/**
 * One-time migration: pre-silo single-community install → the per-community "slot" model.
 *
 * Before the multi-community silo ([[stiq-multicommunity-silo]]), a member's identity key,
 * credential, relay, display name, gradient, drafts, and DM caches all lived under GLOBAL storage
 * keys. The silo namespaces them per identity slot / per community id. This module copies an
 * existing member's data into the namespace of their (single) active community's slot so the
 * upgraded app finds it exactly where the new code looks — with NO data loss.
 *
 * Guarantees:
 *  - **Copy, never move.** The legacy global keys are left in place. The identity's signing key is
 *    reconstructable from them, so even a bug in the new namespaced path can't strand the user.
 *  - **Idempotent.** Guarded by a `stiq.migrated.v1` flag AND every copy is skip-if-present, so a
 *    re-run (or a partial run that crashed) never clobbers newer namespaced data.
 *  - **Event cache is NOT migrated.** The cache is reconstructable from the relay; it re-syncs on
 *    first connect into the new per-community DB file. (Keys/credential/name/gradient/DMs — the
 *    non-reconstructable state — ARE migrated.)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nip19 from 'nostr-tools/nip19';
import {KeyStore, type SecureStorage} from '../keys/keystore';
import {namespacedSkItem} from '../keys/keystore';
import {multiGet} from '../keys/nativeKeystore';
import {KeyRing, newSlotId, type KeySlot} from '../keys/keyRing';
import {CommunityStore, communityId} from '../communities/communityStore';
import {walletStorageKeys} from '../blind/wallet';
import {migrateContentKeys} from '../blind/contentKey';
import {migrateSpaceKeysToSlot} from '../channels/groupCrypto';
import {wipeLegacyCidStore} from '../nostr/sqliteFactory';
import {clearFeedSnapshot} from '../nostr/feedSnapshot';
import {
  LEGACY_SK_ITEM,
  LEGACY_RELAY_ITEM,
  LEGACY_CRED_TOKEN_ITEM,
  LEGACY_CRED_SIG_ITEM,
  LEGACY_IDENTITY_AT_ITEM,
  LEGACY_DISPLAYNAME_SELF,
  LEGACY_DISPLAYNAME_BOOK,
  LEGACY_GRADIENT_SELF,
  LEGACY_GRADIENT_BOOK,
  LEGACY_DRAFTS,
  LEGACY_DM_SENT,
  LEGACY_DM_REACTIONS,
  LEGACY_DM_FAILED_WRAPS,
  LEGACY_DM_BLOCKLIST,
  LEGACY_OUTBOX,
  LEGACY_SQLITE_DBKEY_ITEM,
  LEGACY_EVENTS_CACHE,
  eventsCacheKey,
  LEGACY_GROUPS_JOINED,
  LEGACY_SPACES_ENCRYPTED,
  LEGACY_PICTURE_SPEND,
  LEGACY_COMMUNITY_KEY,
  PREV_OUTBOX_CID,
  PREV_GROUPS_JOINED_CID,
  PREV_SPACES_ENCRYPTED_CID,
  credTokenKey,
  credSigKey,
  identityRelayKey,
  identityAtKey,
  displayNameSelfKey,
  displayNameBookKey,
  gradientSelfKey,
  gradientBookKey,
  draftsKey,
  dmSentKey,
  dmReactionsKey,
  outboxKey,
  groupsJoinedKey,
  spacesEncryptedKey,
  pictureSpendKey,
} from './workspaceKeys';

const MIGRATED_FLAG = 'stiq.migrated.v1';
/** Second migration flag: per-CID/global identity-bound items → per-SLOT (account) namespace. */
const SLOT_MIGRATED_FLAG = 'stiq.migrated.slot.v2';
/** Third migration flag: wipe the orphaned pre-per-account per-CID event store (finding #4). */
const STORE_SLOT_MIGRATED_FLAG = 'stiq.migrated.store.slot.v3';

/** Copy `from`→`to` in SecureStorage only when `to` is absent (skip-if-present, so it's idempotent). */
async function copyIfAbsent(storage: SecureStorage, from: string, to: string): Promise<void> {
  if ((await storage.getItem(to)) !== null) return;
  const value = await storage.getItem(from);
  if (value !== null) await storage.setItem(to, value);
}

/** Same as copyIfAbsent, for the AsyncStorage-backed sets (joined groups, encrypted spaces). */
async function copyAsyncIfAbsent(from: string, to: string): Promise<void> {
  try {
    if ((await AsyncStorage.getItem(to)) !== null) return;
    const value = await AsyncStorage.getItem(from);
    if (value !== null) await AsyncStorage.setItem(to, value);
  } catch {
    // best effort — a missing group/space list just means the community starts without it
  }
}

/**
 * Batch the three one-time migration-flag reads (audit finding #2 hygiene) into ONE native
 * multiGet round-trip instead of three serial `getItem` bridge hops — one inside each of
 * {@link migrateToSlots}, {@link migrateCidToSlot}, {@link migrateWipeLegacyCidStores}. Every
 * launch forever after the first hits the "already migrated" fast return in all three, so this
 * collapses that steady-state cost from 3 native round-trips to 1. Callers thread the result back
 * into each function so it can skip its own read; omitting it (existing call sites, tests) makes
 * each function fall back to reading its own flag exactly as before — behavior is identical either
 * way, only the number of round-trips changes.
 */
export async function preflightMigrationFlags(storage: SecureStorage): Promise<Record<string, string | null>> {
  return multiGet([MIGRATED_FLAG, SLOT_MIGRATED_FLAG, STORE_SLOT_MIGRATED_FLAG], storage);
}

/**
 * Run the legacy→slot migration once. Safe to call on every launch: it no-ops after the first
 * successful run (flag) and every individual copy is skip-if-present. Never throws — a migration
 * failure must not brick startup, so it swallows errors and leaves the legacy keys intact.
 */
export async function migrateToSlots(
  storage: SecureStorage,
  keyRing: KeyRing,
  communities: CommunityStore,
  /** Pre-fetched flag values (see {@link preflightMigrationFlags}) — when supplied, skips this
   *  function's own MIGRATED_FLAG read. Omit to read it directly (unchanged behavior). */
  preflightFlags?: Record<string, string | null>,
): Promise<void> {
  try {
    const migrated = preflightFlags ? preflightFlags[MIGRATED_FLAG] : await storage.getItem(MIGRATED_FLAG);
    if (migrated === '1') return;

    const legacySk = await storage.getItem(LEGACY_SK_ITEM);
    if (!legacySk) {
      // Fresh install (or never enrolled with the pre-silo build): nothing to migrate.
      await storage.setItem(MIGRATED_FLAG, '1');
      return;
    }

    // Resolve the target slot + community. If a slot already exists (enrolled with an intermediate
    // build that namespaced the KEY but not the credential/name/gradient), backfill THAT slot;
    // otherwise mint slot 0 for the single legacy identity.
    const legacyRelay = (await storage.getItem(LEGACY_RELAY_ITEM)) ?? '';
    const existing = await keyRing.listSlots();
    const activeSlotId = await keyRing.getActiveSlotId();
    let slotId = activeSlotId ?? existing[0]?.id;
    const cid = communityId(
      slotId ? (existing.find(s => s.id === slotId)?.relayUrl ?? legacyRelay) : legacyRelay,
    );

    if (!slotId) {
      // Case A — no slot yet: create slot 0 from the legacy key.
      slotId = newSlotId();
      // Copy the raw secret key hex into the slot's namespace (the legacy hex stays put as a safety net).
      await copyIfAbsent(storage, LEGACY_SK_ITEM, namespacedSkItem(slotId));
      let npub = '';
      try {
        npub = nip19.npubEncode(await new KeyStore(storage).publicKey());
      } catch {
        // leave npub blank if the legacy key can't be read; the switcher falls back to the label
      }
      const active = await communities.active();
      await keyRing.addSlot({
        id: slotId,
        communityName: active?.name ?? active?.organizerLabel ?? 'Community',
        relayUrl: legacyRelay,
        enrolledAt: Math.floor(Date.now() / 1000),
        npub,
      });
      if (active) await communities.setActive(active.id);
    } else {
      // Case B — slot exists: ensure its signing key is present in the namespace too.
      await copyIfAbsent(storage, LEGACY_SK_ITEM, namespacedSkItem(slotId));
    }

    // Backfill every per-slot secret / identity value from the legacy globals.
    await copyIfAbsent(storage, LEGACY_CRED_TOKEN_ITEM, credTokenKey(slotId));
    await copyIfAbsent(storage, LEGACY_CRED_SIG_ITEM, credSigKey(slotId));
    await copyIfAbsent(storage, LEGACY_RELAY_ITEM, identityRelayKey(slotId));
    await copyIfAbsent(storage, LEGACY_IDENTITY_AT_ITEM, identityAtKey(slotId));
    await copyIfAbsent(storage, LEGACY_DISPLAYNAME_SELF, displayNameSelfKey(slotId));
    await copyIfAbsent(storage, LEGACY_GRADIENT_SELF, gradientSelfKey(slotId));
    await copyIfAbsent(storage, LEGACY_DRAFTS, draftsKey(slotId));
    await copyIfAbsent(storage, LEGACY_DM_SENT, dmSentKey(slotId));
    await copyIfAbsent(storage, LEGACY_DM_REACTIONS, dmReactionsKey(slotId));

    // Backfill the per-community (relay-scoped) PUBLIC phonebooks.
    await copyIfAbsent(storage, LEGACY_DISPLAYNAME_BOOK, displayNameBookKey(cid));
    await copyIfAbsent(storage, LEGACY_GRADIENT_BOOK, gradientBookKey(cid));
    // Joined groups + encrypted-spaces sets are now per ACCOUNT (slot) — backfill under the slot.
    await copyAsyncIfAbsent(LEGACY_GROUPS_JOINED, groupsJoinedKey(slotId));
    await copyAsyncIfAbsent(LEGACY_SPACES_ENCRYPTED, spacesEncryptedKey(slotId));
    // Note: the outbox (pending sends) intentionally stays on the legacy key until reload — a stale
    // pending send is low-value and will simply not resend; the event cache re-syncs from the relay.

    await storage.setItem(MIGRATED_FLAG, '1');
  } catch {
    // Never brick startup on a migration error. Legacy keys are untouched, so a later launch retries.
  }
}

/** Read a persisted AsyncStorage string-array set (joined groups / encrypted spaces); [] on any error. */
async function readAsyncSet(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Second one-time migration: identity-bound state that USED to be per-community (or global) → the
 * per-ACCOUNT (identity slot) namespace, so two accounts sharing a community no longer share a wallet,
 * outbox, joined-groups/encrypted-spaces set, private-space keys, content keys, or picture-allowance
 * spend. Runs AFTER {@link migrateToSlots} (which already backfilled a pre-silo install into the active
 * slot). One slot per community today ⇒ the per-community items map unambiguously into that slot.
 *
 * Guarantees mirror migrateToSlots: copy-not-move, skip-if-present (idempotent), never throws.
 */
export async function migrateCidToSlot(
  storage: SecureStorage,
  keyRing: KeyRing,
  /** Pre-fetched flag values (see {@link preflightMigrationFlags}) — when supplied, skips this
   *  function's own SLOT_MIGRATED_FLAG read. Omit to read it directly (unchanged behavior). */
  preflightFlags?: Record<string, string | null>,
): Promise<void> {
  try {
    const migrated = preflightFlags ? preflightFlags[SLOT_MIGRATED_FLAG] : await storage.getItem(SLOT_MIGRATED_FLAG);
    if (migrated === '1') return;
    const slots = await keyRing.listSlots();
    const activeSlotId = await keyRing.getActiveSlotId();

    // Group slots by community id; pick a single target slot per community (the active one if it lives
    // in this community, else the first) so the per-community items map into exactly one account. With
    // one slot per community today this is unambiguous; the tie-break only matters for a future multi-
    // account install upgrading, where the not-chosen sibling simply starts fresh (tokens re-drawn, etc).
    const byCid = new Map<string, KeySlot[]>();
    for (const s of slots) {
      const cid = communityId(s.relayUrl);
      const list = byCid.get(cid) ?? [];
      list.push(s);
      byCid.set(cid, list);
    }

    for (const [cid, cidSlots] of byCid) {
      const target = cidSlots.find(s => s.id === activeSlotId) ?? cidSlots[0];
      if (!target) continue;
      const sid = target.id;

      // Wallet (tokens + last-drawn epoch + issuer-key fingerprint stamp): per-cid → per-slot.
      const from = walletStorageKeys(cid);
      const to = walletStorageKeys(sid);
      await copyIfAbsent(storage, from.tokens, to.tokens);
      await copyIfAbsent(storage, from.epoch, to.epoch);
      await copyIfAbsent(storage, from.keyfp, to.keyfp);

      // Outbox (pending optimistic sends signed by this account's npub): per-cid → per-slot.
      await copyIfAbsent(storage, PREV_OUTBOX_CID(cid), outboxKey(sid));

      // Joined-groups + encrypted-spaces sets (AsyncStorage): per-cid → per-slot.
      await copyAsyncIfAbsent(PREV_GROUPS_JOINED_CID(cid), groupsJoinedKey(sid));
      await copyAsyncIfAbsent(PREV_SPACES_ENCRYPTED_CID(cid), spacesEncryptedKey(sid));

      // Content-epoch keys (dark feature): per-cid namespace → per-slot namespace.
      await migrateContentKeys(storage, cid, sid);

      // Private-space E2E keys were GLOBAL (`spacekey:<spaceId>:<epoch>`). Move each space this account
      // belongs to (its joined-groups ∪ encrypted-spaces sets, now populated per-slot above + by
      // migrateToSlots) into the slot namespace, so it keeps decrypting its private spaces.
      const spaceIds = new Set<string>([
        ...(await readAsyncSet(groupsJoinedKey(sid))),
        ...(await readAsyncSet(spacesEncryptedKey(sid))),
      ]);
      await migrateSpaceKeysToSlot(storage, sid, spaceIds);
    }

    // Picture-allowance spend was a single GLOBAL value — it belongs to the active account.
    if (activeSlotId) {
      await copyIfAbsent(storage, LEGACY_PICTURE_SPEND, pictureSpendKey(activeSlotId));
    }

    await storage.setItem(SLOT_MIGRATED_FLAG, '1');
  } catch {
    // Never brick startup on a migration error. Sources are untouched, so a later launch retries.
  }
}

/**
 * Third one-time migration (finding #4): the event cache used to be namespaced by community id ONLY
 * and SHARED across the accounts of one community, so account B's downloaded feed + kind-1059 DM
 * gift-wraps physically sat in account A's cache file. The cache is now per-(cid, ACCOUNT), so each
 * account opens its OWN fresh file and simply re-syncs from the relay. This drops the orphaned
 * pre-per-account per-cid store for every known community so the cross-account ciphertext can't
 * linger — there is NO content copy (the store is a re-syncable cache). The cache has TWO physical
 * backends and BOTH per-cid orphans are dropped: (a) the SQLCipher op-sqlite `stiq-cache-<cid>.db`
 * file + its key (wipeLegacyCidStore), and (b) the SecureStorage JSON fallback blob used when
 * op-sqlite is absent — `eventsCacheKey(cid)` + its `feedSnapshot(cid)`. An intermediate pre-fix
 * build that ran WITHOUT op-sqlite linked stored account B's feed + DM gift-wrap ciphertext in that
 * fallback blob; wiping only the SQLCipher file would have left it behind (matches the duress path).
 *
 * Guarded by a flag (idempotent) and never throws — a wipe failure must not brick startup.
 */
export async function migrateWipeLegacyCidStores(
  storage: SecureStorage,
  keyRing: KeyRing,
  /** Pre-fetched flag values (see {@link preflightMigrationFlags}) — when supplied, skips this
   *  function's own STORE_SLOT_MIGRATED_FLAG read. Omit to read it directly (unchanged behavior). */
  preflightFlags?: Record<string, string | null>,
): Promise<void> {
  try {
    const migrated = preflightFlags ? preflightFlags[STORE_SLOT_MIGRATED_FLAG] : await storage.getItem(STORE_SLOT_MIGRATED_FLAG);
    if (migrated === '1') return;
    // Every community the device knows has at least one KeyRing slot; derive the set of community ids
    // from the slots (deduped) and wipe each one's orphaned pre-per-account store — BOTH backends.
    const cids = new Set<string>();
    for (const s of await keyRing.listSlots()) cids.add(communityId(s.relayUrl));
    for (const cid of cids) {
      await wipeLegacyCidStore(storage, cid); // SQLCipher op-sqlite file + key
      await storage.removeItem(eventsCacheKey(cid)); // SecureStorage JSON fallback blob (no-slot)
      await clearFeedSnapshot(storage, cid); // its companion per-cid feed snapshot
    }
    await storage.setItem(STORE_SLOT_MIGRATED_FLAG, '1');
  } catch {
    // Never brick startup — the orphaned store is unreadable ciphertext regardless; retry next launch.
  }
}

/**
 * Remove the pre-silo legacy global secrets that {@link migrateToSlots} deliberately COPIES but
 * never moves (its "Copy, never move" safety net). The duress-PIN wipe and the Settings emergency
 * kill switch call this so an upgraded install doesn't leave the raw identity private key
 * (`LEGACY_SK_ITEM` = `stiq.identity.sk`) plus the legacy credential/relay/name/DM material sitting
 * in secure storage after a supposed "fresh install" wipe (security finding #18). Best-effort per
 * key: a single failure must not abort the rest of the wipe. Also drops `MIGRATED_FLAG` so a later
 * launch re-runs the (now no-op) migration cleanly.
 */
export async function wipeLegacyGlobals(storage: SecureStorage): Promise<void> {
  const secureKeys = [
    LEGACY_SK_ITEM,
    LEGACY_RELAY_ITEM,
    LEGACY_CRED_TOKEN_ITEM,
    LEGACY_CRED_SIG_ITEM,
    LEGACY_IDENTITY_AT_ITEM,
    LEGACY_DISPLAYNAME_SELF,
    LEGACY_DISPLAYNAME_BOOK,
    LEGACY_GRADIENT_SELF,
    LEGACY_GRADIENT_BOOK,
    LEGACY_DRAFTS,
    LEGACY_DM_SENT,
    LEGACY_DM_REACTIONS,
    LEGACY_DM_FAILED_WRAPS,
    LEGACY_OUTBOX,
    LEGACY_PICTURE_SPEND, // pre-slot global picture-allowance spend
    LEGACY_COMMUNITY_KEY, // pre-slot global community-key mirror (dropped; wipe any leftover)
    LEGACY_SQLITE_DBKEY_ITEM,
    MIGRATED_FLAG,
    SLOT_MIGRATED_FLAG,
    STORE_SLOT_MIGRATED_FLAG,
  ];
  for (const key of secureKeys) {
    try {
      await storage.removeItem(key);
    } catch {
      // best effort — keep wiping the rest
    }
  }
  // The AsyncStorage-backed legacy state: joined groups, encrypted-space keys, the old event cache,
  // and the DM blocklist. LEGACY_DM_BLOCKLIST (`stiq_dm_blocklist`) is AsyncStorage-backed (see
  // dm/blocklist.ts) — removing it via SecureStorage is a silent no-op (finding M3), so it MUST be
  // dropped through the AsyncStorage API here.
  for (const key of [
    LEGACY_GROUPS_JOINED,
    LEGACY_SPACES_ENCRYPTED,
    LEGACY_EVENTS_CACHE,
    LEGACY_DM_BLOCKLIST,
  ]) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // best effort
    }
  }
}

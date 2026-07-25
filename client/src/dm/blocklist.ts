/**
 * Local DM decision store — device-only "block / allow a user's DMs".
 *
 * Blocking a peer here is PURELY LOCAL and DM-ONLY: nothing is published to the relay (no
 * kind-10000 mute list, no event — an identity-signed mute would deanonymise the "npub A muted
 * npub B" relationship, which STIQ's anonymity model forbids). The single effect is on THIS
 * device's DM surface — a blocked peer's conversation drops out of the inbox grouping
 * (buildConversations) and the conversation view hides the composer behind the blocked footer.
 * Channels and the feed are untouched (blocks are DM-scoped).
 *
 * This module stores an explicit per-peer DECISION, not just a blocked set, because a peer can also
 * be auto-blocked by a MODERATOR removal (a moderator's kind-10000 mute list, evaluated in
 * AppRuntime.effectiveDmBlocked). A local 'allow' is the user's override of that moderator
 * auto-block — "I still want this person's DMs" — so it must be persisted to survive restarts and
 * mute-list republishes. A local 'block' carries the moment it was made (`at`, epoch seconds): DMs
 * received before that instant are the user's kept history (hidden, restorable on unblock), while
 * DMs that arrive after it are deleted on arrival (see AppRuntime.dropBlockedArrivals). The
 * effective block state — local decision layered over the moderator mute — lives in AppRuntime,
 * which is the only place with access to the moderator roster + store; this module owns only the
 * local decision.
 *
 * Persistence mirrors the notifications mute-set pattern: an in-memory Map hydrated once from
 * AsyncStorage, re-saved on every change. A subscribe() mechanism lets views re-render when it
 * changes; reads are synchronous, so an un-hydrated map simply means "no local decision yet" — safe
 * to call before load completes.
 */
import {useSyncExternalStore} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {LEGACY_DM_BLOCKLIST, dmBlocklistKey} from '../app/workspaceKeys';

/** A local, device-only decision about a peer's DMs. */
export type BlockDecision = 'block' | 'allow';

interface DecisionEntry {
  decision: BlockDecision;
  /** Epoch seconds the decision was recorded. For a 'block', the cutoff that separates kept history
   *  (received before) from delete-on-arrival (received after). */
  at: number;
}

// The storage key is per identity slot — a decision is "how MY device treats this peer's DMs", and
// each enrolled community has its own npub/inbox, so decisions must not bleed across communities.
// The key is mutable and repointed by reloadBlocklistFor() on a community switch. Defaults to the
// legacy global key until a slot is known.
let _key = LEGACY_DM_BLOCKLIST;

let _loaded = false;
let _loading: Promise<void> | null = null;
const _decisions = new Map<string, DecisionEntry>();
const _listeners = new Set<() => void>();

/** Wall-clock in epoch seconds (RN runtime — Date.now is available here). */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function emit(): void {
  for (const listener of _listeners) listener();
}

async function persist(): Promise<void> {
  try {
    // Format v2: {v:2, e:[[peer, decision, at], …]}. A bare JSON array is the legacy v1 blocked-set
    // and is migrated on load (see loadBlocklist).
    const e = [..._decisions.entries()].map(([peer, d]) => [peer, d.decision, d.at]);
    await AsyncStorage.setItem(_key, JSON.stringify({v: 2, e}));
  } catch {
    /* best effort — a failed write just means the decision isn't persisted across restarts */
  }
}

/**
 * Re-point the decision store at a different identity slot and reload it (community switch). The
 * in-memory map is cleared and re-hydrated from the new slot's key, then subscribers are notified so
 * the inbox/conversation views recompute. Decisions are intentionally NOT carried across communities
 * — a fresh community starts with none.
 */
export async function reloadBlocklistFor(slotId?: string): Promise<void> {
  _key = slotId ? dmBlocklistKey(slotId) : LEGACY_DM_BLOCKLIST;
  _decisions.clear();
  _loaded = false;
  _loading = null;
  await loadBlocklist();
  emit();
}

/**
 * Hydrate the in-memory decision map from AsyncStorage exactly once. Safe to await repeatedly and
 * safe to call concurrently (the in-flight promise is shared). Migrates the legacy v1 format (a bare
 * JSON array of blocked peers) to a 'block' decision stamped at load time — treating the migration
 * moment as the block time keeps any already-received history rather than deleting it. Notifies
 * subscribers if anything was loaded so views built before hydration re-render.
 */
export async function loadBlocklist(): Promise<void> {
  if (_loaded) return;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const raw = await AsyncStorage.getItem(_key);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          // Legacy v1: a plain array of blocked peer pubkeys.
          const at = nowSec();
          for (const peer of parsed as string[]) {
            if (peer) _decisions.set(peer, {decision: 'block', at});
          }
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as {e?: unknown}).e)) {
          for (const row of (parsed as {e: unknown[]}).e) {
            if (!Array.isArray(row)) continue;
            const [peer, decision, at] = row as [string, BlockDecision, number];
            if (peer && (decision === 'block' || decision === 'allow')) {
              _decisions.set(peer, {decision, at: typeof at === 'number' ? at : 0});
            }
          }
        }
      }
    } catch {
      /* fresh state is fine */
    } finally {
      _loaded = true;
      _loading = null;
    }
    if (_decisions.size > 0) emit();
  })();
  return _loading;
}

/** The local decision for this peer, or undefined if none has been made on this device. */
export function localDecision(pubkey: string): BlockDecision | undefined {
  return _decisions.get(pubkey)?.decision;
}

/** Epoch seconds a local 'block' was recorded (the delete-on-arrival cutoff), or undefined if the
 *  peer is not locally blocked. */
export function localBlockedAt(pubkey: string): number | undefined {
  const e = _decisions.get(pubkey);
  return e?.decision === 'block' ? e.at : undefined;
}

/** True if this peer is locally blocked on this device (a local 'block' decision). Synchronous;
 *  false until hydrated. Does NOT account for moderator auto-blocks — see
 *  AppRuntime.effectiveDmBlocked for the effective state. */
export function isBlocked(pubkey: string): boolean {
  return _decisions.get(pubkey)?.decision === 'block';
}

/** All locally-blocked peer pubkeys (hex), as a fresh array. */
export function getBlocked(): string[] {
  const out: string[] = [];
  for (const [peer, d] of _decisions) if (d.decision === 'block') out.push(peer);
  return out;
}

/**
 * Block a peer's DMs locally. Records the block time so DMs received afterwards are deleted on
 * arrival while earlier history is kept (hidden, restorable on unblock). Re-blocking an
 * already-blocked peer is a no-op that preserves the original block time.
 */
export async function blockPeer(pubkey: string): Promise<void> {
  await loadBlocklist();
  if (_decisions.get(pubkey)?.decision === 'block') return;
  _decisions.set(pubkey, {decision: 'block', at: nowSec()});
  emit();
  await persist();
}

/**
 * Unblock a peer's DMs locally by recording an explicit 'allow'. Unlike a plain delete, the allow is
 * persisted so it overrides a MODERATOR auto-block (a moderator's mute list) — the user has said "I
 * still want this person's DMs" and that survives restarts and mute-list republishes. Re-allowing an
 * already-allowed peer is a no-op.
 */
export async function unblockPeer(pubkey: string): Promise<void> {
  await loadBlocklist();
  if (_decisions.get(pubkey)?.decision === 'allow') return;
  _decisions.set(pubkey, {decision: 'allow', at: nowSec()});
  emit();
  await persist();
}

/** Subscribe to decision changes. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * React hook: re-renders the caller whenever the decision map changes. Returns whether `pubkey` is
 * locally blocked (or, when no pubkey is given, always false — used only to force a re-render on
 * change). This reflects the LOCAL decision only; production DM views receive the effective block
 * (local ⊕ moderator) as a prop from AppRuntime.
 */
export function useBlocklist(pubkey?: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (pubkey ? _decisions.get(pubkey)?.decision === 'block' : false),
  );
}

// Kick off hydration at import time so cold-start inbox grouping sees local decisions as soon as
// AsyncStorage resolves. Fire-and-forget: callers that need the loaded map can await loadBlocklist().
void loadBlocklist();

/**
 * Blind-post author resolution — the ONE place the feed/moderation layers turn a stored event
 * into its real author.
 *
 * For a blind post (throwaway-signed, `stiq_attr` present) this decrypts the attribution under
 * the active community key to recover the real npub + display name + gradient. For any other
 * event it falls back to `event.pubkey` and the plaintext SOH header, so non-blind posts behave
 * exactly as before. Results are cached by (immutable) event id, since decrypting per feed
 * rebuild would be wasteful.
 *
 * The community key is injected via ./communityKey (setActiveCommunityKey), so no feed signature
 * needs to carry it. Until the key loads (or for a host who never has it) blind posts resolve to
 * their throwaway signer — indistinguishable from anonymous.
 */
import {readBlindAuthor} from './blindPost';
import {getActiveCommunityKey} from './communityKey';
import {getActiveMemberRoll} from './memberRoll';
import {isBlindPost} from './blindPost';
import {FEED_KINDS} from '../contracts';

export interface ResolvedAuthor {
  /** The author to attribute the event to (real npub for a decrypted blind post). */
  pubkey: string;
  /** Display name from the attestation (blind posts only). */
  name?: string;
  /** Gradient wire form from the attestation (blind posts only). */
  gradient?: string;
  /** True if this is a blind post whose attribution we successfully decrypted. */
  blind: boolean;
}

const _cache = new Map<string, ResolvedAuthor>();

/**
 * Resolve an event's real author. Cheap and idempotent; cached by event id. A blind post whose
 * attribution we cannot read (no key yet, wrong community) resolves to its throwaway signer and
 * is intentionally NOT cached, so it re-resolves once the community key loads.
 */
export function resolveAuthor(event: {id: string; pubkey: string; tags: string[][]}): ResolvedAuthor {
  const cached = _cache.get(event.id);
  if (cached) return cached;

  if (!isBlindPost(event)) {
    const res: ResolvedAuthor = {pubkey: event.pubkey, blind: false};
    if (event.id) _cache.set(event.id, res);
    return res;
  }

  const key = getActiveCommunityKey();
  if (!key) {
    // Blind post, but we can't read it yet — fall back without caching so a later key load fixes it.
    return {pubkey: event.pubkey, blind: false};
  }
  const attr = readBlindAuthor(event, key);
  const res: ResolvedAuthor = attr
    ? {pubkey: attr.pubkey, name: attr.name, gradient: attr.gradient, blind: true}
    : {pubkey: event.pubkey, blind: false};
  if (event.id) _cache.set(event.id, res);
  return res;
}

/** Convenience: the author pubkey to attribute an event to. */
export function resolveAuthorPubkey(event: {id: string; pubkey: string; tags: string[][]}): string {
  return resolveAuthor(event).pubkey;
}

/**
 * True iff `event` is a blind post (it spent a token) whose attribution does NOT resolve to a real
 * member — a token was spent but no valid, member-signed attestation backs the post. That is a
 * patched client publishing under a throwaway key with the `stiq_attr` tag stripped or forged, so the
 * post can't be tied to (or moderated by) any npub. Conforming clients hide such content + log it.
 *
 * ONLY judged once the active community key is loaded: without it we can't tell a stripped attribution
 * from one we simply can't decrypt yet, so return false (defer) rather than wrongly flag a legit post.
 */
export function isUnattributedBlindPost(event: {id: string; pubkey: string; tags: string[][]}): boolean {
  if (!isBlindPost(event)) return false;
  if (!getActiveCommunityKey()) return false;
  return !resolveAuthor(event).blind;
}

/**
 * True iff `event` is a blind post whose attribution DOES resolve (a valid member-signed
 * attestation) but to an npub that is NOT on the active member roll — i.e. a key nobody ever
 * bound on the relay. That is the fresh-npub ban-evasion / sock-puppet shape: the attestation
 * only ever proved control of *some* key, and binding a key costs a scarce enrollment credential,
 * so a legitimately-enrolled author is always on the roll. Conforming clients treat it exactly
 * like an unattributed post: hidden from feed/threads, excluded from tallies, mod-logged.
 *
 * DEFERRAL (each returns false — byte-identical to pre-roll behavior):
 *   - no community key loaded (can't resolve attributions at all yet);
 *   - no roll loaded (legacy community, roll doc not yet synced, or organizer publishes none);
 *   - attribution doesn't resolve (that's isUnattributedBlindPost's bucket, distinct mod-log label).
 *
 * The roll Set already contains the organizer + self (unioned at load — see memberRoll.ts), so
 * organizer posts and a member's own just-bound identity are never flagged. Verdicts are computed
 * live against the current roll (never cached): a roll update flips them on the next feed build.
 */
export function isOffRollBlindPost(event: {id: string; pubkey: string; tags: string[][]}): boolean {
  if (!isBlindPost(event)) return false;
  if (!getActiveCommunityKey()) return false;
  const roll = getActiveMemberRoll();
  if (!roll) return false;
  const res = resolveAuthor(event);
  if (!res.blind) return false;
  return !roll.has(res.pubkey);
}

/**
 * A blind post that must not surface as legitimate member content: attribution stripped/forged
 * (isUnattributedBlindPost) OR resolving off the member roll (isOffRollBlindPost). One import for
 * hide-only call sites (thread partitions, tallies, learning, notifications); moderation surfaces
 * that label the two cases distinctly call the two predicates separately.
 */
export function isUnverifiedBlindPost(event: {id: string; pubkey: string; tags: string[][]}): boolean {
  return isUnattributedBlindPost(event) || isOffRollBlindPost(event);
}

/** Clear the resolver cache (e.g. after the community key changes on re-enrollment). */
export function clearAuthorCache(): void {
  _cache.clear();
}

/**
 * Kinds a blind post can ever arrive as — i.e. the feed-content kinds (see FEED_KINDS). DMs
 * (GiftWrap), organizer config (AppData), and space-key deliveries never carry `stiq_attr`
 * attribution, so they are excluded up front rather than paying a (cheap but pointless) tags scan.
 */
const _warmupKinds = new Set<number>(FEED_KINDS);

/**
 * Ingest-time cache warmup: pre-resolve a blind post's real author so a later SYNCHRONOUS
 * `resolveAuthor`/`resolveAuthorPubkey` call (buildFeed, buildModeratedFeed) hits an already-warm
 * cache instead of paying the NIP-44 decrypt + schnorr verify cost inline. Intended to be called
 * once per event from the paced inbound-ingest path (RelayClient's `onIngestEvent` hook) so that
 * hundreds of first-sight blind posts each pay their decrypt cost across many small ingest
 * macrotasks instead of one giant synchronous feed build.
 *
 * Cheap kind check FIRST (skips DMs/gift-wraps/organizer-config/space-key-delivery — see
 * `_warmupKinds`). Fire-and-forget: `resolveAuthor` itself doesn't throw, but this is guarded
 * anyway since a best-effort warmup pass must never be able to affect ingest or crash a caller.
 */
export function warmAuthorResolution(event: {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
}): void {
  if (!_warmupKinds.has(event.kind)) return;
  try {
    resolveAuthor(event);
  } catch {
    // best-effort cache warm only
  }
}

/**
 * Chunk size for the cold-start warmup pass — how many `resolveAuthor` calls run synchronously
 * before yielding the JS thread. Mirrors `DECRYPT_CHUNK` (dm.ts): a small, sub-frame slice so a
 * large cached history paces itself across macrotasks instead of freezing one.
 */
const COLD_WARMUP_CHUNK_SIZE = 32;

/**
 * Safety cap on how many events one cold-start warmup pass will touch, so a pathologically large
 * local cache can't indefinitely delay the deferred heavy feed build it precedes. Matches the
 * network cold-cache feed limit (subscriptionPlan.ts DEFAULT_FEED_LIMIT) — anything beyond this is
 * left for buildFeed's own (always-correct, just synchronous) resolveAuthor calls to resolve.
 */
const COLD_WARMUP_MAX_EVENTS = 500;

/**
 * Cold-start hydration warmup (bug #2 / C3): events loaded from the persistent store on app start
 * (SqliteEventStore/SwappableEventStore's first snapshot) reach `buildFeed` WITHOUT ever passing
 * through RelayClient's paced ingest drain — they were already on disk from a prior session. This
 * pre-resolves their authors in bounded, yielding chunks (see `COLD_WARMUP_CHUNK_SIZE`) so a
 * returning member's cached history doesn't freeze the first heavy feed build the same way an
 * un-warmed post-enrollment REQ would.
 *
 * Best-effort + bounded (see `COLD_WARMUP_MAX_EVENTS`): `buildFeed`'s own synchronous
 * `resolveAuthor` calls stay exactly as correct on anything this pass doesn't reach — this is
 * purely an optimization, never a correctness dependency. Callers should still unconditionally
 * proceed with their real feed build once this resolves (or rejects — it never throws internally,
 * but the caller should not treat a resolved promise as "cache is now fully warm" for extremely
 * large stores past the cap).
 */
export async function warmAuthorResolutionCold(
  events: readonly {id: string; pubkey: string; kind: number; tags: string[][]}[],
): Promise<void> {
  const limit = Math.min(events.length, COLD_WARMUP_MAX_EVENTS);
  let i = 0;
  while (i < limit) {
    const end = Math.min(i + COLD_WARMUP_CHUNK_SIZE, limit);
    for (; i < end; i++) warmAuthorResolution(events[i]!);
    if (i < limit) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); // yield between chunks
    }
  }
}

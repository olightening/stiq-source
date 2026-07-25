/**
 * doubleSpend — PURE, client-side detection of a holder DOUBLE-SPENDING a P3 posting token.
 *
 * A P3 token is 32 bytes that ARE a BIP-340 x-only pubkey `Q`; the client keeps the secret `q` and
 * NEVER reveals it (the organizer blind-signs `Q`, the relay only ever sees `Q`). Spending the token
 * requires a HOLDER PROOF that only `q`'s owner can produce:
 *   - token 0: the event is signed by `q0`, so `event.pubkey === hex(Q0)` — the event's own BIP-340
 *     signature (verified at ingest) IS the proof.
 *   - token i>=1: a positional `stiq_spend` tag carrying a schnorr sig by `q_i` over
 *     `spendMessage(event.pubkey)` (see ./holderProof) — bound to THIS event's pubkey.
 *
 * WHY THIS IS SOUND (the property every function here preserves): because a spend is holder-bound,
 * only the true holder can mint a SECOND valid spend of the same `Q` over a DIFFERENT `event.pubkey`.
 * The organizer never saw `q`; an outsider who copies `Q` off the wire cannot forge a fresh holder
 * proof for a new event. So a token that appears WITH A VALID SPEND in two DISTINCT event ids can
 * ONLY be the holder double-spending. Two consequences we rely on:
 *   1. Detection can never hide an honest member's single legit post (one valid spend = one event).
 *   2. "Valid spend" MUST be verified client-side here, NEVER trusted from a tag — otherwise the
 *      relay/organizer could forge a `Q_victim` tag onto some event and weaponise the detector to
 *      censor the victim. Every count below is gated on a cryptographic check.
 *
 * PURE + deterministic: given the same set of events (in ANY order) every client computes the SAME
 * winner/loser split, so all clients hide the same losers with no coordination.
 *
 * ZERO new deps: reuses sha256Hex (../util/hash), base64ToBytes (../util/base64), bytesToHex
 * (../util/hex), isBlindPost (./blindPost) and verifySpendProof (./holderProof).
 */
import type {Event} from 'nostr-tools/pure';
import {sha256Hex} from '../util/hash';
import {base64ToBytes} from '../util/base64';
import {bytesToHex} from '../util/hex';
import {isBlindPost} from './blindPost';
import {verifySpendProof} from './holderProof';
import {TAG_TOKEN, TAG_SPEND} from './protocol';

/**
 * The canonical id of a token: `hex(sha256(Q))`. Matches the relay's `membership.TokenID` (the key
 * of its spent-set), so a conflict this module finds is keyed identically to what the relay would
 * key its own double-spend rejection under.
 */
export function tokenId(Q: Uint8Array): string {
  return sha256Hex(Q);
}

/** base64 -> bytes, or null when the value is missing / undecodable (kept as a POSITIONAL placeholder
 *  so a bad token never shifts the index that pairs `stiq_spend[i-1]` with `stiq_token[i]`). */
function decodeOrNull(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

/** verifySpendProof, but a malformed proof / non-point `Q` (which makes schnorr.verify throw) reads
 *  as an INVALID proof rather than crashing the whole scan — fail-closed, so a forged tag can never
 *  manufacture a conflict. */
function safeVerifySpend(proof: Uint8Array, eventPubkeyHex: string, Q: Uint8Array): boolean {
  try {
    return verifySpendProof(proof, eventPubkeyHex, Q);
  } catch {
    return false;
  }
}

// Events are immutable, so a token-id list only needs computing once per object. WeakMap keys on
// object identity and never pins the event alive, so this is a free cache with no eviction policy.
const _spentCache = new WeakMap<Event, string[]>();

/**
 * The token-ids `event` VALIDLY spends — each entry cryptographically verified here, NOT trusted
 * from the tag. Non-blind events (no `stiq_token`) return `[]`.
 *
 * Token 0 is counted only when `stiq_token[0]`'s raw bytes equal `event.pubkey` (i.e. the event was
 * actually signed by `q0`): the event's own BIP-340 signature, already verified at ingest, is the
 * proof. For a pre-P3 BEARER post `event.pubkey !== Q0`, so token 0 is soundly NOT attributed — we
 * only ever attribute holder-bound spends we can prove.
 *
 * Token i>=1 is counted only when its positional `stiq_spend[i-1]` verifies against `Q_i` over
 * `spendMessage(event.pubkey)`. A missing / undecodable / invalid proof is SKIPPED (fail-closed), so
 * a `Q_victim` tag bolted onto an attacker's event without a real holder proof produces NO count and
 * therefore no false conflict.
 *
 * The returned array is MEMOIZED per event object — callers must treat it as READ-ONLY (do not sort
 * or mutate it in place; copy first). Result order is tag order, deduplicated.
 */
export function validSpentTokenIds(event: Event): string[] {
  const cached = _spentCache.get(event);
  if (cached !== undefined) return cached;
  const ids = computeValidSpentTokenIds(event);
  _spentCache.set(event, ids);
  return ids;
}

function computeValidSpentTokenIds(event: Event): string[] {
  if (!isBlindPost(event)) return [];

  // Collect token & spend tag VALUES in tag order, keeping a null placeholder for any undecodable
  // one so positions stay aligned: `stiq_spend[i-1]` is the holder proof for `stiq_token[i]` (the
  // wire layout emitted by assembleBlindEvent — all token/sig pairs, then all spends, then attr).
  const tokens: (Uint8Array | null)[] = [];
  const spends: (Uint8Array | null)[] = [];
  for (const tag of event.tags) {
    if (tag[0] === TAG_TOKEN) tokens.push(decodeOrNull(tag[1]));
    else if (tag[0] === TAG_SPEND) spends.push(decodeOrNull(tag[1]));
  }

  const ids: string[] = [];
  const seen = new Set<string>(); // "set of token-ids" semantics: a repeated token never double-lists
  for (let i = 0; i < tokens.length; i++) {
    const Q = tokens[i];
    if (!Q) continue; // undecodable token — not counted (fail-closed)

    let valid: boolean;
    if (i === 0) {
      // Compare bytes via the same hex encoding the signer used for event.pubkey (both lowercase),
      // so no separate hex-decode of the pubkey is needed and a malformed pubkey simply won't match.
      valid = bytesToHex(Q) === event.pubkey;
    } else {
      const proof = spends[i - 1];
      valid = proof != null && safeVerifySpend(proof, event.pubkey, Q);
    }
    if (!valid) continue;

    const tid = tokenId(Q);
    if (!seen.has(tid)) {
      seen.add(tid);
      ids.push(tid);
    }
  }
  return ids;
}

/** One token spent by two or more distinct events, with the deterministic winner/loser split. */
export interface DoubleSpendConflict {
  tokenId: string;
  winner: string;
  losers: string[];
  /** All event ids in the conflict, winner first then losers — deterministic order. */
  eventIds: string[];
}

export interface DoubleSpendResult {
  /** Event ids to hide from the feed (the union of every conflict's losers). */
  loserIds: Set<string>;
  /** Every detected conflict, keyed by tokenId. */
  conflicts: Map<string, DoubleSpendConflict>;
}

/**
 * Detect holder double-spends across `events`.
 *
 * Index every event by the token-ids it VALIDLY spends (via {@link validSpentTokenIds}); any token
 * spent by >= 2 DISTINCT event ids is a conflict. The WINNER is the event with the LOWEST created_at,
 * tie-broken by the LOWEST event.id (lexicographic) — a total order that is identical on every
 * client. All other events for that token are LOSERS and get hidden.
 *
 * A single event can validly spend several tokens; if it loses ANY one conflict it is hidden whole
 * (a double-spending event is not honest, even for the tokens it did not reuse). loserIds is the
 * union across conflicts, so that falls out naturally.
 *
 * PURE + deterministic: the same event set in any input order yields byte-identical loserIds and
 * conflicts, so every client independently hides the same losers with zero coordination.
 */
export function detectDoubleSpends(events: readonly Event[]): DoubleSpendResult {
  // token-id -> the distinct events that validly spend it (deduped by event id — the store already
  // dedups by id, but a caller could hand us the same event twice, so we guard).
  const buckets = new Map<string, {id: string; created_at: number}[]>();
  const seenPerToken = new Map<string, Set<string>>();

  for (const ev of events) {
    for (const tid of validSpentTokenIds(ev)) {
      let bucket = buckets.get(tid);
      let seen = seenPerToken.get(tid);
      if (bucket === undefined || seen === undefined) {
        bucket = [];
        seen = new Set<string>();
        buckets.set(tid, bucket);
        seenPerToken.set(tid, seen);
      }
      if (seen.has(ev.id)) continue; // same event id already recorded for this token
      seen.add(ev.id);
      bucket.push({id: ev.id, created_at: ev.created_at});
    }
  }

  const loserIds = new Set<string>();
  const conflicts = new Map<string, DoubleSpendConflict>();
  for (const [tid, bucket] of buckets) {
    if (bucket.length < 2) continue; // spent exactly once — an honest post, never hidden

    // Total order: lowest created_at first, ties broken by lexicographically-lowest id. Deterministic
    // regardless of input order, so every client selects the same winner.
    const ordered = [...bucket].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const eventIds = ordered.map(e => e.id);
    const [winner, ...losers] = eventIds;
    for (const l of losers) loserIds.add(l);
    conflicts.set(tid, {tokenId: tid, winner: winner!, losers, eventIds});
  }

  return {loserIds, conflicts};
}

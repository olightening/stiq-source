/**
 * blindPost — turn a content event into a relay-blind post.
 *
 * Given the unsigned content (note/comment/article/…), one or more spent tokens, and the author's
 * real key, this signs the event with the FIRST spent token's own secret (P3 holder-bound tokens —
 * see ./holderProof) and attaches the anti-spam token(s) plus an encrypted attribution tag. The
 * relay sees a token-bound signer + valid token(s); only community members can decrypt who wrote it.
 *
 * PURE module. The caller supplies the real secret key (under the keystore guard) and the
 * community key, exactly as dm.ts is handed the sender key.
 */
import {finalizeEvent, type Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {bytesToBase64} from '../util/base64';
import {bytesToHex} from '../util/hex';
import {randomBytes} from '../util/random';
import {decryptForSpace} from '../channels/groupCrypto';
import {buildAttribution, parseAttribution, type Attribution, type AttributionMeta} from './attribution';
import {getContentEpochKey, hasContentEpochKey} from './contentKey';
import {spendProof} from './holderProof';
import type {Token} from './wallet';
import {TAG_ATTR, TAG_SIG, TAG_TOKEN, TAG_SPEND, TAG_ENC, ENC_NIP44, TAG_KE} from './protocol';

/**
 * Coarse-bucket + CSPRNG jitter for a blind post's created_at (audit #48).
 *
 * A blind post is signed by a throwaway key, but an unfuzzed wall-clock `created_at` still hands the
 * relay (and anyone with the feed) the exact posting SECOND — an extra correlation handle to tie a
 * throwaway-key post to the moment a suspected member's connection was active. NIP-17 gift wraps
 * back-date their timestamp for exactly this reason (see dm.ts); blind posts get an analogous, but
 * much smaller, treatment so feed ordering stays sane.
 *
 * The emitted timestamp is the input quantized DOWN to a `BUCKET`-second boundary plus a uniform
 * CSPRNG offset within that bucket, then CLAMPED so it never exceeds `nowSeconds` (M4). Clamping
 * keeps the shift strictly BACKWARD: without it, an offset near a bucket boundary can push the stamp
 * up to ~BUCKET-1 seconds into the FUTURE, which distorts feed ordering and risks rejection by
 * relays enforcing created_at ≤ now. The result's sub-bucket position stays independent of the true
 * second; resolution is coarsened to `BUCKET` and the exact second destroyed.
 *
 * BUCKET is purely a feed-ordering / relay-hygiene bound now: the standing live feed REQ is
 * limit-only and carries no `since` (subscriptionPlan.ts's buildLiveFeedFilter — khatru applies a
 * REQ's `since` to live-broadcast events too, so the live tail can never risk dropping a fresh,
 * back-dated blind post below a since window it doesn't have). BUCKET is no longer coupled to any
 * feed overlap/since value; it only needs to keep the clamp's backward shift small enough that feed
 * ordering still reads as roughly-chronological.
 */
const BLIND_TS_BUCKET_SECONDS = 180;

function fuzzBlindCreatedAt(nowSeconds: number): number {
  const bucketStart = Math.floor(nowSeconds / BLIND_TS_BUCKET_SECONDS) * BLIND_TS_BUCKET_SECONDS;
  const b = randomBytes(4);
  const r = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  // Clamp to `nowSeconds` so the fuzz is strictly backward-only (M4): near a bucket boundary the raw
  // `bucketStart + offset` can exceed now by up to BUCKET-1s. The max backward shift stays < BUCKET,
  // keeping feed ordering sane and created_at ≤ now for relay hygiene — this is no longer coupled to
  // any feed `since`/overlap value (the live feed REQ is limit-only, see subscriptionPlan.ts).
  return Math.min(nowSeconds, bucketStart + (r % BLIND_TS_BUCKET_SECONDS));
}

/**
 * Assemble a signed blind post from already-built parts: the N spent tokens (P3 holder-bound —
 * each carries its own secret `q`) and the pre-built encrypted attribution. PURE (it takes no
 * long-lived author secret), so it can run OUTSIDE the keystore guard — the attribution, which
 * does need the real key, is built by the caller first (see BlindSigner, which must build `attr`
 * before pricing the event so it can count the attr's bytes toward the weight-priced token cost).
 *
 * P3: the event is signed with `tokens[0].secret` (q0), so `event.pubkey === hex(tokens[0].token)`
 * (Q0) — token 0's holder proof IS the event's own BIP-340 signature, already verified by the
 * relay's signature hook, so it carries NO `stiq_spend` tag. A single-token post is therefore
 * WIRE-IDENTICAL to today. Each additional token i>=1 carries exactly one positional
 * `['stiq_spend', base64(sig_i)]`, `sig_i = spendProof(tokens[i].secret, hex(Q0))`, emitted in
 * token order AFTER all the stiq_token/stiq_sig pairs and BEFORE stiq_attr (see ./holderProof).
 *
 * @param unsigned the content event to post (kind/content/tags preserved)
 * @param tokens the tokens spent from the wallet (>= the event's weight-priced cost); tokens[0]
 *   becomes the event's signer
 * @param attr the encrypted stiq_attr attribution (built from the real key by the caller, bound to
 *   hex(tokens[0].token))
 */
export function assembleBlindEvent(unsigned: UnsignedEvent, tokens: readonly Token[], attr: string): Event {
  if (tokens.length === 0) {
    throw new Error('assembleBlindEvent requires at least one spent token');
  }
  const token0 = tokens[0]!;
  const q0 = token0.secret;
  const eventPubkeyHex = bytesToHex(token0.token);

  const tags: string[][] = [...unsigned.tags];
  for (const t of tokens) {
    tags.push([TAG_TOKEN, bytesToBase64(t.token)]);
    tags.push([TAG_SIG, bytesToBase64(t.sig)]);
  }
  // Holder proofs for every token beyond the first, in token order (positional — the relay pairs
  // stiq_spend[i-1] with token i). Token 0 needs none: signing the event with q0 already proves it.
  for (let i = 1; i < tokens.length; i++) {
    const proof = spendProof(tokens[i]!.secret, eventPubkeyHex);
    tags.push([TAG_SPEND, bytesToBase64(proof)]);
  }
  tags.push([TAG_ATTR, attr]);
  // Fuzz the timestamp so a blind post never carries the exact posting second (audit #48). Applies
  // to the caller-supplied created_at too — the composer stamps `Date.now()` before signing, so the
  // fallback default alone would leave every real post un-fuzzed.
  return finalizeEvent(
    {
      kind: unsigned.kind,
      created_at: fuzzBlindCreatedAt(unsigned.created_at ?? Math.floor(Date.now() / 1000)),
      tags,
      content: unsigned.content,
    },
    q0,
  );
}

/**
 * Convenience wrapper: build the attribution bound to token 0's pubkey from the real key, and
 * assemble a blind post spending `tokens`. Used by the single-token path and tests.
 *
 * @param unsigned the content event to post (its kind/content/tags are preserved)
 * @param tokens the tokens spent from the wallet; tokens[0] becomes the event's signer
 * @param realSecretKey the author's long-lived key (signs only the encrypted attestation)
 * @param communityKey the shared community key the attribution is encrypted under
 * @param meta optional display name + gradient to embed for member-side rendering
 */
export function toBlindEvent(
  unsigned: UnsignedEvent,
  tokens: readonly Token[],
  realSecretKey: Uint8Array,
  communityKey: Uint8Array,
  meta: AttributionMeta = {},
): Event {
  if (tokens.length === 0) {
    throw new Error('toBlindEvent requires at least one spent token');
  }
  const eventPubkeyHex = bytesToHex(tokens[0]!.token);
  const attr = buildAttribution(realSecretKey, eventPubkeyHex, communityKey, meta);
  return assembleBlindEvent(unsigned, tokens, attr);
}

/** True if `event` is a blind post (carries an anti-spam token). */
export function isBlindPost(event: {tags: string[][]}): boolean {
  return event.tags.some(t => t[0] === TAG_TOKEN && t[1]);
}

/**
 * Recover the real author of a blind post for member-side rendering/moderation. Returns null for
 * a non-blind event, a missing/invalid attribution, or the wrong community key — callers then
 * fall back to treating it as anonymous.
 */
export function readBlindAuthor(
  event: {pubkey: string; tags: string[][]},
  communityKey: Uint8Array,
): Attribution | null {
  const attr = event.tags.find(t => t[0] === TAG_ATTR && t[1])?.[1];
  return parseAttribution(attr, event.pubkey, communityKey);
}

/** How a blind post's body resolved for rendering. */
export interface ResolvedContent {
  /** The plaintext body — '' when the body is sealed and this device hasn't unlocked its epoch. */
  text: string;
  /** True when the body is sealed under a content epoch key this device has not unlocked. */
  locked: boolean;
}

/**
 * True if `event`'s body is sealed under a content epoch key. Requires BOTH the NIP-44 marker AND
 * that the event is a blind post (carries a token): a content seal is only ever produced by
 * BlindSigner on a blind post, and the marker itself is shared with private-space encryption
 * (channels/groupCrypto). Gating on isBlindPost makes this predicate immune to that collision, so a
 * private-space message that ever reached this render path can never be mis-read as a sealed body.
 */
export function isSealedContent(event: {tags: string[][]}): boolean {
  if (!isBlindPost(event)) return false;
  return event.tags.some(t => t[0] === TAG_ENC && t[1] === ENC_NIP44);
}

/** The epoch named by a sealed post's `ke` tag, or null when absent/malformed. */
export function contentEpochOf(event: {tags: string[][]}): number | null {
  const keRaw = event.tags.find(t => t[0] === TAG_KE && t[1])?.[1];
  if (keRaw === undefined) return null;
  const epoch = Number(keRaw);
  return Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}

/**
 * Cheap (no-decrypt) lock classification for cache keys: '' for a plaintext post, 'u' when the
 * body is sealed and this device has unlocked its epoch, 'L' when sealed and still locked. Feeding
 * this into a per-post render cache key makes a later unlock (L→u) rebuild the item.
 */
export function contentLockState(event: {tags: string[][]}): '' | 'u' | 'L' {
  if (!isSealedContent(event)) return '';
  const epoch = contentEpochOf(event);
  if (epoch === null) return 'L';
  return hasContentEpochKey(epoch) ? 'u' : 'L';
}

/**
 * Resolve a blind post's body for rendering. A plaintext post (no `['encrypted','nip44']` marker)
 * passes through unchanged. A sealed post is decrypted with the content epoch key named by its
 * `ke` tag when this device has unlocked that epoch; otherwise it is reported LOCKED — never
 * rendered as ciphertext — so the UI can offer to spend a read-token and unlock the window.
 */
export function resolveContent(event: {content: string; tags: string[][]}): ResolvedContent {
  if (!isSealedContent(event)) return {text: event.content, locked: false};
  const keRaw = event.tags.find(t => t[0] === TAG_KE && t[1])?.[1];
  const epoch = keRaw === undefined ? NaN : Number(keRaw);
  if (!Number.isInteger(epoch) || epoch < 0) return {text: '', locked: true};
  const key = getContentEpochKey(epoch);
  if (!key) return {text: '', locked: true};
  try {
    return {text: decryptForSpace(event.content, key), locked: false};
  } catch {
    // undecryptable (tampered / wrong key) — treat as locked rather than render ciphertext
    return {text: '', locked: true};
  }
}

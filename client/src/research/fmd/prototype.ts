/**
 * Narrow, flag-gated CLIENT-side FMD prototype (T18-S4) — EVAL-ONLY, spike-not-production.
 *
 * Proves two things over already-downloaded events, without any relay change (T14 no-new-servers):
 *   (1) an FMD flag can ride a DM gift-wrap (as an `extraTags` entry mined into the wrap) or a
 *       mention post, as a `['stiq_fmd', base64(serializeFlag(flag(pk)))]` tag on the stiq_* tag
 *       convention; and
 *   (2) a detection key at precision `n` recovers ALL true positives plus a tunable 2^-n fuzzy set
 *       of decoys — the same npub-blind lookup subscriptionPlan.ts's decoy cover-set approximates,
 *       but with a dial-able anonymity set instead of a fixed (k+1)-inbox one.
 *
 * SHIP-DARK SAFETY. The two functions the production DM/mention send + refresh paths (T18-S7) call —
 * {@link fmdExtraTagsFor} (inject) and {@link fmdDetectInbox} (detect) — both short-circuit on
 * `FMD_EVAL_ENABLED` (config.ts, default false): inject returns `undefined` so `mineGiftWrap`
 * appends nothing and the wrap is byte-identical to today, and detect returns `[]` so no wrap is
 * ever FMD-selected. Every FMD-specific production seam therefore reads the flag before doing
 * anything. The pure {@link fmdFlagTag} / {@link readFmdFlag} / {@link fmdFilterInbox} /
 * {@link detectMentions} primitives are UNGATED on purpose — they are the eval/test surface and are
 * only reachable from a test or a flagged path.
 */
import type {Event} from 'nostr-tools/pure';
import {FMD_EVAL_ENABLED} from '../../config';
import {bytesToBase64, base64ToBytes} from '../../util/base64';
import {
  FMD_GAMMA,
  flag,
  testFlag,
  serializeFlag,
  deserializeFlag,
  generateFmdKeypair,
  type FmdDetectionKey,
  type FmdFlag,
  type FmdKeypair,
} from './fmd';

/** Tag name carrying a serialized FMD flag; follows the stiq_* tag convention (contracts). */
export const TAG_FMD = 'stiq_fmd';

/** Rollup of a detection run over downloaded traffic, for the S3 report's fuzzy-set metrics. */
export interface FmdPrototypeStats {
  /** Total events the member downloaded and tested. */
  downloaded: number;
  /** Genuine recipient matches (FMD guarantees this equals the true-recipient count — no misses). */
  truePositives: number;
  /** Decoy matches (non-recipients that passed the n bit-checks by chance). */
  falsePositives: number;
  /** falsePositives / (non-recipient count) — should track 2^-n. */
  observedFpRate: number;
}

/**
 * Build the FMD flag tag for a recipient whose compressed γ-subkey public key is `recipientFmdPk`.
 * Fresh randomness per call (the tag is a one-time flag ciphertext), so two flags to the same
 * recipient are unlinkable to a detector holding fewer than γ subkeys.
 */
export function fmdFlagTag(recipientFmdPk: Uint8Array[]): string[] {
  return [TAG_FMD, bytesToBase64(serializeFlag(flag(recipientFmdPk)))];
}

/**
 * The FLAG-GUARDED injection helper the production DM/mention send path (T18-S7) calls to obtain
 * `mineGiftWrap`'s `extraTags` argument (or a mention post's extra tags). Returns `[fmdFlagTag(pk)]`
 * ONLY when `FMD_EVAL_ENABLED`; otherwise `undefined`, so the caller passes nothing and the wrap /
 * post is byte-identical to today. This is the single injection choke point — a shipped APK (flag
 * false) never reaches {@link fmdFlagTag}.
 */
export function fmdExtraTagsFor(recipientFmdPk: Uint8Array[]): string[][] | undefined {
  return FMD_EVAL_ENABLED ? [fmdFlagTag(recipientFmdPk)] : undefined;
}

/**
 * EVAL-ONLY registry of per-peer FMD keypairs, so the flag-gated DM send seam (T18-S7, wired at
 * Identity.sealDM) has SOMETHING to flag against. A real FMD deployment would publish each member's
 * γ-subkey public key (e.g. in their beacon/profile) and the sender would look it up by npub; that
 * key-distribution layer is deliberately OUT of the T18 spike scope. Here we lazily mint one keypair
 * per peer hex pubkey and memoize it, so a send and a later detection in the SAME eval process agree
 * on the key. This is NOT secure key management and is NEVER reached in a shipped build: the call-site
 * guard skips it entirely when FMD_EVAL_ENABLED is false, so no keypair is ever generated in production.
 */
const evalKeypairs = new Map<string, FmdKeypair>();

/** Lazily mint + memoize the eval FMD keypair for `peerHexPubkey` (see {@link evalKeypairs}). */
export function evalRecipientFmdKeypair(peerHexPubkey: string, gamma: number = FMD_GAMMA): FmdKeypair {
  let kp = evalKeypairs.get(peerHexPubkey);
  if (kp === undefined) {
    kp = generateFmdKeypair(gamma);
    evalKeypairs.set(peerHexPubkey, kp);
  }
  return kp;
}

/**
 * The recipient γ-subkey PUBLIC key the flag-gated DM send path passes to {@link fmdExtraTagsFor}.
 * EVAL-ONLY stand-in for "fetch the recipient's published FMD pk" — deterministic within one process
 * via {@link evalRecipientFmdKeypair}. Only ever called under FMD_EVAL_ENABLED at the guarded call-site.
 */
export function evalRecipientFmdPk(peerHexPubkey: string, gamma: number = FMD_GAMMA): Uint8Array[] {
  return evalRecipientFmdKeypair(peerHexPubkey, gamma).pk;
}

/**
 * Recover an FMD flag from an event's `stiq_fmd` tag. Returns null if the tag is absent or the
 * payload is malformed (wrong base64 / wrong length for `gamma`), so callers can treat "no flag"
 * and "bad flag" identically (a non-match).
 */
export function readFmdFlag(event: Event, gamma: number = FMD_GAMMA): FmdFlag | null {
  const tag = event.tags.find(t => t[0] === TAG_FMD && typeof t[1] === 'string');
  if (!tag || tag[1] === undefined) return null;
  try {
    return deserializeFlag(base64ToBytes(tag[1]), gamma);
  } catch {
    return null;
  }
}

/**
 * SIMULATE the relay-side FMD match locally (the spike proves detection client-side over wraps that
 * were already downloaded): keep only wraps whose flag tests true for `dk`. A genuine recipient's
 * wraps are ALWAYS retained (zero false negatives); non-recipient decoys survive with probability
 * 2^-dk.n. Ungated eval surface — production reaches it only through {@link fmdDetectInbox}.
 */
export function fmdFilterInbox(wraps: Event[], dk: FmdDetectionKey, gamma: number = FMD_GAMMA): Event[] {
  return wraps.filter(w => {
    const fl = readFmdFlag(w, gamma);
    return fl ? testFlag(dk, fl) : false;
  });
}

/**
 * The FLAG-GUARDED detection entrypoint the production DM/mention refresh path (T18-S7) calls. With
 * `FMD_EVAL_ENABLED` false the filter is BYPASSED entirely (returns `[]` — no wrap is FMD-selected,
 * so the shipping decoy cover-set in subscriptionPlan.ts remains the sole mechanism). Flip the flag
 * in a local eval build to exercise {@link fmdFilterInbox}.
 */
export function fmdDetectInbox(wraps: Event[], dk: FmdDetectionKey, gamma: number = FMD_GAMMA): Event[] {
  if (!FMD_EVAL_ENABLED) return [];
  return fmdFilterInbox(wraps, dk, gamma);
}

/**
 * Detect mentions WITHOUT revealing the member's npub: each post carrying a `stiq_fmd` flag
 * addressed at the member's FMD pubkey matches, so a member finds their mentions without ever
 * issuing a `#p == me` REQ — the exact identity leak subscriptionPlan.ts guards DMs/self-lists
 * against. Returns one `{post, matched}` per input post (order preserved) so a caller can both
 * surface matches and count the fuzzy set.
 */
export function detectMentions(
  posts: Event[],
  dk: FmdDetectionKey,
  gamma: number = FMD_GAMMA,
): {post: Event; matched: boolean}[] {
  return posts.map(post => {
    const fl = readFmdFlag(post, gamma);
    return {post, matched: fl ? testFlag(dk, fl) : false};
  });
}

/**
 * Fold a detection run into {@link FmdPrototypeStats}. `nonRecipients` is the count of downloaded
 * events that were NOT addressed to the member (the denominator for the false-positive rate), and
 * `isTrueRecipient` reports whether a matched event was a genuine recipient event (vs a decoy).
 */
export function prototypeStats(
  downloaded: number,
  nonRecipients: number,
  matched: Event[],
  isTrueRecipient: (e: Event) => boolean,
): FmdPrototypeStats {
  let truePositives = 0;
  let falsePositives = 0;
  for (const e of matched) {
    if (isTrueRecipient(e)) truePositives++;
    else falsePositives++;
  }
  return {
    downloaded,
    truePositives,
    falsePositives,
    observedFpRate: nonRecipients > 0 ? falsePositives / nonRecipients : 0,
  };
}

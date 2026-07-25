/**
 * Attribution — bind a blind post's throwaway signer to its real author, encrypted so only
 * community members (never the relay/host) can read it.
 *
 * A blind post is signed by a fresh throwaway key. To let members attribute it — for profiles,
 * threads and moderation — the author also produces an "attestation": a tiny Nostr event signed
 * by their REAL key that commits to this post's throwaway pubkey (via the `bind` tag). The
 * attestation is NIP-44-encrypted under the shared community key and rides in the post's
 * `stiq_attr` tag. Because the attestation is a normal signed event, `verifyEvent` proves the
 * real key authorized exactly this throwaway key; because it is encrypted to the community key,
 * a relay/host sees only ciphertext and cannot link the post to an npub.
 *
 * Replay-safety: the `bind` tag pins the attestation to one throwaway pubkey, and each blind
 * post uses a unique throwaway key, so a captured attribution tag cannot be re-pasted onto a
 * different post to frame someone.
 *
 * PURE module (no React, no storage). The community key is passed in by the caller.
 */
import {finalizeEvent, verifyEvent, type Event} from 'nostr-tools/pure';
import {encryptForSpace, decryptForSpace} from '../channels/groupCrypto';
import {ATTR_BIND, ATTR_GRAD, ATTR_NAME, KIND_ATTESTATION} from './protocol';

/** The identity a member recovers from a blind post's `stiq_attr` tag. */
export interface Attribution {
  /** The author's real hex pubkey (npub, decoded). */
  pubkey: string;
  /** The author's chosen display name, if they included one. */
  name?: string;
  /** The author's gradient-identity wire form, if they included one. */
  gradient?: string;
}

/** Optional identity extras to embed alongside the author pubkey. */
export interface AttributionMeta {
  name?: string;
  gradient?: string;
}

/**
 * Build the encrypted `stiq_attr` tag value for a blind post. `realSecretKey` is the author's
 * long-lived key; `throwawayPubkey` is the fresh key that signs the post; `communityKey` is the
 * shared 32-byte NIP-44 key every member holds. Returns the NIP-44 ciphertext to place as the
 * tag value.
 */
export function buildAttribution(
  realSecretKey: Uint8Array,
  throwawayPubkey: string,
  communityKey: Uint8Array,
  meta: AttributionMeta = {},
): string {
  const tags: string[][] = [[ATTR_BIND, throwawayPubkey]];
  if (meta.name) tags.push([ATTR_NAME, meta.name]);
  if (meta.gradient) tags.push([ATTR_GRAD, meta.gradient]);
  const attestation = finalizeEvent(
    {
      kind: KIND_ATTESTATION,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    realSecretKey,
  );
  return encryptForSpace(JSON.stringify(attestation), communityKey);
}

/**
 * Recover and verify a blind post's author from its `stiq_attr` tag value. Returns null (never
 * throws) if the tag is missing, the community key is wrong, the attestation signature is
 * invalid, or it does not bind THIS post's throwaway pubkey — callers then render the post as
 * anonymous rather than trusting an unverifiable claim.
 *
 * @param attrTagValue the `stiq_attr` tag value (NIP-44 ciphertext)
 * @param throwawayPubkey the post's `event.pubkey` (the throwaway signer) — must match `bind`
 * @param communityKey the shared 32-byte community key
 */
export function parseAttribution(
  attrTagValue: string | undefined,
  throwawayPubkey: string,
  communityKey: Uint8Array,
): Attribution | null {
  if (!attrTagValue) return null;
  try {
    const json = decryptForSpace(attrTagValue, communityKey);
    const attestation = JSON.parse(json) as Event;
    if (!attestation || attestation.kind !== KIND_ATTESTATION) return null;
    if (!verifyEvent(attestation)) return null;
    const bound = attestation.tags.find(t => t[0] === ATTR_BIND && t[1])?.[1];
    // The attestation must commit to exactly this post's throwaway key, or it is a replay.
    if (bound !== throwawayPubkey) return null;
    const name = attestation.tags.find(t => t[0] === ATTR_NAME && t[1])?.[1];
    const gradient = attestation.tags.find(t => t[0] === ATTR_GRAD && t[1])?.[1];
    return {
      pubkey: attestation.pubkey,
      ...(name ? {name} : {}),
      ...(gradient ? {gradient} : {}),
    };
  } catch {
    return null;
  }
}

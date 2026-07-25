/**
 * Identity documents — two relay-published carriers of a user's relay-blind identity (display
 * name + gradient), complementing the SOH identity headers that already ride inside posts/DMs
 * ([[displayName]], [[gradientIdentity]]).
 *
 *  • Identity BEACON  — kind-30078, d="identity". Content is the SAME SOH-framed identity header a
 *    post carries, so the relay never interprets it (same relay-blind property as posts). Riding
 *    the firehose, it lets peers LEARN a user's name/gradient the moment it changes — without
 *    waiting for that user to author a post. Addressable → one beacon per author, latest replaces.
 *
 *  • Encrypted PROFILE — kind-30078, d="identity-enc". The identity as a compact JSON payload,
 *    NIP-44-encrypted to the author's OWN key (built/decrypted in keys/identity.ts, which owns
 *    secret-key access). The relay stores only ciphertext, so it is a genuinely private, queryable
 *    source-of-truth that converges across a user's own devices (they share the key). Peers receive
 *    the ciphertext but cannot read it.
 *
 * Both use kind-30078 with NON-`stiq:` `d` tags, which the relay accepts from any bound member
 * (only `stiq:`-prefixed d tags are reserved to the organizer key). Zero relay changes required.
 */
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {Kind} from '../nostr/events';
import {encodeIdentityHeader, decodeNameHeader, decodeGradientHeader} from './displayName';

/** kind-30078 `d` tag for the relay-blind identity beacon (SOH-header content). */
export const D_IDENTITY_BEACON = 'identity';
/** kind-30078 `d` tag for the NIP-44 self-encrypted profile (ciphertext content). */
export const D_IDENTITY_PROFILE = 'identity-enc';

const dTagOf = (event: Event): string | undefined => event.tags.find(t => t[0] === 'd')?.[1];

/** Whether at least one of name / gradient is set (i.e. there is something worth announcing). */
export function hasIdentityToPublish(name: string, gradientWire: string): boolean {
  return !!name || !!gradientWire;
}

/**
 * Build the UNSIGNED identity beacon: an addressable kind-30078 (`d="identity"`) whose content is
 * the SOH identity header (name + gradient), exactly the framing posts use. Returns null when the
 * user has neither a name nor a custom gradient (empty header → nothing to announce).
 */
export function buildIdentityBeacon(
  name: string,
  gradientWire: string,
  createdAt: number,
): UnsignedEvent | null {
  const content = encodeIdentityHeader('', name, gradientWire);
  if (!content) return null;
  return {kind: Kind.AppData, created_at: createdAt, tags: [['d', D_IDENTITY_BEACON]], content};
}

/** Whether an event is an identity beacon (kind-30078, d="identity"). */
export function isIdentityBeacon(event: Event): boolean {
  return event.kind === Kind.AppData && dTagOf(event) === D_IDENTITY_BEACON;
}

/** Whether an event is an encrypted self-profile (kind-30078, d="identity-enc"). */
export function isEncryptedProfile(event: Event): boolean {
  return event.kind === Kind.AppData && dTagOf(event) === D_IDENTITY_PROFILE;
}

/** Parse a beacon's header content into the author's claimed name + gradient wire. */
export function readIdentityBeacon(content: string): {name?: string; gradientWire?: string} {
  const {name} = decodeNameHeader(content);
  return {name, gradientWire: decodeGradientHeader(content)};
}

/** The encrypted-profile plaintext (pre-NIP-44): compact `{n?:name, g?:gradientWire}` JSON. */
export interface ProfilePayload {
  /** display name */
  n?: string;
  /** gradient wire (compact form) */
  g?: string;
}

/** Wrap the SIGNED-and-encrypted profile ciphertext as an addressable kind-30078 event body. */
export function buildEncryptedProfileEvent(ciphertext: string, createdAt: number): UnsignedEvent {
  return {kind: Kind.AppData, created_at: createdAt, tags: [['d', D_IDENTITY_PROFILE]], content: ciphertext};
}

/** Serialise the profile payload for encryption (omits empty fields to keep it compact). */
export function encodeProfilePayload(name: string, gradientWire: string): string {
  const payload: ProfilePayload = {};
  if (name) payload.n = name;
  if (gradientWire) payload.g = gradientWire;
  return JSON.stringify(payload);
}

/** Parse a decrypted profile payload; tolerant of malformed/absent fields (never throws). */
export function decodeProfilePayload(json: string): ProfilePayload {
  try {
    const obj = JSON.parse(json) as ProfilePayload;
    if (!obj || typeof obj !== 'object') return {};
    return {
      n: typeof obj.n === 'string' ? obj.n : undefined,
      g: typeof obj.g === 'string' ? obj.g : undefined,
    };
  } catch {
    return {};
  }
}

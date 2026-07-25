/**
 * Channel / group invite links (PLAN.md Phase 4 + #8 E2E key delivery).
 *
 * Generates a deep-link URL that recipients can tap to open the space in the app. The host app
 * handles `stiq://channel/<id>` on startup.
 *
 * The invite link is now NAVIGATE-ONLY: it never carries the space's E2E key. For a private space,
 * the key is delivered exclusively via a kind-30079 event when an admin approves the recipient's
 * join request (see `deliverCurrentSpaceKeyTo` in AppRuntime) — never embedded in a URL. This closes
 * the exposure window where a copy/pasted or logged link could leak the membership credential.
 *
 * `parseInviteLink` remains tolerant of a legacy `#k=…&e=…` fragment so any invite links that were
 * already shared before this change keep delivering their key on accept; we simply stop PRODUCING
 * new keyed links.
 */
import {parseKeyFragment} from './groupCrypto';

export interface ParsedInvite {
  /** The space id (NIP-29 group id or NIP-53 channel coordinate). */
  spaceId: string;
  /** The shared E2E key, present only for a private space whose invite carried a key fragment. */
  key?: Uint8Array;
  /** The key's epoch (only meaningful when `key` is present). */
  epoch?: number;
}

/**
 * Build a shareable, navigate-only invite link for a space: `stiq://channel/<id>`. Never carries
 * an E2E key — for a private space the recipient requests to join and the admin's approval
 * delivers the current-epoch key via kind-30079 (see AppRuntime's `deliverCurrentSpaceKeyTo`).
 */
export function buildInviteLink(spaceId: string): string {
  return `stiq://channel/${encodeURIComponent(spaceId)}`;
}

/**
 * Matches a `stiq://channel/<id>` invite link inside a longer message body — the token every link
 * detector (RichText EMBED_RE, MessageBody CONTENT_RE) splices in so a pasted/DM'd invite renders
 * as a tappable card instead of dead text (bug #12 lesson: every detector must recognize the token,
 * and they must never drift). `\S+` intentionally swallows any trailing legacy `#k=…&e=…` fragment —
 * `parseInviteLink` splits the fragment itself, so the whole matched substring is passed through.
 */
export const INVITE_LINK_RE = /stiq:\/\/channel\/\S+/g;

/**
 * Parse an invite link into its space id and (if a legacy private-space fragment is present) the
 * E2E key + epoch. Robust to malformed input: a missing/garbled fragment simply yields no key (the
 * link still opens the space, just without decryption material). Returns null only when there is no
 * recognisable space id at all.
 */
export function parseInviteLink(url: string): ParsedInvite | null {
  if (typeof url !== 'string') return null;
  // Split off the fragment ourselves: RN's URL doesn't always expose `.hash`, and we must not let
  // a server ever receive it. Everything after the FIRST '#' is the fragment.
  const hashIdx = url.indexOf('#');
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';

  // Expect `stiq://channel/<encoded-id>` (optionally with a trailing slash/query we ignore).
  const m = /^stiq:\/\/channel\/([^/?#]+)/i.exec(beforeHash.trim());
  if (!m || !m[1]) return null;
  let spaceId: string;
  try {
    spaceId = decodeURIComponent(m[1]);
  } catch {
    spaceId = m[1];
  }
  if (!spaceId) return null;

  const parsedKey = fragment ? parseKeyFragment(fragment) : null;
  return parsedKey ? {spaceId, key: parsedKey.key, epoch: parsedKey.epoch} : {spaceId};
}

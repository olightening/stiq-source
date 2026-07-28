/**
 * Channel / group invite links (PLAN.md Phase 4 + #8 E2E key delivery).
 *
 * Generates a deep-link URL that recipients can tap to open the space in the app. The host app
 * handles `stiq://channel/<id>` on startup.
 *
 * The invite link is NAVIGATE-ONLY: it never carries the space's E2E key, and — since the
 * link-hardening pass — a link can no longer DELIVER one either. For a private space the key is
 * delivered exclusively via a kind-30079 event when an admin approves the recipient's join request
 * (see `deliverCurrentSpaceKeyTo` / the 30079 ingest path in AppRuntime, which verifies the sender is
 * an owner/admin of that space before it will replace a cached key).
 *
 * ── WHY A LINK CAN NO LONGER CARRY A KEY (security) ────────────────────────────────────────────
 * `parseInviteLink` used to hand back the `#k=…&e=…` fragment's key so a pre-existing "legacy" keyed
 * link kept working. Nothing about that fragment is authenticated: an attacker picks BOTH halves of
 * `stiq://channel/<victim's space id>#k=<attacker key>&e=<huge epoch>`, and the tap handler adopted
 * it with no prompt. Downstream that meant:
 *   - the key was PERSISTED to secure storage and cached in memory (`cacheSpaceKey`), surviving
 *     restart;
 *   - the huge epoch became the space's tracked "current" epoch, so `outgoingSpaceKey` picked the
 *     ATTACKER'S key to encrypt the victim's own outgoing messages — readable off the relay by the
 *     attacker, and by nobody else;
 *   - a same-epoch link silently OVERWROTE the real key for a space the victim already trusted,
 *     which also stops the genuine messages decrypting;
 *   - it marked the space locally encrypted (`addEncryptedSpace`), which fails outgoing sends closed
 *     for a genuinely public space — a one-tap denial of service.
 * There is no way to make this safe by validating the link: the link is entirely attacker-authored,
 * so the key cannot be bound to anything it cannot also forge, and "do you trust these 32 bytes?" is
 * not a question a user can answer. The only sound rule is the one implemented here — key material
 * arriving over an untrusted link is DISCARDED, never adopted. Legitimate access still works: the
 * link opens the space, the recipient requests to join, and admin approval delivers the current key
 * over the authenticated kind-30079 path.
 *
 * Nothing legitimate regresses: `buildInviteLink` has not produced a keyed link for a long time, the
 * organizer's multi-use / expiring / short invites are `stiq://join?c=…` codes (a different deep-link
 * host entirely, untouched here), and a stale legacy keyed link still navigates — it just lands the
 * recipient on request-to-join instead of silently seeding a key.
 */
import {parseKeyFragment} from './groupCrypto';

export interface ParsedInvite {
  /** The space id (NIP-29 group id or NIP-53 channel coordinate). */
  spaceId: string;
  /**
   * ALWAYS `undefined`. Retained (typed as `undefined`, not `Uint8Array`) so that any code which
   * still reads a key off a parsed link is a compile error rather than a silent key adoption.
   * @deprecated A link never carries usable key material — see the module header. Space keys arrive
   * only via the authenticated kind-30079 delivery path.
   */
  key?: undefined;
  /**
   * ALWAYS `undefined` — same reasoning as {@link ParsedInvite.key}.
   * @deprecated
   */
  epoch?: undefined;
  /**
   * True when the link DID carry a well-formed `#k=…` key fragment that we deliberately threw away.
   * Only ever informational: a UI may use it to explain "this invite tried to hand your app a key;
   * it was ignored — request to join and an admin will send you the real one." Absent otherwise, so
   * a plain link still parses to exactly `{spaceId}`.
   */
  rejectedKeyFragment?: true;
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
 * and they must never drift). `\S+` intentionally swallows any trailing `#k=…&e=…` fragment —
 * `parseInviteLink` splits the fragment itself (and discards its key), so the whole matched
 * substring is passed through.
 */
export const INVITE_LINK_RE = /stiq:\/\/channel\/\S+/g;

/**
 * Parse an invite link into its space id.
 *
 * Any `#…` fragment is split off and DISCARDED — including a well-formed `k=…&e=…` key fragment,
 * which is never returned to the caller and never reaches storage (see the module header for why).
 * Robust to malformed input: a missing/garbled fragment simply parses to the bare space id. Returns
 * null only when there is no recognisable space id at all.
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

  return fragmentCarriesKey(fragment) ? {spaceId, rejectedKeyFragment: true} : {spaceId};
}

/**
 * Whether a URL fragment carries a well-formed space key we are refusing to adopt. Parses it purely
 * to classify, zeroes the decoded bytes, and returns a boolean — the key itself never escapes this
 * function. `parseKeyFragment` never throws (it returns null on anything malformed), so a garbled or
 * hostile fragment is simply "no key".
 */
function fragmentCarriesKey(fragment: string): boolean {
  if (!fragment) return false;
  const parsed = parseKeyFragment(fragment);
  if (!parsed) return false;
  parsed.key.fill(0); // don't leave attacker-supplied key bytes lying in a live buffer
  return true;
}

/**
 * Public form of the same check, for a caller that wants to warn about a keyed link before/without
 * parsing it. Never returns the key.
 */
export function inviteLinkCarriesKeyFragment(url: string): boolean {
  if (typeof url !== 'string') return false;
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return false;
  return fragmentCarriesKey(url.slice(hashIdx + 1));
}

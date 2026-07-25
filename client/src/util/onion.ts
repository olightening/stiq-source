/**
 * Tor v3 onion URL validation, shared by the relay socket (Step 5) and invite parsing
 * (Step 6). A v3 onion host is exactly 56 base32 characters (a-z, 2-7) + ".onion".
 *
 * Only ws:// and wss:// onion URLs are accepted — never a clearnet host. This is a
 * security boundary: an invite or relay config must never point the app at a non-Tor relay
 * (PLAN.md §3.2).
 */
const ONION_WS_RE = /^wss?:\/\/[a-z2-7]{56}\.onion(?::\d{1,5})?(?:\/\S*)?$/i;

export function isOnionWsUrl(url: string): boolean {
  return ONION_WS_RE.test(url.trim());
}

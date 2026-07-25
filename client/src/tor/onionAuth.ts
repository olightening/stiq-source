/**
 * onionAuth — the Tor v3 client-authorization credential that lets a member's device REACH the
 * relay onion. This is lever 2: the npub-blind relay-reach restriction.
 *
 * The community's relay onion is provisioned with v3 client authorization (see deploy/stiq-up.sh):
 * its descriptor is published ENCRYPTED to the community auth PUBLIC key, so only a client holding
 * the matching PRIVATE key can resolve/rendezvous with the service at all. An outsider who merely
 * learns the `.onion` address — the exact worry that motivated this — cannot connect, so plaintext
 * enumeration and even fetching ciphertext are off the table for non-members.
 *
 * The whole community shares ONE auth keypair; the private key rides in the join code alongside the
 * community key (community-code v4). Sharing one keypair is deliberate: the relay authorizes the
 * descriptor collectively and never learns WHICH member connected, so reach stays npub-blind.
 * Cutting off an individual is the job of the read-token meter (content stays sealed) plus key
 * rotation, not of per-member onion auth.
 *
 * Tor reads client auth from a `ClientOnionAuthDir` of `<host>.auth_private` files, each ONE line:
 *
 *     <onion-address-without-.onion>:descriptor:x25519:<BASE32 privkey>
 *
 * This PURE module produces that filename + line and validates the key, so the native Tor module
 * can drop the file in place before boot. No native, no fs, no crypto here.
 */

/** An x25519 client-auth key is 32 bytes → 52 chars of unpadded uppercase base32. */
export const ONION_AUTH_KEY_LEN = 52;

const BASE32_KEY_RE = /^[A-Z2-7]{52}$/;

/** True if `s` is a well-formed unpadded-uppercase-base32 x25519 client-auth key. */
export function isValidAuthKeyBase32(s: string | undefined | null): s is string {
  return typeof s === 'string' && BASE32_KEY_RE.test(s);
}

/**
 * Extract the bare onion host (56-char v3 address, WITHOUT the `.onion` suffix) from a relay URL
 * like `ws://<56chars>.onion` or `ws://<56chars>.onion/`. Returns null when the URL is not a v3
 * onion — Tor's client-auth file keys on this bare address. Pure string parse (no `new URL()`,
 * which throws under Hermes — see url.ts).
 */
export function onionHostOf(relayUrl: string): string | null {
  if (typeof relayUrl !== 'string') return null;
  let s = relayUrl.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  // Drop anything after the authority (path/query/port).
  s = s.split(/[/?#]/, 1)[0] ?? '';
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = s.toLowerCase();
  if (!s.endsWith('.onion')) return null;
  const host = s.slice(0, -'.onion'.length);
  // v3 onion addresses are exactly 56 base32 chars.
  return /^[a-z2-7]{56}$/.test(host) ? host : null;
}

/** A resolved reach credential for the native Tor start config: bare onion host + base32 key. */
export interface OnionAuth {
  onionHost: string;
  privKeyBase32: string;
}

/**
 * Derive the native `onionAuth` start-config from a community's relay URL and its shared onion-auth
 * key. Returns null when the community carries no auth key or the relay URL isn't a v3 onion — the
 * caller then connects to a public onion. Pure.
 */
export function deriveOnionAuth(
  relayUrl: string,
  onionAuthKey: string | undefined,
): OnionAuth | null {
  if (!isValidAuthKeyBase32(onionAuthKey)) return null;
  const onionHost = onionHostOf(relayUrl);
  if (!onionHost) return null;
  return {onionHost, privKeyBase32: onionAuthKey};
}

// In-memory active reach credential, mirroring communityKey's active-key holder: set on community
// (re)activation so the app can hand it to the Tor manager before (re)connecting. null = public onion.
let _activeOnionAuth: OnionAuth | null = null;

/** Publish the active community's reach credential (or null to clear). Read by the Tor manager wiring. */
export function setActiveOnionAuth(auth: OnionAuth | null): void {
  _activeOnionAuth = auth;
}

/** The active community's reach credential, or null when the active onion is public. */
export function getActiveOnionAuth(): OnionAuth | null {
  return _activeOnionAuth;
}

/**
 * Derive the reach credential SET for every mirror of a community (P2 §1.7 multi-relay client
 * transport). Each mirror can carry its own onion host + auth key (or none, for a public onion);
 * this maps deriveOnionAuth over the list, drops entries with no resolvable credential, and
 * de-dups by onion host (first occurrence wins) so a mirror list that repeats a host under two
 * URLs — or shares the community's one auth keypair across every mirror, the common case — never
 * produces duplicate `<host>.auth_private` writes. Pure.
 */
export function deriveOnionAuthSet(
  mirrors: readonly {url: string; onionAuthKey?: string | null}[],
): OnionAuth[] {
  const seen = new Set<string>();
  const out: OnionAuth[] = [];
  for (const m of mirrors) {
    const auth = deriveOnionAuth(m.url, m.onionAuthKey ?? undefined);
    if (!auth) continue;
    if (seen.has(auth.onionHost)) continue;
    seen.add(auth.onionHost);
    out.push(auth);
  }
  return out;
}

// In-memory EXTRA reach credentials — every SECONDARY mirror's auth beyond the primary
// (`_activeOnionAuth` above stays the primary-only slot so single-mirror behaviour is
// byte-identical). Set on community (re)activation alongside `setActiveOnionAuth`. Inert until a
// caller wires `resolveOnionAuthExtra` into the Tor manager (P2 SC).
let _activeOnionAuthExtra: OnionAuth[] = [];

/** Publish the active community's SECONDARY-mirror reach credentials (or [] to clear). */
export function setActiveOnionAuthExtra(list: OnionAuth[]): void {
  _activeOnionAuthExtra = list;
}

/** The active community's secondary-mirror reach credentials (empty when none/public). */
export function getActiveOnionAuthExtra(): OnionAuth[] {
  return _activeOnionAuthExtra;
}

/**
 * Whether two reach-credential sets are equal. Order-sensitive is fine: both operands are produced by
 * the deterministic {@link deriveOnionAuthSet}, so the same effective mirror list always yields the
 * same order. Used to decide whether a durable `stiq:mirrors` update actually CHANGED the daemon's
 * required onion-auth set (a Tor restart is only worth triggering when it did — Tor reads
 * ClientOnionAuthDir at startup, so a new auth-gated mirror needs the daemon to boot with its key). Pure.
 */
export function sameOnionAuthSet(a: readonly OnionAuth[], b: readonly OnionAuth[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.onionHost !== b[i]!.onionHost || a[i]!.privKeyBase32 !== b[i]!.privKeyBase32) {
      return false;
    }
  }
  return true;
}

/**
 * Guard against the multi-community onion-auth clobber: while a fresh/additive join targets a
 * different onion (`overrideActive` — see App.tsx's `onboardingOnionAuth`), the native "primary"
 * onionAuth slot temporarily reports the PENDING join's credential (or explicitly `null`, for a
 * deliberately public onion) instead of the currently-ACTIVE community's. Left alone, the active
 * community's primary reach credential then lands in NEITHER the primary slot (displaced by the
 * override) NOR the extra/secondary slot (untouched) — so its `<host>.auth_private` file stops
 * being written while the join is pending, and the already-joined community's own relay can go
 * unreachable mid-join.
 *
 * Folds the displaced active-community primary into the extra set so its auth_private file keeps
 * being written alongside the pending join's. No-op (returns `extras.slice()`) when: there is no
 * override in effect, there is no active primary to preserve, the override targets the SAME onion
 * host as the active primary (nothing was actually displaced), or `extras` already carries the
 * active primary's host (would just duplicate the write). Pure.
 */
export function preserveDisplacedActivePrimary(
  extras: readonly OnionAuth[],
  activePrimary: OnionAuth | null,
  overrideActive: boolean,
  override: OnionAuth | null,
): OnionAuth[] {
  if (!overrideActive || !activePrimary) return extras.slice();
  if (override && override.onionHost === activePrimary.onionHost) return extras.slice();
  if (extras.some(a => a.onionHost === activePrimary.onionHost)) return extras.slice();
  return [activePrimary, ...extras];
}

/** The client-auth filename Tor expects inside ClientOnionAuthDir for this onion host. */
export function authPrivateFileName(onionHost: string): string {
  return `${onionHost}.auth_private`;
}

/**
 * The single-line body of the `<host>.auth_private` file. Returns null if the host or key is
 * malformed, so the caller never writes a file that would make Tor refuse to start.
 */
export function authPrivateFileContent(
  onionHost: string,
  privKeyBase32: string,
): string | null {
  if (!/^[a-z2-7]{56}$/.test(onionHost)) return null;
  if (!isValidAuthKeyBase32(privKeyBase32)) return null;
  return `${onionHost}:descriptor:x25519:${privKeyBase32}\n`;
}

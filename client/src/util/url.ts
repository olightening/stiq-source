/**
 * URL safety utilities for opening links and referencing media (PLAN.md §3.2).
 *
 * Pure and dependency-free — in particular it NEVER calls the global `URL` constructor, which is a
 * throwing stub on React Native's Hermes (the `whatwg-url` polyfill does not reliably load on
 * device). All parsing is done with string ops so it behaves identically under Node and Hermes.
 * Used by the link-opening UI and the Tor fetch layer to:
 *   - classify a destination as a Tor `.onion` (stays inside Tor) vs clearnet (egresses via
 *     an exit node), so the UI can warn appropriately;
 *   - flag IDN/punycode homograph domains that could spoof a trusted site;
 *   - strip privacy-hostile tracking parameters (a per-recipient `?token=` is itself a
 *     deanonymization signal — it tells the poster exactly who clicked).
 */

export type UrlKind = 'onion' | 'clearnet' | 'invalid';

export interface UrlInfo {
  kind: UrlKind;
  /** Lowercased hostname, or '' when unparseable. */
  host: string;
  /** True only for an https:// origin. */
  secure: boolean;
  /** Normalized href, or the original string when unparseable. */
  href: string;
}

// A v3 onion host is exactly 56 base32 chars + ".onion". We also accept any ".onion" suffix
// for classification (v2 is dead, but a non-56 ".onion" is still unmistakably a Tor host).
const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/i;
const ONION_ANY_RE = /\.onion$/i;

/** Any `.onion` host — used to decide whether a fetch can stay entirely inside Tor. */
export function isOnionHost(host: string): boolean {
  return ONION_ANY_RE.test(host);
}

/** Strict Tor v3 onion host (56 base32 + .onion). */
export function isV3OnionHost(host: string): boolean {
  return ONION_V3_RE.test(host);
}

/**
 * Parsed pieces of a `scheme://authority/path…` URL, extracted WITHOUT the global `URL`
 * constructor. React Native's Hermes ships a `URL` stub whose getters throw "not implemented",
 * and the `whatwg-url` polyfill does not reliably take effect on-device — so `new URL()` cannot be
 * trusted here (it threw for real links, which silently disabled "Open link" and skipped tracking
 * stripping). This is pure string parsing, so it behaves identically under Node (tests) and Hermes.
 */
interface UrlParts {
  /** Lowercased scheme without the trailing ':' (e.g. "https"). */
  scheme: string;
  /** Lowercased hostname — no userinfo, no port. */
  host: string;
  /** Authority as written minus userinfo (host[:port]) — used to rebuild a URL. */
  authority: string;
  /** Path beginning with '/', or '' when absent. */
  path: string;
}

/** Split an http(s)-style URL into pieces. Returns null unless it has a `scheme://` prefix. */
function parseUrlParts(raw: string): UrlParts | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(raw.trim());
  if (!m) {
    return null;
  }
  const scheme = (m[1] ?? '').toLowerCase();
  let authority = m[2] ?? '';
  const path = m[3] ?? '';
  const at = authority.lastIndexOf('@'); // strip userinfo (user:pass@)
  if (at !== -1) {
    authority = authority.slice(at + 1);
  }
  // Hostname without port. Bracketed IPv6 literals keep their brackets and carry no port.
  let host: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    host = end === -1 ? authority : authority.slice(0, end + 1);
  } else {
    host = authority.replace(/:\d+$/, '');
  }
  return {scheme, host: host.toLowerCase(), authority, path};
}

/** Classify an http(s) URL. Non-http(s) schemes (javascript:, data:, app links) are invalid. */
export function classifyUrl(raw: string): UrlInfo {
  const parts = parseUrlParts(raw);
  if (!parts) {
    return {kind: 'invalid', host: '', secure: false, href: raw};
  }
  const {scheme, host} = parts;
  const href = raw.trim();
  if ((scheme !== 'http' && scheme !== 'https') || !host) {
    return {kind: 'invalid', host, secure: false, href};
  }
  return {
    kind: isOnionHost(host) ? 'onion' : 'clearnet',
    host,
    secure: scheme === 'https',
    href,
  };
}

/**
 * Host of any `scheme://host…` URL, INCLUDING custom app schemes (e.g. `stiq://join?c=…`), returned
 * lowercased — or '' when the string has no `scheme://authority` prefix. This is the WHATWG
 * `hostname`: for a custom-scheme deep link the authority segment is the "host" (`stiq://join` →
 * "join"). Hermes-safe — it never touches the throwing global `URL` — so the deep-link router in
 * App.tsx behaves identically on-device and under Jest. Distinct from `classifyUrl().host`, which is
 * scoped to http(s) links; use this to route app deep links by their host.
 */
export function urlHost(raw: string): string {
  return parseUrlParts(raw)?.host ?? '';
}

/**
 * Decode one query token the way `URLSearchParams` does: `+`→space, then percent-decode. Falls back
 * to the raw token on malformed percent-encoding (lenient, matching stripTrackingParams).
 */
function decodeQueryComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * First value of query parameter `name`, decoded like `URLSearchParams.get` — or null when absent.
 * Hermes-safe replacement for `new URL(raw).searchParams.get(name)`: it slices the query out of the
 * raw string (between the first '?' and the fragment) and scans the `&`-separated pairs, so it works
 * for custom app schemes (`stiq://join?c=…`) and never depends on the throwing global `URL`. The
 * organizer's join link is built with `encodeURIComponent`, so decoding here restores the raw code.
 */
export function getQueryParam(raw: string, name: string): string | null {
  const qIdx = raw.indexOf('?');
  if (qIdx === -1) {
    return null;
  }
  const after = raw.slice(qIdx + 1);
  const hIdx = after.indexOf('#');
  const queryStr = hIdx === -1 ? after : after.slice(0, hIdx);
  for (const pair of queryStr.split('&')) {
    if (!pair) {
      continue;
    }
    const eqIdx = pair.indexOf('=');
    const key = decodeQueryComponent(eqIdx === -1 ? pair : pair.slice(0, eqIdx));
    if (key === name) {
      return decodeQueryComponent(eqIdx === -1 ? '' : pair.slice(eqIdx + 1));
    }
  }
  return null;
}

export interface HomographResult {
  suspicious: boolean;
  /** Why it's flagged: a raw non-ASCII host, or an `xn--` (IDN) label. */
  reason?: 'non-ascii' | 'punycode';
}

/**
 * Detect display-spoofing hosts. A browser renders `xn--…` labels as their Unicode form,
 * which an attacker can use to mimic a trusted domain (e.g. Cyrillic "a" for Latin "a").
 * We don't decode (no Unicode tables on Hermes) — we flag, so the UI can show the literal
 * host and warn, the way Tor Browser surfaces punycode.
 */
export function detectHomograph(host: string): HomographResult {
  const h = host.toLowerCase();
  // Any code point outside printable ASCII (0x20-0x7e) — a browser would punycode it.
  for (let i = 0; i < h.length; i++) {
    const code = h.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return {suspicious: true, reason: 'non-ascii'};
    }
  }
  if (h.split('.').some(label => label.startsWith('xn--'))) {
    return {suspicious: true, reason: 'punycode'};
  }
  return {suspicious: false};
}

// Known tracking query keys. Exact names plus prefixes (utm_source, utm_medium, ...).
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'wickedid',
  'mc_eid', 'mc_cid', 'igshid', 'igsh', 'rb_clickid', 's_cid', 'epik', 'mkt_tok', 'vero_id',
  'oly_enc_id', 'oly_anon_id', 'spm', 'scm', '_hsenc', '_hsmi', 'ref', 'ref_src', 'ref_url',
  'referrer', 'cmpid', 'campaign_id', 'fb_action_ids', 'fb_source', 'srsltid',
]);
const TRACKING_PREFIX = ['utm_', 'pk_', 'mtm_', 'matomo_', 'hsa_', 'ga_', 'wt_', 'at_custom', 'icid'];

// Host-specific share/attribution params. These only exist to tie a shared link back to whoever
// sent it (an instagram reel's `igsh`, a YouTube `si`, an X `s`/`t`), so we strip them to reduce a
// link to its shortest form. Kept host-scoped because some names are legitimate elsewhere — e.g.
// `t` is a play-position timestamp on YouTube but a share token on X. Ordered most-specific first.
const HOST_TRACKING: Array<{match: RegExp; keys: string[]}> = [
  {match: /(?:^|\.)youtu\.be$|(?:^|\.)youtube\.com$/, keys: ['si', 'feature', 'pp', 'ab_channel']},
  {match: /(?:^|\.)(?:x|twitter)\.com$/, keys: ['s', 't', 'cxt']},
  {match: /(?:^|\.)tiktok\.com$/, keys: ['is_from_webapp', 'sender_device', '_r', '_t', 'web_id']},
  {match: /(?:^|\.)facebook\.com$/, keys: ['mibextid', 'rdid', 'share_url']},
  {match: /(?:^|\.)reddit\.com$/, keys: ['share_id', 'correlation_id', 'ref_source', 'rdt']},
  {match: /(?:^|\.)(?:open\.)?spotify\.com$/, keys: ['si', 'nd']},
];

function hostTrackingKeys(host: string): Set<string> {
  const h = host.toLowerCase();
  const entry = HOST_TRACKING.find(e => e.match.test(h));
  return new Set(entry ? entry.keys : []);
}

function isTrackingKey(key: string, hostKeys: Set<string>): boolean {
  const k = key.toLowerCase();
  return TRACKING_EXACT.has(k) || hostKeys.has(k) || TRACKING_PREFIX.some(p => k.startsWith(p));
}

/**
 * Remove known tracking parameters. Returns the original string UNCHANGED when nothing was
 * stripped (so the result is byte-identical and `hasTrackingParams` is exact); returns a
 * normalized URL when at least one param was removed.
 *
 * Parses the query string (and the host, for host-specific keys) from the raw string directly via
 * parseUrlParts — no `new URL()`, which throws on-device (Hermes) and previously made this return
 * the raw string unchanged, leaking `?igsh=`/`?si=` share tokens.
 */
export function stripTrackingParams(raw: string): string {
  // Host drives host-specific share params; a URL with no parseable host still gets global trackers
  // (utm_*, igsh, fbclid…) stripped — better than returning it untouched.
  const hostKeys = hostTrackingKeys(parseUrlParts(raw)?.host ?? '');
  const qIdx = raw.indexOf('?');
  if (qIdx === -1) {
    return raw;
  }
  const before = raw.slice(0, qIdx);
  const after = raw.slice(qIdx + 1);
  const hIdx = after.indexOf('#');
  const queryStr = hIdx === -1 ? after : after.slice(0, hIdx);
  const hash = hIdx === -1 ? '' : after.slice(hIdx);
  const pairs = queryStr.split('&');
  const kept: string[] = [];
  let removed = false;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) {
      continue;
    }
    const eqIdx = pair.indexOf('=');
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (isTrackingKey(key, hostKeys)) {
        removed = true;
        continue;
      }
    } catch {
      // malformed percent-encoding — keep the pair as-is
    }
    kept.push(pair);
  }
  if (!removed) {
    return raw;
  }
  const qs = kept.join('&');
  return `${before}${qs ? `?${qs}` : ''}${hash}`;
}

/** Whether a URL carries any known tracking parameter. */
export function hasTrackingParams(raw: string): boolean {
  return stripTrackingParams(raw) !== raw;
}

/**
 * Resolve a redirect `Location` (which may be absolute, protocol-relative, root-relative, or
 * path-relative) against the request URL. Hand-rolled (no `new URL()`) because Hermes's URL does
 * not reliably support the two-argument `new URL(ref, base)` form — and throws even for one-arg.
 */
export function resolveRelativeUrl(base: string, ref: string): string {
  const r = ref.trim();
  // Any ref carrying its own scheme is absolute — return it verbatim so a non-http(s) scheme
  // (javascript:, data:, app links) reaches classifyUrl and is rejected, not turned into a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) {
    return r;
  }
  const b = parseUrlParts(base);
  if (!b) {
    return r;
  }
  const root = `${b.scheme}://${b.authority}`;
  if (r.startsWith('//')) {
    return `${b.scheme}:${r}`;
  }
  if (r.startsWith('/')) {
    return `${root}${r}`;
  }
  const dir = (b.path || '/').replace(/[^/]*$/, '');
  return `${root}${dir}${r}`;
}

/** Display host without a leading `www.`; falls back to a trimmed raw string. */
export function prettyDomain(raw: string): string {
  const info = classifyUrl(raw);
  if (info.host) {
    return info.host.replace(/^www\./, '');
  }
  return raw.replace(/^https?:\/\//, '').slice(0, 40);
}

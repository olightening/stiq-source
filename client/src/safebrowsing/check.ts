/**
 * Safe Browsing reputation check (client side).
 *
 * Before opening a link we ask "is this a known phishing/malware URL?" WITHOUT revealing the URL:
 *  1. canonicalize + expand + SHA-256 the link locally ([[./url]]) → full hashes;
 *  2. send only the 4-byte hash PREFIXES to OUR OWN relay over Tor (the relay holds the Google
 *     Safe Browsing API key and proxies the query — see relay/internal/safebrowsing);
 *  3. the relay returns the full hashes Google flagged for those prefixes;
 *  4. we match those against our own full hashes LOCALLY.
 * So neither Google nor the relay ever learns the URL, the path, or the query — only opaque
 * 4-byte prefixes, and only the matching half of the verdict comes back. See
 * [[stiq-safe-links-architecture]].
 *
 * Fails OPEN: if Tor/the relay is unreachable the check returns `checked:false, flagged:false`, so
 * a transient outage never blocks link-opening — the UI just can't show a reputation badge.
 */
import {utf8ToBytes} from '@noble/hashes/utils.js';
import {bytesToBase64} from '../util/base64';
import {utf8Decode} from '../util/utf8';
import {fullHashes, HASH_PREFIX_BYTES} from './url';
import {torFetch, type StiqHttpNative} from '../media/torHttp';
import type {TorManager} from '../tor';

export interface ThreatVerdict {
  /** Whether the reputation lookup actually completed. */
  checked: boolean;
  /** True when a threat-list match was confirmed locally. */
  flagged: boolean;
  /** Google threat types that matched (e.g. SOCIAL_ENGINEERING, MALWARE). */
  threatTypes: string[];
}

/** A relay match: a full hash Google flagged + its threat type. */
export interface RelayMatch {
  hash: string;
  threatType?: string;
}

const SAFE: ThreatVerdict = {checked: false, flagged: false, threatTypes: []};

/** Derive the unique hex hash-prefixes to send, from a URL's full hashes. */
export function prefixesOf(full: string[], prefixBytes: number = HASH_PREFIX_BYTES): string[] {
  const n = prefixBytes * 2;
  const out: string[] = [];
  for (const h of full) {
    const p = h.slice(0, n);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Local final match: which of the relay's flagged hashes are actually hashes of THIS url. */
export function evaluateMatches(full: string[], matches: RelayMatch[]): ThreatVerdict {
  const mine = new Set(full.map(h => h.toLowerCase()));
  const hits = matches.filter(m => typeof m.hash === 'string' && mine.has(m.hash.toLowerCase()));
  const threatTypes: string[] = [];
  for (const h of hits) {
    const t = h.threatType ?? 'THREAT';
    if (!threatTypes.includes(t)) threatTypes.push(t);
  }
  return {checked: true, flagged: hits.length > 0, threatTypes};
}

/** Derive the relay's HTTP base (`http://<onion>`) from its ws(s):// relay URL. */
export function relayHttpBase(relayWsUrl: string): string | null {
  const m = /^wss?:\/\/([^/]+)/i.exec(relayWsUrl.trim());
  if (!m) return null;
  // The relay's HTTP endpoint shares the hidden service; plain http over the onion (Tor encrypts).
  return `http://${m[1]}`;
}

export interface CheckDeps {
  manager: TorManager;
  /** The joined community's relay ws URL, to derive the Safe Browsing endpoint. */
  relayWsUrl: string;
  native?: StiqHttpNative;
  timeoutMs?: number;
}

/**
 * Check a URL's reputation via the relay-proxied Safe Browsing lookup. Never throws — returns
 * `checked:false` on any failure (fail-open).
 */
export async function checkUrl(raw: string, deps: CheckDeps): Promise<ThreatVerdict> {
  const full = fullHashes(raw);
  if (full.length === 0) return SAFE;
  const base = relayHttpBase(deps.relayWsUrl);
  if (!base) return SAFE;

  const body = JSON.stringify({prefixes: prefixesOf(full)});
  try {
    const res = await torFetch(
      deps.manager,
      {
        url: `${base}/safebrowsing`,
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        bodyBase64: bytesToBase64(utf8ToBytes(body)),
        maxBytes: 256 * 1024,
        timeoutMs: deps.timeoutMs ?? 8000,
        maxRedirects: 0,
      },
      deps.native,
    );
    if (res.status !== 200) return SAFE;
    const parsed = JSON.parse(utf8Decode(res.bytes)) as {matches?: RelayMatch[]};
    return evaluateMatches(full, Array.isArray(parsed.matches) ? parsed.matches : []);
  } catch {
    return SAFE;
  }
}

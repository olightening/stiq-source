/**
 * Google Safe Browsing URL canonicalization + hashing (Update API v4 spec).
 *
 * STIQ checks a link's reputation BEFORE opening it, but never sends the URL anywhere: we
 * canonicalize the link, expand it into the up-to-30 host/path "expressions" Safe Browsing
 * defines, SHA-256 each, and send only the 4-byte hash PREFIXES to our own relay (which holds
 * the Google API key and proxies the lookup). Google — and the relay — only ever see opaque
 * 4-byte prefixes, never the URL, the path, or the query.
 *
 * Pure and dependency-light (only @noble/hashes). All string work is done on a "binary string"
 * (one char per byte, 0x00–0xff) so percent-decoding and re-escaping operate on raw bytes, as
 * the spec requires — Hermes lacks a full URL/percent codec we could lean on.
 *
 * Reference: https://developers.google.com/safe-browsing/v4/urls-hashing
 */
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js';

/** Default hash-prefix length Safe Browsing uses for the local/Update path. */
export const HASH_PREFIX_BYTES = 4;

const HEX = '0123456789abcdef';

function isHexByte(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}
function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

/** Bytes → binary string (each char code is one byte). */
function toBin(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return s;
}

/** One pass of percent-decoding over a binary string. */
function unescapeOnce(bin: string): string {
  let out = '';
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i);
    if (c === 0x25 /* % */ && i + 2 < bin.length && isHexByte(bin.charCodeAt(i + 1)) && isHexByte(bin.charCodeAt(i + 2))) {
      out += String.fromCharCode(hexVal(bin.charCodeAt(i + 1)) * 16 + hexVal(bin.charCodeAt(i + 2)));
      i += 2;
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

/** Repeatedly percent-decode until stable (spec: "until it has no more percent-escapes"). */
function unescapeRepeated(bin: string): string {
  let cur = bin;
  for (let i = 0; i < 10; i++) {
    const next = unescapeOnce(cur);
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

/** Percent-escape bytes that are unsafe per the spec: <=0x20, >=0x7f, '#', '%'. */
function escapeBin(bin: string): string {
  let out = '';
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f || c === 0x23 /* # */ || c === 0x25 /* % */) {
      out += '%' + HEX[(c >> 4) & 0xf] + HEX[c & 0xf];
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

/** Canonicalize the host: trim/collapse dots, lowercase, normalize a dotted-decimal IP. */
function canonicalizeHost(host: string): string {
  let h = host.replace(/^\.+/, '').replace(/\.+$/, '').replace(/\.{2,}/g, '.').toLowerCase();
  const ip = canonicalizeIp(h);
  if (ip) return ip;
  return h;
}

/**
 * Normalize an integer / dotted IPv4 form to dotted-decimal (e.g. `3279880203` → `195.127.0.11`).
 * Returns null when the host isn't a recognizable IPv4 literal — covering the common decimal and
 * dotted forms; exotic octal/hex-mixed forms fall through to the literal host (still hashed, just
 * not normalized).
 */
function canonicalizeIp(host: string): string | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
  }
  const parts = host.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) <= 255)) {
    return parts.map(p => String(Number(p))).join('.');
  }
  return null;
}

/** Resolve `/./` and `/../`, collapse duplicate slashes; preserve a trailing slash. */
function canonicalizePath(path: string): string {
  const p = path.replace(/\/{2,}/g, '/');
  const trailing = p.length > 1 && p.endsWith('/');
  const segs = p.split('/');
  const stack: string[] = [];
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  let out = '/' + stack.join('/');
  if (trailing && out !== '/') out += '/';
  return out;
}

export interface CanonicalUrl {
  host: string;
  /** Escaped path, always starting with '/'. */
  path: string;
  /** Escaped query (without the leading '?'), or null when absent. */
  query: string | null;
}

/** Canonicalize a URL per the Safe Browsing spec. Returns null for non-http(s)/unparseable input. */
export function canonicalize(raw: string): CanonicalUrl | null {
  // 1. Remove tab/CR/LF anywhere; 2. drop the fragment.
  let s = raw.trim().replace(/[\t\r\n]/g, '');
  const frag = s.indexOf('#');
  if (frag !== -1) s = s.slice(0, frag);

  // Scheme handling. A real scheme has no dot (so `host.com:1234` is host:port, not a scheme);
  // when one is present it must be http/https — opaque schemes like javascript:/data:/ftp: are
  // rejected (with or without `//`), so they can never be canonicalized into a default-http host.
  let rest = s;
  const sm = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (sm) {
    const sch = sm[1]!.toLowerCase();
    if (!sch.includes('.')) {
      if (sch !== 'http' && sch !== 'https') return null;
      const tail = s.slice(sm[0].length);
      rest = tail.startsWith('//') ? tail.slice(2) : tail;
    }
  }

  rest = unescapeRepeated(toBin(utf8ToBytes(rest)));

  // Split host / path / query off the (decoded) remainder.
  let hostEnd = rest.search(/[/?]/);
  if (hostEnd === -1) hostEnd = rest.length;
  let host = rest.slice(0, hostEnd);
  const after = rest.slice(hostEnd);

  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  host = canonicalizeHost(host);
  if (!host) return null;

  let path: string;
  let query: string | null = null;
  const q = after.indexOf('?');
  if (q !== -1) {
    path = after.slice(0, q);
    query = after.slice(q + 1);
  } else {
    path = after;
  }
  if (!path) path = '/';
  path = canonicalizePath(path);

  return {
    host: escapeBin(host),
    path: escapeBin(path),
    query: query === null ? null : escapeBin(query),
  };
}

/** Host candidates Safe Browsing tries: exact, then last-5..last-2 components (deduped, ≤5). */
function hostExpressions(host: string): string[] {
  if (canonicalizeIp(host)) return [host];
  const parts = host.split('.');
  const out: string[] = [host];
  for (let take = 5; take >= 2; take--) {
    if (take >= parts.length) continue;
    const cand = parts.slice(parts.length - take).join('.');
    if (!out.includes(cand)) out.push(cand);
  }
  return out;
}

/** Path candidates: exact+query, exact, then root + up to 4 directory prefixes (deduped). */
function pathExpressions(path: string, query: string | null): string[] {
  const out: string[] = [];
  if (query !== null) out.push(`${path}?${query}`);
  out.push(path);
  const prefixes = ['/'];
  const dirs = path.split('/').slice(1, -1); // segments excluding leading '' and the final (file) part
  let cur = '/';
  for (const d of dirs) {
    if (prefixes.length >= 4) break;
    cur += `${d}/`;
    prefixes.push(cur);
  }
  for (const p of prefixes) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The host/path "expressions" (up to 30) Safe Browsing hashes for a URL. Each is `host + path`
 * (no scheme). A match on ANY of them means the URL is covered by a threat list.
 */
export function urlExpressions(raw: string): string[] {
  const c = canonicalize(raw);
  if (!c) return [];
  const hosts = hostExpressions(c.host);
  const paths = pathExpressions(c.path, c.query);
  const out: string[] = [];
  for (const h of hosts) {
    for (const p of paths) {
      const e = h + p;
      if (!out.includes(e)) out.push(e);
    }
  }
  return out;
}

/** The full SHA-256 hashes (hex) of a URL's expressions. */
export function fullHashes(raw: string): string[] {
  return urlExpressions(raw).map(e => bytesToHex(sha256(utf8ToBytes(e))));
}

/**
 * The hash PREFIXES (hex, `prefixBytes` long) sent to the relay for a reputation check. This is
 * the only thing that leaves the device for a link check — opaque, fixed-width, and never the URL.
 */
export function hashPrefixes(raw: string, prefixBytes: number = HASH_PREFIX_BYTES): string[] {
  const n = prefixBytes * 2; // hex chars
  const out: string[] = [];
  for (const h of fullHashes(raw)) {
    const pre = h.slice(0, n);
    if (!out.includes(pre)) out.push(pre);
  }
  return out;
}

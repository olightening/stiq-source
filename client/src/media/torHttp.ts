/**
 * HTTP(S) fetch over Tor (PLAN.md §3.2).
 *
 * This is the ONE sanctioned way for the app to pull remote bytes (images, link pages). It
 * routes every request through the bundled Tor SOCKS proxy via the native `StiqHttp` module —
 * the same leak-free raw-socket + remote-DNS pattern proven by StiqSocket, with TLS for https.
 * It NEVER touches the OS network stack (which `<Image>`/`fetch`/`WebView` would), so a link
 * or image can't be used to harvest the reader's real IP.
 *
 * Policy enforced here, at the single chokepoint:
 *   - Tor-only: throws when offline (requireTorTransport) — never a clearnet fallback.
 *   - onion/clearnet gate: refuses clearnet when REQUIRE_ONION_MEDIA, re-checked per redirect.
 *   - size cap, content-type left to callers, pinned generic UA, and NO Referer/Cookie ever.
 *   - per-request Tor stream isolation (distinct SOCKS user/pass → distinct circuit).
 * The native module does ONE request per call; redirects are followed here so policy applies
 * to every hop.
 */
import {NativeModules} from 'react-native';
import {requireTorTransport, type TorManager} from '../tor';
import type {SocksProxy} from '../tor/types';
import {base64ToBytes} from '../util/base64';
import {classifyUrl, resolveRelativeUrl} from '../util/url';
import {utf8Decode} from '../util/utf8';
import {
  LINK_MAX_REDIRECTS,
  MEDIA_FETCH_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  REQUIRE_ONION_MEDIA,
} from '../config';

export interface StiqHttpNativeRequest {
  method: string;
  url: string;
  socksHost: string;
  socksPort: number;
  /** SOCKS5 username/password → Tor circuit isolation (IsolateSOCKSAuth). */
  socksUser: string;
  socksPass: string;
  headers: Record<string, string>;
  /** Base64 request body, '' when none. */
  bodyBase64: string;
  maxBytes: number;
  timeoutMs: number;
}

export interface StiqHttpNativeResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface StiqHttpNative {
  request(opts: StiqHttpNativeRequest): Promise<StiqHttpNativeResponse>;
}

export interface TorHttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'HEAD';
  headers?: Record<string, string>;
  bodyBase64?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Requests sharing a circuitTag share a Tor circuit; distinct tags isolate streams. */
  circuitTag?: string;
  /** Max redirect hops (default LINK_MAX_REDIRECTS). 0 disables following. */
  maxRedirects?: number;
}

export interface TorHttpResponse {
  status: number;
  /** Lowercased header keys. */
  headers: Record<string, string>;
  /** Final URL after any redirects. */
  url: string;
  bytes: Uint8Array;
  /** Lowercased content-type, parameters stripped (e.g. "text/html"). */
  contentType: string;
}

// A pinned, generic, Tor-Browser-adjacent UA. Sending the device's real WebView/RN UA would
// be a fingerprint; a fixed value makes every stiq client look identical on the wire.
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  // No gzip: keep the native HTTP reader simple and avoid a decompression bomb surface.
  'Accept-Encoding': 'identity',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function getNativeHttp(): StiqHttpNative | undefined {
  return (NativeModules as {StiqHttp?: StiqHttpNative}).StiqHttp;
}

function randomCircuitTag(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(headers ?? {})) {
    out[k.toLowerCase()] = headers[k] ?? '';
  }
  return out;
}

/**
 * Fetch a URL over Tor. Resolves with the final response (after capped redirects) or throws
 * when offline, when the URL/redirect is non-http(s), when clearnet is disallowed, or when the
 * response exceeds the byte cap.
 */
export async function torFetch(
  manager: TorManager,
  req: TorHttpRequest,
  native: StiqHttpNative | undefined = getNativeHttp(),
): Promise<TorHttpResponse> {
  const socks: SocksProxy = requireTorTransport(manager); // throws when offline — Tor-only
  if (!native) {
    throw new Error('StiqHttp native module not linked — cannot fetch over Tor');
  }
  const circuitTag = req.circuitTag ?? randomCircuitTag();
  const maxBytes = req.maxBytes ?? MEDIA_MAX_BYTES;
  const timeoutMs = req.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS;
  const maxRedirects = req.maxRedirects ?? LINK_MAX_REDIRECTS;
  const headers = {...DEFAULT_HEADERS, ...(req.headers ?? {})};

  let url = req.url;
  for (let hop = 0; ; hop++) {
    const info = classifyUrl(url);
    if (info.kind === 'invalid') {
      throw new Error(`refusing to fetch non-http(s) URL: ${url}`);
    }
    if (info.kind === 'clearnet' && REQUIRE_ONION_MEDIA) {
      throw new Error(`refusing clearnet fetch (REQUIRE_ONION_MEDIA): ${info.host}`);
    }

    const res = await native.request({
      method: req.method ?? 'GET',
      url,
      socksHost: socks.host,
      socksPort: socks.port,
      socksUser: circuitTag,
      socksPass: circuitTag,
      headers,
      bodyBase64: req.bodyBase64 ?? '',
      maxBytes,
      timeoutMs,
    });

    const h = lowerKeys(res.headers ?? {});
    if (REDIRECT_STATUSES.has(res.status) && h.location && hop < maxRedirects) {
      url = resolveRelativeUrl(url, h.location);
      continue;
    }

    const bytes = res.bodyBase64 ? base64ToBytes(res.bodyBase64) : new Uint8Array(0);
    if (bytes.length > maxBytes) {
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    const contentType = (h['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    return {status: res.status, headers: h, url, bytes, contentType};
  }
}

/** Fetch and UTF-8 decode (reader-mode HTML, JSON). */
export async function torFetchText(
  manager: TorManager,
  req: TorHttpRequest,
  native?: StiqHttpNative,
): Promise<{text: string; response: TorHttpResponse}> {
  const response = await torFetch(manager, req, native);
  return {text: utf8Decode(response.bytes), response};
}

/**
 * Resolve a link's TRUE final destination over Tor (following redirects) without committing
 * to downloading the page — used to show the real landing domain before the user opens it.
 * Tries HEAD; the caller treats any thrown error as "unresolved" and shows the original URL.
 */
export async function resolveFinalUrl(
  manager: TorManager,
  url: string,
  native?: StiqHttpNative,
): Promise<{finalUrl: string; status: number}> {
  const res = await torFetch(manager, {url, method: 'HEAD', maxBytes: 1}, native);
  return {finalUrl: res.url, status: res.status};
}

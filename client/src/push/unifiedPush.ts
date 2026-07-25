/**
 * UnifiedPush client wrapper + push-registration builder (T1 — real push over Tor).
 *
 * This is the TS half of the "content-free wake over Tor" design. It does two jobs, both inert until
 * App.tsx opts in behind the PUSH_UNIFIEDPUSH flag AND the relay advertises a watcher:
 *
 *  1. A duck-typed, absent-safe wrapper over the native `StiqUnifiedPush` module (registerApp /
 *     getEndpoint / getDistributor / unregister). The module only exists on device builds that
 *     compiled the UnifiedPush connector in; every wrapper degrades to a harmless no-op when it's
 *     absent (jest, older APK), so callers never have to null-check `NativeModules.StiqUnifiedPush`.
 *
 *  2. The pure registration substrate the app POSTs to the keyless watcher over Tor: derive the ntfy
 *     TOPIC from a distributor endpoint (validated against the relay-advertised ntfy host so a
 *     third-party push server can never receive the endpoint), map the member's interests to COARSE
 *     trigger keys (`p:`/`h:`/`e:` — the same already-public tag values the relay sees), and register.
 *
 * PRIVACY: the registration body carries ONLY {v, topic, keys, exp}. No npub-to-name, no content, no
 * event id beyond the coarse root-id trigger the member opts into. The wake itself is content-free;
 * all notification text is derived locally on-device after the wake (see background/headlessNotify).
 *
 * NO `new URL()` anywhere (it throws under Hermes — see url.ts / onionAuth.ts): every URL/host parse
 * here is a pure string walk.
 */
import {NativeModules} from 'react-native';
import type {TorManager} from '../tor';
import {torFetch, getNativeHttp, type StiqHttpNative} from '../media/torHttp';
import {bytesToBase64} from '../util/base64';
import {utf8Encode} from '../util/utf8';
import {PUSH_UNIFIEDPUSH} from '../config';
import type {RelayCapabilities} from '../nostr/capabilities';

// ─── Native module wrapper (absent-safe) ────────────────────────────────────────────────────────

/** The subset of the native `StiqUnifiedPush` module (T1-S2) this wrapper duck-types onto. */
interface StiqUnifiedPushNative {
  registerApp(): Promise<string>;
  unregister(): Promise<void>;
  getDistributor(): Promise<string | null>;
  getEndpoint(): Promise<string | null>;
}

function nativeModule(): StiqUnifiedPushNative | undefined {
  return (NativeModules as {StiqUnifiedPush?: StiqUnifiedPushNative}).StiqUnifiedPush;
}

/** Whether the native UnifiedPush module is compiled into this build. */
export function hasUnifiedPushModule(): boolean {
  return !!nativeModule();
}

/**
 * Ask the native connector to register with the saved distributor. Resolves the native status string
 * (`'no_distributor'` when none is installed) — or `'no_module'` when the connector isn't compiled in,
 * so callers get one uniform, throw-free result on every platform.
 */
export async function registerApp(): Promise<string> {
  const mod = nativeModule();
  if (!mod?.registerApp) return 'no_module';
  try {
    return await mod.registerApp();
  } catch {
    return 'error';
  }
}

/** Unregister from the distributor. No-op (resolves) when the module is absent. */
export async function unregister(): Promise<void> {
  const mod = nativeModule();
  if (!mod?.unregister) return;
  try {
    await mod.unregister();
  } catch {
    /* best effort — nothing to unwind */
  }
}

/** The saved distributor id, or null when none / the module is absent. Never throws. */
export async function getDistributor(): Promise<string | null> {
  const mod = nativeModule();
  if (!mod?.getDistributor) return null;
  try {
    return await mod.getDistributor();
  } catch {
    return null;
  }
}

/** The persisted UnifiedPush endpoint URL, or null when none yet / the module is absent. Never throws. */
export async function getEndpoint(): Promise<string | null> {
  const mod = nativeModule();
  if (!mod?.getEndpoint) return null;
  try {
    return await mod.getEndpoint();
  } catch {
    return null;
  }
}

// ─── Registration substrate (pure) ──────────────────────────────────────────────────────────────

/** The body POSTed to the watcher's /push/register — byte-compatible with the Go watcher's schema. */
export interface PushRegistration {
  v: 1;
  topic: string;
  keys: string[];
  exp: number;
}

/**
 * Config gate: true only when the flag is on AND the relay advertised a watcher endpoint. Every
 * UnifiedPush action in App.tsx is gated on this, so the whole feature stays dark on an un-advertised
 * relay even with the flag flipped (clients ship the flag first — see PUSH_UNIFIEDPUSH doc).
 */
export function pushEnabled(caps: RelayCapabilities): boolean {
  return PUSH_UNIFIEDPUSH && !!caps.push?.watcher;
}

/** Bare, lowercased host of a host / host:port / URL string — no scheme, port, path, or userinfo. */
function normHost(hostOrUrl: string): string {
  if (typeof hostOrUrl !== 'string') return '';
  let s = hostOrUrl.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/, 1)[0] ?? ''; // drop path/query/fragment
  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(at + 1); // drop userinfo
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon); // drop port
  return s.toLowerCase();
}

/** ntfy topics are `[-_A-Za-z0-9]` up to 64 chars — reject anything else as a malformed endpoint. */
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Pull the ntfy TOPIC (the last path segment) out of a UnifiedPush endpoint URL, but ONLY when the
 * endpoint's host matches `allowedNtfyHost` (the relay-advertised ntfy onion). A host mismatch — a
 * distributor pointed at some third-party ntfy — returns null so the endpoint is never registered
 * anywhere it shouldn't leak to. Pure string parse (no `new URL()`).
 */
export function extractNtfyTopic(endpoint: string, allowedNtfyHost: string): string | null {
  if (typeof endpoint !== 'string') return null;
  let s = endpoint.trim();
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  const authEnd = s.search(/[/?#]/);
  const authority = authEnd >= 0 ? s.slice(0, authEnd) : s;
  const rest = authEnd >= 0 ? s.slice(authEnd) : '';

  let host = authority;
  const at = host.indexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.indexOf(':');
  if (colon >= 0) host = host.slice(0, colon);
  host = host.toLowerCase();

  const allowed = normHost(allowedNtfyHost);
  if (!host || !allowed || host !== allowed) return null;

  const path = rest.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').filter(seg => seg.length > 0);
  const topic = segments[segments.length - 1];
  return topic && NTFY_TOPIC_RE.test(topic) ? topic : null;
}

/**
 * Build the watcher registration from a distributor endpoint + the member's interests, or null when
 * the endpoint host isn't the advertised ntfy host (never register a foreign endpoint) or the member
 * has no pubkey yet. Trigger keys are COARSE and already-public: `p:<npubHex>` (DM #p), `h:<groupId>`
 * (group/channel #h), optional `e:<rootIdHex>` (comment root). Values are lowercased to byte-match the
 * Go watcher's `^(p|h|e):[0-9a-z:_-]+$` check (p/e are 64-hex).
 */
export function buildRegistration(
  endpoint: string,
  opts: {
    myPubkey: string;
    groupIds: string[];
    rootIds?: string[];
    allowedNtfyHost: string;
    ttlSeconds: number;
  },
): PushRegistration | null {
  if (!opts.myPubkey) return null;
  const topic = extractNtfyTopic(endpoint, opts.allowedNtfyHost);
  if (!topic) return null;
  const keys = [
    'p:' + opts.myPubkey.toLowerCase(),
    ...opts.groupIds.map(g => 'h:' + g),
    ...(opts.rootIds ?? []).map(r => 'e:' + r.toLowerCase()),
  ];
  const exp = Math.floor(Date.now() / 1000) + opts.ttlSeconds;
  return {v: 1, topic, keys, exp};
}

/** watcherOnionUrl may be a bare `host:port` (as the relay advertises) — normalize to an http URL. */
function watcherRegisterUrl(watcherOnionUrl: string): string {
  const base = watcherOnionUrl.includes('://') ? watcherOnionUrl : `http://${watcherOnionUrl}`;
  return `${base.replace(/\/+$/, '')}/push/register`;
}

/**
 * POST the registration to the watcher onion over Tor (the SAME torHttp chokepoint every remote byte
 * goes through — Tor-only, stream-isolated, no OS network stack). Resolves true on the watcher's 204,
 * false on any other status or a thrown request (offline / unreachable). `native` is injectable for
 * tests; production uses the linked StiqHttp module.
 */
export async function registerWithWatcher(
  watcherOnionUrl: string,
  reg: PushRegistration,
  manager: TorManager,
  native: StiqHttpNative | undefined = getNativeHttp(),
): Promise<boolean> {
  try {
    const res = await torFetch(
      manager,
      {
        url: watcherRegisterUrl(watcherOnionUrl),
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        bodyBase64: bytesToBase64(utf8Encode(JSON.stringify(reg))),
        maxRedirects: 0,
        maxBytes: 4096,
      },
      native,
    );
    return res.status === 204;
  } catch {
    return false;
  }
}

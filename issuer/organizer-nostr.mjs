/**
 * Organizer Nostr identity + moderation-config publishing (PLAN.md §3.4).
 *
 * The organizer holds ONE Nostr key — the moderation root of trust. It signs several NIP-78
 * app-data events (kind 30078), which the relay and every client honor only from this key:
 *   - d="stiq:moderators"  → current moderator roster (`p` tags)  → grant/withdraw moderators
 *   - d="stiq:limits"      → rate-limit policy (JSON content)     → spam / storage caps
 *   - d="stiq:permissions" → per-moderator action scopes          → who may do what
 *   - and the additive config events (labels, post-rules, reasons, mod-limits, gov, community)
 *
 * The secret key is generated once and persisted locally (organizer_nostr.json, gitignored),
 * exactly like the issuer RSA private key. Publishing is best-effort over RELAY_WS; the signed
 * event is always returned so the organizer can publish it by any Tor-capable path if the
 * dashboard host can't reach the onion directly (e.g. set RELAY_WS=ws://127.0.0.1:3334 when
 * co-located with the relay, or tunnel over SSH).
 */
import {readFileSync, writeFileSync, existsSync} from 'fs';
import {fileURLToPath, pathToFileURL} from 'url';
import {dirname, join} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOSTR_PATH = join(__dirname, 'organizer_nostr.json');
const NT_PATH = join(__dirname, '../client/node_modules/nostr-tools/lib/esm/index.js');

const nt = await import(pathToFileURL(NT_PATH).href);
const {finalizeEvent, getPublicKey, generateSecretKey, nip19, verifyEvent, Relay, useWebSocketImplementation} = nt;

// nostr-tools' Relay needs a WebSocket implementation. Node < 22 has no global `WebSocket`,
// and nostr-tools 2.23 dropped `useWebSocketImplementation` (it's undefined) — so set
// globalThis.WebSocket from the bundled `ws`, which Relay.connect picks up version-agnostically.
try {
  const wsmod = await import(pathToFileURL(join(__dirname, '../client/node_modules/ws/index.js')).href);
  const WS = wsmod.default ?? wsmod.WebSocket ?? wsmod;
  if (typeof useWebSocketImplementation === 'function') useWebSocketImplementation(WS);
  if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS;
} catch {
  // Fall back to a platform-provided global WebSocket (Node 22+ / browsers).
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Load the organizer keypair, generating + persisting it on first use. */
export function organizerIdentity() {
  if (existsSync(NOSTR_PATH)) {
    const saved = JSON.parse(readFileSync(NOSTR_PATH, 'utf8'));
    const sk = hexToBytes(saved.skHex);
    return {sk, pkHex: saved.pkHex, npub: saved.npub};
  }
  const sk = generateSecretKey();
  const pkHex = getPublicKey(sk);
  const npub = nip19.npubEncode(pkHex);
  writeFileSync(NOSTR_PATH, JSON.stringify({skHex: bytesToHex(sk), pkHex, npub}, null, 2) + '\n');
  return {sk, pkHex, npub};
}

/** Sign a kind-30078 organizer-config event with the given `d` tag, extra tags, and content. */
export function signConfig(d, tags, content) {
  const {sk} = organizerIdentity();
  return finalizeEvent(
    {kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', d], ...tags], content},
    sk,
  );
}

/**
 * Verify a member-signed reader-auth event (censorable reads, #4). Read-token draws under read-auth
 * enforcement carry a small event the member signs with their REAL identity key, so the organizer
 * can identify the reader and refuse a revoked one. Returns the signer's hex pubkey when the event is
 * a well-formed, correctly-signed reader-auth for `expectedKind` (optionally bound to `epoch`), else
 * null. The WRITE path never calls this — posting stays blind and uncensorable.
 */
export function verifyReaderAuth(event, expectedKind, epoch) {
  try {
    if (!event || typeof event !== 'object') return null;
    if (event.kind !== expectedKind) return null;
    if (typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(event.pubkey)) return null;
    if (!verifyEvent(event)) return null;
    if (epoch !== undefined) {
      const et = Array.isArray(event.tags) ? event.tags.find(t => t[0] === 'epoch') : null;
      if (!et || String(et[1]) !== String(epoch)) return null;
    }
    return event.pubkey;
  } catch {
    return null;
  }
}

/** Sign the moderator roster from a list of npubs (skips malformed entries). */
export function signRoster(npubs) {
  const tags = [];
  for (const npub of npubs) {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') tags.push(['p', decoded.data]);
    } catch {
      // skip malformed npub
    }
  }
  return signConfig('stiq:moderators', tags, '');
}

/** Sign the rate-limit policy from a plain limits object. */
export function signLimits(limits) {
  return signConfig('stiq:limits', [], JSON.stringify(limits));
}

/**
 * (T14-S5) Sign the seeded pluggable-transport bridge lines (obfs4 / webtunnel) as a kind-30078
 * d=stiq:bridges event so already-enrolled members receive them over the existing organizer-config
 * rail (the join code's `br` array covers brand-new members). Compact wire {b:[lines]} — the client
 * ingest (AppRuntime, gated by COMMUNITY_SEEDED_BRIDGES) re-validates each line and caps the set.
 */
export function signBridges(lines) {
  const b = Array.isArray(lines) ? lines.filter(l => typeof l === 'string') : [];
  return signConfig('stiq:bridges', [], JSON.stringify({b}));
}

/**
 * Community relay mirrors (kind-30078, d=stiq:mirrors) — the organizer's own additional relays for
 * the community. This is the PUBLISH half of a wire contract the client already ships (see
 * client/src/app/AppRuntime.ts parseMirrorsEvent + client/src/onboarding/join.ts MAX_MIRRORS): the
 * content MUST be a JSON array of terse `[wsOnionUrl, onionAuthKeyOrNull]` pairs, capped at
 * MIRRORS_MAX (5). `mirrors` is `{url, onionAuthKey}[]`; entries whose `url` isn't a valid ws/wss
 * v3-onion address are dropped rather than signed — the client applies the identical validation and
 * would drop them too, so rejecting them here just keeps the published doc itself honest. An empty
 * (or all-invalid) input signs an EMPTY array, which the client treats as the organizer legitimately
 * withdrawing its own previously-published mirrors (it never touches user/known-good/seed mirrors).
 */
const MIRRORS_MAX = 5;
const ONION_WS_RE = /^wss?:\/\/[a-z2-7]{56}\.onion(?:[:/?#]|$)/i;
export function signMirrors(mirrors) {
  const list = Array.isArray(mirrors) ? mirrors : [];
  const valid = list
    .filter(m => m && typeof m.url === 'string' && ONION_WS_RE.test(m.url))
    .slice(0, MIRRORS_MAX);
  return signConfig(
    'stiq:mirrors',
    [],
    JSON.stringify(valid.map(m => [m.url, (typeof m.onionAuthKey === 'string' && m.onionAuthKey) ? m.onionAuthKey : null])),
  );
}

/**
 * Sign per-moderator action scopes (kind-30078, d=stiq:permissions). The dashboard stores scopes
 * keyed by npub (friendly); here each npub is decoded to its hex pubkey for the wire content the
 * client + relay read: {def:[scopes], mods:{<hexpubkey>:[scopes]}}. Malformed npubs are skipped.
 */
export function signPermissions(defaultScopes, modScopesByNpub) {
  const def = Array.isArray(defaultScopes) ? defaultScopes : [];
  const mods = {};
  for (const npub of Object.keys(modScopesByNpub || {})) {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') mods[decoded.data] = Array.isArray(modScopesByNpub[npub]) ? modScopesByNpub[npub] : [];
    } catch {
      // skip malformed npub
    }
  }
  return signConfig('stiq:permissions', [], JSON.stringify({def, mods}));
}

// Per-attempt connect bound (T1.6/F-E). A hung Tor/socket connect must not block a publish
// attempt — and therefore publishWithRetry's whole backoff loop — indefinitely. nostr-tools' own
// AbstractRelay#connect(opts) supports `opts.timeout`, but the STATIC `Relay.connect(url, opts)`
// helper silently drops `opts` before calling the instance's no-args `connect()` (verified against
// nostr-tools 2.23's compiled relay.js: `static async connect(url, options) { const relay = new
// Relay(url, options); await relay.connect(); return relay; }` — options never reaches the inner
// connect() call). So `Relay.connect(relayWs, {timeout: …})` would silently keep hanging forever;
// the only way to reach the library's real timeout mechanism is to construct the Relay ourselves
// and call its instance `connect({timeout})` directly.
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/**
 * Best-effort publish a signed event to the relay. Returns {ok, message, event}. Never throws —
 * the caller can fall back to manual publishing of the returned event. `opts.connectTimeoutMs`
 * (default 8s) bounds the connect phase so one hung attempt can't block forever.
 */
export async function publish(event, relayWs, opts = {}) {
  if (!relayWs) return {ok: false, message: 'no relay URL configured', event};
  const {connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS} = opts;
  const relay = new Relay(relayWs);
  try {
    await relay.connect({timeout: connectTimeoutMs});
    await relay.publish(event);
    relay.close();
    return {ok: true, message: `published to ${relayWs}`, event};
  } catch (e) {
    // Best-effort socket reclaim: on a timed-out/failed connect, nostr-tools' own timeout path
    // rejects the connect promise but never closes the underlying raw WebSocket (AbstractRelay#
    // handleHardClose only clears timers/subs, and AbstractRelay#close() only calls ws.close() when
    // readyState is already OPEN) — so a socket stuck in CONNECTING would otherwise leak, one per
    // failed attempt, which is exactly the "accumulating sockets" half of F-E. `relay.ws` is a plain
    // (not truly private — TS `private` is erased at compile time) instance field, and
    // WebSocket#close() is valid from any readyState per spec, including CONNECTING, so reach in and
    // ask it to close. Never let this best-effort cleanup mask the real failure below.
    try { relay.close(); } catch { /* best-effort */ }
    try { relay.ws?.close?.(); } catch { /* best-effort */ }
    return {ok: false, message: `publish failed: ${e?.message ?? e}`, event};
  }
}

/**
 * Publish with capped exponential-backoff retry (T1.6, fixes F8). `publish()` above already awaits
 * the relay's OK frame for a single attempt (nostr-tools' `relay.publish` resolves on `["OK",id,true,
 * …]` and rejects on `false`/timeout) — but a single attempt is exactly the swk-class failure mode:
 * one relay hiccup or Tor blip and the fleet's key-sync silently no-ops, with no recovery. This
 * retries that single attempt up to `maxAttempts` times, doubling the wait each time (capped at
 * `maxDelayMs`), and stops the instant one attempt's OK frame confirms acceptance. Exhausting every
 * attempt is NOT a thrown rejection — it resolves a terminal `{ok:false, attempts, message}` so a
 * caller can always await this and get an answer to log/surface, rather than looping forever or
 * leaving the caller to handle an uncaught rejection.
 *
 * `publishFn`/`sleep` are injectable so tests can simulate relay accept/reject sequences and skip
 * real wall-clock delay without a live socket (see token_keys_publish_test.mjs).
 *
 * `connectTimeoutMs` (F-E) is forwarded to each attempt so a hung Tor/socket connect can't stall a
 * single attempt — and therefore this whole loop — indefinitely; omit it to use `publishFn`'s own
 * default (8s for the real `publish`). This makes the "bounded to a handful of attempts/seconds"
 * behavior actually true: previously an attempt with no relay response could hang forever, silently
 * pinning the loop on attempt 1 and never advancing/backing off.
 *
 * @param {object} event         the signed event to publish
 * @param {string} relayWs       relay websocket URL (passed through to `publishFn`)
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=5]   bounded attempts — never retries forever
 * @param {number} [opts.baseDelayMs=500] first backoff wait; doubles each subsequent attempt
 * @param {number} [opts.maxDelayMs=8000] backoff cap
 * @param {(event:object, relayWs:string, publishOpts?:object) => Promise<{ok:boolean,message:string,event:object}>} [opts.publishFn=publish]
 * @param {(ms:number) => Promise<void>} [opts.sleep]  injectable delay, defaults to a real setTimeout
 * @param {number} [opts.connectTimeoutMs] per-attempt connect bound, forwarded to `publishFn`'s own opts
 * @returns {Promise<{ok:boolean, attempts:number, message:string, event:object}>}
 */
export async function publishWithRetry(event, relayWs, opts = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    publishFn = publish,
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    connectTimeoutMs,
  } = opts;
  const publishOpts = connectTimeoutMs !== undefined ? {connectTimeoutMs} : undefined;
  let last = {ok: false, message: 'publishWithRetry: no attempt made', event};
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await publishFn(event, relayWs, publishOpts);
    } catch (e) {
      // publishFn (publish() above) is itself designed to never throw, but an injected/alternate
      // implementation might — guard so retry accounting is never bypassed by an uncaught throw.
      last = {ok: false, message: `publish threw: ${e?.message ?? e}`, event};
    }
    if (last?.ok) {
      return {ok: true, attempts: attempt, message: last.message, event};
    }
    if (attempt < maxAttempts) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
  return {
    ok: false,
    attempts: maxAttempts,
    message: `no relay OK after ${maxAttempts} attempts — last error: ${last?.message ?? 'unknown'}`,
    event,
  };
}

/**
 * Best-effort READ from the relay: connect, subscribe with the given filters, collect events until
 * EOSE (or a timeout / connection failure), then close. Never throws — returns whatever arrived,
 * de-duped by id and capped at `limit`. Used by the dashboard's featured-space picker to list the
 * community's channels (kind-30311) and the profiles of pubkeys it wants to feature (scoped kind-0).
 */
export async function fetchEvents(filters, {relayWs = null, timeoutMs = 4500, limit = 500} = {}) {
  if (!relayWs) return [];
  let relay;
  try {
    relay = await Relay.connect(relayWs);
  } catch {
    return [];
  }
  const byId = new Map();
  await new Promise((resolve) => {
    let sub = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sub && sub.close(); } catch { /* already closed */ }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      sub = relay.subscribe(filters, {
        onevent(ev) { if (ev && ev.id && byId.size < limit) byId.set(ev.id, ev); },
        oneose() { finish(); },
        onclose() { finish(); },
      });
    } catch {
      finish();
    }
  });
  try { relay.close(); } catch { /* already closed */ }
  return [...byId.values()];
}

/** Encode a hex pubkey as an npub, or null if malformed. */
export function encodeNpub(hex) {
  try { return nip19.npubEncode(hex); } catch { return null; }
}

/** Decode an npub to its hex pubkey, or null if not a valid npub. */
export function decodeNpub(npub) {
  try { const d = nip19.decode(npub); return d.type === 'npub' ? d.data : null; }
  catch { return null; }
}

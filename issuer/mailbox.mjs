/**
 * Organizer mailbox — the server half of the automated, unlinkable credential exchange
 * (PLAN.md §3.3, smoother-onboarding).
 *
 * Connects to the community relay OVER TOR (SOCKS5) and services enrollment requests:
 *
 *   member ──kind 9020 (blinded token, NIP-44 to organizerPub)──▶ relay
 *   here   ◀──subscribe {kinds:[9020], #p: organizerPub}──────────  relay
 *   here   ── validate+spend invite, blind-sign, NIP-44 to replyPub, mine PoW ──▶ kind 9021
 *
 * The token stays blinded (we never see it); we only ever learn an opaque invite code and a
 * throwaway reply key — never the member's posting npub.
 *
 * Everything is loaded via guarded dynamic import: if `ws` / `socks-proxy-agent` / nostr-tools
 * can't be resolved, the mailbox stays OFF and the dashboard + manual exchange keep working.
 */
import {pathToFileURL} from 'url';
import {join} from 'path';
import {readFileSync, writeFileSync, existsSync} from 'fs';

const KIND_ENROLL_REQUEST = 9020;
const KIND_ENROLL_RESPONSE = 9023;
const KIND_DRAW_REQUEST = 9024;
const KIND_DRAW_RESPONSE = 9025;
const KIND_UNLOCK_REQUEST = 9026;
const KIND_UNLOCK_RESPONSE = 9027;
const MAILBOX_TTL_SECONDS = 48 * 3600;
const RESPONSE_ACK_TIMEOUT_MS = 15_000;

/**
 * Track response EVENT publishes until the relay sends their matching NIP-01 OK frame. A successful
 * `ws.send()` only means bytes reached the kernel; without OK, the organizer must not consume the
 * request or assume the encrypted response was admitted and stored.
 *
 * Exported as a small dependency-free unit so the delivery contract can be regression-tested.
 */
export function createResponsePublisher(timeoutMs = RESPONSE_ACK_TIMEOUT_MS) {
  const pending = new Map(); // event id -> {ws, promise, resolve, reject, timer}

  function deliveryError(error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.mailboxDelivery = true;
    return wrapped;
  }

  function settle(id, entry, error) {
    if (pending.get(id) !== entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(deliveryError(error));
    else entry.resolve();
  }

  return {
    publish(ws, event) {
      const existing = pending.get(event?.id);
      if (existing) {
        if (existing.ws === ws) return existing.promise;
        return Promise.reject(new Error('mailbox response id is already pending on another socket'));
      }

      let resolve;
      let reject;
      const promise = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const entry = {ws, promise, resolve, reject, timer: null};
      entry.timer = setTimeout(
        () =>
          settle(
            event.id,
            entry,
            new Error('relay did not acknowledge the mailbox response in time'),
        ),
        Math.max(1, timeoutMs),
      );
      pending.set(event.id, entry);

      try {
        // The callback catches local write failures. Relay admission is confirmed separately by OK.
        ws.send(JSON.stringify(['EVENT', event]), error => {
          if (error) settle(event.id, entry, error);
        });
      } catch (error) {
        settle(event.id, entry, error);
      }
      return promise;
    },

    handleMessage(ws, msg) {
      if (!Array.isArray(msg) || msg[0] !== 'OK' || typeof msg[1] !== 'string') return false;
      const entry = pending.get(msg[1]);
      if (!entry || entry.ws !== ws) return false;
      settle(
        msg[1],
        entry,
        msg[2] === true
          ? null
          : new Error('relay rejected mailbox response: ' + (msg[3] || 'rejected')),
      );
      return true;
    },

    failSocket(ws, error = new Error('relay socket closed before acknowledging the mailbox response')) {
      for (const [id, entry] of pending) {
        if (entry.ws === ws) settle(id, entry, error);
      }
    },
  };
}

// Requests carry an `expiration` tag of now + MAILBOX_TTL_SECONDS, so an event older than the TTL
// can never be answered anyway. We keep the processed-id memory (and the subscription `since`
// floor) to a window a bit wider than that TTL: old enough events are dropped from the relay's
// own replay and from our dedupe set, keeping both bounded over months of uptime.
const SEEN_WINDOW_SECONDS = MAILBOX_TTL_SECONDS + 6 * 3600;
// Reach back this far before the newest processed event when (re)subscribing, so requests that
// landed on the relay during a reconnect gap (slightly older created_at than what we already
// processed) are still delivered. Dedupe-before-decrypt then discards the ones we already answered.
const SINCE_OVERLAP_SECONDS = 3 * 3600;

/**
 * Decide whether a just-received request event is new work or a replay we've already handled.
 * Pure + exported so it can be unit-tested without a live relay. Consulted BEFORE any decrypt or
 * PoW mining, which is the whole point: stale replays cost nothing.
 *
 * @param {{id?:string, created_at?:number}} ev  the incoming event
 * @param {Set<string>} seen                     ids we've already processed (mutated on accept)
 * @param {number} nowSec                        current unix time in seconds
 * @returns {boolean} true if the caller should process ev (and it's now recorded as seen)
 */
export function shouldProcess(ev, seen, nowSec) {
  const id = ev?.id;
  if (typeof id !== 'string' || id.length === 0) return false; // malformed — nothing to dedupe on
  if (seen.has(id)) return false;                              // already answered on a prior pass
  const createdAt = ev?.created_at;
  // Drop events older than the memory window outright: they're past the mailbox TTL, so even a
  // fresh one is unanswerable, and admitting them would let an old replay grow `seen` unbounded.
  if (typeof createdAt === 'number' && createdAt < nowSec - SEEN_WINDOW_SECONDS) return false;
  seen.add(id);
  return true;
}

// Clock-skew allowance when advancing the subscription high-water mark from an event's
// created_at. Anything further ahead is treated as "now": a single malicious/mistimed request
// with a far-future created_at must NOT push highWater — and with it the next REQ's `since`
// floor — past the present, or every genuinely new request would be silently excluded forever,
// with the poison persisting via the sidecar.
const HIGHWATER_SKEW_SECONDS = 900; // 15 min

/**
 * The timestamp an accepted event contributes to the high-water mark: its created_at, clamped so
 * a missing/bogus/far-future value counts as `nowSec`. Pure + exported for unit tests.
 *
 * @param {number|undefined} createdAt  the event's created_at (seconds) — may be absent or bogus
 * @param {number} nowSec               current unix time in seconds
 * @returns {number} the clamped timestamp to fold into highWater
 */
export function clampHighWater(createdAt, nowSec) {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return nowSec;
  return createdAt > nowSec + HIGHWATER_SKEW_SECONDS ? nowSec : createdAt;
}

// ── Unanswered-request log lines (2026-07-22 incident) ────────────────────────────────
// Prod showed 4 answered content-epoch unlocks against 11 sealed posts, with nothing in the log
// explaining the gap: a dropped (policy: dropInvalid) or shed (concurrency cap) request left zero
// trace of WHY it never got a reply. Both lines are pure + exported (mirrors isOnionRelayUrl below)
// so the reason string is unit-tested directly, without standing up a real relay/socket.

/**
 * Log line for an unlock request the mailbox answers with silence (drop-eligible per the
 * dropInvalid policy — see contentEpochKeys.mjs's unlockEpoch, which always pairs `drop:true` with a
 * `body.error` explaining the refusal: bad/unknown epoch, missing/malformed/invalid read-token, etc).
 */
export function describeDroppedUnlock(body) {
  return 'dropped unlock request (no response sent): ' + (body?.error || 'unknown reason');
}

/** Log line for ANY mailbox request (enroll/draw/unlock) shed under the concurrency cap — names the
 * request kind so an unlock-specific shed burst is distinguishable from an enroll/draw one. */
export function describeShedRequest(kind, maxConc) {
  return 'shed mailbox request kind=' + kind + ' (at concurrency cap ' + maxConc + ')';
}

// Route .onion through Tor's SOCKS proxy; reach a direct ws (e.g. an SSH tunnel to the relay's
// localhost port) without it, so a Tor-less dashboard host can still service the mailbox. The
// transport is chosen purely from the URL — pure + exported so the branch (previously inline and
// untested — 0% coverage per the hardening audit) has a direct unit test independent of a real
// WebSocket/SOCKS connection.
export function isOnionRelayUrl(url) {
  return /\.onion(?::\d+)?(?:\/|$)/i.test(String(url ?? ''));
}

/** Count leading zero bits of a hex event id (NIP-13 difficulty). */
function leadingZeroBits(idHex) {
  let count = 0;
  for (const ch of idHex) {
    const n = parseInt(ch, 16);
    if (Number.isNaN(n)) break;
    if (n === 0) { count += 4; continue; }
    for (let mask = 0x8; mask > 0; mask >>= 1) {
      if (n & mask) return count;
      count += 1;
    }
    break;
  }
  return count;
}

/**
 * Start the mailbox loop.
 *
 * @param {object} o
 * @param {string} o.dirname            issuer dir (to resolve client node_modules)
 * @param {string} o.relayUrl           ws://…onion of the community relay
 * @param {Uint8Array} o.organizerSk    organizer Nostr secret key
 * @param {string} o.organizerPub       organizer Nostr public key (hex)
 * @param {(invite:string, blinded:Buffer)=>Promise<Uint8Array>} o.signToken  blind-sign core
 * @param {number} o.enrollPoW          NIP-13 difficulty to mine on responses (match relay)
 * @param {(invite:string, blinded:Buffer)=>Promise<object>} [o.drawTokens]  epoch-token draw handler;
 *   returns {sigs} | {error, cap?} | {drop:true} (drop ⇒ send no response)
 * @param {()=>number} [o.maxConcurrent]  live getter for the in-flight handler ceiling (0 = unlimited);
 *   excess requests are shed (unanswered) so a burst can't pile up unbounded work on the event loop
 * @param {string} [o.socks]            socks proxy URL (default socks5h://127.0.0.1:9050)
 * @param {(msg:string)=>void} [o.log]
 * @param {()=>void} [o.onOpen]         called on every successful (re)connect, including the first
 * @returns {Promise<{stop:()=>void}>}
 */
export async function startMailbox(o) {
  const log = o.log || (m => console.log('[mailbox] ' + m));
  const socks = o.socks || process.env.STIQ_TOR_SOCKS || 'socks5h://127.0.0.1:9050';

  // Replay guard. The relay resends every stored request on each (re)subscribe; without this the
  // mailbox would re-decrypt + PoW-mine an error for every stale event on every reconnect —
  // unbounded rework that can wedge the single JS thread. We remember processed ids (checked
  // before decrypt) and the newest created_at we've handled, both persisted to a small JSON
  // sidecar so a restart doesn't replay either. `since` on the subscription keeps the relay from
  // resending most history in the first place; dedupe covers the reconnect-gap overlap window.
  const SEEN_PATH = join(o.dirname, 'mailbox_seen.json');
  const seen = new Set();       // processed ids — the O(1) dedupe check consulted before decrypt
  const seenAt = new Map();     // id -> created_at, so the sidecar can be pruned by age on write
  let highWater = 0;            // newest created_at we've processed (seconds)
  try {
    if (existsSync(SEEN_PATH)) {
      const nowSec = Math.floor(Date.now() / 1000);
      const saved = JSON.parse(readFileSync(SEEN_PATH, 'utf8'));
      // Clamp on load too: a future `high` (pre-clamp sidecar or hand-edit) must not poison `since`.
      const high = Number(saved?.high) || 0;
      highWater = high > 0 ? clampHighWater(high, nowSec) : 0;
      // Only rehydrate ids still inside the window; drop expired ones so the set stays bounded.
      for (const [id, createdAt] of Object.entries(saved?.seen || {})) {
        const ca = Number(createdAt);
        if (Number.isFinite(ca) && ca >= nowSec - SEEN_WINDOW_SECONDS) { seen.add(id); seenAt.set(id, ca); }
      }
    }
  } catch (e) { log('could not read ' + SEEN_PATH + ' (' + (e?.message || e) + '); starting fresh.'); }

  // Write the sidecar and prune expired ids from memory in one pass. Synchronous so stop() can
  // flush immediately; debounced via persistSeen() on the hot path.
  function flushSeen() {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = {};
    for (const [id, createdAt] of seenAt) {
      if (createdAt >= nowSec - SEEN_WINDOW_SECONDS) out[id] = createdAt;
      else { seen.delete(id); seenAt.delete(id); } // prune expired from memory too
    }
    try { writeFileSync(SEEN_PATH, JSON.stringify({high: highWater, seen: out}, null, 2) + '\n'); }
    catch (e) { log('could not write ' + SEEN_PATH + ' (' + (e?.message || e) + ').'); }
  }

  let persistTimer = null;
  function persistSeen() {
    if (persistTimer) return; // debounce — a burst of requests writes once
    persistTimer = setTimeout(() => { persistTimer = null; flushSeen(); }, 2000);
    persistTimer.unref?.(); // don't keep the process alive just for a pending flush
  }

  // Record a just-accepted event's created_at and advance the high-water mark, then schedule a
  // persist. Called only after shouldProcess() has admitted the event. The clamp (see
  // clampHighWater) stops a far-future created_at from poisoning the `since` floor; it also
  // bounds seenAt so a far-future id still ages out of the prune window normally.
  function noteProcessed(ev) {
    const createdAt = clampHighWater(ev?.created_at, Math.floor(Date.now() / 1000));
    seenAt.set(ev.id, createdAt);
    if (createdAt > highWater) highWater = createdAt;
    persistSeen();
  }

  let WebSocket, SocksProxyAgent, ntPure, ntNip44;
  try {
    ({default: WebSocket} = await import('ws'));
    ({SocksProxyAgent} = await import('socks-proxy-agent'));
    const base = join(o.dirname, '../client/node_modules/nostr-tools/lib/esm');
    ntPure = await import(pathToFileURL(join(base, 'pure.js')).href);
    ntNip44 = (await import(pathToFileURL(join(base, 'nip44.js')).href)).v2;
  } catch (e) {
    log('disabled — could not load deps (' + (e?.message || e) + ').');
    log('Run `npm install` in issuer/ (adds socks-proxy-agent) to enable the automated mailbox.');
    return {stop() {}};
  }

  const {finalizeEvent, getEventHash} = ntPure;
  const responsePublisher = createResponsePublisher();

  /**
   * Mine a `nonce` tag so the (unsigned) event id has >= difficulty leading zero bits.
   * Async + periodically yields to the event loop: this runs on the SHARED loop that also serves the
   * dashboard, so an unyielding loop (a high difficulty, or a burst of responses) would wedge the
   * single JS thread and stall HTTP. Yielding every YIELD_EVERY tries keeps the process responsive
   * while leaving the mined result (same difficulty, same hash convention) byte-identical.
   */
  async function mine(unsigned, difficulty) {
    const YIELD_EVERY = 4096;
    let nonce = 0;
    for (;;) {
      const tags = [...unsigned.tags.filter(t => t[0] !== 'nonce'), ['nonce', String(nonce), String(difficulty)]];
      const candidate = {...unsigned, tags};
      if (leadingZeroBits(getEventHash(candidate)) >= difficulty) return candidate;
      nonce += 1;
      if (nonce % YIELD_EVERY === 0) await new Promise(setImmediate);
    }
  }

  async function handleRequest(ws, ev) {
    let replyPubkey;
    try {
      const convKey = ntNip44.utils.getConversationKey(o.organizerSk, ev.pubkey);
      const payload = JSON.parse(ntNip44.decrypt(ev.content, convKey));
      replyPubkey = payload.replyPubkey;
      const blinded = Buffer.from(payload.blindedToken, 'base64');
      const sig = await o.signToken(payload.inviteCode, blinded);
      await sendResponse(ws, replyPubkey, {blindSig: Buffer.from(sig).toString('base64')});
      log('signed enrollment for invite ' + payload.inviteCode);
    } catch (e) {
      // A drop-eligible error (an invite code that doesn't exist — a credential-less flood) gets NO
      // reply, removing the mined+signed response an attacker could otherwise force per request. A
      // real member's error (e.g. "invite already used") is not drop-eligible, so they still hear why.
      if (e?.drop) { log('dropped invalid enrollment (no response sent)'); return; }
      if (e?.mailboxDelivery) throw e;
      if (replyPubkey) await sendResponse(ws, replyPubkey, {error: e?.message || 'enrollment failed'});
      log('request error: ' + (e?.message || e));
    }
  }

  // Handle an epoch-token DRAW request: the member proves membership with their (anonymous) blind
  // credential + a batch of blinded tokens; o.drawTokens verifies the credential, enforces the
  // per-credential/per-epoch quota, and blind-signs the batch — all without learning the npub.
  async function handleDraw(ws, ev) {
    let replyPubkey, payload;
    try {
      const convKey = ntNip44.utils.getConversationKey(o.organizerSk, ev.pubkey);
      payload = JSON.parse(ntNip44.decrypt(ev.content, convKey));
      replyPubkey = payload.replyPubkey;
      // {sigs?} | {error?, cap?} | {drop?}. `drop` marks an unauthenticated/malformed request the
      // policy says to answer with silence — strip it and send NOTHING, so a credential-less flood
      // can't force a mined + signed reply per request. `body` is the client-facing payload.
      const {drop, ...body} = (await o.drawTokens(payload)) || {};
      if (drop) { log('dropped invalid draw request (no response sent)'); return; }
      await sendResponse(ws, replyPubkey, body, KIND_DRAW_RESPONSE);
      if (body.sigs) log('drew ' + body.sigs.length + ' tokens for epoch ' + payload.epoch);
    } catch (e) {
      if (e?.mailboxDelivery) throw e;
      // o.drawTokens (organizer-server.mjs's drawTokensForMember) classifies + logs its own [draw-fail]
      // line with purpose+fingerprint for every rejection it RETURNS. This catch only fires for a
      // failure that escaped that classification entirely (a thrown exception, not a returned {error}
      // shape) — still worth a grep-able line, even without a fingerprint at this layer.
      console.error(`[draw-fail] purpose=${payload?.purpose ?? 'unknown'} fp=n/a err=${e?.message || e}`);
      if (replyPubkey) await sendResponse(ws, replyPubkey, {error: e?.message || 'draw failed'}, KIND_DRAW_RESPONSE);
      log('draw error: ' + (e?.message || e));
    }
  }

  // Handle a read-token UNLOCK request (lever 1 meter): the member spends one blind read-token to
  // obtain a content epoch key. o.unlockEpoch verifies the token's issuer signature, records it in
  // the read spent-set (one epoch unlock per token), and returns the requested K_E — all without
  // learning the npub (the token is blind-signed; the request rides a throwaway key).
  async function handleUnlock(ws, ev) {
    let replyPubkey;
    try {
      const convKey = ntNip44.utils.getConversationKey(o.organizerSk, ev.pubkey);
      const payload = JSON.parse(ntNip44.decrypt(ev.content, convKey));
      replyPubkey = payload.replyPubkey;
      // {key?} | {error?} | {drop?}. `drop` marks an unauthenticated/malformed request the policy says
      // to answer with silence — strip it and send NOTHING, so a junk-9026 flood can't force a mined +
      // signed reply per request (mirrors handleDraw). `body` is the client-facing payload.
      const {drop, ...body} = (await o.unlockEpoch(payload)) || {};
      if (drop) { log(describeDroppedUnlock(body)); return; }
      await sendResponse(ws, replyPubkey, body, KIND_UNLOCK_RESPONSE);
      if (body.key) log('unlocked content epoch ' + payload.epoch);
    } catch (e) {
      if (e?.mailboxDelivery) throw e;
      if (replyPubkey) await sendResponse(ws, replyPubkey, {error: e?.message || 'unlock failed'}, KIND_UNLOCK_RESPONSE);
      log('unlock error: ' + (e?.message || e));
    }
  }

  async function sendResponse(ws, replyPubkey, body, kind = KIND_ENROLL_RESPONSE) {
    const now = Math.floor(Date.now() / 1000);
    const convKey = ntNip44.utils.getConversationKey(o.organizerSk, replyPubkey);
    const unsigned = {
      pubkey: o.organizerPub,
      kind,
      created_at: now,
      tags: [['p', replyPubkey], ['expiration', String(now + MAILBOX_TTL_SECONDS)]],
      content: ntNip44.encrypt(JSON.stringify(body), convKey),
    };
    const event = finalizeEvent(await mine(unsigned, o.enrollPoW), o.organizerSk);
    await responsePublisher.publish(ws, event);
  }

  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  // In-flight mailbox handlers, for the optional concurrency ceiling (o.maxConcurrent). Persists
  // across reconnects so a mid-flood reconnect doesn't reset the count.
  let inFlight = 0;

  function connect() {
    if (stopped) return;
    // Route .onion through Tor's SOCKS proxy; reach a direct ws (e.g. an SSH tunnel to the
    // relay's localhost port) without it, so a Tor-less dashboard host can still service the
    // mailbox. The transport is chosen purely from the URL (isOnionRelayUrl, exported above).
    const isOnion = isOnionRelayUrl(o.relayUrl);
    const wsOpts = isOnion ? {agent: new SocksProxyAgent(socks)} : {};
    const socket = new WebSocket(o.relayUrl, wsOpts);
    ws = socket;
    const subId = 'org-mailbox';

    // Subscribe to enrollment requests and — when the handlers are wired — token-draw and
    // content-unlock requests.
    const kinds = [KIND_ENROLL_REQUEST];
    if (o.drawTokens) kinds.push(KIND_DRAW_REQUEST);
    if (o.unlockEpoch) kinds.push(KIND_UNLOCK_REQUEST);
    socket.on('open', () => {
      log('connected to relay (' + (isOnion ? 'Tor' : 'direct') + '); listening for requests.');
      // Ask the relay only for events newer than (highWater - overlap): it stops replaying most
      // history, and the overlap keeps requests that arrived during a reconnect gap. Fresh install
      // (highWater 0) omits `since` entirely so nothing is missed on first run.
      const filter = {kinds, '#p': [o.organizerPub]};
      if (highWater > 0) filter.since = Math.max(0, highWater - SINCE_OVERLAP_SECONDS);
      socket.send(JSON.stringify(['REQ', subId, filter]));
      // Fires on EVERY open, including the first — a caller (organizer-server.mjs) uses this to
      // re-broadcast its own fleet-sync config docs on reconnect, not just at startup, so a Tor
      // hiccup can't leave the fleet stuck on stale keys/epoch until the next periodic timer tick.
      // Guarded: a hook error must never take the mailbox connection down.
      if (typeof o.onOpen === 'function') {
        try { o.onOpen(); } catch (e) { log('onOpen hook error: ' + (e?.message || e)); }
      }
    });
    socket.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (responsePublisher.handleMessage(socket, msg)) return;
      if (msg[0] !== 'EVENT' || msg[1] !== subId) return;
      const ev = msg[2];
      // Pick the handler by kind up front so unknown kinds cost nothing.
      let handler = null;
      if (ev.kind === KIND_ENROLL_REQUEST) handler = handleRequest;
      else if (ev.kind === KIND_DRAW_REQUEST && o.drawTokens) handler = handleDraw;
      else if (ev.kind === KIND_UNLOCK_REQUEST && o.unlockEpoch) handler = handleUnlock;
      if (!handler) return;
      // Shed under load BEFORE marking the event seen, so a shed request's later resend can still be
      // processed once capacity frees (marking it seen here would dedupe the retry away forever).
      const maxConc = o.maxConcurrent ? o.maxConcurrent() : 0;
      if (maxConc > 0 && inFlight >= maxConc) {
        log(describeShedRequest(ev.kind, maxConc));
        return;
      }
      // Dedupe BEFORE decrypt/PoW: stale replays (from the overlap window or a since-less relay)
      // cost one Set lookup, not a full decrypt + mined error response.
      if (!shouldProcess(ev, seen, Math.floor(Date.now() / 1000))) return;
      inFlight++;
      void handler(socket, ev)
        .then(() => {
          // Persist dedupe/high-water only after the response was accepted by the relay (or the
          // request was intentionally dropped). A local ws.send() is not proof of delivery.
          noteProcessed(ev);
        })
        .catch(error => {
          // shouldProcess() claimed the id while it was in flight. Release that claim so the
          // client's exact-event retry can safely recover after a lost organizer connection/OK.
          seen.delete(ev.id);
          seenAt.delete(ev.id);
          log('mailbox response not delivered; request remains retryable (' + (error?.message || error) + ')');
        })
        .finally(() => { inFlight--; });
    });
    socket.on('close', () => {
      responsePublisher.failSocket(socket);
      if (!stopped) scheduleReconnect();
    });
    socket.on('error', err => { log('socket error: ' + (err?.message || err)); try { socket.close(); } catch {} });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; flushSeen(); }
      try { ws?.close(); } catch {}
    },
  };
}

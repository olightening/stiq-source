/**
 * Content-epoch rotation watcher (organizer side, lever 1 — the recordPost half of the read meter).
 *
 * The organizer mints a rotating content epoch key K_E that seals blind-post bodies (see
 * contentEpochKeys.mjs). To bound a leaked K_E's blast radius, the epoch must roll to a fresh key
 * every `rotateEvery` sealed posts — which requires COUNTING sealed posts. This watcher does exactly
 * that: it subscribes to the community relay's firehose for blind-content kinds and, for each new
 * post that is actually SEALED (carries a ['ke', <epoch>] tag), calls contentCustody.recordPost().
 * When recordPost reports a rotation it invokes onRotate() so the organizer re-publishes
 * stiq:content-epoch with the new epoch, and writing clients start sealing under the new key.
 *
 * Why count only sealed posts: an unsealed post consumes no content epoch, so it must not advance
 * rotation. This also keeps the epoch dormant at 0 until content sealing is actually live on clients,
 * then advances it precisely per sealed post.
 *
 * Rotation is NOT security-critical (it only bounds blast radius; every past K_E is retained so any
 * post's ['ke'] epoch stays unlockable forever). So counting is deliberately best-effort and cheap:
 *   - a SEPARATE ws to the (co-located) relay, so the mailbox's enrollment hot path is never touched;
 *   - `since: <startup>` on (re)subscribe, so a restart never re-counts old history (the running
 *     postsInEpoch count is already persisted in content_epochs.json);
 *   - a bounded in-memory dedupe set for reconnect replays;
 *   - every error caught + logged — the watcher can never crash or wedge the organizer.
 *
 * Griefing is bounded by the token economy: a post only reaches the relay by spending a blind token,
 * so forcing a rotation costs `rotateEvery` tokens for zero effect (a key change is harmless).
 */
// Body-bearing blind-content kinds a client may seal. Reactions (kind 7) are excluded: they carry no
// sealed body worth metering, and counting them would rotate the epoch far faster than intended.
export const CONTENT_KINDS = [1, 1111, 30023, 1222, 1244, 1018, 1068];

const SEEN_CAP = 5000; // bound the in-memory dedupe ring

/** True when an event is a sealed blind post (carries a ['ke', ...] content-epoch tag). Pure. */
export function isSealedPost(ev) {
  return !!ev && Array.isArray(ev.tags) && ev.tags.some(t => Array.isArray(t) && t[0] === 'ke');
}

/**
 * Process one firehose event for rotation. Counts it via custody.recordPost() iff it is a NEW
 * (per markNew) SEALED post. Pure-ish + exported so the count/rotate logic is unit-testable without
 * a live relay.
 *
 * @param {{id?:string, tags?:any[]}} ev  the incoming event
 * @param {(id:string)=>boolean} markNew  returns true the FIRST time an id is seen (dedupe)
 * @param {{recordPost:()=>{epoch:number,rotated:boolean}}} custody
 * @returns {{epoch:number, rotated:boolean}|null}  recordPost result if counted, else null
 */
export function recordIfSealed(ev, markNew, custody) {
  if (!ev || typeof ev.id !== 'string' || ev.id.length === 0) return null;
  if (!isSealedPost(ev)) return null;
  if (!markNew(ev.id)) return null;
  return custody.recordPost();
}

/**
 * Start the rotation watcher.
 *
 * @param {object} o
 * @param {string} o.relayUrl   ws url of the community relay (same one the organizer publishes to)
 * @param {{recordPost:()=>{epoch:number,rotated:boolean}}} o.custody  the content key custody
 * @param {(epoch:number)=>any} [o.onRotate]  called after a rotation (re-publish stiq:content-epoch)
 * @param {string} [o.socks]    socks proxy url for .onion relays (default socks5h://127.0.0.1:9050)
 * @param {()=>number} [o.now]  injectable clock (seconds) for tests
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{stop:()=>void}>}
 */
export async function startContentEpochWatcher(o) {
  const log = o.log || (m => console.log('[content-epoch] ' + m));
  const now = o.now || (() => Math.floor(Date.now() / 1000));
  if (!o.relayUrl || !o.custody || typeof o.custody.recordPost !== 'function') {
    log('disabled — missing relayUrl/custody.');
    return {stop() {}};
  }
  const onRotate = typeof o.onRotate === 'function' ? o.onRotate : () => {};

  let WebSocket, SocksProxyAgent;
  try {
    ({default: WebSocket} = await import('ws'));
    ({SocksProxyAgent} = await import('socks-proxy-agent'));
  } catch (e) {
    log('disabled — could not load ws deps (' + (e?.message || e) + '); epoch rotation will not run.');
    return {stop() {}};
  }
  const socks = o.socks || process.env.STIQ_TOR_SOCKS || 'socks5h://127.0.0.1:9050';

  // Bounded in-memory dedupe: a ring of recent ids so a reconnect replay doesn't double-count.
  const seen = new Set();
  const order = [];
  function markNew(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    order.push(id);
    if (order.length > SEEN_CAP) seen.delete(order.shift());
    return true;
  }

  const startedAt = now();
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  const subId = 'org-content-epoch';

  function connect() {
    if (stopped) return;
    const isOnion = /\.onion(?::\d+)?(?:\/|$)/i.test(o.relayUrl);
    let socket;
    try {
      socket = new WebSocket(o.relayUrl, isOnion ? {agent: new SocksProxyAgent(socks)} : {});
    } catch (e) {
      log('connect failed: ' + (e?.message || e));
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.on('open', () => {
      log('connected (' + (isOnion ? 'Tor' : 'direct') + '); watching sealed posts for epoch rotation.');
      // since startup: never re-count old history on (re)connect. Missing a few posts across a
      // reconnect gap only slows rotation slightly — acceptable, as rotation is not exact.
      try { socket.send(JSON.stringify(['REQ', subId, {kinds: CONTENT_KINDS, since: startedAt}])); }
      catch (e) { log('subscribe failed: ' + (e?.message || e)); }
    });
    socket.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg[1] !== subId) return;
      try {
        const res = recordIfSealed(msg[2], markNew, o.custody);
        if (res && res.rotated) {
          log('rotated content epoch to ' + res.epoch + '; re-publishing stiq:content-epoch.');
          Promise.resolve(onRotate(res.epoch)).catch(e => log('re-publish after rotation failed: ' + (e?.message || e)));
        }
      } catch (e) {
        log('recordPost error (ignored): ' + (e?.message || e));
      }
    });
    socket.on('close', () => { if (!stopped) scheduleReconnect(); });
    socket.on('error', err => { log('socket error: ' + (err?.message || err)); try { socket.close(); } catch {} });
  }

  function scheduleReconnect() {
    if (reconnectTimer || stopped) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
    reconnectTimer.unref?.();
  }

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { ws?.close(); } catch {}
    },
  };
}

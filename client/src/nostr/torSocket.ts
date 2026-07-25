/**
 * Tor-routed relay socket (PLAN.md Step 5).
 *
 * Wraps StiqSocketModule (native OkHttp WebSocket through Tor SOCKS5) in the RelaySocket
 * interface expected by RelayClient. The native module is event-based; this shim bridges
 * those events into the callback API RelayClient uses.
 *
 * If the native StiqSocket module is absent, throws — so the app surfaces an offline state
 * rather than silently bypassing Tor. Tests inject FakeRelaySocket instead.
 */
import {NativeEventEmitter, NativeModules, type NativeModule} from 'react-native';
import {requireTorTransport, type TorManager} from '../tor';
import {isOnionWsUrl} from '../util/onion';
import {log} from '../util/log';
import type {RelaySocket} from './socket';

interface StiqSocketNativeModule {
  connect(
    socketId: string,
    url: string,
    socksHost: string,
    socksPort: number,
    socksUser: string,
    socksPass: string,
  ): Promise<void>;
  send(socketId: string, message: string): Promise<void>;
  close(socketId: string): Promise<void>;
}

type SocketEvent =
  | {socketId: string; type: 'open'}
  | {socketId: string; type: 'message'; data: string}
  | {socketId: string; type: 'error'; data: string}
  | {socketId: string; type: 'close'};

let nextSocketId = 0;

/**
 * Anonymity finding #1 — isolate BLIND-POST publishes onto their own Tor circuit.
 *
 * The long-lived feed socket carries identity-scoped REQs (DM `#p:[myNpub]`, self-lists, group
 * subs). Publishing a blind post's EVENT on that SAME socket means the relay sees the blind write
 * and the real-npub REQs arrive on one circuit — a correlation handle on authorship. When this flag
 * is ON, `createTorRelaySocket` returns a socket that can spawn a FRESH ephemeral sibling socket
 * (its own socketId ⇒ its own SOCKS-auth credential ⇒ its own Tor circuit — IsolateSOCKSAuth) for a
 * single blind-post publish, so the blind EVENT never rides the identity circuit.
 *
 * ENABLED (audit #1 full deanonymization closure): blind-post publishes ride a dedicated Tor circuit
 * distinct from the identity-scoped REQ circuit. A fresh rendezvous per blind post is slower and more
 * failure-prone than reusing the warm feed circuit, so this is under on-device Tor validation — if it
 * proves unreliable on a real device, revert this const to `false` (byte-identical to the previous
 * single-circuit publish) and add the periodic-retry follow-up. Per-call `{isolatePublishCircuit}`
 * still overrides for tests.
 */
export const ISOLATE_BLIND_PUBLISH_CIRCUIT = true;

/**
 * A relay socket that can, on demand, open a dedicated circuit-isolated sibling socket for a single
 * blind-post publish. Only present on the returned socket when publish-circuit isolation is enabled;
 * RelayClient duck-types for `openPublishCircuit` and falls back to the shared socket when absent.
 */
export interface IsolatingRelaySocket extends RelaySocket {
  /**
   * Open a fresh Tor-routed sibling socket to the SAME relay onion, with its own socketId (⇒ its own
   * SOCKS credential ⇒ its own Tor circuit). Returns null when a dedicated circuit can't be built
   * right now (Tor momentarily offline, or the native module is absent) — the caller then queues the
   * blind post for retry rather than leaking it onto the identity circuit.
   */
  openPublishCircuit(): RelaySocket | null;
}

function getNativeSocketModule(): StiqSocketNativeModule | undefined {
  return (NativeModules as {StiqSocket?: StiqSocketNativeModule}).StiqSocket;
}

/**
 * Build a relay socket routed through Tor. Throws if Tor is not connected or if
 * the StiqSocket native module is not linked. Each call mints a unique socketId, so passing it as
 * the SOCKS username/password engages Tor's IsolateSOCKSAuth — every socket gets its own circuit.
 */
function openTorSocket(manager: TorManager, onionUrl: string): RelaySocket {
  const socks = requireTorTransport(manager); // throws when offline — Tor-only guarantee
  if (!isOnionWsUrl(onionUrl)) {
    throw new Error(`refusing non-onion relay URL: ${onionUrl}`);
  }
  const native = getNativeSocketModule();
  if (!native) {
    throw new Error(
      'StiqSocket native module not linked — build the Android project to connect to the relay',
    );
  }

  const socketId = `stiq-socket-${++nextSocketId}`;
  const emitter = new NativeEventEmitter(native as unknown as NativeModule);
  let onMessageCb: ((data: string) => void) | undefined;
  let onOpenCb: (() => void) | undefined;
  let onCloseCb: (() => void) | undefined;

  // Buffer messages sent before the WebSocket handshake completes.
  let isOpen = false;
  let terminalClosed = false;
  let replayClose = false;
  const sendQueue: string[] = [];

  let sub: {remove: () => void};
  const notifyRemoteClose = (): void => {
    if (terminalClosed) return;
    terminalClosed = true;
    replayClose = true;
    isOpen = false;
    sub.remove();
    onCloseCb?.();
  };

  sub = emitter.addListener('StiqSocket', (event: SocketEvent) => {
    if (event.socketId !== socketId) return;
    // Privacy-safe transport trace: event type + local socket sequence only, never payload data.
    // Through the app's leveled logger (dev-console + bounded ring), so it doesn't spam release logs.
    log.info('torsocket', socketId, event.type);
    switch (event.type) {
      case 'open':
        isOpen = true;
        for (const msg of sendQueue.splice(0)) {
          void native.send(socketId, msg);
        }
        onOpenCb?.();
        break;
      case 'message':
        onMessageCb?.(event.data);
        break;
      case 'error':
        // onFailure in Kotlin — treat as close so the caller knows the socket is dead.
        notifyRemoteClose();
        break;
      case 'close':
        // A remote close means this socket is dead; App.tsx's onClose handler spins up a fresh
        // socket (with its own listener on the same global native channel). Remove THIS listener
        // here too — the 'error' case and close() already do — or every past reconnect's stale
        // listener keeps dispatching each incoming frame, re-processing every relay event N+1×.
        notifyRemoteClose();
        break;
    }
  });

  // Start connection — RelayClient's onOpen callback fires when the socket opens.
  // On failure (SOCKS unreachable, circuit down), fire onClose so RelayClient and
  // callers know the socket is dead rather than silently waiting for the publish timer.
  //
  // Per-session SOCKS auth (audit #49): the socketId is unique per socket instance, so passing it as
  // the SOCKS username/password engages Tor's IsolateSOCKSAuth and gives each logical relay session
  // (the long-lived feed/publish socket, the enrollment socket, the token-draw socket) its own
  // circuit — they are never multiplexed onto one shared circuit.
  void native
    .connect(socketId, onionUrl, socks.host, socks.port, socketId, socketId)
    .catch(() => {
      notifyRemoteClose();
    });

  return {
    send(data: string): void {
      if (terminalClosed) return;
      if (isOpen) {
        void native.send(socketId, data);
      } else {
        sendQueue.push(data);
      }
    },
    onMessage(cb: (data: string) => void): void {
      onMessageCb = cb;
    },
    onOpen(cb: () => void): void {
      onOpenCb = cb;
      // The native connection starts before this wrapper is returned. Enrollment performs key
      // generation + PoW before registering onOpen, so a fast onion handshake can win that race.
      // Replay the state to late subscribers; otherwise their first frames stay unsent until the
      // exchange's 90-second timeout.
      if (isOpen) {
        cb();
      }
    },
    onClose(cb: () => void): void {
      onCloseCb = cb;
      // The onion connect can fail while enrollment is still doing crypto/PoW, before it has had
      // a chance to register this callback. Replay that terminal state just like late onOpen.
      if (replayClose) {
        cb();
      }
    },
    close(): void {
      terminalClosed = true; // intentional local close must not look like a connection failure
      sub.remove();
      void native.close(socketId);
    },
  };
}

/** How soon after the main socket opens to start warming the first spare publish circuit. */
const WARM_INITIAL_DELAY_MS = 250;
/**
 * Backoff before retrying to warm a replacement spare after a warm attempt failed (native/Tor
 * offline) or died before finishing its onion rendezvous. Keeps a flaky Tor network from hot-looping
 * connect attempts — this is purely opportunistic background work, never on the publish path.
 */
const WARM_RETRY_BACKOFF_MS = 2_000;

/**
 * Build the app's relay socket over Tor. The returned socket carries the feed subscription and — by
 * default — publishes too, exactly as before.
 *
 * When publish-circuit isolation is enabled (see {@link ISOLATE_BLIND_PUBLISH_CIRCUIT}, or the
 * per-call `opts.isolatePublishCircuit` override used by tests / a future on-device toggle), the
 * returned socket additionally exposes `openPublishCircuit()`, which RelayClient uses to send a
 * blind post's EVENT over a FRESH sibling socket — its own socketId ⇒ its own Tor circuit — so the
 * blind write never shares a circuit with this socket's identity-scoped REQs (anonymity finding #1).
 * A sibling is a full, independent Tor-routed socket built by the same code path, so it inherits all
 * of the base socket's buffering/close semantics; the caller owns its lifecycle (opens it, sends one
 * EVENT, waits for the OK, closes it).
 *
 * WARM POOL (fixes "posts not posting anywhere" under a flaky Tor network): opening a brand-new
 * onion rendezvous per blind post is slow and failure-prone, so this keeps at most ONE spare sibling
 * circuit pre-opened (already past its onion handshake) ready to hand to the next publish —
 * `openPublishCircuit()` returns it instantly instead of making the caller wait out a fresh
 * rendezvous. Each spare is still a FULL fresh sibling (its own socketId ⇒ its own SOCKS credential ⇒
 * its own Tor circuit): warming only moves the slow part earlier, it never reuses one circuit across
 * posts and never shares one with the main/identity socket. The pool never holds more than one spare;
 * a spare that dies before being handed out is discarded and a replacement is warmed in its place
 * (with a backoff so a persistently-offline Tor doesn't hot-loop connect attempts). Warming failures
 * are always swallowed — they can only ever affect how often a fresh circuit has to be opened
 * synchronously, never surface into the publish path.
 *
 * With isolation disabled (the default override) the extra method is ABSENT and no warm pool is
 * kept, so behaviour is byte-identical to the previous single-circuit publish and no caller can
 * accidentally engage it.
 */
export function createTorRelaySocket(
  manager: TorManager,
  onionUrl: string,
  opts: {isolatePublishCircuit?: boolean} = {},
): RelaySocket {
  const base = openTorSocket(manager, onionUrl);
  const isolate = opts.isolatePublishCircuit ?? ISOLATE_BLIND_PUBLISH_CIRCUIT;
  if (!isolate) {
    return base;
  }

  // A sibling that has fully opened (finished its onion handshake) and is unclaimed by any publish.
  let spare: RelaySocket | null = null;
  // A warm attempt is currently rendezvousing (not yet ready, not yet handed out). Guards against
  // ever running two warm attempts — or holding more than one spare — at once.
  let warming = false;
  let warmRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // Set once this socket is torn down (Tor drop / community switch / relay.close()). After disposal
  // the pool must go fully quiescent: no new warm attempt, no pending retry, no post-close promotion
  // of an in-flight sibling, and no held-open spare — otherwise every frequent-reconnect teardown
  // (the exact unstable-Tor case this fix targets) would leak a warmed circuit AND keep a failing
  // warm loop firing openTorSocket() on the orphaned onion forever, competing with the real reconnect.
  let disposed = false;

  const scheduleWarmRetry = (): void => {
    if (disposed || warmRetryTimer) return; // never (re)schedule after close, nor stack two retries
    warmRetryTimer = setTimeout(() => {
      warmRetryTimer = undefined;
      warmSpare();
    }, WARM_RETRY_BACKOFF_MS);
    (warmRetryTimer as {unref?: () => void}).unref?.();
  };

  const warmSpare = (delayMs = 0): void => {
    if (disposed || warming || spare) return; // one spare AND one warm attempt max; none after close
    warming = true;
    const attempt = (): void => {
      if (disposed) {
        // Torn down while a delayed warm was pending — don't open a circuit on a dead socket.
        warming = false;
        return;
      }
      let sib: RelaySocket;
      try {
        sib = openTorSocket(manager, onionUrl);
      } catch {
        // Native module absent / Tor momentarily offline — swallow and retry later. Warming is
        // purely opportunistic background work; it must never throw into the publish path.
        warming = false;
        scheduleWarmRetry();
        return;
      }
      let settled = false; // this sibling has been promoted to `spare` or discarded, exactly once
      sib.onOpen(() => {
        if (settled) return;
        settled = true;
        warming = false;
        if (disposed) {
          // Rendezvous completed AFTER teardown — never promote it to `spare` (it would be an
          // orphaned open circuit that close() already ran past). Close it and drop it.
          try { sib.close(); } catch { /* already closed */ }
          return;
        }
        spare = sib;
      });
      sib.onClose(() => {
        // Dies before being handed out — whether before or after finishing its handshake. Never hand
        // a dead circuit to a publish: discard it, and if it never got to warm, try again later.
        if (spare === sib) spare = null;
        if (!settled) {
          settled = true;
          warming = false;
          scheduleWarmRetry();
        }
      });
    };
    if (delayMs > 0) {
      const t = setTimeout(attempt, delayMs);
      (t as {unref?: () => void}).unref?.();
    } else {
      attempt();
    }
  };

  /**
   * Tear the warm pool down and hold it quiescent, IDEMPOTENTLY (the `disposed` guard makes a second
   * call a no-op). Must run on EVERY base-socket death — remote (native 'close'/'error' →
   * notifyRemoteClose → the base onClose handler) as well as a local `close()` — because the base's
   * remote-close path fires the caller's onClose handler DIRECTLY and would otherwise bypass the
   * explicit close() override, leaving `disposed` false and the pool orphaned (a pre-warmed spare
   * held open on a dead onion, and a mid-rendezvous warm re-firing openTorSocket() every 2s on an
   * unreachable onion). Stops any new warm attempt / pending retry / post-close promotion, and closes
   * the held spare. Fully guarded — disposal must never throw into the caller's teardown path.
   */
  const disposePool = (): void => {
    if (disposed) return;
    disposed = true; // stops any new warm attempt, pending retry, and post-close promotion (above)
    if (warmRetryTimer !== undefined) {
      clearTimeout(warmRetryTimer);
      warmRetryTimer = undefined;
    }
    if (spare) {
      const held = spare;
      spare = null;
      try { held.close(); } catch { /* already closed */ }
    }
    // An in-flight `warming` sibling (if any) is still mid-rendezvous; its onOpen handler above sees
    // `disposed` and closes+drops itself rather than promoting to `spare`, so nothing leaks.
  };

  const isolating: IsolatingRelaySocket = {
    ...base,
    onOpen(cb: () => void): void {
      // `base.onOpen` holds a single callback slot, so this wrapper is the one registration point:
      // it starts warming the first spare once the main socket is up (per the base's own
      // replay-on-late-subscribe semantics — if already open, both fire immediately) IN ADDITION to
      // forwarding to whatever the caller (RelayClient) does on open.
      base.onOpen(() => {
        warmSpare(WARM_INITIAL_DELAY_MS);
        cb();
      });
    },
    onClose(cb: () => void): void {
      // Mirror the onOpen wrapper: `base.onClose` holds a single callback slot and RelayClient
      // registers onClose exactly once, so this is the one registration point. Dispose the pool
      // BEFORE the caller's handler runs, so a GENUINE REMOTE death (which reaches the caller through
      // base's onClose, NOT through our close() override) still tears the warm pool down. Covers all
      // death paths — remote 'close'/'error' and local close() both funnel through here or close().
      base.onClose(() => {
        disposePool();
        cb();
      });
    },
    openPublishCircuit(): RelaySocket | null {
      if (spare) {
        const ready = spare;
        spare = null;
        warmSpare(); // immediately start warming a replacement for the NEXT publish
        return ready;
      }
      // No spare ready right now (cold start, or a warm attempt is still mid-rendezvous) — open a
      // fresh circuit synchronously exactly as without the warm pool, so this call never blocks on
      // warming. Open THIS call's circuit first, then kick off warming a spare for next time (in that
      // order, so this synchronous open is always the very next socket after the caller's own —
      // warming never interposes an extra socket ahead of the one this call is about to return).
      let fresh: RelaySocket | null;
      try {
        fresh = openTorSocket(manager, onionUrl);
      } catch {
        fresh = null;
      }
      warmSpare();
      return fresh;
    },
    close(): void {
      // Dispose the warm pool BEFORE tearing down the main socket, so the frequent reconnects this
      // fix targets never leak a warmed circuit or leave a failing warm loop firing openTorSocket()
      // on the orphaned onion. Shares the idempotent helper with the remote-death onClose path; the
      // `disposed` guard makes the double call (if base.close() re-enters onClose) a harmless no-op.
      disposePool();
      base.close();
    },
  };
  return isolating;
}

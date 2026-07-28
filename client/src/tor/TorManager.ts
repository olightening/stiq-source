/**
 * TorManager — the single transport authority for the app (PLAN.md §3.2).
 *
 * It bootstraps the bundled Tor daemon over a bridge and tracks one connection state. It
 * is the ONLY source of a usable transport: `getSocksProxy()` returns a proxy strictly
 * while connected, and is null otherwise. There is no clearnet path. If Tor fails to
 * bootstrap, the manager settles in `offline` — it never falls back to a direct
 * connection. The WebSocket layer (Step 5) obtains its proxy exclusively from here.
 */
import {ALLOW_CLEARNET_FALLBACK} from '../config';
import type {ConnectionState} from '../connection';
import type {TorBackend} from './backend';
import {createBootstrapTimeline, type BootstrapTimeline} from './bootstrapTiming';
import {buildStartConfig} from './bridges';
import {getActiveRelayOnion, relayOnionHostOf} from './onionAuth';
import type {BootstrapProgress, SocksProxy, TorBackendEvent, TorStartConfig, TransportType} from './types';

export interface TorManagerOptions {
  transport?: TransportType;
  bridgeLines?: string[];
  socksPort?: number;
  dataDir?: string;
  /** Bootstrap deadline; on expiry the manager goes offline (no fallback). */
  bootstrapTimeoutMs?: number;
  /** v3 onion client-auth reach credential for a members-only relay onion (lever 2). Threaded
   *  straight through to the native start config; absent → a public onion. See ./onionAuth. */
  onionAuth?: TorStartConfig['onionAuth'];
  /** Resolver pulled at EACH connect for the current onion-auth credential — so the manager always
   *  reaches the ACTIVE community's onion without the caller re-wiring on every switch. Overrides
   *  the static `onionAuth`. */
  resolveOnionAuth?: () => TorStartConfig['onionAuth'] | null;
  /** Static relay onion (URL, `<host>.onion`, or bare host) for the native reachability probe —
   *  see TorStartConfig.relayOnion. Normalized through relayOnionHostOf at connect. */
  relayOnion?: string;
  /** Resolver pulled at EACH connect for the current community's relay onion. Highest precedence in
   *  the chain resolver > static `relayOnion` > the module-level `getActiveRelayOnion()` >
   *  `onionAuth.onionHost`; the FIRST one that yields a v3 onion wins. Unlike `resolveOnionAuth`, a
   *  null return does NOT clear the value — it just falls through to the next source. "No relay
   *  onion" is not a meaningful state the way "public onion, no auth key" is: it only costs the
   *  probe its target, and a missing probe is the bug this field exists to close. */
  resolveRelayOnion?: () => string | null | undefined;
  /** Static SECONDARY-mirror reach credentials (P2 §1.7 multi-relay client transport). Threaded
   *  straight through to the native start config alongside `onionAuth`; absent/empty → no
   *  secondary mirrors carry their own auth-gated onion. See ./onionAuth deriveOnionAuthSet. */
  onionAuthExtra?: TorStartConfig['onionAuthExtra'];
  /** Resolver pulled at EACH connect for the current secondary-mirror credentials — mirrors
   *  `resolveOnionAuth` but for the extra set, so the manager always reaches every ACTIVE mirror
   *  without the caller re-wiring on every community switch. Overrides the static
   *  `onionAuthExtra`. Inert (never called) until a caller supplies it. */
  resolveOnionAuthExtra?: () => TorStartConfig['onionAuthExtra'] | null;
  /** When true, Arti applies `DormantMode::Soft` to the TorClient at construction (so a backgrounded
   *  daemon can idle instead of being killed) rather than C-tor's torrc padding/DormantClientTimeout
   *  directives, which Arti has no equivalent of. Pure transport config, not manager state: threaded
   *  straight into `buildStartConfig(merged)` via the `{...this.options}` spread in connect().
   *  Absent/false → built non-dormant, byte-identical. See TorStartConfig.dormancy. */
  dormancy?: boolean;
  /** Injectable clock for the connect-timing instrumentation ONLY (see ./bootstrapTiming). Defaults
   *  to Date.now. Tests pass a deterministic counter so a recorded breakdown is assertable without
   *  fake timers. Nothing in the state machine reads this — it never affects connect behaviour. */
  now?: () => number;
  /** Called once per finished connect attempt with its per-phase wall-clock attribution. Purely an
   *  observer seam for diagnostics/telemetry; throwing from it cannot break a connect. */
  onTiming?: (timeline: BootstrapTimeline, outcome: 'connected' | 'offline') => void;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 60_000;
// Under C-tor, native start() could spend up to ~12s in a teardown barrier (waiting for a prior
// Tor daemon to fully die) plus a further ~3s forced-kill extension before it emitted a single
// bootstrap percent — dead time that must not be counted against the no-progress deadline, or a
// short reprobe deadline (e.g. the 20s direct-Tor retry) got mostly consumed before real
// bootstrapping even started. Arti's StiqArtiModule.startTor has no such wait: there is no prior
// daemon to tear down, and it emits its first bootstrap event in well under a second. So this
// grace is now just small headroom for that first event to cross the JNI + RN bridge — not zero,
// but nowhere near the old C-tor barrier. See armTimeout() in connect(). Exported so tests can
// assert against it precisely instead of duplicating the literal.
export const FIRST_PROGRESS_GRACE_MS = 3_000;

function sameOnionAuth(
  a: TorStartConfig['onionAuth'] | null | undefined,
  b: TorStartConfig['onionAuth'] | null | undefined,
): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.onionHost === b.onionHost && a.privKeyBase32 === b.privKeyBase32;
}

function eventToState(event: TorBackendEvent): ConnectionState {
  switch (event.kind) {
    case 'stopped':
      return 'disconnected';
    case 'starting':
      return 'starting-tor';
    case 'bootstrapping':
      return 'connecting-bridge';
    case 'connected':
      return 'connected';
    // Deferred reachability verdicts (types.ts): 'verified' confirms the state we are already in;
    // 'transport-dead' means the daemon bootstrapped off a cached consensus but cannot carry a
    // stream — for every consumer of coarse state that is an offline transport.
    case 'verified':
      return 'connected';
    case 'transport-dead':
      return 'offline';
    case 'error':
      return 'offline';
  }
}

export class TorManager {
  private state: ConnectionState = 'disconnected';
  private socks: SocksProxy | null = null;
  // Version string the embedded tor daemon reported on the connected event, or null when the
  // backend didn't report one (always null under Arti today — see the connected-event handler in
  // connect() below). Surfaced via getTorVersion(); purely informational, never gates connect.
  private torVersion: string | null = null;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  // Reach-verdict listeners (see onReach). Long-lived like `listeners`; the per-attempt backend
  // subscription is what feeds them, so verdicts only ever arrive while a daemon we started lives.
  private readonly reachListeners = new Set<
    (ok: boolean, transport: TransportType | null, message?: string) => void
  >();
  // Transport of the most recent connect attempt — what a reach verdict is ABOUT. The verdict
  // arrives after connect() has resolved and the cascade's rung-local variables are gone, so the
  // manager carries this for the listener instead.
  private lastTransport: TransportType | null = null;
  // Latest bootstrap progress (percent + Tor's own summary) for the current attempt, or null when
  // not bootstrapping. Surfaced so the onboarding connect screen reflects the REAL Tor progress.
  private bootstrap: BootstrapProgress | null = null;
  private readonly progressListeners = new Set<(p: BootstrapProgress) => void>();
  // Per-phase wall-clock attribution for the LAST FINISHED connect attempt (see ./bootstrapTiming).
  // Retained after the attempt settles so a diagnostics surface — or a field log — can read the
  // breakdown that explains a slow connect instead of guessing. Null until one attempt finishes.
  private lastTiming: BootstrapTimeline | null = null;
  private unsubscribeBackend?: () => void;
  private timeoutHandle?: ReturnType<typeof setTimeout>;
  // Monotonic attempt id, bumped whenever an attempt is superseded (a new connect, or a
  // disconnect). Backend events and the bootstrap timeout from a superseded attempt are
  // ignored, so exactly one attempt ever drives state. This is what stops a stale Tor
  // instance — e.g. a late event from a torn-down attempt — from flipping the UI to
  // "connected" when the live circuit is actually gone.
  private generation = 0;
  // Resolver for the in-flight connect() promise, so a superseding connect/disconnect can
  // release it instead of leaving the caller awaiting forever.
  private releaseInFlight?: (state: ConnectionState) => void;
  // Credential actually passed to the currently running Tor backend. Tor can be 100% bootstrapped
  // without being able to resolve an auth-gated onion, so callers must be able to distinguish
  // "Tor is connected" from "Tor was started with the key for this onion".
  private configuredOnionAuth: TorStartConfig['onionAuth'] | null = null;
  // Every credential the running daemon was actually started with — primary plus any secondary
  // mirrors (P2 §1.7). Always [configuredOnionAuth].filter(Boolean) when no extras are supplied,
  // so single-mirror behaviour (the only path exercised today) is unchanged byte-for-byte.
  private configuredOnionAuthSet: NonNullable<TorStartConfig['onionAuth']>[] = [];
  // Whether a daemon this manager started may still be running, i.e. whether stop() has anything
  // to do. Every backend.stop() still costs a JS↔native bridge round-trip through the single
  // lifecycle executor (StiqArtiModule.kt) even though Arti's own artiStop() is now a near-instant
  // in-memory drop — no longer the bounded ~10s poll C-tor's stop used to cost — so stopping an
  // already-stopped daemon is not exactly free, it just delays the next start by a small,
  // no-longer-worth-measuring-in-seconds amount rather than a real one.
  //
  // Initialised TRUE deliberately: at construction we do not know whether a daemon from a previous
  // process (a dormant one we may later reattach to, or one orphaned by a crash) is still alive, so
  // the FIRST stop() must always reach the backend and act as the safety hammer. Only once we have
  // observed a stop of our own do we start skipping.
  private backendMaybeRunning = true;

  constructor(
    private readonly backend: TorBackend,
    private readonly options: TorManagerOptions = {},
  ) {
    // Compile-time intent, enforced at runtime: this build must never allow clearnet.
    if (ALLOW_CLEARNET_FALLBACK) {
      throw new Error('ALLOW_CLEARNET_FALLBACK must be false: no clearnet transport is permitted');
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  /**
   * True only when the live Tor daemon was started with this onion credential — as the primary OR
   * as one of the secondary-mirror `onionAuthExtra` entries (P2 §1.7). `null` still means "the
   * public-onion (no-auth) config", checked against the PRIMARY slot only, so single-mirror
   * callers (the only path exercised before secondaries existed) see byte-identical behaviour. A
   * different key (or a public-onion config) requires a daemon restart because Tor reads
   * ClientOnionAuthDir at startup.
   */
  isOnionAuthActive(auth: TorStartConfig['onionAuth'] | null): boolean {
    if (this.state !== 'connected') {
      return false;
    }
    if (auth == null) {
      return this.configuredOnionAuth == null;
    }
    return this.configuredOnionAuthSet.some(x => sameOnionAuth(x, auth));
  }

  /** The active SOCKS proxy, or null. Non-null ONLY while connected. */
  getSocksProxy(): SocksProxy | null {
    return this.state === 'connected' ? this.socks : null;
  }

  /**
   * Version string the connected tor daemon reported, or null when the backend didn't report one
   * (always null under Arti today) / no connection has been made. Informational only; never used
   * to gate transport.
   */
  getTorVersion(): string | null {
    return this.torVersion;
  }

  /**
   * True only when Tor is ACTUALLY usable right now — connected AND holding a live SOCKS proxy.
   *
   * Why this exists instead of `getState() === 'connected'`: `disconnect()` (below) nulls
   * `this.socks` synchronously but only flips state to 'disconnected' AFTER `backend.stop()`
   * resolves. Under the since-deleted C-tor backend that resolution could block for up to ~10s
   * (a bounded poll on the native control channel), so `getState()` could stale-report 'connected'
   * for that whole window even though the circuit was already torn down. Arti's stop
   * (StiqArtiModule.stopTor → artiStop(), a near-instant in-memory drop) closes that window to a
   * single JS↔native bridge round-trip — real, but no longer seconds-scale. Callers that gate
   * reconnect decisions on `getState()` (e.g. "skip reconnecting, we're already connected") would
   * still, in principle, be fooled for that brief remaining window and stay silent when the circuit
   * is actually gone. `isLive()` is immune to it regardless of its size: `this.socks` is cleared in
   * the very same synchronous tick disconnect() starts in, so this predicate flips to false
   * immediately, with no dependency on how long the backend takes to confirm the stop.
   */
  isLive(): boolean {
    return this.state === 'connected' && this.socks !== null;
  }

  onChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to the DEFERRED reachability verdict (native background probe — types.ts 'verified'
   * / 'transport-dead'). `ok=true`: the connected transport demonstrably carries a stream to the
   * relay onion — safe to record the rung warm. `ok=false`: bootstrap lied off a cached consensus;
   * the manager has already begun stopping the daemon and is about to flip state to 'offline'
   * (listeners here fire FIRST, so a ladder can mark the rung dead before the offline retry path
   * schedules the next walk). `transport` names the rung the verdict is about.
   */
  onReach(
    listener: (ok: boolean, transport: TransportType | null, message?: string) => void,
  ): () => void {
    this.reachListeners.add(listener);
    return () => this.reachListeners.delete(listener);
  }

  private notifyReach(ok: boolean, message?: string): void {
    for (const listener of this.reachListeners) {
      try {
        listener(ok, this.lastTransport, message);
      } catch {
        // A verdict observer must never be able to break the state machine.
      }
    }
  }

  /**
   * Per-phase wall-clock attribution for the last FINISHED connect attempt, or null before one has
   * finished. Read-only diagnostics: `getLastTiming()?.format()` yields the one-line breakdown, and
   * `.slowest()` names the phase that actually cost the connect its time.
   */
  getLastTiming(): BootstrapTimeline | null {
    return this.lastTiming;
  }

  /** Latest live bootstrap progress, or null when Tor isn't actively bootstrapping. */
  getBootstrap(): BootstrapProgress | null {
    return this.bootstrap;
  }

  /**
   * Subscribe to REAL bootstrap progress (percent + Tor's summary) as the daemon boots. These fire
   * in addition to onChange — onChange reports the coarse state, this reports the live percentage so
   * a connecting screen can render a truthful progress bar. Long-lived: survives connect attempts
   * (the per-attempt backend subscription is separate), so subscribe once and keep it.
   */
  onBootstrap(listener: (p: BootstrapProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /**
   * Start Tor and resolve once a terminal state is reached: `connected` on success,
   * `offline` on any error or bootstrap timeout. Never resolves to a clearnet path.
   * Pass `overrides` to select a different transport and/or use fresh bridges fetched at
   * runtime instead of the ones baked into `options` at construction time. This is how the
   * app prefers WebTunnel (with moat-fetched bridges) and falls back to obfs4.
   */
  async connect(overrides?: {
    transport?: TransportType;
    bridgeLines?: string[];
    /**
     * Per-attempt bootstrap deadline, overriding the constructor default. Lets the app try a
     * short "warm" deadline when reusing cached bridges + a warm dataDir, then fall back to a
     * longer "cold" deadline for the full fetch-and-bootstrap cascade.
     */
    bootstrapTimeoutMs?: number;
  }): Promise<ConnectionState> {
    if (this.state === 'connected') {
      return this.state;
    }
    // Was a previous connect() attempt still in flight (its promise not yet settled)? If so,
    // superseding it below must also stop the native backend before we ask it to start again —
    // symmetric with disconnect(). supersede() itself only tears down JS-side bookkeeping
    // (timeout/subscription/promise); without this, a connect() that interrupts another
    // in-flight connect() could ask the native module to start a fresh Tor daemon while the
    // previous attempt's startTor() is still mid-flight, which is exactly the concurrent-start
    // race the native lifecycle serialization (StiqArtiModule's single lifecycle executor) exists
    // to guard against — but stopping proactively here means we don't rely on that alone.
    const hadInFlightAttempt = this.releaseInFlight !== undefined;
    // Supersede any in-flight attempt: tear down its subscription/timeout and release its
    // promise, so there is exactly one live backend subscription and one attempt driving
    // state at any time. (The old code subscribed afresh on every connect without ever
    // removing the previous listener — leaked subscriptions from dead attempts kept mutating
    // state, which both corrupted the reconnect logic and showed a false "connected".)
    const gen = this.supersede('disconnected');
    // Start the connect clock HERE — before the teardown barrier and before the native start — so
    // the `launch` phase honestly carries that dead time (FIRST_PROGRESS_GRACE_MS documents it as
    // up to ~12s) instead of it vanishing into an unmeasured gap ahead of the first percent line.
    const now = this.options.now ?? Date.now;
    const timeline = createBootstrapTimeline(now());
    if (hadInFlightAttempt) {
      await this.stopBackendIfRunning();
    }
    const merged: TorManagerOptions = {...this.options};
    if (overrides?.transport) {
      merged.transport = overrides.transport;
    }
    if (overrides?.bridgeLines && overrides.bridgeLines.length > 0) {
      merged.bridgeLines = overrides.bridgeLines;
    }
    // Resolve the onion-auth reach credential fresh for THIS attempt (lever 2). Precedence:
    // per-connect resolver (active community) > static option.
    if (this.options.resolveOnionAuth) {
      merged.onionAuth = this.options.resolveOnionAuth() ?? undefined;
    }
    // Same precedence for the secondary-mirror set (P2 §1.7). Resolver absent/returns
    // null/undefined → falls back to the static option → undefined → no secondaries.
    if (this.options.resolveOnionAuthExtra) {
      merged.onionAuthExtra = this.options.resolveOnionAuthExtra() ?? undefined;
    }
    // Resolve the native reachability probe's target for THIS attempt. This must NOT be keyed off
    // onionAuth: `onionAuth == null` means "a PUBLIC relay onion", not "no relay", and a public
    // community's user hits the exact same "bootstrap 100% with no usable guards" lie the probe
    // exists to catch (arti-ffi/src/lib.rs). Precedence — first source that yields a v3 onion wins:
    //   1. resolveRelayOnion()  — the ACTIVE community, re-read per attempt (community switches).
    //   2. options.relayOnion   — a statically configured relay.
    //   3. getActiveRelayOnion() — the module-level publisher, so a caller that never wires a
    //      resolver still gets probe coverage from whoever activates the community.
    //   4. merged.onionAuth.onionHost — the auth credential's own host, which also covers a
    //      per-connect onboarding OVERRIDE that (3) cannot see. Same target the native side would
    //      have fallen back to on its own, so this can never narrow existing coverage.
    merged.relayOnion =
      relayOnionHostOf(this.options.resolveRelayOnion?.()) ??
      relayOnionHostOf(this.options.relayOnion) ??
      getActiveRelayOnion() ??
      merged.onionAuth?.onionHost;
    const config = buildStartConfig(merged);
    this.lastTransport = merged.transport ?? null;
    this.configuredOnionAuth = merged.onionAuth ?? null;
    this.configuredOnionAuthSet = [
      ...(merged.onionAuth ? [merged.onionAuth] : []),
      ...(merged.onionAuthExtra ?? []),
    ];

    return new Promise<ConnectionState>(resolve => {
      this.releaseInFlight = resolve;
      const isCurrent = (): boolean => this.generation === gen;
      const settle = (final: ConnectionState) => {
        if (!isCurrent()) {
          return;
        }
        this.clearTimeout();
        this.releaseInFlight = undefined;
        // Freeze and publish the connect-clock attribution before resolving, so a caller awaiting
        // connect() can read getLastTiming() the moment it returns.
        timeline.finish(now());
        this.lastTiming = timeline;
        const outcome = final === 'connected' ? 'connected' : 'offline';
        console.info(`[tor] connect ${outcome}: ${timeline.format()}`);
        try {
          this.options.onTiming?.(timeline, outcome);
        } catch {
          // A diagnostics observer must never be able to break a connect.
        }
        resolve(final);
        // The subscription is intentionally kept alive after a successful connect so the
        // manager keeps hearing about a later drop; it is removed by the next supersede().
      };

      const timeoutMs =
        overrides?.bootstrapTimeoutMs ??
        this.options.bootstrapTimeoutMs ??
        DEFAULT_BOOTSTRAP_TIMEOUT_MS;
      // The deadline is "this long with NO forward progress", not "this long total". Re-armed on
      // every percent increase below. A bridge that keeps advancing (Snowflake on a slow network
      // routinely climbs past 50% well after a fixed 180s ceiling) is given the time to finish
      // instead of being killed mid-bootstrap and thrashing the cascade onto a worse transport.
      // Highest bootstrap percent seen this attempt; only a real increase re-arms the deadline, so a
      // flat stream of repeated/lower percents (or a stall) still times out and escalates.
      let lastPercent = 0;
      const armTimeout = (): void => {
        this.clearTimeout();
        // Before any real forward progress (lastPercent === 0), give this arm the extra
        // FIRST_PROGRESS_GRACE_MS budget to absorb the native teardown barrier (see its doc
        // comment) — otherwise that dead time is unfairly charged against the no-progress
        // deadline. Once a percent > 0 event has re-armed us, lastPercent is > 0 here and we
        // fall back to the plain timeoutMs.
        const budget = lastPercent === 0 ? timeoutMs + FIRST_PROGRESS_GRACE_MS : timeoutMs;
        this.timeoutHandle = setTimeout(() => {
          if (!isCurrent()) {
            return;
          }
          this.socks = null;
          this.setState('offline');
          void this.stopBackendIfRunning();
          settle('offline');
        }, budget);
      };

      this.unsubscribeBackend = this.backend.subscribe(event => {
        if (!isCurrent()) {
          return; // event from a superseded attempt — ignore
        }
        if (event.kind === 'verified') {
          // Deferred reachability verdict: the transport carries real streams. No state change —
          // we are already 'connected' — just let the ladder record the rung warm.
          this.notifyReach(true);
          return;
        }
        if (event.kind === 'transport-dead') {
          // Bootstrap lied off a cached consensus; no circuit exists. Notify BEFORE the state
          // flip so the ladder marks the rung dead before the offline retry machinery (App.tsx
          // onChange('offline') → scheduleRetry) starts the next walk. Unlike 'error' — whose
          // native failure paths tear the daemon down themselves — the daemon here is RUNNING
          // (bootstrapped, SOCKS bound), so stop it, or the next rung's client races its
          // state-directory lock. No settle(): this verdict only ever arrives after 'connected'
          // has settled the attempt; were the contract ever violated, the no-progress deadline
          // still ends the attempt.
          this.notifyReach(false, event.message);
          this.socks = null;
          void this.stopBackendIfRunning();
          this.setState('offline');
          return;
        }
        // Once connected, ignore stray 'bootstrapping' events. They arrive from a late
        // TorService STATUS broadcast (the native fast-path receiver maps STATUS_ON→95%,
        // STATUS_STARTING→50%) or a post-100% control line, and do NOT mean the circuit
        // dropped — only 'error'/'stopped' do. Letting them through would flip the UI back to
        // "Connecting…" while Tor is actually online and the relay is streaming.
        if (event.kind === 'bootstrapping' && this.state === 'connected') {
          return;
        }
        if (event.kind === 'bootstrapping') {
          // Attribute the gap since the previous line to the phase we were IN (see
          // ./bootstrapTiming). Purely observational — it reads no state and changes none.
          // One clock read shared by both calls: two reads would double-consume an injected clock
          // and desynchronise the recorded instants from the recorded phase durations.
          const at = now();
          // First write wins inside mark(), so this records only the FIRST percent line — the
          // boundary that separates "we were waiting on the daemon" from "tor is working".
          timeline.mark('first-progress', at);
          timeline.sample(event.percent, at, event.summary);
          this.setBootstrap({percent: event.percent, summary: event.summary});
          if (event.percent > lastPercent) {
            lastPercent = event.percent;
            armTimeout(); // forward progress — reset the no-progress deadline
          }
        }
        if (event.kind === 'connected') {
          this.socks = event.socks;
          // Capture the daemon's reported version, if any, for getTorVersion(). StiqArtiModule
          // never populates torVersion on its 'connected' event (that was a C-tor/tor-android
          // concept — see the removed torVersion.ts's >=0.4.8 onion-service PoW guard), so this is
          // always null under Arti; kept only so getTorVersion() stays meaningful if a future
          // backend ever does report one.
          this.torVersion = event.torVersion ?? null;
          // A live circuit is 100% by definition — pin the bar there before flipping state so the
          // connecting screen lands on a full bar, not whatever partial percent arrived last.
          this.setBootstrap({percent: 100, summary: this.bootstrap?.summary});
        }
        this.setState(eventToState(event));
        if (event.kind === 'connected') {
          settle('connected');
        } else if (event.kind === 'error') {
          this.socks = null;
          settle('offline');
        }
      });

      armTimeout();

      this.setState('starting-tor');
      // From here on a daemon may exist, so the next stop() must reach the backend. Set BEFORE the
      // start call: if start() throws we still want the teardown to run, since a partially started
      // daemon is exactly the case that needs stopping.
      this.backendMaybeRunning = true;
      // Split the otherwise-opaque `launch` phase. `native-start` is the JS→native handoff;
      // `native-ready` is when startTor() resolves, i.e. AFTER the native teardown barrier (up to
      // 12s), the always-on PT warm-up (~1.5s settle, run even in 'direct' mode) and the
      // TorService bind. Without these two instants a slow launch is unattributable — you cannot
      // tell a wedged prior daemon from a slow PT from tor simply being quiet.
      timeline.mark('native-start', now());
      // ONE start call, two observers attached to the same promise. Calling start() twice would
      // launch two daemons.
      const started = this.backend.start(config);
      // Mark on either outcome, so a FAILED launch is as attributable as a successful one. Passing
      // the handler as both arguments keeps this branch from surfacing an unhandled rejection; the
      // real failure handling stays in the .catch() below.
      const markNativeReady = (): void => timeline.mark('native-ready', now());
      started.then(markNativeReady, markNativeReady);
      started.catch(() => {
        if (!isCurrent()) {
          return;
        }
        this.socks = null;
        this.setState('offline');
        settle('offline');
      });
    });
  }

  /**
   * Install the CURRENT reach credentials — resolved exactly the way connect() resolves them —
   * into the LIVE daemon, without a restart, and kick the deferred reachability verification.
   *
   * This is the second half of an EARLY start: connect() may now run before the app runtime has
   * hydrated the active community (its resolvers yield nothing, so the daemon bootstraps
   * credential-less — bootstrap never needs one). When hydration lands, this installs the real
   * credential into Arti's keystore, which Arti consults at DESCRIPTOR-FETCH time — the
   * "must restart Tor to load a key" rule was C-tor's ClientOnionAuthDir semantics and is dead.
   *
   * Returns true when the resolved credentials are now active on the live daemon (so
   * isOnionAuthActive() answers for them); false when there is no live daemon, the backend
   * predates installReach, or the native install failed — callers fall back to the restart path
   * they always used.
   */
  async installReach(): Promise<boolean> {
    if (this.state !== 'connected' || !this.backend.installReach) {
      return false;
    }
    const auth = this.options.resolveOnionAuth
      ? this.options.resolveOnionAuth() ?? undefined
      : this.options.onionAuth;
    const extra = this.options.resolveOnionAuthExtra
      ? this.options.resolveOnionAuthExtra() ?? undefined
      : this.options.onionAuthExtra;
    // Same precedence chain as connect() — see the block comment there.
    const relayOnion =
      relayOnionHostOf(this.options.resolveRelayOnion?.()) ??
      relayOnionHostOf(this.options.relayOnion) ??
      getActiveRelayOnion() ??
      auth?.onionHost;
    try {
      await this.backend.installReach({onionAuth: auth, onionAuthExtra: extra, relayOnion});
    } catch {
      return false;
    }
    this.configuredOnionAuth = auth ?? null;
    this.configuredOnionAuthSet = [...(auth ? [auth] : []), ...(extra ?? [])];
    return true;
  }

  /**
   * Stop the backend, but only when a daemon we started might actually be up. Collapses the
   * redundant teardown the connect cascade used to emit: a direct-Tor timeout already stops the
   * backend from inside connect()'s timeout handler, then App.tsx's cascade calls disconnect()
   * right after it, then walks to a bridge tier that has no bridges to dial and disconnect()s
   * again — three serialized native stopTor() calls, two of them against a daemon that was already
   * down, before the next transport could even start.
   *
   * Deliberately NOT `async`: it returns the backend's promise directly so that awaiting this is
   * microtask-for-microtask identical to awaiting `backend.stop()` inline, as every call site used
   * to. An async wrapper adds a hop, which is enough to let a caller's next synchronous step land
   * before the awaiting attempt has re-subscribed to the backend.
   */
  private stopBackendIfRunning(): Promise<void> {
    if (!this.backendMaybeRunning) {
      return Promise.resolve();
    }
    this.backendMaybeRunning = false;
    return this.backend.stop().catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    // Supersede invalidates any in-flight connect (releasing its promise and silencing its
    // events) so a deliberate disconnect can't be undone by an attempt that was mid-flight.
    this.supersede('disconnected');
    this.socks = null;
    // Drop the captured version too, so a stale value can't linger across reconnects.
    this.torVersion = null;
    await this.stopBackendIfRunning();
    this.setState('disconnected');
  }

  /**
   * End the current attempt: clear its timeout, remove its backend subscription, release any
   * pending connect() promise with `release`, and bump the generation so any late event or
   * timer from that attempt becomes a no-op. Returns the new generation for the next attempt.
   */
  private supersede(release: ConnectionState): number {
    this.clearTimeout();
    this.unsubscribeBackend?.();
    this.unsubscribeBackend = undefined;
    // A new (or torn-down) attempt starts from a clean bar: drop stale progress so the next
    // bootstrap reports from zero rather than briefly showing the prior attempt's percent.
    this.bootstrap = null;
    const release_ = this.releaseInFlight;
    this.releaseInFlight = undefined;
    const gen = ++this.generation;
    release_?.(release);
    return gen;
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /** Store + broadcast the latest bootstrap progress to onBootstrap subscribers. */
  private setBootstrap(next: BootstrapProgress): void {
    this.bootstrap = next;
    for (const listener of this.progressListeners) {
      listener(next);
    }
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== undefined) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }
}

/**
 * The single chokepoint for obtaining a transport. Throws unless Tor is connected — used
 * by the WebSocket layer so there is exactly one way to reach the relay, and it is Tor.
 */
export function requireTorTransport(manager: TorManager): SocksProxy {
  const socks = manager.getSocksProxy();
  if (!socks) {
    throw new Error('offline: no Tor circuit; refusing any non-Tor connection');
  }
  return socks;
}

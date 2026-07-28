/**
 * Relay reconnect backoff — a pure schedule extracted so App.tsx's reconnect loop stays a thin
 * wrapper and the timing policy is unit-testable in isolation.
 *
 * A dead onion circuit over a throttled network fails within seconds. The old fixed 3s retry both
 * hammered the relay and churned half-built Tor circuits during an outage. Capped exponential
 * backoff keyed on the consecutive-failure streak lets a persistent outage settle into an
 * infrequent poll while keeping a fast first retry after any success (the streak resets to 0).
 */
export const RELAY_BACKOFF_BASE_MS = 5_000;
export const RELAY_BACKOFF_MAX_MS = 60_000;

/**
 * Delay before the next reconnect attempt given the current consecutive-failure `streak` (1 = the
 * first failure). Doubles from BASE up to MAX: 5s, 10s, 20s, 40s, 60s (capped), 60s, …
 * A streak of 0 (or less) — i.e. right after a success — yields the base delay.
 *
 * To avoid thundering-herd reconnections (all clients reconnecting simultaneously after a relay
 * outage), the delay includes +/-20% jitter: final = MIN(MAX, base * (0.8 + 0.4 * rng())).
 * The optional `rng` parameter is a function returning [0, 1) for testability; it defaults to
 * Math.random() for production.
 *
 * RESET CONTRACT for every caller that keeps its OWN `streak` (and any `nextAttemptAt` deadline
 * computed from this function's return value) outside this module — e.g. App.tsx's
 * `relayFailureStreak` / `nextRelayAttemptAt` closure state driving the PRIMARY relay socket, or a
 * per-url streak keyed externally (see MirrorSet.ts's `preConnectFailureStreak` /
 * `ChildEntry.failureStreak` for secondaries): the streak must be reset to 0 the INSTANT a fresh,
 * independent, more-recent signal proves the transport is healthy again — not just on the caller's
 * own next successful connect.
 *
 * MEASURED ON DEVICE (2026-07-27): after Tor reconnected, the relay was not re-dialled for ~90s.
 * Cause: App.tsx's `manager.onChange('connected')` handler calls `startRelay()` directly (the socket
 * having gone `null` while Tor itself was down), and `startRelay()` only consults its backoff floor
 * `nextRelayAttemptAt` while `relayFailureStreak > 0` — but that ONE call site was the only caller of
 * `startRelay()` that did not reset the streak first. A streak built from failures dialling THROUGH
 * Tor says nothing about whether Tor itself just now regained a circuit; honouring it there re-stales
 * the app for up to RELAY_BACKOFF_MAX_MS after every single Tor recovery, silently, with no further
 * signal to break out of it before the stale floor's own deadline. Every OTHER place this codebase
 * resets a relay failure streak (a community switch, an applied Tor-mode change, a network-change
 * bounce — all in App.tsx) already zeroes it inline (`relayFailureStreak = 0`) at the point of reset;
 * there is deliberately no stateful helper exported here for that — the state lives entirely in the
 * caller's closure, so a bare, grep-able `= 0` at the Tor-'connected' call site (immediately before
 * its `startRelay()` call) is the fix, matching the existing sites rather than inventing a new shape
 * for this one. Resetting `relayFailureStreak` alone is sufficient: `startRelay()`'s backoff-floor
 * check is gated on `streak > 0`, so zeroing the streak makes the stale `nextRelayAttemptAt` moot
 * without needing to also touch it (though clearing both is more defensive against future refactors
 * of that gate).
 */
export function relayBackoffMs(streak: number, rng: () => number = Math.random): number {
  const base = Math.min(RELAY_BACKOFF_MAX_MS, RELAY_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));
  return Math.min(RELAY_BACKOFF_MAX_MS, base * (0.8 + 0.4 * rng()));
}

/**
 * Requesting a fresh circuit on every fast failure churns half-built circuits, so rotate only every
 * Nth failure instead. Under C-tor this restraint doubled as respecting Tor's own ~once/10s NEWNYM
 * rate limit; Arti's equivalent (`arti_new_identity()` → `retire_all_circuits()`, arti-ffi/src/lib.rs)
 * has NO rate limit at all — every call fully executes and immediately retires every onion circuit,
 * so over-rotating is now fully self-inflicted rather than harmlessly throttled away. With N=2 and a
 * streak incremented before the check, this fires on every other attempt once rotation has started.
 */
export const RELAY_NEWNYM_EVERY = 2;

/**
 * Consecutive failures tolerated BEFORE the first circuit rotation.
 *
 * Rotating used to start at failure #1, which was actively counter-productive for the case it was
 * meant to help. NEWNYM-equivalent rotation drops the client's hidden-service DESCRIPTOR cache along
 * with half-built circuits, so rotating early throws away the descriptor fetch that the very next
 * dial needs and forces it to start over — each rotation making the following attempt slower, not
 * fresher. Early failures against an onion are usually "the descriptor isn't here yet", which a retry
 * fixes and a rotation actively sabotages. A rotation only earns its cost once several attempts have
 * failed, which is real evidence the circuit itself is bad rather than merely young.
 *
 * This is also the policy `requestNewTorCircuit` (App.tsx) already follows for the keep-alive path:
 * do NOT rotate on every failure — that doesn't refresh a live circuit and only costs reachability by
 * retiring circuits that were about to succeed. Arti's `arti_new_identity()` (arti-ffi/src/lib.rs)
 * has no rate limit of its own to lean on here (every call fully executes and retires ALL onion
 * circuits — see RELAY_NEWNYM_EVERY's doc above), so this app-level restraint is the ONLY thing
 * standing between a fast failure streak and needlessly destroying a circuit that was still warming
 * up. The reconnect path honours the same policy.
 */
export const RELAY_NEWNYM_AFTER = 2;

/**
 * Whether to request a fresh Tor circuit for this failure `streak` (1 = the first failure).
 * Rotates on the 3rd, 5th, 7th, … failure: nothing early, then every other attempt.
 */
export function shouldRotateCircuit(streak: number): boolean {
  if (streak <= RELAY_NEWNYM_AFTER) {
    return false;
  }
  return (streak - RELAY_NEWNYM_AFTER) % RELAY_NEWNYM_EVERY === 1;
}

/** Consecutive failed relay connections before a transport may be condemned. */
export const ESCALATE_MIN_STREAK = 4;

/**
 * How long a transport must have been connected before onion-rendezvous failures may condemn it.
 *
 * 90s. Onion rendezvous failures come back in ~1-2s, so a streak of 4 can accumulate in ~16s of
 * wall clock — which is what let a direct transport that had bootstrapped in 4.3s be torn down and
 * walked to snowflake, turning a 4-second connection into 4m16s. Roughly what the 5/10/20/40s
 * backoff takes to reach a streak of 4 anyway, so in the normal case this gate is redundant and it
 * only bites when something dials faster than the backoff intends.
 */
export const ESCALATE_MIN_SETTLED_MS = 90_000;

export interface TransportCondemnedInput {
  /** Consecutive relay connections that died without delivering data. */
  streak: number;
  /** How long the current transport has been 'connected' (0 if it isn't). */
  transportSettledMs: number;
  /** Whether Tor itself still reports connected — i.e. the TRANSPORT is fine. */
  torConnected: boolean;
}

/**
 * Whether repeated onion-rendezvous failure is now strong enough evidence to blame the TRANSPORT
 * and fall back to a more evasive one.
 *
 * Transport health ("can I reach the Tor network") and onion reachability ("can I rendezvous with
 * THIS service") are different signals, and the bug this encodes against was letting them share one
 * 16-second fuse. Escalating is still correct when a network genuinely allows Tor but throttles
 * rendezvous — that just cannot be concluded in 16 seconds.
 *
 * Both gates are required because they prove different things: the streak proves repeated failure,
 * the window proves it persisted. The streak alone is exactly what misfired on device; the window
 * alone would condemn a transport on a single unlucky failure.
 *
 * `torConnected` is what makes this a RENDEZVOUS verdict rather than a transport one: if Tor itself
 * has dropped, the relay failures are explained by that and escalating would be blaming the wrong
 * layer — the reconnect cascade handles it instead.
 */
export function isTransportCondemned(input: TransportCondemnedInput): boolean {
  return (
    input.torConnected &&
    input.streak >= ESCALATE_MIN_STREAK &&
    input.transportSettledMs >= ESCALATE_MIN_SETTLED_MS
  );
}

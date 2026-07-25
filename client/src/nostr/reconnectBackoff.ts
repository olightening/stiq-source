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
 */
export function relayBackoffMs(streak: number, rng: () => number = Math.random): number {
  const base = Math.min(RELAY_BACKOFF_MAX_MS, RELAY_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));
  return Math.min(RELAY_BACKOFF_MAX_MS, base * (0.8 + 0.4 * rng()));
}

/**
 * Tor rate-limits NEWNYM to roughly once per 10s, so requesting a fresh circuit on every fast
 * failure wastes the rotation (Tor ignores it) and churns half-built circuits. Rotate only every
 * Nth failure. With N=2 and a streak incremented before the check, this fires on every other
 * attempt once rotation has started.
 */
export const RELAY_NEWNYM_EVERY = 2;

/**
 * Consecutive failures tolerated BEFORE the first circuit rotation.
 *
 * Rotating used to start at failure #1, which was actively counter-productive for the case it was
 * meant to help. NEWNYM drops the client's hidden-service DESCRIPTOR cache along with half-built
 * circuits, so rotating early throws away the descriptor fetch that the very next dial needs and
 * forces it to start over — each rotation making the following attempt slower, not fresher. Early
 * failures against an onion are usually "the descriptor isn't here yet", which a retry fixes and a
 * rotation actively sabotages. A rotation only earns its cost once several attempts have failed,
 * which is real evidence the circuit itself is bad rather than merely young.
 *
 * This is also what the torrc built in StiqTorModule already says about the keep-alive path: "we
 * deliberately do NOT spam SIGNAL NEWNYM — that doesn't refresh a live circuit and only costs
 * reachability." The reconnect path now honours the same policy.
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

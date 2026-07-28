import {
  relayBackoffMs,
  shouldRotateCircuit,
  isTransportCondemned,
  RELAY_BACKOFF_BASE_MS,
  RELAY_BACKOFF_MAX_MS,
  RELAY_NEWNYM_EVERY,
  ESCALATE_MIN_SETTLED_MS,
} from './reconnectBackoff';

describe('relayBackoffMs', () => {
  it('doubles from the base delay and caps at the max (deterministic with fixed rng)', () => {
    // With rng() = 0.5 (middle of jitter range), the formula is:
    // final = MIN(MAX, base * (0.8 + 0.4 * 0.5)) = MIN(MAX, base * 1.0) = base (no jitter effect).
    // So we get the deterministic schedule: streak 1→5s, 2→10s, 3→20s, 4→40s, 5→60s(cap), 6+→60s.
    const fixed = () => 0.5;
    expect(relayBackoffMs(1, fixed)).toBe(5_000);
    expect(relayBackoffMs(2, fixed)).toBe(10_000);
    expect(relayBackoffMs(3, fixed)).toBe(20_000);
    expect(relayBackoffMs(4, fixed)).toBe(40_000);
    expect(relayBackoffMs(5, fixed)).toBe(RELAY_BACKOFF_MAX_MS);
    expect(relayBackoffMs(6, fixed)).toBe(RELAY_BACKOFF_MAX_MS);
    expect(relayBackoffMs(20, fixed)).toBe(RELAY_BACKOFF_MAX_MS);
  });

  it('applies +/-20% jitter around each base delay', () => {
    // Jitter range is [base * 0.8, base * 1.2] (from the formula 0.8 + 0.4 * [0, 1)).
    // rng=0 gives min (0.8x), rng=1 would give 1.2x (but unreachable since rng < 1).
    const rngMin = () => 0;
    const rngMax = () => 0.99999;

    // Streak 1: base 5000ms, range [4000, 6000).
    expect(relayBackoffMs(1, rngMin)).toBe(4_000);
    expect(relayBackoffMs(1, rngMax)).toBeLessThan(6_000);
    expect(relayBackoffMs(1, rngMax)).toBeGreaterThan(5_999); // very close to 6000

    // Streak 2: base 10000ms, range [8000, 12000).
    expect(relayBackoffMs(2, rngMin)).toBe(8_000);
    expect(relayBackoffMs(2, rngMax)).toBeLessThan(12_000);

    // Streak 3: base 20000ms, range [16000, 24000).
    expect(relayBackoffMs(3, rngMin)).toBe(16_000);
    expect(relayBackoffMs(3, rngMax)).toBeLessThan(24_000);

    // Streak 4: base 40000ms, range [32000, 48000).
    expect(relayBackoffMs(4, rngMin)).toBe(32_000);
    expect(relayBackoffMs(4, rngMax)).toBeLessThan(48_000);
  });

  it('caps jitter at RELAY_BACKOFF_MAX_MS when the base is already capped', () => {
    // Streak 5+: base is capped at 60000ms, so jitter range is [48000, 60000).
    const rngMin = () => 0;
    const rngMax = () => 0.99999;

    expect(relayBackoffMs(5, rngMin)).toBe(48_000);
    expect(relayBackoffMs(5, rngMax)).toBeLessThanOrEqual(RELAY_BACKOFF_MAX_MS);

    expect(relayBackoffMs(6, rngMin)).toBe(48_000);
    expect(relayBackoffMs(6, rngMax)).toBeLessThanOrEqual(RELAY_BACKOFF_MAX_MS);

    expect(relayBackoffMs(20, rngMin)).toBe(48_000);
    expect(relayBackoffMs(20, rngMax)).toBeLessThanOrEqual(RELAY_BACKOFF_MAX_MS);
  });

  it('yields the base delay (with jitter) for a reset (0 / negative) streak — fast first retry after success', () => {
    // Base for streak 0/negative is RELAY_BACKOFF_BASE_MS = 5000.
    // With rng 0.5, we get 5000 * 1.0 = 5000 (middle of jitter).
    const fixed = () => 0.5;
    expect(relayBackoffMs(0, fixed)).toBe(RELAY_BACKOFF_BASE_MS);
    expect(relayBackoffMs(-3, fixed)).toBe(RELAY_BACKOFF_BASE_MS);

    // With jitter: rng=0 gives 4000, rng~1 gives ~6000.
    const rngMin = () => 0;
    const rngMax = () => 0.99999;
    expect(relayBackoffMs(0, rngMin)).toBe(4_000);
    expect(relayBackoffMs(0, rngMax)).toBeLessThan(6_000);
  });

  it('never exceeds the cap and jitter preserves monotonic non-decreasing tendency', () => {
    const rngMid = () => 0.5; // deterministic middle value
    let prev = 0;
    for (let streak = 1; streak <= 12; streak++) {
      const d = relayBackoffMs(streak, rngMid);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(RELAY_BACKOFF_MAX_MS);
      prev = d;
    }
  });

  it('defaults to Math.random when rng is not provided', () => {
    // Call without rng parameter; should not throw and return a value in valid range.
    const d = relayBackoffMs(1);
    expect(d).toBeGreaterThanOrEqual(4_000); // 5000 * 0.8
    expect(d).toBeLessThanOrEqual(6_000); // 5000 * 1.2
  });
});

describe('shouldRotateCircuit (NEWNYM every Nth failure)', () => {
  it('does NOT rotate on the early failures — NEWNYM drops the descriptor cache', () => {
    // The regression this locks: rotating at streak 1 threw away the hidden-service descriptor the
    // next dial needed, making each retry slower instead of fresher.
    expect(shouldRotateCircuit(1)).toBe(false);
    expect(shouldRotateCircuit(2)).toBe(false);
  });

  it('rotates from the 3rd failure, then every other one', () => {
    // streak is incremented before the check, so: 1 no, 2 no, 3 yes, 4 no, 5 yes, …
    expect([1, 2, 3, 4, 5, 6, 7].map(shouldRotateCircuit)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('never rotates twice in a row, so a just-rotated circuit is never retired before it can be used', () => {
    const rotations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(shouldRotateCircuit);
    let previous: number | undefined;
    for (const streak of rotations) {
      if (previous !== undefined) {
        expect(streak - previous).toBeGreaterThanOrEqual(RELAY_NEWNYM_EVERY);
      }
      previous = streak;
    }
  });
});

describe('isTransportCondemned (blame the transport for onion failures?)', () => {
  const settled = {streak: 4, transportSettledMs: ESCALATE_MIN_SETTLED_MS, torConnected: true};

  it('condemns a transport that has failed repeatedly over a real window', () => {
    expect(isTransportCondemned(settled)).toBe(true);
  });

  it('THE DEVICE REGRESSION: does not condemn a transport over a fast burst of failures', () => {
    // Verbatim from the logcat this fix exists for: direct Tor bootstrapped in 4.26s, then four
    // rendezvous failures landed within 16.4s and tore it down, walking the ladder to snowflake —
    // 4m16s to usable. The streak alone said "escalate"; the elapsed window is what says "wait".
    expect(isTransportCondemned({streak: 4, transportSettledMs: 16_400, torConnected: true})).toBe(
      false,
    );
  });

  it('requires BOTH the streak and the window — neither alone condemns', () => {
    expect(isTransportCondemned({...settled, streak: 3})).toBe(false);
    expect(isTransportCondemned({...settled, transportSettledMs: ESCALATE_MIN_SETTLED_MS - 1})).toBe(
      false,
    );
  });

  it('never condemns the transport when Tor itself has dropped', () => {
    // Relay failures are fully explained by Tor being down; the reconnect cascade owns that case,
    // and escalating here would blame the transport for someone else's outage.
    expect(isTransportCondemned({...settled, torConnected: false})).toBe(false);
    expect(
      isTransportCondemned({streak: 99, transportSettledMs: 600_000, torConnected: false}),
    ).toBe(false);
  });

  it('still condemns a genuinely rendezvous-throttled network, just not in 16 seconds', () => {
    // The escalation mechanism is not being defanged: a network that allows Tor but throttles onion
    // rendezvous must still fall back to a more evasive transport. It just has to prove it first.
    expect(
      isTransportCondemned({streak: 8, transportSettledMs: 300_000, torConnected: true}),
    ).toBe(true);
  });
});

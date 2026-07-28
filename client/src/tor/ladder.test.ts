import {
  AUTO_LADDER,
  CEILING_EXHAUSTED_LABEL,
  describePhase,
  nextRungIndex,
  type PhaseKind,
} from './ladder';

describe('AUTO_LADDER shape', () => {
  it('is exactly direct → obfs4-bundled → fetched-bridges → snowflake-bundled', () => {
    expect(AUTO_LADDER.map(r => r.id)).toEqual([
      'direct',
      'obfs4-bundled',
      'fetched-bridges',
      'snowflake-bundled',
    ]);
    // Snowflake is the last rung — the reaches-where-others-are-blocked resort — so the guided auto
    // cascade the DEFAULT preset walks does not exhaust without ever trying the one transport built
    // to survive a network where every IP-addressed bridge is blocked.
    expect(AUTO_LADDER[AUTO_LADDER.length - 1]!.transport).toBe('snowflake');
  });

  it('maps each rung to the expected transport + fetched-bridge flag', () => {
    expect(AUTO_LADDER.map(r => [r.transport, r.useFetchedBridges])).toEqual([
      ['direct', false],
      ['obfs4', false],
      ['webtunnel', true],
      // Snowflake is bundled (useFetchedBridges=false): DEFAULT_SNOWFLAKE_BRIDGES already carries the
      // broker/front/ICE config, so the rung dials with no moat round-trip — resolved through
      // defaultBridgeLines('snowflake') by connectGuided()'s cold walk exactly like the obfs4 rung.
      ['snowflake', false],
    ]);
  });

  it('keeps noProgressMs strictly less than hardCeilingMs on every rung', () => {
    for (const rung of AUTO_LADDER) {
      expect(rung.noProgressMs).toBeLessThan(rung.hardCeilingMs);
    }
  });

  it('gives every rung a non-empty stiq-authored label', () => {
    for (const rung of AUTO_LADDER) {
      expect(rung.label.length).toBeGreaterThan(0);
    }
  });
});

describe('describePhase', () => {
  const direct = AUTO_LADDER[0]!; // 'direct', rungIndex 0
  const obfs4 = AUTO_LADDER[1]!; // 'obfs4-bundled', rungIndex 1

  it('fills rungIndex/totalRungs from AUTO_LADDER position', () => {
    const phase = describePhase(direct, 'starting');
    expect(phase.rungId).toBe('direct');
    expect(phase.rungIndex).toBe(0);
    expect(phase.totalRungs).toBe(AUTO_LADDER.length);

    expect(describePhase(obfs4, 'starting').rungIndex).toBe(1);
  });

  it("uses the rung label for 'starting' with no percent suffix", () => {
    const phase = describePhase(direct, 'starting');
    expect(phase.plainLabel).toBe('Connecting directly through Tor');
  });

  it("appends a rounded percent for 'bootstrapping' when percent > 0", () => {
    expect(describePhase(direct, 'bootstrapping', 42.6).plainLabel).toBe(
      'Connecting directly through Tor · 43%',
    );
  });

  it("omits the percent suffix when percent is 0 or undefined", () => {
    expect(describePhase(direct, 'bootstrapping', 0).plainLabel).toBe(
      'Connecting directly through Tor',
    );
    expect(describePhase(direct, 'bootstrapping').plainLabel).toBe(
      'Connecting directly through Tor',
    );
  });

  it("says the rung 'is taking too long' on ceiling-exceeded", () => {
    expect(describePhase(direct, 'ceiling-exceeded').plainLabel).toBe(
      'Connecting directly through Tor is taking too long',
    );
  });

  it('has fixed wording for escalating / connected / exhausted', () => {
    expect(describePhase(direct, 'escalating').plainLabel).toBe(
      'Switching to a harder-to-block path…',
    );
    expect(describePhase(direct, 'connected').plainLabel).toBe('Connected via Tor');
    expect(describePhase(direct, 'exhausted').plainLabel).toBe(CEILING_EXHAUSTED_LABEL);
  });

  it("never leaks a caller's Tor bootstrap summary into plainLabel", () => {
    // describePhase takes no summary argument by design; even so, assert that a raw Tor
    // summary string can never appear in the output for any kind.
    const fakeTorSummary = 'Loading relay descriptors';
    const kinds: PhaseKind[] = [
      'starting',
      'bootstrapping',
      'ceiling-exceeded',
      'escalating',
      'connected',
      'exhausted',
    ];
    for (const rung of AUTO_LADDER) {
      for (const kind of kinds) {
        expect(describePhase(rung, kind, 55).plainLabel).not.toContain(fakeTorSummary);
      }
    }
  });

  it('threads the percent value through onto the phase object', () => {
    expect(describePhase(direct, 'bootstrapping', 30).percent).toBe(30);
  });
});

describe('nextRungIndex', () => {
  it('increments within the ladder', () => {
    expect(nextRungIndex(0)).toBe(1);
    expect(nextRungIndex(1)).toBe(2);
  });

  it('returns -1 past the last rung (exhaustion, not wraparound)', () => {
    const last = AUTO_LADDER.length - 1;
    expect(nextRungIndex(last)).toBe(-1);
  });

  it('honors an explicit total override', () => {
    expect(nextRungIndex(0, 1)).toBe(-1);
    expect(nextRungIndex(0, 2)).toBe(1);
  });

  // Regression lock for the exact order App.tsx connectGuided()'s cold walk depends on: it steps
  // `for (let i = 0; i !== -1; i = nextRungIndex(i))` over AUTO_LADDER, so walking from 0 must yield
  // direct → obfs4-bundled → fetched-bridges → snowflake-bundled and then terminate on -1 (never
  // wrap around).
  it('walks the full guided sequence from 0 then exhausts to -1', () => {
    const walked: string[] = [];
    for (let i = 0; i !== -1; i = nextRungIndex(i)) {
      walked.push(AUTO_LADDER[i]!.id);
    }
    expect(walked).toEqual([
      'direct',
      'obfs4-bundled',
      'fetched-bridges',
      'snowflake-bundled',
    ]);
    expect(nextRungIndex(AUTO_LADDER.length - 1)).toBe(-1);
  });
});

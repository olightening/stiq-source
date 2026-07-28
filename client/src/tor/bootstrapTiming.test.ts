import {
  BOOTSTRAP_PHASES,
  createBootstrapTimeline,
  phaseForPercent,
} from './bootstrapTiming';

describe('BOOTSTRAP_PHASES shape', () => {
  it('is the five ordered phases, ending at 100', () => {
    expect(BOOTSTRAP_PHASES.map(p => p.id)).toEqual([
      'connect',
      'consensus',
      'certs',
      'descriptors',
      'finalize',
    ]);
    expect(BOOTSTRAP_PHASES.at(-1)?.upTo).toBe(100);
  });

  it('covers 0..100 contiguously with strictly increasing bounds', () => {
    let prev = -1;
    for (const phase of BOOTSTRAP_PHASES) {
      expect(phase.upTo).toBeGreaterThan(prev);
      prev = phase.upTo;
    }
    // every percent in 0..100 resolves to exactly one phase
    for (let pct = 0; pct <= 100; pct++) {
      expect(phaseForPercent(pct)).toBeDefined();
    }
  });
});

describe('phaseForPercent', () => {
  it('maps Arti’s real bootstrap bands to the right phase', () => {
    // 0-14: establishing the first connection (conn_status*0.15 dominates here)
    expect(phaseForPercent(0).id).toBe('connect');
    expect(phaseForPercent(14).id).toBe('connect');
    // 15-20: directory reachable, consensus downloading — includes the ~100s 15%-plateau
    expect(phaseForPercent(15).id).toBe('consensus');
    expect(phaseForPercent(20).id).toBe('consensus');
    // 21-30: fetching authority certificates ("0/9" .. "9/9")
    expect(phaseForPercent(21).id).toBe('certs');
    expect(phaseForPercent(30).id).toBe('certs');
    // 31-89: fetching relay descriptors/microdescriptors through "directory is usable"
    expect(phaseForPercent(31).id).toBe('descriptors');
    expect(phaseForPercent(89).id).toBe('descriptors');
    // 90-100: connected / finalizing
    expect(phaseForPercent(90).id).toBe('finalize');
    expect(phaseForPercent(100).id).toBe('finalize');
  });

  it('clamps out-of-range percents instead of returning undefined', () => {
    expect(phaseForPercent(-5).id).toBe('connect');
    expect(phaseForPercent(999).id).toBe('finalize');
  });
});

describe('createBootstrapTimeline', () => {
  it('charges elapsed wall-clock to the phase the daemon was IN, not the one it entered', () => {
    const t = createBootstrapTimeline(1000);
    // 2s spent before the first progress line ever arrives → that is connect cost.
    t.sample(16, 3000);
    // 1s spent waiting on the consensus download.
    t.sample(25, 4000);
    t.finish(4000);

    const byId = Object.fromEntries(t.breakdown().map(p => [p.id, p.ms]));
    expect(byId.connect).toBe(2000);
    expect(byId.consensus).toBe(1000);
  });

  it('attributes the slow consensus fetch that dominates a cold bootstrap', () => {
    const t = createBootstrapTimeline(0);
    t.sample(5, 1_000); // connect: 1s
    t.sample(15, 1_500); // connect: 0.5s more — this sample's OWN percent enters consensus, but
    // the elapsed gap it closes still belongs to the phase before it
    t.sample(21, 31_500); // consensus: 30s ← the wall (device: ~100s flat at the 15% plateau)
    t.sample(31, 33_500); // certs: 2s
    t.sample(90, 36_500); // descriptors: 3s
    t.finish(37_000); // finalize: 0.5s

    expect(t.totalMs()).toBe(37_000);
    const slowest = t.slowest();
    expect(slowest?.id).toBe('consensus');
    expect(slowest?.ms).toBe(30_000);
  });

  it('never rewinds the phase cursor when a stray lower percent arrives', () => {
    const t = createBootstrapTimeline(0);
    t.sample(50, 1_000); // → descriptors (skips consensus/certs entirely)
    t.sample(10, 2_000); // stray late STATUS broadcast; must NOT go back to connect
    t.finish(2_000);

    const byId = Object.fromEntries(t.breakdown().map(p => [p.id, p.ms]));
    // the 1s after the regression is still descriptors time, not certs time
    expect(byId.descriptors).toBe(1_000);
    expect(byId.certs).toBeUndefined();
  });

  it('attributes skipped phases to zero rather than inventing time', () => {
    const t = createBootstrapTimeline(0);
    t.sample(90, 5_000); // jumps straight from connect to finalize
    t.finish(6_000);

    expect(t.breakdown().map(p => [p.id, p.ms])).toEqual([
      ['connect', 5_000],
      ['finalize', 1_000],
    ]);
  });

  it('ignores samples that arrive after finish()', () => {
    const t = createBootstrapTimeline(0);
    t.sample(50, 1_000);
    t.finish(2_000);
    const before = t.totalMs();
    t.sample(90, 9_000);
    t.finish(9_000);
    expect(t.totalMs()).toBe(before);
  });

  it('never charges negative time when the clock skews backwards', () => {
    const t = createBootstrapTimeline(5_000);
    t.sample(50, 1_000); // now < start
    t.finish(1_000);
    expect(t.totalMs()).toBe(0);
    for (const phase of t.breakdown()) {
      expect(phase.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('omits phases that consumed no time from the breakdown', () => {
    const t = createBootstrapTimeline(0);
    t.sample(15, 0); // connect took literally nothing
    t.sample(21, 1_000);
    t.finish(1_000);
    expect(t.breakdown().map(p => p.id)).toEqual(['consensus']);
  });

  it('formats a compact one-liner that flags the slowest phase', () => {
    const t = createBootstrapTimeline(0);
    t.sample(15, 1_000);
    t.sample(50, 21_000);
    t.finish(21_500);

    const line = t.format();
    expect(line).toContain('21.5s total');
    expect(line).toContain('consensus 20.0s');
    // the dominant phase is marked so a log reader sees the culprit immediately
    expect(line).toMatch(/consensus 20\.0s[^·]*←/);
  });

  it('reports no slowest phase before any time has been recorded', () => {
    const t = createBootstrapTimeline(0);
    expect(t.slowest()).toBeNull();
    expect(t.breakdown()).toEqual([]);
    expect(t.totalMs()).toBe(0);
  });
});

describe('timeline marks', () => {
  it('records named instants relative to the start of the attempt', () => {
    const t = createBootstrapTimeline(1_000);
    t.mark('native-start', 1_200);
    t.mark('native-ready', 13_600);
    expect(t.marks()).toEqual([
      {name: 'native-start', atMs: 200},
      {name: 'native-ready', atMs: 12_600},
    ]);
  });

  it('decomposes an opaque connect phase into barrier vs daemon time', () => {
    // The exact case that makes a bare "connect 14.0s" useless: is it the teardown barrier,
    // the unused-PT warm-up, or tor itself being slow to say anything?
    const t = createBootstrapTimeline(0);
    t.mark('native-start', 200); // JS handed off almost immediately
    t.mark('native-ready', 12_600); // ~12.4s inside the native barrier + PT settle
    t.sample(5, 14_000); // tor's first percent only now
    t.finish(14_000);

    expect(t.slowest()?.id).toBe('connect');
    const line = t.format();
    expect(line).toContain('connect 14.0s');
    expect(line).toContain('native-start @0.2s');
    expect(line).toContain('native-ready @12.6s');
  });

  it('keeps the FIRST occurrence when a mark name repeats', () => {
    const t = createBootstrapTimeline(0);
    t.mark('native-start', 500);
    t.mark('native-start', 9_000);
    expect(t.marks()).toEqual([{name: 'native-start', atMs: 500}]);
  });

  it('ignores marks after finish() and never records a negative instant', () => {
    const t = createBootstrapTimeline(1_000);
    t.mark('early', 0); // clock behind the start
    t.finish(2_000);
    t.mark('late', 5_000);
    expect(t.marks()).toEqual([{name: 'early', atMs: 0}]);
  });

  it('adds no suffix to format() when nothing was marked', () => {
    const t = createBootstrapTimeline(0);
    t.sample(50, 1_000);
    t.finish(1_000);
    expect(t.format()).not.toContain('@');
  });
});

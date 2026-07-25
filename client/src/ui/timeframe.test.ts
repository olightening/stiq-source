import {
  ALL_TIME,
  filterByTime,
  fmtDate,
  fmtTime,
  isActive,
  parseDateTime,
  selectionLabel,
  selectionToRange,
  type TimeSelection,
} from './timeframe';

describe('selectionToRange', () => {
  const now = 1_000_000;

  it('returns null for "all" (no filtering)', () => {
    expect(selectionToRange(ALL_TIME, now)).toBeNull();
  });

  it('anchors presets to the supplied now', () => {
    expect(selectionToRange({kind: 'preset', preset: 'hour'}, now)).toEqual({from: now - 3600, to: now});
    expect(selectionToRange({kind: 'preset', preset: 'week'}, now)).toEqual({from: now - 604800, to: now});
  });

  it('passes through a closed custom range', () => {
    expect(selectionToRange({kind: 'custom', from: 100, to: 200}, now)).toEqual({from: 100, to: 200});
  });

  it('treats an open-ended custom range (to=null) as up-to-now', () => {
    expect(selectionToRange({kind: 'custom', from: 100, to: null}, now)).toEqual({from: 100, to: now});
  });
});

describe('filterByTime', () => {
  const items = [{t: 100}, {t: 200}, {t: 300}];
  const get = (i: {t: number}): number => i.t;

  it('returns everything when the range is null', () => {
    expect(filterByTime(items, get, null)).toHaveLength(3);
  });

  it('keeps only items within the inclusive window', () => {
    expect(filterByTime(items, get, {from: 200, to: 300}).map(get)).toEqual([200, 300]);
    expect(filterByTime(items, get, {from: 150, to: 250}).map(get)).toEqual([200]);
  });
});

describe('parseDateTime', () => {
  it('parses a date at local midnight by default', () => {
    const sec = parseDateTime('2026-03-15', '');
    expect(sec).not.toBeNull();
    expect(fmtDate(sec!)).toBe('2026-03-15');
    expect(fmtTime(sec!)).toBe('00:00');
  });

  it('defaults a blank "to" time to end-of-day', () => {
    const sec = parseDateTime('2026-03-15', '', true);
    expect(fmtTime(sec!)).toBe('23:59');
  });

  it('parses an explicit time', () => {
    const sec = parseDateTime('2026-03-15', '09:30');
    expect(fmtTime(sec!)).toBe('09:30');
  });

  it('rejects malformed dates and impossible calendar days', () => {
    expect(parseDateTime('not-a-date', '')).toBeNull();
    expect(parseDateTime('2026-13-01', '')).toBeNull();
    expect(parseDateTime('2026-02-31', '')).toBeNull();
    expect(parseDateTime('2026-03-15', '25:00')).toBeNull();
  });

  it('round-trips fmtDate/fmtTime', () => {
    const sec = parseDateTime('2026-07-01', '14:05');
    expect(sec).not.toBeNull();
    expect(parseDateTime(fmtDate(sec!), fmtTime(sec!))).toBe(sec);
  });
});

describe('selectionLabel & isActive', () => {
  it('labels each selection kind', () => {
    expect(selectionLabel(ALL_TIME)).toBe('Any time');
    expect(selectionLabel({kind: 'preset', preset: 'day'})).toBe('24h');
    const from = parseDateTime('2026-01-05', '')!;
    const to = parseDateTime('2026-01-20', '')!;
    expect(selectionLabel({kind: 'custom', from, to})).toBe('Jan 5 – Jan 20');
    expect(selectionLabel({kind: 'custom', from, to: null})).toBe('Since Jan 5');
  });

  it('is active only when the selection narrows results', () => {
    const cases: [TimeSelection, boolean][] = [
      [ALL_TIME, false],
      [{kind: 'preset', preset: 'hour'}, true],
      [{kind: 'custom', from: 1, to: 2}, true],
    ];
    for (const [sel, expected] of cases) expect(isActive(sel)).toBe(expected);
  });
});

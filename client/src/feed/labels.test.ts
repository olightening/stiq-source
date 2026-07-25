import {
  DEFAULT_LABELS,
  encodeLabels,
  normalizeLabels,
  parseLabels,
  parseLabelsEvent,
  labelMetaFor,
  type LabelConfig,
} from './labels';

describe('label config', () => {
  it('seeds defaults from the five built-in labels', () => {
    expect(DEFAULT_LABELS.map(l => l.id)).toEqual([
      'insight',
      'question',
      'discussion',
      'personal',
      'fun',
    ]);
  });

  it('round-trips through the compact wire format', () => {
    expect(parseLabels(encodeLabels(DEFAULT_LABELS))).toEqual(DEFAULT_LABELS);
  });

  it('skips entries without an id and sorts by order', () => {
    const parsed = parseLabels({
      lbls: [
        {id: 'b', nm: 'B', c: '#111111', o: 1},
        {nm: 'no id', o: 0},
        {id: 'a', nm: 'A', c: '#222222', o: 0},
      ],
    });
    expect(parsed?.map(l => l.id)).toEqual(['a', 'b']);
  });

  it('returns null when the label list is absent or malformed', () => {
    expect(parseLabels({})).toBeNull();
    expect(parseLabelsEvent('not json')).toBeNull();
  });

  it('parses each label’s post-type scope (a), defaulting to all', () => {
    const parsed = parseLabels({
      lbls: [
        {id: 'tip', nm: 'Tip', c: '#111111', o: 0, a: 'article'},
        {id: 'hot', nm: 'Hot', c: '#222222', o: 1, a: 'note'},
        {id: 'any', nm: 'Any', c: '#333333', o: 2},
        {id: 'bad', nm: 'Bad', c: '#444444', o: 3, a: 'nonsense'},
      ],
    });
    expect(parsed?.map(l => l.appliesTo)).toEqual(['article', 'note', 'all', 'all']);
  });

  it('resolves a known label to an upper-cased chip', () => {
    const meta = labelMetaFor('insight', DEFAULT_LABELS);
    expect(meta.text).toBe('INSIGHT');
    expect(meta.color).toBe('#6f90c0');
  });

  it('falls back to a neutral chip for a since-deleted label', () => {
    const meta = labelMetaFor('ghost', DEFAULT_LABELS);
    expect(meta.text).toBe('GHOST');
    expect(meta.color).toBe('#8a8f98');
    expect(meta.bg).toBe('#8a8f9826');
  });
});

describe('normalizeLabels (old-shape migration)', () => {
  it('fills appliesTo on labels persisted before the field existed', () => {
    // Older app version wrote labels with no `appliesTo`; without a default every label would be
    // scoped to neither post type and the picker would render empty.
    const old = [
      {id: 'insight', name: 'Insight', color: '#111111', order: 0},
      {id: 'tip', name: 'Tip', color: '#222222', order: 1},
    ] as unknown as LabelConfig;
    expect(normalizeLabels(old)?.map(l => l.appliesTo)).toEqual(['all', 'all']);
  });

  it('coerces an unrecognized appliesTo to all and preserves valid scopes', () => {
    const messy = [
      {id: 'a', name: 'A', color: '#111111', order: 0, appliesTo: 'article'},
      {id: 'b', name: 'B', color: '#222222', order: 1, appliesTo: 'bogus'},
    ] as unknown as LabelConfig;
    expect(normalizeLabels(messy)?.map(l => l.appliesTo)).toEqual(['article', 'all']);
  });

  it('drops entries without a usable id', () => {
    const messy = [
      {id: '', name: 'blank', color: '#111', order: 0},
      {id: 'ok', name: 'Ok', color: '#222', order: 1},
    ] as unknown as LabelConfig;
    expect(normalizeLabels(messy)?.map(l => l.id)).toEqual(['ok']);
  });

  it('returns undefined for non-array input so callers keep their default set', () => {
    expect(normalizeLabels(undefined)).toBeUndefined();
    expect(normalizeLabels(null)).toBeUndefined();
  });

  it('leaves a well-formed config unchanged', () => {
    expect(normalizeLabels(DEFAULT_LABELS)).toEqual(DEFAULT_LABELS);
  });
});

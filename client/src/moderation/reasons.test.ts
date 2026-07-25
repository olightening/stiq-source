import {
  DEFAULT_REASONS,
  encodeReasons,
  parseReasons,
  parseReasonsEvent,
  bucketMetaFor,
  type ReasonsConfig,
} from './reasons';

describe('reasons parse/encode', () => {
  it('round-trips through the compact wire format', () => {
    const cfg: ReasonsConfig = {
      buckets: [
        {id: 'spam', name: 'Spam', color: '#c77b7b', order: 0},
        {id: 'rude', name: 'Rude', color: '#b5563f', order: 1},
      ],
      reportThreshold: 3,
    };
    expect(parseReasons(encodeReasons(cfg))).toEqual(cfg);
  });

  it('sorts buckets by order and skips entries without an id', () => {
    const parsed = parseReasons({
      bk: [
        {id: 'b', nm: 'B', c: '#111111', o: 1},
        {nm: 'no id', c: '#222222', o: 0},
        {id: 'a', nm: 'A', c: '#333333', o: 0},
      ],
    });
    expect(parsed?.buckets.map(b => b.id)).toEqual(['a', 'b']);
  });

  it('defaults threshold to 0 and tolerates missing names/colors', () => {
    const parsed = parseReasons({bk: [{id: 'x'}]});
    expect(parsed?.reportThreshold).toBe(0);
    expect(parsed?.buckets[0]).toMatchObject({id: 'x', name: 'x'});
  });

  it('returns null when the bucket list is absent', () => {
    expect(parseReasons({})).toBeNull();
    expect(parseReasons(null)).toBeNull();
  });

  it('parseReasonsEvent returns null on malformed JSON', () => {
    expect(parseReasonsEvent('nope')).toBeNull();
  });

  it('ships a sensible default set', () => {
    expect(DEFAULT_REASONS.buckets.length).toBeGreaterThan(0);
    expect(DEFAULT_REASONS.buckets.every(b => b.id && b.name && b.color)).toBe(true);
  });
});

describe('bucketMetaFor', () => {
  const cfg = DEFAULT_REASONS;
  it('resolves a known bucket', () => {
    expect(bucketMetaFor('spam', cfg).name).toBe('Spam');
  });
  it('falls back to the raw id with a neutral color for an unknown bucket', () => {
    const meta = bucketMetaFor('since-deleted', cfg);
    expect(meta.name).toBe('since-deleted');
    expect(meta.color).toBe('#8a8f98');
  });
  it('handles an undefined id', () => {
    expect(bucketMetaFor(undefined, cfg).id).toBe('other');
  });
});

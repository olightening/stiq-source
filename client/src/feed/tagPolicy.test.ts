import {
  DEFAULT_TAG_POLICY,
  encodeTagPolicy,
  normalizeTagPolicy,
  parseTagPolicy,
  parseTagPolicyEvent,
  type TagPolicy,
} from './tagPolicy';

describe('tagPolicy parse/encode', () => {
  it('round-trips through the compact wire format', () => {
    const policy: TagPolicy = {
      communityTags: ['news', 'help'],
      pinCommunityTags: false,
      allowMemberTags: false,
      maxTags: 3,
      tagScopes: {help: 'article', news: 'note'},
    };
    expect(parseTagPolicy(encodeTagPolicy(policy))).toEqual(policy);
  });

  it('defaults to the permissive policy for missing fields', () => {
    expect(parseTagPolicy({})).toEqual(DEFAULT_TAG_POLICY);
  });

  it('only carries non-all tag scopes on the wire (absent ⇒ all)', () => {
    const wire = encodeTagPolicy({
      ...DEFAULT_TAG_POLICY,
      communityTags: ['a', 'b'],
      tagScopes: {a: 'all', b: 'article'},
    });
    // 'a' is scoped 'all' so it is dropped from the wire; only 'b' survives.
    expect(wire.tsc).toEqual({b: 'article'});
    expect(parseTagPolicy(wire)?.tagScopes).toEqual({b: 'article'});
  });

  it('omits the tsc key entirely when no tag is scoped', () => {
    const wire = encodeTagPolicy(DEFAULT_TAG_POLICY);
    expect('tsc' in wire).toBe(false);
    expect(parseTagPolicy(wire)?.tagScopes).toEqual({});
  });

  it('ignores unrecognized scope values', () => {
    expect(parseTagPolicy({ct: ['x'], tsc: {x: 'nonsense'}})?.tagScopes).toEqual({});
  });

  it('returns null for malformed input', () => {
    expect(parseTagPolicy(null)).toBeNull();
    expect(parseTagPolicyEvent('{not json')).toBeNull();
  });
});

describe('normalizeTagPolicy (old-shape migration)', () => {
  it('fills tagScopes on a policy persisted before the field existed', () => {
    // A record written by an older app version: no `tagScopes` key at all. Using it raw crashed
    // ComposerScreen render with "Cannot convert undefined value to object".
    const old = {
      communityTags: ['news'],
      pinCommunityTags: true,
      allowMemberTags: true,
      maxTags: 0,
    } as unknown as TagPolicy;
    const fixed = normalizeTagPolicy(old);
    expect(fixed.tagScopes).toEqual({});
    expect(fixed.communityTags).toEqual(['news']);
    // The normalized policy no longer throws on a computed tagScopes lookup.
    expect(() => fixed.tagScopes['news']).not.toThrow();
  });

  it('preserves a well-formed policy', () => {
    const good: TagPolicy = {
      communityTags: ['a'],
      pinCommunityTags: false,
      allowMemberTags: false,
      maxTags: 5,
      tagScopes: {a: 'article'},
    };
    expect(normalizeTagPolicy(good)).toEqual(good);
  });

  it('returns the default for null/undefined/garbage', () => {
    expect(normalizeTagPolicy(null)).toEqual(DEFAULT_TAG_POLICY);
    expect(normalizeTagPolicy(undefined)).toEqual(DEFAULT_TAG_POLICY);
    expect(normalizeTagPolicy(42 as unknown as TagPolicy)).toEqual(DEFAULT_TAG_POLICY);
  });

  it('drops non-string community tags and clamps a bad maxTags', () => {
    const messy = {
      communityTags: ['ok', 3, null],
      maxTags: -1,
    } as unknown as TagPolicy;
    const fixed = normalizeTagPolicy(messy);
    expect(fixed.communityTags).toEqual(['ok']);
    expect(fixed.maxTags).toBe(0);
  });
});

import {
  DEFAULT_POST_RULES,
  encodePostRules,
  parsePostRules,
  parsePostRulesEvent,
  evaluatePost,
  wordCount,
  violationMessage,
  coercePostScope,
  scopeAppliesTo,
  type PostRules,
} from './postRules';

describe('postRules parse/encode', () => {
  it('round-trips through the compact wire format', () => {
    const rules: PostRules = {
      note: {min: 5, max: 200, mediaMax: 0, labelRequired: false},
      article: {min: 50, max: 1000, mediaMax: 0, labelRequired: true},
      authorNoteMax: 500,
    };
    expect(parsePostRules(encodePostRules(rules))).toEqual(rules);
  });

  it('falls back to defaults for missing fields', () => {
    expect(parsePostRules({})).toEqual(DEFAULT_POST_RULES);
    expect(parsePostRules({note: {}})).toEqual(DEFAULT_POST_RULES);
  });

  it('parses the author-note cap (anmx); 0 = unbounded, default 280', () => {
    expect(parsePostRules({anmx: 140})?.authorNoteMax).toBe(140);
    expect(parsePostRules({anmx: 0})?.authorNoteMax).toBe(0);
    expect(parsePostRules({})?.authorNoteMax).toBe(280);
    expect(parsePostRules({anmx: -5})?.authorNoteMax).toBe(280); // invalid → default
  });

  it('parses per-type media caps (mm); absent → design default (note 1, article larger)', () => {
    // Explicit organizer values survive.
    const r = parsePostRules({note: {mm: 2}, article: {mm: 20}});
    expect(r?.note.mediaMax).toBe(2);
    expect(r?.article.mediaMax).toBe(20);
    // 0 = the organizer's explicit "no media limit".
    expect(parsePostRules({note: {mm: 0}})?.note.mediaMax).toBe(0);
    // A doc from an older organizer that predates media caps → the design default, so a community
    // gets "1 media per note" out of the box without republishing.
    expect(parsePostRules({note: {mx: 280}})?.note.mediaMax).toBe(DEFAULT_POST_RULES.note.mediaMax);
    expect(DEFAULT_POST_RULES.note.mediaMax).toBe(1);
    expect(DEFAULT_POST_RULES.article.mediaMax).toBeGreaterThan(1);
    // Invalid (negative) → default.
    expect(parsePostRules({note: {mm: -3}})?.note.mediaMax).toBe(DEFAULT_POST_RULES.note.mediaMax);
  });

  it('returns null for non-objects', () => {
    expect(parsePostRules(null)).toBeNull();
    expect(parsePostRules(42)).toBeNull();
  });

  it('parsePostRulesEvent returns null on malformed JSON', () => {
    expect(parsePostRulesEvent('{not json')).toBeNull();
  });

  it('ignores negative / non-finite numbers', () => {
    const r = parsePostRules({note: {mn: -5, mx: Infinity}});
    expect(r?.note.min).toBe(DEFAULT_POST_RULES.note.min);
    expect(r?.note.max).toBe(DEFAULT_POST_RULES.note.max);
  });
});

describe('wordCount', () => {
  it('counts whitespace-delimited words', () => {
    expect(wordCount('one two   three\nfour')).toBe(4);
  });
  it('is zero for empty / whitespace', () => {
    expect(wordCount('   ')).toBe(0);
  });
});

describe('evaluatePost', () => {
  const rules: PostRules = {
    note: {min: 3, max: 10, mediaMax: 0, labelRequired: false},
    article: {min: 2, max: 4, mediaMax: 0, labelRequired: true},
    authorNoteMax: 280,
  };

  it('measures notes in characters', () => {
    expect(evaluatePost({kind: 'note', body: 'hi'}, rules)).toEqual(['too-short']);
    expect(evaluatePost({kind: 'note', body: 'this is way too long'}, rules)).toEqual(['too-long']);
    expect(evaluatePost({kind: 'note', body: 'okay'}, rules)).toEqual([]);
  });

  it('measures articles in words and enforces a required label', () => {
    expect(evaluatePost({kind: 'article', body: 'one'}, rules)).toEqual(
      expect.arrayContaining(['too-short', 'label-required']),
    );
    expect(evaluatePost({kind: 'article', body: 'a b c', label: 'insight'}, rules)).toEqual([]);
    expect(
      evaluatePost({kind: 'article', body: 'a b c d e f', label: 'insight'}, rules),
    ).toEqual(['too-long']);
  });

  it('treats max/min of 0 as unbounded', () => {
    const open: PostRules = {
      note: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
      article: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
      authorNoteMax: 0,
    };
    expect(evaluatePost({kind: 'note', body: ''}, open)).toEqual([]);
  });

  it('produces readable violation messages', () => {
    expect(violationMessage('too-long', 'note', rules)).toContain('characters');
    expect(violationMessage('too-short', 'article', rules)).toContain('words');
    expect(violationMessage('label-required', 'article', rules)).toContain('label');
  });
});

describe('post-type scope', () => {
  it('coerces arbitrary input to a PostScope', () => {
    expect(coercePostScope('note')).toBe('note');
    expect(coercePostScope('article')).toBe('article');
    expect(coercePostScope('all')).toBe('all');
    expect(coercePostScope('garbage')).toBe('all');
    expect(coercePostScope(undefined)).toBe('all');
  });

  it("an 'all' scope applies to every post type; a typed scope only to its own", () => {
    expect(scopeAppliesTo('all', 'note')).toBe(true);
    expect(scopeAppliesTo('all', 'article')).toBe(true);
    expect(scopeAppliesTo('article', 'article')).toBe(true);
    expect(scopeAppliesTo('article', 'note')).toBe(false);
    expect(scopeAppliesTo('note', 'article')).toBe(false);
  });
});

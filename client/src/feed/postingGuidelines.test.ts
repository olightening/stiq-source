import {
  encodePostingGuidelines,
  parsePostingGuidelines,
  parsePostingGuidelinesEvent,
  MAX_BLURB_ITEMS,
  MAX_DIFF_ROWS,
  MAX_SECTIONS,
  type PostingGuidelines,
} from './postingGuidelines';

const FULL: PostingGuidelines = {
  version: 3,
  updatedAt: 1_751_241_600,
  blurb: ['No screenshots — quote as text only.', 'Anything sensitive goes behind a content warning.'],
  sections: [
    {heading: 'How we post', items: ['No screenshots.', 'Use content warnings.']},
    {heading: 'How we treat each other', items: ['Assume good faith.']},
  ],
  diff: {from: 2, rows: [{sign: '~', text: 'Note limit changed from 500 to 280 characters.'}, {sign: '+', text: 'marta added as a moderator.'}]},
};

describe('postingGuidelines', () => {
  it('encode → parse round-trips a full doc', () => {
    expect(parsePostingGuidelines(encodePostingGuidelines(FULL))).toEqual(FULL);
  });

  it('a doc without a diff round-trips with diff null', () => {
    const g = {...FULL, diff: null};
    expect(parsePostingGuidelines(encodePostingGuidelines(g))).toEqual(g);
  });

  it('rejects malformed / foreign / empty docs', () => {
    expect(parsePostingGuidelines(null)).toBeNull();
    expect(parsePostingGuidelines(42)).toBeNull();
    expect(parsePostingGuidelines({})).toBeNull(); // no v
    expect(parsePostingGuidelines({v: 2, ver: 1, at: 1})).toBeNull(); // future wire version
    expect(parsePostingGuidelines({v: 1, ver: 0, at: 1, b: ['x']})).toBeNull(); // ver must be ≥1
    expect(parsePostingGuidelines({v: 1, ver: 1, at: 1, b: [], sec: []})).toBeNull(); // nothing to show
    expect(parsePostingGuidelinesEvent('{not json')).toBeNull();
  });

  it('clamps to the caps instead of rejecting an oversized doc', () => {
    const g = parsePostingGuidelines({
      v: 1,
      ver: 2,
      at: 100,
      b: Array.from({length: 10}, (_, i) => `rule ${i}`),
      sec: Array.from({length: 12}, (_, i) => ({h: `sec ${i}`, it: ['one']})),
      df: {f: 1, rows: Array.from({length: 12}, (_, i) => ['~', `row ${i}`])},
    });
    expect(g?.blurb).toHaveLength(MAX_BLURB_ITEMS);
    expect(g?.sections).toHaveLength(MAX_SECTIONS);
    expect(g?.diff?.rows).toHaveLength(MAX_DIFF_ROWS);
  });

  it('drops empty lines, whitespace-collapses, and skips headingless/itemless sections', () => {
    const g = parsePostingGuidelines({
      v: 1,
      ver: 1,
      at: 100,
      b: ['  a   rule  ', '', 42],
      sec: [
        {h: '', it: ['orphan items']},
        {h: 'no items', it: []},
        {h: 'kept', it: ['  spaced   out  ']},
      ],
    });
    expect(g?.blurb).toEqual(['a rule']);
    expect(g?.sections).toEqual([{heading: 'kept', items: ['spaced out']}]);
  });

  it('diff rows accept only ~ and + signs; a signless diff drops to null', () => {
    const g = parsePostingGuidelines({
      v: 1, ver: 2, at: 100, b: ['x'],
      df: {f: 1, rows: [['-', 'removed thing'], ['~', 'changed thing']]},
    });
    expect(g?.diff?.rows).toEqual([{sign: '~', text: 'changed thing'}]);
    const none = parsePostingGuidelines({
      v: 1, ver: 2, at: 100, b: ['x'],
      df: {f: 1, rows: [['-', 'removed thing']]},
    });
    expect(none?.diff).toBeNull();
  });
});

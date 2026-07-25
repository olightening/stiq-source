import {
  DEFAULT_LIMITS,
  countStats,
  draftStatus,
  limitsFromRules,
  measureBody,
  mediaMaxFor,
  modeOf,
  validateDetails,
  universalLimits,
  validateMedia,
  validateUniversalBody,
  validateWrite,
  type Limits,
} from './editorRules';
import {DEFAULT_POST_RULES, DEFAULT_NOTE_MEDIA_MAX, DEFAULT_ARTICLE_MEDIA_MAX, type PostRules} from './postRules';
import {bodyForMeasure} from './inlineMedia';
import {encodeEventEmbed} from '../events/eventEmbed';

const L: Limits = DEFAULT_LIMITS; // noteMax 280, articleMin 150, articleMax 2000 (soft)

/** A real event card token — deliberately longer than the whole note limit, as field ones are. */
const EVENT_TOKEN = encodeEventEmbed({
  addr: {pubkey: 'a'.repeat(64), d: 'launch-night'},
  type: 'inperson',
  title: 'Launch night',
  description: 'Doors at seven, talks at eight, and a long table afterwards. '.repeat(4),
  hostName: 'Aya',
  area: 'The old print works',
});

describe('modeOf', () => {
  it('is a note when the title is empty/blank', () => {
    expect(modeOf('')).toBe('note');
    expect(modeOf('   ')).toBe('note');
  });
  it('is an article once the title has text', () => {
    expect(modeOf('Hello')).toBe('article');
  });
});

describe('countStats', () => {
  it('counts characters and words, trimming edges and normalising nbsp', () => {
    const s = countStats('  hello world  ', false);
    expect(s.chars).toBe('hello world'.length);
    expect(s.words).toBe(2);
    expect(s.empty).toBe(false);
  });
  it('is empty for blank text with no embed, non-empty when an embed is present', () => {
    expect(countStats('', false).empty).toBe(true);
    expect(countStats('   ', false).empty).toBe(true);
    expect(countStats('', true).empty).toBe(false);
  });
});

describe('validateWrite — Note (character cap, hard)', () => {
  it('empty → blocked, neutral, "Up to 280 characters"', () => {
    const v = validateWrite('note', countStats('', false), L);
    expect(v).toMatchObject({ok: false, state: 'empty', count: 0, denom: 280});
    expect(v.msg).toBe('Up to 280 characters');
  });
  it('within cap → ok, green, "{n} characters left"', () => {
    const text = 'x'.repeat(207);
    const v = validateWrite('note', countStats(text, false), L);
    expect(v).toMatchObject({ok: true, state: 'ok', count: 207, denom: 280});
    expect(v.msg).toBe('73 characters left');
  });
  it('over cap → blocked, red, offers the "add a title" escape hatch', () => {
    const text = 'x'.repeat(359);
    const v = validateWrite('note', countStats(text, false), L);
    expect(v).toMatchObject({ok: false, state: 'over', count: 359});
    expect(v.msg).toBe('79 over the 280 limit — shorten, or add a title');
  });
  it('media-only (0 chars but a picture/voice/embed) → publishable, not "empty"', () => {
    // hasEmbed=true models a body whose only content is an inline picture/voice/embed token — the
    // base64 is excluded from the char count upstream (bodyForMeasure). A caption-less picture tweet
    // must be postable, so the note is OK even with 0 prose characters.
    const v = validateWrite('note', countStats('', true), L);
    expect(v).toMatchObject({ok: true, state: 'ok', count: 0, denom: 280});
  });
});

describe('validateWrite — Article (word floor hard, ceiling soft)', () => {
  const words = (n: number): string => Array.from({length: n}, () => 'word').join(' ');
  it('empty → blocked, "150+ words to publish an article"', () => {
    const v = validateWrite('article', countStats('', false), L);
    expect(v).toMatchObject({ok: false, state: 'empty', denom: 150});
    expect(v.msg).toBe('150+ words to publish an article');
  });
  it('under floor → blocked, "{n} more words to publish an article"', () => {
    const v = validateWrite('article', countStats(words(64), false), L);
    expect(v).toMatchObject({ok: false, state: 'under', count: 64});
    expect(v.msg).toBe('86 more words to publish an article');
  });
  it('in range → ok, green, "Good length — ready for details"', () => {
    const v = validateWrite('article', countStats(words(436), false), L);
    expect(v).toMatchObject({ok: true, state: 'ok', count: 436, denom: 2000});
    expect(v.msg).toBe('Good length — ready for details');
  });
  it('over the soft ceiling → still OK (not blocked), amber "long"', () => {
    const v = validateWrite('article', countStats(words(2100), false), L);
    expect(v).toMatchObject({ok: true, state: 'long', count: 2100});
    expect(v.msg).toBe('100 over the 2000-word limit');
  });
  it('hard article ceiling (organizer-set) DOES block', () => {
    const hard: Limits = {...L, articleMax: 500, articleMaxHard: true};
    const v = validateWrite('article', countStats(words(640), false), hard);
    expect(v).toMatchObject({ok: false, state: 'over', count: 640});
    expect(v.msg).toBe('140 over the 500-word limit — shorten');
  });
});

describe('validateDetails', () => {
  it('note: only tags required; label never needed', () => {
    expect(validateDetails('note', [], null, false)).toMatchObject({ok: false, tagsOk: false, labelNeeded: false});
    expect(validateDetails('note', ['x'], null, false)).toMatchObject({ok: true, tagsOk: true});
  });
  it('article: label required when the community offers article labels', () => {
    expect(validateDetails('article', ['x'], null, true)).toMatchObject({ok: false, labelNeeded: true, labelOk: false});
    expect(validateDetails('article', ['x'], 'insight', true)).toMatchObject({ok: true, labelOk: true});
  });
  it('article: no article labels offered → label not required, tags alone gate', () => {
    expect(validateDetails('article', ['x'], null, false)).toMatchObject({ok: true, labelNeeded: false});
  });
});

describe('draftStatus — mirrors the composer rules on stored numbers', () => {
  it('d1 article, labelled, 436 wd → Ready', () => {
    expect(draftStatus('article', 0, 436, 'insight', L)).toEqual({cls: 'ok', msg: 'Ready to publish'});
  });
  it('d2 note, 104 ch → Ready', () => {
    expect(draftStatus('note', 104, 0, null, L)).toEqual({cls: 'ok', msg: 'Ready to publish'});
  });
  it('d3 article, over floor but unlabelled → Add a label to publish', () => {
    expect(draftStatus('article', 0, 210, null, L)).toEqual({cls: 'warn', msg: 'Add a label to publish'});
  });
  it('d4 note, 326 ch → 46 over the 280 limit', () => {
    expect(draftStatus('note', 326, 0, null, L)).toEqual({cls: 'warn', msg: '46 over the 280 limit'});
  });
  it('d6 article, 64 wd → 86 more words to publish', () => {
    expect(draftStatus('article', 0, 64, 'personal', L)).toEqual({cls: 'warn', msg: '86 more words to publish'});
  });
});

describe('limitsFromRules', () => {
  it('defaults fill unset (0) bounds with the design defaults; ceiling is soft', () => {
    expect(limitsFromRules(DEFAULT_POST_RULES)).toEqual({
      noteMax: 280,
      articleMin: 150,
      articleMax: 2000,
      articleMaxHard: false,
      noteMediaMax: 1,
      articleMediaMax: DEFAULT_POST_RULES.article.mediaMax,
    });
  });
  it('an explicit organizer article.max becomes a hard ceiling', () => {
    const rules: PostRules = {
      note: {min: 0, max: 500, mediaMax: 0, labelRequired: false},
      article: {min: 200, max: 800, mediaMax: 0, labelRequired: false},
      authorNoteMax: 280,
    };
    expect(limitsFromRules(rules)).toEqual({
      noteMax: 500,
      articleMin: 200,
      articleMax: 800,
      articleMaxHard: true,
      noteMediaMax: 0,
      articleMediaMax: 0,
    });
  });
});

describe('measureBody', () => {
  it('derives kind from the title and measures chars/words of the body', () => {
    expect(measureBody('', 'hello there')).toEqual({kind: 'note', chars: 11, words: 2});
    expect(measureBody('T', 'one two three')).toEqual({kind: 'article', chars: 13, words: 3});
  });
  it('excludes an inline picture token from the char/word count (a picture is not prose)', () => {
    // The multi-KB base64 of a picture must never count against the note limit.
    expect(measureBody('', 'hi [[pic:2;2;AAAA]]')).toEqual({kind: 'note', chars: 2, words: 1});
    // A picture-only body measures as zero prose (validateWrite treats it as media, not empty).
    expect(measureBody('', '[[pic:2;2;AAAA]]')).toEqual({kind: 'note', chars: 0, words: 0});
  });
  it('excludes an embedded card from the char/word count (a card is not prose either)', () => {
    expect(measureBody('', `hi ${EVENT_TOKEN}`)).toEqual({kind: 'note', chars: 2, words: 1});
    expect(measureBody('', EVENT_TOKEN)).toEqual({kind: 'note', chars: 0, words: 0});
  });
});

describe('an embedded card never spends the note character budget (the composer meter)', () => {
  // What the composer computes on every keystroke: countStats(bodyForMeasure(body), bodyHasEmbed(body)).
  const meter = (body: string) => validateWrite('note', countStats(bodyForMeasure(body), true), L);

  it('measures the prose only, so a short note plus a card is publishable', () => {
    // The token alone is longer than the whole note limit — counting it blocked Next outright.
    expect(EVENT_TOKEN.length).toBeGreaterThan(L.noteMax);
    const v = meter(`Come to this ${EVENT_TOKEN}`);
    expect(v.ok).toBe(true);
    expect(v.state).toBe('ok');
    expect(v.count).toBe('Come to this'.length); // countStats trims the space the token left behind
    expect(v.msg).toBe(`${L.noteMax - v.count} characters left`);
  });

  it('still blocks on prose that is genuinely over the limit, card or no card', () => {
    const tooLong = 'x'.repeat(L.noteMax + 1);
    expect(meter(tooLong).state).toBe('over');
    expect(meter(`${tooLong} ${EVENT_TOKEN}`).state).toBe('over');
  });

  it('treats a card-only body as content, not as an empty post', () => {
    const v = meter(EVENT_TOKEN);
    expect(v.ok).toBe(true);
    expect(v.count).toBe(0);
  });
});

describe('media caps — Limits carries per-type media count caps', () => {
  it('DEFAULT_LIMITS uses the design defaults (note 1, article larger)', () => {
    expect(DEFAULT_LIMITS.noteMediaMax).toBe(DEFAULT_NOTE_MEDIA_MAX);
    expect(DEFAULT_LIMITS.articleMediaMax).toBe(DEFAULT_ARTICLE_MEDIA_MAX);
    expect(DEFAULT_NOTE_MEDIA_MAX).toBe(1);
    expect(DEFAULT_ARTICLE_MEDIA_MAX).toBeGreaterThan(DEFAULT_NOTE_MEDIA_MAX);
  });

  it('limitsFromRules passes media caps through verbatim (0 = unbounded, NOT defaulted)', () => {
    const rules: PostRules = {
      note: {min: 0, max: 280, mediaMax: 3, labelRequired: false},
      article: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
      authorNoteMax: 280,
    };
    const lim = limitsFromRules(rules);
    expect(lim.noteMediaMax).toBe(3);
    expect(lim.articleMediaMax).toBe(0); // organizer's explicit "no media limit" survives
  });

  it('mediaMaxFor selects the cap for the mode', () => {
    expect(mediaMaxFor('note', DEFAULT_LIMITS)).toBe(1);
    expect(mediaMaxFor('article', DEFAULT_LIMITS)).toBe(DEFAULT_ARTICLE_MEDIA_MAX);
  });
});

describe('validateMedia — the per-post media-count gate', () => {
  it('a note allows exactly one picture/voice; a second is blocked', () => {
    expect(validateMedia('note', 0, DEFAULT_LIMITS).ok).toBe(true);
    expect(validateMedia('note', 1, DEFAULT_LIMITS).ok).toBe(true);
    const over = validateMedia('note', 2, DEFAULT_LIMITS);
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/1 picture or voice note/);
  });

  it('an article allows up to its larger cap', () => {
    expect(validateMedia('article', DEFAULT_ARTICLE_MEDIA_MAX, DEFAULT_LIMITS).ok).toBe(true);
    expect(validateMedia('article', DEFAULT_ARTICLE_MEDIA_MAX + 1, DEFAULT_LIMITS).ok).toBe(false);
  });

  it('cap 0 = unbounded (never blocks, no hint)', () => {
    const L0: Limits = {...DEFAULT_LIMITS, noteMediaMax: 0};
    const v = validateMedia('note', 99, L0);
    expect(v.ok).toBe(true);
    expect(v.max).toBe(0);
    expect(v.hint).toBe('');
  });

  it('surfaces a cap hint that names the type', () => {
    expect(validateMedia('note', 1, DEFAULT_LIMITS).hint).toMatch(/per post/);
    expect(validateMedia('article', 1, DEFAULT_LIMITS).hint).toMatch(/per article/);
  });
});

/**
 * The UNIVERSAL long-body caps — the organizer's article numbers applied to every surface that
 * isn't the feed note: channel broadcasts, group messages, DMs, comments. Mirrors what the relay
 * enforces (relay/internal/policy/organizer.go checkPostRules).
 */
describe('universalLimits — the organizer numbers, raw', () => {
  const rules = (max: number, mediaMax: number): PostRules => ({
    ...DEFAULT_POST_RULES,
    article: {...DEFAULT_POST_RULES.article, max, mediaMax},
  });

  it('reads the ARTICLE bounds, never the note ones', () => {
    const r: PostRules = {
      ...DEFAULT_POST_RULES,
      note: {...DEFAULT_POST_RULES.note, max: 280, mediaMax: 1},
      article: {...DEFAULT_POST_RULES.article, max: 500, mediaMax: 4},
    };
    expect(universalLimits(r)).toEqual({words: 500, media: 4});
  });

  it('does NOT substitute the design default the way limitsFromRules does', () => {
    // limitsFromRules turns an unset article ceiling into the 2000-word DESIGN default, which is
    // right for the feed's soft advisory and wrong here: inventing a ceiling would block writing
    // the relay is perfectly happy to accept.
    const unset = rules(0, 0);
    expect(limitsFromRules(unset).articleMax).toBe(2000);
    expect(universalLimits(unset)).toEqual({words: 0, media: 0});
  });
});

describe('validateUniversalBody', () => {
  it('says nothing at all while the body is within the caps', () => {
    expect(validateUniversalBody(400, 2, {words: 500, media: 4})).toEqual({ok: true, msg: ''});
    // Exactly at the cap is fine — the relay rejects only ABOVE it.
    expect(validateUniversalBody(500, 4, {words: 500, media: 4})).toEqual({ok: true, msg: ''});
  });

  it('never mentions LENGTH in a default community (the word cap ships unbounded)', () => {
    const L0 = universalLimits(DEFAULT_POST_RULES);
    expect(L0.words).toBe(0);
    expect(validateUniversalBody(100000, 0, L0)).toEqual({ok: true, msg: ''});
    // The media cap, by contrast, is NOT unbounded by default — it is the app's shipped article
    // number and the relay enforces it, so it is real and must still be reported.
    expect(L0.media).toBe(DEFAULT_ARTICLE_MEDIA_MAX);
    expect(validateUniversalBody(10, DEFAULT_ARTICLE_MEDIA_MAX, L0).ok).toBe(true);
    expect(validateUniversalBody(10, DEFAULT_ARTICLE_MEDIA_MAX + 1, L0).ok).toBe(false);
  });

  it('reports how far over the word cap the body is', () => {
    const v = validateUniversalBody(503, 0, {words: 500, media: 0});
    expect(v.ok).toBe(false);
    expect(v.msg).toContain('3 words over');
    expect(v.msg).toContain('500');
  });

  it('singularises a one-word overrun', () => {
    expect(validateUniversalBody(501, 0, {words: 500, media: 0}).msg).toContain('1 word over');
  });

  it('reports the media cap once the body is over it', () => {
    const v = validateUniversalBody(10, 6, {words: 0, media: 4});
    expect(v.ok).toBe(false);
    expect(v.msg).toContain('remove 2');
  });

  it('never emits a running count — only an over-the-cap sentence', () => {
    // The whole difference from the feed's meter: writing on a message surface is not narrated.
    for (const words of [0, 1, 250, 499, 500]) {
      expect(validateUniversalBody(words, 0, {words: 500, media: 0}).msg).toBe('');
    }
  });
});

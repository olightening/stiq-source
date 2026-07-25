import {
  DRAFT_EMBED_PREFIX,
  DRAFT_EMBED_RE,
  MAX_DRAFT_EXCERPT_LEN,
  draftExcerptWouldTrim,
  encodeDraftEmbed,
  parseDraftEmbed,
} from './draftEmbed';
import type {DraftRef} from './draftEmbed';
import type {GradientSpec} from '../media/gradient';

const AUTHOR = 'c'.repeat(64);
const GRADIENT: GradientSpec = {type: 'linear', angle: 135, stops: ['#3a4150', '#222834']};

/** Base64url-encode an arbitrary wire object exactly the way both the retired v1 encoder and the
 * current v2 encoder do (JSON -> utf8 -> base64 -> unpadded base64url). Used to hand-craft fixtures
 * (a realistic legacy v1 token, an out-of-band-oversized v2 payload) that the current public
 * `encodeDraftEmbed` signature can no longer produce on its own. */
function toToken(wire: unknown): string {
  const base64 = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64');
  return DRAFT_EMBED_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A DraftRef assertion helper: fails the test with a clear message if `parseDraftEmbed` returned
 * 'legacy' or null instead of a pointer, then narrows the type for the caller. */
function expectRef(result: DraftRef | 'legacy' | null): DraftRef {
  if (result === null) {
    throw new Error('expected a DraftRef, got null');
  }
  if (result === 'legacy') {
    throw new Error("expected a DraftRef, got 'legacy'");
  }
  return result;
}

describe('encodeDraftEmbed / parseDraftEmbed (v2 pointer)', () => {
  it('round-trips a full pointer (id, title, excerpt, author identity)', () => {
    const token = encodeDraftEmbed({
      id: 'draft-abc123',
      title: 'My unfinished essay',
      excerpt: 'A short teaser of the first paragraph…',
      author: AUTHOR,
      authorName: 'Bob',
      authorGradient: GRADIENT,
    });
    expect(token.startsWith(DRAFT_EMBED_PREFIX)).toBe(true);

    const ref = expectRef(parseDraftEmbed(token));
    expect(ref.id).toBe('draft-abc123');
    expect(ref.title).toBe('My unfinished essay');
    expect(ref.excerpt).toBe('A short teaser of the first paragraph…');
    expect(ref.author).toBe(AUTHOR);
    expect(ref.authorName).toBe('Bob');
    expect(ref.authorGradient).toEqual(GRADIENT);
  });

  it('round-trips a minimal pointer (id + excerpt only) — title and identity fields are optional', () => {
    const ref = expectRef(parseDraftEmbed(encodeDraftEmbed({id: 'd1', excerpt: 'just a thought'})));
    expect(ref.id).toBe('d1');
    expect(ref.excerpt).toBe('just a thought');
    expect(ref.title).toBeUndefined();
    expect(ref.author).toBeUndefined();
    expect(ref.authorName).toBeUndefined();
    expect(ref.authorGradient).toBeUndefined();
  });

  it('drops author identity fields when the author pubkey is not valid hex', () => {
    const token = encodeDraftEmbed({
      id: 'd1',
      excerpt: 'x',
      author: 'nothex',
      authorName: 'Nope',
      authorGradient: GRADIENT,
    });
    const ref = expectRef(parseDraftEmbed(token));
    expect(ref.author).toBeUndefined();
    expect(ref.authorName).toBeUndefined();
    expect(ref.authorGradient).toBeUndefined();
  });

  it('carries authorName/authorGradient only alongside a valid author pubkey', () => {
    // authorName/authorGradient are meaningless without an author to attach them to — confirm the
    // encoder does not smuggle them onto the wire when author itself is absent.
    const token = encodeDraftEmbed({id: 'd1', excerpt: 'x', authorName: 'Orphan', authorGradient: GRADIENT});
    const ref = expectRef(parseDraftEmbed(token));
    expect(ref.author).toBeUndefined();
    expect(ref.authorName).toBeUndefined();
    expect(ref.authorGradient).toBeUndefined();
  });

  it('clamps a long excerpt to MAX_DRAFT_EXCERPT_LEN; draftExcerptWouldTrim flags it beforehand', () => {
    const long = 'x'.repeat(MAX_DRAFT_EXCERPT_LEN + 500);
    expect(draftExcerptWouldTrim(long)).toBe(true);
    expect(draftExcerptWouldTrim('short excerpt')).toBe(false);
    const ref = expectRef(parseDraftEmbed(encodeDraftEmbed({id: 'd1', excerpt: long})));
    expect(ref.excerpt.length).toBe(MAX_DRAFT_EXCERPT_LEN);
  });

  it('sanitizes the excerpt (keeps newlines/tabs, strips control/bidi chars) without over-trimming short text', () => {
    const token = encodeDraftEmbed({id: 'd1', excerpt: 'first line\n\tsecond‮evil'});
    const ref = expectRef(parseDraftEmbed(token));
    expect(ref.excerpt).toContain('first line\n\tsecond');
    expect(ref.excerpt).not.toContain('‮');
  });

  it('clamps id/title/authorName to their respective caps', () => {
    const token = encodeDraftEmbed({
      id: 'i'.repeat(300),
      title: 't'.repeat(300),
      excerpt: 'x',
      author: AUTHOR,
      authorName: 'n'.repeat(200),
    });
    const ref = expectRef(parseDraftEmbed(token));
    expect(ref.id.length).toBe(128);
    expect(ref.title!.length).toBe(200);
    expect(ref.authorName!.length).toBe(80);
  });

  it('clamps a >200-char title to exactly 200, and leaves a title between 80 and 200 chars intact', () => {
    const over = expectRef(
      parseDraftEmbed(encodeDraftEmbed({id: 'd1', excerpt: 'x', title: 't'.repeat(250)})),
    );
    expect(over.title!.length).toBe(200);

    const midLength = 150;
    const mid = expectRef(
      parseDraftEmbed(encodeDraftEmbed({id: 'd1', excerpt: 'x', title: 'm'.repeat(midLength)})),
    );
    expect(mid.title).toBe('m'.repeat(midLength));
  });

  it('the v2 wire payload carries no body/tags/label/contentWarning — even if such fields are smuggled onto the input object', () => {
    // Nothing in the current encodeDraftEmbed({id, title?, excerpt, author?, authorName?,
    // authorGradient?}) signature accepts a body/tags/label/contentWarning — that's the whole point
    // of v2. This proves it holds even for a caller that still has v1-shaped data lying around
    // (e.g. a half-migrated call site) and casts past the type checker to smuggle old fields in.
    const smuggled = {
      id: 'draft-x',
      excerpt: 'a short teaser',
      author: AUTHOR,
      body: 'THE ENTIRE SECRET BODY THAT MUST NEVER REACH THE WIRE',
      tags: ['ideas', 'draft'],
      label: 'article',
      contentWarning: 'spoilers',
    } as unknown as Parameters<typeof encodeDraftEmbed>[0];
    const token = encodeDraftEmbed(smuggled);

    const payload = token.slice(DRAFT_EMBED_PREFIX.length);
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');

    expect(json).not.toContain('SECRET BODY');
    expect(json).not.toContain('spoilers');
    expect(json).not.toContain('article');
    expect(json).not.toContain('ideas');

    const wire = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['id', 'p', 'sn', 'v']);
    expect(wire.b).toBeUndefined();
    expect(wire.tg).toBeUndefined();
    expect(wire.l).toBeUndefined();
    expect(wire.cw).toBeUndefined();

    // And the decoded DraftRef itself has no such keys either.
    const ref = expectRef(parseDraftEmbed(token));
    expect(ref).not.toHaveProperty('body');
    expect(ref).not.toHaveProperty('tags');
    expect(ref).not.toHaveProperty('label');
    expect(ref).not.toHaveProperty('contentWarning');
  });

  it('DRAFT_EMBED_RE captures a whole v2 token inside a longer body', () => {
    const token = encodeDraftEmbed({id: 'd1', title: 'T', excerpt: 'b'});
    const body = `read my draft ${token} thanks`;
    const matches = body.match(DRAFT_EMBED_RE);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe(token);
    expect(parseDraftEmbed(matches![0]!)).toEqual(parseDraftEmbed(token));
  });

  it('returns null on garbage / empty / wrong-prefix input', () => {
    expect(parseDraftEmbed('not a token')).toBeNull();
    expect(parseDraftEmbed('')).toBeNull();
    expect(parseDraftEmbed(DRAFT_EMBED_PREFIX)).toBeNull();
    expect(parseDraftEmbed('stiq:msg:abc')).toBeNull();
  });

  it('returns null on malformed JSON payload', () => {
    const base64 = Buffer.from('{not valid json', 'utf8').toString('base64');
    const token = DRAFT_EMBED_PREFIX + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseDraftEmbed(token)).toBeNull();
  });

  it('returns null when a v2 wire is missing its required id', () => {
    expect(parseDraftEmbed(toToken({v: 2, sn: 'a teaser with no id'}))).toBeNull();
  });

  it('returns null on an unrecognized version number', () => {
    expect(parseDraftEmbed(toToken({v: 3, id: 'd1', sn: 'x'}))).toBeNull();
    expect(parseDraftEmbed(toToken({id: 'd1', sn: 'x'}))).toBeNull(); // no v at all
  });

  it('returns null on a grossly oversized payload (outer sanity bound, either version)', () => {
    expect(parseDraftEmbed(DRAFT_EMBED_PREFIX + 'A'.repeat(30_000))).toBeNull();
  });

  it('returns null for a well-formed v2 payload that exceeds the v2-specific payload cap', () => {
    // A legitimate v2 token (through the real encoder) can never get this large — every field it
    // carries is clamped small. This proves the decoder still rejects a hand-crafted v2-shaped wire
    // that inflates past the cap via a field the encoder itself would have clamped (e.g. `id`).
    const token = toToken({v: 2, id: 'x'.repeat(3000), sn: 'short excerpt'});
    expect(parseDraftEmbed(token)).toBeNull();
  });

  it('never throws on adversarial input', () => {
    const adversarial = [
      'stiq:draft:',
      'stiq:draft:{}',
      'stiq:draft:====',
      DRAFT_EMBED_PREFIX + 'a'.repeat(30_000),
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of adversarial) {
      expect(() => parseDraftEmbed(input)).not.toThrow();
    }
  });
});

describe('v1 (legacy, retired) tokens', () => {
  it("a realistic v1 token (the retired self-contained format) parses to exactly the string 'legacy'", () => {
    // Faithful to the retired v1 encoder (`git show HEAD:client/src/feed/draftEmbed.ts` before this
    // rewrite): `{v:1, ti?, b, tg?, l?, cw?, p?, an?, ag?}` — the whole body inline, no `id`.
    const v1 = toToken({
      v: 1,
      ti: 'My unfinished essay',
      b: 'first paragraph\n\nsecond paragraph',
      tg: ['ideas', 'draft'],
      l: 'article',
      cw: 'spoilers',
      p: AUTHOR,
      an: 'Bob',
      ag: 'L135:3a4150,222834',
    });
    expect(parseDraftEmbed(v1)).toBe('legacy');
  });

  it('a minimal v1 token (body only, no title/tags/label/cw/identity) also parses to legacy', () => {
    const v1 = toToken({v: 1, b: 'just a thought'});
    expect(parseDraftEmbed(v1)).toBe('legacy');
  });

  it('a large v1 token (near the old ~8000-char body cap) still resolves to legacy rather than null', () => {
    // The old MAX_DRAFT_BODY_LEN was 8000; a real legacy token in the wild can be this big. The v2
    // decoder must recognize + reject it as 'legacy' via the generous outer bound, not silently
    // treat an oversized-but-real legacy token as garbage (null).
    const v1 = toToken({v: 1, b: 'x'.repeat(8000)});
    expect(parseDraftEmbed(v1)).toBe('legacy');
  });

  it('a v1 token is never mistaken for a v2 pointer (result is the bare string, not a DraftRef-shaped object)', () => {
    const v1 = toToken({v: 1, b: 'body text', p: AUTHOR});
    const result = parseDraftEmbed(v1);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result).toBe('legacy');
  });
});

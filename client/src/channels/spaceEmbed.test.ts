import {SPACE_EMBED_PREFIX, SPACE_EMBED_RE, encodeSpaceEmbed, parseSpaceEmbed, sanitizeSpaceName} from './spaceEmbed';
import type {GradientSpec} from '../media/gradient';

const OWNER = 'a'.repeat(64);
const GRADIENT: GradientSpec = {type: 'linear', angle: 135, stops: ['#3a4150', '#222834']};

describe('encodeSpaceEmbed / parseSpaceEmbed', () => {
  it('round-trips a public channel (30311) with name + gradient', () => {
    const token = encodeSpaceEmbed({
      kind: 30311,
      owner: OWNER,
      identifier: 'general',
      name: 'General',
      private: false,
      gradient: GRADIENT,
    });
    expect(token.startsWith(SPACE_EMBED_PREFIX)).toBe(true);

    const ref = parseSpaceEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(30311);
    expect(ref!.owner).toBe(OWNER);
    expect(ref!.identifier).toBe('general');
    expect(ref!.coordinate).toBe(`30311:${OWNER}:general`);
    expect(ref!.name).toBe('General');
    expect(ref!.private).toBe(false);
    expect(ref!.gradient).toEqual(GRADIENT);
  });

  it('round-trips a private group (39000) with name, no gradient', () => {
    const token = encodeSpaceEmbed({
      kind: 39000,
      owner: OWNER,
      identifier: 'grp123',
      name: 'Inner Circle',
      private: true,
    });
    const ref = parseSpaceEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(39000);
    expect(ref!.owner).toBe(OWNER);
    expect(ref!.identifier).toBe('grp123');
    expect(ref!.coordinate).toBe(`39000:${OWNER}:grp123`);
    expect(ref!.name).toBe('Inner Circle');
    expect(ref!.private).toBe(true);
    expect(ref!.gradient).toBeUndefined();
  });

  it('omits name/gradient keys when absent (token still decodes cleanly)', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'd1', private: false});
    const ref = parseSpaceEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.name).toBeUndefined();
    expect(ref!.gradient).toBeUndefined();
  });

  it('SPACE_EMBED_RE matches a produced token embedded in a longer string, capturing the whole token', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'general', name: 'General', private: false});
    const body = `check out this space -> ${token} it's great!`;
    const matches = body.match(SPACE_EMBED_RE);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe(token);
    // Round-trip through the regex match, not just the original token.
    expect(parseSpaceEmbed(matches![0]!)).toEqual(parseSpaceEmbed(token));
  });

  it('SPACE_EMBED_RE finds multiple tokens in one body', () => {
    const t1 = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'a', private: false});
    const t2 = encodeSpaceEmbed({kind: 39000, owner: OWNER, identifier: 'b', private: true});
    const body = `${t1} and also ${t2}`;
    expect(body.match(SPACE_EMBED_RE)).toEqual([t1, t2]);
  });

  it('returns null on garbage input', () => {
    expect(parseSpaceEmbed('not a token at all')).toBeNull();
    expect(parseSpaceEmbed('')).toBeNull();
    expect(parseSpaceEmbed('nostr:naddr1qqqq')).toBeNull();
  });

  it('returns null on an empty payload', () => {
    expect(parseSpaceEmbed(SPACE_EMBED_PREFIX)).toBeNull();
  });

  it('returns null on a wrong kind', () => {
    const bogus = SPACE_EMBED_PREFIX + Buffer.from(JSON.stringify({v: 1, k: 1, o: OWNER, i: 'x', p: 0}))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(parseSpaceEmbed(bogus)).toBeNull();
  });

  it('returns null when owner/identifier are missing', () => {
    const bogus = SPACE_EMBED_PREFIX + Buffer.from(JSON.stringify({v: 1, k: 30311, p: 0}))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(parseSpaceEmbed(bogus)).toBeNull();
  });

  it('returns null on truncated base64 (invalid character / malformed payload)', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'general', private: false});
    const truncated = token.slice(0, token.length - 4) + '!!!!';
    expect(parseSpaceEmbed(truncated)).toBeNull();
  });

  it('clamps + sanitizes a hostile carried name (newlines, over-length, bidi override) while the token itself stays within the payload cap', () => {
    // Well over the 80-char name clamp but still small enough (as a whole token) to clear the
    // 1024-char payload cap — isolates the name clamp/sanitize path from the payload-size guard.
    const hostile = `Evil\nSpace\t\r${'x'.repeat(200)}‮attack`;
    const token = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'general', name: hostile, private: false});
    const ref = parseSpaceEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.name).toBeDefined();
    expect(ref!.name!.length).toBeLessThanOrEqual(80);
    expect(ref!.name).not.toMatch(/[\n\r\t]/);
    expect(ref!.name).not.toContain('‮');
  });

  it('returns null when a hostile name inflates the token past the payload cap (e.g. 20k chars)', () => {
    const hostile = `Evil${'x'.repeat(20000)}`;
    const token = encodeSpaceEmbed({kind: 30311, owner: OWNER, identifier: 'general', name: hostile, private: false});
    expect(parseSpaceEmbed(token)).toBeNull();
  });

  it('sanitizeSpaceName strips control/bidi/zero-width chars, clamps length, and trims', () => {
    expect(sanitizeSpaceName('hello\nworld')).toBe('helloworld');
    expect(sanitizeSpaceName('a‮b⁦c​d﻿e')).toBe('abcde');
    expect(sanitizeSpaceName('  padded  ')).toBe('padded');
    expect(sanitizeSpaceName('x'.repeat(200)).length).toBe(80);
    expect(sanitizeSpaceName('\n\t  ')).toBe('');
  });

  it('returns null when the base64url payload exceeds the sane cap', () => {
    const oversized = SPACE_EMBED_PREFIX + 'A'.repeat(1025);
    expect(parseSpaceEmbed(oversized)).toBeNull();
  });

  it('never throws on adversarial input', () => {
    const adversarial = [
      'stiq:space:',
      'stiq:space:{}',
      'stiq:space:====',
      SPACE_EMBED_PREFIX + 'a'.repeat(5000),
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of adversarial) {
      expect(() => parseSpaceEmbed(input)).not.toThrow();
    }
  });
});

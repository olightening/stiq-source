import {MSG_EMBED_PREFIX, MSG_EMBED_RE, encodeMsgEmbed, parseMsgEmbed} from './msgEmbed';
import type {GradientSpec} from '../media/gradient';

const AUTHOR = 'b'.repeat(64);
const GRADIENT: GradientSpec = {type: 'linear', angle: 135, stops: ['#3a4150', '#222834']};

describe('encodeMsgEmbed / parseMsgEmbed', () => {
  it('round-trips a private-space post with every field', () => {
    const token = encodeMsgEmbed({
      author: AUTHOR,
      name: 'Alice',
      gradient: GRADIENT,
      body: 'the secret plan\nis on line two',
      kind: 9,
      spaceName: 'Inner Circle',
    });
    expect(token.startsWith(MSG_EMBED_PREFIX)).toBe(true);

    const ref = parseMsgEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.author).toBe(AUTHOR);
    expect(ref!.name).toBe('Alice');
    expect(ref!.gradient).toEqual(GRADIENT);
    expect(ref!.body).toBe('the secret plan\nis on line two');
    expect(ref!.kind).toBe(9);
    expect(ref!.spaceName).toBe('Inner Circle');
  });

  it('round-trips a minimal message (author + body only)', () => {
    const token = encodeMsgEmbed({author: AUTHOR, body: 'hi'});
    const ref = parseMsgEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.author).toBe(AUTHOR);
    expect(ref!.body).toBe('hi');
    expect(ref!.name).toBeUndefined();
    expect(ref!.gradient).toBeUndefined();
    expect(ref!.kind).toBeUndefined();
    expect(ref!.spaceName).toBeUndefined();
  });

  it('preserves newlines and tabs in the body but strips other control chars + bidi overrides', () => {
    const token = encodeMsgEmbed({author: AUTHOR, body: 'line1\n\tline2‮evil'});
    const ref = parseMsgEmbed(token);
    expect(ref!.body).toContain('line1\n\tline2');
    expect(ref!.body).not.toContain('');
    expect(ref!.body).not.toContain('‮');
  });

  it('clamps a very long body to the cap (2000) while the token still decodes', () => {
    const token = encodeMsgEmbed({author: AUTHOR, body: 'x'.repeat(5000)});
    const ref = parseMsgEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.body.length).toBe(2000);
  });

  it('MSG_EMBED_RE captures a whole token inside a longer body', () => {
    const token = encodeMsgEmbed({author: AUTHOR, body: 'quoted'});
    const body = `see this -> ${token} <- neat`;
    const matches = body.match(MSG_EMBED_RE);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe(token);
    expect(parseMsgEmbed(matches![0]!)).toEqual(parseMsgEmbed(token));
  });

  it('returns null on a non-hex (or wrong-length) author pubkey', () => {
    const bogus = MSG_EMBED_PREFIX + Buffer.from(JSON.stringify({v: 1, p: 'NOTHEX', b: 'x'}))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(parseMsgEmbed(bogus)).toBeNull();
  });

  it('returns null on garbage / empty / wrong-prefix input', () => {
    expect(parseMsgEmbed('not a token')).toBeNull();
    expect(parseMsgEmbed('')).toBeNull();
    expect(parseMsgEmbed(MSG_EMBED_PREFIX)).toBeNull();
    expect(parseMsgEmbed('stiq:draft:abc')).toBeNull();
  });

  it('returns null when the payload exceeds the sane cap', () => {
    expect(parseMsgEmbed(MSG_EMBED_PREFIX + 'A'.repeat(6145))).toBeNull();
  });

  it('never throws on adversarial input', () => {
    const adversarial = [
      'stiq:msg:',
      'stiq:msg:{}',
      'stiq:msg:====',
      MSG_EMBED_PREFIX + 'a'.repeat(9000),
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of adversarial) {
      expect(() => parseMsgEmbed(input)).not.toThrow();
    }
  });
});

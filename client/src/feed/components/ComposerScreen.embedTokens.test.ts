/**
 * bodyHasEmbed / previewText — the feed post composer's "is this body empty?" and Details-preview
 * helpers. Both used to recognize only `nostr:nevent…` links, `[[voice:…]]`, and `stiq:event:…`; the
 * other three self-contained embed kinds — `stiq:space:…` (channels/spaceEmbed.ts), `stiq:msg:…`
 * (channels/msgEmbed.ts), and `stiq:draft:…` (feed/draftEmbed.ts) — silently fell through:
 *   - bodyHasEmbed would treat a space/private-post/draft-only body as EMPTY, blocking Publish;
 *   - previewText would leak the token's raw base64 payload straight into the Details preview.
 * These tests pin all four `stiq:` kinds (plus the pre-existing nostr:/voice cases) through both.
 */
import {bodyHasEmbed, previewText} from './ComposerScreen';
import {encodeEventEmbed} from '../../events/eventEmbed';
import {encodeSpaceEmbed} from '../../channels/spaceEmbed';
import {encodeMsgEmbed} from '../../channels/msgEmbed';
import {encodeDraftEmbed} from '../draftEmbed';

const HEX64 = 'a'.repeat(64);

const TOKENS = {
  event: encodeEventEmbed({addr: {pubkey: HEX64, d: 'party'}, type: 'inperson'}),
  space: encodeSpaceEmbed({kind: 30311, owner: HEX64, identifier: 'general', private: false}),
  msg: encodeMsgEmbed({author: HEX64, body: 'hello from a private space'}),
  // v2 draft tokens are pointers, not content: an id + a short excerpt, never the body.
  draft: encodeDraftEmbed({id: 'b'.repeat(64), excerpt: 'an unpublished piece of writing'}),
};

describe('bodyHasEmbed — an embed-only body is never "empty" (Publish must not be blocked)', () => {
  it('is false for genuinely empty / plain-prose bodies', () => {
    expect(bodyHasEmbed('')).toBe(false);
    expect(bodyHasEmbed('   \n  ')).toBe(false);
    expect(bodyHasEmbed('just some prose, nothing inserted')).toBe(false);
  });

  it('stays true for the pre-existing kinds (nostr: reference, voice clip, event)', () => {
    expect(bodyHasEmbed('nostr:nevent1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toBe(true);
    expect(bodyHasEmbed('[[voice:audio/mp4;30;AAAA]]')).toBe(true);
    expect(bodyHasEmbed(TOKENS.event)).toBe(true);
  });

  it('is true for a stiq:space:… token-only body (channel/private-group card)', () => {
    expect(bodyHasEmbed(TOKENS.space)).toBe(true);
    expect(bodyHasEmbed(`check out ${TOKENS.space}`)).toBe(true);
  });

  it('is true for a stiq:msg:… token-only body (private post carried out of a space)', () => {
    expect(bodyHasEmbed(TOKENS.msg)).toBe(true);
  });

  it('is true for a stiq:draft:… token-only body (an embedded unpublished draft)', () => {
    expect(bodyHasEmbed(TOKENS.draft)).toBe(true);
  });
});

describe('previewText — every stiq: embed reduces to a short placeholder, never raw base64', () => {
  it('leaves ordinary prose untouched', () => {
    expect(previewText('hello world')).toBe('hello world');
  });

  it('reduces the pre-existing kinds (voice / picture / event / nostr reference)', () => {
    expect(previewText('[[voice:audio/mp4;30;AAAA]]')).toBe('🎙 voice clip');
    expect(previewText('[[pic:16;4;AAAA]]')).toBe('🖼 picture');
    expect(previewText(TOKENS.event)).toBe('📅 event card');
    expect(previewText('nostr:nevent1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'))
      .toBe('🔗 referenced post');
  });

  it('reduces a stiq:space:… token to a short placeholder, not its base64 payload', () => {
    const out = previewText(`Join us: ${TOKENS.space}`);
    expect(out).toBe('Join us: 🌐 space card');
    expect(out).not.toContain(TOKENS.space);
  });

  it('reduces a stiq:msg:… token to a short placeholder, not its (private!) payload', () => {
    const out = previewText(TOKENS.msg);
    expect(out).toBe('🔒 private post');
    expect(out).not.toContain(TOKENS.msg);
    expect(out).not.toContain('hello from a private space'); // the carried plaintext must not leak here
  });

  it('reduces a stiq:draft:… token to a short placeholder, not its payload', () => {
    const out = previewText(TOKENS.draft);
    expect(out).toBe('✍ draft');
    expect(out).not.toContain(TOKENS.draft);
  });

  it('reduces a body mixing several embed kinds, each to its own placeholder', () => {
    const out = previewText(`${TOKENS.event}\n${TOKENS.space}\n${TOKENS.msg}\n${TOKENS.draft}`);
    expect(out).toBe('📅 event card\n🌐 space card\n🔒 private post\n✍ draft');
  });
});

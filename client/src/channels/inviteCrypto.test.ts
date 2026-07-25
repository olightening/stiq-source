/**
 * Invite-link (navigate-only) + private-space message encryption (build path).
 *
 * Proves: (1) buildInviteLink ALWAYS produces a plain navigate-only link, never a key fragment —
 * the E2E key is now delivered exclusively via kind-30079 on admin approval; (2) parseInviteLink
 * remains tolerant of a LEGACY keyed link (`#k=…&e=…`) so any previously-shared links keep
 * delivering their key; (3) buildGroupChat / buildChannelMessage emit ciphertext + the right tags
 * when keyed, and untouched plaintext when not.
 */
import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {buildInviteLink, parseInviteLink} from './invite';
import {
  mintGroupKey,
  decryptForSpace,
  encodeKeyFragment,
  type SpaceKey,
} from './groupCrypto';
import {buildGroupChat, buildGroupChatEdit, buildGroupReply, messageEpoch} from './groups';
import {buildChannelMessage, channelMessageEpoch} from './channels';

describe('invite link (navigate-only; legacy key-fragment accept-only)', () => {
  it('public invite is unchanged (no fragment)', () => {
    expect(buildInviteLink('grp123')).toBe('stiq://channel/grp123');
    const parsed = parseInviteLink('stiq://channel/grp123');
    expect(parsed).toEqual({spaceId: 'grp123'});
  });

  it('buildInviteLink NEVER produces a key fragment, even for a space with a live key', () => {
    // buildInviteLink no longer takes an SpaceKey param at all — there is no way to ask it for a
    // keyed link. Confirm the link is always the bare navigate form.
    const link = buildInviteLink('grpABC');
    expect(link).toBe('stiq://channel/grpABC');
    expect(link).not.toContain('#');
  });

  it('a LEGACY keyed link (pre-existing, already shared) still round-trips its key on parse', () => {
    const key = mintGroupKey();
    const enc: SpaceKey = {key, epoch: 0};
    // Simulate a link produced by the old (pre-chunk-6) buildInviteLink: manually attach the
    // fragment via the still-exported encodeKeyFragment, exactly as legacy links were formed.
    const legacyLink = `stiq://channel/grpABC#${encodeKeyFragment(enc.key, enc.epoch)}`;
    expect(legacyLink.startsWith('stiq://channel/grpABC#')).toBe(true);
    expect(legacyLink).toContain('k=');
    const [beforeHash] = legacyLink.split('#');
    expect(beforeHash).toBe('stiq://channel/grpABC');

    const parsed = parseInviteLink(legacyLink);
    expect(parsed).not.toBeNull();
    expect(parsed!.spaceId).toBe('grpABC');
    expect(parsed!.epoch).toBe(0);
    expect(Buffer.from(parsed!.key!).equals(Buffer.from(key))).toBe(true);
  });

  it('a legacy link carries a non-zero epoch too', () => {
    const key = mintGroupKey();
    const legacyLink = `stiq://channel/g#${encodeKeyFragment(key, 4)}`;
    const parsed = parseInviteLink(legacyLink)!;
    expect(parsed.epoch).toBe(4);
  });

  it('a tampered/garbled fragment still opens the space (just no key)', () => {
    const parsed = parseInviteLink('stiq://channel/g#k=not-valid');
    expect(parsed).toEqual({spaceId: 'g'});
  });

  it('returns null when there is no space id', () => {
    expect(parseInviteLink('stiq://join?c=ABC')).toBeNull();
    expect(parseInviteLink('https://example.com')).toBeNull();
    expect(parseInviteLink('garbage')).toBeNull();
  });

  it('a fragment can be parsed even when the host URL parser drops it (manual split)', () => {
    const key = mintGroupKey();
    const frag = encodeKeyFragment(key, 2);
    const parsed = parseInviteLink(`stiq://channel/x#${frag}`)!;
    expect(parsed.epoch).toBe(2);
  });
});

describe('buildGroupChat encryption', () => {
  it('PLAINTEXT path is byte-identical when no key is given', () => {
    const ev = buildGroupChat('g1', '  hi there  ');
    expect(ev.content).toBe('hi there');
    expect(ev.tags).toEqual([['h', 'g1']]);
    expect(messageEpoch(ev as never)).toBeNull();
  });

  it('ENCRYPTS the body and adds marker tags when keyed', () => {
    const key = mintGroupKey();
    const ev = buildGroupChat('g1', 'secret words', undefined, {key, epoch: 2});
    expect(ev.content).not.toContain('secret words'); // ciphertext on the wire
    expect(ev.tags).toContainEqual(['encrypted', 'nip44']);
    expect(ev.tags).toContainEqual(['ke', '2']);
    expect(ev.tags).toContainEqual(['h', 'g1']);
    // Decrypts back to the original.
    expect(decryptForSpace(ev.content, key)).toBe('secret words');
    expect(messageEpoch(ev as never)).toBe(2);
  });

  it('keeps the reply marker OUTSIDE the ciphertext, still encrypting the body', () => {
    const key = mintGroupKey();
    const ev = buildGroupChat('g1', 'reply body', 'parentId', {key, epoch: 0});
    expect(ev.tags).toContainEqual(['e', 'parentId', '', 'reply']);
    expect(ev.tags).toContainEqual(['encrypted', 'nip44']);
    expect(decryptForSpace(ev.content, key)).toBe('reply body');
  });

  it('edit + threaded reply also encrypt when keyed', () => {
    const key = mintGroupKey();
    const edit = buildGroupChatEdit('g1', 'orig', 'new text', {key, epoch: 1});
    expect(edit.content).not.toContain('new text');
    expect(decryptForSpace(edit.content, key)).toBe('new text');
    expect(edit.tags).toContainEqual(['e', 'orig', '', 'edit']);
    expect(edit.tags).toContainEqual(['ke', '1']);

    const reply = buildGroupReply('g1', 'parent', 'a reply', {key, epoch: 1});
    expect(decryptForSpace(reply.content, key)).toBe('a reply');
    expect(reply.tags).toContainEqual(['encrypted', 'nip44']);
  });
});

describe('buildChannelMessage encryption (symmetry; NIP-53 stays public today)', () => {
  it('plaintext path unchanged with no key', () => {
    const ev = buildChannelMessage('30311:owner:d', 'hello');
    expect(ev.content).toBe('hello');
    expect(ev.tags).toEqual([['a', '30311:owner:d', '', 'root']]);
    expect(channelMessageEpoch(ev as never)).toBeNull();
  });

  it('encrypts + tags when keyed (path ready even if unused by NIP-53)', () => {
    const key = mintGroupKey();
    const ev = buildChannelMessage('30311:owner:d', 'private broadcast', {key, epoch: 0});
    expect(ev.content).not.toContain('private broadcast');
    expect(decryptForSpace(ev.content, key)).toBe('private broadcast');
    expect(ev.tags).toContainEqual(['encrypted', 'nip44']);
    expect(channelMessageEpoch(ev as never)).toBe(0);
  });
});

describe('signed encrypted group message: relay sees only ciphertext', () => {
  it('the signed event content is ciphertext, decryptable only with the key', () => {
    const key = mintGroupKey();
    const sk = generateSecretKey();
    const unsigned = buildGroupChat('g', 'top secret', undefined, {key, epoch: 0});
    const signed = finalizeEvent(unsigned, sk);
    // This is exactly what the relay receives.
    expect(signed.content).not.toContain('top secret');
    expect(decryptForSpace(signed.content, key)).toBe('top secret');
    expect(() => decryptForSpace(signed.content, mintGroupKey())).toThrow();
  });
});

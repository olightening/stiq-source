/**
 * Invite-link (navigate-only) + private-space message encryption (build path).
 *
 * Proves: (1) buildInviteLink ALWAYS produces a plain navigate-only link, never a key fragment —
 * the E2E key is delivered exclusively via kind-30079 on admin approval; (2) a link can NEVER hand
 * the app key material, however it is dressed up (the link-hardening attack tests below);
 * (3) buildGroupChat / buildChannelMessage emit ciphertext + the right tags when keyed, and
 * untouched plaintext when not.
 */
import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {buildInviteLink, parseInviteLink, inviteLinkCarriesKeyFragment, INVITE_LINK_RE} from './invite';
import {
  mintGroupKey,
  decryptForSpace,
  encodeKeyFragment,
} from './groupCrypto';
import {buildGroupChat, buildGroupChatEdit, buildGroupReply, messageEpoch} from './groups';
import {buildChannelMessage, channelMessageEpoch} from './channels';

describe('invite link (navigate-only)', () => {
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

  it('an id needing percent-encoding still round-trips (NIP-53 channel coordinate)', () => {
    const coord = '30311:abc123:my d';
    const link = buildInviteLink(coord);
    expect(link).not.toContain(' ');
    expect(parseInviteLink(link)).toEqual({spaceId: coord});
  });

  it('the detector regex still matches an invite inside a message body', () => {
    const body = `join us stiq://channel/grpABC now`;
    expect(body.match(INVITE_LINK_RE)).toEqual(['stiq://channel/grpABC']);
  });

  it('returns null when there is no space id', () => {
    expect(parseInviteLink('stiq://join?c=ABC')).toBeNull();
    expect(parseInviteLink('https://example.com')).toBeNull();
    expect(parseInviteLink('garbage')).toBeNull();
  });
});

// ── ATTACK TESTS: key material arriving over a link must never be adopted ─────────────────────
//
// The link is entirely attacker-authored — they choose the space id AND the key bytes AND the
// epoch. Every shape below used to hand the app a usable key; none may now.
describe('invite link key-fragment REJECTION (link hardening)', () => {
  it('a keyed link yields NO key and NO epoch — only the space id + the rejection flag', () => {
    const attackerKey = mintGroupKey();
    const link = `stiq://channel/grpABC#${encodeKeyFragment(attackerKey, 0)}`;
    const parsed = parseInviteLink(link)!;
    expect(parsed.spaceId).toBe('grpABC');
    expect(parsed.key).toBeUndefined();
    expect(parsed.epoch).toBeUndefined();
    expect(parsed.rejectedKeyFragment).toBe(true);
  });

  it('OVERWRITE ATTACK: a huge epoch aimed at a space the user already trusts is refused', () => {
    // The severe variant. A high epoch used to become the space's tracked "current" epoch, so the
    // victim's OWN outgoing messages got sealed under the attacker's key. Nothing comes back now,
    // so there is nothing for the runtime to cache or persist.
    const attackerKey = mintGroupKey();
    const link = `stiq://channel/trusted-space#${encodeKeyFragment(attackerKey, 999999)}`;
    const parsed = parseInviteLink(link)!;
    expect(parsed).toEqual({spaceId: 'trusted-space', rejectedKeyFragment: true});
    expect(parsed.key).toBeUndefined();
    expect(parsed.epoch).toBeUndefined();
  });

  it('SAME-EPOCH OVERWRITE: epoch 0 (the epoch every space starts at) is refused too', () => {
    const link = `stiq://channel/trusted-space#${encodeKeyFragment(mintGroupKey(), 0)}`;
    expect(parseInviteLink(link)!.key).toBeUndefined();
  });

  it('the key bytes never survive anywhere in the returned object', () => {
    const attackerKey = mintGroupKey();
    const link = `stiq://channel/g#${encodeKeyFragment(attackerKey, 3)}`;
    const parsed = parseInviteLink(link)!;
    // No field, however named, carries the fragment's bytes — not as a Uint8Array, not re-encoded.
    expect(Object.values(parsed).some(v => v instanceof Uint8Array)).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(
      Buffer.from(attackerKey).toString('base64').replace(/=+$/, '').slice(0, 8),
    );
    expect(JSON.stringify(parsed)).toBe(JSON.stringify({spaceId: 'g', rejectedKeyFragment: true}));
  });

  it('a fragment the URL layer would drop is still rejected, not silently accepted', () => {
    // Regression guard for the "manual split" behaviour: we split the fragment ourselves, so it is
    // classified (and discarded) regardless of what any host URL parser does with it.
    const frag = encodeKeyFragment(mintGroupKey(), 2);
    expect(inviteLinkCarriesKeyFragment(`stiq://channel/x#${frag}`)).toBe(true);
    expect(parseInviteLink(`stiq://channel/x#${frag}`)!.epoch).toBeUndefined();
  });

  it('MALFORMED fragments never throw and never flag', () => {
    const cases = [
      'stiq://channel/g#k=not-valid',
      'stiq://channel/g#',
      'stiq://channel/g#k=',
      'stiq://channel/g#k',
      'stiq://channel/g#=k=&&&',
      'stiq://channel/g#k=AAAA', // well-formed base64url, wrong key length
      `stiq://channel/g#k=${'A'.repeat(43)}&e=-1`, // negative epoch
      `stiq://channel/g#k=${'A'.repeat(43)}&e=NaN`,
      `stiq://channel/g#k=${'%'.repeat(80)}`,
      'stiq://channel/g#####',
    ];
    for (const c of cases) {
      const parsed = parseInviteLink(c);
      expect(parsed).not.toBeNull();
      expect(parsed!.spaceId).toBe('g');
      expect(parsed!.key).toBeUndefined();
      expect(parsed!.rejectedKeyFragment).toBeUndefined();
    }
  });

  it('non-string / hostile inputs are handled without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(parseInviteLink(bad as unknown as string)).toBeNull();
      expect(inviteLinkCarriesKeyFragment(bad as unknown as string)).toBe(false);
    }
    expect(inviteLinkCarriesKeyFragment('stiq://channel/g')).toBe(false);
  });

  it('LEGITIMATE invite is byte-identical and unaffected — it never had a fragment', () => {
    const link = buildInviteLink('grpABC');
    expect(link).toBe('stiq://channel/grpABC');
    expect(inviteLinkCarriesKeyFragment(link)).toBe(false);
    expect(parseInviteLink(link)).toEqual({spaceId: 'grpABC'});
  });

  it('the organizer join-code link family (multi-use / expiring / short) is untouched', () => {
    // `stiq://join?c=…` is a different deep-link host and is routed elsewhere; parseInviteLink must
    // keep declining it rather than growing an opinion about it.
    for (const l of ['stiq://join?c=ABC', 'stiq://join?c=ABC&x=1', 'stiq://join']) {
      expect(parseInviteLink(l)).toBeNull();
    }
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

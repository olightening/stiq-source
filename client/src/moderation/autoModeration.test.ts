import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {InMemoryEventStore} from '../nostr/store';
import {autoHiddenPosts, type AutoModConfig} from './autoModeration';
import {DEFAULT_POST_RULES, type PostRules} from '../feed/postRules';
import {assembleBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {encryptForSpace} from '../channels/groupCrypto';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../blind/contentKey';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../blind/protocol';
import type {Token} from '../blind/wallet';

const modPub = getPublicKey(generateSecretKey());
const modNpub = nip19.npubEncode(modPub);

function note(id: string, content: string, createdAt = 1000, label?: string): Event {
  const tags: string[][] = [];
  if (label) tags.push(['l', label, 'stiq.type']);
  return {id, pubkey: 'author', created_at: createdAt, kind: 1, tags, content, sig: 's'};
}
function article(id: string, content: string, createdAt = 1000, label?: string): Event {
  const tags: string[][] = [['d', id], ['title', 'T']];
  if (label) tags.push(['l', label, 'stiq.type']);
  return {id, pubkey: 'author', created_at: createdAt, kind: 30023, tags, content, sig: 's'};
}
function restore(postId: string, createdAt: number): Event {
  return {
    id: `res-${postId}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', postId], ['stiq-action', 'restore']],
    content: '',
    sig: 's',
  };
}
function storeWith(...events: Event[]): InMemoryEventStore {
  const s = new InMemoryEventStore();
  for (const e of events) s.save(e);
  return s;
}
const rules = (over: Partial<PostRules>): PostRules => ({...DEFAULT_POST_RULES, ...over});
const cfg = (postRules: PostRules, postRulesAt = 0): AutoModConfig => ({postRules, postRulesAt});

describe('autoHiddenPosts', () => {
  it('hides nothing when the rules constrain nothing', () => {
    const s = storeWith(note('A', 'hello'));
    const open = rules({
      note: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
      article: {min: 0, max: 0, mediaMax: 0, labelRequired: false},
    });
    expect(autoHiddenPosts(s, cfg(open)).size).toBe(0);
  });

  it('hides an article missing a required label, but not one that has one', () => {
    const s = storeWith(article('A', 'body', 1000), article('B', 'body', 1000, 'insight'));
    const c = cfg(rules({article: {min: 0, max: 0, mediaMax: 0, labelRequired: true}}));
    const hidden = autoHiddenPosts(s, c);
    expect(hidden.has('A')).toBe(true);
    expect(hidden.get('A')?.code).toBe('label-required');
    expect(hidden.has('B')).toBe(false);
  });

  it('hides a note over the max length (chars), not one within it', () => {
    const s = storeWith(note('A', 'way too long', 1000), note('B', 'ok', 1000));
    const hidden = autoHiddenPosts(s, cfg(rules({note: {min: 0, max: 5, mediaMax: 0, labelRequired: false}})));
    expect(hidden.has('A')).toBe(true);
    expect(hidden.get('A')?.code).toBe('too-long');
    expect(hidden.has('B')).toBe(false);
  });

  it('does NOT enforce a minimum (compose-time only)', () => {
    const s = storeWith(note('A', 'hi', 1000));
    const hidden = autoHiddenPosts(s, cfg(rules({note: {min: 100, max: 0, mediaMax: 0, labelRequired: false}})));
    expect(hidden.has('A')).toBe(false);
  });

  it('never retroactively hides posts created before the rule took effect', () => {
    const s = storeWith(article('OLD', 'body', 1000), article('NEW', 'body', 3000));
    const c = cfg(rules({article: {min: 0, max: 0, mediaMax: 0, labelRequired: true}}), 2000);
    const hidden = autoHiddenPosts(s, c);
    expect(hidden.has('OLD')).toBe(false); // predates the rule
    expect(hidden.has('NEW')).toBe(true);
  });

  it('lets a moderator restore override an automatic hide', () => {
    const s = storeWith(article('A', 'body', 3000), restore('A', 4000));
    const c = cfg(rules({article: {min: 0, max: 0, mediaMax: 0, labelRequired: true}}));
    expect(autoHiddenPosts(s, c, [modNpub]).has('A')).toBe(false);
  });

  it('ignores a restore from a non-moderator', () => {
    const s = storeWith(article('A', 'body', 3000), restore('A', 4000));
    const c = cfg(rules({article: {min: 0, max: 0, mediaMax: 0, labelRequired: true}}));
    // No moderators configured → the restore doesn't count → still hidden.
    expect(autoHiddenPosts(s, c, []).has('A')).toBe(true);
  });

  // Regression: a picture note carries its pixel data as a long inline [[pic:…]] token. That base64
  // must NOT count against the note char limit (the composer already excludes it via bodyForMeasure),
  // or every normal picture post trips "too-long" and is auto-hidden to the mod log.
  it('does NOT auto-hide a picture note whose inline media exceeds the char limit', () => {
    const pic = `[[pic:16;4;${'A'.repeat(500)}]]`;
    const s = storeWith(note('PIC', pic, 1000), note('LONG', 'x'.repeat(500), 1000));
    const hidden = autoHiddenPosts(s, cfg(rules({note: {min: 0, max: 280, mediaMax: 0, labelRequired: false}})));
    expect(hidden.has('PIC')).toBe(false); // media stripped before measuring → within the limit
    expect(hidden.has('LONG')).toBe(true); // genuinely long prose is still caught
  });

  it('still auto-hides a picture note whose PROSE (excluding media) is over the limit', () => {
    const pic = `[[pic:16;4;${'A'.repeat(500)}]]`;
    const s = storeWith(note('PIC', `${'x'.repeat(300)}${pic}`, 1000));
    const hidden = autoHiddenPosts(s, cfg(rules({note: {min: 0, max: 280, mediaMax: 0, labelRequired: false}})));
    expect(hidden.get('PIC')?.code).toBe('too-long'); // 300 chars of real prose is still over 280
  });

  // 2026-07-21 members-only invisible-unlock incident: a note/article can itself be SEALED under a
  // content epoch key (the blind feedSigner's content-encryption meter). Its ciphertext must never
  // be measured as if it were prose — a false "too-long" (or missed one) derived from ciphertext
  // bytes, not the real body.
  describe('sealed (locked) posts are exempt from length auto-hide, never judged on ciphertext', () => {
    afterEach(() => clearActiveContentKeys());

    it('a still-locked sealed note is exempt even though its true body would violate the rule; catches it once unlocked', () => {
      const key = mintContentKey();
      const {q, Q} = newTokenKeypair();
      const token: Token = {token: Q, sig: new Uint8Array(32), secret: q};
      const ct = encryptForSpace('way too long', key);
      const sealed = assembleBlindEvent(
        {kind: 1, created_at: 1000, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '2']], content: ct},
        [token],
        'attr',
      );
      const s = storeWith(sealed);
      const c = cfg(rules({note: {min: 0, max: 5, mediaMax: 0, labelRequired: false}}));

      // Locked: never judged on the ciphertext bytes — exempt from this pass entirely.
      expect(autoHiddenPosts(s, c).has(sealed.id)).toBe(false);

      setContentEpochKey(2, key);
      const hidden = autoHiddenPosts(s, c);
      expect(hidden.has(sealed.id)).toBe(true);
      expect(hidden.get(sealed.id)?.code).toBe('too-long');
    });
  });
});

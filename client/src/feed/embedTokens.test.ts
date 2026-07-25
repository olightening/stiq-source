/**
 * embedTokens — the tokens that render as a CARD and must therefore never be measured, previewed, or
 * shown as prose. The bug this module exists to fix: dropping an event card into a note spent ~2 KB
 * of that note's 280-character budget, so the composer's meter read "over the limit" for a body the
 * reader sees as one short line plus a card.
 *
 * The grammars are imported from each codec, so these tests use tokens built by the REAL encoders —
 * a codec that changes its wire (a longer payload, a new field) is caught here rather than in the
 * field, where the symptom is a meter that counts a card as prose.
 */
import {stripEmbedTokens, hasEmbedToken, labelEmbedTokens, firstEmbedLabel} from './embedTokens';
import {encodeEventEmbed} from '../events/eventEmbed';
import {encodeSpaceEmbed} from '../channels/spaceEmbed';
import {encodeMsgEmbed} from '../channels/msgEmbed';
import {encodeDraftEmbed} from './draftEmbed';

const HEX64 = 'a'.repeat(64);
const NOSTR_REF = `nostr:nevent1${'q'.repeat(60)}`;

const TOKENS = {
  event: encodeEventEmbed({addr: {pubkey: HEX64, d: 'party'}, type: 'inperson', title: 'Launch night'}),
  space: encodeSpaceEmbed({kind: 30311, owner: HEX64, identifier: 'general', private: false}),
  msg: encodeMsgEmbed({author: HEX64, body: 'hello from a private space'}),
  // v2 draft embeds are POINTERS (id + excerpt), not carriers of the body — the real writing is
  // delivered only to an approved reader. Matches ComposerScreen.embedTokens.test.ts.
  draft: encodeDraftEmbed({id: 'b'.repeat(64), excerpt: 'an unpublished piece of writing'}),
};

describe('stripEmbedTokens — a card payload is not prose', () => {
  it('leaves a body with no tokens untouched', () => {
    expect(stripEmbedTokens('')).toBe('');
    expect(stripEmbedTokens('just some prose')).toBe('just some prose');
  });

  it('strips a token from every canonical encoder, keeping the prose around it', () => {
    for (const [kind, token] of Object.entries(TOKENS)) {
      expect(stripEmbedTokens(`before ${token} after`)).toBe(`before  after`);
      // The point of the exemption: the payload is long, the prose is not.
      expect(token.length).toBeGreaterThan(20);
      expect(kind).toBeTruthy();
    }
  });

  it('strips a nostr reference, in either case (matching every other detector)', () => {
    expect(stripEmbedTokens(`see ${NOSTR_REF}`)).toBe('see ');
    expect(stripEmbedTokens(NOSTR_REF.toUpperCase())).toBe('');
  });

  it('stops at the token boundary — trailing punctuation is prose and stays', () => {
    expect(stripEmbedTokens(`see ${TOKENS.event}.`)).toBe('see .');
    expect(stripEmbedTokens(`(${TOKENS.space})`)).toBe('()');
  });

  it('leaves text that merely mentions the scheme (no payload / unknown kind) alone', () => {
    expect(stripEmbedTokens('stiq:event: with a space after the prefix')).toBe(
      'stiq:event: with a space after the prefix',
    );
    expect(stripEmbedTokens('stiq:unknown:AAAA')).toBe('stiq:unknown:AAAA');
    expect(stripEmbedTokens('nostr:npub1abc')).toBe('nostr:npub1abc'); // a mention is prose, not a card
  });
});

describe('hasEmbedToken — an embed-only body is not empty', () => {
  it('is false for prose and true for each embed kind', () => {
    expect(hasEmbedToken('nothing inserted here')).toBe(false);
    expect(hasEmbedToken(TOKENS.event)).toBe(true);
    expect(hasEmbedToken(TOKENS.space)).toBe(true);
    expect(hasEmbedToken(TOKENS.msg)).toBe(true);
    expect(hasEmbedToken(TOKENS.draft)).toBe(true);
    expect(hasEmbedToken(`chat about ${NOSTR_REF}`)).toBe(true);
  });

  it('answers the same on every call (a shared /g/ regex would skip every other one)', () => {
    for (let i = 0; i < 4; i++) {
      expect(hasEmbedToken(TOKENS.event)).toBe(true);
      expect(hasEmbedToken(NOSTR_REF)).toBe(true);
    }
  });
});

describe('labelEmbedTokens / firstEmbedLabel — a token shown as text becomes a label', () => {
  it('replaces each token in place with its inline label', () => {
    expect(labelEmbedTokens(`Join us: ${TOKENS.event} — bring a friend`)).toBe(
      'Join us: 📅 event card — bring a friend',
    );
    expect(labelEmbedTokens(`${TOKENS.space}\n${TOKENS.msg}\n${TOKENS.draft}\n${NOSTR_REF}`)).toBe(
      '🌐 space card\n🔒 private post\n✍ draft\n🔗 referenced post',
    );
  });

  it('never leaks a carried payload (the private-post token carries plaintext)', () => {
    const out = labelEmbedTokens(TOKENS.msg);
    expect(out).not.toContain('hello from a private space');
  });

  it('no label starts with "#" — a heading strip downstream would eat the marker', () => {
    const labelled = labelEmbedTokens(Object.values(TOKENS).join('\n'));
    for (const line of labelled.split('\n')) expect(line.startsWith('#')).toBe(false);
  });

  it('names a body by its FIRST token, and is empty when there is none', () => {
    expect(firstEmbedLabel('plain prose')).toBe('');
    expect(firstEmbedLabel(TOKENS.event)).toBe('📅 Event');
    expect(firstEmbedLabel(TOKENS.space)).toBe('🌐 Space');
    expect(firstEmbedLabel(TOKENS.msg)).toBe('🔒 Private post');
    expect(firstEmbedLabel(TOKENS.draft)).toBe('✍ Draft');
    expect(firstEmbedLabel(NOSTR_REF)).toBe('🔗 Referenced post');
    // Earliest wins, whichever kind it is.
    expect(firstEmbedLabel(`${NOSTR_REF} ${TOKENS.event}`)).toBe('🔗 Referenced post');
    expect(firstEmbedLabel(`${TOKENS.event} ${NOSTR_REF}`)).toBe('📅 Event');
  });
});

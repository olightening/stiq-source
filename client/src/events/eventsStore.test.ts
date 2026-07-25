import type {Event} from 'nostr-tools/pure';
import {interestedTallies} from './eventsStore';
import {KIND_EVENT_RSVP} from '../contracts';
import {assembleBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {encryptForSpace} from '../channels/groupCrypto';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../blind/contentKey';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../blind/protocol';
import type {Token} from '../blind/wallet';

const COORD = `31923:${'a'.repeat(64)}:my-event`;

/** A fresh holder-bound token: a real BIP-340 keypair (Q = the wire token, q = the secret). */
function makeToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: new Uint8Array(32), secret: q};
}

// This suite only cares about the tally, not attribution — the throwaway signer doubles as "the
// author" so every RSVP counts as its own distinct person.
const resolveAuthor = (ev: Event): string => ev.pubkey;

describe('interestedTallies', () => {
  it('counts a plain (non-blind) "+" RSVP and ignores a retraction', () => {
    const going: Event = {id: 'g1', pubkey: 'p1', created_at: 10, kind: KIND_EVENT_RSVP, tags: [['a', COORD]], content: '+', sig: 's'};
    const retracted: Event = {id: 'g2', pubkey: 'p2', created_at: 10, kind: KIND_EVENT_RSVP, tags: [['a', COORD]], content: '', sig: 's'};
    const tally = interestedTallies([going, retracted], resolveAuthor, null);
    expect(tally.get(COORD)).toEqual({count: 1, mine: false});
  });
});

// 2026-07-21 members-only invisible-unlock incident: a kind-31925 RSVP rides the same blind
// feedSigner as any other content and can therefore be SEALED under a content epoch key. Reading
// its raw ciphertext (which never equals '+') used to silently under-count "interested" — never a
// crash, just a wrong number that looked plausible.
describe('interestedTallies — sealed RSVP body (members-only invisible unlock)', () => {
  afterEach(() => clearActiveContentKeys());

  it('leaves a still-locked sealed RSVP uncounted; the tally corrects once its epoch unlocks', () => {
    const key = mintContentKey();
    const ct = encryptForSpace('+', key);
    const rsvp = assembleBlindEvent(
      {
        kind: KIND_EVENT_RSVP,
        created_at: 100,
        tags: [['a', COORD], [TAG_ENC, ENC_NIP44], [TAG_KE, '4']],
        content: ct,
      },
      [makeToken()],
      'attr',
    );

    const lockedTally = interestedTallies([rsvp], resolveAuthor, null);
    expect(lockedTally.get(COORD)?.count ?? 0).toBe(0);

    setContentEpochKey(4, key);
    const unlockedTally = interestedTallies([rsvp], resolveAuthor, null);
    expect(unlockedTally.get(COORD)).toEqual({count: 1, mine: false});
  });

  it('the resolved viewer\'s own sealed "+" counts toward `mine` once unlocked', () => {
    const key = mintContentKey();
    const ct = encryptForSpace('+', key);
    const rsvp = assembleBlindEvent(
      {
        kind: KIND_EVENT_RSVP,
        created_at: 100,
        tags: [['a', COORD], [TAG_ENC, ENC_NIP44], [TAG_KE, '7']],
        content: ct,
      },
      [makeToken()],
      'attr',
    );
    setContentEpochKey(7, key);
    const tally = interestedTallies([rsvp], resolveAuthor, rsvp.pubkey);
    expect(tally.get(COORD)).toEqual({count: 1, mine: true});
  });
});

import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {bytesToBase64} from '../util/base64';
import {bytesToHex} from '../util/hex';
import {Kind, KIND_SPEND_WITNESS, TAG_TOKEN} from '../contracts';
import {newTokenKeypair, type TokenKeypair} from './holderProof';
import {tokenId} from './doubleSpend';
import {buildSpendWitness, parseSpendWitness, verifySpendWitness} from './spendWitness';

// Build a blind post that VALIDLY spends `kp` as its token 0: the event is signed with the token's
// secret q, so event.pubkey === hex(Q) and its holder proof IS the event's own BIP-340 signature
// (see blind/holderProof) — exactly what doubleSpend.validSpentTokenIds credits as a valid spend.
// Two such events with different content are two DISTINCT ids spending the SAME token: a genuine
// holder double-spend, and the only thing detectDoubleSpends should ever flag.
function spend(kp: TokenKeypair, content: string, createdAt = 1_700_000_000): Event {
  return finalizeEvent(
    {kind: Kind.Post, created_at: createdAt, tags: [[TAG_TOKEN, bytesToBase64(kp.Q)]], content},
    kp.q,
  );
}

// Sign a witness template with a throwaway key — verifySpendWitness only reads kind + tags, but a
// real signed Event keeps the test honest to the wire shape (a bound member signs the real thing).
function signWitness(unsigned: ReturnType<typeof buildSpendWitness>): Event {
  return finalizeEvent(unsigned, generateSecretKey());
}

describe('buildSpendWitness / parseSpendWitness', () => {
  it('round-trips: build → parse recovers the token id and both event ids in order', () => {
    const unsigned = buildSpendWitness('token-hex-id', 'winner-event-id', 'loser-event-id');
    expect(unsigned.kind).toBe(KIND_SPEND_WITNESS);
    expect(unsigned.content).toBe('');
    const parsed = parseSpendWitness(signWitness(unsigned));
    expect(parsed).toEqual({tokenId: 'token-hex-id', eventIds: ['winner-event-id', 'loser-event-id']});
  });

  it('returns null for the wrong kind', () => {
    const ev = signWitness(buildSpendWitness('t', 'a', 'b'));
    expect(parseSpendWitness({...ev, kind: Kind.Post})).toBeNull();
  });

  it('returns null when the stiq_ds token tag is missing', () => {
    const ev = finalizeEvent(
      {kind: KIND_SPEND_WITNESS, created_at: 1_700_000_000, tags: [['e', 'a'], ['e', 'b']], content: ''},
      generateSecretKey(),
    );
    expect(parseSpendWitness(ev)).toBeNull();
  });

  it('returns null when fewer than two e-tags are present', () => {
    const ev = finalizeEvent(
      {kind: KIND_SPEND_WITNESS, created_at: 1_700_000_000, tags: [['e', 'a'], ['stiq_ds', 't']], content: ''},
      generateSecretKey(),
    );
    expect(parseSpendWitness(ev)).toBeNull();
  });
});

describe('verifySpendWitness', () => {
  it('returns the re-derived loser when the store holds two genuinely-colliding events', () => {
    const kp = newTokenKeypair();
    const e1 = spend(kp, 'first post reusing token 0', 1_700_000_000);
    const e2 = spend(kp, 'second post reusing the SAME token 0', 1_700_000_050);
    // Both events are signed by the one token secret, so both prove the same token — the double-spend.
    expect(e1.pubkey).toBe(bytesToHex(kp.Q));
    expect(e2.pubkey).toBe(bytesToHex(kp.Q));
    expect(e1.id).not.toBe(e2.id);

    const store = new InMemoryEventStore();
    store.save(e1);
    store.save(e2);

    const witness = signWitness(buildSpendWitness(tokenId(kp.Q), e1.id, e2.id));
    const losers = verifySpendWitness(witness, store);
    expect(losers).toHaveLength(1);
    expect([e1.id, e2.id]).toContain(losers[0]);
  });

  it('ignores the witness label: swapping winner/loser yields the SAME proven loser', () => {
    const kp = newTokenKeypair();
    const e1 = spend(kp, 'a', 1_700_000_000);
    const e2 = spend(kp, 'b', 1_700_000_050);
    const store = new InMemoryEventStore();
    store.save(e1);
    store.save(e2);

    // A dishonest witness could name the honest post as the "loser"; verify re-derives from the
    // events, so the loser it returns must not depend on which id is labelled winner vs loser.
    const asBuilt = verifySpendWitness(signWitness(buildSpendWitness(tokenId(kp.Q), e1.id, e2.id)), store);
    const swapped = verifySpendWitness(signWitness(buildSpendWitness(tokenId(kp.Q), e2.id, e1.id)), store);
    expect(asBuilt).toEqual(swapped);
    expect(asBuilt).toHaveLength(1);
  });

  it('returns [] for a false witness naming two events that spend DIFFERENT tokens', () => {
    const kpA = newTokenKeypair();
    const kpB = newTokenKeypair();
    const a = spend(kpA, 'x'); // token A
    const b = spend(kpB, 'y'); // token B — no shared token, no collision
    const store = new InMemoryEventStore();
    store.save(a);
    store.save(b);

    // Claim a collision on token A between two events that do not both spend it.
    const witness = signWitness(buildSpendWitness(tokenId(kpA.Q), a.id, b.id));
    expect(verifySpendWitness(witness, store)).toEqual([]);
  });

  it('returns [] when the named token is not the one that actually collides', () => {
    const kp = newTokenKeypair();
    const e1 = spend(kp, 'a', 1_700_000_000); // genuine collision on tokenId(kp.Q)...
    const e2 = spend(kp, 'b', 1_700_000_050);
    const store = new InMemoryEventStore();
    store.save(e1);
    store.save(e2);

    // ...but the witness names an UNRELATED token, so nothing is provable for that token.
    const otherToken = tokenId(newTokenKeypair().Q);
    const witness = signWitness(buildSpendWitness(otherToken, e1.id, e2.id));
    expect(verifySpendWitness(witness, store)).toEqual([]);
  });

  it('returns [] when a referenced event is absent from the store', () => {
    const kp = newTokenKeypair();
    const e1 = spend(kp, 'a', 1_700_000_000);
    const e2 = spend(kp, 'b', 1_700_000_050); // genuinely collides with e1, but is NOT saved
    const store = new InMemoryEventStore();
    store.save(e1);

    const witness = signWitness(buildSpendWitness(tokenId(kp.Q), e1.id, e2.id));
    expect(verifySpendWitness(witness, store)).toEqual([]);
  });

  it('returns [] for an event that is not structurally a witness', () => {
    const store = new InMemoryEventStore();
    const notAWitness = spend(newTokenKeypair(), 'just a post');
    expect(verifySpendWitness(notAWitness, store)).toEqual([]);
  });
});

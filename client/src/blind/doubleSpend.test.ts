import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {detectDoubleSpends, tokenId, validSpentTokenIds} from './doubleSpend';
import {newTokenKeypair, spendProof, type TokenKeypair} from './holderProof';
import {TAG_ATTR, TAG_SIG, TAG_SPEND, TAG_TOKEN} from './protocol';
import {bytesToBase64} from '../util/base64';
import {bytesToHex} from '../util/hex';

// A dummy issuer signature — its bytes are irrelevant to double-spend detection (the relay checks the
// RSA blind-sig; this module only re-verifies HOLDER proofs), so any placeholder is fine.
const SIG = bytesToBase64(Uint8Array.of(1, 2, 3));

/**
 * A real single-token (P3) blind post signed by the token's own secret `q0`, so `event.pubkey ===
 * hex(Q0)` and the event VALIDLY spends token 0. created_at/content are explicit (assembleBlindEvent
 * fuzzes created_at, which we must NOT do here — the tests pin ordering and force distinct ids).
 */
function tokenZeroPost(kp: TokenKeypair, createdAt: number, content: string): Event {
  const tags = [
    [TAG_TOKEN, bytesToBase64(kp.Q)],
    [TAG_SIG, SIG],
    [TAG_ATTR, 'attr'],
  ];
  return finalizeEvent({kind: 1, created_at: createdAt, tags, content}, kp.q);
}

/**
 * A real multi-token blind post: signed by `signer.q0`, plus one holder-bound secondary token per
 * entry in `extras`, each with its own positional `stiq_spend` proof over the event's pubkey — the
 * exact wire layout assembleBlindEvent emits. So the event validly spends `signer` AND every extra.
 */
function multiTokenPost(
  signer: TokenKeypair,
  extras: TokenKeypair[],
  createdAt: number,
  content: string,
): Event {
  const eventPubkeyHex = bytesToHex(signer.Q); // == the event.pubkey that signing with signer.q yields
  const tags: string[][] = [
    [TAG_TOKEN, bytesToBase64(signer.Q)],
    [TAG_SIG, SIG],
  ];
  for (const e of extras) {
    tags.push([TAG_TOKEN, bytesToBase64(e.Q)]);
    tags.push([TAG_SIG, SIG]);
  }
  for (const e of extras) {
    tags.push([TAG_SPEND, bytesToBase64(spendProof(e.q, eventPubkeyHex))]);
  }
  tags.push([TAG_ATTR, 'attr']);
  return finalizeEvent({kind: 1, created_at: createdAt, tags, content}, signer.q);
}

describe('validSpentTokenIds', () => {
  it('tokenId is hex(sha256(Q)) — stable and pure', () => {
    const {Q} = newTokenKeypair();
    expect(tokenId(Q)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenId(Q)).toBe(tokenId(Q));
  });

  it('counts token 0 of a holder-bound single-token post', () => {
    const kp = newTokenKeypair();
    const ev = tokenZeroPost(kp, 1000, 'hello');
    expect(ev.pubkey).toBe(bytesToHex(kp.Q)); // signed by q0
    expect(validSpentTokenIds(ev)).toEqual([tokenId(kp.Q)]);
  });

  it('returns [] for a non-blind event (no stiq_token)', () => {
    const ev = finalizeEvent(
      {kind: 1, created_at: 1000, tags: [['t', 'general']], content: 'x'},
      generateSecretKey(),
    );
    expect(validSpentTokenIds(ev)).toEqual([]);
  });

  it('counts token 0 AND every valid holder-bound secondary token', () => {
    const signer = newTokenKeypair();
    const x = newTokenKeypair();
    const y = newTokenKeypair();
    const ev = multiTokenPost(signer, [x, y], 1000, 'multi');
    expect(validSpentTokenIds(ev).sort()).toEqual(
      [tokenId(signer.Q), tokenId(x.Q), tokenId(y.Q)].sort(),
    );
  });

  it('BEARER post: event.pubkey !== stiq_token[0] -> token 0 is NOT counted (soundness)', () => {
    // A pre-P3 bearer post: the token is opaque bytes and the event is signed by an UNRELATED
    // throwaway key, so we cannot soundly attribute the spend to that token's holder.
    const kp = newTokenKeypair();
    const otherSk = generateSecretKey();
    const tags = [
      [TAG_TOKEN, bytesToBase64(kp.Q)],
      [TAG_SIG, SIG],
      [TAG_ATTR, 'attr'],
    ];
    const bearer = finalizeEvent({kind: 1, created_at: 1000, tags, content: 'bearer'}, otherSk);
    expect(bearer.pubkey).not.toBe(bytesToHex(kp.Q));
    expect(validSpentTokenIds(bearer)).toEqual([]);
  });

  it('FORGED secondary: a stiq_token[i]=Q_victim with an invalid/absent proof is NOT counted', () => {
    const victim = newTokenKeypair();
    const attacker = newTokenKeypair();
    // The attacker bolts the victim's public Q onto their own event but cannot forge a holder proof
    // (they never hold the victim's q). Try both a garbage proof and no proof at all.
    const garbage = new Uint8Array(64).fill(7);
    const build = (proof: Uint8Array | null): Event => {
      const tags: string[][] = [
        [TAG_TOKEN, bytesToBase64(attacker.Q)],
        [TAG_SIG, SIG],
        [TAG_TOKEN, bytesToBase64(victim.Q)],
        [TAG_SIG, SIG],
      ];
      if (proof) tags.push([TAG_SPEND, bytesToBase64(proof)]);
      tags.push([TAG_ATTR, 'attr']);
      return finalizeEvent({kind: 1, created_at: 2000, tags, content: 'forged'}, attacker.q);
    };
    // Only the attacker's OWN token 0 counts; the victim token is never attributed.
    expect(validSpentTokenIds(build(garbage))).toEqual([tokenId(attacker.Q)]);
    expect(validSpentTokenIds(build(null))).toEqual([tokenId(attacker.Q)]);
  });

  it('is memoized: the same event object yields the SAME array reference', () => {
    const ev = tokenZeroPost(newTokenKeypair(), 1000, 'x');
    const first = validSpentTokenIds(ev);
    const second = validSpentTokenIds(ev);
    expect(second).toBe(first); // WeakMap-keyed by object identity
  });
});

describe('detectDoubleSpends', () => {
  it('a single honest post produces no conflict and hides nothing', () => {
    const ev = tokenZeroPost(newTokenKeypair(), 1000, 'hello');
    const res = detectDoubleSpends([ev]);
    expect(res.loserIds.size).toBe(0);
    expect(res.conflicts.size).toBe(0);
  });

  it('genuine double-spend of token 0: the later event loses, the earlier is kept', () => {
    // Same holder-bound token signs two DISTINCT events — only the true holder of q can do this.
    const kp = newTokenKeypair();
    const early = tokenZeroPost(kp, 1000, 'first');
    const late = tokenZeroPost(kp, 2000, 'second');
    const res = detectDoubleSpends([early, late]);

    expect(res.loserIds.has(late.id)).toBe(true);
    expect(res.loserIds.has(early.id)).toBe(false);
    expect(res.loserIds.size).toBe(1);

    const conflict = res.conflicts.get(tokenId(kp.Q));
    expect(conflict?.winner).toBe(early.id);
    expect(conflict?.losers).toEqual([late.id]);
    expect(conflict?.eventIds).toEqual([early.id, late.id]);
  });

  it('tie-break on EQUAL created_at: the lexicographically-higher event.id loses', () => {
    const kp = newTokenKeypair();
    // Different content -> different ids, but identical created_at forces the id tie-break.
    const a = tokenZeroPost(kp, 1000, 'alpha');
    const b = tokenZeroPost(kp, 1000, 'bravo');
    expect(a.id).not.toBe(b.id);
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];

    const res = detectDoubleSpends([a, b]);
    expect(res.loserIds.has(hi.id)).toBe(true);
    expect(res.loserIds.has(lo.id)).toBe(false);
    expect(res.conflicts.get(tokenId(kp.Q))?.winner).toBe(lo.id);
  });

  it('the forged-secondary attack produces NO false conflict — the honest post is never hidden', () => {
    const victim = newTokenKeypair();
    const attacker = newTokenKeypair();
    const legit = tokenZeroPost(victim, 1000, 'legit'); // victim's real, single spend of victim.Q

    const garbage = new Uint8Array(64).fill(7);
    const forgedTags: string[][] = [
      [TAG_TOKEN, bytesToBase64(attacker.Q)],
      [TAG_SIG, SIG],
      [TAG_TOKEN, bytesToBase64(victim.Q)],
      [TAG_SIG, SIG],
      [TAG_SPEND, bytesToBase64(garbage)],
      [TAG_ATTR, 'attr'],
    ];
    const forged = finalizeEvent(
      {kind: 1, created_at: 2000, tags: forgedTags, content: 'forged'},
      attacker.q,
    );

    const res = detectDoubleSpends([legit, forged]);
    // victim.Q was validly spent exactly once (by legit); the forged tag never counts -> no conflict.
    expect(res.conflicts.has(tokenId(victim.Q))).toBe(false);
    expect(res.loserIds.has(legit.id)).toBe(false);
    expect(res.loserIds.size).toBe(0);
  });

  it('a loser for ONE token is hidden whole, even though it alone spends another token', () => {
    // evLate double-spends D (as a secondary token) that evEarly already spent (as its token 0).
    // evLate is the sole spender of P, yet it is still fully hidden because it lost the D conflict.
    const P = newTokenKeypair();
    const D = newTokenKeypair();
    const evEarly = tokenZeroPost(D, 1000, 'early'); // spends D (token 0)
    const evLate = multiTokenPost(P, [D], 2000, 'late'); // spends P (token 0) + D (holder proof)

    const res = detectDoubleSpends([evEarly, evLate]);
    expect(res.loserIds.has(evLate.id)).toBe(true);
    expect(res.loserIds.has(evEarly.id)).toBe(false);
    // P was spent only by evLate -> no P conflict...
    expect(res.conflicts.has(tokenId(P.Q))).toBe(false);
    // ...but D was double-spent, and evLate (later) is the D-loser.
    expect(res.conflicts.get(tokenId(D.Q))?.winner).toBe(evEarly.id);
    expect(res.conflicts.get(tokenId(D.Q))?.losers).toEqual([evLate.id]);
  });

  it('is deterministic: a shuffled copy yields identical loserIds', () => {
    const kpA = newTokenKeypair();
    const kpC = newTokenKeypair();
    const e1 = tokenZeroPost(kpA, 1000, 'a1');
    const e2 = tokenZeroPost(kpA, 3000, 'a2'); // double-spend of A -> later, loses
    const e3 = tokenZeroPost(newTokenKeypair(), 1500, 'b1'); // honest
    const e4 = tokenZeroPost(kpC, 1200, 'c1'); // double-spend of C -> later, loses
    const e5 = tokenZeroPost(kpC, 1100, 'c2'); // earlier C -> wins

    const r1 = detectDoubleSpends([e1, e2, e3, e4, e5]);
    const r2 = detectDoubleSpends([e5, e3, e1, e4, e2]); // same set, different order

    expect([...r1.loserIds].sort()).toEqual([...r2.loserIds].sort());
    // Concretely: the two later re-spends (e2 for A, e4 for C) are the losers.
    expect([...r1.loserIds].sort()).toEqual([e2.id, e4.id].sort());
  });
});

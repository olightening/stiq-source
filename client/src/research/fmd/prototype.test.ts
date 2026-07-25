/**
 * Tests for the narrow FMD client-side prototype (T18-S4).
 *
 * Focused + fast (the heavy scheme sweep lives in fmd.test.ts): the empirical fuzzy-set check runs a
 * modest synthetic stream (γ = 8) with a deterministic counter-based `randScalar` so the observed
 * false-positive rate is reproducible run-to-run. It exercises the prototype glue — flag tag build /
 * read, the client-side detection filter, npub-blind mention lookup, the mineGiftWrap `extraTags`
 * seam, and the ship-dark flag guards — NOT the crypto correctness (S1 owns that).
 */
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import type {Event} from 'nostr-tools/pure';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToNumberBE, numberToBytesBE} from '@noble/curves/utils.js';
import {sha256} from '@noble/hashes/sha2.js';
import {Kind} from '../../nostr/events';
import {bytesToBase64} from '../../util/base64';
import {createDmSeal, mineGiftWrap, openDM} from '../../dm/dm';
import {countLeadingZeroBits} from '../../dm/nip13';
import {FMD_EVAL_ENABLED} from '../../config';
import {
  generateFmdKeypair,
  extractDetectionKey,
  flag,
  testFlag,
  serializeFlag,
} from './fmd';
import {
  TAG_FMD,
  fmdFlagTag,
  fmdExtraTagsFor,
  readFmdFlag,
  fmdFilterInbox,
  fmdDetectInbox,
  detectMentions,
  prototypeStats,
} from './prototype';

const Fn = secp256k1.Point.Fn;

/** Deterministic non-zero scalar source (mirrors fmd.test.ts) for reproducible synthetic flags. */
function counterScalar(seed: number): () => bigint {
  let ctr = BigInt(seed);
  return () => {
    ctr += 1n;
    const s = Fn.create(bytesToNumberBE(sha256(numberToBytesBE(ctr, 32))));
    return s === 0n ? 1n : s;
  };
}

/** A stub event carrying only a `stiq_fmd` flag for `pk` (no `p`/npub tag — that is the point). */
function flaggedEvent(kind: number, pk: Uint8Array[], rnd: () => bigint, id: string): Event {
  const tag = [TAG_FMD, bytesToBase64(serializeFlag(flag(pk, rnd)))];
  return {
    id,
    pubkey: '0'.repeat(64),
    created_at: 0,
    kind,
    tags: [tag],
    content: '',
    sig: '0'.repeat(128),
  } as Event;
}

describe('FMD prototype — flag tag build / read round-trip', () => {
  it('fmdFlagTag → readFmdFlag → testFlag detects the addressed recipient', () => {
    const kp = generateFmdKeypair(8);
    const ev = {tags: [fmdFlagTag(kp.pk)]} as unknown as Event;
    expect(ev.tags[0]![0]).toBe(TAG_FMD);
    const fl = readFmdFlag(ev, kp.gamma);
    expect(fl).not.toBeNull();
    expect(fl!.u.length).toBe(33);
  });

  it('readFmdFlag returns null when the tag is absent or malformed', () => {
    expect(readFmdFlag({tags: []} as unknown as Event, 8)).toBeNull();
    expect(readFmdFlag({tags: [['p', 'abc']]} as unknown as Event, 8)).toBeNull();
    // present but not decodable / wrong length for gamma
    expect(readFmdFlag({tags: [[TAG_FMD, 'not*base64!!']]} as unknown as Event, 8)).toBeNull();
    expect(readFmdFlag({tags: [[TAG_FMD, bytesToBase64(new Uint8Array(3))]]} as unknown as Event, 8)).toBeNull();
  });
});

describe('FMD prototype — mineGiftWrap extraTags seam (id + PoW cover the flag)', () => {
  it('an FMD flag mined into a wrap survives finalizeEvent and round-trips via readFmdFlag', async () => {
    const aliceSK = generateSecretKey();
    const alicePub = getPublicKey(aliceSK);
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const victimFmd = generateFmdKeypair(8);
    const difficulty = 4; // low → fast pure-JS mine (no native StiqPow in jest)

    const {seal} = createDmSeal(aliceSK, bobPub, 'flagged hello');
    const wrap = await mineGiftWrap(seal, bobPub, difficulty, [fmdFlagTag(victimFmd.pk)]);

    // The wrap id still meets the mined difficulty (the flag tag is inside the hashed event).
    expect(countLeadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(difficulty);
    // The stiq_fmd tag trails the nonce and survived signing.
    expect(wrap.tags[0]![0]).toBe('p');
    expect(wrap.tags[1]![0]).toBe('nonce');
    expect(wrap.tags.some(t => t[0] === TAG_FMD)).toBe(true);

    // readFmdFlag recovers the flag and the victim's detection key matches it.
    const fl = readFmdFlag(wrap, 8);
    expect(fl).not.toBeNull();
    expect(testFlag(extractDetectionKey(victimFmd, 4), fl!)).toBe(true);

    // And the DM itself still decrypts unchanged — the flag rides alongside, it does not corrupt.
    const opened = openDM(wrap, bobSK);
    expect(opened.text).toBe('flagged hello');
    expect(opened.sender).toBe(alicePub);
  }, 30000);

  it('mineGiftWrap() with no extraTags is byte-identical in tag shape (regression guard)', async () => {
    const bobPub = getPublicKey(generateSecretKey());
    const {seal} = createDmSeal(generateSecretKey(), bobPub, 'plain');
    const wrap = await mineGiftWrap(seal, bobPub, 4);
    expect(wrap.tags).toHaveLength(2);
    expect(wrap.tags[0]![0]).toBe('p');
    expect(wrap.tags[1]![0]).toBe('nonce');
    expect(wrap.tags.some(t => t[0] === TAG_FMD)).toBe(false);
  }, 30000);
});

describe('FMD prototype — client-side detection filter (fuzzy set, n=4 ⇒ p≈2^-4)', () => {
  const GAMMA = 8;
  const N_VICTIM = 32;
  const N_DECOY = 512;
  const victim = generateFmdKeypair(GAMMA);
  const decoyKeys = Array.from({length: 8}, () => generateFmdKeypair(GAMMA));

  let matched: Event[] = [];
  const victimWraps = new Set<Event>();
  const stats = {truePositives: 0, observedFpRate: 0};

  beforeAll(() => {
    const rnd = counterScalar(0xf1a6);
    const victims: Event[] = [];
    for (let i = 0; i < N_VICTIM; i++) {
      const ev = flaggedEvent(Kind.GiftWrap, victim.pk, rnd, `v${i}`);
      victims.push(ev);
      victimWraps.add(ev);
    }
    const decoys: Event[] = [];
    for (let i = 0; i < N_DECOY; i++) {
      decoys.push(flaggedEvent(Kind.GiftWrap, decoyKeys[i % decoyKeys.length]!.pk, rnd, `d${i}`));
    }
    // Interleave so the filter cannot exploit ordering.
    const all = [...victims, ...decoys];
    const dk = extractDetectionKey(victim, 4);
    matched = fmdFilterInbox(all, dk, GAMMA);
    const s = prototypeStats(all.length, N_DECOY, matched, e => victimWraps.has(e));
    stats.truePositives = s.truePositives;
    stats.observedFpRate = s.observedFpRate;
    // eslint-disable-next-line no-console
    console.log(
      `[FMD-proto] downloaded=${all.length} tp=${s.truePositives}/${N_VICTIM} ` +
        `fp=${s.falsePositives}/${N_DECOY} observedFpRate=${s.observedFpRate.toFixed(4)} (target 0.0625)`,
    );
  }, 120000);

  it('returns 100% of true positives (zero false negatives)', () => {
    expect(stats.truePositives).toBe(N_VICTIM);
    // Every victim wrap is present in the filtered set.
    for (const w of victimWraps) expect(matched).toContain(w);
  });

  it('false-positive rate over the decoys tracks 2^-4 (0.0625)', () => {
    // 3-sigma sampling error at p=0.0625, N=512 is ~0.032 → [0.02, 0.15] is a comfortable band.
    expect(stats.observedFpRate).toBeGreaterThan(0.02);
    expect(stats.observedFpRate).toBeLessThan(0.15);
  });
});

describe('FMD prototype — npub-blind mention detection', () => {
  it('detects mention posts via the FMD flag alone, with no #p==me tag anywhere', () => {
    const GAMMA = 8;
    const rnd = counterScalar(0x123);
    const member = generateFmdKeypair(GAMMA);
    const stranger = generateFmdKeypair(GAMMA);

    const posts: Event[] = [
      flaggedEvent(Kind.Post, member.pk, rnd, 'p0'), // addressed to the member
      flaggedEvent(Kind.Post, stranger.pk, rnd, 'p1'), // not addressed to the member
      flaggedEvent(Kind.Post, member.pk, rnd, 'p2'), // addressed to the member
    ];

    // No post carries the member's npub — mention detection is purely via the stiq_fmd flag.
    for (const p of posts) expect(p.tags.some(t => t[0] === 'p')).toBe(false);

    const results = detectMentions(posts, extractDetectionKey(member, 6), GAMMA);
    const matchedIds = results.filter(r => r.matched).map(r => r.post.id);
    // Both member-addressed posts detected (zero false negatives); the stranger post is (almost
    // surely) not a chance false positive at n=6, p=1/64.
    expect(matchedIds).toContain('p0');
    expect(matchedIds).toContain('p2');
    expect(matchedIds).not.toContain('p1');
  });
});

describe('FMD prototype — ship-dark guards (FMD_EVAL_ENABLED default false)', () => {
  it('the eval flag ships false', () => {
    expect(FMD_EVAL_ENABLED).toBe(false);
  });

  it('fmdExtraTagsFor injects NOTHING when the flag is off (wrap stays byte-identical)', () => {
    const kp = generateFmdKeypair(8);
    expect(fmdExtraTagsFor(kp.pk)).toBeUndefined();
  });

  it('fmdDetectInbox is bypassed (returns []) when the flag is off', () => {
    const kp = generateFmdKeypair(8);
    const dk = extractDetectionKey(kp, kp.gamma);
    const wraps = [flaggedEvent(Kind.GiftWrap, kp.pk, counterScalar(1), 'x0')];
    // fmdFilterInbox (ungated) WOULD match it; fmdDetectInbox short-circuits on the flag.
    expect(fmdFilterInbox(wraps, dk, 8)).toHaveLength(1);
    expect(fmdDetectInbox(wraps, dk, 8)).toEqual([]);
  });
});

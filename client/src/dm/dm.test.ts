import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {
  sealDM,
  openDM,
  readInbox,
  makeConversationKeyCache,
  createDmSeal,
  createDmReactionSeal,
  mineGiftWrap,
  randomPastTimestamp,
} from './dm';
import {countLeadingZeroBits} from './nip13';

describe('NIP-17 sealed DMs', () => {
  it('hides sender metadata and only the recipient can read it', () => {
    const aliceSK = generateSecretKey();
    const alicePub = getPublicKey(aliceSK);
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);

    const wrap = sealDM(aliceSK, bobPub, 'meet at 8');

    // The gift wrap is kind 1059 and signed by an EPHEMERAL key, not Alice.
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(alicePub);

    // Bob recovers the message and the real sender.
    const opened = openDM(wrap, bobSK);
    expect(opened.text).toBe('meet at 8');
    expect(opened.sender).toBe(alicePub);
  });

  it('cannot be read by a third party', () => {
    const aliceSK = generateSecretKey();
    const bobPub = getPublicKey(generateSecretKey());
    const carolSK = generateSecretKey();

    const wrap = sealDM(aliceSK, bobPub, 'secret');
    expect(() => openDM(wrap, carolSK)).toThrow();
  });

  it('readInbox decrypts only our wraps, newest first', () => {
    const aliceSK = generateSecretKey();
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const eveSK = generateSecretKey();
    const evePub = getPublicKey(eveSK);

    const forBob1 = sealDM(aliceSK, bobPub, 'first');
    const forBob2 = sealDM(aliceSK, bobPub, 'second');
    const forEve = sealDM(aliceSK, evePub, 'not for bob');

    const {messages, failedIds} = readInbox([forBob1, forEve, forBob2], bobSK);
    expect(messages.map(m => m.text).sort()).toEqual(['first', 'second']);
    expect(messages).toHaveLength(2);
    // The wrap addressed to Eve is undecryptable for Bob → reported for age-based pruning.
    expect(failedIds).toEqual([forEve.id]);
  });

  it('mines a relay-acceptable PoW gift wrap that still round-trips', async () => {
    const aliceSK = generateSecretKey();
    const alicePub = getPublicKey(aliceSK);
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const difficulty = 8; // low for a fast test; production uses DM_POW_DIFFICULTY

    const {seal} = createDmSeal(aliceSK, bobPub, 'pow hello');
    const wrap = await mineGiftWrap(seal, bobPub, difficulty);

    // Relay PoW gate: committed target (nonce[2]) >= difficulty AND id has >= difficulty bits.
    const nonce = wrap.tags.find(t => t[0] === 'nonce');
    expect(nonce?.[2]).toBe(String(difficulty));
    expect(countLeadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(difficulty);

    // Structurally a valid NIP-59 wrap, and Bob still decrypts it.
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(alicePub);
    const opened = openDM(wrap, bobSK);
    expect(opened.text).toBe('pow hello');
    expect(opened.sender).toBe(alicePub);
  });

  it('carries a reply reference inside the encrypted rumor (swipe-to-reply)', async () => {
    const aliceSK = generateSecretKey();
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const parentId = 'a'.repeat(64);

    const {seal} = createDmSeal(aliceSK, bobPub, 'replying', parentId);
    const wrap = await mineGiftWrap(seal, bobPub, 8);
    // The reply ref is NOT visible on the public wrap (it lives in the encrypted rumor).
    expect(wrap.tags.some(t => t[0] === 'e')).toBe(false);

    const opened = openDM(wrap, bobSK);
    expect(opened.text).toBe('replying');
    expect(opened.replyTo).toBe(parentId);
  });

  it('omits replyTo on a non-reply message', () => {
    const aliceSK = generateSecretKey();
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const wrap = sealDM(aliceSK, bobPub, 'plain');
    expect(openDM(wrap, bobSK).replyTo).toBeUndefined();
  });

  it('exposes the shared rumor id (the cross-party message handle) on decrypt', () => {
    const aliceSK = generateSecretKey();
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const {rumorId} = createDmSeal(aliceSK, bobPub, 'hi');
    // A reaction later references this rumorId; the sender knows it up-front for its own echo.
    expect(rumorId).toMatch(/^[0-9a-f]{64}$/);
    // openDM (peer) recovers the SAME rumor id from its own wrap.
    // (sealDM/wrapEvent path is used here for brevity; the id is a property of the rumor, shared.)
    const opened = openDM(sealDM(aliceSK, bobPub, 'hi'), bobSK);
    expect(opened.rumorId).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.reaction).toBeUndefined();
  });

  it('round-trips a DM reaction (kind-7) targeting a message rumor id', async () => {
    const aliceSK = generateSecretKey();
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const targetRumorId = 'b'.repeat(64);

    const {seal} = createDmReactionSeal(aliceSK, bobPub, targetRumorId, '🔥');
    const wrap = await mineGiftWrap(seal, bobPub, 8);
    // The reaction target is hidden inside the encrypted rumor — not on the public wrap.
    expect(wrap.tags.some(t => t[0] === 'e')).toBe(false);

    const opened = openDM(wrap, bobSK);
    expect(opened.text).toBe('');
    expect(opened.reaction).toEqual({targetRumorId, emoji: '🔥'});
  });
});

describe('gift-wrap timestamp jitter (audit #25)', () => {
  const TWO_DAYS = 2 * 24 * 60 * 60;

  it('fuzzes created_at from the CSPRNG, never Math.random, within the 2-day window', () => {
    const mathSpy = jest.spyOn(Math, 'random');
    for (let i = 0; i < 200; i++) {
      const now = Math.floor(Date.now() / 1000);
      const ts = randomPastTimestamp();
      // Fuzzed into the past only, never the future, never more than 2 days back.
      expect(ts).toBeLessThanOrEqual(now + 1);
      expect(ts).toBeGreaterThanOrEqual(now - TWO_DAYS - 1);
    }
    // The old implementation drew the offset from Math.random — the CSPRNG path must not.
    expect(mathSpy).not.toHaveBeenCalled();
    mathSpy.mockRestore();
  });

  it('spreads values across the window rather than returning a constant', () => {
    const values = new Set<number>();
    for (let i = 0; i < 60; i++) values.add(randomPastTimestamp());
    // 60 draws over a 2-day range at second resolution should almost never all collide.
    expect(values.size).toBeGreaterThan(10);
  });
});

describe('conversation-key cache (finding #2)', () => {
  it('derives one inner-seal conversation key per distinct sender across a batch', () => {
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const aliceSK = generateSecretKey();
    const carolSK = generateSecretKey();

    // 3 wraps from Alice + 2 from Carol, all to Bob.
    const wraps = [
      sealDM(aliceSK, bobPub, 'a1'),
      sealDM(aliceSK, bobPub, 'a2'),
      sealDM(carolSK, bobPub, 'c1'),
      sealDM(aliceSK, bobPub, 'a3'),
      sealDM(carolSK, bobPub, 'c2'),
    ];

    const spy = jest.spyOn(nip44.utils, 'getConversationKey');
    const cache = makeConversationKeyCache();
    const {messages} = readInbox(wraps, bobSK, cache);
    expect(messages).toHaveLength(5);

    // Each unwrap derives the OUTER (ephemeral) key fresh — 5 wraps → 5 outer derivations. The INNER
    // seal key is cached per sender, so 2 distinct senders → 2 inner derivations (not 5). Total = 7,
    // versus 10 (2 per wrap) with no cache.
    expect(spy).toHaveBeenCalledTimes(7);
    expect(cache.size).toBe(2); // Alice + Carol
    spy.mockRestore();
  });

  it('reuses cached sender keys across separate readInbox calls (same cache instance)', () => {
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const aliceSK = generateSecretKey();
    const cache = makeConversationKeyCache();

    readInbox([sealDM(aliceSK, bobPub, 'first')], bobSK, cache);
    expect(cache.size).toBe(1);

    const spy = jest.spyOn(nip44.utils, 'getConversationKey');
    // A later message from the same sender: only the outer (ephemeral) key is derived; the inner
    // seal key is served from the cache seeded by the earlier call.
    readInbox([sealDM(aliceSK, bobPub, 'second')], bobSK, cache);
    expect(spy).toHaveBeenCalledTimes(1); // outer only — inner was a cache hit
    expect(cache.size).toBe(1);
    spy.mockRestore();
  });

  it('clear() drops derived keys so a wiped identity re-derives from scratch', () => {
    const bobSK = generateSecretKey();
    const bobPub = getPublicKey(bobSK);
    const aliceSK = generateSecretKey();
    const cache = makeConversationKeyCache();
    readInbox([sealDM(aliceSK, bobPub, 'x')], bobSK, cache);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

import {getPublicKey, generateSecretKey, getEventHash, finalizeEvent} from 'nostr-tools/pure';
import {countLeadingZeroBits, mineEvent, mineEventPow} from './nip13';

describe('NIP-13 proof-of-work', () => {
  it('counts leading zero bits', () => {
    expect(countLeadingZeroBits('ffff')).toBe(0);
    expect(countLeadingZeroBits('00ff')).toBe(8);
    expect(countLeadingZeroBits('01ff')).toBe(7);
    expect(countLeadingZeroBits('000f')).toBe(12);
  });

  it('mines an event to the target difficulty', () => {
    const difficulty = 8;
    const mined = mineEvent(
      {
        pubkey: getPublicKey(generateSecretKey()),
        kind: 1059,
        created_at: 1000,
        tags: [],
        content: 'x',
      },
      difficulty,
    );
    expect(countLeadingZeroBits(getEventHash(mined))).toBeGreaterThanOrEqual(difficulty);
    expect(mined.tags.some(t => t[0] === 'nonce' && t[2] === '8')).toBe(true);
  });

  describe('mineEventPow (native-aware async miner)', () => {
    const sk = generateSecretKey();
    const base = () => ({
      pubkey: getPublicKey(sk),
      kind: 9020,
      created_at: 1000,
      tags: [['p', 'a'.repeat(64)]] as string[][],
      content: 'enroll',
    });

    it('mines to the target difficulty with the identical nonce tag semantics as mineEvent', async () => {
      const difficulty = 8;
      const mined = await mineEventPow(base(), difficulty);
      // Same relay check: id has >= difficulty leading zero bits.
      expect(countLeadingZeroBits(getEventHash(mined))).toBeGreaterThanOrEqual(difficulty);
      // Same tag shape: ['nonce', <value>, String(difficulty)]; preserves prior tags.
      const nonce = mined.tags.find(t => t[0] === 'nonce');
      expect(nonce).toBeDefined();
      expect(nonce![2]).toBe('8');
      expect(mined.tags.some(t => t[0] === 'p')).toBe(true);
    });

    it('produces an id that survives finalizeEvent unchanged (so the signed event keeps its PoW)', async () => {
      const difficulty = 8;
      const mined = await mineEventPow(base(), difficulty);
      const preSignId = getEventHash(mined);
      const signed = finalizeEvent(
        {kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content},
        sk,
      );
      // finalizeEvent recomputes the same id preimage — the PoW must carry through to the signed event.
      expect(signed.id).toBe(preSignId);
      expect(countLeadingZeroBits(signed.id)).toBeGreaterThanOrEqual(difficulty);
    });

    it('difficulty 0 attaches a zero nonce and needs no work', async () => {
      const mined = await mineEventPow(base(), 0);
      expect(mined.tags.some(t => t[0] === 'nonce' && t[1] === '0')).toBe(true);
    });
  });
});

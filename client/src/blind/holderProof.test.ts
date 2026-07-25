import {schnorr} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js';
import {newTokenKeypair, spendMessage, spendProof, verifySpendProof} from './holderProof';
import {SPEND_DOMAIN} from './protocol';
import {bytesToHex} from '../util/hex';

describe('newTokenKeypair', () => {
  it('mints a valid BIP-340 keypair: Q is exactly 32 bytes and equals schnorr.getPublicKey(q)', () => {
    const {q, Q} = newTokenKeypair();
    expect(Q).toHaveLength(32);
    expect(Q).toEqual(schnorr.getPublicKey(q));
  });

  it('mints a fresh, distinct keypair every call', () => {
    const a = newTokenKeypair();
    const b = newTokenKeypair();
    expect(bytesToHex(a.q)).not.toBe(bytesToHex(b.q));
    expect(bytesToHex(a.Q)).not.toBe(bytesToHex(b.Q));
  });
});

describe('spendMessage', () => {
  it('is a 32-byte digest of SPEND_DOMAIN || event.pubkey (45-byte preimage)', () => {
    const evPubHex = 'a'.repeat(64);
    const digest = spendMessage(evPubHex);
    expect(digest).toHaveLength(32);
  });

  it('is bound to the exact event pubkey — a different pubkey yields a different digest', () => {
    const d1 = spendMessage('a'.repeat(64));
    const d2 = spendMessage('b'.repeat(64));
    expect(bytesToHex(d1)).not.toBe(bytesToHex(d2));
  });

  it('is deterministic for the same input', () => {
    const evPubHex = '1234'.repeat(16);
    expect(bytesToHex(spendMessage(evPubHex))).toBe(bytesToHex(spendMessage(evPubHex)));
  });

  it('pins the wire domain string so an accidental edit cannot pass silently', () => {
    // SPEND_DOMAIN is a cross-language wire constant: the relay hard-codes spendDomain = "stiq-spend-v1"
    // (policy/membership.go). Assert the literal here — the preimage cross-check below rebuilds from the
    // imported constant, so without this a silent edit of SPEND_DOMAIN would still pass every test.
    expect(SPEND_DOMAIN).toBe('stiq-spend-v1');
  });

  it('matches the exact preimage the relay reproduces: sha256(utf8(SPEND_DOMAIN) ++ pubkeyBytes)', () => {
    // Cross-check against a hand-built preimage using only primitives outside the module under
    // test, so a refactor of spendMessage's internals can't silently drift from the relay's Go
    // reproduction (sha256.Sum256(append([]byte(spendDomain), evPub...))).
    const evPubHex = 'deadbeef'.repeat(8);
    const pre = new Uint8Array([...utf8ToBytes(SPEND_DOMAIN), ...hexToBytes(evPubHex)]);
    expect(pre).toHaveLength(45); // 13-byte domain + 32-byte pubkey
    expect(bytesToHex(spendMessage(evPubHex))).toBe(bytesToHex(sha256(pre)));
    // Hard-pinned digest vector (sha256("stiq-spend-v1" || deadbeef*8)) — locks BOTH the domain and the
    // digest construction against the relay's Go reproduction, independent of the constant import above.
    expect(bytesToHex(spendMessage(evPubHex))).toBe('474d1bbbbf59b20158ef1c9807c397b03e7f1fcd3d435448e3968b90d9d309c8');
  });
});

describe('spendProof / verifySpendProof', () => {
  it('round-trips: a proof by q verifies against that token\'s own Q', () => {
    const {q, Q} = newTokenKeypair();
    const evPubHex = 'c'.repeat(64);
    const proof = spendProof(q, evPubHex);
    expect(proof).toHaveLength(64); // BIP-340 signature width
    expect(verifySpendProof(proof, evPubHex, Q)).toBe(true);
  });

  it('fails against a DIFFERENT token\'s Q (proof cannot be replayed cross-token)', () => {
    const a = newTokenKeypair();
    const b = newTokenKeypair();
    const evPubHex = 'd'.repeat(64);
    const proof = spendProof(a.q, evPubHex);
    expect(verifySpendProof(proof, evPubHex, b.Q)).toBe(false);
  });

  it('fails when bound to a DIFFERENT event pubkey (no cross-event replay)', () => {
    const {q, Q} = newTokenKeypair();
    const proof = spendProof(q, 'e'.repeat(64));
    expect(verifySpendProof(proof, 'f'.repeat(64), Q)).toBe(false);
  });
});

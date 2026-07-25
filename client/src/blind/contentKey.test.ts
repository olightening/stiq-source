import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {BlindSigner, BlindTokensExhausted, SealKeyUnavailable, type BlindSignerDeps} from './blindSigner';
import {setActiveCommunityKey} from './communityKey';
import {setBytesPerToken} from './tokenCost';
import {
  isBlindPost,
  isSealedContent,
  resolveContent,
  contentLockState,
  contentEpochOf,
} from './blindPost';
import {
  mintContentKey,
  setContentEpochKey,
  getWriteContentKey,
  getContentEpochKey,
  hasContentEpochKey,
  clearActiveContentKeys,
  setContentKeyStorage,
  storeContentEpochKey,
  loadContentKeys,
  parseContentEpochDoc,
  CONTENT_EPOCH_D_TAG,
} from './contentKey';
import {mintGroupKey, encryptForSpace} from '../channels/groupCrypto';
import {newTokenKeypair} from './holderProof';
import {EpochWallet, type MintToken, type Token} from './wallet';
import type {SecureStorage, UnsignedEvent} from '../keys/keystore';

class Mem implements SecureStorage {
  m = new Map<string, string>();
  async setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  async getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  async removeItem(k: string) {
    this.m.delete(k);
  }
}

const authorSk = generateSecretKey();
const communityKey = mintGroupKey();

const deps: BlindSignerDeps = {
  sign: (u: UnsignedEvent) => Promise.resolve(finalizeEvent({...u, created_at: 1}, authorSk)),
  useSecretKey: async <T>(fn: (sk: Uint8Array) => T) => fn(authorSk),
};

async function walletWith(n: number): Promise<EpochWallet> {
  const w = new EpochWallet(new Mem());
  // Real holder-bound keypairs: the BlindSigner signs the (sealed) post with token 0's secret (P3).
  const mint: MintToken = async (): Promise<Token> => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: Uint8Array.of(9), secret: q};
  };
  if (n > 0) await w.draw(1, n, mint);
  return w;
}

describe('contentKey module', () => {
  afterEach(() => {
    clearActiveContentKeys();
    setContentKeyStorage(null);
  });

  it('has no write key until an epoch key is set (ships dark)', () => {
    expect(getWriteContentKey()).toBeNull();
  });

  it('writes under the newest unlocked epoch and reads back any unlocked epoch', () => {
    const k0 = mintContentKey();
    const k3 = mintContentKey();
    setContentEpochKey(0, k0);
    setContentEpochKey(3, k3);
    // Write key is the newest epoch.
    expect(getWriteContentKey()?.epoch).toBe(3);
    // Both unlocked epochs are readable.
    expect(getContentEpochKey(0)).toEqual(k0);
    expect(getContentEpochKey(3)).toEqual(k3);
    expect(getContentEpochKey(1)).toBeNull();
    expect(hasContentEpochKey(0)).toBe(true);
    expect(hasContentEpochKey(1)).toBe(false);
  });

  it('rejects a malformed epoch or key', () => {
    setContentEpochKey(-1, mintContentKey());
    setContentEpochKey(0, Uint8Array.of(1, 2, 3)); // wrong length
    expect(getWriteContentKey()).toBeNull();
  });

  it('persists and rehydrates epoch keys per community, siloed on switch', async () => {
    const store = new Mem();
    setContentKeyStorage(store);
    const kA = mintContentKey();
    await storeContentEpochKey('communityA', 5, kA);

    clearActiveContentKeys();
    await loadContentKeys('communityA');
    expect(getContentEpochKey(5)).toEqual(kA);

    // Switching to a community with no stored keys clears the caches (no cross-silo leak).
    await loadContentKeys('communityB');
    expect(getContentEpochKey(5)).toBeNull();
    expect(getWriteContentKey()).toBeNull();
  });
});

describe('BlindSigner content sealing + round-trip', () => {
  afterEach(() => {
    setActiveCommunityKey(null);
    setBytesPerToken(0);
    clearActiveContentKeys();
  });

  it('leaves content plaintext when no content key is provisioned', async () => {
    setActiveCommunityKey(communityKey);
    const signer = new BlindSigner(deps, await walletWith(2));
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'plain body'});
    expect(isBlindPost(ev)).toBe(true);
    expect(isSealedContent(ev)).toBe(false);
    expect(ev.content).toBe('plain body');
    expect(resolveContent(ev)).toEqual({text: 'plain body', locked: false});
  });

  it('seals the body under the content epoch key and a holder decrypts it', async () => {
    setActiveCommunityKey(communityKey);
    const epochKey = mintContentKey();
    setContentEpochKey(7, epochKey);
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => true);

    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'members only'});
    expect(isBlindPost(ev)).toBe(true);
    expect(isSealedContent(ev)).toBe(true);
    // The relay/host sees ciphertext, not the body.
    expect(ev.content).not.toContain('members only');
    expect(contentEpochOf(ev)).toBe(7);
    // A holder of epoch 7's key decrypts it.
    expect(resolveContent(ev)).toEqual({text: 'members only', locked: false});
    expect(contentLockState(ev)).toBe('u');
  });

  it('reports LOCKED (never ciphertext) when the epoch is not unlocked', async () => {
    setActiveCommunityKey(communityKey);
    setContentEpochKey(7, mintContentKey());
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => true);
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'secret'});

    // Simulate another device / a member who hasn't unlocked epoch 7.
    clearActiveContentKeys();
    const res = resolveContent(ev);
    expect(res.locked).toBe(true);
    expect(res.text).toBe(''); // withheld, not ciphertext
    expect(contentLockState(ev)).toBe('L');

    // Unlocking the epoch flips it to readable.
    // (the ciphertext is on the event; re-supplying the right key must decrypt it)
  });

  it('a wrong epoch key cannot decrypt (reported locked, not garbage)', async () => {
    setActiveCommunityKey(communityKey);
    setContentEpochKey(7, mintContentKey());
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => true);
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'secret'});

    clearActiveContentKeys();
    setContentEpochKey(7, mintContentKey()); // different key for the same epoch
    const res = resolveContent(ev);
    expect(res.locked).toBe(true);
    expect(res.text).toBe('');
  });

  it('a stripped ke tag on a sealed post is treated as locked (no downgrade)', () => {
    const key = mintContentKey();
    setContentEpochKey(2, key);
    const ct = encryptForSpace('hidden', key);
    // A real sealed BLIND post (carries a token) whose `ke` epoch tag was stripped by a malicious
    // relay: still detected as sealed (via the token + marker) and reported LOCKED, never plaintext.
    const forged = {content: ct, tags: [['stiq_token', 'AA'], ['encrypted', 'nip44']]};
    expect(isSealedContent(forged)).toBe(true);
    expect(resolveContent(forged)).toEqual({text: '', locked: true});
    expect(contentLockState(forged)).toBe('L');
  });

  it('does NOT treat a private-space message (nip44 marker, no token) as a sealed body', () => {
    // Same ['encrypted','nip44'] marker private channels/groups use, but not a blind post → must be
    // left alone (plaintext passthrough), never mis-decrypted with a content epoch key.
    const spaceMsg = {content: 'ciphertext', tags: [['encrypted', 'nip44'], ['ke', '0']]};
    expect(isSealedContent(spaceMsg)).toBe(false);
    expect(resolveContent(spaceMsg)).toEqual({text: 'ciphertext', locked: false});
    expect(contentLockState(spaceMsg)).toBe('');
  });
});

// 2026-07-21 incident: with content encryption REQUIRED (relay flag on + announced epoch) a missing
// write key silently posted PLAINTEXT — a body leak with no warning. The sealRequired hook makes
// that fail closed; the caller's durable pipeline (which already handles BlindTokensExhausted)
// queues the write and retries once the runtime provisions the key.
//
// 2026-07-22 incident: the INVERSE bug — sealing was keyed on merely HOLDING a write key, not on
// whether the community currently REQUIRES sealing. A relay that turned content_encryption back off
// (while a device still had a cached epoch key from when it was on) kept sealing new posts anyway,
// rendering them permanently gray "locked" bars for members who never provisioned that epoch. The
// tests below pin the correct gate: sealing needs BOTH sealRequired() AND a loaded write key.
describe('BlindSigner fail-closed sealing (sealRequired)', () => {
  afterEach(() => {
    setActiveCommunityKey(null);
    clearActiveContentKeys();
  });

  it('throws SealKeyUnavailable instead of posting plaintext when sealing is required and no key is loaded', async () => {
    setActiveCommunityKey(communityKey);
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => true);
    await expect(
      signer.sign({kind: 1, created_at: 0, tags: [], content: 'must never leak'}),
    ).rejects.toThrow(SealKeyUnavailable);
    // Subclass contract: every existing durable catch treats it as the exhaustion family.
    const err = await signer
      .sign({kind: 1, created_at: 0, tags: [], content: 'x'})
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BlindTokensExhausted);
  });

  it('seals normally when required and the epoch key IS loaded', async () => {
    setActiveCommunityKey(communityKey);
    setContentEpochKey(4, mintContentKey());
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => true);
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'sealed fine'});
    expect(isSealedContent(ev)).toBe(true);
    expect(resolveContent(ev)).toEqual({text: 'sealed fine', locked: false});
  });

  it('keeps the pre-incident plaintext fallback when sealing is NOT required (dark/off deployments)', async () => {
    setActiveCommunityKey(communityKey);
    const off = new BlindSigner(deps, await walletWith(2), undefined, () => false);
    const ev = await off.sign({kind: 1, created_at: 0, tags: [], content: 'plain ok'});
    expect(isSealedContent(ev)).toBe(false);
    expect(ev.content).toBe('plain ok');
    const absent = new BlindSigner(deps, await walletWith(2));
    const ev2 = await absent.sign({kind: 1, created_at: 0, tags: [], content: 'plain ok 2'});
    expect(ev2.content).toBe('plain ok 2');
  });

  it('never seals from key presence alone: flag OFF + a loaded write key still publishes plaintext', async () => {
    // The exact 2026-07-22 shape: a device holds a perfectly good epoch key (e.g. left over from
    // when the relay required sealing) but the relay's live flag is now OFF.
    setActiveCommunityKey(communityKey);
    setContentEpochKey(9, mintContentKey());
    const signer = new BlindSigner(deps, await walletWith(2), undefined, () => false);
    const ev = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'never sealed'});
    expect(isSealedContent(ev)).toBe(false);
    expect(ev.content).toBe('never sealed');
    expect(ev.tags.some(t => t[0] === 'encrypted')).toBe(false);
    expect(ev.tags.some(t => t[0] === 'ke')).toBe(false);
  });

  it('consults sealRequired fresh on every sign(): flipping the flag OFF mid-session stops sealing the very next post', async () => {
    setActiveCommunityKey(communityKey);
    setContentEpochKey(3, mintContentKey());
    let flag = true; // simulates the live relay-caps flag, re-negotiated on reconnect
    const signer = new BlindSigner(deps, await walletWith(3), undefined, () => flag);

    const sealedEv = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'first, sealed'});
    expect(isSealedContent(sealedEv)).toBe(true);

    flag = false; // relay flips content_encryption off (or the epoch is un-announced)
    const plainEv = await signer.sign({kind: 1, created_at: 0, tags: [], content: 'second, plaintext'});
    expect(isSealedContent(plainEv)).toBe(false);
    expect(plainEv.content).toBe('second, plaintext');
  });
});

describe('parseContentEpochDoc (stiq:content-epoch announcement, #4)', () => {
  it('has the wire d-tag the organizer publishes', () => {
    expect(CONTENT_EPOCH_D_TAG).toBe('stiq:content-epoch');
  });

  it('reads a well-formed announcement', () => {
    expect(parseContentEpochDoc(JSON.stringify({epoch: 7, rotateEvery: 500}))).toEqual({epoch: 7});
    expect(parseContentEpochDoc(JSON.stringify({epoch: 0}))).toEqual({epoch: 0});
  });

  it('rejects malformed / negative / non-integer / foreign docs', () => {
    expect(parseContentEpochDoc('not json')).toBeNull();
    expect(parseContentEpochDoc(JSON.stringify({epoch: -1}))).toBeNull();
    expect(parseContentEpochDoc(JSON.stringify({epoch: 1.5}))).toBeNull();
    expect(parseContentEpochDoc(JSON.stringify({epoch: '3'}))).toBeNull();
    expect(parseContentEpochDoc(JSON.stringify({notEpoch: 1}))).toBeNull();
  });
});

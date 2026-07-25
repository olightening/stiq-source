/**
 * groupCrypto — exhaustive crypto unit tests (#8 E2E).
 *
 * Security-critical: a regression here either leaks plaintext to the relay or locks members out.
 * Covers content encrypt/decrypt (incl. wrong-key failure), per-member wrap/unwrap (incl. wrong
 * recipient), invite-fragment encode/parse (incl. malformed → null), and keystore persistence
 * (store/load round-trip + epoch ordering), with the keystore backed by InMemorySecureStorage.
 */
import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {InMemorySecureStorage} from '../keys/keystore';
import {
  mintGroupKey,
  encryptForSpace,
  decryptForSpace,
  wrapKeyForMember,
  unwrapKeyFromSender,
  encodeKeyFragment,
  parseKeyFragment,
  buildKeyDelivery,
  parseKeyDelivery,
  setSpaceKeyStorage,
  storeSpaceKey,
  loadSpaceKey,
  currentEpoch,
  hasSpaceKey,
  SPACE_KEY_BYTES,
} from './groupCrypto';

describe('groupCrypto: key mint', () => {
  it('mints a 32-byte key and is non-deterministic', () => {
    const a = mintGroupKey();
    const b = mintGroupKey();
    expect(a).toHaveLength(SPACE_KEY_BYTES);
    expect(b).toHaveLength(SPACE_KEY_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('groupCrypto: message encrypt/decrypt', () => {
  it('round-trips plaintext (incl. unicode + the SOH name header char)', () => {
    const key = mintGroupKey();
    const plaintext = `nAlicehello 🌍 private world — café`;
    const ct = encryptForSpace(plaintext, key);
    expect(ct).not.toContain('hello'); // ciphertext must not leak plaintext
    expect(decryptForSpace(ct, key)).toBe(plaintext);
  });

  it('produces different ciphertext each call (random nonce) but both decrypt', () => {
    const key = mintGroupKey();
    const c1 = encryptForSpace('same', key);
    const c2 = encryptForSpace('same', key);
    expect(c1).not.toBe(c2);
    expect(decryptForSpace(c1, key)).toBe('same');
    expect(decryptForSpace(c2, key)).toBe('same');
  });

  it('FAILS to decrypt with the wrong key', () => {
    const key = mintGroupKey();
    const wrong = mintGroupKey();
    const ct = encryptForSpace('secret', key);
    expect(() => decryptForSpace(ct, wrong)).toThrow();
  });

  it('FAILS to decrypt tampered ciphertext', () => {
    const key = mintGroupKey();
    const ct = encryptForSpace('secret', key);
    // flip a character in the middle of the payload
    const mid = Math.floor(ct.length / 2);
    const tampered = ct.slice(0, mid) + (ct[mid] === 'A' ? 'B' : 'A') + ct.slice(mid + 1);
    expect(() => decryptForSpace(tampered, key)).toThrow();
  });
});

describe('groupCrypto: per-member wrap/unwrap', () => {
  it('round-trips the key to the intended member', () => {
    const key = mintGroupKey();
    const orgSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const memberPk = getPublicKey(memberSk);
    const orgPk = getPublicKey(orgSk);

    const blob = wrapKeyForMember(key, orgSk, memberPk);
    const unwrapped = unwrapKeyFromSender(blob, memberSk, orgPk);
    expect(Buffer.from(unwrapped).equals(Buffer.from(key))).toBe(true);
  });

  it('a DIFFERENT recipient cannot unwrap (wrong recipient fails)', () => {
    const key = mintGroupKey();
    const orgSk = generateSecretKey();
    const orgPk = getPublicKey(orgSk);
    const memberSk = generateSecretKey();
    const memberPk = getPublicKey(memberSk);
    const eveSk = generateSecretKey();

    const blob = wrapKeyForMember(key, orgSk, memberPk);
    // Eve uses her own sk with the org pubkey → different conversation key → auth failure.
    expect(() => unwrapKeyFromSender(blob, eveSk, orgPk)).toThrow();
  });

  it('unwrapping with the wrong SENDER pubkey fails', () => {
    const key = mintGroupKey();
    const orgSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const memberPk = getPublicKey(memberSk);
    const impostorPk = getPublicKey(generateSecretKey());

    const blob = wrapKeyForMember(key, orgSk, memberPk);
    expect(() => unwrapKeyFromSender(blob, memberSk, impostorPk)).toThrow();
  });
});

describe('groupCrypto: invite fragment', () => {
  it('encode→parse round-trips key + epoch', () => {
    const key = mintGroupKey();
    for (const epoch of [0, 1, 5, 42, 1000]) {
      const frag = encodeKeyFragment(key, epoch);
      const parsed = parseKeyFragment(frag);
      expect(parsed).not.toBeNull();
      expect(parsed!.epoch).toBe(epoch);
      expect(Buffer.from(parsed!.key).equals(Buffer.from(key))).toBe(true);
    }
  });

  it('tolerates a leading # and unrelated params', () => {
    const key = mintGroupKey();
    const frag = '#' + encodeKeyFragment(key, 3) + '&x=ignored';
    const parsed = parseKeyFragment(frag);
    expect(parsed).not.toBeNull();
    expect(parsed!.epoch).toBe(3);
    expect(Buffer.from(parsed!.key).equals(Buffer.from(key))).toBe(true);
  });

  it('defaults epoch to 0 when e= is absent', () => {
    const key = mintGroupKey();
    const frag = `k=${encodeKeyFragment(key, 0).split('&')[0]!.slice(2)}`;
    const parsed = parseKeyFragment(frag);
    expect(parsed).not.toBeNull();
    expect(parsed!.epoch).toBe(0);
  });

  it('returns null (never throws) on malformed input', () => {
    const cases = [
      '',
      'garbage',
      'k=',
      'k=!!!notbase64!!!&e=0',
      'e=1', // no key
      'k=AAAA&e=0', // key too short
      'k=' + 'A'.repeat(43) + '&e=-1', // negative epoch
      'k=' + 'A'.repeat(43) + '&e=1.5', // non-integer epoch
      'k=' + 'A'.repeat(43) + '&e=abc', // non-numeric epoch
      null, // deliberately non-string
      undefined, // deliberately non-string
      42, // deliberately non-string
    ];
    for (const c of cases) {
      expect(parseKeyFragment(c as unknown as string)).toBeNull();
    }
  });

  it('a fragment with a valid 32-byte key parses (sanity on the length gate)', () => {
    const key = mintGroupKey();
    const frag = encodeKeyFragment(key, 7);
    // The key portion is base64url of 32 bytes = 43 chars (unpadded).
    const kPart = frag.split('&')[0]!.slice(2);
    expect(kPart).toHaveLength(43);
    expect(parseKeyFragment(frag)).not.toBeNull();
  });
});

describe('groupCrypto: key-delivery event (kind 30079)', () => {
  it('builds a delivery the intended member can unwrap, and routes correctly', () => {
    const key = mintGroupKey();
    const orgSk = generateSecretKey();
    const memberSk = generateSecretKey();
    const memberPk = getPublicKey(memberSk);

    const unsigned = buildKeyDelivery('space-1', 3, key, orgSk, memberPk);
    const signed = finalizeEvent(unsigned, orgSk);

    const parsed = parseKeyDelivery(signed);
    expect(parsed).not.toBeNull();
    expect(parsed!.spaceId).toBe('space-1');
    expect(parsed!.epoch).toBe(3);
    expect(parsed!.recipient).toBe(memberPk);
    expect(parsed!.sender).toBe(getPublicKey(orgSk));

    const unwrapped = unwrapKeyFromSender(parsed!.blob, memberSk, parsed!.sender);
    expect(Buffer.from(unwrapped).equals(Buffer.from(key))).toBe(true);
  });

  it('a non-recipient cannot unwrap a delivery addressed to someone else', () => {
    const key = mintGroupKey();
    const orgSk = generateSecretKey();
    const memberPk = getPublicKey(generateSecretKey());
    const eveSk = generateSecretKey();

    const signed = finalizeEvent(buildKeyDelivery('s', 0, key, orgSk, memberPk), orgSk);
    const parsed = parseKeyDelivery(signed)!;
    expect(() => unwrapKeyFromSender(parsed.blob, eveSk, parsed.sender)).toThrow();
  });

  it('parseKeyDelivery returns null for the wrong kind or missing tags', () => {
    const notDelivery = finalizeEvent(
      {kind: 1, created_at: 1, tags: [], content: 'x'},
      generateSecretKey(),
    );
    expect(parseKeyDelivery(notDelivery)).toBeNull();
  });

  it('d-tag scopes by space:epoch:member so re-delivery replaces', () => {
    const orgSk = generateSecretKey();
    const memberPk = getPublicKey(generateSecretKey());
    const unsigned = buildKeyDelivery('abc', 2, mintGroupKey(), orgSk, memberPk);
    const d = unsigned.tags.find(t => t[0] === 'd')?.[1];
    expect(d).toBe(`abc:2:${memberPk}`);
  });
});

describe('groupCrypto: keystore persistence', () => {
  let storage: InMemorySecureStorage;

  beforeEach(() => {
    storage = new InMemorySecureStorage();
    setSpaceKeyStorage(storage);
  });

  afterEach(() => {
    setSpaceKeyStorage(null);
  });

  it('store→load round-trips a key for an epoch', async () => {
    const key = mintGroupKey();
    await storeSpaceKey('space1', 0, key);
    const loaded = await loadSpaceKey('space1', 0);
    expect(loaded).not.toBeNull();
    expect(Buffer.from(loaded!).equals(Buffer.from(key))).toBe(true);
  });

  it('loads null for an unknown space/epoch', async () => {
    expect(await loadSpaceKey('nope', 0)).toBeNull();
    expect(await loadSpaceKey('space1', 99)).toBeNull();
  });

  it('currentEpoch tracks the HIGHEST stored epoch (ordering)', async () => {
    expect(await currentEpoch('s')).toBe(-1);
    await storeSpaceKey('s', 0, mintGroupKey());
    expect(await currentEpoch('s')).toBe(0);
    await storeSpaceKey('s', 1, mintGroupKey());
    expect(await currentEpoch('s')).toBe(1);
    // Storing an OLDER epoch must not lower the tracked current epoch.
    await storeSpaceKey('s', 0, mintGroupKey());
    expect(await currentEpoch('s')).toBe(1);
    // Jumping forward advances it.
    await storeSpaceKey('s', 5, mintGroupKey());
    expect(await currentEpoch('s')).toBe(5);
  });

  it('keeps every epoch key readable after rotation (old messages stay decryptable)', async () => {
    const k0 = mintGroupKey();
    const k1 = mintGroupKey();
    await storeSpaceKey('s', 0, k0);
    await storeSpaceKey('s', 1, k1);
    expect(Buffer.from((await loadSpaceKey('s', 0))!).equals(Buffer.from(k0))).toBe(true);
    expect(Buffer.from((await loadSpaceKey('s', 1))!).equals(Buffer.from(k1))).toBe(true);
  });

  it('hasSpaceKey reflects whether any key is stored', async () => {
    expect(await hasSpaceKey('s')).toBe(false);
    await storeSpaceKey('s', 0, mintGroupKey());
    expect(await hasSpaceKey('s')).toBe(true);
  });

  it('refuses to store a malformed key', async () => {
    await expect(storeSpaceKey('s', 0, new Uint8Array(16))).rejects.toThrow();
  });

  it('no-ops gracefully when no storage is wired', async () => {
    setSpaceKeyStorage(null);
    await expect(storeSpaceKey('s', 0, mintGroupKey())).resolves.toBeUndefined();
    expect(await loadSpaceKey('s', 0)).toBeNull();
    expect(await currentEpoch('s')).toBe(-1);
  });

  it('a stored key actually decrypts what it encrypted (end-to-end through storage)', async () => {
    const key = mintGroupKey();
    await storeSpaceKey('s', 2, key);
    const ct = encryptForSpace('through the keystore', key);
    const reloaded = await loadSpaceKey('s', 2);
    expect(reloaded).not.toBeNull();
    expect(decryptForSpace(ct, reloaded!)).toBe('through the keystore');
  });
});

/**
 * DM call-site guard (T18-S7): proves the FMD eval seam wired into Identity.sealDM (keys/identity.ts)
 * is SHIP-DARK. With FMD_EVAL_ENABLED false (the shipped default) a sealed DM is byte-identical to
 * before the seam existed — NO stiq_fmd tag, exactly [p, nonce] — and the DM still decrypts. Flipping
 * the flag (local eval build) injects a detectable flag via the flag-guarded fmdExtraTagsFor choke
 * point. This is the safety-critical test for the one production file the FMD work touches.
 */
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {Identity} from '../../keys/identity';
import {InMemorySecureStorage} from '../../keys/keystore';
import {openDM} from '../../dm/dm';
import {FMD_EVAL_ENABLED} from '../../config';
import {TAG_FMD} from './prototype';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const CRED = {token: new Uint8Array([1, 2, 3]), signature: new Uint8Array([4, 5, 6])};
const LOW_POW = 4; // keep the pure-JS mine fast in jest

async function enrolledIdentity(IdentityCtor = Identity, Storage = InMemorySecureStorage) {
  const storage = new Storage();
  const id = new IdentityCtor(storage);
  await id.enroll(generateSecretKey(), ONION, CRED);
  return id;
}

describe('FMD DM call-site guard — flag OFF (shipped default) is byte-identical', () => {
  it('the eval flag ships false', () => {
    expect(FMD_EVAL_ENABLED).toBe(false);
  });

  it('sealDM emits exactly [p, nonce] with no stiq_fmd tag, and the DM still decrypts', async () => {
    const id = await enrolledIdentity();
    const senderPub = (await id.info()).pubkey;
    const peerSk = generateSecretKey();
    const peerPub = getPublicKey(peerSk);

    const {wrap} = await id.sealDM(peerPub, 'hello', undefined, LOW_POW);

    expect(wrap.tags).toHaveLength(2);
    expect(wrap.tags[0]![0]).toBe('p');
    expect(wrap.tags[1]![0]).toBe('nonce');
    expect(wrap.tags.some(t => t[0] === TAG_FMD)).toBe(false);

    // The DM itself is intact — the guard changed nothing on the shipped path.
    const opened = openDM(wrap, peerSk);
    expect(opened.text).toBe('hello');
    expect(opened.sender).toBe(senderPub);
  }, 30000);
});

describe('FMD DM call-site guard — flag ON (local eval build) injects a detectable flag', () => {
  afterAll(() => {
    jest.dontMock('../../config');
    jest.resetModules();
  });

  it('sealDM injects a stiq_fmd flag the eval recipient key detects', async () => {
    jest.resetModules();
    jest.doMock('../../config', () => ({...jest.requireActual('../../config'), FMD_EVAL_ENABLED: true}));
    // Re-require the whole chain under the mocked flag so identity, prototype and fmd agree on one
    // fresh module graph (the memoized eval keypair must be the SAME instance for send + detect).
    const {Identity: IdOn} = require('../../keys/identity');
    const {InMemorySecureStorage: StorageOn} = require('../../keys/keystore');
    const proto = require('./prototype');
    const {extractDetectionKey, testFlag} = require('./fmd');

    const id = await enrolledIdentity(IdOn, StorageOn);
    const peerPub = getPublicKey(generateSecretKey());
    const {wrap} = await id.sealDM(peerPub, 'flagged', undefined, LOW_POW);

    const flagTag = wrap.tags.find((t: string[]) => t[0] === proto.TAG_FMD);
    expect(flagTag).toBeDefined();

    // The memoized eval keypair for this peer detects the flag it just minted.
    const kp = proto.evalRecipientFmdKeypair(peerPub);
    const dk = extractDetectionKey(kp, kp.gamma);
    const fl = proto.readFmdFlag(wrap);
    expect(fl).not.toBeNull();
    expect(testFlag(dk, fl)).toBe(true);
  }, 30000);
});

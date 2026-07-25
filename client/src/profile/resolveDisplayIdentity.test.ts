import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type {Event} from 'nostr-tools/pure';
import {displayIdentityFor} from './resolveDisplayIdentity';
import {DisplayNameStore} from './displayName';
import {GradientStore} from './gradientIdentity';
import {gradientFromSeed, encodeGradient, randomGradient} from '../media/gradient';
import {toBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {setActiveCommunityKey} from '../blind/communityKey';
import {clearAuthorCache} from '../blind/identity';
import {mintGroupKey} from '../channels/groupCrypto';
import type {Token} from '../blind/wallet';

const communityKey = mintGroupKey();

function freshToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: Uint8Array.of(2), secret: q};
}

const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);
const authorNpub = nip19.npubEncode(authorPk);

function blindPostBy(
  sk: Uint8Array,
  meta: {name?: string; gradient?: string} = {},
  createdAt = 1000,
): Event {
  return toBlindEvent(
    {kind: 1, created_at: createdAt, tags: [], content: 'hi'},
    [freshToken()],
    sk,
    communityKey,
    meta,
  );
}

/** A plain (non-blind) event — no token tags, so resolveAuthor falls back to event.pubkey. */
function plainEvent(pubkey: string, createdAt = 1000): Event {
  return {
    id: 'e'.repeat(64),
    pubkey,
    kind: 1,
    created_at: createdAt,
    tags: [],
    content: '',
    sig: 's'.repeat(128),
  } as unknown as Event;
}

describe('displayIdentityFor — shared attribution resolver', () => {
  beforeEach(() => {
    clearAuthorCache();
    setActiveCommunityKey(communityKey);
  });
  afterAll(() => setActiveCommunityKey(null));

  it('a blind post carrying an attestation name renders named with an EMPTY phonebook', () => {
    const ev = blindPostBy(authorSk, {name: 'Alice'});
    const names = new DisplayNameStore(null);
    const grads = new GradientStore(null);
    const id = displayIdentityFor(ev, {names, grads});
    expect(id.pubkey).toBe(authorPk);
    expect(id.npub).toBe(authorNpub);
    expect(id.name).toBe('Alice');
  });

  it('a blind post carrying an attestation gradient renders it with an EMPTY phonebook', () => {
    const wire = encodeGradient(randomGradient(() => 0.3));
    const ev = blindPostBy(authorSk, {gradient: wire});
    const grads = new GradientStore(null);
    const id = displayIdentityFor(ev, {grads});
    expect(id.gradient).toEqual(grads.gradientFor(authorPk));
    expect(id.gradient).not.toEqual(gradientFromSeed(authorNpub));
  });

  it('teaches the phonebook from the attestation, keyed on the REAL pubkey — never the throwaway signer', () => {
    const ev = blindPostBy(authorSk, {name: 'Alice'});
    expect(ev.pubkey).not.toBe(authorPk); // signed by a fresh throwaway key
    const names = new DisplayNameStore(null);
    expect(names.nameFor(authorPk)).toBeUndefined();
    displayIdentityFor(ev, {names});
    // The real author's claim is now in the phonebook — not the throwaway's.
    expect(names.nameFor(authorPk)).toBe('Alice');
    expect(names.nameFor(ev.pubkey)).toBeUndefined();
  });

  it("an attested name that has already been won by an EARLIER claimant loses to the community's arbitration", () => {
    const impersonatorSk = generateSecretKey();
    const impersonatorPk = getPublicKey(impersonatorSk);
    const names = new DisplayNameStore(null);
    // The rightful owner claimed "Alice" first, at an earlier timestamp.
    void names.learn(authorPk, 'Alice', 500);
    // A blind post from a DIFFERENT pubkey attests the same name, claimed LATER.
    const ev = blindPostBy(impersonatorSk, {name: 'Alice'}, 900);
    const id = displayIdentityFor(ev, {names});
    // The impersonator's own attestation is NOT trusted outright — the phonebook's longest-held-wins
    // arbitration has the final say, and they lose it.
    expect(id.pubkey).toBe(impersonatorPk);
    expect(id.name).toBeUndefined();
  });

  it("self always renders their OWN current name, never a stale attestation or a lost arbitration", () => {
    const names = new DisplayNameStore(null);
    void names.setMyName('CurrentName');
    // My own blind post attests an OLD name from before I changed it.
    const ev = blindPostBy(authorSk, {name: 'OldName'});
    const id = displayIdentityFor(ev, {names, myPubkey: authorPk});
    expect(id.pubkey).toBe(authorPk);
    expect(id.name).toBe('CurrentName');
  });

  it('self gradient renders the live getMyGradient, not the attestation snapshot', () => {
    const grads = new GradientStore(null);
    const mine = randomGradient(() => 0.7);
    void grads.setMyGradient(mine);
    const ev = blindPostBy(authorSk, {gradient: encodeGradient(randomGradient(() => 0.1))});
    const id = displayIdentityFor(ev, {grads, myPubkey: authorPk});
    expect(id.gradient).toEqual(mine);
  });

  it('a non-blind post with no attestation and no phonebook entry falls back to npub + seed gradient', () => {
    const ev = plainEvent(authorPk);
    const names = new DisplayNameStore(null);
    const grads = new GradientStore(null);
    const id = displayIdentityFor(ev, {names, grads});
    expect(id.pubkey).toBe(authorPk);
    expect(id.npub).toBe(authorNpub);
    expect(id.name).toBeUndefined();
    expect(id.gradient).toEqual(gradientFromSeed(authorNpub));
  });

  it('with no stores injected at all, still resolves attestation-first, then npub + seed gradient', () => {
    const ev = blindPostBy(authorSk, {name: 'Alice'});
    const id = displayIdentityFor(ev, {});
    expect(id.pubkey).toBe(authorPk);
    expect(id.name).toBe('Alice'); // no phonebook to consult — the attestation is trusted directly
    expect(id.gradient).toEqual(gradientFromSeed(authorNpub)); // no gradient store — seed fallback
  });

  it('anonymity is impossible: pubkey/npub/gradient are always present even when nothing is known', () => {
    const ev = plainEvent(getPublicKey(generateSecretKey()));
    const id = displayIdentityFor(ev, {});
    expect(id.pubkey).toBeTruthy();
    expect(id.npub.startsWith('npub1')).toBe(true);
    expect(id.gradient).toBeDefined();
  });
});

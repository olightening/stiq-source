/**
 * The DM cover set is only as strong as its decoys' plausibility. These tests pin the property the
 * pool exists for: every pubkey it emits must be one the relay cannot recognise as "not a member" —
 * so a blind post's one-shot token pubkey (which the relay itself verified via `stiq_token`) must
 * never appear, and a real npub that authored an npub-signed kind must.
 */
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {GroupKind} from '../contracts';
import {TAG_TOKEN} from '../blind/protocol';
import {D_IDENTITY_BEACON, D_IDENTITY_PROFILE} from '../profile/identityDoc';
import {npubCoverPool, NPUB_SIGNED_KINDS} from './coverPool';
import {decoyPool} from '../nostr/subscriptionPlan';

function sign(sk: Uint8Array, kind: number, tags: string[][] = [], createdAt = 1): Event {
  return finalizeEvent({kind, created_at: createdAt, tags, content: 'x'}, sk);
}

/** A blind feed post: signed by its spent token's secret, carrying the token tag the relay checks. */
function blindPost(tokenSk: Uint8Array, createdAt = 1): Event {
  return finalizeEvent(
    {kind: Kind.Post, created_at: createdAt, tags: [[TAG_TOKEN, 'dG9rZW4=']], content: 'blind'},
    tokenSk,
  );
}

describe('npubCoverPool', () => {
  it('collects distinct real-npub authors of channel/group chat and identity carriers, excluding me', () => {
    const store = new InMemoryEventStore();
    const chanAuthor = generateSecretKey();
    const groupAuthor = generateSecretKey();
    const beaconAuthor = generateSecretKey();
    const profileAuthor = generateSecretKey();
    const me = generateSecretKey();

    store.save(sign(chanAuthor, Kind.LiveChat, [['a', '30311:x:y']], 1));
    store.save(sign(chanAuthor, Kind.LiveChat, [['a', '30311:x:y']], 2)); // same author twice → distinct
    store.save(sign(groupAuthor, GroupKind.Chat, [['h', 'g1']], 3));
    store.save(sign(beaconAuthor, Kind.AppData, [['d', D_IDENTITY_BEACON]], 4));
    store.save(sign(profileAuthor, Kind.AppData, [['d', D_IDENTITY_PROFILE]], 5));
    store.save(sign(me, Kind.LiveChat, [['a', '30311:x:y']], 6));

    expect(npubCoverPool(store, getPublicKey(me)).sort()).toEqual(
      [
        getPublicKey(chanAuthor),
        getPublicKey(groupAuthor),
        getPublicKey(beaconAuthor),
        getPublicKey(profileAuthor),
      ].sort(),
    );
  });

  it('THE POINT: a blind post’s token pubkey is never offered as a decoy — unlike decoyPool', () => {
    const store = new InMemoryEventStore();
    const token = generateSecretKey(); // stands in for hex(token0): a one-shot blind signer
    const realMember = generateSecretKey();
    const me = generateSecretKey();
    store.save(blindPost(token, 1));
    store.save(sign(realMember, Kind.LiveChat, [['a', '30311:x:y']], 2));

    // The pool subscriptionPlan uses today hands the relay the token pubkey as "cover"...
    expect(decoyPool(store, getPublicKey(me))).toEqual([getPublicKey(token)]);
    // ...which the relay recognises and subtracts. This pool emits only the real member.
    expect(npubCoverPool(store, getPublicKey(me))).toEqual([getPublicKey(realMember)]);
  });

  it('skips a token-signed event even if its KIND is on the npub-signed list (belt-and-braces)', () => {
    const store = new InMemoryEventStore();
    const token = generateSecretKey();
    store.save(sign(token, Kind.LiveChat, [['a', '30311:x:y'], [TAG_TOKEN, 'dG9rZW4=']], 1));
    expect(npubCoverPool(store, undefined)).toEqual([]);
  });

  it('accepts only the identity `d` tags on kind-30078 (org config / space settings are not members)', () => {
    const store = new InMemoryEventStore();
    const organizer = generateSecretKey();
    const admin = generateSecretKey();
    store.save(sign(organizer, Kind.AppData, [['d', 'stiq:org-config']], 1));
    store.save(sign(admin, Kind.AppData, [['d', 'space-settings']], 2));
    store.save(sign(admin, Kind.AppData, [], 3)); // no d tag at all
    expect(npubCoverPool(store, undefined)).toEqual([]);
  });

  it('degrades to an EMPTY pool rather than borrowing blind authors (plan then falls back to firehose)', () => {
    const store = new InMemoryEventStore();
    for (let i = 0; i < 10; i++) store.save(blindPost(generateSecretKey(), i + 1));
    expect(npubCoverPool(store, undefined)).toEqual([]);
    expect(decoyPool(store, undefined)).toHaveLength(10);
  });

  it('never lists a kind whose author can be a blind token pubkey', () => {
    // kind-1 posts, kind-1111 comments and kind-7 reactions all ride feedSigner (blind when a
    // community key is loaded), so they must stay off the list.
    for (const blindable of [Kind.Post, Kind.Comment, Kind.Reaction, Kind.Article, Kind.Poll]) {
      expect(NPUB_SIGNED_KINDS).not.toContain(blindable);
    }
  });
});

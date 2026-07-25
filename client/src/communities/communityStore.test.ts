import {
  CommunityStore,
  communityId,
  toEnrolledCommunity,
  normalizeEnrolledCommunity,
  dedupByOnionHost,
  effectiveMirrors,
  describeRelays,
  type EnrolledCommunity,
} from './communityStore';
import {InMemorySecureStorage} from '../keys/keystore';
import type {Community, RelayEntry} from '../onboarding/community';
import {walletKeyFingerprint} from '../blind/wallet';
import {MAX_MIRRORS} from '../onboarding/join';
import {onionHostOf} from '../tor/onionAuth';

/** The onion-host identity key describeRelays/effectiveMirrors use (56-char base32, no `.onion`). */
const host = (url: string): string => onionHostOf(url)!;

const ONION_A = `ws://${'a'.repeat(56)}.onion`;
const ONION_B = `ws://${'b'.repeat(56)}.onion`;
const ONION_C = `ws://${'c'.repeat(56)}.onion`;
const ONION_D = `ws://${'d'.repeat(56)}.onion`;
const ONION_E = `ws://${'e'.repeat(56)}.onion`;
const ONION_F = `ws://${'f'.repeat(56)}.onion`;
const ONION_G = `ws://${'g'.repeat(56)}.onion`;

function baseCommunity(overrides: Partial<EnrolledCommunity> = {}): EnrolledCommunity {
  return {id: communityId(ONION_A), relayUrl: ONION_A, ...overrides};
}

const COMM_A: Community = {
  relayUrl: ONION_A,
  issuerPublicKey: 'KEYA',
  name: 'Community A',
  organizerLabel: 'Alice',
  organizerPubkey: 'a'.repeat(64),
};

describe('communityId', () => {
  it('derives the onion host and ignores scheme/path', () => {
    expect(communityId(`${ONION_A}/?x=1`)).toBe(`${'a'.repeat(56)}.onion`);
    expect(communityId(ONION_A)).toBe(communityId(`wss://${'a'.repeat(56)}.onion`));
  });
});

describe('CommunityStore', () => {
  it('upserts and activates, then reads back active', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity(COMM_A));
    const active = await store.active();
    expect(active?.relayUrl).toBe(ONION_A);
    expect(active?.organizerLabel).toBe('Alice');
    expect(await store.activeRelayUrl('fallback')).toBe(ONION_A);
  });

  it('treats the same relay as one community (dedup on id) but updates organizer', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity(COMM_A));
    // second organizer on the SAME relay
    await store.upsert(
      toEnrolledCommunity({...COMM_A, organizerLabel: 'Bob', issuerPublicKey: 'KEYB'}),
    );
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.organizerLabel).toBe('Bob');
  });

  it('holds multiple distinct communities and switches active', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity(COMM_A));
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_B, issuerPublicKey: 'KEYB'}));
    expect((await store.list()).length).toBe(2);
    expect((await store.active())?.relayUrl).toBe(ONION_B); // last upsert is active
    await store.setActive(communityId(ONION_A));
    expect((await store.active())?.relayUrl).toBe(ONION_A);
  });

  it('falls back to the default relay when nothing is enrolled', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    expect(await store.activeRelayUrl('ws://default.onion')).toBe('ws://default.onion');
  });

  it('remove reassigns active and clear wipes everything', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity(COMM_A));
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_B, issuerPublicKey: 'KEYB'}));
    await store.remove(communityId(ONION_B));
    expect((await store.active())?.relayUrl).toBe(ONION_A);
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await store.active()).toBeNull();
  });

  it('a re-join whose code lacks communityKey does NOT erase a stored shared key', async () => {
    // First join carried the v3 shared community key…
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity({...COMM_A, communityKey: 'CKBASE64=='}));
    expect((await store.active())?.communityKey).toBe('CKBASE64==');
    // …a later re-join of the SAME community with a code that carried NO key (v2/dashboard) must NOT
    // wipe it — losing the key silently downgrades every blind post to non-blind (reported Bug 1).
    await store.upsert(toEnrolledCommunity({...COMM_A})); // COMM_A has no communityKey
    expect((await store.active())?.communityKey).toBe('CKBASE64==');
  });

  it('a re-join lacking tagPolicy does NOT erase a live-learned tagPolicy', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(
      toEnrolledCommunity({
        ...COMM_A,
        tagPolicy: {communityTags: ['news'], pinCommunityTags: true, allowMemberTags: true, maxTags: 5, tagScopes: {}},
      }),
    );
    await store.upsert(toEnrolledCommunity({...COMM_A})); // no tagPolicy on the re-join code
    expect((await store.active())?.tagPolicy?.maxTags).toBe(5);
  });

  it('an explicit communityKey: undefined on upsert cannot erase a stored key (guard)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity({...COMM_A, communityKey: 'SECRET=='}));
    // A hand-built record with an explicit undefined (bypassing toEnrolledCommunity's omission).
    await store.upsert({id: communityId(ONION_A), relayUrl: ONION_A, issuerPublicKey: 'KEYA', communityKey: undefined});
    expect((await store.active())?.communityKey).toBe('SECRET==');
  });

  it('never wipes storagePolicy when an incoming record omits it (absent-stays-absent, T16)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    const policy = {reactionCap: 500, timelineCap: 400, maxAgeDays: 30, collapseReplaceable: true};
    await store.upsert(baseCommunity({storagePolicy: policy}));
    expect((await store.active())?.storagePolicy).toEqual(policy);
    // A later upsert that carries no storagePolicy (unrelated partial, or org stopped publishing it)
    // must NOT erase the last-known caps — that would silently revert to the generous defaults.
    await store.upsert(baseCommunity());
    expect((await store.active())?.storagePolicy).toEqual(policy);
  });

  it('an explicit storagePolicy: undefined on upsert cannot erase a stored policy (guard)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    const policy = {timelineCap: 300};
    await store.upsert(baseCommunity({storagePolicy: policy}));
    await store.upsert({id: communityId(ONION_A), relayUrl: ONION_A, storagePolicy: undefined});
    expect((await store.active())?.storagePolicy).toEqual(policy);
  });

  it('a caller MAY intentionally replace storagePolicy by passing a new one (not erasure)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({storagePolicy: {timelineCap: 300}}));
    await store.upsert(baseCommunity({storagePolicy: {timelineCap: 250}}));
    expect((await store.active())?.storagePolicy).toEqual({timelineCap: 250});
  });

  it('toEnrolledCommunity omits absent optional fields (no undefined keys to clobber with)', () => {
    const minimal = toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: 'KEYA'});
    expect('communityKey' in minimal).toBe(false);
    expect('tagPolicy' in minimal).toBe(false);
    expect('organizerPubkey' in minimal).toBe(false);
    // Present fields are still carried.
    const full = toEnrolledCommunity({...COMM_A, communityKey: 'CK=='});
    expect(full.communityKey).toBe('CK==');
    expect(full.organizerPubkey).toBe('a'.repeat(64));
  });

  it('memoizes list()/activeId() within a session — repeat calls do not re-read storage', async () => {
    const storage = new InMemorySecureStorage();
    const store = new CommunityStore(storage);
    await store.upsert(toEnrolledCommunity(COMM_A));

    const getItemSpy = jest.spyOn(storage, 'getItem');
    // Several reads with nothing mutating storage in between — only the FIRST of each should hit storage.
    await store.list();
    await store.list();
    await store.activeId();
    await store.activeId();
    await store.active(); // active() composes activeId()+list(), both already warm
    expect(getItemSpy).toHaveBeenCalledTimes(2); // one list() read + one activeId() read, both memoized after

    getItemSpy.mockRestore();
  });

  it('a mutation invalidates the memo — the very next read observes the write', async () => {
    const storage = new InMemorySecureStorage();
    const store = new CommunityStore(storage);
    await store.upsert(toEnrolledCommunity(COMM_A));
    // Warm the memo.
    expect((await store.list()).length).toBe(1);
    expect(await store.activeId()).toBe(communityId(ONION_A));

    // upsert a second community — must invalidate both memos.
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_B, issuerPublicKey: 'KEYB'}));
    expect((await store.list()).length).toBe(2);
    expect(await store.activeId()).toBe(communityId(ONION_B));

    // setActive alone invalidates just the id memo, without touching the list memo's content.
    await store.setActive(communityId(ONION_A));
    expect(await store.activeId()).toBe(communityId(ONION_A));
    expect((await store.active())?.relayUrl).toBe(ONION_A);

    // remove invalidates both; clear resets to the fresh-instance state.
    await store.remove(communityId(ONION_B));
    expect((await store.list()).length).toBe(1);
    await store.clear();
    expect(await store.list()).toEqual([]);
    expect(await store.activeId()).toBeNull();
  });

  it('upsert never mutates a previously-returned list() reference (no shared-array aliasing)', async () => {
    const storage = new InMemorySecureStorage();
    const store = new CommunityStore(storage);
    await store.upsert(toEnrolledCommunity(COMM_A));
    const first = await store.list(); // memoized reference
    expect(first.length).toBe(1);

    await store.upsert(toEnrolledCommunity({relayUrl: ONION_B, issuerPublicKey: 'KEYB'}));

    // The array a caller captured before the mutation must be unaffected by it.
    expect(first.length).toBe(1);
    expect((await store.list()).length).toBe(2);
  });

  it('repairs an old-shape persisted community (tagPolicy w/o tagScopes, labels w/o appliesTo)', async () => {
    // Simulate a record written by an app version from before per-post-type scoping shipped: the
    // stored tagPolicy has no `tagScopes` and labels have no `appliesTo`. Reading it raw crashed
    // the composer at launch. The store must normalize both on read.
    const storage = new InMemorySecureStorage();
    const id = communityId(ONION_A);
    const oldRecord = {
      id,
      relayUrl: ONION_A,
      issuerPublicKey: 'KEYA',
      tagPolicy: {communityTags: ['news'], pinCommunityTags: true, allowMemberTags: true, maxTags: 0},
      labels: [{id: 'insight', name: 'Insight', color: '#6f90c0', order: 0}],
    };
    await storage.setItem('stiq.communities.list', JSON.stringify([oldRecord]));
    await storage.setItem('stiq.communities.active', id);

    const store = new CommunityStore(storage);
    const active = await store.active();
    expect(active?.tagPolicy?.tagScopes).toEqual({});
    expect(active?.labels?.[0]?.appliesTo).toBe('all');
    // The repaired policy no longer throws on the computed lookup that crashed render.
    expect(() => active?.tagPolicy?.tagScopes['news']).not.toThrow();
  });
});

// join-code v2: relay-independent identity (cid → identityKey), deferred enrollment key, and
// tolerated mirror list — see FEATURE_3_4_BUILD_CONTRACT.md.
describe('EnrolledCommunity — v2 identity + deferred issuer key', () => {
  it('toEnrolledCommunity OMITS issuerPublicKey when the community carries the "" deferred sentinel', () => {
    const deferred = toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: '', cid: 'a'.repeat(16)});
    expect('issuerPublicKey' in deferred).toBe(false);
    expect(deferred.identityKey).toBe('a'.repeat(16));
  });

  it('toEnrolledCommunity copies cid → identityKey, plus relays and advisoryExpiry', () => {
    const relays = [{url: ONION_A, onionAuthKey: null}, {url: ONION_B, onionAuthKey: 'A'.repeat(52)}];
    const out = toEnrolledCommunity({
      relayUrl: ONION_A,
      issuerPublicKey: 'KEYA',
      cid: 'deadbeefdeadbeef',
      relays,
      advisoryExpiry: 1999999999,
    });
    expect(out.identityKey).toBe('deadbeefdeadbeef');
    expect(out.relays).toEqual(relays);
    expect(out.advisoryExpiry).toBe(1999999999);
  });

  it('toEnrolledCommunity omits identityKey/relays/advisoryExpiry when the community lacks them', () => {
    const out = toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: 'KEYA'});
    expect('identityKey' in out).toBe(false);
    expect('relays' in out).toBe(false);
    expect('advisoryExpiry' in out).toBe(false);
  });

  it('D1 migrator: backfills identityKey from a resolved issuerPublicKey when absent', () => {
    const legacy = {id: communityId(ONION_A), relayUrl: ONION_A, issuerPublicKey: 'KEYA'};
    const normalized = normalizeEnrolledCommunity(legacy);
    expect(normalized.identityKey).toBe(walletKeyFingerprint('KEYA'));
  });

  it('D1 migrator: leaves an already-set identityKey untouched', () => {
    const record = {id: communityId(ONION_A), relayUrl: ONION_A, issuerPublicKey: 'KEYA', identityKey: 'preexisting'};
    const normalized = normalizeEnrolledCommunity(record);
    expect(normalized.identityKey).toBe('preexisting');
  });

  it('D1 migrator: stays undefined when there is no issuerPublicKey to derive from (still-deferred community)', () => {
    const record = {id: communityId(ONION_A), relayUrl: ONION_A};
    const normalized = normalizeEnrolledCommunity(record);
    expect(normalized.identityKey).toBeUndefined();
  });

  it('a re-join whose code still defers ik does NOT erase an already-resolved issuerPublicKey/identityKey', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: 'KEYA', cid: walletKeyFingerprint('KEYA')}));
    expect((await store.active())?.issuerPublicKey).toBe('KEYA');
    // Re-join with a v2 code that hasn't resolved the key yet (issuerPublicKey === '' sentinel;
    // toEnrolledCommunity omits both issuerPublicKey and identityKey for this record).
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: ''}));
    const active = await store.active();
    expect(active?.issuerPublicKey).toBe('KEYA');
    expect(active?.identityKey).toBe(walletKeyFingerprint('KEYA'));
  });

  it('storage id stays the onion host even once identityKey (cid) is known — no orphaned silo', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(toEnrolledCommunity({relayUrl: ONION_A, issuerPublicKey: 'KEYA', cid: 'cafecafecafecafe'}));
    const active = await store.active();
    expect(active?.id).toBe(communityId(ONION_A));
    expect(active?.identityKey).toBe('cafecafecafecafe');
  });
});

// P2 MirrorSet transport composition (synthesis §1.2) — pure relay-set ordering/dedup + the
// upsert guards that keep it additive-only. See FEATURE_3_4_BUILD_CONTRACT.md's anti-censorship
// invariant: an organizer must never be able to shrink a member's *effective* mirror set.
describe('dedupByOnionHost', () => {
  it('first occurrence wins, keyed on onion host not literal URL', () => {
    const entries: RelayEntry[] = [
      {url: ONION_A, onionAuthKey: 'FIRST'},
      {url: `wss://${'a'.repeat(56)}.onion`, onionAuthKey: 'SECOND'}, // same host, different scheme
      {url: `${ONION_A}/`, onionAuthKey: 'THIRD'}, // same host, trailing slash
      {url: ONION_B},
    ];
    const out = dedupByOnionHost(entries);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({url: ONION_A, onionAuthKey: 'FIRST'});
    expect(out[1]?.url).toBe(ONION_B);
  });

  it('falls back to trimmed lower-cased URL for non-onion entries', () => {
    const entries: RelayEntry[] = [{url: '  Ws://Example.test:1234  '}, {url: 'ws://example.test:1234'}];
    expect(dedupByOnionHost(entries).length).toBe(1);
  });
});

describe('effectiveMirrors', () => {
  it('orders primary, mirrorsUser, mirrorsKnownGood, seed (relays minus primary), mirrorsOrg', () => {
    const c = baseCommunity({
      onionAuthKey: 'PRIMARYKEY',
      mirrorsUser: [{url: ONION_B}],
      mirrorsKnownGood: [{url: ONION_C}],
      relays: [{url: ONION_A}, {url: ONION_D}], // primary host filtered out of the seed
      mirrorsOrg: [{url: ONION_E}],
    });
    const out = effectiveMirrors(c);
    expect(out.map(r => r.url)).toEqual([ONION_A, ONION_B, ONION_C, ONION_D, ONION_E]);
    expect(out[0]?.onionAuthKey).toBe('PRIMARYKEY');
  });

  it('org de-listing a mirror cannot drop a user/known-good/seed mirror from the effective set', () => {
    // Org previously included ONION_E; now its (fresh) mirrorsOrg omits it — but omission from
    // mirrorsOrg is not erasure of mirrorsUser/mirrorsKnownGood/relays, which stay untouched.
    const c = baseCommunity({
      mirrorsUser: [{url: ONION_B}],
      mirrorsKnownGood: [{url: ONION_C}],
      relays: [{url: ONION_D}],
      mirrorsOrg: [], // org "de-listed" everything it used to publish
    });
    const out = effectiveMirrors(c).map(r => r.url);
    expect(out).toEqual([ONION_A, ONION_B, ONION_C, ONION_D]);
  });

  it('org flooding mirrorsOrg past the cap cannot evict a user/known-good/seed mirror — org is always the truncated tail', () => {
    const c = baseCommunity({
      mirrorsUser: [{url: ONION_B}],
      mirrorsKnownGood: [{url: ONION_C}],
      relays: [{url: ONION_D}],
      // Org floods far more than would fit even alone.
      mirrorsOrg: [{url: ONION_E}, {url: ONION_F}, {url: ONION_G}, {url: `ws://${'h'.repeat(56)}.onion`}],
    });
    const out = effectiveMirrors(c).map(r => r.url);
    expect(out.length).toBe(MAX_MIRRORS);
    // Primary + user + known-good + seed (4 structurally-protected entries) all survive…
    expect(out).toEqual(expect.arrayContaining([ONION_A, ONION_B, ONION_C, ONION_D]));
    // …leaving exactly ONE leftover cap slot for org, filled by org's FIRST entry (stable order).
    expect(out).toEqual([ONION_A, ONION_B, ONION_C, ONION_D, ONION_E]);
  });

  it('host-level dedup collapses a ws:// vs trailing-slash duplicate across the mirror groups', () => {
    const c = baseCommunity({
      mirrorsUser: [{url: `${ONION_A}/`}], // same host as primary, different literal URL
      mirrorsKnownGood: [{url: `wss://${'b'.repeat(56)}.onion`}],
      relays: [{url: ONION_B}], // same host as the known-good entry above, different scheme
    });
    const out = effectiveMirrors(c).map(r => r.url);
    expect(out).toEqual([ONION_A, `wss://${'b'.repeat(56)}.onion`]);
  });

  it('with no mirror fields set, effectiveMirrors is just the primary (single-mirror / DARK default)', () => {
    const c = baseCommunity({onionAuthKey: 'K'});
    expect(effectiveMirrors(c)).toEqual([{url: ONION_A, onionAuthKey: 'K'}]);
  });

  it('a member mute subtracts a relay from the effective set (wins over every additive tier)', () => {
    const c = baseCommunity({
      mirrorsUser: [{url: ONION_B}],
      mirrorsOrg: [{url: ONION_E}],
      mirrorsBlocked: [{url: ONION_E}], // member closed the org-published mirror
    });
    expect(effectiveMirrors(c).map(r => r.url)).toEqual([ONION_A, ONION_B]);
  });

  it('mute is keyed on onion host (ws:// vs wss:// vs trailing-slash are the same relay)', () => {
    const c = baseCommunity({
      mirrorsUser: [{url: ONION_B}],
      mirrorsBlocked: [{url: `wss://${'b'.repeat(56)}.onion/`}],
    });
    expect(effectiveMirrors(c).map(r => r.url)).toEqual([ONION_A]);
  });

  it('the PRIMARY relay is never removed even if the member muted its host', () => {
    const c = baseCommunity({mirrorsBlocked: [{url: `wss://${'a'.repeat(56)}.onion`}]});
    expect(effectiveMirrors(c).map(r => r.url)).toEqual([ONION_A]);
  });
});

describe('CommunityStore.upsert — mirror-list absent-stays-absent guards', () => {
  it('never wipes mirrorsUser when an incoming record omits it', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({mirrorsUser: [{url: ONION_B}]}));
    expect((await store.active())?.mirrorsUser).toEqual([{url: ONION_B}]);
    await store.upsert(baseCommunity()); // re-join record carries no mirrorsUser at all
    expect((await store.active())?.mirrorsUser).toEqual([{url: ONION_B}]);
  });

  it('never wipes mirrorsKnownGood when an incoming record omits it', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({mirrorsKnownGood: [{url: ONION_C}]}));
    await store.upsert(baseCommunity());
    expect((await store.active())?.mirrorsKnownGood).toEqual([{url: ONION_C}]);
  });

  it('never wipes mirrorsOrg (or its mirrorsOrgAt) when an incoming record omits it', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({mirrorsOrg: [{url: ONION_E}], mirrorsOrgAt: 1000}));
    await store.upsert(baseCommunity());
    const active = await store.active();
    expect(active?.mirrorsOrg).toEqual([{url: ONION_E}]);
    expect(active?.mirrorsOrgAt).toBe(1000);
  });

  it('an explicit undefined on any mirror field cannot erase a stored value (guard, not just omission)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(
      baseCommunity({mirrorsUser: [{url: ONION_B}], mirrorsKnownGood: [{url: ONION_C}], mirrorsOrg: [{url: ONION_E}], mirrorsOrgAt: 5}),
    );
    await store.upsert({
      id: communityId(ONION_A),
      relayUrl: ONION_A,
      mirrorsUser: undefined,
      mirrorsKnownGood: undefined,
      mirrorsOrg: undefined,
    });
    const active = await store.active();
    expect(active?.mirrorsUser).toEqual([{url: ONION_B}]);
    expect(active?.mirrorsKnownGood).toEqual([{url: ONION_C}]);
    expect(active?.mirrorsOrg).toEqual([{url: ONION_E}]);
    expect(active?.mirrorsOrgAt).toBe(5);
  });

  it('a caller MAY still intentionally replace mirrorsOrg by passing a new list (not erasure)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({mirrorsOrg: [{url: ONION_E}], mirrorsOrgAt: 5}));
    await store.upsert(baseCommunity({mirrorsOrg: [{url: ONION_F}], mirrorsOrgAt: 10}));
    const active = await store.active();
    expect(active?.mirrorsOrg).toEqual([{url: ONION_F}]);
    expect(active?.mirrorsOrgAt).toBe(10);
  });

  it('never wipes mirrorsBlocked when an incoming record omits it (an org-config apply re-opens nothing)', async () => {
    const store = new CommunityStore(new InMemorySecureStorage());
    await store.upsert(baseCommunity({mirrorsBlocked: [{url: ONION_E}]}));
    await store.upsert(baseCommunity({mirrorsOrg: [{url: ONION_E}], mirrorsOrgAt: 1})); // org publishes it
    const active = await store.active();
    expect(active?.mirrorsBlocked).toEqual([{url: ONION_E}]); // mute survives
    expect(effectiveMirrors(active!).map(r => r.url)).toEqual([ONION_A]); // still not received
  });
});

describe('describeRelays', () => {
  it('tags each active relay with its trust-tier source, in effective order', () => {
    const c = baseCommunity({
      mirrorsUser: [{url: ONION_B}],
      mirrorsKnownGood: [{url: ONION_C}],
      relays: [{url: ONION_A}, {url: ONION_D}], // primary + one seed
      mirrorsOrg: [{url: ONION_E}],
    });
    const snap = describeRelays(c);
    expect(snap.active.map(r => [r.host, r.source])).toEqual([
      [host(ONION_A), 'primary'],
      [host(ONION_B), 'user'],
      [host(ONION_C), 'known-good'],
      [host(ONION_D), 'seed'],
      [host(ONION_E), 'organizer'],
    ]);
    expect(snap.muted).toEqual([]);
    expect(snap.atCap).toBe(true); // 5 = MAX_MIRRORS
    expect(snap.cap).toBe(MAX_MIRRORS);
  });

  it('lists a muted relay separately and excludes it from active, retaining its source tier', () => {
    const c = baseCommunity({
      mirrorsOrg: [{url: ONION_E}],
      mirrorsBlocked: [{url: ONION_E}],
    });
    const snap = describeRelays(c);
    expect(snap.active.map(r => r.host)).toEqual([host(ONION_A)]);
    expect(snap.muted.map(r => [r.host, r.source, r.muted])).toEqual([
      [host(ONION_E), 'organizer', true],
    ]);
  });
});

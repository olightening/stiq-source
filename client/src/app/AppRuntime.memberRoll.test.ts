// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so the
// runtime logic can be exercised in the test environment (same preamble as capsSticky).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {toBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {getActiveMemberRoll} from '../blind/memberRoll';
import {encryptForSpace} from '../channels/groupCrypto';
import {ORGANIZER_D_MEMBER_ROLL} from '../moderation/organizerConfig';
import {Kind} from '../nostr/events';
import type {Token} from '../blind/wallet';

/**
 * Member-roll enforcement, end-to-end through the runtime (ban-evasion fix, 2026-07-29).
 *
 * The hazard this pins: a blind post's `stiq_attr` attestation only ever proved control of SOME
 * key — never that the key was ever bound on the relay. So a banned member could mint a fresh npub
 * and reappear, and any member could mint unlimited fresh keys that each read as a distinct voter.
 * The organizer's encrypted stiq:member-roll doc closes both: a post whose attribution resolves off
 * the roll is hidden like an unattributed one.
 *
 * Contract pinned here:
 *   • no roll doc ⇒ ZERO behavior change (legacy communities, pre-sync window);
 *   • a live roll doc hides off-roll posts and keeps on-roll ones;
 *   • organizer + self are always exempt (neither appears in the relay's membership.json in time);
 *   • a republished roll unhides a newly-bound member's posts without a restart;
 *   • a community switch clears the roll (one community's roll must never gate another's).
 */
const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const CK_BYTES = new Uint8Array(32).fill(7);
const CK = Buffer.from(CK_BYTES).toString('base64');
const CK_B_BYTES = new Uint8Array(32).fill(9);
const CK_B = Buffer.from(CK_B_BYTES).toString('base64');

const organizerSk = generateSecretKey();
const ORG_PUBKEY = getPublicKey(organizerSk);

const memberSk = generateSecretKey();
const memberPk = getPublicKey(memberSk);
const rogueSk = generateSecretKey();
const roguePk = getPublicKey(rogueSk);

async function makeSession(relayUrl: string, communityKey: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl, issuerPublicKey: 'aXNz', organizerPubkey: ORG_PUBKEY, communityKey},
    new MockBlindRsa(),
    'STIQ-TEST-ROLL',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function freshToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: Uint8Array.of(2), secret: q};
}

/** A real blind post: throwaway signer + encrypted attribution to `sk`'s npub. */
function blindPostBy(sk: Uint8Array, content: string, key: Uint8Array = CK_BYTES): Event {
  return toBlindEvent({kind: 1, created_at: 1000, tags: [], content}, [freshToken()], sk, key, {
    name: 'someone',
  });
}

/** The organizer's encrypted roll doc naming `members`. */
function rollDoc(members: string[], createdAt: number, key: Uint8Array = CK_BYTES): Event {
  const payload = JSON.stringify({v: 1, members, updated_at: createdAt});
  return finalizeEvent(
    {
      kind: Kind.AppData,
      created_at: createdAt,
      tags: [['d', ORGANIZER_D_MEMBER_ROLL]],
      content: encryptForSpace(payload, key),
    },
    organizerSk,
  );
}

function newRuntime() {
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  return {runtime, store};
}

/** Ids visible in the feed right now. */
function visibleIds(runtime: AppRuntime): string[] {
  return runtime.getSnapshot().feed.items.map(i => i.id);
}

describe('member-roll enforcement (AppRuntime)', () => {
  it('with NO roll doc, an off-roll-looking post stays visible (legacy communities unchanged)', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');
    const rogue = blindPostBy(rogueSk, 'no roll yet');
    store.save(rogue);
    expect(getActiveMemberRoll()).toBeNull();
    expect(visibleIds(runtime)).toContain(rogue.id);
    runtime.dispose();
  });

  it('hides a post whose attribution is off the roll, keeps an on-roll one', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');

    const good = blindPostBy(memberSk, 'enrolled member');
    const rogue = blindPostBy(rogueSk, 'fresh-key sock puppet');
    store.save(good);
    store.save(rogue);
    store.save(rollDoc([memberPk], 2000));

    // The roll converges lazily, at the moment verdicts are computed (syncMemberRollFromStore runs
    // at the top of the feed build) — so read the feed first, then assert the roll is live.
    const ids = visibleIds(runtime);
    expect(getActiveMemberRoll()).not.toBeNull();
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(rogue.id);
    runtime.dispose();
  });

  it('exempts the organizer and the member themselves (neither is on the relay roll in time)', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');
    // A roll that names ONLY a third party — self + organizer must still be exempt.
    store.save(rollDoc([memberPk], 2000));
    visibleIds(runtime); // converge the roll (lazy sync at feed-build time)
    const roll = getActiveMemberRoll();
    expect(roll).not.toBeNull();
    expect(roll!.has(ORG_PUBKEY)).toBe(true);
    // Self-exemption: the member's OWN blind post must stay visible even though the roll (built
    // from the relay's membership.json at publish time) doesn't name them yet.
    const mine = blindPostBy(memberSk, 'my own post');
    store.save(mine);
    expect(visibleIds(runtime)).toContain(mine.id);
    runtime.dispose();
  });

  it('a republished roll unhides a newly-bound member without a restart', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');

    const late = blindPostBy(rogueSk, 'just enrolled');
    store.save(late);
    store.save(rollDoc([memberPk], 2000));
    expect(visibleIds(runtime)).not.toContain(late.id);

    // The organizer's 60s poll picks up the new bind and republishes:
    store.save(rollDoc([memberPk, roguePk], 3000));
    expect(visibleIds(runtime)).toContain(late.id);
    runtime.dispose();
  });

  it('ignores a roll doc signed by someone other than the organizer', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');
    const impostorSk = generateSecretKey();
    const forged = finalizeEvent(
      {
        kind: Kind.AppData,
        created_at: 2000,
        tags: [['d', ORGANIZER_D_MEMBER_ROLL]],
        content: encryptForSpace(JSON.stringify({v: 1, members: [memberPk], updated_at: 2000}), CK_BYTES),
      },
      impostorSk,
    );
    const rogue = blindPostBy(rogueSk, 'should stay visible — forged roll must not enforce');
    store.save(rogue);
    store.save(forged);
    expect(getActiveMemberRoll()).toBeNull();
    expect(visibleIds(runtime)).toContain(rogue.id);
    runtime.dispose();
  });

  it('clears the roll on a community switch (one community never gates another)', async () => {
    const {runtime, store} = newRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(RELAY_A, CK), '1234', '9999');
    store.save(rollDoc([memberPk], 2000));
    visibleIds(runtime); // converge the roll for community A
    expect(getActiveMemberRoll()).not.toBeNull();

    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await runtime.completeEnrollment(await makeSession(RELAY_B, CK_B), '1234', '9999');
    // Community B published no roll → enforcement defers there. (A's roll must NOT carry over,
    // even before B's first feed build.)
    expect(getActiveMemberRoll()).toBeNull();
    visibleIds(runtime);
    expect(getActiveMemberRoll()).toBeNull();
    runtime.dispose();
  });
});

/**
 * Space-reaction DEFAULTS audit (2026-07-22 "check if reactions in spaces work"):
 *
 * (a) A channel/group's one-tap reaction PALETTE (see channels/spaceRules.ts `resolveReactionPalette`)
 *     is EXACTLY what the owner configured, and an empty chip row when they configured nothing — the
 *     standard-set fallback this audit originally introduced was reverted the same day on owner
 *     directive (no emojis a space never chose). Pinned in channels/spaceRules.test.ts (the palette
 *     resolver is pure and doesn't need a live AppRuntime to test).
 *
 * (b) Per-message interaction gating (channels/interactions.ts channelPostInteractions/
 *     groupPostInteractions) used to hardcode BOTH comments and reactions CLOSED for any message with
 *     no owner override — so an admin's `defaultReactions: true` space rule (spaceRules.ts) was silently
 *     ignored; reactions stayed off everywhere until the owner opened them ONE MESSAGE AT A TIME. This
 *     suite pins the fix at the AppRuntime level: getChannelMessageInteractions/getGroupPostInteractions
 *     now resolve an un-overridden message's REACTIONS default from the space's own rule (comments
 *     still default closed, unchanged), while an explicit per-message owner override still wins outright.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {DEFAULT_SPACE_RULE_SET} from '../channels/spaceRules';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const ORG = 'a'.repeat(64);

/** A plain (non-blind) community — this suite is about local interaction-state resolution, not the
 *  token pipeline, so no community key / wallet is needed. */
const plainCommunity = (): Community => ({relayUrl: RELAY, issuerPublicKey: 'aXNz', organizerPubkey: ORG});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(plainCommunity(), new MockBlindRsa(), 'STIQ-TEST-REACTDEFAULTS');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime() {
  const secure = new InMemorySecureStorage();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new SwappableEventStore(new InMemoryEventStore()),
    createStore: async (): Promise<EventStore> => new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
  });
  return {runtime, secure, published};
}

async function enrolled() {
  const h = newRuntime();
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  return h;
}

const MSG_ID = 'e'.repeat(64);

describe('getChannelMessageInteractions — reactions default follows the space rule (comments still closed)', () => {
  it('an un-overridden message defaults reactions to the space rule\'s defaultReactions (true)', async () => {
    const {runtime} = await enrolled();
    const channelId = await runtime.createChannel({name: 'Announcements'});
    expect(channelId).toBeTruthy();

    await runtime.setSpaceSettings(channelId!, {rules: {...DEFAULT_SPACE_RULE_SET, defaultReactions: true}});

    const perm = runtime.getChannelMessageInteractions(channelId!, MSG_ID);
    expect(perm.reactions).toBe(true);
    expect(perm.comments).toBe(false); // comments default is unchanged by this fix
    runtime.dispose();
  });

  it('an un-overridden message stays CLOSED when the space rule never turned reactions on (unconfigured space)', async () => {
    const {runtime} = await enrolled();
    const channelId = await runtime.createChannel({name: 'Quiet'});
    expect(channelId).toBeTruthy();
    // No settings doc published at all — resolves to DEFAULT_SPACE_RULE_SET.defaultReactions (false).

    const perm = runtime.getChannelMessageInteractions(channelId!, MSG_ID);
    expect(perm).toEqual({comments: false, reactions: false});
    runtime.dispose();
  });

  it('an explicit per-message owner override still wins over the space default', async () => {
    const {runtime} = await enrolled();
    const channelId = await runtime.createChannel({name: 'Mixed'});
    expect(channelId).toBeTruthy();
    await runtime.setSpaceSettings(channelId!, {rules: {...DEFAULT_SPACE_RULE_SET, defaultReactions: true}});

    // Owner explicitly closes reactions on THIS one message.
    await runtime.setChannelInteractions(MSG_ID, {comments: false, reactions: false});

    const perm = runtime.getChannelMessageInteractions(channelId!, MSG_ID);
    expect(perm.reactions).toBe(false); // the per-message override wins, not the space default
    runtime.dispose();
  });
});

describe('getGroupPostInteractions — reactions default follows the space rule (comments still closed)', () => {
  it('an un-overridden message defaults reactions to the space rule\'s defaultReactions (true)', async () => {
    const {runtime} = await enrolled();
    const groupId = await runtime.createGroup({name: 'Crew'});
    expect(groupId).toBeTruthy();

    await runtime.setSpaceSettings(groupId!, {rules: {...DEFAULT_SPACE_RULE_SET, defaultReactions: true}});

    const perm = runtime.getGroupPostInteractions(groupId!, MSG_ID);
    expect(perm.reactions).toBe(true);
    expect(perm.comments).toBe(false);
    runtime.dispose();
  });

  it('an un-overridden message stays CLOSED when the space rule never turned reactions on', async () => {
    const {runtime} = await enrolled();
    const groupId = await runtime.createGroup({name: 'Quiet crew'});
    expect(groupId).toBeTruthy();

    const perm = runtime.getGroupPostInteractions(groupId!, MSG_ID);
    expect(perm).toEqual({comments: false, reactions: false});
    runtime.dispose();
  });

  it('an explicit per-message admin override still wins over the space default', async () => {
    const {runtime} = await enrolled();
    const groupId = await runtime.createGroup({name: 'Mixed crew'});
    expect(groupId).toBeTruthy();
    await runtime.setSpaceSettings(groupId!, {rules: {...DEFAULT_SPACE_RULE_SET, defaultReactions: true}});

    await runtime.setGroupInteractions(groupId!, MSG_ID, {comments: false, reactions: false});

    const perm = runtime.getGroupPostInteractions(groupId!, MSG_ID);
    expect(perm.reactions).toBe(false);
    runtime.dispose();
  });
});

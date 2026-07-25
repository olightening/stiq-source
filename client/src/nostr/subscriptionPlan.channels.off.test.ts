// SCOPED_CHANNEL_SYNC forced OFF. This file used to read the real config, because OFF was the
// committed default; the flag was flipped ON on 2026-07-15 once the relay precondition was verified,
// so the mock moved here and the tripwire moved to subscriptionPlan.channels.on.test.ts (which now
// reads the real config). jest.mock hoists above the imports — the same pattern
// MainScreen.authorNote.on.test.tsx uses for AUTHOR_NOTE_ENABLED.
jest.mock('../config', () => ({...jest.requireActual('../config'), SCOPED_CHANNEL_SYNC: false}));

/**
 * Bug 8 — the SCOPED_CHANNEL_SYNC contract, OFF side: the SUPPORTED ROLLBACK, not the shipped state.
 *
 * OFF is no longer what ships, but it is not dead either — it is the one-const revert if scoped sync
 * ever has to be backed out (e.g. a relay that stops serving `#a`-filtered 1311, or a community that
 * needs channel discovery to keep streaming). So its contract still has to hold, and it is still the
 * strong one: with the flag off, bug 8 changes NOTHING — kind 1311 rides the unscoped firehose, no
 * `channels` sub is emitted, and every derived kind list resolves to exactly the array it resolved to
 * before this round. A rollback that half-works is worse than no rollback, because it is only ever
 * reached in an incident.
 *
 * The flag's committed value is pinned in subscriptionPlan.channels.on.test.ts, which deliberately
 * does NOT mock the config; that is the file that fails if someone flips the const by accident.
 * Separate files rather than jest.resetModules() inside one: the module derives its kind sets from
 * the flag at import time, so the flag must be settled before first evaluation.
 */
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {
  createFeedAndDmPlan,
  buildLiveFeedFilter,
  buildFeedFilter,
  buildReconcileFilter,
  buildCoverSet,
  buildCoverSetFor,
  FIREHOSE_FEED_KINDS,
  TEXT_ONLY_FEED_KINDS,
  FEED_KINDS,
} from './subscriptionPlan';
import {InMemoryEventStore} from './store';
import {Kind} from './events';

function postBy(sk: Uint8Array, createdAt: number): Event {
  return finalizeEvent({kind: Kind.Post, created_at: createdAt, tags: [], content: 'x'}, sk);
}

const CH = (n: number): string => `30311:${'f'.repeat(64)}:c${n}`;

describe('SCOPED_CHANNEL_SYNC OFF — the rollback is byte-identical to before bug 8', () => {
  it('the firehose kind set IS FEED_KINDS — the same array identity, not a copy', () => {
    // Identity, not just equality: flag-off must not even allocate a different array, so nothing
    // downstream can start behaving differently because it compared by reference.
    expect(FIREHOSE_FEED_KINDS).toBe(FEED_KINDS);
    expect(FIREHOSE_FEED_KINDS).toContain(Kind.LiveChat);
  });

  it('every firehose filter still asks for channel messages, exactly as it did before bug 8', () => {
    const store = new InMemoryEventStore();
    expect(buildLiveFeedFilter().kinds).toContain(Kind.LiveChat);
    expect(buildFeedFilter(store).kinds).toContain(Kind.LiveChat);
    expect(buildReconcileFilter(store, {}).kinds).toContain(Kind.LiveChat);
    expect(TEXT_ONLY_FEED_KINDS).toContain(Kind.LiveChat);
  });

  it('emits NO channels sub even when the channel getters are wired', () => {
    // App.tsx wires getJoinedChannelIds/getKnownChannelIds unconditionally (they are inert when the
    // flag is off), so "the getters are present" must NOT be what turns the sub on.
    const store = new InMemoryEventStore();
    Array.from({length: 6}, () => generateSecretKey()).forEach((sk, i) => store.save(postBy(sk, i + 1)));
    const me = getPublicKey(generateSecretKey());
    const plan = createFeedAndDmPlan({
      store,
      getMyPubkey: () => me,
      getJoinedChannelIds: () => [CH(1), CH(2)],
      getKnownChannelIds: () => [CH(1), CH(2), CH(3), CH(4), CH(5), CH(6)],
    });
    const subs = plan();
    expect(subs.find(s => s.subId === 'channels')).toBeUndefined();
    // …and the feed sub still carries 1311 itself, so channel messages keep arriving as they do today.
    expect(subs.find(s => s.subId === 'feed')!.filter.kinds).toContain(Kind.LiveChat);
  });

  it('buildCoverSet is unchanged by the generalization (it is buildCoverSetFor(me, [me], …))', () => {
    // The refactor is only safe if the DM/self-list/space-key cover set is literally the same value.
    const pool = ['d1', 'd2', 'd3', 'd4', 'd5'];
    expect(buildCoverSet('me', pool, 3)).toEqual(buildCoverSetFor('me', ['me'], pool, 3));
    // …including through the `sample` seam.
    const takeFirst = <T,>(arr: readonly T[], n: number): T[] => arr.slice(0, n);
    expect(buildCoverSet('me', pool, 2, takeFirst)).toEqual(
      buildCoverSetFor('me', ['me'], pool, 2, takeFirst),
    );
  });
});

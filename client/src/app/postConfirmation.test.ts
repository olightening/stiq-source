/**
 * "Posted" confirmation — AppSnapshot.postsDelivered may move ONLY when the relay has genuinely
 * taken one of the user's own posts.
 *
 * This counter is the sole trigger of the app's success toast (App.tsx's <Toast/>), so these tests
 * are the guard on the exact failure that got the ORIGINAL "✓ Posted / Your post is live in the
 * community feed" overlay deleted: it fired unconditionally on the publish tap, including for writes
 * that went on to FAIL — announcing success moments before "Couldn't post right now" contradicted
 * it. The composer cannot know the outcome (it closes on the tap and deliberately never waits for
 * the multi-second Tor blind draw — that wait was the "publish tap hangs" bug), so the confirmation
 * had to be driven from the delivery machinery instead. Everything below asserts it stayed there.
 *
 * The invariant, in one line: postsDelivered increments in AppRuntime.confirmDelivery and nowhere
 * else, only for an id signPendingWrite registered as a POST, and only when the outbox actually
 * records that id as 'confirmed'.
 */
// Send jitter (TIMING_JITTER) ships default-ON but only defers the WIRE send by a bounded random
// delay — orthogonal to every assertion here, and it would race the 0ms flush(). Disabled exactly as
// optimistic.test.ts does it; every other flag keeps its real value via requireActual.
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {PUBLISH_TIMEOUT_MESSAGE} from '../nostr/RelayClient';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import type {Session} from '../onboarding/enrollment';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const community = {relayUrl: RELAY_A, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSessionFor(relayUrl: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl, issuerPublicKey: 'aXNz'},
    new MockBlindRsa(),
    'STIQ-TEST-0001',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

const makeSession = (): Promise<Session> => makeSessionFor(community.relayUrl);

/** An enrolled, unlocked runtime whose relay answers every publish with `reply`. */
async function runtimeWith(
  reply: () => Promise<{accepted: boolean; message: string; offline?: boolean}>,
): Promise<AppRuntime> {
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store: new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: reply,
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return runtime;
}

const delivered = (runtime: AppRuntime): number => runtime.getSnapshot().postsDelivered;

describe('postsDelivered counts relay-confirmed posts — and nothing else', () => {
  it('starts at zero and increments once when the relay accepts the post', async () => {
    const runtime = await runtimeWith(async () => ({accepted: true, message: 'ok'}));
    expect(delivered(runtime)).toBe(0); // nothing posted yet — a fresh app must never confirm

    await runtime.post('hello world', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'hello world');
    expect(snap.sendStatus.get(item!.id)).toBe('confirmed'); // the relay genuinely took it…
    expect(snap.postsDelivered).toBe(1); // …so, and only so, the confirmation is earned
    runtime.dispose();
  });

  it('does NOT count a post that is still in flight — the tap alone confirms nothing', async () => {
    // The exact shape of the deleted overlay's bug: the write has STARTED (post() has returned, the
    // composer has closed, the placeholder is in the feed) but the relay has not answered. Anything
    // that fires here is guessing.
    const acks: Array<(v: {accepted: boolean; message: string}) => void> = [];
    let gate = false;
    const runtime = await runtimeWith(() =>
      gate ? new Promise(res => acks.push(res)) : Promise.resolve({accepted: true, message: 'ok'}),
    );
    gate = true;

    await runtime.post('still flying', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'still flying');
    expect(item).toBeDefined(); // rendered optimistically…
    expect(snap.sendStatus.get(item!.id)).toBe('sending'); // …but not delivered
    expect(snap.postsDelivered).toBe(0); // NOTHING is claimed while the outcome is unknown

    // And a real answer, when it finally comes, is what counts it.
    acks.forEach(ack => ack({accepted: true, message: 'ok'}));
    await flush();
    expect(delivered(runtime)).toBe(1);
    runtime.dispose();
  });

  it('does NOT count a permanently REJECTED post', async () => {
    const runtime = await runtimeWith(async () => ({accepted: false, message: 'blocked: rejected'}));
    await runtime.post('rejected post', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'rejected post');
    expect(snap.sendStatus.get(item!.id)).toBe('rejected');
    expect(snap.postsDelivered).toBe(0); // red "failed" + Cancel is the whole story; no toast
    runtime.dispose();
  });

  it('does NOT count a FAILED post — not on the failure, not on any local resend, and not on any later timer', async () => {
    jest.useFakeTimers();
    try {
      const runtime = await runtimeWith(async () => ({accepted: false, message: PUBLISH_TIMEOUT_MESSAGE}));
      await runtime.post('timed out post', []);

      // The first ambiguous timeout self-schedules a local resend (finding #dms) rather than settling
      // straight to 'failed' — still not delivered either way.
      const item = runtime.getSnapshot().feed.items.find(i => i.content === 'timed out post');
      expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('sending');
      expect(runtime.getSnapshot().postsDelivered).toBe(0);

      // Walk the whole local backoff ladder (4/8/16/32s) — every attempt is still ambiguous, so it
      // eventually settles to genuinely 'failed'. Not delivered at any point along the way.
      await jest.advanceTimersByTimeAsync(4_000);
      expect(delivered(runtime)).toBe(0);
      await jest.advanceTimersByTimeAsync(8_000);
      expect(delivered(runtime)).toBe(0);
      await jest.advanceTimersByTimeAsync(16_000);
      expect(delivered(runtime)).toBe(0);
      await jest.advanceTimersByTimeAsync(32_000);
      expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('failed');
      expect(delivered(runtime)).toBe(0);

      // The delivered counter is not a delayed reflex on the publish tap: letting more time pass (the
      // old overlay's POST_DELAY_MS floor was 900ms) must not turn a failure into a confirmation.
      await jest.advanceTimersByTimeAsync(50);
      expect(delivered(runtime)).toBe(0);
      runtime.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT count a post queued while the relay is offline — until the reconnect lands it', async () => {
    let online = false;
    const runtime = await runtimeWith(async () =>
      online
        ? {accepted: true, message: 'ok'}
        : {accepted: false, message: 'relay not connected', offline: true},
    );

    await runtime.post('queued while connecting', []);
    await flush();
    expect(delivered(runtime)).toBe(0); // waiting for a relay is not success

    online = true;
    await runtime.onRelayConnected();
    await flush();
    expect(delivered(runtime)).toBe(1); // now it really is posted
    runtime.dispose();
  });

  it('counts a retried post exactly once, when the retry finally lands', async () => {
    let accept = false;
    const runtime = await runtimeWith(async () =>
      accept ? {accepted: true, message: 'ok'} : {accepted: false, message: PUBLISH_TIMEOUT_MESSAGE},
    );

    await runtime.post('retry me', []);
    await flush();
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'retry me')!;
    expect(delivered(runtime)).toBe(0);

    accept = true;
    await runtime.retry(item.id);
    await flush();
    expect(delivered(runtime)).toBe(1);

    // A redundant echo of an already-confirmed post must not double-count: markEchoed → the SAME
    // confirmDelivery, and the registration is consumed exactly once.
    runtime.markEchoed(item.id);
    await flush();
    expect(delivered(runtime)).toBe(1);
    runtime.dispose();
  });

  it('does NOT count a CANCELLED post whose ack lands late', async () => {
    // The user gave up on a failed post and dismissed it. A straggling ack must not congratulate
    // them on a post that is no longer theirs.
    const acks: Array<(v: {accepted: boolean; message: string}) => void> = [];
    let gate = false;
    const runtime = await runtimeWith(() =>
      gate ? new Promise(res => acks.push(res)) : Promise.resolve({accepted: true, message: 'ok'}),
    );
    gate = true;

    await runtime.post('never mind', []);
    await flush();
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'never mind')!;

    await runtime.cancelSend(item.id);
    acks.forEach(ack => ack({accepted: true, message: 'ok'}));
    await flush();

    expect(delivered(runtime)).toBe(0);
    runtime.dispose();
  });

  it('does NOT count non-post writes: a COMMENT, a pinned note and a vote all land silently', async () => {
    // Everything the user writes rides the same outbox and the same confirmDelivery, and a comment
    // and a pinned note ride the very same signPendingWrite pipeline a post does — only the `type`
    // gate separates them. That gate is the whole reason a thread doesn't fire "Posted" at you: a
    // comment leaves you looking at it, with its own SendProgress attached, so a floating
    // confirmation would only shout what the row under your thumb already says.
    const runtime = await runtimeWith(async () => ({accepted: true, message: 'ok'}));
    await runtime.post('a post to reply to', []);
    await flush();
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'a post to reply to')!;
    const afterPost = delivered(runtime);
    expect(afterPost).toBe(1); // the post itself confirmed, as it should

    const ref = {id: item.id, pubkey: item.author, kind: item.kind};
    await runtime.comment('a reply', ref, ref);
    await flush();
    expect(delivered(runtime)).toBe(afterPost); // the comment landed, and said nothing

    await runtime.setPinnedComment(item.id, item.author, item.kind, "author's note");
    await flush();
    expect(delivered(runtime)).toBe(afterPost);

    await runtime.vote(item.id, item.author, 'up');
    await flush();
    expect(delivered(runtime)).toBe(afterPost);
    runtime.dispose();
  });

  it('does NOT confirm a post in the community you SWITCHED TO while it was still in flight', async () => {
    // The one case cancelSend's own bookkeeping can't cover, and the reason confirmDelivery gates on
    // the outbox rather than on merely being reached: a switch RELOADS the outbox per identity slot,
    // dropping A's queue, while A's delivery is still parked on an unanswered publish. When the ack
    // finally lands, the user is looking at community B — and a "✓ Posted" floating over B for a post
    // that went to A is a lie about where their words went, in an app whose whole point is that the
    // two silos never touch.
    const acks: Array<(v: {accepted: boolean; message: string}) => void> = [];
    let gate = false;
    const stores = new Map<string, EventStore>();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new SwappableEventStore(new InMemoryEventStore()),
      createStore: async (cid: string | null) => {
        const key = cid ?? '__none__';
        let store = stores.get(key);
        if (!store) {
          store = new InMemoryEventStore();
          stores.set(key, store);
        }
        return store;
      },
      hash: identityHash,
      autoLockMs: 60_000,
      publish: () =>
        gate ? new Promise(res => acks.push(res)) : Promise.resolve({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');

    // Post into A; its delivery parks on the gated publish (the real-world case: a slow Tor circuit).
    gate = true;
    await runtime.post('from-A', []);
    await flush();
    expect(delivered(runtime)).toBe(0);

    // Join + switch to B, then let A's ack finally land.
    gate = false;
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    await runtime.submitPin('1234');
    expect(runtime.getSnapshot().feed.items.map(i => i.content)).not.toContain('from-A'); // siloed
    acks.forEach(ack => ack({accepted: true, message: 'ok'}));
    await flush();

    expect(delivered(runtime)).toBe(0); // B says nothing about A's post

    // And switching BACK doesn't retroactively announce it either — the moment has passed, and a
    // confirmation for a post made minutes ago is noise, not news.
    await runtime.switchCommunity(communityId(RELAY_A));
    await flush();
    expect(delivered(runtime)).toBe(0);
    runtime.dispose();
  });

  it('counts each post in a burst, so two landing together are one signal each — never a lost one', async () => {
    const runtime = await runtimeWith(async () => ({accepted: true, message: 'ok'}));
    await runtime.post('first', []);
    await runtime.post('second', []);
    await flush();
    // Two genuine landings ⇒ the counter moves twice. Coalescing them into ONE visible toast is the
    // Toast component's job (a burst restarts the single toast rather than stacking two) — the
    // runtime's job is to report the truth, not to de-duplicate it. See Toast.test.tsx.
    expect(delivered(runtime)).toBe(2);
    runtime.dispose();
  });
});

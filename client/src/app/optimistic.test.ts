/**
 * Optimistic-design guarantee: a composed post is cached and rendered BEFORE the relay
 * acknowledges it (the UI never blocks on Tor). Its outbox status flips sending → accepted →
 * confirmed the moment the relay returns OK 'accepted' — confirmation is OK-driven, NOT gated on
 * the event echoing back via the live feed subscription (see AppRuntime.deliver()): that
 * subscription's `since` advances over time and a blind post's back-dated created_at can land
 * below it, so waiting for the echo could leave the ring stuck at "accepted" forever even though
 * the relay had already stored the post. markEchoed() remains a harmless redundant confirm for
 * an id the outbox may already have dropped.
 */
// Send jitter (TIMING_JITTER) ships default-ON, but it is a WIRE-timing-only defense orthogonal to
// these delivery-classification assertions; the tests await a 0ms flush() and would otherwise race the
// bounded (150–2500ms) jitter timer. Disable it here so flush() still observes the publish outcome; the
// jitter behavior itself is covered in AppRuntime.jitter.test.ts. Every other flag (incl.
// TRUST_RELAY_REJECT_CODES) keeps its real value via requireActual.
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
}));

import {AppRuntime} from './AppRuntime';
import {sortFeed} from '../feed/sort';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {PUBLISH_TIMEOUT_MESSAGE} from '../nostr/RelayClient';
import {defaultRelayCapabilities} from '../nostr/capabilities';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import type {Session} from '../onboarding/enrollment';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) {
    throw new Error('enrollment failed in setup');
  }
  return result.session;
}

describe('optimistic writes', () => {
  it('caches and renders a post before the relay acknowledges, then marks it sent', async () => {
    // Gate only the POST publish; enrollment's binding publish must resolve normally.
    const gatedAcks: Array<(v: {accepted: boolean; message: string}) => void> = [];
    let gatePost = false;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: () =>
        gatePost
          ? new Promise(res => gatedAcks.push(res))
          : Promise.resolve({accepted: true, message: 'ok'}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    gatePost = true;

    // Compose a post. The relay publish is still pending (gate unresolved)...
    await runtime.post('hello world', ['news']);

    // ...yet the post is already in the feed (optimistic) and marked "sending".
    const optimistic = runtime.getSnapshot();
    const item = optimistic.feed.items.find(i => i.content === 'hello world');
    expect(item).toBeDefined();
    expect(optimistic.sendStatus.get(item!.id)).toBe('sending');

    // Relay accepts (OK) → status goes straight to "confirmed"; a live-feed echo is NOT required
    // (regression guard for the stuck-"accepted" bug: a since-bounded feed REQ may never echo a
    // back-dated blind post back to the sender).
    gatedAcks.forEach(ack => ack({accepted: true, message: 'ok'}));
    await flush();
    expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('confirmed');

    // A later echo (if the feed subscription does happen to carry it) is a harmless no-op — it
    // must not throw or resurrect an already-confirmed/removed outbox entry.
    expect(() => runtime.markEchoed(item!.id)).not.toThrow();
    expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('confirmed');

    runtime.dispose();
  });

  it('orders the viewer\'s own rapid posts newest-first via LOCAL order, and never leaks sortAt to the wire', async () => {
    // Two posts made back-to-back. Each is signed as a blind post whose WIRE created_at is bucket-
    // fuzzed (blindPost.fuzzBlindCreatedAt, audit #48) and can therefore INVERT for same-bucket posts.
    // _ownPostOrder captures the true local publish order → FeedItem.sortAt so the 'new' sort still
    // puts the latest on top, while the fuzzed wire timestamp is left completely untouched.
    const published: Array<{created_at: number; hasSortAt: boolean}> = [];
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async event => {
        published.push({created_at: event.created_at, hasSortAt: 'sortAt' in event});
        return {accepted: true, message: 'ok'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    await runtime.post('first post', []);
    await runtime.post('second post', []);
    await flush();

    const items = runtime.getSnapshot().feed.items;
    const first = items.find(i => i.content === 'first post')!;
    const second = items.find(i => i.content === 'second post')!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Local publish order is strictly monotonic: the later post's sortAt is greater, independent of
    // how the fuzzed wire created_at landed.
    expect(first.sortAt).toBeDefined();
    expect(second.sortAt).toBeDefined();
    expect(second.sortAt!).toBeGreaterThan(first.sortAt!);

    // So even if we FORCE the wire created_at to invert (the exact case the fuzz can produce), the
    // 'new' sort still renders the latest post on top.
    const invertedWire = [
      {...first, createdAt: 2000},
      {...second, createdAt: 1000}, // later post, yet SMALLER wire created_at
    ];
    expect(sortFeed(invertedWire, 'new').map(i => i.content)).toEqual(['second post', 'first post']);

    // Wire-safety / linkability invariant: sortAt is a render-model field ONLY — it must NEVER ride
    // onto a published event, and the fuzz on the emitted created_at is untouched (≤ now).
    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(published.every(p => p.hasSortAt === false)).toBe(true);

    runtime.dispose();
  });

  it('marks a relay-rejected write terminal: kept with its reason, no auto-resend, manual retry still fires', async () => {
    // The relay was reachable and returned an OK frame saying no (a genuine rejection). Re-sending the
    // same signed event with its stale blind token just earns the same "no" — the B1 defect where a
    // rejected post got re-uploaded over Tor on every reconnect. It must become TERMINAL 'rejected'.
    const published: string[] = [];
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async event => {
        published.push(event.id);
        return {accepted: false, message: 'blocked: rejected'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    await runtime.post('rejected post', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'rejected post');
    expect(item).toBeDefined(); // optimistic copy kept
    expect(snap.sendStatus.get(item!.id)).toBe('rejected'); // terminal, not 'failed'
    expect(snap.sendReasons.get(item!.id)).toBe('blocked: rejected'); // reason surfaced to the UI

    const postPublishes = () => published.filter(id => id === item!.id).length;
    expect(postPublishes()).toBe(1);

    // A reconnect + resend sweep must NOT re-upload a rejected write (the Tor-bandwidth bug).
    await runtime.onRelayConnected();
    await runtime.resendUnsent();
    await flush();
    expect(postPublishes()).toBe(1); // unchanged — excluded from the auto-resend set
    expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('rejected');

    // …but a user-initiated Retry still re-sends it (retry() looks it up by id, not via unsent()).
    await runtime.retry(item!.id);
    await flush();
    expect(postPublishes()).toBe(2);

    runtime.dispose();
  });

  it('keeps a TRANSIENT OK-rejection retryable (failed + auto-resent) — not terminal like a permanent one', async () => {
    // The relay returned an OK frame saying no, but with a transient reason (rate-limit): a fresh
    // attempt may well land, so classifyRejection marks it retryable → 'failed' (stays in unsent(),
    // auto-resent on reconnect + Retry live), NOT terminal 'rejected'.
    const published: string[] = [];
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async event => {
        published.push(event.id);
        return {accepted: false, message: 'rate-limited: slow down'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    await runtime.post('rate limited post', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'rate limited post');
    expect(item).toBeDefined();
    expect(snap.sendStatus.get(item!.id)).toBe('failed'); // transient → retryable, NOT 'rejected'

    const before = published.filter(id => id === item!.id).length;
    // A reconnect + resend sweep DOES re-upload a transient failure (unlike a permanent rejection).
    await runtime.onRelayConnected();
    await runtime.resendUnsent();
    await flush();
    expect(published.filter(id => id === item!.id).length).toBeGreaterThan(before); // auto-resent

    runtime.dispose();
  });

  it('keeps an ambiguous timeout retryable (self-resends locally, then still auto-resent on reconnect) — only a real OK-rejection is terminal', async () => {
    // A publishShared timeout returns {accepted:false, message:'timeout'} with no OK frame: we don't
    // know if the relay got it, so it must stay retryable — NEVER terminal like a genuine OK-rejection.
    // It now self-drives the same bounded local backoff ladder every other ambiguous/offline write
    // gets (finding #dms), showing the quiet 'sending' affordance while attempts remain, and only
    // settles to 'failed' once that ladder is exhausted — at which point a reconnect sweep still
    // resends it, same as before.
    jest.useFakeTimers();
    try {
      const published: string[] = [];
      const runtime = new AppRuntime({
        secureStorage: new InMemorySecureStorage(),
        store: new InMemoryEventStore(),
        hash: identityHash,
        autoLockMs: 60_000,
        publish: async event => {
          published.push(event.id);
          return {accepted: false, message: PUBLISH_TIMEOUT_MESSAGE};
        },
      });
      await runtime.init();
      await runtime.completeEnrollment(await makeSession(), '1234', '9999');
      await runtime.submitPin('1234');

      await runtime.post('timed out post', []);
      const item = runtime.getSnapshot().feed.items.find(i => i.content === 'timed out post');
      // The FIRST ambiguous timeout self-schedules a local resend rather than going straight to
      // 'failed' — the quiet '·' affordance, not a hard '✕', while retries remain.
      expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('sending');
      expect(runtime.getSnapshot().sendReasons.has(item!.id)).toBe(false); // no rejection reason
      expect(published.filter(id => id === item!.id).length).toBe(1);

      // Walk the whole local backoff ladder (4/8/16/32s) — every attempt is still ambiguous.
      await jest.advanceTimersByTimeAsync(4_000);
      await jest.advanceTimersByTimeAsync(8_000);
      await jest.advanceTimersByTimeAsync(16_000);
      await jest.advanceTimersByTimeAsync(32_000);
      expect(published.filter(id => id === item!.id).length).toBe(5); // original + 4 local resends
      // Ladder exhausted — settles to 'failed' (still retryable, not 'rejected').
      expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('failed');
      expect(runtime.getSnapshot().sendReasons.has(item!.id)).toBe(false);

      // A reconnect sweep still resends it — an ambiguous miss is never permanent like a rejection.
      const before = published.filter(id => id === item!.id).length;
      await runtime.resendUnsent();
      await jest.advanceTimersByTimeAsync(0);
      expect(published.filter(id => id === item!.id).length).toBe(before + 1); // auto-resent

      runtime.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a post composed while the relay is offline QUEUED (not failed), then delivers on reconnect', async () => {
    // A post made before the onion circuit is up must NOT flash "failed": it isn't sent or
    // rejected, just waiting for a relay. It stays "sending" and auto-delivers on reconnect.
    let online = false;
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () =>
        online
          ? {accepted: true, message: 'ok'}
          : {accepted: false, message: 'relay not connected', offline: true},
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    // Relay still offline: compose a post.
    await runtime.post('queued while connecting', []);
    await flush();

    let snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'queued while connecting');
    expect(item).toBeDefined(); // shown immediately (optimistic)
    expect(snap.sendStatus.get(item!.id)).toBe('sending'); // QUEUED, not 'failed'

    // Relay comes up → onRelayConnected re-delivers the queued post → OK 'accepted' confirms it
    // immediately, with no echo required (the delayed-send stuck-ring regression this guards
    // against: a post signed with a fuzzed, back-dated created_at while offline and resent minutes
    // later can fall below the live feed's advancing `since` and never echo back).
    online = true;
    await runtime.onRelayConnected();
    await flush();
    snap = runtime.getSnapshot();
    expect(snap.sendStatus.get(item!.id)).toBe('confirmed');

    runtime.dispose();
  });
});

describe('T12-S6: deliver retryable decision routes through the gated reject-code table', () => {
  async function rejectingRuntime(message: string): Promise<AppRuntime> {
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async () => ({accepted: false, message}),
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    return runtime;
  }

  // Stub the relay caps the deliver() gate reads (default advertises rejectCodesVersion 0 → legacy).
  function stubCaps(runtime: AppRuntime, rejectCodesVersion: number): void {
    jest
      .spyOn(runtime, 'relayCapabilities')
      .mockReturnValue({...defaultRelayCapabilities(), rejectCodesVersion});
  }

  it('caps v3 + trust: a terminal code stays terminal even when its prose reads transient (B1 win)', async () => {
    // [too_many_tags] ∉ RETRYABLE_CODES, so under trust it is terminal — despite the prose "too many"
    // that the legacy substring heuristic would treat as retryable.
    const msg = '[too_many_tags] too many tags (3, max 2)';
    const runtime = await rejectingRuntime(msg);
    stubCaps(runtime, 3);

    await runtime.post('trusted terminal', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'trusted terminal');
    expect(snap.sendStatus.get(item!.id)).toBe('rejected'); // code-authoritative terminal
    expect(snap.sendReasons.get(item!.id)).toBe(msg); // RAW message stored (calm mapping is at render)
    runtime.dispose();
  });

  it('caps v2 (pre-flip): the SAME message keeps the legacy prose heuristic → retryable failed', async () => {
    // With the relay advertising < CAPS_REJECT_CODES_MACHINE_MIN the gate falls back to classifyRejection,
    // whose "too many" transient substring wins → 'failed' (byte-identical to pre-change behavior).
    const msg = '[too_many_tags] too many tags (3, max 2)';
    const runtime = await rejectingRuntime(msg);
    stubCaps(runtime, 2);

    await runtime.post('legacy retryable', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'legacy retryable');
    expect(snap.sendStatus.get(item!.id)).toBe('failed'); // legacy heuristic unchanged
    runtime.dispose();
  });

  it('caps v3 + trust: a transient rate-limit code is retryable (failed, auto-resends)', async () => {
    const msg = '[rate_limited_dm] the community is busy (retry_after=60)';
    const runtime = await rejectingRuntime(msg);
    stubCaps(runtime, 3);

    await runtime.post('busy now', []);
    await flush();

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.content === 'busy now');
    expect(snap.sendStatus.get(item!.id)).toBe('failed'); // rate_limited_dm ∈ RETRYABLE_CODES
    runtime.dispose();
  });
});

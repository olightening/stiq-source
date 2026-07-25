/**
 * Adaptive deferred-emit throttle + background emit parking (JS-thread jank fixes, 2026-07-12).
 *
 * emitDeferred coalesces relay-driven re-renders. These tests pin its three behaviours:
 *   • normal: one emit per RELAY_EMIT_THROTTLE_MS (250 ms) window;
 *   • syncing (setRelaySyncing(true), i.e. the relay's pre-EOSE backlog burst): the window widens to
 *     1000 ms so burst ingest + O(cache) feed rebuilds don't stack on the one JS thread, snapping
 *     back on setRelaySyncing(false) and self-expiring after 60 s as a stale-flag backstop;
 *   • backgrounded (setAppBackgrounded(true)): deferred emits PARK (nothing is on screen), and the
 *     first foreground transition flushes exactly one coalesced emit.
 *   • scrolling (setScrolling(true), i.e. the feed FlatList is mid-drag/fling): deferred emits PARK
 *     so a sync burst can't jump the list under the user's finger; settle (setScrolling(false))
 *     flushes exactly one coalesced emit, self-expiring after RELAY_SCROLL_MAX_MS (1200 ms) if no
 *     scroll-end callback ever arrives. Urgent emits still fire immediately while scrolling and clear
 *     any parked flush (the fresh snapshot already reflects it — see AppRuntime.emit).
 * Urgent user-action emits bypass emitDeferred entirely and are not throttled/backgrounded-parked.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';
import {Kind} from '../nostr/events';

async function makeRuntime(): Promise<AppRuntime> {
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store: new InMemoryEventStore(),
    hash: async (d: Uint8Array) => d,
    // Far past every advanceTimersByTime below, so an autolock tick can never inject an emit.
    autoLockMs: 600_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  await runtime.init();
  // Drain init's off-critical-path real timers (deferred-heavy lift + attribution warmup emit)
  // BEFORE the test subscribes and freezes time — they'd otherwise fire mid-test as stray emits.
  await runtime.whenAttributionWarmupReady();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  return runtime;
}

/** Subscribe a counter that ignores the immediate snapshot subscribe() itself delivers. */
function countEmits(runtime: AppRuntime): {count: () => number; unsub: () => void} {
  let n = -1; // subscribe() calls the listener once synchronously — start at -1 to ignore it
  const unsub = runtime.subscribe(() => {
    n++;
  });
  return {count: () => n, unsub};
}

/**
 * Fire a plain urgent emit (default `emit()`, e.g. the user's own optimistic post/vote/comment).
 * There's no lightweight public action on the minimal test runtime (no PIN/community enrolled) that
 * reaches emit(true) without dragging in unrelated setup, so this reaches the private method
 * directly — it's exactly the contract this suite pins (urgent bypasses parking; see AppRuntime.emit).
 */
function emitUrgent(runtime: AppRuntime): void {
  (runtime as unknown as {emit: (urgent?: boolean) => void}).emit(true);
}

describe('AppRuntime deferred-emit throttle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits once per 250 ms window normally', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged(); // coalesces into the same window
    expect(count()).toBe(0);
    jest.advanceTimersByTime(249);
    expect(count()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1);
    unsub();
  });

  it('widens the window to 1000 ms while the relay is syncing, and restores it on clear', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setRelaySyncing(true);
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(999);
    expect(count()).toBe(0); // still parked — the 250 ms window no longer applies
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1);

    runtime.setRelaySyncing(false); // backlog EOSEd — normal cadence again
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(250);
    expect(count()).toBe(2);
    unsub();
  });

  it('does not reset the widened window on later events, but still fires a trailing emit', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setRelaySyncing(true);
    runtime.notifyStoreChanged(); // arms the 1000 ms window
    jest.advanceTimersByTime(500);
    runtime.notifyStoreChanged(); // mid-window — must NOT push the deadline out to 1500
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(499);
    expect(count()).toBe(0); // 999 ms since the FIRST call — still pending
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1); // trailing emit fires at the original 1000 ms deadline, not starved
    unsub();
  });

  it('a stale syncing flag self-expires after 60 s (missed clear cannot park the app on 1 Hz)', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setRelaySyncing(true);
    jest.advanceTimersByTime(61_000); // relay died mid-sync; nothing ever cleared the flag
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(250); // expired flag → back on the normal window
    expect(count()).toBe(1);
    unsub();
  });

  it('parks deferred emits while backgrounded and flushes ONE on foreground', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setAppBackgrounded(true);
    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(10_000);
    expect(count()).toBe(0); // fully parked — no build, no render while off-screen

    runtime.setAppBackgrounded(false);
    jest.advanceTimersByTime(250); // the flush goes through the normal deferred window
    expect(count()).toBe(1); // exactly one coalesced catch-up emit
    unsub();
  });

  it('foregrounding with nothing pending emits nothing', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setAppBackgrounded(true);
    runtime.setAppBackgrounded(false);
    jest.advanceTimersByTime(2_000);
    expect(count()).toBe(0);
    unsub();
  });

  it('parks deferred emits while scrolling and flushes ONE on settle', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setScrolling(true);
    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged();
    // Stay under the RELAY_SCROLL_MAX_MS (1200 ms) self-expiry ceiling — this proves the park itself,
    // not the backstop (that's the dedicated self-expiry test below).
    jest.advanceTimersByTime(1_000);
    expect(count()).toBe(0); // fully parked — no whole-tree render mid-drag

    runtime.setScrolling(false);
    jest.advanceTimersByTime(250); // the flush goes through the normal deferred window
    expect(count()).toBe(1); // exactly one coalesced catch-up emit
    unsub();
  });

  it('settling with nothing pending emits nothing', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setScrolling(true);
    runtime.setScrolling(false);
    jest.advanceTimersByTime(2_000);
    expect(count()).toBe(0);
    unsub();
  });

  it('an urgent emit while scrolling notifies immediately and skips the redundant flush', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setScrolling(true);
    runtime.notifyStoreChanged(); // parked — deferred, non-urgent
    expect(count()).toBe(0);

    emitUrgent(runtime); // e.g. the user's own optimistic post/vote/comment
    expect(count()).toBe(1); // urgent emits are never parked, even mid-scroll

    runtime.setScrolling(false);
    jest.advanceTimersByTime(250);
    expect(count()).toBe(1); // the urgent emit's snapshot already reflected the parked change
    unsub();
  });

  it('a scroll that never settles self-expires after RELAY_SCROLL_MAX_MS (1200 ms) and flushes', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setScrolling(true); // no onScrollEndDrag/onMomentumScrollEnd ever arrives
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(1_199);
    expect(count()).toBe(0); // still under the ceiling — still parked
    jest.advanceTimersByTime(1); // 1200 ms — self-expiry fires setScrolling(false)
    jest.advanceTimersByTime(250); // the resulting flush goes through the normal deferred window
    expect(count()).toBe(1);
    unsub();
  });
});

/**
 * UI-freeze A1 (P0-2): a like/vote/comment optimistic placeholder must save synchronously (so the
 * write's data is instantly available) but must NOT run its heavy getSnapshot→buildFeed rebuild on
 * the touch handler — that rebuild is deferred to the next macrotask so the tap never freezes on the
 * old architecture (render + touch dispatch share one JS thread). See renderPlaceholder /
 * scheduleOptimisticEmit.
 */
describe('AppRuntime optimistic-placeholder emit deferral', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Reach the private renderPlaceholder (no enrolled identity on the minimal test runtime to drive
   *  vote()/post() without dragging in unrelated blind-draw setup — this pins the exact contract). */
  function renderPlaceholder(runtime: AppRuntime, id: string, unsigned: UnsignedEvent): void {
    (
      runtime as unknown as {
        renderPlaceholder: (id: string, unsigned: UnsignedEvent, status?: 'sending' | 'failed') => void;
      }
    ).renderPlaceholder(id, unsigned);
  }

  const reaction = (): UnsignedEvent => ({
    kind: Kind.Reaction,
    created_at: 1,
    tags: [['e', 'p'.repeat(64)]],
    content: '+',
  });

  it('saves the placeholder synchronously but defers the rebuild emit to the next macrotask', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    renderPlaceholder(runtime, 'ph1', reaction());

    // The write is available IMMEDIATELY (store.save + awaitingSign ran synchronously) so the UI has
    // its instant-feedback data — but the heavy emit has NOT fired on the tap.
    expect(runtime.getSnapshot().sendStatus.get('ph1')).toBe('sending');
    expect(count()).toBe(0);

    // It lands on the very next macrotask (one frame later), off the touch handler.
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1);
    unsub();
    runtime.dispose();
  });

  it('coalesces a burst of rapid placeholders into a single deferred rebuild', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    renderPlaceholder(runtime, 'a', reaction());
    renderPlaceholder(runtime, 'b', reaction());
    renderPlaceholder(runtime, 'c', reaction());
    expect(count()).toBe(0); // nothing synchronous on any of the taps

    jest.advanceTimersByTime(1);
    expect(count()).toBe(1); // exactly one rebuild for the whole burst
    unsub();
    runtime.dispose();
  });
});

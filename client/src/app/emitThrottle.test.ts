/**
 * Deferred-emit throttle + background/scroll emit parking (JS-thread jank fixes, 2026-07-12;
 * tightened + hardened 2026-07-27 as part of the "no pull-to-refresh, ever" pass).
 *
 * emitDeferred coalesces relay-driven re-renders. These tests pin its behaviours:
 *   • normal: one emit per RELAY_EMIT_THROTTLE_MS (80 ms) window, TRAILING and NON-RESETTING — a
 *     call while a window is already armed is a no-op, it never pushes the deadline back out, but a
 *     trailing emit always fires at the original deadline. That SHAPE is what caps render count
 *     under an arbitrarily large burst (a 500-event EOSE backlog costs at most one render per
 *     window, never one render per event) — independent of the exact window size.
 *   • syncing (setRelaySyncing(true), the relay's pre-EOSE backlog burst) no longer widens this
 *     window — the backlog now gets the SAME tight cadence as everything else (a live sync is
 *     exactly when the user most wants to see content land). setRelaySyncing only drives the
 *     snapshot's `syncing` indicator now, which still self-expires after 60 s as a stale-flag
 *     backstop (a missed clear can't leave the indicator on forever).
 *   • backgrounded (setAppBackgrounded(true)): deferred emits PARK (nothing is on screen). Unlike
 *     the syncing/scroll parks, this one has NO timed self-expiry (a legitimate background stretch
 *     can last hours — see AppRuntime._appBackgrounded's doc for why a timer would be wrong here).
 *     What IS hardened: a relay event that armed the deferred timer just BEFORE backgrounding began
 *     can no longer sneak a render through DURING backgrounding (the timer is cancelled and folded
 *     into the pending flag), and the foreground transition flushes any pending change with a
 *     DIRECT, immediate emit() — not routed back through emitDeferred()'s own throttle — so "the
 *     moment it foregrounds" carries zero extra delay.
 *   • scrolling (setScrolling(true), the feed FlatList mid-drag/fling): deferred emits PARK so a
 *     sync burst can't jump the list under the user's finger; settle (setScrolling(false)) flushes
 *     exactly one coalesced emit THROUGH the normal deferred window (deliberately not instant —
 *     unlike backgrounding, there's no "away for hours" staleness to race against here), self-
 *     expiring after RELAY_SCROLL_MAX_MS (1200 ms) if no scroll-end callback ever arrives. Scrolling
 *     shares the same pre-armed-timer hardening as backgrounding: a timer already ticking when the
 *     drag begins is cancelled and folded in, rather than firing mid-drag.
 * Urgent user-action emits bypass emitDeferred entirely and are never throttled or parked.
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

  it('emits once per 80 ms window normally', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.notifyStoreChanged();
    runtime.notifyStoreChanged(); // coalesces into the same window
    expect(count()).toBe(0);
    jest.advanceTimersByTime(79);
    expect(count()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1);
    unsub();
  });

  it('a large burst arriving inside one window still costs exactly ONE render, never one per event', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    // Stand-in for a 500-event EOSE backlog delivered faster than the coalescing window: every call
    // before the first one's timer fires is a no-op (see emitDeferred), so this can never become
    // 500 renders no matter how the window size is tuned.
    for (let i = 0; i < 500; i++) runtime.notifyStoreChanged();
    expect(count()).toBe(0); // nothing has rendered yet — all 500 calls coalesced into one timer
    jest.advanceTimersByTime(80);
    expect(count()).toBe(1); // exactly one render for the whole burst
    unsub();
  });

  it('no longer widens the window while the relay is syncing — same tight cadence as normal', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.setRelaySyncing(true);
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(79);
    expect(count()).toBe(0); // still within the (single, tight) window
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1); // fires at 80 ms — NOT held to the old widened 1000 ms

    runtime.setRelaySyncing(false);
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(80);
    expect(count()).toBe(2); // identical cadence on either side of the sync flag
    unsub();
  });

  it('does not reset the coalescing window on later events, but still fires a trailing emit', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.notifyStoreChanged(); // arms the 80 ms window
    jest.advanceTimersByTime(40);
    runtime.notifyStoreChanged(); // mid-window — must NOT push the deadline out to 120
    runtime.notifyStoreChanged();
    jest.advanceTimersByTime(39);
    expect(count()).toBe(0); // 79 ms since the FIRST call — still pending
    jest.advanceTimersByTime(1);
    expect(count()).toBe(1); // trailing emit fires at the original 80 ms deadline, not starved
    unsub();
  });

  it('the syncing indicator self-expires after 60 s (a missed clear cannot leave it on forever)', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();

    runtime.setRelaySyncing(true);
    expect(runtime.getSnapshot().syncing).toBe(true);
    jest.advanceTimersByTime(61_000); // relay died mid-sync; nothing ever cleared the flag
    expect(runtime.getSnapshot().syncing).toBe(false); // stale-flag backstop, not a real clear
  });

  it('parks deferred emits while backgrounded and flushes ONE the instant it foregrounds', async () => {
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
    // No advanceTimersByTime here: the foreground flush is a DIRECT emit(), not routed back through
    // emitDeferred()'s throttle — see AppRuntime.setAppBackgrounded's doc for why.
    expect(count()).toBe(1); // exactly one coalesced catch-up emit, with zero extra delay
    unsub();
  });

  it('cancels an already-armed deferred timer when backgrounding begins, instead of letting it render mid-background', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.notifyStoreChanged(); // arms the 80 ms deferred timer WHILE STILL FOREGROUNDED
    runtime.setAppBackgrounded(true); // must cancel that timer, not let it ride to completion
    jest.advanceTimersByTime(1_000); // well past the original 80 ms deadline
    expect(count()).toBe(0); // no render leaked through while backgrounded

    runtime.setAppBackgrounded(false);
    expect(count()).toBe(1); // the cancelled timer's intent is not lost — it flushes on foreground
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
    jest.advanceTimersByTime(80); // the flush goes through the normal deferred window
    expect(count()).toBe(1); // exactly one coalesced catch-up emit
    unsub();
  });

  it('cancels an already-armed deferred timer when a scroll begins, instead of letting it jump the list mid-drag', async () => {
    const runtime = await makeRuntime();
    jest.useFakeTimers();
    const {count, unsub} = countEmits(runtime);

    runtime.notifyStoreChanged(); // arms the 80 ms deferred timer WHILE STILL SETTLED
    runtime.setScrolling(true); // must cancel that timer, not let it fire mid-drag
    jest.advanceTimersByTime(1_000); // well past the original deadline, still under RELAY_SCROLL_MAX_MS
    expect(count()).toBe(0); // no render leaked through mid-scroll

    runtime.setScrolling(false);
    jest.advanceTimersByTime(80); // settle flush still goes through the normal deferred window
    expect(count()).toBe(1); // the cancelled timer's intent is not lost — it flushes on settle
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
    jest.advanceTimersByTime(80);
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
    jest.advanceTimersByTime(80); // the resulting flush goes through the normal deferred window
    expect(count()).toBe(1);
    unsub();
  });
});

/**
 * UI-freeze A1 (P0-2): a like/vote/comment optimistic placeholder must save synchronously (so the
 * write's data is instantly available) but must NOT run its heavy getSnapshot→buildFeed rebuild on
 * the touch handler — that rebuild is deferred to the next macrotask so the tap never freezes on the
 * old architecture (render + touch dispatch share one JS thread). See renderPlaceholder /
 * scheduleOptimisticEmit. Unaffected by the RELAY_EMIT_THROTTLE_MS retune above: this path is a
 * separate, always-0ms macrotask yield, not the relay-driven deferred throttle.
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

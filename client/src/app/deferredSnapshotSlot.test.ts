/**
 * The two guards App.tsx's deferred-snapshot path depends on — see deferredSnapshotSlot.ts's module
 * doc. Both of these shipped broken in release APK vc9's working tree, and neither was reachable by
 * any test while the logic lived as bare `let`s inside App's 3000-line mount effect.
 */
import {createDeferredSlot, type Cancellable} from './deferredSnapshotSlot';

/** A scheduler that never fires on its own — the test decides when (and whether) a flush runs. */
function fakeScheduler(): {
  schedule: (cb: () => void) => Cancellable;
  /** Run every callback that is still scheduled (i.e. was not cancelled), in order. */
  run: () => void;
  /** How many callbacks were ever scheduled — pins the COALESCE guard. */
  scheduled: () => number;
  /** How many of those were cancelled before firing — pins the SUPERSEDE guard. */
  cancelled: () => number;
} {
  let scheduled = 0;
  let cancelled = 0;
  let queue: Array<{cb: () => void; live: boolean}> = [];
  return {
    schedule: cb => {
      scheduled++;
      const entry = {cb, live: true};
      queue.push(entry);
      return {
        cancel: () => {
          if (entry.live) {
            entry.live = false;
            cancelled++;
          }
        },
      };
    },
    run: () => {
      const due = queue;
      queue = [];
      for (const entry of due) if (entry.live) entry.cb();
    },
    scheduled: () => scheduled,
    cancelled: () => cancelled,
  };
}

describe('createDeferredSlot — COALESCE', () => {
  it('collapses a burst into ONE scheduled flush that applies only the LATEST value', () => {
    const applied: string[] = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(v => applied.push(v), sched.schedule);

    slot.defer('a');
    slot.defer('b');
    slot.defer('c');
    expect(sched.scheduled()).toBe(1); // not three
    expect(applied).toEqual([]); // nothing applied until the flush actually runs

    sched.run();
    expect(applied).toEqual(['c']); // the latest, not the one that armed the flush
  });

  it('re-arms after a flush has fired, so later values are not silently dropped', () => {
    const applied: string[] = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(v => applied.push(v), sched.schedule);

    slot.defer('first');
    sched.run();
    expect(applied).toEqual(['first']);
    expect(slot.isPending()).toBe(false);

    slot.defer('second');
    expect(slot.isPending()).toBe(true);
    sched.run();
    expect(applied).toEqual(['first', 'second']);
  });

  it('a flush with nothing queued applies nothing (a cancelled slot cannot resurrect a value)', () => {
    const applied: string[] = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(v => applied.push(v), sched.schedule);

    slot.defer('x');
    slot.cancel();
    sched.run();
    expect(applied).toEqual([]);
  });
});

describe('createDeferredSlot — SUPERSEDE', () => {
  /**
   * REGRESSION: App.tsx's handleMarkFeedSeen applies a post-mark snapshot by reading the runtime
   * directly, bypassing the subscribe/defer path entirely. Before the slot was reachable from the
   * component body it could not cancel a queued flush, so: tap the "N new posts" pill → the count
   * clears → the queued OLDER (pre-mark) snapshot lands → the count comes back.
   */
  it('cancel() drops the queued value so a stale flush can never overwrite a fresher direct apply', () => {
    const applied: string[] = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(v => applied.push(v), sched.schedule);

    slot.defer('old-snapshot'); // relay churn queues a flush
    slot.cancel(); // …then something applies a fresher value directly
    applied.push('fresh-direct-apply');

    sched.run(); // the previously-queued flush would have fired here
    expect(applied).toEqual(['fresh-direct-apply']); // and must NOT have rolled it back
  });

  it('cancel() cancels the scheduled callback rather than leaving it to fire and no-op', () => {
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(() => undefined, sched.schedule);

    slot.defer('x');
    expect(slot.isPending()).toBe(true);
    slot.cancel();

    // Not merely "the flush found nothing to do" — the handle itself is retired, so the queue check
    // in defer() below is accurate and a burst of supersedes cannot strand a phantom pending flush.
    expect(sched.cancelled()).toBe(1);
    expect(slot.isPending()).toBe(false);
  });

  it('after a supersede, the NEXT deferred value schedules a fresh flush and still applies', () => {
    // The bug this pins: if cancel() cleared the value but left the "already queued" flag set, this
    // second value would never be scheduled and would sit unapplied forever.
    const applied: string[] = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(v => applied.push(v), sched.schedule);

    slot.defer('superseded');
    slot.cancel();
    slot.defer('after-supersede');

    expect(sched.scheduled()).toBe(2);
    sched.run();
    expect(applied).toEqual(['after-supersede']);
  });

  it('is idempotent — repeated cancels are harmless and cancel nothing extra', () => {
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string>(() => undefined, sched.schedule);

    slot.defer('x');
    slot.cancel();
    slot.cancel();
    slot.cancel();
    expect(sched.cancelled()).toBe(1);
    expect(slot.isPending()).toBe(false);
  });

  it('treats a legitimately undefined value as a real queued value, not an empty slot', () => {
    const applied: Array<string | undefined> = [];
    const sched = fakeScheduler();
    const slot = createDeferredSlot<string | undefined>(v => applied.push(v), sched.schedule);

    slot.defer(undefined);
    sched.run();
    expect(applied).toEqual([undefined]); // applied once, not skipped as "nothing pending"
  });
});

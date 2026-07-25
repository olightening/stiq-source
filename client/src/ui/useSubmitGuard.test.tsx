/**
 * useSubmitGuard — the shared re-entrancy guard used by LockScreen/PasswordsScreen's PIN submit.
 *
 * Root cause it fixes: `if (busy) return; setBusy(true);` used a stale closure + async setState,
 * so a double-tap/ghost-press could call the guarded async submit twice before `busy` ever
 * flipped, double-counting one wrong PIN against the lockout counter. `useSubmitGuard` instead
 * checks-and-sets a `useRef` synchronously, before any `await`, so a second call arriving while
 * the first is still in flight is skipped outright — regardless of React's render timing.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {useSubmitGuard, type SubmitGuard} from './useSubmitGuard';

/** Mount a bare component just long enough to capture its stable `guard` function. */
function mountGuard(): SubmitGuard {
  let captured: SubmitGuard | undefined;
  function Harness(): null {
    captured = useSubmitGuard();
    return null;
  }
  act(() => {
    renderer.create(<Harness />);
  });
  return captured!;
}

describe('useSubmitGuard', () => {
  it('runs fn and resolves with its return value when nothing is in flight', async () => {
    const guard = mountGuard();
    const result = await guard(async () => 42);
    expect(result).toBe(42);
  });

  it('a second call fired while the first is still in flight is skipped (returns undefined)', async () => {
    const guard = mountGuard();
    const fnSecond = jest.fn(async () => 'second-ran');

    let resolveFirst: (v: string) => void = () => {};
    const first = guard(
      () =>
        new Promise<string>(resolve => {
          resolveFirst = resolve;
        }),
    );
    // Fired synchronously — same "event tick" as a double-tap/ghost-press — before `first` settles.
    const second = guard(fnSecond);

    resolveFirst('first-ran');
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe('first-ran');
    expect(r2).toBeUndefined();
    expect(fnSecond).not.toHaveBeenCalled(); // the guarded fn itself never even ran
  });

  it('releases the guard in a finally even when fn throws/rejects', async () => {
    const guard = mountGuard();
    await expect(
      guard(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Not wedged open by the failure — the next call runs normally.
    const after = await guard(async () => 'ok');
    expect(after).toBe('ok');
  });

  it('after a call resolves, a later call is not skipped (guard is per-call, not permanent)', async () => {
    const guard = mountGuard();
    await guard(async () => 'one');
    const two = await guard(async () => 'two');
    expect(two).toBe('two');
  });

  it('three rapid-fire calls: only the first runs, and the guard is free again afterward', async () => {
    const guard = mountGuard();
    const calls = jest.fn(async (n: number) => n);

    let resolveFirst: (v: number) => void = () => {};
    const p1 = guard(
      () =>
        new Promise<number>(resolve => {
          resolveFirst = resolve;
        }),
    );
    const p2 = guard(() => calls(2));
    const p3 = guard(() => calls(3));
    resolveFirst(1);
    const results = await Promise.all([p1, p2, p3]);

    expect(results).toEqual([1, undefined, undefined]);
    expect(calls).not.toHaveBeenCalled();

    // The guard is released now — a fresh call goes through.
    const p4 = await guard(() => calls(4));
    expect(p4).toBe(4);
  });
});

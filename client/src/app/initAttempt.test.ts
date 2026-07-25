import {isCurrentInitAttempt} from './initAttempt';

describe('isCurrentInitAttempt', () => {
  it('is current when the attempt number matches the latest and the component is mounted', () => {
    expect(isCurrentInitAttempt(1, 1, false)).toBe(true);
  });

  it('is stale once a newer attempt has started (e.g. a Retry) — the late/original settlement is a no-op', () => {
    // Original attempt 1's promise/timeout settles AFTER Retry bumped the counter to 2.
    expect(isCurrentInitAttempt(1, 2, false)).toBe(false);
    // The newer attempt itself is still current.
    expect(isCurrentInitAttempt(2, 2, false)).toBe(true);
  });

  it('is stale once the component has unmounted, even for the latest attempt', () => {
    expect(isCurrentInitAttempt(1, 1, true)).toBe(false);
  });
});

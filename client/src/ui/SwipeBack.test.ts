/**
 * SwipeBack — the pure reducers, pinned outside a device (PLAN_SWIPE_BACK_GESTURE_2026-07-27.md).
 *
 * `nextSwipeBackPhase` is `useTabSwipe`'s `nextAxis` shape with a THIRD outcome. The tab swipe only
 * ever needs `horizontal` vs `vertical`, because either horizontal direction is a valid tab swipe;
 * swipe-back owns only the RIGHTWARD half of the horizontal axis (`SwipeToReply` owns the leftward
 * half, dragging a chat row left to reply), so a leftward-leading drag must be a PERMANENT
 * disqualification (`declined`) rather than merely "not yet claimed" — otherwise a reply drag that
 * overshoots left and then swings back right would be free to reinterpret itself as a swipe-back
 * mid-gesture. These tests deliberately parallel useTabSwipe.test.ts's `nextAxis` suite so the two
 * reducers' shapes stay easy to compare.
 */
import type {PanResponderGestureState} from 'react-native';
import {nextSwipeBackPhase, readSwipeBackCommit, SWIPE_BACK, type SwipeBackPhase} from './SwipeBack';

/** A gesture state at rest — one finger down, nothing moved — overlaid with the case under test. */
const at = (g: Partial<PanResponderGestureState>): PanResponderGestureState =>
  ({
    numberActiveTouches: 1,
    dx: 0, dy: 0, vx: 0, vy: 0, x0: 0, y0: 0, moveX: 0, moveY: 0, stateID: 1,
    ...g,
  } as PanResponderGestureState);

/** Feed a whole gesture through the reducer frame-by-frame, as the responder does, so a test can pin
 *  the LOCK (the outcome depends on order, not just the final frame). */
const lockThrough = (...frames: Array<Partial<PanResponderGestureState>>): SwipeBackPhase =>
  frames.reduce<SwipeBackPhase>((phase, f) => nextSwipeBackPhase(phase, at(f)), 'pending');

describe('nextSwipeBackPhase — claim / decline / fail', () => {
  it('claims a clearly rightward drag', () => {
    expect(nextSwipeBackPhase('pending', at({dx: 40, dy: 4}))).toBe('back');
  });

  it('claims a natural diagonal arc, not only a perfectly flat drag', () => {
    // A real thumb swipe arcs, so a clearly-rightward drag with a modest vertical component must
    // still claim. Well inside the ~40° split (CLAIM_DOMINANCE).
    expect(nextSwipeBackPhase('pending', at({dx: 40, dy: 20}))).toBe('back');
  });

  it('claims sooner now — a short but clearly-rightward nudge counts', () => {
    // CLAIM_DX is low (12) so the page grabs a rightward drag quickly; 14px sideways with little
    // vertical is already a swipe-back.
    expect(nextSwipeBackPhase('pending', at({dx: 14, dy: 4}))).toBe('back');
  });

  it('a leftward-leading drag is DECLINED, not merely un-claimed — SwipeToReply is safe by sign', () => {
    expect(nextSwipeBackPhase('pending', at({dx: -40, dy: 2}))).toBe('declined');
  });

  it('a leftward-leading drag stays declined even if it later travels far right', () => {
    // The exact interference this protects against: a reply-drag that overshoots left, then swings
    // hard right past CLAIM_DX, must NOT be free to reinterpret itself as a swipe-back mid-gesture.
    expect(lockThrough({dx: -20, dy: 2}, {dx: 10, dy: 2}, {dx: 80, dy: 2}, {dx: 200, dy: 2})).toBe('declined');
  });

  it('a vertical-leading drag is declined, handing off to the scroll underneath (failOffsetY)', () => {
    expect(nextSwipeBackPhase('pending', at({dx: 8, dy: 12}))).toBe('declined');
    expect(nextSwipeBackPhase('pending', at({dx: 0, dy: -15}))).toBe('declined');
  });

  it('ignores a tap and the wobble inside one — stays pending', () => {
    expect(nextSwipeBackPhase('pending', at({dx: 0, dy: 0}))).toBe('pending');
    expect(nextSwipeBackPhase('pending', at({dx: 6, dy: 2}))).toBe('pending');
  });

  it('never claims a multi-touch gesture (a pinch is not navigation) — stays pending either direction', () => {
    expect(nextSwipeBackPhase('pending', at({dx: 120, dy: 0, numberActiveTouches: 2}))).toBe('pending');
    expect(nextSwipeBackPhase('pending', at({dx: -120, dy: 0, numberActiveTouches: 2}))).toBe('pending');
  });

  describe('the lock is one-way — decided once, honoured for the whole gesture', () => {
    it('a claimed swipe-back stays claimed even if its arc ends mostly vertical', () => {
      expect(lockThrough({dx: 14, dy: 3}, {dx: 60, dy: 80}, {dx: 70, dy: 200})).toBe('back');
    });

    it('a drag that started vertical can never be reclaimed as a swipe-back', () => {
      expect(lockThrough({dx: 2, dy: 14}, {dx: 60, dy: 40}, {dx: 220, dy: 60})).toBe('declined');
    });

    it('every locked phase is returned unchanged, whatever the next frame brings', () => {
      (['back', 'declined'] as const).forEach(locked => {
        expect(nextSwipeBackPhase(locked, at({dx: 500, dy: 500, numberActiveTouches: 2}))).toBe(locked);
        expect(nextSwipeBackPhase(locked, at({dx: -500, dy: 0}))).toBe(locked);
        expect(nextSwipeBackPhase(locked, at({dx: 0, dy: 0}))).toBe(locked);
      });
    });
  });

  describe('exact-threshold boundaries', () => {
    it('dx exactly at -CLAIM_DX declines (inclusive)', () => {
      expect(nextSwipeBackPhase('pending', at({dx: -SWIPE_BACK.CLAIM_DX, dy: 0}))).toBe('declined');
    });

    it('dx exactly at CLAIM_DX with dy exactly at the dominance ratio still claims (both >= inclusive)', () => {
      const dy = SWIPE_BACK.CLAIM_DX / SWIPE_BACK.CLAIM_DOMINANCE; // dx >= |dy| * CLAIM_DOMINANCE, at equality
      expect(nextSwipeBackPhase('pending', at({dx: SWIPE_BACK.CLAIM_DX, dy}))).toBe('back');
    });

    it('just short of CLAIM_DX and just short of FAIL_DY stays pending', () => {
      expect(
        nextSwipeBackPhase('pending', at({dx: SWIPE_BACK.CLAIM_DX - 1, dy: SWIPE_BACK.FAIL_DY - 1})),
      ).toBe('pending');
    });

    it('dy exactly at FAIL_DY declines, once dx has not already resolved the frame', () => {
      expect(nextSwipeBackPhase('pending', at({dx: 4, dy: SWIPE_BACK.FAIL_DY}))).toBe('declined');
    });
  });
});

describe('readSwipeBackCommit — committing on release', () => {
  it('commits by distance: dx past COMMIT_FRACTION of the screen width, even at zero velocity', () => {
    const width = 400;
    expect(readSwipeBackCommit(at({dx: width * SWIPE_BACK.COMMIT_FRACTION, dy: 0, vx: 0}), width)).toBe(true);
  });

  it('commits by velocity: a short but fast flick, past COMMIT_MIN_DX', () => {
    const width = 1000; // large width, so the distance branch alone would not have committed this dx
    expect(
      readSwipeBackCommit(at({dx: SWIPE_BACK.COMMIT_MIN_DX, dy: 0, vx: SWIPE_BACK.COMMIT_VX}), width),
    ).toBe(true);
  });

  it('a short, slow drag commits neither by distance nor by velocity — the gesture is abortable', () => {
    const width = 1000;
    const short = at({dx: SWIPE_BACK.COMMIT_MIN_DX - 1, dy: 2, vx: 0});
    expect(short.dx).toBeLessThan(width * SWIPE_BACK.COMMIT_FRACTION);
    expect(readSwipeBackCommit(short, width)).toBe(false);
  });

  it('a fast flick that has not travelled COMMIT_MIN_DX does not commit on velocity alone', () => {
    const width = 1000;
    expect(
      readSwipeBackCommit(at({dx: SWIPE_BACK.COMMIT_MIN_DX - 1, dy: 0, vx: SWIPE_BACK.COMMIT_VX + 1}), width),
    ).toBe(false);
  });

  it('exact-threshold: dx exactly at width * COMMIT_FRACTION commits (>= inclusive)', () => {
    const width = 1000;
    expect(readSwipeBackCommit(at({dx: width * SWIPE_BACK.COMMIT_FRACTION, dy: 0, vx: 0}), width)).toBe(true);
    expect(readSwipeBackCommit(at({dx: width * SWIPE_BACK.COMMIT_FRACTION - 1, dy: 0, vx: 0}), width)).toBe(false);
  });

  it('exact-threshold: vx exactly at COMMIT_VX with dx exactly at COMMIT_MIN_DX commits (>= inclusive)', () => {
    const width = 1000;
    expect(
      readSwipeBackCommit(at({dx: SWIPE_BACK.COMMIT_MIN_DX, dy: 0, vx: SWIPE_BACK.COMMIT_VX}), width),
    ).toBe(true);
  });

  it('COMMIT_FRACTION is relative to width — the same absolute dx commits on a narrow screen but not a wide one', () => {
    const dx = 150;
    expect(readSwipeBackCommit(at({dx, dy: 0, vx: 0}), 400)).toBe(true); // 150 >= 400*0.28=112
    expect(readSwipeBackCommit(at({dx, dy: 0, vx: 0}), 900)).toBe(false); // 150 < 900*0.28=252
  });
});

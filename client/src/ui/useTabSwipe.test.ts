/**
 * useTabSwipe — the sideways flick that steps between the top-level tabs.
 *
 * The gesture decision is split into two pure functions so the thresholds can be pinned here instead
 * of only on a device:
 *  - `nextAxis` — the per-gesture DIRECTIONAL LOCK (activeOffsetX + failOffsetY, hand-built on
 *    PanResponder). This is what keeps the left/right swipe from fighting the up/down scroll: within
 *    one touch the gesture commits to a single axis and never switches.
 *  - `readCommit` — at release, whether a claimed (horizontal) drag was decisive enough to switch.
 *
 * What these guard:
 *  - a vertical scroll is NEVER read as navigation, and once a drag has started scrolling it can't be
 *    reclaimed as a swipe however far it later drifts sideways (the swipe-vs-scroll conflict fix);
 *  - a horizontal drag on a chip rail is only ever claimed once it is clearly a sideways sweep, and a
 *    claimed drag that stops short leaves the reader where they were (gestures are abortable);
 *  - direction: sweeping the content LEFT moves FORWARD along the row, as on every paged UI;
 *  - a short but fast flick counts, so navigating never demands a long deliberate drag.
 */
import type {PanResponderGestureState} from 'react-native';
import {nextAxis, readCommit, type Axis} from './useTabSwipe';

/** A gesture state at rest — one finger down, nothing moved — overlaid with the case under test. */
const at = (g: Partial<PanResponderGestureState>): PanResponderGestureState =>
  ({
    numberActiveTouches: 1,
    dx: 0, dy: 0, vx: 0, vy: 0, x0: 0, y0: 0, moveX: 0, moveY: 0, stateID: 1,
    ...g,
  } as PanResponderGestureState);

/** Feed a whole gesture through the reducer frame-by-frame, as the responder does, so a test can pin
 *  the LOCK (the outcome depends on order, not just the final frame). */
const lockThrough = (...frames: Array<Partial<PanResponderGestureState>>): Axis =>
  frames.reduce<Axis>((axis, f) => nextAxis(axis, at(f)), 'pending');

describe('nextAxis — the directional lock', () => {
  it('claims a clearly sideways drag in either direction', () => {
    expect(nextAxis('pending', at({dx: -40, dy: 4}))).toBe('horizontal');
    expect(nextAxis('pending', at({dx: 40, dy: -4}))).toBe('horizontal');
  });

  it('claims a natural diagonal arc, not only a perfectly flat drag', () => {
    // A real thumb swipe arcs, so a clearly-sideways drag with a modest vertical component must still
    // claim (the "only works when perfectly horizontal" fix). Well inside the ~40° split.
    expect(nextAxis('pending', at({dx: -40, dy: 20}))).toBe('horizontal');
    expect(nextAxis('pending', at({dx: 40, dy: 20}))).toBe('horizontal');
  });

  it('claims sooner now — a short but clearly-horizontal nudge counts', () => {
    // CLAIM_DX is low (12) so the stage grabs a horizontal drag before the feed's native vertical
    // scroll can take a diagonal; 14px of sideways with little vertical is already a swipe.
    expect(nextAxis('pending', at({dx: -14, dy: 4}))).toBe('horizontal');
  });

  it('yields to the scroll the instant the finger leads vertically (failOffsetY)', () => {
    // The core of the swipe-vs-scroll fix: a vertical lead locks the gesture to the scroll, even
    // though it has ALSO drifted a little sideways — FAIL_DY (10) trips before CLAIM_DX (12).
    expect(nextAxis('pending', at({dx: 8, dy: 12}))).toBe('vertical');
    expect(nextAxis('pending', at({dx: -6, dy: -20}))).toBe('vertical');
  });

  it('ignores a tap and the wobble inside one — stays pending', () => {
    expect(nextAxis('pending', at({dx: 0, dy: 0}))).toBe('pending');
    expect(nextAxis('pending', at({dx: 6, dy: 2}))).toBe('pending');
  });

  it('never claims a multi-touch gesture (a pinch is not navigation)', () => {
    expect(nextAxis('pending', at({dx: -120, dy: 0, numberActiveTouches: 2}))).toBe('pending');
  });

  describe('the lock is one-way — decided once, honoured for the whole gesture', () => {
    it('a drag that started scrolling can NEVER be reclaimed as a swipe', () => {
      // This is the exact interference the fix removes: a vertical scroll that later curves hard
      // sideways used to cross the horizontal ratio and yank the tab. Now, once vertical, always
      // vertical — the late sideways travel is ignored.
      expect(lockThrough({dx: 2, dy: 14}, {dx: 60, dy: 40}, {dx: 220, dy: 60})).toBe('vertical');
    });

    it('a claimed swipe stays a swipe even if its arc ends mostly vertical', () => {
      expect(lockThrough({dx: -14, dy: 3}, {dx: -60, dy: 80}, {dx: -70, dy: 200})).toBe('horizontal');
    });

    it('resolves a fast diagonal flick by which axis led, not by frame order', () => {
      // A fast flick can cross CLAIM_DX and FAIL_DY inside one coarse move event. The dominance test
      // decides: led sideways → swipe; led vertically → scroll.
      expect(nextAxis('pending', at({dx: -30, dy: 15}))).toBe('horizontal'); // 2:1 sideways
      expect(nextAxis('pending', at({dx: 15, dy: 30}))).toBe('vertical'); // 2:1 vertical
    });
  });
});

describe('readCommit — committing on release', () => {
  it('sweeping the content LEFT goes forward, RIGHT goes back', () => {
    expect(readCommit(at({dx: -90, dy: 5}))).toBe(1);
    expect(readCommit(at({dx: 90, dy: 5}))).toBe(-1);
  });

  it('commits an arced swipe whose end drifted vertical, as long as it stayed mostly sideways', () => {
    // Once claimed, the commit angle is looser than the claim (COMMIT_DOMINANCE 0.75): a normal
    // downward arc at the end should still switch tab rather than being read as an abort.
    expect(readCommit(at({dx: -140, dy: 90}))).toBe(1);
  });

  it('a claimed drag released short of the threshold changes nothing — the gesture is abortable', () => {
    const short = at({dx: -30, dy: 2, vx: 0});
    expect(short.dx).toBeGreaterThan(-45); // above the 45px commit threshold in magnitude
    expect(readCommit(short)).toBeNull();
  });

  it('a short but fast flick commits on velocity alone', () => {
    expect(readCommit(at({dx: -25, dy: 1, vx: -0.9}))).toBe(1);
  });

  it('a drag that curved into a vertical sweep no longer commits, however far sideways it went', () => {
    expect(readCommit(at({dx: -120, dy: -300}))).toBeNull();
  });

  it('still commits at release, when the finger is already up (numberActiveTouches 0)', () => {
    // The release fires with ZERO active touches, so gating the commit on `numberActiveTouches === 1`
    // (as the CLAIM does) would reject every real swipe. The commit must ignore the live touch count.
    expect(readCommit(at({dx: -248, dy: 0, numberActiveTouches: 0}))).toBe(1);
    expect(readCommit(at({dx: 248, dy: 0, numberActiveTouches: 0}))).toBe(-1);
  });
});

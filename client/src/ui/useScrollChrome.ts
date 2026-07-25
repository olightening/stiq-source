/**
 * useScrollChrome — scroll-driven chrome show/hide with smooth animation.
 *
 * The chrome (compose bar + filter row) fades + slides up when the user scrolls
 * down past a threshold, and only returns when they scroll all the way back to the
 * top (offset 0) — scrolling up mid-feed does not reveal it. Uses `Animated` with
 * `useNativeDriver: true` so the animation runs on the UI thread at 60fps without
 * triggering JS re-renders on every frame.
 *
 * Hide sequence: animate opacity/translate → 0 (220ms) → unmount from DOM.
 * Show sequence: mount in DOM → animate opacity/translate → 1 (220ms).
 * This way the layout jump always coincides with the invisible state.
 */
import {useCallback, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

const HIDE_AFTER = 80;    // px scrolled down before chrome hides
const JUMP_AFTER = 240;   // px from top before the jump button appears (design .to-top threshold)
const DURATION = 220;     // animation duration in ms

export interface ScrollChrome {
  /** Animated value driving opacity (0 = hidden, 1 = visible). Pass to Animated.View. */
  chromeAnim: Animated.Value;
  /** Whether the chrome container should be in the DOM at all. */
  chromeMounted: boolean;
  /** Whether the floating jump-to-top button should be shown. */
  showJump: boolean;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /**
   * Re-derive chrome visibility + showJump from an already-known offset, INSTANTLY (no 220ms
   * transition) — for when the list itself jumps to a known position programmatically (e.g. a
   * tab-switch scroll restore) rather than via a live drag, so the chrome/jump-bubble state is
   * never left describing the position the list was at before the jump. See MainScreen's
   * `useLayoutEffect(() => { if (tab === 'feed') feedScroll.syncOffset(...) }, ...)`.
   */
  syncOffset: (y: number) => void;
}

export function useScrollChrome(): ScrollChrome {
  const chromeAnim = useRef(new Animated.Value(1)).current;
  const [chromeMounted, setChromeMounted] = useState(true);
  const [showJump, setShowJump] = useState(false);

  const visibleRef = useRef(true);

  const setChrome = useCallback(
    (next: boolean): void => {
      if (visibleRef.current === next) return;
      visibleRef.current = next;

      if (next) {
        // Show: mount first, then fade/slide in.
        setChromeMounted(true);
        Animated.timing(chromeAnim, {
          toValue: 1,
          duration: DURATION,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      } else {
        // Hide: fade/slide out, then unmount.
        Animated.timing(chromeAnim, {
          toValue: 0,
          duration: DURATION,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }).start(({finished}) => {
          if (finished) setChromeMounted(false);
        });
      }
    },
    [chromeAnim],
  );

  // Instant twin of setChrome — jumps straight to the target visual state (no Animated.timing),
  // for re-deriving chrome from a RESTORED offset rather than a live scroll gesture. Always writes
  // (no `visibleRef.current === next` bail-out) so visibleRef stays correctly in sync for whatever
  // setChrome call comes next from a real scroll.
  const setChromeInstant = useCallback(
    (next: boolean): void => {
      visibleRef.current = next;
      chromeAnim.setValue(next ? 1 : 0);
      setChromeMounted(next);
    },
    [chromeAnim],
  );

  // Shared offset→visibility branching, parameterised on HOW to apply the chrome-visible state
  // (animated via setChrome for a live scroll event, instant via setChromeInstant for a known
  // offset) — onScroll and syncOffset are the same derivation with a different "how".
  const applyOffset = useCallback((y: number, apply: (next: boolean) => void): void => {
    // Chrome (compose bar) is only shown at the very top of the feed.
    // Scrolling up mid-feed does NOT bring it back — the user must reach the top.
    if (y <= 0) {
      apply(true);
    } else if (y > HIDE_AFTER) {
      apply(false);
    }

    const jump = y > JUMP_AFTER;
    setShowJump(s => (s === jump ? s : jump));
  }, []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      applyOffset(e.nativeEvent.contentOffset.y, setChrome);
    },
    [applyOffset, setChrome],
  );

  const syncOffset = useCallback(
    (y: number): void => {
      applyOffset(y, setChromeInstant);
    },
    [applyOffset, setChromeInstant],
  );

  return {chromeAnim, chromeMounted, showJump, onScroll, syncOffset};
}

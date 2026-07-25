/**
 * useReturnToLatest — drives the floating "return to latest" button for a scrollable transcript.
 *
 * Works for either anchoring:
 *  • 'top'    — newest sits at offset 0 (feed-style channels, broadcast/private group feeds). The
 *               button shows once the user scrolls DOWN past the threshold into older items.
 *  • 'bottom' — newest sits at the end (DM + group chats). The button shows once the user scrolls
 *               UP more than the threshold away from the newest message.
 *
 * The visibility is evaluated from the scroll offset. Wire {@link ReturnToLatest.onScroll} to the
 * list's `onScroll` AND `onMomentumScrollEnd` AND `onScrollEndDrag`: a throttled `onScroll` alone
 * drops the FINAL resting frame when a fling settles between throttle windows, which would leave
 * the button stuck visible even after you've reached the edge. The settle callbacks always fire
 * with the true final offset, so the button hides reliably at rest.
 */
import {useCallback, useState} from 'react';
import type {NativeScrollEvent, NativeSyntheticEvent} from 'react-native';

/** px away from the "latest" edge before the button appears. */
const SHOW_AFTER = 320;

export interface ReturnToLatest {
  /** Whether the floating return-to-latest button should be shown. */
  showJump: boolean;
  /** Wire to onScroll + onMomentumScrollEnd + onScrollEndDrag (see module doc). */
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

export function useReturnToLatest(anchor: 'top' | 'bottom', threshold = SHOW_AFTER): ReturnToLatest {
  const [showJump, setShowJump] = useState(false);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const {contentOffset, contentSize, layoutMeasurement} = e.nativeEvent;
      const distance =
        anchor === 'top'
          ? contentOffset.y
          : contentSize.height - (contentOffset.y + layoutMeasurement.height);
      const next = distance > threshold;
      setShowJump(s => (s === next ? s : next));
    },
    [anchor, threshold],
  );
  return {showJump, onScroll};
}

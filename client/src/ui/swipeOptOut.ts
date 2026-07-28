/**
 * swipeOptOut — the "stand this one touch down for me" escape hatch shared by every page-level swipe
 * gesture (today: the tab swipe in `useTabSwipe`, and swipe-back in `SwipeBack`).
 *
 * WHY THIS EXISTS AT ALL: a native horizontal `ScrollView`'s own scroll responder, and a
 * `TextInput`'s selection-handle drag, never join JS `PanResponder` negotiation — they are answered
 * by the platform directly. So when an ANCESTOR'S PanResponder grants itself a horizontal drag (a tab
 * swipe, a swipe-back), it wins unconditionally and steals the touch out from under a rail that was
 * scrolling itself, or a field that was dragging a text selection. There is no responder-side fix for
 * this (the child was never a responder to begin with) — the only fix is the ancestor learning to
 * stand down BEFORE it claims, for the one touch that started on an opted-out descendant.
 *
 * THE MECHANISM: a descendant (a chip rail, in practice) spreads these three handlers onto its own
 * `ScrollView`/`TextInput`. They flip a shared flag on touch start/end/cancel; the ancestor gesture's
 * `isExcluded()` getter reads that flag LIVE (never a value captured at render time — see
 * `useTabSwipe`'s and `useSwipeBack`'s own ref-refresh notes) and declines to claim while it is set.
 * Chips and fields stay tappable either way — a tap never claims a PanResponder gesture in the first
 * place, opted-out or not.
 *
 * Empty (`{}`) outside a provider — a safe no-op — so a descendant that spreads these without any
 * opt-out-aware ancestor above it simply behaves exactly as if the opt-out didn't exist.
 *
 * HISTORY: built 2026-07-23 as `useTabSwipe.ts`'s own `TabRailTouchContext`/`RailTouchHandlers`, under
 * a name that only made sense for chip rails opting out of the TAB swipe specifically. Promoted to
 * this file 2026-07-27 because `SwipeBack.tsx` needed the identical mechanism for a different set of
 * nested opt-outs (composer inputs, the profile channel rail, …) and "TabRail…" would have been a lie
 * at every one of those call sites. `useTabSwipe.ts` re-exports the old names verbatim, so every
 * shipped chip rail keeps compiling — and behaving — exactly as before.
 *
 * Per the swipe-back plan (PLAN_SWIPE_BACK_GESTURE_2026-07-27.md, "Opt-outs"): `SwipeBackView` and the
 * sub-screen transition hook each provide their OWN value into this same context, so a rail nested
 * several layers deep always opts out of whichever swipe actually wraps it, not some outer one that
 * may not even be live at that point (a drill-in page's swipe-back, for instance, shadows the tab
 * swipe's provider — which is moot anyway, since the tab swipe is `enabled: false` under any open
 * sub-screen).
 */
import {createContext, useContext} from 'react';

export type SwipeOptOutHandlers = {
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  onTouchCancel?: () => void;
};

export const SwipeOptOutContext = createContext<SwipeOptOutHandlers>({});

/** `useContext(SwipeOptOutContext)`, named for what a call site is DOING ("opt this out") rather than
 *  what the value IS — most call sites want exactly one thing: the handlers to spread onto their own
 *  scroller so whichever swipe currently wraps them stands down for that touch. */
export function useSwipeOptOut(): SwipeOptOutHandlers {
  return useContext(SwipeOptOutContext);
}

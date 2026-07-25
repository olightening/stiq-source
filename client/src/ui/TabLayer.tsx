/**
 * TabLayer — one top-level tab body inside MainScreen's always-mounted "tab stage"
 * (UI smoothness overhaul Phase 4.1, PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md).
 *
 * Historically the three tab bodies rendered as `{tab === 'feed' && …}` etc., so every dock press
 * fully unmounted one body and mounted another — the single biggest "every click is a flicker"
 * mechanism: lists re-measured from zero, scroll positions needed a hand-rolled save/restore, and
 * heavy screens paid their whole mount cost on every visit. TabLayer keeps each body mounted and
 * hides it instead:
 *
 * - Lazy until first visit: a layer whose tab has never been active renders nothing at all, so
 *   app startup pays for exactly one tab body (same as before this component existed).
 * - Once shown, mounted forever. Hiding is `opacity: 0` + `pointerEvents: 'none'` — deliberately
 *   NOT `display: 'none'`, which resets a FlatList's scroll offset on Android (the documented
 *   reason the feed stays laid out under the thread overlay). Native scroll positions therefore
 *   survive tab switches with no restore machinery.
 * - Frozen while hidden: the children subtree skips React reconciliation entirely (a memo wrapper
 *   whose comparator reports "unchanged" while frozen), so runtime snapshot emits cost nothing for
 *   the two invisible tabs. The first render after re-activation picks up all the latest props.
 * - Frozen while COVERED (2026-07-22 latency round): when an opaque full-screen surface sits above
 *   the stage — a drill-in sub-screen overlay, the notifications center, the composer — the layer
 *   beneath stays VISIBLE and laid out (it must be painted the instant the cover unmounts, and it
 *   peeks through the entrance slide's top sliver) but skips reconciliation and refuses touches.
 *   This is the tap-latency fix: the commit that OPENS a cover flips `covered` in the same render,
 *   so the freeze comparator prunes the entire tab body from that very commit — opening a post
 *   re-renders the overlay, not the ~10 memo-defeated PostCards underneath it.
 *
 * Layers are absolutely-filled siblings inside the stage container, so hidden layers take no part
 * in layout and the active one always spans the stage.
 */
import React, {useRef} from 'react';
import {StyleSheet, View} from 'react-native';

/** Reconciliation gate: while `frozen`, the comparator claims props are equal, so React re-uses
 * the previously committed subtree untouched (children element churn included). The unfreeze
 * render re-renders children with whatever props exist at that moment — nothing is stale for the
 * frame that is actually visible. */
const Freeze = React.memo(
  function FrozenChildren({children}: {frozen: boolean; children: React.ReactNode}): React.JSX.Element {
    return <>{children}</>;
  },
  (_prev, next) => next.frozen,
);

export interface TabLayerProps {
  /** Is this layer the surface the user is currently on? */
  active: boolean;
  /** An opaque full-screen surface (sub-screen overlay / full-screen Modal) sits above the stage.
   * The layer keeps its visibility (opacity untouched — see the header note) but is frozen and
   * untouchable for the duration. Meaningful for the ACTIVE layer; hidden layers are frozen anyway. */
  covered?: boolean;
  testID?: string;
  children: React.ReactNode;
}

export function TabLayer({active, covered = false, testID, children}: TabLayerProps): React.JSX.Element | null {
  const everActive = useRef(active);
  if (active) everActive.current = true;
  // Never visited → costs nothing (neither mount time nor memory).
  if (!everActive.current) return null;
  const interactive = active && !covered;
  return (
    <View
      testID={testID}
      // collapsable would let Android flatten this wrapper away and lose the opacity toggle.
      collapsable={false}
      style={[StyleSheet.absoluteFill, !active && styles.hidden]}
      pointerEvents={interactive ? 'box-none' : 'none'}
      importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!interactive}>
      <Freeze frozen={!active || covered}>{children}</Freeze>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {opacity: 0},
});

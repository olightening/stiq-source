/**
 * BottomDock — the app's primary navigation (Current · Spaces · Updates) as a floating CENTRED PILL: a
 * compact dark pill, horizontally centred toward the bottom of the screen, ALWAYS visible while the
 * dock is mounted. There is no collapse toggle and no ≡ bubble — the parent screen decides when the
 * dock is "on" (root tabs only; hidden on drill-in sub-screens), and while it is on the tabs simply
 * show. This evolves the earlier fluid-bubble dock (a ≡ circle that sprang open a pill) per user
 * direction: drop the toggle, keep the pill always on, centred.
 *
 *  - The tabs render in the FIXED order they are given (Current · Spaces · Updates) and never move.
 *    Earlier versions rotated the active tab into the centre slot; a nav bar whose items shuffle
 *    under the thumb costs the reader their spatial memory of where each destination lives, so the
 *    row is now static and "you are here" is carried purely by the active chip's highlight.
 *  - Tapping a tab switches to it. Persisting the choice as the launch default is the SCREEN's job
 *    (MainScreen writes dockPrefs on every tab change — dock press, stage swipe or a programmatic
 *    jump alike), so this component stays presentational.
 *  - The pill keeps the dark surface + faint identity aurora treatment (the Log hearth's
 *    blue/violet/pink radial washes at low opacity) with the light hairline + lifted shadow.
 *  - Optional `jump` slot: a matching ↑ bubble pinned to the row's RIGHT edge (the feed's
 *    return-to-top control). It is absolutely positioned so it never shifts the pill off-centre,
 *    whether it is showing or not.
 *
 * Mount once as shared chrome inside the screen's root SafeAreaView (NOT per-tab, NOT at App.tsx
 * level) so it stays put while content scrolls beneath and inherits the iOS home-indicator inset
 * (absolute children position against the SafeAreaView's padded box; Android is not edge-to-edge
 * here, targetSdk 34, so the same flat bottom constant clears the nav bar there too).
 *
 * The ↑ bubble animates transform+opacity only on the native driver (mount-before-show,
 * animate-then-unmount-on-hide — the useScrollChrome pattern), and the dock is a root-level SIBLING
 * of the content: it must never become an Animated ancestor of the feed subtree (documented hang).
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {Press} from './Press';
import Svg, {Defs, RadialGradient, Rect, Stop} from 'react-native-svg';
import {colors, radius, weight, DENSE_MAX_FONT_SCALE} from './theme';

/** The dock's bottom offset inside the root SafeAreaView — lifted well off the bottom edge so the
 *  pill sits inside the natural thumb arc rather than down in the gesture-bar zone. */
const DOCK_BOTTOM = 30;

/** ↑ jump-bubble diameter — a small, unobtrusive blue thumb target pinned to the right of the pill. */
const BUBBLE_SIZE = 40;

/**
 * Vertical space a scroll surface must reserve at its bottom so its last item can scroll clear of
 * the floating dock. Every top-level scroll surface (feed, channel list, log hearth) adds this to
 * its bottom padding, and the feed's jump-to-top FAB uses it as its raised `bottom` — one source of
 * truth so the dock's footprint stays consistent everywhere. Sized to the pill footprint
 * (= DOCK_BOTTOM + pill height + breathing gap).
 */
export const BOTTOM_DOCK_CLEARANCE = 100;

export interface DockItem {
  /** Stable identity for the React key (the tab id: 'feed' | 'channels' | 'log'). */
  key: string;
  /** Visible label — also what tests press by text, so it must render as a Text's string child. */
  label: string;
  active: boolean;
  onPress: () => void;
}

/** The optional right-aligned return-to-top bubble (the feed passes this; other tabs omit it). */
export interface DockJump {
  visible: boolean;
  onPress: () => void;
}

/** The shared identity-aurora wash (Log-hearth blue/violet/pink), clipped to its container. The id
 *  prefix keeps the pill's and the ↑ bubble's gradient defs distinct (react-native-svg ids are global). */
function AuroraWash({idPrefix}: {idPrefix: string}): React.JSX.Element {
  return (
    <View style={s.auroraFill} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id={`${idPrefix}1`} cx="16%" cy="35%" rx="70%" ry="140%">
            <Stop offset="0" stopColor="#7cb2ff" stopOpacity={0.24} />
            <Stop offset="1" stopColor="#7cb2ff" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${idPrefix}2`} cx="52%" cy="14%" rx="55%" ry="140%">
            <Stop offset="0" stopColor="#b89aff" stopOpacity={0.2} />
            <Stop offset="1" stopColor="#b89aff" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${idPrefix}3`} cx="88%" cy="74%" rx="72%" ry="150%">
            <Stop offset="0" stopColor="#f472b6" stopOpacity={0.12} />
            <Stop offset="1" stopColor="#f472b6" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${idPrefix}1)`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${idPrefix}2)`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${idPrefix}3)`} />
      </Svg>
    </View>
  );
}

export function BottomDock({items, jump}: {items: readonly DockItem[]; jump?: DockJump}): React.JSX.Element {
  // The ↑ bubble follows the mount-before-show / animate-then-unmount discipline so it never pops
  // while the reader scrolls past the show threshold.
  const jumpVisible = !!jump?.visible;
  const [jumpMounted, setJumpMounted] = useState(jumpVisible);
  const jumpAnim = useRef(new Animated.Value(jumpVisible ? 1 : 0)).current;
  useEffect(() => {
    if (jumpVisible) {
      setJumpMounted(true);
      Animated.spring(jumpAnim, {toValue: 1, useNativeDriver: true, bounciness: 6, speed: 24}).start();
    } else {
      Animated.timing(jumpAnim, {
        toValue: 0,
        duration: 120,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({finished}) => {
        if (finished) setJumpMounted(false);
      });
    }
    return () => jumpAnim.stopAnimation();
  }, [jumpVisible, jumpAnim]);

  return (
    // Full-width strip pinned to the bottom; `box-none` keeps it transparent to touches everywhere
    // except the pill/↑ bubble, so content still scrolls through the empty space beside the dock.
    // The pill is centred; the ↑ bubble is absolutely pinned right so it never shifts that centre.
    <View style={s.wrap} pointerEvents="box-none">
      <View style={s.dock} accessibilityRole="tablist">
        <AuroraWash idPrefix="stiqDockAu" />
        {/* Fixed order — the row is rendered exactly as given and never reshuffles on selection. */}
        {items.map(it => (
          <Press
            key={it.key}
            onPress={it.onPress}
            // The pill is deliberately compact; generous invisible hit-slop keeps every item an
            // easy thumb target without bloating the visual size.
            hitSlop={{top: 12, bottom: 12, left: 4, right: 4}}
            accessibilityRole="tab"
            accessibilityState={{selected: it.active}}
            accessibilityLabel={it.label}
            style={[s.item, it.active && s.itemActive]}>
            {({pressed}) => (
              <Text
                numberOfLines={1}
                style={[s.label, it.active ? s.labelActive : pressed && s.labelPressed]}>
                {it.label}
              </Text>
            )}
          </Press>
        ))}
      </View>
      {jump && jumpMounted && (
        <Animated.View
          style={[
            s.jumpSlot,
            {
              opacity: jumpAnim,
              transform: [{scale: jumpAnim.interpolate({inputRange: [0, 1], outputRange: [0.6, 1]})}],
            },
          ]}>
          <Press
            onPress={jump.onPress}
            hitSlop={10}
            accessibilityLabel="scroll to top"
            style={s.jumpBubble}>
            <Text style={s.jumpChevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⌄</Text>
          </Press>
        </Animated.View>
      )}
    </View>
  );
}

/** Shared chrome for both the pill and the ↑ bubble: dark surface, light hairline, lifted shadow. */
const chrome = {
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.1)',
  shadowColor: '#000',
  shadowOpacity: 0.4,
  shadowRadius: 26,
  shadowOffset: {width: 0, height: 12},
  elevation: 10,
  backgroundColor: colors.surface,
} as const;

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: DOCK_BOTTOM,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  // Compact metrics (paddings/type a notch tighter than the original design) so the centred
  // three-tab pill AND the right-pinned ↑ bubble coexist on a 360dp screen: the ~197dp pill centres
  // to roughly [82, 279]; the small 40dp ↑ bubble sits at [304, 344] (right:16) — ~25dp of air.
  // hitSlop keeps the touch targets full-size.
  dock: {
    ...chrome,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 5,
    borderRadius: radius.pill,
    overflow: 'visible',
  },
  // The ↑ bubble is absolutely pinned to the right edge and vertically centred against the pill's
  // row, so it can appear/disappear without ever nudging the centred pill.
  jumpSlot: {
    position: 'absolute',
    right: 16,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Solid blue accent (not the pill's aurora wash) so the return-to-top control reads as a distinct
  // action; keeps the lifted shadow, drops the light hairline for a clean fill. A faint white rim
  // lifts it off dark content.
  jumpBubble: {
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    borderRadius: BUBBLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: {width: 0, height: 8},
    elevation: 10,
  },
  // The ⌄ caret rotated up (the JumpButton idiom), white on the blue accent fill.
  jumpChevron: {
    color: colors.onAccent,
    fontSize: 15,
    lineHeight: 15,
    fontWeight: '800',
    textAlign: 'center',
    includeFontPadding: false,
    transform: [{rotate: '180deg'}],
    marginTop: -1,
  },
  // The aurora layer: absolutely fills its container and clips itself to the rounded shape. A large
  // radius clips correctly for both the pill and the circle (the circle's own radius is smaller).
  auroraFill: {...StyleSheet.absoluteFillObject, borderRadius: radius.pill, overflow: 'hidden'},
  // Every tab gets an identical fixed footprint so the pill stays symmetrical and its total width
  // never changes as the selection moves. The fixed width (not intrinsic text width) supplies the spacing,
  // so paddingHorizontal is trimmed right down and the centred label floats in an equal-width chip.
  // Sized to fit the longest label (~7 chars at 13.5px) while keeping the 3-tab pill compact enough
  // to still clear the right-pinned ↑ bubble on a 360dp screen.
  item: {
    width: 62,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
  },
  // Selected = a soft glass chip on the dark aurora, for an unmistakable "you are here".
  itemActive: {backgroundColor: 'rgba(255,255,255,0.12)'},
  // Muted light label on the dark aurora; centred both ways (includeFontPadding:false drops
  // Android's asymmetric font padding so the word doesn't sit high in the pill).
  label: {
    fontSize: 13.5,
    lineHeight: 17,
    fontWeight: weight.semibold,
    color: colors.textSecondary,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  labelActive: {color: colors.textPrimary},
  // Pressed feedback for an inactive item — brighten toward the active colour.
  labelPressed: {color: colors.textPrimary},
});

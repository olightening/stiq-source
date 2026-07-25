/**
 * PictureChip — renders a Stiq Picture in a body (feed / comments / DM / channel), matching the
 * design's in-context spec.
 *
 * Idle: a quiet chip "🖼️ Label · tap to load" — no size, no specs. Tapping EXPANDS that chip into the
 * preview card: the card grows from the chip's own footprint to a square (.38s cubic-bezier) while the
 * chip's face cross-fades away and the loading ring fades up in its place, and the picture paints into
 * the same frame the moment the bytes land. Once loaded, a "double-tap to open" hint flashes;
 * double-tapping the picture opens the fullscreen viewer — the only place Save PNG lives, so saving
 * is intentional too.
 *
 * Double-tap is the ONLY route into the viewer. There used to be a redundant ⤢ button in the stage's
 * bottom-right doing exactly the same thing; it was removed as clutter. That makes the double-tap
 * detector (markTap) load-bearing rather than a convenience — if it stops registering, the viewer
 * becomes unreachable. It is timed from onPressIn for that reason; see the note there.
 *
 * ## THE FRAME IS NEVER ABSENT (bug 3 — read this before restructuring the tree)
 *
 * The reported defect was that tapping a chip made the card vanish and leave a hole for a moment
 * before the preview appeared. The cause was structural, not a timing tweak: idle and loading were
 * two DIFFERENT render branches. Tapping unmounted the chip and mounted a stage whose animated height
 * started at ZERO — so for the first frames of the tween there was, literally, nothing on screen where
 * the card had been, and the feed jumped.
 *
 * So there is now ONE tree. A single frame is mounted in every state; the tap only changes its height
 * and what is painted inside it. The tween starts at the chip's MEASURED height (never 0), so the
 * first expanded frame is pixel-identical to the chip that was there the frame before. Every state
 * change since — failure, retry, cache-clear, row recycling — moves that one frame rather than
 * swapping trees. **Do not re-introduce a `return <chip/>` early exit**: an early return is exactly
 * the shape of the original bug, and `PictureChip.transition.test.tsx` fails if the frame ever renders
 * empty or shorter than the chip between tap and paint.
 *
 * ## The ring means it (no fake delay, ever again)
 *
 * This component used to hold "Fetching over Tor…" up behind a hardcoded `780 + random*480` ms timer:
 * nothing was fetched, because the bytes had always arrived inline with the feed. That is gone and
 * must never come back — a fake delay bolted onto a now-real fetch would be strictly worse than
 * either. The tap drives a real id-scoped REQ for the picture's blob (media/mediaBlobService.ts) and
 * every state below — including `error`, which Tor's flakiness makes routine rather than theoretical —
 * is driven by that request's actual lifecycle. The ring is indefinite because Tor is: it is never
 * timed, and it is only shown when the load genuinely leaves the device ({@link crossesTor}). A legacy
 * inline picture, or a blob already in the local store, has nothing to fetch — it expands and paints,
 * and is never made to look slow.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Image, Modal, StyleSheet, Text, View} from 'react-native';
import Reanimated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {Press} from '../../ui/Press';
import {colors, radius, space, weight as fweight} from '../../ui/theme';
import {Icon} from '../../ui/icons';
import {getMediaService} from '../../media/mediaService';
import {getMediaBlobService} from '../../media/mediaBlobService';
import {useMediaBlob, type MediaLoadError} from '../../media/useMediaBlob';
import {indexedPngDataUri} from '../../media/png';
import {fmtKB, weight as pictureWeight} from '../pixelEngine';
import {decodePicturePayload, type InlinePicture} from '../picture';
import type {MediaSource} from '../mediaBlob';

export interface PictureChipProps {
  picture: InlinePicture;
  /** Flag the picture to channel admins (⚑ in the viewer). */
  onReport?: () => void;
}

/** The design's expand motion: .38s on cubic-bezier(.2,0,0,1). */
const EXPAND_MS = 380;
/** Collapsing back to the chip (a failure) is quicker — it is a retreat, not a reveal. */
const COLLAPSE_MS = 240;
const CURVE = Easing.bezier(0.2, 0, 0, 1);

/** Integer upscale so `res` big-pixels fill roughly `target` px, kept crisp (nearest-neighbour). */
function scaleFor(res: number, target: number, max = 8): number {
  return Math.max(1, Math.min(max, Math.round(target / res)));
}

/**
 * Will loading `source` actually leave this device? Decided ONCE per tap, and it is the ONLY thing
 * that puts "Fetching over Tor…" on screen — the caption states a fact, so it may only appear when
 * the fact holds. Three cases resolve with no network at all and must therefore stay silent:
 *
 *   • an `inline` source (a legacy body whose bytes rode with the post) — there is nothing to fetch;
 *   • a blob already in the local event store (loaded earlier, or our own published picture) — a
 *     re-tap after Settings clears the rendered-media cache re-decodes from the store, and telling
 *     the viewer it went to Tor would be the old lie in miniature;
 *   • no bound blob service, or Tor down — `loadMediaSource` rejects 'offline' at once and no REQ is
 *     ever issued, so the viewer gets "Not connected" without a ring pretending otherwise first.
 *
 * These are exactly `loadMediaSource`'s own no-network fast paths, read back (media/mediaBlobService
 * .ts, and its `peek`/`isConnected` are documented synchronous and fetch-free). Keep the two in step:
 * if that function grows another way to answer without the network, it belongs here too — the cost of
 * drift is a caption that overstates, which is the whole class of bug this component is paying off.
 * Runs per TAP, never per render, so a feed full of chips still costs nothing.
 */
function crossesTor(source: MediaSource): boolean {
  if (source.kind === 'inline') return false;
  const svc = getMediaBlobService();
  if (svc === null) return false;
  return svc.peek(source.blobId) === null && svc.isConnected();
}

export function PictureChip({picture, onReport}: PictureChipProps): React.JSX.Element {
  // The load lifecycle (fetch over Tor → decode → loaded/error) is the SHARED one, so this chip and
  // the voice player can never drift in how they load or how they fail. `decodePicturePayload` is the
  // only picture-specific part; it is module-scope, so it is referentially stable for the hook.
  const {state, value: decoded, error, retryable, load: startLoad} = useMediaBlob(picture.source, decodePicturePayload);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Whether the frame is currently the preview card (height driven by `stageH`) rather than resting at
  // the chip's natural height. The ONLY structural switch in this component — and it changes the
  // frame's height and contents, never whether the frame exists.
  const [expanded, setExpanded] = useState(false);
  // Whether the stage is actively resizing — used to scope a hardware texture to JUST the resize,
  // never left dangling once it settles (design gotcha: a stale rasterized layer left on an Android
  // view after a layout-changing animation renders it — and, since it sits inside a FlatList row, the
  // whole on-screen viewport — blurry until scroll forces recycling to redraw).
  const [resizing, setResizing] = useState(false);
  // Whether THIS load is genuinely crossing Tor (see `crossesTor`). Latched at the tap.
  const [overTor, setOverTor] = useState(false);
  // Busy state for savePng. Mirrored in a ref because the guard has to hold WITHIN one tick — the
  // encode blocks long enough to tap through, and setState wouldn't have committed yet.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Phase 4.4 (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md): the height tween is reanimated now, so
  // the per-frame relayout is driven from the UI thread instead of ticking the JS thread — the last
  // JS-driven animation that lived inside feed rows.
  const stageH = useSharedValue(0);
  const chipOpacity = useSharedValue(1);
  const contentOpacity = useSharedValue(0);
  const hintOpacity = useSharedValue(0);
  const lastTap = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Animation generation. Completion callbacks land asynchronously (runOnJS off the UI thread), so
  // a tween superseded mid-flight — retry tap over a collapse, failure over an expansion — must not
  // let its late "I was cancelled" callback stomp the state of the tween that took over.
  const animGen = useRef(0);
  const mounted = useRef(true);
  // The chip's measured box. REFS, not state: nothing in the render reads them — they only feed the
  // tween — so measuring must not cost every picture in the feed a re-render.
  const width = useRef(0);
  const chipH = useRef(0);
  // Mirrors `expanded` for `expand`, which must read it without depending on it (a dep would churn
  // `load`'s identity on every tap).
  const expandedRef = useRef(false);

  const label = picture.label && picture.label.trim() ? picture.label.trim() : 'Picture';
  const failed = state === 'error';
  // Nothing to press when the bytes are unreadable — retrying can never fix them.
  const dead = failed && !retryable;
  // The chip's face is inert only while the stage genuinely owns the frame. A failure hands the frame
  // straight back — before the collapse has finished animating — so a retry tap is live the instant
  // the viewer can read that it failed, rather than being swallowed for the length of a tween.
  const chipInert = expanded && !failed;

  useEffect(() => {
    // timers.current is a stable array (only pushed to, never reassigned), so capturing it here and
    // clearing it on unmount drains every timer added over the component's life.
    const t = timers.current;
    return () => {
      mounted.current = false;
      t.forEach(clearTimeout);
      cancelAnimation(stageH);
      cancelAnimation(chipOpacity);
      cancelAnimation(contentOpacity);
      cancelAnimation(hintOpacity);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setExpandedBoth = useCallback((next: boolean): void => {
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  /** Grow the frame from the height the chip occupies RIGHT NOW to a square, and fade the faces. */
  const expand = useCallback((): void => {
    const gen = ++animGen.current;
    // Entering from rest: pin the tween to the chip's measured height so the first expanded frame is
    // pixel-identical to the chip that was on screen the frame before. THIS is what makes the
    // transition continuous — starting at 0 (or at a stale value) is the original bug. Already
    // expanded (a retry mid-collapse) means `stageH` is live and must be left where it is.
    // (Assigning a shared value mid-tween also cancels that tween, so no explicit stop is needed.)
    if (!expandedRef.current) stageH.value = chipH.current;
    setExpandedBoth(true);
    setResizing(true);
    const settle = (): void => {
      if (mounted.current && animGen.current === gen) setResizing(false);
    };
    // The height tween re-lays-out the row every frame — reanimated drives it from the UI thread,
    // so a busy JS tick no longer stutters the growth. `resizing` rasterizes JUST the frame for
    // that window, and the completion callback drops it the instant the animation settles — never
    // left stuck on, which is what left neighbours blurry.
    stageH.value = withTiming(width.current, {duration: EXPAND_MS, easing: CURVE}, finished => {
      if (finished) runOnJS(settle)();
    });
    // The chip's face leaves early so the card reads as growing rather than as a label being
    // stretched; the stage's contents come up over the whole expansion, so the ring becomes legible
    // exactly as the frame makes room for it and never flashes in a box too small to hold it.
    chipOpacity.value = withTiming(0, {duration: 200, easing: CURVE});
    contentOpacity.value = withTiming(1, {duration: EXPAND_MS, easing: CURVE});
  }, [stageH, chipOpacity, contentOpacity, setExpandedBoth]);

  /**
   * Shrink the frame back to the chip. `animated` is false for a reset that isn't a gesture on this
   * card (the cache was cleared, or a FlatList row was recycled onto a different picture) — there is
   * nothing to narrate, so it snaps.
   */
  const collapse = useCallback(
    (animated: boolean): void => {
      const gen = ++animGen.current;
      const rest = (): void => {
        if (!mounted.current) return;
        setExpandedBoth(false);
        setResizing(false);
        setOpen(false);
      };
      if (!animated || chipH.current === 0) {
        // Direct assignment cancels any in-flight tween on each value and snaps it.
        stageH.value = chipH.current;
        chipOpacity.value = 1;
        contentOpacity.value = 0;
        rest();
        return;
      }
      setResizing(true);
      const done = (finished: boolean): void => {
        // A stale generation means a retry tap took over mid-collapse — it owns the frame now, so
        // leave it expanded and let `expand` carry on from wherever the height happens to be.
        if (animGen.current !== gen) return;
        if (finished) rest();
        else if (mounted.current) setResizing(false);
      };
      stageH.value = withTiming(chipH.current, {duration: COLLAPSE_MS, easing: CURVE}, finished => {
        runOnJS(done)(finished === true);
      });
      chipOpacity.value = withTiming(1, {duration: COLLAPSE_MS, easing: CURVE});
      contentOpacity.value = withTiming(0, {duration: 160, easing: CURVE});
    },
    [stageH, chipOpacity, contentOpacity, setExpandedBoth],
  );

  /** Tap → kick off the REAL fetch+decode, and expand the frame to meet it. */
  const load = useCallback((): void => {
    // Un-measured (the very first frame, before layout): there is no height to grow from, so there is
    // no honest transition to run. Rather than blank the card, do nothing — the next tap works.
    if (width.current === 0 || chipH.current === 0) return;
    setOverTor(crossesTor(picture.source));
    startLoad();
    expand();
  }, [picture.source, startLoad, expand]);

  // The load ENDED — react to the real outcome rather than to a timer that pretended to be one.
  useEffect(() => {
    if (state !== 'loaded') return;
    // Flash "double-tap to open" for 2200ms.
    hintOpacity.value = withTiming(0.95, {duration: 300});
    const t = setTimeout(() => {
      if (mounted.current) hintOpacity.value = withTiming(0, {duration: 300});
    }, 2200);
    timers.current.push(t);
  }, [state, hintOpacity]);

  useEffect(() => {
    // `error` — come back to a chip that says what happened, rather than leaving a black square over a
    // fetch that is never going to land. Animated, so the retreat is as continuous as the reveal: a
    // failure that lands before the expansion finishes retreats from wherever it got to.
    if (state === 'error') collapse(true);
    // `idle` — the SHARED hook reset us: Settings cleared the rendered-media cache, or this row was
    // recycled onto a different picture. Either way the frame is showing something that is no longer
    // ours, so drop straight back to the chip. Driving this off the hook's own state (rather than
    // subscribing to the cache separately, as this component used to) means the animation can never
    // disagree with the load about which picture is on screen, and it fixes recycling — which the
    // cache subscription never covered, leaving a re-used row's next tap to snap open with no tween.
    else if (state === 'idle') collapse(false);
  }, [state, collapse]);

  // Encoding a PNG is NOT free — a 256² picture upscaled for the stage is a 768²-pixel encode — and
  // this component re-renders through the whole expansion. Keyed on the decoded artifact, so it runs
  // once per load rather than once per frame.
  const thumbUri = useMemo(
    () => (decoded ? indexedPngDataUri(decoded.indices, decoded.palette, decoded.res, scaleFor(decoded.res, 640)) : null),
    [decoded],
  );
  const viewerUri = useMemo(
    () => (open && decoded ? indexedPngDataUri(decoded.indices, decoded.palette, decoded.res, scaleFor(decoded.res, 720)) : null),
    [open, decoded],
  );

  // Double-tap, timed from touch-DOWN rather than release. onPress fires on release, so the old
  // version charged each tap's press-and-hold dwell — plus the bridge hop, this app being on the old
  // architecture — against the window before JS ever read the clock. A genuinely quick double-tap
  // could still measure >300ms apart and be ignored. onPressIn is the earliest signal available, and
  // the wider window buys back what a slow device eats.
  const DOUBLE_TAP_MS = 400;
  const markTap = (): void => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      setOpen(true);
      lastTap.current = 0; // consumed — a 3rd tap must not re-open off this one
      return;
    }
    lastTap.current = now;
  };

  const flashToast = (msg: string): void => {
    setToast(msg);
    const t = setTimeout(() => setToast(null), 1600);
    timers.current.push(t);
  };

  const savePng = async (): Promise<void> => {
    if (!decoded || savingRef.current) return; // re-entrancy: the encode is long enough to double-tap through
    const svc = getMediaService();
    if (!svc) {
      flashToast('Saving is unavailable');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // YIELD BEFORE ENCODING, and this is the whole fix for "the buttons are dead".
      //
      // indexedPngDataUri is synchronous and expensive: it builds an RGB buffer up to ~1024*1024*3
      // (~3.1MB) and pushes it through zlibStored a BYTE AT A TIME, then chunk() spreads the whole
      // buffer into an array literal again (media/png.ts:58-82). On the old architecture that blocks
      // the JS thread outright, which stalls ALL touch dispatch — that is why the ✕ appeared broken
      // too. It was never broken; it just couldn't be heard over this.
      //
      // The yield lets React commit the `saving` state and paint the spinner FIRST, so the freeze is
      // at least announced. It does NOT make the encode fast — the real fix is writing into a
      // pre-sized Uint8Array instead of Array.push+spread in png.ts, which is a job for the encoder,
      // not for this component.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const uri = indexedPngDataUri(decoded.indices, decoded.palette, decoded.res, scaleFor(decoded.res, 1024));
      await svc.savePng(uri.slice(uri.indexOf(',') + 1), label);
      flashToast('Saved to Photos');
    } catch {
      flashToast('Could not save');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false); // the encode outlives a fast close; honour the file's mounted guard
    }
  };

  const stageHeightStyle = useAnimatedStyle(() => ({height: stageH.value}));
  const chipFaceStyle = useAnimatedStyle(() => ({opacity: chipOpacity.value}));
  const stageContentStyle = useAnimatedStyle(() => ({opacity: contentOpacity.value}));
  const hintStyle = useAnimatedStyle(() => ({opacity: hintOpacity.value}));

  return (
    <View style={s.wrap}>
      {/* THE FRAME. Mounted in every state; the tap moves it, it never swaps out. At rest it is a
          transparent, height-auto container and the chip inside draws the whole card, so an idle
          picture is pixel-for-pixel the chip it always was. */}
      <Reanimated.View
        style={[s.frame, expanded && s.frameStage, expanded && stageHeightStyle]}
        renderToHardwareTextureAndroid={resizing}>
        {/* The chip's face. Stays painted while the frame grows out from underneath it — pinned to the
            top so it holds still and fades, rather than being dragged down by the growing box. It is
            never unmounted: it is what the frame retreats to on a failure, and remounting it would
            re-introduce a frame where neither face is on screen. */}
        <Reanimated.View
          style={[expanded && s.chipPinned, chipFaceStyle]}
          pointerEvents={chipInert ? 'none' : 'auto'}
          accessibilityElementsHidden={chipInert}
          importantForAccessibility={chipInert ? 'no-hide-descendants' : 'auto'}>
          <Press
            // Press supplies the pressed-state feedback itself (scale+dim); this custom
            // background-tint pressedStyle layers the chip's own highlight on top of it.
            style={s.chip}
            pressedStyle={dead ? undefined : s.chipPressed}
            onPress={dead ? undefined : load}
            onLayout={e => {
              const {width: w, height: h} = e.nativeEvent.layout;
              width.current = w;
              // Only while resting: expanded, this box is pinned and would measure the pinned height
              // back over the natural one it is supposed to remember.
              if (!expandedRef.current && h > 0) chipH.current = h;
            }}
            accessibilityLabel="picture-chip"
            disabled={dead}>
            <View style={[s.tile, dead && s.tileDead]}>
              <Icon name="🖼️" size={17} />
            </View>
            <Text style={s.chipLabel} numberOfLines={1}>
              {failed ? errorLabel(error) : label}
              {/* A transport failure is worth another go over a flaky Tor circuit; unreadable bytes
                  never will be, so we stop inviting a tap that cannot work. Same words, same ↻/⚠,
                  same quieted disc as VoicePlayer — one mechanism, one vocabulary. */}
              {!failed && <Text style={s.chipDim}> · tap to load</Text>}
              {failed && retryable && <Text style={s.chipDim}> · tap to retry</Text>}
            </Text>
            <View style={s.go}>
              <Text style={s.goIcon}>{failed ? (retryable ? '↻' : '⚠') : '↓'}</Text>
            </View>
          </Press>
        </Reanimated.View>

        {/* The stage's contents, fading up into the space the expansion is making. */}
        {expanded && (
          <Reanimated.View
            style={[s.stageFill, stageContentStyle]}
            pointerEvents={state === 'loaded' ? 'auto' : 'none'}
            accessibilityLabel="picture-stage">
            {state === 'loaded' && thumbUri && (
              // bare: a double-tap-to-open gesture surface over the loaded photo — scale/dim feedback
              // here would fight the photo itself, and the tap outcome is the fullscreen viewer, not a
              // button press.
              <Press variant="bare" style={s.stageFill} onPressIn={markTap}>
                <Image source={{uri: thumbUri}} style={s.stageImg} resizeMode="cover" accessibilityLabel="picture-image" />
              </Press>
            )}
            {/* The loading circle the card expands into. Indefinite by design: it is bound to a real
                Tor round-trip whose duration nobody can predict, so it is never given a duration and
                never given a fake one. The caption appears only when the load truly leaves the
                device (`crossesTor`) — a local decode expands and paints without ever claiming a
                fetch it did not make. */}
            {state === 'loading' && overTor && (
              <View style={s.loadOverlay}>
                <Spinner />
                <Text style={s.loadCap}>Fetching over Tor…</Text>
              </View>
            )}
            {state === 'loaded' && (
              <Reanimated.View style={[s.hint, hintStyle]} pointerEvents="none">
                <Text style={s.hintText}>double-tap to open</Text>
              </Reanimated.View>
            )}
          </Reanimated.View>
        )}
      </Reanimated.View>

      {toast && (
        <View style={s.toastInline}>
          <Text style={s.toastText}>{toast}</Text>
        </View>
      )}

      {/* Fullscreen viewer — the only place Save PNG lives (design .viewer). Always mounted and
          toggled by `visible` (RN renders nothing at all while it is false), per the house rule: a
          Modal mounted in order to show it does not reliably appear on Android. */}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={s.viewer}>
          <View style={s.viewerTop}>
            <Press
              style={s.viewerX}
              pressedStyle={s.viewerXPressed}
              onPress={() => setOpen(false)}
              hitSlop={10}
              accessibilityLabel="Close picture">
              <Text style={s.viewerXIcon}>✕</Text>
            </Press>
            <Text style={s.viewerTitle} numberOfLines={1}>{label}</Text>
            <View style={{width: 38}} />
          </View>
          <View style={s.viewerMid}>{viewerUri && <Image source={{uri: viewerUri}} style={s.viewerImg} resizeMode="contain" />}</View>
          <View style={s.viewerBot}>
            {/* Guarded, not asserted: the stage now genuinely has no bytes while it is fetching, and
                this Modal is always mounted (toggled by `visible`) — so `decoded` is legitimately
                null here mid-load. "fetched over Tor" is likewise stated only when it actually was:
                a legacy inline picture arrived with the post and was never fetched at all. */}
            {decoded && (
              <Text style={s.viewerMeta}>
                {decoded.res}² · {decoded.colours} colours · ≈{fmtKB(pictureWeight(decoded.res, decoded.colours))}
                {picture.source.kind === 'blob' ? ' · fetched over Tor' : ''}
              </Text>
            )}
            <View style={s.viewerActs}>
              <Press
                style={s.saveBtn}
                pressedStyle={s.saveBtnPressed}
                onPress={savePng}
                disabled={saving}
                accessibilityState={{busy: saving, disabled: saving}}
                accessibilityLabel="Save picture as PNG">
                <Text style={s.saveText}>{saving ? '⤓ Saving…' : '⤓ Save PNG'}</Text>
              </Press>
              {onReport && (
                <Press
                  style={s.reportBtn}
                  onPress={() => {
                    onReport();
                    flashToast('Report sent to admins');
                  }}>
                  <Text style={s.reportIcon}>⚑</Text>
                </Press>
              )}
            </View>
          </View>
          {toast && (
            <View style={s.toast}>
              <Text style={s.toastText}>{toast}</Text>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

/**
 * What to tell the viewer when a load fails. Deliberately plain-spoken and cause-specific: "couldn't
 * load" for a corrupt picture is honest, but for a dropped Tor circuit it hides the one fact the
 * viewer can act on (wait / retry). Kept word-for-word in step with VoicePlayer's `errorLabel` —
 * these are two faces of one mechanism and must never drift into two vocabularies.
 */
function errorLabel(error: MediaLoadError | null): string {
  switch (error) {
    case 'offline':
      return 'Not connected';
    case 'timeout':
      return "Couldn't fetch picture";
    default:
      return "Couldn't load picture";
  }
}

/** A 0.8s spinning ring (design .pic-load .spin) — UI-thread driven, so it keeps spinning even
 * while the JS thread chews on the arriving bytes. */
function Spinner(): React.JSX.Element {
  const spin = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(withTiming(1, {duration: 800, easing: Easing.linear}), -1, false);
    return () => cancelAnimation(spin);
  }, [spin]);
  const style = useAnimatedStyle(() => ({transform: [{rotate: `${spin.value * 360}deg`}]}));
  return <Reanimated.View style={[s.spinner, style]} accessibilityLabel="picture-spinner" />;
}

const s = StyleSheet.create({
  // marginVERTICAL, not just top: inline media sits in a flat list of text/media siblings
  // (RichText's segment map) where nothing else contributes spacing, so a top-only margin left text
  // butting flush against the bottom of a picture and made the line under it easy to skip.
  wrap: {marginVertical: space.sm},

  // The frame at rest: a transparent, height-auto container. It exists so there is ONE node whose
  // height the tap can drive; it draws nothing of its own, so an idle chip looks exactly as it did
  // before this component had a frame at all.
  frame: {width: '100%'},
  // ...and expanded (design .pic-stage). Applied in the SAME commit that pins the height to the chip's
  // own, at which moment the chip's face still covers the frame edge to edge — so the black and the
  // new radius arrive invisibly, under a face that is already there.
  frameStage: {borderRadius: 14, overflow: 'hidden', backgroundColor: '#000'},
  // Held against the top of the growing frame at its natural height (no explicit height needed —
  // absolute + left/right with height auto shrink-wraps the chip, and stays correct in RTL).
  chipPinned: {position: 'absolute', top: 0, left: 0, right: 0},

  // Idle chip (design .pic-bar): quiet, no specs.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  // Pressed acknowledgement for the tap-to-load chip. Same surface the embed card uses for its own
  // pressed state, so a tap here reads the same as a tap anywhere else in a post body.
  chipPressed: {backgroundColor: colors.surfaceHover},
  tile: {width: 30, height: 30, borderRadius: 8, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center'},
  // A picture that can never load goes quiet rather than sitting there in accent colour inviting a
  // tap that is refused (VoicePlayer's `playBtnDead`, same idea, same trigger).
  tileDead: {backgroundColor: colors.surfaceHover},
  chipLabel: {flex: 1, color: colors.textPrimary, fontSize: 13.5, fontWeight: fweight.semibold},
  chipDim: {color: colors.textMuted, fontWeight: fweight.medium},
  go: {width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceHover, alignItems: 'center', justifyContent: 'center'},
  goIcon: {color: colors.textSecondary, fontSize: 13, fontWeight: fweight.bold},

  // Stage (design .pic-stage).
  stageFill: {...StyleSheet.absoluteFillObject},
  stageImg: {width: '100%', height: '100%'},
  loadOverlay: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10},
  spinner: {width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: '#fff'},
  loadCap: {color: 'rgba(255,255,255,0.8)', fontSize: 11.5, fontWeight: fweight.semibold},
  hint: {
    position: 'absolute',
    bottom: 11,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  hintText: {color: '#fff', fontSize: 10.5, fontWeight: fweight.semibold},

  // Viewer (design .viewer).
  viewer: {flex: 1, backgroundColor: '#000'},
  viewerTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 52, paddingBottom: 10},
  viewerX: {width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center'},
  viewerXPressed: {backgroundColor: 'rgba(255,255,255,0.28)'},
  // lineHeight pinned to the button's own height + explicit centring: the parent centres the Text
  // NODE, but the ✕ glyph's ink sits off-centre inside its line box, because that box comes from the
  // font's asymmetric ascent/descent (plus Android's includeFontPadding).
  viewerXIcon: {color: '#fff', fontSize: 16, lineHeight: 38, textAlign: 'center', textAlignVertical: 'center'},
  viewerTitle: {flex: 1, textAlign: 'center', color: '#fff', fontSize: 15, fontWeight: fweight.semibold},
  viewerMid: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18},
  viewerImg: {width: '100%', height: '100%'},
  viewerBot: {paddingHorizontal: 18, paddingBottom: 34, paddingTop: 16, gap: 14},
  viewerMeta: {color: 'rgba(255,255,255,0.55)', fontSize: 11.5, textAlign: 'center', letterSpacing: 0.2},
  viewerActs: {flexDirection: 'row', gap: 10},
  saveBtn: {flex: 1, backgroundColor: '#fff', borderRadius: 13, paddingVertical: 14, alignItems: 'center'},
  // On a white button, dim rather than tint — a surface colour would read as a different button.
  saveBtnPressed: {opacity: 0.65},
  // Held while the PNG encode blocks the thread, so the button is visibly busy rather than ignored.
  saveBtnBusy: {opacity: 0.5},
  saveText: {color: '#111', fontSize: 14.5, fontWeight: fweight.semibold},
  reportBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 13,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportIcon: {color: 'rgba(255,255,255,0.8)', fontSize: 16},

  toast: {position: 'absolute', bottom: 110, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 9},
  toastInline: {marginTop: 6, alignSelf: 'flex-start', backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7},
  toastText: {color: '#fff', fontSize: 13, fontWeight: fweight.medium},
});

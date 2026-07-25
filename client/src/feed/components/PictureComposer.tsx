/**
 * PictureComposer — the "Add a picture" flow (Choose → Frame → Pixelate → Add).
 *
 * Two deliberate levels, so cropping never fights the pixel engine:
 *  1. FRAME (crop & zoom) — pan / zoom / rotate on the REAL photo. This is a plain GPU-composited
 *     `Animated` transform (translate + scale + rotate); NO pixelation runs, so it's buttery even on
 *     a large photo. The framing is stored as the engine `Transform` (zoom / panX / panY / rot).
 *  2. PIXELATE — freeze the frame and play with resolution / colours / dither on the pixel-art
 *     preview. Pan/zoom is locked here. "Re-crop" drops back to level 1 and the pixel-art disappears
 *     until you pixelate again — you're never in both processes at once.
 *
 * Adding does NOT post — it hands an inline picture token back to whatever is being written (like the
 * Voice / Link inserts), so the primary button reads "Add picture", not Post. Organizer enforcement
 * lives here: the Add button disables when the framed picture's weight exceeds the per-picture cap or
 * the member's remaining per-period allowance (pictureRules).
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  PanResponder,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import {BackModal, useBackDismiss} from '../../ui/back';
import Svg, {Circle} from 'react-native-svg';
import {Press} from '../../ui/Press';
import {colors, radius, space, weight as fweight} from '../../ui/theme';
import {Icon} from '../../ui/icons';
import {getMediaService, type RgbaImage} from '../../media/mediaService';
import {indexedPngDataUri} from '../../media/png';
import {
  DITHER_NAME,
  RES,
  COLOURS,
  IDENTITY_TRANSFORM,
  fmtKB,
  pixelate,
  weight as pictureWeight,
  type Dither,
  type Transform,
} from '../pixelEngine';
import {encodeInlinePicture} from '../picture';
import {evaluatePicture, pictureViolationMessage, type PictureRules} from '../pictureRules';

/**
 * Longer-side cap the native decoder scales the picked photo to (whole photo, no crop). Kept high
 * enough that zooming in still has real source detail to sample: at max zoom (3×) and max res (256²)
 * the framed square needs ~768 source px on its shorter side to stay ≥1:1, so a 4:3 photo wants a
 * ~1024 longer side. Anything less and zoom just reveals the pre-scale blur. (Native clamps maxSide
 * to 1..2048; this stays JS-only.)
 */
const WORK = 1024;

/** Which level of the composer we're in once a photo is picked. */
type Stage = 'frame' | 'pixelate';

export interface PictureComposerProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the finished inline token + its weight (token bytes) when the user taps Add. */
  onAdd: (token: string, weightBytes: number) => void;
  /** Organizer picture limits (allow / caps / allowance). */
  rules: PictureRules;
  /** Token bytes the member has already spent this period. */
  spentBytes: number;
}

const DITHER_LABELS: [Dither, string][] = [
  ['ordered', 'Ordered'],
  ['diffusion', 'Floyd'],
  ['atkinson', 'Atkinson'],
  ['halftone', 'Halftone'],
  ['none', 'Off'],
];

function sizeLabel(res: number): string {
  return res <= 64 ? 'Small' : res <= 128 ? 'Standard' : 'High';
}

/** Clamp a transform's pan to the range where the viewport square still fits inside the photo. */
function clampPan(t: Transform, s: RgbaImage | null): Transform {
  if (!s) return t;
  const visSide = Math.min(s.width, s.height) / Math.max(1, t.zoom);
  const maxFx = Math.max(0, (s.width - visSide) / (2 * s.width));
  const maxFy = Math.max(0, (s.height - visSide) / (2 * s.height));
  return {
    ...t,
    panX: Math.max(-maxFx, Math.min(maxFx, t.panX)),
    panY: Math.max(-maxFy, Math.min(maxFy, t.panY)),
  };
}

/**
 * Screen-space transform for the FRAME preview that reproduces `transformDownsample`'s cover-with-pan
 * geometry exactly, so what you frame is what gets pixelated. The photo is drawn centred at its cover
 * size (shorter side = frame width F); `scale` is the zoom, and the translate slides the viewport
 * centre (source cx,cy) to the frame centre. Because cx maps to F/2, rotation about the frame centre
 * equals the engine's rotation about the viewport centre.
 */
function frameGeom(t: Transform, s: RgbaImage, F: number): {baseW: number; baseH: number; tx: number; ty: number} {
  const coverS = F / Math.min(s.width, s.height);
  return {
    baseW: s.width * coverS,
    baseH: s.height * coverS,
    tx: -t.panX * s.width * coverS * t.zoom,
    ty: -t.panY * s.height * coverS * t.zoom,
  };
}

export function PictureComposer({visible, onClose, onAdd, rules, spentBytes}: PictureComposerProps): React.JSX.Element {
  const [src, setSrc] = useState<RgbaImage | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('frame');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY_TRANSFORM);
  const [res, setRes] = useState(128);
  const [colours, setColours] = useState(32);
  const [dither, setDither] = useState<Dither>('ordered');
  const [label, setLabel] = useState('');
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Cover size of the real photo inside the square frame (recomputed when src / frame width change).
  const [baseSize, setBaseSize] = useState<{w: number; h: number} | null>(null);
  // After Add: a confirmation overlay (design "Added" screen) with a preview + "Add another".
  const [added, setAdded] = useState<{uri: string; label: string} | null>(null);

  const transformRef = useRef(transform);
  transformRef.current = transform;
  const srcRef = useRef(src);
  srcRef.current = src;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const panBase = useRef({x: 0, y: 0});
  const frameWidthRef = useRef(320); // on-screen frame px (measured)
  // Debounce timer for the pixelate render on control changes.
  const fullTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Animated transform for the FRAME photo — driven imperatively by gestures (no React re-render).
  const animTX = useRef(new Animated.Value(0)).current;
  const animTY = useRef(new Animated.Value(0)).current;
  const animScale = useRef(new Animated.Value(1)).current;
  // Guard for async handlers (pickFrom, etc) to prevent state updates after unmount when awaiting
  // native UI (unbounded duration).
  const isMountedRef = useRef(true);

  // Offered sizes/colours are clamped by the organizer's caps.
  const offeredRes = useMemo(() => RES.filter(r => r <= rules.maxRes), [rules.maxRes]);
  const offeredColours = useMemo(() => COLOURS.filter(c => c <= rules.maxColours), [rules.maxColours]);

  // Track mount state for unmount guard on async handlers.
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Reset when the sheet is dismissed.
  useEffect(() => {
    if (!visible) {
      setSrc(null);
      setPhotoUri(null);
      setStage('frame');
      setBusy(false);
      setError(null);
      setTransform(IDENTITY_TRANSFORM);
      setRes(Math.min(128, rules.maxRes));
      setColours(Math.min(32, rules.maxColours));
      setDither('ordered');
      setLabel('');
      setAdjustOpen(false);
      setPreviewUri(null);
      setDragging(false);
      setBaseSize(null);
      setAdded(null);
    }
  }, [visible, rules.maxRes, rules.maxColours]);

  // ── framed-picture weight + allowance gate (only meaningful in the pixelate stage) ──
  const framedWeight = pictureWeight(res, colours);
  const violations = evaluatePicture(framedWeight, spentBytes, rules);
  const over = violations.length > 0;
  const remaining = rules.allowanceBytes > 0 ? Math.max(0, rules.allowanceBytes - spentBytes) : Infinity;
  // Panning does something only when the viewport is smaller than the photo: zoomed in, or a
  // non-square photo (which overflows the square viewport on its long axis at base zoom).
  const canPan = !!src && (transform.zoom > 1 || (src.width !== src.height));

  // Keep the cover size in sync with the current photo + measured frame width.
  const recomputeBase = (): void => {
    const s = srcRef.current;
    const F = frameWidthRef.current;
    if (!s || F <= 0) return;
    const coverS = F / Math.min(s.width, s.height);
    setBaseSize({w: s.width * coverS, h: s.height * coverS});
  };

  // Push the current framing transform onto the Animated values (used on mount / zoom / rotate /
  // re-crop / new photo; gestures update them directly for smoothness).
  const syncAnim = (t: Transform): void => {
    const s = srcRef.current;
    const F = frameWidthRef.current;
    if (!s || F <= 0) return;
    const g = frameGeom(t, s, F);
    animTX.setValue(g.tx);
    animTY.setValue(g.ty);
    animScale.setValue(t.zoom);
  };

  // New photo → recompute cover + reset the animated framing.
  useEffect(() => {
    if (!src) return;
    recomputeBase();
    syncAnim(transformRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Programmatic framing changes (zoom / rotate / re-crop) re-sync the animated values.
  useEffect(() => {
    if (src && stage === 'frame') syncAnim(transform);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform, stage]);

  // ── pixelate render (settled, single pass — pan/zoom is frozen in this stage) ──
  const renderPixelate = (): void => {
    const source = srcRef.current;
    if (!source) return;
    // Cap the preview res for encode cost; supersample 0 = AUTO area-average (crisp downsample).
    const previewRes = Math.min(res, 160);
    const result = pixelate(source.rgba, source.width, source.height, transformRef.current, previewRes, colours, dither, 0);
    setPreviewUri(indexedPngDataUri(result.indices, result.palette, result.res, Math.max(1, Math.round(340 / previewRes))));
  };

  // Re-pixelate (debounced) whenever a pixel control changes while in the pixelate stage, or on entry.
  useEffect(() => {
    if (stage !== 'pixelate' || !src) return;
    if (fullTimer.current) clearTimeout(fullTimer.current);
    fullTimer.current = setTimeout(renderPixelate, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, colours, dither, stage, src]);

  useEffect(() => () => { if (fullTimer.current) clearTimeout(fullTimer.current); }, []);

  // ── FRAME pan gesture — updates the engine transform + animated values, NO pixelation ──
  // gestureState.dx is cumulative from the grant, so we pan from the grant-time base. Gearing is a
  // true 1:1 map of finger px → photo px on screen (per-axis, since a non-square photo scales
  // differently on each axis), so the real photo tracks the finger exactly. Capture guards stop the
  // parent ScrollView from stealing the drag.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => stageRef.current === 'frame',
      onStartShouldSetPanResponderCapture: () => stageRef.current === 'frame',
      onMoveShouldSetPanResponder: () => stageRef.current === 'frame',
      onMoveShouldSetPanResponderCapture: () => stageRef.current === 'frame',
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        panBase.current = {x: transformRef.current.panX, y: transformRef.current.panY};
        setDragging(true);
      },
      onPanResponderMove: (_e, g) => {
        const s = srcRef.current;
        const F = frameWidthRef.current;
        if (!s || F <= 0) return;
        const coverS = F / Math.min(s.width, s.height);
        const z = transformRef.current.zoom;
        const gearX = s.width * coverS * z;
        const gearY = s.height * coverS * z;
        // Sign is negative so the image follows the finger (drag right → reveal the left).
        const nt = clampPan(
          {...transformRef.current, panX: panBase.current.x - g.dx / gearX, panY: panBase.current.y - g.dy / gearY},
          s,
        );
        transformRef.current = nt;
        const geo = frameGeom(nt, s, F);
        animTX.setValue(geo.tx);
        animTY.setValue(geo.ty);
      },
      onPanResponderRelease: () => {
        setDragging(false);
        setTransform(transformRef.current); // persist after the gesture (one re-render)
      },
      onPanResponderTerminate: () => {
        setDragging(false);
        setTransform(transformRef.current);
      },
    }),
  ).current;

  const pickFrom = async (camera: boolean): Promise<void> => {
    setError(null);
    try {
      const resp = camera
        ? await launchCamera({mediaType: 'photo', includeBase64: true, quality: 0.9})
        : await launchImageLibrary({mediaType: 'photo', includeBase64: true, quality: 0.9, selectionLimit: 1});

      // Guard after first await: native UI duration is unbounded
      if (!isMountedRef.current) return;

      if (resp.didCancel) return;
      const asset = resp.assets?.[0];
      if (!asset?.base64) {
        setError(resp.errorMessage ?? 'Could not read that photo.');
        return;
      }
      setBusy(true);
      const svc = getMediaService();
      if (!svc) throw new Error('image module unavailable');
      const square = await svc.getPixels(asset.base64, WORK);

      // Guard after second await: image processing duration is significant
      if (!isMountedRef.current) return;

      setTransform(IDENTITY_TRANSFORM);
      transformRef.current = IDENTITY_TRANSFORM;
      setStage('frame');
      setPreviewUri(null);
      // Prefer the native uri (light); fall back to a data URI so the real photo can be displayed.
      setPhotoUri(asset.uri ?? `data:${asset.type ?? 'image/jpeg'};base64,${asset.base64}`);
      setSrc(square);
    } catch (e) {
      if (!isMountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Could not process that photo.');
    } finally {
      if (!isMountedRef.current) return;
      setBusy(false);
    }
  };

  /** Freeze the frame and enter the pixelate level. */
  const goPixelate = (): void => {
    if (!src) return;
    setStage('pixelate');
    renderPixelate(); // paint immediately (the debounce effect handles later control changes)
  };

  /** Drop back to crop/zoom — the pixel-art is discarded until they pixelate again. */
  const backToCrop = (): void => {
    if (fullTimer.current) clearTimeout(fullTimer.current);
    setPreviewUri(null);
    setStage('frame');
  };

  const add = (): void => {
    if (!src || over) return;
    // Render at full resolution for the final token (the preview was capped for responsiveness).
    // supersample 0 = AUTO area-average — the highest-quality path, run once on Add.
    const result = pixelate(src.rgba, src.width, src.height, transformRef.current, res, colours, dither, 0);
    const token = encodeInlinePicture(result, dither, label);
    // Token length ≈ weight(); report the exact encoded length so the allowance stays accurate.
    const b64 = /;([A-Za-z0-9+/=]+)\]\]$/.exec(token);
    onAdd(token, b64 ? b64[1]!.length : framedWeight);
    // Show the "Added" confirmation (the token is already in the body); parent keeps the modal open.
    setAdded({uri: indexedPngDataUri(result.indices, result.palette, result.res, Math.max(1, Math.min(8, Math.round(300 / result.res)))), label: label.trim() || 'Picture'});
  };

  /** Reset back to Choose for "Add another". */
  const addAnother = (): void => {
    setAdded(null);
    setSrc(null);
    setPhotoUri(null);
    setStage('frame');
    setTransform(IDENTITY_TRANSFORM);
    setLabel('');
    setPreviewUri(null);
    setAdjustOpen(false);
    setBaseSize(null);
  };

  const rotate = (): void => {
    const next = clampPan({...transformRef.current, rot: (transformRef.current.rot + 1) % 4}, srcRef.current);
    transformRef.current = next;
    setTransform(next);
  };
  const setZoom = (z: number): void => {
    // Re-clamp pan for the new zoom (zooming out shrinks the pannable range).
    const next = clampPan({...transformRef.current, zoom: Math.max(1, Math.min(3, z))}, srcRef.current);
    transformRef.current = next;
    setTransform(next);
  };

  const picked = !!src;

  // BACK peels one level of this composer, mirroring the on-screen controls: from Pixelate it drops
  // to Crop & zoom (the same `backToCrop` the ‹ control uses), and from Crop & zoom it leaves — but
  // only after asking, because a picked-and-framed image is real work. With nothing picked yet
  // there is nothing to lose, so it just closes. See ui/back.tsx (contract rules 1, 2 and 5).
  const dismiss = useBackDismiss(picked, onClose, {
    title: 'Discard this picture?',
    message: 'Your crop and pixelate settings will not be kept.',
  });
  const handleBack = (): boolean => {
    if (added) return false; // the "Added ✓" recap owns the modal — Done/Add another are the exits
    if (picked && stage === 'pixelate') { backToCrop(); return true; }
    dismiss();
    return true;
  };

  return (
    <BackModal visible={visible} animationType="slide" onClose={onClose} onBack={handleBack}>
      <SafeAreaView style={s.page}>
        <View style={s.header}>
          <Press onPress={dismiss}>
            <Text style={s.cancel}>Cancel</Text>
          </Press>
          <Text style={s.headerTitle}>{!picked ? 'Add picture' : stage === 'frame' ? 'Crop & zoom' : 'Pixelate'}</Text>
          {picked ? (
            stage === 'frame' ? (
              <Press style={s.addPill} onPress={goPixelate}>
                <Text style={s.addPillText}>Pixelate</Text>
              </Press>
            ) : (
              <Press style={[s.addPill, over && s.addPillDisabled]} onPress={add} disabled={over}>
                <Text style={s.addPillText}>Add</Text>
              </Press>
            )
          ) : (
            <View style={s.headerSpacer} />
          )}
        </View>

        {error && <Text style={s.error}>{error}</Text>}

        {!picked ? (
          // ── Choose ──
          <ScrollView contentContainerStyle={s.chooseBody}>
            <Text style={s.chooseTitle}>Add a picture</Text>
            <Text style={s.chooseSub}>
              Your photo never leaves this device. Stiq attaches a tiny, private version that only loads when someone taps it.
            </Text>
            <View style={s.srcRow}>
              <Press style={s.srcBtn} onPress={() => void pickFrom(true)} disabled={busy}>
                <Text style={s.srcGlyph}>📷</Text>
                <Text style={s.srcLabel}>Camera</Text>
              </Press>
              <Press style={s.srcBtn} onPress={() => void pickFrom(false)} disabled={busy}>
                <Text style={s.srcGlyph}>🖼️</Text>
                <Text style={s.srcLabel}>Library</Text>
              </Press>
            </View>
            {busy && <ActivityIndicator style={{marginTop: space.xl}} color={colors.accent} />}
            {!rules.allow && <Text style={s.error}>Pictures are turned off in this community.</Text>}
          </ScrollView>
        ) : (
          // ── Frame / Pixelate ──
          <>
            <ScrollView contentContainerStyle={s.editBody} keyboardShouldPersistTaps="handled" scrollEnabled={!dragging}>
              <View
                style={s.frame}
                onLayout={e => { frameWidthRef.current = e.nativeEvent.layout.width; recomputeBase(); syncAnim(transformRef.current); }}
                {...(stage === 'frame' ? pan.panHandlers : {})}>
                {stage === 'frame' ? (
                  photoUri && baseSize ? (
                    <Animated.Image
                      source={{uri: photoUri}}
                      style={{
                        width: baseSize.w,
                        height: baseSize.h,
                        transform: [
                          {translateX: animTX},
                          {translateY: animTY},
                          {scale: animScale},
                          {rotate: `${-transform.rot * 90}deg`},
                        ],
                      }}
                    />
                  ) : (
                    <ActivityIndicator color="#fff" />
                  )
                ) : previewUri ? (
                  <Image source={{uri: previewUri}} style={s.frameImg} resizeMode="cover" />
                ) : (
                  <ActivityIndicator color="#fff" />
                )}
                {/* Rule-of-thirds grid, visible while dragging when there's room to pan (design .grid3). */}
                {stage === 'frame' && dragging && canPan && (
                  <View style={s.grid3} pointerEvents="none">
                    <View style={[s.gridV, {left: '33.33%'}]} />
                    <View style={[s.gridV, {left: '66.66%'}]} />
                    <View style={[s.gridH, {top: '33.33%'}]} />
                    <View style={[s.gridH, {top: '66.66%'}]} />
                  </View>
                )}
                {stage === 'frame' && canPan && (
                  <View style={s.frameHint} pointerEvents="none">
                    <Text style={s.frameHintText}>drag to reposition</Text>
                  </View>
                )}
                {stage === 'pixelate' && (
                  <View style={s.frameHint} pointerEvents="none">
                    <Text style={s.frameHintText}>{res}² · {colours} colours</Text>
                  </View>
                )}
              </View>

              {stage === 'frame' ? (
                // ── Level 1: crop & zoom (smooth, no pixelation) ──
                <>
                  <View style={s.tools}>
                    <Press onPress={() => setZoom(transform.zoom - 0.25)}>
                      <Text style={s.toolGlyph}>⊖</Text>
                    </Press>
                    <ZoomSlider value={transform.zoom} onChange={setZoom} />
                    <Press onPress={() => setZoom(transform.zoom + 0.25)}>
                      <Text style={s.toolGlyph}>⊕</Text>
                    </Press>
                    <Press style={s.rotateBtn} onPress={rotate}>
                      <Text style={s.rotateGlyph}>↻</Text>
                    </Press>
                  </View>

                  <Text style={s.stageNote}>
                    Position and zoom your photo — this stays smooth. When it's framed, tap Pixelate to
                    turn it into a tiny pixel-art picture.
                  </Text>

                  <Press style={s.changeBtn} onPress={() => void pickFrom(false)}>
                    <Text style={s.changeText}>Change picture</Text>
                  </Press>
                </>
              ) : (
                // ── Level 2: pixelate (params; framing is frozen) ──
                <>
                  <Press style={s.recropBtn} onPress={backToCrop}>
                    <Text style={s.recropText}>‹ Re-crop</Text>
                  </Press>

                  {/* Label */}
                  <View style={s.labelBlock}>
                    <Text style={s.blockLabel}>
                      LABEL <Text style={s.blockHint}>optional · shown on the chip before it loads</Text>
                    </Text>
                    <TextInput
                      style={s.labelInput}
                      value={label}
                      onChangeText={setLabel}
                      maxLength={48}
                      placeholder="e.g. Dusk from the roof"
                      placeholderTextColor={colors.textMuted}
                      autoCorrect={false}
                    />
                  </View>

                  {/* Progressive disclosure: Size & quality */}
                  <Press style={s.adjustHead} onPress={() => setAdjustOpen(o => !o)}>
                    <View>
                      <Text style={s.adjustTitle}>Size &amp; quality</Text>
                      <Text style={s.adjustSum}>{sizeLabel(res)} · ≈{fmtKB(framedWeight)}</Text>
                    </View>
                    <Text style={s.chev}>{adjustOpen ? '⌃' : '⌄'}</Text>
                  </Press>
                  {adjustOpen && (
                    <View style={s.adjustBody}>
                      <Text style={s.adjustNote}>
                        Stiq pictures are deliberately light so they stay private and cheap. Smaller pictures let you post more per period.
                      </Text>
                      <Field label="Resolution" value={`${res}²`}>
                        <Segmented options={offeredRes.map(r => ({key: r, label: String(r)}))} value={res} onChange={setRes} />
                      </Field>
                      <Field label="Colours" value={String(colours)}>
                        <Segmented options={offeredColours.map(c => ({key: c, label: String(c)}))} value={colours} onChange={setColours} />
                      </Field>
                      <AllowanceMeter weight={framedWeight} spent={spentBytes} allowance={rules.allowanceBytes} over={over} remaining={remaining} />
                    </View>
                  )}

                  {/* Dither — always visible in the pixelate stage */}
                  <Field label="Dither" value={DITHER_NAME[dither]}>
                    <Segmented
                      options={DITHER_LABELS.map(([k, l]) => ({key: k, label: l}))}
                      value={dither}
                      onChange={setDither}
                    />
                    <Text style={s.ditherNote}>How the limited palette is blended — changes the look, not the byte size.</Text>
                  </Field>

                  {over && <Text style={s.reason}>{pictureViolationMessage(violations[0]!, rules)}</Text>}
                </>
              )}
            </ScrollView>

            <View style={s.postbar}>
              {stage === 'frame' ? (
                <Press style={s.addBtn} onPress={goPixelate}>
                  <Text style={s.addBtnText}>Pixelate →</Text>
                </Press>
              ) : (
                <Press style={[s.addBtn, over && s.addBtnDisabled]} onPress={add} disabled={over}>
                  <Text style={s.addBtnText}>Add picture</Text>
                </Press>
              )}
            </View>
          </>
        )}

        {/* "Added" confirmation overlay (design .done) — the token is already in your message. */}
        {added && (
          <View style={s.done}>
            <View style={s.doneArt}>
              <Image source={{uri: added.uri}} style={s.doneArtImg} resizeMode="cover" />
              <View style={s.doneChk}>
                <Text style={s.doneChkIcon}>✓</Text>
              </View>
            </View>
            <Text style={s.doneTitle}>Added</Text>
            <View style={s.doneChip}>
              <View style={s.doneChipIc}>
                <Icon name="🖼️" size={17} />
              </View>
              <Text style={s.doneChipLbl} numberOfLines={1}>
                {added.label}
                <Text style={s.doneChipDim}> · tap to load</Text>
              </Text>
              <View style={s.doneChipGo}>
                <Text style={s.doneChipGoIcon}>↓</Text>
              </View>
            </View>
            <Text style={s.doneCopy}>It's added to what you're writing — a quiet chip that stays hidden until someone taps to load it.</Text>
            <View style={s.doneActions}>
              <Press style={s.doneAgain} onPress={addAnother}>
                <Text style={s.doneAgainText}>Add another</Text>
              </Press>
              <Press style={s.doneDone} onPress={onClose}>
                <Text style={s.doneDoneText}>Done</Text>
              </Press>
            </View>
          </View>
        )}
      </SafeAreaView>
    </BackModal>
  );
}

// ── little building blocks ──────────────────────────────────────────────────────────────────────
function Field({label, value, children}: {label: string; value: string; children: React.ReactNode}): React.JSX.Element {
  return (
    <View style={s.field}>
      <View style={s.fieldLab}>
        <Text style={s.fieldH}>{label}</Text>
        <Text style={s.fieldV}>{value}</Text>
      </View>
      {children}
    </View>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: {key: T; label: string}[];
  value: T;
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <View style={s.seg}>
      {options.map(o => {
        const on = o.key === value;
        return (
          <Press key={String(o.key)} style={[s.segBtn, on && s.segBtnOn]} onPress={() => onChange(o.key)}>
            <Text style={[s.segText, on && s.segTextOn]}>{o.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

/**
 * A minimal zoom slider (1..3) — no slider dependency in the tree, so it's hand-rolled. The
 * PanResponder is created ONCE (recreating it per render drops the in-flight gesture); it reads live
 * width / callback via refs and computes the touch x from gestureState (robust regardless of which
 * child the finger lands on) with the parent ScrollView blocked from stealing the horizontal drag.
 */
function ZoomSlider({value, onChange}: {value: number; onChange: (v: number) => void}): React.JSX.Element {
  const widthRef = useRef(1);
  const leftRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const setFromX = (x: number): void => {
    const w = widthRef.current || 1;
    onChangeRef.current(1 + (Math.max(0, Math.min(w, x)) / w) * 2);
  };
  const setFromXRef = useRef(setFromX);
  setFromXRef.current = setFromX;
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e, g) => {
        // page-left of the track = touch page-x minus its offset within the track.
        leftRef.current = g.x0 - e.nativeEvent.locationX;
        setFromXRef.current(e.nativeEvent.locationX);
      },
      onPanResponderMove: (_e, g) => setFromXRef.current(g.moveX - leftRef.current),
    }),
  ).current;
  const pct = ((value - 1) / 2) * 100;
  return (
    <View style={s.slider} onLayout={e => { widthRef.current = e.nativeEvent.layout.width; }} {...responder.panHandlers}>
      <View style={s.sliderTrack} pointerEvents="none" />
      <View style={[s.sliderFill, {width: `${pct}%`}]} pointerEvents="none" />
      <View style={[s.sliderThumb, {left: `${pct}%`}]} pointerEvents="none" />
    </View>
  );
}

/** The conic weight ring (design .weigh .ring): spent · this picture · remaining, as a donut. */
function Ring({pctSpent, pctW, over}: {pctSpent: number; pctW: number; over: boolean}): React.JSX.Element {
  const size = 24;
  const sw = 5; // 5px stroke → 14px inner hole (design inset:5px)
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const a = (pctSpent / 100) * c;
  const b = (pctW / 100) * c;
  const pend = over ? colors.danger : colors.accentTint;
  const rot = `rotate(-90 ${size / 2} ${size / 2})`;
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.borderLight} strokeWidth={sw} fill="none" />
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.accent} strokeWidth={sw} fill="none" strokeDasharray={`${a} ${c}`} transform={rot} />
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={pend} strokeWidth={sw} fill="none" strokeDasharray={`${b} ${c}`} strokeDashoffset={-a} transform={rot} />
    </Svg>
  );
}

function AllowanceMeter({
  weight,
  spent,
  allowance,
  over,
  remaining,
}: {
  weight: number;
  spent: number;
  allowance: number;
  over: boolean;
  remaining: number;
}): React.JSX.Element {
  if (allowance <= 0) {
    return (
      <View style={s.weigh}>
        <Text style={s.weighW}>≈{fmtKB(weight)}</Text>
        <Text style={s.weighSep}>·</Text>
        <Text style={s.weighLeft}>no period limit</Text>
      </View>
    );
  }
  const pctSpent = Math.min(100, (spent / allowance) * 100);
  const pctW = Math.min(100 - pctSpent, (weight / allowance) * 100);
  return (
    <View style={s.weigh}>
      <Ring pctSpent={pctSpent} pctW={pctW} over={over} />
      <Text style={[s.weighW, over && s.weighOver]}>≈{fmtKB(weight)}</Text>
      <Text style={s.weighSep}>·</Text>
      <Text style={[s.weighLeft, over && s.weighOver]}>{over ? 'over allowance' : `${fmtKB(remaining)} left this period`}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  page: {flex: 1, backgroundColor: colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerSpacer: {width: 64},
  cancel: {color: colors.textSecondary, fontSize: 16},
  headerTitle: {color: colors.textPrimary, fontSize: 16, fontWeight: fweight.semibold},
  addPill: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 7},
  addPillDisabled: {backgroundColor: colors.surfaceHover},
  addPillText: {color: colors.onAccent, fontWeight: fweight.semibold, fontSize: 14},
  error: {color: colors.danger, fontSize: 13, paddingHorizontal: 20, paddingTop: 10},

  // Choose
  chooseBody: {padding: 20},
  chooseTitle: {color: colors.textPrimary, fontSize: 22, fontWeight: fweight.bold, letterSpacing: -0.2},
  chooseSub: {color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 8},
  srcRow: {flexDirection: 'row', gap: 9, marginTop: 20},
  srcBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 11,
  },
  srcGlyph: {fontSize: 15},
  srcLabel: {color: colors.textPrimary, fontSize: 13, fontWeight: fweight.semibold},

  // Edit
  editBody: {padding: 16, paddingBottom: 24, gap: 14},
  frame: {aspectRatio: 1, borderRadius: 16, backgroundColor: '#000', overflow: 'hidden', alignItems: 'center', justifyContent: 'center'},
  frameImg: {width: '100%', height: '100%'},
  frameHint: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 4,
  },
  frameHintText: {color: 'rgba(255,255,255,0.9)', fontSize: 10.5},
  tools: {flexDirection: 'row', alignItems: 'center', gap: 12},
  toolGlyph: {color: colors.textSecondary, fontSize: 20},
  rotateBtn: {width: 42, height: 36, borderRadius: 9, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center'},
  rotateGlyph: {color: colors.textPrimary, fontSize: 18},

  stageNote: {color: colors.textMuted, fontSize: 12.5, lineHeight: 18},
  recropBtn: {alignSelf: 'flex-start'},
  recropText: {color: colors.accent, fontSize: 14, fontWeight: fweight.semibold},

  slider: {flex: 1, height: 32, justifyContent: 'center'},
  sliderTrack: {height: 4, borderRadius: 2, backgroundColor: colors.border},
  sliderFill: {position: 'absolute', height: 4, borderRadius: 2, backgroundColor: colors.accent},
  sliderThumb: {position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: colors.accent, marginLeft: -9},

  labelBlock: {gap: 6},
  blockLabel: {color: colors.textSecondary, fontSize: 10, fontWeight: fweight.bold, letterSpacing: 0.6},
  blockHint: {color: colors.textMuted, fontWeight: fweight.regular, letterSpacing: 0},
  labelInput: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 14,
  },
  changeBtn: {alignSelf: 'flex-start'},
  changeText: {color: colors.accent, fontSize: 13, fontWeight: fweight.semibold},

  adjustHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  adjustTitle: {color: colors.textPrimary, fontSize: 15, fontWeight: fweight.semibold},
  adjustSum: {color: colors.textMuted, fontSize: 12, marginTop: 2},
  chev: {color: colors.textSecondary, fontSize: 16},
  adjustBody: {gap: 14, paddingTop: 4},
  adjustNote: {color: colors.textMuted, fontSize: 12, lineHeight: 17},

  field: {gap: 8},
  fieldLab: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  fieldH: {color: colors.textSecondary, fontSize: 13, fontWeight: fweight.semibold},
  fieldV: {color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums']},
  seg: {flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: 9, padding: 3, gap: 3},
  segBtn: {flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 7},
  segBtnOn: {backgroundColor: colors.accent},
  segText: {color: colors.textSecondary, fontSize: 13, fontWeight: fweight.medium},
  segTextOn: {color: colors.onAccent},
  ditherNote: {color: colors.textMuted, fontSize: 11.5, lineHeight: 16},

  // Weight ring row (design .weigh).
  weigh: {flexDirection: 'row', alignItems: 'center', gap: 10},
  weighW: {color: colors.textPrimary, fontSize: 12.5, fontWeight: fweight.semibold, fontVariant: ['tabular-nums']},
  weighSep: {color: colors.textMuted, fontSize: 12.5},
  weighLeft: {color: colors.textMuted, fontSize: 12.5, fontVariant: ['tabular-nums']},
  weighOver: {color: colors.danger},

  reason: {color: colors.danger, fontSize: 12.5, lineHeight: 17},

  postbar: {padding: 16, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceAlt},
  addBtn: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 14, alignItems: 'center'},
  addBtnDisabled: {backgroundColor: colors.surfaceHover},
  addBtnText: {color: colors.onAccent, fontSize: 15, fontWeight: fweight.semibold},

  // Rule-of-thirds grid (design .grid3).
  grid3: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  gridV: {position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.28)'},
  gridH: {position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.28)'},

  // "Added" overlay (design .done).
  done: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24},
  doneArt: {width: 150, height: 150, borderRadius: 18, overflow: 'hidden', marginBottom: 22},
  doneArtImg: {width: '100%', height: '100%'},
  doneChk: {
    position: 'absolute',
    right: -6,
    bottom: 16,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.success,
    borderWidth: 3,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneChkIcon: {color: '#fff', fontSize: 18, fontWeight: fweight.bold},
  doneTitle: {fontSize: 22, fontWeight: fweight.bold, color: colors.textPrimary, letterSpacing: -0.2, marginBottom: 7},
  // Mirrors the feed PictureChip idle style so the "Added" preview looks exactly like what publishes.
  doneChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    maxWidth: 290,
    marginBottom: 16,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  doneChipIc: {width: 30, height: 30, borderRadius: 8, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center'},
  doneChipLbl: {flex: 1, fontSize: 13.5, fontWeight: fweight.semibold, color: colors.textPrimary},
  doneChipDim: {color: colors.textMuted, fontWeight: fweight.medium},
  doneChipGo: {width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceHover, alignItems: 'center', justifyContent: 'center'},
  doneChipGoIcon: {color: colors.textSecondary, fontSize: 13, fontWeight: fweight.bold},
  doneCopy: {color: colors.textSecondary, fontSize: 13.5, lineHeight: 20, maxWidth: 260, textAlign: 'center', marginBottom: 22},
  doneActions: {flexDirection: 'row', gap: 10},
  doneAgain: {backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22},
  doneAgainText: {color: colors.textPrimary, fontSize: 14, fontWeight: fweight.semibold},
  doneDone: {backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 28},
  doneDoneText: {color: colors.onAccent, fontSize: 14, fontWeight: fweight.semibold},
});

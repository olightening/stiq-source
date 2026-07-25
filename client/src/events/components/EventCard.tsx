/**
 * EventCard — the embeddable Stiq event card (DS component, fixed API — COMPONENTS.md §1).
 *
 * Two densities: 'Feed' (full card — optional 152px cover, 52px date tile, when/location lines,
 * host row, footer) and 'Compact' (single-row channel/DM/comment inline — 44px tile, one metadata
 * line, trailing ›). Aggregate-only: never renders a guest list. Pixel source of truth is the
 * design handoff's `EventCard.dc.html`; REDLINES.md §1 and COMPONENTS.md §1 pin the exact
 * measurements and the footer/pill selection logic ported verbatim below.
 *
 * Privacy (DATA-MODEL §"cover"): a cover `image` carries the app's inline picture token
 * (`[[pic:…]]`) and is NEVER fetched or decoded until the viewer taps "Load image". The mechanism
 * is the SAME shared load-on-tap state machine PictureChip uses for pictures in a post body
 * (`useMediaBlob` + `decodePicturePayload` + `indexedPngDataUri` — see feed/components/PictureChip
 * .tsx), reused here rather than forked so a cover image can never fetch behind the viewer's back.
 * The presentation differs from PictureChip on purpose: PictureChip expands a chip into a square;
 * a cover is already a fixed 152px band with its own hidden/shown button per the DC, so that part
 * is built to spec here instead of embedding PictureChip's chip-expansion UI inside it.
 */
import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';
import Svg, {Defs, LinearGradient, Rect, Stop} from 'react-native-svg';
import {Press} from '../../ui/Press';
import {colors, radius, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {GradientDot} from '../../ui/GradientDot';
import {GradientRect} from '../../ui/GradientRect';
import {decodeGradient, type GradientSpec} from '../../media/gradient';
import {useMediaBlob} from '../../media/useMediaBlob';
import {indexedPngDataUri} from '../../media/png';
import {extractInlinePictures, decodePicturePayload} from '../../feed/picture';
import type {MediaSource} from '../../feed/mediaBlob';
import type {EventCardProps, EventStatus, EventType, RsvpState} from '../types';

const COVER_HEIGHT = 152;

const TYPE_META: Record<EventType, {glyph: string; label: string}> = {
  online: {glyph: '📡', label: 'Online'},
  inperson: {glyph: '📍', label: 'In person'},
  hybrid: {glyph: '🔀', label: 'Hybrid'},
  ama: {glyph: '💬', label: 'Channel AMA'},
};

const LOC_GLYPH: Record<EventType, string> = {
  online: '📡',
  inperson: '📍',
  hybrid: '🔀',
  ama: '🎙️',
};

/** DC default cover — `linear-gradient(135deg,#7cb2ff,#b89aff)` (EventCard.dc.html renderVals). */
const DEFAULT_COVER_GRADIENT: GradientSpec = {type: 'linear', angle: 135, stops: ['#7cb2ff', '#b89aff']};

/** `hostGrad`/`coverGradient` are `GradientSpec | string` — a string is the encodeGradient wire form. */
function resolveGradient(g: GradientSpec | string | undefined): GradientSpec | undefined {
  if (!g) return undefined;
  return typeof g === 'string' ? decodeGradient(g) : g;
}

interface PillStyle {
  text: string;
  color: string;
  bg: string;
  border: string;
}

/** RSVP pill map — COMPONENTS.md §1 "RSVP pill map" / DC `pill()`, verbatim. */
function rsvpPillStyle(rsvp: RsvpState, status: EventStatus): PillStyle {
  if (rsvp === 'interested') return {text: '★ Interested', color: colors.accent, bg: colors.accentSoft, border: 'transparent'};
  if (rsvp === 'applied') return {text: '⏳ Applied', color: colors.warning, bg: colors.warningBg, border: 'transparent'};
  if (rsvp === 'approved') return {text: '✓ You’re in', color: colors.success, bg: colors.successBg, border: 'transparent'};
  if (rsvp === 'waitlist') return {text: '⊕ Waitlisted', color: colors.textSecondary, bg: colors.surfaceAlt, border: colors.border};
  return status === 'full'
    ? {text: 'Join waitlist', color: colors.textSecondary, bg: colors.surfaceAlt, border: colors.border}
    : {text: 'Interested', color: colors.onAccent, bg: colors.accent, border: 'transparent'};
}

/** Integer upscale so a `res`-wide picture fills a cover-sized target crisply (mirrors PictureChip's `scaleFor`). */
function scaleForCover(res: number, target: number, max = 8): number {
  return Math.max(1, Math.min(max, Math.round(target / res)));
}

/** Rectangular gradient fill for the cover band. GradientAvatar/GradientDot are locked to a square
 * `size`, so a full-width×152 fill duplicates their linear/radial axis math against an SVG sized to
 * the cover instead — the same react-native-svg idiom, just not square. Delegates to the shared
 * `ui/GradientRect` (onLayout-measured pixel `<Svg>` — a `width="100%"` root Svg is flaky on Android
 * react-native-svg 15 and only partially fills the cover). */
function CoverGradientFill({spec}: {spec: GradientSpec}): React.JSX.Element {
  return (
    <GradientRect gradient={spec} style={StyleSheet.absoluteFill} fallbackStops={['#3a4150', '#222834']} />
  );
}

/** The vertical black wash behind the "Load image" button — DC's
 * `linear-gradient(180deg, rgba(0,0,0,.12), rgba(0,0,0,.48))`. Not a plain hex-stop GradientSpec (its
 * stops carry alpha, not colour), so it can't go through `GradientRect`'s API — but it keeps the same
 * onLayout-measured pixel `<Svg>` fix (a `%`-sized root Svg is flaky on Android react-native-svg 15). */
function LoadScrim(): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_]/g, '');
  const gid = `evscrim${uid}`;
  const [size, setSize] = useState({w: 0, h: 0});
  return (
    <View
      style={StyleSheet.absoluteFillObject}
      onLayout={e => setSize({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})}>
      {size.w > 0 && size.h > 0 && (
        <Svg width={size.w} height={size.h}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset={0} stopColor="#000000" stopOpacity={0.12} />
              <Stop offset={1} stopColor="#000000" stopOpacity={0.48} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={size.w} height={size.h} fill={`url(#${gid})`} />
        </Svg>
      )}
    </View>
  );
}

/** Calendar date tile, shared between Feed (52px) and Compact (44px) — DC `_eventDateTile`-equivalent.
 * `empty` renders the dashed TBD tile (month `'—'`/`'-'` or day `'·'`/`'-'`/`''`). Note the DC quirk
 * preserved here: the TBD tile never dims, even when the card itself is cancelled/past — only the
 * dateSet tile does. */
function DateTile({
  month,
  day,
  empty,
  size,
  dim,
}: {
  month: string;
  day: string;
  empty: boolean;
  size: 'feed' | 'compact';
  dim: boolean;
}): React.JSX.Element {
  const feed = size === 'feed';
  if (empty) {
    return (
      <View style={feed ? styles.dateTbdFeed : styles.dateTbdCompact}>
        <Text style={feed ? styles.dateTbdEmojiFeed : styles.dateTbdEmojiCompact} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          🗓️
        </Text>
        {feed && (
          <Text style={styles.dateTbdLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            TBD
          </Text>
        )}
      </View>
    );
  }
  return (
    <View style={[feed ? styles.dateTileFeed : styles.dateTileCompact, {opacity: dim ? 0.55 : 1}]}>
      <Text
        style={feed ? styles.dateMonthFeed : styles.dateMonthCompact}
        numberOfLines={1}
        maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {month}
      </Text>
      <Text style={feed ? styles.dateDayFeed : styles.dateDayCompact} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {day}
      </Text>
    </View>
  );
}

function RsvpPill({rsvp, status}: {rsvp: RsvpState; status: EventStatus}): React.JSX.Element {
  const p = rsvpPillStyle(rsvp, status);
  return (
    <View style={[styles.pill, {backgroundColor: p.bg, borderColor: p.border}]}>
      <Text style={[styles.pillText, {color: p.color}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {p.text}
      </Text>
    </View>
  );
}

export function EventCard(props: EventCardProps): React.JSX.Element {
  const {
    title: titleProp,
    variant,
    type,
    month,
    day,
    dateLabel,
    timeLabel,
    locationLabel,
    hostName,
    hostGrad,
    interestedCount,
    attendingCount,
    capacity,
    countOnly,
    tag,
    recurring,
    rsvp,
    status,
    external,
    coverMode,
    coverGradient,
    coverImage,
    onPress,
  } = props;

  const title = titleProp || 'Untitled event';
  const isCompact = variant === 'Compact';
  const isFeed = !isCompact;
  const cancelled = status === 'cancelled';
  const dim = cancelled || status === 'past';
  const dimOpacity = dim ? 0.55 : 1;

  const tm = TYPE_META[type] ?? TYPE_META.inperson;
  const locGlyph = LOC_GLYPH[type] ?? '📍';
  const tagText = tag ?? '';
  const recurringText = recurring ?? '';
  const locationText = locationLabel ?? '';

  // '—'/'-' month or '·'/'-'/'' day → the dashed TBD tile (EventCardProps month/day contract).
  const dateEmpty = month === '—' || month === '-' || day === '·' || day === '-' || day === '';

  // Cover-image load-on-tap. Hooks run unconditionally (Compact never reads the result) so the hook
  // order never depends on `variant`. An absent/malformed token falls back to a dead-end empty
  // source: tapping "Load image" then simply fails to decode rather than throwing.
  const picture = useMemo(() => (coverImage ? extractInlinePictures(coverImage)[0] : undefined), [coverImage]);
  const pictureSource: MediaSource = picture ? picture.source : {kind: 'inline', payloadBase64: ''};
  const {state: picState, value: decodedPic, load: loadPicture} = useMediaBlob(pictureSource, decodePicturePayload);
  const coverThumbUri = useMemo(
    () =>
      decodedPic
        ? indexedPngDataUri(decodedPic.indices, decodedPic.palette, decodedPic.res, scaleForCover(decodedPic.res, 640))
        : null,
    [decodedPic],
  );
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const hasCoverFeed = isFeed && coverMode !== 'none';
  const coverIsImage = coverMode === 'image';
  const imgShown = coverIsImage && !!picture && picState === 'loaded';
  const imgHidden = hasCoverFeed && coverIsImage && !imgShown;
  const showInlineType = isFeed && !hasCoverFeed;

  useEffect(() => {
    if (imgShown) {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {toValue: 1, duration: 400, useNativeDriver: true}).start();
    }
  }, [imgShown, fadeAnim]);

  const resolvedCoverGradient = resolveGradient(coverGradient) ?? DEFAULT_COVER_GRADIENT;
  const resolvedHostGrad = resolveGradient(hostGrad);

  // DC `bodyOpacity`: only dims when there IS a cover (an uncovered card's text is the only surface,
  // so it stays fully legible even cancelled/past) — separate from the date tile's own `dimOpacity`.
  const bodyOpacity = dim && hasCoverFeed ? 0.85 : 1;

  // Footer selection — COMPONENTS.md §1 "Footer selection logic" / REDLINES §1.4, ported verbatim.
  const footBeFirst =
    !external && !cancelled && status === 'upcoming' && interestedCount === 0 && (attendingCount === null || attendingCount === 0);
  const footGoingLead = !footBeFirst && countOnly && attendingCount !== null;
  const footInterestedLead = !footBeFirst && !footGoingLead;

  let spotsText = '';
  let spotsWarn = false;
  if (footInterestedLead && capacity !== null && attendingCount !== null) {
    if (status === 'full') {
      spotsText = 'Full · waitlist open';
      spotsWarn = true;
    } else {
      spotsText = `${attendingCount}/${capacity} spots`;
    }
  }

  const whenLine = `${dateLabel} · ${timeLabel}`;
  const hostLine = `${external ? 'Shared by ' : 'Hosted by '}${hostName}`;
  const compactSub = cancelled ? 'Cancelled' : `${tm.glyph} ${dateLabel} · ${timeLabel}`;

  if (isCompact) {
    return (
      <Press
        variant="row"
        onPress={onPress}
        disabled={!onPress}
        style={styles.compactCard}
        pressedStyle={styles.compactCardPressed}
        accessibilityLabel={title}>
        <DateTile month={month} day={day} empty={dateEmpty} size="compact" dim={dim} />
        <View style={[styles.compactBody, {opacity: dimOpacity}]}>
          <Text
            style={[styles.compactTitle, cancelled && styles.strike]}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {title}
          </Text>
          <Text style={styles.compactSub} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {compactSub}
          </Text>
        </View>
        {!cancelled && (
          <Text style={styles.chevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ›
          </Text>
        )}
      </Press>
    );
  }

  return (
    <Press
      variant="row"
      onPress={onPress}
      disabled={!onPress}
      style={styles.feedCard}
      pressedStyle={styles.feedCardPressed}
      accessibilityLabel={title}>
      {external && (
        <View style={styles.externalBanner}>
          <Text style={styles.externalBannerText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ↗ External event · shared, not organized on Stiq
          </Text>
        </View>
      )}

      {hasCoverFeed && (
        <View style={styles.cover}>
          <CoverGradientFill spec={resolvedCoverGradient} />
          {imgShown && coverThumbUri && (
            <Animated.Image
              source={{uri: coverThumbUri}}
              style={[styles.coverImg, {opacity: fadeAnim}]}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          )}
          {imgHidden && (
            <Press
              style={styles.loadOverlay}
              onPress={loadPicture}
              accessibilityLabel="Load cover image (image is hidden until you tap, for privacy)">
              <LoadScrim />
              <View style={styles.loadPill}>
                <Text style={styles.loadPillText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  📷 Load image
                </Text>
              </View>
              <Text style={styles.loadSub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Hidden until you tap · privacy-safe
              </Text>
            </Press>
          )}
          <View style={styles.coverChipsRow} pointerEvents="none">
            <View style={styles.coverChip}>
              <Text style={styles.coverChipText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {tm.glyph} {tm.label}
              </Text>
            </View>
            {!!recurringText && (
              <View style={styles.coverChip}>
                <Text style={styles.coverChipText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  🔁 {recurringText}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      <View style={[styles.body, {opacity: bodyOpacity}]}>
        <View style={styles.bodyRow}>
          <DateTile month={month} day={day} empty={dateEmpty} size="feed" dim={dim} />
          <View style={styles.titleBlock}>
            <View style={styles.titleRow}>
              <Text style={[styles.title, cancelled && styles.strike]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {title}
              </Text>
              {showInlineType && (
                <View style={styles.inlineTypeChip}>
                  <Text style={styles.inlineTypeChipText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    {tm.glyph} {tm.label}
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                🕒
              </Text>
              <Text style={styles.metaLabel} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {whenLine}
              </Text>
            </View>
            {!!locationText && (
              <View style={[styles.metaRow, styles.locRow]}>
                <Text style={styles.metaGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {locGlyph}
                </Text>
                <Text style={styles.metaLabel} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {locationText}
                </Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.hostRow}>
          <GradientDot size={22} gradient={resolvedHostGrad} seed={hostName} />
          <Text style={styles.hostText} numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {hostLine}
          </Text>
          {!!tagText && (
            <Text style={styles.tagText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              #{tagText}
            </Text>
          )}
        </View>

        <View style={styles.footerRow}>
          {footBeFirst && (
            <Text style={styles.footBeFirst} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              ✨ Be the first to RSVP
            </Text>
          )}
          {footGoingLead && (
            <>
              <Text style={styles.footGoingMain} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                👥 {attendingCount} going
              </Text>
              <Text style={styles.footGoingSub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                · ★ {interestedCount} interested
              </Text>
            </>
          )}
          {footInterestedLead && (
            <>
              <Text style={styles.footInterestedMain} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                ★ {interestedCount} interested
              </Text>
              {!!spotsText && (
                <Text
                  style={[styles.footSpots, {color: spotsWarn ? colors.warning : colors.textMuted}]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  · {spotsText}
                </Text>
              )}
            </>
          )}
          <View style={styles.footerSpacer} />
          {cancelled ? (
            <Text style={styles.cancelledText} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Cancelled
            </Text>
          ) : (
            <RsvpPill rsvp={rsvp} status={status} />
          )}
        </View>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  // ── Feed ──────────────────────────────────────────────────────────────────
  feedCard: {
    flexDirection: 'column',
    width: '100%',
    // Same reasoning as compactCard: the Feed density also renders INSIDE post bodies (RichText
    // eventDensity='Feed'), where the host card is `surface`. One fill for both densities keeps the
    // event card a single recognisable object whether it is embedded or standing alone on `bg`.
    backgroundColor: colors.embed,
    borderWidth: 1,
    borderColor: colors.embedBorder,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.36,
    shadowRadius: 26,
    shadowOffset: {width: 0, height: 8},
    elevation: 8,
  },
  feedCardPressed: {backgroundColor: colors.embedHover},

  externalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 9,
    paddingHorizontal: 16,
    backgroundColor: colors.accentSoft,
  },
  externalBannerText: {fontSize: 11.5, fontWeight: weight.semibold, color: colors.accent},

  cover: {height: COVER_HEIGHT, overflow: 'hidden', backgroundColor: colors.surfaceAlt},
  coverImg: {...StyleSheet.absoluteFillObject},
  loadOverlay: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 7},
  loadPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: radius.pill,
  },
  loadPillText: {fontSize: 13, fontWeight: weight.semibold, color: '#ffffff'},
  loadSub: {fontSize: 11, fontWeight: weight.regular, color: 'rgba(255,255,255,0.82)'},

  coverChipsRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 11,
  },
  coverChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  coverChipText: {fontSize: 11, fontWeight: weight.semibold, color: '#ffffff'},

  body: {paddingTop: 15, paddingHorizontal: 17, paddingBottom: 16},
  bodyRow: {flexDirection: 'row', gap: 13, alignItems: 'flex-start'},

  dateTileFeed: {width: 52, borderRadius: 13, backgroundColor: colors.surfaceAlt, overflow: 'hidden', flexShrink: 0},
  dateMonthFeed: {
    fontSize: 10.5,
    fontWeight: weight.bold,
    letterSpacing: 0.84,
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingVertical: 4,
    textAlign: 'center',
  },
  dateDayFeed: {
    fontSize: 22,
    fontWeight: weight.bold,
    lineHeight: 22,
    color: colors.textPrimary,
    paddingTop: 6,
    paddingBottom: 8,
    textAlign: 'center',
  },
  dateTbdFeed: {
    width: 52,
    height: 54,
    borderRadius: 13,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    flexShrink: 0,
  },
  dateTbdEmojiFeed: {fontSize: 19, lineHeight: 19},
  dateTbdLabel: {fontSize: 9.5, fontWeight: weight.bold, letterSpacing: 0.56, textTransform: 'uppercase', color: colors.textMuted},

  dateTileCompact: {width: 44, borderRadius: 12, backgroundColor: colors.surfaceAlt, overflow: 'hidden', flexShrink: 0},
  dateMonthCompact: {
    fontSize: 9.5,
    fontWeight: weight.bold,
    letterSpacing: 0.76,
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingVertical: 3,
    textAlign: 'center',
  },
  dateDayCompact: {
    fontSize: 17,
    fontWeight: weight.bold,
    lineHeight: 17,
    color: colors.textPrimary,
    paddingTop: 5,
    paddingBottom: 6,
    textAlign: 'center',
  },
  dateTbdCompact: {
    width: 44,
    height: 46,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dateTbdEmojiCompact: {fontSize: 18, lineHeight: 18},

  titleBlock: {flex: 1, minWidth: 0},
  titleRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
  title: {flex: 1, minWidth: 0, fontSize: 17.5, fontWeight: weight.bold, lineHeight: 21.875, letterSpacing: -0.2, color: colors.textPrimary},
  strike: {textDecorationLine: 'line-through'},

  inlineTypeChip: {flexShrink: 0, marginTop: 2, paddingVertical: 4, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: colors.accentSoft},
  inlineTypeChipText: {fontSize: 10.5, fontWeight: weight.semibold, color: colors.accent},

  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6},
  locRow: {marginTop: 4},
  metaGlyph: {fontSize: 13, color: colors.textSecondary},
  metaLabel: {flex: 1, fontSize: 13, fontWeight: weight.regular, color: colors.textSecondary},

  hostRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14},
  hostText: {flex: 1, fontSize: 12.5, fontWeight: weight.regular, color: colors.textSecondary},
  tagText: {flexShrink: 0, fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono},

  footerRow: {flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 15},
  footBeFirst: {fontSize: 13, fontWeight: weight.semibold, color: colors.accent},
  footGoingMain: {fontSize: 14, fontWeight: weight.bold, color: colors.accent},
  footGoingSub: {fontSize: 12.5, fontWeight: weight.regular, color: colors.textMuted},
  footInterestedMain: {fontSize: 13, fontWeight: weight.semibold, color: colors.textSecondary},
  footSpots: {fontSize: 13, fontWeight: weight.regular},
  footerSpacer: {flex: 1},
  cancelledText: {fontSize: 12.5, fontWeight: weight.semibold, color: colors.danger},

  pill: {flexShrink: 0, flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1},
  pillText: {fontSize: 12.5, fontWeight: weight.semibold},

  // ── Compact ───────────────────────────────────────────────────────────────
  compactCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    // `embed`, not `surface`: the compact card is ALWAYS nested inside another reading surface
    // (channel message card, chat bubble, comment), and `surface` is that host's own fill — the two
    // merged into one indistinguishable slab. The raised neutral + hairline is what separates them;
    // the shadow alone is invisible on dark. See theme `embed`.
    backgroundColor: colors.embed,
    borderWidth: 1,
    borderColor: colors.embedBorder,
    borderRadius: 15,
    paddingVertical: 11,
    paddingHorizontal: 13,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: {width: 0, height: 4},
    elevation: 4,
  },
  compactCardPressed: {backgroundColor: colors.embedHover},
  compactBody: {flex: 1, minWidth: 0},
  compactTitle: {fontSize: 14.5, fontWeight: weight.semibold, color: colors.textPrimary},
  compactSub: {fontSize: 12, fontWeight: weight.regular, color: colors.textMuted, marginTop: 2},
  chevron: {flexShrink: 0, fontSize: 18, lineHeight: 18, color: colors.textMuted},
});

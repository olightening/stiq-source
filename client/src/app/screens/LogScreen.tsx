/**
 * LogScreen — the Log tab, rebuilt token-for-token from the "Stiq Log" design handoff
 * (design_handoff_log: the hearth + the community log).
 *
 * Two layers:
 *   1. THE HEARTH (the base tab) — the community's warm front room: the owner's note (a
 *      gradient-border card with the standing rules tucked inside, collapsible to a pill strip
 *      with a version-keyed persisted dismissal — STATES §2), the organizers' picked channels,
 *      the people-worth-knowing rail, and the 🕯️ doorway into the moderation record.
 *   2. THE COMMUNITY LOG (a full-screen view behind the doorway) — the append-only, searchable,
 *      filterable moderation record in Grouped/Timeline layouts, with a detail sheet per action
 *      and a full-post drill-down (MainScreen's LogPostView modal).
 *
 * Every text on the hearth is ORGANIZER-CONTROLLED (kind-30078 stiq:log-page → LogHearthData);
 * the community log's own copy and its entries are NOT — the record is append-only and rendered
 * from the live moderation-event stream, read-only for everyone.
 *
 * Navigation state that other surfaces depend on lives in MainScreen (logOpen hides the chrome
 * like every sub-screen; openEntryKey lets the full-post modal orchestrate with the sheet).
 */
import React, {useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  FlatList,
  type ListRenderItem,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, {Defs, LinearGradient, RadialGradient, Rect, Stop} from 'react-native-svg';
import Reanimated from 'react-native-reanimated';
import {Press} from '../../ui/Press';
import {TabRailTouchContext} from '../../ui/useTabSwipe';
import {useSwipeBack} from '../../ui/SwipeBack';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import {
  type ModLogEntry,
  type ModAction,
  type ModTargetType,
  UNATTRIBUTED_REPORT_TYPE,
} from '../../moderation/modlog';
import {decodeNameHeader} from '../../profile/displayName';
import type {FeaturedRow} from '../../channels/featured';
import {
  LOG_PAGE_COPY_DEFAULTS,
  fillDoorwaySub,
  type LogHearthData,
  type LogPickRow,
  type LogPersonRow,
} from '../../channels/logPage';
import {
  dismissNote,
  undismissNote,
  isNoteDismissed,
  logLayoutPref,
  setLogLayoutPref,
  type LogLayout,
} from '../logPagePrefs';
import type {GradientSpec} from '../../media/gradient';
import {GradientDot} from '../../ui/GradientDot';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {colors, weight} from '../../ui/theme';
import {BOTTOM_DOCK_CLEARANCE} from '../../ui/BottomDock';
import {relTime as relTimeStyled} from '../../ui/relTime';

// ── Exported types ────────────────────────────────────────────────────────────

/**
 * Payload handed to `onOpenLogPost` when the user taps the removed-content card in the
 * detail sheet. The integrator uses this to render the full-post view (Overlay B) with the
 * correct banner tone and composer state.
 */
export interface LogPostOpenInfo {
  targetId: string;
  targetType: import('../../moderation/modlog').ModTargetType;
  /** 'Post' | 'Comment' | 'Locked thread' */
  kindLabel: string;
  /** 'removed' — red danger banner; 'intact' — neutral surface banner. */
  bannerTone: 'removed' | 'intact';
  /** e.g. "Removed by Maeve R. · Privacy & opsec" or "Locked by …" */
  bannerText: string;
  bannerReason: string;
  /** true when status is Removed, Banned, or Locked — composer is frozen. */
  composerClosed: boolean;
  /** "Commenting is closed on removed content." or "This thread is locked." */
  closedText: string;
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface LogScreenProps {
  /** True for the current user — mods may restore from the detail sheet. */
  isModerator: boolean;
  /** The organizer-controlled hearth (note, rules, picks, people, copy). Null → defaults only. */
  hearth: LogHearthData | null;
  /** Whether the full-screen community-log view is open. Lifted to MainScreen: it hides the
   *  persistent chrome (like every sub-screen) and participates in hardware-back ordering. */
  logOpen: boolean;
  onSetLogOpen: (open: boolean) => void;
  /** Open a picked space / featured person. Same routing contract as the old featured rail.
   *  `name` is the pick's resolved display name — the join-request dialog for a not-yet-joined
   *  group shows it (the group's own metadata is unreadable to a non-member). */
  onOpenPick?: (ref: string, type: 'channel' | 'group' | 'user', name?: string) => void;
  /** Full moderator-action log, newest first. */
  entries?: ModLogEntry[];
  /** Resolve a peer's display name + gradient identity for rendering. */
  getProfile?: (pubkey: string) => {name?: string; gradient?: GradientSpec | null} | undefined;
  /** The open detail-sheet entry key. Lifted to MainScreen so the full-post modal can
   *  orchestrate with the sheet (author-tap closes both; back returns to the open sheet). */
  openEntryKey: string | null;
  onOpenEntry: (key: string | null) => void;
  /** Open the original post/comment behind a log entry (the full-post modal). The sheet stays
   *  open beneath it — closing the post returns to the sheet, exactly per the design. */
  onOpenLogPost?: (info: LogPostOpenInfo) => void;
  /** Moderator: restore a hidden post/comment, or unhide a user, from the log. */
  onRestore?: (targetId: string, targetType: ModTargetType, authorPubkey?: string) => void;
  /** Moderator-only: open the moderator console (reports queue + bans). */
  onOpenModTools?: () => void;
  /** Member reports awaiting review — drives the mod-tools badge. */
  pendingReportCount?: number;
  /**
   * Tab-switch scroll restore (Fix 2): the hearth ScrollView's offset (px) to jump back to, ONCE,
   * the first time its content is measured after mount — the Log tab body unmounts on tab switch
   * (MainScreen renders it as `{tab === 'log' && …}`), so a fresh mount always starts at offset 0
   * without this.
   */
  restoreHearthOffset?: number;
  /** Fires on every hearth scroll (throttled) so MainScreen can remember the live offset in a ref. */
  onHearthScroll?: (y: number) => void;
}

// ── Pure helpers (shared with tests) ─────────────────────────────────────────

function shortNpub(npub: string): string {
  return shortenNpub(npub, {lead: 12, tail: 4, minLen: 16});
}

/** Relative age, design-style: "25m" / "1h" / "3h" / "2d". */
function relTime(tsSeconds: number, nowMs: number): string {
  return relTimeStyled(tsSeconds, 'log', nowMs);
}

/** Day bucket from age, matching the design's Today / Yesterday / Earlier grouping. */
function dayBucket(tsSeconds: number, nowMs: number): 'Today' | 'Yesterday' | 'Earlier' {
  const mins = (nowMs / 1000 - tsSeconds) / 60;
  if (mins < 1440) return 'Today';
  if (mins < 2880) return 'Yesterday';
  return 'Earlier';
}

type StatusKind =
  | 'Removed'
  | 'Banned'
  | 'Restored'
  | 'Locked'
  | 'Edited'
  | 'Pinned'
  | 'Unlocked'
  | 'Unpinned';

interface Row {
  key: string;
  /** Filter category: maps to the All / Posts / Comments / Other chips. */
  cat: 'post' | 'comment' | 'other';
  /** Unix-seconds timestamp from the source entry (for day-bucket grouping). */
  timestamp: number;
  glyph: string;
  actionLabel: string;
  status: StatusKind;
  at: string;
  /** Channel or group display name, when the target belongs to one. */
  where?: string;
  // moderator identity
  modName: string;
  modSeed: string;
  modGradient?: GradientSpec | null;
  // targeted author identity
  authorName: string;
  authorSeed: string;
  authorGradient?: GradientSpec | null;
  snippet: string;
  reason: string;
  tags: string[];
  viewLabel: string;
  target: string;
  targetType: ModTargetType;
  targetAuthorPubkey?: string;
  action: ModAction;
  /** Structural removal (no member-signed attestation) — no member to reinstate, so hide Restore. */
  unattributable: boolean;
}

/** Map an action + target type to its glyph, human label, filter category and status. */
function actionShape(action: ModAction, targetType: ModTargetType): {
  glyph: string;
  label: string;
  cat: 'post' | 'comment' | 'other';
  status: StatusKind;
} {
  switch (action) {
    case 'hide':
      if (targetType === 'user') return {glyph: '🚫', label: 'Removed a member', cat: 'other', status: 'Banned'};
      if (targetType === 'comment') return {glyph: '🗑', label: 'Removed a comment', cat: 'comment', status: 'Removed'};
      return {glyph: '🗑', label: 'Removed a post', cat: 'post', status: 'Removed'};
    case 'restore':
      if (targetType === 'user') return {glyph: '↩️', label: 'Reinstated a member', cat: 'other', status: 'Restored'};
      if (targetType === 'comment') return {glyph: '↩️', label: 'Restored a comment', cat: 'comment', status: 'Restored'};
      return {glyph: '↩️', label: 'Restored a post', cat: 'post', status: 'Restored'};
    case 'lock':
      return {glyph: '🔒', label: 'Locked a thread', cat: 'other', status: 'Locked'};
    case 'unlock':
      return {glyph: '🔓', label: 'Unlocked a thread', cat: 'other', status: 'Unlocked'};
    case 'retag':
      return {glyph: '🏷️', label: 'Re-tagged a post', cat: 'post', status: 'Edited'};
    case 'pin':
      return {glyph: '📌', label: 'Pinned a note', cat: 'post', status: 'Pinned'};
    case 'unpin':
      return {glyph: '📌', label: 'Unpinned a note', cat: 'post', status: 'Unpinned'};
    case 'ban':
      return {glyph: '🚫', label: 'Banned a member', cat: 'other', status: 'Banned'};
    case 'unban':
      return {glyph: '↩️', label: 'Lifted a ban', cat: 'other', status: 'Restored'};
  }
}

/** Derive flair tags wired to the mod action: the NIP-56 report type, plus any #hashtags the
 *  moderator wrote in the reason. Falls back to a bare single-keyword reason. */
function deriveTags(reportType: string | undefined, reason: string | undefined): string[] {
  // Tags are STORED bare (no leading '#'); the Log surface renders them '#'-prefixed per design.
  const tags = new Set<string>();
  if (reportType?.trim()) tags.add(reportType.trim().toLowerCase());
  for (const h of reason?.match(/#[\p{L}\p{N}_-]+/gu) ?? []) tags.add(h.slice(1).toLowerCase());
  if (tags.size === 0 && reason) {
    const trimmed = reason.trim();
    // A bare report-type keyword (e.g. "spam", "harassment") becomes one tag; prose stays untagged.
    if (trimmed && !/\s/.test(trimmed) && trimmed.length <= 24) tags.add(trimmed.toLowerCase());
  }
  return [...tags].slice(0, 3);
}

/**
 * Build the display rows for the mod log. Exported for unit testing the per-snapshot profile
 * memoization (each distinct pubkey resolves its — expensive — profile at most once).
 */
export function buildRows(
  entries: ModLogEntry[],
  getProfile: LogScreenProps['getProfile'],
  nowMs: number,
): Row[] {
  // getProfile is AppRuntime.getProfile → buildProfile, which runs several full store scans and
  // maps every post the author ever wrote through toFeedItem — an expensive call we only mine for
  // {name, gradient}. Distinct pubkeys recur heavily across the log (the same handful of moderators,
  // repeat-offending authors), so resolve each pubkey at most once per snapshot instead of the naive
  // 2 calls per entry.
  const profileCache = new Map<string, ReturnType<NonNullable<typeof getProfile>>>();
  const profileOf = (pubkey: string): ReturnType<NonNullable<typeof getProfile>> => {
    if (profileCache.has(pubkey)) return profileCache.get(pubkey);
    const p = getProfile?.(pubkey);
    profileCache.set(pubkey, p);
    return p;
  };

  return entries.map(e => {
    const shape = actionShape(e.action, e.targetType);
    const modProfile = profileOf(e.moderatorPubkey);
    const modName = e.auto ? 'Automatic' : modProfile?.name?.trim() || shortNpub(e.moderatorNpub);

    // For user targets the "author" is the removed member; their pubkey is the target itself.
    const authorPubkey = e.targetAuthorPubkey ?? (e.targetType === 'user' ? e.target : undefined);
    const authorProfile = authorPubkey ? profileOf(authorPubkey) : undefined;
    const authorName =
      authorProfile?.name?.trim() || (authorPubkey ? shortNpub(safeNpubEncode(authorPubkey)) : 'a member');

    // For retag actions, synthesize a snippet from newLabel when targetContent is absent.
    let snippet: string;
    if (e.action === 'retag' && e.newLabel) {
      const labelCap = e.newLabel.charAt(0).toUpperCase() + e.newLabel.slice(1);
      snippet = e.targetContent
        ? decodeNameHeader(e.targetContent).text.trim() || `Re-labeled to ${labelCap}.`
        : `Re-labeled to ${labelCap}.`;
    } else {
      const cleanSnippet = e.targetContent ? decodeNameHeader(e.targetContent).text.trim() : '';
      snippet =
        cleanSnippet ||
        (e.targetType === 'user' ? 'Member removed from the community.' : 'Content removed by a moderator.');
    }

    return {
      key: e.key,
      cat: shape.cat,
      timestamp: e.timestamp,
      glyph: shape.glyph,
      actionLabel: shape.label,
      status: shape.status,
      at: relTime(e.timestamp, nowMs),
      where: e.where,
      modName,
      modSeed: e.moderatorPubkey,
      modGradient: modProfile?.gradient ?? null,
      authorName,
      authorSeed: authorPubkey ?? e.moderatorPubkey,
      authorGradient: authorProfile?.gradient ?? null,
      snippet,
      reason: e.reason?.trim() || 'Removed by a moderator under the community rules.',
      tags: deriveTags(e.reportType, e.reason),
      viewLabel: e.targetType === 'comment' ? 'View comment in context' : 'View post & comments',
      target: e.target,
      targetType: e.targetType,
      targetAuthorPubkey: e.targetAuthorPubkey,
      action: e.action,
      unattributable: e.reportType === UNATTRIBUTED_REPORT_TYPE,
    };
  });
}

/**
 * Status pill colors. Per design: "the only red is danger."
 * - Danger (Removed, Banned, Locked, Edited, Pinned) → danger fg/bg.
 * - Neutral/muted (Restored, Unlocked, Unpinned) → textSecondary on surfaceAlt (no green).
 */
function statusColors(status: StatusKind): {fg: string; bg: string} {
  switch (status) {
    case 'Restored':
    case 'Unlocked':
    case 'Unpinned':
      return {fg: colors.textSecondary, bg: colors.surfaceAlt};
    default:
      return {fg: colors.danger, bg: colors.dangerBg};
  }
}

/** Which open-route a pick uses (same contract as the old featured rail). */
function pickRouteType(kind: FeaturedRow['kind']): 'channel' | 'group' | 'user' {
  if (kind === 'user') return 'user';
  if (kind === 'channel' || kind === 'open') return 'channel';
  return 'group';
}

// ── Aurora wash (REDLINES §0.1) ──────────────────────────────────────────────

/**
 * The soft aurora behind the hearth's top: three faint radial gradients in the identity colors,
 * absolutely positioned inside the scroll body, non-interactive, purely decorative.
 */
const AuroraWash = React.memo(function AuroraWash(): React.JSX.Element {
  return (
    <View style={s.aurora} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="300">
        <Defs>
          <RadialGradient id="au1" cx="18%" cy="28%" rx="58%" ry="52%">
            <Stop offset="0" stopColor="#7cb2ff" stopOpacity={0.15} />
            <Stop offset="1" stopColor="#7cb2ff" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="au2" cx="78%" cy="18%" rx="55%" ry="50%">
            <Stop offset="0" stopColor="#b89aff" stopOpacity={0.13} />
            <Stop offset="1" stopColor="#b89aff" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="au3" cx="55%" cy="75%" rx="60%" ry="55%">
            <Stop offset="0" stopColor="#f472b6" stopOpacity={0.07} />
            <Stop offset="1" stopColor="#f472b6" stopOpacity={0} />
          </RadialGradient>
          {/* Top veil: the wash used to overhang the ScrollView by 50px so its softest band was
              CLIPPED — the visible gradient started at non-zero alpha exactly at the header seam,
              reading as an abrupt cut. This bg-coloured fade makes the wash's top edge
              mathematically equal the header's flat background, so the aurora now melts into the
              chrome instead of being sliced by it. */}
          <LinearGradient id="auVeil" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.bg} stopOpacity={1} />
            <Stop offset="1" stopColor={colors.bg} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="300" fill="url(#au1)" />
        <Rect x="0" y="0" width="100%" height="300" fill="url(#au2)" />
        <Rect x="0" y="0" width="100%" height="300" fill="url(#au3)" />
        <Rect x="0" y="0" width="100%" height="72" fill="url(#auVeil)" />
      </Svg>
    </View>
  );
});

// ── Sparkles (REDLINES §1.1) ─────────────────────────────────────────────────

/** A twinkling ✦ — opacity .25→.9→.25, scale .9→1.15→.9, looping. Static under reduced motion. */
function Sparkle({
  color,
  size,
  top,
  right,
  duration,
  delay = 0,
  reduceMotion,
}: {
  color: string;
  size: number;
  top: number;
  right: number;
  duration: number;
  delay?: number;
  reduceMotion: boolean;
}): React.JSX.Element {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, {toValue: 1, duration: duration / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(v, {toValue: 0, duration: duration / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, duration, delay, reduceMotion]);
  const opacity = reduceMotion ? 0.6 : v.interpolate({inputRange: [0, 1], outputRange: [0.25, 0.9]});
  const scale = reduceMotion ? 1 : v.interpolate({inputRange: [0, 1], outputRange: [0.9, 1.15]});
  return (
    <Animated.Text
      style={[s.sparkle, {color, fontSize: size, top, right, opacity, transform: [{scale}]}]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      ✦
    </Animated.Text>
  );
}

// ── Section header (eyebrow + fading hairline, REDLINES §2/§3) ───────────────

function SectionHeader({label, first}: {label: string; first?: boolean}): React.JSX.Element {
  return (
    <View style={[s.sectionHeader, first ? s.sectionHeaderFirst : null]}>
      <Text style={s.sectionEyebrow}>{label}</Text>
      <View style={s.sectionHairline}>
        <Svg width="100%" height="1">
          <Defs>
            <LinearGradient id="hl" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={colors.border} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.border} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="1" fill="url(#hl)" />
        </Svg>
      </View>
    </View>
  );
}

// ── Owner-note card (REDLINES §1) ────────────────────────────────────────────

function OwnerNoteCard({
  hearth,
  rulesOpen,
  onToggleRules,
  onTuck,
  reduceMotion,
}: {
  hearth: LogHearthData;
  rulesOpen: boolean;
  onToggleRules: () => void;
  onTuck: () => void;
  reduceMotion: boolean;
}): React.JSX.Element | null {
  const note = hearth.note;
  if (!note) return null;
  const copy = hearth.copy;
  return (
    <View style={s.noteWrap}>
      {/* 1px gradient border: an SVG gradient rect underneath, the surface card inset 1px above. */}
      <View style={s.noteBorder}>
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <LinearGradient id="noteb" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#7cb2ff" stopOpacity={0.45} />
              <Stop offset="0.5" stopColor="#b89aff" stopOpacity={0.32} />
              <Stop offset="1" stopColor="#f472b6" stopOpacity={0.25} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" rx={17} ry={17} fill="url(#noteb)" />
        </Svg>
        <View style={s.noteCard} accessibilityRole="summary" accessibilityLabel={note.title}>
          <Sparkle color="#b89aff" size={12} top={12} right={14} duration={3200} reduceMotion={reduceMotion} />
          <Sparkle color="#7cb2ff" size={8} top={26} right={30} duration={4100} delay={900} reduceMotion={reduceMotion} />

          {/* identity row */}
          <View style={s.noteIdentityRow}>
            <View style={s.noteAvatarRing}>
              <GradientAvatar gradient={note.gradient} seed={note.seed} size={42} shape="circle" />
            </View>
            <View style={s.noteIdentityText}>
              <Text style={s.noteTitle}>{note.title}</Text>
              <Text style={s.noteSubline} numberOfLines={1}>{note.subline}</Text>
            </View>
          </View>

          {/* the note — a letter in the app's own font, not UI: carried by rhythm, not a serif face */}
          <Text style={s.noteBody}>{note.body}</Text>
          {!!note.signature && <Text style={s.noteSignature}>{note.signature}</Text>}

          {/* action row */}
          <View style={s.noteActions}>
            {hearth.rules ? (
              <Press
                onPress={onToggleRules}
                hitSlop={12}
                accessibilityState={{expanded: rulesOpen}}
                accessibilityLabel={rulesOpen ? copy.rulesHideLabel : copy.rulesShowLabel}>
                <Text style={s.rulesToggleText}>
                  {rulesOpen ? copy.rulesHideLabel : copy.rulesShowLabel}
                  <Text style={s.rulesToggleChevron}>{rulesOpen ? '  ⌃' : '  ⌄'}</Text>
                </Text>
              </Press>
            ) : (
              <View />
            )}
            <View style={s.flex1} />
            <Press
              onPress={onTuck}
              hitSlop={12}
              accessibilityLabel="Tuck this note away">
              <Text style={s.tuckText}>
                {copy.tuckLabel}
                <Text style={s.tuckChevron}>  ⌃</Text>
              </Text>
            </Press>
          </View>

          {/* standing rules, tucked inside the note */}
          {rulesOpen && hearth.rules && (
            <View style={s.rulesBlock}>
              <Text style={s.rulesEyebrow}>{hearth.rules.eyebrow}</Text>
              <Text style={s.rulesBody}>{hearth.rules.body}</Text>
              <Text style={s.rulesMeta}>{hearth.rules.meta}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/** The collapsed pill strip — the whole note tucked away (REDLINES §1.6). */
function CollapsedNoteStrip({hearth, onReopen}: {hearth: LogHearthData; onReopen: () => void}): React.JSX.Element | null {
  const note = hearth.note;
  if (!note) return null;
  return (
    <View style={s.noteWrap}>
      <Press
        variant="row"
        style={s.noteStrip}
        onPress={onReopen}
        accessibilityState={{expanded: false}}
        accessibilityLabel={`${note.title} — collapsed. Reopen`}>
        <GradientAvatar gradient={note.gradient} seed={note.seed} size={26} shape="circle" />
        <Text style={s.noteStripLabel} numberOfLines={1}>{note.title}</Text>
        {/* The word + chevron are nested in one non-shrinking Text (matching tuck/rules), so the
            title's flex:1 can never squeeze "reopen" and clip it mid-word on Android. */}
        <Text style={s.noteStripReopen} numberOfLines={1}>
          {hearth.copy.reopenLabel}
          <Text style={s.noteStripReopenChevron}>{'  ⌄'}</Text>
        </Text>
      </Press>
    </View>
  );
}

// ── Picks + people (REDLINES §2–3) ───────────────────────────────────────────

function PickCard({pick, onOpen}: {pick: LogPickRow; onOpen?: () => void}): React.JSX.Element {
  // Never disabled: an unresolved (e.g. private, not-yet-joined) group routes to the
  // join-request dialog instead of dead-tapping — the integrator decides per membership.
  return (
    <Press
      variant="row"
      style={s.pickCard}
      onPress={onOpen}
      accessibilityLabel={`${pick.name}, ${pick.chip} channel${pick.unread ? `, ${pick.unread} unread` : ''}${pick.membersLabel ? `, ${pick.membersLabel}` : ''}`}>
      <GradientAvatar gradient={pick.gradient} seed={pick.seed} size={40} shape={pick.shape} />
      <View style={s.pickBody}>
        <View style={s.pickNameRow}>
          <Text style={s.pickName} numberOfLines={1}>{pick.name}</Text>
          {/* kind chip: a pill bubble on the title row, anchored to the right edge */}
          <View style={s.pickChip}>
            <Text style={s.pickChipText}>{pick.chip}</Text>
          </View>
        </View>
        {!!pick.blurb && (
          <Text style={s.pickBlurb} numberOfLines={1}>{`“${pick.blurb}”`}</Text>
        )}
        {!!pick.membersLabel && <Text style={s.pickMembers}>{pick.membersLabel}</Text>}
      </View>
      {/* live unread bubble (Point 2) — the app's standard unread pill, at the list-row's right edge
          so "3" reads the same here as on the Spaces list. */}
      {!!pick.unread && (
        <View style={s.pickUnread}>
          <Text style={s.pickUnreadText}>{pick.unread > 99 ? '99+' : pick.unread}</Text>
        </View>
      )}
      <Text style={s.pickChevron}>›</Text>
    </Press>
  );
}

function PeopleRail({people, onOpen}: {people: LogPersonRow[]; onOpen?: (pubkey: string) => void}): React.JSX.Element {
  // Dragging this people rail scrolls it instead of switching tab — the stage swipe (MainScreen)
  // reads this shared flag and stands down while the rail is touched. No-op outside that host.
  const railTouch = useContext(TabRailTouchContext);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      {...railTouch}
      contentContainerStyle={s.peopleRail}>
      {people.map(p => (
        <Press
          variant="row"
          key={p.pubkey}
          style={s.personCard}
          onPress={onOpen ? () => onOpen(p.pubkey) : undefined}
          accessibilityLabel={p.role ? `${p.name}, ${p.role}` : p.name}>
          <GradientAvatar gradient={p.gradient} seed={p.seed} size={46} shape="circle" />
          <Text style={s.personName} numberOfLines={1}>{p.name}</Text>
          {!!p.role && <Text style={s.personRole} numberOfLines={2}>{p.role}</Text>}
        </Press>
      ))}
    </ScrollView>
  );
}

// ── Shared entry card body content (REDLINES §5.2) ───────────────────────────

/** The inner content of a log entry card, shared by grouped and timeline layouts. */
function EntryCardContent({row}: {row: Row}): React.JSX.Element {
  return (
    <>
      <View style={s.entryTopRow}>
        <Text style={s.entryAction}>{row.actionLabel}</Text>
        <View style={s.flex1} />
        <Text style={s.entryAt}>{row.at}</Text>
      </View>
      <View style={s.entryModRow}>
        <GradientDot size={18} gradient={row.modGradient} seed={row.modSeed} />
        <Text style={s.entryModLine}>{`by ${row.modName}`}</Text>
      </View>
      <Text style={s.entrySnippet} numberOfLines={1}>
        {row.snippet}
      </Text>
      {row.tags.length > 0 && (
        <View style={s.entryTags}>
          {row.tags.map(t => (
            <View key={t} style={s.tagPill}>
              <Text style={s.tagPillText}>{`#${t}`}</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

// ── Log entry card (grouped layout, REDLINES §5.4) ───────────────────────────

function EntryCard({row, onOpen}: {row: Row; onOpen: () => void}): React.JSX.Element {
  return (
    <Press
      variant="row"
      onPress={onOpen}
      style={s.entryCard}
      accessibilityLabel={`${row.actionLabel} by ${row.modName}, ${row.at} ago. Tap to view details.`}>
      <View style={s.entryGlyphTile}>
        <Text style={s.entryGlyph}>{row.glyph}</Text>
      </View>
      <View style={s.entryBody}>
        <EntryCardContent row={row} />
      </View>
    </Press>
  );
}

// ── Timeline layout entry (REDLINES §5.3) ────────────────────────────────────

/**
 * A single row in the Timeline layout: a 30px-wide left rail with a 2px vertical connector
 * line and a 28px rounded-square glyph node, and a full-width entry card to the right.
 */
function TimelineEntry({row, onOpen}: {row: Row; onOpen: () => void}): React.JSX.Element {
  return (
    <View style={s.timelineRow}>
      {/* left rail: connector line + glyph node */}
      <View style={s.timelineRail}>
        <View style={s.timelineConnector} />
        <View style={s.timelineNode}>
          <Text style={s.timelineNodeGlyph}>{row.glyph}</Text>
        </View>
      </View>
      {/* entry card to the right */}
      <Press
        variant="row"
        onPress={onOpen}
        style={s.timelineCard}
        accessibilityLabel={`${row.actionLabel} by ${row.modName}, ${row.at} ago. Tap to view details.`}>
        <EntryCardContent row={row} />
      </Press>
    </View>
  );
}

// ── Detail bottom-sheet (REDLINES §6) ────────────────────────────────────────

/** Build a `LogPostOpenInfo` from a row for the `onOpenLogPost` handoff. */
function buildLogPostInfo(row: Row): LogPostOpenInfo {
  const kindLabel =
    row.targetType === 'comment'
      ? 'Comment'
      : row.status === 'Locked'
      ? 'Locked thread'
      : 'Post';

  const bannerTone: 'removed' | 'intact' =
    row.status === 'Removed' || row.status === 'Banned' ? 'removed' : 'intact';

  const displayStatus = row.status === 'Banned' ? 'Removed' : row.status;
  const bannerText = `${displayStatus} by ${row.modName}${row.where ? ' · ' + row.where : ''}`;

  const composerClosed = row.status === 'Removed' || row.status === 'Banned' || row.status === 'Locked';
  const closedText =
    row.status === 'Locked'
      ? 'This thread is locked.'
      : 'Commenting is closed on removed content.';

  return {
    targetId: row.target,
    targetType: row.targetType,
    kindLabel,
    bannerTone,
    bannerText,
    bannerReason: row.reason,
    composerClosed,
    closedText,
  };
}

/**
 * Detail sheet. Android's `<Modal>` reliably presents only when it stays mounted and its `visible`
 * prop toggles false→true — a conditionally-mounted `<Modal visible>` frequently fails to appear on
 * Android (the app-wide "always-mount + toggle visible" rule that every other shipped sheet follows).
 * So the Modal stays mounted at all times, driven by `visible`, and the last row is retained through
 * the slide-out so the sheet keeps its content while closing.
 */
function DetailSheet({
  visible,
  row,
  isModerator,
  onClose,
  onOpenLogPost,
  onRestore,
}: {
  visible: boolean;
  row: Row | null;
  isModerator: boolean;
  onClose: () => void;
  onOpenLogPost?: (info: LogPostOpenInfo) => void;
  onRestore?: (targetId: string, targetType: ModTargetType, authorPubkey?: string) => void;
}): React.JSX.Element {
  // Retain the last non-null row so the slide-out still renders content after `row` clears on close.
  const [lastRow, setLastRow] = useState<Row | null>(row);
  useEffect(() => {
    if (row) setLastRow(row);
  }, [row]);
  const shown = row ?? lastRow;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {shown && (
        <DetailSheetBody
          row={shown}
          isModerator={isModerator}
          onClose={onClose}
          onOpenLogPost={onOpenLogPost}
          onRestore={onRestore}
        />
      )}
    </Modal>
  );
}

/** The inner surface of the detail sheet — only rendered with a non-null row. */
function DetailSheetBody({
  row,
  isModerator,
  onClose,
  onOpenLogPost,
  onRestore,
}: {
  row: Row;
  isModerator: boolean;
  onClose: () => void;
  onOpenLogPost?: (info: LogPostOpenInfo) => void;
  onRestore?: (targetId: string, targetType: ModTargetType, authorPubkey?: string) => void;
}): React.JSX.Element {
  const sc = statusColors(row.status);

  // Whether we can open a post/comment view — user bans have no post to open.
  const canOpenPost = row.targetType !== 'user';

  function handleOpenPost(): void {
    if (!canOpenPost || !onOpenLogPost) return;
    // The sheet stays open — the full-post modal rises above it, and closing the post returns
    // here, exactly per the design's z-stack (log → sheet → post).
    onOpenLogPost(buildLogPostInfo(row));
  }

  // Sub-line in the header: "{where} · {at} ago" or just "{at} ago".
  const whereTime = `${row.where ? row.where + ' · ' : ''}${row.at} ago`;

  return (
    <View style={s.sheetRoot}>
      <Press variant="bare" style={s.scrim} onPress={onClose} accessibilityRole="none" accessibilityLabel="Close details" />
      <View style={s.sheet}>
        <View style={s.sheetHandleWrap}>
          <View style={s.sheetHandle} />
        </View>
        <ScrollView contentContainerStyle={s.sheetContent} showsVerticalScrollIndicator={false}>
          {/* header */}
          <View style={s.sheetHeader}>
            <View style={s.sheetGlyphTile}>
              <Text style={s.sheetGlyph}>{row.glyph}</Text>
            </View>
            <View style={s.flex1}>
              <Text style={s.sheetTitle}>{row.actionLabel}</Text>
              <Text style={s.sheetWhere}>{whereTime}</Text>
            </View>
          </View>

          {row.tags.length > 0 && (
            <View style={s.sheetTags}>
              {row.tags.map(t => (
                <View key={t} style={s.sheetTagPill}>
                  <Text style={s.sheetTagText}>{`#${t}`}</Text>
                </View>
              ))}
            </View>
          )}

          {/* removed content */}
          <Text style={s.sheetEyebrow}>REMOVED CONTENT</Text>
          <Press
            variant="row"
            style={s.removedCard}
            onPress={canOpenPost ? handleOpenPost : undefined}
            accessibilityLabel={canOpenPost ? row.viewLabel : 'Removed content'}>
            <View style={s.removedAuthorRow}>
              <GradientDot size={24} gradient={row.authorGradient} seed={row.authorSeed} />
              <Text style={s.removedAuthorName}>{row.authorName}</Text>
              <View style={s.flex1} />
              <View style={[s.statusTag, {backgroundColor: sc.bg}]}>
                <Text style={[s.statusTagText, {color: sc.fg}]}>{row.status.toUpperCase()}</Text>
              </View>
            </View>
            <Text style={s.removedSnippet}>{row.snippet}</Text>
            {canOpenPost && onOpenLogPost && (
              <View style={s.removedViewRow}>
                <Text style={s.removedViewText}>{`${row.viewLabel} ›`}</Text>
              </View>
            )}
          </Press>

          {/* reason */}
          <Text style={s.sheetEyebrow}>REASON</Text>
          <Text style={s.reasonText}>{row.reason}</Text>

          {/* moderator */}
          <View style={s.modCard}>
            <GradientDot size={30} gradient={row.modGradient} seed={row.modSeed} />
            <View style={s.flex1}>
              <Text style={s.modCardName}>{row.modName}</Text>
              <Text style={s.modCardSub}>{`Moderator · ${row.at} ago`}</Text>
            </View>
            {isModerator && onRestore && row.action === 'hide' && !row.unattributable && (
              <Press
                onPress={() => onRestore(row.target, row.targetType, row.targetAuthorPubkey)}
                accessibilityLabel={row.targetType === 'user' ? 'Unhide this member' : 'Restore this content'}>
                <Text style={s.restoreBtn}>
                  {row.targetType === 'user' ? 'Unhide' : 'Restore'}
                </Text>
              </Press>
            )}
          </View>

          <Text style={s.sheetFooter}>
            🔒 Removed content stays hidden from the feed but is kept in this append-only log.
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

// ── Filter chips ─────────────────────────────────────────────────────────────

type CatFilter = 'all' | 'post' | 'comment' | 'other';
const CHIPS: {id: CatFilter; label: string}[] = [
  {id: 'all', label: 'All'},
  {id: 'post', label: 'Posts'},
  {id: 'comment', label: 'Comments'},
  {id: 'other', label: 'Other'},
];

// ── Layout toggle ─────────────────────────────────────────────────────────────

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: LogLayout;
  onChange: (l: LogLayout) => void;
}): React.JSX.Element {
  return (
    <View style={s.layoutToggle}>
      <Press
        onPress={() => onChange('grouped')}
        style={[s.layoutBtn, layout === 'grouped' ? s.layoutBtnActive : s.layoutBtnInactive]}
        accessibilityLabel="Grouped layout"
        accessibilityState={{selected: layout === 'grouped'}}>
        <Text style={[s.layoutBtnText, layout === 'grouped' ? s.layoutBtnTextActive : s.layoutBtnTextInactive]}>
          Grouped
        </Text>
      </Press>
      <Press
        onPress={() => onChange('timeline')}
        style={[s.layoutBtn, layout === 'timeline' ? s.layoutBtnActive : s.layoutBtnInactive]}
        accessibilityLabel="Timeline layout"
        accessibilityState={{selected: layout === 'timeline'}}>
        <Text style={[s.layoutBtnText, layout === 'timeline' ? s.layoutBtnTextActive : s.layoutBtnTextInactive]}>
          Timeline
        </Text>
      </Press>
    </View>
  );
}

// ── Flattened list model (for FlatList virtualization) ────────────────────────

/**
 * The mod log is virtualized via FlatList. Both layouts flatten to a single typed row stream so
 * the list windows instead of mounting every EntryCard/TimelineEntry at once (the log is an
 * unbounded, community-lifetime scan). The grouped layout interleaves day-label markers; per-item
 * spacing carries the exact margins the design's nested containers produce.
 */
type ListItem =
  | {type: 'group-label'; key: string; label: string}
  | {type: 'entry'; key: string; row: Row; layout: LogLayout; lastInGroup: boolean};

/** Flatten grouped/timeline rows into one virtualizable stream, preserving order and spacing. */
function buildListData(
  layout: LogLayout,
  rows: Row[],
  groups: {label: string; items: Row[]}[],
): ListItem[] {
  if (layout === 'timeline') {
    return rows.map(r => ({type: 'entry' as const, key: r.key, row: r, layout, lastInGroup: false}));
  }
  const out: ListItem[] = [];
  for (const g of groups) {
    out.push({type: 'group-label', key: `label:${g.label}`, label: g.label.toUpperCase()});
    g.items.forEach((r, i) =>
      out.push({type: 'entry', key: r.key, row: r, layout, lastInGroup: i === g.items.length - 1}),
    );
  }
  return out;
}

// ── Screen ───────────────────────────────────────────────────────────────────

/** Stable empty rows array — keeps the lazy allRows memo referentially quiet while inactive. */
const EMPTY_ROWS: Row[] = [];

export function LogScreen({
  isModerator,
  hearth,
  logOpen,
  onSetLogOpen,
  onOpenPick,
  entries = [],
  getProfile,
  openEntryKey,
  onOpenEntry,
  onOpenLogPost,
  onRestore,
  onOpenModTools,
  pendingReportCount = 0,
  restoreHearthOffset,
  onHearthScroll,
}: LogScreenProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatFilter>('all');
  // Persisted UI pref (STATES §9). logPagePrefs is eagerly loaded at init/account-switch, so the
  // synchronous read here is accurate from the very first render.
  const [layout, setLayoutState] = useState<LogLayout>(() => logLayoutPref());
  const setLayout = useCallback((l: LogLayout) => {
    setLayoutState(l);
    void setLogLayoutPref(l);
  }, []);
  // Rules expanded flag — null falls back to the organizer's startExpanded tweak; session-only.
  const [rulesOpen, setRulesOpen] = useState<boolean | null>(null);
  // In-session note choice, KEYED TO THE VERSION so a new note arriving mid-session can never be
  // suppressed by a stale choice (STATES §2).
  const [noteState, setNoteState] = useState<{ver: string; open: boolean} | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => setReduceMotion(!!v))
      .catch(() => {});
  }, []);

  // Fix 2 (tab-switch scroll restore): one-shot restore of the hearth's scroll offset, mirroring
  // FeedList's own restoreOffset idiom — fires at most once per mount so later content changes
  // (a fresh pick/note arriving) never re-snap the reader's position.
  const hearthScrollRef = useRef<ScrollView>(null);
  const hearthRestoredRef = useRef(false);
  const handleHearthContentSizeChange = useCallback(() => {
    if (hearthRestoredRef.current) return;
    hearthRestoredRef.current = true;
    if (restoreHearthOffset && restoreHearthOffset > 0) {
      hearthScrollRef.current?.scrollTo({y: restoreHearthOffset, animated: false});
    }
  }, [restoreHearthOffset]);

  const copy = hearth?.copy ?? LOG_PAGE_COPY_DEFAULTS;

  // One "now" per entries-snapshot keeps every relative timestamp consistent and
  // prevents nowMs from changing every render and defeating the useMemo deps below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMs = useMemo(() => Date.now(), [entries]);

  // buildRows resolves a full profile per distinct pubkey — real store-scan work. The HEARTH never
  // needs it (its doorway counts derive from raw entries below), so rows are only built while a
  // surface that renders them is up: the community-log overlay or the detail sheet. This is what
  // keeps switching TO the Log tab as light as any other tab switch.
  const rowsActive = logOpen || openEntryKey !== null;
  const allRows = useMemo(
    () => (rowsActive ? buildRows(entries, getProfile, nowMs) : EMPTY_ROWS),
    [rowsActive, entries, getProfile, nowMs],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allRows.filter(r => {
      if (filter !== 'all' && r.cat !== filter) return false;
      if (!q) return true;
      return [r.actionLabel, r.snippet, r.modName, r.authorName, ...r.tags, r.where ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [allRows, query, filter]);

  // Group filtered rows by day, preserving the newest-first order within each bucket.
  const groups = useMemo(() => {
    const order: Array<'Today' | 'Yesterday' | 'Earlier'> = ['Today', 'Yesterday', 'Earlier'];
    const byDay: Record<string, Row[]> = {};
    for (const r of rows) {
      const bucket = dayBucket(r.timestamp, nowMs);
      (byDay[bucket] = byDay[bucket] ?? []).push(r);
    }
    return order.filter(o => byDay[o]?.length).map(o => ({label: o, items: byDay[o]!}));
  }, [rows, nowMs]);

  const total = entries.length;
  const filtering = !!query.trim() || filter !== 'all';
  const countLabel = filtering ? `${rows.length} of ${total}` : `${total} action${total === 1 ? '' : 's'}`;
  // Doorway sub-line: distinct moderators, straight off the raw entries so the hearth never pays
  // for buildRows (every 'Automatic' entry counts as one, matching the rendered name).
  const modCount = useMemo(
    () => new Set(entries.map(e => (e.auto ? 'auto' : e.moderatorPubkey))).size,
    [entries],
  );

  // Memoized: the log is an unbounded community-lifetime list, and this would otherwise re-scan
  // it on every keystroke/toggle re-render even though neither input changed.
  const openRow = useMemo(
    () => (openEntryKey ? allRows.find(r => r.key === openEntryKey) ?? null : null),
    [allRows, openEntryKey],
  );

  // ── Note collapse state (STATES §2 — THE CONTRACT) ──────────────────────────
  const note = hearth?.note;
  const noteVer = note?.version;
  const dismissed = noteVer ? isNoteDismissed(noteVer) : false;
  const noteOpen = note ? (noteState && noteState.ver === noteVer ? noteState.open : !dismissed) : false;

  const tuckNote = useCallback(() => {
    if (!noteVer) return;
    void dismissNote(noteVer);
    setNoteState({ver: noteVer, open: false});
    AccessibilityInfo.announceForAccessibility('Note collapsed. It will return when a new note is posted.');
  }, [noteVer]);

  const reopenNote = useCallback(() => {
    if (!noteVer) return;
    void undismissNote(noteVer);
    setNoteState({ver: noteVer, open: true});
  }, [noteVer]);

  const rulesShown = rulesOpen ?? hearth?.rules?.startExpanded ?? false;

  // ── Community log list plumbing ─────────────────────────────────────────────
  const listData = useMemo(() => buildListData(layout, rows, groups), [layout, rows, groups]);
  const keyExtractor = useCallback((it: ListItem) => it.key, []);
  const renderItem = useCallback<ListRenderItem<ListItem>>(
    ({item}) => {
      if (item.type === 'group-label') {
        return <Text style={s.groupLabelRow}>{item.label}</Text>;
      }
      const open = (): void => onOpenEntry(item.row.key);
      if (item.layout === 'timeline') {
        return (
          <View style={s.timelineItem}>
            <TimelineEntry row={item.row} onOpen={open} />
          </View>
        );
      }
      return (
        <View style={[s.groupedItem, item.lastInGroup ? s.groupedItemLast : s.groupedItemMid]}>
          <EntryCard row={item.row} onOpen={open} />
        </View>
      );
    },
    [onOpenEntry],
  );

  // Slide-in from the right (stiqSlideIn 0.22s) when the community log opens. The value is
  // PINNED to 0 while closed so the overlay's very first visible frame is already offset +
  // transparent — starting at 1 and resetting in the effect painted one fully-visible frame
  // before the animation, a visible flash on every open.
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!logOpen) {
      slide.setValue(0);
      return;
    }
    if (reduceMotion) {
      slide.setValue(1);
      return;
    }
    const anim = Animated.timing(slide, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    // Stop on unmount/close so a mid-animation teardown never fires the completion callback
    // into a dead tree (also what lets tests unmount without a stray timer).
    return () => anim.stop();
  }, [logOpen, reduceMotion, slide]);

  // Swipe-back for the community-log overlay (the transparent Modal below, wraps `logView` itself —
  // see the comment there for why). Called directly via `useSwipeBack`, not the `<SwipeBackView>`
  // wrapper, because this same component also needs `optOut` in hand below for its own search
  // TextInput: a component can never consume a context Provider it renders itself (only a genuine
  // descendant component can), and that TextInput is a plain sibling constructed right here, not a
  // separate component. `closeLog` is hoisted so the header ‹, the hardware BACK (this Modal's
  // `onRequestClose`) and the swipe can never drift apart (SwipeBack.tsx's ownership rule). Always
  // enabled: the row detail sheet and the full-post view that can sit above this overlay are each
  // their OWN separate `<Modal>` (own Android Dialog window — see BackModal's docstring in back.tsx),
  // so whichever is open already owns every touch here; unlike EventsOrganizerHost's `create`/
  // `manage`, there is no in-window inner level of the log overlay itself to gate off.
  const closeLog = useCallback(() => onSetLogOpen(false), [onSetLogOpen]);
  const swipe = useSwipeBack({enabled: true, onBack: closeLog});

  // ── Render ──────────────────────────────────────────────────────────────────

  const hearthBody = (
    <ScrollView
      ref={hearthScrollRef}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={s.hearthScroll}
      onScroll={onHearthScroll ? e => onHearthScroll(e.nativeEvent.contentOffset.y) : undefined}
      scrollEventThrottle={16}
      onContentSizeChange={handleHearthContentSizeChange}>
      {(hearth?.aurora ?? true) && <AuroraWash />}

      {/* the owner's note — expanded card, or the tucked pill strip */}
      {hearth?.note && (noteOpen ? (
        <OwnerNoteCard
          hearth={hearth}
          rulesOpen={rulesShown}
          onToggleRules={() => setRulesOpen(!rulesShown)}
          onTuck={tuckNote}
          reduceMotion={reduceMotion}
        />
      ) : (
        <CollapsedNoteStrip hearth={hearth} onReopen={reopenNote} />
      ))}

      {/* picked by the organizers */}
      {!!hearth?.picks.length && (
        <>
          <SectionHeader label={copy.picksHeader} first />
          <View style={s.pickList}>
            {hearth.picks.map(p => (
              <PickCard
                key={p.ref}
                pick={p}
                onOpen={onOpenPick ? () => onOpenPick(p.ref, pickRouteType(p.kind), p.name) : undefined}
              />
            ))}
          </View>
        </>
      )}

      {/* people worth knowing */}
      {(hearth?.showPeople ?? true) && !!hearth?.people.length && (
        <>
          <SectionHeader label={copy.peopleHeader} />
          <PeopleRail people={hearth.people} onOpen={onOpenPick ? pk => onOpenPick(pk, 'user') : undefined} />
        </>
      )}

      {/* the doorway into the record + the motto */}
      <View style={s.doorwayWrap}>
        <Press
          variant="row"
          style={s.doorway}
          onPress={() => onSetLogOpen(true)}
          accessibilityLabel={`${copy.doorwayTitle} — ${fillDoorwaySub(copy.doorwaySub, total, modCount)}`}>
          <View style={s.doorwayTile}>
            <Text style={s.doorwayGlyph}>🕯️</Text>
          </View>
          <View style={s.doorwayText}>
            <Text style={s.doorwayTitle}>{copy.doorwayTitle}</Text>
            <Text style={s.doorwaySub}>{fillDoorwaySub(copy.doorwaySub, total, modCount)}</Text>
          </View>
          <Text style={s.doorwayChevron}>›</Text>
        </Press>
        <Text style={s.motto}>{copy.motto}</Text>
      </View>

      {/* moderator-only console entry — a tool, kept quiet below the hearth's narrative */}
      {isModerator && onOpenModTools && (
        <Press variant="row" style={s.modToolsCard} onPress={onOpenModTools} accessibilityLabel="Open moderator tools">
          <View style={s.modToolsIcon}>
            <Text style={s.modToolsGlyph}>🛡️</Text>
          </View>
          <View style={s.flex1}>
            <Text style={s.modToolsTitle}>Moderator tools</Text>
            <Text style={s.modToolsSub}>Review reports &amp; manage bans</Text>
          </View>
          {pendingReportCount > 0 && (
            <View style={s.modToolsBadge}>
              <Text style={s.modToolsBadgeText}>{pendingReportCount}</Text>
            </View>
          )}
          <Text style={s.modToolsChevron}>›</Text>
        </Press>
      )}
    </ScrollView>
  );

  const logView = (
    <Animated.View
      style={[
        s.logView,
        {
          opacity: slide,
          transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [40, 0]})}],
        },
      ]}>
      {/* header: ‹ back · centered title · right spacer */}
      <View style={s.logHeaderBar}>
        <Press onPress={closeLog} hitSlop={12} style={s.logBackBtn} accessibilityLabel="Back">
          <Text style={s.logBackChevron}>‹</Text>
        </Press>
        <Text style={s.logViewTitle}>Community log</Text>
        <View style={s.logHeaderSpacer} />
      </View>

      <FlatList
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.logScroll}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            {/* mod log header + count + layout toggle */}
            <View style={s.logHeader}>
              <Text style={s.logHeading}>MODERATION LOG</Text>
              <Text style={s.logCount}>{countLabel}</Text>
              <View style={s.flex1} />
              <LayoutToggle layout={layout} onChange={setLayout} />
            </View>

            {/* search */}
            <View style={s.searchWrap}>
              <View style={s.searchBox}>
                <Text style={s.searchIcon}>🔍</Text>
                <TextInput
                  style={s.searchInput}
                  placeholder="Search removals, tags, moderators…"
                  placeholderTextColor={colors.textMuted}
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Search the moderation log"
                  // Stands the swipe-back drag down for this touch — a TextInput's own selection-handle
                  // drag never joins JS responder negotiation, so without this the page-level swipe
                  // would win the drag and the field could never be selected/caret-dragged one-handed.
                  {...swipe.optOut}
                />
              </View>
            </View>

            {/* filter chips */}
            <View style={s.chipRow}>
              {CHIPS.map(c => {
                const active = filter === c.id;
                return (
                  <Press
                    key={c.id}
                    onPress={() => setFilter(c.id)}
                    style={[s.chip, active ? s.chipActive : s.chipInactive]}
                    accessibilityLabel={`Filter: ${c.label}`}
                    accessibilityState={{selected: active}}>
                    <Text style={[s.chipText, active ? s.chipTextActive : s.chipTextInactive]}>
                      {c.label}
                    </Text>
                  </Press>
                );
              })}
            </View>
          </>
        }
        ListFooterComponent={listData.length > 0 ? <View style={s.listFooterPad} /> : null}
        ListEmptyComponent={
          <Text style={s.empty}>
            {total === 0 ? 'No moderation actions yet.' : 'Nothing matches your search.'}
          </Text>
        }
      />
    </Animated.View>
  );

  return (
    <View style={s.root}>
      {hearthBody}

      {/* The community log is an OVERLAY above the still-mounted hearth (design z10: absolute
          inset:0, stiqSlideIn) — never a content swap. A transparent always-mounted Modal covers
          the whole screen (persistent chrome included, exactly like the design's inset:0 panel)
          while the hearth keeps its scroll position beneath; the bg-painted panel inside slides
          in from the right over the visible hearth. The detail sheet + full-post Modals shown
          later stack above this one in show order (the verified Android z-contract). */}
      <Modal
        visible={logOpen}
        transparent
        animationType="none"
        onRequestClose={closeLog}>
        <SafeAreaView style={s.logModalSafe}>
          {/* Wraps `logView` itself, not just its children: `logView` (s.logView) is the one opaque
              layer inside this otherwise-transparent Modal, so sliding the whole thing away is what
              uncovers the real hearth still mounted behind it — wrapping only its insides would leave
              `logView`'s own flat background covering the screen instead. */}
          <Reanimated.View style={[s.flex1, swipe.style]} {...swipe.panHandlers}>
            {logView}
          </Reanimated.View>
        </SafeAreaView>
      </Modal>

      {/* Always mounted — Android only reliably shows a Modal when `visible` toggles false→true,
          not when a `<Modal visible>` is conditionally mounted. Driven by whether a row is open. */}
      <DetailSheet
        visible={!!openRow}
        row={openRow}
        isModerator={isModerator}
        onClose={() => onOpenEntry(null)}
        onOpenLogPost={onOpenLogPost}
        onRestore={onRestore}
      />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
// Pixel values transcribed from design_files/Log.dc.html + REDLINES.md.

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex1: {flex: 1},

  // hearth — bottom padding reserves room for the floating nav dock (shared chrome across all three
  // top-level screens) so the hearth's tail scrolls clear of it (was a plain 24px before the dock).
  hearthScroll: {paddingBottom: BOTTOM_DOCK_CLEARANCE},
  // Flush with the ScrollView's own edges: the old -50/-40 overhang was silently CLIPPED (a
  // ScrollView clips its content), which is what produced the hard cut at the header seam — the
  // in-Svg top veil now owns the fade instead of relying on clipped-away gradient tail.
  aurora: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
  },

  // sparkles
  sparkle: {position: 'absolute', zIndex: 1},

  // owner-note card (§1)
  noteWrap: {paddingHorizontal: 14, paddingTop: 16, paddingBottom: 4},
  noteBorder: {
    borderRadius: 17,
    padding: 1,
    overflow: 'hidden',
    // The sanctioned note glow (0 10px 34px rgba(124,178,255,.07)) — approximated with a tinted
    // elevation shadow on Android (API 28+ supports colored ambient shadows).
    shadowColor: '#7cb2ff',
    shadowOpacity: 0.07,
    shadowRadius: 34,
    shadowOffset: {width: 0, height: 10},
    elevation: 6,
  },
  noteCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
    paddingBottom: 14,
    overflow: 'hidden',
  },
  noteIdentityRow: {flexDirection: 'row', alignItems: 'center', gap: 11},
  // ring: 2px surface gap + 1.5px lavender halo (spec: 0 0 0 2px surface, 0 0 0 3.5px rgba(184,154,255,.45))
  noteAvatarRing: {
    padding: 2,
    backgroundColor: colors.surface,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: 'rgba(184,154,255,0.45)',
  },
  noteIdentityText: {minWidth: 0, flex: 1},
  // The card is a LETTER from the organizer, set in the APP's own system font so it never reads as a
  // unique serif island (the rest of the app is sans). The generous body line-height + the italic
  // signature keep the letter's warmth; the title is a small display line, the subline a quiet
  // tracked-caps meta line, so the hierarchy reads eyebrow-title-letter.
  noteTitle: {
    fontSize: 18,
    lineHeight: 23,
    fontWeight: '600',
    letterSpacing: 0.2,
    color: colors.textPrimary,
  },
  noteSubline: {
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 3,
  },
  noteBody: {
    fontSize: 16,
    lineHeight: 26.4,
    letterSpacing: 0.1,
    color: colors.textPrimary,
    marginTop: 14,
  },
  noteSignature: {
    fontStyle: 'italic',
    fontSize: 15,
    lineHeight: 21,
    color: colors.textSecondary,
    marginTop: 12,
  },
  noteActions: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 13},
  rulesToggleText: {fontSize: 13, fontWeight: '600', color: colors.accent},
  rulesToggleChevron: {fontSize: 11, color: colors.accent},
  tuckText: {fontSize: 12.5, fontWeight: '600', color: colors.textMuted},
  tuckChevron: {fontSize: 11, color: colors.textMuted},

  // standing rules (§1.5)
  rulesBlock: {marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border},
  // Matches the subline's tracked-caps treatment (one meta style across the card); the rules text
  // sits a step down from the letter body in the same app font.
  rulesEyebrow: {
    fontSize: 10.5,
    color: colors.textMuted,
    fontWeight: '600',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  rulesBody: {
    fontSize: 14.5,
    lineHeight: 24,
    color: colors.textSecondary,
  },
  rulesMeta: {marginTop: 11, fontSize: 11.5, color: colors.textMuted},

  // collapsed pill strip (§1.6)
  noteStrip: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingRight: 14,
    paddingLeft: 9,
  },
  noteStripLabel: {
    flex: 1,
    textAlign: 'left',
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  noteStripReopen: {flexShrink: 0, color: colors.textMuted, fontSize: 11.5},
  noteStripReopenChevron: {fontSize: 11, color: colors.textMuted},

  // section headers (§2/§3)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  sectionHeaderFirst: {paddingTop: 20},
  sectionEyebrow: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 0.88,
    textTransform: 'uppercase',
  },
  sectionHairline: {flex: 1, height: 1},

  // picks (§2)
  pickList: {flexDirection: 'column', gap: 9, paddingHorizontal: 14},
  pickCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  pickBody: {flex: 1, minWidth: 0},
  pickNameRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  pickName: {fontSize: 14.5, fontWeight: weight.semibold, color: colors.textPrimary, flex: 1},
  // The kind chip: the design's pill (radius 999, 2×7 pad, hairline border) kept on the title
  // row but pushed to its right edge by the title's flex:1.
  pickChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  pickChipText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  pickBlurb: {fontSize: 12.5, color: colors.textSecondary, fontStyle: 'italic', marginTop: 3},
  pickMembers: {fontSize: 11, color: colors.textMuted, marginTop: 3},
  // Live unread bubble (Point 2) — the app's standard unread pill (accent fill, white bold), sized
  // for the pick row and sitting just left of the chevron, exactly as on the Spaces list.
  pickUnread: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    flexShrink: 0,
    marginLeft: 4,
  },
  pickUnreadText: {color: '#ffffff', fontSize: 10.5, fontWeight: '700', lineHeight: 16},
  pickChevron: {color: colors.textMuted, fontSize: 16},

  // people rail (§3)
  peopleRail: {flexDirection: 'row', gap: 9, paddingHorizontal: 14},
  personCard: {
    width: 104,
    alignItems: 'center',
    gap: 7,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    paddingTop: 13,
    paddingHorizontal: 8,
    paddingBottom: 11,
  },
  personName: {fontSize: 13, fontWeight: '600', color: colors.textPrimary, textAlign: 'center'},
  personRole: {fontSize: 11, color: colors.textMuted, textAlign: 'center', lineHeight: 14.3},

  // doorway + motto (§4)
  doorwayWrap: {paddingHorizontal: 14, paddingTop: 20, paddingBottom: 8},
  doorway: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 15,
    paddingVertical: 14,
    paddingHorizontal: 15,
    // The doorway's sanctioned accent glow (0 0 0 1px rgba(79,142,236,.12), 0 8px 26px rgba(79,142,236,.08)).
    shadowColor: colors.accent,
    shadowOpacity: 0.1,
    shadowRadius: 26,
    shadowOffset: {width: 0, height: 8},
    elevation: 6,
  },
  doorwayTile: {
    width: 44,
    height: 44,
    borderRadius: 13,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(124,178,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doorwayGlyph: {fontSize: 20},
  doorwayText: {flex: 1, minWidth: 0, gap: 2},
  doorwayTitle: {fontSize: 15.5, fontWeight: '700', color: colors.textPrimary},
  doorwaySub: {fontSize: 12.5, color: colors.textSecondary},
  doorwayChevron: {color: colors.accent, fontSize: 19},
  motto: {
    textAlign: 'center',
    fontSize: 11.5,
    color: colors.textMuted,
    paddingTop: 14,
    paddingHorizontal: 10,
    paddingBottom: 16,
  },

  // moderator-only entry card (kept from the prior surface, quiet at the end of the hearth)
  modToolsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 14,
    marginTop: 2,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  modToolsIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modToolsGlyph: {fontSize: 18},
  modToolsTitle: {fontSize: 15, fontWeight: '700', color: colors.textPrimary},
  modToolsSub: {fontSize: 12, color: colors.textMuted, marginTop: 2},
  modToolsBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  modToolsBadgeText: {color: '#ffffff', fontSize: 12, fontWeight: '700'},
  modToolsChevron: {fontSize: 20, color: colors.textMuted, marginLeft: 4},

  // community-log view (§5) — a bg-painted panel sliding over the transparent modal window,
  // so the hearth beneath stays visible through the 0.22s slide exactly as in the design.
  logModalSafe: {flex: 1, backgroundColor: 'transparent'},
  logView: {flex: 1, backgroundColor: colors.bg},
  logHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 14,
    paddingHorizontal: 8,
    paddingBottom: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logBackBtn: {paddingVertical: 2, paddingHorizontal: 8},
  logBackChevron: {color: colors.accent, fontSize: 24, lineHeight: 28},
  logViewTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  logHeaderSpacer: {width: 34},
  logScroll: {paddingBottom: 32},

  // mod log header
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 9,
    gap: 8,
  },
  logHeading: {fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.88},
  logCount: {fontSize: 11.5, color: colors.textMuted},

  // layout toggle (segmented pill)
  layoutToggle: {flexDirection: 'row', gap: 2},
  layoutBtn: {borderRadius: 999, borderWidth: 1, paddingVertical: 3, paddingHorizontal: 9},
  layoutBtnActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  layoutBtnInactive: {backgroundColor: 'transparent', borderColor: colors.borderLight},
  layoutBtnText: {fontSize: 11.5, fontWeight: '600'},
  layoutBtnTextActive: {color: '#ffffff'},
  layoutBtnTextInactive: {color: colors.textSecondary},

  // search
  searchWrap: {paddingHorizontal: 14, paddingBottom: 10},
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  searchIcon: {fontSize: 14, opacity: 0.7},
  searchInput: {flex: 1, padding: 0, color: colors.textPrimary, fontSize: 14},

  // filter chips
  chipRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 14, paddingBottom: 12},
  chip: {borderRadius: 999, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 14},
  chipActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  chipInactive: {backgroundColor: 'transparent', borderColor: colors.borderLight},
  chipText: {fontSize: 12.5, fontWeight: '600'},
  chipTextActive: {color: '#ffffff'},
  chipTextInactive: {color: colors.textSecondary},

  // grouped list — day label + per-item gutters reproducing the design's nested-container spacing
  // under FlatList (which has no `gap`): 14px horizontal list padding, 9px between siblings, 16px
  // after the last entry of a group; the day label keeps its 2px inset inside the 14px gutter (→16).
  groupLabelRow: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 0.88,
    paddingTop: 6,
    paddingHorizontal: 16,
    paddingBottom: 9,
  },
  groupedItem: {paddingHorizontal: 14},
  groupedItemMid: {marginBottom: 9},
  groupedItemLast: {marginBottom: 16},
  timelineItem: {paddingHorizontal: 14},
  listFooterPad: {height: 18},
  empty: {textAlign: 'center', color: colors.textMuted, fontSize: 14, paddingVertical: 30, paddingHorizontal: 24},

  // entry card (grouped layout)
  entryCard: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  entryGlyphTile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  entryGlyph: {fontSize: 15},
  entryBody: {flex: 1, minWidth: 0},

  // entry card shared content (used in both grouped and timeline)
  entryTopRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  entryAction: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary},
  entryAt: {fontSize: 11.5, color: colors.textMuted},
  entryModRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5},
  entryModLine: {fontSize: 12.5, color: colors.textSecondary},
  entrySnippet: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderLight,
    paddingLeft: 10,
    marginTop: 9,
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18.85,
    fontStyle: 'italic',
  },
  entryTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10},
  tagPill: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  tagPillText: {fontSize: 11, color: colors.textSecondary},

  // timeline layout
  timelineRow: {flexDirection: 'row', gap: 0},
  timelineRail: {
    width: 30,
    flexShrink: 0,
    position: 'relative',
  },
  timelineConnector: {
    position: 'absolute',
    left: 14,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.border,
  },
  timelineNode: {
    position: 'relative',
    zIndex: 1,
    marginTop: 2,
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineNodeGlyph: {fontSize: 14},
  timelineCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    paddingVertical: 12,
    paddingHorizontal: 13,
    marginBottom: 12,
    marginLeft: 4,
    minWidth: 0,
  },

  // detail sheet (§6)
  sheetRoot: {flex: 1, justifyContent: 'flex-end'},
  scrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingTop: 8,
    paddingBottom: 20,
    maxHeight: '90%',
  },
  sheetHandleWrap: {alignItems: 'center', paddingTop: 6, paddingBottom: 14},
  sheetHandle: {width: 38, height: 5, borderRadius: 3, backgroundColor: colors.borderLight},
  sheetContent: {paddingHorizontal: 18},
  sheetHeader: {flexDirection: 'row', alignItems: 'center', gap: 12},
  sheetGlyphTile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetGlyph: {fontSize: 20},
  sheetTitle: {fontSize: 18, fontWeight: '700', color: colors.textPrimary},
  sheetWhere: {fontSize: 12.5, color: colors.textMuted, marginTop: 2},
  sheetTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14},
  sheetTagPill: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  sheetTagText: {fontSize: 11.5, color: colors.textSecondary},
  sheetEyebrow: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    letterSpacing: 0.88,
    marginTop: 18,
    marginBottom: 8,
  },
  removedCard: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  removedAuthorRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9},
  removedAuthorName: {fontSize: 13, fontWeight: '600', color: colors.textSecondary},
  statusTag: {borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8},
  statusTagText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.4},
  removedSnippet: {fontSize: 15, color: colors.textPrimary, lineHeight: 22.48, opacity: 0.85},
  removedViewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 11,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  removedViewText: {color: colors.accent, fontSize: 12.5, fontWeight: '600'},
  reasonText: {fontSize: 14.5, color: colors.textSecondary, lineHeight: 22.48},
  modCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 16,
    paddingVertical: 11,
    paddingHorizontal: 13,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
  },
  modCardName: {fontSize: 13.5, fontWeight: '600', color: colors.textPrimary},
  modCardSub: {fontSize: 11.5, color: colors.textMuted},
  restoreBtn: {color: colors.accent, fontSize: 12.5, fontWeight: '600'},
  sheetFooter: {marginTop: 14, fontSize: 12, color: colors.textMuted, lineHeight: 18},
});

/**
 * YourEventsScreen — the organizer's "Your events" list (design handoff `org-06`,
 * EventsOrganizer.dc.html `showList` section; REDLINES.md §3).
 *
 * Full-screen content — the host mounts this inside a Modal (see EVENTS_BUILD_CONTRACT.md);
 * this component does NOT render its own Modal. Pure VM + callbacks: no runtime imports.
 *
 * Groups, top to bottom: a full-width "＋ New event" CTA, then three optional sections —
 * UPCOMING (→ Manage), DRAFT (dashed rows → Edit), PAST (dimmed, static "Recap" chip, no
 * onPress this round). A section and its eyebrow are omitted entirely when its list is empty
 * (the DC's list markup only shows the populated-mock state; no explicit empty-section
 * conditional was found in EventsOrganizer.dc.html, so we default to the standard "never
 * render an empty section" rule stated for the editor in STATES.md §7).
 *
 * Rows carry optional `month`/`day` (real date tile), `interestedCount`/`attendingCount` (the
 * "★ N interested · N going" second line) and `locationLabel` (📍 meta segment) per the DC row;
 * when a field is absent the tile falls back to the design system's "unknown-date" glyph (🗓️,
 * the EventCard TBD-tile glyph per REDLINES §1.3) and the extra segments are omitted.
 */
import React from 'react';
import {SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, space, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import type {DraftRowVM, PastRowVM, UpcomingRowVM, YourEventsProps} from '../types';

export function YourEventsScreen(props: YourEventsProps): React.JSX.Element {
  const {upcoming, drafts, past, onNew, onOpenManage, onEditDraft, onBack} = props;

  return (
    <SafeAreaView style={s.page}>
      <View style={s.header}>
        <Press
          accessibilityLabel="Back"
          onPress={onBack}
          hitSlop={10}
          style={s.backBtn}>
          <Text style={s.backGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ‹
          </Text>
        </Press>
        <Text style={s.title} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          Your events
        </Text>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}>
        <Press
          accessibilityLabel="New event"
          onPress={onNew}
          style={s.newBtn}
          pressedStyle={s.pressed}>
          <Text style={s.newBtnGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ＋
          </Text>
          <Text style={s.newBtnText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            New event
          </Text>
        </Press>

        {upcoming.length > 0 ? (
          <View style={s.section}>
            <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              UPCOMING
            </Text>
            <View style={s.rowsGap}>
              {upcoming.map(row => (
                <UpcomingRowItem key={row.id} row={row} onPress={() => onOpenManage(row.id)} />
              ))}
            </View>
          </View>
        ) : null}

        {drafts.length > 0 ? (
          <View style={s.section}>
            <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              DRAFT
            </Text>
            <View style={s.rowsGap}>
              {drafts.map(row => (
                <DraftRowItem key={row.id} row={row} onPress={() => onEditDraft(row.id)} />
              ))}
            </View>
          </View>
        ) : null}

        {past.length > 0 ? (
          <View style={s.section}>
            <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              PAST
            </Text>
            <View style={s.rowsGap}>
              {past.map(row => (
                <PastRowItem key={row.id} row={row} />
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

function RowDateTile({month, day, past}: {month?: string; day?: string; past?: boolean}): React.JSX.Element {
  const hasDate = !!month && !!day && month !== '—' && day !== '·';
  if (!hasDate) {
    return (
      <View style={[s.dateTile, s.dateTileEmpty]}>
        <Text style={past ? s.dateTileGlyphPast : s.dateTileGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          🗓️
        </Text>
      </View>
    );
  }
  return (
    <View style={s.dateTile}>
      <Text style={past ? s.dateTileMonthPast : s.dateTileMonth} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {month}
      </Text>
      <Text style={past ? s.dateTileDayPast : s.dateTileDay} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {day}
      </Text>
    </View>
  );
}

function UpcomingRowItem({row, onPress}: {row: UpcomingRowVM; onPress: () => void}): React.JSX.Element {
  const title = row.title || 'Untitled event';
  return (
    <Press
      variant="row"
      onPress={onPress}
      style={s.upcomingRow}
      pressedStyle={s.pressed}>
      <RowDateTile month={row.month} day={row.day} />
      <View style={s.rowContent}>
        <Text
          style={[s.rowTitle, row.cancelled && s.rowTitleCancelled]}
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {title}
        </Text>
        <Text style={s.rowMeta} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          🕒 {row.whenLine}
          {row.locationLabel ? ` · 📍 ${row.locationLabel}` : ''}
        </Text>
        {row.interestedCount != null ? (
          <Text style={s.rowStats} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ★ {row.interestedCount} interested
            {row.attendingCount != null ? ` · ${row.attendingCount} going` : ''}
          </Text>
        ) : null}
        {row.cancelled ? (
          <Text style={s.rowCancelledNote} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            Cancelled — guests notified
          </Text>
        ) : null}
      </View>
      <View style={s.rightCol}>
        {row.newCount ? (
          <View style={s.badge}>
            <Text style={s.badgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {row.newCount} new
            </Text>
          </View>
        ) : null}
        <Text style={s.chevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          ›
        </Text>
      </View>
    </Press>
  );
}

function DraftRowItem({row, onPress}: {row: DraftRowVM; onPress: () => void}): React.JSX.Element {
  const title = row.title || 'Untitled event';
  return (
    <Press
      variant="row"
      accessibilityLabel={`Edit draft: ${title}`}
      onPress={onPress}
      style={s.draftRow}
      pressedStyle={s.pressed}>
      <View style={s.draftTile}>
        <Text style={s.draftTileGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          ✎
        </Text>
      </View>
      <View style={s.rowContent}>
        <Text style={s.draftTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {title}
        </Text>
        <Text style={s.draftSub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {row.subLine}
        </Text>
      </View>
      <View style={s.editChip}>
        <Text style={s.editChipText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          Edit
        </Text>
      </View>
    </Press>
  );
}

function PastRowItem({row}: {row: PastRowVM}): React.JSX.Element {
  const title = row.title || 'Untitled event';
  return (
    <View style={s.pastRow}>
      <RowDateTile month={row.month} day={row.day} past />
      <View style={s.rowContent}>
        <Text style={s.pastTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {title}
        </Text>
        <Text style={s.pastSub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {row.whenLine}
        </Text>
      </View>
      <Text style={s.recapText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        Recap
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Styles — REDLINES §0 (chrome) + §3 (Organizer — Your events)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {flex: 1, backgroundColor: colors.bg},
  pressed: {opacity: 0.85},

  // Back header — REDLINES §0.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    paddingHorizontal: space.sm,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {paddingVertical: 2, paddingHorizontal: space.sm},
  backGlyph: {fontSize: 24, lineHeight: 26, color: colors.accent, includeFontPadding: false},
  title: {flex: 1, textAlign: 'center', fontSize: 16, fontWeight: weight.bold, color: colors.textPrimary},
  headerSpacer: {width: 34},

  scroll: {flex: 1},
  scrollContent: {paddingTop: 14, paddingHorizontal: 14, paddingBottom: space.xl},

  // "＋ New event" CTA.
  newBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    marginBottom: 18,
  },
  // Fullwidth ＋ in its own Text with a pinned lineHeight — its taller CJK-font line box otherwise
  // pushes the latin label off the button's visual centre (PostCard vglyph idiom). gap stays 2:
  // the fullwidth glyph carries its own side bearings.
  newBtnGlyph: {fontSize: 15, lineHeight: 19, fontWeight: weight.semibold, color: colors.onAccent},
  newBtnText: {fontSize: 15, lineHeight: 19, fontWeight: weight.semibold, color: colors.onAccent},

  // Section eyebrow.
  section: {marginBottom: 18},
  eyebrow: {
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginHorizontal: 2,
    marginBottom: 9,
  },
  rowsGap: {gap: 10},

  // Shared row bits.
  rowContent: {flex: 1, minWidth: 0},
  rowTitle: {fontSize: 15.5, fontWeight: weight.bold, color: colors.textPrimary},
  rowTitleCancelled: {color: colors.textMuted, textDecorationLine: 'line-through'},
  rowMeta: {fontSize: 12.5, color: colors.textSecondary, marginTop: 3},
  rowCancelledNote: {fontSize: 12, color: colors.danger, fontWeight: weight.semibold, marginTop: 5},
  chevron: {fontSize: 18, lineHeight: 20, color: colors.textMuted},

  // Date tile (Upcoming + Past) — w46, radius10, two-tone: month band over day number (the same
  // chip EventCard/ManageScreen draw); glyph stands in for the missing month/day data.
  dateTile: {
    width: 46,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    alignItems: 'center',
  },
  dateTileEmpty: {justifyContent: 'center', paddingVertical: 13},
  dateTileGlyph: {fontSize: 20, color: colors.accent},
  dateTileGlyphPast: {fontSize: 20, color: colors.textMuted},
  dateTileMonth: {
    width: '100%',
    textAlign: 'center',
    fontSize: 10,
    fontWeight: weight.bold,
    letterSpacing: 0.6,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingVertical: 3,
  },
  dateTileDay: {fontSize: 19, fontWeight: weight.bold, lineHeight: 20, color: colors.textPrimary, paddingTop: 6, paddingBottom: 7},
  dateTileMonthPast: {
    width: '100%',
    textAlign: 'center',
    fontSize: 10,
    fontWeight: weight.bold,
    letterSpacing: 0.6,
    color: colors.textMuted,
    backgroundColor: colors.surface,
    paddingVertical: 3,
  },
  dateTileDayPast: {fontSize: 19, fontWeight: weight.bold, lineHeight: 20, color: colors.textSecondary, paddingTop: 6, paddingBottom: 7},
  rowStats: {fontSize: 12, color: colors.textMuted, marginTop: 5},

  // Upcoming row.
  upcomingRow: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 13,
  },
  rightCol: {alignItems: 'flex-end', gap: space.sm},
  badge: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: space.sm},
  badgeText: {fontSize: 10.5, fontWeight: weight.bold, color: colors.onAccent},

  // Draft row — dashed, → onEditDraft. Whole row is the tap target (bigger hit area than the
  // DC's Edit-chip-only click; the chip is rendered as a static affordance inside the row).
  draftRow: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    borderRadius: radius.lg,
    padding: 13,
  },
  draftTile: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftTileGlyph: {fontSize: 17, color: colors.textMuted},
  draftTitle: {fontSize: 15.5, fontWeight: weight.semibold, color: colors.textPrimary},
  draftSub: {fontSize: 12.5, color: colors.textMuted, marginTop: 3},
  editChip: {backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingVertical: 7, paddingHorizontal: 13},
  editChipText: {fontSize: 12.5, fontWeight: weight.semibold, color: colors.accent},

  // Past row — dimmed, static Recap (no onPress this round).
  pastRow: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 13,
    opacity: 0.7,
  },
  pastTitle: {fontSize: 15, fontWeight: weight.semibold, color: colors.textSecondary},
  pastSub: {fontSize: 12.5, color: colors.textMuted, marginTop: 3},
  recapText: {fontSize: 12.5, fontWeight: weight.semibold, color: colors.textSecondary},
});

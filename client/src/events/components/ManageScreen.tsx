/**
 * ManageScreen — the organizer's Manage dashboard (A7).
 *
 * Full-screen content (the host wraps it in a Modal — this component does NOT Modal-wrap itself).
 * Ported pixel-for-pixel from EventsOrganizer.dc.html (screen==='manage', lines 358–468) + the
 * app-card / stat-strip / tabs / going+waitlist / settings markup, with the two bottom sheets
 * (CancelSheet, MessageSheet) rendered as always-mounted siblings whose open/close this screen owns.
 *
 * Pure VM + callbacks: it renders `vm` and calls `cb`. Approve/Decline/Undo flow OUT through the
 * callbacks and come BACK through `vm.applications[].decision` — there is no local decision state.
 * Tokens from ui/theme; icons are emoji; confirmations are inline swaps; copy is verbatim COPY.md.
 */
import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors} from '../../ui/theme';
import {GradientDot} from '../../ui/GradientDot';
import {decodeGradient, type GradientSpec} from '../../media/gradient';
import {fmtWhenFromIso} from '../format';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import type {ManageCallbacks, ManageVM, ManagedApplication, ManagedGuest, Waitlister} from '../types';
import {CancelSheet, MessageSheet} from './ManageSheets';

type ManageTab = 'apps' | 'going' | 'settings';
const TAB_LABELS: Record<ManageTab, string> = {apps: 'Applications', going: 'Going', settings: 'Settings'};

/** Wire-string grads decode to a spec; specs pass through (GradientDot falls back to the seed). */
function toSpec(grad: GradientSpec | string): GradientSpec | undefined {
  return typeof grad === 'string' ? decodeGradient(grad) : grad;
}
/** The one list-row npub form used across the app's chips (util/npub, lead 8 · tail 3). */
function shortN(npub: string): string {
  return shortenNpub(safeNpubEncode(npub), {lead: 8, tail: 3});
}

export function ManageScreen({vm, cb}: {vm: ManageVM; cb: ManageCallbacks}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ManageTab>('apps');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [msgOpen, setMsgOpen] = useState(false);
  const [csvDone, setCsvDone] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);

  const tile = fmtWhenFromIso(vm.event.startsAt, vm.event.tz);
  const groupLabel = vm.event.autoAdd?.label;

  // Summary meta = when-line + a type-glyphed location suffix (DC: "… CET · 📍 Neukölln").
  const {type: eventType, location} = vm.event;
  const locGlyph = eventType === 'online' ? '📡' : eventType === 'ama' ? '💬' : '📍';
  const locText = location.area || location.channel || '';
  const summaryMeta = vm.whenLine + (locText ? ` · ${locGlyph} ${locText}` : '');

  // Going-tab section label: "16 going · 30 capacity" (drop capacity for the no-cap "count" mode).
  const cap = vm.event.capacityMode === 'limit' ? vm.event.capacity : undefined;
  const goingCapLabel = cap != null ? `${vm.stats.going} going · ${cap} capacity` : `${vm.stats.going} going`;

  // Empty state fires when nothing is pending — matches the DC's noPending (covers the empty list too).
  const pendingCount = vm.applications.reduce((n, a) => n + (a.decision === null ? 1 : 0), 0);

  const onExport = async (): Promise<void> => {
    if (csvBusy || csvDone) return;
    setCsvBusy(true);
    try {
      const ok = await cb.onExportCsv();
      if (ok) setCsvDone(true);
    } finally {
      setCsvBusy(false);
    }
  };

  const renderApp = (a: ManagedApplication): React.JSX.Element => {
    const approved = a.decision === 'approved';
    const declined = a.decision === 'declined';
    return (
      <View key={a.id} style={s.appCard}>
        <View style={s.appHead}>
          <GradientDot size={34} gradient={toSpec(a.applicant.grad)} seed={a.applicant.npub} />
          <View style={s.appHeadText}>
            <Text style={s.appName} numberOfLines={1}>{a.applicant.name}</Text>
            <Text style={s.appNpub} numberOfLines={1}>{shortN(a.applicant.npub)}</Text>
          </View>
          <Text style={s.appWhen}>{a.timeLabel}</Text>
        </View>
        {a.note ? (
          <View style={s.appNote}>
            <Text style={s.appNoteText}>{a.note}</Text>
          </View>
        ) : null}
        {approved ? (
          <View style={s.approvedRow}>
            <Text style={s.approvedCheck}>✓</Text>
            <Text style={s.approvedText}>
              {groupLabel ? `Approved · address sent · added to ${groupLabel}` : 'Approved · address sent'}
            </Text>
            <Press onPress={() => cb.onUndo(a.id)} accessibilityLabel="Undo">
              <Text style={s.undo}>Undo</Text>
            </Press>
          </View>
        ) : declined ? (
          <View style={s.declinedRow}>
            <Text style={s.declinedText}>Declined · notified without details</Text>
            <Press onPress={() => cb.onUndo(a.id)} accessibilityLabel="Undo">
              <Text style={s.undo}>Undo</Text>
            </Press>
          </View>
        ) : (
          <View style={s.appActions}>
            <Press
              style={s.approveBtn}
              onPress={() => cb.onApprove(a.id)}
              accessibilityLabel={`Approve ${a.applicant.name}`}>
              <Text style={s.approveText}>Approve</Text>
            </Press>
            <Press
              style={s.declineBtn}
              onPress={() => cb.onDecline(a.id)}
              accessibilityLabel={`Decline ${a.applicant.name}`}>
              <Text style={s.declineText}>Decline</Text>
            </Press>
          </View>
        )}
      </View>
    );
  };

  const renderGuest = (g: ManagedGuest): React.JSX.Element => (
    <View key={g.who.npub} style={s.guestRow}>
      <GradientDot size={32} gradient={toSpec(g.who.grad)} seed={g.who.npub} />
      <View style={s.guestText}>
        <Text style={s.guestName} numberOfLines={1}>{g.who.name}</Text>
        <Text style={s.guestNpub} numberOfLines={1}>{shortN(g.who.npub)}</Text>
      </View>
      {g.sinceLabel ? <Text style={s.guestWhen}>{g.sinceLabel}</Text> : null}
    </View>
  );

  const renderWaiter = (w: Waitlister): React.JSX.Element => (
    <View key={w.who.npub} style={s.waitRow}>
      <GradientDot size={32} gradient={toSpec(w.who.grad)} seed={w.who.npub} />
      <View style={s.waitText}>
        <Text style={s.guestName} numberOfLines={1}>{w.who.name}</Text>
        <Text style={s.guestNpub} numberOfLines={1}>{shortN(w.who.npub)}</Text>
      </View>
      <Press
        style={s.offerBtn}
        onPress={() => cb.onOfferSpot(w.who.npub)}
        accessibilityLabel={`Offer a spot to ${w.who.name}`}>
        <Text style={s.offerText}>Offer spot</Text>
      </Press>
    </View>
  );

  return (
    <View style={s.root}>
      {/* Header: back → Your events, Preview ↗ = open the detail screen as a guest would see it. */}
      <View style={s.header}>
        <Press onPress={cb.onBack} accessibilityLabel="Back">
          <Text style={s.back}>‹ Your events</Text>
        </Press>
        <Press
          onPress={cb.onPreview}
          disabled={!cb.onPreview}
          accessibilityLabel="Preview as guest">
          <Text style={s.preview}>Preview ↗</Text>
        </Press>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollBody} showsVerticalScrollIndicator={false}>
        {/* Summary */}
        <View style={s.summary}>
          <View style={s.dateTile}>
            <Text style={s.dateMonth}>{tile.month}</Text>
            <Text style={s.dateDay}>{tile.day}</Text>
          </View>
          <View style={s.flex1}>
            <Text style={[s.summaryTitle, vm.cancelled && s.summaryTitleCancelled]} numberOfLines={1}>
              {vm.event.title || 'Untitled event'}
            </Text>
            <Text style={s.summaryMeta} numberOfLines={1}>{summaryMeta}</Text>
          </View>
        </View>

        {/* Stat strip */}
        <View style={s.stats}>
          <View style={s.stat}>
            <Text style={s.statNum}>{vm.stats.interested}</Text>
            <Text style={s.statLabel}>interested</Text>
          </View>
          <View style={s.stat}>
            <Text style={[s.statNum, s.statNumAccent]}>{vm.stats.pending}</Text>
            <Text style={s.statLabel}>pending</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statNum}>{vm.stats.going}</Text>
            <Text style={s.statLabel}>going</Text>
          </View>
          <View style={s.stat}>
            <Text style={s.statNum}>{vm.stats.waitlist}</Text>
            <Text style={s.statLabel}>waitlist</Text>
          </View>
        </View>

        {/* Tabs */}
        <View style={s.tabs}>
          {(Object.keys(TAB_LABELS) as ManageTab[]).map(t => {
            const active = activeTab === t;
            return (
              <Press
                key={t}
                onPress={() => setActiveTab(t)}
                style={[s.tab, active ? s.tabActive : s.tabInactive]}
                accessibilityRole="tab"
                accessibilityState={{selected: active}}>
                <Text style={[s.tabText, active ? s.tabTextActive : s.tabTextInactive]}>{TAB_LABELS[t]}</Text>
              </Press>
            );
          })}
        </View>

        {/* Applications */}
        {activeTab === 'apps' ? (
          <View style={s.tabBodyApps}>
            <Text style={s.appsIntro}>
              {'Approving sends the exact address'}
              {groupLabel ? (
                <Text>
                  {' and brings the guest into '}
                  <Text style={s.appsIntroStrong}>{groupLabel}</Text>
                </Text>
              ) : null}
              {'. Declining notifies them without any details.'}
            </Text>
            {vm.applications.map(renderApp)}
            {pendingCount === 0 ? <Text style={s.empty}>All caught up — no requests waiting.</Text> : null}
          </View>
        ) : null}

        {/* Going + waitlist */}
        {activeTab === 'going' ? (
          <View style={s.tabBody}>
            <View style={s.privacyNote}>
              <Text style={s.privacyGlyph}>🕶</Text>
              <Text style={s.privacyText}>
                Only you can see who’s going. Guests never see this list — they just see the count.
              </Text>
            </View>
            <Text style={s.sectionLabel}>{goingCapLabel}</Text>
            {vm.guests.map(renderGuest)}
            {vm.guestsMore > 0 ? <Text style={s.andMore}>and {vm.guestsMore} more</Text> : null}

            {vm.waitlist.length > 0 ? (
              <>
                <Text style={[s.sectionLabel, s.waitlistLabel]}>Waitlist · {vm.stats.waitlist}</Text>
                {vm.waitlist.map(renderWaiter)}
              </>
            ) : null}
          </View>
        ) : null}

        {/* Settings */}
        {activeTab === 'settings' ? (
          <View style={s.tabBodySettings}>
            {vm.cancelled ? (
              <View style={s.cancelledNotice}>
                <Text style={s.cancelledGlyph}>⚠️</Text>
                <Text style={s.cancelledText}>This event is cancelled. Everyone has been notified.</Text>
              </View>
            ) : null}
            <View style={s.settingsList}>
              <Press variant="row" style={s.setRow} onPress={cb.onEdit} accessibilityLabel="Edit event">
                <Text style={s.setGlyph}>✎</Text>
                <View style={s.flex1}>
                  <Text style={s.setTitle}>Edit event</Text>
                  <Text style={s.setSub}>Everyone going is notified of changes</Text>
                </View>
                <Text style={s.setChevron}>›</Text>
              </Press>

              <Press variant="row" style={s.setRow} onPress={() => setMsgOpen(true)} accessibilityLabel="Message everyone going">
                <Text style={s.setGlyph}>📣</Text>
                <View style={s.flex1}>
                  <Text style={s.setTitle}>Message everyone going</Text>
                  <Text style={s.setSub}>One update to all {vm.messageRecipients} guests</Text>
                </View>
                <Text style={s.setChevron}>›</Text>
              </Press>

              <Press
                variant="row"
                style={s.setRow}
                onPress={() => { void onExport(); }}
                disabled={csvBusy}
                accessibilityLabel="Export guest list as CSV (only you can do this)">
                <Text style={s.setGlyph}>⤓</Text>
                <View style={s.flex1}>
                  <Text style={s.setTitle}>Export guest list (.csv)</Text>
                  {csvDone ? (
                    <Text style={s.setSubDone}>Downloaded ✓</Text>
                  ) : (
                    <Text style={s.setSub}>Only you can do this</Text>
                  )}
                </View>
                <Text style={s.setChevron}>›</Text>
              </Press>

              <Press
                variant="row"
                style={[s.setRow, s.cancelRow]}
                onPress={vm.cancelled ? undefined : () => setCancelOpen(true)}
                disabled={vm.cancelled}
                accessibilityLabel="Cancel event">
                <Text style={s.setGlyph}>⚠️</Text>
                <View style={s.flex1}>
                  <Text style={s.cancelTitle}>Cancel event</Text>
                  <Text style={s.cancelSub}>Notifies everyone · can’t be undone</Text>
                </View>
              </Press>
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Always-mounted sheets — only `visible` toggles (Android RN 0.76 Modal law). */}
      <CancelSheet
        visible={cancelOpen}
        groupLabel={groupLabel}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => {
          cb.onCancelEvent();
          setCancelOpen(false);
        }}
      />
      <MessageSheet
        visible={msgOpen}
        recipients={vm.messageRecipients}
        onClose={() => setMsgOpen(false)}
        onSend={cb.onMessageAll}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex1: {flex: 1, minWidth: 0},
  scroll: {flex: 1},
  scrollBody: {paddingBottom: 12},

  // header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingRight: 12,
  },
  back: {color: colors.accent, fontSize: 14, fontWeight: '600', paddingHorizontal: 12, paddingTop: 11, paddingBottom: 10},
  preview: {color: colors.textSecondary, fontSize: 12.5, fontWeight: '600'},

  // summary
  summary: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12},
  dateTile: {
    width: 46,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
    alignItems: 'center',
  },
  dateMonth: {
    width: '100%',
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingVertical: 3,
  },
  dateDay: {fontSize: 19, fontWeight: '700', lineHeight: 20, color: colors.textPrimary, paddingTop: 6, paddingBottom: 7},
  summaryTitle: {fontSize: 17, fontWeight: '700', color: colors.textPrimary},
  summaryTitleCancelled: {textDecorationLine: 'line-through', color: colors.textMuted},
  summaryMeta: {fontSize: 12.5, color: colors.textSecondary, marginTop: 2},

  // stat strip
  stats: {flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 14},
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    paddingVertical: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  statNum: {fontSize: 20, fontWeight: '700', color: colors.textPrimary},
  statNumAccent: {color: colors.accent},
  statLabel: {fontSize: 10.5, color: colors.textMuted, marginTop: 2},

  // tabs (surface-alt segmented control, DC manage tabs)
  tabs: {flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 3, marginHorizontal: 16, marginBottom: 4},
  tab: {flex: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center'},
  tabActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 2,
  },
  tabInactive: {backgroundColor: 'transparent'},
  tabText: {fontSize: 12.5, fontWeight: '600'},
  tabTextActive: {color: colors.textPrimary},
  tabTextInactive: {color: colors.textSecondary},

  // tab bodies
  tabBody: {paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24},
  tabBodyApps: {paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24},
  tabBodySettings: {paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24},

  // applications
  appsIntro: {fontSize: 12, color: colors.textMuted, lineHeight: 18, marginBottom: 12},
  appsIntroStrong: {color: colors.textSecondary, fontWeight: '700'},
  appCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 13, marginBottom: 10},
  appHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  appHeadText: {flex: 1, minWidth: 0},
  appName: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary, lineHeight: 17},
  appNpub: {fontSize: 11, color: colors.link, fontFamily: 'monospace', lineHeight: 14},
  appWhen: {fontSize: 11.5, color: colors.textMuted},
  appNote: {
    marginTop: 9,
    paddingHorizontal: 11,
    paddingVertical: 8,
    backgroundColor: colors.surfaceAlt,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderLight,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  appNoteText: {fontSize: 13, color: colors.textSecondary, lineHeight: 19},
  appActions: {flexDirection: 'row', gap: 8, marginTop: 11},
  approveBtn: {flex: 1, backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 9, alignItems: 'center'},
  approveText: {color: colors.onAccent, fontSize: 13, fontWeight: '600'},
  declineBtn: {borderWidth: 1, borderColor: colors.borderLight, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 18, alignItems: 'center'},
  declineText: {color: colors.textSecondary, fontSize: 13, fontWeight: '600'},
  approvedRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 11, paddingHorizontal: 11, paddingVertical: 9, backgroundColor: colors.successBg, borderRadius: 9},
  approvedCheck: {fontSize: 13, color: colors.success},
  approvedText: {flex: 1, fontSize: 12.5, color: colors.success, fontWeight: '600'},
  declinedRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 11, paddingHorizontal: 11, paddingVertical: 9, backgroundColor: colors.surfaceAlt, borderRadius: 9},
  declinedText: {flex: 1, fontSize: 12.5, color: colors.textMuted},
  undo: {color: colors.textMuted, fontSize: 11.5, fontWeight: '600', textDecorationLine: 'underline'},
  empty: {textAlign: 'center', paddingVertical: 22, paddingHorizontal: 20, fontSize: 13, color: colors.textMuted},

  // going + waitlist
  privacyNote: {flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 14},
  privacyGlyph: {fontSize: 14},
  privacyText: {flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 19},
  sectionLabel: {fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 8},
  guestRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9, paddingHorizontal: 2, borderBottomWidth: 1, borderBottomColor: colors.border},
  guestText: {flex: 1, minWidth: 0},
  guestName: {fontSize: 14, fontWeight: '600', color: colors.textPrimary, lineHeight: 17},
  guestNpub: {fontSize: 11, color: colors.link, fontFamily: 'monospace', lineHeight: 14},
  guestWhen: {fontSize: 11.5, color: colors.textMuted},
  andMore: {fontSize: 12.5, color: colors.textMuted, textAlign: 'center', paddingTop: 12},
  waitlistLabel: {marginTop: 20},
  waitRow: {flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8},
  waitText: {flex: 1, minWidth: 0},
  offerBtn: {backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7},
  offerText: {color: colors.accent, fontSize: 12, fontWeight: '600'},

  // settings
  cancelledNotice: {flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: 'rgba(212,80,78,0.42)', borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 16},
  cancelledGlyph: {fontSize: 14},
  cancelledText: {flex: 1, fontSize: 13, color: colors.textPrimary, lineHeight: 20},
  settingsList: {gap: 9},
  setRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 13},
  setGlyph: {fontSize: 16, width: 20, textAlign: 'center'},
  setTitle: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary},
  setSub: {fontSize: 12, color: colors.textMuted, marginTop: 1},
  setSubDone: {fontSize: 12, color: colors.success, marginTop: 1},
  setChevron: {color: colors.textMuted, fontSize: 17},
  cancelRow: {backgroundColor: colors.dangerBg, borderColor: 'rgba(212,80,78,0.32)'},
  rowDisabled: {opacity: 0.5},
  cancelTitle: {fontSize: 14.5, fontWeight: '600', color: colors.danger},
  cancelSub: {fontSize: 12, color: colors.textSecondary, marginTop: 1},
});

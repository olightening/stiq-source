/**
 * EventDetailHost — mounts the viewer's event experience: the EventDetailScreen (pure VM
 * component) inside an always-mounted Modal, plus its sibling sheets (Apply / Share / Forward)
 * and every effectful wire: RSVP actions via {@link EventsApi}, reminders (events/reminders.ts),
 * the real .ics download (format.buildIcs → util/fileExport), Add to embeds (bookmarks the
 * self-contained stiq:event token into the saved-embeds picker every composer offers), the map
 * hand-off, and the Forward real-send picker.
 *
 * MainScreen owns `coordinate` (which event is open); everything else is host-internal.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Linking, Modal, Platform, ScrollView, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {Press} from '../../ui/Press';
import {colors, radius, weight} from '../../ui/theme';
import {GradientDot} from '../../ui/GradientDot';
import {SwipeBackView} from '../../ui/SwipeBack';
import type {GradientSpec} from '../../media/gradient';
import {openLinkDialog} from '../../ui/openLink';
import {saveEventEmbed} from '../../channels/savedEmbeds';
import type {EventsApi} from '../api';
import {degradedEventFrom, detailEventFrom} from '../detailVm';
import type {EventRef} from '../eventEmbed';
import {EventDetailScreen} from './EventDetailScreen';
import {ApplySheet, ShareSheet} from './EventSheets';
import {buildIcs} from '../format';
import {saveTextFile, sanitizeFileName} from '../../util/fileExport';
import {
  cancelEventReminder,
  getReminder,
  rescheduleEventReminder,
  scheduleEventReminder,
} from '../reminders';
import type {EventDetailVM, ReminderState, ReminderUnit} from '../types';

export function EventDetailHost({
  api,
  coordinate,
  eventRef,
  onClose,
  onOpenPeer,
}: {
  api: EventsApi;
  /** The open event's 31923 coordinate, or null when the overlay is hidden. */
  coordinate: string | null;
  /** The decoded `stiq:event:` token, when this open came from one (embed tap / forward) — lets the
   * screen render a real (degraded) VM immediately instead of the bare skeleton while api.doc()'s
   * lazy fetch is still in flight. Null for a raw-coordinate open (reminder tap, organizer preview)
   * that never had a token, and once the real doc has landed (see the `doc ??` fallback below). */
  eventRef?: EventRef | null;
  onClose: () => void;
  /** Open a DM with the host (MainScreen closes this overlay first — the DM view is in-tree). */
  onOpenPeer: (pubkey: string) => void;
}): React.JSX.Element {
  const [applyOpen, setApplyOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [calAdded, setCalAdded] = useState(false);
  const [reminder, setReminder] = useState<ReminderState>({set: false, n: 2, unit: 'hours'});
  const [sentTo, setSentTo] = useState<string | null>(null); // forward inline ✓ (target id)
  // Force a re-read after an async action lands (api reads are synchronous snapshots).
  const [, setTick] = useState(0);
  const bump = (): void => setTick(t => t + 1);

  const visible = coordinate != null;
  // Heavy subtree lazy-latch: never constructed until the first open; stays mounted after.
  const mounted = useRef(false);
  mounted.current ||= visible;

  // Per-open reset + reminder hydration (records persist per coordinate).
  useEffect(() => {
    if (!coordinate) return;
    setApplyOpen(false);
    setShareOpen(false);
    setForwardOpen(false);
    setCalAdded(false);
    setSentTo(null);
    setReminder({set: false, n: 2, unit: 'hours'});
    let alive = true;
    void getReminder(coordinate).then(r => {
      if (alive && r) setReminder({set: true, n: r.n, unit: r.unit});
    });
    return () => {
      alive = false;
    };
  }, [coordinate]);

  const doc = coordinate ? api.doc(coordinate) : null;
  const live = coordinate ? api.live(coordinate) : null;
  const rsvp = coordinate ? api.myRsvp(coordinate) : null;
  // Only trust the ref while it actually describes the currently-open coordinate — guards a stale
  // prop surviving one render past a coordinate change.
  const ref = coordinate && eventRef && eventRef.coordinate === coordinate ? eventRef : null;

  let vm: EventDetailVM | null = null;
  // True once the doc has landed — everything below this stays real until then.
  let degraded = false;
  if (coordinate && (doc || ref)) {
    const {event, showSpots} = doc
      ? detailEventFrom(doc, live, Math.floor(Date.now() / 1000))
      : degradedEventFrom(ref!, live, Math.floor(Date.now() / 1000));
    vm = {
      event,
      rsvp: rsvp?.state ?? null,
      waitlistPosition: rsvp?.pos,
      reveal: rsvp?.state === 'approved' ? rsvp.reveal ?? null : null,
      reminder,
      calAdded,
      viewer: api.viewerIdentity(),
      showSpots,
    };
    if (rsvp?.autoAddLabel && !vm.event.autoAdd) {
      vm.event.autoAdd = {target: 'group', label: rsvp.autoAddLabel};
    }
    degraded = !doc;
  }

  const setReminderFor = async (n: number, unit: ReminderUnit): Promise<void> => {
    if (!coordinate || !vm) return;
    const input = {
      coordinate,
      title: vm.event.title,
      startsAtIso: vm.event.startsAt,
      n,
      unit,
    };
    const ok = reminder.set
      ? await rescheduleEventReminder(input)
      : await scheduleEventReminder(input);
    if (ok) setReminder({set: true, n, unit});
  };

  const addToCalendar = async (): Promise<boolean> => {
    if (!coordinate || !vm) return false;
    const ics = buildIcs({
      id: coordinate,
      title: vm.event.title,
      startsAt: vm.event.startsAt || undefined,
      endsAt: vm.event.endsAt,
      area: vm.event.location.area,
      description: vm.event.description,
    });
    const ok = await saveTextFile(`${sanitizeFileName(vm.event.title || 'stiq-event')}.ics`, 'text/calendar', ics);
    if (ok) setCalAdded(true);
    return ok;
  };

  // Bookmark the card into the saved-embeds list — every composer's 🔖 Embed picker then offers
  // it, and inserting it drops the self-contained live token into that draft.
  const addToEmbeds = (): void => {
    if (!coordinate) return;
    const token = api.token(coordinate);
    if (token) {
      void saveEventEmbed(
        {coordinate, token, title: api.doc(coordinate)?.public.title},
        Math.floor(Date.now() / 1000),
      ).catch(() => {});
    }
  };

  const targets = forwardOpen ? api.forwardTargets() : {channels: [], groups: [], peers: []};

  const forward = async (
    target: {kind: 'channel'; id: string} | {kind: 'group'; id: string} | {kind: 'dm'; pubkey: string},
  ): Promise<void> => {
    if (!coordinate || !vm) return;
    const token = api.token(coordinate);
    if (!token) return;
    const text = `📅 ${vm.event.title}\n${token}`;
    const key = target.kind === 'dm' ? target.pubkey : target.id;
    await api.forwardTo(target, text);
    setSentTo(key);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {mounted.current && (
        <View style={s.root}>
          {/* Opaque Modal: this View (colors.bg) is the backdrop and stays put; SwipeBackView wraps
              its children so the drag translates the actual content, revealing this same bg beneath
              — no window transparency surgery needed. `onBack` is `onClose`, the SAME identifier the
              header ‹ (EventDetailScreen's `cb.onBack`) and the loading-state back Press both already
              call, so button, hardware BACK and swipe can never drift apart. */}
          <SwipeBackView onBack={onClose}>
            {vm ? (
              <EventDetailScreen
                vm={vm}
                banner={degraded ? 'Fetching full details…' : undefined}
                cb={{
                  onToggleInterested: () => {
                    if (coordinate) void api.toggleInterested(coordinate).then(bump);
                  },
                  onApplyPress: () => setApplyOpen(true),
                  onSharePress: () => setShareOpen(true),
                  onApply: note => {
                    if (coordinate) void api.apply(coordinate, note).then(bump);
                    setApplyOpen(false);
                  },
                  onWithdraw: () => {
                    if (coordinate) {
                      void api.withdraw(coordinate).then(bump);
                      void cancelEventReminder(coordinate);
                      setReminder({set: false, n: 2, unit: 'hours'});
                    }
                  },
                  onJoinWaitlist: () => {
                    if (coordinate) void api.joinWaitlist(coordinate).then(bump);
                  },
                  onLeaveWaitlist: () => {
                    if (coordinate) void api.leaveWaitlist(coordinate).then(bump);
                  },
                  onSetReminder: (n, unit) => {
                    void setReminderFor(n, unit);
                  },
                  onAddToCalendar: addToCalendar,
                  onAddToEmbeds: addToEmbeds,
                  onForward: () => {
                    setShareOpen(false);
                    setForwardOpen(true);
                  },
                  onOpenSource: vm.event.externalLink
                    ? () => openLinkDialog({url: vm!.event.externalLink!, title: vm!.event.title})
                    : undefined,
                  onOpenMap: () => {
                    const addr = rsvp?.reveal?.exactAddress;
                    if (!addr) return;
                    const q = encodeURIComponent(addr);
                    // `geo:` is Android-only — iOS has no handler for it, so route to Apple Maps there.
                    // Swallow rejection so an unresolvable handler never surfaces as an unhandled rejection.
                    const url = Platform.OS === 'ios' ? `http://maps.apple.com/?q=${q}` : `geo:0,0?q=${q}`;
                    void Linking.openURL(url).catch(() => {});
                  },
                  onCopyAddress: () => {
                    const addr = rsvp?.reveal?.exactAddress;
                    if (addr) Clipboard.setString(addr);
                  },
                  onMessageHost: () => {
                    const host = doc?.addr.pubkey ?? ref?.addr.pubkey;
                    onClose();
                    if (host) onOpenPeer(host);
                  },
                  onBack: onClose,
                }}
              />
            ) : (
              // The doc hasn't resolved yet (opened from a bare embed) — api.doc() already issued the
              // lazy by-coordinate fetch; render the skeleton until the store snapshot lands.
              <View style={s.loading}>
                <Press onPress={onClose} hitSlop={10} accessibilityLabel="Back">
                  <Text style={s.loadingBack}>‹</Text>
                </Press>
                <View style={s.loadingBody}>
                  <Text style={s.loadingGlyph}>📅</Text>
                  <Text style={s.loadingText}>Fetching event…</Text>
                </View>
              </View>
            )}

            <ApplySheet
              visible={applyOpen}
              onClose={() => setApplyOpen(false)}
              onSend={note => {
                if (coordinate) void api.apply(coordinate, note).then(bump);
                setApplyOpen(false);
              }}
              hostName={vm?.event.host.name}
              autoAddLabel={vm?.event.autoAdd?.label}
            />
            <ShareSheet
              visible={shareOpen}
              onClose={() => setShareOpen(false)}
              onAddToEmbeds={addToEmbeds}
              onForward={() => {
                setShareOpen(false);
                setForwardOpen(true);
              }}
            />

            {/* Forward — a REAL send: one tap posts the card into a channel or DM (inline ✓). */}
            <Modal visible={forwardOpen} transparent animationType="fade" onRequestClose={() => setForwardOpen(false)}>
              <Press variant="bare" style={s.scrim} onPress={() => setForwardOpen(false)} accessibilityRole="none">
                <Press variant="bare" style={s.fwdCard} onPress={() => {}} accessibilityRole="none">
                  <View style={s.grab} />
                  <Text style={s.fwdTitle}>Forward event</Text>
                  <Text style={s.fwdSub}>Sends the public card — never the guest list or exact address.</Text>
                  <ScrollView style={s.fwdList}>
                    {targets.channels.length > 0 && <Text style={s.fwdEyebrow}>CHANNELS</Text>}
                    {targets.channels.map(c => (
                      <Press key={c.id} variant="row" style={s.fwdRow} onPress={() => void forward({kind: 'channel', id: c.id})}>
                        <Text style={s.fwdRowGlyph}>#</Text>
                        <Text style={s.fwdRowLabel} numberOfLines={1}>
                          {c.label}
                        </Text>
                        {sentTo === c.id ? <Text style={s.fwdSent}>✓ Sent</Text> : <Text style={s.fwdGo}>➦</Text>}
                      </Press>
                    ))}
                    {targets.groups.length > 0 && <Text style={s.fwdEyebrow}>GROUPS</Text>}
                    {targets.groups.map(g => (
                      <Press key={g.id} variant="row" style={s.fwdRow} onPress={() => void forward({kind: 'group', id: g.id})}>
                        <Text style={s.fwdRowGlyph}>⬡</Text>
                        <Text style={s.fwdRowLabel} numberOfLines={1}>
                          {g.label}
                        </Text>
                        {sentTo === g.id ? <Text style={s.fwdSent}>✓ Sent</Text> : <Text style={s.fwdGo}>➦</Text>}
                      </Press>
                    ))}
                    {targets.peers.length > 0 && <Text style={s.fwdEyebrow}>MESSAGES</Text>}
                    {targets.peers.map(p => (
                      <Press key={p.pubkey} variant="row" style={s.fwdRow} onPress={() => void forward({kind: 'dm', pubkey: p.pubkey})}>
                        <GradientDot gradient={p.grad as GradientSpec | undefined} seed={p.pubkey} size={22} />
                        <Text style={s.fwdRowLabel} numberOfLines={1}>
                          {p.name}
                        </Text>
                        {sentTo === p.pubkey ? <Text style={s.fwdSent}>✓ Sent</Text> : <Text style={s.fwdGo}>➦</Text>}
                      </Press>
                    ))}
                    {targets.channels.length === 0 && targets.groups.length === 0 && targets.peers.length === 0 && (
                      <Text style={s.fwdEmpty}>No channels or conversations yet.</Text>
                    )}
                  </ScrollView>
                  <Press style={s.fwdDone} onPress={() => setForwardOpen(false)}>
                    <Text style={s.fwdDoneText}>Done</Text>
                  </Press>
                </Press>
              </Press>
            </Modal>
          </SwipeBackView>
        </View>
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  loading: {flex: 1, backgroundColor: colors.bg, paddingTop: 8, paddingHorizontal: 14},
  loadingBack: {fontSize: 24, color: colors.accent, paddingVertical: 4, paddingHorizontal: 6},
  loadingBody: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10},
  loadingGlyph: {fontSize: 34},
  loadingText: {color: colors.textSecondary, fontSize: 14},

  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  grab: {alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 12},
  fwdCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 20,
    maxHeight: '75%',
  },
  fwdTitle: {fontSize: 17, fontWeight: weight.bold, color: colors.textPrimary},
  fwdSub: {fontSize: 12.5, color: colors.textSecondary, marginTop: 4, marginBottom: 10},
  fwdList: {flexGrow: 0},
  fwdEyebrow: {
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.88,
    color: colors.textMuted,
    marginTop: 10,
    marginBottom: 6,
  },
  fwdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 8,
  },
  fwdRowGlyph: {fontSize: 15, color: colors.accent, fontWeight: weight.bold, width: 22, textAlign: 'center'},
  fwdRowLabel: {flex: 1, color: colors.textPrimary, fontSize: 14.5, fontWeight: weight.semibold},
  fwdGo: {color: colors.textMuted, fontSize: 15},
  fwdSent: {color: colors.success, fontSize: 12.5, fontWeight: weight.bold},
  fwdEmpty: {color: colors.textMuted, fontSize: 13, paddingVertical: 18, textAlign: 'center'},
  fwdDone: {alignItems: 'center', paddingVertical: 12, marginTop: 4},
  fwdDoneText: {color: colors.textSecondary, fontSize: 14.5, fontWeight: weight.semibold},
});

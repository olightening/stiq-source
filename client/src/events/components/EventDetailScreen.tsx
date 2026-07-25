/**
 * EventDetailScreen (agent A3) — the viewer's full event screen, pixel-for-pixel from
 * `design_handoff_events/design_files/EventDetail.dc.html` (+ REDLINES §2, COPY.md, STATES §1–2/§6–7,
 * A11Y.md, and the eight detail-*.png screenshots).
 *
 * PURE VM + callbacks: it renders {@link EventDetailVM} and calls {@link EventDetailCallbacks} — no
 * runtime / store / nostr / navigation imports (only react, react-native, react-native-svg, ui/*,
 * media/gradient, events/types|format, util/npub). The host wraps this in an always-mounted Modal and
 * renders the Apply/Share sheets (EventSheets.tsx, agent A4) as siblings; this screen only calls
 * `cb.onApplyPress()` / `cb.onSharePress()` and never imports a sheet.
 *
 * Privacy invariants held here (STATES §6 / A11Y): the exact address, entry notes and stream link are
 * rendered ONLY in the approved branch (`rsvp==='approved' && reveal`) — they are never in the tree
 * before approval. A cover image is never fetched before the viewer taps "Load image".
 *
 * Internal state is confined to what the contract permits: the reminder editor's working value + its
 * shown/editing flip, the cover-image "loaded" flag, and the transient .ics "pending" flag.
 */
import React, {useCallback, useState} from 'react';
import {
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {GradientDot} from '../../ui/GradientDot';
import {GradientRect} from '../../ui/GradientRect';
import {decodeGradient, type GradientSpec} from '../../media/gradient';
import {shortenNpub} from '../../util/npub';
import {recurLabel, reminderLabel} from '../format';
import {RichText} from '../../feed/components/RichText';
import type {EventDetailCallbacks, EventDetailVM, EventType, ReminderUnit} from '../types';

// ── constants ──────────────────────────────────────────────────────────────────

const COVER_H = 172;

/** Cover shown when a gradient cover carries no decodable spec — the DC's own blue→violet wash. */
const FALLBACK_COVER: GradientSpec = {type: 'linear', angle: 135, stops: ['#3b82f6', '#8b5cf6']};

/** Type chip (cover / inline) — glyph + label, verbatim from COPY.md → EventCard type chips. */
const TYPE_CHIP: Record<EventType, {icon: string; label: string}> = {
  inperson: {icon: '📍', label: 'In person'},
  online: {icon: '📡', label: 'Online'},
  hybrid: {icon: '🔀', label: 'Hybrid'},
  ama: {icon: '💬', label: 'Channel AMA'},
};

const UNITS: ReminderUnit[] = ['minutes', 'hours', 'days', 'weeks'];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── local date helpers (the detail's full weekday/month names aren't in format.ts) ───────────────

/** ISO date part → a local Date (parsed as wall-clock, tz-label-agnostic, matching format.fmtWhen). */
function parseDate(iso?: string): Date | null {
  if (!iso || iso.length < 10) return null;
  const p = iso.slice(0, 10).split('-');
  if (p.length !== 3) return null;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return isNaN(d.getTime()) ? null : d;
}

/** The wall-clock "HH:MM" out of an ISO datetime, or null when timeless (same slice as fmtWhenFromIso). */
function hhmm(iso?: string): string | null {
  if (!iso || iso.length < 16 || iso.charAt(10) !== 'T') return null;
  return iso.slice(11, 16);
}

/** "Saturday, November 8". */
function fullDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()] ?? ''}, ${MONTHS_FULL[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** "Nov 8". */
function monDay(d: Date): string {
  return `${MONTHS_ABBR[d.getMonth()] ?? ''} ${d.getDate()}`;
}

/** Next three occurrences of a recurring event, as "Nov 8 · Nov 15 · Nov 22". */
function recurDates(base: Date, recurrence: 'weekly' | 'monthly'): string {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(base);
    if (recurrence === 'weekly') d.setDate(d.getDate() + 7 * i);
    else d.setMonth(d.getMonth() + i);
    out.push(monDay(d));
  }
  return out.join(' · ');
}

/** A rectangular gradient cover. Delegates to the shared `ui/GradientRect` (onLayout-measured pixel
 * `<Svg>`) rather than a `width="100%"` root Svg, which is flaky on Android react-native-svg 15 and
 * only partially fills the cover. */
function CoverGradient({spec}: {spec: GradientSpec}): React.JSX.Element {
  return (
    <GradientRect gradient={spec} style={StyleSheet.absoluteFill} fallbackStops={FALLBACK_COVER.stops} />
  );
}

// ── screen ───────────────────────────────────────────────────────────────────────

export function EventDetailScreen({
  vm,
  cb,
  banner,
}: {
  vm: EventDetailVM;
  cb: EventDetailCallbacks;
  /** Optional degraded-state notice (EventDetailHost: opened from a token, full doc not landed
   * yet) — "Fetching full details…". Absent once the real doc resolves. */
  banner?: string;
}): React.JSX.Element {
  const {event, rsvp, reveal, reminder} = vm;
  const {host, location, cover, autoAdd} = event;

  const external = event.external;
  const cancelled = event.status === 'cancelled';
  const isFull = event.status === 'full';
  const recurring = event.recurrence !== 'none';
  const approved = rsvp === 'approved';

  // Internal state — confined to the three the contract permits.
  const [imageLoaded, setImageLoaded] = useState(false);
  const [icsPending, setIcsPending] = useState(false);
  const [editingReminder, setEditingReminder] = useState(false);
  const [remN, setRemN] = useState(() => String(reminder.n || 2));
  const [remUnit, setRemUnit] = useState<ReminderUnit>(reminder.unit || 'hours');

  const handleAddCal = useCallback(async (): Promise<void> => {
    if (icsPending || vm.calAdded) return;
    setIcsPending(true);
    try {
      await cb.onAddToCalendar();
    } finally {
      setIcsPending(false);
    }
  }, [cb, icsPending, vm.calAdded]);

  const handleSetReminder = (): void => {
    const n = Math.max(1, parseInt(remN || '1', 10) || 1);
    cb.onSetReminder(n, remUnit);
    setEditingReminder(false);
  };
  const handleEditReminder = (): void => {
    setRemN(String(reminder.n || 2));
    setRemUnit(reminder.unit || 'hours');
    setEditingReminder(true);
  };

  // ── derived strings ──
  const npubShort = shortenNpub(host.npub, {lead: 12, tail: 4, minLen: 16});
  const type = TYPE_CHIP[event.type];

  const startDate = parseDate(event.startsAt);
  const whenTitle = startDate ? fullDate(startDate) : 'Date to be announced';
  const t1 = hhmm(event.startsAt);
  const t2 = hhmm(event.endsAt);
  const timePart = t1 ? (t2 ? `${t1} – ${t2}` : t1) : '';
  const whenSub = [timePart, event.tz].filter(Boolean).join(' · ');
  const recurLine =
    recurring && startDate && event.recurrence !== 'none'
      ? `🔁 Repeats ${recurLabel(event.recurrence).toLowerCase()} · ${recurDates(startDate, event.recurrence)} …`
      : '';

  const hasCover = cover.mode === 'gradient' || cover.mode === 'image';
  const coverSpec =
    cover.mode === 'gradient'
      ? (typeof cover.gradient === 'string' ? decodeGradient(cover.gradient) : cover.gradient) ?? FALLBACK_COVER
      : FALLBACK_COVER;

  const hostGradSpec = typeof host.grad === 'string' ? decodeGradient(host.grad) : host.grad;

  // ── description / tag (auto-hidden when empty, STATES §7) ──
  const descTrim = (event.description ?? '').trim();
  const paragraphs = descTrim ? descTrim.split(/\n{2,}/).map(p => p.trim()).filter(Boolean) : [];
  const tagText = (event.tag ?? '').trim().replace(/^#/, '');

  // ── Where row: locked note text is by event type; private fields only in the approved branch ──
  const lockedNote =
    event.type === 'online'
      ? `The stream link is shared once ${host.name} approves you.`
      : event.type === 'hybrid'
      ? `The exact address and stream link are shared once ${host.name} approves you.`
      : `The exact address is shared once ${host.name} approves you.`;

  const hasArea = !!location.area;
  const whereChannel = location.kind === 'channel' ? location.channel : undefined;
  const showWhere = hasArea || location.kind === 'link' || !!whereChannel;
  const whereGlyph = location.kind === 'link' ? '📡' : location.kind === 'channel' ? '💬' : '📍';
  const whereTitle =
    location.kind === 'channel'
      ? whereChannel ?? ''
      : location.area || (location.kind === 'link' ? 'Online' : '');
  const areaSub = hasArea
    ? `Approximate area${location.approxRadiusKm ? ` · ~${location.approxRadiusKm} km radius` : ''}`
    : '';

  // ── build the hairline-separated facts rows (last row draws no divider) ──
  const factRows: {key: string; node: React.ReactNode}[] = [];

  factRows.push({
    key: 'when',
    node: (
      <>
        <Text style={s.factGlyph}>🕒</Text>
        <View style={s.factBody}>
          <Text style={s.factTitle}>{whenTitle}</Text>
          {!!whenSub && <Text style={s.factSub}>{whenSub}</Text>}
          {!!recurLine && <Text style={s.recurLine}>{recurLine}</Text>}
          <View style={s.calRow}>
            {vm.calAdded ? (
              <Text style={s.calAdded}>✓ Added — check your downloads</Text>
            ) : (
              <Press
                onPress={handleAddCal}
                disabled={icsPending}
                style={s.calBtn}
                accessibilityLabel="Add to calendar (downloads an .ics file)">
                <Text style={s.calBtnGlyph}>⤓</Text>
                <Text style={s.calBtnText}>Add to calendar (.ics)</Text>
              </Press>
            )}
          </View>
        </View>
      </>
    ),
  });

  if (showWhere) {
    factRows.push({
      key: 'where',
      node: (
        <>
          <Text style={s.factGlyph}>{whereGlyph}</Text>
          <View style={s.factBody}>
            {!!whereTitle && <Text style={s.factTitle}>{whereTitle}</Text>}
            {/* LOCKED (not approved) — public approximate info + the privacy note. No private fields. */}
            {!approved && location.kind !== 'channel' && (
              <>
                {!!areaSub && <Text style={s.factSub}>{areaSub}</Text>}
                <View style={s.lockBox}>
                  <Text style={s.lockGlyph}>🔒</Text>
                  <Text style={s.lockText}>{lockedNote}</Text>
                </View>
              </>
            )}
            {/* APPROVED — the private payload, rendered ONLY here (privacy invariant 2). */}
            {approved && reveal && (
              <>
                {!!reveal.exactAddress && <Text style={s.addressMono}>{reveal.exactAddress}</Text>}
                {!!reveal.entryNotes && <Text style={s.entryNotes}>{reveal.entryNotes}</Text>}
                {!!reveal.streamLink && (
                  <>
                    <Text style={s.streamLabel}>Stream / call link</Text>
                    <Text style={s.addressMono}>{reveal.streamLink}</Text>
                  </>
                )}
                {!!reveal.exactAddress && (
                  <View style={s.revealActions}>
                    <Press
                      onPress={() => cb.onCopyAddress?.()}
                      style={s.copyAddrChip}
                      accessibilityLabel="Copy address">
                      <Text style={s.copyAddrText}>Copy address</Text>
                    </Press>
                    <Press
                      onPress={() => cb.onOpenMap?.()}
                      style={s.openMapChip}
                      accessibilityLabel="Open map">
                      <Text style={s.openMapText}>Open map</Text>
                    </Press>
                  </View>
                )}
              </>
            )}
          </View>
        </>
      ),
    });
  }

  // Spots — hidden for external events (Stiq tracks no RSVPs there) and when the organizer hid
  // the attendee count (vm.showSpots === false; STATES §5 hide/auto-hide).
  if (!external && vm.showSpots !== false) {
    factRows.push({
      key: 'spots',
      node: (
        <>
          <Text style={s.factGlyph}>👥</Text>
          <View style={s.factBody}>
            {event.capacityMode === 'limit' ? (
              <>
                <View style={s.spotsHeadRow}>
                  <Text style={s.factTitle}>
                    {event.attendingCount} of {event.capacity ?? 0} spots
                  </Text>
                  {isFull && (
                    <View style={s.fullBadge}>
                      <Text style={s.fullBadgeText}>Full</Text>
                    </View>
                  )}
                </View>
                <View style={s.progressTrack}>
                  <View
                    style={[
                      s.progressFill,
                      {
                        width: `${
                          isFull
                            ? 100
                            : event.capacity && event.capacity > 0
                            ? Math.min(100, Math.round((event.attendingCount / event.capacity) * 100))
                            : 0
                        }%`,
                      },
                    ]}
                  />
                </View>
              </>
            ) : (
              <>
                <View style={s.countRow}>
                  <Text style={s.countNum}>{event.attendingCount}</Text>
                  <Text style={s.countGoing}>going</Text>
                </View>
                <Text style={s.countNote}>No limit — just tracking who’s coming.</Text>
              </>
            )}
            <Text style={s.privacyLine}>
              🕶 Who’s coming is private — only {host.name} sees the guest list.
            </Text>
          </View>
        </>
      ),
    });
  }

  // Access / auto-add policy (non-external) OR "Organized elsewhere" (external).
  if (external) {
    factRows.push({
      key: 'access-ext',
      node: (
        <>
          <Text style={s.factGlyph}>🔗</Text>
          <View style={s.factBody}>
            <Text style={s.factTitle}>Organized elsewhere</Text>
            <Text style={s.accessSub}>RSVPs and full details are handled by the organizer, not on Stiq.</Text>
            <Press
              onPress={() => cb.onOpenSource?.()}
              style={s.sourcePill}
              accessibilityLabel="Open event source">
              <Text style={s.sourcePillText}>Open event source ↗</Text>
            </Press>
          </View>
        </>
      ),
    });
  } else if (autoAdd) {
    factRows.push({
      key: 'access',
      node: (
        <>
          <Text style={s.factGlyph}>🔐</Text>
          <View style={s.factBody}>
            <Text style={s.factTitle}>Approved guests join a private group</Text>
            <Text style={s.accessSub}>
              Once you’re approved you’re added to the <Text style={s.accessStrong}>{autoAdd.label}</Text> group
              chat with everyone attending.
            </Text>
          </View>
        </>
      ),
    });
  }

  // ── action bar ──
  const showEditor = editingReminder || !reminder.set;

  return (
    <SafeAreaView style={s.screen}>
      {/* header */}
      <View style={s.header}>
        <Press onPress={cb.onBack} hitSlop={12} accessibilityLabel="Back">
          <Text style={s.back}>‹</Text>
        </Press>
        <Text style={s.headerTitle}>Event</Text>
        <Press
          onPress={cb.onSharePress}
          hitSlop={12}
          style={s.shareBtn}
          accessibilityLabel="Share this event">
          <Text style={s.share}>⤴</Text>
        </Press>
      </View>

      <ScrollView style={s.flex1} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* degraded-state notice — opened from a token before the full doc landed */}
        {banner && (
          <View style={s.bannerFetching}>
            <Text style={s.bannerGlyph}>⏳</Text>
            <Text style={s.bannerFetchingText}>{banner}</Text>
          </View>
        )}

        {/* cover */}
        {hasCover ? (
          <View style={s.cover}>
            {cover.mode === 'gradient' && <CoverGradient spec={coverSpec} />}
            {cover.mode === 'image' &&
              (imageLoaded ? (
                <Image
                  source={{uri: cover.image}}
                  style={StyleSheet.absoluteFill}
                  resizeMode="cover"
                  accessibilityLabel="Event cover image"
                />
              ) : (
                <Press
                  variant="row"
                  style={[StyleSheet.absoluteFill, s.coverHidden]}
                  onPress={() => setImageLoaded(true)}
                  accessibilityLabel="Load cover image (image is hidden until you tap, for privacy)">
                  <View style={s.loadPill}>
                    <Text style={s.loadPillText}>📷 Load image</Text>
                  </View>
                  <Text style={s.loadSub}>Hidden until you tap · privacy-safe</Text>
                </Press>
              ))}
            <View style={s.coverChips} pointerEvents="box-none">
              <View style={s.coverChip}>
                <Text style={s.coverChipText}>{type.icon} {type.label}</Text>
              </View>
              {recurring && (
                <View style={s.coverChip}>
                  <Text style={s.coverChipText}>🔁 {recurLabel(event.recurrence)}</Text>
                </View>
              )}
            </View>
          </View>
        ) : (
          // 'none' cover → a clean text-only header; the type/recurring chips move inline.
          <View style={s.inlineChips}>
            <View style={s.inlineChip}>
              <Text style={s.inlineChipText}>{type.icon} {type.label}</Text>
            </View>
            {recurring && (
              <View style={s.inlineChip}>
                <Text style={s.inlineChipText}>🔁 {recurLabel(event.recurrence)}</Text>
              </View>
            )}
          </View>
        )}

        {/* external banner */}
        {external && (
          <View style={s.bannerExternal}>
            <Text style={s.bannerGlyphExt}>↗</Text>
            <Text style={s.bannerTextExt}>
              <Text style={s.bold}>External event.</Text> {host.name} shared this — they’re not the organizer.
              Stiq isn’t handling RSVPs or the guest list; check the source for details.
            </Text>
          </View>
        )}

        {/* cancelled banner */}
        {cancelled && (
          <View style={s.bannerCancelled}>
            <Text style={s.bannerGlyph}>⚠️</Text>
            <Text style={s.bannerTextCancel}>
              This event was cancelled by the host. Everyone who applied has been notified.
            </Text>
          </View>
        )}

        {/* title + host */}
        <View style={s.titleWrap}>
          <Text style={s.title}>{event.title || 'Untitled event'}</Text>
          <View style={s.hostRow}>
            <GradientDot size={28} gradient={hostGradSpec ?? null} seed={host.npub} />
            <View style={s.hostCol}>
              <Text style={s.hostName} numberOfLines={1}>
                {host.name}
              </Text>
              <Text
                style={[s.hostNpub, external ? s.hostNpubExt : s.hostNpubHost]}
                numberOfLines={1}>
                {external ? `${npubShort} · shared this · not the organizer` : `${npubShort} · host`}
              </Text>
            </View>
            <Press
              onPress={() => cb.onMessageHost?.()}
              style={s.messageBtn}
              accessibilityLabel={`Message ${host.name}`}>
              <Text style={s.messageText}>Message</Text>
            </Press>
          </View>
        </View>

        {/* facts card */}
        <View style={s.factsCard}>
          {factRows.map((r, i) => (
            <View key={r.key} style={[s.factRow, i < factRows.length - 1 && s.factRowBorder]}>
              {r.node}
            </View>
          ))}
        </View>

        {/* about */}
        {paragraphs.length > 0 && (
          <View style={s.aboutWrap}>
            <Text style={s.aboutEyebrow}>ABOUT THIS EVENT</Text>
            {/* The description is authored in the app's main editor (RichEditor markdown) — render
                it through the same RichText pipeline messages use so styling survives. */}
            <RichText content={descTrim} style={s.aboutBody} paragraphSpacing={12} />
            {!!tagText && (
              <View style={s.tagRow}>
                <View style={s.tagChip}>
                  <Text style={s.tagChipText}>#{tagText}</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* action bar */}
      <View style={s.actionBar}>
        {cancelled ? (
          <View style={s.cancelledBar}>
            <Text style={s.cancelledBarText}>Event cancelled — no longer accepting guests</Text>
          </View>
        ) : external ? (
          <>
            <View style={s.barRow}>
              <Press
                onPress={cb.onToggleInterested}
                style={[s.interestedBtn, rsvp === 'interested' ? s.interestedActive : s.interestedInactive]}
                accessibilityState={{selected: rsvp === 'interested'}}
                accessibilityLabel="Interested">
                <Text style={[s.interestedText, rsvp === 'interested' ? s.interestedTextActive : s.interestedTextInactive]}>
                  {rsvp === 'interested' ? '★' : '☆'} Interested
                </Text>
              </Press>
              <Press
                onPress={() => cb.onOpenSource?.()}
                style={s.primaryBtn}
                accessibilityLabel="Open event source">
                <Text style={s.primaryBtnText}>Open event source ↗</Text>
              </Press>
            </View>
            <Text style={s.hint}>Stiq isn’t handling RSVPs for this one — mark interested to save it.</Text>
          </>
        ) : rsvp === 'applied' ? (
          <>
            <View style={s.appliedCard}>
              <Text style={s.appliedGlyph}>⏳</Text>
              <View style={s.flex1}>
                <Text style={s.cardTitle}>Application sent</Text>
                <Text style={s.cardSub}>{host.name} reviews requests. You’ll be notified here.</Text>
              </View>
              <Press
                onPress={cb.onWithdraw}
                accessibilityLabel="Withdraw application">
                <Text style={s.linkUnderline}>Withdraw</Text>
              </Press>
            </View>
            <Text style={s.hint}>You’re marked interested while you wait.</Text>
          </>
        ) : rsvp === 'approved' ? (
          <>
            <View style={s.approvedRow}>
              <View style={s.checkDot}>
                <Text style={s.checkDotText}>✓</Text>
              </View>
              <Text style={s.approvedText}>You’re in — see you there</Text>
              <View style={s.flex1} />
              {autoAdd && <Text style={s.addedTo}>added to {autoAdd.label}</Text>}
            </View>
            {showEditor ? (
              <>
                <View style={s.remControls}>
                  <Text style={s.remLabel}>🔔 Remind me</Text>
                  <TextInput
                    value={remN}
                    onChangeText={v => setRemN(v.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    maxLength={4}
                    style={s.remInput}
                    accessibilityLabel="Remind me, number"
                  />
                  {UNITS.map(u => (
                    <Press
                      key={u}
                      onPress={() => setRemUnit(u)}
                      style={[s.unitChip, remUnit === u && s.unitChipActive]}
                      hitSlop={{top: 8, bottom: 8, left: 3, right: 3}}
                      accessibilityState={{selected: remUnit === u}}
                      accessibilityLabel={`Remind me, unit: ${u}`}>
                      <Text style={[s.unitChipText, remUnit === u && s.unitChipTextActive]}>{u}</Text>
                    </Press>
                  ))}
                  <Text style={s.remBefore}>before</Text>
                </View>
                <Press
                  onPress={handleSetReminder}
                  style={s.setBtn}
                  accessibilityLabel="Set reminder">
                  <Text style={s.setBtnText}>Set</Text>
                </Press>
              </>
            ) : (
              <View style={s.remSetChip}>
                <Text style={s.remBell}>🔔</Text>
                <Text style={s.remSetText}>{reminderLabel(reminder.n, reminder.unit)}</Text>
                <Press
                  onPress={handleEditReminder}
                  accessibilityLabel="Edit reminder">
                  <Text style={s.remEdit}>Edit</Text>
                </Press>
              </View>
            )}
          </>
        ) : rsvp === 'waitlist' ? (
          <View style={s.waitlistCard}>
            <Text style={s.waitlistGlyph}>⊕</Text>
            <View style={s.flex1}>
              <Text style={s.cardTitle}>
                {vm.waitlistPosition ? `You’re #${vm.waitlistPosition} on the waitlist` : "You’re on the waitlist"}
              </Text>
              <Text style={s.cardSub}>We’ll notify you if a spot opens up.</Text>
            </View>
            <Press
              onPress={cb.onLeaveWaitlist}
              accessibilityLabel="Leave the waitlist">
              <Text style={s.linkUnderline}>Leave</Text>
            </Press>
          </View>
        ) : (
          // null / 'interested' → the active two-tier bar
          <>
            <View style={s.barRow}>
              <Press
                onPress={cb.onToggleInterested}
                style={[s.interestedBtn, rsvp === 'interested' ? s.interestedActive : s.interestedInactive]}
                accessibilityState={{selected: rsvp === 'interested'}}
                accessibilityLabel="Interested">
                <Text style={[s.interestedText, rsvp === 'interested' ? s.interestedTextActive : s.interestedTextInactive]}>
                  {rsvp === 'interested' ? '★' : '☆'} Interested
                </Text>
              </Press>
              {isFull ? (
                <Press
                  onPress={cb.onJoinWaitlist}
                  style={s.waitlistBtn}
                  accessibilityLabel="Join the waitlist">
                  <Text style={s.waitlistBtnText}>Join waitlist</Text>
                </Press>
              ) : (
                <Press
                  onPress={cb.onApplyPress}
                  style={s.primaryBtn}
                  accessibilityLabel="Apply to attend">
                  <Text style={s.primaryBtnText}>Apply to attend</Text>
                </Press>
              )}
            </View>
            <Text style={s.hint}>
              {isFull
                ? 'The room is full — join the waitlist and we’ll notify you.'
                : 'Applying marks you interested and sends a request the host reviews.'}
            </Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.bg},
  flex1: {flex: 1},
  bold: {fontWeight: '700', color: colors.textPrimary},
  dim: {opacity: 0.5},

  // header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    paddingBottom: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: {fontSize: 24, lineHeight: 26, color: colors.accent, paddingVertical: 2, paddingHorizontal: 8},
  headerTitle: {flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.textPrimary},
  shareBtn: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  share: {fontSize: 18, color: colors.textSecondary},

  scroll: {paddingBottom: 14},

  // cover
  cover: {height: COVER_H, position: 'relative', overflow: 'hidden', backgroundColor: colors.surfaceAlt},
  coverHidden: {alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.28)'},
  loadPill: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 15,
  },
  loadPillText: {color: colors.onAccent, fontSize: 13, fontWeight: '600'},
  loadSub: {color: 'rgba(255,255,255,0.82)', fontSize: 11, marginTop: 8},
  coverChips: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  coverChip: {backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: 10},
  coverChipText: {color: colors.onAccent, fontSize: 11.5, fontWeight: '600'},

  inlineChips: {flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16},
  inlineChip: {backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 9},
  inlineChipText: {color: colors.accent, fontSize: 11.5, fontWeight: '600'},

  // banners
  bannerExternal: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    marginTop: 14,
    marginHorizontal: 16,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentTint,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  bannerGlyphExt: {fontSize: 15, color: colors.textPrimary},
  bannerTextExt: {flex: 1, fontSize: 12.5, color: colors.textPrimary, lineHeight: 19},
  bannerCancelled: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    marginTop: 14,
    marginHorizontal: 16,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    // color-mix(danger 40%, border) — no token exists for this blend.
    borderColor: 'rgba(212,80,78,0.40)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  bannerGlyph: {fontSize: 15},
  bannerTextCancel: {flex: 1, fontSize: 13, color: colors.textPrimary, lineHeight: 20},
  bannerFetching: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'center',
    marginTop: 14,
    marginHorizontal: 16,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  bannerFetchingText: {flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18},

  // title + host
  titleWrap: {paddingTop: 16, paddingHorizontal: 16, paddingBottom: 4},
  title: {fontSize: 22, fontWeight: '700', lineHeight: 27, letterSpacing: -0.3, color: colors.textPrimary},
  hostRow: {flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13},
  hostCol: {flex: 1, minWidth: 0},
  hostName: {fontSize: 14, fontWeight: '600', color: colors.textPrimary},
  hostNpub: {fontSize: 11},
  hostNpubHost: {color: colors.link, fontFamily: fonts.mono},
  hostNpubExt: {color: colors.textMuted},
  messageBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  messageText: {fontSize: 12.5, fontWeight: '600', color: colors.accent},

  // facts card
  factsCard: {
    marginTop: 14,
    marginHorizontal: 16,
    marginBottom: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  factRow: {flexDirection: 'row', gap: 12, padding: 14},
  factRowBorder: {borderBottomWidth: 1, borderBottomColor: colors.border},
  factGlyph: {fontSize: 17, lineHeight: 22},
  factBody: {flex: 1, minWidth: 0},
  factTitle: {fontSize: 15, fontWeight: '600', color: colors.textPrimary},
  factSub: {fontSize: 13, color: colors.textSecondary, marginTop: 2},
  recurLine: {fontSize: 12, color: colors.textMuted, marginTop: 5, lineHeight: 17},

  calRow: {marginTop: 11, flexDirection: 'row'},
  calBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  // Glyph in its own Text with a pinned lineHeight — mixed-font glyphs otherwise inflate the
  // line box and shove the latin label off the button's visual centre (PostCard vglyph idiom).
  calBtnGlyph: {fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: colors.accent},
  calBtnText: {fontSize: 12.5, lineHeight: 16, fontWeight: '600', color: colors.accent},
  calAdded: {fontSize: 12.5, fontWeight: '600', color: colors.success},

  // where — locked
  lockBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 9,
    paddingVertical: 9,
    paddingHorizontal: 11,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 9,
  },
  lockGlyph: {fontSize: 13},
  lockText: {flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 18},
  // where — revealed (approved only)
  addressMono: {fontSize: 14, color: colors.textPrimary, marginTop: 4, fontFamily: fonts.mono},
  entryNotes: {fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 19},
  streamLabel: {fontSize: 11, color: colors.textMuted, marginTop: 8, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase'},
  revealActions: {flexDirection: 'row', gap: 8, marginTop: 10},
  copyAddrChip: {backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12},
  copyAddrText: {fontSize: 12, fontWeight: '600', color: colors.accent},
  openMapChip: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  openMapText: {fontSize: 12, fontWeight: '600', color: colors.textSecondary},

  // spots
  spotsHeadRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  fullBadge: {backgroundColor: colors.warningBg, borderRadius: radius.pill, paddingVertical: 2, paddingHorizontal: 7},
  fullBadgeText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: colors.warning},
  progressTrack: {height: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, marginTop: 9, overflow: 'hidden'},
  progressFill: {height: '100%', backgroundColor: colors.accent, borderRadius: radius.pill},
  countRow: {flexDirection: 'row', alignItems: 'baseline', gap: 8},
  countNum: {fontSize: 24, fontWeight: '700', color: colors.accent},
  countGoing: {fontSize: 14, fontWeight: '600', color: colors.textSecondary},
  countNote: {fontSize: 12.5, color: colors.textSecondary, marginTop: 4},
  privacyLine: {fontSize: 12, color: colors.textMuted, marginTop: 9, lineHeight: 18},

  // access
  accessSub: {fontSize: 12.5, color: colors.textSecondary, marginTop: 3, lineHeight: 19},
  accessStrong: {color: colors.textPrimary, fontWeight: '700'},
  sourcePill: {
    alignSelf: 'flex-start',
    marginTop: 9,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  sourcePillText: {fontSize: 12.5, fontWeight: '600', color: colors.accent},

  // about
  aboutWrap: {paddingTop: 18, paddingHorizontal: 16, paddingBottom: 6},
  aboutEyebrow: {fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.9, marginBottom: 8},
  aboutBody: {fontSize: 17, color: colors.textPrimary, lineHeight: 27},
  aboutBodyGap: {marginTop: 11},
  tagRow: {marginTop: 13, flexDirection: 'row'},
  tagChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  tagChipText: {fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono},

  // action bar
  actionBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  barRow: {flexDirection: 'row', gap: 9},
  hint: {fontSize: 11.5, color: colors.textMuted, textAlign: 'center', marginTop: 9, lineHeight: 16},

  interestedBtn: {borderRadius: radius.pill, paddingVertical: 12, paddingHorizontal: 15, borderWidth: 1},
  interestedActive: {backgroundColor: colors.accentSoft, borderColor: 'transparent'},
  interestedInactive: {backgroundColor: 'transparent', borderColor: colors.borderLight},
  interestedText: {fontSize: 14, fontWeight: '600'},
  interestedTextActive: {color: colors.accent},
  interestedTextInactive: {color: colors.textSecondary},

  primaryBtn: {flex: 1, backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 12, alignItems: 'center'},
  primaryBtnText: {fontSize: 14.5, fontWeight: '600', color: colors.onAccent},
  waitlistBtn: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.pill,
    paddingVertical: 12,
    alignItems: 'center',
  },
  waitlistBtnText: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary},

  // applied
  appliedCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    // color-mix(warning 35%, border) — no token exists for this blend.
    borderColor: 'rgba(201,162,39,0.35)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  appliedGlyph: {fontSize: 17},
  cardTitle: {fontSize: 13.5, fontWeight: '600', color: colors.textPrimary},
  cardSub: {fontSize: 12, color: colors.textSecondary, marginTop: 1, lineHeight: 17},
  linkUnderline: {fontSize: 12.5, fontWeight: '600', color: colors.textMuted, textDecorationLine: 'underline'},

  // waitlist
  waitlistCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  waitlistGlyph: {fontSize: 17, color: colors.textSecondary},

  // approved + reminder
  approvedRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 11},
  checkDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.successBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDotText: {color: colors.success, fontSize: 12, fontWeight: '700'},
  approvedText: {fontSize: 14, fontWeight: '700', color: colors.success},
  addedTo: {fontSize: 11.5, color: colors.textMuted},

  remControls: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7},
  remLabel: {fontSize: 13, color: colors.textSecondary},
  remInput: {
    width: 48,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    color: colors.textPrimary,
    fontSize: 14,
    textAlign: 'center',
  },
  unitChip: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  unitChipActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  unitChipText: {fontSize: 13, color: colors.textSecondary},
  unitChipTextActive: {color: colors.onAccent, fontWeight: '600'},
  remBefore: {fontSize: 13, color: colors.textSecondary},
  setBtn: {
    alignSelf: 'flex-end',
    marginTop: 8,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  setBtnText: {fontSize: 13, fontWeight: '600', color: colors.onAccent},
  remSetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  remBell: {fontSize: 14},
  remSetText: {flex: 1, fontSize: 13.5, color: colors.textPrimary},
  remEdit: {fontSize: 12.5, fontWeight: '600', color: colors.accent},

  // cancelled bar
  cancelledBar: {backgroundColor: colors.dangerBg, borderRadius: 12, paddingVertical: 13, alignItems: 'center'},
  cancelledBarText: {fontSize: 13, fontWeight: '600', color: colors.danger, textAlign: 'center'},
});

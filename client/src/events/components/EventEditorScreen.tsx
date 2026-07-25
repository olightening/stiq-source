/**
 * EventEditorScreen — the organizer's Create/Edit event builder (EventsOrganizer.dc.html create/edit
 * screen). A pure VM + callbacks component: it owns the DC's entire field state machine internally,
 * derives the live EventCard preview exactly per the DC's renderVals mapping (lines 714-742), and
 * hands the assembled {@link EventDraft} up on Publish / Save as draft / Add to embeds.
 *
 * Full-screen content only — the HOST wraps this in a Modal (do NOT Modal-wrap the screen). The
 * overlays it opens (CoverColorsSheet, the body-only ComposerScreen for the description, the
 * date/time/tz picker sheets, PictureComposer for the cover image) are always-mounted Modals per
 * the Android RN 0.76 Modal law.
 *
 * No runtime/store/nostr/navigation imports: tokens from ui/theme, gradient helpers from media/
 * gradient, when-derivation from events/format, the live card from ./EventCard. The description
 * editor is THE app's full post editor (feed/ComposerScreen in bodyOnly mode) and the cover image
 * flow is THE app's pixel-picture studio (feed/PictureComposer) — both pure components.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import type {GradientSpec} from '../../media/gradient';
import {colors} from '../../ui/theme';
import {fmtWhen, recurLabel} from '../format';
import type {
  AutoAddPolicy,
  CapacityMode,
  CoverMode,
  EventCardProps,
  EventDraft,
  EventEditorProps,
  EventLocation,
  EventType,
} from '../types';
import {EventCard} from './EventCard';
import {CoverColorsSheet, DEFAULT_COVER_GRADIENT, GradientRect, toGradientSpec} from './CoverColorsSheet';
import {DatePickerSheet, TimePickerSheet, OptionSheet} from './PickerSheets';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {labelInlineMedia} from '../../feed/inlineMedia';
import {PictureComposer} from '../../feed/components/PictureComposer';

type Recurrence = 'none' | 'weekly' | 'monthly';
type HideState = 'shown' | 'hidden' | 'auto';
type AutoTarget = 'group' | 'channel';

// ── Static option tables (DC copy, verbatim from COPY.md) ─────────────────────────────────────────
const TYPE_OPTIONS: Array<{value: EventType; glyph: string; title: string; sub: string}> = [
  {value: 'online', glyph: '📡', title: 'Online / relay meetup', sub: 'Voice, stream or chat · link after RSVP'},
  {value: 'inperson', glyph: '📍', title: 'In person', sub: 'Physical place · address after approval'},
  {value: 'hybrid', glyph: '🔀', title: 'Hybrid', sub: 'In person and streamed'},
  {value: 'ama', glyph: '💬', title: 'Channel AMA / Q&A', sub: 'Scheduled inside one of your channels'},
];
/** Timezone dropdown options (label strings only — the app does no offset math), west → east. */
const TZ_OPTIONS = [
  'HST (UTC−10)',
  'AKST (UTC−9)',
  'PST (UTC−8)',
  'MST (UTC−7)',
  'CST (UTC−6)',
  'EST (UTC−5)',
  'VET (UTC−4)',
  'ART (UTC−3)',
  'UTC',
  'CET (UTC+1)',
  'EET (UTC+2)',
  'AST (UTC+3)',
  'MSK (UTC+3)',
  'IRST (UTC+3:30)',
  'GST (UTC+4)',
  'PKT (UTC+5)',
  'IST (UTC+5:30)',
  'BST (UTC+6)',
  'ICT (UTC+7)',
  'HKT (UTC+8)',
  'JST (UTC+9)',
  'AEST (UTC+10)',
  'NZST (UTC+12)',
];
const RECUR_OPTIONS: Array<{value: Recurrence; label: string}> = [
  {value: 'none', label: 'Doesn’t repeat'},
  {value: 'weekly', label: 'Repeats weekly'},
  {value: 'monthly', label: 'Repeats monthly'},
];
const COVER_SEG = [
  {key: 'gradient', label: 'Gradient'},
  {key: 'image', label: 'Image'},
  {key: 'none', label: 'None'},
];
const CAP_SEG = [
  {key: 'limit', label: 'Limit spots'},
  {key: 'count', label: 'Just a count'},
];

/** Valid date (mirrors format.ts fmtWhen's lenient check so the live preview and startsAt agree). */
function computeStartsAt(rawDate: string, rawTime: string): string | undefined {
  const p = rawDate.split('-');
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) {return undefined;}
  const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (isNaN(dt.getTime())) {return undefined;}
  const time = /^\d{1,2}:\d{2}$/.test(rawTime.trim()) ? rawTime.trim() : '00:00';
  return `${rawDate}T${time}:00`;
}

// ── Small presentational pieces ───────────────────────────────────────────────────────────────────
function ToggleSwitch({on}: {on: boolean}): React.JSX.Element {
  // Display-only: the enclosing row Pressable owns the toggle (matches the DC's whole-row buttons).
  return (
    <View pointerEvents="none">
      <Switch
        value={on}
        onValueChange={() => {}}
        trackColor={{false: colors.border, true: colors.accent}}
        thumbColor={colors.onAccent}
        ios_backgroundColor={colors.border}
      />
    </View>
  );
}

function Eyebrow({children, style}: {children: React.ReactNode; style?: object}): React.JSX.Element {
  return <Text style={[s.eyebrow, style]}>{children}</Text>;
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{key: string; label: string}>;
  value: string;
  onChange: (key: string) => void;
}): React.JSX.Element {
  return (
    <View style={s.seg}>
      {options.map(o => {
        const active = o.key === value;
        return (
          <Press
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[s.segBtn, active && s.segBtnActive]}
            accessibilityRole="tab"
            accessibilityState={{selected: active}}>
            <Text style={[s.segText, active ? s.segTextActive : s.segTextInactive]}>{o.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

function ChipSelect({
  options,
  value,
  onChange,
}: {
  options: Array<{value: string; label: string}>;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <View style={s.chipRow}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <Press
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[s.chip, active && s.chipActive]}
            accessibilityState={{selected: active}}>
            <Text style={[s.chipText, active && s.chipTextActive]}>{o.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

function HideToggle({state, onToggle}: {state: HideState; onToggle: () => void}): React.JSX.Element {
  if (state === 'auto') {return <Text style={s.hideAuto}>empty · auto-hidden</Text>;}
  const isHidden = state === 'hidden';
  return (
    <Press
      onPress={onToggle}
      hitSlop={10}
      style={[s.hideBtn, isHidden ? s.hideBtnHidden : s.hideBtnShown]}
      accessibilityLabel={isHidden ? 'Section hidden — tap to show' : 'Section visible to viewers'}>
      <Text style={[s.hideText, isHidden ? s.hideTextHidden : s.hideTextShown]}>{isHidden ? '🙈 Hidden' : '👁 Shown'}</Text>
    </Press>
  );
}

function TypeRow({
  option,
  selected,
  onPress,
}: {
  option: (typeof TYPE_OPTIONS)[number];
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Press variant="row" onPress={onPress} style={s.typeRow} accessibilityRole="radio" accessibilityState={{selected}}>
      <View style={s.typeIcon}>
        <Text style={s.typeGlyph}>{option.glyph}</Text>
      </View>
      <View style={s.flex1}>
        <Text style={s.typeTitle}>{option.title}</Text>
        <Text style={s.typeSub}>{option.sub}</Text>
      </View>
      {selected && (
        <View style={s.checkDot}>
          <Text style={s.checkGlyph}>✓</Text>
        </View>
      )}
    </Press>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────────────────────────
export function EventEditorScreen(props: EventEditorProps): React.JSX.Element {
  const {
    mode,
    initial,
    channels,
    hostName,
    hostGrad,
    pictureRules,
    picturesSpentBytes,
    allowVoice,
    postRules,
    savedPosts,
    savedEmbedTokens,
    onPublish,
    onSaveDraft,
    onAddToEmbeds,
    onBack,
  } = props;

  const channelOptions = channels.map(c => ({value: c.label, label: c.label}));
  const firstChannel = channels[0]?.label ?? '';

  // ── State (the DC's full field set, seeded from props.initial; DC defaults where absent) ──
  const [external, setExternal] = useState(initial.external ?? false);
  const [extSource, setExtSource] = useState(initial.externalSource ?? '');
  const [extLink, setExtLink] = useState(initial.externalLink ?? '');

  const [coverMode, setCoverMode] = useState<CoverMode>(initial.cover?.mode ?? 'gradient');
  const [coverGradient, setCoverGradient] = useState<GradientSpec>(
    toGradientSpec(initial.cover?.gradient, DEFAULT_COVER_GRADIENT),
  );
  // Cover image = an inline pixel-picture token from the app's PictureComposer studio (publish
  // rewrites it to a compact blob ref). Hidden-until-tapped on every rendered card.
  const [coverImage, setCoverImage] = useState(initial.cover?.image ?? '');

  const [cType, setCType] = useState<EventType>(initial.type ?? 'inperson');
  const [cTitle, setCTitle] = useState(initial.title ?? '');
  const [cDesc, setCDesc] = useState(initial.description ?? '');
  const [rawDate, setRawDate] = useState(initial.rawDate ?? (initial.startsAt ? initial.startsAt.slice(0, 10) : ''));
  const [rawTime, setRawTime] = useState(
    initial.rawTime ??
      (initial.startsAt && initial.startsAt.length >= 16 && initial.startsAt.charAt(10) === 'T'
        ? initial.startsAt.slice(11, 16)
        : ''),
  );
  const [cTz, setCTz] = useState(initial.tz ?? 'CET (UTC+1)');
  const [cRecur, setCRecur] = useState<Recurrence>(initial.recurrence ?? 'none');

  const [cArea, setCArea] = useState(initial.location?.area ?? '');
  const [cExact, setCExact] = useState(initial.location?.exactAddress ?? '');
  const [cLink, setCLink] = useState(initial.location?.streamLink ?? '');
  const [cChannel, setCChannel] = useState(initial.location?.channel ?? firstChannel);

  const [capMode, setCapMode] = useState<CapacityMode>(initial.capacityMode ?? 'limit');
  const [cCap, setCCap] = useState(initial.capacity != null ? String(initial.capacity) : '30');
  const [waitOn, setWaitOn] = useState(initial.waitlistEnabled ?? true);

  const [autoOn, setAutoOn] = useState(mode === 'create' ? true : initial.autoAdd != null);
  const [autoTarget, setAutoTarget] = useState<AutoTarget>(initial.autoAdd?.target ?? 'group');
  const [cGroupName, setCGroupName] = useState(initial.autoAdd?.groupName ?? '');
  const [cAddChannel, setCAddChannel] = useState(initial.autoAdd?.channel ?? firstChannel);

  const [cTag, setCTag] = useState(initial.tag ?? '');
  const [hidden, setHidden] = useState<NonNullable<EventDraft['hidden']>>(initial.hidden ?? {});

  const [gradOpen, setGradOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [picOpen, setPicOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [tzOpen, setTzOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) {clearTimeout(copyTimer.current);}
  }, []);

  // ── Derived ──
  const needsPhysical = cType === 'inperson' || cType === 'hybrid';
  const needsLink = cType === 'online' || cType === 'hybrid';
  const amaVenue = cType === 'ama';

  const descEmpty = !cDesc.trim();
  const areaEmpty = !cArea.trim();
  const tagEmpty = !cTag.trim();
  const isCount = capMode === 'count';
  const capShown = !hidden.cap && !external;
  const limitNum = cCap.trim() ? Number(cCap) : null;
  const showLoc = !hidden.loc && !areaEmpty;
  const showTag = !hidden.tag && !tagEmpty;

  const liveInterested = mode === 'edit' ? initial.interestedCount ?? 0 : 0;
  const liveGoing = mode === 'edit' ? initial.attendingCount ?? 0 : 0;

  const when = fmtWhen(rawDate, rawTime, cTz);
  const capPreviewLimit = limitNum != null ? `${liveGoing}/${limitNum} spots` : `${liveGoing} going`;
  const capPreviewCount = `${liveGoing} going`;
  const targetName =
    autoTarget === 'group' ? (cGroupName ? `the ${cGroupName} group chat` : 'a new group chat') : cAddChannel;

  const descState: HideState = hidden.desc ? 'hidden' : descEmpty ? 'auto' : 'shown';
  const locState: HideState = hidden.loc ? 'hidden' : areaEmpty ? 'auto' : 'shown';
  const tagState: HideState = hidden.tag ? 'hidden' : tagEmpty ? 'auto' : 'shown';
  const capState: HideState = hidden.cap ? 'hidden' : 'shown';

  const cardProps: EventCardProps = {
    title: cTitle || 'Untitled event',
    variant: 'Feed',
    type: cType,
    month: when.month,
    day: when.day,
    dateLabel: when.dateLabel,
    timeLabel: when.timeLabel,
    locationLabel: showLoc ? cArea : '',
    hostName,
    hostGrad,
    interestedCount: liveInterested,
    attendingCount: !external && capShown && (isCount || limitNum != null) ? liveGoing : null,
    capacity: !external && capShown && !isCount && limitNum != null ? limitNum : null,
    countOnly: !external && capShown && isCount,
    tag: showTag ? cTag : '',
    recurring: recurLabel(cRecur),
    rsvp: null,
    status: 'upcoming',
    external,
    coverMode,
    coverGradient,
    coverImage: coverImage || undefined,
  };

  const createTitle = mode === 'edit' ? 'Edit event' : 'New event';
  const publishLabel = mode === 'edit' ? 'Save changes & notify' : 'Publish event';
  const canPublish = cTitle.trim().length > 0 && (!external || extSource.trim().length > 0);

  const toggleHidden = (key: 'desc' | 'loc' | 'tag' | 'cap'): void =>
    setHidden(h => ({...h, [key]: !h[key]}));

  // ── Assemble the outgoing draft ──
  const assembleDraft = (isDraft: boolean): EventDraft => {
    const capNum = capMode === 'limit' && cCap.trim() && Number(cCap) >= 1 ? Number(cCap) : undefined;
    let location: EventLocation;
    if (amaVenue) {location = {kind: 'channel', channel: cChannel || undefined};}
    else if (cType === 'online') {location = {kind: 'link', streamLink: cLink || undefined};}
    else if (cType === 'hybrid')
      {location = {kind: 'physical', area: cArea || undefined, exactAddress: cExact || undefined, streamLink: cLink || undefined};}
    else {location = {kind: 'physical', area: cArea || undefined, exactAddress: cExact || undefined};}

    // The CARD/detail label is the DC's "#backups-crew" form (slugged group name / channel
    // label), not the editor's explainer phrase (targetName stays UI-only). channelId resolves
    // the picked label back to the channel's id so approvals know where to add guests.
    const groupSlug = cGroupName.trim() ? `#${cGroupName.trim().toLowerCase().replace(/\s+/g, '-')}` : 'the group chat';
    const autoAdd: AutoAddPolicy | undefined =
      autoOn && !external
        ? {
            target: autoTarget,
            groupName: autoTarget === 'group' ? cGroupName || undefined : undefined,
            channel: autoTarget === 'channel' ? cAddChannel || undefined : undefined,
            channelId: autoTarget === 'channel' ? channels.find(c => c.label === cAddChannel)?.id : undefined,
            // Editing a live event must keep the group already created on first publish —
            // dropping this would make publishEvent mint a second, empty group.
            groupId: autoTarget === 'group' ? initial.autoAdd?.groupId : undefined,
            label: autoTarget === 'group' ? groupSlug : cAddChannel || 'the channel',
          }
        : undefined;

    return {
      isDraft,
      hidden,
      rawDate,
      rawTime,
      title: cTitle,
      description: cDesc,
      tag: cTag,
      type: cType,
      startsAt: computeStartsAt(rawDate, rawTime),
      tz: cTz,
      recurrence: cRecur,
      location,
      capacityMode: capMode,
      capacity: capNum,
      waitlistEnabled: waitOn,
      autoAdd,
      cover: {mode: coverMode, gradient: coverGradient, image: coverImage || undefined},
      external,
      externalSource: extSource,
      externalLink: extLink,
      interestedCount: initial.interestedCount ?? 0,
      attendingCount: initial.attendingCount ?? 0,
    };
  };

  const onEmbed = (): void => {
    onAddToEmbeds(assembleDraft(false));
    setCopied(true);
    if (copyTimer.current) {clearTimeout(copyTimer.current);}
    copyTimer.current = setTimeout(() => setCopied(false), 2400);
  };
  const onPublishPress = (): void => {
    if (canPublish) {onPublish(assembleDraft(false));}
  };
  const openGrad = (): void => {
    setCoverMode('gradient');
    setGradOpen(true);
  };

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Press onPress={onBack} style={s.backBtn} accessibilityLabel="Back">
          <Text style={s.backText}>‹ Your events</Text>
        </Press>
        <Text style={s.headerTitle}>{createTitle}</Text>
        <View style={s.headerSpacer} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        // iOS doesn't resize for the keyboard (Android's adjustResize does) — auto-inset the scroll
        // so lower form fields (description, tags, location) aren't typed behind the keyboard.
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        showsVerticalScrollIndicator={false}>
        {/* editing banner */}
        {mode === 'edit' && (
          <View style={s.editBanner}>
            <Text style={s.editBannerGlyph}>✎</Text>
            <Text style={s.editBannerText}>
              Editing a live event — everyone going is notified when you save time or place changes.
            </Text>
          </View>
        )}

        {/* external toggle card */}
        <View style={[s.extCard, external && s.extCardOn]}>
          <Press
            variant="row"
            onPress={() => setExternal(v => !v)}
            style={s.extRow}
            accessibilityRole="switch"
            accessibilityState={{checked: external}}
            accessibilityLabel="External event">
            <View style={[s.extIconTile, external && s.extIconTileOn]}>
              <Text style={[s.extIconGlyph, external && s.extIconGlyphOn]}>↗</Text>
            </View>
            <View style={s.flex1}>
              <Text style={s.extTitle}>External event</Text>
              <Text style={s.extSub}>
                {external ? 'You’re sharing an event you don’t organize' : 'Turn on if you’re sharing an event you don’t organize'}
              </Text>
            </View>
            <ToggleSwitch on={external} />
          </Press>
          {external && (
            <View style={s.extReveal}>
              <View style={s.noteRowTight}>
                <Text style={s.noteGlyph}>🪧</Text>
                <Text style={s.noteText}>
                  <Text style={s.noteBold}>You’re not the organizer.</Text> The card is clearly marked so people check the
                  source. Stiq won’t handle RSVPs, approvals or a guest list for this one.
                </Text>
              </View>
              <Eyebrow style={s.mb7}>Who’s organizing it</Eyebrow>
              <TextInput
                value={extSource}
                onChangeText={setExtSource}
                placeholder="Person, group or venue"
                placeholderTextColor={colors.textMuted}
                style={[s.input, s.inputOnAccent, s.mb11]}
                accessibilityLabel="Who’s organizing it"
              />
              <Text style={[s.eyebrow, s.mb7]}>
                Link to the event <Text style={s.eyebrowOptional}>· optional</Text>
              </Text>
              <TextInput
                value={extLink}
                onChangeText={setExtLink}
                placeholder="https:// or where to find it"
                placeholderTextColor={colors.textMuted}
                style={[s.input, s.inputOnAccent, s.mono]}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Link to the event"
              />
            </View>
          )}
        </View>

        {/* live card + copy */}
        <View style={s.cardHeaderRow}>
          <Eyebrow>Event card</Eyebrow>
          <View style={s.flex1} />
          <Text style={s.updatesLive}>● Updates live</Text>
        </View>
        <EventCard {...cardProps} />
        {copied ? (
          <View style={s.copiedRow}>
            <Text style={s.copiedText}>✓ Added — insert it from any composer’s 🔖 Embed picker</Text>
          </View>
        ) : (
          <Press onPress={onEmbed} style={s.copyBtn} accessibilityLabel="Add this event card to your embeds">
            <Text style={s.copyGlyph}>🔖</Text>
            <Text style={s.copyText}>Add to my embeds</Text>
          </Press>
        )}
        <Text style={[s.helpNote, s.mt9]}>
          There’s no feed to announce to — add the card to your embeds, then drop it into any post, channel, group or
          DM from the composer’s 🔖 Embed button. It stays a live, tappable event wherever it lands.
        </Text>

        <View style={s.divider} />

        {/* cover */}
        <Eyebrow style={s.mb8}>Cover</Eyebrow>
        <View style={s.mb12}>
          <Segmented options={COVER_SEG} value={coverMode} onChange={k => setCoverMode(k as CoverMode)} />
        </View>
        {coverMode === 'gradient' && (
          <>
            <Press variant="row" onPress={openGrad} style={s.coverSwatch} accessibilityLabel="Edit cover colours">
              <GradientRect gradient={coverGradient} style={StyleSheet.absoluteFill} />
              <View style={s.editColorsPill}>
                <Text style={s.editColorsText}>🎨 Edit colors</Text>
              </View>
            </Press>
            <Text style={[s.helpNote, s.mb20]}>A color wash — always visible, nothing to load. Tap to pick your own colors.</Text>
          </>
        )}
        {coverMode === 'image' && (
          <>
            <Press
              variant="row"
              onPress={() => {
                if (pictureRules?.allow) setPicOpen(true);
              }}
              style={s.imageDrop}
              accessibilityLabel={coverImage ? 'Replace the cover image' : 'Choose an image'}>
              <Text style={s.imageDropGlyph}>🖼️</Text>
              <Text style={s.imageDropTitle}>{coverImage ? 'Image attached' : 'Choose an image'}</Text>
              <Text style={s.imageDropSub}>
                {!pictureRules?.allow
                  ? 'Pictures are switched off in this community'
                  : coverImage
                  ? 'Tap to replace — opens the pixel studio'
                  : 'Opens the pixel studio — same as pictures in a post'}
              </Text>
            </Press>
            {coverImage ? (
              <Press
                onPress={() => setCoverImage('')}
                style={s.removeImageBtn}
                accessibilityLabel="Remove the cover image">
                <Text style={s.removeImageText}>✕ Remove image</Text>
              </Press>
            ) : null}
            <View style={s.noteCard}>
              <Text style={s.noteGlyphLg}>🔒</Text>
              <Text style={s.noteText}>
                For privacy, the image stays hidden on the card until a viewer taps to load it — nothing fetches until they
                choose.
              </Text>
            </View>
          </>
        )}
        {coverMode === 'none' && (
          <View style={s.noteCard}>
            <Text style={s.noteGlyphLg}>🗒️</Text>
            <Text style={s.noteText}>No cover — a clean, text-only card.</Text>
          </View>
        )}

        {/* type */}
        <Eyebrow style={s.mb8}>Type</Eyebrow>
        <View style={s.typeList}>
          {TYPE_OPTIONS.map(o => (
            <TypeRow key={o.value} option={o} selected={cType === o.value} onPress={() => setCType(o.value)} />
          ))}
        </View>

        {/* title */}
        <Eyebrow style={s.mb8}>Title</Eyebrow>
        <TextInput
          value={cTitle}
          onChangeText={setCTitle}
          placeholder="What’s the event?"
          placeholderTextColor={colors.textMuted}
          style={[s.input, s.mb16]}
          accessibilityLabel="Event title"
        />

        {/* description */}
        <View style={s.eyebrowRow}>
          <Eyebrow>Description</Eyebrow>
          <View style={s.flex1} />
          <Press onPress={() => setDescOpen(true)} style={s.expandBtn}>
            <Text style={s.expandText}>⤢ Expand editor</Text>
          </Press>
          <HideToggle state={descState} onToggle={() => toggleHidden('desc')} />
        </View>
        <Press variant="row" onPress={() => setDescOpen(true)} style={s.descPreview} accessibilityLabel="Edit description">
          <Text style={cDesc.trim() ? s.descText : s.descPlaceholder} numberOfLines={8}>
            {cDesc.trim() ? labelInlineMedia(cDesc) : 'What happens, who it’s for, what to bring…'}
          </Text>
        </Press>

        {/* date / time / tz / recurrence */}
        <Eyebrow style={s.mb8}>Date &amp; time</Eyebrow>
        <View style={s.dateRow}>
          <Press
            variant="row"
            onPress={() => setDateOpen(true)}
            style={[s.dateInput, s.pickField]}
            accessibilityLabel="Pick the event date">
            <Text style={rawDate ? s.pickText : s.pickPlaceholder} numberOfLines={1}>
              {rawDate ? when.dateLabel : 'Pick a date'}
            </Text>
            <Text style={s.pickChevron}>▾</Text>
          </Press>
          <Press
            variant="row"
            onPress={() => setTimeOpen(true)}
            style={[s.timeInput, s.pickField]}
            accessibilityLabel="Pick the event time">
            <Text style={rawTime ? s.pickText : s.pickPlaceholder} numberOfLines={1}>
              {rawTime || 'Time'}
            </Text>
            <Text style={s.pickChevron}>▾</Text>
          </Press>
        </View>
        <Press
          variant="row"
          onPress={() => setTzOpen(true)}
          style={[s.tzField, s.pickField, s.mb10]}
          accessibilityLabel="Pick the time zone">
          <Text style={s.pickText} numberOfLines={1}>
            {cTz}
          </Text>
          <Text style={s.pickChevron}>▾</Text>
        </Press>
        <View style={s.mb16}>
          <ChipSelect options={RECUR_OPTIONS} value={cRecur} onChange={v => setCRecur(v as Recurrence)} />
        </View>

        {/* location (type-driven) */}
        {needsPhysical && (
          <>
            <View style={s.eyebrowRow}>
              <Eyebrow>Approximate area</Eyebrow>
              <Text style={s.eyebrowAccent}>shown to everyone</Text>
              <View style={s.flex1} />
              <HideToggle state={locState} onToggle={() => toggleHidden('loc')} />
            </View>
            <TextInput
              value={cArea}
              onChangeText={setCArea}
              placeholder="e.g. Neukölln, Berlin"
              placeholderTextColor={colors.textMuted}
              style={[s.input, s.mb12]}
              accessibilityLabel="Approximate area"
            />
            <Text style={[s.eyebrow, s.mb8]}>
              Exact address <Text style={s.eyebrowSuccess}>· 🔒 revealed after you approve</Text>
            </Text>
            <TextInput
              value={cExact}
              onChangeText={setCExact}
              placeholder="Street, number, entry notes"
              placeholderTextColor={colors.textMuted}
              style={[s.input, s.mb16]}
              accessibilityLabel="Exact address"
            />
          </>
        )}
        {needsLink && (
          <>
            <Text style={[s.eyebrow, s.mb8]}>
              Stream / call link <Text style={s.eyebrowSuccess}>· 🔒 revealed after RSVP</Text>
            </Text>
            <TextInput
              value={cLink}
              onChangeText={setCLink}
              placeholder="https:// or relay address"
              placeholderTextColor={colors.textMuted}
              style={[s.input, s.mb16]}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Stream or call link"
            />
          </>
        )}
        {amaVenue && (
          <>
            <Eyebrow style={s.mb8}>Hosted in channel</Eyebrow>
            <View style={s.mb16}>
              <ChipSelect options={channelOptions} value={cChannel} onChange={setCChannel} />
            </View>
          </>
        )}

        {/* attendees + auto-add (hidden when external) */}
        {!external && (
          <>
            <View style={s.eyebrowRow}>
              <Eyebrow>Attendees</Eyebrow>
              <View style={s.flex1} />
              <HideToggle state={capState} onToggle={() => toggleHidden('cap')} />
            </View>
            <View style={s.mb12}>
              <Segmented options={CAP_SEG} value={capMode} onChange={k => setCapMode(k as CapacityMode)} />
            </View>
            {capMode === 'limit' ? (
              <>
                <View style={s.spotsRow}>
                  <TextInput
                    value={cCap}
                    onChangeText={t => setCCap(t.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    style={s.spotsInput}
                    accessibilityLabel="Spots"
                  />
                  <Text style={s.spotsHint}>spots · viewers see “{capPreviewLimit}”</Text>
                </View>
                <Press
                  variant="row"
                  onPress={() => setWaitOn(v => !v)}
                  style={[s.toggleRow, s.mb20]}
                  accessibilityRole="switch"
                  accessibilityState={{checked: waitOn}}>
                  <Text style={s.toggleRowLabel}>Waitlist when full</Text>
                  <ToggleSwitch on={waitOn} />
                </Press>
              </>
            ) : (
              <View style={s.noteCard}>
                <Text style={s.noteGlyphLg}>👥</Text>
                <Text style={s.noteText}>
                  No cap. Anyone approved just adds to the count — viewers see a bold{' '}
                  <Text style={s.noteAccentBold}>“{capPreviewCount}”</Text> with no limit or goal to reach.
                </Text>
              </View>
            )}

            <Eyebrow style={s.mb8}>When you approve a guest</Eyebrow>
            <View style={s.autoCard}>
              <Press
                variant="row"
                onPress={() => setAutoOn(v => !v)}
                style={s.autoToggleRow}
                accessibilityRole="switch"
                accessibilityState={{checked: autoOn}}>
                <Text style={s.toggleRowLabel}>Bring them into a chat</Text>
                <ToggleSwitch on={autoOn} />
              </Press>
              {autoOn && (
                <>
                  <View style={s.targetRow}>
                    <Press
                      onPress={() => setAutoTarget('group')}
                      style={[s.targetBtn, autoTarget === 'group' ? s.targetBtnActive : s.targetBtnInactive]}
                      accessibilityState={{selected: autoTarget === 'group'}}>
                      <Text style={[s.targetText, autoTarget === 'group' ? s.targetTextActive : s.targetTextInactive]}>
                        New group chat
                      </Text>
                    </Press>
                    <Press
                      onPress={() => setAutoTarget('channel')}
                      style={[s.targetBtn, autoTarget === 'channel' ? s.targetBtnActive : s.targetBtnInactive]}
                      accessibilityState={{selected: autoTarget === 'channel'}}>
                      <Text style={[s.targetText, autoTarget === 'channel' ? s.targetTextActive : s.targetTextInactive]}>
                        A channel I run
                      </Text>
                    </Press>
                  </View>
                  {autoTarget === 'group' ? (
                    <TextInput
                      value={cGroupName}
                      onChangeText={setCGroupName}
                      placeholder="Name the group chat"
                      placeholderTextColor={colors.textMuted}
                      style={s.autoInput}
                      accessibilityLabel="Name the group chat"
                    />
                  ) : (
                    <View style={s.autoChannelSelect}>
                      <ChipSelect options={channelOptions} value={cAddChannel} onChange={setCAddChannel} />
                    </View>
                  )}
                  <View style={s.autoNoteRow}>
                    <Text style={s.autoNoteGlyph}>👁</Text>
                    <Text style={s.autoNoteText}>
                      Shown on the card so guests know they’ll join <Text style={s.noteStrong}>{targetName}</Text> once
                      approved.
                    </Text>
                  </View>
                </>
              )}
            </View>
          </>
        )}

        {/* external note */}
        {external && (
          <View style={s.noteCard}>
            <Text style={s.noteGlyphLg}>🔕</Text>
            <Text style={s.noteText}>
              RSVPs, approvals and the guest list are handled by the real organizer — not on Stiq. People who see the card
              can mark interested and open your link.
            </Text>
          </View>
        )}

        {/* tag */}
        <View style={s.eyebrowRow}>
          <Eyebrow>Tag</Eyebrow>
          <View style={s.flex1} />
          <HideToggle state={tagState} onToggle={() => toggleHidden('tag')} />
        </View>
        <View style={s.tagInputRow}>
          <Text style={s.tagHash}>#</Text>
          <TextInput
            value={cTag}
            onChangeText={t => setCTag(t.replace(/[^a-z0-9-]/gi, ''))}
            placeholder="opsec"
            placeholderTextColor={colors.textMuted}
            style={s.tagInput}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Tag"
          />
        </View>

        {/* CTAs */}
        <Press
          onPress={onPublishPress}
          disabled={!canPublish}
          style={s.publishBtn}
          accessibilityState={{disabled: !canPublish}}>
          <Text style={s.publishText}>{publishLabel}</Text>
        </Press>
        {mode !== 'edit' && (
          <Press onPress={() => onSaveDraft(assembleDraft(true))} style={s.draftBtn}>
            <Text style={s.draftText}>Save as draft</Text>
          </Press>
        )}
      </ScrollView>

      {/* always-mounted overlays (Modal law) */}
      <CoverColorsSheet
        visible={gradOpen}
        value={coverGradient}
        onChange={setCoverGradient}
        onDone={() => setGradOpen(false)}
        onClose={() => setGradOpen(false)}
      />
      {/* Description — THE app's full post editor (rich blocks, Aa sheet, links, embeds, media),
          body-only: no title row, no Details step, article ceiling only. Done applies; publish
          blob-splits any inline media out of the doc (AppRuntime.mintEventDescriptionBlobs). */}
      <ComposerScreen
        visible={descOpen}
        onClose={() => setDescOpen(false)}
        bodyOnly
        showByline
        communityName={hostName}
        myGradient={toGradientSpec(hostGrad)}
        headerTitle="Description"
        bodyPlaceholder="What happens, who it’s for, what to bring…"
        initialBody={cDesc}
        onSubmit={text => setCDesc(text)}
        allowVoice={allowVoice}
        postRules={postRules}
        pictureRules={pictureRules}
        pictureSpentBytes={picturesSpentBytes ?? 0}
        savedPosts={savedPosts}
        savedEmbedTokens={savedEmbedTokens}
      />

      {/* Cover image — THE app's pixel-picture studio, same flow as pictures in a post. */}
      {pictureRules?.allow && (
        <PictureComposer
          visible={picOpen}
          onClose={() => setPicOpen(false)}
          rules={pictureRules}
          spentBytes={picturesSpentBytes ?? 0}
          onAdd={token => {
            setCoverImage(token);
            setCoverMode('image');
            setPicOpen(false);
          }}
        />
      )}

      <DatePickerSheet
        visible={dateOpen}
        value={rawDate}
        onSelect={d => {
          setRawDate(d);
          setDateOpen(false);
        }}
        onClear={() => {
          setRawDate('');
          setDateOpen(false);
        }}
        onClose={() => setDateOpen(false)}
      />
      <TimePickerSheet
        visible={timeOpen}
        value={rawTime}
        onSelect={t => {
          setRawTime(t);
          setTimeOpen(false);
        }}
        onClear={() => {
          setRawTime('');
          setTimeOpen(false);
        }}
        onClose={() => setTimeOpen(false)}
      />
      <OptionSheet
        visible={tzOpen}
        title="Time zone"
        options={TZ_OPTIONS.map(t => ({value: t, label: t}))}
        value={cTz}
        onSelect={v => {
          setCTz(v);
          setTzOpen(false);
        }}
        onClose={() => setTzOpen(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex1: {flex: 1, minWidth: 0},
  mono: {fontFamily: 'monospace'},
  mt9: {marginTop: 9},
  mb7: {marginBottom: 7},
  mb8: {marginBottom: 8},
  mb10: {marginBottom: 10},
  mb11: {marginBottom: 11},
  mb12: {marginBottom: 12},
  mb16: {marginBottom: 16},
  mb20: {marginBottom: 20},

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingRight: 10,
  },
  backBtn: {paddingLeft: 12, paddingRight: 12, paddingTop: 11, paddingBottom: 10},
  backText: {color: colors.accent, fontSize: 14, fontWeight: '600'},
  headerTitle: {fontSize: 15, fontWeight: '700', color: colors.textPrimary},
  headerSpacer: {width: 60},

  scroll: {flex: 1},
  scrollContent: {padding: 16, paddingBottom: 28},

  eyebrow: {fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted},
  eyebrowRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8},
  eyebrowAccent: {fontSize: 11, fontWeight: '600', color: colors.accent},
  eyebrowOptional: {fontSize: 11, fontWeight: '400', color: colors.textMuted, textTransform: 'none', letterSpacing: 0},
  eyebrowSuccess: {fontSize: 11, fontWeight: '400', color: colors.success, textTransform: 'none', letterSpacing: 0},

  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.textPrimary,
    fontSize: 15,
  },
  inputOnAccent: {backgroundColor: colors.bg},

  // editing banner
  editBanner: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: 'rgba(201,162,39,0.35)',
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginBottom: 18,
  },
  editBannerGlyph: {fontSize: 14},
  editBannerText: {flex: 1, fontSize: 12.5, color: colors.textPrimary, lineHeight: 18.75},

  // external card
  extCard: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 13,
    marginBottom: 18,
  },
  extCardOn: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  extRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  extIconTile: {
    width: 40,
    height: 40,
    borderRadius: 11,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  extIconTileOn: {backgroundColor: colors.accent},
  extIconGlyph: {fontSize: 19, color: colors.textPrimary},
  extIconGlyphOn: {color: colors.onAccent},
  extTitle: {fontSize: 15, fontWeight: '700', color: colors.textPrimary},
  extSub: {fontSize: 12.5, color: colors.textSecondary, marginTop: 2, lineHeight: 17.5},
  extReveal: {marginTop: 13, paddingTop: 13, borderTopWidth: 1, borderTopColor: colors.accentTint},

  // notes
  noteRowTight: {flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginBottom: 14},
  noteGlyph: {fontSize: 14},
  noteBold: {fontWeight: '700', color: colors.textPrimary},
  noteText: {flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 19.4},
  noteCard: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 12,
    marginBottom: 20,
  },
  noteGlyphLg: {fontSize: 15},
  noteAccentBold: {color: colors.accent, fontWeight: '700'},
  noteStrong: {color: colors.textPrimary, fontWeight: '700'},

  // live card + copy
  cardHeaderRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9},
  updatesLive: {fontSize: 11, color: colors.accent, fontWeight: '600'},
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 999,
    paddingVertical: 12,
    marginTop: 11,
  },
  // Glyph in its own Text with a pinned lineHeight — mixed-font glyphs otherwise inflate the
  // line box and shove the latin label off the button's visual centre (PostCard vglyph idiom).
  copyGlyph: {fontSize: 14, lineHeight: 18, fontWeight: '600', color: colors.textPrimary},
  copyText: {fontSize: 14, lineHeight: 18, fontWeight: '600', color: colors.textPrimary},
  copiedRow: {alignItems: 'center', justifyContent: 'center', backgroundColor: colors.successBg, borderRadius: 999, paddingVertical: 12, marginTop: 11},
  copiedText: {fontSize: 14, fontWeight: '600', color: colors.success},
  helpNote: {fontSize: 12, color: colors.textMuted, lineHeight: 18},

  divider: {height: 1, backgroundColor: colors.border, marginVertical: 20},

  // segmented (cover / attendees)
  seg: {flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 3},
  segBtn: {flex: 1, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 4, alignItems: 'center'},
  segBtnActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: {width: 0, height: 1},
    elevation: 2,
  },
  segText: {fontSize: 12.5, fontWeight: '600'},
  segTextActive: {color: colors.textPrimary},
  segTextInactive: {color: colors.textSecondary},

  // cover
  coverSwatch: {height: 74, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginBottom: 8},
  editColorsPill: {
    position: 'absolute',
    bottom: 9,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  editColorsText: {fontSize: 11.5, fontWeight: '600', color: '#ffffff'},
  imageDrop: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.borderLight,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 22,
    paddingHorizontal: 13,
    marginBottom: 10,
  },
  imageDropGlyph: {fontSize: 24},
  imageDropTitle: {fontSize: 14, fontWeight: '600', color: colors.textPrimary},
  imageDropSub: {fontSize: 12, color: colors.textMuted},
  removeImageBtn: {alignSelf: 'center', paddingVertical: 7, paddingHorizontal: 12, marginBottom: 4},
  removeImageText: {fontSize: 12.5, fontWeight: '600', color: colors.danger},

  // type
  typeList: {gap: 8, marginBottom: 20},
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  typeIcon: {width: 32, height: 32, borderRadius: 9, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center'},
  typeGlyph: {fontSize: 16},
  typeTitle: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary},
  typeSub: {fontSize: 12, color: colors.textSecondary, marginTop: 1},
  checkDot: {width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center'},
  checkGlyph: {fontSize: 13, fontWeight: '700', color: colors.onAccent},

  // description
  expandBtn: {backgroundColor: colors.accentSoft, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 4},
  expandText: {fontSize: 11.5, fontWeight: '600', color: colors.accent},
  descPreview: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 15,
    paddingVertical: 13,
    minHeight: 96,
    marginBottom: 16,
  },
  descText: {fontSize: 17, lineHeight: 27, color: colors.textPrimary},
  descPlaceholder: {fontSize: 17, lineHeight: 27, color: colors.textMuted},

  // date / time / tz — picker FIELDS (Pressables opening the PickerSheets), not text inputs.
  dateRow: {flexDirection: 'row', gap: 8, marginBottom: 10},
  dateInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  timeInput: {
    width: 110,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tzField: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickField: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  pickText: {flexShrink: 1, fontSize: 14, lineHeight: 18, color: colors.textPrimary},
  pickPlaceholder: {flexShrink: 1, fontSize: 14, lineHeight: 18, color: colors.textMuted},
  pickChevron: {fontSize: 12, lineHeight: 16, color: colors.textMuted},

  // chip pseudo-select
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 13},
  chipActive: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  chipText: {fontSize: 13, color: colors.textPrimary},
  chipTextActive: {color: colors.accent, fontWeight: '600'},

  // hide toggle
  hideBtn: {borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1},
  hideBtnShown: {backgroundColor: colors.surfaceAlt, borderColor: colors.border},
  hideBtnHidden: {backgroundColor: colors.accentSoft, borderColor: 'transparent'},
  hideText: {fontSize: 11, fontWeight: '600'},
  hideTextShown: {color: colors.textSecondary},
  hideTextHidden: {color: colors.accent},
  hideAuto: {fontSize: 11, color: colors.textMuted, fontStyle: 'italic'},

  // attendees
  spotsRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12},
  spotsInput: {
    width: 88,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
    color: colors.textPrimary,
    fontSize: 15,
    textAlign: 'center',
  },
  spotsHint: {flex: 1, fontSize: 13.5, color: colors.textSecondary},
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  toggleRowLabel: {flex: 1, fontSize: 14, color: colors.textPrimary},

  // auto-add
  autoCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 13, marginBottom: 20},
  autoToggleRow: {flexDirection: 'row', alignItems: 'center'},
  targetRow: {flexDirection: 'row', gap: 8, marginTop: 12},
  targetBtn: {flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 8, borderWidth: 1.5},
  targetBtnActive: {backgroundColor: colors.accentSoft, borderColor: colors.accent},
  targetBtnInactive: {backgroundColor: colors.surfaceAlt, borderColor: colors.border},
  targetText: {fontSize: 12.5, fontWeight: '600'},
  targetTextActive: {color: colors.accent},
  targetTextInactive: {color: colors.textPrimary},
  autoInput: {
    marginTop: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 14,
  },
  autoChannelSelect: {marginTop: 10},
  autoNoteRow: {flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border},
  autoNoteGlyph: {fontSize: 13},
  autoNoteText: {flex: 1, fontSize: 12, color: colors.textSecondary, lineHeight: 18},

  // tag
  tagInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 13,
    marginBottom: 22,
  },
  tagHash: {fontSize: 15, color: colors.textMuted, fontFamily: 'monospace'},
  tagInput: {flex: 1, paddingVertical: 11, color: colors.textPrimary, fontSize: 15},

  // CTAs
  publishBtn: {backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 14, alignItems: 'center'},
  publishBtnDisabled: {opacity: 0.45},
  publishText: {color: colors.onAccent, fontSize: 15, fontWeight: '600'},
  draftBtn: {alignItems: 'center', paddingVertical: 10, marginTop: 6},
  draftText: {color: colors.textSecondary, fontSize: 14, fontWeight: '600'},
});

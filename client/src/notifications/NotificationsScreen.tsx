/**
 * NotificationsScreen — the notification center (design_handoff_notifications, high-fidelity).
 *
 * Two panes:
 *   'list'     (default) — one inbox over the four live-derived sources (DMs, channel activity,
 *              comments on the user's own posts, members' new public posts). Filter chips with
 *              per-type unread counts, recency sections (Today / This week / Earlier), rows with
 *              identity avatar + type badge + actor/action/target line + 2-line preview + relative
 *              time + unread dot. Tap a row → it marks read (dot clears immediately) and navigates
 *              via onSelect(target). ✓✓ marks everything read. Empty state per the design.
 *   'settings' (via the gear button) — a prefs editor. Every toggle commits immediately (both to
 *              a local draft, so the UI reflects it instantly, and via onSetPrefs so the caller
 *              persists it) rather than requiring a separate "Save" step.
 *
 * ALWAYS-MOUNT: the <Modal> is unconditionally in the tree; `visible` toggles it. Never
 * conditionally render the Modal itself — RN 0.76 Android has a mount-to-show bug.
 *
 * Read state: `items` is a snapshot taken at open; rows carry their persisted `read` flag. Taps
 * and ✓✓ update a local override set for instant feedback AND report up (onMarkRead /
 * onMarkAllRead) so the runtime persists + the bell badge drops.
 *
 * Never renders a raw npub: DM override rows use getDisplayName, falling back to a short
 * (truncated) label — never the full identity string.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Modal, SafeAreaView, ScrollView, SectionList, StyleSheet, Switch, Text, View} from 'react-native';
import {Press} from '../ui/Press';
import {SwipeBackView} from '../ui/SwipeBack';
import {useSwipeOptOut} from '../ui/swipeOptOut';
import {colors, radius, space, type as typeScale, weight, type Palette, DENSE_MAX_FONT_SCALE} from '../ui/theme';
import {relTimeShort} from '../ui/relTime';
import {safeNpubEncode, shortenNpub} from '../util/npub';
import {GradientAvatar, type AvatarShape} from '../ui/GradientAvatar';
import {Icon} from '../ui/icons';
import {EmptyState} from '../ui/EmptyState';
import type {Channel} from '../channels/channels';
import type {NavTarget, NotifItem, NotifKind} from './notifications';
import {DEFAULT_PREFS, type NotificationPrefs, type PostType} from './prefs';

export interface NotificationsScreenProps {
  visible: boolean;
  onClose: () => void;
  /** Snapshot taken on open (onGetNotifications()). */
  items: NotifItem[];
  prefs: NotificationPrefs;
  onSetPrefs: (next: NotificationPrefs) => void;
  onSelect: (target: NavTarget) => void;
  /** Mark one notification read (row tap) — persists + drops the bell badge. */
  onMarkRead?: (id: string) => void;
  /** Mark every notification read (✓✓) — persists + clears the bell badge. */
  onMarkAllRead?: () => void;
  /** For per-channel + per-type + joined/accessible rows in the settings pane. */
  channels: Channel[];
  subscribedChannelIds: string[];
  /** Known DM peers — drives the per-user override rows. */
  inboxPeers?: string[];
  getDisplayName?: (pubkey: string) => string | undefined;
}

type Pane = 'list' | 'settings';
type Filter = 'all' | NotifKind;
/** Segmented tab inside the settings pane: in-app (notification-center) gates vs. OS-push gates. */
type SettingsTab = 'inapp' | 'push';

const POST_TYPE_LABEL: Record<PostType, string> = {
  note: 'Notes',
  article: 'Articles',
  picture: 'Pictures',
  voice: 'Voice',
  poll: 'Polls',
};

/** Filter chips in design order. 'reply' is the model name for the design's "Comments" source. */
const CHIPS: ReadonlyArray<{id: Filter; label: string}> = [
  {id: 'all', label: 'All'},
  {id: 'dm', label: 'DMs'},
  {id: 'channel', label: 'Channels'},
  {id: 'reply', label: 'Comments'},
  {id: 'post', label: 'Posts'},
  {id: 'draft', label: 'Drafts'},
];

/**
 * Small bottom-right type-badge glyph per source (single-tone precompiled icons — see ui/icons).
 * 'post' is absent on purpose: a public post's marker is the avatar itself — a large megaphone
 * filling the identity circle — so post rows read differently from DM rows at a glance.
 */
const GLYPH: Partial<Record<NotifKind, string>> = {
  dm: '✉️',
  reply: '💬',
  channel: '📣',
  draft: '✍️',
};

/** One list row. Memoized so a chip tap / read-state change only re-renders the rows it affects. */
const NotifRow = React.memo(function NotifRow({
  item,
  unread,
  onPress,
}: {
  item: NotifItem;
  unread: boolean;
  onPress: (item: NotifItem) => void;
}): React.JSX.Element {
  const c: Palette = colors;
  const glyph = GLYPH[item.kind];
  return (
    <Press variant="row" onPress={() => onPress(item)}>
      <View style={[s.notifRowInner, {borderBottomColor: c.border}]}>
        <View style={s.avatarWrap}>
          <GradientAvatar
            gradient={item.avatar.gradient}
            seed={item.avatar.seed}
            size={42}
            shape={item.avatar.shape as AvatarShape}
          />
          {item.kind === 'post' ? (
            <View style={s.postGlyphOverlay} pointerEvents="none">
              <Icon name="📣" size={26} />
            </View>
          ) : glyph ? (
            <View style={[s.typeBadge, {backgroundColor: c.surface, borderColor: c.borderLight}]}>
              <Icon name={glyph} size={10} />
            </View>
          ) : null}
        </View>
        <View style={s.notifBody}>
          <Text style={s.line1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            <Text style={[s.actor, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.actor}</Text>
            <Text style={[s.action, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}> {item.action}</Text>
            {item.targetText ? (
              <Text style={[s.target, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}> {item.targetText}</Text>
            ) : null}
          </Text>
          {item.preview ? (
            <Text
              style={[s.preview, {color: c.textMuted}]}
              numberOfLines={2}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {item.preview}
            </Text>
          ) : null}
        </View>
        <View style={s.meta}>
          <Text style={[s.time, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {relTimeShort(item.ts)}
          </Text>
          {unread && <View style={[s.unreadDot, {backgroundColor: c.accent}]} />}
        </View>
      </View>
    </Press>
  );
});

export function NotificationsScreen({
  visible,
  onClose,
  items,
  prefs,
  onSetPrefs,
  onSelect,
  onMarkRead,
  onMarkAllRead,
  channels,
  subscribedChannelIds,
  inboxPeers,
  getDisplayName,
}: NotificationsScreenProps): React.JSX.Element {
  const c: Palette = colors;
  const [pane, setPane] = useState<Pane>('list');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('inapp');
  const [draft, setDraft] = useState<NotificationPrefs>(prefs ?? DEFAULT_PREFS);
  const [filter, setFilter] = useState<Filter>('all');
  // Optimistic read overrides layered over the snapshot's persisted flags: row taps add ids,
  // ✓✓ flips everything. The runtime persists in parallel (onMarkRead/onMarkAllRead).
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const [allRead, setAllRead] = useState(false);
  // Stands this page's own swipe-back down for touches beginning on the horizontal filter-chip
  // rail below — spread onto that ScrollView; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();

  // Reset to the list pane and reseed the draft from the latest persisted prefs each time the
  // modal opens — mirrors the open-time seed pattern used across the app's other settings sheets.
  useEffect(() => {
    if (!visible) return;
    setPane('list');
    setSettingsTab('inapp');
    setDraft(prefs ?? DEFAULT_PREFS);
    setFilter('all');
    setReadIds(new Set());
    setAllRead(false);
    // Only re-seed on the visible transition, not on every parent re-render (prefs identity churns
    // whenever the runtime emits) — same rationale as SettingsScreen's cbs-ref seed effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const commit = (next: NotificationPrefs): void => {
    setDraft(next);
    onSetPrefs(next);
  };

  const nameFor = (peer: string): string => {
    const known = getDisplayName?.(peer);
    if (known && known.trim()) return known;
    // Never the raw npub — a shortened, truncated form only.
    return shortenNpub(safeNpubEncode(peer), {lead: 10, tail: 4});
  };

  const isUnread = (item: NotifItem): boolean => !allRead && !item.read && !readIds.has(item.id);

  const sortedItems = [...items].sort((a, b) => b.ts - a.ts);
  const visibleItems = filter === 'all' ? sortedItems : sortedItems.filter(i => i.kind === filter);

  // Per-chip unread counts (All = total) — counts stay per-type regardless of the active filter.
  const unreadCountFor = (f: Filter): number =>
    sortedItems.reduce((n, i) => n + ((f === 'all' || i.kind === f) && isUnread(i) ? 1 : 0), 0);
  const hasUnread = unreadCountFor('all') > 0;

  // Recency sections. "Today" = the local calendar day; "This week" = the last 7 days; anything
  // older lands in "Earlier" (the design's dataset stops at a week — empty sections are omitted).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayFloor = Math.floor(startOfToday.getTime() / 1000);
  const weekFloor = Math.floor(Date.now() / 1000) - 7 * 86400;
  const sections = [
    {title: 'Today', items: visibleItems.filter(i => i.ts >= todayFloor)},
    {title: 'This week', items: visibleItems.filter(i => i.ts < todayFloor && i.ts >= weekFloor)},
    {title: 'Earlier', items: visibleItems.filter(i => i.ts < weekFloor)},
  ].filter(sec => sec.items.length > 0);

  const tapRow = useCallback(
    (item: NotifItem): void => {
      if (!allRead && !item.read && !readIds.has(item.id)) {
        setReadIds(prev => new Set(prev).add(item.id));
        onMarkRead?.(item.id);
      }
      onSelect(item.target);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRead, readIds, onMarkRead, onSelect],
  );

  const markAll = (): void => {
    if (!hasUnread) return;
    setAllRead(true);
    onMarkAllRead?.();
  };

  // One back action for BOTH the header chevron and the Android system back gesture
  // (Modal.onRequestClose): from settings it returns to the list; from the list it closes.
  // Routing the system back through onClose unconditionally would dump the user out of the
  // whole center from the settings pane.
  const goBack = (): void => {
    if (pane === 'settings') setPane('list');
    else onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={goBack}>
      {/* SafeAreaView, not View: a Modal renders in its own native view controller OUTSIDE the
          app's root SafeAreaView, so it must re-apply the top inset itself. Without this the header
          sits up in the status-bar row, flanking the Dynamic Island instead of below it. */}
      <SafeAreaView style={[s.page, {backgroundColor: c.bg}]}>
        {/* SwipeBackView wraps the SafeAreaView's children, not the SafeAreaView itself, so that
            opaque c.bg-colored root stays put as the backdrop while just the content slides away —
            see PLAN_SWIPE_BACK_GESTURE_2026-07-27.md's "Modal-hosted pages" note. `onBack` is
            `goBack`, the exact function the header ‹ and the Modal's own onRequestClose both call
            above, so the button, the hardware key and the swipe can never resolve to different
            panes. `enabled` stands down on the settings pane: `goBack` PEELS settings → list first
            rather than closing the modal, so a committed swipe there would slide this whole view
            off-screen while `goBack` only took it back to the list underneath — the page would be
            stranded mid-exit, not dismissed. */}
        <SwipeBackView onBack={goBack} enabled={pane === 'list'}>
          <View style={[s.header, {borderBottomColor: c.border}]}>
            <Press
              accessibilityLabel="Back"
              onPress={goBack}
              hitSlop={12}
              style={s.backBtn}>
              <Text style={[s.backText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>‹</Text>
            </Press>
            <Text
              style={[s.title, {color: c.textPrimary}]}
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {pane === 'settings' ? 'Notification settings' : 'Notifications'}
            </Text>
            {pane === 'list' ? (
              <>
                <Press
                  accessibilityLabel="Mark all read"
                  onPress={markAll}
                  disabled={!hasUnread}
                  style={s.headerBtn}>
                  {/* Nested double checkmark — negative tracking pulls the checks together. */}
                  <Text
                    style={[s.markAllText, {color: hasUnread ? c.accent : c.textMuted}]}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    ✓✓
                  </Text>
                </Press>
                <Press
                  accessibilityLabel="Notification settings"
                  onPress={() => setPane('settings')}
                  style={s.headerBtn}>
                  <Text style={[s.gearText, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    ⚙
                  </Text>
                </Press>
              </>
            ) : (
              <View style={s.headerBtn} />
            )}
          </View>

          {pane === 'list' ? (
            <>
              <View style={[s.chipsWrap, {borderBottomColor: c.border}]}>
                {/* A native horizontal ScrollView never joins JS PanResponder negotiation, so
                    without this opt-out the page-level swipe-back above would win any rightward
                    drag that starts on the chip strip and it would never get to scroll itself. */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.chipsRow}
                  {...optOut}>
                  {CHIPS.map(chip => {
                    const active = chip.id === filter;
                    const count = unreadCountFor(chip.id);
                    return (
                      <Press
                        key={chip.id}
                        accessibilityLabel={`Filter ${chip.label}`}
                        onPress={() => setFilter(chip.id)}
                        style={[s.chip, {backgroundColor: active ? c.accent : c.surface}]}>
                        <Text
                          style={[s.chipText, {color: active ? c.onAccent : c.textSecondary}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {chip.label}
                        </Text>
                        {count > 0 && (
                          <View
                            style={[
                              s.chipCount,
                              {backgroundColor: active ? 'rgba(255,255,255,0.25)' : c.accentSoft},
                            ]}>
                            <Text
                              style={[s.chipCountText, {color: active ? c.onAccent : c.accent}]}
                              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                              {count}
                            </Text>
                          </View>
                        )}
                      </Press>
                    );
                  })}
                </ScrollView>
              </View>

              {sections.length === 0 ? (
                <EmptyState
                  icon="🔔"
                  title="You're all caught up"
                  subtitle="Nothing new in this filter right now."
                />
              ) : (
                // Virtualized (the snapshot can be 100 rows of SVG avatars — mounting them all
                // synchronously inside the Modal's slide-in is what made opening the center janky).
                <SectionList
                  sections={sections.map(sec => ({title: sec.title, data: sec.items}))}
                  keyExtractor={item => item.id}
                  renderItem={({item}) => <NotifRow item={item} unread={isUnread(item)} onPress={tapRow} />}
                  renderSectionHeader={({section}) => (
                    <Text
                      style={[s.sectionTitle, {color: c.textMuted}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {section.title.toUpperCase()}
                    </Text>
                  )}
                  stickySectionHeadersEnabled={false}
                  showsVerticalScrollIndicator={false}
                  style={s.scroll}
                  initialNumToRender={10}
                  windowSize={7}
                  removeClippedSubviews
                  ListFooterComponent={<View style={s.bottomPad} />}
                />
              )}
            </>
          ) : (
            <>
              {/* Segmented tab: in-app (notification-center gates, unchanged) vs. push (OS-push
                  gates, layered on top — see prefs.ts isPushAllowed). Fixed above the scroll, like
                  the list pane's filter chips, so it stays reachable while the pane scrolls. */}
              <View style={[s.segWrap, {borderBottomColor: c.border}]}>
                <View style={[s.segRow, {backgroundColor: c.surface}]}>
                  <Press
                    accessibilityLabel="Settings tab In-app"
                    onPress={() => setSettingsTab('inapp')}
                    style={[s.segBtn, settingsTab === 'inapp' && {backgroundColor: c.accent}]}>
                    <Text
                      style={[
                        s.segText,
                        {color: settingsTab === 'inapp' ? c.onAccent : c.textSecondary},
                      ]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      In-app
                    </Text>
                  </Press>
                  <Press
                    accessibilityLabel="Settings tab Push"
                    onPress={() => setSettingsTab('push')}
                    style={[s.segBtn, settingsTab === 'push' && {backgroundColor: c.accent}]}>
                    <Text
                      style={[
                        s.segText,
                        {color: settingsTab === 'push' ? c.onAccent : c.textSecondary},
                      ]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Push
                    </Text>
                  </Press>
                </View>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} style={s.scroll}>
                {settingsTab === 'inapp' ? (
                  <InAppSettingsTab
                    draft={draft}
                    commit={commit}
                    channels={channels}
                    subscribedChannelIds={subscribedChannelIds}
                    inboxPeers={inboxPeers}
                    nameFor={nameFor}
                    c={c}
                  />
                ) : (
                  <PushSettingsTab draft={draft} commit={commit} c={c} />
                )}
                <View style={s.bottomPad} />
              </ScrollView>
            </>
          )}
        </SwipeBackView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Settings pane: In-app tab (unchanged behavior — the pre-push-split settings content) ────────

function InAppSettingsTab({
  draft,
  commit,
  channels,
  subscribedChannelIds,
  inboxPeers,
  nameFor,
  c,
}: {
  draft: NotificationPrefs;
  commit: (next: NotificationPrefs) => void;
  channels: Channel[];
  subscribedChannelIds: string[];
  inboxPeers?: string[];
  nameFor: (peer: string) => string;
  c: Palette;
}): React.JSX.Element {
  return (
    <>
      {/* General */}
      <SectionHeader label="GENERAL" color={c.textMuted} />
      <ToggleRow
        label="Hide names on lockscreen"
        sub="Show generic titles like “New message” instead of a name"
        value={draft.hideNamesOnLockscreen}
        onValueChange={v => commit({...draft, hideNamesOnLockscreen: v})}
        c={c}
      />

      {/* Direct messages */}
      <SectionHeader label="DIRECT MESSAGES" color={c.textMuted} />
      <ToggleRow
        label="Message notifications"
        value={draft.dms.enabled}
        onValueChange={v => commit({...draft, dms: {...draft.dms, enabled: v}})}
        c={c}
      />
      {(inboxPeers ?? []).length > 0 && (
        <Text style={[s.subLabel, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>PER-PERSON</Text>
      )}
      {(inboxPeers ?? []).map(peer => {
        const override = dmOverrideFor(draft, peer);
        return (
          <Press
            key={peer}
            variant="row"
            style={[s.row, {borderBottomColor: c.border}]}
            onPress={() => cycleDmOverride(draft, commit, peer)}>
            <View style={s.rowBody}>
              <Text style={[s.rowLabel, {color: c.textPrimary}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {nameFor(peer)}
              </Text>
            </View>
            <View style={[s.chipOutline, {borderColor: chipColor(override, c)}]}>
              <Text style={[s.chipOutlineText, {color: chipColor(override, c)}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {override === 'always' ? 'Always' : override === 'never' ? 'Never' : 'Default'}
              </Text>
            </View>
          </Press>
        );
      })}

      {/* Channels */}
      <SectionHeader label="CHANNELS" color={c.textMuted} />
      <ToggleRow
        label="Channel notifications"
        value={draft.channels.enabled}
        onValueChange={v => commit({...draft, channels: {...draft.channels, enabled: v}})}
        c={c}
      />
      {/* v1 generates notifications only for NIP-53 channel broadcasts, so only that
          channel-type toggle is exposed. The group/broadcast pref fields remain in the model
          (default on, no effect) for when those sources are wired — no dead toggles shown. */}
      <ToggleRow
        label="Channels"
        sub="NIP-53 live activities"
        value={draft.channels.byType.channel}
        onValueChange={v =>
          commit({...draft, channels: {...draft.channels, byType: {...draft.channels.byType, channel: v}}})
        }
        c={c}
      />

      {joinedChannels(channels, subscribedChannelIds).length > 0 && (
        <>
          <Text style={[s.subLabel, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>JOINED</Text>
          {joinedChannels(channels, subscribedChannelIds).map(ch => (
            <ToggleRow
              key={ch.id}
              label={ch.name}
              value={draft.channels.perChannel[ch.id] ?? true}
              onValueChange={() => togglePerChannel(draft, commit, ch.id)}
              c={c}
            />
          ))}
        </>
      )}
      {accessibleChannels(channels, subscribedChannelIds).length > 0 && (
        <>
          <Text style={[s.subLabel, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>OTHER</Text>
          {accessibleChannels(channels, subscribedChannelIds).map(ch => (
            <ToggleRow
              key={ch.id}
              label={ch.name}
              value={draft.channels.perChannel[ch.id] ?? true}
              onValueChange={() => togglePerChannel(draft, commit, ch.id)}
              c={c}
            />
          ))}
        </>
      )}

      {/* Post types */}
      <SectionHeader label="POST TYPES" color={c.textMuted} />
      {(Object.keys(POST_TYPE_LABEL) as PostType[]).map(pt => (
        <ToggleRow
          key={pt}
          label={POST_TYPE_LABEL[pt]}
          value={draft.postTypes[pt]}
          onValueChange={v => commit({...draft, postTypes: {...draft.postTypes, [pt]: v}})}
          c={c}
        />
      ))}

      {/* Replies */}
      <SectionHeader label="REPLIES" color={c.textMuted} />
      <ToggleRow
        label="Reply notifications"
        sub="When someone replies to your post"
        value={draft.replies}
        onValueChange={v => commit({...draft, replies: v})}
        c={c}
      />

      {/* Shared drafts (Phase 5§G) — its own category so muting draft chatter no longer also
          mutes group-join requests (owner side) or DMs (requester side). */}
      <SectionHeader label="SHARED DRAFTS" color={c.textMuted} />
      <ToggleRow
        label="Draft access"
        sub="When someone asks to read your draft, or an owner approves your request"
        value={draft.drafts}
        onValueChange={v => commit({...draft, drafts: v})}
        c={c}
      />
    </>
  );
}

// ── Settings pane: Push tab (new — the OS-push gate layered atop the In-app tab's gates) ────────
//
// Each row here mirrors an In-app category and is disabled (greyed, with an explanatory `sub`)
// whenever that in-app parent is off — push ⊆ in-app is enforced in prefs.ts's isPushAllowed, and
// this UI makes that constraint legible rather than showing an on-but-inert control. The master
// `push.enabled` switch is never itself disabled (it's the kill switch) but disables every row
// below it. `channels.byType.group`/`byType.broadcast` and `channels.perChannel` are intentionally
// NOT mirrored here for the same no-dead-toggles reason the In-app tab's Channels section omits them.

function PushSettingsTab({
  draft,
  commit,
  c,
}: {
  draft: NotificationPrefs;
  commit: (next: NotificationPrefs) => void;
  c: Palette;
}): React.JSX.Element {
  const masterOff = !draft.push.enabled;
  // Sub-copy for a category row: explain WHY it's inert, in priority order (master kill switch
  // first, since flipping it back on is the one action that un-greys everything at once).
  const subFor = (inAppParentOn: boolean): string | undefined => {
    if (masterOff) return 'Push notifications are off';
    if (!inAppParentOn) return 'Off in In-app';
    return undefined;
  };

  return (
    <>
      <SectionHeader label="PUSH" color={c.textMuted} />
      <ToggleRow
        label="Push notifications"
        sub="Master switch — turn off to silence all OS notifications"
        value={draft.push.enabled}
        onValueChange={v => commit({...draft, push: {...draft.push, enabled: v}})}
        c={c}
      />

      <SectionHeader label="DIRECT MESSAGES" color={c.textMuted} />
      <ToggleRow
        label="Message push"
        sub={subFor(draft.dms.enabled)}
        value={draft.push.dms}
        disabled={masterOff || !draft.dms.enabled}
        onValueChange={v => commit({...draft, push: {...draft.push, dms: v}})}
        c={c}
      />

      <SectionHeader label="CHANNELS" color={c.textMuted} />
      <ToggleRow
        label="Channel push"
        sub={subFor(draft.channels.enabled)}
        value={draft.push.channels}
        disabled={masterOff || !draft.channels.enabled}
        onValueChange={v => commit({...draft, push: {...draft.push, channels: v}})}
        c={c}
      />

      <SectionHeader label="POST TYPES" color={c.textMuted} />
      {(Object.keys(POST_TYPE_LABEL) as PostType[]).map(pt => (
        <ToggleRow
          key={pt}
          label={POST_TYPE_LABEL[pt]}
          sub={subFor(draft.postTypes[pt])}
          value={draft.push.postTypes[pt]}
          disabled={masterOff || !draft.postTypes[pt]}
          onValueChange={v =>
            commit({...draft, push: {...draft.push, postTypes: {...draft.push.postTypes, [pt]: v}}})
          }
          c={c}
        />
      ))}

      <SectionHeader label="REPLIES" color={c.textMuted} />
      <ToggleRow
        label="Reply push"
        sub={subFor(draft.replies)}
        value={draft.push.replies}
        disabled={masterOff || !draft.replies}
        onValueChange={v => commit({...draft, push: {...draft.push, replies: v}})}
        c={c}
      />

      <SectionHeader label="SHARED DRAFTS" color={c.textMuted} />
      <ToggleRow
        label="Draft access push"
        sub={subFor(draft.drafts)}
        value={draft.push.drafts}
        disabled={masterOff || !draft.drafts}
        onValueChange={v => commit({...draft, push: {...draft.push, drafts: v}})}
        c={c}
      />

      <Text style={[s.footerNote, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        Background delivery is checked periodically and may be delayed. Items always appear
        immediately in the In-app tab.
      </Text>
    </>
  );
}

// ── Settings-pane helpers (unchanged behavior from the pre-redesign screen) ─────────────────────

function joinedChannels(channels: Channel[], subscribed: string[]): Channel[] {
  return channels.filter(ch => subscribed.includes(ch.id));
}

function accessibleChannels(channels: Channel[], subscribed: string[]): Channel[] {
  return channels.filter(ch => !subscribed.includes(ch.id));
}

function dmOverrideFor(draft: NotificationPrefs, peer: string): 'always' | 'never' | undefined {
  return draft.dms.overrides[peer];
}

/** Cycles a DM peer's override: default -> always -> never -> default. */
function cycleDmOverride(
  draft: NotificationPrefs,
  commit: (next: NotificationPrefs) => void,
  peer: string,
): void {
  const cur = dmOverrideFor(draft, peer);
  const next: 'always' | 'never' | undefined =
    cur === undefined ? 'always' : cur === 'always' ? 'never' : undefined;
  const overrides = {...draft.dms.overrides};
  if (next === undefined) delete overrides[peer];
  else overrides[peer] = next;
  commit({...draft, dms: {...draft.dms, overrides}});
}

function togglePerChannel(
  draft: NotificationPrefs,
  commit: (next: NotificationPrefs) => void,
  id: string,
): void {
  const cur = draft.channels.perChannel[id] ?? true;
  commit({
    ...draft,
    channels: {...draft.channels, perChannel: {...draft.channels.perChannel, [id]: !cur}},
  });
}

function chipColor(v: 'always' | 'never' | undefined, c: Palette): string {
  if (v === 'always') return c.success;
  if (v === 'never') return c.danger;
  return c.textSecondary;
}

function SectionHeader({label, color}: {label: string; color: string}): React.JSX.Element {
  return (
    <Text style={[s.sectionLabel, {color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
      {label}
    </Text>
  );
}

function ToggleRow({
  label,
  sub,
  value,
  onValueChange,
  c,
  disabled,
}: {
  label: string;
  sub?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  c: Palette;
  /** Greys the row and blocks the switch — used by the Push tab to show push ⊆ in-app legibly. */
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <View style={[s.row, {borderBottomColor: c.border}, disabled && s.rowDisabled]}>
      <View style={s.rowBody}>
        <Text style={[s.rowLabel, {color: c.textPrimary}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{label}</Text>
        {sub ? <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{sub}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{false: c.border, true: c.accent}}
        thumbColor={c.onAccent}
      />
    </View>
  );
}

const s = StyleSheet.create({
  page: {flex: 1},

  // ── Header bar (design: gap 6, padding 6 10 10, bottom hairline) ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    // The SafeAreaView wrapper now supplies the top inset (status bar / Dynamic Island), so this is
    // just the header's own breathing room — not a hand-rolled status-bar offset as before.
    paddingTop: space.sm,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  // Full 40px touch target (+hitSlop 12) — the design's 2×8 padding made a sliver of a target on
  // real glass, which read as "the back button doesn't work".
  backBtn: {minWidth: 40, height: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4},
  backText: {fontSize: 24, lineHeight: 26, fontWeight: weight.regular},
  title: {fontSize: 17, fontWeight: weight.bold, flex: 1, textAlign: 'center'},
  headerBtn: {width: 30, height: 30, alignItems: 'center', justifyContent: 'center'},
  // ✓✓ — negative tracking nests the checks (design letter-spacing −0.18em @ 15px ≈ −2.7px).
  markAllText: {fontSize: 15, fontWeight: weight.bold, letterSpacing: -2.7, paddingRight: 3},
  gearText: {fontSize: 16},

  // ── Filter chips (design: gap 7, padding 12 16, bottom hairline) ──
  chipsWrap: {borderBottomWidth: 1},
  chipsRow: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 12},
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 13,
    borderRadius: radius.pill,
  },
  chipText: {fontSize: 13, fontWeight: weight.semibold},
  chipCount: {borderRadius: radius.pill, paddingVertical: 1.5, paddingHorizontal: 6},
  chipCountText: {fontSize: 10.5, fontWeight: weight.bold},

  // ── Settings-pane segmented tab (In-app | Push) — a two-up pill switch, fixed above the scroll. ──
  segWrap: {borderBottomWidth: 1, paddingHorizontal: space.lg, paddingVertical: space.md},
  segRow: {flexDirection: 'row', borderRadius: radius.pill, padding: 3},
  segBtn: {flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.pill},
  segText: {fontSize: 13, fontWeight: weight.semibold},

  scroll: {flex: 1},

  // ── Section headers ──
  sectionTitle: {
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.9,
    paddingTop: 16,
    paddingHorizontal: 18,
    paddingBottom: 8,
  },

  // ── Notification rows ──
  notifRowInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  avatarWrap: {position: 'relative'},
  typeBadge: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Public-post marker: a large megaphone filling the identity circle (no corner badge), so a
  // post row can never be mistaken for a DM row.
  postGlyphOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifBody: {flex: 1, minWidth: 0},
  line1: {fontSize: 14, lineHeight: 19},
  actor: {fontWeight: weight.bold},
  action: {fontWeight: weight.regular},
  target: {fontWeight: weight.semibold},
  preview: {fontSize: 13, lineHeight: 19, marginTop: 3},
  meta: {alignItems: 'flex-end', gap: 7, paddingTop: 2},
  time: {fontSize: 12},
  unreadDot: {width: 8, height: 8, borderRadius: 4},

  // ── Settings pane (unchanged) ──
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.md,
  },
  rowBody: {flex: 1},
  rowLabel: {fontSize: typeScale.body},
  rowSub: {fontSize: typeScale.caption, marginTop: 2},
  // Push tab: a row whose in-app parent (or the master push switch) is off renders inert, not just
  // silently present — dimmed plus the `sub` explanation set by PushSettingsTab's subFor().
  rowDisabled: {opacity: 0.45},

  chipOutline: {borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 5},
  chipOutlineText: {fontSize: typeScale.caption, fontWeight: weight.semibold},

  // Push tab footer — qualitative-only latency note (no numbers, no "Tor"; the background-delivery
  // cadence is owned by a separate workstream and is expected to change under this copy).
  footerNote: {
    fontSize: typeScale.caption,
    lineHeight: 18,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: 6,
  },
  subLabel: {
    fontSize: 11,
    fontWeight: weight.semibold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 4,
  },

  bottomPad: {height: 32},
});

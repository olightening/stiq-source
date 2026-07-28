/**
 * ConversationView — one DM thread + composer (PLAN.md §3 / Step 17).
 *
 * Re-skinned to the Stiq "Channels & Messages" handoff (Screen 4 — DM conversation +
 * Overlay B — DM detail sheet). The DM backend (NIP-17, send path) is unchanged: this is a
 * pure restyle that adds the tappable identity header, the encrypted empty state, the blocked
 * footer, and the DM detail sheet (mute / block / unblock). Messages render through the shared
 * `ChatBubble` primitive so DMs and group chats share exactly one bubble implementation.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, FlatList, KeyboardAvoidingView, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {decodeNameHeader} from '../../profile/displayName';
import {ensureSavedEmbedsLoaded, listSavedEmbeds, savedEmbedIsPrivate, savedEmbedUri, toSavedEmbedRow, type SavedEmbed, type SavedEmbedRow} from '../../channels/savedEmbeds';
import {dmMuteId, isSourceMuted, toggleMute} from '../../notifications/notifications';
import {blockPeer, unblockPeer, useBlocklist} from '../blocklist';
import type {Conversation} from '../conversations';
import type {DirectMessage} from '../dm';
import {colors, space, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {JumpButton} from '../../ui/JumpButton';
import {BackButton} from '../../ui/BackButton';
import {useReturnToLatest} from '../../ui/useReturnToLatest';
import {SearchTimeButton} from '../../ui/SearchTimeButton';
import {TimeFrameSheet} from '../../ui/TimeFrameSheet';
import {ALL_TIME, filterByTime, selectionToRange, type TimeSelection} from '../../ui/timeframe';
import {useSwipeOptOut} from '../../ui/swipeOptOut';
import {ChatBubble, QuotedReply, SwipeToReply, shortNpub} from '../../channels/components/primitives';
import {ReactionBar} from '../../channels/components/ReactionPicker';
import {VoiceComposer} from '../../feed/components/VoiceComposer';
import {MessageComposer} from '../../feed/components/MessageComposer';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {encodeInlineVoice} from '../../feed/voice';
import {inlineMediaSummary} from '../../feed/inlineMedia';
import {PictureComposer} from '../../feed/components/PictureComposer';
import {extractInlinePictures} from '../../feed/picture';
import {DEFAULT_PICTURE_RULES, type PictureRules} from '../../feed/pictureRules';
import type {PostRules} from '../../feed/postRules';
import type {DraftStoreApi, DraftLocation} from '../../feed/drafts';
import {useInProgressDraft} from '../../feed/useInProgressDraft';
import {calmRejection} from '../../feed/rejectionMessages';
import type {GradientSpec} from '../../media/gradient';
import type {NostrEventSummary} from '../../ui/NostrLinkPreview';

export interface ConversationViewProps {
  conversation: Conversation;
  selfPubkey: string;
  /** Resolved display name for the peer, if known — shown instead of the shortened npub. */
  peerDisplayName?: string;
  /**
   * Live identity-gradient lookup, called at render time with the peer's hex pubkey (mirrors
   * InboxList's `getPeerGradient`). Preferred over the static {@link peerGradient} prop below —
   * a caller that re-resolves gradients as they arrive (identity beacons, profile updates) stays
   * live instead of freezing whatever gradient was known at mount. Falls back to `peerGradient`,
   * then to the npub-seed-derived gradient, when it returns undefined.
   */
  getPeerGradient?: (pubkeyHex: string) => GradientSpec | undefined;
  /** Send a message; `replyTo` is the shared rumor id of the message being replied to (swipe-to-reply). */
  onSend: (text: string, replyTo?: string) => void;
  /** React to a message by its shared rumor id with an emoji (⋯ → any emoji). */
  onReact?: (targetRumorId: string, emoji: string) => void;
  /** Retry a failed ('✕') outgoing message by its echo id (peer already bound; see AppRuntime.retryDm). */
  onRetry?: (echoId: string) => void;
  onBack?: () => void;
  /** Open the peer's profile — shown as a "View profile" row in the DM detail sheet. Omit to hide it. */
  onOpenProfile?: () => void;
  /**
   * Resolve a referenced Nostr event (nostr:nevent/note/naddr) for inline embed previews — both the
   * composer's saved-post picker AND, threaded down through DmRow → DmBubble → ChatBubble → RichText,
   * the embed card rendered inside a message body. Named to match RichText's own prop exactly so the
   * whole chain shares one contract.
   */
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  /** Open a quoted post embedded inline in a message body. Threaded to ChatBubble/RichText verbatim. */
  onOpenNostrPost?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card in a message body → run the in-app accept-invite flow. */
  onOpenInviteLink?: (url: string) => void;
  /**
   * The blocked state. Production passes the EFFECTIVE block (the local device-only decision layered
   * over any moderator removal, computed in AppRuntime). When omitted, ConversationView falls back to
   * the local DM blocklist module directly (standalone/tests).
   */
  blocked?: boolean;
  /**
   * The Block action. Production routes this to AppRuntime.blockDmPeer (local-only; nothing published
   * to the relay). When omitted, ConversationView blocks the peer in the local module directly.
   */
  onBlock?: () => void;
  /**
   * The Unblock action. Production routes this to AppRuntime.unblockDmPeer (records a local allow that
   * also overrides a moderator auto-block). When omitted, ConversationView unblocks in the module.
   */
  onUnblock?: () => void;
  /** Saved-embed handler for the composer 🔖 button. Optional — defaults to a visible no-op. */
  onOpenSaved?: () => void;
  /** Npub override for the peer (else `conversation.peerNpub`). */
  peerNpub?: string;
  /** Organizer allows voice — shows the 🎙️ in the composer to embed a clip inline (No.9). */
  allowVoice?: boolean;
  /** Organizer picture limits — shows the 🖼️ "Add picture" option + enforces the allowance. */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has spent this period (allowance gate). */
  picturesSpentBytes?: number;
  /** Organizer post rules — supplies the expanded editor's universal long-body caps (words + media).
   *  Absent ⇒ unbounded, which is also the relay's default. */
  postRules?: PostRules;
  /** Persists the in-progress message so an unsent draft is restored on reopen (No.7). */
  draftStore?: DraftStoreApi;
  /** Open the unified Drafts list from the expanded editor's byline. */
  onOpenDrafts?: () => void;
}

export function ConversationView({
  conversation,
  selfPubkey,
  peerDisplayName,
  getPeerGradient,
  onSend,
  onReact,
  onRetry,
  onBack,
  onOpenProfile,
  onLookupEvent,
  onOpenNostrPost,
  onOpenInviteLink,
  blocked: blockedProp,
  onBlock: onBlockProp,
  onUnblock: onUnblockProp,
  peerNpub,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  postRules,
  draftStore,
  onOpenDrafts,
}: ConversationViewProps): React.JSX.Element {
  // Production drives the blocked state via the `blocked` prop (the effective block: local decision ⊕
  // moderator removal). The local-module read is the standalone fallback used only when no prop is
  // passed; subscribing to it keeps the footer live in that mode.
  const blockedFromModule = useBlocklist(conversation.peer);
  const blocked = blockedProp ?? blockedFromModule;
  // Stands this page's own swipe-back down for touches beginning on the in-conversation search
  // field below — spread onto that TextInput; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();
  // Live gradient lookup (No.9): resolved at render time from the peer's hex pubkey, so a gradient
  // that arrives/changes after mount (identity beacon, profile update) is reflected immediately —
  // unlike a static prop baked in by the caller at mount; falls back (inside GradientAvatar) to the
  // npub-seed-derived gradient.
  const peerGradient = getPeerGradient?.(conversation.peer);
  const lookupEvent = onLookupEvent;
  const [muted, setMuted] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // In-conversation search: the DM renders as a full-screen overlay that hides the app's global
  // search icon, so it carries its own. Filters the transcript by decoded (visible) message text.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [timeSel, setTimeSel] = useState<TimeSelection>(ALL_TIME);
  const [timeSheetOpen, setTimeSheetOpen] = useState(false);
  const toggleSearch = (): void => { setSearchOpen(o => !o); setSearchText(''); setTimeSel(ALL_TIME); };
  /** When set, the composer is replying to this message (swipe-to-reply). */
  const [replyingTo, setReplyingTo] = useState<{id: string; name: string; text: string} | null>(null);
  /** ⋯ reaction menu target / who-reacted sheet target (a message). */
  const [reactMenuFor, setReactMenuFor] = useState<DirectMessage | null>(null);
  const [whoFor, setWhoFor] = useState<DirectMessage | null>(null);
  // DMs are bottom-anchored (newest at the bottom), like a messenger. The transcript is an INVERTED
  // FlatList: data is newest-first and index 0 sits at the visual bottom, so the newest message is
  // pinned to the bottom without any manual scroll-to-end, and long histories are windowed (only
  // on-screen bubbles mount). For an inverted list the "latest" edge is contentOffset.y === 0, which
  // is exactly the 'top' anchor's distance math — so useReturnToLatest('top') drives the FAB here.
  const listRef = useRef<FlatList<DirectMessage>>(null);
  const jump = useReturnToLatest('top');
  const scrollToLatest = useCallback(() => {
    listRef.current?.scrollToOffset({offset: 0, animated: true});
  }, []);
  const [savedOpen, setSavedOpen] = useState(false);
  // Pending saved embed to splice into the composer draft: the composer owns its own draft state (so
  // a keystroke re-renders only the composer, not the transcript), so the saved-embed picker hands
  // the encoded URI down through a prop the composer consumes and clears.
  const [pendingEmbed, setPendingEmbed] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedEmbed[]>(() => listSavedEmbeds().slice());
  useEffect(() => { void ensureSavedEmbedsLoaded().then(() => setSaved(listSavedEmbeds().slice())); }, []);
  // Refresh the saved list whenever the picker opens (it may have changed since mount).
  useEffect(() => { if (savedOpen) setSaved(listSavedEmbeds().slice()); }, [savedOpen]);
  const embedSaved = (item: SavedEmbed): void => {
    setSavedOpen(false);
    // A private-content embed (a post from a private space) confirms first — it travels with its text.
    if (savedEmbedIsPrivate(item)) {
      Alert.alert(
        'Embed from a private space?',
        'This post is from a private space. Its content travels inside the embed — anyone who can see where you post it will be able to read it.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Insert anyway', style: 'destructive', onPress: () => setPendingEmbed(savedEmbedUri(item))},
        ],
      );
      return;
    }
    setPendingEmbed(savedEmbedUri(item));
  };
  // The saved posts, shaped for the full editor's embed picker (`+` → Expand to editor). One shared
  // row builder handles every embed kind (post, space, event, private-space post, draft) identically.
  const editorEmbeds: SavedEmbedRow[] = useMemo(
    () =>
      saved.map(item => {
        const selfContained =
          item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
        return toSavedEmbedRow(item, selfContained ? undefined : lookupEvent?.(item.id));
      }),
    [saved, lookupEvent],
  );
  const muteId = dmMuteId(conversation.peer);

  useEffect(() => {
    void isSourceMuted(muteId).then(setMuted);
  }, [muteId]);

  const handleMuteToggle = (): void => {
    void toggleMute(muteId)
      .then(setMuted)
      .catch(() => {
        // toggleMute already reverted its in-memory mute-set on a failed write, and `muted` was
        // never optimistically flipped here — just tell the user it didn't take.
        Alert.alert('Could not update mute setting', 'Please try again.');
      });
  };

  // In-progress message autosave (No.7): an unsent draft persists per DM peer and is restored on
  // reopen. DMs have no edit mode, so every keystroke persists into the slot. Phase 4: the full
  // editor (ComposerScreen, inside <Composer/>) now self-persists into this SAME location's slot via
  // its own `draftStore`/`draftLocation` props — `slot` is only still needed for what ComposerScreen
  // can't reach: the compact MessageComposer's own keystrokes, load-on-mount hydration, and send-clear.
  const draftLoc = useMemo<DraftLocation>(
    () => ({
      kind: 'channel',
      channelId: conversation.peer,
      channelType: 'dm',
      channelName: peerDisplayName ?? shortNpub(peerNpub ?? conversation.peerNpub),
    }),
    [conversation.peer, conversation.peerNpub, peerDisplayName, peerNpub],
  );
  const slot = useInProgressDraft(draftStore, draftLoc);

  const npub = peerNpub ?? conversation.peerNpub;
  const name = peerDisplayName ?? shortNpub(npub);
  const searchQ = searchText.trim().toLowerCase();
  const dmRange = useMemo(() => selectionToRange(timeSel), [timeSel]);
  // While search is open, narrow the transcript by the chosen time frame first, then by text.
  const visibleMessages = useMemo(() => {
    if (!searchOpen) return conversation.messages;
    const timeFiltered = filterByTime(conversation.messages, m => m.createdAt, dmRange);
    return searchQ
      ? timeFiltered.filter(m => decodeNameHeader(m.text).text.toLowerCase().includes(searchQ))
      : timeFiltered;
  }, [searchOpen, conversation.messages, dmRange, searchQ]);
  // Inverted FlatList data is newest-first (index 0 = visual bottom). Reverse once per snapshot.
  const invertedData = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const isEmpty = conversation.messages.length === 0;
  // Messages keyed by the SHARED rumor id (not the per-recipient wrap id) so a reply resolves its
  // quoted parent on BOTH sides. A just-sent echo has no rumor id yet, so it is skipped.
  const byId = useMemo(() => {
    const m = new Map<string, DirectMessage>();
    for (const msg of conversation.messages) if (msg.rumorId) m.set(msg.rumorId, msg);
    return m;
  }, [conversation.messages]);
  const quoteName = useCallback(
    (msg: DirectMessage): string => (msg.sender === selfPubkey ? 'You' : name),
    [selfPubkey, name],
  );
  // Per-message handlers are STABLE (useCallback) so the memoized DmRow's props don't change every
  // render — a composer keystroke (draft now lives in <Composer/>) no longer re-renders the bubbles.
  const beginReply = useCallback((msg: DirectMessage): void => {
    setReplyingTo({
      id: msg.rumorId, // reference the parent by its shared rumor id (cross-party correct)
      name: quoteName(msg),
      text: inlineMediaSummary(decodeNameHeader(msg.text).text),
    });
  }, [quoteName]);
  const openReactMenu = useCallback((msg: DirectMessage): void => setReactMenuFor(msg), []);
  const showReactors = useCallback((msg: DirectMessage): void => setWhoFor(msg), []);

  const openDetail = (): void => setDetailOpen(true);
  const closeDetail = (): void => setDetailOpen(false);
  const handleOpenProfile = (): void => {
    closeDetail();
    onOpenProfile?.();
  };

  const handleBlock = (): void => {
    closeDetail();
    // Persist to the local DM blocklist directly (default), or defer to a caller-provided override.
    if (onBlockProp) onBlockProp();
    else void blockPeer(conversation.peer);
  };
  const handleUnblock = (): void => {
    closeDetail();
    if (onUnblockProp) onUnblockProp();
    else void unblockPeer(conversation.peer);
  };

  return (
    // SafeAreaView (not View): ConversationView renders inside MainScreen's DM overlay, which is
    // position:absolute top:0 and covers the app's root SafeAreaView — so this screen must re-apply
    // the top inset itself, or the header flanks the Dynamic Island. This is the single top inset.
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
    <SafeAreaView style={s.root}>
      {/* Header — back chevron + tappable identity block + ⋯, both open the detail sheet */}
      <View style={s.header}>
        {onBack && <BackButton onPress={onBack} style={s.backBtn} />}
        <Press style={s.identity} onPress={openDetail} accessibilityLabel="open-dm-detail">
          <GradientAvatar gradient={peerGradient} seed={npub} size={32} shape="circle" />
          <View style={s.peerText}>
            <Text style={s.peerName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
            <Text style={s.peerNpub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub)}</Text>
          </View>
        </Press>
        <Press onPress={toggleSearch} style={s.searchBtn} accessibilityLabel="search-dm">
          <Text style={[s.searchIcon, searchOpen && s.searchIconOn]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔍</Text>
        </Press>
        <Press onPress={openDetail} style={s.moreBtn} accessibilityLabel="dm-menu">
          <Text style={s.moreDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
        </Press>
      </View>

      {/* In-conversation search bar (self-contained — see searchOpen). */}
      {searchOpen && (
        <View style={s.searchBar}>
          {/* A TextInput's own selection-handle drag doesn't join JS PanResponder negotiation, so
              without this opt-out the page-level swipe-back would win a rightward drag started
              inside the field instead of moving the cursor. */}
          <TextInput
            style={s.searchInput}
            value={searchText}
            onChangeText={setSearchText}
            placeholder="Search this conversation…"
            placeholderTextColor={colors.textMuted}
            autoFocus
            returnKeyType="search"
            {...optOut}
          />
          <SearchTimeButton selection={timeSel} onPress={() => setTimeSheetOpen(true)} />
          <Press style={s.searchClose} onPress={toggleSearch} accessibilityLabel="cancel-search">
            <Text style={s.searchCloseText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕</Text>
          </Press>
        </View>
      )}

      {/* Transcript — an INVERTED FlatList (newest at the visual bottom). Inverting windows the list
          (only on-screen bubbles mount) AND pins the newest message to the bottom with no manual
          scroll-to-end, on open and as messages arrive. */}
      <View style={s.transcriptWrap}>
      {isEmpty ? (
        <Text style={s.emptyState} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          🔒 This is the start of your encrypted conversation with {name}.
        </Text>
      ) : invertedData.length === 0 ? (
        <Text style={s.emptyState} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>No messages match “{searchText.trim()}”.</Text>
      ) : (
        <FlatList
          ref={listRef}
          inverted
          data={invertedData}
          keyExtractor={dmKey}
          style={s.transcript}
          contentContainerStyle={s.list}
          onScroll={jump.onScroll}
          onMomentumScrollEnd={jump.onScroll}
          onScrollEndDrag={jump.onScroll}
          scrollEventThrottle={16}
          maxToRenderPerBatch={8}
          windowSize={11}
          initialNumToRender={12}
          // #13a: RN's default 'never' makes the ScrollView capture every touch in the capture
          // phase while the keyboard is up, so SwipeToReply's PanResponder never even starts.
          // 'handled' lets a row's own responder (swipe-to-reply) claim the gesture first.
          keyboardShouldPersistTaps="handled"
          renderItem={({item}) => (
            <DmRow
              item={item}
              mine={item.sender === selfPubkey}
              parent={item.replyTo ? byId.get(item.replyTo) : undefined}
              quoteName={quoteName}
              onBeginReply={blocked ? undefined : beginReply}
              onOpenMenu={onReact && !blocked ? openReactMenu : undefined}
              onReactTo={onReact && !blocked ? onReact : undefined}
              onRetry={onRetry && !blocked ? onRetry : undefined}
              onShowReactors={showReactors}
              onLookupEvent={lookupEvent}
              onOpenNostrPost={onOpenNostrPost}
              onOpenInviteLink={onOpenInviteLink}
              peerGradient={peerGradient}
              peerSeed={npub}
            />
          )}
        />
      )}
        <JumpButton visible={jump.showJump} direction="down" onPress={scrollToLatest} />
      </View>

      {/* Composer (hidden when blocked). Its draft state lives INSIDE <Composer/> so a keystroke
          re-renders only the composer, not the (potentially long) transcript above. */}
      {blocked ? (
        <View style={s.blockedFooter}>
          <Text style={s.blockedText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🚫 You blocked this user. </Text>
          <Press onPress={handleUnblock}>
            <Text style={s.blockedUnblock} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Unblock</Text>
          </Press>
        </View>
      ) : (
        <Composer
          slot={slot}
          draftStore={draftStore}
          draftLocation={draftLoc}
          peerName={name}
          peerPubkey={conversation.peer}
          peerGradient={peerGradient}
          replyingTo={replyingTo}
          onClearReply={() => setReplyingTo(null)}
          onSend={onSend}
          onOpenSavedPicker={() => setSavedOpen(true)}
          pendingEmbed={pendingEmbed}
          onEmbedConsumed={() => setPendingEmbed(null)}
          editorEmbeds={editorEmbeds}
          allowVoice={allowVoice}
          pictureRules={pictureRules}
          picturesSpentBytes={picturesSpentBytes}
          postRules={postRules}
          onOpenDrafts={onOpenDrafts}
        />
      )}

      {/* SAVED · TAP TO EMBED picker — embeds a saved post/comment into the message. */}
      <Modal visible={savedOpen} transparent animationType="slide" onRequestClose={() => setSavedOpen(false)}>
        <Press variant="bare" style={s.scrim} onPress={() => setSavedOpen(false)} accessibilityRole="none" />
        <View style={s.savedWrap}>
          <View style={s.savedCard}>
            <View style={s.savedHeader}>
              <Text style={s.savedHeaderLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>SAVED · TAP TO EMBED</Text>
              <Text style={s.savedHeaderCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{saved.length} saved</Text>
            </View>
            {saved.length === 0 ? (
              <Text style={s.savedEmpty} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Nothing saved yet. Use a post's ⋯ → “Save to embed later”.</Text>
            ) : (
              <ScrollView style={s.savedList}>
                {saved.map(item => {
                  const selfContained =
                    item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
                  const row = toSavedEmbedRow(item, selfContained ? undefined : lookupEvent?.(item.id));
                  return (
                    <Press key={item.id} variant="row" style={s.savedRow} onPress={() => embedSaved(item)} accessibilityLabel={`${row.title}, tap to embed`}>
                      <Text style={s.savedRowLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.label}</Text>
                      <Text style={s.savedRowTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.title}</Text>
                      {row.snippet ? <Text style={s.savedRowSnippet} numberOfLines={2} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.snippet}</Text> : null}
                    </Press>
                  );
                })}
              </ScrollView>
            )}
          </View>
          <Press style={s.savedDone} onPress={() => setSavedOpen(false)}>
            <Text style={s.savedDoneText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
          </Press>
        </View>
      </Modal>

      {/* ⋯ react — pick any emoji for this message. */}
      <Modal visible={!!reactMenuFor} transparent animationType="fade" onRequestClose={() => setReactMenuFor(null)}>
        <Press variant="bare" style={s.scrim} onPress={() => setReactMenuFor(null)} accessibilityRole="none" />
        <View style={s.reactMenuWrap}>
          <View style={s.reactMenuCard}>
            <ReactionBar onPick={emoji => { if (reactMenuFor) onReact?.(reactMenuFor.rumorId, emoji); setReactMenuFor(null); }} />
          </View>
        </View>
      </Modal>

      {/* Who reacted — in a 1:1 DM the reactor is you or the peer. */}
      <Modal visible={!!whoFor} transparent animationType="fade" onRequestClose={() => setWhoFor(null)}>
        <Press variant="bare" style={s.scrim} onPress={() => setWhoFor(null)} accessibilityRole="none" />
        <View style={s.reactMenuWrap}>
          <View style={s.savedCard}>
            <View style={s.savedHeader}>
              <Text style={s.savedHeaderLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>WHO REACTED</Text>
              <Text style={s.savedHeaderCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{whoFor?.reactions?.reduce((n, t) => n + t.count, 0) ?? 0}</Text>
            </View>
            <ScrollView style={s.savedList}>
              {(whoFor?.reactions ?? []).flatMap(t =>
                t.pubkeys.map(pk => (
                  <View key={`${t.emoji}:${pk}`} style={s.reactorRow}>
                    <GradientAvatar
                      gradient={pk === selfPubkey ? undefined : peerGradient}
                      seed={pk === selfPubkey ? selfPubkey : npub}
                      size={26}
                      shape="circle"
                    />
                    <Text style={s.reactorName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{pk === selfPubkey ? 'You' : name}</Text>
                    <Text style={s.reactorEmoji} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t.emoji}</Text>
                  </View>
                )),
              )}
            </ScrollView>
          </View>
          <Press style={s.savedDone} onPress={() => setWhoFor(null)}>
            <Text style={s.savedDoneText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
          </Press>
        </View>
      </Modal>

      {/* Overlay B — DM detail sheet */}
      <Modal visible={detailOpen} transparent animationType="slide" onRequestClose={closeDetail}>
        <Press variant="bare" style={s.scrim} onPress={closeDetail} accessibilityLabel="close-dm-detail" accessibilityRole="none" />
        <View style={s.sheet}>
          <View style={s.grabberRow}>
            <View style={s.grabber} />
          </View>

          <View style={s.sheetHead}>
            <GradientAvatar gradient={peerGradient} seed={npub} size={72} shape="circle" style={s.sheetAvatar} />
            <Text style={s.sheetName} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
            <Text style={s.sheetNpub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub)}</Text>
            <Text style={s.sheetEncrypted} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔒 Messages are end-to-end encrypted.</Text>
          </View>

          <View style={s.sheetActions}>
            <View style={s.muteRow}>
              <Text style={s.muteLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔕 Mute notifications</Text>
              <Switch
                value={muted}
                onValueChange={handleMuteToggle}
                trackColor={{false: colors.borderLight, true: colors.accent}}
                thumbColor={colors.onAccent}
              />
            </View>

            {onOpenProfile && (
              <Press variant="row" style={s.profileRow} onPress={handleOpenProfile} accessibilityLabel="view-profile">
                <Text style={s.profileLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>👤 View profile</Text>
              </Press>
            )}

            {blocked ? (
              <Press variant="row" style={s.dangerRow} onPress={handleUnblock}>
                <Text style={s.unblockLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Unblock user</Text>
              </Press>
            ) : (
              <Press variant="row" style={s.dangerRow} onPress={handleBlock}>
                <Text style={s.blockLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🚫 Block user</Text>
              </Press>
            )}
          </View>
        </View>
      </Modal>

      {/* Time-frame picker for the conversation search (mirrors the app's global search). */}
      <TimeFrameSheet
        visible={timeSheetOpen}
        value={timeSel}
        onClose={() => setTimeSheetOpen(false)}
        onApply={setTimeSel}
      />
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/** Stable keyExtractor (module-level, so its identity never changes across renders).
 *  `localId ?? id`: sendDM mutates an outgoing echo's `id` from its optimistic `local-…` value to
 *  the real gift-wrap id once PoW sealing finishes — keying on `id` alone remounted the just-sent
 *  bubble (the bottom-most, most visible row) mid-send. `localId` survives that adoption. */
const dmKey = (m: DirectMessage): string => m.localId ?? m.id;

/**
 * DmRow — the FlatList cell. It is React.memo'd and receives STABLE callbacks (the per-message
 * binding — `() => onBeginReply(item)` etc. — happens INSIDE the memo boundary, so its props are
 * value-stable across a parent re-render). A composer keystroke re-renders only the composer, and a
 * relay snapshot re-renders only the rows whose message object actually changed. It also builds the
 * quoted-reply element from the resolved `parent`, so the parent render body allocates no elements.
 */
const DmRow = React.memo(function DmRow({
  item,
  mine,
  parent,
  quoteName,
  onBeginReply,
  onOpenMenu,
  onReactTo,
  onRetry,
  onShowReactors,
  onLookupEvent,
  onOpenNostrPost,
  onOpenInviteLink,
  peerGradient,
  peerSeed,
}: {
  item: DirectMessage;
  mine: boolean;
  /** The message this one replies to (resolved by shared rumor id), if any. */
  parent?: DirectMessage;
  quoteName: (msg: DirectMessage) => string;
  onBeginReply?: (msg: DirectMessage) => void;
  onOpenMenu?: (msg: DirectMessage) => void;
  onReactTo?: (targetRumorId: string, emoji: string) => void;
  onRetry?: (echoId: string) => void;
  onShowReactors?: (msg: DirectMessage) => void;
  /** #12 — resolve/open a nostr: embed referenced inline in the message body. Same names as RichText. */
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  onOpenInviteLink?: (url: string) => void;
  /** The peer's real (often claimed) gradient — SAME value the header/detail-sheet avatar uses. */
  peerGradient?: GradientSpec;
  /** Stable seed (peer npub) for the gradient fallback when no claimed gradient is known yet. */
  peerSeed?: string;
}): React.JSX.Element {
  const quote = item.replyTo ? (
    <QuotedReply
      tone={mine ? 'onAccent' : 'default'}
      name={parent ? quoteName(parent) : 'Message'}
      text={parent ? inlineMediaSummary(decodeNameHeader(parent.text).text) : ''}
    />
  ) : undefined;
  return (
    <DmBubble
      item={item}
      mine={mine}
      quote={quote}
      onReply={onBeginReply ? () => onBeginReply(item) : undefined}
      onMenu={onOpenMenu ? () => onOpenMenu(item) : undefined}
      onReact={onReactTo ? emoji => onReactTo(item.rumorId, emoji) : undefined}
      onRetry={onRetry ? () => onRetry(item.id) : undefined}
      onShowReactors={onShowReactors && item.reactions?.length ? () => onShowReactors(item) : undefined}
      onLookupEvent={onLookupEvent}
      onOpenNostrPost={onOpenNostrPost}
      onOpenInviteLink={onOpenInviteLink}
      peerGradient={peerGradient}
      peerSeed={peerSeed}
    />
  );
});

/**
 * DmBubble — wraps the shared ChatBubble and appends the delivery-status glyph on your own
 * messages (· sending, ✓ sent, ✕ failed). DMs are 1:1, so no senderName is passed (no name label
 * over every incoming bubble) — but the per-message avatar on incoming messages (ChatBubble's
 * "theirs" branch always renders one) MUST still match the peer's real identity, so `peerGradient`/
 * `peerSeed` — the SAME values the DM header and detail sheet render — are threaded straight through
 * to ChatBubble's `senderGradient`/`senderSeed`. Without this the avatar fell back to a default
 * gradient derived from an empty seed, which never matched the peer's claimed gradient shown
 * everywhere else in the DM.
 */
const DmBubble = React.memo(function DmBubble({
  item,
  mine,
  quote,
  onReply,
  onMenu,
  onReact,
  onRetry,
  onShowReactors,
  onLookupEvent,
  onOpenNostrPost,
  onOpenInviteLink,
  peerGradient,
  peerSeed,
}: {
  item: DirectMessage;
  mine: boolean;
  quote?: React.ReactNode;
  onReply?: () => void;
  onMenu?: () => void;
  onReact?: (emoji: string) => void;
  onRetry?: () => void;
  onShowReactors?: () => void;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  onOpenInviteLink?: (url: string) => void;
  peerGradient?: GradientSpec;
  peerSeed?: string;
}): React.JSX.Element {
  const statusIcon =
    item.status === 'sending' ? '·' :
    item.status === 'failed' ? '✕' :
    item.status === 'sent' ? '✓' : '';
  // A failed send now shows WHY + a Retry (the thread had no retry before). The raw seal/relay reason
  // is mapped to calm copy here at render (calmRejection), matching how posts surface Outbox.reasons().
  const failReason = (() => {
    if (item.status !== 'failed' || !item.failureReason) return '';
    const calm = calmRejection(item.failureReason);
    return [calm.text, calm.nextStep].filter(Boolean).join(' ');
  })();
  return (
    <SwipeToReply onReply={onReply ?? (() => {})} enabled={!!onReply}>
      <View>
        <ChatBubble
          mine={mine}
          content={decodeNameHeader(item.text).text}
          quote={quote}
          onMenu={onMenu}
          reactions={item.reactions}
          onReactEmoji={onReact}
          onShowReactors={onShowReactors}
          onLookupEvent={onLookupEvent}
          onOpenNostrPost={onOpenNostrPost}
          onOpenInviteLink={onOpenInviteLink}
          senderGradient={mine ? undefined : peerGradient}
          senderSeed={mine ? undefined : peerSeed}
        />
        {mine && item.status === 'failed' ? (
          <View style={s.failedBlock}>
            <View style={s.failedRow}>
              <Text style={s.statusFailed} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕ failed</Text>
              {onRetry ? (
                <Press onPress={onRetry}>
                  <Text style={s.retryLink} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Retry</Text>
                </Press>
              ) : null}
            </View>
            {failReason ? (
              <Text style={s.failReason} numberOfLines={2} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{failReason}</Text>
            ) : null}
          </View>
        ) : mine && statusIcon ? (
          <Text style={s.status} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{statusIcon}</Text>
        ) : null}
      </View>
    </SwipeToReply>
  );
});

/**
 * Composer — the message input, self-contained so a keystroke re-renders ONLY this subtree and
 * never the transcript above. Owns its own `draft` state and the voice sheet; loads/persists the
 * in-progress draft via the passed-in {@link DraftStoreApi} slot. Saved-embed insertion arrives as
 * the `pendingEmbed` prop (the picker lives in the parent) and is spliced in via an effect.
 */
function Composer({
  slot,
  draftStore,
  draftLocation,
  peerName,
  peerPubkey,
  peerGradient,
  replyingTo,
  onClearReply,
  onSend,
  onOpenSavedPicker,
  pendingEmbed,
  onEmbedConsumed,
  editorEmbeds,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  postRules,
  onOpenDrafts,
}: {
  slot: ReturnType<typeof useInProgressDraft>;
  /** Same store + location `slot` above was built from — handed to the full editor directly so it
   * can self-persist (autosave, long-press "Saved ✓", delete-on-send) into the SAME per-peer slot
   * `slot` writes to for the compact composer's own keystrokes (Phase 4). */
  draftStore?: DraftStoreApi;
  draftLocation: DraftLocation;
  /** Peer display name — titles the full editor opened from `+` → Expand. */
  peerName: string;
  /** Peer hex pubkey — the byline's identity seed/circle when the full editor is open. */
  peerPubkey: string;
  peerGradient?: GradientSpec;
  replyingTo: {id: string; name: string; text: string} | null;
  onClearReply: () => void;
  onSend: (text: string, replyTo?: string) => void;
  onOpenSavedPicker: () => void;
  pendingEmbed: string | null;
  onEmbedConsumed: () => void;
  editorEmbeds: SavedEmbedRow[];
  onOpenDrafts?: () => void;
  allowVoice?: boolean;
  pictureRules?: PictureRules;
  picturesSpentBytes?: number;
  postRules?: PostRules;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Stands this page's own swipe-back down for touches beginning on the message composer below —
  // spread onto its wrapper View; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();
  // #13b: swipe-to-reply set `replyingTo` but nothing ever opened the keyboard — focus the
  // composer's input imperatively whenever a reply target is set (mirrors Telegram/every other
  // messenger's swipe-to-reply UX).
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    if (replyingTo) inputRef.current?.focus();
  }, [replyingTo]);

  // Restore the persisted in-progress draft once on mount.
  useEffect(() => {
    void slot.load().then(c => { if (c != null) setDraft(c); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Splice a picked saved-embed URI into the draft when the parent hands one down, then clear it.
  useEffect(() => {
    if (pendingEmbed == null) return;
    setDraft(prev => (prev.trim() ? `${prev.trimEnd()}\n${pendingEmbed}` : pendingEmbed));
    onEmbedConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEmbed]);

  const send = (): void => {
    if (draft.trim()) {
      onSend(draft, replyingTo?.id);
      onClearReply();
      slot.clear();
      setDraft('');
    }
  };

  return (
    <View>
      {replyingTo && (
        <View style={s.replyBar}>
          <QuotedReply name={replyingTo.name} text={replyingTo.text} onClose={onClearReply} />
        </View>
      )}
      {/* Wrapped in a plain View (MessageComposer's own props don't forward touch handlers) so the
          swipe-back drag stands down for any touch landing on it: the composer's TextInput does its
          own selection-handle drag, which never joins JS responder negotiation, so without this the
          page swipe would win that drag instead. */}
      <View {...optOut}>
        <MessageComposer
          ref={inputRef}
          value={draft}
          onChangeText={v => { setDraft(v); slot.persist(v); }}
          placeholder="Message…"
          onSend={send}
          onEmbed={onOpenSavedPicker}
          onExpand={() => setEditorOpen(true)}
          onAddPicture={pictureRules?.allow ? () => setPictureOpen(true) : undefined}
          onRecordVoice={allowVoice ? () => setVoiceOpen(true) : undefined}
          accessibilitySend="send-dm"
        />
      </View>
      {allowVoice && (
        <VoiceComposer
          visible={voiceOpen}
          onClose={() => setVoiceOpen(false)}
          onSend={voice => {
            setDraft(d => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${encodeInlineVoice(voice)} `);
            setVoiceOpen(false);
          }}
        />
      )}
      {pictureRules?.allow && (
        <PictureComposer
          visible={pictureOpen}
          onClose={() => setPictureOpen(false)}
          rules={pictureRules ?? DEFAULT_PICTURE_RULES}
          // Include pictures already staged in this draft so one message can't exceed the allowance.
          spentBytes={(picturesSpentBytes ?? 0) + extractInlinePictures(draft).reduce((n, p) => n + p.weightBytes, 0)}
          onAdd={token => setDraft(d => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${token} `)}
        />
      )}
      {/* `+` → Expand: the same Post Editor v2 engine, message-mode, over the same draft — the byline
          shows the PEER's identity (a circle, not a space shape — a DM is 1:1, not a shaped space).
          It does NOT send: its pill is Done, which closes with the draft synced back through
          onChangeDraft, and the message goes out via the composer bubble's ↑ above (`send`), which
          owns the reply target and the slot clear.
          Phase 4: `draftStore`/`draftLocation` make the editor itself the DraftStore participant
          (autosave, long-press "Saved ✓", keyed by the SAME stable `inProgressDraftId` the compact
          MessageComposer above already writes to via `slot`). */}
      <ComposerScreen
        visible={editorOpen}
        onClose={() => setEditorOpen(false)}
        messageMode
        headerTitle={peerName}
        value={draft}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        pictureSpentBytes={picturesSpentBytes}
        postRules={postRules}
        onChangeDraft={v => setDraft(v)}
        savedEmbedTokens={editorEmbeds}
        myGradient={peerGradient}
        myPubkey={peerPubkey}
        bylineVerb="Message to"
        communityName={peerName}
        onOpenDrafts={onOpenDrafts}
        draftStore={draftStore}
        draftLocation={draftLocation}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},

  // Header (padding 9/10, bottom hairline)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: {paddingHorizontal: 4},
  backChevron: {fontSize: 22, lineHeight: 22, color: colors.accent},
  identity: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10},
  peerText: {flex: 1, minWidth: 0},
  peerName: {fontSize: 15.5, fontWeight: weight.bold, color: colors.textPrimary, lineHeight: 19},
  peerNpub: {fontSize: 11, color: colors.link, fontFamily: 'monospace', lineHeight: 14},
  moreBtn: {paddingHorizontal: 6, paddingVertical: 2},
  moreDots: {fontSize: 20, lineHeight: 20, color: colors.textSecondary},
  searchBtn: {paddingHorizontal: 6, paddingVertical: 2},
  searchIcon: {fontSize: 15, opacity: 0.7},
  searchIconOn: {opacity: 1},

  // In-conversation search bar — matched to the app's global search bar.
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    color: colors.textPrimary, fontSize: typeScale.body,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  searchClose: {width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center'},
  searchCloseText: {color: colors.textSecondary, fontSize: 16, fontWeight: weight.medium},

  // Transcript
  // The transcript area fills the space between header and composer; the return-to-latest button
  // floats at its bottom-right, clear of the composer below.
  transcriptWrap: {flex: 1},
  transcript: {flex: 1},
  list: {paddingVertical: 14, paddingHorizontal: 12, flexGrow: 1},
  emptyState: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: typeScale.caption,
    lineHeight: 20,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
  },
  status: {alignSelf: 'flex-end', fontSize: 10, color: colors.textMuted, marginTop: 1, marginRight: 2},
  statusFailed: {color: colors.danger, fontSize: 11, fontWeight: weight.bold},
  failedBlock: {alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '82%', marginTop: 1, marginRight: 2},
  failedRow: {flexDirection: 'row', alignItems: 'center'},
  retryLink: {color: colors.accent, fontSize: 11, fontWeight: weight.bold, marginLeft: 10},
  failReason: {color: colors.textMuted, fontSize: 10, textAlign: 'right', marginTop: 1},

  // Composer
  replyBar: {paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border},
  // ── saved-embed picker (two cards over a scrim, 16px radius) ──
  savedWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  savedCard: {maxHeight: '70%', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  savedHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  savedHeaderLabel: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted, letterSpacing: 0.6},
  savedHeaderCount: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted},
  savedEmpty: {color: colors.textMuted, fontSize: 14, padding: 18, textAlign: 'center'},
  savedList: {maxHeight: 320},
  savedRow: {paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border},
  savedRowLabel: {fontSize: 10, fontWeight: weight.bold, color: colors.accent, letterSpacing: 0.4, marginBottom: 3},
  savedRowTitle: {fontSize: 15, color: colors.textPrimary, fontWeight: weight.semibold},
  savedRowSnippet: {fontSize: 13, color: colors.textSecondary, marginTop: 2},
  savedDone: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  savedDoneText: {fontSize: 16, color: colors.accent, fontWeight: weight.semibold},
  // ⋯ reaction menu + who-reacted sheet
  reactMenuWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  reactMenuCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 10},
  reactorRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border},
  reactorName: {flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: 15},
  reactorEmoji: {fontSize: 18},

  // Blocked footer
  blockedFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  blockedText: {color: colors.textMuted, fontSize: typeScale.caption},
  blockedUnblock: {color: colors.accent, fontSize: typeScale.caption, fontWeight: weight.semibold},

  // DM detail sheet
  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingTop: space.sm,
    paddingBottom: 18,
    // The one allowed shadow — slide-up sheets only.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: -4},
    elevation: 12,
  },
  grabberRow: {alignItems: 'center', paddingTop: 6, paddingBottom: space.md},
  grabber: {width: 38, height: 5, borderRadius: 3, backgroundColor: colors.borderLight},
  sheetHead: {alignItems: 'center', paddingHorizontal: space.lg, paddingBottom: 14},
  sheetAvatar: {marginBottom: space.md},
  sheetName: {fontSize: 21, fontWeight: weight.bold, color: colors.textPrimary, textAlign: 'center', lineHeight: 26},
  sheetNpub: {fontSize: typeScale.caption, color: colors.link, fontFamily: 'monospace', marginTop: 5, textAlign: 'center'},
  sheetEncrypted: {fontSize: typeScale.caption, color: colors.textMuted, marginTop: space.md, textAlign: 'center'},
  sheetActions: {marginHorizontal: space.lg, gap: space.sm},
  muteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: space.md,
    paddingHorizontal: 14,
  },
  muteLabel: {fontSize: 14, color: colors.textPrimary},
  // "View profile" row (No.10) — structured like muteRow/dangerRow (same card, radius, padding).
  profileRow: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: space.md,
    paddingHorizontal: 14,
  },
  profileLabel: {fontSize: 14, fontWeight: weight.semibold, color: colors.textPrimary},
  dangerRow: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: space.md,
    paddingHorizontal: 14,
  },
  blockLabel: {fontSize: 14, fontWeight: weight.semibold, color: colors.danger},
  unblockLabel: {fontSize: 14, fontWeight: weight.semibold, color: colors.accent},
});

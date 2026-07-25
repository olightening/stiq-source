/**
 * ChannelView — channel header + broadcast messages + owner composer.
 *
 * Composes the shared Channels primitives (SpaceHeader, PinnedBar, MessageCard, MessageBody,
 * ReactionChips, MessageFooter, CommentThread, ChannelComposer) so the card/header/composer visuals
 * are identical to every other space type. This screen owns only the channel-specific behaviour:
 * the per-message ⋯ action sheet, the expandable reply thread, the format toolbar, and the saved-
 * embed picker.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import type {Event} from 'nostr-tools/pure';
import type {Channel} from '../channels';
import type {SendStatus} from '../../nostr/outbox';
import type {CommentNode} from '../../feed/thread';
import {JumpButton} from '../../ui/JumpButton';
import {VoiceComposer} from '../../feed/components/VoiceComposer';
import {encodeInlineVoice} from '../../feed/voice';
import {PictureComposer} from '../../feed/components/PictureComposer';
import {extractInlinePictures} from '../../feed/picture';
import {DEFAULT_PICTURE_RULES, type PictureRules} from '../../feed/pictureRules';
import type {PostRules} from '../../feed/postRules';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {promotedFeedId} from '../promote';
import {type NostrEventSummary} from '../../ui/NostrLinkPreview';
import {decodeNameHeader} from '../../profile/displayName';
import type {GradientSpec} from '../../media/gradient';
import type {DraftStoreApi, DraftLocation} from '../../feed/drafts';
import {useInProgressDraft} from '../../feed/useInProgressDraft';
import type {PostInteractions} from '../interactions';
import {colors, space, radius, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {EmptyState} from '../../ui/EmptyState';
import {tallyEmojiReactions, type EmojiTally} from '../reactions';
import {
  ensureSavedEmbedsLoaded,
  listSavedEmbeds,
  saveEmbed,
  removeEmbed,
  savedEmbedUri,
  savedEmbedIsPrivate,
  toSavedEmbedRow,
  type SavedEmbed,
  type SavedEmbedRow,
} from '../savedEmbeds';
import {ChannelComposer, SpaceHeader, SpaceBackButton, StatusPill, npubFor} from './primitives';
import {BroadcastCard} from './BroadcastCard';
import {colors as ct, ctType, ctTracking, ctRadius, ctSpace, ctWeight} from '../tokens';

/** Stable empty tally array so React.memo'd rows don't churn on a fresh `[]` each render. */
const EMPTY_TALLIES: EmojiTally[] = [];

export interface ChannelViewProps {
  channel: Channel;
  messages: Event[];
  /** Phase 5 stale-first: the channel's scoped history fetch hasn't settled yet (no EOSE/CLOSED),
   * so an empty `messages` means "still loading over Tor" — the "No broadcasts yet." empty state
   * is suppressed rather than flashing a false claim. Omitted → empty state shows as before. */
  historyPending?: boolean;
  isOwner: boolean;
  currentUserPubkey?: string;
  /** Whether the viewer subscribes to this channel (NIP-51). Undefined hides the toggle. */
  subscribed?: boolean;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
  /**
   * Broadcast a message. May return a promise so the composer can await the outcome — a rejection
   * restores the draft (see `sendText`) instead of silently discarding a failed message.
   */
  onBroadcast: (text: string) => Promise<void> | void;
  /** Author edit of one of your broadcasts (position-preserving). Enables the ⋯ → Edit action. May
   *  return a promise; a rejection restores the edit-in-progress draft (see `sendText`). */
  onEditMessage?: (messageId: string, content: string) => Promise<void> | void;
  onOpenDetail?: () => void;
  /** §9: back control merged into the header row (the top chrome is hidden on sub-screens). */
  onBack?: () => void;
  sendStatus?: ReadonlyMap<string, SendStatus>;
  /** Relay's rejection reason per message id (shown as muted subtext under "failed"; parity with GroupView). */
  sendReasons?: ReadonlyMap<string, string>;
  onRetry?: (eventId: string) => void;
  onCancel?: (eventId: string) => void;
  onGetEvent?: (id: string) => NostrEventSummary | null;
  /** Tap a REFERENCED card → open that event (by id). */
  onOpenRef?: (id: string) => void;
  onGetChannelThread?: (messageId: string) => CommentNode[];
  onPostChannelComment?: (messageId: string, messagePubkey: string, messageKind: number, content: string) => void;
  /** Whether the viewer may moderate this channel's content (the channel owner — sovereign over
   * their own channel). Community moderators have NO authority inside a user's channel. */
  canModerate?: boolean;
  /** Channel-owner action: hide a message or comment within the owner's channel. */
  onModerate?: (id: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  /** Resolve a message author's display name (shown above their npub when known). */
  getAuthorName?: (pubkey: string) => string | undefined;
  /** Resolve a message author's identity gradient (else derived from their npub). */
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  /** Open-community-only: tap the footer author gradient circle → open that author's profile. */
  onOpenAuthor?: (pubkey: string) => void;
  /** Current per-message interaction state (comments/reactions open?). Defaults to both closed. */
  getMessageInteractions?: (messageId: string) => PostInteractions;
  /** Owner action: open/close comments & reactions on a specific broadcast message. */
  onSetMessageInteractions?: (messageId: string, perm: PostInteractions) => void;
  /** The channel's owner-configured reaction emoji set (rendered as chips under each broadcast). */
  reactionEmojis?: string[];
  /** All kind-7 reactions bucketed by target message id — tallied per broadcast against the set. */
  onGetReactionsByTarget?: () => ReadonlyMap<string, Event[]>;
  /** Audience action: react to a message with one of the channel's configured emojis. */
  onReactToMessage?: (messageId: string, messagePubkey: string, emoji: string) => void;
  /** The owner's pinned broadcast id (renders the sticky PINNED bar when set). */
  pinnedMessageId?: string;
  /** Owner action: pin a message to the channel (pass null to unpin). */
  onSetPinned?: (messageId: string | null) => void;
  /** Open a single broadcast full-screen (the replies view). */
  onOpenMessage?: (messageId: string) => void;
  /** Report a broadcast (NIP-56). */
  onReportMessage?: (messageId: string, messagePubkey: string) => void;
  /** Mute a broadcast's author (silences their notifications). */
  onMuteAuthor?: (pubkey: string) => void;
  /** Save a broadcast to the embed bookmarks (reference it in a later post). */
  onSaveToEmbed?: (messageId: string, messagePubkey: string) => void;
  /** Author (No.5): promote a broadcast into a feed thread ("enable replies"). Author-only. */
  onEnableReplies?: (message: Event) => void;
  /** Open the feed thread a promoted broadcast points to. */
  onOpenPromoted?: (feedId: string) => void;
  /** No.3: reply count of a promoted post's feed thread (mirrored on the promoted card). */
  getFeedReplyCount?: (feedId: string) => number;
  /** Organizer allows voice — shows the 🎙️ in the composer to embed a clip inline (No.9). */
  allowVoice?: boolean;
  /** Organizer picture limits — gates the "Add picture" option + enforces size/allowance in the UI. */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has already spent this period (for the allowance gate). */
  picturesSpentBytes?: number;
  /** Organizer post rules — supplies the expanded editor's universal long-body caps (words + media).
   *  Absent ⇒ unbounded, which is also the relay's default. */
  postRules?: PostRules;
  /** Persists the in-progress broadcast so an unsent draft is restored on reopen (No.7). */
  draftStore?: DraftStoreApi;
  /** Open the unified Drafts list from the expanded editor's byline. */
  onOpenDrafts?: () => void;
  /** Scroll-back pagination: fetch older broadcasts (fires near the bottom/oldest end of the list). */
  onLoadOlder?: () => void;
  /**
   * Stable React list key for an event id (AppRuntime.stableListKey). Our own optimistic
   * broadcast's `local-…` placeholder id is swapped for the real event id when it signs — keying
   * rows through this keeps ONE key across that swap so the just-sent message never
   * unmounts/remounts (FeedList.feedItemKey's cure, applied here). Omitted → raw id.
   */
  listKeyFor?: (id: string) => string;
}


export function ChannelView({
  channel,
  messages,
  historyPending,
  isOwner,
  currentUserPubkey,
  subscribed,
  onSubscribe,
  onUnsubscribe,
  onBroadcast,
  onEditMessage,
  onOpenDetail,
  onBack,
  sendStatus,
  sendReasons,
  onRetry,
  onCancel,
  onGetEvent,
  onOpenRef,
  onGetChannelThread,
  onPostChannelComment,
  canModerate,
  onModerate,
  getAuthorName,
  getAuthorGradient,
  onOpenAuthor,
  getMessageInteractions,
  reactionEmojis = [],
  onGetReactionsByTarget,
  onReactToMessage,
  pinnedMessageId,
  onSetPinned,
  onOpenMessage,
  onReportMessage,
  onMuteAuthor,
  onEnableReplies,
  onOpenPromoted,
  getFeedReplyCount,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  postRules,
  draftStore,
  onOpenDrafts,
  onLoadOlder,
  listKeyFor,
}: ChannelViewProps): React.JSX.Element {
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  /** No.8: the full-screen WYSIWYG editor (opened by the composer's ⤢ expand button). */
  const [editorOpen, setEditorOpen] = useState(false);
  /** When set, the composer is editing this broadcast (its raw text is loaded into the draft). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRef = useRef<FlatList<Event>>(null);
  const [showJump, setShowJump] = useState(false);

  // In-progress broadcast autosave (No.7): an unsent draft persists per channel and is restored on
  // reopen. The slot holds only the NEW broadcast — never an edit-in-progress (gated on !editingId).
  // Phase 4: the full editor (ComposerScreen, below) now self-persists into this SAME location's
  // slot via its own `draftStore`/`draftLocation` props — `slot` here is only still needed for what
  // ComposerScreen can't reach: the compact `ChannelComposer`'s own keystrokes (typed without ever
  // opening the full editor), the load-on-mount hydration, and the send-time clear.
  const draftLoc = useMemo<DraftLocation>(
    () => ({kind: 'channel', channelId: channel.id, channelType: 'public', channelName: channel.name}),
    [channel.id, channel.name],
  );
  const slot = useInProgressDraft(draftStore, draftLoc);
  useEffect(() => {
    void slot.load().then(c => { if (c != null) setDraft(c); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved embeds (the composer's embed picker). Loaded once; `savedVersion` bumps to refresh the
  // synchronously-read list after a save/remove.
  const [savedSheetOpen, setSavedSheetOpen] = useState(false);
  const [savedVersion, setSavedVersion] = useState(0);
  useEffect(() => { void ensureSavedEmbedsLoaded().then(() => setSavedVersion(v => v + 1)); }, []);
  // savedVersion is a deliberate invalidation counter, not a data dependency: the callback reads
  // the module-level saved-embeds cache synchronously, and the bump forces a re-read after load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const savedEmbeds: SavedEmbed[] = useMemo(() => listSavedEmbeds().slice(), [savedVersion]);
  // The same saved posts, shaped for the full editor's embed picker (No.8). One shared row builder
  // (toSavedEmbedRow) handles every embed kind — post, public channel post, space, event, private-space
  // post, and draft — so a new kind is surfaced here and in every other composer at once.
  const editorEmbeds: SavedEmbedRow[] = useMemo(
    () =>
      savedEmbeds.map(item => {
        const selfContained =
          item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
        return toSavedEmbedRow(item, selfContained ? undefined : onGetEvent?.(item.id));
      }),
    [savedEmbeds, onGetEvent],
  );

  // ⋯ "Save to embed later" — bookmark a broadcast so it can be referenced from a future post.
  const handleSaveEmbed = (id: string, pubkey: string, kind: number): void => {
    void saveEmbed({id, pubkey, kind}, Math.floor(Date.now() / 1000))
      .then(added => {
        setSavedVersion(v => v + 1);
        Alert.alert(added ? 'Saved to embed later' : 'Already saved');
      })
      .catch(() => {
        // saveEmbed already reverted its in-memory list on a failed write, so there's nothing to
        // undo here — just surface the failure instead of letting it vanish silently.
        Alert.alert('Could not save', 'Please try again.');
      });
  };
  const handleRemoveEmbed = (id: string): void => {
    void removeEmbed(id)
      .then(() => setSavedVersion(v => v + 1))
      .catch(() => {
        Alert.alert('Could not remove', 'Please try again.');
      });
  };
  // Tap a saved item → append its embed token to the draft. A SPACE embed appends the stiq:space
  // token (renders as a channel card); anything else appends the nostr:nevent reference (REFERENCED
  // card) — savedEmbedUri branches on item.kind so this is correct for both.
  const embedSaved = (item: SavedEmbed): void => {
    const uri = savedEmbedUri(item);
    setSavedSheetOpen(false);
    const append = (): void => setDraft(prev => (prev.trim() ? `${prev.trimEnd()}\n${uri}` : uri));
    // A private-content embed (a post from a private space) confirms first — it travels with its text.
    if (savedEmbedIsPrivate(item)) {
      Alert.alert(
        'Embed from a private space?',
        'This post is from a private space. Its content travels inside the embed — anyone who can see where you post it will be able to read it.',
        [{text: 'Cancel', style: 'cancel'}, {text: 'Insert anyway', style: 'destructive', onPress: append}],
      );
      return;
    }
    append();
  };

  const [initialScrollDone, setInitialScrollDone] = useState(false);

  // Comment counts for every message in one memoised pass, so each MessageItem renders from a plain
  // number prop instead of scanning the store itself. Recomputes only when the message set or the
  // app snapshot changes (onGetChannelThread identity changes once per snapshot), not on local
  // re-renders (typing, expand/collapse).
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (onGetChannelThread) {
      for (const m of messages) counts.set(m.id, onGetChannelThread(m.id)?.length ?? 0);
    }
    return counts;
  }, [messages, onGetChannelThread]);

  // No.3: for each promoted broadcast, the reply count of its feed thread (mirrors the feed post).
  const promotedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (getFeedReplyCount) {
      for (const m of messages) {
        const fid = promotedFeedId(m);
        if (fid) counts.set(m.id, getFeedReplyCount(fid));
      }
    }
    return counts;
  }, [messages, getFeedReplyCount]);

  // Per-message emoji tallies in one pass: fetch the store's reactions-by-target bucket once, then
  // tally each message against the channel's configured set. Recomputes per snapshot, not on typing.
  // No early-out on an empty `reactionEmojis`: an unconfigured channel legitimately has none (it shows
  // no zero-count chip row — see resolveReactionPalette), but reactions people ALREADY cast, e.g.
  // before the owner cleared the set, must still tally through the off-palette union. GroupView's
  // equivalent pass has never had such an early-out; skipping here would drift the two surfaces.
  const reactionTallies = useMemo(() => {
    const map = new Map<string, EmojiTally[]>();
    const byTarget = onGetReactionsByTarget?.() ?? new Map<string, Event[]>();
    for (const m of messages) {
      map.set(m.id, tallyEmojiReactions(byTarget.get(m.id) ?? [], reactionEmojis, currentUserPubkey));
    }
    return map;
  }, [messages, reactionEmojis, onGetReactionsByTarget, currentUserPubkey]);

  // Channels read like a feed: NEWEST FIRST, anchored at the top (groups/DMs stay bottom-anchored).
  // `messages` arrives oldest-first, so reverse for display. A freshly-sent broadcast (optimistically
  // inserted into the store) therefore pops in at the very top — visibly, not "into the void".
  const ordered = useMemo(() => messages.slice().reverse(), [messages]);

  /** True when `v` looks like a promise (duck-typed — avoids importing a Promise type guard). */
  const isThenable = (v: unknown): v is Promise<void> =>
    !!v && typeof (v as {catch?: unknown}).catch === 'function';

  const sendText = (text: string): void => {
    if (!text.trim()) return;
    if (editingId) {
      // Capture what's being replaced BEFORE the optimistic clear, so a rejection restores the
      // in-progress edit instead of silently losing it.
      const id = editingId;
      const result = onEditMessage?.(id, text);
      setEditingId(null);
      setDraft('');
      setEditorOpen(false);
      if (isThenable(result)) {
        result.catch(() => {
          setEditingId(id);
          setDraft(text);
        });
      }
      return;
    }
    // Capture the draft BEFORE the optimistic clear so a failed broadcast (offline, relay
    // rejection) restores it — never a silent "the message just vanished" for the author.
    const result = onBroadcast(text);
    slot.clear();
    setDraft('');
    setEditorOpen(false);
    if (isThenable(result)) {
      result.catch(() => {
        setDraft(text);
        // Re-fill the autosave slot too (mirrors the composer input restore above).
        slot.persist(text);
      });
    }
  };
  const send = (): void => sendText(draft);

  // ⋯ → Edit: load a broadcast's visible text into the composer (the relay-blind name header is
  // stripped so the author edits only their words). Send then republishes it in place.
  const startEdit = (id: string, rawContent: string): void => {
    setEditingId(id);
    setDraft(decodeNameHeader(rawContent).text);
  };
  const cancelEdit = (): void => {
    setEditingId(null);
    setDraft('');
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (!initialScrollDone) return;
    // Newest is at the TOP; show the jump button once scrolled down into older broadcasts.
    const shouldShow = e.nativeEvent.contentOffset.y > 300;
    setShowJump(prev => (prev === shouldShow ? prev : shouldShow));
  };

  const scrollToLatest = (): void => {
    listRef.current?.scrollToOffset({offset: 0, animated: true});
  };

  // Scroll-back pagination (No.3): fire onLoadOlder near the list's older (bottom) end, with a
  // simple re-entrancy guard — don't refire within 1.5s of the last call UNLESS the message count
  // has since grown (a page actually landed), so a fling doesn't spam repeated fetches for one gesture.
  const loadOlderGuardRef = useRef({lastCalledAt: 0, lastLength: messages.length});
  const handleEndReached = useCallback(() => {
    if (!onLoadOlder) return;
    const guard = loadOlderGuardRef.current;
    const now = Date.now();
    if (now - guard.lastCalledAt < 1500 && messages.length === guard.lastLength) return;
    guard.lastCalledAt = now;
    guard.lastLength = messages.length;
    onLoadOlder();
  }, [onLoadOlder, messages.length]);

  // Open community (Channels 2.0 §7): a public channel with more than one voice. It's discoverable +
  // joinable like a public channel, but admins (not only the owner) post and every post carries its
  // author's identity. `canPost` gates the composer; a plain public channel stays owner-voiced.
  const isOpen = !!channel.openCommunity;
  const adminSet = useMemo(
    () => new Set<string>([channel.owner, ...(channel.admins ?? [])]),
    [channel.owner, channel.admins],
  );
  const isAdmin = !!currentUserPubkey && adminSet.has(currentUserPubkey);
  const canPost = isOpen ? isAdmin : isOwner;

  const headerTrailing = isOwner ? (
    <StatusPill label="Owner" />
  ) : isOpen && isAdmin ? (
    <StatusPill label="Admin" />
  ) : isOpen ? (
    <Press
      style={[s.subBtn, subscribed && s.subBtnActive]}
      onPress={() => (subscribed ? onUnsubscribe?.() : onSubscribe?.())}>
      <Text style={[s.subBtnText, subscribed && s.subBtnTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{subscribed ? 'Joined' : 'Join'}</Text>
    </Press>
  ) : onSubscribe || onUnsubscribe ? (
    <Press
      style={[s.subBtn, subscribed && s.subBtnActive]}
      onPress={() => (subscribed ? onUnsubscribe?.() : onSubscribe?.())}>
      <Text style={[s.subBtnText, subscribed && s.subBtnTextActive]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{subscribed ? '✓' : '+ Sub'}</Text>
    </Press>
  ) : null;

  // Latest-event index for the per-row handler cache below: a cached closure fetches the CURRENT
  // event by id at CALL time instead of freezing whatever `item` looked like when the closure was
  // first created — so an edited broadcast's latest content/tags are always used even though its
  // handlers, once built, are never recreated for the row's lifetime.
  const byId = useMemo(() => {
    const m = new Map<string, Event>();
    for (const ev of messages) m.set(ev.id, ev);
    return m;
  }, [messages]);

  // BroadcastCard is React.memo'd, but an inline renderItem re-created every render (e.g. on every
  // composer keystroke, since `draft` lives at this component's root) hands each card fresh closure
  // props and defeats the memo, re-rendering every visible card. Stabilise renderItem with
  // useCallback so its identity only changes when a value it actually reads changes — NOT on a
  // keystroke. The handful of volatile handlers it needs (startEdit/handleSaveEmbed/setPinnedExpanded/
  // byId/…) are reached through a ref so they don't have to be memo deps.
  const cardHandlersRef = useRef({
    startEdit, handleSaveEmbed, byId,
    onRetry, onCancel, onReactToMessage, onPostChannelComment, onOpenMessage,
    onSetPinned, pinnedMessageId, onEnableReplies, onMuteAuthor, onReportMessage,
  });
  cardHandlersRef.current = {
    startEdit, handleSaveEmbed, byId,
    onRetry, onCancel, onReactToMessage, onPostChannelComment, onOpenMessage,
    onSetPinned, pinnedMessageId, onEnableReplies, onMuteAuthor, onReportMessage,
  };
  // `onTogglePinExpand` is shared by every row (it flips one piece of top-level state, not
  // per-message), so it gets a single permanently-stable callback instead of a per-row entry.
  const togglePinExpand = useCallback(() => setPinnedExpanded(e => !e), []);

  // Per-row handler cache: even with renderCard itself stabilised above, EVERY call to it still
  // built ~10 fresh arrow closures for that one row (onRetry/onReact/onEdit/…) — real allocation
  // cost whenever the visible window re-renders (e.g. one new broadcast bumps `ordered`'s identity
  // and every visible row's props get rebuilt). Cache one closure bundle per message id — built once,
  // reused for the row's lifetime — so a renderCard call only allocates for ids it has never seen.
  // Every closure dereferences `cardHandlersRef.current` (and its live `byId` snapshot) at CALL time,
  // so nothing here can go stale even though the closures themselves are never recreated.
  interface RowHandlers {
    onRetry: () => void;
    onCancel: () => void;
    onReact: (emoji: string) => void;
    onPostComment: (content: string) => void;
    onOpenMessage: () => void;
    onEdit: () => void;
    onTogglePin: () => void;
    onEnableReplies: () => void;
    onSaveToEmbed: () => void;
    onMuteAuthor: () => void;
    onReport: () => void;
  }
  const rowHandlersRef = useRef(new Map<string, RowHandlers>());
  // useCallback (empty deps) is correct AND needed, not just a lint nicety: getRowHandlers is itself
  // a dependency of renderCard below, so without a stable identity here renderCard would be recreated
  // every render regardless of the cache. Everything it touches is reached via refs, so it never
  // needs to change.
  const getRowHandlers = useCallback((id: string): RowHandlers => {
    const existing = rowHandlersRef.current.get(id);
    if (existing) return existing;
    const row: RowHandlers = {
      onRetry: () => cardHandlersRef.current.onRetry?.(id),
      onCancel: () => cardHandlersRef.current.onCancel?.(id),
      onReact: emoji => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.onReactToMessage?.(id, ev.pubkey, emoji);
      },
      onPostComment: content => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.onPostChannelComment?.(id, ev.pubkey, ev.kind, content);
      },
      onOpenMessage: () => cardHandlersRef.current.onOpenMessage?.(id),
      onEdit: () => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.startEdit(id, ev.content);
      },
      onTogglePin: () => {
        const h = cardHandlersRef.current;
        h.onSetPinned?.(id === h.pinnedMessageId ? null : id);
      },
      onEnableReplies: () => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.onEnableReplies?.(ev);
      },
      onSaveToEmbed: () => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.handleSaveEmbed(id, ev.pubkey, ev.kind);
      },
      onMuteAuthor: () => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.onMuteAuthor?.(ev.pubkey);
      },
      onReport: () => {
        const h = cardHandlersRef.current;
        const ev = h.byId.get(id);
        if (ev) h.onReportMessage?.(id, ev.pubkey);
      },
    };
    rowHandlersRef.current.set(id, row);
    return row;
  }, []);
  // Bounded cache — same pattern as feed's `_itemCache`: once it outgrows the live message set, drop
  // entries for ids no longer present so a long session can't grow it without bound.
  if (rowHandlersRef.current.size > messages.length * 2 + 64) {
    const live = new Set(messages.map(m => m.id));
    for (const id of rowHandlersRef.current.keys()) {
      if (!live.has(id)) rowHandlersRef.current.delete(id);
    }
  }

  const renderCard = useCallback(
    ({item}: {item: Event}) => {
      const row = getRowHandlers(item.id);
      return (
        <BroadcastCard
          event={item}
          showAuthor={false}
          author={isOpen ? {
            seed: npubFor(item.pubkey),
            gradient: getAuthorGradient?.(item.pubkey),
            onPress: onOpenAuthor ? () => onOpenAuthor(item.pubkey) : undefined,
          } : undefined}
          status={sendStatus?.get(item.id)}
          reason={sendReasons?.get(item.id)}
          onRetry={onRetry ? row.onRetry : undefined}
          onCancel={onCancel ? row.onCancel : undefined}
          reactionEmojis={reactionEmojis}
          reactions={reactionTallies.get(item.id) ?? EMPTY_TALLIES}
          onReact={onReactToMessage ? row.onReact : undefined}
          commentsEnabled={(getMessageInteractions?.(item.id)?.comments ?? false) || isOwner}
          commentCount={commentCounts.get(item.id) ?? 0}
          onGetThread={onGetChannelThread}
          onPostComment={onPostChannelComment ? row.onPostComment : undefined}
          getCommentAuthorName={getAuthorName}
          getCommentAuthorGradient={getAuthorGradient}
          canModerate={canModerate}
          onModerate={onModerate}
          onLookupEvent={onGetEvent}
          onOpenRef={onOpenRef}
          onOpenMessage={onOpenMessage ? row.onOpenMessage : undefined}
          isMine={!!currentUserPubkey && item.pubkey === currentUserPubkey}
          edited={item.tags.some(t => t[0] === 'edited')}
          onEdit={onEditMessage ? row.onEdit : undefined}
          isPinned={item.id === pinnedMessageId}
          onTogglePin={isOwner && onSetPinned ? row.onTogglePin : undefined}
          pinnedExpanded={pinnedExpanded}
          onTogglePinExpand={togglePinExpand}
          onEnableReplies={onEnableReplies && !!currentUserPubkey && item.pubkey === currentUserPubkey ? row.onEnableReplies : undefined}
          onOpenPromoted={onOpenPromoted}
          promotedReplyCount={promotedCounts.get(item.id) ?? 0}
          onSaveToEmbed={row.onSaveToEmbed}
          onMuteAuthor={onMuteAuthor ? row.onMuteAuthor : undefined}
          onReport={onReportMessage ? row.onReport : undefined}
        />
      );
    },
    // NOTE: `draft`/typing state is deliberately NOT a dependency — that is the whole point (a
    // keystroke must not re-create renderItem and churn the cards). Volatile handlers ride the ref;
    // getRowHandlers/togglePinExpand are permanently-stable (empty-dep useCallback) so listing them
    // costs nothing.
    [
      getMessageInteractions, isOpen, getAuthorName, getAuthorGradient, onOpenAuthor, sendStatus,
      sendReasons, onRetry, onCancel, reactionEmojis, reactionTallies, onReactToMessage, isOwner,
      commentCounts, onGetChannelThread, onPostChannelComment, canModerate, onModerate, onGetEvent,
      onOpenRef, onOpenMessage, currentUserPubkey, onEditMessage, pinnedMessageId, onSetPinned,
      pinnedExpanded, onEnableReplies, onOpenPromoted, promotedCounts, onMuteAuthor, onReportMessage,
      togglePinExpand, getRowHandlers,
    ],
  );

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
      <SpaceHeader
        leading={onBack ? <SpaceBackButton onPress={onBack} /> : undefined}
        gradient={channel.gradient}
        seed={channel.id}
        shape={isOpen ? 'octagon' : 'square'}
        avatarSize={44}
        name={channel.name}
        subtitle={
          isOpen
            ? `Open community${channel.about ? ` · ${channel.about}` : ''} ›`
            : channel.about ? `${channel.about} ›` : 'Public · tap for details ›'
        }
        onPressBody={onOpenDetail}
        trailing={headerTrailing}
      />

      {messages.length === 0 ? (
        // Stale-first: while the scoped history fetch is still replaying (historyPending), claim
        // NOTHING — a channel with real history must never flash "No broadcasts yet." mid-load.
        historyPending ? (
          <View style={s.empty} />
        ) : (
          <EmptyState
            icon="💬"
            title="No broadcasts yet"
            subtitle="New posts to this channel will show up here."
          />
        )
      ) : (
        <View style={s.feedWrap}>
          <FlatList
            ref={listRef}
            data={ordered}
            keyExtractor={m => (listKeyFor ? listKeyFor(m.id) : m.id)}
            contentContainerStyle={s.list}
            onScroll={handleScroll}
            // Re-evaluate on settle too — a throttled onScroll can drop the final resting frame,
            // leaving the jump button stuck visible after a fling back to the top (newest).
            onMomentumScrollEnd={handleScroll}
            onScrollEndDrag={handleScroll}
            scrollEventThrottle={16}
            maxToRenderPerBatch={6}
            windowSize={11}
            initialNumToRender={10}
            onContentSizeChange={() => setInitialScrollDone(true)}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            renderItem={renderCard}
          />
          <JumpButton visible={showJump} direction="up" onPress={scrollToLatest} />
        </View>
      )}

      {canPost ? (
        <>
          {editingId && (
            <View style={s.editingBar}>
              <Text style={s.editingText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️ Editing broadcast</Text>
              <Press onPress={cancelEdit}>
                <Text style={s.editingCancel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
              </Press>
            </View>
          )}
          <ChannelComposer
            value={draft}
            onChangeText={v => { setDraft(v); if (!editingId) slot.persist(v); }}
            placeholder={editingId ? 'Edit your broadcast…' : 'Broadcast a message…'}
            onSend={send}
            onEmbed={() => setSavedSheetOpen(true)}
            onExpand={() => setEditorOpen(true)}
            onRecordVoice={allowVoice ? () => setVoiceOpen(true) : undefined}
            onAddPicture={pictureRules?.allow ? () => setPictureOpen(true) : undefined}
            accessibilitySend="broadcast"
          />
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
          <PictureComposer
            visible={pictureOpen}
            onClose={() => setPictureOpen(false)}
            rules={pictureRules ?? DEFAULT_PICTURE_RULES}
            // Include pictures already staged in this draft so one message can't exceed the allowance.
            spentBytes={(picturesSpentBytes ?? 0) + extractInlinePictures(draft).reduce((n, p) => n + p.weightBytes, 0)}
            onAdd={token => setDraft(d => `${d}${d && !/\s$/.test(d) ? ' ' : ''}${token} `)}
          />
        </>
      ) : (
        <View style={s.readOnlyFooter}>
          <Text style={s.readOnlyText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {isOpen
              ? "🔒 Only admins can post here — you'll get every broadcast."
              : "🔕 Only the owner can post here — you'll get every broadcast."}
          </Text>
        </View>
      )}

      {/* SAVED · TAP TO EMBED sheet — the composer's embed picker. */}
      <Modal visible={savedSheetOpen} transparent animationType="slide" onRequestClose={() => setSavedSheetOpen(false)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setSavedSheetOpen(false)} accessibilityRole="none" />
        <View style={s.sheetWrap}>
          <View style={s.savedCard}>
          <View style={s.savedHeader}>
            <Text style={s.savedHeaderLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>SAVED · TAP TO EMBED</Text>
            <Text style={s.savedHeaderCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{savedEmbeds.length} saved</Text>
          </View>
          {savedEmbeds.length === 0 ? (
            <Text style={s.savedEmpty} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Nothing saved yet. Use a post's ⋯ → “Save to embed later”.</Text>
          ) : (
            <ScrollView style={s.savedList}>
              {savedEmbeds.map(item => {
                const selfContained =
                  item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
                const row = toSavedEmbedRow(item, selfContained ? undefined : onGetEvent?.(item.id));
                return (
                  <View key={item.id} style={s.savedRow}>
                    <Press variant="row" style={s.savedRowBody} onPress={() => embedSaved(item)}>
                      <Text style={s.savedRowLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.label}</Text>
                      <Text style={s.savedRowTitle} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{row.title}</Text>
                      {row.snippet ? <Text style={s.savedRowSnippet} numberOfLines={2}>{row.snippet}</Text> : null}
                    </Press>
                    <Press onPress={() => handleRemoveEmbed(item.id)} accessibilityLabel="remove saved embed">
                      <Text style={s.savedRemove} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✕</Text>
                    </Press>
                  </View>
                );
              })}
            </ScrollView>
          )}
          </View>
          <Press style={s.sheetCancel} onPress={() => setSavedSheetOpen(false)}>
            <Text style={s.sheetCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Done</Text>
          </Press>
        </View>
      </Modal>

      {/* §2: the `+` → Expand action opens the full Post Editor v2 engine, message-mode, over the
          same draft — the same rich body/Aa-blocks/insert-bar/byline the feed uses, minus title/
          tags/label/CW/Details (a broadcast stays a broadcast; see ComposerScreen's messageMode doc).
          It does NOT send: its pill is Done, which closes with the draft synced back through
          onChangeDraft, and the broadcast goes out via the composer bubble's ↑ below (`send`) — the
          same one path whether or not the writer ever opened the editor, editing included.
          Phase 4: `draftStore`/`draftLocation` make the editor itself the DraftStore participant
          (autosave, long-press "Saved ✓", keyed by the SAME stable `inProgressDraftId` the compact
          `ChannelComposer` below already writes to via `slot`) — both composers converge on one row.
          Withheld while editing an EXISTING broadcast (`editingId`): the slot is for the next NEW
          broadcast only, never an edit-in-progress (matches the compact composer's own
          `if (!editingId)` guard on `slot.persist` below). */}
      {canPost && (
        <ComposerScreen
          visible={editorOpen}
          onClose={() => setEditorOpen(false)}
          messageMode
          headerTitle={editingId ? 'Edit broadcast' : channel.name}
          value={draft}
          allowVoice={allowVoice}
          pictureRules={pictureRules}
          pictureSpentBytes={picturesSpentBytes}
          postRules={postRules}
          onChangeDraft={v => setDraft(v)}
          savedEmbedTokens={editorEmbeds}
          onRemoveSavedToken={handleRemoveEmbed}
          space={{name: channel.name, gradient: channel.gradient, shape: isOpen ? 'octagon' : 'square'}}
          onOpenDrafts={onOpenDrafts}
          draftStore={editingId ? undefined : draftStore}
          draftLocation={editingId ? undefined : draftLoc}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  // ── pinned post: collapsed bar + expanded toggle row ──
  pinnedCollapsed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginHorizontal: ctSpace.side,
    marginTop: ctSpace.stackGap,
    backgroundColor: ct.surfaceAlt,
    borderWidth: 1,
    borderColor: ct.border,
    borderRadius: ctRadius.pinned,
    paddingVertical: 10,
    paddingHorizontal: 13,
  },
  pinnedToggleRow: {flexDirection: 'row', alignItems: 'center', gap: 7, paddingBottom: 9},
  pinnedLabel: {
    fontSize: ctType.microLabel.fontSize,
    fontWeight: ctWeight.bold,
    letterSpacing: ctTracking.pinned,
    textTransform: 'uppercase',
    color: ct.accent,
  },
  pinnedPreview: {flex: 1, minWidth: 0, fontSize: 14, color: ct.textSecondary},
  pinnedChevron: {fontSize: ctType.chipCount.fontSize, color: ct.textMuted},
  // ── read-only footer (followers of a public channel can't post) ──
  readOnlyFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: ct.border,
  },
  readOnlyText: {flex: 1, fontSize: ctType.chipCount.fontSize, color: ct.textMuted},
  // ── composer "editing" bar (shown while editing a broadcast) ──
  editingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: ct.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: ct.border,
  },
  editingText: {fontSize: ctType.chipCount.fontSize, color: ct.textSecondary, fontWeight: ctWeight.semibold},
  editingCancel: {fontSize: ctType.chipCount.fontSize, color: ct.accent, fontWeight: ctWeight.semibold},
  subBtn: {borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6, borderWidth: 1, borderColor: colors.accent},
  subBtnActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  subBtnText: {fontSize: 13, color: colors.accent, fontWeight: weight.semibold},
  subBtnTextActive: {color: colors.onAccent},
  feedWrap: {flex: 1},
  list: {paddingBottom: space.lg},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl},
  // ── bottom sheets (⋯ action sheet + saved picker): two cards over a scrim, 16px radius ──
  sheetBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)'},
  sheetWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  sheetCard: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 8,
  },
  sheetCancel: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  sheetCancelText: {fontSize: 16, color: colors.accent, fontWeight: weight.semibold},
  menuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    paddingHorizontal: 18, paddingVertical: 15,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  menuRowLast: {borderBottomWidth: 0},
  menuIcon: {fontSize: 16, width: 22, textAlign: 'center'},
  menuLabel: {fontSize: 16, color: colors.textPrimary},
  menuDanger: {color: colors.danger},
  // ── saved-embed picker card (sits in the shared sheetWrap) ──
  savedCard: {
    maxHeight: '70%',
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 8,
  },
  savedHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  savedHeaderLabel: {fontSize: 11, fontWeight: weight.bold, color: colors.textMuted, letterSpacing: 0.6},
  savedHeaderCount: {fontSize: typeScale.caption, color: colors.textMuted},
  savedEmpty: {color: colors.textMuted, fontSize: typeScale.label, padding: 18, textAlign: 'center'},
  savedList: {maxHeight: 360},
  savedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  savedRowBody: {flex: 1, minWidth: 0},
  savedRowLabel: {fontSize: 10, fontWeight: weight.bold, color: colors.accent, letterSpacing: 0.4, marginBottom: 3},
  savedRowTitle: {fontSize: typeScale.label, color: colors.textPrimary, fontWeight: weight.semibold},
  savedRowSnippet: {fontSize: typeScale.caption, color: colors.textSecondary, marginTop: 2},
  savedRemove: {fontSize: 16, color: colors.textMuted, paddingHorizontal: 6},
  // ── expandable reply thread ──
  commentSection: {
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  noComments: {fontSize: typeScale.label, color: colors.textMuted, marginBottom: space.sm},
  commentComposer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  commentInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    color: colors.textPrimary,
    fontSize: typeScale.label,
  },
  commentSendBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  commentSendBtnDisabled: {opacity: 0.4},
  commentSendBtnText: {color: colors.onAccent, fontSize: 14, fontWeight: weight.bold},
});

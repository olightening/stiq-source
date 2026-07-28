/**
 * ChannelPostView — a single broadcast opened full-screen, with its reactions and reply thread.
 *
 * Reached by tapping a broadcast in ChannelView. When replies are enabled (the owner's per-post
 * interaction gate, or the viewer is the owner) it shows the reply composer + thread; otherwise it
 * shows a "replies are turned off" note. Reuses MessageBody / ReactionChips from the shared channel
 * primitives so the post body + reactions render identically to the channel feed.
 *
 * The comment thread is rendered INLINE here (not via the shared CommentThread primitive): the
 * Post-detail spec needs an "Author" badge, a per-comment replies toggle, and Reply / ⋯ controls
 * that the shared primitive does not implement, and that primitive is owned by another stream — so
 * the spec'd layout lives here rather than mutating shared code.
 */
import React, {useState} from 'react';
import {Alert, KeyboardAvoidingView, Modal, Platform, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import type {Event} from 'nostr-tools/pure';
import type {CommentNode} from '../../feed/thread';
import {countComments} from '../../feed/thread';
import type {NostrEventSummary} from '../../ui/NostrLinkPreview';
import {decodeGradient, type GradientSpec} from '../../media/gradient';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {BackButton} from '../../ui/BackButton';
import {decodeNameHeader} from '../../profile/displayName';
import {colors, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {useSwipeOptOut} from '../../ui/swipeOptOut';
import {CommentComposer} from '../../feed/components/CommentComposer';
import {SendProgress} from '../../feed/components/SendProgress';
import type {SendStatus} from '../../nostr/outbox';
import type {PictureRules} from '../../feed/pictureRules';
import {MessageBody, ReactionChips, npubFor, shortNpub} from './primitives';
import {relTime} from '../../ui/relTime';
import {promotedFeedId} from '../promote';
import {tallyEmojiReactions, type EmojiTally} from '../reactions';
import {resolveAuthor} from '../../blind/identity';

function relativeTime(ts: number): string {
  return relTime(ts, 'ago');
}

export interface ChannelPostViewProps {
  channelName: string;
  message: Event;
  isOwner: boolean;
  /** Whether replies are open on this post (owner's per-post gate, or the viewer owns the channel). */
  repliesEnabled: boolean;
  /** Author (No.5): promote this post into a feed thread ("enable replies"). Author-only (isOwner);
   *  hidden once the post is already promoted. Surface audit (T4.4) — this single-post overlay was
   *  the one place BroadcastCard/GroupView's "Turn on replies" action was missing. */
  onEnableReplies?: (message: Event) => void;
  /** Open the feed thread this post was promoted to — set when the post carries a `promoted` tag. */
  onOpenPromoted?: (feedId: string) => void;
  /** No.3: reply count of the feed thread a promoted post points to — mirrored under the post. */
  promotedReplyCount?: number;
  /** Show the post author header (multi-author / non-public channels only). */
  showAuthor?: boolean;
  onBack: () => void;
  /** Configured reaction emojis + the raw kind-7 events targeting this message (tallied here). */
  reactionEmojis: string[];
  reactionEvents: Event[];
  currentUserPubkey?: string;
  onReact?: (emoji: string) => void;
  /** The reply thread (kind-1111 comments) under this broadcast. */
  thread: CommentNode[];
  onPostComment?: (content: string) => void;
  /** Organizer picture limits — gives the comment composer's `+` an "Add picture" action. */
  pictureRules?: PictureRules;
  /** Picture token bytes already spent this period (for the comment composer's allowance gate). */
  picturesSpentBytes?: number;
  /** Organizer-allowed voice — gives the comment composer's `+` a "Record voice" action. */
  allowVoice?: boolean;
  canModerate?: boolean;
  onModerate?: (id: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  getAuthorName?: (pubkey: string) => string | undefined;
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  onGetEvent?: (id: string) => NostrEventSummary | null;
  /** Tap an embedded reference card (a `nostr:`/`stiq:space:` ref inside the post body or a
   * comment) → open that target. Omitted, every card here renders non-interactive. */
  onOpenRef?: (id: string) => void;
  /** Per-comment optimistic delivery status, keyed by comment event id (drives the send indicator). */
  sendStatus?: ReadonlyMap<string, SendStatus>;
  /** Per-comment relay rejection reason (only rejected ids) — shown next to "failed". */
  sendReasons?: ReadonlyMap<string, string>;
  /** Comment ids whose 'sending' status is a pre-connect queue (relay/Tor not up yet) rather than an
   *  active in-flight publish — drives "Queued — connecting…" vs "Sending…" (M7). */
  sendQueuedOffline?: ReadonlySet<string>;
  /** Retry a failed comment send. */
  onRetryComment?: (id: string) => void;
  /** Cancel / dismiss a failed comment send. */
  onCancelComment?: (id: string) => void;
}

// ── One comment (and, when expanded, its nested replies) ─────────────────────

interface CommentItemProps {
  node: CommentNode;
  /** The post author's pubkey — drives the "Author" badge. */
  postAuthor: string;
  reply?: boolean;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenRef?: (id: string) => void;
  canModerate?: boolean;
  onModerate?: (id: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  getAuthorName?: (pubkey: string) => string | undefined;
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  /** Optimistic delivery status for this comment (drives the send indicator). */
  status?: SendStatus;
  /** Relay's rejection reason (when status is 'rejected') — shown next to "failed". */
  reason?: string;
  /** True when `status === 'sending'` is a pre-connect queue rather than an active in-flight
   *  publish — renders "Queued — connecting…" instead of "Sending…" (M7). */
  queuedOffline?: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
  /** Raw per-comment status maps, threaded through purely so a recursively-rendered reply can look
   *  up its OWN status/reason/onRetry/onCancel the same way the top-level render site does. */
  sendStatus?: ReadonlyMap<string, SendStatus>;
  sendReasons?: ReadonlyMap<string, string>;
  sendQueuedOffline?: ReadonlySet<string>;
  onRetryComment?: (id: string) => void;
  onCancelComment?: (id: string) => void;
}

function Comment({
  node,
  postAuthor,
  reply,
  onLookupEvent,
  onOpenRef,
  canModerate,
  onModerate,
  getAuthorName,
  getAuthorGradient,
  status,
  reason,
  queuedOffline,
  onRetry,
  onCancel,
  sendStatus,
  sendReasons,
  sendQueuedOffline,
  onRetryComment,
  onCancelComment,
}: CommentItemProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // A comment may be a blind post (throwaway-signed) — resolve its real author before deriving the
  // avatar seed/name/gradient/moderation-target, or every blind comment renders (and moderates) as
  // its anonymous throwaway signer (bug #7; mirrors CommentThread.tsx / ThreadView.tsx).
  const author = resolveAuthor(node.event);
  const pubkey = author.pubkey;
  const npub = npubFor(pubkey);
  const name = (author.name ?? getAuthorName?.(pubkey))?.trim() || shortNpub(npub, 12, 4);
  // author.gradient is the raw attestation wire form (a string) — decode it to the same
  // GradientSpec shape getAuthorGradient returns before handing it to GradientAvatar.
  const gradient = (author.gradient ? decodeGradient(author.gradient) : undefined) ?? getAuthorGradient?.(pubkey);
  const isAuthor = pubkey === postAuthor;
  const text = decodeNameHeader(node.event.content).text;
  const childCount = node.children.length;

  const onMenu = (): void => {
    if (!canModerate || !onModerate) return;
    Alert.alert('Comment', undefined, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Hide comment', style: 'destructive', onPress: () => onModerate(node.event.id, pubkey, 'hide')},
      {text: 'Mute author', style: 'destructive', onPress: () => onModerate(node.event.id, pubkey, 'hideUser')},
    ]);
  };

  const avatarSize = reply ? 26 : 32;

  return (
    <View style={reply ? null : s.commentRow}>
      <View style={s.commentInner}>
        <GradientAvatar gradient={gradient} seed={npub} size={avatarSize} shape="circle" style={s.avatar} />
        <View style={s.commentBody}>
          <View style={s.commentMeta}>
            <Text style={reply ? s.replyName : s.commentName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text>
            {isAuthor && (
              <View style={s.authorBadge}>
                <Text style={s.authorBadgeText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Author</Text>
              </View>
            )}
            <Text style={s.commentTime} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relativeTime(node.event.created_at)}</Text>
          </View>
          {/* MessageBody renders the comment text + any embedded reference card. */}
          <View style={s.commentText}>
            <MessageBody content={text} onLookupEvent={onLookupEvent} onOpenRef={onOpenRef} />
          </View>
          <View style={s.controlsRow}>
            <Text style={s.controlReply} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Reply</Text>
            {!reply && childCount > 0 && (
              <Press onPress={() => setExpanded(v => !v)}>
                <Text style={s.controlToggle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {expanded ? '▾' : '▸'} {childCount} {childCount === 1 ? 'reply' : 'replies'}
                </Text>
              </Press>
            )}
            <View style={s.controlsSpacer} />
            <SendProgress status={status} reason={reason} queuedOffline={queuedOffline} onRetry={onRetry} onCancel={onCancel} />
            <Press onPress={onMenu} accessibilityLabel="comment-more">
              <Text style={s.controlMore} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
            </Press>
          </View>
          {!reply && expanded && childCount > 0 && (
            <View style={s.replies}>
              {node.children.map(child => (
                <Comment
                  key={child.event.id}
                  node={child}
                  postAuthor={postAuthor}
                  reply
                  onLookupEvent={onLookupEvent}
                  onOpenRef={onOpenRef}
                  canModerate={canModerate}
                  onModerate={onModerate}
                  getAuthorName={getAuthorName}
                  getAuthorGradient={getAuthorGradient}
                  status={sendStatus?.get(child.event.id)}
                  reason={sendReasons?.get(child.event.id)}
                  queuedOffline={sendQueuedOffline?.has(child.event.id)}
                  onRetry={onRetryComment ? () => onRetryComment(child.event.id) : undefined}
                  onCancel={onCancelComment ? () => onCancelComment(child.event.id) : undefined}
                  sendStatus={sendStatus}
                  sendReasons={sendReasons}
                  sendQueuedOffline={sendQueuedOffline}
                  onRetryComment={onRetryComment}
                  onCancelComment={onCancelComment}
                />
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

export function ChannelPostView({
  channelName,
  message,
  isOwner,
  repliesEnabled,
  onEnableReplies,
  onOpenPromoted,
  promotedReplyCount = 0,
  showAuthor,
  onBack,
  reactionEmojis,
  reactionEvents,
  currentUserPubkey,
  onReact,
  thread,
  onPostComment,
  pictureRules,
  picturesSpentBytes,
  allowVoice,
  canModerate,
  onModerate,
  getAuthorName,
  getAuthorGradient,
  onGetEvent,
  onOpenRef,
  sendStatus,
  sendReasons,
  sendQueuedOffline,
  onRetryComment,
  onCancelComment,
}: ChannelPostViewProps): React.JSX.Element {
  const npub = npubFor(message.pubkey);
  const name = getAuthorName?.(message.pubkey)?.trim();
  const gradient = getAuthorGradient?.(message.pubkey);
  const tallies: EmojiTally[] = tallyEmojiReactions(reactionEvents, reactionEmojis, currentUserPubkey);
  // Once a post is ON THE FEED, engagement moves to the feed post — drop the in-channel reaction UI.
  const feedId = promotedFeedId(message);
  const promoted = feedId !== undefined;
  const isPinned = message.tags.some(t => t[0] === 'pinned' || (t[0] === 't' && t[1] === 'pinned'));
  const commentCount = countComments(thread);
  const [menuOpen, setMenuOpen] = useState(false);
  // Stands this page's own swipe-back down for touches beginning on the comment composer below —
  // spread onto its wrapper View; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();

  return (
    // SafeAreaView (not View): ChannelPostView renders inside MainScreen's post-detail overlay,
    // which is position:absolute top:0 and covers the app's root SafeAreaView — so this screen must
    // re-apply the top inset itself, or the back row flanks the Dynamic Island. Single inset here.
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
    <SafeAreaView style={s.root}>
      <View style={s.backRow}>
        <BackButton label={channelName} onPress={onBack} size="sm" style={s.backNav} />
        {isOwner && onEnableReplies && !promoted && (
          <Press style={s.backMenuBtn} onPress={() => setMenuOpen(true)} accessibilityLabel="post-more">
            <Text style={s.backMenuDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
          </Press>
        )}
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setMenuOpen(false)} accessibilityRole="none" />
        <View style={s.sheetWrap}>
          <View style={s.sheetCard}>
            <Press
              variant="row"
              style={[s.menuRow, s.menuRowLast]}
              onPress={() => { setMenuOpen(false); onEnableReplies?.(message); }}
              accessibilityLabel="enable-replies">
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>💬</Text>
              <Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Turn on replies</Text>
            </Press>
          </View>
          <Press style={s.sheetCancel} onPress={() => setMenuOpen(false)}>
            <Text style={s.sheetCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
          </Press>
        </View>
      </Modal>

      <ScrollView style={s.flex} contentContainerStyle={s.content}>
        {/* ── The post ── */}
        <View style={s.post}>
          {isPinned && <Text style={s.pinned} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>📌 Pinned</Text>}

          {showAuthor && (
            <View style={s.postHeader}>
              <GradientAvatar gradient={gradient} seed={npub} size={30} shape="circle" style={s.avatar} />
              <View style={s.authorText}>
                {name ? <Text style={s.authorName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text> : null}
                <Text style={s.authorNpub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub, 12, 4)}</Text>
              </View>
            </View>
          )}

          <MessageBody content={message.content} onLookupEvent={onGetEvent} onOpenRef={onOpenRef} />
          {promoted && feedId && onOpenPromoted && (
            /* Mirrors BroadcastCard's "✦ On the feed" eyebrow — this full-screen overlay has no card
               frame to accent, so a tappable row carries the same signal + tap-through (clickability). */
            <Press variant="row" onPress={() => onOpenPromoted(feedId)} accessibilityLabel="open-promoted">
              <Text style={s.promotedEyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                ✦ On the feed · 💬 {promotedReplyCount} · view discussion ›
              </Text>
            </Press>
          )}
          {!promoted && <ReactionChips reactions={tallies} onReact={onReact} />}
          <Text style={s.time} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relativeTime(message.created_at)}</Text>
        </View>

        {/* ── Replies-off notice / Comments ── */}
        {!repliesEnabled ? (
          <Text style={s.repliesOff} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔕 Replies are turned off for this post.</Text>
        ) : (
          <View style={s.commentsSection}>
            <View style={s.commentsHeader}>
              <Text style={s.commentsLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>COMMENTS</Text>
              <Text style={s.commentsCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{commentCount}</Text>
              <View style={s.commentsRule} />
            </View>
            {thread.length > 0 ? (
              thread.map(node => (
                <Comment
                  key={node.event.id}
                  node={node}
                  postAuthor={message.pubkey}
                  onLookupEvent={onGetEvent}
                  onOpenRef={onOpenRef}
                  canModerate={canModerate}
                  onModerate={onModerate}
                  getAuthorName={getAuthorName}
                  getAuthorGradient={getAuthorGradient}
                  status={sendStatus?.get(node.event.id)}
                  reason={sendReasons?.get(node.event.id)}
                  queuedOffline={sendQueuedOffline?.has(node.event.id)}
                  onRetry={onRetryComment ? () => onRetryComment(node.event.id) : undefined}
                  onCancel={onCancelComment ? () => onCancelComment(node.event.id) : undefined}
                  sendStatus={sendStatus}
                  sendReasons={sendReasons}
                  sendQueuedOffline={sendQueuedOffline}
                  onRetryComment={onRetryComment}
                  onCancelComment={onCancelComment}
                />
              ))
            ) : (
              <Text style={s.noReplies} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>No replies yet.</Text>
            )}
          </View>
        )}
      </ScrollView>

      {repliesEnabled && onPostComment && (
        // Wrapped in a plain View (CommentComposer's own props don't forward touch handlers) so the
        // swipe-back drag stands down for any touch landing on it: the composer's TextInput does its
        // own selection-handle drag, which never joins JS responder negotiation, so without this the
        // page swipe would win that drag instead.
        <View {...optOut}>
          <CommentComposer
            onSubmit={onPostComment}
            onGetEvent={onGetEvent}
            placeholder="Add a comment…"
            submitLabel="Comment"
            allowVoice={allowVoice}
            pictureRules={pictureRules}
            picturesSpentBytes={picturesSpentBytes}
          />
        </View>
      )}
    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex: {flex: 1},
  content: {paddingBottom: 24},

  // Back link
  backRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.border},
  backNav: {paddingHorizontal: 12, paddingVertical: 8},
  backMenuBtn: {paddingHorizontal: 14, paddingVertical: 8},
  backMenuDots: {fontSize: 18, lineHeight: 18, color: colors.textMuted},

  // The post
  post: {paddingHorizontal: 16, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.border},
  pinned: {fontSize: 11, fontWeight: '700', letterSpacing: 0.55, textTransform: 'uppercase', color: colors.accent, marginBottom: 10},
  // Mirrors BroadcastCard's "✦ On the feed" eyebrow (T4.4 surface audit) — this full-screen overlay
  // has no card frame to accent, so the tappable text row carries the same signal.
  promotedEyebrow: {marginBottom: 8, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.accent},
  // ── ⋯ action sheet (mirrors BroadcastCard's, for the one action this overlay offers: enable replies) ──
  sheetBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)'},
  sheetWrap: {position: 'absolute', left: 10, right: 10, bottom: 14},
  sheetCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  sheetCancel: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  sheetCancelText: {fontSize: 16, color: colors.accent, fontWeight: '600'},
  menuRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 18, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.border},
  menuRowLast: {borderBottomWidth: 0},
  menuIcon: {fontSize: 16, width: 22, textAlign: 'center'},
  menuLabel: {fontSize: 16, color: colors.textPrimary},
  postHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 11},
  avatar: {flexShrink: 0},
  authorText: {flexShrink: 1, minWidth: 0},
  authorName: {color: colors.textPrimary, fontSize: 13.5, fontWeight: '600', lineHeight: 16},
  authorNpub: {color: colors.link, fontSize: 11, fontFamily: 'monospace', lineHeight: 14},
  time: {color: colors.textMuted, fontSize: 11.5, marginTop: 11},

  // Replies-off
  repliesOff: {color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 18, paddingHorizontal: 16},

  // Comments section
  commentsSection: {paddingHorizontal: 16, paddingBottom: 14},
  commentsHeader: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingTop: 14, paddingBottom: 6},
  commentsLabel: {fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.85, textTransform: 'uppercase'},
  commentsCount: {fontSize: 11, color: colors.textMuted, fontWeight: '700'},
  commentsRule: {flex: 1, height: 1, backgroundColor: colors.border},
  noReplies: {color: colors.textMuted, fontSize: 15, paddingTop: 13},

  // A comment
  commentRow: {borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 13},
  commentInner: {flexDirection: 'row', gap: 11, alignItems: 'flex-start'},
  commentBody: {flex: 1, minWidth: 0},
  commentMeta: {flexDirection: 'row', alignItems: 'center', gap: 8},
  commentName: {fontSize: 14, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  replyName: {fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  authorBadge: {backgroundColor: colors.accentSoft, borderRadius: 4, paddingVertical: 2, paddingHorizontal: 6},
  authorBadgeText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: colors.accent},
  commentTime: {fontSize: 12, color: colors.textMuted},
  commentText: {marginTop: 4},

  // Controls row (Reply · ▸/▾ N replies · ⋯)
  controlsRow: {flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 9},
  controlReply: {fontSize: 13, color: colors.accent},
  controlToggle: {fontSize: 13, color: colors.textSecondary, fontWeight: '600'},
  controlsSpacer: {flex: 1},
  controlMore: {fontSize: 16, color: colors.textMuted, lineHeight: 16, paddingHorizontal: 2},

  // Nested replies (left rule)
  replies: {marginTop: 12, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.border, gap: 13},
});

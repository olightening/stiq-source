/**
 * BroadcastCard — the ONE channel-message card, shared by public channels (ChannelView) AND
 * private/broadcast channels (GroupView). It owns the card chrome + body + reaction chips + footer
 * (💬 counter / time / ⋯) + the ⋯ action sheet + the expandable comment thread + composer, so a
 * public and a private channel post are pixel-for-pixel identical save for the author header.
 *
 * Channel-vs-group differences are passed in as plain props (commentsEnabled, onTogglePin,
 * onToggleReplies, onPostComment, …) — this component never branches on protocol.
 */
import React, {useState} from 'react';
import {Alert, Modal, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import Clipboard from '@react-native-clipboard/clipboard';
import type {Event} from 'nostr-tools/pure';
import type {SendStatus} from '../../nostr/outbox';
import type {CommentNode} from '../../feed/thread';
import {gradientSpecEqual, type GradientSpec} from '../../media/gradient';
import type {EmojiTally} from '../reactions';
import {type NostrEventSummary} from '../../ui/NostrLinkPreview';
import {SendProgress} from '../../feed/components/SendProgress';
import {decodeNameHeader} from '../../profile/displayName';
import {colors, space, weight, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {colors as ct, ctType, ctTracking, ctRadius, ctSpace, ctWeight} from '../tokens';
import {
  MessageBody,
  MessageCard,
  MessageFooter,
  ReactionChips,
  npubFor,
  relativeTime,
} from './primitives';
import {promotedFeedId} from '../promote';
import {inlineMediaSummary} from '../../feed/inlineMedia';
import {nostrLinkForEvent} from '../savedEmbeds';

export interface BroadcastCardProps {
  event: Event;
  /** Show the per-message author header (private/broadcast channels; false for owner-voiced public). */
  showAuthor?: boolean;
  authorName?: string;
  authorGradient?: GradientSpec;
  /** Trailing node in the author header (e.g. an ADMIN badge). */
  authorTrailing?: React.ReactNode;
  /** Private-channel-only footer author avatar — a clickable gradient circle immediately left of the
   *  timestamp (see MessageFooter). Omit for public cards, the default — they stay byte-identical. */
  author?: {seed: string; gradient?: GradientSpec; onPress?: () => void};
  /** Optimistic send status (channels); omit for group posts. */
  status?: SendStatus;
  /** Relay's rejection reason (when status is 'rejected'/'failed'); shown as muted subtext under "failed". */
  reason?: string;
  onRetry?: () => void;
  onCancel?: () => void;
  /** The configured reaction emoji set (chips render only when non-empty). */
  reactionEmojis: string[];
  /** This message's per-emoji tallies (count + whether the viewer reacted). */
  reactions: EmojiTally[];
  onReact?: (emoji: string) => void;
  /** Whether the comment thread is available (replies open, or the viewer is owner/admin). */
  commentsEnabled: boolean;
  /** Comment count from the parent's single bulk pass. */
  commentCount: number;
  onGetThread?: (messageId: string) => CommentNode[];
  /** Post a comment on THIS message (pre-bound to its id/author/kind). */
  onPostComment?: (content: string) => void;
  getCommentAuthorName?: (pubkey: string) => string | undefined;
  getCommentAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
  canModerate?: boolean;
  onModerate?: (id: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  /** Resolve a referenced nostr: event for inline REFERENCED cards. */
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  /** Tap a REFERENCED card → open that event. */
  onOpenRef?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card in the body → run the in-app accept-invite flow. */
  onOpenInviteLink?: (url: string) => void;
  /** Open this message full-screen (single-post view). */
  onOpenMessage?: () => void;
  // ── ⋯ action-sheet actions (each row shows only when its handler is provided) ──
  isMine?: boolean;
  edited?: boolean;
  onEdit?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Pinned posts collapse to a bar until expanded (channels only). */
  pinnedExpanded?: boolean;
  onTogglePinExpand?: () => void;
  /** Author (No.5): promote this channel post into a real feed thread ("enable replies"). Author-only;
      hidden once the post is already promoted. */
  onEnableReplies?: () => void;
  /** Open the feed thread this post was promoted to — set when the post carries a `promoted` tag. */
  onOpenPromoted?: (feedId: string) => void;
  /** No.3: reply count of the feed thread a promoted post points to — mirrored under the card. */
  promotedReplyCount?: number;
  onSaveToEmbed?: () => void;
  onMuteAuthor?: () => void;
  onReport?: () => void;
}

export const BroadcastCard = React.memo(function BroadcastCard({
  event,
  showAuthor,
  authorName,
  authorGradient,
  authorTrailing,
  author,
  status,
  reason,
  onRetry,
  onCancel,
  reactions,
  onReact,
  canModerate,
  onModerate,
  onLookupEvent,
  onOpenRef,
  onOpenInviteLink,
  onOpenMessage,
  isMine,
  edited,
  onEdit,
  isPinned,
  onTogglePin,
  pinnedExpanded,
  onTogglePinExpand,
  onEnableReplies,
  onOpenPromoted,
  promotedReplyCount = 0,
  onSaveToEmbed,
  onMuteAuthor,
  onReport,
}: BroadcastCardProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  const copyLink = (): void => {
    Clipboard.setString(nostrLinkForEvent({id: event.id, author: event.pubkey}));
    Alert.alert('Link copied');
  };
  const act = (fn?: () => void) => () => { setMenuOpen(false); fn?.(); };

  const npub = npubFor(event.pubkey);
  // No.5: a promoted post has been turned into a feed thread; its tap opens that thread (not the
  // in-channel detail), it shows a "shared to the feed" frame, and it can no longer be edited.
  const promoted = promotedFeedId(event);
  const openTarget = promoted && onOpenPromoted ? () => onOpenPromoted(promoted) : onOpenMessage;

  // The pinned post collapses to a compact bar until tapped (only the pinned post collapses).
  if (isPinned && !pinnedExpanded) {
    const preview = inlineMediaSummary(decodeNameHeader(event.content).text);
    return (
      <Press variant="row" style={s.pinnedCollapsed} onPress={onTogglePinExpand}>
        <Text style={s.pinnedLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>📌 Pinned</Text>
        <Text style={s.pinnedPreview} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{preview}</Text>
        <Text style={s.pinnedChevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>▾</Text>
      </Press>
    );
  }

  return (
    <MessageCard
      authored={!!showAuthor}
      authorNpub={npub}
      authorName={authorName?.trim()}
      authorGradient={authorGradient}
      authorTrailing={authorTrailing}
      frameColor={promoted ? colors.accent : undefined}
      onPress={openTarget}>
      {isPinned && (
        <Press style={s.pinnedToggleRow} onPress={onTogglePinExpand}>
          <Text style={s.pinnedLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>📌 Pinned</Text>
          <Text style={s.pinnedChevron} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>▴</Text>
        </Press>
      )}
      {promoted && (
        /* Channels 2.0 §4: the "✦ On the feed" frame is the reward for turning on replies. The accent
           frame IS the signal; this small-caps eyebrow names it and the whole card taps through to the
           feed thread (openTarget). Tags/label live on the feed post itself. */
        <Text style={s.promotedEyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✦ On the feed</Text>
      )}
      <MessageBody content={event.content} onLookupEvent={onLookupEvent} onOpenRef={onOpenRef} onOpenInviteLink={onOpenInviteLink} />
      <MessageFooter
        /* §4: once a post is ON THE FEED, engagement moves there — the card drops its in-channel
           reaction chips (for EVERYONE, author and viewers alike, since this is the one shared card)
           and instead mirrors the feed post's ✦/💬 counter on the right, tapping through to the feed. */
        time={promoted
          ? `✦ · 💬 ${promotedReplyCount} · on the feed ›`
          : relativeTime(event.created_at) + (edited ? ' · edited' : '')}
        leading={promoted ? undefined : <ReactionChips inline reactions={reactions} onReact={onReact} />}
        trailing={<SendProgress status={status} reason={reason} onRetry={onRetry} onCancel={onCancel} size={14} />}
        author={author}
        onMenu={() => setMenuOpen(true)}
      />

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        {/* Backdrop scrim — tap outside to dismiss; deliberately no press feedback. */}
        <Press variant="bare" style={s.sheetBackdrop} onPress={() => setMenuOpen(false)} accessibilityRole="none" />
        <View style={s.sheetWrap}>
          <View style={s.sheetCard}>
          <Press variant="row" style={s.menuRow} onPress={act(copyLink)}>
            <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔗</Text><Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Copy link</Text>
          </Press>
          {isMine && onEdit && !promoted && (
            <Press variant="row" style={s.menuRow} onPress={act(onEdit)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>✏️</Text><Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Edit</Text>
            </Press>
          )}
          {onTogglePin && (
            <Press variant="row" style={s.menuRow} onPress={act(onTogglePin)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>📌</Text>
              <Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{isPinned ? 'Unpin from channel' : 'Pin to channel'}</Text>
            </Press>
          )}
          {isMine && onEnableReplies && !promoted && (
            <Press variant="row" style={s.menuRow} onPress={act(onEnableReplies)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>💬</Text>
              <Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Turn on replies</Text>
            </Press>
          )}
          {onSaveToEmbed && (
            <Press variant="row" style={s.menuRow} onPress={act(onSaveToEmbed)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔖</Text><Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Save to embed later</Text>
            </Press>
          )}
          {onMuteAuthor && (
            <Press variant="row" style={s.menuRow} onPress={act(onMuteAuthor)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🔕</Text><Text style={s.menuLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Mute this author</Text>
            </Press>
          )}
          {canModerate && onModerate && (
            <Press
              variant="row"
              style={s.menuRow}
              onPress={act(() => Alert.alert('Hide this message?', 'It will be removed from your channel and logged.', [
                {text: 'Cancel', style: 'cancel'},
                {text: 'Hide', style: 'destructive', onPress: () => onModerate(event.id, event.pubkey, 'hide')},
              ]))}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🚫</Text><Text style={[s.menuLabel, s.menuDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Hide message</Text>
            </Press>
          )}
          {onReport && (
            <Press variant="row" style={[s.menuRow, s.menuRowLast]} onPress={act(onReport)}>
              <Text style={s.menuIcon} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🚩</Text><Text style={[s.menuLabel, s.menuDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Report</Text>
            </Press>
          )}
          </View>
          <Press style={s.sheetCancel} onPress={() => setMenuOpen(false)}>
            <Text style={s.sheetCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
          </Press>
        </View>
      </Modal>
    </MessageCard>
  );
}, (prev, next) => {
  const gradSame = gradientSpecEqual(prev.authorGradient, next.authorGradient);
  const authorSame =
    prev.author?.seed === next.author?.seed &&
    prev.author?.onPress === next.author?.onPress &&
    gradientSpecEqual(prev.author?.gradient, next.author?.gradient);
  const reactSame =
    prev.reactions.length === next.reactions.length &&
    prev.reactions.every((r, i) => {
      const n = next.reactions[i];
      return !!n && r.emoji === n.emoji && r.count === n.count && r.mine === n.mine;
    });
  return (
    prev.event.id === next.event.id &&
    prev.event.content === next.event.content &&
    promotedFeedId(prev.event) === promotedFeedId(next.event) &&
    prev.promotedReplyCount === next.promotedReplyCount &&
    prev.edited === next.edited &&
    prev.isMine === next.isMine &&
    prev.status === next.status &&
    prev.reason === next.reason &&
    prev.canModerate === next.canModerate &&
    prev.authorName === next.authorName &&
    prev.isPinned === next.isPinned &&
    prev.pinnedExpanded === next.pinnedExpanded &&
    prev.showAuthor === next.showAuthor &&
    reactSame &&
    gradSame &&
    authorSame
  );
});

const s = StyleSheet.create({
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
  // ── bottom sheet (⋯ action sheet) ──
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
  // ── "✦ On the feed" marker (§4): a small-caps accent eyebrow above the body — the accent frame is
  //    the reward signal; this names it. ──
  promotedEyebrow: {
    marginBottom: space.xs,
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.accent,
  },
});

/**
 * CommentItem — one comment in a thread (design spec `.comment`).
 *
 * Identity row (name · Author badge · time), the body (clamped to 4 lines past ~240 chars with a
 * "Read more"), any reference embeds, then a meta row: ✦ like, Reply, the replies toggle, and ⋯.
 * Replies are indented by depth and ride a left rail. The ⋯ opens a bottom action sheet.
 */
import React, {useEffect, useState} from 'react';
import {Modal, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import type {CommentNode} from '../thread';
import {Press} from '../../ui/Press';
import {colors} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {RichText} from './RichText';
import {SendProgress} from './SendProgress';
import type {SendStatus} from '../../nostr/outbox';
import {Icon} from '../../ui/icons';
import {decodeNameHeader} from '../../profile/displayName';
import {paragraphAlign} from '../../ui/textDirection';
import {gradientSpecEqual, type GradientSpec} from '../../media/gradient';
import type {NostrEventSummary} from '../../ui/NostrLinkPreview';
import {relTime} from '../../ui/relTime';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import {nostrLinkForNote} from '../../channels/savedEmbeds';
import {resolveAuthor} from '../../blind/identity';
import {resolveContent, contentEpochOf, contentLockState} from '../../blind/blindPost';
import {isEpochUnlockUnavailable, requestEpochUnlock} from '../../blind/unlockState';

function relativeTime(ts: number): string {
  return relTime(ts, 'short-days');
}

const READ_MORE_CHARS = 240;

export interface CommentItemProps {
  node: CommentNode;
  collapsed: boolean;
  onToggle: () => void;
  onReply: () => void;
  authorName?: string | null;
  authorGradient?: GradientSpec;
  onAuthorPress?: () => void;
  /** This comment is by the post's author — shows an "Author" badge. */
  isOp?: boolean;
  /** First comment in its sibling group (or the very first) — drops the top divider (spec `:first-child`). */
  isFirst?: boolean;
  /** Aggregate ✦ score and whether the viewer has liked it. */
  score?: number;
  liked?: boolean;
  onLike?: () => void;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  isModerator?: boolean;
  onModeratorHide?: () => void;
  onModeratorHideUser?: () => void;
  /** Save/bookmark this comment. */
  onSaveComment?: () => void;
  /** Mute this comment's author. */
  onMuteAuthor?: () => void;
  /** Report this comment. */
  onReportComment?: () => void;
  /** Whether this comment is currently saved (drives the Save row's ✅/🔖). */
  isSaved?: boolean;
  /** Optimistic delivery status for this comment (drives the send indicator). */
  status?: SendStatus;
  /** Relay's rejection reason (when status is 'rejected') — shown next to "failed". */
  reason?: string;
  /** True when `status === 'sending'` is a pre-connect queue (relay/Tor not up yet) rather than an
   *  active in-flight publish — renders "Queued — connecting…" instead of "Sending…" (M7). */
  queuedOffline?: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
}

export const CommentItem = React.memo(function CommentItem({
  node,
  collapsed,
  onToggle,
  onReply,
  authorName,
  authorGradient,
  onAuthorPress,
  isOp,
  isFirst,
  score,
  liked,
  onLike,
  onLookupEvent,
  onOpenNostrPost,
  isModerator,
  onModeratorHide,
  onModeratorHideUser,
  onSaveComment,
  onMuteAuthor,
  onReportComment,
  isSaved,
  status,
  reason,
  queuedOffline,
  onRetry,
  onCancel,
}: CommentItemProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const replyCount = node.children.length;
  const isReply = node.depth > 0;
  // A comment may be a blind post (throwaway-signed) — resolve its real author before deriving the
  // avatar seed/name fallback, or every blind comment renders anonymous under its throwaway signer
  // (mirrors CommentThread's fix for the same class of bug).
  const author = resolveAuthor(node.event);
  const npubFull = safeNpubEncode(author.pubkey);
  const name = authorName?.trim() || shortenNpub(npubFull, {lead: 10, tail: 4});
  // Resolve once per node: passthrough for a plain comment; '' + locked for a still-sealed one
  // (members-only invisible redesign, 2026-07-21) — every measurement/render below reads `body`,
  // never node.event.content directly, so ciphertext can never reach the screen or the "Read more"
  // length check.
  const body = resolveContent(node.event);
  const epoch = contentEpochOf(node.event);
  const long = body.text.length > READ_MORE_CHARS;
  // Unresolvable epoch (no `ke` tag survived) reads the same as an organizer refusal — there is no
  // epoch left to background-unlock, so the quiet members-only card is the only honest state.
  const unavailable = epoch === null || isEpochUnlockUnavailable(epoch);

  // Invisible auto-unlock kick: the feed/thread build already sweeps locked epochs it knows about,
  // but a thread can render off an older cached page before any sweep ran (cold start) — this is
  // belt-and-braces, deduped by the runtime. No tap, no visible affordance.
  useEffect(() => {
    if (body.locked && epoch !== null) requestEpochUnlock(epoch);
  }, [body.locked, epoch]);

  const copyLink = (): void => {
    Clipboard.setString(nostrLinkForNote(node.event.id));
    setMenuOpen(false);
  };

  return (
    <View style={[styles.comment, isReply && styles.reply, {marginLeft: node.depth * 16}, isFirst && styles.noTopBorder]}>
      <Press onPress={onAuthorPress} style={styles.avatarCol}>
        <GradientAvatar gradient={authorGradient} seed={npubFull} size={isReply ? 28 : 34} />
      </Press>

      <View style={styles.body}>
        {/* Name row */}
        <Press onPress={onAuthorPress} style={styles.nameRow}>
          <Text style={[styles.name, isReply && styles.nameReply]} numberOfLines={1}>{name}</Text>
          {isOp ? <Text style={styles.opBadge}>Author</Text> : null}
          <Text style={styles.when}>{relativeTime(node.event.created_at)}</Text>
        </Press>

        {/* Body (rich text + reference embeds + link bubbles). RichText applies per-paragraph
            direction internally; we also align the body container on the comment's first-strong
            direction (decoded past the identity header) so a single-line comment aligns right.
            A still-sealed body renders a neutral pending placeholder (no lock iconography — the
            member is not meant to notice the meter) unless the organizer refused this epoch's
            unlock, in which case a quiet members-only line replaces it. Ciphertext never reaches
            RichText, decodeNameHeader, or the "Read more" measurement — all read `body.text`. */}
        {body.locked ? (
          unavailable ? (
            <View style={styles.lockedBanner}>
              <Icon name="🔒" size={12} />
              <Text style={styles.lockedLabel}>Members-only content</Text>
            </View>
          ) : (
            <View style={styles.lockedPending} accessibilityLabel="loading">
              <View style={styles.lockedPendingBar} />
              <View style={[styles.lockedPendingBar, styles.lockedPendingBarShort]} />
            </View>
          )
        ) : (
          <>
            <RichText
              style={[styles.text, paragraphAlign(decodeNameHeader(body.text).text)]}
              numberOfLines={long && !expanded ? 4 : undefined}
              content={body.text}
              onLookupEvent={onLookupEvent}
              onOpenNostrPost={onOpenNostrPost}
            />
            {long ? (
              <Press onPress={() => setExpanded(e => !e)}>
                <Text style={styles.showMore}>{expanded ? 'Read less' : 'Read more'}</Text>
              </Press>
            ) : null}
          </>
        )}

        {/* Meta row: ✦ like · Reply · replies toggle · ⋯ */}
        <View style={styles.meta}>
          {score != null ? (
            <Press style={styles.act} onPress={onLike} accessibilityLabel="like">
              <Text style={[styles.likeGlyph, liked && styles.likeOn]}>✦</Text>
              <Text style={[styles.likeCount, liked && styles.likeOn]}>{score}</Text>
            </Press>
          ) : null}
          <Press accessibilityLabel="reply" onPress={onReply}>
            <Text style={styles.replyAct}>Reply</Text>
          </Press>
          <View style={styles.spacer} />
          <SendProgress status={status} reason={reason} queuedOffline={queuedOffline} onRetry={onRetry} onCancel={onCancel} />
          {replyCount > 0 ? (
            <Press accessibilityLabel="toggle-replies" onPress={onToggle} style={styles.toggle}>
              <Text style={styles.caret}>{collapsed ? '▸' : '▾'}</Text>
              <Text style={styles.toggleText}>
                {collapsed
                  ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} hidden`
                  : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
              </Text>
            </Press>
          ) : null}
          <Press accessibilityLabel="comment-more" onPress={() => setMenuOpen(true)} style={styles.moreC}>
            <Text style={styles.moreCText}>⋯</Text>
          </Press>
        </View>
      </View>

      {/* ⋯ action sheet */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Press variant="bare" style={styles.sheetBack} onPress={() => setMenuOpen(false)} accessibilityRole="none">
          <Press variant="bare" style={styles.sheet} onPress={() => {}} accessibilityRole="none">
            <View style={styles.sheetCard}>
              <Press variant="row" style={styles.sheetItem} onPress={copyLink}>
                <View style={styles.sheetIcon}><Icon name="🔗" size={16}/></View>
                <Text style={styles.sheetText}>Copy link</Text>
              </Press>
              {onSaveComment && (
                <Press
                  variant="row"
                  accessibilityLabel="save-comment"
                  style={styles.sheetItem}
                  onPress={() => { setMenuOpen(false); onSaveComment(); }}>
                  <View style={styles.sheetIcon}><Icon name={isSaved ? '✅' : '🔖'} size={16}/></View>
                  <Text style={styles.sheetText}>{isSaved ? 'Saved · tap to remove' : 'Save'}</Text>
                </Press>
              )}
              {onMuteAuthor && (
                <Press
                  variant="row"
                  accessibilityLabel="mute-author"
                  style={styles.sheetItem}
                  onPress={() => { setMenuOpen(false); onMuteAuthor(); }}>
                  <View style={styles.sheetIcon}><Icon name="🔕" size={16}/></View>
                  <Text style={styles.sheetText}>Mute this author</Text>
                </Press>
              )}
              <Press
                variant="row"
                accessibilityLabel="report-comment"
                style={styles.sheetItem}
                onPress={() => { setMenuOpen(false); onReportComment?.(); }}>
                <View style={styles.sheetIcon}><Icon name="🚩" size={16}/></View>
                <Text style={[styles.sheetText, styles.sheetDanger]}>Report</Text>
              </Press>
              {isModerator && onModeratorHide && (
                <Press
                  variant="row"
                  accessibilityLabel="mod-hide-comment"
                  style={styles.sheetItem}
                  onPress={() => { setMenuOpen(false); onModeratorHide(); }}>
                  <View style={styles.sheetIcon}><Icon name="🙈" size={16}/></View>
                  <Text style={[styles.sheetText, styles.sheetDanger]}>Hide comment</Text>
                </Press>
              )}
              {isModerator && onModeratorHideUser && (
                <Press
                  variant="row"
                  accessibilityLabel="mod-hide-user"
                  style={[styles.sheetItem, styles.sheetItemLast]}
                  onPress={() => { setMenuOpen(false); onModeratorHideUser(); }}>
                  <View style={styles.sheetIcon}><Icon name="🚫" size={16}/></View>
                  <Text style={[styles.sheetText, styles.sheetDanger]}>Hide this user</Text>
                </Press>
              )}
            </View>
            <Press style={styles.sheetCancel} onPress={() => setMenuOpen(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Press>
          </Press>
        </Press>
      </Modal>
    </View>
  );
}, (prev, next) => {
  const gradSame = gradientSpecEqual(prev.authorGradient, next.authorGradient);
  return (
    prev.node.event.id === next.node.event.id &&
    // A sealed comment's lock state ('' | 'u' | 'L') can flip L→u purely from the background
    // auto-unlock landing a content key — no prop above would otherwise change, so the memo would
    // never re-render past the pending placeholder (mirrors feed.ts baking this into FeedItem's
    // cache key for PostCard's reference-equality check).
    contentLockState(prev.node.event) === contentLockState(next.node.event) &&
    prev.node.children.length === next.node.children.length &&
    prev.node.depth === next.node.depth &&
    prev.collapsed === next.collapsed &&
    prev.authorName === next.authorName &&
    prev.isOp === next.isOp &&
    prev.isFirst === next.isFirst &&
    prev.score === next.score &&
    prev.liked === next.liked &&
    prev.isModerator === next.isModerator &&
    prev.isSaved === next.isSaved &&
    prev.status === next.status &&
    prev.reason === next.reason &&
    prev.queuedOffline === next.queuedOffline &&
    gradSame
  );
});

const styles = StyleSheet.create({
  comment: {
    flexDirection: 'row',
    gap: 11,
    marginRight: 20,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 20,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  // Replies ride a left rail. Top divider is controlled by `isFirst` (spec `:first-child` only).
  reply: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  avatarCol: {paddingTop: 0},
  noTopBorder: {borderTopWidth: 0},
  body: {flex: 1, minWidth: 0},
  nameRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8},
  name: {fontSize: 15, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  nameReply: {fontSize: 14},
  opBadge: {
    fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: colors.accent, textTransform: 'uppercase',
    backgroundColor: colors.accentSoft, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2,
    overflow: 'hidden',
  },
  when: {fontSize: 12, fontWeight: '400', color: colors.textMuted},
  text: {fontSize: 15, lineHeight: 23, fontWeight: '400', color: colors.textPrimary, marginTop: 5},
  showMore: {color: colors.accent, fontSize: 13, fontWeight: '600', paddingTop: 7, paddingBottom: 2},

  // ── Members-only sealed body (invisible auto-unlock) — comment scale mirror of PostCard's s.* ──
  lockedPending: {paddingVertical: 4, gap: 5, marginTop: 5},
  lockedPendingBar: {height: 9, borderRadius: 4, backgroundColor: colors.surfaceAlt, alignSelf: 'stretch'},
  lockedPendingBarShort: {width: '58%', alignSelf: 'flex-start'},
  lockedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 5,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  lockedLabel: {fontSize: 12.5, fontWeight: '600', color: colors.textSecondary},
  meta: {flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 10},
  spacer: {flex: 1},
  act: {flexDirection: 'row', alignItems: 'center', gap: 5},
  likeGlyph: {fontSize: 13, fontWeight: '400', color: colors.textSecondary},
  likeCount: {fontSize: 13, fontWeight: '400', color: colors.textSecondary, fontVariant: ['tabular-nums']},
  likeOn: {color: colors.accent},
  replyAct: {fontSize: 13, color: colors.accent, fontWeight: '400'},
  toggle: {flexDirection: 'row', alignItems: 'center', gap: 5},
  caret: {fontSize: 10, fontWeight: '400', color: colors.textSecondary},
  toggleText: {fontSize: 12.5, fontWeight: '600', color: colors.textSecondary},
  moreC: {paddingHorizontal: 0},
  moreCText: {fontSize: 16, lineHeight: 16, fontWeight: '400', color: colors.textSecondary},

  // ── Action sheet ──
  sheetBack: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {paddingHorizontal: 10, paddingBottom: 12},
  sheetCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', marginBottom: 8},
  sheetItem: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 15, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: colors.border},
  sheetItemLast: {borderBottomWidth: 0},
  sheetIcon: {width: 16, alignItems: 'center'},
  sheetText: {fontSize: 16, fontWeight: '500', color: colors.textPrimary},
  sheetDanger: {color: colors.danger},
  sheetCancel: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingVertical: 15, alignItems: 'center'},
  sheetCancelText: {fontSize: 16, fontWeight: '600', color: colors.accent},
});

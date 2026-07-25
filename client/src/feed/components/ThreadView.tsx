/**
 * ThreadView — renders a nested comment thread with collapse/expand (PLAN.md §2 / Step 14).
 * Root-level comments that have replies start collapsed so the thread isn't overwhelming.
 */
import React, {useCallback, useState} from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import type {Event} from 'nostr-tools/pure';
import type {CommentNode} from '../thread';
import {visibleNodes} from '../collapse';
import {CommentItem} from './CommentItem';
import {colors, space, type as typeScale} from '../../ui/theme';
import {resolveAuthorPubkey} from '../../blind/identity';
import type {SendStatus} from '../../nostr/outbox';
export interface ThreadViewProps {
  nodes: CommentNode[];
  onReply?: (node: CommentNode) => void;
  getAuthorName?: (event: Event) => string | null;
  getAuthorGradient?: (event: Event) => import('../../media/gradient').GradientSpec | undefined;
  /** Tapping an author's avatar/name navigates to their profile. */
  onAuthorPress?: (pubkey: string) => void;
  isModerator?: boolean;
  onModeratorHide?: (event: Event) => void;
  onModeratorHideUser?: (event: Event) => void;
  /** Save/bookmark a comment. */
  onSaveComment?: (event: Event) => void;
  /** Mute a comment's author. */
  onMuteAuthor?: (event: Event) => void;
  /** Report a comment. */
  onReportComment?: (event: Event) => void;
  /** Whether a comment is currently saved (drives the Save row's ✅/🔖). */
  getCommentSaved?: (id: string) => boolean;
  listHeader?: React.ReactElement;
  /** External ref to the underlying FlatList — lets the post-detail appbar jump to the comments. */
  listRef?: React.Ref<FlatList<import('../thread').CommentNode & {depth: number}>>;
  /** The post author's pubkey — comments by them get an "Author" badge. */
  opPubkey?: string;
  /** Aggregate score + viewer's vote for a comment (drives the ✦ like). */
  getScore?: (id: string) => {score: number; myVote: import('../voting').VoteDirection | null};
  /** Cast / retract a ✦ like on a comment. */
  onLike?: (event: Event) => void;
  /** Resolve a quoted post/comment for reference embeds inside a comment. */
  onLookupEvent?: (id: string) => import('../../ui/NostrLinkPreview').NostrEventSummary | null;
  /** Open a referenced post/comment when its embed is tapped. */
  onOpenNostrPost?: (id: string) => void;
  /** Per-comment optimistic delivery status, keyed by comment event id (drives the send indicator). */
  sendStatus?: ReadonlyMap<string, SendStatus>;
  /** Per-comment relay rejection reason (only rejected ids) — shown next to "failed". */
  sendReasons?: ReadonlyMap<string, string>;
  /** Comment ids whose 'sending' status is a pre-connect queue (relay/Tor not up yet) rather than an
   *  active in-flight publish — drives "Queued — connecting…" vs "Sending…" on a comment's send
   *  indicator (M7). */
  sendQueuedOffline?: ReadonlySet<string>;
  /** Retry a failed comment send. */
  onRetryComment?: (id: string) => void;
  /** Cancel / dismiss a failed comment send. */
  onCancelComment?: (id: string) => void;
  /**
   * Stable React list key for an event id (AppRuntime.stableListKey). When our own optimistic
   * comment finishes signing, its `local-…` placeholder id is swapped for the real event id —
   * keying rows through this keeps ONE key across that swap so the just-sent comment never
   * unmounts/remounts (the same cure FeedList.feedItemKey applies to the feed). Omitted → raw id.
   */
  listKeyFor?: (id: string) => string;
  /**
   * True while the thread hasn't been computed yet (the deferred InteractionManager pass after a
   * post opens). Suppresses the "No comments yet." empty state so a post with comments never
   * FLASHES it during the compute gap — `[]`-when-pending is indistinguishable from genuinely
   * empty, which was exactly the flicker (stale-first rule, Phase 3.1/5).
   */
  pending?: boolean;
}

export function ThreadView({
  nodes,
  onReply,
  getAuthorName,
  getAuthorGradient,
  onAuthorPress,
  isModerator,
  onModeratorHide,
  onModeratorHideUser,
  onSaveComment,
  onMuteAuthor,
  onReportComment,
  getCommentSaved,
  listHeader,
  listRef,
  opPubkey,
  getScore,
  onLike,
  onLookupEvent,
  onOpenNostrPost,
  sendStatus,
  sendReasons,
  sendQueuedOffline,
  onRetryComment,
  onCancelComment,
  listKeyFor,
  pending,
}: ThreadViewProps): React.JSX.Element {
  // Every node that has replies starts collapsed (walk the WHOLE tree, not just roots) so that
  // expanding a node reveals only its DIRECT children — deeper descendants stay collapsed until
  // their own node is tapped (one level per tap).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    const seed = (ns: CommentNode[]): void => {
      for (const n of ns) {
        if (n.children.length > 0) { s.add(n.event.id); seed(n.children); }
      }
    };
    seed(nodes);
    return s;
  });

  const toggle = useCallback((id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  const visible = visibleNodes(nodes, collapsed);

  const renderItem = useCallback(({item, index}: {item: import('../thread').CommentNode & {depth: number}; index: number}) => {
    const sc = getScore ? getScore(item.event.id) : undefined;
    // First in its sibling group (or the very first row): the flattened list always places a
    // node's first child immediately after it at a greater depth — spec `:first-child` drops the
    // top divider; later siblings (same depth) keep theirs.
    const isFirst = index === 0 || item.depth > (visible[index - 1]?.depth ?? -1);
    return (
      <CommentItem
        node={item}
        collapsed={collapsed.has(item.event.id)}
        onToggle={() => toggle(item.event.id)}
        onReply={() => onReply?.(item)}
        authorName={getAuthorName ? getAuthorName(item.event) : undefined}
        authorGradient={getAuthorGradient ? getAuthorGradient(item.event) : undefined}
        onAuthorPress={onAuthorPress ? () => onAuthorPress(resolveAuthorPubkey(item.event)) : undefined}
        isOp={!!opPubkey && resolveAuthorPubkey(item.event) === opPubkey}
        isFirst={isFirst}
        score={sc?.score}
        liked={sc?.myVote === 'up'}
        onLike={onLike ? () => onLike(item.event) : undefined}
        onLookupEvent={onLookupEvent}
        onOpenNostrPost={onOpenNostrPost}
        isModerator={isModerator}
        onModeratorHide={onModeratorHide ? () => onModeratorHide(item.event) : undefined}
        onModeratorHideUser={onModeratorHideUser ? () => onModeratorHideUser(item.event) : undefined}
        onSaveComment={onSaveComment ? () => onSaveComment(item.event) : undefined}
        onMuteAuthor={onMuteAuthor ? () => onMuteAuthor(item.event) : undefined}
        onReportComment={onReportComment ? () => onReportComment(item.event) : undefined}
        isSaved={getCommentSaved ? getCommentSaved(item.event.id) : undefined}
        status={sendStatus?.get(item.event.id)}
        reason={sendReasons?.get(item.event.id)}
        queuedOffline={sendQueuedOffline?.has(item.event.id)}
        onRetry={onRetryComment ? () => onRetryComment(item.event.id) : undefined}
        onCancel={onCancelComment ? () => onCancelComment(item.event.id) : undefined}
      />
    );
  }, [visible, collapsed, toggle, onReply, getAuthorName, getAuthorGradient, onAuthorPress, opPubkey, getScore, onLike, onLookupEvent, onOpenNostrPost, isModerator, onModeratorHide, onModeratorHideUser, onSaveComment, onMuteAuthor, onReportComment, getCommentSaved, sendStatus, sendReasons, sendQueuedOffline, onRetryComment, onCancelComment]);
  return (
    <FlatList
      ref={listRef}
      data={visible}
      keyExtractor={node => (listKeyFor ? listKeyFor(node.event.id) : node.event.id)}
      ListHeaderComponent={listHeader}
      removeClippedSubviews
      maxToRenderPerBatch={8}
      windowSize={5}
      onScrollToIndexFailed={info => {
        // Variable-height comments aren't all measured; approximate, then settle next frame.
        const list = typeof listRef === 'function' ? null : listRef?.current;
        list?.scrollToOffset({offset: info.averageItemLength * info.index, animated: false});
        setTimeout(() => list?.scrollToIndex({index: info.index, animated: true, viewPosition: 0}), 60);
      }}
      ListEmptyComponent={
        pending ? null : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No comments yet.</Text>
          </View>
        )
      }
      renderItem={renderItem}
    />
  );
}

const styles = StyleSheet.create({
  empty: {padding: space.xl, alignItems: 'center'},
  emptyText: {color: colors.textSecondary, fontSize: typeScale.body, fontWeight: '400'},
});

/**
 * FeedList — the main community feed (PLAN.md §2 / Step 12). Renders feed items as cards.
 */
import React, {forwardRef, useCallback, useMemo, useRef} from 'react';
import {FlatList, RefreshControl, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent} from 'react-native';
import {colors} from '../../ui/theme';
import {BOTTOM_DOCK_CLEARANCE} from '../../ui/BottomDock';
import {isOnline, type ConnectionState} from '../../connection';
import type {FeedItem} from '../feed';
import type {VoteDirection} from '../voting';
import type {SendStatus} from '../../nostr/outbox';
import {DEFAULT_LABELS, type LabelConfig, type PostLabel} from '../labels';
import {EmptyState} from '../../ui/EmptyState';
import {PostCard} from './PostCard';

/**
 * React key for a feed row — NOT the event id, and that distinction is the whole point.
 *
 * When one of your own posts finishes signing, AppRuntime swaps the optimistic placeholder for the
 * real signed event (signPendingWrite: discardPlaceholder → publishOptimistic). Those two carry
 * DIFFERENT ids by construction — `local-<ts>-<rand>` versus the real 64-hex event hash — so keying
 * on `id` changed the row's key mid-swap. React reads a changed key as "different row": it unmounts
 * the cell and mounts a new one, and because this list has variable item heights and no
 * getItemLayout, the replacement re-measures from zero. That is the post visibly vanishing and
 * coming back after publishing.
 *
 * `sortAt` is the fix and it needs no new plumbing: it is the local publish-order key that
 * _ownPostOrder already carries ACROSS the swap (AppRuntime.signPendingWrite transfers it onto the
 * real event id), and recordOwnPostOrder makes it strictly monotonic, so it is unique per own post
 * even within one millisecond. Same row, same key, no remount.
 *
 * Everyone else's posts have no sortAt and fall back to `id`, which is already stable for them.
 * (_ownPostOrder is bounded to 512 entries; an evicted post loses sortAt and re-keys once — by then
 * it is hundreds of posts up the list and nobody is looking at it.)
 */
export const feedItemKey = (item: FeedItem): string =>
  item.sortAt !== undefined ? `own-${item.sortAt}` : item.id;

export interface FeedListProps {
  items: FeedItem[];
  /** Organizer-defined labels for chip rendering + the moderator re-tag picker. */
  labels?: LabelConfig;
  sendStatus?: ReadonlyMap<string, SendStatus>;
  /** Per-event relay rejection reason (only rejected ids) — shown next to "failed". */
  sendReasons?: ReadonlyMap<string, string>;
  /** Ids whose 'sending' status is a pre-connect queue (relay/Tor not up yet) rather than an active
   *  in-flight publish — drives "Queued — connecting…" vs "Sending…" on a card's send indicator (M7). */
  sendQueuedOffline?: ReadonlySet<string>;
  onVote?: (postId: string, authorPubkey: string, direction: VoteDirection) => void;
  onItemPress?: (item: FeedItem) => void;
  onRetry?: (eventId: string) => void;
  onCancel?: (eventId: string) => void;
  onAuthorPress?: (authorPubkey: string) => void;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** M5: drag started (park deferred relay-driven re-renders so the list doesn't jump under a sync
   *  burst mid-scroll) — see AppRuntime.setScrolling. */
  onScrollBeginDrag?: () => void;
  /** M5: drag/fling settled — flush the parked deferred emit. Fired from BOTH onScrollEndDrag and
   *  onMomentumScrollEnd (idempotent), same as the existing onScroll settle-evaluation below. */
  onScrollSettle?: () => void;
  /** Auto-pagination: fired as the user nears the end so more items load without a manual tap. */
  onEndReached?: () => void;
  onLookupEvent?: (id: string) => import('../../ui/NostrLinkPreview').NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  isModerator?: boolean;
  onModeratePost?: (postId: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  lockedIds?: ReadonlySet<string>;
  pinnedIds?: ReadonlySet<string>;
  onModeratorLock?: (postId: string, authorPubkey: string, lock: boolean) => void;
  onModeratorRetag?: (postId: string, authorPubkey: string, label: PostLabel) => void;
  onModeratorPin?: (postId: string, authorPubkey: string, pin: boolean) => void;
  bookmarkedPostIds?: readonly string[];
  onToggleBookmark?: (postId: string) => void;
  onReportPost?: (postId: string, authorPubkey: string) => void;
  /** Mute this author LOCALLY (device-only; publishes nothing). Threaded to each card's ⋯ menu. */
  onMuteAuthor?: (authorPubkey: string) => void;
  /** Spend a read-token to unlock a locked post's content epoch (C7; ships dark — no item is locked
   *  until content encryption is live). Wired to a card only when it is locked with a known epoch. */
  onUnlockContent?: (epoch: number) => void;
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  /** Pull-to-refresh: whether the resync spinner is showing. */
  refreshing?: boolean;
  /** Pull-to-refresh: invoked when the user pulls down at the top of the feed. */
  onRefresh?: () => void;
  /** Live Tor connection state — drives the empty state: skeleton placeholders while still connecting
   *  (e.g. a fresh download with an empty cache during the 30-90s Tor bootstrap), honest "quiet"
   *  copy once connected. Omitted → treated as connected (the plain empty copy). */
  connection?: ConnectionState;
  /**
   * Tab-switch scroll restore: the offset (px) to jump back to, ONCE, the first time this list's
   * content is measured after mount. The feed tab body unmounts on tab switch (MainScreen renders
   * it as `{tab === 'feed' && …}`), so a fresh FeedList always mounts at offset 0 — this restores
   * the reader's actual position instead of stranding them at the top. Applied via the same
   * one-shot `onContentSizeChange` idiom as GroupView.tsx/ChannelView.tsx's own initial-scroll
   * handling: fires at most once per mount, so a later loadMore/refresh/prepend never re-scrolls.
   */
  restoreOffset?: number;
}

/**
 * Empty-feed placeholder shown while Tor is still connecting (fresh download = empty cache + a slow
 * first sync). Static, dimmed post silhouettes — NO shimmer animation, because the single Hermes JS
 * thread is busy bootstrapping Tor at this moment and a JS-driven animation would jank. Reads as
 * "content is on the way" instead of a bare "No posts yet." on a slow first run.
 */
function FeedSkeleton(): React.JSX.Element {
  return (
    <View style={styles.skeleton} pointerEvents="none">
      {[0, 1, 2].map(i => (
        <View key={i} style={styles.skelCard}>
          <View style={styles.skelHeaderRow}>
            <View style={styles.skelAvatar} />
            <View style={styles.skelName} />
          </View>
          <View style={styles.skelLineWide} />
          <View style={styles.skelLine} />
          <View style={styles.skelLineShort} />
        </View>
      ))}
    </View>
  );
}

export const FeedList = forwardRef<FlatList<FeedItem>, FeedListProps>(function FeedList(
  {items, labels = DEFAULT_LABELS, sendStatus, sendReasons, sendQueuedOffline, onVote, onItemPress, onRetry, onCancel, onAuthorPress, onScroll, onScrollBeginDrag, onScrollSettle, onEndReached, onLookupEvent, onOpenNostrPost, isModerator, onModeratePost, lockedIds, pinnedIds, onModeratorLock, onModeratorRetag, onModeratorPin, bookmarkedPostIds, onToggleBookmark, onReportPost, onMuteAuthor, onUnlockContent, header, footer, refreshing, onRefresh, connection, restoreOffset},
  ref,
): React.JSX.Element {
  const bookmarkedSet = useMemo(() => new Set(bookmarkedPostIds), [bookmarkedPostIds]);

  // Tab-switch scroll restore (one-shot): the very first content-size measurement after this list
  // mounts jumps to `restoreOffset`, then never again — later content growth (loadMore, a live
  // prepend, pull-to-refresh) must not keep re-snapping the list back.
  const restoredRef = useRef(false);
  const handleContentSizeChange = useCallback(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (restoreOffset && restoreOffset > 0) {
      const list = typeof ref === 'function' ? null : ref?.current;
      list?.scrollToOffset({offset: restoreOffset, animated: false});
    }
  }, [restoreOffset, ref]);

  // Per-item moderator-prop cache (P2-2 / C2): PostCard is React.memo'd, but building a fresh
  // `moderator` object (with fresh onHide/onLockThread/… closures) on every renderItem call gave
  // every cell a changed prop reference every time — even one whose own lock/pin state and
  // moderator callbacks hadn't changed, and even when renderItem was only recreated for a reason
  // unrelated to that item (e.g. the outbox snapshots below regaining a stable identity still
  // leaves genuine changes like a new `labels` object). Cache the object per item id, keyed on the
  // fields that actually determine its contents, so an untouched cell reuses the SAME moderator
  // object and its memo comparison can bail out.
  const moderatorCacheRef = useRef(new Map<string, {
    locked: boolean | undefined;
    pinned: boolean | undefined;
    onModeratePost: typeof onModeratePost;
    onModeratorLock: typeof onModeratorLock;
    onModeratorRetag: typeof onModeratorRetag;
    onModeratorPin: typeof onModeratorPin;
    value: NonNullable<React.ComponentProps<typeof PostCard>['moderator']>;
  }>());
  const moderatorFor = useCallback((item: FeedItem): React.ComponentProps<typeof PostCard>['moderator'] => {
    if (!isModerator) return undefined;
    const locked = lockedIds?.has(item.id);
    const pinned = pinnedIds?.has(item.id);
    const cached = moderatorCacheRef.current.get(item.id);
    if (
      cached &&
      cached.locked === locked &&
      cached.pinned === pinned &&
      cached.onModeratePost === onModeratePost &&
      cached.onModeratorLock === onModeratorLock &&
      cached.onModeratorRetag === onModeratorRetag &&
      cached.onModeratorPin === onModeratorPin
    ) {
      return cached.value;
    }
    const value = {
      onHide: () => onModeratePost?.(item.id, item.authorPubkey, 'hide'),
      onHideUser: () => onModeratePost?.(item.id, item.authorPubkey, 'hideUser'),
      locked,
      pinned,
      onLockThread: () => onModeratorLock?.(item.id, item.authorPubkey, !locked),
      onRetag: (label: PostLabel) => onModeratorRetag?.(item.id, item.authorPubkey, label),
      onPin: () => onModeratorPin?.(item.id, item.authorPubkey, !pinned),
    };
    moderatorCacheRef.current.set(item.id, {locked, pinned, onModeratePost, onModeratorLock, onModeratorRetag, onModeratorPin, value});
    // Bound the cache — a long session scrolling through many load-mores would otherwise accumulate
    // one entry per item ever rendered for the life of the component. Evicting the oldest insertion
    // is a cheap approximation of LRU; feedLimit keeps any single render window tiny (~50 items).
    if (moderatorCacheRef.current.size > 1000) {
      const oldest = moderatorCacheRef.current.keys().next().value;
      if (oldest !== undefined) moderatorCacheRef.current.delete(oldest);
    }
    return value;
  }, [isModerator, lockedIds, pinnedIds, onModeratePost, onModeratorLock, onModeratorRetag, onModeratorPin]);

  const renderItem = useCallback(({item}: {item: FeedItem; index: number}) => (
    <PostCard
      item={item}
      labels={labels}
      status={sendStatus?.get(item.id)}
      statusReason={sendReasons?.get(item.id)}
      queuedOffline={sendQueuedOffline?.has(item.id)}
      onVote={onVote ? dir => onVote(item.id, item.authorPubkey, dir) : undefined}
      onPress={onItemPress ? () => onItemPress(item) : undefined}
      onRetry={onRetry ? () => onRetry(item.id) : undefined}
      onCancel={onCancel ? () => onCancel(item.id) : undefined}
      onAuthorPress={onAuthorPress ? () => onAuthorPress(item.authorPubkey) : undefined}
      onLookupEvent={onLookupEvent}
      onOpenNostrPost={onOpenNostrPost}
      moderator={moderatorFor(item)}
      isBookmarked={bookmarkedSet.has(item.id)}
      onToggleBookmark={onToggleBookmark ? () => onToggleBookmark(item.id) : undefined}
      onReportPost={onReportPost ? () => onReportPost(item.id, item.authorPubkey) : undefined}
      onMuteAuthor={onMuteAuthor ? () => onMuteAuthor(item.authorPubkey) : undefined}
      onUnlockContent={
        onUnlockContent && item.locked && item.lockedEpoch !== undefined
          ? () => onUnlockContent(item.lockedEpoch!)
          : undefined
      }
    />
  ), [bookmarkedSet, labels, sendStatus, sendReasons, sendQueuedOffline, onVote, onItemPress, onRetry, onCancel, onAuthorPress, onLookupEvent, onOpenNostrPost, moderatorFor, onToggleBookmark, onReportPost, onMuteAuthor, onUnlockContent]);

  return (
    <FlatList
      ref={ref}
      style={styles.list}
      contentContainerStyle={styles.content}
      data={items}
      keyExtractor={feedItemKey}
      onScroll={onScroll}
      // M5: park deferred relay-driven emits for the duration of a drag/fling (AppRuntime.setScrolling)
      // so a sync burst can't yank the list mid-touch.
      onScrollBeginDrag={onScrollBeginDrag}
      // Also evaluate on settle: a throttled onScroll drops the final resting frame when a fling
      // stops between windows, which would otherwise leave the jump-to-top button stuck visible at
      // the very top. Momentum/drag end always report the true final offset. Both also flush the
      // scroll park above — firing from either/both is harmless (setScrolling(false) is idempotent).
      onMomentumScrollEnd={e => { onScroll?.(e); onScrollSettle?.(); }}
      onScrollEndDrag={e => { onScroll?.(e); onScrollSettle?.(); }}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      onContentSizeChange={handleContentSizeChange}
      scrollEventThrottle={16}
      removeClippedSubviews
      maxToRenderPerBatch={4}
      updateCellsBatchingPeriod={60}
      windowSize={7}
      initialNumToRender={5}
      ListHeaderComponent={header ?? null}
      ListFooterComponent={footer ?? null}
      refreshControl={
        onRefresh
          ? <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
              progressBackgroundColor={colors.surface}
            />
          : undefined
      }
      ListEmptyComponent={
        connection !== undefined && !isOnline(connection)
          ? <FeedSkeleton />
          : <EmptyState
              icon="💬"
              title="Your community is quiet right now"
              subtitle="Be the first to share an idea — start with the box above."
            />
      }
      renderItem={renderItem}
      // Centring the just-read post on Back can target an index not yet measured (no
      // getItemLayout — variable heights). Degrade gracefully: jump to an estimated offset, then
      // settle exactly on the next frame once that region has rendered.
      onScrollToIndexFailed={info => {
        const list = typeof ref === 'function' ? null : ref?.current;
        list?.scrollToOffset({offset: info.averageItemLength * info.index, animated: false});
        setTimeout(() => {
          list?.scrollToIndex({index: info.index, viewPosition: 0.5, animated: false});
        }, 50);
      }}
    />
  );
});

const styles = StyleSheet.create({
  list: {flex: 1},
  // Cards carry their own side inset + top gap; the tail reserves room for the floating bottom nav
  // dock so the last card scrolls clear of it (was a plain 28px edge before the dock existed).
  content: {paddingBottom: BOTTOM_DOCK_CLEARANCE},
  // Static loading silhouettes (see FeedSkeleton) — dimmed neutral blocks, no animation.
  skeleton: {paddingTop: 8},
  skelCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginHorizontal: 14,
    marginTop: 12,
    padding: 16,
    opacity: 0.5,
  },
  skelHeaderRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 14},
  skelAvatar: {width: 34, height: 34, borderRadius: 17, backgroundColor: '#ffffff1f'},
  skelName: {width: 120, height: 12, borderRadius: 6, backgroundColor: '#ffffff1f', marginLeft: 12},
  skelLineWide: {height: 12, borderRadius: 6, backgroundColor: '#ffffff17', marginBottom: 10},
  skelLine: {height: 12, borderRadius: 6, backgroundColor: '#ffffff17', marginBottom: 10, width: '92%'},
  skelLineShort: {height: 12, borderRadius: 6, backgroundColor: '#ffffff17', width: '55%'},
});

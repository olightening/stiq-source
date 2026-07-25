/**
 * PostCard — one feed item, rendered in its native shape (design spec, List + Conversation).
 *
 * Two shapes, chosen by the content:
 *  • article-like — a titled (or long) post: identity row on top, title, a 3-line teaser,
 *    then a footer carrying the ✦ vote, the idea (reply) count, the label, and the time.
 *  • tweet-like  — a titleless note that reads short (≤140 chars of PROSE — an attached picture or
 *    voice clip doesn't count toward it): avatar + text-forward body, then a compact footer.
 *
 * The whole card opens the thread; the ✦ vote, the ⋯ menu and the author identity are their own
 * tappable targets (nested Pressables don't bubble, so they never also open the thread).
 */
import React, {useCallback, useRef, useState, useEffect} from 'react';
import {Modal, StyleSheet, Text, View} from 'react-native';
import Animated, {Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming} from 'react-native-reanimated';
import {Press} from '../../ui/Press';
import Clipboard from '@react-native-clipboard/clipboard';
import type {FeedItem} from '../feed';
import type {VoteDirection} from '../voting';
import type {SendStatus} from '../../nostr/outbox';
import {bodyForMeasure} from '../inlineMedia';
import {colors, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {Icon} from '../../ui/icons';
import {RichText} from './RichText';
import {SendProgress} from './SendProgress';
import {labelMetaFor, DEFAULT_LABELS, type LabelConfig, type PostLabel} from '../labels';
import {VoicePlayer} from './VoicePlayer';
import {relTimeShort} from '../../ui/relTime';
import {shortenNpub} from '../../util/npub';
import {paragraphAlign, rtlVerticalFix} from '../../ui/textDirection';
import {withNostrScheme} from '../../channels/savedEmbeds';
import {isEpochUnlockUnavailable, requestEpochUnlockRetry} from '../../blind/unlockState';

function shortNpub(npub: string): string {
  return shortenNpub(npub, {lead: 8, tail: 4, minLen: 16});
}

/** The prose length at/below which a titleless note renders in the compact tweet shape. */
const TWEET_MAX_CHARS = 140;

/**
 * Which of the two shapes a post renders in — the single source of truth, shared with the post-detail
 * header in MainScreen so a note can never open in a different shape than it had in the feed.
 *
 * Length is measured over `bodyForMeasure` (media tokens stripped), never the raw body: a picture is
 * not prose. Measuring raw also made the shape FLIP mid-send, because the two representations of the
 * same picture have wildly different lengths — the optimistic placeholder carries the pixel bytes
 * INLINE (multi-KB base64, so any picture note measured article-like), while the confirmed event
 * carries a ~72-char `STIQBLOB` reference to the blob event minted during signing (back under 140, so
 * it measured tweet-like). Stripped, both forms measure identically and the shape holds still.
 */
export function isTweetLike(item: FeedItem, cwRevealed = false): boolean {
  const hasSpecialBody =
    Boolean(item.locked) || Boolean(item.voice) || Boolean(item.contentWarning && !cwRevealed);
  return !item.title && !hasSpecialBody && bodyForMeasure(item.content).length <= TWEET_MAX_CHARS;
}

export interface PostCardProps {
  item: FeedItem;
  /** Organizer-defined labels — chip rendering + the moderator re-tag picker. */
  labels?: LabelConfig;
  /** Optimistic delivery status (drives the progress ring). */
  status?: SendStatus;
  /** Relay's rejection reason (when status is 'rejected') — shown next to "failed". */
  statusReason?: string;
  /** True when `status === 'sending'` is a pre-connect queue (relay/Tor not up yet) rather than an
   *  active in-flight publish — renders "Queued — connecting…" instead of "Sending…" (M7). */
  queuedOffline?: boolean;
  /** Cast / retract the viewer's vote on this post. */
  onVote?: (direction: VoteDirection) => void;
  onPress?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  onAuthorPress?: () => void;
  onLookupEvent?: (id: string) => import('../../ui/NostrLinkPreview').NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  moderator?: {
    hidden?: boolean;
    locked?: boolean;
    pinned?: boolean;
    onHide?: () => void;
    onRestore?: () => void;
    onHideUser?: () => void;
    onLockThread?: () => void;
    onRetag?: (label: PostLabel) => void;
    onPin?: () => void;
  };
  isBookmarked?: boolean;
  onToggleBookmark?: () => void;
  onReportPost?: () => void;
  /** Mute this post's author. Optional — falls back to a no-op that just closes the sheet. */
  onMuteAuthor?: () => void;
  /** Spend a read-token to unlock this post's sealed content epoch (C7 content-encryption meter).
   *  Present only for a `locked` item with a known epoch; SHIPS DARK — no item is ever locked until
   *  the relay advertises content encryption AND the organizer seals posts, so this never renders
   *  today. Tapping the members-only placeholder invokes it. */
  onUnlockContent?: () => void;
}

/**
 * VotePill — the ✦ spark + score, with a cast micro-interaction.
 *
 * Voting is the app's signature act, so casting one earns a moment: the spark pops (a quick
 * over-scale that springs back) while a second ✦ blooms outward and fades behind it. Retracting is
 * quiet — the colour just drops back to muted. Everything runs on the reanimated UI thread, so it
 * stays smooth under the feed's frequent re-renders. (Reduced-motion suppression is deferred to the
 * app-wide reduce-motion pass.)
 */
function VotePill({
  voted,
  scoreText,
  onVote,
}: {
  voted: boolean;
  scoreText: string;
  onVote?: (direction: VoteDirection) => void;
}): React.JSX.Element {
  const pop = useSharedValue(1);
  const spark = useSharedValue(0);
  const prevVoted = useRef(voted);

  useEffect(() => {
    // Fire the flourish only on a fresh up-cast (false → true), never on retract or a re-render that
    // merely re-supplies the same `voted`.
    if (voted && !prevVoted.current) {
      pop.value = withSequence(
        withTiming(1.35, {duration: 110, easing: Easing.out(Easing.quad)}),
        withSpring(1, {damping: 9, stiffness: 260, mass: 0.5}),
      );
      spark.value = withSequence(
        withTiming(1, {duration: 10}),
        withTiming(0, {duration: 300, easing: Easing.out(Easing.quad)}),
      );
    }
    prevVoted.current = voted;
  }, [voted, pop, spark]);

  const glyphStyle = useAnimatedStyle(() => ({transform: [{scale: pop.value}]}));
  // At rest spark=0 → opacity 0, so the bloom is invisible until a cast drives it 0→1→0.
  const sparkStyle = useAnimatedStyle(() => ({
    opacity: spark.value,
    transform: [{scale: 1 + (1 - spark.value) * 0.9}],
  }));

  return (
    <Press style={s.votePill} onPress={() => onVote?.('up')} accessibilityLabel="upvote">
      <View style={s.voteGlyphWrap}>
        {/* Decorative bloom — a plain Text inside the Press never intercepts the tap, so it needs no
            pointerEvents (which reanimated's Animated.Text doesn't type anyway). */}
        <Animated.Text
          style={[s.vglyph, s.vOn, s.vSpark, sparkStyle]}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          ✦
        </Animated.Text>
        <Animated.Text style={[s.vglyph, voted && s.vOn, glyphStyle]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          ✦
        </Animated.Text>
      </View>
      <Text style={[s.vsc, voted && s.vOn]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{scoreText}</Text>
    </Press>
  );
}

export const PostCard = React.memo(function PostCard({
  item,
  labels = DEFAULT_LABELS,
  status,
  statusReason,
  queuedOffline,
  onVote,
  onPress,
  onRetry,
  onCancel,
  onAuthorPress,
  onLookupEvent,
  onOpenNostrPost,
  moderator,
  isBookmarked,
  onToggleBookmark,
  onReportPost,
  onMuteAuthor,
  onUnlockContent,
}: PostCardProps): React.JSX.Element {
  const labelMeta = item.label ? labelMetaFor(item.label, labels) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [retagOpen, setRetagOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cwRevealed, setCwRevealed] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current); }, []);

  // Invisible auto-unlock kick for a sealed body: the feed build already noted this epoch, but a
  // card can also render off an older cached feed before any build ran (cold start) — one extra
  // kick is free, the runtime dedups per epoch. Silent by design: no tap, no visible affordance.
  useEffect(() => {
    if (item.locked && item.lockedEpoch !== undefined) onUnlockContent?.();
  }, [item.locked, item.lockedEpoch, onUnlockContent]);

  const copyLink = (): void => {
    const uri = withNostrScheme(item.identifier);
    Clipboard.setString(uri);
    setCopied(true);
    setMenuOpen(false);
    if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const isTweet = isTweetLike(item, cwRevealed);
  const voted = item.myVote === 'up';
  const scoreText = item.score > 0 ? `+${item.score}` : `${item.score}`;
  const ideasN = item.commentCount ?? 0;
  // The user-generated text that the teaser/tweet body renders (same selection RichText uses),
  // so its per-paragraph RTL/LTR direction can be applied to the text style at the call sites.
  const bodyText = item.summary && !item.title ? item.content : item.summary || item.content;

  // ── Shared body renderer (voice / poll / content-warning / rich text) ──
  const renderBody = useCallback((numberOfLines?: number, textStyle?: object): React.ReactNode => {
    // Members-only sealed body (invisible auto-unlock): the runtime already has a background
    // read-token unlock under way for this epoch (noteLockedEpochs fires on every feed build; the
    // mount effect below re-kicks it as belt-and-braces), so a member in good standing sees only a
    // brief neutral loading placeholder — never a lock, never a prompt — and the card re-renders
    // decrypted the moment the key lands. The quiet members-only card renders ONLY once that epoch
    // reaches a TERMINAL state — the organizer REFUSED the unlock (a read-revoked member) or the
    // transient retry ladder exhausted with no answer at all (dead mailbox, never got a live Tor
    // circuit) — or the seal is unresolvable (no `ke` epoch to unlock). A reconnect, app foreground,
    // or a tap on the card all give it one fresh attempt (see AppRuntime.reviveStuckEpochUnlocks /
    // retryEpochUnlock).
    if (item.locked) {
      const unavailable = item.lockedEpoch === undefined || isEpochUnlockUnavailable(item.lockedEpoch);
      if (!unavailable) {
        return (
          <View style={s.lockedPending} accessibilityLabel="loading">
            <View style={s.lockedPendingBar} />
            <View style={[s.lockedPendingBar, s.lockedPendingBarShort]} />
          </View>
        );
      }
      // Terminal (organizer refusal OR the transient retry ladder exhausted with no answer at all —
      // see AppRuntime.noteLockedEpochs) — the one deliberately user-visible state. Tap-to-retry:
      // resets that epoch's attempt counter/backoff and kicks one fresh attempt, so a member doesn't
      // have to wait for the next reconnect/foreground revival or reinstall the app.
      return (
        <Press
          variant="row"
          style={s.lockedBanner}
          onPress={() => {
            if (item.lockedEpoch !== undefined) requestEpochUnlockRetry(item.lockedEpoch);
          }}
          accessibilityLabel="Members-only content — tap to retry">
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
            <Icon name="🔒" size={14} />
            <Text style={s.lockedLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Members-only content</Text>
          </View>
          <Text style={s.cwTap} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Tap to retry</Text>
        </Press>
      );
    }
    if (item.contentWarning && !cwRevealed) {
      return (
        <Press variant="row" style={s.cwBanner} onPress={() => setCwRevealed(true)}>
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
            <Icon name="⚠️" size={14} />
            <Text style={s.cwLabel} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Content warning{item.contentWarning ? `: ${item.contentWarning}` : ''}</Text>
          </View>
          <Text style={s.cwTap} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Tap to reveal</Text>
        </Press>
      );
    }
    if (item.voice) return <VoicePlayer voice={item.voice} />;
    return (
      <RichText
        style={textStyle}
        numberOfLines={numberOfLines}
        flow
        content={item.summary && !item.title ? item.content : item.summary || item.content}
        imageMetas={item.images}
        onLookupEvent={onLookupEvent}
        onOpenNostrPost={onOpenNostrPost}
        eventDensity="Feed"
      />
    );
  }, [item, cwRevealed, onLookupEvent, onOpenNostrPost]);

  // ── Shared footer pieces ──
  const votePill = <VotePill voted={voted} scoreText={scoreText} onVote={onVote} />;
  const moreBtn = (
    <Press style={s.more} onPress={() => setMenuOpen(true)} accessibilityLabel="more">
      <Text style={s.moreDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{copied ? '✓' : '⋯'}</Text>
    </Press>
  );
  const labelChip = labelMeta ? (
    <View style={[s.label, {backgroundColor: labelMeta.bg}]}>
      <Text style={[s.labelText, {color: labelMeta.color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{labelMeta.text}</Text>
    </View>
  ) : null;

  const tagsTopics =
    item.tags.length > 0 ? (
      <View style={s.tags}>
        {item.tags.map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 ? <Text style={s.tagSep} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>·</Text> : null}
            <Text style={s.tag} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{t}</Text>
          </React.Fragment>
        ))}
      </View>
    ) : null;

  // ── Tweet-like layout ──
  if (isTweet) {
    return (
      <>
        <Press variant="row" style={[s.post, s.tweet]} pressedStyle={s.postPressed} onPress={onPress}>
          <Press onPress={onAuthorPress}>
            <GradientAvatar gradient={item.authorGradient} seed={item.author} size={22} style={s.twAv} />
          </Press>
          <View style={s.twBody}>
            {renderBody(undefined, [s.twText, paragraphAlign(bodyText)])}
            <View style={s.twFoot}>
              {votePill}
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                <Icon name="💬" size={14} />
                <Text style={s.replies} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{`${ideasN}`}</Text>
              </View>
              {tagsTopics}
              <View style={s.spacer} />
              <SendProgress status={status} reason={statusReason} queuedOffline={queuedOffline} onRetry={onRetry} onCancel={onCancel} />
              <Text style={s.when} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relTimeShort(item.createdAt)}</Text>
              {moreBtn}
            </View>
          </View>
        </Press>
        {renderSheet()}
      </>
    );
  }

  // ── Article-like layout ──
  return (
    <>
      <Press variant="row" style={s.post} pressedStyle={s.postPressed} onPress={onPress}>
        {/* Identity row + topic tags (top-right) */}
        <View style={s.ptop}>
          <Press onPress={onAuthorPress} style={s.who}>
            <GradientAvatar gradient={item.authorGradient} seed={item.author} size={22} />
            {item.authorName ? <Text style={s.whoName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{item.authorName}</Text> : null}
            <Text style={s.whoNpub} numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(item.author)}</Text>
          </Press>
          <View style={s.spacer} />
          {tagsTopics}
        </View>

        {item.title ? <Text style={[s.ptitle, paragraphAlign(item.title), rtlVerticalFix(item.title, 12)]}>{item.title}</Text> : null}

        <View style={item.title ? s.snipWrap : s.headWrap}>
          {renderBody(item.title ? 3 : 4, [item.title ? s.psnip : s.phead, paragraphAlign(bodyText)])}
        </View>

        {/* Footer: ✦ vote · ideas | label · time · ⋯ */}
        <View style={s.pfoot}>
          {votePill}
          <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
            <Icon name="💬" size={14} />
            <Text style={s.replies} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{`${ideasN} ${ideasN === 1 ? 'idea' : 'ideas'}`}</Text>
          </View>
          <View style={s.spacer} />
          <SendProgress status={status} reason={statusReason} queuedOffline={queuedOffline} onRetry={onRetry} onCancel={onCancel} />
          {labelChip}
          <Text style={s.when} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relTimeShort(item.createdAt)}</Text>
          {moreBtn}
        </View>
      </Press>
      {renderSheet()}
    </>
  );

  // ── Bottom action sheet (shared by both layouts) ──
  function renderSheet(): React.JSX.Element {
    return (
      <>
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Press variant="bare" style={s.sheetBack} onPress={() => setMenuOpen(false)} accessibilityRole="none">
          <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
            <View style={s.sheetCard}>
              <Press variant="row" style={s.sheetItem} onPress={copyLink}>
                <View style={s.sheetIcon}><Icon name="🔗" size={16} /></View>
                <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{copied ? 'Copied ✓' : 'Copy link'}</Text>
              </Press>
              {onToggleBookmark && (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); onToggleBookmark(); }}>
                  <View style={s.sheetIcon}><Icon name={isBookmarked ? '✅' : '🔖'} size={16} /></View>
                  <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{isBookmarked ? 'Saved · tap to remove' : 'Save'}</Text>
                </Press>
              )}
              <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); onMuteAuthor?.(); }}>
                <View style={s.sheetIcon}><Icon name="🔕" size={16} /></View>
                <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Mute this author</Text>
              </Press>
              {onReportPost && (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); onReportPost(); }}>
                  <View style={s.sheetIcon}><Icon name="🚩" size={16} /></View>
                  <Text style={[s.sheetText, s.sheetDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Report</Text>
                </Press>
              )}
              {moderator && (moderator.hidden ? (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); moderator.onRestore?.(); }}>
                  <View style={s.sheetIcon}><Icon name="♻️" size={16} /></View>
                  <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Restore post</Text>
                </Press>
              ) : (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); moderator.onHide?.(); }}>
                  <View style={s.sheetIcon}><Icon name="🙈" size={16} /></View>
                  <Text style={[s.sheetText, s.sheetDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Hide post</Text>
                </Press>
              ))}
              {moderator?.onHideUser && (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); moderator.onHideUser?.(); }}>
                  <View style={s.sheetIcon}><Icon name="🚫" size={16} /></View>
                  <Text style={[s.sheetText, s.sheetDanger]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Hide this user</Text>
                </Press>
              )}
              {moderator?.onLockThread && (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); moderator.onLockThread?.(); }}>
                  <View style={s.sheetIcon}><Icon name="🔒" size={16} /></View>
                  <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{moderator.locked ? 'Unlock thread' : 'Lock thread'}</Text>
                </Press>
              )}
              {moderator?.onRetag && (
                <Press variant="row" style={s.sheetItem} onPress={() => { setMenuOpen(false); setRetagOpen(true); }}>
                  <View style={s.sheetIcon}><Text style={s.sheetEmoji} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>🏷️</Text></View>
                  <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Re-tag…</Text>
                </Press>
              )}
              {moderator?.onPin && (
                <Press variant="row" style={[s.sheetItem, s.sheetItemLast]} onPress={() => { setMenuOpen(false); moderator.onPin?.(); }}>
                  <View style={s.sheetIcon}><Icon name="📌" size={16} /></View>
                  <Text style={s.sheetText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{moderator.pinned ? 'Unpin from top' : 'Pin to top'}</Text>
                </Press>
              )}
            </View>
            <Press style={s.sheetCancel} onPress={() => setMenuOpen(false)}>
              <Text style={s.sheetCancelText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
            </Press>
          </Press>
        </Press>
      </Modal>
      {/* Re-tag sheet — a moderator re-labels the post (kind-1984 stiq-action overlay). */}
      <Modal visible={retagOpen} transparent animationType="fade" onRequestClose={() => setRetagOpen(false)}>
        <Press variant="bare" style={s.sheetBack} onPress={() => setRetagOpen(false)} accessibilityRole="none">
          <Press variant="bare" style={s.retagSheet} onPress={() => {}} accessibilityRole="none">
            <Text style={s.retagTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Re-tag this post</Text>
            <View style={s.retagChips}>
              {labels.map(l => {
                const meta = labelMetaFor(l.id, labels);
                return (
                  <Press
                    key={l.id}
                    style={[s.retagChip, {backgroundColor: meta.bg}]}
                    onPress={() => { setRetagOpen(false); moderator?.onRetag?.(l.id); }}>
                    <Text style={[s.retagChipText, {color: meta.color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{meta.text}</Text>
                  </Press>
                );
              })}
            </View>
          </Press>
        </Press>
      </Modal>
      </>
    );
  }
}, (prev, next) =>
  prev.item === next.item &&
  prev.status === next.status &&
  prev.statusReason === next.statusReason &&
  prev.queuedOffline === next.queuedOffline &&
  (prev.moderator != null) === (next.moderator != null) &&
  prev.moderator?.hidden === next.moderator?.hidden &&
  prev.moderator?.locked === next.moderator?.locked &&
  prev.moderator?.pinned === next.moderator?.pinned &&
  prev.isBookmarked === next.isBookmarked);

const s = StyleSheet.create({
  // Feed "List" style (the design's default, per the canonical 03-feed-list screenshot): posts are
  // NOT cards — they sit flush, full-width, on the page bg, separated only by a hairline bottom
  // divider. No surface fill, no border box, no radius, no inter-post gap. Pressing tints the row.
  post: {
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 17,
    paddingBottom: 16,
  },
  postPressed: {backgroundColor: colors.surfaceAlt},

  // ── Identity row (article) ──
  ptop: {flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 9},
  who: {flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, minWidth: 0},
  whoName: {fontSize: 13, fontWeight: '600', color: colors.textSecondary, flexShrink: 0},
  whoNpub: {fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, flexShrink: 1},
  spacer: {flex: 1},

  ptitle: {fontSize: 17, fontWeight: '700', lineHeight: 21.8, letterSpacing: -0.3, color: colors.textPrimary},
  snipWrap: {marginTop: 6},
  headWrap: {marginTop: 0},
  psnip: {fontSize: 14.5, fontWeight: '400', lineHeight: 22.5, color: colors.textSecondary},
  phead: {fontSize: 16, fontWeight: '500', lineHeight: 23.2, letterSpacing: -0.1, color: colors.textPrimary},

  // ── Tweet ──
  tweet: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  twAv: {marginTop: 2},
  twBody: {flex: 1, minWidth: 0},
  twText: {fontSize: 18.5, fontWeight: '400', lineHeight: 26.8, letterSpacing: -0.2, color: colors.textPrimary},
  twFoot: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14},

  // ── Footer ──
  pfoot: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14},
  votePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 999,
  },
  // ✦ glyph and its number: equal lineHeight + no extra font padding so the count sits centered
  // on the spark instead of riding a hair high (Android includeFontPadding offsets mixed glyphs).
  vglyph: {fontSize: 13, lineHeight: 16, color: colors.textSecondary, fontWeight: '600', includeFontPadding: false},
  vsc: {fontSize: 13, lineHeight: 16, color: colors.textSecondary, fontWeight: '600', fontVariant: ['tabular-nums'], includeFontPadding: false},
  vOn: {color: colors.accent},
  // Positioning context for the cast-spark: sized to the main glyph so the absolute bloom overlays it.
  voteGlyphWrap: {alignItems: 'center', justifyContent: 'center'},
  // The blooming ✦ laid exactly over the main glyph (identical vglyph box → exact overlay).
  vSpark: {position: 'absolute', left: 0, top: 0},
  replies: {fontSize: 13.5, lineHeight: 16, fontWeight: '600', color: colors.textPrimary, includeFontPadding: false},
  when: {fontSize: 12, color: colors.textMuted, flexShrink: 0, fontWeight: '400'},
  more: {paddingHorizontal: 5, paddingVertical: 2},
  moreDots: {fontSize: 17, color: colors.textMuted, lineHeight: 17, fontWeight: '400'},

  // ── Topic tags (quiet, dot-separated) ──
  tags: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', flexShrink: 1},
  tag: {fontSize: 12.5, color: colors.textMuted, fontWeight: '500'},
  tagSep: {fontSize: 12.5, color: colors.textMuted, opacity: 0.6, marginHorizontal: 7, fontWeight: '400'},

  // ── Label chip (footer size) ──
  label: {borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, flexShrink: 0},
  labelText: {fontSize: 9.5, fontWeight: '700', letterSpacing: 0.57},

  // ── Content warning ──
  cwBanner: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  cwLabel: {fontSize: 13, fontWeight: '600', color: colors.textSecondary},
  cwTap: {fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontWeight: '400'},

  // ── Members-only sealed body (invisible auto-unlock) ──
  // The banner renders ONLY for a TERMINAL unlock (organizer refusal OR the transient retry ladder
  // exhausted with no answer — see AppRuntime.epochAccessState); a pending one shows the neutral
  // placeholder bars below instead — deliberately free of lock iconography. Tappable: retries.
  lockedBanner: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  lockedLabel: {fontSize: 13, fontWeight: '600', color: colors.textSecondary},
  lockedPending: {paddingVertical: 6, gap: 6},
  lockedPendingBar: {height: 10, borderRadius: 5, backgroundColor: colors.surfaceAlt, alignSelf: 'stretch'},
  lockedPendingBarShort: {width: '62%', alignSelf: 'flex-start'},

  // ── Action sheet ──
  sheetBack: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {paddingHorizontal: 10, paddingBottom: 12},
  sheetCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 8,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 15,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetItemLast: {borderBottomWidth: 0},
  sheetIcon: {width: 16, alignItems: 'center'},
  sheetText: {fontSize: 16, fontWeight: '500', color: colors.textPrimary},
  sheetDanger: {color: colors.danger},
  sheetCancel: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  sheetCancelText: {fontSize: 16, fontWeight: '600', color: colors.accent},
  // 🏷️ has no Twemoji-SVG in the icon set, so the Re-tag row renders it as a native glyph.
  sheetEmoji: {fontSize: 14},
  // Re-tag sheet (moderator) — a bottom card of label chips.
  retagSheet: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 18, marginHorizontal: 10, marginBottom: 12},
  retagTitle: {fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 12, textAlign: 'center'},
  retagChips: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center'},
  retagChip: {borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8},
  retagChipText: {fontSize: 11, fontWeight: '700', letterSpacing: 0.6},
});

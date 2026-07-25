/**
 * LogPostView — Overlay B, "Full post view" from the Stiq Log design spec.
 *
 * Opened from the Log tab's detail sheet when the viewer taps "View post & comments ›".
 * It re-renders a moderated post *in context* — body, author identity, engagement, and
 * comment thread — alongside a state banner that tells the reader exactly what was done
 * to this content and why.
 *
 * The overlay is a full-screen View (absolute fill, colors.bg) layered above everything
 * else by the parent navigator.  The parent wires navigation; this component is pure
 * presentational: pass props in, get a rendered screen back.
 *
 * Render order (top → bottom):
 *   1. Header bar       — ‹ back · centred kindLabel · 34px spacer
 *   2. State banner     — 🚫 removed (danger) OR 🛡️ intact (neutral)
 *   3. Post head        — label chip · optional title · author row
 *   4. Body             — post text
 *   5. Engagement row   — vote pill + 💬 comment count
 *   6. Comment thread   — COMMENTS header + ThreadView (via listHeader trick so the whole
 *                         page scrolls as one FlatList)
 *   7. Composer footer  — 🔒 closed bar OR live CommentComposer
 *
 * Design token source: design_files/Log.dc.html lines 211-305 + README "Overlay B".
 * House-style reference: LogScreen.tsx (Dot pattern, color usage, StyleSheet layout).
 */

import React, {useMemo} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, Text, View} from 'react-native';
import type {Event} from 'nostr-tools/pure';

import type {CommentNode} from '../../feed/thread';
import type {GradientSpec} from '../../media/gradient';
import type {PictureRules} from '../../feed/pictureRules';
import {labelMetaFor, DEFAULT_LABELS, type PostLabel, type LabelConfig} from '../../feed/labels';

import {GradientDot} from '../../ui/GradientDot';
import {Press} from '../../ui/Press';
import {colors} from '../../ui/theme';
import {ThreadView} from '../../feed/components/ThreadView';
import {RichText} from '../../feed/components/RichText';
import {CommentComposer} from '../../feed/components/CommentComposer';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface LogPostViewProps {
  /** Title shown in the header bar: 'Post' | 'Comment' | 'Locked thread'. */
  kindLabel: string;
  /** Dismiss the overlay (back to detail sheet). */
  onClose: () => void;
  /** State banner — drives the red-vs-neutral treatment at the top of the body. */
  banner: {
    tone: 'removed' | 'intact';
    /** Short line: e.g. "Removed by Alice · Privacy & opsec". */
    text: string;
    /** Moderator's written reason (one sentence or a few lines). */
    reason: string;
  };
  /** Optional NIP-32 post-type label — renders the muted chip if present. */
  label?: PostLabel;
  /** Organizer-defined labels, to resolve the label id to its chip meta. */
  labels?: LabelConfig;
  /** Optional long-form post title (25px/700). */
  title?: string;
  /** Resolved display name for the original author. */
  authorName: string;
  /** Author's bech32 npub shown in monospace beneath the display name. */
  authorNpub: string;
  /** Author's gradient identity (null → derive from authorSeed). */
  authorGradient?: GradientSpec | null;
  /** Pubkey / handle used to derive the gradient when authorGradient is absent. */
  authorSeed: string;
  /** Human-readable age of the post: "25m", "1h", "2d", etc. */
  at: string;
  /** Full text body of the post. */
  body: string;
  /** Net vote score (upvotes − downvotes via getEventScore). */
  score: number;
  /** Total comment count for the engagement row. */
  commentCount: number;
  /** Flat CommentNode list that ThreadView knows how to render. */
  threadNodes: CommentNode[];

  // ── ThreadView pass-through ──────────────────────────────────────────────
  getAuthorName?: (event: Event) => string | null;
  getAuthorGradient?: (event: Event) => GradientSpec | undefined;
  onAuthorPress?: (pubkey: string) => void;

  // ── Composer footer ──────────────────────────────────────────────────────
  /**
   * `mode: 'closed'` → a muted locked bar with custom text (for removed content).
   * `mode: 'open'`   → live CommentComposer (for intact content).
   */
  composer:
    | {mode: 'closed'; text: string}
    | {
        mode: 'open';
        onSubmit: (text: string) => void;
        /** Organizer picture limits — gives the composer's `+` an "Add picture" action. */
        pictureRules?: PictureRules;
        /** Picture token bytes already spent this period (allowance gate). */
        picturesSpentBytes?: number;
        /** Organizer-allowed voice — gives the composer's `+` a "Record voice" action. */
        allowVoice?: boolean;
      };

  // ── Save / embed ─────────────────────────────────────────────────────────
  /** Whether this post is currently bookmarked — drives the header save toggle. */
  saved?: boolean;
  /** Toggle the bookmark. A saved log post can be inserted as an embed like any other post. */
  onToggleSave?: () => void;
}

// ── Post label chip ───────────────────────────────────────────────────────────

function LabelChip({label, labels}: {label: PostLabel; labels: LabelConfig}): React.JSX.Element {
  const meta = labelMetaFor(label, labels);
  return (
    <View style={[s.labelChip, {backgroundColor: meta.bg}]}>
      <Text style={[s.labelChipText, {color: meta.color}]}>{meta.text}</Text>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function LogPostView({
  kindLabel,
  onClose,
  banner,
  label,
  labels = DEFAULT_LABELS,
  title,
  authorName,
  authorNpub,
  authorGradient,
  authorSeed,
  at,
  body,
  score,
  commentCount,
  threadNodes,
  getAuthorName,
  getAuthorGradient,
  onAuthorPress,
  composer,
  saved,
  onToggleSave,
}: LogPostViewProps): React.JSX.Element {
  // ── Build the static "above the fold" content that goes into ThreadView's
  //    listHeader so the entire page scrolls as a single FlatList, not two
  //    nested scroll containers.
  const listHeader = useMemo(
    () => (
      <View>
        {/* ── State banner ────────────────────────────────────────────────── */}
        <View style={s.bannerPad}>
          {banner.tone === 'removed' ? (
            <View style={s.bannerRemoved}>
              <Text style={s.bannerRemovedTitle}>🚫 {banner.text}</Text>
              <Text style={s.bannerReason}>{banner.reason}</Text>
            </View>
          ) : (
            <View style={s.bannerIntact}>
              <Text style={s.bannerIntactTitle}>🛡️ {banner.text}</Text>
              <Text style={s.bannerReason}>{banner.reason}</Text>
            </View>
          )}
        </View>

        {/* ── Post head ───────────────────────────────────────────────────── */}
        <View style={s.postHead}>
          {/* Label chip — only when a label is present */}
          {!!label && (
            <View style={s.labelChipWrap}>
              <LabelChip label={label} labels={labels} />
            </View>
          )}

          {/* Optional long-form title */}
          {!!title && <Text style={s.postTitle}>{title}</Text>}

          {/* Author row: 32px gradient circle · name / npub · timestamp */}
          <View style={s.authorRow}>
            <GradientDot size={32} gradient={authorGradient} seed={authorSeed} />
            <View style={s.authorMeta}>
              <Text style={s.authorName} numberOfLines={1}>
                {authorName}
              </Text>
              <Text style={s.authorNpub} numberOfLines={1}>
                {authorNpub}
              </Text>
            </View>
            {/* Spacer pushes timestamp to the right */}
            <View style={s.flex1} />
            <Text style={s.authorAt}>{at}</Text>
          </View>
        </View>

        {/* ── Body ──────────────────────────────────────────────────────────
            RichText, not a bare <Text>: this is a real post being re-read in context, and post
            bodies carry the app's markdown dialect (headings, tables, collapsible "details",
            task lists, pullquotes). Rendering it raw leaked the syntax itself onto the page —
            `| a | b |`, `:::`, `-#` — which is precisely what a moderation record must NOT do,
            since the whole point of this screen is showing what the content actually was.
            `paragraphSpacing` matches the feed's post detail (MainScreen's article body). */}
        <View style={s.bodyPad}>
          <RichText content={body} style={s.bodyText} paragraphSpacing={15} />
        </View>

        {/* ── Engagement row ───────────────────────────────────────────────── */}
        <View style={s.engagementRow}>
          {/* Vote pill: ▲ score ▼ */}
          <View style={s.votePill}>
            <Text style={s.voteUp}>▲</Text>
            <Text style={s.voteScore}>{score}</Text>
            <Text style={s.voteDown}>▼</Text>
          </View>
          {/* Comment count */}
          <Text style={s.commentCount}>💬 {commentCount}</Text>
        </View>

        {/* ── Comments section header ──────────────────────────────────────── */}
        <View style={s.commentsPad}>
          <View style={s.commentsHeader}>
            <Text style={s.commentsLabel}>COMMENTS</Text>
            <Text style={s.commentsCount}>{commentCount}</Text>
            {/* Hairline rule stretches to fill remaining width */}
            <View style={s.hairline} />
          </View>
        </View>
      </View>
    ),
    [banner, label, labels, title, authorName, authorNpub, authorGradient, authorSeed, at, body, score, commentCount],
  );

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
      {/* ── Header bar ────────────────────────────────────────────────────── */}
      <View style={s.header}>
        {/* ‹ back button — accent, 24px */}
        <Press onPress={onClose} style={s.backBtn} accessibilityLabel="Back">
          <Text style={s.backChevron}>‹</Text>
        </Press>
        {/* Centred kindLabel */}
        <Text style={s.headerTitle} numberOfLines={1}>
          {kindLabel}
        </Text>
        {/* Save toggle — a saved log post can be inserted as an embed like any other post. Falls
            back to a 34px spacer (to keep the title centred) when saving isn't available. */}
        {onToggleSave ? (
          <Press
            onPress={onToggleSave}
            style={s.saveBtn}
            accessibilityLabel={saved ? 'Remove from saved' : 'Save post to embed later'}
            accessibilityState={{selected: !!saved}}>
            <Text style={[s.saveIcon, saved && s.saveIconOn]}>{saved ? '🔖' : '📑'}</Text>
          </Press>
        ) : (
          <View style={s.headerSpacer} />
        )}
      </View>

      {/* ── Scrollable body: ThreadView owns the scroll; static content lives
           in its listHeader so we never nest FlatList inside ScrollView. ── */}
      <View style={s.flex1}>
        <ThreadView
          nodes={threadNodes}
          getAuthorName={getAuthorName}
          getAuthorGradient={getAuthorGradient}
          onAuthorPress={onAuthorPress}
          listHeader={listHeader}
        />
      </View>

      {/* ── Composer footer ───────────────────────────────────────────────── */}
      {composer.mode === 'closed' ? (
        /* Muted locked bar — removed/banned content. */
        <View style={s.composerClosed}>
          <Text style={s.composerClosedText}>🔒 {composer.text}</Text>
        </View>
      ) : (
        /* Live CommentComposer — intact content. */
        <CommentComposer
          onSubmit={composer.onSubmit}
          placeholder="Add a comment…"
          submitLabel="Comment"
          allowVoice={composer.allowVoice}
          pictureRules={composer.pictureRules}
          picturesSpentBytes={composer.picturesSpentBytes}
        />
      )}
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Pixel-matched to Log.dc.html lines 211-305 + README "Overlay B" token table.
// All colors come from `colors` (dark-canonical, same as LogScreen).

const s = StyleSheet.create({
  // Full-screen overlay
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bg,
    flexDirection: 'column',
  },
  flex1: {flex: 1},

  // ── Header bar ─────────────────────────────────────────────────────────────
  // padding 10/8/11, 1px bottom border — exact from the DC
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 10,
    paddingHorizontal: 8,
    paddingBottom: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    // flex: 0 (not 'none') keeps the header bar from stretching vertically
    flexShrink: 0,
  },
  backBtn: {
    // the ‹ chevron button: accent, font-size 24, padded for tap target
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  backChevron: {
    color: colors.accent,
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '400',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  // 34px right spacer mirrors the width of the chevron zone so the title is
  // truly centred (same trick used in the DC: a <span style="width:34px">).
  headerSpacer: {
    width: 34,
  },
  // Save toggle — same 34px right zone as the spacer so the title stays centred.
  saveBtn: {
    width: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  saveIcon: {
    fontSize: 17,
    opacity: 0.55,
  },
  saveIconOn: {
    opacity: 1,
  },

  // ── State banner ───────────────────────────────────────────────────────────
  // padding 14/14/0 on the outer pad; card: radius 12, pad 11/13
  bannerPad: {
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  bannerRemoved: {
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  bannerRemovedTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.danger,
  },
  bannerIntact: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  bannerIntactTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  // Shared reason line (beneath either banner title)
  bannerReason: {
    fontSize: 12.5,
    color: colors.textSecondary,
    lineHeight: 19,
    marginTop: 6,
  },

  // ── Post head ──────────────────────────────────────────────────────────────
  // padding 18/20/20, 1px bottom border
  postHead: {
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // Label chip is present only when a label prop is passed; the wrapper provides
  // the marginBottom:13 shown in the spec (the DC has the badge in a div with mb:13).
  labelChipWrap: {
    flexDirection: 'row',
    marginBottom: 13,
  },
  labelChip: {
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  labelChipText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  // Optional long-form title: 25px / 700 / lineHeight 1.2 / tracking -0.01em
  postTitle: {
    fontSize: 25,
    fontWeight: '700',
    lineHeight: 30, // 25 × 1.2
    letterSpacing: -0.25, // −0.01em at 25px
    color: colors.textPrimary,
    // No bottom margin: the author row's marginTop:14 provides the gap below the title
    // (matches the DC, where the title div has no margin and the author row carries mt:14).
  },
  // Author row: gradient dot · name/npub column · spacer · timestamp
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  authorMeta: {
    flex: 1,
    minWidth: 0,
  },
  authorName: {
    fontSize: 13.5,
    fontWeight: '600',
    color: colors.textSecondary,
    lineHeight: 17,
  },
  authorNpub: {
    fontSize: 11,
    color: colors.link,
    fontFamily: 'Courier New', // monospace fallback; no bundled webfont per design system rules
    lineHeight: 15,
  },
  authorAt: {
    fontSize: 12,
    color: colors.textMuted,
  },

  // ── Body ───────────────────────────────────────────────────────────────────
  // padding 18/20/6; text: 17px, lineHeight ~26 (1.55×17), primary
  bodyPad: {
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  bodyText: {
    fontSize: 17,
    lineHeight: 26,
    color: colors.textPrimary,
  },

  // ── Engagement row ─────────────────────────────────────────────────────────
  // padding 6/20/18, 1px bottom border
  engagementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingTop: 6,
    paddingHorizontal: 20,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // Vote pill: surfaceAlt bg, 1px border, pill radius, pad 5/13
  votePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 13,
  },
  voteUp: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  voteScore: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  voteDown: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  commentCount: {
    fontSize: 13,
    color: colors.textMuted,
  },

  // ── Comments section header ─────────────────────────────────────────────────
  // Outer pad matches the DC's <div style="padding:6px 20px 18px">
  commentsPad: {
    paddingTop: 6,
    paddingHorizontal: 20,
    paddingBottom: 18,
  },
  // Header row: "COMMENTS" eyebrow · count · hairline rule
  commentsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    marginBottom: 6,
  },
  commentsLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.99, // 0.09em at 11px
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  commentsCount: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
  },
  // The hairline rule stretches to fill remaining width
  hairline: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },

  // ── Composer footer — closed (removed/banned) ──────────────────────────────
  // 1px top border, flex:none; pad 13/16; text 13px muted
  composerClosed: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  composerClosedText: {
    fontSize: 13,
    color: colors.textMuted,
  },
});

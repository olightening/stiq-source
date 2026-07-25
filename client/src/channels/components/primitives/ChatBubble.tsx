/**
 * ChatBubble — the DM / group-chat message bubble (handoff "Messages — group chats" + "DM").
 * Outgoing (mine): right-aligned, accent fill, asymmetric radius 16/16/4/16, with a ⋯ More button to
 * its LEFT. Incoming (theirs): left-aligned, a 24px circle sender avatar + sender name above a
 * surface bubble (radius 16/16/16/4), with a ⋯ to its RIGHT. 15.5px / line-height 1.4.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import type {GradientSpec} from '../../../media/gradient';
import {RichText} from '../../../feed/components/RichText';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import {decodeNameHeader} from '../../../profile/displayName';
import {paragraphAlign} from '../../../ui/textDirection';
import {colors, ctAvatar, ctWeight, DENSE_MAX_FONT_SCALE} from '../../tokens';
import type {EmojiTally} from '../../reactions';
import type {NostrEventSummary} from '../../../ui/NostrLinkPreview';

const BODY = 15.5;
const LINE = 21.7; // 15.5 × 1.4

export function ChatBubble({
  mine,
  content,
  senderName,
  senderSeed,
  senderGradient,
  /** Group chat: this bubble continues a run by the same sender — drop the avatar (a spacer keeps
   *  the bubble aligned) and tuck it up under the run's first bubble. Incoming bubbles only. */
  continuation,
  /** Quoted-reply card rendered INSIDE the bubble, above the text (Telegram-style). */
  quote,
  /** Tapping the sender name/avatar (open their profile). Incoming only. */
  onPressSender,
  /** ⋯ More button beside the bubble. Omit to hide. */
  onMenu,
  /** Reaction tallies shown under the bubble (any-emoji, groups/DMs). */
  reactions,
  /** Tap an existing reaction chip to add/remove that emoji. */
  onReactEmoji,
  /** Long-press a reaction chip to see who reacted. */
  onShowReactors,
  /** Resolve a quoted post (NIP-18/27 nostr:nevent…/note…) for an inline REFERENCED embed card. */
  onLookupEvent,
  /** Open a quoted post when its embed card is tapped. */
  onOpenNostrPost,
  /** Tap a `stiq://channel/<id>` invite card → run the in-app accept-invite flow with the RAW url. */
  onOpenInviteLink,
}: {
  mine: boolean;
  content: string;
  senderName?: string;
  senderSeed?: string;
  senderGradient?: GradientSpec;
  continuation?: boolean;
  quote?: React.ReactNode;
  onPressSender?: () => void;
  onMenu?: () => void;
  reactions?: EmojiTally[];
  onReactEmoji?: (emoji: string) => void;
  onShowReactors?: () => void;
  onLookupEvent?: (id: string) => NostrEventSummary | null;
  onOpenNostrPost?: (id: string) => void;
  onOpenInviteLink?: (url: string) => void;
}): React.JSX.Element {
  const more = onMenu ? (
    <Press style={s.more} onPress={onMenu} accessibilityLabel="message actions">
      <Text style={s.moreDots} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>⋯</Text>
    </Press>
  ) : null;

  const chips = reactions && reactions.length > 0 ? (
    <View style={[s.reactRow, mine && s.reactRowMine]}>
      {reactions.map(r => (
        <Press
          key={r.emoji}
          style={[s.reactChip, r.mine && s.reactChipMine]}
          disabled={!onReactEmoji && !onShowReactors}
          onPress={onReactEmoji ? () => onReactEmoji(r.emoji) : undefined}
          onLongPress={onShowReactors}
          accessibilityLabel={`reaction-${r.emoji}-${r.count}`}>
          <Text style={s.reactEmoji} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{r.emoji}</Text>
          {r.count > 1 ? <Text style={s.reactCount} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{r.count}</Text> : null}
        </Press>
      ))}
    </View>
  ) : null;

  // Align the TEXT inside the bubble to its own first-strong direction (decoded past the identity
  // header) — the bubble background and mine-vs-theirs row layout are unchanged. RichText also
  // applies per-paragraph direction for multi-paragraph messages.
  const bodyAlign = paragraphAlign(decodeNameHeader(content).text);

  if (mine) {
    return (
      <View style={[s.mineRow, continuation && s.continuationRow]}>
        {more}
        <View style={s.mineCol}>
          <View style={[s.bubble, s.mine]}>
            {quote ? <View style={s.quote}>{quote}</View> : null}
            <RichText
              content={content}
              style={[s.textMine, bodyAlign]}
              // YOUR bubble is filled with the accent, so the block chrome has to follow: `style`
              // only recolours the prose, while a heading / quote bar / pullquote rule / checkbox /
              // table border each carry their own colour and would otherwise paint the feed's dark
              // ink onto the accent fill. Their bubble (below) sits on the normal surface and keeps
              // the default tone.
              tone="onAccent"
              onLookupEvent={onLookupEvent}
              onOpenNostrPost={onOpenNostrPost}
              onOpenInviteLink={onOpenInviteLink}
            />
          </View>
          {chips}
        </View>
      </View>
    );
  }
  return (
    <View style={[s.theirsRow, continuation && s.continuationRow]}>
      {continuation ? (
        <View style={s.avatarSpacer} />
      ) : (
        <GradientAvatar gradient={senderGradient} seed={senderSeed ?? ''} size={ctAvatar.bubbleSender} />
      )}
      <View style={s.theirsBody}>
        {senderName ? (
          <Press disabled={!onPressSender} onPress={onPressSender}>
            <Text style={s.senderName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{senderName}</Text>
          </Press>
        ) : null}
        <View style={[s.bubble, s.theirs]}>
          {quote ? <View style={s.quote}>{quote}</View> : null}
          <RichText
            content={content}
            style={[s.text, bodyAlign]}
            onLookupEvent={onLookupEvent}
            onOpenNostrPost={onOpenNostrPost}
            onOpenInviteLink={onOpenInviteLink}
          />
        </View>
        {chips}
      </View>
      {more}
    </View>
  );
}

const s = StyleSheet.create({
  mineRow: {alignSelf: 'flex-end', maxWidth: '82%', flexDirection: 'row', alignItems: 'flex-end', gap: 5, marginVertical: 4},
  theirsRow: {alignSelf: 'flex-start', maxWidth: '86%', flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginVertical: 4},
  // Grouped (same-sender continuation) bubble: tuck it up under the run's first bubble.
  continuationRow: {marginTop: 1},
  // Keeps a continuation bubble left-aligned with the run's first bubble now that its avatar is gone.
  avatarSpacer: {width: ctAvatar.bubbleSender},
  theirsBody: {minWidth: 0, flexShrink: 1},
  senderName: {fontSize: 11.5, fontWeight: ctWeight.semibold, color: colors.textSecondary, marginLeft: 2, marginBottom: 3},
  bubble: {paddingHorizontal: 13, paddingVertical: 9},
  quote: {marginBottom: 5},
  mine: {backgroundColor: colors.accent, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomRightRadius: 4, borderBottomLeftRadius: 16},
  theirs: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomRightRadius: 16, borderBottomLeftRadius: 4},
  text: {color: colors.textPrimary, fontSize: BODY, lineHeight: LINE},
  textMine: {color: colors.onAccent, fontSize: BODY, lineHeight: LINE},
  more: {paddingHorizontal: 2, paddingBottom: 4},
  moreDots: {color: colors.textMuted, fontSize: 16, lineHeight: 16},
  mineCol: {alignItems: 'flex-end', minWidth: 0, flexShrink: 1},
  reactRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4},
  reactRowMine: {justifyContent: 'flex-end'},
  reactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactChipMine: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  reactEmoji: {fontSize: 13},
  reactCount: {fontSize: 11, color: colors.textSecondary, fontWeight: ctWeight.semibold},
});

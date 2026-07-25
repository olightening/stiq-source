/**
 * MessageCard — the channel message card (the mockup's authored card). One implementation, used by
 * public channels (no header), private channels, and broadcast channels (with header). The card
 * chrome — surface fill, 14px radius, hairline border, 14/15/12 padding, side+stack margins — lives
 * HERE and nowhere else (RC-1: fixing the card fixes every channel type at once).
 *
 * The body / reactions / footer / comment-section are passed as children, so each screen composes
 * the same shell with its own content and behaviour.
 */
import React from 'react';
import {StyleSheet} from 'react-native';
import {Press} from '../../../ui/Press';
import type {GradientSpec} from '../../../media/gradient';
import {colors, ctRadius, ctSpace, ctAvatar} from '../../tokens';
import {AuthorHeader} from './AuthorHeader';

export function MessageCard({
  /** Show the per-message author header (private/broadcast channels; false for public). */
  authored,
  authorNpub,
  authorName,
  authorGradient,
  /** Optional trailing element in the author header (e.g. ADMIN badge). */
  authorTrailing,
  /** Tapping the card (e.g. open the single-post view). Omit to disable. */
  onPress,
  /** Override the card's border colour — the "line that holds the card together" (No.2). A promoted
   *  post passes the accent colour so a glance tells it apart, with no extra banner button. */
  frameColor,
  children,
}: {
  authored: boolean;
  authorNpub?: string;
  authorName?: string;
  authorGradient?: GradientSpec;
  authorTrailing?: React.ReactNode;
  onPress?: () => void;
  frameColor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Press
      variant="row"
      style={[s.card, frameColor ? {borderColor: frameColor, borderWidth: 1.5} : null]}
      onPress={onPress}
      disabled={!onPress}>
      {authored && authorNpub ? (
        <AuthorHeader
          npub={authorNpub}
          name={authorName}
          gradient={authorGradient}
          size={ctAvatar.cardAuthor}
          trailing={authorTrailing}
        />
      ) : null}
      {children}
    </Press>
  );
}

/** Bare card container (no author header) for callers that lay out their own contents — e.g. the
 *  single-post screen, which scrolls rather than rendering a tappable feed row. */
export const cardChrome = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: ctRadius.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingTop: ctSpace.cardPadTop,
    paddingHorizontal: ctSpace.cardPadX,
    paddingBottom: ctSpace.cardPadBottom,
  },
});

const s = StyleSheet.create({
  card: {
    marginHorizontal: ctSpace.side,
    marginTop: ctSpace.stackGap,
    ...cardChrome.card,
  },
});

/**
 * ReferencedCard — a post/comment/question referenced inside a message (the "save to embed" target).
 * The mockup's REFERENCED card: accent label, bold title line, muted snippet, author chip, and a 3px
 * accent left bar. Decodes any nostr: ref and resolves the event via `onLookup`.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import * as nip19 from 'nostr-tools/nip19';
import type {NostrEventSummary} from '../../../ui/NostrLinkPreview';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import {safeNpubEncode, shortenNpub} from '../../../util/npub';
import {paragraphAlign} from '../../../ui/textDirection';
import {RefEmbed, embedFromSummary, embedFromSpaceRef, embedFromInviteLink, embedFromMsgRef, embedFromDraftRef} from '../../../feed/components/RefEmbed';
import {colors, ctType, ctTracking, ctWeight, ctRadius, ctAvatar, ctSpace, DENSE_MAX_FONT_SCALE} from '../../tokens';
import {npubFor, shortNpub} from './format';
import {SPACE_EMBED_PREFIX, parseSpaceEmbed} from '../../spaceEmbed';
import {MSG_EMBED_PREFIX, parseMsgEmbed} from '../../msgEmbed';
import {DRAFT_EMBED_PREFIX, parseDraftEmbed} from '../../../feed/draftEmbed';
import {parseInviteLink} from '../../invite';
import {spaceCtaFor} from '../../spaceCta';
import {EVENT_EMBED_PREFIX, parseEventEmbed} from '../../../events/eventEmbed';
import {eventCardPropsFrom} from '../../../events/cardProps';
import {eventLiveFor} from '../../../events/eventCardState';
import {EventCard} from '../../../events/components/EventCard';

/** Prefix of a `stiq://channel/<id>` navigate-only invite link. */
const INVITE_LINK_PREFIX = 'stiq://channel/';

/** Decode any nostr: reference into the bits we can render (id for lookup, author, kind). */
function decodeRef(uri: string): {id?: string; pubkey?: string; kind?: number} {
  try {
    const d = nip19.decode(uri.replace(/^nostr:/, ''));
    if (d.type === 'nevent') return {id: d.data.id, pubkey: d.data.author, kind: d.data.kind};
    if (d.type === 'note') return {id: d.data};
    if (d.type === 'naddr') return {pubkey: d.data.pubkey, kind: d.data.kind};
    if (d.type === 'nprofile') return {pubkey: d.data.pubkey};
    if (d.type === 'npub') return {pubkey: d.data};
  } catch {
    /* unparseable ref */
  }
  return {};
}

export function ReferencedCard({
  uri,
  onLookup,
  onOpenRef,
  onOpenInvite,
}: {
  uri: string;
  onLookup?: (id: string) => NostrEventSummary | null;
  /** Tap the card → open the referenced event. Omit to render a non-interactive card. */
  onOpenRef?: (id: string) => void;
  /** Tap a `stiq://channel/<id>` invite card → run the in-app accept-invite flow with the RAW url. */
  onOpenInvite?: (url: string) => void;
}): React.JSX.Element | null {
  // A `stiq://channel/<id>` invite link renders as a tappable card whose tap runs the IN-APP
  // accept-invite flow (never the external-link path). The bare link carries no name — resolve a
  // richer card from onLookup when the space's metadata happens to be cached, else the id-shape
  // label. Per the tap contract, the FULL raw url (not a decoded id) is handed to onOpenInvite so
  // the runtime's parseInviteLink can split any legacy fragment itself.
  if (uri.startsWith(INVITE_LINK_PREFIX)) {
    const parsed = parseInviteLink(uri);
    if (!parsed) return null;
    const summary = onLookup ? onLookup(parsed.spaceId) : null;
    const view = embedFromInviteLink(parsed, summary);
    const tappable = !!onOpenInvite;
    return (
      <Press
        variant="row"
        style={s.card}
        disabled={!tappable}
        onPress={tappable ? () => onOpenInvite!(uri) : undefined}
        accessibilityLabel={tappable ? 'accept channel invite' : undefined}>
        <Text style={s.label} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{view.kind}</Text>
        <Text style={[s.title, paragraphAlign(view.title)]} numberOfLines={2}>{view.title}</Text>
        {view.owner ? (
          <Text style={s.owner} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {`by ${shortenNpub(safeNpubEncode(view.owner), {lead: 10, tail: 4})}`}
          </Text>
        ) : null}
        {view.name ? (
          <View style={s.authorRow}>
            <GradientAvatar gradient={view.gradient} seed={view.seed} size={ctAvatar.refAuthor} shape={view.shape} />
            <Text style={s.author} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{view.name}</Text>
          </View>
        ) : null}
      </Press>
    );
  }
  // A `stiq:event:…` token renders as the REAL EventCard, Compact density (channel messages +
  // channel-post comments are inline surfaces). Self-contained offline payload, live-upgraded via
  // the events/eventCardState resolver. Tap hands the RAW token to onOpenRef (same contract as
  // spaces). Malformed → nothing.
  if (uri.startsWith(EVENT_EMBED_PREFIX)) {
    const eventRef = parseEventEmbed(uri);
    if (!eventRef) return null;
    const live = eventLiveFor(eventRef.coordinate);
    const props = eventCardPropsFrom(eventRef, live, 'Compact', onOpenRef ? () => onOpenRef(uri) : undefined);
    return <EventCard {...props} />;
  }
  // A `stiq:space:…` token is SELF-CONTAINED (name + gradient carried in the token) — render it
  // fully offline, no onLookup round-trip. Per the tap contract, the FULL raw token (not a decoded
  // id) is handed to onOpenRef. A malformed token (parseSpaceEmbed returns null) renders nothing.
  if (uri.startsWith(SPACE_EMBED_PREFIX)) {
    const spaceRef = parseSpaceEmbed(uri);
    if (!spaceRef) return null;
    const view = embedFromSpaceRef(spaceRef);
    const tappable = !!onOpenRef;
    // Membership CTA (private spaces only): "View & request access ›" flips to "⏳ Requested ·
    // pending ›" once the viewer has an outstanding request; a member sees no line. Tapping always
    // opens the locked preview via onOpenRef.
    const cta = spaceCtaFor(spaceRef.identifier, spaceRef.private || spaceRef.kind === 39000);
    return (
      <Press
        variant="row"
        style={s.card}
        disabled={!tappable}
        onPress={tappable ? () => onOpenRef!(uri) : undefined}
        accessibilityLabel={tappable ? 'open referenced space' : undefined}>
        <Text style={s.label} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{view.kind}</Text>
        <Text style={[s.title, paragraphAlign(view.title)]} numberOfLines={2}>{view.title}</Text>
        {/* Owner npub — an untrusted stiq:space: token carries an attacker-controlled name/gradient
            but never proves who signed it; showing the owner lets a spoof of a real space be told
            apart, since the npub can't be forged to match. */}
        {view.owner ? (
          <Text style={s.owner} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {`by ${shortenNpub(safeNpubEncode(view.owner), {lead: 10, tail: 4})}`}
          </Text>
        ) : null}
        <View style={s.authorRow}>
          <GradientAvatar gradient={view.gradient} seed={view.seed} size={ctAvatar.refAuthor} shape={view.shape} />
          <Text style={s.author} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{view.name}</Text>
        </View>
        {cta ? <Text style={s.cta}>{cta}</Text> : null}
      </Press>
    );
  }
  // A `stiq:draft:…` (unpublished writing) or `stiq:msg:…` (decrypted snapshot of a PRIVATE post)
  // token is SELF-CONTAINED — render the shared referenced-card offline and hand the RAW token to
  // onOpenRef so the host opens the read view. Malformed → nothing (untrusted body content).
  if (uri.startsWith(DRAFT_EMBED_PREFIX)) {
    const draftRef = parseDraftEmbed(uri);
    if (!draftRef) return null;
    return <RefEmbed view={embedFromDraftRef(draftRef)} onPress={onOpenRef ? () => onOpenRef(uri) : undefined} />;
  }
  if (uri.startsWith(MSG_EMBED_PREFIX)) {
    const msgRef = parseMsgEmbed(uri);
    if (!msgRef) return null;
    return <RefEmbed view={embedFromMsgRef(msgRef)} onPress={onOpenRef ? () => onOpenRef(uri) : undefined} />;
  }
  const ref = decodeRef(uri);
  // Resolve by direct id (nevent/note) when present, else by the full URI so addressable `naddr`
  // refs (NIP-23 articles, channels) resolve via the runtime's {kind,author,#d} fetch instead of
  // sitting forever on the "Referenced post" placeholder.
  const summary = onLookup ? onLookup(ref.id ?? uri) : null;
  // Reuse the feed embed's display mapping: prefers a real article title, strips inline nostr
  // tokens, guards against surfacing a raw bech32 URI as the title, and labels by resolved kind.
  const view = embedFromSummary(summary);
  const kind = summary?.kind ?? ref.kind;
  const label = view
    ? view.kind.toUpperCase()
    : kind === 1111
    ? 'REFERENCED COMMENT'
    : kind === 30311
    ? 'REFERENCED CHANNEL'
    : 'REFERENCED POST';
  const title = view?.title ?? 'Referenced post';
  const snippet = view?.snip ?? '';
  const authorPubkey = summary?.pubkey || ref.pubkey || '';
  const npub = authorPubkey ? npubFor(authorPubkey) : '';
  const authorName = view?.name || (npub ? shortNpub(npub, 10, 4) : '');
  // Open the resolved event id (naddr resolves to a concrete id) or the directly-referenced id.
  const openId = summary?.id ?? ref.id;
  const tappable = !!(onOpenRef && openId);
  return (
    <Press
      variant="row"
      style={s.card}
      disabled={!tappable}
      onPress={tappable ? () => onOpenRef!(openId!) : undefined}
      accessibilityLabel={tappable ? 'open referenced event' : undefined}>
      {/* A comment (identity-forward, see RefEmbed) leads with WHO said it — the gradient + name row
          replaces the eyebrow, matching the same card in the feed. Everything else keeps the
          eyebrow-first / author-last order. */}
      {view?.variant === 'identityForward' ? (
        <>
          <View style={s.identityTop}>
            <GradientAvatar gradient={view.gradient} seed={npub || view.seed} size={ctAvatar.refAuthor} shape={view.shape} />
            <Text style={s.identityName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{authorName}</Text>
            <Text style={s.identityDot} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {` · ${view.identityLabel ?? view.kind}`}
            </Text>
          </View>
          {view.where ? (
            <Text style={s.identityWhere} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {`in ${view.where}`}
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={s.label} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{label}</Text>
      )}
      {/* TITLE + SNIPPET are user content → align each to its own first-strong direction. */}
      <Text style={[s.title, paragraphAlign(title)]} numberOfLines={2}>{title}</Text>
      {snippet ? <Text style={[s.snippet, paragraphAlign(snippet)]} numberOfLines={2}>{snippet}</Text> : null}
      {authorPubkey && view?.variant !== 'identityForward' ? (
        <View style={s.authorRow}>
          {/* The RESOLVED gradient (a member's claimed one) when the lookup carried it — passing only
              a seed silently rendered the deterministic fallback instead, so an embedded post/comment
              showed different colours than the same author's avatar everywhere else on screen. */}
          <GradientAvatar gradient={view?.gradient} seed={npub} size={ctAvatar.refAuthor} />
          <Text style={s.author} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{authorName}</Text>
        </View>
      ) : null}
    </Press>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: ctRadius.ref,
    paddingHorizontal: ctSpace.refPadX,
    paddingVertical: ctSpace.refPadY,
    marginTop: ctSpace.refTop,
    // Per-side borders (NOT the `borderColor` shorthand): on Android the shorthand silently wins
    // over `borderLeftColor`, painting the thicker left bar grey. Declaring every side explicitly
    // is the only reliable way to get the accent-blue left bar to render on-device.
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: colors.border,
    borderRightColor: colors.border,
    borderBottomColor: colors.border,
    borderLeftWidth: ctSpace.refBar,
    borderLeftColor: colors.accent,
  },
  label: {
    color: colors.accent,
    fontSize: ctType.refLabel.fontSize,
    fontWeight: ctWeight.bold,
    letterSpacing: ctTracking.refLabel,
    marginBottom: 4,
  },
  title: {color: colors.textPrimary, fontSize: ctType.refTitle.fontSize, fontWeight: ctWeight.semibold},
  owner: {color: colors.textMuted, fontSize: ctType.refAuthor.fontSize, marginTop: 2, fontFamily: 'monospace'},
  snippet: {
    color: colors.textSecondary,
    fontSize: ctType.refSnippet.fontSize,
    lineHeight: ctType.refSnippet.lineHeight,
    marginTop: 2,
  },
  authorRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8},
  author: {color: colors.textMuted, fontSize: ctType.refAuthor.fontSize},
  // Identity-forward header (comments): avatar · name · kind chip, then the thread it lives in —
  // the RefEmbed layout at this surface's denser type scale.
  identityTop: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6},
  identityName: {color: colors.textPrimary, fontSize: ctType.refTitle.fontSize, fontWeight: ctWeight.semibold, flexShrink: 1},
  identityDot: {color: colors.textMuted, fontSize: ctType.refAuthor.fontSize},
  identityWhere: {color: colors.textMuted, fontSize: ctType.refAuthor.fontSize, marginBottom: 5},
  cta: {color: colors.accent, fontSize: 12.5, fontWeight: '600', marginTop: 9},
});

/**
 * RefEmbed — a "referenced post / comment / channel post" embed card (design spec `.ref-embed`).
 *
 * A copied Stiq link to another post or comment renders as this card: an accent-railed block with
 * a kind eyebrow, the place it lives, a title, a short excerpt, and the author's identity. Tapping
 * it navigates to the target — it works the same inside a feed card, a post detail, or a comment.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import * as nip19 from 'nostr-tools/nip19';
import {Press} from '../../ui/Press';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import {colors} from '../../ui/theme';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import type {GradientSpec} from '../../media/gradient';
import {Kind} from '../../nostr/events';
import {paragraphAlign} from '../../ui/textDirection';
import type {NostrEventSummary} from '../../ui/NostrLinkPreview';
import type {SpaceRef} from '../../channels/spaceEmbed';
import {spaceEmbedLabel} from '../../channels/savedEmbeds';
import type {ParsedInvite} from '../../channels/invite';
import type {MsgRef} from '../../channels/msgEmbed';
import type {DraftRef} from '../draftEmbed';

/** The display fields a reference embed renders. */
export interface RefEmbedView {
  /** Eyebrow, e.g. "Referenced post" / "Referenced comment" / "Referenced channel post". */
  kind: string;
  /** Where it lives, e.g. "the community" or a parent post's title. */
  where?: string;
  title: string;
  snip?: string;
  name?: string;
  gradient?: GradientSpec | null;
  /** Seed (npub/pubkey) used to derive the avatar gradient when none is given. */
  seed?: string;
  /** Avatar shape override (SPACE cards: 'square' for a public channel, 'hexagon' for a private one). */
  shape?: AvatarShape;
  /**
   * SPACE cards only: the coordinate owner's raw pubkey. Untrusted `stiq:space:` tokens carry an
   * attacker-controlled name + gradient but never proved who signed them — surfacing the owner as a
   * short npub lets a viewer tell a spoofed card (impersonating a real space's look) from the real
   * thing, since the npub can't be forged to match.
   */
  owner?: string;
  /**
   * Render variant. `'identityForward'` (draft cards with a KNOWN author, and every comment card)
   * leads with `[GradientAvatar] {name} · {identityLabel}` at the TOP, then where/title/excerpt
   * below — instead of the generic eyebrow-first / author-last layout the other embed kinds (and an
   * author-less draft) use. Omitted (undefined) ⇒ the existing generic layout.
   */
  variant?: 'identityForward';
  /**
   * `'identityForward'` only: the kind chip trailing the name in the identity row ("Draft",
   * "Comment"). It replaces the generic eyebrow, so the card still says WHAT it is.
   */
  identityLabel?: string;
}

function shortNpub(pubkey: string): string {
  try {
    return shortenNpub(nip19.npubEncode(pubkey), {lead: 10, tail: 0});
  } catch {
    return shortenNpub(pubkey, {lead: 8, tail: 0});
  }
}

/** A bare nostr: reference token (or bech32 id) — never a meaningful title/snippet. */
const BARE_REF = /^(?:nostr:)?(?:nevent1|naddr1|note1|npub1|nprofile1)[a-z0-9]+$/i;

/** True when a string is blank or is itself a raw nostr ref/bech32 token (not real content). */
function isRawRef(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  return t.length === 0 || BARE_REF.test(t);
}

/** Strip inline nostr: reference tokens (embeds/mentions) out of a content excerpt. */
const EMBED_TOKEN = /(?:nostr:)?(?:nevent1|naddr1|note1|npub1|nprofile1)[a-z0-9]+/gi;

/** Truncate, but never surface a raw nostr: URI as content — return '' so callers can fall back. */
function truncate(s: string, n: number): string {
  const t = s.replace(EMBED_TOKEN, ' ').replace(/\s+/g, ' ').trim();
  if (!t || isRawRef(t)) return '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const CHANNEL_KINDS = new Set<number>([Kind.ChannelMessage, Kind.LiveChat]);

// A channel/private-space's OWN addressable metadata event (30311/39000) — distinct from
// CHANNEL_KINDS above, which is a MESSAGE posted inside a channel (kind 1311-family). A naddr ref
// that resolves straight to one of these reads as a channel/space card, not a "referenced post".
const SPACE_KINDS = new Set<number>([30311, 39000]);
const SPACE_SHAPE: Record<number, AvatarShape> = {30311: 'square', 39000: 'hexagon'};

/**
 * Map a resolved event summary into the embed's display fields. Posts read as
 * "Referenced post · in the community"; comments as "Referenced comment · in <root>".
 */
export function embedFromSummary(summary: NostrEventSummary | null): RefEmbedView | null {
  if (!summary) return null;
  const isComment = summary.kind === Kind.Comment || !!summary.rootTitle;
  const isChannel = summary.kind != null && CHANNEL_KINDS.has(summary.kind);
  const isSpace = summary.kind != null && SPACE_KINDS.has(summary.kind);
  const author = summary.name?.trim() || shortNpub(summary.pubkey);
  if (isSpace && !isComment) {
    const isPrivate = summary.kind === 39000;
    const cleanTitle = isRawRef(summary.title) ? '' : (summary.title ?? '').trim();
    return {
      kind: spaceEmbedLabel(summary.kind!, isPrivate),
      title: cleanTitle || author || (isPrivate ? 'Private space' : 'Channel'),
      gradient: summary.gradient,
      seed: summary.pubkey,
      shape: SPACE_SHAPE[summary.kind!],
    };
  }
  if (isComment) {
    // A comment IS its author saying something — so it gets the identity-forward layout: gradient +
    // name lead, the thread it lives in follows, and the comment's own words are the body. The old
    // generic layout put the author name in BOTH the title line and the bottom "by" row, which read
    // as a stutter (and, before the attribution fix in AppRuntime.getEvent, as a bare npub twice).
    return {
      kind: 'Referenced comment',
      where: isRawRef(summary.rootTitle) ? undefined : truncate(summary.rootTitle ?? '', 48) || undefined,
      title: truncate(summary.content, 140) || 'Tap to open',
      name: author,
      gradient: summary.gradient,
      seed: summary.pubkey,
      variant: 'identityForward',
      identityLabel: 'Comment',
    };
  }
  // A real title wins; else a clean content excerpt; else a generic label — never the raw URI.
  const cleanTitle = isRawRef(summary.title) ? '' : (summary.title ?? '').trim();
  const excerpt = truncate(summary.content, 90);
  return {
    kind: isChannel ? 'Referenced channel post' : 'Referenced post',
    where: isChannel ? 'a channel' : 'the community',
    title: cleanTitle || excerpt || 'Tap to open',
    snip: cleanTitle ? (truncate(summary.content, 140) || undefined) : undefined,
    name: author,
    gradient: summary.gradient,
    seed: summary.pubkey,
  };
}

/**
 * Map a decoded `stiq:space:…` token into the embed's display fields — FULLY OFFLINE (name and
 * gradient are carried in the token itself; no lookup/relay round-trip needed). Renders the
 * avatar+hint row via `view.name` ("Open" for a public channel, "Request to join" for a private
 * space) so a tap always has somewhere obvious to go.
 */
export function embedFromSpaceRef(ref: SpaceRef): RefEmbedView {
  const isPrivate = ref.kind === 39000 || ref.private;
  return {
    kind: spaceEmbedLabel(ref.kind, ref.private),
    title: ref.name ?? (isPrivate ? 'Private space' : 'Channel'),
    name: isPrivate ? 'Request to join' : 'Open',
    gradient: ref.gradient,
    seed: ref.coordinate,
    shape: SPACE_SHAPE[ref.kind],
    owner: ref.owner,
  };
}

/**
 * Map a decoded `stiq:msg:…` token (a quoted post/message from a PRIVATE space) into the embed's
 * display fields — FULLY OFFLINE (the decrypted body + author identity are carried in the token). The
 * body leads as the title so the quoted content is what a viewer reads; the author sits in the chip.
 */
export function embedFromMsgRef(ref: MsgRef): RefEmbedView {
  const author = ref.name?.trim() || shortNpub(ref.author);
  const excerpt = truncate(ref.body, 120);
  return {
    kind: 'Referenced post',
    where: ref.spaceName || 'a private space',
    title: excerpt || author || 'Tap to read',
    name: author,
    gradient: ref.gradient,
    seed: ref.author,
  };
}

/**
 * Map a decoded `stiq:draft:…` token into the embed's display fields — FULLY OFFLINE. A v2 pointer
 * shows its title/excerpt teaser and, when carried, the author (tapping opens the reader, which
 * resolves access state — request/pending/approved — and only THEN shows the full body). A legacy
 * v1 token (the retired self-contained format) shows an explicit "no longer available" card instead
 * of attempting to render stale content. A draft is not a post: there is no "where" (it lives in no
 * space).
 *
 * Phase 6: a draft with a KNOWN author gets the `'identityForward'` variant — the card leads with
 * the author's identity rather than burying it in the bottom "by" row, since a shared draft reads
 * as "someone's writing", not a generic reference. An author-LESS draft (the token carried no `p`)
 * has no identity to lead with, so it keeps the generic layout with its existing "Read draft" hint.
 */
export function embedFromDraftRef(ref: DraftRef | 'legacy'): RefEmbedView {
  if (ref === 'legacy') {
    return {
      kind: 'Draft',
      title: 'No longer available',
      snip: 'This shared draft uses an old format that is no longer supported.',
      name: 'Draft',
    };
  }
  const hasIdentity = !!ref.author;
  const author = ref.authorName?.trim() || (ref.author ? shortNpub(ref.author) : '');
  return {
    kind: 'Draft',
    title: ref.title || ref.excerpt || 'Untitled draft',
    snip: ref.title ? truncate(ref.excerpt, 140) || undefined : undefined,
    name: author || 'Read draft',
    gradient: ref.authorGradient,
    seed: ref.author || ref.title || 'draft',
    variant: hasIdentity ? 'identityForward' : undefined,
    identityLabel: 'Draft',
  };
}

// A `stiq://channel/<id>` invite link's id is EITHER a public-channel addressable coordinate
// (`30311:<64-hex owner>:<identifier>`) or a bare NIP-29 private-group id. The bare link carries no
// name/gradient (unlike a self-contained `stiq:space:` token), so the shape of the id is all we have
// to label the card offline. A short, elided id fills the title so a viewer sees WHICH space.
export const CHANNEL_COORD_RE = /^30311:[0-9a-f]{64}:/i;

/**
 * Map a parsed `stiq://channel/<id>` invite link into the embed's display fields — offline, from the
 * id shape alone (a bare invite link carries no name/gradient). A caller MAY pass a `summary`
 * resolved via onLookup (e.g. a public channel whose 30311 metadata is cached locally); when present
 * its richer fields (real name + gradient) win. The action hint is "Join" — tapping runs the in-app
 * accept-invite flow (never the external-link dialog).
 */
export function embedFromInviteLink(parsed: ParsedInvite, summary?: NostrEventSummary | null): RefEmbedView {
  const resolved = embedFromSummary(summary ?? null);
  if (resolved) return {...resolved, name: 'Join'};
  const isChannel = CHANNEL_COORD_RE.test(parsed.spaceId);
  const shortId = parsed.spaceId.length > 24 ? `${parsed.spaceId.slice(0, 23)}…` : parsed.spaceId;
  return {
    kind: isChannel ? 'Channel invite' : 'Private group invite',
    title: shortId,
    name: 'Join',
    shape: isChannel ? 'square' : 'hexagon',
    seed: parsed.spaceId,
  };
}

export interface RefEmbedProps {
  view: RefEmbedView;
  onPress?: () => void;
}

export function RefEmbed({view, onPress}: RefEmbedProps): React.JSX.Element {
  // An identified draft and a comment both lead with the AUTHOR's identity instead of the generic
  // eyebrow-first / author-last layout the other embed kinds use (see RefEmbedView.variant doc +
  // embedFromDraftRef/embedFromSummary). Every other kind — and an author-less draft — falls through
  // to the untouched generic branch below.
  if (view.variant === 'identityForward') {
    return (
      <Press
        variant="row"
        style={s.embed}
        pressedStyle={s.embedPressed}
        onPress={onPress}>
        <View style={s.identityTop}>
          <GradientAvatar gradient={view.gradient} seed={view.seed ?? view.name} size={20} shape={view.shape} />
          <Text style={s.identityName} numberOfLines={1}>{view.name}</Text>
          <Text style={s.identityDot}>{` · ${view.identityLabel ?? view.kind}`}</Text>
        </View>
        {/* A comment carries the thread it lives in; a draft lives in no space and has no `where`. */}
        {view.where ? <Text style={s.identityWhere} numberOfLines={1}>{`in ${view.where}`}</Text> : null}
        <Text style={[s.title, paragraphAlign(view.title)]} numberOfLines={2}>{view.title}</Text>
        {view.snip ? <Text style={[s.snip, paragraphAlign(view.snip)]} numberOfLines={2}>{view.snip}</Text> : null}
      </Press>
    );
  }
  return (
    <Press
      variant="row"
      style={s.embed}
      pressedStyle={s.embedPressed}
      onPress={onPress}>
      <View style={s.top}>
        <Text style={s.kind} numberOfLines={1}>{view.kind.toUpperCase()}</Text>
        {view.where ? <Text style={s.where} numberOfLines={1}>{`in ${view.where}`}</Text> : null}
      </View>
      <Text style={[s.title, paragraphAlign(view.title)]} numberOfLines={2}>{view.title}</Text>
      {view.owner ? (
        <Text style={s.owner} numberOfLines={1}>
          {`by ${shortenNpub(safeNpubEncode(view.owner), {lead: 10, tail: 4})}`}
        </Text>
      ) : null}
      {view.snip ? <Text style={[s.snip, paragraphAlign(view.snip)]} numberOfLines={2}>{view.snip}</Text> : null}
      {view.name ? (
        <View style={s.by}>
          <GradientAvatar gradient={view.gradient} seed={view.seed ?? view.name} size={16} shape={view.shape} />
          <Text style={s.byName} numberOfLines={1}>{view.name}</Text>
        </View>
      ) : null}
    </Press>
  );
}

const s = StyleSheet.create({
  embed: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    // Curved stiq-blue left accent: a 3px left border follows the rounded corners (same technique
    // as the content-warning box) — no absolute rail child, so the corners stay crisp on Android.
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingVertical: 11,
    paddingRight: 13,
    paddingLeft: 13,
    // Vertical, not top-only: an embed is a sibling in RichText's flat segment list, so without a
    // bottom margin the text after it sat flush against the card's border.
    marginVertical: 12,
  },
  embedPressed: {backgroundColor: colors.surfaceHover},
  top: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6},
  kind: {fontSize: 10, fontWeight: '700', letterSpacing: 0.7, color: colors.accent, flexShrink: 0},
  where: {fontSize: 11, color: colors.textMuted, flexShrink: 1, fontWeight: '400'},
  title: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary, lineHeight: 18.85},
  // Owner npub line (SPACE cards only) — distinguishes a real space from a same-looking spoofed
  // card, since the owner npub can't be forged to match a legitimate one.
  owner: {fontSize: 11, color: colors.textMuted, marginTop: 2, fontFamily: 'monospace'},
  snip: {fontSize: 13, lineHeight: 19.5, color: colors.textSecondary, marginTop: 3, fontWeight: '400'},
  by: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9},
  byName: {fontSize: 11.5, color: colors.textMuted, flexShrink: 1, fontWeight: '400'},
  // Identity-forward layout (Phase 6, `variant: 'identityForward'`) — avatar · name · "· Draft" AT
  // THE TOP, replacing the generic eyebrow/where row for this variant only.
  identityTop: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8},
  identityName: {fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  identityDot: {fontSize: 12, color: colors.textMuted},
  // "in <thread>" under the identity row (comments only) — same muted weight as the generic
  // layout's `where`, but on its own line since the identity row already fills the first one.
  identityWhere: {fontSize: 11, color: colors.textMuted, fontWeight: '400', marginTop: -4, marginBottom: 6},
});

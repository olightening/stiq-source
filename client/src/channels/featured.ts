/**
 * Featured spaces — the organizer's curated, ordered rail at the top of the Log tab.
 *
 * The organizer publishes an ordered list of space refs (moderation/organizerConfig.ts,
 * d="stiq:featured"); this module resolves each ref against what the client actually knows about
 * that space and produces a render-ready row.
 *
 * TWO THINGS ARE DELIBERATELY SPLIT, and the split is the whole design:
 *   - The NAME belongs to the space's OWNER. It is read live from the space's own metadata
 *     (30311 for channels, 39000 for groups) so renaming a channel renames it everywhere,
 *     including here. The organizer cannot rewrite what someone else's space is called.
 *   - The LABEL belongs to the ORGANIZER. It is a short chip riding alongside ("Start here"),
 *     carried in the organizer's own signed doc.
 *
 * REACHABILITY. A NIP-53 channel is ALWAYS reachable: its 30311 definition is small and addressable,
 * and the caller fetches it by coordinate on tap when it isn't already cached (the firehose is
 * newest-N bounded, so an unjoined channel's definition is NOT guaranteed to be resident) — the same
 * fetch-on-open a tapped space-embed card uses. Its name/gradient come from the live 30311 when known,
 * else from the `stiq:space:` link the organizer curated (which carries both), else a stand-in. NIP-29
 * groups are membership-gated and off-firehose: a non-member has no 39000 and cannot fetch one, so an
 * unresolved group is `reachable:false` — the row still renders (the organizer chose it) with the
 * carried name/gradient, but as a join-first affordance rather than a dead tap. A featured USER is
 * always reachable — any pubkey opens a profile with no membership or firehose precondition.
 */
import type {Channel} from './channels';
import type {GroupState} from './groups';
import type {FeaturedSpace} from '../moderation/organizerConfig';
import type {GradientSpec} from '../media/gradient';
import type {AvatarShape} from '../ui/GradientAvatar';

/** The kind of entry a row points at — drives the icon and how a tap is routed. */
export type FeaturedKind =
  | 'channel' // NIP-53, owner-voiced broadcast
  | 'open' // NIP-53 with mode=open — a public channel with many voices
  | 'group' // NIP-29, open + public
  | 'group-closed' // NIP-29, join needs an admin's approval
  | 'group-private' // NIP-29, members-only readership
  | 'group-broadcast' // NIP-29, admins-only posting
  | 'user'; // a featured person — opens their profile

/** Per-kind glyph. Emoji-only by house rule (see the design-system handoff — no icon fonts). */
const KIND_GLYPH: Record<FeaturedKind, string> = {
  channel: '📢',
  open: '🌐',
  group: '👥',
  'group-closed': '🔒',
  'group-private': '🕶️',
  'group-broadcast': '📣',
  user: '👤',
};

export function featuredGlyph(kind: FeaturedKind): string {
  return KIND_GLYPH[kind];
}

/** A resolved, render-ready featured row. Carries the same identity fields the Channels tab uses to
 * draw a row, so the rail renders in the exact channel-row style rather than a bespoke card. */
export interface FeaturedRow {
  /** The ref — channel coordinate, group id, or user pubkey. Stable; safe as a list key. */
  ref: string;
  /** Live name when known (channel title / group name / user display name), else snapshot, else a stand-in. */
  name: string;
  /** Organizer's chip text, if they set one. */
  label?: string;
  kind: FeaturedKind;
  glyph: string;
  /** True when the entry can be opened right now (a user always can; an off-firehose group may not). */
  reachable: boolean;
  /** Gradient-avatar seed — the ref, so an entry without a crafted gradient still gets a stable one. */
  seed: string;
  /** Avatar outline shape, matching how the Channels tab draws this same entity. */
  shape: AvatarShape;
  /** Crafted gradient when known; null/undefined falls back to the seeded gradient. */
  gradient?: GradientSpec | null;
}

/** Narrow a channel to its precise featured kind. */
function channelKind(ch: Channel | undefined): FeaturedKind {
  return ch?.openCommunity ? 'open' : 'channel';
}

/**
 * Narrow a group to its precise featured kind. Order matters: `private` is the strongest signal
 * (members-only readership) and wins over closed/broadcast, because it is what a viewer most needs
 * to understand about the row before tapping it.
 */
function groupKind(g: GroupState | undefined): FeaturedKind {
  if (!g) return 'group';
  if (g.private) return 'group-private';
  if (g.closed) return 'group-closed';
  if (g.broadcast) return 'group-broadcast';
  return 'group';
}

/** Avatar shape for a group row — byte-for-byte the mapping the Channels tab uses (MainScreen
 * groupRow): a broadcast+private space is a private channel (diamond), a broadcast is an octagon,
 * everything else a hexagon. Keeps a featured group visually identical to its Channels-tab row. */
function groupShape(g: GroupState | undefined): AvatarShape {
  if (g?.broadcast && g?.private) return 'diamond';
  if (g?.broadcast) return 'octagon';
  return 'hexagon';
}

/**
 * Resolve the organizer's featured list against what this client knows.
 *
 * Pure: takes the caches (and a name lookup for users) rather than a store, so it is trivially
 * testable and can't trigger a query. Preserves the organizer's order exactly. Never throws on an
 * unknown ref — an unresolvable channel/group degrades to an unreachable row with the organizer's
 * snapshot name.
 *
 * `userInfo` resolves a user ref (hex pubkey) to the viewer's learned display name + gradient (the
 * phonebook + gradient store), kept as a plain function so this stays pure. Channels and groups carry
 * their own gradient in the passed caches; a user's rides here instead.
 */
export function resolveFeatured(
  featured: readonly FeaturedSpace[] | undefined,
  channels: readonly Channel[],
  groups: readonly GroupState[],
  userInfo?: (pubkey: string) => {name?: string; gradient?: GradientSpec | null} | undefined,
): FeaturedRow[] {
  if (!featured || featured.length === 0) return [];
  const byChannel = new Map(channels.map(c => [c.id, c]));
  const byGroup = new Map(groups.map(g => [g.id, g]));

  return featured.map(f => {
    if (f.type === 'user') {
      const info = userInfo?.(f.ref);
      return {
        ref: f.ref,
        name: info?.name || f.name || 'Member',
        label: f.label,
        kind: 'user',
        glyph: KIND_GLYPH.user,
        // A pubkey always opens a profile — no membership/firehose precondition.
        reachable: true,
        seed: f.ref,
        shape: 'circle',
        gradient: info?.gradient ?? null,
      };
    }
    if (f.type === 'channel') {
      const ch = byChannel.get(f.ref);
      const kind = channelKind(ch);
      return {
        ref: f.ref,
        name: ch?.name || f.name || 'Channel',
        label: f.label,
        kind,
        glyph: KIND_GLYPH[kind],
        // Always reachable: a NIP-53 channel opens even unjoined — the caller fetches its 30311 by
        // coordinate on tap (exactly as tapping a space-embed card does), so the row is never inert
        // just because the definition hasn't reached the firehose window yet. The live gradient wins;
        // a `stiq:space:` link's carried gradient paints it correctly until then.
        reachable: true,
        seed: f.ref,
        shape: ch?.openCommunity ? 'octagon' : 'square',
        gradient: ch?.gradient ?? f.gradient ?? null,
      };
    }
    const g = byGroup.get(f.ref);
    const kind = groupKind(g);
    return {
      ref: f.ref,
      name: g?.name || f.name || 'Group',
      label: f.label,
      kind,
      glyph: KIND_GLYPH[kind],
      // A NIP-29 group is off-firehose + membership-gated: a non-member has no 39000 and can't fetch
      // one, so an unresolved group stays inert (the carried name/gradient still paints the row).
      reachable: !!g,
      seed: f.ref,
      shape: groupShape(g),
      gradient: g?.gradient ?? f.gradient ?? null,
    };
  });
}

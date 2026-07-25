/**
 * Profiles (PLAN.md §3.8 / Step 19). A profile aggregates a pubkey's metadata (kind 0) and
 * the channels they own (kind 40). Reached only by tapping a post author — there is no
 * directory or search (enforced at the relay by RequireScopedDiscovery).
 *
 * Posts + ideaCount are NOT built here. Blind posts are signed by per-post THROWAWAY keys, so a
 * raw `{authors: [pubkey]}` store query (the old approach) never matches a blind author's real
 * npub — it only ever found non-blind content. AppRuntime.getProfile overlays both fields from the
 * already-resolved feed (FeedItem.authorPubkey, via resolveAuthorPubkey) instead, reusing the SAME
 * moderation path every other view renders through (visibleFeed) rather than a second, subtly
 * different filter. This module stays scoped to metadata + channels, which ARE correctly
 * raw-key-scoped (channels are real-key signed, never blind).
 */
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {FeedItem} from '../feed/feed';
import {parseChannel} from '../channels/channels';
import {safeNpubEncode} from '../util/npub';

/**
 * One "idea" — a comment (NIP-22 kind-1111 or hybrid kind-1 stiq-comment) authored by the profiled
 * user, resolved for display in their profile's Ideas tab. Populated by AppRuntime.getProfile; always
 * [] straight out of buildProfile (see the Profile.ideas note).
 */
export interface ProfileIdea {
  /** The comment event id. */
  id: string;
  /** Resolved comment text (identity header stripped, blind content unsealed; '' when locked). */
  content: string;
  createdAt: number;
  /** The post this comment lives under, resolved to a feed item so a tap opens that thread.
   *  Undefined when the root post isn't in the viewer's visible feed (aged out / hidden). */
  rootPost?: FeedItem;
  /** Short title/excerpt of the root post, for the "on <post>" subtext under the idea. */
  rootTitle?: string;
}

export interface ChannelSummary {
  id: string; // channel-create (kind 40) event id
  name: string;
  about?: string;
  picture?: string;
  /** The channel's OWN configured gradient (from its 30311 `gradient` tag). Undefined → the renderer
   *  derives one from the channel-id seed. Carried through so a profile's channel rows show the
   *  channel's real gradient, not a generic seed-derived one. */
  gradient?: import('../media/gradient').GradientSpec;
}

export interface Profile {
  pubkey: string;
  npub: string;
  name?: string;
  about?: string;
  picture?: string;
  /** Crafted identity gradient (relay-blind, set-once). Undefined → derive from pubkey seed. */
  gradient?: import('../media/gradient').GradientSpec;
  channels: ChannelSummary[];
  /** Posts + articles by this author (channels shown first in UI per the plan). Populated by
   *  AppRuntime.getProfile from the resolved feed — always [] straight out of buildProfile. */
  posts: FeedItem[];
  /** NIP-22 kind-1111 comments (+ hybrid kind-1 stiq-comments) by this author, resolved. Populated
   *  by AppRuntime.getProfile — always 0 straight out of buildProfile. */
  ideaCount: number;
  /** This author's comments ("ideas"), resolved for the profile's Ideas tab. Populated by
   *  AppRuntime.getProfile — always [] straight out of buildProfile (see the module doc comment). */
  ideas: ProfileIdea[];
  /**
   * Set only on the VIEWER'S OWN profile, and only when their display name has definitively lost
   * the longest-held-wins arbitration to an earlier claimant — meaning the community currently
   * renders them as a bare npub (see displayName.ts `nameConflict`). Undefined otherwise, which is
   * NOT a guarantee the name is unique: it only means no conflict is known from what has synced.
   * Populated by AppRuntime.getProfile — always undefined straight out of buildProfile.
   */
  nameConflict?: import('./displayName').NameConflict;
}

function safeJson(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}


/** Build a profile for `pubkey` from cached events. */
export function buildProfile(store: EventStore, pubkey: string): Profile {
  const [metadata] = store.query({kinds: [Kind.Metadata], authors: [pubkey], limit: 1});
  const meta = metadata ? safeJson(metadata.content) : {};
  // NIP-53 channels (addressable kind 30311), deduped by coordinate (latest wins).
  const byCoord = new Map<string, ChannelSummary>();
  for (const ev of store.query({kinds: [Kind.LiveActivity], authors: [pubkey]})) {
    const ch = parseChannel(ev);
    if (ch) byCoord.set(ch.id, {id: ch.id, name: ch.name, about: ch.about, picture: ch.picture, gradient: ch.gradient});
  }
  const channels = [...byCoord.values()];

  return {
    pubkey,
    npub: safeNpubEncode(pubkey),
    name: str(meta.name),
    about: str(meta.about),
    picture: str(meta.picture),
    channels,
    // Resolved (blind-attribution-aware) by AppRuntime.getProfile — see the module doc comment.
    posts: [],
    ideaCount: 0,
    ideas: [],
  };
}

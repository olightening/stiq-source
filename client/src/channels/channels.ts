/**
 * Channels — NIP-53 Live Activities.
 *
 * A channel is an addressable `kind:30311` event signed by the owner, identified by a `d`
 * tag. Its stable identity is the NIP-01 address coordinate `30311:<owner-pubkey>:<d>`,
 * which is what messages, subscriptions, and the UI reference (NOT a one-shot event id, so
 * the owner can edit channel metadata by re-publishing the same coordinate — latest wins).
 *
 * Messages are `kind:1311` (NIP-53 live chat) carrying an `["a", "<coord>", "", "root"]`
 * tag. Channels are open and ride the firehose (NIP-53's openness rationale), unlike the old
 * NIP-28 channels which required scoped discovery.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import type {UnsignedEvent} from '../keys/keystore';
import type {Signer} from '../feed/compose';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';
import {encryptForSpace, type SpaceKey} from './groupCrypto';
import {promotedTagFrom} from './promote';

export type {SpaceKey};

export interface ChannelMetadata {
  name: string;
  about?: string;
  picture?: string;
  gradient?: GradientSpec;
  /** Emoji set the owner enables as one-tap reactions on every broadcast. Empty/absent = none. */
  reactions?: string[];
  /** Event id of the broadcast the owner has pinned to the top, if any. */
  pinnedMessageId?: string;
  /**
   * Hex pubkeys the owner has granted moderation power in this channel. NIP-53 channels have no
   * relay roster, so admin authority is carried as owner-signed `['p', <pubkey>, 'admin']` tags on
   * the 30311 (same `['p', pk, role]` shape as NIP-29), giving channels the per-space admin model
   * groups get from the relay. The owner is always an admin implicitly (see {@link isChannelAdmin}).
   */
  admins?: string[];
  /**
   * Open community — a public channel that ANY admin (not just the owner) posts to and where every
   * post carries its author's identity, but that stays discoverable + joinable by anyone (a public
   * channel with multiple voices). Carried as a `['mode','open']` tag on the 30311; a plain public
   * channel is owner-voiced. Rendered with the octagon identity shape.
   */
  openCommunity?: boolean;
}

export interface Channel {
  /** Addressable coordinate `30311:<owner>:<d>` — the stable channel identity. */
  id: string;
  owner: string; // hex pubkey
  name: string;
  about?: string;
  picture?: string;
  gradient?: GradientSpec;
  /** Owner-configured reaction emojis shown on every broadcast (NIP-7 kind-7 tallies). */
  reactions?: string[];
  /** Event id of the owner's pinned broadcast, surfaced in the channel's PINNED bar. */
  pinnedMessageId?: string;
  /** Owner-granted moderators of this channel (owner is implicitly an admin too). */
  admins?: string[];
  /** Open community — admins (not only the owner) post, posts show author identity, octagon shape. */
  openCommunity?: boolean;
}

/** NIP-01 addressable coordinate for a 30311 event. */
export function channelCoord(pubkey: string, d: string): string {
  return `${Kind.LiveActivity}:${pubkey}:${d}`;
}

function tagValue(event: Event, name: string): string | undefined {
  const t = event.tags.find(tag => tag[0] === name && tag[1]);
  return t?.[1];
}

/** Generate a short random `d` identifier for a new channel. */
function newChannelD(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the 30311 tag set for a channel definition keyed by an explicit `d`. */
function buildChannelTags(d: string, meta: ChannelMetadata): string[][] {
  const tags: string[][] = [
    ['d', d],
    ['title', meta.name],
    ['status', 'live'],
  ];
  if (meta.about) tags.push(['summary', meta.about]);
  if (meta.picture) tags.push(['image', meta.picture]);
  if (meta.gradient) {
    const encoded = encodeGradient(meta.gradient);
    if (encoded) tags.push(['gradient', encoded]);
  }
  // Reaction set as a single multi-value tag: ['reactions', '👍', '🔥', '🙏'].
  const reactions = (meta.reactions ?? []).map(e => e.trim()).filter(Boolean);
  if (reactions.length > 0) tags.push(['reactions', ...reactions]);
  if (meta.pinnedMessageId) tags.push(['pinned', meta.pinnedMessageId]);
  // Open community marker (a public channel with admin voices + author identity). Absent = owner-voiced.
  if (meta.openCommunity) tags.push(['mode', 'open']);
  // Per-space admins as NIP-29-shaped ['p', pubkey, 'admin'] tags (owner is always admin implicitly).
  for (const pk of (meta.admins ?? []).map(a => a.trim()).filter(Boolean)) {
    tags.push(['p', pk, 'admin']);
  }
  return tags;
}

export function buildChannelCreate(meta: ChannelMetadata): UnsignedEvent {
  return {
    kind: Kind.LiveActivity,
    created_at: Math.floor(Date.now() / 1000),
    tags: buildChannelTags(newChannelD(), meta),
    content: '',
  };
}

/**
 * Edit a channel by re-publishing the SAME `d` (addressable latest-wins). Identical to
 * `buildChannelCreate` except the `d` is reused instead of freshly generated.
 */
export function buildChannelEdit(d: string, meta: ChannelMetadata): UnsignedEvent {
  return {
    kind: Kind.LiveActivity,
    created_at: Math.floor(Date.now() / 1000),
    tags: buildChannelTags(d, meta),
    content: '',
  };
}

/** Create a channel owned by the signer's account. */
export function createChannel(signer: Signer, meta: ChannelMetadata): Promise<Event> {
  return signer.sign(buildChannelCreate(meta));
}

/**
 * Wrap a body for the wire: NIP-44-encrypt under `enc.key` (+ encryption marker tags) for a private
 * space, else return plaintext untouched. Mirrors groups.ts/sealBody so private channels never leak
 * plaintext to the relay. NOTE: NIP-53 channels are public by design today (no `private` flag on
 * ChannelMetadata), so `enc` is currently never passed — this keeps the path ready + unit-testable.
 */
function sealBody(content: string, enc?: SpaceKey): {content: string; tags: string[][]} {
  if (!enc) return {content, tags: []};
  return {
    content: encryptForSpace(content, enc.key),
    tags: [['encrypted', 'nip44'], ['ke', String(enc.epoch)]],
  };
}

/** The encryption epoch a channel message was sealed under (its `['ke', n]` tag), or null. */
export function channelMessageEpoch(event: Event): number | null {
  if (!event.tags.some(t => t[0] === 'encrypted' && t[1] === 'nip44')) return null;
  const ke = event.tags.find(t => t[0] === 'ke' && t[1] !== undefined)?.[1];
  if (ke === undefined) return null;
  const n = Number(ke);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function buildChannelMessage(
  channelCoordinate: string,
  content: string,
  enc?: SpaceKey,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('channel message is empty');
  }
  const sealed = sealBody(trimmed, enc);
  return {
    kind: Kind.LiveChat,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['a', channelCoordinate, '', 'root'], ...sealed.tags],
    content: sealed.content,
  };
}

/** Owner broadcast into a channel. */
export function broadcastToChannel(
  signer: Signer,
  channelCoordinate: string,
  content: string,
): Promise<Event> {
  return signer.sign(buildChannelMessage(channelCoordinate, content));
}

/**
 * Build a position-preserving EDIT of a prior broadcast: a fresh 1311 carrying the channel `a` tag
 * plus an `["e", <originalId>, "", "edit"]` marker. At read time (`channelMessages`) the edit's text
 * replaces the original IN PLACE — same id, created_at, comments, reactions — so the message keeps its
 * spot in the feed and is flagged "edited". Only honored when signed by the original's author.
 */
export function buildChannelMessageEdit(
  channelCoordinate: string,
  originalId: string,
  content: string,
  enc?: SpaceKey,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('channel message is empty');
  }
  const sealed = sealBody(trimmed, enc);
  return {
    kind: Kind.LiveChat,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['a', channelCoordinate, '', 'root'],
      ['e', originalId, '', 'edit'],
      ...sealed.tags,
    ],
    content: sealed.content,
  };
}

/** The broadcast id this event edits (its `["e", id, "", "edit"]` marker), or null if not an edit. */
export function editTargetId(event: Event): string | null {
  if (event.kind !== Kind.LiveChat) return null;
  const t = event.tags.find(tag => tag[0] === 'e' && tag[3] === 'edit');
  return t?.[1] ?? null;
}

export function parseChannel(event: Event): Channel | null {
  if (event.kind !== Kind.LiveActivity) {
    return null;
  }
  const d = tagValue(event, 'd');
  if (!d) return null;
  const reactionsTag = event.tags.find(t => t[0] === 'reactions');
  const reactions = reactionsTag ? reactionsTag.slice(1).filter(Boolean) : undefined;
  const admins = event.tags
    .filter(t => t[0] === 'p' && t[2] === 'admin' && !!t[1])
    .map(t => t[1] as string);
  return {
    id: channelCoord(event.pubkey, d),
    owner: event.pubkey,
    name: tagValue(event, 'title') ?? 'channel',
    about: tagValue(event, 'summary'),
    picture: tagValue(event, 'image'),
    gradient: decodeGradient(tagValue(event, 'gradient') ?? ''),
    reactions: reactions && reactions.length > 0 ? reactions : undefined,
    pinnedMessageId: tagValue(event, 'pinned'),
    admins: admins.length > 0 ? admins : undefined,
    openCommunity: tagValue(event, 'mode') === 'open' || undefined,
  };
}

/**
 * Whether `pubkey` may moderate this channel — the owner, or an owner-granted admin. The channel
 * analogue of {@link isGroupAdmin}; feeds the per-space restore authority in space auto-moderation.
 */
export function isChannelAdmin(channel: Channel, pubkey: string): boolean {
  return channel.owner === pubkey || (channel.admins?.includes(pubkey) ?? false);
}

/** The channel coordinate a kind-1311 message targets (its `a` tag), or null. */
export function messageChannelId(event: Event): string | null {
  if (event.kind !== Kind.LiveChat) {
    return null;
  }
  for (const tag of event.tags) {
    if (tag[0] === 'a' && tag[1]) {
      return tag[1];
    }
  }
  return null;
}

/** A channel definition from the cache by coordinate — latest 30311 wins (addressable). */
export function getChannel(store: EventStore, channelCoordinate: string): Channel | null {
  const latest = store
    .query({kinds: [Kind.LiveActivity]})
    .filter(ev => {
      const ch = parseChannel(ev);
      return ch !== null && ch.id === channelCoordinate;
    })
    .sort((a, b) => b.created_at - a.created_at)[0];
  return latest ? parseChannel(latest) : null;
}

/**
 * A channel's chat messages from the cache, oldest first, with edits folded in place.
 *
 * Edit events (`["e", id, "", "edit"]`) are NOT shown as their own messages; instead the latest edit
 * by the original's author replaces that message's content and flags it with an `["edited", <ts>]`
 * tag. Position (created_at), id, comments and reactions all stay anchored to the original.
 */
export function channelMessages(store: EventStore, channelCoordinate: string): Event[] {
  const all = store
    .query({kinds: [Kind.LiveChat]})
    .filter(message => messageChannelId(message) === channelCoordinate);

  // Latest edit per (target, author) — keyed by author so a foreign edit can never rewrite or
  // shadow the genuine one (nobody can edit someone else's message).
  const editsByKey = new Map<string, Event>();
  for (const ev of all) {
    const target = editTargetId(ev);
    if (!target) continue;
    const key = `${target} ${ev.pubkey}`;
    const cur = editsByKey.get(key);
    if (!cur || ev.created_at > cur.created_at) editsByKey.set(key, ev);
  }

  const folded: Event[] = [];
  for (const m of all) {
    if (editTargetId(m)) continue; // an edit event never renders as its own broadcast
    const edit = editsByKey.get(`${m.id} ${m.pubkey}`);
    folded.push(
      edit
        ? {...m, content: edit.content, tags: [...m.tags, ['edited', String(edit.created_at)], ...promotedTagFrom(edit)]}
        : m,
    );
  }
  return folded.sort((a, b) => a.created_at - b.created_at);
}

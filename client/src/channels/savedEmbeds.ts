/**
 * Saved embeds — the "save to embed later" bookmark store behind the composer's embed picker.
 *
 * A user saves a post/comment from the ⋯ menu; later, the composer's embed button lists the saved
 * references and tapping one inserts a `nostr:nevent…` link into the draft, which renders as a
 * REFERENCED card (via NostrLinkPreview) in the published message.
 *
 * Stored locally (AsyncStorage) — these bookmarks are private to the device and never published, in
 * keeping with Stiq's metadata-minimal posture (distinct from the public NIP-51 kind-10003 list).
 * Mirrored in memory after first load so the picker can read synchronously while rendering.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nip19 from 'nostr-tools/nip19';
import {referencedLabel} from './components/primitives/format';
import type {GradientSpec} from '../media/gradient';
import {encodeSpaceEmbed} from './spaceEmbed';
import {decodeNameHeader} from '../profile/displayName';

const KEY = 'stiq.savedEmbeds';
const MAX = 50; // newest-first cap so the picker stays small

export interface SavedEmbed {
  /**
   * Referenced identity. For a POST/COMMENT embed this is the event id. For a SPACE embed (channel
   * or private group) this is the NIP-01 addressable coordinate `${kind}:${owner}:${identifier}` —
   * `30311:<owner>:<d>` (matches `Channel.id`) or `39000:<owner>:<groupId>`.
   */
  id: string;
  /** Referenced author's hex pubkey (for the nevent author hint + display), or the space's owner. */
  pubkey: string;
  /** Referenced event kind, when known (drives the REFERENCED POST/QUESTION/COMMENT label), or the space kind (30311/39000). */
  kind?: number;
  /** Unix-seconds the user saved it (newest first in the picker). */
  savedAt: number;
  /** SPACE embed only: the channel/group display name (a private group has no other way to show it offline). */
  name?: string;
  /** SPACE embed only: the space's gradient identity, if it has one. */
  gradient?: GradientSpec;
  /** SPACE embed only: true for a private group (39000), false/absent for a public channel (30311). */
  private?: boolean;
  /** SPACE embed only, kind 39000: the group's `h`/`d` identifier (the coordinate's third segment). */
  groupId?: string;
  /** EVENT embed only (kind 31923): the full self-contained `stiq:event:…` token, stored verbatim
   * so re-insertion reproduces the exact public card snapshot (renders offline, upgrades live). */
  eventToken?: string;
  /** PRIVATE MESSAGE embed only: the full self-contained `stiq:msg:…` token (decrypted snapshot of a
   * private channel/group post), stored verbatim — a private post can't be re-fetched by its id. */
  msgToken?: string;
  /** DRAFT embed only: the full self-contained `stiq:draft:…` token (an unpublished piece of writing),
   * stored verbatim — a draft was never published, so the token IS the content. */
  draftToken?: string;
}

let _loaded = false;
let _list: SavedEmbed[] = [];

async function persist(): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(_list));
}

/** Load saved embeds into memory once. Safe to await repeatedly. */
export async function ensureSavedEmbedsLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) _list = (JSON.parse(raw) as SavedEmbed[]).filter(e => e && e.id);
  } catch { /* fresh state is fine */ }
}

/** Current saved embeds, newest first. Synchronous — call after load. */
export function listSavedEmbeds(): SavedEmbed[] {
  return _list;
}

export function isEmbedSaved(id: string): boolean {
  return _list.some(e => e.id === id);
}

/**
 * Guarantee the `nostr:` scheme prefix on an already bech32-encoded identifier (nevent/naddr/note/
 * npub/…). Idempotent — a caller that already prefixed it (e.g. a feed item's pre-computed
 * identifier) gets the same string back, so this is safe to apply defensively at every call site.
 */
export function withNostrScheme(identifier: string): string {
  return identifier.startsWith('nostr:') ? identifier : `nostr:${identifier}`;
}

/**
 * The canonical `nostr:nevent…` link for an event (id + author hint) — the ONE formatting path
 * every "copy link"/"embed" action routes through, so a shared post reads identically regardless of
 * which card, bubble, or menu produced it. Falls back to a bare `nostr:<id>` if nevent encoding
 * throws (a valid event id practically never does).
 */
export function nostrLinkForEvent(item: {id: string; author: string}): string {
  try { return withNostrScheme(nip19.neventEncode({id: item.id, author: item.author})); }
  catch { return withNostrScheme(item.id); }
}

/**
 * The canonical `nostr:note…` link for a bare event reference (no author hint available) — used
 * where only an id is known (e.g. a comment's copy-link).
 */
export function nostrLinkForNote(id: string): string {
  try { return withNostrScheme(nip19.noteEncode(id)); }
  catch { return withNostrScheme(id); }
}

/**
 * The embed URI for a saved reference — appended to a draft, it renders as a card in the published
 * message. A SPACE embed (kind 30311 channel or 39000 private group) produces a self-contained
 * `stiq:space:…` token (see {@link encodeSpaceEmbed}); anything else falls back to the existing
 * `nostr:nevent…` path. Falls back to a bare `nostr:<id>` if nevent encoding throws. Shared by every
 * composer surface so "embed" behaves identically in channels, groups, DMs, and comments.
 */
export function savedEmbedUri(
  item: Pick<
    SavedEmbed,
    'id' | 'pubkey' | 'kind' | 'name' | 'gradient' | 'groupId' | 'eventToken' | 'msgToken' | 'draftToken'
  >,
): string {
  // A DRAFT / PRIVATE-MESSAGE embed re-inserts its stored self-contained token verbatim — neither has
  // a relay-resolvable id (a draft was never published; a private post is stored still-encrypted).
  if (item.draftToken) return item.draftToken;
  if (item.msgToken) return item.msgToken;
  // An EVENT embed re-inserts its stored self-contained token verbatim (see saveEventEmbed).
  if (item.kind === 31923 && item.eventToken) return item.eventToken;
  if (item.kind === 30311) {
    // id = '30311:<owner>:<d>' — the owner segment is fixed (a 64-char hex pubkey has no ':'), but
    // the `d` identifier could in principle contain ':', so re-join everything after it.
    const parts = item.id.split(':');
    const owner = parts[1] ?? item.pubkey;
    const identifier = parts.slice(2).join(':');
    return encodeSpaceEmbed({kind: 30311, owner, identifier, name: item.name, private: false, gradient: item.gradient});
  }
  if (item.kind === 39000) {
    return encodeSpaceEmbed({
      kind: 39000,
      owner: item.pubkey,
      identifier: item.groupId ?? '',
      name: item.name,
      private: true,
      gradient: item.gradient,
    });
  }
  return nostrLinkForEvent({id: item.id, author: item.pubkey});
}

/** Uppercase row label for a saved reference (REFERENCED COMMENT for kind-1111, else REFERENCED POST). */
export function savedEmbedLabel(item: Pick<SavedEmbed, 'kind'>): string {
  return referencedLabel(item.kind);
}

/** Uppercase row label for a SPACE embed — 'PRIVATE SPACE' for a 39000 group, else 'CHANNEL'. */
export function spaceEmbedLabel(kind: number, isPrivate?: boolean): string {
  return kind === 39000 || isPrivate ? 'PRIVATE SPACE' : 'CHANNEL';
}

/** Uppercase row label for ANY saved embed, used by the composer picker rows. Distinguishes the
 * self-contained kinds (draft/private-message/event/space) from a plain referenced post/comment. */
export function savedEmbedRowLabel(
  item: Pick<SavedEmbed, 'kind' | 'msgToken' | 'draftToken' | 'private'>,
): string {
  if (item.draftToken) return 'DRAFT';
  if (item.msgToken) return 'PRIVATE POST';
  if (item.kind === 31923) return 'EVENT';
  if (item.kind === 30311 || item.kind === 39000) return spaceEmbedLabel(item.kind, item.private);
  return referencedLabel(item.kind);
}

/** True when re-inserting this saved embed exposes PRIVATE CONTENT (a post carried out of a private
 * space via a self-contained `stiq:msg:` token) — the composer confirms before inserting one. A
 * private-space CARD (kind 39000) is deliberately NOT flagged: it's navigate-only (name/gradient only,
 * no content), exactly like the invite links the app already lets you share without a prompt. */
export function savedEmbedIsPrivate(item: Pick<SavedEmbed, 'msgToken'>): boolean {
  return !!item.msgToken;
}

/** The composer-picker row shape shared by every editor (feed, channels, groups, DMs, comments). */
export interface SavedEmbedRow {
  id: string;
  pubkey: string;
  label: string;
  title: string;
  snippet: string;
  /** Insertion token — the self-contained/nevent URI, precomputed so every editor inserts identically. */
  uri: string;
  /** Private CONTENT (a `stiq:msg:` token) — the editor confirms before inserting. */
  private?: boolean;
}

/**
 * Build a composer-picker row from a saved embed. ONE definition of "how a saved embed appears + what
 * gets inserted", used by every editor so channels, groups, DMs, and the feed can never disagree (and
 * so a new embed kind — draft, private post — is handled everywhere at once). `summary` enriches a
 * plain referenced post with its resolved name/body; self-contained embeds ignore it.
 */
export function toSavedEmbedRow(
  it: SavedEmbed,
  summary?: {name?: string; content?: string} | null,
): SavedEmbedRow {
  const selfContained =
    it.kind === 30311 || it.kind === 39000 || it.kind === 31923 || !!it.draftToken || !!it.msgToken;
  const title = it.draftToken
    ? it.name?.trim() || 'Untitled draft'
    : it.msgToken
      ? it.name?.trim() || 'Private post'
      : it.kind === 30311 || it.kind === 39000
        ? it.name?.trim() || 'Saved space'
        : it.kind === 31923
          ? it.name?.trim() || 'Saved event'
          : summary?.name?.trim() || 'Saved post';
  const snippet = selfContained ? '' : decodeNameHeader(summary?.content ?? '').text.replace(/\s+/g, ' ').trim();
  return {
    id: it.id,
    pubkey: it.pubkey,
    label: savedEmbedRowLabel(it),
    title,
    snippet,
    uri: savedEmbedUri(it),
    private: savedEmbedIsPrivate(it),
  };
}

/** Save a reference (no-op if already saved). Returns true if it was newly added. */
export async function saveEmbed(item: Omit<SavedEmbed, 'savedAt'>, savedAt: number): Promise<boolean> {
  await ensureSavedEmbedsLoaded();
  if (_list.some(e => e.id === item.id)) return false;
  const prev = _list;
  _list = [{...item, savedAt}, ...prev].slice(0, MAX);
  try {
    await persist();
  } catch (err) {
    // Revert so the caller's in-memory view (and any re-read of listSavedEmbeds()) matches what's
    // actually on disk, then rethrow so a failed write isn't silently treated as "saved".
    _list = prev;
    throw err;
  }
  return true;
}

/**
 * Save a channel as an embeddable SPACE reference (no-op if already saved). `channel.id` is the
 * `30311:<owner>:<d>` coordinate (matches `Channel.id`), stored verbatim so {@link savedEmbedUri} can
 * split it back apart. Dedupes/caps/reverts exactly like {@link saveEmbed} (this just shapes the item).
 */
export async function saveChannelEmbed(
  channel: {id: string; owner: string; name?: string; gradient?: GradientSpec},
  savedAt: number,
): Promise<boolean> {
  return saveEmbed(
    {id: channel.id, pubkey: channel.owner, kind: 30311, name: channel.name, gradient: channel.gradient, private: false},
    savedAt,
  );
}

/**
 * Save an event as an embeddable reference (no-op if already saved). `coordinate` is the
 * `31923:<host>:<d>` address (the dedupe key); the full `stiq:event:…` token is stored verbatim
 * for re-insertion. Dedupes/caps/reverts exactly like {@link saveEmbed}.
 */
export async function saveEventEmbed(
  ev: {coordinate: string; token: string; title?: string},
  savedAt: number,
): Promise<boolean> {
  return saveEmbed(
    {
      id: ev.coordinate,
      pubkey: ev.coordinate.split(':')[1] ?? '',
      kind: 31923,
      name: ev.title,
      eventToken: ev.token,
    },
    savedAt,
  );
}

/**
 * Save a private group as an embeddable SPACE reference (no-op if already saved). Synthesizes the
 * `39000:<owner>:<groupId>` coordinate as the item id (groups have no native addressable coordinate
 * the way channels do). Dedupes/caps/reverts exactly like {@link saveEmbed}.
 */
export async function saveSpaceEmbed(
  group: {id: string; owner: string; name?: string; gradient?: GradientSpec},
  savedAt: number,
): Promise<boolean> {
  return saveEmbed(
    {
      id: `39000:${group.owner}:${group.id}`,
      pubkey: group.owner,
      kind: 39000,
      name: group.name,
      gradient: group.gradient,
      private: true,
      groupId: group.id,
    },
    savedAt,
  );
}

/**
 * Save a post/message from a PRIVATE channel or group as an embeddable reference (no-op if already
 * saved). Because a private post is stored still-encrypted and can't be re-fetched by id, the caller
 * passes the full self-contained `stiq:msg:…` token (built from the DECRYPTED snapshot it was
 * showing) — stored verbatim, keyed by the source event id. Dedupes/caps/reverts like {@link saveEmbed}.
 */
export async function saveMessageEmbed(
  msg: {id: string; token: string; author: string; kind?: number; name?: string; private?: boolean},
  savedAt: number,
): Promise<boolean> {
  return saveEmbed(
    {id: msg.id, pubkey: msg.author, kind: msg.kind, name: msg.name, private: msg.private ?? true, msgToken: msg.token},
    savedAt,
  );
}

/**
 * Save an unpublished DRAFT as an embeddable reference (no-op if already saved). The full self-contained
 * `stiq:draft:…` token is both the stored payload and the dedupe key (a draft has no published id).
 * Dedupes/caps/reverts exactly like {@link saveEmbed}.
 */
export async function saveDraftEmbed(
  draft: {token: string; title?: string; author?: string},
  savedAt: number,
): Promise<boolean> {
  return saveEmbed(
    {id: draft.token, pubkey: draft.author ?? '', name: draft.title, draftToken: draft.token},
    savedAt,
  );
}

/** Remove a saved reference by id. */
export async function removeEmbed(id: string): Promise<void> {
  await ensureSavedEmbedsLoaded();
  const prev = _list;
  const next = prev.filter(e => e.id !== id);
  if (next.length === prev.length) return;
  _list = next;
  try {
    await persist();
  } catch (err) {
    _list = prev;
    throw err;
  }
}

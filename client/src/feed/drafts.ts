/**
 * Post drafts — autosave / resume / delete (Phase 2).
 *
 * Drafts are stored as JSON in SecureStorage under a single key. This keeps
 * them encrypted at rest without requiring the SQLite native driver in tests.
 * The DraftStore is intentionally kept simple: at most a few dozen drafts.
 */
import {utf8ToBytes} from '@noble/hashes/utils.js';
import type {SecureStorage} from '../keys/keystore';
import {LEGACY_DRAFTS, draftsKey} from '../app/workspaceKeys';
import {sha256Hex} from '../util/hash';
import {randomBytes} from '../util/random';
import {bytesToHex} from '../util/hex';

/**
 * Where a draft belongs (No.7). A draft is either for the main feed, or for composing into a
 * specific channel/group/broadcast/DM. Old drafts (saved before this field existed) have no
 * `location` and are treated as feed drafts.
 */
export type DraftLocation =
  | {kind: 'feed'}
  | {
      kind: 'channel';
      /** The channel/group/peer id the draft composes into. */
      channelId: string;
      channelType: 'public' | 'private' | 'broadcast' | 'dm';
      /** Display name for the drafts list (e.g. "#general", a group title, or a peer handle). */
      channelName: string;
    }
  | {
      /**
       * A comment/reply being composed on a post's thread. Its own variant rather than a reuse of
       * `channel`: a comment is keyed on the ROOT POST, not on a channel, and reusing `channel`
       * would make a comment draft collide with the surrounding channel's single in-progress slot
       * (`inProgressDraftId` keys on channelId) — typing a reply would silently clobber the
       * half-written broadcast sitting in that channel's composer.
       *
       * Only set where the draft can actually be RESUMED — i.e. the feed post thread, which has a
       * proven "open this post by id" path. The channel-post, Log and draft-embed comment surfaces
       * deliberately leave it unset (they keep their previous non-persisting behavior) rather than
       * list a draft that cannot be reopened; see MainScreen's `resume`.
       */
      kind: 'comment';
      /** The root post's event id — what the thread is reopened by. */
      rootId: string;
      /** Display label for the drafts list (the post's title, or a short excerpt of it). */
      rootLabel: string;
    };

export interface Draft {
  id: string;
  title: string;
  content: string;
  tags: string[];
  savedAt: number;
  /**
   * Post-type label (NIP-32 id) chosen in the composer, if any. Articles need one to publish, so the
   * Drafts status chip reads it ("Add a label to publish"). Absent on older drafts / notes.
   */
  label?: string | null;
  /** Where this draft belongs. Absent ⇒ feed (back-compat). */
  location?: DraftLocation;
  /** Content-warning reason, when the author enabled CW. Absent ⇒ no content warning. */
  contentWarning?: string;
  /**
   * The stable, high-entropy id a shared `stiq:draft:` embed carries (Phase 5§B — see
   * `feed/draftAccess.ts`). Generated ONCE, at first share, via {@link newShareId}, and persisted
   * here so every later edit or re-share keeps addressing the SAME access-control doc
   * (`draft-access:<shareId>`) and the SAME comment thread (`buildThread(store, shareId)`) — this
   * is what lets "frozen snapshot per grant, but one unified thread across every place it's
   * shared" hold. Absent until the draft is first shared; a fork (§5E) mints its own fresh id when
   * the forker first shares it themselves, since ownership genuinely changed. Deliberately NOT
   * {@link newDraftId} — that generator is coarse (timestamp + 4 random chars), fine for a private
   * per-device autosave slot nobody else ever addresses, but guessable enough that reusing it here
   * would let an attacker precompute another author's shareId and forge requests/comments against it.
   */
  shareId?: string;
}

/** A short, human label for a draft's location, shown in the unified drafts list. */
export function draftLocationLabel(location?: DraftLocation): string {
  if (!location || location.kind === 'feed') return 'Feed';
  if (location.kind === 'comment') return `${location.rootLabel} · comment`;
  const kindLabel =
    location.channelType === 'public'
      ? 'public channel'
      : location.channelType === 'private'
        ? 'private group'
        : location.channelType === 'broadcast'
          ? 'broadcast'
          : 'DM';
  return `${location.channelName} · ${kindLabel}`;
}

/** Build the stable, per-location draft id used for the in-progress autosave slot (No.7). */
export function inProgressDraftId(location?: DraftLocation): string {
  if (!location || location.kind === 'feed') return 'inprogress:feed';
  // Its own namespace, so a reply being written on a post can never collide with the in-progress
  // slot of a channel that happens to share the id — see DraftLocation's 'comment' variant doc.
  if (location.kind === 'comment') return `inprogress:comment:${location.rootId}`;
  return `inprogress:${location.channelType}:${location.channelId}`;
}

/** Structural draft API so callers (and the lazy App.tsx wrapper) don't depend on the class. */
export interface DraftStoreApi {
  all(): Promise<Draft[]>;
  save(draft: Draft): Promise<void>;
  delete(id: string): Promise<void>;
}

export class DraftStore implements DraftStoreApi {
  /** Storage key — per identity slot (an unsent draft belongs to the identity that wrote it). */
  private key: string;

  constructor(private readonly storage: SecureStorage | null, slotId?: string) {
    this.key = slotId ? draftsKey(slotId) : LEGACY_DRAFTS;
  }

  /** Re-point at a different identity slot (community switch). Drafts are read on demand, so this
   *  only swaps the key — no in-memory state to clear. */
  reload(slotId?: string): void {
    this.key = slotId ? draftsKey(slotId) : LEGACY_DRAFTS;
  }

  async all(): Promise<Draft[]> {
    if (!this.storage) return [];
    try {
      const raw = await this.storage.getItem(this.key);
      if (!raw) return [];
      return JSON.parse(raw) as Draft[];
    } catch {
      return [];
    }
  }

  async save(draft: Draft): Promise<void> {
    if (!this.storage) return;
    const drafts = await this.all();
    const idx = drafts.findIndex(d => d.id === draft.id);
    if (idx >= 0) {
      drafts[idx] = draft;
    } else {
      drafts.push(draft);
    }
    await this.storage.setItem(this.key, JSON.stringify(drafts));
  }

  async delete(id: string): Promise<void> {
    if (!this.storage) return;
    const drafts = await this.all();
    const filtered = drafts.filter(d => d.id !== id);
    await this.storage.setItem(this.key, JSON.stringify(filtered));
  }
}

/** Generate a short unique draft id (timestamp + 4 random chars). */
export function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mint a fresh, high-entropy `shareId` (Phase 5§B) — call this ONCE, at first share, and persist the
 * result on the {@link Draft} (`draft.shareId`) so every subsequent edit/re-share reuses it.
 *
 * Unlike {@link newDraftId} (a coarse, guessable per-device slot id — fine when nothing but this
 * device ever reads it), a shareId is the anchor for a real access-control surface: the
 * `draft-access:<shareId>` grant/revoke doc, every `DraftAccessRequest`/`DraftDelivery`, and the
 * shared comment thread (`buildThread(store, shareId)`). It hashes the author's pubkey + the
 * body + a fresh CSPRNG salt (SHA-256, hex) so it is infeasible to guess or precompute — hashing in
 * the author + body means it is also tied to THIS piece of writing (a coincidental salt collision
 * between two different authors' drafts still can't produce the same id), and the random salt means
 * even the SAME author re-sharing byte-identical content later can't be forced toward a value
 * anyone else could predict ahead of time.
 */
export function newShareId(authorPubkey: string, body: string): string {
  const salt = bytesToHex(randomBytes(16));
  return sha256Hex(utf8ToBytes(`${authorPubkey}:${body.length}:${body}:${salt}`));
}

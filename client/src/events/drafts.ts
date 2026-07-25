/**
 * Event drafts — autosave / resume / delete for the Events surface's Create/Edit builder. Mirrors
 * feed/drafts.ts's DraftStore pattern closely: same SecureStorage backend, same try/catch-only-
 * around-JSON.parse error-handling discipline (a corrupt/missing blob reads back as empty rather than
 * throwing), same upsert-by-id save() / filter-out remove().
 *
 * One deliberate shape difference from feed/drafts.ts: that file's `Draft` IS the stored record
 * (flat — id/title/content/... live directly on it). `EventDraft` (events/types.ts, frozen) has no
 * `updatedAt` or guaranteed `id` of its own — it's `Partial<StiqEvent>`, so `id` is only present once
 * an event is far enough along to carry a real kind-31923 `d` tag. So event drafts wrap the EventDraft
 * in a small `{id, updatedAt, draft}` envelope instead, giving every draft-in-progress a stable list
 * identity and a sort key without touching the frozen EventDraft shape itself.
 */
import type {SecureStorage} from '../keys/keystore';
import type {EventDraft} from './types';

/**
 * Per-identity storage key for the event-drafts store — the same colon-separated key FAMILY as
 * feed/drafts.ts's `draftsKey` (`stiq:drafts:${slotId}`, defined in app/workspaceKeys.ts), namespaced
 * 'events' so it can never collide with feed's own drafts under that key family. (Also distinct from
 * the unrelated `stiq.events.cache.*` / `eventsCacheKey` family in app/workspaceKeys.ts — same English
 * word, different subsystem: that one caches raw relay events, this one is the Events-surface UI
 * draft store.)
 */
export function eventDraftsKey(slotId: string): string {
  return `stiq:drafts:events:${slotId}`;
}

/**
 * One stored event draft. `id` is this entry's stable list identity (independent of anything inside
 * `draft`); `updatedAt` drives recent-first ordering; `draft` is the full (partial) EventDraft as the
 * editor left it.
 */
export interface EventDraftEntry {
  id: string;
  updatedAt: number;
  draft: EventDraft;
}

/** Structural store API (mirrors feed/drafts.ts's DraftStoreApi) so callers don't depend on the class. */
export interface EventDraftStoreApi {
  list(): Promise<EventDraftEntry[]>;
  get(id: string): Promise<EventDraftEntry | null>;
  save(entry: EventDraftEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

export class EventDraftStore implements EventDraftStoreApi {
  /** Storage key — per identity slot (an unpublished event draft belongs to the identity building it,
   *  exactly like feed/drafts.ts's DraftStore). */
  private key: string;

  constructor(private readonly storage: SecureStorage | null, slotId: string) {
    this.key = eventDraftsKey(slotId);
  }

  /** Re-point at a different identity slot (community switch). Entries are read on demand, so this
   *  only swaps the key — no in-memory state to clear. Mirrors feed/drafts.ts's DraftStore.reload. */
  reload(slotId: string): void {
    this.key = eventDraftsKey(slotId);
  }

  private async all(): Promise<EventDraftEntry[]> {
    if (!this.storage) return [];
    try {
      const raw = await this.storage.getItem(this.key);
      if (!raw) return [];
      return JSON.parse(raw) as EventDraftEntry[];
    } catch {
      return [];
    }
  }

  /** All entries, recent-first (updatedAt desc) — the one place this store's ordering deliberately
   *  differs from feed/drafts.ts's DraftStore.all(), which returns raw insertion order. */
  async list(): Promise<EventDraftEntry[]> {
    const entries = await this.all();
    return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<EventDraftEntry | null> {
    const entries = await this.all();
    return entries.find(e => e.id === id) ?? null;
  }

  async save(entry: EventDraftEntry): Promise<void> {
    if (!this.storage) return;
    const entries = await this.all();
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    await this.storage.setItem(this.key, JSON.stringify(entries));
  }

  async remove(id: string): Promise<void> {
    if (!this.storage) return;
    const entries = await this.all();
    const filtered = entries.filter(e => e.id !== id);
    await this.storage.setItem(this.key, JSON.stringify(filtered));
  }
}

/** Generate a short unique event-draft entry id (timestamp + 4 random chars) — same recipe as
 *  feed/drafts.ts's newDraftId. */
export function newEventDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

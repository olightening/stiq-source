/**
 * Gradient identity store — relay-blind, locally-rendered identity gradients.
 *
 * Like the display name ([[displayName]]), a user's gradient rides *inside* the content they author
 * as a control header the relay never interprets; readers strip it and learn `npub → gradient`.
 *
 * A gradient is freely changeable (set initially during onboarding, edited any time from the
 * profile). Because a gradient is NOT a contended namespace — every pubkey owns its own, there is
 * no impersonation concern — the phonebook is **latest-wins**: every device keeps the MOST RECENT
 * gradient it has seen a pubkey author, so when you change yours, peers adopt the new one as soon as
 * they see any newer authored event from you (the same way a changed display name propagates).
 *
 * Every pubkey also has a deterministic `gradientFromSeed(pubkey)` fallback, so a gradient renders
 * for everyone with zero stored state; a custom gradient is transmitted only when one is set.
 */
import type {SecureStorage} from '../keys/keystore';
import {decodeGradient, encodeGradient, isValidGradient, type GradientSpec} from '../media/gradient';
import {
  LEGACY_GRADIENT_SELF,
  LEGACY_GRADIENT_BOOK,
  gradientSelfKey,
  gradientBookKey,
} from '../app/workspaceKeys';

const PERSIST_DEBOUNCE_MS = 1500;

/** One pubkey's gradient claim: the compact wire form + the time it was authored. */
interface GradClaim {
  wire: string;
  at: number; // seconds (authored event created_at)
}

export class GradientStore {
  /** pubkey → most-recently-seen gradient claim. */
  private byPubkey = new Map<string, GradClaim>();
  private myGradient: GradientSpec | null = null;
  private persistTimer?: ReturnType<typeof setTimeout>;
  /** Storage key for MY gradient (per identity slot) and the learned phonebook (per community). */
  private myGradKey: string;
  private bookKey: string;

  constructor(private readonly storage: SecureStorage | null, slotId?: string, cid?: string) {
    this.myGradKey = slotId ? gradientSelfKey(slotId) : LEGACY_GRADIENT_SELF;
    this.bookKey = cid ? gradientBookKey(cid) : LEGACY_GRADIENT_BOOK;
  }

  /**
   * Re-point at a different identity slot + community and reload (community switch). MY gradient is
   * per-slot, the learned gradient phonebook is per-community; both swap together. Pending persist
   * for the outgoing community is flushed first, then in-memory state is cleared.
   */
  async reload(slotId?: string, cid?: string): Promise<void> {
    await this.flush();
    this.byPubkey.clear();
    this.myGradient = null;
    this.myGradKey = slotId ? gradientSelfKey(slotId) : LEGACY_GRADIENT_SELF;
    this.bookKey = cid ? gradientBookKey(cid) : LEGACY_GRADIENT_BOOK;
    await this.load();
  }

  async load(): Promise<void> {
    if (!this.storage) return;
    try {
      const rawSelf = await this.storage.getItem(this.myGradKey);
      if (rawSelf) {
        const parsed = JSON.parse(rawSelf) as unknown;
        if (isValidGradient(parsed)) this.myGradient = parsed;
      }
      const rawBook = await this.storage.getItem(this.bookKey);
      if (rawBook) {
        const obj = JSON.parse(rawBook) as Record<string, GradClaim>;
        for (const [pubkey, claim] of Object.entries(obj)) {
          if (claim && typeof claim.wire === 'string') {
            this.record(pubkey, claim.wire, typeof claim.at === 'number' ? claim.at : 0);
          }
        }
      }
    } catch {
      // start empty on corrupt/absent storage
    }
  }

  /** The viewer's own gradient, or null if they've never set one (→ render the seed default). */
  getMyGradient(): GradientSpec | null {
    return this.myGradient;
  }

  /** Set (or change) the viewer's gradient. Persists immediately; rides the viewer's next content. */
  async setMyGradient(spec: GradientSpec): Promise<boolean> {
    if (!isValidGradient(spec)) return false;
    this.myGradient = spec;
    await this.storage?.setItem(this.myGradKey, JSON.stringify(spec));
    return true;
  }

  /** The custom gradient to render for `pubkey`, or undefined when none is known (→ seed default). */
  gradientFor(pubkey: string): GradientSpec | undefined {
    const claim = this.byPubkey.get(pubkey);
    return claim ? decodeGradient(claim.wire) : undefined;
  }

  /** The compact wire form to embed in the viewer's outgoing content, or '' when using the default. */
  myWire(): string {
    return this.myGradient ? encodeGradient(this.myGradient) : '';
  }

  /**
   * Learn a peer's gradient from an authored event. `claimedAt` is the event's created_at. Keeps the
   * LATEST claim (latest-wins) so a peer's most recent gradient is what everyone renders. Schedules
   * a debounced persist only when something actually changed (in-memory update is immediate).
   */
  async learn(pubkey: string, wire: string, claimedAt?: number): Promise<void> {
    const at = claimedAt ?? Math.floor(Date.now() / 1000);
    if (this.record(pubkey, wire, at)) {
      this.schedulePersist();
    }
  }

  /** In-memory update; returns true if the phonebook changed. */
  private record(pubkey: string, wire: string, at: number): boolean {
    if (!decodeGradient(wire)) return false; // ignore malformed wires
    const prev = this.byPubkey.get(pubkey);
    if (prev) {
      // Latest-wins: only a MORE RECENT sighting replaces the current gradient.
      if (at < prev.at) return false;
      if (at === prev.at && wire === prev.wire) return false;
      prev.at = at;
      prev.wire = wire;
      return true;
    }
    this.byPubkey.set(pubkey, {wire, at});
    return true;
  }

  /** Debounced persist: schedules a save if one isn't already pending. */
  private schedulePersist(): void {
    if (this.persistTimer !== undefined) {
      return; // a persist is already pending; it will capture this change too
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const obj: Record<string, GradClaim> = {};
    for (const [pubkey, claim] of this.byPubkey) obj[pubkey] = claim;
    await this.storage?.setItem(this.bookKey, JSON.stringify(obj));
  }

  /** Ensure any pending persist is flushed immediately (e.g. on shutdown). */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist();
  }
}

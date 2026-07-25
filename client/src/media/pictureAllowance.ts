/**
 * Per-period picture allowance accounting (client-side).
 *
 * The organizer's picture allowance (a byte budget per rolling window) can only be enforced on the
 * client: posts are relay-blind (throwaway per-post signatures), so no server can attribute a
 * member's cumulative picture bytes across a period without breaking blindness. We track the spend
 * locally in SecureStorage, keyed by a rolling window, and reset it when the window rolls over.
 *
 * The live value is mirrored into a module-level accessor so AppRuntime.getSnapshot() can read it
 * synchronously (same pattern as mediaSettings' endpoint mirror), and fed to every composer so the
 * "Add picture" button can disable when a picture would exceed the remaining allowance.
 */
import type {SecureStorage} from '../keys/keystore';
import {LEGACY_PICTURE_SPEND, pictureSpendKey} from '../app/workspaceKeys';

interface Spend {
  windowStart: number;
  spentBytes: number;
}

let mem: Spend = {windowStart: 0, spentBytes: 0};
let periodMs = 24 * 3_600_000;

/** Set the allowance window length (from the organizer's pictureRules.periodHours). */
export function setPicturePeriodHours(hours: number): void {
  periodMs = Math.max(1, hours) * 3_600_000;
}

/** Roll the window forward if it has elapsed; returns true if it reset. */
function roll(now: number): boolean {
  if (mem.windowStart === 0) {
    mem.windowStart = now;
    return false;
  }
  if (now - mem.windowStart >= periodMs) {
    mem = {windowStart: now, spentBytes: 0};
    return true;
  }
  return false;
}

/** Picture token bytes spent in the current window (synchronous; used by the snapshot + composers). */
export function picturesSpentThisPeriod(now: number = Date.now()): number {
  roll(now);
  return mem.spentBytes;
}

/** Set the in-memory spend directly (tests). */
export function setPictureSpendRuntime(spend: Spend): void {
  mem = spend;
}

/**
 * Persistent store for an ACCOUNT's picture spend this period. Owned by AppRuntime; the spend is a
 * per-npub metered budget, so it is namespaced by the active identity slot and RE-LOADED on every
 * community/account switch (not just at init) — otherwise the outgoing account's spend would linger in
 * the module accessor and be attributed to the incoming account. Un-enrolled falls back to the legacy
 * global key.
 */
export class PictureAllowanceStore {
  /** Storage key for the currently-loaded account (repointed by {@link load}). */
  private key: string = LEGACY_PICTURE_SPEND;

  constructor(private readonly storage: SecureStorage | null) {}

  async load(periodHours: number, slotId?: string): Promise<void> {
    setPicturePeriodHours(periodHours);
    this.key = slotId ? pictureSpendKey(slotId) : LEGACY_PICTURE_SPEND;
    // Reset the in-memory spend to a clean default FIRST, so switching to an account with no stored
    // spend can never inherit the previous account's `mem` (cross-account leak).
    mem = {windowStart: 0, spentBytes: 0};
    if (!this.storage) {
      roll(Date.now());
      return;
    }
    try {
      const raw = await this.storage.getItem(this.key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Spend>;
        mem = {
          windowStart: typeof parsed.windowStart === 'number' ? parsed.windowStart : Date.now(),
          spentBytes: typeof parsed.spentBytes === 'number' && parsed.spentBytes >= 0 ? parsed.spentBytes : 0,
        };
      }
    } catch {
      // keep the clean default
    }
    if (roll(Date.now())) await this.persist();
  }

  /** Add `bytes` to this period's spend and persist (call after a picture-bearing post publishes). */
  async add(bytes: number, now: number = Date.now()): Promise<void> {
    if (bytes <= 0) return;
    roll(now);
    mem.spentBytes += bytes;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.storage?.setItem(this.key, JSON.stringify(mem));
  }
}

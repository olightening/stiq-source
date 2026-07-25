/**
 * Duress wipe (PLAN.md §3.5 / Step 11).
 *
 * Entering the duress PIN silently and irrecoverably destroys everything that proves this
 * device was ever configured: the key + membership credential in the secure store, the two
 * PINs, the in-memory session, and the SQLite cache (including DMs). The result is
 * indistinguishable from a fresh install.
 *
 * Every step is best-effort and independent: a failure in one must NOT prevent the others,
 * so the device is left as clean as possible even under partial failure.
 */
export interface DuressTargets {
  /** Secure key + credential + relay binding (Identity.reset). */
  identity: {reset(): Promise<void>};
  /** Standard + duress PIN slots (PinVault.clear). */
  pins: {clear(): Promise<void>};
  /** Cached events incl. DMs (EventStore.clear). */
  cache: {clear(): void};
  /**
   * Persistent cache file, if any: drops the SQLCipher key and deletes the DB file so the
   * (encrypted) events can't be recovered forensically — defense in depth beyond cache.clear().
   */
  cacheFile?: {wipe(): Promise<void>};
  /** In-memory session, if any (SessionManager.clear). */
  session?: {clear(): void};
  /** Any additional persisted state to wipe (e.g. the joined-community list). */
  extra?: () => Promise<void>;
}

export async function performDuressWipe(targets: DuressTargets): Promise<void> {
  try {
    targets.session?.clear();
  } catch {
    /* best effort */
  }
  try {
    await targets.identity.reset();
  } catch {
    /* best effort */
  }
  try {
    await targets.pins.clear();
  } catch {
    /* best effort */
  }
  try {
    targets.cache.clear();
  } catch {
    /* best effort */
  }
  try {
    await targets.cacheFile?.wipe();
  } catch {
    /* best effort */
  }
  try {
    await targets.extra?.();
  } catch {
    /* best effort */
  }
}

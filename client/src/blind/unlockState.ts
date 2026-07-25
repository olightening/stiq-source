/**
 * unlockState — module-global mirror of AppRuntime's per-epoch AUTO-unlock outcome, for synchronous
 * render reads (the same pattern contentKey uses for the in-memory epoch keys: the runtime writes,
 * the hot render path reads without awaiting anything).
 *
 * The members-only feature is deliberately INVISIBLE to a member in good standing: a sealed item
 * triggers a background read-token unlock and re-renders decrypted when the key lands. While that
 * is under way (or backing off a transient Tor failure) the item renders a NEUTRAL loading
 * treatment — nothing that says "locked", because the member is not meant to notice the meter at
 * all. An epoch flips to "unavailable" — the one deliberately user-visible, quiet members-only card
 * — only once it reaches a TERMINAL outcome: either the organizer REFUSES the unlock outright (a
 * read-revoked member), or (2026-07-22 fix) the transient retry ladder exhausts itself with no
 * answer at all, so a dead mailbox or a device that never got a live Tor circuit no longer sits
 * locked FOREVER (prod: 11 sealed posts, 4 organizer answers ever — permanent gray bars). That
 * terminal state is what this module carries to the render layer, reused byte-identically for both
 * causes; see AppRuntime.markEpochTerminal / reviveStuckEpochUnlocks / retryEpochUnlock.
 */
const _unavailable = new Set<number>();

/** Runtime → render: mark whether `epoch`'s unlock has reached a TERMINAL outcome (organizer
 *  refusal or the transient retry ladder exhausted with no answer — see AppRuntime.markEpochTerminal). */
export function setEpochUnlockUnavailable(epoch: number, unavailable: boolean): void {
  if (unavailable) _unavailable.add(epoch);
  else _unavailable.delete(epoch);
}

/** Render-path read: true when `epoch`'s unlock is TERMINAL for this member (organizer refusal or
 *  the transient ladder exhausted) — the one case that renders the quiet members-only card. */
export function isEpochUnlockUnavailable(epoch: number): boolean {
  return _unavailable.has(epoch);
}

/** Clear on community/account switch (a refusal there says nothing about the next community). */
export function clearEpochUnlockDisplay(): void {
  _unavailable.clear();
}

// ── Render → runtime unlock requests ─────────────────────────────────────────────────────────────
// Any surface that meets a sealed body (comment thread, embed card, pinned note, moderation
// snippet…) can request its epoch's background unlock without plumbing a prop chain down to it —
// the runtime registers the single requester (which owns dedup/backoff), latest registration wins.

let _requester: ((epoch: number) => void) | null = null;

/** Runtime wiring: register the auto-unlock entry point (AppRuntime.noteLockedEpochs). */
export function registerEpochUnlockRequester(fn: ((epoch: number) => void) | null): void {
  _requester = fn;
}

/** Ask the runtime to (eventually, deduped) unlock `epoch` in the background. Safe pre-wiring. */
export function requestEpochUnlock(epoch: number): void {
  _requester?.(epoch);
}

// ── Tap-to-retry (terminal `unlockUnavailable` card) ─────────────────────────────────────────────
// A member tapping the quiet members-only card (organizer refusal OR the transient ladder exhausted
// without an answer — see AppRuntime.noteLockedEpochs) resets that epoch's attempt counter/backoff
// and kicks ONE fresh attempt right away, same dedup/backoff machinery as the background path. A
// SEPARATE requester slot from the silent one above: the silent path must never reset a real
// organizer refusal's slow backoff on every card mount, but an explicit tap should.
let _retryRequester: ((epoch: number) => void) | null = null;

/** Runtime wiring: register the tap-to-retry entry point (AppRuntime.retryEpochUnlock). */
export function registerEpochUnlockRetryRequester(fn: ((epoch: number) => void) | null): void {
  _retryRequester = fn;
}

/** Render-path call: the member tapped a terminal members-only card. Safe pre-wiring. */
export function requestEpochUnlockRetry(epoch: number): void {
  _retryRequester?.(epoch);
}

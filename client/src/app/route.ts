/**
 * Top-level screen routing (PLAN.md §3.3, §3.5). Pure decision so it is unit-testable.
 *
 * Order: onboarding gates everything (you can't lock what isn't set up); once enrolled the
 * lock gates the app; otherwise the main feed. The feed itself reads from cache, so it
 * shows regardless of Tor connection (the connection is a banner, not a gate).
 */
import {PIN_LOCK_UI} from '../config';
import type {LockState} from '../lock/autolock';

export type Screen = 'onboarding' | 'lock' | 'feed';

export function resolveScreen(input: {enrolled: boolean; lock: LockState; pinEnabled?: boolean}): Screen {
  if (!input.enrolled) {
    return 'onboarding';
  }
  // The `'lock'` branch is gated on PIN_LOCK_UI (config.ts) FIRST, before any input is consulted:
  // when the PIN UI ships dark there is no LockScreen to route to, so this function must never name
  // it — whatever `lock`/`pinEnabled` say. Reading the flag first rather than folding it into
  // `pinEnabled` is deliberate: `pinEnabled` here is UNTRUSTED for this purpose. It arrives from the
  // live AppSnapshot, whose persisted source defaults to TRUE (lock/pinPrefs.ts) for every member
  // who is on a PIN today, and App.tsx's pre-hydration `INITIAL` snapshot hardcodes
  // `{lock: 'locked', pinEnabled: true}` — so a flag-off build would still be handed `true` here on
  // both paths. Routing an enrolled member to a lock screen they can never dismiss (the Settings
  // toggle that turned it off is gone too) would trap them out of the app permanently.
  //
  // This is the ROUTING half of that guarantee; the runtime half lives in `loadPinEnabled()`
  // (lock/pinPrefs.ts), which stops AppRuntime.getSnapshot withholding the feed behind the same
  // stale `pinEnabled`. Both are needed — see PIN_LOCK_UI's doc comment for why. Flip PIN_LOCK_UI
  // true and this reverts to the pre-flag decision exactly.
  if (PIN_LOCK_UI && input.lock === 'locked' && input.pinEnabled !== false) {
    return 'lock';
  }
  return 'feed';
}

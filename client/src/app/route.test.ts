/**
 * resolveScreen — with the PIN lock UI shipped DARK (PIN_LOCK_UI false, config.ts — the committed
 * default; bugs 5+6). The mirror file route.pinLockOn.test.ts pins the same function with the flag
 * ON and is what proves flipping it back restores today's routing.
 *
 * The 'lock' branch is unreachable here, and the tests below are deliberately blunt about WHY that
 * has to hold for inputs that still say "locked": with no LockScreen and no Settings toggle in the
 * build, an enrolled member routed to 'lock' could never leave it. See PIN_LOCK_UI's doc comment.
 */
import {resolveScreen} from './route';

describe('resolveScreen (PIN lock UI dark)', () => {
  it('shows onboarding until enrolled (even if locked)', () => {
    expect(resolveScreen({enrolled: false, lock: 'unlocked'})).toBe('onboarding');
    expect(resolveScreen({enrolled: false, lock: 'locked'})).toBe('onboarding');
  });

  it('shows the feed when enrolled and unlocked', () => {
    expect(resolveScreen({enrolled: true, lock: 'unlocked'})).toBe('feed');
  });

  it('NEVER returns lock — not even for an enrolled+locked app', () => {
    expect(resolveScreen({enrolled: true, lock: 'locked'})).toBe('feed');
  });

  it('NEVER returns lock for a member carrying a persisted pinEnabled=true (the trap)', () => {
    // The regression this pins: `stiq.lock.pinEnabled` (AsyncStorage) defaults to TRUE and is
    // persisted, so every member who is on a PIN today still reads back `true` after this flag
    // lands — and a cold start always constructs AutoLock 'locked'. If this returned 'lock' they
    // would face a lock screen forever: the Settings toggle that switches it off is gone, and
    // nothing but the (now unrouteable) LockScreen ever unlocks AutoLock.
    expect(resolveScreen({enrolled: true, lock: 'locked', pinEnabled: true})).toBe('feed');
  });

  it('NEVER returns lock for App.tsx’s pre-hydration INITIAL snapshot', () => {
    // App.tsx's INITIAL hardcodes {lock: 'locked', pinEnabled: true}; an enrolled member is routed
    // through it for the frames between mount and the runtime's first emit.
    expect(resolveScreen({enrolled: true, lock: 'locked', pinEnabled: true})).toBe('feed');
  });

  it('still honours an explicitly disabled PIN (unchanged by the flag)', () => {
    expect(resolveScreen({enrolled: true, lock: 'locked', pinEnabled: false})).toBe('feed');
  });
});

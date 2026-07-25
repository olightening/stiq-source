/**
 * resolveScreen — with the PIN lock UI RESTORED (PIN_LOCK_UI true).
 *
 * The ship-dark contract for bugs 5+6 is "flip one flag and today's PIN behaviour comes back
 * byte-identically". This file is the proof for the routing half: every assertion below is the
 * pre-flag route.test.ts verbatim, and it passes against the same `resolveScreen` the dark build
 * ships — only the flag differs. Its mirror (route.test.ts) pins the dark side.
 *
 * The flag is mocked at module level rather than via jest.resetModules() + a dynamic require,
 * matching the house pattern (see MainScreen.authorNote.off/on.test.tsx). `requireActual` is spread
 * first so every OTHER config value stays real — this overrides one const, it does not stub config.
 */
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  PIN_LOCK_UI: true,
}));

import {resolveScreen} from './route';

describe('resolveScreen (PIN lock UI restored)', () => {
  it('shows onboarding until enrolled (even if locked)', () => {
    expect(resolveScreen({enrolled: false, lock: 'unlocked'})).toBe('onboarding');
    expect(resolveScreen({enrolled: false, lock: 'locked'})).toBe('onboarding');
  });

  it('locks an enrolled app until unlocked', () => {
    expect(resolveScreen({enrolled: true, lock: 'locked'})).toBe('lock');
  });

  it('shows the feed when enrolled and unlocked', () => {
    expect(resolveScreen({enrolled: true, lock: 'unlocked'})).toBe('feed');
  });

  it('locks an enrolled+locked app whose member left the PIN on', () => {
    expect(resolveScreen({enrolled: true, lock: 'locked', pinEnabled: true})).toBe('lock');
  });

  it('routes an opted-out member (pinEnabled=false) straight to the feed', () => {
    expect(resolveScreen({enrolled: true, lock: 'locked', pinEnabled: false})).toBe('feed');
  });
});

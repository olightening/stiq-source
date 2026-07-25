/**
 * PIN lock shipped dark (PIN_LOCK_UI false — config.ts, bugs 5+6): the RUNTIME contract.
 *
 * Deliberately does NOT mock config — these run against the real, shipped flag value. The mirror is
 * AppRuntime.test.ts, which forces PIN_LOCK_UI on and whose whole (unchanged) lock/duress/pre-warm
 * suite still passes; between them they pin the feature both ways.
 *
 * The reason this file exists rather than a route-level test alone: hiding the lock SCREEN is not
 * enough. `stiq.lock.pinEnabled` (AsyncStorage) is persisted and defaults to TRUE, and two things in
 * AppRuntime key off it — getSnapshot's heavy-build gate (`lock === 'locked' && this.pinEnabled`)
 * and lock(). A cold start always constructs AutoLock 'locked', and the ONLY things that ever call
 * autolock.unlock() are lock/controller.ts (i.e. the LockScreen) and enrollment. So a member who is
 * on a PIN today, in a build with no lock screen to unlock with, would have been routed to the feed
 * and handed an EMPTY one — forever, with no way out. That is the trap these tests exist to catch.
 */
import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {PinVault} from '../lock/pin';
import {loadPinEnabled, savePinEnabled} from '../lock/pinPrefs';
import {resolveScreen} from './route';
import {Kind} from '../nostr/events';
import type {Session} from '../onboarding/enrollment';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const PIN_ENABLED_KEY = 'stiq.lock.pinEnabled';

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(secure: InMemorySecureStorage, store: InMemoryEventStore) {
  return new AppRuntime({
    secureStorage: secure,
    store,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
}

function cachedPost(content: string) {
  return finalizeEvent(
    {kind: Kind.Post, created_at: 900, tags: [], content},
    generateSecretKey(),
  );
}

describe('PIN lock dark — an existing PIN-enabled member is not trapped', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.removeItem(PIN_ENABLED_KEY);
  });
  afterEach(() => jest.useRealTimers());

  it('loadPinEnabled reports the effective preference (false) even with true persisted', async () => {
    await AsyncStorage.setItem(PIN_ENABLED_KEY, 'true');
    expect(await loadPinEnabled()).toBe(false);
  });

  it('leaves the member’s persisted choice untouched, so flipping the flag back restores it', async () => {
    // The load is gated; the WRITE is not. Nothing calls savePinEnabled while the toggle is hidden,
    // so whatever each member actually chose is still on disk, verbatim, for a flag-on build to read.
    await AsyncStorage.setItem(PIN_ENABLED_KEY, 'true');
    expect(await loadPinEnabled()).toBe(false); // effective
    expect(await AsyncStorage.getItem(PIN_ENABLED_KEY)).toBe('true'); // persisted, unchanged

    await savePinEnabled(false);
    expect(await AsyncStorage.getItem(PIN_ENABLED_KEY)).toBe('false'); // still writes through
  });

  it('cold-starts an enrolled member with a real PIN + pinEnabled=true straight into a REAL feed', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore(); // shared across the "relaunch" — stands in for the cache

    // Session 1 — a member as they exist TODAY: enrolled, a real 4-digit PIN sealed, lock screen on.
    const rt1 = newRuntime(secure, store);
    await rt1.init();
    await rt1.completeEnrollment(await makeSession(), '1234', '9999');
    await AsyncStorage.setItem(PIN_ENABLED_KEY, 'true'); // exactly what their device has persisted
    store.save(cachedPost('their-cached-history'));
    rt1.dispose();
    expect(await new PinVault(secure, identityHash).isConfigured()).toBe(true); // they DO have a PIN

    // Session 2 — the same device, now running a build with the PIN UI dark. AutoLock constructs
    // 'locked' as it always does, and nothing in this build can ever unlock it.
    const rt2 = newRuntime(secure, store);
    await rt2.init();
    expect(rt2.getSnapshot().lock).toBe('locked'); // precondition: the trap's setup is real

    // Routing: they reach the app, not a lock screen they could never dismiss.
    expect(resolveScreen(rt2.getSnapshot())).toBe('feed');
    expect(rt2.getSnapshot().pinEnabled).toBe(false);

    // …and the app they reach is the REAL one. This is the half a route-only fix would have missed:
    // getSnapshot's heavy gate would still have withheld every store-derived field behind that
    // stale 'locked', leaving them on a permanently empty feed.
    await jest.runOnlyPendingTimersAsync(); // let the deferred heavy build land
    expect(rt2.getSnapshot().feed.items.some(i => i.content === 'their-cached-history')).toBe(true);
    rt2.dispose();
  });

  it('never re-locks a live session — lock() is inert while the PIN UI is dark', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore();
    const rt = newRuntime(secure, store);
    await rt.init();
    await rt.completeEnrollment(await makeSession(), '1234', '9999');
    store.save(cachedPost('still-here'));
    await jest.runOnlyPendingTimersAsync();

    rt.lock(); // e.g. any surviving caller; App.tsx's background trigger is gated separately (slot G)
    expect(resolveScreen(rt.getSnapshot())).toBe('feed');
    expect(rt.getSnapshot().feed.items.some(i => i.content === 'still-here')).toBe(true);
    rt.dispose();
  });
});

describe('PIN lock dark — a fresh enrollment with no PIN', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.removeItem(PIN_ENABLED_KEY);
  });
  afterEach(() => jest.useRealTimers());

  it('completes enrollment and lands in the feed when onboarding supplies no PIN', async () => {
    const secure = new InMemorySecureStorage();
    const store = new InMemoryEventStore();
    const rt = newRuntime(secure, store);
    await rt.init();

    // What OnboardingScreen sends once its PIN step is skipped (see stepAfterIdentity).
    await rt.completeEnrollment(await makeSession(), '', '');

    expect(rt.getSnapshot().enrolled).toBe(true);
    expect(resolveScreen(rt.getSnapshot())).toBe('feed'); // never half-enrolled, never lockable
    rt.dispose();
  });

  it('seals NOTHING — an unchosen PIN must not become an empty-string unlock credential', async () => {
    const secure = new InMemorySecureStorage();
    const rt = newRuntime(secure, new InMemoryEventStore());
    await rt.init();
    await rt.completeEnrollment(await makeSession(), '', '');

    // Without completeEnrollment's `standardPin &&` guard this would be `true`: setPins('') would
    // have sealed the EMPTY STRING into the keystore as this device's real unlock PIN, which
    // verify('') would then classify as 'standard'. `false` is both the truthful state and the
    // recoverable one — it is the signal a future re-enablement needs to tell "never had a PIN"
    // (→ prompt to set one) apart from "has a PIN".
    const vault = new PinVault(secure, identityHash);
    expect(await vault.isConfigured()).toBe(false);
    expect(await vault.verify('')).toBe('invalid');
    rt.dispose();
  });

  it('still seals a real PIN when onboarding supplies one (the guard is emptiness, not enrollment)', async () => {
    const secure = new InMemorySecureStorage();
    const rt = newRuntime(secure, new InMemoryEventStore());
    await rt.init();
    await rt.completeEnrollment(await makeSession(), '1234', '9999');

    // Byte-identical to before the flag: with PIN_LOCK_UI on, onboarding always passes a real PIN,
    // and the vault — including its duress slot — is configured exactly as it always was.
    const vault = new PinVault(secure, identityHash);
    expect(await vault.isConfigured()).toBe(true);
    expect(await vault.verify('1234')).toBe('standard');
    expect(await vault.verify('9999')).toBe('duress'); // the coercion defence is untouched
    rt.dispose();
  });
});

/**
 * T15-S2 — send-jitter wiring in AppRuntime.deliver().
 *
 * The timing-correlation defense delays ONLY the network wire send, never the optimistic UI render:
 * publishOptimistic's store.save + outbox.add (the 'sending' badge) happen synchronously, and the
 * bounded jitter is awaited as the first statement inside deliver()'s try — so with TIMING_JITTER on
 * (default) deps.publish is not called for the write until the jitter timer elapses, and with the
 * kill-switch off it fires immediately. The pure sendJitterMs policy is unit-tested separately in
 * ../timing/sendJitter.test.ts.
 *
 * Delivery counts are filtered by the POST's event id so the enrollment/binding publishes that fire
 * during setup (a different id) never skew the assertions — mirroring optimistic.test.ts.
 */
import * as sendJitterModule from '../timing/sendJitter';
import {SEND_JITTER_MAX_MS} from '../timing/sendJitter';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import type {Session} from '../onboarding/enrollment';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) {
    throw new Error('enrollment failed in setup');
  }
  return result.session;
}

describe('AppRuntime send jitter — TIMING_JITTER default-on', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders optimistically now but defers the wire send behind the bounded jitter timer', async () => {
    // Pin the jitter draw to its max so the timer boundary is deterministic (and stays under the
    // separate 1500ms confirm-linger removal timer that fires only AFTER delivery completes).
    jest.spyOn(sendJitterModule, 'sendJitterMs').mockReturnValue(SEND_JITTER_MAX_MS);

    const published: string[] = [];
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store: new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async event => {
        published.push(event.id);
        return {accepted: true, message: 'ok'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');

    jest.useFakeTimers();

    // Optimistic render is synchronous (store.save + outbox.add in publishOptimistic, BEFORE deliver's
    // jitter) so the post appears immediately with a 'sending' badge…
    await runtime.post('jittered', []);
    const item = runtime.getSnapshot().feed.items.find(i => i.content === 'jittered');
    expect(item).toBeDefined();
    expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('sending');
    const postSends = () => published.filter(id => id === item!.id).length;
    // …but the post's wire send has NOT been issued: it is still inside the jitter window.
    expect(postSends()).toBe(0);

    // One ms short of the bound: still deferred.
    await jest.advanceTimersByTimeAsync(SEND_JITTER_MAX_MS - 1);
    expect(postSends()).toBe(0);

    // Crossing the bound releases the deferred send; markAccepted → confirmDelivery then run.
    await jest.advanceTimersByTimeAsync(1);
    expect(postSends()).toBe(1);
    expect(runtime.getSnapshot().sendStatus.get(item!.id)).toBe('confirmed');

    runtime.dispose();
  });
});

describe('AppRuntime send jitter — TIMING_JITTER=false kill-switch', () => {
  afterEach(() => {
    jest.dontMock('../config');
    jest.resetModules();
    jest.useRealTimers();
  });

  it('issues the wire send immediately (no timer) when jitter is disabled', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../config', () => ({
        ...jest.requireActual('../config'),
        TIMING_JITTER: false,
      }));
      // Re-require AppRuntime (and its collaborators) against the mocked config in the isolated registry.
      const {AppRuntime: RT} = require('./AppRuntime') as typeof import('./AppRuntime');
      const {InMemorySecureStorage: ISS} =
        require('../keys/keystore') as typeof import('../keys/keystore');
      const {InMemoryEventStore: IES} = require('../nostr/store') as typeof import('../nostr/store');
      const {Enrollment: Enr} =
        require('../onboarding/enrollment') as typeof import('../onboarding/enrollment');
      const {MockBlindRsa: MBR} =
        require('../onboarding/blindrsa') as typeof import('../onboarding/blindrsa');

      const published: string[] = [];
      const runtime = new RT({
        secureStorage: new ISS(),
        store: new IES(),
        hash: identityHash,
        autoLockMs: 60_000,
        publish: async event => {
          published.push(event.id);
          return {accepted: true, message: 'ok'};
        },
      });
      await runtime.init();
      const {enrollment} = await Enr.begin(community, new MBR(), 'STIQ-TEST-0001');
      const res = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
      if (!res.ok) {
        throw new Error('enrollment failed in setup');
      }
      await runtime.completeEnrollment(res.session, '1234', '9999');
      await runtime.submitPin('1234');

      // No fake timers, no advance: with jitter off the post's send happens on the next microtask tick.
      await runtime.post('no jitter', []);
      await new Promise(r => setTimeout(r, 0));
      const item = runtime.getSnapshot().feed.items.find(i => i.content === 'no jitter');
      expect(item).toBeDefined();
      expect(published.filter(id => id === item!.id).length).toBe(1);

      runtime.dispose();
    });
  });
});

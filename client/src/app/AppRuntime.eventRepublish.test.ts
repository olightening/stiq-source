/**
 * Host republish sweep (2026-07-21 incident fix) — kind-31923 event docs are addressable, so the
 * normal outbox retry-on-reconnect path (drainPendingPosts / outbox.unsent()) never covers a doc
 * that was rejected or otherwise never landed on the relay: publishOptimistic fires the write and
 * moves on, and nothing about an addressable doc sits "unsent" waiting on a reconnect the way a
 * regular post does. republishMyEventDocs() (AppRuntime.ts) closes that gap: every event *I host*
 * that is no longer a draft gets republished (a) on relay (re)connect (onRelayConnected) and (b)
 * when the host opens the events management surface (App.tsx's `republishMine` facade method) —
 * throttled to once per connect cycle since 31923 is addressable (idempotent) and a relay-existence
 * check isn't worth building.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {KIND_EVENT} from '../contracts';
import type {EventDraft} from '../events/types';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime() {
  const secure = new InMemorySecureStorage();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
  });
  return {runtime, secure, published};
}

async function enrolled() {
  const h = newRuntime();
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  return h;
}

/** Drain the fire-and-forget promise chains republishMyEventDocs/onRelayConnected fan out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const draftOf = (title: string): EventDraft => ({
  isDraft: false,
  hidden: {},
  title,
  type: 'inperson',
  recurrence: 'none',
  waitlistEnabled: false,
});

const eventDocsFor = (published: Event[], d: string): Event[] =>
  published.filter(e => e.kind === KIND_EVENT && e.tags.some(t => t[0] === 'd' && t[1] === d));

describe('republishMyEventDocs — the host republish sweep', () => {
  it('republishes an event I host on relay (re)connect (onRelayConnected)', async () => {
    const {runtime, published} = await enrolled();
    const coordinate = await runtime.publishEvent(draftOf('Rooftop meetup'));
    expect(coordinate).not.toBeNull();
    const d = coordinate!.split(':')[2]!;
    expect(eventDocsFor(published, d)).toHaveLength(1); // the original publish

    published.length = 0; // isolate the sweep's own re-send
    await runtime.onRelayConnected();
    await flush();

    expect(eventDocsFor(published, d)).toHaveLength(1);
  });

  it('does NOT republish a draft that was never published (isDraft still true)', async () => {
    const {runtime, published} = await enrolled();
    // A draft saved by the editor's autosave, never published — no `d` tag was ever coined for it
    // by publishEvent, so it has no coordinate and must never appear on the wire.
    await runtime.eventDrafts.save({
      id: 'unpublished-1',
      updatedAt: Date.now(),
      draft: {...draftOf('Still drafting'), isDraft: true},
    });

    await runtime.onRelayConnected();
    await flush();

    expect(published.filter(e => e.kind === KIND_EVENT)).toHaveLength(0);
  });

  it('republishes only the non-draft entries when both a live event and a draft exist', async () => {
    const {runtime, published} = await enrolled();
    const coordinate = await runtime.publishEvent(draftOf('Live event'));
    const d = coordinate!.split(':')[2]!;
    await runtime.eventDrafts.save({
      id: 'unpublished-2',
      updatedAt: Date.now(),
      draft: {...draftOf('Still drafting'), isDraft: true},
    });

    published.length = 0;
    await runtime.onRelayConnected();
    await flush();

    const eventDocs = published.filter(e => e.kind === KIND_EVENT);
    expect(eventDocs).toHaveLength(1);
    expect(eventDocs[0]!.tags).toContainEqual(['d', d]);
  });

  it('throttles repeated sweeps — a second reconnect moments later does not re-send', async () => {
    const {runtime, published} = await enrolled();
    const coordinate = await runtime.publishEvent(draftOf('Rooftop meetup'));
    const d = coordinate!.split(':')[2]!;

    published.length = 0;
    await runtime.onRelayConnected();
    await flush();
    expect(eventDocsFor(published, d)).toHaveLength(1);

    published.length = 0;
    await runtime.onRelayConnected(); // same connect cycle — throttled
    await flush();
    expect(eventDocsFor(published, d)).toHaveLength(0);
  });

  it('the events-management-surface trigger (republishMyEventDocs, force) re-sends even inside the throttle window', async () => {
    const {runtime, published} = await enrolled();
    const coordinate = await runtime.publishEvent(draftOf('Rooftop meetup'));
    const d = coordinate!.split(':')[2]!;

    published.length = 0;
    await runtime.onRelayConnected();
    await flush();
    expect(eventDocsFor(published, d)).toHaveLength(1);

    // Opening the events management surface right after a reconnect still self-heals immediately
    // (App.tsx's republishMine facade calls this with no throttle bypass in production, but the
    // underlying sweep itself must be reachable/forceable — this proves the mechanism works).
    published.length = 0;
    await runtime.republishMyEventDocs(true);
    await flush();
    expect(eventDocsFor(published, d)).toHaveLength(1);
  });

  it('is a no-op before enrollment / without an identity (never throws)', async () => {
    const {runtime} = newRuntime();
    await expect(runtime.republishMyEventDocs()).resolves.toBeUndefined();
  });
});

import {Outbox} from './outbox';
import {InMemorySecureStorage} from '../keys/keystore';
import type {Event} from 'nostr-tools/pure';

function evt(id: string): Event {
  return {id, pubkey: 'p', created_at: 1, kind: 1, tags: [], content: '', sig: 's'} as Event;
}

describe('Outbox', () => {
  it('tracks sending → accepted → confirmed, and confirmed drops out of the retry set', async () => {
    const box = new Outbox();
    await box.add(evt('a'));
    expect(box.statuses().get('a')).toBe('sending');
    expect(box.unsent().map(e => e.id)).toEqual(['a']);

    await box.markAccepted('a');
    expect(box.statuses().get('a')).toBe('accepted');
    expect(box.unsent().map(e => e.id)).toEqual(['a']); // not delivered until echoed

    await box.markConfirmed('a');
    expect(box.statuses().get('a')).toBe('confirmed');
    expect(box.unsent()).toEqual([]); // delivered — no longer retried

    await box.remove('a');
    expect(box.has('a')).toBe(false);
    expect(box.statuses().size).toBe(0);
  });

  it('marks failures and keeps them for retry', async () => {
    const box = new Outbox();
    await box.add(evt('a'));
    await box.markFailed('a');
    expect(box.statuses().get('a')).toBe('failed');
    expect(box.unsent().map(e => e.id)).toEqual(['a']); // still retryable
  });

  it('persists across a reload (crash recovery)', async () => {
    const storage = new InMemorySecureStorage();
    const box = new Outbox(storage);
    await box.add(evt('a'));
    await box.markFailed('a');

    const reloaded = new Outbox(storage);
    await reloaded.load();
    expect(reloaded.statuses().get('a')).toBe('failed');
    expect(reloaded.unsent().map(e => e.id)).toEqual(['a']);
  });

  it('treats a relay rejection as terminal: kept + reason exposed, but dropped from the retry set', async () => {
    const box = new Outbox();
    await box.add(evt('a'));
    await box.markRejected('a', 'blocked: rejected');

    // Status flips to 'rejected' and the reason is surfaced for the UI…
    expect(box.statuses().get('a')).toBe('rejected');
    expect(box.reasons().get('a')).toBe('blocked: rejected');
    // …the entry is KEPT (optimistic copy + failed/Retry/Cancel still render)…
    expect(box.has('a')).toBe(true);
    expect(box.eventFor('a')?.id).toBe('a'); // still retrievable for a manual retry
    // …but it is EXCLUDED from the auto-resend set, so reconnect never re-uploads it.
    expect(box.unsent()).toEqual([]);
  });

  it('only exposes reasons for rejected entries, and persists the reason across a reload', async () => {
    const storage = new InMemorySecureStorage();
    const box = new Outbox(storage);
    await box.add(evt('a')); // still sending — no reason
    await box.add(evt('b'));
    await box.markRejected('b', 'pow: difficulty 20 required');
    expect([...box.reasons().keys()]).toEqual(['b']);

    const reloaded = new Outbox(storage);
    await reloaded.load();
    expect(reloaded.statuses().get('b')).toBe('rejected');
    expect(reloaded.reasons().get('b')).toBe('pow: difficulty 20 required');
    expect(reloaded.unsent().map(e => e.id)).toEqual(['a']); // rejected 'b' not re-sent; 'a' still is
  });

  // M7: render-only "queued offline" hint (distinguishes "Queued — connecting…" from "Sending…").
  it('queuedOfflineIds() tracks the offline hint on markSending, independent of status transitions', async () => {
    const box = new Outbox();
    await box.add(evt('a')); // fresh send — actively in flight, not queued
    expect(box.statuses().get('a')).toBe('sending');
    expect(box.queuedOfflineIds().has('a')).toBe(false);

    // deliver() found the relay offline: still 'sending', but now a pre-connect queue.
    await box.markSending('a', true);
    expect(box.statuses().get('a')).toBe('sending'); // status unchanged
    expect(box.queuedOfflineIds().has('a')).toBe(true);

    // A later resend attempt without offline reverts the hint (still just a render hint).
    await box.markSending('a', false);
    expect(box.queuedOfflineIds().has('a')).toBe(false);

    // Leaving 'sending' entirely (e.g. accepted) drops it out of the offline set regardless of the
    // last-recorded flag.
    await box.markSending('a', true);
    await box.markAccepted('a');
    expect(box.queuedOfflineIds().has('a')).toBe(false);
  });

  // P2-2 / C2: statuses()/reasons()/queuedOfflineIds() must return the SAME object across back-to-
  // back calls with no intervening mutation, so a consumer keying re-render on identity (FeedList's
  // renderItem) doesn't churn on an unrelated emit — and must return a NEW object once a real
  // mutation lands, so the UI still updates promptly.
  it('caches statuses()/reasons()/queuedOfflineIds() by mutation version: stable identity when unchanged, fresh after a real mutation', async () => {
    const box = new Outbox();
    await box.add(evt('a'));
    await box.markRejected('a', 'blocked: rejected');
    await box.add(evt('b'));
    await box.markSending('b', true);

    const statuses1 = box.statuses();
    const reasons1 = box.reasons();
    const offline1 = box.queuedOfflineIds();
    const version1 = box.version();

    // Repeated calls with no mutation in between → same instances, same version.
    expect(box.statuses()).toBe(statuses1);
    expect(box.reasons()).toBe(reasons1);
    expect(box.queuedOfflineIds()).toBe(offline1);
    expect(box.version()).toBe(version1);

    // A call that changes nothing (status already 'rejected' with the same reason) must NOT bump the
    // version or invalidate the cache — mirrors the existing no-op guards on setStatus/markRejected.
    await box.markRejected('a', 'blocked: rejected');
    expect(box.version()).toBe(version1);
    expect(box.statuses()).toBe(statuses1);

    // A genuine mutation (new status) bumps the version and rebuilds — new instance, updated content.
    await box.markAccepted('b');
    expect(box.version()).not.toBe(version1);
    const statuses2 = box.statuses();
    expect(statuses2).not.toBe(statuses1);
    expect(statuses2.get('b')).toBe('accepted');
    // The offline hint changed too (accepted leaves the offline-queued set) — also a new instance.
    const offline2 = box.queuedOfflineIds();
    expect(offline2).not.toBe(offline1);
    expect(offline2.has('b')).toBe(false);
    // reasons() didn't change ('a' is still rejected with the same reason) — but the cache was built
    // fresh anyway since the shared version counter advanced; contents must still be correct.
    expect(box.reasons().get('a')).toBe('blocked: rejected');
  });
});

import {generateSecretKey} from 'nostr-tools/pure';
import {performDuressWipe} from './duress';
import {PinVault} from './pin';
import {Identity} from '../keys/identity';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const ONION = `ws://${'a'.repeat(56)}.onion`;
const credential = {token: new Uint8Array([1, 2, 3]), signature: new Uint8Array([4, 5, 6])};

function post(id: string): Event {
  return {id, pubkey: 'p', created_at: 1, kind: 1, tags: [], content: '', sig: 's'};
}

describe('performDuressWipe', () => {
  it('irrecoverably wipes key, credential, PINs, cache, and session', async () => {
    // A fully configured device, key + PINs in ONE secure store (as on-device).
    const secure = new InMemorySecureStorage();
    const identity = new Identity(secure);
    await identity.enroll(generateSecretKey(), ONION, credential);

    const pins = new PinVault(secure, identityHash);
    await pins.setPins('1234', '9999');

    const cache = new InMemoryEventStore();
    cache.save(post('a'));
    cache.save(post('b'));

    const session = {clear: jest.fn()};

    await performDuressWipe({identity, pins, cache, session});

    // In-memory session scrubbed.
    expect(session.clear).toHaveBeenCalled();
    // Everything gone on this instance.
    expect(await identity.isEnrolled()).toBe(false);
    expect(await identity.credential()).toBeNull();
    expect(await pins.isConfigured()).toBe(false);
    expect(cache.size()).toBe(0);

    // The key is truly gone from the SECURE STORE, not just this instance: a fresh Identity
    // over the same storage is unconfigured and cannot sign.
    const reopened = new Identity(secure);
    expect(await reopened.isEnrolled()).toBe(false);
    await expect(
      reopened.sign({kind: 1, created_at: 1, tags: [], content: 'x'}),
    ).rejects.toThrow(/no key enrolled/);
  });

  it('wipes the persistent cache file (key + DB) when present', async () => {
    const cache = new InMemoryEventStore();
    const identity = {reset: jest.fn(async () => undefined)};
    const pins = {clear: jest.fn(async () => undefined)};
    const cacheFile = {wipe: jest.fn(async () => undefined)};

    await performDuressWipe({identity, pins, cache, cacheFile});

    expect(cacheFile.wipe).toHaveBeenCalled();
  });

  it('completes the other wipes even if one target throws', async () => {
    const cache = new InMemoryEventStore();
    cache.save(post('a'));
    const identity = {reset: async () => Promise.reject(new Error('keystore unavailable'))};
    const pins = {clear: jest.fn(async () => undefined)};
    // cacheFile.wipe rejects — must not prevent the cache clear below.
    const cacheFile = {wipe: jest.fn(async () => Promise.reject(new Error('fs busy')))};

    await performDuressWipe({identity, pins, cache, cacheFile});

    expect(pins.clear).toHaveBeenCalled(); // ran despite identity.reset throwing
    expect(cache.size()).toBe(0);
    expect(cacheFile.wipe).toHaveBeenCalled();
  });
});

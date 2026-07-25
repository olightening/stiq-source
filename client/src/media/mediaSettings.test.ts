import {
  MediaSettingsStore,
  getBlossomEndpoint,
  normalizeEndpoint,
  setBlossomEndpointRuntime,
  validateEndpoint,
} from './mediaSettings';
import type {SecureStorage} from '../keys/keystore';

function fakeStorage(initial: Record<string, string> = {}): SecureStorage & {data: Record<string, string>} {
  const data: Record<string, string> = {...initial};
  return {
    data,
    getItem: async (k: string) => (k in data ? data[k]! : null),
    setItem: async (k: string, v: string) => { data[k] = v; },
    removeItem: async (k: string) => { delete data[k]; },
  } as SecureStorage & {data: Record<string, string>};
}

describe('normalizeEndpoint', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeEndpoint('  https://h.onion/  ')).toBe('https://h.onion');
    expect(normalizeEndpoint('https://h.onion///')).toBe('https://h.onion');
  });
  it('returns empty for blank input', () => {
    expect(normalizeEndpoint('   ')).toBe('');
    expect(normalizeEndpoint('')).toBe('');
  });
});

describe('validateEndpoint', () => {
  it('treats empty as valid-but-disabled', () => {
    const v = validateEndpoint('');
    expect(v).toMatchObject({valid: true, kind: 'empty'});
  });
  it('flags a non-http scheme as invalid', () => {
    expect(validateEndpoint('ftp://x.onion').valid).toBe(false);
    expect(validateEndpoint('not a url').kind).toBe('invalid');
  });
  it('classifies onion vs clearnet', () => {
    expect(validateEndpoint('http://abc.onion').kind).toBe('onion');
    expect(validateEndpoint('https://blossom.example.com').kind).toBe('clearnet');
  });
});

describe('MediaSettingsStore', () => {
  it('load() applies the persisted endpoint to the live accessor', async () => {
    const store = new MediaSettingsStore(fakeStorage({'stiq.media.blossomEndpoint': 'https://h.onion'}));
    await store.load();
    expect(getBlossomEndpoint()).toBe('https://h.onion');
    expect(store.getEndpoint()).toBe('https://h.onion');
  });

  it('setEndpoint() normalizes, updates the accessor, and persists', async () => {
    const storage = fakeStorage();
    const store = new MediaSettingsStore(storage);
    await store.setEndpoint('  https://h.onion/  ');
    expect(getBlossomEndpoint()).toBe('https://h.onion');
    expect(storage.data['stiq.media.blossomEndpoint']).toBe('https://h.onion');
  });

  it('empty input clears the endpoint (uploads disabled)', async () => {
    const storage = fakeStorage({'stiq.media.blossomEndpoint': 'https://h.onion'});
    const store = new MediaSettingsStore(storage);
    await store.load();
    await store.setEndpoint('');
    expect(getBlossomEndpoint()).toBe('');
    expect(storage.data['stiq.media.blossomEndpoint']).toBe('');
  });

  afterAll(() => setBlossomEndpointRuntime(''));
});

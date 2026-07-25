import {InMemorySecureStorage} from '../keys/keystore';
import {
  BrowserSettingsStore,
  getPreferredBrowser,
  setPreferredBrowserRuntime,
} from './browserSettings';

describe('BrowserSettingsStore', () => {
  beforeEach(() => setPreferredBrowserRuntime(''));

  it('defaults to empty when nothing is persisted', async () => {
    const store = new BrowserSettingsStore(new InMemorySecureStorage());
    await store.load();
    expect(store.getPreferred()).toBe('');
    expect(getPreferredBrowser()).toBe('');
  });

  it('persists (trimmed) and reloads a chosen browser', async () => {
    const storage = new InMemorySecureStorage();
    const store = new BrowserSettingsStore(storage);
    await store.setPreferred('  com.brave.browser  ');
    expect(getPreferredBrowser()).toBe('com.brave.browser');

    setPreferredBrowserRuntime(''); // wipe the live value to prove reload restores it
    const store2 = new BrowserSettingsStore(storage);
    await store2.load();
    expect(store2.getPreferred()).toBe('com.brave.browser');
  });

  it('clears with an empty string', async () => {
    const storage = new InMemorySecureStorage();
    const store = new BrowserSettingsStore(storage);
    await store.setPreferred('org.torproject.torbrowser');
    await store.setPreferred('');
    expect(getPreferredBrowser()).toBe('');
  });

  it('falls back to empty with no secure storage', async () => {
    const store = new BrowserSettingsStore(null);
    await store.load();
    expect(store.getPreferred()).toBe('');
  });
});

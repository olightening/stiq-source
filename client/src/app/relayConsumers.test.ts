/**
 * C2/C3 consumer wiring: the RelayClient's onSubError (a relay CLOSED reason) and onNotice (a relay
 * NOTICE) listeners are consumed by AppRuntime.handleSubError / handleNotice, which route them into
 * the on-device diagnostics `log` ring (the hook point a future re-auth banner would read from).
 * These consumers had NO consumer before C3 — this proves they now fire and are observable.
 */
import {AppRuntime} from './AppRuntime';
import {RelayClient} from '../nostr/RelayClient';
import {InMemoryEventStore} from '../nostr/store';
import {FakeRelaySocket} from '../nostr/socket.fake';
import {InMemorySecureStorage} from '../keys/keystore';
import {clearRecentLogs, getRecentLogs} from '../util/log';

const identityHash = async (d: Uint8Array) => d;

function newRuntime(): AppRuntime {
  return new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store: new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
  });
}

beforeEach(() => clearRecentLogs());

describe('AppRuntime relay consumers (C2/C3)', () => {
  it('handleSubError routes auth-required/restricted to a warn (the re-auth banner hook)', () => {
    const runtime = newRuntime();
    runtime.handleSubError({subId: 'feed', message: 'auth-required: please authenticate'});
    runtime.handleSubError({subId: 'grp', message: 'restricted: not a member'});
    const warns = getRecentLogs().filter(l => l.level === 'warn');
    expect(warns.some(l => /"feed" needs auth\/membership/.test(l.msg))).toBe(true);
    expect(warns.some(l => /"grp" needs auth\/membership/.test(l.msg))).toBe(true);
    runtime.dispose();
  });

  it('handleSubError logs any OTHER CLOSED reason as diagnostics (never silently dropped)', () => {
    const runtime = newRuntime();
    runtime.handleSubError({subId: 'feed', message: 'error: shutting down'});
    expect(
      getRecentLogs().some(l => l.level === 'warn' && /"feed" closed by relay: error: shutting down/.test(l.msg)),
    ).toBe(true);
    runtime.dispose();
  });

  it('handleNotice routes a NOTICE into the diagnostics log', () => {
    const runtime = newRuntime();
    runtime.handleNotice('rate-limited: slow down');
    expect(
      getRecentLogs().some(l => l.level === 'info' && /NOTICE: rate-limited: slow down/.test(l.msg)),
    ).toBe(true);
    runtime.dispose();
  });

  it('fires through the real RelayClient listener path (as wired in App.tsx startRelay)', () => {
    const runtime = newRuntime();
    const socket = new FakeRelaySocket();
    const client = new RelayClient(socket, new InMemoryEventStore(), {kinds: [1]});
    // Mirror App.tsx: register the AppRuntime consumers on the RelayClient.
    const unsubErr = client.onSubError(err => runtime.handleSubError(err));
    const unsubNotice = client.onNotice(msg => runtime.handleNotice(msg));
    socket.simulateOpen();

    socket.emit(JSON.stringify(['CLOSED', 'feed', 'auth-required: please authenticate']));
    socket.emit(JSON.stringify(['NOTICE', 'be advised']));

    const logs = getRecentLogs();
    expect(logs.some(l => l.level === 'warn' && /"feed" needs auth\/membership/.test(l.msg))).toBe(true);
    expect(logs.some(l => l.level === 'info' && /NOTICE: be advised/.test(l.msg))).toBe(true);

    // Teardown unregisters (as relay.close()+null does in App.tsx).
    unsubErr();
    unsubNotice();
    clearRecentLogs();
    socket.emit(JSON.stringify(['NOTICE', 'after teardown']));
    expect(getRecentLogs().some(l => l.level === 'info' && /after teardown/.test(l.msg))).toBe(false);

    client.close();
    runtime.dispose();
  });
});

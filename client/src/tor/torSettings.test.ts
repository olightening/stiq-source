import {InMemorySecureStorage} from '../keys/keystore';
import {
  DEFAULT_TOR_PREFS,
  TorSettingsStore,
  customBridgesForTransport,
  inferCustomTransport,
  normalizePrefs,
  parseBridgeLines,
  validateBridgeLine,
  validateBridgeLines,
  type TorConnectionPrefs,
} from './torSettings';

// A real obfs4 line shape (from DEFAULT_OBFS4_BRIDGES) and a well-formed webtunnel line.
const OBFS4 =
  'obfs4 23.129.64.94:443 21F6BA217C1A9390600D62A6DA6D4D9C9F790259 cert=id1W2fU+DRDy4I+uHZW94QkW7JhEQhW0ZsG5LkFc4804Cj8kuP6oyWZjzH33rlmhSu7JTQ iat-mode=0';
const OBFS4_2 =
  'obfs4 31.171.250.46:80 F512F63404FB824912C4E65E09EAAA0857922E31 cert=BtB/ImZly0PO+pBoIaTc+NsMHLqXxdiLamfj02hZzErcYk7mvorTpteYbjq7LscCkGwuBA iat-mode=0';
const WEBTUNNEL =
  'webtunnel 1.2.3.4:443 0123456789ABCDEF0123456789ABCDEF01234567 url=https://example.com/path ver=0.0.2';
const SNOWFLAKE =
  'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://broker/';
const VANILLA = '1.2.3.4:443 0123456789ABCDEF0123456789ABCDEF01234567';

describe('validateBridgeLine', () => {
  it('accepts obfs4 and webtunnel', () => {
    expect(validateBridgeLine(OBFS4)).toBe('obfs4');
    expect(validateBridgeLine(WEBTUNNEL)).toBe('webtunnel');
  });

  it('classifies (but rejects) snowflake and vanilla bridges', () => {
    expect(validateBridgeLine(SNOWFLAKE)).toBe('snowflake');
    expect(validateBridgeLine(VANILLA)).toBe('vanilla');
  });

  it('flags garbage as invalid', () => {
    expect(validateBridgeLine('hello world')).toBe('invalid');
    expect(validateBridgeLine('obfs4 missing-the-rest')).toBe('invalid');
  });

  it('rejects a valid-prefix line carrying an embedded control char (torrc injection guard)', () => {
    // A CR/LF (or any C0/DEL) smuggled after an otherwise-valid obfs4 prefix must NOT be accepted —
    // it would be written verbatim into a torrc Bridge directive and could split into a second one.
    expect(validateBridgeLine(`${OBFS4}\rBridge injected-second-directive`)).toBe('invalid');
    expect(validateBridgeLine(`${OBFS4}\nSomeDirective 1`)).toBe('invalid');
    expect(validateBridgeLine(`${OBFS4}\u0000`)).toBe('invalid');
    expect(validateBridgeLine(`${OBFS4}\u007f`)).toBe('invalid');
  });

  it('rejects an implausibly long line', () => {
    expect(validateBridgeLine(`${OBFS4} ${'A'.repeat(700)}`)).toBe('invalid');
  });
});

describe('parseBridgeLines', () => {
  it('keeps only obfs4/webtunnel, drops blanks and rejects', () => {
    const raw = [OBFS4, '', SNOWFLAKE, WEBTUNNEL, VANILLA, '   '].join('\n');
    expect(parseBridgeLines(raw)).toEqual([OBFS4, WEBTUNNEL]);
  });

  it('dedupes repeated lines', () => {
    expect(parseBridgeLines([OBFS4, OBFS4].join('\n'))).toEqual([OBFS4]);
  });

  it('caps at 12 lines', () => {
    // 14 distinct obfs4 lines (vary the port) — only the first 12 survive.
    const many = Array.from({length: 14}, (_, i) =>
      OBFS4.replace(':443', `:${4430 + i}`),
    ).join('\n');
    expect(parseBridgeLines(many)).toHaveLength(12);
  });

  it('splits on a bare CR so a smuggled tail cannot ride an accepted line into the torrc', () => {
    // A paste where a bare CR (not CRLF) joins a valid obfs4 line to an attacker-chosen tail: the
    // split must separate them, the valid line survives, and the injected tail is dropped as invalid.
    expect(parseBridgeLines(`${OBFS4}\rBridge 6.6.6.6:6 ${'F'.repeat(40)} cert=x`)).toEqual([OBFS4]);
    // A CR embedded mid-line splits it into two malformed halves, both dropped (nothing survives).
    expect(parseBridgeLines(WEBTUNNEL.replace(' ', '\r'))).toEqual([]);
  });
});

describe('validateBridgeLines (UI feedback)', () => {
  it('treats empty input as valid (built-in bridges used)', () => {
    const v = validateBridgeLines('   \n  ');
    expect(v.valid).toBe(true);
    expect(v.kind).toBe('empty');
    expect(v.count).toBe(0);
  });

  it('reports counts for accepted lines', () => {
    expect(validateBridgeLines(OBFS4)).toMatchObject({valid: true, kind: 'obfs4', count: 1});
    expect(validateBridgeLines([OBFS4, OBFS4_2].join('\n'))).toMatchObject({
      valid: true,
      kind: 'obfs4',
      count: 2,
    });
    expect(validateBridgeLines([OBFS4, WEBTUNNEL].join('\n'))).toMatchObject({
      valid: true,
      kind: 'mixed',
      count: 2,
    });
  });

  it('rejects snowflake with a helpful message', () => {
    const v = validateBridgeLines(SNOWFLAKE);
    expect(v.valid).toBe(false);
    expect(v.message).toMatch(/Max reachability/i);
  });

  it('rejects vanilla and garbage', () => {
    expect(validateBridgeLines(VANILLA).valid).toBe(false);
    expect(validateBridgeLines('nonsense').valid).toBe(false);
  });
});

describe('normalizePrefs', () => {
  it('falls back to auto for an unknown mode', () => {
    expect(normalizePrefs({mode: 'bogus' as never, customBridges: []}).mode).toBe('auto');
    expect(normalizePrefs(null).mode).toBe('auto');
  });

  it('keeps a known mode', () => {
    expect(normalizePrefs({mode: 'bridges', customBridges: []}).mode).toBe('bridges');
  });

  it('drops an invalid preferredTransport', () => {
    expect(
      normalizePrefs({mode: 'custom', preferredTransport: 'tcp' as never, customBridges: []})
        .preferredTransport,
    ).toBeUndefined();
    expect(
      normalizePrefs({mode: 'custom', preferredTransport: 'obfs4', customBridges: []})
        .preferredTransport,
    ).toBe('obfs4');
  });

  // ALL_TRANSPORTS used to be a plain `TransportType[]`, which compiles fine forever even when it
  // under-lists the union — and the failure mode is invisible: normalizePrefs() drops a persisted
  // preference for the missing transport as if it were garbage input, no error, the user's pinned
  // choice just reverts. It is now a `Record<TransportType, true>`, so tsc fails if a future
  // TransportType member is left out. This test pins the runtime half of that.
  it('accepts every current TransportType member as a persisted preference', () => {
    for (const transport of ['direct', 'webtunnel', 'obfs4', 'snowflake'] as const) {
      expect(
        normalizePrefs({mode: 'custom', preferredTransport: transport, customBridges: []})
          .preferredTransport,
      ).toBe(transport);
    }
  });

  it('sanitizes and dedupes custom bridges', () => {
    const p = normalizePrefs({mode: 'custom', customBridges: [OBFS4, OBFS4, SNOWFLAKE, VANILLA]});
    expect(p.customBridges).toEqual([OBFS4]);
  });

  it('clamps the bootstrap timeout into a sane band', () => {
    expect(normalizePrefs({mode: 'auto', customBridges: [], bootstrapTimeoutMs: 1}).bootstrapTimeoutMs).toBe(
      15_000,
    );
    expect(
      normalizePrefs({mode: 'auto', customBridges: [], bootstrapTimeoutMs: 9_000_000})
        .bootstrapTimeoutMs,
    ).toBe(600_000);
    expect(
      normalizePrefs({mode: 'auto', customBridges: [], bootstrapTimeoutMs: NaN}).bootstrapTimeoutMs,
    ).toBeUndefined();
  });
});

describe('customBridgesForTransport', () => {
  it('returns only lines matching the transport', () => {
    const prefs: TorConnectionPrefs = {mode: 'custom', customBridges: [OBFS4, WEBTUNNEL]};
    expect(customBridgesForTransport(prefs, 'obfs4')).toEqual([OBFS4]);
    expect(customBridgesForTransport(prefs, 'webtunnel')).toEqual([WEBTUNNEL]);
    expect(customBridgesForTransport(prefs, 'snowflake')).toEqual([]);
  });
});

describe('inferCustomTransport', () => {
  it('infers the transport from the first pasted bridge', () => {
    expect(inferCustomTransport({mode: 'custom', customBridges: [OBFS4]})).toBe('obfs4');
    expect(inferCustomTransport({mode: 'custom', customBridges: [WEBTUNNEL]})).toBe('webtunnel');
    // First accepted line wins (one PT per torrc anyway).
    expect(inferCustomTransport({mode: 'custom', customBridges: [OBFS4, WEBTUNNEL]})).toBe('obfs4');
  });

  it('returns undefined when no usable bridge was pasted', () => {
    expect(inferCustomTransport({mode: 'custom', customBridges: []})).toBeUndefined();
  });
});

describe('TorSettingsStore', () => {
  it('defaults to auto when nothing is persisted', async () => {
    const store = new TorSettingsStore(new InMemorySecureStorage());
    await store.load();
    expect(store.getPrefs()).toEqual(DEFAULT_TOR_PREFS);
  });

  it('round-trips persisted prefs (normalized)', async () => {
    const storage = new InMemorySecureStorage();
    const store = new TorSettingsStore(storage);
    await store.setPrefs({
      mode: 'custom',
      preferredTransport: 'obfs4',
      customBridges: [OBFS4, OBFS4, SNOWFLAKE],
      bootstrapTimeoutMs: 45_000,
    });
    // A fresh store loading the same storage sees the normalized values.
    const reloaded = new TorSettingsStore(storage);
    await reloaded.load();
    expect(reloaded.getPrefs()).toEqual({
      mode: 'custom',
      preferredTransport: 'obfs4',
      customBridges: [OBFS4],
      bootstrapTimeoutMs: 45_000,
    });
  });

  it('falls back to default on corrupt stored JSON', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem('stiq.tor.connectionPrefs', 'not-json{{{');
    const store = new TorSettingsStore(storage);
    await store.load();
    expect(store.getPrefs()).toEqual(DEFAULT_TOR_PREFS);
  });

  it('degrades to in-memory default with null storage', async () => {
    const store = new TorSettingsStore(null);
    await store.load();
    expect(store.getPrefs()).toEqual(DEFAULT_TOR_PREFS);
    await expect(store.setPrefs({mode: 'fast', customBridges: []})).resolves.toBeUndefined();
    expect(store.getPrefs().mode).toBe('fast');
  });
});

/**
 * WEBTUNNEL end-to-end through the settings layer. It is the transport that still evades the DPI
 * obfs4 no longer does, so "nominally listed" is not good enough: a user who pins it plus pastes
 * their own private webtunnel bridges must get exactly that back after a restart, and the real
 * line shapes BridgeDB hands out (placeholder IPv6 in brackets, `ver=` present or absent) must
 * survive the paste validator rather than being silently dropped.
 */
describe('webtunnel end-to-end through torSettings', () => {
  // Real published shapes: an RFC 3849 documentation IPv6 in brackets (the NORMAL webtunnel case —
  // the client dials `url=` and never touches the address), and a line carrying no ver= at all.
  const WT_V6 =
    'webtunnel [2001:db8:1b75:cd28:36c7:1347:3eda:a01e]:443 ' +
    '2852538D49D7D73C1A6694FC492104983A9C4FA2 url=https://example.net/IfuJ9KsjkEk6462QblGNI0pR ver=0.0.3';
  const WT_NO_VER =
    'webtunnel 10.0.0.2:443 F76C85011FD8C113AA00960BD9FC7F5B66F726A2 url=https://example.org/vM8i19';

  it('accepts the real published webtunnel line shapes (bracketed IPv6, no ver=)', () => {
    expect(validateBridgeLine(WT_V6)).toBe('webtunnel');
    expect(validateBridgeLine(WT_NO_VER)).toBe('webtunnel');
    expect(parseBridgeLines(`${WT_V6}\n${WT_NO_VER}`)).toEqual([WT_V6, WT_NO_VER]);
    expect(validateBridgeLines(`${WT_V6}\n${WT_NO_VER}`)).toMatchObject({
      valid: true,
      count: 2,
      kind: 'webtunnel',
    });
  });

  it('round-trips a pinned webtunnel transport + pasted webtunnel bridges through storage', async () => {
    const storage = new InMemorySecureStorage();
    await new TorSettingsStore(storage).setPrefs({
      mode: 'custom',
      preferredTransport: 'webtunnel',
      customBridges: [WT_V6, WT_NO_VER],
      bootstrapTimeoutMs: 90_000,
    });

    const reloaded = new TorSettingsStore(storage);
    await reloaded.load();

    expect(reloaded.getPrefs()).toEqual({
      mode: 'custom',
      preferredTransport: 'webtunnel',
      customBridges: [WT_V6, WT_NO_VER],
      bootstrapTimeoutMs: 90_000,
    });
    // And the cascade can actually pick those lines back out for the webtunnel rung.
    expect(customBridgesForTransport(reloaded.getPrefs(), 'webtunnel')).toEqual([
      WT_V6,
      WT_NO_VER,
    ]);
    expect(inferCustomTransport(reloaded.getPrefs())).toBe('webtunnel');
  });
});

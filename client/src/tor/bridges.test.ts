import {
  BRIDGE_LADDER,
  DEFAULT_OBFS4_BRIDGES,
  DEFAULT_SNOWFLAKE_BRIDGES,
  DEFAULT_TRANSPORT,
  buildStartConfig,
  buildTorrcBridgeLines,
  defaultBridgeLines,
} from './bridges';
// The real parser these bridge lines have to survive (StiqArtiModule.kt ->
// arti-ffi/src/pt.rs's BridgeConfigBuilder::from_str never sees TS at all, but
// torSettings.ts's validateBridgeLine is the one place this repo already encodes that
// shape in TS, and is what the custom-bridge paste box in Settings runs pasted lines
// through) — importing it here means a future bad line fails `npm test`, not a user's
// bootstrap attempt. See torSettings.ts's OBFS4_RE/WEBTUNNEL_RE/SNOWFLAKE_RE.
import {validateBridgeLine} from './torSettings';

describe('bridge config', () => {
  it('defaults to obfs4', () => {
    expect(DEFAULT_TRANSPORT).toBe('obfs4');
  });

  it('builds an obfs4 start config by default', () => {
    const cfg = buildStartConfig();
    expect(cfg.transport).toBe('obfs4');
    expect(cfg.bridgeLines.length).toBeGreaterThan(0);
    expect(cfg.socksPort).toBe(0); // auto-pick
  });

  it('honors the snowflake transport and custom bridge lines', () => {
    const cfg = buildStartConfig({
      transport: 'snowflake',
      bridgeLines: ['snowflake 192.0.2.9:80 ABCD url=https://example/'],
      socksPort: 9999,
    });
    expect(cfg.transport).toBe('snowflake');
    expect(cfg.bridgeLines).toHaveLength(1);
    expect(cfg.socksPort).toBe(9999);
  });

  it('falls back to default snowflake bridges when none provided', () => {
    expect(defaultBridgeLines('snowflake')[0]).toMatch(/^snowflake /);
    expect(defaultBridgeLines('obfs4')[0]).toMatch(/^obfs4 /);
  });

  it('emits UseBridges + Bridge torrc lines', () => {
    const lines = buildTorrcBridgeLines(['obfs4 1.2.3.4:443 FP cert=x iat-mode=0']);
    expect(lines[0]).toBe('UseBridges 1');
    expect(lines[1]).toBe('Bridge obfs4 1.2.3.4:443 FP cert=x iat-mode=0');
  });

  it('refuses to enable bridges with an empty list', () => {
    expect(() => buildTorrcBridgeLines([])).toThrow();
  });

  it('orders the bridge ladder fastest→most-evasive and excludes direct', () => {
    expect(BRIDGE_LADDER).toEqual(['webtunnel', 'obfs4', 'snowflake']);
    expect(BRIDGE_LADDER).not.toContain('direct');
    // Every ladder tier must have a usable default bridge set so escalation never dead-ends
    // on a transport with nothing to dial (webtunnel is fetched at runtime, so allow empty).
    expect(defaultBridgeLines('obfs4').length).toBeGreaterThan(0);
    expect(defaultBridgeLines('snowflake').length).toBeGreaterThan(0);
  });
});

// T4-S2: the dormancy field is threaded so the native layer can apply Arti's battery-friendly
// DormantMode::Soft at TorClient construction (see TorStartConfig.dormancy). Ship-dark parity
// requires the key to be OMITTED from the config unless explicitly true, so a flag-off config is
// structurally identical to before the field existed.
describe('dormancy config field', () => {
  it('carries dormancy:true when requested', () => {
    const cfg = buildStartConfig({dormancy: true});
    expect(cfg.dormancy).toBe(true);
  });

  it('OMITS the dormancy key entirely when not requested (flag-off byte-parity)', () => {
    const cfg = buildStartConfig({});
    expect('dormancy' in cfg).toBe(false);
    expect(cfg.dormancy).toBeUndefined();
  });

  it('OMITS the dormancy key when dormancy:false (falsy → not added)', () => {
    const cfg = buildStartConfig({dormancy: false});
    expect('dormancy' in cfg).toBe(false);
  });

  it('OMITS the dormancy key for a plain no-arg config', () => {
    expect('dormancy' in buildStartConfig()).toBe(false);
  });
});

// T14-S1: regression net pinning the Snowflake + WebTunnel ladder wiring so a refactor cannot
// silently drop a transport, reorder the ladder, or stop passing a transport through to the config.
describe('transport portfolio', () => {
  it('pins the BRIDGE_LADDER order and membership', () => {
    expect(BRIDGE_LADDER).toEqual(['webtunnel', 'obfs4', 'snowflake']);
    expect(BRIDGE_LADDER).toContain('snowflake');
    expect(BRIDGE_LADDER).toContain('webtunnel');
  });

  it('returns the expected default bridge lines per transport', () => {
    const snowflake = defaultBridgeLines('snowflake');
    expect(snowflake.length).toBeGreaterThan(0);
    for (const line of snowflake) {
      expect(line).toMatch(/^snowflake /);
    }
    // WebTunnel ships zero bundled bridges today (fetched from the moat / seeded by organizers);
    // T14-S3/S4 backfills this — the empty state is intentional and pinned here.
    expect(defaultBridgeLines('webtunnel')).toEqual([]);
    // direct carries no bridges at all.
    expect(defaultBridgeLines('direct')).toEqual([]);
    expect(defaultBridgeLines('obfs4').length).toBeGreaterThan(0);
  });

  it('passes each bridge transport through buildStartConfig unchanged', () => {
    for (const t of ['webtunnel', 'obfs4', 'snowflake'] as const) {
      expect(buildStartConfig({transport: t}).transport).toBe(t);
    }
    // Snowflake falls back to its bundled bridge set when none are supplied.
    expect(buildStartConfig({transport: 'snowflake'}).bridgeLines.length).toBeGreaterThan(0);
  });

  it('builds UseBridges + Bridge torrc lines, and refuses an empty list', () => {
    expect(() => buildTorrcBridgeLines([])).toThrow();
    const lines = buildTorrcBridgeLines(['snowflake 192.0.2.3:80 FP url=https://example/']);
    expect(lines).toEqual([
      'UseBridges 1',
      'Bridge snowflake 192.0.2.3:80 FP url=https://example/',
    ]);
  });
});

// T-refresh (2026-07-27): the bundled obfs4 set was replaced wholesale (30 dead
// scriptzteam-scraped lines -> 11 lines sourced from Tor Project's own moat "builtin"
// endpoint — see the DEFAULT_OBFS4_BRIDGES doc comment for provenance) and the Snowflake
// broker's fronts=/ice= were updated for the same reason. These tests are the "sanity-check
// every line against the parser" pass called for alongside that refresh: a malformed bundled
// line is worse than a dead one, so every line here now runs through the SAME
// validateBridgeLine() the custom-bridge paste box in Settings uses, on every `npm test`.
describe('DEFAULT_OBFS4_BRIDGES sanity (post 2026-07-27 refresh)', () => {
  it('every bundled obfs4 line parses as a valid obfs4 bridge per torSettings.validateBridgeLine', () => {
    for (const line of DEFAULT_OBFS4_BRIDGES) {
      expect(validateBridgeLine(line)).toBe('obfs4');
    }
  });

  it('has at least 8 entries so a full non-repeating pickRandom(8) draw is possible', () => {
    // Not "greater than 0" (already covered elsewhere) — this pins the specific number
    // pickRandom() is documented to draw, so a future trim that drops below it is a
    // deliberate, reviewed choice rather than an accident.
    expect(DEFAULT_OBFS4_BRIDGES.length).toBeGreaterThanOrEqual(8);
  });

  it('has no duplicate lines', () => {
    expect(new Set(DEFAULT_OBFS4_BRIDGES).size).toBe(DEFAULT_OBFS4_BRIDGES.length);
  });
});

describe('DEFAULT_SNOWFLAKE_BRIDGES sanity (post 2026-07-27 refresh)', () => {
  it('every bundled snowflake line parses as a valid snowflake bridge per torSettings.validateBridgeLine', () => {
    for (const line of DEFAULT_SNOWFLAKE_BRIDGES) {
      expect(validateBridgeLine(line)).toBe('snowflake');
    }
  });

  it('both bridges share the current CDN77 broker url= and fronts=', () => {
    for (const line of DEFAULT_SNOWFLAKE_BRIDGES) {
      expect(line).toContain('url=https://1098762253.rsc.cdn77.org/');
      expect(line).toContain('fronts=app.datapacket.com,www.datapacket.com');
    }
  });

  it('carries more than one ice= STUN server on every line (single-STUN stalls the rendezvous)', () => {
    for (const line of DEFAULT_SNOWFLAKE_BRIDGES) {
      const match = line.match(/ice=(\S+)/);
      expect(match).not.toBeNull();
      const stunServers = match![1]!.split(',');
      expect(stunServers.length).toBeGreaterThan(1);
    }
  });
});

/**
 * relayOnion — the native reachability probe's target (TorStartConfig.relayOnion).
 *
 * The probe (arti-ffi/src/lib.rs) exists because Arti reports "connected, bootstrap 100%" off a
 * CACHED consensus milliseconds after logging "No usable guards": a usable directory is not a
 * working channel. It only runs when the start config names a relay onion. Keying that off
 * `onionAuth` — as the first cut did — silently excluded every PUBLIC community, because
 * `onionAuth == null` means "a public onion", NOT "no relay". These tests pin the public case
 * specifically, since it is the one that regressed.
 */
describe('relayOnion probe target', () => {
  const HOST = 'a'.repeat(56);

  it('carries relayOnion for a PUBLIC community — no onionAuth anywhere in the config', () => {
    const cfg = buildStartConfig({relayOnion: HOST});
    expect(cfg.relayOnion).toBe(HOST);
    expect('onionAuth' in cfg).toBe(false);
  });

  it('carries relayOnion alongside onionAuth for a members-only community', () => {
    const auth = {onionHost: HOST, privKeyBase32: 'A'.repeat(52)};
    const cfg = buildStartConfig({relayOnion: HOST, onionAuth: auth});
    expect(cfg.relayOnion).toBe(HOST);
    expect(cfg.onionAuth).toEqual(auth);
  });

  it('OMITS the key entirely when no relay onion is known (pre-field byte-parity)', () => {
    expect('relayOnion' in buildStartConfig()).toBe(false);
    expect('relayOnion' in buildStartConfig({relayOnion: ''})).toBe(false);
    expect('relayOnion' in buildStartConfig({transport: 'direct'})).toBe(false);
  });

  it('is independent of the transport — every rung gets probe coverage', () => {
    for (const t of ['direct', 'webtunnel', 'obfs4', 'snowflake'] as const) {
      expect(buildStartConfig({transport: t, relayOnion: HOST}).relayOnion).toBe(HOST);
    }
  });
});

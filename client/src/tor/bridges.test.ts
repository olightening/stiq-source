import {
  BRIDGE_LADDER,
  DEFAULT_TRANSPORT,
  buildStartConfig,
  buildTorrcBridgeLines,
  defaultBridgeLines,
} from './bridges';

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

// T4-S2: the dormancy field is threaded so the native torrc can pick the battery-friendly padding
// block. Ship-dark parity requires the key to be OMITTED from the config unless explicitly true, so
// a flag-off config is structurally identical to before the field existed.
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

import {
  isValidAuthKeyBase32,
  onionHostOf,
  authPrivateFileName,
  authPrivateFileContent,
  deriveOnionAuthSet,
  setActiveOnionAuthExtra,
  getActiveOnionAuthExtra,
  sameOnionAuthSet,
  preserveDisplacedActivePrimary,
} from './onionAuth';

const HOST = 'a'.repeat(56); // stand-in v3 onion host (56 base32 chars)
const KEY = 'A'.repeat(52); // stand-in x25519 key (52 base32 chars)
const HOST2 = 'b'.repeat(56);
const KEY2 = 'B'.repeat(52);

describe('onionAuth', () => {
  it('validates the base32 client-auth key shape', () => {
    expect(isValidAuthKeyBase32(KEY)).toBe(true);
    expect(isValidAuthKeyBase32('A'.repeat(51))).toBe(false); // too short
    expect(isValidAuthKeyBase32('a'.repeat(52))).toBe(false); // lowercase not allowed
    expect(isValidAuthKeyBase32('A'.repeat(50) + '01')).toBe(false); // 0/1 not in base32
    expect(isValidAuthKeyBase32(undefined)).toBe(false);
  });

  it('extracts the bare onion host from a relay ws url', () => {
    expect(onionHostOf(`ws://${HOST}.onion`)).toBe(HOST);
    expect(onionHostOf(`ws://${HOST}.onion/`)).toBe(HOST);
    expect(onionHostOf(`ws://${HOST}.onion:80/path`)).toBe(HOST);
    expect(onionHostOf(`wss://${HOST}.ONION`)).toBe(HOST); // case-insensitive suffix
  });

  it('rejects non-onion / malformed relay urls', () => {
    expect(onionHostOf('ws://example.com')).toBeNull();
    expect(onionHostOf(`ws://${'a'.repeat(40)}.onion`)).toBeNull(); // wrong length
    expect(onionHostOf('')).toBeNull();
  });

  it('builds the auth_private filename and line', () => {
    expect(authPrivateFileName(HOST)).toBe(`${HOST}.auth_private`);
    expect(authPrivateFileContent(HOST, KEY)).toBe(`${HOST}:descriptor:x25519:${KEY}\n`);
  });

  it('refuses to build a line for a malformed host or key', () => {
    expect(authPrivateFileContent('short', KEY)).toBeNull();
    expect(authPrivateFileContent(HOST, 'bad')).toBeNull();
  });

  describe('deriveOnionAuthSet (P2 §1.7 multi-relay client transport)', () => {
    it('maps mirrors to their auth credentials and drops public (no-key) mirrors', () => {
      const set = deriveOnionAuthSet([
        {url: `ws://${HOST}.onion`, onionAuthKey: KEY},
        {url: 'ws://example.com'}, // public mirror — no onion, no auth
        {url: `ws://${HOST2}.onion`}, // onion mirror but no key — public onion
        {url: `ws://${HOST2}.onion`, onionAuthKey: KEY2},
      ]);
      expect(set).toEqual([
        {onionHost: HOST, privKeyBase32: KEY},
        {onionHost: HOST2, privKeyBase32: KEY2},
      ]);
    });

    it('de-dups by onion host, first occurrence wins (e.g. the shared community keypair repeated across mirrors)', () => {
      const set = deriveOnionAuthSet([
        {url: `ws://${HOST}.onion`, onionAuthKey: KEY},
        {url: `ws://${HOST}.onion/`, onionAuthKey: KEY}, // same host, trailing slash
        {url: `ws://${HOST}.onion:80`, onionAuthKey: 'C'.repeat(52)}, // same host, different key — ignored
      ]);
      expect(set).toEqual([{onionHost: HOST, privKeyBase32: KEY}]);
    });

    it('returns [] for an empty or all-public mirror list', () => {
      expect(deriveOnionAuthSet([])).toEqual([]);
      expect(deriveOnionAuthSet([{url: 'ws://example.com'}])).toEqual([]);
    });
  });

  describe('active onion-auth EXTRA holder (secondary mirrors)', () => {
    afterEach(() => {
      setActiveOnionAuthExtra([]); // don't leak state across tests
    });

    it('defaults to empty and round-trips a set', () => {
      expect(getActiveOnionAuthExtra()).toEqual([]);
      const set = [{onionHost: HOST2, privKeyBase32: KEY2}];
      setActiveOnionAuthExtra(set);
      expect(getActiveOnionAuthExtra()).toEqual(set);
    });
  });

  describe('sameOnionAuthSet (change detection for the reconnect trigger)', () => {
    const a = {onionHost: HOST, privKeyBase32: KEY};
    const b = {onionHost: HOST2, privKeyBase32: KEY2};

    it('is true for equal sets (same order — deriveOnionAuthSet is deterministic)', () => {
      expect(sameOnionAuthSet([], [])).toBe(true);
      expect(sameOnionAuthSet([a, b], [a, b])).toBe(true);
    });

    it('is false when the set grows, shrinks, or a key changes', () => {
      expect(sameOnionAuthSet([a], [a, b])).toBe(false); // grew (new auth-gated mirror)
      expect(sameOnionAuthSet([a, b], [a])).toBe(false); // shrank
      expect(sameOnionAuthSet([a], [{onionHost: HOST, privKeyBase32: KEY2}])).toBe(false); // rekeyed
    });
  });

  describe('preserveDisplacedActivePrimary (A3: multi-community onion-auth clobber)', () => {
    const activePrimary = {onionHost: HOST, privKeyBase32: KEY};
    const otherAuth = {onionHost: HOST2, privKeyBase32: KEY2};

    it('is a no-op when no onboarding override is in effect', () => {
      expect(preserveDisplacedActivePrimary([], activePrimary, false, null)).toEqual([]);
      expect(preserveDisplacedActivePrimary([otherAuth], activePrimary, false, otherAuth)).toEqual([otherAuth]);
    });

    it('is a no-op when there is no active primary to preserve', () => {
      expect(preserveDisplacedActivePrimary([], null, true, otherAuth)).toEqual([]);
      expect(preserveDisplacedActivePrimary([otherAuth], null, true, null)).toEqual([otherAuth]);
    });

    it('is a no-op when the override targets the SAME onion host as the active primary (nothing displaced)', () => {
      const sameHostOverride = {onionHost: HOST, privKeyBase32: 'C'.repeat(52)};
      expect(preserveDisplacedActivePrimary([], activePrimary, true, sameHostOverride)).toEqual([]);
    });

    it('is a no-op when extras already carry the active primary\'s host (no duplicate write)', () => {
      expect(preserveDisplacedActivePrimary([activePrimary], activePrimary, true, otherAuth)).toEqual([activePrimary]);
    });

    it('prepends the displaced active primary on a normal displacement (including a deliberate public-onion override)', () => {
      expect(preserveDisplacedActivePrimary([otherAuth], activePrimary, true, otherAuth)).toEqual([
        activePrimary,
        otherAuth,
      ]);
      // override === null means the onboarding flow deliberately selected a public onion — the
      // active community's primary credential must still be preserved so its relay stays reachable.
      expect(preserveDisplacedActivePrimary([], activePrimary, true, null)).toEqual([activePrimary]);
    });
  });
});

import {
  encodeJoinCode,
  parseJoinCode,
  isInviteCode,
  enrollKeyMatchesCid,
  JOIN_PREFIX,
  MAX_MIRRORS,
} from './join';
import type {Community} from './community';
import {walletKeyFingerprint} from '../blind/wallet';
import {log} from '../util/log';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const ONION_B = `ws://${'b'.repeat(56)}.onion`;
const ONION_C = `ws://${'c'.repeat(56)}.onion`;
const ISSUER = 'TUlJQklqQU5CZ2tx'; // opaque base64-ish issuer key
const CID = walletKeyFingerprint(ISSUER);
const INVITE = 'STIQ-ABCD-2345-MNPQ';
const ORG_PUB = 'f'.repeat(64);
// A structurally-valid 32-byte community key (base64) — parseJoinCode now enforces this width
// (mirrors decodeCommunityKey), so fixtures must decode to exactly 32 bytes, not just be "base64-ish".
const CK32 = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
// Purpose-specific issuer keys (base64 SPKI) — validated with the same isPlausibleIssuerKey bound as
// `ik`, so any decodable base64 within the SPKI ceiling round-trips.
const POST_KEY = Buffer.from('post-issuer-key').toString('base64');
const READ_KEY = Buffer.from('read-issuer-key').toString('base64');
// Valid unpadded-uppercase-base32 x25519 onion-auth key (52 chars from [A-Z2-7]).
const AUTH_KEY = 'A'.repeat(52);
// Organizer-seeded bridge lines (join-code `br`, T14). The valid two match validateBridgeLine's
// obfs4/webtunnel shapes (40-hex fingerprint etc.); the rest are the kinds parseJoinCode must drop.
const OBFS4_BRIDGE = 'obfs4 1.2.3.4:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbCdEf iat-mode=0';
const WEBTUNNEL_BRIDGE =
  'webtunnel 5.6.7.8:443 89ABCDEF0123456789ABCDEF0123456789ABCDEF url=https://tunnel.example.com/xyz';
const SNOWFLAKE_BRIDGE = 'snowflake 1.1.1.1:1 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72';
const VANILLA_BRIDGE = '9.9.9.9:443 0123456789ABCDEF0123456789ABCDEF01234567';
const INVALID_BRIDGE = 'not a bridge line at all';

const FULL: Community = {
  relayUrl: ONION,
  issuerPublicKey: ISSUER,
  name: 'Acme Community',
  organizerLabel: 'Alice; the organizer', // contains a ; to prove JSON wrapping is robust
  organizerPubkey: ORG_PUB,
};

/** Hand-build a raw `stiq:join:<version>:<b64url-json>` envelope, bypassing encodeJoinCode, so
 *  tests can craft version-specific / malformed / partial JSON that the real encoder would never
 *  produce (e.g. a v1 envelope, or a v2 envelope with an inline `ik` — encodeJoinCode itself never
 *  emits `ik`, it always produces the deferred form). */
function rawJoinCode(version: number, json: object): string {
  const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${JOIN_PREFIX}${version}:${b64url}`;
}

describe('join code (v2 default encode)', () => {
  it('encodes a v2 envelope that defers the issuer key, pinning cid instead', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    expect(text.startsWith(`${JOIN_PREFIX}2:`)).toBe(true);
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.inviteCode).toBe(INVITE);
      expect(parsed.join.community.relayUrl).toBe(FULL.relayUrl);
      // encodeJoinCode never inlines `ik` — v2 always defers to a post-connect NIP-11 fetch.
      expect(parsed.join.community.issuerPublicKey).toBe('');
      expect(parsed.join.community.cid).toBe(walletKeyFingerprint(FULL.issuerPublicKey));
      expect(parsed.join.community.name).toBe(FULL.name);
      expect(parsed.join.community.organizerLabel).toBe(FULL.organizerLabel);
      expect(parsed.join.community.organizerPubkey).toBe(FULL.organizerPubkey);
      expect(parsed.join.community.relays).toEqual([{url: FULL.relayUrl, onionAuthKey: null}]);
    }
  });

  it('round-trips a v3-style join code carrying the shared community key (ck)', () => {
    const ck = CK32;
    const text = encodeJoinCode({community: {...FULL, communityKey: ck}, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.join.community.communityKey).toBe(ck);
  });

  it('leaves communityKey undefined when the join code has no ck (legacy)', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.communityKey).toBeUndefined();
  });

  it('round-trips a minimal join code (no optional fields)', () => {
    const text = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: INVITE,
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.name).toBeUndefined();
      expect(parsed.join.community.organizerPubkey).toBeUndefined();
    }
  });

  it('lower-cases input invite back to canonical upper-case', () => {
    const text = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: INVITE.toLowerCase(),
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.inviteCode).toBe(INVITE);
  });

  it('rejects a non-stiq code', () => {
    expect(parseJoinCode('https://evil.example').ok).toBe(false);
  });

  it('rejects garbage payload', () => {
    expect(parseJoinCode(`${JOIN_PREFIX}2:not-valid-base64-json`).ok).toBe(false);
  });

  it('rejects a clearnet relay (dropped from rs, no mirror left)', () => {
    const clearnet = encodeJoinCode({
      community: {relayUrl: 'ws://relay.example.com', issuerPublicKey: ISSUER},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(clearnet).ok).toBe(false);
  });

  it('rejects an invalid invite', () => {
    const bad = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: 'STIQ-ABCD-2345', // only 8 chars (old format)
    });
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects a below-minimum join code version', () => {
    const text = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: INVITE,
    }).replace(`${JOIN_PREFIX}2:`, `${JOIN_PREFIX}0:`);
    expect(parseJoinCode(text).ok).toBe(false);
  });

  it('rejects a malformed (non-numeric) join code version', () => {
    const text = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: INVITE,
    }).replace(`${JOIN_PREFIX}2:`, `${JOIN_PREFIX}abc:`);
    expect(parseJoinCode(text).ok).toBe(false);
  });

  // Forward-compat (Architecture Component 8): a join code from a newer client/organizer is no
  // longer an outright reject — the envelope is JSON, so unknown keys are already harmless; the
  // known fields still parse (via the same >=2 parser) and we just warn instead of bricking the
  // un-upgraded client.
  it('accepts a newer-than-known join code version, parsing known fields and warning', () => {
    const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const text = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER},
      inviteCode: INVITE,
    }).replace(`${JOIN_PREFIX}2:`, `${JOIN_PREFIX}3:`);
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.inviteCode).toBe(INVITE);
      expect(parsed.join.community.relayUrl).toBe(ONION);
      expect(parsed.join.community.cid).toBe(walletKeyFingerprint(ISSUER));
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// T8 deep-link hardening: a join code is attacker-reachable (any web page can fire stiq://join),
// so the parser bounds and structurally validates every field before it reaches crypto/UI.
describe('join code — T8 hardening', () => {
  it('rejects an oversize join code before parsing', () => {
    const huge = `${JOIN_PREFIX}2:${'a'.repeat(5000)}`;
    expect(parseJoinCode(huge).ok).toBe(false);
  });

  it('rejects a non-base64 inline issuer key (ik present in a v2 envelope)', () => {
    const bad = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, ik: 'not valid base64 %%%'});
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects an oversize inline issuer key (past the SPKI ceiling), even with a matching-shaped cid', () => {
    // 2732 base64 chars decode to ~2049 bytes, just past the 2048-byte SPKI ceiling.
    const bad = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, ik: 'A'.repeat(2732)});
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects a malformed organizer pubkey (not 64-hex)', () => {
    const bad = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER, organizerPubkey: 'nothex'},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects an oversize community name', () => {
    const bad = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER, name: 'x'.repeat(300)},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('still accepts a well-formed code at the boundary', () => {
    const ok = encodeJoinCode({
      community: {relayUrl: ONION, issuerPublicKey: ISSUER, organizerPubkey: ORG_PUB, name: 'Acme'},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(ok).ok).toBe(true);
  });

  // #77: ck was previously accepted as any non-empty string; must now match the same 32-byte
  // width the community key is used at (attribution decryption / NIP-44 conversation key).
  it('rejects a malformed community key (ck, wrong length)', () => {
    const shortCk = Buffer.from(new Uint8Array(6).fill(1)).toString('base64');
    const bad = encodeJoinCode({community: {...FULL, communityKey: shortCk}, inviteCode: INVITE});
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects a malformed community key (ck, not base64)', () => {
    const bad = encodeJoinCode({community: {...FULL, communityKey: 'not valid base64 %%%'}, inviteCode: INVITE});
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('still accepts a well-formed ck at the boundary', () => {
    const ok = encodeJoinCode({community: {...FULL, communityKey: CK32}, inviteCode: INVITE});
    expect(parseJoinCode(ok).ok).toBe(true);
  });
});

// Token domain separation (#3/#4/#29): the join code carries the organizer's purpose keys pk (K_post)
// / rk (K_read) so the client can blind posting/read tokens under the right key. Absent ⇒ the draws
// fall back to the single issuer key, byte-identical to a pre-domain-separation community. Still
// inlined this increment — only the enrollment key (ik) defers to post-connect fetch.
describe('join code — token domain separation (pk/rk)', () => {
  it('round-trips the posting + read issuer keys (pk/rk)', () => {
    const text = encodeJoinCode({
      community: {...FULL, postIssuerPublicKey: POST_KEY, readIssuerPublicKey: READ_KEY},
      inviteCode: INVITE,
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.postIssuerPublicKey).toBe(POST_KEY);
      expect(parsed.join.community.readIssuerPublicKey).toBe(READ_KEY);
    }
  });

  it('leaves pk/rk undefined when the join code omits them (single-key / legacy)', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.postIssuerPublicKey).toBeUndefined();
      expect(parsed.join.community.readIssuerPublicKey).toBeUndefined();
    }
  });

  it('rejects a malformed posting issuer key (pk, not base64)', () => {
    const bad = encodeJoinCode({
      community: {...FULL, postIssuerPublicKey: 'not valid base64 %%%'},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('rejects an oversize read issuer key (rk, past the SPKI ceiling)', () => {
    const bad = encodeJoinCode({
      community: {...FULL, readIssuerPublicKey: 'A'.repeat(2732)},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(bad).ok).toBe(false);
  });

  it('still accepts well-formed pk/rk at the boundary', () => {
    const ok = encodeJoinCode({
      community: {...FULL, postIssuerPublicKey: POST_KEY, readIssuerPublicKey: READ_KEY},
      inviteCode: INVITE,
    });
    expect(parseJoinCode(ok).ok).toBe(true);
  });
});

// Organizer-seeded bridge lines (`br`, T14): a zero-network fallback for the webtunnel tier, which
// ships no bundled bridges. parseJoinCode validates (obfs4/webtunnel only), dedupes, and caps at 12.
// Parsing/storing is harmless with COMMUNITY_SEEDED_BRIDGES off; an old client ignores unknown `br`.
describe('join code — organizer-seeded bridges (br)', () => {
  it('(a) parses valid webtunnel + obfs4 br lines into community.seededBridges', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      rs: [[ONION, null]],
      cid: CID,
      br: [WEBTUNNEL_BRIDGE, OBFS4_BRIDGE],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.seededBridges).toContain(WEBTUNNEL_BRIDGE);
      expect(parsed.join.community.seededBridges).toContain(OBFS4_BRIDGE);
      // insertion order preserved (seeded-first = tried-first once App.tsx consumes it).
      expect(parsed.join.community.seededBridges).toEqual([WEBTUNNEL_BRIDGE, OBFS4_BRIDGE]);
    }
  });

  it('(b) drops invalid / snowflake / vanilla br lines, keeping only obfs4/webtunnel', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      rs: [[ONION, null]],
      cid: CID,
      br: [SNOWFLAKE_BRIDGE, VANILLA_BRIDGE, INVALID_BRIDGE, OBFS4_BRIDGE],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.seededBridges).toEqual([OBFS4_BRIDGE]);
    }
  });

  it('(b2) leaves seededBridges undefined when every br line is invalid (never an empty array)', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      rs: [[ONION, null]],
      cid: CID,
      br: [SNOWFLAKE_BRIDGE, VANILLA_BRIDGE, INVALID_BRIDGE],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.seededBridges).toBeUndefined();
  });

  it('dedupes repeated br lines via a Set', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      rs: [[ONION, null]],
      cid: CID,
      br: [OBFS4_BRIDGE, OBFS4_BRIDGE, WEBTUNNEL_BRIDGE],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.seededBridges).toEqual([OBFS4_BRIDGE, WEBTUNNEL_BRIDGE]);
    }
  });

  it('(c) caps a >12 br list at MAX_SEEDED_BRIDGES (12), keeping the first 12', () => {
    const many = Array.from(
      {length: 15},
      (_, i) => `obfs4 10.0.0.${i}:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbCdEf iat-mode=0`,
    );
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, br: many});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.seededBridges?.length).toBe(12);
      expect(parsed.join.community.seededBridges).toEqual(many.slice(0, 12));
    }
  });

  it('(d) leaves seededBridges undefined when br is absent', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, ik: ISSUER});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.seededBridges).toBeUndefined();
  });

  it('(e) parses a v2 code WITHOUT br unchanged (back-compat)', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.seededBridges).toBeUndefined();
      // the rest of the code is byte-for-byte the same as before `br` existed.
      expect(parsed.join.inviteCode).toBe(INVITE);
      expect(parsed.join.community.relayUrl).toBe(FULL.relayUrl);
      expect(parsed.join.community.cid).toBe(walletKeyFingerprint(FULL.issuerPublicKey));
      expect(parsed.join.community.organizerPubkey).toBe(FULL.organizerPubkey);
    }
  });
});

// Signed in-app update repo (`up`/`uf`/`af`/`ua`, T9): the per-community trust anchor App.tsx feeds
// to the updater. Only assembled when `up` is present AND both cert pins are 64-hex; a malformed pin
// DROPS the whole repo (never fatal). Parsed/stored even with APK_UPDATES off; an old client ignores
// the unknown keys entirely (forward-compat).
const UP_REPO = `http://${'d'.repeat(56)}.onion/fdroid/repo`;
const UF_CERT = 'AB'.repeat(32); // 64-hex, UPPERCASE — proves lowercase normalization on parse
const AF_CERT = 'CD'.repeat(32); // distinct app-signing pin (verifies it maps to appCertSha256)
const APP_ID = 'com.example.fork';

describe('join code — signed update repo (up/uf/af/ua)', () => {
  it('(a) parses up/uf/af/ua into community.updateRepo (uf/af lowercased)', () => {
    const text = rawJoinCode(2, {
      v: 2, i: INVITE, rs: [[ONION, null]], cid: CID,
      up: UP_REPO, uf: UF_CERT, af: AF_CERT, ua: APP_ID,
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.updateRepo).toEqual({
        baseUrl: UP_REPO,
        certSha256: UF_CERT.toLowerCase(),
        appCertSha256: AF_CERT.toLowerCase(),
        applicationId: APP_ID,
      });
    }
  });

  it('(b) leaves updateRepo undefined when up is absent', () => {
    const text = rawJoinCode(2, {
      v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, uf: UF_CERT, af: AF_CERT,
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.updateRepo).toBeUndefined();
  });

  it('(c) drops the whole repo when uf or af is not 64-hex (never fatal)', () => {
    const badUf = parseJoinCode(rawJoinCode(2, {
      v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, up: UP_REPO, uf: 'xyz', af: AF_CERT,
    }));
    expect(badUf.ok).toBe(true); // the invite still parses — a bad pin is not fatal
    expect(badUf.ok && badUf.join.community.updateRepo).toBeUndefined();

    const badAf = parseJoinCode(rawJoinCode(2, {
      v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, up: UP_REPO, uf: UF_CERT, af: 'AB'.repeat(30),
    }));
    expect(badAf.ok && badAf.join.community.updateRepo).toBeUndefined();
  });

  it('(d) defaults applicationId to com.stiq.client when ua is absent', () => {
    const text = rawJoinCode(2, {
      v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, up: UP_REPO, uf: UF_CERT, af: AF_CERT,
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.updateRepo?.applicationId).toBe('com.stiq.client');
    }
  });

  it('(e) parses a v2 code WITHOUT update fields unchanged (back-compat)', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.updateRepo).toBeUndefined();
      // the rest of the code is byte-for-byte the same as before the update fields existed.
      expect(parsed.join.inviteCode).toBe(INVITE);
      expect(parsed.join.community.relayUrl).toBe(FULL.relayUrl);
    }
  });
});

// v2 relay mirrors (rs): the additive discovery source future write-fanout (P2) will read.
describe('join code — v2 relay mirrors (rs)', () => {
  it('parses a multi-mirror rs list, primary = rs[0]', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      cid: CID,
      ik: ISSUER,
      rs: [
        [ONION, null],
        [ONION_B, AUTH_KEY],
      ],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relayUrl).toBe(ONION);
      expect(parsed.join.community.onionAuthKey).toBeUndefined(); // primary's auth was null
      expect(parsed.join.community.relays).toEqual([
        {url: ONION, onionAuthKey: null},
        {url: ONION_B, onionAuthKey: AUTH_KEY},
      ]);
    }
  });

  it('carries the primary mirror onion-auth key onto community.onionAuthKey', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, cid: CID, ik: ISSUER, rs: [[ONION, AUTH_KEY]]});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.onionAuthKey).toBe(AUTH_KEY);
  });

  it('caps the mirror list at MAX_MIRRORS BEFORE per-entry validation', () => {
    const onions = Array.from({length: MAX_MIRRORS + 2}, (_, i) => `ws://${String.fromCharCode(97 + i).repeat(56)}.onion`);
    const rs = onions.map(url => [url, null]);
    const text = rawJoinCode(2, {v: 2, i: INVITE, cid: CID, ik: ISSUER, rs});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relays?.length).toBe(MAX_MIRRORS);
      expect(parsed.join.community.relays?.[0]?.url).toBe(onions[0]);
    }
  });

  it('drops an individual malformed mirror (bad onion url) rather than rejecting the whole code', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      cid: CID,
      ik: ISSUER,
      rs: [
        ['ws://not-an-onion.example', null],
        [ONION, null],
      ],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relays).toEqual([{url: ONION, onionAuthKey: null}]);
      expect(parsed.join.community.relayUrl).toBe(ONION);
    }
  });

  it('drops an individual mirror whose onion-auth key is malformed (fails closed on a bad reach credential)', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      cid: CID,
      ik: ISSUER,
      rs: [
        [ONION, 'not-valid-base32'],
        [ONION_B, null],
      ],
    });
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relays).toEqual([{url: ONION_B, onionAuthKey: null}]);
    }
  });

  it('rejects the whole code when every mirror is malformed', () => {
    const text = rawJoinCode(2, {
      v: 2,
      i: INVITE,
      cid: CID,
      ik: ISSUER,
      rs: [['ws://not-an-onion.example', null]],
    });
    expect(parseJoinCode(text).ok).toBe(false);
  });

  it('falls back to the legacy r+oa pair as a one-element list when rs is absent', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, cid: CID, ik: ISSUER, r: ONION_C, oa: AUTH_KEY});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relayUrl).toBe(ONION_C);
      expect(parsed.join.community.onionAuthKey).toBe(AUTH_KEY);
      expect(parsed.join.community.relays).toEqual([{url: ONION_C, onionAuthKey: AUTH_KEY}]);
    }
  });

  it('rejects when both rs and the r fallback are absent/invalid', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, cid: CID, ik: ISSUER});
    expect(parseJoinCode(text).ok).toBe(false);
  });
});

// v2 relay-independent identity (cid) + deferred enrollment key.
describe('join code — v2 identity (cid) and deferred issuer key', () => {
  it('defers the issuer key when ik is absent but cid is present', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.issuerPublicKey).toBe('');
      expect(parsed.join.community.cid).toBe(CID.toLowerCase());
    }
  });

  it('rejects when both ik and cid are absent (nothing to enroll against or verify later)', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]]});
    expect(parseJoinCode(text).ok).toBe(false);
  });

  it('accepts an inline ik whose fingerprint matches cid, resolving the key immediately', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID, ik: ISSUER});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.issuerPublicKey).toBe(ISSUER);
      expect(parsed.join.community.cid).toBe(CID.toLowerCase());
    }
  });

  it('rejects an inline ik that does NOT match cid (fail closed on mis-provisioning)', () => {
    const wrongCid = '0'.repeat(16);
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: wrongCid, ik: ISSUER});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('does not match community id');
  });

  it('accepts an inline ik with no cid at all (cid is only required when ik is absent)', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], ik: ISSUER});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.issuerPublicKey).toBe(ISSUER);
      expect(parsed.join.community.cid).toBeUndefined();
    }
  });

  it('rejects a malformed cid (wrong length / not hex)', () => {
    const tooShort = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: 'abcd', ik: ISSUER});
    expect(parseJoinCode(tooShort).ok).toBe(false);
    const notHex = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: 'g'.repeat(16), ik: ISSUER});
    expect(parseJoinCode(notHex).ok).toBe(false);
  });

  it('lower-cases an upper-case cid on parse', () => {
    const text = rawJoinCode(2, {v: 2, i: INVITE, rs: [[ONION, null]], cid: CID.toUpperCase(), ik: ISSUER});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.cid).toBe(CID.toLowerCase());
  });
});

describe('join code — v2 advisory expiry (x)', () => {
  it('parses x into community.advisoryExpiry', () => {
    const text = encodeJoinCode({community: {...FULL, advisoryExpiry: 1999999999}, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.advisoryExpiry).toBe(1999999999);
  });

  it('leaves advisoryExpiry undefined when x is absent', () => {
    const text = encodeJoinCode({community: FULL, inviteCode: INVITE});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.advisoryExpiry).toBeUndefined();
  });
});

describe('enrollKeyMatchesCid', () => {
  it('matches when the recomputed fingerprint agrees with cid', () => {
    expect(enrollKeyMatchesCid(ISSUER, walletKeyFingerprint(ISSUER))).toBe(true);
  });

  it('is case-insensitive on cid', () => {
    expect(enrollKeyMatchesCid(ISSUER, walletKeyFingerprint(ISSUER).toUpperCase())).toBe(true);
  });

  it('fails closed on a mismatched cid', () => {
    expect(enrollKeyMatchesCid(ISSUER, '0'.repeat(16))).toBe(false);
  });

  it('fails closed on empty inputs', () => {
    expect(enrollKeyMatchesCid('', walletKeyFingerprint(ISSUER))).toBe(false);
    expect(enrollKeyMatchesCid(ISSUER, '')).toBe(false);
  });
});

// v1 codes (`stiq:join:1:…`) must still parse — old QRs/mailboxes may still hand them out.
describe('join code v1 (legacy, hand-built envelope)', () => {
  it('parses an inline-ik v1 code unchanged, and derives cid for display only', () => {
    const text = rawJoinCode(1, {v: 1, r: ONION, ik: ISSUER, i: INVITE, cn: 'Acme', op: ORG_PUB});
    const parsed = parseJoinCode(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.community.relayUrl).toBe(ONION);
      expect(parsed.join.community.issuerPublicKey).toBe(ISSUER);
      expect(parsed.join.community.cid).toBe(walletKeyFingerprint(ISSUER));
      expect(parsed.join.community.relays).toBeUndefined(); // v1 carries no mirror list
      expect(parsed.join.community.name).toBe('Acme');
    }
  });

  it('still requires ik inline (no deferral on v1)', () => {
    const text = rawJoinCode(1, {v: 1, r: ONION, i: INVITE});
    expect(parseJoinCode(text).ok).toBe(false);
  });

  it('still requires a valid onion relay (no rs fallback on v1)', () => {
    const text = rawJoinCode(1, {v: 1, r: 'ws://not-an-onion.example', ik: ISSUER, i: INVITE});
    expect(parseJoinCode(text).ok).toBe(false);
  });

  it('parses the v4 onion-auth key (oa) on a v1 envelope', () => {
    const text = rawJoinCode(1, {v: 1, r: ONION, ik: ISSUER, i: INVITE, oa: AUTH_KEY});
    const parsed = parseJoinCode(text);
    expect(parsed.ok && parsed.join.community.onionAuthKey).toBe(AUTH_KEY);
  });
});

describe('cross-impl: organizer-produced join code', () => {
  // Produced by the organizer's buildJoinCode() (issuer/organizer-server.mjs) — pinning the
  // wire format so the two implementations can't silently drift. This is a v1 fixture (pre-dating
  // the v2 rollout); v1 parsing is unchanged so it must keep parsing exactly as before.
  const FROM_ORGANIZER =
    'stiq:join:1:eyJ2IjoxLCJyIjoid3M6Ly9hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYS5vbmlvbiIsImNuIjoiQWNtZSIsIm9uIjoiQWxpY2UiLCJpayI6IklTU1VFUktFWUI2NCIsIm9wIjoiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZiIsImkiOiJTVElRLUFCQ0QtMjM0NS1NTlBRIn0';

  it('parses what the organizer server emits', () => {
    const parsed = parseJoinCode(FROM_ORGANIZER);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.join.inviteCode).toBe('STIQ-ABCD-2345-MNPQ');
      expect(parsed.join.community.name).toBe('Acme');
      expect(parsed.join.community.organizerLabel).toBe('Alice');
      expect(parsed.join.community.organizerPubkey).toBe('f'.repeat(64));
      expect(parsed.join.community.issuerPublicKey).toBe('ISSUERKEYB64');
    }
  });
});

describe('isInviteCode', () => {
  it('accepts a 12-char three-group code', () => {
    expect(isInviteCode('STIQ-ABCD-2345-MNPQ')).toBe(true);
    expect(isInviteCode('stiq-abcd-2345-mnpq')).toBe(true);
  });
  it('rejects the old two-group code', () => {
    expect(isInviteCode('STIQ-ABCD-2345')).toBe(false);
  });
});

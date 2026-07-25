import {encodeCommunity, parseCommunity} from './community';
import {log} from '../util/log';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const ISSUER = 'TUlJQklqQU5CZ2tx'; // opaque base64-ish issuer key
// A structurally-valid 32-byte community key (base64) — parseCommunity now enforces this width
// (mirrors decodeCommunityKey), so fixtures must decode to exactly 32 bytes, not just be "base64-ish".
const CK32 = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

describe('community bootstrap', () => {
  it('round-trips', () => {
    const text = encodeCommunity({relayUrl: ONION, issuerPublicKey: ISSUER});
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.relayUrl).toBe(ONION);
      expect(parsed.community.issuerPublicKey).toBe(ISSUER);
    }
  });

  it('rejects a non-stiq code', () => {
    expect(parseCommunity('https://evil.example').ok).toBe(false);
  });

  it('v3 round-trips the community key', () => {
    const NPUB = 'npub1' + 'q'.repeat(58);
    const CK = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
    const text = encodeCommunity({
      relayUrl: ONION,
      issuerPublicKey: ISSUER,
      organizerNpub: NPUB,
      communityKey: CK,
    });
    expect(text.startsWith('stiq:community:3;')).toBe(true);
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.organizerNpub).toBe(NPUB);
      expect(parsed.community.communityKey).toBe(CK);
    }
  });

  it('v2 codes still parse (no community key)', () => {
    const parsed = parseCommunity(`stiq:community:2;${ONION};${ISSUER}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.community.communityKey).toBeUndefined();
  });

  it('rejects a clearnet relay', () => {
    expect(parseCommunity(`stiq:community:1;ws://relay.example.com;${ISSUER}`).ok).toBe(false);
  });

  it('rejects a missing issuer key', () => {
    expect(parseCommunity(`stiq:community:1;${ONION};`).ok).toBe(false);
  });

  it('rejects a below-minimum community version', () => {
    expect(parseCommunity(`stiq:community:0;${ONION};${ISSUER}`).ok).toBe(false);
  });

  it('rejects a malformed (non-numeric) community version', () => {
    expect(parseCommunity(`stiq:community:abc;${ONION};${ISSUER}`).ok).toBe(false);
  });

  // Forward-compat (Architecture Component 8): a version higher than this client knows about is
  // no longer an outright reject — the known leading positions still parse, so the organizer can
  // bump the community-code format without bricking un-upgraded clients.
  it('accepts a newer-than-known community version, parsing known fields and warning', () => {
    const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const parsed = parseCommunity(`stiq:community:9;${ONION};${ISSUER}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.relayUrl).toBe(ONION);
      expect(parsed.community.issuerPublicKey).toBe(ISSUER);
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Structural blocker fix: a newer version may append further positional fields past the known
  // 6 slots (version;relay;issuer;organizer-npub;community-key;onion-auth-key). They must be
  // ignored, not cause a reject, so an un-upgraded client can still enroll into the community.
  it('tolerates extra trailing positional fields on a newer version', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const authKey = 'A'.repeat(52);
    const text = `stiq:community:5;${ONION};${ISSUER};${npub};${CK32};${authKey};future-field-1;future-field-2`;
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.relayUrl).toBe(ONION);
      expect(parsed.community.issuerPublicKey).toBe(ISSUER);
      expect(parsed.community.organizerNpub).toBe(npub);
      expect(parsed.community.communityKey).toBe(CK32);
      expect(parsed.community.onionAuthKey).toBe(authKey);
    }
  });

  it('parses a v1 code with no organizer (back-compat)', () => {
    const parsed = parseCommunity(`stiq:community:1;${ONION};${ISSUER}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.organizerNpub).toBeUndefined();
    }
  });

  it('round-trips a v2 code with an organizer npub', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const text = encodeCommunity({relayUrl: ONION, issuerPublicKey: ISSUER, organizerNpub: npub});
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.organizerNpub).toBe(npub);
    }
  });

  it('rejects a v2 organizer field that is not an npub', () => {
    expect(parseCommunity(`stiq:community:2;${ONION};${ISSUER};deadbeef`).ok).toBe(false);
  });

  it('round-trips a v3 code carrying the shared community key', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const ck = CK32;
    const text = encodeCommunity({
      relayUrl: ONION,
      issuerPublicKey: ISSUER,
      organizerNpub: npub,
      communityKey: ck,
    });
    expect(text.startsWith('stiq:community:3;')).toBe(true);
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.organizerNpub).toBe(npub);
      expect(parsed.community.communityKey).toBe(ck);
    }
  });

  it('parses a raw v3 code and extracts the community key (5th field)', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const ck = CK32;
    const parsed = parseCommunity(`stiq:community:3;${ONION};${ISSUER};${npub};${ck}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.community.communityKey).toBe(ck);
  });

  it('emits a v2 code (no key) when the community key is absent', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const text = encodeCommunity({relayUrl: ONION, issuerPublicKey: ISSUER, organizerNpub: npub});
    expect(text.startsWith('stiq:community:2;')).toBe(true);
    const parsed = parseCommunity(text);
    expect(parsed.ok && parsed.community.communityKey).toBeFalsy();
  });

  it('v4 round-trips the shared onion client-auth key', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const ck = CK32;
    const authKey = 'A'.repeat(52); // 52-char base32 x25519 key
    const text = encodeCommunity({
      relayUrl: ONION,
      issuerPublicKey: ISSUER,
      organizerNpub: npub,
      communityKey: ck,
      onionAuthKey: authKey,
    });
    expect(text.startsWith('stiq:community:4;')).toBe(true);
    const parsed = parseCommunity(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.communityKey).toBe(ck);
      expect(parsed.community.onionAuthKey).toBe(authKey);
    }
  });

  it('falls back to a v3 code when the auth key is absent', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const ck = CK32;
    const text = encodeCommunity({
      relayUrl: ONION,
      issuerPublicKey: ISSUER,
      organizerNpub: npub,
      communityKey: ck,
    });
    expect(text.startsWith('stiq:community:3;')).toBe(true);
    expect(parseCommunity(text).ok).toBe(true);
  });

  it('rejects a v4 code whose onion auth key is malformed', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const ck = CK32;
    const parsed = parseCommunity(`stiq:community:4;${ONION};${ISSUER};${npub};${ck};not-base32`);
    expect(parsed.ok).toBe(false);
  });

  // Token domain separation (#3/#4/#29): the purpose keys pk (K_post) / rk (K_read) ride the JOIN
  // code (see ./join), NOT the positional community code — mirroring how organizerPubkey/tagPolicy
  // are join-code-only. So a parsed community code always leaves them undefined, and the token draw
  // falls back to `issuerPublicKey`, exactly as before domain separation existed.
  it('leaves postIssuerPublicKey/readIssuerPublicKey undefined (they ride the join code)', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const parsed = parseCommunity(`stiq:community:4;${ONION};${ISSUER};${npub};${CK32};${'A'.repeat(52)}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.community.postIssuerPublicKey).toBeUndefined();
      expect(parsed.community.readIssuerPublicKey).toBeUndefined();
    }
  });
});

// #76 hardening: parseCommunity mirrors parseJoinCode's bounds (T8) — a community code can also
// reach the parser from an attacker-controllable QR/deep-link surface.
describe('community bootstrap — hardening (#76)', () => {
  it('rejects an oversize community code before parsing', () => {
    const huge = `stiq:community:1;${ONION};${'A'.repeat(5000)}`;
    expect(parseCommunity(huge).ok).toBe(false);
  });

  it('rejects a non-base64 issuer key', () => {
    expect(parseCommunity(`stiq:community:1;${ONION};not valid base64 %%%`).ok).toBe(false);
  });

  it('rejects an oversize issuer key', () => {
    // 2732 base64 chars decode to ~2049 bytes, just past the 2048-byte SPKI ceiling.
    expect(parseCommunity(`stiq:community:1;${ONION};${'A'.repeat(2732)}`).ok).toBe(false);
  });

  it('rejects a malformed community key (wrong length)', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const shortCk = Buffer.from(new Uint8Array(6).fill(1)).toString('base64');
    const parsed = parseCommunity(`stiq:community:3;${ONION};${ISSUER};${npub};${shortCk}`);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a malformed community key (not base64)', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const parsed = parseCommunity(`stiq:community:3;${ONION};${ISSUER};${npub};not valid base64 %%%`);
    expect(parsed.ok).toBe(false);
  });

  it('still accepts a well-formed v4 code at the boundary', () => {
    const npub = 'npub1' + 'q'.repeat(58);
    const authKey = 'A'.repeat(52);
    const text = encodeCommunity({
      relayUrl: ONION,
      issuerPublicKey: ISSUER,
      organizerNpub: npub,
      communityKey: CK32,
      onionAuthKey: authKey,
    });
    expect(parseCommunity(text).ok).toBe(true);
  });
});

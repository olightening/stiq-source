import {
  CAPS_REJECT_CODES_MACHINE_MIN,
  CAPS_SCHEMA_PURPOSE_FINGERPRINTS,
  defaultRelayCapabilities,
  fetchRelayCapabilities,
  fetchRelaySupportsNip29,
  parseRelayCapabilities,
  parseSupportedNips,
  supportsNip29,
} from './capabilities';
import {DM_POW_DIFFICULTY, ENROLL_POW_DIFFICULTY, RELAY_SUPPORTS_NIP29} from '../config';
import {FETCH_ONLY_KINDS, GROUP_KINDS, KIND_MEDIA_BLOB, SUBSCRIBED_KINDS} from '../contracts';

describe('parseRelayCapabilities', () => {
  it('parses a full stiq-capabilities block', () => {
    const doc = {
      supported_nips: [1, 11, 29, 77],
      limitation: {max_content_length: 8000, max_event_tags: 100, max_limit: 500},
      'stiq-capabilities': {
        schema_version: 3,
        enroll_pow: 16,
        dm_pow: 22,
        enforced: {blind_required: true, private_group_read_auth: true, bytes_per_token: 256, content_encryption: true, read_auth_required: true},
        purpose_key_fingerprints: {posting: 'aaa', binding: 'bbb', read: 'ccc'},
        allowed_kinds: [1, 7, 1111],
      },
    };
    const caps = parseRelayCapabilities(doc);
    expect(caps.schemaVersion).toBe(3);
    expect(caps.enrollPow).toBe(16);
    expect(caps.dmPow).toBe(22);
    expect(caps.enforcedFlags).toEqual({
      blindRequired: true,
      privateGroupReadAuth: true,
      bytesPerToken: 256,
      contentEncryption: true,
      readAuthRequired: true,
      spaceTokensRequired: false,
    });
    // posting/binding are widened to string[] SETS (T1.4/F6); a bare-string input (this legacy/
    // synthetic doc shape) normalizes into a single-entry array. `read` stays a single string.
    expect(caps.purposeKeyFingerprints).toEqual({posting: ['aaa'], binding: ['bbb'], read: 'ccc'});
    expect(caps.issuerKeys).toEqual({});
    expect(caps.allowedKinds).toEqual([1, 7, 1111]);
    expect(caps.limitation).toEqual({maxContentLength: 8000, maxEventTags: 100, maxLimit: 500});
    expect(caps.supportedNips).toEqual([1, 11, 29, 77]);
  });

  it('C5 ship-ahead safety: fallback schemaVersion is BELOW the purpose-fingerprint enforcement threshold', () => {
    // The C5 hard block only activates at/above CAPS_SCHEMA_PURPOSE_FINGERPRINTS. Today's fallback
    // caps (older relay / failed fetch) MUST report a schema below it, so enforcement can never
    // trigger a posting outage until a relay advertises a schema that pins the fingerprint format.
    expect(defaultRelayCapabilities().schemaVersion).toBeLessThan(CAPS_SCHEMA_PURPOSE_FINGERPRINTS);
  });

  it('accepts the underscore spelling stiq_capabilities', () => {
    const caps = parseRelayCapabilities({stiq_capabilities: {enroll_pow: 9, dm_pow: 19}});
    expect(caps.enrollPow).toBe(9);
    expect(caps.dmPow).toBe(19);
  });

  it('falls back to build constants when the stiq block is absent', () => {
    const caps = parseRelayCapabilities({supported_nips: [1, 11]});
    const def = defaultRelayCapabilities();
    expect(caps.enrollPow).toBe(ENROLL_POW_DIFFICULTY);
    expect(caps.dmPow).toBe(DM_POW_DIFFICULTY);
    expect(caps.schemaVersion).toBe(0);
    expect(caps.enforcedFlags.bytesPerToken).toBe(0);
    expect(caps.enforcedFlags.blindRequired).toBe(false);
    expect(caps.enforcedFlags.privateGroupReadAuth).toBe(false);
    // C7 read meter ships dark: absent block → contentEncryption false (subsystem inert).
    expect(caps.enforcedFlags.contentEncryption).toBe(false);
    expect(caps.purposeKeyFingerprints).toEqual({});
    expect(caps.issuerKeys).toEqual({});
    expect(caps.allowedKinds).toEqual(def.allowedKinds);
    // supported_nips WAS advertised (and omits 29) → honoured over the constant.
    expect(caps.supportedNips).toEqual([1, 11]);
  });

  it('defaults allowedKinds to the client kind union (SUBSCRIBED_KINDS ∪ GROUP_KINDS ∪ FETCH_ONLY_KINDS)', () => {
    // The union spans every kind the client PUBLISHES or ACCEPTS — which is not the same as what it
    // REQs. It therefore includes both off-firehose allow-lists: group kinds (arriving on a
    // group-scoped sub) and media blobs (arriving on an id-scoped fetch).
    const def = defaultRelayCapabilities();
    const union = Array.from(new Set([...SUBSCRIBED_KINDS, ...GROUP_KINDS, ...FETCH_ONLY_KINDS]));
    expect(def.allowedKinds).toEqual(union);
    expect(def.allowedKinds).toContain(KIND_MEDIA_BLOB);
  });

  it('does not throw on malformed fields and degrades each to the fallback', () => {
    const doc = {
      supported_nips: 'not-an-array',
      limitation: 42,
      'stiq-capabilities': {
        schema_version: 'x',
        enroll_pow: null,
        dm_pow: {},
        enforced: 'nope',
        purpose_key_fingerprints: [1, 2],
        allowed_kinds: 'all',
      },
    };
    expect(() => parseRelayCapabilities(doc)).not.toThrow();
    const caps = parseRelayCapabilities(doc);
    expect(caps.enrollPow).toBe(ENROLL_POW_DIFFICULTY);
    expect(caps.dmPow).toBe(DM_POW_DIFFICULTY);
    expect(caps.schemaVersion).toBe(0);
    expect(caps.enforcedFlags.bytesPerToken).toBe(0);
    expect(caps.limitation).toEqual({});
    expect(caps.purposeKeyFingerprints).toEqual({});
    expect(caps.allowedKinds).toEqual(defaultRelayCapabilities().allowedKinds);
    // supported_nips malformed → constant fallback (RELAY_SUPPORTS_NIP29).
    expect(caps.supportedNips).toEqual(RELAY_SUPPORTS_NIP29 ? [29] : []);
  });

  it('degrades individual malformed enforced/limitation sub-fields but keeps the valid ones', () => {
    const caps = parseRelayCapabilities({
      limitation: {max_content_length: 4096, max_event_tags: 'nope'},
      'stiq-capabilities': {
        enroll_pow: 14,
        enforced: {blind_required: true, bytes_per_token: 'x'},
      },
    });
    expect(caps.enrollPow).toBe(14);
    expect(caps.limitation).toEqual({maxContentLength: 4096}); // max_event_tags dropped, not thrown
    expect(caps.enforcedFlags.blindRequired).toBe(true);
    expect(caps.enforcedFlags.bytesPerToken).toBe(0); // bad value → fallback
  });

  it('never throws on non-object input and returns the fallback', () => {
    for (const bad of [null, undefined, 42, 'x', true, []]) {
      expect(() => parseRelayCapabilities(bad)).not.toThrow();
      expect(parseRelayCapabilities(bad)).toEqual(defaultRelayCapabilities());
    }
  });

  describe('issuer_keys (post-connect fetch substrate for join-code v2 deferred ik)', () => {
    it('parses the full issuer_keys block', () => {
      const caps = parseRelayCapabilities({
        'stiq-capabilities': {
          issuer_keys: {enroll: 'ENROLLKEYB64', posting: 'POSTKEYB64', read: 'READKEYB64'},
        },
      });
      expect(caps.issuerKeys).toEqual({enroll: 'ENROLLKEYB64', posting: 'POSTKEYB64', read: 'READKEYB64'});
    });

    it('defaults to {} when the block is absent', () => {
      expect(parseRelayCapabilities({}).issuerKeys).toEqual({});
      expect(defaultRelayCapabilities().issuerKeys).toEqual({});
    });

    it('maps an empty-string purpose key ("no such key") to undefined, not ""', () => {
      const caps = parseRelayCapabilities({
        'stiq-capabilities': {issuer_keys: {enroll: 'ENROLLKEYB64', posting: '', read: ''}},
      });
      expect(caps.issuerKeys.enroll).toBe('ENROLLKEYB64');
      expect(caps.issuerKeys.posting).toBeUndefined();
      expect(caps.issuerKeys.read).toBeUndefined();
    });

    it('does not throw and degrades to {} on a malformed issuer_keys value', () => {
      expect(() => parseRelayCapabilities({'stiq-capabilities': {issuer_keys: 'nope'}})).not.toThrow();
      expect(parseRelayCapabilities({'stiq-capabilities': {issuer_keys: [1, 2]}}).issuerKeys).toEqual({});
    });

    it('leaves issuer_key_fingerprints parsing untouched alongside the new issuer_keys block', () => {
      const caps = parseRelayCapabilities({
        'stiq-capabilities': {
          issuer_key_fingerprints: {posting: ['sha256:abc']},
          issuer_keys: {enroll: 'ENROLLKEYB64'},
        },
      });
      expect(caps.purposeKeyFingerprints.posting).toEqual(['abc']); // T1.4: posting is now string[]
      expect(caps.issuerKeys.enroll).toBe('ENROLLKEYB64');
    });
  });

  describe('push discovery block (T1 real-push over Tor, SHIPS DARK)', () => {
    it('defaults to undefined in the constant fallback and when the block is absent', () => {
      expect(defaultRelayCapabilities().push).toBeUndefined();
      expect(parseRelayCapabilities({}).push).toBeUndefined();
      expect(parseRelayCapabilities({'stiq-capabilities': {schema_version: 1}}).push).toBeUndefined();
    });

    it('parses watcher + ntfy onions from stiq-capabilities.push', () => {
      const caps = parseRelayCapabilities({
        'stiq-capabilities': {push: {watcher: 'abc.onion:8787', ntfy: 'abc.onion'}},
      });
      expect(caps.push).toEqual({watcher: 'abc.onion:8787', ntfy: 'abc.onion'});
    });

    it('materializes push when only one field is present, mapping "" to undefined', () => {
      expect(
        parseRelayCapabilities({'stiq-capabilities': {push: {watcher: 'w.onion:8787', ntfy: ''}}}).push,
      ).toEqual({watcher: 'w.onion:8787', ntfy: undefined});
    });

    it('stays undefined when the push block is present but both fields are empty', () => {
      expect(
        parseRelayCapabilities({'stiq-capabilities': {push: {watcher: '', ntfy: ''}}}).push,
      ).toBeUndefined();
    });

    it('does not throw and leaves push undefined on a malformed push value', () => {
      expect(() => parseRelayCapabilities({'stiq-capabilities': {push: 'nope'}})).not.toThrow();
      expect(parseRelayCapabilities({'stiq-capabilities': {push: [1, 2]}}).push).toBeUndefined();
    });
  });

  describe('C7 content-encryption read-meter flag (SHIPS DARK)', () => {
    it('defaults OFF in the constant fallback so the whole subsystem is inert', () => {
      expect(defaultRelayCapabilities().enforcedFlags.contentEncryption).toBe(false);
    });

    it('activates only when the relay explicitly advertises enforced.content_encryption: true', () => {
      expect(
        parseRelayCapabilities({'stiq-capabilities': {enforced: {content_encryption: true}}})
          .enforcedFlags.contentEncryption,
      ).toBe(true);
    });

    it('stays OFF for a malformed value or an enforced block that omits it', () => {
      expect(
        parseRelayCapabilities({'stiq-capabilities': {enforced: {content_encryption: 'yes'}}})
          .enforcedFlags.contentEncryption,
      ).toBe(false);
      expect(
        parseRelayCapabilities({'stiq-capabilities': {enforced: {blind_required: true}}})
          .enforcedFlags.contentEncryption,
      ).toBe(false);
    });
  });
});

describe('live relay NIP-11 wire format (backend compatibility, captured 2026-07-09)', () => {
  // The EXACT `stiq-capabilities` block the production relay serves. Field names/shapes here are the
  // contract: nested `pow`, `issuer_key_fingerprints` as `["sha256:<hex>"]` arrays. If the relay's
  // format drifts from this, these assertions fail and force a lock-step parser update.
  const LIVE = {
    limitation: {max_event_tags: 1000, max_content_length: 524288},
    'stiq-capabilities': {
      allowed_kinds: [0, 1, 7, 1111, 9021, 9022, 30078, 39000],
      enforced: {blind_required: false, bytes_per_token: 0, private_group_read_auth: false},
      issuer_key_fingerprints: {
        binding: ['sha256:81794a5d1532737e35df67b6d32b909819f2ae5c13dc185765a03285acaf6b25'],
        enroll: ['sha256:81794a5d1532737e35df67b6d32b909819f2ae5c13dc185765a03285acaf6b25'],
        posting: ['sha256:660093783235c521fbf2bc9551853971c8ac1f5e01700d77a13ed363060a9fef'],
      },
      pow: {dm: 20, enroll: 12},
      reject_codes_version: 1,
      schema_version: 1,
      token_domain_sep: true,
    },
    supported_nips: [1, 11, 40, 42, 70, 86, 29, 53, 9, 45, 77],
  };

  it('reads the nested pow object (pow.enroll / pow.dm), not the flat spelling', () => {
    const caps = parseRelayCapabilities(LIVE);
    expect(caps.enrollPow).toBe(12);
    expect(caps.dmPow).toBe(20);
  });

  it('normalizes issuer_key_fingerprints arrays to bare lowercase hex (sha256: stripped)', () => {
    const caps = parseRelayCapabilities(LIVE);
    // T1.4/F6: posting/binding/enroll are widened to string[] SETS — each entry normalized, not just
    // entry[0] — so rotation-safe set-membership has the full list to compare against.
    expect(caps.purposeKeyFingerprints.posting).toEqual([
      '660093783235c521fbf2bc9551853971c8ac1f5e01700d77a13ed363060a9fef',
    ]);
    expect(caps.purposeKeyFingerprints.binding).toEqual([
      '81794a5d1532737e35df67b6d32b909819f2ae5c13dc185765a03285acaf6b25',
    ]);
    expect(caps.purposeKeyFingerprints.enroll).toEqual([
      '81794a5d1532737e35df67b6d32b909819f2ae5c13dc185765a03285acaf6b25',
    ]);
    // The relay advertises no `read` key yet → undefined (never falsely trips the read-metering trap).
    expect(caps.purposeKeyFingerprints.read).toBeUndefined();
    // T1.3 media legs (picture/audio) aren't advertised by today's LIVE fixture yet → undefined.
    expect(caps.purposeKeyFingerprints.picture).toBeUndefined();
    expect(caps.purposeKeyFingerprints.audio).toBeUndefined();
    expect(caps.purposeKeyFingerprints.spaceWrite).toBeUndefined();
  });

  it('client walletKeyFingerprint (16-hex) is a PREFIX of the relay full hash (prefix compare is valid)', () => {
    const relayPosting = parseRelayCapabilities(LIVE).purposeKeyFingerprints.posting![0]!;
    // The comparison verifyCommunityProvisioning performs: relay.slice(0, 16) for a matching community.
    expect(relayPosting.slice(0, 16)).toBe('660093783235c521');
    expect(relayPosting.length).toBe(64); // full sha256 hex, not truncated
  });

  it('T1.4/F6: normalizes a MULTI-ENTRY fingerprint array (rotation overlap), preserving every entry', () => {
    const caps = parseRelayCapabilities({
      'stiq-capabilities': {
        issuer_key_fingerprints: {
          posting: ['sha256:AAAA', 'sha256:BBBB'],
          space_write: ['sha256:CCCC'],
          picture: ['sha256:DDDD'],
          audio: ['sha256:EEEE'],
        },
      },
    });
    // Every entry survives normalization (lowercased, prefix stripped) — NOT just entry[0]. This is
    // the whole point of T1.4: a stale-vs-rotation-overlap decision needs the full set.
    expect(caps.purposeKeyFingerprints.posting).toEqual(['aaaa', 'bbbb']);
    expect(caps.purposeKeyFingerprints.spaceWrite).toEqual(['cccc']);
    expect(caps.purposeKeyFingerprints.picture).toEqual(['dddd']);
    expect(caps.purposeKeyFingerprints.audio).toEqual(['eeee']);
  });

  it('T1.4: a bare (non-array) legacy fingerprint string still normalizes into a single-entry array', () => {
    const caps = parseRelayCapabilities({
      'stiq-capabilities': {purpose_key_fingerprints: {space_write: 'sha256:FEED'}},
    });
    expect(caps.purposeKeyFingerprints.spaceWrite).toEqual(['feed']);
  });

  it('T1.4: an absent/malformed fingerprint field degrades to undefined, never an empty array', () => {
    const caps = parseRelayCapabilities({
      'stiq-capabilities': {issuer_key_fingerprints: {posting: [], space_write: [123, null]}},
    });
    expect(caps.purposeKeyFingerprints.posting).toBeUndefined();
    expect(caps.purposeKeyFingerprints.spaceWrite).toBeUndefined();
  });

  it('reads enforced flags + limitation + supported_nips from the live doc', () => {
    const caps = parseRelayCapabilities(LIVE);
    expect(caps.enforcedFlags.blindRequired).toBe(false);
    expect(caps.enforcedFlags.bytesPerToken).toBe(0);
    expect(caps.enforcedFlags.contentEncryption).toBe(false); // read meter stays dark
    expect(caps.limitation).toEqual({maxContentLength: 524288, maxEventTags: 1000});
    expect(caps.supportedNips).toContain(29);
    expect(caps.allowedKinds).toContain(9021);
  });

  it('CRITICAL ship-ahead invariant: the live relay schema is BELOW the C5 enforcement threshold', () => {
    // If this ever fails, the C5 hard block is armed against the production relay and a single
    // fingerprint-parse discrepancy becomes a community-wide posting outage. The threshold MUST stay
    // strictly above whatever the live relay advertises (today schema_version 1).
    expect(parseRelayCapabilities(LIVE).schemaVersion).toBeLessThan(CAPS_SCHEMA_PURPOSE_FINGERPRINTS);
  });
});

describe('reject_codes_version (T12 machine reject-code gate)', () => {
  it('parses reject_codes_version from the stiq block', () => {
    const caps = parseRelayCapabilities({'stiq-capabilities': {reject_codes_version: 3}});
    expect(caps.rejectCodesVersion).toBe(3);
  });

  it('defaults to 0 when absent (fallback caps and an absent field)', () => {
    expect(defaultRelayCapabilities().rejectCodesVersion).toBe(0);
    expect(parseRelayCapabilities({}).rejectCodesVersion).toBe(0);
    expect(parseRelayCapabilities({'stiq-capabilities': {schema_version: 1}}).rejectCodesVersion).toBe(0);
  });

  it('degrades a malformed value to the fallback 0 without throwing', () => {
    expect(parseRelayCapabilities({'stiq-capabilities': {reject_codes_version: 'x'}}).rejectCodesVersion).toBe(
      0,
    );
  });

  it('the live relay advertises reject_codes_version 1 — BELOW the machine-code trust threshold', () => {
    // Ship-ahead: the client that understands v3 ships first; the retry-decision trust stays dark
    // until a relay advertises reject_codes_version >= CAPS_REJECT_CODES_MACHINE_MIN.
    const live = parseRelayCapabilities({'stiq-capabilities': {reject_codes_version: 1, schema_version: 1}});
    expect(live.rejectCodesVersion).toBeLessThan(CAPS_REJECT_CODES_MACHINE_MIN);
  });

  it('CAPS_REJECT_CODES_MACHINE_MIN is 3', () => {
    expect(CAPS_REJECT_CODES_MACHINE_MIN).toBe(3);
  });
});

describe('parseSupportedNips / supportsNip29 (back-compat)', () => {
  it('extracts supported_nips', () => {
    expect(parseSupportedNips({supported_nips: [1, 29, 77]})).toEqual([1, 29, 77]);
    expect(parseSupportedNips(null)).toEqual([]);
    expect(parseSupportedNips({})).toEqual([]);
    expect(parseSupportedNips({supported_nips: 'x'})).toEqual([]);
  });
  it('detects NIP-29', () => {
    expect(supportsNip29({supported_nips: [1, 11, 45]})).toBe(false);
    expect(supportsNip29({supported_nips: [29]})).toBe(true);
  });
});

describe('NIP-29 gate resolves from caps when present, from the build constant when absent', () => {
  it('reads NIP-29 from an advertised supported_nips', () => {
    expect(parseRelayCapabilities({supported_nips: [1, 29]}).supportedNips.includes(29)).toBe(true);
    expect(parseRelayCapabilities({supported_nips: [1, 11]}).supportedNips.includes(29)).toBe(false);
  });
  it('falls back to RELAY_SUPPORTS_NIP29 when supported_nips is absent', () => {
    expect(defaultRelayCapabilities().supportedNips.includes(29)).toBe(RELAY_SUPPORTS_NIP29);
    expect(parseRelayCapabilities({}).supportedNips.includes(29)).toBe(RELAY_SUPPORTS_NIP29);
  });
});

describe('fetchRelayCapabilities', () => {
  it('parses the fetched doc', async () => {
    const caps = await fetchRelayCapabilities(async () => ({'stiq-capabilities': {enroll_pow: 20}}));
    expect(caps.enrollPow).toBe(20);
  });
  it('returns the constant fallback when the getter rejects', async () => {
    const caps = await fetchRelayCapabilities(async () => {
      throw new Error('tor down');
    });
    expect(caps).toEqual(defaultRelayCapabilities());
  });
});

describe('fetchRelaySupportsNip29 (back-compat)', () => {
  it('resolves from the fetched doc', async () => {
    await expect(fetchRelaySupportsNip29(async () => ({supported_nips: [29]}))).resolves.toBe(true);
    await expect(fetchRelaySupportsNip29(async () => ({supported_nips: [1]}))).resolves.toBe(false);
  });
  it('resolves false when the getter rejects', async () => {
    await expect(
      fetchRelaySupportsNip29(async () => {
        throw new Error('tor down');
      }),
    ).resolves.toBe(false);
  });
});

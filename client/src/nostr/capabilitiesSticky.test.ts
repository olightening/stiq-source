import {explicitEnforcedFlags, parseRelayCapabilities} from './capabilities';

/**
 * explicitEnforcedFlags — the "did the relay actually SAY that?" companion to
 * parseRelayCapabilities. The parser maps an ABSENT enforcement field to the constant fallback,
 * which is indistinguishable from an explicit downgrade; the sticky-enforcement contract
 * (2026-07-28 caps-fallback fix) needs the distinction, so this reader returns ONLY the fields the
 * document explicitly advertises with the right type. These tests pin that partiality: nothing is
 * ever invented, nothing explicit is ever dropped, and every value the parser would adopt for an
 * explicit field is byte-identical here.
 */
describe('explicitEnforcedFlags', () => {
  it('returns {} for junk documents (undefined, null, arrays, no stiq block, no enforced object)', () => {
    expect(explicitEnforcedFlags(undefined)).toEqual({});
    expect(explicitEnforcedFlags(null)).toEqual({});
    expect(explicitEnforcedFlags([])).toEqual({});
    expect(explicitEnforcedFlags({})).toEqual({});
    expect(explicitEnforcedFlags({'stiq-capabilities': {}})).toEqual({});
    expect(explicitEnforcedFlags({'stiq-capabilities': {enforced: 'yes'}})).toEqual({});
  });

  it('returns ONLY the fields the document explicitly advertises', () => {
    const out = explicitEnforcedFlags({
      'stiq-capabilities': {enforced: {space_tokens_required: true}},
    });
    expect(out).toEqual({spaceTokensRequired: true});
    // The absent fields are genuinely ABSENT — not present-as-false. This partiality is the whole
    // point: an overlay of this result must never touch a field the doc didn't speak to.
    expect('blindRequired' in out).toBe(false);
    expect('bytesPerToken' in out).toBe(false);
  });

  it('an explicit FALSE is carried (a real downgrade advertisement is not absence)', () => {
    expect(
      explicitEnforcedFlags({'stiq-capabilities': {enforced: {space_tokens_required: false}}}),
    ).toEqual({spaceTokensRequired: false});
  });

  it('reads every enforcement field, both block spellings, and agrees with the parser', () => {
    const enforced = {
      blind_required: true,
      private_group_read_auth: true,
      bytes_per_token: 512,
      content_encryption: true,
      read_auth_required: true,
      space_tokens_required: true,
    };
    for (const spelling of ['stiq-capabilities', 'stiq_capabilities'] as const) {
      const doc = {[spelling]: {enforced}};
      const explicit = explicitEnforcedFlags(doc);
      expect(explicit).toEqual({
        blindRequired: true,
        privateGroupReadAuth: true,
        bytesPerToken: 512,
        contentEncryption: true,
        readAuthRequired: true,
        spaceTokensRequired: true,
      });
      // Overlay-safety invariant: for every explicitly-advertised field, the value here matches
      // what parseRelayCapabilities adopts — overlaying explicit on parsed is always a no-op.
      expect(parseRelayCapabilities(doc).enforcedFlags).toEqual(
        expect.objectContaining(explicit),
      );
    }
  });

  it('ignores wrongly-typed fields instead of guessing', () => {
    expect(
      explicitEnforcedFlags({
        'stiq-capabilities': {
          enforced: {
            space_tokens_required: 'true', // string, not boolean
            bytes_per_token: NaN, // not finite
            blind_required: 1, // number, not boolean
          },
        },
      }),
    ).toEqual({});
  });
});

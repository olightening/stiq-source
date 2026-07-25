import {parseRelayCapabilities, defaultRelayCapabilities} from './capabilities';

// Tokens-everywhere + Phase-4d activation signals in the parsed relay capabilities.
describe('space_tokens_required + media_write_domains capability parsing', () => {
  it('defaults to off / no media domains (older relay, or omitted fields)', () => {
    const caps = defaultRelayCapabilities();
    expect(caps.enforcedFlags.spaceTokensRequired).toBe(false);
    expect(caps.mediaWriteDomains).toEqual({picture: false, audio: false});
  });

  it('reads space_tokens_required from the enforced block', () => {
    const caps = parseRelayCapabilities({
      'stiq-capabilities': {enforced: {space_tokens_required: true}},
    });
    expect(caps.enforcedFlags.spaceTokensRequired).toBe(true);
  });

  it('a missing space_tokens_required stays false (never throws)', () => {
    const caps = parseRelayCapabilities({'stiq-capabilities': {enforced: {blind_required: true}}});
    expect(caps.enforcedFlags.spaceTokensRequired).toBe(false);
  });

  it('parses media_write_domains into per-domain booleans', () => {
    const caps = parseRelayCapabilities({
      'stiq-capabilities': {media_write_domains: ['picture']},
    });
    expect(caps.mediaWriteDomains).toEqual({picture: true, audio: false});

    const both = parseRelayCapabilities({
      'stiq-capabilities': {media_write_domains: ['picture', 'audio']},
    });
    expect(both.mediaWriteDomains).toEqual({picture: true, audio: true});
  });

  it('a non-array media_write_domains is ignored (both false)', () => {
    const caps = parseRelayCapabilities({'stiq-capabilities': {media_write_domains: 'picture'}});
    expect(caps.mediaWriteDomains).toEqual({picture: false, audio: false});
  });
});

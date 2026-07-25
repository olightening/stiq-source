import {
  isRetryable,
  legacyRetryable,
  parseRejection,
  RETRYABLE_CODES,
  type ParsedRejection,
} from './rejection';

describe('parseRejection — bracket code is authoritative', () => {
  it('strips the leading [code] bracket and keeps the trailing prose', () => {
    const p = parseRejection('[token_required] blocked: this community requires a posting token');
    expect(p.code).toBe('token_required');
    expect(p.prose).toBe('blocked: this community requires a posting token');
  });

  it('handles a snake_case code with digits and no space after the bracket', () => {
    const p = parseRejection('[pow_insufficient]work harder');
    expect(p.code).toBe('pow_insufficient');
    expect(p.prose).toBe('work harder');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseRejection('   [tag_scope] blocked: nope   ').code).toBe('tag_scope');
  });

  it('empty prose after the bracket yields code with empty prose', () => {
    const p = parseRejection('[token_spent]');
    expect(p).toEqual({code: 'token_spent', prose: '', params: {}});
  });

  // T0.5: the relay's actual wire shape for the tokens-everywhere space-write gate
  // (membership.go gateSpaceTokens) — pins that the generic bracket parse needs no code-specific
  // change to recognize it, matching how every other code here is handled.
  it('parses space_token_required (tokens-everywhere space-write gate)', () => {
    const p = parseRejection('[space_token_required] blocked: this community requires a space token for this content');
    expect(p.code).toBe('space_token_required');
    expect(p.prose).toBe('blocked: this community requires a space token for this content');
  });
});

describe('parseRejection — legacy bare "code:" prose fallback (no bracket)', () => {
  it('reads the bare prose prefix as the code and keeps the WHOLE message as prose', () => {
    const p = parseRejection('blocked: rejected');
    expect(p.code).toBe('blocked');
    expect(p.prose).toBe('blocked: rejected');
  });

  it('reads a hyphenated legacy prefix', () => {
    expect(parseRejection('auth-required: please authenticate').code).toBe('auth-required');
    expect(parseRejection('rate-limited: slow down').code).toBe('rate-limited');
  });

  it('yields an empty code (never throws) for prose with no recognizable prefix', () => {
    const p = parseRejection('some brand new relay message');
    expect(p.code).toBe('');
    expect(p.prose).toBe('some brand new relay message');
  });

  it('handles the empty string without throwing', () => {
    expect(parseRejection('')).toEqual({code: '', prose: '', params: {}});
  });
});

describe('parseRejection — embedded param extraction', () => {
  it('extracts count vs cap "(actual, max N)" (too_many_tags / too_many_tokens)', () => {
    expect(parseRejection('[too_many_tags] blocked: too many tags (3, max 2)').params).toEqual({
      actual: 3,
      max: 2,
    });
  });

  it('extracts byte size "(N bytes, max N)" (event_too_large), not the plain (n, max n)', () => {
    expect(
      parseRejection('[event_too_large] invalid: event is too large (500000 bytes, max 262144)').params,
    ).toEqual({actual: 500000, max: 262144});
  });

  it('extracts token balance "needs N tokens, has N" (token_insufficient)', () => {
    expect(parseRejection('[token_insufficient] blocked: event needs 3 tokens, has 1').params).toEqual({
      need: 3,
      have: 1,
    });
  });

  it('extracts content length "is N X; this community allows at most N"', () => {
    expect(
      parseRejection('[content_too_long] blocked: post is 500 characters; this community allows at most 280')
        .params,
    ).toEqual({actual: 500, max: 280});
  });

  it('extracts media count "N media items; this community allows at most N"', () => {
    expect(
      parseRejection('[too_much_media] blocked: post has 5 media items; this community allows at most 4')
        .params,
    ).toEqual({actual: 5, max: 4});
  });

  it('extracts the rate-limit period word', () => {
    expect(parseRejection('[rate_limited] blocked: daily post limit reached').params.period).toBe('daily');
    expect(parseRejection('[rate_limited] blocked: weekly post limit reached').params.period).toBe(
      'weekly',
    );
    expect(parseRejection('[rate_limited] blocked: monthly post limit reached').params.period).toBe(
      'monthly',
    );
  });

  it('extracts retry_after=<sec>', () => {
    const p = parseRejection(
      '[rate_limited_dm] blocked: community DM rate limit reached, try again shortly (retry_after=60)',
    );
    expect(p.params.retryAfterSec).toBe(60);
  });

  it('leaves params empty when there are no numbers to scrape', () => {
    expect(parseRejection('[not_a_member] blocked: you are not a member').params).toEqual({});
  });
});

describe('RETRYABLE_CODES membership', () => {
  it('contains exactly the transient relay states', () => {
    for (const c of [
      'rate_limited_dm',
      'rate_limited_mailbox',
      'record_token_error',
      'record_membership_error',
    ]) {
      expect(RETRYABLE_CODES.has(c)).toBe(true);
    }
  });

  it('excludes terminal codes', () => {
    for (const c of [
      'token_required',
      'content_too_long',
      'too_many_tags',
      'tag_scope',
      'not_a_member',
      'pow_insufficient',
      'rate_limited',
      'kind_not_permitted',
    ]) {
      expect(RETRYABLE_CODES.has(c)).toBe(false);
    }
  });
});

describe('isRetryable — trusted code-table path', () => {
  const parse = (m: string): ParsedRejection => parseRejection(m);

  it('fixes the too_many_tags mis-classification: terminal under trust', () => {
    const p = parse('[too_many_tags] blocked: too many tags (3, max 2)');
    expect(isRetryable(p, {trustCodes: true})).toBe(false);
  });

  it('treats rate_limited_dm as retryable under trust (with retry_after present)', () => {
    const p = parse(
      '[rate_limited_dm] blocked: community DM rate limit reached, try again shortly (retry_after=60)',
    );
    expect(isRetryable(p, {trustCodes: true})).toBe(true);
  });

  it('treats rate_limited_mailbox and record_* as retryable under trust', () => {
    expect(isRetryable(parse('[rate_limited_mailbox] blocked: mailbox busy'), {trustCodes: true})).toBe(
      true,
    );
    expect(
      isRetryable(parse('[record_token_error] error: could not record token'), {trustCodes: true}),
    ).toBe(true);
  });

  it('treats token_required as terminal under trust', () => {
    expect(
      isRetryable(parse('[token_required] blocked: requires a posting token'), {trustCodes: true}),
    ).toBe(false);
  });

  // T0.5 (tokens-everywhere, RejectCodesVersion 4): space_token_required is the space-write sibling of
  // token_required — same terminal shape (a same-event retry without a token just repeats the reject).
  it('treats space_token_required as terminal under trust (T0.5)', () => {
    expect(
      isRetryable(
        parse('[space_token_required] blocked: this community requires a space token for this content'),
        {trustCodes: true},
      ),
    ).toBe(false);
  });

  it('with trustCodes but an EMPTY code, falls back to the legacy heuristic', () => {
    // No bracket, no bare prefix → code '' → cannot trust the table, use legacy prose.
    expect(isRetryable(parse('please try again later'), {trustCodes: true})).toBe(true);
    expect(isRetryable(parse('some brand new relay message'), {trustCodes: true})).toBe(false);
  });
});

describe('isRetryable — untrusted (legacy) path preserves today behaviour', () => {
  const parse = (m: string): ParsedRejection => parseRejection(m);

  it('rate_limited_dm is NOT retryable via the legacy heuristic (blocked: prefix wins)', () => {
    const p = parse(
      '[rate_limited_dm] blocked: community DM rate limit reached, try again shortly (retry_after=60)',
    );
    // The bracket code is transient, but untrusted → the legacy prose sees "blocked:" → terminal.
    expect(isRetryable(p, {trustCodes: false})).toBe(false);
  });

  it('a transient substring still flips retryable under the untrusted path', () => {
    expect(isRetryable(parse('please slow down'), {trustCodes: false})).toBe(true);
    expect(isRetryable(parse('[record_token_error] error: could not record token'), {trustCodes: false})).toBe(
      true,
    );
  });

  it('permanent prefixes stay terminal under the untrusted path', () => {
    expect(isRetryable(parse('blocked: banned'), {trustCodes: false})).toBe(false);
    expect(isRetryable(parse('invalid: bad sig'), {trustCodes: false})).toBe(false);
  });

  // T0.5: pins that BOTH the trusted code-table path and the untrusted legacy prose heuristic agree
  // space_token_required is terminal — the relay's own wire prose ("blocked: …") is what the legacy
  // path keys on, so this holds even before a relay advertises reject_codes_version >= 4.
  it('space_token_required is NOT retryable via the legacy heuristic either (T0.5)', () => {
    expect(
      isRetryable(
        parse('[space_token_required] blocked: this community requires a space token for this content'),
        {trustCodes: false},
      ),
    ).toBe(false);
  });
});

describe('legacyRetryable — verbatim pre-T12 prose heuristic', () => {
  it('permanent prefixes → false', () => {
    expect(legacyRetryable('blocked: banned author')).toBe(false);
    expect(legacyRetryable('invalid: bad signature')).toBe(false);
    expect(legacyRetryable('auth-required: please authenticate')).toBe(false);
    expect(legacyRetryable('restricted: not a member')).toBe(false);
    expect(legacyRetryable('pow: 24 bits needed')).toBe(false);
  });

  it('transient classes → true', () => {
    expect(legacyRetryable('rate-limited: slow down')).toBe(true);
    expect(legacyRetryable('error: too many events')).toBe(true);
    expect(legacyRetryable('please slow down')).toBe(true);
    expect(legacyRetryable('try again later')).toBe(true);
    expect(legacyRetryable('temporarily unavailable')).toBe(true);
    expect(legacyRetryable('duplicate: have this event')).toBe(true);
  });

  it('a permanent prefix wins over a transient phrase in its text', () => {
    expect(legacyRetryable('blocked: too many tags')).toBe(false);
  });

  it('unknown / empty → false (B1 terminal default)', () => {
    expect(legacyRetryable('some brand new relay message')).toBe(false);
    expect(legacyRetryable('')).toBe(false);
    expect(legacyRetryable('mystery: not a known code')).toBe(false);
  });

  it('bracketed transient storage codes → true', () => {
    expect(legacyRetryable('[record_token_error] error: could not record token')).toBe(true);
    expect(legacyRetryable('[record_membership_error] error: could not record membership')).toBe(true);
  });
});

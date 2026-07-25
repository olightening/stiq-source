import {calmRejection} from './rejectionMessages';
import {isRetryable, parseRejection} from '../nostr/rejection';

/** Guard the acceptance rule: no calm text/next-step may leak a bracket, a bare "blocked:", or a code. */
function assertClean(c: {text: string; nextStep?: string}): void {
  for (const s of [c.text, c.nextStep ?? '']) {
    expect(s).not.toMatch(/\[[a-z0-9_]+\]/i);
    expect(s.toLowerCase()).not.toContain('blocked:');
    expect(s.toLowerCase()).not.toContain('invalid:');
    expect(s).not.toMatch(/\b[a-z]+_[a-z_]+\b/); // no snake_case machine code
  }
}

describe('calmRejection — token family', () => {
  it('token_required → out-of-tokens copy + get-more next-step, terminal', () => {
    const c = calmRejection('[token_required] blocked: this community requires a posting token');
    expect(c).toEqual({
      text: "You're out of posting tokens.",
      nextStep: 'Get more tokens, then resend.',
      retryable: false,
    });
    assertClean(c);
  });

  // T0.5 (tokens-everywhere, RejectCodesVersion 4): space_token_required is the channel/group/DM
  // sibling of token_required — same "out of tokens" shape, worded for the space surface. Previously
  // this code fell through to the raw-prose default, leaking the relay's "blocked: this community
  // requires a space token for this content" wire prose straight to the user (F4).
  it('space_token_required → out-of-tokens copy worded for a space, terminal', () => {
    const c = calmRejection('[space_token_required] blocked: this community requires a space token for this content');
    expect(c).toEqual({
      text: "You're out of tokens to send here.",
      nextStep: 'Get more tokens, then resend.',
      retryable: false,
    });
    assertClean(c);
  });

  it('token_insufficient → fills in need/have', () => {
    const c = calmRejection('[token_insufficient] blocked: event needs 3 tokens, has 1');
    expect(c.text).toContain('3');
    expect(c.text).toContain('1');
    expect(c.text).toBe('This post needs 3 tokens; you have 1.');
    expect(c.retryable).toBe(false);
    assertClean(c);
  });
});

describe('calmRejection — content / size limits (real number filled in)', () => {
  it('content_too_long mentions the 280 cap', () => {
    const c = calmRejection(
      '[content_too_long] blocked: post is 500 characters; this community allows at most 280',
    );
    expect(c.text).toContain('280');
    expect(c.nextStep).toBe('Shorten it and resend.');
    expect(c.retryable).toBe(false);
    assertClean(c);
  });

  it('event_too_large converts bytes to KB', () => {
    const c = calmRejection('[event_too_large] invalid: event is too large (500000 bytes, max 262144)');
    expect(c.text).toBe('This post is too large (max 256 KB).');
    assertClean(c);
  });

  it('too_much_media uses the media cap', () => {
    const c = calmRejection('[too_much_media] blocked: post has 5 media items; this community allows at most 4');
    expect(c.text).toBe('Too many attachments (max 4).');
    assertClean(c);
  });

  it('too_many_tags uses the tag cap', () => {
    const c = calmRejection('[too_many_tags] blocked: too many tags (3, max 2)');
    expect(c.text).toBe('Too many tags (max 2).');
    expect(c.retryable).toBe(false);
    assertClean(c);
  });

  it('degrades gracefully to a number-less line when no cap is present', () => {
    const c = calmRejection('[content_too_long] blocked: post too long');
    expect(c.text).toBe('This post is too long.');
    expect(c.text).not.toContain('undefined');
    assertClean(c);
  });

  // RejectCodesVersion 5: the community's long-body word cap reaching a body that is NOT a long-form
  // article — a channel broadcast, a group message, a comment. Same rule as article_too_long; the
  // separate code exists so the copy can say "message" instead of "article" on those surfaces.
  it('body_too_long reads as a message and carries the word cap', () => {
    const c = calmRejection(
      '[body_too_long] blocked: message is 900 words; this community allows at most 500',
    );
    // "words", not "characters" — the long-body cap is a word count, and calling it characters
    // would tell the writer to cut roughly five times more than they actually need to.
    expect(c.text).toBe('This message is too long (max 500 words).');
    expect(c.text).not.toContain('article');
    expect(c.nextStep).toBe('Shorten it and resend.');
    expect(c.retryable).toBe(false);
    assertClean(c);
  });

  it('article_too_long still reads as an article', () => {
    const c = calmRejection(
      '[article_too_long] blocked: article is 900 words; this community allows at most 500',
    );
    expect(c.text).toBe('This article is too long (max 500 words).');
    assertClean(c);
  });

  it('a character-capped note still reads as characters', () => {
    const c = calmRejection(
      '[content_too_long] blocked: post is 500 characters; this community allows at most 280',
    );
    expect(c.text).toBe('This post is too long (max 280 characters).');
    assertClean(c);
  });
});

describe('calmRejection — tag scope', () => {
  it('tag_scope / tag_not_permitted → remove-the-tag next-step', () => {
    for (const code of ['tag_scope', 'tag_not_permitted']) {
      const c = calmRejection(`[${code}] blocked: tag not allowed`);
      expect(c).toEqual({
        text: "That tag isn't allowed here.",
        nextStep: 'Remove the tag and resend.',
        retryable: false,
      });
      assertClean(c);
    }
  });
});

describe('calmRejection — rate limits', () => {
  it('rate_limited daily → tomorrow, terminal', () => {
    const c = calmRejection('[rate_limited] blocked: daily post limit reached');
    expect(c).toEqual({
      text: "You've reached the daily limit.",
      nextStep: 'Try again tomorrow.',
      retryable: false,
    });
    assertClean(c);
  });

  it('rate_limited weekly / monthly → matching next-step', () => {
    expect(calmRejection('[rate_limited] blocked: weekly post limit reached').nextStep).toBe(
      'Try again next week.',
    );
    expect(calmRejection('[rate_limited] blocked: monthly post limit reached').nextStep).toBe(
      'Try again next month.',
    );
  });

  it('rate_limited_dm with retry_after → "Try again in 60s." and RETRYABLE', () => {
    const c = calmRejection(
      '[rate_limited_dm] blocked: community DM rate limit reached, try again shortly (retry_after=60)',
    );
    expect(c).toEqual({
      text: 'The community is busy right now.',
      nextStep: 'Try again in 60s.',
      retryable: true,
    });
    assertClean(c);
  });

  it('rate_limited_mailbox without retry_after → "Try again in a minute." and RETRYABLE', () => {
    const c = calmRejection('[rate_limited_mailbox] blocked: mailbox busy');
    expect(c.nextStep).toBe('Try again in a minute.');
    expect(c.retryable).toBe(true);
    assertClean(c);
  });
});

describe('calmRejection — permission / membership family (each a calm line + one next-step)', () => {
  const cases: Array<[string, string]> = [
    ['not_a_member', "You're not a member of this community."],
    ['not_group_member', "You're not in this group."],
    ['unknown_group', 'This group no longer exists.'],
    ['group_query_scope', "You can't view this group's messages."],
    ['group_missing_tag', "This message isn't tagged to a group."],
    ['group_state_managed', 'The group manages this automatically.'],
    ['moderator_denied', "Your role doesn't allow that."],
    ['broadcast_only', 'Only admins can post here.'],
    ['comments_closed', 'Comments are closed on this post.'],
    ['reactions_closed', 'Reactions are closed on this post.'],
    ['channel_organizer_only', 'Only the organizer can post in this channel.'],
    ['channel_mods_only', 'Only moderators can post in this channel.'],
    ['newcomer_links', "New members can't post links yet."],
    ['newcomer_channels', "New members can't post in channels yet."],
    ['voice_disabled', 'Voice messages are off in this community.'],
    ['config_reserved', 'Only the organizer can change this.'],
  ];

  it.each(cases)('%s → calm text, one next-step, terminal', (code, expectedText) => {
    const c = calmRejection(`[${code}] blocked: some prose`);
    expect(c.text).toBe(expectedText);
    expect(typeof c.nextStep).toBe('string');
    expect(c.nextStep!.length).toBeGreaterThan(0);
    expect(c.retryable).toBe(false);
    assertClean(c);
  });
});

describe('calmRejection — proof-of-work', () => {
  it('pow_insufficient → security-check copy with a Retry next-step', () => {
    const c = calmRejection('[pow_insufficient] pow: 24 bits needed');
    expect(c.text).toBe("Your device couldn't finish the security check.");
    expect(c.nextStep).toBe('Retry.');
    expect(c.retryable).toBe(false);
    assertClean(c);
  });

  it('pow_disabled → "This isn\'t allowed here." with no next-step', () => {
    const c = calmRejection('[pow_disabled] blocked: pow disabled');
    expect(c.text).toBe("This isn't allowed here.");
    expect(c.nextStep).toBeUndefined();
    expect(c.retryable).toBe(false);
    assertClean(c);
  });
});

describe('calmRejection — unknown-code fallback (raw prose, no throw)', () => {
  it('a bracketed unknown code shows the human prose after the bracket, no next-step', () => {
    const c = calmRejection('[brand_new_code] the relay said something new');
    expect(c.text).toBe('the relay said something new');
    expect(c.nextStep).toBeUndefined();
    expect(c.retryable).toBe(false);
  });

  it('a bracket-less legacy message falls back to the whole message', () => {
    const c = calmRejection('some brand new relay message');
    expect(c.text).toBe('some brand new relay message');
    expect(c.nextStep).toBeUndefined();
    expect(c.retryable).toBe(false);
  });

  it('an unknown transient-substring message stays retryable via the legacy heuristic', () => {
    const c = calmRejection('please try again later');
    expect(c.text).toBe('please try again later');
    expect(c.retryable).toBe(true);
  });

  it('never throws on empty input', () => {
    expect(() => calmRejection('')).not.toThrow();
    expect(calmRejection('').text).toBe('');
  });
});

/**
 * T0.5 — "both mappers agree" regression guard (Fable NB-2, "parallel-dev trap").
 *
 * `calmRejection` (this file) and `../nostr/rejection`'s {@link RETRYABLE_CODES}/{@link isRetryable}
 * are two INDEPENDENT encodings of the same fact — whether re-sending a rejected event could ever land.
 * calmRejection hardcodes `retryable` per case as advisory copy metadata (its own doc: "the actual
 * outbox retry DECISION is made elsewhere"); rejection.ts's RETRYABLE_CODES is the table that decision
 * actually consults. Nothing enforces they stay in sync — a future edit to one and not the other would
 * silently show "Retry" copy for a code the outbox has ALREADY decided never to auto-resend, or vice
 * versa. This test pins the three tokens-everywhere codes (T0.1-T0.5) agree across both files.
 */
describe('calmRejection / isRetryable — cross-file agreement on the token family (T0.5)', () => {
  const cases = [
    ['token_required', '[token_required] blocked: this community requires a posting token'],
    ['token_invalid', '[token_invalid] blocked: token failed verification'],
    ['space_token_required', '[space_token_required] blocked: this community requires a space token for this content'],
  ] as const;

  it.each(cases)('%s: calmRejection.retryable matches nostr/rejection isRetryable (trusted)', (_code, message) => {
    const calm = calmRejection(message);
    const trusted = isRetryable(parseRejection(message), {trustCodes: true});
    expect(calm.retryable).toBe(trusted);
    expect(calm.retryable).toBe(false); // and both agree it is specifically terminal, not merely equal
  });
});

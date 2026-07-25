import {
  reqMessage,
  closeMessage,
  countMessage,
  negOpenMessage,
  negMsgMessage,
  negCloseMessage,
  parseRelayMessage,
} from './protocol';

describe('NIP-01 framing', () => {
  it('builds REQ with a sub id and filters', () => {
    const msg = reqMessage('feed', [{kinds: [1, 7]}]);
    expect(JSON.parse(msg)).toEqual(['REQ', 'feed', {kinds: [1, 7]}]);
  });

  it('builds a NIP-45 COUNT request', () => {
    const msg = countMessage('c1', [{kinds: [7], '#e': ['abc']}]);
    expect(JSON.parse(msg)).toEqual(['COUNT', 'c1', {kinds: [7], '#e': ['abc']}]);
  });

  it('parses a COUNT response', () => {
    const parsed = parseRelayMessage(JSON.stringify(['COUNT', 'c1', {count: 42}]));
    expect(parsed).toEqual({type: 'COUNT', subId: 'c1', count: 42});
  });

  it('builds CLOSE', () => {
    expect(JSON.parse(closeMessage('feed'))).toEqual(['CLOSE', 'feed']);
  });

  it('parses EVENT / EOSE / OK / NOTICE / CLOSED', () => {
    const ev = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      sig: 'c'.repeat(128),
      kind: 1,
      created_at: 1_700_000_000,
      content: 'hello',
      tags: [['t', 'general']],
    };
    expect(parseRelayMessage(JSON.stringify(['EVENT', 'feed', ev]))).toEqual({
      type: 'EVENT',
      subId: 'feed',
      event: ev,
    });
    expect(parseRelayMessage(JSON.stringify(['EOSE', 'feed']))).toEqual({
      type: 'EOSE',
      subId: 'feed',
    });
    expect(parseRelayMessage(JSON.stringify(['OK', 'id1', true, 'stored']))).toEqual({
      type: 'OK',
      id: 'id1',
      accepted: true,
      message: 'stored',
    });
    expect(parseRelayMessage(JSON.stringify(['NOTICE', 'hi']))).toEqual({
      type: 'NOTICE',
      message: 'hi',
    });
    expect(parseRelayMessage(JSON.stringify(['CLOSED', 'feed', 'bye']))).toEqual({
      type: 'CLOSED',
      subId: 'feed',
      message: 'bye',
    });
  });

  it('never throws on garbage', () => {
    expect(parseRelayMessage('not json').type).toBe('UNKNOWN');
    expect(parseRelayMessage('{}').type).toBe('UNKNOWN');
    expect(parseRelayMessage('[]').type).toBe('UNKNOWN');
  });

  it('builds NIP-77 NEG frames', () => {
    expect(JSON.parse(negOpenMessage('feed', {kinds: [1]}, '6100'))).toEqual([
      'NEG-OPEN',
      'feed',
      {kinds: [1]},
      '6100',
    ]);
    expect(JSON.parse(negMsgMessage('feed', '61abcd'))).toEqual(['NEG-MSG', 'feed', '61abcd']);
    expect(JSON.parse(negCloseMessage('feed'))).toEqual(['NEG-CLOSE', 'feed']);
  });

  it('parses NEG-MSG and NEG-ERROR (go-nostr emits the latter label)', () => {
    expect(parseRelayMessage(JSON.stringify(['NEG-MSG', 'feed', '61ff']))).toEqual({
      type: 'NEG-MSG',
      subId: 'feed',
      message: '61ff',
    });
    expect(parseRelayMessage(JSON.stringify(['NEG-ERROR', 'feed', 'blocked']))).toEqual({
      type: 'NEG-ERR',
      subId: 'feed',
      reason: 'blocked',
    });
    expect(parseRelayMessage(JSON.stringify(['NEG-ERR', 'feed', 'closed']))).toEqual({
      type: 'NEG-ERR',
      subId: 'feed',
      reason: 'closed',
    });
  });
});

describe('EVENT structural validation (relay ingest trust boundary)', () => {
  const validEvent = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    kind: 1,
    created_at: 1_700_000_000,
    content: 'hello',
    tags: [['t', 'general']],
  };

  it('accepts a structurally sound event', () => {
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', validEvent]));
    expect(parsed).toEqual({type: 'EVENT', subId: 'feed', event: validEvent});
  });

  it('accepts other kinds unchanged — validation is structural only, never semantic', () => {
    // Gift wraps (1059), ephemeral blind-token kinds (9020-9027), and NIP-29 group-state kinds
    // (39000-39005) must never be filtered by kind or content — only by shape.
    for (const kind of [1059, 9020, 9024, 9027, 39000, 39005]) {
      const ev = {...validEvent, kind};
      const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', ev]));
      expect(parsed.type).toBe('EVENT');
      if (parsed.type === 'EVENT') {
        expect(parsed.event.kind).toBe(kind);
      }
    }
  });

  it('treats tags-not-an-array as a malformed (UNKNOWN) frame', () => {
    const bad = {...validEvent, tags: 'not-an-array'};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a tag entry that is not an array-of-strings as malformed', () => {
    const bad = {...validEvent, tags: [['t', 'ok'], ['e', 123]]};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats numeric content as malformed', () => {
    const bad = {...validEvent, content: 12345};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a truncated event (missing sig/pubkey) as malformed', () => {
    const truncated = {id: validEvent.id, kind: 1, created_at: 1000, content: '', tags: []};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', truncated]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a non-64-hex id as malformed', () => {
    const bad = {...validEvent, id: 'not-hex'};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a non-integer kind as malformed', () => {
    const bad = {...validEvent, kind: 1.5};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a non-finite created_at as malformed', () => {
    const bad = {...validEvent, created_at: Infinity};
    const parsed = parseRelayMessage(JSON.stringify(['EVENT', 'feed', bad]));
    expect(parsed.type).toBe('UNKNOWN');
  });

  it('treats a null/undefined event payload as malformed rather than throwing', () => {
    expect(() => parseRelayMessage(JSON.stringify(['EVENT', 'feed', null]))).not.toThrow();
    expect(parseRelayMessage(JSON.stringify(['EVENT', 'feed', null])).type).toBe('UNKNOWN');
    expect(() => parseRelayMessage(JSON.stringify(['EVENT', 'feed']))).not.toThrow();
    expect(parseRelayMessage(JSON.stringify(['EVENT', 'feed'])).type).toBe('UNKNOWN');
  });
});

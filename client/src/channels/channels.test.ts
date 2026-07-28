/**
 * channels.test.ts — NIP-53 Live Activities (kind 30311/1311).
 * REWRITE: deleted all old NIP-28 (kind 40/42) content.
 */
import {generateSecretKey, getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {
  buildChannelCreate,
  buildChannelEdit,
  buildChannelMessage,
  buildChannelMessageEdit,
  editTargetId,
  channelCoord,
  createChannel,
  broadcastToChannel,
  parseChannel,
  messageChannelId,
  channelMessages,
  getChannel,
} from './channels';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {encodeGradient} from '../media/gradient';
import type {GradientSpec} from '../media/gradient';
import type {Event} from 'nostr-tools/pure';

// ── helpers ──────────────────────────────────────────────────────────────────

async function ownerStore() {
  const store = new KeyStore(new InMemorySecureStorage());
  const sk = generateSecretKey();
  await store.enroll(sk);
  return {store, pubkey: getPublicKey(sk)};
}

const SAMPLE_GRADIENT: GradientSpec = {
  type: 'linear',
  angle: 135,
  stops: ['#7ec8ff', '#8a5bd0'],
};

// ── buildChannelCreate ────────────────────────────────────────────────────────

describe('buildChannelCreate', () => {
  it('produces kind-30311 with a d tag and title', () => {
    const ev = buildChannelCreate({name: 'News', about: 'latest updates'});
    expect(ev.kind).toBe(Kind.LiveActivity);
    const tags = ev.tags;
    const d = tags.find(t => t[0] === 'd');
    expect(d).toBeDefined();
    expect(d![1]).toBeTruthy(); // non-empty d
    expect(tags).toContainEqual(expect.arrayContaining(['title', 'News']));
    // summary tag (about)
    expect(tags.find(t => t[0] === 'summary')?.[1]).toBe('latest updates');
  });

  it('includes an encoded gradient tag when gradient is set', () => {
    const ev = buildChannelCreate({name: 'Colors', gradient: SAMPLE_GRADIENT});
    const gradTag = ev.tags.find(t => t[0] === 'gradient');
    expect(gradTag).toBeDefined();
    const encoded = encodeGradient(SAMPLE_GRADIENT);
    expect(gradTag![1]).toBe(encoded);
  });

  it('omits gradient tag when no gradient is set', () => {
    const ev = buildChannelCreate({name: 'Plain'});
    expect(ev.tags.find(t => t[0] === 'gradient')).toBeUndefined();
  });

  it('generates a distinct d tag each call', () => {
    const d1 = buildChannelCreate({name: 'A'}).tags.find(t => t[0] === 'd')![1];
    const d2 = buildChannelCreate({name: 'B'}).tags.find(t => t[0] === 'd')![1];
    expect(d1).not.toBe(d2);
  });

  it('round-trips the reaction emoji set through build → parse', () => {
    const ev = buildChannelCreate({name: 'Ops', reactions: ['👍', '🔥', '🙏']});
    const reactTag = ev.tags.find(t => t[0] === 'reactions');
    expect(reactTag).toEqual(['reactions', '👍', '🔥', '🙏']);
    const parsed = parseChannel({...ev, id: 'x', pubkey: 'abc', sig: '', created_at: 1} as never);
    expect(parsed?.reactions).toEqual(['👍', '🔥', '🙏']);
  });

  it('omits the reactions tag when the set is empty, parsing back as undefined', () => {
    const ev = buildChannelCreate({name: 'Plain', reactions: []});
    expect(ev.tags.find(t => t[0] === 'reactions')).toBeUndefined();
    const parsed = parseChannel({...ev, id: 'x', pubkey: 'abc', sig: '', created_at: 1} as never);
    expect(parsed?.reactions).toBeUndefined();
  });

  it('round-trips the pinned message id through build → parse', () => {
    const ev = buildChannelCreate({name: 'Ops', pinnedMessageId: 'msg-abc'});
    expect(ev.tags.find(t => t[0] === 'pinned')).toEqual(['pinned', 'msg-abc']);
    const parsed = parseChannel({...ev, id: 'x', pubkey: 'abc', sig: '', created_at: 1} as never);
    expect(parsed?.pinnedMessageId).toBe('msg-abc');
  });

  it('round-trips the open-community mode flag through build → parse', () => {
    const ev = buildChannelCreate({name: 'Commons', openCommunity: true});
    expect(ev.tags).toContainEqual(['mode', 'open']);
    const parsed = parseChannel({...ev, id: 'x', pubkey: 'abc', sig: '', created_at: 1} as never);
    expect(parsed?.openCommunity).toBe(true);
  });

  it('omits the mode tag for a plain public channel, parsing back as undefined', () => {
    const ev = buildChannelCreate({name: 'Plain'});
    expect(ev.tags.find(t => t[0] === 'mode')).toBeUndefined();
    const parsed = parseChannel({...ev, id: 'x', pubkey: 'abc', sig: '', created_at: 1} as never);
    expect(parsed?.openCommunity).toBeUndefined();
  });
});

// ── buildChannelEdit ──────────────────────────────────────────────────────────

describe('buildChannelEdit', () => {
  it('reuses the provided d (stable coordinate) and re-encodes gradient', () => {
    const d = 'stable-d-value';
    const ev = buildChannelEdit(d, {name: 'Renamed', gradient: SAMPLE_GRADIENT});
    expect(ev.kind).toBe(Kind.LiveActivity);
    const dTag = ev.tags.find(t => t[0] === 'd');
    expect(dTag![1]).toBe(d);
    const gradTag = ev.tags.find(t => t[0] === 'gradient');
    expect(gradTag).toBeDefined();
    expect(gradTag![1]).toBe(encodeGradient(SAMPLE_GRADIENT));
  });

  it('produces the same coordinate as the original create (latest-wins)', () => {
    const d = 'my-channel';
    const owner = 'a'.repeat(64);
    const coord = channelCoord(owner, d);
    const edited = buildChannelEdit(d, {name: 'Updated'});
    // The d in the edited event still maps to the same coord for the same owner.
    expect(edited.tags.find(t => t[0] === 'd')![1]).toBe(d);
    expect(coord).toBe(`${Kind.LiveActivity}:${owner}:${d}`);
  });
});

// ── parseChannel round-trip ───────────────────────────────────────────────────

describe('parseChannel', () => {
  const owner = 'a'.repeat(64);

  function fakeEvent(tags: string[][], createdAt = 1000): Event {
    return {
      id: Math.random().toString(36),
      pubkey: owner,
      created_at: createdAt,
      kind: Kind.LiveActivity,
      tags,
      content: '',
      sig: '',
    } as Event;
  }

  it('round-trips name, about, and gradient; yields correct coordinate id', () => {
    const encoded = encodeGradient(SAMPLE_GRADIENT)!;
    const ev = fakeEvent([
      ['d', 'chan1'],
      ['title', 'My Channel'],
      ['summary', 'About text'],
      ['gradient', encoded],
    ]);
    const ch = parseChannel(ev)!;
    expect(ch).not.toBeNull();
    expect(ch.id).toBe(`${Kind.LiveActivity}:${owner}:chan1`);
    expect(ch.name).toBe('My Channel');
    expect(ch.about).toBe('About text');
    expect(ch.gradient).toBeDefined();
    expect(ch.gradient!.type).toBe(SAMPLE_GRADIENT.type);
    expect(ch.gradient!.stops).toEqual(SAMPLE_GRADIENT.stops);
    expect(ch.metaAt).toBe(ev.created_at);
  });

  it('returns null for wrong kind', () => {
    const ev = {...fakeEvent([['d', 'x']]), kind: 1};
    expect(parseChannel(ev)).toBeNull();
  });

  it('returns null when d tag is missing', () => {
    expect(parseChannel(fakeEvent([['title', 'No D']]))).toBeNull();
  });

  it('gracefully handles missing gradient (undefined, not error)', () => {
    const ch = parseChannel(fakeEvent([['d', 'x'], ['title', 'Plain']]))!;
    expect(ch.gradient).toBeUndefined();
  });
});

// ── createChannel (real signer) ───────────────────────────────────────────────

describe('createChannel (signed)', () => {
  it('produces a valid, verifiable kind-30311 event', async () => {
    const {store, pubkey} = await ownerStore();
    const ev = await createChannel(store, {name: 'Dispatch', about: 'updates'});
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(Kind.LiveActivity);
    const ch = parseChannel(ev)!;
    expect(ch.owner).toBe(pubkey);
    expect(ch.name).toBe('Dispatch');
    expect(ch.id).toBe(channelCoord(pubkey, ev.tags.find(t => t[0] === 'd')![1] ?? ''));
  });
});

// ── buildChannelMessage / messageChannelId ────────────────────────────────────

describe('buildChannelMessage', () => {
  const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:chan1`;

  it('round-trips the a coordinate', () => {
    const ev = buildChannelMessage(COORD, 'hello');
    expect(ev.kind).toBe(Kind.LiveChat);
    expect(ev.tags).toContainEqual(['a', COORD, '', 'root']);
  });

  it('rejects empty content', () => {
    expect(() => buildChannelMessage(COORD, '   ')).toThrow(/empty/);
  });
});

describe('messageChannelId', () => {
  const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:chan1`;

  it('extracts the a coordinate from a kind-1311', () => {
    const ev: Event = {
      id: '1',
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: Kind.LiveChat,
      tags: [['a', COORD, '', 'root']],
      content: 'hi',
      sig: '',
    };
    expect(messageChannelId(ev)).toBe(COORD);
  });

  it('returns null for wrong kind', () => {
    const ev: Event = {
      id: '2',
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 1,
      tags: [['a', COORD]],
      content: 'hi',
      sig: '',
    };
    expect(messageChannelId(ev)).toBeNull();
  });
});

// ── channelMessages ───────────────────────────────────────────────────────────

describe('channelMessages', () => {
  const OWNER = 'a'.repeat(64);
  const COORD1 = channelCoord(OWNER, 'c1');
  const COORD2 = channelCoord(OWNER, 'c2');

  function msg(coord: string, content: string, createdAt: number): Event {
    return {
      id: Math.random().toString(36),
      pubkey: OWNER,
      created_at: createdAt,
      kind: Kind.LiveChat,
      tags: [['a', coord, '', 'root']],
      content,
      sig: '',
    } as Event;
  }

  it('filters by coordinate and returns oldest first', () => {
    const store = new InMemoryEventStore();
    store.save(msg(COORD1, 'first', 10));
    store.save(msg(COORD1, 'second', 20));
    store.save(msg(COORD2, 'other', 15));
    const msgs = channelMessages(store, COORD1);
    expect(msgs.map(m => m.content)).toEqual(['first', 'second']);
  });
});

// ── getChannel / latest-wins ──────────────────────────────────────────────────

describe('getChannel / listChannels latest-wins', () => {
  const OWNER = 'a'.repeat(64);

  function chEvent(d: string, name: string, createdAt: number): Event {
    return {
      id: Math.random().toString(36),
      pubkey: OWNER,
      created_at: createdAt,
      kind: Kind.LiveActivity,
      tags: [['d', d], ['title', name], ['status', 'live']],
      content: '',
      sig: '',
    } as Event;
  }

  it('latest 30311 with the same coordinate replaces the earlier', () => {
    const store = new InMemoryEventStore();
    const coord = channelCoord(OWNER, 'ch1');
    store.save(chEvent('ch1', 'Original', 1000));
    store.save(chEvent('ch1', 'Updated', 2000));
    const ch = getChannel(store, coord)!;
    expect(ch).not.toBeNull();
    expect(ch.name).toBe('Updated');
  });

  it('returns null for a coordinate not in the store', () => {
    const store = new InMemoryEventStore();
    expect(getChannel(store, channelCoord(OWNER, 'nope'))).toBeNull();
  });

  it('scopes by coordinate (different owners are distinct)', () => {
    const OWNER2 = 'b'.repeat(64);
    const store = new InMemoryEventStore();
    store.save(chEvent('ch1', 'AliceChannel', 1000));
    const ev2: Event = {
      id: Math.random().toString(36),
      pubkey: OWNER2,
      created_at: 1000,
      kind: Kind.LiveActivity,
      tags: [['d', 'ch1'], ['title', 'BobChannel'], ['status', 'live']],
      content: '',
      sig: '',
    } as Event;
    store.save(ev2);
    expect(getChannel(store, channelCoord(OWNER, 'ch1'))?.name).toBe('AliceChannel');
    expect(getChannel(store, channelCoord(OWNER2, 'ch1'))?.name).toBe('BobChannel');
  });
});

// ── broadcastToChannel (real signer) ─────────────────────────────────────────

describe('broadcastToChannel (signed)', () => {
  it('broadcasts a valid message and reads it back via channelMessages', async () => {
    const {store} = await ownerStore();
    const cache = new InMemoryEventStore();
    const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:c1`;

    const m1 = await broadcastToChannel(store, COORD, 'first');
    const m2 = await broadcastToChannel(store, COORD, 'second');
    const other = await broadcastToChannel(store, `${Kind.LiveActivity}:${'a'.repeat(64)}:c2`, 'elsewhere');

    expect(m1.kind).toBe(Kind.LiveChat);
    expect(messageChannelId(m1)).toBe(COORD);

    cache.save({...m1, created_at: 1});
    cache.save({...m2, created_at: 2});
    cache.save({...other, created_at: 1});

    expect(channelMessages(cache, COORD).map(m => m.content)).toEqual(['first', 'second']);
  });

  it('rejects an empty channel message', async () => {
    const {store} = await ownerStore();
    expect(() => broadcastToChannel(store, 'coord', '   ')).toThrow(/empty/);
  });
});

// ── editing broadcasts (position-preserving fold) ─────────────────────────────

describe('channel message edits', () => {
  it('folds the latest author edit in place: same id, kept position, "edited" tag', async () => {
    const {store, pubkey} = await ownerStore();
    const cache = new InMemoryEventStore();
    const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:c1`;

    const m1 = await broadcastToChannel(store, COORD, 'first');
    const m2 = await broadcastToChannel(store, COORD, 'second');
    cache.save({...m1, created_at: 1});
    cache.save({...m2, created_at: 2});

    // Two successive edits of m1 — the latest wins; m1 keeps its id and its position (created_at 1).
    const e1 = await store.sign(buildChannelMessageEdit(COORD, m1.id, 'first (typo)'));
    const e2 = await store.sign(buildChannelMessageEdit(COORD, m1.id, 'first — fixed'));
    cache.save({...e1, created_at: 3});
    cache.save({...e2, created_at: 4});

    expect(editTargetId(e2)).toBe(m1.id);
    const msgs = channelMessages(cache, COORD);
    // Edit events do NOT appear as their own messages; only the two originals remain, in order.
    expect(msgs.map(m => m.id)).toEqual([m1.id, m2.id]);
    expect(msgs[0]!.content).toBe('first — fixed');
    expect(msgs[0]!.pubkey).toBe(pubkey);
    expect(msgs[0]!.tags.some(t => t[0] === 'edited')).toBe(true);
    expect(msgs[1]!.content).toBe('second');
  });

  it('ignores an edit signed by someone other than the original author', async () => {
    const a = await ownerStore();
    const b = await ownerStore();
    const cache = new InMemoryEventStore();
    const COORD = `${Kind.LiveActivity}:${'a'.repeat(64)}:c1`;

    const m1 = await broadcastToChannel(a.store, COORD, 'authentic');
    cache.save({...m1, created_at: 1});
    const forged = await b.store.sign(buildChannelMessageEdit(COORD, m1.id, 'tampered'));
    cache.save({...forged, created_at: 2});

    const msgs = channelMessages(cache, COORD);
    expect(msgs.map(m => m.id)).toEqual([m1.id]);
    expect(msgs[0]!.content).toBe('authentic');
  });

  it('rejects an empty edit', () => {
    expect(() => buildChannelMessageEdit('coord', 'id', '  ')).toThrow(/empty/);
  });
});

import {
  ensureSavedEmbedsLoaded,
  listSavedEmbeds,
  saveEmbed,
  saveChannelEmbed,
  saveSpaceEmbed,
  removeEmbed,
  isEmbedSaved,
  withNostrScheme,
  nostrLinkForEvent,
  nostrLinkForNote,
  savedEmbedUri,
  spaceEmbedLabel,
} from './savedEmbeds';
import {parseSpaceEmbed} from './spaceEmbed';
import * as nip19 from 'nostr-tools/nip19';

// In-memory AsyncStorage mock (the module persists JSON under one key), with a `mockFailNextWrite`
// switch (names prefixed with `mock` are the one out-of-scope reference jest allows in a factory)
// so a single test can make one setItem reject and assert the in-memory list reverts.
// eslint-disable-next-line no-var
var mockFailNextWrite = false;
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => Promise.resolve(store[k] ?? null),
    setItem: (k: string, v: string) => {
      if (mockFailNextWrite) {
        mockFailNextWrite = false;
        return Promise.reject(new Error('disk full'));
      }
      store[k] = v;
      return Promise.resolve();
    },
    removeItem: (k: string) => { delete store[k]; return Promise.resolve(); },
  };
});

describe('savedEmbeds', () => {
  it('saves newest-first, dedupes by id, and tracks membership', async () => {
    await ensureSavedEmbedsLoaded();
    expect(await saveEmbed({id: 'a', pubkey: 'pa', kind: 1311}, 100)).toBe(true);
    expect(await saveEmbed({id: 'b', pubkey: 'pb', kind: 1111}, 200)).toBe(true);
    expect(await saveEmbed({id: 'a', pubkey: 'pa', kind: 1311}, 300)).toBe(false); // dup

    expect(listSavedEmbeds().map(e => e.id)).toEqual(['b', 'a']); // newest first
    expect(isEmbedSaved('a')).toBe(true);
    expect(isEmbedSaved('zzz')).toBe(false);
  });

  it('removes a saved reference by id', async () => {
    await removeEmbed('a');
    expect(isEmbedSaved('a')).toBe(false);
    expect(listSavedEmbeds().map(e => e.id)).toEqual(['b']);
  });

  it('reverts the added item and rethrows when the write fails (B15)', async () => {
    mockFailNextWrite = true;
    await expect(saveEmbed({id: 'z', pubkey: 'pz', kind: 1}, 500)).rejects.toThrow('disk full');
    expect(isEmbedSaved('z')).toBe(false);
    expect(listSavedEmbeds().map(e => e.id)).toEqual(['b']); // unchanged
  });

  it('reverts the removed item and rethrows when the write fails (B15)', async () => {
    // 'b' is still present from the earlier "removes a saved reference" test.
    mockFailNextWrite = true;
    await expect(removeEmbed('b')).rejects.toThrow('disk full');
    expect(isEmbedSaved('b')).toBe(true);
    expect(listSavedEmbeds().map(e => e.id)).toEqual(['b']); // unchanged
  });
});

describe('savedEmbedLabel', () => {
  it('delegates to referencedLabel: REFERENCED COMMENT for kind-1111, else REFERENCED POST', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {savedEmbedLabel} = require('./savedEmbeds');
    expect(savedEmbedLabel({kind: 1111})).toBe('REFERENCED COMMENT');
    expect(savedEmbedLabel({kind: 1})).toBe('REFERENCED POST');
    expect(savedEmbedLabel({})).toBe('REFERENCED POST');
  });
});

// B12: the canonical nostr: link helpers — every "copy link" call site (BroadcastCard, GroupView,
// PostCard, CommentItem) routes through these so a shared post always carries the `nostr:` scheme
// prefix every embed detector (RichText's EMBED_RE, MessageBody's CONTENT_RE) requires.
const ID = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);

describe('withNostrScheme', () => {
  it('prefixes an unprefixed identifier', () => {
    expect(withNostrScheme('nevent1xyz')).toBe('nostr:nevent1xyz');
  });

  it('is idempotent on an already-prefixed identifier', () => {
    expect(withNostrScheme('nostr:nevent1xyz')).toBe('nostr:nevent1xyz');
  });
});

describe('nostrLinkForEvent', () => {
  it('returns a nostr:nevent… link carrying the author hint', () => {
    const uri = nostrLinkForEvent({id: ID, author: AUTHOR});
    expect(uri.startsWith('nostr:nevent1')).toBe(true);
    const decoded = nip19.decode(uri.replace(/^nostr:/, ''));
    expect(decoded.type).toBe('nevent');
    expect((decoded.data as {id: string; author?: string}).id).toBe(ID);
    expect((decoded.data as {id: string; author?: string}).author).toBe(AUTHOR);
  });

  it('falls back to a bare nostr:<id> when nevent encoding throws', () => {
    expect(nostrLinkForEvent({id: 'not-hex', author: 'also-not-hex'})).toBe('nostr:not-hex');
  });
});

describe('nostrLinkForNote', () => {
  it('returns a nostr:note… link with no author hint', () => {
    const uri = nostrLinkForNote(ID);
    expect(uri.startsWith('nostr:note1')).toBe(true);
    const decoded = nip19.decode(uri.replace(/^nostr:/, ''));
    expect(decoded.type).toBe('note');
    expect(decoded.data).toBe(ID);
  });

  it('falls back to a bare nostr:<id> when note encoding throws', () => {
    expect(nostrLinkForNote('not-hex')).toBe('nostr:not-hex');
  });
});

describe('savedEmbedUri (routes through nostrLinkForEvent)', () => {
  it('produces the identical nostr:nevent… shape', () => {
    expect(savedEmbedUri({id: ID, pubkey: AUTHOR})).toBe(nostrLinkForEvent({id: ID, author: AUTHOR}));
  });
});

// SPACE embeds (channel-card-embed foundation): saveChannelEmbed/saveSpaceEmbed store a coordinate id
// (matches Channel.id for 30311, synthesized for 39000); savedEmbedUri branches on kind to produce a
// self-contained `stiq:space:…` token instead of the nostr:nevent path.
const OWNER = 'c'.repeat(64);
const CHANNEL_D = 'general';
const GROUP_ID = 'grp-42';
const GRADIENT = {type: 'linear' as const, angle: 135, stops: ['#3a4150', '#222834']};

describe('spaceEmbedLabel', () => {
  it("is 'CHANNEL' for a public 30311, 'PRIVATE SPACE' for a private/39000", () => {
    expect(spaceEmbedLabel(30311, false)).toBe('CHANNEL');
    expect(spaceEmbedLabel(39000, true)).toBe('PRIVATE SPACE');
    expect(spaceEmbedLabel(39000)).toBe('PRIVATE SPACE'); // kind alone is enough
    expect(spaceEmbedLabel(30311, true)).toBe('PRIVATE SPACE'); // explicit private flag wins
  });
});

describe('saveChannelEmbed + savedEmbedUri (public channel)', () => {
  it('stores a 30311 coordinate item and savedEmbedUri decodes back to the right coordinate + name', async () => {
    const channelId = `30311:${OWNER}:${CHANNEL_D}`;
    expect(await saveChannelEmbed({id: channelId, owner: OWNER, name: 'General', gradient: GRADIENT}, 1000)).toBe(true);

    const saved = listSavedEmbeds().find(e => e.id === channelId)!;
    expect(saved).toBeDefined();
    expect(saved.pubkey).toBe(OWNER);
    expect(saved.kind).toBe(30311);
    expect(saved.private).toBe(false);

    const uri = savedEmbedUri(saved);
    expect(uri.startsWith('stiq:space:')).toBe(true);
    const ref = parseSpaceEmbed(uri);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(30311);
    expect(ref!.coordinate).toBe(channelId);
    expect(ref!.owner).toBe(OWNER);
    expect(ref!.identifier).toBe(CHANNEL_D);
    expect(ref!.name).toBe('General');
    expect(ref!.private).toBe(false);
    expect(ref!.gradient).toEqual(GRADIENT);
  });

  it('dedupes by coordinate id (saving the same channel twice is a no-op)', async () => {
    const channelId = `30311:${OWNER}:${CHANNEL_D}`;
    expect(await saveChannelEmbed({id: channelId, owner: OWNER, name: 'General'}, 2000)).toBe(false);
  });
});

describe('saveSpaceEmbed + savedEmbedUri (private group)', () => {
  it('stores a synthesized 39000 coordinate item and savedEmbedUri decodes back correctly', async () => {
    expect(await saveSpaceEmbed({id: GROUP_ID, owner: OWNER, name: 'Inner Circle'}, 3000)).toBe(true);

    const groupCoord = `39000:${OWNER}:${GROUP_ID}`;
    const saved = listSavedEmbeds().find(e => e.id === groupCoord)!;
    expect(saved).toBeDefined();
    expect(saved.pubkey).toBe(OWNER);
    expect(saved.kind).toBe(39000);
    expect(saved.private).toBe(true);
    expect(saved.groupId).toBe(GROUP_ID);

    const uri = savedEmbedUri(saved);
    expect(uri.startsWith('stiq:space:')).toBe(true);
    const ref = parseSpaceEmbed(uri);
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(39000);
    expect(ref!.coordinate).toBe(groupCoord);
    expect(ref!.owner).toBe(OWNER);
    expect(ref!.identifier).toBe(GROUP_ID);
    expect(ref!.name).toBe('Inner Circle');
    expect(ref!.private).toBe(true);
  });

  it('dedupes by the synthesized coordinate id (saving the same group twice is a no-op)', async () => {
    expect(await saveSpaceEmbed({id: GROUP_ID, owner: OWNER, name: 'Inner Circle'}, 4000)).toBe(false);
  });
});

describe('savedEmbedUri: post embeds are unaffected (still emit nostr:nevent…)', () => {
  it('an item with no space kind still routes through nostrLinkForEvent', () => {
    expect(savedEmbedUri({id: ID, pubkey: AUTHOR, kind: 1})).toBe(nostrLinkForEvent({id: ID, author: AUTHOR}));
    expect(savedEmbedUri({id: ID, pubkey: AUTHOR, kind: 1111})).toBe(nostrLinkForEvent({id: ID, author: AUTHOR}));
  });
});

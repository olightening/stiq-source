import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {
  GroupKind,
  ROLE_ADMIN,
  buildGroupCreate,
  buildGroupEditMetadata,
  buildGroupJoinRequest,
  buildGroupLeaveRequest,
  buildGroupAddUser,
  buildGroupRemoveUser,
  buildGroupChat,
  groupEditTargetId,
  groupReplyParentId,
  buildGroupReply,
  buildGroupDelete,
  buildGroupTransferOwner,
  ROLE_OWNER,
  parseGroupMetadata,
  parseGroupPubkeys,
  groupState,
  groupMembers,
  groupAdmins,
  groupPending,
  isGroupAdmin,
  isGroupMember,
  isGroupOwner,
  groupChatMessages,
  groupRepliesByParent,
  groupSummariesForIds,
  myGroupSummaries,
  newGroupId,
  parseSupportedNips,
  supportsNip29,
  fetchRelaySupportsNip29,
} from './groups';
import {encodeGradient} from '../media/gradient';
import type {GradientSpec} from '../media/gradient';

const RELAY = 'relaypubkey00000000000000000000000000000000000000000000000000000';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

// Build a relay-generated state event (the relay signs these; tests only need the shape).
function stateEvent(kind: number, d: string, tags: string[][], createdAt = 1000): Event {
  return {
    id: Math.random().toString(36),
    pubkey: RELAY,
    created_at: createdAt,
    kind,
    tags: [['d', d], ...tags],
    content: '',
    sig: '',
  } as Event;
}

function chat(groupId: string, author: string, createdAt: number): Event {
  return {
    id: Math.random().toString(36),
    pubkey: author,
    created_at: createdAt,
    kind: GroupKind.Chat,
    tags: [['h', groupId]],
    content: 'hi',
    sig: '',
  } as Event;
}

describe('group event builders', () => {
  it('builds a create event with h tag and access flags', () => {
    const e = buildGroupCreate('g1', {name: 'Test', closed: true, private: true});
    expect(e.kind).toBe(GroupKind.Create);
    expect(e.tags).toContainEqual(['h', 'g1']);
    expect(e.tags).toContainEqual(['name', 'Test']);
    expect(e.tags).toContainEqual(['closed']);
    expect(e.tags).toContainEqual(['private']);
  });

  it('defaults create to open + public', () => {
    const e = buildGroupCreate('g1');
    expect(e.tags).toContainEqual(['open']);
    expect(e.tags).toContainEqual(['public']);
  });

  it('builds join/leave with just the h tag', () => {
    expect(buildGroupJoinRequest('g1').kind).toBe(GroupKind.JoinRequest);
    expect(buildGroupJoinRequest('g1').tags).toEqual([['h', 'g1']]);
    expect(buildGroupLeaveRequest('g1').kind).toBe(GroupKind.LeaveRequest);
  });

  it('builds add-user with an optional admin role', () => {
    expect(buildGroupAddUser('g1', BOB).tags).toContainEqual(['p', BOB]);
    expect(buildGroupAddUser('g1', BOB, true).tags).toContainEqual(['p', BOB, ROLE_ADMIN]);
  });

  it('builds remove-user (kick) targeting a pubkey', () => {
    const e = buildGroupRemoveUser('g1', BOB);
    expect(e.kind).toBe(GroupKind.RemoveUser);
    expect(e.tags).toContainEqual(['p', BOB]);
  });

  it('builds a chat event and rejects empty content', () => {
    const e = buildGroupChat('g1', '  hello  ');
    expect(e.kind).toBe(GroupKind.Chat);
    expect(e.content).toBe('hello');
    expect(e.tags).toEqual([['h', 'g1']]);
    expect(() => buildGroupChat('g1', '   ')).toThrow();
  });

  it('builds a reply that quotes its parent (swipe-to-reply)', () => {
    const parentId = 'p'.repeat(64);
    const e = buildGroupChat('g1', 'a reply', parentId);
    expect(e.tags).toContainEqual(['h', 'g1']);
    expect(e.tags).toContainEqual(['e', parentId, '', 'reply']);
    expect(groupReplyParentId(e as never)).toBe(parentId);
    // A normal (non-reply) message has no parent and is not mistaken for an edit.
    expect(groupReplyParentId(buildGroupChat('g1', 'plain') as never)).toBeNull();
  });

  it('builds edit-metadata', () => {
    const e = buildGroupEditMetadata('g1', {name: 'New', closed: false, private: false});
    expect(e.kind).toBe(GroupKind.EditMetadata);
    expect(e.tags).toContainEqual(['name', 'New']);
    expect(e.tags).toContainEqual(['open']);
    expect(e.tags).toContainEqual(['public']);
  });

  it('generates distinct group ids', () => {
    expect(newGroupId()).not.toBe(newGroupId());
  });
});

describe('group state parsing', () => {
  it('parses 39000 metadata including access flags', () => {
    const e = stateEvent(GroupKind.Metadata, 'g1', [
      ['name', 'Test'],
      ['about', 'desc'],
      ['closed'],
      ['private'],
    ]);
    const meta = parseGroupMetadata(e);
    expect(meta).toMatchObject({id: 'g1', name: 'Test', about: 'desc', picture: undefined, closed: true, private: true});
    // metaAt = the 39000's created_at — the channels list's recency fallback for spaces with no
    // readable messages (a fresh empty space must not bury at lastAt 0).
    expect(meta!.metaAt).toBe(e.created_at);
  });

  it('parses member/admin p tags', () => {
    const e = stateEvent(GroupKind.Members, 'g1', [['p', ALICE], ['p', BOB]]);
    expect(parseGroupPubkeys(e)).toEqual([ALICE, BOB]);
  });
});

describe('group store selectors', () => {
  function seed(): InMemoryEventStore {
    const store = new InMemoryEventStore();
    store.save(stateEvent(GroupKind.Metadata, 'g1', [['name', 'Group One'], ['closed']]));
    store.save(stateEvent(GroupKind.Admins, 'g1', [['p', ALICE, ROLE_ADMIN]]));
    store.save(stateEvent(GroupKind.Members, 'g1', [['p', ALICE], ['p', BOB]]));
    return store;
  }

  it('reads metadata, members, and admins', () => {
    const store = seed();
    expect(groupState(store, 'g1')?.name).toBe('Group One');
    expect(groupMembers(store, 'g1')).toEqual([ALICE, BOB]);
    expect(groupAdmins(store, 'g1')).toEqual([ALICE]);
    expect(isGroupMember(store, 'g1', BOB)).toBe(true);
    expect(isGroupAdmin(store, 'g1', BOB)).toBe(false);
    expect(isGroupAdmin(store, 'g1', ALICE)).toBe(true);
  });

  it('uses the latest replaceable member list', () => {
    const store = seed();
    // BOB is kicked: a newer 39002 lists only ALICE.
    store.save(stateEvent(GroupKind.Members, 'g1', [['p', ALICE]], 2000));
    expect(groupMembers(store, 'g1')).toEqual([ALICE]);
    expect(isGroupMember(store, 'g1', BOB)).toBe(false);
  });

  it('orders chat oldest first and scopes by group', () => {
    const store = seed();
    store.save(chat('g1', ALICE, 30));
    store.save(chat('g1', BOB, 10));
    store.save(chat('other', ALICE, 20));
    const msgs = groupChatMessages(store, 'g1');
    expect(msgs.map(m => m.created_at)).toEqual([10, 30]);
  });

  it('folds an author edit of a group message in place and ignores foreign edits', () => {
    const store = seed();
    const m1: Event = {...chat('g1', ALICE, 10), id: 'm1', content: 'original'};
    store.save(m1);
    store.save({...chat('g1', BOB, 20), id: 'm2', content: 'second'});
    // ALICE edits m1 → folds in place (kept created_at 10, flagged edited).
    store.save({
      id: 'e1', pubkey: ALICE, created_at: 30, kind: GroupKind.Chat,
      tags: [['h', 'g1'], ['e', 'm1', '', 'edit']], content: 'fixed', sig: '',
    } as Event);
    // BOB tries to edit ALICE's message → ignored.
    store.save({
      id: 'e2', pubkey: BOB, created_at: 40, kind: GroupKind.Chat,
      tags: [['h', 'g1'], ['e', 'm1', '', 'edit']], content: 'tampered', sig: '',
    } as Event);

    expect(groupEditTargetId(store.query({kinds: [GroupKind.Chat]}).find(e => e.id === 'e1')!)).toBe('m1');
    const msgs = groupChatMessages(store, 'g1');
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']); // edit events excluded, order kept
    expect(msgs[0]!.content).toBe('fixed');
    expect(msgs[0]!.tags.some(t => t[0] === 'edited')).toBe(true);
  });

  it('summarises only the groups the viewer belongs to', () => {
    const store = seed();
    // A second group that BOB is in but ALICE is not.
    store.save(stateEvent(GroupKind.Metadata, 'g2', [['name', 'Group Two']]));
    store.save(stateEvent(GroupKind.Members, 'g2', [['p', BOB]]));

    const mine = myGroupSummaries(store, ALICE);
    expect(mine.map(g => g.id)).toEqual(['g1']);
    expect(mine[0]).toMatchObject({id: 'g1', name: 'Group One', memberCount: 2, isAdmin: true});

    expect(myGroupSummaries(store, BOB).map(g => g.id).sort()).toEqual(['g1', 'g2']);
    expect(myGroupSummaries(store, undefined)).toEqual([]);
  });
});

describe('new group builders + selectors', () => {
  const CAROL = 'c'.repeat(64);

  it('buildGroupReply tags the parent message', () => {
    const e = buildGroupReply('g1', 'parent123', 'a reply');
    expect(e.kind).toBe(GroupKind.Reply);
    expect(e.tags).toContainEqual(['h', 'g1']);
    expect(e.tags).toContainEqual(['e', 'parent123', '', 'reply']);
    expect(e.content).toBe('a reply');
  });

  it('buildGroupDelete + buildGroupTransferOwner produce the right kinds/tags', () => {
    expect(buildGroupDelete('g1')).toMatchObject({kind: GroupKind.Delete, tags: [['h', 'g1']]});
    const t = buildGroupTransferOwner('g1', BOB);
    expect(t.kind).toBe(GroupKind.AddUser);
    expect(t.tags).toContainEqual(['p', BOB, ROLE_OWNER]);
  });

  it('groupPending reads the 39004 pending list', () => {
    const store = new InMemoryEventStore();
    store.save(stateEvent(GroupKind.Pending, 'g1', [['p', CAROL]]));
    expect(groupPending(store, 'g1')).toEqual([CAROL]);
    expect(groupPending(store, 'unknown')).toEqual([]);
  });

  it('isGroupOwner reads the owner tag from metadata', () => {
    const store = new InMemoryEventStore();
    store.save(stateEvent(GroupKind.Metadata, 'g1', [['name', 'G'], ['owner', ALICE]]));
    expect(isGroupOwner(store, 'g1', ALICE)).toBe(true);
    expect(isGroupOwner(store, 'g1', BOB)).toBe(false);
  });

  it('groupRepliesByParent groups kind-12 replies by their parent', () => {
    const store = new InMemoryEventStore();
    const reply = (id: string, parent: string, at: number): Event => ({
      id, pubkey: BOB, created_at: at, kind: GroupKind.Reply,
      tags: [['h', 'g1'], ['e', parent, '', 'reply']], content: `r${id}`, sig: '',
    });
    store.save(reply('r1', 'm1', 1));
    store.save(reply('r2', 'm1', 2));
    store.save(reply('r3', 'm2', 3));
    const byParent = groupRepliesByParent(store, 'g1');
    expect(byParent.get('m1')?.map(e => e.id)).toEqual(['r1', 'r2']);
    expect(byParent.get('m2')?.map(e => e.id)).toEqual(['r3']);
  });

  it('groupSummariesForIds is driven by the id set (not 39002 scan)', () => {
    const store = new InMemoryEventStore();
    store.save(stateEvent(GroupKind.Metadata, 'g1', [['name', 'One'], ['owner', ALICE]]));
    store.save(stateEvent(GroupKind.Members, 'g1', [['p', ALICE], ['p', BOB]]));
    store.save(stateEvent(GroupKind.Admins, 'g1', [['p', ALICE, ROLE_ADMIN]]));
    // g2 has state but is NOT in the id set → excluded.
    store.save(stateEvent(GroupKind.Metadata, 'g2', [['name', 'Two']]));

    const out = groupSummariesForIds(store, ['g1'], ALICE);
    expect(out.map(g => g.id)).toEqual(['g1']);
    expect(out[0]).toMatchObject({name: 'One', memberCount: 2, isAdmin: true});
  });
});

describe('NIP-11 capability gate', () => {
  it('extracts supported_nips and detects NIP-29', () => {
    expect(parseSupportedNips({supported_nips: [1, 29, 77]})).toEqual([1, 29, 77]);
    expect(supportsNip29({supported_nips: [1, 11, 45]})).toBe(false);
    expect(supportsNip29({supported_nips: [29]})).toBe(true);
    expect(parseSupportedNips(null)).toEqual([]);
    expect(parseSupportedNips({})).toEqual([]);
  });

  it('fetches capability via an injected getter and is safe on error', async () => {
    await expect(fetchRelaySupportsNip29(async () => ({supported_nips: [29]}))).resolves.toBe(true);
    await expect(fetchRelaySupportsNip29(async () => ({supported_nips: [1]}))).resolves.toBe(false);
    await expect(
      fetchRelaySupportsNip29(async () => {
        throw new Error('tor down');
      }),
    ).resolves.toBe(false);
  });
});

// ── gradient + broadcast extension ───────────────────────────────────────────

const SAMPLE_GRADIENT: GradientSpec = {
  type: 'linear',
  angle: 135,
  stops: ['#7ec8ff', '#8a5bd0'],
};

describe('group metadata tag builders — gradient + broadcast', () => {
  it('buildGroupCreate emits a gradient tag when gradient is set', () => {
    const e = buildGroupCreate('g1', {name: 'Colorful', gradient: SAMPLE_GRADIENT});
    const gradTag = e.tags.find(t => t[0] === 'gradient');
    expect(gradTag).toBeDefined();
    expect(gradTag![1]).toBe(encodeGradient(SAMPLE_GRADIENT));
  });

  it('buildGroupCreate emits a broadcast flag when broadcast=true', () => {
    const e = buildGroupCreate('g1', {name: 'Broadcast', broadcast: true});
    expect(e.tags).toContainEqual(['broadcast']);
  });

  it('buildGroupCreate omits gradient tag when no gradient', () => {
    const e = buildGroupCreate('g1', {name: 'Plain'});
    expect(e.tags.find(t => t[0] === 'gradient')).toBeUndefined();
  });

  it('buildGroupCreate omits broadcast flag when broadcast=false/undefined', () => {
    const e = buildGroupCreate('g1', {name: 'Normal', broadcast: false});
    expect(e.tags.find(t => t[0] === 'broadcast')).toBeUndefined();
    const e2 = buildGroupCreate('g1', {name: 'Normal2'});
    expect(e2.tags.find(t => t[0] === 'broadcast')).toBeUndefined();
  });

  it('buildGroupEditMetadata re-encodes gradient', () => {
    const e = buildGroupEditMetadata('g1', {name: 'G', gradient: SAMPLE_GRADIENT});
    const gradTag = e.tags.find(t => t[0] === 'gradient');
    expect(gradTag).toBeDefined();
    expect(gradTag![1]).toBe(encodeGradient(SAMPLE_GRADIENT));
  });
});

describe('parseGroupMetadata — gradient + broadcast decoding', () => {
  it('decodes gradient and sets broadcast:true from state event', () => {
    const encoded = encodeGradient(SAMPLE_GRADIENT)!;
    const e = stateEvent(GroupKind.Metadata, 'g2', [
      ['name', 'Colorcast'],
      ['open'],
      ['public'],
      ['gradient', encoded],
      ['broadcast'],
    ]);
    const meta = parseGroupMetadata(e)!;
    expect(meta).not.toBeNull();
    expect(meta.broadcast).toBe(true);
    expect(meta.gradient).toBeDefined();
    expect(meta.gradient!.type).toBe(SAMPLE_GRADIENT.type);
    expect(meta.gradient!.stops).toEqual(SAMPLE_GRADIENT.stops);
  });

  it('sets broadcast:false when the broadcast flag is absent', () => {
    const e = stateEvent(GroupKind.Metadata, 'g3', [['name', 'Silent'], ['open'], ['public']]);
    const meta = parseGroupMetadata(e)!;
    expect(meta.broadcast).toBe(false);
    expect(meta.gradient).toBeUndefined();
  });
});

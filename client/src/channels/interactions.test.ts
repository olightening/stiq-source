/**
 * interactions.test.ts — per-post interaction gating (comments & reactions).
 *
 * Tests both the unsigned event builders (shape only — no signing required) and the
 * read-side store selectors (groupPostInteractions, channelPostInteractions).
 * Store events are hand-built (no signatures needed — InMemoryEventStore accepts any shape).
 */
import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind, PostState} from '../nostr/events';
import {
  buildGroupInteractionControl,
  buildChannelInteractionControl,
  groupPostInteractions,
  channelPostInteractions,
  CLOSED,
} from './interactions';

// ── helpers ──────────────────────────────────────────────────────────────────

const OWNER = 'a'.repeat(64);
const POST_ID = 'post1111' + '0'.repeat(56);

function fakeEvent(
  kind: number,
  tags: string[][],
  createdAt = 1000,
  pubkey = OWNER,
): Event {
  return {
    id: Math.random().toString(36) + Math.random().toString(36),
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content: '',
    sig: '',
  } as Event;
}

// ── buildGroupInteractionControl ──────────────────────────────────────────────

describe('buildGroupInteractionControl', () => {
  it('produces kind-9009 with h, e, comments, and reactions tags', () => {
    const ev = buildGroupInteractionControl('group1', POST_ID, {comments: true, reactions: false});
    expect(ev.kind).toBe(Kind.SetInteractions);
    expect(ev.tags).toContainEqual(['h', 'group1']);
    expect(ev.tags).toContainEqual(['e', POST_ID]);
    expect(ev.tags).toContainEqual(['comments', '1']);
    expect(ev.tags).toContainEqual(['reactions', '0']);
  });

  it('encodes both flags correctly when both are true', () => {
    const ev = buildGroupInteractionControl('g', POST_ID, {comments: true, reactions: true});
    expect(ev.tags).toContainEqual(['comments', '1']);
    expect(ev.tags).toContainEqual(['reactions', '1']);
  });

  it('encodes both flags correctly when both are false', () => {
    const ev = buildGroupInteractionControl('g', POST_ID, {comments: false, reactions: false});
    expect(ev.tags).toContainEqual(['comments', '0']);
    expect(ev.tags).toContainEqual(['reactions', '0']);
  });

  it('has empty content', () => {
    const ev = buildGroupInteractionControl('g', POST_ID, {comments: false, reactions: false});
    expect(ev.content).toBe('');
  });
});

// ── buildChannelInteractionControl ────────────────────────────────────────────

describe('buildChannelInteractionControl', () => {
  it('produces kind-30078 with d=stiq:interactions:<postId>, e, comments, reactions', () => {
    const ev = buildChannelInteractionControl(POST_ID, {comments: true, reactions: false});
    expect(ev.kind).toBe(Kind.AppData);
    expect(ev.tags).toContainEqual(['d', `stiq:interactions:${POST_ID}`]);
    expect(ev.tags).toContainEqual(['e', POST_ID]);
    expect(ev.tags).toContainEqual(['comments', '1']);
    expect(ev.tags).toContainEqual(['reactions', '0']);
  });

  it('encodes both flags when reactions=true', () => {
    const ev = buildChannelInteractionControl(POST_ID, {comments: false, reactions: true});
    expect(ev.tags).toContainEqual(['comments', '0']);
    expect(ev.tags).toContainEqual(['reactions', '1']);
  });
});

// ── groupPostInteractions ─────────────────────────────────────────────────────

describe('groupPostInteractions', () => {
  it('defaults to CLOSED (both false) when no events in store', () => {
    const store = new InMemoryEventStore();
    expect(groupPostInteractions(store, POST_ID)).toEqual(CLOSED);
    expect(groupPostInteractions(store, POST_ID)).toEqual({comments: false, reactions: false});
  });

  it('falls back to the caller-supplied default (the space rule) when no override exists', () => {
    const store = new InMemoryEventStore();
    // No per-message doc published — resolves to whatever the caller passes, not hardcoded CLOSED
    // (AppRuntime.getGroupPostInteractions passes the space's spaceRules `defaultReactions` here).
    expect(groupPostInteractions(store, POST_ID, {comments: false, reactions: true})).toEqual({
      comments: false,
      reactions: true,
    });
  });

  it('an explicit per-message override still wins over the caller-supplied default', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(PostState, [
      ['e', POST_ID],
      ['comments', '0'],
      ['reactions', '0'],
    ]));
    // The space default says reactions:true, but this message's own override says false — override wins.
    expect(groupPostInteractions(store, POST_ID, {comments: false, reactions: true})).toEqual({
      comments: false,
      reactions: false,
    });
  });

  it('reads comments:true from a kind-39005 (PostState) event whose e tag matches', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(PostState, [
      ['e', POST_ID],
      ['comments', '1'],
      ['reactions', '0'],
    ]));
    const perm = groupPostInteractions(store, POST_ID);
    expect(perm.comments).toBe(true);
    expect(perm.reactions).toBe(false);
  });

  it('reads from a kind-9009 (SetInteractions) event', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(Kind.SetInteractions, [
      ['h', 'group1'],
      ['e', POST_ID],
      ['comments', '1'],
      ['reactions', '1'],
    ]));
    const perm = groupPostInteractions(store, POST_ID);
    expect(perm.comments).toBe(true);
    expect(perm.reactions).toBe(true);
  });

  it('a newer 39005 wins over an older 9009', () => {
    const store = new InMemoryEventStore();
    // older 9009 says open
    store.save(fakeEvent(Kind.SetInteractions, [
      ['h', 'g1'],
      ['e', POST_ID],
      ['comments', '1'],
      ['reactions', '1'],
    ], 1000));
    // newer 39005 says closed
    store.save(fakeEvent(PostState, [
      ['e', POST_ID],
      ['comments', '0'],
      ['reactions', '0'],
    ], 2000));
    const perm = groupPostInteractions(store, POST_ID);
    expect(perm.comments).toBe(false);
    expect(perm.reactions).toBe(false);
  });

  it('a newer 9009 wins over an older 39005', () => {
    const store = new InMemoryEventStore();
    // older 39005 says closed
    store.save(fakeEvent(PostState, [
      ['e', POST_ID],
      ['comments', '0'],
      ['reactions', '0'],
    ], 1000));
    // newer 9009 says open
    store.save(fakeEvent(Kind.SetInteractions, [
      ['h', 'g1'],
      ['e', POST_ID],
      ['comments', '1'],
      ['reactions', '1'],
    ], 2000));
    const perm = groupPostInteractions(store, POST_ID);
    expect(perm.comments).toBe(true);
    expect(perm.reactions).toBe(true);
  });

  it('ignores events with a different postId', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(PostState, [
      ['e', 'different_post'],
      ['comments', '1'],
      ['reactions', '1'],
    ]));
    expect(groupPostInteractions(store, POST_ID)).toEqual(CLOSED);
  });
});

// ── channelPostInteractions ───────────────────────────────────────────────────

describe('channelPostInteractions', () => {
  const OTHER_OWNER = 'b'.repeat(64);

  it('defaults to CLOSED when no events in store', () => {
    const store = new InMemoryEventStore();
    expect(channelPostInteractions(store, OWNER, POST_ID)).toEqual(CLOSED);
  });

  it('falls back to the caller-supplied default (the space rule) when no override exists', () => {
    const store = new InMemoryEventStore();
    expect(channelPostInteractions(store, OWNER, POST_ID, {comments: false, reactions: true})).toEqual({
      comments: false,
      reactions: true,
    });
  });

  it('an explicit per-message override still wins over the caller-supplied default', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(Kind.AppData, [
      ['d', `stiq:interactions:${POST_ID}`],
      ['comments', '0'],
      ['reactions', '0'],
    ], 1000, OWNER));
    expect(channelPostInteractions(store, OWNER, POST_ID, {comments: false, reactions: true})).toEqual({
      comments: false,
      reactions: false,
    });
  });

  it('reads the latest kind-30078 authored by ownerPubkey with matching d', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(Kind.AppData, [
      ['d', `stiq:interactions:${POST_ID}`],
      ['e', POST_ID],
      ['comments', '1'],
      ['reactions', '0'],
    ], 1000, OWNER));
    const perm = channelPostInteractions(store, OWNER, POST_ID);
    expect(perm.comments).toBe(true);
    expect(perm.reactions).toBe(false);
  });

  it('a newer 30078 wins over an older one', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(Kind.AppData, [
      ['d', `stiq:interactions:${POST_ID}`],
      ['comments', '0'],
      ['reactions', '0'],
    ], 1000, OWNER));
    store.save(fakeEvent(Kind.AppData, [
      ['d', `stiq:interactions:${POST_ID}`],
      ['comments', '1'],
      ['reactions', '1'],
    ], 2000, OWNER));
    const perm = channelPostInteractions(store, OWNER, POST_ID);
    expect(perm.comments).toBe(true);
    expect(perm.reactions).toBe(true);
  });

  it('ignores 30078 authored by a different pubkey', () => {
    const store = new InMemoryEventStore();
    // OTHER_OWNER sets interactions open
    store.save(fakeEvent(Kind.AppData, [
      ['d', `stiq:interactions:${POST_ID}`],
      ['comments', '1'],
      ['reactions', '1'],
    ], 1000, OTHER_OWNER));
    // OWNER query should still return CLOSED
    expect(channelPostInteractions(store, OWNER, POST_ID)).toEqual(CLOSED);
  });

  it('ignores 30078 with a different d tag (different postId)', () => {
    const store = new InMemoryEventStore();
    store.save(fakeEvent(Kind.AppData, [
      ['d', 'stiq:interactions:other_post'],
      ['comments', '1'],
      ['reactions', '1'],
    ], 1000, OWNER));
    expect(channelPostInteractions(store, OWNER, POST_ID)).toEqual(CLOSED);
  });
});

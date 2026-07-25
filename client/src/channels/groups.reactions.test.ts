/**
 * GroupMeta.reactions round-trip — the admin-configured emoji set must survive
 * metaTags() (via buildGroupCreate / buildGroupEditMetadata) -> parseGroupMetadata(), in the
 * SAME ['reactions', ...emojis] tag format public channels use, so tallyEmojiReactions counts
 * group posts identically to channel posts.
 */
import type {Event} from 'nostr-tools/pure';
import {
  GroupKind,
  buildGroupCreate,
  buildGroupEditMetadata,
  parseGroupMetadata,
} from './groups';
import {buildChannelCreate} from './channels';

const REACTIONS = ['👍', '❤️', '🎉'];

/** Re-key an emitted create/edit event as a relay 39000 state event so parseGroupMetadata reads it
 * (parse only inspects tags; the d-tag carries the group id the relay would assign). */
function asState(groupId: string, tags: string[][]): Event {
  return {
    id: 'state',
    pubkey: 'relay'.padEnd(64, '0'),
    created_at: 1000,
    kind: GroupKind.Metadata,
    tags: [['d', groupId], ...tags.filter(t => t[0] !== 'h')],
    content: '',
    sig: '',
  } as Event;
}

describe('GroupMeta.reactions round-trip', () => {
  it('buildGroupCreate emits a single ["reactions", ...emojis] tag', () => {
    const e = buildGroupCreate('g1', {name: 'Builders', reactions: REACTIONS});
    const tag = e.tags.find(t => t[0] === 'reactions');
    expect(tag).toEqual(['reactions', ...REACTIONS]);
  });

  it('omits the reactions tag when none are configured', () => {
    expect(buildGroupCreate('g1', {name: 'Plain'}).tags.find(t => t[0] === 'reactions')).toBeUndefined();
    expect(buildGroupCreate('g1', {name: 'Empty', reactions: []}).tags.find(t => t[0] === 'reactions')).toBeUndefined();
  });

  it('trims blanks and drops empties before emitting', () => {
    const e = buildGroupCreate('g1', {name: 'Trim', reactions: [' 👍 ', '', '  ', '🔥']});
    expect(e.tags.find(t => t[0] === 'reactions')).toEqual(['reactions', '👍', '🔥']);
  });

  it('round-trips create -> parse', () => {
    const created = buildGroupCreate('g1', {name: 'Builders', reactions: REACTIONS});
    const meta = parseGroupMetadata(asState('g1', created.tags))!;
    expect(meta).not.toBeNull();
    expect(meta.reactions).toEqual(REACTIONS);
  });

  it('round-trips edit-metadata -> parse', () => {
    const edited = buildGroupEditMetadata('g1', {name: 'Builders', reactions: REACTIONS});
    const meta = parseGroupMetadata(asState('g1', edited.tags))!;
    expect(meta.reactions).toEqual(REACTIONS);
  });

  it('parses reactions as undefined when the tag is absent', () => {
    const created = buildGroupCreate('g1', {name: 'Silent'});
    const meta = parseGroupMetadata(asState('g1', created.tags))!;
    expect(meta.reactions).toBeUndefined();
  });

  it('uses the identical tag format to public channels (so the tally is shared)', () => {
    const groupTag = buildGroupCreate('g1', {name: 'G', reactions: REACTIONS}).tags.find(t => t[0] === 'reactions');
    const channelTag = buildChannelCreate({name: 'C', reactions: REACTIONS}).tags.find(t => t[0] === 'reactions');
    expect(groupTag).toEqual(channelTag);
  });
});

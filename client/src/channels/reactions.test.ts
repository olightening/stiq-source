import {buildEmojiReaction, tallyEmojiReactions, tallyAllReactions} from './reactions';
import type {Event} from 'nostr-tools/pure';

const react = (pubkey: string, emoji: string, target = 'm1'): Event =>
  ({kind: 7, pubkey, content: emoji, created_at: 1, tags: [['e', target]], id: '', sig: ''} as Event);

describe('buildEmojiReaction', () => {
  it('builds a kind-7 carrying the emoji as content with e/p tags', () => {
    const ev = buildEmojiReaction('msg1', 'authorhex', '🔥');
    expect(ev.kind).toBe(7);
    expect(ev.content).toBe('🔥');
    expect(ev.tags).toEqual([['e', 'msg1'], ['p', 'authorhex']]);
  });
});

describe('tallyEmojiReactions', () => {
  const emojis = ['👍', '🔥', '🙏'];

  it('counts one reaction per pubkey per emoji and preserves configured order', () => {
    const events = [
      react('a', '👍'), react('b', '👍'), react('a', '👍'), // double-tap by a ignored
      react('a', '🔥'),
    ];
    const t = tallyEmojiReactions(events, emojis, 'a');
    expect(t.map(x => [x.emoji, x.count])).toEqual([['👍', 2], ['🔥', 1], ['🙏', 0]]);
  });

  it('flags the viewer\'s own reactions', () => {
    const t = tallyEmojiReactions([react('a', '👍'), react('b', '🔥')], emojis, 'a');
    expect(t.find(x => x.emoji === '👍')?.mine).toBe(true);
    expect(t.find(x => x.emoji === '🔥')?.mine).toBe(false);
  });

  it('appends off-palette reactions (present in events, absent from the configured set) after the '
    + 'configured entries, count > 0 only, ordered by first appearance', () => {
    const events = [
      react('b', '🎉'), react('a', '👍'),
      react('c', '🎉'), // second voter on the same off-palette emoji
      react('a', '🦄'),
    ];
    const t = tallyEmojiReactions(events, emojis, 'a');
    // Configured entries keep their configured order and zero-count entries, unchanged.
    expect(t.slice(0, 3).map(x => [x.emoji, x.count])).toEqual([['👍', 1], ['🔥', 0], ['🙏', 0]]);
    // Off-palette entries are appended, ordered by first appearance in `events` (🎉 before 🦄).
    expect(t.slice(3).map(x => [x.emoji, x.count, x.mine])).toEqual([['🎉', 2, false], ['🦄', 1, true]]);
  });

  it('an empty configured set with no reaction events tallies to nothing', () => {
    expect(tallyEmojiReactions([], [])).toEqual([]);
  });

  it('an empty configured set still surfaces real reaction events (the load-bearing fallback fix: '
    + 'an unconfigured space must not hide reactions people actually sent)', () => {
    const events = [react('a', '🔥'), react('b', '🔥'), react('c', '👍')];
    const t = tallyEmojiReactions(events, [], 'a');
    expect(t.map(x => [x.emoji, x.count, x.mine])).toEqual([['🔥', 2, true], ['👍', 1, false]]);
  });
});

describe('tallyAllReactions (groups/DMs — any emoji)', () => {
  it('tallies every emoji present, most-used first, one per pubkey', () => {
    const events = [
      react('a', '🎉'), react('b', '🎉'), react('a', '🎉'), // a double-tap ignored
      react('c', '🦄'),
    ];
    const t = tallyAllReactions(events, 'a');
    expect(t.map(x => [x.emoji, x.count])).toEqual([['🎉', 2], ['🦄', 1]]);
    expect(t.find(x => x.emoji === '🎉')?.mine).toBe(true);
    expect(t.find(x => x.emoji === '🦄')?.mine).toBe(false);
  });

  it('returns empty when there are no reactions', () => {
    expect(tallyAllReactions([], 'a')).toEqual([]);
  });
});

/**
 * spaceRules.test.ts — unified per-space settings doc: normalizer, wire round-trip, and the
 * authorized latest-wins selector. Store events are hand-built (InMemoryEventStore accepts any shape).
 */
import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {
  DEFAULT_SPACE_RULE_SET,
  DEFAULT_SPACE_REACTIONS,
  buildSpaceSettings,
  getSpaceSettings,
  normalizeSpaceRules,
  parseSpaceSettings,
  resolveReactionPalette,
  spaceSettingsDTag,
  type SpaceSettings,
} from './spaceRules';

const OWNER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const IMPOSTOR = 'c'.repeat(64);
const SPACE = '30311:' + OWNER + ':chan1';

function fakeEvent(tags: string[][], content: string, createdAt = 1000, pubkey = OWNER): Event {
  return {
    id: Math.random().toString(36) + Math.random().toString(36),
    pubkey,
    created_at: createdAt,
    kind: Kind.AppData,
    tags,
    content,
    sig: '',
  } as Event;
}

describe('spaceSettingsDTag', () => {
  it('is never stiq:-prefixed (that d is organizer-reserved on the relay)', () => {
    expect(spaceSettingsDTag(SPACE).startsWith('stiq:')).toBe(false);
    expect(spaceSettingsDTag(SPACE)).toBe('space-settings:' + SPACE);
  });
});

describe('normalizeSpaceRules', () => {
  it('returns full defaults for empty/garbage input', () => {
    expect(normalizeSpaceRules(undefined)).toEqual(DEFAULT_SPACE_RULE_SET);
    expect(normalizeSpaceRules(null)).toEqual(DEFAULT_SPACE_RULE_SET);
    expect(normalizeSpaceRules(42)).toEqual(DEFAULT_SPACE_RULE_SET);
  });

  it('fills missing fields from defaults (partial input)', () => {
    const r = normalizeSpaceRules({m: {mx: 100}});
    expect(r.message.max).toBe(100);
    expect(r.message.min).toBe(0);
    expect(r.allowLinks).toBe(true);
    expect(r.onViolation).toBe('autohide');
  });

  it('rejects invalid enum/number values back to defaults', () => {
    const r = normalizeSpaceRules({pa: 'nonsense', ov: 'nope', m: {mx: -5}});
    expect(r.postAudience).toBeUndefined();
    expect(r.onViolation).toBe('autohide');
    expect(r.message.max).toBe(0);
  });

  it('drops an empty allowedKinds to undefined and filters non-ints', () => {
    expect(normalizeSpaceRules({ak: []}).allowedKinds).toBeUndefined();
    expect(normalizeSpaceRules({ak: [1311, 'x' as unknown as number, 9]}).allowedKinds).toEqual([1311, 9]);
  });
});

describe('buildSpaceSettings / parseSpaceSettings round-trip', () => {
  it('preserves rules, reactions and pinned across encode→parse', () => {
    const settings: SpaceSettings = {
      rules: {
        message: {min: 2, max: 500, mediaMax: 0, labelRequired: false},
        allowLinks: false,
        allowedKinds: [9],
        postAudience: 'admins',
        allowVoice: false,
        defaultComments: true,
        defaultReactions: true,
        onViolation: 'block',
      },
      reactions: ['👍', '🔥'],
      pinnedMessageId: 'pinned123',
    };
    const ev = buildSpaceSettings(SPACE, settings);
    expect(ev.kind).toBe(Kind.AppData);
    expect(ev.tags).toContainEqual(['d', spaceSettingsDTag(SPACE)]);
    const parsed = parseSpaceSettings(ev.content);
    expect(parsed).toEqual(settings);
  });

  it('parse returns defaults on malformed content', () => {
    expect(parseSpaceSettings('not json').rules).toEqual(DEFAULT_SPACE_RULE_SET);
    expect(parseSpaceSettings('not json').reactions).toBeUndefined();
  });
});

describe('getSpaceSettings', () => {
  it('returns the latest authorized doc (newer wins)', () => {
    const store = new InMemoryEventStore();
    const older = buildSpaceSettings(SPACE, {rules: {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 100, mediaMax: 0, labelRequired: false}}});
    const newer = buildSpaceSettings(SPACE, {rules: {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 200, mediaMax: 0, labelRequired: false}}});
    store.save(fakeEvent(older.tags, older.content, 1000, ADMIN));
    store.save(fakeEvent(newer.tags, newer.content, 2000, ADMIN));
    const got = getSpaceSettings(store, SPACE, new Set([OWNER, ADMIN]));
    expect(got?.settings.rules.message.max).toBe(200);
    expect(got?.at).toBe(2000);
  });

  it('ignores a doc signed by an unauthorized pubkey (impostor)', () => {
    const store = new InMemoryEventStore();
    const doc = buildSpaceSettings(SPACE, {rules: {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 999, mediaMax: 0, labelRequired: false}}});
    store.save(fakeEvent(doc.tags, doc.content, 3000, IMPOSTOR));
    expect(getSpaceSettings(store, SPACE, new Set([OWNER, ADMIN]))).toBeNull();
  });

  it('returns null when no doc exists', () => {
    expect(getSpaceSettings(new InMemoryEventStore(), SPACE, new Set([OWNER]))).toBeNull();
  });
});

describe('resolveReactionPalette', () => {
  // Owner directive (2026-07-22): a space whose owner never set reaction emojis shows NONE. The
  // short-lived fallback to DEFAULT_SPACE_REACTIONS put seven emojis on every fresh channel that
  // nobody chose; that list is now suggestion-only (the groups/DMs ⋯ picker seeds from it).
  it('resolves to an EMPTY palette when nothing is configured — never a default set', () => {
    expect(resolveReactionPalette(undefined)).toEqual([]);
    expect(resolveReactionPalette([])).toEqual([]);
  });

  it('never resolves to the suggestion palette (no default emojis leak into a space)', () => {
    for (const emoji of DEFAULT_SPACE_REACTIONS) {
      expect(resolveReactionPalette(undefined)).not.toContain(emoji);
    }
  });

  it("an owner's configured set wins outright, unchanged", () => {
    expect(resolveReactionPalette(['🔥', '💯'])).toEqual(['🔥', '💯']);
  });

  it('returns the SAME array reference across calls for the unconfigured case (memo stability)', () => {
    // ChannelView/GroupView key a reaction-tally useMemo on this value — a fresh array every call
    // would recompute the tally on every render even though "no configured set" never changed.
    expect(resolveReactionPalette(undefined)).toBe(resolveReactionPalette([]));
  });

  it('passes a configured set through by reference (no defensive copy)', () => {
    const configured = ['🔥'];
    expect(resolveReactionPalette(configured)).toBe(configured);
  });
});

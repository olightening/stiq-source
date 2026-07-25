/**
 * spaceAutoModeration.test.ts — deterministic per-space auto-removal + space-admin restore override.
 */
import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {ACTION_TAG} from './report';
import {spaceAutoHidden, spaceAutoHideReason, type SpaceAutoModConfig} from './spaceAutoModeration';
import {DEFAULT_SPACE_RULE_SET, type SpaceRuleSet} from '../channels/spaceRules';

const ADMIN = 'a'.repeat(64);
const AUTHOR = 'd'.repeat(64);
const OUTSIDER = 'e'.repeat(64);

let seq = 0;
function msg(content: string, createdAt = 1000, tags: string[][] = [], kind: number = Kind.LiveChat): Event {
  return {
    id: 'm' + seq++ + '0'.repeat(60),
    pubkey: AUTHOR,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig: '',
  } as Event;
}

function restore(targetId: string, pubkey: string, createdAt = 5000): Event {
  return {
    id: 'r' + seq++ + '0'.repeat(60),
    pubkey,
    created_at: createdAt,
    kind: Kind.Report,
    tags: [['e', targetId], [ACTION_TAG, 'restore']],
    content: '',
    sig: '',
  } as Event;
}

function cfg(rules: SpaceRuleSet, over: Partial<SpaceAutoModConfig> = {}): SpaceAutoModConfig {
  return {rules, rulesAt: 0, spaceAdmins: new Set([ADMIN]), ...over};
}

describe('spaceAutoHidden — length', () => {
  it('hides a message over the max, keeps one under', () => {
    const store = new InMemoryEventStore();
    const long = msg('x'.repeat(20));
    const short = msg('ok');
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 10, mediaMax: 0, labelRequired: false}};
    const hidden = spaceAutoHidden(store, [long, short], cfg(rules));
    expect(hidden.has(long.id)).toBe(true);
    expect(hidden.get(long.id)?.code).toBe('too-long');
    expect(hidden.has(short.id)).toBe(false);
  });

  it('is a no-op when rules constrain nothing', () => {
    const store = new InMemoryEventStore();
    const hidden = spaceAutoHidden(store, [msg('x'.repeat(999))], cfg(DEFAULT_SPACE_RULE_SET));
    expect(hidden.size).toBe(0);
  });

  it('does not count an inline picture token against the length limit', () => {
    const store = new InMemoryEventStore();
    const pic = msg(`[[pic:16;4;${'A'.repeat(500)}]]`);
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 20, mediaMax: 0, labelRequired: false}};
    expect(spaceAutoHidden(store, [pic], cfg(rules)).has(pic.id)).toBe(false);
  });
});

describe('spaceAutoHidden — links', () => {
  it('hides a message with a URL when allowLinks is false', () => {
    const store = new InMemoryEventStore();
    const m = msg('check https://evil.example');
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, allowLinks: false};
    const hidden = spaceAutoHidden(store, [m], cfg(rules));
    expect(hidden.get(m.id)?.code).toBe('link-blocked');
  });

  it('allows links by default', () => {
    const store = new InMemoryEventStore();
    const m = msg('see https://ok.example');
    expect(spaceAutoHidden(store, [m], cfg(DEFAULT_SPACE_RULE_SET)).size).toBe(0);
  });
});

describe('spaceAutoHidden — allowedKinds', () => {
  it('hides a message whose kind is not allowed (even if encrypted)', () => {
    const store = new InMemoryEventStore();
    const m = msg('ciphertext', 1000, [['encrypted', 'nip44'], ['ke', '0']], 9999);
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, allowedKinds: [Kind.LiveChat]};
    expect(spaceAutoHidden(store, [m], cfg(rules)).get(m.id)?.code).toBe('kind-blocked');
  });
});

describe('spaceAutoHidden — retroactivity', () => {
  it('exempts messages created before rulesAt', () => {
    const store = new InMemoryEventStore();
    const old = msg('x'.repeat(50), 500);
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 10, mediaMax: 0, labelRequired: false}};
    expect(spaceAutoHidden(store, [old], cfg(rules, {rulesAt: 1000})).size).toBe(0);
  });
});

describe('spaceAutoHidden — encrypted content', () => {
  it('skips length/link rules on ciphertext bodies', () => {
    const store = new InMemoryEventStore();
    const enc = msg('x'.repeat(50), 1000, [['encrypted', 'nip44'], ['ke', '0']]);
    const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 10, mediaMax: 0, labelRequired: false}, allowLinks: false};
    expect(spaceAutoHidden(store, [enc], cfg(rules)).size).toBe(0);
  });
});

describe('spaceAutoHidden — restore override', () => {
  const rules: SpaceRuleSet = {...DEFAULT_SPACE_RULE_SET, message: {min: 0, max: 5, mediaMax: 0, labelRequired: false}};

  it('a space admin restore un-hides a message', () => {
    const store = new InMemoryEventStore();
    const m = msg('x'.repeat(20));
    store.save(restore(m.id, ADMIN));
    expect(spaceAutoHidden(store, [m], cfg(rules)).has(m.id)).toBe(false);
  });

  it('a non-admin restore does NOT un-hide', () => {
    const store = new InMemoryEventStore();
    const m = msg('x'.repeat(20));
    store.save(restore(m.id, OUTSIDER));
    expect(spaceAutoHidden(store, [m], cfg(rules)).has(m.id)).toBe(true);
  });
});

describe('spaceAutoHideReason', () => {
  it('maps each code to a human string', () => {
    expect(spaceAutoHideReason('too-long')).toMatch(/length/i);
    expect(spaceAutoHideReason('link-blocked')).toMatch(/link/i);
    expect(spaceAutoHideReason('kind-blocked')).toMatch(/type/i);
  });
});

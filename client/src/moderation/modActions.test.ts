import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {InMemoryEventStore} from '../nostr/store';
import {moderationOverlay} from './modActions';

const modKey = generateSecretKey();
const modPub = getPublicKey(modKey);
const modNpub = nip19.npubEncode(modPub);
const mods = [modNpub];

let _seq = 0;
function actionReport(
  targetId: string,
  action: string,
  createdAt: number,
  extra: string[][] = [],
): Event {
  return {
    id: `ar-${targetId}-${action}-${createdAt}-${++_seq}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', targetId], ['stiq-action', action], ...extra],
    content: '',
    sig: 's',
  };
}

function hideReport(targetId: string, createdAt: number): Event {
  return {
    id: `hr-${targetId}-${createdAt}-${++_seq}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', targetId, 'spam']],
    content: '',
    sig: 's',
  };
}

describe('moderationOverlay', () => {
  it('returns empty sets for an empty store', () => {
    const store = new InMemoryEventStore();
    const overlay = moderationOverlay(store, mods);
    expect(overlay.lockedPostIds.size).toBe(0);
    expect(overlay.pinnedPostIds.size).toBe(0);
    expect(overlay.modLabels.size).toBe(0);
  });

  it('ignores plain hide/restore events', () => {
    const store = new InMemoryEventStore();
    store.save(hideReport('P1', 100));
    store.save(actionReport('P1', 'restore', 110));
    const overlay = moderationOverlay(store, mods);
    expect(overlay.lockedPostIds.size).toBe(0);
    expect(overlay.pinnedPostIds.size).toBe(0);
    expect(overlay.modLabels.size).toBe(0);
  });

  it('ignores events from non-moderators', () => {
    const store = new InMemoryEventStore();
    const stranger: Event = {
      ...actionReport('P1', 'lock', 100),
      pubkey: 'stranger',
      id: 'x-stranger',
    };
    store.save(stranger);
    const overlay = moderationOverlay(store, mods);
    expect(overlay.lockedPostIds.size).toBe(0);
  });

  // ── lock / unlock ─────────────────────────────────────────────────────────────────────────

  it('locks a post', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'lock', 100));
    const {lockedPostIds} = moderationOverlay(store, mods);
    expect(lockedPostIds.has('P1')).toBe(true);
  });

  it('unlock after lock clears the lock (latest-wins)', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'lock', 100));
    store.save(actionReport('P1', 'unlock', 200));
    const {lockedPostIds} = moderationOverlay(store, mods);
    expect(lockedPostIds.has('P1')).toBe(false);
  });

  it('lock after unlock reinstates the lock', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'unlock', 100));
    store.save(actionReport('P1', 'lock', 200));
    const {lockedPostIds} = moderationOverlay(store, mods);
    expect(lockedPostIds.has('P1')).toBe(true);
  });

  it('handles multiple independent locked posts', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'lock', 100));
    store.save(actionReport('P2', 'lock', 110));
    store.save(actionReport('P1', 'unlock', 120));
    const {lockedPostIds} = moderationOverlay(store, mods);
    expect(lockedPostIds.has('P1')).toBe(false);
    expect(lockedPostIds.has('P2')).toBe(true);
  });

  // ── pin / unpin ───────────────────────────────────────────────────────────────────────────

  it('pins a post', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'pin', 100));
    const {pinnedPostIds} = moderationOverlay(store, mods);
    expect(pinnedPostIds.has('P1')).toBe(true);
  });

  it('unpin after pin clears the pin (latest-wins)', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'pin', 100));
    store.save(actionReport('P1', 'unpin', 200));
    const {pinnedPostIds} = moderationOverlay(store, mods);
    expect(pinnedPostIds.has('P1')).toBe(false);
  });

  it('pin after unpin reinstates the pin', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'unpin', 100));
    store.save(actionReport('P1', 'pin', 200));
    const {pinnedPostIds} = moderationOverlay(store, mods);
    expect(pinnedPostIds.has('P1')).toBe(true);
  });

  // ── retag ─────────────────────────────────────────────────────────────────────────────────

  it('records a retag label', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'retag', 100, [['l', 'question', 'stiq.type']]));
    const {modLabels} = moderationOverlay(store, mods);
    expect(modLabels.get('P1')).toBe('question');
  });

  it('latest retag label wins', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'retag', 100, [['l', 'question', 'stiq.type']]));
    store.save(actionReport('P1', 'retag', 200, [['l', 'insight', 'stiq.type']]));
    const {modLabels} = moderationOverlay(store, mods);
    expect(modLabels.get('P1')).toBe('insight');
  });

  it('records a retag with a custom (organizer-defined) label id', () => {
    // Labels are organizer-defined now, so any non-empty stiq.type id is valid; an unknown id
    // renders with a neutral fallback chip rather than being dropped (non-destructive).
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'retag', 100, [['l', 'banana', 'stiq.type']]));
    const {modLabels} = moderationOverlay(store, mods);
    expect(modLabels.get('P1')).toBe('banana');
  });

  it('ignores retag with an empty label', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'retag', 100, [['l', '', 'stiq.type']]));
    const {modLabels} = moderationOverlay(store, mods);
    expect(modLabels.has('P1')).toBe(false);
  });

  it('ignores retag with wrong namespace', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'retag', 100, [['l', 'question', 'other.ns']]));
    const {modLabels} = moderationOverlay(store, mods);
    expect(modLabels.has('P1')).toBe(false);
  });

  // ── lock and pin are independent ──────────────────────────────────────────────────────────

  it('lock and pin states are independent per post', () => {
    const store = new InMemoryEventStore();
    store.save(actionReport('P1', 'lock', 100));
    store.save(actionReport('P1', 'pin', 110));
    store.save(actionReport('P1', 'unlock', 120));
    const overlay = moderationOverlay(store, mods);
    expect(overlay.lockedPostIds.has('P1')).toBe(false);
    expect(overlay.pinnedPostIds.has('P1')).toBe(true);
  });
});

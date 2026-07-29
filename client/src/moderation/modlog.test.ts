import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {InMemoryEventStore} from '../nostr/store';
import {clearAuthorCache} from '../blind/identity';
import {
  buildModLog,
  filterModLog,
  moderatorsInLog,
  UNATTRIBUTED_REASON,
  UNATTRIBUTED_REPORT_TYPE,
} from './modlog';
import {toBlindEvent, assembleBlindEvent} from '../blind/blindPost';
import {DEFAULT_POST_RULES} from '../feed/postRules';
import {newTokenKeypair} from '../blind/holderProof';
import {mintGroupKey, encryptForSpace} from '../channels/groupCrypto';
import {setActiveCommunityKey} from '../blind/communityKey';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../blind/contentKey';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../blind/protocol';
import type {Token} from '../blind/wallet';

const modPub = getPublicKey(generateSecretKey());
const modNpub = nip19.npubEncode(modPub);
const mods = [modNpub];

// buildModLog now resolves each post's real author (advisory routing). resolveAuthor memoizes by
// event id — harmless in production (ids are unique hashes) but these suites deliberately reuse ids
// like "P1" with different authors, so clear the resolver between tests to avoid stale attributions.
beforeEach(() => clearAuthorCache());

function post(id: string, pubkey = 'author', content = 'hello'): Event {
  return {id, pubkey, created_at: 10, kind: 1, tags: [], content, sig: 's'};
}
function comment(id: string, pubkey = 'author'): Event {
  return {id, pubkey, created_at: 10, kind: 1111, tags: [], content: 'a comment', sig: 's'};
}
function report(targetId: string, createdAt: number, content = '', extra: string[][] = []): Event {
  return {
    id: `rep-${targetId}-${createdAt}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', targetId, 'spam'], ...extra],
    content,
    sig: 's',
  };
}
function muteList(muted: string[], createdAt: number): Event {
  return {
    id: `mute-${createdAt}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 10000,
    tags: muted.map(p => ['p', p]),
    content: '',
    sig: 's',
  };
}

describe('buildModLog', () => {
  it('records post hides, comment hides, restores, and user hides', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(comment('C1'));
    store.save(report('P1', 100, 'off-topic'));
    store.save(report('C1', 110));
    store.save(report('P1', 120, '', [['stiq-action', 'restore']]));
    store.save(muteList(['spammer'], 130));

    const log = buildModLog(store, mods);
    // newest first
    expect(log.map(e => [e.action, e.targetType, e.target])).toEqual([
      ['hide', 'user', 'spammer'],
      ['restore', 'post', 'P1'],
      ['hide', 'comment', 'C1'],
      ['hide', 'post', 'P1'],
    ]);
    expect(log.find(e => e.target === 'P1' && e.action === 'hide')?.reason).toBe('off-topic');
    // The NIP-56 report type rides through as `reportType` (surfaced as a flair tag in the UI).
    expect(log.find(e => e.target === 'P1' && e.action === 'hide')?.reportType).toBe('spam');
    expect(log.find(e => e.targetType === 'comment')?.targetContent).toBe('a comment');
  });

  it('ignores actions from non-moderators', () => {
    const store = new InMemoryEventStore();
    const stranger: Event = {...report('P1', 100), pubkey: 'stranger', id: 'x'};
    store.save(stranger);
    expect(buildModLog(store, mods)).toHaveLength(0);
  });
});

describe('filterModLog', () => {
  function sampleStore(): InMemoryEventStore {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'author', 'the quick brown fox'));
    store.save(report('P1', 100, 'spammy'));
    store.save(muteList(['spammer'], 130));
    return store;
  }

  it('filters by action and target type', () => {
    const log = buildModLog(sampleStore(), mods);
    expect(filterModLog(log, {targetType: 'user'}).map(e => e.target)).toEqual(['spammer']);
    expect(filterModLog(log, {action: 'hide', targetType: 'post'}).map(e => e.target)).toEqual([
      'P1',
    ]);
  });

  it('searches content and reason', () => {
    const log = buildModLog(sampleStore(), mods);
    expect(filterModLog(log, {search: 'brown fox'}).map(e => e.target)).toEqual(['P1']);
    expect(filterModLog(log, {search: 'spammy'}).map(e => e.target)).toEqual(['P1']);
    expect(filterModLog(log, {search: 'nothing-here'})).toHaveLength(0);
  });

  it('searches the removed content via the report snapshot when the target is NOT cached', () => {
    // No post saved for P9 → ev is undefined; the body is only available via the snapshot tag.
    const store = new InMemoryEventStore();
    store.save(report('P9', 100, 'spammy', [['content-snapshot', 'the quick brown fox jumped']]));

    const log = buildModLog(store, mods);
    const entry = log.find(e => e.target === 'P9');
    expect(entry?.targetContent).toBe('the quick brown fox jumped');
    // Searchable by the removed body even though the original event left the cache.
    expect(filterModLog(log, {search: 'brown fox'}).map(e => e.target)).toEqual(['P9']);
    expect(filterModLog(log, {search: 'jumped'}).map(e => e.target)).toEqual(['P9']);
  });

  it('prefers the live cached body over the report snapshot when the target IS cached', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'author', 'live cached body'));
    store.save(report('P1', 100, 'spammy', [['content-snapshot', 'stale snapshot body']]));

    const log = buildModLog(store, mods);
    expect(log.find(e => e.target === 'P1')?.targetContent).toBe('live cached body');
  });

  it('searches by the action label (e.g. "restore")', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'author', 'hello'));
    store.save(report('P1', 100, 'spammy'));
    store.save(report('P1', 120, '', [['stiq-action', 'restore']]));

    const log = buildModLog(store, mods);
    expect(filterModLog(log, {search: 'restore'}).map(e => e.action)).toEqual(['restore']);
  });

  it('filters by date window', () => {
    const log = buildModLog(sampleStore(), mods);
    expect(filterModLog(log, {since: 120}).map(e => e.target)).toEqual(['spammer']);
    expect(filterModLog(log, {until: 120}).map(e => e.target)).toEqual(['P1']);
  });
});

describe('moderatorsInLog', () => {
  it('lists distinct moderators', () => {
    const store = new InMemoryEventStore();
    store.save(report('P1', 100));
    const found = moderatorsInLog(buildModLog(store, mods));
    expect(found).toEqual([{pubkey: modPub, npub: modNpub}]);
  });
});

// ── advisory routing: everything blocked by the mods (posts + comments) shows in the log ──────────

/** A kind-1984 advisory directive (log-user / log / log-batch / unlog-user), by the test moderator. */
function advisoryReport(
  action: string,
  createdAt: number,
  eTags: string[][],
  pTag?: string,
): Event {
  const tags: string[][] = [...eTags];
  if (pTag) tags.push(['p', pTag]);
  tags.push(['stiq-action', action]);
  return {
    id: `adv-${action}-${createdAt}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags,
    content: '',
    sig: 's',
  };
}

describe('buildModLog — advisory content routing', () => {
  it('logs every post AND comment of an author under a log-user standing rule', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'baddie', 'first spam'));
    store.save(post('P2', 'baddie', 'second spam'));
    store.save(comment('C1', 'baddie'));
    store.save(post('P3', 'gooduser', 'perfectly fine'));
    store.save(advisoryReport('log-user', 200, [], 'baddie'));

    const log = buildModLog(store, mods);
    const hidden = log.filter(e => e.action === 'hide').map(e => e.target).sort();
    expect(hidden).toEqual(['C1', 'P1', 'P2']);
    // Full body is preserved (the post stays on the relay) so the row + click-through can render it.
    expect(log.find(e => e.target === 'P1')?.targetContent).toBe('first spam');
    expect(log.find(e => e.target === 'C1')?.targetType).toBe('comment');
    // An unaffected author's post never enters the log.
    expect(log.find(e => e.target === 'P3')).toBeUndefined();
  });

  it('logs EVERY event in a log-batch, not just the first', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'baddie'));
    store.save(post('P2', 'baddie'));
    store.save(post('P3', 'baddie'));
    store.save(advisoryReport('log-batch', 300, [['e', 'P1'], ['e', 'P2'], ['e', 'P3']], 'baddie'));

    const log = buildModLog(store, mods);
    expect(log.filter(e => e.action === 'hide').map(e => e.target).sort()).toEqual(['P1', 'P2', 'P3']);
  });

  it('logs a muted author’s individual posts, alongside the "member" entry', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'spammer', 'buy now'));
    store.save(muteList(['spammer'], 130));

    const log = buildModLog(store, mods);
    expect(log.find(e => e.targetType === 'user' && e.target === 'spammer')).toBeDefined();
    expect(log.find(e => e.targetType === 'post' && e.target === 'P1')?.targetContent).toBe('buy now');
  });

  it('records a single log directive as a clickable hide entry', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'author', 'logged once'));
    store.save(advisoryReport('log', 400, [['e', 'P1']]));

    const log = buildModLog(store, mods);
    const entry = log.find(e => e.target === 'P1');
    expect(entry?.action).toBe('hide');
    expect(entry?.targetContent).toBe('logged once');
  });

  it('drops the author out of the log once a standing rule is reversed (unlog-user)', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'baddie'));
    store.save(advisoryReport('log-user', 200, [], 'baddie'));
    store.save(advisoryReport('unlog-user', 300, [], 'baddie'));

    const log = buildModLog(store, mods);
    expect(log.find(e => e.target === 'P1')).toBeUndefined();
  });

  it('does not double-count a post that is both directly hidden and clickable', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1', 'author', 'hello'));
    store.save(report('P1', 100, 'off-topic'));

    const log = buildModLog(store, mods);
    expect(log.filter(e => e.target === 'P1')).toHaveLength(1);
  });
});

// ── new stiq-action entry types ───────────────────────────────────────────────────────────────

function actionReport(
  targetId: string,
  action: string,
  createdAt: number,
  extra: string[][] = [],
): Event {
  return {
    id: `rep-${targetId}-${action}-${createdAt}`,
    pubkey: modPub,
    created_at: createdAt,
    kind: 1984,
    tags: [['e', targetId], ['stiq-action', action], ...extra],
    content: '',
    sig: 's',
  };
}

describe('buildModLog — new action types', () => {
  it('records lock and unlock entries', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(actionReport('P1', 'lock', 200));
    store.save(actionReport('P1', 'unlock', 210));

    const log = buildModLog(store, mods);
    expect(log.map(e => [e.action, e.target])).toEqual([
      ['unlock', 'P1'],
      ['lock', 'P1'],
    ]);
    // lock/unlock are not hides — no reportType
    expect(log.find(e => e.action === 'lock')?.reportType).toBeUndefined();
    expect(log.find(e => e.action === 'unlock')?.reportType).toBeUndefined();
  });

  it('records retag entries with newLabel', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(actionReport('P1', 'retag', 300, [['l', 'question', 'stiq.type']]));

    const log = buildModLog(store, mods);
    const entry = log.find(e => e.action === 'retag');
    expect(entry).toBeDefined();
    expect(entry?.target).toBe('P1');
    expect(entry?.newLabel).toBe('question');
    expect(entry?.reportType).toBeUndefined();
  });

  it('records pin and unpin entries', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(actionReport('P1', 'pin', 400));
    store.save(actionReport('P1', 'unpin', 410));

    const log = buildModLog(store, mods);
    expect(log.map(e => e.action)).toEqual(['unpin', 'pin']);
  });

  it('sets where for channel messages', () => {
    const store = new InMemoryEventStore();
    // Create a channel definition (kind 30311)
    const channelDef: Event = {
      id: 'ch-def',
      pubkey: 'owner',
      created_at: 1,
      kind: 30311,
      tags: [['d', 'mychan'], ['title', 'My Channel'], ['status', 'live']],
      content: '',
      sig: 's',
    };
    const coord = '30311:owner:mychan';
    // Create a channel message (kind 1311)
    const msg: Event = {
      id: 'msg1',
      pubkey: 'user',
      created_at: 50,
      kind: 1311,
      tags: [['a', coord, '', 'root']],
      content: 'hello channel',
      sig: 's',
    };
    store.save(channelDef);
    store.save(msg);
    store.save(actionReport('msg1', 'lock', 500));

    const log = buildModLog(store, mods);
    const entry = log.find(e => e.action === 'lock');
    expect(entry?.where).toBe('My Channel');
  });

  it('leaves where undefined for global feed posts', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(actionReport('P1', 'pin', 600));

    const log = buildModLog(store, mods);
    const entry = log.find(e => e.action === 'pin');
    expect(entry?.where).toBeUndefined();
  });
});

describe('filterModLog — new action types', () => {
  it('filters by lock action', () => {
    const store = new InMemoryEventStore();
    store.save(post('P1'));
    store.save(post('P2'));
    store.save(actionReport('P1', 'lock', 100));
    store.save(actionReport('P2', 'pin', 200));

    const log = buildModLog(store, mods);
    expect(filterModLog(log, {action: 'lock'}).map(e => e.target)).toEqual(['P1']);
    expect(filterModLog(log, {action: 'pin'}).map(e => e.target)).toEqual(['P2']);
  });

  it('searches where in the haystack', () => {
    const store = new InMemoryEventStore();
    const channelDef: Event = {
      id: 'ch-def2',
      pubkey: 'owner2',
      created_at: 1,
      kind: 30311,
      tags: [['d', 'news'], ['title', 'News Feed'], ['status', 'live']],
      content: '',
      sig: 's',
    };
    const coord = '30311:owner2:news';
    const msg: Event = {
      id: 'msg2',
      pubkey: 'user',
      created_at: 50,
      kind: 1311,
      tags: [['a', coord, '', 'root']],
      content: 'breaking news',
      sig: 's',
    };
    store.save(channelDef);
    store.save(msg);
    store.save(actionReport('msg2', 'lock', 700));

    const log = buildModLog(store, mods);
    expect(filterModLog(log, {search: 'news feed'}).map(e => e.target)).toEqual(['msg2']);
    expect(filterModLog(log, {search: 'breaking'}).map(e => e.target)).toEqual(['msg2']);
    expect(filterModLog(log, {search: 'nowhere'})).toHaveLength(0);
  });

  it('searches newLabel in the haystack', () => {
    const store = new InMemoryEventStore();
    store.save(post('P3'));
    store.save(actionReport('P3', 'retag', 800, [['l', 'insight', 'stiq.type']]));

    const log = buildModLog(store, mods);
    expect(filterModLog(log, {search: 'insight'}).map(e => e.target)).toEqual(['P3']);
  });
});

describe('buildModLog — unattributable blind posts (anonymization enforcement)', () => {
  const communityKey = mintGroupKey();
  // Real holder-bound keypair so the attributed post decrypts back to its author (P3 signs with q0).
  const {q: tokenSecret, Q: tokenPub} = newTokenKeypair();
  const token: Token = {token: tokenPub, sig: Uint8Array.of(2), secret: tokenSecret};
  const authorSk = generateSecretKey();

  beforeEach(() => setActiveCommunityKey(communityKey));
  afterEach(() => setActiveCommunityKey(null));

  function unattrBlind(content: string, kind = 1): Event {
    return assembleBlindEvent({kind, created_at: 100, tags: [], content}, [token], 'garbage');
  }

  it('surfaces an unattributable post as an automatic structural hide', () => {
    const store = new InMemoryEventStore();
    const ev = unattrBlind('anonymous spoof');
    store.save(ev);

    const entry = buildModLog(store, mods).find(e => e.target === ev.id);
    expect(entry).toBeDefined();
    expect(entry?.auto).toBe(true);
    expect(entry?.action).toBe('hide');
    expect(entry?.reason).toBe(UNATTRIBUTED_REASON);
    expect(entry?.reportType).toBe(UNATTRIBUTED_REPORT_TYPE);
    expect(entry?.targetContent).toBe('anonymous spoof');
    expect(entry?.moderatorNpub).toBe('');
    // The absence of a resolvable author is the point — no targetAuthorPubkey.
    expect(entry?.targetAuthorPubkey).toBeUndefined();
  });

  it('classifies an unattributable kind-1111 as a comment', () => {
    const store = new InMemoryEventStore();
    const ev = unattrBlind('anon comment', 1111);
    store.save(ev);
    expect(buildModLog(store, mods).find(e => e.target === ev.id)?.targetType).toBe('comment');
  });

  it('does NOT list a properly attributed blind post', () => {
    const store = new InMemoryEventStore();
    const ev = toBlindEvent({kind: 1, created_at: 100, tags: [], content: 'legit'}, [token], authorSk, communityKey, {
      name: 'alice',
    });
    store.save(ev);
    expect(buildModLog(store, mods).find(e => e.target === ev.id)).toBeUndefined();
  });
});

/**
 * Blind-author attribution on mod-log rows (audit 2026-07-29, defect D2).
 *
 * Three entry builders recorded `targetAuthorPubkey: ev.pubkey` — the per-post THROWAWAY signer,
 * a fresh key for every blind post — instead of the real author decrypted from `stiq_attr`. The
 * damage is twofold: the row renders a garbage identity (LogScreen feeds the value straight to
 * getProfile), and searching the mod log by the offender's real npub MISSES those entries, so a
 * moderator reviewing someone's history sees a partial record. The suite's other blocks use
 * synthetic non-blind pubkeys, where the two values coincide — which is why the seam was untested.
 *
 * Restore was never affected: un-hide matching keys on the target's event id, and the author pubkey
 * only ever rides along as an inert `p` tag.
 */
describe('buildModLog — blind posts are attributed to their REAL author, not the throwaway signer', () => {
  const communityKey = mintGroupKey();
  const {q: tokenSecret, Q: tokenPub} = newTokenKeypair();
  const token: Token = {token: tokenPub, sig: Uint8Array.of(2), secret: tokenSecret};
  const authorSk = generateSecretKey();
  const authorPub = getPublicKey(authorSk);
  const authorNpub = nip19.npubEncode(authorPub);

  beforeEach(() => setActiveCommunityKey(communityKey));
  afterEach(() => setActiveCommunityKey(null));

  /** A blind post by `authorSk`: signed by a throwaway key, real author sealed in the attribution. */
  function blind(id: string, content = 'blind body', kind = 1): Event {
    const ev = toBlindEvent({kind, created_at: 100, tags: [], content}, [token], authorSk, communityKey, {
      name: 'alice',
    });
    return {...ev, id};
  }

  it('a plain moderator hide records the real author (block 1)', () => {
    const store = new InMemoryEventStore();
    const ev = blind('P-blind');
    store.save(ev);
    store.save(report('P-blind', 20));

    const entry = buildModLog(store, mods).find(e => e.target === 'P-blind');
    expect(entry).toBeDefined();
    expect(ev.pubkey).not.toBe(authorPub); // the signer really is a throwaway key
    expect(entry?.targetAuthorPubkey).toBe(authorPub);
  });

  it('the hidden post is findable by searching the offender\'s real npub', () => {
    const store = new InMemoryEventStore();
    store.save(blind('P-blind'));
    store.save(report('P-blind', 20));

    const log = buildModLog(store, mods);
    expect(filterModLog(log, {search: authorNpub}).map(e => e.target)).toEqual(['P-blind']);
  });

  it('a lock / re-tag / pin action on a blind post also records the real author (block 1)', () => {
    const store = new InMemoryEventStore();
    store.save(blind('P-lock'));
    store.save(report('P-lock', 20, '', [['stiq-action', 'lock']]));

    const entry = buildModLog(store, mods).find(e => e.target === 'P-lock');
    expect(entry?.action).toBe('lock');
    expect(entry?.targetAuthorPubkey).toBe(authorPub);
  });

  it('an organizer auto-mod hide records the real author (block 3)', () => {
    const store = new InMemoryEventStore();
    // Over the note length limit → auto-hidden by the organizer's post rules.
    store.save(blind('P-auto', 'x'.repeat(50)));
    const autoCfg = {
      postRules: {...DEFAULT_POST_RULES, note: {...DEFAULT_POST_RULES.note, max: 10}},
      postRulesAt: 0,
    };

    const entry = buildModLog(store, mods, autoCfg).find(e => e.target === 'P-auto');
    expect(entry?.auto).toBe(true);
    expect(entry?.reportType).toBe('too-long');
    expect(entry?.targetAuthorPubkey).toBe(authorPub);
  });
});

// 2026-07-21 members-only invisible-unlock incident: a hidden post/comment can itself be SEALED
// under a content epoch key (the blind feedSigner's content-encryption meter). targetContent must
// never surface that ciphertext — a still-locked target logs '' and self-corrects once its epoch
// unlocks, and (report.ts's own fix) a report published while locked never carried a snapshot to
// fall back to in the first place.
describe('buildModLog — sealed (locked) target content is never surfaced as ciphertext', () => {
  // A community key is needed only for the unattributable-post test below (isUnattributedBlindPost
  // defers without one) — harmless to have active for the plain moderator-hide test too.
  const communityKey2 = mintGroupKey();
  const {q: sealedSecret, Q: sealedPub} = newTokenKeypair();
  const sealedToken: Token = {token: sealedPub, sig: Uint8Array.of(4), secret: sealedSecret};

  beforeEach(() => setActiveCommunityKey(communityKey2));
  afterEach(() => {
    clearActiveContentKeys();
    setActiveCommunityKey(null);
  });

  function sealedBlind(plaintext: string, epoch: number, key: Uint8Array): Event {
    const ct = encryptForSpace(plaintext, key);
    return assembleBlindEvent(
      {kind: 1, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, String(epoch)]], content: ct},
      [sealedToken],
      'attr',
    );
  }

  it('a moderator hide on a still-locked sealed post logs \'\' — never the ciphertext — and the plaintext once unlocked', () => {
    const key = mintContentKey();
    const ev = sealedBlind('members-only removed body', 6, key);
    const store = new InMemoryEventStore();
    store.save(ev);
    store.save(report(ev.id, 200, 'spam'));

    const lockedEntry = buildModLog(store, mods).find(e => e.target === ev.id);
    expect(lockedEntry).toBeDefined();
    expect(lockedEntry?.targetContent).toBe('');
    expect(lockedEntry?.targetContent).not.toContain(ev.content);

    setContentEpochKey(6, key);
    const unlockedEntry = buildModLog(store, mods).find(e => e.target === ev.id);
    expect(unlockedEntry?.targetContent).toBe('members-only removed body');
  });

  it('an unattributable sealed blind post logs \'\' while locked, never the ciphertext', () => {
    const key = mintContentKey();
    const ev = sealedBlind('anonymous sealed spoof', 9, key);
    const store = new InMemoryEventStore();
    store.save(ev); // no valid attestation ('garbage' attr) → routed via the unattributable path

    const lockedEntry = buildModLog(store, mods).find(e => e.target === ev.id);
    expect(lockedEntry).toBeDefined();
    expect(lockedEntry?.targetContent).toBe('');
    expect(lockedEntry?.targetContent).not.toContain(ev.content);

    setContentEpochKey(9, key);
    const unlockedEntry = buildModLog(store, mods).find(e => e.target === ev.id);
    expect(unlockedEntry?.targetContent).toBe('anonymous sealed spoof');
  });
});

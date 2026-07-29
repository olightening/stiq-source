import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {InMemoryEventStore} from '../nostr/store';
import {pendingReports, thresholdHiddenTargets} from './queue';
import {DEFAULT_REASONS, type ReasonsConfig} from './reasons';
import {buildLogUser, buildUnlogUser, buildLogEvent} from './advisory';
import {assembleBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {encryptForSpace} from '../channels/groupCrypto';
import {mintContentKey, setContentEpochKey, clearActiveContentKeys} from '../blind/contentKey';
import {TAG_ENC, ENC_NIP44, TAG_KE} from '../blind/protocol';
import type {Token} from '../blind/wallet';

const modPub = getPublicKey(generateSecretKey());
const mods = [nip19.npubEncode(modPub)];
const AUTHOR = getPublicKey(generateSecretKey());
const memberA = getPublicKey(generateSecretKey());
const memberB = getPublicKey(generateSecretKey());

function post(id: string, content = 'a reported idea', pubkey = AUTHOR): Event {
  return {id, pubkey, created_at: 100, kind: 1, tags: [], content, sig: 's'};
}
function comment(id: string): Event {
  // kind-1111 NIP-22 comment
  return {id, pubkey: AUTHOR, created_at: 100, kind: 1111, tags: [['E', 'root']], content: 'a reply', sig: 's'};
}
function memberReport(target: string, by: string, at: number, reasonId = 'spam', note = ''): Event {
  return {
    id: `rep-${by}-${target}-${at}`,
    pubkey: by,
    created_at: at,
    kind: 1984,
    tags: [['e', target, reasonId], ['p', AUTHOR]],
    content: note,
    sig: 's',
  };
}
function modHide(target: string, at: number): Event {
  return {id: `hide-${target}-${at}`, pubkey: modPub, created_at: at, kind: 1984, tags: [['e', target, 'spam']], content: '', sig: 's'};
}
function modBan(pubkey: string, at: number): Event {
  return {id: `ban-${at}`, pubkey: modPub, created_at: at, kind: 1984, tags: [['p', pubkey], ['stiq-action', 'ban']], content: 'banned', sig: 's'};
}
/** A moderator-signed advisory directive (log-user / unlog-user / log), stamped so latest-wins is testable. */
function modAdvisory(id: string, unsigned: {kind: number; tags: string[][]; content: string}, at: number): Event {
  return {id, pubkey: modPub, created_at: at, kind: unsigned.kind, tags: unsigned.tags, content: unsigned.content, sig: 's'};
}
function storeWith(...events: Event[]): InMemoryEventStore {
  const s = new InMemoryEventStore();
  for (const e of events) s.save(e);
  return s;
}

describe('pendingReports', () => {
  it('aggregates distinct members reporting one target into a single row', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), memberReport('p1', memberB, 210, 'harassment', 'please review'));
    const q = pendingReports(s, mods, DEFAULT_REASONS, 1000);
    expect(q).toHaveLength(1);
    const row = q[0]!;
    expect(row.targetId).toBe('p1');
    expect(row.reporterCount).toBe(2);
    expect(row.authorPubkey).toBe(AUTHOR);
    expect(row.snippet).toBe('a reported idea');
    expect(row.reasons.map(r => r.id).sort()).toEqual(['harassment', 'spam']);
    expect(row.notes).toEqual(['please review']);
    expect(row.latestAt).toBe(210);
  });

  it('counts a member who reports twice only once', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), memberReport('p1', memberA, 260));
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)[0]!.reporterCount).toBe(1);
  });

  it('ignores reports authored by a moderator (mods act directly)', () => {
    const s = storeWith(post('p1'), modHide('p1', 200));
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(0);
  });

  it('excludes a target a moderator has already hidden', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), modHide('p1', 300));
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(0);
  });

  it('excludes a target whose author is banned', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), modBan(AUTHOR, 300));
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(0);
  });

  it('excludes a target whose author is under a standing advisory rule (log-user)', () => {
    const s = storeWith(
      post('p1'),
      memberReport('p1', memberA, 200),
      modAdvisory('adv-loguser', buildLogUser(AUTHOR), 300),
    );
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(0);
  });

  it('excludes a single target routed to the log (log-event)', () => {
    const s = storeWith(
      post('p1'),
      memberReport('p1', memberA, 200),
      modAdvisory('adv-logev', buildLogEvent('p1', AUTHOR), 300),
    );
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(0);
  });

  it('keeps the report when a standing rule was reversed (latest-wins)', () => {
    const s = storeWith(
      post('p1'),
      memberReport('p1', memberA, 200),
      modAdvisory('adv-loguser', buildLogUser(AUTHOR), 300),
      modAdvisory('adv-unlog', buildUnlogUser(AUTHOR), 400), // newer reversal wins
    );
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)).toHaveLength(1);
  });

  it('classifies a kind-1111 comment target as a comment', () => {
    const s = storeWith(comment('c1'), memberReport('c1', memberA, 200));
    expect(pendingReports(s, mods, DEFAULT_REASONS, 1000)[0]!.targetType).toBe('comment');
  });

  it('flags thresholdReached once enough distinct members report', () => {
    const cfg: ReasonsConfig = {...DEFAULT_REASONS, reportThreshold: 2};
    const one = storeWith(post('p1'), memberReport('p1', memberA, 200));
    expect(pendingReports(one, mods, cfg, 1000)[0]!.thresholdReached).toBe(false);
    const two = storeWith(post('p1'), memberReport('p1', memberA, 200), memberReport('p1', memberB, 210));
    expect(pendingReports(two, mods, cfg, 1000)[0]!.thresholdReached).toBe(true);
  });

  it('orders threshold-reached and most-reported targets first', () => {
    const cfg: ReasonsConfig = {...DEFAULT_REASONS, reportThreshold: 2};
    const s = storeWith(
      post('low', 'low'),
      post('hot', 'hot'),
      memberReport('low', memberA, 200),
      memberReport('hot', memberA, 210),
      memberReport('hot', memberB, 220),
    );
    const q = pendingReports(s, mods, cfg, 1000);
    expect(q.map(r => r.targetId)).toEqual(['hot', 'low']);
  });

  it('resolves an unknown reason id to a neutral chip rather than dropping it', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200, 'deleted-bucket'));
    const row = pendingReports(s, mods, DEFAULT_REASONS, 1000)[0]!;
    expect(row.reasons[0]).toEqual({id: 'deleted-bucket', name: 'deleted-bucket', color: '#8a8f98'});
  });

  // 2026-07-21 members-only invisible-unlock incident: a reported post/comment can itself be SEALED
  // under a content epoch key (the blind feedSigner's content-encryption meter). The queue's snippet
  // must never surface that ciphertext.
  describe('snippet of a sealed (locked) reported target', () => {
    afterEach(() => clearActiveContentKeys());

    it('reports \'\' while locked; the real excerpt once its epoch unlocks', () => {
      const key = mintContentKey();
      const {q, Q} = newTokenKeypair();
      const token: Token = {token: Q, sig: Uint8Array.of(7), secret: q};
      const ct = encryptForSpace('a members-only reported body', key);
      const sealed = assembleBlindEvent(
        {kind: 1, created_at: 100, tags: [[TAG_ENC, ENC_NIP44], [TAG_KE, '11']], content: ct},
        [token],
        'attr',
      );
      const s = storeWith(sealed, memberReport(sealed.id, memberA, 200));

      const lockedRow = pendingReports(s, mods, DEFAULT_REASONS, 1000).find(r => r.targetId === sealed.id);
      expect(lockedRow?.snippet).toBe('');
      expect(lockedRow?.snippet).not.toContain(sealed.content);

      setContentEpochKey(11, key);
      const unlockedRow = pendingReports(s, mods, DEFAULT_REASONS, 1000).find(r => r.targetId === sealed.id);
      expect(unlockedRow?.snippet).toBe('a members-only reported body');
    });
  });
});

/**
 * Report-threshold auto-hide (audit 2026-07-29, defect D3).
 *
 * `reasons.ts` has always documented reportThreshold as "once that many DISTINCT members report one
 * item it is auto-hidden pending moderator review", and prod runs a threshold of 5 — but nothing
 * ever hid anything. `thresholdReached` reached only the queue's sort order and a console pill; a
 * repo-wide grep found zero references in any feed path. This is the suppression half.
 */
describe('thresholdHiddenTargets', () => {
  const memberC = getPublicKey(generateSecretKey());
  const threshold = (n: number): ReasonsConfig => ({...DEFAULT_REASONS, reportThreshold: n});
  function modRestore(target: string, at: number): Event {
    return {
      id: `restore-${target}-${at}`,
      pubkey: modPub,
      created_at: at,
      kind: 1984,
      tags: [['e', target], ['stiq-action', 'restore']],
      content: '',
      sig: 's',
    };
  }

  it('hides a target once DISTINCT reporters reach the threshold', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), memberReport('p1', memberB, 210));
    expect([...thresholdHiddenTargets(s, mods, threshold(2))]).toEqual(['p1']);
  });

  it('does not hide below the threshold', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200));
    expect(thresholdHiddenTargets(s, mods, threshold(2)).size).toBe(0);
  });

  it('counts DISTINCT members — one member reporting repeatedly never crosses it', () => {
    const s = storeWith(
      post('p1'),
      memberReport('p1', memberA, 200),
      memberReport('p1', memberA, 210, 'harassment'),
      memberReport('p1', memberA, 220, 'off-topic'),
    );
    expect(thresholdHiddenTargets(s, mods, threshold(2)).size).toBe(0);
  });

  it('is disabled at threshold 0 (the default) no matter how many reports land', () => {
    const s = storeWith(
      post('p1'),
      memberReport('p1', memberA, 200),
      memberReport('p1', memberB, 210),
      memberReport('p1', memberC, 220),
    );
    expect(thresholdHiddenTargets(s, mods, DEFAULT_REASONS).size).toBe(0);
    expect(DEFAULT_REASONS.reportThreshold).toBe(0);
  });

  it('ignores MODERATOR reports — one moderator must not masquerade as member consensus', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), modHide('p1', 210));
    expect(thresholdHiddenTargets(s, mods, threshold(2)).size).toBe(0);
  });

  it('ignores non-hide stiq-actions (ban/lock/retag carry their own semantics)', () => {
    const s = storeWith(post('p1'), memberReport('p1', memberA, 200), modBan(AUTHOR, 210));
    expect(thresholdHiddenTargets(s, mods, threshold(2)).size).toBe(0);
  });

  it('a moderator RESTORE overrides the auto-hide, and stays final as more reports arrive', () => {
    const base = [post('p1'), memberReport('p1', memberA, 200), memberReport('p1', memberB, 210)];
    expect([...thresholdHiddenTargets(storeWith(...base), mods, threshold(2))]).toEqual(['p1']);

    const restored = storeWith(...base, modRestore('p1', 220));
    expect(thresholdHiddenTargets(restored, mods, threshold(2)).size).toBe(0);

    // A later brigade cannot re-hide what a moderator already cleared: the restore remains the
    // latest MODERATOR visibility action, which is what restoredIds keys on.
    const brigaded = storeWith(...base, modRestore('p1', 220), memberReport('p1', memberC, 230));
    expect(thresholdHiddenTargets(brigaded, mods, threshold(2)).size).toBe(0);
  });

  it('tracks each target independently', () => {
    const s = storeWith(
      post('p1'),
      post('p2'),
      memberReport('p1', memberA, 200),
      memberReport('p1', memberB, 205),
      memberReport('p2', memberA, 210),
    );
    expect([...thresholdHiddenTargets(s, mods, threshold(2))]).toEqual(['p1']);
  });

  it('works on comments as well as posts', () => {
    const s = storeWith(comment('c1'), memberReport('c1', memberA, 200), memberReport('c1', memberB, 210));
    expect([...thresholdHiddenTargets(s, mods, threshold(2))]).toEqual(['c1']);
  });
});

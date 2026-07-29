// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so the
// runtime logic can be exercised in the test environment (same preamble as memberRoll/capsSticky).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {toBlindEvent} from '../blind/blindPost';
import {newTokenKeypair} from '../blind/holderProof';
import {ORGANIZER_D_MODERATORS} from '../moderation/organizerConfig';
import {ACTION_TAG} from '../moderation/report';
import {REASONS_D_TAG, encodeReasons, DEFAULT_REASONS} from '../moderation/reasons';
import {PENDING_REVIEW_REPORT_TYPE} from '../moderation/modlog';
import {Kind} from '../nostr/events';
import type {CommentNode} from '../feed/thread';
import type {Token} from '../blind/wallet';

/**
 * Thread-level enforcement of the community-wide moderation actions (audit 2026-07-29, defect D1).
 *
 * `moderatedThread` is the single choke point behind getThread() and getChannelThread() — every
 * member-facing comment view. It used to consult ONLY the plain hide map (kind-1984 hide reports +
 * kind-10000 mute lists), never the advisory overlay or the banned-author set that the feed path
 * applies. So the two MOST SEVERE moderator actions leaked in the highest-engagement surface:
 *
 *   • `log-user` — a standing rule carries only a `p` tag, so it never enters the hide map at all;
 *   • `ban`      — bannedAuthors() was consumed by the feed builder only;
 *   • `log-batch` ids 2..n — reportedPostId() reads only the FIRST `e` tag, so a batch of N hid one.
 *
 * Every case below FAILED before the fix, with zero test coverage — which is exactly why it shipped.
 * The deferral cases pin the other half of the contract: nothing here may hide content when no
 * moderator (or a non-rostered impostor) asked for it.
 */
const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK_BYTES = new Uint8Array(32).fill(7);
const CK = Buffer.from(CK_BYTES).toString('base64');

const organizerSk = generateSecretKey();
const ORG_PUBKEY = getPublicKey(organizerSk);
const modSk = generateSecretKey();
const MOD_PUBKEY = getPublicKey(modSk);
const aliceSk = generateSecretKey();
const ALICE = getPublicKey(aliceSk);
const bobSk = generateSecretKey(); // the untouched bystander in every case below

const ROOT_ID = 'r'.repeat(64);

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl: RELAY, issuerPublicKey: 'aXNz', organizerPubkey: ORG_PUBKEY, communityKey: CK},
    new MockBlindRsa(),
    'STIQ-TEST-THRD',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

interface Harness {
  runtime: AppRuntime;
  store: SwappableEventStore;
}

async function enrolledRuntime(): Promise<Harness> {
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  // The organizer's roster makes MOD_PUBKEY a real moderator — every directive below is ignored
  // outright unless its signer is on this roster.
  store.save(
    finalizeEvent(
      {
        kind: Kind.AppData,
        created_at: 500,
        tags: [['d', ORGANIZER_D_MODERATORS], ['p', MOD_PUBKEY]],
        content: '',
      },
      organizerSk,
    ),
  );
  return {runtime, store};
}

let seq = 0;
/** A plain (npub-signed) kind-1111 comment under ROOT_ID. */
function comment(sk: Uint8Array, text: string): Event {
  seq += 1;
  return finalizeEvent(
    {
      kind: Kind.Comment,
      created_at: 1000 + seq,
      tags: [['E', ROOT_ID], ['e', ROOT_ID]],
      content: text,
    },
    sk,
  );
}

function freshToken(): Token {
  const {q, Q} = newTokenKeypair();
  return {token: Q, sig: Uint8Array.of(2), secret: q};
}

/** A BLIND kind-1111 comment: throwaway signer, real author sealed in `stiq_attr`. */
function blindComment(sk: Uint8Array, text: string): Event {
  seq += 1;
  return toBlindEvent(
    {kind: Kind.Comment, created_at: 1000 + seq, tags: [['E', ROOT_ID], ['e', ROOT_ID]], content: text},
    [freshToken()],
    sk,
    CK_BYTES,
    {name: 'someone'},
  );
}

/** A BLIND feed post whose real author is `sk`'s npub. */
function blindPost(sk: Uint8Array, text: string): Event {
  seq += 1;
  return toBlindEvent({kind: Kind.Post, created_at: 1000 + seq, tags: [], content: text}, [freshToken()], sk, CK_BYTES, {
    name: 'someone',
  });
}

/** A moderator-signed kind-1984 directive. */
function modEvent(tags: string[][], content = ''): Event {
  seq += 1;
  return finalizeEvent({kind: Kind.Report, created_at: 2000 + seq, tags, content}, modSk);
}

/** Flatten a comment tree to its event ids. */
function ids(nodes: CommentNode[]): string[] {
  return nodes.flatMap(n => [n.event.id, ...ids(n.children)]);
}

describe('moderatedThread — standing advisory rules (log-user)', () => {
  it('hides every comment from an author under a standing log-user rule', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice one');
    const a2 = comment(aliceSk, 'alice two');
    const b1 = comment(bobSk, 'bob stays');
    store.save(a1);
    store.save(a2);
    store.save(b1);
    expect(ids(runtime.getThread(ROOT_ID)).sort()).toEqual([a1.id, a2.id, b1.id].sort());

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'log-user']]));

    const visible = ids(runtime.getThread(ROOT_ID));
    expect(visible).toEqual([b1.id]);
    runtime.dispose();
  });

  it('follows a blind comment to its REAL author (the standing rule survives throwaway keys)', async () => {
    const {runtime, store} = await enrolledRuntime();
    const blind = blindComment(aliceSk, 'alice, blind-signed');
    const other = blindComment(bobSk, 'bob, blind-signed');
    store.save(blind);
    store.save(other);
    // The comment is signed by a throwaway key — only the decrypted attribution names ALICE.
    expect(blind.pubkey).not.toBe(ALICE);

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'log-user']]));

    expect(ids(runtime.getThread(ROOT_ID))).toEqual([other.id]);
    runtime.dispose();
  });

  it('a later unlog-user returns the author\'s comments to the thread (latest wins)', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice one');
    store.save(a1);
    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'log-user']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([]);

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'unlog-user']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([a1.id]);
    runtime.dispose();
  });
});

describe('moderatedThread — bans', () => {
  it('hides comments authored by a banned npub', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    const b1 = comment(bobSk, 'bob');
    store.save(a1);
    store.save(b1);

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'ban']], 'off you go'));

    expect(ids(runtime.getThread(ROOT_ID))).toEqual([b1.id]);
    runtime.dispose();
  });

  it('a later unban restores them', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    store.save(a1);
    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'ban']], 'off you go'));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([]);

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'unban']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([a1.id]);
    runtime.dispose();
  });

  it('an EXPIRED ban does not hide (ban-until in the past)', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    store.save(a1);
    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'ban'], ['ban-until', '1']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([a1.id]);
    runtime.dispose();
  });
});

describe('moderatedThread — log-batch names MANY events, not just the first', () => {
  it('hides every id in the batch (the first-e-tag bug hid only one)', async () => {
    const {runtime, store} = await enrolledRuntime();
    const c1 = comment(aliceSk, 'one');
    const c2 = comment(aliceSk, 'two');
    const c3 = comment(aliceSk, 'three');
    const keep = comment(bobSk, 'untouched');
    [c1, c2, c3, keep].forEach(e => store.save(e));

    store.save(
      modEvent([['e', c1.id], ['e', c2.id], ['e', c3.id], ['p', ALICE], [ACTION_TAG, 'log-batch']]),
    );

    expect(ids(runtime.getThread(ROOT_ID))).toEqual([keep.id]);
    runtime.dispose();
  });

  it('a restore on ONE batch member returns just that comment', async () => {
    const {runtime, store} = await enrolledRuntime();
    const c1 = comment(aliceSk, 'one');
    const c2 = comment(aliceSk, 'two');
    store.save(c1);
    store.save(c2);
    store.save(modEvent([['e', c1.id], ['e', c2.id], ['p', ALICE], [ACTION_TAG, 'log-batch']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([]);

    store.save(modEvent([['e', c2.id], [ACTION_TAG, 'restore']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([c2.id]);
    runtime.dispose();
  });
});

describe('moderatedThread — deferral (nothing hides unless a real moderator asked)', () => {
  it('leaves the thread untouched when no moderator has acted', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    const b1 = comment(bobSk, 'bob');
    store.save(a1);
    store.save(b1);
    expect(ids(runtime.getThread(ROOT_ID)).sort()).toEqual([a1.id, b1.id].sort());
    runtime.dispose();
  });

  it('ignores a log-user / ban from a pubkey that is NOT on the organizer roster', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    store.save(a1);
    const impostorSk = generateSecretKey();
    store.save(
      finalizeEvent(
        {kind: Kind.Report, created_at: 3000, tags: [['p', ALICE], [ACTION_TAG, 'log-user']], content: ''},
        impostorSk,
      ),
    );
    store.save(
      finalizeEvent(
        {kind: Kind.Report, created_at: 3001, tags: [['p', ALICE], [ACTION_TAG, 'ban']], content: ''},
        impostorSk,
      ),
    );
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([a1.id]);
    runtime.dispose();
  });

  it('un-rostering the moderator retroactively un-hides their thread actions', async () => {
    const {runtime, store} = await enrolledRuntime();
    const a1 = comment(aliceSk, 'alice');
    store.save(a1);
    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'ban']]));
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([]);

    // The organizer republishes a roster WITHOUT this moderator — every action they took stops
    // counting on the next read (the roster gates the fold, it isn't a snapshot).
    store.save(
      finalizeEvent(
        {kind: Kind.AppData, created_at: 4000, tags: [['d', ORGANIZER_D_MODERATORS]], content: ''},
        organizerSk,
      ),
    );
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([a1.id]);
    runtime.dispose();
  });
});

/**
 * Report-threshold auto-hide, end-to-end (audit 2026-07-29, defect D3).
 *
 * The organizer doc has carried `reportThreshold` since the feature shipped — prod runs 5 — and
 * `reasons.ts` documents it as "auto-hidden pending moderator review". In reality the flag reached
 * only the queue's sort order and a console pill: a post crossing the threshold stayed fully
 * visible to every member until a human acted. These pin the suppression half, on BOTH surfaces,
 * plus the reversal a moderator needs to undo a brigade.
 */
describe('report-threshold auto-hide', () => {
  const memberSks = [generateSecretKey(), generateSecretKey(), generateSecretKey()];

  /** The organizer's reasons doc, carrying a report threshold. */
  function reasonsDoc(threshold: number, createdAt = 600): Event {
    return finalizeEvent(
      {
        kind: Kind.AppData,
        created_at: createdAt,
        tags: [['d', REASONS_D_TAG]],
        content: JSON.stringify(encodeReasons({...DEFAULT_REASONS, reportThreshold: threshold})),
      },
      organizerSk,
    );
  }

  /** A member (NON-moderator) hide-report against `targetId`. */
  function memberReport(sk: Uint8Array, targetId: string): Event {
    seq += 1;
    return finalizeEvent(
      {kind: Kind.Report, created_at: 2500 + seq, tags: [['e', targetId, 'spam']], content: ''},
      sk,
    );
  }

  /** Apply an organizer config doc the way relay ingestion does (store + live dispatch). */
  function ingestConfig(h: Harness, ev: Event): void {
    h.store.save(ev);
    h.runtime.handleIncomingEvent(ev);
  }

  it('hides a post from the feed once enough DISTINCT members report it', async () => {
    const h = await enrolledRuntime();
    ingestConfig(h, reasonsDoc(2));
    const post = finalizeEvent({kind: Kind.Post, created_at: 1000, tags: [], content: 'brigaded'}, aliceSk);
    h.store.save(post);
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).toContain(post.id);

    h.store.save(memberReport(memberSks[0]!, post.id));
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).toContain(post.id); // 1 < 2

    h.store.save(memberReport(memberSks[1]!, post.id));
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).not.toContain(post.id);
    h.runtime.dispose();
  });

  it('hides a threshold-crossing COMMENT from the thread too', async () => {
    const h = await enrolledRuntime();
    ingestConfig(h, reasonsDoc(2));
    const c1 = comment(aliceSk, 'brigaded comment');
    const c2 = comment(bobSk, 'fine comment');
    h.store.save(c1);
    h.store.save(c2);

    h.store.save(memberReport(memberSks[0]!, c1.id));
    h.store.save(memberReport(memberSks[1]!, c1.id));

    expect(ids(h.runtime.getThread(ROOT_ID))).toEqual([c2.id]);
    h.runtime.dispose();
  });

  it('surfaces the auto-hide in the mod log as a RESTORABLE row', async () => {
    const h = await enrolledRuntime();
    ingestConfig(h, reasonsDoc(2));
    const post = finalizeEvent({kind: Kind.Post, created_at: 1000, tags: [], content: 'brigaded'}, aliceSk);
    h.store.save(post);
    h.store.save(memberReport(memberSks[0]!, post.id));
    h.store.save(memberReport(memberSks[1]!, post.id));

    const row = h.runtime.getModLog().find(e => e.target === post.id);
    expect(row).toBeDefined();
    expect(row?.auto).toBe(true);
    expect(row?.reportType).toBe(PENDING_REVIEW_REPORT_TYPE);
    expect(row?.targetAuthorPubkey).toBe(ALICE);
    h.runtime.dispose();
  });

  it('a moderator restore returns it to the feed and thread, and further reports cannot re-hide it', async () => {
    const h = await enrolledRuntime();
    ingestConfig(h, reasonsDoc(2));
    const c1 = comment(aliceSk, 'false positive');
    h.store.save(c1);
    h.store.save(memberReport(memberSks[0]!, c1.id));
    h.store.save(memberReport(memberSks[1]!, c1.id));
    expect(ids(h.runtime.getThread(ROOT_ID))).toEqual([]);

    h.store.save(modEvent([['e', c1.id], [ACTION_TAG, 'restore']]));
    expect(ids(h.runtime.getThread(ROOT_ID))).toEqual([c1.id]);

    // A brigade cannot undo a moderator's decision by piling on more reports.
    h.store.save(memberReport(memberSks[2]!, c1.id));
    expect(ids(h.runtime.getThread(ROOT_ID))).toEqual([c1.id]);
    h.runtime.dispose();
  });

  it('is inert with no threshold configured — the default, and every community that never set one', async () => {
    const h = await enrolledRuntime();
    const post = finalizeEvent({kind: Kind.Post, created_at: 1000, tags: [], content: 'reported a lot'}, aliceSk);
    h.store.save(post);
    memberSks.forEach(sk => h.store.save(memberReport(sk, post.id)));
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).toContain(post.id);
    h.runtime.dispose();
  });

  it('raising the threshold live un-hides a post that no longer crosses it', async () => {
    const h = await enrolledRuntime();
    ingestConfig(h, reasonsDoc(2));
    const post = finalizeEvent({kind: Kind.Post, created_at: 1000, tags: [], content: 'borderline'}, aliceSk);
    h.store.save(post);
    h.store.save(memberReport(memberSks[0]!, post.id));
    h.store.save(memberReport(memberSks[1]!, post.id));
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).not.toContain(post.id);

    // The organizer raises the bar. No feed-kind event moved — only the 30078 reasons doc — so this
    // pins that the threshold value really is part of the feed cache key.
    ingestConfig(h, reasonsDoc(3, 700));
    expect(h.runtime.getSnapshot().feed.items.map(i => i.id)).toContain(post.id);
    h.runtime.dispose();
  });
});

// The end-to-end case the audit called out as missing coverage entirely (gap 4): a ban must reach
// BOTH surfaces for the same blind author, through the encrypted attribution rather than the signer.
describe('ban → hidden in the feed AND the thread (end-to-end, blind author)', () => {
  it('hides a banned author\'s blind post in the feed and their blind comment in the thread', async () => {
    const {runtime, store} = await enrolledRuntime();
    const post = blindPost(aliceSk, 'alice, in the feed');
    const reply = blindComment(aliceSk, 'alice, in the thread');
    const bobReply = blindComment(bobSk, 'bob, in the thread');
    [post, reply, bobReply].forEach(e => store.save(e));
    expect(runtime.getSnapshot().feed.items.map(i => i.id)).toContain(post.id);

    store.save(modEvent([['p', ALICE], [ACTION_TAG, 'ban']], 'banned'));

    expect(runtime.getSnapshot().feed.items.map(i => i.id)).not.toContain(post.id);
    expect(ids(runtime.getThread(ROOT_ID))).toEqual([bobReply.id]);
    runtime.dispose();
  });
});

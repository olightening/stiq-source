/**
 * T1 headless notify derivation. Exercises deriveHeadlessNotifications against the SAME composers +
 * shared HWM/floor/prefs the foreground uses, capturing the delivery provider via
 * setNotificationProvider (the @notifee native module is jest-stubbed, but this path never touches it
 * — it goes through the injected provider). Real NIP-17 gift wraps are built with sealDM and decrypted
 * with openDM so the DM path is end-to-end, not mocked.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {sealDM} from '../dm/dm';
import {GroupKind, Kind} from '../contracts';
import {buildComment, buildNoteComment, type EventRef} from '../feed/comments';
import {
  ensureNotifLoaded,
  setNotificationProvider,
  setSessionFloor,
  type NavTarget,
} from './notifications';
import {DEFAULT_PREFS, savePrefs} from './prefs';
import {deriveHeadlessNotifications} from './headlessNotify';

interface Fired {
  title: string;
  channelId: string;
  target: NavTarget;
}

let fired: Fired[];

async function installProvider(): Promise<void> {
  fired = [];
  setNotificationProvider(async (title, channelId, target) => {
    fired.push({title, channelId, target});
  });
  await ensureNotifLoaded();
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await AsyncStorage.clear();
  await installProvider();
});

describe('deriveHeadlessNotifications — DMs', () => {
  it('fires notifyDm exactly once for a within-lookback decryptable 1059, with the sealed sender', async () => {
    setSessionFloor(nowSec() - 900);
    const senderSk = generateSecretKey();
    const senderPub = getPublicKey(senderSk);
    const mySk = generateSecretKey();
    const myPubkey = getPublicKey(mySk);
    const wrap = sealDM(senderSk, myPubkey, 'hello');

    await deriveHeadlessNotifications({
      events: [wrap],
      mySk,
      myPubkey,
      followedGroupIds: new Set(),
    });

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      title: 'Message from Someone', // empty headless displayName → anonymized title
      channelId: 'dm',
      target: {kind: 'dm', peer: senderPub},
    });
  });

  it('suppresses a DM below the overridden floor and advances the shared HWM (no re-notify)', async () => {
    // Push the floor into the future so the just-sent DM (createdAt ≈ now) is "historical replay".
    setSessionFloor(nowSec() + 100_000);
    const senderSk = generateSecretKey();
    const senderPub = getPublicKey(senderSk);
    const mySk = generateSecretKey();
    const myPubkey = getPublicKey(mySk);
    const wrap = sealDM(senderSk, myPubkey, 'later');

    await deriveHeadlessNotifications({events: [wrap], mySk, myPubkey, followedGroupIds: new Set()});

    expect(fired).toHaveLength(0); // suppressed
    const hwmRaw = await AsyncStorage.getItem('stiq.notif.hwm');
    expect(hwmRaw).toBeTruthy();
    const hwm = JSON.parse(hwmRaw!) as Record<string, number>;
    expect(hwm[`dm:${senderPub}`]).toBeGreaterThan(0); // HWM advanced → won't re-notify next sync
  });

  it('does not notify or throw when the 1059 is not addressed to us (openDM throws)', async () => {
    setSessionFloor(nowSec() - 900);
    const senderSk = generateSecretKey();
    const otherPub = getPublicKey(generateSecretKey()); // wrap is sealed to someone else
    const notMySk = generateSecretKey();
    const wrap = sealDM(senderSk, otherPub, 'not for you');

    await expect(
      deriveHeadlessNotifications({
        events: [wrap],
        mySk: notMySk,
        myPubkey: getPublicKey(notMySk),
        followedGroupIds: new Set(),
      }),
    ).resolves.toBeUndefined();
    expect(fired).toHaveLength(0);
  });

  it('is a no-op for a gift wrap when mySk is null (locked/absent key)', async () => {
    setSessionFloor(nowSec() - 900);
    const wrap = sealDM(generateSecretKey(), getPublicKey(generateSecretKey()), 'x');
    await deriveHeadlessNotifications({
      events: [wrap],
      mySk: null,
      myPubkey: undefined,
      followedGroupIds: new Set(),
    });
    expect(fired).toHaveLength(0);
  });
});

describe('deriveHeadlessNotifications — group/channel', () => {
  const groupEvent = (pubkey: string, h: string, kind: number = GroupKind.Chat): Event =>
    ({
      id: 'e'.repeat(64),
      kind,
      pubkey,
      created_at: nowSec(),
      tags: [['h', h]],
      content: 'gm',
      sig: '0'.repeat(128),
    }) as Event;

  it('skips a followed-group message authored by self', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    await deriveHeadlessNotifications({
      events: [groupEvent(myPubkey, 'group1')],
      mySk: null,
      myPubkey,
      followedGroupIds: new Set(['group1']),
    });
    expect(fired).toHaveLength(0);
  });

  it('fires notifyChannel for a followed-group message authored by someone else', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    await deriveHeadlessNotifications({
      events: [groupEvent(otherPub, 'group1', GroupKind.Thread)],
      mySk: null,
      myPubkey,
      followedGroupIds: new Set(['group1']),
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      title: '#group1 — new post',
      channelId: 'channel',
      target: {kind: 'channel', channelId: 'group1', channelType: 'public'},
    });
  });

  it('ignores a group message for a group the user does not follow', async () => {
    setSessionFloor(nowSec() - 900);
    const otherPub = getPublicKey(generateSecretKey());
    await deriveHeadlessNotifications({
      events: [groupEvent(otherPub, 'unknown-group')],
      mySk: null,
      myPubkey: getPublicKey(generateSecretKey()),
      followedGroupIds: new Set(['group1']),
    });
    expect(fired).toHaveLength(0);
  });
});

describe('deriveHeadlessNotifications — comments (both event shapes)', () => {
  // Build a full signed-looking Event from an UnsignedEvent (buildComment/buildNoteComment never
  // touch id/pubkey/sig — deriveHeadlessNotifications never verifies a signature either, it only
  // reads kind/tags/pubkey/created_at) so these tests exercise the REAL tag shapes feed/comments.ts
  // produces, not hand-rolled approximations of them.
  const asEvent = (
    unsigned: {kind: number; created_at: number; tags: string[][]; content: string},
    authorPubkey: string,
    id: string,
  ): Event => ({...unsigned, id, pubkey: authorPubkey, sig: '0'.repeat(128)}) as Event;

  afterEach(async () => {
    // A couple of tests below flip prefs.postTypes to prove postType gating; always restore so it
    // never bleeds into a later test (prefs.ts is a module-level singleton across this whole file).
    await savePrefs(DEFAULT_PREFS);
  });

  it('fires notifyComment for a hybrid kind-1 stiq-comment reply to my post, with the empty-displayName privacy title', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'a'.repeat(64), pubkey: myPubkey, kind: Kind.Post};
    const unsigned = buildNoteComment('nice post!', root, root); // top-level: parent === root
    const ev = asEvent(unsigned, otherPub, 'b'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      title: 'Someone replied', // never a resolved name — headless has no display-name phonebook
      channelId: 'comment',
      target: {kind: 'post', rootId: root.id},
    });
  });

  it('fires notifyComment for a kind-1111 NIP-22 reply to my article', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'c'.repeat(64), pubkey: myPubkey, kind: Kind.Article};
    const unsigned = buildComment('great read', root, root);
    const ev = asEvent(unsigned, otherPub, 'd'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      title: 'Someone replied',
      channelId: 'comment',
      target: {kind: 'post', rootId: root.id},
    });
  });

  it('does not notify a self-reply (comment author === root author === me)', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'e'.repeat(64), pubkey: myPubkey, kind: Kind.Article};
    const unsigned = buildComment('replying to myself', root, root);
    const ev = asEvent(unsigned, myPubkey, 'f'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0);
  });

  it('does not notify a hybrid reply to someone ELSE\'s post that never p-tags me', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    const thirdParty = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'g'.repeat(64), pubkey: otherPub, kind: Kind.Post}; // NOT my post
    const unsigned = buildNoteComment('cool', root, root);
    const ev = asEvent(unsigned, thirdParty, 'h'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0);
  });

  it('privacy invariant: never carries a resolved name even when hideNamesOnLockscreen is off', async () => {
    setSessionFloor(nowSec() - 900);
    await savePrefs({...DEFAULT_PREFS, hideNamesOnLockscreen: false});
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'i'.repeat(64), pubkey: myPubkey, kind: Kind.Post};
    const unsigned = buildNoteComment('hi', root, root);
    const ev = asEvent(unsigned, otherPub, 'j'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});

    expect(fired).toHaveLength(1);
    // Even with names NOT hidden by pref, headless never resolves a profile (no phonebook in the
    // background JS context) — notifyComment is always called with '', so the composer's own
    // isNameHidden/anonymized-title fallback ("Someone replied") is what actually renders.
    expect(fired[0]!.title).toBe('Someone replied');
  });

  it('gates a kind-1111 reply on the resolved article postType (prefs.postTypes.article=false suppresses it)', async () => {
    setSessionFloor(nowSec() - 900);
    await savePrefs({...DEFAULT_PREFS, postTypes: {...DEFAULT_PREFS.postTypes, article: false}});
    const myPubkey = getPublicKey(generateSecretKey());
    const otherPub = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'k'.repeat(64), pubkey: myPubkey, kind: Kind.Article};
    const unsigned = buildComment('nice', root, root);
    const ev = asEvent(unsigned, otherPub, 'l'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0); // 'K' tag → resolved postType 'article' → gated off by prefs
  });
});

/**
 * Widened "is this for me" gate (P1.3), headless path: a reply to MY COMMENT — even inside someone
 * ELSE's thread — must notify, not just a reply to my own thread ROOT. Mirrors the in-app coverage in
 * AppRuntime.commentNotifications.test.ts, but exercised through the real headless composer + prefs
 * gate (not a spy), since that's the only way to observe `replies: false` actually suppressing delivery
 * here (notifyComment itself, not deriveHeadlessNotifications, owns the isPushAllowed check).
 */
describe('deriveHeadlessNotifications — comments: reply-to-my-comment (root OR parent author === me)', () => {
  const asEvent = (
    unsigned: {kind: number; created_at: number; tags: string[][]; content: string},
    authorPubkey: string,
    id: string,
  ): Event => ({...unsigned, id, pubkey: authorPubkey, sig: '0'.repeat(128)}) as Event;

  afterEach(async () => {
    await savePrefs(DEFAULT_PREFS);
  });

  it('hybrid: fires notifyComment for a reply to my comment on SOMEONE ELSE\'s post', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const postAuthor = getPublicKey(generateSecretKey());
    const replier = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'm'.repeat(64), pubkey: postAuthor, kind: Kind.Post}; // NOT my post
    const myComment: EventRef = {id: 'n'.repeat(64), pubkey: myPubkey, kind: Kind.Post}; // MY comment on it

    const unsigned = buildNoteComment('replying to you', root, myComment);
    const ev = asEvent(unsigned, replier, 'o'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      title: 'Someone replied',
      channelId: 'comment',
      target: {kind: 'post', rootId: root.id}, // still routes to the thread root, not the comment
    });
  });

  it('kind-1111: fires notifyComment for a reply to my comment on someone else\'s article', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const articleAuthor = getPublicKey(generateSecretKey());
    const replier = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'p'.repeat(64), pubkey: articleAuthor, kind: Kind.Article};
    const myComment: EventRef = {id: 'q'.repeat(64), pubkey: myPubkey, kind: Kind.Comment};

    const unsigned = buildComment('agreed', root, myComment);
    const ev = asEvent(unsigned, replier, 'r'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(1);
  });

  it('fires EXACTLY ONCE (not twice) for a reply to my comment on MY OWN post (root===me AND parent===me)', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const replier = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 's'.repeat(64), pubkey: myPubkey, kind: Kind.Post}; // my own post
    const myComment: EventRef = {id: 't'.repeat(64), pubkey: myPubkey, kind: Kind.Post}; // my own comment on it

    const unsigned = buildNoteComment('replying to your comment', root, myComment);
    const ev = asEvent(unsigned, replier, 'u'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(1); // one event in ⇒ at most one notifyComment call, never two
  });

  it('does not notify when I reply to my own comment (self-reply, even though I am the parent author)', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const postAuthor = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'v'.repeat(64), pubkey: postAuthor, kind: Kind.Post};
    const myComment: EventRef = {id: 'w'.repeat(64), pubkey: myPubkey, kind: Kind.Post};

    const unsigned = buildNoteComment('adding to my own comment', root, myComment);
    const ev = asEvent(unsigned, myPubkey, 'x'.repeat(64)); // authored by ME

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0);
  });

  it('does not notify for a reply to someone ELSE\'s comment on someone ELSE\'s post, not involving me', async () => {
    setSessionFloor(nowSec() - 900);
    const myPubkey = getPublicKey(generateSecretKey());
    const postAuthor = getPublicKey(generateSecretKey());
    const commentAuthor = getPublicKey(generateSecretKey());
    const thirdParty = getPublicKey(generateSecretKey());
    const root: EventRef = {id: 'y'.repeat(64), pubkey: postAuthor, kind: Kind.Post};
    const someonesComment: EventRef = {id: 'z'.repeat(64), pubkey: commentAuthor, kind: Kind.Post};

    const unsigned = buildNoteComment('agreed', root, someonesComment);
    const ev = asEvent(unsigned, thirdParty, '1'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0);
  });

  it('the `replies` pref set to false suppresses a reply-to-my-comment push too', async () => {
    setSessionFloor(nowSec() - 900);
    await savePrefs({...DEFAULT_PREFS, replies: false});
    const myPubkey = getPublicKey(generateSecretKey());
    const postAuthor = getPublicKey(generateSecretKey());
    const replier = getPublicKey(generateSecretKey());
    const root: EventRef = {id: '2'.repeat(64), pubkey: postAuthor, kind: Kind.Post};
    const myComment: EventRef = {id: '3'.repeat(64), pubkey: myPubkey, kind: Kind.Post};

    const unsigned = buildNoteComment('replying to you', root, myComment);
    const ev = asEvent(unsigned, replier, '4'.repeat(64));

    await deriveHeadlessNotifications({events: [ev], mySk: null, myPubkey, followedGroupIds: new Set()});
    expect(fired).toHaveLength(0); // notifyComment's own isPushAllowed check suppresses it
  });
});

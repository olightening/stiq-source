// E2E encryption for PRIVATE NIP-29 groups, exercised through the real AppRuntime.
//
// Security-critical proofs:
//  - A private group's outgoing message reaches the relay as CIPHERTEXT (incl. the author name).
//  - The keyed creator decrypts its own messages on read.
//  - A joiner who received the key via the invite fragment decrypts; a runtime WITHOUT the key sees
//    the space minus the encrypted message (never ciphertext, never a crash).
//  - Removing a member ROTATES the key (epoch+1) and delivers it only to remaining members.
//  - Public + broadcast groups stay plaintext (byte-identical).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind, messageEpoch} from '../channels/groups';
import {Kind} from '../nostr/events';
import {decodeNameHeader, decodeGradientHeader} from '../profile/displayName';
import {parseInviteLink} from '../channels/invite';
import {parseInvitePayload} from '../channels/membership';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

interface Harness {
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
}

async function enrolledRuntime(): Promise<Harness> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    subscribeGroup: () => {},
    unsubscribeGroup: () => {},
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published};
}

function lastOfKind(published: Event[], kind: number): Event | undefined {
  return [...published].reverse().find(e => e.kind === kind);
}

/**
 * Seed the relay-generated 39000 metadata + 39001 admins + 39002 member list so a group reads as
 * private. The first member is treated as the owner+admin (mirrors the relay making the creator
 * owner+admin) unless `owner` is given — this matters because the 30079 sender-auth check requires
 * the delivery's sender to be the owner or an admin per this signed state.
 */
function seedPrivateGroup(
  store: InMemoryEventStore,
  groupId: string,
  members: string[],
  owner: string = members[0]!,
  admins: string[] = [owner],
): void {
  const state = (kind: number, tags: string[][]): Event =>
    ({
      id: Math.random().toString(36).slice(2) + '0'.repeat(40),
      pubkey: 'relay',
      created_at: 1000,
      kind,
      tags,
      content: '',
      sig: '',
    } as Event);
  store.save(
    state(GroupKind.Metadata, [
      ['d', groupId],
      ['name', 'Secret'],
      ['owner', owner],
      ['private'],
      ['closed'],
    ]),
  );
  store.save(state(GroupKind.Admins, [['d', groupId], ...admins.map(a => ['p', a])]));
  store.save(state(GroupKind.Members, [['d', groupId], ...members.map(m => ['p', m])]));
}

/** Capture the exact invite DM `inviteToGroup` produces (fallback text + SOH-i frame wire) by
 *  intercepting the outgoing DM layer — the membership-handoff replacement for the old
 *  `stiq://channel/` link capture. */
async function captureInviteDm(
  runtime: AppRuntime,
  groupId: string,
): Promise<{text: string; wire: string}> {
  let captured: {text: string; wire: string} | null = null;
  const rt = runtime as unknown as {
    sendDM: (pk: string, text: string, replyTo?: string, wire?: string) => Promise<void>;
  };
  const original = rt.sendDM.bind(rt);
  rt.sendDM = async (_pk: string, text: string, _replyTo?: string, wire?: string) => {
    captured = {text, wire: wire ?? ''};
  };
  try {
    await runtime.inviteToGroup(groupId, 'd'.repeat(64));
  } finally {
    rt.sendDM = original;
  }
  if (!captured) throw new Error('failed to capture invite DM');
  return captured;
}

describe('AppRuntime E2E: private group encryption', () => {
  it('a private group message reaches the relay as ciphertext and decrypts on read', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(store, groupId, [me]);

    await runtime.postToGroup(groupId, 'launch codes are 0000');

    // What the relay actually receives:
    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(chat.content).not.toContain('launch codes'); // plaintext must NOT be on the wire
    expect(chat.content).not.toContain('Alice'); // author name is encrypted too
    expect(chat.tags).toContainEqual(['encrypted', 'nip44']);
    expect(chat.tags).toContainEqual(['ke', '0']);
    expect(messageEpoch(chat)).toBe(0);

    // The optimistic event is in the store; open the space (hydrates keys) and read decrypts it.
    runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0)); // let hydrateSpaceKeys resolve
    const mine = runtime.getGroupMessages(groupId).find(m => m.id === chat.id)!;
    expect(mine).toBeDefined();
    expect(decodeNameHeader(mine.content).text).toBe('launch codes are 0000');
    expect(decodeNameHeader(mine.content).name).toBe('Alice');
  });

  it('a private group REPLY (kind 12) is ciphertext on the wire and decrypts on read', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(store, groupId, [me]);

    // A parent message, then a threaded (kind-12) reply to it.
    await runtime.postToGroup(groupId, 'parent message');
    const parent = lastOfKind(published, GroupKind.Chat)!;
    await runtime.replyToGroupMessage(groupId, parent.id, 'the secret reply');

    // What the relay receives: the kind-12 reply is sealed like a chat message, not plaintext.
    const reply = lastOfKind(published, GroupKind.Reply)!;
    expect(reply.content).not.toContain('the secret reply'); // plaintext must NOT be on the wire
    expect(reply.content).not.toContain('Alice'); // author name is encrypted too
    expect(reply.tags).toContainEqual(['encrypted', 'nip44']);
    expect(messageEpoch(reply)).toBe(0);

    // On read, getGroupReplies decrypts it under its parent (previously it rendered as ciphertext).
    runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0)); // let hydrateSpaceKeys resolve
    const underParent = runtime.getGroupReplies(groupId).get(parent.id)!;
    expect(underParent).toHaveLength(1);
    expect(decodeNameHeader(underParent[0]!.content).text).toBe('the secret reply');
    expect(decodeNameHeader(underParent[0]!.content).name).toBe('Alice');
  });

  it('a private group reply is HIDDEN (not ciphertext) for a member without the key', async () => {
    const author = await enrolledRuntime();
    const groupId = (await author.runtime.createGroup({name: 'Secret', private: true}))!;
    const authorPk = author.runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(author.store, groupId, [authorPk]);
    await author.runtime.postToGroup(groupId, 'parent');
    const parent = lastOfKind(author.published, GroupKind.Chat)!;
    await author.runtime.replyToGroupMessage(groupId, parent.id, 'secret reply');
    const encReply = lastOfKind(author.published, GroupKind.Reply)!;

    // A different runtime that never received the key; inject the same state + the sealed reply.
    const outsider = await enrolledRuntime();
    seedPrivateGroup(outsider.store, groupId, [authorPk]);
    outsider.store.save(parent);
    outsider.store.save(encReply);
    outsider.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0));

    // No key → the reply is hidden entirely (bucket empty/absent), never rendered as ciphertext.
    const bucket = outsider.runtime.getGroupReplies(groupId).get(parent.id);
    expect(bucket === undefined || bucket.length === 0).toBe(true);
  });

  it('a runtime WITHOUT the key sees the space minus the encrypted message (no crash, no ciphertext)', async () => {
    const author = await enrolledRuntime();
    await author.runtime.setMyDisplayName('Alice');
    const groupId = (await author.runtime.createGroup({name: 'Secret', private: true}))!;
    const authorPk = author.runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(author.store, groupId, [authorPk]);
    await author.runtime.postToGroup(groupId, 'top secret');
    const encryptedChat = lastOfKind(author.published, GroupKind.Chat)!;

    // A different runtime that never received the key; inject the same state + the encrypted message.
    const outsider = await enrolledRuntime();
    seedPrivateGroup(outsider.store, groupId, [authorPk]);
    outsider.store.save(encryptedChat);
    outsider.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0));

    const msgs = outsider.runtime.getGroupMessages(groupId);
    expect(msgs.find(m => m.id === encryptedChat.id)).toBeUndefined(); // hidden, not ciphertext
    for (const m of msgs) expect(m.content).not.toBe(encryptedChat.content);
  });

  it('the invite link is navigate-only (no key fragment) — a joiner decrypts only once approved', async () => {
    const author = await enrolledRuntime();
    const groupId = (await author.runtime.createGroup({name: 'Secret', private: true}))!;
    const authorPk = author.runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(author.store, groupId, [authorPk]);
    await author.runtime.postToGroup(groupId, 'members only');
    const encryptedChat = lastOfKind(author.published, GroupKind.Chat)!;

    // The invite DM the author sends is navigate-only: the space embed + invite frame carry
    // render data (id/name/kind/count) and NEVER a key fragment or decryption material.
    const invite = await captureInviteDm(author.runtime, groupId);
    expect(invite.text).toContain('stiq:space:');
    expect(invite.text).not.toContain('#k=');
    const frame = parseInvitePayload(invite.wire)!;
    expect(frame.g).toBe(groupId);
    expect(JSON.stringify(frame)).not.toContain('key');
    // The legacy deep link (still accepted from old DMs) is equally keyless.
    expect(parseInviteLink(`stiq://channel/${groupId}`)!.key).toBeUndefined();

    // A fresh joiner accepts the invite — accepting alone must NOT hand them a key.
    const joiner = await enrolledRuntime();
    seedPrivateGroup(joiner.store, groupId, [authorPk]);
    joiner.store.save(encryptedChat);
    const joinerPk = joiner.runtime.getSnapshot().currentUserPubkey!;
    await joiner.runtime.acceptSpaceInvite(groupId);
    joiner.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0));

    // Without the admin's approval delivering the key (kind-30079), the pre-existing message stays
    // undecryptable to the joiner.
    let got = joiner.runtime.getGroupMessages(groupId).find(m => m.id === encryptedChat.id);
    expect(got).toBeUndefined();

    // Once the admin approves the join, `approveJoin` -> `addGroupMember` delivers the current-epoch
    // key via kind-30079 (unchanged path — see the FIX 5 tests below), and the joiner can decrypt.
    await author.runtime.approveJoin(groupId, joinerPk);
    const delivery = lastOfKind(author.published, Kind.SpaceKeyDelivery)!;
    joiner.store.save(delivery);
    joiner.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0));

    got = joiner.runtime.getGroupMessages(groupId).find(m => m.id === encryptedChat.id);
    expect(got).toBeDefined();
    expect(decodeNameHeader(got!.content).text).toBe('members only');
  });

  it('removing a member rotates the key (epoch+1) and delivers it only to remaining members', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    // Real curve pubkeys — wrapKeyForMember derives an ECDH conversation key, which requires a
    // valid x-only pubkey (a synthetic 'bbbb…' is not a point on secp256k1).
    const bob = getPublicKey(generateSecretKey());
    const carol = getPublicKey(generateSecretKey());
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    seedPrivateGroup(store, groupId, [me, bob, carol]);

    await runtime.kickGroupMember(groupId, bob);

    const removal = lastOfKind(published, GroupKind.RemoveUser)!;
    expect(removal.tags).toContainEqual(['p', bob]);

    const deliveries = published.filter(e => e.kind === Kind.SpaceKeyDelivery);
    expect(deliveries.length).toBe(1); // only carol (self is skipped — we store our own copy)
    const delivery = deliveries[0]!;
    expect(delivery.tags).toContainEqual(['p', carol]);
    expect(delivery.tags).toContainEqual(['h', groupId]);
    expect(delivery.tags).toContainEqual(['ke', '1']); // epoch advanced 0 → 1
    expect(deliveries.some(d => d.tags.some(t => t[0] === 'p' && t[1] === bob))).toBe(false);

    // New messages now use the rotated epoch (1).
    published.length = 0;
    await runtime.postToGroup(groupId, 'after the kick');
    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(chat.tags).toContainEqual(['ke', '1']);
    expect(messageEpoch(chat)).toBe(1);
    expect(chat.content).not.toContain('after the kick');
  });

  it('a remaining member ingests a rotated-key delivery and can then decrypt new-epoch messages', async () => {
    // Organizer side: a private group; the organizer rotates after a kick and the delivery is
    // addressed to the (real) member runtime.
    const org = await enrolledRuntime();
    const orgPk = org.runtime.getSnapshot().currentUserPubkey!;
    const member = await enrolledRuntime();
    const memberPk = member.runtime.getSnapshot().currentUserPubkey!;
    const kicked = getPublicKey(generateSecretKey());

    const groupId = (await org.runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    seedPrivateGroup(org.store, groupId, [orgPk, memberPk, kicked]);
    seedPrivateGroup(member.store, groupId, [orgPk, memberPk, kicked]);

    // Organizer kicks → rotates to epoch 1 → one delivery addressed to the member.
    await org.runtime.kickGroupMember(groupId, kicked);
    const delivery = lastOfKind(org.published, Kind.SpaceKeyDelivery)!;
    expect(delivery).toBeDefined();

    // The member RECEIVES the delivery (handleIncomingEvent): unwrap with their sk + store epoch-1.
    member.store.save(delivery);
    member.runtime.handleIncomingEvent(delivery);
    await new Promise(r => setTimeout(r, 10)); // let the async unwrap+store settle

    // The organizer now posts a new-epoch (1) message; the member decrypts it via the delivered key.
    await org.runtime.postToGroup(groupId, 'post-rotation secret');
    const newChat = lastOfKind(org.published, GroupKind.Chat)!;
    expect(newChat.tags).toContainEqual(['ke', '1']);

    member.store.save(newChat);
    member.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 10));
    const got = member.runtime.getGroupMessages(groupId).find(m => m.id === newChat.id);
    expect(got).toBeDefined();
    expect(decodeNameHeader(got!.content).text).toBe('post-rotation secret');
  });

  it('FAIL-CLOSED: a member without the key cannot post plaintext to a private group', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    // A private group whose key this runtime never obtained (state seeded, but no key cached).
    const groupId = 'no-key-group-' + Math.random().toString(36).slice(2);
    seedPrivateGroup(store, groupId, [me]);
    runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0));

    const before = published.length;
    // Each of the three write paths THROWS SPACE_KEY_UNAVAILABLE (a visible failure the composer
    // reacts to) rather than a silent no-op.
    await expect(runtime.postToGroup(groupId, 'should never leak')).rejects.toThrow('SPACE_KEY_UNAVAILABLE');
    await expect(runtime.editGroupMessage(groupId, 'x'.repeat(64), 'should never leak')).rejects.toThrow('SPACE_KEY_UNAVAILABLE');
    await expect(runtime.replyToGroupMessage(groupId, 'y'.repeat(64), 'should never leak')).rejects.toThrow('SPACE_KEY_UNAVAILABLE');

    // NOTHING was published — the private-space-with-no-key send is blocked, never plaintext.
    expect(published.length).toBe(before);
    expect(published.some(e => e.content.includes('should never leak'))).toBe(false);
  });

  it('PUBLIC groups (incl. a public broadcast) stay PLAINTEXT; a private CHANNEL is ENCRYPTED', async () => {
    const {runtime, store, published} = await enrolledRuntime();

    // Public group (private:false) → plaintext.
    const pub = (await runtime.createGroup({name: 'Open'}))!;
    store.save({
      id: 'pubmeta' + '0'.repeat(50), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', pub], ['name', 'Open'], ['public']], content: '', sig: '',
    } as Event);
    await runtime.postToGroup(pub, 'hello everyone');
    const pubChat = lastOfKind(published, GroupKind.Chat)!;
    // No NAME header (nameless), but enrollment without a chosen gradient auto-claims one (#9),
    // so a gradient header rides the body regardless; decodeNameHeader strips BOTH (parseHeaders).
    expect(decodeNameHeader(pubChat.content).name).toBeUndefined();
    expect(decodeGradientHeader(pubChat.content)).toBeDefined();
    expect(decodeNameHeader(pubChat.content).text).toBe('hello everyone');
    expect(pubChat.tags.some(t => t[0] === 'encrypted')).toBe(false);

    // PUBLIC broadcast (private:false, broadcast:true) → still plaintext (public reach by design).
    const pbc = (await runtime.createGroup({name: 'Megaphone', broadcast: true}))!;
    store.save({
      id: 'pbcmeta' + '0'.repeat(49), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', pbc], ['name', 'Megaphone'], ['public'], ['broadcast']], content: '', sig: '',
    } as Event);
    await runtime.postToGroup(pbc, 'to the world');
    const pbcChat = lastOfKind(published, GroupKind.Chat)!;
    expect(decodeNameHeader(pbcChat.content).text).toBe('to the world');
    expect(pbcChat.tags.some(t => t[0] === 'encrypted')).toBe(false);

    // PRIVATE channel (private + broadcast: members read, admins write) → E2E-ENCRYPTED, NOT plaintext.
    // This is the leak the audit closed: a private+broadcast space was previously sent in the clear.
    const priv = (await runtime.createGroup({name: 'Loud', private: true, broadcast: true}))!;
    store.save({
      id: 'privmeta' + '0'.repeat(48), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', priv], ['name', 'Loud'], ['private'], ['broadcast']], content: '', sig: '',
    } as Event);
    await runtime.postToGroup(priv, 'members of the channel only');
    const privChat = lastOfKind(published, GroupKind.Chat)!;
    expect(privChat.content).not.toContain('members of the channel only'); // sealed
    expect(privChat.tags).toContainEqual(['encrypted', 'nip44']);
  });

  it('FAIL-CLOSED: a member without the key cannot post plaintext to a private CHANNEL', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    // A private channel (private + broadcast) whose key this runtime never obtained — seed only 39000.
    const gid = 'privchan' + '0'.repeat(48);
    store.save({
      id: 'pcmeta' + '0'.repeat(50), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', gid], ['name', 'Secret channel'], ['private'], ['broadcast']], content: '', sig: '',
    } as Event);
    const before = published.length;
    // The private-channel-with-no-key send THROWS (a visible failure the composer can react to —
    // see App.tsx's runWrite + GroupView's sendText draft-restore) rather than a silent no-op.
    await expect(runtime.postToGroup(gid, 'should never leak')).rejects.toThrow('SPACE_KEY_UNAVAILABLE');
    // Nothing was ever plaintext (same guard as a private group) — still BLOCKED, never leaked.
    expect(published.length).toBe(before);
    expect(published.some(e => e.content.includes('should never leak'))).toBe(false);
  });

  it('PROMOTES a private-space post (author choice) and RE-SEALS the in-place edit', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    // A private channel we own (key minted at create → treated as encrypted).
    const gid = (await runtime.createGroup({name: 'Inner', private: true, broadcast: true}))!;
    store.save({
      id: 'innermeta' + '0'.repeat(47), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', gid], ['name', 'Inner'], ['private'], ['broadcast']], content: '', sig: '',
    } as Event);
    await runtime.postToGroup(gid, 'internal announcement');
    const source = lastOfKind(published, GroupKind.Chat)!;
    // "Turn on replies" in a private channel: the AUTHOR deliberately publishes their own words
    // to the public feed — same mechanism as a public channel (user directive). The public post
    // goes out; the in-place edit stays SEALED under the space key (never a plaintext write into
    // an E2E space) and carries the promoted marker.
    await runtime.promoteChannelPost(source, 'internal announcement');
    const feedPost = lastOfKind(published, 1)!;
    expect(feedPost).toBeDefined();
    expect(feedPost.content).toContain('internal announcement'); // public by author choice
    const edit = [...published].reverse().find(
      e => e.kind === GroupKind.Chat && e.tags.some(t => t[0] === 'promoted'),
    )!;
    expect(edit).toBeDefined();
    expect(edit.tags).toContainEqual(['promoted', feedPost.id]);
    expect(edit.content).not.toContain('internal announcement'); // edit-back re-sealed
    expect(edit.tags).toContainEqual(['encrypted', 'nip44']);
  });

  it('FAIL-CLOSED: promoting from a KEYLESS private space throws before anything publishes', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    // A private space we're in but hold NO key for (grant-admit window / lost key).
    const gid = 'keylesspromote' + '0'.repeat(42);
    store.save({
      id: 'kpmeta' + '0'.repeat(50), pubkey: 'relay', created_at: 1, kind: GroupKind.Metadata,
      tags: [['d', gid], ['name', 'Locked'], ['private'], ['broadcast']], content: '', sig: '',
    } as Event);
    const source = {
      id: 'srcmsg' + '0'.repeat(50), pubkey: runtime.getSnapshot().currentUserPubkey!,
      created_at: 2, kind: GroupKind.Chat, tags: [['h', gid]], content: 'x', sig: 's',
    } as Event;
    const before = published.length;
    await expect(runtime.promoteChannelPost(source, 'x')).rejects.toThrow(/unlocking/);
    expect(published.length).toBe(before); // fail-closed BEFORE the public post went out
  });
});

describe('AppRuntime E2E hardening: relay-independent privacy + sender-auth', () => {
  // FIX 1: outgoingSeal must ENCRYPT whenever a key is cached, even with NO relay 39000 seeded
  // (the create→send race) — the creator must never plaintext-send in that window.
  it('FIX 1: encrypts in the create→send window (no 39000 seeded) — content is ciphertext, not the name', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    // Create a private group but DO NOT seed any relay state → isPrivateSpace would be false.
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;

    await runtime.postToGroup(groupId, 'launch codes are 0000');

    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(chat).toBeDefined();
    expect(chat.content).not.toContain('launch codes'); // plaintext must NOT be on the wire
    expect(chat.content).not.toContain('Alice'); // author name encrypted too
    expect(chat.tags).toContainEqual(['encrypted', 'nip44']);
    expect(messageEpoch(chat)).toBe(0);
  });

  // FIX 1: even if the relay reports the space as PUBLIC (private flag stripped), a cached key forces
  // encryption — a malicious relay can't coerce a plaintext send.
  it('FIX 1: encrypts when the relay 39000 says PUBLIC but a key is cached (downgrade attempt)', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    // Hostile relay: 39000 advertises the group as PUBLIC (no private flag).
    store.save({
      id: 'pubmeta' + '0'.repeat(50),
      pubkey: 'relay',
      created_at: 2000,
      kind: GroupKind.Metadata,
      tags: [['d', groupId], ['name', 'Secret'], ['public']],
      content: '',
      sig: '',
    } as Event);
    expect(runtime.getGroupState(groupId)?.private).toBeFalsy(); // relay says public

    await runtime.postToGroup(groupId, 'still a secret');

    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(chat.content).not.toContain('still a secret'); // encrypted despite the relay's claim
    expect(chat.tags).toContainEqual(['encrypted', 'nip44']);
  });

  // FIX 2: a 30079 delivery from a NON-owner/non-admin pubkey is rejected (key not stored, epoch not
  // advanced); a delivery from the owner IS accepted.
  it('FIX 2: rejects a 30079 from a non-admin pubkey; accepts one from the owner', async () => {
    // Victim runtime is a member of a private group; the owner is a separate real key.
    const victim = await enrolledRuntime();
    const victimPk = victim.runtime.getSnapshot().currentUserPubkey!;
    const ownerSk = generateSecretKey();
    const ownerPk = getPublicKey(ownerSk);
    const attackerSk = generateSecretKey();
    const groupId = 'auth-test-' + Math.random().toString(36).slice(2);
    // Seed state: owner = ownerPk, admins = [ownerPk]. Attacker is NOT owner/admin.
    seedPrivateGroup(victim.store, groupId, [ownerPk, victimPk], ownerPk, [ownerPk]);

    // Helper to build a REAL signed 30079 from an arbitrary sender to the victim for (groupId, epoch).
    const { buildKeyDelivery } = require('../channels/groupCrypto');
    const { finalizeEvent } = require('nostr-tools/pure');
    const makeDelivery = (senderSk: Uint8Array, epoch: number): Event => {
      const key = generateSecretKey(); // 32 random bytes = a space key
      const unsigned = buildKeyDelivery(groupId, epoch, key, senderSk, victimPk);
      return finalizeEvent(unsigned, senderSk) as Event;
    };

    // ── Attacker (not owner/admin) delivers epoch 0 → MUST be rejected.
    const attackerDelivery = makeDelivery(attackerSk, 0);
    victim.store.save(attackerDelivery);
    victim.runtime.handleIncomingEvent(attackerDelivery);
    await new Promise(r => setTimeout(r, 10));
    // No key stored: opening the space + trying to post must BLOCK (fail-closed), not encrypt-and-send.
    victim.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 10));
    const beforeAttackerPost = victim.published.length;
    await expect(victim.runtime.postToGroup(groupId, 'should be blocked')).rejects.toThrow('SPACE_KEY_UNAVAILABLE');
    expect(victim.published.length).toBe(beforeAttackerPost); // blocked — no key from the attacker

    // ── Owner delivers epoch 0 → MUST be accepted; the victim can now encrypt+post.
    const ownerDelivery = makeDelivery(ownerSk, 0);
    victim.store.save(ownerDelivery);
    victim.runtime.handleIncomingEvent(ownerDelivery);
    await new Promise(r => setTimeout(r, 10));
    const beforeOwnerPost = victim.published.length;
    await victim.runtime.postToGroup(groupId, 'now i can post');
    expect(victim.published.length).toBe(beforeOwnerPost + 1); // accepted — owner's key was stored
    const chat = lastOfKind(victim.published, GroupKind.Chat)!;
    expect(chat.content).not.toContain('now i can post'); // and it's encrypted
    expect(chat.tags).toContainEqual(['encrypted', 'nip44']);
    expect(messageEpoch(chat)).toBe(0);
  });

  // FIX 3: a private-space kind-9 whose `encrypted` tag was STRIPPED must render NOTHING (not the raw
  // content as plaintext).
  it('FIX 3: hides a private-space message whose encrypted tag was stripped', async () => {
    const author = await enrolledRuntime();
    await author.runtime.setMyDisplayName('Alice');
    const groupId = (await author.runtime.createGroup({name: 'Secret', private: true}))!;
    const authorPk = author.runtime.getSnapshot().currentUserPubkey!;
    seedPrivateGroup(author.store, groupId, [authorPk]);
    await author.runtime.postToGroup(groupId, 'real secret');
    const encryptedChat = lastOfKind(author.published, GroupKind.Chat)!;

    // A hostile relay strips the encrypted/ke tags, leaving the ciphertext as if it were plaintext.
    const stripped: Event = {
      ...encryptedChat,
      id: 'stripped' + '0'.repeat(48),
      tags: encryptedChat.tags.filter(t => t[0] !== 'encrypted' && t[0] !== 'ke'),
    };
    expect(messageEpoch(stripped)).toBeNull(); // tag gone

    author.store.save(stripped);
    author.runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 10));

    const msgs = author.runtime.getGroupMessages(groupId);
    expect(msgs.find(m => m.id === stripped.id)).toBeUndefined(); // hidden, not rendered as text
    for (const m of msgs) expect(m.content).not.toBe(stripped.content); // no ciphertext leaked
  });

  // FIX 5: adding a member to a private group delivers the CURRENT-epoch key to them (a 30079).
  it('FIX 5: addGroupMember on a private space delivers the current key to the new member', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const newMember = getPublicKey(generateSecretKey());
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    seedPrivateGroup(store, groupId, [me]);

    published.length = 0;
    await runtime.addGroupMember(groupId, newMember);

    const deliveries = published.filter(e => e.kind === Kind.SpaceKeyDelivery);
    expect(deliveries.length).toBe(1);
    const d = deliveries[0]!;
    expect(d.tags).toContainEqual(['p', newMember]);
    expect(d.tags).toContainEqual(['h', groupId]);
    expect(d.tags).toContainEqual(['ke', '0']); // current epoch
  });

  // FIX 5: approveJoin (which routes through addGroupMember) likewise keys the new member.
  it('FIX 5: approveJoin on a private space delivers the current key to the approved member', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const joiner = getPublicKey(generateSecretKey());
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    seedPrivateGroup(store, groupId, [me]);

    published.length = 0;
    await runtime.approveJoin(groupId, joiner);

    const deliveries = published.filter(e => e.kind === Kind.SpaceKeyDelivery);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.tags).toContainEqual(['p', joiner]);
    expect(deliveries[0]!.tags).toContainEqual(['ke', '0']);
  });

  // FIX 5: denyJoin must NOT rotate the key (no new epoch, no key delivery) — the denied user never
  // had the key.
  it('FIX 5: denyJoin does NOT rotate the key (no delivery, no epoch advance)', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const other = getPublicKey(generateSecretKey());
    const denied = getPublicKey(generateSecretKey());
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    seedPrivateGroup(store, groupId, [me, other]);

    published.length = 0;
    await runtime.denyJoin(groupId, denied);

    // A 9001 remove was published (clears the pending entry) but NO key delivery (no rotation).
    expect(published.some(e => e.kind === GroupKind.RemoveUser)).toBe(true);
    expect(published.some(e => e.kind === Kind.SpaceKeyDelivery)).toBe(false);

    // The outgoing epoch is unchanged (still 0): a post still uses ke=0.
    await runtime.postToGroup(groupId, 'unchanged epoch');
    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(messageEpoch(chat)).toBe(0);
  });
});

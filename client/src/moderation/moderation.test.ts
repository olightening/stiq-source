import {generateSecretKey, getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {isModerator, moderatorPubkeySet} from './moderators';
import {
  buildRemoveReport,
  contentSnapshotOf,
  removePost,
  reportedPostId,
  CONTENT_SNAPSHOT_MAX,
} from './report';
import type {Event} from 'nostr-tools/pure';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';

describe('moderators', () => {
  it('recognizes a hardcoded moderator by pubkey', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const npub = nip19.npubEncode(pk);

    expect(isModerator(pk, [npub])).toBe(true);
    expect(moderatorPubkeySet([npub]).has(pk)).toBe(true);

    const other = getPublicKey(generateSecretKey());
    expect(isModerator(other, [npub])).toBe(false);
  });

  it('ignores malformed npubs', () => {
    expect(moderatorPubkeySet(['not-an-npub']).size).toBe(0);
  });
});

describe('removal report (NIP-56 / kind 1984)', () => {
  it('builds a report referencing the offending post', () => {
    const report = buildRemoveReport('post123', {reportType: 'spam', reason: 'spam'});
    expect(report.kind).toBe(1984);
    expect(report.tags).toContainEqual(['e', 'post123', 'spam']);
    expect(report.content).toBe('spam');
  });

  it('includes the author pubkey when given', () => {
    const report = buildRemoveReport('post123', {authorPubkey: 'authorhex'});
    expect(report.tags).toContainEqual(['p', 'authorhex']);
  });

  it('embeds and reads back a bounded content snapshot', () => {
    const report = buildRemoveReport('post123', {contentSnapshot: '  the removed body  '});
    expect(report.tags).toContainEqual(['content-snapshot', 'the removed body']);
    expect(contentSnapshotOf(report as Event)).toBe('the removed body');
  });

  it('caps the snapshot length and omits the tag when empty', () => {
    const long = 'x'.repeat(CONTENT_SNAPSHOT_MAX + 50);
    const report = buildRemoveReport('post123', {contentSnapshot: long});
    expect(contentSnapshotOf(report as Event)).toHaveLength(CONTENT_SNAPSHOT_MAX);

    const none = buildRemoveReport('post123', {contentSnapshot: '   '});
    expect(none.tags.some(t => t[0] === 'content-snapshot')).toBe(false);
    expect(contentSnapshotOf(none as Event)).toBeUndefined();
  });

  it('signs a valid moderation event via the keystore', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    const sk = generateSecretKey();
    await store.enroll(sk);

    const event = await removePost(store, 'offendingPostId', {reason: 'off-topic'});

    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(1984);
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(reportedPostId(event)).toBe('offendingPostId');
  });

  it('reportedPostId returns null for a non-report', () => {
    expect(reportedPostId({kind: 1, tags: [], id: 'x'} as never)).toBeNull();
  });
});

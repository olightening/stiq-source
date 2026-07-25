import {InMemorySecureStorage} from '../keys/keystore';
import {saveDrawMarker, loadDrawMarker, clearDrawMarker, STALE_DRAW_MARKER_MS} from './drawStaging';
import type {DrawMarker} from './drawExchange';
import type {Event} from 'nostr-tools/pure';

function fakeRequestEvent(id: string): Event {
  return {
    id,
    pubkey: 'a'.repeat(64),
    created_at: 0,
    kind: 9024,
    tags: [],
    content: 'cipher',
    sig: 'b'.repeat(128),
  };
}

function marker(overrides: Partial<DrawMarker> = {}): DrawMarker {
  return {
    schemaV: 1,
    credId: 'cred-1',
    epoch: 5,
    purpose: 'post',
    reqHash: 'hash-1',
    issuerPublicKey: 'ISSUER',
    organizerPubkey: 'c'.repeat(64),
    requestEvent: fakeRequestEvent('req-1'),
    replyPubkey: 'd'.repeat(64),
    respConvKey: 'Y29udmtleQ==',
    items: [{prepared: 'cA==', blinded: 'Yg==', blindingSecret: 'aQ==', secret: 'cQ=='}],
    // A fresh marker by default — every existing test in this file is exercising storage plumbing
    // (round-trip / clear / namespace / purpose isolation), not staleness, so it must not be treated
    // as abandoned. The staleness cutoff itself gets its own describe block below.
    savedAt: Date.now(),
    ...overrides,
  };
}

describe('drawStaging', () => {
  it('round-trips a marker: save then load returns an equal record', async () => {
    const storage = new InMemorySecureStorage();
    const m = marker();
    await saveDrawMarker(storage, 'slot-1', 'post', m);
    const loaded = await loadDrawMarker(storage, 'slot-1', 'post');
    expect(loaded).toEqual(m);
  });

  it('loads null when no marker was ever staged', async () => {
    const storage = new InMemorySecureStorage();
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
  });

  it('clear removes the marker so a later load sees null', async () => {
    const storage = new InMemorySecureStorage();
    await saveDrawMarker(storage, 'slot-1', 'post', marker());
    await clearDrawMarker(storage, 'slot-1', 'post');
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
  });

  it('a second save overwrites the first (cap-adjustment rebuild semantics)', async () => {
    const storage = new InMemorySecureStorage();
    await saveDrawMarker(storage, 'slot-1', 'post', marker({epoch: 5, reqHash: 'first'}));
    await saveDrawMarker(storage, 'slot-1', 'post', marker({epoch: 5, reqHash: 'second'}));
    const loaded = await loadDrawMarker(storage, 'slot-1', 'post');
    expect(loaded?.reqHash).toBe('second');
  });

  it('isolates markers by namespace (per-account siloing — never leak across slots)', async () => {
    const storage = new InMemorySecureStorage();
    await saveDrawMarker(storage, 'slotA', 'post', marker({credId: 'A'}));
    expect(await loadDrawMarker(storage, 'slotB', 'post')).toBeNull();
    expect((await loadDrawMarker(storage, 'slotA', 'post'))?.credId).toBe('A');
  });

  it('isolates markers by purpose (post / space-write / read draws run independently)', async () => {
    const storage = new InMemorySecureStorage();
    await saveDrawMarker(storage, 'slot-1', 'post', marker({credId: 'POST'}));
    await saveDrawMarker(storage, 'slot-1', 'space-write', marker({credId: 'SPACE'}));
    expect((await loadDrawMarker(storage, 'slot-1', 'post'))?.credId).toBe('POST');
    expect((await loadDrawMarker(storage, 'slot-1', 'space-write'))?.credId).toBe('SPACE');
    // Clearing one purpose's marker must not disturb a sibling purpose's marker under the same slot.
    await clearDrawMarker(storage, 'slot-1', 'post');
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
    expect((await loadDrawMarker(storage, 'slot-1', 'space-write'))?.credId).toBe('SPACE');
  });

  it('treats a corrupt/malformed record as no marker rather than throwing', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem('stiq.wallet.drawMarker.post.slot-1', '{not json');
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
    await storage.setItem('stiq.wallet.drawMarker.post.slot-1', JSON.stringify({credId: 'x'})); // missing fields
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
  });

  it('the default namespace ("") is distinct from a named one', async () => {
    const storage = new InMemorySecureStorage();
    await saveDrawMarker(storage, '', 'post', marker({credId: 'UNNAMESPACED'}));
    expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
    expect((await loadDrawMarker(storage, '', 'post'))?.credId).toBe('UNNAMESPACED');
  });

  // F-F: a permanently-stuck marker (never resumed) must not keep its blinding/token secrets in
  // SecureStorage forever with no TTL. Covers both sides of the cutoff — a genuinely-abandoned
  // marker is purged rather than resumed, and the normal short-lived resume path (a marker that's
  // merely old enough to have outlived one timeout, not days old) is untouched.
  describe('stale marker cutoff (F-F)', () => {
    it('purges a marker older than the cutoff and loads it as null', async () => {
      const storage = new InMemorySecureStorage();
      const stale = Date.now() - (STALE_DRAW_MARKER_MS + 60_000); // just past the cutoff
      await saveDrawMarker(storage, 'slot-1', 'post', marker({credId: 'STALE', savedAt: stale}));

      expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();

      // Purged, not merely hidden — a raw re-read of the underlying storage key must come back empty
      // too, proving the secrets themselves were cleared rather than just filtered on read.
      expect(await storage.getItem('stiq.wallet.drawMarker.post.slot-1')).toBeNull();
    });

    it('does not disturb a sibling purpose/namespace when purging a stale marker', async () => {
      const storage = new InMemorySecureStorage();
      const stale = Date.now() - (STALE_DRAW_MARKER_MS + 60_000);
      await saveDrawMarker(storage, 'slot-1', 'post', marker({credId: 'STALE', savedAt: stale}));
      await saveDrawMarker(storage, 'slot-1', 'space-write', marker({credId: 'FRESH-SIBLING'}));

      expect(await loadDrawMarker(storage, 'slot-1', 'post')).toBeNull();
      expect((await loadDrawMarker(storage, 'slot-1', 'space-write'))?.credId).toBe('FRESH-SIBLING');
    });

    it('still resumes a marker within the cutoff — the normal short-lived timeout-resume path is unaffected', async () => {
      const storage = new InMemorySecureStorage();
      // A marker that has merely outlived one relay-reconnect timeout (minutes old), nowhere near the
      // multi-day abandonment cutoff — this is the routine "process was killed a moment ago" case
      // resumeStagedDraw exists for, and must keep working exactly as before.
      const recent = Date.now() - 5 * 60_000; // 5 minutes old
      await saveDrawMarker(storage, 'slot-1', 'post', marker({credId: 'RESUMABLE', savedAt: recent}));

      const loaded = await loadDrawMarker(storage, 'slot-1', 'post');
      expect(loaded?.credId).toBe('RESUMABLE');
    });

    it('a marker just inside the cutoff is still resumable (not an off-by-a-hair purge)', async () => {
      const storage = new InMemorySecureStorage();
      // A minute short of the cutoff — comfortably inside, but close enough to prove the check isn't
      // wildly more aggressive than documented. (Testing the EXACT boundary would race real-clock
      // progression between save and load, so this stays a minute off it rather than flaking.)
      const justInside = Date.now() - (STALE_DRAW_MARKER_MS - 60_000);
      await saveDrawMarker(storage, 'slot-1', 'post', marker({credId: 'BOUNDARY', savedAt: justInside}));

      expect((await loadDrawMarker(storage, 'slot-1', 'post'))?.credId).toBe('BOUNDARY');
    });
  });
});

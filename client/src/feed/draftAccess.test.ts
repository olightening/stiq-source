/**
 * Draft access control — pure codec/fold contracts (Phase 5§D; see the module doc for the shape).
 * Mirrors channels/membership.test.ts's structure:
 *  • DraftAccessRequest payload codec + a real NIP-44 seal/unseal round-trip;
 *  • draft-access doc + fold semantics (latest grant wins, revoke vs re-grant, unauthorized authors
 *    ignored) — same shape as the `foldInvites` tests, minus the "current members drop off" step
 *    (a draft grant has no membership-completion analogue);
 *  • DraftDelivery snapshot codec + a real NIP-44 seal/decrypt round-trip, including the empty-
 *    plaintext "tombstone" a revoke publishes;
 *  • latestDraftAccessRequests store join (newest request per requester pubkey);
 *  • the local denied-request store (mirrors the local join-request store tests).
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Event} from 'nostr-tools/pure';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {
  encodeDraftAccessPayload,
  parseDraftAccessPayload,
  buildDraftAccessRequestTags,
  latestDraftAccessRequests,
  draftAccessDTag,
  encodeDraftAccessDoc,
  parseDraftAccessDoc,
  foldDraftAccess,
  draftDeliveryDTag,
  buildDraftDeliveryTags,
  encodeDraftDeliverySnapshot,
  parseDraftDeliverySnapshot,
  DRAFT_DELIVERY_TOMBSTONE,
  loadDeniedDraftAccess,
  saveDeniedDraftAccess,
  DRAFT_COMMENT_ROOT_KIND,
  type DraftAccessDoc,
} from './draftAccess';
import {Kind as EventKind} from '../nostr/events';
import {InMemoryEventStore} from '../nostr/store';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

/** Seal `plaintext` to `recipientPubkey` from `senderSk` — exactly the primitive
 *  `Identity.sealForPeer` wraps (getConversationKey + nip44.encrypt). */
function sealFor(senderSk: Uint8Array, recipientPubkey: string, plaintext: string): string {
  return nip44.encrypt(plaintext, nip44.utils.getConversationKey(senderSk, recipientPubkey));
}

/** Decrypt a seal FROM `senderPubkey` using `recipientSk` — mirrors `Identity.openFromPeer`. */
function openFrom(recipientSk: Uint8Array, senderPubkey: string, ciphertext: string): string {
  return nip44.decrypt(ciphertext, nip44.utils.getConversationKey(recipientSk, senderPubkey));
}

// ── 1. DraftAccessRequest payload + seal/unseal round-trip ─────────────────────────────────────

describe('DraftAccessRequest payload codec', () => {
  it('round-trips a name through encode/parse', () => {
    const payload = encodeDraftAccessPayload({n: 'Mara V.'});
    expect(parseDraftAccessPayload(payload)).toEqual({n: 'Mara V.'});
  });

  it('a name-less payload round-trips to an empty object (still v:1 on the wire)', () => {
    const payload = encodeDraftAccessPayload({});
    expect(JSON.parse(payload)).toEqual({v: 1});
    expect(parseDraftAccessPayload(payload)).toEqual({});
  });

  it('clamps an over-long name to MAX_DRAFT_ACCESS_NAME', () => {
    const long = 'x'.repeat(200);
    const payload = encodeDraftAccessPayload({n: long});
    expect(parseDraftAccessPayload(payload)!.n).toHaveLength(80);
  });

  it('parse never throws on garbage and rejects a wrong version', () => {
    expect(parseDraftAccessPayload('not json')).toBeNull();
    expect(parseDraftAccessPayload(JSON.stringify({v: 2, n: 'x'}))).toBeNull();
  });

  it('SEAL/UNSEAL round-trip: the requester seals to the owner; only the owner unseals it', () => {
    const requesterSk = generateSecretKey();
    const ownerSk = generateSecretKey();
    const ownerPk = getPublicKey(ownerSk);
    const requesterPk = getPublicKey(requesterSk);

    const wire = encodeDraftAccessPayload({n: 'Mara V.'});
    const ciphertext = sealFor(requesterSk, ownerPk, wire);
    expect(ciphertext).not.toContain('Mara'); // never rides plaintext

    const opened = openFrom(ownerSk, requesterPk, ciphertext);
    expect(parseDraftAccessPayload(opened)).toEqual({n: 'Mara V.'});

    // A third party (not the owner) cannot open it.
    const eavesdropperSk = generateSecretKey();
    expect(() => openFrom(eavesdropperSk, requesterPk, ciphertext)).toThrow();
  });

  it('buildDraftAccessRequestTags carries the draftId + ownerPubkey', () => {
    expect(buildDraftAccessRequestTags('share1', A)).toEqual([
      ['d', 'share1'],
      ['p', A],
    ]);
  });
});

// ── latestDraftAccessRequests store join ────────────────────────────────────────────────────────

describe('latestDraftAccessRequests', () => {
  const req = (id: string, pk: string, at: number, draftId: string, owner: string): Event => ({
    id,
    pubkey: pk,
    created_at: at,
    kind: EventKind.DraftAccessRequest,
    tags: [
      ['d', draftId],
      ['p', owner],
    ],
    content: 'ct',
    sig: 's',
  });

  it('keeps the newest request per requester pubkey, scoped to (draftId, owner)', () => {
    const store = new InMemoryEventStore();
    store.save(req('r1', C, 10, 'share1', A));
    store.save(req('r2', C, 20, 'share1', A)); // re-request from the same pubkey
    store.save(req('r3', D, 5, 'OTHER', A)); // different draft
    store.save(req('r4', D, 5, 'share1', B)); // different owner
    const latest = latestDraftAccessRequests(store, 'share1', A);
    expect(latest.size).toBe(1);
    expect(latest.get(C)!.id).toBe('r2');
  });
});

// ── 2. draft-access doc + fold ──────────────────────────────────────────────────────────────────

describe('draft-access doc codec', () => {
  const doc = (grants: {p: string; at: number}[], revokes: {p: string; at: number}[] = []): DraftAccessDoc => ({
    grants,
    revokes,
  });

  it('round-trips through encode/parse', () => {
    const parsed = parseDraftAccessDoc(encodeDraftAccessDoc(doc([{p: C, at: 10}], [{p: D, at: 5}])));
    expect(parsed).toEqual(doc([{p: C, at: 10}], [{p: D, at: 5}]));
  });

  it('parse tolerates garbage and drops malformed entries', () => {
    expect(parseDraftAccessDoc('nope')).toBeNull();
    expect(parseDraftAccessDoc(JSON.stringify({v: 2, grants: []}))).toBeNull(); // wrong version
    expect(parseDraftAccessDoc(JSON.stringify({v: 1, grants: [{p: 'bad', at: 1}], revokes: 'x'}))).toEqual(
      doc([]),
    );
  });

  it('draftAccessDTag / buildDraftDeliveryTags shape the addressable ids', () => {
    expect(draftAccessDTag('share1')).toBe('draft-access:share1');
    expect(draftDeliveryDTag('share1', C)).toBe(`draft-delivery:share1:${C}`);
    expect(buildDraftDeliveryTags('share1', C)).toEqual([
      ['d', `draft-delivery:share1:${C}`],
      ['p', C],
    ]);
  });
});

describe('foldDraftAccess', () => {
  const doc = (grants: {p: string; at: number}[], revokes: {p: string; at: number}[] = []): DraftAccessDoc => ({
    grants,
    revokes,
  });

  it('a non-authorized author cannot fake a grant', () => {
    const folded = foldDraftAccess(
      [
        {author: A, doc: doc([{p: C, at: 10}])},
        {author: D, doc: doc([{p: B, at: 20}])}, // D is not authorized
      ],
      new Set([A]),
    );
    expect(folded).toEqual([{p: C, at: 10}]);
  });

  it('a revoke at-or-after the grant kills it', () => {
    const folded = foldDraftAccess(
      [{author: A, doc: doc([{p: C, at: 10}], [{p: C, at: 15}])}],
      new Set([A]),
    );
    expect(folded).toEqual([]);
  });

  it('a revoke exactly AT the grant time still kills it (same-or-later)', () => {
    const folded = foldDraftAccess([{author: A, doc: doc([{p: C, at: 10}], [{p: C, at: 10}])}], new Set([A]));
    expect(folded).toEqual([]);
  });

  it('a RE-grant newer than the revoke stands (re-approve after revoke)', () => {
    const folded = foldDraftAccess(
      [{author: A, doc: doc([{p: C, at: 30}], [{p: C, at: 15}])}],
      new Set([A]),
    );
    expect(folded).toEqual([{p: C, at: 30}]);
  });

  it('no membership-completion step: a granted pubkey never silently drops off', () => {
    // Unlike foldInvites (an invite completes and vanishes once the target JOINS), a draft grant has
    // no such event — it stands until an explicit revoke, so feeding the SAME grant repeatedly changes
    // nothing.
    const folded = foldDraftAccess(
      [{author: A, doc: doc([{p: C, at: 10}])}, {author: A, doc: doc([{p: C, at: 10}])}],
      new Set([A]),
    );
    expect(folded).toEqual([{p: C, at: 10}]);
  });
});

// ── 3. DraftDelivery snapshot codec + seal/decrypt round-trip ───────────────────────────────────

describe('DraftDelivery snapshot codec', () => {
  it('round-trips the full shape', () => {
    const snap = {ti: 'A quiet Tuesday', b: 'The body of the piece.', tg: ['t1', 't2'], l: 'article', cw: 'grief'};
    const parsed = parseDraftDeliverySnapshot(encodeDraftDeliverySnapshot(snap));
    expect(parsed).toEqual(snap);
  });

  it('round-trips the minimal shape (body only)', () => {
    const parsed = parseDraftDeliverySnapshot(encodeDraftDeliverySnapshot({b: 'just the body'}));
    expect(parsed).toEqual({b: 'just the body'});
  });

  it('DRAFT_DELIVERY_TOMBSTONE (what revokeDraftAccess seals) parses to null, not an empty body', () => {
    expect(parseDraftDeliverySnapshot(DRAFT_DELIVERY_TOMBSTONE)).toBeNull();
  });

  it('a truly empty string also parses to null (defensive — NIP-44 itself never seals one)', () => {
    expect(parseDraftDeliverySnapshot('')).toBeNull();
  });

  it('parse never throws on garbage / wrong version / missing body', () => {
    expect(parseDraftDeliverySnapshot('not json')).toBeNull();
    expect(parseDraftDeliverySnapshot(JSON.stringify({v: 2, b: 'x'}))).toBeNull();
    expect(parseDraftDeliverySnapshot(JSON.stringify({v: 1}))).toBeNull(); // no `b`
  });

  it('SEAL/DECRYPT round-trip: the owner seals directly to the requester', () => {
    const ownerSk = generateSecretKey();
    const requesterSk = generateSecretKey();
    const requesterPk = getPublicKey(requesterSk);
    const ownerPk = getPublicKey(ownerSk);

    const snapshot = {ti: 'A quiet Tuesday', b: 'The real writing goes here, in full.'};
    const wire = encodeDraftDeliverySnapshot(snapshot);
    const ciphertext = sealFor(ownerSk, requesterPk, wire);
    expect(ciphertext).not.toContain('quiet Tuesday');

    const opened = openFrom(requesterSk, ownerPk, ciphertext);
    expect(parseDraftDeliverySnapshot(opened)).toEqual(snapshot);

    // Someone else entirely cannot open the requester's delivery.
    const eavesdropperSk = generateSecretKey();
    expect(() => openFrom(eavesdropperSk, ownerPk, ciphertext)).toThrow();
  });

  it('a revoke tombstone (sealed DRAFT_DELIVERY_TOMBSTONE) decrypts fine but parses to null', () => {
    const ownerSk = generateSecretKey();
    const requesterSk = generateSecretKey();
    const requesterPk = getPublicKey(requesterSk);
    const ownerPk = getPublicKey(ownerSk);

    // What revokeDraftAccess actually seals — NIP-44 rejects a truly empty plaintext outright.
    const ciphertext = sealFor(ownerSk, requesterPk, DRAFT_DELIVERY_TOMBSTONE);
    const opened = openFrom(requesterSk, ownerPk, ciphertext);
    expect(opened).toBe(DRAFT_DELIVERY_TOMBSTONE);
    expect(parseDraftDeliverySnapshot(opened)).toBeNull();
  });
});

// ── Phase 7§A sentinel ───────────────────────────────────────────────────────────────────────────

describe('DRAFT_COMMENT_ROOT_KIND', () => {
  it('is never Kind.Post (1) — buildPostComment must take the kind-1111 branch for a draft root', () => {
    expect(DRAFT_COMMENT_ROOT_KIND).not.toBe(1);
  });
});

// ── local denied-request store ──────────────────────────────────────────────────────────────────

describe('local denied-draft-access store', () => {
  beforeEach(() => void (AsyncStorage as unknown as {clear: () => Promise<void>}).clear());

  it('persists per slot and round-trips', async () => {
    await saveDeniedDraftAccess({[`share1:${C}`]: 100}, 'slotA');
    expect(await loadDeniedDraftAccess('slotA')).toEqual({[`share1:${C}`]: 100});
    // Another slot's denials are siloed.
    expect(await loadDeniedDraftAccess('slotB')).toEqual({});
  });

  it('tolerates corrupt storage', async () => {
    await AsyncStorage.setItem('stiq.draftaccess.denied.slot.slotA', '{broken');
    expect(await loadDeniedDraftAccess('slotA')).toEqual({});
  });
});

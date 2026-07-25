import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {
  buildMediaBlobEvent,
  encodeBlobTail,
  mediaSourceKey,
  mediaSourceTail,
  needsFetch,
  parseBlobTail,
  parseMediaSource,
  payloadWeightBytes,
  readMediaBlobPayload,
  splitMediaBlobs,
  splitMediaBlobsIfEnabled,
  type UnsignedMediaBlob,
} from './mediaBlob';
import {encodeInlinePicture, extractInlinePictures, packPicture} from './picture';
import {KIND_MEDIA_BLOB} from '../contracts';
import {bytesToBase64} from '../util/base64';

const ID_A = 'a'.repeat(64);

/** Sign a blob with a throwaway key, exactly as the publish path will. */
function signer(): (blob: UnsignedMediaBlob) => Event {
  return blob => finalizeEvent({kind: blob.kind, created_at: blob.created_at, tags: blob.tags, content: blob.content}, generateSecretKey());
}

/** A real, valid inline picture token (2x2, 2 colours). */
function picToken(label?: string): string {
  return encodeInlinePicture(
    {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])},
    'none',
    label,
  );
}

describe('blob tail grammar', () => {
  it('round-trips an event id through the tail', () => {
    expect(parseBlobTail(encodeBlobTail(ID_A))).toBe(ID_A);
  });

  it('refuses to encode anything that is not a 64-hex event id', () => {
    // A bad id here would silently corrupt a published body, so this must throw rather than coerce.
    expect(() => encodeBlobTail('nope')).toThrow();
    expect(() => encodeBlobTail(ID_A.toUpperCase())).toThrow();
    expect(() => encodeBlobTail(`${ID_A}extra`)).toThrow();
  });

  it('reads an ordinary base64 payload as an inline source, not a blob', () => {
    const source = parseMediaSource('UABCDEF==');
    expect(source).toEqual({kind: 'inline', payloadBase64: 'UABCDEF=='});
    expect(needsFetch(source)).toBe(false);
  });

  it('reads a blob tail as a blob source', () => {
    const source = parseMediaSource(encodeBlobTail(ID_A));
    expect(source).toEqual({kind: 'blob', blobId: ID_A});
    expect(needsFetch(source)).toBe(true);
  });

  it('mediaSourceTail is the exact inverse of parseMediaSource', () => {
    for (const tail of ['UABCDEF==', encodeBlobTail(ID_A)]) {
      expect(mediaSourceTail(parseMediaSource(tail))).toBe(tail);
    }
  });

  it('keys inline sources by payload and blob sources by id', () => {
    expect(mediaSourceKey({kind: 'inline', payloadBase64: 'UAAA'})).toBe('UAAA');
    expect(mediaSourceKey({kind: 'blob', blobId: ID_A})).toBe(ID_A);
  });

  /**
   * The collision-freedom claim the whole tail-reuse design rests on: a blob marker and a real
   * picture payload are disjoint BY CONSTRUCTION, not by luck. A picture binary always starts with
   * MAGIC 0x50, which base64-encodes to a leading 'U' — never the 'S' of STIQBLOB. If this ever
   * fails, a genuine inline picture could be mistaken for a blob reference and silently vanish.
   */
  it('a valid picture payload can never be mistaken for a blob tail', () => {
    for (const res of [2, 8, 16]) {
      const raw = packPicture(
        {res, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array(res * res)},
        'none',
      );
      const payload = bytesToBase64(raw);
      expect(payload.startsWith('U')).toBe(true);
      expect(parseBlobTail(payload)).toBeNull();
    }
  });
});

describe('blob event round-trip', () => {
  it('carries a payload out and back byte-identically', () => {
    const payload = 'UABCDEFGH1234567890+/==';
    const blob = signer()(buildMediaBlobEvent(payload));
    expect(blob.kind).toBe(KIND_MEDIA_BLOB);
    expect(readMediaBlobPayload(blob)).toBe(payload);
  });

  it('carries NO tags — nothing linking it back to its post, and no modality marker', () => {
    // Relay-blindness: the post points at the blob, never the reverse, and the relay must not be
    // able to tell a picture blob from a voice blob.
    expect(buildMediaBlobEvent('UAAA').tags).toEqual([]);
  });

  it('rejects a non-blob kind, an empty payload, and a non-base64 payload', () => {
    const sign = signer();
    expect(readMediaBlobPayload(sign({...buildMediaBlobEvent('UAAA'), kind: 1}))).toBeNull();
    expect(readMediaBlobPayload(sign(buildMediaBlobEvent('')))).toBeNull();
    expect(readMediaBlobPayload(sign(buildMediaBlobEvent('not base64!!')))).toBeNull();
    expect(readMediaBlobPayload(undefined)).toBeNull();
    expect(readMediaBlobPayload(null)).toBeNull();
  });
});

describe('splitMediaBlobs — publish-side', () => {
  it('moves a picture payload into a blob and leaves a reference behind', () => {
    const body = `look at this ${picToken('cat')} ok?`;
    const {blobs, body: out} = splitMediaBlobs(body, signer());

    expect(blobs).toHaveLength(1);
    // The body no longer carries the bytes...
    expect(out).not.toContain(blobs[0]!.content);
    // ...but still carries everything needed to draw the idle chip without any fetch.
    expect(out).toContain('[[pic:2;2;l=cat;');
    expect(out).toContain(`STIQBLOB${blobs[0]!.id}`);
    expect(out.startsWith('look at this ')).toBe(true);
    expect(out.endsWith(' ok?')).toBe(true);
  });

  it('the reference parses back to exactly the blob that carries the bytes', () => {
    const token = picToken('cat');
    // What the bytes were BEFORE the split (the inline form).
    const original = extractInlinePictures(token)[0]!.source as {kind: 'inline'; payloadBase64: string};

    const {blobs, body} = splitMediaBlobs(token, signer());
    const split = extractInlinePictures(body)[0]!;

    // The body points at the blob...
    expect(split.source).toEqual({kind: 'blob', blobId: blobs[0]!.id});
    // ...and the blob carries byte-identically what used to ride inline. This is the whole contract:
    // a reader resolving the reference ends up with exactly what an inline reader would have had.
    expect(readMediaBlobPayload(blobs[0]!)).toBe(original.payloadBase64);
    // The chip metadata survives, so the idle chip still renders with zero network.
    expect(split.res).toBe(2);
    expect(split.colours).toBe(2);
    expect(split.label).toBe('cat');
  });

  it('preserves the metered byte weight across the split (the organizer allowance must not collapse)', () => {
    // A REALISTIC picture (64², 16 colours ⇒ several KB), not the 2×2 toy: the failure mode being
    // guarded is "weight collapses to the length of the 72-char reference", which a toy picture is
    // too small to reveal — its payload is shorter than the reference that would replace it.
    const big = encodeInlinePicture(
      {res: 64, colours: 16, palette: Array.from({length: 16}, (_, i) => [i * 16, i * 16, i * 16]), indices: new Uint8Array(64 * 64).fill(3)},
      'none',
      'cat',
    );
    const before = extractInlinePictures(big).reduce((n, p) => n + p.weightBytes, 0);
    expect(before).toBeGreaterThan(2000); // a real payload, comfortably larger than any reference

    const {body} = splitMediaBlobs(big, signer());
    const after = extractInlinePictures(body).reduce((n, p) => n + p.weightBytes, 0);

    // This is exactly AppRuntime.accountPictures' reduction. If `w=` were dropped, `after` would
    // collapse to the ~72-char reference and the per-period allowance would silently stop metering.
    expect(after).toBe(before);
  });

  it('splits several pictures in one body, in document order', () => {
    const {blobs, body} = splitMediaBlobs(`${picToken('one')} and ${picToken('two')}`, signer());
    expect(blobs).toHaveLength(2);
    const pics = extractInlinePictures(body);
    expect(pics.map(p => p.label)).toEqual(['one', 'two']);
    expect(pics.map(p => (p.source as {blobId: string}).blobId)).toEqual(blobs.map(b => b.id));
  });

  it('is idempotent — a re-queued body is never blobbed twice', () => {
    const once = splitMediaBlobs(picToken('cat'), signer());
    const twice = splitMediaBlobs(once.body, signer());
    expect(twice.blobs).toHaveLength(0);
    expect(twice.body).toBe(once.body);
  });

  it('leaves a body with no media completely alone', () => {
    const body = 'just some prose with a [[notmedia:x]] and nostr:nevent1xyz';
    const {blobs, body: out} = splitMediaBlobs(body, signer());
    expect(blobs).toHaveLength(0);
    expect(out).toBe(body);
  });

  it('is modality-agnostic — it splits a voice token identically, with no voice code here', () => {
    // Slot I plugs voice in by parsing this same tail; the transport needs no per-modality branch.
    const voice = '[[voice:audio/mp4;3.5;wf=1,2,3;QUJDREVGRw==]]';
    const {blobs, body} = splitMediaBlobs(`hi ${voice}`, signer());
    expect(blobs).toHaveLength(1);
    expect(readMediaBlobPayload(blobs[0]!)).toBe('QUJDREVGRw==');
    expect(body).toContain('[[voice:audio/mp4;3.5;wf=1,2,3;w=12;STIQBLOB');
  });

  /**
   * THE HALF-FAIL CASE. A post that ships while its blob does not is a permanently broken picture
   * for every reader. Blob-first ordering makes that outcome unreachable: if the blob cannot even be
   * created, the body is never rewritten and the caller publishes nothing at all.
   */
  it('throws and rewrites NOTHING when a blob cannot be signed', () => {
    const body = `before ${picToken('cat')} after`;
    expect(() =>
      splitMediaBlobs(body, () => {
        throw new Error('sign failed (e.g. blind wallet exhausted)');
      }),
    ).toThrow('sign failed');
  });

  it('never emits a body referencing a blob the caller was not handed', () => {
    // Every id the body references must appear in `blobs` — otherwise readers would chase a blob
    // that was never published.
    const {blobs, body} = splitMediaBlobs(`${picToken('a')} ${picToken('b')}`, signer());
    const referenced = extractInlinePictures(body).map(p => (p.source as {blobId: string}).blobId);
    expect(referenced.sort()).toEqual(blobs.map(b => b.id).sort());
  });
});

describe('splitMediaBlobsIfEnabled — the LAZY_MEDIA_BLOBS gate', () => {
  // `enabled` is an explicit parameter here, so both branches are exercised directly whatever the
  // committed const says — no config mock needed, and the OFF branch stays covered now that ON ships.
  it('flag OFF is a byte-identical no-op: media keeps riding inline, as it did before the split', () => {
    const body = `hi ${picToken('cat')}`;
    const {blobs, body: out} = splitMediaBlobsIfEnabled(body, signer(), false);
    expect(blobs).toEqual([]);
    expect(out).toBe(body);
  });

  it('flag OFF never even calls the signer (no blob is created, let alone published)', () => {
    const sign = jest.fn(signer());
    splitMediaBlobsIfEnabled(picToken('cat'), sign, false);
    expect(sign).not.toHaveBeenCalled();
  });

  it('flag ON splits, exactly as splitMediaBlobs does', () => {
    const {blobs, body} = splitMediaBlobsIfEnabled(picToken('cat'), signer(), true);
    expect(blobs).toHaveLength(1);
    expect(body).toContain('STIQBLOB');
  });

  /**
   * THE TRIPWIRE ON AN ACCIDENTAL FLIP — now pointing the other way.
   *
   * `enabled` defaults to the LAZY_MEDIA_BLOBS const, and this file does not mock the config, so
   * this is the one assertion here that reads what a real build does. It shipped OFF, pending the
   * relay allow-listing kind 30351 on BOTH its gates; the relay was redeployed and verified on
   * 2026-07-15 and the flag was flipped ON, so the expectation moved with it — a deliberate, visible
   * edit, which is exactly what the previous version of this test demanded and got.
   *
   * Flipping it back OFF is a LEGITIMATE ROLLBACK, not a bug: the read path is unconditional, so
   * bodies published while it was on keep working forever, and the OFF write path is still fully
   * covered (the two tests above, plus mediaBlobPublish.off.test.ts end-to-end). It must simply be
   * CONSCIOUS — because OFF silently puts every composed picture's ≤48KB (and voice's ≤267KB) of
   * base64 back inside the post body, streamed to every member on the feed REQ whether or not they
   * ever tap it. That is bug 2, and nothing else in the suite would notice its return.
   */
  it('defaults to the committed flag value — currently ON (the relay admits 30351 as of 2026-07-15)', () => {
    const token = picToken('cat');
    const {blobs, body: out} = splitMediaBlobsIfEnabled(token, signer());
    expect(blobs).toHaveLength(1);
    expect(out).not.toBe(token);
    expect(out).toContain('STIQBLOB');
    // The bytes moved rather than vanished — the default must be the real split, not a rewrite.
    expect(readMediaBlobPayload(blobs[0]!)).toBe(
      (extractInlinePictures(token)[0]!.source as {payloadBase64: string}).payloadBase64,
    );
  });
});

describe('payloadWeightBytes', () => {
  it('prefers the w= field when present', () => {
    expect(payloadWeightBytes('49152', 'STIQBLOB')).toBe(49152);
  });

  it('falls back to the tail length for inline/legacy tokens', () => {
    expect(payloadWeightBytes(undefined, 'UABCD')).toBe(5);
  });

  it('falls back rather than metering zero on a malformed w= (a corrupt token buys no free allowance)', () => {
    expect(payloadWeightBytes('notanumber', 'UABCD')).toBe(5);
    expect(payloadWeightBytes('-5', 'UABCD')).toBe(5);
  });
});

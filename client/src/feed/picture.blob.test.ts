/**
 * Backward compatibility is the non-negotiable half of the blob split: every post already published
 * carries an INLINE `[[pic:…]]` token, and every user's local SQLite cache is full of them. Those
 * must keep rendering forever, unchanged, with no fetch. These tests pin that, and pin that the new
 * blob-reference form parses through the same path to the same shape.
 */
import {
  countInlinePictures,
  decodePicture,
  decodePicturePayload,
  encodeInlinePicture,
  extractInlinePictures,
  hasInlinePicture,
  inlinePictureSummary,
  packPicture,
  stripInlinePictures,
} from './picture';
import {segmentInlineMedia, bodyForMeasure, countInlineMedia, labelInlineMedia} from './inlineMedia';
import {encodeBlobTail} from './mediaBlob';
import {bytesToBase64} from '../util/base64';

const BLOB_ID = 'c'.repeat(64);

function pixels() {
  return {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])};
}

/** The LEGACY on-the-wire form: bytes inline in the body. Exactly what is already published. */
function legacyToken(label = 'cat'): string {
  return encodeInlinePicture(pixels(), 'none', label);
}

/** The NEW form: chip metadata + real byte weight + a reference to the blob holding the bytes. */
function blobToken(label = 'cat', weight = 4096): string {
  return `[[pic:2;2;l=${label};w=${weight};${encodeBlobTail(BLOB_ID)}]]`;
}

describe('backward compatibility — legacy inline pictures', () => {
  it('still extracts, with its bytes in hand and no fetch implied', () => {
    const [pic] = extractInlinePictures(`hello ${legacyToken()} world`);
    expect(pic!.res).toBe(2);
    expect(pic!.colours).toBe(2);
    expect(pic!.label).toBe('cat');
    expect(pic!.source.kind).toBe('inline');
  });

  it('still decodes straight from the body', () => {
    const [pic] = extractInlinePictures(legacyToken());
    const decoded = decodePicture(pic!);
    expect(decoded).not.toBeNull();
    expect(decoded!.res).toBe(2);
    expect(Array.from(decoded!.indices)).toEqual([0, 1, 1, 0]);
  });

  it('still meters its weight as the base64 payload length', () => {
    const raw = bytesToBase64(packPicture(pixels(), 'none'));
    const [pic] = extractInlinePictures(legacyToken());
    expect(pic!.weightBytes).toBe(raw.length);
  });

  it('still strips, counts, summarises and labels', () => {
    const body = `a ${legacyToken()} b`;
    expect(stripInlinePictures(body)).toBe('a  b');
    expect(countInlinePictures(body)).toBe(1);
    expect(hasInlinePicture(body)).toBe(true);
    expect(inlinePictureSummary(legacyToken())).toBe('🖼️ Picture');
    expect(labelInlineMedia(legacyToken())).toBe('🖼️ picture');
  });

  it('still segments in place, so the chip renders where it sits in the text', () => {
    const segments = segmentInlineMedia(`before ${legacyToken()} after`);
    expect(segments.map(s => s.type)).toEqual(['text', 'pic', 'text']);
  });

  it('still refuses an oversized inline token (the hostile-payload cap is unchanged)', () => {
    const huge = `[[pic:2;2;l=x;${'A'.repeat(200_000)}]]`;
    expect(extractInlinePictures(huge)).toHaveLength(0);
  });
});

describe('the new blob-reference form', () => {
  it('parses to a blob source carrying no bytes', () => {
    const [pic] = extractInlinePictures(blobToken());
    expect(pic!.source).toEqual({kind: 'blob', blobId: BLOB_ID});
  });

  it('keeps the chip metadata, so an idle chip renders with zero network', () => {
    const [pic] = extractInlinePictures(blobToken('a dog'));
    expect(pic!.res).toBe(2);
    expect(pic!.colours).toBe(2);
    expect(pic!.label).toBe('a dog');
  });

  it('reports the REAL payload weight from w=, not the length of the reference', () => {
    const [pic] = extractInlinePictures(blobToken('cat', 49152));
    expect(pic!.weightBytes).toBe(49152);
  });

  it('cannot be decoded without fetching first (decodePicture is for bytes in hand)', () => {
    const [pic] = extractInlinePictures(blobToken());
    expect(decodePicture(pic!)).toBeNull();
  });

  it('decodes once its payload has been resolved', () => {
    const payload = bytesToBase64(packPicture(pixels(), 'none'));
    const decoded = decodePicturePayload(payload);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.indices)).toEqual([0, 1, 1, 0]);
  });

  it('is indistinguishable from an inline picture to every body-level helper', () => {
    // The whole point of reusing the token grammar: nothing downstream had to learn a new shape —
    // including the RELAY, which counts a post's media by this same grammar.
    const body = `a ${blobToken()} b`;
    expect(stripInlinePictures(body)).toBe('a  b');
    expect(countInlinePictures(body)).toBe(1);
    expect(countInlineMedia(body)).toBe(1);
    expect(hasInlinePicture(body)).toBe(true);
    expect(bodyForMeasure(body)).toBe('a  b');
    expect(inlinePictureSummary(blobToken())).toBe('🖼️ Picture');
    expect(labelInlineMedia(blobToken())).toBe('🖼️ picture');
    expect(segmentInlineMedia(body).map(s => s.type)).toEqual(['text', 'pic', 'text']);
  });
});

describe('mixed bodies', () => {
  it('renders a legacy picture and a blob-backed picture side by side, in order', () => {
    // The realistic migration state: an old post edited, or a feed showing both eras at once.
    const pics = extractInlinePictures(`${legacyToken('old')} then ${blobToken('new')}`);
    expect(pics.map(p => p.label)).toEqual(['old', 'new']);
    expect(pics.map(p => p.source.kind)).toEqual(['inline', 'blob']);
  });

  it('meters both forms into one total', () => {
    const raw = bytesToBase64(packPicture(pixels(), 'none'));
    const total = extractInlinePictures(`${legacyToken()} ${blobToken('x', 1000)}`).reduce((n, p) => n + p.weightBytes, 0);
    expect(total).toBe(raw.length + 1000);
  });
});

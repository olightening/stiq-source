/**
 * pendingPictureBytes — the typing-lag fix (defect 1a, 2026-07-15).
 *
 * ComposerScreen used to recompute `pendingPicBytes` on EVERY KEYSTROKE via
 * `extractInlinePictures(mediaRefs.current.reassemble(content))`, which rebuilds the full body with
 * every placeholder swapped back for its real (up to 48 KB) base64 payload, then regex-scans the
 * WHOLE reassembled string — O(picture size) string construction + scan per character typed.
 *
 * `pendingPictureBytes` computes the identical total directly off the COMPACT placeholder body: it
 * scans `content` (which only ever carries short `STIQMEDIAREF<n>` refs, never the real base64), and
 * resolves each ref's REAL weight via an O(1) map lookup (`MediaRefs.realTailFor`) instead of
 * reconstructing the real body. These tests prove the two computations agree exactly.
 */
import {pendingPictureBytes} from './ComposerScreen';
import {MediaRefs} from '../mediaRefs';
import {extractInlinePictures} from '../picture';

const bigB64 = (kb: number): string => 'A'.repeat(kb * 1024);
const picToken = (b64: string, label?: string): string =>
  `[[pic:16;4${label ? `;l=${label}` : ''};${b64}]]`;

/** The OLD computation ComposerScreen used before this fix — the ground truth these tests pin against. */
function oldReassembleBasedTotal(body: string, media: MediaRefs): number {
  return extractInlinePictures(media.reassemble(body)).reduce((n, p) => n + p.weightBytes, 0);
}

describe('pendingPictureBytes — matches the old reassemble-based total without reassembling the body', () => {
  it('0 pictures: an empty/plain-prose body is 0', () => {
    const media = new MediaRefs();
    const body = 'just some prose with no pictures';
    expect(pendingPictureBytes(body, media)).toBe(0);
    expect(pendingPictureBytes(body, media)).toBe(oldReassembleBasedTotal(body, media));
    expect(pendingPictureBytes('', media)).toBe(0);
  });

  it('1 picture: equals the real (post-reassembly) base64 length, not the placeholder length', () => {
    const media = new MediaRefs();
    const full = picToken(bigB64(40), 'art');
    const placeholder = media.toPlaceholder(full);
    const body = `hello ${placeholder} world`;

    // Sanity: the placeholder is tiny — proves this body is cheap to scan (the whole point of the fix).
    expect(placeholder.length).toBeLessThan(64);

    const total = pendingPictureBytes(body, media);
    expect(total).toBe(40 * 1024); // the REAL picture's base64 length
    expect(total).toBe(oldReassembleBasedTotal(body, media));
  });

  it('2 pictures: sums both real weights', () => {
    const media = new MediaRefs();
    const p1 = media.toPlaceholder(picToken(bigB64(30), 'one'));
    const p2 = media.toPlaceholder(picToken(bigB64(64)));
    const body = `intro ${p1} middle ${p2} end`;

    const total = pendingPictureBytes(body, media);
    expect(total).toBe(30 * 1024 + 64 * 1024);
    expect(total).toBe(oldReassembleBasedTotal(body, media));
  });

  it('picture added then deleted: self-corrects back down without touching the media map', () => {
    const media = new MediaRefs();
    const p1 = media.toPlaceholder(picToken(bigB64(20), 'keep'));
    const p2 = media.toPlaceholder(picToken(bigB64(50), 'drop'));
    const withBoth = `a ${p1} b ${p2} c`;
    expect(pendingPictureBytes(withBoth, media)).toBe(20 * 1024 + 50 * 1024);

    // Simulate the user deleting the second picture from the editor body (the map is untouched — it
    // still remembers BOTH refs, exactly like a real MediaRefs session where old refs are never
    // evicted). The total must drop to just the remaining picture's weight, matching what
    // extractInlinePictures(reassemble(...)) would compute on the now-shorter body.
    const afterDelete = `a ${p1} b  c`;
    const total = pendingPictureBytes(afterDelete, media);
    expect(total).toBe(20 * 1024);
    expect(total).toBe(oldReassembleBasedTotal(afterDelete, media));
  });

  it('a real (never-registered) token falls back to its own tail length, like reassemble leaves it', () => {
    const media = new MediaRefs();
    const real = picToken(bigB64(10));
    const body = `x ${real} y`;
    const total = pendingPictureBytes(body, media);
    expect(total).toBe(10 * 1024);
    expect(total).toBe(oldReassembleBasedTotal(body, media));
  });

  it('mixes real + placeholder pictures in one body correctly', () => {
    const media = new MediaRefs();
    const placeholder = media.toPlaceholder(picToken(bigB64(15), 'ph'));
    const real = picToken(bigB64(5));
    const body = `${placeholder} middle ${real}`;
    const total = pendingPictureBytes(body, media);
    expect(total).toBe(15 * 1024 + 5 * 1024);
    expect(total).toBe(oldReassembleBasedTotal(body, media));
  });

  it('ignores voice placeholders (only pictures count)', () => {
    const media = new MediaRefs();
    const voicePlaceholder = media.toPlaceholder(`[[voice:audio/mp4;30;${bigB64(80)}]]`);
    const body = `clip: ${voicePlaceholder}`;
    expect(pendingPictureBytes(body, media)).toBe(0);
    expect(pendingPictureBytes(body, media)).toBe(oldReassembleBasedTotal(body, media));
  });
});

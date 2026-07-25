import {MediaRefs} from './mediaRefs';
import {bodyForMeasure} from './inlineMedia';
import {extractInlinePictures} from './picture';
import {extractInlineVoices} from './voice';

const bigB64 = (kb: number): string => 'A'.repeat(kb * 1024);
const picToken = (b64: string, label?: string): string =>
  `[[pic:16;4${label ? `;l=${label}` : ''};${b64}]]`;
const voiceToken = (b64: string, wf?: string): string =>
  `[[voice:audio/mp4;30${wf ? `;wf=${wf}` : ''};${b64}]]`;

describe('MediaRefs — keep inline-media base64 out of the WebView bridge', () => {
  it('placeholder → reassemble round-trips a picture token exactly', () => {
    const m = new MediaRefs();
    const full = picToken(bigB64(60), 'art');
    const ph = m.toPlaceholder(full);
    expect(ph).not.toBe(full);
    expect(ph.length).toBeLessThan(64); // the giant base64 no longer crosses the bridge
    expect(m.reassemble(ph)).toBe(full);
  });

  it('placeholder → reassemble round-trips a voice token (with waveform) exactly', () => {
    const m = new MediaRefs();
    const full = voiceToken(bigB64(260), '1.00,0.50,0.75');
    const ph = m.toPlaceholder(full);
    expect(ph.length).toBeLessThan(80);
    expect(m.reassemble(ph)).toBe(full);
  });

  it('the placeholder is a compact fixed size regardless of payload size', () => {
    const m = new MediaRefs();
    const small = m.toPlaceholder(picToken(bigB64(1)));
    const huge = m.toPlaceholder(picToken(bigB64(260)));
    // Both placeholders are tiny; the size difference is only the ref counter, not the payload.
    expect(small.length).toBeLessThan(48);
    expect(huge.length).toBeLessThan(48);
  });

  it('is idempotent: the same token always maps to the same placeholder', () => {
    const m = new MediaRefs();
    const full = picToken(bigB64(50), 'x');
    expect(m.toPlaceholder(full)).toBe(m.toPlaceholder(full));
    // ingest of an already-placeholdered body is a no-op (stable across re-renders).
    const body = `a ${full} b`;
    const once = m.ingest(body);
    expect(m.ingest(once)).toBe(once);
  });

  it('ingest → reassemble round-trips a mixed body (prose + several tokens)', () => {
    const m = new MediaRefs();
    const p1 = picToken(bigB64(40), 'one');
    const v1 = voiceToken(bigB64(120));
    const p2 = picToken(bigB64(64));
    const body = `intro ${p1} middle ${v1} more ${p2} end`;
    const ingested = m.ingest(body);
    // No base64 payloads remain in the bridge-facing body.
    expect(ingested).not.toContain('AAAA');
    expect(ingested.length).toBeLessThan(300);
    expect(m.reassemble(ingested)).toBe(body);
  });

  it('leaves non-media tokens (nostr embeds) untouched', () => {
    const m = new MediaRefs();
    const embed = 'nostr:nevent1qqsxyz';
    expect(m.toPlaceholder(embed)).toBe(embed);
    const body = `see ${embed} here`;
    expect(m.ingest(body)).toBe(body);
    expect(m.reassemble(body)).toBe(body);
  });

  it('reassemble is a no-op for a real (never-registered) token', () => {
    const m = new MediaRefs();
    const full = picToken(bigB64(10));
    expect(m.reassemble(`x ${full} y`)).toBe(`x ${full} y`); // unknown tail → left as-is
  });

  it('placeholders are still stripped by bodyForMeasure (do not count toward the length limit)', () => {
    const m = new MediaRefs();
    const body = `hello ${m.toPlaceholder(picToken(bigB64(60), 'art'))} world ${m.toPlaceholder(voiceToken(bigB64(200)))}`;
    expect(bodyForMeasure(body).replace(/\s+/g, ' ').trim()).toBe('hello world');
  });

  it('placeholders are still detected as media by extractInline* (a media-only note is non-empty)', () => {
    const m = new MediaRefs();
    const picBody = m.toPlaceholder(picToken(bigB64(60), 'art'));
    const voiceBody = m.toPlaceholder(voiceToken(bigB64(200)));
    expect(extractInlinePictures(picBody).length).toBe(1);
    expect(extractInlineVoices(voiceBody).length).toBe(1);
  });

  describe('hasUnresolvedRef — guards against persisting a dangling placeholder', () => {
    it('flags a placeholder that a DIFFERENT (empty) map could not reassemble', () => {
      const a = new MediaRefs();
      const placeholder = a.toPlaceholder(picToken(bigB64(60), 'art'));
      const stranger = new MediaRefs(); // e.g. the map after a composer reopen / "Write another"
      const reassembled = stranger.reassemble(placeholder); // cannot resolve → leaves the placeholder
      expect(stranger.hasUnresolvedRef(reassembled)).toBe(true);
      expect(a.hasUnresolvedRef(a.reassemble(placeholder))).toBe(false); // its own map resolves it
    });

    it('does NOT flag a fully-reassembled body or a plain prose/real-token body', () => {
      const m = new MediaRefs();
      const full = picToken(bigB64(60), 'art');
      expect(m.hasUnresolvedRef(m.reassemble(m.toPlaceholder(full)))).toBe(false);
      expect(m.hasUnresolvedRef('just some prose with no media')).toBe(false);
      expect(m.hasUnresolvedRef(`prose ${full} more`)).toBe(false); // a real base64 tail is not a ref
    });
  });
});

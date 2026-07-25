import {
  segmentInlineMedia,
  bodyForMeasure,
  countInlineMedia,
  inlineMediaSummary,
  type BodySegment,
} from './inlineMedia';

// Minimal, strictly-valid inline tokens (mime/res/colours + a tiny base64 payload).
const PIC = '[[pic:2;2;AAAA]]';
const VOICE = '[[voice:audio/mp4;3;AAAA]]';
// A minimal embed token — the grammar, not the payload, is what measurement cares about.
const EVENT = 'stiq:event:eyJ2IjoxfQ';

/** Collapse a segment list to a compact shape for order/type assertions. */
function shape(segs: BodySegment[]): string[] {
  return segs.map(s => (s.type === 'text' ? `t:${s.value}` : s.type));
}

describe('segmentInlineMedia', () => {
  it('returns a single text segment when there is no media', () => {
    expect(shape(segmentInlineMedia('just some prose'))).toEqual(['t:just some prose']);
  });

  it('splits text · picture · text in document order', () => {
    expect(shape(segmentInlineMedia(`before ${PIC} after`))).toEqual(['t:before ', 'pic', 't: after']);
  });

  it('keeps a LEADING picture before the following text', () => {
    expect(shape(segmentInlineMedia(`${PIC}caption`))).toEqual(['pic', 't:caption']);
  });

  it('handles a voice clip and preserves order with a following picture', () => {
    expect(shape(segmentInlineMedia(`${VOICE} then ${PIC}`))).toEqual(['voice', 't: then ', 'pic']);
  });

  it('decodes each token into its typed payload', () => {
    const segs = segmentInlineMedia(`hi ${PIC}`);
    expect(segs[0]).toEqual({type: 'text', value: 'hi '});
    expect(segs[1]!.type).toBe('pic');
    if (segs[1]!.type === 'pic') expect(segs[1]!.pic.res).toBe(2);
  });

  it('leaves a malformed token inside the surrounding text (never crashes)', () => {
    // Not a valid pic token (no res;colours;base64) → stays as literal text, exactly like strip/extract.
    expect(shape(segmentInlineMedia('a [[pic:nope]] b'))).toEqual(['t:a [[pic:nope]] b']);
  });
});

describe('countInlineMedia — the value checked against a post type mediaMax cap', () => {
  it('counts zero for a prose-only body', () => {
    expect(countInlineMedia('just prose, no media')).toBe(0);
  });
  it('counts a single picture and a single voice clip', () => {
    expect(countInlineMedia(`caption ${PIC}`)).toBe(1);
    expect(countInlineMedia(`${VOICE} listen`)).toBe(1);
  });
  it('counts pictures + voice together, in any arrangement', () => {
    expect(countInlineMedia(`${PIC}${VOICE}`)).toBe(2);
    expect(countInlineMedia(`a ${PIC} b ${VOICE} c ${PIC}`)).toBe(3);
  });
  it('counts exactly the tokens bodyForMeasure strips (exemption ⇔ cap symmetry)', () => {
    const body = `intro ${PIC} middle ${VOICE} end`;
    // The two media tokens are removed for length…
    expect(bodyForMeasure(body).includes('pic')).toBe(false);
    expect(bodyForMeasure(body).includes('voice')).toBe(false);
    // …and are exactly the two counted against the cap.
    expect(countInlineMedia(body)).toBe(2);
  });
  it('ignores a malformed token (matches strip/segment behaviour)', () => {
    expect(countInlineMedia('a [[pic:nope]] b')).toBe(0);
  });
});

describe('non-prose strip/count matches the relay byte-for-byte (cross-language contract)', () => {
  // The SAME body list + expected numbers live in the relay's
  // relay/internal/policy/organizer_test.go (TestInlineMediaStripMatchesClient). If a body the
  // composer measures as N prose chars is measured as M != N by the relay, the relay can hard-reject
  // a post the composer accepted — the exact "failed post" outage. Both sides strip in ONE fixed
  // order: voice, then pictures, then embed/reference tokens. The nested cases below are where that
  // order changes the residue, and so are the cases that would diverge first.
  const cases: Array<[body: string, proseLen: number, media: number]> = [
    ['', 0, 0],
    ['hello world', 11, 0],
    ['[[pic:8;4;AAAA]]', 0, 1],
    ['[[voice:audio/mp4;3;QQ==]]', 0, 1],
    ['a[[pic:8;4;AAAA]]b[[voice:audio/mp4;3;QQ]]c', 3, 2],
    ['[[pic:8;4;[[voice:audio/x;1;QQ]]AAAA]]', 0, 1], // valid voice inside an invalid pic frame
    ['[[voice:audio/x;1;[[pic:8;4;AAAA]]QQ]]', 22, 1], // valid pic inside an invalid voice frame
    ['[[pic:8;4;[[voice:audio/x;1;[[pic:2;2;ZZ]]QQ]]AA]]', 36, 1], // double-nested
    // Embed/reference cards: a card is not prose and is not media — 0 length, 0 media count.
    ['stiq:event:AAAA', 0, 0],
    ['look stiq:event:AAAA', 5, 0],
    ['stiq:msg:AA stiq:draft:BB', 1, 0],
    // Two tokens GLUED together with no separator: the token charset covers letters, so the first
    // match swallows the second's "stiq" and leaves ':space:BB' behind as prose. That is the shared
    // grammar's behaviour — the renderers draw one card and literal text here too — and both sides
    // land on the identical residue, which is all this contract requires.
    ['stiq:event:AAstiq:space:BB', 9, 0],
    ['nostr:nevent1qqqq', 0, 0],
    ['[[pic:2;2;AAAA]] stiq:event:ZZZZ', 1, 1],
    // An embed inside a pic frame: the frame is INVALID while it still holds the ':'-bearing token, so
    // media-then-embeds leaves the (now well-formed) frame as prose. Stripping embeds first would
    // reveal the frame to the media pass and measure 0 instead of 14 — the divergence the fixed order
    // rules out. Both sides make one pass each, in this order.
    ['[[pic:8;4;AAstiq:event:BB]]', 14, 0],
  ];
  it.each(cases)('%j → prose %i, media %i', (body, proseLen, media) => {
    expect(bodyForMeasure(body).length).toBe(proseLen);
    expect(countInlineMedia(body)).toBe(media);
  });
});

describe('bodyForMeasure / inlineMediaSummary ignore every non-prose payload', () => {
  it('strips media tokens for measurement', () => {
    expect(bodyForMeasure(`caption ${PIC}`).trim()).toBe('caption');
  });
  it('strips embed cards for measurement — a card never spends the note character budget', () => {
    expect(bodyForMeasure(`caption ${EVENT}`).trim()).toBe('caption');
    expect(bodyForMeasure(`${PIC} caption ${EVENT}`).trim()).toBe('caption');
  });
  it('summarises a media-only body with a label, not its base64', () => {
    expect(inlineMediaSummary(PIC)).toBe('🖼️ Picture');
    expect(inlineMediaSummary(VOICE)).toBe('🎙️ Voice message');
  });
  it('summarises an embed-only body with its label, not its base64', () => {
    expect(inlineMediaSummary(EVENT)).toBe('📅 Event');
    expect(inlineMediaSummary(`  ${EVENT}  `)).toBe('📅 Event');
  });
  it('prefers real prose over any label', () => {
    expect(inlineMediaSummary(`See you there ${EVENT}`)).toBe('See you there');
  });
});

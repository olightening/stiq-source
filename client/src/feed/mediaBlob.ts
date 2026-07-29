/**
 * mediaBlob — the SHARED, modality-agnostic lazy media transport (pictures + voice + whatever next).
 *
 * ## The problem
 *
 * Inline media used to ride as base64 INSIDE the post body: `[[pic:res;colours;l=…;<base64>]]` (up to
 * 48KB) and `[[voice:mime;dur;wf=…;<base64>]]` (up to ~267KB of base64). Those bytes arrive with the
 * feed REQ over Tor for every post in the community whether or not anyone ever taps them — which is
 * what made the app unusable to browse. "Load on tap" was a fiction: `PictureChip` decoded bytes it
 * already held behind a hardcoded fake spinner delay.
 *
 * ## The mechanism
 *
 * A media token's payload tail becomes a REFERENCE to a separate {@link KIND_MEDIA_BLOB} event that
 * carries the bytes, fetched by id only on tap:
 *
 *     inline (legacy, still rendered):  [[pic:256;64;l=cat;UABCD…48KB…]]
 *     blob reference (new):             [[pic:256;64;l=cat;w=49152;STIQBLOB<64-hex blob event id>]]
 *
 * Everything the chip needs to draw its IDLE state (res/colours/label; mime/duration/waveform) stays
 * in the token, so a feed render still costs nothing and never needs the network to show a chip.
 *
 * ## Why the tail, and not a new `[[blob:…]]` token
 *
 * This is the {@link ../feed/mediaRefs} trick promoted from composer-session state to the wire.
 * mediaRefs already swaps a token's base64 tail for an opaque `STIQMEDIAREF<n>` placeholder and
 * documents why it is safe: the tail stays inside the `[A-Za-z0-9]` alphabet, so it remains a valid
 * base64-shaped tail and EVERY downstream consumer keeps working untouched. Reusing that shape means:
 *
 *   • `countInlineMedia` / `bodyForMeasure` / `labelInlineMedia` / `inlineMediaSummary` — unchanged.
 *   • `mediaRefs` (the RichEditor WebView bridge shim) — unchanged; a blob ref is just a short tail.
 *   • **The RELAY's per-post media cap — unchanged.** The relay counts media by this exact token
 *     grammar (see inlineMedia.ts: "The relay counts these identically (same token grammar) so the
 *     client gate and the relay's hard cap never disagree"). A new `[[blob:…]]` token would silently
 *     stop being counted, quietly breaking a governance control on the relay side.
 *   • Backward compatibility falls out for free: old and new tokens are ONE family, and the segment
 *     layer yields a lazy reference either way — the renderer cannot tell them apart.
 *
 * ## Collision-freedom (provable, not probabilistic)
 *
 * A blob tail is exactly `STIQBLOB` + 64 lowercase hex. A *valid* inline payload can never take that
 * shape: every picture binary starts with MAGIC `0x50`, which base64-encodes to a leading `U`, and
 * every voice payload is a base64 audio buffer of a registered mime. `S` ≠ `U`, so the two tails are
 * disjoint by construction, not by luck. `mediaBlob.test.ts` pins this.
 *
 * ## Relay-blindness: what this COSTS (an explicit, accepted regression)
 *
 * picture.ts used to guarantee "a picture is NOT its own event kind and carries NO distinguishing tag
 * … the relay never learns an event contains a picture". Splitting the bytes out FORFEITS that: the
 * relay now sees that a post references a blob, and sees the tap that fetches it. The user accepted
 * this trade explicitly (it is the only way to stop shipping every picture to every phone). Two
 * mitigations are built in:
 *   • ONE generic blob kind (not picture/voice kinds) ⇒ the relay learns "media", never WHICH media.
 *   • The blob carries no back-reference to its post and is signed by its own throwaway key, so the
 *     join only exists in one direction, and {@link fetchMediaBlobs} takes an ARRAY of ids so decoy
 *     cover-fetches can be layered on later (subscriptionPlan's `buildCoverSet` idiom) with no
 *     rework at any call site.
 *
 * This module is a LEAF (contracts + a base64 helper only), so `picture.ts`, `voice.ts` and the fetch
 * service can all depend on it without a cycle.
 */
import {KIND_MEDIA_BLOB, type Event} from '../contracts';
import {LAZY_MEDIA_BLOBS} from '../config';
import {resolveContent} from '../blind/blindPost';

/**
 * Where an inline media token's bytes actually live. The ONE abstraction pictures and voice share:
 * each modality parses its own metadata, then hands the tail here and stops caring about transport.
 *
 *   • `inline` — legacy: the bytes rode in the body and are already in hand (no fetch, ever).
 *   • `blob`   — the bytes live in a kind-30351 event, fetched by id on tap.
 */
export type MediaSource =
  | {kind: 'inline'; payloadBase64: string}
  | {kind: 'blob'; blobId: string};

/** Marker opening a blob-reference tail. Uppercase letters only ⇒ still a valid base64-alphabet tail. */
const BLOB_TAIL_PREFIX = 'STIQBLOB';

/** A blob tail: the marker + a 64-hex event id. Anchored, so a payload is never partially matched. */
const BLOB_TAIL_RE = new RegExp(`^${BLOB_TAIL_PREFIX}([0-9a-f]{64})$`);

/** A 32-byte hex event id (lowercase — the form nostr-tools emits and the relay echoes). */
const EVENT_ID_RE = /^[0-9a-f]{64}$/;

/** Build the token tail that references blob `blobId`. Throws on a non-id, which would corrupt a body. */
export function encodeBlobTail(blobId: string): string {
  if (!EVENT_ID_RE.test(blobId)) throw new Error('encodeBlobTail: not a 64-hex event id');
  return `${BLOB_TAIL_PREFIX}${blobId}`;
}

/** The blob id in `tail`, or null when `tail` is an ordinary inline payload. Never throws. */
export function parseBlobTail(tail: string): string | null {
  return BLOB_TAIL_RE.exec(tail)?.[1] ?? null;
}

/**
 * Classify a media token's payload tail. The single point where "are these bytes here, or do we have
 * to go get them?" is decided — every modality routes through it, so the answer can never diverge.
 */
export function parseMediaSource(tail: string): MediaSource {
  const blobId = parseBlobTail(tail);
  return blobId ? {kind: 'blob', blobId} : {kind: 'inline', payloadBase64: tail};
}

/**
 * The real payload size (base64 chars) a token represents — the value the organizer's allowance is
 * metered in. Shared by every modality so picture and voice can never meter differently.
 *
 * `wField` is the token's optional `w=<bytes>` capture; `tail` is its payload tail.
 *
 * ## Why `w=` exists at all (governance, not decoration)
 *
 * The organizer's per-period picture allowance is metered by summing `weightBytes` over the tokens in
 * a freshly-composed body (`AppRuntime.accountPictures` →
 * `extractInlinePictures(body).reduce(…weightBytes)`), where `weightBytes` is the base64 payload's
 * length. Move that payload into a blob and the sum silently collapses to the length of a 72-char
 * reference: the allowance would meter ≈0 and every cap (`allowanceBytes`, the composer's meter)
 * would quietly stop working — a governance control failing open, with nothing to notice it.
 * Carrying the real length forward on the token keeps the accounting measuring EXACTLY what it
 * measured before the split, without touching the accounting code.
 *
 * Each modality's strict extractor must accept an optional `;w=(\d+)` before the tail and pass its
 * capture here. It is absent on inline and legacy tokens — where the tail length IS the payload
 * length — so old bodies meter exactly as they always did. A malformed `w=` falls back to the tail
 * length rather than metering 0: a corrupt token must never buy free allowance.
 *
 * Placement is deliberate: `w=` sits before the LAST `;`, so mediaRefs' `SPLIT_RE` (greedy `.+;`)
 * still splits a blob-reference token into prefix + tail exactly as it splits an inline one.
 */
export function payloadWeightBytes(wField: string | undefined, tail: string): number {
  if (wField !== undefined) {
    const n = parseInt(wField, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return tail.length;
}

/** The `w=<bytes>;` segment to write before a blob tail. Empty when the weight isn't known. */
function encodeWeightField(weightBytes: number): string {
  return weightBytes >= 0 ? `w=${weightBytes};` : '';
}

/**
 * A stable key for one media source — the blob id, or the payload itself for an inline source (its
 * bytes ARE its identity). Use to key per-media UI/render caches so the same picture shown twice
 * decodes once.
 */
export function mediaSourceKey(source: MediaSource): string {
  return source.kind === 'blob' ? source.blobId : source.payloadBase64;
}

/**
 * The raw token tail this source was parsed from — the exact inverse of {@link parseMediaSource}, so
 * `parseMediaSource(mediaSourceTail(s))` ≡ `s`. For callers that work in TOKEN TEXT rather than
 * bytes (e.g. the composer's live byte meter, which resolves a tail through the mediaRefs placeholder
 * map) and must not care which form the token took.
 */
export function mediaSourceTail(source: MediaSource): string {
  return source.kind === 'blob' ? encodeBlobTail(source.blobId) : source.payloadBase64;
}

/** True when these bytes must be fetched before they can be rendered. */
export function needsFetch(source: MediaSource): source is {kind: 'blob'; blobId: string} {
  return source.kind === 'blob';
}

// ── the blob event ───────────────────────────────────────────────────────────────────────────────

/** An unsigned kind-30351 blob event, ready for a caller to stamp with a throwaway key. */
export interface UnsignedMediaBlob {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

/**
 * Build the blob event carrying `payloadBase64`.
 *
 * Content is the payload verbatim — byte-identical to the tail it replaces, so a blob round-trips
 * back to exactly the bytes the inline token would have carried, and the organizer's byte accounting
 * measures the same thing before and after the split (see picture.ts `weightBytes`).
 *
 * NO TAGS, deliberately. A tag naming the post would let the relay join blob→post from the blob side
 * and would be circular anyway (the post embeds the blob's id, so the blob must be built first). A
 * modality tag would hand the relay the picture/voice distinction the shared kind exists to withhold.
 */
export function buildMediaBlobEvent(payloadBase64: string, createdAt: number = Math.floor(Date.now() / 1000)): UnsignedMediaBlob {
  return {kind: KIND_MEDIA_BLOB, content: payloadBase64, tags: [], created_at: createdAt};
}

/** The payload carried by a blob event, or null if `event` isn't a well-formed blob. Never throws. */
export function readMediaBlobPayload(event: Event | undefined | null): string | null {
  if (!event || event.kind !== KIND_MEDIA_BLOB) return null;
  // Blobs ride the blind feedSigner, so under content encryption the base64 payload is sealed like
  // any body — and NIP-44 ciphertext is ITSELF base64, so without resolving first the regex below
  // would wave ciphertext through to the PNG/voice decoders as if it were media (the exact trap
  // config.ts's LAZY_MEDIA_BLOBS note documents). Resolve; a still-locked blob is simply "not
  // found" (soft-fail, retryable — peek() re-reads on every tap, so it heals the moment the epoch
  // unlocks; the referencing post is sealed under the same epoch and drives that unlock).
  const {text: content, locked} = resolveContent(event);
  if (locked) return null;
  if (typeof content !== 'string' || content.length === 0) return null;
  // A blob's content is always a base64 payload; reject anything else rather than hand a renderer
  // bytes it will fail to decode halfway through paint.
  return /^[A-Za-z0-9+/=]+$/.test(content) ? content : null;
}

// ── publish-side: split a composed body into blobs + a referencing body ──────────────────────────

/**
 * ONE inline media token, cross-modality. Mirrors mediaRefs' private `TOKEN_RE`/`SPLIT_RE` pair: the
 * body between `[[…:` and `]]` never contains `]`, and the metadata prefix is URL-/comma-encoded so
 * it holds no bare `;` before the tail — hence greedy `.+;` lands exactly on the payload delimiter.
 *
 * DUPLICATION NOTE: mediaRefs.ts holds an identical private grammar. It is not exported and that file
 * belongs to another change in flight, so it could not be shared here without a collision. These two
 * MUST be unified into one exported grammar (this one) on the next touch of mediaRefs — a second
 * divergent copy of the token grammar is exactly the failure this codebase keeps re-learning.
 */
const MEDIA_TOKEN_SPLIT_RE = /^(\[\[(?:pic|voice):.+;)([A-Za-z0-9+/=]+)\]\]$/;
const MEDIA_TOKEN_RE = /\[\[(?:pic|voice):[^\]]+\]\]/g;

/** The result of splitting a body: the blobs to publish FIRST, and the body that references them. */
export interface MediaBlobSplit {
  /**
   * The blob events to publish, in body order. The caller MUST publish/queue these BEFORE the body's
   * own event — see {@link splitMediaBlobs} for why that ordering is the whole half-fail story.
   */
  blobs: Event[];
  /** The body with every inline payload replaced by a reference to its blob. */
  body: string;
}

/**
 * Split every inline media payload in `body` out into its own blob event, returning the blobs plus a
 * body that references them. Modality-agnostic: it only ever touches a token's payload tail, so voice
 * rides this identically to pictures with no change here.
 *
 * `signBlob` turns an unsigned blob into a signed `Event` — injected rather than imported so this
 * module stays a signing-free leaf, and so a caller can supply the throwaway-key + blind-token
 * machinery that lives up in AppRuntime.
 *
 * ## Ordering, and why publish-half-fail is designed OUT rather than compensated for
 *
 * A two-event write can half-land, and one direction is catastrophic: a post that ships while its
 * blob does not is a permanently broken picture for every reader, unfixable after the fact. So the
 * ordering is not a detail, it is the mitigation:
 *
 *   1. Blobs are signed FIRST. A Nostr id IS the event hash, so signing YIELDS the id locally — no
 *      network round-trip is needed to learn what the body should reference. The composer therefore
 *      never awaits Tor to publish a picture (which would re-introduce the very foreground stall
 *      being fixed elsewhere this round).
 *   2. If signing ANY blob fails, this throws and NOTHING is rewritten — the caller falls back to
 *      today's inline behaviour or surfaces a normal publish failure. A body referencing a blob that
 *      was never created cannot escape this function.
 *   3. The caller queues blobs before the post through the SAME durable outbox, so both survive a
 *      crash and retry together. A crash between the two loses the POST (benign: the user retries and
 *      sees a normal failure), never the blob — the broken direction is the one made impossible.
 *
 * The author's own device saves the blob to its local store at publish, so their picture renders
 * instantly from the store with no fetch, exactly as an inline one used to.
 *
 * A token whose tail is ALREADY a blob reference is left alone (idempotent — a re-published or
 * re-queued body never re-blobs). A malformed token is left untouched inside the body, matching what
 * every other token helper here does.
 */
export function splitMediaBlobs(body: string, signBlob: (blob: UnsignedMediaBlob) => Event): MediaBlobSplit {
  const blobs: Event[] = [];
  const out = body.replace(MEDIA_TOKEN_RE, tok => {
    const m = MEDIA_TOKEN_SPLIT_RE.exec(tok);
    if (!m) return tok; // not a well-formed media token — leave it exactly as it is
    const prefix = m[1]!;
    const tail = m[2]!;
    if (parseBlobTail(tail)) return tok; // already a reference — idempotent
    const signed = signBlob(buildMediaBlobEvent(tail));
    blobs.push(signed);
    // `w=` carries the payload's real size forward so the organizer's allowance keeps metering the
    // same bytes it metered when they rode inline (see payloadWeightBytes).
    return `${prefix}${encodeWeightField(tail.length)}${encodeBlobTail(signed.id)}]]`;
  });
  return {blobs, body: out};
}

/**
 * THE PUBLISH ENTRY POINT — the one call a publisher makes. {@link splitMediaBlobs}, gated on the
 * {@link LAZY_MEDIA_BLOBS} flag.
 *
 * Flag ON is the committed default as of 2026-07-15: composed media is split into blob events and the
 * body carries references. The relay precondition that gated this is MET — kind 30351 was admitted on
 * both relay gates (`allowed_kinds` in the deployed config.json, which overrides the Go default, AND
 * the compiled-in `policy.blindContentKinds`) and the relay was redeployed and verified.
 *
 * Flag OFF remains fully supported and byte-identical to pre-2026-07-15: the body is returned untouched
 * and no blob is created, so media rides inline exactly as every picture already in the wild does. It is
 * the ROLLBACK, and it is not vestigial — it is also what a community with no shared key gets, because
 * the npub fallback cannot give each blob a distinct key (see splitMediaBlobs' own doc: a tagless
 * addressable blob signed by a shared key would silently ReplaceEvent its siblings). Both paths are
 * covered: ON against the committed config (app/inlineMediaPost.repro.test.ts), OFF via a config mock
 * (app/mediaBlobPublish.off.test.ts).
 *
 * `enabled` overrides the flag; it exists so both branches are directly testable without module
 * mocking (the `as boolean` cast on the flag keeps both branches type-checked either way).
 */
export function splitMediaBlobsIfEnabled(
  body: string,
  signBlob: (blob: UnsignedMediaBlob) => Event,
  enabled: boolean = LAZY_MEDIA_BLOBS,
): MediaBlobSplit {
  return enabled ? splitMediaBlobs(body, signBlob) : {blobs: [], body};
}

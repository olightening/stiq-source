/**
 * mediaRefs — keep multi-KB inline-media base64 OUT of the sandboxed RichEditor WebView bridge.
 *
 * An inline picture / voice token carries its payload as base64 in its final `;`-delimited segment
 * (`[[pic:res;colours;l=label;<base64>]]`, `[[voice:mime;dur;wf=…;<base64>]]`). A max picture is ~64 KB
 * and a max voice clip ~267 KB of base64. Routing that through the react-native-webview bridge (RN→page
 * `postMessage` is double-JSON-encoded into an `evaluateJavascript` script; page→RN goes back through a
 * `@JavascriptInterface`) is where a media note silently fails to post — the token is dropped/truncated
 * crossing the bridge, so RN's editor state loses it and a media-only note publishes empty (see
 * INLINE_MEDIA_POST_FAILURE.md §0).
 *
 * The fix: the editor only ever holds a compact PLACEHOLDER token — the same token with its base64 tail
 * swapped for a short opaque ref (`…;STIQMEDIAREF<n>]]`). The full token is held here on the RN side,
 * keyed by ref, and reassembled at the publish / draft-save boundary. The placeholder keeps the token's
 * metadata prefix, so the chip still renders, and the ref uses only `[A-Za-z0-9]`, so the placeholder
 * still matches every downstream token regex (chip anchor, `bodyForMeasure` strip, `extractInline*`).
 *
 * `MediaRefs` is per-composer-session state. `toPlaceholder`/`ingest` are idempotent (the same full
 * token always maps to the same ref), so `ingest` may be called on every render without churning refs.
 */

/** One inline media token (picture or voice), full or placeholder. Body content between `[[…:` and
 *  `]]` never contains `]`, so `[^\]]+` matches exactly one token. */
const TOKEN_RE = /\[\[(?:pic|voice):[^\]]+\]\]/g;

/** Split one token into (everything up to and INCLUDING the last `;`) and (its base64/ref tail). The
 *  metadata prefix (res/colours/l=label, mime/dur/wf=…) is URL-/comma-encoded and never contains a
 *  bare `;` before the tail, so greedy `.+;` lands on the delimiter right before the payload. */
const SPLIT_RE = /^(\[\[(?:pic|voice):.+;)([A-Za-z0-9+/=]+)\]\]$/;

const REF_PREFIX = 'STIQMEDIAREF';
/** A placeholder tail: the ref prefix + a hex counter. Uppercase+digits only ⇒ still valid base64
 *  alphabet, so a placeholder is indistinguishable from a real token to every downstream regex. */
const REF_RE = new RegExp(`^${REF_PREFIX}[0-9A-F]+$`);

/** Split a token into its prefix (through the last `;`) and payload tail, or null if not a media token. */
function splitToken(token: string): {prefix: string; tail: string} | null {
  const m = SPLIT_RE.exec(token);
  return m ? {prefix: m[1]!, tail: m[2]!} : null;
}

export class MediaRefs {
  /** ref tail → full token. */
  private readonly byRef = new Map<string, string>();
  /** full token → its ref tail (idempotency: the same token always yields the same placeholder). */
  private readonly byToken = new Map<string, string>();
  private seq = 0;

  /**
   * Convert ONE full media token to its compact placeholder (registering it), or return the input
   * unchanged if it isn't a media token or is already a placeholder. Idempotent per token content.
   */
  toPlaceholder(token: string): string {
    const parts = splitToken(token);
    if (!parts) return token; // not an inline media token (e.g. a nostr: embed) — leave it alone
    if (REF_RE.test(parts.tail)) return token; // already a placeholder
    let ref = this.byToken.get(token);
    if (!ref) {
      ref = `${REF_PREFIX}${(this.seq++).toString(16).toUpperCase()}`;
      this.byRef.set(ref, token);
      this.byToken.set(token, ref);
    }
    return `${parts.prefix}${ref}]]`;
  }

  /** A body with full media tokens → the same body with each token replaced by its placeholder.
   *  Idempotent: placeholders already present are left as-is. Use when seeding the editor (e.g. a
   *  resumed draft) so the bridge never carries base64. */
  ingest(body: string): string {
    return body.replace(TOKEN_RE, tok => this.toPlaceholder(tok));
  }

  /** A body with placeholder tokens → the same body with the full tokens restored. Tokens whose tail
   *  isn't a known ref (e.g. a real token that never went through the editor) are left unchanged. Use
   *  at the publish / draft-save boundary so the published event / saved draft carries real base64. */
  reassemble(body: string): string {
    return body.replace(TOKEN_RE, tok => {
      const parts = splitToken(tok);
      if (!parts) return tok;
      return this.byRef.get(parts.tail) ?? tok;
    });
  }

  /**
   * True if `body` still carries a placeholder ref — i.e. a token whose FINAL segment is a
   * STIQMEDIAREF that {@link reassemble} could not resolve (the map is out of sync). A real base64
   * tail is never all-ref-shaped, so this never false-positives on genuine media. Callers use it to
   * REFUSE persisting/publishing a dangling placeholder that would silently drop the real payload.
   */
  hasUnresolvedRef(body: string): boolean {
    return DANGLING_RE.test(body);
  }

  /**
   * The REAL (post-{@link reassemble}) base64 tail for one already-registered ref, or `null` if
   * `ref` isn't a known ref (e.g. it's already a real payload that never went through
   * {@link toPlaceholder}). Lets a caller read a placeholder's true payload weight straight off this
   * map — without reassembling the surrounding body — for hot paths (e.g. a live byte total
   * recomputed on every keystroke) where rebuilding a multi-KB body per call would be too slow.
   */
  realTailFor(ref: string): string | null {
    const full = this.byRef.get(ref);
    if (!full) return null;
    const parts = splitToken(full);
    return parts ? parts.tail : null;
  }
}

/** A media token whose payload tail is a placeholder ref (unresolved after reassemble). */
const DANGLING_RE = new RegExp(`\\[\\[(?:pic|voice):[^\\]]*;${REF_PREFIX}[0-9A-F]+\\]\\]`);

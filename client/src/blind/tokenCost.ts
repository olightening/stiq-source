/**
 * tokenCost — the single source of truth for how many per-post anti-spam tokens an event must
 * carry. It MIRRORS the relay's policy.TokenCost / chargeableSize byte-for-byte (relay/internal/
 * policy/weight.go): a blind post costs one token per `bytesPerToken` of chargeable weight, floored
 * at one. This is the unifying primitive — a plain note costs 1 token; a picture or voice clip
 * (which ride inline as base64 in event.content) costs proportionally more, with no content-type
 * awareness anywhere. The organizer sets bytesPerToken; 0 (default) disables weight-pricing (every
 * event costs exactly one token — byte-identical to the pre-weight-pricing behaviour), so this ships
 * dark until a community opts in.
 *
 * PARITY IS LOAD-BEARING: the relay measures Go `len(string)` = UTF-8 BYTES. This module must count
 * UTF-8 bytes too — NOT JS String.length (UTF-16 code units) — or the two sides disagree on an
 * event's weight and honest non-ASCII posts (Arabic, emoji) get rejected as under-paid. See
 * tokenCost.test.ts, which pins the exact byte counts shared with the Go weightprice_test.go.
 */
import {TAG_SIG, TAG_TOKEN, TAG_SPEND} from './protocol';

/** UTF-8 byte length of `s` — matches Go len(string). Uses TextEncoder when present, else counts by code point. */
export function utf8ByteLength(s: string): number {
  const Enc = (globalThis as {TextEncoder?: new () => {encode(input: string): Uint8Array}}).TextEncoder;
  if (Enc) {
    return new Enc().encode(s).length;
  }
  // Fallback (no TextEncoder): for…of iterates by code point, so surrogate pairs count once.
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * chargeableWeight mirrors the relay's chargeableSize EXACTLY: content bytes + every tag element's
 * bytes (+1 per element for the delimiter), EXCLUDING the anti-spam token tags (stiq_token /
 * stiq_sig / stiq_spend) so neither the tokens nor their P3 holder proofs ever price themselves
 * (the circularity trap). stiq_attr IS counted — it is real stored ciphertext, so the caller must
 * include the built attribution tag before pricing.
 */
export function chargeableWeight(content: string, tags: readonly string[][]): number {
  let n = utf8ByteLength(content);
  for (const tag of tags) {
    if (tag.length >= 1 && (tag[0] === TAG_TOKEN || tag[0] === TAG_SIG || tag[0] === TAG_SPEND)) {
      continue;
    }
    for (const el of tag) {
      n += utf8ByteLength(el) + 1;
    }
  }
  return n;
}

/** Active weight-pricing rate (bytes per token). 0 = disabled (one token per event); ships dark. */
let _bytesPerToken = 0;

/** Set the weight-pricing rate for the active community (from the organizer's limits doc). */
export function setBytesPerToken(n: number | undefined | null): void {
  _bytesPerToken = typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
}

/** The active weight-pricing rate (0 = disabled). */
export function getBytesPerToken(): number {
  return _bytesPerToken;
}

/**
 * How many tokens an event carrying `content` + `tags` must spend. One per bytesPerToken of
 * chargeable weight, floored at one. bytesPerToken<=0 (default) → always 1 (weight-pricing off).
 */
export function tokenCost(
  content: string,
  tags: readonly string[][],
  bytesPerToken: number = _bytesPerToken,
): number {
  if (bytesPerToken <= 0) {
    return 1;
  }
  const cost = Math.ceil(chargeableWeight(content, tags) / bytesPerToken);
  return cost < 1 ? 1 : cost;
}

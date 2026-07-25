/**
 * NIP-01 client/relay wire framing. Pure functions — no transport, no crypto — so the
 * message handling is fully unit-testable.
 */
import type {Event} from 'nostr-tools/pure';

export interface ReqFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  // Tag filters, e.g. "#t": ["announcements"] or "#e": [<eventId>].
  [tag: `#${string}`]: string[] | undefined;
}

export function reqMessage(subId: string, filters: ReqFilter[]): string {
  return JSON.stringify(['REQ', subId, ...filters]);
}

export function closeMessage(subId: string): string {
  return JSON.stringify(['CLOSE', subId]);
}

export function eventMessage(event: Event): string {
  return JSON.stringify(['EVENT', event]);
}

/** NIP-45 COUNT request: asks the relay to tally matching events without sending them. */
export function countMessage(subId: string, filters: ReqFilter[]): string {
  return JSON.stringify(['COUNT', subId, ...filters]);
}

/** NIP-77 NEG-OPEN: start a Negentropy reconciliation for `filter`, seeded with `message` (hex). */
export function negOpenMessage(subId: string, filter: ReqFilter, message: string): string {
  return JSON.stringify(['NEG-OPEN', subId, filter, message]);
}

/** NIP-77 NEG-MSG: a reconciliation round message (hex). */
export function negMsgMessage(subId: string, message: string): string {
  return JSON.stringify(['NEG-MSG', subId, message]);
}

/** NIP-77 NEG-CLOSE: end a reconciliation session. */
export function negCloseMessage(subId: string): string {
  return JSON.stringify(['NEG-CLOSE', subId]);
}

export type RelayMessage =
  | {type: 'EVENT'; subId: string; event: Event}
  | {type: 'EOSE'; subId: string}
  | {type: 'OK'; id: string; accepted: boolean; message: string}
  | {type: 'NOTICE'; message: string}
  | {type: 'CLOSED'; subId: string; message: string}
  | {type: 'COUNT'; subId: string; count: number}
  | {type: 'NEG-MSG'; subId: string; message: string}
  | {type: 'NEG-ERR'; subId: string; reason: string}
  | {type: 'UNKNOWN'; raw: unknown};

const HEX64_LOWER = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(v => typeof v === 'string');
}

/**
 * Structural (never semantic) validation for an incoming EVENT payload — this is the trust
 * boundary between the relay and everything downstream (verify/store/UI). It checks only that
 * the wire shape is sound (hex ids, correct field types, well-formed tags); it never inspects
 * `kind` or `content` values, so gift wraps, ephemeral kinds (9020-9027), group-state kinds
 * (39000-39005), and every other kind pass through unchanged as long as they're shaped like a
 * NIP-01 event. Cryptographic authenticity is still verified later by RelayClient — this only
 * stops a malformed frame from reaching that code (or a crash from a missing/mistyped field).
 */
function isValidEventShape(x: unknown): x is Event {
  if (typeof x !== 'object' || x === null) {
    return false;
  }
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    HEX64_LOWER.test(e.id) &&
    typeof e.pubkey === 'string' &&
    HEX64.test(e.pubkey) &&
    typeof e.sig === 'string' &&
    typeof e.kind === 'number' &&
    Number.isInteger(e.kind) &&
    typeof e.created_at === 'number' &&
    Number.isFinite(e.created_at) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every(isStringArray)
  );
}

/** Parse a raw relay frame into a typed message. Never throws. */
export function parseRelayMessage(raw: string): RelayMessage {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return {type: 'UNKNOWN', raw};
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    return {type: 'UNKNOWN', raw: arr};
  }
  switch (arr[0]) {
    case 'EVENT': {
      // Malformed EVENT payloads (missing/mistyped fields, non-array tags, etc.) are treated as
      // unrecognized frames — same convention as any other unparseable message — instead of
      // handing an unsafe shape to callers that assume a well-formed Event.
      if (!isValidEventShape(arr[2])) {
        return {type: 'UNKNOWN', raw: arr};
      }
      return {type: 'EVENT', subId: String(arr[1]), event: arr[2]};
    }
    case 'EOSE':
      return {type: 'EOSE', subId: String(arr[1])};
    case 'OK':
      return {
        type: 'OK',
        id: String(arr[1]),
        accepted: Boolean(arr[2]),
        message: String(arr[3] ?? ''),
      };
    case 'NOTICE':
      return {type: 'NOTICE', message: String(arr[1] ?? '')};
    case 'CLOSED':
      return {type: 'CLOSED', subId: String(arr[1]), message: String(arr[2] ?? '')};
    case 'COUNT': {
      const payload = arr[2] as {count?: number} | undefined;
      return {type: 'COUNT', subId: String(arr[1]), count: Number(payload?.count ?? 0)};
    }
    case 'NEG-MSG':
      return {type: 'NEG-MSG', subId: String(arr[1]), message: String(arr[2] ?? '')};
    // go-nostr emits the label "NEG-ERROR"; accept the spec's "NEG-ERR" too.
    case 'NEG-ERR':
    case 'NEG-ERROR':
      return {type: 'NEG-ERR', subId: String(arr[1]), reason: String(arr[2] ?? '')};
    default:
      return {type: 'UNKNOWN', raw: arr};
  }
}

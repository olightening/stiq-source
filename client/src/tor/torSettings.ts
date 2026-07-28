/**
 * User-configurable Tor connection preferences (connection-modes feature).
 *
 * The app has always run a fixed connect cascade (warm cache → direct → webtunnel → obfs4 →
 * snowflake) hardcoded in App.tsx. This module lets the user steer that cascade from Settings: a
 * friendly preset (Automatic / Fastest / Censored network / Max reachability) plus an Advanced
 * escape hatch (exact transport, pasted bridge lines, bootstrap timeout).
 *
 * Same shape as mediaSettings.ts: the live value is mirrored into a module-level accessor so the
 * cascade reads it synchronously (getTorConnectionPrefs()) without threading a preset through every
 * nested connect helper. Persisted as a single JSON blob in SecureStorage — consistent with
 * bridgeCache.ts (the stiq.tor.* namespace) and wiped by a duress reset, so a censored user's choice
 * to use bridges and their private bridge lines vanish along with their identity.
 *
 * The app stays Tor-only: 'direct' is direct *Tor* to public guards, never clearnet. No preset here
 * can bypass Tor (ALLOW_CLEARNET_FALLBACK stays false).
 */
import type {SecureStorage} from '../keys/keystore';
import type {TransportType} from './types';

/**
 * How the user wants the connect cascade to behave. Each maps to a policy applied at the top of the
 * cascade (App.tsx connectByMode); none removes the ultimate bridge-ladder fallback, so no preset
 * can strand the user offline.
 *  - auto:    today's full cascade (warm → direct → ladder). Default; unchanged behavior.
 *  - fast:    pin Direct Tor first, skip bridge priming. Best on an open network / behind a VPN.
 *  - bridges: skip the doomed direct attempt; go straight to the bridge ladder.
 *  - reach:   start the ladder at Snowflake (hardest to block) with longer patience.
 *  - custom:  use the Advanced transport + pasted bridges, then fall back to the auto ladder.
 */
export type ConnectionMode = 'auto' | 'fast' | 'bridges' | 'reach' | 'custom';

export const CONNECTION_MODES: readonly ConnectionMode[] = [
  'auto',
  'fast',
  'bridges',
  'reach',
  'custom',
];

/** Persisted connection preferences. Stored as one JSON blob under PREFS_KEY. */
export interface TorConnectionPrefs {
  mode: ConnectionMode;
  /** Advanced: exact transport for 'custom' mode. Undefined = let the mode decide. */
  preferredTransport?: TransportType;
  /** Advanced: user-pasted bridge lines (obfs4/webtunnel only), without a leading "Bridge ". */
  customBridges: string[];
  /** Advanced: per-attempt bootstrap deadline override (ms). Undefined = cascade defaults. */
  bootstrapTimeoutMs?: number;
}

export const DEFAULT_TOR_PREFS: TorConnectionPrefs = {mode: 'auto', customBridges: []};

const PREFS_KEY = 'stiq.tor.connectionPrefs';

/** Max custom bridge lines we keep: Tor stalls past ~32 circuits, so cap well under that. */
const MAX_CUSTOM_BRIDGES = 12;
/** Clamp the advanced timeout to a sane band so a fat-fingered value can't hang or thrash. */
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Transports a user may pin in custom mode (all of them; 'direct' simply carries no bridges) — a
 * `Record<TransportType, true>`, NOT a plain array, so a future member added to `TransportType`
 * fails tsc here unless this table is updated too.
 *
 * The Record is the point. As a plain `readonly TransportType[]` (what this was) the list compiles
 * fine forever while silently omitting a new transport, and the failure is invisible at runtime:
 * `normalizePrefs()` below would drop a persisted preference for that transport as if it were
 * garbage input — no error, no warning, the user's pinned choice just reverts. Exhaustiveness is
 * cheap to enforce here, so enforce it.
 */
const ALL_TRANSPORTS: Record<TransportType, true> = {
  direct: true,
  webtunnel: true,
  obfs4: true,
  snowflake: true,
};

// Live prefs, read synchronously by the connect cascade. Seeded with the default; replaced by the
// persisted value on load() and by the user via setPrefs().
let currentPrefs: TorConnectionPrefs = DEFAULT_TOR_PREFS;

/** The connection prefs in effect right now (user choice, else the default cascade). */
export function getTorConnectionPrefs(): TorConnectionPrefs {
  return currentPrefs;
}

/** Set the in-memory prefs only (no persistence). For the store and tests. */
export function setTorConnectionPrefsRuntime(prefs: TorConnectionPrefs): void {
  currentPrefs = prefs;
}

/** What a single pasted bridge line is, for per-line validation. */
export type BridgeLineKind = 'obfs4' | 'webtunnel' | 'snowflake' | 'vanilla' | 'invalid';

// obfs4 <ip:port> <40-hex fingerprint> cert=<…> [iat-mode=N]
const OBFS4_RE = /^obfs4\s+\S+:\d+\s+[0-9A-Fa-f]{40}\s+cert=\S+/i;
// webtunnel <ip:port> <40-hex fingerprint> … url=https://<…> [ver=…]
const WEBTUNNEL_RE = /^webtunnel\s+\S+:\d+\s+[0-9A-Fa-f]{40}\s+.*url=https?:\/\/\S+/i;
// snowflake … — rejected: its reachability comes from the bundled broker front + STUN list, not a
// hand-typed line, so a pasted snowflake bridge breaks the WebRTC rendezvous.
const SNOWFLAKE_RE = /^snowflake\s+/i;
// bare "<ip:port> <40-hex>" with no transport keyword — a vanilla bridge (rejected: PT-only here).
const VANILLA_RE = /^\S+:\d+\s+[0-9A-Fa-f]{40}/;

// An accepted bridge line is passed VERBATIM into TorStartConfig.bridgeLines, which the native layer
// (StiqArtiModule.kt) marshals into a JSON array element and arti-ffi/src/pt.rs parses directly with
// `BridgeConfigBuilder::from_str` — the same torrc-style `Bridge <line>` syntax, just never actually
// assembled into torrc text along the way. Bridge lines are untrusted input — users routinely paste
// them from forums/messaging apps — so a line carrying an embedded control character (a CR/LF
// smuggled after an otherwise-valid prefix) could still split into a second, attacker-chosen
// directive wherever it is eventually interpreted. Reject any C0 control char or DEL anywhere in the
// line, and cap the length (a real obfs4/webtunnel line is a few hundred chars). `trim()` only strips
// leading/trailing whitespace, so an embedded CR survives to be caught here. This is the load-bearing
// guard; parseBridgeLines' broadened split is defence in depth on top of it.
const MAX_BRIDGE_LINE_LEN = 600;

/** True if the string carries any C0 control char (U+0000–U+001F) or DEL (U+007F) — either would
 * let a smuggled CR/LF split an accepted bridge line into a second, attacker-chosen directive
 * wherever it is later interpreted. Uses a code-point scan (no control chars in source, no regex
 * lint suppression needed). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Classify a single bridge line. Only obfs4/webtunnel are accepted for custom use. */
export function validateBridgeLine(raw: string): BridgeLineKind {
  const line = raw.trim();
  // Reject control-char injection / implausible length before any transport match (see above).
  if (!line || line.length > MAX_BRIDGE_LINE_LEN || hasControlChar(line)) {
    return 'invalid';
  }
  if (OBFS4_RE.test(line)) {
    return 'obfs4';
  }
  if (WEBTUNNEL_RE.test(line)) {
    return 'webtunnel';
  }
  if (SNOWFLAKE_RE.test(line)) {
    return 'snowflake';
  }
  if (VANILLA_RE.test(line)) {
    return 'vanilla';
  }
  return 'invalid';
}

/** True for the two transports we accept as pasted custom bridges. */
function isAcceptedKind(kind: BridgeLineKind): kind is 'obfs4' | 'webtunnel' {
  return kind === 'obfs4' || kind === 'webtunnel';
}

/** Parse a multiline paste into accepted, deduped, capped bridge lines (drops blanks/invalid). */
export function parseBridgeLines(raw: string): string[] {
  const out: string[] = [];
  // Split on ANY line terminator — LF, CR, and CRLF — so a bare CR (which `/\r?\n/` would keep
  // INSIDE a line) can't carry the tail of a pasted blob into an accepted line. validateBridgeLine's
  // hasControlChar guard is the backstop if a terminator/control char still slips through.
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !isAcceptedKind(validateBridgeLine(trimmed))) {
      continue;
    }
    if (!out.includes(trimmed)) {
      out.push(trimmed);
    }
    if (out.length >= MAX_CUSTOM_BRIDGES) {
      break;
    }
  }
  return out;
}

/** The user's custom bridge lines that match a given transport (used by the connect cascade). */
export function customBridgesForTransport(
  prefs: TorConnectionPrefs,
  transport: TransportType,
): string[] {
  return prefs.customBridges.filter(line => validateBridgeLine(line) === transport);
}

/**
 * The transport implied by the user's pasted bridges — the kind of the first accepted line. Used in
 * custom mode when the user pasted obfs4/webtunnel lines but didn't pick an explicit transport, so
 * the cascade dials the transport their bridges are actually for (instead of silently dropping them
 * because the default transport didn't match). Returns undefined when no usable line was pasted.
 */
export function inferCustomTransport(prefs: TorConnectionPrefs): TransportType | undefined {
  for (const line of prefs.customBridges) {
    const kind = validateBridgeLine(line);
    if (kind === 'obfs4' || kind === 'webtunnel') {
      return kind;
    }
  }
  return undefined;
}

export interface BridgesValidation {
  /** False only when some non-blank line is not an obfs4/webtunnel bridge. Empty is valid. */
  valid: boolean;
  /** Count of accepted (obfs4/webtunnel) lines. */
  count: number;
  kind: 'empty' | 'obfs4' | 'webtunnel' | 'mixed' | 'invalid';
  message: string;
}

/**
 * Validate/classify a multiline custom-bridge paste for inline UI feedback (mirrors
 * mediaSettings.validateEndpoint). The first offending line short-circuits to an error.
 */
export function validateBridgeLines(raw: string): BridgesValidation {
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      valid: true,
      count: 0,
      kind: 'empty',
      message: 'No custom bridges — the app will fetch or use its built-in bridges.',
    };
  }
  let obfs4 = 0;
  let webtunnel = 0;
  for (const line of lines) {
    const kind = validateBridgeLine(line);
    if (kind === 'obfs4') {
      obfs4 += 1;
    } else if (kind === 'webtunnel') {
      webtunnel += 1;
    } else {
      const why =
        kind === 'snowflake'
          ? 'Snowflake lines aren’t supported here — pick the Max reachability preset instead.'
          : kind === 'vanilla'
            ? 'Plain bridges aren’t supported — paste an obfs4 or webtunnel line.'
            : 'Not a bridge line — expected obfs4 or webtunnel.';
      return {valid: false, count: obfs4 + webtunnel, kind: 'invalid', message: why};
    }
  }
  const count = obfs4 + webtunnel;
  const kind: BridgesValidation['kind'] =
    obfs4 > 0 && webtunnel > 0 ? 'mixed' : webtunnel > 0 ? 'webtunnel' : 'obfs4';
  const label = kind === 'mixed' ? 'obfs4 + webtunnel' : kind;
  return {
    valid: true,
    count,
    kind,
    message: `${count} ${label} ${count === 1 ? 'bridge' : 'bridges'} — looks good.`,
  };
}

/** Clamp/sanitize arbitrary input (persisted JSON or user edits) into safe, well-formed prefs. */
export function normalizePrefs(
  next: Partial<TorConnectionPrefs> | null | undefined,
): TorConnectionPrefs {
  const mode: ConnectionMode = CONNECTION_MODES.includes(next?.mode as ConnectionMode)
    ? (next!.mode as ConnectionMode)
    : 'auto';

  const preferredTransport =
    next?.preferredTransport && ALL_TRANSPORTS[next.preferredTransport]
      ? next.preferredTransport
      : undefined;

  const customBridges = Array.isArray(next?.customBridges)
    ? parseBridgeLines(next!.customBridges.join('\n'))
    : [];

  let bootstrapTimeoutMs: number | undefined;
  if (typeof next?.bootstrapTimeoutMs === 'number' && Number.isFinite(next.bootstrapTimeoutMs)) {
    bootstrapTimeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, Math.round(next.bootstrapTimeoutMs)),
    );
  }

  return {mode, preferredTransport, customBridges, bootstrapTimeoutMs};
}

/**
 * Persistent store for the user's connection prefs. Owned by AppRuntime; loaded at init() and
 * updated when the user applies a new mode in Settings. Mirrors MediaSettingsStore.
 */
export class TorSettingsStore {
  constructor(private readonly storage: SecureStorage | null) {}

  /** Load the persisted prefs into the live accessor (falls back to the default cascade). */
  async load(): Promise<void> {
    if (!this.storage) {
      setTorConnectionPrefsRuntime(DEFAULT_TOR_PREFS);
      return;
    }
    try {
      const raw = await this.storage.getItem(PREFS_KEY);
      setTorConnectionPrefsRuntime(raw ? normalizePrefs(JSON.parse(raw)) : DEFAULT_TOR_PREFS);
    } catch {
      setTorConnectionPrefsRuntime(DEFAULT_TOR_PREFS);
    }
  }

  getPrefs(): TorConnectionPrefs {
    return getTorConnectionPrefs();
  }

  /** Normalize, apply to the live accessor, and persist. */
  async setPrefs(next: TorConnectionPrefs): Promise<void> {
    const prefs = normalizePrefs(next);
    setTorConnectionPrefsRuntime(prefs);
    await this.storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  }
}

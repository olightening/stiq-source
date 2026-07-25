/**
 * RelayClient — subscribes to the relay over Tor, validates and caches events, and serves
 * the feed from cache (PLAN.md Step 5).
 *
 * Pipeline for each incoming event: kind filter -> signature verify -> dedupe -> store ->
 * notify. Invalid signatures are dropped (defense in depth; the relay verifies too). The
 * socket is injected, so this class never knows about Tor directly — but the production
 * factory only builds Tor-routed sockets (see torSocket.ts).
 */
import {verifyEvent, type Event} from 'nostr-tools/pure';
import {SUBSCRIBED_KINDS, GROUP_KINDS, FETCH_ONLY_KINDS, Kind} from './events';
import {
  parseRelayMessage,
  reqMessage,
  closeMessage,
  eventMessage,
  countMessage,
  negOpenMessage,
  negMsgMessage,
  negCloseMessage,
  type ReqFilter,
} from './protocol';
import {Negentropy, NegentropyStorage, type Item as NegItem} from './negentropy';
import {parseRejection, legacyRetryable} from './rejection';
import type {RelaySocket} from './socket';
import type {EventStore} from './store';
import {TAG_TOKEN} from '../blind/protocol';
import {log} from '../util/log';
import {OLDER_PAGE_LIMIT} from '../config';
import {sharedInboundBudget} from './inboundBudget';

/**
 * NIP-77 set-reconciliation for the feed, run as a SUPPLEMENTAL gap-repair pass on a warm cache
 * (fetching only the missing-id delta — a bandwidth win over Tor), alongside — never instead of —
 * the standing live feed REQ. The two sessions run on DISTINCT subIds (this one defaults to
 * `feed-neg`) so their EVENT/EOSE/pendingSubs bookkeeping never collides with the live REQ's
 * `feed` subId. Any error (NEG-ERR, a relay without NIP-77, a parse failure, or timeout) silently
 * falls back to a normal feed REQ (on this SAME subId) built from `fallbackFilter`, so this can
 * never regress existing sync — it only ever adds coverage on top of the live REQ.
 */
/**
 * On-device reconciliation diagnostics emitted once per completed (or fell-back) NIP-77 round via
 * {@link NegentropySyncOptions.onReconciled}. PURELY LOCAL: this is never serialized to the relay —
 * it feeds a debug ring buffer (syncStats.ts) and a local diagnostics screen only. The relay stays
 * author/content-blind; nothing here leaves the device.
 */
export interface ReconcileStats {
  /** The reconciliation subId this round ran on (e.g. 'feed-neg'). */
  subId: string;
  /** NEG-MSG rounds driven this session (excludes the opening NEG-OPEN). */
  rounds: number;
  /** Wall-clock ms from NEG-OPEN to the terminal round (completion or fallback). */
  wallMs: number;
  /** Missing-id delta the relay has that we don't (fetched after this round). */
  need: number;
  /** Ids we hold that the relay didn't, observed across the session (diagnostic only). */
  have: number;
  /** Total outbound negentropy frame bytes sent (initiate + every NEG-MSG reply). */
  frameBytesOut: number;
  /** True when the round abandoned reconciliation and fell back to a legacy REQ. */
  fellBack: boolean;
  /** Wall-clock timestamp (ms) the stat was emitted. */
  at: number;
}

export interface NegentropySyncOptions {
  /**
   * Sub id for the reconciliation session and its fallback REQ. Defaults to 'feed-neg' — kept
   * distinct from the live feed REQ's 'feed' subId (subscriptionPlan.ts) on purpose, so the two
   * concurrent sessions' EVENT/EOSE/pendingSubs bookkeeping can never collide.
   */
  subId?: string;
  /**
   * Filter describing the feed window to reconcile. A factory is preferred so a cold cache can
   * use a bounded `limit`, while later rounds use the current incremental `since` window.
   */
  filter: ReqFilter | (() => ReqFilter);
  /**
   * Snapshot of locally-cached {id, timestamp} inside the resolved reconciliation filter.
   * The resolved filter is passed in so both sides reconcile the same bounded window.
   */
  getItems: (filter: ReqFilter) => NegItem[];
  /** The legacy incremental feed REQ to fall back to on any reconciliation error. */
  fallbackFilter: () => ReqFilter;
  /** Outbound frame-size cap in bytes (0 = unlimited). */
  frameSizeLimit?: number;
  /**
   * Initiator range fan-out for the negentropy split heuristic (local tuning knob, wire-compatible).
   * Integer in [2,256]; when absent the engine's default (16) is used — byte-identical to legacy.
   * A higher value trades larger frames for fewer Tor round-trips (T10 Tor sync tuning).
   */
  buckets?: number;
  /** Abort reconciliation and fall back after this many ms. */
  timeoutMs?: number;
  /**
   * Fires once per terminal reconciliation round (completion OR fallback) with on-device diagnostics
   * ({@link ReconcileStats}). OPTIONAL and best-effort: when unset, sync behavior is byte-identical;
   * when set, a throwing consumer is swallowed so it can never break reconciliation. NEVER published
   * to the relay — intended only for a local ring buffer / debug screen (syncStats.ts).
   */
  onReconciled?: (stats: ReconcileStats) => void;
}

/** A single REQ to open on (re)connect: a subscription id and its NIP-01 filter. */
export interface Subscription {
  subId: string;
  filter: ReqFilter;
  /**
   * Page older stored history through short-lived companion subscriptions instead of allowing
   * one REQ to flood the JS thread. The root subscription remains open for live events.
   */
  pagination?: {
    pageSize: number;
    delayMs?: number;
  };
}

/**
 * Builds the set of subscriptions to open each time the socket connects. Called fresh on
 * every open so it can read the current high-water mark (incremental `since`) and rotate
 * cover-traffic decoys. The default plan asks for the configured kinds incrementally; the
 * production app injects a plan that splits the feed from a scoped+decoyed DM request.
 */
export type SubscriptionPlan = () => Subscription[];

export interface RelayClientOptions {
  subId?: string;
  kinds?: number[];
  /** Override for tests; defaults to real NIP-01 signature verification. */
  verify?: (event: Event) => boolean;
  limit?: number;
  /**
   * Seconds to subtract from the cache high-water mark when computing the incremental
   * `since`, absorbing relay receive-lag and clock skew. Re-sent events dedupe on id.
   */
  overlapSeconds?: number;
  /** Override the default subscription plan (e.g. split feed + hybrid DM). */
  plan?: SubscriptionPlan;
  /** Publish acknowledgement timeout (ms). */
  publishTimeoutMs?: number;
  /** Enable NIP-77 feed reconciliation (with automatic fallback). Absent = legacy sync. */
  negentropy?: NegentropySyncOptions;
  /**
   * Process at most this many inbound relay frames per macrotask. Zero (the default) preserves
   * synchronous behaviour for tests; production enables it so touch handling can run during sync.
   */
  inboundBatchSize?: number;
  /**
   * @deprecated No longer read by `drainInboundQueue`, which now caps its per-tick JS time against
   * the cross-client `sharedInboundBudget` (I3) instead of a fixed slice per client — the previous
   * mechanism this option configured let N simultaneously-live RelayClients (primary + mirrors)
   * each spend a full slice in the same wall-clock window. Still accepted (and clamped) for
   * call-site/back-compat; has no effect on drain pacing.
   */
  inboundTimeSliceMs?: number;
  /**
   * The relay's advertised allow-list (`caps.allowedKinds`). A GETTER because caps are negotiated
   * once per (re)connect, after this client is built. Used only to WARN (never reject) when an event
   * of an accepted kind isn't in the relay's advertised allow-list (C6). Absent / caps fallback → no
   * warning; ingest accept/reject is unchanged.
   */
  getAllowedKinds?: () => readonly number[];
  /**
   * Fires once per event that passes ingest (verified + accepted, whether newly stored or an
   * already-known dupe), from inside the SAME paced inbound-drain loop that ingests it — never a
   * separate scheduler. Intended for a cheap, fire-and-forget cache warmup (e.g. the blind
   * attribution resolver) so a later synchronous consumer (buildFeed) hits a warm cache instead of
   * doing expensive per-event work inside one macrotask. The transport layer never calls into
   * attribution/identity code itself — this hook is the ONLY seam, injected by the owner that wires
   * RelayClient up, keeping this module free of any blind/* import.
   */
  onIngestEvent?: (event: Event) => void;
}

/** Relay response to a published event (the OK frame). */
/**
 * Sentinel `message` for a publish that never got an OK frame back before the timer fired. The
 * outbox treats this as an AMBIGUOUS failure (retry on reconnect), distinct from a relay OK frame
 * carrying accepted=false — a genuine rejection that must NOT be auto-resent. Exported so the outbox
 * consumer (AppRuntime.deliver) can tell the two apart without string-coupling to a bare literal.
 */
export const PUBLISH_TIMEOUT_MESSAGE = 'timeout';

export interface PublishResult {
  accepted: boolean;
  message: string;
  /**
   * The write was neither accepted nor rejected — it never reached a relay (e.g. a dedicated
   * publish circuit couldn't be built, or the isolated socket dropped before its OK). The caller
   * keeps such an event queued and re-delivers it on reconnect instead of marking it failed.
   */
  offline?: boolean;
}

/**
 * A relay OK-frame rejection reason (`OK(accepted=false, message)`), classified for the outbox's
 * retry policy (C3). `code` is the NIP-01 machine-readable prefix (the text before the first `:`,
 * e.g. `blocked`, `invalid`, `rate-limited`); `retryable` decides whether re-sending the SAME signed
 * event could ever succeed.
 */
export interface RejectionClass {
  code: string;
  retryable: boolean;
}

/**
 * Classify a relay OK-frame rejection `message` into `{code, retryable}` (C3). Delegates to the pure
 * {@link parseRejection} / {@link legacyRetryable} substrate in `./rejection`:
 *   • `code` is the authoritative bracket code (`[token_required] …` → `token_required`), falling
 *     back to the legacy bare `code:` prose prefix (`blocked:`/`invalid:`/`auth-required:`/…), or
 *     `'unknown'` when the reason carries neither. This is what lets handleSubError still detect
 *     bracket-less `auth-required:`/`restricted:` CLOSED frames.
 *   • `retryable` is the legacy prose heuristic — a permanent prefix (blocked/invalid/auth/restricted/
 *     pow) → false, a known-transient class/code → true, an unclassified reason → false (the B1 win:
 *     it stays terminal and is never infinitely re-uploaded over Tor).
 *
 * The retry DECISION stays on this legacy heuristic here so the outbox path is unchanged pre-flip; the
 * machine-code-trusting decision (via {@link isRetryable}) is gated separately in AppRuntime.deliver.
 * Parsing the `[code]` bracket for the RETURNED `code` is an unconditional correctness fix.
 */
export function classifyRejection(message: string): RejectionClass {
  return {code: parseRejection(message).code || 'unknown', retryable: legacyRetryable(message)};
}

/**
 * A transport that can spin up a fresh, circuit-isolated sibling socket for a single blind-post
 * publish (see torSocket's IsolatingRelaySocket). Detected by duck-typing so RelayClient stays free
 * of any concrete transport import and remains testable with a plain fake socket. When the injected
 * socket does NOT provide this, blind posts publish on the shared socket exactly as before.
 */
interface PublishCircuitProvider {
  openPublishCircuit(): RelaySocket | null;
}

function hasPublishCircuit(socket: RelaySocket): socket is RelaySocket & PublishCircuitProvider {
  return typeof (socket as Partial<PublishCircuitProvider>).openPublishCircuit === 'function';
}

/**
 * A blind post carries an anti-spam `stiq_token` tag and is signed by a throwaway key. These — and
 * only these — must not share a Tor circuit with this socket's identity-scoped REQs (finding #1).
 */
function isBlindPublish(event: Event): boolean {
  return event.tags.some(t => t[0] === TAG_TOKEN && !!t[1]);
}

/**
 * A DM gift wrap (kind 1059) carries no `stiq_token` tag under default config, so isBlindPublish()
 * alone never catches it — every DM's EVENT publish fell onto the shared identity socket, with none
 * of the dedicated-circuit fast-retry treatment a blind post gets (finding #dms). Isolating it here
 * doesn't cost anything anonymity-wise either: the DM inbox REQ ('#p:[myNpub]') already rides the
 * shared socket, so moving just the WRITE off it is a strict improvement, the same reasoning that
 * motivates isBlindPublish in the first place.
 */
function isDmPublish(event: Event): boolean {
  return event.kind === Kind.GiftWrap;
}

const DEFAULT_PUBLISH_TIMEOUT_MS = 60_000;
/**
 * Total dedicated-circuit attempts for a blind publish before giving up and reporting `offline`
 * (queued for the next reconnect). Each attempt opens a BRAND NEW isolated circuit — never reuses a
 * failed one — so retrying never weakens the per-post unlinkability guarantee; it only spends more
 * of the timeout budget chasing a flaky Tor network instead of surrendering after a single miss.
 */
const MAX_PUBLISH_CIRCUIT_ATTEMPTS = 3;
/** Backoff before each fresh-circuit retry (attempt 2, then attempt 3) — short, since a warmed
 * circuit (torSocket's pool) usually resolves the very next attempt fast. */
const PUBLISH_RETRY_BACKOFF_MS: readonly number[] = [800, 1_500];
/**
 * Consecutive SHARED-socket publish timeouts (no OK, ambiguous), with no OK/EVENT activity landing in
 * between, before the shared socket is treated as suspect and force-closed (bounded stall detection —
 * finding #dms). A merely congested-but-alive circuit is never torn down by publishShared()'s own
 * timeout, the app's connection watchdog is one-shot and disarmed after the session's first sync, and
 * the native transport auto-answers server pings independent of the JS layer — so nothing else in this
 * codebase ever notices a stalled-but-not-dead shared socket. Closing it here hands recovery to the
 * SAME reconnect + outbox walk every other transport failure already gets. Requiring TWO consecutive
 * misses (not one) keeps a single slow-but-fine round-trip from ever tearing down a healthy socket.
 */
const SHARED_PUBLISH_STALL_STREAK = 2;
/**
 * Backoff before re-issuing a scoped-sub REQ (subscribeScoped) whose send failed synchronously —
 * the socket wasn't open at the exact instant a channel/group view opened. Short and bounded: this
 * covers only that same-tick socket-readiness race, not an offline retry — a genuine reconnect
 * already re-issues every open scoped sub via onSubscribed (resubscribeChannels/resubscribeGroups),
 * which is what heals a socket that's actually down for a while.
 */
const SCOPED_SUB_RETRY_BACKOFF_MS: readonly number[] = [250, 1_000];
/** Default incremental overlap: re-request the last 5 minutes to cover relay lag. */
const DEFAULT_OVERLAP_SECONDS = 300;
/**
 * Max ids per id-scoped fetch REQ. Bounds the outbound Tor frame size and lets a cold-cache
 * negentropy delta (potentially thousands of ids) drain as independent chunks instead of one
 * giant REQ that can't complete within the per-fetch cleanup window.
 */
const FETCH_CHUNK_SIZE = 25;
/** Briefly yield between missing-id chunks so rendering and touch dispatch get a turn. */
const FETCH_NEXT_CHUNK_DELAY_MS = 25;
/**
 * How long a one-shot fetch REQ (by id / by filter / older-page) waits for the relay before it
 * self-closes. This is the codebase's ONE on-demand-fetch deadline over Tor; a caller awaiting the
 * ARRIVAL of a fetched event (media/mediaBlobService.ts) must not give up before the REQ itself does,
 * or it would report a failure while the bytes were still in flight — so it is exported rather than
 * duplicated as a second, silently-drifting magic number.
 */
export const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_INBOUND_TIME_SLICE_MS = 8;
/**
 * Cap on cumulative raw-frame bytes processed in a single drainInboundQueue tick (I6). A handful
 * of large media events (each already ~200KB of base64, whose parse+verify+encrypted-INSERT alone
 * can run 30-50ms) must not all land in the same tick just because inboundBatchSize/the shared time
 * budget hadn't yet caught up — this ends the tick early once their combined size crosses the cap,
 * same as the existing `processed < inboundBatchSize` count cap, and composes with it (whichever
 * limit is hit first wins).
 */
const INBOUND_BYTE_CAP = 256 * 1_024;
const MAX_PAGINATION_PAGE_SIZE = 500;

interface PagedBackfillState {
  rootSubId: string;
  baseFilter: ReqFilter;
  pageSize: number;
  currentLimit: number;
  delayMs: number;
  pageIndex: number;
  currentSubId: string;
  currentUntil?: number;
  received: number;
  oldestCreatedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

type IngestResult = 'stored' | 'known' | 'rejected';

/**
 * Events accepted (deduped + verified) during ONE drainInboundQueue tick, held here instead of
 * stored immediately so the tick can flush them with a single saveNewBatch call at the end (M6)
 * instead of one autocommitting INSERT per event. `ids` lets ingestEvent recognize a duplicate id
 * arriving twice within the SAME tick — before it's durable, so `store.has()` alone can't see it
 * yet — and classify it as 'known' (skip verify, no double-store) exactly like an already-durable
 * duplicate.
 */
interface PendingIngestBatch {
  events: Event[];
  ids: Set<string>;
}

/**
 * Allowed-kinds lockstep check (C6): WARN — never reject — when any of the client's `subscribed`
 * kinds is absent from the relay's advertised `allowedKinds`, i.e. the client asks for / accepts a
 * kind the relay says it won't serve. A benign kind-list drift must not break the app, so this only
 * logs (via the leaf `log` facade). No-op when `allowedKinds` is empty (the relay advertised none) or
 * when every subscribed kind is allowed. SHIP-AHEAD SAFE: at caps fallback `allowedKinds` is the
 * client's own kind union (a superset of everything it subscribes to), so no drift is ever reported —
 * byte-identical to today's silence. `alreadyWarned`, when supplied, de-dupes so a hot path (per-event
 * ingest) warns each drifted kind at most once. Shared with subscriptionPlan's plan-time check.
 */
export function warnKindDrift(
  subscribed: readonly number[],
  allowedKinds: readonly number[],
  where: string,
  alreadyWarned?: Set<number>,
): void {
  if (allowedKinds.length === 0) return; // relay advertised no allow-list — nothing to check against
  const allowed = new Set(allowedKinds);
  const drift = subscribed.filter(k => !allowed.has(k) && !alreadyWarned?.has(k));
  if (drift.length === 0) return;
  if (alreadyWarned) for (const k of drift) alreadyWarned.add(k);
  log.warn('caps', `${where}: subscribed kind(s) not in relay allow-list: ${drift.join(',')}`);
}

/** Bounds for the fetchedIds/fetchedFilters dedupe Sets (see addBoundedDedupe below). */
const DEDUPE_SET_CAP = 4096;
const DEDUPE_SET_EVICT_BATCH = 512;

/**
 * Add `value` to a de-dupe Set, evicting the oldest entries once it grows past its cap. Sets
 * iterate in insertion order, so the front of the iterator is always the oldest entry — this
 * keeps `fetchedIds`/`fetchedFilters` from growing unbounded over a long-lived session (a busy
 * feed can accumulate far more quoted/naddr ids than any one session will ever re-request).
 */
function addBoundedDedupe(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size <= DEDUPE_SET_CAP) {
    return;
  }
  let toEvict = DEDUPE_SET_EVICT_BATCH;
  for (const oldest of set) {
    if (toEvict <= 0) break;
    set.delete(oldest);
    toEvict--;
  }
}

/**
 * Order-insensitive dedupe key for a fetchByFilter call. Plain `JSON.stringify(filters)` treats
 * two logically-identical filter objects as different requests whenever their keys were built in
 * a different order, or one carries an explicit `undefined` field the other omits — a real gap
 * (two call sites building the "same" `{kinds, authors, '#d'}` filter object in different field
 * order would silently defeat the dedupe and double-request). Recursing key-sort into nested
 * values only reorders object KEYS; array element order (kinds/authors/ids/tag lists) is left
 * exactly as given, since callers may reasonably build those in a meaningful order.
 */
function stableFilterKey(filters: ReqFilter[]): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue; // an explicit `undefined` field must dedupe like an omitted one
        sorted[k] = sortKeys(v);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortKeys(filters));
}

export class RelayClient {
  private readonly subId: string;
  private readonly kinds: number[];
  /** Live getter for the relay's advertised allow-list (C6 drift warning); undefined = no check. */
  private readonly getAllowedKinds?: () => readonly number[];
  /** Fire-and-forget cache-warmup hook, called once per event that passes ingest. See options doc. */
  private readonly onIngestEvent?: (event: Event) => void;
  /** Kinds already warned about as allow-list drift, so the per-event hot path warns each once. */
  private readonly warnedDriftKinds = new Set<number>();
  private readonly verify: (event: Event) => boolean;
  private readonly limit?: number;
  private readonly overlapSeconds: number;
  private readonly plan: SubscriptionPlan;
  private readonly eventListeners = new Set<(event: Event) => void>();
  private readonly seenListeners = new Set<(event: Event) => void>();
  private readonly syncListeners = new Set<() => void>();
  /** Fires after every (re)connect's sendSubscribe() — the ONLY moment a scoped sub can be
   *  (re)opened and survive, since sendSubscribe resets knownSubIds to the plan's subs. */
  private readonly subscribedListeners = new Set<() => void>();
  /** Fires when the relay CLOSEs a subscription (e.g. `auth-required:`/`restricted:`). */
  private readonly subErrorListeners = new Set<(err: {subId: string; message: string}) => void>();
  /** Fires on the EOSE of a caller-named SCOPED subscription (subscribeScoped) — "this channel/
   *  group's stored history has fully replayed". Phase 5 stale-first: the UI uses this to stop
   *  treating an empty message list as still-loading (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md). */
  private readonly scopedEoseListeners = new Set<(subId: string) => void>();
  /** Fires for every relay NOTICE frame (NIP-01) — never silently dropped. */
  private readonly noticeListeners = new Set<(message: string) => void>();
  private readonly pendingPublishes = new Map<string, (result: PublishResult) => void>();
  /** Bounded stall detection (see {@link SHARED_PUBLISH_STALL_STREAK}): consecutive publishShared()
   *  timeouts with no intervening OK/EVENT frame on this socket. Reset by noteSharedSocketActivity(). */
  private sharedPublishStallStreak = 0;
  private readonly pendingCounts = new Map<string, (count: number) => void>();
  private countSeq = 0;
  /** One-off id-scoped fetches (e.g. quoted posts). subId → cleanup. */
  private readonly fetchSubs = new Map<string, () => void>();
  private fetchSeq = 0;
  /** fetchByFilter subId → whether a genuinely matching event has arrived on it yet, so cleanup
   *  can tell a real result apart from an empty timeout (see fetchByFilter's un-blacklist). */
  private readonly fetchFilterMatches = new Map<string, {value: boolean}>();
  /** Missing-id chunks drain one at a time; opening all chunks together recreates a firehose. */
  private readonly fetchQueue: string[][] = [];
  private activeIdFetchSubId?: string;
  /** Ids already fetched/in-flight so we don't re-request the same quoted post. */
  private readonly fetchedIds = new Set<string>();
  /** Filter keys already fetched/in-flight so we don't re-request the same addressable (naddr). */
  private readonly fetchedFilters = new Set<string>();
  private readonly publishTimeoutMs: number;
  private readonly inboundBatchSize: number;
  private readonly inboundTimeSliceMs: number;
  private readonly inboundQueue: string[] = [];
  private inboundHead = 0;
  private inboundTimer?: ReturnType<typeof setTimeout>;
  /**
   * Frames dropped because processing them threw (malformed shape past the protocol parser, a
   * throwing verify()/listener, etc.). The socket/session and the inbound drain loop are never
   * killed by a bad frame — it's counted here and skipped so later valid frames still ingest.
   */
  private droppedFrames = 0;
  /** Sub ids opened by the last plan (used to route EVENT/EOSE for any of them). */
  private knownSubIds = new Set<string>();
  /** Pending backoff retries for a scoped-sub REQ whose send failed. subId → timer, so a fresh
   *  subscribeScoped/closeSub call for the same subId cancels a stale retry instead of resending a
   *  stale filter or resurrecting a sub the caller already closed (see subscribeScoped). */
  private readonly scopedSubRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sub ids still awaiting their EOSE; synced once empty. */
  private pendingSubs = new Set<string>();
  /** Root/page sub ids point to their shared historical pagination state. */
  private readonly pagedSubs = new Map<string, PagedBackfillState>();
  /** requestOlder's in-flight guard: surface `subKey` -> the subId currently paging it. */
  private readonly olderPageInFlight = new Map<string, string>();
  private olderPageSeq = 0;
  private synced = false;

  // ── NIP-77 feed reconciliation (optional; falls back to a normal feed REQ on any error) ──
  private readonly negOptions?: NegentropySyncOptions;
  private readonly negSubId: string;
  private readonly negTimeoutMs: number;
  private neg: Negentropy | null = null;
  private negActive = false;
  private negNeed: string[] = [];
  /** Keep the NIP-77 sync slot pending until its sequential missing-id queue has drained. */
  private negFetchPending = false;
  private negTimer?: ReturnType<typeof setTimeout>;
  // ── On-device reconciliation instrumentation (T10-S3) — fed to onReconciled; never published. ──
  /** NEG-MSG rounds driven this session (reset each startNegentropy). */
  private negRounds = 0;
  /** Date.now() at NEG-OPEN, for the wall-time measurement. */
  private negStartMs = 0;
  /** Total outbound negentropy frame bytes this session (initiate + every NEG-MSG reply). */
  private negFrameBytesOut = 0;
  /** Ids we hold that the relay lacked, observed across this session (diagnostic only). */
  private negHaveCount = 0;

  // ── Manual pull-to-refresh resync (separate from the connection-level initial sync) ──
  /** Resolver for an in-flight resyncFeed() round; cleared (and called) when the round settles. */
  private resyncResolve?: () => void;
  /** Watchdog so a stalled resync round still resolves and releases the spinner. */
  private resyncTimer?: ReturnType<typeof setTimeout>;
  /** When the legacy (non-negentropy) resync REQ is in flight, the sub id awaiting its EOSE. */
  private resyncEoseSubId?: string;
  private resyncSeq = 0;

  constructor(
    private readonly socket: RelaySocket,
    private readonly store: EventStore,
    options: RelayClientOptions = {},
  ) {
    this.subId = options.subId ?? 'feed';
    this.kinds = options.kinds ?? SUBSCRIBED_KINDS;
    this.getAllowedKinds = options.getAllowedKinds;
    this.onIngestEvent = options.onIngestEvent;
    this.verify = options.verify ?? verifyEvent;
    this.limit = options.limit;
    this.overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
    this.plan = options.plan ?? (() => this.defaultPlan());
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.inboundBatchSize = Math.max(0, Math.trunc(options.inboundBatchSize ?? 0));
    this.inboundTimeSliceMs = Math.max(
      1,
      Math.trunc(options.inboundTimeSliceMs ?? DEFAULT_INBOUND_TIME_SLICE_MS),
    );
    this.negOptions = options.negentropy;
    this.negSubId = options.negentropy?.subId ?? 'feed-neg';
    this.negTimeoutMs = options.negentropy?.timeoutMs ?? 30_000;
    this.socket.onOpen(() => this.sendSubscribe());
    this.socket.onMessage(data => this.receiveMessage(data));
  }

  /**
   * Incremental `since` for the given kinds: the newest cached `created_at` minus the
   * overlap, or undefined for a cold cache (so the first sync is bounded by `limit`
   * instead). Re-requested events within the overlap window dedupe on id.
   */
  incrementalSince(kinds: number[]): number | undefined {
    const latest = this.store.latestCreatedAt(kinds);
    if (latest === undefined) {
      return undefined;
    }
    return Math.max(0, latest - this.overlapSeconds);
  }

  /** Single incremental subscription over the configured kinds. */
  private defaultPlan(): Subscription[] {
    const filter: ReqFilter = {kinds: this.kinds};
    const since = this.incrementalSince(this.kinds);
    if (since !== undefined) {
      filter.since = since;
    }
    if (this.limit != null) {
      filter.limit = this.limit;
    }
    return [{subId: this.subId, filter}];
  }

  /**
   * Publish an event to the relay and resolve with its OK frame. On acceptance the event is also
   * cached locally so the feed updates immediately.
   *
   * A BLIND post (throwaway-signed, `stiq_token`-tagged) or a DM gift wrap (kind 1059, finding #dms)
   * is routed over a DEDICATED Tor circuit when the injected socket supports it (anonymity finding
   * #1): its EVENT must never share a circuit with this socket's identity-scoped REQs, or the relay
   * could correlate the write to the real npub — and, for a DM, this also earns it the isolated path's
   * fast bounded fresh-circuit retry (publishIsolated) instead of one 60s shared-socket wait with no
   * local retry at all. Everything else — normal npub-signed writes, and either of the above on a
   * transport without circuit isolation (tests / isolation disabled) — publishes on the shared socket
   * exactly as before.
   */
  publish(event: Event): Promise<PublishResult> {
    if ((isBlindPublish(event) || isDmPublish(event)) && hasPublishCircuit(this.socket)) {
      return this.publishIsolated(event, this.socket);
    }
    return this.publishShared(event);
  }

  /** Publish on the long-lived shared socket (the historical path). */
  private publishShared(event: Event): Promise<PublishResult> {
    return new Promise<PublishResult>(resolve => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        this.noteSharedPublishTimeout();
        resolve({accepted: false, message: PUBLISH_TIMEOUT_MESSAGE});
      }, this.publishTimeoutMs);

      this.pendingPublishes.set(event.id, result => {
        clearTimeout(timer);
        if (result.accepted) {
          this.ingest(event); // optimistic local cache update
        }
        resolve(result);
      });
      this.socket.send(eventMessage(event));
    });
  }

  /**
   * Bounded stall detection (see {@link SHARED_PUBLISH_STALL_STREAK}): count this ambiguous timeout
   * and, once two land back-to-back with no OK/EVENT frame in between, force-close the shared socket.
   * The close is the ONLY thing that matters here — App.tsx's `socket.onClose(onRelayDown)` already
   * drives the reconnect + backoff cascade, and `onRelayConnected` already re-delivers every unsent
   * outbox entry (including 'failed') once the new connection is up, so this is all that's needed to
   * turn "stalled forever" into "bounded by one extra reconnect".
   */
  private noteSharedPublishTimeout(): void {
    this.sharedPublishStallStreak++;
    if (this.sharedPublishStallStreak < SHARED_PUBLISH_STALL_STREAK) return;
    this.sharedPublishStallStreak = 0; // this close is about to tear the socket (and this streak) down
    try {
      this.socket.close();
    } catch {
      /* already closing/closed */
    }
  }

  /** Any OK/EVENT frame proves the shared socket is still answering — clears the stall streak so only
   *  a genuinely repeated run of timeouts, with nothing landing in between, is ever treated as suspect. */
  private noteSharedSocketActivity(): void {
    this.sharedPublishStallStreak = 0;
  }

  /**
   * Publish a blind post over a fresh, circuit-isolated sibling socket, retrying on a BRAND NEW
   * circuit up to {@link MAX_PUBLISH_CIRCUIT_ATTEMPTS} times when an attempt fails TRANSIENTLY (no
   * circuit could be built, the attempt timed out with no OK, or the sibling closed before the OK) —
   * a single cold onion rendezvous under a flaky Tor network is exactly the "posts not posting
   * anywhere" failure mode this guards against. Each retry opens an entirely new sibling (its own
   * socketId ⇒ its own SOCKS credential ⇒ its own Tor circuit), so unlinkability is unaffected by
   * retrying — it is never the SAME circuit reused. A genuine relay REJECTION (an OK frame with
   * accepted=false) is TERMINAL: it is surfaced as-is on the first attempt and never retried, since
   * re-sending the exact same signed event just earns the exact same "no". Only after every attempt
   * has failed transiently does this give up and report `offline` (queued + retried on the next
   * reconnect) — a blind post must NEVER fall back onto the shared identity socket.
   */
  private publishIsolated(
    event: Event,
    provider: PublishCircuitProvider,
    attempt = 0,
  ): Promise<PublishResult> {
    return this.publishIsolatedOnce(event, provider).then(result => {
      if (result.accepted || !result.offline) {
        return result; // accepted, or a terminal (non-offline) relay rejection — never retried
      }
      if (attempt + 1 >= MAX_PUBLISH_CIRCUIT_ATTEMPTS) {
        return result; // every attempt missed — stay queued for the next reconnect, as before
      }
      const backoffMs =
        PUBLISH_RETRY_BACKOFF_MS[attempt] ?? PUBLISH_RETRY_BACKOFF_MS[PUBLISH_RETRY_BACKOFF_MS.length - 1]!;
      return new Promise<PublishResult>(resolve => {
        const timer = setTimeout(
          () => resolve(this.publishIsolated(event, provider, attempt + 1)),
          backoffMs,
        );
        (timer as {unref?: () => void}).unref?.();
      });
    });
  }

  /** Single dedicated-circuit publish attempt — opens ONE fresh sibling, publishes, and closes it. */
  private publishIsolatedOnce(event: Event, provider: PublishCircuitProvider): Promise<PublishResult> {
    let sibling: RelaySocket | null;
    try {
      sibling = provider.openPublishCircuit();
    } catch {
      sibling = null;
    }
    if (!sibling) {
      // No dedicated circuit right now (Tor momentarily offline). Keep the post queued; onRelayConnected
      // re-delivers it, which opens a fresh sibling then. Never leak it onto the shared socket.
      return Promise.resolve({accepted: false, message: 'publish circuit unavailable', offline: true});
    }
    const circuit = sibling;
    return new Promise<PublishResult>(resolve => {
      let settled = false;
      const finish = (result: PublishResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          circuit.close();
        } catch {
          /* already closed */
        }
        if (result.accepted) {
          this.ingest(event); // optimistic local cache update, same as the shared path
        }
        resolve(result);
      };
      const timer = setTimeout(
        // A fresh onion rendezvous per blind post can be slow; treat a no-OK timeout as a transient
        // miss to retry (offline), not a hard failure, matching the app's "queued while connecting"
        // handling rather than flashing a misleading "failed" badge.
        () => finish({accepted: false, message: PUBLISH_TIMEOUT_MESSAGE, offline: true}),
        this.publishTimeoutMs,
      );
      (timer as {unref?: () => void}).unref?.();
      circuit.onMessage(raw => {
        const msg = parseRelayMessage(raw);
        if (msg.type === 'OK' && msg.id === event.id) {
          finish({accepted: msg.accepted, message: msg.message});
        }
      });
      // A dead circuit before the OK is transient — queue + retry on a fresh one.
      circuit.onClose(() => finish({accepted: false, message: 'publish circuit closed', offline: true}));
      circuit.onOpen(() => {
        try {
          circuit.send(eventMessage(event));
        } catch {
          finish({accepted: false, message: 'publish circuit send failed', offline: true});
        }
      });
    });
  }

  /**
   * NIP-45 COUNT: ask the relay to tally events matching `filter` (e.g. comments/reactions on a
   * post) without pulling the raw events — a bandwidth/battery win over Tor. Resolves null on
   * timeout or if the relay doesn't support COUNT (no reply).
   */
  count(filter: ReqFilter, timeoutMs = this.publishTimeoutMs): Promise<number | null> {
    const subId = `count:${this.countSeq++}`;
    return new Promise<number | null>(resolve => {
      const timer = setTimeout(() => {
        this.pendingCounts.delete(subId);
        resolve(null);
      }, timeoutMs);
      this.pendingCounts.set(subId, n => {
        clearTimeout(timer);
        resolve(n);
      });
      this.socket.send(countMessage(subId, [filter]));
    });
  }

  /**
   * Open a long-lived, caller-named scoped subscription (e.g. a NIP-29 group's chat + state).
   * Events ingest into the store like any other; the sub stays open until closeSub or reconnect.
   * Filters must be relay-acceptable (group queries must be scoped by #h/#d/authors/ids).
   *
   * A send that fails synchronously (the socket isn't open at this exact instant — e.g. a channel
   * view mounts while Tor is still settling) is retried a few times under the SAME subId on a short
   * backoff (SCOPED_SUB_RETRY_BACKOFF_MS) rather than just being dropped. A genuine reconnect still
   * re-issues every open scoped sub via onSubscribed (resubscribeChannels/resubscribeGroups) — that
   * self-heals a socket that's down for a while — but it never fires again for a socket that stays
   * "nominally up" without a fresh open/close cycle, which is exactly the case this covers: without
   * it, a subscribeScoped call that raced the socket wouldn't be retried until the NEXT real
   * reconnect, which may never come while the caller is still on that channel/group view.
   */
  subscribeScoped(subId: string, filters: ReqFilter[]): void {
    this.subscribeScopedAttempt(subId, filters, 0);
  }

  private subscribeScopedAttempt(subId: string, filters: ReqFilter[], attempt: number): void {
    this.cancelScopedSubRetry(subId);
    this.knownSubIds.add(subId);
    try {
      this.socket.send(reqMessage(subId, filters));
    } catch {
      this.knownSubIds.delete(subId);
      if (attempt >= SCOPED_SUB_RETRY_BACKOFF_MS.length) return; // a genuine reconnect will still re-issue it
      const delay = SCOPED_SUB_RETRY_BACKOFF_MS[attempt]!;
      const timer = setTimeout(() => {
        this.scopedSubRetries.delete(subId);
        this.subscribeScopedAttempt(subId, filters, attempt + 1);
      }, delay);
      (timer as unknown as {unref?: () => void}).unref?.();
      this.scopedSubRetries.set(subId, timer);
    }
  }

  private cancelScopedSubRetry(subId: string): void {
    const timer = this.scopedSubRetries.get(subId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.scopedSubRetries.delete(subId);
  }

  /** Close a subscription opened with subscribeScoped. */
  closeSub(subId: string): void {
    this.cancelScopedSubRetry(subId);
    if (!this.knownSubIds.delete(subId)) return;
    try { this.socket.send(closeMessage(subId)); } catch { /* socket gone */ }
  }

  /**
   * Fetch specific events by id (e.g. a quoted post / NIP-18 embed not in the cache, or the
   * missing-id delta from a NIP-77 reconciliation). Opens short, id-scoped REQs; matching events
   * ingest into the store and each sub closes on EOSE. No-ops for ids already requested this session.
   *
   * The need-list is CHUNKED (a cold-cache reconciliation can produce hundreds-to-thousands of ids,
   * and one giant `{ids:[…]}` REQ frame both bloats a single Tor frame and can't drain within the
   * cleanup window). Each chunk gets its own sub + timeout and drains sequentially, so one delta
   * cannot recreate the same event storm as the original giant request.
   *
   * Un-blacklist on cleanup: an id is added to fetchedIds up front (so re-renders don't re-request an
   * in-flight id), but at cleanup any requested id whose event never actually arrived (`!store.has`)
   * is REMOVED from fetchedIds. Otherwise a backlog truncated by the timeout over a slow Tor circuit
   * would be blacklisted for the whole session — every later reconnect recomputes it as "need" but
   * fetchById silently skips it, so the missing feed content never arrives until an app restart. Now
   * the next connect/resync re-requests exactly the ids that didn't make it.
   */
  fetchById(ids: string[]): void {
    const want = ids.filter(id => id && !this.fetchedIds.has(id));
    if (want.length === 0) return;
    for (let i = 0; i < want.length; i += FETCH_CHUNK_SIZE) {
      const chunk = want.slice(i, i + FETCH_CHUNK_SIZE);
      for (const id of chunk) addBoundedDedupe(this.fetchedIds, id);
      this.fetchQueue.push(chunk);
    }
    this.pumpFetchQueue();
  }

  /** Open the next id-scoped chunk only after the prior chunk reached EOSE/timeout. */
  private pumpFetchQueue(): void {
    if (this.activeIdFetchSubId !== undefined) return;
    const want = this.fetchQueue.shift();
    if (!want) return;
    const subId = `fetch:${this.fetchSeq++}`;
    this.activeIdFetchSubId = subId;
    this.knownSubIds.add(subId);
    const cleanup = (): void => {
      if (!this.fetchSubs.delete(subId)) return;
      this.knownSubIds.delete(subId);
      // Retry-on-next-connect: drop ids that never ingested so they aren't blacklisted for the session.
      for (const id of want) {
        if (!this.store.has(id)) this.fetchedIds.delete(id);
      }
      try { this.socket.send(closeMessage(subId)); } catch { /* socket gone */ }
      if (this.activeIdFetchSubId === subId) {
        this.activeIdFetchSubId = undefined;
        if (this.fetchQueue.length === 0) {
          this.completeNegentropyFetch();
        } else {
          const timer = setTimeout(() => this.pumpFetchQueue(), FETCH_NEXT_CHUNK_DELAY_MS);
          (timer as {unref?: () => void}).unref?.();
        }
      }
    };
    this.fetchSubs.set(subId, cleanup);
    const timer = setTimeout(cleanup, FETCH_TIMEOUT_MS);
    (timer as {unref?: () => void}).unref?.();
    try {
      this.socket.send(reqMessage(subId, [{ids: want}]));
    } catch {
      cleanup();
    }
  }

  /**
   * Fetch events by arbitrary filter (e.g. a NIP-19 `naddr` addressable article, which has no
   * single id and must be queried by `{kinds, authors, '#d'}`). Like fetchById, this opens a
   * short one-shot REQ that ingests matches into the store and closes on EOSE (or a timeout).
   * De-duped on the (order-insensitive) serialized filter set, so re-rendering an unresolved
   * naddr embed is a no-op.
   *
   * Un-blacklist on cleanup: the key is added to `fetchedFilters` up front (so re-renders don't
   * re-request an in-flight filter), but at cleanup — EOSE, timeout, or a synchronous send throw —
   * it is REMOVED from `fetchedFilters` unless a genuinely matching event was actually ingested for
   * this sub. Otherwise a single failed attempt (a send that races a not-yet-open socket, or a
   * relay that never answers within FETCH_TIMEOUT_MS) would blacklist that coordinate for the rest
   * of the session — every later render/retry recomputes the same key and fetchByFilter silently
   * no-ops, so the content never arrives until an app restart. Mirrors fetchById/pumpFetchQueue's
   * own "drop ids that never ingested" cleanup above.
   */
  fetchByFilter(filters: ReqFilter[]): void {
    if (filters.length === 0) return;
    const key = stableFilterKey(filters);
    if (this.fetchedFilters.has(key)) return;
    addBoundedDedupe(this.fetchedFilters, key);
    const subId = `fetch:${this.fetchSeq++}`;
    this.knownSubIds.add(subId);
    const matched = {value: false};
    this.fetchFilterMatches.set(subId, matched);
    const cleanup = (): void => {
      if (!this.fetchSubs.delete(subId)) return;
      this.knownSubIds.delete(subId);
      this.fetchFilterMatches.delete(subId);
      if (!matched.value) this.fetchedFilters.delete(key);
      try { this.socket.send(closeMessage(subId)); } catch { /* socket gone */ }
    };
    this.fetchSubs.set(subId, cleanup);
    setTimeout(cleanup, FETCH_TIMEOUT_MS);
    try {
      this.socket.send(reqMessage(subId, filters));
    } catch {
      cleanup();
    }
  }

  /**
   * On-demand, one-shot older-history page shared by the feed/channel/group surfaces (bug #3's
   * scroll-back primitive): opens `{...filter, until, limit}` and lets ingest's `store.has(id)`
   * dedupe (ingestEvent) absorb any overlap with what's already cached. `subKey` names the SURFACE
   * being paged (e.g. `'feed'`, `` `channel:${coordinate}` ``, `` `group:${groupId}` ``) — while a
   * page for that subKey is already in flight, a second call is a no-op, so a doubled
   * onEndReached/scroll-trigger can't pile up duplicate REQs for the same surface. `filter` should
   * carry only the surface's own scoping (kinds/authors/#h/#a/etc.) — `until`/`limit` are applied
   * here.
   *
   * Reuses the `fetchSubs` bookkeeping/EOSE-cleanup machinery shared with fetchById/fetchByFilter
   * (no new message-routing branch needed): the sub self-closes on EOSE, or after a bounded
   * timeout if the relay never replies.
   */
  requestOlder(opts: {subKey: string; filter: ReqFilter; until: number; limit?: number}): void {
    if (this.olderPageInFlight.has(opts.subKey)) return;
    const limit = Math.max(1, Math.trunc(opts.limit ?? OLDER_PAGE_LIMIT));
    const subId = `older:${opts.subKey}:${this.olderPageSeq++}`;
    this.knownSubIds.add(subId);
    this.olderPageInFlight.set(opts.subKey, subId);
    const cleanup = (): void => {
      if (!this.fetchSubs.delete(subId)) return;
      this.knownSubIds.delete(subId);
      if (this.olderPageInFlight.get(opts.subKey) === subId) {
        this.olderPageInFlight.delete(opts.subKey);
      }
      try { this.socket.send(closeMessage(subId)); } catch { /* socket gone */ }
    };
    this.fetchSubs.set(subId, cleanup);
    const timer = setTimeout(cleanup, FETCH_TIMEOUT_MS);
    (timer as {unref?: () => void}).unref?.();
    try {
      this.socket.send(reqMessage(subId, [{...opts.filter, until: opts.until, limit}]));
    } catch {
      cleanup();
    }
  }

  private sendSubscribe(): void {
    const subs = this.plan();
    this.synced = false;
    this.clearNegentropy(); // drop any half-open session from a previous connection
    this.clearPagedBackfills();
    const subIds = subs.map(s => s.subId);
    // With NIP-77 enabled, a SEPARATE reconciliation session runs concurrently on `negSubId` —
    // the injected plan's live 'feed' REQ (subscriptionPlan.ts) is NOT omitted; it keeps streaming
    // new events on its own subId the whole time. `negSubId` still counts toward "synced" so
    // onSynced waits for it too.
    const useNeg = this.negOptions != null;
    const all = useNeg ? [...subIds, this.negSubId] : subIds;
    this.knownSubIds = new Set(all);
    this.pendingSubs = new Set(all);
    if (this.pendingSubs.size === 0) {
      this.markSynced();
      this.notifySubscribed();
      return;
    }
    for (const {subId, filter, pagination} of subs) {
      if (pagination) {
        const pageSize = Math.max(1, Math.trunc(pagination.pageSize));
        const boundedFilter = {...filter, limit: pageSize};
        this.pagedSubs.set(subId, {
          rootSubId: subId,
          baseFilter: boundedFilter,
          pageSize,
          currentLimit: pageSize,
          delayMs: Math.max(0, Math.trunc(pagination.delayMs ?? 50)),
          pageIndex: 0,
          currentSubId: subId,
          currentUntil: boundedFilter.until,
          received: 0,
        });
        this.socket.send(reqMessage(subId, [boundedFilter]));
      } else {
        this.socket.send(reqMessage(subId, [filter]));
      }
    }
    if (useNeg) {
      this.startNegentropy();
    }
    this.notifySubscribed();
  }

  /** The plan's REQs just went out on an OPEN socket and knownSubIds was reset — tell listeners so
   *  they can re-open their scoped subs (subscribeScoped) and have them actually stick. */
  private notifySubscribed(): void {
    for (const listener of this.subscribedListeners) {
      try {
        listener();
      } catch {
        // A throwing listener must not kill the others or the connection.
      }
    }
  }

  /** Open a NIP-77 reconciliation session for the feed. Falls back on any synchronous error. */
  private startNegentropy(): void {
    const opts = this.negOptions;
    if (!opts) return;
    this.negNeed = [];
    this.negActive = true;
    // Reset per-session instrumentation counters (T10-S3). onReconciled reads these at the terminal
    // round; on the flag-off path opts.onReconciled is undefined and nothing observes them.
    this.negRounds = 0;
    this.negStartMs = Date.now();
    this.negFrameBytesOut = 0;
    this.negHaveCount = 0;
    try {
      const filter = typeof opts.filter === 'function' ? opts.filter() : opts.filter;
      const storage = NegentropyStorage.fromItems(opts.getItems(filter));
      // Passing opts.buckets (possibly undefined) still applies the engine default (16) — a default
      // parameter fires on an explicit `undefined`, so flag-off is byte-identical.
      this.neg = new Negentropy(storage, opts.frameSizeLimit ?? 0, opts.buckets);
      const initiate = this.neg.initiate();
      this.negFrameBytesOut += initiate.length / 2; // hex string → bytes
      this.socket.send(negOpenMessage(this.negSubId, filter, initiate));
      this.negTimer = setTimeout(() => this.negFallback(), this.negTimeoutMs);
      // Don't let the fallback timer keep a Node process (tests) alive; no-op on RN.
      (this.negTimer as {unref?: () => void}).unref?.();
    } catch {
      this.negFallback();
    }
  }

  /** Drive one reconciliation round; finish (and fetch the delta) or send the next message. */
  private handleNegMsg(message: string): void {
    if (!this.neg) {
      return;
    }
    this.negRounds++; // count every inbound NEG-MSG we drive a reply for (T10-S3)
    try {
      const {output, need, have} = this.neg.reconcile(message);
      if (need.length > 0) {
        this.negNeed.push(...need);
      }
      this.negHaveCount += have.length;
      if (output === null) {
        this.finishNegentropy();
      } else {
        this.negFrameBytesOut += output.length / 2; // hex string → bytes
        this.socket.send(negMsgMessage(this.negSubId, output));
      }
    } catch {
      this.negFallback();
    }
  }

  /** Reconciliation complete: close the session, fetch the missing ids, mark the feed synced. */
  private finishNegentropy(): void {
    if (!this.negActive) {
      return;
    }
    this.negActive = false;
    this.negFetchPending = false;
    this.clearNegTimer();
    this.neg = null;
    // Emit diagnostics BEFORE negNeed is cleared below (need = this round's missing-id delta).
    this.emitReconcileStats(false, this.negNeed.length);
    try { this.socket.send(negCloseMessage(this.negSubId)); } catch { /* socket gone */ }
    if (this.negNeed.length > 0) {
      this.negFetchPending = true;
      this.fetchById(this.negNeed); // missing events stream in via sequential id-scoped REQs
      this.negNeed = [];
      this.completeNegentropyFetch(); // handles a need-list already fetched/in-flight elsewhere
    } else {
      this.completeNegentropySlot();
    }
  }

  private completeNegentropyFetch(): void {
    if (
      !this.negFetchPending ||
      this.activeIdFetchSubId !== undefined ||
      this.fetchQueue.length > 0
    ) {
      return;
    }
    this.negFetchPending = false;
    this.completeNegentropySlot();
  }

  private completeNegentropySlot(): void {
    if (this.pendingSubs.delete(this.negSubId) && this.pendingSubs.size === 0) {
      this.markSynced();
    }
    this.settleResync(); // a manual resync round (if any) is now complete
  }

  /**
   * Regression firewall: abandon reconciliation and sync the feed with the legacy incremental
   * REQ instead. The fallback REQ reuses `negSubId`, which is already in pendingSubs/knownSubIds,
   * so its EVENTs ingest and its EOSE drives markSynced — behaviour identical to legacy sync.
   */
  private negFallback(): void {
    if (!this.negActive) {
      return;
    }
    this.negActive = false;
    this.negFetchPending = false;
    this.clearNegTimer();
    this.neg = null;
    // Emit diagnostics for the fell-back round exactly once (guarded by the negActive flip above, so
    // the subsequent fallback-REQ EOSE never double-fires it) BEFORE negNeed is cleared.
    this.emitReconcileStats(true, this.negNeed.length);
    this.negNeed = [];
    const opts = this.negOptions;
    try {
      this.socket.send(negCloseMessage(this.negSubId)); // tidy any half-open session
      if (opts) {
        this.socket.send(reqMessage(this.negSubId, [opts.fallbackFilter()]));
        return; // negSubId stays pending until its EOSE arrives
      }
    } catch {
      /* socket gone — fall through to clear the pending slot */
    }
    // No fallback possible (no opts, or socket gone): don't hang "unsynced" forever.
    if (this.pendingSubs.delete(this.negSubId) && this.pendingSubs.size === 0) {
      this.markSynced();
    }
    this.settleResync(); // release a manual resync round if one was driving this session
  }

  private clearNegTimer(): void {
    if (this.negTimer !== undefined) {
      clearTimeout(this.negTimer);
      this.negTimer = undefined;
    }
  }

  private clearNegentropy(): void {
    this.negActive = false;
    this.negFetchPending = false;
    this.clearNegTimer();
    this.neg = null;
    this.negNeed = [];
  }

  /**
   * Emit on-device reconciliation diagnostics (T10-S3) to an optional consumer, once per terminal
   * round. No-op when no onReconciled is wired (flag-off is byte-identical). The callback is wrapped
   * in try/catch so a throwing diagnostics consumer can NEVER break the sync path — the round still
   * completes and the feed still marks synced.
   */
  private emitReconcileStats(fellBack: boolean, need: number): void {
    const cb = this.negOptions?.onReconciled;
    if (!cb) return;
    try {
      cb({
        subId: this.negSubId,
        rounds: this.negRounds,
        wallMs: Math.max(0, Date.now() - this.negStartMs),
        need,
        have: this.negHaveCount,
        frameBytesOut: this.negFrameBytesOut,
        fellBack,
        at: Date.now(),
      });
    } catch {
      /* a throwing diagnostics consumer must never disrupt reconciliation */
    }
  }

  /** Resolve an in-flight resyncFeed() promise (if any) exactly once and clear its watchdog. */
  private settleResync(): void {
    if (this.resyncTimer !== undefined) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    // Close the legacy resync REQ (if one is open) on BOTH normal completion AND watchdog timeout, so
    // a slow relay that EOSEs after the watchdog fired can't leave the sub open in knownSubIds forever
    // (each timed-out pull would otherwise leak one relay sub + ingest its EVENTs indefinitely).
    const eoseSub = this.resyncEoseSubId;
    this.resyncEoseSubId = undefined;
    if (eoseSub !== undefined) {
      this.knownSubIds.delete(eoseSub);
      try { this.socket.send(closeMessage(eoseSub)); } catch { /* socket gone */ }
    }
    const resolve = this.resyncResolve;
    this.resyncResolve = undefined;
    resolve?.();
  }

  /**
   * Manual pull-to-refresh: re-run the feed reconciliation against the relay NOW (independent of
   * the automatic open/reconnect sync), resolving when the round completes. With NIP-77 enabled it
   * re-opens a negentropy session on the feed sub and fetches the missing-id delta; otherwise it
   * re-issues the legacy incremental feed REQ and resolves on its EOSE. A watchdog guarantees the
   * promise always settles (so the spinner can't hang) even if the relay never replies.
   *
   * Coalesces: a resync requested while one is already in flight piggybacks on the same round.
   */
  resyncFeed(timeoutMs = 8_000): Promise<void> {
    // Already running — share the in-flight round rather than opening a second session.
    if (this.resyncResolve) {
      return new Promise<void>(resolve => {
        const prev = this.resyncResolve!;
        this.resyncResolve = () => { prev(); resolve(); };
      });
    }
    return new Promise<void>(resolve => {
      this.resyncResolve = resolve;
      // Watchdog: always release the spinner, even if the relay goes silent mid-round.
      this.resyncTimer = setTimeout(() => this.settleResync(), timeoutMs);
      (this.resyncTimer as {unref?: () => void}).unref?.();
      try {
        if (this.negOptions) {
          // NIP-77 path. If a reconciliation round is ALREADY in flight (initial-connect sync, a
          // reconnect sync, or a prior pull), piggyback on it: its finishNegentropy()/negFallback()
          // calls settleResync(), which resolves this promise. Starting a second round here would
          // re-open negSubId while the first is still live (double-open) and feed the first round's
          // NEG-MSG replies into a fresh Negentropy instance, corrupting/aborting it. Only kick off a
          // fresh round when none is active (a prior finished round already sent its NEG-CLOSE).
          if (!this.negActive && !this.negFetchPending) {
            // Re-add the feed slot for this manual round. Initial sync removed it from pendingSubs;
            // without restoring it, an error fallback's EOSE is ignored and the refresh spinner
            // waits for its watchdog despite the relay having completed normally.
            this.knownSubIds.add(this.negSubId);
            this.pendingSubs.add(this.negSubId);
            this.clearNegentropy();
            this.startNegentropy();
          }
        } else {
          // Legacy path (no negentropy configured for THIS connection — either the flag is off, or
          // the cache was cold at connect time, see the negentropy option doc): re-issue the feed
          // REQ under a fresh sub id and resolve on EOSE. Reuse the CURRENT plan's own 'feed' sub
          // filter — the same bounded/incremental shape the connection itself opened with (cold
          // `limit` or warm `since`) — rather than RelayClient's generic defaultPlan()/`kinds`
          // fallback, which an injected custom plan (e.g. the app's createFeedAndDmPlan) never
          // configures via the `kinds`/`limit` constructor options and would otherwise resync with
          // an unbounded, unscoped firehose REQ (this path became reachable on a cold-cache connect
          // once negentropy started gating on warm-only — a plain `this.plan()` call is cheap and
          // side-effect-free beyond its own memoized decoy-pool bookkeeping).
          const subId = `resync:${this.resyncSeq++}`;
          this.resyncEoseSubId = subId;
          this.knownSubIds.add(subId);
          const planFeed = this.plan().find(s => s.subId === 'feed')?.filter;
          const filter = planFeed ?? this.defaultPlan()[0]?.filter ?? {kinds: this.kinds};
          this.socket.send(reqMessage(subId, [filter]));
        }
      } catch {
        // Socket gone or send failed — release the spinner immediately.
        this.settleResync();
      }
    });
  }

  private markSynced(): void {
    if (this.synced) {
      return;
    }
    this.synced = true;
    for (const listener of this.syncListeners) {
      listener();
    }
  }

  /**
   * The relay CLOSED a subscription outright — e.g. NIP-42 `auth-required:`/`restricted:`, or any
   * other relay-side refusal — instead of ever sending it an EOSE. Clean up exactly like that sub
   * reached a normal EOSE/CLOSE round-trip (same knownSubIds/pendingSubs bookkeeping as the EOSE
   * branch above) so a hard CLOSED can never leave onSynced waiting forever on a sub that will now
   * never reply. The reason is surfaced as a structured sub-error; wiring a consumer (e.g. AppRuntime
   * prompting re-auth on `auth-required:`) is a follow-up — this only guarantees it's observable.
   */
  private handleClosed(subId: string, message: string): void {
    this.knownSubIds.delete(subId);
    if (this.pendingSubs.delete(subId) && this.pendingSubs.size === 0) {
      this.markSynced();
    }
    for (const listener of this.subErrorListeners) {
      listener({subId, message});
    }
  }

  /** NIP-01 NOTICE: a human-readable relay message not tied to any subscription. Observed, not dropped. */
  private handleNotice(message: string): void {
    log.warn('relay', 'NOTICE', message);
    for (const listener of this.noticeListeners) {
      listener(message);
    }
  }

  /**
   * The native bridge can deliver hundreds of WebSocket messages without giving React Native's
   * touch queue a turn. Production opts into a small cooperative batch; tests retain synchronous
   * delivery by leaving inboundBatchSize at zero.
   */
  private receiveMessage(data: string): void {
    if (this.inboundBatchSize === 0) {
      this.handleMessage(data);
      return;
    }
    this.inboundQueue.push(data);
    this.scheduleInboundDrain();
  }

  private scheduleInboundDrain(): void {
    if (this.inboundTimer !== undefined) return;
    this.inboundTimer = setTimeout(() => this.drainInboundQueue(), 0);
    (this.inboundTimer as {unref?: () => void}).unref?.();
  }

  private drainInboundQueue(): void {
    this.inboundTimer = undefined;
    const started = Date.now();
    let processed = 0;
    let tickBytes = 0;
    // Running per-event charge cursor (P2-1): tracks the wall-clock point up to which the shared
    // pool has already been charged, so each event charges only ITS OWN slice below rather than
    // the loop's cumulative time being charged in one lump at tick end.
    let lastCharged = started;
    const pending: PendingIngestBatch = {events: [], ids: new Set()};
    while (
      this.inboundHead < this.inboundQueue.length &&
      processed < this.inboundBatchSize &&
      // Forward progress (I3/I6): the FIRST event of a tick always runs regardless of the shared
      // budget or byte cap below, so an already-exhausted cross-client pool, or one oversized
      // frame, can never wedge this client's queue — worst case ~one event per client per window,
      // never zero.
      (processed === 0 ||
        (sharedInboundBudget.remaining(Date.now()) > 0 && tickBytes < INBOUND_BYTE_CAP))
    ) {
      const frame = this.inboundQueue[this.inboundHead++]!;
      this.handleMessage(frame, pending);
      processed++;
      // Raw frame length is the cheap proxy for the byte cap — it's already a plain string, so
      // this avoids re-stringifying the parsed event just to estimate cost.
      tickBytes += frame.length;
      // Shared budget (P2-1/B4): charge THIS event's own JS time the moment it's processed, rather
      // than only once at tick end — so the `remaining()` check above sees THIS tick's own spend
      // while the loop is still running. A tick now self-terminates mid-batch the instant the
      // shared cross-client pool it draws from is exhausted, instead of always running the full
      // inboundBatchSize before the budget "notices". The remainder of the tick's cost (the flush
      // below) is still charged once the loop exits, so the TOTAL charged per tick is unchanged —
      // only WHEN it lands within the tick moves earlier.
      const chargePoint = Date.now();
      sharedInboundBudget.charge(chargePoint - lastCharged);
      lastCharged = chargePoint;
    }
    this.flushPendingIngest(pending);
    // Shared budget (I3): charge the pool for whatever's left of this tick's JS time not already
    // charged per-event above — the flush call plus any loop-exit overhead — so every RelayClient's
    // drain loop on the JS thread still draws from the SAME bounded total across the FULL tick, not
    // just the per-event portion.
    sharedInboundBudget.charge(Date.now() - lastCharged);
    if (this.inboundHead === this.inboundQueue.length) {
      this.inboundQueue.length = 0;
      this.inboundHead = 0;
    } else {
      // Avoid retaining already-processed strings forever during a sustained relay stream.
      if (this.inboundHead >= 1_024 && this.inboundHead * 2 >= this.inboundQueue.length) {
        this.inboundQueue.splice(0, this.inboundHead);
        this.inboundHead = 0;
      }
      this.scheduleInboundDrain();
    }
  }

  /** Count valid events in the active page and remember the cursor for the next older page. */
  private recordPagedEvent(subId: string, event: Event, result: IngestResult): void {
    if (result === 'rejected') return;
    const state = this.pagedSubs.get(subId);
    if (!state || state.currentSubId !== subId) return;
    state.received++;
    if (state.oldestCreatedAt === undefined || event.created_at < state.oldestCreatedAt) {
      state.oldestCreatedAt = event.created_at;
    }
  }

  /** Flag a fetchByFilter sub as having matched a real event, so its cleanup keeps the dedupe key
   *  (see fetchByFilter's un-blacklist-on-cleanup) instead of treating this as a failed attempt. */
  private recordFetchFilterEvent(subId: string, result: IngestResult): void {
    if (result === 'rejected') return;
    const state = this.fetchFilterMatches.get(subId);
    if (state) state.value = true;
  }

  /**
   * Advance a paginated history subscription after EOSE. The root sub remains live; older pages
   * use unique short-lived ids so backfilling never replaces the live subscription.
   */
  private handlePagedEose(subId: string): boolean {
    const state = this.pagedSubs.get(subId);
    if (!state || state.currentSubId !== subId) return false;

    this.pendingSubs.delete(subId);
    if (subId !== state.rootSubId) {
      this.pagedSubs.delete(subId);
      this.knownSubIds.delete(subId);
      try { this.socket.send(closeMessage(subId)); } catch { /* socket gone */ }
    }

    let nextUntil: number | undefined;
    let nextLimit = state.pageSize;
    if (state.received >= state.currentLimit && state.oldestCreatedAt !== undefined) {
      // Keep the boundary inclusive so events sharing the oldest second are not skipped. If a
      // whole page has that same boundary again, widen just that page until the cursor can move.
      nextUntil = state.oldestCreatedAt;
      if (state.baseFilter.until !== undefined) {
        nextUntil = Math.min(nextUntil, state.baseFilter.until);
      }
      if (state.currentUntil !== undefined && nextUntil >= state.currentUntil) {
        if (
          nextUntil === state.currentUntil &&
          state.currentLimit < MAX_PAGINATION_PAGE_SIZE
        ) {
          nextLimit = Math.min(MAX_PAGINATION_PAGE_SIZE, state.currentLimit * 2);
        } else {
          nextUntil = undefined;
        }
      }
      if (
        nextUntil !== undefined &&
        (nextUntil < 0 ||
          (state.baseFilter.since !== undefined && nextUntil < state.baseFilter.since))
      ) {
        nextUntil = undefined;
      }
    }

    if (nextUntil === undefined) {
      this.pagedSubs.delete(state.rootSubId);
      if (this.pendingSubs.size === 0) this.markSynced();
      return true;
    }

    const pageSubId = `page:${state.rootSubId}:${++state.pageIndex}`;
    state.currentSubId = pageSubId;
    state.currentUntil = nextUntil;
    state.currentLimit = nextLimit;
    state.received = 0;
    state.oldestCreatedAt = undefined;
    this.pagedSubs.set(pageSubId, state);
    this.knownSubIds.add(pageSubId);
    this.pendingSubs.add(pageSubId);

    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (!this.pendingSubs.has(pageSubId)) return;
      try {
        this.socket.send(
          reqMessage(pageSubId, [{...state.baseFilter, until: nextUntil, limit: state.currentLimit}]),
        );
      } catch {
        this.pagedSubs.delete(pageSubId);
        this.pagedSubs.delete(state.rootSubId);
        this.knownSubIds.delete(pageSubId);
        this.pendingSubs.delete(pageSubId);
        if (this.pendingSubs.size === 0) this.markSynced();
      }
    }, state.delayMs);
    (state.timer as {unref?: () => void}).unref?.();
    return true;
  }

  private clearPagedBackfills(): void {
    for (const state of new Set(this.pagedSubs.values())) {
      if (state.timer !== undefined) clearTimeout(state.timer);
    }
    this.pagedSubs.clear();
  }

  /**
   * Trust-boundary firewall: this is the sole entry point for relay-originated frames reaching
   * `ingestEvent` (directly from `receiveMessage`, or looped over by `drainInboundQueue`). The
   * relay is untrusted input — a throwing verify(), a listener bug, or any other unexpected
   * failure on ONE frame must never kill the socket/session or abort the batched drain loop, so
   * every frame is processed inside this per-frame try/catch. A frame that throws is simply
   * dropped (counted, not re-thrown) and the next frame is unaffected.
   *
   * `ingestBatch`, when supplied (only by `drainInboundQueue`), collects newly-accepted EVENT
   * frames instead of storing them immediately — see {@link flushPendingIngest}.
   */
  private handleMessage(data: string, ingestBatch?: PendingIngestBatch): void {
    try {
      this.handleMessageUnsafe(data, ingestBatch);
    } catch {
      this.droppedFrames++;
    }
  }

  private handleMessageUnsafe(data: string, ingestBatch?: PendingIngestBatch): void {
    const msg = parseRelayMessage(data);
    if (msg.type === 'EVENT' && this.knownSubIds.has(msg.subId)) {
      this.noteSharedSocketActivity(); // this socket is answering — clear the stall streak
      const result = this.ingestEvent(msg.event, ingestBatch);
      this.recordPagedEvent(msg.subId, msg.event, result);
      this.recordFetchFilterEvent(msg.subId, result);
    } else if (msg.type === 'EOSE' && this.pendingSubs.has(msg.subId)) {
      if (!this.handlePagedEose(msg.subId)) {
        this.pendingSubs.delete(msg.subId);
        if (this.pendingSubs.size === 0) {
          this.markSynced();
        }
      }
    } else if (msg.type === 'EOSE' && this.fetchSubs.has(msg.subId)) {
      this.fetchSubs.get(msg.subId)?.();
    } else if (msg.type === 'EOSE' && msg.subId === this.resyncEoseSubId) {
      // The legacy (non-negentropy) manual resync REQ has replayed its backlog — round done.
      // settleResync() closes the sub + removes it from knownSubIds (shared with the watchdog path).
      this.settleResync();
    } else if (msg.type === 'EOSE' && this.knownSubIds.has(msg.subId)) {
      // Any other EOSE on a live sub is a SCOPED one (subscribeScoped) finishing its stored-history
      // replay — the plan's own subs were consumed by the pendingSubs branch above. Previously
      // dropped on the floor; now surfaced so the UI can distinguish "history synced, genuinely
      // empty" from "still replaying" (Phase 5 stale-first).
      for (const listener of this.scopedEoseListeners) {
        try {
          listener(msg.subId);
        } catch {
          // a throwing listener must not kill the connection
        }
      }
    } else if (msg.type === 'CLOSED') {
      this.handleClosed(msg.subId, msg.message);
    } else if (msg.type === 'NOTICE') {
      this.handleNotice(msg.message);
    } else if (msg.type === 'OK') {
      this.noteSharedSocketActivity(); // this socket is answering — clear the stall streak
      const pending = this.pendingPublishes.get(msg.id);
      if (pending) {
        this.pendingPublishes.delete(msg.id);
        pending({accepted: msg.accepted, message: msg.message});
      }
    } else if (msg.type === 'COUNT') {
      const pending = this.pendingCounts.get(msg.subId);
      if (pending) {
        this.pendingCounts.delete(msg.subId);
        pending(msg.count);
      }
    } else if (msg.type === 'NEG-MSG' && this.negActive && msg.subId === this.negSubId) {
      this.handleNegMsg(msg.message);
    } else if (msg.type === 'NEG-ERR' && this.negActive && msg.subId === this.negSubId) {
      this.negFallback();
    }
  }

  /** Validate, dedupe, store, and notify. Returns true when newly stored. */
  ingest(event: Event): boolean {
    return this.ingestEvent(event) === 'stored';
  }

  private ingestEvent(event: Event, ingestBatch?: PendingIngestBatch): IngestResult {
    // Accept the firehose kinds, plus two allow-lists of kinds that NEVER ride the firehose and only
    // ever arrive on an explicitly-opened, narrowly-scoped subscription:
    //   • GROUP_KINDS      — a NIP-29 group sub (the relay demands a group-scoped query).
    //   • FETCH_ONLY_KINDS — a media blob, pulled by id alone when a viewer taps a chip. Accepting it
    //     here is what lets the tap's fetchById REQ land in the store; it is deliberately absent from
    //     `this.kinds` (SUBSCRIBED_KINDS), so no REQ this client ever issues will ask for it in bulk.
    if (
      !this.kinds.includes(event.kind) &&
      !GROUP_KINDS.includes(event.kind) &&
      !FETCH_ONLY_KINDS.includes(event.kind)
    ) {
      return 'rejected';
    }
    // C6 allow-list lockstep: this kind IS accepted by the client — warn (never reject) if the relay's
    // advertised allow-list doesn't carry it, once per kind. At caps fallback the advertised list is a
    // superset of every accepted kind, so this stays silent; ingest accept/reject is never changed here.
    if (this.getAllowedKinds) {
      warnKindDrift([event.kind], this.getAllowedKinds(), 'ingest', this.warnedDriftKinds);
    }
    // Dedupe BEFORE verifying. The sync design deliberately re-delivers events we already hold —
    // the DM sub replays a 2-day gift-wrap window, org-config/self-lists carry no `since`, group
    // resubs replay history, and every optimistic publish is echoed back by the relay. Re-running
    // a full pure-JS schnorr verify (several ms on Hermes) just to drop the event as a duplicate
    // one line later is wasted CPU precisely during reconnect/refresh bursts.
    //
    // SECURITY INVARIANT preserved: an event is only skipped here when store.has(id) — i.e. a copy
    // is ALREADY stored, and (since the id IS the event hash and events only enter the store via the
    // verify-then-save path below) that stored copy was signature-verified on first sight. We never
    // store or hand an unverified event to a store-changing listener. Known ids still fire the
    // "seen" listeners so echo-confirmation and liveness keep working; they never re-save or reach
    // the `eventListeners`, matching the store.save()-dedupe behaviour they had before.
    //
    // A batched drain tick also checks `ingestBatch.ids`: an event collected earlier THIS tick isn't
    // durable yet (its saveNewBatch hasn't run), so store.has() alone can't see it — without this it
    // would be misjudged brand-new and re-verified/re-queued instead of recognized as the same-tick
    // duplicate it is.
    if (this.store.has(event.id) || ingestBatch?.ids.has(event.id)) {
      for (const listener of this.seenListeners) {
        listener(event);
      }
      this.onIngestEvent?.(event);
      return 'known'; // already verified on first ingest; skip re-verify + re-save
    }
    if (!this.verify(event)) {
      return 'rejected';
    }
    // Notify "seen" listeners for EVERY valid received event — even a duplicate. This is how a
    // freshly published optimistic write gets confirmed: the relay echoes our own event back, but
    // it's already in the local store (we saved it optimistically on publish), so store.save()
    // dedupes and the store-changing `eventListeners` below never fire. Echo-confirmation and
    // liveness must therefore key off "seen", not "newly stored".
    for (const listener of this.seenListeners) {
      listener(event);
    }
    if (ingestBatch) {
      // Only the STORE step batches: this event is verified + deduped now, exactly as above; the
      // durable write and the store-changing listeners are deferred to flushPendingIngest() at the
      // end of THIS SAME drain tick (M6), so a sync burst costs one transaction instead of one
      // autocommitting INSERT per event.
      ingestBatch.ids.add(event.id);
      ingestBatch.events.push(event);
      return 'stored';
    }
    const stored = this.store.saveNew?.(event) ?? this.store.save(event);
    if (!stored) {
      this.onIngestEvent?.(event);
      return 'known'; // duplicate — already notified "seen" above (rare: raced concurrent ingest)
    }
    for (const listener of this.eventListeners) {
      listener(event);
    }
    this.onIngestEvent?.(event);
    return 'stored';
  }

  /**
   * End-of-tick flush for `drainInboundQueue`'s batched ingest (M6): stores every event collected
   * this tick with ONE saveNewBatch call, then fires the SAME per-event notifications ingestEvent's
   * immediate path would have fired (`eventListeners` + `onIngestEvent`), in collection order — so
   * batching is invisible to listeners except for landing together at tick-end instead of
   * interleaved with parsing. Falls back to per-event saveNew/save (via storeIndividually) when the
   * store doesn't implement saveNewBatch (e.g. the in-memory test double).
   *
   * This step must NEVER throw out of drainInboundQueue: a throwing saveNewBatch (Bug-2's rollback
   * contract guarantees a clean, untouched state on any such throw) is caught here and retried
   * per-event via storeIndividually, each write in its OWN try/catch, so one bad event doesn't drop
   * the rest of the tick's events — matching handleMessage's per-frame isolation guarantee.
   *
   * Each event's notification runs in its own try/catch, matching handleMessage's per-frame
   * isolation guarantee: a listener throwing for one event must not stop the rest of the batch from
   * being notified. Notifications fire only for events actually stored.
   */
  private flushPendingIngest(batch: PendingIngestBatch): void {
    if (batch.events.length === 0) return;
    let stored: Event[];
    try {
      stored = this.store.saveNewBatch?.(batch.events) ?? this.storeIndividually(batch.events);
    } catch {
      stored = this.storeIndividually(batch.events);
    }
    for (const event of stored) {
      try {
        for (const listener of this.eventListeners) {
          listener(event);
        }
        this.onIngestEvent?.(event);
      } catch {
        this.droppedFrames++;
      }
    }
  }

  /**
   * Per-event store fallback for flushPendingIngest: used when the store has no saveNewBatch, or
   * when saveNewBatch threw. Each write is in its OWN try/catch, so a single bad event (a throwing
   * saveNew/save) is dropped and counted without stopping the rest of the tick's events from being
   * stored — the same per-frame isolation `handleMessage` gives the unbatched path. Returns the
   * subset of `events` actually stored, same relative order.
   */
  private storeIndividually(events: Event[]): Event[] {
    const stored: Event[] = [];
    for (const event of events) {
      try {
        if (this.store.saveNew?.(event) ?? this.store.save(event)) stored.push(event);
      } catch {
        this.droppedFrames++;
      }
    }
    return stored;
  }

  /** Fires for every newly-stored event (drives feed re-render). */
  onEvent(cb: (event: Event) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /**
   * Fires for every valid event received from the relay, INCLUDING duplicates already in the
   * store. Use this for echo-confirmation of our own optimistic writes and for connection
   * liveness, where "the relay sent us this id" matters more than "it changed the store".
   */
  onSeen(cb: (event: Event) => void): () => void {
    this.seenListeners.add(cb);
    return () => this.seenListeners.delete(cb);
  }

  /** Fires when the relay signals end-of-stored-events (initial sync complete). */
  onSynced(cb: () => void): () => void {
    this.syncListeners.add(cb);
    return () => this.syncListeners.delete(cb);
  }

  /**
   * Fires after every (re)connect has actually sent the subscription plan — i.e. the socket is OPEN
   * and knownSubIds was just reset to the plan's subs. This is the correct (and only) moment to
   * (re)open scoped subscriptions: a subscribeScoped() made before the socket opened is wiped by
   * that reset, so callers who subscribe at construction time silently lose their subs.
   */
  onSubscribed(cb: () => void): () => void {
    this.subscribedListeners.add(cb);
    return () => this.subscribedListeners.delete(cb);
  }

  /**
   * Fires when the relay CLOSEs a subscription (e.g. `auth-required:`/`restricted:`) with the sub
   * id and the relay's reason string.
   */
  onSubError(cb: (err: {subId: string; message: string}) => void): () => void {
    this.subErrorListeners.add(cb);
    return () => this.subErrorListeners.delete(cb);
  }

  /** Fires when a SCOPED subscription (subscribeScoped) receives its EOSE — its stored history has
   *  fully replayed and an empty local list for that scope is now genuinely empty. */
  onScopedEose(cb: (subId: string) => void): () => void {
    this.scopedEoseListeners.add(cb);
    return () => this.scopedEoseListeners.delete(cb);
  }

  /** Fires for every relay NOTICE frame (NIP-01) — never silently dropped. */
  onNotice(cb: (message: string) => void): () => void {
    this.noticeListeners.add(cb);
    return () => this.noticeListeners.delete(cb);
  }

  isSynced(): boolean {
    return this.synced;
  }

  /** Count of inbound frames dropped because processing them threw (diagnostics/tests only). */
  droppedFrameCount(): number {
    return this.droppedFrames;
  }

  /** The feed served from cache — works offline, independent of the connection. */
  cachedPosts(limit?: number): Event[] {
    return this.store.getPosts(limit ?? this.limit);
  }

  unsubscribe(): void {
    for (const subId of this.knownSubIds) {
      this.socket.send(closeMessage(subId));
    }
  }

  close(): void {
    if (this.inboundTimer !== undefined) {
      clearTimeout(this.inboundTimer);
      this.inboundTimer = undefined;
    }
    this.inboundQueue.length = 0;
    this.inboundHead = 0;
    this.fetchQueue.length = 0;
    this.clearPagedBackfills();
    this.socket.close();
  }
}

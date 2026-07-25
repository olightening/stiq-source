/**
 * One-shot, on-demand fetch of the organizer's kind-30078 config docs over a dedicated relay socket.
 *
 * The live subscription plan already streams these docs in — but two failure modes need a fetch the
 * client can AWAIT at a precise moment instead of waiting for a stream to happen to deliver one:
 *
 *   • FRESH ENROLL VIA A SHORT LINK: `STIQ_SHORT_LINKS` join codes carry ZERO purpose issuer keys,
 *     so until the `stiq:token-keys` doc is ingested every token draw blinds under the enrollment
 *     key — the wrong-key draws behind the 2026-07-21 posting outage ("signature representative out
 *     of range" at the organizer, silently unblindable batches client-side). The first draw must be
 *     able to fetch the keys FIRST, not race the live stream.
 *
 *   • STALE-KEY SELF-HEAL: when a draw fails with the wrong-key signature (see
 *     drawExchange.isStaleKeyDrawFailure), the runtime re-fetches the current key set and retries
 *     once — turning a permanent, retry-proof outage into one extra round-trip.
 *
 * Pure module in the drawExchange mold: caller supplies the socket factory and consumes the verified
 * events (piping them through AppRuntime.handleIncomingEvent, the single ingestion path that
 * validates, applies, persists, and rebinds fingerprints). Only events that are (a) signed validly
 * and (b) authored by `organizerHex` are returned — the same authorship gate handleIncomingEvent
 * applies, enforced here too so a hostile relay can't even reach that code path with foreign docs.
 */
import {verifyEvent, type Event} from 'nostr-tools/pure';
import type {RelaySocket} from '../nostr/socket';
import {reqMessage, closeMessage, parseRelayMessage} from '../nostr/protocol';
// kind-30078 (NIP-78 app data) — the organizer config carrier; the same constant AppRuntime aliases
// as KIND_ORG_CONFIG for its ingestion gate.
import {KIND_TAG_POLICY as KIND_ORG_CONFIG} from '../feed/tagPolicy';

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface OrgConfigFetchOptions {
  /** Opens a FRESH (production: Tor-routed) socket to the community relay. Called once per attempt. */
  connect: () => RelaySocket;
  /** The organizer's hex pubkey — only docs authored by it are returned. */
  organizerHex: string;
  /** Which `d` tags to fetch (e.g. ['stiq:token-keys', 'stiq:content-epoch']). */
  dTags: string[];
  /** Per-attempt wait for EOSE before falling back to whatever arrived. Default 25s (Tor-paced). */
  timeoutMs?: number;
  /** Socket attempts before giving up (a fresh circuit per attempt). Default 2. */
  attempts?: number;
}

/**
 * Fetch the newest organizer-authored doc per requested `d` tag. Resolves with the verified events
 * (possibly empty — relay unreachable, or the organizer never published one); never rejects. Each
 * attempt waits for EOSE (or its timeout, keeping any events that DID arrive); a socket that dies
 * pre-EOSE gets one fresh-circuit retry.
 */
export async function fetchOrgConfigDocs(opts: OrgConfigFetchOptions): Promise<Event[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const got = await runOneAttempt(opts, timeoutMs);
    if (got !== null) return got;
    if (i < attempts - 1) await sleep(RETRY_BACKOFF_MS);
  }
  return [];
}

/** One socket's attempt. Resolves the deduped events on EOSE/timeout, or null when the socket died
 *  before ANY signal (worth a fresh circuit). */
function runOneAttempt(opts: OrgConfigFetchOptions, timeoutMs: number): Promise<Event[] | null> {
  return new Promise<Event[] | null>(resolve => {
    let socket: RelaySocket;
    try {
      socket = opts.connect();
    } catch {
      return resolve(null); // Tor not up yet — a fresh attempt may catch it
    }
    // Newest doc per d-tag: kind-30078 is replaceable so the relay should send one per d, but a
    // mirror-unioned stream can deliver several — keep MAX(created_at) per d, mirroring the
    // (author, d) watermark handleIncomingEvent enforces downstream.
    const newestByD = new Map<string, Event>();
    let sawAnything = false;
    let settled = false;
    const subId = `orgcfg:${opts.organizerHex.slice(0, 12)}`;

    const done = (out: Event[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(closeMessage(subId));
      } catch {
        /* socket already gone */
      }
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(out);
    };

    const timer = setTimeout(() => done([...newestByD.values()]), timeoutMs);

    socket.onMessage(raw => {
      const msg = parseRelayMessage(raw);
      if (msg.type === 'EVENT' && msg.subId === subId) {
        sawAnything = true;
        const ev = msg.event;
        if (ev.kind !== KIND_ORG_CONFIG || ev.pubkey !== opts.organizerHex) return;
        if (!verifyEvent(ev)) return;
        const d = ev.tags.find(t => t[0] === 'd')?.[1];
        if (d === undefined || !opts.dTags.includes(d)) return;
        const prev = newestByD.get(d);
        if (!prev || ev.created_at > prev.created_at) newestByD.set(d, ev);
      } else if (msg.type === 'EOSE' && msg.subId === subId) {
        done([...newestByD.values()]);
      }
    });

    // A dead circuit with nothing received → null (retry on a fresh one); with events already in
    // hand → return them rather than discard.
    socket.onClose(() => done(sawAnything || newestByD.size > 0 ? [...newestByD.values()] : null));

    socket.onOpen(() => {
      socket.send(
        reqMessage(subId, [
          {kinds: [KIND_ORG_CONFIG], authors: [opts.organizerHex], '#d': opts.dTags},
        ]),
      );
    });
  });
}

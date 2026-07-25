/**
 * Read-token unlock over Tor — the METER that turns reading into a limited capability (lever 1).
 *
 * A blind post's BODY is sealed under a rotating content epoch key K_E (see ./contentKey,
 * ./blindSigner). K_E is NOT in the join code. To read epoch E a member SPENDS one blind
 * READ-TOKEN and the organizer returns K_E:
 *
 *   member ──kind 9026 (read-token + epoch E, NIP-44 to organizer)──▶ relay mailbox
 *   organizer ◀──pickup── verify token sig + not-already-spent ── look up K_E ──
 *   organizer ──kind 9027 (K_E, NIP-44 to reply key)──▶ relay mailbox
 *   member ◀──pickup── store K_E ──▶ epoch E unlocked
 *
 * Metering + anonymity: read-tokens are the SAME blind-signed tokens as posting tokens, drawn from
 * the organizer against a (large) per-epoch READ allowance (see drawExchange, `purpose:'read'`). The
 * organizer records each redeemed token in a read spent-set, so it enforces the budget WITHOUT ever
 * learning which npub is reading (the token is blind-signed; the request rides a throwaway key). A
 * member who hands their read-tokens to a malicious actor merely burns their OWN finite budget, and
 * volume-based rotation bounds how much any single unlocked K_E exposes.
 *
 * The whole meter lives at the organizer mailbox — the RELAY needs no read-side change; it just
 * stores/forwards the 9026/9027 events exactly like the 9024/9025 draw pair.
 *
 * Mirrors drawExchange.ts (same dedicated-socket + retry + NIP-44 mailbox pattern), simplified to a
 * single token in / single key out. Idempotent over retries: the organizer dedupes by request id and
 * K_E is deterministic per epoch, so a resent request replays the same key without double-charging.
 */
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {mineEventPow} from '../dm/nip13';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import type {RelaySocket} from '../nostr/socket';
import {reqMessage, eventMessage, closeMessage, parseRelayMessage} from '../nostr/protocol';
import {KIND_UNLOCK_REQUEST, KIND_UNLOCK_RESPONSE, MAILBOX_TTL_SECONDS} from '../contracts';
import {CONTENT_KEY_BYTES} from './contentKey';
import type {Token} from './wallet';
import {log} from '../util/log';

// Unlock request/response kinds are owned by the contract module; re-exported for existing importers.
export {KIND_UNLOCK_REQUEST, KIND_UNLOCK_RESPONSE};

const DEFAULT_ATTEMPT_TIMEOUT_MS = 45_000;
const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface ReadUnlockOptions {
  /** Opens a FRESH (production: Tor-routed) socket to the community relay. Called once per attempt. */
  connect: () => RelaySocket;
  /** The organizer mailbox pubkey (hex) the request is encrypted to. */
  organizerPubkey: string;
  /** One spent read-token (blind token + issuer sig) — the budget unit the organizer marks spent. */
  token: Token;
  /** The content epoch to unlock. */
  epoch: number;
  /** NIP-13 difficulty to mine on the request (must meet the relay's enroll PoW). */
  powDifficulty: number;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
}

export type ReadUnlockResult =
  | {ok: true; epoch: number; key: Uint8Array}
  | {ok: false; error: string; timedOut?: boolean};

interface UnlockRequestPayload {
  token: string; // base64 read-token
  sig: string; // base64 issuer blind signature over `token`
  epoch: number;
  replyPubkey: string; // hex — where the organizer addresses K_E
}

interface UnlockResponsePayload {
  key?: string; // base64 of the 32-byte content epoch key
  epoch?: number;
  error?: string;
}

type AttemptOutcome =
  | {kind: 'ok'; key: Uint8Array}
  | {kind: 'error'; error: string}
  | {kind: 'retry'; error: string};

interface UnlockSession {
  requestEvent: Event;
  replyPubkey: string;
  respConvKey: Uint8Array;
  organizerPubkey: string;
  epoch: number;
}

/** Build the signed unlock request ONCE; every socket attempt replays it (id-dedupe at the organizer). */
async function prepareSession(opts: ReadUnlockOptions): Promise<UnlockSession> {
  const reqSk = generateSecretKey();
  const replySk = generateSecretKey();
  const replyPubkey = getPublicKey(replySk);

  const payload: UnlockRequestPayload = {
    token: bytesToBase64(opts.token.token),
    sig: bytesToBase64(opts.token.sig),
    epoch: opts.epoch,
    replyPubkey,
  };
  const reqConvKey = nip44.utils.getConversationKey(reqSk, opts.organizerPubkey);
  const now = Math.floor(Date.now() / 1000);
  const mined = await mineEventPow(
    {
      pubkey: getPublicKey(reqSk),
      kind: KIND_UNLOCK_REQUEST,
      created_at: now,
      tags: [
        ['p', opts.organizerPubkey],
        ['expiration', String(now + MAILBOX_TTL_SECONDS)],
      ],
      content: nip44.encrypt(JSON.stringify(payload), reqConvKey),
    },
    opts.powDifficulty,
  );
  const requestEvent = finalizeEvent(
    {kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content},
    reqSk,
  );
  const respConvKey = nip44.utils.getConversationKey(replySk, opts.organizerPubkey);
  return {requestEvent, replyPubkey, respConvKey, organizerPubkey: opts.organizerPubkey, epoch: opts.epoch};
}

/** One attempt over one socket: subscribe, (re)send the request on open, settle on the first terminal event. */
function runOneAttempt(
  session: UnlockSession,
  socket: RelaySocket,
  timeoutMs: number,
  attemptNo: number,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>(resolve => {
    let settled = false;
    const subId = `unlock:${session.replyPubkey.slice(0, 16)}`;

    const done = (o: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(closeMessage(subId));
      } catch {
        /* socket already gone */
      }
      resolve(o);
    };

    const timer = setTimeout(
      () => done({kind: 'retry', error: 'the organizer did not respond in time'}),
      timeoutMs,
    );

    const handleResponse = (event: Event): void => {
      if (!verifyEvent(event) || event.pubkey !== session.organizerPubkey) return;
      let data: UnlockResponsePayload;
      try {
        data = JSON.parse(nip44.decrypt(event.content, session.respConvKey)) as UnlockResponsePayload;
      } catch {
        return; // not addressed to us / undecryptable — keep waiting
      }
      if (data.error) {
        // An organizer-signed error (spent token, unknown epoch) won't change on retry — fatal.
        log.warn('unlock', `epoch ${session.epoch} refusal received (attempt ${attemptNo}): ${data.error}`);
        return done({kind: 'error', error: data.error});
      }
      if (!data.key) return; // malformed — keep waiting
      // The organizer must echo back the SAME epoch we requested. A mismatch (buggy/version-skewed
      // organizer) would otherwise get cached under the requested epoch (see setContentEpochKey in
      // the caller) — silently binding the wrong K_E to that epoch and burning the spent read-token
      // for nothing. Treat it as fatal rather than retrying: a resend would just repeat the mismatch.
      if (data.epoch !== session.epoch) {
        return done({kind: 'error', error: 'organizer returned a key for the wrong epoch'});
      }
      let key: Uint8Array;
      try {
        key = base64ToBytes(data.key);
      } catch {
        return done({kind: 'error', error: 'organizer returned a malformed content key'});
      }
      if (key.length !== CONTENT_KEY_BYTES) {
        return done({kind: 'error', error: 'organizer returned a wrong-length content key'});
      }
      log.info('unlock', `epoch ${session.epoch} answer received (attempt ${attemptNo}) — K_E delivered`);
      done({kind: 'ok', key});
    };

    socket.onMessage(raw => {
      const msg = parseRelayMessage(raw);
      if (msg.type === 'EVENT' && msg.subId === subId && msg.event.kind === KIND_UNLOCK_RESPONSE) {
        handleResponse(msg.event);
      } else if (msg.type === 'OK' && msg.id === session.requestEvent.id && !msg.accepted) {
        log.warn('unlock', `epoch ${session.epoch} request rejected by relay (attempt ${attemptNo}): ${msg.message}`);
        done({kind: 'error', error: `relay rejected the unlock request: ${msg.message}`});
      }
    });

    socket.onClose(() => done({kind: 'retry', error: 'the relay connection closed before a response'}));

    socket.onOpen(() => {
      socket.send(reqMessage(subId, [{kinds: [KIND_UNLOCK_RESPONSE], '#p': [session.replyPubkey]}]));
      socket.send(eventMessage(session.requestEvent));
      log.info('unlock', `epoch ${session.epoch} request sent over Tor (attempt ${attemptNo})`);
    });
  });
}

/**
 * Run the full unlock round-trip (with retries) and resolve with the epoch key, or a typed failure.
 * The caller stores the key via contentKey.setContentEpochKey/storeContentEpochKey on success.
 */
export async function runReadUnlock(opts: ReadUnlockOptions): Promise<ReadUnlockResult> {
  if (!opts.organizerPubkey) {
    log.warn('unlock', `epoch ${opts.epoch} unlock skipped — no organizer mailbox for this community`);
    return {ok: false, error: 'this community has no organizer mailbox'};
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

  // Built ONCE; every socket attempt replays it so the organizer charges the token exactly once.
  const session = await prepareSession(opts);

  let lastError = 'the organizer did not respond in time';
  for (let i = 0; i < attempts; i++) {
    let socket: RelaySocket;
    try {
      socket = opts.connect();
    } catch (e) {
      // No live relay socket to send on at all — this is the "dropped on the floor while Tor/WS is
      // still connecting" case the 2026-07-21 incident review flagged: it is NOT silently swallowed
      // (logged + retried within this same call), but with `opts.connect` unavailable across every
      // sub-attempt here, this whole runReadUnlock call returns a transient failure and the OUTER
      // caller (AppRuntime.noteLockedEpochs) is what must keep the retry alive past this call's own
      // bounded attempts — see its own reconnect/foreground revival.
      lastError = `could not open a relay connection: ${(e as Error)?.message ?? e}`;
      log.warn('unlock', `epoch ${opts.epoch} sub-attempt ${i + 1}/${attempts}: ${lastError}`);
      if (i < attempts - 1) await sleep(backoffMs);
      continue;
    }
    let outcome: AttemptOutcome;
    try {
      outcome = await runOneAttempt(session, socket, timeoutMs, i + 1);
    } finally {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    if (outcome.kind === 'ok') return {ok: true, epoch: session.epoch, key: outcome.key};
    if (outcome.kind === 'error') return {ok: false, error: outcome.error};
    lastError = outcome.error;
    if (i < attempts - 1) await sleep(backoffMs);
  }
  log.warn('unlock', `epoch ${opts.epoch} exhausted ${attempts} sub-attempt(s) in this call: ${lastError}`);
  return {ok: false, error: lastError, timedOut: true};
}

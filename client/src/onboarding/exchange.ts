/**
 * Automated, unlinkable credential exchange over a Tor-routed relay mailbox.
 *
 * Reliability is part of the protocol: one blinded request and one reply key are prepared once,
 * then replayed over fresh sockets. If a Tor stream drops after the organizer answers, a later
 * subscription to the same reply key recovers the stored response. Re-minting either value on
 * retry would strand the one-shot invite.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {Enrollment, RESP_PREFIX, type Session} from './enrollment';
import type {BlindRsaClient} from './blindrsa';
import type {Community} from './community';
import {mineEventPow} from '../dm/nip13';
import {bytesToBase64} from '../util/base64';
import {log} from '../util/log';
import type {RelaySocket} from '../nostr/socket';
import {
  reqMessage,
  eventMessage,
  closeMessage,
  parseRelayMessage,
} from '../nostr/protocol';
import {KIND_ENROLL_REQUEST, KIND_ENROLL_RESPONSE, MAILBOX_TTL_SECONDS} from '../contracts';

// Enroll request/response kinds and the NIP-40 mailbox TTL are owned by the contract module (the
// relay may drop the mailbox event after MAILBOX_TTL_SECONDS, so it self-purges). Re-exported so
// existing importers/tests keep resolving the kinds via this module.
export {KIND_ENROLL_REQUEST, KIND_ENROLL_RESPONSE};

/** Per-socket wait. A retry opens a fresh Tor stream but reuses the same cryptographic request. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export type ExchangeResult =
  | {ok: true; session: Session}
  | {ok: false; error: string; timedOut?: boolean};

/**
 * Callbacks a caller can thread through {@link ExchangeOptions} to observe the transport-level
 * proof-of-connectivity separately from the exchange's ultimate ok/error result. Reused verbatim by
 * App.tsx's single-flight wrapper and OnboardingScreen's connecting step so the shape stays in sync.
 */
export interface CircuitHooks {
  /** The onion circuit to the community relay is open (see {@link ExchangeOptions.onCircuitOpen}). */
  onCircuitOpen?: () => void;
  /** The onion circuit never opened before the socket died (see {@link ExchangeOptions.onCircuitFailed}). */
  onCircuitFailed?: (reason: string) => void;
}

export interface ExchangeOptions {
  /**
   * A single dedicated socket. Kept for tests/manual callers; production should pass `connect` so
   * a dropped onion circuit can be retried over a fresh stream without minting another request.
   */
  socket?: RelaySocket;
  /** Opens a fresh Tor-routed socket for each attempt. May wait asynchronously for Tor recovery. */
  connect?: () => RelaySocket | Promise<RelaySocket>;
  /** Parsed community — MUST carry `organizerPubkey` (the mailbox recipient). */
  community: Community;
  inviteCode: string;
  blindRsa: BlindRsaClient;
  /** NIP-13 difficulty to mine on the request (must meet the relay's enroll PoW). */
  powDifficulty: number;
  /** Per-socket deadline before trying a fresh stream. */
  timeoutMs?: number;
  /** Number of fresh socket attempts. Defaults to 3 with `connect`, 1 with `socket`. */
  attempts?: number;
  /** Pause between fresh socket attempts. */
  backoffMs?: number;
  /** Best-effort transport recovery before opening the next socket (production requests NEWNYM). */
  onRetry?: (nextAttempt: number, error: string) => void | Promise<void>;
  /**
   * Fires the first time an attempt's socket reaches `onOpen`, just before the request is sent —
   * a complete proof that the authenticated, encrypted onion circuit to the community relay is
   * open (SOCKS stream + descriptor resolution + rendezvous + WS upgrade all succeeded). Callers
   * should latch this true and never toggle it back.
   */
  onCircuitOpen?: () => void;
  /**
   * Fires when an attempt's socket closes/errors BEFORE ever reaching `onOpen` — i.e. the onion
   * rendezvous to the relay itself failed, as opposed to a later protocol-level rejection.
   */
  onCircuitFailed?: (reason: string) => void;
  /**
   * Reuse a previously prepared enrollment after a UI/Tor retry. The posting key, blinded token,
   * request event, and reply mailbox stay identical, so an already-stored response remains useful.
   */
  prepared?: PreparedCredentialExchange;
}

/** Request payload (NIP-44 encrypted to the organizer). */
interface EnrollRequestPayload {
  inviteCode: string;
  blindedToken: string;
  replyPubkey: string;
}

/** Response payload (NIP-44 encrypted to the reply key). */
interface EnrollResponsePayload {
  blindSig?: string;
  error?: string;
}

/**
 * Sensitive in-memory state that must remain fixed across transport retries. Callers should discard
 * it after success or when the user switches to a different invite/community.
 */
export interface PreparedCredentialExchange {
  enrollment: Enrollment;
  requestEvent: Event;
  replyPubkey: string;
  respConvKey: Uint8Array;
  organizerPubkey: string;
}

type AttemptOutcome =
  | {kind: 'ok'; session: Session}
  | {kind: 'error'; error: string}
  | {kind: 'retry'; error: string; timedOut?: boolean};

type PrepareOptions = Pick<
  ExchangeOptions,
  'community' | 'inviteCode' | 'blindRsa' | 'powDifficulty'
>;

/**
 * Perform the expensive/key-generating half exactly once. Reusing this object lets the organizer
 * make a one-shot invite idempotent for this exact blinded request without enabling a second
 * credential.
 */
export async function prepareCredentialExchange(
  opts: PrepareOptions,
): Promise<PreparedCredentialExchange> {
  const {community, inviteCode, blindRsa, powDifficulty} = opts;
  const organizerPubkey = community.organizerPubkey;
  if (!organizerPubkey) {
    throw new Error('this community has no organizer mailbox');
  }

  // On-device account key + blinded credential token.
  const {enrollment, blinded} = await Enrollment.begin(community, blindRsa, inviteCode);

  // Two unlinkable throwaway keys: one signs the request; one receives the response.
  const reqSk = generateSecretKey();
  const replySk = generateSecretKey();
  const replyPubkey = getPublicKey(replySk);
  const payload: EnrollRequestPayload = {
    inviteCode,
    blindedToken: bytesToBase64(blinded),
    replyPubkey,
  };
  const reqConvKey = nip44.utils.getConversationKey(reqSk, organizerPubkey);
  const now = Math.floor(Date.now() / 1000);

  // Mine once. Every retry sends this exact event id; changing it would defeat organizer dedupe.
  const mined = await mineEventPow(
    {
      pubkey: getPublicKey(reqSk),
      kind: KIND_ENROLL_REQUEST,
      created_at: now,
      tags: [
        ['p', organizerPubkey],
        ['expiration', String(now + MAILBOX_TTL_SECONDS)],
      ],
      content: nip44.encrypt(JSON.stringify(payload), reqConvKey),
    },
    powDifficulty,
  );
  const requestEvent = finalizeEvent(
    {kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content},
    reqSk,
  );

  return {
    enrollment,
    requestEvent,
    replyPubkey,
    respConvKey: nip44.utils.getConversationKey(replySk, organizerPubkey),
    organizerPubkey,
  };
}

/** A duplicate request publish is expected on retry; keep waiting for the stored response replay. */
function isDuplicateRejection(message: string): boolean {
  return /duplicate|already (?:have|stored)|event already exists/i.test(message);
}

/** Run one subscribe+publish round-trip over one dedicated socket. */
function runOneAttempt(
  prepared: PreparedCredentialExchange,
  socket: RelaySocket,
  timeoutMs: number,
  onCircuitOpen?: () => void,
  onCircuitFailed?: (reason: string) => void,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>(resolve => {
    let settled = false;
    let opened = false;
    const subId = `enroll:${prepared.replyPubkey.slice(0, 16)}`;

    const finish = (outcome: AttemptOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(closeMessage(subId));
      } catch {
        /* socket already gone */
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () =>
        finish({
          kind: 'retry',
          error: 'the organizer did not respond in time',
          timedOut: true,
        }),
      timeoutMs,
    );

    const handleResponse = async (event: Event): Promise<void> => {
      // Authenticate the responder before attempting potentially attacker-controlled decoding.
      // Order matters: the O(1) organizer-pubkey comparison runs BEFORE the expensive Schnorr
      // verifyEvent() (audit #55). A malicious relay ignores the subscription filter and can stream
      // unlimited kind-9023 events with valid-looking sigs during the ~60s enrollment window; running
      // verifyEvent first would burn a full signature verification on each, so we reject anything not
      // claiming to be from the organizer for free and verify only genuine candidates.
      if (settled || event.pubkey !== prepared.organizerPubkey || !verifyEvent(event)) {
        return;
      }

      let data: EnrollResponsePayload;
      try {
        data = JSON.parse(
          nip44.decrypt(event.content, prepared.respConvKey),
        ) as EnrollResponsePayload;
      } catch {
        return; // not addressed to us / undecryptable — keep waiting
      }
      if (data.error) {
        finish({kind: 'error', error: data.error});
        return;
      }
      if (!data.blindSig) {
        return;
      }

      try {
        const result = await prepared.enrollment.complete(RESP_PREFIX + data.blindSig);
        finish(
          result.ok
            ? {kind: 'ok', session: result.session}
            : {kind: 'error', error: result.error},
        );
      } catch (e) {
        finish({
          kind: 'error',
          error: `could not verify the organizer credential: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    };

    socket.onMessage(raw => {
      const msg = parseRelayMessage(raw);
      log.info('enroll', 'relay', msg.type);
      if (
        msg.type === 'EVENT' &&
        msg.subId === subId &&
        msg.event.kind === KIND_ENROLL_RESPONSE
      ) {
        handleResponse(msg.event).catch(e => {
          finish({
            kind: 'error',
            error: `could not process the organizer response: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
        });
      } else if (
        msg.type === 'OK' &&
        msg.id === prepared.requestEvent.id &&
        !msg.accepted &&
        !isDuplicateRejection(msg.message)
      ) {
        finish({
          kind: 'error',
          error: `relay rejected the enrollment request: ${msg.message}`,
        });
      }
    });

    socket.onClose(() => {
      if (!opened) {
        onCircuitFailed?.('the Tor circuit to your community relay could not be opened');
      }
      finish({
        kind: 'retry',
        error: 'the Tor relay connection closed before enrollment completed',
      });
    });

    socket.onOpen(() => {
      opened = true;
      onCircuitOpen?.();
      try {
        // Subscribe first. WebSocket frame ordering installs the response filter before the request.
        socket.send(
          reqMessage(subId, [
            {kinds: [KIND_ENROLL_RESPONSE], '#p': [prepared.replyPubkey]},
          ]),
        );
        socket.send(eventMessage(prepared.requestEvent));
      } catch (e) {
        finish({
          kind: 'retry',
          error: `could not send the enrollment request: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
      }
    });
  });
}

/**
 * Run the full round-trip. Factory-created sockets are retried and owned by this function; a
 * directly supplied socket is a one-shot, caller-owned compatibility path.
 */
export async function runCredentialExchange(opts: ExchangeOptions): Promise<ExchangeResult> {
  if (!opts.community.organizerPubkey) {
    return {ok: false, error: 'this community has no organizer mailbox — use manual exchange'};
  }
  if (!opts.socket && !opts.connect) {
    return {ok: false, error: 'no relay connection was provided for enrollment'};
  }

  const prepared = opts.prepared ?? (await prepareCredentialExchange(opts));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const attempts = Math.max(1, opts.attempts ?? (opts.connect ? DEFAULT_ATTEMPTS : 1));
  const backoffMs = Math.max(0, opts.backoffMs ?? DEFAULT_BACKOFF_MS);
  let last: Extract<AttemptOutcome, {kind: 'retry'}> = {
    kind: 'retry',
    error: 'the organizer did not respond in time',
    timedOut: true,
  };

  for (let i = 0; i < attempts; i++) {
    let socket: RelaySocket;
    try {
      socket = opts.connect ? await opts.connect() : opts.socket!;
    } catch (e) {
      last = {
        kind: 'retry',
        error: `could not open the Tor relay connection: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
      if (i < attempts - 1) {
        try {
          await opts.onRetry?.(i + 2, last.error);
        } catch {
          // Circuit rotation is best-effort; the next socket may still recover on its own.
        }
        await sleep(backoffMs);
      }
      continue;
    }

    let outcome: AttemptOutcome;
    try {
      outcome = await runOneAttempt(
        prepared,
        socket,
        timeoutMs,
        opts.onCircuitOpen,
        opts.onCircuitFailed,
      );
    } finally {
      if (opts.connect) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
    }

    if (outcome.kind === 'ok') {
      return {ok: true, session: outcome.session};
    }
    if (outcome.kind === 'error') {
      return {ok: false, error: outcome.error};
    }
    last = outcome;
    if (i < attempts - 1) {
      try {
        await opts.onRetry?.(i + 2, last.error);
      } catch {
        // Circuit rotation is best-effort; the next socket may still recover on its own.
      }
      await sleep(backoffMs);
    }
  }

  return {
    ok: false,
    error: last.error,
    ...(last.timedOut || opts.connect ? {timedOut: true} : {}),
  };
}

/**
 * Enrollment — the member's two-way blind-credential sign-up (PLAN.md §3.3).
 *
 * 1. begin(): generate the key ON-DEVICE, blind a random token, and produce the request QR
 *    the member shows the organizer.
 * 2. organizer scans it, blind-signs (issuer tool / cmd/issuer), and shows a response QR.
 * 3. complete(): unblind into a credential and build the one-time binding event (kind 9011)
 *    signed by the on-device key. Organizers never see the npub or the token.
 */
import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {randomBytes} from '../util/random';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {KIND_MEMBERSHIP_BINDING, TOKEN_BYTES, TAG_TOKEN, TAG_SIG} from '../contracts';
import type {BlindRsaClient} from './blindrsa';
import type {Community} from './community';

// The binding kind and token width are owned by the contract module (single source of truth,
// shared with the relay verifier); re-exported so existing importers/tests keep resolving them here.
export {KIND_MEMBERSHIP_BINDING, TOKEN_BYTES};

const REQ_PREFIX = 'stiq:cred-req:1;';
/** Wire prefix for the issuer's blind-signature response (manual QR and mailbox payloads). */
export const RESP_PREFIX = 'stiq:cred-resp:1;';

/**
 * Quantize to the nearest 6-hour block then randomly subtract 0 or 1 block.
 * This means the binding event timestamp can only be one of four values per day,
 * making sub-hour timing correlation impossible even for an organizer who logged
 * the exact moment they blind-signed.
 *
 * The jitter bit is drawn from the CSPRNG (randomBytes), not Math.random: this is an
 * anonymity/timing-correlation defence path, so no decision on it may depend on a
 * reconstructible non-cryptographic PRNG (audit #53), matching the CSPRNG discipline used
 * for token generation in this same flow.
 */
function jitteredTimestamp(): number {
  const BLOCK = 6 * 3600;
  const base = Math.floor(Math.floor(Date.now() / 1000) / BLOCK) * BLOCK;
  return base - ((randomBytes(1)[0]! & 1) ? BLOCK : 0);
}

export interface Credential {
  token: Uint8Array;
  signature: Uint8Array;
}

export interface Session {
  /** On-device secret key (in memory during enrollment; Step 7 stores it hardware-wrapped). */
  secretKey: Uint8Array;
  pubkey: string;
  npub: string;
  relayUrl: string;
  issuerPublicKey: string;
  /** Full community descriptor (relay + organizer identity), persisted in the community store. */
  community: Community;
  credential: Credential;
  /** Kind-9011 event to publish on first connect to bind this npub. */
  bindingEvent: Event;
}

export type CompleteResult =
  | {ok: true; session: Session}
  | {ok: false; error: string};

/** Build the response QR the issuer hands back (used by the issuer tool / tests). */
export function encodeIssuanceResponse(blindSignature: Uint8Array): string {
  return RESP_PREFIX + bytesToBase64(blindSignature);
}

export class Enrollment {
  private constructor(
    private readonly community: Community,
    private readonly blindRsa: BlindRsaClient,
    private readonly secretKey: Uint8Array,
    private readonly pubkey: string,
    private readonly prepared: Uint8Array,
    private readonly state: unknown,
  ) {}

  /** Start enrollment: generate the on-device key and the blinded membership request.
   *  inviteCode is the STIQ-XXXX-XXXX code the organizer issued — it is embedded in
   *  the request and validated (and spent) by the organizer before blind-signing. */
  static async begin(
    community: Community,
    blindRsa: BlindRsaClient,
    inviteCode: string,
  ): Promise<{enrollment: Enrollment; requestQr: string; blinded: Uint8Array}> {
    if (!community.issuerPublicKey) {
      // Defensive last-resort guard: a v2 join code may leave `issuerPublicKey` as the '' DEFERRED
      // sentinel until the caller has fetched + verified it against the pinned `cid` over Tor (see
      // App.tsx exchangeFnRef). Every real caller resolves it before reaching here — this only
      // stops an unresolved key from ever being blinded/signed against.
      throw new Error('community issuer key is not resolved yet');
    }
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const token = randomBytes(TOKEN_BYTES);
    const {prepared, blinded, state} = await blindRsa.blind(community.issuerPublicKey, token);
    const enrollment = new Enrollment(community, blindRsa, secretKey, pubkey, prepared, state);
    // `requestQr` is the manual-exchange payload (member shows it to the organizer); `blinded`
    // is the raw blinded token the automated mailbox exchange (exchange.ts) sends over Tor.
    return {enrollment, requestQr: REQ_PREFIX + inviteCode + ';' + bytesToBase64(blinded), blinded};
  }

  /** Finish with the organizer's response QR: unblind, then build the binding event. */
  async complete(responseQr: string): Promise<CompleteResult> {
    const trimmed = responseQr.trim();
    if (!trimmed.startsWith(RESP_PREFIX)) {
      return {ok: false, error: 'not a membership response code'};
    }
    let blindSignature: Uint8Array;
    try {
      blindSignature = base64ToBytes(trimmed.slice(RESP_PREFIX.length));
    } catch {
      return {ok: false, error: 'malformed response code'};
    }

    let signature: Uint8Array;
    try {
      signature = await this.blindRsa.finalize(this.state, blindSignature);
    } catch (e) {
      return {
        ok: false,
        error: `could not verify credential: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const credential: Credential = {token: this.prepared, signature};

    const bindingEvent = finalizeEvent(
      {
        kind: KIND_MEMBERSHIP_BINDING,
        created_at: jitteredTimestamp(),
        tags: [
          [TAG_TOKEN, bytesToBase64(credential.token)],
          [TAG_SIG, bytesToBase64(credential.signature)],
        ],
        content: '',
      },
      this.secretKey,
    );

    return {
      ok: true,
      session: {
        secretKey: this.secretKey,
        pubkey: this.pubkey,
        npub: nip19.npubEncode(this.pubkey),
        relayUrl: this.community.relayUrl,
        issuerPublicKey: this.community.issuerPublicKey,
        community: this.community,
        credential,
        bindingEvent,
      },
    };
  }
}

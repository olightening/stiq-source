import {finalizeEvent, generateSecretKey, getPublicKey, getEventHash} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {NativeModules} from 'react-native';
import {RSABSSA} from '@cloudflare/blindrsa-ts';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {sha256Hex} from '../util/hash';
import {utf8ToBytes} from '@noble/hashes/utils.js';
import {
  runTokenDraw,
  resumeTokenDraw,
  isStaleKeyDrawFailure,
  KIND_DRAW_REQUEST,
  KIND_DRAW_RESPONSE,
  type DrawMarker,
} from './drawExchange';
import {DrawErrorCode} from '../contracts';
import {CAPS_SCHEMA_ERROR_CODES} from '../nostr/capabilities';
import {countLeadingZeroBits} from '../dm/nip13';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {RealBlindRsa} from '../onboarding/blindrsaReal';
import {FakeRelaySocket} from '../nostr/socket.fake';
import type {Community} from '../onboarding/community';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise<void>(r => setTimeout(r, 5));
  }
}

function organizer() {
  const sk = generateSecretKey();
  return {sk, pub: getPublicKey(sk)};
}
function community(organizerPubkey?: string): Community {
  return {relayUrl: ONION, issuerPublicKey: 'ISSUER', organizerPubkey, name: 'Acme'};
}
const credential = {token: Uint8Array.of(1, 2, 3, 4), signature: Uint8Array.of(9, 9)};

function readSent(socket: FakeRelaySocket) {
  let subId = '';
  let request: any;
  for (const raw of socket.sent) {
    const arr = JSON.parse(raw);
    if (arr[0] === 'REQ') subId = arr[1];
    else if (arr[0] === 'EVENT' && arr[1]?.kind === KIND_DRAW_REQUEST) request = arr[1];
  }
  return {subId, request};
}

/** Craft the organizer's blind-signed response for a request, mock-signing each blinded token. */
function craftResponse(orgSk: Uint8Array, request: any, firstSigByte = 100) {
  const reqConvKey = nip44.utils.getConversationKey(orgSk, request.pubkey);
  const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {
    blinded: string[];
    replyPubkey: string;
  };
  const sigs = payload.blinded.map((_, i) => bytesToBase64(Uint8Array.of(firstSigByte + i)));
  const respConvKey = nip44.utils.getConversationKey(orgSk, payload.replyPubkey);
  const event = finalizeEvent(
    {
      kind: KIND_DRAW_RESPONSE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', payload.replyPubkey]],
      content: nip44.encrypt(JSON.stringify({sigs}), respConvKey),
    },
    orgSk,
  );
  return {payload, event};
}

/** Craft an organizer error/cap response (an over-quota rejection) addressed to the reply key. */
function craftErrorResponse(orgSk: Uint8Array, request: any, body: {error: string; cap?: number; code?: string}) {
  const reqConvKey = nip44.utils.getConversationKey(orgSk, request.pubkey);
  const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {replyPubkey: string};
  const respConvKey = nip44.utils.getConversationKey(orgSk, payload.replyPubkey);
  return finalizeEvent(
    {
      kind: KIND_DRAW_RESPONSE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', payload.replyPubkey]],
      content: nip44.encrypt(JSON.stringify(body), respConvKey),
    },
    orgSk,
  );
}

/** How many blinded tokens a draw request carries (decrypts the request as the organizer would). */
function readBlindedCount(orgSk: Uint8Array, request: any): number {
  const reqConvKey = nip44.utils.getConversationKey(orgSk, request.pubkey);
  const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {blinded: string[]};
  return payload.blinded.length;
}

/** Decrypt a draw request as the organizer would, exposing purpose + credential + blinded batch. */
function readPayload(
  orgSk: Uint8Array,
  request: any,
): {purpose?: string; credToken: string; credSig: string; blinded: string[]} {
  const reqConvKey = nip44.utils.getConversationKey(orgSk, request.pubkey);
  return JSON.parse(nip44.decrypt(request.content, reqConvKey));
}

/** MockBlindRsa that records WHICH issuer key each token was blinded under (token domain separation). */
class RecordingBlindRsa extends MockBlindRsa {
  readonly blindedUnder: string[] = [];
  override async blind(issuerPublicKey: string, token: Uint8Array) {
    this.blindedUnder.push(issuerPublicKey);
    return super.blind(issuerPublicKey, token);
  }
}

describe('runTokenDraw', () => {
  it('draws a batch of tokens and returns them for the wallet', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 42,
      count: 3,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(request).toBeDefined();
    expect(subId).toContain('draw:');

    // Organizer: decrypt, verify it carries the credential + N blinded tokens for the epoch.
    const reqConvKey = nip44.utils.getConversationKey(org.sk, request.pubkey);
    const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {
      credToken: string;
      credSig: string;
      epoch: number;
      blinded: string[];
      replyPubkey: string;
    };
    expect(payload.epoch).toBe(42);
    expect(payload.credToken).toBe(bytesToBase64(credential.token));
    expect(payload.blinded).toHaveLength(3);

    // Organizer blind-signs each blinded token and replies (mock: sign = pass-through bytes).
    socket.emitEvent(subId, craftResponse(org.sk, request).event);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens).toHaveLength(3);
      // With the mock, finalize passes the sig through and prepared === token.
      expect(result.tokens[0]!.sig[0]).toBe(100);
    }
  });

  // ── Audit finding #1: the finalize() loop (handleResponse, run the instant the organizer's 9025
  // lands) must yield a macrotask every FINALIZE_YIELD_EVERY tokens — mirroring the sibling blind()
  // loop's BLIND_YIELD_EVERY — instead of unblinding a whole batch as one unbroken JS-thread block.
  it('finalize() yields a macrotask mid-batch (finding #1) without dropping, reordering, or duplicating any token', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    // > FINALIZE_YIELD_EVERY (6) so the loop must yield at least once before finishing the batch.
    const BATCH = 8;

    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 7,
      count: BATCH,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(request).toBeDefined();
    expect(readBlindedCount(org.sk, request)).toBe(BATCH);

    // Only count setTimeout calls made from here on — everything before this point (PoW mining,
    // the blind() loop's own yields) is irrelevant to the claim under test. A manual monkeypatch
    // (not jest.spyOn) is used here: this custom RN jest environment's vm-contextified global
    // doesn't reliably let jest.spyOn intercept calls made from a DIFFERENT module's compiled code
    // (verified empirically — spyOn saw zero calls despite the yield demonstrably firing and
    // resuming), whereas a plain reassignment of `global.setTimeout` is a normal property write
    // every module's lookup honours.
    const originalSetTimeout = global.setTimeout;
    const delays: unknown[] = [];
    global.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      delays.push(ms);
      return originalSetTimeout(fn as never, ms, ...args);
    }) as typeof global.setTimeout;

    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    const result = await resultP;
    global.setTimeout = originalSetTimeout;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Correctness first: exactly BATCH tokens, still in the original order, none dropped or
    // duplicated — the yield must never reorder or skip an item.
    expect(result.tokens).toHaveLength(BATCH);
    for (let i = 0; i < BATCH; i++) {
      expect(result.tokens[i]!.sig[0]).toBe(100 + i); // craftResponse's firstSigByte=100 + index
    }
    // The yield actually happened: at least one real 0-delay macrotask hand-back occurred while
    // finalizing this response — the exact mechanism that lets a queued touch/frame interleave.
    expect(delays.filter(ms => ms === 0).length).toBeGreaterThanOrEqual(1);
  });

  it('mines the request via the async miner (StiqPow absent → JS fallback) with the same shape', async () => {
    // Jest has no native StiqPow, so mineEventPow must fall back to the chunked-yield JS miner.
    expect((NativeModules as {StiqPow?: unknown}).StiqPow).toBeUndefined();

    const org = organizer();
    const socket = new FakeRelaySocket();
    const difficulty = 8; // small so the JS fallback finishes fast, but > 0 so it actually mines.
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 7,
      count: 1,
      powDifficulty: difficulty,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {request} = readSent(socket);
    expect(request).toBeDefined();
    // Same mined shape as the old sync mineEvent path: a ['nonce', <value>, String(difficulty)]
    // tag whose event id clears the target leading-zero-bit count (the relay's exact check).
    const nonce = request.tags.find((t: string[]) => t[0] === 'nonce');
    expect(nonce).toBeDefined();
    expect(nonce![2]).toBe(String(difficulty));
    expect(countLeadingZeroBits(getEventHash(request))).toBeGreaterThanOrEqual(difficulty);

    // The mined event still round-trips to a real draw (the PoW carried through finalizeEvent).
    socket.emitEvent(readSent(socket).subId, craftResponse(org.sk, request).event);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens).toHaveLength(1);
  });

  it('times out when the organizer never responds', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 30,
    });
    await tick();
    socket.simulateOpen();
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);
  });

  it('surfaces a relay rejection of the draw request (fatal — does not retry)', async () => {
    const org = organizer();
    let opened = 0;
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => {
        opened += 1;
        return socket;
      },
      attempts: 4,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 1,
      count: 1,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {request} = readSent(socket);
    socket.emit(JSON.stringify(['OK', request.id, false, 'blocked: insufficient proof-of-work']));
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('insufficient proof-of-work');
    expect(opened).toBe(1); // a relay rejection is permanent — no wasteful re-attempts
  });

  it('recovers a response the organizer already stored, on a later attempt with the same reply key', async () => {
    // Attempt 1 sends the request but the 9025 is "lost" (never delivered); the organizer, though,
    // has already signed + stored it. Attempt 2 opens a FRESH socket and re-subscribes with the same
    // reply key — the relay replays the stored response, so the draw completes WITHOUT re-drawing.
    const org = organizer();
    const sockets: FakeRelaySocket[] = [];
    const resultP = runTokenDraw({
      connect: () => {
        const s = new FakeRelaySocket();
        sockets.push(s);
        return s;
      },
      attempts: 3,
      backoffMs: 5,
      timeoutMs: 50,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 5,
      count: 2,
      powDifficulty: 0,
    });

    // Attempt 1: open + send, but deliver NO response → it times out.
    await waitFor(() => sockets.length >= 1);
    sockets[0]!.simulateOpen();
    await tick();
    const {request: req1} = readSent(sockets[0]!);
    expect(req1).toBeDefined();
    // The relay would have this stored 9025 addressed to the (fixed) reply key.
    const stored = craftResponse(org.sk, req1, 50).event;

    // Attempt 2: a fresh socket opens and re-subscribes; the relay replays the stored response.
    await waitFor(() => sockets.length >= 2);
    const s2 = sockets[1]!;
    s2.simulateOpen();
    await tick();
    const {subId: sub2, request: req2} = readSent(s2);
    expect(req2.id).toBe(req1.id); // SAME signed request — the organizer would dedupe by id (no double charge)
    s2.emitEvent(sub2, stored);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens).toHaveLength(2);
      expect(result.tokens[0]!.sig[0]).toBe(50);
    }
  });

  it('re-draws a smaller batch when the organizer caps the per-epoch allowance', async () => {
    // The wallet asks for 10 but the community's quota only permits 4 more this epoch. The organizer
    // returns a `cap`; the client re-blinds a batch of exactly 4 (never bricking on the low quota).
    const org = organizer();
    const sockets: FakeRelaySocket[] = [];
    const resultP = runTokenDraw({
      connect: () => { const s = new FakeRelaySocket(); sockets.push(s); return s; },
      attempts: 2,
      backoffMs: 5,
      timeoutMs: 5_000,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 9,
      count: 10,
      powDifficulty: 0,
    });

    // Attempt 1 (batch of 10): organizer rejects, allowance is only 4.
    await waitFor(() => sockets.length >= 1);
    sockets[0]!.simulateOpen();
    await tick();
    const {subId: sub0, request: req0} = readSent(sockets[0]!);
    expect(readBlindedCount(org.sk, req0)).toBe(10);
    sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'epoch token limit reached (100/epoch)', cap: 4}));

    // Fresh socket, re-blinded batch of 4 — the organizer signs it.
    await waitFor(() => sockets.length >= 2);
    sockets[1]!.simulateOpen();
    await tick();
    const {subId: sub1, request: req1} = readSent(sockets[1]!);
    expect(readBlindedCount(org.sk, req1)).toBe(4);
    sockets[1]!.emitEvent(sub1, craftResponse(org.sk, req1, 70).event);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens).toHaveLength(4);
      expect(result.tokens[0]!.sig[0]).toBe(70);
    }
  });

  it('returns an empty draw (not an error) when the allowance is already spent (cap 0)', async () => {
    // The member already drew their full epoch quota: cap 0 means "nothing more to draw" — a valid
    // empty result, so the caller neither surfaces an error nor spins retrying.
    const org = organizer();
    let opened = 0;
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => { opened += 1; return socket; },
      attempts: 3,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 3,
      count: 8,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftErrorResponse(org.sk, request, {error: 'epoch token limit reached (8/epoch)', cap: 0}));

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens).toHaveLength(0);
    expect(opened).toBe(1); // cap 0 → no re-blind, no wasteful re-attempts
  });

  it('self-heals from the legacy error text when the organizer sends no cap field', async () => {
    // A federated community may run an organizer that predates the `cap` field. The client recovers
    // the allowance from the "draw at most N" message so it still shrinks the batch instead of failing.
    const org = organizer();
    const sockets: FakeRelaySocket[] = [];
    const resultP = runTokenDraw({
      connect: () => { const s = new FakeRelaySocket(); sockets.push(s); return s; },
      attempts: 2,
      backoffMs: 5,
      timeoutMs: 5_000,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 11,
      count: 9,
      powDifficulty: 0,
    });
    await waitFor(() => sockets.length >= 1);
    sockets[0]!.simulateOpen();
    await tick();
    const {subId: sub0, request: req0} = readSent(sockets[0]!);
    sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'draw at most 3 tokens per request'}));

    await waitFor(() => sockets.length >= 2);
    sockets[1]!.simulateOpen();
    await tick();
    const {subId: sub1, request: req1} = readSent(sockets[1]!);
    expect(readBlindedCount(org.sk, req1)).toBe(3);
    sockets[1]!.emitEvent(sub1, craftResponse(org.sk, req1, 80).event);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tokens).toHaveLength(3);
  });

  it('surfaces a non-cap organizer error as fatal (does not retry)', async () => {
    const org = organizer();
    let opened = 0;
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => { opened += 1; return socket; },
      attempts: 4,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftErrorResponse(org.sk, request, {error: 'invalid membership credential'}));

    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid membership credential');
    expect(opened).toBe(1); // a non-cap error is permanent — no re-attempts
  });

  // capFromResponse's LEGACY prose scrape (`/at most N/`) is schema-gated (C3): below
  // CAPS_SCHEMA_ERROR_CODES it self-heals from the error text; at/above it the organizer guarantees
  // the structured `cap` field, so a cap-less error is fatal instead of prose-scraped. The structured
  // `cap` is always preferred either way.
  describe('capFromResponse schema gate (C3)', () => {
    it('AT/ABOVE schema: a cap-LESS "at most N" prose error is fatal — NO prose scrape, no re-blind', async () => {
      const org = organizer();
      const sockets: FakeRelaySocket[] = [];
      const resultP = runTokenDraw({
        connect: () => { const s = new FakeRelaySocket(); sockets.push(s); return s; },
        attempts: 2,
        backoffMs: 5,
        timeoutMs: 5_000,
        community: community(org.pub),
        blindRsa: new MockBlindRsa(),
        credential,
        epoch: 12,
        count: 9,
        powDifficulty: 0,
        capsSchemaVersion: CAPS_SCHEMA_ERROR_CODES,
      });
      await waitFor(() => sockets.length >= 1);
      sockets[0]!.simulateOpen();
      await tick();
      const {subId: sub0, request: req0} = readSent(sockets[0]!);
      sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'draw at most 3 tokens per request'}));

      const result = await resultP;
      expect(result.ok).toBe(false); // machine `cap` guaranteed → cap-less error is a genuine failure
      if (!result.ok) expect(result.error).toContain('draw at most 3');
      expect(sockets.length).toBe(1); // never re-blinded a smaller batch (no scraped cap)
    });

    it('AT/ABOVE schema: the STRUCTURED `cap` field is still honoured (re-blinds the smaller batch)', async () => {
      const org = organizer();
      const sockets: FakeRelaySocket[] = [];
      const resultP = runTokenDraw({
        connect: () => { const s = new FakeRelaySocket(); sockets.push(s); return s; },
        attempts: 2,
        backoffMs: 5,
        timeoutMs: 5_000,
        community: community(org.pub),
        blindRsa: new MockBlindRsa(),
        credential,
        epoch: 13,
        count: 10,
        powDifficulty: 0,
        capsSchemaVersion: CAPS_SCHEMA_ERROR_CODES,
      });
      await waitFor(() => sockets.length >= 1);
      sockets[0]!.simulateOpen();
      await tick();
      const {subId: sub0, request: req0} = readSent(sockets[0]!);
      // Prose says "at most 3" but the structured cap says 4 — the structured field must win.
      sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'draw at most 3 tokens per request', cap: 4}));

      await waitFor(() => sockets.length >= 2);
      sockets[1]!.simulateOpen();
      await tick();
      const {subId: sub1, request: req1} = readSent(sockets[1]!);
      expect(readBlindedCount(org.sk, req1)).toBe(4); // re-blinds `cap`, NOT the prose "3"
      sockets[1]!.emitEvent(sub1, craftResponse(org.sk, req1, 90).event);

      const result = await resultP;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tokens).toHaveLength(4);
    });

    it('BELOW schema (default 0): the legacy prose scrape still self-heals the batch', async () => {
      const org = organizer();
      const sockets: FakeRelaySocket[] = [];
      const resultP = runTokenDraw({
        connect: () => { const s = new FakeRelaySocket(); sockets.push(s); return s; },
        attempts: 2,
        backoffMs: 5,
        timeoutMs: 5_000,
        community: community(org.pub),
        blindRsa: new MockBlindRsa(),
        credential,
        epoch: 14,
        count: 9,
        powDifficulty: 0,
        // capsSchemaVersion omitted → 0 → below the gate → prose scrape active (byte-identical to before).
      });
      await waitFor(() => sockets.length >= 1);
      sockets[0]!.simulateOpen();
      await tick();
      const {subId: sub0, request: req0} = readSent(sockets[0]!);
      sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'draw at most 3 tokens per request'}));

      await waitFor(() => sockets.length >= 2);
      sockets[1]!.simulateOpen();
      await tick();
      const {subId: sub1, request: req1} = readSent(sockets[1]!);
      expect(readBlindedCount(org.sk, req1)).toBe(3); // scraped the "at most 3" allowance
      sockets[1]!.emitEvent(sub1, craftResponse(org.sk, req1, 80).event);

      const result = await resultP;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tokens).toHaveLength(3);
    });
  });
});

// Token domain separation (#3/#4/#29): the tokens a draw MINTS are blinded under a purpose key
// (K_post for posts, K_read for reads) while the membership credential that AUTHORIZES the draw stays
// the K_enroll enrollment credential. When the community carries no purpose key, both fall back to
// `issuerPublicKey`, so a single-key deployment is byte-identical to before.
describe('runTokenDraw — token domain separation (#3/#4/#29)', () => {
  const withKeys = (organizerPubkey: string): Community => ({
    relayUrl: ONION,
    issuerPublicKey: 'K_ENROLL',
    organizerPubkey,
    postIssuerPublicKey: 'K_POST',
    readIssuerPublicKey: 'K_READ',
  });
  const singleKey = (organizerPubkey: string): Community => ({
    relayUrl: ONION,
    issuerPublicKey: 'K_ENROLL',
    organizerPubkey,
  });

  it('C5 read-gate: purpose:read + no rk + advertised read fingerprint → errors, never blinds/connects', async () => {
    const org = organizer();
    const rec = new RecordingBlindRsa();
    const result = await runTokenDraw({
      // A connect that throws proves the gate returns BEFORE any socket is opened / token blinded.
      connect: () => {
        throw new Error('read-gate must not open a socket');
      },
      attempts: 1,
      community: singleKey(org.pub), // no readIssuerPublicKey (`rk`)
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 3,
      purpose: 'read',
      readFingerprint: 'FP_READ_ADVERTISED', // relay advertised a read fingerprint → domain sep known
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ok: false, error: 'community mis-provisioned — update your invite', code: 'mis-provisioned'});
    expect(rec.blindedUnder).toEqual([]); // nothing was blinded under the enroll/posting key
  });

  it('C5 read-gate: NO advertised read fingerprint (caps fallback) → falls back to K_enroll blinding, unchanged', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: singleKey(org.pub), // no rk
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 2,
      purpose: 'read',
      // readFingerprint omitted (relay advertised none) → gate off; today's fallback stands.
      powDifficulty: 0,
      timeoutMs: 30, // settle fast (no response) so no timer leaks past the test
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {request} = readSent(socket);
    expect(request).toBeDefined(); // it DID proceed to send a request
    expect(rec.blindedUnder).toEqual(['K_ENROLL', 'K_ENROLL']); // fell back to the single issuer key
    await expect(resultP).resolves.toEqual(expect.objectContaining({ok: false})); // round-trip times out
  });

  it('C5 read-gate: read fingerprint advertised AND rk present → no gate, blinds under K_read', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: withKeys(org.pub), // carries readIssuerPublicKey = 'K_READ'
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 2,
      purpose: 'read',
      readFingerprint: 'FP_READ_ADVERTISED',
      powDifficulty: 0,
      timeoutMs: 30, // settle fast (no response) so no timer leaks past the test
    });
    await tick();
    socket.simulateOpen();
    await tick();
    expect(rec.blindedUnder).toEqual(['K_READ', 'K_READ']); // proceeded normally under K_read
    await expect(resultP).resolves.toEqual(expect.objectContaining({ok: false}));
  });

  it('blinds posting tokens under K_post and sends purpose:post', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: withKeys(org.pub),
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 3,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    // Every token was blinded under K_post — never the enrollment or read key.
    expect(rec.blindedUnder).toEqual(['K_POST', 'K_POST', 'K_POST']);
    const payload = readPayload(org.sk, request);
    expect(payload.purpose).toBe('post');
    // The membership credential is presented verbatim (K_enroll), unchanged by domain separation.
    expect(payload.credToken).toBe(bytesToBase64(credential.token));
    expect(payload.credSig).toBe(bytesToBase64(credential.signature));

    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    expect((await resultP).ok).toBe(true);
  });

  it('falls back to the enrollment key for a post draw when K_post is absent (single-key)', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: singleKey(org.pub),
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(rec.blindedUnder).toEqual(['K_ENROLL', 'K_ENROLL']); // fallback to issuerPublicKey
    expect(readPayload(org.sk, request).purpose).toBe('post');
    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    expect((await resultP).ok).toBe(true);
  });

  it('blinds read tokens under K_read and sends purpose:read', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: withKeys(org.pub),
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
      purpose: 'read',
    });
    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(rec.blindedUnder).toEqual(['K_READ', 'K_READ']);
    expect(readPayload(org.sk, request).purpose).toBe('read');
    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    expect((await resultP).ok).toBe(true);
  });

  it('falls back to the enrollment key for a read draw when K_read is absent', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const rec = new RecordingBlindRsa();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: singleKey(org.pub),
      blindRsa: rec,
      credential,
      epoch: 1,
      count: 1,
      powDifficulty: 0,
      timeoutMs: 5_000,
      purpose: 'read',
    });
    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(rec.blindedUnder).toEqual(['K_ENROLL']); // fallback, but still purpose:read on the wire
    expect(readPayload(org.sk, request).purpose).toBe('read');
    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    expect((await resultP).ok).toBe(true);
  });

  it('presents the SAME K_enroll credential for a post and a read draw (credential unchanged)', async () => {
    const org = organizer();

    async function drawAndReadRequest(purpose: 'post' | 'read', rec: RecordingBlindRsa) {
      const socket = new FakeRelaySocket();
      const resultP = runTokenDraw({
        connect: () => socket,
        attempts: 1,
        community: withKeys(org.pub),
        blindRsa: rec,
        credential,
        epoch: 4,
        count: 1,
        powDifficulty: 0,
        timeoutMs: 5_000,
        purpose,
      });
      await tick();
      socket.simulateOpen();
      await tick();
      const {subId, request} = readSent(socket);
      socket.emitEvent(subId, craftResponse(org.sk, request).event);
      await resultP;
      return readPayload(org.sk, request);
    }

    const postRec = new RecordingBlindRsa();
    const readRec = new RecordingBlindRsa();
    const postReq = await drawAndReadRequest('post', postRec);
    const readReq = await drawAndReadRequest('read', readRec);

    // The MINTING key differs by purpose…
    expect(postRec.blindedUnder).toEqual(['K_POST']);
    expect(readRec.blindedUnder).toEqual(['K_READ']);
    // …but the credential that AUTHORIZES both draws is the identical K_enroll credential.
    expect(postReq.credToken).toBe(bytesToBase64(credential.token));
    expect(postReq.credSig).toBe(bytesToBase64(credential.signature));
    expect(readReq.credToken).toBe(postReq.credToken);
    expect(readReq.credSig).toBe(postReq.credSig);
  });

  // T1.5/F7: the swk write-gate (hasDomainSepKeys, drawExchange.ts:~471) used to EXCLUDE `post`, so a
  // domain-sep community missing its dedicated post key silently fell back to blinding under K_enroll
  // — the organizer signs with K_post, finalize() then fails RFC-9474 verification, and feed posting
  // bricks with no diagnosis. This section proves: (1) the same gate already protected space-write
  // (untested until now), and (2) `post` gets the identical protection as of this fix.
  describe('C5 write-gate (T1.5/F7): missing purpose key under domain-sep fails clean, never mis-blinds', () => {
    it('space-write purpose + domain-sep community missing swk → errors, never blinds/connects', async () => {
      const org = organizer();
      const rec = new RecordingBlindRsa();
      const domainSepNoSwk: Community = {
        relayUrl: ONION,
        issuerPublicKey: 'K_ENROLL',
        organizerPubkey: org.pub,
        postIssuerPublicKey: 'K_POST', // proves domain sep is on (at least one OTHER purpose key)
        // spaceWriteIssuerPublicKey intentionally ABSENT
      };
      const result = await runTokenDraw({
        // A connect that throws proves the gate returns BEFORE any socket is opened / token blinded.
        connect: () => {
          throw new Error('write-gate must not open a socket');
        },
        attempts: 1,
        community: domainSepNoSwk,
        blindRsa: rec,
        credential,
        epoch: 1,
        count: 3,
        purpose: 'space-write',
        powDifficulty: 0,
        timeoutMs: 5_000,
      });
      expect(result).toEqual({ok: false, error: 'community mis-provisioned — update your invite', code: 'mis-provisioned'});
      expect(rec.blindedUnder).toEqual([]); // nothing was blinded under the enroll/post key
    });

    it('blinds space-write tokens under K_spacewrite and sends purpose:space-write when swk IS present', async () => {
      const org = organizer();
      const socket = new FakeRelaySocket();
      const rec = new RecordingBlindRsa();
      const withSwk: Community = {
        relayUrl: ONION,
        issuerPublicKey: 'K_ENROLL',
        organizerPubkey: org.pub,
        spaceWriteIssuerPublicKey: 'K_SPACEWRITE',
      };
      const resultP = runTokenDraw({
        connect: () => socket,
        attempts: 1,
        community: withSwk,
        blindRsa: rec,
        credential,
        epoch: 1,
        count: 2,
        purpose: 'space-write',
        powDifficulty: 0,
        timeoutMs: 5_000,
      });
      await tick();
      socket.simulateOpen();
      await tick();
      const {subId, request} = readSent(socket);
      expect(rec.blindedUnder).toEqual(['K_SPACEWRITE', 'K_SPACEWRITE']);
      expect(readPayload(org.sk, request).purpose).toBe('space-write');
      socket.emitEvent(subId, craftResponse(org.sk, request).event);
      expect((await resultP).ok).toBe(true);
    });

    it('F7 FIX: post purpose + domain-sep community missing pk → errors, never blinds/connects (previously excluded)', async () => {
      // Before T1.5, `post` was explicitly excluded from this gate (`drawPurpose !== 'post'`), so this
      // exact scenario — domain sep clearly ON (a READ key present) but the dedicated POST key absent —
      // silently fell back to blinding under K_ENROLL. This test proves the carve-out is gone: the draw
      // now fails clean, before ever opening a socket or blinding under the wrong key.
      const org = organizer();
      const rec = new RecordingBlindRsa();
      const domainSepNoPk: Community = {
        relayUrl: ONION,
        issuerPublicKey: 'K_ENROLL',
        organizerPubkey: org.pub,
        readIssuerPublicKey: 'K_READ', // proves domain sep is on (at least one OTHER purpose key)
        // postIssuerPublicKey intentionally ABSENT — the exact F7 scenario
      };
      const result = await runTokenDraw({
        connect: () => {
          throw new Error('write-gate must not open a socket');
        },
        attempts: 1,
        community: domainSepNoPk,
        blindRsa: rec,
        credential,
        epoch: 1,
        count: 3,
        // purpose omitted → defaults to 'post'
        powDifficulty: 0,
        timeoutMs: 5_000,
      });
      expect(result).toEqual({ok: false, error: 'community mis-provisioned — update your invite', code: 'mis-provisioned'});
      expect(rec.blindedUnder).toEqual([]); // nothing was blinded under the enroll key
    });
  });
});

// F10 (TOKEN_FIXING_PLAN.md T3.1) — durable draw staging: a freshly-blinded, organizer-signed batch
// otherwise lives only in the JS heap between the 9025 response and wallet.add(). These tests prove
// (a) the marker onMarker hands the caller carries everything finalize() needs, staged BEFORE the
// mailbox round-trip, and (b) resumeTokenDraw can recover a batch from that marker alone — including a
// REAL blind-RSA round trip, so a mistake in reconstructing the RSA blinding state would show up as a
// failed unblind, not just a type error.
describe('F10 durable draw staging: onMarker', () => {
  it('is called with a complete marker BEFORE any socket is opened', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    let connectCalls = 0;
    let captured: DrawMarker | undefined;
    const resultP = runTokenDraw({
      connect: () => {
        connectCalls++;
        return socket;
      },
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 20,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
      onMarker: async m => {
        expect(connectCalls).toBe(0); // staged before the mailbox round-trip, not after
        captured = m;
      },
    });

    await tick();
    socket.simulateOpen();
    await tick();

    expect(captured).toBeDefined();
    const marker = captured!;
    expect(marker.epoch).toBe(20);
    expect(marker.purpose).toBe('post');
    expect(marker.organizerPubkey).toBe(org.pub);
    expect(marker.credId).toBe(sha256Hex(credential.token)); // matches an independent recomputation
    expect(marker.requestEvent.kind).toBe(KIND_DRAW_REQUEST);
    expect(marker.requestEvent.id).toBeTruthy();
    expect(marker.replyPubkey).toBeTruthy();
    expect(marker.respConvKey).toBeTruthy();
    expect(marker.items).toHaveLength(2);
    for (const item of marker.items) {
      // Every field finalize() needs: the blinded value, the RSA unblinding secret, the plaintext
      // token, AND the holder-bound ownership secret — not just the blinded messages (Fable NB-4).
      expect(typeof item.prepared).toBe('string');
      expect(typeof item.blinded).toBe('string');
      expect(typeof item.blindingSecret).toBe('string');
      expect(typeof item.secret).toBe('string');
    }
    // reqHash matches an independent recomputation over the same blinded-array shape the organizer
    // itself hashes for its dedup key (organizer-server.mjs's reqHash).
    const expectedReqHash = sha256Hex(utf8ToBytes(JSON.stringify(marker.items.map(i => i.blinded))));
    expect(marker.reqHash).toBe(expectedReqHash);

    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    expect((await resultP).ok).toBe(true);
  });

  it('a cap-adjustment rebuild calls onMarker again with the smaller session (overwrite semantics)', async () => {
    const org = organizer();
    const sockets: FakeRelaySocket[] = [];
    const markers: DrawMarker[] = [];
    const resultP = runTokenDraw({
      connect: () => {
        const s = new FakeRelaySocket();
        sockets.push(s);
        return s;
      },
      attempts: 2,
      backoffMs: 5,
      timeoutMs: 5_000,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 21,
      count: 10,
      powDifficulty: 0,
      onMarker: async m => {
        markers.push(m);
      },
    });

    await waitFor(() => sockets.length >= 1);
    sockets[0]!.simulateOpen();
    await tick();
    const {subId: sub0, request: req0} = readSent(sockets[0]!);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.items).toHaveLength(10);
    sockets[0]!.emitEvent(sub0, craftErrorResponse(org.sk, req0, {error: 'epoch token limit reached (100/epoch)', cap: 4}));

    await waitFor(() => sockets.length >= 2);
    sockets[1]!.simulateOpen();
    await tick();
    const {subId: sub1, request: req1} = readSent(sockets[1]!);
    expect(markers).toHaveLength(2); // rebuilt session staged its OWN marker
    expect(markers[1]!.items).toHaveLength(4);
    sockets[1]!.emitEvent(sub1, craftResponse(org.sk, req1, 70).event);

    expect((await resultP).ok).toBe(true);
  });
});

describe('F10 durable draw staging: resumeTokenDraw', () => {
  /** Build a marker via a real (mock-crypto) draw whose original attempt never gets a response —
   *  models "the process died before the organizer answered" without needing real RSA for tests that
   *  only care about resumeTokenDraw's outcome plumbing, not the unblind math itself. */
  async function captureMarker(count = 2): Promise<{marker: DrawMarker; org: ReturnType<typeof organizer>}> {
    const org = organizer();
    const socket = new FakeRelaySocket();
    let captured: DrawMarker | undefined;
    const p = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 40,
      count,
      powDifficulty: 0,
      timeoutMs: 20,
      onMarker: async m => {
        captured = m;
      },
    });
    await tick();
    socket.simulateOpen();
    const result = await p; // no response ever delivered → times out fast
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);
    return {marker: captured!, org};
  }

  it('a fatal organizer rejection resolves WITHOUT timedOut — the caller should clear the marker', async () => {
    const {marker, org} = await captureMarker();
    const socket = new FakeRelaySocket();
    const resumeP = resumeTokenDraw(marker, {
      connect: () => socket,
      blindRsa: new MockBlindRsa(),
      attempts: 2,
      backoffMs: 5,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    expect(request.id).toBe(marker.requestEvent.id); // byte-identical replay of the original request
    socket.emitEvent(subId, craftErrorResponse(org.sk, request, {error: 'invalid membership credential'}));

    const result = await resumeP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBeFalsy();
      expect(result.error).toContain('invalid membership credential');
    }
  });

  it('a cap response resolves WITHOUT timedOut (never charged — safe to abandon)', async () => {
    const {marker, org} = await captureMarker();
    const socket = new FakeRelaySocket();
    const resumeP = resumeTokenDraw(marker, {
      connect: () => socket,
      blindRsa: new MockBlindRsa(),
      attempts: 2,
      backoffMs: 5,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftErrorResponse(org.sk, request, {error: 'epoch token limit reached (0/epoch)', cap: 0}));

    const result = await resumeP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBeFalsy();
      expect(result.error).toContain('cap');
    }
  });

  it('exhausting every attempt with no answer resolves timedOut:true — the caller must KEEP the marker', async () => {
    const {marker} = await captureMarker();
    const socket = new FakeRelaySocket();
    const result = await resumeTokenDraw(marker, {
      connect: () => socket,
      blindRsa: new MockBlindRsa(),
      attempts: 1,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.timedOut).toBe(true);
  });

  it('recovers a response the organizer already stored, on a fresh socket with the replayed request', async () => {
    // Mirrors the existing "recovers a response the organizer already stored" runTokenDraw test, but
    // for the COLD-START path: the marker alone (no in-memory session) must be enough to re-subscribe
    // with the same reply key and finalize the already-stored 9025.
    const {marker, org} = await captureMarker(3);
    const socket = new FakeRelaySocket();
    const resumeP = resumeTokenDraw(marker, {
      connect: () => socket,
      blindRsa: new MockBlindRsa(),
      attempts: 1,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    expect(request.id).toBe(marker.requestEvent.id);
    socket.emitEvent(subId, craftResponse(org.sk, request, 33).event);

    const result = await resumeP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens).toHaveLength(3);
      expect(result.tokens[0]!.sig[0]).toBe(33);
    }
  });

  it('REAL blind-RSA round trip: a resumed draw finalizes a batch the organizer signs for real, after a fresh restart (no shared in-memory state)', async () => {
    // The critical correctness test: if rebuildState() reconstructed the wrong RSA blinding state
    // (inv / imported public key / prepared message) from the marker alone, blindrsa-ts's finalize()
    // internally re-verifies the unblinded signature (RSASSA-PSS-VERIFY) and THROWS — so a passing
    // result here is proof the marker carries everything needed to unblind, not just that the code
    // compiles.
    const org = organizer();
    const suite = RSABSSA.SHA384.PSS.Deterministic();
    const kp = (await crypto.subtle.generateKey(
      {name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384'},
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const issuerPubB64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));
    const realCommunity: Community = {relayUrl: ONION, issuerPublicKey: issuerPubB64, organizerPubkey: org.pub};

    let captured: DrawMarker | undefined;
    const firstSocket = new FakeRelaySocket();
    const firstAttempt = runTokenDraw({
      connect: () => firstSocket,
      attempts: 1,
      community: realCommunity,
      blindRsa: new RealBlindRsa(),
      credential,
      epoch: 30,
      count: 3,
      powDifficulty: 0,
      timeoutMs: 30, // nobody ever answers this original attempt — models the kill
      onMarker: async m => {
        captured = m;
      },
    });
    // Real WebCrypto RSA blinding (x3) + key import can take longer than a couple of microtask ticks,
    // so poll rather than assume a fixed number of ticks is enough — simulateOpen() is safe to call
    // before onOpen() is even registered (FakeRelaySocket latches `isOpen` and fires on registration).
    firstSocket.simulateOpen();
    await waitFor(() => firstSocket.sent.length > 0, 10_000);
    const first = readSent(firstSocket);
    expect(first.request).toBeDefined();

    const firstResult = await firstAttempt;
    expect(firstResult.ok).toBe(false);
    if (!firstResult.ok) expect(firstResult.timedOut).toBe(true);
    expect(captured).toBeDefined();

    // "Cold start": resume from the persisted marker on a FRESH socket + a FRESH RealBlindRsa instance
    // (a brand new instance, with its own empty importedKeys cache — proving nothing carried over
    // except what the marker itself contains).
    const secondSocket = new FakeRelaySocket();
    const resumeP = resumeTokenDraw(captured!, {
      connect: () => secondSocket,
      blindRsa: new RealBlindRsa(),
      attempts: 1,
      timeoutMs: 5_000,
    });
    secondSocket.simulateOpen();
    await waitFor(() => secondSocket.sent.length > 0, 10_000);
    const second = readSent(secondSocket);
    expect(second.request.id).toBe(first.request.id); // byte-identical replay — the organizer's own
    // reqHash/event-id dedupe means this never re-charges the epoch quota.

    // The organizer blind-signs the (replayed) request for real.
    const reqConvKey = nip44.utils.getConversationKey(org.sk, second.request.pubkey);
    const payload = JSON.parse(nip44.decrypt(second.request.content, reqConvKey)) as {
      blinded: string[];
      replyPubkey: string;
    };
    const sigs: string[] = [];
    for (const b of payload.blinded) {
      const sig = await suite.blindSign(kp.privateKey, base64ToBytes(b));
      sigs.push(bytesToBase64(sig));
    }
    const respConvKey = nip44.utils.getConversationKey(org.sk, payload.replyPubkey);
    const responseEvent = finalizeEvent(
      {
        kind: KIND_DRAW_RESPONSE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', payload.replyPubkey]],
        content: nip44.encrypt(JSON.stringify({sigs}), respConvKey),
      },
      org.sk,
    );
    secondSocket.emitEvent(second.subId, responseEvent);

    const resumed = await resumeP;
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.tokens).toHaveLength(3);
      for (const t of resumed.tokens) {
        // A full 2048-bit RSA signature that passed finalize()'s internal PSS verification.
        expect(t.sig.length).toBe(256);
      }
    }
  }, 20000);
});

// The 2026-07-21 wrong-key incident contract: an organizer that can't sign a batch because the
// client blinded under a stale/wrong key returns code:'stale-blind-key' next to its error string;
// a client whose unblind fails (the SILENT half of the same condition) self-classifies
// 'unblind-failed'; and isStaleKeyDrawFailure is the single classifier the runtime's healed-draw
// path keys its token-keys re-sync + one retry on — including the legacy-prose fallback for an
// organizer that predates the code field.
describe('stale-key draw classification (2026-07-21 incident)', () => {
  it("threads the organizer's code:'stale-blind-key' through to the DrawResult", async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(
      subId,
      craftErrorResponse(org.sk, request, {
        error: 'could not sign token batch: signature representative out of range',
        code: 'stale-blind-key',
      }),
    );
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(DrawErrorCode.StaleBlindKey);
      expect(result.timedOut).toBeFalsy(); // fatal, not a retry loop — the OLD bug spun here forever
    }
    expect(isStaleKeyDrawFailure(result)).toBe(true);
  });

  it('legacy organizer (no code field): the prose "signature representative out of range" still classifies', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new MockBlindRsa(),
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(
      subId,
      craftErrorResponse(org.sk, request, {error: 'signature representative out of range'}),
    );
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBeUndefined();
    expect(isStaleKeyDrawFailure(result)).toBe(true);
  });

  it("a client-side unblind failure classifies as code:'unblind-failed' (the silent wrong-key half)", async () => {
    // The organizer answered with well-formed signatures, but they don't verify under the key WE
    // blinded with — exactly what a wrong-modulus blind produces about half the time. Before the
    // incident fix this surfaced as an opaque fatal error no self-heal could key on.
    class UnblindThrows extends MockBlindRsa {
      override async finalize(): Promise<Uint8Array> {
        throw new Error('PSS verification failed');
      }
    }
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runTokenDraw({
      connect: () => socket,
      attempts: 1,
      community: community(org.pub),
      blindRsa: new UnblindThrows(),
      credential,
      epoch: 1,
      count: 2,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftResponse(org.sk, request).event);
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(DrawErrorCode.UnblindFailed);
      expect(result.error).toContain('could not unblind tokens');
    }
    expect(isStaleKeyDrawFailure(result)).toBe(true);
  });

  it('does NOT classify unrelated fatal errors or successes as stale-key', async () => {
    expect(isStaleKeyDrawFailure({ok: true, tokens: []})).toBe(false);
    expect(isStaleKeyDrawFailure({ok: false, error: 'invalid membership credential'})).toBe(false);
    expect(isStaleKeyDrawFailure({ok: false, error: 'the organizer did not respond in time', timedOut: true})).toBe(false);
    // The C5 gates' mis-provision code IS the family (same remedy: re-sync keys, retry once).
    expect(
      isStaleKeyDrawFailure({ok: false, error: 'community mis-provisioned — update your invite', code: 'mis-provisioned'}),
    ).toBe(true);
  });
});

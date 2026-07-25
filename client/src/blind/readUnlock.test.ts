import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {bytesToBase64} from '../util/base64';
import {runReadUnlock, KIND_UNLOCK_REQUEST, KIND_UNLOCK_RESPONSE} from './readUnlock';
import {mintContentKey} from './contentKey';
import {FakeRelaySocket} from '../nostr/socket.fake';
import type {Token} from './wallet';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function organizer() {
  const sk = generateSecretKey();
  return {sk, pub: getPublicKey(sk)};
}

const readToken: Token = {token: Uint8Array.of(1, 2, 3, 4), sig: Uint8Array.of(9, 9), secret: Uint8Array.of(5, 6, 7, 8)};

function readSent(socket: FakeRelaySocket) {
  let subId = '';
  let request: any;
  for (const raw of socket.sent) {
    const arr = JSON.parse(raw);
    if (arr[0] === 'REQ') subId = arr[1];
    else if (arr[0] === 'EVENT' && arr[1]?.kind === KIND_UNLOCK_REQUEST) request = arr[1];
  }
  return {subId, request};
}

/** Craft the organizer's K_E response (or an error) addressed to the request's reply key. */
function craftResponse(orgSk: Uint8Array, request: any, body: {key?: Uint8Array; epoch?: number; error?: string}) {
  const reqConvKey = nip44.utils.getConversationKey(orgSk, request.pubkey);
  const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {epoch: number; replyPubkey: string};
  const respConvKey = nip44.utils.getConversationKey(orgSk, payload.replyPubkey);
  const json: Record<string, unknown> = {};
  if (body.key) json.key = bytesToBase64(body.key);
  if (body.epoch !== undefined) json.epoch = body.epoch;
  if (body.error) json.error = body.error;
  const event = finalizeEvent(
    {
      kind: KIND_UNLOCK_RESPONSE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', payload.replyPubkey]],
      content: nip44.encrypt(JSON.stringify(json), respConvKey),
    },
    orgSk,
  );
  return {payload, event};
}

describe('runReadUnlock', () => {
  it('spends a read-token and returns the epoch content key', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const epochKey = mintContentKey();

    const resultP = runReadUnlock({
      connect: () => socket,
      attempts: 1,
      organizerPubkey: org.pub,
      token: readToken,
      epoch: 5,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(request).toBeDefined();
    expect(subId).toContain('unlock:');

    // Organizer sees the read-token + requested epoch, and cannot see any npub.
    const reqConvKey = nip44.utils.getConversationKey(org.sk, request.pubkey);
    const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {
      token: string;
      sig: string;
      epoch: number;
    };
    expect(payload.epoch).toBe(5);
    expect(payload.token).toBe(bytesToBase64(readToken.token));

    socket.emitEvent(subId, craftResponse(org.sk, request, {key: epochKey, epoch: 5}).event);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.epoch).toBe(5);
      expect(result.key).toEqual(epochKey);
    }
  });

  it('surfaces an organizer error (spent token) as a fatal failure', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();

    const resultP = runReadUnlock({
      connect: () => socket,
      attempts: 1,
      organizerPubkey: org.pub,
      token: readToken,
      epoch: 5,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    socket.emitEvent(subId, craftResponse(org.sk, request, {error: 'read-token already spent'}).event);

    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already spent');
  });

  it('rejects a wrong-length key from the organizer', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();

    const resultP = runReadUnlock({
      connect: () => socket,
      attempts: 1,
      organizerPubkey: org.pub,
      token: readToken,
      epoch: 1,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    // Matching epoch so the wrong-length check (not the epoch check) is what fires here.
    socket.emitEvent(subId, craftResponse(org.sk, request, {key: Uint8Array.of(1, 2, 3), epoch: 1}).event);

    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('wrong-length');
  });

  it('rejects a key returned for the wrong epoch (#47)', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const epochKey = mintContentKey();

    const resultP = runReadUnlock({
      connect: () => socket,
      attempts: 1,
      organizerPubkey: org.pub,
      token: readToken,
      epoch: 5,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick();
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    // A well-formed key, but addressed to a DIFFERENT epoch than requested — must not be cached
    // under the requested epoch.
    socket.emitEvent(subId, craftResponse(org.sk, request, {key: epochKey, epoch: 9}).event);

    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('wrong epoch');
  });

  it('fails with no organizer mailbox', async () => {
    const result = await runReadUnlock({
      connect: () => new FakeRelaySocket(),
      organizerPubkey: '',
      token: readToken,
      epoch: 0,
      powDifficulty: 0,
    });
    expect(result.ok).toBe(false);
  });

  // 2026-07-22 investigation: while Tor/WS is still connecting, the host's `connect` throws
  // synchronously (App.tsx's connectForDraw wrapper) rather than ever returning a socket. Proves
  // that failure is QUEUED (retried across every sub-attempt this call makes) rather than DROPPED —
  // the request never even reaches the wire, but the call still ends in a typed transient failure
  // the OUTER caller (AppRuntime.noteLockedEpochs) can act on, not a silent hang or an unhandled throw.
  it('a connect() that throws (relay socket not live yet) is retried across sub-attempts, not dropped', async () => {
    const org = organizer();
    let connectCalls = 0;
    const connect = (): never => {
      connectCalls++;
      throw new Error('draw socket unavailable (relay not connected)');
    };

    const result = await runReadUnlock({
      connect,
      attempts: 3,
      backoffMs: 1,
      organizerPubkey: org.pub,
      token: readToken,
      epoch: 11,
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    expect(connectCalls).toBe(3); // every attempt actually tried to open a socket — nothing skipped
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true); // transient, not fatal — the outer ladder should retry
      expect(result.error).toContain('could not open a relay connection');
    }
  });
});

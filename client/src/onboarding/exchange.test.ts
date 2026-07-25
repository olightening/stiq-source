import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {bytesToBase64} from '../util/base64';
import {runCredentialExchange, KIND_ENROLL_REQUEST, KIND_ENROLL_RESPONSE} from './exchange';
import {MockBlindRsa} from './blindrsa';
import {FakeRelaySocket} from '../nostr/socket.fake';
import type {Community} from './community';

const ONION = `ws://${'a'.repeat(56)}.onion`;
const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>(r => setTimeout(r, 5));
  }
}

function organizer() {
  const sk = generateSecretKey();
  return {sk, pub: getPublicKey(sk)};
}

function community(organizerPubkey?: string): Community {
  return {relayUrl: ONION, issuerPublicKey: 'ISSUER', organizerPubkey, name: 'Acme', organizerLabel: 'Alice'};
}

/** Pull the REQ subId and the kind-9020 request event out of what the client sent. */
function readSent(socket: FakeRelaySocket) {
  let subId = '';
  let request: ReturnType<typeof JSON.parse> | undefined;
  for (const raw of socket.sent) {
    const arr = JSON.parse(raw);
    if (arr[0] === 'REQ') {
      subId = arr[1];
    } else if (arr[0] === 'EVENT' && arr[1]?.kind === KIND_ENROLL_REQUEST) {
      // publish form: ['EVENT', event]
      request = arr[1];
    }
  }
  return {subId, request};
}

describe('runCredentialExchange', () => {
  it('sends the request when the relay socket opened before crypto preparation finished', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    socket.simulateOpen(); // fast onion handshake wins the race with Enrollment.begin/PoW

    const pending = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 30,
    });
    await tick();
    await tick();

    expect(readSent(socket).request).toBeDefined();
    await pending; // let the short test timeout clear its timer/listener state
  });

  it('fails promptly when the onion socket died before handlers were registered', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    socket.close();

    const result = await runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBeUndefined();
      expect(result.error).toContain('connection closed');
    }
  });

  it('reuses one signed request and reply mailbox across fresh sockets after a circuit loss', async () => {
    const org = organizer();
    const sockets = [new FakeRelaySocket(), new FakeRelaySocket()];
    let connects = 0;
    const onRetry = jest.fn();

    const resultP = runCredentialExchange({
      connect: () => sockets[connects++]!,
      attempts: 2,
      backoffMs: 0,
      onRetry,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 1_000,
    });

    await waitFor(() => connects === 1);
    sockets[0]!.simulateOpen();
    await waitFor(() => readSent(sockets[0]!).request !== undefined);
    const first = readSent(sockets[0]!);
    sockets[0]!.close();

    await waitFor(() => connects === 2);
    expect(onRetry).toHaveBeenCalledWith(2, expect.stringContaining('connection closed'));
    sockets[1]!.simulateOpen();
    await waitFor(() => readSent(sockets[1]!).request !== undefined);
    const second = readSent(sockets[1]!);

    expect(second.request.id).toBe(first.request.id);
    const firstPayload = JSON.parse(
      nip44.decrypt(first.request.content, nip44.utils.getConversationKey(org.sk, first.request.pubkey)),
    );
    const secondPayload = JSON.parse(
      nip44.decrypt(second.request.content, nip44.utils.getConversationKey(org.sk, second.request.pubkey)),
    );
    expect(secondPayload.replyPubkey).toBe(firstPayload.replyPubkey);
    expect(secondPayload.blindedToken).toBe(firstPayload.blindedToken);

    const blindSig = bytesToBase64(new Uint8Array([1, 2, 3, 4]));
    const response = finalizeEvent(
      {
        kind: KIND_ENROLL_RESPONSE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', secondPayload.replyPubkey]],
        content: nip44.encrypt(
          JSON.stringify({blindSig}),
          nip44.utils.getConversationKey(org.sk, secondPayload.replyPubkey),
        ),
      },
      org.sk,
    );
    sockets[1]!.emitEvent(second.subId, response);

    await expect(resultP).resolves.toMatchObject({ok: true});
  });

  it('completes the round-trip and returns an enrolled session', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();

    const resultP = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 5_000,
    });

    await tick(); // let Enrollment.begin + handler registration settle
    socket.simulateOpen();
    await tick();

    const {subId, request} = readSent(socket);
    expect(request).toBeDefined();
    expect(subId).toContain('enroll:');

    // Organizer side: decrypt the request, "blind-sign", encrypt the response back.
    const reqConvKey = nip44.utils.getConversationKey(org.sk, request.pubkey);
    const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey)) as {
      blindedToken: string;
      replyPubkey: string;
      inviteCode: string;
    };
    expect(payload.inviteCode).toBe('STIQ-ABCD-2345-MNPQ');
    expect(payload.blindedToken.length).toBeGreaterThan(0);

    const blindSig = bytesToBase64(new Uint8Array([1, 2, 3, 4])); // mock pass-through signature
    const respConvKey = nip44.utils.getConversationKey(org.sk, payload.replyPubkey);
    const response = finalizeEvent(
      {
        kind: KIND_ENROLL_RESPONSE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', payload.replyPubkey]],
        content: nip44.encrypt(JSON.stringify({blindSig}), respConvKey),
      },
      org.sk,
    );
    socket.emitEvent(subId, response);

    const result = await resultP;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.community.organizerPubkey).toBe(org.pub);
      expect(result.session.bindingEvent.kind).toBe(9011);
      // The reply key is NOT the posting key — unlinkability.
      expect(result.session.pubkey).not.toBe(payload.replyPubkey);
    }
  });

  it('falls back (timedOut) when the organizer never responds', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 30,
    });
    await tick();
    socket.simulateOpen();
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
    }
  });

  it('errors when the community has no organizer mailbox', async () => {
    const result = await runCredentialExchange({
      socket: new FakeRelaySocket(),
      community: community(undefined),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('surfaces a relay rejection of the request', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
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
    if (!result.ok) {
      expect(result.error).toContain('insufficient proof-of-work');
    }
  });

  it('keeps waiting when a retry publish is reported as an already-stored duplicate', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const resultP = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 1_000,
    });
    await tick();
    socket.simulateOpen();
    await waitFor(() => readSent(socket).request !== undefined);
    const {subId, request} = readSent(socket);
    socket.emit(JSON.stringify(['OK', request.id, false, 'duplicate: already have this event']));

    const reqConvKey = nip44.utils.getConversationKey(org.sk, request.pubkey);
    const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey));
    const response = finalizeEvent(
      {
        kind: KIND_ENROLL_RESPONSE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', payload.replyPubkey]],
        content: nip44.encrypt(
          JSON.stringify({blindSig: bytesToBase64(Uint8Array.of(1, 2, 3))}),
          nip44.utils.getConversationKey(org.sk, payload.replyPubkey),
        ),
      },
      org.sk,
    );
    socket.emitEvent(subId, response);
    await expect(resultP).resolves.toMatchObject({ok: true});
  });

  it('fires onCircuitOpen exactly once, before the request is sent', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    socket.simulateOpen(); // fast onion handshake wins the race with Enrollment.begin/PoW
    let requestAlreadySentWhenOpened: boolean | undefined;
    const onCircuitOpen = jest.fn(() => {
      requestAlreadySentWhenOpened = readSent(socket).request !== undefined;
    });
    const onCircuitFailed = jest.fn();

    const pending = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 30,
      onCircuitOpen,
      onCircuitFailed,
    });
    await tick();
    await tick();

    expect(onCircuitOpen).toHaveBeenCalledTimes(1);
    expect(requestAlreadySentWhenOpened).toBe(false); // proof the request wasn't sent yet
    expect(readSent(socket).request).toBeDefined(); // ...but is sent by the time we check now
    expect(onCircuitFailed).not.toHaveBeenCalled();
    await pending;
  });

  it('fires onCircuitFailed (never onCircuitOpen) when the socket closes before it ever opened', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    socket.close(); // dies before handlers were registered — mirrors a failed onion rendezvous
    const onCircuitOpen = jest.fn();
    const onCircuitFailed = jest.fn();

    const result = await runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: new MockBlindRsa(),
      powDifficulty: 0,
      timeoutMs: 5_000,
      onCircuitOpen,
      onCircuitFailed,
    });

    expect(result.ok).toBe(false);
    expect(onCircuitOpen).not.toHaveBeenCalled();
    expect(onCircuitFailed).toHaveBeenCalledTimes(1);
    expect(onCircuitFailed).toHaveBeenCalledWith(
      'the Tor circuit to your community relay could not be opened',
    );
  });

  it('fails explicitly instead of timing out when an authenticated response cannot be unblinded', async () => {
    const org = organizer();
    const socket = new FakeRelaySocket();
    const mock = new MockBlindRsa();
    const resultP = runCredentialExchange({
      socket,
      community: community(org.pub),
      inviteCode: 'STIQ-ABCD-2345-MNPQ',
      blindRsa: {
        blind: (key, token) => mock.blind(key, token),
        finalize: async () => {
          throw new Error('blind signature verification failed');
        },
      },
      powDifficulty: 0,
      timeoutMs: 100,
    });

    await tick();
    socket.simulateOpen();
    await waitFor(() => readSent(socket).request !== undefined);
    const {subId, request} = readSent(socket);
    const reqConvKey = nip44.utils.getConversationKey(org.sk, request.pubkey);
    const payload = JSON.parse(nip44.decrypt(request.content, reqConvKey));
    const response = finalizeEvent(
      {
        kind: KIND_ENROLL_RESPONSE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', payload.replyPubkey]],
        content: nip44.encrypt(
          JSON.stringify({blindSig: bytesToBase64(Uint8Array.of(9, 9, 9))}),
          nip44.utils.getConversationKey(org.sk, payload.replyPubkey),
        ),
      },
      org.sk,
    );
    socket.emitEvent(subId, response);

    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBeUndefined();
      expect(result.error).toContain('blind signature verification failed');
    }
  });
});

import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {fetchOrgConfigDocs} from './orgConfigFetch';
import {FakeRelaySocket} from '../nostr/socket.fake';

const orgSk = generateSecretKey();
const orgHex = getPublicKey(orgSk);
const foreignSk = generateSecretKey();

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function doc(d: string, createdAt: number, sk = orgSk, content = '{}') {
  return finalizeEvent({kind: 30078, created_at: createdAt, tags: [['d', d]], content}, sk);
}

describe('fetchOrgConfigDocs (on-demand stiq:token-keys / content-epoch fetch)', () => {
  it('returns the newest organizer-signed doc per d-tag on EOSE; drops foreign, unverifiable, and off-list docs', async () => {
    const socket = new FakeRelaySocket();
    const p = fetchOrgConfigDocs({
      connect: () => socket,
      organizerHex: orgHex,
      dTags: ['stiq:token-keys', 'stiq:content-epoch'],
      timeoutMs: 5_000,
      attempts: 1,
    });
    await tick();
    socket.simulateOpen();
    await tick();
    const req = JSON.parse(socket.sent.find(m => m.startsWith('["REQ'))!);
    const subId = req[1] as string;
    expect(req[2]).toMatchObject({kinds: [30078], authors: [orgHex], '#d': ['stiq:token-keys', 'stiq:content-epoch']});

    const older = doc('stiq:token-keys', 100);
    const newer = doc('stiq:token-keys', 200);
    socket.emitEvent(subId, older);
    socket.emitEvent(subId, newer);
    socket.emitEvent(subId, doc('stiq:token-keys', 300, foreignSk)); // foreign author → dropped
    const forged = {...doc('stiq:content-epoch', 150), sig: '00'.repeat(64)}; // bad sig → dropped
    socket.emitEvent(subId, forged);
    socket.emitEvent(subId, doc('stiq:mirrors', 400)); // d not requested → dropped
    socket.emitEose(subId);

    const got = await p;
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(newer.id);
  });

  it('retries on a dead socket that delivered nothing, and succeeds on the fresh circuit', async () => {
    const sockets: FakeRelaySocket[] = [];
    const p = fetchOrgConfigDocs({
      connect: () => {
        const s = new FakeRelaySocket();
        sockets.push(s);
        return s;
      },
      organizerHex: orgHex,
      dTags: ['stiq:token-keys'],
      timeoutMs: 5_000,
      attempts: 2,
    });
    await tick();
    sockets[0]!.simulateOpen();
    await tick();
    sockets[0]!.close(); // circuit died before any signal → fresh attempt
    await new Promise<void>(r => setTimeout(r, 2_100)); // RETRY_BACKOFF_MS
    await tick();
    expect(sockets).toHaveLength(2);
    sockets[1]!.simulateOpen();
    await tick();
    const req = JSON.parse(sockets[1]!.sent.find(m => m.startsWith('["REQ'))!);
    const fresh = doc('stiq:token-keys', 500);
    sockets[1]!.emitEvent(req[1] as string, fresh);
    sockets[1]!.emitEose(req[1] as string);
    const got = await p;
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(fresh.id);
  }, 10_000);

  it('resolves empty (never rejects) when the relay is unreachable on every attempt', async () => {
    const got = await fetchOrgConfigDocs({
      connect: () => {
        throw new Error('tor not up');
      },
      organizerHex: orgHex,
      dTags: ['stiq:token-keys'],
      attempts: 2,
    });
    expect(got).toEqual([]);
  }, 10_000);
});

import {verifyEvent} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {Enrollment, encodeIssuanceResponse, KIND_MEMBERSHIP_BINDING} from './enrollment';
import {MockBlindRsa} from './blindrsa';
import {base64ToBytes} from '../util/base64';
import type {Community} from './community';

// Opaque test fixtures. Enrollment is community-agnostic — the relay URL and issuer key flow
// straight from the join code into the Session, so these only need to round-trip unchanged
// (MockBlindRsa ignores the issuer key). No build-time community constant is involved.
const TEST_RELAY = 'ws://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion';
const TEST_ISSUER_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA-test-issuer-key';

const community: Community = {
  relayUrl: TEST_RELAY,
  issuerPublicKey: TEST_ISSUER_KEY,
};

const TEST_INVITE = 'STIQ-TEST-0001';
const REQ_PREFIX = `stiq:cred-req:1;${TEST_INVITE};`;

describe('Enrollment — code-based flow', () => {
  it('generates the key on-device and a request code that hides the token', async () => {
    const {requestQr: requestCode} = await Enrollment.begin(community, new MockBlindRsa(), TEST_INVITE);
    expect(requestCode.startsWith(REQ_PREFIX)).toBe(true);
    // The request carries the blinded message, not a raw 32-byte token.
    const blinded = base64ToBytes(requestCode.slice(REQ_PREFIX.length));
    expect(blinded.length).not.toBe(32);
  });

  it('completes into a session with a signed kind-9011 binding event', async () => {
    const blindRsa = new MockBlindRsa();
    const {enrollment} = await Enrollment.begin(community, blindRsa, TEST_INVITE);

    // Organizer side (mock): blind-sign and return the response code.
    const responseCode = encodeIssuanceResponse(new Uint8Array([1, 2, 3, 4]));
    expect(responseCode.startsWith('stiq:cred-resp:1;')).toBe(true);

    const result = await enrollment.complete(responseCode);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const {session} = result;

    expect(session.relayUrl).toBe(TEST_RELAY);
    expect(session.npub).toBe(nip19.npubEncode(session.pubkey));
    expect(session.credential.token).toHaveLength(32);

    expect(session.bindingEvent.kind).toBe(KIND_MEMBERSHIP_BINDING);
    expect(session.bindingEvent.pubkey).toBe(session.pubkey);
    expect(verifyEvent(session.bindingEvent)).toBe(true);
    expect(session.bindingEvent.tags).toEqual(
      expect.arrayContaining([
        ['stiq_token', expect.any(String)],
        ['stiq_sig', expect.any(String)],
      ]),
    );
  });

  it('rejects a malformed response code', async () => {
    const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), TEST_INVITE);
    expect((await enrollment.complete('not-a-response')).ok).toBe(false);
    expect((await enrollment.complete('stiq:cred-resp:1;!!!invalid-base64')).ok).toBe(false);
  });

  it('returns a typed failure when the organizer blind signature cannot be verified', async () => {
    const mock = new MockBlindRsa();
    const {enrollment} = await Enrollment.begin(
      community,
      {
        blind: (key, token) => mock.blind(key, token),
        finalize: async () => {
          throw new Error('signature verification failed');
        },
      },
      TEST_INVITE,
    );
    const result = await enrollment.complete(
      encodeIssuanceResponse(new Uint8Array([1, 2, 3, 4])),
    );
    expect(result).toEqual({ok: false, error: 'could not verify credential: signature verification failed'});
  });

  it('full simulation: invite → request code → organizer mock-signs → complete', async () => {
    const blindRsa = new MockBlindRsa();
    const {enrollment, requestQr: requestCode} = await Enrollment.begin(community, blindRsa, TEST_INVITE);
    expect(requestCode).toMatch(/^stiq:cred-req:1;STIQ-TEST-0001;/);

    const blindedB64 = requestCode.slice(REQ_PREFIX.length);
    const blinded = base64ToBytes(blindedB64);
    const mockSig = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const responseCode = encodeIssuanceResponse(mockSig);

    const result = await enrollment.complete(responseCode);
    expect(result.ok).toBe(true);
    if (!result.ok) { return; }

    expect(result.session.relayUrl).toBe(TEST_RELAY);
    expect(verifyEvent(result.session.bindingEvent)).toBe(true);
    expect(blinded).not.toEqual(result.session.credential.token);
  });
});

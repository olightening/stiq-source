import {parseTokenKeysEvent, TOKEN_KEYS_D_TAG} from './tokenKeys';

// Purpose-specific issuer keys (base64 SPKI) — any decodable base64 within the SPKI ceiling is
// plausible (isPlausibleIssuerKey), so short strings round-trip like the join-code parser's fixtures.
const PK = Buffer.from('post-issuer-key').toString('base64');
const RK = Buffer.from('read-issuer-key').toString('base64');
const SWK = Buffer.from('space-write-issuer-key').toString('base64');
const BAD = 'not valid base64 %%%'; // fails isPlausibleIssuerKey (same fixture join.test.ts uses)

describe('parseTokenKeysEvent (stiq:token-keys live adoption)', () => {
  it('exposes the canonical d-tag literal the organizer publishes under', () => {
    expect(TOKEN_KEYS_D_TAG).toBe('stiq:token-keys');
  });

  it('maps every present wire key to its EnrolledCommunity field', () => {
    const patch = parseTokenKeysEvent(
      JSON.stringify({v: 1, pk: PK, rk: RK, pwk: PK, prk: RK, awk: PK, ark: RK, swk: SWK}),
    );
    expect(patch).toEqual({
      postIssuerPublicKey: PK,
      readIssuerPublicKey: RK,
      picWriteIssuerPublicKey: PK,
      picReadIssuerPublicKey: RK,
      audWriteIssuerPublicKey: PK,
      audReadIssuerPublicKey: RK,
      spaceWriteIssuerPublicKey: SWK,
    });
  });

  it('adopts a partial doc — only the keys actually present (absent-stays-absent upstream)', () => {
    expect(parseTokenKeysEvent(JSON.stringify({swk: SWK}))).toEqual({spaceWriteIssuerPublicKey: SWK});
  });

  it('fails closed: one malformed key makes the WHOLE doc ignored', () => {
    expect(parseTokenKeysEvent(JSON.stringify({pk: PK, swk: BAD}))).toBeNull();
  });

  it('returns null for non-JSON / non-object / no recognizable keys', () => {
    expect(parseTokenKeysEvent('not json at all')).toBeNull();
    expect(parseTokenKeysEvent('42')).toBeNull();
    expect(parseTokenKeysEvent('null')).toBeNull();
    expect(parseTokenKeysEvent(JSON.stringify({v: 1, unrelated: 'x'}))).toBeNull();
    expect(parseTokenKeysEvent(JSON.stringify({}))).toBeNull();
  });

  it('skips non-string / empty values without failing the whole doc', () => {
    // pk (number) and rk (empty) are simply omitted; the one valid key still adopts.
    expect(parseTokenKeysEvent(JSON.stringify({pk: 123, rk: '', swk: SWK}))).toEqual({
      spaceWriteIssuerPublicKey: SWK,
    });
  });
});

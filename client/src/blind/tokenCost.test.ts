import {chargeableWeight, tokenCost, utf8ByteLength, setBytesPerToken, getBytesPerToken} from './tokenCost';

/**
 * These fixtures + expected UTF-8 byte counts are SHARED with the Go parity test
 * (relay/internal/policy/weightprice_test.go TestChargeableParity). Both implementations MUST
 * produce the identical numbers, or the relay rejects honest non-ASCII posts as under-paid. Counts
 * are UTF-8 bytes (Go len), NOT UTF-16 code units (JS String.length).
 */
const FIXTURES: {content: string; tags: string[][]; weight: number}[] = [
  {content: 'hi', tags: [], weight: 2},
  {content: 'café', tags: [], weight: 5}, // é = U+00E9 = 2 bytes
  {content: '😀', tags: [], weight: 4}, // emoji = 4 bytes
  {content: 'مرحبا', tags: [], weight: 10}, // 5 Arabic letters × 2 bytes
  {content: '', tags: [['t', 'news']], weight: 7}, // (1+1) + (4+1)
  {content: 'x', tags: [['stiq_token', 'AAAA'], ['stiq_sig', 'BBBB'], ['t', 'hi']], weight: 6}, // token tags excluded: 1 + (1+1)+(2+1)
  {content: 'مرحبا😀', tags: [['stiq_attr', 'zz']], weight: 27}, // (10+4) + ((9+1)+(2+1))
];

describe('tokenCost / chargeableWeight (relay parity)', () => {
  afterEach(() => setBytesPerToken(0));

  it('counts UTF-8 bytes, matching the Go relay byte-for-byte', () => {
    for (const f of FIXTURES) {
      expect(chargeableWeight(f.content, f.tags)).toBe(f.weight);
    }
  });

  it('utf8ByteLength is UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('😀')).toBe(4); // .length is 2
    expect('😀'.length).toBe(2); // proves the trap the relay parity depends on avoiding
    expect(utf8ByteLength('مرحبا')).toBe(10); // .length is 5
  });

  it('excludes stiq_token/stiq_sig from weight (no self-pricing / circularity trap)', () => {
    const base = chargeableWeight('body', [['t', 'x']]);
    const withTokens = chargeableWeight('body', [
      ['t', 'x'],
      ['stiq_token', 'A'.repeat(400)],
      ['stiq_sig', 'B'.repeat(400)],
    ]);
    expect(withTokens).toBe(base); // adding tokens must not change the price
  });

  it('excludes stiq_spend (P3 holder proofs) from weight — a multi-token post must not self-price its proofs', () => {
    const base = chargeableWeight('body', [['t', 'x']]);
    const withOneSpend = chargeableWeight('body', [['t', 'x'], ['stiq_spend', 'C'.repeat(400)]]);
    // Several proofs at once (a weight-priced post spending many tokens) — a big stiq_spend payload
    // must never inflate chargeableWeight, or the relay rejects the very multi-token post the
    // client priced as affordable (crypto mustFix #1).
    const withManySpends = chargeableWeight('body', [
      ['t', 'x'],
      ['stiq_spend', 'C'.repeat(400)],
      ['stiq_spend', 'D'.repeat(400)],
      ['stiq_spend', 'E'.repeat(400)],
    ]);
    expect(withOneSpend).toBe(base);
    expect(withManySpends).toBe(base);
  });

  it('disabled (bytesPerToken<=0) always costs exactly 1 token', () => {
    expect(tokenCost('x'.repeat(9999), [], 0)).toBe(1);
    expect(tokenCost('x'.repeat(9999), [], -3)).toBe(1);
  });

  it('one token per bytesPerToken of weight, floored at 1 (ceil division)', () => {
    expect(tokenCost('', [], 100)).toBe(1); // floor: an empty event still costs 1
    expect(tokenCost('مرحبا', [], 4)).toBe(3); // ceil(10/4) = 3
    expect(tokenCost('hi', [], 1)).toBe(2); // 2 bytes / 1
    expect(tokenCost('x'.repeat(64), [], 16)).toBe(4); // 64/16
  });

  it('reads the module bytesPerToken when no override is passed', () => {
    setBytesPerToken(4);
    expect(getBytesPerToken()).toBe(4);
    expect(tokenCost('مرحبا', [])).toBe(3);
    setBytesPerToken(0);
    expect(tokenCost('مرحبا', [])).toBe(1);
  });
});

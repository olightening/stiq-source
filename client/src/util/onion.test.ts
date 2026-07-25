import {isOnionWsUrl} from './onion';

const ONION = 'a'.repeat(56); // 56 base32 chars

describe('isOnionWsUrl', () => {
  it('accepts ws/wss v3 onion URLs, with optional port/path', () => {
    expect(isOnionWsUrl(`ws://${ONION}.onion`)).toBe(true);
    expect(isOnionWsUrl(`wss://${ONION}.onion`)).toBe(true);
    expect(isOnionWsUrl(`ws://${ONION}.onion:80`)).toBe(true);
    expect(isOnionWsUrl(`ws://${ONION}.onion/`)).toBe(true);
  });

  it('rejects clearnet and non-ws schemes', () => {
    expect(isOnionWsUrl('ws://example.com')).toBe(false);
    expect(isOnionWsUrl('http://' + ONION + '.onion')).toBe(false);
    expect(isOnionWsUrl('https://relay.example.org')).toBe(false);
    expect(isOnionWsUrl(`ws://${ONION}.com`)).toBe(false);
  });

  it('rejects malformed onion hosts', () => {
    expect(isOnionWsUrl(`ws://${'a'.repeat(55)}.onion`)).toBe(false); // too short
    expect(isOnionWsUrl(`ws://${'1'.repeat(56)}.onion`)).toBe(false); // 1/0/8/9 not base32
    expect(isOnionWsUrl('ws://.onion')).toBe(false);
    expect(isOnionWsUrl('')).toBe(false);
  });
});

import {
  classifyUrl,
  detectHomograph,
  getQueryParam,
  hasTrackingParams,
  isOnionHost,
  isV3OnionHost,
  prettyDomain,
  stripTrackingParams,
  urlHost,
} from './url';

const V3 = 'stiqexamplerelayonionaddressfortestsonly2345672345672345.onion';

describe('classifyUrl', () => {
  it('classifies a v3 onion as onion', () => {
    const info = classifyUrl(`http://${V3}/x`);
    expect(info.kind).toBe('onion');
    expect(info.host).toBe(V3);
  });

  it('classifies https clearnet', () => {
    const info = classifyUrl('https://example.com/a?b=1');
    expect(info.kind).toBe('clearnet');
    expect(info.secure).toBe(true);
    expect(info.host).toBe('example.com');
  });

  it('rejects non-http(s) schemes as invalid', () => {
    expect(classifyUrl('javascript:alert(1)').kind).toBe('invalid');
    expect(classifyUrl('data:text/html,<b>').kind).toBe('invalid');
    expect(classifyUrl('myapp://open').kind).toBe('invalid');
  });

  it('returns invalid for garbage', () => {
    expect(classifyUrl('not a url').kind).toBe('invalid');
  });
});

describe('onion host checks', () => {
  it('accepts any .onion for isOnionHost but only 56-char for v3', () => {
    expect(isOnionHost(V3)).toBe(true);
    expect(isOnionHost('short.onion')).toBe(true);
    expect(isV3OnionHost(V3)).toBe(true);
    expect(isV3OnionHost('short.onion')).toBe(false);
    expect(isOnionHost('example.com')).toBe(false);
  });
});

describe('detectHomograph', () => {
  it('passes a plain ASCII host', () => {
    expect(detectHomograph('example.com').suspicious).toBe(false);
  });

  it('flags a punycode/IDN label', () => {
    const r = detectHomograph('xn--80ak6aa92e.com');
    expect(r.suspicious).toBe(true);
    expect(r.reason).toBe('punycode');
  });

  it('flags a raw non-ASCII host', () => {
    const r = detectHomograph('аpple.com'); // Cyrillic 'а'
    expect(r.suspicious).toBe(true);
    expect(r.reason).toBe('non-ascii');
  });
});

describe('stripTrackingParams', () => {
  it('removes utm_* and known click ids, keeps real params', () => {
    const cleaned = stripTrackingParams(
      'https://example.com/p?id=42&utm_source=x&utm_medium=y&fbclid=abc&gclid=z',
    );
    expect(cleaned).toContain('id=42');
    expect(cleaned).not.toContain('utm_source');
    expect(cleaned).not.toContain('fbclid');
    expect(cleaned).not.toContain('gclid');
  });

  it('returns the original string byte-for-byte when nothing is stripped', () => {
    const url = 'https://example.com/p?id=42&page=2';
    expect(stripTrackingParams(url)).toBe(url);
    expect(hasTrackingParams(url)).toBe(false);
  });

  it('drops the query entirely when only trackers were present', () => {
    expect(stripTrackingParams('https://example.com/p?utm_source=x')).toBe(
      'https://example.com/p',
    );
    expect(hasTrackingParams('https://example.com/p?utm_source=x')).toBe(true);
  });

  it('strips an instagram reel share token (igsh) to its shortest form', () => {
    expect(stripTrackingParams('https://www.instagram.com/reel/ABC123/?igsh=OGViZ')).toBe(
      'https://www.instagram.com/reel/ABC123/',
    );
  });

  it('strips YouTube share `si` but keeps a real `t` timestamp', () => {
    const cleaned = stripTrackingParams('https://youtu.be/dQw4w9WgXcQ?si=abcd1234&t=42');
    expect(cleaned).toContain('t=42');
    expect(cleaned).not.toContain('si=');
  });

  it('strips X share params (s, t)', () => {
    expect(stripTrackingParams('https://x.com/u/status/1?s=20&t=xyz')).toBe(
      'https://x.com/u/status/1',
    );
  });

  it('only strips host-specific keys on the matching host (keeps `si` elsewhere)', () => {
    const url = 'https://example.com/p?si=keepme';
    expect(stripTrackingParams(url)).toBe(url);
  });
});

describe('prettyDomain', () => {
  it('strips www', () => {
    expect(prettyDomain('https://www.example.com/x')).toBe('example.com');
  });
});

// The deep-link router (App.tsx handleDeepLink) routes stiq:// links by host and reads the join
// code from `?c=`. These back that without the throwing global URL (see the Hermes block below).
describe('urlHost', () => {
  it('extracts the host of a custom-scheme deep link', () => {
    expect(urlHost('stiq://join?c=ABC')).toBe('join');
    expect(urlHost('stiq://channel/grp123#k=key')).toBe('channel');
  });

  it('extracts and lowercases the host of an http(s) URL', () => {
    expect(urlHost('https://Example.COM/a?b=1')).toBe('example.com');
  });

  it('returns "" when there is no scheme://authority (e.g. a raw join code)', () => {
    expect(urlHost('stiq:join:1:abc')).toBe('');
    expect(urlHost('not a url')).toBe('');
  });
});

describe('getQueryParam', () => {
  it('reads a param and percent-decodes it, matching URLSearchParams.get', () => {
    // The organizer builds the link as `stiq://join?c=` + encodeURIComponent(joinCode).
    const code = 'stiq:join:1:eyJ2IjoxfQ';
    expect(getQueryParam(`stiq://join?c=${encodeURIComponent(code)}`, 'c')).toBe(code);
  });

  it('returns null for an absent param and never reads the fragment', () => {
    expect(getQueryParam('stiq://join?c=ABC', 'x')).toBeNull();
    expect(getQueryParam('stiq://join#c=ABC', 'c')).toBeNull();
    expect(getQueryParam('stiq://join', 'c')).toBeNull();
  });

  it('decodes + as space and takes the first occurrence', () => {
    expect(getQueryParam('stiq://join?c=a+b', 'c')).toBe('a b');
    expect(getQueryParam('stiq://join?c=first&c=second', 'c')).toBe('first');
  });

  it('yields "" for a valueless param and stops at the fragment', () => {
    expect(getQueryParam('stiq://join?c', 'c')).toBe('');
    expect(getQueryParam('stiq://join?c=&d=1', 'c')).toBe('');
    expect(getQueryParam('stiq://join?c=code#frag', 'c')).toBe('code');
  });
});

// On-device (Hermes) the global URL constructor is a stub that THROWS for real links, which used to
// make classifyUrl return {kind:'invalid'} — disabling the "Open link" button — and stripTrackingParams
// return the URL untouched (leaking share tokens). These utilities must not touch `new URL` at all.
describe('Hermes safety (no dependency on global URL)', () => {
  let savedURL: typeof globalThis.URL;
  beforeAll(() => {
    savedURL = globalThis.URL;
    // Simulate the Hermes stub: constructing throws "not implemented".
    globalThis.URL = function BrokenURL() {
      throw new Error('URL.prototype.href getter not implemented');
    } as unknown as typeof globalThis.URL;
  });
  afterAll(() => {
    globalThis.URL = savedURL;
  });

  it('classifyUrl still classifies a real clearnet link (button stays enabled)', () => {
    const info = classifyUrl('https://www.instagram.com/p/DaOy5UZzSfv/');
    expect(info.kind).toBe('clearnet');
    expect(info.host).toBe('www.instagram.com');
    expect(info.secure).toBe(true);
  });

  it('classifyUrl still recognises an onion host', () => {
    expect(classifyUrl(`http://${V3}/x`).kind).toBe('onion');
  });

  it('classifyUrl still rejects non-http(s) schemes', () => {
    expect(classifyUrl('javascript:alert(1)').kind).toBe('invalid');
    expect(classifyUrl('myapp://open').kind).toBe('invalid');
  });

  it('stripTrackingParams still strips an instagram share token', () => {
    expect(
      stripTrackingParams('https://www.instagram.com/p/DaOy5UZzSfv/?igsh=MTI0bXZyb3c4ODdyYQ=='),
    ).toBe('https://www.instagram.com/p/DaOy5UZzSfv/');
  });

  it('urlHost/getQueryParam still route a join deep link (onboarding code prefills)', () => {
    // This is the on-device failure the fix targets: `new URL(url).searchParams.get('c')` threw, so
    // a scanned/tapped stiq://join link silently never prefilled the code. The string parsers don't.
    const code = 'stiq:join:1:eyJ2IjoxfQ';
    const link = `stiq://join?c=${encodeURIComponent(code)}`;
    expect(urlHost(link)).toBe('join');
    expect(getQueryParam(link, 'c')).toBe(code);
  });
});

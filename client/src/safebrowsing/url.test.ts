import {canonicalize, urlExpressions, hashPrefixes} from './url';

// Canonicalization vectors straight from the Safe Browsing v4 spec
// (https://developers.google.com/safe-browsing/v4/urls-hashing).
describe('safe browsing — canonicalize', () => {
  const cases: Array<[string, string, string, string | null]> = [
    // input, host, path, query
    ['http://host/%25%32%35', 'host', '/%25', null],
    ['http://host/%25%32%35%25%32%35', 'host', '/%25%25', null],
    ['http://host/%2525252525252525', 'host', '/%25', null],
    ['http://host/asdf%25%32%35asd', 'host', '/asdf%25asd', null],
    ['http://www.google.com/', 'www.google.com', '/', null],
    ['http://195.127.0.11/blah', '195.127.0.11', '/blah', null],
    ['http://3279880203/blah', '195.127.0.11', '/blah', null],
    ['http://www.google.com.../', 'www.google.com', '/', null],
    ['http://www.google.com/foo\tbar\rbaz\n2', 'www.google.com', '/foobarbaz2', null],
    ['http://www.evil.com/blah#frag', 'www.evil.com', '/blah', null],
    ['http://www.GOOgle.com/', 'www.google.com', '/', null],
    ['http://notrailingslash.com', 'notrailingslash.com', '/', null],
    ['http://www.gotaport.com:1234/', 'www.gotaport.com', '/', null],
    ['  http://www.google.com/  ', 'www.google.com', '/', null],
    ['http://192.168.0.1/', '192.168.0.1', '/', null],
    ['http://user@host.com/path', 'host.com', '/path', null],
    ['http://host.com//twoslashes//x', 'host.com', '/twoslashes/x', null],
    ['http://host.com/a/./b/../c', 'host.com', '/a/c', null],
    ['https://Secure.Example.COM/Path?Q=1', 'secure.example.com', '/Path', 'Q=1'],
  ];
  for (const [input, host, path, query] of cases) {
    it(`canonicalizes ${JSON.stringify(input)}`, () => {
      const c = canonicalize(input);
      expect(c).not.toBeNull();
      expect(c?.host).toBe(host);
      expect(c?.path).toBe(path);
      expect(c?.query).toBe(query);
    });
  }

  it('rejects non-http(s) schemes', () => {
    expect(canonicalize('javascript:alert(1)')).toBeNull();
    expect(canonicalize('data:text/html,x')).toBeNull();
    expect(canonicalize('ftp://host/x')).toBeNull();
  });
});

// Expression (suffix/prefix) vectors from the spec.
describe('safe browsing — urlExpressions', () => {
  it('expands a.b.c/1/2.html?param=1', () => {
    expect(urlExpressions('http://a.b.c/1/2.html?param=1')).toEqual([
      'a.b.c/1/2.html?param=1',
      'a.b.c/1/2.html',
      'a.b.c/',
      'a.b.c/1/',
      'b.c/1/2.html?param=1',
      'b.c/1/2.html',
      'b.c/',
      'b.c/1/',
    ]);
  });

  it('expands a.b.c.d.e.f.g/1.html (host capped at last 5)', () => {
    expect(urlExpressions('http://a.b.c.d.e.f.g/1.html')).toEqual([
      'a.b.c.d.e.f.g/1.html',
      'a.b.c.d.e.f.g/',
      'c.d.e.f.g/1.html',
      'c.d.e.f.g/',
      'd.e.f.g/1.html',
      'd.e.f.g/',
      'e.f.g/1.html',
      'e.f.g/',
      'f.g/1.html',
      'f.g/',
    ]);
  });

  it('produces ≤30 expressions and 8-hex-char (4-byte) prefixes', () => {
    const ex = urlExpressions('http://a.b.c.d.e/1/2/3/4/5/6.html?x=1');
    expect(ex.length).toBeLessThanOrEqual(30);
    const pre = hashPrefixes('http://a.b.c.d.e/1/2/3/4/5/6.html?x=1');
    expect(pre.length).toBeGreaterThan(0);
    for (const p of pre) {
      expect(p).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

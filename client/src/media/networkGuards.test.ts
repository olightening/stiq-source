/// <reference types="node" />
/**
 * Network-egress guards (PLAN.md §3.2) — CI fails if any code reintroduces a clearnet leak.
 *
 * The whole anonymity model rests on every remote byte going through Tor (src/media/torHttp).
 * These tests scan the source tree and forbid the three ways that invariant has historically
 * been broken: a WebView rendering remote content, an <Image> pointed at a remote URL, or a raw
 * fetch() to the network. Each has exactly one sanctioned exception, asserted explicitly.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const FILES = walk(SRC);
const read = (f: string): string => fs.readFileSync(f, 'utf8');

describe('network-egress guards', () => {
  it('react-native-webview is imported ONLY by the local-only RichEditor', () => {
    // There is no in-app browser any more — a link is handed to a real external browser (ui/
    // LinkDialog), so nothing in the app renders remote web content. RichEditor (the No.5 WYSIWYG
    // composer) is the sole remaining WebView: it loads ONLY an inlined local html document
    // (source={{html}}, never a URL), blocks ALL real navigation via an allowlist, and runs with no
    // network and no file access — so it cannot egress a single byte. It never touches remote content.
    const ALLOWED = new Set(['feed/components/RichEditor.tsx']);
    const offenders = FILES.filter(
      f => /from ['"]react-native-webview['"]/.test(read(f)) && !ALLOWED.has(rel(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no <Image> renders a remote http(s) URL (only data: URIs from Tor-fetched bytes)', () => {
    const offenders = FILES.filter(f => /uri:\s*[`'"]https?:/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no raw fetch() to the network except the pre-Tor bridge bootstrap', () => {
    const ALLOWED = new Set(['tor/bridgeFetch.ts']);
    const offenders = FILES.filter(f => {
      if (ALLOWED.has(rel(f))) {
        return false;
      }
      // The global builtin is called `fetch(` with no space; prose like "fetch (Tier 1)" is fine.
      return /(^|[^.\w])fetch\(/.test(read(f));
    }).map(rel);
    expect(offenders).toEqual([]);
  });
});

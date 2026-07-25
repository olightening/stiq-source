/**
 * Seeded-bridge join-code invariants (T14-S4 / T14-S5).
 *
 * Two properties are load-bearing and pinned here:
 *   1. sanitizeBridges accepts ONLY obfs4 / webtunnel transport lines (snowflake is a broker transport,
 *      a bare `ip:port fingerprint` vanilla line leaks the relay), trims + dedupes, and caps at 12 so
 *      the `br` array can never blow the client's 4096-char join-code budget (MAX_JOIN_CODE_LEN in
 *      client/src/onboarding/join.ts).
 *   2. buildJoinCode embeds `br` into the SAME stiq:join:2 envelope only when bridges.json is non-empty;
 *      an empty sidecar yields a code with no `br` field (back-compat — old clients ignore it anyway).
 *   3. signBridges (T14-S5) yields a kind-30078 event with d=stiq:bridges whose content is {b:[lines]} —
 *      the cross-layer wire the client ingest (AppRuntime, COMMUNITY_SEEDED_BRIDGES) parses.
 *
 * sanitizeBridges + the buildJoinCode `br` step are mirrored below (kept in lockstep with
 * organizer-server.mjs, exactly as storage_config_test.mjs mirrors sanitizeStorage) — organizer-server.mjs
 * can't be imported without booting the whole dashboard + minting keys. signBridges IS imported from
 * organizer-nostr.mjs (the real signer).
 */
import assert from 'assert';
import {signBridges} from './organizer-nostr.mjs';

// ── Mirror of organizer-server.mjs sanitizeBridges (kept in lockstep) ────────────
const BRIDGES_MAX = 12;
const BRIDGE_LINE_RE = /^(obfs4|webtunnel)\s\S/;
function sanitizeBridges(input) {
  const raw = Array.isArray(input) ? input : (Array.isArray(input?.lines) ? input.lines : []);
  const seen = new Set();
  const lines = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const line = item.trim();
    if (!BRIDGE_LINE_RE.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= BRIDGES_MAX) break;
  }
  return {lines};
}

// ── Mirror of organizer-server.mjs b64url + the buildJoinCode `br` embedding ─────
const JOIN_PREFIX = 'stiq:join:2:';
const MAX_JOIN_CODE_LEN = 4096; // must match client/src/onboarding/join.ts
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildJoinCodeWithBridges(seededLines) {
  // Representative base envelope (matches the real buildJoinCode shape) + the br step under test.
  const json = {
    v: 2,
    rs: [['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion', null]],
    cn: 'stiq community', on: 'organizer',
    cid: '0123456789abcdef', op: 'a'.repeat(64),
    i: 'STIQ-AAAA-BBBB-CCCC',
    ck: Buffer.alloc(32).toString('base64'),
  };
  const br = sanitizeBridges({lines: seededLines}).lines;
  if (br.length > 0) json.br = br;
  return JOIN_PREFIX + b64url(Buffer.from(JSON.stringify(json), 'utf8'));
}
function decodeJoin(code) {
  const b64 = code.slice(JOIN_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

const OBFS4 = 'obfs4 192.0.2.1:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA iat-mode=0';
const WEBTUN = 'webtunnel [2001:db8::1]:443 0123456789ABCDEF0123456789ABCDEF01234567 url=https://example.org/aBcDeFgHiJ ver=0.0.1';

// ── 1. a webtunnel + an obfs4 line both survive and appear in json.br ────────────
{
  const code = buildJoinCodeWithBridges([WEBTUN, OBFS4]);
  const json = decodeJoin(code);
  assert.ok(Array.isArray(json.br), 'json.br is present when bridges are seeded');
  assert.deepStrictEqual(json.br, [WEBTUN, OBFS4], 'json.br carries both seeded lines in order');
  console.log('ok 1 — buildJoinCode embeds a webtunnel + obfs4 line into json.br');
}

// ── 2. snowflake + vanilla + garbage are dropped; whitespace trimmed; dupes removed ──
{
  const s = sanitizeBridges({lines: [
    '  ' + OBFS4 + '  ',                 // trims to a valid obfs4 line
    'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72', // broker transport → drop
    '192.0.2.9:443 0123456789ABCDEF0123456789ABCDEF01234567',         // vanilla (no transport) → drop
    'obfs4bogus not-a-space-after-keyword',                            // no whitespace boundary → drop
    'meek 1.2.3.4:443',                                               // unsupported transport → drop
    OBFS4,                                                            // exact dupe of line 1 → drop
    '',                                                              // empty → drop
    WEBTUN,                                                          // valid webtunnel
  ]});
  assert.deepStrictEqual(s.lines, [OBFS4, WEBTUN], 'only the trimmed obfs4 + webtunnel lines survive, deduped');
  console.log('ok 2 — snowflake / vanilla / garbage / dupes dropped, whitespace trimmed');
}

// ── 3. cap at 12 ─────────────────────────────────────────────────────────────────
{
  const many = [];
  for (let i = 0; i < 20; i++) many.push('obfs4 192.0.2.' + i + ':443 0123456789ABCDEF0123456789ABCDEF0123456' + (i % 10) + ' iat-mode=0');
  const s = sanitizeBridges({lines: many});
  assert.strictEqual(s.lines.length, 12, 'sanitizeBridges caps the set at 12 lines');
  console.log('ok 3 — sanitizeBridges caps at 12 lines');
}

// ── 4. empty bridges ⇒ json.br absent (back-compat / ship-dark) ───────────────────
{
  for (const empty of [[], undefined, null, {lines: []}, {lines: ['not-a-bridge']}]) {
    const code = buildJoinCodeWithBridges(empty && empty.lines ? empty.lines : (Array.isArray(empty) ? empty : []));
    const json = decodeJoin(code);
    assert.ok(!('br' in json), 'json.br is absent when no valid bridges are seeded (' + JSON.stringify(empty) + ')');
  }
  console.log('ok 4 — no valid seeded bridges ⇒ json.br omitted (byte-identical to today)');
}

// ── 5. 12 seeded webtunnel lines still fit under the 4096-char join-code budget ────
{
  const twelve = [];
  for (let i = 0; i < 12; i++) twelve.push('webtunnel [2001:db8::' + i + ']:443 0123456789ABCDEF0123456789ABCDEF0123456' + (i % 10) + ' url=https://example.org/bridge' + i + 'aBcDeFgHiJkLmNoP ver=0.0.1');
  const s = sanitizeBridges({lines: twelve});
  assert.strictEqual(s.lines.length, 12, 'all 12 distinct webtunnel lines are kept');
  const code = buildJoinCodeWithBridges(twelve);
  assert.strictEqual(decodeJoin(code).br.length, 12, 'the code carries all 12 lines');
  assert.ok(code.length < MAX_JOIN_CODE_LEN, 'a 12-bridge join code (' + code.length + ' chars) fits under the ' + MAX_JOIN_CODE_LEN + '-char budget');
  console.log('ok 5 — a 12-bridge join code is ' + code.length + ' chars (< ' + MAX_JOIN_CODE_LEN + ')');
}

// ── 6. signBridges: kind-30078, d=stiq:bridges, content {b:[lines]} (T14-S5) ──────
{
  const lines = [OBFS4, WEBTUN];
  const event = signBridges(lines);
  assert.strictEqual(event.kind, 30078, 'organizer bridges event is kind-30078 (NIP-78 app data)');
  const dTag = event.tags.find(t => t[0] === 'd');
  assert.ok(dTag && dTag[1] === 'stiq:bridges', 'the addressable d-tag is exactly "stiq:bridges"');
  assert.deepStrictEqual(JSON.parse(event.content), {b: lines}, 'content is the compact {b:[lines]} wire the client parser reads');
  assert.ok(typeof event.sig === 'string' && event.sig.length === 128, 'event carries a schnorr signature');
  // non-string junk in the input is filtered before signing
  assert.deepStrictEqual(JSON.parse(signBridges([OBFS4, 42, null, WEBTUN]).content), {b: [OBFS4, WEBTUN]}, 'non-string entries are dropped before signing');
  console.log('ok 6 — signBridges emits kind-30078 d=stiq:bridges with {b:[lines]} content');
}

console.log('\nall seeded-bridge join-code invariants hold.');

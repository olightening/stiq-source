/**
 * Community relay mirrors (stiq:mirrors) invariants.
 *
 * The CLIENT already ships the read side of this wire contract (client/src/app/AppRuntime.ts
 * parseMirrorsEvent + client/src/onboarding/join.ts MAX_MIRRORS) — this pins the ORGANIZER publish
 * side, which must never deviate from it:
 *   1. signMirrors (organizer-nostr.mjs, the real signer, imported below) yields a kind-30078 event
 *      with a d=stiq:mirrors tag whose content JSON-parses to an array of terse `[url, authKeyOrNull]`
 *      pairs — the exact shape parseMirrorsEvent reads.
 *   2. Entries whose url isn't a valid ws/wss v3-onion address are dropped before signing, never
 *      coerced into a relay attempt.
 *   3. The list is capped at MIRRORS_MAX (5), matching the client's MAX_MIRRORS.
 *   4. An empty/all-invalid input signs an EMPTY array — the organizer's own-mirror withdrawal case.
 *
 * sanitizeMirror/onionHostOfMirror (the POST /api/mirrors route's validation) are mirrored below (kept
 * in lockstep with organizer-server.mjs, exactly as joincode_bridges_test.mjs mirrors sanitizeBridges)
 * — organizer-server.mjs can't be imported without booting the whole dashboard + minting keys.
 */
import assert from 'assert';
import {signMirrors} from './organizer-nostr.mjs';

// ── Mirror of organizer-server.mjs's mirror validation (kept in lockstep) ────────
const MIRRORS_MAX = 5;
const ONION_WS_RE = /^wss?:\/\/[a-z2-7]{56}\.onion(?:[:/?#]|$)/i;
function onionHostOfMirror(u) {
  const m = /^wss?:\/\/([a-z2-7]{56}\.onion)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}
function normalizeMirrorHost(s) {
  const fromUrl = onionHostOfMirror(s);
  if (fromUrl) return fromUrl;
  const bare = String(s || '').trim().toLowerCase();
  if (/^[a-z2-7]{56}$/.test(bare)) return bare + '.onion';
  if (/^[a-z2-7]{56}\.onion$/.test(bare)) return bare;
  return null;
}
function sanitizeMirror(m) {
  if (!m || typeof m.url !== 'string' || !ONION_WS_RE.test(m.url)) return null;
  const onionAuthKey = (typeof m.onionAuthKey === 'string' && m.onionAuthKey) ? m.onionAuthKey : null;
  return {url: m.url, onionAuthKey};
}

const HOST_A = 'a'.repeat(56);
const HOST_B = 'b'.repeat(56);
const HOST_C = 'c'.repeat(56);
const AUTH_KEY = 'ABCD2345ABCD2345ABCD2345ABCD2345ABCD2345ABCD2345ABC'; // 52-char base32-ish shape

// ── 1. signMirrors: kind-30078, d=stiq:mirrors, content [[url, authOrNull], ...] ─
{
  const mirrors = [
    {url: `ws://${HOST_A}.onion`, onionAuthKey: null},
    {url: `wss://${HOST_B}.onion`, onionAuthKey: AUTH_KEY},
  ];
  const event = signMirrors(mirrors);
  assert.strictEqual(event.kind, 30078, 'organizer mirrors event is kind-30078 (NIP-78 app data)');
  const dTag = event.tags.find(t => t[0] === 'd');
  assert.ok(dTag && dTag[1] === 'stiq:mirrors', 'the addressable d-tag is exactly "stiq:mirrors"');
  const parsed = JSON.parse(event.content);
  assert.ok(Array.isArray(parsed), 'content JSON-parses to an array');
  assert.deepStrictEqual(parsed, [
    [`ws://${HOST_A}.onion`, null],
    [`wss://${HOST_B}.onion`, AUTH_KEY],
  ], 'content is the terse [url, authKeyOrNull] pair wire the client parser reads');
  assert.ok(typeof event.sig === 'string' && event.sig.length === 128, 'event carries a schnorr signature');
  console.log('ok 1 — signMirrors emits kind-30078 d=stiq:mirrors with [[url, authOrNull], ...] content');
}

// ── 2. non-onion / malformed urls are dropped before signing ─────────────────────
{
  const mirrors = [
    {url: `ws://${HOST_A}.onion`, onionAuthKey: null},
    {url: 'https://example.com', onionAuthKey: null},        // not ws/wss
    {url: `ws://${'x'.repeat(55)}.onion`, onionAuthKey: null}, // 55 chars, not 56
    {url: `ws://${HOST_B}.ONION`, onionAuthKey: null},        // case-insensitive host still valid
    {url: 'not a url at all', onionAuthKey: null},
    {url: 42, onionAuthKey: null},                             // non-string url
    null,                                                      // non-object entry
  ];
  const parsed = JSON.parse(signMirrors(mirrors).content);
  assert.deepStrictEqual(parsed, [
    [`ws://${HOST_A}.onion`, null],
    [`ws://${HOST_B}.ONION`, null],
  ], 'only the valid ws/wss v3-onion entries survive, in order');
  console.log('ok 2 — non-onion / malformed / non-string urls are dropped before signing');
}

// ── 3. cap at MIRRORS_MAX (5) ─────────────────────────────────────────────────────
{
  const many = [];
  for (let i = 0; i < 9; i++) many.push({url: `ws://${String.fromCharCode(97 + i).repeat(56)}.onion`, onionAuthKey: null});
  const parsed = JSON.parse(signMirrors(many).content);
  assert.strictEqual(parsed.length, MIRRORS_MAX, `signMirrors caps the set at ${MIRRORS_MAX} entries`);
  console.log(`ok 3 — signMirrors caps at ${MIRRORS_MAX} entries`);
}

// ── 4. empty / all-invalid input signs an EMPTY array (organizer withdraws its mirrors) ──
{
  for (const input of [[], undefined, null, [{url: 'garbage'}], [{url: 'https://not-onion.example'}]]) {
    const parsed = JSON.parse(signMirrors(input).content);
    assert.deepStrictEqual(parsed, [], 'empty/all-invalid input (' + JSON.stringify(input) + ') signs []');
  }
  console.log('ok 4 — empty/all-invalid input signs an EMPTY array (valid organizer-withdrawal doc)');
}

// ── 5. onionAuthKey passthrough: only a non-empty string survives, else null ─────
{
  const cases = [
    [{url: `ws://${HOST_A}.onion`, onionAuthKey: undefined}, null],
    [{url: `ws://${HOST_A}.onion`, onionAuthKey: ''}, null],
    [{url: `ws://${HOST_A}.onion`, onionAuthKey: 123}, null],
    [{url: `ws://${HOST_A}.onion`, onionAuthKey: AUTH_KEY}, AUTH_KEY],
  ];
  for (const [input, expected] of cases) {
    const parsed = JSON.parse(signMirrors([input]).content);
    assert.strictEqual(parsed[0][1], expected, 'onionAuthKey ' + JSON.stringify(input.onionAuthKey) + ' -> ' + JSON.stringify(expected));
  }
  console.log('ok 5 — onionAuthKey only passes through as a non-empty string, else null');
}

// ── 6. POST /api/mirrors validation (mirrored sanitizeMirror) rejects non-onion urls ──
{
  assert.strictEqual(sanitizeMirror({url: 'https://example.com'}), null, 'a non-onion url is rejected');
  assert.strictEqual(sanitizeMirror({url: 'ws://short.onion'}), null, 'a too-short onion host is rejected');
  assert.strictEqual(sanitizeMirror({}), null, 'a missing url is rejected');
  assert.strictEqual(sanitizeMirror(null), null, 'a null body is rejected');
  const ok = sanitizeMirror({url: `ws://${HOST_C}.onion/path`, onionAuthKey: 'x'.repeat(52)});
  assert.deepStrictEqual(ok, {url: `ws://${HOST_C}.onion/path`, onionAuthKey: 'x'.repeat(52)}, 'a valid onion url (with path) + auth key survives sanitizeMirror unchanged');
  console.log('ok 6 — POST /api/mirrors validation (sanitizeMirror) rejects non-onion / malformed urls');
}

// ── 7. onionHostOfMirror / normalizeMirrorHost (used by DELETE /api/mirrors/<host>) ──
{
  assert.strictEqual(onionHostOfMirror(`wss://${HOST_A}.onion:443/x`), `${HOST_A}.onion`, 'onionHostOfMirror extracts the bare host from a full url');
  assert.strictEqual(onionHostOfMirror('https://example.com'), null, 'onionHostOfMirror rejects a non-onion url');
  assert.strictEqual(normalizeMirrorHost(HOST_B), `${HOST_B}.onion`, 'normalizeMirrorHost accepts a bare 56-char host');
  assert.strictEqual(normalizeMirrorHost(`${HOST_B}.onion`), `${HOST_B}.onion`, 'normalizeMirrorHost accepts a <host>.onion string');
  assert.strictEqual(normalizeMirrorHost(`ws://${HOST_B}.onion`), `${HOST_B}.onion`, 'normalizeMirrorHost accepts a full ws:// url');
  assert.strictEqual(normalizeMirrorHost('not-a-host'), null, 'normalizeMirrorHost rejects garbage');
  console.log('ok 7 — onionHostOfMirror / normalizeMirrorHost resolve the DELETE route\'s <host> param correctly');
}

console.log('\nall community relay mirror invariants hold.');

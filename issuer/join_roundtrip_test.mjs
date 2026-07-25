/**
 * In-app update-repo join-code fields (T9-S6).
 *
 * buildJoinCode carries four OPTIONAL trailing fields when the organizer has published an F-Droid update
 * repo on the community onion, read from env:
 *   up = update repo path (STIQ_UPDATE_REPO_PATH, e.g. '/fdroid/repo')
 *   uf = repo index signing cert sha256 (STIQ_UPDATE_REPO_CERT, 64-char lowercase hex)
 *   af = app signing cert sha256        (STIQ_UPDATE_APP_CERT,  64-char lowercase hex)
 *   ua = applicationId                  (STIQ_UPDATE_APP_ID, default 'com.stiq.client')
 *
 * Pinned properties:
 *   1. With STIQ_UPDATE_REPO_PATH set + valid fingerprints, the decoded JSON carries up/uf/af/ua.
 *   2. With none set, NO update fields appear (back-compat — an old v2 code is byte-identical).
 *   3. Malformed uf/af (non-hex / wrong length) are dropped, not fatal — up + ua still emit.
 *   4. ua defaults to com.stiq.client when STIQ_UPDATE_APP_ID is unset but a repo path is present.
 *   5. An uppercase-hex fingerprint is normalized to lowercase and accepted.
 *
 * The update-field block is mirrored below (kept in lockstep with organizer-server.mjs buildJoinCode,
 * exactly as storage_config_test.mjs mirrors sanitizeStorage) — organizer-server.mjs can't be imported
 * without booting the whole dashboard + minting keys, and reads its env once at module scope, so the
 * mirror takes an env object to exercise multiple scenarios in one process.
 */
import assert from 'assert';

// ── Mirror of organizer-server.mjs buildJoinCode update-repo block (kept in lockstep) ──
const UPDATE_CERT_RE = /^[0-9a-f]{64}$/;
function updateFields(env) {
  const repoPath = (env.STIQ_UPDATE_REPO_PATH || '').trim();
  const repoCert = (env.STIQ_UPDATE_REPO_CERT || '').trim().toLowerCase();
  const appCert  = (env.STIQ_UPDATE_APP_CERT  || '').trim().toLowerCase();
  const appId    = (env.STIQ_UPDATE_APP_ID    || '').trim();
  const out = {};
  if (repoPath) {
    out.up = repoPath;
    if (UPDATE_CERT_RE.test(repoCert)) out.uf = repoCert;
    if (UPDATE_CERT_RE.test(appCert))  out.af = appCert;
    out.ua = appId || 'com.stiq.client';
  }
  return out;
}

const JOIN_PREFIX = 'stiq:join:2:';
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildJoinCode(env) {
  const json = {
    v: 2,
    rs: [['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion', null]],
    cn: 'stiq community', on: 'organizer',
    cid: '0123456789abcdef', op: 'a'.repeat(64),
    i: 'STIQ-AAAA-BBBB-CCCC',
    ck: Buffer.alloc(32).toString('base64'),
    ...updateFields(env),
  };
  return JOIN_PREFIX + b64url(Buffer.from(JSON.stringify(json), 'utf8'));
}
function decodeJoin(code) {
  const b64 = code.slice(JOIN_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

const REPO_CERT = 'a'.repeat(64);
const APP_CERT  = 'b'.repeat(64);

// ── 1. all fields set + valid → present in decoded JSON ──────────────────────────
{
  const json = decodeJoin(buildJoinCode({
    STIQ_UPDATE_REPO_PATH: '/fdroid/repo',
    STIQ_UPDATE_REPO_CERT: REPO_CERT,
    STIQ_UPDATE_APP_CERT: APP_CERT,
    STIQ_UPDATE_APP_ID: 'com.stiq.client',
  }));
  assert.strictEqual(json.up, '/fdroid/repo', 'up = repo path');
  assert.strictEqual(json.uf, REPO_CERT, 'uf = repo index cert sha256');
  assert.strictEqual(json.af, APP_CERT, 'af = app cert sha256');
  assert.strictEqual(json.ua, 'com.stiq.client', 'ua = applicationId');
  console.log('ok 1 — up/uf/af/ua appear when STIQ_UPDATE_* are set with valid fingerprints');
}

// ── 2. none set → no update fields (back-compat with old v2 codes) ───────────────
{
  const bare = buildJoinCode({});
  const json = decodeJoin(bare);
  for (const k of ['up', 'uf', 'af', 'ua']) assert.ok(!(k in json), 'no ' + k + ' field when the repo path is unset');
  // and the code is byte-identical to one built with all update env explicitly empty
  assert.strictEqual(bare, buildJoinCode({STIQ_UPDATE_REPO_PATH: '', STIQ_UPDATE_APP_ID: ''}), 'empty env yields the byte-identical bare code');
  console.log('ok 2 — no update fields when STIQ_UPDATE_REPO_PATH is unset (back-compat)');
}

// ── 3. malformed uf/af dropped, not fatal — up + ua still emit ───────────────────
{
  const json = decodeJoin(buildJoinCode({
    STIQ_UPDATE_REPO_PATH: '/fdroid/repo',
    STIQ_UPDATE_REPO_CERT: 'not-hex!!',            // non-hex → dropped
    STIQ_UPDATE_APP_CERT: 'abc123',                // too short → dropped
    STIQ_UPDATE_APP_ID: 'org.example.app',
  }));
  assert.strictEqual(json.up, '/fdroid/repo', 'up still present despite malformed fingerprints');
  assert.ok(!('uf' in json), 'malformed uf dropped');
  assert.ok(!('af' in json), 'malformed af dropped');
  assert.strictEqual(json.ua, 'org.example.app', 'ua still present');
  console.log('ok 3 — malformed uf/af are silently dropped (never fatal); up + ua persist');
}

// ── 4. ua defaults to com.stiq.client when unset but repo path present ───────────
{
  const json = decodeJoin(buildJoinCode({STIQ_UPDATE_REPO_PATH: '/fdroid/repo', STIQ_UPDATE_REPO_CERT: REPO_CERT}));
  assert.strictEqual(json.ua, 'com.stiq.client', 'ua defaults to com.stiq.client');
  assert.strictEqual(json.uf, REPO_CERT, 'uf preserved');
  assert.ok(!('af' in json), 'af omitted when STIQ_UPDATE_APP_CERT is unset');
  console.log('ok 4 — ua defaults to com.stiq.client when STIQ_UPDATE_APP_ID is unset');
}

// ── 5. uppercase hex is normalized to lowercase and accepted ─────────────────────
{
  const json = decodeJoin(buildJoinCode({
    STIQ_UPDATE_REPO_PATH: '/fdroid/repo',
    STIQ_UPDATE_REPO_CERT: 'A'.repeat(64),   // uppercase → normalized
    STIQ_UPDATE_APP_CERT: '  ' + 'C'.repeat(64) + '  ', // whitespace + uppercase
  }));
  assert.strictEqual(json.uf, 'a'.repeat(64), 'uppercase uf normalized to lowercase');
  assert.strictEqual(json.af, 'c'.repeat(64), 'whitespace-padded uppercase af normalized');
  console.log('ok 5 — uppercase/whitespace fingerprints normalized to 64-char lowercase hex');
}

console.log('\nall update-repo join-code invariants hold.');

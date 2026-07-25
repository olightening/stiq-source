#!/usr/bin/env node
/**
 * Stiq Organizer — terminal client.
 *
 * The organizer dashboard (organizer-server.mjs) is a loopback JSON API driven by a browser SPA.
 * On a headless server (SSH session, no browser) you'd otherwise have to `ssh -L 7799:...` and open a
 * GUI just to mint an invite or add a moderator. This talks to the SAME JSON API from the terminal.
 *
 * It reuses the server's exact contract, so there is no second code path to keep in sync:
 *   • Targets the loopback bind (default http://127.0.0.1:7799). Run it ON the server, or forward the
 *     port first:  ssh -L 7799:127.0.0.1:7799 root@<host>  then run the CLI on your laptop.
 *   • Sends NO Origin header, so the server's CSRF guard (Origin-present-must-match-Host) passes —
 *     that guard only rejects a *mismatched* browser Origin; non-browser tooling with no Origin is
 *     explicitly allowed (organizer-server.mjs originMatchesHost).
 *   • When the dashboard runs password-protected (hosted / onion deployments set STIQ_ORG_PASSWORD),
 *     the first 401 triggers POST /api/login with the password from $STIQ_ORG_PASSWORD (or --password),
 *     and the returned stiq_org session cookie is carried on the retry + every later request this run.
 *   • In local-only mode (no password) nothing needs a login and every call just works.
 *
 * Zero dependencies — Node built-in http/https only (Node >= 18).
 *
 * Usage:
 *   node organizer-cli.mjs [--url URL] [--password PW] [--json] <command> [args…]
 *   (or via the shim)  ./stiq-org <command> [args…]
 *
 * Env:
 *   STIQ_ORG_URL        base URL of the dashboard      (default http://127.0.0.1:7799)
 *   STIQ_ORG_PASSWORD   password for a protected dashboard (only sent on a 401, never on argv)
 *
 * Commands:
 *   status                 Health + key facts (community code, relay onion, organizer npub, token policy)
 *   invites                List every invite (code · status · uses · created · expires)
 *   invite [--link] [--uses N | --unlimited]   Mint a new join code (default single-use; --link adds the stiq:// link)
 *   invite-revoke <code>   Delete an invite
 *   mods                   List moderators
 *   mod-add <npub>         Add a moderator to the roster
 *   mod-rm <npub>          Remove a moderator from the roster
 *   mods-publish           Sign + publish the moderator roster to the relay
 *   mirrors                List community relay mirrors
 *   mirror-add <ws-onion-url> [onionAuthKey]   Add a relay mirror (ws/wss v3 onion URL)
 *   mirror-rm <host>       Remove a relay mirror by onion host
 *   mirrors-publish        Sign + publish the mirror list to the relay
 *   limits                 Show the published relay limits
 *   token-policy           Show the per-member token quota + this epoch's draw activity
 *   config <name>          GET any /api/<name> config endpoint, pretty-printed
 *   set <name> <json|@file> POST a JSON body to /api/<name> (inline JSON, or @path / @- for stdin)
 *   get <path>             GET an arbitrary path (e.g. get /api/invites)
 *   call <METHOD> <path> [json|@file|@-]   Arbitrary request (body inline, from @file, or @- stdin)
 *   help                   This message
 */

import http from 'node:http';
import https from 'node:https';
import {URL} from 'node:url';

// ── args ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {url: process.env.STIQ_ORG_URL || 'http://127.0.0.1:7799', password: process.env.STIQ_ORG_PASSWORD || '', json: false};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') opts.url = argv[++i];
  else if (a === '--password') opts.password = argv[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '-h' || a === '--help') positional.unshift('help');
  else positional.push(a);
}
const [cmd, ...rest] = positional;

// Some subcommands (invite --url) take their own flags; strip known ones out of `rest`.
function takeFlag(name) {
  const i = rest.indexOf(name);
  if (i === -1) return false;
  rest.splice(i, 1);
  return true;
}
// Like takeFlag but consumes the following token as the option's value (e.g. `--uses 5`).
function takeOption(name) {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

// ── low-level HTTP (built-in modules — full header access incl. set-cookie) ──────
function rawRequest(method, urlStr, {headers = {}, body} = {}) {
  const u = new URL(urlStr);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {method, headers}, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

let _cookie = ''; // stiq_org=<token> once we've logged in
let _loginInFlight = null; // single-flight guard (see ensureLoggedIn)

function extractSessionCookie(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const c of arr) {
    const m = /(?:^|;\s*)?stiq_org=([a-f0-9]+)/.exec(c);
    if (m) return `stiq_org=${m[1]}`;
  }
  return '';
}

async function login() {
  if (!opts.password) {
    die('This dashboard is password-protected. Set STIQ_ORG_PASSWORD (preferred) or pass --password <pw>.');
  }
  const body = JSON.stringify({password: opts.password});
  // Deliberately no Origin header — the server allows Origin-absent requests (CSRF guard only blocks a
  // *mismatched* browser Origin).
  const res = await rawRequest('POST', opts.url + '/api/login', {
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
    body,
  });
  if (res.status === 429) die('Login throttled (too many attempts) — wait a minute and retry.');
  if (res.status !== 200) die('Login failed — wrong password?' + (res.status ? ` (HTTP ${res.status})` : ''));
  _cookie = extractSessionCookie(res.headers['set-cookie']);
  if (!_cookie) die('Login succeeded but no session cookie was returned — unexpected server response.');
}

// Log in AT MOST ONCE even under concurrency. `status` fires several reads together; all 401 before
// any cookie exists, so each must wait on the SAME login and then retry with that shared session. A
// naive "retry only if !_cookie" guard strands the siblings whose 401 is inspected after the first
// login lands (the cookie is now set, so they skip their own retry and surface a stale 401).
function ensureLoggedIn() {
  if (_cookie) return Promise.resolve();
  if (!_loginInFlight) _loginInFlight = login().finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

/**
 * Call the API. Auto-logs-in on the first 401 (password mode) and retries once. `bodyObj` is
 * JSON-encoded; pass a raw string via {rawBody} for the escape-hatch `call`.
 */
async function api(method, path, bodyObj, {rawBody} = {}) {
  const send = async () => {
    const headers = {};
    let body;
    if (rawBody !== undefined) {
      body = rawBody;
      if (body) headers['Content-Type'] = 'application/json';
    } else if (bodyObj !== undefined) {
      body = JSON.stringify(bodyObj);
      headers['Content-Type'] = 'application/json';
    }
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
    if (_cookie) headers['Cookie'] = _cookie;
    return rawRequest(method, opts.url + path, {headers, body});
  };
  let res;
  try {
    res = await send();
  } catch (e) {
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) {
      die(`Can't reach the organizer at ${opts.url} — is the service running?\n` +
          `  • On the server:   node organizer-server.mjs   (or systemctl status stiq-organizer)\n` +
          `  • From elsewhere:  ssh -L 7799:127.0.0.1:7799 <host>   then set STIQ_ORG_URL=http://127.0.0.1:7799`);
    }
    throw e;
  }
  if (res.status === 401) {
    await ensureLoggedIn();          // single-flight; a no-op if a sibling already logged in
    if (_cookie) res = await send(); // retry once with the session cookie
  }
  return res;
}

/** Parse a JSON response body, or die with the server's error message. */
function parse(res, what) {
  let obj;
  try { obj = res.body ? JSON.parse(res.body) : {}; } catch { obj = {_raw: res.body}; }
  if (res.status >= 400) {
    die(`${what} failed (HTTP ${res.status}): ${obj && obj.error ? obj.error : (res.body || 'no body').slice(0, 400)}`);
  }
  return obj;
}

function die(msg) { process.stderr.write(String(msg) + '\n'); process.exit(1); }
function out(s) { process.stdout.write(s + '\n'); }
function pretty(obj) { out(JSON.stringify(obj, null, 2)); }

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve a body argument: inline JSON, @path (file), or @- (stdin). */
async function resolveBody(arg) {
  if (arg === undefined) return undefined;
  if (arg === '@-') return await readStdin();
  if (arg.startsWith('@')) {
    const {readFileSync} = await import('node:fs');
    return readFileSync(arg.slice(1), 'utf8');
  }
  return arg;
}

// ── commands ─────────────────────────────────────────────────────────────────────
function fmtTs(s) { return s ? String(s).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

async function cmdStatus() {
  const [cc, ok, tk, tp, org] = await Promise.all([
    api('GET', '/api/community-code').then((r) => parse(r, 'community-code')),
    api('GET', '/api/organizer-key').then((r) => parse(r, 'organizer-key')),
    api('GET', '/api/token-keys').then((r) => parse(r, 'token-keys')),
    api('GET', '/api/token-policy').then((r) => parse(r, 'token-policy')),
    api('GET', '/api/organizer').then((r) => parse(r, 'organizer')).catch(() => ({})),
  ]);
  if (opts.json) return pretty({community: cc, organizer: ok, tokenKeys: tk, tokenPolicy: tp, meta: org});
  const line = (k, v) => out('  ' + (k + ':').padEnd(16) + (v ?? '—'));
  out('Stiq organizer — ' + opts.url);
  line('Community', org.communityName);
  line('Community code', cc.communityCode);
  line('Relay onion', cc.relayOnion);
  line('Relay WS', ok.relayWs);
  line('Organizer', cc.organizerNpub || ok.npub);
  line('Auth mode', _cookie ? 'password-protected' : 'local-only (no password)');
  line('Token domain-sep', tk.domainSeparation ? 'ON' : 'off');
  line('Token quota', `${tp.tokensPerEpoch}/member/epoch — epoch #${tp.epoch}: ${tp.drawnThisEpoch} drawn by ${tp.activeMembers} member(s)`);
}

async function cmdInvites() {
  const {invites} = parse(await api('GET', '/api/invites'), 'invites');
  const entries = Object.entries(invites || {});
  if (opts.json) return pretty(invites || {});
  if (!entries.length) return out('No invites yet. Mint one with:  stiq-org invite');
  out('CODE'.padEnd(21) + 'STATUS'.padEnd(11) + 'USES'.padEnd(10) + 'CREATED'.padEnd(22) + 'EXPIRES');
  for (const [code, info] of entries) {
    const uses = (info.usesCount ?? 0) + '/' + (info.maxUses == null ? 'inf' : info.maxUses);
    out(code.padEnd(21) + String(info.status || '').padEnd(11) + uses.padEnd(10) + fmtTs(info.createdAt).padEnd(22) + (info.expiresAt ? fmtTs(info.expiresAt) : 'never'));
  }
  out(`\n${entries.length} invite(s). Full join codes:  stiq-org invites --json`);
}

async function cmdInvite() {
  // `--link` (not `--url`, which is the global base-URL option) also prints the stiq:// deep link.
  const withLink = takeFlag('--link');
  // `--uses N` sets a finite use cap; `--unlimited` makes the link work until expiry/revoke. Default 1.
  const unlimited = takeFlag('--unlimited');
  const usesRaw = takeOption('--uses');
  const body = {};
  if (unlimited) {
    body.maxUses = null;
  } else if (usesRaw !== undefined) {
    const n = Number(usesRaw);
    if (!Number.isFinite(n) || Math.floor(n) < 1) die('--uses must be a positive integer (or use --unlimited)');
    body.maxUses = Math.floor(n);
  }
  const r = parse(await api('POST', '/api/join', body), 'invite');
  if (opts.json) return pretty(r);
  out('New invite minted.');
  out('  code:     ' + r.code);
  out('  joinCode: ' + r.joinCode);
  if (withLink && r.joinUrl) out('  joinUrl:  ' + r.joinUrl);
}

async function cmdInviteRevoke(code) {
  if (!code) die('usage: stiq-org invite-revoke <code>');
  parse(await api('DELETE', '/api/invite/' + encodeURIComponent(code)), 'invite-revoke');
  out(opts.json ? JSON.stringify({ok: true, code}) : `Revoked invite ${code}.`);
}

async function cmdMods() {
  const {moderators} = parse(await api('GET', '/api/moderators'), 'moderators');
  if (opts.json) return pretty(moderators || []);
  if (!moderators || !moderators.length) return out('No moderators. Add one with:  stiq-org mod-add <npub>');
  for (const m of moderators) out(m);
  out(`\n${moderators.length} moderator(s).`);
}

async function cmdModAdd(npub) {
  if (!npub) die('usage: stiq-org mod-add <npub1…>');
  const r = parse(await api('POST', '/api/moderators', {npub}), 'mod-add');
  out(opts.json ? JSON.stringify(r) : `Added. Roster now ${r.moderators.length}. Publish it with:  stiq-org mods-publish`);
}

async function cmdModRm(npub) {
  if (!npub) die('usage: stiq-org mod-rm <npub1…>');
  const r = parse(await api('DELETE', '/api/moderators/' + encodeURIComponent(npub)), 'mod-rm');
  out(opts.json ? JSON.stringify(r) : `Removed. Roster now ${r.moderators.length}. Publish it with:  stiq-org mods-publish`);
}

async function cmdModsPublish() {
  const r = parse(await api('POST', '/api/moderators/publish', {}), 'mods-publish');
  if (opts.json) return pretty(r);
  out(r.ok ? `Published moderator roster to the relay. ${r.message || ''}`.trim()
           : `Publish did not confirm: ${r.message || 'unknown'}`);
}

async function cmdMirrors() {
  const {mirrors} = parse(await api('GET', '/api/mirrors'), 'mirrors');
  if (opts.json) return pretty(mirrors || []);
  if (!mirrors || !mirrors.length) return out('No relay mirrors yet. Add one with:  stiq-org mirror-add <ws-onion-url> [onionAuthKey]');
  for (const m of mirrors) out(m.url + (m.onionAuthKey ? '  (auth-gated)' : '  (public)'));
  out(`\n${mirrors.length} mirror(s).`);
}

async function cmdMirrorAdd(wsOnionUrl, onionAuthKey) {
  if (!wsOnionUrl) die('usage: stiq-org mirror-add <ws-onion-url> [onionAuthKey]');
  const body = {url: wsOnionUrl};
  if (onionAuthKey) body.onionAuthKey = onionAuthKey;
  const r = parse(await api('POST', '/api/mirrors', body), 'mirror-add');
  out(opts.json ? JSON.stringify(r) : `Added. List now ${r.mirrors.length}. Publish it with:  stiq-org mirrors-publish`);
}

async function cmdMirrorRm(host) {
  if (!host) die('usage: stiq-org mirror-rm <host>');
  const r = parse(await api('DELETE', '/api/mirrors/' + encodeURIComponent(host)), 'mirror-rm');
  out(opts.json ? JSON.stringify(r) : `Removed. List now ${r.mirrors.length}. Publish it with:  stiq-org mirrors-publish`);
}

async function cmdMirrorsPublish() {
  const r = parse(await api('POST', '/api/mirrors/publish', {}), 'mirrors-publish');
  if (opts.json) return pretty(r);
  out(r.ok ? `Published mirror list to the relay. ${r.message || ''}`.trim()
           : `Publish did not confirm: ${r.message || 'unknown'}`);
}

async function cmdConfigGet(name) {
  if (!name) die('usage: stiq-org config <name>   (e.g. limits, tag-policy, permissions, gov, community, ranking, storage, bridges, mirrors, labels, reasons, guide, mailbox-policy, mod-limits, post-rules, picture-rules, safe-browsing, token-policy, organizer)');
  const path = name.startsWith('/') ? name : '/api/' + name;
  pretty(parse(await api('GET', path), 'config ' + name));
}

async function cmdSet(name, bodyArg) {
  if (!name || bodyArg === undefined) die('usage: stiq-org set <name> <json|@file|@->   (POSTs the JSON body to /api/<name>)');
  const path = name.startsWith('/') ? name : '/api/' + name;
  const rawBody = await resolveBody(bodyArg);
  try { JSON.parse(rawBody); } catch { die('body is not valid JSON'); }
  pretty(parse(await api('POST', path, undefined, {rawBody}), 'set ' + name));
}

async function cmdGet(path) {
  if (!path) die('usage: stiq-org get <path>   (e.g. get /api/invites)');
  pretty(parse(await api('GET', path.startsWith('/') ? path : '/' + path), 'get ' + path));
}

async function cmdCall(method, path, bodyArg) {
  if (!method || !path) die('usage: stiq-org call <METHOD> <path> [json|@file|@-]');
  const rawBody = await resolveBody(bodyArg);
  pretty(parse(await api(method.toUpperCase(), path.startsWith('/') ? path : '/' + path, undefined, {rawBody}), `${method} ${path}`));
}

function usage() {
  out(`Stiq Organizer — terminal client

Usage: stiq-org [--url URL] [--password PW] [--json] <command> [args…]
       (targets ${opts.url} — override with --url or STIQ_ORG_URL; run on the server or via ssh -L 7799:127.0.0.1:7799)

Read
  status                 Health + key facts (community code, relay onion, organizer npub, token policy)
  invites                List every invite  (--json for full join codes)
  mods                   List moderators
  mirrors                List community relay mirrors
  limits                 Show the published relay limits
  token-policy           Token quota + this epoch's draw activity
  config <name>          GET any /api/<name> config endpoint, pretty-printed
  get <path>             GET an arbitrary path

Write
  invite [--link]        Mint a new join code (--link also prints the stiq:// link)
  invite-revoke <code>   Delete an invite
  mod-add <npub>         Add a moderator
  mod-rm <npub>          Remove a moderator
  mods-publish           Sign + publish the moderator roster to the relay
  mirror-add <ws-onion-url> [onionAuthKey]   Add a relay mirror
  mirror-rm <host>       Remove a relay mirror
  mirrors-publish        Sign + publish the mirror list to the relay
  set <name> <json|@file|@->   POST a JSON body to /api/<name>
  call <METHOD> <path> [json|@file|@-]   Arbitrary request

  --json  raw JSON output     --password / STIQ_ORG_PASSWORD  for a protected dashboard`);
}

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':            usage(); break;
    case 'status':          await cmdStatus(); break;
    case 'invites':         await cmdInvites(); break;
    case 'invite':          await cmdInvite(); break;
    case 'invite-revoke':   await cmdInviteRevoke(rest[0]); break;
    case 'mods':            await cmdMods(); break;
    case 'mod-add':         await cmdModAdd(rest[0]); break;
    case 'mod-rm':          await cmdModRm(rest[0]); break;
    case 'mods-publish':    await cmdModsPublish(); break;
    case 'mirrors':         await cmdMirrors(); break;
    case 'mirror-add':      await cmdMirrorAdd(rest[0], rest[1]); break;
    case 'mirror-rm':       await cmdMirrorRm(rest[0]); break;
    case 'mirrors-publish': await cmdMirrorsPublish(); break;
    case 'limits':          await cmdConfigGet('limits'); break;
    case 'token-policy':    await cmdConfigGet('token-policy'); break;
    case 'config':          await cmdConfigGet(rest[0]); break;
    case 'set':             await cmdSet(rest[0], rest[1]); break;
    case 'get':             await cmdGet(rest[0]); break;
    case 'call':            await cmdCall(rest[0], rest[1], rest[2]); break;
    default:                die(`unknown command: ${cmd}\nrun  stiq-org help  for the list.`);
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));

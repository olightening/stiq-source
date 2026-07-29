/**
 * Stiq Organizer Dashboard — local-only community management console.
 *
 * Features:
 *   - Member invite codes (STIQ-XXXX-XXXX), single-use, with QR display
 *   - Community code display (relay + issuer pub key) with QR
 *   - Blind-signing enrollment requests (step 2 of 4-step onboarding flow)
 *   - Moderator npub management with TypeScript export
 *
 * Usage: node organizer-server.mjs [port]   (default 7799)
 * Then open http://localhost:7799 in a browser on this machine only.
 */

import {createServer} from 'http';
import {connect as netConnect} from 'net';
import {readFileSync, writeFileSync, renameSync, existsSync, chmodSync, accessSync, constants as FS} from 'fs';
import {fileURLToPath, pathToFileURL} from 'url';
import {dirname, join} from 'path';
import {timingSafeEqual, randomBytes, createHash} from 'crypto';
import {execFile} from 'child_process';
import QRCode from 'qrcode';
import {startMailbox, isOnionRelayUrl} from './mailbox.mjs';
import {issueInviteCredential, normalizeEntry, summarizeInvite} from './invite-issuance.mjs';
import {createContentKeyCustody, buildContentEpochDoc} from './contentEpochKeys.mjs';
import {startContentEpochWatcher} from './contentEpochWatcher.mjs';
import {organizerIdentity, signConfig, signRoster, signLimits, signPermissions, signBridges, signMirrors, publish, publishWithRetry, fetchEvents, encodeNpub, decodeNpub, verifyReaderAuth} from './organizer-nostr.mjs';
import {buildArchive, collectArtifactPaths} from './archive.mjs';
import {SPACE_OFFER_D_PREFIX, latestOffersByGid, newestOfferOf, resolveOfferedGroup, offeredGroupFromOffer} from './log-offer.mjs';
import {sanitizeLogPage} from './log-page.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] ?? '7799', 10);
// Bind host: 127.0.0.1 for local use; set STIQ_BIND=0.0.0.0 when hosting behind a reverse
// proxy / its own Tor onion (require STIQ_ORG_PASSWORD in that case — enforced below).
const BIND = process.env.STIQ_BIND || '127.0.0.1';
// NIP-13 difficulty mined on enroll responses — MUST match the relay's enroll_pow and the
// client's ENROLL_POW_DIFFICULTY.
const ENROLL_POW = parseInt(process.env.STIQ_ENROLL_POW ?? '12', 10);

// Atomic JSON state write: serialize to a temp sibling, then rename over the target. rename is
// atomic on POSIX, so a crash (or a full disk) mid-write can never leave a truncated/corrupt state
// file — a reader sees either the old bytes or the fully-written new bytes, never a partial. All the
// security-state + config sidecar writers below go through this. Output bytes are identical to the
// prior `JSON.stringify(obj, null, 2) + '\n'` shape, so nothing downstream changes.
function writeJsonAtomic(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

// ── Draw purposes (Appendix A wire vocabulary; T2.1/F9) — the CLOSED set drawTokensForMember
// validates payload.purpose against, and the set every per-purpose override map below is keyed by.
// Static + independent of TOKEN_DOMAIN_SEP (that flag only changes which KEY signs a purpose, never
// the purpose vocabulary itself), so it is safe — and necessary — to define this early: several policy
// loaders below build per-purpose override maps before the purpose keypairs themselves are loaded/
// minted (~line 1440).
const PURPOSE_ORDER = ['post', 'read', 'picture-write', 'picture-read', 'audio-write', 'audio-read', 'space-write'];
const ALL_PURPOSES = new Set(PURPOSE_ORDER);
// Sparse purpose -> value override map, shared shape for both token_policy.json's `perPurpose` and
// mailbox_policy.json's `perPurposeMaxDraws`: any purpose absent inherits the plain global scalar, so
// a policy file/dashboard that never sets one is byte-identical to before this existed.
function sanitizePerPurposeInts(raw, {allowZero}) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!ALL_PURPOSES.has(k)) continue;
      const n = Number.isInteger(v) ? v : parseInt(v, 10);
      if (Number.isInteger(n) && (allowZero ? n >= 0 : n > 0) && n <= 100000) out[k] = n;
    }
  }
  return out;
}

// Posting-token quota: how many blind posting tokens a member may draw per epoch (1 day) — the
// anti-spam knob for blind posts. The client spends one token per post, comment AND reaction/vote
// and draws them silently in the background, so this default is deliberately HIGH: it must sit well
// above anything a well-meaning member does in a day (a heavy user posts+reacts maybe a few hundred
// times) and only bite an automated spammer. Live-tunable from the dashboard Tokens panel (persisted
// to token_policy.json); STIQ_TOKENS_PER_EPOCH overrides the default.
const DEFAULT_TOKENS_PER_EPOCH = 1000;
const TOKEN_POLICY_PATH = join(__dirname, 'token_policy.json');
function loadTokenPolicy() {
  try {
    if (existsSync(TOKEN_POLICY_PATH)) {
      const p = JSON.parse(readFileSync(TOKEN_POLICY_PATH, 'utf8'));
      if (Number.isInteger(p.tokensPerEpoch) && p.tokensPerEpoch > 0) return p.tokensPerEpoch;
    }
  } catch { /* fall through to env/default */ }
  const n = parseInt(process.env.STIQ_TOKENS_PER_EPOCH ?? String(DEFAULT_TOKENS_PER_EPOCH), 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TOKENS_PER_EPOCH;
}
// Per-purpose tokensPerEpoch overrides (T2.1/F9 item 5 — the per-media write/read knob
// MEDIA_TOKENS_CENSORABLE_READS_SPEC.md §4a promised, which TOKENS_EVERYWHERE_SPEC.md §4 had
// deliberately dropped in favor of one shared pool). Lives in the SAME token_policy.json file (a
// `perPurpose` field) rather than a new sidecar.
function loadTokenPolicyOverrides() {
  try {
    if (existsSync(TOKEN_POLICY_PATH)) {
      const p = JSON.parse(readFileSync(TOKEN_POLICY_PATH, 'utf8'));
      return sanitizePerPurposeInts(p.perPurpose, {allowZero: false});
    }
  } catch { /* fall through to empty */ }
  return {};
}
// perPurpose defaults to the CURRENT overrides unless the caller is replacing them (the /api/
// token-policy POST handler), so a plain saveTokenPolicy(n) call (e.g. from a future call site that
// only ever touches the scalar) never clobbers a previously-configured per-purpose map.
function saveTokenPolicy(n, perPurpose) {
  writeJsonAtomic(TOKEN_POLICY_PATH, {tokensPerEpoch: n, perPurpose: perPurpose ?? TOKENS_PER_EPOCH_OVERRIDES});
}
// `let` so the Tokens panel can update it live without a restart.
let TOKENS_PER_EPOCH = loadTokenPolicy();
let TOKENS_PER_EPOCH_OVERRIDES = loadTokenPolicyOverrides();

// ── Mailbox / draw protection (issuer-side; not published to the relay) ─────────
// Defence-in-depth for THIS process (the single-threaded credential-exchange mailbox), complementing
// the relay's mailbox rate caps. Live-tunable from the dashboard Tokens panel (persisted to
// mailbox_policy.json); takes effect immediately without a restart.
//   maxDrawsPerEpoch — per-credential cap on the number of DISTINCT draw requests per epoch (a
//     retry of the same request is idempotent and doesn't count). Bounds per-request overhead
//     (decrypt + RSA verify + draws.json rewrite) on top of the token quota. 0 = unlimited.
//   dropInvalid — when true, a draw whose credential is invalid or whose payload is malformed gets
//     NO response: we skip mining + signing a reply for an unauthenticated request, removing the
//     attacker-controlled work that made a credential-less flood cheap. A real member never trips
//     this (their credential is valid); the client simply times out and retries if it somehow does.
//   maxConcurrent — ceiling on in-flight mailbox handlers; excess requests are shed (the client
//     retries) so a burst can't pile up unbounded promises + file writes on the event loop.
const MAILBOX_POLICY_PATH = join(__dirname, 'mailbox_policy.json');
const DEFAULT_MAILBOX_POLICY = {maxDrawsPerEpoch: 16, dropInvalid: true, maxConcurrent: 4, perPurposeMaxDraws: {}};
function sanitizeMailboxPolicy(p) {
  const n = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
  return {
    maxDrawsPerEpoch: n(p?.maxDrawsPerEpoch, DEFAULT_MAILBOX_POLICY.maxDrawsPerEpoch),
    dropInvalid: p?.dropInvalid !== false, // default true
    maxConcurrent: n(p?.maxConcurrent, DEFAULT_MAILBOX_POLICY.maxConcurrent),
    // Per-purpose maxDrawsPerEpoch overrides (T2.1/F9 item 5), sparse — see sanitizePerPurposeInts.
    // 0 is a valid override (unlimited FOR that purpose specifically), hence allowZero.
    perPurposeMaxDraws: sanitizePerPurposeInts(p?.perPurposeMaxDraws, {allowZero: true}),
  };
}
function loadMailboxPolicy() {
  try { if (existsSync(MAILBOX_POLICY_PATH)) return sanitizeMailboxPolicy(JSON.parse(readFileSync(MAILBOX_POLICY_PATH, 'utf8'))); }
  catch { /* fall through to defaults */ }
  return {...DEFAULT_MAILBOX_POLICY};
}
function saveMailboxPolicy(p) { writeJsonAtomic(MAILBOX_POLICY_PATH, p); }
// `let` so the dashboard can update it live; drawTokensForMember + the mailbox read it at call time.
let mailboxPolicy = loadMailboxPolicy();

// The relay's Tor onion is generated fresh on each community's box (deploy/stiq-up.sh reads it
// from /var/lib/tor/stiq-relay/hostname). Resolve it dynamically so the SAME dashboard code runs
// for every community without editing this file:
//   1. STIQ_RELAY_ONION env (set by the systemd unit the installer writes), else
//   2. relay_onion.txt next to this file (written by the installer).
// No hardcoded fallback: a wrong-but-plausible onion (e.g. a stale/other community's address baked
// into this file) is worse than a clear failure — it would silently point enrollment/publish at the
// wrong relay instead of failing loud. Throws when neither source is present; callers that need the
// onion (community-code display, mirrors, /api/community-code) surface that as a clear 5xx/error
// rather than limping along on a wrong address.
// Accepts a bare "<hash>.onion" or a full "ws://<hash>.onion" and normalizes to a ws:// URL.
function resolveRelayOnion() {
  let raw = (process.env.STIQ_RELAY_ONION || '').trim();
  if (!raw) {
    try {
      const f = readFileSync(join(__dirname, 'relay_onion.txt'), 'utf8').trim();
      if (f) raw = f;
    } catch { /* no file */ }
  }
  if (!raw) {
    throw new Error(
      'no relay onion configured: set STIQ_RELAY_ONION or write relay_onion.txt next to organizer-server.mjs ' +
      '(deploy/stiq-up.sh writes both automatically — this box likely needs a re-run, or is missing them entirely).'
    );
  }
  if (!/^wss?:\/\//.test(raw)) raw = 'ws://' + raw;        // bare hostname → ws:// URL
  return raw.replace(/\/+$/, '');                          // trim any trailing slash
}
const RELAY_ONION  = resolveRelayOnion();

// Where organizer config (roster + limits + tag policy) is published, and where the mailbox listens
// for enrollment/draw requests. Same precedence contract as resolveRelayOnion, plus a middle "file"
// rung of its own (relay_ws.txt, same directory/convention as relay_onion.txt) so a directly-reachable
// ws (e.g. an SSH tunnel, or a co-located relay's loopback port) can be pinned on disk without an env
// var surviving every invocation — mirrors how relay_onion.txt lets a manual `node organizer-server.mjs`
// run outside systemd still pick up the installer-resolved value:
//   1. RELAY_WS env (set by the systemd unit for the co-located case: ws://127.0.0.1:3334), else
//   2. relay_ws.txt next to this file, else
//   3. the relay's own onion (RELAY_ONION, already resolved above — routed over Tor).
// No hardcoded onion fallback here either: if this silently fell back to a wrong RELAY_ONION-shaped
// default the organizer would look "up" (dashboard loads, keys load) while every publish/mailbox
// call quietly targets the wrong relay — exactly the post-flip failure mode this finding exists to
// close (F2/org-1/X6: the organizer sits outside every automated defense check).
function resolveRelayWs() {
  const env = (process.env.RELAY_WS || '').trim();
  if (env) return env;
  try {
    const f = readFileSync(join(__dirname, 'relay_ws.txt'), 'utf8').trim();
    if (f) return f;
  } catch { /* no file — fall through to the onion */ }
  return RELAY_ONION;
}
const RELAY_WS     = resolveRelayWs();
// The co-located relay's config file — where its SECRETS live, incl. the Safe Browsing API key.
// Both services run as the same 'stiq' user, so the dashboard rewrites it in place and the relay
// hot-reloads it. This is a SECRET: it is written to the local config only, NEVER published to Nostr.
const RELAY_CONFIG_PATH = process.env.STIQ_RELAY_CONFIG || '/etc/stiq-relay/config.json';
function readRelayConfig() {
  try { return JSON.parse(readFileSync(RELAY_CONFIG_PATH, 'utf8')); } catch { return null; }
}
function writeRelayConfig(cfg) {
  writeFileSync(RELAY_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  try { chmodSync(RELAY_CONFIG_PATH, 0o600); } catch { /* best-effort; mode may already be 600 */ }
}
function relayConfigWritable() {
  try { accessSync(RELAY_CONFIG_PATH, FS.W_OK); return true; } catch { return false; }
}
// Translate a relay-config write failure into an operator-actionable message, shared by every
// endpoint that calls writeRelayConfig (2026-07-21 incident: config.json went root-owned mid-
// deployment, every subsequent write started EACCES-ing, and the dashboard only ever showed a
// generic "request failed" — masking both the cause and the fix, while /api/activation had ALREADY
// flipped READ_AUTH in memory before the failed write, so the running organizer silently diverged
// from the persisted config). EACCES is the realistic case (a manual chown, or config regenerated by
// a root-run script); anything else still surfaces its own code+message instead of a swallowed
// generic error.
function relayConfigWriteErrorMessage(e) {
  if (e && e.code === 'EACCES') {
    return `config file ${RELAY_CONFIG_PATH} is not writable by the organizer (EACCES) — ` +
      `run: chown stiq ${RELAY_CONFIG_PATH}`;
  }
  return `couldn't write ${RELAY_CONFIG_PATH}` + (e?.code ? ` (${e.code})` : '') + `: ${e?.message || e}`;
}

// SIGHUP the co-located relay so it re-reads config.json and hot-swaps its mutable fields (the
// booleans the activation panel flips: space_tokens_required, media advertisement, content
// encryption). Both services run as the SAME 'stiq' user, so `pkill -HUP` can signal the relay
// without root. Best-effort: a missing pkill / no matching process resolves without throwing, and
// the config write still stands (the change takes effect on the relay's next restart regardless).
// The issuer KEY LISTS are NOT in the relay's SIGHUP set (they load at startup), which is exactly
// why the panel only toggles booleans — the keys are put in place at deploy time.
function reloadRelay() {
  return new Promise(resolve => {
    execFile('pkill', ['-HUP', '-x', 'stiq-relay'], err => {
      // pkill exits 1 when no process matched — not fatal (dev boxes have no live relay).
      resolve(!err || err.code === 1);
    });
  });
}

// ── Safe-Browsing Tor SOCKS reachability (F5) ────────────────────────────────
// The dashboard can flip safe_browsing_api_key on and the relay hot-reloads config.json within
// ~10s, so the toggle LOOKS live immediately. But relay/main.go's Safe-Browsing proxy dials OUT
// over Tor via STIQ_TOR_SOCKS (bare "host:port", default "127.0.0.1:9050" — same env + default
// relay/main.go itself reads, see main.go:113-119), and under RELAY_SINGLE_ONION=1 (the default;
// see deploy/torrc + deploy/SINGLE_ONION.md) the MAIN tor instance runs `SocksPort 0` — that
// dependency is only satisfied by a SEPARATE `tor@stiq-client` instance, which deploy/stiq-up.sh
// provisions ONLY when it's re-run over SSH. Nothing in this UI ever surfaces that gap, so an
// organizer with no SSH habit (the whole point of this dashboard) sees "Active" while every
// hash-prefix lookup silently 503s closed.
// resolveSocksHostPort mirrors relay/main.go's own parsing exactly (bare host:port, no scheme) so
// this probes the SAME address the relay would dial — deliberately NOT the socks5h:// URL shape
// checkRelayReachable's SocksProxyAgent below expects, which is a different consumer.
function resolveSocksHostPort() {
  const raw = (process.env.STIQ_TOR_SOCKS || '').trim() || '127.0.0.1:9050';
  const m = /^(.+):(\d+)$/.exec(raw);
  return m ? {host: m[1], port: Number(m[2])} : {host: '127.0.0.1', port: 9050};
}
// A plain TCP connect-then-close — NOT a SOCKS handshake and NOT a real Safe-Browsing lookup, just
// "is anything listening here". That's the entire question F5 needs answered, and it's cheap enough
// to run on every GET /api/safe-browsing without spamming Tor or Google.
const SAFE_BROWSING_SOCKS_TIMEOUT_MS = 1500;
function checkSocksReachable() {
  const {host, port} = resolveSocksHostPort();
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* best-effort teardown, never fail the probe on it */ }
      resolve(ok);
    };
    const sock = netConnect({host, port, timeout: SAFE_BROWSING_SOCKS_TIMEOUT_MS});
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}
const PEM_PATH     = join(__dirname, 'issuer_private.pem');
const PUB_PATH     = join(__dirname, 'issuer_public.b64');
const INVITES_PATH = join(__dirname, 'invites.json');
const MODS_PATH    = join(__dirname, 'moderators.json');
const LIMITS_PATH  = join(__dirname, 'limits.json');
const TAG_POLICY_PATH = join(__dirname, 'tag_policy.json');
const GUIDE_PATH      = join(__dirname, 'guide.json');
const LABELS_PATH     = join(__dirname, 'labels.json');
const POST_RULES_PATH = join(__dirname, 'post_rules.json');
const PICTURE_RULES_PATH = join(__dirname, 'picture_rules.json');
const AUDIO_RULES_PATH = join(__dirname, 'audio_rules.json');
const READ_REVOKED_PATH = join(__dirname, 'read_revoked.json');

// Censorable reads (#4). When read-auth is enforced (STIQ_READ_AUTH=1), a READ-purpose token draw
// must carry a member-signed reader-auth proving their npub, and that npub must not be read-revoked.
// This is the ONLY organizer power over reading; the WRITE path is never gated, so posting stays
// blind + uncensorable (the most a mod can do to a poster is ban → advisory mod-log). Ships DARK:
// off by default → read draws stay anonymous, byte-identical to before.
// Runtime-toggleable (was const): the dashboard's activation panel flips this in lock-step with the
// relay's content_encryption/read_auth_required so enabling censorable reads turns on BOTH the relay
// advertisement AND the organizer's enforcement of it. Initial value from the env for a headless boot.
let READ_AUTH = process.env.STIQ_READ_AUTH === '1' || process.env.STIQ_READ_AUTH === 'true';
// Member-signed reader-auth kind — carried INSIDE the NIP-44 read-draw payload, never a relay event.
const KIND_READ_AUTH = 9028;
const READ_PURPOSES = new Set(['read', 'picture-read', 'audio-read']);
// Accept an npub (bech32) or 64-hex pubkey; return lowercase hex, or null if malformed.
function toHexPubkey(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  try { const d = decodeNpub(t); return typeof d === 'string' && /^[0-9a-f]{64}$/i.test(d) ? d.toLowerCase() : null; }
  catch { return null; }
}
function loadReadRevoked() {
  try {
    const raw = existsSync(READ_REVOKED_PATH) ? JSON.parse(readFileSync(READ_REVOKED_PATH, 'utf8')) : {pubkeys: []};
    return {pubkeys: Array.isArray(raw.pubkeys) ? raw.pubkeys.filter(p => /^[0-9a-f]{64}$/i.test(p)).map(p => p.toLowerCase()) : []};
  } catch { return {pubkeys: []}; }
}
function saveReadRevoked(set) { writeJsonAtomic(READ_REVOKED_PATH, set); }
function isReadRevoked(hexPubkey) {
  return loadReadRevoked().pubkeys.includes((hexPubkey || '').toLowerCase());
}
const REASONS_PATH    = join(__dirname, 'reasons.json');
const PERMISSIONS_PATH = join(__dirname, 'permissions.json');
const MOD_LIMITS_PATH  = join(__dirname, 'mod_limits.json');
const GOV_PATH         = join(__dirname, 'gov.json');
const COMMUNITY_CFG_PATH = join(__dirname, 'community.json');
const FEATURED_PATH      = join(__dirname, 'featured.json');
const LOG_PAGE_PATH      = join(__dirname, 'log-page.json');
const POSTING_GUIDELINES_PATH = join(__dirname, 'posting-guidelines.json');
const RANKING_PATH       = join(__dirname, 'ranking.json');
const STORAGE_PATH       = join(__dirname, 'storage.json');
const BRIDGES_PATH       = join(__dirname, 'bridges.json');
const MIRRORS_PATH       = join(__dirname, 'mirrors.json');

// Default rate-limit policy (0 = unlimited). Tunable in the Limits panel. Mirrors the relay's
// policy.DefaultLimits so relay and organizer agree before the first publish. mailbox_per_min /
// mailbox_per_conn_per_min throttle the credential-exchange mailbox request kinds (enroll 9020 +
// draw 9024) at the relay, shielding this single-threaded process from a forwarded-request flood.
const DEFAULT_LIMITS = {
  posts:    {daily: 20,  weekly: 100, monthly: 300},
  comments: {daily: 100, weekly: 500, monthly: 1500},
  channel:  {daily: 50,  weekly: 250, monthly: 750},
  dm_global_per_min: 60,
  exempt_moderators: true,
  allow_voice: false,
  mailbox_per_min: 240,
  mailbox_per_conn_per_min: 12,
};

// ── Keys ──────────────────────────────────────────────────────────────────────

const issuerPubKeyB64 = readFileSync(PUB_PATH, 'utf8').trim();
// Organizer Nostr key is the moderation trust root; generated + persisted on first run.
const organizer       = organizerIdentity();

// Shared community key (32 bytes, base64): every member holds it to decrypt blind-post
// attribution, while a relay/host — lacking it — stays blind to who authored what. Minted once
// and persisted; it is the community's membership secret. There is no revoke: it is handed to
// members in the community/join code, exactly like posting tokens are publish-only.
const COMMUNITY_KEY_PATH = join(__dirname, 'community_key.b64');
function loadOrMintCommunityKey() {
  try { if (existsSync(COMMUNITY_KEY_PATH)) return readFileSync(COMMUNITY_KEY_PATH, 'utf8').trim(); } catch {}
  // First run: mint + persist. This key is the membership secret baked into every join code and used
  // FOREVER to attribute blind posts. If a fresh key silently failed to persist, the next restart would
  // mint a DIFFERENT one and break attribution for every already-issued code irrecoverably. So read the
  // file back and assert it matches before trusting the in-memory key — a failed/partial write must
  // crash loudly rather than run on an unpersisted key.
  const key = randomBytes(32).toString('base64');
  try {
    writeFileSync(COMMUNITY_KEY_PATH, key + '\n');
    const readBack = readFileSync(COMMUNITY_KEY_PATH, 'utf8').trim();
    if (readBack !== key) throw new Error('read-back mismatch after write');
  } catch (e) {
    console.error('FATAL: could not persist the community key to ' + COMMUNITY_KEY_PATH + ' (' + (e?.message || e) + '). Running with an unpersisted key would break blind-post attribution on the next restart. Fix the filesystem/permissions and retry.');
    process.exit(1);
  }
  return key;
}
const communityKeyB64 = loadOrMintCommunityKey();

// Shared Tor v3 onion client-auth private key (lever 2): the credential a member's device needs to
// REACH the auth-gated relay onion. Provisioned by deploy/stiq-up.sh (RELAY_ONION_AUTH=1) and
// passed in as env; empty ⇒ a public onion, so we emit a v3 code and no reach credential.
const onionAuthKeyB32 = (process.env.STIQ_ONION_AUTH_KEY || '').trim();
const hasOnionAuth = /^[A-Z2-7]{52}$/.test(onionAuthKeyB32);

// Community code v3 carries the organizer npub (moderation trust root) AND the community key (so
// members can attribute blind posts). v4 additionally carries the onion client-auth key (reach
// credential). Older clients ignore trailing fields they don't understand.
const communityCode = hasOnionAuth
  ? 'stiq:community:4;' + RELAY_ONION + ';' + issuerPubKeyB64 + ';' + organizer.npub + ';' + communityKeyB64 + ';' + onionAuthKeyB32
  : 'stiq:community:3;' + RELAY_ONION + ';' + issuerPubKeyB64 + ';' + organizer.npub + ';' + communityKeyB64;

const pemText = readFileSync(PEM_PATH, 'utf8')
  .replace(/-----BEGIN PRIVATE KEY-----/, '')
  .replace(/-----END PRIVATE KEY-----/, '')
  .replace(/\s+/g, '');

const privateKey = await crypto.subtle.importKey(
  'pkcs8', Buffer.from(pemText, 'base64'),
  {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['sign'],
);

const blindrsaPath = join(__dirname, '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js');
const {RSABSSA} = await import(pathToFileURL(blindrsaPath).href);
const suite = RSABSSA.SHA384.PSS.Deterministic();

// ── Organizer Nostr identity (mailbox address for the automated exchange) ───────────────────
// The SAME organizer key that roots moderation (organizerIdentity above) is also the mailbox
// address members encrypt enrollment requests to, and the signer for the tag-policy config
// event. One key, three roles — derived here in the forms the mailbox needs.
const organizerSk  = organizer.sk;     // Uint8Array secret key
const organizerPub = organizer.pkHex;  // hex public key

// ── Community identity shown in the join code (so members recognize community + organizer) ──
const COMMUNITY_NAME  = process.env.STIQ_COMMUNITY_NAME  || 'stiq community';
const ORGANIZER_LABEL = process.env.STIQ_ORGANIZER_LABEL || 'organizer';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// v2 unified join envelope: full issuer keys move OUT of the link (fetched post-connect from the
// relay's NIP-11 `issuer_keys`, then verified against `cid`); relay(s) move into `rs` (capped at
// MAX_MIRRORS — the organizer currently emits exactly one mirror, so the cap is a no-op today but
// keeps a future multi-mirror rollout bounded without a wire-format change).
const MAX_MIRRORS = 5;

// ── In-app APK update repo pointer (T9-S6) — advisory join-code transport metadata ──────────────
// When the organizer has published an F-Droid-format update repo on the community onion (T9-S1/S2),
// these env vars carry its path + the pinned repo-index and app signing cert fingerprints + the
// applicationId into the join code so a member's app can find and verify updates over Tor. Absent ⇒
// the four fields are omitted and old/new join codes are byte-identical (ship-dark). These are advisory
// transport metadata, NOT a trust root for enrollment (cid/issuer keys remain the only trust anchors);
// old clients ignore the unknown up/uf/af/ua fields. Set from deploy/publish-fdroid.sh output before
// regenerating the join QR: STIQ_UPDATE_REPO_PATH + STIQ_UPDATE_REPO_CERT + STIQ_UPDATE_APP_CERT +
// STIQ_UPDATE_APP_ID.
const UPDATE_REPO_PATH = (process.env.STIQ_UPDATE_REPO_PATH || '').trim();
const UPDATE_REPO_CERT = (process.env.STIQ_UPDATE_REPO_CERT || '').trim().toLowerCase();
const UPDATE_APP_CERT  = (process.env.STIQ_UPDATE_APP_CERT  || '').trim().toLowerCase();
const UPDATE_APP_ID    = (process.env.STIQ_UPDATE_APP_ID    || '').trim();
const UPDATE_CERT_RE   = /^[0-9a-f]{64}$/; // 64-char lowercase hex SHA-256; malformed ⇒ field dropped, never fatal

/** The single copy-paste/QR join code that bootstraps a blank app (see client onboarding/join.ts). */
function buildJoinCode(inviteCode, expiresAt) {
  const policy = loadTagPolicy();
  // Relay-independent community id: 16-hex sha256 of the enroll issuer key's base64 SPKI string —
  // MUST match client walletKeyFingerprint(issuerPubKeyB64) byte-for-byte (hashes the base64 STRING,
  // not the decoded DER — see the NIP-11 issuer_keys field for the same invariant).
  const cid = createHash('sha256').update(issuerPubKeyB64, 'utf8').digest('hex').slice(0, 16);
  const json = {
    v: 2,
    rs: [[RELAY_ONION, hasOnionAuth ? onionAuthKeyB32 : null]].slice(0, MAX_MIRRORS),
    cn: COMMUNITY_NAME,
    on: ORGANIZER_LABEL,
    cid,
    op: organizerPub,
    i: inviteCode,
    ck: communityKeyB64, // shared community key — lets the member attribute blind posts
  };
  // Purpose-specific issuer keys (token domain separation, #3/#4/#29): posting tokens blind against
  // pk, read tokens against rk. Present only when enabled; older clients ignore unknown fields. When
  // SHORT_LINKS is on they are OMITTED (they are ~86% of the payload) and the member converges to them
  // live from the kind-30078 stiq:token-keys doc (publishTokenKeys) on connect — see SHORT_LINKS.
  if (TOKEN_DOMAIN_SEP && !SHORT_LINKS) {
    json.pk = postKey.pubB64; json.rk = readKey.pubB64;
    json.pwk = picWriteKey.pubB64; json.prk = picReadKey.pubB64;
    json.awk = audWriteKey.pubB64; json.ark = audReadKey.pubB64;
    json.swk = spaceWriteKey.pubB64; // space-write tokens (channels/groups/DMs spam-brake)
  }
  // Embed tag policy (compact keys) so new members get it from day one, before any relay sync.
  if (policy.communityTags.length > 0 || !policy.pinCommunityTags || !policy.allowMemberTags) {
    json.tp = {ct: policy.communityTags, pin: policy.pinCommunityTags, mem: policy.allowMemberTags};
  }
  // Seeded pluggable-transport bridges (T14-S4): rides the SAME stiq:join:2 envelope so a new member
  // can bootstrap Tor through censorship before any relay contact. Emitted only when bridges.json is
  // non-empty; old clients ignore json.br.
  const br = loadBridges().lines;
  if (br.length > 0) json.br = br;
  // In-app update repo pointer (T9-S6): emitted only when STIQ_UPDATE_REPO_PATH is set. Fingerprints
  // are validated to 64-char lowercase hex and dropped (not fatal) if malformed; applicationId defaults
  // to com.stiq.client so a member's updater always has a package to look up in the repo index.
  if (UPDATE_REPO_PATH) {
    json.up = UPDATE_REPO_PATH;
    if (UPDATE_CERT_RE.test(UPDATE_REPO_CERT)) json.uf = UPDATE_REPO_CERT;
    if (UPDATE_CERT_RE.test(UPDATE_APP_CERT))  json.af = UPDATE_APP_CERT;
    json.ua = UPDATE_APP_ID || 'com.stiq.client';
  }
  // Optional advisory expiry (feature 4) — UX hint only, never enforced from the wire value; the
  // authoritative check lives server-side in invite-issuance.mjs against inv[code].expiresAt.
  if (expiresAt) {
    const x = Math.floor(Date.parse(expiresAt) / 1000);
    if (Number.isFinite(x)) json.x = x;
  }
  return 'stiq:join:2:' + b64url(Buffer.from(JSON.stringify(json), 'utf8'));
}

// ── Invites ───────────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  // 12 significant characters (three groups of four) — the member's "12-digit code".
  const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => CHARS[b % 32]).join('');
  return 'STIQ-' + rand(4) + '-' + rand(4) + '-' + rand(4);
}
function loadInvites() {
  try { return existsSync(INVITES_PATH) ? JSON.parse(readFileSync(INVITES_PATH, 'utf8')) : {}; }
  catch (e) {
    // A corrupt invites.json silently reading as {} would drop every single-use invite's spent record,
    // letting already-redeemed invites be reissued/reused. Make the corruption discoverable.
    console.error('[organizer] WARNING: could not read ' + INVITES_PATH + ' (' + (e?.message || e) + '); invite state reads as EMPTY — single-use invites may be reissued/reused. Inspect the file for corruption.');
    return {};
  }
}
function saveInvites(inv) { writeJsonAtomic(INVITES_PATH, inv); }

// ── Moderators ────────────────────────────────────────────────────────────────

function loadMods() {
  try { return existsSync(MODS_PATH) ? JSON.parse(readFileSync(MODS_PATH, 'utf8')) : []; }
  catch (e) {
    // A corrupt moderators.json silently reading as [] would let a roster PUBLISH clear every
    // moderator. Log loudly so an operator notices before signing/publishing an empty roster.
    console.error('[organizer] WARNING: could not read ' + MODS_PATH + ' (' + (e?.message || e) + '); moderator roster reads as EMPTY — publishing now would clear all moderators. Inspect the file for corruption.');
    return [];
  }
}
function saveMods(list) { writeJsonAtomic(MODS_PATH, list); }

// ── Community relay mirrors ──────────────────────────────────────────────────
// The organizer's own additional relays for the community, published as a kind-30078 d=stiq:mirrors
// event — the wire contract is owned by the CLIENT (client/src/app/AppRuntime.ts parseMirrorsEvent /
// client/src/onboarding/join.ts MAX_MIRRORS) and already ships; this is only the publish side. Each
// stored mirror is {url, onionAuthKey}: url a ws/wss v3-onion address, onionAuthKey either a base32
// x25519 client-auth key (string) or null for a public onion. Capped at MIRRORS_MAX and de-duped by
// onion host so what's stored here can never exceed what the client will parse anyway.
const MIRRORS_MAX = 5;
const ONION_WS_RE = /^wss?:\/\/[a-z2-7]{56}\.onion(?:[:/?#]|$)/i;
/** Extract the bare `<56-char>.onion` host from a ws/wss onion URL, or null if not one. */
function onionHostOfMirror(u) {
  const m = /^wss?:\/\/([a-z2-7]{56}\.onion)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}
/** Accept a bare 56-char base32 host, a `<host>.onion` host, or a full ws/wss URL; else null. */
function normalizeMirrorHost(s) {
  const fromUrl = onionHostOfMirror(s);
  if (fromUrl) return fromUrl;
  const bare = String(s || '').trim().toLowerCase();
  if (/^[a-z2-7]{56}$/.test(bare)) return bare + '.onion';
  if (/^[a-z2-7]{56}\.onion$/.test(bare)) return bare;
  return null;
}
/** Validate + normalize one mirror entry, or null if its url isn't a valid ws/wss v3 onion. */
function sanitizeMirror(m) {
  if (!m || typeof m.url !== 'string' || !ONION_WS_RE.test(m.url)) return null;
  const onionAuthKey = (typeof m.onionAuthKey === 'string' && m.onionAuthKey) ? m.onionAuthKey : null;
  return {url: m.url, onionAuthKey};
}
function loadMirrors() {
  try { return existsSync(MIRRORS_PATH) ? JSON.parse(readFileSync(MIRRORS_PATH, 'utf8')) : []; }
  catch (e) {
    // A corrupt mirrors.json silently reading as [] would let a PUBLISH withdraw every
    // organizer-published mirror. Log loudly so an operator notices before signing/publishing an
    // empty list.
    console.error('[organizer] WARNING: could not read ' + MIRRORS_PATH + ' (' + (e?.message || e) + '); mirror list reads as EMPTY — publishing now would withdraw all organizer-published mirrors. Inspect the file for corruption.');
    return [];
  }
}
function saveMirrors(list) { writeJsonAtomic(MIRRORS_PATH, list); }

// ── Tag policy ────────────────────────────────────────────────────────────────

const DEFAULT_TAG_POLICY = {communityTags: [], pinCommunityTags: true, allowMemberTags: true, tagScopes: {}};

function loadTagPolicy() {
  try { return existsSync(TAG_POLICY_PATH) ? JSON.parse(readFileSync(TAG_POLICY_PATH, 'utf8')) : DEFAULT_TAG_POLICY; }
  catch { return DEFAULT_TAG_POLICY; }
}
function saveTagPolicy(p) { writeJsonAtomic(TAG_POLICY_PATH, p); }

// ── Limits ────────────────────────────────────────────────────────────────────

function loadLimits() {
  // Merge over the defaults so a limits.json written before the mailbox caps existed still surfaces
  // (and, once re-saved, publishes) them — otherwise those fields would read as blank/0 in the panel.
  try { return existsSync(LIMITS_PATH) ? {...DEFAULT_LIMITS, ...JSON.parse(readFileSync(LIMITS_PATH, 'utf8'))} : {...DEFAULT_LIMITS}; }
  catch { return {...DEFAULT_LIMITS}; }
}
function saveLimits(l) { writeJsonAtomic(LIMITS_PATH, l); }

// ── Community guide (kind-30078 stiq:guide, shown atop the app's Log tab) ────────
// Longest title the client will surface (organizerConfig.ts MAX_GUIDE_TITLE) — keep in sync.
const MAX_GUIDE_TITLE = 120;
const DEFAULT_GUIDE = {title: 'Community Guide', content: ''};
function loadGuide() {
  try { return existsSync(GUIDE_PATH) ? JSON.parse(readFileSync(GUIDE_PATH, 'utf8')) : {...DEFAULT_GUIDE}; }
  catch { return {...DEFAULT_GUIDE}; }
}
function saveGuide(g) { writeJsonAtomic(GUIDE_PATH, g); }

// ── Post config: labels / per-type rules / reason buckets (kind-30078) ──────────
// The dashboard stores the friendly shape ({id,name,color}); the POST routes convert to the
// compact wire ({lbls:[{id,nm,c,o}]} etc.) the client + relay read. Defaults mirror the client's
// DEFAULT_* so an un-configured community looks identical before the organizer publishes.

function slug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}
function hexColor(c, fallback) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}
/** Coerce a post-type scope; anything unrecognized ⇒ 'all'. */
function postScope(v) { return v === 'note' || v === 'article' ? v : 'all'; }
/**
 * Normalize a list of {id?,name,color} into unique-id'd entries (id derived from name when absent).
 * When `withScope` is set (labels only), also carries a per-entry `appliesTo` post-type scope.
 */
function sanitizeNamedColors(arr, fallbackName, withScope) {
  const seen = new Set(), out = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const name = (typeof x?.name === 'string' && x.name.trim()) || fallbackName;
    let id = slug(x?.id) || slug(name) || fallbackName.toLowerCase();
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const entry = {id, name, color: hexColor(x?.color, '#8a8f98')};
    if (withScope) entry.appliesTo = postScope(x?.appliesTo);
    out.push(entry);
  }
  return out;
}

const DEFAULT_LABELS_CFG = [
  {id: 'insight',    name: 'Insight',    color: '#6f90c0', appliesTo: 'all'},
  {id: 'question',   name: 'Question',   color: '#9b8cc6', appliesTo: 'all'},
  {id: 'discussion', name: 'Discussion', color: '#6fab90', appliesTo: 'all'},
  {id: 'personal',   name: 'Personal',   color: '#c79583', appliesTo: 'all'},
  {id: 'fun',        name: 'Fun',        color: '#bfa75e', appliesTo: 'all'},
];
function loadLabels() {
  try { return existsSync(LABELS_PATH) ? JSON.parse(readFileSync(LABELS_PATH, 'utf8')) : DEFAULT_LABELS_CFG.slice(); }
  catch { return DEFAULT_LABELS_CFG.slice(); }
}
function saveLabelsCfg(l) { writeJsonAtomic(LABELS_PATH, l); }

const DEFAULT_POST_RULES_CFG = {
  note:    {min: 0, max: 280, mediaMax: 1, labelRequired: false},
  article: {min: 0, max: 0,   mediaMax: 8, labelRequired: false},
  authorNoteMax: 280,
};
function ruleOf(o, dflt) {
  o = o || {};
  const n = (v, d) => Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  // mediaMax: max inline pictures + voice notes per post (0 = unlimited). Media is exempt from the
  // length limit; this is its separate cap.
  return {min: n(o.min, dflt.min), max: n(o.max, dflt.max), mediaMax: n(o.mediaMax, dflt.mediaMax), labelRequired: o.labelRequired === true};
}
function sanitizePostRules(body) {
  const anmx = body?.authorNoteMax;
  return {
    note:    ruleOf(body?.note,    DEFAULT_POST_RULES_CFG.note),
    article: ruleOf(body?.article, DEFAULT_POST_RULES_CFG.article),
    authorNoteMax: Number.isFinite(anmx) && anmx >= 0 ? Math.floor(anmx) : DEFAULT_POST_RULES_CFG.authorNoteMax,
  };
}
function loadPostRules() {
  try { return existsSync(POST_RULES_PATH) ? JSON.parse(readFileSync(POST_RULES_PATH, 'utf8')) : {...DEFAULT_POST_RULES_CFG}; }
  catch { return {...DEFAULT_POST_RULES_CFG}; }
}
function savePostRules(r) { writeJsonAtomic(POST_RULES_PATH, r); }

// Picture limits (Stiq Pictures). allow / caps / per-period byte allowance. The per-period allowance
// + res/colour caps + on/off are CLIENT-enforced (relay-blind posts can't be attributed per member);
// maxBytesPerPicture is backstopped by the relay's content-neutral max_event_bytes cap. Keep
// maxBytesPerPicture <= relay max_event_bytes so a picture never trips the generic size gate.
const DEFAULT_PICTURE_RULES_CFG = {
  allow: true,
  allowanceBytes: 128 * 1024,
  periodHours: 24,
  maxBytesPerPicture: 48 * 1024,
  maxRes: 256,
  maxColours: 64,
};
function sanitizePictureRules(body) {
  const nn = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return {
    allow: body?.allow === true,
    allowanceBytes: nn(body?.allowanceBytes, DEFAULT_PICTURE_RULES_CFG.allowanceBytes),
    periodHours: pos(body?.periodHours, DEFAULT_PICTURE_RULES_CFG.periodHours),
    maxBytesPerPicture: pos(body?.maxBytesPerPicture, DEFAULT_PICTURE_RULES_CFG.maxBytesPerPicture),
    maxRes: pos(body?.maxRes, DEFAULT_PICTURE_RULES_CFG.maxRes),
    maxColours: pos(body?.maxColours, DEFAULT_PICTURE_RULES_CFG.maxColours),
  };
}
function loadPictureRules() {
  try { return existsSync(PICTURE_RULES_PATH) ? JSON.parse(readFileSync(PICTURE_RULES_PATH, 'utf8')) : {...DEFAULT_PICTURE_RULES_CFG}; }
  catch { return {...DEFAULT_PICTURE_RULES_CFG}; }
}
function savePictureRules(r) { writeJsonAtomic(PICTURE_RULES_PATH, r); }

// Voice/audio limits (stiq:audio-limits). Bytes are DECODED audio (what the recorder produces), the
// same unit as the client's MAX_VOICE_BYTES. bitrateKbps/sampleRateHz are the recording knobs the app
// hands the native AAC encoder; maxBytesPerClip is backstopped by the relay's content-neutral
// max_event_bytes (accounting for base64 expansion when the clip rides in an event).
const DEFAULT_AUDIO_RULES_CFG = {
  allow: true,
  allowanceBytes: 1024 * 1024,
  periodHours: 24,
  maxBytesPerClip: 200 * 1024,
  maxDurationSec: 60,
  bitrateKbps: 24,
  sampleRateHz: 24000,
};
function sanitizeAudioRules(body) {
  const nn = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  // Out-of-range bitrate/sample-rate fall back to the default (not clamped) so a garbage value can't
  // become a surprise encoder setting — matches the client's audioRules.ts clampInt.
  const rng = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : d);
  return {
    allow: body?.allow === true,
    allowanceBytes: nn(body?.allowanceBytes, DEFAULT_AUDIO_RULES_CFG.allowanceBytes),
    periodHours: pos(body?.periodHours, DEFAULT_AUDIO_RULES_CFG.periodHours),
    maxBytesPerClip: pos(body?.maxBytesPerClip, DEFAULT_AUDIO_RULES_CFG.maxBytesPerClip),
    maxDurationSec: pos(body?.maxDurationSec, DEFAULT_AUDIO_RULES_CFG.maxDurationSec),
    bitrateKbps: rng(body?.bitrateKbps, 8, 128, DEFAULT_AUDIO_RULES_CFG.bitrateKbps),
    sampleRateHz: rng(body?.sampleRateHz, 8000, 48000, DEFAULT_AUDIO_RULES_CFG.sampleRateHz),
  };
}
function loadAudioRules() {
  try { return existsSync(AUDIO_RULES_PATH) ? JSON.parse(readFileSync(AUDIO_RULES_PATH, 'utf8')) : {...DEFAULT_AUDIO_RULES_CFG}; }
  catch { return {...DEFAULT_AUDIO_RULES_CFG}; }
}
function saveAudioRules(r) { writeJsonAtomic(AUDIO_RULES_PATH, r); }

const DEFAULT_REASONS_CFG = {
  buckets: [
    {id: 'spam',       name: 'Spam',       color: '#c77b7b'},
    {id: 'harassment', name: 'Harassment', color: '#b5563f'},
    {id: 'off-topic',  name: 'Off-topic',  color: '#9b8cc6'},
    {id: 'illegal',    name: 'Illegal',    color: '#c79583'},
    {id: 'other',      name: 'Other',      color: '#8a8f98'},
  ],
  reportThreshold: 0,
};
function sanitizeReasons(body) {
  const th = Number.isFinite(body?.reportThreshold) && body.reportThreshold > 0 ? Math.floor(body.reportThreshold) : 0;
  return {buckets: sanitizeNamedColors(body?.buckets, 'Reason'), reportThreshold: th};
}
function loadReasons() {
  try { return existsSync(REASONS_PATH) ? JSON.parse(readFileSync(REASONS_PATH, 'utf8')) : JSON.parse(JSON.stringify(DEFAULT_REASONS_CFG)); }
  catch { return JSON.parse(JSON.stringify(DEFAULT_REASONS_CFG)); }
}
function saveReasonsCfg(r) { writeJsonAtomic(REASONS_PATH, r); }

// ── Permissions: per-moderator action scopes (kind-30078, d=stiq:permissions) ────
// Stored friendly (scopes keyed by npub); converted to hex at signing time via signPermissions.
// The wire shape the client + relay read is {def:[scopes], mods:{<hexpubkey>:[scopes]}}.
const PERM_SCOPES = ['hide-post', 'hide-comment', 'ban', 'retag', 'pin', 'lock', 'restore'];
const DEFAULT_PERMISSIONS = {def: ['hide-post', 'hide-comment', 'retag', 'pin', 'lock', 'restore'], mods: {}};

/** Keep only known scope strings, deduped and in canonical order. */
function sanitizeScopes(arr) {
  const set = new Set(Array.isArray(arr) ? arr.filter(s => PERM_SCOPES.includes(s)) : []);
  return PERM_SCOPES.filter(s => set.has(s));
}
function sanitizePermissions(body) {
  const mods = {};
  const src = body && typeof body.mods === 'object' && body.mods ? body.mods : {};
  for (const npub of Object.keys(src)) {
    if (typeof npub === 'string' && npub.startsWith('npub1')) mods[npub] = sanitizeScopes(src[npub]);
  }
  return {def: sanitizeScopes(body?.def), mods};
}
function loadPermissions() {
  try { return existsSync(PERMISSIONS_PATH) ? JSON.parse(readFileSync(PERMISSIONS_PATH, 'utf8')) : JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS)); }
  catch { return JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS)); }
}
function savePermissions(p) { writeJsonAtomic(PERMISSIONS_PATH, p); }

// ── Mod limits: caps on a moderator's OWN actions (kind-30078, d=stiq:mod-limits) ─
// Wire shape: {hide:{d,w}, ban:{d,w}, …} for each action (0 = unlimited).
const MOD_LIMIT_ACTIONS = ['hide', 'ban', 'restore', 'lock', 'unlock', 'retag', 'pin', 'unpin'];
function defaultModLimits() {
  const o = {};
  for (const a of MOD_LIMIT_ACTIONS) o[a] = {d: 0, w: 0};
  return o;
}
function sanitizeModLimits(body) {
  const n = v => Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const a of MOD_LIMIT_ACTIONS) {
    const r = src[a] && typeof src[a] === 'object' ? src[a] : {};
    out[a] = {d: n(r.d), w: n(r.w)};
  }
  return out;
}
function loadModLimits() {
  try { return existsSync(MOD_LIMITS_PATH) ? JSON.parse(readFileSync(MOD_LIMITS_PATH, 'utf8')) : defaultModLimits(); }
  catch { return defaultModLimits(); }
}
function saveModLimits(l) { writeJsonAtomic(MOD_LIMITS_PATH, l); }

// ── Governance: newcomer restrictions + channel-creation policy (d=stiq:gov) ──────
// Wire shape: {ncd:int, nl:bool, nc:bool, cc:"any"|"mods"|"org"}.
const GOV_CC = ['any', 'mods', 'org'];
const DEFAULT_GOV = {ncd: 0, nl: false, nc: false, cc: 'any'};
function sanitizeGov(body) {
  const ncd = Number.isFinite(body?.ncd) && body.ncd >= 0 ? Math.floor(body.ncd) : 0;
  const cc = GOV_CC.includes(body?.cc) ? body.cc : 'any';
  return {ncd, nl: body?.nl === true, nc: body?.nc === true, cc};
}
function loadGov() {
  try { return existsSync(GOV_PATH) ? JSON.parse(readFileSync(GOV_PATH, 'utf8')) : {...DEFAULT_GOV}; }
  catch { return {...DEFAULT_GOV}; }
}
function saveGov(g) { writeJsonAtomic(GOV_PATH, g); }

// ── Community: identity + posting/announcement settings (d=stiq:community) ────────
// Wire shape: {nm,desc,icn,acc,dv,ew,ae,ad,ann:{t,u}} (acc = accent hex; dv = default feed view).
const COMM_VIEWS = ['list', 'topics', 'conversation'];
const DEFAULT_COMMUNITY = {
  nm: '', desc: '', icn: '', acc: '#8a8f98', dv: 'list', ew: 0, ae: true, ad: true,
  ann: {t: '', u: 0},
};
function sanitizeCommunity(body) {
  const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const n = v => Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const dv = COMM_VIEWS.includes(body?.dv) ? body.dv : 'list';
  const annSrc = body?.ann && typeof body.ann === 'object' ? body.ann : {};
  return {
    nm: str(body?.nm, 80),
    desc: str(body?.desc, 500),
    icn: str(body?.icn, 300),
    acc: hexColor(body?.acc, '#8a8f98'),
    dv,
    ew: n(body?.ew),
    ae: body?.ae !== false,
    ad: body?.ad !== false,
    ann: {t: str(annSrc.t, 500), u: n(annSrc.u)},
  };
}
function loadCommunity() {
  try { return existsSync(COMMUNITY_CFG_PATH) ? JSON.parse(readFileSync(COMMUNITY_CFG_PATH, 'utf8')) : JSON.parse(JSON.stringify(DEFAULT_COMMUNITY)); }
  catch { return JSON.parse(JSON.stringify(DEFAULT_COMMUNITY)); }
}
function saveCommunity(c) { writeJsonAtomic(COMMUNITY_CFG_PATH, c); }

// ── Featured spaces (kind-30078 stiq:featured) ───────────────────────────────────
// The organizer's ORDERED rail atop the Log tab. Wire {v:1, items:[{a,t,l,n,g?}]} — `a` = the space
// ref (a `30311:<owner>:<d>` coordinate for a channel, a group id for a group, a hex pubkey for a
// user), `t` = 'channel'|'group'|'user', `l` = the organizer's label chip, `n` = a name snapshot,
// `g` = an optional gradient snapshot (encodeGradient wire form). `n`/`g` are the client's fallback
// when a space's own live metadata is unreachable — NIP-29 groups are off-firehose, and a channel's
// 30311 may not be in the newest-N firehose window yet — so the row still paints its real name +
// gradient offline. A pasted `stiq:space:` share link (the only in-app channel reference a member can
// copy) is normalized here to its coordinate + carried name/gradient. The client re-validates and
// re-caps all of this (moderation/organizerConfig.ts currentFeaturedSpaces) — these caps MUST match
// MAX_FEATURED_SPACES / MAX_FEATURED_LABEL there, or the dashboard would silently publish rows the
// app drops on the floor.
/** First value of the named single-letter/string tag on a Nostr event, or '' when absent. */
function evTag(ev, name) {
  const t = ev.tags && ev.tags.find(x => x[0] === name);
  return t && typeof t[1] === 'string' ? t[1] : '';
}

const MAX_FEATURED = 12;
const MAX_FEATURED_LABEL = 24;
const MAX_FEATURED_GRADIENT = 120;
// 'user' features a person by hex pubkey (opened as their profile in the app); 'channel'/'group'
// address spaces. Keep in sync with the client's currentFeaturedSpaces parser.
const FEATURED_TYPES = ['channel', 'group', 'user'];
const HEX64 = /^[0-9a-f]{64}$/;
const SPACE_EMBED_PREFIX = 'stiq:space:';

// Decode the app's own `stiq:space:<base64url(JSON)>` share link (client channels/spaceEmbed.ts) —
// the ONLY channel/group reference a member can copy in-app, so it is what an organizer naturally
// pastes into the featured list. Returns the native coordinate (== the client's Channel.id) plus the
// name + gradient the link carries, or null if it isn't a decodable space link. Never throws.
function decodeSpaceLink(a) {
  if (typeof a !== 'string' || !a.startsWith(SPACE_EMBED_PREFIX)) return null;
  const payload = a.slice(SPACE_EMBED_PREFIX.length);
  if (!payload || payload.length > 1024) return null;
  try {
    let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const rem = b64.length % 4;
    if (rem) b64 += '='.repeat(4 - rem);
    const wire = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!wire || (wire.k !== 30311 && wire.k !== 39000)) return null;
    if (typeof wire.o !== 'string' || !wire.o) return null;
    if (typeof wire.i !== 'string' || !wire.i) return null;
    return {
      a: `${wire.k}:${wire.o}:${wire.i}`,
      t: wire.k === 30311 ? 'channel' : 'group',
      n: typeof wire.n === 'string' ? wire.n : '',
      g: typeof wire.g === 'string' ? wire.g : '',
    };
  } catch { return null; }
}

function sanitizeFeatured(body) {
  const src = Array.isArray(body?.items) ? body.items : [];
  const seen = new Set();
  const items = [];
  for (const it of src) {
    if (!it || typeof it !== 'object') continue;
    let a = typeof it.a === 'string' ? it.a.trim() : '';
    if (!a) continue;
    let t = it.t;
    let n = typeof it.n === 'string' ? it.n : '';
    let g = typeof it.g === 'string' ? it.g : '';
    // A pasted share link normalizes to the native coordinate + carried name/gradient, so the stored
    // wire is always a coordinate the client can match against a real space.
    if (a.startsWith(SPACE_EMBED_PREFIX)) {
      const dec = decodeSpaceLink(a);
      if (!dec) continue;
      a = dec.a; t = dec.t;
      if (dec.n) n = dec.n;
      if (dec.g) g = dec.g;
    }
    if (seen.has(a)) continue;
    if (!FEATURED_TYPES.includes(t)) continue;
    // A user ref must be a 64-char hex pubkey — the client's profile route decodes it, so a
    // malformed one would publish a dead row. (The picker always sends hex.)
    if (t === 'user' && !HEX64.test(a)) continue;
    seen.add(a);
    const item = {
      a,
      t,
      l: (typeof it.l === 'string' ? it.l : '').slice(0, MAX_FEATURED_LABEL),
      n: n.slice(0, 80),
    };
    // Carry the gradient only when present (a channel/group snapshot from the picker or a share link),
    // so an entry without one stays byte-identical to the pre-gradient wire.
    if (g) item.g = g.slice(0, MAX_FEATURED_GRADIENT);
    items.push(item);
    if (items.length >= MAX_FEATURED) break;
  }
  return {v: 1, items};
}
function loadFeatured() {
  try { return existsSync(FEATURED_PATH) ? JSON.parse(readFileSync(FEATURED_PATH, 'utf8')) : {v: 1, items: []}; }
  catch { return {v: 1, items: []}; }
}
function saveFeatured(f) { writeJsonAtomic(FEATURED_PATH, f); }

// ── Log page — the hearth (kind-30078 stiq:log-page) ────────────────────────────
// ONE doc carries everything the organizer controls on the app's Log tab: the owner's note (with
// the version that keys members' tuck-away dismissals), the standing rules, the picked channels
// (with per-pick blurbs), the people rail (with roles), and every piece of hearth copy. The
// moderation log itself is NOT here — it is the append-only record, never organizer-editable.
// The stored file IS the compact wire (published verbatim); caps mirror the client parser in
// client/src/moderation/organizerConfig.ts currentLogPage() — keep the two in lockstep.
//
// The pure wire sanitizer (caps + note/welcome version discipline) lives in ./log-page.mjs so
// issuer/log_page_test.mjs can exercise it without booting the dashboard — the POST handler calls
// sanitizeLogPage(body, prev, {decodeSpaceLink}). Only the file I/O (load seed / save) stays here.

/**
 * Load the saved log-page doc. When none exists yet, SEED it from the legacy guide + featured
 * docs (guide → standing rules; featured channels/groups → picks with the label as the blurb;
 * featured users → people with the label as the role) — the same fallback the client applies —
 * so the panel opens pre-filled and one publish promotes the legacy config into the new page.
 */
function loadLogPage() {
  try {
    if (existsSync(LOG_PAGE_PATH)) return JSON.parse(readFileSync(LOG_PAGE_PATH, 'utf8'));
  } catch { /* fall through to the seed */ }
  const guide = loadGuide();
  const featured = loadFeatured();
  const doc = {v: 1, picks: [], people: [], copy: {}, sp: true, au: true, seeded: true};
  if (guide.content) doc.rules = {b: guide.content};
  for (const it of featured.items || []) {
    if (it.t === 'user') {
      const person = {p: it.a};
      if (it.l) person.r = it.l;
      if (it.n) person.n = it.n;
      doc.people.push(person);
    } else if (it.t === 'channel' || it.t === 'group') {
      const pick = {a: it.a, t: it.t};
      if (it.l) pick.bl = it.l;
      if (it.n) pick.n = it.n;
      if (it.g) pick.g = it.g;
      doc.picks.push(pick);
    }
  }
  return doc;
}
function saveLogPage(doc) { writeJsonAtomic(LOG_PAGE_PATH, doc); }

// ── Posting guidelines (kind-30078 stiq:posting-guidelines) ─────────────────────
// The organizer's "rules at the point of posting" doc: a short blurb shown in the composer's rules
// banner, plus the full, versioned covenant (sections + a "what changed" diff of the last revision).
// The stored file IS the compact wire (published verbatim) — v/ver/at/b/sec/df match the client
// parser exactly (client/src/feed/postingGuidelines.ts), keep the two in lockstep. `ver`/`at` are
// SERVER-managed (never trust the client's copy): `ver` bumps ONLY when the sanitized CONTENT
// (b + sections + the diff's rows) actually changes vs. what's already saved — the same
// don't-re-open-everyone's-dismissal-for-an-unrelated-edit discipline as the log-page note version.
const MAX_GL_BLURB_ITEMS = 4;
const MAX_GL_BLURB_CHARS = 200;
const MAX_GL_SECTIONS = 8;
const MAX_GL_SECTION_HEADING_CHARS = 80;
const MAX_GL_SECTION_ITEMS = 10;
const MAX_GL_SECTION_ITEM_CHARS = 300;
const MAX_GL_DIFF_ROWS = 6;
const MAX_GL_DIFF_ROW_CHARS = 220;

function glCleanLine(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function glSplitLines(raw) {
  return typeof raw === 'string' ? raw.split(/\r?\n/) : [];
}

function sanitizeGuidelinesBlurb(raw) {
  return glSplitLines(raw)
    .map(l => glCleanLine(l, MAX_GL_BLURB_CHARS))
    .filter(l => l !== '')
    .slice(0, MAX_GL_BLURB_ITEMS);
}

function sanitizeGuidelinesSections(raw) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object') continue;
    const h = glCleanLine(s.h, MAX_GL_SECTION_HEADING_CHARS);
    const it = glSplitLines(s.it)
      .map(l => glCleanLine(l, MAX_GL_SECTION_ITEM_CHARS))
      .filter(l => l !== '')
      .slice(0, MAX_GL_SECTION_ITEMS);
    // Mirrors the client parser: a heading with no items (or an item list with no heading) is not a
    // valid section, so it is dropped here rather than published malformed.
    if (h && it.length > 0) out.push({h, it});
    if (out.length >= MAX_GL_SECTIONS) break;
  }
  return out;
}

// Parses free-form "~ text" / "+ text" lines into wire rows `[sign, text]`; any other line (blank,
// unprefixed, unknown sign) is silently dropped, per the UI's help text.
function sanitizeGuidelinesDiffRows(raw) {
  const rows = [];
  for (const rawLine of glSplitLines(raw)) {
    const line = typeof rawLine === 'string' ? rawLine.trim() : '';
    if (!line) continue;
    const sign = line[0] === '~' || line[0] === '+' ? line[0] : null;
    if (!sign) continue;
    const text = glCleanLine(line.slice(1), MAX_GL_DIFF_ROW_CHARS);
    if (!text) continue;
    rows.push([sign, text]);
    if (rows.length >= MAX_GL_DIFF_ROWS) break;
  }
  return rows;
}

/**
 * Sanitize a dashboard POST into the wire doc. `prev` is the previously saved doc, or null when
 * nothing has ever been published. Only the CONTENT fields (b/sec/df) are read from `body` — `ver`
 * and `at` are always computed here. If the sanitized content is identical to what's already saved,
 * the republish is idempotent (ver/at carry over unchanged, including the diff's own `f`). Otherwise
 * ver = prev.ver + 1 (or 1 when nothing was ever saved) and at = now. An empty doc (no blurb lines,
 * no sections) is valid — the client parses it to `null` and hides the banner + covenant entirely.
 */
function sanitizePostingGuidelines(body, prev) {
  const now = Math.floor(Date.now() / 1000);
  const b = sanitizeGuidelinesBlurb(body?.b);
  const sec = sanitizeGuidelinesSections(body?.sec);
  const dfRows = sanitizeGuidelinesDiffRows(body?.df);

  const prevB = Array.isArray(prev?.b) ? prev.b : [];
  const prevSec = Array.isArray(prev?.sec) ? prev.sec : [];
  const prevDfRows = Array.isArray(prev?.df?.rows) ? prev.df.rows : [];

  const unchanged = !!prev
    && JSON.stringify(b) === JSON.stringify(prevB)
    && JSON.stringify(sec) === JSON.stringify(prevSec)
    && JSON.stringify(dfRows) === JSON.stringify(prevDfRows);

  let ver, at, df;
  if (unchanged) {
    ver = Number.isFinite(prev.ver) && prev.ver >= 1 ? prev.ver : 1;
    at = Number.isFinite(prev.at) && prev.at >= 1 ? prev.at : now;
    df = dfRows.length > 0 ? prev.df : null; // carried over verbatim, including its own `f`
  } else {
    const prevVer = prev && Number.isFinite(prev.ver) ? prev.ver : 0;
    ver = prevVer + 1;
    at = now;
    df = dfRows.length > 0 ? {f: prevVer, rows: dfRows} : null;
  }

  const doc = {v: 1, ver, at, b, sec};
  if (df) doc.df = df;
  return doc;
}

const DEFAULT_POSTING_GUIDELINES_DOC = {v: 1, ver: 0, at: 0, b: [], sec: []};
function loadPostingGuidelines() {
  try { return existsSync(POSTING_GUIDELINES_PATH) ? JSON.parse(readFileSync(POSTING_GUIDELINES_PATH, 'utf8')) : {...DEFAULT_POSTING_GUIDELINES_DOC}; }
  catch { return {...DEFAULT_POSTING_GUIDELINES_DOC}; }
}
function savePostingGuidelines(doc) { writeJsonAtomic(POSTING_GUIDELINES_PATH, doc); }

// ── Rising ranking (kind-30078 stiq:ranking) — tunes the feed's Rising sort ──────
// This file stores the COMPACT WIRE shape directly (the route publishes it verbatim), so these keys
// are the cross-layer contract with the client's parseRanking in client/src/feed/sort.ts — keep the
// two in lockstep. Four engagement signals, each with a weight and (where it has a clock of its
// own) a half-life, plus two editorial multipliers:
//   tw  freshness weight        thl freshness half-life (hours) — the post's OWN clock
//   vw  vote weight             hl  vote half-life (hours)
//   cw  comment weight          chl comment half-life (hours)
//   sw  all-time score weight
//   lw  prose-length weight     ty  per-type multipliers {n: note, a: article}; 1 = neutral
// tw/vw ship LIVE; cw/lw/ty ship dark (0/0/1) — an untuned community sees nothing from them.
const DEFAULT_RANKING_CFG = {
  hl: 3.85, sw: 0.1, tw: 1, thl: 6, vw: 1, cw: 0, chl: 6, lw: 0, ty: {n: 1, a: 1},
};
// Tolerant of numbers OR numeric strings (the UI posts raw <input type="text"> values), like
// sanitizeStorage. Every field falls back to ITS OWN default, so a partial or garbage POST can never
// drag the other fields off their current meaning.
function rankNum(v, dflt, min) {
  const n = typeof v === 'number' ? v : (/^-?\d*\.?\d+$/.test(String(v).trim()) ? parseFloat(v) : NaN);
  return Number.isFinite(n) && n >= min ? n : dflt;
}
function sanitizeRanking(body) {
  const ty = (body && typeof body.ty === 'object' && body.ty) || {};
  // MIN_VALUE (not 0) for every half-life: λ = ln2/hl, so a 0 would publish an infinite decay.
  return {
    hl: rankNum(body?.hl, DEFAULT_RANKING_CFG.hl, Number.MIN_VALUE),
    sw: rankNum(body?.sw, DEFAULT_RANKING_CFG.sw, 0),
    tw: rankNum(body?.tw, DEFAULT_RANKING_CFG.tw, 0),
    thl: rankNum(body?.thl, DEFAULT_RANKING_CFG.thl, Number.MIN_VALUE),
    vw: rankNum(body?.vw, DEFAULT_RANKING_CFG.vw, 0),
    cw: rankNum(body?.cw, DEFAULT_RANKING_CFG.cw, 0),
    chl: rankNum(body?.chl, DEFAULT_RANKING_CFG.chl, Number.MIN_VALUE),
    lw: rankNum(body?.lw, DEFAULT_RANKING_CFG.lw, 0),
    ty: {n: rankNum(ty.n, DEFAULT_RANKING_CFG.ty.n, 0), a: rankNum(ty.a, DEFAULT_RANKING_CFG.ty.a, 0)},
  };
}
// Sanitize on READ too: a ranking.json written before the new fields existed holds only {hl, sw},
// and the dashboard must show the real effective values (defaults filled in) rather than blanks.
function loadRanking() {
  try { return existsSync(RANKING_PATH) ? sanitizeRanking(JSON.parse(readFileSync(RANKING_PATH, 'utf8'))) : {...DEFAULT_RANKING_CFG}; }
  catch { return {...DEFAULT_RANKING_CFG}; }
}
function saveRankingCfg(r) { writeJsonAtomic(RANKING_PATH, r); }

// ── Retention / storage policy (kind-30078 stiq:storage) — org-tunable SQLite compaction caps ──
// Sizes the client's per-community SQLite retention prune (T16). Compact wire {rc,tc,ma,cr} —
// rc=reactionCap, tc=timelineCap, ma=maxAgeDays, cr=collapseReplaceable — EXACTLY the shape the
// client parses in client/src/moderation/organizerConfig.ts currentStoragePolicy (T16-S2); this is
// the cross-layer contract, keep the keys in lockstep. Ship-dark: with no storage.json published the
// client keeps its built-in caps and nothing changes — the client only re-sizes retention from a
// policy the organizer explicitly signs. Defaults match the client's REACTION_RETENTION/
// TIMELINE_RETENTION so relay/organizer/client agree before the first publish.
const DEFAULT_STORAGE = {reactionCap: 8000, timelineCap: 3000, maxAgeDays: 0, collapseReplaceable: true};
function sanitizeStorage(p) {
  // Integer clamps to safe low-storage-phone bounds; tolerant of numbers OR numeric strings (the UI
  // posts <input> values). Out-of-range/garbage falls back to the default so a published event can
  // never set a pathological cap (e.g. 0 rows = an always-empty feed, or a multi-million-row cap).
  const toInt = v => (Number.isFinite(v) ? Math.floor(v) : (/^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN));
  const clamp = (v, min, max, d) => { const n = toInt(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const age = toInt(p?.maxAgeDays);
  return {
    reactionCap: clamp(p?.reactionCap, 200, 100000, DEFAULT_STORAGE.reactionCap),
    timelineCap: clamp(p?.timelineCap, 200, 100000, DEFAULT_STORAGE.timelineCap),
    maxAgeDays: Number.isFinite(age) && age >= 0 ? age : DEFAULT_STORAGE.maxAgeDays,
    collapseReplaceable: p?.collapseReplaceable !== false, // default true
  };
}
function loadStorage() {
  try { return existsSync(STORAGE_PATH) ? sanitizeStorage(JSON.parse(readFileSync(STORAGE_PATH, 'utf8'))) : {...DEFAULT_STORAGE}; }
  catch { return {...DEFAULT_STORAGE}; }
}
function saveStorage(s) { writeJsonAtomic(STORAGE_PATH, s); }

// ── Seeded pluggable-transport bridges (T14) ─────────────────────────────────────
// The organizer pastes their PRIVATE per-deployment bridge lines here (obfs4 / webtunnel). They ride
// the join code's `br` array so a brand-new member can bootstrap Tor through a censored network before
// any relay contact. Ship-dark: with no bridges.json (or an empty one) the join code carries no `br`
// field and is byte-identical to today — old clients ignore `br` regardless. Only the two per-hop
// transports the client bootstraps are accepted (snowflake is a broker-side transport, and a bare
// vanilla `ip:port fingerprint` line leaks the relay directly, so both are rejected); input is trimmed,
// de-duped, and capped so the `br` array can never blow the 4096-char join-code budget.
const DEFAULT_BRIDGES = {lines: []};
const BRIDGES_MAX = 12;
const BRIDGE_LINE_RE = /^(obfs4|webtunnel)\s\S/; // transport keyword + whitespace + at least one arg char
function sanitizeBridges(input) {
  const raw = Array.isArray(input) ? input : (Array.isArray(input?.lines) ? input.lines : []);
  const seen = new Set();
  const lines = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const line = item.trim();
    if (!BRIDGE_LINE_RE.test(line)) continue; // only obfs4 / webtunnel transport lines
    if (seen.has(line)) continue;             // dedupe exact duplicates
    seen.add(line);
    lines.push(line);
    if (lines.length >= BRIDGES_MAX) break;   // cap so `br` stays within the join-code budget
  }
  return {lines};
}
function loadBridges() {
  try { return existsSync(BRIDGES_PATH) ? sanitizeBridges(JSON.parse(readFileSync(BRIDGES_PATH, 'utf8'))) : {...DEFAULT_BRIDGES}; }
  catch { return {...DEFAULT_BRIDGES}; }
}
function saveBridges(obj) { writeJsonAtomic(BRIDGES_PATH, sanitizeBridges(obj)); }

// ── Blind sign ────────────────────────────────────────────────────────────────

/**
 * Core: validate + spend an invite, then blind-sign the blinded token bytes. Shared by the
 * manual HTTP path AND the automated Tor mailbox. Returns raw blind-signature bytes.
 */
async function signToken(inviteCode, blindedBytes) {
  return issueInviteCredential({
    inviteCode,
    blindedBytes,
    loadInvites,
    saveInvites,
    signBlinded: blinded => suite.blindSign(privateKey, blinded),
    // Random/nonexistent codes stay drop-eligible, preserving the mailbox's anti-amplification
    // behavior. A retry of the exact valid request instead replays its persisted blind signature.
    dropInvalid: mailboxPolicy.dropInvalid,
  });
}

async function blindSign(requestCode) {
  const prefix = 'stiq:cred-req:1;';
  if (!requestCode.startsWith(prefix)) throw new Error('Not a valid stiq request code');
  const body = requestCode.slice(prefix.length);
  const semi = body.indexOf(';');
  if (semi === -1) throw new Error('Missing invite code in request — update the app');
  const inviteCode = body.slice(0, semi);
  const blindedB64 = body.slice(semi + 1);

  const blindSig    = await signToken(inviteCode, Buffer.from(blindedB64, 'base64'));
  const sigB64      = Buffer.from(blindSig).toString('base64');
  const responseCode = 'stiq:cred-resp:1;' + sigB64;
  const responseUrl  = 'stiq://cred-resp?data=' + encodeURIComponent(sigB64);
  return {responseCode, responseUrl};
}

// ── Epoch token draw (blind posting, PLAN.md §3.6) ──────────────────────────────
// A member fills their posting-token wallet each epoch by presenting their (anonymous,
// blind-signed) enrollment credential + a batch of blinded tokens. We verify the credential,
// enforce a per-credential/per-epoch cap, and blind-sign the batch — never learning which member
// drew, and (because posting tokens are blind too) never able to link a spent token to this draw.
// Persisted so the cap survives restarts. There is NO revoke: this only PUBLISHES tokens.

const DRAWS_PATH = join(__dirname, 'draws.json');
function loadDraws() {
  try { return existsSync(DRAWS_PATH) ? JSON.parse(readFileSync(DRAWS_PATH, 'utf8')) : {}; }
  catch (e) {
    // A corrupt draws.json must NOT silently reset every per-epoch draw quota — log loudly so the
    // reset is discoverable (an attacker who can corrupt this file could otherwise re-draw unbounded).
    console.error('[organizer] WARNING: could not read ' + DRAWS_PATH + ' (' + (e?.message || e) + '); starting with EMPTY draw state — per-epoch draw quotas are reset. Inspect the file for corruption.');
    return {};
  }
}
function saveDraws(d) {
  // Atomic so a crash mid-write can't truncate the quota state; still non-fatal (the mailbox keeps
  // serving) but a persistent failure is now logged rather than swallowed.
  try { writeJsonAtomic(DRAWS_PATH, d); }
  catch (e) { console.error('[organizer] WARNING: could not persist draw quota state to ' + DRAWS_PATH + ' (' + (e?.message || e) + '); per-epoch caps may not survive a restart.'); }
}

// Per-epoch draw state is {used:<count>, seen:[<requestHash>...]}. `seen` makes a repeated draw
// (a client retry after a lost response) idempotent: we re-sign the same blinded tokens — RSA
// blind-signing is deterministic, so the member gets identical tokens — but charge the quota once.
// Tolerate the legacy numeric shape (older draws.json where an epoch mapped straight to a count).
function epUsed(v) {
  if (typeof v === 'number') return v;
  return v && typeof v.used === 'number' ? v.used : 0;
}
function epState(v) {
  if (typeof v === 'number') return {used: v, seen: []};
  return v && typeof v.used === 'number' ? {used: v.used, seen: Array.isArray(v.seen) ? v.seen : []} : {used: 0, seen: []};
}

// Per-epoch draw state is keyed by BUCKET — the resolved signing-key fingerprint (purposeKeyFingerprint,
// defined below once the purpose keys are loaded), not the raw purpose string (T2.1/F9): {buckets:
// {<fp>: {used, seen}}}. bucketsOf() tolerates BOTH older on-disk shapes so a mid-epoch deploy of this
// fix never resets a member's accounting:
//   - the pre-T2.1 single-bucket shape: perCred[ep] === {used, seen} (every purpose pooled together)
//   - the original legacy numeric shape: perCred[ep] === <count> (epState already folds this to {used,seen})
// Both pre-date per-purpose accounting, so there is no way to know which purpose the historical count
// belonged to; it folds into POST's bucket — post is the fallback/anchor purpose everywhere else in
// this file (the signer already falls back to postKey for an absent/unrecognized purpose), and was the
// dominant historical consumer of the shared pool per the F9 writeup. The nested shape is persisted
// from the very next write, so this migration only ever runs once per (credId, epoch) record.
function bucketsOf(perEpochRecord) {
  if (perEpochRecord && typeof perEpochRecord === 'object' &&
      perEpochRecord.buckets && typeof perEpochRecord.buckets === 'object') {
    return perEpochRecord.buckets; // already-migrated shape
  }
  const legacy = epState(perEpochRecord);
  if (legacy.used === 0 && legacy.seen.length === 0) return {}; // nothing to migrate (absent/empty)
  return {[purposeKeyFingerprint.post]: legacy};
}

// The issuer PUBLIC key, imported once to verify membership credentials (RFC 9474 RSA-PSS).
const issuerVerifyKey = await crypto.subtle.importKey(
  'spki', Buffer.from(issuerPubKeyB64, 'base64'),
  {name: 'RSA-PSS', hash: 'SHA-384'}, false, ['verify'],
);
async function verifyCredential(tokenBuf, sigBuf) {
  // RFC 9474 RSABSSA-SHA384-PSS fixes the PSS salt length at the 48-byte hash length and the issuer
  // signs with exactly that, so verify with 48 ONLY. A saltLength-0 fallback would admit signatures
  // the issuer never produces, needlessly widening the accepted set beyond the spec (#79).
  try {
    return await crypto.subtle.verify({name: 'RSA-PSS', saltLength: 48}, issuerVerifyKey, sigBuf, tokenBuf);
  } catch { return false; }
}

// ── Token domain separation (findings #3 / #4 / #29) ─────────────────────────────
// A blind signer can't bind a type into the (blinded) message it never sees, so when membership
// credentials, posting tokens, and read tokens are all blind-RSA objects under ONE issuer key they
// are cryptographically interchangeable: a drawn posting token is itself a valid draw credential
// (unbounded minting, #3/#4) and a posting token / enrollment credential doubles as a read-token
// (#29). The robust fix is a DISTINCT issuer keypair per purpose. Membership credentials keep the
// existing issuer key (K_enroll = issuer_private.pem / issuer_public.b64, already in the community
// code + relay config); posting tokens are signed under K_post and read tokens under K_read, so the
// draw credential check (verifyCredential, bound to K_enroll) rejects any drawn token, and the read
// meter (bound to K_read) rejects posting tokens + credentials.
//
// Enabling is a COORDINATED cross-layer change (see the CROSS-LAYER SPEC in the security handoff):
// the RELAY must verify posting tokens ONLY against K_post, and the CLIENT must blind each purpose
// against its own key (K_post / K_read are surfaced via /api/token-keys and the join code's pk/rk).
// It is therefore OFF by default — with the flag unset the organizer signs every purpose with the
// single issuer key exactly as before, so the current single-key deployment is unaffected.
const TOKEN_DOMAIN_SEP = process.env.STIQ_TOKEN_DOMAIN_SEP === '1' || process.env.STIQ_TOKEN_DOMAIN_SEP === 'true';

// (short links, dark by default) When on, the join code OMITS the seven ~392-char purpose issuer keys
// (pk/rk/pwk/prk/awk/ark/swk) — ~86% of the payload. A member instead converges to them live from the
// kind-30078 stiq:token-keys doc (publishTokenKeys → client applyOrgConfig), verified as organizer-
// authored, exactly like an existing member picking up a newly-added key. REQUIRES a fleet already
// running the stiq:token-keys adoption before flipping, so leave OFF until the client is deployed;
// older links keep their embedded keys and never break.
const SHORT_LINKS = process.env.STIQ_SHORT_LINKS === '1' || process.env.STIQ_SHORT_LINKS === 'true';

// (T14-S5, optional/dark) Also deliver the seeded bridge lines over the EXISTING kind-30078
// community-config rail (d=stiq:bridges) when the organizer opts in. This publishes the PRIVATE
// webtunnel/obfs4 lines inside a relay-stored event — acceptable (rides existing config rails, no new
// backend) but with a privacy tradeoff, so it is OFF by default; the join-code `br` path (T14-S4)
// needs no publish and is the primary delivery.
const PUBLISH_BRIDGES = process.env.STIQ_PUBLISH_BRIDGES === '1' || process.env.STIQ_PUBLISH_BRIDGES === 'true';

// (T16-S5) Encrypted community-archive export. The archive concentrates the ENTIRE community trust
// root (issuer RSA key + organizer Nostr key + community key + purpose keys + all config + relay
// double-spend state), so the route is ENV-GATED and default OFF; even when on it demands a passphrase
// and stays behind the dashboard's isAuthed + loopback/onion guards, and the output is always an
// AES-256-GCM encrypted blob (never plaintext).
const ARCHIVE_EXPORT = process.env.STIQ_ARCHIVE_EXPORT === '1' || process.env.STIQ_ARCHIVE_EXPORT === 'true';

// Key-loss guard (2026-07-21 incident follow-up): a manifest recording each purpose key's
// fingerprint the first time it was minted/loaded, checked at startup before EVER silently minting a
// replacement. Without this, a botched restore/redeploy that dropped a purpose key file looks
// EXACTLY like a fresh install to loadOrMintPurposeKey below, which happily mints a brand-new key —
// and instantly bricks every member's wallet for that purpose (every already-drawn token was blinded
// under the now-discarded old key, so real "signature representative out of range"-class draw
// failures start fleet-wide with no obvious cause). Lives alongside the key files themselves.
const KEY_MANIFEST_PATH = join(__dirname, 'key-manifest.json');
function loadKeyManifest() {
  try { if (existsSync(KEY_MANIFEST_PATH)) return JSON.parse(readFileSync(KEY_MANIFEST_PATH, 'utf8')); }
  catch { /* corrupt/missing — treated as empty; a first-ever mint below still records fresh entries */ }
  return {};
}
function saveKeyManifest(m) { writeJsonAtomic(KEY_MANIFEST_PATH, m); }

// Load an existing purpose keypair (PEM + public b64 sidecars) or mint + persist a fresh 2048-bit
// RSA-PSS one on first run (mirrors loadOrMintCommunityKey). Extractable so blindrsa-ts can export
// it to JWK for the raw-math blind signature.
async function loadOrMintPurposeKey(name) {
  const privPath = join(__dirname, name + '_private.pem');
  const pubPath  = join(__dirname, name + '_public.b64');
  const manifest = loadKeyManifest();
  if (existsSync(privPath) && existsSync(pubPath)) {
    const pem = readFileSync(privPath, 'utf8')
      .replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
    const priv = await crypto.subtle.importKey('pkcs8', Buffer.from(pem, 'base64'), {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['sign']);
    const pubB64 = readFileSync(pubPath, 'utf8').trim();
    const pub = await crypto.subtle.importKey('spki', Buffer.from(pubB64, 'base64'), {name: 'RSA-PSS', hash: 'SHA-384'}, false, ['verify']);
    // First-ever mint (no manifest entry yet, e.g. a key file that predates this guard) proceeds as
    // today and just backfills the manifest — it never blocks a key that's actually present on disk.
    if (!manifest[name]) {
      manifest[name] = {fingerprint: keyFingerprintOf({pubB64}), mintedAt: Date.now()};
      try { saveKeyManifest(manifest); } catch { /* best-effort; the guard re-derives this next boot */ }
    }
    return {priv, pub, pubB64};
  }
  // The key file is MISSING. If the manifest remembers minting this purpose before, this looks like a
  // botched restore, not a fresh install — refuse to silently re-mint (STIQ_ALLOW_KEY_REMINT=1 opts
  // into it explicitly, e.g. a deliberate rotation).
  if (manifest[name] && process.env.STIQ_ALLOW_KEY_REMINT !== '1') {
    console.error(
      `[organizer] FATAL: purpose key "${name}" is listed in key-manifest.json (minted ` +
      `${new Date(manifest[name].mintedAt).toISOString()}, fingerprint ${manifest[name].fingerprint}) ` +
      `but its key file is MISSING (${privPath}). This looks like a botched restore/redeploy, not a ` +
      `fresh install. Re-minting would silently generate a NEW key and instantly brick every member's ` +
      `wallet for this purpose (every token they already drew was blinded under the old key). Restore ` +
      `the original ${name}_private.pem / ${name}_public.b64 from backup. If this re-mint is truly ` +
      `intentional (a deliberate key rotation), set STIQ_ALLOW_KEY_REMINT=1 and restart — every member ` +
      `will then need to re-sync keys.`
    );
    process.exit(1);
  }
  if (manifest[name]) {
    console.warn(`[organizer] WARNING: re-minting purpose key "${name}" despite an existing manifest entry (STIQ_ALLOW_KEY_REMINT=1) — ALL members must re-sync keys (stiq:token-keys) or their existing tokens for this purpose will fail to verify.`);
  }
  const kp = await crypto.subtle.generateKey(
    {name: 'RSA-PSS', hash: 'SHA-384', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1])},
    true, ['sign', 'verify'],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const spki  = Buffer.from(await crypto.subtle.exportKey('spki', kp.publicKey));
  const pem = '-----BEGIN PRIVATE KEY-----\n' + pkcs8.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
  try { writeFileSync(privPath, pem); chmodSync(privPath, 0o600); } catch { /* best-effort persistence */ }
  const pubB64 = spki.toString('base64');
  try { writeFileSync(pubPath, pubB64 + '\n'); } catch { /* best-effort persistence */ }
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['sign']);
  manifest[name] = {fingerprint: keyFingerprintOf({pubB64}), mintedAt: Date.now()};
  try { saveKeyManifest(manifest); } catch { /* best-effort; a lost manifest write only weakens the guard, never blocks minting */ }
  return {priv, pub: kp.publicKey, pubB64};
}

// K_post signs posting tokens; K_read signs read tokens. Both default to the issuer key when domain
// separation is OFF, so the draw + unlock paths are byte-identical to today unless it is enabled.
let postKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
let readKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
// Per-media token domains (#3): each media modality has its own WRITE + READ token, drawn under its
// own key, so the organizer can budget/meter pictures and audio independently of text posts and
// (for the read side) gate viewing them. All default to the issuer key when domain separation is
// OFF, so every draw path stays byte-identical to today until an operator flips STIQ_TOKEN_DOMAIN_SEP.
let picWriteKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
let picReadKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
let audWriteKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
let audReadKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
// Space-write token domain (tokens-everywhere): meters writes into channels / groups / DMs — the
// bound-npub kinds the blind path deliberately excludes. A WRITE purpose: never in READ_PURPOSES, so
// its draws carry no reader-auth and stay anonymous/uncensorable exactly like posting-token draws.
let spaceWriteKey = {priv: privateKey, pub: issuerVerifyKey, pubB64: issuerPubKeyB64};
if (TOKEN_DOMAIN_SEP) {
  postKey = await loadOrMintPurposeKey('post_token_key');
  readKey = await loadOrMintPurposeKey('read_token_key');
  picWriteKey = await loadOrMintPurposeKey('picture_write_token_key');
  picReadKey = await loadOrMintPurposeKey('picture_read_token_key');
  audWriteKey = await loadOrMintPurposeKey('audio_write_token_key');
  audReadKey = await loadOrMintPurposeKey('audio_read_token_key');
  spaceWriteKey = await loadOrMintPurposeKey('space_write_token_key');
  console.log('[organizer] token domain separation ON — post/read + picture/audio write+read + space-write tokens use dedicated issuer keys');
}

// Purpose -> resolved key object, hoisted (was rebuilt on every drawTokensForMember call). Order
// matches PURPOSE_ORDER; keep the two in sync (ALL_PURPOSES/PURPOSE_ORDER are the single source of
// truth for "the 7 wire purposes", defined near the top of the file).
const signKeyByPurpose = {
  post: postKey,
  read: readKey,
  'picture-write': picWriteKey,
  'picture-read': picReadKey,
  'audio-write': audWriteKey,
  'audio-read': audReadKey,
  'space-write': spaceWriteKey,
};

// Resolved-signing-key identity for draw-budget bucketing (T2.1/F9 — PINNED GATE, Fable round-2 B4).
// Bucketing draw accounting by the raw purpose STRING is unsafe: the signer falls back to postKey for
// any absent/unrecognized purpose, and with TOKEN_DOMAIN_SEP off (default) all 7 purpose vars above
// alias the SAME `privateKey` (identical pubB64) — so 7 nominally-independent purpose buckets would
// really be a 7x-larger mintable supply of interchangeable, relay-valid post tokens through one shared
// key. Fingerprinting the RESOLVED key (its pubB64, 1:1 with the keypair) instead of the purpose name
// makes aliased purposes collapse onto ONE bucket automatically: no TOKEN_DOMAIN_SEP branch needed
// here at all, so this stays correct even if a future purpose is added or the flag's default changes.
function keyFingerprintOf(keyObj) {
  return createHash('sha256').update(keyObj.pubB64).digest('hex');
}
// Static after startup (purpose keys never change post-boot) — computed once, not per draw.
const purposeKeyFingerprint = Object.fromEntries(PURPOSE_ORDER.map(p => [p, keyFingerprintOf(signKeyByPurpose[p])]));

// Canonical purpose for a bucket fingerprint: the FIRST purpose in PURPOSE_ORDER that resolves to it
// (post is always first). When several purposes alias onto one fingerprint (domain-sep off) this picks
// a single deterministic owner for quota-lookup purposes, below — never "whichever purpose happened to
// draw first at runtime".
function purposeForFingerprint(fp) {
  return PURPOSE_ORDER.find(p => purposeKeyFingerprint[p] === fp) || 'post';
}
// Effective per-bucket token quota / request-count cap. Routing the lookup through purposeForFingerprint
// (rather than reading TOKENS_PER_EPOCH_OVERRIDES[purpose] directly) is what makes aliased purposes
// share ONE cap instead of each enforcing its own against the same shared counter — TOKENS_PER_EPOCH /
// mailboxPolicy / TOKENS_PER_EPOCH_OVERRIDES are all dashboard-mutable at runtime, so these re-resolve
// on every call rather than being hoisted.
function quotaForBucket(fp) {
  const override = TOKENS_PER_EPOCH_OVERRIDES[purposeForFingerprint(fp)];
  return Number.isInteger(override) && override > 0 ? override : TOKENS_PER_EPOCH;
}
function maxDrawsForBucket(fp) {
  const override = mailboxPolicy.perPurposeMaxDraws[purposeForFingerprint(fp)];
  return Number.isInteger(override) && override >= 0 ? override : mailboxPolicy.maxDrawsPerEpoch;
}

// Verify a read-token against K_read (the issuer key when domain separation is off). Salt length 48
// per RFC 9474, matching verifyCredential.
async function verifyReadToken(tokenBuf, sigBuf) {
  try {
    return await crypto.subtle.verify({name: 'RSA-PSS', saltLength: 48}, readKey.pub, sigBuf, tokenBuf);
  } catch { return false; }
}

// Content epoch key custody (lever 1 read meter). Custodies the rotating K_E that seal blind-post
// bodies and hands one to a member who SPENDS a valid blind read-token (mailbox kind 9026). The read
// token is verified against K_read (its own key when domain separation is on) so a posting token or
// membership credential can't satisfy it (#29); the read spent-set (separate from the relay's posting
// spent-set) enforces one epoch unlock per token. rotateEvery bounds a leaked K_E's blast radius.
// SHIPS DARK until the client requests unlocks + the recordPost/publish-epoch wires below are driven.
const CONTENT_ROTATE_EVERY = Math.max(1, parseInt(process.env.STIQ_CONTENT_ROTATE_EVERY || '500', 10) || 500);
const contentCustody = createContentKeyCustody({
  rotateEvery: CONTENT_ROTATE_EVERY,
  statePath: join(__dirname, 'content_epochs.json'),
  verifyToken: verifyReadToken,
  // Junk/invalid unlock requests get NO reply (no mined+signed 9027), removing the attacker-forced
  // PoW work the enroll/draw paths were already hardened against (#31). Live getter — tracks the
  // dashboard's Draw-protection toggle without a restart.
  dropInvalid: () => mailboxPolicy.dropInvalid,
});

// Clean base64 only. Rejecting junk also closes a delimiter-injection: a blinded entry containing
// a separator byte could otherwise let two DISTINCT requests hash to one idempotency key, skip the
// quota check, and mint tokens for free. (RSA-blinded tokens are ~256+ base64 chars; cap generously.)
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// One-line, grep-able diagnostic for every draw rejection (2026-07-21 incident: "signature
// representative out of range" reached an operator as an undifferentiated failure with no way to
// tell WHICH purpose/key was involved, so a fleet-wide stale-key storm looked identical to routine
// quota noise). purpose/fp may be unresolved yet when malformed/unknown-purpose requests are
// rejected before a bucket is picked — 'unknown'/'n/a' cover that rather than throwing from here.
function logDrawFail(purpose, fp, err) {
  console.error(`[draw-fail] purpose=${purpose ?? 'unknown'} fp=${fp ?? 'n/a'} err=${err}`);
}

// A single GLOBAL mutex serializing the draw critical section (#15). The read→quota-check→blind-sign
// →write in drawTokensForMember spans awaits, and the mailbox runs handlers concurrently
// (maxConcurrent), so the section must be serialized. Per-credential locking is NOT enough: loadDraws()
// reads the WHOLE draws.json and saveDraws() overwrites the WHOLE file, so two concurrent draws for
// DIFFERENT credentials each load a snapshot and both write it back — the earlier committer's
// used/seen increment is silently clobbered, and that member re-draws a fresh TOKENS_PER_EPOCH quota,
// defeating the per-epoch mint cap. One global chain makes the entire loadDraws→quota-check→
// blind-sign→saveDraws section atomic across ALL credentials: different credentials queue rather than
// race. Correctness over throughput here — the mailbox already bounds concurrency to a handful, and a
// draw is infrequent per member. The chain swallows each task's rejection so one failure can't wedge
// the queue.
let drawChain = Promise.resolve();
function withDrawLock(fn) {
  const run = drawChain.then(fn, fn); // run regardless of the prior draw's outcome
  drawChain = run.catch(() => {});    // keep the chain alive across a rejected draw
  return run;
}

async function drawTokensForMember(payload) {
  const {credToken, credSig, blinded} = payload || {};
  if (!credToken || !credSig || !Array.isArray(blinded) || blinded.length === 0) {
    logDrawFail(payload?.purpose, undefined, 'malformed draw request');
    return {error: 'malformed draw request', drop: mailboxPolicy.dropInvalid};
  }
  // Closed-set purpose validation (T2.1/F9, Fable B4): an absent purpose folds to 'post' — the signer
  // already falls back to postKey for anything falsy/unrecognized (below), so an absent field from an
  // older client must resolve to EXACTLY the bucket that fallback signs under. Anything PRESENT but not
  // one of the 7 wire purposes (Appendix A / PURPOSE_ORDER) is rejected outright, before it can resolve
  // to any signing key or draw-budget bucket at all — an invented purpose string must never mint a
  // fresh TOKENS_PER_EPOCH of interchangeable post tokens.
  const purpose = payload.purpose === undefined ? 'post' : payload.purpose;
  if (!ALL_PURPOSES.has(purpose)) {
    logDrawFail(purpose, undefined, 'unknown draw purpose');
    return {error: 'unknown draw purpose', drop: mailboxPolicy.dropInvalid};
  }
  // The bucket this purpose resolves to (PINNED GATE — see purposeKeyFingerprint above): when
  // TOKEN_DOMAIN_SEP is off every purpose maps to the SAME fingerprint, so every check below naturally
  // enforces one shared budget instead of a 7x one; when domain-sep is on each purpose gets its own.
  const fp = purposeKeyFingerprint[purpose];
  // Absolute per-request cap, sized to THIS bucket's quota — checked BEFORE the per-entry base64 scan
  // so an oversized `blinded` array can't force O(n) validation work. `cap` names the largest batch a
  // client may request right now: an up-to-date client re-draws that many instead of failing, so
  // lowering the quota (e.g. below the client's DRAW_BATCH) shrinks the draw rather than BRICKING the
  // wallet. Older clients ignore the extra field and see only the error, exactly as before.
  const requestCap = quotaForBucket(fp);
  if (blinded.length > requestCap) {
    logDrawFail(purpose, fp, `draw at most ${requestCap} tokens per request`);
    return {error: `draw at most ${requestCap} tokens per request`, cap: requestCap};
  }
  if (!blinded.every(b => typeof b === 'string' && b.length > 0 && b.length <= 8192 && BASE64_RE.test(b))) {
    logDrawFail(purpose, fp, 'malformed draw request');
    return {error: 'malformed draw request', drop: mailboxPolicy.dropInvalid};
  }
  const tokenBuf = Buffer.from(credToken, 'base64');
  if (!(await verifyCredential(tokenBuf, Buffer.from(credSig, 'base64')))) {
    // Unauthenticated request: optionally send NO reply (dropInvalid), so an outside flooder can't
    // force a mined + signed error response per request.
    logDrawFail(purpose, fp, 'invalid membership credential');
    return {error: 'invalid membership credential', drop: mailboxPolicy.dropInvalid};
  }
  // Censorable-reads gate (#4): a READ-purpose draw under read-auth enforcement must ALSO prove the
  // reader's npub (a member-signed reader-auth), and that npub must not be read-revoked. This — and
  // only this — lets the organizer stop a specific member from reading (given sealed content). The
  // WRITE path never reaches here with a read purpose, so posting stays blind + uncensorable. Off by
  // default (READ_AUTH false) → read draws stay anonymous, byte-identical to before.
  if (READ_AUTH && READ_PURPOSES.has(purpose)) {
    const readerPubkey = verifyReaderAuth(payload.readerAuth, KIND_READ_AUTH);
    if (!readerPubkey) {
      logDrawFail(purpose, fp, 'read access requires member authentication');
      return {error: 'read access requires member authentication', drop: mailboxPolicy.dropInvalid};
    }
    // Epoch-bind the reader-auth (freshness): the client stamps ['epoch', <day>] when it signs, so a
    // captured reader-auth can't be replayed indefinitely to pass this gate as someone else. Checked
    // against OUR clock with ±1 day tolerance — the signer's clock and ours straddle day boundaries
    // (the draw may also sit in the mailbox across one), and strict equality would spuriously refuse
    // an honest member at midnight. verifyReaderAuth already proved the signature covers the tag.
    const authEpochTag = Array.isArray(payload.readerAuth?.tags)
      ? payload.readerAuth.tags.find(t => Array.isArray(t) && t[0] === 'epoch')
      : null;
    const authEpoch = authEpochTag ? Number(authEpochTag[1]) : NaN;
    const nowEpoch = Math.floor(Date.now() / 1000 / 86400);
    if (!Number.isInteger(authEpoch) || Math.abs(authEpoch - nowEpoch) > 1) {
      logDrawFail(purpose, fp, 'read access requires member authentication');
      return {error: 'read access requires member authentication', drop: mailboxPolicy.dropInvalid};
    }
    if (isReadRevoked(readerPubkey)) {
      logDrawFail(purpose, fp, 'read access revoked by the organizer');
      return {error: 'read access revoked by the organizer'};
    }
  }
  // Per-credential, per-epoch cap — the core anti-spam knob. The epoch is derived from OUR clock,
  // NEVER the client's: a request that named its own epoch could otherwise mint the quota per made-up
  // value (epoch=1,2,3,…) from a single credential and defeat the cap entirely. Day-number, matching
  // the client's currentEpoch(); the blind tokens themselves are epoch-agnostic so the client keying
  // its wallet by its own epoch is unaffected.
  const epoch = Math.floor(Date.now() / 1000 / 86400);
  const credId = createHash('sha256').update(tokenBuf).digest('hex');
  const ep = String(epoch);
  // Fingerprint the exact request via an UNAMBIGUOUS encoding (JSON, not a delimiter join). A client
  // retry after a lost response resends the SAME blinded set, so if we've already answered it we must
  // NOT charge the quota again — else a few dropped Tor round-trips would drain a member's allowance.
  // Scoped per-bucket below (buckets[fp].seen), so an identical reqHash landing in two DIFFERENT
  // buckets (different purpose resolving to a different key) can never cross-dedupe one against the
  // other.
  const reqHash = createHash('sha256').update(JSON.stringify(blinded)).digest('hex');
  // Posting tokens sign under K_post, read tokens under K_read, etc. (all = the issuer key when domain
  // separation is off) so a drawn token can never pass verifyCredential and be replayed as a draw
  // credential (#3/#4) or satisfy the read meter with the wrong purpose (#29). `purpose` was already
  // validated against ALL_PURPOSES above, so this lookup always hits.
  const signKey = signKeyByPurpose[purpose].priv;
  // Serialize the read-modify-write globally (#15): the whole load→quota-check→sign→persist section
  // runs inside the mutex so concurrent draws — same OR different credential, same OR different
  // purpose/bucket — see each other's committed `used` instead of racing on a stale whole-file
  // snapshot. A per-bucket (or per-credential) lock is NOT enough, for the same reason called out at
  // withDrawLock's definition: loadDraws()/saveDraws() round-trip the WHOLE file regardless of how many
  // buckets/credentials it holds, so ANY two concurrent draws anywhere in it must serialize, not just
  // two that happen to share a bucket.
  return withDrawLock(async () => {
    const draws = loadDraws();
    const perCred = draws[credId] || {};
    const buckets = bucketsOf(perCred[ep]); // migrates a pre-T2.1 single-bucket/legacy-numeric record
    const state = epState(buckets[fp]);
    const already = state.seen.includes(reqHash);
    // Per-credential request-count cap (distinct requests, not tokens), now per-bucket: bounds how many
    // separate signing batches + draws.json rewrites one credential can force per epoch FOR THIS
    // PURPOSE'S BUCKET, on top of its own token quota. A retry of an already-seen request (`already`) is
    // idempotent and never counts. cap:0 tells a cap-aware client to STOP (resolves to an empty draw,
    // not a surfaced error) instead of re-drawing and issuing yet another request. 0 = unlimited.
    const maxDraws = maxDrawsForBucket(fp);
    if (!already && maxDraws > 0 && state.seen.length >= maxDraws) {
      logDrawFail(purpose, fp, `draw request limit reached this epoch (${maxDraws}/epoch)`);
      return {error: `draw request limit reached this epoch (${maxDraws}/epoch)`, cap: 0};
    }
    const quota = quotaForBucket(fp);
    if (!already && state.used + blinded.length > quota) {
      // Report how many tokens this credential may STILL draw this epoch IN THIS BUCKET (0 once that
      // bucket's quota is spent) — other purposes' buckets are untouched and unaffected (the F9 fix: a
      // heavy post/feed day no longer bricks the next space-write/channel draw, and vice versa).
      logDrawFail(purpose, fp, `epoch token limit reached (${quota}/epoch)`);
      return {
        error: `epoch token limit reached (${quota}/epoch)`,
        cap: Math.max(0, quota - state.used),
      };
    }
    // Deterministic: re-signing an already-answered request yields the identical signatures.
    const sigs = [];
    try {
      for (const b of blinded) {
        const sig = await suite.blindSign(signKey, Buffer.from(b, 'base64'));
        sigs.push(Buffer.from(sig).toString('base64'));
      }
    } catch (e) {
      const msg = e?.message || String(e);
      // "signature representative out of range" (RSA blind-sign's own range check) — and any similar
      // RSA verify/range error the blind-sign library throws — fires when the blinded input the
      // client sent was blinded under a DIFFERENT public key than the one `signKey` resolves to for
      // this purpose: the client is holding a stale/wrong purpose key (e.g. it never picked up a key
      // rotation via stiq:token-keys). That is client-recoverable (re-fetch the keys and rebuild),
      // unlike a generic signing failure, so classify it distinctly for the wire reply — see
      // CLIENT_C5_FINGERPRINT_CONTRACT.md "Draw error code contract".
      const staleKey = /representative out of range|invalid signature representative/i.test(msg);
      logDrawFail(purpose, fp, msg);
      return staleKey
        ? {error: msg, code: 'stale-blind-key', purpose, expectedFingerprint: fp}
        : {error: msg};
    }
    if (!already) {
      state.used += blinded.length;
      state.seen.push(reqHash);
      buckets[fp] = state;
      perCred[ep] = {buckets}; // always persisted in the new nested shape going forward
      // Prune stale epochs (day-numbers) so draws.json stays bounded over months of uptime.
      for (const k of Object.keys(perCred)) { if (Number(k) < epoch - 1) delete perCred[k]; }
      draws[credId] = perCred;
      saveDraws(draws);
    }
    return {sigs};
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  // no-store on EVERY /api/* response (every other response path — serveFile, HTML, QR, archive —
  // already sets it). Without it a browser/intermediary may cache a mint response (POST /api/join,
  // /api/invite) and re-serve it for a byte-identical request, so repeated "Generate" with an
  // unchanged expiry hands back the SAME code — it only looked fresh when the expiry (request body)
  // changed the cache key.
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

// Return a generic client-facing error while logging the real one server-side, so raw exception
// text (fs paths, JSON parse offsets, library internals) never reaches the caller (#61).
function fail(res, e, status = 400, msg = 'request failed') {
  console.error('[organizer] ' + (e?.stack || e?.message || e));
  return json(res, {error: msg}, status);
}

// Security headers for the key-holding admin dashboard (#60/#62): a strict CSP (default/connect/
// img 'self') contains any injected script — it can't beacon the community key/code to an external
// host — while frame-ancestors 'none' + X-Frame-Options block clickjacking and nosniff stops MIME
// confusion. 'unsafe-inline' remains for now because the UI still uses inline event handlers;
// migrating those (organizer.html) to addEventListener is the follow-up that lets it be dropped.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

// Cap the buffered body so an unauthenticated caller (POST /api/login is parsed before auth) can't
// stream unbounded bytes into memory and exhaust the single-threaded organizer (#27). Content-Length
// is checked first for a fast reject; the running total is enforced too (a lying/absent header, or
// chunked transfer). On overflow the socket is destroyed.
const DEFAULT_MAX_BODY = 1024 * 1024; // 1 MB — covers config/sign/moderator bodies + typical draws
function readBody(req, limit = DEFAULT_MAX_BODY) {
  return new Promise((ok, fail) => {
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > limit) { req.destroy(); return fail(new Error('request body too large')); }
    let d = '';
    let len = 0;
    req.on('data', c => {
      len += c.length;
      if (len > limit) { req.destroy(); return fail(new Error('request body too large')); }
      d += c;
    });
    req.on('end', () => ok(d));
    req.on('error', fail);
  });
}

// Upper bound on a finite use count — beyond this, an organizer wants the explicit "unlimited" option,
// not a giant number. A finite maxUses is floored to a positive integer and clamped here.
const MAX_FINITE_USES = 10000;

// Pure parse of an expiry value → ISO string or null (Never). Default (omitted/garbage) is Never per
// the organizer's chosen default: a single-use link dies on its one use regardless, and the dashboard
// warns on the one genuinely open-ended combination (unlimited uses + never expires). Only a value that
// actually parses as a date is honored; anything else collapses to Never. Enforcement is fail-closed at
// the issuance funnel (invite-issuance.mjs), which treats a persisted-but-unparseable expiresAt as
// expired — so a corrupted record never means "live forever".
function parseExpiresAt(v) {
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  return null;
}

// Pure parse of a uses value → positive integer (clamped) or null (unlimited). Default (omitted/garbage)
// is 1 — single-use, the unchanged legacy behavior. Explicit null = unlimited until expiry/revoke.
function parseMaxUses(v) {
  if (v === null) return null; // explicit unlimited
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.floor(v);
    if (n >= 1) return Math.min(n, MAX_FINITE_USES);
  }
  return 1; // omitted / garbage → single-use
}

// Read an invite-mint body {expiresAt?: ISO|null, maxUses?: number|null} ONCE (a request stream can't be
// read twice) and default each field independently. Used by both /api/invite and /api/join.
async function readInviteMintOptions(req) {
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch { body = {}; }
  return {expiresAt: parseExpiresAt(body?.expiresAt), maxUses: parseMaxUses(body?.maxUses)};
}

// Asset version stamps the ?v= query on the dashboard's own JS. It's the process start time, so a
// deploy (systemd restart) auto-busts every member's cached bundle, and POST /api/bust-cache rotates
// it on demand ("clear cache"). Because every bundle URL carries this token, the bytes themselves are
// safe to cache immutably: a change → a new ?v= → a new URL → a fresh fetch, and the old entry is
// simply abandoned. Over a Tor onion this turns a ~360 KB re-download on every page load into one.
let ASSET_VERSION = String(Date.now());

// The big static files (organizer-ui.js ~105 KB, jsQR ~256 KB) never change while the process runs,
// so read each from disk once and serve the buffer thereafter — no per-request readFileSync stalling
// the event loop while the initial fan-out of ~18 API calls is also in flight. cacheControl defaults
// to no-store; versioned bundles pass an immutable policy so the browser keeps them across reloads.
const staticFileCache = new Map();
function serveFile(res, filePath, contentType, cacheControl = 'no-store') {
  try {
    let buf = staticFileCache.get(filePath);
    if (!buf) { buf = readFileSync(filePath); staticFileCache.set(filePath, buf); }
    res.writeHead(200, {'Content-Type': contentType, 'Cache-Control': cacheControl, ...SECURITY_HEADERS});
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// The dashboard shell is templated (its ?v= placeholders → ASSET_VERSION) and always served no-store,
// so a reload re-reads it and picks up the current bundle version. The substituted HTML is memoised
// per version so the replace only reruns when ASSET_VERSION actually rotates.
let htmlShell = null, htmlShellVersion = null;
function serveHtmlShell(res) {
  try {
    if (htmlShell === null || htmlShellVersion !== ASSET_VERSION) {
      const raw = readFileSync(join(__dirname, 'organizer.html'), 'utf8');
      // Replace a DISTINCT token, never the bare "__ASSET_V__" — that substring also occurs in the
      // property name `window.__ASSET_V__`, and a global replace there would corrupt it into
      // `window.<digits>` (a syntax error that leaves the global unset).
      htmlShell = raw.replace(/__ASSET_V_TOKEN__/g, ASSET_VERSION);
      htmlShellVersion = ASSET_VERSION;
    }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS});
    res.end(htmlShell);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// ── Auth (for hosted deployments) ───────────────────────────────────────────────
// When STIQ_ORG_PASSWORD is set, every request needs a valid session cookie obtained via
// POST /api/login. With no password set, the server runs in LOCAL-ONLY mode (no auth) — safe
// only on 127.0.0.1. The blind-sign RSA key and organizer Nostr key live here, so when the
// dashboard is exposed a password is mandatory. "Exposed" means either a non-loopback bind
// (STIQ_BIND != loopback) OR a Tor onion in front of the loopback bind: the installer sets
// STIQ_REQUIRE_PASSWORD=1 when it provisions the dashboard onion, since the bind stays
// loopback in that case and the non-loopback check below would not otherwise fire.
const ORG_PASSWORD = process.env.STIQ_ORG_PASSWORD || '';
const REQUIRE_PASSWORD = process.env.STIQ_REQUIRE_PASSWORD === '1' || process.env.STIQ_REQUIRE_PASSWORD === 'true';

// Sessions carry issued-at + last-seen so a leaked cookie can't live until process restart (#59):
// idle + absolute TTLs bound each token's lifetime, the map is capped so repeated logins can't grow
// it unbounded, and POST /api/logout evicts one. token -> {created, last} (ms).
const sessions = new Map();
const SESSION_IDLE_MS = 12 * 3600 * 1000;   // evict after 12h of inactivity
const SESSION_ABS_MS  = 24 * 3600 * 1000;   // hard cap regardless of activity
const MAX_SESSIONS    = 64;
function pruneSessions(now = Date.now()) {
  for (const [tok, s] of sessions) {
    if (now - s.created > SESSION_ABS_MS || now - s.last > SESSION_IDLE_MS) sessions.delete(tok);
  }
}

// Login throttle (#26/#66): the dashboard guards the issuer RSA + organizer keys behind one
// password, and over a Tor onion every request shares the loopback source, so a per-IP lockout is
// both meaningless AND lets an attacker lock out the operator. Instead we hard-cap attempts per
// fixed window (regardless of concurrency) and apply an escalating delay after consecutive failures.
// A correct password resets both, so the operator is barely slowed while a brute-force is throttled
// to the window cap.
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_PER_WINDOW = 30;
let loginWindowStart = 0, loginWindowCount = 0, loginFails = 0;
function loginWindowExceeded(now) {
  if (now - loginWindowStart > LOGIN_WINDOW_MS) { loginWindowStart = now; loginWindowCount = 0; }
  loginWindowCount += 1;
  return loginWindowCount > LOGIN_MAX_PER_WINDOW;
}
function loginFailDelayMs() { return Math.min(loginFails * loginFails * 100, 10_000); }

// Compare via fixed-length SHA-256 digests so the running time — and the code path — never depend on
// the secret's length (a bare length pre-check leaks len(STIQ_ORG_PASSWORD) via timing, #78).
function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
function sessionToken(req) {
  const m = /(?:^|;\s*)stiq_org=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function isAuthed(req) {
  if (!ORG_PASSWORD) return true; // local-only mode
  const tok = sessionToken(req);
  const s = tok && sessions.get(tok);
  if (!s) return false;
  const now = Date.now();
  if (now - s.created > SESSION_ABS_MS || now - s.last > SESSION_IDLE_MS) { sessions.delete(tok); return false; }
  s.last = now;
  return true;
}

// ── CSRF / DNS-rebinding defenses (#12/#28) ──────────────────────────────────────
// This process holds the issuer RSA key, organizer Nostr key, and community key. Two browser-borne
// threats need blocking even with SameSite=Strict:
//   • DNS rebinding — an attacker page rebinds its hostname to 127.0.0.1 so its script is "same
//     origin" with a local dashboard. Defence: local-only mode is only ever reached over loopback,
//     so reject any non-loopback Host outright, for EVERY method (a rebound GET /api/community-code
//     would exfiltrate the community key).
//   • Cross-site state change — a 'simple' cross-site POST (text/plain body, no preflight). Defence:
//     if an Origin header is present it must match Host; a cross-site request carries the attacker's
//     Origin and is rejected. Requests with no Origin (non-browser tooling, same-origin navigations)
//     are allowed. Applied to every state-changing method in BOTH modes.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function hostIsLoopback(req) {
  const name = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(name);
}

// The origin the CSRF check expects a browser to send. A TLS-terminating reverse proxy commonly
// rewrites the Host header to the backend (e.g. nginx `proxy_set_header Host localhost:7799`) while
// the browser still sends the EXTERNAL Origin (https://dash.example.org). A bare Origin===Host check
// would then 403 every dashboard POST/DELETE (#S5, breaks reverse-proxy deploys). Two operator knobs,
// in priority order, tell us the real external host:
//   1. STIQ_PUBLIC_ORIGIN — the external origin/URL the dashboard is served from (e.g.
//      https://dash.example.org). Preferred: it's explicit and can't be spoofed by a request header.
//   2. X-Forwarded-Host — the external Host the proxy saw, forwarded as `proxy_set_header
//      X-Forwarded-Host $host`. Consistent with the existing trust of X-Forwarded-Proto (the login
//      Secure-cookie decision), i.e. we already trust the fronting proxy's X-Forwarded-* headers.
// With NEITHER set we fall back to the request Host, so the direct loopback + onion-direct deployments
// (no proxy, so a cross-site attacker cannot inject X-Forwarded-* without a CORS preflight that this
// server never satisfies) keep the exact CSRF / DNS-rebinding defence they had before.
function parseHostFromOrigin(v) {
  if (!v) return null;
  const s = String(v).trim();
  // A bare `host:port` (no scheme) parses as scheme:path with an EMPTY host, so treat an empty host
  // as a parse miss and retry with an assumed scheme rather than silently dropping the config.
  try { const h = new URL(s).host.toLowerCase(); if (h) return h; } catch { /* not a full URL */ }
  try { const h = new URL('https://' + s).host.toLowerCase(); if (h) return h; } catch { /* unparseable */ }
  return null;
}
const PUBLIC_ORIGIN_HOST = parseHostFromOrigin(process.env.STIQ_PUBLIC_ORIGIN);
function expectedOriginHost(req) {
  if (PUBLIC_ORIGIN_HOST) return PUBLIC_ORIGIN_HOST;
  const xfh = req.headers['x-forwarded-host'];
  if (xfh) return String(xfh).split(',')[0].trim().toLowerCase(); // first hop = the client-facing host
  return String(req.headers.host || '').toLowerCase();
}
function originMatchesHost(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // no Origin — not a cross-site browser request
  try { return new URL(origin).host.toLowerCase() === expectedOriginHost(req); }
  catch { return false; }
}

const LOGIN_HTML = `<!doctype html><meta charset=utf-8><title>stiq organizer — sign in</title>
<style>body{background:#0b0b0b;color:#eee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{display:flex;gap:8px;flex-direction:column;width:280px}input,button{padding:10px;border-radius:8px;border:1px solid #333;background:#161616;color:#eee;font-size:15px}
button{background:#e8f54e;color:#000;font-weight:700;border:none;cursor:pointer}.err{color:#ff5c5c;font-size:13px;min-height:16px}</style>
<form onsubmit="go(event)"><h2>stiq organizer</h2><input id=p type=password placeholder="Password" autofocus>
<button>Sign in</button><div class=err id=e></div></form>
<script>async function go(ev){ev.preventDefault();var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});if(r.ok){location.href='/'}else{document.getElementById('e').textContent='Wrong password.'}}</script>`;

// ── Health (org-4 / F2 / org-1 / X6) ─────────────────────────────────────────
// The organizer sits on the SAME box as the relay but is entirely OUTSIDE every automated defense
// check — relay/deploy/tor_defense_check.sh only ever probes the relay process, so post-flip it can
// report all-green while enrollment + token draws are silently dead here (a stale/missing
// relay_onion.txt, a RELAY_WS pointed at the wrong place, an unreachable relay). The client has no
// way to self-heal its wallet state in the background, so a member just watches posts fail with
// nothing to explain why. This reports the minimum an operator or an automated check needs to tell
// "the process is up" apart from "the organizer can actually talk to the relay".
//
// checkRelayReachable does a real WS-open-then-close PROBE — not a publish (must be cheap enough to
// poll every few seconds without spamming a config event at the relay each time). It mirrors
// mailbox.mjs's own connect() transport choice (isOnionRelayUrl, imported above, decides Tor SOCKS
// vs. a direct socket — same STIQ_TOR_SOCKS default) and, like mailbox.mjs, dynamic-imports 'ws' +
// 'socks-proxy-agent' behind a try/catch so a missing/broken node_modules degrades to "unreachable"
// rather than crashing the request.
const HEALTH_RELAY_TIMEOUT_MS = 5000;
async function checkRelayReachable(relayUrl) {
  if (!relayUrl) return false;
  let WS, SocksProxyAgent;
  try {
    ({default: WS} = await import('ws'));
    ({SocksProxyAgent} = await import('socks-proxy-agent'));
  } catch {
    return false; // deps not installed — report unreachable rather than throwing
  }
  const wsOpts = isOnionRelayUrl(relayUrl)
    ? {agent: new SocksProxyAgent(process.env.STIQ_TOR_SOCKS || 'socks5h://127.0.0.1:9050')}
    : {};
  return new Promise(resolveProbe => {
    let settled = false;
    let socket;
    const timer = setTimeout(() => finish(false), HEALTH_RELAY_TIMEOUT_MS);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.terminate?.(); } catch { /* best-effort teardown, never fail the probe on it */ }
      resolveProbe(ok);
    }
    try {
      socket = new WS(relayUrl, wsOpts);
    } catch {
      return finish(false);
    }
    socket.once('open', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * GET /health body. Never throws: resolveRelayOnion() now THROWS when no onion is configured (no
 * more silent hardcoded-legacy fallback — see resolveRelayOnion above), so it's re-checked fresh
 * here (RELAY_ONION/RELAY_WS are otherwise frozen at the value resolved once at startup) and wrapped
 * so an unconfigured onion is a reported UNHEALTHY field, never a 500.
 */
async function buildHealth() {
  let relayOnionConfigured = true;
  try { resolveRelayOnion(); } catch { relayOnionConfigured = false; }
  const relayReachable = await checkRelayReachable(RELAY_WS);
  const keysLoaded = Boolean(issuerPubKeyB64) && Boolean(organizer?.npub) && Boolean(privateKey);
  return {
    ok: relayReachable && relayOnionConfigured && keysLoaded,
    relayReachable,
    relayWs: RELAY_WS,
    relayOnionConfigured,
    keysLoaded,
    checkedAt: new Date().toISOString(),
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  // DNS-rebinding guard (#12/#28): local-only mode is only ever reached over loopback, so a
  // non-loopback Host is an attack (rebound to 127.0.0.1) or a misconfig. Blocks every method.
  if (!ORG_PASSWORD && !hostIsLoopback(req)) {
    res.writeHead(403); return res.end('{"error":"bad host"}');
  }
  // Cross-site CSRF guard (#12/#28): a state-changing request with a mismatched Origin is cross-site.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originMatchesHost(req)) {
    res.writeHead(403); return res.end('{"error":"bad origin"}');
  }

  // Login (the only route reachable while unauthenticated).
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const now = Date.now();
    if (loginWindowExceeded(now)) {
      res.writeHead(429, {'Retry-After': '60'}); return res.end('{"error":"too many attempts"}');
    }
    const delay = loginFailDelayMs();
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const {password} = JSON.parse(await readBody(req, 16 * 1024));
      if (ORG_PASSWORD && constantTimeEqual(password ?? '', ORG_PASSWORD)) {
        loginFails = 0;
        pruneSessions(now);
        if (sessions.size >= MAX_SESSIONS) { // evict the oldest so the map stays bounded
          let oldest = null;
          for (const [t, s] of sessions) if (!oldest || s.created < oldest[1].created) oldest = [t, s];
          if (oldest) sessions.delete(oldest[0]);
        }
        const token = randomBytes(32).toString('hex');
        sessions.set(token, {created: now, last: now});
        // Mark Secure only when a TLS-terminating reverse proxy fronted us (X-Forwarded-Proto:https)
        // — a bare Secure would drop the cookie over the plain-http Tor onion deployment (#58).
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(200, {'Set-Cookie': `stiq_org=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_ABS_MS / 1000)}${secure}`});
        return res.end('{"ok":true}');
      }
    } catch { /* fall through to 401 */ }
    loginFails += 1;
    res.writeHead(401); return res.end('{"error":"unauthorized"}');
  }

  // Logout: evict the current session token so a leaked cookie can be revoked without a restart (#59).
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const tok = sessionToken(req);
    if (tok) sessions.delete(tok);
    res.writeHead(200, {'Set-Cookie': 'stiq_org=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    return res.end('{"ok":true}');
  }

  // Gate everything else behind a session when a password is configured.
  if (!isAuthed(req)) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS});
      return res.end(LOGIN_HTML);
    }
    res.writeHead(401); return res.end('{"error":"unauthorized"}');
  }

  // Static UI files. The shell is templated + no-store; the two bundles are versioned via ?v= so they
  // can be cached immutably — over Tor that's the difference between re-pulling ~360 KB every load and
  // pulling it once (jsQR is only fetched at all if the operator opens the camera scanner).
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveHtmlShell(res);
  }
  if (req.method === 'GET' && url.pathname === '/organizer-ui.js') {
    return serveFile(res, join(__dirname, 'organizer-ui.js'), 'text/javascript', IMMUTABLE);
  }
  if (req.method === 'GET' && url.pathname === '/jsqr.js') {
    return serveFile(res, join(__dirname, 'node_modules/jsqr/dist/jsQR.js'), 'text/javascript', IMMUTABLE);
  }
  // "Clear cache" — rotate the asset version so every device's next reload re-fetches the bundle.
  if (req.method === 'POST' && url.pathname === '/api/bust-cache') {
    ASSET_VERSION = String(Date.now());
    return json(res, {ok: true, version: ASSET_VERSION});
  }

  // Health check (org-4): reachability + config diagnostics for automated monitoring (deliberately
  // named /health, not /api/health — mirrors the relay's own loopback /health convention in
  // relay/main.go). Same isAuthed gate as every other route above — local-only deployments (no
  // STIQ_ORG_PASSWORD, the common co-located case) already skip auth entirely, exactly like the
  // relay's own /health does via its loopback-only bind; only an exposed dashboard (onion +
  // STIQ_REQUIRE_PASSWORD) needs a session to read it. 503 when unhealthy so a plain
  // `curl -f`/`curl --fail` style check fails loudly too, not just the JSON body's `ok` field.
  if (req.method === 'GET' && url.pathname === '/health') {
    const health = await buildHealth();
    return json(res, health, health.ok ? 200 : 503);
  }

  // API
  if (req.method === 'GET' && url.pathname === '/api/community-code') {
    return json(res, {communityCode, relayOnion: RELAY_ONION, issuerPubKey: issuerPubKeyB64, organizerNpub: organizer.npub});
  }

  if (req.method === 'GET' && url.pathname === '/api/organizer-key') {
    return json(res, {npub: organizer.npub, relayWs: RELAY_WS});
  }

  // Purpose-key public keys for the coordinated token-domain-separation rollout (#3/#4/#29): the
  // relay config needs the posting key to verify posts, the client needs both to blind each purpose.
  // Empty strings when domain separation is off (single issuer key still verifies everything).
  if (req.method === 'GET' && url.pathname === '/api/token-keys') {
    return json(res, {
      domainSeparation: TOKEN_DOMAIN_SEP,
      enrollPubKey: issuerPubKeyB64,
      postPubKey: TOKEN_DOMAIN_SEP ? postKey.pubB64 : '',
      readPubKey: TOKEN_DOMAIN_SEP ? readKey.pubB64 : '',
      picWritePubKey: TOKEN_DOMAIN_SEP ? picWriteKey.pubB64 : '',
      picReadPubKey: TOKEN_DOMAIN_SEP ? picReadKey.pubB64 : '',
      audWritePubKey: TOKEN_DOMAIN_SEP ? audWriteKey.pubB64 : '',
      audReadPubKey: TOKEN_DOMAIN_SEP ? audReadKey.pubB64 : '',
      spaceWritePubKey: TOKEN_DOMAIN_SEP ? spaceWriteKey.pubB64 : '',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/qr') {
    const data = url.searchParams.get('data');
    if (!data) { res.writeHead(400); return res.end('Missing data'); }
    try {
      const svg = await QRCode.toString(decodeURIComponent(data), {
        type: 'svg', errorCorrectionLevel: 'M', margin: 1,
      });
      res.writeHead(200, {'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store'});
      return res.end(svg);
    } catch (e) { res.writeHead(500); return res.end(e.message); }
  }

  if (req.method === 'POST' && url.pathname === '/api/invite') {
    const {expiresAt, maxUses} = await readInviteMintOptions(req);
    const code = makeCode();
    const inv  = loadInvites();
    // Store the entire join code (the full "key"), not just the 12-char invite code, so the
    // invites list can re-surface it later. It also captures the config in force at mint time.
    // maxUses:1 = single-use (default); null = unlimited. usesCount/uses accrue per redemption.
    inv[code]  = {createdAt: new Date().toISOString(), expiresAt, maxUses, usesCount: 0, uses: {}, joinCode: buildJoinCode(code, expiresAt)};
    saveInvites(inv);
    return json(res, {code, joinCode: inv[code].joinCode});
  }

  // Mint an invite AND the single join code that bundles relay + issuer key + organizer
  // pubkey + invite — the one code a member copies/pastes or scans.
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const {expiresAt, maxUses} = await readInviteMintOptions(req);
    const code     = makeCode();
    const joinCode = buildJoinCode(code, expiresAt);
    const inv      = loadInvites();
    // Persist the full join code alongside the invite so it survives in the invites list.
    inv[code]      = {createdAt: new Date().toISOString(), expiresAt, maxUses, usesCount: 0, uses: {}, joinCode};
    saveInvites(inv);
    return json(res, {code, joinCode, joinUrl: 'stiq://join?c=' + encodeURIComponent(joinCode)});
  }

  if (req.method === 'GET' && url.pathname === '/api/organizer') {
    return json(res, {organizerPub, communityName: COMMUNITY_NAME, organizerLabel: ORGANIZER_LABEL});
  }

  if (req.method === 'GET' && url.pathname === '/api/invites') {
    // Rebuild the join code for any invite that can still admit a member (relay onion/auth, issuer,
    // organizer, community key, or tag policy may have changed since mint — a stale code could be
    // unable to reach the auth-gated relay). A fully-exhausted invite keeps its frozen historical code
    // for the organizer's audit view. Each row is annotated with a read-only usage summary and a
    // curated projection (the per-redemption `uses` map with its blind signatures is never exposed).
    const inv = loadInvites();
    const out = {};
    const nowMs = Date.now();
    for (const [code, info] of Object.entries(inv)) {
      const s = summarizeInvite(info, nowMs);
      out[code] = {
        createdAt: info.createdAt || null,
        expiresAt: info.expiresAt ?? null,
        maxUses: s.maxUses,
        usesCount: s.usesCount,
        remaining: s.remaining,
        status: s.status,
        joinCode: s.exhausted && info.joinCode ? info.joinCode : buildJoinCode(code, info.expiresAt),
      };
    }
    return json(res, {invites: out});
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/invite/')) {
    const code = decodeURIComponent(url.pathname.slice('/api/invite/'.length));
    const inv  = loadInvites();
    delete inv[code];
    saveInvites(inv);
    return json(res, {ok: true});
  }

  // Bulk-delete every SPENT invite (expired, or fully redeemed) in one write — the housekeeping the
  // dashboard offers so invites.json (rewritten on every redemption) and the /api/invites payload
  // don't grow forever. Only spent records go: an active or partially-used code is never touched. A
  // late lost-response retry against a purged fully-used code just re-enrolls with a fresh token
  // (issueInviteCredential's evicted-slot path), never a double-mint.
  if (req.method === 'POST' && url.pathname === '/api/invites/purge') {
    const inv = loadInvites();
    const nowMs = Date.now();
    let removed = 0;
    for (const [code, info] of Object.entries(inv)) {
      const s = summarizeInvite(info, nowMs);
      if (s.expired || s.exhausted) { delete inv[code]; removed += 1; }
    }
    if (removed) saveInvites(inv);
    return json(res, {ok: true, removed});
  }

  // Adjust an invite's expiry and/or use cap. Fields are INDEPENDENT: only a field present in the body
  // is changed, so adjusting uses never wipes expiry and vice-versa. {expiresAt: null} clears to Never;
  // {maxUses: null} makes it unlimited. A present-but-unparseable value → 400 (for these controls,
  // silently "live forever" / "unlimited" is the dangerous fail direction). Works on a partially-used
  // invite; raising maxUses can even revive an exhausted one.
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/invite/')) {
    const code = decodeURIComponent(url.pathname.slice('/api/invite/'.length));
    // Read + validate the body FIRST (the only async step). No await may straddle the load-modify-save
    // of invites.json: the single-threaded mailbox redemption path also does load→mutate→save, so a
    // redemption committing inside a body-read window would be clobbered here.
    let body;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch { return json(res, {error: 'malformed body'}, 400); }
    const setExpiry = body && Object.prototype.hasOwnProperty.call(body, 'expiresAt');
    const setUses   = body && Object.prototype.hasOwnProperty.call(body, 'maxUses');
    let nextExpiry = null;
    if (setExpiry && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) {
        return json(res, {error: 'invalid expiresAt'}, 400);
      }
      nextExpiry = body.expiresAt;
    }
    let nextUses = null;
    if (setUses && body.maxUses !== null) {
      if (typeof body.maxUses !== 'number' || !Number.isFinite(body.maxUses) || Math.floor(body.maxUses) < 1) {
        return json(res, {error: 'invalid maxUses'}, 400);
      }
      nextUses = Math.min(Math.floor(body.maxUses), MAX_FINITE_USES);
    }
    const inv   = loadInvites();
    const entry = inv[code];
    if (!entry) return json(res, {error: 'invite not found'}, 404);
    normalizeEntry(entry); // upgrade any legacy record in place so the write converges to one shape
    if (setExpiry) entry.expiresAt = nextExpiry;
    if (setUses)   entry.maxUses   = nextUses; // null = unlimited
    saveInvites(inv);
    return json(res, {ok: true, ...summarizeInvite(entry)});
  }

  if (req.method === 'POST' && url.pathname === '/api/sign') {
    let requestCode;
    try { ({requestCode} = JSON.parse(await readBody(req))); }
    catch { return json(res, {error: 'invalid request'}, 400); }
    try {
      const result = await blindSign(String(requestCode ?? '').trim());
      return json(res, result);
    } catch (e) {
      // blindSign / issueInviteCredential throw user-facing domain errors (bad request code, invite
      // already used) that echo caller input, not host internals — safe to surface (#61).
      return json(res, {error: e.message || 'sign failed'}, 400);
    }
  }

  // Batch token issuance for a member's epoch wallet (manual/tooling path; the client normally
  // draws over the Tor mailbox). Blind-signs an array of blinded tokens, capped at
  // TOKENS_PER_EPOCH. There is deliberately NO revoke endpoint — blind-signed tokens can't be
  // linked to an npub, so no one can selectively kill a member's ability to post.
  if (req.method === 'POST' && url.pathname === '/api/sign-tokens') {
    try {
      // Large cap: an authenticated batch can carry up to TOKENS_PER_EPOCH blinded tokens (each ~344
      // base64 chars) — well past the default 1 MB body limit for a big quota. Length is re-checked
      // below regardless.
      const {blinded} = JSON.parse(await readBody(req, 64 * 1024 * 1024));
      if (!Array.isArray(blinded) || blinded.length === 0 || blinded.length > TOKENS_PER_EPOCH) {
        return json(res, {error: `draw between 1 and ${TOKENS_PER_EPOCH} tokens per request`}, 400);
      }
      const sigs = [];
      for (const b of blinded) {
        // Manual posting-token issuance → K_post (the issuer key when domain separation is off, #3/#4).
        const sig = await suite.blindSign(postKey.priv, Buffer.from(String(b), 'base64'));
        sigs.push(Buffer.from(sig).toString('base64'));
      }
      return json(res, {sigs});
    } catch (e) {
      return fail(res, e);
    }
  }

  // Token policy: read the current per-member per-epoch quota + this epoch's draw activity, broken
  // out per purpose bucket (T2.1/F9) as well as totaled, so the dashboard can show e.g. "space-write
  // heavy today" instead of one opaque number.
  if (req.method === 'GET' && url.pathname === '/api/token-policy') {
    const epoch = Math.floor(Date.now() / 1000 / 86400);
    const draws = loadDraws();
    let drawnThisEpoch = 0;
    let activeMembers = 0;
    const perPurposeDrawn = {};
    for (const perCred of Object.values(draws)) {
      const buckets = bucketsOf(perCred[String(epoch)]);
      let credTotal = 0;
      for (const [fp, bucketState] of Object.entries(buckets)) {
        const n = epUsed(bucketState);
        if (n <= 0) continue;
        credTotal += n;
        const p = purposeForFingerprint(fp);
        perPurposeDrawn[p] = (perPurposeDrawn[p] || 0) + n;
      }
      if (credTotal > 0) { drawnThisEpoch += credTotal; activeMembers += 1; }
    }
    return json(res, {
      tokensPerEpoch: TOKENS_PER_EPOCH,
      perPurpose: TOKENS_PER_EPOCH_OVERRIDES,
      epoch, drawnThisEpoch, activeMembers, perPurposeDrawn,
    });
  }

  // Update the quota live (persisted; no relay publish — it's an issuer-side setting). `perPurpose`
  // (T2.1/F9 item 5 — the per-media write/read knob MEDIA_TOKENS_CENSORABLE_READS_SPEC.md §4a promised)
  // is optional: omit it to leave existing overrides untouched, or pass {} to clear them back to
  // "every purpose inherits tokensPerEpoch" (today's byte-identical behavior).
  if (req.method === 'POST' && url.pathname === '/api/token-policy') {
    try {
      const body = JSON.parse(await readBody(req));
      const n = parseInt(body.tokensPerEpoch, 10);
      if (!Number.isInteger(n) || n < 1 || n > 100000) {
        return json(res, {error: 'tokens per epoch must be a positive integer (1–100000)'}, 400);
      }
      let overrides = TOKENS_PER_EPOCH_OVERRIDES;
      if (body.perPurpose !== undefined) {
        if (typeof body.perPurpose !== 'object' || body.perPurpose === null || Array.isArray(body.perPurpose)) {
          return json(res, {error: 'perPurpose must be an object of purpose -> tokens per epoch'}, 400);
        }
        const next = {};
        for (const [k, v] of Object.entries(body.perPurpose)) {
          if (!ALL_PURPOSES.has(k)) return json(res, {error: `unknown purpose "${k}"`}, 400);
          const vn = parseInt(v, 10);
          if (!Number.isInteger(vn) || vn < 1 || vn > 100000) {
            return json(res, {error: `invalid tokens-per-epoch for purpose "${k}"`}, 400);
          }
          next[k] = vn;
        }
        overrides = next;
      }
      // Persist BEFORE touching the live globals the draw path reads on every call (write-before-
      // mutate — same incident pattern as /api/activation): if the save throws, this process must
      // keep enforcing exactly what's on disk, not a quota nobody could actually save.
      try {
        saveTokenPolicy(n, overrides);
      } catch (e) {
        return json(res, {error: `couldn't save token policy: ${e?.code ? e.code + ' ' : ''}${e?.message || e}`}, 500);
      }
      TOKENS_PER_EPOCH = n;
      TOKENS_PER_EPOCH_OVERRIDES = overrides;
      return json(res, {ok: true, tokensPerEpoch: n, perPurpose: overrides});
    } catch (e) {
      return fail(res, e);
    }
  }

  // Mailbox / draw protection (issuer-side, not published). GET the current policy; POST to update
  // it live. Read by drawTokensForMember + the mailbox loop at call time, so changes apply at once.
  if (req.method === 'GET' && url.pathname === '/api/mailbox-policy') {
    return json(res, mailboxPolicy);
  }
  if (req.method === 'POST' && url.pathname === '/api/mailbox-policy') {
    try {
      const body = JSON.parse(await readBody(req));
      // Preserve any existing perPurposeMaxDraws override when the caller doesn't send one — mirrors
      // /api/token-policy's TOKENS_PER_EPOCH_OVERRIDES preserve pattern above. The dashboard's Draw
      // Protection panel only ever POSTs {maxDrawsPerEpoch, maxConcurrent, dropInvalid}; without this,
      // every save from that panel would silently reset any perPurposeMaxDraws override (set via a
      // direct API call or the config file) back to {}. Pass perPurposeMaxDraws: {} explicitly to
      // clear it — that still works, since only `undefined` triggers the preserve.
      if (body.perPurposeMaxDraws === undefined) {
        body.perPurposeMaxDraws = mailboxPolicy.perPurposeMaxDraws;
      }
      const next = sanitizeMailboxPolicy(body);
      // Write-before-mutate (see /api/token-policy above): the mailbox reads `mailboxPolicy` live on
      // every draw, so it must never move to a value that failed to persist.
      try {
        saveMailboxPolicy(next);
      } catch (e) {
        return json(res, {error: `couldn't save mailbox policy: ${e?.code ? e.code + ' ' : ''}${e?.message || e}`}, 500);
      }
      mailboxPolicy = next;
      return json(res, {ok: true, ...mailboxPolicy});
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/moderators') {
    return json(res, {moderators: loadMods()});
  }

  if (req.method === 'POST' && url.pathname === '/api/moderators') {
    try {
      const {npub} = JSON.parse(await readBody(req));
      // Validate the full bech32 npub shape (not just the prefix) so no quotes/parens/semicolons can
      // be persisted and later rendered — closes the stored-value half of the moderator XSS (#13).
      if (typeof npub !== 'string' || !/^npub1[02-9ac-hj-np-z]{58}$/.test(npub)) {
        return json(res, {error: 'Must be a valid npub1… string.'}, 400);
      }
      const mods = loadMods();
      if (!mods.includes(npub)) { mods.push(npub); saveMods(mods); }
      return json(res, {moderators: mods});
    } catch (e) { return fail(res, e); }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/moderators/')) {
    const npub = decodeURIComponent(url.pathname.slice('/api/moderators/'.length));
    const mods = loadMods().filter(n => n !== npub);
    saveMods(mods);
    return json(res, {moderators: mods});
  }

  // Sign + publish the current moderator roster as a kind-30078 stiq:moderators event.
  if (req.method === 'POST' && url.pathname === '/api/moderators/publish') {
    try {
      const event  = signRoster(loadMods());
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, event});
    } catch (e) { return fail(res, e, 500); }
  }

  // Community relay mirrors: GET the current list, POST to add one (or bulk-replace with
  // {mirrors:[...]}) — validated + de-duped by onion host + capped at MIRRORS_MAX, DELETE by host to
  // remove one. These are ADDITIVE for members: publishing can only ever add relays the app tries,
  // never remove ones a member already added or trusts (see client MirrorSet/communityStore).
  if (req.method === 'GET' && url.pathname === '/api/mirrors') {
    return json(res, {mirrors: loadMirrors()});
  }

  if (req.method === 'POST' && url.pathname === '/api/mirrors') {
    try {
      const body = JSON.parse(await readBody(req));
      if (Array.isArray(body.mirrors)) {
        // Bulk replace: validate each entry, drop invalid ones, de-dupe by onion host, cap at MIRRORS_MAX.
        const seen = new Set();
        const list = [];
        for (const raw of body.mirrors) {
          const clean = sanitizeMirror(raw);
          if (!clean) continue;
          const host = onionHostOfMirror(clean.url);
          if (seen.has(host)) continue;
          seen.add(host);
          list.push(clean);
          if (list.length >= MIRRORS_MAX) break;
        }
        saveMirrors(list);
        return json(res, {mirrors: list});
      }
      const clean = sanitizeMirror(body);
      if (!clean) {
        return json(res, {error: `url must be a ws:// or wss:// v3 onion address (56-char base32 host), e.g. ws://${'a'.repeat(56)}.onion`}, 400);
      }
      const host = onionHostOfMirror(clean.url);
      const withoutHost = loadMirrors().filter(m => onionHostOfMirror(m.url) !== host);
      if (withoutHost.length >= MIRRORS_MAX) {
        return json(res, {error: `mirror list is full (max ${MIRRORS_MAX}) — remove one first.`}, 400);
      }
      const list = [...withoutHost, clean];
      saveMirrors(list);
      return json(res, {mirrors: list});
    } catch (e) { return fail(res, e); }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/mirrors/')) {
    const raw  = decodeURIComponent(url.pathname.slice('/api/mirrors/'.length));
    const host = normalizeMirrorHost(raw);
    const list = host ? loadMirrors().filter(m => onionHostOfMirror(m.url) !== host) : loadMirrors();
    saveMirrors(list);
    return json(res, {mirrors: list});
  }

  // Sign + publish the current mirror list as a kind-30078 stiq:mirrors event.
  if (req.method === 'POST' && url.pathname === '/api/mirrors/publish') {
    try {
      const event  = signMirrors(loadMirrors());
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, event});
    } catch (e) { return fail(res, e, 500); }
  }

  // Limits: GET current policy, POST to update + sign + publish a kind-30078 stiq:limits event.
  if (req.method === 'GET' && url.pathname === '/api/limits') {
    return json(res, {limits: loadLimits()});
  }
  if (req.method === 'POST' && url.pathname === '/api/limits') {
    try {
      const limits = JSON.parse(await readBody(req));
      // Coerce the mailbox flood caps to non-negative ints (0 = unlimited); fall back to the
      // defaults if the field is absent/garbage so a published event never disables them by accident.
      const intOr = (v, d) => (Number.isInteger(v) && v >= 0 ? v : (Number.isInteger(parseInt(v, 10)) && parseInt(v, 10) >= 0 ? parseInt(v, 10) : d));
      limits.mailbox_per_min = intOr(limits.mailbox_per_min, DEFAULT_LIMITS.mailbox_per_min);
      limits.mailbox_per_conn_per_min = intOr(limits.mailbox_per_conn_per_min, DEFAULT_LIMITS.mailbox_per_conn_per_min);
      saveLimits(limits);
      const event  = signLimits(limits);
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, limits, event});
    } catch (e) { return fail(res, e); }
  }

  // Tag policy: GET current, POST to update + sign + publish a kind-30078 stiq:tag-policy event.
  // The wire content uses compact keys {ct, pin, mem} — the same shape the client and relay read.
  if (req.method === 'GET' && url.pathname === '/api/tag-policy') {
    return json(res, loadTagPolicy());
  }
  if (req.method === 'POST' && url.pathname === '/api/tag-policy') {
    try {
      const body = JSON.parse(await readBody(req));
      const communityTags = (Array.isArray(body.communityTags) ? body.communityTags : [])
        .filter(t => typeof t === 'string' && /^[a-z0-9_-]+$/i.test(t))
        .map(t => t.toLowerCase());
      // Per-tag post-type scope — only carry non-'all' entries, and only for current community tags.
      const tagScopes = {};
      if (body.tagScopes && typeof body.tagScopes === 'object') {
        for (const t of communityTags) {
          const s = postScope(body.tagScopes[t]);
          if (s !== 'all') tagScopes[t] = s;
        }
      }
      const policy = {
        communityTags,
        pinCommunityTags: body.pinCommunityTags !== false,
        allowMemberTags: body.allowMemberTags !== false,
        maxTags: Number.isFinite(body.maxTags) && body.maxTags > 0 ? Math.floor(body.maxTags) : 0,
        tagScopes,
      };
      saveTagPolicy(policy);
      // Publish kind-30078 (d=stiq:tag-policy) so the relay enforces it and clients update live.
      // `tsc` (per-tag scope) is ignored by the relay; the client uses it to scope composer chips.
      const event  = signConfig('stiq:tag-policy', [], JSON.stringify({
        ct: policy.communityTags, pin: policy.pinCommunityTags, mem: policy.allowMemberTags,
        max: policy.maxTags,
        ...(Object.keys(tagScopes).length ? {tsc: tagScopes} : {}),
      }));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, event});
    } catch (e) { return fail(res, e); }
  }

  // Community guide: GET current draft, POST to save + sign + publish. Signed as a kind-30078
  // organizer config (d="stiq:guide"), NOT a kind-30023 article: a blind community (blind_required)
  // rejects a tokenless content kind from every author — organizers included — so the guide must
  // ride the same privileged config path as the announcement banner. The client reads it via
  // organizerConfig.ts currentGuide(); keep this wire {v,title,content} in sync with that parser.
  if (req.method === 'GET' && url.pathname === '/api/guide') {
    return json(res, loadGuide());
  }
  if (req.method === 'POST' && url.pathname === '/api/guide') {
    try {
      const body = JSON.parse(await readBody(req));
      const guide = {
        title: ((typeof body.title === 'string' && body.title.trim()) || 'Community Guide').slice(0, MAX_GUIDE_TITLE),
        content: typeof body.content === 'string' ? body.content : '',
      };
      saveGuide(guide);
      const event  = signConfig('stiq:guide', [], JSON.stringify({v: 1, title: guide.title, content: guide.content}));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, guide, event});
    } catch (e) { return fail(res, e); }
  }

  // Post labels: GET current set, POST to save + sign + publish kind-30078 stiq:labels.
  if (req.method === 'GET' && url.pathname === '/api/labels') {
    return json(res, {labels: loadLabels()});
  }
  if (req.method === 'POST' && url.pathname === '/api/labels') {
    try {
      const body = JSON.parse(await readBody(req));
      const labels = sanitizeNamedColors(body.labels, 'Label', true);
      saveLabelsCfg(labels);
      const event = signConfig('stiq:labels', [], JSON.stringify({
        lbls: labels.map((l, i) => ({id: l.id, nm: l.name, c: l.color, o: i, a: l.appliesTo})),
      }));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, labels, event});
    } catch (e) { return fail(res, e); }
  }

  // Per-post-type rules: GET current, POST to save + sign + publish kind-30078 stiq:post-rules.
  if (req.method === 'GET' && url.pathname === '/api/post-rules') {
    return json(res, {postRules: loadPostRules()});
  }
  if (req.method === 'POST' && url.pathname === '/api/post-rules') {
    try {
      const rules = sanitizePostRules(JSON.parse(await readBody(req)));
      savePostRules(rules);
      const event = signConfig('stiq:post-rules', [], JSON.stringify({
        note:    {mn: rules.note.min,    mx: rules.note.max,    mm: rules.note.mediaMax,    lr: rules.note.labelRequired},
        article: {mn: rules.article.min, mx: rules.article.max, mm: rules.article.mediaMax, lr: rules.article.labelRequired},
        anmx: rules.authorNoteMax,
      }));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, postRules: rules, event});
    } catch (e) { return fail(res, e); }
  }

  // Picture limits: GET current, POST to save + sign + publish kind-30078 stiq:picture-limits.
  if (req.method === 'GET' && url.pathname === '/api/picture-rules') {
    return json(res, {pictureRules: loadPictureRules()});
  }
  if (req.method === 'POST' && url.pathname === '/api/picture-rules') {
    try {
      const rules = sanitizePictureRules(JSON.parse(await readBody(req)));
      savePictureRules(rules);
      const event = signConfig('stiq:picture-limits', [], JSON.stringify({
        al: rules.allow,
        ab: rules.allowanceBytes,
        ph: rules.periodHours,
        mbp: rules.maxBytesPerPicture,
        mr: rules.maxRes,
        mc: rules.maxColours,
      }));
      const result = await publish(event, RELAY_WS);
      // Leak-free relay backstop: align the relay's CONTENT-NEUTRAL event-size cap so a picture at
      // the new per-picture limit (+ headroom for the surrounding post text/tags) never trips the
      // generic "event too large" gate. Raise-only — never shrink an operator-set cap. The relay
      // still enforces only a size number; it never learns an event contains a picture.
      let relayNote = '';
      const cfg = readRelayConfig();
      if (cfg) {
        const needed = rules.maxBytesPerPicture + 16 * 1024;
        const current = cfg.max_event_bytes || 0;
        if (current < needed) {
          // Best-effort secondary write: a failure here must NOT swallow the fact that the picture
          // rules themselves already saved + published fine, and must NOT be silent either — a
          // dashboard operator otherwise has no way to learn the relay will keep rejecting oversized
          // pictures until this is raised by hand.
          if (!relayConfigWritable()) {
            relayNote = ` NOTE: relay max_event_bytes needs raising to ${needed} for pictures to fit, but ${relayConfigWriteErrorMessage({code: 'EACCES'})}.`;
          } else {
            try {
              cfg.max_event_bytes = needed;
              writeRelayConfig(cfg);
              relayNote = ` Relay max_event_bytes raised to ${needed} so pictures fit (restart the relay to apply).`;
            } catch (e) {
              relayNote = ` NOTE: could not raise relay max_event_bytes: ${relayConfigWriteErrorMessage(e)}`;
            }
          }
        }
      }
      return json(res, {ok: result.ok, message: (result.message || '') + relayNote, pictureRules: rules, event});
    } catch (e) { return fail(res, e); }
  }

  // Posting guidelines: GET the saved doc (ver 0 + empty b/sec when never published) so the UI can
  // pre-fill and show the status line, POST to save + sign + publish kind-30078
  // stiq:posting-guidelines. ver/at are server-managed — see sanitizePostingGuidelines.
  if (req.method === 'GET' && url.pathname === '/api/posting-guidelines') {
    return json(res, {postingGuidelines: loadPostingGuidelines()});
  }
  if (req.method === 'POST' && url.pathname === '/api/posting-guidelines') {
    try {
      const prevSaved = existsSync(POSTING_GUIDELINES_PATH) ? loadPostingGuidelines() : null;
      const doc = sanitizePostingGuidelines(JSON.parse(await readBody(req)), prevSaved);
      savePostingGuidelines(doc);
      const event = signConfig('stiq:posting-guidelines', [], JSON.stringify(doc));
      const result = await publish(event, RELAY_WS);
      const empty = doc.b.length === 0 && doc.sec.length === 0;
      const message = (result.message || 'saved')
        + (empty ? ' — published EMPTY: the banner and covenant sheet are hidden for members until you add content.' : '');
      return json(res, {ok: result.ok, message, postingGuidelines: doc, event});
    } catch (e) { return fail(res, e); }
  }

  // Audio limits: GET current, POST to save + sign + publish kind-30078 stiq:audio-limits.
  if (req.method === 'GET' && url.pathname === '/api/audio-rules') {
    return json(res, {audioRules: loadAudioRules()});
  }
  if (req.method === 'POST' && url.pathname === '/api/audio-rules') {
    try {
      const rules = sanitizeAudioRules(JSON.parse(await readBody(req)));
      saveAudioRules(rules);
      const event = signConfig('stiq:audio-limits', [], JSON.stringify({
        al: rules.allow,
        ab: rules.allowanceBytes,
        ph: rules.periodHours,
        mbc: rules.maxBytesPerClip,
        md: rules.maxDurationSec,
        br: rules.bitrateKbps,
        sr: rules.sampleRateHz,
      }));
      const result = await publish(event, RELAY_WS);
      // Same leak-free backstop as pictures: raise the relay's content-neutral event-size cap so a
      // clip at the new per-clip limit fits. maxBytesPerClip is DECODED bytes; the clip rides as
      // base64 (~4/3 larger) plus surrounding post text/tags, so size for the base64 form + headroom.
      let relayNote = '';
      const cfg = readRelayConfig();
      if (cfg) {
        const needed = Math.ceil(rules.maxBytesPerClip * 4 / 3) + 16 * 1024;
        const current = cfg.max_event_bytes || 0;
        if (current < needed) {
          // Same best-effort/non-silent treatment as picture-rules above.
          if (!relayConfigWritable()) {
            relayNote = ` NOTE: relay max_event_bytes needs raising to ${needed} for voice clips to fit, but ${relayConfigWriteErrorMessage({code: 'EACCES'})}.`;
          } else {
            try {
              cfg.max_event_bytes = needed;
              writeRelayConfig(cfg);
              relayNote = ` Relay max_event_bytes raised to ${needed} so voice clips fit (restart the relay to apply).`;
            } catch (e) {
              relayNote = ` NOTE: could not raise relay max_event_bytes: ${relayConfigWriteErrorMessage(e)}`;
            }
          }
        }
      }
      return json(res, {ok: result.ok, message: (result.message || '') + relayNote, audioRules: rules, event});
    } catch (e) { return fail(res, e); }
  }

  // Read access (censorable reads, #4): GET the enforcement flag + revoked list, POST to revoke or
  // reinstate a member's READING by npub. Purely organizer-side (never a signed/published event) — a
  // revoked member simply gets no fresh read tokens, so cannot decrypt sealed content. Posting is
  // untouched: this endpoint has no effect on the write path.
  if (req.method === 'GET' && url.pathname === '/api/read-access') {
    return json(res, {readAuth: READ_AUTH, revoked: loadReadRevoked().pubkeys});
  }
  if (req.method === 'POST' && url.pathname === '/api/read-access') {
    try {
      const body = JSON.parse(await readBody(req));
      const hex = toHexPubkey(body.npub);
      if (!hex) return fail(res, new Error('invalid npub / pubkey'));
      const cur = new Set(loadReadRevoked().pubkeys);
      if (body.revoked === false) cur.delete(hex); else cur.add(hex);
      const next = {pubkeys: [...cur]};
      saveReadRevoked(next);
      return json(res, {ok: true, readAuth: READ_AUTH, revoked: next.pubkeys});
    } catch (e) { return fail(res, e); }
  }

  // ── Token & sealing activation (tokens-everywhere) ───────────────────────────
  // The dashboard control for the fleet-coordinated feature flags that live in the RELAY config
  // (not organizer-published kind-30078 — admission-critical flags stay in relay config so a
  // malicious mirror can't roll them back). GET reports the live state + guardrails; POST flips the
  // BOOLEANS and SIGHUPs the relay to hot-reload them. The verifying KEYS load at relay startup
  // (put in place at deploy) and are NOT toggled here — so a toggle only ever flips a boolean that
  // hot-reloads, never something needing a restart. Enabling space tokens / content encryption is a
  // ONE-WAY, fleet-coordinated flip (an un-updated client breaks); the UI warns, and the guardrails
  // below refuse a flip that could never be satisfied (flag with no key, or without domain sep).
  if (url.pathname === '/api/activation') {
    const buildActivationState = () => {
      const cfg = readRelayConfig();
      const has = k => Array.isArray(cfg?.[k]) && cfg[k].length > 0;
      return {
        domainSeparation: TOKEN_DOMAIN_SEP,
        configReadable: !!cfg,
        configWritable: relayConfigWritable(),
        // Space tokens: needs the space-write verify key in the relay config to enable.
        spaceTokens: {enabled: !!cfg?.space_tokens_required, keyPresent: has('space_write_issuer_public_keys')},
        // Media token domains: soft activation; needs at least one media write key.
        mediaTokens: {
          enabled: !!cfg?.media_tokens_enabled,
          pictureKeyPresent: has('picture_write_issuer_public_keys'),
          audioKeyPresent: has('audio_write_issuer_public_keys'),
        },
        // Content encryption / censorable reads: relay advertises, organizer enforces (READ_AUTH).
        // Guardrail is domain separation (read tokens must be drawn under K_read).
        contentEncryption: {
          enabled: !!cfg?.content_encryption && !!cfg?.read_auth_required,
          organizerEnforcing: READ_AUTH,
        },
        // T5.2 mirror-awareness: this toggle writes the PRIMARY's config only. Each attached
        // mirror advertises its own config, provisioned from a bundle — after a flip the operator
        // re-exports + re-attaches so mirrors advertise the same enforcement. Client sealing keys
        // off the primary alone (sticky, per community), so a lagging mirror can't unseal anyone —
        // this count only drives the dashboard reminder.
        mirrorCount: loadMirrors().length,
        // T1.6 (fixes F8): last outcome of the stiq:token-keys fleet broadcast (publishTokenKeys,
        // defined below), so an operator can see whether it actually reached the relay instead of
        // trusting a fire-and-forget publish. `attempted:false` while domainSeparation is on just
        // means it hasn't resolved yet this run (the startup/flip broadcast is still retrying) —
        // reload in a few seconds.
        tokenKeysPublish: {...tokenKeysPublishStatus},
        // Task 3: same observability for stiq:content-epoch's own hardened publish (publishContentEpoch,
        // defined below) — an operator can see whether the fleet's current epoch actually reached the
        // relay, same shape as tokenKeysPublish above.
        contentEpochPublish: {...contentEpochPublishStatus},
      };
    };

    if (req.method === 'GET') {
      return json(res, buildActivationState());
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const cfg = readRelayConfig();
        if (!cfg) {
          return json(res, {error: `Can't read the relay config at ${RELAY_CONFIG_PATH}. Set STIQ_RELAY_CONFIG or check permissions.`}, 500);
        }
        // Verify writability FIRST, before mutating ANYTHING (in-memory or on disk) — the 2026-07-21
        // incident: config.json went root-owned, writes started EACCES-ing, but READ_AUTH had ALREADY
        // flipped in memory (below) and the UI only ever showed generic "request failed", so the
        // running organizer silently diverged from the persisted config with no operator-visible signal.
        if (!relayConfigWritable()) {
          return json(res, {error: relayConfigWriteErrorMessage({code: 'EACCES'})}, 500);
        }
        const has = k => Array.isArray(cfg[k]) && cfg[k].length > 0;
        // Validate each requested flip against its guardrail BEFORE mutating anything.
        if (body.spaceTokens === true && !has('space_write_issuer_public_keys')) {
          return json(res, {error: 'The relay has no space-write issuer key configured, so requiring space tokens would reject every channel/group/DM write. Redeploy the relay with space_write_issuer_public_keys first.'}, 400);
        }
        if (body.mediaTokens === true && !has('picture_write_issuer_public_keys') && !has('audio_write_issuer_public_keys')) {
          return json(res, {error: 'The relay has no picture/audio write issuer keys configured. Redeploy the relay with the media write keys first.'}, 400);
        }
        if (body.contentEncryption === true && !TOKEN_DOMAIN_SEP) {
          return json(res, {error: 'Content encryption requires token domain separation (STIQ_TOKEN_DOMAIN_SEP=1) so read tokens are drawn under K_read. Enable domain separation first.'}, 400);
        }
        // Build the NEXT config in a local object — never touch in-memory state (READ_AUTH) until the
        // write to disk has actually succeeded. Write-before-mutate: on a write failure the running
        // organizer must keep enforcing exactly what's on disk, never a value nobody could actually save.
        const next = {...cfg};
        if (typeof body.spaceTokens === 'boolean') next.space_tokens_required = body.spaceTokens;
        if (typeof body.mediaTokens === 'boolean') next.media_tokens_enabled = body.mediaTokens;
        if (typeof body.contentEncryption === 'boolean') {
          next.content_encryption = body.contentEncryption;
          next.read_auth_required = body.contentEncryption;
        }
        try {
          writeRelayConfig(next);
        } catch (e) {
          return json(res, {error: relayConfigWriteErrorMessage(e)}, 500);
        }
        // The write succeeded — only NOW is it safe to mutate in-memory state and run the follow-ons.
        if (typeof body.contentEncryption === 'boolean') {
          READ_AUTH = body.contentEncryption; // organizer enforcement follows the relay advertisement
        }
        const reloaded = await reloadRelay();
        // Re-broadcast the issuer keys the moment enforcement changes so every already-enrolled member
        // holds the space-write / media key the newly-enabled gate now demands — existing members never
        // got it in their join code, and without it every gated write would fail. Best-effort; the flip
        // itself already succeeded.
        publishTokenKeys().catch(e => console.error('[organizer] token-keys publish failed:', e?.message || e));
        // Re-broadcast the content-epoch doc the moment contentEncryption flips, in EITHER direction:
        // publishContentEpoch() itself re-reads READ_AUTH (just updated above), so turning it off
        // announces the deactivation doc immediately (not up to 6h later on the next republish tick),
        // and turning it back on immediately resumes announcing the real current epoch.
        if (typeof body.contentEncryption === 'boolean') {
          publishContentEpoch().catch(e => console.error('[organizer] content-epoch publish failed:', e?.message || e));
        }
        return json(res, {ok: true, reloaded, state: buildActivationState()});
      } catch (e) {
        return fail(res, e, e && e.code === 'EACCES' ? 500 : 400);
      }
    }
  }

  // Moderation reason buckets: GET current, POST to save + sign + publish kind-30078 stiq:reasons.
  if (req.method === 'GET' && url.pathname === '/api/reasons') {
    return json(res, loadReasons());
  }
  if (req.method === 'POST' && url.pathname === '/api/reasons') {
    try {
      const cfg = sanitizeReasons(JSON.parse(await readBody(req)));
      saveReasonsCfg(cfg);
      const event = signConfig('stiq:reasons', [], JSON.stringify({
        bk: cfg.buckets.map((b, i) => ({id: b.id, nm: b.name, c: b.color, o: i})),
        th: cfg.reportThreshold,
      }));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, reasons: cfg, event});
    } catch (e) { return fail(res, e); }
  }

  // Permissions: GET current per-moderator scopes, POST to save + sign + publish kind-30078
  // stiq:permissions. signPermissions converts npubs → hex; the wire shape is {def, mods:{hex:[…]}}.
  // Safe Browsing API key — a RELAY SECRET, NOT a signed Nostr event. Written straight into the
  // co-located relay's config.json (same 'stiq' user); the relay hot-reloads it within ~10s. GET
  // reports ONLY whether a key is set (never returns the key itself); POST sets or clears it.
  if (req.method === 'GET' && url.pathname === '/api/safe-browsing') {
    const cfg = readRelayConfig();
    const key = cfg && typeof cfg.safe_browsing_api_key === 'string' ? cfg.safe_browsing_api_key : '';
    const configured = key.length > 0;
    const {host: socksHost, port: socksPort} = resolveSocksHostPort();
    // Only probe when the feature is actually ON (F5): a warning that fires when Safe-Browsing is
    // off is noise nobody acts on, and a disabled feature never needs tor@stiq-client at all. null
    // (not checked) is distinct from false (checked, unreachable) so the UI never confuses "off"
    // with "on but broken".
    const socksReachable = configured ? await checkSocksReachable() : null;
    return json(res, {
      configured,
      hint: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
      relayConfig: RELAY_CONFIG_PATH,
      readable: cfg !== null,
      writable: relayConfigWritable(),
      socksAddr: `${socksHost}:${socksPort}`,
      socksReachable,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/safe-browsing') {
    try {
      const body = JSON.parse(await readBody(req));
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const cfg = readRelayConfig();
      if (!cfg) {
        return json(res, {error: `Can't read the relay config at ${RELAY_CONFIG_PATH}. Set STIQ_RELAY_CONFIG or check permissions.`}, 500);
      }
      if (!relayConfigWritable()) {
        return json(res, {error: relayConfigWriteErrorMessage({code: 'EACCES'})}, 500);
      }
      if (key) cfg.safe_browsing_api_key = key;
      else delete cfg.safe_browsing_api_key;
      try {
        writeRelayConfig(cfg);
      } catch (e) {
        return json(res, {error: relayConfigWriteErrorMessage(e)}, 500);
      }
      return json(res, {ok: true, configured: key.length > 0});
    } catch (e) {
      return fail(res, e, e && e.code === 'EACCES' ? 500 : 400);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/permissions') {
    return json(res, loadPermissions());
  }
  if (req.method === 'POST' && url.pathname === '/api/permissions') {
    try {
      const perms = sanitizePermissions(JSON.parse(await readBody(req)));
      savePermissions(perms);
      const event = signPermissions(perms.def, perms.mods);
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, permissions: perms, event});
    } catch (e) { return fail(res, e); }
  }

  // Mod limits: GET current caps, POST to save + sign + publish kind-30078 stiq:mod-limits.
  if (req.method === 'GET' && url.pathname === '/api/mod-limits') {
    return json(res, {modLimits: loadModLimits()});
  }
  if (req.method === 'POST' && url.pathname === '/api/mod-limits') {
    try {
      const limits = sanitizeModLimits(JSON.parse(await readBody(req)));
      saveModLimits(limits);
      const event = signConfig('stiq:mod-limits', [], JSON.stringify(limits));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, modLimits: limits, event});
    } catch (e) { return fail(res, e); }
  }

  // Governance: GET current, POST to save + sign + publish kind-30078 stiq:gov.
  if (req.method === 'GET' && url.pathname === '/api/gov') {
    return json(res, loadGov());
  }
  if (req.method === 'POST' && url.pathname === '/api/gov') {
    try {
      const gov = sanitizeGov(JSON.parse(await readBody(req)));
      saveGov(gov);
      const event = signConfig('stiq:gov', [], JSON.stringify(gov));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, gov, event});
    } catch (e) { return fail(res, e); }
  }

  // Community: GET current identity/settings, POST to save + sign + publish kind-30078 stiq:community.
  if (req.method === 'GET' && url.pathname === '/api/community') {
    return json(res, loadCommunity());
  }
  if (req.method === 'POST' && url.pathname === '/api/community') {
    try {
      const cfg = sanitizeCommunity(JSON.parse(await readBody(req)));
      saveCommunity(cfg);
      const event = signConfig('stiq:community', [], JSON.stringify(cfg));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, community: cfg, event});
    } catch (e) { return fail(res, e); }
  }

  // Featured spaces: GET current rail, POST to save + sign + publish kind-30078 stiq:featured.
  if (req.method === 'GET' && url.pathname === '/api/featured') {
    return json(res, loadFeatured());
  }
  if (req.method === 'POST' && url.pathname === '/api/featured') {
    try {
      const featured = sanitizeFeatured(JSON.parse(await readBody(req)));
      saveFeatured(featured);
      const event = signConfig('stiq:featured', [], JSON.stringify(featured));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, featured, event});
    } catch (e) { return fail(res, e); }
  }

  // Log page (the hearth): GET current draft (seeded from guide+featured when never saved),
  // POST to save + sign + publish kind-30078 stiq:log-page. The note VERSION is server-managed:
  // it bumps only when the note text changes (sanitizeLogPage), which is what auto-reopens a
  // member's tucked-away card — an unrelated edit never does.
  if (req.method === 'GET' && url.pathname === '/api/log-page') {
    return json(res, loadLogPage());
  }
  if (req.method === 'POST' && url.pathname === '/api/log-page') {
    try {
      const prevSaved = existsSync(LOG_PAGE_PATH) ? loadLogPage() : null;
      const doc = sanitizeLogPage(JSON.parse(await readBody(req)), prevSaved, {decodeSpaceLink});
      saveLogPage(doc);
      const event  = signConfig('stiq:log-page', [], JSON.stringify(doc));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, logPage: doc, event});
    } catch (e) { return fail(res, e); }
  }

  // Featured-space PICKER source: read the community's featureable entities off the relay so the
  // organizer clicks to add instead of hand-typing a `30311:…` coordinate or a hex pubkey.
  //   - channels: kind-30311 rides the firehose, so an unscoped REQ is allowed (latest-per-coord).
  //   - users:    pubkeys the relay CAN tie to a public identity — channel owners/admins + group
  //               owners + the moderator roster — enriched with a SCOPED (by-author, therefore
  //               allowed) kind-0 name lookup. A blind community hides authorship, so there is no
  //               "list all members".
  //   - groups:   NIP-29 metadata (39000) is anti-enumeration-gated by the relay and only answers a
  //               SCOPED request (a `#d` tag filter qualifies), so groups are no longer a manual
  //               paste: kind-9007 group-create rides the firehose UNSCOPED, so its `h` tags give us
  //               every group id in play, and THOSE ids are what scope the 39000 lookup. A deleted
  //               group has no 39000 (the relay purges it), so it drops out naturally.
  if (req.method === 'GET' && url.pathname === '/api/discover') {
    try {
      const chEvents = await fetchEvents([{kinds: [30311], limit: 300}], {relayWs: RELAY_WS, timeoutMs: 4500});
      // 30311 is addressable — keep the latest event per coordinate.
      const latestByCoord = new Map();
      for (const ev of chEvents) {
        const dTag = evTag(ev, 'd');
        if (!dTag) continue;
        const coord = `30311:${ev.pubkey}:${dTag}`;
        const prev = latestByCoord.get(coord);
        if (!prev || ev.created_at > prev.created_at) latestByCoord.set(coord, ev);
      }

      const hints = new Map(); // hex pubkey -> role hint (first writer wins: mods before owners)
      const noteUser = (hex, hint) => { if (HEX64.test(hex) && !hints.has(hex)) hints.set(hex, hint); };
      // Moderators first, so their hint wins even if they also own a channel.
      for (const npub of loadMods()) { const hex = decodeNpub(npub); if (hex) noteUser(hex, 'Moderator'); }

      const channels = [];
      for (const ev of latestByCoord.values()) {
        const dTag = evTag(ev, 'd');
        channels.push({
          ref: `30311:${ev.pubkey}:${dTag}`,
          name: evTag(ev, 'title') || 'channel',
          owner: ev.pubkey,
          open: evTag(ev, 'mode') === 'open',
          // The channel's own gradient (same tag the client's parseChannel reads) so a picked-but-
          // unsynced channel still paints its real gradient in the app's featured rail.
          gradient: evTag(ev, 'gradient'),
        });
        noteUser(ev.pubkey, 'Channel owner');
        for (const t of ev.tags) if (t[0] === 'p' && t[2] === 'admin' && t[1]) noteUser(t[1], 'Channel admin');
      }
      channels.sort((a, b) => a.name.localeCompare(b.name));

      // Groups: kind-9007 group-create rides the firehose UNSCOPED, so its `h` tags give us every
      // group id in play; kind-39000 metadata only answers a SCOPED (`#d` tag) request, so those ids
      // are what scope the lookup. Isolated in its own try/catch — a relay hiccup here must never
      // break channels/users. noteUser calls happen HERE, before `pks` is captured below, so group
      // owners get a scoped kind-0 name lookup like channel owners/admins do.
      let groups = [];
      try {
        const creates = await fetchEvents([{kinds: [9007], limit: 500}], {relayWs: RELAY_WS, timeoutMs: 4000});
        const ids = [...new Set(creates.map(ev => evTag(ev, 'h')).filter(Boolean))];
        if (ids.length) {
          const metas = await fetchEvents([{kinds: [39000], '#d': ids}], {relayWs: RELAY_WS, timeoutMs: 4500});
          // 39000 is addressable — keep the latest event per d-tag (same pattern as latestByCoord).
          const latestByD = new Map();
          for (const ev of metas) {
            const d = evTag(ev, 'd');
            if (!d) continue;
            const prev = latestByD.get(d);
            if (!prev || ev.created_at > prev.created_at) latestByD.set(d, ev);
          }
          // Owner-consent gate: a private group is listable ONLY when its owner has published a live
          // "log offer" — an OWNER-signed kind-30078 with d=space-offer:<gid>. Scope the read by those
          // exact d-tags (mirrors the 39000 call's style/timeout); keep the latest per gid so a revoke
          // tombstone supersedes an earlier offer. See issuer/log-offer.mjs for the wire contract.
          const offerEvents = await fetchEvents(
            [{kinds: [30078], '#d': ids.map(id => SPACE_OFFER_D_PREFIX + id), limit: 500}],
            {relayWs: RELAY_WS, timeoutMs: 4500},
          );
          const offersByGid = latestOffersByGid(offerEvents);

          const list = [];
          const resolvedGids = new Set();
          for (const ev of latestByD.values()) {
            const gid = evTag(ev, 'd');
            resolvedGids.add(gid);
            noteUser(evTag(ev, 'owner'), 'Group owner');
            const base = {
              ref: gid,
              name: evTag(ev, 'name') || 'group',
              gradient: evTag(ev, 'gradient') || '',
              // Flavor flags are single-element tags whose NAME is the value; 'open'/'public' are
              // the absent-flag defaults, so there is nothing to read for those.
              closed: ev.tags.some(t => t[0] === 'closed'),
              private: ev.tags.some(t => t[0] === 'private'),
              broadcast: ev.tags.some(t => t[0] === 'broadcast'),
            };
            // The owner is known (39000 resolved) ⇒ consider ONLY the owner's own latest offer (a
            // non-owner's event can never shadow it — see latestOffersByGid); a private group
            // without a verified live offer is DROPPED entirely from the results.
            const entry = resolveOfferedGroup(base, evTag(ev, 'owner'), offersByGid.get(gid)?.get(evTag(ev, 'owner')));
            if (entry) list.push(entry);
          }
          // Future hardened-relay state: a gid we know from kind-9007 whose 39000 is not resolvable but
          // which carries a live offer — build a degraded (offerVerified:false) entry from the offer's
          // own carried fields so the picker can still surface it with an "unverified owner" caveat.
          for (const [gid, signers] of offersByGid) {
            if (resolvedGids.has(gid)) continue;
            const entry = offeredGroupFromOffer(gid, newestOfferOf(signers));
            if (entry) list.push(entry);
          }
          list.sort((a, b) => a.name.localeCompare(b.name));
          groups = list;
        }
      } catch { /* best-effort — an unreachable relay just leaves groups empty */ }

      // Scoped kind-0 lookup for any names those pubkeys published (latest per author).
      const pks = [...hints.keys()];
      const names = new Map();
      if (pks.length) {
        const metas = await fetchEvents([{kinds: [0], authors: pks, limit: 500}], {relayWs: RELAY_WS, timeoutMs: 4000});
        const latestMeta = new Map();
        for (const ev of metas) {
          const prev = latestMeta.get(ev.pubkey);
          if (!prev || ev.created_at > prev.created_at) latestMeta.set(ev.pubkey, ev);
        }
        for (const [pk, ev] of latestMeta) {
          try {
            const j = JSON.parse(ev.content);
            const nm = String(j.display_name || j.name || '').trim().slice(0, 80);
            if (nm) names.set(pk, nm);
          } catch { /* ignore malformed kind-0 */ }
        }
      }
      const users = pks.map(pk => ({
        ref: pk,
        npub: encodeNpub(pk) || pk,
        name: names.get(pk) || '',
        hint: hints.get(pk) || '',
      })).sort((a, b) => (a.name || a.hint).localeCompare(b.name || b.hint));

      return json(res, {channels, users, groups});
    } catch (e) { return fail(res, e); }
  }

  // Rising ranking: GET current, POST to save + sign + publish kind-30078 stiq:ranking.
  if (req.method === 'GET' && url.pathname === '/api/ranking') {
    return json(res, {ranking: loadRanking()});
  }
  if (req.method === 'POST' && url.pathname === '/api/ranking') {
    try {
      const r = sanitizeRanking(JSON.parse(await readBody(req)));
      saveRankingCfg(r);
      const event = signConfig('stiq:ranking', [], JSON.stringify(r));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, ranking: r, event});
    } catch (e) { return fail(res, e); }
  }

  // Storage / retention: GET current, POST to save + sign + publish kind-30078 stiq:storage. A pure
  // signed Nostr doc (no relay-secret write, unlike safe-browsing) — the client sizes its SQLite
  // compaction caps from it. Compact wire {rc,tc,ma,cr} MUST match the client parser in
  // client/src/moderation/organizerConfig.ts currentStoragePolicy (T16-S2) — cross-layer contract.
  if (req.method === 'GET' && url.pathname === '/api/storage') {
    return json(res, loadStorage());
  }
  if (req.method === 'POST' && url.pathname === '/api/storage') {
    try {
      const s = sanitizeStorage(JSON.parse(await readBody(req)));
      saveStorage(s);
      const event = signConfig('stiq:storage', [], JSON.stringify({rc: s.reactionCap, tc: s.timelineCap, ma: s.maxAgeDays, cr: s.collapseReplaceable}));
      const result = await publish(event, RELAY_WS);
      return json(res, {ok: result.ok, message: result.message, storage: s, event});
    } catch (e) { return fail(res, e); }
  }

  // Seeded bridges (T14-S4): GET current lines, POST to sanitize + persist to bridges.json. No relay
  // publish is required for the join-code `br` path — the next join code the organizer generates picks
  // the lines up via loadBridges(). OPTIONALLY (T14-S5, STIQ_PUBLISH_BRIDGES), also sign + publish a
  // kind-30078 d=stiq:bridges event so already-enrolled members receive them over the org-config rail.
  // Reuses the same isAuthed + Origin/CSRF guards as every other config POST; no new service or port.
  if (req.method === 'GET' && url.pathname === '/api/bridges') {
    return json(res, loadBridges());
  }
  if (req.method === 'POST' && url.pathname === '/api/bridges') {
    try {
      const b = sanitizeBridges(JSON.parse(await readBody(req)));
      saveBridges(b);
      if (PUBLISH_BRIDGES) {
        const event = signBridges(b.lines);
        const result = await publish(event, RELAY_WS);
        return json(res, {ok: result.ok, message: result.message, bridges: b, event});
      }
      return json(res, {ok: true, message: 'saved to bridges.json (join-code delivery only)', bridges: b});
    } catch (e) { return fail(res, e); }
  }

  // Encrypted community-archive export (T16-S5): ENV-GATED (STIQ_ARCHIVE_EXPORT), default OFF ⇒ 404.
  // Behind isAuthed + the loopback/onion + Origin guards above. Requires a passphrase (X-Stiq-Archive-Pass
  // header, or ?pass= for a browser download) used to derive the AES-256-GCM key; the passphrase is never
  // logged or echoed. Streams the encrypted .stiqarch blob — the ONLY output is the encrypted container.
  if (req.method === 'GET' && url.pathname === '/api/archive/export') {
    if (!ARCHIVE_EXPORT) { res.writeHead(404); return res.end('Not found'); }
    const pass = String(req.headers['x-stiq-archive-pass'] || url.searchParams.get('pass') || '');
    if (pass.length < 12) return json(res, {error: 'a passphrase of at least 12 characters is required (X-Stiq-Archive-Pass header or ?pass=)'}, 400);
    try {
      const entries = collectArtifactPaths(__dirname, RELAY_CONFIG_PATH, process.env.STIQ_RELAY_DATA_DIR);
      const blob = await buildArchive(entries, pass);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="stiq-community-' + stamp + '.stiqarch"',
        'Cache-Control': 'no-store',
      });
      return res.end(blob);
    } catch (e) { return fail(res, e, 500, 'archive export failed'); }
  }

  res.writeHead(404); res.end('Not found');
});

// Safety: refuse to expose the dashboard without a password — the RSA issuer key and organizer
// Nostr key live in this process. "Exposed" = a non-loopback bind, OR a Tor onion in front of a
// loopback bind (STIQ_REQUIRE_PASSWORD=1, set by the installer when it provisions the dashboard
// onion). Tor client-authorization already gates who can resolve the onion; the password is the
// second, app-layer factor (defense in depth).
const isLoopback = BIND === '127.0.0.1' || BIND === '::1' || BIND === 'localhost';
if ((!isLoopback || REQUIRE_PASSWORD) && !ORG_PASSWORD) {
  const why = isLoopback ? 'the dashboard onion is enabled (STIQ_REQUIRE_PASSWORD=1)' : 'bind ' + BIND + ' is not loopback';
  console.error('Refusing to start: ' + why + ' but STIQ_ORG_PASSWORD is not set. The issuer + organizer keys live here — set a password to expose the dashboard.');
  process.exit(1);
}

// Bound slow/large requests so an unauthenticated caller can't hold sockets or dribble a body open
// forever (#27), complementing readBody's size cap.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.maxHeadersCount = 100;

server.listen(PORT, BIND, () => {
  console.log('Stiq Organizer running at http://' + BIND + ':' + PORT + (ORG_PASSWORD ? ' (password protected)' : ' (local-only, no auth)'));
});

// Start the automated credential-exchange mailbox over Tor. Best-effort: if Tor or its deps
// aren't available it logs and stays off, leaving the dashboard + manual exchange working.
let mailboxHandle = null; // captured stop handle so shutdown can flush mailbox_seen and close cleanly
startMailbox({
  dirname: __dirname,
  // Use RELAY_WS so a Tor-less host can service the mailbox via an SSH tunnel to the relay's
  // localhost port (e.g. RELAY_WS=ws://127.0.0.1:3334). Defaults to the onion (routed via Tor).
  relayUrl: RELAY_WS,
  organizerSk,
  organizerPub,
  signToken,
  drawTokens: drawTokensForMember,
  // Read-token → content epoch key redemption (lever 1 meter). Verifies + spends the token and
  // returns K_E, all blind to the npub. See contentCustody above.
  unlockEpoch: contentCustody.unlockEpoch,
  enrollPoW: ENROLL_POW,
  // Live getter so the dashboard's Draw-protection control tunes the in-flight ceiling without a
  // restart. 0 = unlimited. Shed requests are simply not answered; the client retries.
  maxConcurrent: () => mailboxPolicy.maxConcurrent,
  // Fires on EVERY successful (re)connect to the relay, including the very first one — re-broadcast
  // both fleet-sync docs (token-keys, content-epoch) here too, not just at startup and on a 6h timer
  // (below), so a member who reconnects right after a Tor hiccup gets the current keys/epoch without
  // waiting for the next timer tick. Both publishes are themselves retried + idempotent (replaceable
  // kind-30078), so an extra call here is always safe.
  onOpen: () => {
    publishTokenKeys().catch(e => console.error('[organizer] token-keys publish failed (reconnect):', e?.message || e));
    publishContentEpoch().catch(e => console.error('[organizer] content-epoch publish failed (reconnect):', e?.message || e));
  },
})
  .then(handle => { mailboxHandle = handle; })
  .catch(e => console.error('[mailbox] failed to start:', e?.message || e));

// Publish the current content epoch (kind-30078, d=stiq:content-epoch) so a writing client knows
// which epoch to seal new post bodies under (lever 1 read meter — see contentCustody above). Purely
// additive: a new signed config event that existing/generic clients simply don't read.
//
// Hardened the SAME way as publishTokenKeys below (T1.6/F8 pattern): a single fire-and-forget attempt
// is exactly the swk-class failure mode that fix already closed once for token-keys — a relay hiccup
// or Tor blip at startup would silently no-op, and every member is stuck on a stale/unknown content
// epoch (unable to unlock reads under the epoch they're actually sealed under) with no operator-
// visible signal. Retries with capped backoff via publishWithRetry and records the terminal outcome
// (contentEpochPublishStatus) the same way tokenKeysPublishStatus does, surfaced alongside it in
// buildActivationState. Also re-run periodically + on relay reconnect — see below — so a startup-time
// Tor hiccup can't leave the fleet stuck forever; kind-30078 is replaceable, so re-publishing the same
// content is always safe/idempotent.
//
// GATED on READ_AUTH (2026-07-22 incident): READ_AUTH is the organizer's in-memory mirror of the
// relay's content_encryption/read_auth_required flags (kept accurate by the write-before-mutate
// /api/activation flow above). While it is false, announcing a real epoch here is actively harmful —
// an OLD field client (pre-dating the relay-flag gate added to ensureWriteEpoch/sealRequiredNow in the
// client) has NO other signal that encryption is off and will keep provisioning + sealing under
// whatever epoch this doc names. buildContentEpochDoc (contentEpochKeys.mjs) picks the doc body —
// see its doc comment for the full compatibility analysis against client/src/blind/contentKey.ts,
// including the case this CANNOT fix (a client that already holds a provisioned epoch's key).
let contentEpochPublishStatus = {attempted: false, ok: null, attempts: 0, message: '', at: null};
publishContentEpoch().catch(e => console.error('[organizer] content-epoch publish failed:', e?.message || e));
async function publishContentEpoch() {
  const event = signConfig('stiq:content-epoch', [], JSON.stringify(
    buildContentEpochDoc(READ_AUTH, contentCustody.currentEpoch(), CONTENT_ROTATE_EVERY),
  ));
  const result = await publishWithRetry(event, RELAY_WS);
  contentEpochPublishStatus = {
    attempted: true,
    ok: result.ok,
    attempts: result.attempts,
    message: result.message,
    at: Date.now(),
  };
  if (result.ok) {
    console.log(`[organizer] content-epoch published after ${result.attempts} attempt(s): ${result.message}`);
  } else {
    console.error(`[organizer] content-epoch publish FAILED after ${result.attempts} attempt(s): ${result.message}`);
  }
  return result;
}

// Publish the community's issuer PUBLIC keys on boot so ALREADY-ENROLLED members converge to any
// purpose key added after they enrolled — notably swk/space-write — AND so a member who enrolled from
// a SHORT (key-less) join code picks up all seven live. Fire-and-forget; never blocks startup — see
// publishTokenKeys itself for the bounded retry that runs before this settles.
publishTokenKeys().catch(e => console.error('[organizer] token-keys publish failed:', e?.message || e));
// Broadcast every purpose-specific issuer PUBLIC key as a kind-30078 config doc (d=stiq:token-keys),
// applied by the client like any other org-config d-tag. WHY: an issuer key used to reach a member
// ONLY inside their join code, parsed once at enrollment. When a new purpose key is added later
// (swk shipped after most members enrolled), or a member enrolls from a SHORT code that carries no
// keys at all, that member has the field undefined, so their space-write draw silently mis-blinds
// under the enrollment key and every channel/group/DM write is rejected once space_tokens_required is
// on. This lets the fleet converge WITHOUT re-enrolling. The keys are PUBLIC (already shipped in join
// codes) — safe to publish. Only meaningful under domain separation; with it off every purpose key
// equals the enrollment key and members already fall back to it correctly, so there is nothing to
// distribute.
//
// (T1.6, fixes F8) This is the ONE mechanism that keeps the whole fleet's issuer keys in sync, so a
// single-attempt fire-and-forget publish silently no-opping (a relay hiccup, a Tor blip) reproduces
// the swk incident for every domain at once. It must therefore actually confirm delivery: retry with
// capped exponential backoff until the relay's OK frame accepts (or exhaust a bounded number of
// attempts — never loop forever), and record the terminal outcome so an operator can see it on the
// dashboard (Activation tab, via buildActivationState → tokenKeysPublish) as well as in the server
// log — instead of the previous "logs on failure, silent on success, tried exactly once" behavior.
// Callers (startup above, and the /api/activation POST handler) stay fire-and-forget so a slow/
// unreachable relay never delays startup or the HTTP response; only this function's own await chain
// (bounded to a handful of attempts/seconds) waits, and it never throws.
let tokenKeysPublishStatus = {attempted: false, ok: null, attempts: 0, message: '', at: null};
async function publishTokenKeys() {
  if (!TOKEN_DOMAIN_SEP) return;
  const event = signConfig('stiq:token-keys', [], JSON.stringify({
    v: 1,
    pk: postKey.pubB64,
    rk: readKey.pubB64,
    pwk: picWriteKey.pubB64,
    prk: picReadKey.pubB64,
    awk: audWriteKey.pubB64,
    ark: audReadKey.pubB64,
    swk: spaceWriteKey.pubB64,
  }));
  const result = await publishWithRetry(event, RELAY_WS);
  tokenKeysPublishStatus = {
    attempted: true,
    ok: result.ok,
    attempts: result.attempts,
    message: result.message,
    at: Date.now(),
  };
  if (result.ok) {
    console.log(`[organizer] token-keys published after ${result.attempts} attempt(s): ${result.message}`);
  } else {
    console.error(`[organizer] token-keys publish FAILED after ${result.attempts} attempt(s): ${result.message}`);
  }
  return result;
}

// Drive epoch rotation from the relay firehose: count sealed posts and roll K_E every
// CONTENT_ROTATE_EVERY, re-publishing stiq:content-epoch so writers move to the new key. Best-effort
// and fully isolated (its own ws; never touches the enrollment mailbox); dormant until sealing is
// live (no sealed posts => no rotation). Fire-and-forget: a failure here never blocks startup.
startContentEpochWatcher({
  relayUrl: RELAY_WS,
  custody: contentCustody,
  onRotate: () => publishContentEpoch(),
}).catch(e => console.error('[organizer] content-epoch watcher failed to start:', e?.message || e));

// Periodic republish of both fleet-sync docs (T1.6/F8 pattern extended, task 3): startup + reconnect
// (mailbox onOpen, above) cover the common cases, but a member's OWN client could still miss a
// publish (offline at the time, a mirror relay that dropped it) with no reconnect event on the
// organizer's side to hang a re-publish off of. A standing 6h timer is the backstop — cheap (two
// idempotent, replaceable kind-30078 publishes) and bounds "how stale can a straggler's copy get" to
// a few hours even with zero reconnects. unref() so this timer never keeps the process alive on its
// own (shutdown() still clears it explicitly for a clean stop).
const REPUBLISH_INTERVAL_MS = 6 * 3600 * 1000;
const republishTimer = setInterval(() => {
  publishTokenKeys().catch(e => console.error('[organizer] token-keys periodic republish failed:', e?.message || e));
  publishContentEpoch().catch(e => console.error('[organizer] content-epoch periodic republish failed:', e?.message || e));
}, REPUBLISH_INTERVAL_MS);
republishTimer.unref?.();

// ── Graceful shutdown + last-resort process handlers ────────────────────────────
// On SIGTERM/SIGINT (systemd stop, Ctrl-C) stop accepting HTTP, then stop the mailbox — its stop()
// synchronously flushes mailbox_seen so a restart doesn't replay + re-mine every stored request.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[organizer] received ' + signal + '; shutting down.');
  try { clearInterval(republishTimer); } catch { /* best-effort */ }
  try { mailboxHandle?.stop(); } catch (e) { console.error('[organizer] mailbox stop error:', e?.message || e); }
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  // Don't hang forever if a keep-alive socket won't close.
  setTimeout(() => process.exit(0), 5000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Surface async faults instead of losing them. A rejected promise we didn't await shouldn't tear the
// process down (the mailbox + dashboard keep serving), but it MUST be logged with context.
process.on('unhandledRejection', reason => {
  console.error('[organizer] unhandledRejection:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});
process.on('uncaughtException', err => {
  // An uncaught exception leaves the process in an undefined state (Node docs warn it is unsafe to
  // resume). Log with context, then exit so systemd (Restart=on-failure) restarts into a clean
  // state instead of letting the mailbox/dashboard limp along wedged.
  console.error('[organizer] FATAL uncaughtException — exiting for a clean restart:',
    err?.stack || err?.message || err);
  process.exit(1);
});

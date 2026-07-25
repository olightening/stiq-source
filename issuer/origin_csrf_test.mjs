/**
 * CSRF / reverse-proxy Origin check invariants (finding #S5).
 *
 * State-changing dashboard requests are gated by originMatchesHost: a browser's Origin must match the
 * host the dashboard is actually served from. A TLS-terminating reverse proxy that rewrites Host to
 * the backend (nginx `proxy_set_header Host localhost:7799`) while the browser sends the EXTERNAL
 * Origin would 403 every POST/DELETE under a bare Origin===Host check. The fix consults, in priority:
 *   1. STIQ_PUBLIC_ORIGIN (explicit external origin) — can't be spoofed by a request header.
 *   2. X-Forwarded-Host (external Host the proxy saw) — same trust basis as X-Forwarded-Proto.
 *   3. the request Host — direct loopback / onion-direct, where the CSRF + DNS-rebinding defence must
 *      remain byte-identical to before.
 *
 * This mirrors expectedOriginHost/originMatchesHost/parseHostFromOrigin in organizer-server.mjs
 * (kept in lockstep) and pins that the reverse-proxy deploy works AND the direct CSRF defence holds.
 */
import assert from 'assert';

// ── Mirror of organizer-server.mjs (kept in lockstep) ────────────────────────────
function parseHostFromOrigin(v) {
  if (!v) return null;
  const s = String(v).trim();
  try { const h = new URL(s).host.toLowerCase(); if (h) return h; } catch { /* not a full URL */ }
  try { const h = new URL('https://' + s).host.toLowerCase(); if (h) return h; } catch { /* unparseable */ }
  return null;
}
// publicOrigin is captured from the env once at boot in the real code; the test passes it explicitly
// so a single process can exercise both the configured and unconfigured deployments.
function expectedOriginHost(req, publicOriginHost) {
  if (publicOriginHost) return publicOriginHost;
  const xfh = req.headers['x-forwarded-host'];
  if (xfh) return String(xfh).split(',')[0].trim().toLowerCase();
  return String(req.headers.host || '').toLowerCase();
}
function originMatchesHost(req, publicOriginHost = null) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === expectedOriginHost(req, publicOriginHost); }
  catch { return false; }
}
const req = (headers) => ({headers});

// ── 1. Direct loopback: the CSRF defence is unchanged ───────────────────────────
{
  const noPub = null;
  assert.strictEqual(originMatchesHost(req({origin: 'http://localhost:7799', host: 'localhost:7799'}), noPub), true,
    'same-origin dashboard POST is allowed');
  assert.strictEqual(originMatchesHost(req({origin: 'https://evil.example', host: 'localhost:7799'}), noPub), false,
    'a cross-site Origin is rejected (CSRF blocked)');
  assert.strictEqual(originMatchesHost(req({host: 'localhost:7799'}), noPub), true,
    'no Origin (non-browser tooling / same-origin nav) is allowed');
  assert.strictEqual(originMatchesHost(req({origin: 'not a url', host: 'localhost:7799'}), noPub), false,
    'an unparseable Origin is rejected');
  console.log('ok 1 — direct-loopback CSRF defence intact (same-origin allowed, cross-site + junk rejected)');
}

// ── 2. STIQ_PUBLIC_ORIGIN: the browser's external Origin is validated, not the rewritten Host ────
{
  const pub = parseHostFromOrigin('https://dash.example.org');
  assert.strictEqual(pub, 'dash.example.org', 'STIQ_PUBLIC_ORIGIN parses to its host');
  // Proxy rewrote Host to the backend; browser still sends the external Origin. Previously a 403.
  assert.strictEqual(originMatchesHost(req({origin: 'https://dash.example.org', host: 'localhost:7799'}), pub), true,
    'external Origin matching STIQ_PUBLIC_ORIGIN is allowed behind a Host-rewriting proxy');
  // A cross-site attacker's Origin still fails against the configured public origin.
  assert.strictEqual(originMatchesHost(req({origin: 'https://evil.example', host: 'localhost:7799'}), pub), false,
    'a foreign Origin is still rejected when a public origin is configured');
  // Bare host (no scheme) in STIQ_PUBLIC_ORIGIN is tolerated.
  assert.strictEqual(parseHostFromOrigin('dash.example.org:8443'), 'dash.example.org:8443',
    'a bare host[:port] STIQ_PUBLIC_ORIGIN is accepted');
  console.log('ok 2 — STIQ_PUBLIC_ORIGIN validates the external Origin against the configured host');
}

// ── 3. X-Forwarded-Host: honored from the trusted proxy when no public origin is set ─────────────
{
  const noPub = null;
  assert.strictEqual(originMatchesHost(
    req({origin: 'https://dash.example.org', host: 'localhost:7799', 'x-forwarded-host': 'dash.example.org'}), noPub), true,
    'external Origin matching X-Forwarded-Host is allowed');
  assert.strictEqual(originMatchesHost(
    req({origin: 'https://evil.example', host: 'localhost:7799', 'x-forwarded-host': 'dash.example.org'}), noPub), false,
    'a foreign Origin is rejected even with X-Forwarded-Host present');
  // A multi-hop X-Forwarded-Host uses the first (client-facing) value.
  assert.strictEqual(originMatchesHost(
    req({origin: 'https://dash.example.org', host: 'localhost:7799', 'x-forwarded-host': 'dash.example.org, inner.proxy'}), noPub), true,
    'the first X-Forwarded-Host hop (client-facing) is used');
  console.log('ok 3 — X-Forwarded-Host honored for the reverse-proxy deploy, foreign Origin still rejected');
}

// ── 4. Priority: STIQ_PUBLIC_ORIGIN wins over X-Forwarded-Host ───────────────────────────────────
{
  const pub = parseHostFromOrigin('https://dash.example.org');
  // A request forging X-Forwarded-Host cannot override the explicitly configured public origin.
  assert.strictEqual(originMatchesHost(
    req({origin: 'https://evil.example', host: 'localhost:7799', 'x-forwarded-host': 'evil.example'}), pub), false,
    'a forged X-Forwarded-Host cannot beat the configured STIQ_PUBLIC_ORIGIN');
  assert.strictEqual(originMatchesHost(
    req({origin: 'https://dash.example.org', host: 'localhost:7799', 'x-forwarded-host': 'evil.example'}), pub), true,
    'the configured public origin still admits the real external Origin');
  console.log('ok 4 — STIQ_PUBLIC_ORIGIN takes priority over X-Forwarded-Host');
}

console.log('\nall origin/CSRF invariants hold.');

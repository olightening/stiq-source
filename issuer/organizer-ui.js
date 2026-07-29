var communityCode = '';
var mods = [];
var communityTags = [];
var communityTagScopes = {}; // tag -> 'article' | 'note' (absent ⇒ 'all')
var mirrors = [];

// ── Tab-load error guard (2026-07-21 incident) ────────────────────────────────────
// A transient GET failure (relay hiccup, dashboard restart mid-request, or just a slow box) must
// never leave a tab showing stale/blank fields that a click of that tab's Publish/Save would then
// write over the REAL config — that's exactly the shape of risk a lost /api/activation read once
// posed. Every tab loader below is registered here and invoked through reloadTab() instead of being
// called directly, so a load failure always shows a retry banner and disables that tab's save/publish
// controls until a load actually succeeds again.
var TAB_LOADERS = {}; // tab name -> {run: fn, controls: [elementId, ...]}

/** Register a tab's loader + the control ids to disable while its data is unknown ([] = read-only tab). */
function registerTabLoad(name, controls, run) {
  TAB_LOADERS[name] = {run: run, controls: controls};
}

function setTabControlsDisabled(controls, disabled) {
  for (var i = 0; i < controls.length; i++) {
    var el = document.getElementById(controls[i]);
    if (el) el.disabled = disabled;
  }
}

// Lazily creates (and thereafter reuses) one error banner per tab, placed right under its <h2>.
function tabLoadBanner(name) {
  var id = 'tabload-err-' + name;
  var el = document.getElementById(id);
  if (el) return el;
  var section = document.getElementById('tab-' + name);
  if (!section) return null;
  el = document.createElement('div');
  el.id = id;
  el.className = 'err';
  el.style.display = 'none';
  el.style.marginBottom = '12px';
  var h2 = section.querySelector('h2');
  if (h2 && h2.nextSibling) section.insertBefore(el, h2.nextSibling);
  else section.insertBefore(el, section.firstChild);
  return el;
}

/**
 * Run a registered tab's loader with the retry-banner + control-disable guard. Controls are
 * re-enabled BEFORE the loader runs (a loader that enforces its own business-rule disabling — e.g.
 * loadActivation's key-present gates — simply re-applies that itself once it runs); on failure they
 * are forced back to disabled, since a failed load means we no longer know their true state.
 */
function reloadTab(name) {
  var entry = TAB_LOADERS[name];
  if (!entry) return;
  var banner = tabLoadBanner(name);
  setTabControlsDisabled(entry.controls, false);
  return Promise.resolve().then(entry.run).then(function () {
    if (banner) banner.style.display = 'none';
  }).catch(function (e) {
    setTabControlsDisabled(entry.controls, true);
    if (banner) {
      banner.innerHTML = '';
      var msg = document.createElement('span');
      msg.textContent = "Couldn't load current settings (" + (e && e.message ? e.message : e) + ") — ";
      banner.appendChild(msg);
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn sm';
      retry.textContent = 'Retry';
      retry.onclick = function () { reloadTab(name); };
      banner.appendChild(retry);
      banner.style.display = 'block';
    }
  });
}

// Buttons are matched by their data-tab attribute (never by index — the grouped sidebar has
// non-button children, and an index-coupled TABS array once made every nav edit a paired change).
// Any tab with a registered loader is refreshed on entry; the rest (onboard's generators,
// maintenance) need no fetch. The hash mirrors the open tab so a reload lands where you were.
function switchTab(name) {
  var sec = document.getElementById('tab-' + name);
  if (!sec) return;
  var btns = document.querySelectorAll('#nav button[data-tab]');
  var secs = document.querySelectorAll('main > section');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === name);
  }
  for (var i = 0; i < secs.length; i++) secs[i].classList.remove('on');
  sec.classList.add('on');
  try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// etc — cosmetic only */ }
  if (TAB_LOADERS[name]) reloadTab(name);
  window.scrollTo(0, 0);
}

// Tab -> {controls, loader} registrations. Kept in one place for a single point of review; the
// load*() functions themselves are defined further down, in their own sections (function
// declarations are hoisted, so referencing them here — before their textual definition — is safe).
// 'onboard' is the merged Members page: the invites table + the (legacy-drawer) community code.
registerTabLoad('onboard', [], function () {
  return Promise.all([loadInvites(), loadCommunityCode()]);
});
registerTabLoad('mods', ['pub-roster-btn'], loadMods);
registerTabLoad('tags', ['pub-tags-btn'], loadTagPolicy);
registerTabLoad('limits', ['pub-limits-btn'], loadLimits);
registerTabLoad('tokens', ['save-tokens-btn', 'save-mbx-btn'], loadTokensTab);
registerTabLoad('activation', ['act-space', 'act-media', 'act-ce'], loadActivation);
registerTabLoad('labels', ['pub-labels-btn'], loadLabels);
registerTabLoad('postrules', ['pub-postrules-btn'], loadPostRules);
// 'media' is the merged Pictures + Audio page — one guard over both publish buttons.
registerTabLoad('media', ['pub-pictures-btn', 'pub-audio-btn'], function () {
  return Promise.all([loadPictureRules(), loadAudioRules()]);
});
registerTabLoad('readaccess', [], loadReadAccess);
registerTabLoad('reasons', ['pub-reasons-btn'], loadReasons);
registerTabLoad('perms', ['pub-perms-btn'], loadPermissions);
registerTabLoad('modlimits', ['pub-modlimits-btn'], loadModLimits);
registerTabLoad('gov', ['pub-gov-btn'], loadGov);
registerTabLoad('community-cfg', ['pub-community-btn'], loadCommunity);
registerTabLoad('logpage', ['pub-lp-btn'], loadLogPage);
registerTabLoad('ranking', ['pub-ranking-btn'], loadRanking);
registerTabLoad('storage', ['pub-storage-btn'], loadStorage);
registerTabLoad('safebrowsing', ['sb-save-btn', 'sb-clear-btn'], loadSafeBrowsing);
registerTabLoad('relays', ['pub-mirrors-btn'], loadMirrors);
registerTabLoad('guidelines', ['pub-guidelines-btn'], loadGuidelines);

// ── QR ────────────────────────────────────────────────────────────────────────

function qrUrl(data) {
  return '/api/qr?data=' + encodeURIComponent(data);
}

// ── Expiry + uses (feature 4 / multi-use) ─────────────────────────────────────
// Advisory-only client-side helpers: they compute the `expiresAt`/`maxUses` sent to the organizer,
// which is the SOLE authoritative enforcement point (invite-issuance.mjs). The join code's optional
// `x` field is a UX hint for the app, never itself enforced.

/** Hide the number input while the expiry unit is "Never" (the number is meaningless then). */
function onExpUnit(nId, unitId) {
  var never = !document.getElementById(unitId).value;
  document.getElementById(nId).style.display = never ? 'none' : 'inline-block';
}

/** Disable the uses number while "unlimited" is checked. */
function onUsesUnl(nId, unlId) {
  document.getElementById(nId).disabled = document.getElementById(unlId).checked;
}

/** Number input + unit <select> (Never/min/hour/day) -> ISO string, or null for Never. Default Never. */
function computeExpiresAt(nId, unitId) {
  var unit = document.getElementById(unitId).value;
  if (!unit) return null; // Never
  var n = parseFloat(document.getElementById(nId).value);
  if (!isFinite(n) || n <= 0) return null;
  var ms = {min: 60e3, hour: 3600e3, day: 86400e3}[unit];
  return ms ? new Date(Date.now() + n * ms).toISOString() : null;
}

/** Uses number input + "unlimited" checkbox -> positive integer, or null for unlimited. Default 1. */
function computeMaxUses(nId, unlId) {
  if (document.getElementById(unlId).checked) return null; // unlimited
  var n = parseInt(document.getElementById(nId).value, 10);
  return isFinite(n) && n >= 1 ? n : 1;
}

function fmtExpiry(expiresAt) {
  return expiresAt ? new Date(expiresAt).toLocaleString() : 'Never';
}

// Compact relative countdown for the invites table (absolute timestamp goes in the cell's title).
function fmtCountdown(expiresAt) {
  if (!expiresAt) return 'Never';
  var ms = Date.parse(expiresAt) - Date.now();
  if (!isFinite(ms)) return 'Never';
  if (ms <= 0) return 'expired';
  var mins = Math.round(ms / 60000);
  if (mins < 60) return 'in ' + mins + 'm';
  var hrs = Math.round(mins / 60);
  if (hrs < 48) return 'in ' + hrs + 'h';
  return 'in ' + Math.round(hrs / 24) + 'd';
}

// One "what did I just mint" note, with a loud amber warning for the one open-ended combination
// (unlimited uses AND never expires) — the organizer's only auto-close is then Revoke.
function setMintNote(elId, maxUses, expiresAt) {
  var el = document.getElementById(elId);
  if (!el) return;
  if (maxUses == null && !expiresAt) {
    el.textContent = '⚠ Unlimited uses and never expires — this link stays open until you revoke it.';
    el.style.color = '#e0a83a';
  } else {
    el.textContent = maxUses == null ? 'Unlimited uses until revoked.'
      : maxUses === 1 ? 'Single use — send to one person only.'
      : 'Works up to ' + maxUses + ' times.';
    el.style.color = '';
  }
}

// ── Join codes ──────────────────────────────────────────────────────────────────

async function genJoin() {
  var errEl = document.getElementById('join-err');
  errEl.style.display = 'none';
  try {
    var expiresAt = computeExpiresAt('join-exp-n', 'join-exp-unit');
    var maxUses = computeMaxUses('join-uses', 'join-uses-unl');
    // Unique per-click URL so NO cache (browser, proxy, onion front) can ever replay a prior mint —
    // a cache cannot serve a URL it has never seen. This is the guarantee; cache:'no-store' + the
    // server's Cache-Control:no-store are belt-and-suspenders. Without it, an unchanged expiry (same
    // request body) let an aggressive cache hand back the SAME code — it only looked fresh when the
    // expiry changed the request. The server ignores the _ param.
    var r = await fetch('/api/join?_=' + Date.now() + '_' + Math.random().toString(36).slice(2), {
      method: 'POST',
      cache: 'no-store',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({expiresAt: expiresAt, maxUses: maxUses}),
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    document.getElementById('new-join-text').textContent = d.joinCode;
    // Encode the deep-link form in the QR so scanning it opens the app directly.
    document.getElementById('new-join-qr').src = qrUrl(d.joinUrl);
    setMintNote('new-join-note', maxUses, expiresAt);
    document.getElementById('new-join-exp').textContent = 'Expires: ' + fmtExpiry(expiresAt);
    document.getElementById('new-join').style.display = 'block';
    loadInvites();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

// ── Invites ───────────────────────────────────────────────────────────────────

async function genInvite() {
  var errEl = document.getElementById('inv-err');
  errEl.style.display = 'none';
  try {
    var expiresAt = computeExpiresAt('inv-exp-n', 'inv-exp-unit');
    var maxUses = computeMaxUses('inv-uses', 'inv-uses-unl');
    // Unique per-click URL so no cache can ever replay a prior mint (see genJoin). Server ignores _.
    var r = await fetch('/api/invite?_=' + Date.now() + '_' + Math.random().toString(36).slice(2), {
      method: 'POST',
      cache: 'no-store',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({expiresAt: expiresAt, maxUses: maxUses}),
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    document.getElementById('new-inv-text').textContent = d.code;
    document.getElementById('new-inv-qr').src = qrUrl(d.code);
    setMintNote('new-inv-note', maxUses, expiresAt);
    document.getElementById('new-inv-exp').textContent = 'Expires: ' + fmtExpiry(expiresAt);
    document.getElementById('new-inv').style.display = 'block';
    loadInvites();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

// Full join code per invite (code → "stiq:join:1:…"), captured for the per-row Copy button.
var inviteJoinCodes = {};

async function loadInvites() {
  var r = await fetch('/api/invites');
  var d = await r.json();
  var entries = Object.entries(d.invites).sort(function(a, b) {
    return b[1].createdAt < a[1].createdAt ? -1 : 1;
  });
  document.getElementById('inv-count').textContent = entries.length;
  inviteJoinCodes = {};
  var rows = '';
  if (entries.length === 0) {
    rows = '<tr><td colspan="6" style="color:var(--mu);padding:16px 8px">No invites yet.</td></tr>';
  } else {
    for (var i = 0; i < entries.length; i++) {
      var code = entries[i][0], info = entries[i][1];
      if (info.joinCode) inviteJoinCodes[code] = info.joinCode;
      // Status/uses are computed authoritatively by the server (invite-issuance.summarizeInvite).
      var status = info.status || 'active';
      var cls  = status === 'expired' ? 'expired' : status === 'exhausted' ? 'exhausted' : 'live';
      var stat = status.charAt(0).toUpperCase() + status.slice(1);
      var uses = (info.usesCount || 0) + ' / ' + (info.maxUses == null ? '∞' : info.maxUses);
      var date = new Date(info.createdAt).toLocaleDateString();
      var expCell = fmtCountdown(info.expiresAt);
      var expTitle = info.expiresAt ? new Date(info.expiresAt).toLocaleString() : 'Never';
      rows += '<tr>'
        + '<td class="' + cls + '">' + esc(code) + '</td>'
        + '<td class="' + cls + '">' + stat + '</td>'
        + '<td style="color:var(--mu);white-space:nowrap">' + uses + '</td>'
        + '<td style="color:var(--mu)">' + date + '</td>'
        + '<td style="color:var(--mu)" title="' + esc(expTitle) + '">' + expCell + '</td>'
        + '<td style="white-space:nowrap">'
        +   '<button class="btn ghost sm" onclick="copyJoin(\'' + esc(code) + '\', this)">Copy</button> '
        +   '<button class="btn ghost sm" onclick="promptInviteUses(\'' + esc(code) + '\')">Uses…</button> '
        +   '<button class="btn ghost sm" onclick="promptInviteExpiry(\'' + esc(code) + '\')">Expiry…</button> '
        +   (info.expiresAt ? '<button class="btn ghost sm" onclick="clearInviteExpiry(\'' + esc(code) + '\')">Clear</button> ' : '')
        +   '<button class="btn danger sm" onclick="revokeInvite(\'' + esc(code) + '\')">Revoke</button>'
        + '</td>'
        + '</tr>';
    }
  }
  document.getElementById('inv-body').innerHTML = rows;
}

// Parse a short duration ("30m", "6h", "7d", or a bare number = days) into an ISO string; blank -> null.
function parseDurationToIso(v) {
  v = (v || '').trim().toLowerCase();
  if (!v) return null;
  var m = v.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|hour|d|day)?s?$/);
  if (!m) return null;
  var n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  var u = m[2] || 'd';
  var ms = u[0] === 'm' ? 60e3 : u[0] === 'h' ? 3600e3 : 86400e3;
  return new Date(Date.now() + n * ms).toISOString();
}

/** Prompt for a new expiry (30m / 6h / 7d, blank = never) and PATCH it. */
async function promptInviteExpiry(code) {
  var v = window.prompt('Expire this invite in… (e.g. 30m, 6h, 7d — blank = never)', '7d');
  if (v === null) return;
  await patchInvite(code, {expiresAt: parseDurationToIso(v)});
}

async function clearInviteExpiry(code) {
  await patchInvite(code, {expiresAt: null});
}

/** Prompt for a new total use count (a number, or "unlimited") and PATCH it. */
async function promptInviteUses(code) {
  var v = window.prompt('Total uses for this invite (a number, or "unlimited"):', '');
  if (v === null) return;
  v = v.trim().toLowerCase();
  var maxUses;
  if (v === 'unlimited' || v === 'inf' || v === '∞') {
    maxUses = null;
  } else {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n < 1) return;
    maxUses = n;
  }
  await patchInvite(code, {maxUses: maxUses});
}

// Generic PATCH /api/invite/:code — sends only the fields present in `body` (the server changes only
// those), then refreshes the list. Used for both expiry and use-count adjustments.
async function patchInvite(code, body) {
  var errEl = document.getElementById('inv-err');
  if (errEl) errEl.style.display = 'none';
  try {
    var r = await fetch('/api/invite/' + encodeURIComponent(code), {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      var d = await r.json().catch(function () { return {}; });
      if (errEl) { errEl.textContent = 'Could not update invite: ' + (d.error || r.status); errEl.style.display = 'block'; }
    }
  } catch (e) {
    if (errEl) { errEl.textContent = 'Could not update invite: ' + e.message; errEl.style.display = 'block'; }
  }
  loadInvites();
}

// Copy the entire join code for one invite (looked up by short code to avoid escaping the long string in HTML).
function copyJoin(code, btn) {
  var jc = inviteJoinCodes[code];
  if (!jc) return;
  copyText(jc);
  if (btn) {
    var prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function () { btn.textContent = prev; }, 1200);
  }
}

async function revokeInvite(code) {
  await fetch('/api/invite/' + encodeURIComponent(code), { method: 'DELETE' });
  loadInvites();
}

// ── Health (org-4) ────────────────────────────────────────────────────────────
// Pill in the header surfaces GET /health so an operator sees "organizer can actually reach the
// relay" at a glance, without opening a terminal — this dashboard is otherwise the only place a
// human ever looks post-flip. Reuses the .badge box styling + the .live/.expired text-color
// classes already defined for the Invites table (green/red), not new CSS.
async function loadHealth() {
  var pill = document.getElementById('health-pill');
  try {
    var r = await fetch('/health');
    var d = await r.json();
    pill.className = 'badge ' + (d.ok ? 'live' : 'expired');
    pill.textContent = d.ok ? 'relay ok' : ('relay ' + (d.relayReachable ? 'unhealthy' : 'unreachable'));
    pill.title = 'GET /health — relayWs=' + (d.relayWs || '?')
      + ' reachable=' + d.relayReachable
      + ' onionConfigured=' + d.relayOnionConfigured
      + ' keysLoaded=' + d.keysLoaded
      + ' (checked ' + d.checkedAt + ')';
  } catch (e) {
    // A network/parse failure here means the dashboard itself can't be reached to ask — distinct
    // from a 503 {ok:false} body, which DID reach the server and got a real diagnostic.
    pill.className = 'badge expired';
    pill.textContent = 'health check failed';
    pill.title = e.message;
  }
}

// ── Community code ────────────────────────────────────────────────────────────

async function loadCommunityCode() {
  var r = await fetch('/api/community-code');
  var d = await r.json();
  communityCode = d.communityCode;
  var box = document.getElementById('comm-code-box');
  // Replace only the text node (first child), keep the Copy button
  box.firstChild.textContent = communityCode;
  document.getElementById('comm-qr').src = qrUrl(communityCode);
}

// ── Sign ──────────────────────────────────────────────────────────────────────

async function doSign() {
  var btn   = document.getElementById('sign-btn');
  var errEl = document.getElementById('sign-err');
  var resEl = document.getElementById('sign-res');
  errEl.style.display = 'none';
  resEl.style.display = 'none';
  var req = document.getElementById('req-in').value.trim();
  if (!req) {
    errEl.textContent = 'Paste or scan the member request code first.';
    errEl.style.display = 'block';
    return;
  }
  btn.innerHTML = '<span class="spin"></span> Signing…';
  btn.disabled = true;
  try {
    var r = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestCode: req })
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    document.getElementById('resp-text').textContent = d.responseCode;
    document.getElementById('resp-qr').src = qrUrl(d.responseUrl);
    resEl.style.display = 'block';
    stopCam();
    loadInvites();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.textContent = 'Sign';
    btn.disabled = false;
  }
}

function clearSign() {
  document.getElementById('req-in').value = '';
  document.getElementById('sign-err').style.display = 'none';
  document.getElementById('sign-res').style.display = 'none';
  stopCam();
}

// ── Camera ────────────────────────────────────────────────────────────────────

var camStream = null, camRaf = null;

// jsQR (~256 KB) is only needed to scan a member-request QR with the camera, which most organizers
// never do — pasting the code is the common path. So it's kept off the initial page load entirely and
// fetched on demand the first time the scanner opens. Loaded at most once; a failure surfaces inline.
var _jsqrPromise = null;
function ensureJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (_jsqrPromise) return _jsqrPromise;
  _jsqrPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = '/jsqr.js?v=' + (window.__ASSET_V__ || '1');
    s.onload = function () { resolve(); };
    s.onerror = function () { _jsqrPromise = null; reject(new Error('Could not load the QR scanner.')); };
    document.head.appendChild(s);
  });
  return _jsqrPromise;
}

async function startCam() {
  try {
    await ensureJsQR();
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    var video   = document.getElementById('cam-video');
    var canvas  = document.getElementById('cam-canvas');
    var overlay = document.getElementById('cam-overlay');
    video.srcObject = camStream;
    document.getElementById('cam-box').style.display  = 'block';
    document.getElementById('cam-btn').style.display  = 'none';
    document.getElementById('cam-stop').style.display = 'inline-flex';
    overlay.textContent = 'Scanning…';
    function tick() {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        var img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
        var code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data.indexOf('stiq:cred-req:') === 0) {
          document.getElementById('req-in').value = code.data;
          overlay.textContent = 'Scanned!';
          setTimeout(stopCam, 700);
          return;
        }
      }
      camRaf = requestAnimationFrame(tick);
    }
    camRaf = requestAnimationFrame(tick);
  } catch (e) {
    document.getElementById('sign-err').textContent = 'Camera error: ' + e.message;
    document.getElementById('sign-err').style.display = 'block';
  }
}

function stopCam() {
  if (camStream) { camStream.getTracks().forEach(function(t) { t.stop(); }); camStream = null; }
  if (camRaf)    { cancelAnimationFrame(camRaf); camRaf = null; }
  document.getElementById('cam-box').style.display  = 'none';
  document.getElementById('cam-btn').style.display  = 'inline-flex';
  document.getElementById('cam-stop').style.display = 'none';
}

// ── Moderators ────────────────────────────────────────────────────────────────

async function loadMods() {
  var r = await fetch('/api/moderators');
  var d = await r.json();
  mods = d.moderators;
  renderMods();
}

async function addMod() {
  var npub  = document.getElementById('npub-in').value.trim();
  var errEl = document.getElementById('mod-err');
  errEl.style.display = 'none';
  if (!npub) return;
  try {
    var r = await fetch('/api/moderators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npub: npub })
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    mods = d.moderators;
    document.getElementById('npub-in').value = '';
    renderMods();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function removeMod(npub) {
  var r = await fetch('/api/moderators/' + encodeURIComponent(npub), { method: 'DELETE' });
  var d = await r.json();
  mods = d.moderators;
  renderMods();
}

function renderMods() {
  document.getElementById('mod-count').textContent = mods.length;
  var list = document.getElementById('mod-list');
  list.innerHTML = '';
  if (mods.length === 0) {
    var empty = document.createElement('span');
    empty.style.cssText = 'color:var(--mu);font-size:13px';
    empty.textContent = 'No moderators yet.';
    list.appendChild(empty);
  } else {
    // Build with DOM APIs + textContent + addEventListener (NOT an inline onclick string): the browser
    // HTML-decodes an attribute value before compiling the handler, so esc()'s &#39; would decode back
    // to a real quote inside removeMod('…') and let a crafted npub break out and run — stored DOM XSS
    // in the key-holding dashboard origin (#13). textContent + a closure never parses the value as code.
    for (var i = 0; i < mods.length; i++) {
      (function (n) {
        var chip = document.createElement('div');
        chip.className = 'chip';
        var short = document.createElement('span');
        short.textContent = n.slice(0, 12) + '…' + n.slice(-6);
        var full = document.createElement('span');
        full.style.cssText = 'color:var(--mu);font-size:11px';
        full.textContent = n;
        var btn = document.createElement('button');
        btn.title = 'Remove';
        btn.textContent = '✕';
        btn.addEventListener('click', function () { removeMod(n); });
        chip.appendChild(short); chip.appendChild(full); chip.appendChild(btn);
        list.appendChild(chip);
      })(mods[i]);
    }
  }
  var lines = mods.length === 0
    ? '  // no moderators'
    : mods.map(function(n) { return "  '" + n + "',"; }).join('\n');
  document.getElementById('mod-ts-inner').textContent =
    "export const MODERATOR_NPUBS: readonly string[] = [\n" + lines + "\n];";
}

// ── Tag Policy ────────────────────────────────────────────────────────────────

async function loadTagPolicy() {
  var r = await fetch('/api/tag-policy');
  var d = await r.json();
  communityTags = d.communityTags || [];
  communityTagScopes = d.tagScopes || {};
  document.getElementById('tag-pin').checked = d.pinCommunityTags !== false;
  document.getElementById('tag-mem').checked = d.allowMemberTags !== false;
  document.getElementById('tag-max').value = (d.maxTags && d.maxTags > 0) ? d.maxTags : 0;
  renderTagChips();
}

function renderTagChips() {
  var container = document.getElementById('tag-chips');
  if (communityTags.length === 0) {
    container.innerHTML = '<span style="color:var(--mu);font-size:12px">No community tags yet.</span>';
    return;
  }
  var html = '';
  for (var i = 0; i < communityTags.length; i++) {
    var t = communityTags[i];
    var sc = communityTagScopes[t] || 'all';
    html += '<div class="chip" style="padding:5px 6px 5px 10px;gap:6px">'
      + '<span>#' + esc(t) + '</span>'
      + '<select onchange="setCommunityTagScope(\'' + esc(t) + '\', this.value)" title="Which post types may use this tag" style="height:26px;font-size:11px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg);color:var(--tx);cursor:pointer">'
        + '<option value="all"' + (sc === 'all' ? ' selected' : '') + '>All</option>'
        + '<option value="article"' + (sc === 'article' ? ' selected' : '') + '>Articles</option>'
        + '<option value="note"' + (sc === 'note' ? ' selected' : '') + '>Tweets</option>'
      + '</select>'
      + '<button onclick="removeCommunityTag(\'' + esc(t) + '\')" title="Remove">✕</button>'
      + '</div>';
  }
  container.innerHTML = html;
}

function setCommunityTagScope(tag, value) {
  if (value === 'article' || value === 'note') communityTagScopes[tag] = value;
  else delete communityTagScopes[tag];
}

function addCommunityTag() {
  var input = document.getElementById('tag-input');
  var errEl = document.getElementById('tag-input-err');
  errEl.style.display = 'none';
  var raw = input.value.trim().replace(/^#+/, '').toLowerCase();
  if (!raw) return;
  if (!/^[a-z0-9_-]+$/.test(raw)) {
    errEl.textContent = 'Tags can only contain letters, numbers, hyphens, and underscores.';
    errEl.style.display = 'block';
    return;
  }
  if (communityTags.indexOf(raw) !== -1) {
    errEl.textContent = 'Tag already in the list.';
    errEl.style.display = 'block';
    return;
  }
  communityTags.push(raw);
  input.value = '';
  renderTagChips();
}

function removeCommunityTag(tag) {
  communityTags = communityTags.filter(function(t) { return t !== tag; });
  delete communityTagScopes[tag];
  renderTagChips();
}

async function saveTagPolicy() {
  var okEl  = document.getElementById('tag-save-ok');
  var errEl = document.getElementById('tag-save-err');
  var spin  = document.getElementById('tag-save-spin');
  okEl.style.display = 'none';
  errEl.style.display = 'none';
  spin.style.display = 'inline-block';
  try {
    var policy = {
      communityTags: communityTags,
      pinCommunityTags: document.getElementById('tag-pin').checked,
      allowMemberTags: document.getElementById('tag-mem').checked,
      maxTags: parseInt(document.getElementById('tag-max').value, 10) || 0,
      tagScopes: communityTagScopes,
    };
    var r = await fetch('/api/tag-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy)
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    okEl.style.display = 'block';
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    spin.style.display = 'none';
  }
}

async function publishRoster() {
  var btn = document.getElementById('pub-roster-btn');
  var out = document.getElementById('roster-pub');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Publishing…';
  try {
    var r = await fetch('/api/moderators/publish', { method: 'POST' });
    var d = await r.json();
    out.className = d.ok ? 'ok' : 'err';
    out.textContent = (d.ok ? '✓ ' : '⚠ ') + (d.message || d.error || 'done')
      + ' — event id ' + (d.event ? d.event.id.slice(0, 12) + '…' : '?');
    out.style.display = 'block';
  } catch (e) {
    out.className = 'err'; out.textContent = e.message; out.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '⇪ Publish roster to relay';
  }
}

// ── Limits ──────────────────────────────────────────────────────────────────────

var LIM_CATS = ['posts', 'comments', 'channel'];
var LIM_WINS = ['daily', 'weekly', 'monthly'];

function numOr0(v) { var n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }

async function loadLimits() {
  var r = await fetch('/api/limits');
  var d = await r.json();
  var l = d.limits || {};
  for (var i = 0; i < LIM_CATS.length; i++) {
    var c = LIM_CATS[i];
    for (var j = 0; j < LIM_WINS.length; j++) {
      var w = LIM_WINS[j];
      var el = document.getElementById('lim-' + c + '-' + w);
      if (el) el.value = (l[c] && l[c][w]) || 0;
    }
  }
  document.getElementById('lim-dm').value = l.dm_global_per_min || 0;
  document.getElementById('lim-mailbox').value = l.mailbox_per_min != null ? l.mailbox_per_min : 240;
  document.getElementById('lim-mailbox-conn').value = l.mailbox_per_conn_per_min != null ? l.mailbox_per_conn_per_min : 12;
  document.getElementById('lim-exempt').checked = l.exempt_moderators !== false;
  document.getElementById('lim-voice').checked = l.allow_voice === true;
}

function readLimits() {
  var out = {};
  for (var i = 0; i < LIM_CATS.length; i++) {
    var c = LIM_CATS[i]; out[c] = {};
    for (var j = 0; j < LIM_WINS.length; j++) {
      var w = LIM_WINS[j];
      out[c][w] = numOr0(document.getElementById('lim-' + c + '-' + w).value);
    }
  }
  out.dm_global_per_min = numOr0(document.getElementById('lim-dm').value);
  out.mailbox_per_min = numOr0(document.getElementById('lim-mailbox').value);
  out.mailbox_per_conn_per_min = numOr0(document.getElementById('lim-mailbox-conn').value);
  out.exempt_moderators = document.getElementById('lim-exempt').checked;
  out.allow_voice = document.getElementById('lim-voice').checked;
  return out;
}

async function publishLimits() {
  var btn = document.getElementById('pub-limits-btn');
  var out = document.getElementById('limits-pub');
  var err = document.getElementById('limits-err');
  err.style.display = 'none';
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Publishing…';
  try {
    var r = await fetch('/api/limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readLimits())
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    out.className = d.ok ? 'ok' : 'err';
    out.textContent = (d.ok ? '✓ ' : '⚠ ') + (d.message || 'saved')
      + ' — event id ' + (d.event ? d.event.id.slice(0, 12) + '…' : '?');
    out.style.display = 'block';
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.innerHTML = '⇪ Save &amp; publish limits';
  }
}

// ── Post config: labels / post rules / reason buckets (kind-30078) ──────────────

// Shared publish for the additive config tabs: POST the body, then render the signed event id.
async function publishConfig(path, body, btnId, outId, errId) {
  var btn = document.getElementById(btnId);
  var out = document.getElementById(outId);
  var err = document.getElementById(errId);
  err.style.display = 'none';
  var prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Publishing…';
  try {
    var r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    out.className = d.ok ? 'ok' : 'err';
    out.textContent = (d.ok ? '✓ ' : '⚠ ') + (d.message || 'saved')
      + ' — event id ' + (d.event ? d.event.id.slice(0, 12) + '…' : '?');
    out.style.display = 'block';
  } catch (e) {
    err.textContent = e.message; err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.innerHTML = prev;
  }
}

function mkSmallBtn(label, onclick) {
  var b = document.createElement('button');
  b.className = 'btn sm'; b.textContent = label; b.onclick = onclick;
  b.style.cssText = 'min-width:34px;padding:0 10px';
  return b;
}

// One editable {name, color} row with reorder + remove, shared by labels and reasons. The id is
// left to the server (derived from the name) so renaming never breaks past posts/removals.
// When `withScope` is set (labels), a post-type selector binds d.appliesTo (all/article/note).
function namedColorRow(arr, i, rerender, withScope) {
  var d = arr[i];
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';

  var color = document.createElement('input');
  color.type = 'color'; color.value = d.color || '#8a8f98';
  color.style.cssText = 'width:38px;height:38px;padding:0;border:1px solid var(--bdr);border-radius:8px;background:none;cursor:pointer';
  color.oninput = function () { d.color = color.value; };

  var name = document.createElement('input');
  name.type = 'text'; name.value = d.name || ''; name.placeholder = 'Name';
  name.style.cssText = 'flex:1;min-width:120px;height:38px;padding:0 11px;font-size:13px';
  name.oninput = function () { d.name = name.value; };

  var up = mkSmallBtn('↑', function () { if (i > 0) { var t = arr[i-1]; arr[i-1] = arr[i]; arr[i] = t; rerender(); } });
  var down = mkSmallBtn('↓', function () { if (i < arr.length-1) { var t = arr[i+1]; arr[i+1] = arr[i]; arr[i] = t; rerender(); } });
  var del = mkSmallBtn('✕', function () { arr.splice(i, 1); rerender(); });
  del.style.color = '#e0867a';

  row.appendChild(color); row.appendChild(name);
  if (withScope) {
    var scope = document.createElement('select');
    scope.title = 'Which post types may use this label';
    scope.style.cssText = 'height:38px;padding:0 8px;font-size:12px;border:1px solid var(--bdr);border-radius:8px;background:var(--surf);color:var(--tx);cursor:pointer';
    var scopeOpts = [['all', 'All posts'], ['article', 'Articles'], ['note', 'Tweets']];
    for (var k = 0; k < scopeOpts.length; k++) {
      var o = document.createElement('option');
      o.value = scopeOpts[k][0]; o.textContent = scopeOpts[k][1];
      if ((d.appliesTo || 'all') === scopeOpts[k][0]) o.selected = true;
      scope.appendChild(o);
    }
    scope.onchange = function () { d.appliesTo = scope.value; };
    row.appendChild(scope);
  }
  row.appendChild(up); row.appendChild(down); row.appendChild(del);
  return row;
}

// Labels
var labelDefs = [];

function renderLabelRows() {
  var box = document.getElementById('label-rows');
  box.innerHTML = '';
  if (labelDefs.length === 0) {
    box.innerHTML = '<span style="color:var(--mu);font-size:13px">No labels — members post without a type chip.</span>';
    return;
  }
  for (var i = 0; i < labelDefs.length; i++) box.appendChild(namedColorRow(labelDefs, i, renderLabelRows, true));
}

function addLabel() { labelDefs.push({ id: '', name: 'New label', color: '#6f90c0', appliesTo: 'all' }); renderLabelRows(); }

async function loadLabels() {
  var r = await fetch('/api/labels');
  var d = await r.json();
  labelDefs = (d.labels || []).map(function (l) { return { id: l.id, name: l.name, color: l.color, appliesTo: l.appliesTo || 'all' }; });
  renderLabelRows();
}

function publishLabels() {
  return publishConfig('/api/labels', { labels: labelDefs }, 'pub-labels-btn', 'labels-pub', 'labels-err');
}

// ── Log page — the hearth (kind-30078 stiq:log-page) ────────────────────────────
// ONE panel now controls everything the app's Log tab shows: the owner's note, the standing
// rules, the picked channels/groups, and the people rail. Pick/person rows reuse the same ↑/↓/✕
// reorder-and-remove shape as labels/reasons/the old featured rail — the array order IS the
// published order.
//
// Every value rendered here (a channel/group name, a display name, a ref/pubkey) is
// MEMBER-controlled: a channel's name comes from whoever created it. So rows are built with
// createElement + textContent/value only — never innerHTML and never an inline onclick with an
// interpolated value, which is exactly how a crafted channel name would become stored DOM XSS in
// this dashboard (see the removeMod note above).
var lpPicks = [];
var lpPeople = [];
// Caps mirror the server + client (MAX_LOG_PICKS / MAX_LOG_PEOPLE) — named once so the four
// add-paths below can't drift from each other.
var LP_MAX_PICKS = 8;
var LP_MAX_PEOPLE = 12;

var LOG_PICK_TYPE_OPTS = [['channel', '📢 Channel'], ['group', '👥 Group']];

function logPickRow(arr, i, rerender) {
  var d = arr[i];
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap';

  var type = document.createElement('select');
  type.title = 'Type — a channel by its 30311 coordinate, a group by its id';
  type.style.cssText = 'height:38px;padding:0 8px;font-size:12px;border:1px solid var(--bdr);border-radius:8px;background:var(--surf);color:var(--tx);cursor:pointer';
  for (var k = 0; k < LOG_PICK_TYPE_OPTS.length; k++) {
    var o = document.createElement('option');
    o.value = LOG_PICK_TYPE_OPTS[k][0];
    o.textContent = LOG_PICK_TYPE_OPTS[k][1];
    if ((d.t || 'channel') === LOG_PICK_TYPE_OPTS[k][0]) o.selected = true;
    type.appendChild(o);
  }
  type.onchange = function () { d.t = type.value; rerender(); };

  var ref = document.createElement('input');
  ref.type = 'text'; ref.value = d.a || '';
  ref.placeholder = d.t === 'group' ? 'group id' : '30311:<owner-pubkey>:<d> or a stiq:space:… share link';
  ref.title = 'The reference members’ apps resolve. Use the picker above, or paste a channel/group '
    + '“share link” (stiq:space:…) copied from the app — it is decoded to a coordinate on publish.';
  ref.style.cssText = 'flex:1;min-width:150px;height:38px;padding:0 11px;font-size:12px;font-family:ui-monospace,monospace';
  ref.oninput = function () { d.a = ref.value.trim(); };

  var blurb = document.createElement('input');
  blurb.type = 'text'; blurb.value = d.bl || '';
  blurb.placeholder = '“Everything important lands here first…”';
  blurb.maxLength = 140;
  blurb.title = 'Shown italic, in quotes, under the pick in the app.';
  blurb.style.cssText = 'flex:2;min-width:180px;height:38px;padding:0 11px;font-size:13px;font-style:italic';
  blurb.oninput = function () { d.bl = blurb.value; };

  var chip = document.createElement('input');
  chip.type = 'text'; chip.value = d.c || '';
  chip.placeholder = 'Broadcast / Open / Group / Private — blank = automatic';
  chip.maxLength = 24;
  chip.title = 'Override the kind chip shown beside the pick. Leave blank to let the app infer it.';
  chip.style.cssText = 'width:160px;height:38px;padding:0 11px;font-size:12px';
  chip.oninput = function () { d.c = chip.value; };

  var name = document.createElement('input');
  name.type = 'text'; name.value = d.n || '';
  name.placeholder = 'Fallback name';
  name.title = 'Shown ONLY if a member’s app cannot see this space’s own name (private/unjoined groups). '
    + 'Otherwise the owner’s live name always wins.';
  name.style.cssText = 'width:130px;height:38px;padding:0 11px;font-size:13px';
  name.oninput = function () { d.n = name.value; };

  var up = mkSmallBtn('↑', function () { if (i > 0) { var t = arr[i-1]; arr[i-1] = arr[i]; arr[i] = t; rerender(); } });
  var down = mkSmallBtn('↓', function () { if (i < arr.length-1) { var t = arr[i+1]; arr[i+1] = arr[i]; arr[i] = t; rerender(); } });
  var del = mkSmallBtn('✕', function () { arr.splice(i, 1); rerender(); });
  del.style.color = '#e0867a';

  row.appendChild(type); row.appendChild(ref); row.appendChild(blurb); row.appendChild(chip); row.appendChild(name);
  row.appendChild(up); row.appendChild(down); row.appendChild(del);

  // A picked GROUP is the one combination that can leak: a group's name/existence is normally
  // visible only to its members, and this page is published to everyone. Warn on the row itself
  // rather than blocking — the organizer may well be picking a deliberately public group.
  if (d.t === 'group') {
    var warn = document.createElement('div');
    warn.textContent = '⚠ Groups are members-only by default. Picking one publishes its name '
      + 'to every member. Non-members see its card and can ask to join from it.';
    warn.style.cssText = 'font-size:11px;color:#d9a441;margin:-4px 0 10px 2px;line-height:1.5;width:100%';
    var wrap = document.createElement('div');
    wrap.appendChild(row); wrap.appendChild(warn);
    // Staleness caveat (purely visual — never auto-removes the pick): once discover has been loaded,
    // an offered-private group whose owner has since revoked its offer is DROPPED by the server, so a
    // saved group pick that is absent from discover (or present but private-and-unoffered) is flagged
    // so the organizer can decide to remove it. The manual share-link path is unaffected.
    if (lpDiscoverData && d.a) {
      var de = lpDiscoverData.groups.find(function (g) { return g.ref === d.a; });
      if (!de || (de.private && !de.offered)) {
        var stale = document.createElement('div');
        stale.textContent = '⚠️ no longer offered';
        stale.style.cssText = 'font-size:11px;color:#e0867a;margin:-2px 0 10px 2px;line-height:1.5;width:100%';
        wrap.appendChild(stale);
      }
    }
    return wrap;
  }
  return row;
}

function renderLpPicks() {
  var box = document.getElementById('lp-pick-rows');
  box.innerHTML = '';
  if (lpPicks.length === 0) {
    box.innerHTML = '<span style="color:var(--mu);font-size:13px">No picks — this rail is hidden in the app.</span>';
    return;
  }
  for (var i = 0; i < lpPicks.length; i++) box.appendChild(logPickRow(lpPicks, i, renderLpPicks));
}

function addLpPick() {
  if (lpPicks.length >= LP_MAX_PICKS) return;
  lpPicks.push({a: '', t: 'group', bl: '', c: '', n: ''});
  renderLpPicks();
}

function logPersonRow(arr, i, rerender) {
  var d = arr[i];
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap';

  var pk = document.createElement('input');
  pk.type = 'text'; pk.value = d.p || '';
  pk.placeholder = 'hex pubkey (64 chars)';
  pk.title = 'The 64-character hex pubkey members’ apps resolve to a live profile.';
  pk.style.cssText = 'flex:1;min-width:200px;height:38px;padding:0 11px;font-size:12px;font-family:ui-monospace,monospace';
  pk.oninput = function () { d.p = pk.value.trim(); };

  var role = document.createElement('input');
  role.type = 'text'; role.value = d.r || '';
  role.placeholder = 'keeps the peace';
  role.maxLength = 40;
  role.title = 'Your one-line description of this person’s role, shown beside their name.';
  role.style.cssText = 'width:170px;height:38px;padding:0 11px;font-size:13px';
  role.oninput = function () { d.r = role.value; };

  var name = document.createElement('input');
  name.type = 'text'; name.value = d.n || '';
  name.placeholder = 'Fallback name';
  name.title = 'Shown ONLY if a member’s app cannot see this person’s own display name yet. '
    + 'Otherwise their live name always wins.';
  name.style.cssText = 'width:130px;height:38px;padding:0 11px;font-size:13px';
  name.oninput = function () { d.n = name.value; };

  var up = mkSmallBtn('↑', function () { if (i > 0) { var t = arr[i-1]; arr[i-1] = arr[i]; arr[i] = t; rerender(); } });
  var down = mkSmallBtn('↓', function () { if (i < arr.length-1) { var t = arr[i+1]; arr[i+1] = arr[i]; arr[i] = t; rerender(); } });
  var del = mkSmallBtn('✕', function () { arr.splice(i, 1); rerender(); });
  del.style.color = '#e0867a';

  row.appendChild(pk); row.appendChild(role); row.appendChild(name);
  row.appendChild(up); row.appendChild(down); row.appendChild(del);
  return row;
}

function renderLpPeople() {
  var box = document.getElementById('lp-people-rows');
  box.innerHTML = '';
  if (lpPeople.length === 0) {
    box.innerHTML = '<span style="color:var(--mu);font-size:13px">No one listed — the people rail is hidden in the app.</span>';
    return;
  }
  for (var i = 0; i < lpPeople.length; i++) box.appendChild(logPersonRow(lpPeople, i, renderLpPeople));
}

function addLpPerson() {
  if (lpPeople.length >= LP_MAX_PEOPLE) return;
  lpPeople.push({p: '', r: '', n: ''});
  renderLpPeople();
}

// ── Note avatar gradient controls (lp-grad-*) ────────────────────────────────────
// Compact wire form matches client/src/media/gradient.ts encodeGradient/decodeGradient exactly:
// `<L|R><angle>:<hex>,<hex>[,<hex>]`, angle 0-359 (0 = up, clockwise), 2-3 lowercase hex stops with
// no '#'. Purely cosmetic (like note.g on the server) — never touches the note's `ver`.

/** Enable/disable the type/angle/color controls together, keyed off the "custom gradient" toggle. */
function lpGradControlsEnabled() {
  var on = document.getElementById('lp-grad-on').checked;
  var ids = ['lp-grad-type', 'lp-grad-angle', 'lp-grad-c1', 'lp-grad-c2', 'lp-grad-c3-on', 'lp-grad-c3'];
  for (var i = 0; i < ids.length; i++) document.getElementById(ids[i]).disabled = !on;
}

/** Read the controls into the compact wire form, or '' when "Pick a custom gradient" is unchecked
 *  (⇒ the app falls back to the organizer's live profile gradient). */
function lpGradFromControls() {
  if (!document.getElementById('lp-grad-on').checked) return '';
  var type = document.getElementById('lp-grad-type').value === 'radial' ? 'R' : 'L';
  var angle = Math.max(0, Math.min(359, Math.round(Number(document.getElementById('lp-grad-angle').value)) || 0));
  var stops = [document.getElementById('lp-grad-c1').value, document.getElementById('lp-grad-c2').value];
  if (document.getElementById('lp-grad-c3-on').checked) stops.push(document.getElementById('lp-grad-c3').value);
  stops = stops.map(function (h) { return (h || '').replace('#', '').toLowerCase(); });
  return type + angle + ':' + stops.join(',');
}

/** Parse a saved wire-form gradient back into the controls (loadLogPage), or turn the toggle off
 *  when it's absent/malformed. */
function lpGradToControls(wire) {
  var m = /^([LR])(\d{0,3}):([0-9a-fA-F]{3,6}(?:,[0-9a-fA-F]{3,6}){1,2})$/.exec(wire || '');
  if (m) {
    document.getElementById('lp-grad-on').checked = true;
    var isRadial = m[1] === 'R';
    document.getElementById('lp-grad-type').value = isRadial ? 'radial' : 'linear';
    document.getElementById('lp-grad-angle').value = m[2] ? parseInt(m[2], 10) : (isRadial ? 315 : 135);
    var stops = m[3].split(',');
    // A 3-char hex ("f0a") is legacy shorthand — pad it to 6 by doubling each digit so it's a valid
    // #rrggbb the <input type=color> controls can display.
    var toHex6 = function (h) { return h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h; };
    document.getElementById('lp-grad-c1').value = '#' + toHex6(stops[0]).toLowerCase();
    document.getElementById('lp-grad-c2').value = '#' + toHex6(stops[1]).toLowerCase();
    var hasC3 = stops.length > 2;
    document.getElementById('lp-grad-c3-on').checked = hasC3;
    if (hasC3) document.getElementById('lp-grad-c3').value = '#' + toHex6(stops[2]).toLowerCase();
  } else {
    document.getElementById('lp-grad-on').checked = false;
  }
  lpGradControlsEnabled();
  updateLpGradPreview();
}

/** Paint the 42px preview circle from the controls' current values — linear/radial, matching the
 *  same angle convention (0 = up, clockwise) and radial-focus math the app itself renders with
 *  (client/src/media/gradient.ts radialFocus). */
function updateLpGradPreview() {
  var preview = document.getElementById('lp-grad-preview');
  var angle = parseInt(document.getElementById('lp-grad-angle').value, 10) || 0;
  var stops = [document.getElementById('lp-grad-c1').value, document.getElementById('lp-grad-c2').value];
  if (document.getElementById('lp-grad-c3-on').checked) stops.push(document.getElementById('lp-grad-c3').value);
  if (document.getElementById('lp-grad-type').value === 'radial') {
    var x = (50 + 30 * Math.sin(angle * Math.PI / 180)).toFixed(1);
    var y = (50 - 30 * Math.cos(angle * Math.PI / 180)).toFixed(1);
    preview.style.background = 'radial-gradient(circle at ' + x + '% ' + y + '%, ' + stops.join(', ') + ')';
  } else {
    preview.style.background = 'linear-gradient(' + angle + 'deg, ' + stops.join(', ') + ')';
  }
}

async function loadLogPage() {
  var r = await fetch('/api/log-page');
  var d = await r.json();

  document.getElementById('lp-seeded-note').style.display = d.seeded ? 'block' : 'none';

  var note = d.note || {};
  document.getElementById('lp-note-title').value = note.t || '';
  document.getElementById('lp-note-sub').value = note.s || '';
  document.getElementById('lp-note-body').value = note.b || '';
  document.getElementById('lp-note-sig').value = note.sig || '';
  lpGradToControls(note.g || '');

  var wel = d.welcome || {};
  document.getElementById('lp-wel-title').value = wel.t || '';
  document.getElementById('lp-wel-sub').value = wel.s || '';
  document.getElementById('lp-wel-body').value = wel.b || '';
  document.getElementById('lp-wel-sig').value = wel.sig || '';
  var welDur = Number(wel.dur) || 0;
  if (welDur && welDur % 86400 === 0) {
    document.getElementById('lp-wel-dur-n').value = welDur / 86400;
    document.getElementById('lp-wel-dur-u').value = 'days';
  } else if (welDur) {
    document.getElementById('lp-wel-dur-n').value = Math.max(1, Math.round(welDur / 3600));
    document.getElementById('lp-wel-dur-u').value = 'hours';
  }

  var rules = d.rules || {};
  document.getElementById('lp-rules-eyebrow').value = rules.e || '';
  document.getElementById('lp-rules-body').value = rules.b || '';
  document.getElementById('lp-rules-meta').value = rules.m || '';
  document.getElementById('lp-rules-x').checked = rules.x === true;

  lpPicks = (d.picks || []).map(function (it) {
    return {a: it.a || '', t: it.t || 'channel', bl: it.bl || '', c: it.c || '', n: it.n || '', g: it.g || ''};
  });
  lpPeople = (d.people || []).map(function (it) {
    return {p: it.p || '', r: it.r || '', n: it.n || ''};
  });
  renderLpPicks();
  renderLpPeople();
  renderLpPicker(); // show the "Load from relay" prompt (discover is fetched on demand, not eagerly)

  var copy = d.copy || {};
  document.getElementById('lp-ph').value = copy.ph || '';
  document.getElementById('lp-pph').value = copy.pph || '';
  document.getElementById('lp-dt').value = copy.dt || '';
  document.getElementById('lp-ds').value = copy.ds || '';
  document.getElementById('lp-mo').value = copy.mo || '';
  document.getElementById('lp-rs').value = copy.rs || '';
  document.getElementById('lp-rh').value = copy.rh || '';
  document.getElementById('lp-tk').value = copy.tk || '';
  document.getElementById('lp-ro').value = copy.ro || '';

  document.getElementById('lp-sp').checked = d.sp !== false;
  document.getElementById('lp-au').checked = d.au !== false;
}

function publishLogPage() {
  var body = {
    note: {
      t: document.getElementById('lp-note-title').value,
      s: document.getElementById('lp-note-sub').value,
      b: document.getElementById('lp-note-body').value,
      sig: document.getElementById('lp-note-sig').value,
      g: lpGradFromControls(),
    },
    welcome: {
      t: document.getElementById('lp-wel-title').value,
      s: document.getElementById('lp-wel-sub').value,
      b: document.getElementById('lp-wel-body').value,
      sig: document.getElementById('lp-wel-sig').value,
      durN: document.getElementById('lp-wel-dur-n').value,
      durU: document.getElementById('lp-wel-dur-u').value,
    },
    rules: {
      b: document.getElementById('lp-rules-body').value,
      e: document.getElementById('lp-rules-eyebrow').value,
      m: document.getElementById('lp-rules-meta').value,
      x: document.getElementById('lp-rules-x').checked,
    },
    // Drop blank rows the organizer added but never filled in, so an empty row can't silently
    // become a dead entry in the published page.
    picks: lpPicks.filter(function (d) { return d.a; }),
    people: lpPeople.filter(function (d) { return d.p; }),
    copy: {
      ph: document.getElementById('lp-ph').value,
      pph: document.getElementById('lp-pph').value,
      dt: document.getElementById('lp-dt').value,
      ds: document.getElementById('lp-ds').value,
      mo: document.getElementById('lp-mo').value,
      rs: document.getElementById('lp-rs').value,
      rh: document.getElementById('lp-rh').value,
      tk: document.getElementById('lp-tk').value,
      ro: document.getElementById('lp-ro').value,
    },
    sp: document.getElementById('lp-sp').checked,
    au: document.getElementById('lp-au').checked,
  };
  return publishConfig('/api/log-page', body, 'pub-lp-btn', 'lp-pub', 'lp-err');
}

// ── Log page picker: pull the community's channels + featureable people off the relay ───────────
// Everything rendered here (channel titles, display names) is MEMBER-controlled, so rows are built
// with createElement + textContent only — never innerHTML — the same stored-DOM-XSS guard used by
// the pick/person rows above. Only the fixed, developer-authored strings use innerHTML.
var lpDiscoverData = null; // {channels:[{ref,name,owner,open}], users:[{ref,npub,name,hint}], groups:[{ref,name,gradient,closed,private,broadcast,offered,offerVerified}]} or null

async function loadLpDiscover() {
  var btn = document.getElementById('lp-load-btn');
  var box = document.getElementById('lp-picker');
  var prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Loading…';
  try {
    var r = await fetch('/api/discover');
    var d = await r.json();
    if (d.error) throw new Error(d.error);
    lpDiscoverData = {channels: d.channels || [], users: d.users || [], groups: d.groups || []};
    renderLpPicker();
  } catch (e) {
    box.textContent = 'Could not load from the relay: ' + e.message;
    box.style.color = '#e0867a';
  } finally {
    btn.disabled = false; btn.innerHTML = prev;
  }
}

function pickerItem(glyph, name, sub, alreadyAdded, onAdd) {
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--bdr)';
  var g = document.createElement('span'); g.textContent = glyph;
  g.style.cssText = 'font-size:16px;width:22px;text-align:center;flex:none';
  var mid = document.createElement('div'); mid.style.cssText = 'flex:1;min-width:0';
  var nm = document.createElement('div'); nm.textContent = name;
  nm.style.cssText = 'font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  var sb = document.createElement('div'); sb.textContent = sub;
  sb.style.cssText = 'font-size:11px;color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  mid.appendChild(nm); mid.appendChild(sb);
  var add = document.createElement('button');
  add.className = 'btn sm'; add.style.cssText = 'min-width:64px;flex:none';
  if (alreadyAdded) { add.textContent = '✓ Added'; add.disabled = true; }
  else { add.textContent = '＋ Add'; add.onclick = onAdd; }
  row.appendChild(g); row.appendChild(mid); row.appendChild(add);
  return row;
}

function renderLpPicker() {
  var box = document.getElementById('lp-picker');
  box.style.color = '';
  box.innerHTML = '';
  if (!lpDiscoverData) {
    box.innerHTML = '<span style="color:var(--mu);font-size:13px">Click “Load from relay” to list your channels, groups, and people.</span>';
    return;
  }
  var q = (document.getElementById('lp-search').value || '').trim().toLowerCase();
  var havePicks = {}; lpPicks.forEach(function (d) { havePicks[d.a] = true; });
  var havePeople = {}; lpPeople.forEach(function (d) { havePeople[d.p] = true; });
  var matches = function (s) { return !q || String(s || '').toLowerCase().indexOf(q) >= 0; };
  var any = false;

  var channels = lpDiscoverData.channels.filter(function (c) { return matches(c.name) || matches(c.ref); });
  if (channels.length) {
    any = true;
    var h1 = document.createElement('div'); h1.textContent = 'CHANNELS';
    h1.style.cssText = 'font-size:11px;letter-spacing:.06em;color:var(--mu);margin:6px 0 2px';
    box.appendChild(h1);
    channels.forEach(function (c) {
      box.appendChild(pickerItem(c.open ? '🌐' : '📢', c.name, c.ref, !!havePicks[c.ref],
        function () { addLpPickFromPicker(c.ref, c.name, c.gradient); }));
    });
  }

  // Groups split into two rails. Plain (non-private) groups list as before. PRIVATE groups reach the
  // picker ONLY when their owner has published a live "log offer" (the server drops unoffered private
  // groups), so they get their own OFFERED PRIVATE SPACES heading. A degraded offer whose ownership
  // couldn't be verified (offerVerified === false) carries an inline "unverified owner" caveat.
  var allGroups = lpDiscoverData.groups.filter(function (g) { return matches(g.name) || matches(g.ref); });
  var openGroups = allGroups.filter(function (g) { return !g.private; });
  var privateGroups = allGroups.filter(function (g) { return g.private; });

  var addGroupRow = function (g, extraSub) {
    // Precedence private > closed > broadcast, else a plain open group — matches the chip the
    // app itself would derive live, so a picked-but-unsynced group still shows the right label.
    var flavorLabel = g.private ? 'Private' : g.closed ? 'Closed' : g.broadcast ? 'Broadcast' : 'Open';
    var glyph = g.private ? '🕶️' : g.closed ? '🔒' : g.broadcast ? '📣' : '👥';
    var chip = flavorLabel === 'Open' ? '' : flavorLabel;
    var sub = flavorLabel + ' group · ' + g.ref + (extraSub || '');
    box.appendChild(pickerItem(glyph, g.name, sub, !!havePicks[g.ref],
      function () { addLpGroupFromPicker(g.ref, g.name, g.gradient, chip); }));
  };

  if (openGroups.length) {
    any = true;
    var hg = document.createElement('div'); hg.textContent = 'GROUPS';
    hg.style.cssText = 'font-size:11px;letter-spacing:.06em;color:var(--mu);margin:10px 0 2px';
    box.appendChild(hg);
    openGroups.forEach(function (g) { addGroupRow(g, ''); });
  }

  if (privateGroups.length) {
    any = true;
    var hp = document.createElement('div'); hp.textContent = 'OFFERED PRIVATE SPACES';
    hp.style.cssText = 'font-size:11px;letter-spacing:.06em;color:var(--mu);margin:10px 0 2px';
    box.appendChild(hp);
    privateGroups.forEach(function (g) {
      addGroupRow(g, g.offerVerified === false ? ' · ⚠️ unverified owner' : '');
    });
  }

  var users = lpDiscoverData.users.filter(function (u) { return matches(u.name) || matches(u.hint) || matches(u.npub); });
  if (users.length) {
    any = true;
    var h2 = document.createElement('div'); h2.textContent = 'PEOPLE';
    h2.style.cssText = 'font-size:11px;letter-spacing:.06em;color:var(--mu);margin:10px 0 2px';
    box.appendChild(h2);
    users.forEach(function (u) {
      var label = u.name || (u.npub ? u.npub.slice(0, 16) + '…' : u.ref.slice(0, 12));
      var sub = (u.hint ? u.hint + ' · ' : '') + (u.npub || u.ref);
      box.appendChild(pickerItem('👤', label, sub, !!havePeople[u.ref],
        function () { addLpPersonFromPicker(u.ref, u.name); }));
    });
  }

  if (!any) box.innerHTML = '<span style="color:var(--mu);font-size:13px">Nothing matches your filter.</span>';
}

function addLpPickFromPicker(a, n, g) {
  if (!a) return;
  if (lpPicks.some(function (d) { return d.a === a; })) return; // already picked
  if (lpPicks.length >= LP_MAX_PICKS) return; // cap mirrors the server + client
  // Carry the channel's name + gradient so a picked-but-unsynced channel still paints its real
  // name/gradient in the app before the member's own copy of it arrives.
  lpPicks.push({a: a, t: 'channel', bl: '', c: '', n: n || '', g: g || ''});
  renderLpPicks();
  renderLpPicker(); // reflect the new "✓ Added" state
}

function addLpGroupFromPicker(a, n, g, c) {
  if (!a) return;
  if (lpPicks.some(function (d) { return d.a === a; })) return; // already picked
  if (lpPicks.length >= LP_MAX_PICKS) return; // cap mirrors the server + client
  // The chip `c` is what labels the pick correctly on NON-member devices, which cannot resolve a
  // private group's flavor live — so we bake in the flavor we just read off the scoped 39000 lookup.
  lpPicks.push({a: a, t: 'group', bl: '', c: c || '', n: n || '', g: g || ''});
  renderLpPicks();
  renderLpPicker(); // reflect the new "✓ Added" state
}

function addLpPersonFromPicker(p, n) {
  if (!p) return;
  if (lpPeople.some(function (d) { return d.p === p; })) return; // already listed
  if (lpPeople.length >= LP_MAX_PEOPLE) return; // cap mirrors the server + client
  lpPeople.push({p: p, r: '', n: n || ''});
  renderLpPeople();
  renderLpPicker(); // reflect the new "✓ Added" state
}

// Per-post-type rules
async function loadPostRules() {
  var r = await fetch('/api/post-rules');
  var d = await r.json();
  var p = d.postRules || {}, note = p.note || {}, article = p.article || {};
  document.getElementById('pr-note-min').value = note.min || 0;
  document.getElementById('pr-note-max').value = note.max || 0;
  document.getElementById('pr-note-media').value = (note.mediaMax === undefined ? 1 : note.mediaMax);
  document.getElementById('pr-note-lbl').checked = note.labelRequired === true;
  document.getElementById('pr-article-min').value = article.min || 0;
  document.getElementById('pr-article-max').value = article.max || 0;
  document.getElementById('pr-article-media').value = (article.mediaMax === undefined ? 8 : article.mediaMax);
  document.getElementById('pr-article-lbl').checked = article.labelRequired === true;
  document.getElementById('pr-authornote-max').value = (p.authorNoteMax === undefined ? 280 : p.authorNoteMax);
}

function publishPostRules() {
  var body = {
    note: {
      min: numOr0(document.getElementById('pr-note-min').value),
      max: numOr0(document.getElementById('pr-note-max').value),
      mediaMax: numOr0(document.getElementById('pr-note-media').value),
      labelRequired: document.getElementById('pr-note-lbl').checked,
    },
    article: {
      min: numOr0(document.getElementById('pr-article-min').value),
      max: numOr0(document.getElementById('pr-article-max').value),
      mediaMax: numOr0(document.getElementById('pr-article-media').value),
      labelRequired: document.getElementById('pr-article-lbl').checked,
    },
    authorNoteMax: numOr0(document.getElementById('pr-authornote-max').value),
  };
  return publishConfig('/api/post-rules', body, 'pub-postrules-btn', 'postrules-pub', 'postrules-err');
}

async function loadPictureRules() {
  var r = await fetch('/api/picture-rules');
  var d = await r.json();
  var p = d.pictureRules || {};
  document.getElementById('pic-allow').checked = p.allow !== false;
  document.getElementById('pic-allowance-kb').value = Math.round((p.allowanceBytes === undefined ? 131072 : p.allowanceBytes) / 1024);
  document.getElementById('pic-period-hours').value = (p.periodHours === undefined ? 24 : p.periodHours);
  document.getElementById('pic-maxbytes-kb').value = Math.round((p.maxBytesPerPicture === undefined ? 49152 : p.maxBytesPerPicture) / 1024);
  document.getElementById('pic-maxres').value = (p.maxRes === undefined ? 256 : p.maxRes);
  document.getElementById('pic-maxcolours').value = (p.maxColours === undefined ? 64 : p.maxColours);
}

function publishPictureRules() {
  var body = {
    allow: document.getElementById('pic-allow').checked,
    allowanceBytes: numOr0(document.getElementById('pic-allowance-kb').value) * 1024,
    periodHours: numOr0(document.getElementById('pic-period-hours').value),
    maxBytesPerPicture: numOr0(document.getElementById('pic-maxbytes-kb').value) * 1024,
    maxRes: numOr0(document.getElementById('pic-maxres').value),
    maxColours: numOr0(document.getElementById('pic-maxcolours').value),
  };
  return publishConfig('/api/picture-rules', body, 'pub-pictures-btn', 'pictures-pub', 'pictures-err');
}

async function loadAudioRules() {
  var r = await fetch('/api/audio-rules');
  var d = await r.json();
  var a = d.audioRules || {};
  document.getElementById('aud-allow').checked = a.allow !== false;
  document.getElementById('aud-allowance-kb').value = Math.round((a.allowanceBytes === undefined ? 1048576 : a.allowanceBytes) / 1024);
  document.getElementById('aud-period-hours').value = (a.periodHours === undefined ? 24 : a.periodHours);
  document.getElementById('aud-maxbytes-kb').value = Math.round((a.maxBytesPerClip === undefined ? 204800 : a.maxBytesPerClip) / 1024);
  document.getElementById('aud-maxdur-sec').value = (a.maxDurationSec === undefined ? 60 : a.maxDurationSec);
  document.getElementById('aud-bitrate').value = (a.bitrateKbps === undefined ? 24 : a.bitrateKbps);
  document.getElementById('aud-samplerate').value = (a.sampleRateHz === undefined ? 24000 : a.sampleRateHz);
}

function publishAudioRules() {
  var body = {
    allow: document.getElementById('aud-allow').checked,
    allowanceBytes: numOr0(document.getElementById('aud-allowance-kb').value) * 1024,
    periodHours: numOr0(document.getElementById('aud-period-hours').value),
    maxBytesPerClip: numOr0(document.getElementById('aud-maxbytes-kb').value) * 1024,
    maxDurationSec: numOr0(document.getElementById('aud-maxdur-sec').value),
    bitrateKbps: numOr0(document.getElementById('aud-bitrate').value),
    sampleRateHz: numOr0(document.getElementById('aud-samplerate').value),
  };
  return publishConfig('/api/audio-rules', body, 'pub-audio-btn', 'audio-pub', 'audio-err');
}

// Read access (censorable reads): revoke/reinstate a member's READING by npub. Purely organizer-side.
async function loadReadAccess() {
  var errEl = document.getElementById('readaccess-err'); if (errEl) errEl.style.display = 'none';
  var r = await fetch('/api/read-access');
  var d = await r.json();
  document.getElementById('readaccess-status').textContent = d.readAuth
    ? '● Read-auth enforcement is ON — revoked members cannot draw read tokens.'
    : '○ Read-auth enforcement is OFF (set STIQ_READ_AUTH=1 to enable). Revocations are saved and take effect once enabled + content is sealed.';
  var list = document.getElementById('readaccess-list');
  var revoked = d.revoked || [];
  if (!revoked.length) { list.innerHTML = '<span class="sub">No members are read-revoked.</span>'; return; }
  list.innerHTML = revoked.map(function(pk) {
    return '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">'
      + '<code style="font-size:11px;word-break:break-all">' + pk + '</code>'
      + '<button class="btn" onclick="reinstateRead(\'' + pk + '\')">Reinstate</button></div>';
  }).join('');
}
function revokeRead() {
  var npub = document.getElementById('readaccess-npub').value.trim();
  if (npub) postReadAccess(npub, true);
}
function reinstateRead(pk) { postReadAccess(pk, false); }
async function postReadAccess(npub, revoked) {
  var errEl = document.getElementById('readaccess-err');
  try {
    var r = await fetch('/api/read-access', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({npub: npub, revoked: revoked}),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'request failed');
    document.getElementById('readaccess-npub').value = '';
    loadReadAccess();
  } catch (e) {
    if (errEl) { errEl.textContent = String(e.message || e); errEl.style.display = 'block'; }
  }
}

// Token & sealing activation (tokens-everywhere): flip the relay-side feature flags live.
async function loadActivation() {
  var okEl = document.getElementById('activation-ok'); if (okEl) okEl.style.display = 'none';
  var errEl = document.getElementById('activation-err'); if (errEl) errEl.style.display = 'none';
  var unavail = document.getElementById('activation-unavailable');
  var r = await fetch('/api/activation');
  var d = await r.json();
  var space = document.getElementById('act-space');
  var media = document.getElementById('act-media');
  var ce = document.getElementById('act-ce');

  // Fleet key-sync status (T1.6, fixes F8): publishTokenKeys() broadcasts every purpose key at
  // startup and on each flip below; this reflects whether that broadcast actually reached the relay
  // (retried with backoff) rather than assuming a fire-and-forget publish landed. Independent of the
  // relay-config readable/writable gate below, so render it even on the early-return path.
  var tkNote = document.getElementById('act-tokenkeys-note');
  if (tkNote) {
    var tk = d.tokenKeysPublish || {};
    if (!d.domainSeparation) {
      tkNote.textContent = '○ Domain separation is off — every purpose key already equals the enrollment key, so there is nothing to broadcast.';
    } else if (!tk.attempted) {
      tkNote.textContent = '… publishing this run — reload this tab in a few seconds to see the result.';
    } else if (tk.ok) {
      tkNote.textContent = '● Broadcast confirmed by the relay (' + tk.attempts + ' attempt' + (tk.attempts === 1 ? '' : 's') + ').';
    } else {
      tkNote.textContent = '⚠ Broadcast FAILED after ' + tk.attempts + ' attempt' + (tk.attempts === 1 ? '' : 's') + ': ' + tk.message + ' — flip a switch below or restart the organizer to retry.';
    }
  }

  // If the dashboard can't read/write the relay config (e.g. a dev box), disable every toggle.
  if (!d.configReadable || !d.configWritable) {
    unavail.textContent = !d.configReadable
      ? 'Can’t read the relay config on this box, so these switches are unavailable here.'
      : 'The relay config is read-only for this box, so these switches are unavailable here.';
    unavail.style.display = 'block';
    space.disabled = media.disabled = ce.disabled = true;
    return;
  }
  unavail.style.display = 'none';

  // Space tokens — needs the space-write verify key deployed on the relay.
  space.checked = !!d.spaceTokens.enabled;
  space.disabled = !d.spaceTokens.keyPresent && !d.spaceTokens.enabled;
  document.getElementById('act-space-note').textContent = d.spaceTokens.keyPresent
    ? (d.spaceTokens.enabled ? '● ON — members must attach a space token to channel/group/DM writes.' : '○ OFF — channels/groups/DMs post without a token, as today.')
    : '⚠ The relay has no space-write key yet — redeploy the relay with space keys before enabling.';

  // Media token domains — needs at least one media write key deployed.
  var mediaKey = d.mediaTokens.pictureKeyPresent || d.mediaTokens.audioKeyPresent;
  media.checked = !!d.mediaTokens.enabled;
  media.disabled = !mediaKey && !d.mediaTokens.enabled;
  document.getElementById('act-media-note').textContent = mediaKey
    ? (d.mediaTokens.enabled ? '● ON — updated apps meter pictures/audio on their own budgets.' : '○ OFF — media pays from the normal post budget.')
    : '⚠ The relay has no picture/audio write keys yet — redeploy the relay with media keys before enabling.';

  // Content encryption — needs token domain separation so read tokens are drawn under K_read.
  ce.checked = !!d.contentEncryption.enabled;
  ce.disabled = !d.domainSeparation && !d.contentEncryption.enabled;
  // Mirror reminder (T5.2): the flip writes THIS relay's config; each attached mirror keeps
  // advertising its bundle until re-attached. Sealing itself follows the primary (a lagging
  // mirror can't unseal anyone) — this is an advertisement-consistency chore, not a leak.
  var ceMirrors = d.mirrorCount > 0
    ? ' ⚠ ' + d.mirrorCount + ' mirror relay' + (d.mirrorCount === 1 ? '' : 's') + ' attached: after changing this, re-run --export-mirror-bundle on this box and --attach on each mirror so they advertise the same enforcement.'
    : '';
  document.getElementById('act-ce-note').textContent = (d.domainSeparation
    ? (d.contentEncryption.enabled ? '● ON — bodies are sealed; revoke a reader under Read access.' : '○ OFF — bodies post in the clear, as today.')
    : '⚠ Needs token domain separation (STIQ_TOKEN_DOMAIN_SEP=1) before enabling.') + ceMirrors;
}

async function toggleActivation(field, checked) {
  var okEl = document.getElementById('activation-ok');
  var errEl = document.getElementById('activation-err');
  okEl.style.display = 'none'; errEl.style.display = 'none';
  // Confirm the one-way, member-breaking flips before turning them ON.
  if (checked && (field === 'spaceTokens' || field === 'contentEncryption')) {
    var what = field === 'spaceTokens' ? 'require space tokens on channels/groups/DMs' : 'seal post bodies';
    if (!confirm('Enable this now? Members whose app has NOT updated will break (they can’t ' + (field === 'spaceTokens' ? 'attach the token' : 'decrypt sealed bodies') + '). Only proceed if your members have updated.\n\nThis will ' + what + ' community-wide.')) {
      reloadTab('activation'); // revert the checkbox to the true state
      return;
    }
  }
  var body = {}; body[field] = checked;
  try {
    var r = await fetch('/api/activation', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'request failed');
    okEl.textContent = 'Saved — relay ' + (d.reloaded ? 'reloaded live.' : 'will apply on its next restart.');
    okEl.style.display = 'block';
    reloadTab('activation');
    // The token-keys re-broadcast this flip triggers (T1.6) retries with backoff in the background
    // and hadn't necessarily landed by the time the response above returned — re-poll a couple of
    // times so the "Fleet key-sync" status line updates without the operator leaving and reopening
    // this tab.
    setTimeout(function () { reloadTab('activation'); }, 3000);
    setTimeout(function () { reloadTab('activation'); }, 9000);
  } catch (e) {
    errEl.textContent = String(e.message || e);
    errEl.style.display = 'block';
    reloadTab('activation'); // revert the checkbox to the true state
  }
}

// Reason buckets
var reasonDefs = [];

function renderReasonRows() {
  var box = document.getElementById('reason-rows');
  box.innerHTML = '';
  if (reasonDefs.length === 0) {
    box.innerHTML = '<span style="color:var(--mu);font-size:13px">No reason buckets yet.</span>';
    return;
  }
  for (var i = 0; i < reasonDefs.length; i++) box.appendChild(namedColorRow(reasonDefs, i, renderReasonRows));
}

function addReason() { reasonDefs.push({ id: '', name: 'New reason', color: '#c77b7b' }); renderReasonRows(); }

async function loadReasons() {
  var r = await fetch('/api/reasons');
  var d = await r.json();
  reasonDefs = (d.buckets || []).map(function (b) { return { id: b.id, name: b.name, color: b.color }; });
  document.getElementById('reason-threshold').value = d.reportThreshold || 0;
  renderReasonRows();
}

function publishReasons() {
  var threshold = parseInt(document.getElementById('reason-threshold').value, 10) || 0;
  return publishConfig('/api/reasons', { buckets: reasonDefs, reportThreshold: threshold }, 'pub-reasons-btn', 'reasons-pub', 'reasons-err');
}

// ── Permissions: per-moderator action scopes (kind-30078) ────────────────────────

var PERM_SCOPES = ['hide-post', 'hide-comment', 'ban', 'retag', 'pin', 'lock', 'restore'];
// State keyed by npub (plus '_def' for the unlisted-mod default), mirroring the server's friendly shape.
var permState = { def: [], mods: {} };
var permMods = [];

// One scope-checkbox row. key is an npub or '_def'; scopes is the current array for that key.
function permRow(label, sublabel, key, scopes) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid var(--bdr);border-radius:8px;padding:12px;margin-bottom:10px';

  var head = document.createElement('div');
  head.style.cssText = 'font-size:13px;margin-bottom:8px';
  head.innerHTML = '<strong>' + esc(label) + '</strong>'
    + (sublabel ? '<span style="display:block;color:var(--mu);font-size:11px;font-family:var(--mono)">' + esc(sublabel) + '</span>' : '');
  wrap.appendChild(head);

  var grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px 16px';
  for (var i = 0; i < PERM_SCOPES.length; i++) {
    (function (scope) {
      var lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;font-size:12px;color:var(--tx)';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'width:15px;height:15px;accent-color:var(--acc)';
      cb.checked = scopes.indexOf(scope) !== -1;
      cb.onchange = function () {
        var idx = scopes.indexOf(scope);
        if (cb.checked && idx === -1) scopes.push(scope);
        else if (!cb.checked && idx !== -1) scopes.splice(idx, 1);
      };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(scope));
      grid.appendChild(lab);
    })(PERM_SCOPES[i]);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderPermRows() {
  var box = document.getElementById('perm-rows');
  box.innerHTML = '';
  box.appendChild(permRow('Default (unlisted moderators)', 'applies to any moderator without an explicit row below', '_def', permState.def));
  if (permMods.length === 0) {
    var none = document.createElement('div');
    none.style.cssText = 'color:var(--mu);font-size:13px;margin-top:6px';
    none.textContent = 'No moderators yet — add them in the Moderators tab.';
    box.appendChild(none);
    return;
  }
  for (var i = 0; i < permMods.length; i++) {
    var n = permMods[i];
    if (!permState.mods[n]) permState.mods[n] = [];
    box.appendChild(permRow(n.slice(0, 12) + '…' + n.slice(-6), n, n, permState.mods[n]));
  }
}

async function loadPermissions() {
  // Roster drives which per-moderator rows we show; saved scopes seed the checkboxes.
  var rm = await fetch('/api/moderators');
  var rd = await rm.json();
  permMods = rd.moderators || [];
  var r = await fetch('/api/permissions');
  var d = await r.json();
  permState = { def: d.def || [], mods: d.mods || {} };
  renderPermRows();
}

function publishPermissions() {
  // Only send scopes for current roster members (drop stale npubs) plus the default row.
  var mods = {};
  for (var i = 0; i < permMods.length; i++) {
    var n = permMods[i];
    mods[n] = permState.mods[n] || [];
  }
  return publishConfig('/api/permissions', { def: permState.def, mods: mods }, 'pub-perms-btn', 'perms-pub', 'perms-err');
}

// ── Mod limits: caps on a moderator's own actions (kind-30078) ────────────────────

var ML_ACTIONS = ['hide', 'ban', 'restore', 'lock', 'unlock', 'retag', 'pin', 'unpin'];

async function loadModLimits() {
  var r = await fetch('/api/mod-limits');
  var d = await r.json();
  var l = d.modLimits || {};
  for (var i = 0; i < ML_ACTIONS.length; i++) {
    var a = ML_ACTIONS[i], row = l[a] || {};
    document.getElementById('ml-' + a + '-d').value = row.d || 0;
    document.getElementById('ml-' + a + '-w').value = row.w || 0;
  }
}

function publishModLimits() {
  var body = {};
  for (var i = 0; i < ML_ACTIONS.length; i++) {
    var a = ML_ACTIONS[i];
    body[a] = {
      d: numOr0(document.getElementById('ml-' + a + '-d').value),
      w: numOr0(document.getElementById('ml-' + a + '-w').value),
    };
  }
  return publishConfig('/api/mod-limits', body, 'pub-modlimits-btn', 'modlimits-pub', 'modlimits-err');
}

// ── Governance: newcomer restrictions + channel-creation policy (kind-30078) ──────

async function loadGov() {
  var r = await fetch('/api/gov');
  var d = await r.json();
  document.getElementById('gov-ncd').value = d.ncd || 0;
  document.getElementById('gov-nl').checked = d.nl === true;
  document.getElementById('gov-nc').checked = d.nc === true;
  document.getElementById('gov-cc').value = (d.cc === 'mods' || d.cc === 'org') ? d.cc : 'any';
}

function publishGov() {
  var body = {
    ncd: numOr0(document.getElementById('gov-ncd').value),
    nl: document.getElementById('gov-nl').checked,
    nc: document.getElementById('gov-nc').checked,
    cc: document.getElementById('gov-cc').value,
  };
  return publishConfig('/api/gov', body, 'pub-gov-btn', 'gov-pub', 'gov-err');
}

// ── Community: identity + posting/announcement settings (kind-30078) ──────────────

async function loadCommunity() {
  var r = await fetch('/api/community');
  var d = await r.json();
  document.getElementById('cc-nm').value = d.nm || '';
  document.getElementById('cc-desc').value = d.desc || '';
  document.getElementById('cc-icn').value = d.icn || '';
  document.getElementById('cc-acc').value = /^#[0-9a-fA-F]{6}$/.test(d.acc) ? d.acc : '#8a8f98';
  document.getElementById('cc-dv').value = (d.dv === 'topics' || d.dv === 'conversation') ? d.dv : 'list';
  document.getElementById('cc-ew').value = d.ew || 0;
  document.getElementById('cc-ae').checked = d.ae !== false;
  document.getElementById('cc-ad').checked = d.ad !== false;
  var ann = d.ann || {};
  document.getElementById('cc-ann-t').value = ann.t || '';
  document.getElementById('cc-ann-u').value = unixToLocalInput(ann.u);
}

// The announcement banner's optional auto-hide is stored as unix SECONDS (0 = never). The dashboard
// edits it with a <input type="datetime-local"> so an organizer can't accidentally enter a raw 1970
// timestamp (a tiny number like "3") that would bury the banner forever.
function localInputToUnix(v) {
  if (!v) return 0;                                    // blank ⇒ never expire
  var ms = new Date(v).getTime();                      // datetime-local has no tz ⇒ parsed as LOCAL
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
function unixToLocalInput(sec) {
  var n = Number(sec) || 0;
  if (n < 1000000000) return '';                       // 0 or a legacy mis-entry ⇒ show blank (never)
  var d = new Date(n * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); // shift so the ISO slice is LOCAL
  return local.toISOString().slice(0, 16);             // "YYYY-MM-DDTHH:MM"
}

function publishCommunity() {
  var body = {
    nm: document.getElementById('cc-nm').value,
    desc: document.getElementById('cc-desc').value,
    icn: document.getElementById('cc-icn').value,
    acc: document.getElementById('cc-acc').value,
    dv: document.getElementById('cc-dv').value,
    ew: numOr0(document.getElementById('cc-ew').value),
    ae: document.getElementById('cc-ae').checked,
    ad: document.getElementById('cc-ad').checked,
    ann: {
      t: document.getElementById('cc-ann-t').value,
      u: localInputToUnix(document.getElementById('cc-ann-u').value),
    },
  };
  return publishConfig('/api/community', body, 'pub-community-btn', 'community-pub', 'community-err');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Rising ranking ──────────────────────────────────────────────────────────────
// The server re-sanitizes every field (sanitizeRanking) and GET /api/ranking already returns the
// effective values with defaults filled in, so the loader seeds the inputs straight from it and the
// publisher posts the raw values. Keys are the compact wire — see DEFAULT_RANKING_CFG.

var RANK_FIELDS = [
  ['rank-tw', 'tw', 1, false], ['rank-thl', 'thl', 6, true],
  ['rank-vw', 'vw', 1, false], ['rank-hl', 'hl', 3.85, true],
  ['rank-cw', 'cw', 0, false], ['rank-chl', 'chl', 6, true],
  ['rank-sw', 'sw', 0.1, false],
  ['rank-lw', 'lw', 0, false],
  ['rank-ty-n', 'ty.n', 1, false], ['rank-ty-a', 'ty.a', 1, false],
];

async function loadRanking() {
  var r = await fetch('/api/ranking');
  var d = await r.json();
  var rk = d.ranking || {};
  var ty = rk.ty || {};
  for (var i = 0; i < RANK_FIELDS.length; i++) {
    var f = RANK_FIELDS[i];
    var v = f[1] === 'ty.n' ? ty.n : f[1] === 'ty.a' ? ty.a : rk[f[1]];
    document.getElementById(f[0]).value = v != null ? v : f[2];
  }
  renderRankPreview();
}

/** Read a weight input; blank/garbage/negative falls back to `dflt`. Server re-checks regardless. */
function rankVal(id, dflt, positiveOnly) {
  var n = parseFloat(document.getElementById(id).value);
  if (isNaN(n) || n < 0 || (positiveOnly && n <= 0)) return dflt;
  return n;
}

/** The current form state, in the exact compact wire shape the client parses. */
function rankBody() {
  var b = {};
  for (var i = 0; i < RANK_FIELDS.length; i++) {
    var f = RANK_FIELDS[i];
    var v = rankVal(f[0], f[2], f[3]);
    if (f[1] === 'ty.n') { b.ty = b.ty || {}; b.ty.n = v; }
    else if (f[1] === 'ty.a') { b.ty = b.ty || {}; b.ty.a = v; }
    else b[f[1]] = v;
  }
  return b;
}

function publishRanking() {
  return publishConfig('/api/ranking', rankBody(), 'pub-ranking-btn', 'ranking-pub', 'ranking-err');
}

// ── Live preview ────────────────────────────────────────────────────────────────
// MIRROR of risingScore() in client/src/feed/sort.ts — kept deliberately literal so the two read
// the same. It exists because nine weights are untunable blind: the organizer needs to SEE that
// (say) doubling cw reorders the feed. Preview-only; if it ever drifts, the preview misleads but
// the feed is unaffected (the client is the only thing that actually ranks). Pinned by
// issuer/ranking_preview_test.mjs against values taken from the TS model.

var HOUR = 3600;
function rankDecay(deltaSec, halfLifeHours) {   // symmetric: future decays like past
  return Math.exp((-Math.LN2 / (halfLifeHours * HOUR)) * Math.abs(deltaSec));
}
function rankVelocity(ages, halfLifeHours) {    // ages = seconds-ago per event
  var s = 0;
  for (var i = 0; i < ages.length; i++) s += rankDecay(ages[i], halfLifeHours);
  return s;
}

/**
 * Representative posts, described the way an organizer thinks about them. `ageH` = hours old,
 * `voteAgesH`/`commenterAgesH` = hours since each upvote / each distinct commenter's last comment.
 */
var RANK_SAMPLES = [
  {name: 'Brand-new note, no votes yet', kind: 'n', ageH: 0.05, words: 20, score: 0, voteAgesH: [], commenterAgesH: []},
  {name: 'Note picking up votes right now', kind: 'n', ageH: 1, words: 30, score: 8, voteAgesH: [0.2, 0.3, 0.5, 0.6, 0.9, 1, 1, 1], commenterAgesH: []},
  {name: 'Note everyone is arguing about', kind: 'n', ageH: 3, words: 25, score: 6, voteAgesH: [1, 2, 2, 3, 3, 3], commenterAgesH: [0.1, 0.2, 0.4, 0.8, 1.5, 2, 2.5]},
  {name: 'Brand-new long article, no votes', kind: 'a', ageH: 0.05, words: 900, score: 0, voteAgesH: [], commenterAgesH: []},
  {name: 'Article with a real discussion', kind: 'a', ageH: 5, words: 1200, score: 12, voteAgesH: [1, 2, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5], commenterAgesH: [0.5, 1, 2, 3, 4]},
  {name: "Yesterday's biggest note (dead now)", kind: 'n', ageH: 26, words: 40, score: 80, voteAgesH: new Array(80).fill(25), commenterAgesH: new Array(20).fill(25)},
];

/** Per-signal contributions for one sample under weights `c`. Mirrors sort.ts risingScore. */
function rankScore(s, c) {
  var time = c.tw * rankDecay(s.ageH * HOUR, c.thl);
  var votes = c.vw * Math.log(1 + rankVelocity(s.voteAgesH.map(h => h * HOUR), c.hl));
  var comments = c.cw * Math.log(1 + rankVelocity(s.commenterAgesH.map(h => h * HOUR), c.chl));
  var score = c.sw * Math.log(1 + Math.max(0, s.score));
  var engagement = time + votes + comments + score;
  var typeW = s.kind === 'a' ? c.ty.a : c.ty.n;
  var lengthBoost = c.lw === 0 ? 1 : 1 + c.lw * Math.log(1 + s.words);
  return {
    time: time, votes: votes, comments: comments, score: score,
    total: engagement * typeW * lengthBoost,
    mult: typeW * lengthBoost,
  };
}

var RANK_BARS = [
  ['time', '#4a90d9', 'Time'], ['votes', '#59a14f', 'Votes'],
  ['comments', '#e8a33d', 'Comments'], ['score', '#9b6bcc', 'Score'],
];

function renderRankPreview() {
  var el = document.getElementById('rank-preview');
  if (!el) return;
  var c = rankBody();
  var rows = RANK_SAMPLES.map(function (s) { return {s: s, r: rankScore(s, c)}; });
  rows.sort(function (a, b) { return b.r.total - a.r.total; });
  var max = rows.length ? rows[0].r.total : 0;
  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var s = rows[i].s, r = rows[i].r;
    var pct = max > 0 ? (r.total / max) * 100 : 0;
    // Stacked bar: each signal's share of THIS post's engagement, scaled by its total vs the winner.
    var seg = '';
    for (var j = 0; j < RANK_BARS.length; j++) {
      var key = RANK_BARS[j][0];
      var share = r.total > 0 ? (r[key] * r.mult / max) * 100 : 0;
      if (share > 0.15) seg += '<span style="display:inline-block;height:100%;width:' + share.toFixed(2) + '%;background:' + RANK_BARS[j][1] + '"></span>';
    }
    html += '<div style="margin-bottom:9px">'
      + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">'
      + '<span style="color:var(--tx)">' + (i + 1) + '. ' + s.name + (s.kind === 'a' ? ' <span style="color:var(--mu);font-size:10px">ARTICLE</span>' : '') + '</span>'
      + '<span style="color:var(--mu);font-family:var(--mono);font-size:11px">' + r.total.toFixed(2) + '</span></div>'
      + '<div style="height:9px;background:var(--bg);border-radius:2px;overflow:hidden;white-space:nowrap;width:' + Math.max(pct, 0.5).toFixed(2) + '%">' + seg + '</div>'
      + '</div>';
  }
  var legend = '';
  for (var k = 0; k < RANK_BARS.length; k++) {
    legend += '<span style="margin-right:12px"><span style="display:inline-block;width:8px;height:8px;background:' + RANK_BARS[k][1] + ';border-radius:2px;margin-right:4px"></span>' + RANK_BARS[k][2] + '</span>';
  }
  el.innerHTML = html + '<div style="margin-top:10px;font-size:11px;color:var(--mu)">' + legend + '</div>';
}

/** Re-render the preview as the organizer types, before anything is published. */
function wireRankPreview() {
  for (var i = 0; i < RANK_FIELDS.length; i++) {
    var input = document.getElementById(RANK_FIELDS[i][0]);
    if (input) input.addEventListener('input', renderRankPreview);
  }
}

// ── Storage / retention (SQLite compaction caps) ─────────────────────────────────
// The server re-sanitizes every field; the UI just seeds the inputs from the current policy and
// posts the raw values. GET /api/storage returns the {reactionCap,timelineCap,maxAgeDays,
// collapseReplaceable} object directly (no wrapper).

async function loadStorage() {
  var s = await (await fetch('/api/storage')).json();
  document.getElementById('sto-rc').value = s.reactionCap != null ? s.reactionCap : 8000;
  document.getElementById('sto-tc').value = s.timelineCap != null ? s.timelineCap : 3000;
  document.getElementById('sto-ma').value = s.maxAgeDays != null ? s.maxAgeDays : 0;
  document.getElementById('sto-cr').checked = s.collapseReplaceable !== false;
}

function publishStorage() {
  var body = {
    reactionCap: parseInt(document.getElementById('sto-rc').value, 10),
    timelineCap: parseInt(document.getElementById('sto-tc').value, 10),
    maxAgeDays: parseInt(document.getElementById('sto-ma').value, 10),
    collapseReplaceable: document.getElementById('sto-cr').checked,
  };
  return publishConfig('/api/storage', body, 'pub-storage-btn', 'storage-pub', 'storage-err');
}

// ── Posting tokens (blind-posting quota) ─────────────────────────────────────────

async function loadTokens() {
  var r = await fetch('/api/token-policy');
  var d = await r.json();
  document.getElementById('tok-per-epoch').value = d.tokensPerEpoch != null ? d.tokensPerEpoch : 1000;
  document.getElementById('tok-stats').textContent =
    'This epoch (day ' + d.epoch + '): ' + (d.drawnThisEpoch || 0) + ' token' +
    (d.drawnThisEpoch === 1 ? '' : 's') + ' drawn by ' + (d.activeMembers || 0) +
    ' member' + (d.activeMembers === 1 ? '' : 's') + '.';
}

async function loadMailboxPolicy() {
  var r = await fetch('/api/mailbox-policy');
  var d = await r.json();
  document.getElementById('mbx-maxdraws').value = d.maxDrawsPerEpoch != null ? d.maxDrawsPerEpoch : 16;
  document.getElementById('mbx-maxconc').value = d.maxConcurrent != null ? d.maxConcurrent : 4;
  document.getElementById('mbx-dropinvalid').checked = d.dropInvalid !== false;
}

// The Tokens tab holds TWO independent forms (token quota + draw protection) sharing one banner/
// control-disable guard — reloadTab('tokens') calls this single combined loader (registered below)
// instead of either half directly, so a failure in EITHER fetch disables BOTH save buttons: a stale
// draw-protection read is just as capable of getting overwritten by a Save click as a stale quota read.
async function loadTokensTab() {
  await loadTokens();
  await loadMailboxPolicy();
}

async function saveMailboxPolicy() {
  var errEl = document.getElementById('mbx-err'), okEl = document.getElementById('mbx-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var body = {
    maxDrawsPerEpoch: numOr0(document.getElementById('mbx-maxdraws').value),
    maxConcurrent: numOr0(document.getElementById('mbx-maxconc').value),
    dropInvalid: document.getElementById('mbx-dropinvalid').checked,
  };
  try {
    var r = await fetch('/api/mailbox-policy', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'save failed');
    okEl.textContent = 'Saved — draw protection updated. Takes effect immediately.';
    okEl.style.display = 'block';
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  }
}

async function saveTokens() {
  var errEl = document.getElementById('tokens-err'), okEl = document.getElementById('tokens-ok');
  errEl.style.display = 'none'; okEl.style.display = 'none';
  var n = parseInt(document.getElementById('tok-per-epoch').value, 10);
  if (!(n >= 1)) {
    errEl.textContent = 'Enter a positive whole number.'; errEl.style.display = 'block'; return;
  }
  try {
    var r = await fetch('/api/token-policy', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tokensPerEpoch: n}),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'save failed');
    okEl.textContent = 'Saved — members may now draw ' + d.tokensPerEpoch + ' tokens/day. Takes effect immediately.';
    okEl.style.display = 'block';
    reloadTab('tokens');
  } catch (e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function copyEl(id) { copyText(document.getElementById(id).textContent); }
function copyText(t) { navigator.clipboard.writeText(t); }

// ── Init ──────────────────────────────────────────────────────────────────────
// Every panel is hydrated up front, but two of these calls are Tor round-trips — loadHealth opens a
// WebSocket to the relay (up to a 5 s probe) and loadSafeBrowsing may probe the Tor SOCKS port — and
// over the dashboard's own onion they'd hold a connection slot for seconds, starving the ~16 cheap
// config reads queued behind them. So we let the parsed page paint first, fire the cheap reads, then
// run the two slow probes a beat later. The health pill still auto-refreshes every 30 s, so nothing
// is lost by not blocking first paint on it.
function hydrateDashboard() {
  reloadTab('onboard');
  reloadTab('limits');
  reloadTab('mods');
  reloadTab('tags');
  reloadTab('labels');
  reloadTab('postrules');
  reloadTab('media');
  reloadTab('readaccess');
  reloadTab('reasons');
  reloadTab('modlimits');
  reloadTab('gov');
  reloadTab('community-cfg');
  reloadTab('ranking');
  wireRankPreview();
  reloadTab('storage');
  setTimeout(function () { loadHealth(); reloadTab('safebrowsing'); }, 400);
}
setInterval(loadHealth, 30000); // periodic refresh so a relay that drops mid-session is noticed
// Reopen the tab named in the hash (switchTab keeps it current), so a reload — routine over Tor —
// lands the organizer back on the page they were working in instead of the first tab.
(function () {
  var initial = location.hash.replace(/^#/, '');
  if (initial && initial !== 'onboard' && document.getElementById('tab-' + initial)) switchTab(initial);
})();
// Yield once so the already-parsed HTML paints before the fetch fan-out begins.
setTimeout(hydrateDashboard, 0);

// ── Maintenance ─────────────────────────────────────────────────────────────────

async function purgeSpentInvites() {
  var btn = document.getElementById('mnt-purge-btn');
  var out = document.getElementById('mnt-purge-out');
  if (!window.confirm('Delete all expired and fully-used invite codes? Active codes are kept.')) return;
  out.style.display = 'none';
  var prev = btn.textContent; btn.disabled = true; btn.textContent = 'Deleting…';
  try {
    var r = await fetch('/api/invites/purge', { method: 'POST' });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'purge failed');
    out.className = 'ok';
    out.textContent = d.removed
      ? 'Removed ' + d.removed + ' spent code' + (d.removed === 1 ? '' : 's') + '.'
      : 'No spent codes to remove.';
    out.style.display = 'block';
    loadInvites();
  } catch (e) {
    out.className = 'err';
    out.textContent = 'Could not purge: ' + e.message;
    out.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

async function bustAssetCache() {
  var btn = document.getElementById('mnt-bust-btn');
  btn.disabled = true; btn.textContent = 'Refreshing…';
  // Rotate the server's asset version, then reload: the freshly-served shell references the new ?v=,
  // so the browser re-fetches the bundle instead of serving the cached copy. Reload even if the POST
  // fails so the operator is never stranded on a half-refreshed page.
  try { await fetch('/api/bust-cache', { method: 'POST' }); } catch (e) { /* reload regardless */ }
  location.reload();
}

// ── Safe Browsing (relay secret; writes the relay config, NOT a Nostr event) ──────
async function loadSafeBrowsing() {
  var statusEl = document.getElementById('sb-status');
  var r = await fetch('/api/safe-browsing');
  var d = await r.json();
  document.getElementById('sb-key').value = '';
  var msg;
  if (!d.readable) {
    msg = '⚠ Relay config not found at ' + d.relayConfig + ' — set STIQ_RELAY_CONFIG.';
  } else if (d.configured) {
    msg = '✓ Active — key ' + d.hint + (d.writable ? '' : ' (⚠ config read-only here — can’t change it)');
    // F5: the toggle looks live the instant the key is saved (the relay hot-reloads config.json
    // within ~10s), but under single-onion mode (the default) the relay's outbound Tor SOCKS use
    // is only satisfied by a SEPARATE tor@stiq-client instance that deploy/stiq-up.sh provisions —
    // and only when re-run over SSH. With no SSH habit an organizer would otherwise never learn
    // lookups are 503ing closed. Only shown when the probe actually found the port unreachable —
    // never fires when everything is fine.
    if (d.socksReachable === false) {
      msg += ' ⚠ Tor SOCKS proxy unreachable at ' + d.socksAddr + ' — link checks are failing closed ' +
        '(single-onion mode disables the relay’s outbound Tor use unless a second tor instance is ' +
        'provisioned). Fix: run `sudo bash deploy/stiq-up.sh` over SSH (provisions tor@stiq-client), ' +
        'or set `SAFE_BROWSING_TOR=1` if this box can’t see the key in config.json.';
    }
  } else {
    msg = 'Off — no key set.' + (d.writable ? '' : ' ⚠ Config read-only here — can’t set it.');
  }
  statusEl.textContent = msg;
  // Reuse the .live/.expired text-color classes the health pill already uses for the same
  // ok/problem distinction (F5) — not new CSS: green when active and (as far as this probe can
  // tell) working, red when active but the SOCKS dependency is confirmed missing, muted default
  // otherwise (off, or config unreadable).
  statusEl.className = 'sub' + (d.configured ? (d.socksReachable === false ? ' expired' : ' live') : '');
  document.getElementById('sb-clear-btn').style.display = d.configured ? '' : 'none';
}

async function postSafeBrowsing(key) {
  var errEl = document.getElementById('sb-err'), okEl = document.getElementById('sb-ok');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  try {
    var r = await fetch('/api/safe-browsing', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: key}),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'save failed');
    okEl.textContent = d.configured
      ? 'Saved. The relay picks it up within ~10 seconds.'
      : 'Turned off. The relay stops checking within ~10 seconds.';
    okEl.style.display = 'block';
    reloadTab('safebrowsing');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

function saveSafeBrowsing() {
  var key = document.getElementById('sb-key').value.trim();
  if (!key) {
    var e = document.getElementById('sb-err');
    e.textContent = 'Paste a key first (or use “Turn off”).';
    e.style.display = 'block';
    return;
  }
  return postSafeBrowsing(key);
}

function clearSafeBrowsing() {
  return postSafeBrowsing('');
}

// ── Relays (community mirrors) ─────────────────────────────────────────────────

async function loadMirrors() {
  var r = await fetch('/api/mirrors');
  var d = await r.json();
  mirrors = d.mirrors || [];
  renderMirrors();
}

async function addMirror() {
  var urlIn  = document.getElementById('mirror-url-in');
  var authIn = document.getElementById('mirror-auth-in');
  var url  = urlIn.value.trim();
  var auth = authIn.value.trim();
  var errEl = document.getElementById('mirror-err');
  errEl.style.display = 'none';
  if (!url) return;
  try {
    var body = {url: url};
    if (auth) body.onionAuthKey = auth;
    var r = await fetch('/api/mirrors', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    var d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'add failed');
    mirrors = d.mirrors;
    urlIn.value = '';
    authIn.value = '';
    renderMirrors();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

async function removeMirror(host) {
  var r = await fetch('/api/mirrors/' + encodeURIComponent(host), {method: 'DELETE'});
  var d = await r.json();
  mirrors = d.mirrors;
  renderMirrors();
}

function renderMirrors() {
  document.getElementById('mirror-count').textContent = mirrors.length;
  var list = document.getElementById('mirror-list');
  list.innerHTML = '';
  if (mirrors.length === 0) {
    var empty = document.createElement('span');
    empty.style.cssText = 'color:var(--mu);font-size:13px';
    empty.textContent = 'No relay mirrors yet.';
    list.appendChild(empty);
  } else {
    // DOM APIs + textContent + addEventListener (not an inline onclick string) — same stored-XSS
    // guard as renderMods (#13): never let a persisted value be parsed back as code.
    for (var i = 0; i < mirrors.length; i++) {
      (function (m) {
        var host = m.url.replace(/^wss?:\/\//i, '').split(/[/?#]/)[0];
        var chip = document.createElement('div');
        chip.className = 'chip';
        var main = document.createElement('span');
        main.textContent = m.url;
        var tag = document.createElement('span');
        tag.style.cssText = 'color:var(--mu);font-size:11px';
        tag.textContent = m.onionAuthKey ? 'auth-gated' : 'public';
        var btn = document.createElement('button');
        btn.title = 'Remove';
        btn.textContent = '✕';
        btn.addEventListener('click', function () { removeMirror(host); });
        chip.appendChild(main); chip.appendChild(tag); chip.appendChild(btn);
        list.appendChild(chip);
      })(mirrors[i]);
    }
  }
}

async function publishMirrors() {
  var btn = document.getElementById('pub-mirrors-btn');
  var out = document.getElementById('mirrors-pub');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Publishing…';
  try {
    var r = await fetch('/api/mirrors/publish', {method: 'POST'});
    var d = await r.json();
    out.className = d.ok ? 'ok' : 'err';
    out.textContent = (d.ok ? '✓ ' : '⚠ ') + (d.message || d.error || 'done')
      + ' — event id ' + (d.event ? d.event.id.slice(0, 12) + '…' : '?');
    out.style.display = 'block';
  } catch (e) {
    out.className = 'err'; out.textContent = e.message; out.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '⇪ Publish relay list';
  }
}

// ── Posting guidelines (kind-30078 stiq:posting-guidelines) ─────────────────────
// The rules-banner blurb + versioned covenant shown in the composer. `ver`/`at` are SERVER-managed
// (see organizer-server.mjs sanitizePostingGuidelines) — this UI only ever displays them, never edits
// them directly. Sections are a dynamic list, each a heading input + an items textarea (one item per
// line); the blurb and diff are also plain textareas — the server splits/parses their lines.
var glSections = []; // [{h: string, it: string(raw, one item per line)}]
var glVer = 0;
var glAt = 0;

async function loadGuidelines() {
  var r = await fetch('/api/posting-guidelines');
  var d = await r.json();
  var g = d.postingGuidelines || {};

  document.getElementById('gl-blurb').value = (g.b || []).join('\n');

  glSections = (g.sec || []).map(function (s) {
    return {h: s.h || '', it: (s.it || []).join('\n')};
  });
  renderGuidelinesSections();

  document.getElementById('gl-diff').value = (g.df && Array.isArray(g.df.rows))
    ? g.df.rows.map(function (row) { return row[0] + ' ' + row[1]; }).join('\n')
    : '';

  glVer = g.ver || 0;
  glAt = g.at || 0;
  renderGuidelinesStatus();
}

function renderGuidelinesStatus() {
  var el = document.getElementById('gl-status');
  if (!glVer) {
    el.textContent = 'not published yet';
    return;
  }
  var dateStr = glAt ? new Date(glAt * 1000).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) : '';
  el.textContent = 'v' + glVer + (dateStr ? ' · updated ' + dateStr : '');
}

function renderGuidelinesSections() {
  var box = document.getElementById('gl-sections');
  box.innerHTML = '';
  if (glSections.length === 0) {
    var empty = document.createElement('span');
    empty.style.cssText = 'color:var(--mu);font-size:13px';
    empty.textContent = 'No sections yet.';
    box.appendChild(empty);
    return;
  }
  for (var i = 0; i < glSections.length; i++) box.appendChild(glSectionRow(i));
}

// One heading + items row, XSS-safe: loaded values are set via .value/textContent, never innerHTML.
function glSectionRow(i) {
  var s = glSections[i];
  var wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid var(--bdr);border-radius:8px;padding:12px;margin-bottom:10px';

  var hLabel = document.createElement('label');
  hLabel.style.marginTop = '0';
  hLabel.textContent = 'Heading';
  wrap.appendChild(hLabel);

  var h = document.createElement('input');
  h.type = 'text'; h.value = s.h; h.placeholder = 'How we post';
  h.style.cssText = 'width:100%;height:36px;padding:0 11px;font-size:13px';
  h.oninput = function () { s.h = h.value; };
  wrap.appendChild(h);

  var itLabel = document.createElement('label');
  itLabel.textContent = 'Items (one per line, up to 10)';
  wrap.appendChild(itLabel);

  var it = document.createElement('textarea');
  it.rows = 4; it.value = s.it; it.placeholder = 'Say what you mean.\nCredit sources.';
  it.style.cssText = 'width:100%;padding:11px;font-size:13px;font-family:inherit;line-height:1.5;resize:vertical';
  it.oninput = function () { s.it = it.value; };
  wrap.appendChild(it);

  var rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'btn sm';
  rm.style.cssText = 'margin-top:10px;background:none;border:1px solid var(--bdr);color:var(--mu)';
  rm.textContent = 'Remove section';
  rm.onclick = function () { glSections.splice(i, 1); renderGuidelinesSections(); };
  wrap.appendChild(rm);

  return wrap;
}

function addGuidelinesSection() {
  if (glSections.length >= 8) return; // mirrors MAX_SECTIONS (client/src/feed/postingGuidelines.ts)
  glSections.push({h: '', it: ''});
  renderGuidelinesSections();
}

function readGuidelinesBody() {
  return {
    b: document.getElementById('gl-blurb').value,
    sec: glSections.map(function (s) { return {h: s.h, it: s.it}; }),
    df: document.getElementById('gl-diff').value,
  };
}

async function publishGuidelines() {
  await publishConfig('/api/posting-guidelines', readGuidelinesBody(), 'pub-guidelines-btn', 'guidelines-pub', 'guidelines-err');
  // ver/at are computed server-side (content-change comparison) — refresh the status line from the
  // saved doc rather than guessing locally, whether the publish succeeded or failed.
  try {
    var r = await fetch('/api/posting-guidelines');
    var d = await r.json();
    var g = d.postingGuidelines || {};
    glVer = g.ver || 0; glAt = g.at || 0;
    renderGuidelinesStatus();
  } catch (e) { /* best-effort refresh only */ }
}

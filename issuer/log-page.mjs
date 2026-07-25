/**
 * Log-page wire sanitizer — the pure half of the hearth doc (kind-30078 stiq:log-page) the
 * organizer dashboard publishes and the app renders. Split out of organizer-server.mjs (which can't
 * be imported without booting the whole dashboard + minting keys) so `issuer/log_page_test.mjs` can
 * import and exercise it directly, exactly as log-offer.mjs is.
 *
 * The stored file IS the compact wire (published verbatim); caps mirror the CLIENT parser in
 * client/src/moderation/organizerConfig.ts currentLogPage() — keep the two in lockstep.
 *
 * `sanitizeLogPage(body, prev, {decodeSpaceLink, now})` is pure: `decodeSpaceLink` is injected (the
 * server passes its own; a test can stub it), and `now` is injectable so version bumps are
 * deterministic under test.
 */

// Duplicated wire constants (trivial, never-changing — the same duplication log-offer.mjs uses).
const MAX_FEATURED_GRADIENT = 120;
const HEX64 = /^[0-9a-f]{64}$/;
const SPACE_EMBED_PREFIX = 'stiq:space:';
const GRADIENT_RE = /^[LR]\d{0,3}:[0-9a-fA-F]{3,6}(,[0-9a-fA-F]{3,6}){1,2}$/;

// Hard caps — the hearth is a curated front room, not a directory or a long-form surface.
export const MAX_LOG_PICKS = 8;
export const MAX_LOG_PEOPLE = 12;
export const MAX_LOG_NOTE_BODY = 2000;
export const MAX_LOG_WELCOME_BODY = 2000;
export const MAX_LOG_RULES_BODY = 8000;
export const MAX_LOG_BLURB = 140;
export const MAX_LOG_ROLE = 40;
export const MAX_LOG_TEXT = 160;

/** One year — the welcome's hard duration ceiling (a mis-typed "9999 days" can't outlive the org). */
const MAX_WELCOME_SECS = 365 * 86400;

export function logText(v, max) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max || MAX_LOG_TEXT) : '';
}

/**
 * Sanitize a dashboard POST into the wire doc. `prev` is the previously saved doc: the note/welcome
 * VERSIONS are managed here — each bumps ONLY when its own text/signature actually changes, so an
 * unrelated edit (a blurb, a header) can never re-expand every member's tucked-away card; and
 * `rules.at` bumps only when the rules text changes, so the app's "updated Xd ago" stays honest.
 *
 * `opts.decodeSpaceLink(a)` decodes a `stiq:space:` share link → {a,t,n?,g?} (or null); the server
 * injects its own. `opts.now` (unix secs) is injectable for deterministic tests.
 */
export function sanitizeLogPage(body, prev, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
  const decodeSpaceLink = typeof opts.decodeSpaceLink === 'function' ? opts.decodeSpaceLink : () => null;
  const doc = {v: 1};

  // Owner's note — absent body ⇒ no note (the app hides the card AND the strip).
  const noteB = typeof body?.note?.b === 'string' ? body.note.b.trim().slice(0, MAX_LOG_NOTE_BODY) : '';
  if (noteB) {
    const sig = logText(body?.note?.sig, 80);
    const prevB = typeof prev?.note?.b === 'string' ? prev.note.b : '';
    const prevSig = typeof prev?.note?.sig === 'string' ? prev.note.sig : '';
    let ver = logText(prev?.note?.ver, 64);
    if (!ver || noteB !== prevB || sig !== prevSig) ver = 'n' + now;
    const note = {ver, b: noteB};
    const t = logText(body?.note?.t); if (t) note.t = t;
    const s = logText(body?.note?.s); if (s) note.s = s;
    if (sig) note.sig = sig;
    // The note's own avatar gradient (encodeGradient wire form) — purely cosmetic, so it is
    // deliberately NOT part of the `ver` comparison above: changing only the gradient must never
    // bump the version and re-expand every member's tucked-away note.
    const gRaw = typeof body?.note?.g === 'string' ? body.note.g.trim() : '';
    if (GRADIENT_RE.test(gRaw)) note.g = gRaw.slice(0, MAX_FEATURED_GRADIENT);
    doc.note = note;
  }

  // Welcome message — same shape as the note plus a duration; absent body ⇒ no welcome. Its `ver` is
  // `w`-prefixed (never collides with a note `ver`) and bumps only when the welcome text/signature
  // changes. The duration arrives as durN (number) + durU ('days'|'hours') and is stored as seconds.
  const welB = typeof body?.welcome?.b === 'string' ? body.welcome.b.trim().slice(0, MAX_LOG_WELCOME_BODY) : '';
  if (welB) {
    const wsig = logText(body?.welcome?.sig, 80);
    const prevWelB = typeof prev?.welcome?.b === 'string' ? prev.welcome.b : '';
    const prevWelSig = typeof prev?.welcome?.sig === 'string' ? prev.welcome.sig : '';
    let wver = logText(prev?.welcome?.ver, 64);
    if (!wver || welB !== prevWelB || wsig !== prevWelSig) wver = 'w' + now;
    const durN = Number(body?.welcome?.durN);
    const unit = body?.welcome?.durU === 'hours' ? 3600 : 86400; // default: days
    const dur = Number.isFinite(durN) && durN > 0 ? Math.min(Math.round(durN * unit), MAX_WELCOME_SECS) : 86400;
    const welcome = {ver: wver, b: welB, dur};
    const wt = logText(body?.welcome?.t); if (wt) welcome.t = wt;
    const ws = logText(body?.welcome?.s); if (ws) welcome.s = ws;
    if (wsig) welcome.sig = wsig;
    const wgRaw = typeof body?.welcome?.g === 'string' ? body.welcome.g.trim() : '';
    if (GRADIENT_RE.test(wgRaw)) welcome.g = wgRaw.slice(0, MAX_FEATURED_GRADIENT);
    doc.welcome = welcome;
  }

  // Standing rules — absent body ⇒ no rules (the note's toggle row hides).
  const rulesB = typeof body?.rules?.b === 'string' ? body.rules.b.trim().slice(0, MAX_LOG_RULES_BODY) : '';
  if (rulesB) {
    const prevRulesB = typeof prev?.rules?.b === 'string' ? prev.rules.b : '';
    const prevAt = Number.isFinite(prev?.rules?.at) ? prev.rules.at : 0;
    const rules = {b: rulesB, at: rulesB !== prevRulesB || !prevAt ? now : prevAt};
    const e = logText(body?.rules?.e); if (e) rules.e = e;
    const m = logText(body?.rules?.m); if (m) rules.m = m;
    if (body?.rules?.x === true) rules.x = true;
    doc.rules = rules;
  }

  // Picked channels/groups — validated like the featured rail (share links → coordinates).
  const picks = [];
  const seenPicks = new Set();
  for (const it of Array.isArray(body?.picks) ? body.picks : []) {
    if (!it || typeof it !== 'object') continue;
    let a = typeof it.a === 'string' ? it.a.trim() : '';
    if (!a) continue;
    let t = it.t;
    let n = typeof it.n === 'string' ? it.n : '';
    let g = typeof it.g === 'string' ? it.g : '';
    if (a.startsWith(SPACE_EMBED_PREFIX)) {
      const dec = decodeSpaceLink(a);
      if (!dec) continue;
      a = dec.a; t = dec.t;
      if (dec.n) n = dec.n;
      if (dec.g) g = dec.g;
    }
    if (t !== 'channel' && t !== 'group') continue;
    if (seenPicks.has(a)) continue;
    seenPicks.add(a);
    const pick = {a, t};
    const bl = logText(it.bl, MAX_LOG_BLURB); if (bl) pick.bl = bl;
    const c = logText(it.c, 24); if (c) pick.c = c;
    if (n) pick.n = n.slice(0, 80);
    if (g) pick.g = g.slice(0, MAX_FEATURED_GRADIENT);
    picks.push(pick);
    if (picks.length >= MAX_LOG_PICKS) break;
  }
  doc.picks = picks;

  // People worth knowing — hex pubkeys only (a malformed ref would dead-end the profile route).
  const people = [];
  const seenPeople = new Set();
  for (const it of Array.isArray(body?.people) ? body.people : []) {
    if (!it || typeof it !== 'object') continue;
    const p = typeof it.p === 'string' ? it.p.trim().toLowerCase() : '';
    if (!HEX64.test(p) || seenPeople.has(p)) continue;
    seenPeople.add(p);
    const person = {p};
    const r = logText(it.r, MAX_LOG_ROLE); if (r) person.r = r;
    const n = typeof it.n === 'string' && it.n.trim() ? it.n.trim().slice(0, 80) : '';
    if (n) person.n = n;
    people.push(person);
    if (people.length >= MAX_LOG_PEOPLE) break;
  }
  doc.people = people;

  // Copy overrides — only non-empty slots are carried; the app falls back to the design copy.
  const copyKeys = ['ph', 'pph', 'dt', 'ds', 'mo', 'rs', 'rh', 'tk', 'ro'];
  const copy = {};
  for (const k of copyKeys) {
    const v = logText(body?.copy?.[k]);
    if (v) copy[k] = v;
  }
  doc.copy = copy;

  // Tweaks — both default ON.
  doc.sp = body?.sp !== false;
  doc.au = body?.au !== false;
  return doc;
}

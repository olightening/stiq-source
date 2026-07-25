/**
 * Content epoch key custody (organizer side) — the server half of lever 1's read meter.
 *
 * The organizer mints the rotating content epoch keys K_E that seal blind-post bodies (see the
 * client's blind/contentKey.ts + blind/blindSigner.ts), and hands K_E to a member only when they
 * SPEND a valid blind read-token (mailbox kind 9026 → this module's unlockEpoch). It:
 *
 *   • custodies the keys (one 32-byte key per epoch), persisted to a JSON sidecar;
 *   • ROTATES volume-based — a fresh epoch key every `rotateEvery` posts, so a single unlocked K_E
 *     exposes at most that many posts (bounds a leaked-key blast radius);
 *   • enforces the read meter with a spent-set keyed on the token bytes: one epoch unlock per token,
 *     so a member's finite read-token budget caps how much reading they (or anyone they share tokens
 *     with) can unlock.
 *
 * Anonymity: token verification is blind (the injected `verifyToken` checks the issuer signature
 * over the opaque token; the organizer never learns which npub is reading). Retry-idempotency for the
 * common case (the request itself is a replay) is handled UPSTREAM by the mailbox's event-id dedupe +
 * the relay replaying the stored 9027 — but a request whose 9027 REPLY never made it back to the
 * member (mailbox delivery failure) is deliberately made retryable upstream, and would otherwise hit
 * this module's spent-set as a hard error despite never having received the key. So unlockEpoch below
 * ALSO remembers each spend's answer (`answered`) and re-delivers it on a matching retry — the
 * spent-set only ever hard-blocks a genuinely DISTINCT reuse of the same token.
 *
 * Pure-ish + injectable: pass `load`/`save` (defaults: fs JSON sidecar at `statePath`) and
 * `verifyToken` so the rotation + spent-set logic is unit-testable without fs or a real issuer.
 */
import {randomBytes, createHash} from 'crypto';
import {readFileSync, writeFileSync, renameSync, existsSync} from 'fs';

/** 32-byte content epoch key, base64 — used directly as a NIP-44 v2 conversation key by clients. */
function mintKeyB64() {
  return randomBytes(32).toString('base64');
}

function defaultLoad(statePath) {
  return () => {
    if (!statePath || !existsSync(statePath)) return null;
    let raw;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch (e) {
      console.error('[contentEpochKeys] WARNING: could not read ' + statePath + ' (' + (e?.message || e) + '); starting fresh.');
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      // Corrupt sidecar. Returning null makes the caller mint a fresh epoch-0 and OVERWRITE this file,
      // DESTROYING every past K_E — and with it the ability to unlock every already-sealed post. Preserve
      // the corrupt bytes to a .corrupt backup and LOG loudly BEFORE that overwrite happens, so a human
      // can recover the keys instead of losing them silently.
      const bak = statePath + '.corrupt';
      try {
        writeFileSync(bak, raw);
        console.error('[contentEpochKeys] WARNING: ' + statePath + ' is corrupt (' + (e?.message || e) + '); backed up to ' + bak + ' before minting a fresh epoch. PAST CONTENT KEYS MAY BE UNRECOVERABLE — inspect the backup.');
      } catch (e2) {
        console.error('[contentEpochKeys] WARNING: ' + statePath + ' is corrupt (' + (e?.message || e) + ') AND the .corrupt backup could not be written (' + (e2?.message || e2) + '); past content keys are about to be overwritten.');
      }
      return null;
    }
  };
}

function defaultSave(statePath) {
  return state => {
    if (!statePath) return;
    try {
      // Temp + atomic rename so a crash mid-write can never leave a truncated sidecar that would then
      // read as "corrupt" and trigger a fresh-epoch overwrite (losing every past K_E).
      const tmp = statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, statePath);
    } catch {
      /* best-effort persistence; an unwritable disk must not take the mailbox down */
    }
  };
}

/**
 * Build the `stiq:content-epoch` kind-30078 doc BODY the organizer publishes (organizer-server.mjs's
 * publishContentEpoch), gated on whether content encryption is currently active (READ_AUTH there — the
 * in-memory mirror of the relay's content_encryption/read_auth_required flags).
 *
 * 2026-07-22 incident: while inactive, publishing a real epoch integer is actively harmful — an OLD
 * field client (one that predates the client-side relay-flag gate added to ensureWriteEpoch /
 * sealRequiredNow) has NO OTHER signal that encryption is off, and keeps provisioning + sealing under
 * whatever epoch this doc names. So while inactive this returns a DEACTIVATION body: `epoch: null`
 * (+ advisory `active: false`, for a future client) instead of an integer.
 *
 * Compatibility (client/src/blind/contentKey.ts's parseContentEpochDoc): it returns `{epoch}` only
 * when `epoch` is `typeof 'number' && Number.isInteger && >= 0`; anything else — including `null` —
 * makes it return `null`, and AppRuntime's CONTENT_EPOCH_D_TAG handler then does `if (!v) return null`,
 * i.e. leaves `_announcedContentEpoch` untouched rather than clearing it. So this body reliably stops a
 * client from ever being TOLD "epoch N is active" (a fresh install, or a member whose local community
 * record has no cached epoch yet, never provisions one) — but it CANNOT reach into a client that
 * already holds a provisioned epoch's key: getWriteContentKey() there reads only the in-memory/on-disk
 * `_writeEpoch`/`_epochKeys` (rehydrated at every app launch by loadContentKeys()), and nothing in the
 * client's event-handling path clears those in response to ANY announcement — only an explicit account
 * wipe/switch does. There is no doc shape that un-seals an already-provisioned client.
 *
 * The ACTIVE body is intentionally byte-identical to before this fix (no `active` key) — turning
 * encryption back on must not perturb what an already-compliant client sees.
 */
export function buildContentEpochDoc(active, epoch, rotateEvery) {
  return active
    ? {epoch, rotateEvery}
    : {epoch: null, rotateEvery, active: false};
}

// Bound on the answered-unlock memory below (2026-07-21 incident: a lost mailbox reply burned the
// member's read token with no key ever delivered). 1000 is a simple, easy-to-reason-about cap — an
// entry is one small object, so even 1000 of them is negligible next to the keys/spent state already
// held; a time-based ("older than 7 days") bound would need a clock at prune time for no real benefit
// here, since a retry that shows up THAT late is vanishingly rare and the count cap already keeps the
// file bounded over months of uptime (mirrors the mailbox's own SEEN_WINDOW_SECONDS bound in spirit,
// just count- instead of age-based). `ts` is still recorded per entry so a future age-based policy
// could be layered on without a state-shape change.
export const ANSWERED_UNLOCK_LIMIT = 1000;

/**
 * @param {object} opts
 * @param {number} opts.rotateEvery   posts per epoch before a fresh key is minted (volume rotation)
 * @param {string} [opts.statePath]   JSON sidecar path (default persistence)
 * @param {() => any} [opts.load]     injected loader (tests)
 * @param {(s:any) => void} [opts.save] injected saver (tests)
 * @param {(token:Buffer, sig:Buffer) => Promise<boolean>} opts.verifyToken  blind read-token check
 * @param {() => boolean} [opts.dropInvalid]  when it returns true, invalid/absent/malformed unlock
 *   requests resolve with `{drop:true}` so the mailbox sends NO mined+signed reply (anti-amplification)
 */
export function createContentKeyCustody(opts) {
  const rotateEvery = Math.max(1, Number(opts.rotateEvery) || 500);
  const load = opts.load || defaultLoad(opts.statePath);
  const save = opts.save || defaultSave(opts.statePath);
  const verifyToken = opts.verifyToken || (async () => false);
  const dropInvalid = typeof opts.dropInvalid === 'function' ? opts.dropInvalid : () => false;

  const state = load() || {current: 0, postsInEpoch: 0, keys: {}, spent: []};
  if (!state.keys || typeof state.keys !== 'object') state.keys = {};
  if (!state.keys[state.current]) state.keys[state.current] = mintKeyB64();
  const spent = new Set(Array.isArray(state.spent) ? state.spent : []);
  // Answered-unlock memory (idempotent retries — see unlockEpoch below): spent token id -> the
  // {key, epoch} we already told them, plus when. Stored as an ORDERED array of [id, entry] pairs
  // (not a plain object) so insertion order survives a JSON round-trip even in the astronomically
  // unlikely case a token id happens to look like an integer — object key order reshuffles integer-
  // like keys first, which would break the "oldest first" assumption the bound below relies on.
  const answered = new Map(Array.isArray(state.answered) ? state.answered : []);
  // Enforce the bound on LOAD too (a hand-edited or pre-bound-existing file could be over it), same
  // oldest-first trim the insert path uses.
  while (answered.size > ANSWERED_UNLOCK_LIMIT) {
    answered.delete(answered.keys().next().value);
  }

  function persist() {
    state.spent = [...spent];
    state.answered = [...answered];
    save(state);
  }
  // Mint the initial epoch key on first run.
  persist();

  function currentEpoch() {
    return state.current;
  }
  /** The key new posts are sealed under (the newest epoch) — base64. */
  function currentKey() {
    return state.keys[state.current];
  }
  function keyFor(epoch) {
    return Object.prototype.hasOwnProperty.call(state.keys, epoch) ? state.keys[epoch] : null;
  }

  /**
   * Record one observed post; rotate to a fresh epoch key once `rotateEvery` posts have accrued.
   * Returns the (possibly advanced) current epoch and whether a rotation happened.
   */
  function recordPost() {
    state.postsInEpoch += 1;
    let rotated = false;
    if (state.postsInEpoch >= rotateEvery) {
      state.current += 1;
      state.postsInEpoch = 0;
      state.keys[state.current] = mintKeyB64();
      rotated = true;
    }
    persist();
    return {epoch: state.current, rotated};
  }

  /**
   * Redeem one blind read-token for a content epoch key. Verifies the token's issuer signature,
   * enforces one-unlock-per-token via the spent-set, and returns the requested K_E. Shape mirrors
   * o.drawTokens: resolves to `{key, epoch}` on success or `{error}` on refusal (never throws).
   *
   * Idempotent on retry (2026-07-21 incident): the mailbox spends the token here BEFORE the reply is
   * actually delivered to the member (mailbox.mjs's response publisher awaits the relay's OK frame
   * AFTER this resolves), so a dropped socket / relay hiccup between "we spent it" and "they got it"
   * previously meant the token was burned with the key never delivered — and the client's retry (the
   * mailbox intentionally un-dedupes a delivery-failed request so it CAN be retried) landed on
   * "already spent" forever. `answered` remembers exactly which key/epoch we told each spent token id
   * so a retry that matches an already-ANSWERED spend re-delivers the SAME result instead of erroring.
   * A token spent before this fix shipped (no `answered` entry, or one pruned past the bound) still
   * errors — we genuinely don't know what we told them.
   */
  async function unlockEpoch(payload) {
    // A request that is malformed or carries an invalid/absent token is unauthenticated junk: mark it
    // `drop` so the mailbox skips the mined+signed 9027 reply, removing the attacker-forced PoW work a
    // 9026 flood could otherwise wedge the single JS thread with (#31). A VALID-but-refused request
    // (already-spent token) is authenticated, so it still gets a reply telling the member why.
    const drop = dropInvalid() === true;
    const epoch = payload && payload.epoch;
    if (!Number.isInteger(epoch) || epoch < 0) return {error: 'bad epoch', drop};
    const key = keyFor(epoch);
    if (!key) return {error: 'unknown content epoch', drop};
    if (typeof payload.token !== 'string' || typeof payload.sig !== 'string') {
      return {error: 'missing read-token', drop};
    }
    let tokenBuf, sigBuf;
    try {
      tokenBuf = Buffer.from(payload.token, 'base64');
      sigBuf = Buffer.from(payload.sig, 'base64');
    } catch {
      return {error: 'malformed read-token', drop};
    }
    const ok = await verifyToken(tokenBuf, sigBuf);
    if (!ok) return {error: 'invalid read-token', drop};
    // One epoch unlock per token. Keyed on the token bytes so the meter is enforced regardless of
    // which epoch was requested.
    const id = createHash('sha256').update(tokenBuf).digest('hex');
    if (spent.has(id)) {
      // Already spent — but if we remember ANSWERING this exact token, re-deliver the same key/epoch
      // instead of erroring (see the idempotency note above). A genuinely distinct reuse attempt (a
      // token spent by some other flow, or one that aged out of `answered`) still gets the error.
      const prior = answered.get(id);
      if (prior) return {key: prior.key, epoch: prior.epoch};
      return {error: 'read-token already spent'};
    }
    spent.add(id);
    answered.set(id, {key, epoch, ts: Date.now()});
    // Bound: drop the oldest entry once over the limit (Map preserves insertion order).
    while (answered.size > ANSWERED_UNLOCK_LIMIT) {
      answered.delete(answered.keys().next().value);
    }
    persist();
    return {key, epoch};
  }

  return {currentEpoch, currentKey, keyFor, recordPost, unlockEpoch, spentCount: () => spent.size};
}

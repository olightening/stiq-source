/**
 * Idempotent multi-use invite issuance.
 *
 * An invite admits up to `maxUses` DISTINCT members (default 1 — single-use; `null` — unlimited until
 * expiry/revoke). Each distinct blinded request that lands inside capacity mints its OWN credential;
 * the relay still binds each credential to exactly one npub, so N uses = N independent, mutually
 * unlinkable members — never N binds of one credential.
 *
 * Every redemption keeps the original one-shot guarantees, now per request-hash instead of per invite:
 * a credential response can be lost after the organizer signs it, so retrying the EXACT blinded request
 * must return the SAME blind signature (idempotent replay), while a DIFFERENT blinded request must only
 * ever consume a fresh slot while capacity remains — and never turn one slot into two credentials. The
 * per-request hash and signature are persisted in invites.json so this survives organizer restarts.
 */
import {createHash} from 'crypto';

// Cap retained redemption slots so an UNLIMITED link redeemed thousands of times can't grow
// invites.json without bound (the whole file is rewritten on every redemption). Only FINISHED slots
// are ever evicted, and only past this many — a finite link is naturally bounded by maxUses and never
// prunes. An evicted slot's late lost-response retry simply re-enrolls with a fresh token: no
// double-mint, only a rare missed replay.
const MAX_RETAINED_USES = 500;

function requestHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inviteError(message, drop = false) {
  const error = new Error(message);
  if (drop) error.drop = true;
  return error;
}

function hasSignature(slot) {
  return slot && typeof slot.blindSignature === 'string' && slot.blindSignature.length > 0;
}

/**
 * Upgrade a legacy single-use record ({used, usedAt, credentialRequestHash, blindSignature}) to the
 * multi-use shape ({maxUses, usesCount, uses:{[hash]:{usedAt|reservedAt, blindSignature?}}}) IN PLACE,
 * and return it. Idempotent: a record already in the new shape only gets its counters defaulted. Legacy
 * invites were strictly single-use, so they normalize to maxUses:1 with their one (possibly still
 * reserved, sig-less) slot folded into `uses` — preserving both replay and crash-recovery. Callers that
 * only READ must use summarizeInvite (pure) instead; this mutates and is meant to be persisted.
 * @param {object} entry
 * @returns {object} the same entry, normalized
 */
export function normalizeEntry(entry) {
  if (entry.uses && typeof entry.uses === 'object') {
    if (entry.maxUses === undefined) entry.maxUses = 1;
    if (typeof entry.usesCount !== 'number') entry.usesCount = Object.keys(entry.uses).length;
    return entry;
  }
  const uses = {};
  if (entry.credentialRequestHash) {
    uses[entry.credentialRequestHash] = {
      usedAt: entry.usedAt || entry.createdAt || null,
      ...(hasSignature(entry) ? {blindSignature: entry.blindSignature} : {}),
    };
  }
  entry.maxUses = 1; // legacy invites were strictly single-use
  entry.usesCount = entry.used ? 1 : 0;
  entry.uses = uses;
  delete entry.used;
  delete entry.usedAt;
  delete entry.credentialRequestHash;
  delete entry.blindSignature;
  return entry;
}

/**
 * Read-only summary of an invite in EITHER shape (legacy or multi-use), without mutating it — for the
 * dashboard list, the CLI, and status badges. `remaining` is null for an unlimited link.
 * @param {object} entry
 * @param {number} [nowMs]
 * @returns {{maxUses:number|null, usesCount:number, remaining:number|null, exhausted:boolean, expired:boolean, status:'active'|'exhausted'|'expired'}}
 */
export function summarizeInvite(entry, nowMs = Date.now()) {
  const legacy = !entry.uses;
  const maxUses =
    entry.maxUses === null ? null : typeof entry.maxUses === 'number' ? entry.maxUses : 1;
  const usesCount = legacy
    ? entry.used
      ? 1
      : 0
    : typeof entry.usesCount === 'number'
      ? entry.usesCount
      : Object.keys(entry.uses).length;
  const remaining = maxUses === null ? null : Math.max(0, maxUses - usesCount);
  const exhausted = maxUses !== null && usesCount >= maxUses;
  let expired = false;
  if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
    const expMs = Date.parse(entry.expiresAt);
    expired = !Number.isFinite(expMs) || nowMs > expMs;
  }
  const status = expired ? 'expired' : exhausted ? 'exhausted' : 'active';
  return {maxUses, usesCount, remaining, exhausted, expired, status};
}

// Evict oldest FINISHED slots once an unlimited link exceeds the retention cap. Never touches a
// reserved-but-unsigned slot (that redemption is in flight). No-op for finite links (bounded by maxUses).
function pruneUses(entry) {
  const hashes = Object.keys(entry.uses);
  let removable = hashes.length - MAX_RETAINED_USES;
  if (removable <= 0) return;
  const finished = hashes
    .filter(h => hasSignature(entry.uses[h]))
    .sort((a, b) =>
      String(entry.uses[a].usedAt || '').localeCompare(String(entry.uses[b].usedAt || '')),
    );
  for (const h of finished) {
    if (removable <= 0) break;
    delete entry.uses[h];
    removable -= 1;
  }
}

/**
 * @param {object} options
 * @param {string} options.inviteCode
 * @param {Uint8Array|Buffer} options.blindedBytes
 * @param {()=>object} options.loadInvites
 * @param {(invites:object)=>void} options.saveInvites
 * @param {(blinded:Buffer)=>Promise<Uint8Array|Buffer>} options.signBlinded
 * @param {boolean} [options.dropInvalid]
 * @param {()=>string} [options.now]
 * @returns {Promise<Buffer>}
 */
export async function issueInviteCredential(options) {
  const {
    inviteCode,
    loadInvites,
    saveInvites,
    signBlinded,
    dropInvalid = false,
    now = () => new Date().toISOString(),
  } = options;
  const blinded = Buffer.from(options.blindedBytes || []);
  if (blinded.length === 0 || blinded.length > 8192) {
    throw inviteError('Malformed blinded credential request', dropInvalid);
  }

  const hash = requestHash(blinded);
  const invites = loadInvites();
  const raw = invites[inviteCode];
  if (!raw) {
    throw inviteError('Invite code not found: ' + inviteCode, dropInvalid);
  }
  const entry = normalizeEntry(raw);

  let reservedNow = false;
  const existing = entry.uses[hash];
  if (existing) {
    // A redemption we've already seen (any of the N). If it finished, replay the exact signature.
    if (hasSignature(existing)) {
      return Buffer.from(existing.blindSignature, 'base64');
    }
    // Reserved before a crash, or an in-flight same-request call: fall through and deterministically
    // (re)sign the exact request to finish this slot. Not a new redemption → consumes no fresh slot.
  } else {
    // A genuinely new redemption. Gate on expiry (fail-closed) THEN capacity — same single funnel for
    // BOTH the automated Tor mailbox and the manual HTTP sign path. A member who ALREADY minted a
    // credential reaches the replay branch above and can re-fetch it even past expiry/exhaustion:
    // gates block issuing NEW credentials, never recovering an earned one whose response was lost. A
    // present-but-unparseable expiresAt is treated as expired (fail-closed) so a corrupted record never
    // means "live forever". Records without expiresAt (Never) skip the expiry check.
    if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
      const expMs = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expMs) || Date.now() > expMs) {
        throw inviteError('This invite has expired');
      }
    }
    // Capacity: unlimited (maxUses === null) never fills. Keep the legacy 'already used' wording so
    // existing callers/copy/tests are unchanged whether the cap is 1 or N.
    if (entry.maxUses !== null && entry.usesCount >= entry.maxUses) {
      throw inviteError('Invite code already used');
    }
    // Reserve synchronously before awaiting WebCrypto. This whole branch runs to completion with no
    // await, so two different requests cannot both observe a free slot and race through blind signing:
    // the counter is bumped and persisted before any await frees the event loop.
    entry.uses[hash] = {reservedAt: now()};
    entry.usesCount += 1;
    pruneUses(entry);
    saveInvites(invites);
    reservedNow = true;
  }

  let signature;
  try {
    signature = Buffer.from(await signBlinded(blinded));
  } catch (error) {
    // A local signer failure must not consume a slot on an otherwise-live invite. Roll back ONLY our
    // own still-unfinished reservation; if a concurrent same-request call already persisted a
    // signature into this slot, leave its successful result intact.
    if (reservedNow) {
      const latest = loadInvites();
      const cur = latest[inviteCode] && normalizeEntry(latest[inviteCode]);
      const slot = cur && cur.uses[hash];
      if (slot && !hasSignature(slot)) {
        delete cur.uses[hash];
        cur.usesCount = Math.max(0, cur.usesCount - 1);
        saveInvites(latest);
      }
    }
    throw error;
  }
  if (signature.length === 0) {
    throw inviteError('Issuer returned an empty blind signature');
  }

  // Reload instead of writing the stale pre-await object — preserve unrelated dashboard edits and
  // finalize just this slot.
  const latest = loadInvites();
  const raw2 = latest[inviteCode];
  if (!raw2) {
    // The invite was revoked while we were signing. The member still earned this credential (it will
    // bind at the relay); hand it back, but do not resurrect the revoked record.
    return signature;
  }
  const cur = normalizeEntry(raw2);
  const slot = cur.uses[hash];
  if (hasSignature(slot)) {
    // A concurrent same-request call already finalized this slot — return the persisted signature so
    // both callers see byte-identical output.
    return Buffer.from(slot.blindSignature, 'base64');
  }
  cur.uses[hash] = {usedAt: (slot && slot.usedAt) || now(), blindSignature: signature.toString('base64')};
  saveInvites(latest);
  return signature;
}

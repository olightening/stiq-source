/**
 * member-roll — build the encrypted stiq:member-roll doc payload from the relay's own
 * membership file (the double-spend authority's bound-npub registry).
 *
 * WHY the file and not kind-9011 events: the file is authoritative and complete (manual binds
 * exist in prod; 9011 events are self-deletable without unbinding, and retries store as distinct
 * events), and the relay now refuses to serve 9011 at the wire at all. The organizer runs as the
 * same user on the same box (systemd User=stiq) and reads it directly.
 *
 * WIRE CONTRACT (must stay byte-stable — the client's currentMemberRoll parser depends on it):
 *   d-tag  : "stiq:member-roll" (kind 30078, organizer-signed, replaceable)
 *   content: NIP-44 v2 ciphertext under the RAW 32-byte community key (the exact primitive the
 *            client calls decryptForSpace / the attribution layer uses)
 *   plaintext JSON: {v: 1, members: [<64-hex npub>...] (sorted, deduped), updated_at: <unixSec>}
 *
 * FAIL-CLOSED RULE: an unreadable, unparseable, or EMPTY bound set throws — the caller must keep
 * the last-good published doc and skip, never publish. A wrongly-empty roll would make every
 * member's blind posts "off-roll" fleet-wide; no roll at all merely defers enforcement.
 *
 * Pure module: no publishing, no timers; organizer-server.mjs wires it to signConfig +
 * publishWithRetry, gated on TOKEN_DOMAIN_SEP (with a shared enrollment/posting key, a drawn
 * posting token doubles as a binding credential, so the roll's scarcity premise would be false).
 */
import {createHash} from 'crypto';
import {readFileSync} from 'fs';

const HEX64 = /^[0-9a-f]{64}$/;

class MemberRollError extends Error {}

/**
 * Parse the relay membership file's JSON text into the sorted, deduped bound-npub list.
 * Unions the `bound` array with `bound_at` keys — mirroring the relay MemStore's loadFrom, where
 * a timestamped pubkey counts as bound even if absent from the legacy slice. Tolerates a map-form
 * `bound` ({pk: true}). Drops non-64-hex entries. Throws MemberRollError on malformed input or an
 * empty result (see the fail-closed rule above).
 */
export function parseBoundSet(jsonText) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (e) {
    throw new MemberRollError('member-roll: membership file is not valid JSON: ' + (e?.message || e));
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new MemberRollError('member-roll: membership file is not an object');
  }
  const seen = new Set();
  const take = pk => {
    if (typeof pk === 'string' && HEX64.test(pk)) seen.add(pk);
  };
  if (Array.isArray(doc.bound)) {
    for (const pk of doc.bound) take(pk);
  } else if (typeof doc.bound === 'object' && doc.bound !== null) {
    for (const pk of Object.keys(doc.bound)) take(pk);
  }
  if (typeof doc.bound_at === 'object' && doc.bound_at !== null && !Array.isArray(doc.bound_at)) {
    for (const pk of Object.keys(doc.bound_at)) take(pk);
  }
  if (seen.size === 0) {
    throw new MemberRollError('member-roll: empty bound set — refusing (publishing an empty roll would hide every member)');
  }
  return [...seen].sort();
}

/** Read + parse the membership file. Throws MemberRollError on an unreadable file. */
export function readBoundSet(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new MemberRollError('member-roll: cannot read membership file ' + path + ': ' + (e?.message || e));
  }
  return parseBoundSet(text);
}

/** Order-insensitive change-detection fingerprint over the member set. */
export function rollFingerprint(members) {
  return createHash('sha256').update([...members].sort().join('\n')).digest('hex');
}

/** The exact plaintext the client parses — see the wire contract above. */
export function buildRollPayload(members, nowSec) {
  return JSON.stringify({v: 1, members, updated_at: nowSec});
}

/**
 * NIP-44 v2 ciphertext under the raw 32-byte community key (base64, as persisted in
 * community_key.b64). `nip44` is injected (the client's own nostr-tools bundle, the way
 * mailbox.mjs loads it) so this module stays dependency-free and the test can pin
 * byte-compatibility with the client's decryptForSpace.
 */
export function encryptRoll(payloadJson, communityKeyB64, nip44) {
  const key = Buffer.from(communityKeyB64, 'base64');
  if (key.length !== 32) {
    throw new MemberRollError('member-roll: community key must be 32 bytes, got ' + key.length);
  }
  return nip44.encrypt(payloadJson, new Uint8Array(key));
}

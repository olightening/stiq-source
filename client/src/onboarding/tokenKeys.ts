/**
 * Live distribution of a community's purpose-specific blind-RSA issuer public keys via a kind-30078
 * organizer-config doc (`d = stiq:token-keys`), applied through {@link applyOrgConfig} like every
 * other org-config d-tag.
 *
 * WHY THIS EXISTS: an issuer key used to reach a member ONLY inside their join code, parsed once at
 * enrollment ({@link parseJoinCode}). When a NEW purpose key is added afterwards — notably `swk`
 * (space-write) — every already-enrolled member has that field `undefined`, so their space-write
 * token draw silently falls back to blinding under the enrollment key ({@link issuerKeyForPurpose})
 * while the organizer signs with the dedicated space-write key. The unblind then fails RFC-9474
 * verification (`finalize()` → "invalid signature"), the draw is non-retryable, the wallet never
 * fills, and every space-write (channels / groups / DM gift wraps) is rejected the moment
 * `space_tokens_required` is enforced. This doc lets the organizer broadcast the keys to the whole
 * fleet so existing members converge WITHOUT re-enrolling. The keys are PUBLIC (blind-RSA issuer
 * public keys, already shipped in join codes) — safe to publish on the relay.
 *
 * It ALSO lets a SHORT join code omit the seven ~392-char issuer keys entirely: a member who enrolls
 * from a key-less code has these fields `undefined` and converges from this doc on connect, exactly
 * like an older member picking up a newly-added key.
 */
import type {EnrolledCommunity} from '../communities/communityStore';
import {isPlausibleIssuerKey} from './join';

/** kind-30078 d-tag carrying the community's issuer public keys. MUST match the organizer's literal. */
export const TOKEN_KEYS_D_TAG = 'stiq:token-keys';

/** The EnrolledCommunity issuer-key fields — every one is `string | undefined`. */
type IssuerKeyField =
  | 'postIssuerPublicKey'
  | 'readIssuerPublicKey'
  | 'picWriteIssuerPublicKey'
  | 'picReadIssuerPublicKey'
  | 'audWriteIssuerPublicKey'
  | 'audReadIssuerPublicKey'
  | 'spaceWriteIssuerPublicKey';

/**
 * Short wire key (the SAME compact keys the join code uses) → EnrolledCommunity field. Kept in
 * lockstep with the join-code parser (onboarding/join.ts) and the organizer's join-code / token-keys
 * builders so a member converges to the identical key whether it arrives by code or by this doc.
 */
const ISSUER_KEY_FIELDS: ReadonlyArray<readonly [string, IssuerKeyField]> = [
  ['pk', 'postIssuerPublicKey'],
  ['rk', 'readIssuerPublicKey'],
  ['pwk', 'picWriteIssuerPublicKey'],
  ['prk', 'picReadIssuerPublicKey'],
  ['awk', 'audWriteIssuerPublicKey'],
  ['ark', 'audReadIssuerPublicKey'],
  ['swk', 'spaceWriteIssuerPublicKey'],
];

/**
 * Parse a `stiq:token-keys` doc into a community patch of issuer keys. Each value is validated with
 * the SAME bound as the join-code parser (isPlausibleIssuerKey) so a malformed/foreign doc can never
 * smuggle a bad key into the blind-RSA import — any malformed key ⇒ the whole doc is ignored (null,
 * fail closed). Absent keys are omitted, so communityStore.upsert's absent-stays-absent guard
 * preserves whatever the member already holds (from a join code or an earlier refresh). Returns null
 * when nothing recognizable is present, matching the sibling org-config parsers, so the caller leaves
 * state — and its per-d rollback watermark — untouched.
 */
export function parseTokenKeysEvent(content: string): Partial<EnrolledCommunity> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const patch: Partial<EnrolledCommunity> = {};
  for (const [wire, field] of ISSUER_KEY_FIELDS) {
    const v = obj[wire];
    if (typeof v === 'string' && v) {
      if (!isPlausibleIssuerKey(v)) return null; // one bad key ⇒ ignore the whole doc (fail closed)
      patch[field] = v;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

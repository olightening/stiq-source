/**
 * Organizer control over the Pictures modality — how big a picture may be, how much a member may
 * post per period, and whether pictures are allowed at all.
 *
 * Delivered as a kind-30078 doc (d=stiq:picture-limits) signed by the organizer, exactly like the
 * post-rules / tag-policy / labels docs. Consumed on the composer hot path to gate the "Add picture"
 * button and disable Add when a picture would exceed the per-period allowance.
 *
 * Enforcement split (deliberate, to keep the relay blind — see picture.ts):
 *   - allow / maxRes / maxColours / per-period allowance  → CLIENT-side only. Posts are relay-blind
 *     (throwaway per-post signatures), so the relay can neither attribute a member's cumulative
 *     picture bytes across a period nor tell a picture from any other bytes. These are enforced here.
 *   - maxBytesPerPicture → backstopped by the relay's CONTENT-NEUTRAL per-event size cap
 *     (max_event_bytes). The relay bounds total event size without knowing it's a picture; we keep
 *     maxBytesPerPicture ≤ that cap so a picture never trips a confusing generic "event too large".
 */

export const KIND_PICTURE_RULES = 30078;
export const PICTURE_RULES_D_TAG = 'stiq:picture-limits';

export interface PictureRules {
  /** Whether members may attach pictures at all. Off ⇒ the composer hides the "Add picture" option. */
  allow: boolean;
  /** Per-period byte budget for one member (token bytes). 0 = unlimited. */
  allowanceBytes: number;
  /** Length of the allowance window in hours (the budget resets each window). */
  periodHours: number;
  /** Hard per-picture byte cap (token bytes). Keep ≤ the relay's max_event_bytes. */
  maxBytesPerPicture: number;
  /** Largest resolution (px, square) the composer offers. */
  maxRes: number;
  /** Largest palette size the composer offers. */
  maxColours: number;
}

export const DEFAULT_PICTURE_RULES: PictureRules = {
  allow: true,
  allowanceBytes: 128 * 1024,
  periodHours: 24,
  maxBytesPerPicture: 48 * 1024,
  maxRes: 256,
  maxColours: 64,
};

/** Compact on-wire shape (kind-30078 content). */
interface PictureRulesWire {
  al?: boolean;
  ab?: number;
  ph?: number;
  mbp?: number;
  mr?: number;
  mc?: number;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}
function posInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && v > 0 && Number.isFinite(v) ? Math.floor(v) : fallback;
}

export function encodePictureRules(r: PictureRules): PictureRulesWire {
  return {al: r.allow, ab: r.allowanceBytes, ph: r.periodHours, mbp: r.maxBytesPerPicture, mr: r.maxRes, mc: r.maxColours};
}

export function parsePictureRules(raw: unknown): PictureRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as PictureRulesWire;
  return {
    allow: typeof w.al === 'boolean' ? w.al : DEFAULT_PICTURE_RULES.allow,
    allowanceBytes: nonNegInt(w.ab, DEFAULT_PICTURE_RULES.allowanceBytes),
    periodHours: posInt(w.ph, DEFAULT_PICTURE_RULES.periodHours),
    maxBytesPerPicture: posInt(w.mbp, DEFAULT_PICTURE_RULES.maxBytesPerPicture),
    maxRes: posInt(w.mr, DEFAULT_PICTURE_RULES.maxRes),
    maxColours: posInt(w.mc, DEFAULT_PICTURE_RULES.maxColours),
  };
}

/** Repair a possibly-old-shape persisted value to a complete PictureRules (defense-in-depth). */
export function normalizePictureRules(r: PictureRules | null | undefined): PictureRules {
  if (!r || typeof r !== 'object') return DEFAULT_PICTURE_RULES;
  return {
    allow: typeof r.allow === 'boolean' ? r.allow : DEFAULT_PICTURE_RULES.allow,
    allowanceBytes: nonNegInt(r.allowanceBytes, DEFAULT_PICTURE_RULES.allowanceBytes),
    periodHours: posInt(r.periodHours, DEFAULT_PICTURE_RULES.periodHours),
    maxBytesPerPicture: posInt(r.maxBytesPerPicture, DEFAULT_PICTURE_RULES.maxBytesPerPicture),
    maxRes: posInt(r.maxRes, DEFAULT_PICTURE_RULES.maxRes),
    maxColours: posInt(r.maxColours, DEFAULT_PICTURE_RULES.maxColours),
  };
}

/** Parse a kind-30078 event's content into PictureRules (null if malformed). */
export function parsePictureRulesEvent(content: string): PictureRules | null {
  try {
    return parsePictureRules(JSON.parse(content));
  } catch {
    return null;
  }
}

export type PictureViolation = 'not-allowed' | 'too-large' | 'over-allowance';

/**
 * Check a candidate picture against the rules. `weightBytes` is the token size (pixelEngine.weight);
 * `spentBytes` is what the member has already spent this period. Returns the violations (empty ⇒ ok).
 */
export function evaluatePicture(weightBytes: number, spentBytes: number, rules: PictureRules): PictureViolation[] {
  const out: PictureViolation[] = [];
  if (!rules.allow) out.push('not-allowed');
  if (rules.maxBytesPerPicture > 0 && weightBytes > rules.maxBytesPerPicture) out.push('too-large');
  if (rules.allowanceBytes > 0 && spentBytes + weightBytes > rules.allowanceBytes) out.push('over-allowance');
  return out;
}

/** Human-readable reason for a violation, for the composer's inline hint. */
export function pictureViolationMessage(v: PictureViolation, rules: PictureRules): string {
  switch (v) {
    case 'not-allowed':
      return 'Pictures are turned off in this community.';
    case 'too-large':
      return `This picture is too large — pick a smaller size (max ${Math.round(rules.maxBytesPerPicture / 1024)} KB).`;
    case 'over-allowance':
      return "Over this period's picture allowance — choose a smaller size or wait for the next period.";
  }
}

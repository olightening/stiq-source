/**
 * Pure tor-version parsing + comparison for the client's warn-only `>=0.4.8` guard.
 *
 * The embedded IPtProxy/tor-android daemon must be >=0.4.8 so it transparently solves the
 * onion-service proof-of-work puzzle (T5). This helper only READS and compares the version the
 * daemon reports; it NEVER gates or blocks connect. Kept dependency-free (no imports) so it is
 * trivially unit-testable and safe to call on any platform.
 */

/** Minimum tor version whose build solves onion-service PoW transparently. Warn-only threshold. */
export const TOR_MIN_SUPPORTED_VERSION = '0.4.8';

/**
 * Parse a dotted tor version ("0.4.8.22") into its numeric components. Supports 3- or 4-segment
 * strings. Returns null when the string has fewer than 3 numeric parts or any part is not a number,
 * so callers can fail open on an odd/garbage string instead of comparing nonsense.
 */
export function parseTorVersion(v: string): number[] | null {
  const parts = v.split('.').map(Number);
  if (parts.length < 3 || parts.some(n => Number.isNaN(n))) {
    return null;
  }
  return parts;
}

/**
 * True when `actual` is at least `min` (component-wise, missing trailing components treated as 0).
 * Fail-open: if `actual` is unparseable, returns true — an odd version string must NOT trip the
 * warn-only guard (we'd rather stay silent than warn-spam on a string we don't understand). If
 * `min` is unparseable the comparison also can't be trusted, so it likewise returns true.
 */
export function torVersionAtLeast(actual: string, min: string): boolean {
  const a = parseTorVersion(actual);
  const b = parseTorVersion(min);
  if (a === null || b === null) {
    return true;
  }
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) {
      return true;
    }
    if (av < bv) {
      return false;
    }
  }
  return true; // all components equal → actual >= min
}

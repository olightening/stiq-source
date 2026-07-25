/**
 * Posting-guidelines seen-state — which covenant VERSION this device has already had the composer
 * rules banner auto-opened for (design_handoff_community_rules "first visit" contract, extended to
 * re-open once per NEW version, mirroring the log page's note tuck-away version contract).
 *
 * Per-device, best-effort (a lost write just re-opens the banner once — never data loss), keyed by
 * space id so one device sitting in several communities keeps independent seen-state.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_BASE = 'stiq.guidelines.seenVer';

const keyFor = (spaceId: string): string => `${KEY_BASE}.${spaceId}`;

/** The covenant version the banner last auto-opened for on this device (0 = never). */
export async function guidelinesSeenVersion(spaceId: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(spaceId));
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0; // fresh state is fine — the banner just opens once more
  }
}

/** Record that the member collapsed (= saw) the banner for this covenant version. */
export function markGuidelinesSeen(spaceId: string, version: number): void {
  if (!Number.isFinite(version) || version < 1) return;
  AsyncStorage.setItem(keyFor(spaceId), String(Math.floor(version))).catch(() => {
    /* best-effort — a lost write re-opens the banner once */
  });
}

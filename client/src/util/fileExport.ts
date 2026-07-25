/**
 * File-export TS layer — save real files (e.g. a built .ics or a guest-list .csv) into the device's
 * Downloads collection via the native `StiqFiles` module.
 *
 * Same duck-typed, never-throws, absent-safe wrapper shape as src/power/reliability.ts,
 * src/push/unifiedPush.ts, and src/util/clipboard.ts: an APK built before StiqFiles existed (or a
 * jest/host environment) simply has no such native module, and every export here degrades to a clean
 * `false` instead of throwing, so callers never have to null-check `NativeModules.StiqFiles`
 * themselves.
 *
 * No RN `fs` dependency — StiqFiles is a native module the integrator is adding in parallel (it saves
 * into the device's Downloads collection natively and resolves the saved name/uri); this file only
 * codes against its interface.
 */
import {NativeModules} from 'react-native';

/** The native `StiqFiles` module's interface. It resolves the saved file's name/uri on success; the
 *  wrapper below only cares that the promise resolved, not what it resolved to. */
interface StiqFilesModule {
  saveTextFile(name: string, mime: string, content: string): Promise<string>;
}

function nativeModule(): StiqFilesModule | undefined {
  return (NativeModules as {StiqFiles?: StiqFilesModule}).StiqFiles;
}

/** Conservative cross-filesystem file-name length clamp — well under NTFS (255 UTF-16 units), ext4
 *  (255 bytes), and FAT32/exFAT (255 UTF-16 units) limits even once multi-byte characters are counted. */
const MAX_FILE_NAME_LENGTH = 128;

const FALLBACK_NAME = 'stiq-export';

/**
 * Sanitize a proposed file name before it reaches the native save call: strips control characters and
 * path separators (defense in depth against a native side that writes straight into the Downloads
 * collection by name — this must never be able to escape that directory or smuggle a raw control
 * byte), also strips the classic Windows-reserved characters (the Downloads collection may sit on a
 * FAT32/exFAT volume), clamps length, and falls back to a non-empty default name when the result would
 * otherwise be blank.
 */
export function sanitizeFileName(name: string): string {
  const stripped = name
    // eslint-disable-next-line no-control-regex -- deliberately matching C0 controls + DEL
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  const clamped = stripped.slice(0, MAX_FILE_NAME_LENGTH).trim();
  return clamped || FALLBACK_NAME;
}

/**
 * Save `content` as a text file named `name` (MIME `mime`) into the device's Downloads collection via
 * the native StiqFiles module. Resolves `false` — NEVER throws — when the module is absent (an APK
 * built before it was added, or a jest/host environment) or the native call rejects for any reason
 * (e.g. the user denied storage access, or the device is out of space).
 */
export async function saveTextFile(
  name: string,
  mime: string,
  content: string,
  native: StiqFilesModule | undefined = nativeModule(),
): Promise<boolean> {
  if (!native) return false;
  try {
    await native.saveTextFile(sanitizeFileName(name), mime, content);
    return true;
  } catch {
    return false;
  }
}

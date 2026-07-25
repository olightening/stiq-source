/**
 * Clipboard writes for SENSITIVE text (npub, nsec, join/invite codes) — routes through the native
 * `StiqKeystore.copySensitive` when present, falling back to the plain cross-platform
 * `@react-native-clipboard/clipboard` path otherwise.
 *
 * WHY this exists instead of a plain `Clipboard.setString(text)`: that call writes a pasteboard item
 * that (a) syncs via iOS Universal Clipboard to the user's other signed-in Apple devices, and (b)
 * persists in clipboard history/managers indefinitely. Neither is acceptable for a join code or a key
 * — a join code embeds a channel's E2E secret (see buildInviteLink/parseInviteLink in
 * channels/invite.ts) and an nsec/npub is identity material. The native `copySensitive` instead sets
 * `.localOnly` (never leaves this device) and a 120s `.expirationDate` (iOS purges it from pasteboard
 * history on its own), so a copy-then-forget doesn't linger.
 *
 * Same duck-typed, never-throws, graceful-degradation shape as client/src/tor/dormancy.ts: absent
 * native module (Android, an older iOS binary that predates this method, or jest) silently falls back
 * to plain `Clipboard.setString`, so the text still gets copied — just without the iOS-only privacy
 * options. Callers never need to branch on platform or native-module presence themselves.
 */
import {NativeModules} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

/** The subset of the native StiqKeystore module this wrapper touches. Optional so an absent module
 *  (non-iOS build, older native binary, or jest) is handled by the plain-Clipboard fallback path. */
interface StiqKeystoreCopy {
  copySensitive?: (text: string) => void;
}

/**
 * Copy sensitive text (npub, nsec, join/invite links) to the clipboard with iOS's Universal-Clipboard
 * sync disabled and a short pasteboard expiry, when the native module supports it. Never throws.
 *
 * Falls back to plain `Clipboard.setString(text)` when `StiqKeystore.copySensitive` is absent —
 * Android (no such native method exists there), a pre-update iOS binary, or a jest environment with no
 * native modules at all. The fallback still copies the text; it just doesn't carry the localOnly/
 * expiration protections, same as every copy did before this util existed.
 */
export function copySensitive(
  text: string,
  native: StiqKeystoreCopy | undefined = (NativeModules as {StiqKeystore?: StiqKeystoreCopy}).StiqKeystore,
): void {
  try {
    if (native?.copySensitive) {
      native.copySensitive(text);
      return;
    }
  } catch {
    // fall through to the plain-clipboard path below
  }
  Clipboard.setString(text);
}

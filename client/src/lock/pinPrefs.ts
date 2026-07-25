/**
 * Persists the user's choice to enable or disable the PIN lock screen.
 * Stored in AsyncStorage so it survives restarts without touching the secure keystore.
 * Default: enabled (true) — new installs always start with lock protection active.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {PIN_LOCK_UI} from '../config';

const KEY = 'stiq.lock.pinEnabled';

/**
 * The EFFECTIVE "is the PIN lock screen in play" preference — what AppRuntime loads into
 * `this.pinEnabled` at init.
 *
 * Normally this is just the persisted choice (defaulting to enabled). When the PIN UI ships dark
 * (PIN_LOCK_UI false — config.ts, bugs 5+6) the honest answer is `false` regardless of what is
 * stored: with no LockScreen to reach and no Settings toggle to reach it with, the lock screen is
 * simply not part of this build. Answering the stored `true` instead would strand every member who
 * is on a PIN today — AppRuntime.getSnapshot() withholds the ENTIRE feed while
 * `lock === 'locked' && pinEnabled`, a cold start always constructs AutoLock 'locked', and the only
 * things that ever unlock it are the (now unreachable) LockScreen and enrollment. They would sit on
 * a permanently empty feed with no way out. See PIN_LOCK_UI's doc comment for the full trap.
 *
 * This reports a preference; it changes no security primitive. `false` here is not a new state — it
 * is the long-shipping, already-tested configuration of a member who simply turned the toggle off.
 */
export async function loadPinEnabled(): Promise<boolean> {
  if (!PIN_LOCK_UI) {
    return false;
  }
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v !== 'false';
  } catch {
    return true;
  }
}

export async function savePinEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, enabled ? 'true' : 'false');
  } catch {
    // best effort
  }
}

/**
 * Duck-typed JS wrappers for the native Tor dormancy transitions (T4).
 *
 * `torDormant()` / `torActive()` issue the SIGNAL DORMANT / SIGNAL ACTIVE equivalents to the running
 * daemon via the native `StiqArti.setDormant()` / `setActive()` @ReactMethods, which call straight
 * into arti-ffi's `arti_set_dormant()` (a direct JNI call setting `DormantMode::Soft`/`Normal` on the
 * already-built TorClient — see arti-ffi/src/lib.rs). There is no control socket or other IPC in the
 * path; it is an in-process function call, so a backgrounded app can idle Tor into a low-power
 * dormant state (and wake it on resume) instead of force-killing and cold-restarting the daemon.
 *
 * Like `requestNewTorCircuit` (App.tsx) and `newCircuit`, these live OFF the TorBackend interface:
 * they are direct one-shot native calls, NOT part of the manager's state machine, so TorManager
 * stays a pure, jest-tested transport authority with no new event kind or ConnectionState. They are
 * an importable, testable module (rather than an inline App.tsx closure) so the call-through and the
 * absent-native no-op are unit-tested without mocking react-native's NativeModules.
 *
 * Both no-op silently when the native module — or the specific method — is absent (non-Android build
 * or jest), and never throw.
 */
import {getTorDaemonControl, type TorDaemonControl} from './daemonControl';

/** The subset of the active daemon's control surface these wrappers touch. Both methods are
 *  optional so an older native build (or the absent module on non-Android/jest) is handled by the
 *  no-op path.
 *
 *  The module is resolved through {@link getTorDaemonControl}, NOT by reading
 *  `NativeModules.StiqArti` directly — routing every off-seam call through that one chokepoint is
 *  what keeps the engine choice single-sourced with createTorBackend() (see daemonControl.ts). */
type StiqArtiDormancy = Pick<TorDaemonControl, 'setDormant' | 'setActive'>;

/**
 * Put the running Tor daemon into its low-power dormant state (SIGNAL DORMANT). Never throws.
 * Returns `true` when the signal was DISPATCHED to the native module (method present), `false` only
 * when the module/method is absent (non-Android build / jest / an older native build).
 *
 * Note the return value reports *dispatch*, not *delivery*: the native `setDormant` @ReactMethod is
 * deliberately fire-and-forget (no Promise, wrapped in its own try/catch — see StiqArtiModule.kt), so
 * a live daemon that never consumes the signal simply stays warm (not idled) — a benign outcome that
 * is preferable to throwing away a bootstrapped daemon over a transient JNI hiccup. The caller
 * (App.tsx `enter()`) uses a `false` return as its cue to fall back to a force-kill teardown for the
 * case that actually warrants it — no native module to signal through; the *no live daemon* case is
 * handled by its own `manager.isLive()` pre-check. A genuine daemon death is detected independently
 * by the `isLive()` check on the resume path, not by this return value.
 */
export function torDormant(
  native: StiqArtiDormancy | undefined = getTorDaemonControl(),
): boolean {
  try {
    if (native?.setDormant) {
      native.setDormant();
      return true;
    }
    return false;
  } catch {
    // native module absent (non-Android build) or the call failed — treat as not-signalled
    return false;
  }
}

/**
 * Wake the running Tor daemon back to an active session (SIGNAL ACTIVE). Never throws. Returns
 * `true` when the signal was dispatched to the native module (method present); `false` only when the
 * module/method is absent. Dispatch-not-delivery, same best-effort semantics as {@link torDormant}
 * (exit()'s real resume correctness comes from the subsequent `isLive()` check, not this return).
 */
export function torActive(
  native: StiqArtiDormancy | undefined = getTorDaemonControl(),
): boolean {
  try {
    if (native?.setActive) {
      native.setActive();
      return true;
    }
    return false;
  } catch {
    // native module absent (non-Android build) or the call failed — treat as not-signalled
    return false;
  }
}

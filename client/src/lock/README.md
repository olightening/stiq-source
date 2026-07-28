# src/lock — auto-lock, dual PIN, duress wipe (PLAN.md §3.5 / Steps 10–11)

Protects the app at rest. The PIN entry screens (LockScreen / OnboardingScreen's PIN step) are
native UI; this is the state + verification logic behind them. There is no biometric unlock path
anywhere in this codebase — see the native-seam note below.

- `autolock.ts` — `AutoLock` locks after `timeoutMs` of inactivity (default `AUTO_LOCK_MS` =
  5 min, config.ts). `touch()` refreshes the timer on user activity; `unlock()` opens the app
  after a successful PIN check; `lock()` is immediate (idle timeout, or any explicit caller).
  Holds lock **state** only — never touches keys or data. Passing `Infinity` as `timeoutMs`
  disables the idle timer (`arm()` never schedules one). As of the 2026-07-15 bug round, STIQ's
  production wiring (App.tsx) does exactly that by default, and also no longer locks on
  backgrounding — the app now re-locks only on a genuine cold start (user decision; see
  BUGROUND_COORDINATION.md and config.ts's `IDLE_LOCK_ENABLED` / `LOCK_ON_BACKGROUND`). The
  class's timer/arm/disarm mechanics are unchanged and fully restorable — every test in
  `autolock.test.ts` still constructs `AutoLock` with a real finite timeout.
- `pin.ts` — `PinVault` registers two PIN slots (standard + duress) sealed with a salted,
  high-iteration KDF over a per-PIN salt in the hardware-backed `SecureStorage`. `verify(pin)` returns
  `'standard' | 'duress' | 'invalid'`. Blobs are scheme-tagged, and the CURRENT scheme is `pbk1:…` —
  **native PBKDF2-HMAC-SHA256** (`nativeKdf.ts` → `StiqKdfModule`, 100k iterations). It replaced the
  pure-JS `scrypt1` KDF, which measured ~11 seconds per unlock on-device under Hermes. Older blobs
  (`scrypt1:…`, and the oldest untagged single-SHA-256 `salt:hash`) are still verified with their
  original KDF and transparently re-sealed to `pbk1` on the next successful entry, so no existing user
  is ever locked out.
- `nativeKdf.ts` — the `pbk1` bridge. Native when `StiqKdf` is registered (it is, via
  `MainApplication.kt`); a byte-identical pure-JS `pbkdf2Async` fallback keeps a mis-built app usable
  rather than locking the user out.
- `attemptLimiter.ts` — `PinAttemptLimiter` persists a consecutive-failure counter in secure storage
  and, past a small free allowance, imposes an escalating lockout (verify rejects without checking the
  PIN). Wired into every PIN surface via `PinVault.verify`.
- `duress.ts` (Step 11) — `performDuressWipe` irrecoverably clears the key + credential
  (`Identity.reset`), both PINs (`PinVault.clear`), the cache incl. DMs (`EventStore.clear`),
  and the in-memory session. Each step is best-effort and independent, so a partial failure
  still leaves the device as clean as possible.
- `controller.ts` (Step 11) — `LockController.submitPin` routes: standard → unlock; duress →
  wipe then unlock to a now-blank app (**indistinguishable** from a normal unlock); invalid →
  stay locked. The `'wiped'` outcome is internal/test-only; the UI renders it identically to
  `'unlocked'`.

## Notes

- PINs are low-entropy, so the default `HashFn` is `nativePinHash` — an iterated, salted KDF
  (finding #20) — and `PinAttemptLimiter` rate-limits attempts (finding #21). The `HashFn` seam stays
  injectable so tests substitute a fast hash. KDF params live in `nativeKdf.ts` (and, for the legacy
  scheme, `pin.ts`) and are self-described by the scheme tag, so they can be raised behind a new tag
  with verify re-sealing old blobs automatically.
- The duress slot has no setter in the product today: the only caller of `PinVault.setPins` is
  `AppRuntime.completeEnrollment`, and the only caller of THAT (`OnboardingScreen`) passes `''` for the
  duress PIN, which clears the slot. `LockController`'s duress branch and `performDuressWipe` are
  complete and tested, but nothing can populate the PIN that triggers them — restoring the coercion
  defence needs a duress-PIN entry surface, not just `PIN_LOCK_UI`.
- Native seam: WebCrypto `subtle.digest` needs a polyfill on RN. There is no biometric unlock
  gate anywhere in this codebase (an older version of this note implied one) — the only unlock
  path is PIN entry via `LockController.submitPin`.

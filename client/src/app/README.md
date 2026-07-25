# src/app — navigation shell (PLAN.md §3.3, §3.5, §2)

Ties the screens together. A lightweight router (no navigation library — those pull heavy
native deps) selects one screen from app state; production can swap in `@react-navigation`.

- `route.ts` — `resolveScreen({enrolled, lock})` → `'onboarding' | 'lock' | 'feed'`.
  Onboarding gates everything; then the lock gates an enrolled app; then the feed.
- `AppShell.tsx` — renders the screen for the current state; supplied state by `App.tsx`.
- `screens/OnboardingScreen` — blank-app entry (two-way scan plugs in here).
- `screens/LockScreen` — locked entry (PIN pad / biometric plugs into the lock controller).
- `screens/MainScreen` — **Feed** / **Moderation Log** tabs + the composer + a connection
  banner. The feed reads from cache, so it renders even while offline.
- `screens/ModerationLogList` — hidden posts attributed to the moderator npub (Step 9).

## AppRuntime — the live wiring

`AppRuntime.ts` derives the screen state reactively from the real pieces (no longer
hardcoded):

- `enrolled` ← `Identity.isEnrolled()` (keystore);
- `lock` ← `AutoLock` + `LockController` (with the **duress wipe** wired into `onDuress`);
- `feed` ← `buildFeed(store)` over the cache;
- `post()` / `vote()` ← sign via `Identity` + publish via the injected relay.

It is injected with `secureStorage`, `store`, and `publish`, so the whole lifecycle is
unit-tested end to end (`AppRuntime.test.ts`): **onboarding → enrolled+locked → unlocked
feed → composed post appears → duress → onboarding**. When `secureStorage` is null (no
native keystore on this build) it resolves to onboarding.

The only remaining seam is the native *implementations*: `SecureStorage` (StiqKeystore),
the Tor-routed socket (StiqSocket), and the SQLite cache. `App.tsx` supplies the native
ones on device and falls back here (→ onboarding). On-device validation against real
hardware is the last step.

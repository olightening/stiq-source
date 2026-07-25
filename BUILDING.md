# Building STIQ

Covers the client (Android + iOS), the relay, and the organizer dashboard. Read the
`@noble/hashes` section before your first client build — it is the one trap here that produces a
*working-looking* app that cannot enrol anyone.

---

## Client

```sh
cd client
npm ci               # NOT `npm install` — see below
npm run verify-deps  # MUST exit 0
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest
```

### The `@noble/hashes` trap — read this

`src/onboarding/webcryptoShim.ts` (the pure-JS blind-RSA path behind credential enrolment)
imports `@noble/hashes/sha1`, `/sha256`, `/sha512`. Those sub-paths exist in **v1.x**.

`nostr-tools` and its dependencies (`@noble/curves`, `@scure/bip32`, `@scure/bip39`) require
**v2**, which *relocated* them — `sha256`/`sha512` moved to `/sha2`, `sha1` to `/legacy`.

The lockfile pins the tree that works: **v1.8.0 hoisted at the top** (where the shim resolves)
and **v2 nested** under the transitive consumers. A bare `npm install`, or an `npm dedupe`, can
hoist v2 over the pinned v1.8.0. When that happens:

- `tsc`, `jest`, and Metro can no longer resolve `@noble/hashes/sha256`, **or**
- worse, the build succeeds and blind-RSA dies at runtime under Hermes — an APK that installs,
  launches, and **cannot enrol a single member**.

**Rules:**

- Use `npm ci`. It reproduces the lockfile exactly. Avoid a bare `npm install` unless you re-run
  `npm run verify-deps` afterwards.
- `npm run verify-deps` is the hard gate. `postinstall` runs it in `--warn` mode, so any install
  that causes drift complains immediately.
- If drift happens, either of these fixes it:
  ```sh
  npm ci --legacy-peer-deps
  npm install @noble/hashes@1.8.0 --legacy-peer-deps   # surgical
  ```

The peer-dependency drift on `react-native-get-random-values` is why `--legacy-peer-deps` shows
up; plain `npm ci` works in CI today, so try it first.

### Android

Needs a **JDK 17** (Android Studio's bundled JBR works) and the Android SDK. Put the SDK path in
`client/android/local.properties` — it is machine-specific and deliberately not committed:

```properties
sdk.dir=/path/to/Android/sdk
```

```sh
cd client/android
./gradlew assembleRelease      # what you distribute
./gradlew assembleDebug        # Metro-less dev/test build ONLY
```

**Always distribute `assembleRelease`.** A debug-variant APK carries
`android:debuggable=true`, which forces ART into debug mode and slows the *entire* native layer —
SQLCipher, the Tor service, the RN bridge, rendering — on every device that installs it. On
non-flagship phones the difference is the app feeling broken. Release is also R8-minified with
`shrinkResources` (roughly 64 MB vs 95 MB for arm64).

#### The signing key is a one-way door — decide it before your first build

Out of the box, release is signed with the **committed debug keystore** (`app/build.gradle`:
`debug.keystore`, store password `android`, alias `androiddebugkey`). That keeps
"install the release APK over the old one" working during development, and it is why the repo
builds a working APK with no setup. It is **not** suitable for a real community: the key is public,
so anyone can build an APK that Android will accept as an update to yours.

**Generate your own keystore before you hand the first APK to anyone.** Android identifies an
installed app by `applicationId` *plus signing certificate*. Once members install a
debug-keystore build, an APK signed with your own key is refused
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and the only way forward is uninstall-and-reinstall —
which destroys the hardware-keystore identity, because it is non-exportable and there is no seed
phrase (PLAN.md §3.3). Switching later means every member loses their account.

```sh
keytool -genkeypair -v -keystore stiq-release.keystore -alias stiq \
        -keyalg RSA -keysize 4096 -validity 10000
```

Point `signingConfigs.release` at it, keep the keystore and its passwords out of the repo (inject
via `~/.gradle/gradle.properties` or the environment), and **back it up** — losing it has the same
effect as changing it.

#### Distributing updates

Members do not get updates automatically until you wire the in-app update repo, and the **first**
install is always a manual sideload — the app cannot fetch itself before it exists on the device.

Once someone has the app, the update path is: the relay serves a signed F-Droid repository from
`fdroid_repo_dir` (`relay/main.go`; unset ⇒ the handler is nil and `/fdroid/` 404s), you publish
into it with [`relay/deploy/fdroid-publish.sh`](relay/deploy/fdroid-publish.sh), and the join code
carries the pins the client verifies before installing:

| Join-code field | Environment variable read by the organizer | What it pins |
|---|---|---|
| `up` | `STIQ_UPDATE_REPO_PATH` | repo path, e.g. `/fdroid/repo` |
| `uf` | `STIQ_UPDATE_REPO_CERT` | SHA-256 of the **index-signing** cert |
| `af` | `STIQ_UPDATE_APP_CERT` | SHA-256 of the **APK signing** cert |
| `ua` | `STIQ_UPDATE_APP_ID` | application id |

Two distinct keys: the **app** key signs the APK, the **repo** key signs `index-v1.jar` only.
Never the same key. Set the variables from `fdroid-publish.sh`'s output before regenerating the
join QR; unset, the fields are simply absent and older clients ignore them.

**Bump `versionCode` AND `versionName` on every build you hand out.** Both live in
`app/build.gradle` — that file is the only place either is defined, and the only place to read the
current value. `versionCode` gates upgrades and the in-app update repo; `versionName` is the only
version a user can read back to you. Builds that all claim the same version are how a fleet
silently drifts onto stale code.

Outputs — per-ABI splits are enabled, so each device gets only its own `.so`:

```
client/android/app/build/outputs/apk/release/
    app-arm64-v8a-release.apk      ← distribute this to any modern phone
    app-armeabi-v7a-release.apk    ← only for old 32-bit ARM devices
    app-universal-release.apk      ← all ABIs; for CI or unknown targets
```

```sh
adb install -r app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

ABIs are `armeabi-v7a,arm64-v8a` only — the emulator-only x86 slices were dropped because they
roughly doubled APK size for code no real phone runs. For an x86_64 emulator, override per-build:
`./gradlew assembleDebug -PreactNativeArchitectures=x86_64`.

Key flags in `gradle.properties`: `bundleInDebug=true`, `hermesEnabled=true`,
`newArchEnabled=false` (old architecture).

R8 keeps for reflection/JNI entry points live in `app/proguard-rules.pro`. A **new** native
module, worker, or JNI-loaded class may need a keep there, or release will crash where debug
works. The existing `com.stiq.client.**Module` / `**Package` rules already cover
conventionally-named RN modules.

### iOS

Needs Xcode and CocoaPods.

```sh
cd client/ios
pod install          # generates stiq.xcworkspace — not committed
cd .. && npm run ios
```

Open `stiq.xcworkspace` (not `.xcodeproj`) if you build from the IDE. See
[`client/ios/README.md`](client/ios/README.md) for detail.

Bundle identifiers are `com.stiq.client` for the app and `com.stiq.client.tests` for the unit-test
bundle, matching the Android `applicationId`.

> **Signing is not configured, and CI cannot tell you that.** The project sets no
> `DEVELOPMENT_TEAM` and no `CODE_SIGN_STYLE`, and its only signing setting is a *development*
> identity (`CODE_SIGN_IDENTITY[sdk=iphoneos*] = "iPhone Developer"`). Before a device build,
> archive, or submission, set your team and a distribution identity — in Xcode's
> *Signing & Capabilities*, or by adding the settings to the project. The CI iOS job builds with
> `CODE_SIGNING_ALLOWED=NO`, so a green pipeline proves the app *compiles and links*, never that it
> can be signed.

The iOS app compiles in Release and runs on the simulator; the bundled-Tor seam is device-gated.
Four of its five native modules (`StiqKeystore`, `StiqPow`, `StiqSocket`, `StiqWorkManager`,
`StiqTor`) are fully functional. `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` are maintained
independently of the Android `versionName` / `versionCode` and currently lag them.

CI builds iOS on every push and asserts two things the project drifted on for months: that tor
0.4.9.x is actually linked, and that exactly one `SSL_CTX_new` symbol is present (more than one
means the two-static-OpenSSL collision is back). `pod install` succeeding is not evidence —
`xcodebuild` is.

---

## Relay

```sh
cd relay
go build ./... && go vet ./... && go test ./...
```

Go 1.24. `config.example.json` is the template; a real `config.json` is generated on the server by
`deploy/stiq-up.sh` and is gitignored.

---

## Organizer dashboard (issuer)

```sh
cd issuer
npm ci
npm test
```

> **The issuer is not a self-contained package.** `issuer.js`, `organizer-server.mjs`,
> `mailbox.mjs`, and `organizer-nostr.mjs` resolve `@cloudflare/blindrsa-ts`, `nostr-tools`, and
> `ws` out of `../client/node_modules` **at runtime**, by relative path — and four of the chained
> tests do the same. This is deliberate: `issuer/deploy/client-deps.package.json` installs those
> same dependencies beside the issuer on a real box, and `deploy/stiq-up.sh` does it for you.
>
> Consequence: `npm ci && npm test` inside `issuer/` **alone** cannot pass. It dies at
> `draw_idempotency_test` with `ERR_MODULE_NOT_FOUND`. Install the client's dependencies first:
>
> ```sh
> cd client && npm ci && cd ../issuer && npm test
> ```

---

## Server

Don't build the server pieces by hand. One command provisions the relay, the dashboard, the
enrollment mailbox, and every key — on a fresh Debian/Ubuntu box:

```sh
sudo COMMUNITY="Riverside Mutual Aid" bash deploy/stiq-up.sh
```

See [`deploy/README.md`](deploy/README.md) for the runbook and threat model, and
[`deploy/SINGLE_ONION.md`](deploy/SINGLE_ONION.md) before enabling single-onion mode.

---

## Rebranding

See [`WHITELABEL.md`](WHITELABEL.md). Read it before any find-and-replace: most occurrences of
`stiq` in the client are **wire-protocol identifiers**, not branding, and renaming them forks the
protocol.

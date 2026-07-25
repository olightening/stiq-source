# client/

React Native (TypeScript) mobile app — Android and iOS. See
[ADR 0001](../docs/adr/0001-frontend-framework.md) for the framework decision,
[PLAN.md](../PLAN.md) for the full specification, and **[BUILDING.md](../BUILDING.md) before your
first build** — there is a dependency trap that yields an app which builds cleanly and cannot
enrol anyone.

## Commands

```sh
npm ci               # NOT `npm install` — see ../BUILDING.md
npm run verify-deps  # dependency guard; must exit 0
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # jest
npm start            # Metro bundler
npm run android      # needs the Android SDK + JDK 17
npm run ios          # needs Xcode (macOS); run `pod install` in ios/ first
```

The `android/` and `ios/` native projects **are checked in** — both are configured and building.
Do not regenerate them with the React Native CLI; that would discard the native modules, the Tor
integration, the R8 keep rules, and the build configuration. `android/local.properties` and
`ios/stiq.xcworkspace` are absent by design: the first is machine-specific, the second is produced
by `pod install`.

## Layout

- `App.tsx` / `src/app/` — the shell: `AppRuntime.ts` (the application core), `AppShell.tsx`,
  routing, and the screens under `src/app/screens/`.
- `src/config.ts` — static config, feature flags, and hard invariants
  (`ALLOW_CLEARNET_FALLBACK = false`, auto-lock, PoW difficulties).
- `src/tor/` — the transport layer. `TorManager.ts` is the single transport authority: it
  bootstraps Tor, tracks state, exposes the SOCKS proxy only while connected, and **never falls
  back to clearnet** (`requireTorTransport` is the one chokepoint). `bridges.ts` holds the obfs4
  defaults and Snowflake toggle; `backend.ts`/`nativeBackend.ts` are the `StiqTor` native contract;
  `backend.fake.ts` covers tests and the no-native-module case.
- `src/nostr/` — relay and cache. `RelayClient.ts` subscribes over Tor, verifies signatures,
  dedupes, caches, and serves the feed from cache so the app renders offline. `protocol.ts` is
  pure NIP-01 framing; `store.ts` defines `EventStore` with `sqliteStore.ts` as the persistent
  (SQLCipher) implementation; `torSocket.ts` is the only place a relay connection is made and
  refuses non-`.onion` URLs.
- `src/onboarding/` — anonymous, unlinkable membership. `community.ts` parses the non-secret
  bootstrap QR; `enrollment.ts` generates the key on-device and runs the blind-credential
  exchange, so organizers never see the npub; `blindrsa.ts` is the blind-RSA seam;
  `prefetchCommunity.ts` warms the first-run path.
- `src/blind/` — blind-signed token draw, wallet, and holder proofs: the mechanism by which the
  relay verifies that *a* member may write without learning *which*.
- `src/keys/` — hardware-backed storage. `keystore.ts` signs and exposes the public key but has
  **no export path**; `nativeKeystore.ts` returns the platform secure store or fails closed.
- `src/lock/` — auto-lock, dual PIN, and `duress.ts`, whose wipe irrecoverably clears key,
  credential, PINs, and cache. A duress unlock is indistinguishable from a normal one.
- `src/feed/`, `src/channels/`, `src/dm/`, `src/events/` — the surfaces: feed and composer,
  channels/groups, NIP-17 encrypted DMs, and events.
- `src/moderation/` — reports, filtering, and the moderation log. Advisory by design: the relay
  cannot enforce a ban it cannot attribute. See the root README's moderation section.
- `src/ui/theme.ts` — the design tokens. Dark-only; see [../WHITELABEL.md](../WHITELABEL.md).
- `native/`, `android/app/src/main/java/com/stiq/client/`, `ios/stiq/` — the native modules
  (`StiqKeystore`, `StiqPow`, `StiqSocket`, `StiqWorkManager`, `StiqTor`, `StiqRsaMath`).

Most subdirectories carry their own `README.md` with the design rationale for that area.

## Testing

`npm test` runs the full Jest suite. Two notes from experience:

- Run the **full** suite rather than narrow globs when judging a change. A pre-existing teardown
  leak in the `MainScreen` tests makes narrow runs flakier than the whole suite.
- Suites are heavy; running two full suites concurrently on one machine causes timeout flakes
  that are not real failures.

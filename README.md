# STIQ

Encrypted, anonymous, append-only community platform built on **Nostr over Tor v3 hidden
services**, with a Reddit-style mobile client and encrypted direct messages.

STIQ is built for communities that need to talk to each other without the platform — or anyone
watching it — learning who they are. The relay that carries your community's traffic is
deliberately blind: it gates membership, stores ciphertext, and cannot tell which member wrote
what.

> No proprietary cryptography or routing. Everything maps to vetted open standards.
> See [PLAN.md](PLAN.md) for the specification and the architecture mandates.

## Repository layout

| Path | Purpose |
|---|---|
| [`client/`](client/) | React Native (TypeScript) mobile app — feed, spaces, votes, comments, DMs, bundled Tor. |
| [`relay/`](relay/) | Go Nostr relay (khatru + Badger): blind-credential admission, Tor-only, zero-logging. |
| [`issuer/`](issuer/) | Organizer dashboard (`node organizer-server.mjs`) — invites, blind signing, moderator roster, limits. |
| [`deploy/`](deploy/) | **One-command community installer** (`deploy/stiq-up.sh`) — relay + dashboard, co-located. |
| [`proto/`](proto/) | Protocol notes: event kinds and NIP usage shared by client and relay. |
| [`docs/`](docs/) | Architecture Decision Records and design docs. |
| [`PLAN.md`](PLAN.md) | Specification, architecture mandates, build record. |
| [`BUILDING.md`](BUILDING.md) | How to build each component — **read before your first client build**. |
| [`WHITELABEL.md`](WHITELABEL.md) | Rebranding: which `stiq` strings are branding and which are wire protocol. |

## Hosting a community (plug-and-play)

Stand up your own STIQ community on a fresh Debian/Ubuntu server with one command — it
provisions the membership-gated relay **and** the organizer dashboard together, generating every
key on the box:

```sh
sudo COMMUNITY="Riverside Mutual Aid" bash deploy/stiq-up.sh
```

The relay and dashboard are **co-located by design**: the dashboard binds loopback and is
reachable only over its client-authorized onion or an SSH tunnel — and whoever can reach the host
already holds the issuer key, organizer key, and onion key. Dashboard access therefore *is* full
community access, with no weaker remote admin surface to mislead you. See
[`deploy/README.md`](deploy/README.md) for the runbook and threat model.

Every key for your community is generated on your server. Nothing in this repository is shared
with, or reports to, any community including ours.

**The client needs no per-community build.** The relay address and issuer public key travel in
the join code, so one APK joins any community (PLAN.md §3.3).

## Security mandates (summary — full text in PLAN.md §3)

- **Relay:** Tor v3 `.onion` only, no clearnet, zero IP logging; writes admitted by a valid,
  unspent blind credential — the relay learns that *a* member may write, never *which*.
- **Client:** bundled Tor with a transport ladder, no clearnet fallback, no telemetry (CI fails
  the build if an analytics or crash-reporting SDK appears in the dependency tree), SQLCipher
  cache siloed per community.
- **Identity:** join-code onboarding; `nsec` and credential in a hardware-backed keystore,
  non-exportable — no seed phrase, no backup.
- **Authorship:** posts, votes, and comments ride one-time blind-signed credentials.
- **Device compromise:** auto-lock; duress PIN that irrecoverably wipes the key and cache.

### Moderation is advisory — by design

Because the relay cannot tell whose event is whose, it **cannot enforce a ban**. Hides, bans, and
reports are advisories that conforming clients honor; a modified client can ignore them and keep
publishing. Moderation in STIQ constrains what members *see*, not what the relay *accepts*.

This is a deliberate trade: authorship-blindness and server-enforced bans are mutually exclusive,
and STIQ chooses blindness. Communities that need enforced expulsion should rotate the community
credential, which the organizer dashboard supports. If that trade is wrong for your threat model,
STIQ is the wrong tool — better to know that from the README than to discover it in the field.

## Building

> Native device builds need the platform toolchains (Android SDK + JDK 17; Xcode for iOS).

```sh
cd client
npm ci              # NOT `npm install` — see BUILDING.md
npm run verify-deps # dependency guard; must exit 0
npm run typecheck && npm run lint && npm test
npm run android
```

```sh
cd relay
go build ./... && go vet ./... && go test ./...
```

### One app, two Tor engines (Android)

The Android client builds in **two flavors from the same codebase** — identical features, one JS
bundle, same application ID and signing key, so a device can switch engines without losing its
identity:

| Flavor | Tor engine | Build command |
|---|---|---|
| `arti` | [Arti](https://gitlab.torproject.org/tpo/core/arti) — Rust, in-process; connects in seconds and bundles the Lyrebird / Snowflake / WebTunnel bridge transports | `./gradlew assembleArtiRelease` |
| `ctor` | Classic C-tor daemon (`tor-android` + IPtProxy) — the battle-tested engine | `./gradlew assembleCtorRelease` |

A plain `assembleRelease` builds both. An installed APK reports its engine in the version name
(`…-arti` / `…-ctor`). The JavaScript layer probes at startup for whichever native engine is
present — there is no per-flavor JS, and engine-specific Kotlin lives only in the `src/arti/` and
`src/ctor/` source sets, so neither flavor ever compiles against the other's engine. Flavor
details and traps are in [BUILDING.md](BUILDING.md).

> **[BUILDING.md](BUILDING.md) is not optional reading.** A bare `npm install` can hoist a
> dependency that makes the app build cleanly and then fail to enrol anyone at runtime; debug
> APKs ship `android:debuggable=true`, which slows the whole native layer on real devices; and the
> **signing key is a one-way door** — swapping it after members have installed forces an uninstall,
> which destroys their identity. All three are documented there, with the guards that catch them.

## Status

The original 21-step plan is complete, and most of the product was built after it (PLAN.md §5).
Android ships to real communities.

**iOS is not shippable yet.** It compiles in Release and runs on the simulator, and four of its
five native modules (`StiqKeystore`, `StiqPow`, `StiqSocket`, `StiqWorkManager`, `StiqTor`) are
functional with the bundled-Tor seam device-gated — but the project carries no signing team and
the CI `xcodebuild` job is failing. See [client/ios/README.md](client/ios/README.md).

## Security reporting

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for a security bug.

## About this repository

This is the public source mirror of STIQ. It contains the full buildable product — client, relay,
issuer, and installer — and no credentials, keys, or infrastructure details from any live
deployment. Onion addresses and server addresses are replaced with obvious placeholders; every
secret is generated per-deployment on your own server and none is present here.

One deployment-specific artefact does ship, deliberately: `issuer/issuer_public.b64`, the **public**
half of a reference issuer keypair, used as a test fixture. It grants nothing — enrolment requires
an invite and the private key, which is not here — but it is not a generic placeholder either.
`deploy/stiq-up.sh` generates a fresh issuer keypair on your box and never uses it.

## License

MIT — see [LICENSE](LICENSE).

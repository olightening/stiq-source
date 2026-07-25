# ADR 0001 — Frontend Framework: React Native vs Flutter

- **Status:** Proposed (pending the Step-1 Tor spike below)
- **Date:** 2026-06-10
- **Deciders:** Engineering team
- **Context step:** PLAN.md Step 1

## Context

The client must be a single cross-platform mobile app (Android + iOS) that:

1. **Bundles a Tor daemon natively** with pluggable transports (obfs4 / Snowflake) —
   no dependency on Orbot. This is the single hardest requirement.
2. Speaks the **Nostr protocol** including the harder NIPs: NIP-44 encryption, NIP-17
   sealed DMs, NIP-25 reactions, NIP-12 tags, NIP-10/22 threading, NIP-56 moderation.
3. Stores a secp256k1 `nsec` in the **hardware-backed keystore** (Android Keystore /
   iOS Secure Enclave), non-exportable.
4. Caches in **SQLite**, ships **zero telemetry**, and never falls back to clearnet.

The hard decision gate (per PLAN.md Step 1) is: **which framework has the
better-maintained native Tor binding for *both* platforms** — with the Nostr protocol
surface as the tie-breaker, since that is where most application code lives.

## Options considered

| Concern | React Native | Flutter |
|---|---|---|
| **iOS Tor** | `Tor.framework` (iCepa, Obj-C) via a native module. Proven (Onion Browser). | Same `Tor.framework` via a platform channel. Proven (Cwtch). |
| **Android Tor** | `tor-android` / Arti (Guardian Project) via a native module. | Same, via a platform channel. Proven (Cwtch). |
| **Bundled-Tor precedent** | Several RN apps shell out to Orbot; fewer *bundle* Tor. | **Cwtch** bundles Tor + obfs4 on both platforms — strongest precedent. |
| **Nostr libraries** | **NDK (Nostr Dev Kit)** + `nostr-tools`, TypeScript, actively maintained. NIP-17/44/25/10 implemented and widely audited. | `dart-nostr` / `nostr` packages — usable but thinner; NIP-17/44 less battle-tested. |
| **secp256k1** | `react-native-secp256k1` (native) or `@noble/secp256k1` (pure JS, audited). | Native via FFI; pure-Dart options less mature. |
| **Secure storage** | `react-native-keychain` (Keychain/Keystore). | `flutter_secure_storage`. Parity. |
| **SQLite** | `op-sqlite` / `react-native-quick-sqlite`. | `sqflite` / `drift`. Parity. |
| **Team velocity** | Large hiring pool; JS/TS Nostr ecosystem is first-class. | Smaller pool; excellent for bundled-Tor messengers specifically. |

Both can drive `Tor.framework` (iOS) and `tor-android`/Arti (Android) — the Tor layer is
**native-bridged either way**, so it is roughly a wash on transport. The differentiator
is the protocol layer.

## Decision

**Adopt React Native (TypeScript).**

The Tor integration is native-bridged regardless of framework, so it does not favor
either side decisively. The Nostr protocol surface does: **NDK** implements the exact
hard NIPs this project needs (NIP-44 encryption, NIP-17 sealed gift-wrap DMs, NIP-25,
NIP-10/22) in maintained, widely audited TypeScript. Reimplementing or trusting thinner
Dart equivalents for sealed-DM cryptography is the larger risk to a security product
than writing one more native module.

This decision is **Proposed, not Accepted**, until the spike below de-risks the one place
RN is weaker than Flutter (bundled Tor).

### Required spike before flipping to "Accepted" (timeboxed, part of Step 1)

Build a throwaway RN app that:
1. Starts a bundled Tor daemon on **both** an Android device and an iOS device (no Orbot).
2. Completes a circuit through an **obfs4** bridge.
3. Opens a WebSocket to a known `.onion` over that circuit.

If any leg fails to bundle cleanly on iOS, **reopen this ADR and reconsider Flutter**,
whose Cwtch precedent proves the bundled-Tor path end to end.

## Consequences

- **Positive:** least protocol-layer risk; richest Nostr tooling; large talent pool;
  pure-JS crypto fallbacks (`@noble/*`) available if native modules misbehave.
- **Negative:** RN has fewer *bundled*-Tor precedents than Flutter; the iOS Tor native
  module is the critical-path risk and must be spiked first (above).
- **Follow-ups:** the bundled-Tor work is PLAN.md Step 4; secp256k1 keystore is Step 7.
  Pin the RN New Architecture (Fabric/TurboModules) from day one to avoid a later migration.

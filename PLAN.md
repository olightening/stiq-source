# PLAN.md — Encrypted, Anonymous, Append-Only Community Platform

> **Status (2026-07-25): shipping.** The Android client is in the field; the relay, organizer
> dashboard, and one-command installer run live communities. The original 21-step build plan (§6)
> is complete, and most of the product was built *after* it — see §5. The shipping version is
> whatever `client/android/app/build.gradle` says; it is not repeated here, because a number
> copied into prose goes stale on the next release.
>
> **What this document is:** the specification and the standing mandates. It is the contract the
> code is held to, not a task list. For how to build each component see
> [BUILDING.md](BUILDING.md); to rebrand see [WHITELABEL.md](WHITELABEL.md); to run a community
> see [`deploy/README.md`](deploy/README.md).

---

## 1. Product Summary

A private, append-only community platform for closed groups, built on **Nostr over Tor v3 hidden
services**. The client is a mobile app (Android shipping; iOS builds and runs on the simulator)
presenting a **Reddit-style community feed** with tags, voting, and threaded comments, plus
encrypted direct messages, channels, groups, and events.

No proprietary cryptography or routing is invented; everything maps to vetted open standards.

### Standing decisions

| Decision | Choice | Rationale |
|---|---|---|
| Network model | **Nostr relay model** — relay-mediated, not device-to-device | Works over Tor and on mobile; supports offline sync. |
| Community structure | **One community per relay, many spaces inside it.** A member may join several communities and switch between them | One shared feed with tag filtering, plus channels/groups/events (§3.7). Each community is siloed on-device (§3.9). |
| Private messaging | **NIP-17 encrypted DMs** | Sealed, gift-wrapped, metadata-resistant. |
| Membership | **Anonymous & unlinkable** — on-device key + blind-signed credential (RFC 9474) | Organizers authorize members without learning their account, even while running the relay (§3.3). |
| Authorship | **Blind by default** — the relay cannot tell which member wrote what (§3.6) | Follows from membership unlinkability; it is also what makes moderation advisory (§3.4). |

---

## 2. Technology Stack (as built)

| Layer | Choice |
|---|---|
| Relay | **Go 1.24**, [`fiatjaf/khatru`](https://github.com/fiatjaf/khatru) v0.19 + `eventstore` on **Badger v4**; `nbd-wtf/go-nostr`; **`cloudflare/circl`** for RFC 9474 blind-RSA verification |
| Client | **React Native 0.76.5** / React 18.3, Hermes, **old architecture** (`newArchEnabled=false`) |
| Client crypto | secp256k1 (`nostr-tools` 2.10), **`@cloudflare/blindrsa-ts`** 0.4 with a pure-JS WebCrypto shim for Hermes, `@noble/hashes` **1.8** (see the hoist trap in BUILDING.md) |
| Local storage | **`@op-engineering/op-sqlite`** with SQLCipher; per-community encrypted databases |
| Transport | **Bundled Tor**, v3 onion services, pluggable transports: `direct`, `webtunnel`, `obfs4`, `snowflake` |
| Organizer | Node 20 — dashboard + enrollment mailbox (`issuer/organizer-server.mjs`), loopback-bound |

The Step-1 framework question (React Native vs Flutter) and the relay question (Rust vs Go) are
both long settled; the ADRs live in [`docs/`](docs/).

### Feature → standard mapping

| Concept | Nostr kind(s) |
|---|---|
| Posts (community feed) | kind 1 (NIP-01) with `t` tags (NIP-12) |
| Long-form articles | kind 30023 (NIP-23) |
| Votes | kind 7 reactions (NIP-25) |
| Threaded comments | kind 1111 (NIP-22) |
| Polls | kinds 1068 / 1018 (NIP-88) |
| Moderation reports | kind 1984 (NIP-56) |
| Deletions | kind 5 (NIP-09) |
| Private DMs | kind 1059 gift wraps (NIP-17) |
| **Channels** | kinds 30311 / 1311 (**NIP-53**) — these replaced the original NIP-28 40/41/42 |
| **Groups** | kinds 9 / 11 / 12 / 39xxx (**NIP-29**), relay-managed membership |
| Events | kinds 31923 / 31925 (NIP-52) |
| Bookmarks, mutes, subscriptions | kinds 10003 / 10000 / 10009 (NIP-51) |
| Organizer config, space settings | kind 30078 (NIP-78), addressable by `d` |
| Private-space key delivery | kind 30079, one per member per epoch, NIP-44 wrapped |

The full registry, with the rationale for each choice, is `client/src/contracts/index.ts`.

---

## 3. Architecture Mandates

These are binding. A change that violates one of them is a change to the product, not an
implementation detail.

### 3.1 Relay — a blind, membership-gated broker

- **Hidden-service only.** Reachable exclusively as a Tor v3 `.onion`. No clearnet ingress; the
  relay binds loopback and Tor fronts it.
- **Zero-logging.** No IP logging, not even of Tor circuits. Prefer removing a reverse proxy over
  configuring one to be quiet.
- **Membership enforcement without identification.** The relay accepts writes backed by a valid,
  unspent blind credential (§3.3) and drops everything else *before storage*. It learns that *a*
  member is entitled to write, never *which*.
- **Content-blind.** The relay does not read post bodies and does not enforce content rules. Where
  content encryption is enabled it stores ciphertext only.

### 3.2 Client — interface, key manager, Tor proxy

- **Bundled routing.** Tor ships inside the app. It must not depend on Orbot or any other app.
- **No clearnet fallback, ever.** If Tor fails, show an offline state. Never reach the relay
  directly.
- **Connection ladder.** The default mode is `auto` — a cascade of warm → direct → pluggable
  transports. `bridges` and `reach` (Snowflake-first, longer patience) exist for hostile networks,
  and `custom` accepts operator-supplied obfs4 lines. Bridges are a *rung*, not the default;
  starting there costs a slow connect on networks that do not need it
  (`client/src/tor/torSettings.ts`).
- **No telemetry.** No analytics, crash reporting, or attribution SDK anywhere. CI fails the build
  if one appears in the dependency tree (the "No telemetry guard" job).
- **Encrypted cache.** Events cache to SQLCipher for offline reads, keyed per community.

### 3.3 Identity & onboarding — anonymous, unlinkable membership

**Authorizing a member must not reveal which account they post under.**

- **Key format:** `nsec` / `npub`, generated **on the member's device**. Organizers never see it.
- **Membership credential (RFC 9474 blind signatures).** The organizer holds an RSA issuer
  keypair. At sign-up the issuer signs a token the member chose **without seeing it**, so it cannot
  later be recognized. The member holds `(token, signature)` proving "an organizer authorized me"
  while being unlinkable to the sign-up session.
- **The issuer public key is per-community, not baked into the app.** It arrives in the join code
  (or via a post-connect NIP-11 fetch) and is stored per community
  (`client/src/communities/communityStore.ts`). `cid = walletKeyFingerprint(issuerPublicKey)` is
  the relay-independent community id. **One build of the app therefore joins any community** — no
  per-community client rebuild.
- **Binding.** The app publishes a one-time binding event carrying the credential. The relay
  verifies it, marks the token spent, and accepts that identity thereafter. One credential binds
  once; a new device or re-enrol needs a fresh credential.
- **Hardware security.** The `nsec` and the credential live in the Android Keystore / iOS Secure
  Enclave — never in SQLite or logs, and **non-exportable**. There is no seed phrase and no
  backup: losing the device loses the identity. That is the cost of the guarantee.

#### What sign-up looks like to a member

> You never make an account or type a password. You scan a join code — from an organizer, a link,
> or a QR — and the app quietly creates your identity *on your phone*. The organizer's side stamps
> your request as approved without being able to see what is inside it. The result: they know they
> let someone in, but have **no way to tell which account is yours** or which posts you wrote.

### 3.4 Moderation — advisory by design, organizer-rooted

This is the most misread part of the system, so it is stated plainly:

**Because the relay cannot tell whose event is whose, it cannot enforce a ban.** Hides, bans, and
reports are *advisories* that conforming clients honor. A modified client can ignore them and keep
publishing. Moderation constrains what members **see**, not what the relay **accepts**.

Authorship-blindness and server-enforced expulsion are mutually exclusive. STIQ chooses blindness.
A community that needs enforced expulsion rotates the community credential, which the organizer
dashboard supports.

- **Trust root:** the organizer's Nostr key, carried in the community config.
- **Roster:** the organizer publishes kind-30078 `d="stiq:moderators"` (one `p` tag per moderator)
  and `d="stiq:limits"` (rate-limit policy, mirrored by the relay). Clients honor these **only**
  when signed by the organizer key, so granting or withdrawing a moderator is a republish — **no
  app rebuild**. `stiq:`-prefixed kind-30078 `d` values are reserved to the organizer key and
  rejected from anyone else (`relay/internal/policy/organizer.go`).
- **Build-time fallback:** `MODERATOR_NPUBS` in `client/src/moderation/moderators.ts` ships
  **empty** and is used only by legacy communities that predate the organizer key.
- **Client-side effect:** the feed hides content carrying a matching 1984 report from an authorized
  moderator; a Moderation Log inverts the filter and shows what was hidden and by whom.

### 3.5 Device compromise — auto-lock and duress

- **Auto-lock** behind biometric or PIN after inactivity.
- **Duress PIN** silently and permanently deletes the key from the secure store, wipes the
  encrypted cache including DMs, and opens a blank state indistinguishable from a fresh install
  (`client/src/app/screens/LockScreen.tsx`).

### 3.6 Blind authorship

Originally this mandate covered comments only. It now covers **posts, votes, and comments alike**:
each is published under a one-time, blind-signed credential drawn from a local token wallet and
signed by a throwaway key, so neither the relay nor other members can attribute it
(`client/src/blind/`).

- **Moderator attribution**, where it exists, is carried as a NIP-44-encrypted tag readable only by
  the moderator roster — the public sees nothing.
- **Double-spend** is prevented by the relay's spent-token set; the client tracks its own witnesses
  (`blind/doubleSpend.ts`, `blind/spendWitness.ts`).
- **Known limitation, unchanged:** a moderator can learn an author and hide their content but
  cannot make the relay block their *future* posts. That is the design, not a gap.

### 3.7 Spaces — channels, groups, events

Three space types coexist, deliberately on different protocols:

- **Channels (NIP-53, kinds 30311/1311)** — owner-broadcast; the owner-signed 30311 is
  self-describing and rides the firehose.
- **Groups (NIP-29, kinds 9/11/12/39xxx)** — relay-managed membership; the relay regenerates 39000
  from a 9002 edit and echoes only name/about/picture/gradient/access.
- **Events (NIP-52, kinds 31923/31925)**.

Standardization happens at the **client model**, not by merging the protocols. The shared,
extended settings — the content rule set, and for groups the reaction set and pinned message —
ride an admin-signed kind-30078 doc under `d="space-settings:<spaceId>"`
(`client/src/channels/spaceRules.ts`). Enforcement of those rules is **client-side**
(`moderation/spaceAutoModeration.ts`); the relay is never asked to read content.

### 3.8 Discovery — no directory, no search

There is no channel directory and no user search. A channel is reachable only through its owner's
profile, which is reachable only from one of their posts. The relay **rejects unbounded
subscriptions** for profile and channel kinds — a filter must name `authors` or a channel `#e` —
so those sets cannot be enumerated.

### 3.9 Multi-community siloing

A member may join several communities. Each gets its own slot: its own SQLCipher database, its own
identity, and its own credential wallet, namespaced by community id. Nothing crosses the boundary
— one community cannot observe that another exists on the device.

---

## 4. Cross-cutting decisions (resolved)

The original plan carried these as open flags. They are answered:

| Question | Resolution |
|---|---|
| Membership set vs NIP-17 DMs (gift wraps use ephemeral keys, so they can never be in an accepted set) | **NIP-13 proof-of-work** gates kind-1059, keeping spam expensive without identifying senders. The same path admits ephemeral-signed comments at a lower difficulty. |
| DM cache at rest | Encrypted at rest, in the per-community SQLCipher database; cleared by the duress wipe. |
| Snowflake in v1 | Shipped, as the `reach` rung of the connection ladder (§3.2). |
| Where the issuer key lives | On the community's own server, generated there by `deploy/stiq-up.sh` and never transmitted. Dashboard access equals shell access equals full community control — deliberately, with no weaker remote admin surface. |
| How the community bootstrap reaches a blank app | The join code: relay onion + issuer public key (+ optional update-repo pins), as a link or QR. |
| Member revocation | Post-binding, an identity can be advisory-banned (§3.4). Revoking *before* binding needs issuer-key rotation. Communities needing hard expulsion rotate the community credential. |

---

## 5. What shipped beyond the original plan

The 21 steps in §6 describe roughly the first third of the product. Built since, each with tests:

- **Blind token economy** — a per-member wallet of blind-signed, one-time write credentials, with
  weight-based pricing, pooling, refresh, and double-spend witnesses (`client/src/blind/`, 37
  files).
- **Content encryption and read tokens** — bodies sealed under a rotating community key with an
  epoch watcher and metered read authorization (`blind/contentKey.ts`, `blind/readUnlock.ts`,
  `issuer/contentEpochKeys.mjs`). Every client surface is sealed-content-safe — a locked body
  renders as a locked state, never ciphertext — enforced by `blind/sealedEverywhere.test.ts`;
  federated mirror relays store ciphertext only and hold no decryption material
  (`deploy/stiq-up.sh --attach`).
- **Spaces** — channels, groups, and events with per-space rules, gradients, reactions, pinning,
  and client-side auto-moderation (`client/src/channels/`, 70 files).
- **Organizer dashboard** — invite issuance (multi-use, expiring, short links), moderator roster,
  limits, ranking config, archive/restore, maintenance (`issuer/`).
- **Rich composer and drafts** — a full-page editor with rich blocks, media chips, inline audio,
  embeds, and a size meter (`client/src/feed/`, 113 files).
- **In-app updates** — the relay serves a signed F-Droid repository; join codes pin the repo and
  app signing certificates; the client verifies both before installing (`client/src/update/`,
  `relay/main.go`, `relay/deploy/fdroid-publish.sh`).
- **Notifications** — per-item read state, a comment/DM/mention split, and optional ntfy push.
- **Tor operations** — connection modes, single-onion mode for latency, bridge selection, and
  in-process restart.
- **Safe links** — the in-app browser was **removed**; links are handed to a real browser, with a
  secure-browser option surfaced when one is the chosen default (`client/src/browser/`,
  `client/src/safebrowsing/`).

---

## 6. Build record — the original 21 steps

All complete. Kept as history; none of it is outstanding work.

| Phase | Steps | Delivered |
|---|---|---|
| 0 — Foundations | 1 | Framework ADR; `client/` `relay/` `docs/` `proto/` monorepo; CI |
| 1 — Relay | 2–3 | Admission middleware failing closed; Tor v3 hidden service; zero-logging hardening |
| 2 — Client transport | 4–5 | Bundled Tor with bridges and no clearnet fallback; Nostr WebSocket over Tor; SQLite cache; telemetry guard in CI |
| 3 — Identity | 6–7 | On-device key; two-way blind-credential exchange (RFC 9474); hardware-backed key + credential storage |
| 4 — Moderation | 8–9 | Signed 1984 reports; client-side filter; Moderation Log with attribution |
| 5 — Device compromise | 10–11 | Auto-lock; dual PIN; duress wipe |
| 6 — Content UI | 12–15 | Feed shell; tagged composer; voting; threaded comments; tag filter and Hot/New/Top |
| 7 — DMs | 16–17 | NIP-17 gift-wrapped DMs admitted by PoW; inbox and thread UI wired into the duress wipe |
| 8 — Anonymity & spaces | 18–21 | Ephemeral-signed comments with moderator-only attribution; profiles with the discovery guard; account-owned channels; channel and profile UI |

Steps 2, 6, and 7 were reworked mid-plan when membership became unlinkable; step 14 was reworked
when comments became anonymous. Those reworks are folded into the rows above.

---

## 7. Definition of Done

- [x] Relay reachable only via `.onion`; no clearnet ingress; no IPs in any log.
- [x] Only holders of a valid, unspent credential can write; organizers cannot link an identity to
      a person; DM spam mitigated by PoW.
- [x] App bundles Tor, offers a bridge ladder, and never falls back to clearnet.
- [x] No telemetry or analytics SDK linked — enforced in CI.
- [x] Member key generated on-device; key and credential in the hardware-backed store,
      non-exportable, surviving restart.
- [x] Community feed: post, tag, vote, comment, sort.
- [x] Moderation hides content in the feed and surfaces it in the Moderation Log with attribution.
- [x] Auto-lock; duress PIN irrecoverably wipes key and cache.
- [x] NIP-17 DMs with sender metadata hidden; duress wipe clears history.
- [x] Authorship is blind to the relay and to other members.
- [x] Account-owned channels, relay-managed groups, and events.
- [x] Channels and profiles reachable only from a post author; the relay rejects enumeration.
- [ ] **iOS shippable.** The app compiles and runs on the simulator, and four of its five native
      modules are functional, but the project carries no signing team and the CI `xcodebuild` job
      is failing. Android only, in practice.

---

## 8. Open questions

1. **iOS device builds.** The CI iOS job fails at `xcodebuild`; the cause is undiagnosed. Signing
   is unconfigured (no `DEVELOPMENT_TEAM`), and CI cannot catch that because it builds with
   `CODE_SIGNING_ALLOWED=NO`.
2. **Distribution bootstrap.** The in-app update path is complete once someone has the app, but
   the *first* install is always a manual sideload, and no signed APK is published with this
   source. A community's operator must build and sign one — see [BUILDING.md](BUILDING.md).
3. **Anonymous-author banning.** Accepted as a limitation (hide plus out-of-band accountability),
   or worth a nullifier/revocation scheme? Unchanged since the original plan.
4. **Comment PoW difficulty.** Comments are far more frequent than DMs; the difficulty that deters
   spam without hurting battery has not been re-tuned since the token economy landed.
5. **Group posting models.** Owner-broadcast is the default; designated co-posters and open
   membership exist, but the abuse surface of open groups has not been stress-tested.

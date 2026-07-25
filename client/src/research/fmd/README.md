# FMD evaluation (T18) — research subtree

**EVAL-ONLY. Spike-not-production.** This subtree evaluates whether, and at what community size, STIQ
should replace or augment the deterministic **decoy cover-set** DM/mention metadata defense
(`client/src/nostr/subscriptionPlan.ts` → `buildCoverSet`) with **Fuzzy Message Detection (FMD)**.
Nothing here ships: the decoy cover-set remains the shipping mechanism and the single feature flag
`FMD_EVAL_ENABLED` (`client/src/config.ts`) defaults **false** and is **never flipped in a shipped APK**.

## What FMD is

FMD lets a sender attach a small **flag** ciphertext to each message. A receiver hands an untrusted
detector a **detection key** revealing the first `n` of its `γ` secret subkeys; the detector can then
decide membership with a **tunable false-positive rate `p = 2^-n`**. A true recipient always matches
(zero false negatives); a non-recipient matches with probability exactly `2^-n`. The result is a
**fuzzy anonymity set** — the true recipients buried in `p·(community volume)` decoys — whose size the
receiver dials via `n`. Unlike the decoy cover-set (a fixed `k+1`-inbox set, independent of community
size `N`), the FMD fuzzy set **grows with `N`**, but so does the bandwidth, and every message pays a
per-flag byte tax.

Scheme: the **compact construction** of Beck–Len–Miers–Green, _"Fuzzy Message Detection"_ (CCS 2021,
§5), over secp256k1 — one group element + one scalar + `⌈γ/8⌉` cipher-bits per flag (68 bytes at
γ=24). See the header of `fmd.ts` for the exact algorithm.

## Module map

| File | Subtask | Role |
|---|---|---|
| `fmd.ts` | T18-S1 | Pure-TS compact FMD scheme: keygen, detect-key extraction at precision `n`, `flag`, `testFlag`, (de)serialize, `flagByteLength`. Reuses only `@noble/curves` + `@noble/hashes/sha2.js` already in the tree. |
| `fmd.test.ts` | T18-S1 | Correctness + **empirical** false-positive-rate checks (slow; do not run in a tight loop). |
| `simulate.ts` | T18-S2 | Pure/deterministic harness: STIQ volume model + Tor link model → bytes/CPU/anonymity for decoy vs FMD across `N` and `n`; `crossoverCommunitySize`. Flag tax sourced from the real `flagByteLength()`. |
| `simulate.test.ts` | T18-S2 | Model-shape checks (decoy flat in N, FMD anonymity linear in N, bytes monotone, finite/null crossover). |
| `report.ts` | T18-S3 | `renderReport` → the markdown decision doc (trade-off table, flag tax, linkability caveat, CPU, decision matrix); `crossoverSummary` / `findCrossover`. |
| `fmd.sim.test.ts` | T18-S3/S7 | Non-gated renderer smoke test **+** the **gated** sweep that writes the report deliverable. |
| `prototype.ts` | T18-S4/S7 | Narrow client-side prototype: `fmdFlagTag`/`readFmdFlag`/`fmdFilterInbox`/`detectMentions`, the flag-guarded `fmdExtraTagsFor`/`fmdDetectInbox` seams, and the eval recipient-key stand-in (`evalRecipientFmdPk`). |
| `prototype.test.ts` | T18-S4 | Flag round-trip, `mineGiftWrap` extraTags seam, fuzzy-set detection, npub-blind mention detection, ship-dark guards. |
| `dmGuard.test.ts` | T18-S7 | The DM call-site guard: flag-off DM is byte-identical (`[p, nonce]`, no `stiq_fmd`) and still decrypts; flag-on injects a detectable flag. |
| `bench.ts` | T18-S6 | On-device Hermes `flag()`/`testFlag()` throughput micro-bench (mean + p95). |
| `bench.test.ts` | T18-S6 | Harness validation (positive means, correct shape). |
| `relay/internal/research/fmd/` (Go) | T18-S5 | Isolated relay-side `Test()` cost projection. NEVER imported by `relayapp.New`. |

The only production seams are two dark, backward-compatible edges, both inert with the flag false:
- `client/src/dm/dm.ts` → `mineGiftWrap(..., extraTags?)` (default `undefined` ⇒ byte-identical wrap).
- `client/src/keys/identity.ts` → `Identity.sealDM` calls the flag-guarded `fmdExtraTagsFor` in a
  **single** `FMD_EVAL_ENABLED ? … : undefined` branch, so a shipped build derives no key and injects
  no tag. `App.tsx` runs the on-device bench only under `FMD_EVAL_ENABLED && __DEV__`.

## How to run

**Decision-report sweep (writes `docs/research/FMD_EVAL_2026-07-10.md`):** gated so normal CI never
writes files —
```sh
cd client
RUN_FMD_SWEEP=1 npx jest research/fmd/fmd.sim.test.ts
```

**Relay-side cost projection (Go; toolchain at `D:/tools/go/bin`):**
```sh
cd relay
go test ./internal/research/fmd/...
go test -bench . ./internal/research/fmd/...   # prints ns/op for Test() at n=4 and n=8
```

**On-device Hermes bench (the only device step):**
1. Locally flip `FMD_EVAL_ENABLED = true` in `client/src/config.ts` (do **not** commit this).
2. Build + install the arm64 debug APK (`cd client/android && ./gradlew assembleDebug`, install
   `app-arm64-v8a-debug.apk`).
3. Launch the app; the flag-gated `App.tsx` hook runs `benchFmd()` once.
4. `adb logcat | grep FMD-bench` → one `[FMD-bench]` line with `flag`/`test` mean + p95 ms on the
   target low-end phone.
5. Feed those numbers into `ReportMeta.hermesFlagMs` / `hermesTestMs` in `fmd.sim.test.ts` and the
   relay `ns/op` into `relayTestMs`, then re-run the sweep to regenerate a fully-measured report.

Do **not** run `fmd.test.ts` in a tight loop — the empirical FP sweep is intentionally heavy.

## Decision report

`docs/research/FMD_EVAL_2026-07-10.md` (regenerated by the gated sweep above). It carries the
per-`N` trade-off table, the per-message flag tax, the static-detection-key linkability caveat with the
per-epoch key-rotation mitigation, the measured CPU section (Hermes flag/test ms from S6, relay
`ns/op` from S5), and an explicit **ship-threshold** recommendation. Current baseline finding: FMD only
overtakes the decoy cover-set at **N ≈ 10** using **p = 2^-4**, and even then only if native flag/test
acceleration lands — pure-JS Hermes and relay-side per-REQ costs otherwise rule it out. **Keep the
decoy cover-set today.**

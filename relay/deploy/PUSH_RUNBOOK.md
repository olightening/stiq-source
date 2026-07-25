# STIQ push (real push over Tor) — deploy + verification runbook (T1)

Content-free "wake and sync" push for STIQ, with **no Google / FCM / Firebase**. A push carries
**zero content** — it is a bare wake signal. The app, once woken, syncs over Tor and derives the
title-only notification **locally on the device**. Ships dark behind two independent flags (server
`PUSH_WATCHER` + client `PUSH_UNIFIEDPUSH`); members without a UnifiedPush distributor keep the
existing WorkManager polling unchanged.

---

## Invariants (do not violate)

- **Keyless watcher.** `relay/cmd/pushwatcher` holds **no** community key, **no** content-encryption
  key (K_E), and **no** issuer/posting/binding keys. It never decrypts a gift wrap or a body. It
  matches **only already-public tag values** on the blind stream.
- **Content-free wake.** The wake POST body is **empty**. No title, npub, body, or event id ever
  crosses ntfy. All notification text is derived on-device over Tor after the wake.
- **Loopback + onion only.** ntfy and the watcher bind `127.0.0.1` and are fronted **only** by the
  relay's Tor onion (extra `HiddenServicePort` lines). There is no clearnet listener — co-location is
  the security model, exactly as for the relay and dashboard.

### Trigger-key vocabulary (must byte-match the client and the Go watcher)

| Key       | Source tag (already public on the wire)                 | Wakes on                          |
|-----------|---------------------------------------------------------|-----------------------------------|
| `p:<hex>` | `['p', <pubkey>]` on kind-1059 DM gift wraps            | a DM addressed to the member      |
| `h:<id>`  | `['h', <group-id>]` on NIP-29 group/channel kinds (9,11,12,42) | activity in a followed group |
| `e:<hex>` | `['e', <root-id>]` on kind-1111 comment roots          | a reply to the member's root note |

`p`/`e` values are canonical 64-char lowercase hex; `h` values are free-form NIP-29 slugs. A member
registers a bundle of these keys against a random, high-entropy ntfy **topic** (a bearer capability),
with a TTL. The watcher re-derives the same keys from incoming events and pokes the matching topics.

---

## Server deploy

Prerequisite: an app build carrying `PUSH_UNIFIEDPUSH=true` + the native `StiqUnifiedPush` module has
already reached your members (clients-first flip order). Then, on the relay/organizer box:

```sh
sudo PUSH_WATCHER=1 bash deploy/stiq-up.sh
```

This (and nothing more than this — the whole stack is gated on `PUSH_WATCHER=1`):

1. builds/installs the keyless watcher to `/opt/stiq/pushwatcher`;
2. installs **off-the-shelf** ntfy from `archive.heckel.io` (never built) and writes a loopback-only
   `/etc/ntfy/server.yml` (`listen-http: 127.0.0.1:2586`, `base-url: http://<relay-onion>:2586`);
3. adds two `HiddenServicePort` lines to the **relay** onion drop-in
   (`8787` → watcher, `2586` → ntfy), preserving any SSH-over-Tor recovery onion;
4. installs `stiq-pushwatcher.service` (hardened, `User=stiq`, keyless) and binds it into
   `stiq.target`;
5. merges `push_watcher_onion` (`<relay-onion>:8787`) and `push_ntfy_onion` (`<relay-onion>`) into
   `/etc/stiq-relay/config.json` (preserving every other key) and restarts the relay so **NIP-11
   `stiq-capabilities.push`** re-advertises them.

Turning `PUSH_WATCHER` back to `0` on a re-run leaves the existing units and config keys in place; a
normal run (`PUSH_WATCHER` unset) deploys nothing new and leaves NIP-11 without a `push` block, so
every client falls back to polling with no code change.

### Server-side verification

```sh
systemctl is-active stiq-relay stiq-organizer stiq-pushwatcher ntfy   # all 'active'

# NIP-11 advertises the push block (over the onion, or loopback with a Host header):
curl -fsS -H 'Accept: application/nostr+json' http://127.0.0.1:3334/ | python3 -m json.tool \
  | grep -A3 '"push"'          # → push.watcher, push.ntfy

# Keyless proof — this MUST return nothing:
grep -R -iE 'communityKey|K_E|issuer|blindrsa|decrypt' relay/cmd/pushwatcher

# End-to-end loopback smoke (health → register 204 → wake delivered on the topic SSE;
# full signed-1059 chain when issuer/verify_push.mjs is present):
WATCHER_URL=http://127.0.0.1:8787 NTFY_BASE=http://127.0.0.1:2586 RELAY_WS=ws://127.0.0.1:3334 \
  bash relay/deploy/push_smoke.sh
# (stiq-up.sh also runs these checks automatically in its PUSH_WATCHER=1 smoke section.)
```

`node issuer/verify_push.mjs` (when shipped) prints `push wake delivered: true` on success: it opens
an SSE subscription on a fresh ntfy topic, registers it under `p:<hex>`, publishes a synthetic
kind-1059 tagged `['p', <hex>]` to the relay, and asserts a wake arrives on the topic within ~20s —
entirely over loopback.

---

## On-device runbook (Android arm64)

1. Install a UnifiedPush **distributor** that can reach an `.onion`: the **ntfy Android app** plus
   **Orbot** (route the ntfy app through Orbot). In the ntfy app, set the server / default base URL to
   the community's ntfy onion — `http://<relay-onion>:2586` (from `push_ntfy_onion` in NIP-11).
2. Build + install the arm64 debug APK with the client flag on:
   ```sh
   # client/src/config.ts: export const PUSH_UNIFIEDPUSH = true as boolean;
   cd client/android && ./gradlew assembleDebug
   adb install -r app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
   ```
3. Launch STIQ, grant the notifications permission, and enroll into the test community. Confirm
   registration:
   ```sh
   adb logcat | grep -iE 'NEW_ENDPOINT|StiqPush|push/register'
   ```
   Expect a `NEW_ENDPOINT` broadcast and a `204` from the watcher `/push/register`.
4. **Wake test.** Background, then **force-stop** the app. From a second device, send a DM to the
   test account. Observe the chain in logcat:
   ```sh
   adb logcat | grep -iE 'StiqUnifiedPushReceiver|StiqSyncService|StiqBackgroundSync|notifyDm'
   ```
   Expect: ntfy wake → `StiqUnifiedPushReceiver.onMessage` → `StiqSyncService` →
   `StiqBackgroundSync` → a title-only **"New message"** notification within a few seconds. Repeat for
   a group broadcast in a followed group.
5. **Privacy check.** Capture the wake POST (e.g. ntfy access log with `log-level: debug` temporarily,
   or a proxy on the topic): the body is **empty** and no npub/content/event-id crosses ntfy. The
   registration body carries only `{v, topic, keys, exp}` with coarse `p:`/`h:`/`e:` keys.

### Fallback (no distributor) — must be identical to today

Uninstall/disable the ntfy app (remove the distributor). Confirm:

- `registerApp()` resolves `no_distributor` and no push fires;
- the existing WorkManager `scheduleSync(15,5)` polling still delivers exactly as before — no UX
  regression, no error. This is the default path for every member without a distributor.

---

## Rollback

- Server: re-run `sudo bash deploy/stiq-up.sh` (with `PUSH_WATCHER` unset) — the push units keep
  running but you can `systemctl disable --now stiq-pushwatcher ntfy` and clear the NIP-11 `push`
  block by removing `push_watcher_onion`/`push_ntfy_onion` from `/etc/stiq-relay/config.json` and
  restarting the relay. Every client then falls back to polling with no code change.
- Client: ship a build with `PUSH_UNIFIEDPUSH = false` — all UnifiedPush registration becomes a
  no-op.

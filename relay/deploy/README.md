# relay/deploy — Tor hidden service deployment (PLAN.md Step 3)

> **For a turnkey setup use [`deploy/stiq-up.sh`](../../deploy/)** — it builds the relay,
> brings up this hidden service, and co-locates the organizer dashboard in one command. The
> reference material below (torrc, hardened unit, firewall, on-box verification checklist) is
> what that installer wires up, and remains the source of truth for the Tor/firewall hardening.

Fronts the relay as a Tor v3 `.onion`, denies all clearnet ingress, and disables all
logging. The relay process itself binds loopback only and knows nothing about Tor.

```
                 Tor network
                     │
        onion:80  ───┤  (descriptor published by tor daemon)
                     ▼
   tor ──HiddenServicePort──► 127.0.0.1:3334 (stiq-relay, loopback only)
```

## Files

| File | Purpose |
|---|---|
| `torrc` | Tor v3 hidden-service config reference (merged view of all the torrc.d drop-ins `stiq-up.sh` actually writes — see "Single-onion mode" below); zero logging; intro-point DoS defense. |
| `stiq-relay.service` | Hardened systemd unit; runs unprivileged; discards all output. |
| `stiq-vanguards.service` | Optional layer-3 guard addon (`STIQ_VANGUARDS=1`); skipped under single-onion mode. |
| `tor_defense_check.sh` | Standing health check: PoW/intro-DoS, single-onion mode, all HS descriptors. |
| `firewall-nftables.sh` | Drops all inbound except loopback + established. |

## Deploy procedure (Debian/Ubuntu target)

```sh
# 1. Build the relay (static, on a build host with Go 1.24+):
cd relay && CGO_ENABLED=0 go build -o stiq-relay .

# 2. Create the config from the example and fill in allowed_pubkeys + a data dir:
cp config.example.json config.json
#   set "data_dir": "/var/lib/stiq-relay/data" for persistence.

# 3. Install the relay + systemd unit (see header of stiq-relay.service for the commands),
#    then start it. It binds 127.0.0.1:3334 only.
sudo systemctl enable --now stiq-relay

# 4. Install Tor and the hidden-service config:
sudo apt install tor
sudo cp deploy/torrc /etc/tor/torrc       # or merge into the existing torrc
sudo systemctl restart tor

# 5. Read the generated onion address (the ONLY way to reach the relay):
sudo cat /var/lib/tor/stiq-relay/hostname  # -> xxxx…xxxx.onion

# 6. Lock down the firewall (defense in depth on top of loopback binding):
sudo ./deploy/firewall-nftables.sh
```

The `.onion` from step 5 is what the admin embeds in the onboarding QR (Step 6), as
`ws://<onion>` (Tor maps onion port 80 → the relay).

## Verification checklist (MUST run on the deploy box)

These checks need a live Tor process and external vantage points, so they cannot be run
in CI or on a dev workstation. The relay's loopback-only binding and persistence ARE
covered by `go test ./...`; the items below close out the rest of the Step 3 exit
criterion.

- [ ] **Reachable only via `.onion`** — from another host with Tor:
      `torsocks websocat ws://<onion>/` connects; a Nostr `REQ` returns events.
- [ ] **No clearnet exposure** — from a different machine on the internet/LAN:
      `nmap -Pn <server-public-ip>` shows the relay port closed/filtered (no 3334, no 80).
- [ ] **Relay binds loopback only** — on the box: `ss -ltnp | grep stiq-relay` shows
      only `127.0.0.1:3334` (never `0.0.0.0` or a public IP). The process also refuses to
      start on a non-loopback bind (enforced by `config.LoopbackOnly`).
- [ ] **No IP / access logs anywhere** —
      `journalctl -u stiq-relay` is empty (StandardOutput/Error=null);
      `journalctl -u tor` shows no connection/IP lines; `/var/lib/tor` has no access log;
      `grep -r <any-test-ip> /var/log` finds nothing.
- [ ] **Persistence** — restart `stiq-relay`; previously stored events are still served
      (requires `data_dir` set).

## Notes

- **Pluggable transports (obfs4 / Snowflake)** are a *client* concern (PLAN.md Step 4):
  they disguise the user's Tor traffic. The hidden service is reached through the Tor
  network normally and needs no bridge config of its own.
- **v3 client authorization** (commented in `torrc`) can restrict who may even resolve the
  onion. Revisit during onboarding (Step 6); it adds an out-of-band key per user.
- Never commit `config.json`, `/var/lib/tor/stiq-relay/hs_ed25519_secret_key`, or the
  `hostname` file. They are git-ignored.

## Single-onion mode (`RELAY_SINGLE_ONION`, default 1)

`deploy/stiq-up.sh` runs every hidden service on this box (relay + dashboard + the optional
SSH-recovery onion) in Tor's official **single onion service** mode by default:
`HiddenServiceNonAnonymousMode 1` + `HiddenServiceSingleHopMode 1` + `SocksPort 0`, written as a
dedicated drop-in, `/etc/tor/torrc.d/stiq-base.conf`. This drops the SERVER's own 3-hop path to its
rendezvous point down to one hop — trimming a full circuit build off first-connect, a meaningful
slice of onion connect latency/jitter. **It does not change how clients reach the service** —
from a client's perspective this is a completely normal v3 `.onion`, resolved and connected the
completely normal (3-hop, anonymous) way. It only removes the server's own circuit anonymity toward
the rendezvous point, which is acceptable here because this box's location/operator was never
actually hidden (rented hosting, SSH access, a billing trail) — only members' connections are meant
to stay anonymous.

- **Disable it:** `sudo bash deploy/stiq-up.sh --no-single-onion` (or `RELAY_SINGLE_ONION=0`).
  Removes `stiq-base.conf` and reloads tor. The `.onion` address is unaffected either way — this
  never touches `hs_ed25519_secret_key`.
- **Incompatible with the `vanguards` addon** (`STIQ_VANGUARDS=1`): vanguards defends the very
  3-hop rendezvous path single-onion mode removes, so `stiq-up.sh` skips installing it (or stops an
  existing copy) whenever single-onion is on. Use `--no-single-onion` to run vanguards.
- **Breaks Safe-Browsing's own outbound SOCKS use** (`STIQ_TOR_SOCKS`, `relay/main.go`) unless a
  second, client-only tor instance is provisioned — `stiq-up.sh` does this automatically whenever
  Safe-Browsing looks configured (`safe_browsing_api_key` present in `config.json`, or
  `SAFE_BROWSING_TOR=1`). See `deploy/SINGLE_ONION.md` and the `stiq-base.conf` comment in
  `torrc` for the full mechanics.
- **Client-auth × single-onion has NO test coverage in this repo.** `RELAY_ONION_AUTH=1` (the
  default) and `RELAY_SINGLE_ONION=1` (the default) have never been jointly verified against a live
  Tor daemon here. Before relying on both together in production, run the compatibility gate in
  **`deploy/SINGLE_ONION.md`** on the box — client authorization wins if the two ever
  conflict; single-onion is the one that gets rolled back.

## In-app signed APK updates — F-Droid repo over the relay onion (T9)

The app can update itself from inside the app: it fetches a signed F-Droid-format `index-v1.jar`
from the community onion **over Tor**, verifies the index signer against a pinned cert, enforces
`versionCode` monotonicity + APK same-signer, then installs via the OS PackageInstaller (which shows
its own confirm dialog — never a silent install). No Google Play, no FCM, no new server: the repo is
served by the **existing** relay onion under `/fdroid/`, and the whole feature ships **dark** behind
the client flag `APK_UPDATES` and the per-community join-code fields below.

> **Publishing requires `fdroidserver` + Java + two keystores and CANNOT be run from this repo's dev
> box.** [`fdroid-publish.sh`](fdroid-publish.sh) is the runbook — run it on the organizer's release
> host. Without `fdroidserver` it falls back to a hand-built, `jarsigner`-signed index (`NO_FDROIDSERVER=1`).

### Two keys (do not confuse them)

| Key | Signs | Fingerprint → join field | Client pins it to… |
|---|---|---|---|
| **APP key** | the APK | `af` (`STIQ_UPDATE_APP_CERT`) | refuse any update APK not signed by the installed build's key |
| **REPO key** | `index-v1.jar` only | `uf` (`STIQ_UPDATE_REPO_CERT`) | refuse an index whose signer ≠ the pin (fail-safe: no update) |

The **APP key MUST be byte-identical to the key that signed the currently-installed build** — today the
debug keystore in `client/android/app/build.gradle` (`signingConfigs.debug`). Changing it forces an
uninstall/reinstall (Android rejects a same-package APK with a different signer). The **REPO key is a
dedicated index-signing key**, generated on first `fdroid-publish.sh` run — never reuse the app key for it.

### Publish + serve

```sh
# On the organizer's release box (fdroidserver + JDK installed):
APK_PATH=app-arm64-v8a-release.apk \
REPO_DIR=/var/lib/stiq-fdroid \
RELAY_ONION=<relay>.onion \
REPO_KS_PASS=… REPO_KEY_ALIAS=stiq-repo \
WHATS_NEW=changelog.txt \
./relay/deploy/fdroid-publish.sh
# → prints REPO_CERT_SHA256 (uf), APP_CERT_SHA256 (af), OBTAINIUM_URL, UPDATE_REPO_PATH (up), APPLICATION_ID (ua)

# Point the relay at the repo dir so it serves /fdroid/ from the SAME onion (restart-only field):
#   set "fdroid_repo_dir": "/var/lib/stiq-fdroid" in the relay config.json
#   (or FDROID_REPO_DIR=/var/lib/stiq-fdroid when using deploy/stiq-up.sh), then:
sudo systemctl restart stiq-relay
# Verify on the box: curl -s http://127.0.0.1:3334/fdroid/repo/index-v1.jar | head -c 4
```

With `fdroid_repo_dir` unset the `/fdroid/` route is not registered and a GET falls through to
khatru's 404 — byte-identical to a relay without this feature.

### Hand off to the join code (T9-S6)

The organizer server (`issuer/organizer-server.mjs`) reads these env vars and, when
`STIQ_UPDATE_REPO_PATH` is set, appends `up`/`uf`/`af`/`ua` to the join code. Set them from the
`fdroid-publish.sh` output, then **reissue the join code** (old codes stay valid — they just carry no
repo, so those members never see the update UI):

```sh
STIQ_UPDATE_REPO_PATH=/fdroid/repo                 # up
STIQ_UPDATE_REPO_CERT=<REPO_CERT_SHA256 from script> # uf  (64-hex, index signer)
STIQ_UPDATE_APP_CERT=<APP_CERT_SHA256 from script>   # af  (64-hex, APK signer)
STIQ_UPDATE_APP_ID=com.stiq.client                   # ua
```

To publish a newer version later, re-run `fdroid-publish.sh` with a **higher-versionCode** APK; the
index gains a new entry (monotonic) and the repo key is reused — no key rotation, no join-code change.

- **Obtainium compatibility:** the same repo works as an Obtainium "F-Droid third-party repo" source at
  `OBTAINIUM_URL` (`http://<relay>.onion/fdroid/repo`), which requires Orbot on the tester's device.

# deploy/ — stand up a STIQ community in one command

Everything a community needs runs on **one server**: the membership-gated Nostr
relay *and* the organizer dashboard, co-located on purpose. This directory holds the
single installer that provisions both.

```sh
# On a fresh Debian/Ubuntu box (root), from a checkout of this repo:
git clone <this-repo> stiq && cd stiq
sudo COMMUNITY="Riverside Mutual Aid" ORGANIZER="stewards" bash deploy/stiq-up.sh
```

That's it. When it finishes you have a live community and a join code to hand out.

## What the one command does

[`stiq-up.sh`](stiq-up.sh) is idempotent (safe to re-run; it preserves keys and the
`.onion`). In order it:

1. Installs deps — `tor`, `node` (LTS), `openssl`, `python3`. Builds the relay from
   source with Go (installing Go if absent), or uses a prebuilt `stiq-relay` binary if
   one sits next to the script.
2. Creates the unprivileged `stiq` user and a co-located tree under `/opt/stiq`.
3. **Generates all community key material on the box** — the issuer RSA key, the
   organizer Nostr key, and (via Tor) the `.onion` secret key. None of these are ever
   typed in, downloaded, or transmitted. They are born here and stay here.
4. Brings up the Tor v3 hidden service and reads the community's fresh `.onion`. By
   default it also brings up a **second onion for the dashboard, with client
   authorization**, so you can administer the community remotely from Tor Browser (see
   "Opening the dashboard"). Set `DASHBOARD_ONION=0` for SSH-tunnel-only instead.
5. Writes the relay config (issuer public key + organizer pubkey + a single shared
   `enroll_pow=12` that matches the client), installs the hardened, zero-logging,
   loopback-only relay service.
6. Wires the fresh `.onion` into the organizer (no more hand-editing a hardcoded
   address) and installs the dashboard service, **bound to `127.0.0.1` only** (fronted
   by the client-auth onion above, or an SSH tunnel — never clearnet).
7. Binds both under a `stiq.target` and starts everything, then smoke-tests the relay.

It prints the `.onion`, the dashboard access card (onion address + client-auth key +
password) or the SSH-tunnel command, and the locations of every secret.

## Opening the dashboard

The dashboard always binds `127.0.0.1` — there is **never a clearnet URL**. There are two
ways to reach it; pick one with the `DASHBOARD_ONION` flag.

### Default: its own Tor onion with client authorization (`DASHBOARD_ONION=1`)

The installer gives the dashboard a *second* Tor v3 onion, **co-located on the relay box**,
locked with **client authorization** plus a login password. You reach it from any device
running **Tor Browser** — no SSH, no clearnet. When the installer finishes it prints (and
saves to `/opt/stiq/organizer/dashboard_auth/ACCESS.txt`, root-only) an access card:

```
address  : http://<dashboard>.onion
auth key  : <52-char base32 x25519 private key>   # paste when Tor Browser prompts
password  : <dashboard login password>
```

Client authorization means the onion descriptor is published **encrypted to your key
only** — without the auth key, an attacker cannot even resolve the address, let alone
reach the login page. The password is a second, app-layer factor.

- **Revoke a lost key:** delete `/var/lib/tor/stiq-dashboard/authorized_clients/*.auth`
  and re-run the installer (mints a fresh key); the onion address itself is preserved.
- **Rotate the password:** set `STIQ_ORG_PASSWORD=...` and re-run, or edit
  `/opt/stiq/organizer/dashboard_auth/env` and `systemctl restart stiq-organizer`.

### Alternative: SSH tunnel only (`DASHBOARD_ONION=0`)

No dashboard onion, no password — the most locked-down option, but tied to machines that
hold your SSH key:

```sh
ssh -L 7799:127.0.0.1:7799 root@<your-server>
# then open http://localhost:7799 in your browser
```

## Single-onion mode (faster rendezvous, default on)

By default (`RELAY_SINGLE_ONION=1`), every onion this box hosts (relay, dashboard, and the
optional SSH-recovery onion) runs Tor's official **single onion service** mode — the server drops
its own 3-hop path to the rendezvous point down to one hop, trimming a full circuit build off
first-connect. **Clients are unaffected**: this is still a normal v3 `.onion`, reached the normal
(3-hop, anonymous) way — only the *server's* own circuit anonymity toward the rendezvous point is
traded away, which is fine here since this box's location/operator (rented hosting, SSH access, a
billing trail) was never actually hidden. The `.onion` address itself never changes.

- **Turn it off:** `sudo bash deploy/stiq-up.sh --no-single-onion` (or `RELAY_SINGLE_ONION=0`) —
  standard, fully-anonymous-both-ways hidden service instead. Zero data loss, same `.onion`.
- Incompatible with the optional `vanguards` addon (`STIQ_VANGUARDS=1`) — see that flag's own
  comment in `stiq-up.sh` — and changes how Safe-Browsing's outbound Tor SOCKS use is served (a
  second, client-only tor instance is provisioned automatically when needed — see
  `relay/deploy/README.md`).
- **Before flipping this on an EXISTING community that relies on `RELAY_ONION_AUTH` client
  authorization, read and run `deploy/SINGLE_ONION.md` on the box first.** This combination
  has no test coverage anywhere in this repo; the runbook has a throwaway-onion compatibility gate
  to run before trusting it in production. Client-auth is non-negotiable and wins if the two ever
  conflict.

## Security model: co-location is the point

The relay and the dashboard share one host **by design**, and that design is the
security model — not a convenience. Whichever access path you choose, the dashboard wields
these secrets, all co-located on this one box:

| Secret | Path | What it controls |
|---|---|---|
| Issuer RSA private key | `/opt/stiq/organizer/issuer_private.pem` | Mints membership credentials |
| Organizer Nostr key | `/opt/stiq/organizer/organizer_nostr.json` | The moderation root of trust |
| Onion secret key | `/var/lib/tor/stiq-relay/hs_ed25519_secret_key` | The community's identity/address |

> **Dashboard access ≡ control of the community.**

### Backing up just the onion key (B4)

The `.onion` address is the one secret that a full community-archive restore (`deploy/stiq-up.sh
--restore <archive.stiqarch>`, see `issuer/restore-archive.mjs`) does **not** carry — restoring an
archive always mints a **fresh** onion by design, so a leaked archive can't also hand over the onion
identity. If losing the address itself (not just the box) would be disruptive — every member's saved
link, every already-issued join code — back it up separately:

```sh
sudo bash deploy/stiq-up.sh --export-onion-key onion-key.stiqokey   # prompts for a passphrase
sudo bash deploy/stiq-up.sh --import-onion-key onion-key.stiqokey   # onto replacement hardware
```

- `--export-onion-key <out>` reads `hs_ed25519_secret_key` / `hs_ed25519_public_key` / `hostname`
  from `${TOR_HS_DIR}` (`/var/lib/tor/stiq-relay`), encrypts them (AES-256-GCM + scrypt, same cost
  parameters as a community archive) under a passphrase you type interactively, and writes the blob
  to `<out>`.
- `--import-onion-key <in>` requires tor to be **stopped** first (`systemctl stop tor@default`),
  double-confirms (`type YES`) before overwriting a different key already present, then decrypts and
  writes the three files back into `${TOR_HS_DIR}` with the right ownership/permissions. Start tor
  again afterwards to bring the onion back up under its restored identity.
- Both are **standalone actions** — they run and exit immediately; they never touch packages, keys,
  or services beyond the onion identity itself, and can't be combined with `--restore` in the same
  invocation.
- ⚠️ **Store the export OFFLINE, and use a DIFFERENT passphrase than any community (`.stiqarch`)
  archive.** The two blobs protect different assets (onion identity vs. the full community trust
  root, respectively) — reusing a passphrase means one leaked passphrase could be tried against both.
  See `issuer/export-onion-key.mjs` for the container format (a distinct `STIQOKEY1` magic keeps the
  two kinds of blob from ever being cross-imported into the wrong tool).

So there is **deliberately no remote, "read-only", or delegated admin surface** that could
lull you into sharing it. We refuse to ship a thing that *looks* safe to hand out but
quietly grants the keys. If you give someone the dashboard — the onion access card, or SSH
— you have given them the community.

Going remote does **not** weaken this. The dashboard onion is still on the relay box, still
has no clearnet, and is reachable only by a key you alone hold; it simply lets *you* (the
organizer) get in from elsewhere. The trust boundary stays a single, honest line: hold all
three of {address, auth key, password}, or hold none.

## Customizing

Environment variables understood by the installer (all optional):

| Var | Default | Meaning |
|---|---|---|
| `COMMUNITY` | `stiq community` | Display name shown in join codes |
| `ORGANIZER` | `organizer` | Organizer label shown in join codes |
| `DASHBOARD_ONION` | `1` | `1` = expose dashboard via client-auth onion; `0` = SSH-tunnel only |
| `STIQ_ORG_PASSWORD` | *(generated)* | Dashboard login password (auto-generated if unset when onion on) |
| `STIQ_ENROLL_POW` | `12` | Enrollment PoW; **must stay 12** to match shipped clients |
| `STIQ_POW_DIFFICULTY` | `20` | NIP-13 difficulty for DMs |
| `STIQ_DASH_PORT` | `7799` | Dashboard loopback port |
| `RELAY_SINGLE_ONION` | `1` | `1` = whole-instance single-onion (faster rendezvous); `0` (or `--no-single-onion`) = standard hidden service |
| `SAFE_BROWSING_TOR` | `0` | Force-provision the client-only `tor@stiqclient` SOCKS instance even when `safe_browsing_api_key` isn't visible in `config.json` |

## Files

| File | Purpose |
|---|---|
| [`stiq-up.sh`](stiq-up.sh) | The one-command installer (relay + organizer, co-located). |
| [`SINGLE_ONION.md`](SINGLE_ONION.md) | Verify/flip/rollback procedure for single-onion mode, incl. the client-auth compatibility gate. |

Component-level deployment detail (Tor hardening, firewall, the relay's own checklist)
lives in [`../relay/deploy/`](../relay/deploy/); the organizer's manual layout notes are
in [`../issuer/deploy/`](../issuer/deploy/). You don't need either for the happy path —
`stiq-up.sh` does it all.

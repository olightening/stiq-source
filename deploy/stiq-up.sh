#!/usr/bin/env bash
# =============================================================================
# stiq-up.sh — ONE-COMMAND, plug-and-play STIQ community.
#
# Stands up a complete, self-hosted STIQ community on a fresh Debian/Ubuntu box:
#   • the membership-gated Nostr relay (loopback-only, Tor v3 .onion fronted)
#   • the organizer dashboard + automated enrollment mailbox
#   • all key material — issuer RSA key, organizer Nostr key, onion secret key —
#     GENERATED ON THIS BOX and never leaving it.
#
# Usage (as root, from a checkout of the stiq repo):
#       sudo bash deploy/stiq-up.sh
#   or with a name:
#       sudo COMMUNITY="Riverside Mutual Aid" ORGANIZER="stewards" bash deploy/stiq-up.sh
#
# Re-running is safe (idempotent): existing keys and the .onion are preserved.
#
# ─── Co-location is the security model, by design ────────────────────────────
# The relay and the organizer dashboard live on the SAME host. The dashboard
# binds 127.0.0.1 only — the ONLY way to reach it is to SSH into this box. But
# anyone who can SSH in already holds the issuer RSA private key, the organizer
# Nostr secret key, and the Tor onion secret key (all on this disk). So:
#
#       dashboard access  ==  shell on this box  ==  full community compromise.
#
# That equivalence is deliberate. There is no remote, "read-only", or delegated
# admin surface to give a false sense of safety. Granting someone the dashboard
# means granting them the community. Treat SSH access accordingly.
# =============================================================================
set -euo pipefail
# Every secret this script generates (issuer RSA key, organizer Nostr key, client-auth key,
# dashboard password) must be private from creation — not just after a late chmod. A strict
# umask makes every new file 0600 and every new dir 0700 for the whole run, closing the window
# where keys would otherwise sit world-readable while npm postinstall hooks run as root.
umask 077

# ---------------------------------------------------------------------------
# Tunables (override via environment)
# ---------------------------------------------------------------------------
COMMUNITY_NAME="${COMMUNITY:-${STIQ_COMMUNITY_NAME:-stiq community}}"
ORGANIZER_LABEL="${ORGANIZER:-${STIQ_ORGANIZER_LABEL:-organizer}}"
ENROLL_POW="${STIQ_ENROLL_POW:-12}"     # MUST match the client's ENROLL_POW_DIFFICULTY (=12)
DM_POW="${STIQ_POW_DIFFICULTY:-20}"     # NIP-13 difficulty for kind-1059 DMs
DASH_PORT="${STIQ_DASH_PORT:-7799}"     # dashboard loopback port
NODE_MAJOR="${STIQ_NODE_MAJOR:-20}"     # Node LTS to install if missing
GO_VERSION="${STIQ_GO_VERSION:-1.24.4}" # Go to install if the relay must be built and go is absent

# Remote dashboard access: expose the dashboard via its OWN Tor v3 onion with client
# authorization, so the organizer can reach it from any device (Tor Browser) without SSH —
# while it stays co-located on the relay box with NO clearnet. Set DASHBOARD_ONION=0 to keep
# the dashboard SSH-tunnel-only instead.
DASHBOARD_ONION="${DASHBOARD_ONION:-1}"
ORG_PASSWORD="${STIQ_ORG_PASSWORD:-}"   # dashboard login password; generated if empty when onion on

# Members-only relay reach (lever 2 — npub-blind relay-reach restriction). ENFORCEMENT flag only:
# key generation is DECOUPLED from enforcement (see the relay-reach block in step 8). The shared
# community auth key is minted, persisted, and carried into every v4 community code UNCONDITIONALLY —
# a code that carries a reach key which no onion enforces just behaves like a public onion, so
# pre-distributing v4 codes never bricks anyone. This flag controls ONLY whether tor ENFORCES it:
# when 1, the shared auth PUBLIC key is dropped into the relay onion's authorized_clients/, so tor
# publishes the descriptor encrypted to that key and an outsider who only learns the .onion cannot
# connect at all; when 0, no authorized_clients entry is written, the onion stays public, and the v4
# code's reach key is simply inert.
#   DEFAULT 1 (members-only). The app rollout (community-code v4 + ClientOnionAuthDir) has shipped,
#   so enforcing by default is safe for a NEW community. Enforcing LOCKS OUT any client not yet
#   carrying the auth key, so on an EXISTING community whose members predate v4, first run one deploy
#   with RELAY_ONION_AUTH=0 to pre-distribute inert v4 codes, then flip to 1. Deleting
#   organizer/relay_auth/community_priv.pem rotates the key and re-locks removed members' reach.
RELAY_ONION_AUTH="${RELAY_ONION_AUTH:-1}"

# Whole-instance single-onion mode (Tor stability+speed W4). Ordinarily a v3 hidden service's own
# path to its rendezvous point is a normal, anonymous 3-hop Tor circuit — protecting the SERVER's
# location from the rendezvous point too. This box's location/operator is never actually hidden
# (it's rented, SSH-reachable hosting with a billing trail); only MEMBERS' connections need
# anonymity, and single-onion mode does not touch that side at all — from a client's perspective
# this stays a completely normal v3 .onion, reached the completely normal (3-hop, anonymous) way.
# Dropping the SERVER's own 3-hop leg (HiddenServiceNonAnonymousMode 1 + HiddenServiceSingleHopMode
# 1 — Tor's official "single onion service" mode) removes one full circuit build from the
# rendezvous path, which is where a meaningful slice of onion connect latency/jitter comes from.
# This is WHOLE-INSTANCE: tor requires SocksPort 0 process-wide the moment ANY HiddenService on the
# instance runs single-hop, so it applies to every onion this tor process fronts (relay + dashboard
# + the optional SSH-recovery onion) — see the stiq-base.conf drop-in in step 8.
#   DEFAULT 1 (on). Set --no-single-onion (or RELAY_SINGLE_ONION=0) to keep the standard,
#   fully-anonymous-both-ways hidden service instead (also required to use the vanguards addon —
#   see STIQ_VANGUARDS below). Flipping this on an EXISTING community that relies on
#   RELAY_ONION_AUTH client-auth has NOT been verified in this repo to be compatible — read and run
#   deploy/SINGLE_ONION.md's compat gate on the box BEFORE relying on this default in
#   production; client-auth wins if the two are ever found to conflict.
#
#   Capture EXPLICIT intent before defaulting: `${VAR+1}` is set iff the caller exported the var at
#   all, which is the only way to tell "unset" apart from "deliberately 0". Using `${VAR:-}` here
#   instead would read an explicit RELAY_SINGLE_ONION=0 as "unset" and let the remembered choice
#   override it — silently inverting the persistence below. --no-single-onion/--single-onion set
#   this too (see the CLI block). Resolution against the remembered choice happens after validation.
SINGLE_ONION_EXPLICIT="${RELAY_SINGLE_ONION+1}"
RELAY_SINGLE_ONION="${RELAY_SINGLE_ONION:-1}"

# Force-provision a separate, client-only tor instance for Safe-Browsing's own outbound SOCKS use
# (STIQ_TOR_SOCKS, relay/main.go) even when this script cannot see that Safe-Browsing is configured
# — e.g. the API key was supplied purely via the relay's SAFE_BROWSING_API_KEY environment variable,
# which never touches config.json. The installer already auto-detects a non-empty
# safe_browsing_api_key already present in ${RELAY_ETC}/config.json (set by the dashboard on a prior
# run) and provisions the instance without needing this flag — see step 8c. Only matters when
# RELAY_SINGLE_ONION=1 (that mode is what sets SocksPort 0 on the main instance in the first place).
SAFE_BROWSING_TOR="${SAFE_BROWSING_TOR:-0}"

# Onion-service proof-of-work + full intro-point DoS defenses on every community onion (relay +
# dashboard + every federated mirror, since a mirror is just another stiq-up.sh relay). Default ON.
#   ⚠ SHIP DARK / AUTO-DEGRADE: HiddenServicePoWDefensesEnabled needs a tor built with the equix
#   'pow' module — a tor WITHOUT it refuses to start, which would wedge the onion. So this NEVER
#   forces PoW blindly: tor_has_pow_module() probes `tor --list-modules` and, when the module is
#   absent, silently falls back to IntroDoS-only so the onion always publishes. Set
#   STIQ_RELAY_POW_DEFENSE=0 to force IntroDoS-only (deliberate rollback).
RELAY_POW_DEFENSE="${STIQ_RELAY_POW_DEFENSE:-1}"

# Optional vanguards addon (layer-3 guard selection + Rendguard/Bandguards on top of tor's
# built-in vanguards-lite). When 1 — AND ONLY when RELAY_SINGLE_ONION is 0 — the installer emits a
# ControlPort unix:/var/run/tor/control + CookieAuthentication 1 drop-in (stiq-controlport.conf,
# step 8), pip3-installs the `vanguards` package, and enables relay/deploy/stiq-vanguards.service
# against that control socket. HSLayer2/3Nodes stay UNSET on purpose (static pinning is a
# deanonymisation risk) — the addon manages guard selection dynamically instead.
#   NOTE: ControlPort is NOT "always-on" — earlier versions of this comment (and of
#   relay/deploy/torrc and stiq-vanguards.service's own header) claimed torrc always carried it,
#   which was never true of the live torrc.d drop-ins actually written by this script (only the
#   unused relay/deploy/torrc reference file had it), so vanguards silently had no control socket
#   to attach to. Fixed: the installer now writes ControlPort only when it is actually needed.
#   NOTE: vanguards defends the hidden service's OWN 3-hop path to its rendezvous point (guard
#   discovery / Rendguard / Bandguards). RELAY_SINGLE_ONION=1 (the default) removes that path
#   entirely — HiddenServiceSingleHopMode skips it — so there is nothing left for vanguards to
#   protect on this instance; step 12b skips installing it (WARN, not an error) whenever
#   RELAY_SINGLE_ONION=1, regardless of this flag. Pass --no-single-onion to use vanguards.
#   ⚠ OPT-IN / SHIP DARK (default 0): a normal run installs nothing extra and tor keeps running
#   with just its built-in vanguards-lite. Flip to 1 (with --no-single-onion) to add layer-3 guard
#   hardening; failures are WARN-only (a broken pip/network never blocks the rest of the deploy).
STIQ_VANGUARDS="${STIQ_VANGUARDS:-0}"

# Token domain separation (posting/read tokens signed under DEDICATED keys, not the enrollment
# issuer key — closes the Sybil/ban-evasion hole where a plentiful posting token also verifies as a
# scarce membership-binding credential, and is the premise the client-side member roll rests on:
# without it a drawn posting token can bind a fresh npub, so the organizer refuses to publish the
# roll at all and a community gets zero ban-evasion protection).
#
# The default is INHERITED, not fixed — resolved once $CONFIG_PATH is known (search
# "resolve_token_domain_sep_default"). Fresh install ⇒ 1; existing box that already has separation
# ⇒ 1; existing box WITHOUT it ⇒ 0. An explicit STIQ_TOKEN_DOMAIN_SEP always wins.
#   ⚠ COORDINATED FLIP: flipping the organizer's STIQ_TOKEN_DOMAIN_SEP alone bricks all posting — the
#   relay would keep verifying K_post tokens against K_enroll and reject them. When this is 1, the
#   installer fetches the organizer's posting/binding public keys over loopback (/api/token-keys)
#   AFTER the organizer restarts and injects them into the relay config, then restarts the relay too
#   (see step 9b below) — so enabling it here does the whole coordinated rollout in one run.
TOKEN_DOMAIN_SEP="${STIQ_TOKEN_DOMAIN_SEP:-}"   # empty = unset; see resolve_token_domain_sep_default

# Censorable reads (asks #4). When 1, the organizer enforces read-auth (STIQ_READ_AUTH) so it can
# refuse a read-REVOKED member's read-token draws, and the relay ADVERTISES content_encryption +
# read_auth_required so clients seal post bodies and carry a reader-auth on read draws. POSTING stays
# blind + uncensorable regardless (write draws never carry reader-auth); the most a mod can do to a
# poster is ban → advisory mod-log. OFF by default: read draws stay anonymous, bodies stay plaintext,
# byte-identical to today.
#   ⚠ ONE-WAY, FLEET-COORDINATED FLIP: once the relay advertises content_encryption, updated clients
#   SEAL new post bodies — a client that predates sealing can no longer read them. NEVER enable this
#   the instant the binary swaps. The correct order (see MEDIA_TOKENS_CENSORABLE_READS_SPEC.md §6):
#   (1) ship the sealing-aware client, (2) let members update, (3) THEN re-run with
#   STIQ_CONTENT_ENCRYPTION=1. Requires token domain separation (STIQ_TOKEN_DOMAIN_SEP=1) so read
#   tokens are drawn under K_read.
CONTENT_ENCRYPTION="${STIQ_CONTENT_ENCRYPTION:-0}"

# Space tokens everywhere (tokens-everywhere). When 1, the relay REQUIRES space-write tokens on
# member space content (channel messages, group chat/replies, h-tagged group reactions, DM wraps) —
# so channels/groups/DMs share the feed's anti-spam token economics. Control-plane kinds (joins,
# leaves, adds/removes, metadata, key delivery, settings) are NEVER token-taxed. OFF by default:
# space content publishes tokenless, byte-identical to today.
#   ⚠ ONE-WAY, FLEET-COORDINATED FLIP (mirrors STIQ_CONTENT_ENCRYPTION): once the relay REQUIRES
#   space tokens, a client that predates attaching them can no longer post to channels/groups/DMs.
#   Order: (1) ship the space-token client, (2) let members update, (3) THEN re-run with
#   STIQ_SPACE_TOKENS=1. Requires token domain separation (STIQ_TOKEN_DOMAIN_SEP=1) so space tokens
#   are drawn+verified under K_spacewrite (the relay's space_write_issuer_public_keys, wired in 9b).
SPACE_TOKENS="${STIQ_SPACE_TOKENS:-0}"

# Real push over Tor (T1). When 1, deploy an off-the-shelf ntfy server + the keyless pushwatcher
# (relay/cmd/pushwatcher) as systemd units, add HiddenServicePort lines for both onto the RELAY onion,
# and write push_watcher_onion/push_ntfy_onion into the relay config (which flows into NIP-11 on the
# next relay restart). Content-free "wake and sync" only — the watcher holds NO keys and never
# decrypts; ntfy and the watcher bind loopback + onion, never clearnet.
#   ⚠ OPT-IN / SHIP DARK (default 0): a normal run deploys NOTHING new and leaves NIP-11 without a
#   push block, so every client stays on the unchanged WorkManager polling fallback. Flip to 1 only
#   AFTER an app build carrying PUSH_UNIFIEDPUSH=true + the native module has reached your members;
#   the relay then advertises the watcher and enrolled apps begin registering. Turning it back to 0
#   (or clearing the NIP-11 push block) makes every client fall back to polling with no code change.
PUSH_WATCHER="${PUSH_WATCHER:-0}"

# Restore a community from an encrypted archive (T16) onto THIS fresh box, instead of minting new
# keys. Set via the env var or the `--restore <archive>` flag (the flag wins). When set, the installer
# runs issuer/restore-archive.mjs BEFORE any key generation or config merge, so the box adopts the
# archived issuer/organizer/community keys + relay config + membership (double-spend) state. The
# passphrase is read from STIQ_ARCHIVE_PASS (or prompted on a TTY) and NEVER echoed.
#   NOTE: the .onion address is NOT in the archive by design, so a restored community gets a FRESH
#   onion — reissue join codes. Stop services first (systemctl stop stiq.target) for a clean restore.
RESTORE_ARCHIVE="${RESTORE_ARCHIVE:-}"

# Onion-key disaster-recovery export/import (B4) — set only via the `--export-onion-key <out>` /
# `--import-onion-key <in>` flags below (no env-var form: these are one-shot, standalone actions,
# not part of the normal provisioning run). See issuer/export-onion-key.mjs for the container format
# (distinct STIQOKEY1 magic — deliberately NOT the same blob as a --restore community archive, which
# never carries the onion key by design).
EXPORT_ONION_KEY_OUT=""
IMPORT_ONION_KEY_IN=""

# Mirror federation (attach-mode). `--attach <bundle.json>` provisions THIS box as a BLIND MIRROR
# relay of an EXISTING community instead of standing up a new one: relay binary + its own fresh
# .onion + the community's PUBLIC verification keys and enforcement flags, and NOTHING else — no
# organizer, no dashboard, no issuer private key, no epoch keys, no enrollment mailbox. Wherever
# the community runs content encryption the mirror stores ciphertext only; it could not decrypt a
# body even if modified to try, because no decryption key ever reaches this box. The bundle comes
# from the PRIMARY box via `--export-mirror-bundle <out>` (a standalone action, like the onion-key
# pair). The one shared piece of key material a bundle carries is the community's Tor v3 reach key
# (the same `ck` every member's join code already holds) so the mirror can enforce members-only
# reach and self-probe its own auth-gated onion — it grants RELAY REACH, never content access.
# After attach, authorize the mirror from the primary: stiq-org mirror-add + mirrors-publish.
ATTACH_BUNDLE=""
EXPORT_MIRROR_BUNDLE_OUT=""

PREFIX="/opt/stiq"                      # everything the organizer needs, co-located here
ORG_DIR="${PREFIX}/organizer"           # the issuer/ tree (dashboard + keys)
CLIENT_DIR="${PREFIX}/client"           # node_modules the organizer imports (../client/node_modules)
AUTH_DIR="${ORG_DIR}/dashboard_auth"    # client-auth private key + password + access card (0600)
RELAY_AUTH_DIR="${ORG_DIR}/relay_auth"  # shared community onion-auth private key (0600), always minted
RELAY_ETC="/etc/stiq-relay"
RELAY_LIB="/var/lib/stiq-relay"
STIQ_STATE_DIR="/var/lib/stiq"          # installer's own durable state (NOT relay data — see RELAY_LIB)
SINGLE_ONION_CHOICE="${STIQ_STATE_DIR}/single_onion.choice"  # the effective single-onion mode tor last actually ran with
# Name of the client-only tor instance that carries Safe-Browsing's SOCKS proxy under single-onion
# mode. Defined HERE, not at its step-8c provisioning site, because step 8's restart must be able to
# RELEASE 127.0.0.1:9050 from it before tor reclaims that port — see the ordering note in step 8.
# NO HYPHEN, and this is not cosmetic: Debian's tor-instance-create rejects any non-alphanumeric
# name (`grep -q '[^a-zA-Z0-9]'` -> "Invalid name"), so the earlier `stiq-client` was uncreatable
# and step 8c's `die` would have aborted EVERY run on a single-onion + Safe-Browsing box. The
# ladder test never caught it because it stubs tor-instance-create — the same blind spot that hid
# the verify-config-as-root bug. Do not "tidy" the hyphen back in.
TOR_CLIENT_INSTANCE="stiqclient"
RELAY_DATA_DIR="${RELAY_LIB}/data"      # relay badger DataDir (must match the config's data_dir)
RELAY_BIN="/usr/local/bin/stiq-relay"
WATCHER_BIN="${PREFIX}/pushwatcher"     # keyless push watcher binary (installed only when PUSH_WATCHER=1)
TOR_HS_DIR="/var/lib/tor/stiq-relay"
DASH_HS_DIR="/var/lib/tor/stiq-dashboard"

# Loopback ports + the ntfy version pinned for the off-the-shelf install (T1). ntfy and the watcher
# each bind ONLY these loopback ports; Tor fronts them via matching HiddenServicePort lines.
WATCHER_PORT="8787"                     # pushwatcher register API (loopback + onion)
NTFY_PORT="2586"                        # ntfy HTTP (loopback + onion)

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# CLI flags. The installer historically takes NO positional args; flags are `--restore` (T16),
# which rebuilds a community from an encrypted archive before services stand up, the B4
# onion-key disaster-recovery pair `--export-onion-key` / `--import-onion-key` (standalone actions —
# see the "0b." block below, right after REPO is resolved), and `--no-single-onion`, an escape
# hatch for RELAY_SINGLE_ONION (default-on — see the tunable's own comment above) so a one-off
# `--no-single-onion` run doesn't require remembering/exporting the env var. Parsed with `set -u`
# safety (tolerates zero args). Anything else is a hard error so a typo can't be ignored.
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore)
      [[ $# -ge 2 ]] || die "--restore requires an archive path: --restore <archive.stiqarch>"
      RESTORE_ARCHIVE="$2"; shift 2 ;;
    --restore=*)
      RESTORE_ARCHIVE="${1#--restore=}"; shift ;;
    --no-single-onion)
      RELAY_SINGLE_ONION=0; SINGLE_ONION_EXPLICIT=1; shift ;;
    --single-onion)
      RELAY_SINGLE_ONION=1; SINGLE_ONION_EXPLICIT=1; shift ;;
    --export-onion-key)
      [[ $# -ge 2 ]] || die "--export-onion-key requires an output path: --export-onion-key <out>"
      EXPORT_ONION_KEY_OUT="$2"; shift 2 ;;
    --export-onion-key=*)
      EXPORT_ONION_KEY_OUT="${1#--export-onion-key=}"; shift ;;
    --import-onion-key)
      [[ $# -ge 2 ]] || die "--import-onion-key requires an input path: --import-onion-key <in>"
      IMPORT_ONION_KEY_IN="$2"; shift 2 ;;
    --import-onion-key=*)
      IMPORT_ONION_KEY_IN="${1#--import-onion-key=}"; shift ;;
    --attach)
      [[ $# -ge 2 ]] || die "--attach requires a bundle path: --attach <stiq-mirror-bundle.json>"
      ATTACH_BUNDLE="$2"; shift 2 ;;
    --attach=*)
      ATTACH_BUNDLE="${1#--attach=}"; shift ;;
    --export-mirror-bundle)
      [[ $# -ge 2 ]] || die "--export-mirror-bundle requires an output path: --export-mirror-bundle <out.json>"
      EXPORT_MIRROR_BUNDLE_OUT="$2"; shift 2 ;;
    --export-mirror-bundle=*)
      EXPORT_MIRROR_BUNDLE_OUT="${1#--export-mirror-bundle=}"; shift ;;
    -h|--help)
      cat <<'USAGE'
stiq-up.sh — stand up (or restore) a self-hosted STIQ community.

  sudo bash deploy/stiq-up.sh                        # fresh community (mints new keys)
  sudo STIQ_ARCHIVE_PASS=... bash deploy/stiq-up.sh --restore <archive.stiqarch>
                                                     # rebuild a community from an encrypted archive
  sudo PUSH_WATCHER=1 bash deploy/stiq-up.sh         # also deploy ntfy + the keyless push watcher
  sudo STIQ_VANGUARDS=1 bash deploy/stiq-up.sh --no-single-onion
                                                     # deploy the vanguards addon (needs single-onion OFF)
  sudo bash deploy/stiq-up.sh --no-single-onion      # standard, fully-anonymous-both-ways onion(s)
                                                     # REMEMBERED: later re-runs keep this mode
  sudo bash deploy/stiq-up.sh --single-onion         # opt single-onion back on (clears the above)
  sudo SAFE_BROWSING_TOR=1 bash deploy/stiq-up.sh    # force the Safe-Browsing client-only tor instance
  sudo bash deploy/stiq-up.sh --export-onion-key onion-key.stiqokey
                                                     # (B4) back up ONLY the .onion identity, encrypted
  sudo bash deploy/stiq-up.sh --import-onion-key onion-key.stiqokey
                                                     # (B4) restore the .onion identity onto this box (stop tor first)
  sudo bash deploy/stiq-up.sh --export-mirror-bundle mirror.json
                                                     # on the PRIMARY: emit the public keys + flags a mirror needs
  sudo bash deploy/stiq-up.sh --attach mirror.json   # on a FRESH box: become a BLIND MIRROR relay of that
                                                     # community (relay + own onion only — no organizer, no
                                                     # issuer keys; ciphertext-only wherever sealing is on).
                                                     # Then on the primary: stiq-org mirror-add + mirrors-publish

Key env tunables: COMMUNITY, ORGANIZER, DASHBOARD_ONION, RELAY_ONION_AUTH, RELAY_SINGLE_ONION,
SAFE_BROWSING_TOR, STIQ_RELAY_POW_DEFENSE, STIQ_TOKEN_DOMAIN_SEP, PUSH_WATCHER, STIQ_VANGUARDS,
RESTORE_ARCHIVE, STIQ_ARCHIVE_PASS. See the header comment block. See deploy/SINGLE_ONION.md
before flipping RELAY_SINGLE_ONION on an EXISTING community that relies on client-auth.

--export-onion-key/--import-onion-key are STANDALONE actions (they run and exit immediately,
touching nothing else) — see issuer/export-onion-key.mjs. Store an export OFFLINE, under a
DIFFERENT passphrase than any --restore community archive.
USAGE
      exit 0 ;;
    *)
      die "unknown argument '$1' (supported: --restore <archive>, --attach <bundle>, --export-mirror-bundle <out>, --export-onion-key <out>, --import-onion-key <in>, --help)." ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. Preflight — root, OS, locate the repo
# ---------------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "must run as root (use sudo)."
command -v apt-get >/dev/null 2>&1 || die "this installer targets Debian/Ubuntu (apt-get not found)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ -d "${REPO}/relay" && -d "${REPO}/issuer" ]] || die "run this from a stiq checkout (expected ${REPO}/relay and ${REPO}/issuer)."

# ---------------------------------------------------------------------------
# 0b. Onion-key disaster-recovery export/import (B4) — STANDALONE actions: each runs and exits
#     immediately, before any package install / key generation / service change below. Mutually
#     exclusive with each other and with --restore: a community archive NEVER carries the onion key
#     by design (--restore always mints a fresh .onion), and this tool carries ONLY the onion key —
#     mixing the two flags in one invocation is almost certainly an operator mistake, so refuse it
#     rather than silently doing just one.
# ---------------------------------------------------------------------------
if [[ -n "$EXPORT_ONION_KEY_OUT" && -n "$IMPORT_ONION_KEY_IN" ]]; then
  die "--export-onion-key and --import-onion-key are mutually exclusive."
fi
if [[ ( -n "$EXPORT_ONION_KEY_OUT" || -n "$IMPORT_ONION_KEY_IN" ) && -n "$RESTORE_ARCHIVE" ]]; then
  die "--export-onion-key/--import-onion-key cannot be combined with --restore. A community archive never carries the onion key by design (--restore always mints a fresh .onion); run the onion-key action as its own, separate invocation."
fi

if [[ -n "$EXPORT_ONION_KEY_OUT" ]]; then
  say "Exporting the onion service secret key (disaster recovery, B4)..."
  command -v node >/dev/null 2>&1 || die "node is required to export the onion key (run this installer's normal flow first to install it, or apt-get install nodejs)."
  HS_SECRET="${TOR_HS_DIR}/hs_ed25519_secret_key"
  [[ -f "$HS_SECRET" ]] || die "no onion key found at ${HS_SECRET} — nothing to export (has this box been provisioned yet?)."
  [[ -t 0 ]] || die "--export-onion-key needs an interactive terminal to prompt for the passphrase (stdin is not a TTY)."
  printf 'Passphrase to encrypt the onion-key export (input hidden): ' >&2
  IFS= read -rs EXPORT_ONION_PASS || true
  printf '\n' >&2
  [[ -n "$EXPORT_ONION_PASS" ]] || die "a passphrase is required — refusing to export the onion key unencrypted."
  printf '%s' "$EXPORT_ONION_PASS" | node "${REPO}/issuer/export-onion-key.mjs" --export --hs-dir "${TOR_HS_DIR}" --out "${EXPORT_ONION_KEY_OUT}" \
    || die "onion-key export failed (see message above)."
  unset EXPORT_ONION_PASS
  warn "Store ${EXPORT_ONION_KEY_OUT} OFFLINE, and use a DIFFERENT passphrase than any community (.stiqarch) archive. The two blobs protect different assets (onion identity vs. the full community trust root) — reusing a passphrase means one leaked passphrase can be tried against both."
  say "Onion key exported to ${EXPORT_ONION_KEY_OUT}."
  exit 0
fi

if [[ -n "$IMPORT_ONION_KEY_IN" ]]; then
  say "Importing an onion service secret key (disaster recovery, B4)..."
  [[ -f "$IMPORT_ONION_KEY_IN" ]] || die "onion-key file not found: ${IMPORT_ONION_KEY_IN}"
  command -v node >/dev/null 2>&1 || die "node is required to import the onion key (run this installer's normal flow first to install it, or apt-get install nodejs)."
  if systemctl is-active --quiet tor@default 2>/dev/null || systemctl is-active --quiet tor 2>/dev/null; then
    die "tor is running — stop it first (systemctl stop tor@default, or 'tor' on distros without the @default unit) so the onion key can be replaced cleanly, then re-run --import-onion-key."
  fi
  if [[ -f "${TOR_HS_DIR}/hs_ed25519_secret_key" ]]; then
    warn "a DIFFERENT onion key already exists at ${TOR_HS_DIR} — importing will OVERWRITE it, changing the community's .onion address to the one in ${IMPORT_ONION_KEY_IN}."
    [[ -t 0 ]] || die "overwriting an existing onion key needs an interactive terminal to confirm (stdin is not a TTY)."
    printf 'Type YES to overwrite the existing onion key: ' >&2
    read -r IMPORT_ONION_CONFIRM || true
    [[ "$IMPORT_ONION_CONFIRM" == "YES" ]] || die "import aborted (confirmation not given)."
  fi
  [[ -t 0 ]] || die "--import-onion-key needs an interactive terminal to prompt for the passphrase (stdin is not a TTY)."
  printf 'Passphrase for the onion-key export (input hidden): ' >&2
  IFS= read -rs IMPORT_ONION_PASS || true
  printf '\n' >&2
  [[ -n "$IMPORT_ONION_PASS" ]] || die "a passphrase is required."
  mkdir -p "${TOR_HS_DIR}"
  printf '%s' "$IMPORT_ONION_PASS" | node "${REPO}/issuer/export-onion-key.mjs" --import --hs-dir "${TOR_HS_DIR}" --in "${IMPORT_ONION_KEY_IN}" \
    || die "onion-key import failed (wrong passphrase, or a corrupt/tampered file?)."
  unset IMPORT_ONION_PASS
  IMPORT_TOR_USER="debian-tor"; id -u "$IMPORT_TOR_USER" >/dev/null 2>&1 || IMPORT_TOR_USER="tor"
  chown -R "${IMPORT_TOR_USER}:${IMPORT_TOR_USER}" "${TOR_HS_DIR}" 2>/dev/null || true
  chmod 700 "${TOR_HS_DIR}"
  say "Onion key imported into ${TOR_HS_DIR}. Start tor (systemctl start tor@default) to bring the onion back up under its restored identity."
  exit 0
fi

# ---------------------------------------------------------------------------
# 0c. Mirror-bundle export — STANDALONE action, run on a provisioned PRIMARY box. Emits the
#     community-semantic subset of the relay config (public keys, enforcement flags, limits — an
#     explicit ALLOWLIST, never a blind copy) plus the shared community reach key, as one JSON
#     file to carry to the mirror box for `--attach`. By construction it carries NO
#     organizer/issuer private key, NO epoch/content keys, NO safe-browsing API key, and NO
#     box-local paths — a mirror provisioned from it is blind to sealed content because nothing
#     in the bundle can decrypt anything.
# ---------------------------------------------------------------------------
if [[ -n "$EXPORT_MIRROR_BUNDLE_OUT" ]]; then
  [[ -n "$ATTACH_BUNDLE" ]] && die "--export-mirror-bundle and --attach are mutually exclusive (export runs on the primary, attach on the mirror box)."
  say "Exporting the mirror bundle (community public keys + enforcement flags)..."
  command -v python3 >/dev/null 2>&1 || die "python3 is required (a provisioned primary has it — is this box provisioned?)."
  [[ -f "${RELAY_ETC}/config.json" ]] || die "no relay config at ${RELAY_ETC}/config.json — run this on the PRIMARY community box."
  [[ -s "${TOR_HS_DIR}/hostname" ]] || die "no relay onion at ${TOR_HS_DIR}/hostname — run this on the PRIMARY community box."
  [[ -f "${RELAY_AUTH_DIR}/community_priv.pem" ]] || die "no community reach key at ${RELAY_AUTH_DIR}/community_priv.pem — run this on the PRIMARY community box."
  EXPORT_ONION_AUTH=0
  [[ -f "${TOR_HS_DIR}/authorized_clients/community.auth" ]] && EXPORT_ONION_AUTH=1
  STIQ_MB_CONFIG="${RELAY_ETC}/config.json" \
  STIQ_MB_ONION="$(cat "${TOR_HS_DIR}/hostname")" \
  STIQ_MB_ONION_AUTH="$EXPORT_ONION_AUTH" \
  STIQ_MB_REACH_PEM="${RELAY_AUTH_DIR}/community_priv.pem" \
  STIQ_MB_COMMUNITY="${COMMUNITY_NAME}" \
  STIQ_MB_OUT="$EXPORT_MIRROR_BUNDLE_OUT" \
  python3 <<'PY' || die "mirror-bundle export failed (see message above)."
import json, os, sys

with open(os.environ['STIQ_MB_CONFIG']) as f:
    cfg = json.load(f)

# The community-semantic allowlist: what a mirror must AGREE with the primary on to serve the same
# fleet (verification keys, org trust root, admission rules, fleet-coordinated enforcement flags).
# Box-local keys (listen/data_dir/membership_file/fdroid_repo_dir), runtime secrets
# (safe_browsing_api_key) and per-box push onions are deliberately NOT here.
ALLOW = [
    'issuer_public_keys', 'binding_issuer_public_keys', 'posting_issuer_public_keys',
    'picture_write_issuer_public_keys', 'audio_write_issuer_public_keys',
    'space_write_issuer_public_keys', 'organizer_pubkeys', 'allowed_kinds',
    'enroll_pow', 'pow_difficulty', 'max_event_bytes', 'max_tags_per_event',
    'max_limit', 'default_limit', 'bytes_per_token',
    'blind_required', 'holder_proof_required', 'private_group_read_auth',
    'content_encryption', 'read_auth_required', 'space_tokens_required',
    'media_tokens_enabled', 'websocket_compression',
]
sub = {k: cfg[k] for k in ALLOW if k in cfg}
if not sub.get('issuer_public_keys'):
    sys.exit('primary config has no issuer_public_keys — refusing to export a bundle no relay could enforce membership with.')
if not sub.get('organizer_pubkeys'):
    sys.exit('primary config has no organizer_pubkeys — refusing to export a bundle without the moderation trust root.')

with open(os.environ['STIQ_MB_REACH_PEM']) as f:
    reach_pem = f.read()

bundle = {
    'stiq_mirror_bundle': 1,
    'community': os.environ.get('STIQ_MB_COMMUNITY', ''),
    'primary_onion': os.environ['STIQ_MB_ONION'].strip(),
    'onion_auth': os.environ.get('STIQ_MB_ONION_AUTH') == '1',
    'relay_auth_priv_pem': reach_pem,
    'config': sub,
}
out = os.environ['STIQ_MB_OUT']
tmp = out + '.tmp'
with open(tmp, 'w') as f:
    json.dump(bundle, f, indent=2)
    f.write('\n')
os.replace(tmp, out)
PY
  chmod 600 "$EXPORT_MIRROR_BUNDLE_OUT"
  say "Mirror bundle written to ${EXPORT_MIRROR_BUNDLE_OUT} (chmod 600)."
  say "Carry it to the mirror box and run:  sudo bash deploy/stiq-up.sh --attach ${EXPORT_MIRROR_BUNDLE_OUT##*/}"
  warn "The bundle carries the shared community REACH key (the same ck every member's join code holds) — it grants relay reach, never content access. Still: transfer over scp/a private channel and delete the copy on the mirror box once attached. Re-export + re-attach after any fleet-coordinated flag flip on the primary (content encryption, space tokens, ...) so the mirror advertises the same enforcement."
  exit 0
fi

# PUSH_WATCHER is a strict 0/1 gate — reject anything else early so a stray value can't half-enable
# the push stack (and to keep the default run's behavior unambiguous).
case "$PUSH_WATCHER" in
  0|1) ;;
  *) die "PUSH_WATCHER must be 0 or 1 (got '${PUSH_WATCHER}')." ;;
esac

# STIQ_VANGUARDS is likewise a strict 0/1 gate (same rationale as PUSH_WATCHER above).
case "$STIQ_VANGUARDS" in
  0|1) ;;
  *) die "STIQ_VANGUARDS must be 0 or 1 (got '${STIQ_VANGUARDS}')." ;;
esac

# RELAY_SINGLE_ONION and SAFE_BROWSING_TOR are likewise strict 0/1 gates.
case "$RELAY_SINGLE_ONION" in
  0|1) ;;
  *) die "RELAY_SINGLE_ONION must be 0 or 1 (got '${RELAY_SINGLE_ONION}')." ;;
esac

# --- Remember the single-onion choice across re-runs ---------------------------------------------
# RELAY_SINGLE_ONION defaults to 1, and nothing read on-disk state — so a deliberate
# `--no-single-onion` lived exactly ONE invocation. The next routine re-run (plain
# `sudo bash deploy/stiq-up.sh`, which deploy/README frames as unconditionally safe to repeat)
# silently re-flipped single-onion back ON, and on a box deliberately running vanguards it also
# silently tore them down (step 12b) without so much as a warn.
#
# Why this flag and not the others: no installer flag is persisted (RELAY_ONION_AUTH,
# DASHBOARD_ONION, PUSH_WATCHER, STIQ_TOKEN_DOMAIN_SEP, STIQ_VANGUARDS are all per-invocation) —
# what's persisted is key material. But this is the only default-ON flag whose OFF state the repo
# itself advertises as a ROLLBACK LEVER (SINGLE_ONION.md Part (c)). The others fail safe;
# a silent re-default here un-does a documented recovery action. And the REASON for the opt-out —
# this box's tor rejects the mode, or this box runs vanguards — is a property of the BOX, not of
# the invocation, so the box is where it belongs.
#
# Precedence: explicit intent this run (env var or CLI flag) > remembered choice > default.
# Resolved BEFORE the summary below so the banner never claims a mode we aren't about to apply.
if [[ -z "$SINGLE_ONION_EXPLICIT" && -f "$SINGLE_ONION_CHOICE" ]]; then
  # No pipeline here on purpose: under `set -o pipefail`, a `tr … | head -c 1` would SIGPIPE tr,
  # make the whole substitution non-zero, and `set -e` would kill the installer over a state file.
  REMEMBERED_SINGLE_ONION="$(head -c 1 "$SINGLE_ONION_CHOICE" 2>/dev/null || true)"
  case "$REMEMBERED_SINGLE_ONION" in
    0|1)
      if [[ "$REMEMBERED_SINGLE_ONION" != "$RELAY_SINGLE_ONION" ]]; then
        say "  single-onion: honouring the remembered choice from a previous run (RELAY_SINGLE_ONION=${REMEMBERED_SINGLE_ONION}, recorded in ${SINGLE_ONION_CHOICE}). Pass --single-onion or --no-single-onion to override."
      fi
      RELAY_SINGLE_ONION="$REMEMBERED_SINGLE_ONION" ;;
    *)
      warn "${SINGLE_ONION_CHOICE} is unreadable/corrupt — ignoring it and using RELAY_SINGLE_ONION=${RELAY_SINGLE_ONION}." ;;
  esac
fi
case "$SAFE_BROWSING_TOR" in
  0|1) ;;
  *) die "SAFE_BROWSING_TOR must be 0 or 1 (got '${SAFE_BROWSING_TOR}')." ;;
esac

# --restore preflight: the archive must exist and a passphrase must be available. We READ the
# passphrase from STIQ_ARCHIVE_PASS (or prompt once on an interactive TTY) and NEVER echo it. Fail
# fast here — before we touch keys or services — if either is missing.
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  [[ -f "$RESTORE_ARCHIVE" ]] || die "RESTORE_ARCHIVE='${RESTORE_ARCHIVE}' is not a readable file."
  RESTORE_ARCHIVE="$(cd "$(dirname "$RESTORE_ARCHIVE")" && pwd)/$(basename "$RESTORE_ARCHIVE")"  # absolutize (cwd changes below)
  if [[ -z "${STIQ_ARCHIVE_PASS:-}" ]]; then
    if [[ -t 0 ]]; then
      printf 'Archive passphrase (input hidden): ' >&2
      IFS= read -rs STIQ_ARCHIVE_PASS || true
      printf '\n' >&2
      export STIQ_ARCHIVE_PASS
    fi
    [[ -n "${STIQ_ARCHIVE_PASS:-}" ]] \
      || die "restore needs the archive passphrase — set STIQ_ARCHIVE_PASS (it is never echoed) and re-run."
  fi
fi

# --attach preflight: validate the bundle EARLY (before packages install) and pin down what mirror
# mode means for every organizer-coupled flag. Full JSON validation waits for python3 (step 1
# installs it); here we check existence + the magic marker cheaply so a wrong file dies in
# seconds, not after an apt run.
if [[ -n "$ATTACH_BUNDLE" ]]; then
  [[ -n "$RESTORE_ARCHIVE" ]] && die "--attach and --restore are mutually exclusive: a mirror never adopts community private keys (that is the point). Restore rebuilds a PRIMARY."
  [[ -f "$ATTACH_BUNDLE" ]] || die "--attach bundle not found: ${ATTACH_BUNDLE}"
  grep -q '"stiq_mirror_bundle"' "$ATTACH_BUNDLE" \
    || die "'${ATTACH_BUNDLE}' does not look like a mirror bundle (missing the stiq_mirror_bundle marker). Generate one on the PRIMARY with: sudo bash deploy/stiq-up.sh --export-mirror-bundle <out.json>"
  ATTACH_BUNDLE="$(cd "$(dirname "$ATTACH_BUNDLE")" && pwd)/$(basename "$ATTACH_BUNDLE")"  # absolutize (cwd changes below)
  # A mirror is a RELAY ONLY. Force every organizer-coupled feature off, whatever the environment
  # says — there is no organizer process on this box to serve them. Enforcement FLAGS still arrive
  # via the bundle's config (written verbatim in step 9's attach branch); the 9b/9c/9d activation
  # blocks below are for coordinating a PRIMARY's organizer+relay pair and must not run here.
  DASHBOARD_ONION=0
  PUSH_WATCHER=0
  TOKEN_DOMAIN_SEP=0
  CONTENT_ENCRYPTION=0
  SPACE_TOKENS=0
  # Members-only reach on the mirror follows the PRIMARY's posture (bundle field), not this box's
  # env: a mismatch either strands members (auth here, none in their code) or makes the mirror
  # enumerable when the community chose not to be. Resolved for real in the step-4..7 else-branch
  # (python3 exists by then); recorded here so the banner can already say which mode this is.
fi

# A caller-supplied password is written verbatim into a systemd EnvironmentFile, whose parser
# treats leading #/; as comments, strips matched surrounding quotes, and unescapes — so a value
# with those characters would reach the process altered (or empty). Reject such values early with
# a clear message rather than silently mis-setting the password. (The auto-generated hex is safe.)
if [[ -n "$ORG_PASSWORD" ]]; then
  if [[ "$ORG_PASSWORD" == *$'\n'* || "$ORG_PASSWORD" =~ ^[[:space:]#\;\'\"] || "$ORG_PASSWORD" == *'\' ]]; then
    die "STIQ_ORG_PASSWORD must not contain newlines, a leading space/quote/#/; or a trailing backslash (systemd EnvironmentFile would mangle it). Use a simpler password or let the installer generate one."
  fi
fi

# The shipped mobile client hardcodes ENROLL_POW_DIFFICULTY=12 (mined by every installed app on
# enroll responses). enroll_pow here MUST match it: the relay's config value and the STIQ_ENROLL_POW
# fed to the organizer are both derived from ENROLL_POW below, so an operator override that isn't 12
# would silently break enrollment for every client already in the field (and every future one, unless
# it too ships a matching, non-default ENROLL_POW_DIFFICULTY). Reject early rather than deploy a
# community that can never enroll a member.
if [[ "$ENROLL_POW" != "12" ]]; then
  die "STIQ_ENROLL_POW=${ENROLL_POW} but the shipped client mines PoW at difficulty 12 (ENROLL_POW_DIFFICULTY). Deploying with a different value breaks enrollment for every installed app. Leave STIQ_ENROLL_POW unset (defaults to 12) unless you have ALSO shipped a client build with a matching, non-default ENROLL_POW_DIFFICULTY."
fi

if [[ -n "$ATTACH_BUNDLE" ]]; then
  say "STIQ mirror installer (attach-mode)"
  echo "    bundle    : ${ATTACH_BUNDLE}"
  echo "    role      : BLIND MIRROR relay — no organizer, no issuer/epoch keys; ciphertext-only wherever the community seals"
  echo "    repo      : ${REPO}"
  echo "    layout    : relay → ${RELAY_BIN} + ${RELAY_ETC}; onion → ${TOR_HS_DIR}"
else
say "STIQ community installer"
echo "    community : ${COMMUNITY_NAME}"
echo "    organizer : ${ORGANIZER_LABEL}"
echo "    repo      : ${REPO}"
echo "    layout    : relay → ${RELAY_BIN} + ${RELAY_ETC}; organizer → ${ORG_DIR}; onion → ${TOR_HS_DIR}"
fi
[[ -n "$RESTORE_ARCHIVE" ]] && echo "    restore   : ${RESTORE_ARCHIVE} (adopting archived keys; a FRESH onion will be minted)"
[[ "$PUSH_WATCHER" == "1" ]] && echo "    push      : ntfy + keyless pushwatcher ENABLED (loopback + onion, content-free wakes)"
if [[ "$RELAY_SINGLE_ONION" == "1" ]]; then
  echo "    onion mode: SINGLE-ONION (SocksPort 0, HiddenServiceNonAnonymousMode/SingleHopMode 1) — faster rendezvous, client reach unaffected"
else
  echo "    onion mode: standard (fully anonymous both ways; --no-single-onion / RELAY_SINGLE_ONION=0)"
fi
[[ "$STIQ_VANGUARDS" == "1" && "$RELAY_SINGLE_ONION" != "1" ]] && echo "    vanguards : ENABLED (pip3 vanguards + stiq-vanguards.service on tor's ControlPort)"
[[ "$STIQ_VANGUARDS" == "1" && "$RELAY_SINGLE_ONION" == "1" ]] && echo "    vanguards : SKIPPED (STIQ_VANGUARDS=1 but RELAY_SINGLE_ONION=1 — no guard path to protect; pass --no-single-onion to use it)"
echo

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------
say "Installing system packages (tor, openssl, python3, curl)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# curl + gnupg + ca-certificates are needed to FETCH and dearmor the Tor Project signing key just
# below, so install them before adding the repo (a fresh minimal box may lack curl/gnupg).
apt-get install -y -qq curl ca-certificates gnupg openssl python3 >/dev/null

# ---------------------------------------------------------------------------
# Swap (2026-07-28 reliability hardening). The reference deployment is a ~1.6GB VPS running
# two tor daemons, the Go relay, and the Node organizer with ZERO swap — under memory pressure
# the kernel has nowhere to shed cold pages and an allocation hiccup in tor degrades the onion
# front silently. 1GB of swapfile at swappiness 10 is a pressure-relief valve, not a perf tool.
# Skipped when any swap is already active. Opt out with STIQ_SWAPFILE=0.
# ---------------------------------------------------------------------------
if [[ "${STIQ_SWAPFILE:-1}" == "1" ]] && ! swapon --show 2>/dev/null | grep -q .; then
  say "No active swap — provisioning a 1GB swapfile (STIQ_SWAPFILE=0 to skip)..."
  if fallocate -l 1G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-stiq-swap.conf
    sysctl -w vm.swappiness=10 >/dev/null || true
  else
    warn "swapfile provisioning failed (filesystem without fallocate support?) — continuing without swap."
    rm -f /swapfile 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Ensure a CURRENT tor via the official Tor Project apt repo.
# WHY: the distro `tor` on Ubuntu 22.04 (jammy) is 0.4.6.10 — END-OF-LIFE since ~2023. Its built-in
# directory-authority keys are too old to validate today's Tor consensus (a dir-auth set change in
# early July invalidated them), so it wedges at "Bootstrapped 30% (Loading networkstatus consensus)"
# with "Consensus not signed by sufficient number of requested authorities", never builds a circuit,
# and never publishes the onion descriptor — a multi-day onion outage. The distro repo has NOTHING
# newer, so adding the Tor Project repo is MANDATORY to get a current tor (0.4.9.x bootstraps in ~6s).
# Idempotent: re-running overwrites the keyring + tor.list (no duplicate sources lines). Non-fatal,
# mirroring the NodeSource fallback below: every fallible step is guarded so a transient curl can't
# abort provisioning under `set -e`; on failure we WARN LOUDLY and fall through to the (EOL) distro tor.
TOR_REPO_OK=0
TOR_KEYRING="/usr/share/keyrings/deb.torproject.org-keyring.gpg"
TOR_CODENAME="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_CODENAME:-}")"
[[ -n "$TOR_CODENAME" ]] || { warn "could not read VERSION_CODENAME from /etc/os-release; defaulting to 'jammy'."; TOR_CODENAME="jammy"; }
if install -m 0755 -d /usr/share/keyrings 2>/dev/null \
   && curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc -o /tmp/tor.asc 2>/dev/null \
   && gpg --dearmor < /tmp/tor.asc > "${TOR_KEYRING}.tmp" 2>/dev/null; then
  mv -f "${TOR_KEYRING}.tmp" "$TOR_KEYRING"
  chmod 0644 "$TOR_KEYRING"
  echo "deb [signed-by=${TOR_KEYRING}] https://deb.torproject.org/torproject.org ${TOR_CODENAME} main" \
    > /etc/apt/sources.list.d/tor.list
  TOR_REPO_OK=1
  say "Tor Project apt repo configured (${TOR_CODENAME}); installing a current tor."
else
  rm -f "${TOR_KEYRING}.tmp"
  warn "could not configure the Tor Project apt repo (network?). Falling back to the DISTRO tor — on Ubuntu 22.04 that is the END-OF-LIFE 0.4.6.10, which cannot validate the current consensus and will wedge your onion at 30%. Add the repo and re-run once network is available."
fi
rm -f /tmp/tor.asc

# Refresh the index when the repo was just added, then install tor from it (distro tor otherwise).
# Guard apt-get update so a transient Tor-repo metadata failure (503 / TLS hiccup / mirror sync) warns
# and falls through instead of aborting the whole installer under `set -e`.
[[ "$TOR_REPO_OK" == "1" ]] && { apt-get update -qq || warn "apt-get update against the Tor Project repo failed; tor may not upgrade this run."; }
apt-get install -y -qq tor >/dev/null || die "tor could not be installed (apt-get install tor failed). Fix apt/networking and re-run."
if [[ "$TOR_REPO_OK" == "1" ]]; then
  # Keep the repo signing key auto-updated via apt (best-effort; the keyring we wrote already works).
  apt-get install -y -qq deb.torproject.org-keyring >/dev/null 2>&1 \
    || warn "could not install deb.torproject.org-keyring; the manually-fetched keyring still verifies the repo."
fi

# Node.js (>= 18). Install the requested LTS from NodeSource if missing/too old. Keep each step
# non-fatal so a transient fetch failure falls through to the actionable `die` below instead of
# aborting under `set -e` with a bare curl exit code and no message.
node_ok() { command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; }
if [[ -n "$ATTACH_BUNDLE" ]]; then
  say "Mirror mode — skipping Node.js (no organizer runs on a mirror)."
else
if ! node_ok; then
  say "Installing Node.js ${NODE_MAJOR} LTS (NodeSource)..."
  if curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource.sh; then
    bash /tmp/nodesource.sh >/dev/null 2>&1 || true
    apt-get install -y -qq nodejs >/dev/null 2>&1 || true
    rm -f /tmp/nodesource.sh
  else
    warn "could not fetch the NodeSource setup script (network?)."
  fi
fi
node_ok || die "Node.js >= 18 is required but could not be installed. Install it manually, then re-run."
say "Node $(node -v) ready."
fi

# ---------------------------------------------------------------------------
# 2. The relay binary — use a prebuilt one if present, else build with Go
# ---------------------------------------------------------------------------
PREBUILT=""
for cand in "${SCRIPT_DIR}/stiq-relay" "${REPO}/relay/stiq-relay" "${REPO}/stiq-relay"; do
  [[ -f "$cand" ]] && { PREBUILT="$cand"; break; }
done

if [[ -n "$PREBUILT" ]]; then
  say "Using prebuilt relay binary: ${PREBUILT}"
  RELAY_SRC_BIN="$PREBUILT"
else
  if ! command -v go >/dev/null 2>&1; then
    say "Go not found — installing Go ${GO_VERSION}..."
    ARCH="$(dpkg --print-architecture)"; [[ "$ARCH" == "arm64" ]] || ARCH="amd64"
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz
    rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
    export PATH="/usr/local/go/bin:${PATH}"
  fi
  command -v go >/dev/null 2>&1 || die "Go toolchain unavailable; cannot build the relay."
  say "Building the relay from source (CGO_ENABLED=0)..."
  ( cd "${REPO}/relay" && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /tmp/stiq-relay . )
  RELAY_SRC_BIN="/tmp/stiq-relay"
fi

# --- 2b. The keyless push watcher binary (T1) — only when PUSH_WATCHER=1 ----------------------------
# The watcher (relay/cmd/pushwatcher) is a SECOND main package in the same relay Go module, so it
# builds from the same tree with the same toolchain. Prefer a prebuilt binary if one was shipped
# alongside the relay; else build it here (installing Go if the relay came prebuilt and go is absent).
# Kept entirely inside the PUSH_WATCHER gate so a normal run never touches Go on account of push.
WATCHER_SRC_BIN=""
if [[ "$PUSH_WATCHER" == "1" ]]; then
  for cand in "${SCRIPT_DIR}/pushwatcher" "${REPO}/relay/pushwatcher" "${REPO}/pushwatcher"; do
    [[ -f "$cand" ]] && { WATCHER_SRC_BIN="$cand"; break; }
  done
  if [[ -n "$WATCHER_SRC_BIN" ]]; then
    say "Using prebuilt push watcher binary: ${WATCHER_SRC_BIN}"
  else
    if ! command -v go >/dev/null 2>&1; then
      say "Go not found — installing Go ${GO_VERSION} to build the push watcher..."
      ARCH="$(dpkg --print-architecture)"; [[ "$ARCH" == "arm64" ]] || ARCH="amd64"
      curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz
      rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && rm -f /tmp/go.tgz
      export PATH="/usr/local/go/bin:${PATH}"
    fi
    command -v go >/dev/null 2>&1 || die "Go toolchain unavailable; cannot build the push watcher (PUSH_WATCHER=1)."
    say "Building the push watcher from source (CGO_ENABLED=0)..."
    ( cd "${REPO}/relay" && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /tmp/stiq-pushwatcher ./cmd/pushwatcher )
    WATCHER_SRC_BIN="/tmp/stiq-pushwatcher"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Unprivileged user + directory tree (co-located under /opt/stiq)
# ---------------------------------------------------------------------------
say "Creating the stiq service user and directories..."
id -u stiq >/dev/null 2>&1 || useradd --system --home "${RELAY_LIB}" --shell /usr/sbin/nologin stiq
mkdir -p "${ORG_DIR}" "${CLIENT_DIR}" "${RELAY_ETC}" "${RELAY_LIB}"

# ---------------------------------------------------------------------------
# 4-7 run only on a PRIMARY. Mirror mode (--attach) has no organizer, no issuer key, no
# organizer Nostr identity — it adopts the community's PUBLIC material from the bundle instead
# (else-branch at the bottom of step 7).
# ---------------------------------------------------------------------------
if [[ -z "$ATTACH_BUNDLE" ]]; then
# ---------------------------------------------------------------------------
# 4. Stage the organizer dashboard tree (code only — keys handled in step 5)
# ---------------------------------------------------------------------------
say "Staging the organizer dashboard into ${ORG_DIR}..."
# Copy the dashboard source/UI/config (never overwrite live keys or state on re-run).
for f in organizer-server.mjs organizer-nostr.mjs organizer-ui.js organizer.html \
         mailbox.mjs invite-issuance.mjs contentEpochKeys.mjs organizer-cli.mjs \
         issuer.js publish-config.mjs verify_enroll.mjs log-offer.mjs package.json; do
  install -m 0644 "${REPO}/issuer/${f}" "${ORG_DIR}/${f}"
done
# The terminal client shim (chmod +x so `./stiq-org …` runs the CLI without `node`).
install -m 0755 "${REPO}/issuer/stiq-org" "${ORG_DIR}/stiq-org"

# ---------------------------------------------------------------------------
# 4b. Restore a community from an encrypted archive (T16) — BEFORE any key generation or config
#     merge, so the restored issuer/organizer/community keys + relay config + membership (double-spend)
#     state are what steps 5/7/9 then adopt and PRESERVE (each of those steps keeps an already-present
#     key/config rather than minting a new one). issuer/restore-archive.mjs (a sibling of archive.mjs,
#     both Node-builtin-only — no npm needed) does the decrypt + write-back; we run it straight from
#     the repo checkout and pass the passphrase through the environment so it is never on argv/echoed.
#     The .onion is intentionally NOT in the archive, so step 8 mints a FRESH onion (reissue join
#     codes). Owner note: run with services stopped (systemctl stop stiq.target) for a clean restore.
# ---------------------------------------------------------------------------
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  RESTORE_SCRIPT="${REPO}/issuer/restore-archive.mjs"
  [[ -f "$RESTORE_SCRIPT" ]] \
    || die "RESTORE_ARCHIVE is set but ${RESTORE_SCRIPT} is missing — update the checkout (issuer/restore-archive.mjs ships with the archive feature)."
  say "Restoring community from encrypted archive (adopting archived keys; a fresh onion will be minted)..."
  mkdir -p "${RELAY_DATA_DIR}"
  # STIQ_ARCHIVE_PASS reaches the child via the environment only — never on the command line (argv is
  # world-visible via /proc). --force lets the installer adopt the archive over the just-created empty
  # target dirs; restore-archive.mjs still refuses to clobber a NON-empty target's populated files per
  # its own guard. A decrypt/auth failure exits non-zero and aborts the whole install under `set -e`.
  STIQ_ARCHIVE_PASS="${STIQ_ARCHIVE_PASS:-}" node "$RESTORE_SCRIPT" "$RESTORE_ARCHIVE" \
    --dir "${ORG_DIR}" \
    --relay-config "${RELAY_ETC}/config.json" \
    --relay-data "${RELAY_DATA_DIR}" \
    --force \
    || die "archive restore failed (wrong passphrase, tampered archive, or a non-empty target) — nothing further was changed. Fix the passphrase/archive and re-run."
  # Lock the restored secrets immediately (umask 077 already covers new files, but the archive may
  # have carried explicit modes; belt-and-suspenders on the private key material).
  [[ -f "${ORG_DIR}/issuer_private.pem"  ]] && chmod 600 "${ORG_DIR}/issuer_private.pem"
  [[ -f "${ORG_DIR}/organizer_nostr.json" ]] && chmod 600 "${ORG_DIR}/organizer_nostr.json"
  say "  archive restored. Steps 5/7/9 will keep the restored keys/config; run publish-config.mjs after start to re-seed roster+limits+storage."
fi

# ---------------------------------------------------------------------------
# 5. Generate community key material ON THIS BOX (idempotent)
# ---------------------------------------------------------------------------
say "Provisioning community keys (generated locally, never transmitted)..."
ISSUER_PEM="${ORG_DIR}/issuer_private.pem"
ISSUER_PUB_PEM="${ORG_DIR}/issuer_public.pem"
ISSUER_PUB_B64="${ORG_DIR}/issuer_public.b64"

if [[ -f "$ISSUER_PEM" ]]; then
  say "  issuer RSA key already present — keeping it."
else
  say "  generating a fresh 2048-bit issuer RSA key..."
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$ISSUER_PEM" 2>/dev/null
fi
chmod 600 "$ISSUER_PEM"   # belt-and-suspenders on top of umask 077
# Always (re)derive the public forms from the private key — cheap and keeps them in sync. Write
# via temp+rename so a transient openssl failure can't clobber a prior-good file on re-run.
openssl pkey -in "$ISSUER_PEM" -pubout -out "${ISSUER_PUB_PEM}.tmp" 2>/dev/null && mv "${ISSUER_PUB_PEM}.tmp" "$ISSUER_PUB_PEM"
openssl pkey -in "$ISSUER_PEM" -pubout -outform DER 2>/dev/null | base64 -w0 > "${ISSUER_PUB_B64}.tmp" && mv "${ISSUER_PUB_B64}.tmp" "$ISSUER_PUB_B64"

# ---------------------------------------------------------------------------
# 6. Organizer dependencies (blindrsa, nostr-tools, ws + dashboard deps)
# ---------------------------------------------------------------------------
say "Installing organizer dependencies..."
install -m 0644 "${REPO}/issuer/deploy/client-deps.package.json" "${CLIENT_DIR}/package.json"
( cd "${CLIENT_DIR}" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ) \
  || die "npm install failed in ${CLIENT_DIR} (blindrsa/nostr-tools/ws)."
( cd "${ORG_DIR}" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ) \
  || die "npm install failed in ${ORG_DIR} (qrcode/jsqr/ws/socks-proxy-agent)."

# ---------------------------------------------------------------------------
# 7. Organizer Nostr key — generate it now so we can feed the relay its pubkey.
#    organizerIdentity() creates organizer_nostr.json on first call and returns pkHex.
# ---------------------------------------------------------------------------
say "Deriving the organizer Nostr identity (moderation trust root)..."
ORG_PUBHEX="$(cd "${ORG_DIR}" && node -e \
  "import('./organizer-nostr.mjs').then(m=>{const id=m.organizerIdentity();process.stdout.write(id.pkHex)})")"
[[ "$ORG_PUBHEX" =~ ^[0-9a-f]{64}$ ]] || die "could not derive organizer pubkey (got: '${ORG_PUBHEX}')."
chmod 600 "${ORG_DIR}/organizer_nostr.json"   # the organizer SECRET key — lock it the moment it exists
say "  organizer pubkey: ${ORG_PUBHEX}"

else
# ---------------------------------------------------------------------------
# 4-7 (mirror mode): adopt the community's shared reach key + reach posture from the bundle,
# so step 8's existing machinery (mint-guard, authorized_clients, watchdog probe credentials)
# runs UNCHANGED: it finds the key already present and derives the same public key the primary
# enforces — members' existing join codes reach this mirror with zero client-side change.
# Full bundle validation happens here too (python3 is installed by now).
# ---------------------------------------------------------------------------
say "Adopting the community's reach key + enforcement posture from the bundle..."
ATTACH_ONION_AUTH="$(STIQ_MB_BUNDLE="$ATTACH_BUNDLE" python3 <<'PY'
import json, os, sys
with open(os.environ['STIQ_MB_BUNDLE']) as f:
    b = json.load(f)
if b.get('stiq_mirror_bundle') != 1:
    sys.exit('unsupported bundle version (expected stiq_mirror_bundle: 1)')
cfg = b.get('config') or {}
if not cfg.get('issuer_public_keys'):
    sys.exit('bundle carries no issuer_public_keys — a mirror could not enforce membership')
if not cfg.get('organizer_pubkeys'):
    sys.exit('bundle carries no organizer_pubkeys — a mirror could not admit organizer config')
pem = b.get('relay_auth_priv_pem') or ''
if 'PRIVATE KEY' not in pem:
    sys.exit('bundle carries no community reach key (relay_auth_priv_pem)')
print('1' if b.get('onion_auth') else '0')
PY
)" || die "mirror bundle validation failed (see message above)."
[[ "$ATTACH_ONION_AUTH" == "0" || "$ATTACH_ONION_AUTH" == "1" ]] \
  || die "mirror bundle validation failed: ${ATTACH_ONION_AUTH}"
# The mirror's reach posture FOLLOWS the primary (see the preflight note): auth-enforced primary
# ⇒ auth-enforced mirror under the SAME shared key; public primary ⇒ public mirror.
RELAY_ONION_AUTH="$ATTACH_ONION_AUTH"
install -d -o stiq -g stiq -m 0700 "$RELAY_AUTH_DIR"
STIQ_MB_BUNDLE="$ATTACH_BUNDLE" STIQ_MB_KEY_OUT="${RELAY_AUTH_DIR}/community_priv.pem" python3 <<'PY' \
  || die "failed to install the community reach key from the bundle."
import json, os
with open(os.environ['STIQ_MB_BUNDLE']) as f:
    b = json.load(f)
out = os.environ['STIQ_MB_KEY_OUT']
tmp = out + '.tmp'
with open(tmp, 'w') as f:
    f.write(b['relay_auth_priv_pem'])
os.replace(tmp, out)
PY
chown stiq:stiq "${RELAY_AUTH_DIR}/community_priv.pem"
chmod 600 "${RELAY_AUTH_DIR}/community_priv.pem"
say "  reach key installed; members-only reach: $([[ "$RELAY_ONION_AUTH" == "1" ]] && echo ENFORCED || echo off) (following the primary)."
fi

# ---------------------------------------------------------------------------
# 8. Tor v3 hidden service(s): the relay onion always; the dashboard onion (with
#    client authorization) when DASHBOARD_ONION=1. Both come up in one tor restart.
# ---------------------------------------------------------------------------
say "Configuring the Tor hidden service(s)..."
# Resolve the Tor service account (debian-tor on Debian/Ubuntu, tor elsewhere).
TOR_USER="debian-tor"; id -u "$TOR_USER" >/dev/null 2>&1 || TOR_USER="tor"
id -u "$TOR_USER" >/dev/null 2>&1 || die "Tor service user not found (tried debian-tor, tor)."

# --- Onion PoW defense gate (T5) -------------------------------------------------------------
# HiddenServicePoWDefensesEnabled REQUIRES a tor built with the equix 'pow' module. A tor without
# it refuses to start ("this build of tor does not include the required pow module"), which would
# wedge the onion — the same failure class as the EOL-tor consensus outage. So probe the module and
# emit the three HiddenServicePoW* lines ONLY when it is present; otherwise the onion keeps
# IntroDoS-only defenses and still publishes. Both onions (relay + dashboard) share POW_LINES.
tor_has_pow_module() { tor --list-modules 2>/dev/null | grep -qiE '^pow:[[:space:]]*yes'; }
POW_ON=0
if [[ "$RELAY_POW_DEFENSE" == "1" ]]; then
  if tor_has_pow_module; then
    POW_ON=1
    say "  onion PoW defense: ENABLED (equix pow module present)."
  else
    warn "tor build lacks the equix 'pow' module (tor --list-modules); writing IntroDoS-only onion defenses so the onion still publishes. Install tor from the Tor Project apt repo to enable HiddenServicePoWDefensesEnabled."
  fi
fi
POW_LINES=""
if [[ "$POW_ON" == "1" ]]; then
  POW_LINES=$'HiddenServicePoWDefensesEnabled 1\nHiddenServicePoWQueueRate 250\nHiddenServicePoWQueueBurst 2500\n'
fi

mkdir -p /etc/tor/torrc.d && chmod 755 /etc/tor/torrc.d

# --- stiq-base.conf: whole-instance single-onion mode (RELAY_SINGLE_ONION, default 1) ------------
# Written FIRST, before any HiddenService drop-in below: HiddenServiceNonAnonymousMode and
# HiddenServiceSingleHopMode are process-wide options (not per-service), so their ordering relative
# to the HiddenServiceDir blocks doesn't matter to tor — but keeping the base/topology drop-in first
# on disk mirrors how it reads (foundation, then the services built on it) and matches the alpha
# glob order tor's `%include torrc.d/*.conf` already uses (stiq-base < stiq-dashboard < stiq-relay).
# Idempotent: re-running always rewrites this file to match RELAY_SINGLE_ONION, and the `else`
# branch removes it on a deliberate --no-single-onion rollback so a stale copy can't linger.
if [[ "$RELAY_SINGLE_ONION" == "1" ]]; then
  say "  single-onion mode: ENABLED (SocksPort 0, HiddenServiceNonAnonymousMode 1, HiddenServiceSingleHopMode 1)."
  cat > /etc/tor/torrc.d/stiq-base.conf <<'BASECONF'
# stiq single-onion base — managed by deploy/stiq-up.sh (RELAY_SINGLE_ONION=1, the default)
#
# Tor's official "single onion service" mode: every HiddenService this tor PROCESS fronts (the
# relay onion, the dashboard onion, and the optional SSH-recovery onion) drops its own 3-hop path
# to the rendezvous point down to a single hop, trimming a full circuit build off first-connect —
# a meaningful slice of onion connect latency/jitter. This affects ONLY the server's own
# circuit-anonymity toward the rendezvous point; it is invisible to clients, who keep reaching a
# completely normal v3 .onion the completely normal (3-hop, anonymous) way. Acceptable here because
# this box's location/operator was never actually hidden (rented hosting, SSH access, billing
# trail) — only members' connections are meant to stay anonymous.
#
# SocksPort 0 is REQUIRED process-wide the instant any HiddenService on this instance goes
# single-hop (tor refuses NonAnonymousMode/SingleHopMode otherwise) — this is also why Safe-Browsing
# (relay/main.go's STIQ_TOR_SOCKS, default 127.0.0.1:9050) needs a SEPARATE, client-only tor
# instance when both single-onion and Safe-Browsing are active; see step 8c / tor@stiqclient below.
#
# Incompatible with the vanguards addon (STIQ_VANGUARDS=1): vanguards defends this same 3-hop path,
# which single-hop mode removes entirely. See STIQ_VANGUARDS's comment near the top of this script.
#
# Rollback: `deploy/stiq-up.sh --no-single-onion` (or RELAY_SINGLE_ONION=0) removes this file and
# RESTARTS tor — the .onion address is UNCHANGED (this never touches hs_ed25519_secret_key). The
# choice is remembered in /var/lib/stiq/single_onion.choice, so later routine re-runs honour it.
# Use restart, not reload: a reload does not reliably un-apply SocksPort / SingleHopMode.
SocksPort 0
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
BASECONF
else
  rm -f /etc/tor/torrc.d/stiq-base.conf 2>/dev/null || true
fi

# --- stiq-controlport.conf: ControlPort for the vanguards addon, ONLY when it will actually run ---
# vanguards (STIQ_VANGUARDS=1) needs a control socket; single-onion mode (RELAY_SINGLE_ONION=1,
# default) makes vanguards a no-op (see stiq-base.conf above and step 12b), so only emit this when
# vanguards is both requested AND usable. Previously NOTHING emitted this drop-in at all — the
# header comments near STIQ_VANGUARDS and stiq-vanguards.service both claimed torrc "always" carried
# ControlPort, which was never true of the live torrc.d drop-ins (only the unused
# relay/deploy/torrc reference file had it) — so vanguards silently had no control socket to attach
# to. Fixed here: write it exactly when needed, remove it otherwise (idempotent both ways).
if [[ "$STIQ_VANGUARDS" == "1" && "$RELAY_SINGLE_ONION" != "1" ]]; then
  cat > /etc/tor/torrc.d/stiq-controlport.conf <<'CTRLCONF'
# stiq vanguards ControlPort — managed by deploy/stiq-up.sh (STIQ_VANGUARDS=1, single-onion off)
# UNIX control socket only (no TCP ControlPort); CookieAuthentication so only local root-group
# processes (debian-tor, which stiq-vanguards.service runs as) can authenticate to it.
ControlPort unix:/var/run/tor/control
CookieAuthentication 1
CTRLCONF
else
  rm -f /etc/tor/torrc.d/stiq-controlport.conf 2>/dev/null || true
fi

# The break-glass SSH-over-Tor recovery onion (relay/deploy/add_ssh_hidden_service.sh and
# console_recovery.sh) APPENDS its block to THIS same drop-in. Re-running stiq-up.sh rewrites the
# file, so detect and re-append the SSH block to avoid erasing the operator's recovery path.
PRESERVE_SSH=0
grep -q 'stiq-ssh' /etc/tor/torrc.d/stiq-relay.conf 2>/dev/null && PRESERVE_SSH=1

cat > /etc/tor/torrc.d/stiq-relay.conf <<'TORCONF'
# stiq-relay hidden service — managed by deploy/stiq-up.sh
# onion:80 → relay loopback listener (127.0.0.1:3334)
HiddenServiceDir /var/lib/tor/stiq-relay/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:3334
HiddenServiceNumIntroductionPoints 5
# Intro-point DoS defenses
HiddenServiceEnableIntroDoSDefense 1
HiddenServiceEnableIntroDoSRatePerSec 25
HiddenServiceEnableIntroDoSBurstPerSec 200
TORCONF
# --- Push stack onion ports (T1) — only when PUSH_WATCHER=1 --------------------------------------
# Front the loopback-bound pushwatcher register API and ntfy on the SAME relay onion, one extra
# HiddenServicePort each. They bind to the relay HiddenServiceDir declared just above (these lines
# land before both the PoW block and the SSH recovery block, which each open a new HiddenService*
# scope). Neither service is ever exposed on clearnet — Tor is the only front, matching co-location.
if [[ "$PUSH_WATCHER" == "1" ]]; then
  cat >> /etc/tor/torrc.d/stiq-relay.conf <<PUSHPORTS
# push watcher register API (loopback ${WATCHER_PORT}) + self-hosted ntfy (loopback ${NTFY_PORT})
HiddenServicePort ${WATCHER_PORT} 127.0.0.1:${WATCHER_PORT}
HiddenServicePort ${NTFY_PORT} 127.0.0.1:${NTFY_PORT}
PUSHPORTS
fi
# Append the onion PoW defenses (empty unless the tor build carries the equix 'pow' module — see
# POW_LINES above). This MUST land before the SSH recovery block below: HiddenService* directives
# bind to the most recent HiddenServiceDir, so appending here keeps PoW on the RELAY onion, never
# the minimal stiq-ssh recovery onion (which stays IntroDoS-free by design).
printf '%s' "$POW_LINES" >> /etc/tor/torrc.d/stiq-relay.conf

if [[ "$PRESERVE_SSH" == "1" ]]; then
  say "  preserving the existing SSH-over-Tor recovery onion."
  cat >> /etc/tor/torrc.d/stiq-relay.conf <<'SSHBLK'

# SSH-over-Tor recovery hidden service (preserved across re-runs by stiq-up.sh;
# originally added by relay/deploy/add_ssh_hidden_service.sh — keyword: stiq-ssh)
HiddenServiceDir /var/lib/tor/stiq-ssh/
HiddenServiceVersion 3
HiddenServicePort 22 127.0.0.1:22
SSHBLK
fi

# --- Members-only relay reach: Tor v3 client authorization on the RELAY onion (lever 2) ----------
# Key generation is DECOUPLED from enforcement, in two independent steps:
#   (a) ALWAYS mint/persist the SHARED community client-auth keypair and derive its base32 forms, so
#       the PRIVATE key is unconditionally fed to the organizer (STIQ_ONION_AUTH_KEY below) and thus
#       carried into every v4 community code. This is inert on its own: a code that carries a reach
#       key which no onion enforces behaves exactly like a public onion, so v4 codes can be
#       pre-distributed during a soak without locking anyone out.
#   (b) ENFORCE only when RELAY_ONION_AUTH=1: drop the PUBLIC key into the relay HS dir's
#       authorized_clients/ — the mere PRESENCE of any authorized_clients/*.auth is what makes tor
#       publish the descriptor encrypted and enforce auth. When 0, remove that entry so the onion
#       stays public (the v4 code's reach key stays inert). Decoupling (a) from (b) makes the flip a
#       one-line change with zero member-facing code churn.
say "Provisioning the shared community relay-reach key (Tor v3 client-auth material)..."
install -d -o stiq -g stiq -m 0700 "$RELAY_AUTH_DIR"
# Persist the community auth private key so re-runs keep the SAME key (reissuing the join code is
# a member-facing event; don't churn it on every deploy). Delete this file to rotate reach.
RELAY_AUTH_KEY="${RELAY_AUTH_DIR}/community_priv.pem"
if [[ ! -f "$RELAY_AUTH_KEY" ]]; then
  openssl genpkey -algorithm x25519 -out "$RELAY_AUTH_KEY" 2>/dev/null
  chown stiq:stiq "$RELAY_AUTH_KEY"; chmod 600 "$RELAY_AUTH_KEY"
fi
# Raw 32-byte keys are the tail of the DER encodings; Tor wants unpadded uppercase base32 (52 ch).
RELAY_AUTH_PRIV_B32="$(openssl pkey -in "$RELAY_AUTH_KEY" -outform DER 2>/dev/null        | tail -c 32 | base32 | tr -d '=')"
RELAY_AUTH_PUB_B32="$(openssl pkey -in "$RELAY_AUTH_KEY" -pubout -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
[[ "${#RELAY_AUTH_PRIV_B32}" -eq 52 && "${#RELAY_AUTH_PUB_B32}" -eq 52 ]] \
  || die "relay client-auth key derivation produced wrong length (priv=${#RELAY_AUTH_PRIV_B32} pub=${#RELAY_AUTH_PUB_B32}, expected 52)."

if [[ "$RELAY_ONION_AUTH" == "1" ]]; then
  say "Enforcing members-only relay reach (dropping the shared auth pubkey into authorized_clients/)..."
  # Pre-create the authorized_clients entry. Tor generates/keeps the onion keys in this dir and
  # enforces auth from authorized_clients/*.auth. (One shared entry → npub-blind collective reach.)
  mkdir -p "${TOR_HS_DIR}/authorized_clients"
  printf 'descriptor:x25519:%s\n' "$RELAY_AUTH_PUB_B32" > "${TOR_HS_DIR}/authorized_clients/community.auth"
  chmod 600 "${TOR_HS_DIR}/authorized_clients/community.auth"
  say "  relay reach is now members-only — reissue the v4 join code to your members."
else
  # Enforcement OFF: remove any stale authorized_clients entry so the onion stays public after a
  # deliberate rollback. The v4 code still carries the (now inert) reach key — this is the soak state.
  rm -f "${TOR_HS_DIR}/authorized_clients/community.auth" 2>/dev/null || true
  say "  relay onion stays PUBLIC (RELAY_ONION_AUTH=0); v4 codes carry an inert reach key (prestage/soak)."
fi

# Assert the relay HS dir is tor-owned and 0700 (tor refuses to load a HiddenServiceDir that is
# group/other-accessible). Heals any permission drift before the restart below brings it up.
if [[ -d "${TOR_HS_DIR}" ]]; then
  chown -R "${TOR_USER}:${TOR_USER}" "${TOR_HS_DIR}" 2>/dev/null || true
  chmod 700 "${TOR_HS_DIR}" 2>/dev/null || true
  [[ -d "${TOR_HS_DIR}/authorized_clients" ]] && chmod 700 "${TOR_HS_DIR}/authorized_clients" 2>/dev/null || true
fi

# --- Dashboard onion with v3 client authorization (optional) --------------------------------
DASH_PRIV_B32=""; DASH_ONION=""
if [[ "$DASHBOARD_ONION" == "1" ]]; then
  say "Provisioning the dashboard onion (Tor v3 client-auth)..."
  install -d -o stiq -g stiq -m 0700 "$AUTH_DIR"

  # 8a. Client x25519 keypair — the credential the organizer carries in Tor Browser. Persist the
  #     private key so re-runs reprint the same access card and don't lock the organizer out.
  CLIENT_KEY="${AUTH_DIR}/client_priv.pem"
  if [[ ! -f "$CLIENT_KEY" ]]; then
    openssl genpkey -algorithm x25519 -out "$CLIENT_KEY" 2>/dev/null
    chown stiq:stiq "$CLIENT_KEY"; chmod 600 "$CLIENT_KEY"
  fi
  # Raw 32-byte keys are the tail of the DER encodings (PKCS8=48B, SPKI=44B); Tor wants
  # unpadded uppercase base32.
  DASH_PRIV_B32="$(openssl pkey -in "$CLIENT_KEY" -outform DER 2>/dev/null        | tail -c 32 | base32 | tr -d '=')"
  DASH_PUB_B32="$(openssl pkey -in "$CLIENT_KEY" -pubout -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
  [[ "${#DASH_PRIV_B32}" -eq 52 && "${#DASH_PUB_B32}" -eq 52 ]] \
    || die "client-auth key derivation produced wrong length (priv=${#DASH_PRIV_B32} pub=${#DASH_PUB_B32}, expected 52)."

  # 8b. Pre-create the HiddenServiceDir with the authorized_clients entry. Tor generates the
  #     onion keys into this dir on start and enforces auth from authorized_clients/*.auth.
  mkdir -p "${DASH_HS_DIR}/authorized_clients"
  printf 'descriptor:x25519:%s\n' "$DASH_PUB_B32" > "${DASH_HS_DIR}/authorized_clients/organizer.auth"
  chown -R "${TOR_USER}:${TOR_USER}" "${DASH_HS_DIR}"
  chmod 700 "${DASH_HS_DIR}" "${DASH_HS_DIR}/authorized_clients"
  chmod 600 "${DASH_HS_DIR}/authorized_clients/organizer.auth"

  cat > /etc/tor/torrc.d/stiq-dashboard.conf <<TORCONF
# stiq-dashboard hidden service — managed by deploy/stiq-up.sh
# onion:80 → organizer dashboard loopback listener (127.0.0.1:${DASH_PORT})
# Client authorization is enforced by the presence of authorized_clients/*.auth in the dir.
HiddenServiceDir ${DASH_HS_DIR}/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:${DASH_PORT}
HiddenServiceEnableIntroDoSDefense 1
HiddenServiceEnableIntroDoSRatePerSec 25
HiddenServiceEnableIntroDoSBurstPerSec 200
TORCONF
  # Same pow-module-gated PoW block as the relay onion (dashboard is a single-HS drop-in, so the
  # append lands on its onion).
  printf '%s' "$POW_LINES" >> /etc/tor/torrc.d/stiq-dashboard.conf
else
  rm -f /etc/tor/torrc.d/stiq-dashboard.conf 2>/dev/null || true
fi

# --- stiq-logging.conf: PERMANENT notice-level logging (2026-07-28 reliability hardening) --------
# The 2026-07-28 onion outage was undiagnosable because the then-live torrc carried
# `Log err file /dev/null`: tor ran for 12 days — including the silent death of the relay onion —
# without writing a single line anywhere (a torrc Log line REPLACES the Debian default
# `Log notice syslog`, it does not add to it). Notice-level is cheap (~tens of lines/day) and
# SafeLogging 1 scrubs client addresses, so there is no privacy cost to keeping real logs.
cat > /etc/tor/torrc.d/stiq-logging.conf <<'LOGCONF'
# stiq tor logging — managed by deploy/stiq-up.sh (post 2026-07-28 onion outage: tor previously
# logged to /dev/null, leaving zero evidence). notice -> file for history, notice -> syslog for
# journald. SafeLogging 1 (main torrc) scrubs client addresses from both sinks.
Log notice file /var/log/tor/notices.log
Log notice syslog
LOGCONF
# Scrub the old discard-everything line from the main torrc on already-provisioned boxes.
sed -i 's|^Log err file /dev/null|# logging: see torrc.d/stiq-logging.conf (notice -> file + syslog)|' /etc/tor/torrc 2>/dev/null || true
# The Debian tor logrotate reloads the dummy `tor` master unit, which never HUPs the real
# writer (tor@default) — after the first rotation tor would keep logging into the deleted
# inode forever. Point postrotate at the actual instance.
cat > /etc/logrotate.d/tor <<'LOGROTATE'
/var/log/tor/*log {
	daily
	rotate 14
	compress
	delaycompress
	missingok
	notifempty
	create 0640 debian-tor adm
	sharedscripts
	postrotate
		# multi-instance tor: the writer of /var/log/tor is tor@default, not the dummy master unit
		systemctl reload tor@default 2>/dev/null || true
	endscript
}
LOGROTATE
# Restart + hang-detection for the onion front: tor is Type=notify and sends systemd watchdog
# pings (verified on tor 0.4.9.11), so WatchdogSec catches "process alive, event loop dead" —
# the failure shape of a silent onion death that probes can only see from outside.
install -d /etc/systemd/system/tor@default.service.d
printf '[Service]\nRestart=always\nRestartSec=3\nWatchdogSec=120\n' \
  > /etc/systemd/system/tor@default.service.d/stiq-reliability.conf
systemctl daemon-reload

chown -R "${TOR_USER}:${TOR_USER}" /etc/tor/torrc.d 2>/dev/null || true
grep -q '%include /etc/tor/torrc.d/' /etc/tor/torrc 2>/dev/null || \
  echo '%include /etc/tor/torrc.d/*.conf' >> /etc/tor/torrc

# Drive the actual tor instance. On Debian/Ubuntu the serving unit is tor@default (the bare
# `tor` unit is a meta-wrapper); the rest of this repo's scripts use tor@default, so match them
# and fall back to `tor` on distros that only ship the plain unit.
if systemctl list-unit-files 'tor@default.service' >/dev/null 2>&1 && \
   systemctl cat tor@default.service >/dev/null 2>&1; then
  TOR_UNIT="tor@default"
else
  TOR_UNIT="tor"
fi
systemctl enable "$TOR_UNIT" >/dev/null 2>&1 || true
# `tor --verify-config` MUST run as the tor user, never as root.
#
# This installer runs as root, and tor validates HiddenServiceDir ownership against the *invoking*
# user — so as root it reports, on every box this script has ever provisioned:
#     /var/lib/tor/stiq-dashboard/ is not owned by this user (root, 0) but by debian-tor (115)
#     Failed to parse/validate config: Failed to configure rendezvous options.
# ...and exits non-zero, while the SAME config validates cleanly as debian-tor ("Configuration was
# valid") and the daemon runs it happily. Root was simply asking the wrong question: the daemon runs
# as debian-tor, so debian-tor's verdict is the only one that means anything.
#
# Verified on the live box (tor 0.4.9.11): as root exit 1, as debian-tor exit 0, same config.
#
# This was ALREADY biting before the ladder existed: the old warn-only branch fired on literally
# every run, so it stripped the HiddenServicePoW* DoS defenses it had just written, re-verified
# (failed again, as it always would), warned, and restarted anyway — silently shipping onions with
# no PoW defense. Getting the user right fixes that too. And it is load-bearing for the ladder
# below: `die` on a verdict that is always non-zero would abort every deploy on every box.
tor_verify_config() { runuser -u "$TOR_USER" -- tor --verify-config >/dev/null 2>&1; }

# --- Fail-safe ladder BEFORE the restart ---------------------------------------------------------
# The restart below used to run UNCONDITIONALLY — even when the check right above had just proven
# the config invalid, which only ever emitted a warn. Under `set -euo pipefail` that turns a bad
# drop-in into an OUTAGE: tor fails to start, the restart returns non-zero, the script dies, and
# EVERY onion on this box (relay + dashboard + the SSH-recovery onion) is down. Dying BEFORE the
# restart instead is strictly more conservative — tor keeps serving the last config that worked.
#
# The ladder, in order of how likely each suspect is:
#   1. HiddenServicePoW* — a pow-module mismatch / equix-less tor. Strip and re-verify.
#   2. stiq-base.conf (single-onion) — MOVE it aside and re-verify. If that fixes it, single-onion
#      is genuinely incompatible with this box, so auto-degrade to standard-onion mode and carry
#      on. If it does NOT fix it, the drop-in was innocent: move it back BYTE-IDENTICAL, so we
#      never "fix" an unrelated failure by silently disabling a feature the operator asked for.
#      (Moving, not rewriting, is the whole point — the restored file is the same bytes, same
#      owner, same mode.)
#   3. Still invalid ⇒ die, without restarting.
#
# The degrade encodes this repo's standing rule — CLIENT-AUTH WINS. RELAY_ONION_AUTH is what keeps
# non-members out of the descriptor; RELAY_SINGLE_ONION is a latency optimisation. The compat gate
# between the two has never been run against a real tor (deploy/SINGLE_ONION.md), and until
# this ladder existed that rule lived only as PROSE IN A MARKDOWN FILE, enforced by nothing while
# both flags defaulted ON. If tor ever rejects the two together, single-onion is what goes.
#
# Degrading mutates RELAY_SINGLE_ONION itself (rather than setting some new flag) so that all of
# its downstream consumers — step 8c's Safe-Browsing instance, step 12b's vanguards, the summary
# and the epilogue — compose for free and stay consistent with what tor is actually running.
if ! tor_verify_config; then
  warn "tor --verify-config failed after writing onion defenses; stripping HiddenServicePoW* lines and re-verifying so the onion still comes up."
  sed -i '/^HiddenServicePoW/d' /etc/tor/torrc.d/stiq-relay.conf /etc/tor/torrc.d/stiq-dashboard.conf 2>/dev/null || true
fi

if ! tor_verify_config \
   && [[ "$RELAY_SINGLE_ONION" == "1" && -f /etc/tor/torrc.d/stiq-base.conf ]]; then
  # Probe path is deliberately OUTSIDE /etc/tor/torrc.d — torrc's `%include torrc.d/*.conf` would
  # otherwise still pick the file up and the probe would prove nothing.
  SINGLE_ONION_PROBE="/etc/tor/stiq-base.conf.probe"
  warn "tor --verify-config still failing with single-onion enabled — testing whether stiq-base.conf is the cause."
  mv -f /etc/tor/torrc.d/stiq-base.conf "$SINGLE_ONION_PROBE"
  if tor_verify_config; then
    rm -f "$SINGLE_ONION_PROBE"
    RELAY_SINGLE_ONION=0
    warn "AUTO-DEGRADED to standard-onion mode: this tor rejects the single-onion config, and client-auth/onion reach wins over a latency optimisation. The .onion address is UNCHANGED (this never touches hs_ed25519_secret_key). Verify with: bash relay/deploy/tor_defense_check.sh — and see deploy/SINGLE_ONION.md before retrying with --single-onion."
    if [[ "$STIQ_VANGUARDS" == "1" ]]; then
      # Step 8 decided whether to emit stiq-controlport.conf while single-onion was still 1, so it
      # skipped it — installing vanguards now would leave it with no control socket to attach to
      # (silently doing nothing). Refuse rather than pretend.
      STIQ_VANGUARDS=0
      warn "STIQ_VANGUARDS=1 is being ignored this run: the auto-degrade happened after the ControlPort drop-in decision, so vanguards would have no control socket. Re-run with --no-single-onion to get vanguards properly."
    fi
  else
    mv -f "$SINGLE_ONION_PROBE" /etc/tor/torrc.d/stiq-base.conf
    warn "stiq-base.conf is NOT the cause (config is invalid without it too) — restored it untouched."
  fi
fi

tor_verify_config \
  || die "tor --verify-config still fails — REFUSING to restart ${TOR_UNIT}, because restarting on a config tor rejects would take every onion on this box down (relay + dashboard + SSH-recovery) while leaving you no way back in. Tor is still running its previous, working config. Inspect with the SAME user the daemon uses (as root it always fails on HiddenServiceDir ownership and tells you nothing): runuser -u ${TOR_USER} -- tor --verify-config; ls /etc/tor/torrc.d"

# --- Release 127.0.0.1:9050 BEFORE the restart ---------------------------------------------------
# Ordering rule: acquire-after-release (flipping single-onion ON) is safe; release-after-acquire
# (flipping it OFF) is NOT. With single-onion off, stiq-base.conf is gone and this instance reverts
# to tor's compiled-in `SocksPort 9050` default — but tor@stiqclient, provisioned by a PREVIOUS
# single-onion run (step 8c), still holds 9050. Tor then fails to bind ("Address already in use"),
# the restart returns non-zero, and `set -e` aborts with every onion down — BEFORE step 8c's
# teardown, which lives ~100 lines below this restart, ever runs to free the port. Self-
# perpetuating: every retry dies at this same line; only a manual
# `systemctl disable --now tor@stiqclient` unwedges it.
#
# That trap sat on the DOCUMENTED rollback path (`--no-single-onion`) — i.e. it was armed on
# exactly the boxes most likely to need the escape hatch — and the auto-degrade above would have
# walked straight into it too. So: free the port here, first. Release-only; step 8c below remains
# authoritative for (re-)provisioning and is unchanged.
if [[ "$RELAY_SINGLE_ONION" != "1" ]] && systemctl is-active --quiet "tor@${TOR_CLIENT_INSTANCE}" 2>/dev/null; then
  say "  releasing 127.0.0.1:9050 from tor@${TOR_CLIENT_INSTANCE} before restarting ${TOR_UNIT} (single-onion off ⇒ the main instance reclaims its default SocksPort)."
  systemctl stop "tor@${TOR_CLIENT_INSTANCE}" >/dev/null 2>&1 || true
fi

systemctl restart "$TOR_UNIT"

# A restart that RETURNS 0 can still be followed by tor degrading or exiting moments later (a config
# it accepts at parse time but rejects at runtime). The hostname wait below would then find a STALE
# hostname file from the previous, working run and report success — reporting a healthy onion over a
# dead tor. Gate on the unit actually still being up before trusting anything downstream of here.
sleep 2
systemctl is-active --quiet "$TOR_UNIT" \
  || die "${TOR_UNIT} restarted but is not active — it accepted the config at parse time and then failed at runtime. Inspect: journalctl -u ${TOR_UNIT} -n 50"

say "Waiting for the .onion descriptor(s) to be generated..."
ONION=""
for _ in $(seq 1 30); do
  if [[ -f "${TOR_HS_DIR}/hostname" ]]; then ONION="$(cat "${TOR_HS_DIR}/hostname")"; break; fi
  sleep 1
done
[[ -n "$ONION" ]] || die "Tor did not produce ${TOR_HS_DIR}/hostname; check: journalctl -u ${TOR_UNIT}"
RELAY_ONION_WS="ws://${ONION}"
say "  relay .onion: ${ONION}"

# --- Persist the EFFECTIVE single-onion mode -----------------------------------------------------
# Placement is the entire point. This runs downstream of the auto-degrade ladder, the restart, the
# is-active gate AND the hostname wait — so it records the mode tor is ACTUALLY running and serving
# an onion under, never the mode that was merely requested. Recording intent earlier would let a
# failed/degraded run persist a lie that every later re-run would then faithfully honour.
install -d -m 0700 "$STIQ_STATE_DIR"
printf '%s\n' "$RELAY_SINGLE_ONION" > "$SINGLE_ONION_CHOICE"
chmod 0600 "$SINGLE_ONION_CHOICE"

if [[ "$DASHBOARD_ONION" == "1" ]]; then
  for _ in $(seq 1 30); do
    if [[ -f "${DASH_HS_DIR}/hostname" ]]; then DASH_ONION="$(cat "${DASH_HS_DIR}/hostname")"; break; fi
    sleep 1
  done
  [[ -n "$DASH_ONION" ]] || die "Tor did not produce ${DASH_HS_DIR}/hostname; check: journalctl -u ${TOR_UNIT}"
  say "  dashboard .onion: ${DASH_ONION}"
fi

# ---------------------------------------------------------------------------
# 8c. Safe-Browsing's own Tor SOCKS proxy — a SEPARATE, client-only tor instance.
#     relay/main.go dials STIQ_TOR_SOCKS (default 127.0.0.1:9050) to relay Google Safe-Browsing
#     hash-prefix lookups over Tor; the feature fails closed (503s) until an API key is configured
#     (safebrowsing.go). Before RELAY_SINGLE_ONION existed, that SOCKS port was never written by any
#     drop-in here — it only worked because Debian's stock tor package torrc happens to enable a
#     SocksPort by default. stiq-base.conf above now sets `SocksPort 0` on THIS instance whenever
#     RELAY_SINGLE_ONION=1 (tor requires it process-wide the moment any HiddenService here runs
#     single-hop), which silently kills that port wherever Safe-Browsing happens to be configured.
#     Fix: stand up a SECOND, minimal, client-only tor instance (Debian's tor-instance-create
#     convention) whose ONLY job is SocksPort 127.0.0.1:9050 — no HiddenService blocks, so it never
#     touches the community onion, the onion key, or single-onion mode at all. main.go's
#     STIQ_TOR_SOCKS default keeps resolving with ZERO Go/relay changes.
#
#     Detection: this script cannot always see whether Safe-Browsing is configured — the key can
#     arrive LATE, written at runtime by the dashboard into config.json's safe_browsing_api_key
#     (issuer/organizer-server.mjs) long after this box was first provisioned, or supplied purely
#     via the relay's own SAFE_BROWSING_API_KEY environment (never touching config.json at all —
#     relay/internal/config/config.go). So treat it as configured when EITHER is true:
#       (a) ${RELAY_ETC}/config.json already has a non-empty "safe_browsing_api_key" (a re-run after
#           the organizer turned it on via the dashboard — re-run this installer to pick it up, the
#           same idempotent-re-run pattern as RELAY_ONION_AUTH / TOKEN_DOMAIN_SEP), OR
#       (b) the operator forces it with SAFE_BROWSING_TOR=1 (covers the env-var-only key path, which
#           this script has no way to see).
#     When Safe-Browsing is NOT configured either way, this deploys NOTHING extra — the feature
#     stays 503-closed by design whether or not a Socks proxy exists for it to use.
# ---------------------------------------------------------------------------
SAFE_BROWSING_CONFIGURED=0
if [[ "$SAFE_BROWSING_TOR" == "1" ]]; then
  SAFE_BROWSING_CONFIGURED=1
elif [[ -f "${RELAY_ETC}/config.json" ]] && python3 -c "
import json, sys
try:
    c = json.load(open('${RELAY_ETC}/config.json'))
except Exception:
    sys.exit(1)
sys.exit(0 if c.get('safe_browsing_api_key') else 1)
" 2>/dev/null; then
  SAFE_BROWSING_CONFIGURED=1
fi

# 2026-07-28 reliability hardening: under single-onion mode this instance is no longer only
# Safe-Browsing's proxy — it is ALSO the watchdog's probe path (the only local route that can
# exercise the relay onion end-to-end, since the main instance has SocksPort 0). So provision it
# whenever single-onion is on, Safe-Browsing or not; an idle client tor costs ~30MB.
if [[ "$RELAY_SINGLE_ONION" == "1" ]]; then
  say "Provisioning a client-only tor instance (Safe-Browsing SOCKS proxy + watchdog onion-probe path)..."
  if [[ ! -d "/etc/tor/instances/${TOR_CLIENT_INSTANCE}" ]]; then
    if command -v tor-instance-create >/dev/null 2>&1; then
      tor-instance-create "$TOR_CLIENT_INSTANCE" \
        || die "tor-instance-create ${TOR_CLIENT_INSTANCE} failed."
    else
      # Fallback for a tor package without the helper: replicate its layout by hand (the Debian
      # tor-instance convention — /etc/tor/instances/<name> + /var/lib/tor-instances/<name>).
      warn "tor-instance-create not found on PATH — creating the ${TOR_CLIENT_INSTANCE} instance layout by hand."
      install -d -o root -g "${TOR_USER}" -m 0750 "/etc/tor/instances/${TOR_CLIENT_INSTANCE}"
      install -d -o "${TOR_USER}" -g "${TOR_USER}" -m 0700 "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}"
    fi
  fi
  cat > "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc" <<TORCONF
# stiqclient — client-only tor instance, managed by deploy/stiq-up.sh (RELAY_SINGLE_ONION=1)
# Two jobs: (1) give relay/main.go's STIQ_TOR_SOCKS (default 127.0.0.1:9050) a normal, anonymous
# 3-hop SOCKS proxy for Safe-Browsing hash-prefix lookups over Tor; (2) carry the stiq-watchdog's
# end-to-end onion probe (ClientOnionAuthDir below decrypts the auth-gated relay descriptor).
# NO HiddenService blocks here — this instance never fronts the community onion and never touches
# the onion key.
DataDirectory /var/lib/tor-instances/${TOR_CLIENT_INSTANCE}
SocksPort 127.0.0.1:9050
Log notice syslog
SafeLogging 1
ClientOnionAuthDir /var/lib/tor-instances/${TOR_CLIENT_INSTANCE}/onion-auth
TORCONF
  chown "${TOR_USER}:${TOR_USER}" "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc"
  chmod 640 "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc"
  # Watchdog probe credentials: the shared community x25519 key (already minted in step 8, and
  # already root-readable on this box) lets the probe decrypt the auth-gated relay descriptor —
  # WITHOUT touching authorized_clients/, so a probe key can never break member reach. The
  # instance user varies (tor-instance-create makes _tor-<name>; the by-hand fallback uses
  # ${TOR_USER}), so derive it from the data directory it must read from.
  INSTANCE_USER="$(stat -c '%U' "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}" 2>/dev/null || echo "${TOR_USER}")"
  install -d -o "$INSTANCE_USER" -g "$INSTANCE_USER" -m 0700 "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}/onion-auth"
  if [[ "$RELAY_ONION_AUTH" == "1" && -f "$RELAY_AUTH_KEY" && -s "${TOR_HS_DIR}/hostname" ]]; then
    PROBE_ONION="$(cat "${TOR_HS_DIR}/hostname")"
    PROBE_PRIV_B32="$(openssl pkey -in "$RELAY_AUTH_KEY" -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
    printf '%s:descriptor:x25519:%s\n' "${PROBE_ONION%.onion}" "$PROBE_PRIV_B32" \
      > "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}/onion-auth/stiq-relay.auth_private"
    chown "$INSTANCE_USER:$INSTANCE_USER" "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}/onion-auth/stiq-relay.auth_private"
    chmod 600 "/var/lib/tor-instances/${TOR_CLIENT_INSTANCE}/onion-auth/stiq-relay.auth_private"
  fi
  # A mode flip from --no-single-onion leaves a stale main-instance clientauth drop-in behind —
  # the probe path is this client instance now, so clear it.
  rm -f /etc/tor/torrc.d/stiq-clientauth.conf 2>/dev/null || true
  # Same restart + hang-detection policy as the onion front (tor pings the systemd watchdog).
  install -d "/etc/systemd/system/tor@${TOR_CLIENT_INSTANCE}.service.d"
  printf '[Service]\nRestart=always\nRestartSec=3\nWatchdogSec=120\n' \
    > "/etc/systemd/system/tor@${TOR_CLIENT_INSTANCE}.service.d/stiq-reliability.conf"
  systemctl daemon-reload
  systemctl enable "tor@${TOR_CLIENT_INSTANCE}" >/dev/null 2>&1 || true
  # restart, not `enable --now`: re-runs can change this torrc (logging, onion-auth) and
  # `enable --now` is a no-op on an already-active unit, silently keeping the old config.
  systemctl restart "tor@${TOR_CLIENT_INSTANCE}" \
    || warn "tor@${TOR_CLIENT_INSTANCE} failed to start — check: journalctl -u tor@${TOR_CLIENT_INSTANCE} -n 50. Safe-Browsing will 503 (fails closed) and the watchdog's onion probe stays dark until this instance is up."
  say "  SOCKS proxy ready on 127.0.0.1:9050 (tor@${TOR_CLIENT_INSTANCE}, client-only, no HS; Safe-Browsing + watchdog probe path)."
else
  # Single-onion is off: the main instance's own SocksPort (tor's default 9050) is untouched by
  # this feature, exactly as before RELAY_SINGLE_ONION existed, and it carries both Safe-Browsing
  # and the watchdog probe. Tear down a stray client instance from a prior run whose mode has
  # since changed, so we don't leave an idle tor process running for nothing.
  systemctl disable --now "tor@${TOR_CLIENT_INSTANCE}" >/dev/null 2>&1 \
    && say "  ${TOR_CLIENT_INSTANCE} tor instance no longer needed — stopped." || true
  # The watchdog's onion probe then rides the MAIN instance's SOCKS, so the auth credential for
  # the gated descriptor must live there instead (a torrc.d drop-in keeps it self-contained).
  INSTANCE_USER="$(stat -c '%U' /var/lib/tor 2>/dev/null || echo "${TOR_USER}")"
  install -d -o "$INSTANCE_USER" -g "$INSTANCE_USER" -m 0700 /var/lib/tor/onion-auth
  if [[ "$RELAY_ONION_AUTH" == "1" && -f "$RELAY_AUTH_KEY" && -s "${TOR_HS_DIR}/hostname" ]]; then
    PROBE_ONION="$(cat "${TOR_HS_DIR}/hostname")"
    PROBE_PRIV_B32="$(openssl pkey -in "$RELAY_AUTH_KEY" -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
    printf '%s:descriptor:x25519:%s\n' "${PROBE_ONION%.onion}" "$PROBE_PRIV_B32" \
      > /var/lib/tor/onion-auth/stiq-relay.auth_private
    chown "$INSTANCE_USER:$INSTANCE_USER" /var/lib/tor/onion-auth/stiq-relay.auth_private
    chmod 600 /var/lib/tor/onion-auth/stiq-relay.auth_private
    printf '# stiq watchdog probe credentials — managed by deploy/stiq-up.sh\nClientOnionAuthDir /var/lib/tor/onion-auth\n' \
      > /etc/tor/torrc.d/stiq-clientauth.conf
  else
    rm -f /etc/tor/torrc.d/stiq-clientauth.conf 2>/dev/null || true
  fi
  # The main instance already restarted in step 8, BEFORE this drop-in existed — apply it now.
  systemctl reload "$TOR_UNIT" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 9. Relay config + binary + service
# ---------------------------------------------------------------------------
say "Writing the relay config (${RELAY_ETC}/config.json)..."
# max_event_bytes caps stored event content (NIP-11 max_content_length). Inline media rides as
# base64 IN the content (voice up to ~267KB base64, pictures up to ~65KB), so this must clear the
# largest media note or the relay rejects it ("failed / Retry"). 512KB clears every allowed clip;
# note khatru's WS frame cap (MaxMessageSize, 500KB) is the true ceiling — still ~1.8x the largest
# audio note (~275KB). Override with MAX_EVENT_BYTES=… before running.
#
# MERGE, don't overwrite. The installer OWNS (and overwrites on every re-run) exactly these keys —
# each is fully derived from installer inputs:
#   listen, issuer_public_keys, organizer_pubkeys, data_dir, membership_file,
#   enroll_pow, pow_difficulty, max_event_bytes
# Every OTHER key already present in an existing config.json is PRESERVED byte-for-byte across
# re-runs — including fields the dashboard writes at runtime (safe_browsing_api_key) and security
# flips an operator or this installer's own domain-sep step (9b) sets (blind_required,
# bytes_per_token, posting_issuer_public_keys, binding_issuer_public_keys, private_group_read_auth,
# max_limit, allowed_kinds, ...). An earlier version of this script used an unconditional heredoc
# here, which clobbered config.json wholesale on every "idempotent" re-run and silently reverted any
# of those. Written atomically (temp file + rename) so a crash mid-write can't leave a half-written
# config on disk.
CONFIG_PATH="${RELAY_ETC}/config.json"

# resolve_token_domain_sep_default — pick TOKEN_DOMAIN_SEP when the operator did not pass one.
#
# It used to default to a flat 0, which meant every FRESH community shipped with enrollment
# credentials and posting tokens signed by ONE key. A bare RSA-PSS credential carries no type, so
# the relay cannot tell them apart: a plentiful posting token doubles as a scarce membership-binding
# credential, and a banned member can simply bind a new npub. The client-side member roll is built
# on that scarcity, so the organizer refuses to publish the roll unless separation is on — meaning
# new deployments silently got no ban-evasion protection at all until an operator knew to flip a
# flag they had never heard of.
#
# So the default INHERITS rather than flipping wholesale:
#   * no relay config yet (a fresh install)          → 1. Nothing exists to break.
#   * config already carries posting_issuer_public_keys → 1. Separation is already on; inheriting it
#     also retires a re-run footgun, since a plain re-run used to trip the reverse-transition die()
#     below purely for not re-passing the flag.
#   * config exists WITHOUT separation                → 0. Never auto-flip a live community: its
#     members hold already-drawn posting tokens signed under K_enroll, and turning separation on
#     would stop those verifying — every one of them would fail to post. That flip is a deliberate,
#     announced operation (pass STIQ_TOKEN_DOMAIN_SEP=1), not a side effect of running the installer.
resolve_token_domain_sep_default() {
  [[ -n "$TOKEN_DOMAIN_SEP" ]] && return 0        # operator (or the --attach branch) chose already
  if [[ ! -f "$CONFIG_PATH" ]]; then
    TOKEN_DOMAIN_SEP=1
    say "Token domain separation: ON (fresh install default — posting and enrollment keys stay distinct)."
    return 0
  fi
  if STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY'
import json, os, sys
try:
    cfg = json.load(open(os.environ['STIQ_INSTALLER_CONFIG_PATH']))
except Exception:
    sys.exit(1)
sys.exit(0 if cfg.get('posting_issuer_public_keys') else 1)
PY
  then
    TOKEN_DOMAIN_SEP=1
    say "Token domain separation: ON (inherited from ${CONFIG_PATH})."
  else
    TOKEN_DOMAIN_SEP=0
    say "Token domain separation: OFF (inherited from ${CONFIG_PATH}). This community's members hold posting tokens signed under the enrollment key, so enabling it is a deliberate, announced flip — re-run with STIQ_TOKEN_DOMAIN_SEP=1 when ready. Until then the organizer will not publish the member roll (see PLAN.md §3.4)."
  fi
}
resolve_token_domain_sep_default

# secure_relay_config restores stiq:stiq ownership + 600 perms on $CONFIG_PATH. Every rewrite of this
# file (here and in 9b/9c/9d below) runs as root and writes via temp-file + os.replace — atomic
# against a crash mid-write, but os.replace mints a NEW inode owned by whoever wrote it (root), which
# silently REVERTS the stiq:stiq ownership set once below and leaves the organizer dashboard (which
# runs as user 'stiq') unable to write its own flags to its own config (EACCES) — the exact incident
# this fixes. Call this immediately after EVERY root-run rewrite of $CONFIG_PATH, not just the first.
secure_relay_config() {
  chown stiq:stiq "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
}

# Push discovery fields (T1). Non-empty ONLY when PUSH_WATCHER=1 — the watcher is fronted at
# <relay-onion>:<port>, ntfy at the bare relay onion host (its loopback port is a deploy detail the
# client never dials directly; it only host-validates the endpoint the ntfy app produced). Both flow
# into NIP-11 stiq-capabilities.push on the next relay restart. Empty ⇒ the merge leaves any existing
# push_* keys untouched (preserve-all-other-keys), so a normal run adds no push block.
PUSH_WATCHER_ONION=""
PUSH_NTFY_ONION=""
if [[ "$PUSH_WATCHER" == "1" ]]; then
  PUSH_WATCHER_ONION="${ONION}:${WATCHER_PORT}"
  PUSH_NTFY_ONION="${ONION}"
fi
if [[ -n "$ATTACH_BUNDLE" ]]; then
# Mirror mode: the BUNDLE is authoritative for every community-semantic key (same allowlist the
# export wrote — verification public keys, org trust root, admission rules, enforcement flags),
# so the mirror's NIP-11 advertises exactly what the primary enforces; a drifted advertisement
# from a mirror could otherwise confuse a client whose capability fetch ever lands here. Box-local
# keys (listen/data_dir/membership_file) are set fresh; any OTHER key an operator hand-added to
# this mirror's config is preserved (same merge discipline as the primary writer below).
STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" \
STIQ_INSTALLER_BUNDLE="$ATTACH_BUNDLE" \
STIQ_INSTALLER_DATA_DIR="${RELAY_LIB}/data" \
STIQ_INSTALLER_MEMBERSHIP_FILE="${RELAY_LIB}/membership.json" \
python3 <<'PY' || die "failed to write ${CONFIG_PATH} from the mirror bundle."
import json, os, sys

path = os.environ['STIQ_INSTALLER_CONFIG_PATH']
existing = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            existing = json.load(f)
    except Exception as e:
        sys.exit("refusing to merge: existing config.json is not valid JSON (%s)" % e)

with open(os.environ['STIQ_INSTALLER_BUNDLE']) as f:
    bundle = json.load(f)
community = bundle.get('config') or {}
if not community.get('issuer_public_keys') or not community.get('organizer_pubkeys'):
    sys.exit('bundle config lost its issuer_public_keys/organizer_pubkeys — re-export it on the primary.')

existing.update(community)
existing.update({
    'listen': '127.0.0.1:3334',
    'data_dir': os.environ['STIQ_INSTALLER_DATA_DIR'],
    'membership_file': os.environ['STIQ_INSTALLER_MEMBERSHIP_FILE'],
})
# A mirror must never carry another box's runtime secret or push endpoints, even if a hand-copied
# config left them behind.
for k in ('safe_browsing_api_key', 'push_watcher_onion', 'push_ntfy_onion'):
    existing.pop(k, None)

tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(existing, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
else
STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" \
STIQ_INSTALLER_ISSUER_PEM="$ISSUER_PUB_PEM" \
STIQ_INSTALLER_ORG_PUBHEX="$ORG_PUBHEX" \
STIQ_INSTALLER_DATA_DIR="${RELAY_LIB}/data" \
STIQ_INSTALLER_MEMBERSHIP_FILE="${RELAY_LIB}/membership.json" \
STIQ_INSTALLER_ENROLL_POW="$ENROLL_POW" \
STIQ_INSTALLER_POW_DIFFICULTY="$DM_POW" \
STIQ_INSTALLER_MAX_EVENT_BYTES="${MAX_EVENT_BYTES:-524288}" \
STIQ_INSTALLER_PUSH_WATCHER_ONION="$PUSH_WATCHER_ONION" \
STIQ_INSTALLER_PUSH_NTFY_ONION="$PUSH_NTFY_ONION" \
python3 <<'PY' || die "failed to write ${CONFIG_PATH}."
import json, os, sys

path = os.environ['STIQ_INSTALLER_CONFIG_PATH']
existing = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            existing = json.load(f)
    except Exception as e:
        sys.exit("refusing to merge: existing config.json is not valid JSON (%s)" % e)

with open(os.environ['STIQ_INSTALLER_ISSUER_PEM']) as f:
    issuer_pem = f.read()

existing.update({
    'listen': '127.0.0.1:3334',
    'issuer_public_keys': [issuer_pem],
    'organizer_pubkeys': [os.environ['STIQ_INSTALLER_ORG_PUBHEX']],
    'data_dir': os.environ['STIQ_INSTALLER_DATA_DIR'],
    'membership_file': os.environ['STIQ_INSTALLER_MEMBERSHIP_FILE'],
    'enroll_pow': int(os.environ['STIQ_INSTALLER_ENROLL_POW']),
    'pow_difficulty': int(os.environ['STIQ_INSTALLER_POW_DIFFICULTY']),
    'max_event_bytes': int(os.environ['STIQ_INSTALLER_MAX_EVENT_BYTES']),
})

# Push onions are installer-owned ONLY when PUSH_WATCHER=1 (non-empty). When empty we do NOT touch
# any existing push_* keys — so leaving PUSH_WATCHER=0 on a box that had it on preserves the block
# (the client falls back to polling when the app flag is off anyway).
_pw = os.environ.get('STIQ_INSTALLER_PUSH_WATCHER_ONION', '')
_pn = os.environ.get('STIQ_INSTALLER_PUSH_NTFY_ONION', '')
if _pw or _pn:
    existing['push_watcher_onion'] = _pw
    existing['push_ntfy_onion'] = _pn

tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(existing, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
fi
python3 -c "import json,sys; json.load(open('${CONFIG_PATH}'))" \
  || die "generated relay config.json is invalid."

say "Installing the relay binary + systemd unit..."
install -o stiq -g stiq -m 0755 "$RELAY_SRC_BIN" "$RELAY_BIN"
chown -R stiq:stiq "${RELAY_LIB}" "${RELAY_ETC}"
chmod 600 "${RELAY_ETC}/config.json"

# Installed straight from the canonical unit file (relay/deploy/stiq-relay.service) — its
# ExecStart/WorkingDirectory/Environment paths (/usr/local/bin/stiq-relay, /var/lib/stiq-relay,
# /etc/stiq-relay/config.json) match RELAY_BIN/RELAY_LIB/RELAY_ETC above byte-for-byte (this
# installer hardcodes the same values under PREFIX=/opt/stiq's sibling dirs), so there is no
# per-deploy templating to do here. Single source of truth: don't reintroduce a second inline copy.
install -m 0644 "${REPO}/relay/deploy/stiq-relay.service" /etc/systemd/system/stiq-relay.service

# ---------------------------------------------------------------------------
# 9c. Push stack (T1) — off-the-shelf ntfy + the keyless pushwatcher, only when PUSH_WATCHER=1.
#     Both bind loopback and are fronted ONLY by the relay onion (HiddenServicePort lines added in
#     step 8). ntfy is DEPLOYED, never built. The watcher holds zero keys and never decrypts.
# ---------------------------------------------------------------------------
if [[ "$PUSH_WATCHER" == "1" ]]; then
  say "Provisioning the push stack (ntfy + keyless pushwatcher)..."

  # 9c-1. Install ntfy off-the-shelf from the official archive.heckel.io apt repo (NEVER built here).
  # Mirrors the Tor-repo idempotent pattern above: fetch+dearmor the signing key, add a signed-by
  # sources line, refresh, install. A hard failure dies (the operator explicitly opted into push).
  if command -v ntfy >/dev/null 2>&1; then
    say "  ntfy already installed — keeping it."
  else
    NTFY_KEYRING="/usr/share/keyrings/archive.heckel.io.gpg"
    NTFY_ARCH="$(dpkg --print-architecture)"
    if install -m 0755 -d /usr/share/keyrings 2>/dev/null \
       && curl -fsSL https://archive.heckel.io/apt/pubkey.txt -o /tmp/ntfy.asc 2>/dev/null \
       && gpg --dearmor < /tmp/ntfy.asc > "${NTFY_KEYRING}.tmp" 2>/dev/null; then
      mv -f "${NTFY_KEYRING}.tmp" "$NTFY_KEYRING"; chmod 0644 "$NTFY_KEYRING"
      echo "deb [arch=${NTFY_ARCH} signed-by=${NTFY_KEYRING}] https://archive.heckel.io/apt debian main" \
        > /etc/apt/sources.list.d/archive.heckel.io.list
      apt-get update -qq || warn "apt-get update against the ntfy repo failed; ntfy may not install this run."
      apt-get install -y -qq ntfy >/dev/null \
        || die "ntfy could not be installed from archive.heckel.io (PUSH_WATCHER=1). Fix apt/networking and re-run."
    else
      rm -f "${NTFY_KEYRING}.tmp"
      die "could not configure the ntfy apt repo (network?). ntfy is required for PUSH_WATCHER=1 — add archive.heckel.io or preinstall ntfy, then re-run."
    fi
    rm -f /tmp/ntfy.asc
  fi

  # 9c-2. Loopback-only ntfy config from the repo template: bind 127.0.0.1:2586, base-url on the
  # relay onion, behind-proxy false, no clearnet. The .deb ships an ntfy 'ntfy' user + ntfy.service.
  # Stop the service FIRST — the package postinst starts ntfy on its default (clearnet :80) — so we
  # minimize any window before our loopback-only config is loaded by the restart below.
  systemctl stop ntfy >/dev/null 2>&1 || true
  [[ -f "${REPO}/relay/deploy/ntfy-server.yml" ]] \
    || die "missing ${REPO}/relay/deploy/ntfy-server.yml (needed to configure ntfy for PUSH_WATCHER=1)."
  install -d -m 0755 /etc/ntfy
  sed -e "s|__NTFY_LISTEN__|127.0.0.1:${NTFY_PORT}|g" \
      -e "s|__NTFY_BASE_URL__|http://${ONION}:${NTFY_PORT}|g" \
      "${REPO}/relay/deploy/ntfy-server.yml" > /etc/ntfy/server.yml
  chmod 0644 /etc/ntfy/server.yml
  systemctl enable ntfy >/dev/null 2>&1 || warn "could not enable ntfy.service."
  systemctl restart ntfy || warn "ntfy.service failed to (re)start — check: journalctl -u ntfy -n 50"

  # 9c-3. Keyless watcher binary + hardened systemd unit. WATCHER_ALLOWED_NTFY_HOST is the
  # fail-closed sentinel (the relay onion host); the watcher reaches ntfy over loopback and writes
  # nothing to disk (no ReadWritePaths). NO MemoryDenyWriteExecute — the Go runtime needs W+X.
  install -o stiq -g stiq -m 0755 "$WATCHER_SRC_BIN" "$WATCHER_BIN"
  cat > /etc/systemd/system/stiq-pushwatcher.service <<UNIT
[Unit]
Description=STIQ keyless push watcher (loopback firehose → content-free ntfy wakes)
After=network.target stiq-relay.service tor.service
Wants=stiq-relay.service

[Service]
User=stiq
Group=stiq
# Reach the co-located relay + ntfy over loopback; front them only via the relay onion.
Environment=WATCHER_RELAY_WS=ws://127.0.0.1:3334
Environment=WATCHER_LISTEN=127.0.0.1:${WATCHER_PORT}
Environment=WATCHER_NTFY_BASE=http://127.0.0.1:${NTFY_PORT}
# Fail-closed sentinel: the ntfy host the watcher is allowed to poke (the community relay onion).
Environment=WATCHER_ALLOWED_NTFY_HOST=${ONION}
ExecStart=${WATCHER_BIN}
WorkingDirectory=${RELAY_LIB}
Restart=on-failure
RestartSec=5
StandardOutput=null
StandardError=null
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
UNIT
fi

# ---------------------------------------------------------------------------
# 10. Organizer dashboard service. Binds loopback always; reached EITHER via the
#     client-auth dashboard onion (DASHBOARD_ONION=1) or an SSH tunnel.
#     Mirror mode: skipped wholesale — a mirror runs a relay and nothing else.
# ---------------------------------------------------------------------------
if [[ -z "$ATTACH_BUNDLE" ]]; then
say "Installing the organizer dashboard service..."
# Persist the resolved onion next to the dashboard too, so manual `node organizer-server.mjs`
# runs (outside systemd) still pick it up.
printf '%s\n' "${RELAY_ONION_WS}" > "${ORG_DIR}/relay_onion.txt"
# Same idea for the relay WS URL. organizer-server.mjs resolves env → relay_ws.txt → onion; writing
# it here gives the file rung something to find, so a lost/rotated RELAY_WS can't silently strand
# enrollment and draws. The organizer sits on this box but outside every automated check, and the
# client cannot self-heal wallet state in the background — so that failure gets misattributed to
# the app. Written next to relay_onion.txt because the organizer reads both from its OWN directory.
printf '%s\n' "${RELAY_ONION_WS}" > "${ORG_DIR}/relay_ws.txt"

# When the dashboard onion is on, a login password is mandatory (the bind stays loopback, so the
# in-process non-loopback guard wouldn't otherwise fire). Generate one if the operator didn't set
# STIQ_ORG_PASSWORD, persist it, and pass secrets via a 0600 EnvironmentFile (NOT the unit, which
# is world-readable).
ENVFILE="${AUTH_DIR}/env"
if [[ "$DASHBOARD_ONION" == "1" ]]; then
  install -d -o stiq -g stiq -m 0700 "$AUTH_DIR"
  if [[ -z "$ORG_PASSWORD" ]]; then
    if [[ -f "${AUTH_DIR}/password.txt" ]]; then ORG_PASSWORD="$(cat "${AUTH_DIR}/password.txt")";
    else ORG_PASSWORD="$(openssl rand -hex 16)"; fi
  fi
  printf '%s' "$ORG_PASSWORD" > "${AUTH_DIR}/password.txt"
  {
    printf 'STIQ_ORG_PASSWORD=%s\n' "$ORG_PASSWORD"
    printf 'STIQ_REQUIRE_PASSWORD=1\n'
  } > "$ENVFILE"
  chown stiq:stiq "${AUTH_DIR}/password.txt" "$ENVFILE"
  chmod 600 "${AUTH_DIR}/password.txt" "$ENVFILE"
else
  # Re-run flipped back to SSH-only mode: drop any stale secrets env so the dashboard does
  # NOT keep demanding a password (STIQ_REQUIRE_PASSWORD=1) with no onion in front of it.
  rm -f "$ENVFILE" 2>/dev/null || true
fi

chown -R stiq:stiq "${PREFIX}"
chmod 600 "${ISSUER_PEM}" "${ORG_DIR}/organizer_nostr.json"

cat > /etc/systemd/system/stiq-organizer.service <<UNIT
[Unit]
Description=STIQ organizer dashboard + automated enrollment mailbox
After=network-online.target stiq-relay.service tor.service
Wants=network-online.target
Requires=stiq-relay.service

[Service]
Type=simple
User=stiq
Group=stiq
WorkingDirectory=${ORG_DIR}
# Reach the co-located relay directly over loopback — no Tor hop on the organizer side.
Environment=RELAY_WS=ws://127.0.0.1:3334
# The community's own onion (shown in join/community codes).
Environment=STIQ_RELAY_ONION=${RELAY_ONION_WS}
# Shared Tor v3 onion client-auth PRIVATE key (lever 2), emitted into the v4 community code so a
# member's device can REACH the auth-gated relay onion. Empty unless RELAY_ONION_AUTH=1.
Environment=STIQ_ONION_AUTH_KEY=${RELAY_AUTH_PRIV_B32}
# NIP-13 difficulty mined on enroll responses — MUST equal the relay's enroll_pow and the client.
Environment=STIQ_ENROLL_POW=${ENROLL_POW}
# Token domain separation (mints posting/read tokens under dedicated keys). OFF (0) by default; when
# on, step 9b below fetches the resulting posting/binding public keys and wires them into the relay.
Environment=STIQ_TOKEN_DOMAIN_SEP=${TOKEN_DOMAIN_SEP}
# The relay's bound-npub registry (membership_file in the relay config — both run as 'stiq'). The
# organizer reads it to publish the encrypted stiq:member-roll doc; only meaningful (and only
# published) under token domain separation.
Environment=STIQ_MEMBERSHIP_FILE=${RELAY_LIB}/membership.json
Environment=STIQ_READ_AUTH=${CONTENT_ENCRYPTION}
# Dashboard binds loopback only; a Tor onion (with client auth) or SSH tunnel fronts it.
Environment=STIQ_BIND=127.0.0.1
Environment=STIQ_COMMUNITY_NAME=${COMMUNITY_NAME}
Environment=STIQ_ORGANIZER_LABEL=${ORGANIZER_LABEL}
# Lets the dashboard read/write the co-located relay's config to set the Safe Browsing API key
# (a relay secret — not a Nostr event). The relay hot-reloads config.json; both run as 'stiq'.
Environment=STIQ_RELAY_CONFIG=${RELAY_ETC}/config.json
# Optional secrets (password + STIQ_REQUIRE_PASSWORD) — present only when the dashboard onion
# is enabled. The leading '-' makes it non-fatal when absent.
EnvironmentFile=-${ENVFILE}
ExecStart=/usr/bin/env node organizer-server.mjs ${DASH_PORT}
Restart=on-failure
RestartSec=5
# Hardening — the issuer RSA key + organizer Nostr key live in this process.
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
# ${PREFIX} = dashboard state; ${RELAY_ETC} = relay config dir (so the Safe Browsing key can be
# written to /etc/stiq-relay/config.json despite ProtectSystem=full making /etc read-only).
ReadWritePaths=${PREFIX} ${RELAY_ETC}

[Install]
WantedBy=multi-user.target
UNIT

fi

# ---------------------------------------------------------------------------
# 11. A single target binding relay + organizer (co-located lifecycle)
#     Mirror mode: the target binds the relay alone.
# ---------------------------------------------------------------------------
# When PUSH_WATCHER=1 the pushwatcher joins the co-located lifecycle target. PUSH_UNIT is empty
# otherwise, so a normal run writes a byte-identical target to today (relay + organizer only).
PUSH_UNIT=""
[[ "$PUSH_WATCHER" == "1" ]] && PUSH_UNIT=" stiq-pushwatcher.service"
if [[ -n "$ATTACH_BUNDLE" ]]; then
cat > /etc/systemd/system/stiq.target <<UNIT
[Unit]
Description=STIQ mirror relay (blind federation secondary)
Wants=stiq-relay.service
After=stiq-relay.service

[Install]
WantedBy=multi-user.target
UNIT
else
cat > /etc/systemd/system/stiq.target <<UNIT
[Unit]
Description=STIQ community (relay + organizer, co-located)
Wants=stiq-relay.service stiq-organizer.service${PUSH_UNIT}
After=stiq-relay.service stiq-organizer.service${PUSH_UNIT}

[Install]
WantedBy=multi-user.target
UNIT
fi

# ---------------------------------------------------------------------------
# 12. Start everything
# ---------------------------------------------------------------------------
say "Starting services..."
systemctl daemon-reload
# `enable --now` is a no-op for an already-active unit. Re-runs can change the relay binary,
# organizer code, PoW settings, relay onion, and (critically) STIQ_ONION_AUTH_KEY, so explicitly
# restart both processes after installing their units. Otherwise Tor may enforce the newly written
# authorized-client key while the organizer keeps issuing join codes from its stale environment.
if [[ -n "$ATTACH_BUNDLE" ]]; then
  systemctl enable stiq-relay.service >/dev/null 2>&1
  systemctl restart stiq-relay.service
else
systemctl enable stiq-relay.service stiq-organizer.service >/dev/null 2>&1
systemctl restart stiq-relay.service
systemctl restart stiq-organizer.service
fi
# Push watcher (T1) — enable + restart alongside the others so a re-run picks up a new binary, the
# freshly written onion-host sentinel, or a changed loopback port. Gated: a normal run never touches
# it. (ntfy was already enabled/restarted in step 9c.)
if [[ "$PUSH_WATCHER" == "1" ]]; then
  systemctl enable stiq-pushwatcher.service >/dev/null 2>&1
  systemctl restart stiq-pushwatcher.service || warn "stiq-pushwatcher failed to start — check: journalctl -u stiq-pushwatcher -n 50"
fi
systemctl enable stiq.target >/dev/null 2>&1 || true

sleep 2
RELAY_STATE="$(systemctl is-active stiq-relay.service || true)"
[[ "$RELAY_STATE" == "active" ]] || warn "stiq-relay is '${RELAY_STATE}' — check: journalctl -u stiq-relay -n 50"
if [[ -z "$ATTACH_BUNDLE" ]]; then
  ORG_STATE="$(systemctl is-active stiq-organizer.service || true)"
  [[ "$ORG_STATE" == "active" ]] || warn "stiq-organizer is '${ORG_STATE}' — check: journalctl -u stiq-organizer -n 50"
fi

# ---------------------------------------------------------------------------
# 12a. Reachability watchdog (2026-07-28 reliability hardening)
# WHY: on 2026-07-28 the relay onion went silently unreachable for ~1.5h — tor@default stayed
# "active (running)", systemd saw nothing wrong, and recovery required a human noticing from a
# phone and restarting tor. The watchdog probes the relay locally AND end-to-end through the
# onion (SOCKS + client-auth) every 2 minutes and restarts the exact layer that failed, with
# strike counts, bootstrap grace, and cooldowns so it can never flap a healthy stack. Incidents
# (with pre-restart forensics) append to /var/log/stiq-watchdog.log.
# ---------------------------------------------------------------------------
say "Installing the stiq reachability watchdog (probe every 2 min, auto-heal)..."
install -m 0755 "${REPO}/relay/deploy/stiq-watchdog.sh" /usr/local/bin/stiq-watchdog.sh
install -m 0644 "${REPO}/relay/deploy/stiq-watchdog.service" /etc/systemd/system/stiq-watchdog.service
install -m 0644 "${REPO}/relay/deploy/stiq-watchdog.timer"   /etc/systemd/system/stiq-watchdog.timer
cat > /etc/logrotate.d/stiq-watchdog <<'WDLOGROTATE'
/var/log/stiq-watchdog.log {
	monthly
	rotate 6
	compress
	missingok
	notifempty
}
WDLOGROTATE
systemctl daemon-reload
systemctl enable --now stiq-watchdog.timer >/dev/null 2>&1 \
  || warn "stiq-watchdog.timer failed to enable — the relay has no reachability auto-heal. Check: systemctl status stiq-watchdog.timer"
if [[ "$PUSH_WATCHER" == "1" ]]; then
  WATCHER_STATE="$(systemctl is-active stiq-pushwatcher.service || true)"
  NTFY_STATE="$(systemctl is-active ntfy.service || true)"
  [[ "$WATCHER_STATE" == "active" ]] || warn "stiq-pushwatcher is '${WATCHER_STATE}' — check: journalctl -u stiq-pushwatcher -n 50"
  [[ "$NTFY_STATE"    == "active" ]] || warn "ntfy is '${NTFY_STATE}' — check: journalctl -u ntfy -n 50"
fi

# ---------------------------------------------------------------------------
# 9b. Token domain separation — coordinated key wiring (only when TOKEN_DOMAIN_SEP=1)
# ---------------------------------------------------------------------------
# The organizer above just started with STIQ_TOKEN_DOMAIN_SEP baked in, minting (or loading) its
# K_post/K_read purpose keys. Fetch them over loopback and inject into the relay config so posting
# tokens verify against K_post and kind-9011 bindings stay pinned to K_enroll, THEN restart the relay
# so it picks the new keys up — closing the "flag flipped on the organizer alone bricks posting" gap.
# A hard failure here (die) is deliberate: half-wired domain-sep is worse than not enabling it, since
# it would silently brick every post once the organizer starts signing under K_post.
#
# Mirror mode skips 9b-9d WHOLESALE: every purpose key and enforcement flag arrived verbatim in the
# bundle (step 9's attach branch), there is no local organizer to coordinate with, and 9b's
# reverse-transition guard below would otherwise (correctly, for a primary) refuse a config that
# carries posting keys without STIQ_TOKEN_DOMAIN_SEP=1 — which on a mirror is the NORMAL state.
if [[ -z "$ATTACH_BUNDLE" ]]; then
if [[ "$TOKEN_DOMAIN_SEP" == "1" ]]; then
  say "Token domain separation is ON — wiring posting/binding keys into the relay config..."
  TOKEN_KEYS_JSON=""
  for _ in $(seq 1 20); do
    TOKEN_KEYS_JSON="$(curl -fsS "http://127.0.0.1:${DASH_PORT}/api/token-keys" 2>/dev/null || true)"
    [[ -n "$TOKEN_KEYS_JSON" ]] && break
    sleep 1
  done
  [[ -n "$TOKEN_KEYS_JSON" ]] \
    || die "STIQ_TOKEN_DOMAIN_SEP=1 but could not reach the organizer's loopback /api/token-keys to fetch the posting/binding keys (check: journalctl -u stiq-organizer -n 50)."

  STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - "$TOKEN_KEYS_JSON" <<'PY' \
    || die "failed to wire posting/binding issuer keys into the relay config for token domain separation (see message above)."
import json, os, sys, textwrap

resp = json.loads(sys.argv[1])
if not resp.get('domainSeparation'):
    sys.exit("organizer reports domainSeparation=false despite STIQ_TOKEN_DOMAIN_SEP=1 (env may not "
              "have taken effect yet) — refusing to finish a half-wired rollout.")
if not resp.get('postPubKey') or not resp.get('enrollPubKey'):
    sys.exit("organizer's /api/token-keys response is missing postPubKey/enrollPubKey.")

def to_pem(b64):
    body = '\n'.join(textwrap.wrap(b64, 64))
    return "-----BEGIN PUBLIC KEY-----\n" + body + "\n-----END PUBLIC KEY-----\n"

path = os.environ['STIQ_INSTALLER_CONFIG_PATH']
with open(path) as f:
    cfg = json.load(f)
# posting tokens verify ONLY against K_post; kind-9011 bindings stay pinned to K_enroll (the SAME
# key as issuer_public_keys) so a plentiful posting token can never double as a scarce membership
# credential, even once K_post exists.
cfg['posting_issuer_public_keys'] = [to_pem(resp['postPubKey'])]
cfg['binding_issuer_public_keys'] = [to_pem(resp['enrollPubKey'])]
# Media WRITE-token domain separation (asks #3/#4): a post CLAIMING stiq_dom=picture/audio must
# verify against K_picwrite / K_audwrite. Only wired when the organizer surfaced the keys (it does
# under domain sep). Absent ⇒ the relay falls back to the posting keys for that domain (byte-identical),
# so an organizer that predates media keys stays valid. Media READ tokens never touch relay admission
# (reads are metered at the organizer), so there is no picture/audio read key in the relay config.
if resp.get('picWritePubKey'):
    cfg['picture_write_issuer_public_keys'] = [to_pem(resp['picWritePubKey'])]
if resp.get('audWritePubKey'):
    cfg['audio_write_issuer_public_keys'] = [to_pem(resp['audWritePubKey'])]
# Space-write token domain (tokens-everywhere): meters bound-npub space content (channels/groups/DMs).
# Wiring the key here lets the relay VERIFY space tokens; it does not REQUIRE them — that is the
# separate space_tokens_required flag (STIQ_SPACE_TOKENS below), a fleet-coordinated flip. Absent ⇒
# token-tagged space kinds stay rejected (dark), byte-identical to before.
if resp.get('spaceWritePubKey'):
    cfg['space_write_issuer_public_keys'] = [to_pem(resp['spaceWritePubKey'])]
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
  secure_relay_config
  say "  relay config now pins posting tokens to K_post and bindings to K_enroll — restarting the relay..."
  systemctl restart stiq-relay.service
  sleep 1
  [[ "$(systemctl is-active stiq-relay.service || true)" == "active" ]] \
    || die "stiq-relay failed to restart with the domain-sep keys wired in — check: journalctl -u stiq-relay -n 50"

  # Preflight/postflight assertion: refuse to declare the deploy live if the organizer still reports
  # domain separation on but the relay config doesn't carry a matching posting key.
  RECHECK_JSON="$(curl -fsS "http://127.0.0.1:${DASH_PORT}/api/token-keys" 2>/dev/null || true)"
  RECHECK_OK="$(STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - "$RECHECK_JSON" <<'PY' 2>/dev/null || echo 0
import json, os, sys
try:
    resp = json.loads(sys.argv[1])
    cfg = json.load(open(os.environ['STIQ_INSTALLER_CONFIG_PATH']))
    print('1' if resp.get('domainSeparation') and cfg.get('posting_issuer_public_keys') else '0')
except Exception:
    print('0')
PY
)"
  [[ "$RECHECK_OK" == "1" ]] \
    || die "post-wiring check failed: organizer reports domainSeparation but ${CONFIG_PATH} still lacks posting_issuer_public_keys."
  say "Token domain separation verified: relay + organizer agree on the posting key."
else
  # Reverse-transition guard. The T5 config merge deliberately PRESERVES an existing
  # posting_issuer_public_keys, so restarting the organizer WITHOUT domain separation on a box that
  # has it would sign posting tokens under K_enroll while the relay still verifies ONLY against
  # K_post — silently bricking every post (the WS/enrollment smoke tests don't exercise ordinary
  # posting, so nothing would catch it). Refuse to proceed rather than silently revert.
  #
  # Reaching this is now DELIBERATE: the default inherits an existing box's separation
  # (resolve_token_domain_sep_default), so a plain re-run no longer trips it — only an explicit
  # STIQ_TOKEN_DOMAIN_SEP=0 gets here, and that operator is asking for exactly what this prevents.
  if [[ -f "$CONFIG_PATH" ]] && STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY'
import json, os, sys
try:
    cfg = json.load(open(os.environ['STIQ_INSTALLER_CONFIG_PATH']))
except Exception:
    sys.exit(1)
sys.exit(0 if cfg.get('posting_issuer_public_keys') else 1)
PY
  then
    die "$(cat <<EOM
${CONFIG_PATH} already has posting_issuer_public_keys set (token domain separation is ENABLED on this
box), but this run was given STIQ_TOKEN_DOMAIN_SEP=0 explicitly. Proceeding would restart the organizer
signing posting tokens under K_enroll while the relay keeps verifying against K_post — silently bricking
ALL posting. Drop STIQ_TOKEN_DOMAIN_SEP to inherit the box's current setting (the default), or
intentionally disable separation by removing posting_issuer_public_keys/binding_issuer_public_keys from
${CONFIG_PATH} first.
EOM
)"
  fi
fi

# ── 9c. Censorable-reads activation (asks #4) — OFF by default, a deliberate fleet-coordinated flip.
# When STIQ_CONTENT_ENCRYPTION=1 the relay ADVERTISES content_encryption + read_auth_required so
# updated clients seal post bodies and attach a reader-auth to read draws (letting the organizer
# refuse a read-revoked member). POSTING stays uncensorable regardless. This is ONE-WAY for a client
# until it updates, so only enable it AFTER the sealing-aware client has shipped and members updated
# (see MEDIA_TOKENS_CENSORABLE_READS_SPEC.md §6). Requires domain separation (read tokens = K_read).
if [[ "$CONTENT_ENCRYPTION" == "1" ]]; then
  [[ "$TOKEN_DOMAIN_SEP" == "1" ]] \
    || die "STIQ_CONTENT_ENCRYPTION=1 requires STIQ_TOKEN_DOMAIN_SEP=1 (read tokens must be drawn under K_read). Re-run with both set."
  say "Censorable reads are ON — advertising content_encryption + read_auth_required on the relay..."
  STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY' \
    || die "failed to set content_encryption/read_auth_required in the relay config."
import json, os
path = os.environ['STIQ_INSTALLER_CONFIG_PATH']
with open(path) as f:
    cfg = json.load(f)
cfg['content_encryption'] = True
cfg['read_auth_required'] = True
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
  secure_relay_config
  systemctl restart stiq-relay.service
  sleep 1
  [[ "$(systemctl is-active stiq-relay.service || true)" == "active" ]] \
    || die "stiq-relay failed to restart with content_encryption on — check: journalctl -u stiq-relay -n 50"
  say "Censorable reads verified: relay advertises content_encryption + read_auth_required."
fi

# ── 9d. Space-tokens activation (tokens-everywhere) — OFF by default, a deliberate fleet-coordinated
# flip. When STIQ_SPACE_TOKENS=1 the relay REQUIRES space-write tokens on member space content, so
# channels/groups/DMs share the feed's anti-spam economics. ONE-WAY for a client until it updates
# (an un-updated client can't attach the tokens), so only enable AFTER the space-token client has
# shipped and members updated. Requires domain separation (space tokens = K_spacewrite, wired in 9b).
if [[ "$SPACE_TOKENS" == "1" ]]; then
  [[ "$TOKEN_DOMAIN_SEP" == "1" ]] \
    || die "STIQ_SPACE_TOKENS=1 requires STIQ_TOKEN_DOMAIN_SEP=1 (space tokens must be drawn under K_spacewrite). Re-run with both set."
  say "Space tokens are ON — requiring space_tokens on channel/group/DM content..."
  STIQ_INSTALLER_CONFIG_PATH="$CONFIG_PATH" python3 - <<'PY' \
    || die "failed to set space_tokens_required in the relay config."
import json, os
path = os.environ['STIQ_INSTALLER_CONFIG_PATH']
with open(path) as f:
    cfg = json.load(f)
# Guard: requiring space tokens without the verifying key would brick every space write.
if not cfg.get('space_write_issuer_public_keys'):
    raise SystemExit('space_write_issuer_public_keys is empty — the organizer did not surface spaceWritePubKey (is STIQ_TOKEN_DOMAIN_SEP=1?). Refusing to require space tokens with no key to verify them.')
cfg['space_tokens_required'] = True
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
  secure_relay_config
  systemctl restart stiq-relay.service
  sleep 1
  [[ "$(systemctl is-active stiq-relay.service || true)" == "active" ]] \
    || die "stiq-relay failed to restart with space_tokens_required on — check: journalctl -u stiq-relay -n 50"
  say "Space tokens verified: relay requires space_tokens on channel/group/DM content."
fi
fi  # end of the primary-only 9b-9d block (mirror mode: flags/keys came verbatim from the bundle)

# Relay loopback smoke test (WebSocket upgrade → 101).
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --include \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
  http://127.0.0.1:3334/ 2>/dev/null || echo 000)"
[[ "$HTTP_CODE" == "101" ]] && say "Relay smoke test PASS (101 Switching Protocols)." \
  || warn "Relay smoke test got HTTP ${HTTP_CODE} (may still be initializing)."

# Best-effort onion-defense postflight (T5): assert tor >=0.4.8, the equix pow module, tor
# --verify-config, and that the onion descriptor(s) published — a silent-downgrade detector that
# stands beside the EOL-tor apt-repo mitigation. Best-effort so a check hiccup never aborts a
# healthy deploy (mirrors the enrollment smoke test's warn-not-die convention).
if [[ -x "${REPO}/relay/deploy/tor_defense_check.sh" ]]; then
  bash "${REPO}/relay/deploy/tor_defense_check.sh" \
    || warn "onion defense check reported an issue (see above); the community is up but review PoW/IntroDoS."
fi

# Full enrollment smoke test — the WS-upgrade check above only proves the relay ACCEPTS a
# connection; it catches no key/PoW/domain-sep mismatch between the relay, organizer, and client. Run
# the repo's own fake-member verifier (issuer/verify_enroll.mjs, staged into ${ORG_DIR} in step 4)
# against a throwaway invite over the loopback relay: mint → blind → mailbox blind-sign → unblind →
# verify → kind-9011 bind. This is the same path a real member's phone takes, so a broken issuer key,
# wrong enroll_pow, or (with TOKEN_DOMAIN_SEP=1) an unwired posting key surfaces HERE, not on someone
# else's phone. Best-effort: verify_enroll.mjs missing, or the check failing, WARNS — it never aborts
# the whole deploy, since the relay/organizer are already up and a manual retry is always possible.
if [[ -n "$ATTACH_BUNDLE" ]]; then
  say "Mirror mode — skipping the enrollment smoke test (enrollment happens at the PRIMARY's organizer; a mirror only stores/forwards)."
elif true; then
say "Running a full enrollment smoke test (mints + spends a throwaway invite end-to-end)..."
if [[ -f "${ORG_DIR}/verify_enroll.mjs" ]]; then
  SMOKE_OK=0
  COOKIE_JAR="$(mktemp)"
  if [[ -n "$ORG_PASSWORD" ]]; then
    curl -fsS -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
      -d "{\"password\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ORG_PASSWORD")}" \
      "http://127.0.0.1:${DASH_PORT}/api/login" >/dev/null 2>&1 \
      || warn "enrollment smoke test: could not log in to the organizer dashboard API."
  fi
  INVITE_JSON="$(curl -fsS -b "$COOKIE_JAR" -X POST "http://127.0.0.1:${DASH_PORT}/api/invite" 2>/dev/null || true)"
  INVITE_CODE="$(python3 -c "
import json,sys
try: print(json.loads(sys.argv[1]).get('code',''))
except Exception: pass
" "$INVITE_JSON" 2>/dev/null || true)"
  if [[ -n "$INVITE_CODE" ]]; then
    VERIFY_LOG="$(mktemp)"
    if ( cd "$ORG_DIR" && RELAY_WS="ws://127.0.0.1:3334" STIQ_ENROLL_POW="$ENROLL_POW" \
         node verify_enroll.mjs "$INVITE_CODE" >"$VERIFY_LOG" 2>&1 ); then
      grep -q 'unblinded credential valid: true' "$VERIFY_LOG" && SMOKE_OK=1
    fi
    [[ "$SMOKE_OK" == "1" ]] || { warn "enrollment smoke test output:"; sed 's/^/    /' "$VERIFY_LOG" >&2; }
    rm -f "$VERIFY_LOG"
  else
    warn "enrollment smoke test: could not mint a throwaway invite via the organizer API (${INVITE_JSON:-<empty response>})."
  fi
  # Clean up the throwaway invite so re-runs don't accumulate 'used' invites in the dashboard audit
  # view. (The throwaway bound member left in the relay membership store has no simple removal API —
  # a known minor artifact tracked as a follow-up.)
  if [[ -n "$INVITE_CODE" ]]; then
    curl -fsS -b "$COOKIE_JAR" -X DELETE "http://127.0.0.1:${DASH_PORT}/api/invite/${INVITE_CODE}" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_JAR"
  if [[ "$SMOKE_OK" == "1" ]]; then
    say "Enrollment smoke test PASS (throwaway invite drawn, blind-signed, unblinded, and bound)."
  else
    warn "Enrollment smoke test did NOT pass — a real member enroll may be broken (issuer-key / enroll_pow / domain-sep mismatch?). Retry manually: (cd ${ORG_DIR} && RELAY_WS=ws://127.0.0.1:3334 node verify_enroll.mjs <invite-code>)"
  fi
else
  warn "verify_enroll.mjs not found at ${ORG_DIR} — skipping the full enrollment smoke test (only the WS-upgrade check above ran)."
fi
fi  # end of the primary-only enrollment smoke test

# --- Push stack smoke (T1) — only when PUSH_WATCHER=1 --------------------------------------------
# Best-effort loopback checks (warn-not-die, matching the enrollment smoke convention): ntfy is
# healthy, the watcher's register API accepts a well-formed registration (204), and a direct wake
# POST to a throwaway ntfy topic is accepted (2xx). The FULL relay→watcher→ntfy chain (publish a
# synthetic kind-1059 → watcher matches #p → ntfy wake) needs a signed Nostr event, so it is left to
# the dedicated harness (relay/deploy/push_smoke.sh, which delegates to issuer/verify_push.mjs when
# present). We invoke that harness here too when available.
if [[ "$PUSH_WATCHER" == "1" ]]; then
  say "Running push-stack smoke checks (ntfy health, watcher register, wake)..."

  NTFY_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${NTFY_PORT}/v1/health" 2>/dev/null || echo 000)"
  [[ "$NTFY_HEALTH" == "200" ]] && say "  ntfy health PASS (200)." \
    || warn "  ntfy health got HTTP ${NTFY_HEALTH} (check: journalctl -u ntfy -n 50)."

  # Well-formed registration: a 64-hex p: key + a random topic + a 1-hour TTL → expect 204.
  SMOKE_TOPIC="stiqsmoke$(openssl rand -hex 8)"
  SMOKE_PHEX="$(openssl rand -hex 32)"
  SMOKE_EXP="$(( $(date +%s) + 3600 ))"
  REG_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"v\":1,\"topic\":\"${SMOKE_TOPIC}\",\"keys\":[\"p:${SMOKE_PHEX}\"],\"exp\":${SMOKE_EXP}}" \
    "http://127.0.0.1:${WATCHER_PORT}/push/register" 2>/dev/null || echo 000)"
  [[ "$REG_CODE" == "204" ]] && say "  watcher register PASS (204)." \
    || warn "  watcher register got HTTP ${REG_CODE} (check: journalctl -u stiq-pushwatcher -n 50)."

  # Direct content-free wake to the throwaway topic → any 2xx.
  WAKE_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Priority: min' \
    "http://127.0.0.1:${NTFY_PORT}/${SMOKE_TOPIC}" 2>/dev/null || echo 000)"
  [[ "$WAKE_CODE" =~ ^2[0-9][0-9]$ ]] && say "  ntfy wake PASS (${WAKE_CODE})." \
    || warn "  ntfy wake got HTTP ${WAKE_CODE} (check: journalctl -u ntfy -n 50)."

  # Best-effort unregister so the throwaway topic doesn't linger in the watcher registry.
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
    -d "{\"topic\":\"${SMOKE_TOPIC}\"}" "http://127.0.0.1:${WATCHER_PORT}/push/unregister" 2>/dev/null || true

  # Full end-to-end chain via the dedicated harness (delegates to issuer/verify_push.mjs when present).
  if [[ -f "${REPO}/relay/deploy/push_smoke.sh" ]]; then
    WATCHER_URL="http://127.0.0.1:${WATCHER_PORT}" NTFY_BASE="http://127.0.0.1:${NTFY_PORT}" \
    RELAY_WS="ws://127.0.0.1:3334" REPO="${REPO}" \
      bash "${REPO}/relay/deploy/push_smoke.sh" \
      || warn "  end-to-end push smoke (relay→watcher→ntfy) did not pass — see above; the loopback legs above still isolate the failing hop."
  fi
fi

# ---------------------------------------------------------------------------
# 12b. Optional vanguards addon (layer-3 guard selection + Rendguard/Bandguards), only when
#      STIQ_VANGUARDS=1 AND RELAY_SINGLE_ONION=0. Step 8 already wrote stiq-controlport.conf
#      (ControlPort unix:/var/run/tor/control + CookieAuthentication 1) under exactly that same
#      condition, so the addon here only needs the `vanguards` package + its systemd unit.
#      WARN-but-continue on every failure — this is a defense-in-depth extra on top of tor's
#      built-in vanguards-lite, never a blocker.
#      Under RELAY_SINGLE_ONION=1 (the default), vanguards defends a 3-hop rendezvous path that
#      single-onion mode removes entirely — there is nothing left for it to protect on this
#      instance — so skip installing it, and stop/disable a copy a prior --no-single-onion run may
#      have left running (idempotent either way).
# ---------------------------------------------------------------------------
if [[ "$RELAY_SINGLE_ONION" == "1" ]]; then
  if systemctl is-enabled --quiet stiq-vanguards 2>/dev/null || systemctl is-active --quiet stiq-vanguards 2>/dev/null; then
    systemctl disable --now stiq-vanguards >/dev/null 2>&1 \
      && say "  vanguards addon disabled (single-onion mode removes the 3-hop guard path it defends)."
  fi
  [[ "$STIQ_VANGUARDS" == "1" ]] && warn "STIQ_VANGUARDS=1 is ignored under RELAY_SINGLE_ONION=1 (see step 8's stiq-base.conf comment) — pass --no-single-onion to use vanguards."
elif [[ "$STIQ_VANGUARDS" == "1" ]]; then
  say "Installing the optional vanguards addon (STIQ_VANGUARDS=1)..."
  if pip3 install --break-system-packages --quiet vanguards; then
    install -m 0644 "${REPO}/relay/deploy/stiq-vanguards.service" /etc/systemd/system/stiq-vanguards.service
    systemctl daemon-reload
    systemctl enable --now stiq-vanguards \
      || warn "stiq-vanguards failed to start — check: journalctl -u stiq-vanguards -n 50"
  else
    warn "pip3 install vanguards failed (network/package index?) — skipping the vanguards addon; tor's built-in vanguards-lite is still active."
  fi
fi

# ---------------------------------------------------------------------------
# 13-mirror. Attach-mode summary — the mirror is up; the remaining steps (authorize + publish the
# mirror list) happen on the PRIMARY box, so print them copy-paste ready and exit before the
# community summary below (join codes, dashboard card — none of which exist here).
# ---------------------------------------------------------------------------
if [[ -n "$ATTACH_BUNDLE" ]]; then
  ATTACH_PRIMARY_ONION="$(STIQ_MB_BUNDLE="$ATTACH_BUNDLE" python3 -c \
    "import json,os; print((json.load(open(os.environ['STIQ_MB_BUNDLE'])).get('primary_onion') or '').strip())" 2>/dev/null || true)"
  ATTACH_COMMUNITY="$(STIQ_MB_BUNDLE="$ATTACH_BUNDLE" python3 -c \
    "import json,os; print((json.load(open(os.environ['STIQ_MB_BUNDLE'])).get('community') or '').strip())" 2>/dev/null || true)"
  echo
  say "Blind mirror relay is UP."
  echo "    community    : ${ATTACH_COMMUNITY:-<unknown>} (primary: ${ATTACH_PRIMARY_ONION:-<unknown>})"
  echo "    mirror onion : ${RELAY_ONION_WS}"
  echo "    members-only : $([[ "$RELAY_ONION_AUTH" == "1" ]] && echo "ENFORCED (same shared reach key as the primary — members' existing join codes work)" || echo "off (public onion, following the primary)")"
  echo "    blind by construction: this box holds ONLY public verification keys. No issuer key, no"
  echo "    organizer key, no content-epoch keys — wherever the community seals bodies, this disk"
  echo "    stores ciphertext it has no means to decrypt."
  echo
  say "Finish on the PRIMARY box (authorize + announce this mirror to the fleet):"
  if [[ "$RELAY_ONION_AUTH" == "1" ]]; then
    echo "    cd /opt/stiq/organizer && ./stiq-org mirror-add ${RELAY_ONION_WS} ${RELAY_AUTH_PRIV_B32}"
  else
    echo "    cd /opt/stiq/organizer && ./stiq-org mirror-add ${RELAY_ONION_WS}"
  fi
  echo "    cd /opt/stiq/organizer && ./stiq-org mirrors-publish"
  echo
  echo "    Clients adopt the organizer-signed stiq:mirrors list automatically (additive, cap 5);"
  echo "    write fan-out, cross-mirror reconciliation, and withholding failover activate on their own."
  echo "    Keep the mirror's enforcement in lock-step with the primary: after any fleet-coordinated"
  echo "    flip there (content encryption, space tokens, ...), re-run --export-mirror-bundle on the"
  echo "    primary and --attach here with the fresh bundle."
  [[ -f "$ATTACH_BUNDLE" ]] && warn "Delete the bundle file (${ATTACH_BUNDLE}) now that the attach is complete — it carries the shared community reach key."
  exit 0
fi

# ---------------------------------------------------------------------------
# 13. Summary (+ persist the dashboard access card when the onion is enabled)
# ---------------------------------------------------------------------------
HOSTHINT="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"; HOSTHINT="${HOSTHINT:-<this-server>}"

if [[ "$DASHBOARD_ONION" == "1" ]]; then
  DASH_NAME="${DASH_ONION%.onion}"   # 56-char address without the .onion suffix
  ACCESS_CARD="$(cat <<CARD
STIQ dashboard — remote access card  (community: ${COMMUNITY_NAME})
KEEP THIS PRIVATE. Anyone with all three lines below controls the community.

  1) Address (open in Tor Browser):
       http://${DASH_ONION}

  2) Client-authorization key — Tor Browser will prompt for it on first visit;
     paste exactly this base32 private key:
       ${DASH_PRIV_B32}

     (For a tor daemon / Tails instead of Tor Browser, drop a file
      <name>.auth_private into your ClientOnionAuthDir containing:)
       ${DASH_NAME}:descriptor:x25519:${DASH_PRIV_B32}

  3) Dashboard login password:
       ${ORG_PASSWORD}
CARD
)"
  printf '%s\n' "$ACCESS_CARD" > "${AUTH_DIR}/ACCESS.txt"
  chown stiq:stiq "${AUTH_DIR}/ACCESS.txt"; chmod 600 "${AUTH_DIR}/ACCESS.txt"
  DASH_SECTION="$(cat <<SEC
 ── Open the dashboard from anywhere (Tor Browser) ───────────────────
   It is fronted by its OWN onion, gated by client authorization + a
   password. No SSH, no clearnet. From any device with Tor Browser:

     address  : http://${DASH_ONION}
     auth key : ${DASH_PRIV_B32}
                (paste when Tor Browser prompts on first visit)
     password : ${ORG_PASSWORD}

   This access card is also saved (root-only) at:
     ${AUTH_DIR}/ACCESS.txt
   To revoke a lost key: delete ${DASH_HS_DIR}/authorized_clients/*.auth
   and re-run this installer (mints a fresh key).

   Mint a join code in the dashboard and share it with your first members.

 ── Security model (by design) ───────────────────────────────────────
   The dashboard stays CO-LOCATED on the relay box with no clearnet. The
   onion's client authorization means only someone holding the auth key
   above can even reach it, and the dashboard wields the issuer + organizer
   keys — so granting access == granting the community. There is still no
   "read-only" or partial admin surface, by design.
SEC
)"
else
  DASH_SECTION="$(cat <<SEC
 ── Open the dashboard ───────────────────────────────────────────────
   It is loopback-only (DASHBOARD_ONION=0). From your laptop:

       ssh -L ${DASH_PORT}:127.0.0.1:${DASH_PORT} root@${HOSTHINT}
       # then browse to  http://localhost:${DASH_PORT}

   Mint a join code there and share it with your first members.

 ── Security model (by design) ───────────────────────────────────────
   The dashboard lives on THIS relay box and is reachable only over SSH.
   Anyone who can open it already has shell here — which means the issuer
   key, organizer key, and onion key. Dashboard access == full community
   compromise. No remote/limited admin surface, on purpose.
SEC
)"
fi

# Optional trailing sections (empty unless the corresponding mode was on this run).
PUSH_SECTION=""
if [[ "$PUSH_WATCHER" == "1" ]]; then
  PUSH_SECTION="$(cat <<SEC

 ── Real push over Tor (PUSH_WATCHER=1) ──────────────────────────────
   ntfy         : 127.0.0.1:${NTFY_PORT}  →  ${ONION}:${NTFY_PORT} (onion, loopback-bound)
   pushwatcher  : 127.0.0.1:${WATCHER_PORT}  →  ${ONION}:${WATCHER_PORT} (keyless, holds no keys)
   NIP-11 now advertises stiq-capabilities.push (watcher + ntfy onions). Members
   on an app build with PUSH_UNIFIEDPUSH=true begin registering for content-free
   wakes; everyone else stays on the unchanged WorkManager polling fallback.
   Runbook (on-device + verify): ${REPO}/relay/deploy/PUSH_RUNBOOK.md
SEC
)"
fi
VANGUARDS_SECTION=""
if [[ "$STIQ_VANGUARDS" == "1" && "$RELAY_SINGLE_ONION" != "1" ]]; then
  VANGUARDS_SECTION="$(cat <<SEC

 ── Vanguards addon (STIQ_VANGUARDS=1) ───────────────────────────────
   Layer-3 guard selection + Rendguard/Bandguards running against tor's
   UNIX control socket (/var/run/tor/control), on top of the built-in
   vanguards-lite. Status:  systemctl status stiq-vanguards
SEC
)"
elif [[ "$STIQ_VANGUARDS" == "1" ]]; then
  VANGUARDS_SECTION="$(cat <<SEC

 ── Vanguards addon (STIQ_VANGUARDS=1, SKIPPED) ──────────────────────
   RELAY_SINGLE_ONION=1 removes the 3-hop rendezvous path vanguards
   defends, so it was not installed. Re-run with --no-single-onion to
   use it.
SEC
)"
fi
SINGLE_ONION_SECTION=""
if [[ "$RELAY_SINGLE_ONION" == "1" ]]; then
  SINGLE_ONION_SECTION="$(cat <<SEC

 ── Single-onion mode (RELAY_SINGLE_ONION=1, default) ────────────────
   Every onion on this box (relay + dashboard$( [[ "$PRESERVE_SSH" == "1" ]] && printf ' + SSH-recovery') ) runs
   single-hop server-side (SocksPort 0, HiddenServiceNonAnonymousMode 1,
   HiddenServiceSingleHopMode 1) for faster rendezvous. Client reach is
   unaffected — this only trims the server's own path. Rollback:
       sudo bash deploy/stiq-up.sh --no-single-onion
   Safe-Browsing SOCKS: $( [[ "$SAFE_BROWSING_CONFIGURED" == "1" ]] && printf 'tor@%s (client-only, provisioned above)' "$TOR_CLIENT_INSTANCE" || printf 'not needed (Safe-Browsing not configured)' )
SEC
)"
fi
RESTORE_SECTION=""
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  RESTORE_SECTION="$(cat <<SEC

 ── Restored from archive ────────────────────────────────────────────
   This box adopted the issuer/organizer/community keys + relay config +
   membership state from:  ${RESTORE_ARCHIVE}
   The .onion above is FRESH (the onion key is not archived) — reissue your
   join/community codes. Re-seed roster+limits+storage once:
       (cd ${ORG_DIR} && RELAY_WS=ws://127.0.0.1:3334 node publish-config.mjs)
SEC
)"
fi

cat <<SUMMARY

======================================================================
 ✅  STIQ community "${COMMUNITY_NAME}" is live.

   relay .onion : ${ONION}
   relay        : ${RELAY_BIN}  (127.0.0.1:3334, Tor-only, zero-logging)
   organizer    : ${ORG_DIR}    (dashboard on 127.0.0.1:${DASH_PORT})
   onion key    : ${TOR_HS_DIR}/hs_ed25519_secret_key
   issuer key   : ${ISSUER_PEM}
   organizer key: ${ORG_DIR}/organizer_nostr.json

${DASH_SECTION}${PUSH_SECTION}${SINGLE_ONION_SECTION}${VANGUARDS_SECTION}${RESTORE_SECTION}

 ── Recommended next steps ───────────────────────────────────────────
   • Harden SSH: PermitRootLogin prohibit-password, PasswordAuthentication no
   • Lock the firewall:  sudo bash ${REPO}/relay/deploy/firewall-nftables.sh
   • Status:  systemctl status stiq.target
======================================================================
SUMMARY

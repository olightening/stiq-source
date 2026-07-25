#!/usr/bin/env bash
# server-setup.sh — one-shot deploy of stiq-relay on a fresh Ubuntu 22.04 ECS instance.
#
# Pre-conditions (run from root's home dir on the server):
#   ~/stiq-relay          — compiled relay binary (CGO_ENABLED=0 GOOS=linux GOARCH=amd64)
#   ~/issuer_public.pem   — RSA public key (openssl rsa -in private.pem -pubout)
#
# This script MUST be run as root.  After it completes:
#   - stiq-relay is running on 127.0.0.1:3334, reachable only via Tor
#   - the Tor hidden service maps onion:80 → 127.0.0.1:3334
#   - ~/issuer_public.pem is removed
#
# If the server previously ran nostr-rs-relay, it is stopped and disabled first.
# The existing Tor onion keys (/var/lib/tor/stiq-relay/) are PRESERVED; only the
# HiddenServicePort mapping is updated (8080 → 3334).
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Sanity checks
# ---------------------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

RELAY_BIN="${HOME}/stiq-relay"
ISSUER_PEM="${HOME}/issuer_public.pem"

for f in "$RELAY_BIN" "$ISSUER_PEM"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: required file not found: $f" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 1. Stop any previously running relay
# ---------------------------------------------------------------------------
echo "==> Stopping old relay (if any)..."
for svc in nostr-rs-relay stiq-relay; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    systemctl stop "$svc"
    echo "    stopped $svc"
  fi
  if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    systemctl disable "$svc"
    echo "    disabled $svc"
  fi
done

# Kill any process still listening on port 3334 or 8080 (graceful approach)
for port in 3334 8080; do
  pid=$(ss -tlnp "sport = :$port" 2>/dev/null | awk 'NR>1 {match($0,/pid=([0-9]+)/,a); if(a[1]) print a[1]}' | head -1)
  if [[ -n "$pid" ]]; then
    echo "    killing pid $pid on port $port"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
  fi
done

# ---------------------------------------------------------------------------
# 2. Create unprivileged user and directories
# ---------------------------------------------------------------------------
echo "==> Creating stiq user and directories..."
if ! id -u stiq &>/dev/null; then
  useradd --system --home /var/lib/stiq-relay --shell /usr/sbin/nologin stiq
fi
mkdir -p /var/lib/stiq-relay /etc/stiq-relay

# ---------------------------------------------------------------------------
# 3. Install relay binary
# ---------------------------------------------------------------------------
echo "==> Installing stiq-relay binary..."
install -o stiq -g stiq -m 0755 "$RELAY_BIN" /usr/local/bin/stiq-relay

# ---------------------------------------------------------------------------
# 4. Build config.json — embed the issuer public key as a PEM string
# ---------------------------------------------------------------------------
echo "==> Writing /etc/stiq-relay/config.json..."

# python3 ships on every Ubuntu 22.04 and handles the JSON string escaping correctly.
PEM_JSON=$(python3 - <<'PYEOF'
import sys, json
with open('/root/issuer_public.pem', 'r') as f:
    pem = f.read()
# json.dumps encodes newlines as \n, which is what Go's pem.Decode expects.
print(json.dumps(pem))
PYEOF
)

# NOTE: allowed_kinds is intentionally OMITTED so the relay uses config.DefaultAllowedKinds — the
# single source of truth for every kind the app publishes (posts, votes, comments, polls, voice,
# channels, groups, NIP-78 app data, private-space key delivery, …). Hardcoding a partial list here
# once left fresh deploys silently rejecting most of the app's events; don't reintroduce it. To
# restrict kinds for a specific deployment, add an explicit "allowed_kinds": [...] below.
cat > /etc/stiq-relay/config.json <<JSONEOF
{
  "listen": "127.0.0.1:3334",
  "issuer_public_keys": [
    ${PEM_JSON}
  ],
  "data_dir": "/var/lib/stiq-relay/data",
  "membership_file": "/var/lib/stiq-relay/membership.json",
  "pow_difficulty": 20,
  "enroll_pow": 12
}
JSONEOF
# NOTE: enroll_pow is set explicitly (12) to match the shipped client's ENROLL_POW_DIFFICULTY and
# the organizer's mailbox mining difficulty. enroll_pow falls back to pow_difficulty (20) when
# omitted, which the shipped app never mines -- leaving it out silently breaks every enrollment.

chown stiq:stiq /etc/stiq-relay/config.json
chmod 600 /etc/stiq-relay/config.json

# Verify the key parsed by doing a quick Go config check via the binary's --help-check,
# but since we don't have that flag, just check the JSON is valid.
if ! python3 -c "import json; json.load(open('/etc/stiq-relay/config.json'))" 2>&1; then
  echo "ERROR: generated config.json is not valid JSON" >&2
  cat /etc/stiq-relay/config.json >&2
  exit 1
fi
echo "    config.json written and valid."

# ---------------------------------------------------------------------------
# 5. Install systemd unit
# ---------------------------------------------------------------------------
echo "==> Installing stiq-relay.service..."

# The canonical unit file is relay/deploy/stiq-relay.service — the SAME one deploy/stiq-up.sh
# installs. Prefer a copy staged at /tmp (older deploy tooling SCP'd it there); otherwise take
# it from this checkout, so the script is self-contained.
# NOTE: MemoryDenyWriteExecute is intentionally ABSENT from the canonical unit: newer Go
# runtime (1.21+) uses W+X memory mappings for goroutine stacks, which this flag blocks
# (causes SIGBUS/SIGSEGV at startup). Do not add it back here.
UNIT_SRC=""
if [[ -f /tmp/stiq-relay.service ]]; then
  UNIT_SRC=/tmp/stiq-relay.service
elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/stiq-relay.service" ]]; then
  UNIT_SRC="$(dirname "${BASH_SOURCE[0]}")/stiq-relay.service"
else
  echo "ERROR: stiq-relay.service not found at /tmp/ or beside this script." >&2
  exit 1
fi
echo "    unit source: ${UNIT_SRC}"
install -m 0644 "${UNIT_SRC}" /etc/systemd/system/stiq-relay.service

systemctl daemon-reload

# ---------------------------------------------------------------------------
# 6. Update Tor hidden-service config
# ---------------------------------------------------------------------------
echo "==> Updating Tor config..."

TORRC=/etc/tor/torrc
TORRC_BAK="${TORRC}.bak.$(date +%s)"

# Back up the existing torrc before touching it.
cp "$TORRC" "$TORRC_BAK"
echo "    backed up $TORRC → $TORRC_BAK"

# Build and install the stiq torrc as an include file so we don't clobber the
# system torrc (which may have other settings).  The HiddenServiceDir is the same
# as before (/var/lib/tor/stiq-relay/), so existing onion keys are preserved.
STIQ_TORRC=/etc/tor/torrc.d/stiq-relay.conf
mkdir -p /etc/tor/torrc.d
chmod 755 /etc/tor/torrc.d

# tor_has_pow_module() — HiddenServicePoWDefensesEnabled needs a tor built with the equix 'pow'
# module; a tor without it refuses to start. The PoW lines are appended to this drop-in in step 6c
# BELOW (after step 6b upgrades tor from the Tor Project repo), so the probe sees the CURRENT tor,
# not the possibly-EOL distro tor present at this point.
tor_has_pow_module() { tor --list-modules 2>/dev/null | grep -qiE '^pow:[[:space:]]*yes'; }

cat > "$STIQ_TORRC" <<'TORCEOF'
# stiq-relay hidden service — managed by server-setup.sh
# onion:80 → stiq-relay loopback listener
HiddenServiceDir /var/lib/tor/stiq-relay/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:3334
HiddenServiceNumIntroductionPoints 5

# Intro-point DoS defenses
HiddenServiceEnableIntroDoSDefense 1
HiddenServiceEnableIntroDoSRatePerSec 25
HiddenServiceEnableIntroDoSBurstPerSec 200
TORCEOF

chown -R debian-tor:debian-tor /etc/tor/torrc.d 2>/dev/null || \
  chown -R tor:tor /etc/tor/torrc.d 2>/dev/null || true
chmod 644 "$STIQ_TORRC"

# If the main torrc still has an old HiddenService block pointing at 8080, remove it
# (prefer sed over a rewrite to preserve all other settings).
if grep -q 'HiddenServicePort.*8080' "$TORRC" 2>/dev/null; then
  echo "    removing old HiddenServicePort 8080 lines from $TORRC..."
  # Remove the HiddenServiceDir + HiddenServicePort block for the old entry
  sed -i '/HiddenServiceDir.*stiq-relay/,/^$/d' "$TORRC" || true
  sed -i '/HiddenServicePort.*8080/d' "$TORRC" || true
fi

# Ensure %include is present in the main torrc so our drop-in is loaded.
if ! grep -q '%include /etc/tor/torrc.d/' "$TORRC" 2>/dev/null; then
  echo '%include /etc/tor/torrc.d/*.conf' >> "$TORRC"
fi

# ---------------------------------------------------------------------------
# 6b. Ensure a CURRENT tor via the official Tor Project apt repo
# ---------------------------------------------------------------------------
# WHY: the tor shipped in Ubuntu 22.04 (jammy) is 0.4.6.10 — END-OF-LIFE since ~2023. Its built-in
# directory-authority keys are too old to validate today's Tor consensus (a dir-auth set change in
# early July invalidated them), so tor wedges at "Bootstrapped 30% (Loading networkstatus consensus)"
# with "Consensus not signed by sufficient number of requested authorities", never builds a circuit,
# and never publishes the onion descriptor — the multi-day onion outage this box just recovered from.
# The distro repo has NOTHING newer, so adding the Tor Project apt repo is mandatory to get a current
# tor (0.4.9.x bootstraps to 100% in ~6s); it also lets unattended-upgrades (step 7) keep tor current.
# Idempotent: re-running overwrites the keyring + tor.list (no duplicate sources lines) and re-runs
# apt-get install to UPGRADE a wedged EOL tor already on the box. Non-fatal: every fallible step is
# guarded so a transient curl can't abort provisioning under `set -e`; on failure we WARN and continue.
echo "==> Ensuring a current tor (official Tor Project apt repo)..."
export DEBIAN_FRONTEND=noninteractive
TOR_KEYRING="/usr/share/keyrings/deb.torproject.org-keyring.gpg"
TOR_CODENAME="$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_CODENAME:-}")"
if [[ -z "$TOR_CODENAME" ]]; then
  echo "    WARNING: could not read VERSION_CODENAME from /etc/os-release; defaulting to 'jammy'." >&2
  TOR_CODENAME="jammy"
fi
# Make sure the tools to fetch/dearmor the key are present (curl, gnupg, ca-certificates).
apt-get install -y -q curl gnupg ca-certificates >/dev/null 2>&1 || \
  echo "    WARNING: could not ensure curl/gnupg are installed." >&2
if install -m 0755 -d /usr/share/keyrings 2>/dev/null \
   && curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc -o /tmp/tor.asc 2>/dev/null \
   && gpg --dearmor < /tmp/tor.asc > "${TOR_KEYRING}.tmp" 2>/dev/null; then
  mv -f "${TOR_KEYRING}.tmp" "$TOR_KEYRING"
  chmod 0644 "$TOR_KEYRING"
  echo "deb [signed-by=${TOR_KEYRING}] https://deb.torproject.org/torproject.org ${TOR_CODENAME} main" \
    > /etc/apt/sources.list.d/tor.list
  echo "    Tor Project repo configured (${TOR_CODENAME}); updating apt and installing/upgrading tor..."
  apt-get update -qq || echo "    WARNING: apt-get update failed; tor may not upgrade this run." >&2
  if apt-get install -y -q tor deb.torproject.org-keyring; then
    echo "    tor is current: $(tor --version 2>/dev/null | head -1)"
  else
    echo "    WARNING: apt-get install tor failed; the existing tor (possibly EOL) is unchanged." >&2
  fi
else
  rm -f "${TOR_KEYRING}.tmp"
  echo "    WARNING: could not configure the Tor Project apt repo (network?). Continuing with the" >&2
  echo "             existing distro tor — on Ubuntu 22.04 that is the END-OF-LIFE 0.4.6.10, which" >&2
  echo "             cannot validate the current consensus and will wedge the onion at 30%. Add the" >&2
  echo "             repo and re-run once network is reachable." >&2
fi
rm -f /tmp/tor.asc

# ---------------------------------------------------------------------------
# 6c. Onion-service PoW defenses (gated on the now-current tor's equix module)
# ---------------------------------------------------------------------------
# Runs AFTER 6b upgraded tor, so tor_has_pow_module() reflects the CURRENT build. Append the three
# HiddenServicePoW* lines to the relay drop-in only when the module is present; otherwise the onion
# keeps IntroDoS-only defenses and still publishes. Queue params match relay/deploy/torrc and
# deploy/stiq-up.sh (single source of truth: 250 / 2500). STIQ_RELAY_POW_DEFENSE=0 forces off.
RELAY_POW_DEFENSE="${STIQ_RELAY_POW_DEFENSE:-1}"
if [[ "$RELAY_POW_DEFENSE" == "1" ]] && tor_has_pow_module; then
  echo "    onion PoW defense: ENABLED (equix pow module present)."
  printf '%s' $'HiddenServicePoWDefensesEnabled 1\nHiddenServicePoWQueueRate 250\nHiddenServicePoWQueueBurst 2500\n' >> "$STIQ_TORRC"
elif [[ "$RELAY_POW_DEFENSE" == "1" ]]; then
  echo "    WARNING: tor lacks the equix 'pow' module; onion runs IntroDoS-only. Ensure tor came from the Tor Project apt repo." >&2
fi

# ---------------------------------------------------------------------------
# 7. Enable automatic security updates
# ---------------------------------------------------------------------------
echo "==> Enabling unattended-upgrades..."
if ! dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii'; then
  apt-get install -y -q unattended-upgrades
fi
# Non-interactive enable (equivalent to dpkg-reconfigure -plow)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APTEOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APTEOF

# The stock unattended-upgrades allow-list only covers Ubuntu-origin pockets, so tor from the Tor
# Project repo (Origin: TorProject; configured in step 6b) would NEVER be auto-upgraded — letting it
# silently EOL again into the consensus-wedge outage. Allow that origin so tor stays current on its
# own. Idempotent overwrite; `::` appends to the existing Origins-Pattern list without replacing it.
cat > /etc/apt/apt.conf.d/51unattended-upgrades-tor <<'APTEOF'
Unattended-Upgrade::Origins-Pattern:: "origin=TorProject";
APTEOF

# ---------------------------------------------------------------------------
# 8. Restart Tor and start relay
# ---------------------------------------------------------------------------
echo "==> Restarting Tor..."
# Fail-safe: if the drop-in doesn't validate (e.g. a tor without the equix pow module despite the
# probe), strip the HiddenServicePoW* lines and re-verify so tor still starts and the onion still
# publishes rather than wedging on an unstartable config.
if ! tor --verify-config >/dev/null 2>&1; then
  echo "    WARNING: tor --verify-config failed after writing onion defenses; stripping HiddenServicePoW* lines and re-verifying." >&2
  sed -i '/^HiddenServicePoW/d' "$STIQ_TORRC" 2>/dev/null || true
  tor --verify-config >/dev/null 2>&1 || echo "    WARNING: tor --verify-config still failing after stripping PoW — check /etc/tor/torrc.d." >&2
fi
systemctl restart tor
sleep 3

# Confirm hidden service is up
if [[ -f /var/lib/tor/stiq-relay/hostname ]]; then
  ONION=$(cat /var/lib/tor/stiq-relay/hostname)
  echo "    .onion address: $ONION"
else
  echo "    WARNING: hostname file not found yet — Tor may still be bootstrapping."
  echo "    Run: sudo cat /var/lib/tor/stiq-relay/hostname"
fi

echo "==> Starting stiq-relay..."
systemctl enable --now stiq-relay

sleep 2
if systemctl is-active --quiet stiq-relay; then
  echo "    stiq-relay is running."
else
  echo "ERROR: stiq-relay failed to start. Check: journalctl -u stiq-relay --no-pager -n 50" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 9. Quick smoke test — relay must respond on loopback
# ---------------------------------------------------------------------------
echo "==> Smoke test: WebSocket upgrade on 127.0.0.1:3334..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --include \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "http://127.0.0.1:3334/" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "101" ]]; then
  echo "    PASS — relay returned 101 Switching Protocols."
else
  echo "    WARN — expected HTTP 101, got: $HTTP_CODE"
  echo "    The relay may still be initializing; retry manually:"
  echo "      curl -v -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\"
  echo "           -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \\"
  echo "           -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:3334/"
fi

# ---------------------------------------------------------------------------
# 10. Clean up — CRITICAL: remove the PEM file
# ---------------------------------------------------------------------------
echo "==> Removing issuer_public.pem from server..."
rm -f "$ISSUER_PEM"
echo "    DONE. issuer_public.pem removed."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================================================"
echo " stiq-relay deployed successfully."
echo ""
echo " Next steps:"
echo "   1. Verify relay is loopback-only:  ss -ltnp | grep stiq-relay"
echo "   2. Lock firewall:  sudo ./firewall-nftables.sh"
echo "   3. End-to-end Tor test (from a machine with torsocks + websocat):"
echo "      torsocks websocat ws://${ONION:-<onion-from-hostname>}"
echo "   4. SSH hardening (separate — don't lock yourself out):"
echo "      Set PermitRootLogin no, PasswordAuthentication no in sshd_config"
echo "      Test in a second session before closing this one."
echo "======================================================================"

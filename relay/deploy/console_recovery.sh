#!/usr/bin/env bash
# Paste this ENTIRE script into the Alibaba Cloud ECS VNC/serial console after logging
# in as root with password <see ops vault for the CURRENT console password>.
#
# What it does:
#   1. Shows relay + Tor status (are they running?)
#   2. Restarts them if they are down
#   3. Verifies the relay is listening on 127.0.0.1:3334
#   4. Shows the relay onion address
#   5. Adds SSH as a Tor v3 hidden service for permanent future access
#   6. Prints the SSH onion address to save
set -euo pipefail

echo ""
echo "════════════════════════════════════════════"
echo "  STIQ relay console recovery"
echo "════════════════════════════════════════════"
echo ""

# ── 1. Service status ──────────────────────────────────────────────────────
echo "=== stiq-relay status ==="
systemctl status stiq-relay --no-pager -l 2>&1 | head -25 || true

echo ""
echo "=== tor@default status ==="
systemctl status tor@default --no-pager 2>&1 | head -10 || true

# ── 2. Restart anything that is down ──────────────────────────────────────
echo ""
echo "=== Ensuring services are running ==="

if ! systemctl is-active --quiet stiq-relay; then
  echo "relay is down — restarting..."
  systemctl restart stiq-relay
  sleep 3
  systemctl is-active --quiet stiq-relay && echo "relay: OK" || echo "relay: STILL DOWN — check logs below"
  journalctl -u stiq-relay -n 20 --no-pager
else
  echo "relay: running"
fi

if ! systemctl is-active --quiet tor@default; then
  echo "tor is down — restarting..."
  systemctl restart tor@default
  sleep 5
  systemctl is-active --quiet tor@default && echo "tor: OK" || echo "tor: STILL DOWN"
  journalctl -u tor@default -n 20 --no-pager
else
  echo "tor: running"
fi

# ── 3. Relay listening check ───────────────────────────────────────────────
echo ""
echo "=== Relay port (should show 127.0.0.1:3334) ==="
ss -tlnp | grep 3334 || echo "WARNING: relay not listening on 3334"

# ── 4. Relay config (issuer key present?) ─────────────────────────────────
echo ""
echo "=== Relay config ==="
python3 -c "
import json, sys
cfg = json.load(open('/etc/stiq-relay/config.json'))
keys = cfg.get('issuer_public_keys', [])
cfg['issuer_public_keys'] = [k[:30]+'...' for k in keys]
print(json.dumps(cfg, indent=2))
print(f'issuer_public_keys count: {len(keys)}')
" 2>/dev/null || cat /etc/stiq-relay/config.json

# ── 5. Relay onion address ────────────────────────────────────────────────
echo ""
echo "=== Relay onion address ==="
cat /var/lib/tor/stiq-relay/hostname 2>/dev/null || echo "hidden service not yet generated"

# ── 6. Add SSH as a Tor hidden service ────────────────────────────────────
echo ""
echo "=== Adding SSH hidden service ==="

SSH_HS_DIR="/var/lib/tor/stiq-ssh"
TORRC_DROP="/etc/tor/torrc.d/stiq-relay.conf"

mkdir -p "$SSH_HS_DIR"
chown debian-tor:debian-tor "$SSH_HS_DIR"
chmod 700 "$SSH_HS_DIR"

if grep -q "stiq-ssh" "$TORRC_DROP" 2>/dev/null; then
  echo "SSH hidden service already configured."
else
  cat >> "$TORRC_DROP" <<'TOREOF'

# SSH management hidden service
HiddenServiceDir /var/lib/tor/stiq-ssh/
HiddenServiceVersion 3
HiddenServicePort 22 127.0.0.1:22
TOREOF
  echo "SSH hidden service added to torrc."
fi

systemctl reload tor@default 2>/dev/null || systemctl restart tor@default
sleep 6

# ── 7. Print SSH onion address ────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "  SSH onion address (SAVE THIS):"
cat "$SSH_HS_DIR/hostname" 2>/dev/null || (sleep 6; cat "$SSH_HS_DIR/hostname" 2>/dev/null || echo "ERROR: not yet generated — check tor logs")
echo ""
echo "  Connect from your local machine:"
echo "    torsocks ssh root@<above-onion>.onion -i ~/.ssh/<your-key>"
echo "════════════════════════════════════════════"
echo ""
echo "Done."

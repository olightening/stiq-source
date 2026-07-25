#!/usr/bin/env bash
# Paste this entire script into the Alibaba Cloud ECS VNC/serial console, then press Enter.
# It adds SSH as a Tor v3 hidden service so you can reach the server via:
#   torsocks ssh root@<onion>.onion -i ~/.ssh/<your-key>
#
# Run as root. Safe to run multiple times (idempotent).
set -euo pipefail

TORRC_DROP="/etc/tor/torrc.d/stiq-relay.conf"
SSH_HS_DIR="/var/lib/tor/stiq-ssh"

# 1. Create hidden service dir with correct ownership
mkdir -p "$SSH_HS_DIR"
chown debian-tor:debian-tor "$SSH_HS_DIR"
chmod 700 "$SSH_HS_DIR"

# 2. Add SSH hidden service block to the drop-in torrc (idempotent)
if grep -q "stiq-ssh" "$TORRC_DROP" 2>/dev/null; then
  echo "SSH hidden service already in torrc — skipping."
else
  cat >> "$TORRC_DROP" <<'EOF'

# SSH management hidden service (added by add_ssh_hidden_service.sh)
HiddenServiceDir /var/lib/tor/stiq-ssh/
HiddenServiceVersion 3
HiddenServicePort 22 127.0.0.1:22
EOF
  echo "SSH hidden service block added to $TORRC_DROP"
fi

# 3. Reload Tor to pick up the new hidden service
systemctl reload tor@default || systemctl restart tor@default
sleep 4

# 4. Print the SSH onion address
ONION_FILE="$SSH_HS_DIR/hostname"
if [[ -f "$ONION_FILE" ]]; then
  SSH_ONION=$(cat "$ONION_FILE")
  echo ""
  echo "=== SSH onion address ==="
  echo "$SSH_ONION"
  echo ""
  echo "Connect from your local machine (needs Tor running locally):"
  echo "  torsocks ssh root@$SSH_ONION -i ~/.ssh/<your-key>"
else
  echo "Waiting for Tor to generate hidden service keys..."
  sleep 8
  if [[ -f "$ONION_FILE" ]]; then
    echo "SSH onion: $(cat "$ONION_FILE")"
  else
    echo "ERROR: $ONION_FILE not created. Check: journalctl -u tor@default -n 30"
  fi
fi

# 5. Show relay + Tor status
echo ""
echo "=== Service status ==="
systemctl is-active stiq-relay tor@default
echo ""
echo "=== Relay port ==="
ss -tlnp | grep 3334 || echo "(relay not listening on 3334)"

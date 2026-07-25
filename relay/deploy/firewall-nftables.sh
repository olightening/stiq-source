#!/usr/bin/env bash
# Drop ALL inbound clearnet traffic (PLAN.md §3.1). The relay is reachable only via the
# Tor hidden service, which connects to it over loopback. Tor's own traffic to the network
# is OUTBOUND and remains allowed.
#
# Run as root:  sudo ./firewall-nftables.sh
set -euo pipefail

nft flush ruleset

nft add table inet filter

nft add chain inet filter input   '{ type filter hook input priority 0; policy drop; }'
nft add chain inet filter forward '{ type filter hook forward priority 0; policy drop; }'
nft add chain inet filter output  '{ type filter hook output priority 0; policy accept; }'

# Allow loopback (this is how Tor reaches the relay).
nft add rule inet filter input iif lo accept
# Allow return traffic for connections the box itself initiated (Tor -> network).
nft add rule inet filter input ct state established,related accept
# Everything else inbound is dropped by the chain policy above. No clearnet ingress.

echo "nftables loaded: inbound dropped except loopback + established. No clearnet ingress."
nft list ruleset

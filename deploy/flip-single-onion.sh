#!/bin/bash
# Flip this box to single-onion, then PROVE it worked — SINGLE_ONION.md Parts (b.1)-(b.4)
# in one run, against the REAL relay onion and the REAL community auth key.
#
#   sudo bash deploy/flip-single-onion.sh              # baseline -> flip -> verify -> latency
#   sudo bash deploy/flip-single-onion.sh --verify-only  # no flip; just measure + prove current state
#
# WHY THIS EXISTS INSTEAD OF `sudo bash deploy/stiq-up.sh`
# -------------------------------------------------------
# The runbook's Part (b.2) says to run the installer. That assumes a box the installer maintains.
# The current production box is NOT one: it has NO Go toolchain and NO git checkout (the relay is a
# cross-compiled binary, deployed by hand), and the only stiq-up.sh on its disk predates
# single-onion entirely. Running the full installer there would try to build the relay from source
# and rewrite config it does not own — a much bigger, riskier action than the flip itself.
#
# So this reproduces EXACTLY what the hardened stiq-up.sh step 8/8c does for the flip, in the same
# order, and nothing else. If you ARE on an installer-maintained box, prefer `sudo bash
# deploy/stiq-up.sh` — it does all of this plus everything else that box needs.
#
# SAFETY
# ------
# - Aborts BEFORE restarting tor if the config doesn't validate (the F1 rule: an outage is worse
#   than a skipped optimisation, and restarting on a rejected config takes relay + dashboard +
#   ssh-recovery down at once).
# - Never touches hs_ed25519_secret_key: the .onion address is unchanged, and that is asserted.
# - Backs up /etc/tor/torrc.d first.
# - Rollback is one line, printed at the end.
set -euo pipefail
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

VERIFY_ONLY=0
[[ "${1:-}" == "--verify-only" ]] && VERIFY_ONLY=1

TOR_UNIT=tor@default
systemctl cat tor@default.service >/dev/null 2>&1 || TOR_UNIT=tor
# NO HYPHEN. Debian's tor-instance-create rejects any non-alphanumeric name outright
# (`if echo "x$name" | grep -q '[^a-zA-Z0-9]' ... echo >&2 "Invalid name: $name."`), so the
# obvious-looking `stiq-client` can never be created and this script died here on the first real
# run — AFTER the flip had already restarted tor, leaving Safe-Browsing with no SOCKS. Do not
# "tidy" the hyphen back in.
TOR_CLIENT_INSTANCE=stiqclient
TOR_USER="debian-tor"; id -u "$TOR_USER" >/dev/null 2>&1 || TOR_USER="tor"
HS_DIR=/var/lib/tor/stiq-relay
AUTH_PRIV=/opt/stiq/organizer/relay_auth/community_priv.pem
W=/var/lib/tor/flipwork          # NOT under /root: the tor user must be able to traverse it
[[ $EUID -eq 0 ]] || die "run me as root"

# tor validates HiddenServiceDir ownership against the INVOKING user, so as root it fails on every
# box ("not owned by this user (root, 0) but by debian-tor") regardless of the config. Ask the user
# the daemon actually runs as, or the answer is meaningless.
tor_verify_config() { runuser -u "$TOR_USER" -- tor --verify-config >/dev/null 2>&1; }

ONION="$(cat ${HS_DIR}/hostname)"
say "relay onion: $ONION"

# ---------------------------------------------------------------- clients (real auth key)
setup_clients() {
  rm -rf $W; install -d -o "$TOR_USER" -g "$TOR_USER" -m 0700 $W $W/authdir $W/cauth $W/cnokey
  [[ -f "$AUTH_PRIV" ]] || die "no community auth key at $AUTH_PRIV — can't prove member reach without it."
  local priv pub live
  priv="$(openssl pkey -in "$AUTH_PRIV" -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
  pub="$(openssl pkey -in "$AUTH_PRIV" -pubout -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')"
  live="$(cut -d: -f3 ${HS_DIR}/authorized_clients/community.auth 2>/dev/null || true)"
  [[ "$pub" == "$live" ]] || die "the key at $AUTH_PRIV is NOT the one this onion authorizes — refusing to draw conclusions from the wrong key."
  say "  auth key matches authorized_clients (this is what a v4 join code carries)"
  printf '%s:descriptor:x25519:%s\n' "${ONION%.onion}" "$priv" > $W/authdir/community.auth_private
  printf 'DataDirectory %s/cauth\nSocksPort 19070\nClientOnionAuthDir %s/authdir\nLog notice file %s/cauth.log\n' "$W" "$W" "$W" > $W/torrc-auth
  printf 'DataDirectory %s/cnokey\nSocksPort 19071\nLog notice file %s/cnokey.log\n' "$W" "$W" > $W/torrc-nokey
  chown -R "$TOR_USER:$TOR_USER" $W; chmod 600 $W/authdir/community.auth_private
  runuser -u "$TOR_USER" -- tor -f $W/torrc-auth  >/dev/null 2>&1 &
  runuser -u "$TOR_USER" -- tor -f $W/torrc-nokey >/dev/null 2>&1 &
  say "  bootstrapping two throwaway clients (75s): one WITH the community key, one without"
  sleep 75
}
stop_clients() { pkill -u "$TOR_USER" -f 'flipwork/torrc-' 2>/dev/null || true; sleep 1; rm -rf $W; }

# member reach = NIP-11 over the onion, the same path the app uses
probe_member() { # label
  local i
  for i in 1 2 3 4 5; do
    curl -m 90 -s -o /dev/null -H 'Accept: application/nostr+json' \
      -w "  $1 try $i: http=%{http_code} total=%{time_total}s\n" \
      --socks5-hostname 127.0.0.1:19070 "http://${ONION}/" || true
  done
}
probe_keyless() {
  local code; code="$(curl -m 60 -s -o /dev/null -w '%{http_code}' --socks5-hostname 127.0.0.1:19071 "http://${ONION}/" || true)"
  echo "  keyless client: http=${code} (000 = could not reach, which is CORRECT)"
  grep -iE 'Fail to decrypt|requiring client auth' $W/cnokey.log 2>/dev/null | tail -1 || true
}

setup_clients
say "===== (b.1) BASELINE — before any change ====="
probe_member "baseline"
probe_keyless

if [[ "$VERIFY_ONLY" == "1" ]]; then stop_clients; say "--verify-only: done, nothing changed."; exit 0; fi

# ---------------------------------------------------------------- (b.2) the flip
say "===== (b.2) FLIP ====="
mkdir -p /root/flip-backup && cp -a /etc/tor/torrc.d "/root/flip-backup/torrc.d.$(date +%s)" 2>/dev/null || true

# An EXPLICIT nonzero SocksPort anywhere tor reads is fatal to this flip, and not obviously so:
# single-onion REQUIRES `SocksPort 0`, and tor refuses to start when both are specified
# ("You specified a nonzero SocksPort along with 'SocksPort 0' in the same configuration" ->
# "Invalid SocksPort configuration"). It is not last-wins; it is a hard error.
#
# This is not hypothetical: the production box shipped `SocksPort 9050` at /etc/tor/torrc:4 (there
# for Safe-Browsing) and the flip aborted on it. The compat gate never saw it because the throwaway
# box had no explicit SocksPort line at all — a clean-box test cannot find a dirty-box bug.
#
# Commenting it out is SAFE for the Safe-Browsing case this exists for: dropping the line does not
# leave the box without SOCKS, because step 8c below provisions tor@${TOR_CLIENT_INSTANCE} to serve
# 9050 instead. Removing the line also does NOT silently re-enable tor's compiled-in 9050 default —
# our drop-in's explicit `SocksPort 0` wins once it is the only SocksPort in the config.
# Tracks "<backup>|<original>" pairs so an abort can put the box back exactly as it was found. The
# abort path MUST restore these: leaving the line commented while also removing our drop-in would
# lean on tor's implicit compiled-in 9050 default to keep SOCKS alive — true today, invisible to
# the next reader, and not something an aborted run should be quietly depending on.
SOCKSPORT_EDITS=()
neutralize_socksport() {
  local f bak found=0
  for f in /etc/tor/torrc /etc/tor/torrc.d/*.conf; do
    [[ -f "$f" ]] || continue
    [[ "$f" == /etc/tor/torrc.d/stiq-base.conf ]] && continue   # ours; it is the SocksPort 0 line
    grep -qE '^[[:space:]]*SocksPort[[:space:]]+[^0[:space:]]' "$f" 2>/dev/null || continue
    bak="/root/flip-backup/$(basename "$f").before.$(date +%s)"
    cp -a "$f" "$bak"
    SOCKSPORT_EDITS+=("${bak}|${f}")
    sed -i -E 's|^([[:space:]]*SocksPort[[:space:]]+[^0[:space:]].*)$|# \1  # disabled by flip-single-onion.sh: single-onion needs SocksPort 0; 9050 is served by tor@'"${TOR_CLIENT_INSTANCE}"'|' "$f"
    say "  neutralized an explicit SocksPort in $f (backed up: $bak)"
    found=1
  done
  [[ "$found" == "1" ]] || say "  no explicit nonzero SocksPort to clear"
}
restore_socksport() {
  local pair
  for pair in "${SOCKSPORT_EDITS[@]:-}"; do
    [[ -n "$pair" ]] || continue
    cp -a "${pair%%|*}" "${pair##*|}" && say "  restored ${pair##*|}"
  done
}
neutralize_socksport

cat > /etc/tor/torrc.d/stiq-base.conf <<'BASECONF'
# stiq single-onion base — managed by deploy/stiq-up.sh (RELAY_SINGLE_ONION=1, the default)
SocksPort 0
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
BASECONF
chown "${TOR_USER}:${TOR_USER}" /etc/tor/torrc.d/stiq-base.conf

if ! tor_verify_config; then
  warn "tor REJECTS single-onion here — reverting and aborting. Client-auth/reach wins over a latency optimisation."
  rm -f /etc/tor/torrc.d/stiq-base.conf
  restore_socksport
  tor_verify_config || die "config is broken even WITHOUT the drop-in — NOT restarting; tor keeps running its current config. Inspect: runuser -u ${TOR_USER} -- tor --verify-config"
  stop_clients; die "ABORTED cleanly. Nothing restarted, nothing changed."
fi
say "  config valid (as ${TOR_USER})"

# Order matters: the main instance RELEASES 9050 (SocksPort 0) before the client instance acquires
# it. acquire-after-release is safe. The reverse (rollback) is the 9050 wedge — see Part (c).
say "  restarting ${TOR_UNIT} — briefly drops all onions on this box (relay + dashboard + ssh-recovery)"
systemctl restart "$TOR_UNIT"
sleep 3
systemctl is-active --quiet "$TOR_UNIT" || die "${TOR_UNIT} not active after restart. journalctl -u ${TOR_UNIT} -n 50"

if [[ -f /etc/stiq-relay/config.json ]] && python3 -c "import json,sys; sys.exit(0 if json.load(open('/etc/stiq-relay/config.json')).get('safe_browsing_api_key') else 1)" 2>/dev/null; then
  say "  Safe-Browsing is configured -> provisioning tor@${TOR_CLIENT_INSTANCE} for its SOCKS (single-onion set SocksPort 0)"
  [[ -d "/etc/tor/instances/${TOR_CLIENT_INSTANCE}" ]] || tor-instance-create "$TOR_CLIENT_INSTANCE" >/dev/null || die "tor-instance-create failed"
  printf 'DataDirectory /var/lib/tor-instances/%s\nSocksPort 127.0.0.1:9050\nLog err file /dev/null\nSafeLogging 1\n' "$TOR_CLIENT_INSTANCE" \
    > "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc"
  chown "${TOR_USER}:${TOR_USER}" "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc"
  chmod 640 "/etc/tor/instances/${TOR_CLIENT_INSTANCE}/torrc"
  systemctl daemon-reload
  systemctl enable --now "tor@${TOR_CLIENT_INSTANCE}" || warn "tor@${TOR_CLIENT_INSTANCE} failed to start — Safe-Browsing will 503 (fails closed) until it is."
fi

for _ in $(seq 1 30); do [[ -f ${HS_DIR}/hostname ]] && break; sleep 1; done
install -d -m 0700 /var/lib/stiq
printf '1\n' > /var/lib/stiq/single_onion.choice && chmod 0600 /var/lib/stiq/single_onion.choice
say "  recorded /var/lib/stiq/single_onion.choice=1 (a later routine stiq-up.sh re-run will honour it)"

# ---------------------------------------------------------------- (b.3) prove it
say "===== (b.3) VERIFY ====="
NOW="$(cat ${HS_DIR}/hostname)"
[[ "$NOW" == "$ONION" ]] && say "  .onion UNCHANGED — every saved join code / link still resolves" \
                         || die "!!! .onion CHANGED ($ONION -> $NOW) — this should be impossible; investigate before telling anyone."
say "  single-hop actually live: $(journalctl -u $TOR_UNIT --since '-3min' --no-pager 2>/dev/null | grep -c 'SingleHopMode is enabled') x 'SingleHopMode is enabled'"
echo "  --- 9050 must belong to tor@${TOR_CLIENT_INSTANCE}, NOT the main instance ---"
ss -ltnp 2>/dev/null | grep :9050 || echo "    (nothing on 9050)"
echo "    ${TOR_UNIT} MainPID          : $(systemctl show -p MainPID --value $TOR_UNIT)"
echo "    tor@${TOR_CLIENT_INSTANCE} MainPID : $(systemctl show -p MainPID --value tor@${TOR_CLIENT_INSTANCE} 2>/dev/null || echo n/a)"
for u in "$TOR_UNIT" "tor@${TOR_CLIENT_INSTANCE}" stiq-relay stiq-organizer; do
  echo "    $u: $(systemctl is-active $u 2>/dev/null || echo inactive)"; done
for d in stiq-relay stiq-dashboard stiq-ssh; do
  [[ -d "/var/lib/tor/$d" ]] && echo "    onion $d: $(cat /var/lib/tor/$d/hostname 2>/dev/null || echo MISSING)"; done

say "  re-testing member reach against the REAL onion + REAL community key (this is the check that matters)"
sleep 20
probe_member "after"
probe_keyless
echo ""
echo "  READ THIS: the auth-holding client MUST still be 200, and the keyless client MUST still fail."
echo "  If the key-holding client now fails, ROLL BACK — client-auth wins, single-onion does not:"
echo "      systemctl disable --now tor@${TOR_CLIENT_INSTANCE}   # release 9050 FIRST (the wedge)"
echo "      rm -f /etc/tor/torrc.d/stiq-base.conf"
echo "      printf '0\\n' > /var/lib/stiq/single_onion.choice"
echo "      systemctl restart ${TOR_UNIT}                        # restart, NOT reload"
stop_clients
say "done. Compare the b.1 and 'after' numbers above for the latency delta (b.4)."

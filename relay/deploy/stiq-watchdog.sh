#!/usr/bin/env bash
# stiq-watchdog — end-to-end reachability probe + auto-heal for the stiq relay stack.
#
# Born from the 2026-07-28 onion outage: tor@default silently stopped serving the relay's
# v3 onion (process alive, systemd happy, zero log evidence — tor logged to /dev/null back
# then). The relay was unreachable for ~1.5h until a human restarted tor. This watchdog makes
# that failure mode self-healing and leaves evidence behind.
#
# Probe ladder (every timer tick):
#   1. LOCAL  — HTTP GET 127.0.0.1:3334 (the Go relay itself). Any HTTP status = healthy.
#               2 consecutive failures -> restart stiq-relay (cooldown 10 min).
#   2. ONION  — HTTP GET the relay onion through tor@stiqclient's SOCKS (127.0.0.1:9050),
#               exercising descriptor fetch + client-auth decrypt + intro + rendezvous + the
#               relay's HTTP answer. Needs ClientOnionAuthDir on the stiqclient instance
#               (provisioned by deploy/stiq-up.sh).
#               streak 2 -> restart tor@stiqclient   (maybe the PROBE path is what broke)
#               streak 3+ -> forensics + restart tor@default (the onion front itself)
#
# Restarts of tor@default/tor@stiqclient within their first 180s never count as failures
# (bootstrap grace), so the watchdog cannot flap a service it just healed.
#
# State lives in /run/stiq-watchdog (tmpfs — resets on boot, which is correct).
# Incidents append to /var/log/stiq-watchdog.log; routine OKs go only to the journal.

set -u

STATE_DIR=/run/stiq-watchdog
INCIDENT_LOG=/var/log/stiq-watchdog.log
RELAY_LOCAL=http://127.0.0.1:3334/
SOCKS=127.0.0.1:9050
HS_HOSTNAME_FILE=/var/lib/tor/stiq-relay/hostname
LOCAL_TIMEOUT=10
ONION_TIMEOUT=60
GRACE_SECS=180
RELAY_COOLDOWN_MIN=10
CLIENT_COOLDOWN_MIN=15
TOR_COOLDOWN_MIN=20

mkdir -p "$STATE_DIR"

log()      { echo "$*"; }                                  # journal (via the service unit)
incident() { printf '%s %s\n' "$(date -Is)" "$*" >> "$INCIDENT_LOG"; echo "INCIDENT: $*"; }

streak()     { cat "$STATE_DIR/$1" 2>/dev/null || echo 0; }
set_streak() { echo "$2" > "$STATE_DIR/$1"; }

cooldown_ok() { # cooldown_ok <name> <minutes>
  local last now
  last=$(cat "$STATE_DIR/$1.last" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $((now - last)) -ge $(($2 * 60)) ]
}
mark() { date +%s > "$STATE_DIR/$1.last"; }

svc_age() { # seconds since the unit last became active; huge if unknown
  local t
  t=$(systemctl show "$1" -p ActiveEnterTimestamp --value 2>/dev/null)
  [ -n "$t" ] || { echo 999999; return; }
  echo $(( $(date +%s) - $(date -d "$t" +%s 2>/dev/null || echo 0) ))
}

probe() { # probe <url> <timeout> [socks] -> echoes http_code, 000 on failure; one retry
  local url=$1
  local tmo=$2
  local socks=${3:-}
  local code
  local args=(-s -o /dev/null -w '%{http_code}' --max-time "$tmo")
  [ -n "$socks" ] && args+=(--socks5-hostname "$socks")
  code=$(curl "${args[@]}" "$url" 2>/dev/null) || code=000
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    sleep 2
    code=$(curl "${args[@]}" "$url" 2>/dev/null) || code=000
  fi
  [ -n "$code" ] || code=000
  echo "$code"
}

forensics() { # appended to the incident log before a tor@default restart
  {
    echo "---- forensics $(date -Is) (onion streak $(streak onion)) ----"
    echo "-- services:"
    for s in stiq-relay tor@default tor@stiqclient; do
      printf '   %s: %s (age %ss)\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)" "$(svc_age "$s")"
    done
    echo "-- established conns to :3334: $(ss -tnH state established '( sport = :3334 )' 2>/dev/null | wc -l)"
    echo "-- memory:"; free -m | sed 's/^/   /'
    echo "-- tor notices tail:"; tail -n 30 /var/log/tor/notices.log 2>/dev/null | sed 's/^/   /'
    echo "----"
  } >> "$INCIDENT_LOG" 2>/dev/null
}

# ---- 0. if the onion front is down at the systemd level, that's systemd's job to fix ----
if ! systemctl is-active --quiet tor@default; then
  incident "tor@default is not active — leaving recovery to systemd (Restart=always)"
  exit 0
fi

# ---- 1. local relay ----
code=$(probe "$RELAY_LOCAL" "$LOCAL_TIMEOUT")
if [ "$code" = "000" ]; then
  n=$(( $(streak local) + 1 )); set_streak local "$n"
  log "local relay probe FAILED (streak $n)"
  if [ "$n" -ge 2 ] && cooldown_ok relay-restart "$RELAY_COOLDOWN_MIN"; then
    incident "local relay unresponsive x${n} — restarting stiq-relay"
    systemctl restart stiq-relay
    mark relay-restart; set_streak local 0
  fi
  exit 0   # onion probe is meaningless while the local relay is down
fi
[ "$(streak local)" != 0 ] && incident "local relay probe recovered"
set_streak local 0

# ---- 2. onion end-to-end ----
onion=$(cat "$HS_HOSTNAME_FILE" 2>/dev/null || true)
if [ -z "$onion" ]; then
  log "no onion hostname at $HS_HOSTNAME_FILE — skipping onion probe"
  exit 0
fi
# No SOCKS proxy -> no probe path. Never count that as an onion failure (a missing/broken
# probe path restarting tor@default would be the watchdog CAUSING outages, not healing them).
if ! ss -ltnH "( sport = :9050 )" 2>/dev/null | grep -q 9050; then
  log "no SOCKS listener on ${SOCKS} — skipping onion probe (is tor@stiqclient provisioned?)"
  exit 0
fi

ocode=$(probe "http://${onion}/" "$ONION_TIMEOUT" "$SOCKS")
if [ "$ocode" = "000" ]; then
  if [ "$(svc_age tor@default)" -lt "$GRACE_SECS" ] || [ "$(svc_age tor@stiqclient)" -lt "$GRACE_SECS" ]; then
    log "onion probe failed but a tor instance is <${GRACE_SECS}s old — bootstrap grace, not counting"
    exit 0
  fi
  n=$(( $(streak onion) + 1 )); set_streak onion "$n"
  log "onion e2e probe FAILED (streak $n)"
  if [ "$n" -eq 2 ] && cooldown_ok client-restart "$CLIENT_COOLDOWN_MIN"; then
    incident "onion unreachable x2 — restarting tor@stiqclient (probe-path reset first)"
    systemctl restart tor@stiqclient
    mark client-restart
  elif [ "$n" -ge 3 ]; then
    if cooldown_ok tor-restart "$TOR_COOLDOWN_MIN"; then
      forensics
      incident "onion unreachable x${n} — restarting tor@default (auto-heal)"
      systemctl restart tor@default
      mark tor-restart; set_streak onion 0
    else
      incident "onion unreachable x${n} — tor@default restart on cooldown, still failing"
    fi
  fi
else
  prev=$(streak onion)
  [ "$prev" != 0 ] && incident "onion probe recovered (after ${prev} failures, HTTP ${ocode})"
  set_streak onion 0
  log "probes OK (local=${code} onion=${ocode})"
fi

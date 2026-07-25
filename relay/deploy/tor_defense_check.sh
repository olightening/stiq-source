#!/usr/bin/env bash
# =============================================================================
# tor_defense_check.sh — standing onion-defense health check for a STIQ relay
# (or any federated mirror — a mirror is just another stiq-up.sh relay box).
#
# Diagnostic ONLY: side-effect-free, no restarts, no daemons. Safe to run by
# hand, from stiq-up.sh as a post-deploy check, or from cron/monitoring.
#
# It asserts, for the onion PoW + intro-DoS hardening (T5):
#   • tor version >= 0.4.8   (older tor cannot solve the onion-service PoW puzzle)
#   • the equix 'pow' module is present (HiddenServicePoWDefensesEnabled needs it)
#   • tor --verify-config passes
#   • the relay (and, when present, dashboard) onion descriptor has published
#   • a silent-downgrade guard: the pow module is present but the live drop-in
#     carries NO HiddenServicePoWDefensesEnabled line
# ...and, for single-onion mode (RELAY_SINGLE_ONION, default 1 — W4):
#   • when stiq-base.conf is present: it carries BOTH HiddenServiceNonAnonymousMode 1 and
#     HiddenServiceSingleHopMode 1, AND SocksPort 0 (a partial/corrupt drop-in is a HARD fail —
#     tor may reject the config or silently run in a mixed, unintended mode)
#   • when stiq-base.conf is ABSENT: reported as informational (standard/--no-single-onion mode),
#     not a failure — that is a legitimate deliberate choice
#   • all THREE possible HiddenServiceDirs (relay, dashboard, SSH-recovery) that exist on this box
#     still have a published descriptor — a single-onion flip touching NOTHING about which onions
#     exist is exactly what should be true before/after toggling RELAY_SINGLE_ONION
# ...and a LIVE-STATE probe (F3), because a config file agreeing with itself proves nothing if tor
# never actually restarted onto it:
#   • ss -ltnp, PID-attributed to the serving unit (tor@default, or the bare `tor` meta-wrapper on
#     distros without the @default unit) — when single-onion is ON, that PID must NOT hold a
#     listener on :9050. Tor's own optional client-only tor@stiq-client instance (Safe-Browsing's
#     SOCKS proxy, provisioned by stiq-up.sh step 8c) legitimately holds :9050 in that same mode —
#     the probe attributes each listener by PID to tell "main instance leaked SocksPort" apart from
#     "the client-only instance is doing its job" instead of treating any listener as a failure.
#   • a GETINFO cross-check over tor's ControlPort, when one is configured (only true when
#     STIQ_VANGUARDS=1 with single-onion OFF — see stiq-controlport.conf / stiq-vanguards.service;
#     most boxes never carry a control port at all, which is normal, not a failure). When reachable,
#     asks tor itself — not a config file, not ps — whether it currently holds a live SOCKS
#     listener, the strongest available signal.
#
# Exit 0 = all HARD defenses healthy (PoW may be a soft WARN when the module is
# absent). Non-zero = an actionable failure (tor missing, verify-config fail, or
# the onion descriptor missing).
#
# ── Runbook ──────────────────────────────────────────────────────────────────
#   Confirm PoW is active:
#       tor --list-modules            # expect: pow: yes
#       grep HiddenServicePoWDefensesEnabled /etc/tor/torrc.d/stiq-relay.conf
#   Roll back to IntroDoS-only (deliberate):
#       STIQ_RELAY_POW_DEFENSE=0 bash deploy/stiq-up.sh
#   Roll back single-onion mode (deliberate):
#       sudo bash deploy/stiq-up.sh --no-single-onion
#   See deploy/SINGLE_ONION.md for the full single-onion verify/flip/rollback procedure,
#   including the client-auth compatibility gate that MUST be checked on a throwaway HS before
#   relying on single-onion + RELAY_ONION_AUTH together on an existing community.
#   This check sits NEXT TO the EOL-tor apt-repo mitigation (stiq-up.sh step 1 /
#   relay/deploy/server-setup.sh) as the standing tor-health check for every
#   relay AND mirror box: an EOL tor here means both no PoW *and* the 30%
#   consensus-wedge outage class, so a non-zero exit is your early warning.
# =============================================================================
set -uo pipefail

RELAY_HS_DIR="${STIQ_RELAY_HS_DIR:-/var/lib/tor/stiq-relay}"
DASH_HS_DIR="${STIQ_DASH_HS_DIR:-/var/lib/tor/stiq-dashboard}"
SSH_HS_DIR="${STIQ_SSH_HS_DIR:-/var/lib/tor/stiq-ssh}"
RELAY_CONF="${STIQ_RELAY_TORRC:-/etc/tor/torrc.d/stiq-relay.conf}"
BASE_CONF="${STIQ_BASE_TORRC:-/etc/tor/torrc.d/stiq-base.conf}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; }

HARD_FAIL=0
SOFT_WARN=0

# 1) tor version >= 0.4.8 (pure sort -V compare — no bc/awk float math).
if ! command -v tor >/dev/null 2>&1; then
  fail "tor is not installed / not on PATH."
  echo "TOR_VERSION=missing"
  exit 1
fi
VER="$(tor --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [[ -z "$VER" ]]; then
  warn "could not parse a tor version from 'tor --version'."
  echo "TOR_VERSION=unknown"
  SOFT_WARN=1
else
  echo "TOR_VERSION=${VER}"
  # VER >= 0.4.8  iff  sort -V of {VER, 0.4.8} puts 0.4.8 first.
  if [[ "$(printf '%s\n0.4.8\n' "$VER" | sort -V | head -1)" == "0.4.8" ]]; then
    say "tor ${VER} >= 0.4.8 (solves onion-service PoW transparently)."
  else
    fail "tor ${VER} is < 0.4.8 — it cannot solve the onion-service PoW puzzle and may be EOL (consensus-wedge risk). Install tor from the Tor Project apt repo."
    HARD_FAIL=1
  fi
fi

# 2) equix 'pow' module present?
if tor --list-modules 2>/dev/null | grep -qiE '^pow:[[:space:]]*yes'; then
  POW_MODULE=yes
  say "equix pow module: present."
else
  POW_MODULE=no
  warn "equix 'pow' module ABSENT — the onion runs IntroDoS-only (HiddenServicePoWDefensesEnabled would refuse to start). Install tor from the Tor Project apt repo to enable onion PoW."
  SOFT_WARN=1
fi
echo "POW_MODULE=${POW_MODULE}"

# 3) tor --verify-config
if tor --verify-config >/dev/null 2>&1; then
  VERIFY_CONFIG=ok
  say "tor --verify-config: ok."
else
  VERIFY_CONFIG=fail
  fail "tor --verify-config FAILED — the tor config is invalid; the onion may not come up. Inspect /etc/tor/torrc and /etc/tor/torrc.d."
  HARD_FAIL=1
fi
echo "VERIFY_CONFIG=${VERIFY_CONFIG}"

# 4) relay onion descriptor published (hostname file exists + non-empty)
if [[ -s "${RELAY_HS_DIR}/hostname" ]]; then
  RELAY_ONION_DESCRIPTOR=published
  say "relay onion descriptor: published ($(cat "${RELAY_HS_DIR}/hostname" 2>/dev/null))."
else
  RELAY_ONION_DESCRIPTOR=missing
  fail "relay onion descriptor MISSING (${RELAY_HS_DIR}/hostname absent/empty) — the community onion is not reachable. Check: journalctl -u tor@default."
  HARD_FAIL=1
fi
echo "RELAY_ONION_DESCRIPTOR=${RELAY_ONION_DESCRIPTOR}"

# Dashboard onion is optional (DASHBOARD_ONION); only report when its dir exists.
if [[ -d "$DASH_HS_DIR" ]]; then
  if [[ -s "${DASH_HS_DIR}/hostname" ]]; then
    say "dashboard onion descriptor: published."
  else
    warn "dashboard onion dir exists but ${DASH_HS_DIR}/hostname is absent/empty."
    SOFT_WARN=1
  fi
fi

# SSH-over-Tor recovery onion is optional (added by add_ssh_hidden_service.sh / console_recovery.sh);
# only report when its dir exists — absence is not a failure (most boxes never add it).
if [[ -d "$SSH_HS_DIR" ]]; then
  if [[ -s "${SSH_HS_DIR}/hostname" ]]; then
    say "SSH-recovery onion descriptor: published."
  else
    warn "SSH-recovery onion dir exists but ${SSH_HS_DIR}/hostname is absent/empty."
    SOFT_WARN=1
  fi
fi

# 5) Silent-downgrade detector: module present but the live drop-in lacks the PoW directive.
if [[ "$POW_MODULE" == "yes" && -f "$RELAY_CONF" ]]; then
  if ! grep -q '^HiddenServicePoWDefensesEnabled' "$RELAY_CONF"; then
    warn "the equix pow module is present but ${RELAY_CONF} carries NO HiddenServicePoWDefensesEnabled line (silent downgrade to IntroDoS-only?). Re-run stiq-up.sh with STIQ_RELAY_POW_DEFENSE=1."
    SOFT_WARN=1
  fi
fi

# 6) Single-onion mode (RELAY_SINGLE_ONION, default 1, W4) — stiq-base.conf.
if [[ -f "$BASE_CONF" ]]; then
  SINGLE_ONION_MODE=on
  MISSING=""
  grep -q '^HiddenServiceNonAnonymousMode 1' "$BASE_CONF" || MISSING="${MISSING}HiddenServiceNonAnonymousMode "
  grep -q '^HiddenServiceSingleHopMode 1'    "$BASE_CONF" || MISSING="${MISSING}HiddenServiceSingleHopMode "
  grep -q '^SocksPort 0'                     "$BASE_CONF" || MISSING="${MISSING}SocksPort-0 "
  if [[ -n "$MISSING" ]]; then
    fail "single-onion drop-in ${BASE_CONF} exists but is missing: ${MISSING}— an incomplete/corrupt config (tor may reject it, or silently run in a mixed mode where some onions are single-hop and SocksPort is still open). Re-run: sudo bash deploy/stiq-up.sh"
    HARD_FAIL=1
  else
    say "single-onion mode: ENABLED (SocksPort 0, HiddenServiceNonAnonymousMode 1, HiddenServiceSingleHopMode 1)."
  fi
else
  SINGLE_ONION_MODE=off
  say "single-onion mode: OFF (standard, fully-anonymous-both-ways hidden service — ${BASE_CONF} absent; this is the --no-single-onion / RELAY_SINGLE_ONION=0 state)."
fi
echo "SINGLE_ONION_MODE=${SINGLE_ONION_MODE}"

# 7) Live-state probe (F3): checks 1-6 above are all config/descriptor checks — a torrc drop-in
#    saying SocksPort 0 proves nothing if tor never restarted onto it, or restarted but a stale
#    process is still holding the port. This asserts what's ACTUALLY listening/running, via two
#    independent signals.
#
# 7a) ss -ltnp, PID-attributed to the serving unit. Same unit-detection stiq-up.sh uses
#     (deploy/stiq-up.sh:864-872): tor@default on Debian/Ubuntu, falling back to the bare `tor`
#     meta-wrapper unit on distros without @default. Any :9050 listener belonging to THAT pid is a
#     leaked SocksPort; a :9050 listener belonging to tor@stiq-client (the separate, client-only
#     instance stiq-up.sh step 8c provisions for Safe-Browsing when single-onion + Safe-Browsing are
#     both active) is expected and NOT a failure — the whole point of that second instance is to own
#     :9050 once the main instance's SocksPort goes to 0.
MAIN_UNIT="tor@default"
if ! { systemctl list-unit-files 'tor@default.service' >/dev/null 2>&1 && systemctl cat tor@default.service >/dev/null 2>&1; }; then
  MAIN_UNIT="tor"
fi
CLIENT_UNIT="tor@stiq-client"

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found — cannot resolve the serving tor unit's pid; skipping the live SocksPort listener probe (config-only checks above still apply)."
  SOFT_WARN=1
elif ! command -v ss >/dev/null 2>&1; then
  warn "ss not found — cannot verify the live SocksPort listener state; skipping the live probe (config-only checks above still apply)."
  SOFT_WARN=1
else
  MAIN_PID="$(systemctl show -p MainPID --value "$MAIN_UNIT" 2>/dev/null)"
  [[ "$MAIN_PID" == "0" ]] && MAIN_PID=""
  CLIENT_PID="$(systemctl show -p MainPID --value "$CLIENT_UNIT" 2>/dev/null)"
  [[ "$CLIENT_PID" == "0" ]] && CLIENT_PID=""

  if [[ -z "$MAIN_PID" ]]; then
    warn "could not resolve a MainPID for ${MAIN_UNIT} (not active, or systemctl show failed) — skipping the live SocksPort listener probe."
    SOFT_WARN=1
  else
    # ss -ltnp only lists LISTENing TCP sockets, so every match here is a bound port, never a peer
    # address — safe to grep on ":9050 " without a state filter. -p needs root, which this check
    # (like the rest of the installer/health-check family) already assumes.
    SOCKS_LISTEN_LINES="$(ss -ltnp 2>/dev/null | grep -E ':9050[[:space:]]' || true)"
    SOCKS_PIDS="$(printf '%s\n' "$SOCKS_LISTEN_LINES" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"

    if [[ "$SINGLE_ONION_MODE" == "on" ]]; then
      if printf '%s\n' "$SOCKS_PIDS" | grep -qx "$MAIN_PID"; then
        fail "LIVE STATE: ${MAIN_UNIT} (pid ${MAIN_PID}) is LISTENING on :9050 despite single-onion mode's SocksPort 0 — the config says one thing, the running process is doing another (needs a restart, not a reload: 'sudo systemctl restart ${MAIN_UNIT}'; see SINGLE_ONION.md / F4's reload-doesn't-un-apply-SocksPort note)."
        HARD_FAIL=1
      elif [[ -z "$SOCKS_PIDS" ]]; then
        say "live state: no listener on :9050 — SocksPort 0 confirmed in effect on ${MAIN_UNIT} (pid ${MAIN_PID})."
      elif [[ -n "$CLIENT_PID" ]] && printf '%s\n' "$SOCKS_PIDS" | grep -qx "$CLIENT_PID"; then
        say "live state: :9050 is held by ${CLIENT_UNIT} (pid ${CLIENT_PID}), the Safe-Browsing client-only tor instance — expected under single-onion, not ${MAIN_UNIT}."
      else
        warn "live state: :9050 has a listener (pid(s): $(printf '%s' "$SOCKS_PIDS" | tr '\n' ' ')) that is neither ${MAIN_UNIT} (${MAIN_PID}) nor an active ${CLIENT_UNIT} — cannot attribute it. Investigate by hand: ss -ltnp | grep :9050"
        SOFT_WARN=1
      fi
    else
      say "live state: single-onion is OFF — ${MAIN_UNIT} is expected to hold its normal SocksPort; no :9050 assertion made."
    fi
  fi
fi

# 7b) GETINFO cross-check over tor's ControlPort, when one is configured. deploy/stiq-up.sh only
#     ever writes /etc/tor/torrc.d/stiq-controlport.conf (ControlPort unix:/var/run/tor/control +
#     CookieAuthentication 1) when STIQ_VANGUARDS=1 AND single-onion is OFF — so on a typical
#     single-onion box (the default) this control socket will be ABSENT, which is normal and not a
#     failure on its own; it's simply not the box's configuration. When the socket IS present, this
#     asks tor directly (not ps, not a config file) whether it currently holds a live SOCKS
#     listener — the strongest signal available, and if it ever disagrees with 7a while single-onion
#     is ON, that is treated as a hard failure (tor's own runtime state, straight from the daemon).
CONTROL_SOCK="${STIQ_TOR_CONTROL_SOCK:-/var/run/tor/control}"
COOKIE_FILE="${STIQ_TOR_COOKIE_FILE:-/var/lib/tor/control_auth_cookie}"
if [[ -S "$CONTROL_SOCK" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    warn "control port ${CONTROL_SOCK} is present but python3 is unavailable — skipping the GETINFO cross-check."
    SOFT_WARN=1
  elif [[ ! -r "$COOKIE_FILE" ]]; then
    warn "control port ${CONTROL_SOCK} is present but its auth cookie ${COOKIE_FILE} is not readable (run this check as root) — skipping the GETINFO cross-check."
    SOFT_WARN=1
  else
    GETINFO_OUT="$(python3 - "$CONTROL_SOCK" "$COOKIE_FILE" <<'PYEOF' 2>/dev/null
import socket, sys
sock_path, cookie_path = sys.argv[1], sys.argv[2]
try:
    with open(cookie_path, 'rb') as f:
        cookie = f.read()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(sock_path)
    s.sendall(b'AUTHENTICATE ' + cookie.hex().encode('ascii') + b'\r\n')
    auth_reply = s.recv(4096)
    if not auth_reply.startswith(b'250'):
        print('AUTH_FAILED:' + auth_reply.decode('utf-8', 'replace').strip())
    else:
        s.sendall(b'GETINFO net/listeners/socks\r\n')
        info_reply = s.recv(4096)
        try:
            s.sendall(b'QUIT\r\n')
        except OSError:
            pass
        print('OK:' + info_reply.decode('utf-8', 'replace').strip())
    s.close()
except Exception as e:
    print('PROBE_ERROR:' + str(e))
PYEOF
)"
    case "$GETINFO_OUT" in
      PROBE_ERROR:*)
        warn "GETINFO probe over ${CONTROL_SOCK} failed: ${GETINFO_OUT#PROBE_ERROR:}"
        SOFT_WARN=1
        ;;
      AUTH_FAILED:*)
        warn "control port ${CONTROL_SOCK} rejected the cookie auth (${GETINFO_OUT#AUTH_FAILED:}) — cannot cross-check live mode via GETINFO."
        SOFT_WARN=1
        ;;
      OK:*)
        # The control-spec reply line is `250-net/listeners/socks=VALUE` (or `250 ...` if it's the
        # final line), VALUE being one-or-more space-separated quoted addresses, or nothing at all
        # when there's no listener. Strip \r (raw CRLF line endings from the control protocol) and
        # pull just the value so "empty" isn't a fragile whole-blob substring match.
        INFO_BODY="$(printf '%s' "${GETINFO_OUT#OK:}" | tr -d '\r')"
        VALUE_LINE="$(printf '%s\n' "$INFO_BODY" | grep -E '^250[- ]net/listeners/socks=' | head -1)"
        VALUE="${VALUE_LINE#250-net/listeners/socks=}"
        VALUE="${VALUE#250 net/listeners/socks=}"
        if [[ -z "$VALUE_LINE" ]]; then
          warn "GETINFO net/listeners/socks returned an unexpected reply (no net/listeners/socks line found): ${INFO_BODY}"
          SOFT_WARN=1
        elif [[ -z "$VALUE" || "$VALUE" == '""' ]]; then
          say "GETINFO net/listeners/socks: empty — control-port-confirmed no live SOCKS listener on this tor instance."
        else
          if [[ "$SINGLE_ONION_MODE" == "on" ]]; then
            fail "LIVE STATE (GETINFO): tor itself reports a live SOCKS listener (${VALUE}) despite single-onion mode — SocksPort 0 is NOT actually in effect on this instance."
            HARD_FAIL=1
          else
            say "GETINFO net/listeners/socks: ${VALUE} (single-onion is OFF — a live SOCKS listener here is expected, not a failure)."
          fi
        fi
        ;;
      *)
        warn "GETINFO probe over ${CONTROL_SOCK} returned an unrecognized result: ${GETINFO_OUT}"
        SOFT_WARN=1
        ;;
    esac
  fi
else
  say "control port not configured on this box (only written when STIQ_VANGUARDS=1 with single-onion OFF) — GETINFO cross-check skipped, not a failure."
fi

# Summary + exit code.
if [[ "$HARD_FAIL" == "1" ]]; then
  fail "onion defenses: one or more HARD checks failed (see above)."
  exit 1
elif [[ "$SOFT_WARN" == "1" ]]; then
  warn "onion defenses: PASS with warnings (PoW may be degraded to IntroDoS-only — review above)."
  exit 0
else
  say "onion defenses: PASS (tor >=0.4.8, pow module, verify-config ok, onion published)."
  exit 0
fi

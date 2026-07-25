#!/bin/bash
# Regression lock for stiq-up.sh's step-8 fail-safe ladder — the single most load-bearing block in
# the installer. A bug here doesn't degrade one feature; it takes every onion on the box down
# (relay + dashboard + SSH-recovery) with no way back in, which is exactly why it earned a test.
#
#   Run:  bash deploy/tests/stiq-up-ladder.test.sh deploy/stiq-up.sh
#
# It EXTRACTS the real ladder lines out of the installer rather than re-implementing them, so the
# test cannot drift from the code it guards; it only rewrites the /etc/tor path prefix into a
# sandbox and stubs `tor` + `systemctl` on PATH so each branch is drivable deterministically. No
# root, no tor, no systemd required.
#
# What it pins (each of these was a real, filed defect):
#   3. tor rejects the single-onion drop-in  -> auto-degrade to standard mode, vanguards forced off
#   4. tor rejects the config for some OTHER reason -> DIE BEFORE THE RESTART, and leave
#      stiq-base.conf byte-identical (never "fix" an unrelated failure by silently disabling a
#      feature the operator asked for)
#   5. single-onion OFF while tor@stiqclient holds 9050 -> release the port BEFORE the restart.
#      The rule: acquire-after-release (flip ON) is safe; release-after-acquire (flip OFF) wedges
#      the box, and it sits on the documented rollback path.
#   7. verify-config runs as the TOR USER, not root. This one is not hypothetical: as root, tor
#      validates HiddenServiceDir ownership against the invoking user and fails on EVERY box
#      ("not owned by this user (root, 0) but by debian-tor"), while the same config is valid as
#      debian-tor. Get this wrong and `die` aborts every deploy everywhere — an earlier revision of
#      this ladder did exactly that, and only a live run caught it.
SRC="$1"
# Start the extraction at the tor_verify_config helper so the REAL helper is under test too — the
# ladder is meaningless without it.
START=$(grep -n 'tor_verify_config() {' "$SRC" | cut -d: -f1)
END=$(grep -n 'restarted but is not active' "$SRC" | cut -d: -f1)
[ -z "$START" ] || [ -z "$END" ] && { echo "FATAL: could not locate ladder"; exit 1; }
END=$((END + 1))

PASS=0; FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; PASS=$((PASS+1));
  else echo "  FAIL $1: expected '$2' got '$3'"; FAIL=$((FAIL+1)); fi
}

run_case() { # name tor_verdict_mode single_onion vanguards client_active
  local name="$1" mode="$2" so="$3" vg="$4" client="$5"
  T=$(mktemp -d); mkdir -p "$T/etc/tor/torrc.d" "$T/bin"

  printf 'SocksPort 0\nHiddenServiceNonAnonymousMode 1\nHiddenServiceSingleHopMode 1\n' > "$T/etc/tor/torrc.d/stiq-base.conf"
  cp "$T/etc/tor/torrc.d/stiq-base.conf" "$T/base.orig"
  printf 'HiddenServiceDir /var/lib/tor/stiq-relay\nHiddenServicePoWDefensesEnabled 1\n' > "$T/etc/tor/torrc.d/stiq-relay.conf"
  printf 'HiddenServiceDir /var/lib/tor/stiq-dash\n' > "$T/etc/tor/torrc.d/stiq-dashboard.conf"

  # stub tor: verdict depends on MODE + whether stiq-base.conf is present
  cat > "$T/bin/tor" <<STUB
#!/bin/bash
case "\$MODE" in
  good)      exit 0 ;;
  pow)       grep -q '^HiddenServicePoW' "$T/etc/tor/torrc.d/stiq-relay.conf" 2>/dev/null && exit 1; exit 0 ;;
  baseonly)  [ -f "$T/etc/tor/torrc.d/stiq-base.conf" ] && exit 1; exit 0 ;;
  hopeless)  exit 1 ;;
esac
exit 0
STUB
  # stub systemctl: records calls; is-active answers from env
  cat > "$T/bin/systemctl" <<STUB
#!/bin/bash
echo "\$*" >> "$T/systemctl.calls"
case "\$1" in
  is-active)
    for a in "\$@"; do case "\$a" in
      tor@stiqclient) [ "\$CLIENT_ACTIVE" = "1" ] && exit 0 || exit 1 ;;
      tor@default|tor) [ "\$UNIT_ACTIVE" = "1" ] && exit 0 || exit 1 ;;
    esac; done; exit 1 ;;
esac
exit 0
STUB
  # stub runuser: records WHICH user each verify ran as, then execs the real (stubbed) command.
  # `runuser -u <user> -- tor --verify-config`
  cat > "$T/bin/runuser" <<STUB
#!/bin/bash
echo "\$2" >> "$T/runuser.users"
shift 3
exec "\$@"
STUB
  chmod +x "$T/bin/tor" "$T/bin/systemctl" "$T/bin/runuser"

  # extract the real ladder, sandbox the paths
  sed -n "${START},${END}p" "$SRC" | sed "s#/etc/tor#$T/etc/tor#g" > "$T/ladder.sh"

  cat > "$T/run.sh" <<RUNNER
set -euo pipefail
export PATH="$T/bin:\$PATH"
say()  { echo "SAY: \$*"; }
warn() { echo "WARN: \$*"; }
die()  { echo "DIE: \$*"; exit 1; }
RELAY_SINGLE_ONION=$so
STIQ_VANGUARDS=$vg
TOR_UNIT=tor@default
TOR_CLIENT_INSTANCE=stiqclient
TOR_USER=debian-tor
source "$T/ladder.sh"
echo "FINAL_SINGLE_ONION=\$RELAY_SINGLE_ONION"
echo "FINAL_VANGUARDS=\$STIQ_VANGUARDS"
RUNNER

  OUT=$(MODE="$mode" CLIENT_ACTIVE="$client" UNIT_ACTIVE=1 bash "$T/run.sh" 2>&1); RC=$?
  echo "--- case: $name (rc=$RC)"
  RESULT_OUT="$OUT"; RESULT_RC=$RC; RESULT_T="$T"
}

echo "=== 0. verify-config runs as the TOR USER, never root (regression: root always fails) ==="
run_case healthy good 1 0 0
check "verify ran at least once"  "yes" "$([ -s $RESULT_T/runuser.users ] && echo yes || echo no)"
check "every verify ran as debian-tor" 0 "$(grep -cv '^debian-tor$' $RESULT_T/runuser.users || true)"

echo "=== 1. healthy config: restarts, no degrade ==="
run_case healthy good 1 0 0
check "exit 0"                0 "$RESULT_RC"
check "restart happened"      1 "$(grep -c '^restart tor@default' $RESULT_T/systemctl.calls)"
check "single-onion kept"     1 "$(echo "$RESULT_OUT" | grep -oP 'FINAL_SINGLE_ONION=\K.')"
check "base.conf intact"      0 "$(cmp -s $RESULT_T/etc/tor/torrc.d/stiq-base.conf $RESULT_T/base.orig; echo $?)"

echo "=== 2. PoW-only failure: strips PoW, restarts, no degrade ==="
run_case pow pow 1 0 0
check "exit 0"                0 "$RESULT_RC"
check "PoW stripped"          0 "$(grep -c '^HiddenServicePoW' $RESULT_T/etc/tor/torrc.d/stiq-relay.conf)"
check "single-onion kept"     1 "$(echo "$RESULT_OUT" | grep -oP 'FINAL_SINGLE_ONION=\K.')"
check "restart happened"      1 "$(grep -c '^restart tor@default' $RESULT_T/systemctl.calls)"

echo "=== 3. single-onion is the culprit: auto-degrades, restarts ==="
run_case degrade baseonly 1 1 0
check "exit 0"                0 "$RESULT_RC"
check "degraded to 0"         0 "$(echo "$RESULT_OUT" | grep -oP 'FINAL_SINGLE_ONION=\K.')"
check "base.conf removed"     1 "$([ -f $RESULT_T/etc/tor/torrc.d/stiq-base.conf ] && echo 0 || echo 1)"
check "probe file cleaned"    1 "$([ -f $RESULT_T/etc/tor/stiq-base.conf.probe ] && echo 0 || echo 1)"
check "vanguards forced off"  0 "$(echo "$RESULT_OUT" | grep -oP 'FINAL_VANGUARDS=\K.')"
check "restart happened"      1 "$(grep -c '^restart tor@default' $RESULT_T/systemctl.calls)"
check "client-auth-wins msg"  1 "$(echo "$RESULT_OUT" | grep -c 'AUTO-DEGRADED')"

echo "=== 4. unrelated failure: DIES before restart, base.conf byte-identical ==="
run_case hopeless hopeless 1 0 0
check "exit 1 (died)"         1 "$RESULT_RC"
NORESTART=$(grep -c '^restart tor@default' $RESULT_T/systemctl.calls 2>/dev/null || true)
check "NO restart"            0 "${NORESTART:-0}"
check "no systemctl at all"   "absent" "$([ -f $RESULT_T/systemctl.calls ] && echo present || echo absent)"
check "base.conf restored"    0 "$(cmp -s $RESULT_T/etc/tor/torrc.d/stiq-base.conf $RESULT_T/base.orig; echo $?)"
check "not degraded"          1 "$(echo "$RESULT_OUT" | grep -c 'REFUSING to restart')"

echo "=== 5. THE 9050 WEDGE: single-onion off + client holds 9050 -> released BEFORE restart ==="
run_case wedge good 0 0 1
check "exit 0"                0 "$RESULT_RC"
check "stopped tor@stiqclient" 1 "$(grep -c '^stop tor@stiqclient' $RESULT_T/systemctl.calls)"
STOP_LINE=$(grep -n '^stop tor@stiqclient' $RESULT_T/systemctl.calls | cut -d: -f1)
RESTART_LINE=$(grep -n '^restart tor@default' $RESULT_T/systemctl.calls | cut -d: -f1)
check "release ORDERED BEFORE restart" "yes" "$([ "$STOP_LINE" -lt "$RESTART_LINE" ] && echo yes || echo no)"

echo "=== 6. single-onion off, no client instance: no needless stop ==="
run_case noclient good 0 0 0
check "exit 0"                0 "$RESULT_RC"
check "no stop issued"        0 "$(grep -c '^stop tor@stiqclient' $RESULT_T/systemctl.calls 2>/dev/null || true)"

echo ""
echo "===== $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ] || exit 1

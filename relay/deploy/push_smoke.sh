#!/usr/bin/env bash
# =============================================================================
# push_smoke.sh — end-to-end smoke for the STIQ push stack (T1-S7).
#
# Exercises the content-free "wake and sync" path over LOOPBACK on a deployed,
# PUSH_WATCHER=1 box:
#
#   1. ntfy is healthy               (GET  NTFY_BASE/v1/health           → 200)
#   2. the watcher accepts a member  (POST WATCHER_URL/push/register     → 204)
#   3. a content-free wake is         (SSE  NTFY_BASE/<topic>/sse  +
#      delivered on that topic         POST NTFY_BASE/<topic>           → message)
#   4. the FULL relay→watcher→ntfy    (delegates to issuer/verify_push.mjs when
#      chain via a signed kind-1059     present: publish a synthetic 1059 with a
#                                        ['p',hex] tag → watcher matches #p → wake)
#
# Legs 1–3 are pure bash (curl). Leg 4 needs a SIGNED Nostr event, so it is
# delegated to the node harness issuer/verify_push.mjs (nostr-tools); if that file
# is not present, leg 4 is reported skipped and the script still passes on 1–3.
#
# Safe to run by hand or from stiq-up.sh's smoke section. Side-effect-free beyond a
# throwaway topic (unregistered at the end). Never prints member content.
#
# Usage:
#   WATCHER_URL=http://127.0.0.1:8787 NTFY_BASE=http://127.0.0.1:2586 \
#   RELAY_WS=ws://127.0.0.1:3334 bash relay/deploy/push_smoke.sh
# =============================================================================
set -uo pipefail

WATCHER_URL="${WATCHER_URL:-http://127.0.0.1:8787}"
NTFY_BASE="${NTFY_BASE:-http://127.0.0.1:2586}"
RELAY_WS="${RELAY_WS:-ws://127.0.0.1:3334}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SSE_TIMEOUT="${SSE_TIMEOUT:-20}"   # seconds to await the wake on the SSE stream

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; }

FAILED=0

# --- 1. ntfy health ------------------------------------------------------------
HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${NTFY_BASE}/v1/health" 2>/dev/null || echo 000)"
if [[ "$HEALTH" == "200" ]]; then
  say "ntfy health PASS (200)."
else
  fail "ntfy health got HTTP ${HEALTH} (is ntfy up? journalctl -u ntfy -n 50)."
  FAILED=1
fi

# --- 2. watcher register (204) -------------------------------------------------
TOPIC="stiqsmoke$(openssl rand -hex 8 2>/dev/null || echo "$$$(date +%s)")"
PHEX="$(openssl rand -hex 32 2>/dev/null || printf '%064d' 0)"
EXP="$(( $(date +%s) + 3600 ))"
REG="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"v\":1,\"topic\":\"${TOPIC}\",\"keys\":[\"p:${PHEX}\"],\"exp\":${EXP}}" \
  "${WATCHER_URL}/push/register" 2>/dev/null || echo 000)"
if [[ "$REG" == "204" ]]; then
  say "watcher register PASS (204)."
else
  fail "watcher register got HTTP ${REG} (journalctl -u stiq-pushwatcher -n 50)."
  FAILED=1
fi

# --- 3. content-free wake delivered on the topic (SSE) -------------------------
# Subscribe to the topic's SSE stream in the background, POST an empty wake, then
# wait for an 'event: message' to appear on the stream within SSE_TIMEOUT.
SSE_LOG="$(mktemp)"
curl -s -N --max-time "$SSE_TIMEOUT" "${NTFY_BASE}/${TOPIC}/sse" > "$SSE_LOG" 2>/dev/null &
SSE_PID=$!
sleep 1  # let the SSE stream open before we publish

WAKE="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Priority: min' -H 'Cache: no' \
  "${NTFY_BASE}/${TOPIC}" 2>/dev/null || echo 000)"
if [[ ! "$WAKE" =~ ^2[0-9][0-9]$ ]]; then
  fail "ntfy wake POST got HTTP ${WAKE} (journalctl -u ntfy -n 50)."
  FAILED=1
fi

GOT_WAKE=0
# ntfy's /sse stream sends real messages as a bare `data: {...}` line (default SSE event type), with
# the message JSON carrying "event":"message" — while connect/keepalive frames carry "event":"open"
# / "event":"keepalive". Match the JSON field so we count only an actual delivered message.
for _ in $(seq 1 "$SSE_TIMEOUT"); do
  if grep -q '"event":"message"' "$SSE_LOG" 2>/dev/null; then GOT_WAKE=1; break; fi
  sleep 1
done
kill "$SSE_PID" >/dev/null 2>&1 || true
wait "$SSE_PID" 2>/dev/null || true
rm -f "$SSE_LOG"
if [[ "$GOT_WAKE" == "1" ]]; then
  say "ntfy wake delivered PASS (message received on the topic SSE)."
else
  fail "no wake arrived on the topic SSE within ${SSE_TIMEOUT}s."
  FAILED=1
fi

# Best-effort unregister of the throwaway topic.
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "{\"topic\":\"${TOPIC}\"}" "${WATCHER_URL}/push/unregister" 2>/dev/null || true

# --- 4. FULL chain: signed kind-1059 → watcher #p match → ntfy wake ------------
# Needs a signed Nostr event, so delegate to the node harness when it is present.
VERIFY_PUSH="${REPO}/issuer/verify_push.mjs"
if [[ -f "$VERIFY_PUSH" ]]; then
  say "Full chain: issuer/verify_push.mjs (signed kind-1059 → watcher → ntfy)..."
  if WATCHER_URL="$WATCHER_URL" NTFY_BASE="$NTFY_BASE" RELAY_WS="$RELAY_WS" \
     node "$VERIFY_PUSH"; then
    say "full chain PASS (push wake delivered end-to-end)."
  else
    fail "full chain FAILED (see verify_push.mjs output above)."
    FAILED=1
  fi
else
  warn "issuer/verify_push.mjs not present — full relay→watcher→ntfy chain (needs a signed kind-1059) SKIPPED; ran the ntfy/register/wake legs only."
fi

if [[ "$FAILED" == "0" ]]; then
  say "push smoke: PASS."
else
  fail "push smoke: one or more legs failed (see above)."
fi
exit "$FAILED"

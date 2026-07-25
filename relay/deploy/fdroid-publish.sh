#!/usr/bin/env bash
#
# fdroid-publish.sh — build + sign the STIQ in-app update repo (T9-S2) and print the fingerprints
# the organizer pins into the join code.
#
# ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
# │ REQUIRES fdroidserver + Java (keytool/jarsigner) + TWO keystores to ACTUALLY RUN. This script   │
# │ cannot run in this dev environment — it is meant for the organizer's release box. It is the     │
# │ runbook, kept in-repo so the exact signing + fingerprint-extraction steps are reproducible.     │
# └───────────────────────────────────────────────────────────────────────────────────────────────┘
#
# What it does, given a signed APK:
#   1. (optional) apt-get install openjdk-17 + fdroidserver           [SKIP_APT=1 to skip]
#   2. `fdroid init`+config the repo dir on first run (creates the REPO index-signing key if absent)
#   3. copy the APK into REPO_DIR/repo/ and write the changelog as F-Droid's whatsNew
#   4. `fdroid update` → builds + JAR-signs REPO_DIR/repo/index-v1.jar (+ index-v1.json)
#        (or a NO-FDROIDSERVER fallback that hand-builds + jarsigner-signs the index — NO_FDROIDSERVER=1)
#   5. print the two pinned SHA-256 cert fingerprints + the Obtainium URL, and the join-code mapping.
#
# TWO DISTINCT KEYS (do not confuse them):
#   • APP key  — signs the APK. MUST be byte-identical to the key that signed the INSTALLED build, or
#                Android refuses the update (INSTALL_FAILED_UPDATE_INCOMPATIBLE). Its cert SHA-256 is
#                the join code's `af` (STIQ_UPDATE_APP_CERT); the client pins it before install.
#   • REPO key — signs the F-Droid index-v1.jar ONLY. A dedicated key, never the app key. Its cert
#                SHA-256 is the join code's `uf` (STIQ_UPDATE_REPO_CERT); the client pins it before it
#                trusts the index JSON at all.
#
# ── Environment contract ────────────────────────────────────────────────────────────────────────
#   APK_PATH        (required) path to the signed release/debug APK to publish
#   REPO_DIR        repo root                         (default: /var/lib/stiq-fdroid)
#   RELAY_ONION     relay onion host w/o scheme, e.g. abcd…xyz.onion  (required for the repo Address)
#   WHATS_NEW       path to a changelog text file (rendered as the release "what changed" note)
#   APPLICATION_ID  app id, e.g. com.stiq.client       (auto-derived via aapt when unset)
#   VERSION_CODE    integer versionCode of the APK     (auto-derived via aapt when unset)
#   REPO_KEYSTORE   dedicated index-signing keystore   (default: REPO_DIR/keystore.p12; created if absent)
#   REPO_KS_PASS    REPO keystore/store password       (required)
#   REPO_KEY_ALIAS  REPO key alias                     (default: stiq-repo)
#   APP_KEYSTORE    the APP signing keystore (== the installed build's key)   [needed for `af` via keytool]
#   APP_KS_PASS     APP keystore password              [needed only for the keytool `af` fallback]
#   APP_KEY_ALIAS   APP key alias                      [needed only for the keytool `af` fallback]
#   SKIP_APT=1      skip the apt-get install step (tooling already present)
#   NO_FDROIDSERVER=1  force the hand-built index path (no fdroidserver)
#
# Emits to stdout (grep-friendly KEY=VALUE lines):
#   REPO_CERT_SHA256=<64-hex>      → join `uf` / STIQ_UPDATE_REPO_CERT
#   APP_CERT_SHA256=<64-hex>       → join `af` / STIQ_UPDATE_APP_CERT
#   OBTAINIUM_URL=http://<onion>/fdroid/repo
#   UPDATE_REPO_PATH=/fdroid/repo  → join `up` / STIQ_UPDATE_REPO_PATH
#   APPLICATION_ID=<id>            → join `ua` / STIQ_UPDATE_APP_ID
#
# Relay side (do ONCE, separately): point the relay at REPO_DIR so it serves it under /fdroid/ —
#   set `fdroid_repo_dir` in the relay config.json (or FDROID_REPO_DIR in deploy/stiq-up.sh) to
#   "$REPO_DIR" and restart stiq-relay. It reuses the EXISTING relay onion:80 — no new HiddenServicePort.
#
set -euo pipefail

die() { echo "fdroid-publish: $*" >&2; exit 1; }
info() { echo "fdroid-publish: $*" >&2; }

# ── Preflight ─────────────────────────────────────────────────────────────────────────────────
: "${APK_PATH:?set APK_PATH to the signed APK to publish}"
[ -f "$APK_PATH" ] || die "APK_PATH not found: $APK_PATH"
REPO_DIR="${REPO_DIR:-/var/lib/stiq-fdroid}"
RELAY_ONION="${RELAY_ONION:?set RELAY_ONION to the relay onion host (…onion, no scheme)}"
REPO_KEYSTORE="${REPO_KEYSTORE:-$REPO_DIR/keystore.p12}"
REPO_KEY_ALIAS="${REPO_KEY_ALIAS:-stiq-repo}"
: "${REPO_KS_PASS:?set REPO_KS_PASS (the index-signing keystore password)}"
UPDATE_REPO_PATH="/fdroid/repo"
OBTAINIUM_URL="http://${RELAY_ONION}${UPDATE_REPO_PATH}"

# Normalize a keytool "SHA256: AB:CD:…" line into 64 lowercase hex chars, no colons.
normalize_fp() { tr -d ': ' | tr 'A-F' 'a-f' | grep -oE '[0-9a-f]{64}' | head -1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 1. Tooling ──────────────────────────────────────────────────────────────────────────────────
if [ "${SKIP_APT:-0}" != "1" ]; then
  if ! have fdroid && [ "${NO_FDROIDSERVER:-0}" != "1" ]; then
    info "installing openjdk-17-jre-headless + fdroidserver (SKIP_APT=1 to skip)"
    sudo apt-get update -y
    sudo apt-get install -y openjdk-17-jre-headless fdroidserver
  fi
fi
have keytool || die "keytool not found — install a JDK/JRE (openjdk-17)"
have jarsigner || die "jarsigner not found — install a JDK (openjdk-17-jdk)"

USE_FDROID=1
if [ "${NO_FDROIDSERVER:-0}" = "1" ] || ! have fdroid; then
  USE_FDROID=0
  info "using the NO-FDROIDSERVER hand-built index path"
fi

# ── Derive applicationId + versionCode (aapt when not provided) ─────────────────────────────────
derive_badging() {
  local aapt
  aapt="$(command -v aapt || true)"
  if [ -z "$aapt" ] && [ -n "${ANDROID_HOME:-}" ]; then
    aapt="$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | sort -V | tail -1 || true)"
  fi
  [ -n "$aapt" ] || return 1
  "$aapt" dump badging "$APK_PATH"
}
if [ -z "${APPLICATION_ID:-}" ] || [ -z "${VERSION_CODE:-}" ]; then
  if BADGING="$(derive_badging 2>/dev/null)"; then
    APPLICATION_ID="${APPLICATION_ID:-$(echo "$BADGING" | sed -n "s/.*package: name='\([^']*\)'.*/\1/p")}"
    VERSION_CODE="${VERSION_CODE:-$(echo "$BADGING" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")}"
  fi
fi
: "${APPLICATION_ID:?could not derive APPLICATION_ID via aapt — set it explicitly}"
: "${VERSION_CODE:?could not derive VERSION_CODE via aapt — set it explicitly}"
info "publishing ${APPLICATION_ID} versionCode=${VERSION_CODE}"

mkdir -p "$REPO_DIR/repo"

# ── 2. First-run repo init (creates the dedicated REPO index-signing key if absent) ─────────────
if [ "$USE_FDROID" = "1" ] && [ ! -f "$REPO_DIR/config.yml" ]; then
  info "initializing F-Droid repo in $REPO_DIR (repo key alias: $REPO_KEY_ALIAS)"
  ( cd "$REPO_DIR" && fdroid init --keystore "$REPO_KEYSTORE" --repo-keyalias "$REPO_KEY_ALIAS" )
  # Point the repo at the onion; F-Droid/Obtainium read Address from config.yml.
  {
    echo "repo_name: \"STIQ updates\""
    echo "repo_url: \"${OBTAINIUM_URL}\""
    echo "repo_description: \"Signed STIQ app updates, served over Tor.\""
    echo "keystorepass: \"${REPO_KS_PASS}\""
    echo "keypass: \"${REPO_KS_PASS}\""
  } >> "$REPO_DIR/config.yml"
fi

# ── 3. Stage the APK + changelog ────────────────────────────────────────────────────────────────
cp -f "$APK_PATH" "$REPO_DIR/repo/"
if [ -n "${WHATS_NEW:-}" ] && [ -f "$WHATS_NEW" ]; then
  CHANGELOG_DIR="$REPO_DIR/metadata/${APPLICATION_ID}/en-US/changelogs"
  mkdir -p "$CHANGELOG_DIR"
  cp -f "$WHATS_NEW" "$CHANGELOG_DIR/${VERSION_CODE}.txt"
  info "changelog staged at metadata/${APPLICATION_ID}/en-US/changelogs/${VERSION_CODE}.txt"
fi

# ── 4a. Build + sign the index with fdroidserver ────────────────────────────────────────────────
if [ "$USE_FDROID" = "1" ]; then
  ( cd "$REPO_DIR" && fdroid update -c --pretty )
else
  # ── 4b. NO-FDROIDSERVER fallback: hand-build a minimal index-v1.json and jarsigner-sign it ─────
  [ -f "$REPO_KEYSTORE" ] || die "REPO_KEYSTORE not found: $REPO_KEYSTORE (create it or run with fdroidserver)"
  APK_NAME="$(basename "$APK_PATH")"
  APK_SHA="$(sha256sum "$APK_PATH" | awk '{print $1}')"
  VERSION_NAME="${VERSION_NAME:-$VERSION_CODE}"
  NOTE=""
  [ -n "${WHATS_NEW:-}" ] && [ -f "$WHATS_NEW" ] && NOTE="$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1]).read()))' "$WHATS_NEW")"
  NOTE="${NOTE:-\"\"}"
  cat > "$REPO_DIR/repo/index-v1.json" <<JSON
{
  "repo": { "name": "STIQ updates", "address": "${OBTAINIUM_URL}", "timestamp": $(date +%s)000 },
  "apps": [ { "packageName": "${APPLICATION_ID}", "localized": { "en-US": { "whatsNew": ${NOTE} } } } ],
  "packages": {
    "${APPLICATION_ID}": [
      { "versionName": "${VERSION_NAME}", "versionCode": ${VERSION_CODE}, "apkName": "${APK_NAME}",
        "hash": "${APK_SHA}", "hashType": "sha256", "packageName": "${APPLICATION_ID}", "added": $(date +%s)000 }
    ]
  }
}
JSON
  ( cd "$REPO_DIR/repo" && jar cf index-v1.jar index-v1.json )
  jarsigner -keystore "$REPO_KEYSTORE" -storepass "$REPO_KS_PASS" \
    -digestalg SHA-256 -sigalg SHA256withRSA \
    "$REPO_DIR/repo/index-v1.jar" "$REPO_KEY_ALIAS"
  info "hand-built + signed $REPO_DIR/repo/index-v1.jar"
fi

# Sanity: the signed index must verify.
jarsigner -verify "$REPO_DIR/repo/index-v1.jar" >/dev/null || die "index-v1.jar failed jarsigner -verify"

# ── 5. Extract the pinned fingerprints ──────────────────────────────────────────────────────────
REPO_CERT_SHA256="$(keytool -list -v -keystore "$REPO_KEYSTORE" -alias "$REPO_KEY_ALIAS" -storepass "$REPO_KS_PASS" 2>/dev/null | grep -iA1 'SHA256:' | normalize_fp)"
[ -n "$REPO_CERT_SHA256" ] || die "could not extract REPO cert SHA-256 from $REPO_KEYSTORE"

# APP cert: prefer apksigner reading the APK's ACTUAL signer (authoritative); fall back to keytool on
# the app keystore. This is the fingerprint the client pins as `af` before it will install the APK.
APP_CERT_SHA256=""
if have apksigner; then
  APP_CERT_SHA256="$(apksigner verify --print-certs "$APK_PATH" 2>/dev/null | grep -i 'certificate SHA-256 digest' | head -1 | awk '{print $NF}' | tr 'A-F' 'a-f')"
fi
if [ -z "$APP_CERT_SHA256" ] && [ -n "${APP_KEYSTORE:-}" ]; then
  APP_CERT_SHA256="$(keytool -list -v -keystore "$APP_KEYSTORE" -alias "${APP_KEY_ALIAS:-}" -storepass "${APP_KS_PASS:-}" 2>/dev/null | grep -iA1 'SHA256:' | normalize_fp)"
fi
[ -n "$APP_CERT_SHA256" ] || die "could not extract APP cert SHA-256 (install apksigner, or set APP_KEYSTORE/APP_KS_PASS/APP_KEY_ALIAS)"

# ── 6. Report (grep-friendly; the organizer feeds these into the join-code STIQ_UPDATE_* env) ────
echo "REPO_CERT_SHA256=${REPO_CERT_SHA256}"
echo "APP_CERT_SHA256=${APP_CERT_SHA256}"
echo "OBTAINIUM_URL=${OBTAINIUM_URL}"
echo "UPDATE_REPO_PATH=${UPDATE_REPO_PATH}"
echo "APPLICATION_ID=${APPLICATION_ID}"
cat >&2 <<NEXT

fdroid-publish: done. Join-code handoff (T9-S6) — set these on the organizer server:
  STIQ_UPDATE_REPO_PATH=${UPDATE_REPO_PATH}   (join 'up')
  STIQ_UPDATE_REPO_CERT=${REPO_CERT_SHA256}   (join 'uf')
  STIQ_UPDATE_APP_CERT=${APP_CERT_SHA256}   (join 'af')
  STIQ_UPDATE_APP_ID=${APPLICATION_ID}   (join 'ua')
Then reissue the join code. Relay: set fdroid_repo_dir=${REPO_DIR} and restart stiq-relay.
NEXT

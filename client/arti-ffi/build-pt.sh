#!/usr/bin/env bash
# =====================================================================================
# Build lyrebird (obfs4), snowflake, and webtunnel as ANDROID-EXECUTABLE pluggable
# transports for the Arti backend.
# =====================================================================================
# WHY A SEPARATE BINARY AT ALL:
#   Arti does not implement any of these transports in-process. tor-ptmgr (arti-client feature
#   `pt-client`) speaks the Tor managed-PT stdio protocol to an EXTERNAL PROCESS. The incumbent
#   C-tor path uses IPtProxy, which is a gomobile JNI *library* — callable, but NOT exec'able — so
#   it cannot serve Arti. Hence real executables, one per transport.
#
# WHY THE OUTPUT IS NAMED lib*.so (each one is an EXECUTABLE, not a library):
#   Android has blocked exec() from app-data directories since API 29 (W^X). The one directory that
#   stays executable is nativeLibraryDir, and the packager only puts a file there if it is in
#   jniLibs/<abi>/ and matches lib*.so. So each PT binary is *named* like a shared object purely to
#   inherit that exec permission. This is the same trick Orbot and Tor Browser Android use.
#   It also requires the APK to EXTRACT native libs (extractNativeLibs=true). STIQ already gets
#   this: app/build.gradle deliberately leaves useLegacyPackaging at its default (see the comment
#   about download bytes over Tor), so libs are compressed AND extracted at install time.
#
# ── VERIFIED 2026-07-27 on this host — all three PTs, both ABIs, every one Type: DYN, Align: 0x4000
#   arm64-v8a:   libLyrebird.so 17,700,000 B (16.9 MB) · libSnowflake.so 17,243,360 B (16.4 MB) ·
#                libWebtunnel.so 5,381,408 B (5.1 MB)
#   armeabi-v7a: libLyrebird.so 16,869,892 B (16.1 MB) · libSnowflake.so 16,391,436 B (15.6 MB) ·
#                libWebtunnel.so 5,447,396 B (5.2 MB)
#   (DYN = PIE, which Android requires; an EXEC-type binary is rejected outright. Align=0x4000 on
#   EVERY LOAD segment of all six files, required for 16KB-page devices — see the LDFLAGS comment
#   below. Both gates verified via llvm-readelf, not assumed.) libLyrebird.so also serves meek_lite
#   (see pt.rs) — lyrebird registers meek_lite internally, so it needs no separate binary or build
#   step here.
# =====================================================================================
set -euo pipefail

# Go is NOT on PATH on this machine (see the stiq-relay-go-build-env memory).
GO_BIN="${GO_BIN:-/d/tools/go/bin}"
export PATH="$GO_BIN:$PATH"

: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME (e.g. D:/Programs/ndk/27.2.12479018)}"
NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/windows-x86_64/bin"
[[ -d "$NDK_BIN" ]] || NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JNILIBS="$HERE/../android/app/src/arti/jniLibs"
WORK="${WORK:-/tmp/ptbuild}"

mkdir -p "$WORK" "$JNILIBS/arm64-v8a" "$JNILIBS/armeabi-v7a"
cd "$WORK"
[[ -f go.mod ]] || go mod init stiqpt

# ---------------------------------------------------------------------------------------------
# One entry per BINARY (not per transport protocol): "<lib name>:<go package>". Adding a 4th
# built binary is ONE line here — nothing else below names one. meek_lite is NOT listed: lyrebird
# registers it internally alongside obfs4 (transports/transports.go's Init(), upstream source), so
# it rides on libLyrebird.so with no separate package or build step — see pt.rs's binary_for().
# ---------------------------------------------------------------------------------------------
PACKAGES=(
  "Lyrebird:gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/lyrebird/cmd/lyrebird"
  "Snowflake:gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/snowflake/v2/client"
  # NOT .../webtunnel/main — "main" has no go.mod of its own, so that path is NOT a separate
  # module (`go get .../webtunnel/main@latest` fails: "no matching versions"). The module is
  # `.../webtunnel` (root go.mod: `module gitlab.torproject.org/.../webtunnel`), and `main/client`
  # is a plain subdirectory package inside it — confirmed against the extracted module source
  # (main/client/main.go, `package main`). The FULL package path below is what `go get` needs.
  "Webtunnel:gitlab.torproject.org/tpo/anti-censorship/pluggable-transports/webtunnel/main/client"
)

for entry in "${PACKAGES[@]}"; do
  pkg="${entry#*:}"
  echo ">> go get $pkg@latest"
  go get "$pkg@latest"
done

# -checklinkname=0 IS REQUIRED for lyrebird AND snowflake. Both pull in github.com/wlynxg/anet
# (lyrebird transitively through one of its obfsN deps; snowflake directly, via pion/ice's Android
# network-interface enumeration), which reaches into the runtime with //go:linkname against
# net.zoneCache. Go 1.23+ rejects that by default and the build dies with:
#   link: github.com/wlynxg/anet: invalid reference to net.zoneCache
# Verified on go1.26.4 — without this flag the build FAILS; with it, it links clean. webtunnel does
# NOT depend on anet (its go.sum lists only goptlib), so the flag is inert for it. Applying it to
# all three uniformly means this file does not need to track which PT happens to need it today.
#
# -extldflags=-Wl,-z,max-page-size=16384 IS REQUIRED for Android's 16KB-page devices (Pixel 9 and
# newer kernels). Go's external linker defaults every LOAD segment to 4 KB (0x1000) alignment; a
# device whose kernel page size is 16 KB refuses to mmap-load a binary whose segments are not
# aligned to ITS page size, and it fails at exec() time with an error that never mentions
# "alignment" — so an unaligned PT binary looks like an unrelated launch/spawn failure and the whole
# bridge ladder silently dies on that hardware. Verified empirically on this host (2026-07-27):
# without the flag, `llvm-readelf -l` reports Align=0x1000 on every LOAD segment; with it,
# Align=0x4000 (16384 decimal) on every LOAD segment, and ELF Type is unaffected (still DYN — this
# flag and -buildmode=pie are orthogonal). The DYN gate below has a matching alignment gate.
LDFLAGS="-s -w -checklinkname=0 -extldflags=-Wl,-z,max-page-size=16384"

# Cross-build one (transport, ABI) pair and enforce the PIE + page-alignment gates.
build_one() {
  local name="$1" pkg="$2" abi="$3" goarch="$4" cc="$5"
  local out="$JNILIBS/$abi/lib${name}.so"
  echo ">> $name / $abi ($goarch)…"
  # -buildmode=pie is mandatory (Android refuses non-PIE executables). Verify afterwards that
  # readelf reports Type: DYN, not EXEC.
  GOOS=android GOARCH="$goarch" CGO_ENABLED=1 CC="$NDK_BIN/$cc" \
    go build -buildmode=pie -trimpath \
      -ldflags="$LDFLAGS" \
      -o "$out" "$pkg"

  local t
  t="$("$NDK_BIN/llvm-readelf.exe" -h "$out" 2>/dev/null | awk '/Type:/{print $2}')"
  if [[ "$t" != "DYN" ]]; then
    echo "!! $name/$abi: ELF Type=$t — Android requires DYN (PIE). Refusing to ship." >&2
    exit 1
  fi

  # Every LOAD segment must be 16 KB (0x4000) aligned — see the LDFLAGS comment above for why. `sort
  # -u` collapses the per-segment values to one line ONLY if they all agree; anything else (a stray
  # 0x1000 segment, or a linker that ignored the flag) fails the comparison below.
  local aligns
  aligns="$("$NDK_BIN/llvm-readelf.exe" -l "$out" 2>/dev/null | awk '/^ *LOAD/{print $NF}' | sort -u)"
  if [[ "$aligns" != "0x4000" ]]; then
    echo "!! $name/$abi: LOAD segment align=[$aligns] — 16KB-page Android devices require 0x4000 on" \
         "every segment. Refusing to ship." >&2
    exit 1
  fi
  echo "   $name/$abi OK — $(wc -c < "$out") bytes, Type=DYN, Align=0x4000"
}

# Build every known PT for one ABI. Called once per ABI below so a run that dies partway through
# still leaves a fully-built ABI directory rather than one binary from each of two ABIs.
build_abi() {
  local abi="$1" goarch="$2" cc="$3"
  for entry in "${PACKAGES[@]}"; do
    build_one "${entry%%:*}" "${entry#*:}" "$abi" "$goarch" "$cc"
  done
}

# API 21 clang covers minSdk 24 (android/build.gradle → minSdkVersion = 24).
build_abi arm64-v8a   arm64 aarch64-linux-android21-clang.cmd
build_abi armeabi-v7a arm   armv7a-linux-androideabi21-clang.cmd

echo
echo ">> Done. StiqArtiModule must pass the ABSOLUTE path of each binary to Arti's PT config:"
echo "     applicationInfo.nativeLibraryDir + \"/lib<Name>.so\""
echo "   Do NOT copy any of them into filesDir first — that directory is not executable."

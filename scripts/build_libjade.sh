#!/bin/bash
#
# Build libjade (the Jade firmware as a native shared library) from the `jade`
# submodule and install it in firmware/, named after everything that defines it:
#
#   firmware/libjade-<version>-<platform>[-ci][-<type>][-nolog][-nocamera][-coverage][-selfcheck-<t>].so
#   eg. firmware/libjade-1.0.41-220-ga59d14c2-jade_v2.so          (the defaults)
#       firmware/libjade-1.0.41-220-ga59d14c2-jade_v1-ci-release.so
#
# next to a .json describing the build. Each variant is compiled out of tree in its own
# build/<variant>/ folder (the submodule stays clean), so variants are rebuilt
# independently. jade-web lists them all in its Device panel.
#
# Usage: scripts/build_libjade.sh [options]
#
#   --display v1|v2      emulated board: v1 = Jade v1 (240x135), v2 = Jade v2 (320x170, default)
#   --type TYPE          Debug (default), Release, RelWithDebInfo, MinSizeRel, or Sanitize
#                        (address/UB sanitizers; needs libasan preloaded to run).
#                        The type may also be given alone: scripts/build_libjade.sh Release
#   --ci                 CI mode: the firmware auto-confirms every prompt
#                        (default: interactive, waits for the buttons in the web UI)
#   --no-log             no firmware logging (default: logging compiled in)
#   --no-camera          no camera/QR scanner support (default: camera enabled)
#   --coverage           gcov profile coverage instrumentation
#   --selfcheck TEST     link libjade/selfcheck/TEST.c as the debug_selfcheck implementation
#                        (see jade/libjade/selfcheck/: assets, bcur, cbor, descriptor, task, urldecode)
#   --jobs N             parallel compile jobs (default: number of CPUs)
#   --path               only print where this variant's binary goes (no build)
#   --list               list the firmware binaries already built
#
# Requires IDF_PATH (ESP-IDF checkout, only its mbedtls/http_parser sources are
# used). Defaults to ~/esp/esp-idf when unset.
set -e

ROOT=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
JADE="$ROOT/jade"
FIRMWARE="$ROOT/firmware"

BUILD_TYPE="Debug"
JADE_DISPLAY="v2"
CI="0"
LOG="LOG"
CAMERA="CAMERA"
COVERAGE="OFF"
SELFCHECK=""
JOBS=$(nproc 2>/dev/null || echo 4)
PRINT_PATH=0

usage() { sed -n '2,/^set -e/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
    case "$1" in
        Debug|Release|RelWithDebInfo|MinSizeRel|Sanitize) BUILD_TYPE="$1" ;;
        --type) shift; BUILD_TYPE="$1" ;;
        --display) shift; JADE_DISPLAY="$1" ;;
        --ci) CI="CI" ;;
        --no-log) LOG="OFF" ;;
        --no-camera) CAMERA="OFF" ;;
        --coverage) COVERAGE="ON" ;;
        --selfcheck) shift; SELFCHECK="$1" ;;
        --jobs|-j) shift; JOBS="$1" ;;
        --path) PRINT_PATH=1 ;;
        --list)
            for f in "$FIRMWARE"/libjade-*.so "$FIRMWARE"/libjade-*.dylib; do
                [ -f "$f" ] && echo "$(basename "$f")  ($(du -h "$f" | cut -f1))"
            done
            exit 0 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1 (see --help)" >&2; exit 1 ;;
    esac
    shift
done

case "$BUILD_TYPE" in
    Debug|Release|RelWithDebInfo|MinSizeRel|Sanitize) ;;
    *) echo "Unknown build type $BUILD_TYPE" >&2; exit 1 ;;
esac
case "$JADE_DISPLAY" in
    v1) BOARD="jade-v1"; PLATFORM="jade_v1"; WIDTH=240; HEIGHT=135 ;;
    v2) BOARD="jade-v2"; PLATFORM="jade_v2"; WIDTH=320; HEIGHT=170 ;;
    *) echo "Unknown --display $JADE_DISPLAY (v1 or v2)" >&2; exit 1 ;;
esac
RESOLUTION="${WIDTH}x${HEIGHT}"     # as in jade/main/Kconfig.projbuild for that board
if [ -n "$SELFCHECK" ] && [ ! -f "$JADE/libjade/selfcheck/$SELFCHECK.c" ]; then
    echo "Unknown --selfcheck $SELFCHECK (see jade/libjade/selfcheck/)" >&2; exit 1
fi

# Firmware version: git describe of the jade submodule
VERSION=$(git -C "$JADE" describe --tags --always --dirty 2>/dev/null || echo unknown)
TYPE=$(echo "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')
# Every non-default option is part of the name (and of the build folder)
OPTS=""
if [ "$CI" != "0" ]; then OPTS="$OPTS-ci"; fi
if [ "$BUILD_TYPE" != "Debug" ]; then OPTS="$OPTS-$TYPE"; fi
if [ "$LOG" = "OFF" ]; then OPTS="$OPTS-nolog"; fi
if [ "$CAMERA" = "OFF" ]; then OPTS="$OPTS-nocamera"; fi
if [ "$COVERAGE" = "ON" ]; then OPTS="$OPTS-coverage"; fi
if [ -n "$SELFCHECK" ]; then OPTS="$OPTS-selfcheck-$SELFCHECK"; fi
EXT="so"; if [ "$(uname)" = "Darwin" ]; then EXT="dylib"; fi
OUT="$FIRMWARE/libjade-$VERSION-$PLATFORM$OPTS.$EXT"
BUILD="$ROOT/build/$BOARD$OPTS"
if [ "$PRINT_PATH" = 1 ]; then
    echo "$OUT"
    exit 0
fi

if [ -z "$IDF_PATH" ]; then
    export IDF_PATH="$HOME/esp/esp-idf"
fi
if [ ! -d "$IDF_PATH/components/mbedtls/mbedtls" ]; then
    echo "ESP-IDF not found at IDF_PATH=$IDF_PATH (needs components/mbedtls)." >&2
    echo "Install the version pinned in jade/Dockerfile (ESP_IDF_BRANCH) and set IDF_PATH." >&2
    exit 1
fi
echo "Using IDF_PATH=$IDF_PATH ($(cat "$IDF_PATH/version.txt" 2>/dev/null || echo unknown version))"

if [ ! -f "$JADE/CMakeLists.txt" ]; then
    echo "Initialising jade submodule..."
    git -C "$ROOT" submodule update --init --recursive
fi

# jade.church drives libjade's screen, buttons, camera and storage through the internal
# requests libjade gained in Jade 1.0.41 (commits 624ac60b "libjade: add gui support" and
# f7184945 "libjade: add camera/input/nvs support"). Older libjade (1.0.40 and before)
# only passes messages: it builds, but jade.church cannot start it. Stop here instead.
if ! grep -q '"get_display_size"' "$JADE/libjade/libjade.c"; then
    echo "The jade checkout ($VERSION) has no libjade screen support: jade.church needs" >&2
    echo "Jade 1.0.41 or later (libjade gained its display, buttons and storage there)." >&2
    exit 1
fi

# libjade compiles tinycbor from managed_components/, which normally only the
# ESP-IDF component manager (idf.py) populates. Fetch just that component, at the
# version pinned in jade's dependencies.lock.
CBOR_DIR="$JADE/managed_components/espressif__cbor"
if [ ! -d "$CBOR_DIR/tinycbor/src" ]; then
    CBOR_VER=$(grep -A12 '^  espressif/cbor:' "$JADE/dependencies.lock.esp32" | sed -n 's/^    version: *//p' | head -1)
    CBOR_VER=${CBOR_VER:-0.6.1~4}
    CBOR_URL="https://components-file.espressif.com/components/espressif/cbor/${CBOR_VER}/espressif__cbor-v${CBOR_VER/\~/_}.zip"
    echo "Fetching espressif/cbor $CBOR_VER ..."
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "$CBOR_URL" -o "$TMP/cbor.zip"
    mkdir -p "$CBOR_DIR"
    python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TMP/cbor.zip" "$CBOR_DIR"
fi

# Emulated screen size. libjade itself hard-codes 320x200 in libjade/include/sdkconfig.h
# (and Jade's CMake ignores JADE_DISPLAY), so without this every board got the same
# 320x200 screen. libjade's include path lists its build folder before libjade/include,
# so an sdkconfig.h written there wins: it includes the original and overrides only the
# display size. The submodule stays untouched.
mkdir -p "$BUILD/libjade"
{
    echo "// Generated by scripts/build_libjade.sh for --display $JADE_DISPLAY: do not edit."
    echo "#ifndef _JADE_WEB_SDKCONFIG_H_"
    echo "#define _JADE_WEB_SDKCONFIG_H_ 1"
    echo "#include \"$JADE/libjade/include/sdkconfig.h\""
    echo "#undef CONFIG_DISPLAY_WIDTH"
    echo "#undef CONFIG_DISPLAY_HEIGHT"
    echo "#define CONFIG_DISPLAY_WIDTH $WIDTH"
    echo "#define CONFIG_DISPLAY_HEIGHT $HEIGHT"
    echo "#endif"
} > "$BUILD/libjade/sdkconfig.h.new"
# only replace it when it changed, so an unchanged variant is not fully recompiled
if cmp -s "$BUILD/libjade/sdkconfig.h.new" "$BUILD/libjade/sdkconfig.h"; then
    rm "$BUILD/libjade/sdkconfig.h.new"
else
    mv "$BUILD/libjade/sdkconfig.h.new" "$BUILD/libjade/sdkconfig.h"
fi

echo "Building $(basename "$OUT") in ${BUILD#"$ROOT"/} ..."
# libjade embeds only the large status bar logo (libjade/icons.inc), made for screens at
# least 170 pixels tall: on the 135-pixel Jade v1 screen drawing it fails an assertion and
# the firmware aborts. The real firmware picks statusbar_small below 170 (main/CMakeLists.txt).
# So the build compiles from an overlay: build/<variant>/src/ links to every jade/ entry,
# except that its libjade/ links every file but icons.inc, generated here with the
# status bar for this screen (same format as jade/libjade/make_icons.py).
SRC="$BUILD/src"
if [ "$HEIGHT" -ge 170 ]; then STATUSBAR=statusbar_large; else STATUSBAR=statusbar_small; fi
rm -rf "$SRC"
mkdir -p "$SRC/libjade"
for entry in "$JADE"/* "$JADE"/.[!.]*; do
    [ -e "$entry" ] || continue
    [ "$(basename "$entry")" = libjade ] || ln -s "$entry" "$SRC/"
done
for entry in "$JADE"/libjade/*; do
    [ "$(basename "$entry")" = icons.inc ] || ln -s "$entry" "$SRC/libjade/"
done
python3 -I -c '
import sys
data = open(sys.argv[1], "rb").read()
var = "_binary_statusbar_large_bin_gz"   # the name libjade (main/gui.c) refers to
print(f"// Generated by scripts/build_libjade.sh from logo/{sys.argv[2]}.bin.gz: do not edit.")
print(f"const uint8_t {var}_start[{len(data)}] = {{")
print(",\n".join(", ".join(hex(b) for b in data[i:i + 19]) for i in range(0, len(data), 19)))
print(f"}};\nconst uint8_t* {var}_end = {var}_start + {len(data)};")
' "$JADE/logo/$STATUSBAR.bin.gz" "$STATUSBAR" > "$SRC/libjade/icons.inc"
# a build folder configured from another source path must be reconfigured from scratch
if [ -f "$BUILD/CMakeCache.txt" ] && ! grep -qx "CMAKE_HOME_DIRECTORY:INTERNAL=$SRC" "$BUILD/CMakeCache.txt"; then
    rm -rf "$BUILD/CMakeCache.txt" "$BUILD/CMakeFiles"
fi

cmake -S "$SRC" -B "$BUILD" \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" -DJADE_DISPLAY="$JADE_DISPLAY" -DCI="$CI" \
    -DLOG="$LOG" -DCAMERA="$CAMERA" -DCOVERAGE="$COVERAGE" -DSELFCHECK="$SELFCHECK"
cmake --build "$BUILD" -j"$JOBS"

mkdir -p "$FIRMWARE"
# copy then rename: a running jade-web keeps using the old file (rewriting a loaded
# library in place can crash it); the new one is picked up on its next start
cp "$BUILD/libjade/libjade.$EXT" "$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
python3 -I -c '
import json, sys, time
(board, display, res, version, ci, build_type, log, camera, coverage, selfcheck,
 idf, out, name) = sys.argv[1:]
json.dump({"file": name, "board": board, "display": display, "resolution": res,
           "jade_version": version, "ci": ci != "0", "build_type": build_type,
           "options": {"log": log != "OFF", "camera": camera != "OFF", "coverage": coverage == "ON",
                       "selfcheck": selfcheck or None},
           "esp_idf": idf, "built": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, open(out, "w"), indent=1)
' "$BOARD" "$JADE_DISPLAY" "$RESOLUTION" "$VERSION" "$CI" "$BUILD_TYPE" "$LOG" "$CAMERA" \
  "$COVERAGE" "$SELFCHECK" \
  "$(cat "$IDF_PATH/version.txt" 2>/dev/null || git -C "$IDF_PATH" describe --tags 2>/dev/null || echo unknown)" \
  "$OUT.json" "$(basename "$OUT")"

echo
echo "Built: $OUT"

#!/bin/bash
#
# Build libjade if needed, then start the jade-web server.
#
#   ./run.sh [server options]      e.g. ./run.sh --port 8642 --bridge-port 30121
#   ./run.sh --rebuild [...]       rebuild the firmware (BUILD_ARGS variant) and run it
#
# Build options can be passed via env: BUILD_ARGS="Release --display v1" ./run.sh
# (each variant is kept in firmware/; ./run.sh --lib firmware/<file> runs a specific one;
#  all build options: scripts/build_libjade.sh --help)
# All other options go to server/jade_web.py (see ./run.sh --help).
set -e
ROOT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)

if [ -t 1 ]; then
    GREEN='\033[0;32m'; BLUE='\033[0;34m'; RESET='\033[0m'
else
    GREEN=''; BLUE=''; RESET=''
fi
info() { printf "${BLUE}==>${RESET} %s\n" "$*"; }
success() { printf "${GREEN}✓${RESET} %s\n" "$*"; }

# Keep jade-web's Python dependencies isolated from the system interpreter.
VENV="$ROOT/venv"
if [ ! -x "$VENV/bin/python" ]; then
    info "Creating local Python environment at venv/"
    python3 -m venv "$VENV"
    "$VENV/bin/python" -m pip install --upgrade pip
    "$VENV/bin/python" -m pip install -r "$ROOT/requirements.txt"
    success "Python dependencies installed"
fi

# Firmware: binaries live in firmware/, named after board, version and build options
# (scripts/build_libjade.sh --help). Without BUILD_ARGS the server starts the highest
# version there (switch in the Device panel); a build is made only if there is none.
# With BUILD_ARGS that variant is used, and built if missing.
# shellcheck disable=SC2086
VARIANT=$("$ROOT/scripts/build_libjade.sh" --path $BUILD_ARGS)
HAVE_ANY=$(ls "$ROOT"/firmware/libjade-*.so "$ROOT"/firmware/libjade-*.dylib 2>/dev/null | head -1)

USER_LIB=0
for a in "$@"; do if [ "$a" = "--lib" ]; then USER_LIB=1; fi; done

REBUILD=0
if [ "$1" = "--rebuild" ]; then REBUILD=1; shift; fi
if [ "$REBUILD" = 1 ] || { [ "$USER_LIB" = 0 ] && { [ -z "$HAVE_ANY" ] || { [ -n "$BUILD_ARGS" ] && [ ! -f "$VARIANT" ]; }; }; }; then
    # shellcheck disable=SC2086
    "$ROOT/scripts/build_libjade.sh" $BUILD_ARGS
fi

LIB_ARGS=()
if [ "$USER_LIB" = 0 ] && { [ -n "$BUILD_ARGS" ] || [ "$REBUILD" = 1 ]; }; then LIB_ARGS=(--lib "$VARIANT"); fi

success "Starting jade-web"
exec "$VENV/bin/python" "$ROOT/server/jade_web.py" "${LIB_ARGS[@]}" "$@"

#!/bin/bash
#
# Start the jade-web server with a firmware already in firmware/ (no build, no ESP-IDF).
#
#   ./run.sh [server options]      e.g. ./run.sh --port 8642 --bridge-port 30121
#   ./run.sh --lib firmware/<file> run a specific firmware binary
#
# All options go to server/jade_web.py (see ./run.sh --help).
# To build firmware: scripts/build_libjade.sh --help (needs ESP-IDF).
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

# Firmware: run.sh never builds (building needs ESP-IDF, see scripts/build_libjade.sh).
# The server starts the highest version in firmware/ (switch in the Device panel),
# or the one given with --lib.
HAVE_ANY=$(ls "$ROOT"/firmware/libjade-*.so "$ROOT"/firmware/libjade-*.dylib 2>/dev/null | head -1)
USER_LIB=0
for a in "$@"; do if [ "$a" = "--lib" ]; then USER_LIB=1; fi; done
if [ "$USER_LIB" = 0 ] && [ -z "$HAVE_ANY" ]; then
    echo "No firmware in firmware/. Build one with scripts/build_libjade.sh (needs ESP-IDF)," >&2
    echo "or copy a libjade-*.so (and its .json) there." >&2
    exit 1
fi

success "Starting jade-web"
exec "$VENV/bin/python" "$ROOT/server/jade_web.py" "$@"

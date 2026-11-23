#!/usr/bin/env bash
# OhMyGame — build the app, then open the desktop window.
#
#   ./start.sh             build, then open the desktop app
#   ./start.sh --no-build  open what is already built
#   ./start.sh --clean     drop the previous build first, then build
#   ./start.sh --dev       hot-reloading dev server in the browser (no build)
#
# Environment, all optional:
#   OHMYGAME_NO_SANDBOX=1   pass --no-sandbox --disable-gpu to Electron, for
#                           shells that block Chromium's own sandbox
#   OHMYGAME_KEEP_PROXY=1   keep http(s)_proxy, which breaks the downloads
#                           below when it terminates TLS itself
#   ELECTRON_MIRROR=...     where to fetch Electron from
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  cat <<'EOF'
Usage: ./start.sh [options]

  (no option)   build the app, then open the desktop window
  --no-build    open the built app without rebuilding
  --clean       remove the previous build before building
  --dev         run the dev server (daemon + renderer, hot reload) in the browser
  -h, --help    show this message

Environment:
  OHMYGAME_NO_SANDBOX=1  add --no-sandbox --disable-gpu for sandboxed shells
  OHMYGAME_KEEP_PROXY=1  keep the proxy settings (they break the downloads here)
  ELECTRON_MIRROR=URL    mirror to download Electron from
EOF
}

build=1
clean=0
dev=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --clean) clean=1 ;;
    --dev) dev=1; build=0 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "start.sh: unknown option '$arg'" >&2
      echo "Try ./start.sh --help" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() {
  printf '\n\033[31mstart.sh: %s\033[0m\n' "$1" >&2
  exit 1
}

# The app's toolchain is Bun, which a machine may only have where its installer
# put it. Node runs the build's scripts.
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in \
    "$HOME/.bun/bin/bun" \
    "$HOME/.workbuddy/binaries/bun/bin/bun" \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

BUN=$(find_bun) || die "bun is not installed. Install it from https://bun.sh, then run this again."
command -v node >/dev/null 2>&1 || die "node is not installed. Node 22.19 or newer is required."

# A proxy that intercepts TLS fails every download below with an unknown
# issuer, and ELECTRON_RUN_AS_NODE turns Electron into plain Node, where the
# app's main process has no `electron.app`.
if [ "${OHMYGAME_KEEP_PROXY:-0}" != "1" ]; then
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
fi
unset ELECTRON_RUN_AS_NODE

export PATH="$(dirname "$BUN"):$PATH"

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "node $(node -v) is too old; Node 22.19 or newer is required."

if [ "$dev" = "1" ]; then
  step "Starting the dev server (http://127.0.0.1:43120)"
  exec "$BUN" run dev
fi

# Dependencies, and the Electron binary Bun does not fetch by itself.
if [ ! -d node_modules ]; then
  step "Installing dependencies"
  "$BUN" install --frozen-lockfile
fi

if [ ! -d node_modules/electron/dist ]; then
  step "Downloading Electron"
  ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
    node node_modules/electron/install.js
fi

# ffmpeg-static's install script needs the network too; without the binary the
# app still opens, but media tools fail.
if [ ! -f node_modules/ffmpeg-static/ffmpeg ]; then
  step "Downloading ffmpeg"
  (cd node_modules/ffmpeg-static && node install.js) || printf '\033[33m  skipped: %s\033[0m\n' "ffmpeg unavailable, media tools will ask for it"
fi

if [ "$clean" = "1" ]; then
  step "Removing the previous build"
  "$BUN" run clean:desktop-build
fi

if [ "$build" = "1" ]; then
  # `build:desktop-app` also clones the examples repository, which is often
  # unreachable and only fills Home's example shelf, so it is left out here.
  step "Building the app"
  "$BUN" run prepare:preinstalled-plugins
  "$BUN" run build:host
  "$BUN" run build:renderer
fi

[ -f dist/desktop/bootstrap.cjs ] || die "dist/desktop is missing. Run ./start.sh without --no-build first."
[ -f dist/renderer/index.html ] || die "dist/renderer is missing. Run ./start.sh without --no-build first."

step "Opening OhMyGame"
electron_args=(. --built-renderer)
if [ "${OHMYGAME_NO_SANDBOX:-0}" = "1" ]; then
  # Chromium's sandbox cannot start under some shells (containers, IDE agents).
  electron_args+=(--no-sandbox --disable-gpu)
fi
exec "$BUN" --bun node_modules/electron/cli.js "${electron_args[@]}"

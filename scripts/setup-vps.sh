#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 (x86_64 or arm64) machine to run the benchmark: Docker, the
# Node version in upstream/template/.nvmrc, project dependencies, the Opus baselines and the
# images. Run it from the project root, as a user who can sudo:
#
#   ssh user@host 'git clone --recursive https://github.com/pngwn/agent-framework-benchmark-pi.git'
#   ssh user@host 'cd agent-framework-benchmark-pi && ./scripts/setup-vps.sh'
#
# Then put HF_TOKEN and EXA_API_KEY in .env.local and start a grid in tmux:
#   tmux new -s grid 'node harness/run.mjs --frameworks=all --iterations=5 --parallel=6'
set -euo pipefail
cd "$(dirname "$0")/.."
SUDO=sudo
[ "$(id -u)" = 0 ] && SUDO=

$SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl git jq rsync tmux xz-utils > /dev/null
if ! command -v docker > /dev/null; then
  curl -fsSL https://get.docker.com | $SUDO sh
  if [ -n "$SUDO" ]; then
    $SUDO usermod -aG docker "$USER"
    echo "Added $USER to the docker group: log out and back in (or run 'newgrp docker'), then re-run this script."
    exit 0
  fi
fi

NODE_VERSION="$(cat upstream/template/.nvmrc)"
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" | $SUDO tar -xJ -C /usr/local --strip-components=1
fi
node --version

# rsync keeps the source machine's file owner; git refuses repos owned by someone else.
$SUDO chown -R "$(id -u):$(id -g)" .

# upstream/ must be a git repo: export-template.sh lists its files with git. It's a submodule
# in a clone of this repo; a copy made with rsync may carry it as a plain checkout instead.
if [ -f .gitmodules ] && git rev-parse --git-dir > /dev/null 2>&1; then
  git submodule update --init upstream
elif ! git -C upstream rev-parse HEAD > /dev/null 2>&1; then
  rm -rf upstream
  git clone -q https://github.com/nolanlawson/agent-framework-benchmark.git upstream
  git -C upstream checkout -q b95ada03930ca3670c8ff6377c3af815df0ac040
fi
chmod +x harness/*.mjs harness/container/*.sh harness/container/*.mjs analysis/*.mjs analysis/judge/*.mjs

npm install --no-audit --no-fund
node baselines/opus.mjs fetch
node analysis/analyze.mjs --opus > /dev/null
node harness/run.mjs --build-only
echo
echo "Ready. Disk: $(df -h / | tail -1 | awk '{print $4}') free, $(nproc) CPUs, $(free -g | awk '/Mem:/ {print $2}') GB RAM."
[ -f .env.local ] || echo "Next: create .env.local with HF_TOKEN and EXA_API_KEY."

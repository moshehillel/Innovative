#!/usr/bin/env bash
# Shared helper: make the repository's pinned Node.js (functions/package.json
# engines = 24) the active toolchain for the current shell.
#
# The Cloud Agent host injects a Node 22 binary early on PATH, so we load nvm
# and explicitly prepend the Node 24 bin directory. This is safe to source
# repeatedly (idempotent) and works in both build and interactive shells.
#
# This file is meant to be `source`d. It avoids `set -u` because nvm.sh
# references unset variables.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR; installing nvm..." >&2
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

# nvm.sh is not compatible with `set -u`; relax it while loading, then restore.
__had_nounset=0
case "$-" in *u*) __had_nounset=1 ;; esac
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

# Install Node 24 if the snapshot/base image does not already have it.
if ! nvm which 24 >/dev/null 2>&1; then
  nvm install 24 >/dev/null
fi

nvm use 24 >/dev/null
[ "$__had_nounset" = "1" ] && set -u
unset __had_nounset

NODE24_BIN="$(dirname "$(nvm which 24)")"
export PATH="$NODE24_BIN:$PATH"

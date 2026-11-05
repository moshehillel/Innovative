#!/usr/bin/env bash
# Idempotent repository bootstrap for the TAI invoice-automation Cloud Functions.
# Runs after checkout; safe to run repeatedly and against cached state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/env-common.sh"

echo "Using node $(node -v) / npm $(npm -v)"

# Firebase CLI (emulators, functions shell). Installed globally under the
# active Node 24 toolchain; skipped when already present.
if ! command -v firebase >/dev/null 2>&1; then
  echo "Installing firebase-tools..."
  npm install -g firebase-tools
fi
echo "firebase-tools $(firebase --version)"

# Project dependencies from the committed lockfile.
npm --prefix "$REPO_ROOT/functions" ci

echo "install.sh complete."

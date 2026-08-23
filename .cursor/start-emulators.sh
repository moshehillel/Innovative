#!/usr/bin/env bash
# Long-running Firebase Emulator Suite (Functions + Firestore) for local
# development. Uses a demo project id so the emulators run fully offline and
# require no GCP credentials. Calls to non-emulated services (BigQuery, Gmail,
# Anthropic, Document AI) still require real credentials/secrets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/env-common.sh"

cd "$REPO_ROOT"

exec firebase emulators:start \
  --only functions,firestore \
  --project "${FIREBASE_DEMO_PROJECT:-demo-tai}"

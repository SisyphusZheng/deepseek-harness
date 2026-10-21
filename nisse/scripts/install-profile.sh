#!/usr/bin/env bash
# Install the Nisse profile template into a DSH_HOME for isolated smoke tests.
# Usage: nisse/scripts/install-profile.sh <DSH_HOME> [profile-name]
set -euo pipefail
DSH_HOME="${1:?usage: install-profile.sh <DSH_HOME> [profile-name]}"
NAME="${2:-nisse-smoke}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
PROFILE_DIR="$DSH_HOME/profiles/$NAME"
mkdir -p "$PROFILE_DIR/node_modules"
cp "$ROOT/nisse/profile/package.json" "$PROFILE_DIR/package.json"
cp "$ROOT/nisse/profile/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
rm -rf "$PROFILE_DIR/node_modules/nisse-host-integration-placeholder"
ln -s "$ROOT/nisse/packages/host-integration-placeholder" "$PROFILE_DIR/node_modules/nisse-host-integration-placeholder"
echo "profile installed: $PROFILE_DIR"

#!/usr/bin/env bash
# Install the Nisse profile (M3 Host Integration v0) into a DSH_HOME.
# Usage: nisse/scripts/install-profile.sh <DSH_HOME> [profile-name] [write-tool true|false]
set -euo pipefail
DSH_HOME="${1:?usage: install-profile.sh <DSH_HOME> [profile-name] [write-tool true|false]}"
NAME="${2:-nisse-smoke}"
WRITE="${3:-false}"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
PROFILE_DIR="$DSH_HOME/profiles/$NAME"
mkdir -p "$PROFILE_DIR/node_modules"
cp "$ROOT/nisse/profile/package.json" "$PROFILE_DIR/package.json"
sed -e "s|__DSH_HOME__|$DSH_HOME|g" \
    -e "s|__FORK__|$ROOT|g" \
    -e "s|__FS_WRITE__|$WRITE|g" \
    "$ROOT/nisse/profile/cordis.patch.yml" > "$PROFILE_DIR/cordis.patch.yml"
rm -rf "$PROFILE_DIR/node_modules/nisse-host-integration" "$PROFILE_DIR/node_modules/nisse-host-integration-placeholder"
ln -s "$ROOT/nisse/packages/host-integration" "$PROFILE_DIR/node_modules/nisse-host-integration"
echo "profile installed: $PROFILE_DIR (write-tool=$WRITE)"

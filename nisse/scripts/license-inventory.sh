#!/usr/bin/env bash
# M2-6 license/SBOM baseline helper. Generates a local inventory for M2 review;
# full SBOM/legal review is M5/M6. Never commits node_modules content.
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
OUT="${1:-$ROOT/.nisse/license-inventory}"
mkdir -p "$OUT"
cd "$ROOT"
cp LICENSE THIRD_PARTY_NOTICES.md "$OUT/"
if command -v pnpm >/dev/null 2>&1; then
  pnpm licenses list --json > "$OUT/pnpm-licenses.json" 2> "$OUT/pnpm-licenses.err" || true
fi
sha256sum LICENSE THIRD_PARTY_NOTICES.md 2>/dev/null | tee "$OUT/SHA256SUMS" >/dev/null || shasum -a 256 LICENSE THIRD_PARTY_NOTICES.md | tee "$OUT/SHA256SUMS" >/dev/null
echo "license inventory: $OUT"

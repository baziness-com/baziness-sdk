#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/check-versions.mjs

(cd server-node && npm ci && npm test && npm run build && npm pack --dry-run)
(cd server-java && ./build.sh && mvn --batch-mode --no-transfer-progress clean verify)
(cd web && npm ci && npm test && npm run build && npm pack --dry-run)
(cd unity/tests/Baziness.Core.Tests && ./run-tests.sh)

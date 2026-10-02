#!/usr/bin/env bash
# Installs exact locked dependencies and builds every package and service the host runs, in
# dependency order (local packages are linked with file: references, so each must build first).
# Run as the naryx user from the repository checkout: deployments/aws/build.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
for dir in packages/protocol-types packages/adapter-core packages/adapters/evm packages/adapters/solana \
           packages/adapters/hyperliquid services/api services/solver services/keeper services/indexer; do
  echo "== $dir"
  (cd "$root/$dir" && npm ci --no-audit --no-fund && npm run build)
done
echo "build complete"

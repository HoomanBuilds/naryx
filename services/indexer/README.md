# services/indexer

Chain event indexing, venue fill reconciliation, finality and reorg handling, normalized receipt construction, and evidence-grade attribution.

Read-only with respect to every venue. Holds no signer and has no broadcast path.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Reverted, expired, and recovered packages are indexed and reported, not only successful ones.

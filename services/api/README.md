# services/api

Public API and the authoritative durable store for orders, quotes, authorizations, submission attempts, nonces, recovery state, and the outbox.

Owns the order and quote lifecycle, RFQ delivery, quote selection, preflight, domain action compilation, and settlement coordination.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

A user master key never enters this service. No mainnet write until the readiness gates pass.

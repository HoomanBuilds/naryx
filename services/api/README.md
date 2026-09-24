# services/api

Private backend-for-frontend for the operator terminal.

The service exposes deterministic package snapshots and previews plus injected boundaries for preparing unsigned Solana Devnet transactions and observing a submitted Devnet signature. The default process has no execution ports, so preparation and observation fail with `EXECUTION_UNAVAILABLE`.

Preparation accepts only a normalized cash-and-carry request. The injected port owns route compilation and returns an unsigned materialization. The HTTP boundary independently verifies the Devnet identity, plan kind, trader signer, zero signatures, wire size, resolved-account count, compute-unit cap, lookup commitments, and evidence before returning `DEVNET_UNSIGNED_REVIEW_REQUIRED`.

Observation is read-only and reports `SUBMITTED`, `FINALIZED`, `FAILED`, or `EXPIRED`. This service has no signer, wallet authority, transaction submission, simulation, broadcast, persistence, arbitrary instruction input, RPC URL input, or mainnet path.

It binds to loopback by default. Cross-origin browser access is allowed only for the exact configured terminal origin.

It may depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`. It must not depend on `apps/web`, `packages/sdk`, or another service's internals.

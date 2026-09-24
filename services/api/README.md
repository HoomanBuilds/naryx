# services/api

Private backend-for-frontend for the operator terminal.

The current service exposes only deterministic, read-only package snapshots and previews. It has no signer, wallet authority, persistence, submission endpoint, or mainnet path.

It binds to loopback by default. Cross-origin browser access is allowed only for the exact configured terminal origin.

It may depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`. It must not depend on `apps/web`, `packages/sdk`, or another service's internals.

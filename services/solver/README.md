# services/solver

Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation.

Reaches `services/api` over the published solver protocol only, so an independent solver can run the same path from outside this repository.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Being the reference implementation is not a network claim. Team-operated solver volume is reported separately from independent volume.

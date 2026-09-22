# services

Long-running Naryx runtimes. Each service owns one responsibility and talks to the others over a published protocol, never by importing their internals.

| Directory | Responsibility |
|---|---|
| `api/` | Public API and the authoritative order, quote, authorization, submission-attempt, nonce, recovery, and outbox store. Order and quote lifecycle, RFQ delivery, quote selection, preflight, domain action compilation, and settlement coordination. |
| `solver/` | Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation. |
| `indexer/` | Chain event indexing, venue fill reconciliation, finality and reorg handling, normalized receipt construction, and evidence-grade attribution. Read-only with respect to venues and holds no signer. |
| `keeper/` | Lifecycle and risk automation. Strategy health evaluation, pre-authorized rebalance, roll, scheduled exit, funding settlement, bounded recovery driving, and dependency and qualification monitoring. |

## Allowed dependencies

A service may depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

A service must not depend on `apps/web`, on `packages/sdk`, or on another service's internal modules.

Services sit above the adapters and below the web app. `services/solver` reaches `services/api` over the published solver protocol so an independent solver can run the same path from outside this repository.

## Rules

- A user master key never enters a service.
- `services/indexer` never holds a signer.
- A keeper action is bound to a signed condition, cost bound, risk bound, and expiry. A keeper never receives a general trading key.
- No mainnet write until the readiness gates pass.

Responsibilities, dependency direction, and build order are specified in the repository architecture document. These directories carry no package manifest until a slice has a real reason to add one, and that manifest comes from an official generator.

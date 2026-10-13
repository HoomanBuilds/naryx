# services

Long-running Naryx runtimes. Each service owns one responsibility and talks to the others over a published protocol, never by importing their internals. The first-party terminal is an API client, not a privileged execution process.

| Directory | Responsibility |
|---|---|
| [`api/`](api/README.md) | Public market API and the authoritative order, quote, authorization, submission-attempt, recovery, and outbox stores. It composes the terminal's preparation and lifecycle boundary. |
| [`solver/`](solver/README.md) | Reference solver runtime for direct and implied package quotes, quote signing, market depth, inventory limits, and capacity reservation. Its Hyperliquid testnet executor is a separately gated path. |
| [`indexer/`](indexer/README.md) | Read-only chain event projection, finality and reorg handling, normalized receipts, and accounting exports. It holds no venue signer. |
| [`keeper/`](keeper/README.md) | Reconciliation, dependency monitoring, bounded recovery, and pre-authorized lifecycle automation. It does not receive a general trading key. |

## Runtime flow

```text
Web terminal and external SDK
             |
             v
Public market API and private terminal API
             |                    \
             v                     v
      Solver quote protocol     Durable order and attempt stores
             |                     |
             v                     v
      Venue adapters        Keeper and indexer observation
                    \       /
                     v     v
                  Verified outcome and receipt
```

The API's public listener serves market data and the solver protocol. Its private listener serves operator terminal preparation and health. The solver signs quotes with an externally managed key; the keeper observes venue state and drives only bounded authorized actions; the indexer projects onchain evidence. A quote response, submission acknowledgement, and terminal settlement are different states.

## State and deployment

The API, solver, and keeper use explicit external database or journal paths. The EVM indexer stores event projections and reorg state. Service environment examples are in each workspace; generated runtime files and signing keys stay outside the repository. The [testnet go-live guide](../deployments/GO-LIVE.md) describes process startup, release-manifest generation, health checks, and the AWS host layout.

Run a service's focused suite from the repository root with `npm test --prefix services/api`, `npm test --prefix services/solver`, `npm test --prefix services/indexer`, or `npm test --prefix services/keeper`. Its workspace README lists the necessary environment variables and any live testnet dependencies.

## Allowed dependencies

A service may depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

A service must not depend on `apps/web`, on `packages/sdk`, or on another service's internal modules.

Services sit above the adapters and below the web app. `services/solver` reaches `services/api` over the published solver protocol so an independent solver can run the same path from outside this repository.

## Rules

- A user master key never enters a service.
- `services/indexer` never holds a signer.
- A keeper action is bound to a signed condition, cost bound, risk bound, and expiry. A keeper never receives a general trading key.
- No mainnet write until the readiness gates pass.

For implementation boundaries and no-mainnet-write rules, read [AGENTS.md](../AGENTS.md).

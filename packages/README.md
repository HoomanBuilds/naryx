# packages

Shared libraries define the protocol's portable language and the executable adapter boundaries. They are the lower half of the import graph, so nothing here reaches upward into a service or web app.

| Directory | Responsibility |
|---|---|
| `protocol-types/` | Protocol kernel. Canonical package, order, quote, route, receipt, recovery-receipt, and error schemas; canonical encoding and domain-separated hashing; exact integer arithmetic for decimals, lots, ticks, spread, margin, and fees; terminal states; evidence grades; golden test vectors. |
| `adapter-core/` | The adapter contract every domain implements. Adapter interface and versioning, supported and unsupported operation declarations, dependency identity and code-hash binding, evidence grades, `PackageResourcePlan`, settlement-class capability declarations, and normalized fill, fee, and state-delta shapes. Contains no venue-specific code. |
| `adapters/solana/` | Solana venue adapters. Spot and perpetual routes, instruction construction, account resolution, address-lookup-table planning, return-data decoding, resource-plan emission, and `naryx_core` client bindings generated from the published IDL. |
| `adapters/evm/` | EVM venue adapters. Spot and perpetual routes, calldata construction, smart-account batch assembly, transient-context binding, EIP-712 payload construction, event decoding, and resource-plan emission. Base first, later EVM domains after. |
| `adapters/hyperliquid/` | HyperCore adapter. Batched IOC action construction, deterministic client order IDs, master authorization payloads, API-wallet identity and expiry checks, write-ahead journal records, nonce and clock-drift evidence, per-fill fee and net-delta reconciliation, exact and bounded quantity policy, residual computation, and the bounded recovery state machine. |
| [`sdk/`](sdk/README.md) | Public TypeScript client and solver SDK. Market reads, quote and order actions, evidence verification, RFQs, auctions, maker automation, and streams over the public API. |

## A strategy through the libraries

1. `protocol-types` defines the signed order, quote, route, domain reference, settlement class, and receipt hashes. Exact asset amounts stay as integer atoms.
2. `adapter-core` specifies what a domain compiler must declare: supported operations, resource requirements, state deltas, and evidence grades.
3. A concrete adapter compiles only the actions supported by its reviewed runtime and exact domain manifest. It does not infer cross-domain atomicity.
4. The API and solver compose adapters at the service layer. The SDK reaches the published API and verifies the response rather than importing a service implementation.

An asset, market, venue instance, or new chain under an existing runtime class is registered through an immutable manifest and delayed domain record. A new adapter class or settlement class needs code and tests before its manifest can be active.

## Allowed dependencies

```text
protocol-types  -> nothing in this repository
adapter-core    -> protocol-types
adapters/*      -> adapter-core, protocol-types, deployments
sdk             -> protocol-types, type-only imports from adapter-core
```

An adapter never imports a sibling adapter. Cross-domain behavior is composed by a service.

`sdk` never imports a concrete adapter, a service, or `apps/web`. Keeping it thin is what makes the reference integration prove that no terminal-specific code is required.

Nothing here imports a service, `apps/web`, `contracts/*` source, or `tests`.

## Hyperliquid placement

Hyperliquid has no Naryx smart contract. All Hyperliquid logic lives in `adapters/hyperliquid` and in the execution services that drive it. Neither `contracts/solana` nor `contracts/evm` may contain Hyperliquid code, identifiers, addresses, or assumptions.

## Build and inspect

Each workspace has its own package manifest and lockfile. From the repository root, install and check only the layer being changed:

```bash
npm ci --prefix packages/protocol-types
npm test --prefix packages/protocol-types
npm ci --prefix packages/sdk
npm test --prefix packages/sdk
```

The individual [adapter guides](adapters/README.md), [protocol type guide](protocol-types/README.md), and [SDK guide](sdk/README.md) describe their capabilities and evidence limits. The full dependency and extension policy is in [AGENTS.md](../AGENTS.md).

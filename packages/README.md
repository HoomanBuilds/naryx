# packages

Shared libraries. This is the lower half of the dependency graph, so nothing here may reach upward into a service or an app.

| Directory | Responsibility |
|---|---|
| `protocol-types/` | Protocol kernel. Canonical package, order, quote, route, receipt, recovery-receipt, and error schemas; canonical encoding and domain-separated hashing; exact integer arithmetic for decimals, lots, ticks, spread, margin, and fees; terminal states; evidence grades; golden test vectors. |
| `adapter-core/` | The adapter contract every domain implements. Adapter interface and versioning, supported and unsupported operation declarations, dependency identity and code-hash binding, evidence grades, `PackageResourcePlan`, settlement-class capability declarations, and normalized fill, fee, and state-delta shapes. Contains no venue-specific code. |
| `adapters/solana/` | Solana venue adapters. Spot and perpetual routes, instruction construction, account resolution, address-lookup-table planning, return-data decoding, resource-plan emission, and `naryx_core` client bindings generated from the published IDL. |
| `adapters/evm/` | EVM venue adapters. Spot and perpetual routes, calldata construction, smart-account batch assembly, transient-context binding, EIP-712 payload construction, event decoding, and resource-plan emission. Base first, later EVM domains after. |
| `adapters/hyperliquid/` | HyperCore adapter. Batched IOC action construction, deterministic client order IDs, master authorization payloads, API-wallet identity and expiry checks, write-ahead journal records, nonce and clock-drift evidence, per-fill fee and net-delta reconciliation, exact and bounded quantity policy, residual computation, and the bounded recovery state machine. |
| `sdk/` | Public TypeScript client SDK. Quote, authorize, preflight, submit, watch, recover, and exit against the public API, plus receipt verification helpers. |

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

Responsibilities, dependency direction, and build order are specified in the repository architecture document. These directories carry no package manifest until a slice has a real reason to add one, and that manifest comes from an official generator.

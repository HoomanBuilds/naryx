# packages/adapters/hyperliquid

HyperCore adapter. Batched IOC action construction, deterministic client order IDs, master authorization payloads, API-wallet identity and expiry checks, write-ahead journal records, nonce and clock-drift evidence, per-fill fee and net-delta reconciliation, exact and bounded quantity policy, residual computation, and the bounded recovery state machine.

May depend on `packages/adapter-core`, `packages/protocol-types`, and `deployments`.

Must not depend on `packages/adapters/solana`, `packages/adapters/evm`, a service, `apps/web`, `packages/sdk`, or `contracts/*` source.

## Why Hyperliquid lives here and not in a contract workspace

Hyperliquid has no Naryx smart contract. Its guarantee is a signed bounded-recovery policy, not a rollback boundary. All Hyperliquid logic belongs to this adapter and to the execution services that drive it (`services/api`, `services/solver`, `services/keeper`). Neither `contracts/solana` nor `contracts/evm` may contain Hyperliquid code, identifiers, addresses, or assumptions.

A batched HyperCore action is never described as atomic or fill-or-kill.

## Current implementation

`HyperliquidExecutionPlanner` is a pure, testnet-only compiler. It accepts a validated package admission plus exact series, execution-class, adapter, venue, and market bindings. It emits the unsigned fields for one official-shape HyperCore `order` action containing separate spot and perpetual IOC orders.

The plan commits the domain, series manifest, execution-class manifest, order, quote, and route. It derives deterministic 128-bit client order IDs, preserves an exact signed perpetual target independently from gross spot quantity, and carries either an exact or bounded terminal residual policy. The guarantee is batched IOC execution with bounded recovery.

This package has no network client, signing key, signature construction, nonce allocation, or broadcast path.

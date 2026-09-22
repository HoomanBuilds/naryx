# packages/adapters/evm

EVM venue adapters. Spot and perpetual routes, calldata construction, smart-account batch assembly, transient-context binding, EIP-712 payload construction, event decoding, and resource-plan emission. Base first, later EVM domains after their own gates pass.

May depend on `packages/adapter-core`, `packages/protocol-types`, and `deployments`.

Must not depend on `packages/adapters/solana`, `packages/adapters/hyperliquid`, a service, `apps/web`, `packages/sdk`, or `contracts/evm` source.

Proxy, beacon, implementation, admin, and account identities are pinned from `deployments` and monitored, never inferred at runtime.

# packages/adapters/solana

Solana venue adapters. Spot and perpetual routes, instruction construction, account resolution, address-lookup-table planning, return-data decoding, resource-plan emission, and `naryx_core` client bindings generated from the published IDL.

May depend on `packages/adapter-core`, `packages/protocol-types`, and `deployments`.

Must not depend on `packages/adapters/evm`, `packages/adapters/hyperliquid`, a service, `apps/web`, `packages/sdk`, or `contracts/solana` source.

Every compilation emits a resource plan covering serialized size, resolved accounts, compute estimate, CPI depth, loaded account data, and lookup-table dependencies. A route that exceeds the envelope is rejected or demoted to an honestly weaker settlement class.

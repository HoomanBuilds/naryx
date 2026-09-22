# packages/adapters

One directory per execution domain. Each implements the contract defined in `packages/adapter-core`.

| Directory | Domain |
|---|---|
| `solana/` | Solana venue adapters and `naryx_core` client bindings |
| `evm/` | EVM venue adapters, Base first |
| `hyperliquid/` | HyperCore execution and bounded recovery |

An adapter may depend on `packages/adapter-core`, `packages/protocol-types`, and `deployments`.

An adapter must not depend on a sibling adapter, a service, `apps/web`, `packages/sdk`, or `contracts/*` source. Cross-domain behavior is composed by a service, never by an adapter importing a sibling.

Contract artifacts are consumed from `deployments`, not from the contract workspaces directly.

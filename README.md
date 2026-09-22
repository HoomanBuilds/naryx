# Naryx

**Naryx, the Complex Order Network.** Trade the strategy, not the legs.

Naryx is open execution and clearing infrastructure for complete onchain financial strategies. An application submits one typed strategy package instead of a sequence of unrelated venue orders. Solvers compete to price and execute the whole package. The protocol enforces the user's signed limits, coordinates every leg under an explicit settlement class, drives permitted recovery, and publishes a verifiable receipt.

The first template is cash-and-carry: buy spot, short the matching perpetual, manage the position, and exit both legs through the same protocol.

Settlement guarantees are named, never implied. On domains where all legs share one rollback boundary, every leg succeeds together or reverts. On domains without atomic composition, the user signs exact intermediate-risk, completion, rollback, and deadline limits before execution, and the result is reported as exact or explicitly bounded. Independent chains are never described as atomically composable.

## Status

**Pre-mainnet. Testnet, devnet, local, and read-only only.**

This repository performs no mainnet writes. It does not deploy, upgrade, approve, transfer, bridge, deposit, withdraw, open or close a position, fund a reservation or bond, or sign a mainnet payload for later broadcast. Read-only mainnet RPC and API calls are permitted and carry no signer.

Environment promotion order:

1. local deterministic
2. public devnet and testnet
3. pinned production-state clone or fork
4. read-only shadow mainnet
5. capped mainnet, only after the readiness gates pass under an approved funds manifest

Promotion is one way and is granted per domain, adapter, template, settlement class, quote mode, and size cohort.

This is a foundation checkout. The workspaces below are official generator output plus boundary definitions. No protocol business logic is implemented yet.

## Component map

| Path | Responsibility |
|---|---|
| `apps/web` | Package terminal. Order construction, quote comparison, pre-sign review, execution progress, recovery, lifecycle, receipts. |
| `contracts/solana` | Anchor workspace containing the `naryx_core` program: package verification, pre-state and post-state enforcement, nonce state, adapter allowlist, event emission. |
| `contracts/evm` | Foundry workspace for the EVM package verifier, pinned venue adapter contracts, transient execution context, and versioned events. |
| `services/api` | Public API and the authoritative order, quote, authorization, nonce, recovery, and outbox store. Lifecycle, RFQ delivery, preflight, settlement coordination. |
| `services/solver` | Reference solver runtime. Market data, quote generation, cost modelling, quote signing, inventory and exposure limits. |
| `services/indexer` | Chain and venue indexing, fill reconciliation, finality and reorg handling, normalized receipts. Read-only, no signer. |
| `services/keeper` | Lifecycle and risk automation under signed conditions, cost bounds, risk bounds, and expiries. |
| `packages/protocol-types` | Protocol kernel. Canonical schemas, domain-separated hashing, exact integer arithmetic, terminal states, evidence grades, golden vectors. |
| `packages/adapter-core` | The adapter contract every domain implements. Interface, versioning, dependency identity, evidence grades, resource plan. |
| `packages/adapters/solana` | Solana venue adapters and `naryx_core` client bindings. |
| `packages/adapters/evm` | EVM venue adapters, Base first. |
| `packages/adapters/hyperliquid` | HyperCore execution, journaling, reconciliation, and bounded recovery. |
| `packages/sdk` | Public TypeScript client SDK. Quote, authorize, preflight, submit, watch, recover, exit. |
| `deployments` | Data only. Program IDs, addresses, ABIs, IDLs, code hashes, pinned dependency identities, environment manifests. |
| `tests` | Cross-workspace conformance, integration, fork, and fault-injection evidence. |

### Dependency direction

Three relations are tracked separately, because a code import, an artifact read, and a network call are not the same edge.

Compile-time imports, where `A -> B` means B imports A:

```text
packages/protocol-types -> packages/adapter-core
packages/adapter-core   -> packages/adapters/{solana,evm,hyperliquid}
packages/adapters/*     -> services/{api,solver,indexer,keeper}
packages/protocol-types -> packages/sdk
packages/adapter-core   -> packages/sdk   (types only)
packages/sdk            -> apps/web
```

Artifact publication, where `A -> B` means B reads A as data:

```text
contracts/solana -> deployments
contracts/evm    -> deployments
deployments      -> packages/adapters/*, services/*, apps/web, tests
```

Runtime calls, where `A -> B` means A calls B over the network:

```text
apps/web     -> services/api   (public API)
packages/sdk -> services/api   (public API)
```

Test consumption, where `A -> B` means B exercises A:

```text
every workspace -> tests
```

`packages/protocol-types` depends on nothing in this repository, and neither does `deployments`, which is data only and is consumed rather than imported. `contracts/solana` and `contracts/evm` depend on nothing in this repository and publish their IDLs, ABIs, and identities into `deployments`. `packages/sdk` depends on `packages/protocol-types` and `packages/adapter-core` types only, never on an adapter or a service's internals, and reaches `services/api` over the public API. `apps/web` does the same. An adapter never imports a sibling adapter. `tests` may consume every workspace and nothing depends on it.

Hyperliquid has no Naryx smart contract. Its logic lives in `packages/adapters/hyperliquid` and the execution services that drive it, never in either contract workspace.

Build order is contract-first: `packages/protocol-types`, then `contracts/solana` and `contracts/evm`, then `packages/adapter-core` and the adapters, then `services/*`, then `packages/sdk`, then `apps/web`.

## Setup

Requires Node.js with npm, the Rust toolchain, the Anchor CLI, the Solana CLI, and Foundry.

Every workspace that an official generator can produce was produced by one. Package manifests are never hand-authored. Run from the repository root, the sequence that reproduces this layout is:

```bash
mkdir -p contracts
(cd contracts && anchor init naryx_core --package-manager npm --template multiple --test-template litesvm --no-git)
mv contracts/naryx_core contracts/solana

forge init contracts/evm --empty --use-parent-git --no-git

npx create-next-app@latest apps/web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git
```

`anchor init` takes a workspace name, not a path, and uses that name for both the directory and the program. It therefore generates `contracts/naryx_core`, which is renamed to `contracts/solana`. The program keeps the name `naryx_core`, so `Anchor.toml`, `programs/naryx_core`, and `declare_id!` are untouched by the rename. `forge init` and `create-next-app` take the target path directly and need no move.

Each `anchor init` run generates a fresh program keypair and a matching declared ID, so re-running this sequence produces a different ID from the one committed here. See Validation below.

Install dependencies:

```bash
npm install --prefix contracts/solana
npm install --prefix apps/web
```

## Validation

Solana program:

```bash
cd contracts/solana && anchor build --ignore-keys
cd contracts/solana && cargo test
```

`cargo test` is the test command declared by the scaffold in `Anchor.toml`. The LiteSVM tests run in process and need no local validator; they load the built program at the declared ID, so they do not depend on the deploy keypair.

Program keypairs are never committed. The one under `contracts/solana/target/deploy` is ignored build output and is regenerated per checkout, so a fresh clone's keypair never matches the ID declared in `Anchor.toml` and `programs/naryx_core/src/lib.rs`. That declared ID is a scaffold-only local identity, not a deployed program, so pre-deployment validation skips the keypair check with `--ignore-keys`.

A reviewed devnet or testnet deployment is what ends that state. It supplies an externally managed program keypair into ignored build output, runs `anchor keys sync`, commits only the resulting public ID change, and then verifies an ordinary `anchor build` without `--ignore-keys` against that injected keypair. No deployment has happened and none is authorized yet.

EVM contracts:

```bash
cd contracts/evm && forge build
cd contracts/evm && forge test
```

Web terminal:

```bash
npm run lint --prefix apps/web
npm run build --prefix apps/web
```

## Contributing

Read `AGENTS.md` before changing anything. It is the authoritative repository policy. A framework's own `AGENTS.md` inside a workspace is generator output and covers that framework only.

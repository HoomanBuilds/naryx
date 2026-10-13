# deployments

Data only. No executable business logic.

Holds per-network deployment identity and the published artifacts that make a run reproducible:

- program IDs and contract addresses;
- ABIs and IDLs published from `contracts/evm` and `contracts/solana`;
- code hashes, deployment slots and blocks, and upgrade-authority state;
- proxy, beacon, implementation, and admin graphs where applicable;
- pinned external dependency identities and reviewed source revisions;
- generated parity environment manifests.

## Current testnet release index

| Environment | Recorded artifact | Execution semantics |
|---|---|---|
| Solana Devnet | [Cash-and-carry](solana/devnet/release.json), [multi-strategy](solana/devnet/multi-strategy-release.json) | Same-transaction postcondition checks with test inventory and a test perpetual. |
| Base Sepolia | [Atomic package](evm/base-sepolia/release.json), [multi-strategy](evm/base-sepolia/multi-strategy-release.json) | Atomic package verification with seeded test spot liquidity and a conformance perpetual. |
| Arbitrum Sepolia | [Bonded GMX route](evm/arbitrum-sepolia/release.json) | Callback-driven entry and exit with bounded asynchronous recovery. |
| Hyperliquid Testnet | [Operator template](hyperliquid/testnet/README.md) | Adapter and service execution; no Naryx contract is deployed. |

Each JSON record is an evidence artifact, not an assertion of organic trading or independent maker participation. Read its `limitations` and `activationState` before citing it. `conformance/` ABI and IDL files support reproducible tests and are not themselves deployment records.

## Allowed dependencies

Depends on nothing. Consumed by `packages/adapters/*`, `services/*`, `apps/web`, and `tests`.

## Rules

- Never contains a private key, mnemonic, API credential, or any other secret.
- Local and ephemeral deployment records are ignored by Git. Only intentional, reproducible release artifacts are committed.
- A recorded mainnet identity is evidence of what exists, not authorization to write to it. No mainnet write until the readiness gates pass.
- Environments are recorded in promotion order: local deterministic, devnet and testnet, pinned production-state clone or fork, read-only shadow mainnet, capped mainnet.

Responsibilities and dependency direction are specified in the repository architecture document.

## Release manifests

`tools/` is operator tooling, not consumed by any workspace. After a reviewed deployment, `node deployments/tools/release-manifests.mjs` turns the per-network release templates (`evm/base-sepolia`, `evm/arbitrum-sepolia`, `solana/devnet`, `hyperliquid/testnet`, and `tools/release-common.template.json`), the deployment output, and read-only RPC into every runtime manifest, config, and env file the services and the web app load, validated with the services' own loaders. It writes only outside the repository, never reads or writes key material, and refuses mainnet. Filled release files stay untracked. See `tools/README.md`.

## Dependency provenance

`dependency-provenance.json` records, for every workspace lockfile, each installed dependency's exact version and registry integrity hash, bound in one digest. `node tests/dependency-provenance/provenance.mjs` fails when any lockfile differs from the recorded provenance or a registry dependency lacks an integrity hash; after the change is reviewed, `--write` records it. Reviewed source revisions for dependencies whose published code differs from their repository are still recorded by hand before integration.

## Operator path

The [testnet go-live checklist](GO-LIVE.md) links the chain-specific steps, funding checks, release generator, service startup, and health validation. The [AWS host guide](aws/README.md) covers the testnet service host and the [tooling guide](tools/README.md) covers external runtime-manifest generation. None of these files authorizes a mainnet deployment.

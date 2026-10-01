# deployments

Data only. No executable business logic.

Holds per-network deployment identity and the generated environment manifests that make a run reproducible:

- program IDs and contract addresses;
- ABIs and IDLs published from `contracts/evm` and `contracts/solana`;
- code hashes, deployment slots and blocks, and upgrade-authority state;
- proxy, beacon, implementation, and admin graphs where applicable;
- pinned external dependency identities and reviewed source revisions;
- generated parity environment manifests.

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

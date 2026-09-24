# EVM conformance ABIs

This directory contains ABI-only conformance data generated from the local EVM contract sources. It records no deployed identity: no network, chain ID, contract address, transaction, block, or runtime code hash. Its presence is not a deployment claim, a support claim, or authorization to transact.

The published set contains the protocol configuration, solver registry, resource registry, package verifier, strategy account, spot ports, inventory reservation, asynchronous package coordination, the isolated GMX V2 entry and exit lifecycle, and their adapter-facing interfaces. Each JSON file under `abi/` is generated directly by `forge inspect` and must not be edited by hand.

From the repository root, regenerate the complete set with:

```bash
contracts/evm/scripts/publish-conformance-abis.sh
```

The command fails if Foundry is unavailable or any expected source contract cannot be inspected.

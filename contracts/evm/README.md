# EVM contracts

Foundry workspace for the EVM protocol contracts.

## Local validation

```bash
forge fmt --check
forge build
forge test
```

## ABI publication

From the repository root, regenerate the ABI-only conformance artifacts with:

```bash
contracts/evm/scripts/publish-conformance-abis.sh
```

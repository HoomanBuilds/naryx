# EVM local conformance

This workspace provisions the Naryx Base atomic contract graph on a private loopback Anvil chain. It uses labeled test assets and ephemeral accounts, writes its manifest and key material only to a temporary external directory, and never connects to a public network.

Run `npm test` for the focused environment check.

## Base Sepolia evidence

The public testnet runner uses the committed release identities, an external owner-only active-solver
key, and permissionlessly mintable Naryx Test USDC. It verifies chain ID and runtime code hashes
before any write, proves atomic rollback with a deliberately failed postcondition, then opens and
closes a 0.001 ETH package and cleans the strategy account.

```bash
NARYX_BASE_SEPOLIA_RPC_URL=https://base-sepolia.example \
NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH=/absolute/path/outside/repository/base-sepolia-solver.json \
npm run test:base-sepolia
```

The runner refuses every chain except Base Sepolia and writes its evidence outside the repository.
The perpetual leg is explicitly labeled `BASE_SEPOLIA_CONFORMANCE_ONLY`.

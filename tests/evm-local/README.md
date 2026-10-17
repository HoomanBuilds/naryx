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

## Funded native package clearing

`node src/run-native-clearing-testnet.mjs --network base-sepolia --step prepare
--metadata /absolute/external/live-metadata.json --output /absolute/external/clearing-evidence.json`
prepares a new, paused clearing domain from the deployed profile and matching policy. The metadata
is a one-time export of the API's live `profiles` and `matchingPolicies`, not a new runtime source of truth.
Set the selected `NARYX_BASE_SEPOLIA_RPC_URL` or `NARYX_ARBITRUM_SEPOLIA_RPC_URL` and a local encrypted
Foundry keystore password through `NARYX_DEPLOYER_PASSWORD`, or select its existing variable with
`--password-env`. Both RPC chain identity and collateral code identity are checked.

Inspect the prepared house address and funding amounts before running `--step deploy --broadcast`,
then `--step fund --broadcast`, with the same output and network. `--source-account` selects an explicitly
approved testnet gas source. Funding is 12 test USDC per network: 1 trader, 5 maker, 5 backstop and 1
recovery reserve. All transactions together, including ETH top-ups, reserve at most 0.01 test ETH per
network. Exact token approvals are used. Signed transactions and hashes are saved before broadcasting;
resuming reuses the recorded transaction instead of repeating a mint or deposit.

This runner does not unpause entries, create an API clearing ledger, publish continuous liquidity,
or claim that native cash-settled package exposure executes external option legs. Those require
separate finalized reconciliation and activation. Keep the owner-only evidence file outside Git.

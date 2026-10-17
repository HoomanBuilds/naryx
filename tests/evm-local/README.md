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

After funding, `--step mark --broadcast` publishes an explicitly controlled testnet mark, not an
external options-market oracle. It also signs the matching offchain observation. If necessary the
approved gas source funds the dedicated mark keeper within the same cumulative cap.

Once the published mark block is finalized, `--step reconcile --broadcast --admin-url
http://127.0.0.1:18807` records the actual funded accounts through the API, using a private SSH forward
to its loopback listener. Each deposit is reconciled against its own historical finalized block.
The authority signature authenticates the mark; account backing receipts prove account state,
not the truth of a market price. Executions separately require exact onchain mark identity.

After funding reconciliation, `--step lifecycle --broadcast --admin-url http://127.0.0.1:18807`
creates real owner-bound strategy accounts, admits two independently signed public package orders,
and obtains separate native-clearing consent from both owners. It briefly enables one 0.1-unit entry,
pauses entries again, exercises a controlled mark shock and default auction, transfers the exposure
to the funded backstop, and exits while paused. The test consumes 5 test USDC of maker collateral
and 0.02 test USDC of the reserve. This is deliberate fault injection, not organic market activity.

`--step cashout --broadcast` normalizes the flat trader account and withdraws its 6.02 test USDC
to that account's owner. After the final transaction is finalized, `--step reconcile-lifecycle
--broadcast --admin-url http://127.0.0.1:18807` verifies each historical transition in order and
commits its balances, immutable receipt and backing evidence. Neither successful broadcast nor
two confirmations substitutes for chain finality.

Native cash settlement does not execute the external option legs described by the economic
reference graphs. The runner does not publish continuous liquidity. Keep the owner-only evidence
file outside Git. Resuming reuses journaled transactions and checks canonical ledger state.

## Hyperliquid cross-batch cohort

`node --env-file=contracts/evm/.env tests/evm-local/src/run-hyperliquid-cross-batch.mjs
--output /absolute/external/cohort.json --admin-url http://127.0.0.1:18807 --step prepare --broadcast`
uses dedicated test owners to sign four funding-spread package orders against real BTC and
sekaw:BTC depth. The second pair reverses the venues, not the template's long and short rules.
Submit immediately with the same arguments and `--step submit`; signatures expire after five minutes.
Use `--step inspect` for current cross-batch and venue state. `--step cancel --broadcast` cancels
only still-resting asks named in that cohort, with each owner's signature.

Equal pairs test internal cross-batch cancellation. Add `--residual` at preparation to use
0.0002 BTC per owner in the first pair and 0.0001 in the second, leaving real 0.0002 BTC external
residuals on both venues. Submission persists its actual response before checking the expected
counterparty, so an unexpected fill is not misreported as an unsubmitted order.

Inspect final execution receipts through the public API and SDK before claiming success.
Matched orders, internally cleared residuals, venue fills, and final owner settlement are separate
states. These controlled testnet flows are not organic trading volume or continuous maker liquidity.

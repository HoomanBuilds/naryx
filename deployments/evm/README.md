# EVM testnet deployment lanes

This directory records reviewed public EVM testnet deployments: Base Sepolia (chain ID `84532`) and Arbitrum Sepolia (chain ID `421614`). Nothing has been deployed. A README without a release record is not a deployment claim, and no step below is authorized until a reviewer approves that exact action.

`conformance/` holds ABI-only data and `fork-evidence/` holds read-only fork qualification evidence. Neither is a deployment record.

## Safety gates

- Run every command from `contracts/evm` at a reviewed commit, after `forge build` and `forge test` pass.
- Use testnet-only wallets held outside the repository: a Foundry keystore (`cast wallet import <name> --interactive`, then `--account <name>`) or `--ledger`. Never pass `--private-key`, never export a key into the environment, and never attach a production signer, even for a simulation.
- Confirm the RPC before every session: `cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL"` prints `84532`, and `cast chain-id --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"` prints `421614`. Every script step also reverts on any other `block.chainid`.
- Run every step once without `--broadcast`. Forge then simulates against the live chain and sends nothing. Review the simulated transactions, then rerun the identical command with `--broadcast` added (and `--slow` for deployments, so each transaction is confirmed before the next is sent).
- The proposer, canceller, executor, and pauser must be four distinct addresses (`ProtocolConfig` rejects duplicates). The deployer, the strategy or account owner, the solver, the test perpetual market owner, and its funding keeper are separate wallets.
- Entry stays paused from deployment until the final delayed unpause. Every configure step refuses to run once entry is open.

## Command shape

```bash
forge script <script file>:<contract> \
  --sig "<function signature>" <arguments> \
  --rpc-url "$RPC_URL" --account <keystore name> --sender <address of that keystore> \
  [--broadcast [--slow]]
```

Struct arguments are tuples in struct field order, nested tuples included, for example `"(0xabc...,1,(0xdef...,2,0x123...))"`. The signatures below are exact and match `forge inspect <contract> methodIdentifiers`.

A deploy `run` function broadcasts from `--sender`. A configure step that takes an operator address calls `vm.startBroadcast(operator)` and first checks that address against the role the step needs, so `--sender` and the wallet must be that operator.

## Reading results

Forge writes each broadcast to `contracts/evm/broadcast/<script file>/<chain ID>/<function>-latest.json` (`run-latest.json` for `run`). That directory and Forge's `cache/` are ignored by Git and stay untracked.

```bash
RECORD=broadcast/DeployBaseSepoliaAtomicPackage.s.sol/84532/run-latest.json
jq -r '.transactions[] | select(.transactionType == "CREATE") | "\(.contractName) \(.contractAddress) \(.hash)"' "$RECORD"
jq '.returns' "$RECORD"
jq -r '.receipts[] | "\(.contractAddress) \(.blockNumber)"' "$RECORD"
```

`.returns` holds the function's return tuple in struct field order. Block numbers are hex. A contract created inside a constructor, such as the `PackageVerifierValidation` helper, is listed under the creating transaction's `additionalContracts` and is also readable with `cast call "$VERIFIER" "validationHelper()(address)"`.

Read every runtime code hash from the chain after the transaction is final, never from local artifacts:

```bash
cast codehash <address> --rpc-url "$RPC_URL"
```

## Delays

Every propose step records `activation = proposal block timestamp + configDelaySeconds`. Before the matching activate step, wait until the chain has passed it:

```bash
cast call "$CONFIG" "configDelaySeconds()(uint64)" --rpc-url "$RPC_URL"
cast block latest --field timestamp --rpc-url "$RPC_URL"
cast call "$CONFIG" "pendingDomain()(bool,uint32,bytes32,uint64)" --rpc-url "$RPC_URL"
cast call "$CONFIG" "pendingUnpause()(bool,uint64)" --rpc-url "$RPC_URL"
```

An early activation reverts in simulation with a `...NotReady` error, so nothing is sent. The canceller can withdraw any pending proposal; the pauser can pause entry at once.

## Domain manifest hash

`ProtocolConfig` takes the domain manifest version and hash in its constructor. The reviewed `DomainManifest` (`packages/protocol-types/src/domain-manifest.ts`) commits to `executionVerifierCodeHash`, the runtime code hash of the deployed execution verifier, which exists only after deployment. On Base that is `PackageVerifier`, whose code embeds its own address and the addresses and code hashes of the registries it binds, so the hash cannot be known before the deployment it must be passed to. On Arbitrum it is `AsyncBondedPackageCoordinator`.

The procedure is a delayed domain rotation before any configuration:

1. Deploy with domain manifest version `1` and a provisional hash that no manifest can produce:

   ```bash
   cast keccak "naryx-provisional-domain-manifest:eip155:84532"
   cast keccak "naryx-provisional-domain-manifest:eip155:421614"
   ```

2. Read the execution verifier's code hash from the chain and compute the reviewed manifest hash with manifest version `2`.
3. Propose the reviewed manifest, wait `configDelaySeconds`, and activate it with `runProposeDomain` and `runActivateDomain`. Both refuse while entry is open, and activation refuses unless the pending proposal is exactly the reviewed version and hash.
4. Only then register anything. `ResourceRegistry`, `CashCarrySeriesRegistry`, and `PackageQuoteShardRegistry` record the active domain with each registration and accept a record only while that domain is active, and every later configure step requires the active domain to equal the route's `domainManifestVersion` and `domainManifestHash`. `FirmInventoryReservationBook` and `DirectInventorySpotPort` pin the active domain at construction, so `DeployBaseSepoliaFirmLiquidity` runs after the rotation.

Nothing is signed or registered under the provisional manifest, and entry is paused throughout. A precomputed hash is not used because the verifier's code hash depends on its address, so it would hold only if the deployer sent no other transaction between the simulation and the broadcast.

Compute the reviewed hash from the repository root with the protocol codec (build `packages/protocol-types` first). The object must be byte-for-byte the `domainManifest` later written into the runtime manifest:

```bash
DOMAIN_ID=eip155:421614 CHAIN_REFERENCE=421614 SETTLEMENT_CLASS=ASYNC_BONDED_SOLVER \
EXECUTION_VERIFIER_CODE_HASH=0x... FINALITY_POLICY_HASH=0x... \
node --input-type=module -e '
import { domainManifestHash, toHex } from "./packages/protocol-types/dist/index.js";
console.log("0x" + toHex(domainManifestHash({
  manifestVersion: 2,
  environment: "testnet",
  domainId: process.env.DOMAIN_ID,
  runtimeClassId: "naryx-evm",
  runtimeClassVersion: 1,
  chainNamespace: "eip155",
  chainReference: process.env.CHAIN_REFERENCE,
  executionVerifierId: "package-verifier-v1",
  executionVerifierCodeHash: process.env.EXECUTION_VERIFIER_CODE_HASH,
  clockModelId: "evm-unix-seconds",
  finalityPolicyHash: process.env.FINALITY_POLICY_HASH,
  addressCodecId: "evm-address-20",
  supportedSettlementClasses: [process.env.SETTLEMENT_CLASS],
})));
'
```

`FINALITY_POLICY_HASH` is the reviewed finality policy manifest hash. It must equal `finality.manifestHash` in the runtime manifest.

## Base Sepolia lane

Domain identifier: the Base scripts fix `domainId` to `eip155:84532`, and `ProtocolConfig`, `PackageVerifier`, and the registries pin it at construction. The API, the web terminal, the execution intent store, and the EVM adapter use the same CAIP-2 identifier, as Arbitrum uses `eip155:421614`. Changing it later needs a new `ProtocolConfig` and `PackageVerifier`.

```bash
export RPC_URL="$BASE_SEPOLIA_RPC_URL"
```

### 1. Deploy the atomic package

`DeployBaseSepoliaAtomicPackage.Parameters`, in order: `domainManifestVersion` (`1`), `domainManifestHash` (the provisional hash), `cashCarryTemplateManifestHash` (the reviewed cash-and-carry template manifest hash that orders sign), `configDelaySeconds`, `proposer`, `canceller`, `executor`, `pauser`, `solver` (initial active solver), and `perpetualMarket` (the `NaryxTestPerpMarket.Parameters` tuple below). The Uniswap V3 factory, pool, WETH, and USDC identities and code hashes are pinned constants in the script. The script deploys no strategy account: accounts are created per owner through `NaryxStrategyAccountFactory`.

```bash
forge script script/DeployBaseSepoliaAtomicPackage.s.sol:DeployBaseSepoliaAtomicPackage \
  --sig "run((uint32,bytes32,bytes32,uint64,address,address,address,address,address,(address,address,address,address,address,uint32,uint32,uint16,uint16,uint16,uint128,uint16,uint16,uint16,uint128,uint128,uint128)))" \
  "$BASE_DEPLOY_PARAMETERS" \
  --rpc-url "$RPC_URL" --account naryx-base-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists, in order: `ProtocolConfig`, `SolverRegistry`, `ResourceRegistry`, `CashCarrySeriesRegistry`, `PackageQuoteShardRegistry`, `PackageVerifier`, `NaryxStrategyAccountFactory`, `UniswapV3SpotPort`, `NaryxTestPerpMarket`. The factory's constructor also creates an inert reference account it owns; `cast call "$FACTORY" "accountCodeHash()(bytes32)"` is the runtime code hash every account shares.

#### Test perpetual market

`NaryxTestPerpMarket` is the Base Sepolia perpetual leg. It is not a venue: it is a SynFutures-compatible instrument and position observer that prices from a Chainlink feed with a spread and size impact, charges taker fees, accrues funding, enforces initial and maintenance margin, and liquidates, so a testnet package moves money the way a mainnet one does. The market is every trader's counterparty: trader losses accrue to its insurance balance and trader profits are paid from it. A close whose profit the insurance balance cannot pay reverts with `InsuranceInsufficient`. A loss beyond the margin floors the payout at zero and is recorded in `badDebtWad`.

Margin never comes from the strategy account's wallet during a package (the verifier's quote postcondition covers only the spot leg). It comes from the trader's free reserve in the market's gate: `deposit(amount)` and `withdraw(amount)` in USDC atoms, `reserveOf(trader)`. Position balances, notionals, and prices are WAD.

`NaryxTestPerpMarket.Parameters`, in order, with recommended Base Sepolia values close to a real venue:

| Field | Recommended | Meaning |
|---|---|---|
| `owner` | separate testnet wallet | pauses new opens, rotates the funding keeper, funds insurance |
| `fundingKeeper` | separate testnet wallet | sets the funding rate |
| `feeRecipient` | separate address | receives taker fees and liquidation penalties in its reserve |
| `collateral` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | USDC; the script rejects any other |
| `oracle` | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | Chainlink ETH/USD, 8 decimals |
| `expiry` | `4294967295` | perpetual expiry; every `perpArgs` header and `perpExpiry` must equal it |
| `maxOracleAgeSeconds` | `3600` | a round older than this rejects every trade and liquidation (cap 1 day) |
| `takerFeeBps` | `5` | taker fee on open and close notional, rounded up to a USDC atom (cap 100) |
| `halfSpreadBps` | `2` | fill offset from the oracle, against the taker |
| `impactBps` | `1` | extra offset per `impactSizeWad` of size, against the taker |
| `impactSizeWad` | `10000000000000000000` | 10 ETH |
| `initialMarginBps` | `1000` | margin after the open fee must cover 10% of entry notional |
| `maintenanceMarginBps` | `500` | liquidation below 5% of oracle notional; must be below initial |
| `liquidationPenaltyBps` | `50` | of oracle notional, to the fee recipient, only from positive equity (cap 500) |
| `maxPositionSizeWad` | `10000000000000000000` | 10 ETH per position |
| `maxMarginWad` | `100000000000000000000000` | 100,000 USDC per position |
| `maxAbsFundingRatePerSecond` | `30000000000000000` | about 4% per hour at 2,700 USD, a venue-style funding cap (cap `1e17`) |

Spread plus impact at the maximum size must stay at or below 500 bps; the constructor rejects anything else, and requires chain `84532` (or the local test chain `31338`). Before deploying, confirm the feed without a signer:

```bash
cast codehash 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1 --rpc-url "$RPC_URL"
cast call 0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC_URL"
```

The market pins the feed's code hash at deployment and refuses a price if it changes.

Trade shapes (`trade(bytes32[2])`, `args[0] = deadline << 56 | expiry`, `args[1] = sizeDelta << 128 | uint128(balanceDelta)`):

- Open from flat: `sizeDelta != 0`, `balanceDelta > 0` and a whole number of USDC atoms in WAD (a multiple of `1e12`), drawn from the caller's reserve. The fee is taken from it, so the position balance is `balanceDelta - fee`. `previewOpen(sizeDelta, balanceWad)` returns the fill price, entry notional, fee, and resulting margin at the current oracle; the executed values use the oracle at execution, so an execution bounds the post balance and entry notional with a range.
- Close: `sizeDelta == -size` and `balanceDelta == 0`. The payout (margin, realized PnL, funding, less the close fee, floored at zero) lands in the caller's reserve, not its wallet, and the position is deleted, so the verifier observes balance, size, and entry notional zero.

Funding keeper duty: the keeper mirrors a real venue's funding. Each venue funding interval (hourly for the reference venue), it reads that venue's ETH funding rate as a fraction per interval (positive when longs pay shorts) and calls `setFundingRatePerSecond(fraction * oraclePriceWad / intervalSeconds)` as a signed WAD (quote per base per second). The rate accrues into `fundingIndex` until the next update, so a lapsed keeper leaves the last rate in force; the owner replaces a lapsed keeper with `setFundingKeeper`. The owner also funds counterparty capital with `fundInsurance(amount)` (approve USDC first) sized to the largest profit open positions can realize; insurance has no withdrawal path. Anyone may `liquidate(trader)` once `health(trader)` shows equity below the maintenance requirement.

#### Strategy accounts

`NaryxStrategyAccountFactory.create(owner)` is permissionless and idempotent; it deploys `NaryxStrategyAccount(owner, verifier)` with CREATE2 salt `keccak256(abi.encode(owner))`, and `accountOf(owner)` returns the address before or after creation. A novated account keeps that address under its new owner. Every account's runtime code hash equals the factory's `accountCodeHash`.

Before an entry the owner funds the account with USDC and moves the perpetual margin into the market's gate with `depositPerpMargin(perpetualVenueSubjectId, amountAtoms)`, where the subject ID is the route's `perpetualVenue.subjectId`. The account resolves that subject in the verifier's `ResourceRegistry` and moves funds only to the active venue record at its registered code hash, with an exact allowance reset in the same call. Deposits need an `ACTIVE` venue; `withdrawPerpMargin(perpetualVenueSubjectId, amountAtoms)` also works while the venue is `ENTRY_PAUSED` or `EXIT_ONLY`. After an exit, the owner withdraws the settled reserve the same way and then uses `withdrawIdleToken`. Delegates can do neither.

### 2. Rotate to the reviewed domain manifest

Compute the reviewed hash with `DOMAIN_ID` set to the settled Base identifier, `CHAIN_REFERENCE=84532`, `SETTLEMENT_CLASS=ATOMIC_POSTCONDITION`, and `EXECUTION_VERIFIER_CODE_HASH=$(cast codehash "$VERIFIER" --rpc-url "$RPC_URL")`.

```bash
forge script script/ConfigureBaseSepoliaAtomicPackage.s.sol:ConfigureBaseSepoliaAtomicPackage \
  --sig "runProposeDomain(address,uint32,bytes32,address)" "$CONFIG" 2 "$DOMAIN_MANIFEST_HASH" "$PROPOSER" \
  --rpc-url "$RPC_URL" --account naryx-base-proposer --sender "$PROPOSER" --broadcast
# wait configDelaySeconds
forge script script/ConfigureBaseSepoliaAtomicPackage.s.sol:ConfigureBaseSepoliaAtomicPackage \
  --sig "runActivateDomain(address,uint32,bytes32,address)" "$CONFIG" 2 "$DOMAIN_MANIFEST_HASH" "$EXECUTOR" \
  --rpc-url "$RPC_URL" --account naryx-base-executor --sender "$EXECUTOR" --broadcast
```

### 3. Deploy the firm liquidity layer

`DeployBaseSepoliaFirmLiquidity.Parameters`, in order: `config`, `configCodeHash`, `verifier`, `verifierCodeHash` (both read from the chain), `reservationMaximumTtlSeconds`, `maximumBaseAtomsPerReservation`, `maximumReservedBaseAtomsPerSolver`, `shardSolver`, `seriesManifestHash`, `executionClassManifestHash`, `shardLimits` as `(maxHeartbeatSeconds,maxBatchSize,maxLevelCount)`, `bondClaimsAuthority`, `bondDisputeResolver`. The shard's series and execution class hashes must equal the route's below.

```bash
forge script script/DeployBaseSepoliaFirmLiquidity.s.sol:DeployBaseSepoliaFirmLiquidity \
  --sig "run((address,bytes32,address,bytes32,uint64,uint256,uint256,address,bytes32,bytes32,(uint64,uint16,uint32),address,address))" \
  "$BASE_FIRM_PARAMETERS" \
  --rpc-url "$RPC_URL" --account naryx-base-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists `FirmInventoryReservationBook`, `DirectInventorySpotPort`, `PackageQuoteShard`, `PerformanceBondVault`. No configure step registers `DirectInventorySpotPort` as a spot adapter yet; the route below uses `UniswapV3SpotPort`.

### 4. Configure

`ConfigureBaseSepoliaAtomicPackage.Route`, in order: `config`, `domainManifestVersion` (`2`), `domainManifestHash` (reviewed), `solverRegistry`, `resources`, `seriesRegistry`, `quoteRegistry`, `verifier`, `strategyAccountFactory`, `spotPort`, `testPerpMarket`, `quoteShard`, `solver`, then eight `(subjectId,manifestVersion,manifestHash)` references for `baseAsset`, `quoteAsset`, `spotVenue`, `perpetualVenue`, `spotMarket`, `perpetualMarket`, `spotAdapter`, `perpetualAdapter`, then `seriesManifestHash`, `executionClassManifestHash`, `seriesBindingVersion`, `spotBaseAtomsPerPackageUnit`, `perpetualQuantityWadPerPackageUnit`, `quoteShardManifestVersion`, `quoteShardManifestHash`, `maximumPackageNotionalQuoteAtoms`, and `spotMarketParameters` and `perpetualMarketParameters` as `(baseLotAtoms,quoteTickAtomsPerBaseLot,minimumQuoteNotionalAtoms,contractMultiplierNumerator,contractMultiplierDenominator,baseDecimals,quoteDecimals)`.

Each `subjectId` is `cast keccak "<subjectId>"` of the same string the runtime manifest uses, and each version and manifest hash is the runtime manifest's. Every step re-verifies the deployment relationships (including that the market's collateral is the spot quote token and that the factory binds this verifier), the shard, the Uniswap pool, and the active domain before it sends anything.

The perpetual venue and market records are `NaryxTestPerpMarket`. The perpetual adapter record is `PackageVerifier`: the verifier is the Base perpetual port, observing the venue position before and after the trade, and it admits only a perpetual adapter whose local address is itself.

```bash
BASE_ROUTE_TYPE='(address,uint32,bytes32,address,address,address,address,address,address,address,address,address,address,(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),bytes32,bytes32,uint32,uint128,uint128,uint32,bytes32,uint256,(uint256,uint256,uint256,uint256,uint256,uint8,uint8),(uint256,uint256,uint256,uint256,uint256,uint8,uint8))'
base_step() { # function, operator address, keystore name, extra flags
  forge script script/ConfigureBaseSepoliaAtomicPackage.s.sol:ConfigureBaseSepoliaAtomicPackage \
    --sig "$1($BASE_ROUTE_TYPE,address)" "$BASE_ROUTE" "$2" \
    --rpc-url "$RPC_URL" --account "$3" --sender "$2" "${@:4}"
}
```

Run in this order, simulating each step before adding `--broadcast`, and waiting `configDelaySeconds` after every propose or schedule step:

| Step | Operator |
|---|---|
| `runProposeQuoteAsset` | proposer |
| `runActivateQuoteAsset` | executor |
| `runProposeFoundation` (solver, base asset, both venues, quote shard) | proposer |
| `runActivateFoundation` | executor |
| `runProposeMarketsAndSeries` | proposer |
| `runActivateMarketsAndSeries` | executor |
| `runProposeAdapters` | proposer |
| `runActivateAdapters` (also validates the complete admission at the maximum notional) | executor |
| `runScheduleUnpause` | proposer |
| `runActivateEntry` | executor |

```bash
base_step runProposeQuoteAsset "$PROPOSER" naryx-base-proposer
base_step runProposeQuoteAsset "$PROPOSER" naryx-base-proposer --broadcast
```

## Arbitrum Sepolia lane

```bash
export RPC_URL="$ARBITRUM_SEPOLIA_RPC_URL"
```

The GMX Arbitrum Sepolia addresses are pinned constants in `DeployArbitrumSepoliaAsyncGmx`. Their code hashes are reviewed operator input: read each with `cast codehash` and compare it with the review before use. Every deployment step fails on a mismatch.

### 1. Deploy the coordinator route

`DeployArbitrumSepoliaAsyncGmx.Parameters`, in order: `domainManifestVersion` (`1`), `domainManifestHash` (provisional), `configDelaySeconds`, `proposer`, `canceller`, `executor`, `pauser`, `fundingAuthority` (funds collateral, spot quote, and execution fees), `beneficiary` (isolated account owner), `market`, `marketCodeHash`, `collateralToken`, `collateralTokenCodeHash`, `executionClassManifestHash`, and the GMX code hashes as `(dataStore,eventEmitter,exchangeRouter,router,orderVault,orderHandler,roleStore)`.

```bash
forge script script/DeployArbitrumSepoliaAsyncGmx.s.sol:DeployArbitrumSepoliaAsyncGmx \
  --sig "run((uint32,bytes32,uint64,address,address,address,address,address,address,address,bytes32,address,bytes32,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)))" \
  "$ARBITRUM_DEPLOY_PARAMETERS" \
  --rpc-url "$RPC_URL" --account naryx-arbitrum-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists `ProtocolConfig`, `AsyncBondedPackageCoordinator`, `GmxV2OrderVerifier`, `GmxV2IsolatedAccount`, `GmxV2ArbitrumAdapter`.

### 2. Rotate to the reviewed domain manifest

Compute the reviewed hash with `DOMAIN_ID=eip155:421614`, `CHAIN_REFERENCE=421614`, `SETTLEMENT_CLASS=ASYNC_BONDED_SOLVER`, and `EXECUTION_VERIFIER_CODE_HASH=$(cast codehash "$COORDINATOR" --rpc-url "$RPC_URL")`. Then run `runProposeDomain` (proposer), wait, and `runActivateDomain` (executor) exactly as in the Base lane, against `script/ConfigureArbitrumSepoliaAsyncGmx.s.sol:ConfigureArbitrumSepoliaAsyncGmx`.

### 3. Configure

`ConfigureArbitrumSepoliaAsyncGmx.Route`, in order: `config`, `configCodeHash`, `domainManifestVersion` (`2`), `domainManifestHash` (reviewed), `coordinator`, `coordinatorCodeHash`, `isolatedAccount`, `isolatedAccountCodeHash`, `adapter`, `adapterCodeHash`, `exitController`, `exitControllerCodeHash`, `spotPort`, `spotPortCodeHash`. The last four are zero until step 3b deploys those contracts; only the steps from `runBindExitAndSpot` on read them.

```bash
ARBITRUM_ROUTE_TYPE='(address,bytes32,uint32,bytes32,address,bytes32,address,bytes32,address,bytes32,address,bytes32,address,bytes32)'
arbitrum_step() { # function, operator address, keystore name, extra flags
  forge script script/ConfigureArbitrumSepoliaAsyncGmx.s.sol:ConfigureArbitrumSepoliaAsyncGmx \
    --sig "$1($ARBITRUM_ROUTE_TYPE,address)" "$ARBITRUM_ROUTE" "$2" \
    --rpc-url "$RPC_URL" --account "$3" --sender "$2" "${@:4}"
}
```

a. `runBindEntryController` as the beneficiary (the isolated account owner).

b. Deploy the exit controller and the coordinated spot port. The exit controller requires the bound entry controller at construction. `ExitAndSpotParameters`, in order: `adapter`, `adapterCodeHash`, `isolatedAccount`, `isolatedAccountCodeHash`, the GMX code hashes, and the spot venue as `(chainId,factory,pool,baseToken,quoteToken,baseTokenDecimals,quoteTokenDecimals,poolFee,factoryCodeHash,poolCodeHash,baseTokenCodeHash,quoteTokenCodeHash)`. The quote token must be the collateral token. No reviewed Arbitrum Sepolia Uniswap V3 pool against the GMX collateral token is pinned in this repository; without one, stop here and leave entry paused.

```bash
forge script script/DeployArbitrumSepoliaAsyncGmx.s.sol:DeployArbitrumSepoliaAsyncGmx \
  --sig "runExitAndSpot((address,bytes32,address,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32),(uint256,address,address,address,address,uint8,uint8,uint24,bytes32,bytes32,bytes32,bytes32)))" \
  "$ARBITRUM_EXIT_AND_SPOT_PARAMETERS" \
  --rpc-url "$RPC_URL" --account naryx-arbitrum-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists `GmxV2ExitOrderVerifier`, `GmxV2ExitController`, `UniswapV3SpotPort`. Fill the route's last four fields from it.

c. Remaining steps, in order:

| Step | Operator |
|---|---|
| `runProposeAdmission` | proposer |
| `runActivateAdmission` (after `configDelaySeconds`) | executor |
| `runBindExitAndSpot` | beneficiary |
| `runScheduleUnpause` (requires the active admission, both controllers, and the spot port bound exactly as the route names them) | proposer |
| `runActivateEntry` (after `configDelaySeconds`) | executor |

Then confirm the final state without a signer:

```bash
forge script script/ConfigureArbitrumSepoliaAsyncGmx.s.sol:ConfigureArbitrumSepoliaAsyncGmx \
  --sig "verifyActiveRoute($ARBITRUM_ROUTE_TYPE)" "$ARBITRUM_ROUTE" --rpc-url "$RPC_URL"
```

## Runtime manifests

The API loads one JSON file per lane from `NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST` and `NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST`. Both are protocol JSON: a bigint is `{"$naryxType":"bigint","value":"<decimal>"}` and a byte string is `{"$naryxType":"bytes","value":"<lowercase hex without 0x>"}`. A contract identity is `{"address":"0x...","expectedCodeHash":"0x..."}` with the code hash read from the chain. At startup and on every attempt the API compares each identity with the live code hash and refuses any mismatch.

Base (`schemaVersion` `1`, `activationState` `"ACTIVE"`, `deployment`):

- `deployment.domainManifest`: the reviewed version `2` manifest from the rotation step, with `executionVerifierCodeHash` equal to `deployment.packageVerifier.expectedCodeHash`.
- `deployment.deploymentChainReference`: bigint `84532`.
- `deployment.strategyAccountFactory`: `NaryxStrategyAccountFactory`. An order's settlement account must equal `accountOf(owner)` for the order's owner, have code hash `deployment.strategyAccountCodeHash`, and bind `deployment.packageVerifier`.
- `deployment.strategyAccountCodeHash`: bytes of the factory's `accountCodeHash()`, the runtime code hash every account shares.
- `deployment.packageVerifier`: `PackageVerifier`.
- `deployment.settlementClass`: `classId` is bytes of `cast keccak "ATOMIC_POSTCONDITION"`, `classVersion` `1`.
- `deployment.spot`: `adapter` is `UniswapV3SpotPort`, `market` the Uniswap pool, `venue` the Uniswap factory, `adapterClassId` `"base-strategy-spot-adapter-v1"`, `adapterClassVersion` `1`, `baseLotAtoms` equal to the route's spot `baseLotAtoms`.
- `deployment.perpetual`: `adapter` is `PackageVerifier`, `market` and `venue` are `NaryxTestPerpMarket`, `adapterClassId` `"base-strategy-perp-port-v1"`, `adapterClassVersion` `1`. `deployment.perpetualObserver` is `NaryxTestPerpMarket`.
- `deployment.baseAsset` and `deployment.quoteAsset`: WETH (`decimals` `18`) and USDC (`decimals` `6`).
- Each resource identity also carries `subjectId`, `manifestVersion`, and `manifestHash`, equal to the route references registered in step 4.
- `uniswapV3.spotPort`, `uniswapV3.pool`, `uniswapV3.factory`: the same identities as the spot adapter, market, and venue.
- `conformancePerpetual`: `instrument` and `observer` are `NaryxTestPerpMarket`, `evidenceLabel` `"BASE_SEPOLIA_CONFORMANCE_ONLY"`. The subject ID an owner passes to `depositPerpMargin` is `deployment.perpetual.venue.subjectId`.
- `seriesBindingInput`: the binding registered in step 4 (route `seriesManifestHash`, `executionClassManifestHash`, `seriesBindingVersion`, and units per package).
- `atomicEvidenceClass`: `"PACKAGE_VERIFIER_ATOMIC_V1"`. `finality.manifestHash` equals the domain manifest's `finalityPolicyHash`. `admission` and `executionBounds` are reviewed configuration, not deployment output.

Arbitrum (`schemaVersion` `1`, `activationState` `"ACTIVE"`, `observationStartBlock`, `deployment`):

- `observationStartBlock`: bigint, the coordinator's deployment block from `.receipts`.
- `deployment.domainManifest`: the reviewed version `2` manifest.
- `deployment.protocolConfig`, `coordinator`, `isolatedAccount`, `entryAdapter` (`GmxV2ArbitrumAdapter`), `orderVerifier` (`GmxV2OrderVerifier`), `market`, `collateralToken`: deployed or reviewed identities.
- `deployment.gmx`: `dataStore`, `eventEmitter`, `exchangeRouter`, `router`, `orderVault`, `orderHandler`, `roleStore` at the pinned addresses with their reviewed code hashes.
- `deployment.executionClassManifestHash`: bytes of the deploy parameter. `deployment.route.coordinatorEvidenceSchemaHash`: bytes of `cast keccak "NARYX_ASYNC_VENUE_EVIDENCE_V1"`. The series identity key, binding version, and binding hash are the ones solvers put in reserved terms.

The Arbitrum manifest has no field for the exit controller or the spot port, so the API neither checks their code nor observes exits through them.

Every new contract's runtime code hash also belongs in the keeper's code-hash monitor targets. The indexer follows a lane through `NARYX_INDEXER_EVM_DOMAIN`, `NARYX_INDEXER_EVM_CONTRACTS` (the settlement contract: `PackageVerifier` on Base, the coordinator on Arbitrum), `NARYX_INDEXER_EVM_START_HEIGHT` (its deployment block), and `NARYX_INDEXER_EVM_BOND_VAULTS`.

## Release record

After a reviewed lane completes, commit a non-secret record under `deployments/evm/<network>/` stating:

- chain ID and release commit;
- solc `0.8.37`, optimizer runs `200`, EVM version `cancun`, and the Forge version;
- each contract's name, address, deployment transaction, block, and runtime code hash;
- the provisional and the reviewed domain manifest (version, hash, and the full reviewed manifest);
- the four governance roles, `configDelaySeconds`, and every governance transaction with its activation time;
- every external dependency identity and code hash that was pinned (Uniswap V3, GMX, tokens);
- known limitations: the Base perpetual leg is the Naryx test perpetual market (oracle-priced, house counterparty, keeper-set funding), not a venue; strategy accounts are created per owner through the factory;
- a statement that deployment implies no funding, solver activity, or package execution.

Broadcast files, keystores, RPC URLs, and environment files stay untracked.

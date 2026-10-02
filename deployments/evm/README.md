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
cast call "$CONFIG" "pendingCashCarryTemplate()(bool,bytes32,uint64)" --rpc-url "$RPC_URL"
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
4. On Base, set the reviewed cash-and-carry template manifest hash (see below).
5. Only then register anything. `ResourceRegistry`, `CashCarrySeriesRegistry`, and `PackageQuoteShardRegistry` record the active domain with each registration and accept a record only while that domain is active, and every later configure step requires the active domain to equal the route's `domainManifestVersion` and `domainManifestHash` and the active template to equal its `cashCarryTemplateManifestHash`. `FirmInventoryReservationBook` and `DirectInventorySpotPort` pin the active domain at construction, so `DeployBaseSepoliaFirmLiquidity` runs after the rotation.

Nothing is signed or registered under the provisional manifest, and entry is paused throughout.

## Template manifest hash

The cash-and-carry `PackageTemplateManifest` lists the reviewed domain reference (version `2` and its hash) in `supportedDomains`, so its hash also exists only after the domain rotation. It is therefore not a deploy parameter. `ProtocolConfig` holds it as governed storage that starts unset (`cashCarryTemplateManifestHash()` returns zero, and every template-bound registration and admission fails closed). `ResourceRegistry` and `CashCarrySeriesRegistry` read it from `ProtocolConfig` on every call, so their code hashes, and through them the `PackageVerifier` code hash that the domain manifest commits to, do not depend on it.

The proposer calls `proposeCashCarryTemplate(hash)`, and after `configDelaySeconds` the executor calls `activateCashCarryTemplate()`; the canceller can withdraw it with `cancelCashCarryTemplateProposal()`. Both the proposal and the activation require entry to be paused, the hash must be nonzero, and a hash that was ever active is refused, so records bound to a retired template cannot revive. Adapter records, admissions, and series bindings must carry exactly the active hash: after a later template change, records registered under the old one stop validating, as they do after a domain rotation, and are re-registered under the new one. A precomputed hash is not used because the verifier's code hash depends on its address, so it would hold only if the deployer sent no other transaction between the simulation and the broadcast.

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

## Test USDC and spot liquidity

Circle's faucet grants a few test USDC per request, which cannot fund a demo. The hosted test deployment therefore settles in test USDC anyone can mint:

- Base Sepolia: `NaryxTestUSDC` (`tUSDC`, 6 decimals). `mint(recipient, amount)` is public while the recipient holds at most 10,000,000 tUSDC; it has no owner, and its constructor refuses every chain except `84532`, `421614`, and the local `31337`. The web terminal's Get test USDC button calls it from the trader's own wallet.
- Arbitrum Sepolia: the GMX ETH/USD market's short token, `USDC.SG` `0x3253a335E7bFfB4790Aa4C25C4250d206E9b9773`, which is GMX's own public `mint(address,uint256)` test token. GMX collateral must be that token, so no Naryx token is deployed there; the same button calls the same function. Read from GMX's `Reader.getMarkets` on 2026-10-02, every GMX Arbitrum Sepolia market uses it as the short token, and the ETH/USD market `0xb6fC4C9eB02C35A134044526C62bb15014Ac0Bcc` (index and long token WETH `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`) held about 5.5 WETH and 50 million USDC.SG, with GMX keepers executing orders.

Which venues are real and which are Naryx test venues, per lane:

| Lane | Spot leg | Perpetual leg | Quote asset |
|---|---|---|---|
| Base Sepolia | Uniswap V3 (canonical contracts), WETH / tUSDC pool seeded below | `NaryxTestPerpMarket`, Chainlink-priced, house counterparty | Naryx Test USDC |
| Arbitrum Sepolia | Uniswap V3 (canonical contracts), WETH / USDC.SG pool seeded below | GMX V2 ETH/USD market (real testnet venue) | GMX USDC.SG |
| Solana Devnet | solver inventory reservation (`naryx_inventory_reservation`) | `naryx_test_perp`, Pyth-priced, house counterparty | Naryx test USDC mint (see `deployments/solana/devnet/README.md`) |
| Hyperliquid testnet | HyperCore spot (real testnet venue) | HyperCore perpetuals (real testnet venue) | Hyperliquid testnet USDC in the service's testnet account |

Every wallet that holds quote in a lane uses that lane's token: traders, the Base test perp's insurance (`fundInsurance`), the Arbitrum solver's bond and recovery reserve, and the pool seeder. Each gets it from the same public `mint(address,uint256)`, for example `cast send "$QUOTE" "mint(address,uint256)" "$WALLET" 1000000000000 --account <wallet> --rpc-url "$RPC_URL"` (one million at six decimals; tUSDC stops a wallet at ten million).

Deploy the Base token (it prints its address; record `cast codehash` of it as the reviewed quote code hash):

```bash
forge script script/DeployNaryxTestUSDC.s.sol:DeployNaryxTestUSDC \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account naryx-base-deployer --sender "$DEPLOYER" --broadcast
```

The spot leg trades on the canonical Uniswap V3 contracts, as on mainnet. The public WETH pools against Circle USDC (Base) and USDC.SG (Arbitrum, fee tiers 500 and 3000) are empty and far from the market price, so seed a WETH pool against the test quote at the live Chainlink price. `SeedUniswapV3TestPool` creates the pool at the oracle price when the fee tier has none, refuses a pool already trading more than `maxPoolDeviationBps` away from the oracle, wraps the sender's ETH, mints the test quote, and adds one position `halfWidthTicks` either side of the price. `Parameters`, in order: `quoteToken`, `fee`, `oracle`, `maxOracleAgeSeconds`, `maxPoolDeviationBps`, `halfWidthTicks`, `baseAmount` (wei), `quoteAmount` (quote atoms), `liquidityRecipient`.

```bash
# Base Sepolia: fee 500, Chainlink ETH/USD, +-2,000 ticks (about +-22%), 1 WETH against 3,000,000 tUSDC.
forge script script/SeedUniswapV3TestPool.s.sol:SeedUniswapV3TestPool \
  --sig "run((address,uint24,address,uint32,uint16,int24,uint256,uint256,address))" \
  "($TEST_USDC,500,0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1,3600,100,2000,1000000000000000000,3000000000000,$LIQUIDITY_OWNER)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account naryx-base-deployer --sender "$DEPLOYER" --broadcast --slow

# Arbitrum Sepolia: fee 100 (tick spacing 1) has no pool yet; Chainlink ETH/USD 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165.
forge script script/SeedUniswapV3TestPool.s.sol:SeedUniswapV3TestPool \
  --sig "run((address,uint24,address,uint32,uint16,int24,uint256,uint256,address))" \
  "(0x3253a335E7bFfB4790Aa4C25C4250d206E9b9773,100,0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165,3600,100,2000,1000000000000000000,3000000000000,$LIQUIDITY_OWNER)" \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" --account naryx-arbitrum-deployer --sender "$DEPLOYER" --broadcast --slow
```

The returned `pool` and `cast codehash` of it are the reviewed spot pool inputs for the lane deploy below. Run the script again to add depth; it reuses the pool while it trades within the deviation bound. Trades move the pool away from the oracle over time; seed a new range, or let the solver's quotes (which price the pool, not the oracle) carry the difference.

## Base Sepolia lane

Domain identifier: the Base scripts fix `domainId` to `eip155:84532`, and `ProtocolConfig`, `PackageVerifier`, and the registries pin it at construction. The API, the web terminal, the execution intent store, and the EVM adapter use the same CAIP-2 identifier, as Arbitrum uses `eip155:421614`. Changing it later needs a new `ProtocolConfig` and `PackageVerifier`.

```bash
export RPC_URL="$BASE_SEPOLIA_RPC_URL"
```

### 1. Deploy the atomic package

`DeployBaseSepoliaAtomicPackage.Parameters`, in order: `domainManifestVersion` (`1`), `domainManifestHash` (the provisional hash), `configDelaySeconds`, `proposer`, `canceller`, `executor`, `pauser`, `solver` (initial active solver), `quote` as `(token,tokenCodeHash,pool,poolCodeHash,poolFee)` (Naryx Test USDC and the seeded pool above), and `perpetualMarket` (the `NaryxTestPerpMarket.Parameters` tuple below). The Uniswap V3 factory and WETH identities and code hashes are pinned constants; the script requires a six-decimal quote token with the reviewed code hash and the factory's WETH pool for it at `poolFee`. The script deploys no strategy account: accounts are created per owner through `NaryxStrategyAccountFactory`.

```bash
forge script script/DeployBaseSepoliaAtomicPackage.s.sol:DeployBaseSepoliaAtomicPackage \
  --sig "run((uint32,bytes32,uint64,address,address,address,address,address,(address,bytes32,address,bytes32,uint24),(address,address,address,address,address,uint32,uint32,uint16,uint16,uint16,uint128,uint16,uint16,uint16,uint128,uint128,uint128)))" \
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
| `collateral` | the `quote.token` address | Naryx Test USDC; the script rejects any token but the quote token |
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

Funding keeper duty: the keeper mirrors a real venue's funding. Each venue funding interval (hourly for the reference venue), it reads that venue's ETH funding rate as a fraction per interval (positive when longs pay shorts) and calls `setFundingRatePerSecond(fraction * oraclePriceWad / intervalSeconds)` as a signed WAD (quote per base per second). The rate accrues into `fundingIndex` until the next update, so a lapsed keeper leaves the last rate in force; the owner replaces a lapsed keeper with `setFundingKeeper`. The owner also funds counterparty capital with `fundInsurance(amount)` (mint tUSDC to the owner and approve the market first) sized to the largest profit open positions can realize; insurance has no withdrawal path. Anyone may `liquidate(trader)` once `health(trader)` shows equity below the maintenance requirement.

#### Strategy accounts

`NaryxStrategyAccountFactory.create(owner)` is permissionless and idempotent; it deploys `NaryxStrategyAccount(owner, verifier)` with CREATE2 salt `keccak256(abi.encode(owner))`, and `accountOf(owner)` returns the address before or after creation. A novated account keeps that address under its new owner. Every account's runtime code hash equals the factory's `accountCodeHash`.

Before an entry the owner funds the account with USDC and moves the perpetual margin into the market's gate with `depositPerpMargin(perpetualVenueSubjectId, amountAtoms)`, where the subject ID is the route's `perpetualVenue.subjectId`. The account resolves that subject in the verifier's `ResourceRegistry` and moves funds only to the active venue record at its registered code hash, with an exact allowance reset in the same call. Deposits need an `ACTIVE` venue; `withdrawPerpMargin(perpetualVenueSubjectId, amountAtoms)` also works while the venue is `ENTRY_PAUSED` or `EXIT_ONLY`. After an exit, the owner withdraws the settled reserve the same way and then uses `withdrawIdleToken`. Delegates can do neither.

Liquidated packages: once anyone has liquidated the account's perpetual position, a package exit can never match the open record, and `withdrawIdleToken` stays blocked while that record is open. The owner calls `closeLiquidatedPackage()` on the account. The verifier then closes the record only when the package's own observer reports the position at the package's instrument and expiry as fully flat (`size == 0` and `entryNotional == 0`). Otherwise it reverts with `PerpPositionStillOpen`, and with `NoOpenPackage` when no record is open. The close consumes the account's next nonce, so every instruction signed for that nonce is void. It writes no package receipt. Instead it emits `PackageLiquidationClosed(closureHash, strategyAccount, entryReceiptHash, postPerpBalanceWad, nonce)` and records `liquidationClosureOf(entryReceiptHash) = closureHash`, which marks the package as liquidated, not exited. The spot leg is not moved: the owner withdraws it with `withdrawIdleToken` or sells it, and withdraws any liquidation payout from the gate reserve with `withdrawPerpMargin`. Delegates cannot close a package this way.

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

### 3. Set the reviewed template manifest

Compute the reviewed cash-and-carry template manifest hash (`packageTemplateManifestHash` in `packages/protocol-types`) with `supportedDomains` holding the reviewed version `2` domain reference from step 2. It must equal the `templateManifestHash` the release generator derives, which is the hash every order signs.

```bash
forge script script/ConfigureBaseSepoliaAtomicPackage.s.sol:ConfigureBaseSepoliaAtomicPackage \
  --sig "runProposeTemplate(address,uint32,bytes32,bytes32,address)" "$CONFIG" 2 "$DOMAIN_MANIFEST_HASH" "$TEMPLATE_MANIFEST_HASH" "$PROPOSER" \
  --rpc-url "$RPC_URL" --account naryx-base-proposer --sender "$PROPOSER" --broadcast
# wait configDelaySeconds
forge script script/ConfigureBaseSepoliaAtomicPackage.s.sol:ConfigureBaseSepoliaAtomicPackage \
  --sig "runActivateTemplate(address,uint32,bytes32,bytes32,address)" "$CONFIG" 2 "$DOMAIN_MANIFEST_HASH" "$TEMPLATE_MANIFEST_HASH" "$EXECUTOR" \
  --rpc-url "$RPC_URL" --account naryx-base-executor --sender "$EXECUTOR" --broadcast
```

Both steps refuse unless entry is paused and the active domain is exactly the reviewed version `2` manifest, and activation refuses unless the pending proposal is exactly the reviewed hash. Confirm with `cast call "$CONFIG" "cashCarryTemplateManifestHash()(bytes32)"`.

### 4. Deploy the firm liquidity layer

`DeployBaseSepoliaFirmLiquidity.Parameters`, in order: `config`, `configCodeHash`, `verifier`, `verifierCodeHash` (both read from the chain), `reservationMaximumTtlSeconds`, `maximumBaseAtomsPerReservation`, `maximumReservedBaseAtomsPerSolver`, `shardSolver`, `seriesManifestHash`, `executionClassManifestHash`, `shardLimits` as `(maxHeartbeatSeconds,maxBatchSize,maxLevelCount)`, `bondClaimsAuthority`, `bondDisputeResolver`. `runWith` takes the token pair `(base,quote,baseCodeHash,quoteCodeHash)`: WETH and the same quote token as the atomic package (`run` pins Circle test USDC). The shard's series and execution class hashes must equal the route's below.

```bash
forge script script/DeployBaseSepoliaFirmLiquidity.s.sol:DeployBaseSepoliaFirmLiquidity \
  --sig "runWith((address,bytes32,address,bytes32,uint64,uint256,uint256,address,bytes32,bytes32,(uint64,uint16,uint32),address,address),(address,address,bytes32,bytes32))" \
  "$BASE_FIRM_PARAMETERS" "(0x4200000000000000000000000000000000000006,$TEST_USDC,0x83f731a17e6c0cdd04bc6f60b15d3e789e215b71403087b84b48650a1e5cbb21,$TEST_USDC_CODE_HASH)" \
  --rpc-url "$RPC_URL" --account naryx-base-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists `FirmInventoryReservationBook`, `DirectInventorySpotPort`, `PackageQuoteShard`, `PerformanceBondVault`. No configure step registers `DirectInventorySpotPort` as a spot adapter yet; the route below uses `UniswapV3SpotPort`.

### 5. Configure

`ConfigureBaseSepoliaAtomicPackage.Route`, in order: `config`, `domainManifestVersion` (`2`), `domainManifestHash` (reviewed), `cashCarryTemplateManifestHash` (reviewed, active from step 3), `solverRegistry`, `resources`, `seriesRegistry`, `quoteRegistry`, `verifier`, `strategyAccountFactory`, `spotPort`, `testPerpMarket`, `quoteShard`, `solver`, then eight `(subjectId,manifestVersion,manifestHash)` references for `baseAsset`, `quoteAsset`, `spotVenue`, `perpetualVenue`, `spotMarket`, `perpetualMarket`, `spotAdapter`, `perpetualAdapter`, then `seriesManifestHash`, `executionClassManifestHash`, `seriesBindingVersion`, `spotBaseAtomsPerPackageUnit`, `perpetualQuantityWadPerPackageUnit`, `quoteShardManifestVersion`, `quoteShardManifestHash`, `maximumPackageNotionalQuoteAtoms`, and `spotMarketParameters` and `perpetualMarketParameters` as `(baseLotAtoms,quoteTickAtomsPerBaseLot,minimumQuoteNotionalAtoms,contractMultiplierNumerator,contractMultiplierDenominator,baseDecimals,quoteDecimals)`.

Each `subjectId` is `cast keccak "<subjectId>"` of the same string the runtime manifest uses, and each version and manifest hash is the runtime manifest's. Every step re-verifies the deployment relationships (including that the market's collateral is the spot quote token and that the factory binds this verifier), the shard, the Uniswap pool, and the active domain and template before it sends anything.

The perpetual venue and market records are `NaryxTestPerpMarket`. The perpetual adapter record is `PackageVerifier`: the verifier is the Base perpetual port, observing the venue position before and after the trade, and it admits only a perpetual adapter whose local address is itself.

```bash
BASE_ROUTE_TYPE='(address,uint32,bytes32,bytes32,address,address,address,address,address,address,address,address,address,address,(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),(bytes32,uint32,bytes32),bytes32,bytes32,uint32,uint128,uint128,uint32,bytes32,uint256,(uint256,uint256,uint256,uint256,uint256,uint8,uint8),(uint256,uint256,uint256,uint256,uint256,uint8,uint8))'
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

### 1. Deploy the shared route

One stage deploys everything and binds it into the account factory. There is no per-user account here: any wallet later creates its own account with `GmxV2IsolatedAccountFactory.create(owner)`, an ERC-1167 clone of the reviewed implementation at a CREATE2 address salted by `keccak256(abi.encode(owner))`. One coordinator admission of the shared adapter covers every factory account.

`DeployArbitrumSepoliaAsyncGmx.Parameters`, in order: `domainManifestVersion` (`1`), `domainManifestHash` (provisional), `configDelaySeconds`, `proposer`, `canceller`, `executor`, `pauser`, `market`, `marketCodeHash`, `collateralToken`, `collateralTokenCodeHash`, `executionClassManifestHash`, the GMX code hashes as `(dataStore,eventEmitter,exchangeRouter,router,orderVault,orderHandler,roleStore)`, and the spot venue as `(chainId,factory,pool,baseToken,quoteToken,baseTokenDecimals,quoteTokenDecimals,poolFee,factoryCodeHash,poolCodeHash,baseTokenCodeHash,quoteTokenCodeHash)`. `market` is the GMX ETH/USD market `0xb6fC4C9eB02C35A134044526C62bb15014Ac0Bcc` and `collateralToken` is `USDC.SG`; confirm both with `cast call 0x4750376b9378294138Cf7B7D69a2d243f4940f71 "getMarket(address,address)((address,address,address,address))" 0xCF4c2C4c53157BcC01A596e3788fFF69cBBCD201 0xb6fC4C9eB02C35A134044526C62bb15014Ac0Bcc` (Reader, DataStore) before deploying. The spot quote token must be the collateral token. Use the fee 100 WETH/USDC.SG pool seeded above: factory `0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e`, WETH `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`, and the code hashes read with `cast codehash`.

```bash
forge script script/DeployArbitrumSepoliaAsyncGmx.s.sol:DeployArbitrumSepoliaAsyncGmx \
  --sig "run((uint32,bytes32,uint64,address,address,address,address,address,bytes32,address,bytes32,bytes32,(bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32),(uint256,address,address,address,address,uint8,uint8,uint24,bytes32,bytes32,bytes32,bytes32)))" \
  "$ARBITRUM_DEPLOY_PARAMETERS" \
  --rpc-url "$RPC_URL" --account naryx-arbitrum-deployer --sender "$DEPLOYER" --broadcast --slow
```

`.returns` lists `ProtocolConfig`, `AsyncBondedPackageCoordinator`, `GmxV2OrderVerifier`, `GmxV2ExitOrderVerifier`, `GmxV2IsolatedAccountFactory`, `GmxV2ArbitrumAdapter`, `GmxV2ExitController`, `UniswapV3SpotPort` (verified by the factory), and the `GmxV2IsolatedAccount` implementation. The deployer is the factory's one-time configurator; `configure` runs inside the same script and cannot run again. Read the shared account code hash with `cast call "$ACCOUNT_FACTORY" "accountCodeHash()(bytes32)"`.

### 2. Rotate to the reviewed domain manifest

Compute the reviewed hash with `DOMAIN_ID=eip155:421614`, `CHAIN_REFERENCE=421614`, `SETTLEMENT_CLASS=ASYNC_BONDED_SOLVER`, and `EXECUTION_VERIFIER_CODE_HASH=$(cast codehash "$COORDINATOR" --rpc-url "$RPC_URL")`. Then run `runProposeDomain` (proposer), wait, and `runActivateDomain` (executor) exactly as in the Base lane, against `script/ConfigureArbitrumSepoliaAsyncGmx.s.sol:ConfigureArbitrumSepoliaAsyncGmx`.

### 3. Configure

`ConfigureArbitrumSepoliaAsyncGmx.Route`, in order: `config`, `configCodeHash`, `domainManifestVersion` (`2`), `domainManifestHash` (reviewed), `coordinator`, `coordinatorCodeHash`, `accountFactory`, `accountFactoryCodeHash`, `adapter`, `adapterCodeHash`, `exitController`, `exitControllerCodeHash`, `spotPort`, `spotPortCodeHash`, `accountCodeHash` (the factory's `accountCodeHash()`). Every step checks that the factory binds exactly this adapter, exit controller, spot port, and account code.

```bash
ARBITRUM_ROUTE_TYPE='(address,bytes32,uint32,bytes32,address,bytes32,address,bytes32,address,bytes32,address,bytes32,address,bytes32,bytes32)'
arbitrum_step() { # function, operator address, keystore name, extra flags
  forge script script/ConfigureArbitrumSepoliaAsyncGmx.s.sol:ConfigureArbitrumSepoliaAsyncGmx \
    --sig "$1($ARBITRUM_ROUTE_TYPE,address)" "$ARBITRUM_ROUTE" "$2" \
    --rpc-url "$RPC_URL" --account "$3" --sender "$2" "${@:4}"
}
```

Steps, in order:

| Step | Operator |
|---|---|
| `runProposeAdmission` | proposer |
| `runActivateAdmission` (after `configDelaySeconds`) | executor |
| `runScheduleUnpause` (requires the active admission and the exact factory binding) | proposer |
| `runActivateEntry` (after `configDelaySeconds`) | executor |

No owner step exists. A trader's own wallet creates its account (`create(owner)` on the factory, permissionless and idempotent), signs each reservation, and funds each request with `fundRequest` on the adapter; the solver only bonds and submits. The solver's bond and recovery reserve are USDC.SG atoms, minted to the solver wallet as above.

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
- Each resource identity also carries `subjectId`, `manifestVersion`, and `manifestHash`, equal to the route references registered in step 5.
- `uniswapV3.spotPort`, `uniswapV3.pool`, `uniswapV3.factory`: the same identities as the spot adapter, market, and venue.
- `conformancePerpetual`: `instrument` and `observer` are `NaryxTestPerpMarket`, `evidenceLabel` `"BASE_SEPOLIA_CONFORMANCE_ONLY"`. The subject ID an owner passes to `depositPerpMargin` is `deployment.perpetual.venue.subjectId`.
- `seriesBindingInput`: the binding registered in step 5 (route `seriesManifestHash`, `executionClassManifestHash`, `seriesBindingVersion`, and units per package).
- `atomicEvidenceClass`: `"PACKAGE_VERIFIER_ATOMIC_V1"`. `finality.manifestHash` equals the domain manifest's `finalityPolicyHash`. `admission` and `executionPolicy` are reviewed configuration, not deployment output.

Arbitrum (`schemaVersion` `1`, `activationState` `"ACTIVE"`, `observationStartBlock`, `deployment`):

- `observationStartBlock`: bigint, the coordinator's deployment block from `.receipts`.
- `deployment.domainManifest`: the reviewed version `2` manifest.
- `deployment.protocolConfig`, `coordinator`, `accountFactory` (`GmxV2IsolatedAccountFactory`), `accountImplementation` (the factory's `implementation()`), `entryAdapter` (`GmxV2ArbitrumAdapter`), `orderVerifier` (`GmxV2OrderVerifier`), `market`, `collateralToken`: deployed or reviewed identities. An order's settlement account must equal the owner's factory account, which the API and solver derive offline from `accountFactory` and `accountImplementation`; the API checks at startup that the factory binds the adapter and implementation and that `accountCodeHash()` is the clone code hash.
- `deployment.gmx`: `dataStore`, `eventEmitter`, `exchangeRouter`, `router`, `orderVault`, `orderHandler`, `roleStore` at the pinned addresses with their reviewed code hashes.
- `deployment.executionClassManifestHash`: bytes of the deploy parameter. `deployment.route.coordinatorEvidenceSchemaHash`: bytes of `cast keccak "NARYX_ASYNC_VENUE_EVIDENCE_V1"`. The series identity key, binding version, and binding hash are the ones solvers put in reserved terms.

The Arbitrum manifest has no field for the exit controller or the spot port, so the API neither checks their code nor observes exits through them.

Every new contract's runtime code hash also belongs in the keeper's code-hash monitor targets. The indexer follows a lane through `NARYX_INDEXER_EVM_DOMAIN`, `NARYX_INDEXER_EVM_CONTRACTS` (the settlement contract: `PackageVerifier` on Base, the coordinator on Arbitrum), `NARYX_INDEXER_EVM_START_HEIGHT` (its deployment block), and `NARYX_INDEXER_EVM_BOND_VAULTS`.

### Generating them

Do not assemble these files by hand. Fill `deployments/evm/base-sepolia/release.template.json` or `deployments/evm/arbitrum-sepolia/release.template.json` outside the repository with the reviewed values and run `deployments/tools/release-manifests.mjs` with the broadcast records. It derives every address, code hash, deployment block, and the reviewed domain manifest hash from the broadcast and the live chain, checks the hash against `ProtocolConfig.domain()`, and writes the runtime manifests, order contexts, solver configs, keeper targets, indexer env, and web env. See `deployments/tools/README.md`.

## Release record

After a reviewed lane completes, commit a non-secret record under `deployments/evm/<network>/` stating:

- chain ID and release commit;
- solc `0.8.37`, optimizer runs `200`, EVM version `cancun`, and the Forge version;
- each contract's name, address, deployment transaction, block, and runtime code hash;
- the provisional and the reviewed domain manifest (version, hash, and the full reviewed manifest);
- on Base, the reviewed cash-and-carry template manifest and its hash, and the transactions that proposed and activated it;
- the four governance roles, `configDelaySeconds`, and every governance transaction with its activation time;
- every external dependency identity and code hash that was pinned (Uniswap V3, GMX, tokens);
- known limitations: the Base perpetual leg is the Naryx test perpetual market (oracle-priced, house counterparty, keeper-set funding), not a venue; strategy accounts are created per owner through the factory;
- a statement that deployment implies no funding, solver activity, or package execution.

Broadcast files, keystores, RPC URLs, and environment files stay untracked.

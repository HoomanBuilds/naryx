# EVM contracts

Foundry workspace for the EVM protocol contracts.

## Local validation

```bash
forge fmt --check
forge build
forge test
```

## Performance bonds

`PerformanceBondVault` holds solver performance bonds that pay harmed takers for objective, evidence-bound faults: failing to honor a funded reservation, submitting off route, or withholding a required recovery action. A solver locks exactly the bond amount it names (a token that skims transfers is refused) and the faults it covers. Only the claims authority files a claim, against a unique fault evidence hash, within the per-claim cap and the unencumbered bond; only the bonded solver can dispute it, inside the dispute window; an undisputed claim pays once the window closes, and a disputed one pays only if the separate dispute resolver rejects the dispute. After expiry, with no open claim, the unpaid remainder returns to the solver exactly once. `BondOpened` carries every term a claim is judged against (bond amount, covered faults, per-claim cap, dispute window, expiry), so the indexer can replay a bond from logs alone. The vault is not deployed anywhere.

## ABI publication

From the repository root, regenerate the ABI-only conformance artifacts with:

```bash
contracts/evm/scripts/publish-conformance-abis.sh
```

## Pinned production-state fork qualification

The fork tests are read-only against production RPCs. All writes, token deals, and Naryx deployments exist only inside the ephemeral Foundry fork. The tests never broadcast and never require a signer.

Both tests skip with an explicit reason when their RPC variable is absent. When an RPC is supplied, the block number, addresses, expected code hashes, decimals, fees, and trade bounds are mandatory. These values are reviewed point-in-time evidence, not runtime configuration.

Base verifies the configured Uniswap V3 factory, pool, token identities, code hashes, pool relationship, fee, and decimals. It then deploys `UniswapV3SpotPort` inside the fork and performs a bounded fork-local entry and exit:

```bash
BASE_MAINNET_RPC_URL=... \
BASE_MAINNET_FORK_BLOCK=... \
BASE_UNISWAP_V3_FACTORY=... \
BASE_UNISWAP_V3_POOL=... \
BASE_SPOT_BASE_TOKEN=... \
BASE_SPOT_QUOTE_TOKEN=... \
BASE_UNISWAP_V3_POOL_FEE=... \
BASE_UNISWAP_V3_FACTORY_CODE_HASH=... \
BASE_UNISWAP_V3_POOL_CODE_HASH=... \
BASE_SPOT_BASE_TOKEN_CODE_HASH=... \
BASE_SPOT_QUOTE_TOKEN_CODE_HASH=... \
BASE_SPOT_BASE_TOKEN_DECIMALS=... \
BASE_SPOT_QUOTE_TOKEN_DECIMALS=... \
BASE_FORK_ROUND_TRIP_BASE_ATOMS=... \
BASE_FORK_ROUND_TRIP_MAX_QUOTE_ATOMS=... \
forge test --match-contract BaseMainnetForkQualificationTest
```

Arbitrum verifies the configured GMX deployment code hashes, ExchangeRouter relationships, and OrderHandler controller role. It deploys the current Naryx isolated account and adapter inside the fork, verifies deployment compatibility, and stops before any live GMX order submission:

```bash
ARBITRUM_MAINNET_RPC_URL=... \
ARBITRUM_MAINNET_FORK_BLOCK=... \
ARBITRUM_GMX_DATA_STORE=... \
ARBITRUM_GMX_EVENT_EMITTER=... \
ARBITRUM_GMX_EXCHANGE_ROUTER=... \
ARBITRUM_GMX_ROUTER=... \
ARBITRUM_GMX_ORDER_VAULT=... \
ARBITRUM_GMX_ORDER_HANDLER=... \
ARBITRUM_GMX_ROLE_STORE=... \
ARBITRUM_GMX_MARKET=... \
ARBITRUM_GMX_COLLATERAL_TOKEN=... \
ARBITRUM_GMX_DATA_STORE_CODE_HASH=... \
ARBITRUM_GMX_EVENT_EMITTER_CODE_HASH=... \
ARBITRUM_GMX_EXCHANGE_ROUTER_CODE_HASH=... \
ARBITRUM_GMX_ROUTER_CODE_HASH=... \
ARBITRUM_GMX_ORDER_VAULT_CODE_HASH=... \
ARBITRUM_GMX_ORDER_HANDLER_CODE_HASH=... \
ARBITRUM_GMX_ROLE_STORE_CODE_HASH=... \
ARBITRUM_GMX_MARKET_CODE_HASH=... \
ARBITRUM_GMX_COLLATERAL_TOKEN_CODE_HASH=... \
forge test --match-contract ArbitrumMainnetForkQualificationTest
```

Record a completed qualification under `deployments/evm/fork-evidence/` only after reviewing the pinned inputs and real test output. Do not copy those values into application runtime configuration.

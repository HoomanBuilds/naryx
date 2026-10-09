# services/keeper

Lifecycle and risk automation. Strategy health evaluation, pre-authorized rebalance, roll, scheduled exit, funding settlement, bounded recovery driving, and dependency and qualification monitoring.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Every action is bound to a signed condition, maximum cost, resulting risk bound, and expiry. An action labeled risk-reducing may not increase leverage, notional, loss bound, or authority. A keeper never receives a general trading key, and an unsupported automatic action stays disabled rather than being granted one.

## Current implementation

The Hyperliquid package-attempt state machine consumes a compiled `HyperliquidExecutionPlan` and authoritative account reconciliation snapshots. It binds the exact domain, commitments, 128-bit client order IDs, master or subaccount identity, monotonic evidence, terminal IOC states, deltas, positions, open orders, and fee evidence before classifying an outcome.

Immediate submission responses cannot complete an attempt. Exact and bounded outcomes remain distinct, no-effect requires zero fills and no open orders, and unsafe or unresolved evidence fails into reconciliation, a typed recovery obligation, or manual intervention. The reducers and journals are pure and deterministic. They have no networking, signing, key handling, nonce allocation, persistence, or broadcast path.

The pure submission journal adds a per-agent signer-process lease, strictly increasing nonce reservations, exact action and plan commitments, and compare-and-set transitions. Its action digest uses the exported Naryx canonical action commitment scheme; it is not a Hyperliquid signing hash or wire codec. Its durable-record-confirmed state records a caller's claim that the prepared record was persisted. The caller must durably commit the journal's submitted-unknown transition before attempting a network write. A crash or lost response then hands the same trading-account identity and client order IDs to account reconciliation. HyperCore retains only its 100 highest nonces per agent wallet, so the monotonic high-water mark must be retained by an external durable store. The journal has no storage, signer, API client, or broadcast path. A fenced or retired agent address cannot be registered again within the persisted journal; recovery requires a fresh agent address.

The authoritative evidence collector is a testnet-only read path over Hyperliquid's Info API. It pins `https://api.hyperliquid-testnet.xyz`, proves the master or subaccount relation with `userRole`, derives market and token names from pinned metadata indices, queries every client order ID independently, and commits each raw response. A pre-submission account checkpoint fixes the inclusive fill-window start so evidence cannot omit activity between the balance baseline and submission. Balance, position, fill, and fee quantities use exact decimal conversion; a value that requires rounding is rejected. Incomplete pagination, a 10,000-fill retention boundary, uncertain fee tokens, stale or mixed snapshots, and ambiguous orders fail closed without reducer input. The collector has no signer, exchange client, private key, order submission, or broadcast surface.

## Hyperliquid SDK dependency

`@nktkas/hyperliquid` is pinned at `0.33.3` for the maintained TypeScript Info API request types and transport. The release is MIT licensed, requires Node `>=22.12.0`, and has npm integrity `sha512-fvnEw/2ejN14ZZVXA+nFQ9YgfFNjCI1yLliYyUboC6hr3Gwd/RwC4Ox90K4e8tkKWqkVpOcLRQ30p0nTeK4NBQ==`. The upstream repository and npm release history show continuing maintenance through this pinned release. `npm audit --omit=dev` reports zero vulnerabilities. Only `InfoClient` and the HTTP transport are imported; signing and exchange APIs are not imported or exposed.

The endpoint shapes and pagination limits come from the official [Info endpoint documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Recovery collection binds source and recovery orders to authoritative fills, values completion slippage against the original signed leg limit, values rollback loss against the source fills being unwound, and rounds adverse quote loss upward. Venue fees remain a separate actual recovery-cost ledger. Missing or inconsistent fill evidence returns typed incomplete evidence with raw commitments and never fabricates zero loss.

## Mainnet shadow reader

The Hyperliquid mainnet shadow reader is signerless and pins the official `https://api.hyperliquid.xyz` Info API. It has no URL override, exchange client, key, order, or broadcast surface. It rejects Testnet and any read port that is not explicitly identified as the official mainnet endpoint.

For one configured spot-perpetual pair it verifies exact universe, token, collateral, and perpetual identities; canonical flags; token IDs; decimals; market context alignment; two-sided ordered books; response freshness; book age and skew; mark-to-oracle divergence; funding; open interest; and the public fee schedule. It conservatively sweeps spot asks and perpetual bids at the configured size using integer quote atoms, rounds costs and taker fees upward, rounds proceeds downward, and rejects an entry whose executable cost exceeds the configured bound.

Each accepted observation returns its observation time, a commitment to the complete source snapshot, a separate fee-schedule commitment, verified market state, and bounded executable economics. The result stays in memory for caller-controlled durable storage. It is dated evidence, not a runtime manifest or mutable source of truth. The reader never activates a market and never writes to mainnet.

## Dependency incidents

The dependency incident engine tracks one exact domain, template, settlement class, quote mode, and size cohort. It ingests signerless qualification evidence commitments and explicit code drift, authority drift, stale evidence, oracle divergence, liquidity loss, recovery unavailability, signer fencing, and cap exhaustion triggers. Automatic transitions can only reduce permissions. Safe exits remain enabled when the accepted dependency evidence says they are safe.

The durable file store writes an atomic restart-safe snapshot with a hash-chained sequence of immutable drill receipts. A receipt binds the prior and resulting state, permissions, trigger, evidence, approvals, timestamp, and previous receipt. Restoration requires fresh READY evidence for the same scope and two distinct nonzero risk or incident reviewer role commitments. The engine has no signer, network client, broadcast path, or automatic onchain pause authority.

## Code-hash monitor

The code-hash monitor is the service that feeds `CODE_DRIFT`. It reads reviewed code identities through read-only RPC: keccak-256 of `eth_getCode` on EVM, and SHA-256 of a Solana program's executable bytes from its ProgramData account, with loader metadata and trailing zero padding excluded. A different hash is `DRIFT` and absent code is `MISSING`; either quarantines the affected scope in its incident journal, with evidence that commits to the exact observations. A failed read is `UNREADABLE`, reported and never treated as a match. It is off unless `NARYX_CODE_WATCHLIST` names a protocol-JSON watchlist of targets, scope journals with their current readiness decisions, the poll interval (at least 5 seconds), and the evidence validity. It holds no key and never writes to a chain; restoring a quarantined scope remains a reviewed action.

Every target names its chain with `chainRef`: `eip155:<chain id>` (for example `eip155:84532` for Base Sepolia and `eip155:421614` for Arbitrum Sepolia), `solana:devnet`, or `solana:mainnet-beta`. Any other reference fails closed. Each chain a target uses needs its own URL in `NARYX_KEEPER_RPC_URLS`, so Base Sepolia and Arbitrum Sepolia are watched together through separate endpoints. In every pass, before any code on a chain is read, that chain's endpoint must prove its identity from chain data: `eth_chainId` must equal the eip155 chain id, and `getGenesisHash` must equal the cluster's genesis hash (Devnet `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, mainnet-beta `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`). An endpoint that answers for another chain makes every target on it `RPC_IDENTITY_MISMATCH` and reads no code; like `UNREADABLE`, that is reported and never quarantines a scope, because a misrouted URL says nothing about the watched code.

`NARYX_KEEPER_RPC_URLS` is one JSON object of chain reference to URL, for example `{"eip155:84532":"https://...","eip155:421614":"https://...","solana:devnet":"https://..."}`. URLs must be https, or http to a loopback host. A URL may carry a provider key, so it never appears in an error or log line. The earlier single `NARYX_EVM_RPC_URL` and `NARYX_SOLANA_RPC_URL` variables are no longer read: one EVM URL cannot serve two EVM chains.

The position snapshot pass reads HyperCore testnet accounts only (`clearinghouseState`, `spotClearinghouseState`, and `allMids` for indicative spot marks) and normalizes them through `@naryx/adapter-hyperliquid` into kernel positions. Coins without a binding are listed as unmapped rather than valued. Each account becomes one `PositionSnapshotRecord` that binds the hash of the exact responses read, signed over its hash by the position authority key, and posted to the public API's `POST /v1/position-snapshots`, which verifies the signature before storing it. It is off unless `NARYX_POSITION_WATCHLIST` names a protocol-JSON watchlist (interval of at least 5 seconds, a non-mainnet environment, an https or loopback API URL, the authority key id, and the accounts with their coin bindings) and `NARYX_POSITION_AUTHORITY_KEY_FILE` names the absolute path of the Ed25519 PKCS#8 key. That key signs observations only and carries no authority over any account.

The collateral snapshot pass reads only HyperCore testnet `clearinghouseState`. It counts the venue-reported `withdrawable` amount as own available collateral, never derives a larger amount from account value, and always reports zero borrowing capacity and cost. Each observation binds the exact response hash, uses the reviewed watchlist's USDC asset identity, haircut, withdrawal delay, strategy account, owner, and risk domain, and is signed before it reaches `POST /v1/collateral-snapshots`. It is off unless `NARYX_COLLATERAL_WATCHLIST` and `NARYX_COLLATERAL_AUTHORITY_KEY_FILE` are set. The reader has no exchange client, wallet key, transfer, borrow, order, or mainnet write path.

Keeper automation (`runKeeperAutomationPass`, `NARYX_KEEPER_AUTOMATION_CONFIG`): for every owner-signed keeper authorization, the pass verifies the owner's Ed25519 signature over the authorization bytes, skips a nonce its journal already consumed, reads the strategy's observed health and state hash from a loopback executor, asks it to project the action, and lets the kernel decide with every bound (condition, cost, reward, resulting risk, risk reduction, manual takeover, expiry). Only an authorized action is dispatched, and its nonce is journaled (fsynced, append-only) as consumed before dispatch, so a lost response can never cause a second execution. The executor routes are the API private server's `/internal/keeper/` routes; the executor re-verifies the owner signature and every bound itself and answers `QUEUED` when it queues the action once, which the journal records. The keeper holds no trading key.

The keeper's clock reads `EVM_UNIX_SECONDS` and `HYPERLIQUID_UNIX_MILLISECONDS` from its wall clock. `SOLANA_SLOT` comes only from the `solana:devnet` URL in `NARYX_KEEPER_RPC_URLS`: each read first proves the Devnet genesis hash, then reads `getSlot` at `confirmed` commitment. Expiry is reached when the clock is at or past the expiry slot, and observation age grows with the clock, so the later reading is the conservative one; `finalized` trails `confirmed` by about 32 slots and would let an action through that long after its expiry. Without a Devnet URL, or for any other unit, an authorization stays `NOT_READY` with `TIME_UNIT_UNSUPPORTED`. A failed or mismatched slot read reports the authorization as `FAILED` without consuming its nonce. Each `SOLANA_SLOT` authorization costs two read-only calls per pass.

## Funding mirror

The Naryx test perpetuals must charge the funding the real venue charges, so a testnet strategy predicts mainnet carry. The funding mirror in `src/funding-mirror.ts` reads `metaAndAssetCtxs` from the pinned Hyperliquid mainnet Info API (`POST https://api.hyperliquid.xyz/info`, no URL override, no signer, no exchange client) and sets the mirrored rate on each configured test market.

Conversion is exact rational arithmetic on the decimal strings Hyperliquid returns; a non-plain decimal fails closed. Results truncate toward zero, so a mirrored rate never exceeds the venue's magnitude.

- Base Sepolia `NaryxTestPerpMarket.setFundingRatePerSecond(int256)` takes an absolute quote WAD per base unit per second. The hourly fraction is applied to the Hyperliquid `oraclePx`, the price Hyperliquid charges funding against: `funding * oraclePx * 1e18 / 3600`.
- Solana Devnet `naryx_test_perp.set_funding_rate(i64)` takes a fraction of oracle notional per second scaled by `1e12`: `funding * 1e12 / 3600`. Accounts are the funding keeper signer, the writable market, and the market's oracle read from the market account.

Each target is clamped to the bound read from the market itself (`maxAbsFundingRatePerSecond`, `max_funding_rate_per_second`), and a clamp is logged. Before reading a market, every pass verifies `eth_chainId` 84532 or the Solana Devnet genesis hash from chain data, then checks that the market's funding keeper is the loaded key before any submission. A change smaller than the market's `minChange` (native units) against the current onchain rate is skipped. A confirmed submission is written to the durable last-submitted record file (atomic replace after fsync). The current onchain rate, not the record, decides the next submission, so a lost record cannot cause a duplicate effect.

Only `eip155:84532` and `solana:devnet` markets are accepted. The job is off without `NARYX_FUNDING_MIRROR_CONFIG`, runs as a dry run unless `NARYX_FUNDING_MIRROR_WRITES=enabled`, and loads keeper keys only from the absolute paths in `NARYX_FUNDING_KEEPER_EVM_KEY_FILE` and `NARYX_FUNDING_KEEPER_SOLANA_KEY_FILE`. RPC URLs come from `NARYX_KEEPER_RPC_URLS`.

```json
{
  "intervalMs": 300000,
  "recordPath": "/absolute/path/to/funding-mirror-record.json",
  "markets": [
    { "id": "base-sepolia-eth", "chainRef": "eip155:84532", "market": "0xReviewedTestPerpMarket", "coin": "ETH", "minChange": "1000000000" },
    { "id": "solana-devnet-sol", "chainRef": "solana:devnet", "market": "ReviewedMarketPubkey", "programId": "ReviewedTestPerpProgramId", "coin": "SOL", "minChange": "10" }
  ]
}
```

`viem` `2.56.8` and `@solana/web3.js` `1.99.0` are pinned to the versions the other services use. `npm audit --omit=dev` reports moderate advisories in `@solana/web3.js`'s transitive `jayson`, `stream-json`, and `uuid` dependencies; the keeper only talks to its configured RPC endpoint.

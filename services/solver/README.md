# services/solver

Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation.

Public control reaches `services/api` over the published solver protocol, so an independent solver can run the same path from outside this repository. Direct venue writes are limited to the private Hyperliquid Testnet submission boundary and the bounded testnet setup CLI described below.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Being the reference implementation is not a network claim. Team-operated solver volume is reported separately from independent volume.

## Current implementation

### Bounded testnet venue setup

`node dist/testnet-dex-margin.js --journal /absolute/external/setup.json` checks the configured Hyperliquid Testnet account and prints a non-broadcast plan. With `--broadcast`, it moves exactly 20 mock USDC from default perp margin to the same owner's `sekaw` margin. It uses the existing approved testnet agent, pins the testnet endpoint and collateral catalog, refuses mainnet signatures and active positions, and saves the signed request before submission. Reopening an existing journal performs read-only checks and never sends another transfer.

After verified funding, `--leverage --broadcast` configures only the two reviewed testnet BTC markets for isolated 5x leverage, verifying each result. Its separate `.leverage` journal prevents automatic resubmission after an interrupted response. This is a bounded one-time testnet setup tool, not a production rebalancer, maker daemon, or permission to trade other markets. Both commands require the configured trading account, master account, agent address and external testnet agent key path.

### Process composition and what is real

`npm start` runs `dist/main.js`. The quote listener binds loopback only, on `NARYX_SOLVER_PORT` (default `8788`, the port `services/api` uses for `NARYX_SOLVER_INTERNAL_ORIGIN`). Every composed runtime reserves quote nonces durably in the SQLite quote database, so nonces survive restarts.

Always required: `NARYX_SOLVER_ED25519_KEY_PATH` (an absolute path to an external Ed25519 private key; `NARYX_SOLVER_ED25519_PUBLIC_KEY_HEX` optionally pins its public key) and `NARYX_SOLVER_QUOTE_DB` (an absolute path to the durable quote database). Nothing defaults into `/tmp` outside fixture mode.

The process composes only the runtimes it is explicitly configured for:

| Runtime | Enabled by | Price source | Real or static |
|---|---|---|---|
| Manifest-validated local Solana | `NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST`, `NARYX_SOLANA_LOCAL_SOLVER_ID`, `NARYX_SOLVER_SOLANA_AUTHORIZATION_DB` | The manifest's local conformance catalog | Program identity, genesis hash, and validator slot clock are read from the local validator. Prices and fees are the conformance venue's configured catalog values, not a market. |
| Hyperliquid Testnet quotes | `NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED=true`, `NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG`, `NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT` | Live Testnet `l2Book` and `userFees` | Prices and fee rates are read live per quote. Static values are listed below. |
| Generalized Hyperliquid strategy quotes | `NARYX_HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED=true`, one matching preparation lane, and the explicit generalized execution-class variables | Live Testnet `l2Book`, `userFees`, and perpetual funding context | Signs typed cash-and-carry, treasury hedge, or two-market funding-spread package quotes at `POST /internal/strategy-quotes`. It performs no venue write. |
| Sealed auction participant | `NARYX_SEALED_AUCTION_PARTICIPANT_ENABLED=true` plus registered solver identity, key id, and an external journal | The enabled generalized quote lane for each addressed order | Discovers only eligible auctions, persists the secret opening before commit, resumes across restarts, and reveals after the common deadline. It performs no venue write. |
| Local fixture | `NARYX_LOCAL_FIXTURE_MODE=true` only | `LOCAL_ATOMIC_MARKET_CATALOG_V1` | Entirely static: fixed prices, zero fees, placeholder hashes, and a wall-clock-derived slot. Quotes are still signed with the configured solver key. The quote database may fall back to `/tmp/naryx-local/solver-quotes.db` only in this mode. It cannot be combined with a Solana environment manifest. |

With none of them configured the listener starts with `runtime=NONE` and every quote fails closed. The startup line reports `runtime=` and `hyperliquidTestnetQuotes=`, and fixture mode prints an explicit warning.

The sealed auction participant uses the authenticated API feed rather than guessing auction hashes. Its cursor, quote hash, net outcome, and 32-byte salt are stored in a separate full-synchronous SQLite journal before the commitment is sent. Exact commit and reveal retries are idempotent at the relay, so a response lost between network acceptance and local acknowledgement can be retried without adding another event. An auction is not entered unless both its signed quote and bound execution route remain valid through the settlement deadline on the auction's clock. The API independently checks this bound before admitting an award. Slot-timed auctions are refused because this process has no authoritative slot clock for the cross-domain relay.

Missed commit or reveal windows retain the last failure in the private journal, including quote
refusals caused by stale test-market oracles. Successful progress clears the old error. A
`NO_FILL` result is not a trade and does not justify bypassing oracle freshness checks.

With `NARYX_SEALED_AUCTION_THRESHOLD_ENABLED=true`, eligible timed auctions with more than sixty
seconds between the pinned beacon release and reveal deadline use encrypted openings. The exact
ciphertext is journaled before delivery and reused on retry. A restart or disabling the flag never
downgrades a journaled ciphertext to a plaintext reveal. The participant reads its authenticated
release status and waits for verified server decryption before finalizing an award. Short-window
auctions remain ordinary commit/reveal; the flag does not claim that every auction is encrypted.
This requires the API's separate threshold flag. Quote validity must cover the longer window.

The pinned `tlock-js` release uses drand-client's v1 hash imports. The explicit `@noble/hashes`
1.8.0 dependency supplies those otherwise undeclared imports; clients needing v2 retain their
own nested version. Do not remove this pin without verifying both dependency paths.

### Durable cross-domain EVM submission

Cross-domain EVM submission uses an owner-only SQLite journal outside the checkout. Each domain
requires a dedicated sender and an explicit gas budget including prior expenditure. The journal
persists the operation, nonce and signed transaction before broadcast, reserves its maximum gas
cost, and retries only the same bytes. A pending outcome fences other submissions from that sender;
only canonical finalized receipts release that fence. Reverts retain their gas reservation and
cannot silently become replacement transactions. Changing the payload, signer, chain or initial
budget refuses the journal.

Preparation requires the reservation to outlive the commit deadline and expire before the
compensation deadline. The reservation lane accepts only inventory release, never a claim to
reverse an executed position. Evidence timestamps are checked against chain time sampled after
the lane call: a block can arrive during RPC validation. Coordination journal URLs accept only
loopback IP literals or localhost, not hostnames beginning with `127.`.

`cross-domain-main.js` is the separate, disabled-by-default worker. Set
`NARYX_CROSS_DOMAIN_ENABLED=true` and `NARYX_CROSS_DOMAIN_CONFIG` only for a reviewed two-domain
Base Sepolia and Arbitrum Sepolia cohort. Its external configuration specifies the allowlisted
owners and strategy accounts, exact adapter deployments, per-domain quote-atom caps, signer files,
submission journals, durable job database, loopback coordination API, and gas budgets. Gas is
capped at 0.01 test ETH per domain, including configured prior expenditure. RPC identity is read
from the chain before the worker runs.

Import a signed job once using `node dist/cross-domain-main.js --enqueue /absolute/job.json`.
The job includes the exact entry and recovery authorization on both domains. Importing it does
not broadcast. The daemon validates its own caps again before each advance. Its account locks,
authorizations and submission history survive restart; unresolved or manual-intervention outcomes
keep accounts fenced. Final chain evidence, not an API terminal label alone, releases a fence.

Finality timestamps can lag between chains. The driver defers an observation older than the
latest journal event without rewriting its evidence time. For an existing isolated clock-order
fence, `node dist/cross-domain-reconcile-main.js PLAN_HASH` independently checks both finalized
entry receipts, current positions, ownership, deployment identities and reservations. It uses
the worker's environment/configuration, accepts only the configured dedicated Sepolia accounts,
and cannot sign or broadcast by default.

If this inspection reports expired unused inventory, the explicit
`--release-expired-inventory` mode uses the existing capped submission journal to release only
those exact reservations. It does not trade or retry entries. After finalized release, `--apply`
rechecks the evidence and appends an immutable resolution to the job store before clearing its
account locks. The original coordination events, signed documents and fenced replay stay intact;
the resolution binds their history hash and both finalized transaction hashes. Other failures,
incomplete finality, changed state and ambiguous outcomes cannot use this procedure.

The version-two recovery path supports exact spot purchases and their full sales, plus qualified
recoverable perpetual and dated-future adapters. A derivative close binds the exact entry generation,
adapter identity, signed quantity and payload; an ordinary derivative adapter is not interchangeable.
The owner signs maximum entry spend, minimum recovery proceeds, and a bounded recovery window.
Finalized receipts, zero residual derivative positions and reserves, and token deltas must prove
the full reversal within the loss cap. Unused inventory reservations are released only after
finalized expiry; a reservation is not represented as a guarantee of external pool liquidity.
The systemd unit is `deployments/aws/systemd/naryx-cross-domain.service`. Implementation or startup
alone is not live qualification: activation still requires recorded execution and recovery evidence.
The dedicated Base/Arbitrum Sepolia worker was enabled on AWS on 2026-10-18 against new version-3
domain deployments. The later canonical-calendar integration also admits separately approved
website packages, with separate capped senders. It does not fund users' strategy accounts.

### Maker emergency controls

EVM native strategy runtimes also require `NARYX_EVM_STRATEGY_AUTHORIZATION_DB`, an absolute durable SQLite path outside the checkout. After owner authorization succeeds, the solver journals the exact execution snapshot before returning signed calldata. Receipt observation reads this snapshot instead of recreating an entry against already-mutated positions. Missing authorization evidence fails closed. Preserve this database across deployments and restarts.

`NARYX_MAKER_CONTROLS_ENABLED=true` adds two loopback-only routes to the quote listener: `POST /internal/maker/shards/{shardId}/cancel-all` and `POST /internal/maker/shards/{shardId}/kill-switch`. Each request contains only the exact lowercase shard hash and decimal shard sequence the operator observed. The solver re-reads that shard through the authenticated solver API, rejects stale state, derives the restricted next state, signs it with the external quote key, and verifies the API admitted the same hash and sequence.

The routes reject browser-originated requests. They cannot place or replace levels, change capacity, heartbeat, clear a kill switch, or accept arbitrary shard bytes. Re-arming remains a separate deliberate operational procedure. Set `NARYX_MAKER_SOLVER_API_ORIGIN` to the loopback listener that serves `/v1/solver`, then bind `NARYX_MAKER_SOLVER_ID` and `NARYX_MAKER_QUOTE_KEY_ID` to the registered capability manifest.

### Hyperliquid Testnet quote runtime

#### Per-user account isolation

`NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE=PER_USER` is the default execution mode. Native
strategy creation binds both the order settlement account and graph account reference to the
signing owner. Generalized quote pricing reads that owner's fee schedule rather than the
operator fixture's schedule. Execution requires the same signed owner and settlement account
at selection and again inside the selected account's execution lane.

With the executor enabled, `NARYX_HYPERLIQUID_TESTNET_USER_ACCOUNTS` names an external JSON file:

```json
{
  "version": 1,
  "environment": "TESTNET",
  "accounts": [
    {
      "owner": "0x1111111111111111111111111111111111111111",
      "agentAddress": "0x2222222222222222222222222222222222222222",
      "agentKeyPath": "/var/lib/naryx/keys/user-a-agent.json",
      "journalPath": "/var/lib/naryx/hyperliquid/user-a.sqlite",
      "signerLeaseId": "user-a-testnet-v1"
    }
  ]
}
```

These are placeholders, not deployed accounts. Each owner must fund their own Hyperliquid
Testnet account and approve their own separate API wallet. Each key file uses the existing
external Testnet signer format and permission checks. Owner addresses, agent addresses, key
paths, journal paths, and signer leases must be unique. V1 supports owner master accounts, not
subaccounts. The configuration supports at most 64 explicitly provisioned accounts, including
an empty list that refuses all execution. It contains key paths, never private keys. Preserve
each journal across restarts; do not reuse the historical shared fixture journal for a new user.

Each account has independent signing, durable nonces, submission serialization, authority
fences, reconciliation, and bounded recovery. Unknown owners and mismatched accounts fail
closed with no shared-account fallback. The same market allowlists and size gates still apply.
The venue's API-wallet approval grants trading authority; Naryx's market restrictions are
enforced by its execution service, not a claim that Hyperliquid implements arbitrary per-agent
market restrictions. The owner's private key is never supplied to this service.

`SHARED_TEST_FIXTURE` is an explicit operator-test compatibility mode only. Shared-account
netting execution is refused in per-user mode: cancelling obligations between different owners
cannot settle their independent HyperCore accounts. It requires a separately qualified funded
clearing or novation mechanism. Historical shared-account evidence is not per-user settlement.

### Optional custodial testnet pool

`hyperliquid-pooled-collateral-store.ts`, `hyperliquid-pool-funding.ts`,
`hyperliquid-pool-funding-reads.ts`, and `hyperliquid-pool-withdrawal.ts` implement a
separate testnet custody boundary. `hyperliquid-pool-main.ts` hosts its operator-only
runtime independently of `main.ts`. Its signed browser operations are separately proxied by the
public API. Version 2 also accepts fully owner-authorized epochs through the browser proxy. It is disabled
by default. Existing per-user accounts are not migrated or pooled.
Consent creates a claim in Naryx's ledger, not an owner-specific HyperCore position.

- An immutable database binding pins the testnet domain, dedicated pool account,
  collateral identity and funding cap. Version 1 uses an explicit test-owner allowlist;
  version 2 permits public testnet enrollment with fresh wallet-signed custody consent.
  Wallet-signed custody and withdrawal messages bind the full configuration hash.
- Deposits credit only the amount actually received after venue fees. Both account
  ledgers and the successful testnet explorer action must agree. Reused transfer
  evidence cannot credit another operation.
- Funding and withdrawal require freshly observed, fully withdrawable equity that
  exactly reconciles with owner liabilities. Standard account mode is required;
  foreign-DEX collateral, positions, spot liabilities, pending default-DEX orders,
  and active TWAPs refuse admission.
- One durable pending operation locks the pool. Withdrawal submission is claimed
  transactionally before signing, so concurrent workers or a restart cannot send
  twice. An acknowledgement does not debit a user: observed transfer evidence does.
  A delayed inclusion can settle only with a nonce inside the owner authorization
  window and matching the journaled submission when present.
- An expired withdrawal that was never claimed for signing can release its lock
  after reconciliation. A claimed or uncertain submission cannot be released merely
  because its authorization expired. Unknown outcomes require receipt reconciliation.
- Epoch ledger primitives conserve total cash and reject allocations exceeding an
  owner's reserved loss. Profits above the funding cap can settle and withdraw;
  the cap stops new exposure, not exits.

The venue reader pins the official testnet HTTP, explorer, and WebSocket endpoints.
Its observations are trusted venue API evidence, not cryptographic solvency proofs.
The all-DEX snapshot checks balances and positions; open-order inspection is limited
to the default settlement DEX. Exclusive operator control and no out-of-band writes
are required. This foundation neither grants trading authority nor guarantees a loss
cap against market gaps.

- Every epoch needs a separate signature from every trader and one funded recovery
  sponsor. Signatures bind both execution policies, quantities, fees, loss reservations,
  deadlines, and the custody configuration. Custody consent alone cannot authorize a trade.
- Entry reserves cash before dispatch. Only terminal exact entry fills allocate virtual
  positions. Unknown entries are observed without resubmission. Cancellation tombstones
  block an unsent order permanently, including a worker racing to submit it.
- Closing is reduce-only. Partial closes retry only the remaining evidenced quantity,
  with separate intents and receipts. A cumulative close is not an atomic fill. Internal
  close prices are fixed by the initial close plan; observed external costs and fees are
  allocated pro rata with deterministic integer rounding.
- Failed entry recovery charges the separately signed sponsor, not unrelated members.
  Ordinary closing caps each trader's allocated loss and fees, charging an admitted
  shortfall to the funded sponsor. Exhausted backing leaves the pool locked. This is
  not an ex-ante guarantee against unlimited gaps or venue default.
- Funding comes from the venue ledger. Funding overlapping an unresolved execution
  interval fails closed rather than guessing the held position. A closure settles only
  when every virtual position closes and all fees, funding, and realized cash reconcile
  exactly to freshly observed withdrawable equity.
- The supervisor resumes pending epochs and closes them at their signed deadline.
  At most 32 close attempts per instrument are admitted. Unresolved venue evidence,
  exhausted retry budgets, or unexplained equity need operator reconciliation.

Run the isolated service only with `NARYX_HYPERLIQUID_POOL_ENABLED=true`,
`NARYX_HYPERLIQUID_POOL_ENVIRONMENT=TESTNET`, and an owner-only external config at
`NARYX_HYPERLIQUID_POOL_CONFIG`. It also requires the existing trusted-time environment
settings. The config pins `binding`, separate `databasePath` and `journalPath`,
`entryConfigPath`, `exitConfigPath`, explicit `markets`, `agentAddress`, `agentKeyPath`,
`custodyKeyPath`, `encryptionKeyPath`, `operatorTokenPath`, and `keeperOrigin`, plus
`version: 1` and `environment: "TESTNET"`. The two residual configs use the existing
reviewed residual policy/binding format. The pool policy hash binds both policies.
The dedicated custody key can withdraw only through the journaled testnet transport;
it is not a restricted API wallet. The separate trading key is a venue API wallet.

The systemd unit uses an exclusive process lock and listens only on loopback port
8821. An independent 32-byte hex operator token protects `/v1/pool/*`; browser-origin
and forwarded requests are refused. Commands cover enrollment, observed deposits,
signed epochs, advancement, close, recovery, and signed withdrawal preparation,
submission, evidence completion, and unsubmitted-expiry release. Responses use the
existing protocol JSON codec. The Portfolio shared-pool panel uses separate signed browser
endpoints for consent, balance, deposit reconciliation and withdrawals. Version 2 additionally
accepts a protocol-encoded epoch plan with every trader's and recovery sponsor's exact signatures.
The browser cannot access the operator token or operate another owner's claim.
Public enrollment does not remove the pool funding cap or permit unsigned trading.
Upgrading from version 1 requires an empty, flat venue account and no pending operations.
The previous ledger is retained separately; old consent is never reused for a new binding.

Version 3 binds configurable `maximumTotalQuoteAtoms` and `maximumOwnerQuoteAtoms`
to custody consent. Both are positive uint128 atom values; the owner cap cannot exceed
the pool cap. The public testnet policy uses 100,000 mock USDC total and 1,000 per wallet.
These are admission limits, not funded liquidity or performance guarantees. Deposits enforce
both limits in the same database transaction; epoch loss reservations cannot exceed the
owner cap or funded balance. Existing gross exposure, leverage and execution-policy limits
remain unchanged. Settlement and withdrawals accept profits above admission caps.
Legacy version-1/2 hashes and ceilings remain unchanged. Changing either signed limit requires
a new binding and fresh consent, never editing a funded ledger. Activate a replacement only
with zero old liabilities, an empty flat venue account and no pending operations, preserving
the original ledger and history. No operator funds are moved when raising admission limits.

The dedicated AWS test cohort completed a funded round trip on October 17, 2026:
three observed deposits backed 20 mock USDC; two signed owners held opposing BTC
quantities with a single 0.00013 BTC net venue position. The supervisor survived a
restart while open, closed once, and reconciled 19.990344 mock USDC exactly. All three
owner withdrawals completed, leaving zero pool cash, liabilities, positions, and
pending operations. This is controlled testnet evidence, not organic volume.

This dedicated cohort is not public custody enrollment or cross-account HyperCore
novation. Do not use ledger `settleEpoch` inputs from public
requests or enable shared trading through the existing per-user route. Repeating the
test requires approved funding and new signed epoch authority; idle service health
does not mean there is continuously funded pool capacity.

Canonical cash-and-carry creation, quote pricing, owner authorization, strategy staging, exits,
and the terminal use the same owner-account binding in per-user mode. The terminal never
substitutes the operator account when the wallet is disconnected. Historical shared positions
are not silently reassigned to a new venue account.

Native attempt status and lane release resolve the account from the selected attempt's stored
package commitments without preparing another trade. Expired orders remain observable and
an uncertain request that never reached submission can be durably fenced as not submitted.
New execution still requires fresh preparation, account binding, and authority checks.

Self-service testnet enrollment is optional and disabled by default. Set
`NARYX_HYPERLIQUID_TESTNET_ENROLLMENT_ENABLED=true` in both API and solver, and configure an
external owner-only enrollment directory plus a separate owner-only 32-byte encryption-key file.
The terminal requests an owner-signed enrollment, then a finite Hyperliquid Testnet API-wallet
approval using the official SDK signing schema. New API keys are AES-256-GCM encrypted at rest.
An uncertain approval is observed rather than automatically broadcast again. Fresh venue checks
require a funded Standard account, approved spot assets, isolated margin in supported markets,
no supported-market positions or orders, and no other active API wallet. Users configure and
fund those testnet accounts themselves. The service does not deposit or withdraw on their behalf.

Enrolled accounts and signed enrollment evidence are stored in SQLite and restored on startup.
Successful enrollment registers a separate runtime without restarting the service. The combined
bootstrap and enrolled cohort is capped at 64 accounts. This is not unrestricted public activation
or a claim that every token and margin mode is supported. Historical shared-position migration
is not implemented. Existing accounts may still be provisioned in the bootstrap registry.
Before enabling a registered
account, verify its owner approval, funding, and a real owner-account execution. An unregistered
owner remains unable to submit through the executor.

The generalized strategy quote lane reuses the same reviewed market config and requires exactly one
matching generalized preparation manifest. It supports `cash-and-carry-v1`,
`treasury-inventory-hedge-v1`, and `perpetual-funding-spread-v1` under the configured execution-class
identity and `BATCHED_IOC_WITH_RECOVERY`. Each quote prices every leg from live executable depth,
reads account-specific fees and the required perpetual funding contexts through the official Testnet
SDK, computes exact integer fees, margin, residuals, and package outcomes, compiles the typed route,
signs the fee-complete quote, and stores idempotency durably. A funding spread requires a distinct
`counterPerpetual` binding in the reviewed quote config. Static holding duration, reversal threshold,
and cash-and-carry exit basis are explicit estimate inputs. They do not authorize execution or
replace signed order limits. Funding-spread quotes report zero package-attributable liquidation
distance instead of assigning an account-wide margin distance to an individual package.

The ordinary signed quote listener dispatches canonical `hypercore:testnet` entry orders to a separate reference cash-and-carry quote runtime when it is enabled. The runtime emits only `BATCHED_IOC_WITH_RECOVERY` routes with `HYPERCORE_BATCHED_IOC`, exact configured versioned market references, millisecond expiry, the order's explicit `EXACT_NET` or `BOUNDED_NET` residual policy, and zero protocol, solver, and builder fees. It performs no venue write, agent signing, or execution.

For every quote it reads, signerless and through the official SDK pinned to `https://api.hyperliquid-testnet.xyz`, the spot `l2Book`, the perpetual `l2Book`, and `userFees` for `NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT`. There is one read attempt and no fallback URL or retry.

- Each IOC limit is the trader's signed bound: the spot limit is `maxSpotQuoteIn` divided by the gross spot quantity, rounded down to HyperCore wire precision, and the perpetual limit is the exact signed `hyperliquidMinPerpSellPrice`.
- The spot buy sweeps asks and the perpetual short sweeps bids, in book order, counting only levels at or inside the wire limit. A book that cannot fill the full size, is missing, mislabeled, unordered, stale or future-dated beyond `maxBookAgeMs`, crossed or locked, or wider than `maxBookSpreadBps` produces no quote. Only the levels the venue returns (top 20 per side) are counted.
- Fee rates come from `userSpotCrossRate` and `userCrossRate`. A missing, malformed, or unavailable fee schedule produces no quote; nothing defaults to zero. The runtime applies no discount of its own to these rates.
- All amounts are integer atoms. Spot cost and every fee round up and perpetual proceeds round down, against the trader. The spot taker fee is charged in the received base asset, so the expected net spot quantity is gross minus that fee. It must lie in the signed net interval, and the expected terminal residual is its exact mismatch against the perpetual quantity, valued with the signed reference price rounded up and bounded by the signed caps. An `EXACT_NET` order whose gross quantity does not absorb the base fee is not quoted.
- The quoted entry spread is spot notional per gross unit minus perpetual notional per perpetual unit. Terms are signed from the same snapshot that selected the route, and a missing or superseded snapshot fails closed.

The quote config is protocol JSON with `version: 2` and a `market` object. It carries only static identity and limits: domain, template, solver, fee policy, and recovery identities; adapter, venue, and market manifest references; base and quote asset references; per-leg `coin` and `sizeDecimals`; actions and account bindings; `capacityBaseAtoms`; `routeTtlMs` and `quoteTtlMs`; `maxBookAgeMs`; `maxBookSpreadBps`; and `marginBps`. It contains no prices, spreads, or fee rates, and a version 1 config is rejected. `marginBps` remains a static configured initial-margin fraction of perpetual notional, not a live leverage read. Lot alignment of both quantities is checked against `sizeDecimals` before any read.

Expected amounts are quote inputs only. Settlement still reconciles individual authoritative fills, fee amounts, and fee tokens.

The Hyperliquid submission service accepts only an existing compiled `HyperliquidExecutionPlan` for `hypercore:testnet`. It independently binds the master and trading account relation, subaccount vault context, agent wallet and lease, package commitments, exact official-shape IOC action, client order IDs, nonce, and request expiry. It requires an injected durable journal port whose compare-and-set lifecycle matches the keeper journal: `PREPARED`, `DURABLE_RECORD_CONFIRMED`, `SUBMITTED_UNKNOWN`, then acknowledgement, rejection, or reconciliation. An unavailable or inconsistent journal fails closed before signing or submission.

The concrete SQLite journal requires an explicit absolute database path and never defaults into the repository or accepts an in-memory database. It uses WAL mode, full synchronous commits, schema version 2, exact decimal text for bigint values, BLOBs for 32-byte commitments, global compare-and-set revisions, permanent signer lease and account nonce fences, and a committed row readback before durable confirmation. Version 1 journals migrate transactionally. Restart recovery is limited to reading an attempt or listing unresolved submissions. It exposes no arbitrary SQL and stores no signer or other secret.

The production transport has no configurable base URL and pins `https://api.hyperliquid-testnet.xyz`. The signer is an injected server-side SDK signer capability. This workspace contains no secret loader, private-key parser, raw-key export, browser signer, mainnet endpoint, fallback URL, retry loop, or recovery submission path. A lost or ambiguous response is not resubmitted. It returns the durable action and request commitments plus both client order IDs for the keeper's Testnet authoritative evidence collector. A successful response is submission evidence only and always requires authoritative reconciliation before settlement classification.

The private loopback executor accepts only an `attemptId` and `idempotencyKey`. An injected trusted provider resolves the complete package attempt, and the boundary validates its Testnet domain, plan commitments, account, market indices, evidence windows, nonce, bounds, and expiry before invoking the existing runtime coordinator. The server is unavailable unless a runtime factory is explicitly injected. It never loads a signer or constructs a submission port, and ambiguous or deferred outcomes remain explicit.

The executor runtime loader is disabled unless `NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true`. Enabling it requires an exact `TESTNET` environment, lowercase agent and account addresses, an absolute external SQLite journal path, a loopback keeper origin, an externally supplied trusted attempt provider, and an injected official SDK-compatible server signer. The signer address is checked against the configured Testnet agent before the pinned exchange transport is constructed. Resolved attempts are then restricted to that agent and account identity. The reusable loader does not read a private key or start a server.

The solver process starts a separate loopback executor listener only when `NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED=true`. That opt-in process path requires `NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH` to identify an absolute, canonical regular file outside the repository, owned by the current user, with mode `0400` or `0600`. The file is strict JSON with only `version: 1`, `environment: "TESTNET"`, and a `privateKey` field. The key is converted to the official viem local account supported by the pinned SDK, tagged with the Testnet server signer scope, and checked against `NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS`. A raw private key is never accepted through an environment variable or command-line argument.

The attempt client contract is `GET /internal/solver/hyperliquid-testnet/attempts/{attemptId}` on `NARYX_API_INTERNAL_ORIGIN`. A successful response is protocol JSON with exactly `{ "version": 1, "attempt": ... }`; `404` means no durable attempt. The client accepts only loopback HTTP, enforces a timeout and 256 KiB response cap, and applies the executor's complete attempt validator before returning state. The API exposes this endpoint from the durable selected-attempt store and returns only canonical admission data and immutable execution limits. Keep `NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED=false` until the dedicated Testnet account, test assets, market qualification, and signer lease are reviewed. The ordinary quote server remains available while the executor is disabled.

Before the executor reserves a nonce, reaches a signer, or submits a package, a signerless market preflight reads `spotMeta`, `meta`, and both L2 books through the official SDK pinned to Hyperliquid Testnet. It verifies the configured spot universe, base token, quote token, perpetual asset, collateral token, asset indices, exact token IDs, expected canonical flags, and size precision. Canonical and builder markets follow the same exact configured identity check. Both books must be recent, two-sided, correctly identified, strictly price ordered, and within the configured snapshot skew. The planned IOC direction must have enough depth at its compiled limit price on both legs, using exact decimal arithmetic, and the two midpoint references must stay within the configured divergence limit. There is one read attempt and no fallback URL or retry loop. Any malformed, stale, mismatched, illiquid, or divergent observation fails before durable nonce reservation. Nonce allocation additionally requires two distinct valid SNTP samples and a Hyperliquid Testnet l2Book timestamp to agree within configured source, round-trip, and local-clock bounds. The complete accepted decision is immutable SQLite evidence. A restored nonce beyond the configured future lead refuses execution and requires a fresh agent instead of resetting or reusing the signer.

The same boundary performs a signerless authority inventory before market qualification. It reads Testnet agent approvals, user roles, subaccounts, spot balances, portfolio-margin mode, and perpetual positions. The configured agent must be the only active extra agent, must bind to the exact master account, and its finite `validUntil` must cover the package expiry, recovery deadline, and configured incident buffer. The configured trading account must have the exact master or subaccount relation, account mode, allowed spot-token scope, allowed perpetual-coin scope, and leverage mode. Unexpected approvals, ambiguous relations, expired authority, foreign balances, foreign positions, or stale reads fail closed.

Authority state is durable in the external SQLite journal as `INITIALIZING`, `ACTIVE`, `INCIDENT_LOCKED`, `FENCED`, or `MANUAL_TAKEOVER`. Only a fresh `INITIALIZING` runtime can become `ACTIVE` from an exact inventory. Any drift, ambiguity, expiry, or failed observation moves it to `INCIDENT_LOCKED`, which normal qualification can never reopen. `FENCED` and `MANUAL_TAKEOVER` are also terminal to observation.

Clearing `INCIDENT_LOCKED` is a separate explicit operation. It requires an injected signerless Testnet clearance reader, a fresh observation proving zero unexpected orders and positions, exact reconciliation and evidence commitments, and two distinct nonzero incident-reviewer role commitments. The complete clearance record is stored durably before execution becomes active again. Fencing, approval, revocation, rotation, and master-account recovery remain offline actions outside this service.

`inspectUntil` validates the same authority inventory without changing the durable fence. It
allows an operator to check a corrected account policy while the incident lock remains held.
Inspection alone never clears an incident. Clearance freshness is measured after the network
observation completes, and its reader must supply actual reconciliation evidence.

Execution additionally requires `NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_NAME`, `NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_NAME`, `NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_NAME`, `NARYX_HYPERLIQUID_TESTNET_PERPETUAL_NAME`, exact base and quote `*_TOKEN_ID` values, the three expected `*_CANONICAL` flags, both `*_SIZE_DECIMALS`, `NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_AGE_MS`, `NARYX_HYPERLIQUID_TESTNET_MAX_BOOK_SNAPSHOT_SKEW_MS`, `NARYX_HYPERLIQUID_TESTNET_MAX_REFERENCE_DIVERGENCE_BPS`, and both `NARYX_HYPERLIQUID_TESTNET_MINIMUM_*_DEPTH` values. These are reviewed Testnet market bindings and risk bounds, not discovery defaults. The executor remains unavailable when any value is absent or invalid.

Authority qualification additionally requires `NARYX_HYPERLIQUID_TESTNET_AUTHORITY_INCIDENT_BUFFER_MS`, `NARYX_HYPERLIQUID_TESTNET_EXPECTED_PORTFOLIO_MARGIN_ENABLED`, `NARYX_HYPERLIQUID_TESTNET_EXPECTED_LEVERAGE_MODE`, `NARYX_HYPERLIQUID_TESTNET_ALLOWED_SPOT_TOKEN_INDICES`, `NARYX_HYPERLIQUID_TESTNET_ALLOWED_PERPETUAL_COINS`, `NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_SNAPSHOT_AGE_MS`, and `NARYX_HYPERLIQUID_TESTNET_MAX_AUTHORITY_CLEARANCE_AGE_MS`. Lists are exact, unique, comma-separated Testnet account-scope bindings.

Neither loader nor process composition approves an agent, transfers funds, changes margin mode, provides a default wallet, or adds a mainnet path. Testnet agent authorization and funding remain external reviewed operations.

### Arbitrum Sepolia quote runtime and executor

Both are disabled by default and quote or execute only `eip155:421614` `ASYNC_BONDED_SOLVER` entry orders.

Quotes (`src/arbitrum-sepolia-quote-runtime.ts`) need `NARYX_ARBITRUM_SEPOLIA_QUOTE_ENABLED=true`, `NARYX_ARBITRUM_SEPOLIA_QUOTE_CONFIG` (absolute path to protocol JSON `{ "version": 1, "market": ... }`), and `NARYX_ARBITRUM_SEPOLIA_RPC_URL`. Every quote checks `eth_chainId == 421614` and the reviewed code hash of each read contract, reads `latestRoundData` from the configured reference feed (rejecting a nonpositive, incomplete, future-dated, or older-than-`maxPriceAgeSeconds` round against the latest block timestamp), and reads both GMX `POSITION_FEE_FACTOR` keys for the market from the GMX data store, using the larger. The spot leg is priced at what the pool charges for exactly the order quantity: the factory's spot port is checked against the code hash the factory pinned, the pinned Uniswap V3 QuoterV2 (`spotQuoter`) is checked for its runtime code hash and for a `factory()` equal to the port pool's, and its `quoteExactOutputSingle` over the port's pool fee and token order (no price limit) gives the spot cost, pool fee and price impact included. A quoter revert refuses the quote. The perpetual leg is priced at the reference: the position fee and margin round up, and perpetual proceeds round down. The signed `ENTRY_SPREAD` is therefore the spread the trader actually pays, and an entry above the order's `maxEntrySpread` is refused before signing. The quote asset must be the feed's USD unit at par (USDC against an ETH/USD feed). Venue fees are `{ base: 0, quote: position fee }`, solver, protocol, and priority fees are zero, and the quote is valid until the route expiry. `market` fields: `domain`, `templateId`, `templateVersion`, `packageTemplateManifestHash`, `templateRegistryRecordHash`, `candidateId`, `capacityBaseAtoms`, `solverId`, `solverCapabilityManifestHash`, `feePolicyVersion`, `feePolicyManifestHash`, `routeTtlSeconds`, `venueWindowSeconds`, `recoveryWindowSeconds`, `marginBps`, `perpSlippageBps`, `rollbackSlippageBps`, `baseAsset`, `quoteAsset`, `accountFactory` and `accountImplementation` (lowercase `GmxV2IsolatedAccountFactory` and its account implementation; any owner is quoted only when the order settlement account is that owner's `accountOf(owner)`, derived offline from the ERC-1167 clone CREATE2 formula), `priceFeed`, `gmxDataStore`, and `spotQuoter` (`{ address, expectedCodeHash }`), `priceFeedDecimals`, `maxPriceAgeSeconds`, `gmxMarket`, `spot` and `perpetual` (`adapter`, `venue`, `market`, `action`), `accountBindings`, `preconditions`, `postconditions`, `evidenceRequirements`, and `recovery` (`policyVersion`, `controllerId`, `controllerCodeHash`, `authorityModeId`, `reconciledStateSchemaHash`, `actionBuilderCodeHash`). The route's recovery plan is `CANCEL_OPEN_ORDERS` on the perpetual leg and `ROLLBACK_SPOT` at the rollback floor, with a zero trader recovery cost cap because recovery is paid from the solver bond.

The executor (`src/arbitrum-sepolia-executor.ts`) listens on loopback `NARYX_ARBITRUM_SEPOLIA_EXECUTOR_PORT` (default `8793`) only when `NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ENABLED=true`. `POST /internal/solver/arbitrum-sepolia/execute` with exactly `{ "attemptId": "arbitrum-async-..." }` advances one attempt and returns `{ version, attemptId, status, packageId, coordinatorState, requestKey, transactions }`, where `status` is `IN_FLIGHT`, `VENUE_PENDING`, `SETTLED`, `RECOVERY_REQUIRED`, or `FAILED`. It fetches the selected attempt from the API's loopback `GET /internal/solver/attempts/{attemptId}`, recomputes the order, route, and quote hashes, and requires this solver's own Ed25519 quote signature. Before planning, it verifies `eth_chainId == 421614`, the code hash of every configured contract, and that the isolated account's on-chain `owner()`, `fundingAuthority()`, `spotPort()`, and `spotBaseToken()` match the order owner, the solver account, and the configuration. It then derives the coordinator `Terms` and GMX `VenueRequest` once: route expiry, venue deadline, and recovery deadline come from the signed route (`routeExpiryValue`, `recoveryPlan.maxActionExpiryValue`, `recoveryPlan.deadlineValue`). `sizeDelta` is the signed perpetual notional in GMX 30-decimal USD. `acceptablePrice` is the signed perpetual floor, rounded up. Collateral is the signed margin, and the spot cap is the order's `maxSpotQuoteIn`. The execution fee is estimated from the GMX data store (`ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1`, `ESTIMATED_GAS_FEE_PER_ORACLE_PRICE`, `ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR`, `INCREASE_ORDER_GAS_LIMIT`, plus the callback gas limit) at the current gas price with a buffer, and refused above `maxExecutionFeeWei`. The executor checks the package ID, EIP-712 reserve digest, bond, reservation, and recovery-policy commitments against the coordinator's own views before the owner key signs the reserve digest. The plan is journaled before any write. Steps are approve adapter, `fundRequest`, approve coordinator, `reserve`, `submitRequest`, `markVenuePending`, then, after the GMX keeper settles, `relayEvidence` and `close`. Funding precedes the reservation so a failed reservation cannot slash the bond. A missed submission after `reserve` is slashable. Each transaction hash is journaled before its receipt is awaited and is never resent. An unmined hash returns `IN_FLIGHT`, and a reverted one marks the attempt `FAILED`. Cancelled, frozen, and overdue packages return `RECOVERY_REQUIRED` for the coordinator recovery path.

Executor variables: `NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CONFIG` (absolute protocol JSON, `version: 1` plus `domain`, `coordinator`, `adapter`, `accountFactory`, `accountImplementation`, `collateralToken`, `spotPort`, `spotBaseToken`, `gmxDataStore` as `{ address, expectedCodeHash }` with lowercase addresses, `gmxMarket`, `quoteAssetDecimals`, `executionClassManifestHash`, `seriesIdentityKey`, `seriesBindingVersion`, `seriesBindingHash` (equal to the API runtime manifest), `bondAtoms`, `recoveryReserveAtoms`, `maxAggregateLossAtoms`, `maxIntermediateResidualAtoms`, `maxTerminalResidualAtoms`, `slashRecipient`, `callbackGasLimit`, `executionFeeBufferBps`, `maxExecutionFeeWei`, `maxCollateralAtoms`, `maxSpotQuoteAtoms`, and `receiptWaitMs`), `NARYX_ARBITRUM_SEPOLIA_EXECUTOR_DB` (absolute SQLite journal outside the repository), `NARYX_ARBITRUM_SEPOLIA_RPC_URL`, and `NARYX_ARBITRUM_SEPOLIA_SOLVER_KEY_PATH` with `NARYX_ARBITRUM_SEPOLIA_SOLVER_ADDRESS` (the solver that bonds and submits). The key file is an absolute, canonical, current-user-owned `0400` or `0600` regular file outside the repository with exactly `{ "version": 1, "environment": "ARBITRUM_SEPOLIA", "privateKey": "0x..." }`, never accepted through environment variables or logged. The executor holds no owner key: `POST /internal/solver/arbitrum-sepolia/prepare` (`{ attemptId }`) journals the unsigned plan and returns the reservation typed data and the owner's funding transactions, `POST /internal/solver/arbitrum-sepolia/authorize` (`{ attemptId, ownerSignature }`) journals the owner's wallet signature after recovering it to the order owner, and `execute` reports `AWAITING_OWNER_SIGNATURE` or `AWAITING_OWNER_FUNDING` and sends nothing until the owner has signed and called `fundRequest` from its own wallet. The owner must be a different wallet from the solver. Collateral, spot, bond, and execution-fee amounts are bounded in integer atoms by the configuration.

Exit (`src/arbitrum-sepolia-exit.ts`) uses the same quote configuration. An `EXIT` order on `eip155:421614` is quoted only after the chain shows the owner account's active package with an executed full short of exactly the order quantity and matching spot inventory, and no exit already in progress. The spot leg is priced at the smaller of the Uniswap pool and reference price less the pool fee, rounded down, and the quoter's `quoteExactInputSingle` proceeds for exactly that sale, which is refused when the quoter reverts or the sale would end at the price limit; the perpetual output is collateral plus entry notional less close notional (rounded up) and the larger position fee (rounded up). The route is a spot `SELL` at that floor and a reduce-only perpetual `BUY` limited at the reference widened by `perpSlippageBps`, with a single `CANCEL_OPEN_ORDERS` recovery slot. The executor needs `exitController` (lowercase, equal to the factory's `exitController()`) and `exitCallbackGasLimit` in its configuration; without them exit routes answer `503 EXIT_UNAVAILABLE`. `POST /internal/solver/arbitrum-sepolia/prepare-exit` (`{ attemptId }`) journals the unsigned `ExitAuthorization` (receiver and spot proceeds go to the owner, `fullCloseSizeUsd` is the live short size, `minOutputAmount` is the signed perpetual minimum in GMX 30-decimal USD, `acceptablePrice` is the signed perpetual ceiling, the decrease execution fee uses `DECREASE_ORDER_GAS_LIMIT`, and the solver is the fee payer and cancellation receiver) after checking `exitDigest` against the controller, and `POST /internal/solver/arbitrum-sepolia/authorize-exit` (`{ attemptId, ownerSignature }`) journals the owner's EIP-712 signature after recovering it to the owner. `execute` then sends `submitFullClose` once from the solver key with the execution fee, takes the request key from `ExitSubmitted`, and afterwards sends at most one each of `finalizeExecutedExit`, `requestCancellationOrReconciliation` (only after `cancelAfter`), and `processReconciliation`. It reports `SETTLED` with the journaled `finalPackageReceipt`, `CANCELLED` when GMX cancelled the close and the package stays open, `VENUE_PENDING` while the keeper is pending, and `RECOVERY_REQUIRED` for frozen, conflicting, or reverted follow-up states. An expired authorization or changed chain state before submission marks the attempt `FAILED` with no write.

Arbitrum activation requires the registered isolated account factory, spot port, live price bounds
and the owner's reservation signature and funding. The executor holds no owner key. The deployed
testnet route has entry and recovery evidence; later entries can still be refused for adverse GMX
price impact, insufficient margin or stale prices. Consult the current release and GO-LIVE records
for that deployment, rather than treating SDK support as an execution guarantee.

## Hyperliquid SDK dependency

`dist/testnet-netting-unwind.js --journal /absolute/external/unwind.json --plans
<first-plan-hash>,<second-plan-hash>` preflights the controlled cross-batch residual cohort.
It verifies both persisted clearing receipts, pins the testnet BTC catalogs and collateral identity,
and requires exactly the cohort's 0.0002 BTC long and short with no unrelated venue positions.
Only `--broadcast` submits the bounded, reduce-only IOC closes through the testnet agent.
Each signed request and response is saved before advancing; an existing journal never resubmits.
The resulting journal proves operator unwind, not final allocation to individual strategy owners.
If the first close filled but the secondary venue has no oracle-valid taker liquidity, `--passive`
uses a separate journal and can place one reduce-only recovery bid near the current oracle.
`WAITING_LIQUIDITY` is not a completed unwind. Repeated inspection never resubmits it.
When bounded taker liquidity returns, `--complete --broadcast` closes only the verified remaining
secondary position and cancels the recorded recovery order if still open. Its separate completion
journal must confirm both venues flat and no live recovery order before reporting `VERIFIED_FLAT`.

New perpetual residual submissions also qualify actual entry and opposing exit depth before
reserving a submission nonce. A missing oracle or insufficient exit depth blocks entry, not
reconciliation of an existing attempt. HIP-3 contexts are read from their named DEX.

`@nktkas/hyperliquid` is pinned at `0.33.3` for its maintained TypeScript order codec, L1 signing, and request transport. The release is MIT licensed, requires Node `>=22.12.0`, and has npm integrity `sha512-fvnEw/2ejN14ZZVXA+nFQ9YgfFNjCI1yLliYyUboC6hr3Gwd/RwC4Ox90K4e8tkKWqkVpOcLRQ30p0nTeK4NBQ==`. `npm audit --omit=dev` reports zero vulnerabilities. The service imports the SDK order function, signing abstraction, and exchange request transport; it does not implement signing or wire codecs.

## Cross-domain wallet approvals

The separate `dist/cross-domain-main.js` worker accepts operator-staged unsigned preparations
only when `NARYX_CROSS_DOMAIN_WALLET_ENABLED=true`, in addition to the existing runtime activation.
`POST /wallet/drafts` is loopback-only and takes the exact `CrossDomainWalletDraft` transport.
It verifies the pinned Base and Arbitrum Sepolia accounts, owners, domain manifests, nonce,
entry caps and exact recovery before persisting the draft. It does not build a canonical public
order or fund inventory. Existing owner/account allowlists and gas caps remain unchanged.

`GET /wallet/drafts/{draftId}` returns unsigned permissions and status, never stored signatures.
`POST /wallet/authorize` takes `{ draftId, signatures: [{ domainId, entry, recovery }] }`.
Both chain-specific entry and recovery signatures must belong to the owner before the solver
signs. The worker waits for the exact pre-funded reservations before durable admission.
Approved drafts survive restart in `<jobDatabasePath>.wallet.sqlite`; expired preparations
release only unused reservations and remain pending until release is confirmed.

Only read and authorize routes are proxied to the terminal. Raw job admission and draft staging
remain private. These are coordinated, recoverable operations, not atomic cross-chain trades.

## SQLite dependency

`better-sqlite3` is pinned at `13.0.3` for its synchronous transaction and SQLite durability controls on Node 22. It is MIT licensed, maintained through the pinned August 2026 release, and has npm integrity `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`. `@types/better-sqlite3` is pinned at `9.6.0` for build-time types only. `npm audit --omit=dev` reports zero vulnerabilities.
## Dedicated native cash testnet service

`node dist/native-cash-testnet-main.js` starts a separate loopback-only service for reviewed `EVM_NATIVE_CASH_RANGE_V1` markets. It is disabled unless `NARYX_NATIVE_CASH_TESTNET_ENABLED=true`. Its immutable deployment bindings are deliberately separate from routed strategy profiles and controlled clearing-test fixtures. The config is protocol JSON `{ version: 1, markets: [{ binding, rpcEnvironmentVariable, makerKeyPath }] }`. Each binding pins the range controller, clearing house, collateral, code hashes, policy, domain manifest, and maker account. The RPC variable must name a supported Sepolia endpoint; actual chain identity is checked before the dedicated testnet maker key is loaded.

The maker key uses the existing owner-only testnet key-file loader. It only signs the exact clearing-house EIP-712 match, not transactions or arbitrary payloads. Each quote checks real funded accounts and grants a durable, short exclusive issuance lease across processes. Same-request retries return the stored response, including its original expiry. Interrupted signing requires a fresh request ID and does not release its conservative lease early.

The loopback HTTP routes are `GET /v1/native-cash/markets`, `POST /v1/native-cash/quotes`, `GET /v1/native-cash/quotes/{requestId}`, and `GET` or `POST /v1/native-cash/quotes/{requestId}/settlement`. Quote bodies contain `requestId`, `marketId`, `owner`, `accountId`, `side`, and bigint `quantityAtoms` using protocol JSON. Settlement POST bodies contain only `transactionHash`. The user must separately open and fund their own native clearing account, sign the returned typed data, and submit `executeMatch` with both signatures through their wallet. The service has no user signing key or broadcast path. Only successful canonical finalized matches become immutable database receipts. This is cash settlement, not execution of external market legs, and does not write into the separate routed-package ledger.

`GET /v1/native-cash/markets/{marketId}/trades` returns up to 100 independently finalized native cash receipts, newest recorded first. Signed quotes, submitted transactions, and still-unfinalized fills never populate this feed. It reports owner-signed testnet activity without inventing depth, organic volume, or external positions.

An included settlement submission is admitted to a durable finality queue only after verifying its exact transaction calldata, deployment code, account owners, authorization consumption, match event, and canonical block. Until finality, the endpoint returns HTTP 409 with `code: AWAITING_FINALITY` and `backgroundReconciliation: true`. The signerless worker checks up to eight pending records per pass, preserves ambiguous observations across restarts, and atomically removes a queued observation when its immutable finalized receipt is stored. Admission is capped at 256 distinct observations; retries use the same slot. A hash that has not yet been independently verified as included is not queued and must be resubmitted by the client. No pending transaction is rebroadcast by this worker.

`POST /v1/native-cash/markets/{marketId}/account` accepts exactly `{ owner, accountId }` and reads that account, collateral balance, and allowance at one block. Chain, code, policy, token, decimals, and account owner must match the registered market. An unopened account is returned explicitly, not treated as funded. This endpoint is read-only and intentionally does not require a fresh oracle for account discovery. Quotes and withdrawals still enforce their own live-mark rules.

The explicit maker-authorization class `ERC1271_NATIVE_CASH_STANDING_V1` binds a reviewed `NativeCashStandingMaker` code hash and account. Such a runtime entry omits `makerKeyPath`: authorization is the exact ABI-encoded match, validated against the maker contract's ERC-1271 policy before issuance and again by the clearing house during execution. Unknown maker classes, code changes, controller/account mismatches and failed signature checks are refused. Existing EOA-signed maker bindings keep their original meaning.

`GET /v1/native-cash/markets/{marketId}/book` reads the registered supplier's live bid, ask, funded quantity and validity. Inactive markets refuse the book; non-entry registration states suppress entry depth. This is cash-range standing liquidity, not fabricated depth in a routed strategy book. Issuance leases can advance before expiry only after fresh chain-qualified state proves that the previous maker sequence was consumed. Unchanged sequences and interrupted issuance stay locked.

Deploying this service does not deploy or fund a market, publish its oracle mark, unpause entries, or create standing package-book depth. Those are separate activation steps.

### Routed strategy package books

`NARYX_EVM_PACKAGE_MAKER_CONFIG` optionally enables continuous implied liquidity for registered Base Sepolia and Arbitrum Sepolia calendar lanes. It is separate from native cash-range markets. The version-1 testnet config contains an absolute `journalPath`, `intervalMs` between 10000 and 30000, and `markets`. Each market specifies `laneId`, the registered Ed25519 `keyId`, a dedicated `fundingAccount`, one to sixteen integer `quantities`, `backingAtomsPerWholeAsset`, and `maximumCapacityAtoms`. The API support manifest must use matching backing atoms with `quantityScale: 1000000000000000000` for these 18-decimal base assets. Configuration uses protocol JSON integers, not floating-point amounts.

The worker reads actual venue previews, token identities, maturity, pause state, position limits, payout reserves, and the maker's collateral balance. Bid and ask prices are quote-token atoms per whole base asset, near future minus far future. Each tier uses a conservative venue preview at the total published quantity plus that tier's size, so consuming several tiers does not underprice the combined trade's market impact. Fees remain separate signed execution limits. Quotes are `SOLVER_BACKED_IMPLIED` with `ONCHAIN_AVAILABLE` capacity, not onchain escrow guarantees. The API reserves each quote's capacity separately and checks matched calendar prices against the eventual owner-authorized execution quote. Venue settlement remains in the user's strategy account.

The same EVM config also accepts registered option, treasury hedge, collateral-conversion and reverse-basis lanes. Each uses its existing venue reader and exact leg ratios. Inventory is marked once; collateral deposits and borrows have no independent execution price. Option pools must hold payout inventory. Reverse-basis lenders must hold borrowable inventory, and derivative reserves must cover shared ladder exposure. Matched prices are checked again against the signed execution quote. All lanes sharing a solver, domain and asset must use the same funding account and capacity cap, and refresh serially within that scope.

Every EVM and Solana ladder supports sixteen independently backed levels per side, published in one batch of up to 32 quotes. A level adds one through sixteen basis points of conservative dealer spread to its venue-derived leg prices, rounding asks up and bids down. Zero-value transfer legs stay zero. This distinguishes real dealer offers even when a test venue rounds several sizes to the same execution price. It does not fabricate trades, add external liquidity, or reuse one commitment across multiple rows. Changing configured quantities requires retiring previous unconsumed commitments and migrating the journal binding while preserving source versions and any unresolved obligations.

`NARYX_SOLANA_PACKAGE_MAKER_CONFIG` enables the registered Devnet treasury-hedge book. Its version-1 testnet config has the same funding fields, a single `laneId` and `keyId`, an absolute `journalPath`, and `intervalMs`. Its quantity scale is the inventory mint's decimal scale. Slot-based expiry and authentication require the API's fresh observed Solana clock; capacity timestamps use milliseconds. A dedicated funding account's associated test-USDC account backs these commitments without sharing the standing cash-and-carry maker's inventory. The publisher only reads that account and does not require its private key.

Source versions and commitments survive restarts. Refresh reserves fresh backing while the previous quotes remain live, then replaces source versions and quotes together in one exchange-database transaction. A rejected replacement leaves the prior book unchanged. Unused previous backing is released only after replacement; consumed backing remains reserved until a finalized, onchain-enforced strategy receipt proves completion with no residual. Unknown outcomes stay reserved. Venue sources are shared across tiers, but backing commitments are not. Venue previews run two size tiers at a time to bound RPC load. Source failures remove quotes rather than inventing prices. Quote refreshes do not send chain transactions, mint tokens, fund insurance, or trade against the publisher's own orders. Funding and activation require separate operator actions. Capacity and activity, not a fixed number of days, determine inventory runway.

Completed quote bookkeeping retains the latest 256 released holds per market and compacts older released records into exact per-scope counts and atom totals, at most 1024 rows per refresh. Pending, held and allocated commitments are never compacted. Trade receipts and the API's authoritative accounting are separate and unchanged. SQLite reuses the freed pages rather than requiring a blocking vacuum.

### Hyperliquid standing package quotes

`NARYX_HYPERLIQUID_PACKAGE_MAKER_CONFIG` optionally enables a testnet-only publisher inside the solver. Its protocol-JSON configuration contains `version: 1`, `environment: "testnet"`, `journalPath`, `collateralTokenId`, `intervalMs`, and `markets`. Each market supplies `quoteConfigPath`, `keyId`, `fundingAccount`, `maximumCapacityAtoms`, `quantity`, `levels`, and `backingAtomsPerWholeAsset`. Quote configurations must match active generalized execution lanes. All markets share one dedicated funding account and capacity ledger, including overlapping refresh generations. The publisher needs the existing solver signing key, not the funding account's trading key.

The publisher verifies fresh, flat, withdrawable collateral across Hyperliquid DEXes, converts venue balance decimals into the registered quote asset's decimals, and reads actual testnet order books. It reserves full spot purchase cost plus the configured perpetual margin, not full derivative notional. This is bounded execution capital, not an insurance guarantee or shared user collateral. Each quote has a separate reservation. Existing user account margin requirements and lifecycle eligibility checks still apply. Orders smaller than the venue's opening-notional minimum are refused before execution; multiple book levels can contribute to one valid aggregate order.

Up to sixteen levels per side are supported when both venue depth and capital permit. Cash-and-carry publishes entry offers only because its generalized compiler does not support reverse entry. Migration prices use source purchase minus destination sale, with the reverse signs for the opposite trading direction. Rebalance and migration execution requires the user's eligible existing position. Quotes expire or are withdrawn when balance, clock, depth, or price checks fail. No venue trades, collateral transfers, account approvals, or mainnet writes are performed by quote refreshes.

New market manifests also begin inactive in the service's durable registration database. Direct loopback `POST /internal/native-cash/registrations/{marketId}/challenge` with `{ state }` returns governor-signable EIP-712 data. The corresponding `/authorize` accepts `{ challengeId, signature }`. The authority is read from the pinned clearing house, not chosen by a request. Entry activation always waits at least 60 seconds after verified consent, including when the challenge was prepared earlier. Manifest replacements cannot reuse an existing market ID. States are `ACTIVE`, `ENTRY_PAUSED`, `EXIT_ONLY`, `ALL_PAUSED`, and terminal `DEPRECATED`; re-enabling operations from `ALL_PAUSED` is also delayed. Reducing quotes remain available in the entry-paused, exit-only and deprecated states when the underlying accounts and oracle are safe. Registration is enforced by quote admission, not by a claim that the clearing house checks this service database. It does not revoke already signed finite-lived quotes; the onchain pause is the hard entry stop.

`node dist/native-cash-mark-main.js` is the separately enabled oracle updater. `NARYX_NATIVE_CASH_MARK_ENABLED=true`, `NARYX_NATIVE_CASH_MARK_CONFIG`, and `NARYX_NATIVE_CASH_MARK_DB` are required. The config contains `{ version: 1, markets: [{ binding, rpcEnvironmentVariable, markKeyPath, reservedWei }] }`, one market per supported Sepolia chain. `reservedWei` imports the deployment and earlier test operations' already committed gas budget. This journal never resets or refunds reservations. Its default lifetime cap, including that baseline, is 0.009 test ETH per network. An explicit owner-approved operating budget may override each chain separately through `NARYX_BASE_SEPOLIA_NATIVE_CASH_MARK_GAS_CAP_WEI` and `NARYX_ARBITRUM_SEPOLIA_NATIVE_CASH_MARK_GAS_CAP_WEI`. Values are positive integer wei, at most 0.1 test ETH per chain; omission preserves the old limit. Existing reservations are never reset, and a configured cap below recorded commitments prevents startup. The owner must budget these allowances together with execution workers and setup operations; funding a wallet does not raise a spending limit. A signed raw transaction and its worst-case gas cost are committed before broadcast. Restart retries only that identical transaction while its outcome is unresolved. The controller derives prices onchain; the updater cannot choose arbitrary marks. Stale sources fail closed and do not have their timestamps extended. This updater does not fund accounts or unpause markets.

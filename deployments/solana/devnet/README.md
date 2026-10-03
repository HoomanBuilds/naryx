# Solana Devnet deployment lane

This directory records reviewed public Solana Devnet deployments. A README without a release manifest is not a deployment claim.

## Scope

The normal cash-and-carry route requires these Naryx programs to be built from one synchronized identity set:

1. `naryx_orca_adapter`
2. `naryx_rise_adapter`
3. `naryx_inventory_reservation`
4. `naryx_package_book`
5. `naryx_core`

The normal `naryx_core` binary is compiled without the `conformance` feature.

Phoenix Rise has no Devnet deployment, so the Devnet perp leg uses the Naryx Devnet test perp lane described in [Naryx Devnet test perp lane](#naryx-devnet-test-perp-lane). That lane adds `naryx_test_perp` and `naryx_test_perp_adapter`, replaces `naryx_rise_adapter` in the Devnet release, and compiles `naryx_core` with `--features devnet-test-perp`.

`naryx_conformance_venue` is local deterministic test infrastructure. It is not a Phoenix Rise substitute and the normal core does not call it. The feature-gated conformance core binary must never replace the normal Devnet core at the same program identity. A future Phoenix-compatible public Devnet conformance dependency needs its own reviewed program, identity, deployment record, and `CONFORMANCE_DEPENDENCY` label.

## Safety gates

- Use only `https://api.devnet.solana.com`.
- Verify the cluster genesis hash is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` before every write.
- Use a fresh Devnet-only payer and fresh program keypairs held outside the repository.
- Fund the payer only with free Devnet SOL.
- Never read, copy, or reuse the configured default wallet.
- Never deploy when the observed genesis hash differs.
- Never run this procedure against mainnet, testnet, or a URL chosen only by a label.

## Build and identity synchronization

From `contracts/solana`:

```bash
anchor build --ignore-keys
solana genesis-hash --url https://api.devnet.solana.com
```

Generate or retrieve the five Devnet program keypairs from an external secret directory, then copy them into the ignored `target/deploy` paths with mode `600`. Do not place any keypair under `deployments` or stage it in Git.

Sync one reviewed normal program at a time:

```bash
anchor keys sync -p naryx_orca_adapter
anchor keys sync -p naryx_rise_adapter
anchor keys sync -p naryx_inventory_reservation
anchor keys sync -p naryx_package_book
anchor keys sync -p naryx_core
node scripts/sync-core-program-ids.mjs
```

`anchor keys sync` rewrites each program's `declare_id!` and its entry in the `Anchor.toml` section that matches the provider cluster, which is `[programs.localnet]` here. It does not rewrite `PACKAGE_BOOK_PROGRAM_ID` and `INVENTORY_RESERVATION_PROGRAM_ID` in `programs/naryx_core/src/constants.rs`, which `naryx_core` uses as CPI targets and PDA owners and cannot import because both programs depend on `naryx_core`. `scripts/sync-core-program-ids.mjs` rewrites those two constants from the synced `declare_id!` values, and `--check` exits nonzero without writing when they differ. The `naryx_core` unit test `constants::tests::cross_program_ids_match_declared_ids` also fails while they differ.

Do not pass a URL as `--provider.cluster`: Anchor CLI 1.2.0 treats it as a custom cluster that matches no `Anchor.toml` section, so no entry is updated. `anchor keys sync` never creates a section, and `--provider.cluster devnet` also rewrites `[provider] cluster`. Add the Devnet section to `Anchor.toml` by hand with the same five synced IDs that `[programs.localnet]` now lists. `naryx_conformance_venue` is not part of it.

```toml
[programs.devnet]
naryx_core = "<synced naryx_core ID>"
naryx_inventory_reservation = "<synced naryx_inventory_reservation ID>"
naryx_orca_adapter = "<synced naryx_orca_adapter ID>"
naryx_package_book = "<synced naryx_package_book ID>"
naryx_rise_adapter = "<synced naryx_rise_adapter ID>"
```

Then confirm the core constants and rebuild against the injected keypairs:

```bash
node scripts/sync-core-program-ids.mjs --check
anchor build
```

Review the resulting source and `Anchor.toml` diff before deployment. Only public program identity changes are expected.

## Funding check

Calculate rent from the final artifacts rather than using a fixed budget:

```bash
solana rent "$(( $(stat -c %s target/deploy/naryx_core.so) + 45 ))" --url https://api.devnet.solana.com
```

Repeat for every program in the release. The payer balance must cover the complete rent estimate, deployment fees, and a small retry margin before the first deploy begins. Do not partially deploy a coordinated identity set without recording the incomplete state.

## Deployment

Deploy each reviewed artifact with the official Solana CLI, an explicit Devnet URL, the external Devnet payer, the matching ignored program keypair, and the same Devnet-only upgrade authority. Capture the JSON output without capturing key material.

```bash
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair /external/devnet-payer.json \
  --fee-payer /external/devnet-payer.json \
  --upgrade-authority /external/devnet-payer.json \
  --program-id target/deploy/naryx_core-keypair.json \
  --use-rpc \
  --output json-compact \
  target/deploy/naryx_core.so
```

Run the same command for each program in the synchronized release. The example path is intentionally external and must be replaced with an actual Devnet-only secret path at execution time.

## Evidence and release manifest

After each successful deployment, verify the program through a read-only query:

```bash
solana program show PROGRAM_ID --url https://api.devnet.solana.com --output json
```

Before a candidate release manifest is reviewed or committed, run the signerless preflight from `contracts/solana`:

```bash
node scripts/verify-devnet-release.mjs --manifest /absolute/path/to/candidate-release.json
```

The input path is mandatory and must be absolute. The script has a fixed `https://api.devnet.solana.com` read endpoint and does not load Solana CLI configuration, a default wallet, a keypair, or a signer. It calls only `getGenesisHash` and `getMultipleAccountsInfo`. The candidate uses schema version `1`, cluster `solana-devnet`, the exact Devnet genesis hash, and a nonempty `programs` array. Each program record supplies `name`, `programId`, `programDataAddress`, `deploymentSlot`, and `upgradeAuthority`, which is `null` for an immutable program. Optional `artifactPath`, `artifactSha256`, `programElfSha256`, and `programDataHeaderIdentity` fields add byte comparisons. An artifact path is resolved relative to the candidate manifest unless it is absolute. Every output record carries `programDataLength`, `programDataHeaderIdentity`, and `programElfSha256`.

The preflight rejects mainnet and every non-Devnet genesis, missing accounts, nonexecutable programs, wrong upgradeable-loader ownership, invalid Program and ProgramData layouts, mismatched ProgramData linkage, deployment slot, or upgrade authority, and any supplied artifact, ELF, or header identity mismatch. Successful JSON output is derived read-only evidence for review. It is not a deployment record, activation record, support claim, write authorization, or proof that initialization occurred. The script never creates or updates a manifest.

### Runtime files

After deployment and initialization, fill `release.template.json` in this directory outside the repository and run `deployments/tools/release-manifests.mjs`. It reads each program's ProgramData identity live after proving the Devnet genesis hash, requires every live ELF to equal the reviewed artifact hash, runs `verifySolanaDevnetDeploymentIdentity`, and writes the runtime manifest, order context, solver config, keeper targets, and web env. See `deployments/tools/README.md`.

## Program code identity

Two hashes identify every program, and a release or registration record carries both.

- `programDataHeaderIdentity` is what the chain checks. It is `sha256("naryx.program-data-header.v1" || ProgramData[0..45] || u64_le(ProgramData length))`. The 45 header bytes are the `u32` state tag `3`, the `u64` slot of the last deploy or upgrade, and the `Option<Pubkey>` upgrade authority. `naryx_core`, `naryx_package_book`, and `naryx_inventory_reservation` compute it at registration and class initialization and recompare it at every execution, so the check costs a constant few hundred compute units instead of about half a compute unit per ProgramData byte. In the LiteSVM test `venue_code_identity_is_constant_cost_and_binds_program_data_header`, registering a venue with a 2,101,248-byte ProgramData consumed 1,080,469 CU when the whole account was hashed and 29,918 CU with the header identity. A whole-account hash cannot fit twice under the 1,400,000 CU transaction limit.
- `programElfSha256` is what reviewers verify off-chain. It is the SHA-256 of `ProgramData[45..]` with trailing zero padding removed, the same convention as `solana-verify get-program-hash`, and equals the SHA-256 of the reviewed `.so` artifact with trailing zero bytes removed. `artifactSha256` uses the same convention.

The header identity is equivalent to a full-code hash for detecting code change. Only the upgradeable loader can write ProgramData. Deploy and upgrade write the current slot and the loader rejects a second deploy in the same slot, so every code change writes a strictly newer slot. A closed program ID cannot be redeployed, and a closed or uninitialized ProgramData fails closed. Set-authority rewrites the authority bytes and extension changes the length, so both also invalidate the identity and require re-registration. Programs outside the upgradeable loader fail closed. The header cannot prove which bytes were deployed, so registration review must first confirm, through `scripts/verify-devnet-release.mjs` or `verifySolanaDevnetDeploymentIdentity`, that the live `programElfSha256` equals the reviewed artifact and that the live `programDataHeaderIdentity` equals the identity being registered. The Devnet runtime manifest requires both hashes for every program and re-verifies them against live RPC data before any write path, and each live binding's `codeIdentity` must equal the verified header identity.

Dump the deployed bytes to an external temporary directory and compare their trimmed SHA-256 hash with the final artifact. A committed release manifest must record:

- cluster name and observed genesis hash;
- release commit;
- program name, public ID, ProgramData address, deployment slot, and deployment signature;
- artifact SHA-256, live `programElfSha256`, ProgramData length, and `programDataHeaderIdentity`;
- upgrade authority public key and whether it remains active;
- exact compiler and CLI versions;
- every mock or conformance dependency with an explicit evidence label;
- known limitations, including the absence of a verified Phoenix Rise Devnet deployment;
- a statement that no initialization, market creation, asset funding, or package execution is implied by program deployment.

Commit only the public identity changes and the completed non-secret release manifest. Program keypairs, payer keys, raw CLI logs, temporary dumps, and local deployment records remain untracked.

## Naryx Devnet test perp lane

Phoenix Rise is not deployed on Devnet and Drift Devnet is abandoned. `naryx_test_perp` is a Naryx-operated, oracle-priced perpetual venue for Solana Devnet. It is test infrastructure with an explicit `CONFORMANCE_DEPENDENCY` label, not a public market, and no result from it is a claim about Rise liquidity or mainnet readiness.

### What it models

- One market per owner and Pyth feed id. The market pins a Pyth Solana Receiver `PriceUpdateV2` account (owner `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`), its feed id, a maximum price age, and a maximum confidence width in bps. Every price read requires the exact account, the receiver owner, the `PriceUpdateV2` discriminator, `Full` verification, the feed id, a positive price, `publish_time + max_age >= now`, and `conf <= max_confidence_bps * price`.
- Market orders are immediate-or-cancel for the full size. A sell fills at `floor(oracle * (10000 - s) / 10000)` and a buy at `ceil(oracle * (10000 + s) / 10000)` per base lot, where `s = half_spread_bps + impact_bps_per_unit * ceil(base_lots / impact_unit_lots)` and `s <= max_slippage_bps`. An order whose fill is worse than its limit, expressed as `limit_price_in_ticks * quote_tick_atoms_per_base_lot`, fails.
- The taker fee is `ceil(notional * taker_fee_bps / 10000)` collateral atoms, moved to the fee vault PDA. Any order that opens or increases exposure needs post-trade equity at or above initial margin at the oracle price; reductions are always allowed. `pause_opens` blocks only exposure increases.
- PnL is realized on every reduction with the closed cost basis rounded against the trader. The insurance vault PDA is the venue counterparty: it pays trader gains and funding credits and receives trader losses and funding debits. A trade that needs more than the insurance vault holds fails closed. A loss beyond collateral floors collateral at zero and is recorded as `bad_debt_atoms`.
- Funding accrues into a cumulative index as `rate_per_second * elapsed_seconds * oracle_price_per_lot`, with the rate scaled by `1e12`. A positive rate makes longs pay shorts. Funding settles on every order, withdrawal, and liquidation, rounded toward the trader paying more.
- Anyone can liquidate a position whose equity, including unsettled funding, is below maintenance margin. The whole position closes at the oracle price and the liquidation penalty goes to the fee vault.
- A position has one owner and an optional delegate. The delegate can place orders but never withdraw, which mirrors the Rise position authority. Withdrawals are owner-only and limited to collateral above initial margin.

`naryx_test_perp_adapter` mirrors `naryx_rise_adapter`: a strategy PDA per owner and strategy id, a controller, a maximum size, `test_perp_enter_short` from flat and `test_perp_close_short` reduce-only from the exact short, and the same pre and post position and collateral postconditions. One collateral quote lot is one collateral atom.

### Building core for Devnet

```bash
cd contracts/solana
anchor build --ignore-keys
anchor build -p naryx_core --ignore-keys --no-idl -- --features devnet-test-perp
node scripts/build-devnet-test-perp-artifacts.mjs
```

The first command produces every program, with the default Rise core. The second replaces `target/deploy/naryx_core.so` with the Devnet core; rebuild the default core before any non-Devnet use, because both builds write the same path. A `devnet-test-perp` core must never be registered or deployed under a mainnet identity. Its perp leg keeps the `rise_strategy` account slot for the test perp strategy PDA and replaces the eight Rise venue accounts with `test_perp_market`, `test_perp_position`, `test_perp_oracle`, `test_perp_collateral_vault`, `test_perp_fee_vault`, and `test_perp_insurance_vault`, and it takes no remaining accounts. The firm entry resolves 55 fixed addresses, inside the 64-address limit. The script publishes the ABI-only core, venue, and adapter IDLs to `deployments/solana/devnet/test-perp/idl`. The TypeScript planner selects this shape with `perpVenueKind: 'NARYX_TEST_PERP'`; there is no fallback between kinds.

The Devnet release then contains `naryx_orca_adapter`, `naryx_test_perp`, `naryx_test_perp_adapter`, `naryx_inventory_reservation`, `naryx_package_book`, and the `devnet-test-perp` `naryx_core`. Sync `naryx_test_perp` and `naryx_test_perp_adapter` with `anchor keys sync -p` like the other programs; the adapter imports the venue ID from the venue crate, so no extra constant sync is needed.

### Initialization, after a reviewed deployment only

Every step below is a Devnet write. None of it is authorized by this README; each needs the same genesis-hash check and an external Devnet-only signer.

1. `initialize_market` by the market owner with the Devnet test USDC mint (operator runbook step 2) as `collateral_mint`, the Devnet SOL/USD sponsored price account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` as `oracle`, and feed id `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`. Recommended parameters, close to a real venue:

   | Parameter | Value |
   |---|---|
   | `base_decimals` | `9` |
   | `base_lot_atoms` | `1000000` (0.001 SOL) |
   | `quote_tick_atoms_per_base_lot` | `1` |
   | `taker_fee_bps` | `5` |
   | `half_spread_bps` | `2` |
   | `impact_bps_per_unit` / `impact_unit_lots` | `1` / `10000` (1 bps per 10 SOL) |
   | `max_slippage_bps` | `100` |
   | `initial_margin_bps` / `maintenance_margin_bps` | `1000` / `500` |
   | `liquidation_penalty_bps` | `100` |
   | `max_price_age_seconds` | `60` |
   | `max_confidence_bps` | `50` |
   | `max_position_lots` | `1000000` |
   | `max_funding_rate_per_second` | `10000` (1e-8 per second) |
   | `funding_keeper` | a separate Devnet-only keeper key |

2. Fund the insurance vault PDA with Devnet test USDC by a plain token transfer. It is the counterparty for trader gains and funding credits.
3. Per trader, signed by the trader's own wallet: `initialize_position`, `deposit`, `set_delegate` to the trader's strategy PDA (`["test-perp-strategy", owner, strategy_id]` under the adapter), then `naryx_test_perp_adapter.initialize_test_perp_strategy` with the core executor authority PDA (`["cash-carry-executor", owner, strategy]` under core) as `controller`, then `naryx_core.initialize_cash_carry_strategy`, and the trader and executor associated token accounts for both mints. The delegate must be set first: the adapter rejects a strategy whose position is not already delegated to it. The API serves these exact unsigned instructions, only for the steps still missing, at `GET /internal/terminal/solana-devnet/account?owner=<wallet>&sizeAtoms=<atoms>`; it never signs.
4. Register the core resources: the perp adapter record subject is the `naryx_test_perp_adapter` program, and both the perp venue and perp market record subjects are the test perp market account under the `naryx_test_perp` program code identity, with the market record lot and tick equal to `base_lot_atoms` and `quote_tick_atoms_per_base_lot`.

The sponsored Pyth feed was observed live and fully verified with read-only RPC on 2026-10-01: about 36 seconds old, confidence about 2 bps. A stale or wide feed fails every order closed, so Devnet execution stops rather than trading on a bad price.

### Funding keeper duty

The keeper is the only signer of `set_funding_rate`. It accrues the index at the previous rate up to now and then sets a new rate bounded by `max_funding_rate_per_second`. A reasonable Devnet policy is to set the rate every hour from a public reference funding rate converted to a per-second fraction scaled by `1e12`, and to set `0` when no reference is available. The keeper never moves funds. The market owner can rotate the keeper and toggle `pause_opens` with `update_market_controls`.

### Terminal trading path

The services drive a Devnet entry end to end once the release above is deployed, registered, and initialized. Everything is off by default.

- API (`NARYX_SOLANA_DEVNET_ORDER_CONTEXT_ENABLED`, `NARYX_SOLANA_DEVNET_RUNTIME_ENABLED`): the runtime manifest pins `perpVenueKind: "NARYX_TEST_PERP"`, the `devnet-test-perp` core IDL and its hash, the five program identities, and `testPerp` (market, the Pyth account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`, feed `ef0d8b6f...b56d`, and the strategy id every wallet's strategy PDA derives from). Order contexts price from the live PriceUpdateV2 account with the program's own age and confidence rules, at finalized slots; any wallet trades through its own PDAs, and the settlement account is the wallet. Solver quotes for `svm:devnet` must be `FIRM_ONCHAIN` with a reservation id. The postcondition verifier also reads the trader's test perp position and requires the exact short after entry and a flat position after exit.
- Solver (`NARYX_SOLANA_DEVNET_SOLVER_ENABLED`): signs `FIRM_ONCHAIN` quotes from the same Pyth price (inventory spot at the oracle plus `inventorySpreadBps`, the perp at the market's spread, impact, and taker fee) against a firm ask level in its own package book shard, and serves `POST /internal/solana-devnet/attempt-binding` on loopback. The binding funds and finalizes the inventory reservation and locks the quote (each finalized) only with `NARYX_SOLANA_DEVNET_SOLVER_WRITES_ENABLED=true`; otherwise it binds only an already live reservation and lock. Its key is a Solana CLI keypair file outside the repository whose public key is the solver id.
- The API accepts a binding whose finalized slot is at most 32 slots behind or 160 slots ahead of its own admission slot, because the solver reads and writes at later finalized slots; expiry is still enforced at both slots and by the program.

- Web terminal: before the Devnet review, the Solana ticket reads `GET /internal/terminal/solana-devnet/account` and walks the wallet through each missing step as one v0 transaction, finalized before the next. The response carries the program allowlist (`programs`), the market and collateral vault, and the mints; the terminal accepts only the reviewed instruction templates, the wallet as the only signer, and a deposit no larger than the reported requirement.
- Reservation release: `release_reservation` is permissionless after expiry. The solver releases only its own FUNDED or LIVE reservation in the reviewed class, only once the finalized slot reached expiry, and only when the vault holds exactly the reserved base atoms. It serves `POST /internal/solana-devnet/release-reservation {orderHash}` on loopback, and the binding service frees an expired earlier reservation that still holds the strategy's live pair before funding a new one. Both need `NARYX_SOLANA_DEVNET_SOLVER_WRITES_ENABLED=true`.
- Exit (firm buy-back): the `devnet-test-perp` core build accepts `EXIT` on `execute_firm_cash_and_carry`; the default Rise build still rejects it. The solver's inventory buys the trader's spot back at a firm price through an exit reservation (`fund_exit_reservation`, action 2): the solver escrows the quote atoms and receives exactly the package base. `lock_firm_quote` binds an exit reservation only to a bid level and an entry reservation only to an ask level, and only entry locks are blocked by the entry pause. One trader transaction closes the short reduce-only, moves the exact spot base through the executor to the solver, pays the escrowed quote through the executor to the trader, and closes the open package with an exit receipt. The program enforces spot base out equal to the package quantity, quote in equal to the firm amount and at least the signed spot minimum, a flat position, and empty executor accounts. A package opened under an earlier core domain does not take this path.
  - API: `POST /internal/terminal/solana-devnet/exit-order {owner, slippageBps, idempotencyKey}` reads the wallet's open package, its entry receipt, and its exact short, prices `minSpotQuoteOut` and `minExitQuoteOutcome` from the live Pyth price less `inventorySpreadBps` and the slippage, and stores the canonical EXIT order whose `entryReceiptHash` is the entry order hash (the receipt PDA seed). The wallet authorizes, quotes, and selects it through the usual order routes, and `execution/prepare` with `mode: "exit"` and the same idempotency key materializes a `TRADER_FIRM_EXIT` plan. The postcondition verifier requires the exit receipt naming the entry receipt, the open package closed, and a flat position.
  - Solver: quotes a `FIRM_ONCHAIN` bid level with an `EXIT_QUOTE_OUTCOME` (wallet quote plus the short's PnL less the close fee); the binding funds and finalizes the exit reservation and locks the quote (writes enabled), and the releaser returns an expired exit reservation's quote with `release_exit_reservation`.
  - The public Orca exit path stays fail-closed (`PUBLIC_EXIT_BINDING_REQUIRED`) until a registered Devnet Orca spot venue, market, and adapter exist.
  - Not available yet: the protocol admits firm quotes only for atomic entries (`solverQuote` and `validatePackageAdmission` in `packages/protocol-types`, mirrored by the core `WireFirmQuoteShape`), so the solver refuses its own `FIRM_ONCHAIN` exit bid when it signs it and no exit transaction is built. The terminal and Portfolio say so instead of offering a Solana exit.

### Operator initialization runbook

Every script below runs from `contracts/solana`, requires `--cluster devnet`, verifies the Devnet genesis hash from chain data, refuses keypair files inside the repository, the default Solana CLI wallet, or files readable by group or others, and only simulates unless `--send` is given. Each step is idempotent: an existing account is decoded and must match the plan or the run fails.

1. Deploy and verify the release as described above, then write the candidate release manifest for `naryx_core`, `naryx_inventory_reservation`, `naryx_package_book`, `naryx_test_perp`, and `naryx_test_perp_adapter`.
2. Create the test USDC quote mint. Circle's Devnet USDC faucet grants a few tokens per request, so the hosted Devnet deployment settles in a Naryx test USDC mint: six decimals, the `naryx_test_perp` faucet PDA (seed `test-collateral-faucet`) as its only mint authority, and no freeze authority. Any wallet then claims up to 10,000 per `claim_test_collateral` call into its own token account, up to 10,000,000 per account; the terminal's account setup adds the claim step when a wallet cannot cover its deposit, and the Portfolio page claims on request. Fund the vault funder and the solver the same way:

   ```bash
   node scripts/create-devnet-test-usdc.mjs --cluster devnet --test-perp-program <naryx_test_perp id> \
     --payer /abs/payer.json --mint-keypair /abs/test-usdc-mint.json [--send]
   node scripts/create-devnet-test-usdc.mjs --cluster devnet --test-perp-program <naryx_test_perp id> \
     --payer /abs/payer.json --mint <mint> --claimant /abs/funder.json --claim-atoms 1000000000000 [--send]
   ```

   An existing `--mint` must already be such a faucet mint, or the script stops. Use the mint as the plan's quote mint, the test perp `collateral_mint`, and the quote asset everywhere below.
3. Write the initialization plan outside the repository: domain, governance canceller and pauser, solver id, base and quote mints and decimals, funding keeper, reservation class, package book class, shard reference, spot market units, quote limit, descriptor hashes, series hashes and units, and vault funding targets.
4. Dry run, review the simulated steps, then send:

   ```bash
   node scripts/initialize-devnet.mjs --cluster devnet \
     --release /abs/release.json --plan /abs/plan.json \
     --payer /abs/payer.json --upgrade-authority /abs/upgrade.json \
     --proposer /abs/proposer.json --executor /abs/executor.json \
     --market-owner /abs/market-owner.json --solver /abs/solver.json \
     [--funder /abs/funder.json] --out /abs/initialize-record.json [--send]
   ```

   The order is: core `initialize`, `propose_solver` and `schedule_unpause`, then their activations after the config delay; test perp `initialize_market` with the recommended parameters; the inventory reservation class; the package book class; asset, venue, market, and adapter registrations, each wave proposed and then activated after the delay; the series binding; the solver shard; the solver's base and quote token accounts; and insurance and fee vault top-ups in exact atoms. With `--send` the script waits for each activation slot; rerun it after `--max-wait-seconds` to resume. The record lists every account, each resource manifest document and its hash, and the `runtimeManifest`, `solverConfig`, and `orderContext` fragments.
5. Create the address lookup table for the fixed accounts and add its fragment to the runtime manifest `lookupTables`:

   ```bash
   node scripts/devnet-lookup-table.mjs --cluster devnet --record /abs/initialize-record.json \
     --payer /abs/payer.json --authority /abs/alt-authority.json [--table <address>] [--freeze] [--send]
   ```

6. Fund the solver's base inventory account, start the solver with writes enabled, and let it post its reference and firm ask levels.

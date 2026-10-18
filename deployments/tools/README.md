# Release manifest generator

## Dedicated Hyperliquid test pool

`prepare-hyperliquid-test-pool.mjs --root /srv/naryx --source <reviewed residual config>`
validates the live testnet BTC and collateral identities without writes. `--apply` creates
new encrypted pool, trading-agent, two-owner, and recovery-sponsor identities, separate journals,
and a 20 mock-USDC pool cap. It refuses existing destinations and never sends funds.
The existing residual config is a one-time seed, not a mutable runtime dependency.

After explicit approval of exact testnet funding, `run-hyperliquid-test-pool.mjs --root /srv/naryx`
operates only that dedicated cohort through the loopback pool service:

| Step | Effect |
| --- | --- |
| `--step status` | Read current members, venue state, operation results, and epoch stages |
| `--step enroll --broadcast` | Sign and persist each dedicated owner's custody consent |
| `--step deposit --role <owner-1,owner-2,sponsor> --broadcast` | Send exactly 7 mock USDC once, verify both transfer ledgers, then credit actual net proceeds |
| `--step configure --broadcast` | Approve the dedicated trading agent for seven days and set 5x cross margin |
| `--step epoch --id <unique-id> --broadcast` | Sign one small opposing two-user BTC epoch, with a funded recovery sponsor and automatic close |
| `--step withdraw --role <owner-1,owner-2,sponsor> --broadcast` | Sign a full owner withdrawal, submit once, and reconcile verified transfer evidence |
| `--step observe --id <unique-id>` | Save a read-only evidence snapshot outside the repository |

Run deposits sequentially and reconcile each before transferring the next. Source funding is
separate and explicitly approved; the tool does not load an existing deployer key. Transfers
require explicitly disabled account and DEX abstraction. The tool sets Standard mode only on
the dedicated, flat cohort; it does not interpret a fresh account's unset mode as disabled.
Transfers are journaled before submission and are never resent automatically after a lost response.
If evidence is delayed, rerun the same command to observe the original nonce. Do not delete
journals, invent a replacement operation ID to bypass uncertainty, or manually edit balances.
These commands are operator-only testnet verification, not public pooled custody enrollment.

## Hyperliquid per-user account migration

`prepare-hyperliquid-per-user.mjs --root /srv/naryx` inspects an existing Testnet master-account
deployment without changing it. Adding `--apply` backs up both service environment files,
registers the existing owner and approved API wallet, preserves that same account's journal and
signer lease, selects `PER_USER`, and disables shared-account residual execution. It never reads
private-key contents, signs, transfers funds, or migrates historical positions between owners.

Stop only the affected API and solver services before applying this configuration alongside the
matching service artifacts. Start the solver and API, then verify health, owner-account binding,
agent approval, and the existing journal. A different existing registry is never overwritten.
This migration registers only the existing account. New users require their own separately
approved agents and registry records; it is not self-service account enrollment.

## Conformance oracle maintenance

The native EVM test perpetual and dated-future markets use an owner-operated test oracle. Refreshing it preserves the existing test answer and advances the onchain timestamp; it is not a live market-price feed. The tool uses the shortest heartbeat among the reviewed native markets and any active canonical test perpetual market sharing their oracle. Run it more frequently than half that heartbeat, shown as `maxAgeSeconds`, while demonstrating these markets. Stale rounds remain rejected by the contracts.

If a canonical market uses a different external oracle, the tool verifies its market and oracle code hashes and reports its freshness with `managed: false` and `readOnly: true`. It never signs an update to that feed, even with `--broadcast`. The Base canonical lane uses an external ETH/USD feed with a one-hour freshness limit; refreshing a native test oracle does not repair an external stale round.

Read-only inspection:

```bash
node --env-file=deployments/.env deployments/tools/refresh-evm-conformance-oracles.mjs --network arbitrum-sepolia
```

For a refresh, add `--broadcast --account <oracle-owner-keystore> --journal <absolute-private-sqlite-path>`. Set `NARYX_ORACLE_KEYSTORE_PASSWORD` in an ignored local env file, or select its existing variable with `--password-env <variable-name>` and load that file using Node's `--env-file`. Alternatively use `--key-file <absolute-owner-only-test-key-path>` instead of `--account`, with the existing EVM test signer file format. Repeat for `--network base-sepolia`, with a different journal. Build the solver workspace first. The tool verifies chain identity, release factory and instrument code hashes, oracle bindings, owner authority, and a bounded testnet gas cost before signing. Without `--broadcast`, it never loads a signer. This tool does not update Chainlink, GMX, or any mainnet oracle.

Use a single process per journal, such as the supplied systemd units with `flock`. Each network has a persistent 0.001 test ETH reservation budget, conservatively reserving 0.000005 per attempt without refunds. Before each Base broadcast, the tool estimates L1 and operator fees in addition to maximum execution gas; their sum must fit in half the reservation. Actual ancillary fees are reconciled from chain evidence, and missing evidence or any overrun stops further spending. L1 fees can change before inclusion and are not limited by the transaction's maximum execution-gas fee, so this is conservative headroom, not an absolute total-cost guarantee. The signed transaction is stored before submission; retries reuse those exact bytes, not another nonce. A changed source round, unknown outcome, failed receipt, or exhausted budget requires operator review. Never delete or replace the database to reset its budget. Public price feeds remain read-only, and the current test price is preserved. These are fixed-price conformance feeds, not market data.

Add `--refresh-now` when another reviewed consumer has a shorter heartbeat than the native market. This preserves the test answer while advancing its round, never relaxes a consumer's freshness checks, and still requires `--broadcast` to write. A read-only invocation with this flag only reports that a refresh is requested.

## Release generation

Operator tooling, not consumed by any workspace. After a reviewed deployment, one command turns the deployment output and the reviewed release values into every runtime file the services and the web app load, and proves each one loads with the services' own loader code.

The release generator never signs, broadcasts, funds, or approves. It reads chains only over read-only RPC, never opens a key file, and writes only key file paths. It refuses mainnet chain ids and the Solana mainnet-beta genesis, refuses any output or data directory inside the repository, and refuses an output that names a mainnet domain or carries key material.

## Inputs

| Network | Release template | Deployment input | Read-only RPC (environment) |
|---|---|---|---|
| shared | `deployments/tools/release-common.template.json` | none | none |
| Base Sepolia | `deployments/evm/base-sepolia/release.template.json` | `broadcast/DeployBaseSepoliaAtomicPackage.s.sol/84532/run-latest.json` and `broadcast/DeployBaseSepoliaFirmLiquidity.s.sol/84532/runWith-latest.json` (`runWith`, the test USDC pairing; `run-latest.json` after `run`) | `NARYX_BASE_SEPOLIA_RPC_URL` |
| Arbitrum Sepolia | `deployments/evm/arbitrum-sepolia/release.template.json` | `broadcast/DeployArbitrumSepoliaAsyncGmx.s.sol/421614/run-latest.json` | `NARYX_ARBITRUM_SEPOLIA_RPC_URL` |
| Solana Devnet | `deployments/solana/devnet/release.template.json` | program ids, reviewed artifact hashes (or `artifactPath`), the `initialize-devnet.mjs` and `devnet-lookup-table.mjs` records, optional `programShowJson` (`solana program show --output json`) per program | `NARYX_SOLANA_DEVNET_RPC_URL` |
| Hyperliquid Testnet | `deployments/hyperliquid/testnet/release.template.json` | operator configuration only | none (reads the public testnet info API) |

Optional public RPC endpoints for the browser bundle: `NARYX_WEB_BASE_SEPOLIA_RPC_URL`, `NARYX_WEB_ARBITRUM_SEPOLIA_RPC_URL`, `NARYX_WEB_SOLANA_DEVNET_RPC_URL`. They are written into `NEXT_PUBLIC_*` values, so they must never carry a provider key; unset, the web app uses public endpoints.

## Fill the templates

Copy each template you need outside the repository, for example to `~/naryx-release/`, and replace every `{"$operator": "..."}` with the reviewed value. Filled copies are never committed. A run with any value left unfilled writes nothing and lists every missing value with its path.

Values the chain already knows are never typed by hand. The generator derives them:

- EVM: each contract's address from the forge `.returns` tuple (checked against the CREATE transaction and its contract name), addresses read through view calls (`spotPort.pool()`, `accountFactory.market()`, and so on), the live `eth_getCode` keccak code hash of every contract, each deployment block from the live receipt, the reviewed `DomainManifest` hash computed with `packages/protocol-types` and checked against `ProtocolConfig.domain()`, the reviewed cash-and-carry template manifest hash checked against `ProtocolConfig.cashCarryTemplateManifestHash()` (Base), and the strategy account code hash.
- Solana: each program's ProgramData address, deployment slot, upgrade authority, `programDataHeaderIdentity`, and `programElfSha256` read live after the genesis hash is proven Devnet; each ELF must equal the reviewed artifact hash, and the seven runtime programs pass `verifySolanaDevnetDeploymentIdentity`. The core IDL hash is computed from `deployments/solana/devnet/test-perp/idl/naryx_core.devnet-test-perp.json`, whose address must be the deployed core.
- Every protocol hash a config carries (template manifest, template registry record, fee policy, series identity key and binding hash, settlement class identity, domain reference) is computed with `packages/protocol-types`.

Template values are JSON, extended by these directives, each an object with one `$` key:

| Directive | Value |
|---|---|
| `{"$operator": "hint"}` | must be replaced by the operator |
| `{"$release": "contracts.packageVerifier.codeHash"}` | a derived value: `chainId`, `contracts.<name>.{address,addressLower,codeHash,codeHashBytes,deployBlock,deployTx}`, `programs.<name>.{programId,programDataAddress,deploymentSlot,headerIdentity,elfSha256,elfSha256Hex0x,expectation}`, `genesisHash`, `coreIdl`, `coreIdlHash`, `domainManifest`, `domainManifestHash`, `domainRef` |
| `{"$contract": "name"}` | `{"address", "expectedCodeHash"}` of a derived contract |
| `{"$def": "name.path"}` | a value from the template's `definitions` |
| `{"$out": "api/x.json"}`, `{"$data": "api/x.db"}` | absolute path under `--out` or `--data-dir` |
| `{"$env": "NAME", "optional": true}` | an environment variable read at generation time (RPC URLs) |
| `{"$input": "name", "pointer": "/json/pointer"}` | a value from a JSON file listed under the template's `inputs` |
| `{"$protocol": "fn", "args": [...]}` | a `packages/protocol-types` function result |
| `{"$same": [a, b]}` | `a`, after proving `a` and `b` identical |
| `$bytes`, `$hex`, `$0x`, `$bigint`, `$number`, `$string`, `$lower`, `$keccak`, `$merge`, `$join` | conversions; `{"$naryxType": ...}` protocol JSON tags also work |

The Solana template reads the initialization accounts, resource identities, series, and solver route fragments from the record `contracts/solana/scripts/initialize-devnet.mjs --out` writes (`inputs.init`), and the lookup table from the record `contracts/solana/scripts/devnet-lookup-table.mjs --out` writes (`inputs.lookupTable`). `$same` makes the run fail unless the reviewed domain manifest hashes to the domain the initialization used, the computed template manifest hash equals the one the initialization registered, and the test perp identity agrees. The Solana domain manifest fields are prefilled with the repository's Solana convention (`packages/adapter-core/src/solana-local-environment.ts`); correct them if the reviewed Devnet manifest differs. A readiness decision for a keeper code-hash journal is loaded the same way, with `{"$input": "readinessDecision"}` and an `inputs` entry pointing at its protocol JSON file.

## Build

The generator imports the built `dist` of `packages/protocol-types`, `packages/adapters/solana`, and the four services, so validation runs exactly the code the services run. From the repository root, once per reviewed commit:

```bash
for d in packages/protocol-types packages/adapter-core packages/adapters/evm packages/adapters/solana packages/adapters/hyperliquid services/api services/solver services/keeper services/indexer; do (cd "$d" && npm run build) || break; done
```

It uses `viem` and `@solana/web3.js` from those workspaces' existing `node_modules`; it has no manifest of its own.

## Run

One command per release. Pass the shared file plus every network that was deployed; files shared across networks (the env files, the execution policy, the keeper code watchlist and funding mirror) are merged, and conflicting values stop the run.

```bash
export NARYX_BASE_SEPOLIA_RPC_URL=https://...        # read-only
export NARYX_ARBITRUM_SEPOLIA_RPC_URL=https://...    # read-only
export NARYX_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
node deployments/tools/release-manifests.mjs \
  --out /srv/naryx/release-2026-10-01 --data-dir /srv/naryx/data \
  --release ~/naryx-release/common.json \
  --release ~/naryx-release/base-sepolia.json \
  --release ~/naryx-release/arbitrum-sepolia.json \
  --release ~/naryx-release/solana-devnet.json \
  --release ~/naryx-release/hyperliquid-testnet.json
```

Per network, drop the other `--release` lines:

```bash
# Base Sepolia
NARYX_BASE_SEPOLIA_RPC_URL=https://... node deployments/tools/release-manifests.mjs --out /srv/naryx/base --data-dir /srv/naryx/data --release ~/naryx-release/common.json --release ~/naryx-release/base-sepolia.json
# Arbitrum Sepolia
NARYX_ARBITRUM_SEPOLIA_RPC_URL=https://... node deployments/tools/release-manifests.mjs --out /srv/naryx/arbitrum --data-dir /srv/naryx/data --release ~/naryx-release/common.json --release ~/naryx-release/arbitrum-sepolia.json
# Solana Devnet
NARYX_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com node deployments/tools/release-manifests.mjs --out /srv/naryx/solana --data-dir /srv/naryx/data --release ~/naryx-release/common.json --release ~/naryx-release/solana-devnet.json
# Hyperliquid Testnet
node deployments/tools/release-manifests.mjs --out /srv/naryx/hyperliquid --data-dir /srv/naryx/data --release ~/naryx-release/common.json --release ~/naryx-release/hyperliquid-testnet.json
```

`--out` must be absent or empty; files are written with mode `600`. If any validation fails, every file the run wrote is removed and the error is printed.

## Outputs

| File | Loaded by |
|---|---|
| `api/base-sepolia-runtime.json` | `loadBaseSepoliaRuntimeManifest` (API) and `loadBaseSepoliaSolverDeployment` (solver) |
| `api/base-sepolia-order-context.json` | `loadBaseSepoliaOrderContextConfig` |
| `api/arbitrum-sepolia-runtime.json`, `api/arbitrum-sepolia-order-context.json` | `loadArbitrumSepoliaRuntimeManifest`, `loadArbitrumSepoliaOrderContextConfig` |
| `api/solana-devnet-runtime.json`, `api/solana-devnet-order-context.json` | `loadSolanaDevnetRuntimeManifest` (API) and `loadSolanaDevnetSharedManifest` (solver), `loadSolanaDevnetOrderContextConfig` |
| `api/hyperliquid-testnet-runtime.json`, `api/hyperliquid-native-strategy-order-profiles.json` | Hyperliquid runtime and native strategy-order profile loaders |
| `api/hyperliquid-public-market-support.json`, `api/hyperliquid-public-market-bootstrap.json`, `api/hyperliquid-public-graph-context.json` | Private terminal package exchange support, idempotent registry and book bootstrap, and strategy graph admission |
| `api/testnet-execution-policy.json` | `loadTestnetExecutionPolicy` |
| `solver/base-sepolia-quote.json`, `solver/arbitrum-sepolia-quote.json`, `solver/arbitrum-sepolia-executor.json`, `solver/solana-devnet-solver.json`, `solver/hyperliquid-*.json` | the solver's quote, preparation, executor, and binding loaders |
| `keeper/code-watchlist.json`, `keeper/funding-mirror.json` | `loadCodeHashMonitorConfig`, `loadFundingMirrorConfig` |
| `env/api.env`, `env/solver.env`, `env/keeper.env`, `env/indexer-<network>.env` | each service process (`node --env-file=<file> dist/main.js`, or a systemd `EnvironmentFile`) |
| `web/.env.production` | copy to `apps/web/.env.production` (ignored by Git) before `next build` |
| `release-records/<network>.json` | non-secret identities for the reviewed release record |

The terminal market sources need no file: the API derives them from the order contexts above.

Env files carry RPC URLs, which can hold a provider key; keep the output directory private. Key files are referenced by absolute path only and must be outside the repository.

## Validation

Before it finishes, the generator loads every output through the services' own code, with the generated env files as each process environment:

- API: `loadPrivateTerminalServerConfig` and `loadPrivateTerminalStartupConfig`; `createBaseSepoliaRuntime` and `createArbitrumSepoliaRuntime` with live read clients (chain id, every code hash, factory and coordinator bindings); `createBaseSepoliaOrderRuntime`, `createArbitrumSepoliaOrderRuntime`, and `createSolanaDevnetOrderRuntime` with one live price read and no timer started; `verifySolanaDevnetDeploymentIdentity`; `loadHyperliquidTestnetRuntimeConfig` plus a check of asset indexes, order asset ids, and size decimals against the testnet `meta` and `spotMeta`; `loadTestnetExecutionPolicy`.
- Solver: `loadSolverProcessConfig`, `loadBaseSepoliaQuoteRuntime`, `loadArbitrumSepoliaQuoteRuntime`, `loadArbitrumSepoliaExecutorConfig`, `loadSolanaDevnetSolverConfig` with `loadSolanaDevnetSharedManifest`, the Hyperliquid preparation and quote loaders, and checks that every native strategy profile matches one preparation template and one generalized quote lane.
- Keeper: `loadKeeperRpcUrls`, `loadCodeHashMonitorConfig` followed by one `observeCode` pass that must report every target `MATCH`, and `loadFundingMirrorConfig`.
- Indexer: `loadEvmIndexerConfig` for each `indexer-<network>.env`.
- Web: every `NEXT_PUBLIC_` value is well formed.

Temporary SQLite stores for the API checks live in a fresh system temp directory and are deleted afterwards.

## Isolated EVM recovery deployment

`deploy-evm-recovery.mjs` deploys the existing generation-bound recovery contracts into a separate
Base Sepolia or Arbitrum Sepolia cohort. It never changes the old accounts, adapter registries or
domain manifests. This is controlled test derivative infrastructure, not a public venue deployment.

Required operator inputs:

- `NARYX_RECOVERY_RELEASE_DIR`: a new private absolute directory outside this checkout.
- `BASE_SEPOLIA_RPC_URL` and `ARBITRUM_SEPOLIA_RPC_URL`: endpoints whose returned chain IDs must match.
- `NARYX_RECOVERY_DEPLOYER_ACCOUNT`, `NARYX_RECOVERY_PROPOSER_ACCOUNT`, and
  `NARYX_RECOVERY_EXECUTOR_ACCOUNT`: local Foundry keystore names. Governance addresses must match
  the existing multi-strategy release; `NARYX_RECOVERY_DEPLOYER_ADDRESS` binds the funding signer.
- `FOUNDRY_PASSWORD`: supplied through an ignored local environment, never in committed commands.
- `NARYX_RECOVERY_OWNER_ADDRESS`: the approved dedicated test account owner.
- `NARYX_RECOVERY_BROADCAST=true`: explicit broadcast opt-in. Without it the deployment refuses writes.

Build the contract artifacts once before deployment. Run each phase for each network, waiting for
the contract's 60-second delay before either activation phase:

```bash
node deployments/tools/deploy-evm-recovery.mjs base-sepolia deploy
node deployments/tools/deploy-evm-recovery.mjs base-sepolia propose-domain
# After the onchain delay:
node deployments/tools/deploy-evm-recovery.mjs base-sepolia activate-domain
node deployments/tools/deploy-evm-recovery.mjs base-sepolia configure
# After the onchain delay:
node deployments/tools/deploy-evm-recovery.mjs base-sepolia activate
node deployments/tools/deploy-evm-recovery.mjs base-sepolia inspect
```

The keystore password is passed to Foundry through a mode-600 transient file in the private release
directory and removed immediately after unlocking. It is not placed in command-line arguments.

Repeat with `arbitrum-sepolia`. Keep deployer and governance signers exclusive during these writes;
restore any deliberately stopped oracle updater timers immediately afterward. Rerunning a phase
reconciles its journaled transaction hashes and refuses changed payloads. Never delete that journal
to retry a failed transaction. It contains signed transaction bytes and must stay private.

Risk policies register each exact adapter subject as a dependency. An older release with generic
dependency IDs requires `propose-risk-dependencies`, the governance delay, then
`activate-risk-dependencies`. These phases publish a new policy version and do not reinterpret
already signed policy hashes. The configuration generator refuses a policy that omits a subject.

The deployment reserves at most 0.003 test ETH per chain, including the 0.0003 test ETH it sends
to that chain's fresh dedicated solver. This is a per-release limit, not permission to exceed an
operator's cumulative budget. No quote tokens are minted or deposited by this script.

After both activations, generate AWS configuration using read-only chain checks:

```bash
node deployments/tools/configure-evm-recovery.mjs
```

It verifies 16 deployed code hashes per chain, domain identity, adapter controls, active risk/fee
policies and solver gas balances. Outputs in the private release directory are
`cross-domain-runtime.json`, `executor-manifest.json` and `activation-observations.json`.
The runtime is consumed by `services/solver/dist/cross-domain-main.js`; it uses a loopback API,
separate submission journals, and a 0.00025 test ETH gas budget per solver. Its 10 mock-USDC entry
limit does not fund an account or authorize a trade. Owners must still sign exact entries and
full recoveries before a job can be admitted. Installing it does not enable public website
materialization for the new domain manifests.

On AWS, install both dedicated solver key files using the paths in the generated runtime,
owned by `naryx` with mode 600. Install the runtime under `/srv/naryx/release/recovery` and create
`/srv/naryx/release/env/cross-domain.env` with `NARYX_CROSS_DOMAIN_ENABLED=true`,
`NARYX_CROSS_DOMAIN_CONFIG` pointing to that runtime, and the two RPC variables
`NARYX_BASE_SEPOLIA_RPC_URL` and `NARYX_ARBITRUM_SEPOLIA_RPC_URL`. Create
`/srv/naryx/data/cross-domain` owned by `naryx`, then enable `naryx-cross-domain.service`.
Preserve its database and journals across all future releases. Startup is not proof of an
executed recovery or a substitute for release qualification.

The worker binds to `127.0.0.1:8806`. Its `POST /jobs` accepts a complete signed protocol-JSON
job only from a loopback service without a browser Origin header. Admission verifies the exact
account owner, entry and recovery signatures, funded reservation, code hashes, deadlines and
dedicated cohort limits before storing immutable authorizations. `GET /jobs/<planHash>` reports
the persisted job status without exposing those signatures. This is an operator/service interface,
not the public website's quote materializer. Do not expose it through the public reverse proxy.

Reservation release has its own 300,000 gas ceiling, separate from the 4,000,000 ceilings for
entry and recovery. Budget reservation includes all three possible submissions. Do not increase
the approved gas budget just because a reservation release inherited an entry-sized gas limit.

## Self-check

```bash
node deployments/tools/self-check.mjs
```

Offline: directive resolution, merge rules, the repository, mainnet, and key-material refusals, and a lint of every template's directives, definitions, contracts, programs, and output paths.

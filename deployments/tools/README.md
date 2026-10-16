# Release manifest generator

## Conformance oracle maintenance

The native EVM test perpetual and dated-future markets use an owner-operated test oracle. Refreshing it preserves the existing test answer and advances the onchain timestamp; it is not a live market-price feed. The tool uses the shortest heartbeat among the reviewed native markets and any active canonical test perpetual market sharing their oracle. Run it more frequently than half that heartbeat, shown as `maxAgeSeconds`, while demonstrating these markets. Stale rounds remain rejected by the contracts.

If a canonical market uses a different external oracle, the tool verifies its market and oracle code hashes and reports its freshness with `managed: false` and `readOnly: true`. It never signs an update to that feed, even with `--broadcast`. The Base canonical lane uses an external ETH/USD feed with a one-hour freshness limit; refreshing a native test oracle does not repair an external stale round.

Read-only inspection:

```bash
node --env-file=deployments/.env deployments/tools/refresh-evm-conformance-oracles.mjs --network arbitrum-sepolia
```

For a refresh, add `--broadcast --account <oracle-owner-keystore>`. Set `NARYX_ORACLE_KEYSTORE_PASSWORD` in an ignored local env file, or select its existing variable with `--password-env <variable-name>` and load that file using Node's `--env-file`. Repeat for `--network base-sepolia`. The tool verifies chain identity, release factory and instrument code hashes, oracle bindings, owner authority, and a bounded testnet gas cost before signing. Without `--broadcast`, it never loads a signer. This tool does not update Chainlink, GMX, or any mainnet oracle.

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

## Self-check

```bash
node deployments/tools/self-check.mjs
```

Offline: directive resolution, merge rules, the repository, mainnet, and key-material refusals, and a lint of every template's directives, definitions, contracts, programs, and output paths.

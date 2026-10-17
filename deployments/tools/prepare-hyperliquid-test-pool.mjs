import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repository, 'services/solver/package.json'));
const { generatePrivateKey, privateKeyToAccount } = await import(require.resolve('viem/accounts'));
const { keccak256, toHex, getAddress } = await import(require.resolve('viem'));
const { HttpTransport, InfoClient, TESTNET_API_URL } = await import(require.resolve('@nktkas/hyperliquid'));
const { parseProtocolJson, stringifyProtocolJson, nettingPolicyManifest, assetRef } =
  await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const { poolEpochPolicyHash } = await import(pathToFileURL(join(repository, 'services/solver/dist/hyperliquid-pool-epoch.js')).href);
const { writeEncryptedHyperliquidTestnetAgentKey } =
  await import(pathToFileURL(join(repository, 'services/solver/dist/hyperliquid-testnet-agent-key.js')).href);
const { values } = parseArgs({ options: { root: { type: 'string' }, source: { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!values.root || !isAbsolute(values.root) || resolve(values.root) !== values.root
  || !values.source || !isAbsolute(values.source)) throw new Error('--root and --source must be explicit absolute paths');
const root = values.root;
const data = join(root, 'data/hyperliquid-pool-v1');
const release = join(root, 'release/hyperliquid-pool-v1');
const keys = join(root, 'keys/hyperliquid-pool-v1');
const envPath = join(root, 'release/env/hyperliquid-pool.env');
if ([data, release, keys, envPath].some(existsSync)) throw new Error('Pool files already exist; refusing to replace identities or journals');
const source = parseProtocolJson(readFileSync(values.source, 'utf8'));
if (source.environment !== 'TESTNET') throw new Error('Source runtime must be testnet');
const original = source.policy.instruments.find(row => row.legFamily === 'PERP_OPEN'
  && source.bindings.some(binding => binding.instrumentId === row.instrumentId && binding.marketBinding.assetId === 3));
if (!original || original.domain.domainId !== 'hypercore:testnet') throw new Error('Reviewed default BTC source is missing');
const originalBinding = source.bindings.find(row => row.instrumentId === original.instrumentId);
const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, timeout: 5_000 }) });
const [meta, spot] = await Promise.all([info.meta({ dex: '' }), info.spotMeta()]);
const btc = meta.universe[3];
const collateral = spot.tokens.find(row => row.index === meta.collateralToken);
if (btc?.name !== 'BTC' || btc.szDecimals !== 5 || btc.isDelisted || meta.collateralToken !== 0
  || collateral?.tokenId !== '0xeb62eee3685fc4c43992febcd9e75443' || !collateral.isCanonical || collateral.name !== 'USDC') {
  throw new Error('Authoritative testnet BTC or collateral identity differs');
}
const environment = parseEnv(readFileSync(join(root, 'release/env/solver.env'), 'utf8'));
const clockKeys = ['NTP_HOST_1', 'NTP_HOST_2', 'NTP_TIMEOUT_MS', 'MAX_NTP_ROUND_TRIP_MS',
  'MAX_TIME_SOURCE_SPREAD_MS', 'MAX_LOCAL_CLOCK_SKEW_MS', 'MAX_FUTURE_NONCE_LEAD_MS', 'CLOCK_MARKET']
  .map(key => `NARYX_HYPERLIQUID_TESTNET_${key}`);
if (clockKeys.some(key => !environment[key])) throw new Error('Existing trusted-time settings are incomplete');
const keeperOrigin = environment.NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN;
if (!keeperOrigin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(keeperOrigin)) throw new Error('Reviewed loopback keeper origin is required');
const quoteManifest = { version: 1, environment: 'TESTNET', domain: original.domain, tokenId: collateral.tokenId,
  denomination: 'HYPERCORE_PERPETUAL_USDC_LEDGER_MICRO_UNITS', decimals: 6 };
const digest = value => keccak256(toHex(stringifyProtocolJson(value)));
const quoteAsset = assetRef('hypercore:testnet:perp-usdc-micro', digest(quoteManifest), 6);
const { instrumentHash: _oldHash, ...instrument } = original;
const common = { ...source.policy, executionClassId: 'dedicated-test-pool-v1', executionClassVersion: 1,
  executionClassManifestHash: digest({ epoch: keccak256(readFileSync(join(repository, 'services/solver/dist/hyperliquid-pool-epoch.js'))),
    executor: keccak256(readFileSync(join(repository, 'services/solver/dist/hyperliquid-pool-netting-execution.js'))) }),
  maximumObligations: 32, instruments: [{ ...instrument, instrumentId: 'pool-btc-perp', quoteAsset,
    quantityIncrementAtoms: 10n ** BigInt(instrument.quantityAsset.decimals - btc.szDecimals), priceTickQuoteAtoms: 1n }] };
const entryPolicy = nettingPolicyManifest(common);
const exitPolicy = nettingPolicyManifest({ ...common,
  instruments: common.instruments.map(row => ({ ...row, legFamily: 'PERP_CLOSE' })) });
const makeLane = policy => ({ version: 1, environment: 'TESTNET', policy,
  bindings: [{ ...originalBinding, instrumentId: 'pool-btc-perp' }] });
if (!values.apply) {
  console.log(JSON.stringify({ environment: 'TESTNET', data, release, keys, envPath, testOwners: 3,
    maximumPoolQuoteAtoms: '20000000', onchainWrites: false, createsKeys: false }));
  process.exit(0);
}
for (const path of [data, release, keys]) mkdirSync(path, { mode: 0o700 });
const write = (path, value) => writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
const encryptionKeyPath = join(keys, 'encryption.key');
write(encryptionKeyPath, randomBytes(32));
const identities = {};
for (const name of ['pool', 'agent', 'owner-1', 'owner-2', 'sponsor']) {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address.toLowerCase();
  const keyPath = join(keys, `${name}.json`);
  writeEncryptedHyperliquidTestnetAgentKey(keyPath, privateKey, encryptionKeyPath);
  identities[name] = { address, keyPath };
}
write(join(keys, 'operator.token'), randomBytes(32).toString('hex'));
const binding = { version: 1, environment: 'TESTNET', domain: original.domain, poolAccount: identities.pool.address,
  policyHash: poolEpochPolicyHash(entryPolicy, exitPolicy), quoteAsset, collateralTokenId: collateral.tokenId,
  dedicatedTestOwners: ['owner-1', 'owner-2', 'sponsor'].map(name => identities[name].address), maximumTotalQuoteAtoms: 20_000_000n };
const config = { version: 1, environment: 'TESTNET', binding, databasePath: join(data, 'collateral.sqlite'),
  journalPath: join(data, 'execution.sqlite'), entryConfigPath: join(release, 'entry.json'), exitConfigPath: join(release, 'exit.json'),
  markets: [{ instrumentId: 'pool-btc-perp', coin: 'BTC', assetId: 3, sizeDecimals: btc.szDecimals }],
  agentAddress: identities.agent.address, agentKeyPath: identities.agent.keyPath, custodyKeyPath: identities.pool.keyPath,
  encryptionKeyPath, operatorTokenPath: join(keys, 'operator.token'), keeperOrigin };
write(join(release, 'entry.json'), stringifyProtocolJson(makeLane(entryPolicy)));
write(join(release, 'exit.json'), stringifyProtocolJson(makeLane(exitPolicy)));
write(join(release, 'collateral-manifest.json'), stringifyProtocolJson(quoteManifest));
write(join(release, 'runtime.json'), stringifyProtocolJson(config));
write(join(release, 'identities.json'), JSON.stringify(identities));
write(envPath, [...clockKeys.map(key => `${key}=${environment[key]}`), 'NARYX_HYPERLIQUID_POOL_ENABLED=true',
  'NARYX_HYPERLIQUID_POOL_ENVIRONMENT=TESTNET', `NARYX_HYPERLIQUID_POOL_CONFIG=${join(release, 'runtime.json')}`,
  'NARYX_HYPERLIQUID_POOL_PORT=8821', ''].join('\n'));
console.log(JSON.stringify({ environment: 'TESTNET', configured: true, funded: false,
  accounts: Object.fromEntries(Object.entries(identities).map(([role, value]) => [role, getAddress(value.address)])),
  maximumPoolQuoteAtoms: binding.maximumTotalQuoteAtoms.toString(), envPath }));

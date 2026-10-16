#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'services/solver/package.json'));
const { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseAbiParameters, stringToHex } = require('viem');
const protocol = await import(pathToFileURL(join(root, 'packages/protocol-types/dist/index.js')).href);
const { values } = parseArgs({ options: { source: { type: 'string' }, deployment: { type: 'string' }, output: { type: 'string' } } });
if (!values.source || !values.deployment || !values.output) throw new Error('Provide source, deployment, and unused output paths.');
const source = resolve(values.source), output = resolve(values.output);
if (existsSync(output)) throw new Error('The output already exists.');
const deployed = JSON.parse(readFileSync(resolve(values.deployment), 'utf8'));
const networks = { 'base-sepolia': 84532, 'arbitrum-sepolia': 421614 };
if (deployed.environment !== 'testnet' || deployed.chainId !== networks[deployed.network]
  || deployed.activationState !== 'UNREGISTERED') throw new Error('The replacement is not an unregistered testnet deployment.');
const rpc = process.env[deployed.network === 'base-sepolia' ? 'NARYX_BASE_SEPOLIA_RPC_URL' : 'NARYX_ARBITRUM_SEPOLIA_RPC_URL'];
if (!rpc) throw new Error('The testnet RPC is missing.');
const client = createPublicClient({ transport: http(rpc) });
if (await client.getChainId() !== deployed.chainId) throw new Error('RPC chain identity differs.');
const release = JSON.parse(readFileSync(join(root, 'deployments/evm', deployed.network, 'multi-strategy-release.json'), 'utf8'));
if (release.environment !== 'testnet' || release.chainId !== deployed.chainId || release.activationState !== 'ACTIVE'
  || getAddress(deployed.oldFactory) !== getAddress(release.contracts.reverseLendingFactory.address)) throw new Error('The old release identity differs.');
for (const entry of [deployed.contracts.reverseLendingPool, deployed.contracts.reverseLendingFactory,
  release.contracts.adapterRegistry]) {
  const code = await client.getCode({ address: getAddress(entry.address) });
  if (!code || keccak256(code).toLowerCase() !== entry.runtimeCodeHash.toLowerCase()) throw new Error('A reviewed code identity differs.');
}
const read = (path) => protocol.parseProtocolJson(readFileSync(join(source, path), 'utf8'));
const runtimePath = 'solver/evm-reverse-basis-runtime.json';
const profilesPath = 'api/evm-reverse-basis-order-profiles.json';
const runtime = read(runtimePath), profiles = read(profilesPath), graph = read('api/public-graph-context.json');
if (runtime.environment !== 'testnet' || profiles.environment !== 'testnet') throw new Error('Only testnet configuration may be prepared.');
const lanes = runtime.lanes.filter((lane) => lane.domain.domainId === `eip155:${deployed.chainId}`);
if (lanes.length !== 1) throw new Error('The source must contain exactly one prior lane for the replacement domain.');
const prior = lanes[0], oldAdapter = protocol.adapterRef(prior.lending.adapter), oldMarket = prior.lending.market;
const registryArtifact = JSON.parse(readFileSync(join(root, 'contracts/evm/out/TypedStrategyAdapterRegistry.sol/TypedStrategyAdapterRegistry.json'), 'utf8'));
const subjectId = keccak256(stringToHex(oldAdapter.adapterId));
const [binding, control] = await client.readContract({ address: getAddress(release.contracts.adapterRegistry.address),
  abi: registryArtifact.abi, functionName: 'activeAdapter', args: [subjectId] });
if (binding.identity.manifestVersion !== oldAdapter.adapterManifestVersion
  || binding.identity.manifestHash.toLowerCase() !== `0x${protocol.toHex(oldAdapter.adapterManifestHash)}`
  || getAddress(binding.adapter) !== getAddress(deployed.oldFactory)) throw new Error('The prior active adapter binding differs.');
const replacementHash = keccak256(encodeAbiParameters(parseAbiParameters('string,bytes32,uint32,address,bytes32,address,bytes32'), [
  'NARYX_REVERSE_LENDING_REPLACEMENT_V1', subjectId, oldAdapter.adapterManifestVersion + 1,
  deployed.contracts.reverseLendingFactory.address, deployed.contracts.reverseLendingFactory.runtimeCodeHash,
  deployed.contracts.reverseLendingPool.address, deployed.contracts.reverseLendingPool.runtimeCodeHash,
]));
const adapter = protocol.adapterRef({ ...oldAdapter, adapterManifestVersion: oldAdapter.adapterManifestVersion + 1,
  adapterManifestHash: replacementHash });
const marketHash = keccak256(encodeAbiParameters(parseAbiParameters('string,address,bytes32'), [
  'NARYX_TEST_REVERSE_LENDING_MARKET_V2', deployed.contracts.reverseLendingPool.address,
  deployed.contracts.reverseLendingPool.runtimeCodeHash,
]));
const market = protocol.versionedManifestRef(oldMarket.subjectId, oldMarket.manifestVersion + 1, marketHash);
function replace(value) {
  if (Array.isArray(value)) return value.map(replace);
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (value.adapterId === oldAdapter.adapterId && value.adapterManifestVersion === oldAdapter.adapterManifestVersion) return adapter;
  if (value.subjectId === oldMarket.subjectId && value.manifestVersion === oldMarket.manifestVersion) return market;
  if (value.recordKind === 'ADAPTER' && value.subjectId === oldAdapter.adapterId) return {
    ...value, subjectManifestVersion: adapter.adapterManifestVersion, subjectManifestHash: adapter.adapterManifestHash,
  };
  if (value.recordKind === 'MARKET' && value.subjectId === oldMarket.subjectId) return {
    ...value, subjectManifestVersion: market.manifestVersion, subjectManifestHash: market.manifestHash,
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
}
const lane = replace(prior);
lane.laneId = `${prior.laneId}-lending-v${adapter.adapterManifestVersion}`;
lane.lendingPool = { address: deployed.contracts.reverseLendingPool.address, expectedCodeHash: deployed.contracts.reverseLendingPool.runtimeCodeHash };
lane.borrowCollateralRatioBps = 30_000n;
lane.adapters = lane.adapters.map((item) => item.role === 'base-borrow' ? { ...item,
  factory: { address: deployed.contracts.reverseLendingFactory.address, expectedCodeHash: deployed.contracts.reverseLendingFactory.runtimeCodeHash },
} : item);
const nextProfiles = profiles.profiles.map((profile) => profile.domain.domainId === `eip155:${deployed.chainId}` ? replace(profile) : profile);
const newRecords = prior.activeRegistryRecords
  .filter((record) => (record.recordKind === 'ADAPTER' && record.subjectId === oldAdapter.adapterId)
    || (record.recordKind === 'MARKET' && record.subjectId === oldMarket.subjectId)).map(replace);
const write = (path, value) => { const target = join(output, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, protocol.stringifyProtocolJson(value), { mode: 0o600 }); };
write(runtimePath, { ...runtime, lanes: [...runtime.lanes, lane] });
write(profilesPath, { ...profiles, profiles: nextProfiles });
write('api/public-graph-context.json', { ...graph, activeRegistryRecords: [...graph.activeRegistryRecords, ...newRecords] });
const nextBinding = { ...binding, identity: { ...binding.identity, manifestVersion: adapter.adapterManifestVersion,
  manifestHash: replacementHash }, adapter: deployed.contracts.reverseLendingFactory.address,
  expectedCodeHash: deployed.contracts.reverseLendingFactory.runtimeCodeHash };
write('onchain-activation.json', { version: 1, environment: 'testnet', chainId: deployed.chainId,
  registry: release.contracts.adapterRegistry.address, proposer: release.governance.proposer,
  executor: release.governance.executor, delaySeconds: release.governance.delaySeconds, subjectId,
  adapterVersion: adapter.adapterManifestVersion, adapterManifestHash: replacementHash,
  proposeCalldata: encodeFunctionData({ abi: registryArtifact.abi, functionName: 'proposeRegistration', args: [nextBinding, control] }),
  activateCalldata: encodeFunctionData({ abi: registryArtifact.abi, functionName: 'activateRegistration', args: [subjectId] }),
});
console.log(JSON.stringify({ network: deployed.network, adapterId: adapter.adapterId,
  adapterVersion: adapter.adapterManifestVersion, marketVersion: market.manifestVersion, output, activationState: 'PREPARED_ONLY' }));

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  adapterRef,
  assetRef,
  domainRef,
  domainRegistryRecord,
  packageTemplateManifest,
  parseProtocolJson,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type PackageTemplateManifestInput,
  type TypedAdapterActionSupportInput,
} from '@naryx/protocol-types';
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { createEvmOptionSpreadGeneralizedPricing } from './evm-option-spread-quote.js';
import type { EvmOptionSpreadPreparationLane, EvmOptionSpreadPackageIdPort } from './evm-option-spread-preparation.js';
import type { GeneralizedStrategyQuoteLane } from './strategy-quote-context-registry.js';
import type { EvmOptionSpreadQuoteNonceSource, EvmOptionSpreadReadPort } from './evm-option-spread-quote.js';
import {
  createViemEvmStrategyObservationReadPort,
  type EvmOptionSpreadObservationLane,
} from './evm-option-spread-observation.js';

const MAX_CONFIG_BYTES = 2_097_152;
const TEST_CHAIN_IDS = new Set([84_532n, 421_614n, 31_337n, 31_338n]);

interface RuntimeLane {
  readonly quote: GeneralizedStrategyQuoteLane;
  readonly preparation: EvmOptionSpreadPreparationLane;
}

function fail(message: string): never {
  throw new Error(`EVM option spread runtime config: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${context} must be a nonempty string`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${context} must be a positive safe integer`);
  return Number(value);
}

function natural(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) fail(`${context} must be a nonnegative bigint`);
  return value;
}

function positive(value: unknown, context: string): bigint {
  const checked = natural(value, context);
  if (checked === 0n) fail(`${context} must be positive`);
  return checked;
}

function hash(value: unknown, context: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    fail(`${context} must be a nonzero bytes32`);
  }
  return value.toLowerCase() as Hex;
}

function contract(value: unknown, context: string) {
  const input = record(value, context);
  return Object.freeze({
    address: getAddress(string(input.address, `${context}.address`)),
    expectedCodeHash: hash(input.expectedCodeHash, `${context}.expectedCodeHash`),
  });
}

function absoluteJson(path: string): unknown {
  if (!isAbsolute(path)) fail('config path must be absolute');
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail('config file is too large');
  try {
    return parseProtocolJson(readFileSync(resolved, 'utf8'), 'evmOptionSpreadRuntime');
  } catch {
    return fail('config file is not valid protocol JSON');
  }
}

export function createViemEvmOptionSpreadReadPort(rpcUrl: string): EvmOptionSpreadReadPort {
  if (!/^https?:\/\//.test(rpcUrl)) fail('rpcUrl must be HTTP or HTTPS');
  const client = createPublicClient({ transport: http(rpcUrl) });
  return Object.freeze({
    chainId: async () => BigInt(await client.getChainId()),
    latestBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
    codeHash: async (address: Address) => {
      const code = await client.getCode({ address });
      return code === undefined || code === '0x' ? undefined : keccak256(code);
    },
    readContract: async (request: Parameters<EvmOptionSpreadReadPort['readContract']>[0]) => client.readContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
    } as never),
  });
}

function lane(
  value: unknown,
  chain: EvmOptionSpreadReadPort,
  nonceSource: (laneId: string) => EvmOptionSpreadQuoteNonceSource,
  packageIds: EvmOptionSpreadPackageIdPort,
): RuntimeLane {
  const input = record(value, 'lane');
  const laneId = string(input.laneId, 'lane.laneId');
  const templateManifest = packageTemplateManifest(input.templateManifest as PackageTemplateManifestInput, 'lane.templateManifest');
  if (templateManifest.environment !== 'testnet') fail('template manifest must be testnet');
  if (!Array.isArray(input.activeRegistryRecords) || input.activeRegistryRecords.length === 0
    || !Array.isArray(input.resourceLimits) || input.resourceLimits.length === 0
    || !Array.isArray(input.adapterSupport) || input.adapterSupport.length === 0
    || !Array.isArray(input.pools) || input.pools.length !== 2
    || !Array.isArray(input.adapters) || input.adapters.length !== 2) {
    fail(`lane ${laneId} collections are incomplete`);
  }
  const activeRegistryRecords = Object.freeze(input.activeRegistryRecords.map((item, index) =>
    domainRegistryRecord(item as DomainRegistryRecordInput, `lane.activeRegistryRecords[${index}]`)));
  const resourceLimits = Object.freeze(input.resourceLimits as DomainResourceLimit[]);
  const adapterSupport = Object.freeze(input.adapterSupport as TypedAdapterActionSupportInput[]);
  const chainId = positive(input.chainId, 'lane.chainId');
  if (!TEST_CHAIN_IDS.has(chainId)) fail(`lane ${laneId} is not an allowed test chain`);
  const domainValue = record(input.domain, 'lane.domain');
  const domain = domainRef(
    string(domainValue.domainId, 'lane.domain.domainId'),
    integer(domainValue.domainManifestVersion, 'lane.domain.domainManifestVersion'),
    domainValue.domainManifestHash as Uint8Array | string,
  );
  if (domain.domainId !== `eip155:${chainId}`) fail(`lane ${laneId} domain and chain differ`);
  const asset = (raw: unknown, context: string) => {
    const item = record(raw, context);
    return assetRef(string(item.assetId, `${context}.assetId`), item.assetManifestHash as Uint8Array | string, integer(item.decimals, `${context}.decimals`));
  };
  const baseAsset = asset(input.baseAsset, 'lane.baseAsset');
  const quoteAsset = asset(input.quoteAsset, 'lane.quoteAsset');
  const pools = input.pools.map((raw, index) => {
    const item = record(raw, `lane.pools[${index}]`);
    if (item.role !== 'option-long' && item.role !== 'option-short') fail(`lane.pools[${index}].role is invalid`);
    return Object.freeze({
      role: item.role,
      adapter: adapterRef(item.adapter as never, `lane.pools[${index}].adapter`),
      venue: versionedManifestRef(
        string((item.venue as Record<string, unknown>).subjectId, `lane.pools[${index}].venue.subjectId`),
        integer((item.venue as Record<string, unknown>).manifestVersion, `lane.pools[${index}].venue.manifestVersion`),
        (item.venue as Record<string, unknown>).manifestHash as Uint8Array | string,
      ),
      market: versionedManifestRef(
        string((item.market as Record<string, unknown>).subjectId, `lane.pools[${index}].market.subjectId`),
        integer((item.market as Record<string, unknown>).manifestVersion, `lane.pools[${index}].market.manifestVersion`),
        (item.market as Record<string, unknown>).manifestHash as Uint8Array | string,
      ),
      pool: contract(item.pool, `lane.pools[${index}].pool`),
      expectedStrike: positive(item.expectedStrike, `lane.pools[${index}].expectedStrike`),
      expectedMaturity: positive(item.expectedMaturity, `lane.pools[${index}].expectedMaturity`),
    });
  });
  const pricing = Object.freeze({
    chainId,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: contract(input.baseToken, 'lane.baseToken'),
    quoteToken: contract(input.quoteToken, 'lane.quoteToken'),
    oracle: contract(input.oracle, 'lane.oracle'),
    pools: Object.freeze(pools) as never,
    referencePriceQuoteAtomsPerWholeBase: positive(input.referencePriceQuoteAtomsPerWholeBase, 'lane.referencePriceQuoteAtomsPerWholeBase'),
    strikeDecimals: integer(input.strikeDecimals, 'lane.strikeDecimals'),
    protocolFeeBps: integer(input.protocolFeeBps, 'lane.protocolFeeBps'),
    solverFeeBps: integer(input.solverFeeBps, 'lane.solverFeeBps'),
    networkFeeQuoteAtoms: natural(input.networkFeeQuoteAtoms, 'lane.networkFeeQuoteAtoms'),
    feePolicyVersion: integer(input.feePolicyVersion, 'lane.feePolicyVersion'),
    feePolicyManifestHash: input.feePolicyManifestHash as Uint8Array | string,
    routeTtlSeconds: positive(input.routeTtlSeconds, 'lane.routeTtlSeconds'),
    quoteTtlSeconds: positive(input.quoteTtlSeconds, 'lane.quoteTtlSeconds'),
    chain,
    nonceSource: nonceSource(laneId),
  });
  const adapterFactories = input.adapters.map((raw, index) => {
    const item = record(raw, `lane.adapters[${index}]`);
    if (item.role !== 'option-long' && item.role !== 'option-short') fail(`lane.adapters[${index}].role is invalid`);
    return Object.freeze({
      role: item.role,
      factory: contract(item.factory, `lane.adapters[${index}].factory`),
      expectedAdapterCodeHash: hash(item.expectedAdapterCodeHash, `lane.adapters[${index}].expectedAdapterCodeHash`),
      maximumGasLimit: positive(item.maximumGasLimit, `lane.adapters[${index}].maximumGasLimit`),
    });
  });
  const preparation: EvmOptionSpreadPreparationLane = Object.freeze({
    environment: 'testnet',
    templateManifest,
    activeRegistryRecords,
    resourceLimits,
    pricing,
    accountFactory: contract(input.accountFactory, 'lane.accountFactory'),
    expectedStrategyAccountCodeHash: hash(input.expectedStrategyAccountCodeHash, 'lane.expectedStrategyAccountCodeHash'),
    adapters: Object.freeze(adapterFactories) as never,
    solver: getAddress(string(input.solver, 'lane.solver')),
    packageIds,
  });
  const quote: GeneralizedStrategyQuoteLane = Object.freeze({
    laneId,
    environment: 'testnet',
    templateManifest,
    executionClassId: string(input.executionClassId, 'lane.executionClassId'),
    executionClassVersion: integer(input.executionClassVersion, 'lane.executionClassVersion'),
    executionClassManifestHash: input.executionClassManifestHash as Uint8Array | string,
    activeRegistryRecords,
    resourceLimits,
    adapterSupport,
    solverId: string(input.solverId, 'lane.solverId'),
    solverCapabilityManifestHash: input.solverCapabilityManifestHash as Uint8Array | string,
    pricing: createEvmOptionSpreadGeneralizedPricing(pricing),
    currentTime: async () => Object.freeze({ unit: 'EVM_UNIX_SECONDS' as const, value: await chain.latestBlockTimestamp() }),
  });
  return Object.freeze({ quote, preparation });
}

export function loadEvmOptionSpreadRuntime(
  path: string,
  dependencies: Readonly<{
    nonceSource: (laneId: string) => EvmOptionSpreadQuoteNonceSource;
    packageIds: EvmOptionSpreadPackageIdPort;
  }>,
): Readonly<{
  quoteLanes: readonly GeneralizedStrategyQuoteLane[];
  preparationLanes: readonly EvmOptionSpreadPreparationLane[];
  observationLanes: readonly EvmOptionSpreadObservationLane[];
}> {
  const root = record(absoluteJson(path), 'root');
  if (root.version !== 1 || root.environment !== 'testnet' || typeof root.rpcUrl !== 'string'
    || !Array.isArray(root.lanes) || root.lanes.length === 0 || root.lanes.length > 8) {
    fail('root must define version 1, testnet, rpcUrl, and one to eight lanes');
  }
  const chain = createViemEvmOptionSpreadReadPort(root.rpcUrl);
  const lanes = root.lanes.map((item) => lane(item, chain, dependencies.nonceSource, dependencies.packageIds));
  const observation = createViemEvmStrategyObservationReadPort(root.rpcUrl);
  return Object.freeze({
    quoteLanes: Object.freeze(lanes.map((item) => item.quote)),
    preparationLanes: Object.freeze(lanes.map((item) => item.preparation)),
    observationLanes: Object.freeze(lanes.map((item) => Object.freeze({
      chainId: Number(item.preparation.pricing.chainId),
      chain: observation,
    }))),
  });
}

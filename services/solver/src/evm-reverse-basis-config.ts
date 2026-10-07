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
import { getAddress, type Hex } from 'viem';
import { createViemEvmOptionSpreadReadPort } from './evm-option-spread-config.js';
import {
  createViemEvmStrategyObservationReadPort,
  type EvmStrategyObservationLane,
} from './evm-option-spread-observation.js';
import type { EvmOptionSpreadPackageIdPort } from './evm-option-spread-preparation.js';
import type { EvmOptionSpreadQuoteNonceSource, EvmOptionSpreadReadPort } from './evm-option-spread-quote.js';
import {
  EvmReverseBasisPreparationContextResolver,
  type EvmReverseBasisPreparationLane,
} from './evm-reverse-basis-preparation.js';
import { createEvmReverseBasisGeneralizedPricing } from './evm-reverse-basis-quote.js';
import type { GeneralizedStrategyQuoteLane } from './strategy-quote-context-registry.js';

const MAX_CONFIG_BYTES = 2_097_152;
const TEST_CHAIN_IDS = new Set([84_532n, 421_614n, 31_337n, 31_338n]);
const MAX_BPS = 10_000n;
const MAX_PPM = 1_000_000n;

interface RuntimeLane {
  readonly quote: GeneralizedStrategyQuoteLane;
  readonly preparation: EvmReverseBasisPreparationLane;
}

function fail(message: string): never {
  throw new Error(`EVM reverse basis runtime config: ${message}`);
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

function nonnegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${context} must be a nonnegative safe integer`);
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

function asset(value: unknown, context: string) {
  const input = record(value, context);
  return assetRef(
    string(input.assetId, `${context}.assetId`),
    input.assetManifestHash as Uint8Array | string,
    nonnegativeInteger(input.decimals, `${context}.decimals`),
  );
}

function leg(value: unknown, context: string) {
  const input = record(value, context);
  const venue = record(input.venue, `${context}.venue`);
  const market = record(input.market, `${context}.market`);
  return Object.freeze({
    adapter: adapterRef(input.adapter as never, `${context}.adapter`),
    venue: versionedManifestRef(
      string(venue.subjectId, `${context}.venue.subjectId`),
      integer(venue.manifestVersion, `${context}.venue.manifestVersion`),
      venue.manifestHash as Uint8Array | string,
    ),
    market: versionedManifestRef(
      string(market.subjectId, `${context}.market.subjectId`),
      integer(market.manifestVersion, `${context}.market.manifestVersion`),
      market.manifestHash as Uint8Array | string,
    ),
  });
}

function absoluteJson(path: string): unknown {
  if (!isAbsolute(path)) fail('config path must be absolute');
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail('config file is too large');
  try {
    return parseProtocolJson(readFileSync(resolved, 'utf8'), 'evmReverseBasisRuntime');
  } catch {
    return fail('config file is not valid protocol JSON');
  }
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
  if (templateManifest.environment !== 'testnet' || templateManifest.templateId !== 'reverse-cash-and-carry-v1') {
    fail(`lane ${laneId} template manifest is not a Testnet reverse cash-and-carry market`);
  }
  if (!Array.isArray(input.activeRegistryRecords) || input.activeRegistryRecords.length === 0
    || !Array.isArray(input.resourceLimits) || input.resourceLimits.length === 0
    || !Array.isArray(input.adapterSupport) || input.adapterSupport.length === 0
    || !Array.isArray(input.adapters) || input.adapters.length !== 3) fail(`lane ${laneId} collections are incomplete`);
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
  const baseAsset = asset(input.baseAsset, 'lane.baseAsset');
  const quoteAsset = asset(input.quoteAsset, 'lane.quoteAsset');
  const lending = leg(input.lending, 'lane.lending');
  const spot = leg(input.spot, 'lane.spot');
  const hedge = leg(input.hedge, 'lane.hedge');
  const borrowCollateralRatioBps = positive(input.borrowCollateralRatioBps, 'lane.borrowCollateralRatioBps');
  const annualBorrowRatePpm = natural(input.annualBorrowRatePpm, 'lane.annualBorrowRatePpm');
  if (borrowCollateralRatioBps < MAX_BPS || borrowCollateralRatioBps > 100_000n) {
    fail('lane.borrowCollateralRatioBps must be between 10000 and 100000');
  }
  if (annualBorrowRatePpm > MAX_PPM) fail('lane.annualBorrowRatePpm exceeds 1000000');
  const pricing = Object.freeze({
    chainId,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: contract(input.baseToken, 'lane.baseToken'),
    quoteToken: contract(input.quoteToken, 'lane.quoteToken'),
    spotFactory: contract(input.spotFactory, 'lane.spotFactory'),
    spotPool: contract(input.spotPool, 'lane.spotPool'),
    spotQuoter: contract(input.spotQuoter, 'lane.spotQuoter'),
    spotPoolFee: integer(input.spotPoolFee, 'lane.spotPoolFee'),
    lendingPool: contract(input.lendingPool, 'lane.lendingPool'),
    oracle: contract(input.oracle, 'lane.oracle'),
    perpetualMarket: contract(input.perpetualMarket, 'lane.perpetualMarket'),
    lending,
    spot,
    hedge,
    minimumPostHealthFactor: positive(input.minimumPostHealthFactor, 'lane.minimumPostHealthFactor'),
    borrowCollateralRatioBps,
    annualBorrowRatePpm,
    holdingDurationSeconds: positive(input.holdingDurationSeconds, 'lane.holdingDurationSeconds'),
    protocolFeeBps: nonnegativeInteger(input.protocolFeeBps, 'lane.protocolFeeBps'),
    solverFeeBps: nonnegativeInteger(input.solverFeeBps, 'lane.solverFeeBps'),
    networkFeeQuoteAtoms: natural(input.networkFeeQuoteAtoms, 'lane.networkFeeQuoteAtoms'),
    feePolicyVersion: integer(input.feePolicyVersion, 'lane.feePolicyVersion'),
    feePolicyManifestHash: input.feePolicyManifestHash as Uint8Array | string,
    routeTtlSeconds: positive(input.routeTtlSeconds, 'lane.routeTtlSeconds'),
    quoteTtlSeconds: positive(input.quoteTtlSeconds, 'lane.quoteTtlSeconds'),
    chain,
    nonceSource: nonceSource(laneId),
  });
  const adapterFactories = input.adapters.map((value, index) => {
    const item = record(value, `lane.adapters[${index}]`);
    if (item.role !== 'base-borrow' && item.role !== 'spot-sale' && item.role !== 'perp-purchase') {
      fail(`lane.adapters[${index}].role is invalid`);
    }
    return Object.freeze({
      role: item.role,
      factory: contract(item.factory, `lane.adapters[${index}].factory`),
      expectedAdapterCodeHash: hash(item.expectedAdapterCodeHash, `lane.adapters[${index}].expectedAdapterCodeHash`),
      maximumGasLimit: positive(item.maximumGasLimit, `lane.adapters[${index}].maximumGasLimit`),
    });
  });
  if (new Set(adapterFactories.map((item) => item.role)).size !== 3) fail(`lane ${laneId} adapter roles repeat`);
  const debtTolerance = natural(input.debtBaseToleranceBps, 'lane.debtBaseToleranceBps');
  if (debtTolerance > 1_000n) fail('lane.debtBaseToleranceBps exceeds 10 percent');
  const preparation: EvmReverseBasisPreparationLane = Object.freeze({
    environment: 'testnet',
    templateManifest,
    activeRegistryRecords,
    resourceLimits,
    pricing,
    accountFactory: contract(input.accountFactory, 'lane.accountFactory'),
    expectedStrategyAccountCodeHash: hash(input.expectedStrategyAccountCodeHash, 'lane.expectedStrategyAccountCodeHash'),
    adapters: Object.freeze(adapterFactories) as EvmReverseBasisPreparationLane['adapters'],
    debtBaseAtomsPerWholeBaseToken: positive(input.debtBaseAtomsPerWholeBaseToken, 'lane.debtBaseAtomsPerWholeBaseToken'),
    debtBaseToleranceBps: debtTolerance,
    solver: getAddress(string(input.solver, 'lane.solver')),
    packageIds,
  });
  return Object.freeze({
    preparation,
    quote: Object.freeze({
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
      pricing: createEvmReverseBasisGeneralizedPricing(pricing),
      currentTime: async () => Object.freeze({ unit: 'EVM_UNIX_SECONDS' as const, value: await chain.latestBlockTimestamp() }),
    }),
  });
}

export function loadEvmReverseBasisRuntime(
  path: string,
  dependencies: Readonly<{
    nonceSource: (laneId: string) => EvmOptionSpreadQuoteNonceSource;
    packageIds: EvmOptionSpreadPackageIdPort;
  }>,
): Readonly<{
  quoteLanes: readonly GeneralizedStrategyQuoteLane[];
  preparationLanes: readonly EvmReverseBasisPreparationLane[];
  observationLanes: readonly EvmStrategyObservationLane[];
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

export function createEvmReverseBasisPreparationResolver(lanes: readonly EvmReverseBasisPreparationLane[]) {
  return new EvmReverseBasisPreparationContextResolver(lanes);
}

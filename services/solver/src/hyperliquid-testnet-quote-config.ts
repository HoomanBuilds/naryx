import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  adapterRef,
  assetRef,
  bytesEqual,
  domainRef,
  manifestHash,
  packageTemplateManifestHash,
  parseProtocolJson,
  versionedManifestRef,
  type AdapterRefInput,
  type AssetRef,
  type DomainRef,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import {
  HyperliquidSdkTestnetMarketReadClient,
  type HyperliquidTestnetGeneralizedMarketReadPort,
  type HyperliquidTestnetQuoteMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';
import {
  createHyperliquidTestnetGeneralizedCashCarryPricing,
  createHyperliquidTestnetGeneralizedDeltaRebalancePricing,
  createHyperliquidTestnetGeneralizedFundingSpreadPricing,
  createHyperliquidTestnetGeneralizedHedgeMigrationPricing,
  createHyperliquidTestnetGeneralizedTreasuryHedgePricing,
  createHyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteRuntimeInput,
} from './hyperliquid-testnet-quote-runtime.js';
import type { HyperliquidStrategyPreparationLane } from './hyperliquid-strategy-preparation.js';
import type { GeneralizedStrategyQuoteLane } from './strategy-quote-context-registry.js';

export const HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV =
  'NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED';
export const HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED_ENV =
  'NARYX_HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED';
export const HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_CONFIGS_ENV =
  'NARYX_HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_CONFIGS';
export const HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION = 2;

const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface HyperliquidTestnetQuoteConfigDependencies {
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly market?: HyperliquidTestnetQuoteMarketReadPort;
  readonly currentTimeMs?: () => bigint;
}

export interface HyperliquidTestnetGeneralizedQuoteConfigDependencies {
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly market?: HyperliquidTestnetGeneralizedMarketReadPort;
  readonly currentTimeMs?: () => bigint;
}

type QuoteLegInput = Readonly<Record<string, unknown> & {
  adapter: AdapterRefInput;
  venue: VersionedManifestRef;
  market: VersionedManifestRef;
  action: Readonly<Record<string, unknown> & { adapter: AdapterRefInput }>;
}>;

type GeneralizedLaneSettings = Readonly<{
  laneId: string;
  executionClassId: string;
  executionClassVersion: number;
  executionClassManifestHash: Uint8Array;
  holdingDurationMs: bigint;
  expectedExitBasisBps: bigint;
  reversalThresholdPpm: bigint;
}>;

// Reviewed configs carry manifest hashes as plain or 0x-prefixed hex, or bytes; the runtime compares
// exact bytes, so every identity reference is normalized here and a malformed one is named.
function normalizedMarket(market: Record<string, unknown>): Record<string, unknown> {
  const field = <T>(name: string, read: () => T): T => {
    try {
      return read();
    } catch {
      throw new Error(`Hyperliquid Testnet quote config market.${name} is missing or malformed`);
    }
  };
  const asset = (name: string) => field(name, () => {
    const value = market[name] as AssetRef;
    return assetRef(value.assetId, value.assetManifestHash, value.decimals);
  });
  const reference = (name: string, value: VersionedManifestRef) =>
    field(name, () => versionedManifestRef(value.subjectId, value.manifestVersion, value.manifestHash));
  const leg = (name: 'spot' | 'perpetual' | 'counterPerpetual') => {
    const value = field(name, () => {
      const candidate = market[name] as QuoteLegInput;
      if (typeof candidate !== 'object' || candidate === null) throw new Error('missing');
      return candidate;
    });
    return {
      ...value,
      adapter: field(`${name}.adapter`, () => adapterRef(value.adapter)),
      venue: reference(`${name}.venue`, value.venue),
      market: reference(`${name}.market`, value.market),
      action: { ...value.action, adapter: field(`${name}.action.adapter`, () => adapterRef(value.action.adapter)) },
    };
  };
  const counterPerpetual = market.counterPerpetual === undefined
    ? undefined
    : leg('counterPerpetual');
  return {
    ...market,
    domain: field('domain', () => {
      const domain = market.domain as DomainRef;
      return domainRef(domain.domainId, domain.domainManifestVersion, domain.domainManifestHash);
    }),
    baseAsset: asset('baseAsset'),
    quoteAsset: asset('quoteAsset'),
    spot: leg('spot'),
    perpetual: leg('perpetual'),
    ...(counterPerpetual === undefined ? {} : { counterPerpetual }),
  };
}

function enabled(value: string | undefined, name = HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = required(env, name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

function signedInteger(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = required(env, name);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be an integer`);
  return BigInt(value);
}

function embeddedGeneralizedLane(value: unknown): GeneralizedLaneSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Hyperliquid Testnet quote config generalized lane must be an object');
  }
  const lane = value as Record<string, unknown>;
  const keys = [
    'laneId', 'executionClassId', 'executionClassVersion', 'executionClassManifestHash',
    'holdingDurationMs', 'expectedExitBasisBps', 'reversalThresholdPpm',
  ];
  if (Object.keys(lane).sort().join(',') !== [...keys].sort().join(',')
    || typeof lane.laneId !== 'string' || lane.laneId.length === 0
    || typeof lane.executionClassId !== 'string' || lane.executionClassId.length === 0
    || !Number.isSafeInteger(lane.executionClassVersion) || (lane.executionClassVersion as number) < 1
    || typeof lane.holdingDurationMs !== 'bigint' || lane.holdingDurationMs <= 0n
    || typeof lane.expectedExitBasisBps !== 'bigint'
    || typeof lane.reversalThresholdPpm !== 'bigint' || lane.reversalThresholdPpm <= 0n) {
    throw new Error('Hyperliquid Testnet quote config generalized lane fields are invalid');
  }
  return Object.freeze({
    laneId: lane.laneId,
    executionClassId: lane.executionClassId,
    executionClassVersion: lane.executionClassVersion as number,
    executionClassManifestHash: manifestHash(
      lane.executionClassManifestHash as Uint8Array,
      'hyperliquidTestnetQuoteConfig.generalized.executionClassManifestHash',
    ),
    holdingDurationMs: lane.holdingDurationMs,
    expectedExitBasisBps: lane.expectedExitBasisBps,
    reversalThresholdPpm: lane.reversalThresholdPpm,
  });
}

function quoteConfiguration(env: NodeJS.ProcessEnv): Readonly<{
  market: Record<string, unknown>;
  tradingAccount: `0x${string}`;
  generalized?: GeneralizedLaneSettings;
}> {
  const configuredPath = env.NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG;
  if (configuredPath === undefined || configuredPath.length === 0 || !isAbsolute(configuredPath)) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG must be an absolute path');
  }
  const tradingAccount = env.NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT;
  if (tradingAccount === undefined || !ADDRESS.test(tradingAccount)) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT must be a lowercase 20-byte address');
  }
  const decoded = parseProtocolJson(
    readFileSync(resolve(configuredPath), 'utf8'),
    'hyperliquidTestnetQuoteConfig',
  );
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Hyperliquid Testnet quote config must be an object');
  }
  const record = decoded as Record<string, unknown>;
  if (record.version !== HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION
    || typeof record.market !== 'object' || record.market === null
    || Array.isArray(record.market)) {
    throw new Error(
      `Hyperliquid Testnet quote config must contain version ${HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION} market configuration`,
    );
  }
  const generalized = embeddedGeneralizedLane(record.generalized);
  return Object.freeze({
    market: normalizedMarket(record.market as Record<string, unknown>),
    tradingAccount: tradingAccount as `0x${string}`,
    ...(generalized === undefined ? {} : { generalized }),
  });
}

function generalizedLaneSettings(
  env: NodeJS.ProcessEnv,
  embedded: GeneralizedLaneSettings | undefined,
): GeneralizedLaneSettings {
  if (embedded !== undefined) return embedded;
  const executionClassVersionValue = positiveInteger(
    env,
    'NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_VERSION',
  );
  if (executionClassVersionValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_VERSION is too large');
  }
  return Object.freeze({
    laneId: required(env, 'NARYX_HYPERLIQUID_GENERALIZED_LANE_ID'),
    executionClassId: required(env, 'NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_ID'),
    executionClassVersion: Number(executionClassVersionValue),
    executionClassManifestHash: manifestHash(required(
      env,
      'NARYX_HYPERLIQUID_GENERALIZED_EXECUTION_CLASS_MANIFEST_HASH',
    )),
    holdingDurationMs: positiveInteger(env, 'NARYX_HYPERLIQUID_GENERALIZED_HOLDING_DURATION_MS'),
    expectedExitBasisBps: signedInteger(env, 'NARYX_HYPERLIQUID_GENERALIZED_EXPECTED_EXIT_BASIS_BPS'),
    reversalThresholdPpm: env.NARYX_HYPERLIQUID_GENERALIZED_REVERSAL_THRESHOLD_PPM === undefined
      ? 1n
      : positiveInteger(env, 'NARYX_HYPERLIQUID_GENERALIZED_REVERSAL_THRESHOLD_PPM'),
  });
}

export function loadHyperliquidTestnetQuoteRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: HyperliquidTestnetQuoteConfigDependencies,
): HyperliquidTestnetQuoteRuntime | undefined {
  if (!enabled(env[HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV])) return undefined;
  const { market, tradingAccount } = quoteConfiguration(env);
  return createHyperliquidTestnetQuoteRuntime({
    ...(market as Omit<
      HyperliquidTestnetQuoteRuntimeInput,
      'enabled' | 'currentTimeMs' | 'nonceSource' | 'market' | 'tradingAccount'
    >),
    enabled: true,
    tradingAccount: tradingAccount as `0x${string}`,
    market: dependencies.market ?? new HyperliquidSdkTestnetMarketReadClient(),
    currentTimeMs: dependencies.currentTimeMs ?? (() => BigInt(Date.now())),
    nonceSource: dependencies.nonceSource,
  });
}

export function loadHyperliquidTestnetGeneralizedQuoteLane(
  env: NodeJS.ProcessEnv,
  preparationLanes: readonly HyperliquidStrategyPreparationLane[],
  dependencies: HyperliquidTestnetGeneralizedQuoteConfigDependencies,
): GeneralizedStrategyQuoteLane | undefined {
  if (!enabled(
    env[HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED_ENV],
    HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED_ENV,
  )) return undefined;
  const { market, tradingAccount, generalized } = quoteConfiguration(env);
  const configured = market as unknown as Omit<
    HyperliquidTestnetQuoteRuntimeInput,
    'enabled' | 'currentTimeMs' | 'nonceSource' | 'market' | 'tradingAccount'
  >;
  const matchingLanes = preparationLanes.filter((lane) =>
    lane.environment === 'testnet'
    && lane.templateManifest.templateId === configured.templateId
    && lane.templateManifest.templateVersion === configured.templateVersion
    && bytesEqual(
      packageTemplateManifestHash(lane.templateManifest),
      manifestHash(configured.packageTemplateManifestHash),
    )
    && lane.domain.domainId === configured.domain.domainId
    && lane.domain.domainManifestVersion === configured.domain.domainManifestVersion
    && bytesEqual(lane.domain.domainManifestHash, configured.domain.domainManifestHash));
  if (matchingLanes.length !== 1) {
    throw new Error('generalized Hyperliquid quote config must match exactly one preparation lane');
  }
  if (configured.templateId !== 'cash-and-carry-v1'
    && configured.templateId !== 'treasury-inventory-hedge-v1'
    && configured.templateId !== 'perpetual-funding-spread-v1'
    && configured.templateId !== 'hedge-migration-v1'
    && configured.templateId !== 'delta-neutral-rebalance-v1') {
    throw new Error('generalized Hyperliquid quote lane does not support the configured template');
  }
  const laneSettings = generalizedLaneSettings(env, generalized);
  const clock = dependencies.currentTimeMs ?? (() => BigInt(Date.now()));
  const liveMarket = dependencies.market ?? new HyperliquidSdkTestnetMarketReadClient();
  const commonPricing = {
    domain: configured.domain,
    baseAsset: configured.baseAsset,
    quoteAsset: configured.quoteAsset,
    tradingAccount,
    market: liveMarket,
    maxBookAgeMs: configured.maxBookAgeMs,
    maxBookSpreadBps: configured.maxBookSpreadBps,
    marginBps: configured.marginBps,
    routeTtlMs: configured.routeTtlMs,
    quoteTtlMs: configured.quoteTtlMs,
    feePolicyVersion: configured.feePolicyVersion,
    feePolicyManifestHash: configured.feePolicyManifestHash,
    nonceSource: dependencies.nonceSource,
    perpetual: configured.perpetual,
  } as const;
  const cashCarry = configured.templateId === 'cash-and-carry-v1';
  const fundingSpread = configured.templateId === 'perpetual-funding-spread-v1';
  const hedgeMigration = configured.templateId === 'hedge-migration-v1';
  const deltaRebalance = configured.templateId === 'delta-neutral-rebalance-v1';
  const counterPerpetual = (configured as typeof configured & Readonly<{
    counterPerpetual?: typeof configured.perpetual;
  }>).counterPerpetual;
  if ((fundingSpread || hedgeMigration) && counterPerpetual === undefined) {
    throw new Error('generalized Hyperliquid two-market quote config requires counterPerpetual');
  }
  return Object.freeze({
    laneId: laneSettings.laneId,
    environment: matchingLanes[0]!.environment,
    templateManifest: matchingLanes[0]!.templateManifest,
    executionClassId: laneSettings.executionClassId,
    executionClassVersion: laneSettings.executionClassVersion,
    executionClassManifestHash: laneSettings.executionClassManifestHash,
    activeRegistryRecords: matchingLanes[0]!.activeRegistryRecords,
    resourceLimits: matchingLanes[0]!.resourceLimits,
    adapterSupport: cashCarry
      ? Object.freeze([Object.freeze({
        domain: configured.domain,
        adapter: configured.spot.adapter,
        legFamily: 'SPOT_SWAP' as const,
        supportedSides: Object.freeze(['BUY' as const]),
        materializationClassId: 'hypercore-spot-ioc-v1',
        executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
        supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
      }), Object.freeze({
        domain: configured.domain,
        adapter: configured.perpetual.adapter,
        legFamily: 'PERP_OPEN' as const,
        supportedSides: Object.freeze(['SELL' as const]),
        materializationClassId: 'hypercore-perpetual-ioc-v1',
        executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
        supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
      })])
      : fundingSpread
        ? Object.freeze([Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_OPEN' as const,
          supportedSides: Object.freeze(['BUY' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: counterPerpetual!.adapter,
          legFamily: 'PERP_OPEN' as const,
          supportedSides: Object.freeze(['SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_CLOSE' as const,
          supportedSides: Object.freeze(['SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: counterPerpetual!.adapter,
          legFamily: 'PERP_CLOSE' as const,
          supportedSides: Object.freeze(['BUY' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_INCREASE' as const,
          supportedSides: Object.freeze(['BUY' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: counterPerpetual!.adapter,
          legFamily: 'PERP_INCREASE' as const,
          supportedSides: Object.freeze(['SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_DECREASE' as const,
          supportedSides: Object.freeze(['SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: counterPerpetual!.adapter,
          legFamily: 'PERP_DECREASE' as const,
          supportedSides: Object.freeze(['BUY' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        })])
        : hedgeMigration
          ? Object.freeze([Object.freeze({
            domain: configured.domain,
            adapter: configured.perpetual.adapter,
            legFamily: 'PERP_CLOSE' as const,
            supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
            materializationClassId: 'hypercore-perpetual-ioc-v1',
            executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
            supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
          }), Object.freeze({
            domain: configured.domain,
            adapter: counterPerpetual!.adapter,
            legFamily: 'PERP_OPEN' as const,
            supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
            materializationClassId: 'hypercore-perpetual-ioc-v1',
            executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
            supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
          })])
          : deltaRebalance
            ? Object.freeze([Object.freeze({
              domain: configured.domain,
              adapter: configured.perpetual.adapter,
              legFamily: 'PERP_INCREASE' as const,
              supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
              materializationClassId: 'hypercore-perpetual-ioc-v1',
              executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
              supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
            }), Object.freeze({
              domain: configured.domain,
              adapter: configured.perpetual.adapter,
              legFamily: 'PERP_DECREASE' as const,
              supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
              materializationClassId: 'hypercore-perpetual-ioc-v1',
              executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
              supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
            })])
          : Object.freeze([Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_OPEN' as const,
          supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_CLOSE' as const,
          supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_INCREASE' as const,
          supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        }), Object.freeze({
          domain: configured.domain,
          adapter: configured.perpetual.adapter,
          legFamily: 'PERP_DECREASE' as const,
          supportedSides: Object.freeze(['BUY' as const, 'SELL' as const]),
          materializationClassId: 'hypercore-perpetual-ioc-v1',
          executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
          supportedSettlementClasses: Object.freeze(['BATCHED_IOC_WITH_RECOVERY' as const]),
        })]),
    solverId: configured.solverId,
    solverCapabilityManifestHash: configured.solverCapabilityManifestHash,
    pricing: cashCarry
      ? createHyperliquidTestnetGeneralizedCashCarryPricing({
        ...commonPricing,
        holdingDurationMs: laneSettings.holdingDurationMs,
        expectedExitBasisBps: laneSettings.expectedExitBasisBps,
        spot: configured.spot,
      })
      : fundingSpread
        ? createHyperliquidTestnetGeneralizedFundingSpreadPricing({
          ...commonPricing,
          expectedHoldingDurationMs: laneSettings.holdingDurationMs,
          reversalThresholdPpm: laneSettings.reversalThresholdPpm,
          longPerpetual: configured.perpetual,
          shortPerpetual: counterPerpetual!,
        })
        : hedgeMigration
          ? createHyperliquidTestnetGeneralizedHedgeMigrationPricing({
            ...commonPricing,
            sourcePerpetual: configured.perpetual,
            destinationPerpetual: counterPerpetual!,
          })
          : deltaRebalance
            ? createHyperliquidTestnetGeneralizedDeltaRebalancePricing(commonPricing)
          : createHyperliquidTestnetGeneralizedTreasuryHedgePricing(commonPricing),
    currentTime: async () => Object.freeze({
      unit: 'HYPERLIQUID_UNIX_MILLISECONDS' as const,
      value: clock(),
    }),
  });
}

export function loadHyperliquidTestnetGeneralizedQuoteLanes(
  env: NodeJS.ProcessEnv,
  preparationLanes: readonly HyperliquidStrategyPreparationLane[],
  dependencies: HyperliquidTestnetGeneralizedQuoteConfigDependencies,
): readonly GeneralizedStrategyQuoteLane[] {
  if (!enabled(
    env[HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED_ENV],
    HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_ENABLED_ENV,
  )) return Object.freeze([]);
  const configured = env[HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_CONFIGS_ENV];
  if (configured === undefined || configured.trim() === '') {
    const lane = loadHyperliquidTestnetGeneralizedQuoteLane(env, preparationLanes, dependencies);
    return Object.freeze(lane === undefined ? [] : [lane]);
  }
  const paths = configured.split(',').map((value) => value.trim()).filter((value) => value !== '');
  if (paths.length === 0 || paths.length > 16 || new Set(paths).size !== paths.length
    || paths.some((path) => !isAbsolute(path))) {
    throw new Error(`${HYPERLIQUID_TESTNET_GENERALIZED_QUOTE_CONFIGS_ENV} must contain one to sixteen unique absolute paths`);
  }
  const lanes = paths.map((path) => {
    const scoped = { ...env, NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG: path };
    if (quoteConfiguration(scoped).generalized === undefined) {
      throw new Error('every generalized quote config in the multi-lane list must contain generalized settings');
    }
    const lane = loadHyperliquidTestnetGeneralizedQuoteLane(scoped, preparationLanes, dependencies);
    if (lane === undefined) throw new Error('configured generalized quote lane did not load');
    return lane;
  });
  if (new Set(lanes.map((lane) => lane.laneId)).size !== lanes.length) {
    throw new Error('generalized Hyperliquid quote lane IDs must be unique');
  }
  return Object.freeze(lanes);
}

export const loadHyperliquidTestnetGeneralizedCashCarryQuoteLane =
  loadHyperliquidTestnetGeneralizedQuoteLane;

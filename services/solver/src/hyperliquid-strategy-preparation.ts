import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  bytesEqual,
  domainRef,
  packageTemplateManifest,
  packageTemplateManifestHash,
  parseProtocolJson,
  strategyPackageOrderHash,
  type DomainRef,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type PackageTemplateManifest,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import type { HyperliquidStrategyMarketBindingInput } from '@naryx/adapter-hyperliquid';
import { createHyperliquidStrategyDomainCompiler } from './strategy-domain-compilers.js';
import type {
  StoredStrategyPackageDocuments,
} from './http-strategy-package-provider.js';
import type {
  StrategyPreparationContext,
  StrategyPreparationContextResolver,
} from './strategy-preparation-service.js';

const MAX_CONFIG_BYTES = 1_048_576;

export interface HyperliquidStrategyPreparationLane {
  readonly environment: string;
  readonly domain: DomainRef;
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly marketBindings: readonly HyperliquidStrategyMarketBindingInput[];
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} fields are invalid`);
  }
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

export function loadHyperliquidStrategyPreparationLane(path: string): HyperliquidStrategyPreparationLane {
  if (!isAbsolute(path)) throw new Error('Hyperliquid strategy preparation config path must be absolute');
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) throw new Error('Hyperliquid strategy preparation config is too large');
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
  } catch {
    throw new Error('Hyperliquid strategy preparation config is not valid protocol JSON');
  }
  const root = object(parsed, 'Hyperliquid strategy preparation config');
  exactKeys(root, ['version', 'environment', 'domain', 'templateManifest', 'activeRegistryRecords', 'resourceLimits', 'marketBindings'], 'Hyperliquid strategy preparation config');
  if (root.version !== 1 || typeof root.environment !== 'string' || root.environment.length === 0
    || root.environment.toLowerCase().includes('mainnet')) {
    throw new Error('Hyperliquid strategy preparation config must name a non-mainnet version 1 environment');
  }
  if (!Array.isArray(root.activeRegistryRecords) || !Array.isArray(root.resourceLimits)
    || root.resourceLimits.length === 0 || !Array.isArray(root.marketBindings) || root.marketBindings.length === 0) {
    throw new Error('Hyperliquid strategy preparation config requires registry records, resource limits, and market bindings');
  }
  const rawDomain = object(root.domain, 'Hyperliquid strategy preparation domain') as unknown as DomainRef;
  const domain = domainRef(rawDomain.domainId, rawDomain.domainManifestVersion, rawDomain.domainManifestHash);
  if (domain.domainId !== 'hypercore:testnet') throw new Error('Hyperliquid strategy preparation is pinned to HyperCore Testnet');
  const templateManifest = packageTemplateManifest(root.templateManifest as PackageTemplateManifestInput);
  if (templateManifest.environment !== root.environment) throw new Error('Hyperliquid strategy preparation template environment mismatch');
  const marketBindings = root.marketBindings as readonly HyperliquidStrategyMarketBindingInput[];
  createHyperliquidStrategyDomainCompiler({ domain, bindings: marketBindings });
  return Object.freeze({
    environment: root.environment,
    domain,
    templateManifest,
    activeRegistryRecords: Object.freeze(root.activeRegistryRecords as DomainRegistryRecordInput[]),
    resourceLimits: Object.freeze(root.resourceLimits as DomainResourceLimit[]),
    marketBindings: Object.freeze([...marketBindings]),
  });
}

export class HyperliquidStrategyPreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly HyperliquidStrategyPreparationLane[];
  readonly #clockMs: () => number;

  constructor(lanes: readonly HyperliquidStrategyPreparationLane[], clockMs: () => number = Date.now) {
    if (lanes.length === 0) throw new Error('Hyperliquid strategy preparation requires at least one lane');
    this.#lanes = Object.freeze([...lanes]);
    this.#clockMs = clockMs;
  }

  async resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext> {
    const matches = this.#lanes.filter((lane) =>
      lane.environment === documents.order.environment
      && lane.templateManifest.templateId === documents.order.templateId
      && lane.templateManifest.templateVersion === documents.order.templateVersion
      && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
      && documents.route.domainPlans.length === 1
      && documents.route.domainPlans[0]!.executionPlanKind === 'HYPERCORE_BATCHED_IOC'
      && sameDomain(lane.domain, documents.route.domainPlans[0]!.domain));
    if (matches.length !== 1) throw new Error('strategy package must resolve to exactly one Hyperliquid preparation lane');
    const lane = matches[0]!;
    if (documents.order.expiryUnit !== 'HYPERLIQUID_UNIX_MILLISECONDS'
      || documents.order.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY') {
      throw new Error('Hyperliquid strategy preparation requires batched IOC settlement with millisecond expiry');
    }
    const now = this.#clockMs();
    if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Hyperliquid strategy preparation clock is invalid');
    return Object.freeze({
      compileContext: Object.freeze({
        templateManifest: lane.templateManifest,
        activeRegistryRecords: lane.activeRegistryRecords,
        resourceLimits: lane.resourceLimits,
        currentTime: Object.freeze({ unit: 'HYPERLIQUID_UNIX_MILLISECONDS' as const, value: BigInt(now) }),
      }),
      identity: Object.freeze({
        packageId: strategyPackageOrderHash(documents.order),
        templateId: documents.order.templateId,
        templateVersion: documents.order.templateVersion,
        templateManifestHash: documents.order.packageTemplateManifestHash,
        operation: documents.order.lifecycleAction,
      }),
      compilers: Object.freeze([createHyperliquidStrategyDomainCompiler({ domain: lane.domain, bindings: lane.marketBindings })]),
      bindings: Object.freeze([{ kind: 'HYPERCORE_EXECUTOR' as const, domain: lane.domain }]),
    });
  }
}

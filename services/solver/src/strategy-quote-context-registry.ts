import {
  bytesEqual,
  manifestHash,
  packageTemplateManifest,
  packageTemplateManifestHash,
  protocolId,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type ExpiryUnit,
  type PackageTemplateManifestInput,
  type TypedAdapterActionSupportInput,
} from '@naryx/protocol-types';
import type { StoredStrategyPackageOrderDocuments } from './http-strategy-package-provider.js';
import type {
  GeneralizedStrategyPricingPort,
  GeneralizedStrategyQuoteContext,
  GeneralizedStrategyQuoteContextResolver,
} from './strategy-quote-service.js';

export interface GeneralizedStrategyQuoteLane {
  readonly laneId: string;
  readonly environment: string;
  readonly templateManifest: PackageTemplateManifestInput;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly adapterSupport: readonly TypedAdapterActionSupportInput[];
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly pricing: GeneralizedStrategyPricingPort;
  readonly currentTime: () => Promise<Readonly<{ unit: ExpiryUnit; value: bigint }>>;
}

interface CheckedLane extends Omit<GeneralizedStrategyQuoteLane, 'templateManifest' | 'executionClassManifestHash' | 'solverCapabilityManifestHash'> {
  readonly templateManifest: ReturnType<typeof packageTemplateManifest>;
  readonly executionClassManifestHash: Uint8Array;
  readonly solverCapabilityManifestHash: Uint8Array;
}

function checkedLane(input: GeneralizedStrategyQuoteLane): CheckedLane {
  const laneId = protocolId(input.laneId, 'strategyQuoteLane.laneId');
  const environment = protocolId(input.environment, 'strategyQuoteLane.environment');
  const templateManifest = packageTemplateManifest(input.templateManifest, 'strategyQuoteLane.templateManifest');
  const executionClassId = protocolId(input.executionClassId, 'strategyQuoteLane.executionClassId');
  const solverId = protocolId(input.solverId, 'strategyQuoteLane.solverId');
  if (templateManifest.environment !== environment
    || !Number.isSafeInteger(input.executionClassVersion) || input.executionClassVersion <= 0
    || input.activeRegistryRecords.length === 0 || input.resourceLimits.length === 0
    || input.adapterSupport.length === 0 || typeof input.pricing?.quote !== 'function'
    || typeof input.currentTime !== 'function') {
    throw new Error(`generalized strategy quote lane ${laneId} is incomplete`);
  }
  return Object.freeze({
    ...input,
    laneId,
    environment,
    templateManifest,
    executionClassId,
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, 'strategyQuoteLane.executionClassManifestHash'),
    solverId,
    solverCapabilityManifestHash: manifestHash(input.solverCapabilityManifestHash, 'strategyQuoteLane.solverCapabilityManifestHash'),
    activeRegistryRecords: Object.freeze([...input.activeRegistryRecords]),
    resourceLimits: Object.freeze([...input.resourceLimits]),
    adapterSupport: Object.freeze([...input.adapterSupport]),
  });
}

function matches(lane: CheckedLane, documents: StoredStrategyPackageOrderDocuments): boolean {
  return lane.environment === documents.order.environment
    && lane.templateManifest.templateId === documents.order.templateId
    && lane.templateManifest.templateVersion === documents.order.templateVersion
    && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
    && lane.executionClassId === documents.order.executionClassId
    && lane.executionClassVersion === documents.order.executionClassVersion
    && bytesEqual(lane.executionClassManifestHash, documents.order.executionClassManifestHash);
}

export class GeneralizedStrategyQuoteContextRegistry implements GeneralizedStrategyQuoteContextResolver {
  readonly #lanes: readonly CheckedLane[];

  constructor(lanes: readonly GeneralizedStrategyQuoteLane[]) {
    if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('at least one generalized strategy quote lane is required');
    const checked = lanes.map(checkedLane);
    const identities = new Set<string>();
    for (const lane of checked) {
      if (identities.has(lane.laneId)) throw new Error(`generalized strategy quote lane ${lane.laneId} is duplicated`);
      identities.add(lane.laneId);
    }
    this.#lanes = Object.freeze(checked);
  }

  async resolve(documents: StoredStrategyPackageOrderDocuments): Promise<GeneralizedStrategyQuoteContext> {
    const candidates = this.#lanes.filter((lane) => matches(lane, documents));
    if (candidates.length !== 1) {
      throw new Error(candidates.length === 0
        ? 'no generalized strategy quote lane supports the committed package'
        : 'multiple generalized strategy quote lanes match the committed package');
    }
    const lane = candidates[0]!;
    const currentTime = await lane.currentTime();
    if (currentTime.unit !== documents.graph.expiryUnit || typeof currentTime.value !== 'bigint' || currentTime.value <= 0n) {
      throw new Error(`generalized strategy quote lane ${lane.laneId} returned an invalid clock`);
    }
    return Object.freeze({
      compileContext: Object.freeze({
        templateManifest: lane.templateManifest,
        activeRegistryRecords: lane.activeRegistryRecords,
        resourceLimits: lane.resourceLimits,
        currentTime,
      }),
      adapterSupport: lane.adapterSupport,
      solverId: lane.solverId,
      solverCapabilityManifestHash: lane.solverCapabilityManifestHash,
      pricing: lane.pricing,
    });
  }
}

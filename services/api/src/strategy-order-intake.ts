import {
  bytesEqual,
  packageGraph,
  strategyPackageOrderHash,
  toHex,
  validateStrategyPackageOrderGraph,
  type DomainRef,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type PackageGraphInput,
  type PackageTemplateManifestInput,
  type StrategyPackageOrderInput,
} from "@naryx/protocol-types";
import type { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import type { SqliteRegistryStore } from "./registry-store.js";
import type { SqliteStrategyPackageStore } from "./strategy-package-store.js";

export type StrategyOrderIntakeResult = Readonly<{
  version: 1;
  status: "STORED_FOR_QUOTING";
  created: boolean;
  orderHashHex: string;
  graphHashHex: string;
  currentTime: Readonly<{ unit: string; value: bigint }>;
  timeSource: "SERVER" | "CALLER";
  stages: readonly unknown[];
}>;

export class StrategyOrderIntakeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StrategyOrderIntakeError";
    this.status = status;
    this.code = code;
  }
}

export interface StrategyOrderIntakePort {
  store(
    order: StrategyPackageOrderInput,
    graph: PackageGraphInput,
    atSlot?: bigint,
  ): StrategyOrderIntakeResult;
}

type Exchange = Pick<
  SqlitePackageExchangeStore,
  "getSeriesRecord" | "getExecutionClassRecord"
>;
type Registry = Pick<SqliteRegistryStore, "latest">;
type Store = Pick<SqliteStrategyPackageStore, "registerOrder">;

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function requireStrategyMarket(exchange: Exchange, input: PackageGraphInput) {
  const graph = packageGraph(input);
  const series = exchange.getSeriesRecord(graph.seriesId, graph.seriesVersion);
  if (series === undefined || series.documentHashHex !== toHex(graph.seriesManifestHash)) {
    throw new StrategyOrderIntakeError(404, "SERIES_NOT_FOUND", "The graph binds no registered strategy series.");
  }
  if (series.document.templateId !== graph.templateId
    || series.document.templateVersion !== graph.templateVersion
    || !bytesEqual(series.document.templateManifestHash, graph.packageTemplateManifestHash)) {
    throw new StrategyOrderIntakeError(400, "SERIES_MISMATCH", "The strategy series does not bind the graph template.");
  }
  const executionClass = exchange.getExecutionClassRecord(
    graph.executionClassId,
    graph.executionClassVersion,
  );
  if (executionClass === undefined
    || executionClass.documentHashHex !== toHex(graph.executionClassManifestHash)) {
    throw new StrategyOrderIntakeError(
      404,
      "EXECUTION_CLASS_NOT_FOUND",
      "The graph binds no registered execution class.",
    );
  }
  if (executionClass.document.seriesId !== graph.seriesId
    || executionClass.document.seriesVersion !== graph.seriesVersion
    || !bytesEqual(executionClass.document.seriesManifestHash, graph.seriesManifestHash)
    || executionClass.document.settlementClass !== graph.settlementClass) {
    throw new StrategyOrderIntakeError(
      400,
      "EXECUTION_CLASS_MISMATCH",
      "The execution class does not bind the graph series and settlement class.",
    );
  }
  const domains = graph.legs.reduce<DomainRef[]>((values, leg) => {
    if (!values.some((domain) => sameDomain(domain, leg.domain))) values.push(leg.domain);
    return values;
  }, []).sort((left, right) => left.domainId.localeCompare(right.domainId));
  if (domains.length !== executionClass.document.domains.length
    || domains.some((domain, index) => {
      const expected = executionClass.document.domains[index];
      return expected === undefined || !sameDomain(domain, expected);
    })) {
    throw new StrategyOrderIntakeError(
      400,
      "EXECUTION_CLASS_MISMATCH",
      "The execution class domains do not match the graph.",
    );
  }
  return series.document;
}

export function createStrategyOrderIntake(input: Readonly<{
  exchange: Exchange;
  registry: Registry;
  graphContext: Readonly<{
    activeRegistryRecords: readonly DomainRegistryRecordInput[];
    resourceLimits: readonly DomainResourceLimit[];
  }>;
  store: Store;
  clockMs?: () => number;
}>): StrategyOrderIntakePort {
  const clockMs = input.clockMs ?? Date.now;
  return Object.freeze({
    store(
      orderInput: StrategyPackageOrderInput,
      graphInput: PackageGraphInput,
      atSlot?: bigint,
    ): StrategyOrderIntakeResult {
      const graph = packageGraph(graphInput);
      const series = requireStrategyMarket(input.exchange, graph);
      const template = input.registry.latest<PackageTemplateManifestInput>(
        "PACKAGE_TEMPLATE",
        graph.templateId,
        graph.templateVersion,
      );
      if (template === undefined) {
        throw new StrategyOrderIntakeError(404, "TEMPLATE_NOT_FOUND", "The graph binds no registered package template.");
      }
      const serverTime = graph.expiryUnit === "EVM_UNIX_SECONDS"
        ? BigInt(Math.floor(clockMs() / 1_000))
        : graph.expiryUnit === "HYPERLIQUID_UNIX_MILLISECONDS"
          ? BigInt(clockMs())
          : undefined;
      const currentTime = Object.freeze({
        unit: graph.expiryUnit,
        value: serverTime ?? atSlot ?? 0n,
      });
      if (currentTime.value <= 0n) {
        throw new StrategyOrderIntakeError(
          400,
          "TIME_REQUIRED",
          "A slot-timed strategy order is admitted at an explicit positive atSlot.",
        );
      }
      const validated = validateStrategyPackageOrderGraph(orderInput, graph, {
        templateManifest: template.document,
        activeRegistryRecords: input.graphContext.activeRegistryRecords,
        resourceLimits: input.graphContext.resourceLimits,
        currentTime,
      });
      if (validated.order.quoteAsset.assetId !== series.quoteAsset) {
        throw new StrategyOrderIntakeError(
          400,
          "SERIES_MISMATCH",
          "The order quote asset differs from the registered strategy series.",
        );
      }
      const stored = input.store.registerOrder(validated.order, validated.graph);
      if (stored.orderHashHex !== toHex(strategyPackageOrderHash(validated.order))) {
        throw new StrategyOrderIntakeError(500, "STORAGE_MISMATCH", "Stored strategy order identity changed.");
      }
      return Object.freeze({
        version: 1 as const,
        status: "STORED_FOR_QUOTING" as const,
        ...stored,
        currentTime,
        timeSource: serverTime === undefined ? "CALLER" as const : "SERVER" as const,
        stages: validated.compiledGraph.stages,
      });
    },
  });
}

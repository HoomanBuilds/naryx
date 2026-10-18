import {
  applyPackageStateTransition,
  bytesEqual,
  packageGraph,
  packageGraphHash,
  packageReceipt,
  packageReceiptHash,
  packageOrder,
  packageOrderHash,
  cashCarrySeriesBindingV1,
  requiresSuccessfulReceipt,
  strategyCommandHash,
  strategyExecutionMatches,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
  strategyState,
  strategyStateHash,
  toHex,
  type PackageGraph,
  type PackageGraphInput,
  type StrategyCommandInput,
  type StrategyPackageTransitionOperation,
  type StrategyPackageOrder,
  type StrategyPackageReceiptInput,
  type StrategyState,
  type PackageReceiptInput,
  type EconomicStrategySeries,
  type SeriesExecutionClass,
  type PackageOrderInput,
  type CashCarrySeriesBindingV1Input,
} from "@naryx/protocol-types";
import type { BaseAccountReceipt } from "./base-account-receipt.js";

export class StrategyOpenPreparationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StrategyOpenPreparationError";
    this.code = code;
  }
}

function requireCondition(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new StrategyOpenPreparationError(code, message);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function sameIdentity(order: StrategyPackageOrder, graph: PackageGraph): boolean {
  return order.environment === graph.environment
    && order.templateId === graph.templateId
    && order.templateVersion === graph.templateVersion
    && bytesEqual(order.packageTemplateManifestHash, graph.packageTemplateManifestHash)
    && order.seriesId === graph.seriesId
    && order.seriesVersion === graph.seriesVersion
    && bytesEqual(order.seriesManifestHash, graph.seriesManifestHash)
    && order.executionClassId === graph.executionClassId
    && order.executionClassVersion === graph.executionClassVersion
    && bytesEqual(order.executionClassManifestHash, graph.executionClassManifestHash)
    && order.owner === graph.owner
    && order.settlementClass === graph.settlementClass;
}

export interface PreparedStrategyOpen {
  readonly command: StrategyCommandInput;
  readonly commandHashHex: string;
  readonly stateHashHex: string;
  readonly orderHashHex: string;
  readonly receiptHashHex: string;
}

export type PreparedStrategyTransition = PreparedStrategyOpen;

export function prepareBoundCashCarryOpen(input: {
  environment: string; atValue: bigint; receiptHashHex: string; receipt: PackageReceiptInput | BaseAccountReceipt;
  order: PackageOrderInput; binding: CashCarrySeriesBindingV1Input;
  spotInstrument: string; perpInstrument: string; transferable: boolean;
}): PreparedStrategyOpen {
  const receipt = "kind" in input.receipt ? input.receipt : packageReceipt(input.receipt), order = packageOrder(input.order), binding = cashCarrySeriesBindingV1(input.binding);
  requireCondition(("kind" in receipt ? receipt.receiptHashHex : toHex(packageReceiptHash(receipt))) === input.receiptHashHex
    && bytesEqual(packageOrderHash(order), receipt.orderHash), "RECEIPT_MISMATCH", "The receipt requires its originating signed order.");
  requireCondition(receipt.environment === input.environment && order.environment === input.environment
    && order.action === "ENTRY" && receipt.action === "ENTRY" && ("kind" in receipt ? order.owner.toLowerCase() === receipt.owner : order.owner === receipt.owner)
    && receipt.finalityStatus === "FINALIZED" && receipt.terminalState === "FINALIZED_COMPLETE"
    && receipt.netSpotDelta !== undefined && receipt.netSpotDelta > 0n && receipt.perpPositionDelta < 0n,
  "RECEIPT_NOT_FINAL", "A strategy requires a finalized entry and positive spot inventory.");
  requireCondition(receipt.domain.domainId === binding.domain.domainId
    && receipt.domain.domainManifestVersion === binding.domain.domainManifestVersion
    && bytesEqual(receipt.domain.domainManifestHash, binding.domain.domainManifestHash)
    && order.domain.domainId === binding.domain.domainId
    && order.domain.domainManifestVersion === binding.domain.domainManifestVersion
    && bytesEqual(order.domain.domainManifestHash, binding.domain.domainManifestHash)
    && receipt.templateId === binding.templateId && receipt.templateVersion === binding.templateVersion
    && order.templateId === binding.templateId && order.templateVersion === binding.templateVersion
    && order.settlementClass === binding.settlementClass && receipt.settlementClass === binding.settlementClass
    && bytesEqual(receipt.packageTemplateManifestHash, binding.templateManifestHash)
    && bytesEqual(order.packageTemplateManifestHash, binding.templateManifestHash)
    && bytesEqual(order.quantity.asset.assetManifestHash, binding.baseAsset.manifestHash)
    && bytesEqual(order.maxMarginAdded.asset.assetManifestHash, binding.quoteAsset.manifestHash)
    && receipt.spotVenue !== receipt.perpVenue && receipt.quantity === order.quantity.atoms
    && order.quantity.atoms === receipt.netSpotDelta
    && receipt.netSpotDelta * binding.perpQuantityAtomsPerPackageUnit === -receipt.perpPositionDelta * binding.spotBaseAtomsPerPackageUnit,
  "BINDING_MISMATCH", "The entry differs from the reviewed onchain cash-and-carry binding.");
  const common = gcd(receipt.netSpotDelta!, receipt.perpPositionDelta);
  const state = strategyState({ version: 1, strategyId: `strategy-${input.receiptHashHex}`, ownerId: receipt.owner,
    subaccountId: order.settlementAccount, seriesId: `series-${toHex(binding.seriesManifestHash)}`, executionClassId: receipt.packageMarketId,
    open: true, stateVersion: 1n, liabilities: [], delegations: [], legalTransferRestricted: false,
    venuePositionsTransferable: input.transferable && receipt.domain.domainId === "eip155:84532",
    legs: [
      { legId: "spot", underlyingId: order.quantity.asset.assetId, instrumentId: input.spotInstrument, venueId: receipt.spotVenue,
        signedQuantityAtoms: receipt.netSpotDelta!, lotAtoms: common, ratioNumerator: receipt.netSpotDelta! / common, ratioDenominator: 1n },
      { legId: "perp", underlyingId: order.quantity.asset.assetId, instrumentId: input.perpInstrument, venueId: receipt.perpVenue,
        signedQuantityAtoms: receipt.perpPositionDelta, lotAtoms: common, ratioNumerator: receipt.perpPositionDelta / common, ratioDenominator: 1n },
    ] });
  const command: StrategyCommandInput = { commandVersion: 1, environment: input.environment, strategyId: state.strategyId,
    actorId: state.ownerId, expectedStateVersion: 0n, expectedStateHash: "00".repeat(32), atValue: input.atValue,
    parameters: { kind: "OPEN", originReceiptHash: input.receiptHashHex, state } };
  return { command, commandHashHex: toHex(strategyCommandHash(command)), stateHashHex: toHex(strategyStateHash(state)),
    orderHashHex: toHex(receipt.orderHash), receiptHashHex: input.receiptHashHex };
}

export function prepareBaseAccountExit(input: { environment: string; atValue: bigint; current: StrategyState; receipt: BaseAccountReceipt }): PreparedStrategyTransition {
  const { current, receipt } = input;
  const command: StrategyCommandInput = { commandVersion: 1, environment: input.environment, strategyId: current.strategyId,
    actorId: current.ownerId, expectedStateVersion: current.stateVersion, expectedStateHash: strategyStateHash(current), atValue: input.atValue,
    parameters: { kind: "EXIT", settlements: [], executionReceiptHashes: [receipt.receiptHashHex] } };
  const next = strategyState({ ...current, open: false, delegations: [], stateVersion: current.stateVersion + 1n,
    legs: current.legs.map(leg => ({ ...leg, signedQuantityAtoms: 0n })) });
  return { command, commandHashHex: toHex(strategyCommandHash(command)), stateHashHex: toHex(strategyStateHash(next)),
    receiptHashHex: receipt.receiptHashHex, orderHashHex: typeof receipt.orderHash === "string" ? receipt.orderHash : toHex(receipt.orderHash) };
}

export function prepareCanonicalStrategyOpen(input: {
  environment: string;
  atValue: bigint;
  receiptHashHex: string;
  receipt: PackageReceiptInput;
  series: EconomicStrategySeries;
  executionClass: SeriesExecutionClass;
  transferable: boolean;
}): PreparedStrategyOpen {
  const receipt = packageReceipt(input.receipt);
  const { series, executionClass } = input;
  requireCondition(toHex(packageReceiptHash(receipt)) === input.receiptHashHex, "RECEIPT_MISMATCH", "The entry receipt hash differs.");
  requireCondition(receipt.environment === input.environment && receipt.action === "ENTRY"
    && receipt.finalityStatus === "FINALIZED" && receipt.terminalState === "FINALIZED_COMPLETE"
    && receipt.netSpotDelta !== undefined && receipt.netSpotDelta > 0n && receipt.perpPositionDelta < 0n,
  "RECEIPT_NOT_FINAL", "A canonical strategy requires a finalized spot and perpetual entry.");
  requireCondition(series.seriesId === executionClass.seriesId && receipt.packageMarketId === executionClass.executionClassId
    && receipt.templateId === series.templateId && receipt.templateVersion === series.templateVersion
    && bytesEqual(receipt.packageTemplateManifestHash, series.templateManifestHash)
    && executionClass.domains.length === 1 && executionClass.domains[0]!.domainId === receipt.domain.domainId
    && executionClass.domains[0]!.domainManifestVersion === receipt.domain.domainManifestVersion
    && bytesEqual(executionClass.domains[0]!.domainManifestHash, receipt.domain.domainManifestHash)
    && series.underlyingRefs.length === 2 && series.instrumentRefs?.length === 2
    && series.underlyingRefs[0] === series.underlyingRefs[1]
    && series.economicLegRatios[0]!.numerator > 0n && series.economicLegRatios[1]!.numerator < 0n,
  "BINDING_MISMATCH", "The receipt requires its registered cash-and-carry series and instruments.");
  const common = gcd(receipt.netSpotDelta!, receipt.perpPositionDelta);
  const state = strategyState({
    version: 1, strategyId: `strategy-${input.receiptHashHex}`, ownerId: receipt.owner,
    subaccountId: receipt.owner, seriesId: series.seriesId, executionClassId: executionClass.executionClassId,
    open: true, stateVersion: 1n, liabilities: [], delegations: [], legalTransferRestricted: false,
    venuePositionsTransferable: input.transferable && receipt.domain.domainId === "eip155:84532",
    legs: [
      { legId: "spot", underlyingId: series.underlyingRefs[0]!, instrumentId: series.instrumentRefs![0]!,
        venueId: receipt.spotVenue, signedQuantityAtoms: receipt.netSpotDelta!, lotAtoms: common,
        ratioNumerator: receipt.netSpotDelta! / common, ratioDenominator: 1n },
      { legId: "perp", underlyingId: series.underlyingRefs[1]!, instrumentId: series.instrumentRefs![1]!,
        venueId: receipt.perpVenue, signedQuantityAtoms: receipt.perpPositionDelta, lotAtoms: common,
        ratioNumerator: receipt.perpPositionDelta / common, ratioDenominator: 1n },
    ],
  });
  const command: StrategyCommandInput = {
    commandVersion: 1, environment: input.environment, strategyId: state.strategyId, actorId: state.ownerId,
    expectedStateVersion: 0n, expectedStateHash: "00".repeat(32), atValue: input.atValue,
    parameters: { kind: "OPEN", originReceiptHash: input.receiptHashHex, state },
  };
  return { command, commandHashHex: toHex(strategyCommandHash(command)), stateHashHex: toHex(strategyStateHash(state)),
    orderHashHex: toHex(receipt.orderHash), receiptHashHex: input.receiptHashHex };
}

export function prepareStrategyOpen(input: Readonly<{
  environment: string;
  atValue: bigint;
  receiptHashHex: string;
  order: StrategyPackageOrder;
  graph: PackageGraphInput;
  receipt: StrategyPackageReceiptInput;
}>): PreparedStrategyOpen {
  const order = strategyPackageOrder(input.order);
  const graph = packageGraph(input.graph);
  const receipt = strategyPackageReceipt(input.receipt);
  const orderHashHex = toHex(strategyPackageOrderHash(order));
  const receiptHashHex = toHex(strategyPackageReceiptHash(receipt));

  requireCondition(receiptHashHex === input.receiptHashHex, "RECEIPT_MISMATCH", "The receipt does not match the requested hash.");
  requireCondition(bytesEqual(receipt.orderHash, strategyPackageOrderHash(order))
    && bytesEqual(receipt.graphHash, packageGraphHash(graph))
    && bytesEqual(order.graphHash, packageGraphHash(graph)),
  "BINDING_MISMATCH", "The order, graph, and receipt do not share one commitment.");
  requireCondition(sameIdentity(order, graph)
    && receipt.environment === order.environment
    && receipt.templateId === order.templateId
    && receipt.templateVersion === order.templateVersion
    && bytesEqual(receipt.packageTemplateManifestHash, order.packageTemplateManifestHash)
    && receipt.seriesId === order.seriesId
    && receipt.seriesVersion === order.seriesVersion
    && bytesEqual(receipt.seriesManifestHash, order.seriesManifestHash)
    && receipt.executionClassId === order.executionClassId
    && receipt.executionClassVersion === order.executionClassVersion
    && bytesEqual(receipt.executionClassManifestHash, order.executionClassManifestHash)
    && receipt.owner === order.owner
    && receipt.settlementClass === order.settlementClass,
  "BINDING_MISMATCH", "The order, graph, and receipt identify different strategy terms.");
  requireCondition(order.lifecycleAction === "ENTRY" && graph.lifecycleAction === "ENTRY" && receipt.lifecycleAction === "entry",
    "NOT_ENTRY", "Only an entry execution can found a strategy.");
  requireCondition(receipt.finalityStatus === "FINALIZED" && requiresSuccessfulReceipt(receipt.terminalState),
    "RECEIPT_NOT_FINAL", "The strategy needs a successful finalized entry receipt.");
  requireCondition(input.environment === order.environment, "WRONG_ENVIRONMENT", "The receipt belongs to another strategy environment.");

  const positionLegs = [];
  const liabilities = [];
  for (const outcome of receipt.legOutcomes) {
    if (outcome.positionLegId === undefined && outcome.liabilityId === undefined) continue;
    const leg = graph.legs.find((candidate) => candidate.legId === outcome.legId);
    requireCondition(leg !== undefined, "BINDING_MISMATCH", `Receipt leg ${outcome.legId} is absent from the graph.`);
    if (outcome.positionLegId !== undefined) {
      requireCondition(outcome.positionLegId === leg.legId, "UNSUPPORTED_POSITION_IDENTITY",
        "A position identity must equal its graph leg until a registered position schema supplies separate metadata.");
      const signedQuantityAtoms = outcome.settledQuantity.atoms;
      if (signedQuantityAtoms === 0n) continue;
      requireCondition(leg.side === "NONE"
        || (leg.side === "BUY" && signedQuantityAtoms > 0n)
        || (leg.side === "SELL" && signedQuantityAtoms < 0n),
      "POSITION_DIRECTION_MISMATCH", `Receipt leg ${leg.legId} has the wrong position direction.`);
      positionLegs.push({
        legId: leg.legId,
        underlyingId: leg.quantityAsset.assetId,
        instrumentId: leg.market.subjectId,
        venueId: leg.venue.subjectId,
        signedQuantityAtoms,
        lotAtoms: gcd(absolute(signedQuantityAtoms), leg.minimumQuantityAtoms),
      });
      continue;
    }
    requireCondition(leg.legFamily === "BORROW" && outcome.liabilityId === leg.legId
      && outcome.settledQuantity.atoms > 0n,
    "UNSUPPORTED_LIABILITY", "Only a positive entry borrow can found a strategy liability.");
    liabilities.push({
      liabilityId: leg.legId,
      kind: "BORROW" as const,
      assetId: outcome.settledQuantity.asset.assetId,
      atoms: outcome.settledQuantity.atoms,
      transferable: false,
    });
  }
  requireCondition(positionLegs.length > 0, "POSITION_EMPTY", "The entry receipt created no strategy position.");
  const commonQuantity = positionLegs.reduce((value, leg) => gcd(value, leg.signedQuantityAtoms), 0n);
  requireCondition(commonQuantity > 0n, "POSITION_EMPTY", "The entry receipt created no strategy quantity.");
  const strategyId = `strategy-${receiptHashHex}`;
  const state: StrategyState = strategyState({
    version: 1,
    strategyId,
    ownerId: order.owner,
    subaccountId: order.settlementAccount,
    seriesId: order.seriesId,
    executionClassId: order.executionClassId,
    open: true,
    stateVersion: 1n,
    legs: positionLegs.map((leg) => ({
      ...leg,
      ratioNumerator: leg.signedQuantityAtoms / commonQuantity,
      ratioDenominator: 1n,
    })),
    liabilities,
    delegations: [],
    venuePositionsTransferable: false,
    legalTransferRestricted: false,
  });
  const command: StrategyCommandInput = {
    commandVersion: 1,
    environment: input.environment,
    strategyId,
    actorId: order.owner,
    expectedStateVersion: 0n,
    expectedStateHash: "00".repeat(32),
    atValue: input.atValue,
    parameters: { kind: "OPEN", originReceiptHash: receiptHashHex, state },
  };
  return Object.freeze({
    command,
    commandHashHex: toHex(strategyCommandHash(command)),
    stateHashHex: toHex(strategyStateHash(state)),
    orderHashHex,
    receiptHashHex,
  });
}

function transitionOperation(lifecycleAction: string): StrategyPackageTransitionOperation {
  switch (lifecycleAction) {
    case "roll": return "ROLL";
    case "migrate": return "MIGRATE";
    case "rebalance": return "REBALANCE";
    case "increase": return "INCREASE";
    case "decrease": return "DECREASE";
    case "exit": return "EXIT";
    case "emergency-unwind": return "EMERGENCY_UNWIND";
    default: throw new StrategyOpenPreparationError("UNSUPPORTED_ACTION", "The receipt is not a supported strategy transition.");
  }
}

export function prepareStrategyTransition(input: Readonly<{
  environment: string;
  atValue: bigint;
  receiptHashHex: string;
  current: StrategyState;
  order: StrategyPackageOrder;
  graph: PackageGraphInput;
  receipt: StrategyPackageReceiptInput;
}>): PreparedStrategyTransition {
  const current = strategyState(input.current);
  const order = strategyPackageOrder(input.order);
  const graph = packageGraph(input.graph);
  const receipt = strategyPackageReceipt(input.receipt);
  const receiptHashHex = toHex(strategyPackageReceiptHash(receipt));
  const orderHashHex = toHex(strategyPackageOrderHash(order));
  const operation = transitionOperation(receipt.lifecycleAction);

  requireCondition(receiptHashHex === input.receiptHashHex, "RECEIPT_MISMATCH", "The receipt does not match the requested hash.");
  requireCondition(input.environment === order.environment && receipt.environment === order.environment,
    "WRONG_ENVIRONMENT", "The strategy transition belongs to another environment.");
  requireCondition(bytesEqual(receipt.orderHash, strategyPackageOrderHash(order))
    && bytesEqual(receipt.graphHash, packageGraphHash(graph))
    && bytesEqual(order.graphHash, packageGraphHash(graph)),
  "BINDING_MISMATCH", "The transition order, graph, and receipt do not share one commitment.");
  requireCondition(sameIdentity(order, graph)
    && order.lifecycleAction.toLowerCase().replaceAll("_", "-") === receipt.lifecycleAction
    && graph.lifecycleAction === order.lifecycleAction
    && receipt.environment === order.environment
    && receipt.templateId === order.templateId
    && receipt.templateVersion === order.templateVersion
    && bytesEqual(receipt.packageTemplateManifestHash, order.packageTemplateManifestHash)
    && receipt.seriesId === order.seriesId
    && receipt.seriesVersion === order.seriesVersion
    && bytesEqual(receipt.seriesManifestHash, order.seriesManifestHash)
    && receipt.executionClassId === order.executionClassId
    && receipt.executionClassVersion === order.executionClassVersion
    && bytesEqual(receipt.executionClassManifestHash, order.executionClassManifestHash)
    && receipt.owner === order.owner
    && receipt.settlementClass === order.settlementClass,
  "BINDING_MISMATCH", "The transition order, graph, and receipt identify different execution terms.");
  requireCondition(receipt.finalityStatus === "FINALIZED" && requiresSuccessfulReceipt(receipt.terminalState),
    "RECEIPT_NOT_FINAL", "The transition needs a successful finalized receipt.");
  requireCondition(order.owner === current.ownerId && order.settlementAccount === current.subaccountId,
  "STRATEGY_IDENTITY_MISMATCH", "The transition receipt does not belong to the selected strategy.");
  requireCondition(order.expectedStrategyStateHash !== undefined
    && bytesEqual(order.expectedStrategyStateHash, strategyStateHash(current)),
  "STALE_STRATEGY_STATE", "The transition order does not bind the strategy's current state.");

  const quantities = new Map(current.legs.map((leg) => [leg.legId, leg.signedQuantityAtoms] as const));
  const newLegs = new Map<string, PackageGraph["legs"][number]>();
  const liabilityAtoms = new Map(current.liabilities.map((liability) => [liability.liabilityId, liability.atoms] as const));
  const liabilityAssets = new Map(current.liabilities.map((liability) => [liability.liabilityId, liability.assetId] as const));
  for (const outcome of receipt.legOutcomes) {
    const leg = graph.legs.find((candidate) => candidate.legId === outcome.legId);
    requireCondition(leg !== undefined, "BINDING_MISMATCH", `Receipt leg ${outcome.legId} is absent from the transition graph.`);
    if (outcome.positionLegId !== undefined && outcome.settledQuantity.atoms !== 0n) {
      const positionLegId = outcome.positionLegId;
      quantities.set(positionLegId, (quantities.get(positionLegId) ?? 0n) + outcome.settledQuantity.atoms);
      if (!current.legs.some((candidate) => candidate.legId === positionLegId)) {
        requireCondition(positionLegId === leg.legId, "UNSUPPORTED_POSITION_IDENTITY",
          "A new position identity must equal its graph leg until a registered position schema supplies separate metadata.");
        newLegs.set(positionLegId, leg);
      }
    }
    if (outcome.liabilityId !== undefined && outcome.settledQuantity.atoms !== 0n) {
      const liabilityId = outcome.liabilityId;
      const assetId = outcome.settledQuantity.asset.assetId;
      const knownAsset = liabilityAssets.get(liabilityId);
      requireCondition(knownAsset === undefined || knownAsset === assetId,
        "LIABILITY_ASSET_MISMATCH", `Liability ${liabilityId} changed asset.`);
      if (knownAsset === undefined) {
        requireCondition(leg.legFamily === "BORROW" && liabilityId === leg.legId,
          "UNSUPPORTED_LIABILITY", "A new strategy liability must be created by its matching borrow leg.");
        liabilityAssets.set(liabilityId, assetId);
      }
      liabilityAtoms.set(liabilityId, (liabilityAtoms.get(liabilityId) ?? 0n) + outcome.settledQuantity.atoms);
    }
  }

  const closed = operation === "EXIT" || operation === "EMERGENCY_UNWIND";
  const legs = [...quantities].flatMap(([legId, signedQuantityAtoms]) => {
    const prior = current.legs.find((leg) => leg.legId === legId);
    if (closed && prior !== undefined) return [{ ...prior, signedQuantityAtoms }];
    if (signedQuantityAtoms === 0n) return [];
    if (prior !== undefined) {
      const quantityOperation = operation === "REBALANCE" || operation === "INCREASE" || operation === "DECREASE";
      return [{
        ...prior,
        signedQuantityAtoms,
        lotAtoms: quantityOperation ? gcd(prior.lotAtoms, signedQuantityAtoms - prior.signedQuantityAtoms) : prior.lotAtoms,
      }];
    }
    const source = newLegs.get(legId);
    requireCondition(source !== undefined, "POSITION_METADATA_MISSING", `No graph metadata defines position ${legId}.`);
    const replaced = current.legs.filter((leg) => (quantities.get(leg.legId) ?? 0n) === 0n
      && leg.underlyingId === source.quantityAsset.assetId
      && leg.venueId === source.venue.subjectId
      && absolute(leg.signedQuantityAtoms) === absolute(signedQuantityAtoms));
    const inherited = replaced.length === 1 ? replaced[0] : undefined;
    return [{
      legId,
      underlyingId: source.quantityAsset.assetId,
      instrumentId: source.market.subjectId,
      venueId: source.venue.subjectId,
      signedQuantityAtoms,
      lotAtoms: gcd(absolute(signedQuantityAtoms), source.minimumQuantityAtoms),
      ratioNumerator: inherited?.ratioNumerator ?? (signedQuantityAtoms > 0n ? 1n : -1n),
      ratioDenominator: inherited?.ratioDenominator ?? 1n,
    }];
  });
  const liabilities = [...liabilityAtoms].flatMap(([liabilityId, atoms]) => {
    requireCondition(atoms >= 0n, "LIABILITY_OVERPAID", `Liability ${liabilityId} was repaid beyond zero.`);
    if (atoms === 0n) return [];
    const prior = current.liabilities.find((liability) => liability.liabilityId === liabilityId);
    if (prior !== undefined) return [{ ...prior, atoms }];
    return [{
      liabilityId,
      kind: "BORROW" as const,
      assetId: liabilityAssets.get(liabilityId)!,
      atoms,
      transferable: false,
    }];
  });
  const next = strategyState({
    ...current,
    open: !closed,
    stateVersion: current.stateVersion + 1n,
    legs,
    liabilities,
    delegations: closed ? [] : current.delegations,
  });
  const transition = applyPackageStateTransition(current, {
    actorId: current.ownerId,
    expectedStateVersion: current.stateVersion,
    expectedStateHash: strategyStateHash(current),
    atValue: input.atValue,
  }, operation, next);
  if (!transition.accepted) {
    throw new StrategyOpenPreparationError("INVALID_TRANSITION", `The lifecycle kernel rejected the transition: ${transition.rejection}.`);
  }
  const execution = strategyExecutionMatches("APPLY_PACKAGE", current, next, [receipt], operation, [order]);
  if (!execution.matches) {
    throw new StrategyOpenPreparationError(execution.mismatch, "The receipt does not exactly account for the derived state change.");
  }

  const command: StrategyCommandInput = {
    commandVersion: 1,
    environment: input.environment,
    strategyId: current.strategyId,
    actorId: current.ownerId,
    expectedStateVersion: current.stateVersion,
    expectedStateHash: strategyStateHash(current),
    atValue: input.atValue,
    parameters: {
      kind: "APPLY_PACKAGE",
      operation,
      nextState: next,
      executionReceiptHashes: [receiptHashHex],
    },
  };
  return Object.freeze({
    command,
    commandHashHex: toHex(strategyCommandHash(command)),
    stateHashHex: toHex(strategyStateHash(next)),
    orderHashHex,
    receiptHashHex,
  });
}

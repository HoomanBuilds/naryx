import {
  applyPackageStateTransition,
  bytesEqual,
  packageGraph,
  packageGraphHash,
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
} from "@naryx/protocol-types";

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

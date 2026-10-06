import {
  bytesEqual,
  packageGraph,
  requiresSuccessfulReceipt,
  strategyState,
  strategyStateHash,
  toHex,
  type PackageGraphInput,
  type StrategyPackageOrder,
  type StrategyPackageReceipt,
  type StrategyState,
} from "@naryx/protocol-types";

export type NativeStrategyPositionStatus = "OPEN" | "EXITING" | "CLOSED" | "UNRESOLVED";

export interface NativeStrategyPosition {
  readonly strategyId: string;
  readonly owner: string;
  readonly templateId: string;
  readonly economicQuantityAtoms: bigint;
  readonly entryOrderHashHex: string;
  readonly entryReceiptHashHex: string;
  readonly stateHashHex: string;
  readonly state: StrategyState;
  readonly status: NativeStrategyPositionStatus;
  readonly exitOrderHashHex?: string;
  readonly exitReceiptHashHex?: string;
}

export class NativeStrategyPositionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeStrategyPositionError";
    this.code = code;
  }
}

function requireCondition(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new NativeStrategyPositionError(code, message);
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

function completeTerminalState(state: StrategyPackageReceipt["terminalState"]): boolean {
  return state === "FINALIZED_COMPLETE" || state === "RECOVERED_COMPLETE";
}

function checkedPositionDeltas(
  graphInput: PackageGraphInput,
  receipt: StrategyPackageReceipt,
): ReadonlyMap<string, bigint> {
  const graph = packageGraph(graphInput);
  const deltas = new Map<string, bigint>();
  for (const leg of graph.legs) {
    const outcome = receipt.legOutcomes.find((candidate) => candidate.legId === leg.legId);
    requireCondition(outcome !== undefined && outcome.positionLegId === leg.legId,
      "POSITION_EVIDENCE_MISSING", `Receipt leg ${leg.legId} does not identify its strategy position.`);
    const delta = outcome.settledQuantity.atoms;
    requireCondition(delta === 0n || (delta > 0n) === (leg.side === "BUY"),
      "POSITION_DIRECTION_MISMATCH", `Receipt leg ${leg.legId} has the wrong position direction.`);
    requireCondition(absolute(delta) <= leg.quantityAtoms,
      "POSITION_QUANTITY_MISMATCH", `Receipt leg ${leg.legId} exceeds the authorized quantity.`);
    deltas.set(leg.legId, delta);
  }
  return deltas;
}

export function nativeStrategyPositionFromEntry(input: Readonly<{
  orderHashHex: string;
  receiptHashHex: string;
  order: StrategyPackageOrder;
  graph: PackageGraphInput;
  receipt: StrategyPackageReceipt;
}>): NativeStrategyPosition | undefined {
  const { orderHashHex, receiptHashHex, order, receipt } = input;
  const graph = packageGraph(input.graph);
  requireCondition(order.lifecycleAction === "ENTRY" && graph.lifecycleAction === "ENTRY",
    "POSITION_ACTION_MISMATCH", "Only an ENTRY package can create a native strategy position.");
  requireCondition(receipt.finalityStatus === "FINALIZED", "POSITION_NOT_FINAL",
    "A native strategy position requires finalized execution evidence.");
  const deltas = checkedPositionDeltas(graph, receipt);
  if (receipt.terminalState === "NO_EFFECT" || receipt.terminalState === "RECOVERED_FLAT") {
    requireCondition([...deltas.values()].every((delta) => delta === 0n),
      "POSITION_NOT_FLAT", "A flat entry receipt cannot leave native strategy exposure.");
    return undefined;
  }
  const nonzero = graph.legs.filter((leg) => deltas.get(leg.legId) !== 0n);
  requireCondition(nonzero.length > 0, "POSITION_EMPTY", "The strategy receipt created no position.");
  if (completeTerminalState(receipt.terminalState)) {
    requireCondition(nonzero.length === graph.legs.length
      && graph.legs.every((leg) => absolute(deltas.get(leg.legId) ?? 0n) === leg.quantityAtoms),
    "POSITION_INCOMPLETE", "A complete entry receipt must establish every strategy leg exactly.");
  }
  const commonQuantity = nonzero.reduce((current, leg) => gcd(current, deltas.get(leg.legId)!), 0n);
  const state = strategyState({
    version: 1,
    strategyId: `native-hl-${orderHashHex.slice(0, 48)}`,
    ownerId: order.owner,
    subaccountId: order.settlementAccount,
    seriesId: order.seriesId,
    executionClassId: order.executionClassId,
    open: true,
    stateVersion: 1n,
    legs: nonzero.map((leg) => {
      const signedQuantityAtoms = deltas.get(leg.legId)!;
      return {
        legId: leg.legId,
        underlyingId: leg.quantityAsset.assetId,
        instrumentId: leg.market.subjectId,
        venueId: leg.venue.subjectId,
        signedQuantityAtoms,
        lotAtoms: gcd(absolute(signedQuantityAtoms), leg.minimumQuantityAtoms),
        ratioNumerator: signedQuantityAtoms / commonQuantity,
        ratioDenominator: 1n,
      };
    }),
    liabilities: [],
    delegations: [],
    venuePositionsTransferable: false,
    legalTransferRestricted: false,
  });
  return Object.freeze({
    strategyId: state.strategyId,
    owner: state.ownerId,
    templateId: order.templateId,
    economicQuantityAtoms: order.economicQuantity.atoms,
    entryOrderHashHex: orderHashHex,
    entryReceiptHashHex: receiptHashHex,
    stateHashHex: toHex(strategyStateHash(state)),
    state,
    status: completeTerminalState(receipt.terminalState) && requiresSuccessfulReceipt(receipt.terminalState)
      ? "OPEN" : "UNRESOLVED",
  });
}

export function validateNativeStrategyExit(
  position: NativeStrategyPosition,
  order: StrategyPackageOrder,
  graphInput: PackageGraphInput,
): void {
  const graph = packageGraph(graphInput);
  const emergency = order.lifecycleAction === "EMERGENCY_UNWIND";
  requireCondition(position.status === "OPEN" || (emergency && position.status === "UNRESOLVED"),
    "STRATEGY_NOT_OPEN", "The native strategy position is not available for this unwind.");
  requireCondition((order.lifecycleAction === "EXIT" || emergency)
    && graph.lifecycleAction === order.lifecycleAction,
  "POSITION_ACTION_MISMATCH", "A native strategy unwind must use EXIT or EMERGENCY_UNWIND semantics.");
  requireCondition(order.expectedStrategyStateHash !== undefined
    && bytesEqual(order.expectedStrategyStateHash, strategyStateHash(position.state)),
  "STALE_STRATEGY_STATE", "The exit does not bind the current native strategy state.");
  requireCondition(order.owner === position.state.ownerId
    && order.templateId === position.templateId
    && order.seriesId === position.state.seriesId
    && order.executionClassId === position.state.executionClassId
    && order.settlementAccount === position.state.subaccountId,
  "STRATEGY_IDENTITY_MISMATCH", "The exit order differs from the open native strategy identity.");
  requireCondition(graph.legs.length === position.state.legs.length,
    "STRATEGY_LEG_MISMATCH", "The exit must close every open native strategy leg.");
  for (const stateLeg of position.state.legs) {
    const leg = graph.legs.find((candidate) => candidate.legId === stateLeg.legId);
    requireCondition(leg !== undefined
      && leg.quantityAsset.assetId === stateLeg.underlyingId
      && leg.market.subjectId === stateLeg.instrumentId
      && leg.venue.subjectId === stateLeg.venueId
      && leg.quantityAtoms === absolute(stateLeg.signedQuantityAtoms)
      && leg.minimumQuantityAtoms === leg.quantityAtoms
      && leg.side === (stateLeg.signedQuantityAtoms > 0n ? "SELL" : "BUY"),
    "STRATEGY_LEG_MISMATCH", `Unwind leg ${stateLeg.legId} does not exactly close the open position.`);
  }
}

export type NativeStrategyPositionTransitionAction = "INCREASE" | "DECREASE";

function validateNativeStrategyIdentity(
  position: NativeStrategyPosition,
  order: StrategyPackageOrder,
): void {
  requireCondition(order.expectedStrategyStateHash !== undefined
    && bytesEqual(order.expectedStrategyStateHash, strategyStateHash(position.state)),
  "STALE_STRATEGY_STATE", "The transition does not bind the current native strategy state.");
  requireCondition(order.owner === position.state.ownerId
    && order.templateId === position.templateId
    && order.seriesId === position.state.seriesId
    && order.executionClassId === position.state.executionClassId
    && order.settlementAccount === position.state.subaccountId,
  "STRATEGY_IDENTITY_MISMATCH", "The transition order differs from the open native strategy identity.");
}

export function validateNativeStrategyTransition(
  position: NativeStrategyPosition,
  order: StrategyPackageOrder,
  graphInput: PackageGraphInput,
): void {
  const graph = packageGraph(graphInput);
  requireCondition(position.status === "OPEN", "STRATEGY_NOT_OPEN",
    "The native strategy position is not available for a lifecycle transition.");
  requireCondition((order.lifecycleAction === "INCREASE" || order.lifecycleAction === "DECREASE")
    && graph.lifecycleAction === order.lifecycleAction,
  "POSITION_ACTION_MISMATCH", "A native strategy transition must use INCREASE or DECREASE semantics.");
  validateNativeStrategyIdentity(position, order);
  requireCondition(graph.legs.length === position.state.legs.length,
    "STRATEGY_LEG_MISMATCH", "The transition must address every open native strategy leg.");
  if (order.lifecycleAction === "DECREASE") {
    requireCondition(order.economicQuantity.atoms < position.economicQuantityAtoms,
      "POSITION_QUANTITY_MISMATCH", "A decrease must retain positive economic exposure; use EXIT to close it.");
  }
  for (const stateLeg of position.state.legs) {
    const leg = graph.legs.find((candidate) => candidate.legId === stateLeg.legId);
    const sameDirection = stateLeg.signedQuantityAtoms > 0n ? "BUY" : "SELL";
    const oppositeDirection = sameDirection === "BUY" ? "SELL" : "BUY";
    requireCondition(leg !== undefined
      && leg.quantityAsset.assetId === stateLeg.underlyingId
      && leg.market.subjectId === stateLeg.instrumentId
      && leg.venue.subjectId === stateLeg.venueId
      && leg.minimumQuantityAtoms === leg.quantityAtoms
      && leg.side === (order.lifecycleAction === "INCREASE" ? sameDirection : oppositeDirection),
    "STRATEGY_LEG_MISMATCH", `Transition leg ${stateLeg.legId} does not match the open position.`);
    if (order.lifecycleAction === "DECREASE") {
      requireCondition(leg.quantityAtoms < absolute(stateLeg.signedQuantityAtoms),
        "POSITION_QUANTITY_MISMATCH", `Decrease leg ${stateLeg.legId} must retain an open position.`);
    }
  }
}

export function applyNativeStrategyTransitionReceipt(
  position: NativeStrategyPosition,
  order: StrategyPackageOrder,
  graphInput: PackageGraphInput,
  receipt: StrategyPackageReceipt,
): NativeStrategyPosition {
  validateNativeStrategyTransition(position, order, graphInput);
  requireCondition(receipt.finalityStatus === "FINALIZED", "POSITION_NOT_FINAL",
    "A native strategy transition requires finalized execution evidence.");
  const graph = packageGraph(graphInput);
  const deltas = checkedPositionDeltas(graph, receipt);
  if (receipt.terminalState === "NO_EFFECT" || receipt.terminalState === "RECOVERED_FLAT") {
    requireCondition([...deltas.values()].every((delta) => delta === 0n),
      "POSITION_NOT_FLAT", "A flat transition receipt cannot change native strategy exposure.");
    return position;
  }
  const complete = completeTerminalState(receipt.terminalState);
  const adjustedLegs = position.state.legs.map((stateLeg) => {
    const graphLeg = graph.legs.find((candidate) => candidate.legId === stateLeg.legId)!;
    const delta = deltas.get(stateLeg.legId) ?? 0n;
    if (complete) {
      requireCondition(absolute(delta) === graphLeg.quantityAtoms,
        "POSITION_INCOMPLETE", `A complete transition must execute ${stateLeg.legId} exactly.`);
    }
    const nextQuantity = stateLeg.signedQuantityAtoms + delta;
    requireCondition(nextQuantity !== 0n && (nextQuantity > 0n) === (stateLeg.signedQuantityAtoms > 0n),
      "POSITION_DIRECTION_MISMATCH", `Transition leg ${stateLeg.legId} cannot close or reverse the position.`);
    return Object.freeze({
      ...stateLeg,
      signedQuantityAtoms: nextQuantity,
      lotAtoms: gcd(stateLeg.lotAtoms, absolute(delta)),
    });
  });
  const commonQuantity = adjustedLegs.reduce(
    (current, leg) => gcd(current, leg.signedQuantityAtoms), 0n,
  );
  const nextLegs = adjustedLegs.map((leg) => Object.freeze({
    ...leg,
    ratioNumerator: leg.signedQuantityAtoms / commonQuantity,
    ratioDenominator: 1n,
  }));
  const state = strategyState({
    ...position.state,
    stateVersion: position.state.stateVersion + 1n,
    legs: nextLegs,
  });
  const economicQuantityAtoms = complete
    ? order.lifecycleAction === "INCREASE"
      ? position.economicQuantityAtoms + order.economicQuantity.atoms
      : position.economicQuantityAtoms - order.economicQuantity.atoms
    : position.economicQuantityAtoms;
  return Object.freeze({
    ...position,
    economicQuantityAtoms,
    state,
    stateHashHex: toHex(strategyStateHash(state)),
    status: complete ? "OPEN" : "UNRESOLVED",
  });
}

export function applyNativeStrategyExitReceipt(
  position: NativeStrategyPosition,
  orderHashHex: string,
  receiptHashHex: string,
  order: StrategyPackageOrder,
  graph: PackageGraphInput,
  receipt: StrategyPackageReceipt,
): NativeStrategyPosition {
  requireCondition(position.status === "EXITING" && position.exitOrderHashHex === orderHashHex,
    "EXIT_NOT_SELECTED", "The receipt does not belong to the selected native strategy exit.");
  validateNativeStrategyExit({ ...position, status: "OPEN" }, order, graph);
  requireCondition(receipt.finalityStatus === "FINALIZED", "POSITION_NOT_FINAL",
    "A native strategy transition requires finalized execution evidence.");
  if (receipt.terminalState === "NO_EFFECT" || receipt.terminalState === "RECOVERED_FLAT") {
    const deltas = checkedPositionDeltas(graph, receipt);
    requireCondition([...deltas.values()].every((delta) => delta === 0n),
      "POSITION_NOT_FLAT", "A no-effect exit receipt cannot change native strategy exposure.");
    return Object.freeze({
      strategyId: position.strategyId,
      owner: position.owner,
      templateId: position.templateId,
      economicQuantityAtoms: position.economicQuantityAtoms,
      entryOrderHashHex: position.entryOrderHashHex,
      entryReceiptHashHex: position.entryReceiptHashHex,
      stateHashHex: position.stateHashHex,
      state: position.state,
      status: "OPEN",
      exitReceiptHashHex: receiptHashHex,
    });
  }
  const deltas = checkedPositionDeltas(graph, receipt);
  const remaining = position.state.legs.map((leg) => {
    const delta = deltas.get(leg.legId) ?? 0n;
    requireCondition(delta === 0n || delta > 0n !== leg.signedQuantityAtoms > 0n,
      "POSITION_DIRECTION_MISMATCH", `Exit leg ${leg.legId} increases the open position.`);
    requireCondition(absolute(delta) <= absolute(leg.signedQuantityAtoms),
      "POSITION_QUANTITY_MISMATCH", `Exit leg ${leg.legId} exceeds the open position.`);
    return Object.freeze({ ...leg, signedQuantityAtoms: leg.signedQuantityAtoms + delta });
  });
  const openLegs = remaining.filter((leg) => leg.signedQuantityAtoms !== 0n);
  if (completeTerminalState(receipt.terminalState)) {
    requireCondition(openLegs.length === 0, "POSITION_INCOMPLETE",
      "A complete exit receipt must close every native strategy leg exactly.");
  }
  const closed = openLegs.length === 0;
  const state = strategyState({
    ...position.state,
    open: !closed,
    stateVersion: position.state.stateVersion + 1n,
    legs: closed ? remaining : openLegs,
  });
  return Object.freeze({
    ...position,
    state,
    stateHashHex: toHex(strategyStateHash(state)),
    status: closed ? "CLOSED" : "UNRESOLVED",
    exitReceiptHashHex: receiptHashHex,
  });
}

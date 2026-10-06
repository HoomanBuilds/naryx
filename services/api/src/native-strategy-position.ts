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
  requireCondition(position.status === "OPEN", "STRATEGY_NOT_OPEN",
    "The native strategy position is not available for a standard exit.");
  requireCondition(order.lifecycleAction === "EXIT" && graph.lifecycleAction === "EXIT",
    "POSITION_ACTION_MISMATCH", "A native strategy exit must use EXIT lifecycle semantics.");
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
    "STRATEGY_LEG_MISMATCH", `Exit leg ${stateLeg.legId} does not exactly close the open position.`);
  }
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
  if (receipt.terminalState === "NO_EFFECT") {
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
  if (completeTerminalState(receipt.terminalState) || receipt.terminalState === "RECOVERED_FLAT") {
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

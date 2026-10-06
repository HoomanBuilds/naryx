import { createHash } from "node:crypto";
import {
  assetAmount,
  strategyPackageReceipt,
  type StrategyPackageReceipt,
} from "@naryx/protocol-types";
import type { StoredStrategyPackageAdmission } from "./strategy-package-store.js";
import type {
  HyperliquidTestnetExecutionEvidence,
  HyperliquidTestnetLegExecutionEvidence,
  HyperliquidTestnetTerminalExecutionResult,
} from "./hyperliquid-testnet-terminal.js";

const RECEIPT_NONCE_DOMAIN = "NARYX/hyperliquid-strategy-receipt/v1";

export class HyperliquidStrategyReceiptError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HyperliquidStrategyReceiptError";
    this.code = code;
  }
}

function requireCondition(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new HyperliquidStrategyReceiptError(code, message);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function receiptNonce(
  attemptId: string,
  actionCommitment: string,
  requestCommitment: string,
): bigint {
  const digest = createHash("sha256")
    .update(RECEIPT_NONCE_DOMAIN, "ascii")
    .update("\0")
    .update(attemptId, "utf8")
    .update("\0")
    .update(actionCommitment, "ascii")
    .update("\0")
    .update(requestCommitment, "ascii")
    .digest();
  let nonce = 0n;
  for (const byte of digest.subarray(0, 8)) nonce = (nonce << 8n) + BigInt(byte);
  return nonce === 0n ? 1n : nonce;
}

function evidenceByLegId(
  evidence: HyperliquidTestnetExecutionEvidence,
  legId: string,
): HyperliquidTestnetLegExecutionEvidence {
  const matches = evidence.legs.filter((leg) => leg.legId === legId);
  requireCondition(matches.length === 1, "INVALID_EVIDENCE", `Execution evidence must contain leg ${legId}.`);
  return matches[0]!;
}

function signedRequestedQuantity(side: "BUY" | "SELL" | "NONE", atoms: bigint): bigint {
  requireCondition(side !== "NONE", "UNSUPPORTED_GRAPH", "An executable Hyperliquid leg must have a side.");
  return side === "BUY" ? atoms : -atoms;
}

function checkedLegOutcome(
  admission: StoredStrategyPackageAdmission,
  evidence: HyperliquidTestnetExecutionEvidence,
  legId: string,
  residualValueAtoms: bigint,
) {
  const leg = admission.graph.legs.find((candidate) => candidate.legId === legId);
  requireCondition(leg !== undefined, "UNSUPPORTED_GRAPH", `The strategy graph does not contain leg ${legId}.`);
  const observed = evidenceByLegId(evidence, legId);
  const role = observed.role;
  const requested = BigInt(observed.requestedSignedBaseAtoms);
  const filled = BigInt(observed.filledSignedBaseAtoms);
  const grossQuoteAtoms = BigInt(observed.grossQuoteAtoms);
  const feeAtoms = BigInt(observed.feeAtoms);
  const venueFeeQuoteAtoms = BigInt(observed.venueFeeQuoteAtoms);
  const expectedRequested = signedRequestedQuantity(leg.side, leg.quantityAtoms);
  requireCondition(requested === expectedRequested, "QUANTITY_MISMATCH", `${role} evidence does not match the signed graph quantity.`);
  requireCondition(filled === 0n || filled > 0n === expectedRequested > 0n,
    "DIRECTION_MISMATCH", `${role} evidence has the wrong execution direction.`);
  requireCondition(absolute(filled) <= leg.quantityAtoms,
    "QUANTITY_MISMATCH", `${role} evidence exceeds the signed graph quantity.`);
  requireCondition(venueFeeQuoteAtoms <= leg.maximumFeeQuoteAtoms,
    "FEE_CAP_EXCEEDED", `${role} venue fees exceed the signed graph cap.`);
  const expectedFeeAsset = role === "SPOT" && leg.side === "BUY"
    ? leg.quantityAsset
    : admission.order.quoteAsset;
  requireCondition(observed.feeAssetId === expectedFeeAsset.assetId
    && observed.feeAssetDecimals === expectedFeeAsset.decimals,
  "FEE_ASSET_MISMATCH", `${role} fee evidence names an unexpected asset.`);
  requireCondition(feeAtoms >= 0n && grossQuoteAtoms >= 0n && venueFeeQuoteAtoms >= 0n,
    "INVALID_EVIDENCE", `${role} evidence contains a negative cost.`);
  return Object.freeze({
    legId: leg.legId,
    positionLegId: leg.legId,
    domain: leg.domain,
    status: filled === 0n ? "NO_EFFECT" as const : "EXECUTED" as const,
    requestedQuantity: assetAmount(leg.quantityAsset, leg.quantityAtoms),
    settledQuantity: assetAmount(leg.quantityAsset, filled),
    grossNotional: assetAmount(admission.order.quoteAsset, grossQuoteAtoms),
    venueFee: assetAmount(admission.order.quoteAsset, venueFeeQuoteAtoms),
    residualValue: assetAmount(admission.order.quoteAsset, residualValueAtoms),
    evidenceGrade: "VENUE_API_CORROBORATED" as const,
    onchainEnforced: false,
    evidenceHash: observed.evidenceCommitment,
  });
}

export function buildHyperliquidStrategyPackageReceipt(input: Readonly<{
  attemptId: string;
  admission: StoredStrategyPackageAdmission;
  result: HyperliquidTestnetTerminalExecutionResult;
}>): StrategyPackageReceipt | undefined {
  const { admission, result } = input;
  requireCondition(result.attemptId === input.attemptId,
    "ATTEMPT_MISMATCH", "Execution evidence belongs to another strategy attempt.");
  if (result.status !== "RECONCILED"
    || result.packageStatus === "RECOVERY_REQUIRED"
    || result.packageStatus === "MANUAL_INTERVENTION") return undefined;
  requireCondition(result.executionEvidence !== undefined,
    "MISSING_EXECUTION_EVIDENCE", "A final strategy result must carry authoritative execution evidence.");
  requireCondition(result.actionCommitment !== null && result.requestCommitment !== null,
    "MISSING_EXECUTION_EVIDENCE", "A final strategy result must carry action and request commitments.");
  requireCondition(result.observedNetSpotDeltaAtoms !== undefined
    && result.observedPerpetualDeltaAtoms !== undefined,
  "MISSING_EXECUTION_EVIDENCE", "A final strategy result must carry observed package deltas.");
  requireCondition(admission.graph.legs.length === 2,
    "UNSUPPORTED_GRAPH", "The Hyperliquid receipt path supports exactly two execution legs.");
  const evidence = result.executionEvidence;
  requireCondition(new Set(evidence.legs.map((leg) => leg.legId)).size === evidence.legs.length,
    "INVALID_EVIDENCE", "Execution evidence leg identifiers must be unique.");
  const terminalResidualBaseAtoms = BigInt(evidence.terminalResidualBaseAtoms);
  const terminalResidualQuoteAtoms = BigInt(evidence.terminalResidualQuoteAtoms);
  const observedSpot = BigInt(result.observedNetSpotDeltaAtoms!);
  const observedPerpetual = BigInt(result.observedPerpetualDeltaAtoms!);
  requireCondition(absolute(observedSpot + observedPerpetual) === terminalResidualBaseAtoms,
    "RESIDUAL_MISMATCH", "Execution evidence does not reconcile with the observed package delta.");
  requireCondition(terminalResidualQuoteAtoms <= admission.order.maximumResidualValue.atoms,
    "RESIDUAL_CAP_EXCEEDED", "The terminal residual exceeds the signed strategy cap.");
  requireCondition(result.packageStatus !== "COMPLETED_EXACT" || terminalResidualQuoteAtoms === 0n,
    "RESIDUAL_MISMATCH", "An exact completion cannot carry a terminal residual.");

  const residualLegId = evidence.legs.find((leg) => leg.role === "SPOT")?.legId
    ?? evidence.legs[0]!.legId;
  const legOutcomes = evidence.legs.map((leg) => checkedLegOutcome(
    admission,
    evidence,
    leg.legId,
    leg.legId === residualLegId ? terminalResidualQuoteAtoms : 0n,
  ));
  const venueFeeAtoms = legOutcomes.reduce((sum, outcome) => sum + outcome.venueFee.atoms, 0n);
  const quotedVenueFeeAtoms = admission.quote.passThroughCosts
    .find((cost) => cost.category === "VENUE")?.amount.atoms ?? 0n;
  requireCondition(venueFeeAtoms <= quotedVenueFeeAtoms,
    "FEE_CAP_EXCEEDED", "Observed venue fees exceed the selected quote.");
  if (result.packageStatus === "NO_EFFECT") {
    requireCondition(legOutcomes.every((outcome) => outcome.status === "NO_EFFECT"
      && outcome.grossNotional.atoms === 0n && outcome.venueFee.atoms === 0n)
      && terminalResidualBaseAtoms === 0n && terminalResidualQuoteAtoms === 0n,
    "NO_EFFECT_MISMATCH", "A no-effect result contains execution or cost evidence.");
  } else {
    requireCondition(legOutcomes.every((outcome) => outcome.status === "EXECUTED"),
      "INCOMPLETE_EXECUTION", "A completed package must execute every graph leg.");
  }

  const zero = assetAmount(admission.order.quoteAsset, 0n);
  return strategyPackageReceipt({
    version: 1,
    environment: admission.order.environment,
    domains: admission.route.domainPlans.map((plan) => plan.domain),
    orderHash: admission.orderHashHex,
    graphHash: admission.graphHashHex,
    quoteHash: admission.quoteHashHex,
    routeHash: admission.routeHashHex,
    templateId: admission.order.templateId,
    templateVersion: admission.order.templateVersion,
    packageTemplateManifestHash: admission.order.packageTemplateManifestHash,
    seriesId: admission.order.seriesId,
    seriesVersion: admission.order.seriesVersion,
    seriesManifestHash: admission.order.seriesManifestHash,
    executionClassId: admission.order.executionClassId,
    executionClassVersion: admission.order.executionClassVersion,
    executionClassManifestHash: admission.order.executionClassManifestHash,
    lifecycleAction: admission.order.lifecycleAction,
    owner: admission.order.owner,
    solverId: admission.quote.solverId,
    settlementClass: admission.order.settlementClass,
    terminalState: result.packageStatus === "NO_EFFECT"
      ? "NO_EFFECT"
      : terminalResidualQuoteAtoms === 0n ? "FINALIZED_COMPLETE" : "FINALIZED_BOUNDED",
    quoteAsset: admission.order.quoteAsset,
    legOutcomes,
    serviceFee: zero,
    solverFee: zero,
    venueFees: assetAmount(admission.order.quoteAsset, venueFeeAtoms),
    networkCost: zero,
    recoveryCost: zero,
    terminalResidualValue: assetAmount(admission.order.quoteAsset, terminalResidualQuoteAtoms),
    finalityStatus: "VENUE_COMMITTED",
    executedAtValue: BigInt(evidence.observedAtMs),
    receiptNonce: receiptNonce(input.attemptId, result.actionCommitment, result.requestCommitment),
  });
}

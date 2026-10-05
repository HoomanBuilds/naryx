import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { enumDiscriminant, SETTLEMENT_CLASS, type SettlementClass } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { GRAPH_LIFECYCLE_ACTION, type GraphLifecycleAction } from './package-graph.js';
import {
  assetAmount,
  assetRef,
  domainRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import {
  FIELD_EVIDENCE_GRADE,
  FINALITY_STATUS,
  TERMINAL_STATE,
  isBoundedTerminalState,
  isRecoveredTerminalState,
  type FieldEvidenceGrade,
  type FinalityStatus,
  type TerminalState,
} from './terminal-outcome.js';

export const STRATEGY_PACKAGE_RECEIPT_VERSION = 1;
export const STRATEGY_RECEIPT_MAX_LEGS = 32;
const U32_BITS = 32;
const U64_BITS = 64;

export const STRATEGY_LEG_OUTCOME = Object.freeze({
  EXECUTED: 1,
  RECOVERED: 2,
  NO_EFFECT: 3,
  MANUAL_INTERVENTION: 4,
} as const);
export type StrategyLegOutcomeStatus = keyof typeof STRATEGY_LEG_OUTCOME;

export interface StrategyLegOutcomeInput {
  readonly legId: string;
  /** Strategy-state position changed by this execution leg. Omitted for operational-only legs. */
  readonly positionLegId?: string;
  /** Strategy-state liability changed by this execution leg. Borrow is positive and repayment is negative. */
  readonly liabilityId?: string;
  readonly domain: DomainRef;
  readonly status: StrategyLegOutcomeStatus;
  readonly requestedQuantity: AssetAmount;
  readonly settledQuantity: AssetAmount;
  readonly grossNotional: AssetAmount;
  readonly venueFee: AssetAmount;
  readonly residualValue: AssetAmount;
  readonly evidenceGrade: FieldEvidenceGrade;
  readonly onchainEnforced: boolean;
  readonly evidenceHash: Uint8Array | string;
}

export interface StrategyLegOutcome extends Omit<StrategyLegOutcomeInput, 'legId' | 'positionLegId' | 'liabilityId' | 'domain' | 'requestedQuantity' | 'settledQuantity' | 'grossNotional' | 'venueFee' | 'residualValue' | 'evidenceHash'> {
  readonly legId: ProtocolId;
  readonly positionLegId?: ProtocolId;
  readonly liabilityId?: ProtocolId;
  readonly domain: DomainRef;
  readonly requestedQuantity: AssetAmount;
  readonly settledQuantity: AssetAmount;
  readonly grossNotional: AssetAmount;
  readonly venueFee: AssetAmount;
  readonly residualValue: AssetAmount;
  readonly evidenceHash: CommitmentHash;
}

export interface StrategyPackageReceiptInput {
  readonly version: number;
  readonly environment: string;
  readonly domains: readonly DomainRef[];
  readonly orderHash: Uint8Array | string;
  readonly graphHash: Uint8Array | string;
  readonly quoteHash: Uint8Array | string;
  readonly routeHash: Uint8Array | string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly seriesId: string;
  readonly seriesVersion: number;
  readonly seriesManifestHash: Uint8Array | string;
  readonly executionClassId: string;
  readonly executionClassVersion: number;
  readonly executionClassManifestHash: Uint8Array | string;
  readonly lifecycleAction: string;
  readonly owner: string;
  readonly solverId: string;
  readonly settlementClass: SettlementClass;
  readonly terminalState: TerminalState;
  readonly quoteAsset: AssetRef;
  readonly legOutcomes: readonly StrategyLegOutcomeInput[];
  readonly serviceFee: AssetAmount;
  readonly solverFee: AssetAmount;
  readonly venueFees: AssetAmount;
  readonly networkCost: AssetAmount;
  readonly recoveryCost: AssetAmount;
  readonly terminalResidualValue: AssetAmount;
  readonly finalityStatus: FinalityStatus;
  readonly executedAtValue: bigint;
  readonly receiptNonce: bigint;
}

export interface StrategyPackageReceipt extends Omit<StrategyPackageReceiptInput,
  'environment' | 'domains' | 'orderHash' | 'graphHash' | 'quoteHash' | 'routeHash' |
  'templateId' | 'packageTemplateManifestHash' | 'seriesId' | 'seriesManifestHash' | 'executionClassId' | 'executionClassManifestHash' |
  'lifecycleAction' | 'owner' | 'solverId' | 'quoteAsset' | 'legOutcomes' |
  'serviceFee' | 'solverFee' | 'venueFees' | 'networkCost' | 'recoveryCost' |
  'terminalResidualValue'> {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly domains: readonly DomainRef[];
  readonly orderHash: CommitmentHash;
  readonly graphHash: CommitmentHash;
  readonly quoteHash: CommitmentHash;
  readonly routeHash: CommitmentHash;
  readonly templateId: ProtocolId;
  readonly packageTemplateManifestHash: ManifestHash;
  readonly seriesId: ProtocolId;
  readonly seriesManifestHash: ManifestHash;
  readonly executionClassId: ProtocolId;
  readonly executionClassManifestHash: ManifestHash;
  readonly lifecycleAction: ProtocolId;
  readonly owner: ProtocolId;
  readonly solverId: ProtocolId;
  readonly quoteAsset: AssetRef;
  readonly legOutcomes: readonly StrategyLegOutcome[];
  readonly serviceFee: AssetAmount;
  readonly solverFee: AssetAmount;
  readonly venueFees: AssetAmount;
  readonly networkCost: AssetAmount;
  readonly recoveryCost: AssetAmount;
  readonly terminalResidualValue: AssetAmount;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

export function strategyLifecycleActionId(value: string, context = 'strategyLifecycleAction'): ProtocolId {
  const canonical = value.toUpperCase().replaceAll('-', '_') as GraphLifecycleAction;
  enumDiscriminant(GRAPH_LIFECYCLE_ACTION, canonical, context);
  return protocolId(canonical.toLowerCase().replaceAll('_', '-'), context);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals && compareBytes(left.assetManifestHash, right.assetManifestHash) === 0;
}

function checkedAmount(value: AssetAmount, context: string, asset?: AssetRef, nonnegative = false): AssetAmount {
  object(value, context);
  const checked = assetAmount(value.asset, value.atoms, context);
  if (asset !== undefined && !sameAsset(checked.asset, asset)) throw new MalformedInputError(`${context}.asset`, 'asset mismatch');
  if (nonnegative && checked.atoms < 0n) throw new MalformedInputError(`${context}.atoms`, 'amount must be nonnegative');
  return checked;
}

function checkedDomains(values: readonly DomainRef[], context: string): readonly DomainRef[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) throw new MalformedInputError(context, 'expected 1 to 16 domains');
  const checked = values.map((value, index) => domainRef(value.domainId, value.domainManifestVersion, value.domainManifestHash, `${context}[${index}]`))
    .sort((left, right) => left.domainId.localeCompare(right.domainId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.domainId === checked[index]!.domainId) throw new DuplicateElementError(context, `domain ${checked[index]!.domainId} appears twice`);
  }
  return Object.freeze(checked);
}

function checkedLegOutcomes(values: readonly StrategyLegOutcomeInput[], domains: readonly DomainRef[], quoteAsset: AssetRef): readonly StrategyLegOutcome[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > STRATEGY_RECEIPT_MAX_LEGS) throw new MalformedInputError('strategyPackageReceipt.legOutcomes', `expected 1 to ${STRATEGY_RECEIPT_MAX_LEGS} legs`);
  const checked = values.map((value, index): StrategyLegOutcome => {
    const context = `strategyPackageReceipt.legOutcomes[${index}]`;
    object(value, context);
    enumDiscriminant(STRATEGY_LEG_OUTCOME, value.status, `${context}.status`);
    enumDiscriminant(FIELD_EVIDENCE_GRADE, value.evidenceGrade, `${context}.evidenceGrade`);
    if (typeof value.onchainEnforced !== 'boolean') throw new MalformedInputError(`${context}.onchainEnforced`, 'expected a boolean');
    const domain = domainRef(value.domain.domainId, value.domain.domainManifestVersion, value.domain.domainManifestHash, `${context}.domain`);
    if (!domains.some((candidate) => candidate.domainId === domain.domainId && candidate.domainManifestVersion === domain.domainManifestVersion && compareBytes(candidate.domainManifestHash, domain.domainManifestHash) === 0)) {
      throw new MalformedInputError(`${context}.domain`, 'leg domain is not declared by the receipt');
    }
    const requestedQuantity = checkedAmount(value.requestedQuantity, `${context}.requestedQuantity`);
    const settledQuantity = checkedAmount(value.settledQuantity, `${context}.settledQuantity`, requestedQuantity.asset);
    const positionLegId = value.positionLegId === undefined
      ? undefined
      : protocolId(value.positionLegId, `${context}.positionLegId`);
    const liabilityId = value.liabilityId === undefined
      ? undefined
      : protocolId(value.liabilityId, `${context}.liabilityId`);
    if (positionLegId !== undefined && liabilityId !== undefined) {
      throw new MalformedInputError(context, 'an execution leg cannot change both a position and a liability');
    }
    if (value.status === 'NO_EFFECT' && settledQuantity.atoms !== 0n) {
      throw new MalformedInputError(`${context}.settledQuantity`, 'a no-effect outcome cannot change a position');
    }
    return Object.freeze({
      legId: protocolId(value.legId, `${context}.legId`),
      ...(positionLegId === undefined ? {} : { positionLegId }),
      ...(liabilityId === undefined ? {} : { liabilityId }),
      domain,
      status: value.status,
      requestedQuantity,
      settledQuantity,
      grossNotional: checkedAmount(value.grossNotional, `${context}.grossNotional`, quoteAsset, true),
      venueFee: checkedAmount(value.venueFee, `${context}.venueFee`, quoteAsset, true),
      residualValue: checkedAmount(value.residualValue, `${context}.residualValue`, quoteAsset, true),
      evidenceGrade: value.evidenceGrade,
      onchainEnforced: value.onchainEnforced,
      evidenceHash: commitmentHash(value.evidenceHash, `${context}.evidenceHash`),
    });
  }).sort((left, right) => left.legId.localeCompare(right.legId));
  for (let index = 1; index < checked.length; index += 1) {
    if (checked[index - 1]!.legId === checked[index]!.legId) throw new DuplicateElementError('strategyPackageReceipt.legOutcomes', `leg ${checked[index]!.legId} appears twice`);
  }
  return Object.freeze(checked);
}

export function strategyPackageReceipt(input: StrategyPackageReceiptInput): StrategyPackageReceipt {
  object(input, 'strategyPackageReceipt');
  if (input.version !== STRATEGY_PACKAGE_RECEIPT_VERSION) throw new MalformedInputError('strategyPackageReceipt.version', `version must equal ${STRATEGY_PACKAGE_RECEIPT_VERSION}`);
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, 'strategyPackageReceipt.settlementClass');
  enumDiscriminant(TERMINAL_STATE, input.terminalState, 'strategyPackageReceipt.terminalState');
  enumDiscriminant(FINALITY_STATUS, input.finalityStatus, 'strategyPackageReceipt.finalityStatus');
  const domains = checkedDomains(input.domains, 'strategyPackageReceipt.domains');
  const quoteAsset = assetRef(input.quoteAsset.assetId, input.quoteAsset.assetManifestHash, input.quoteAsset.decimals, 'strategyPackageReceipt.quoteAsset');
  const legOutcomes = checkedLegOutcomes(input.legOutcomes, domains, quoteAsset);
  const executedAtValue = checkedUnsigned(input.executedAtValue, U64_BITS, 'strategyPackageReceipt.executedAtValue');
  const receiptNonce = checkedUnsigned(input.receiptNonce, U64_BITS, 'strategyPackageReceipt.receiptNonce');
  if (executedAtValue === 0n || receiptNonce === 0n) throw new MalformedInputError('strategyPackageReceipt', 'execution time and receipt nonce must be nonzero');
  const venueFees = checkedAmount(input.venueFees, 'strategyPackageReceipt.venueFees', quoteAsset, true);
  const residual = checkedAmount(input.terminalResidualValue, 'strategyPackageReceipt.terminalResidualValue', quoteAsset, true);
  const serviceFee = checkedAmount(input.serviceFee, 'strategyPackageReceipt.serviceFee', quoteAsset, true);
  const solverFee = checkedAmount(input.solverFee, 'strategyPackageReceipt.solverFee', quoteAsset, true);
  const networkCost = checkedAmount(input.networkCost, 'strategyPackageReceipt.networkCost', quoteAsset, true);
  const recoveryCost = checkedAmount(input.recoveryCost, 'strategyPackageReceipt.recoveryCost', quoteAsset, true);
  if (legOutcomes.reduce((sum, leg) => sum + leg.venueFee.atoms, 0n) !== venueFees.atoms) throw new MalformedInputError('strategyPackageReceipt.venueFees', 'aggregate does not equal leg venue fees');
  if (legOutcomes.reduce((sum, leg) => sum + leg.residualValue.atoms, 0n) !== residual.atoms) throw new MalformedInputError('strategyPackageReceipt.terminalResidualValue', 'aggregate does not equal leg residual values');
  if (input.terminalState === 'NO_EFFECT' && legOutcomes.some((leg) => leg.status !== 'NO_EFFECT')) throw new MalformedInputError('strategyPackageReceipt.legOutcomes', 'no-effect receipt contains a changed leg');
  if (input.terminalState === 'MANUAL_INTERVENTION' && !legOutcomes.some((leg) => leg.status === 'MANUAL_INTERVENTION')) throw new MalformedInputError('strategyPackageReceipt.legOutcomes', 'manual receipt must identify an unresolved leg');
  if (isBoundedTerminalState(input.terminalState) && residual.atoms === 0n) throw new MalformedInputError('strategyPackageReceipt.terminalResidualValue', 'a bounded terminal state must report a residual');
  if (!isBoundedTerminalState(input.terminalState) && input.terminalState !== 'MANUAL_INTERVENTION' && residual.atoms !== 0n) throw new MalformedInputError('strategyPackageReceipt.terminalResidualValue', 'this terminal state must have zero residual');
  if (isRecoveredTerminalState(input.terminalState)) {
    if (serviceFee.atoms !== 0n || solverFee.atoms !== 0n) throw new MalformedInputError('strategyPackageReceipt', 'recovered execution cannot charge service or solver fees');
    if (!legOutcomes.some((leg) => leg.status === 'RECOVERED')) throw new MalformedInputError('strategyPackageReceipt.legOutcomes', 'a recovered receipt must identify a recovered leg');
  }
  if (input.terminalState === 'NO_EFFECT' && (serviceFee.atoms !== 0n || solverFee.atoms !== 0n || venueFees.atoms !== 0n || recoveryCost.atoms !== 0n)) {
    throw new MalformedInputError('strategyPackageReceipt', 'a no-effect receipt cannot charge execution, venue, or recovery fees');
  }
  const templateVersion = Number(checkedUnsigned(input.templateVersion, U32_BITS, 'strategyPackageReceipt.templateVersion'));
  const seriesVersion = Number(checkedUnsigned(input.seriesVersion, U32_BITS, 'strategyPackageReceipt.seriesVersion'));
  const executionClassVersion = Number(checkedUnsigned(input.executionClassVersion, U32_BITS, 'strategyPackageReceipt.executionClassVersion'));
  if (templateVersion === 0 || seriesVersion === 0 || executionClassVersion === 0) throw new MalformedInputError('strategyPackageReceipt', 'manifest versions must be nonzero');
  return Object.freeze({
    version: STRATEGY_PACKAGE_RECEIPT_VERSION,
    environment: protocolId(input.environment, 'strategyPackageReceipt.environment'),
    domains,
    orderHash: commitmentHash(input.orderHash, 'strategyPackageReceipt.orderHash'),
    graphHash: commitmentHash(input.graphHash, 'strategyPackageReceipt.graphHash'),
    quoteHash: commitmentHash(input.quoteHash, 'strategyPackageReceipt.quoteHash'),
    routeHash: commitmentHash(input.routeHash, 'strategyPackageReceipt.routeHash'),
    templateId: protocolId(input.templateId, 'strategyPackageReceipt.templateId'),
    templateVersion,
    packageTemplateManifestHash: manifestHash(input.packageTemplateManifestHash, 'strategyPackageReceipt.packageTemplateManifestHash'),
    seriesId: protocolId(input.seriesId, 'strategyPackageReceipt.seriesId'),
    seriesVersion,
    seriesManifestHash: manifestHash(input.seriesManifestHash, 'strategyPackageReceipt.seriesManifestHash'),
    executionClassId: protocolId(input.executionClassId, 'strategyPackageReceipt.executionClassId'),
    executionClassVersion,
    executionClassManifestHash: manifestHash(input.executionClassManifestHash, 'strategyPackageReceipt.executionClassManifestHash'),
    lifecycleAction: strategyLifecycleActionId(input.lifecycleAction, 'strategyPackageReceipt.lifecycleAction'),
    owner: protocolId(input.owner, 'strategyPackageReceipt.owner'),
    solverId: protocolId(input.solverId, 'strategyPackageReceipt.solverId'),
    settlementClass: input.settlementClass,
    terminalState: input.terminalState,
    quoteAsset,
    legOutcomes,
    serviceFee,
    solverFee,
    venueFees,
    networkCost,
    recoveryCost,
    terminalResidualValue: residual,
    finalityStatus: input.finalityStatus,
    executedAtValue,
    receiptNonce,
  });
}

function encodeLegOutcome(writer: CanonicalWriter, value: StrategyLegOutcome): void {
  encodeProtocolId(writer, value.legId, 'legId');
  writer.writeOptional(value.positionLegId, (element, positionLegId) => encodeProtocolId(element, positionLegId, 'positionLegId'), 'positionLegId');
  writer.writeOptional(value.liabilityId, (element, liabilityId) => encodeProtocolId(element, liabilityId, 'liabilityId'), 'liabilityId');
  encodeDomainRef(writer, value.domain);
  writer.writeEnum(STRATEGY_LEG_OUTCOME, value.status, 'status');
  encodeAssetAmount(writer, value.requestedQuantity);
  encodeAssetAmount(writer, value.settledQuantity);
  encodeAssetAmount(writer, value.grossNotional);
  encodeAssetAmount(writer, value.venueFee);
  encodeAssetAmount(writer, value.residualValue);
  writer.writeEnum(FIELD_EVIDENCE_GRADE, value.evidenceGrade, 'evidenceGrade');
  writer.writeBool(value.onchainEnforced, 'onchainEnforced');
  encodeCommitmentHash(writer, value.evidenceHash, 'evidenceHash');
}

export function strategyPackageReceiptBytes(input: StrategyPackageReceiptInput): Uint8Array {
  const value = strategyPackageReceipt(input);
  return canonicalBytes((writer) => {
    writer.writeU32(value.version, 'version');
    encodeProtocolId(writer, value.environment, 'environment');
    writer.writeArray(value.domains, encodeDomainRef, 'domains');
    encodeCommitmentHash(writer, value.orderHash, 'orderHash');
    encodeCommitmentHash(writer, value.graphHash, 'graphHash');
    encodeCommitmentHash(writer, value.quoteHash, 'quoteHash');
    encodeCommitmentHash(writer, value.routeHash, 'routeHash');
    encodeProtocolId(writer, value.templateId, 'templateId');
    writer.writeU32(value.templateVersion, 'templateVersion');
    encodeManifestHash(writer, value.packageTemplateManifestHash, 'packageTemplateManifestHash');
    encodeProtocolId(writer, value.seriesId, 'seriesId');
    writer.writeU32(value.seriesVersion, 'seriesVersion');
    encodeManifestHash(writer, value.seriesManifestHash, 'seriesManifestHash');
    encodeProtocolId(writer, value.executionClassId, 'executionClassId');
    writer.writeU32(value.executionClassVersion, 'executionClassVersion');
    encodeManifestHash(writer, value.executionClassManifestHash, 'executionClassManifestHash');
    encodeProtocolId(writer, value.lifecycleAction, 'lifecycleAction');
    encodeProtocolId(writer, value.owner, 'owner');
    encodeProtocolId(writer, value.solverId, 'solverId');
    writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass, 'settlementClass');
    writer.writeEnum(TERMINAL_STATE, value.terminalState, 'terminalState');
    encodeAssetRef(writer, value.quoteAsset);
    writer.writeArray(value.legOutcomes, encodeLegOutcome, 'legOutcomes');
    encodeAssetAmount(writer, value.serviceFee);
    encodeAssetAmount(writer, value.solverFee);
    encodeAssetAmount(writer, value.venueFees);
    encodeAssetAmount(writer, value.networkCost);
    encodeAssetAmount(writer, value.recoveryCost);
    encodeAssetAmount(writer, value.terminalResidualValue);
    writer.writeEnum(FINALITY_STATUS, value.finalityStatus, 'finalityStatus');
    writer.writeU64(value.executedAtValue, 'executedAtValue');
    writer.writeU64(value.receiptNonce, 'receiptNonce');
  });
}

export function strategyPackageReceiptHash(input: StrategyPackageReceiptInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.STRATEGY_RECEIPT, strategyPackageReceiptBytes(input)), 'strategyPackageReceiptHash');
}

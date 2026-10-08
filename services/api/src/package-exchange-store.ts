import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bs58 from "bs58";
import {
  addImpliedLiquidity,
  addMultiPackageImpliedLiquidity as admitMultiPackageImpliedLiquidity,
  applyPackageBookHalt,
  amendPackageBookEntry,
  bytesEqual,
  cancelPackageBookEntry,
  clearPackageReopeningAuction,
  commitmentHash,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  crossBatchClearingReceipt,
  crossBatchExternalExecutionIntent,
  economicStrategySeries,
  economicStrategySeriesBytes,
  economicStrategySeriesHash,
  emptyPackageBook,
  invalidateImpliedSource,
  matchPackageOrder,
  packageAllocation,
  packageAllocationHash,
  packageBookAmendment,
  packageBookAmendmentHash,
  packageBookHalt,
  packageBookHaltHash,
  packageBookCancellation,
  packageBookCancellationHash,
  packageBookEntry,
  packageBookState,
  packageMatchingPolicy,
  packageMatchingPolicyBytes,
  packageMatchingPolicyHash,
  packageReopeningResult,
  packageReopeningResultHash,
  packageReopeningSettlementHandoff,
  packageReopeningSettlementHandoffHash,
  packageReopeningSnapshotHash,
  packageSettlementCommitment,
  packageSettlementCommitmentHash,
  packageSettlementHandoff,
  packageSettlementHandoffHash,
  packageSettlementReadiness,
  packageSettlementReadinessHash,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  nettingResultHash,
  nettingAllocationSettlementEvidence,
  nettingSettlementCompletionReceipt,
  nettingFinalAllocationReceipt,
  verifyNettingAllocationSettlementEvidence,
  verifyNettingAllocationExecutionAuthorization,
  verifyNettingExternalExecutionEvidence,
  verifyNettingExternalExecutionIntent,
  verifyNettingFinalAllocationReceipt,
  verifyNettingSettlementCompletionReceipt,
  verifyCrossBatchClearingPlan,
  verifyCrossBatchClearingReceipt,
  verifyCrossBatchExternalExecutionEvidence,
  verifyCrossBatchExternalExecutionIntent,
  PACKAGE_SETTLEMENT_MAX_ALLOCATIONS,
  parseProtocolJson,
  protocolId,
  queuePackageReopeningOrder,
  seriesExecutionClass,
  seriesExecutionClassBytes,
  seriesExecutionClassHash,
  stringifyProtocolJson,
  toHex,
  verifyPackageAllocation,
  verifyPackageReopeningSettlementHandoff,
  verifyPackageSettlementHandoff,
  verifyNettingResultAgainstPolicy,
} from "@naryx/protocol-types";
import type {
  CommitmentHash,
  CrossBatchClearingPlan,
  CrossBatchClearingPolicy,
  CrossBatchClearingPolicyInput,
  CrossBatchClearingReceipt,
  CrossBatchExternalExecutionEvidence,
  CrossBatchExternalExecutionIntent,
  CrossBatchNettingResolution,
  EconomicStrategySeries,
  EconomicStrategySeriesInput,
  EconomicStrategySeriesSupportInput,
  ImpliedLiquidityInput,
  MultiPackageImpliedLiquidityInput,
  PackageAllocation,
  PackageBookAmendmentInput,
  PackageBookHalt,
  PackageBookHaltInput,
  PackageBookEntry,
  PackageBookState,
  PackageMatchingPolicy,
  PackageMatchingPolicyInput,
  PackageMatchRejection,
  PackageReopeningResult,
  PackageReopeningSettlementHandoff,
  PackageSettlementCommitment,
  PackageSettlementCommitmentInput,
  PackageSettlementHandoff,
  PackageSettlementReadiness,
  PackageSettlementEvidenceKind,
  PackageTakerOrderInput,
  NettingPolicyManifest,
  NettingPolicyManifestInput,
  NettingResult,
  NettingExternalExecutionIntent,
  NettingExternalExecutionEvidence,
  NettingAllocationSettlementEvidence,
  NettingAllocationExecutionAuthorization,
  NettingFinalAllocationReceipt,
  NettingSettlementCompletionReceipt,
  SeriesExecutionClass,
  SeriesExecutionClassInput,
  SeriesExecutionClassSupportInput,
} from "@naryx/protocol-types";

export type ExchangeDocumentKind = "SERIES" | "EXECUTION_CLASS" | "MATCHING_POLICY";

export interface RegisteredExchangeDocument {
  readonly kind: ExchangeDocumentKind;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly documentHashHex: string;
  readonly created: boolean;
}

export interface RegisteredStrategySeriesRecord {
  readonly documentHashHex: string;
  readonly document: EconomicStrategySeries;
}

export interface RegisteredExecutionClassRecord {
  readonly documentHashHex: string;
  readonly document: SeriesExecutionClass;
}

export type PackageExchangeSubmitResult =
  | {
      readonly accepted: true;
      readonly replayed: boolean;
      readonly allocation: PackageAllocation;
      readonly allocationHashHex: string;
      readonly settlementCommitmentHashHex: string;
      readonly settlementHandoff?: PackageSettlementHandoff;
      readonly settlementHandoffHashHex?: string;
    }
  | { readonly accepted: false; readonly rejection: PackageMatchRejection };

export interface PackageTapeRecord {
  readonly cursor: number;
  readonly allocation: PackageAllocation;
  readonly allocationHashHex: string;
  readonly recordedAtMs: number;
}

export interface PackageExchangeCancellationResult {
  readonly cancellationHashHex: string;
  readonly replayed: boolean;
}

export interface PackageExchangeAmendmentResult {
  readonly amendmentHashHex: string;
  readonly entry: PackageBookEntry;
  readonly replayed: boolean;
}

export interface PackageExchangeHaltResult {
  readonly halt: PackageBookHalt;
  readonly haltHashHex: string;
  readonly haltedSnapshotHashHex: string;
  readonly recordedAtMs: number;
  readonly replayed: boolean;
}

export interface PackageExchangeHaltRecord {
  readonly halt: PackageBookHalt;
  readonly haltHashHex: string;
  readonly haltedSnapshotHashHex: string;
  readonly recordedAtMs: number;
}

export interface PackageReopeningQueueResult {
  readonly entry: PackageBookEntry;
  readonly settlementCommitmentHashHex: string;
  readonly replayed: boolean;
}

export interface PackageReopeningClearResult {
  readonly result: PackageReopeningResult;
  readonly resultHashHex: string;
  readonly settlementHandoff?: PackageReopeningSettlementHandoff;
  readonly settlementHandoffHashHex?: string;
  readonly replayed: boolean;
}

export interface PackageSettlementObligation {
  readonly evidenceKind: PackageSettlementEvidenceKind;
  readonly evidenceHashHex: string;
  readonly fillSequence: bigint;
  readonly role: "TAKER" | "MAKER" | "BID" | "ASK";
  readonly counterpartyOrderIdHex?: string;
  readonly liquiditySource: "DIRECT" | "IMPLIED";
  readonly priceTicks: bigint;
  readonly quantity: bigint;
}

export interface PackageSettlementProgress {
  readonly readiness: PackageSettlementReadiness;
  readonly readinessHashHex: string;
  readonly obligations: readonly PackageSettlementObligation[];
}

export type PackageSettlementAuthorizationScheme = "ED25519" | "EIP712_SECP256K1";

export interface PackageSettlementAuthorizationEvidenceInput {
  readonly scheme: PackageSettlementAuthorizationScheme;
  readonly signature: string;
}

export interface PackageSettlementAuthorizationEvidence extends PackageSettlementAuthorizationEvidenceInput {
  readonly packageOrderIdHex: string;
  readonly settlementCommitmentHashHex: string;
  readonly participantId: string;
  readonly authorizedAtMs: number;
}

export interface PreparedNettingBatchPackage {
  readonly packageOrderIdHex: string;
  readonly strategyOrderHashHex: string;
  readonly settlementReadinessHashHex: string;
}

export interface PreparedNettingBatch {
  readonly status: "PREPARED";
  readonly proofHashHex: string;
  readonly policy: NettingPolicyManifest;
  readonly result: NettingResult;
  readonly externalExecutions: readonly NettingExternalExecutionRecord[];
  readonly externalExecutionStatus: "NOT_REQUIRED" | "PENDING" | "EXACT_FILLED" | "RECOVERY_REQUIRED";
  readonly finalAllocationReceipt?: NettingFinalAllocationReceipt;
  readonly settlementEvidence: readonly NettingAllocationSettlementEvidence[];
  readonly settlementStatus: "AWAITING_FINAL_ALLOCATION" | "AWAITING_SETTLEMENT" | "SETTLED";
  readonly settlementCompletionReceipt?: NettingSettlementCompletionReceipt;
  readonly packages: readonly PreparedNettingBatchPackage[];
  readonly recordedAtMs: number;
}

export interface PreparedNettingBatchRecordInput {
  readonly policy: NettingPolicyManifestInput | NettingPolicyManifest;
  readonly result: NettingResult;
  readonly externalIntents: readonly NettingExternalExecutionIntent[];
  readonly packages: readonly PreparedNettingBatchPackage[];
}

export interface NettingExternalExecutionRecord {
  readonly intent: NettingExternalExecutionIntent;
  readonly evidence?: NettingExternalExecutionEvidence;
  readonly crossBatchClearingPlanHashHex?: string;
  readonly crossBatchStatus?: "PENDING" | "EXACT_FILLED" | "RECOVERY_REQUIRED";
}

export interface PreparedCrossBatchClearing {
  readonly status: "PENDING" | "EXACT_FILLED" | "RECOVERY_REQUIRED";
  readonly policy: CrossBatchClearingPolicy;
  readonly sourceIntents: readonly NettingExternalExecutionIntent[];
  readonly plan: CrossBatchClearingPlan;
  readonly intent?: CrossBatchExternalExecutionIntent;
  readonly evidence?: CrossBatchExternalExecutionEvidence;
  readonly receipt?: CrossBatchClearingReceipt;
  readonly recordedAtMs: number;
}

export interface NettingAllocationExecutionObservation {
  readonly authorizationHash: Uint8Array | string;
  readonly observedAtUnit: NettingAllocationSettlementEvidence["observedAtUnit"];
  readonly observedAtValue: bigint;
  readonly settlementReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

function nettingExternalExecutionStatus(
  records: readonly NettingExternalExecutionRecord[],
): PreparedNettingBatch["externalExecutionStatus"] {
  if (records.length === 0) return "NOT_REQUIRED";
  if (records.some((record) => record.crossBatchStatus === "RECOVERY_REQUIRED")) {
    return "RECOVERY_REQUIRED";
  }
  if (records.some((record) => record.evidence !== undefined && record.evidence.outcome !== "EXACT_FILLED")) {
    return "RECOVERY_REQUIRED";
  }
  return records.every((record) => record.evidence?.outcome === "EXACT_FILLED"
    || record.crossBatchStatus === "EXACT_FILLED") ? "EXACT_FILLED" : "PENDING";
}

function nettingSettlementStatus(
  finalAllocationReceipt: NettingFinalAllocationReceipt | undefined,
  settlementCompletionReceipt: NettingSettlementCompletionReceipt | undefined,
): PreparedNettingBatch["settlementStatus"] {
  if (finalAllocationReceipt === undefined) return "AWAITING_FINAL_ALLOCATION";
  return settlementCompletionReceipt === undefined ? "AWAITING_SETTLEMENT" : "SETTLED";
}

export const MAX_TAPE_PAGE = 100;

export interface PackageExchangeStoreOptions {
  readonly seriesSupport: EconomicStrategySeriesSupportInput;
  readonly executionClassSupport: SeriesExecutionClassSupportInput;
  readonly clock?: () => number;
}

/** Resting entries one package book may hold, and one participant within it. */
export const MAX_BOOK_ENTRIES = 2_000;
/** Implied entries one batch may add. */
export const MAX_IMPLIED_BATCH = 16;
export const MAX_ENTRIES_PER_PARTICIPANT = 250;

export class PackageExchangeStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageExchangeStoreError";
    this.code = code;
  }
}

const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS exchange_documents (
  document_hash BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('SERIES', 'EXECUTION_CLASS', 'MATCHING_POLICY')),
  subject_id TEXT NOT NULL,
  subject_version INTEGER NOT NULL CHECK (subject_version > 0),
  canonical_bytes BLOB NOT NULL,
  document_json TEXT NOT NULL,
  UNIQUE (kind, subject_id, subject_version)
) STRICT;
CREATE TABLE IF NOT EXISTS execution_class_bindings (
  class_hash BLOB PRIMARY KEY REFERENCES exchange_documents(document_hash),
  series_hash BLOB NOT NULL REFERENCES exchange_documents(document_hash),
  matching_policy_hash BLOB NOT NULL REFERENCES exchange_documents(document_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS package_books (
  execution_class_id TEXT PRIMARY KEY,
  class_hash BLOB NOT NULL REFERENCES execution_class_bindings(class_hash),
  halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
  next_sequence TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_entries (
  entry_id BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  entry_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_allocations (
  allocation_hash BLOB PRIMARY KEY,
  taker_order_id BLOB NOT NULL UNIQUE,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  allocation_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_commitments (
  package_order_id BLOB PRIMARY KEY,
  commitment_hash BLOB NOT NULL UNIQUE,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  strategy_order_hash BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  commitment_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_authorizations (
  package_order_id BLOB PRIMARY KEY REFERENCES package_book_settlement_commitments(package_order_id),
  commitment_hash BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('ED25519', 'EIP712_SECP256K1')),
  signature TEXT NOT NULL,
  authorized_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_handoffs (
  allocation_hash BLOB PRIMARY KEY REFERENCES package_book_allocations(allocation_hash),
  handoff_hash BLOB NOT NULL UNIQUE,
  handoff_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_settlement_obligations (
  allocation_hash BLOB NOT NULL REFERENCES package_book_allocations(allocation_hash),
  fill_index INTEGER NOT NULL CHECK (fill_index >= 0),
  fill_sequence TEXT NOT NULL,
  package_order_id BLOB NOT NULL REFERENCES package_book_settlement_commitments(package_order_id),
  role TEXT NOT NULL CHECK (role IN ('TAKER', 'MAKER')),
  counterparty_order_id BLOB,
  maker_source TEXT NOT NULL CHECK (maker_source IN ('DIRECT', 'IMPLIED')),
  price_ticks TEXT NOT NULL,
  quantity_atoms TEXT NOT NULL,
  PRIMARY KEY (allocation_hash, fill_index, role)
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_reopening_results (
  result_hash BLOB PRIMARY KEY,
  auction_id BLOB NOT NULL UNIQUE,
  opening_snapshot_hash BLOB NOT NULL,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  result_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_reopening_handoffs (
  result_hash BLOB PRIMARY KEY REFERENCES package_book_reopening_results(result_hash),
  handoff_hash BLOB NOT NULL UNIQUE,
  handoff_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_reopening_obligations (
  result_hash BLOB NOT NULL REFERENCES package_book_reopening_results(result_hash),
  fill_index INTEGER NOT NULL CHECK (fill_index >= 0),
  fill_sequence TEXT NOT NULL,
  package_order_id BLOB NOT NULL REFERENCES package_book_settlement_commitments(package_order_id),
  role TEXT NOT NULL CHECK (role IN ('BID', 'ASK')),
  counterparty_order_id BLOB NOT NULL REFERENCES package_book_settlement_commitments(package_order_id),
  price_ticks TEXT NOT NULL,
  quantity_atoms TEXT NOT NULL,
  PRIMARY KEY (result_hash, fill_index, role)
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_cancellations (
  cancellation_hash BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  entry_id BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (execution_class_id, entry_id)
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_amendments (
  amendment_hash BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  entry_id BLOB NOT NULL,
  participant_id TEXT NOT NULL,
  amendment_json TEXT NOT NULL,
  amended_entry_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_halts (
  halt_hash BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  expected_open_snapshot_hash BLOB NOT NULL,
  halted_snapshot_hash BLOB NOT NULL,
  halt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS package_book_consumed_sources (
  source_key BLOB PRIMARY KEY,
  execution_class_id TEXT NOT NULL REFERENCES package_books(execution_class_id),
  allocation_hash BLOB NOT NULL REFERENCES package_book_allocations(allocation_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS implied_source_versions (
  source_id TEXT PRIMARY KEY,
  current_version TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_batches (
  proof_hash BLOB PRIMARY KEY,
  netting_policy_hash BLOB NOT NULL,
  policy_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'PREPARED'),
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_batch_packages (
  proof_hash BLOB NOT NULL REFERENCES netting_batches(proof_hash),
  package_order_id BLOB NOT NULL UNIQUE REFERENCES package_book_settlement_commitments(package_order_id),
  strategy_order_hash BLOB NOT NULL,
  settlement_readiness_hash BLOB NOT NULL,
  PRIMARY KEY (proof_hash, package_order_id)
) STRICT;
CREATE TABLE IF NOT EXISTS netting_external_execution_intents (
  intent_hash BLOB PRIMARY KEY,
  proof_hash BLOB NOT NULL REFERENCES netting_batches(proof_hash),
  instrument_hash BLOB NOT NULL,
  intent_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (proof_hash, instrument_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS netting_external_execution_evidence (
  evidence_hash BLOB PRIMARY KEY,
  intent_hash BLOB NOT NULL UNIQUE REFERENCES netting_external_execution_intents(intent_hash),
  evidence_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cross_batch_clearing_plans (
  plan_hash BLOB PRIMARY KEY,
  policy_hash BLOB NOT NULL,
  policy_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  external_intent_hash BLOB UNIQUE,
  external_intent_json TEXT,
  recorded_at_ms INTEGER NOT NULL,
  CHECK ((external_intent_hash IS NULL) = (external_intent_json IS NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS cross_batch_clearing_sources (
  plan_hash BLOB NOT NULL REFERENCES cross_batch_clearing_plans(plan_hash),
  source_intent_hash BLOB NOT NULL UNIQUE REFERENCES netting_external_execution_intents(intent_hash),
  PRIMARY KEY (plan_hash, source_intent_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS cross_batch_execution_evidence (
  evidence_hash BLOB PRIMARY KEY,
  plan_hash BLOB NOT NULL UNIQUE REFERENCES cross_batch_clearing_plans(plan_hash),
  evidence_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cross_batch_clearing_receipts (
  receipt_hash BLOB PRIMARY KEY,
  plan_hash BLOB NOT NULL UNIQUE REFERENCES cross_batch_clearing_plans(plan_hash),
  receipt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_final_allocation_receipts (
  proof_hash BLOB PRIMARY KEY REFERENCES netting_batches(proof_hash),
  receipt_hash BLOB NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_allocation_execution_authorizations (
  authorization_hash BLOB PRIMARY KEY,
  proof_hash BLOB NOT NULL REFERENCES netting_batches(proof_hash),
  final_allocation_receipt_hash BLOB NOT NULL REFERENCES netting_final_allocation_receipts(receipt_hash),
  allocation_receipt_hash BLOB NOT NULL UNIQUE,
  authorization_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_allocation_settlement_evidence (
  evidence_hash BLOB PRIMARY KEY,
  proof_hash BLOB NOT NULL REFERENCES netting_batches(proof_hash),
  final_allocation_receipt_hash BLOB NOT NULL REFERENCES netting_final_allocation_receipts(receipt_hash),
  allocation_receipt_hash BLOB NOT NULL UNIQUE,
  evidence_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS netting_settlement_completion_receipts (
  proof_hash BLOB PRIMARY KEY REFERENCES netting_batches(proof_hash),
  final_allocation_receipt_hash BLOB NOT NULL UNIQUE REFERENCES netting_final_allocation_receipts(receipt_hash),
  receipt_hash BLOB NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS reject_exchange_document_change
  BEFORE UPDATE ON exchange_documents
  BEGIN SELECT RAISE(ABORT, 'exchange documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_exchange_document_delete
  BEFORE DELETE ON exchange_documents
  BEGIN SELECT RAISE(ABORT, 'exchange documents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_class_binding_change
  BEFORE UPDATE ON execution_class_bindings
  BEGIN SELECT RAISE(ABORT, 'execution class bindings are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_allocation_change
  BEFORE UPDATE ON package_book_allocations
  BEGIN SELECT RAISE(ABORT, 'package allocations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_allocation_delete
  BEFORE DELETE ON package_book_allocations
  BEGIN SELECT RAISE(ABORT, 'package allocations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_commitment_change
  BEFORE UPDATE ON package_book_settlement_commitments
  BEGIN SELECT RAISE(ABORT, 'package settlement commitments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_commitment_delete
  BEFORE DELETE ON package_book_settlement_commitments
  BEGIN SELECT RAISE(ABORT, 'package settlement commitments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_authorization_change
  BEFORE UPDATE ON package_book_settlement_authorizations
  BEGIN SELECT RAISE(ABORT, 'package settlement authorizations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_authorization_delete
  BEFORE DELETE ON package_book_settlement_authorizations
  BEGIN SELECT RAISE(ABORT, 'package settlement authorizations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_handoff_change
  BEFORE UPDATE ON package_book_settlement_handoffs
  BEGIN SELECT RAISE(ABORT, 'package settlement handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_handoff_delete
  BEFORE DELETE ON package_book_settlement_handoffs
  BEGIN SELECT RAISE(ABORT, 'package settlement handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_obligation_change
  BEFORE UPDATE ON package_book_settlement_obligations
  BEGIN SELECT RAISE(ABORT, 'package settlement obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_settlement_obligation_delete
  BEFORE DELETE ON package_book_settlement_obligations
  BEGIN SELECT RAISE(ABORT, 'package settlement obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_result_change
  BEFORE UPDATE ON package_book_reopening_results
  BEGIN SELECT RAISE(ABORT, 'package reopening results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_result_delete
  BEFORE DELETE ON package_book_reopening_results
  BEGIN SELECT RAISE(ABORT, 'package reopening results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_handoff_change
  BEFORE UPDATE ON package_book_reopening_handoffs
  BEGIN SELECT RAISE(ABORT, 'package reopening handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_handoff_delete
  BEFORE DELETE ON package_book_reopening_handoffs
  BEGIN SELECT RAISE(ABORT, 'package reopening handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_obligation_change
  BEFORE UPDATE ON package_book_reopening_obligations
  BEGIN SELECT RAISE(ABORT, 'package reopening obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_reopening_obligation_delete
  BEFORE DELETE ON package_book_reopening_obligations
  BEGIN SELECT RAISE(ABORT, 'package reopening obligations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cancellation_change
  BEFORE UPDATE ON package_book_cancellations
  BEGIN SELECT RAISE(ABORT, 'package cancellations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cancellation_delete
  BEFORE DELETE ON package_book_cancellations
  BEGIN SELECT RAISE(ABORT, 'package cancellations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_amendment_change
  BEFORE UPDATE ON package_book_amendments
  BEGIN SELECT RAISE(ABORT, 'package amendments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_amendment_delete
  BEFORE DELETE ON package_book_amendments
  BEGIN SELECT RAISE(ABORT, 'package amendments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_halt_change
  BEFORE UPDATE ON package_book_halts
  BEGIN SELECT RAISE(ABORT, 'package halts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_halt_delete
  BEFORE DELETE ON package_book_halts
  BEGIN SELECT RAISE(ABORT, 'package halts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consumed_source_change
  BEFORE UPDATE ON package_book_consumed_sources
  BEGIN SELECT RAISE(ABORT, 'consumed sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_consumed_source_delete
  BEFORE DELETE ON package_book_consumed_sources
  BEGIN SELECT RAISE(ABORT, 'consumed sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_batch_change
  BEFORE UPDATE ON netting_batches
  BEGIN SELECT RAISE(ABORT, 'netting batches are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_batch_delete
  BEFORE DELETE ON netting_batches
  BEGIN SELECT RAISE(ABORT, 'netting batches are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_batch_package_change
  BEFORE UPDATE ON netting_batch_packages
  BEGIN SELECT RAISE(ABORT, 'netting batch packages are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_batch_package_delete
  BEFORE DELETE ON netting_batch_packages
  BEGIN SELECT RAISE(ABORT, 'netting batch packages are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_external_intent_change
  BEFORE UPDATE ON netting_external_execution_intents
  BEGIN SELECT RAISE(ABORT, 'netting external execution intents are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_external_intent_delete
  BEFORE DELETE ON netting_external_execution_intents
  BEGIN SELECT RAISE(ABORT, 'netting external execution intents are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_external_evidence_change
  BEFORE UPDATE ON netting_external_execution_evidence
  BEGIN SELECT RAISE(ABORT, 'netting external execution evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_external_evidence_delete
  BEFORE DELETE ON netting_external_execution_evidence
  BEGIN SELECT RAISE(ABORT, 'netting external execution evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_plan_change
  BEFORE UPDATE ON cross_batch_clearing_plans
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing plans are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_plan_delete
  BEFORE DELETE ON cross_batch_clearing_plans
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing plans are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_source_change
  BEFORE UPDATE ON cross_batch_clearing_sources
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_source_delete
  BEFORE DELETE ON cross_batch_clearing_sources
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing sources are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_execution_evidence_change
  BEFORE UPDATE ON cross_batch_execution_evidence
  BEGIN SELECT RAISE(ABORT, 'cross batch execution evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_execution_evidence_delete
  BEFORE DELETE ON cross_batch_execution_evidence
  BEGIN SELECT RAISE(ABORT, 'cross batch execution evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_receipt_change
  BEFORE UPDATE ON cross_batch_clearing_receipts
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_cross_batch_clearing_receipt_delete
  BEFORE DELETE ON cross_batch_clearing_receipts
  BEGIN SELECT RAISE(ABORT, 'cross batch clearing receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_final_allocation_receipt_change
  BEFORE UPDATE ON netting_final_allocation_receipts
  BEGIN SELECT RAISE(ABORT, 'netting final allocation receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_final_allocation_receipt_delete
  BEFORE DELETE ON netting_final_allocation_receipts
  BEGIN SELECT RAISE(ABORT, 'netting final allocation receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_execution_authorization_change
  BEFORE UPDATE ON netting_allocation_execution_authorizations
  BEGIN SELECT RAISE(ABORT, 'netting allocation execution authorizations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_execution_authorization_delete
  BEFORE DELETE ON netting_allocation_execution_authorizations
  BEGIN SELECT RAISE(ABORT, 'netting allocation execution authorizations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_settlement_evidence_change
  BEFORE UPDATE ON netting_allocation_settlement_evidence
  BEGIN SELECT RAISE(ABORT, 'netting allocation settlement evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_allocation_settlement_evidence_delete
  BEFORE DELETE ON netting_allocation_settlement_evidence
  BEGIN SELECT RAISE(ABORT, 'netting allocation settlement evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_settlement_completion_receipt_change
  BEFORE UPDATE ON netting_settlement_completion_receipts
  BEGIN SELECT RAISE(ABORT, 'netting settlement completion receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_netting_settlement_completion_receipt_delete
  BEFORE DELETE ON netting_settlement_completion_receipts
  BEGIN SELECT RAISE(ABORT, 'netting settlement completion receipts are append-only'); END;
CREATE INDEX IF NOT EXISTS package_book_allocations_by_time ON package_book_allocations(execution_class_id, recorded_at_ms);
CREATE INDEX IF NOT EXISTS package_book_reopening_obligations_by_order ON package_book_reopening_obligations(package_order_id);
CREATE TABLE IF NOT EXISTS package_book_trades (
  allocation_rowid INTEGER PRIMARY KEY,
  allocation_hash BLOB NOT NULL UNIQUE REFERENCES package_book_allocations(allocation_hash),
  execution_class_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS package_book_trades_by_class ON package_book_trades(execution_class_id, allocation_rowid);
CREATE INDEX IF NOT EXISTS package_book_trades_by_time ON package_book_trades(execution_class_id, recorded_at_ms, allocation_rowid);
CREATE TRIGGER IF NOT EXISTS reject_trade_change
  BEFORE UPDATE ON package_book_trades
  BEGIN SELECT RAISE(ABORT, 'package trades are append-only'); END;
CREATE TRIGGER IF NOT EXISTS reject_trade_delete
  BEFORE DELETE ON package_book_trades
  BEGIN SELECT RAISE(ABORT, 'package trades are append-only'); END;
`;

interface DocumentRow {
  readonly document_hash: unknown;
  readonly canonical_bytes: unknown;
  readonly document_json: unknown;
}

function repositoryRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function requireDatabasePath(dbPath: string): string {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:" || !isAbsolute(dbPath)) {
    throw new PackageExchangeStoreError("INVALID_PATH", "Database path must be an absolute durable file path.");
  }
  const resolved = resolve(dbPath);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === resolve(root) || resolved.startsWith(resolve(root) + sep))) {
    throw new PackageExchangeStoreError("INVALID_PATH", "Database path must remain outside the repository checkout.");
  }
  return resolved;
}

function guarded<T>(code: string, message: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PackageExchangeStoreError) throw error;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new PackageExchangeStoreError(code, `${message}${detail}`);
  }
}

function hashBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return Uint8Array.from(value);
}

function jsonText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return value;
}

function sequenceText(value: bigint): string {
  return value.toString(10);
}

function storedBigInt(value: unknown, field: string, signed = false): bigint {
  if (typeof value !== "string" || !(signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value)) {
    throw new PackageExchangeStoreError("CORRUPT_ROW", `Stored ${field} is invalid.`);
  }
  return BigInt(value);
}

function settlementAuthorizationEvidence(
  input: PackageSettlementAuthorizationEvidenceInput,
): PackageSettlementAuthorizationEvidenceInput {
  if (typeof input !== "object" || input === null) {
    throw new PackageExchangeStoreError("INVALID_INPUT", "Settlement authorization evidence must be an object.");
  }
  if (input.scheme === "ED25519") {
    if (typeof input.signature !== "string") {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Ed25519 settlement authorization must be a signature string.");
    }
    try {
      const signature = bs58.decode(input.signature);
      if (signature.length !== 64 || bs58.encode(signature) !== input.signature) throw new Error("noncanonical signature");
    } catch {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Ed25519 settlement authorization is not canonical base58.");
    }
    return Object.freeze({ scheme: input.scheme, signature: input.signature });
  }
  if (input.scheme === "EIP712_SECP256K1" && /^0x[0-9a-f]{130}$/.test(input.signature)) {
    return Object.freeze({ scheme: input.scheme, signature: input.signature });
  }
  throw new PackageExchangeStoreError("INVALID_INPUT", "Settlement authorization scheme or signature is invalid.");
}

/**
 * Durable exchange state: immutable series, execution-class, and matching-policy documents
 * plus one package book per execution class. Every mutation runs the protocol matcher inside
 * one immediate transaction, and a global primary key on consumed source keys makes a source
 * reservation single-use even if two books were ever handed the same reservation.
 */
export class SqlitePackageExchangeStore {
  private readonly db: Database.Database;
  private readonly options: PackageExchangeStoreOptions;
  private readonly clock: () => number;

  constructor(dbPath: string, options: PackageExchangeStoreOptions) {
    const resolved = requireDatabasePath(dbPath);
    if (typeof options !== "object" || options === null) {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Store options must name the supported series semantics.");
    }
    this.options = options;
    this.clock = options.clock ?? Date.now;
    mkdirSync(dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const journalMode = db.pragma("journal_mode = WAL", { simple: true });
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      if (String(journalMode).toLowerCase() !== "wal" || db.pragma("foreign_keys", { simple: true }) !== 1) {
        throw new PackageExchangeStoreError("PRAGMA_FAILED", "Durability pragmas were not applied.");
      }
      const indexedTrades = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'package_book_trades'").get() !== undefined;
      db.exec(SCHEMA_SQL);
      // Stores created before trades were indexed index their existing trades once.
      if (!indexedTrades) {
        db.exec(
          `INSERT INTO package_book_trades (allocation_rowid, allocation_hash, execution_class_id, recorded_at_ms)
           SELECT rowid, allocation_hash, execution_class_id, recorded_at_ms FROM package_book_allocations WHERE json_array_length(allocation_json, '$.fills') > 0`,
        );
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- documents

  registerMatchingPolicy(input: PackageMatchingPolicyInput): RegisteredExchangeDocument {
    const policy = guarded("INVALID_INPUT", "Matching policy is invalid.", () => packageMatchingPolicy(input));
    return this.transaction(() =>
      this.insertDocument(
        "MATCHING_POLICY",
        policy.executionClassId,
        policy.matchingPolicyVersion,
        packageMatchingPolicyBytes(policy),
        packageMatchingPolicyHash(policy),
        policy,
      ),
    );
  }

  registerSeries(input: EconomicStrategySeriesInput): RegisteredExchangeDocument {
    const series = guarded("INVALID_INPUT", "Strategy series is invalid.", () =>
      economicStrategySeries(input, this.options.seriesSupport),
    );
    return this.transaction(() =>
      this.insertDocument(
        "SERIES",
        series.seriesId,
        series.seriesVersion,
        economicStrategySeriesBytes(series, this.options.seriesSupport),
        economicStrategySeriesHash(series, this.options.seriesSupport),
        series,
      ),
    );
  }

  registerExecutionClass(input: SeriesExecutionClassInput): RegisteredExchangeDocument {
    const executionClass = guarded("INVALID_INPUT", "Execution class is invalid.", () =>
      seriesExecutionClass(input, this.options.executionClassSupport),
    );
    return this.transaction(() => {
      const series = this.documentByHash("SERIES", executionClass.seriesManifestHash);
      const seriesValue = series === undefined ? undefined : this.loadSeries(series);
      if (
        seriesValue === undefined ||
        seriesValue.seriesId !== executionClass.seriesId ||
        seriesValue.seriesVersion !== executionClass.seriesVersion
      ) {
        throw new PackageExchangeStoreError("UNKNOWN_REFERENCE", "Execution class references an unregistered series.");
      }
      const policyRow = this.documentByHash("MATCHING_POLICY", executionClass.matchingPolicyHash);
      const policy = policyRow === undefined ? undefined : this.loadPolicy(policyRow);
      if (policy === undefined || policy.executionClassId !== executionClass.executionClassId) {
        throw new PackageExchangeStoreError(
          "UNKNOWN_REFERENCE",
          "Execution class references a matching policy that is unregistered or written for another class.",
        );
      }
      const classHash = seriesExecutionClassHash(executionClass, this.options.executionClassSupport);
      const registered = this.insertDocument(
        "EXECUTION_CLASS",
        executionClass.executionClassId,
        executionClass.executionClassVersion,
        seriesExecutionClassBytes(executionClass, this.options.executionClassSupport),
        classHash,
        executionClass,
      );
      if (registered.created) {
        this.db
          .prepare("INSERT INTO execution_class_bindings (class_hash, series_hash, matching_policy_hash) VALUES (?, ?, ?)")
          .run(classHash, executionClass.seriesManifestHash, executionClass.matchingPolicyHash);
      }
      return registered;
    });
  }

  getSeries(seriesId: string, seriesVersion: number): EconomicStrategySeries | undefined {
    const row = this.documentBySubject("SERIES", seriesId, seriesVersion);
    return row === undefined ? undefined : this.loadSeries(row);
  }

  getSeriesRecord(seriesId: string, seriesVersion: number): RegisteredStrategySeriesRecord | undefined {
    const row = this.documentBySubject("SERIES", seriesId, seriesVersion);
    return row === undefined ? undefined : Object.freeze({
      documentHashHex: toHex(hashBytes(row.document_hash, "document_hash")),
      document: this.loadSeries(row),
    });
  }

  getExecutionClass(executionClassId: string, executionClassVersion: number): SeriesExecutionClass | undefined {
    const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
    return row === undefined ? undefined : this.loadExecutionClass(row);
  }

  getExecutionClassRecord(executionClassId: string, executionClassVersion: number): RegisteredExecutionClassRecord | undefined {
    const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
    return row === undefined ? undefined : Object.freeze({
      documentHashHex: toHex(hashBytes(row.document_hash, "document_hash")),
      document: this.loadExecutionClass(row),
    });
  }

  getOpenExecutionClass(executionClassId: string): SeriesExecutionClass | undefined {
    const row = this.db.prepare(`
      SELECT d.document_hash, d.canonical_bytes, d.document_json
      FROM package_books b
      JOIN exchange_documents d ON d.document_hash = b.class_hash
      WHERE b.execution_class_id = ? AND d.kind = 'EXECUTION_CLASS'
    `).get(executionClassId) as DocumentRow | undefined;
    return row === undefined ? undefined : this.loadExecutionClass(row);
  }

  /** Every open book with its halt state, ordered by execution class. */
  listBooks(): readonly { readonly executionClassId: string; readonly halted: boolean }[] {
    const rows = this.db
      .prepare("SELECT execution_class_id, halted FROM package_books ORDER BY execution_class_id LIMIT 500")
      .all() as { execution_class_id: unknown; halted: unknown }[];
    return Object.freeze(rows.map((row) => Object.freeze({ executionClassId: jsonText(row.execution_class_id, "execution_class_id"), halted: row.halted === 1 })));
  }

  /** The highest registered version of every strategy series, revalidated against its hash. */
  listSeries(): readonly EconomicStrategySeries[] {
    return Object.freeze(this.latestSubjects("SERIES").map((row) => this.loadSeries(row)));
  }

  /** The highest version of every execution class bound to one strategy series. */
  listExecutionClasses(seriesId: string): readonly SeriesExecutionClass[] {
    return Object.freeze(
      this.latestSubjects("EXECUTION_CLASS")
        .map((row) => this.loadExecutionClass(row))
        .filter((executionClass) => executionClass.seriesId === seriesId),
    );
  }

  /** Trades recorded in a half-open time window, oldest first, for candle aggregation; resting-only allocations are skipped. */
  allocationsBetween(executionClassId: string, fromMs: number, toMs: number, limit: number): readonly PackageTapeRecord[] {
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs <= fromMs || !Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
      throw new PackageExchangeStoreError("INVALID_INPUT", "Window must be nonempty and limit between 1 and 50000.");
    }
    if (this.getBook(executionClassId) === undefined) throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "Package book is not open.");
    const rows = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? AND t.recorded_at_ms >= ? AND t.recorded_at_ms < ?
         ORDER BY t.recorded_at_ms, t.allocation_rowid LIMIT ?`,
      )
      .all(executionClassId, fromMs, toMs, limit) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown }[];
    return Object.freeze(rows.map((row) => this.tapeRecord(executionClassId, row)));
  }

  private latestSubjects(kind: ExchangeDocumentKind): readonly DocumentRow[] {
    return this.db
      .prepare(
        `SELECT d.document_hash, d.canonical_bytes, d.document_json FROM exchange_documents d
         JOIN (SELECT subject_id, MAX(subject_version) AS version FROM exchange_documents WHERE kind = ? GROUP BY subject_id) m
           ON d.subject_id = m.subject_id AND d.subject_version = m.version
         WHERE d.kind = ? ORDER BY d.subject_id LIMIT 500`,
      )
      .all(kind, kind) as DocumentRow[];
  }

  getMatchingPolicy(policyHash: Uint8Array | string): PackageMatchingPolicy | undefined {
    const row = this.documentByHash("MATCHING_POLICY", commitmentHash(policyHash));
    return row === undefined ? undefined : this.loadPolicy(row);
  }

  // ---------------------------------------------------------------- books

  openBook(executionClassId: string, executionClassVersion: number): PackageBookState {
    return this.transaction(() => {
      const row = this.documentBySubject("EXECUTION_CLASS", executionClassId, executionClassVersion);
      if (row === undefined) {
        throw new PackageExchangeStoreError("UNKNOWN_REFERENCE", "Execution class is not registered.");
      }
      const executionClass = this.loadExecutionClass(row);
      const existing = this.db
        .prepare("SELECT class_hash FROM package_books WHERE execution_class_id = ?")
        .get(executionClass.executionClassId) as { class_hash: unknown } | undefined;
      if (existing !== undefined) {
        if (!bytesEqual(hashBytes(existing.class_hash, "class_hash"), hashBytes(row.document_hash, "document_hash"))) {
          throw new PackageExchangeStoreError("BOOK_CONFLICT", "A book for this execution class runs another class version.");
        }
        return this.loadBook(executionClass.executionClassId);
      }
      const policy = this.policyForClass(executionClass);
      const book = emptyPackageBook(policy);
      this.db
        .prepare("INSERT INTO package_books (execution_class_id, class_hash, halted, next_sequence) VALUES (?, ?, 0, ?)")
        .run(executionClass.executionClassId, hashBytes(row.document_hash, "document_hash"), sequenceText(book.nextSequence));
      return book;
    });
  }

  getBook(executionClassId: string): PackageBookState | undefined {
    const exists = this.db
      .prepare("SELECT 1 FROM package_books WHERE execution_class_id = ?")
      .get(executionClassId);
    return exists === undefined ? undefined : this.loadBook(executionClassId);
  }

  submitOrder(
    executionClassId: string,
    order: PackageTakerOrderInput,
    nowValue: bigint,
    commitmentInput: PackageSettlementCommitmentInput,
    authorizationInput?: PackageSettlementAuthorizationEvidenceInput,
  ): PackageExchangeSubmitResult {
    return this.transaction(() => {
      const orderId = guarded("INVALID_INPUT", "Order id is invalid.", () => commitmentHash(order.orderId));
      const commitment = guarded("INVALID_INPUT", "Settlement commitment is invalid.", () =>
        packageSettlementCommitment(commitmentInput),
      );
      const settlementCommitmentHash = packageSettlementCommitmentHash(commitment);
      const authorization = authorizationInput === undefined
        ? undefined
        : settlementAuthorizationEvidence(authorizationInput);
      if (
        commitment.executionClassId !== executionClassId
        || !bytesEqual(commitment.packageOrderId, orderId)
        || commitment.participantId !== order.participantId
        || commitment.quantity !== order.quantity
      ) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment does not bind the submitted package order.",
        );
      }
      if (commitment.validUntilValue <= nowValue) {
        throw new PackageExchangeStoreError("SETTLEMENT_EXPIRED", "The settlement commitment is expired.");
      }
      if (order.timeInForce === "GTC" && order.settlementLeaseUntilValue !== commitment.validUntilValue) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The GTC settlement lease and settlement commitment must expire together.",
        );
      }
      if (order.timeInForce === "GTD" && order.expiresAtValue !== commitment.validUntilValue) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The book order and settlement commitment must expire together.",
        );
      }
      const replay = this.db
        .prepare("SELECT allocation_json, execution_class_id FROM package_book_allocations WHERE taker_order_id = ?")
        .get(orderId) as { allocation_json: unknown; execution_class_id: unknown } | undefined;
      if (replay !== undefined) {
        if (replay.execution_class_id !== executionClassId) {
          throw new PackageExchangeStoreError("ORDER_CONFLICT", "Order id was already allocated in another book.");
        }
        const storedCommitment = this.settlementCommitment(orderId);
        if (storedCommitment === undefined || !bytesEqual(packageSettlementCommitmentHash(storedCommitment), settlementCommitmentHash)) {
          throw new PackageExchangeStoreError(
            "ORDER_CONFLICT",
            "Order id was already allocated under another settlement commitment.",
          );
        }
        if (authorization !== undefined) this.insertSettlementAuthorization(storedCommitment, authorization);
        const allocation = this.decodeAllocation(executionClassId, replay.allocation_json);
        const allocationHashHex = toHex(packageAllocationHash(allocation));
        const handoff = this.settlementHandoff(allocationHashHex);
        return {
          accepted: true,
          replayed: true,
          allocation,
          allocationHashHex,
          settlementCommitmentHashHex: toHex(settlementCommitmentHash),
          ...(handoff === undefined ? {} : {
            settlementHandoff: handoff,
            settlementHandoffHashHex: toHex(packageSettlementHandoffHash(handoff)),
          }),
        };
      }
      const { policy, book } = this.policyAndBook(executionClassId);
      if (commitment.environment !== policy.environment) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment belongs to another environment.",
        );
      }
      const result = guarded("INVALID_INPUT", "Order is invalid.", () => matchPackageOrder(policy, book, order, nowValue));
      if (!result.accepted) {
        if (result.state !== book) this.writeBook(result.state);
        return { accepted: false, rejection: result.rejection };
      }
      const allocationHash = packageAllocationHash(result.allocation);
      const recordedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO package_book_settlement_commitments
          (package_order_id, commitment_hash, execution_class_id, strategy_order_hash,
           participant_id, commitment_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        settlementCommitmentHash,
        executionClassId,
        commitment.strategyOrderHash,
        commitment.participantId,
        stringifyProtocolJson(commitment),
        recordedAtMs,
      );
      if (authorization !== undefined) this.insertSettlementAuthorization(commitment, authorization);
      this.db
        .prepare(
          "INSERT INTO package_book_allocations (allocation_hash, taker_order_id, execution_class_id, allocation_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(allocationHash, orderId, executionClassId, stringifyProtocolJson(result.allocation), recordedAtMs);
      // Only allocations that filled are trades; resting-only allocations never reach the tape.
      if (result.allocation.fills.length > 0) {
        this.db
          .prepare(
            "INSERT INTO package_book_trades (allocation_rowid, allocation_hash, execution_class_id, recorded_at_ms) SELECT rowid, allocation_hash, execution_class_id, recorded_at_ms FROM package_book_allocations WHERE allocation_hash = ?",
          )
          .run(allocationHash);
      }
      const consume = this.db.prepare(
        "INSERT INTO package_book_consumed_sources (source_key, execution_class_id, allocation_hash) VALUES (?, ?, ?)",
      );
      for (const fill of result.allocation.fills) {
        for (const key of fill.consumedSourceKeys) {
          guarded("SOURCE_ALREADY_CONSUMED", "A source reservation was already consumed.", () =>
            consume.run(key, executionClassId, allocationHash),
          );
        }
      }
      let settlementHandoff: PackageSettlementHandoff | undefined;
      let settlementHandoffHashHex: string | undefined;
      if (result.allocation.fills.length > 0) {
        settlementHandoff = packageSettlementHandoff({
          version: 1,
          allocationHash,
          executionClassId,
          takerSettlementCommitmentHash: settlementCommitmentHash,
          fills: result.allocation.fills.map((fill) => {
            if (fill.makerSource === "IMPLIED") {
              return {
                fillSequence: fill.fillSequence,
                makerEntryId: fill.makerEntryId,
                makerSource: fill.makerSource,
                priceTicks: fill.priceTicks,
                quantity: fill.quantity,
              };
            }
            const makerCommitment = this.settlementCommitment(fill.makerEntryId);
            if (makerCommitment === undefined) {
              throw new PackageExchangeStoreError(
                "UNBACKED_LIQUIDITY",
                "A direct maker entry has no settlement commitment.",
              );
            }
            return {
              fillSequence: fill.fillSequence,
              makerEntryId: fill.makerEntryId,
              makerSource: fill.makerSource,
              priceTicks: fill.priceTicks,
              quantity: fill.quantity,
              makerSettlementCommitmentHash: packageSettlementCommitmentHash(makerCommitment),
            };
          }),
        });
        verifyPackageSettlementHandoff(result.allocation, settlementHandoff);
        const handoffHash = packageSettlementHandoffHash(settlementHandoff);
        settlementHandoffHashHex = toHex(handoffHash);
        this.db.prepare(`
          INSERT INTO package_book_settlement_handoffs
            (allocation_hash, handoff_hash, handoff_json, recorded_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(allocationHash, handoffHash, stringifyProtocolJson(settlementHandoff), recordedAtMs);
        for (const fill of result.allocation.fills) {
          if (fill.makerSource !== "DIRECT") continue;
          if (this.settlementEvidenceCount(fill.makerEntryId) >= PACKAGE_SETTLEMENT_MAX_ALLOCATIONS) {
            throw new PackageExchangeStoreError(
              "SETTLEMENT_ALLOCATION_LIMIT",
              `One package order may participate in at most ${PACKAGE_SETTLEMENT_MAX_ALLOCATIONS} settlement evidence records.`,
            );
          }
        }
        const insertObligation = this.db.prepare(`
          INSERT INTO package_book_settlement_obligations
            (allocation_hash, fill_index, fill_sequence, package_order_id, role,
             counterparty_order_id, maker_source, price_ticks, quantity_atoms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        result.allocation.fills.forEach((fill, fillIndex) => {
          insertObligation.run(
            allocationHash,
            fillIndex,
            sequenceText(fill.fillSequence),
            orderId,
            "TAKER",
            fill.makerSource === "DIRECT" ? fill.makerEntryId : null,
            fill.makerSource,
            sequenceText(fill.priceTicks),
            sequenceText(fill.quantity),
          );
          if (fill.makerSource === "DIRECT") {
            insertObligation.run(
              allocationHash,
              fillIndex,
              sequenceText(fill.fillSequence),
              fill.makerEntryId,
              "MAKER",
              orderId,
              fill.makerSource,
              sequenceText(fill.priceTicks),
              sequenceText(fill.quantity),
            );
          }
        });
      }
      this.writeBook(result.state);
      return {
        accepted: true,
        replayed: false,
        allocation: result.allocation,
        allocationHashHex: toHex(allocationHash),
        settlementCommitmentHashHex: toHex(settlementCommitmentHash),
        ...(settlementHandoff === undefined || settlementHandoffHashHex === undefined
          ? {}
          : { settlementHandoff, settlementHandoffHashHex }),
      };
    });
  }

  queueReopeningOrder(
    executionClassId: string,
    order: PackageTakerOrderInput,
    nowValue: bigint,
    commitmentInput: PackageSettlementCommitmentInput,
    authorizationInput?: PackageSettlementAuthorizationEvidenceInput,
  ): PackageReopeningQueueResult {
    return this.transaction(() => {
      const orderId = guarded("INVALID_INPUT", "Order id is invalid.", () => commitmentHash(order.orderId));
      const commitment = guarded("INVALID_INPUT", "Settlement commitment is invalid.", () =>
        packageSettlementCommitment(commitmentInput),
      );
      const commitmentHashValue = packageSettlementCommitmentHash(commitment);
      const authorization = authorizationInput === undefined
        ? undefined
        : settlementAuthorizationEvidence(authorizationInput);
      if (
        commitment.executionClassId !== executionClassId
        || !bytesEqual(commitment.packageOrderId, orderId)
        || commitment.participantId !== order.participantId
        || commitment.quantity !== order.quantity
      ) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment does not bind the submitted reopening order.",
        );
      }
      if (commitment.validUntilValue <= nowValue) {
        throw new PackageExchangeStoreError("SETTLEMENT_EXPIRED", "The settlement commitment is expired.");
      }
      if (order.timeInForce === "GTC" && order.settlementLeaseUntilValue !== commitment.validUntilValue) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The GTC settlement lease and settlement commitment must expire together.",
        );
      }
      if (order.timeInForce === "GTD" && order.expiresAtValue !== commitment.validUntilValue) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The book order and settlement commitment must expire together.",
        );
      }
      const { policy, book } = this.policyAndBook(executionClassId);
      if (commitment.environment !== policy.environment) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_MISMATCH",
          "The settlement commitment belongs to another environment.",
        );
      }
      const stored = this.settlementCommitment(orderId);
      if (stored !== undefined) {
        if (!bytesEqual(packageSettlementCommitmentHash(stored), commitmentHashValue)) {
          throw new PackageExchangeStoreError(
            "ORDER_CONFLICT",
            "Order id is already bound to another settlement commitment.",
          );
        }
        if (authorization !== undefined) this.insertSettlementAuthorization(stored, authorization);
        const entry = book.entries.find((candidate) => bytesEqual(candidate.entryId, orderId));
        if (entry === undefined) {
          throw new PackageExchangeStoreError("ORDER_CONFLICT", "Order id is no longer active in the package book.");
        }
        return {
          entry,
          settlementCommitmentHashHex: toHex(commitmentHashValue),
          replayed: true,
        };
      }
      const admitted = guarded("INVALID_INPUT", "Reopening order is invalid.", () =>
        queuePackageReopeningOrder(policy, book, order, nowValue),
      );
      this.db.prepare(`
        INSERT INTO package_book_settlement_commitments
          (package_order_id, commitment_hash, execution_class_id, strategy_order_hash,
           participant_id, commitment_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        commitmentHashValue,
        executionClassId,
        commitment.strategyOrderHash,
        commitment.participantId,
        stringifyProtocolJson(commitment),
        this.clock(),
      );
      if (authorization !== undefined) this.insertSettlementAuthorization(commitment, authorization);
      this.writeBook(admitted.state);
      return {
        entry: admitted.entry,
        settlementCommitmentHashHex: toHex(commitmentHashValue),
        replayed: false,
      };
    });
  }

  clearReopeningAuction(
    executionClassId: string,
    auctionIdInput: Uint8Array | string,
    openingSnapshotHashInput: Uint8Array | string,
    qualificationSnapshotHash: Uint8Array | string,
    referencePriceTicks: bigint,
    nowValue: bigint,
  ): PackageReopeningClearResult {
    return this.transaction(() => {
      const auctionId = commitmentHash(auctionIdInput);
      const openingSnapshotHash = commitmentHash(openingSnapshotHashInput);
      const previous = this.db.prepare(`
        SELECT result_hash, execution_class_id, result_json
        FROM package_book_reopening_results
        WHERE auction_id = ?
      `).get(auctionId) as {
        result_hash: unknown;
        execution_class_id: unknown;
        result_json: unknown;
      } | undefined;
      if (previous !== undefined) {
        const previousClass = jsonText(previous.execution_class_id, "execution_class_id");
        const result = this.decodeReopeningResult(previousClass, previous.result_json);
        if (!bytesEqual(packageReopeningResultHash(result), hashBytes(previous.result_hash, "result_hash"))) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening result does not match its hash.");
        }
        if (
          previousClass !== executionClassId
          || !bytesEqual(result.auctionId, auctionId)
          || !bytesEqual(result.openingSnapshotHash, openingSnapshotHash)
          || !bytesEqual(result.qualificationSnapshotHash, commitmentHash(qualificationSnapshotHash))
          || result.referencePriceTicks !== referencePriceTicks
        ) {
          throw new PackageExchangeStoreError("REOPENING_CONFLICT", "Auction id was already used by another request.");
        }
        const resultHashHex = toHex(hashBytes(previous.result_hash, "result_hash"));
        const settlementHandoff = this.reopeningSettlementHandoff(resultHashHex);
        return {
          result,
          resultHashHex,
          ...(settlementHandoff === undefined ? {} : {
            settlementHandoff,
            settlementHandoffHashHex: toHex(packageReopeningSettlementHandoffHash(settlementHandoff)),
          }),
          replayed: true,
        };
      }
      const { policy, book } = this.policyAndBook(executionClassId);
      if (!bytesEqual(packageReopeningSnapshotHash(policy, book), openingSnapshotHash)) {
        throw new PackageExchangeStoreError("STALE_REOPENING_SNAPSHOT", "Package book changed after the opening snapshot.");
      }
      const clearance = guarded("INVALID_INPUT", "Reopening auction cannot clear.", () =>
        clearPackageReopeningAuction(policy, book, auctionId, qualificationSnapshotHash, referencePriceTicks, nowValue),
      );
      const commitments = new Map<string, PackageSettlementCommitment>();
      for (const fill of clearance.result.fills) {
        for (const orderId of [fill.bidEntryId, fill.askEntryId]) {
          const key = toHex(orderId);
          if (commitments.has(key)) continue;
          const settlement = this.settlementCommitment(orderId);
          if (
            settlement === undefined
            || settlement.executionClassId !== executionClassId
            || settlement.validUntilValue <= nowValue
          ) {
            throw new PackageExchangeStoreError(
              "UNBACKED_LIQUIDITY",
              "Every reopening fill requires a live settlement commitment.",
            );
          }
          commitments.set(key, settlement);
        }
      }
      const resultHash = packageReopeningResultHash(clearance.result);
      const recordedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO package_book_reopening_results
          (result_hash, auction_id, opening_snapshot_hash, execution_class_id, result_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        resultHash,
        auctionId,
        clearance.result.openingSnapshotHash,
        executionClassId,
        stringifyProtocolJson(clearance.result),
        recordedAtMs,
      );
      let settlementHandoff: PackageReopeningSettlementHandoff | undefined;
      let settlementHandoffHashHex: string | undefined;
      if (clearance.result.fills.length > 0) {
        for (const orderId of commitments.keys()) {
          if (this.settlementEvidenceCount(orderId) >= PACKAGE_SETTLEMENT_MAX_ALLOCATIONS) {
            throw new PackageExchangeStoreError(
              "SETTLEMENT_ALLOCATION_LIMIT",
              `One package order may participate in at most ${PACKAGE_SETTLEMENT_MAX_ALLOCATIONS} settlement evidence records.`,
            );
          }
        }
        settlementHandoff = packageReopeningSettlementHandoff({
          version: 1,
          reopeningResultHash: resultHash,
          executionClassId,
          fills: clearance.result.fills.map((fill) => ({
            fillSequence: fill.fillSequence,
            bidEntryId: fill.bidEntryId,
            askEntryId: fill.askEntryId,
            bidSettlementCommitmentHash: packageSettlementCommitmentHash(commitments.get(toHex(fill.bidEntryId))!),
            askSettlementCommitmentHash: packageSettlementCommitmentHash(commitments.get(toHex(fill.askEntryId))!),
            priceTicks: clearance.result.clearingPriceTicks!,
            quantity: fill.quantity,
          })),
        });
        verifyPackageReopeningSettlementHandoff(clearance.result, settlementHandoff);
        const handoffHash = packageReopeningSettlementHandoffHash(settlementHandoff);
        settlementHandoffHashHex = toHex(handoffHash);
        this.db.prepare(`
          INSERT INTO package_book_reopening_handoffs
            (result_hash, handoff_hash, handoff_json, recorded_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(resultHash, handoffHash, stringifyProtocolJson(settlementHandoff), recordedAtMs);
        const insertObligation = this.db.prepare(`
          INSERT INTO package_book_reopening_obligations
            (result_hash, fill_index, fill_sequence, package_order_id, role,
             counterparty_order_id, price_ticks, quantity_atoms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        clearance.result.fills.forEach((fill, fillIndex) => {
          insertObligation.run(
            resultHash,
            fillIndex,
            sequenceText(fill.fillSequence),
            fill.bidEntryId,
            "BID",
            fill.askEntryId,
            sequenceText(clearance.result.clearingPriceTicks!),
            sequenceText(fill.quantity),
          );
          insertObligation.run(
            resultHash,
            fillIndex,
            sequenceText(fill.fillSequence),
            fill.askEntryId,
            "ASK",
            fill.bidEntryId,
            sequenceText(clearance.result.clearingPriceTicks!),
            sequenceText(fill.quantity),
          );
        });
      }
      this.writeBook(clearance.state);
      return {
        result: clearance.result,
        resultHashHex: toHex(resultHash),
        ...(settlementHandoff === undefined || settlementHandoffHashHex === undefined
          ? {}
          : { settlementHandoff, settlementHandoffHashHex }),
        replayed: false,
      };
    });
  }

  addImpliedLiquidity(executionClassId: string, input: ImpliedLiquidityInput): PackageBookEntry {
    return this.addImpliedLiquidityBatch(executionClassId, [input])[0] as PackageBookEntry;
  }

  addMultiPackageImpliedLiquidity(
    executionClassId: string,
    input: MultiPackageImpliedLiquidityInput,
  ): PackageBookEntry {
    return this.transaction(() => {
      const { policy, book } = this.policyAndBook(executionClassId);
      const versions = this.db.prepare("SELECT current_version FROM implied_source_versions WHERE source_id = ?");
      const consumed = this.db.prepare("SELECT 1 FROM package_book_consumed_sources WHERE source_key = ?");
      for (const source of input.proof.sources) {
        const sourceId = toHex(source.entryId);
        const row = versions.get(sourceId) as { current_version: unknown } | undefined;
        if (row !== undefined && BigInt(jsonText(row.current_version, "current_version")) > source.sourceVersion) {
          throw new PackageExchangeStoreError("STALE_SOURCE", `Implied source ${sourceId} was superseded.`);
        }
        if (consumed.get(source.reservationId) !== undefined) {
          throw new PackageExchangeStoreError("SOURCE_ALREADY_CONSUMED", "A source reservation was already consumed.");
        }
      }
      const result = guarded("INVALID_INPUT", "Multi-package implied liquidity is invalid.", () =>
        admitMultiPackageImpliedLiquidity(policy, book, input),
      );
      this.writeBook(result.state);
      return result.entry;
    });
  }

  /**
   * Adds several implied entries to one book in a single transaction: every entry is admitted in
   * order against the book as it stands after the previous one, or none is.
   */
  addImpliedLiquidityBatch(executionClassId: string, inputs: readonly ImpliedLiquidityInput[]): readonly PackageBookEntry[] {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_IMPLIED_BATCH) {
      throw new PackageExchangeStoreError("INVALID_INPUT", `A batch holds 1 to ${MAX_IMPLIED_BATCH} implied entries.`);
    }
    return this.transaction(() => {
      const { policy, book } = this.policyAndBook(executionClassId);
      const versions = this.db.prepare("SELECT current_version FROM implied_source_versions WHERE source_id = ?");
      const consumed = this.db.prepare("SELECT 1 FROM package_book_consumed_sources WHERE source_key = ?");
      let state = book;
      const entries: PackageBookEntry[] = [];
      for (const input of inputs) {
        for (const source of input.quote.sources) {
          const row = versions.get(source.sourceId) as { current_version: unknown } | undefined;
          if (row !== undefined && BigInt(jsonText(row.current_version, "current_version")) > source.sourceVersion) {
            throw new PackageExchangeStoreError("STALE_SOURCE", `Implied source ${source.sourceId} was superseded.`);
          }
          if (source.reservationId !== undefined && consumed.get(source.reservationId) !== undefined) {
            throw new PackageExchangeStoreError("SOURCE_ALREADY_CONSUMED", "A source reservation was already consumed.");
          }
        }
        const result = guarded("INVALID_INPUT", "Implied liquidity is invalid.", () => addImpliedLiquidity(policy, state, input));
        state = result.state;
        entries.push(result.entry);
      }
      this.writeBook(state);
      return Object.freeze(entries);
    });
  }

  /** Records a newer leg-source version and removes every implied entry built on an older one. */
  observeSourceVersion(sourceId: string, currentVersion: bigint): readonly CommitmentHash[] {
    return this.transaction(() => {
      const id = guarded("INVALID_INPUT", "Source id is invalid.", () => protocolId(sourceId));
      const row = this.db
        .prepare("SELECT current_version FROM implied_source_versions WHERE source_id = ?")
        .get(id) as { current_version: unknown } | undefined;
      if (row !== undefined && BigInt(jsonText(row.current_version, "current_version")) > currentVersion) {
        throw new PackageExchangeStoreError("STALE_SOURCE", "Source versions only move forward.");
      }
      this.db
        .prepare(
          "INSERT INTO implied_source_versions (source_id, current_version) VALUES (?, ?) ON CONFLICT (source_id) DO UPDATE SET current_version = excluded.current_version",
        )
        .run(id, currentVersion.toString(10));
      const invalidated: CommitmentHash[] = [];
      const books = this.db.prepare("SELECT execution_class_id FROM package_books").all() as { execution_class_id: string }[];
      for (const { execution_class_id: classId } of books) {
        const { book } = this.policyAndBook(classId);
        const result = invalidateImpliedSource(book, id, currentVersion);
        if (result.invalidatedEntryIds.length > 0) {
          this.writeBook(result.state);
          invalidated.push(...result.invalidatedEntryIds);
        }
      }
      return Object.freeze(invalidated);
    });
  }

  cancelEntry(
    executionClassId: string,
    entryId: Uint8Array | string,
    participantId: string,
  ): PackageExchangeCancellationResult {
    return this.transaction(() => {
      const cancellation = guarded("INVALID_INPUT", "Cancellation is invalid.", () =>
        packageBookCancellation({ version: 1, executionClassId, entryId, participantId }),
      );
      const cancellationHash = packageBookCancellationHash(cancellation);
      const existing = this.db
        .prepare("SELECT 1 FROM package_book_cancellations WHERE cancellation_hash = ?")
        .get(cancellationHash);
      if (existing !== undefined) return { cancellationHashHex: toHex(cancellationHash), replayed: true };
      const { book } = this.policyAndBook(executionClassId);
      this.writeBook(
        guarded("INVALID_INPUT", "Cancellation is invalid.", () => cancelPackageBookEntry(book, entryId, participantId)),
      );
      this.db
        .prepare(
          "INSERT INTO package_book_cancellations (cancellation_hash, execution_class_id, entry_id, participant_id, recorded_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cancellationHash, cancellation.executionClassId, cancellation.entryId, cancellation.participantId, this.clock());
      return { cancellationHashHex: toHex(cancellationHash), replayed: false };
    });
  }

  amendEntry(amendmentInput: PackageBookAmendmentInput): PackageExchangeAmendmentResult {
    return this.transaction(() => {
      const amendment = guarded("INVALID_INPUT", "Amendment is invalid.", () => packageBookAmendment(amendmentInput));
      const amendmentHash = packageBookAmendmentHash(amendment);
      const existing = this.db.prepare(`
        SELECT amended_entry_json
        FROM package_book_amendments
        WHERE amendment_hash = ?
      `).get(amendmentHash) as { amended_entry_json: unknown } | undefined;
      const { policy, book } = this.policyAndBook(amendment.executionClassId);
      if (existing !== undefined) {
        const entry = guarded("CORRUPT_ROW", "Stored amendment entry is invalid.", () =>
          packageBookEntry(
            policy,
            parseProtocolJson(jsonText(existing.amended_entry_json, "amended_entry_json")) as PackageBookEntry,
          ),
        );
        return { amendmentHashHex: toHex(amendmentHash), entry, replayed: true };
      }
      const progress = this.settlementProgress(toHex(amendment.entryId));
      if (progress === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Direct package entry lost its settlement commitment.");
      }
      const amendedQuantity = amendment.quantity ?? amendment.expectedQuantity;
      if (amendedQuantity > progress.readiness.remainingQuantity) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Amendment quantity exceeds its remaining settlement commitment.");
      }
      const next = guarded("INVALID_INPUT", "Amendment is invalid.", () =>
        amendPackageBookEntry(policy, book, amendment),
      );
      const entry = next.entries.find((candidate) => bytesEqual(candidate.entryId, amendment.entryId));
      if (entry === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Amended entry disappeared from the package book.");
      }
      this.writeBook(next);
      this.db.prepare(`
        INSERT INTO package_book_amendments
          (amendment_hash, execution_class_id, entry_id, participant_id, amendment_json, amended_entry_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        amendmentHash,
        amendment.executionClassId,
        amendment.entryId,
        amendment.participantId,
        stringifyProtocolJson(amendment),
        stringifyProtocolJson(entry),
        this.clock(),
      );
      return { amendmentHashHex: toHex(amendmentHash), entry, replayed: false };
    });
  }

  haltBook(haltInput: PackageBookHaltInput): PackageExchangeHaltResult {
    return this.transaction(() => {
      const halt = guarded("INVALID_INPUT", "Package book halt is invalid.", () => packageBookHalt(haltInput));
      const haltHash = packageBookHaltHash(halt);
      const existing = this.haltRecord(haltHash);
      if (existing !== undefined) {
        return {
          ...existing,
          replayed: true,
        };
      }
      const { policy, book } = this.policyAndBook(halt.executionClassId);
      const halted = guarded("INVALID_INPUT", "Package book halt cannot be applied.", () =>
        applyPackageBookHalt(policy, book, halt),
      );
      const haltedSnapshotHash = packageReopeningSnapshotHash(policy, halted);
      const recordedAtMs = this.clock();
      this.writeBook(halted);
      this.db.prepare(`
        INSERT INTO package_book_halts
          (halt_hash, execution_class_id, expected_open_snapshot_hash, halted_snapshot_hash, halt_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        haltHash,
        halt.executionClassId,
        halt.expectedOpenSnapshotHash,
        haltedSnapshotHash,
        stringifyProtocolJson(halt),
        recordedAtMs,
      );
      return {
        halt,
        haltHashHex: toHex(haltHash),
        haltedSnapshotHashHex: toHex(haltedSnapshotHash),
        recordedAtMs,
        replayed: false,
      };
    });
  }

  haltRecord(haltHashInput: Uint8Array | string): PackageExchangeHaltRecord | undefined {
    const haltHash = commitmentHash(haltHashInput, "haltRecord.haltHash");
    const row = this.db.prepare(`
      SELECT execution_class_id, expected_open_snapshot_hash, halted_snapshot_hash, halt_json, recorded_at_ms
      FROM package_book_halts
      WHERE halt_hash = ?
    `).get(haltHash) as {
      execution_class_id: unknown;
      expected_open_snapshot_hash: unknown;
      halted_snapshot_hash: unknown;
      halt_json: unknown;
      recorded_at_ms: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const halt = guarded("CORRUPT_ROW", "Stored package book halt is invalid.", () =>
      packageBookHalt(parseProtocolJson(jsonText(row.halt_json, "halt_json")) as PackageBookHaltInput),
    );
    if (
      !bytesEqual(packageBookHaltHash(halt), haltHash)
      || halt.executionClassId !== jsonText(row.execution_class_id, "execution_class_id")
      || !bytesEqual(halt.expectedOpenSnapshotHash, hashBytes(row.expected_open_snapshot_hash, "expected_open_snapshot_hash"))
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored package book halt does not match its identity.");
    }
    const recordedAtMs = row.recorded_at_ms;
    if (typeof recordedAtMs !== "number" || !Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored package book halt time is invalid.");
    }
    return Object.freeze({
      halt,
      haltHashHex: toHex(haltHash),
      haltedSnapshotHashHex: toHex(hashBytes(row.halted_snapshot_hash, "halted_snapshot_hash")),
      recordedAtMs,
    });
  }

  getAllocation(takerOrderId: Uint8Array | string): PackageAllocation | undefined {
    const row = this.db
      .prepare("SELECT allocation_json, execution_class_id FROM package_book_allocations WHERE taker_order_id = ?")
      .get(commitmentHash(takerOrderId)) as { allocation_json: unknown; execution_class_id: unknown } | undefined;
    if (row === undefined) return undefined;
    return this.decodeAllocation(jsonText(row.execution_class_id, "execution_class_id"), row.allocation_json);
  }

  settlementCommitment(packageOrderId: Uint8Array | string): PackageSettlementCommitment | undefined {
    const row = this.db.prepare(`
      SELECT commitment_hash, commitment_json
      FROM package_book_settlement_commitments
      WHERE package_order_id = ?
    `).get(commitmentHash(packageOrderId)) as {
      commitment_hash: unknown;
      commitment_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const commitment = packageSettlementCommitment(
      parseProtocolJson(jsonText(row.commitment_json, "commitment_json")) as PackageSettlementCommitmentInput,
    );
    if (!bytesEqual(packageSettlementCommitmentHash(commitment), hashBytes(row.commitment_hash, "commitment_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement commitment does not match its hash.");
    }
    return commitment;
  }

  settlementAuthorization(packageOrderId: Uint8Array | string): PackageSettlementAuthorizationEvidence | undefined {
    const orderId = commitmentHash(packageOrderId);
    const row = this.db.prepare(`
      SELECT commitment_hash, participant_id, scheme, signature, authorized_at_ms
      FROM package_book_settlement_authorizations
      WHERE package_order_id = ?
    `).get(orderId) as {
      commitment_hash: unknown;
      participant_id: unknown;
      scheme: unknown;
      signature: unknown;
      authorized_at_ms: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const commitment = this.settlementCommitment(orderId);
    if (commitment === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement authorization lost its commitment.");
    }
    const evidence = settlementAuthorizationEvidence({
      scheme: jsonText(row.scheme, "scheme") as PackageSettlementAuthorizationScheme,
      signature: jsonText(row.signature, "signature"),
    });
    const commitmentHashValue = packageSettlementCommitmentHash(commitment);
    const participantId = jsonText(row.participant_id, "participant_id");
    const authorizedAtMs = row.authorized_at_ms;
    if (
      !bytesEqual(commitmentHashValue, hashBytes(row.commitment_hash, "commitment_hash"))
      || participantId !== commitment.participantId
      || typeof authorizedAtMs !== "number"
      || !Number.isSafeInteger(authorizedAtMs)
      || authorizedAtMs < 0
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement authorization differs from its commitment.");
    }
    return Object.freeze({
      packageOrderIdHex: toHex(orderId),
      settlementCommitmentHashHex: toHex(commitmentHashValue),
      participantId,
      ...evidence,
      authorizedAtMs,
    });
  }

  recordPreparedNettingBatch(input: PreparedNettingBatchRecordInput): { readonly batch: PreparedNettingBatch; readonly replayed: boolean } {
    return this.transaction(() => {
      const policy = guarded("INVALID_INPUT", "Netting policy is invalid.", () => nettingPolicyManifest(input.policy));
      guarded("INVALID_INPUT", "Netting result is invalid.", () => verifyNettingResultAgainstPolicy(input.result, policy));
      const externalIntents = [...input.externalIntents]
        .map((intent) => {
          guarded("INVALID_INPUT", "Netting external execution intent is invalid.", () =>
            verifyNettingExternalExecutionIntent(intent, input.result, policy));
          return intent;
        })
        .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
      const expectedExternalInstruments = input.result.underlyings
        .filter((summary) => summary.externalNetAtoms !== 0n)
        .map((summary) => summary.instrumentId)
        .sort();
      if (
        externalIntents.length !== expectedExternalInstruments.length
        || externalIntents.some((intent, index) => intent.instrumentId !== expectedExternalInstruments[index])
      ) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "External execution intents do not cover the exact net residuals.");
      }
      const executionClass = this.getExecutionClassRecord(policy.executionClassId, policy.executionClassVersion);
      if (
        executionClass === undefined
        || executionClass.documentHashHex !== toHex(policy.executionClassManifestHash)
        || executionClass.document.settlementClass !== policy.settlementClass
        || executionClass.document.executionClassId !== policy.executionClassId
      ) {
        throw new PackageExchangeStoreError("NETTING_POLICY_MISMATCH", "Netting policy does not bind the registered execution class.");
      }
      const proofHash = nettingResultHash(input.result);
      if (!bytesEqual(proofHash, input.result.proofHash)) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Netting result proof hash is inconsistent.");
      }
      if (!Array.isArray(input.packages) || input.packages.length === 0) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "A prepared netting batch must name at least one package.");
      }
      const packages = [...input.packages]
        .map((entry) => Object.freeze({
          packageOrderIdHex: toHex(commitmentHash(entry.packageOrderIdHex)),
          strategyOrderHashHex: toHex(commitmentHash(entry.strategyOrderHashHex)),
          settlementReadinessHashHex: toHex(commitmentHash(entry.settlementReadinessHashHex)),
        }))
        .sort((left, right) => left.packageOrderIdHex.localeCompare(right.packageOrderIdHex));
      if (new Set(packages.map((entry) => entry.packageOrderIdHex)).size !== packages.length) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Prepared netting batch package ids repeat.");
      }
      const allocatedPackages = new Set(input.result.allocations.map((allocation) => toHex(allocation.packageOrderId)));
      if (allocatedPackages.size !== packages.length || packages.some((entry) => !allocatedPackages.has(entry.packageOrderIdHex))) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Prepared netting packages do not match the result allocations.");
      }
      for (const entry of packages) {
        const commitment = this.settlementCommitment(entry.packageOrderIdHex);
        const authorization = this.settlementAuthorization(entry.packageOrderIdHex);
        const progress = this.settlementProgress(entry.packageOrderIdHex);
        if (commitment === undefined || authorization === undefined || progress === undefined) {
          throw new PackageExchangeStoreError("NETTING_NOT_READY", "A netting package lacks durable settlement evidence.");
        }
        if (
          progress.readiness.status !== "READY_FOR_OWNER_AUTHORIZATION"
          || entry.strategyOrderHashHex !== toHex(commitment.strategyOrderHash)
          || entry.settlementReadinessHashHex !== progress.readinessHashHex
        ) {
          throw new PackageExchangeStoreError("NETTING_NOT_READY", "A netting package is not fully allocated under the named readiness evidence.");
        }
        const allocations = input.result.allocations.filter((allocation) => toHex(allocation.packageOrderId) === entry.packageOrderIdHex);
        if (allocations.length === 0 || allocations.some((allocation) =>
          toHex(allocation.strategyOrderHash) !== entry.strategyOrderHashHex
          || toHex(allocation.settlementReadinessHash) !== entry.settlementReadinessHashHex
          || allocation.ownerId !== commitment.participantId
        )) {
          throw new PackageExchangeStoreError("INVALID_INPUT", "A netting allocation differs from its package settlement evidence.");
        }
      }
      const existing = this.nettingBatch(proofHash);
      const policyJson = stringifyProtocolJson(policy);
      const resultJson = stringifyProtocolJson(input.result);
      if (existing !== undefined) {
        if (
          stringifyProtocolJson(existing.policy) !== policyJson
          || stringifyProtocolJson(existing.result) !== resultJson
          || stringifyProtocolJson(existing.packages) !== stringifyProtocolJson(packages)
          || stringifyProtocolJson(existing.externalExecutions.map((record) => record.intent)) !== stringifyProtocolJson(externalIntents)
        ) {
          throw new PackageExchangeStoreError("NETTING_BATCH_CONFLICT", "The proof hash is already bound to another netting batch.");
        }
        this.ensureNettingFinalAllocationReceipt(proofHash);
        return Object.freeze({ batch: this.nettingBatch(proofHash)!, replayed: true });
      }
      const recordedAtMs = this.clock();
      guarded("NETTING_PACKAGE_CONFLICT", "A package is already assigned to another prepared netting batch.", () => {
        this.db.prepare(`
          INSERT INTO netting_batches
            (proof_hash, netting_policy_hash, policy_json, result_json, status, recorded_at_ms)
          VALUES (?, ?, ?, ?, 'PREPARED', ?)
        `).run(proofHash, nettingPolicyManifestHash(policy), policyJson, resultJson, recordedAtMs);
        const insertPackage = this.db.prepare(`
          INSERT INTO netting_batch_packages
            (proof_hash, package_order_id, strategy_order_hash, settlement_readiness_hash)
          VALUES (?, ?, ?, ?)
        `);
        for (const entry of packages) {
          insertPackage.run(
            proofHash,
            commitmentHash(entry.packageOrderIdHex),
            commitmentHash(entry.strategyOrderHashHex),
            commitmentHash(entry.settlementReadinessHashHex),
          );
        }
        const insertIntent = this.db.prepare(`
          INSERT INTO netting_external_execution_intents
            (intent_hash, proof_hash, instrument_hash, intent_json, recorded_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const intent of externalIntents) {
          insertIntent.run(
            intent.intentHash,
            proofHash,
            intent.instrumentHash,
            stringifyProtocolJson(intent),
            recordedAtMs,
          );
        }
      });
      const externalExecutions: readonly NettingExternalExecutionRecord[] = Object.freeze(
        externalIntents.map((intent) => Object.freeze({ intent })),
      );
      const finalAllocationReceipt = this.ensureNettingFinalAllocationReceipt(proofHash);
      const settlementEvidence: readonly NettingAllocationSettlementEvidence[] = Object.freeze([]);
      return Object.freeze({
        batch: Object.freeze({
          status: "PREPARED" as const,
          proofHashHex: toHex(proofHash),
          policy,
          result: input.result,
          externalExecutions,
          externalExecutionStatus: nettingExternalExecutionStatus(externalExecutions),
          ...(finalAllocationReceipt === undefined ? {} : { finalAllocationReceipt }),
          settlementEvidence,
          settlementStatus: nettingSettlementStatus(finalAllocationReceipt, undefined),
          packages: Object.freeze(packages),
          recordedAtMs,
        }),
        replayed: false,
      });
    });
  }

  nettingBatch(proofHashInput: Uint8Array | string): PreparedNettingBatch | undefined {
    const proofHash = commitmentHash(proofHashInput);
    const row = this.db.prepare(`
      SELECT netting_policy_hash, policy_json, result_json, status, recorded_at_ms
      FROM netting_batches
      WHERE proof_hash = ?
    `).get(proofHash) as {
      netting_policy_hash: unknown;
      policy_json: unknown;
      result_json: unknown;
      status: unknown;
      recorded_at_ms: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const policy = nettingPolicyManifest(
      parseProtocolJson(jsonText(row.policy_json, "policy_json")) as NettingPolicyManifestInput,
    );
    const result = parseProtocolJson(jsonText(row.result_json, "result_json")) as NettingResult;
    guarded("CORRUPT_ROW", "Stored netting result failed validation.", () => verifyNettingResultAgainstPolicy(result, policy));
    const status = jsonText(row.status, "status");
    const recordedAtMs = row.recorded_at_ms;
    if (
      status !== "PREPARED"
      || !bytesEqual(nettingPolicyManifestHash(policy), hashBytes(row.netting_policy_hash, "netting_policy_hash"))
      || !bytesEqual(nettingResultHash(result), proofHash)
      || !bytesEqual(result.proofHash, proofHash)
      || typeof recordedAtMs !== "number"
      || !Number.isSafeInteger(recordedAtMs)
      || recordedAtMs < 0
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored prepared netting batch is inconsistent.");
    }
    const packageRows = this.db.prepare(`
      SELECT package_order_id, strategy_order_hash, settlement_readiness_hash
      FROM netting_batch_packages
      WHERE proof_hash = ?
      ORDER BY package_order_id
    `).all(proofHash) as {
      package_order_id: unknown;
      strategy_order_hash: unknown;
      settlement_readiness_hash: unknown;
    }[];
    const packages = Object.freeze(packageRows.map((entry) => Object.freeze({
      packageOrderIdHex: toHex(hashBytes(entry.package_order_id, "package_order_id")),
      strategyOrderHashHex: toHex(hashBytes(entry.strategy_order_hash, "strategy_order_hash")),
      settlementReadinessHashHex: toHex(hashBytes(entry.settlement_readiness_hash, "settlement_readiness_hash")),
    })));
    const allocatedPackages = new Set(result.allocations.map((allocation) => toHex(allocation.packageOrderId)));
    if (packages.length === 0 || allocatedPackages.size !== packages.length || packages.some((entry) => !allocatedPackages.has(entry.packageOrderIdHex))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored netting package set differs from its result.");
    }
    const executionRows = this.db.prepare(`
      SELECT i.intent_hash, i.instrument_hash, i.intent_json,
             e.evidence_hash, e.evidence_json
      FROM netting_external_execution_intents i
      LEFT JOIN netting_external_execution_evidence e ON e.intent_hash = i.intent_hash
      WHERE i.proof_hash = ?
      ORDER BY i.instrument_hash
    `).all(proofHash) as {
      intent_hash: unknown;
      instrument_hash: unknown;
      intent_json: unknown;
      evidence_hash: unknown;
      evidence_json: unknown;
    }[];
    const externalExecutions: readonly NettingExternalExecutionRecord[] = Object.freeze(executionRows.map((entry): NettingExternalExecutionRecord => {
      const intent = parseProtocolJson(jsonText(entry.intent_json, "intent_json")) as NettingExternalExecutionIntent;
      guarded("CORRUPT_ROW", "Stored external execution intent failed validation.", () =>
        verifyNettingExternalExecutionIntent(intent, result, policy));
      if (
        !bytesEqual(intent.intentHash, hashBytes(entry.intent_hash, "intent_hash"))
        || !bytesEqual(intent.instrumentHash, hashBytes(entry.instrument_hash, "instrument_hash"))
      ) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored external execution intent identity is inconsistent.");
      }
      const crossBatch = this.crossBatchClearingForSourceIntent(intent.intentHash);
      const crossBatchFields = crossBatch === undefined ? {} : {
        crossBatchClearingPlanHashHex: toHex(crossBatch.plan.planHash),
        crossBatchStatus: crossBatch.status,
      } as const;
      if (entry.evidence_json === null && entry.evidence_hash === null) {
        return Object.freeze({ intent, ...crossBatchFields });
      }
      if (crossBatch !== undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Netting intent has both direct and cross-batch execution.");
      }
      if (entry.evidence_json === null || entry.evidence_hash === null) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored external execution evidence is incomplete.");
      }
      const evidence = parseProtocolJson(jsonText(entry.evidence_json, "evidence_json")) as NettingExternalExecutionEvidence;
      guarded("CORRUPT_ROW", "Stored external execution evidence failed validation.", () =>
        verifyNettingExternalExecutionEvidence(evidence, intent));
      if (!bytesEqual(evidence.evidenceHash, hashBytes(entry.evidence_hash, "evidence_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored external execution evidence identity is inconsistent.");
      }
      return Object.freeze({ intent, evidence, ...crossBatchFields });
    }));
    const expectedExternalInstruments = result.underlyings.filter((summary) => summary.externalNetAtoms !== 0n);
    if (
      externalExecutions.length !== expectedExternalInstruments.length
      || expectedExternalInstruments.some((summary) => !externalExecutions.some((record) => record.intent.instrumentId === summary.instrumentId))
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored external execution intents do not cover the exact net residuals.");
    }
    const crossBatchResolutions = this.crossBatchResolutionsForProof(proofHash);
    const finalAllocationRow = this.db.prepare(`
      SELECT receipt_hash, receipt_json
      FROM netting_final_allocation_receipts
      WHERE proof_hash = ?
    `).get(proofHash) as { receipt_hash: unknown; receipt_json: unknown } | undefined;
    let finalAllocationReceipt: NettingFinalAllocationReceipt | undefined;
    if (finalAllocationRow !== undefined) {
      finalAllocationReceipt = parseProtocolJson(
        jsonText(finalAllocationRow.receipt_json, "receipt_json"),
      ) as NettingFinalAllocationReceipt;
      guarded("CORRUPT_ROW", "Stored final allocation receipt failed validation.", () =>
        verifyNettingFinalAllocationReceipt(
          finalAllocationReceipt!,
          result,
          policy,
          externalExecutions.map((record) => record.intent),
          externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
          crossBatchResolutions,
        ));
      if (!bytesEqual(finalAllocationReceipt.receiptHash, hashBytes(finalAllocationRow.receipt_hash, "receipt_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored final allocation receipt identity is inconsistent.");
      }
    }
    const settlementRows = this.db.prepare(`
      SELECT evidence_hash, allocation_receipt_hash, evidence_json
      FROM netting_allocation_settlement_evidence
      WHERE proof_hash = ?
      ORDER BY allocation_receipt_hash
    `).all(proofHash) as {
      evidence_hash: unknown;
      allocation_receipt_hash: unknown;
      evidence_json: unknown;
    }[];
    const settlementEvidence: readonly NettingAllocationSettlementEvidence[] = Object.freeze(settlementRows.map((entry) => {
      if (finalAllocationReceipt === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement evidence exists before a final allocation receipt.");
      }
      const evidence = parseProtocolJson(
        jsonText(entry.evidence_json, "evidence_json"),
      ) as NettingAllocationSettlementEvidence;
      guarded("CORRUPT_ROW", "Stored allocation settlement evidence failed validation.", () =>
        verifyNettingAllocationSettlementEvidence(
          evidence,
          finalAllocationReceipt!,
          result,
          policy,
          externalExecutions.map((record) => record.intent),
          externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
          crossBatchResolutions,
        ));
      const allocation = finalAllocationReceipt.allocations.find((candidate) =>
        bytesEqual(candidate.allocationReceiptHash, evidence.allocationReceiptHash));
      const commitment = allocation === undefined ? undefined : this.settlementCommitment(allocation.packageOrderId);
      if (
        !bytesEqual(evidence.evidenceHash, hashBytes(entry.evidence_hash, "evidence_hash"))
        || !bytesEqual(evidence.allocationReceiptHash, hashBytes(entry.allocation_receipt_hash, "allocation_receipt_hash"))
        || allocation === undefined
        || commitment === undefined
        || commitment.participantId !== evidence.ownerId
        || commitment.settlementAccount !== evidence.settlementAccount
      ) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored allocation settlement evidence identity is inconsistent.");
      }
      return evidence;
    }));
    const completionRow = this.db.prepare(`
      SELECT receipt_hash, receipt_json
      FROM netting_settlement_completion_receipts
      WHERE proof_hash = ?
    `).get(proofHash) as { receipt_hash: unknown; receipt_json: unknown } | undefined;
    let settlementCompletionReceipt: NettingSettlementCompletionReceipt | undefined;
    if (completionRow !== undefined) {
      if (finalAllocationReceipt === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement completion exists before a final allocation receipt.");
      }
      settlementCompletionReceipt = parseProtocolJson(
        jsonText(completionRow.receipt_json, "receipt_json"),
      ) as NettingSettlementCompletionReceipt;
      guarded("CORRUPT_ROW", "Stored settlement completion receipt failed validation.", () =>
        verifyNettingSettlementCompletionReceipt(
          settlementCompletionReceipt!,
          finalAllocationReceipt!,
          settlementEvidence,
          result,
          policy,
          externalExecutions.map((record) => record.intent),
          externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
          crossBatchResolutions,
        ));
      if (!bytesEqual(settlementCompletionReceipt.receiptHash, hashBytes(completionRow.receipt_hash, "receipt_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement completion receipt identity is inconsistent.");
      }
    }
    return Object.freeze({
      status: "PREPARED",
      proofHashHex: toHex(proofHash),
      policy,
      result,
      externalExecutions,
      externalExecutionStatus: nettingExternalExecutionStatus(externalExecutions),
      ...(finalAllocationReceipt === undefined ? {} : { finalAllocationReceipt }),
      settlementEvidence,
      settlementStatus: nettingSettlementStatus(finalAllocationReceipt, settlementCompletionReceipt),
      ...(settlementCompletionReceipt === undefined ? {} : { settlementCompletionReceipt }),
      packages,
      recordedAtMs,
    });
  }

  recordVerifiedNettingExternalExecutionEvidence(
    evidence: NettingExternalExecutionEvidence,
  ): { readonly evidence: NettingExternalExecutionEvidence; readonly replayed: boolean } {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT proof_hash, intent_json
        FROM netting_external_execution_intents
        WHERE intent_hash = ?
      `).get(commitmentHash(evidence.intentHash)) as { proof_hash: unknown; intent_json: unknown } | undefined;
      if (row === undefined) throw new PackageExchangeStoreError("NETTING_INTENT_NOT_FOUND", "External execution intent is not stored.");
      const pooled = this.db.prepare(`
        SELECT plan_hash FROM cross_batch_clearing_sources WHERE source_intent_hash = ?
      `).get(commitmentHash(evidence.intentHash)) as { plan_hash: unknown } | undefined;
      if (pooled !== undefined) {
        throw new PackageExchangeStoreError(
          "NETTING_INTENT_POOLED",
          "External execution intent is committed to cross-batch clearing.",
        );
      }
      const proofHash = hashBytes(row.proof_hash, "proof_hash");
      const batch = this.nettingBatch(proofHash);
      if (batch === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "External execution intent lost its netting batch.");
      const intent = parseProtocolJson(jsonText(row.intent_json, "intent_json")) as NettingExternalExecutionIntent;
      guarded("INVALID_INPUT", "External execution evidence is invalid.", () =>
        verifyNettingExternalExecutionEvidence(evidence, intent));
      const existing = this.db.prepare(`
        SELECT evidence_hash, evidence_json
        FROM netting_external_execution_evidence
        WHERE intent_hash = ?
      `).get(intent.intentHash) as { evidence_hash: unknown; evidence_json: unknown } | undefined;
      if (existing !== undefined) {
        const existingHash = hashBytes(existing.evidence_hash, "evidence_hash");
        if (
          !bytesEqual(existingHash, evidence.evidenceHash)
          || jsonText(existing.evidence_json, "evidence_json") !== stringifyProtocolJson(evidence)
        ) {
          throw new PackageExchangeStoreError("NETTING_EVIDENCE_CONFLICT", "External execution intent already has different terminal evidence.");
        }
        this.ensureNettingFinalAllocationReceipt(proofHash);
        return Object.freeze({ evidence, replayed: true });
      }
      this.db.prepare(`
        INSERT INTO netting_external_execution_evidence
          (evidence_hash, intent_hash, evidence_json, recorded_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(evidence.evidenceHash, intent.intentHash, stringifyProtocolJson(evidence), this.clock());
      this.ensureNettingFinalAllocationReceipt(proofHash);
      return Object.freeze({ evidence, replayed: false });
    });
  }

  recordPreparedCrossBatchClearing(input: Readonly<{
    policy: CrossBatchClearingPolicyInput | CrossBatchClearingPolicy;
    sourceIntentHashes: readonly (Uint8Array | string)[];
  }>): { readonly clearing: PreparedCrossBatchClearing; readonly replayed: boolean } {
    return this.transaction(() => {
      if (!Array.isArray(input.sourceIntentHashes) || input.sourceIntentHashes.length < 2) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Cross-batch clearing requires at least two source intents.");
      }
      const sourceHashes = input.sourceIntentHashes.map((value) => commitmentHash(value));
      if (new Set(sourceHashes.map(toHex)).size !== sourceHashes.length) {
        throw new PackageExchangeStoreError("INVALID_INPUT", "Cross-batch clearing source intents repeat.");
      }
      const sourceRows = sourceHashes.map((sourceIntentHash) => {
        const row = this.db.prepare(`
          SELECT i.proof_hash, i.intent_json, e.evidence_hash, s.plan_hash
          FROM netting_external_execution_intents i
          LEFT JOIN netting_external_execution_evidence e ON e.intent_hash = i.intent_hash
          LEFT JOIN cross_batch_clearing_sources s ON s.source_intent_hash = i.intent_hash
          WHERE i.intent_hash = ?
        `).get(sourceIntentHash) as {
          proof_hash: unknown;
          intent_json: unknown;
          evidence_hash: unknown;
          plan_hash: unknown;
        } | undefined;
        if (row === undefined) {
          throw new PackageExchangeStoreError("NETTING_INTENT_NOT_FOUND", "Cross-batch source intent is not stored.");
        }
        if (row.evidence_hash !== null) {
          throw new PackageExchangeStoreError("NETTING_INTENT_ALREADY_EXECUTED", "Cross-batch source intent already has direct evidence.");
        }
        return row;
      });
      const sourceIntents = Object.freeze(sourceRows.map((row) =>
        parseProtocolJson(jsonText(row.intent_json, "intent_json")) as NettingExternalExecutionIntent));
      const policy = guarded("INVALID_INPUT", "Cross-batch clearing policy is invalid.", () =>
        crossBatchClearingPolicy(input.policy));
      const plan = guarded("INVALID_INPUT", "Cross-batch clearing plan is invalid.", () =>
        crossBatchClearingPlan(sourceIntents, policy));
      const conflictingPlan = sourceRows.find((row) => row.plan_hash !== null
        && !bytesEqual(hashBytes(row.plan_hash, "plan_hash"), plan.planHash));
      if (conflictingPlan !== undefined) {
        throw new PackageExchangeStoreError(
          "CROSS_BATCH_SOURCE_CONFLICT",
          "A source intent is already committed to another cross-batch clearing plan.",
        );
      }
      const existing = this.crossBatchClearing(plan.planHash);
      if (existing !== undefined) {
        return Object.freeze({ clearing: existing, replayed: true });
      }
      const intent = plan.externalQuantityAtoms === 0n
        ? undefined
        : crossBatchExternalExecutionIntent(plan);
      const receipt = plan.externalQuantityAtoms === 0n
        ? crossBatchClearingReceipt(plan)
        : undefined;
      const recordedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO cross_batch_clearing_plans
          (plan_hash, policy_hash, policy_json, plan_json, external_intent_hash,
           external_intent_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.planHash,
        policy.policyHash,
        stringifyProtocolJson(policy),
        stringifyProtocolJson(plan),
        intent?.intentHash ?? null,
        intent === undefined ? null : stringifyProtocolJson(intent),
        recordedAtMs,
      );
      const insertSource = this.db.prepare(`
        INSERT INTO cross_batch_clearing_sources (plan_hash, source_intent_hash) VALUES (?, ?)
      `);
      for (const source of plan.sources) insertSource.run(plan.planHash, source.sourceIntentHash);
      if (receipt !== undefined) {
        this.db.prepare(`
          INSERT INTO cross_batch_clearing_receipts
            (receipt_hash, plan_hash, receipt_json, recorded_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(receipt.receiptHash, plan.planHash, stringifyProtocolJson(receipt), recordedAtMs);
      }
      const clearing = this.crossBatchClearing(plan.planHash);
      if (clearing === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "Cross-batch clearing disappeared.");
      if (receipt !== undefined) {
        for (const row of sourceRows) this.ensureNettingFinalAllocationReceipt(hashBytes(row.proof_hash, "proof_hash"));
      }
      return Object.freeze({ clearing, replayed: false });
    });
  }

  crossBatchClearing(planHashInput: Uint8Array | string): PreparedCrossBatchClearing | undefined {
    const planHash = commitmentHash(planHashInput);
    const row = this.db.prepare(`
      SELECT policy_hash, policy_json, plan_json, external_intent_hash, external_intent_json, recorded_at_ms
      FROM cross_batch_clearing_plans
      WHERE plan_hash = ?
    `).get(planHash) as {
      policy_hash: unknown;
      policy_json: unknown;
      plan_json: unknown;
      external_intent_hash: unknown;
      external_intent_json: unknown;
      recorded_at_ms: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const policy = guarded("CORRUPT_ROW", "Stored cross-batch policy failed validation.", () =>
      crossBatchClearingPolicy(
        parseProtocolJson(jsonText(row.policy_json, "policy_json")) as CrossBatchClearingPolicy,
      ));
    if (!bytesEqual(policy.policyHash, hashBytes(row.policy_hash, "policy_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch policy identity is inconsistent.");
    }
    const sourceRows = this.db.prepare(`
      SELECT i.intent_hash, i.intent_json
      FROM cross_batch_clearing_sources s
      JOIN netting_external_execution_intents i ON i.intent_hash = s.source_intent_hash
      WHERE s.plan_hash = ?
      ORDER BY i.intent_hash
    `).all(planHash) as { intent_hash: unknown; intent_json: unknown }[];
    const sourceIntents = Object.freeze(sourceRows.map((source) => {
      const intent = parseProtocolJson(jsonText(source.intent_json, "intent_json")) as NettingExternalExecutionIntent;
      if (!bytesEqual(intent.intentHash, hashBytes(source.intent_hash, "intent_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch source identity is inconsistent.");
      }
      return intent;
    }));
    const plan = parseProtocolJson(jsonText(row.plan_json, "plan_json")) as CrossBatchClearingPlan;
    guarded("CORRUPT_ROW", "Stored cross-batch plan failed validation.", () =>
      verifyCrossBatchClearingPlan(plan, sourceIntents, policy));
    if (!bytesEqual(plan.planHash, planHash)) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch plan identity is inconsistent.");
    }
    let intent: CrossBatchExternalExecutionIntent | undefined;
    if (row.external_intent_json !== null || row.external_intent_hash !== null) {
      if (row.external_intent_json === null || row.external_intent_hash === null) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch external intent is incomplete.");
      }
      intent = parseProtocolJson(jsonText(row.external_intent_json, "external_intent_json")) as CrossBatchExternalExecutionIntent;
      guarded("CORRUPT_ROW", "Stored cross-batch external intent failed validation.", () =>
        verifyCrossBatchExternalExecutionIntent(intent!, plan));
      if (!bytesEqual(intent.intentHash, hashBytes(row.external_intent_hash, "external_intent_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch external intent identity is inconsistent.");
      }
    }
    const evidenceRow = this.db.prepare(`
      SELECT evidence_hash, evidence_json FROM cross_batch_execution_evidence WHERE plan_hash = ?
    `).get(planHash) as { evidence_hash: unknown; evidence_json: unknown } | undefined;
    let evidence: CrossBatchExternalExecutionEvidence | undefined;
    if (evidenceRow !== undefined) {
      if (intent === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "Cross-batch evidence lacks an external intent.");
      evidence = parseProtocolJson(jsonText(evidenceRow.evidence_json, "evidence_json")) as CrossBatchExternalExecutionEvidence;
      guarded("CORRUPT_ROW", "Stored cross-batch evidence failed validation.", () =>
        verifyCrossBatchExternalExecutionEvidence(evidence!, intent!));
      if (!bytesEqual(evidence.evidenceHash, hashBytes(evidenceRow.evidence_hash, "evidence_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch evidence identity is inconsistent.");
      }
    }
    const receiptRow = this.db.prepare(`
      SELECT receipt_hash, receipt_json FROM cross_batch_clearing_receipts WHERE plan_hash = ?
    `).get(planHash) as { receipt_hash: unknown; receipt_json: unknown } | undefined;
    let receipt: CrossBatchClearingReceipt | undefined;
    if (receiptRow !== undefined) {
      receipt = parseProtocolJson(jsonText(receiptRow.receipt_json, "receipt_json")) as CrossBatchClearingReceipt;
      guarded("CORRUPT_ROW", "Stored cross-batch receipt failed validation.", () =>
        verifyCrossBatchClearingReceipt(receipt!, plan, intent, evidence));
      if (!bytesEqual(receipt.receiptHash, hashBytes(receiptRow.receipt_hash, "receipt_hash"))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch receipt identity is inconsistent.");
      }
    }
    const recordedAtMs = row.recorded_at_ms;
    if (typeof recordedAtMs !== "number" || !Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored cross-batch timestamp is invalid.");
    }
    const status = receipt !== undefined
      ? "EXACT_FILLED"
      : evidence !== undefined && evidence.outcome !== "EXACT_FILLED"
        ? "RECOVERY_REQUIRED"
        : "PENDING";
    return Object.freeze({
      status,
      policy,
      sourceIntents,
      plan,
      ...(intent === undefined ? {} : { intent }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(receipt === undefined ? {} : { receipt }),
      recordedAtMs,
    });
  }

  crossBatchClearingForSourceIntent(
    sourceIntentHashInput: Uint8Array | string,
  ): PreparedCrossBatchClearing | undefined {
    const row = this.db.prepare(`
      SELECT plan_hash FROM cross_batch_clearing_sources WHERE source_intent_hash = ?
    `).get(commitmentHash(sourceIntentHashInput)) as { plan_hash: unknown } | undefined;
    return row === undefined ? undefined : this.crossBatchClearing(hashBytes(row.plan_hash, "plan_hash"));
  }

  recordVerifiedCrossBatchExternalExecutionEvidence(
    evidence: CrossBatchExternalExecutionEvidence,
  ): { readonly evidence: CrossBatchExternalExecutionEvidence; readonly replayed: boolean } {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT plan_hash FROM cross_batch_clearing_plans WHERE external_intent_hash = ?
      `).get(commitmentHash(evidence.intentHash)) as { plan_hash: unknown } | undefined;
      if (row === undefined) {
        throw new PackageExchangeStoreError("CROSS_BATCH_INTENT_NOT_FOUND", "Cross-batch external intent is not stored.");
      }
      const planHash = hashBytes(row.plan_hash, "plan_hash");
      const clearing = this.crossBatchClearing(planHash);
      if (clearing?.intent === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Cross-batch external intent lost its plan.");
      }
      guarded("INVALID_INPUT", "Cross-batch execution evidence is invalid.", () =>
        verifyCrossBatchExternalExecutionEvidence(evidence, clearing.intent!));
      const existing = this.db.prepare(`
        SELECT evidence_hash, evidence_json FROM cross_batch_execution_evidence WHERE plan_hash = ?
      `).get(planHash) as { evidence_hash: unknown; evidence_json: unknown } | undefined;
      if (existing !== undefined) {
        if (!bytesEqual(hashBytes(existing.evidence_hash, "evidence_hash"), evidence.evidenceHash)
          || jsonText(existing.evidence_json, "evidence_json") !== stringifyProtocolJson(evidence)) {
          throw new PackageExchangeStoreError(
            "CROSS_BATCH_EVIDENCE_CONFLICT",
            "Cross-batch intent already has different terminal evidence.",
          );
        }
        return Object.freeze({ evidence, replayed: true });
      }
      const recordedAtMs = this.clock();
      this.db.prepare(`
        INSERT INTO cross_batch_execution_evidence
          (evidence_hash, plan_hash, evidence_json, recorded_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(evidence.evidenceHash, planHash, stringifyProtocolJson(evidence), recordedAtMs);
      if (evidence.outcome === "EXACT_FILLED") {
        const receipt = crossBatchClearingReceipt(clearing.plan, clearing.intent, evidence);
        this.db.prepare(`
          INSERT INTO cross_batch_clearing_receipts
            (receipt_hash, plan_hash, receipt_json, recorded_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(receipt.receiptHash, planHash, stringifyProtocolJson(receipt), recordedAtMs);
        for (const source of clearing.plan.sources) {
          this.ensureNettingFinalAllocationReceipt(source.nettingProofHash);
        }
      }
      return Object.freeze({ evidence, replayed: false });
    });
  }

  nettingAllocationExecutionAuthorization(
    authorizationHashInput: Uint8Array | string,
  ): NettingAllocationExecutionAuthorization | undefined {
    const authorizationHash = commitmentHash(authorizationHashInput);
    const row = this.db.prepare(`
      SELECT proof_hash, final_allocation_receipt_hash, allocation_receipt_hash, authorization_json
      FROM netting_allocation_execution_authorizations
      WHERE authorization_hash = ?
    `).get(authorizationHash) as {
      proof_hash: unknown;
      final_allocation_receipt_hash: unknown;
      allocation_receipt_hash: unknown;
      authorization_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const proofHash = hashBytes(row.proof_hash, "proof_hash");
    const batch = this.nettingBatch(proofHash);
    if (batch?.finalAllocationReceipt === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Execution authorization lost its final allocation receipt.");
    }
    const authorization = parseProtocolJson(
      jsonText(row.authorization_json, "authorization_json"),
    ) as NettingAllocationExecutionAuthorization;
    const allocation = batch.finalAllocationReceipt.allocations.find((candidate) =>
      bytesEqual(candidate.allocationReceiptHash, authorization.allocationReceiptHash));
    const settlement = allocation === undefined ? undefined : this.settlementCommitment(allocation.packageOrderId);
    if (allocation === undefined || settlement === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Execution authorization lost its settlement commitment.");
    }
    guarded("CORRUPT_ROW", "Stored execution authorization failed validation.", () =>
      verifyNettingAllocationExecutionAuthorization(
        authorization,
        batch.finalAllocationReceipt!,
        batch.result,
        batch.policy,
        batch.externalExecutions.map((record) => record.intent),
        batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
        settlement,
        this.crossBatchResolutionsForProof(proofHash),
      ));
    if (
      !bytesEqual(authorization.authorizationHash, authorizationHash)
      || !bytesEqual(authorization.nettingProofHash, proofHash)
      || !bytesEqual(
        authorization.finalAllocationReceiptHash,
        hashBytes(row.final_allocation_receipt_hash, "final_allocation_receipt_hash"),
      )
      || !bytesEqual(
        authorization.allocationReceiptHash,
        hashBytes(row.allocation_receipt_hash, "allocation_receipt_hash"),
      )
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored execution authorization identity is inconsistent.");
    }
    return authorization;
  }

  nettingAllocationExecutionAuthorizations(
    proofHashInput: Uint8Array | string,
  ): readonly NettingAllocationExecutionAuthorization[] {
    const proofHash = commitmentHash(proofHashInput);
    if (this.nettingBatch(proofHash) === undefined) {
      throw new PackageExchangeStoreError("NETTING_BATCH_NOT_FOUND", "Prepared netting batch is not stored.");
    }
    const rows = this.db.prepare(`
      SELECT authorization_hash
      FROM netting_allocation_execution_authorizations
      WHERE proof_hash = ?
      ORDER BY allocation_receipt_hash
    `).all(proofHash) as { authorization_hash: unknown }[];
    return Object.freeze(rows.map((row) => {
      const authorization = this.nettingAllocationExecutionAuthorization(
        hashBytes(row.authorization_hash, "authorization_hash"),
      );
      if (authorization === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored execution authorization disappeared.");
      }
      return authorization;
    }));
  }

  recordNettingAllocationExecutionAuthorization(
    authorization: NettingAllocationExecutionAuthorization,
  ): { readonly authorization: NettingAllocationExecutionAuthorization; readonly replayed: boolean } {
    return this.transaction(() => {
      const receiptRow = this.db.prepare(`
        SELECT proof_hash
        FROM netting_final_allocation_receipts
        WHERE receipt_hash = ?
      `).get(commitmentHash(authorization.finalAllocationReceiptHash)) as { proof_hash: unknown } | undefined;
      if (receiptRow === undefined) {
        throw new PackageExchangeStoreError("NETTING_FINAL_ALLOCATION_NOT_FOUND", "Final allocation receipt is not stored.");
      }
      const proofHash = hashBytes(receiptRow.proof_hash, "proof_hash");
      const batch = this.nettingBatch(proofHash);
      if (batch?.finalAllocationReceipt === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Final allocation receipt lost its netting batch.");
      }
      const allocation = batch.finalAllocationReceipt.allocations.find((candidate) =>
        bytesEqual(candidate.allocationReceiptHash, authorization.allocationReceiptHash));
      const settlement = allocation === undefined ? undefined : this.settlementCommitment(allocation.packageOrderId);
      if (allocation === undefined || settlement === undefined) {
        throw new PackageExchangeStoreError(
          "NETTING_SETTLEMENT_COMMITMENT_NOT_FOUND",
          "Execution authorization does not have a stored settlement commitment.",
        );
      }
      guarded("INVALID_INPUT", "Allocation execution authorization is invalid.", () =>
        verifyNettingAllocationExecutionAuthorization(
          authorization,
          batch.finalAllocationReceipt!,
          batch.result,
          batch.policy,
          batch.externalExecutions.map((record) => record.intent),
          batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
          settlement,
          this.crossBatchResolutionsForProof(proofHash),
        ));
      const authorizationHash = commitmentHash(authorization.authorizationHash);
      const allocationReceiptHash = commitmentHash(authorization.allocationReceiptHash);
      const authorizationJson = stringifyProtocolJson(authorization);
      const existing = this.db.prepare(`
        SELECT authorization_hash, allocation_receipt_hash, authorization_json
        FROM netting_allocation_execution_authorizations
        WHERE authorization_hash = ? OR allocation_receipt_hash = ?
      `).all(authorizationHash, allocationReceiptHash) as {
        authorization_hash: unknown;
        allocation_receipt_hash: unknown;
        authorization_json: unknown;
      }[];
      if (existing.length > 0) {
        if (
          existing.length !== 1
          || !bytesEqual(hashBytes(existing[0]!.authorization_hash, "authorization_hash"), authorizationHash)
          || !bytesEqual(hashBytes(existing[0]!.allocation_receipt_hash, "allocation_receipt_hash"), allocationReceiptHash)
          || jsonText(existing[0]!.authorization_json, "authorization_json") !== authorizationJson
        ) {
          throw new PackageExchangeStoreError(
            "NETTING_EXECUTION_AUTHORIZATION_CONFLICT",
            "Allocation already has a different execution authorization.",
          );
        }
        return Object.freeze({ authorization, replayed: true });
      }
      this.db.prepare(`
        INSERT INTO netting_allocation_execution_authorizations
          (authorization_hash, proof_hash, final_allocation_receipt_hash, allocation_receipt_hash,
           authorization_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        authorizationHash,
        proofHash,
        authorization.finalAllocationReceiptHash,
        allocationReceiptHash,
        authorizationJson,
        this.clock(),
      );
      return Object.freeze({ authorization, replayed: false });
    });
  }

  recordNettingAllocationExecutionObservation(
    observation: NettingAllocationExecutionObservation,
  ): { readonly evidence: NettingAllocationSettlementEvidence; readonly replayed: boolean } {
    const authorization = this.nettingAllocationExecutionAuthorization(observation.authorizationHash);
    if (authorization === undefined) {
      throw new PackageExchangeStoreError(
        "NETTING_EXECUTION_AUTHORIZATION_NOT_FOUND",
        "Execution observation does not have a stored authorization.",
      );
    }
    const batch = this.nettingBatch(authorization.nettingProofHash);
    if (batch?.finalAllocationReceipt === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Execution authorization lost its netting batch.");
    }
    const evidence = guarded("INVALID_INPUT", "Allocation execution observation is invalid.", () =>
      nettingAllocationSettlementEvidence({
        version: 1,
        finalAllocationReceiptHash: authorization.finalAllocationReceiptHash,
        allocationReceiptHash: authorization.allocationReceiptHash,
        settlementAccount: authorization.settlementAccount,
        settledQuantityAtoms: authorization.settledQuantityAtoms,
        settledQuoteDeltaAtoms: authorization.settledQuoteDeltaAtoms,
        observedAtUnit: observation.observedAtUnit,
        observedAtValue: observation.observedAtValue,
        settlementReferenceHash: observation.settlementReferenceHash,
        authoritativeEvidenceHash: observation.authoritativeEvidenceHash,
      },
      batch.finalAllocationReceipt!,
      batch.result,
      batch.policy,
      batch.externalExecutions.map((record) => record.intent),
      batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
      this.crossBatchResolutionsForProof(authorization.nettingProofHash),
      ));
    return this.recordVerifiedNettingAllocationSettlementEvidence(evidence);
  }

  recordVerifiedNettingAllocationSettlementEvidence(
    evidence: NettingAllocationSettlementEvidence,
  ): { readonly evidence: NettingAllocationSettlementEvidence; readonly replayed: boolean } {
    return this.transaction(() => {
      const receiptRow = this.db.prepare(`
        SELECT proof_hash
        FROM netting_final_allocation_receipts
        WHERE receipt_hash = ?
      `).get(commitmentHash(evidence.finalAllocationReceiptHash)) as { proof_hash: unknown } | undefined;
      if (receiptRow === undefined) {
        throw new PackageExchangeStoreError("NETTING_FINAL_ALLOCATION_NOT_FOUND", "Final allocation receipt is not stored.");
      }
      const proofHash = hashBytes(receiptRow.proof_hash, "proof_hash");
      const batch = this.nettingBatch(proofHash);
      if (batch?.finalAllocationReceipt === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Final allocation receipt lost its netting batch.");
      }
      guarded("INVALID_INPUT", "Allocation settlement evidence is invalid.", () =>
        verifyNettingAllocationSettlementEvidence(
          evidence,
          batch.finalAllocationReceipt!,
          batch.result,
          batch.policy,
          batch.externalExecutions.map((record) => record.intent),
          batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
          this.crossBatchResolutionsForProof(proofHash),
        ));
      const allocation = batch.finalAllocationReceipt.allocations.find((candidate) =>
        bytesEqual(candidate.allocationReceiptHash, evidence.allocationReceiptHash));
      const commitment = allocation === undefined ? undefined : this.settlementCommitment(allocation.packageOrderId);
      if (
        allocation === undefined
        || commitment === undefined
        || commitment.participantId !== evidence.ownerId
        || commitment.settlementAccount !== evidence.settlementAccount
      ) {
        throw new PackageExchangeStoreError(
          "NETTING_SETTLEMENT_ACCOUNT_MISMATCH",
          "Allocation settlement evidence does not bind the authorized settlement account.",
        );
      }
      const existing = this.db.prepare(`
        SELECT evidence_hash, evidence_json
        FROM netting_allocation_settlement_evidence
        WHERE allocation_receipt_hash = ?
      `).get(evidence.allocationReceiptHash) as { evidence_hash: unknown; evidence_json: unknown } | undefined;
      if (existing !== undefined) {
        if (
          !bytesEqual(hashBytes(existing.evidence_hash, "evidence_hash"), evidence.evidenceHash)
          || jsonText(existing.evidence_json, "evidence_json") !== stringifyProtocolJson(evidence)
        ) {
          throw new PackageExchangeStoreError(
            "NETTING_SETTLEMENT_EVIDENCE_CONFLICT",
            "Allocation already has different settlement evidence.",
          );
        }
        this.ensureNettingSettlementCompletionReceipt(proofHash);
        return Object.freeze({ evidence, replayed: true });
      }
      this.db.prepare(`
        INSERT INTO netting_allocation_settlement_evidence
          (evidence_hash, proof_hash, final_allocation_receipt_hash, allocation_receipt_hash, evidence_json, recorded_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        evidence.evidenceHash,
        proofHash,
        evidence.finalAllocationReceiptHash,
        evidence.allocationReceiptHash,
        stringifyProtocolJson(evidence),
        this.clock(),
      );
      this.ensureNettingSettlementCompletionReceipt(proofHash);
      return Object.freeze({ evidence, replayed: false });
    });
  }

  private crossBatchResolutionsForProof(
    proofHashInput: Uint8Array | string,
  ): readonly CrossBatchNettingResolution[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT s.plan_hash
      FROM cross_batch_clearing_sources s
      JOIN netting_external_execution_intents i ON i.intent_hash = s.source_intent_hash
      WHERE i.proof_hash = ?
      ORDER BY s.plan_hash
    `).all(commitmentHash(proofHashInput)) as { plan_hash: unknown }[];
    return Object.freeze(rows.flatMap((row) => {
      const clearing = this.crossBatchClearing(hashBytes(row.plan_hash, "plan_hash"));
      if (clearing === undefined) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Cross-batch source lost its clearing plan.");
      }
      if (clearing.receipt === undefined) return [];
      return [Object.freeze({
        policy: clearing.policy,
        sourceIntents: clearing.sourceIntents,
        plan: clearing.plan,
        ...(clearing.intent === undefined ? {} : { intent: clearing.intent }),
        ...(clearing.evidence === undefined ? {} : { evidence: clearing.evidence }),
        receipt: clearing.receipt,
      })];
    }));
  }

  private ensureNettingFinalAllocationReceipt(
    proofHashInput: Uint8Array | string,
  ): NettingFinalAllocationReceipt | undefined {
    const proofHash = commitmentHash(proofHashInput);
    const batch = this.nettingBatch(proofHash);
    if (batch === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "Netting batch disappeared.");
    if (batch.finalAllocationReceipt !== undefined) return batch.finalAllocationReceipt;
    if (batch.externalExecutionStatus !== "NOT_REQUIRED" && batch.externalExecutionStatus !== "EXACT_FILLED") {
      return undefined;
    }
    const receipt = guarded("CORRUPT_ROW", "Final allocation receipt could not be derived.", () =>
      nettingFinalAllocationReceipt(
        batch.result,
        batch.policy,
        batch.externalExecutions.map((record) => record.intent),
        batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
        this.crossBatchResolutionsForProof(proofHash),
      ));
    this.db.prepare(`
      INSERT INTO netting_final_allocation_receipts
        (proof_hash, receipt_hash, receipt_json, recorded_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(proofHash, receipt.receiptHash, stringifyProtocolJson(receipt), this.clock());
    return receipt;
  }

  private ensureNettingSettlementCompletionReceipt(
    proofHashInput: Uint8Array | string,
  ): NettingSettlementCompletionReceipt | undefined {
    const proofHash = commitmentHash(proofHashInput);
    const batch = this.nettingBatch(proofHash);
    if (batch === undefined) throw new PackageExchangeStoreError("CORRUPT_ROW", "Netting batch disappeared.");
    if (batch.settlementCompletionReceipt !== undefined) return batch.settlementCompletionReceipt;
    if (
      batch.finalAllocationReceipt === undefined
      || batch.settlementEvidence.length !== batch.finalAllocationReceipt.allocations.length
    ) {
      return undefined;
    }
    const completion = guarded("CORRUPT_ROW", "Settlement completion receipt could not be derived.", () =>
      nettingSettlementCompletionReceipt(
        batch.finalAllocationReceipt!,
        batch.settlementEvidence,
        batch.result,
        batch.policy,
        batch.externalExecutions.map((record) => record.intent),
        batch.externalExecutions.flatMap((record) => record.evidence === undefined ? [] : [record.evidence]),
        this.crossBatchResolutionsForProof(proofHash),
      ));
    this.db.prepare(`
      INSERT INTO netting_settlement_completion_receipts
        (proof_hash, final_allocation_receipt_hash, receipt_hash, receipt_json, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      proofHash,
      completion.finalAllocationReceiptHash,
      completion.receiptHash,
      stringifyProtocolJson(completion),
      this.clock(),
    );
    return completion;
  }

  settlementHandoff(allocationHash: Uint8Array | string): PackageSettlementHandoff | undefined {
    const row = this.db.prepare(`
      SELECT handoff_hash, handoff_json
      FROM package_book_settlement_handoffs
      WHERE allocation_hash = ?
    `).get(commitmentHash(allocationHash)) as {
      handoff_hash: unknown;
      handoff_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const handoff = packageSettlementHandoff(
      parseProtocolJson(jsonText(row.handoff_json, "handoff_json")) as PackageSettlementHandoff,
    );
    if (!bytesEqual(packageSettlementHandoffHash(handoff), hashBytes(row.handoff_hash, "handoff_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement handoff does not match its hash.");
    }
    return handoff;
  }

  reopeningResult(resultHash: Uint8Array | string): PackageReopeningResult | undefined {
    const hash = commitmentHash(resultHash);
    const row = this.db.prepare(`
      SELECT execution_class_id, result_json
      FROM package_book_reopening_results
      WHERE result_hash = ?
    `).get(hash) as {
      execution_class_id: unknown;
      result_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const result = this.decodeReopeningResult(jsonText(row.execution_class_id, "execution_class_id"), row.result_json);
    if (!bytesEqual(packageReopeningResultHash(result), hash)) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening result does not match its hash.");
    }
    return result;
  }

  reopeningSettlementHandoff(resultHash: Uint8Array | string): PackageReopeningSettlementHandoff | undefined {
    const hash = commitmentHash(resultHash);
    const row = this.db.prepare(`
      SELECT handoff_hash, handoff_json
      FROM package_book_reopening_handoffs
      WHERE result_hash = ?
    `).get(hash) as {
      handoff_hash: unknown;
      handoff_json: unknown;
    } | undefined;
    if (row === undefined) return undefined;
    const handoff = packageReopeningSettlementHandoff(
      parseProtocolJson(jsonText(row.handoff_json, "handoff_json")) as PackageReopeningSettlementHandoff,
    );
    if (
      !bytesEqual(handoff.reopeningResultHash, hash)
      || !bytesEqual(packageReopeningSettlementHandoffHash(handoff), hashBytes(row.handoff_hash, "handoff_hash"))
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening handoff does not match its hashes.");
    }
    const result = this.reopeningResult(hash);
    if (result === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening handoff lost its result.");
    }
    guarded("CORRUPT_ROW", "Stored reopening handoff failed verification.", () =>
      verifyPackageReopeningSettlementHandoff(result, handoff),
    );
    return handoff;
  }

  settlementObligations(packageOrderId: Uint8Array | string): readonly PackageSettlementObligation[] {
    const orderId = commitmentHash(packageOrderId);
    const commitment = this.settlementCommitment(orderId);
    const rows = this.db.prepare(`
      SELECT o.allocation_hash, o.fill_sequence, o.role, o.counterparty_order_id,
             o.maker_source, o.price_ticks, o.quantity_atoms
      FROM package_book_settlement_obligations o
      JOIN package_book_allocations a ON a.allocation_hash = o.allocation_hash
      WHERE o.package_order_id = ?
      ORDER BY a.recorded_at_ms, o.fill_index, o.role
    `).all(orderId) as {
      allocation_hash: unknown;
      fill_sequence: unknown;
      role: unknown;
      counterparty_order_id: unknown;
      maker_source: unknown;
      price_ticks: unknown;
      quantity_atoms: unknown;
    }[];
    const handoffs = new Map<string, PackageSettlementHandoff>();
    const takerOrderIds = new Map<string, string>();
    const continuous = rows.map((row) => {
      if ((row.role !== "TAKER" && row.role !== "MAKER")
        || (row.maker_source !== "DIRECT" && row.maker_source !== "IMPLIED")
        || (row.role === "MAKER" && row.maker_source !== "DIRECT")) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation kind is invalid.");
      }
      const counterparty = row.counterparty_order_id === null
        ? undefined
        : toHex(hashBytes(row.counterparty_order_id, "counterparty_order_id"));
      if ((row.maker_source === "DIRECT") !== (counterparty !== undefined)) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation counterparty is invalid.");
      }
      const allocationHashHex = toHex(hashBytes(row.allocation_hash, "allocation_hash"));
      const fillSequence = storedBigInt(row.fill_sequence, "fill_sequence");
      const priceTicks = storedBigInt(row.price_ticks, "price_ticks", true);
      const quantity = storedBigInt(row.quantity_atoms, "quantity_atoms");
      let handoff = handoffs.get(allocationHashHex);
      if (handoff === undefined) {
        handoff = this.settlementHandoff(allocationHashHex);
        if (handoff === undefined) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligation lost its handoff.");
        }
        handoffs.set(allocationHashHex, handoff);
      }
      let takerOrderIdHex = takerOrderIds.get(allocationHashHex);
      if (takerOrderIdHex === undefined) {
        const allocationRow = this.db.prepare(
          "SELECT taker_order_id FROM package_book_allocations WHERE allocation_hash = ?",
        ).get(handoff.allocationHash) as { taker_order_id: unknown } | undefined;
        if (allocationRow === undefined) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligation lost its allocation.");
        }
        takerOrderIdHex = toHex(hashBytes(allocationRow.taker_order_id, "taker_order_id"));
        takerOrderIds.set(allocationHashHex, takerOrderIdHex);
      }
      const fill = handoff.fills.find((candidate) => candidate.fillSequence === fillSequence);
      if (commitment === undefined || fill === undefined
        || fill.makerSource !== row.maker_source
        || fill.priceTicks !== priceTicks
        || fill.quantity !== quantity
        || (row.role === "TAKER" && (!bytesEqual(
          handoff.takerSettlementCommitmentHash,
          packageSettlementCommitmentHash(commitment),
        ) || (fill.makerSource === "DIRECT" && counterparty !== toHex(fill.makerEntryId))))
        || (row.role === "MAKER" && (!bytesEqual(fill.makerEntryId, orderId)
          || counterparty !== takerOrderIdHex
          || fill.makerSettlementCommitmentHash === undefined
          || !bytesEqual(fill.makerSettlementCommitmentHash, packageSettlementCommitmentHash(commitment))))) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement obligation differs from its handoff.");
      }
      return Object.freeze({
        evidenceKind: "CONTINUOUS_ALLOCATION" as const,
        evidenceHashHex: allocationHashHex,
        fillSequence,
        role: row.role,
        ...(counterparty === undefined ? {} : { counterpartyOrderIdHex: counterparty }),
        liquiditySource: row.maker_source,
        priceTicks,
        quantity,
      });
    });
    const reopeningRows = this.db.prepare(`
      SELECT o.result_hash, o.fill_sequence, o.role, o.counterparty_order_id,
             o.price_ticks, o.quantity_atoms
      FROM package_book_reopening_obligations o
      JOIN package_book_reopening_results r ON r.result_hash = o.result_hash
      WHERE o.package_order_id = ?
      ORDER BY r.recorded_at_ms, o.fill_index, o.role
    `).all(orderId) as {
      result_hash: unknown;
      fill_sequence: unknown;
      role: unknown;
      counterparty_order_id: unknown;
      price_ticks: unknown;
      quantity_atoms: unknown;
    }[];
    const reopeningHandoffs = new Map<string, PackageReopeningSettlementHandoff>();
    const reopening = reopeningRows.map((row) => {
      if (row.role !== "BID" && row.role !== "ASK") {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening obligation role is invalid.");
      }
      const evidenceHashHex = toHex(hashBytes(row.result_hash, "result_hash"));
      const counterpartyOrderIdHex = toHex(hashBytes(row.counterparty_order_id, "counterparty_order_id"));
      const fillSequence = storedBigInt(row.fill_sequence, "fill_sequence");
      const priceTicks = storedBigInt(row.price_ticks, "price_ticks", true);
      const quantity = storedBigInt(row.quantity_atoms, "quantity_atoms");
      let handoff = reopeningHandoffs.get(evidenceHashHex);
      if (handoff === undefined) {
        handoff = this.reopeningSettlementHandoff(evidenceHashHex);
        if (handoff === undefined) {
          throw new PackageExchangeStoreError("CORRUPT_ROW", "Reopening obligation lost its handoff.");
        }
        reopeningHandoffs.set(evidenceHashHex, handoff);
      }
      const fill = handoff.fills.find((candidate) => candidate.fillSequence === fillSequence);
      const expectedOrderId = row.role === "BID" ? fill?.bidEntryId : fill?.askEntryId;
      const expectedCounterparty = row.role === "BID" ? fill?.askEntryId : fill?.bidEntryId;
      const expectedCommitmentHash = row.role === "BID"
        ? fill?.bidSettlementCommitmentHash
        : fill?.askSettlementCommitmentHash;
      if (
        commitment === undefined
        || fill === undefined
        || expectedOrderId === undefined
        || expectedCounterparty === undefined
        || expectedCommitmentHash === undefined
        || !bytesEqual(expectedOrderId, orderId)
        || toHex(expectedCounterparty) !== counterpartyOrderIdHex
        || !bytesEqual(expectedCommitmentHash, packageSettlementCommitmentHash(commitment))
        || fill.priceTicks !== priceTicks
        || fill.quantity !== quantity
      ) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening obligation differs from its handoff.");
      }
      return Object.freeze({
        evidenceKind: "REOPENING_RESULT" as const,
        evidenceHashHex,
        fillSequence,
        role: row.role,
        counterpartyOrderIdHex,
        liquiditySource: "DIRECT" as const,
        priceTicks,
        quantity,
      });
    });
    return Object.freeze([...continuous, ...reopening]);
  }

  settlementProgress(packageOrderId: Uint8Array | string): PackageSettlementProgress | undefined {
    const orderId = commitmentHash(packageOrderId);
    const commitment = this.settlementCommitment(orderId);
    if (commitment === undefined) return undefined;
    const obligations = this.settlementObligations(orderId);
    const allocatedQuantity = obligations.reduce((sum, obligation) => sum + obligation.quantity, 0n);
    if (allocatedQuantity > commitment.quantity) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Settlement obligations exceed the committed quantity.");
    }
    const remainingQuantity = commitment.quantity - allocatedQuantity;
    const { book } = this.policyAndBook(commitment.executionClassId);
    const acceptsFurtherMatches = book.entries.some((entry) => bytesEqual(entry.entryId, orderId));
    if (remainingQuantity === 0n && acceptsFurtherMatches) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "A fully allocated package order remains in the book.");
    }
    const status = allocatedQuantity === commitment.quantity
      ? "READY_FOR_OWNER_AUTHORIZATION" as const
      : acceptsFurtherMatches
        ? allocatedQuantity === 0n ? "AWAITING_MATCH" as const : "PARTIALLY_ALLOCATED" as const
        : allocatedQuantity === 0n ? "CANCELLED_UNFILLED" as const : "PARTIAL_AUTHORIZATION_REQUIRED" as const;
    const readiness = packageSettlementReadiness({
      version: 2,
      packageOrderId: orderId,
      settlementCommitmentHash: packageSettlementCommitmentHash(commitment),
      strategyOrderHash: commitment.strategyOrderHash,
      executionClassId: commitment.executionClassId,
      committedQuantity: commitment.quantity,
      allocatedQuantity,
      remainingQuantity,
      acceptsFurtherMatches,
      status,
      evidenceRefs: [...new Map(obligations.map((obligation) => [
        `${obligation.evidenceKind}:${obligation.evidenceHashHex}`,
        { kind: obligation.evidenceKind, evidenceHash: obligation.evidenceHashHex },
      ])).values()],
    });
    return Object.freeze({
      readiness,
      readinessHashHex: toHex(packageSettlementReadinessHash(readiness)),
      obligations,
    });
  }

  /**
   * Trades for one book in recorded order after an opaque cursor: allocations with at least one
   * fill. An order that only rested is not a trade and is never listed. The cursor is the storage
   * row order, so a reader resumes exactly where it stopped and never sees a trade twice.
   */
  allocationTape(executionClassId: string, afterCursor: number, limit: number): readonly PackageTapeRecord[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TAPE_PAGE) {
      throw new PackageExchangeStoreError("INVALID_INPUT", `Tape cursor must be nonnegative and limit between 1 and ${MAX_TAPE_PAGE}.`);
    }
    if (this.getBook(executionClassId) === undefined) {
      throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "Package book is not open.");
    }
    const rows = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? AND t.allocation_rowid > ? ORDER BY t.allocation_rowid LIMIT ?`,
      )
      .all(executionClassId, afterCursor, limit) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown }[];
    return Object.freeze(rows.map((row) => this.tapeRecord(executionClassId, row)));
  }

  /** The most recently recorded allocation of one book, or undefined when it has never traded. */
  latestTrade(executionClassId: string): PackageTapeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT t.allocation_rowid AS cursor, a.allocation_hash, a.allocation_json, a.recorded_at_ms FROM package_book_trades t
         JOIN package_book_allocations a ON a.allocation_hash = t.allocation_hash
         WHERE t.execution_class_id = ? ORDER BY t.allocation_rowid DESC LIMIT 1`,
      )
      .get(executionClassId) as { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown } | undefined;
    return row === undefined ? undefined : this.tapeRecord(executionClassId, row);
  }

  private tapeRecord(
    executionClassId: string,
    row: { cursor: unknown; allocation_hash: unknown; allocation_json: unknown; recorded_at_ms: unknown },
  ): PackageTapeRecord {
    if (typeof row.cursor !== "number" || typeof row.recorded_at_ms !== "number") {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored tape row is invalid.");
    }
    const allocation = this.decodeAllocation(executionClassId, row.allocation_json);
    const allocationHash = packageAllocationHash(allocation);
    if (!bytesEqual(allocationHash, hashBytes(row.allocation_hash, "allocation_hash"))) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored allocation hash does not match its content.");
    }
    return Object.freeze({ cursor: row.cursor, allocation, allocationHashHex: toHex(allocationHash), recordedAtMs: row.recorded_at_ms });
  }

  // ---------------------------------------------------------------- internals

  private transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  private insertDocument(
    kind: ExchangeDocumentKind,
    subjectId: string,
    subjectVersion: number,
    bytes: Uint8Array,
    hash: Uint8Array,
    document: unknown,
  ): RegisteredExchangeDocument {
    const existing = this.documentBySubject(kind, subjectId, subjectVersion);
    const documentHashHex = toHex(hash);
    if (existing !== undefined) {
      // A published version is never reinterpreted: the same identity must carry the same bytes.
      if (!bytesEqual(hashBytes(existing.document_hash, "document_hash"), hash)) {
        throw new PackageExchangeStoreError(
          "DOCUMENT_CONFLICT",
          `${kind} ${subjectId} version ${subjectVersion} is already registered with different content.`,
        );
      }
      return { kind, subjectId, subjectVersion, documentHashHex, created: false };
    }
    this.db
      .prepare(
        "INSERT INTO exchange_documents (document_hash, kind, subject_id, subject_version, canonical_bytes, document_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(hash, kind, subjectId, subjectVersion, bytes, stringifyProtocolJson(document));
    return { kind, subjectId, subjectVersion, documentHashHex, created: true };
  }

  private documentBySubject(kind: ExchangeDocumentKind, subjectId: string, subjectVersion: number): DocumentRow | undefined {
    return this.db
      .prepare(
        "SELECT document_hash, canonical_bytes, document_json FROM exchange_documents WHERE kind = ? AND subject_id = ? AND subject_version = ?",
      )
      .get(kind, subjectId, subjectVersion) as DocumentRow | undefined;
  }

  private documentByHash(kind: ExchangeDocumentKind, hash: Uint8Array): DocumentRow | undefined {
    return this.db
      .prepare("SELECT document_hash, canonical_bytes, document_json FROM exchange_documents WHERE kind = ? AND document_hash = ?")
      .get(kind, hash) as DocumentRow | undefined;
  }

  private verifiedDocument<T>(
    row: DocumentRow,
    build: (value: never) => T,
    bytesOf: (value: T) => Uint8Array,
    hashOf: (value: T) => Uint8Array,
  ): T {
    const value = guarded("CORRUPT_ROW", "Stored exchange document failed validation.", () =>
      build(parseProtocolJson(jsonText(row.document_json, "document_json")) as never),
    );
    if (
      !bytesEqual(bytesOf(value), row.canonical_bytes as Uint8Array) ||
      !bytesEqual(hashOf(value), hashBytes(row.document_hash, "document_hash"))
    ) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored exchange document does not match its canonical hash.");
    }
    return value;
  }

  private loadSeries(row: DocumentRow): EconomicStrategySeries {
    return this.verifiedDocument(
      row,
      (value: EconomicStrategySeriesInput) => economicStrategySeries(value, this.options.seriesSupport),
      (value) => economicStrategySeriesBytes(value, this.options.seriesSupport),
      (value) => economicStrategySeriesHash(value, this.options.seriesSupport),
    );
  }

  private loadExecutionClass(row: DocumentRow): SeriesExecutionClass {
    return this.verifiedDocument(
      row,
      (value: SeriesExecutionClassInput) => seriesExecutionClass(value, this.options.executionClassSupport),
      (value) => seriesExecutionClassBytes(value, this.options.executionClassSupport),
      (value) => seriesExecutionClassHash(value, this.options.executionClassSupport),
    );
  }

  private loadPolicy(row: DocumentRow): PackageMatchingPolicy {
    return this.verifiedDocument(
      row,
      (value: PackageMatchingPolicyInput) => packageMatchingPolicy(value),
      packageMatchingPolicyBytes,
      packageMatchingPolicyHash,
    );
  }

  private policyForClass(executionClass: SeriesExecutionClass): PackageMatchingPolicy {
    const row = this.documentByHash("MATCHING_POLICY", executionClass.matchingPolicyHash);
    if (row === undefined) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Execution class lost its matching policy.");
    }
    return this.loadPolicy(row);
  }

  private policyAndBook(executionClassId: string): { policy: PackageMatchingPolicy; book: PackageBookState } {
    const row = this.db
      .prepare(
        "SELECT d.document_hash, d.canonical_bytes, d.document_json FROM package_books b JOIN exchange_documents d ON d.document_hash = b.class_hash WHERE b.execution_class_id = ?",
      )
      .get(executionClassId) as DocumentRow | undefined;
    if (row === undefined) {
      throw new PackageExchangeStoreError("BOOK_NOT_FOUND", "No package book is open for this execution class.");
    }
    const policy = this.policyForClass(this.loadExecutionClass(row));
    return { policy, book: this.loadBookWith(policy, executionClassId) };
  }

  private loadBook(executionClassId: string): PackageBookState {
    return this.policyAndBook(executionClassId).book;
  }

  private loadBookWith(policy: PackageMatchingPolicy, executionClassId: string): PackageBookState {
    const meta = this.db
      .prepare("SELECT halted, next_sequence FROM package_books WHERE execution_class_id = ?")
      .get(executionClassId) as { halted: unknown; next_sequence: unknown };
    const entries = (
      this.db
        .prepare("SELECT entry_json FROM package_book_entries WHERE execution_class_id = ?")
        .all(executionClassId) as { entry_json: unknown }[]
    ).map((row) => parseProtocolJson(jsonText(row.entry_json, "entry_json")) as PackageBookEntry);
    const consumedSourceKeys = (
      this.db
        .prepare("SELECT source_key FROM package_book_consumed_sources WHERE execution_class_id = ?")
        .all(executionClassId) as { source_key: unknown }[]
    ).map((row) => toHex(hashBytes(row.source_key, "source_key")));
    return guarded("CORRUPT_ROW", "Stored package book failed validation.", () =>
      packageBookState(policy, {
        executionClassId: policy.executionClassId,
        matchingPolicyHash: packageMatchingPolicyHash(policy),
        halted: meta.halted === 1,
        nextSequence: BigInt(jsonText(meta.next_sequence, "next_sequence")),
        entries,
        consumedSourceKeys,
      }),
    );
  }

  /**
   * Writes a book state incrementally: only added, changed, or removed entries touch storage. A
   * mutation that grows the book or one participant past its cap is refused inside the caller's
   * transaction, while cancels and fills are always allowed.
   */
  private writeBook(state: PackageBookState): void {
    const classId = state.executionClassId;
    const stored = new Map<string, string>(
      (this.db.prepare("SELECT entry_id, entry_json FROM package_book_entries WHERE execution_class_id = ?").all(classId) as {
        entry_id: Uint8Array;
        entry_json: string;
      }[]).map((row) => [toHex(row.entry_id), row.entry_json]),
    );
    const participants = (entries: Iterable<{ participantId: string }>) => {
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.participantId, (counts.get(entry.participantId) ?? 0) + 1);
      return counts;
    };
    const before = participants([...stored.values()].map((json) => ({ participantId: String((JSON.parse(json) as { participantId?: unknown }).participantId) })));
    const after = participants(state.entries);
    if (state.entries.length > MAX_BOOK_ENTRIES && state.entries.length > stored.size) {
      throw new PackageExchangeStoreError("BOOK_FULL", `A package book holds at most ${MAX_BOOK_ENTRIES} entries.`);
    }
    for (const [participantId, count] of after) {
      if (count > MAX_ENTRIES_PER_PARTICIPANT && count > (before.get(participantId) ?? 0)) {
        throw new PackageExchangeStoreError("PARTICIPANT_BOOK_LIMIT", `One participant may hold at most ${MAX_ENTRIES_PER_PARTICIPANT} entries in a book.`);
      }
    }
    this.db
      .prepare("UPDATE package_books SET halted = ?, next_sequence = ? WHERE execution_class_id = ?")
      .run(state.halted ? 1 : 0, sequenceText(state.nextSequence), classId);
    const insert = this.db.prepare(
      "INSERT INTO package_book_entries (entry_id, execution_class_id, entry_json) VALUES (?, ?, ?)",
    );
    const update = this.db.prepare("UPDATE package_book_entries SET entry_json = ? WHERE entry_id = ? AND execution_class_id = ?");
    const remove = this.db.prepare("DELETE FROM package_book_entries WHERE entry_id = ? AND execution_class_id = ?");
    const kept = new Set<string>();
    for (const entry of state.entries) {
      const key = toHex(entry.entryId);
      const json = stringifyProtocolJson(entry);
      kept.add(key);
      const previous = stored.get(key);
      if (previous === undefined) insert.run(entry.entryId, classId, json);
      else if (previous !== json) update.run(json, entry.entryId, classId);
    }
    for (const key of stored.keys()) if (!kept.has(key)) remove.run(Buffer.from(key, "hex"), classId);
  }

  private decodeAllocation(executionClassId: string, json: unknown): PackageAllocation {
    const { policy } = this.policyAndBook(executionClassId);
    return guarded("CORRUPT_ROW", "Stored allocation failed validation.", () => {
      const allocation = packageAllocation(parseProtocolJson(jsonText(json, "allocation_json")) as PackageAllocation);
      verifyPackageAllocation(policy, allocation);
      return allocation;
    });
  }

  private decodeReopeningResult(executionClassId: string, json: unknown): PackageReopeningResult {
    return guarded("CORRUPT_ROW", "Stored reopening result failed validation.", () => {
      const result = packageReopeningResult(
        parseProtocolJson(jsonText(json, "result_json")) as PackageReopeningResult,
      );
      if (result.executionClassId !== executionClassId) {
        throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored reopening result belongs to another book.");
      }
      return result;
    });
  }

  private insertSettlementAuthorization(
    commitment: PackageSettlementCommitment,
    input: PackageSettlementAuthorizationEvidenceInput,
  ): void {
    const evidence = settlementAuthorizationEvidence(input);
    const packageOrderId = commitment.packageOrderId;
    const commitmentHashValue = packageSettlementCommitmentHash(commitment);
    const existing = this.db.prepare(`
      SELECT commitment_hash, participant_id, scheme, signature
      FROM package_book_settlement_authorizations
      WHERE package_order_id = ?
    `).get(packageOrderId) as {
      commitment_hash: unknown;
      participant_id: unknown;
      scheme: unknown;
      signature: unknown;
    } | undefined;
    if (existing !== undefined) {
      if (
        !bytesEqual(commitmentHashValue, hashBytes(existing.commitment_hash, "commitment_hash"))
        || jsonText(existing.participant_id, "participant_id") !== commitment.participantId
        || jsonText(existing.scheme, "scheme") !== evidence.scheme
        || jsonText(existing.signature, "signature") !== evidence.signature
      ) {
        throw new PackageExchangeStoreError(
          "SETTLEMENT_AUTHORIZATION_CONFLICT",
          "Package order is already bound to another settlement authorization.",
        );
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO package_book_settlement_authorizations
        (package_order_id, commitment_hash, participant_id, scheme, signature, authorized_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      packageOrderId,
      commitmentHashValue,
      commitment.participantId,
      evidence.scheme,
      evidence.signature,
      this.clock(),
    );
  }

  private settlementEvidenceCount(packageOrderId: Uint8Array | string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT allocation_hash AS evidence_hash
        FROM package_book_settlement_obligations
        WHERE package_order_id = ?
        GROUP BY allocation_hash
        UNION
        SELECT result_hash AS evidence_hash
        FROM package_book_reopening_obligations
        WHERE package_order_id = ?
        GROUP BY result_hash
      )
    `).get(commitmentHash(packageOrderId), commitmentHash(packageOrderId)) as { count: unknown };
    if (typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new PackageExchangeStoreError("CORRUPT_ROW", "Stored settlement evidence count is invalid.");
    }
    return row.count;
  }
}

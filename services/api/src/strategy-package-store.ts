import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import {
  bytesEqual,
  packageGraph,
  packageGraphHash,
  parseProtocolJson,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageQuoteHash,
  strategyPackageQuote,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
  strategyState,
  strategyStateHash,
  stringifyProtocolJson,
  toHex,
  typedStrategyRouteHash,
  type AdmittedStrategyRoute,
  type PackageGraphInput,
  type StrategyPackageOrder,
  type StrategyPackageOrderInput,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
  type StrategyPackageReceipt,
  type StrategyPackageReceiptInput,
  type StrategyState,
  type TypedStrategyRoute,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";
import {
  applyNativeStrategyTransitionReceipt,
  applyNativeStrategyExitReceipt,
  nativeStrategyPositionFromEntry,
  NativeStrategyPositionError,
  validateNativeStrategyExit,
  validateNativeStrategyTransition,
  type NativeStrategyPosition,
  type NativeStrategyPositionStatus,
} from "./native-strategy-position.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategy_package_orders (
  order_hash BLOB PRIMARY KEY,
  graph_hash BLOB NOT NULL,
  owner_id TEXT NOT NULL,
  order_json TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_package_quotes (
  quote_hash BLOB PRIMARY KEY,
  order_hash BLOB NOT NULL REFERENCES strategy_package_orders(order_hash),
  route_hash BLOB NOT NULL UNIQUE,
  solver_id TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  route_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_package_sources (
  order_hash BLOB PRIMARY KEY REFERENCES strategy_package_orders(order_hash),
  source_order_hash BLOB NOT NULL UNIQUE,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_package_authorizations (
  order_hash BLOB PRIMARY KEY REFERENCES strategy_package_orders(order_hash),
  owner_id TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme = 'EIP712_SECP256K1'),
  signature TEXT NOT NULL,
  authorized_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_hash BLOB NOT NULL REFERENCES strategy_package_orders(order_hash),
  graph_hash BLOB NOT NULL,
  quote_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_quotes(quote_hash),
  route_hash BLOB NOT NULL,
  source_order_hash BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status = 'HYPERLIQUID_TESTNET_QUOTE_SELECTED'),
  selected_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_native_execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_hash BLOB NOT NULL REFERENCES strategy_package_orders(order_hash),
  graph_hash BLOB NOT NULL,
  quote_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_quotes(quote_hash),
  route_hash BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status = 'HYPERLIQUID_TESTNET_QUOTE_SELECTED'),
  selected_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_package_receipts (
  receipt_hash BLOB PRIMARY KEY,
  order_hash BLOB NOT NULL REFERENCES strategy_package_orders(order_hash),
  quote_hash BLOB NOT NULL REFERENCES strategy_package_quotes(quote_hash),
  route_hash BLOB NOT NULL REFERENCES strategy_package_quotes(route_hash),
  receipt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_native_positions (
  strategy_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  economic_quantity_atoms TEXT NOT NULL,
  entry_order_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_orders(order_hash),
  entry_receipt_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_receipts(receipt_hash),
  state_hash BLOB NOT NULL UNIQUE,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'EXITING', 'CLOSED', 'UNRESOLVED')),
  exit_order_hash BLOB UNIQUE REFERENCES strategy_package_orders(order_hash),
  exit_receipt_hash BLOB UNIQUE REFERENCES strategy_package_receipts(receipt_hash),
  recorded_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_native_transitions (
  order_hash BLOB PRIMARY KEY REFERENCES strategy_package_orders(order_hash),
  strategy_id TEXT NOT NULL REFERENCES strategy_native_positions(strategy_id),
  action TEXT NOT NULL CHECK (action IN ('INCREASE', 'DECREASE')),
  expected_state_hash BLOB NOT NULL,
  receipt_hash BLOB UNIQUE REFERENCES strategy_package_receipts(receipt_hash),
  selected_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS strategy_evm_positions (
  package_id BLOB PRIMARY KEY,
  owner_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  domain_id TEXT NOT NULL,
  settlement_account TEXT NOT NULL,
  template_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  execution_class_id TEXT NOT NULL,
  base_asset_id TEXT NOT NULL,
  base_asset_decimals INTEGER NOT NULL,
  economic_quantity_atoms TEXT NOT NULL,
  entry_order_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_orders(order_hash),
  latest_order_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_orders(order_hash),
  latest_receipt_hash BLOB NOT NULL UNIQUE REFERENCES strategy_package_receipts(receipt_hash),
  state_hash BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  recorded_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS strategy_package_orders_by_owner ON strategy_package_orders(owner_id, recorded_at_ms);
CREATE INDEX IF NOT EXISTS strategy_package_quotes_by_order ON strategy_package_quotes(order_hash, recorded_at_ms);
CREATE INDEX IF NOT EXISTS strategy_package_receipts_by_order ON strategy_package_receipts(order_hash, recorded_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_package_receipts_by_quote ON strategy_package_receipts(quote_hash);
CREATE INDEX IF NOT EXISTS strategy_native_positions_by_owner ON strategy_native_positions(owner_id, status, updated_at_ms);
CREATE INDEX IF NOT EXISTS strategy_evm_positions_by_owner ON strategy_evm_positions(owner_id, status, updated_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_evm_open_state_hash
ON strategy_evm_positions(state_hash) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS strategy_native_pending_transition
ON strategy_native_transitions(strategy_id) WHERE receipt_hash IS NULL;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_order_change BEFORE UPDATE ON strategy_package_orders BEGIN SELECT RAISE(ABORT, 'strategy package orders are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_order_delete BEFORE DELETE ON strategy_package_orders BEGIN SELECT RAISE(ABORT, 'strategy package orders are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_quote_change BEFORE UPDATE ON strategy_package_quotes BEGIN SELECT RAISE(ABORT, 'strategy package quotes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_quote_delete BEFORE DELETE ON strategy_package_quotes BEGIN SELECT RAISE(ABORT, 'strategy package quotes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_source_change BEFORE UPDATE ON strategy_package_sources BEGIN SELECT RAISE(ABORT, 'strategy package sources are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_source_delete BEFORE DELETE ON strategy_package_sources BEGIN SELECT RAISE(ABORT, 'strategy package sources are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_authorization_change BEFORE UPDATE ON strategy_package_authorizations BEGIN SELECT RAISE(ABORT, 'strategy package authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_authorization_delete BEFORE DELETE ON strategy_package_authorizations BEGIN SELECT RAISE(ABORT, 'strategy package authorizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_execution_attempt_change BEFORE UPDATE ON strategy_execution_attempts BEGIN SELECT RAISE(ABORT, 'strategy execution attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_execution_attempt_delete BEFORE DELETE ON strategy_execution_attempts BEGIN SELECT RAISE(ABORT, 'strategy execution attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_native_execution_attempt_change BEFORE UPDATE ON strategy_native_execution_attempts BEGIN SELECT RAISE(ABORT, 'native strategy execution attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_native_execution_attempt_delete BEFORE DELETE ON strategy_native_execution_attempts BEGIN SELECT RAISE(ABORT, 'native strategy execution attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_receipt_change BEFORE UPDATE ON strategy_package_receipts BEGIN SELECT RAISE(ABORT, 'strategy package receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS reject_strategy_package_receipt_delete BEFORE DELETE ON strategy_package_receipts BEGIN SELECT RAISE(ABORT, 'strategy package receipts are immutable'); END;
`;

export class StrategyPackageStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StrategyPackageStoreError";
    this.code = code;
  }
}

export interface StoredStrategyPackageOrder {
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraphInput;
  readonly recordedAtMs: number;
}

export interface StoredStrategyPackageQuote {
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly quote: StrategyPackageQuote;
  readonly route: TypedStrategyRoute;
  readonly recordedAtMs: number;
}

export interface StoredStrategyPackageAdmission {
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly order: StrategyPackageOrder;
  readonly graph: PackageGraphInput;
  readonly quote: StrategyPackageQuote;
  readonly route: TypedStrategyRoute;
  readonly recordedAtMs: number;
}

export interface StoredStrategyPackageReceipt {
  readonly receiptHashHex: string;
  readonly receipt: StrategyPackageReceipt;
  readonly recordedAtMs: number;
}

export interface StoredNativeStrategyPosition extends NativeStrategyPosition {
  readonly recordedAtMs: number;
  readonly updatedAtMs: number;
}

export interface StoredEvmStrategyPosition {
  readonly packageIdHex: string;
  readonly owner: string;
  readonly chainId: number;
  readonly domainId: string;
  readonly settlementAccount: string;
  readonly templateId: string;
  readonly seriesId: string;
  readonly executionClassId: string;
  readonly baseAssetId: string;
  readonly baseAssetDecimals: number;
  readonly economicQuantityAtoms: bigint;
  readonly entryOrderHashHex: string;
  readonly latestOrderHashHex: string;
  readonly latestReceiptHashHex: string;
  readonly stateHashHex: string;
  readonly status: "OPEN" | "CLOSED";
  readonly recordedAtMs: number;
  readonly updatedAtMs: number;
}

export interface EvmStrategyPositionEvidence {
  readonly receiptHashHex: string;
  readonly packageIdHex: string;
  readonly chainId: number;
  readonly account: string;
  readonly previousStateHashHex: string;
  readonly nextStateHashHex: string;
}

export interface StrategyPackageSourceBinding {
  readonly orderHashHex: string;
  readonly sourceOrderHashHex: string;
  readonly recordedAtMs: number;
}

export interface StoredStrategyPackageAuthorization {
  readonly orderHashHex: string;
  readonly owner: string;
  readonly scheme: "EIP712_SECP256K1";
  readonly signature: string;
  readonly authorizedAtMs: number;
}

export interface SelectedStrategyPackageAttempt {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly sourceOrderHashHex: string;
  readonly status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED";
  readonly selectedAtMs: number;
}

export interface SelectHyperliquidStrategyExecutionRequest {
  readonly quoteHashHex: string;
  readonly orderHashHex: string;
  readonly routeHashHex: string;
  readonly sourceOrderHashHex: string;
  readonly idempotencyKey: string;
}

export interface SelectedNativeStrategyPackageAttempt {
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly orderHashHex: string;
  readonly graphHashHex: string;
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED";
  readonly selectedAtMs: number;
}

export interface SelectNativeHyperliquidStrategyExecutionRequest {
  readonly quoteHashHex: string;
  readonly orderHashHex: string;
  readonly routeHashHex: string;
  readonly idempotencyKey: string;
}

export type AnySelectedStrategyPackageAttempt =
  | SelectedStrategyPackageAttempt
  | SelectedNativeStrategyPackageAttempt;

export interface StrategyPackageAdmissionSummary {
  readonly orderHashHex: string;
  readonly quoteHashHex: string;
  readonly routeHashHex: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly lifecycleAction: StrategyPackageOrder["lifecycleAction"];
  readonly settlementClass: StrategyPackageOrder["settlementClass"];
  readonly solverId: string;
  readonly domainIds: readonly string[];
  readonly validUntilUnit: StrategyPackageQuote["validUntilUnit"];
  readonly validUntilValue: bigint;
  readonly recordedAtMs: number;
}

function requireCondition(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) throw new StrategyPackageStoreError(code, message);
}

function sameAsset(left: { readonly assetId: string; readonly decimals: number; readonly assetManifestHash: Uint8Array }, right: { readonly assetId: string; readonly decimals: number; readonly assetManifestHash: Uint8Array }): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function sameDomain(left: { readonly domainId: string; readonly domainManifestVersion: number; readonly domainManifestHash: Uint8Array }, right: { readonly domainId: string; readonly domainManifestVersion: number; readonly domainManifestHash: Uint8Array }): boolean {
  return left.domainId === right.domainId && left.domainManifestVersion === right.domainManifestVersion && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function hashBuffer(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new StrategyPackageStoreError("INVALID_HASH", "A strategy package hash must be 32 bytes of lowercase hex.");
  return Buffer.from(hex, "hex");
}

function evmHashBuffer(hex: string): Buffer {
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    throw new StrategyPackageStoreError("INVALID_HASH", "An EVM strategy hash must be lowercase bytes32.");
  }
  return Buffer.from(hex.slice(2), "hex");
}

function strategyAttemptId(
  orderHashHex: string,
  quoteHashHex: string,
  routeHashHex: string,
  sourceOrderHashHex: string,
): string {
  const digest = createHash("sha256")
    .update("NARYX/hyperliquid-strategy-execution-attempt/v1", "ascii")
    .update(Buffer.from(orderHashHex, "hex"))
    .update(Buffer.from(quoteHashHex, "hex"))
    .update(Buffer.from(routeHashHex, "hex"))
    .update(Buffer.from(sourceOrderHashHex, "hex"))
    .digest("hex");
  return `strategy-hl-${digest.slice(0, 48)}`;
}

function nativeStrategyAttemptId(
  orderHashHex: string,
  quoteHashHex: string,
  routeHashHex: string,
): string {
  const digest = createHash("sha256")
    .update("NARYX/hyperliquid-native-strategy-execution-attempt/v1", "ascii")
    .update(Buffer.from(orderHashHex, "hex"))
    .update(Buffer.from(quoteHashHex, "hex"))
    .update(Buffer.from(routeHashHex, "hex"))
    .digest("hex");
  return `strategy-hl-${digest.slice(0, 48)}`;
}

function attemptRow(row: {
  attempt_id: string;
  idempotency_key: string;
  order_hash: Uint8Array;
  graph_hash: Uint8Array;
  quote_hash: Uint8Array;
  route_hash: Uint8Array;
  source_order_hash: Uint8Array;
  status: string;
  selected_at_ms: number;
}): SelectedStrategyPackageAttempt {
  requireCondition(row.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED", "CORRUPT_ROW", "The strategy execution attempt status is invalid.");
  return Object.freeze({
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    orderHashHex: toHex(row.order_hash),
    graphHashHex: toHex(row.graph_hash),
    quoteHashHex: toHex(row.quote_hash),
    routeHashHex: toHex(row.route_hash),
    sourceOrderHashHex: toHex(row.source_order_hash),
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs: row.selected_at_ms,
  });
}

function nativeAttemptRow(row: {
  attempt_id: string;
  idempotency_key: string;
  order_hash: Uint8Array;
  graph_hash: Uint8Array;
  quote_hash: Uint8Array;
  route_hash: Uint8Array;
  status: string;
  selected_at_ms: number;
}): SelectedNativeStrategyPackageAttempt {
  requireCondition(row.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED", "CORRUPT_ROW", "The native strategy execution attempt status is invalid.");
  return Object.freeze({
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    orderHashHex: toHex(row.order_hash),
    graphHashHex: toHex(row.graph_hash),
    quoteHashHex: toHex(row.quote_hash),
    routeHashHex: toHex(row.route_hash),
    status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
    selectedAtMs: row.selected_at_ms,
  });
}

type NativePositionRow = {
  strategy_id: string;
  owner_id: string;
  template_id: string;
  economic_quantity_atoms: string;
  entry_order_hash: Uint8Array;
  entry_receipt_hash: Uint8Array;
  state_hash: Uint8Array;
  state_json: string;
  status: string;
  exit_order_hash: Uint8Array | null;
  exit_receipt_hash: Uint8Array | null;
  recorded_at_ms: number;
  updated_at_ms: number;
};

type EvmPositionRow = {
  package_id: Uint8Array;
  owner_id: string;
  chain_id: number;
  domain_id: string;
  settlement_account: string;
  template_id: string;
  series_id: string;
  execution_class_id: string;
  base_asset_id: string;
  base_asset_decimals: number;
  economic_quantity_atoms: string;
  entry_order_hash: Uint8Array;
  latest_order_hash: Uint8Array;
  latest_receipt_hash: Uint8Array;
  state_hash: Uint8Array;
  status: string;
  recorded_at_ms: number;
  updated_at_ms: number;
};

function nativePositionRow(row: NativePositionRow): StoredNativeStrategyPosition {
  requireCondition(row.status === "OPEN" || row.status === "EXITING"
    || row.status === "CLOSED" || row.status === "UNRESOLVED",
  "CORRUPT_ROW", "The native strategy position status is invalid.");
  const state = strategyState(parseProtocolJson(row.state_json) as StrategyState);
  requireCondition(/^[1-9][0-9]*$/.test(row.economic_quantity_atoms),
    "CORRUPT_ROW", "The native strategy economic quantity is invalid.");
  const stateHashHex = toHex(strategyStateHash(state));
  requireCondition(state.strategyId === row.strategy_id
    && state.ownerId === row.owner_id
    && stateHashHex === toHex(row.state_hash),
  "CORRUPT_ROW", "The stored native strategy state does not match its identity or hash.");
  return Object.freeze({
    strategyId: row.strategy_id,
    owner: row.owner_id,
    templateId: row.template_id,
    economicQuantityAtoms: BigInt(row.economic_quantity_atoms),
    entryOrderHashHex: toHex(row.entry_order_hash),
    entryReceiptHashHex: toHex(row.entry_receipt_hash),
    stateHashHex,
    state,
    status: row.status as NativeStrategyPositionStatus,
    ...(row.exit_order_hash === null ? {} : { exitOrderHashHex: toHex(row.exit_order_hash) }),
    ...(row.exit_receipt_hash === null ? {} : { exitReceiptHashHex: toHex(row.exit_receipt_hash) }),
    recordedAtMs: row.recorded_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

function evmPositionRow(row: EvmPositionRow): StoredEvmStrategyPosition {
  requireCondition(row.status === "OPEN" || row.status === "CLOSED",
    "CORRUPT_ROW", "The EVM strategy position status is invalid.");
  const packageIdHex = toHex(row.package_id);
  const entryOrderHashHex = toHex(row.entry_order_hash);
  const latestOrderHashHex = toHex(row.latest_order_hash);
  const latestReceiptHashHex = toHex(row.latest_receipt_hash);
  const stateHashHex = toHex(row.state_hash);
  const quantityValid = /^(?:0|[1-9][0-9]*)$/.test(row.economic_quantity_atoms);
  const economicQuantityAtoms = quantityValid ? BigInt(row.economic_quantity_atoms) : -1n;
  requireCondition(Number.isSafeInteger(row.chain_id) && row.chain_id > 0
    && Number.isSafeInteger(row.base_asset_decimals) && row.base_asset_decimals >= 0 && row.base_asset_decimals <= 255
    && quantityValid
    && /^0x(?!0{40}$)[0-9a-f]{40}$/.test(row.owner_id)
    && /^0x(?!0{40}$)[0-9a-f]{40}$/.test(row.settlement_account)
    && /^[0-9a-f]{64}$/.test(packageIdHex)
    && /^[0-9a-f]{64}$/.test(entryOrderHashHex)
    && /^[0-9a-f]{64}$/.test(latestOrderHashHex)
    && /^[0-9a-f]{64}$/.test(latestReceiptHashHex)
    && /^[0-9a-f]{64}$/.test(stateHashHex)
    && (row.status === "OPEN"
      ? economicQuantityAtoms > 0n && !/^0{64}$/.test(stateHashHex)
      : economicQuantityAtoms === 0n && /^0{64}$/.test(stateHashHex)),
  "CORRUPT_ROW", "The stored EVM strategy position is malformed.");
  return Object.freeze({
    packageIdHex,
    owner: row.owner_id,
    chainId: row.chain_id,
    domainId: row.domain_id,
    settlementAccount: row.settlement_account,
    templateId: row.template_id,
    seriesId: row.series_id,
    executionClassId: row.execution_class_id,
    baseAssetId: row.base_asset_id,
    baseAssetDecimals: row.base_asset_decimals,
    economicQuantityAtoms,
    entryOrderHashHex,
    latestOrderHashHex,
    latestReceiptHashHex,
    stateHashHex,
    status: row.status,
    recordedAtMs: row.recorded_at_ms,
    updatedAtMs: row.updated_at_ms,
  });
}

export class SqliteStrategyPackageStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(dbPath: string, options: { readonly clock?: () => number } = {}) {
    this.db = openDurableDatabase(dbPath, SCHEMA_SQL, (code, message) => new StrategyPackageStoreError(code, message));
    this.clock = options.clock ?? Date.now;
  }

  close(): void {
    this.db.close();
  }

  registerOrder(orderInput: StrategyPackageOrderInput, graphInput: PackageGraphInput): { readonly created: boolean; readonly orderHashHex: string; readonly graphHashHex: string } {
    const order = strategyPackageOrder(orderInput);
    const graph = packageGraph(graphInput);
    const orderHash = strategyPackageOrderHash(order);
    const graphHash = packageGraphHash(graph);
    requireCondition(bytesEqual(order.graphHash, graphHash), "BINDING_MISMATCH", "The order does not bind the supplied graph.");
    requireCondition(order.environment === graph.environment && order.owner === graph.owner, "BINDING_MISMATCH", "The order and graph environment or owner differ.");
    requireCondition(order.templateId === graph.templateId && order.templateVersion === graph.templateVersion, "BINDING_MISMATCH", "The order and graph template differ.");
    requireCondition(order.seriesId === graph.seriesId && order.seriesVersion === graph.seriesVersion && bytesEqual(order.seriesManifestHash, graph.seriesManifestHash), "BINDING_MISMATCH", "The order and graph series identity differ.");
    requireCondition(order.executionClassId === graph.executionClassId && order.executionClassVersion === graph.executionClassVersion && bytesEqual(order.executionClassManifestHash, graph.executionClassManifestHash), "BINDING_MISMATCH", "The order and graph execution class differ.");
    requireCondition(order.lifecycleAction === graph.lifecycleAction && order.settlementClass === graph.settlementClass, "BINDING_MISMATCH", "The order and graph execution semantics differ.");
    const orderHashHex = toHex(orderHash);
    const graphHashHex = toHex(graphHash);
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT graph_hash, order_json, graph_json FROM strategy_package_orders WHERE order_hash = ?").get(orderHash) as { graph_hash: Uint8Array; order_json: string; graph_json: string } | undefined;
      if (known !== undefined) {
        requireCondition(toHex(known.graph_hash) === graphHashHex && known.order_json === stringifyProtocolJson(order) && known.graph_json === stringifyProtocolJson(graph), "HASH_CONFLICT", "The order hash is already stored with different bytes.");
        return Object.freeze({ created: false, orderHashHex, graphHashHex });
      }
      this.db.prepare("INSERT INTO strategy_package_orders (order_hash, graph_hash, owner_id, order_json, graph_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(orderHash, graphHash, order.owner, stringifyProtocolJson(order), stringifyProtocolJson(graph), this.clock());
      return Object.freeze({ created: true, orderHashHex, graphHashHex });
    }).immediate();
  }

  registerQuote(admission: AdmittedStrategyRoute): { readonly created: boolean; readonly quoteHashHex: string; readonly routeHashHex: string } {
    const orderHash = strategyPackageOrderHash(admission.order);
    const quoteHash = strategyPackageQuoteHash(admission.quote);
    const routeHash = typedStrategyRouteHash(admission.route);
    requireCondition(this.db.prepare("SELECT 1 FROM strategy_package_orders WHERE order_hash = ?").get(orderHash) !== undefined, "ORDER_NOT_FOUND", "The admitted order is not stored.");
    const quoteHashHex = toHex(quoteHash);
    const routeHashHex = toHex(routeHash);
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT route_hash, quote_json, route_json FROM strategy_package_quotes WHERE quote_hash = ?").get(quoteHash) as { route_hash: Uint8Array; quote_json: string; route_json: string } | undefined;
      if (known !== undefined) {
        requireCondition(toHex(known.route_hash) === routeHashHex && known.quote_json === stringifyProtocolJson(admission.quote) && known.route_json === stringifyProtocolJson(admission.route), "HASH_CONFLICT", "The quote hash is already stored with different bytes.");
        return Object.freeze({ created: false, quoteHashHex, routeHashHex });
      }
      this.db.prepare("INSERT INTO strategy_package_quotes (quote_hash, order_hash, route_hash, solver_id, quote_json, route_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(quoteHash, orderHash, routeHash, admission.quote.solverId, stringifyProtocolJson(admission.quote), stringifyProtocolJson(admission.route), this.clock());
      return Object.freeze({ created: true, quoteHashHex, routeHashHex });
    }).immediate();
  }

  bindSourceOrder(orderHashHex: string, sourceOrderHashHex: string): { readonly created: boolean; readonly binding: StrategyPackageSourceBinding } {
    const orderHash = hashBuffer(orderHashHex);
    const sourceOrderHash = hashBuffer(sourceOrderHashHex);
    requireCondition(this.db.prepare("SELECT 1 FROM strategy_package_orders WHERE order_hash = ?").get(orderHash) !== undefined, "ORDER_NOT_FOUND", "The strategy package order is not stored.");
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT source_order_hash, recorded_at_ms FROM strategy_package_sources WHERE order_hash = ?").get(orderHash) as { source_order_hash: Uint8Array; recorded_at_ms: number } | undefined;
      if (known !== undefined) {
        requireCondition(toHex(known.source_order_hash) === sourceOrderHashHex, "SOURCE_CONFLICT", "The strategy package order is already bound to another source order.");
        return Object.freeze({
          created: false,
          binding: Object.freeze({ orderHashHex, sourceOrderHashHex, recordedAtMs: known.recorded_at_ms }),
        });
      }
      const recordedAtMs = this.clock();
      try {
        this.db.prepare("INSERT INTO strategy_package_sources (order_hash, source_order_hash, recorded_at_ms) VALUES (?, ?, ?)")
          .run(orderHash, sourceOrderHash, recordedAtMs);
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed: strategy_package_sources.source_order_hash")) {
          throw new StrategyPackageStoreError("SOURCE_CONFLICT", "The source order is already bound to another strategy package order.");
        }
        throw error;
      }
      return Object.freeze({
        created: true,
        binding: Object.freeze({ orderHashHex, sourceOrderHashHex, recordedAtMs }),
      });
    }).immediate();
  }

  sourceBinding(orderHashHex: string): StrategyPackageSourceBinding | undefined {
    const row = this.db.prepare("SELECT source_order_hash, recorded_at_ms FROM strategy_package_sources WHERE order_hash = ?")
      .get(hashBuffer(orderHashHex)) as { source_order_hash: Uint8Array; recorded_at_ms: number } | undefined;
    if (row === undefined) return undefined;
    return Object.freeze({
      orderHashHex,
      sourceOrderHashHex: toHex(row.source_order_hash),
      recordedAtMs: row.recorded_at_ms,
    });
  }

  recordOwnerAuthorization(
    orderHashHex: string,
    owner: string,
    signature: string,
  ): { readonly created: boolean; readonly authorization: StoredStrategyPackageAuthorization } {
    const orderHash = hashBuffer(orderHashHex);
    requireCondition(/^0x(?!0{40}$)[0-9a-f]{40}$/.test(owner), "INVALID_OWNER", "The strategy package owner must be a lowercase nonzero EVM address.");
    requireCondition(/^0x[0-9a-f]{130}$/.test(signature), "INVALID_SIGNATURE", "The strategy package authorization signature is invalid.");
    const orderRow = this.db.prepare("SELECT owner_id FROM strategy_package_orders WHERE order_hash = ?")
      .get(orderHash) as { owner_id: string } | undefined;
    requireCondition(orderRow !== undefined, "ORDER_NOT_FOUND", "The strategy package order is not stored.");
    requireCondition(orderRow.owner_id === owner, "OWNER_MISMATCH", "The authorization owner differs from the strategy package owner.");
    return this.db.transaction(() => {
      const known = this.db.prepare("SELECT owner_id, scheme, signature, authorized_at_ms FROM strategy_package_authorizations WHERE order_hash = ?")
        .get(orderHash) as { owner_id: string; scheme: string; signature: string; authorized_at_ms: number } | undefined;
      if (known !== undefined) {
        requireCondition(known.owner_id === owner && known.scheme === "EIP712_SECP256K1" && known.signature === signature,
          "AUTHORIZATION_CONFLICT", "The strategy package order already has another authorization record.");
        return Object.freeze({ created: false, authorization: this.ownerAuthorization(orderHashHex)! });
      }
      const authorizedAtMs = this.clock();
      requireCondition(Number.isSafeInteger(authorizedAtMs) && authorizedAtMs >= 0, "INVALID_CLOCK", "The authorization clock is invalid.");
      this.db.prepare("INSERT INTO strategy_package_authorizations (order_hash, owner_id, scheme, signature, authorized_at_ms) VALUES (?, ?, 'EIP712_SECP256K1', ?, ?)")
        .run(orderHash, owner, signature, authorizedAtMs);
      return Object.freeze({
        created: true,
        authorization: Object.freeze({
          orderHashHex,
          owner,
          scheme: "EIP712_SECP256K1" as const,
          signature,
          authorizedAtMs,
        }),
      });
    }).immediate();
  }

  ownerAuthorization(orderHashHex: string): StoredStrategyPackageAuthorization | undefined {
    const orderHash = hashBuffer(orderHashHex);
    const row = this.db.prepare(`
      SELECT a.owner_id, a.scheme, a.signature, a.authorized_at_ms, o.owner_id AS order_owner
      FROM strategy_package_authorizations a
      JOIN strategy_package_orders o ON o.order_hash = a.order_hash
      WHERE a.order_hash = ?
    `).get(orderHash) as {
      owner_id: string;
      scheme: string;
      signature: string;
      authorized_at_ms: number;
      order_owner: string;
    } | undefined;
    if (row === undefined) return undefined;
    requireCondition(row.owner_id === row.order_owner && row.scheme === "EIP712_SECP256K1"
      && /^0x[0-9a-f]{130}$/.test(row.signature), "CORRUPT_ROW", "The stored strategy package authorization is invalid.");
    return Object.freeze({
      orderHashHex,
      owner: row.owner_id,
      scheme: "EIP712_SECP256K1",
      signature: row.signature,
      authorizedAtMs: row.authorized_at_ms,
    });
  }

  nativeStrategyPosition(strategyId: string): StoredNativeStrategyPosition | undefined {
    const row = this.db.prepare("SELECT * FROM strategy_native_positions WHERE strategy_id = ?")
      .get(strategyId) as NativePositionRow | undefined;
    return row === undefined ? undefined : nativePositionRow(row);
  }

  nativeStrategyPositionByStateHash(stateHashHex: string): StoredNativeStrategyPosition | undefined {
    const row = this.db.prepare("SELECT * FROM strategy_native_positions WHERE state_hash = ?")
      .get(hashBuffer(stateHashHex)) as NativePositionRow | undefined;
    return row === undefined ? undefined : nativePositionRow(row);
  }

  nativeStrategyPositionsByOwner(owner: string): readonly StoredNativeStrategyPosition[] {
    requireCondition(/^0x(?!0{40}$)[0-9a-f]{40}$/.test(owner), "INVALID_OWNER",
      "The native strategy owner must be a lowercase nonzero EVM address.");
    const rows = this.db.prepare(`
      SELECT * FROM strategy_native_positions
      WHERE owner_id = ?
      ORDER BY updated_at_ms DESC, strategy_id
    `).all(owner) as NativePositionRow[];
    return Object.freeze(rows.map(nativePositionRow));
  }

  evmStrategyPositionsByOwner(owner: string): readonly StoredEvmStrategyPosition[] {
    requireCondition(/^0x(?!0{40}$)[0-9a-f]{40}$/.test(owner), "INVALID_OWNER",
      "The EVM strategy owner must be a lowercase nonzero address.");
    const rows = this.db.prepare(`
      SELECT * FROM strategy_evm_positions
      WHERE owner_id = ?
      ORDER BY updated_at_ms DESC, package_id
    `).all(owner) as EvmPositionRow[];
    return Object.freeze(rows.map(evmPositionRow));
  }

  recordEvmStrategyPosition(evidence: EvmStrategyPositionEvidence): StoredEvmStrategyPosition {
    requireCondition(Number.isSafeInteger(evidence.chainId) && evidence.chainId > 0,
      "INVALID_CHAIN", "The EVM strategy chain is invalid.");
    requireCondition(/^0x(?!0{40}$)[0-9a-f]{40}$/.test(evidence.account),
      "INVALID_ACCOUNT", "The EVM strategy account must be a lowercase nonzero address.");
    const receiptHash = hashBuffer(evidence.receiptHashHex);
    const packageId = evmHashBuffer(evidence.packageIdHex);
    const previousStateHash = evmHashBuffer(evidence.previousStateHashHex);
    const nextStateHash = evmHashBuffer(evidence.nextStateHashHex);
    const zeroHash = /^0x0{64}$/.test(evidence.nextStateHashHex);
    const previousZero = /^0x0{64}$/.test(evidence.previousStateHashHex);
    const receiptRow = this.db.prepare(`
      SELECT r.order_hash, r.receipt_json, o.order_json, o.graph_json
      FROM strategy_package_receipts r
      JOIN strategy_package_orders o ON o.order_hash = r.order_hash
      WHERE r.receipt_hash = ?
    `).get(receiptHash) as {
      order_hash: Uint8Array;
      receipt_json: string;
      order_json: string;
      graph_json: string;
    } | undefined;
    requireCondition(receiptRow !== undefined, "RECEIPT_NOT_FOUND",
      "The EVM strategy receipt must be stored before its position state.");
    const receipt = strategyPackageReceipt(parseProtocolJson(receiptRow.receipt_json) as StrategyPackageReceiptInput);
    const order = strategyPackageOrder(parseProtocolJson(receiptRow.order_json) as StrategyPackageOrderInput);
    const graph = packageGraph(parseProtocolJson(receiptRow.graph_json) as PackageGraphInput);
    requireCondition(receipt.finalityStatus === "FINALIZED" && receipt.terminalState === "FINALIZED_COMPLETE",
      "POSITION_NOT_FINAL", "Only a finalized complete EVM execution can update strategy state.");
    requireCondition(order.settlementClass === "ATOMIC_POSTCONDITION" && graph.settlementClass === "ATOMIC_POSTCONDITION"
      && graph.legs.length > 0 && new Set(graph.legs.map((leg) => leg.domain.domainId)).size === 1,
    "UNSUPPORTED_EXECUTION", "The receipt is not one atomic EVM strategy execution.");
    const domainId = graph.legs[0]!.domain.domainId;
    requireCondition(domainId === `eip155:${evidence.chainId}` && order.settlementAccount === evidence.account,
      "BINDING_MISMATCH", "The EVM position evidence differs from the order domain or account.");
    const orderHashHex = toHex(receiptRow.order_hash);
    const changedAtMs = this.clock();
    requireCondition(Number.isSafeInteger(changedAtMs) && changedAtMs >= 0,
      "INVALID_CLOCK", "The EVM strategy position clock is invalid.");

    return this.db.transaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM strategy_evm_positions WHERE package_id = ?")
        .get(packageId) as EvmPositionRow | undefined;
      if (existingRow !== undefined && toHex(existingRow.latest_order_hash) === orderHashHex) {
        requireCondition(toHex(existingRow.latest_receipt_hash) === evidence.receiptHashHex,
          "POSITION_CONFLICT", "The EVM strategy transition is already bound to another receipt.");
        return evmPositionRow(existingRow);
      }

      if (order.lifecycleAction === "ENTRY") {
        requireCondition(existingRow === undefined && previousZero && !zeroHash
          && evidence.packageIdHex.slice(2) === orderHashHex,
        "POSITION_CONFLICT", "The EVM strategy entry identity or state transition is invalid.");
        this.db.prepare(`
          INSERT INTO strategy_evm_positions
            (package_id, owner_id, chain_id, domain_id, settlement_account,
             template_id, series_id, execution_class_id, base_asset_id, base_asset_decimals,
             economic_quantity_atoms, entry_order_hash, latest_order_hash, latest_receipt_hash,
             state_hash, status, recorded_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
        `).run(
          packageId,
          order.owner,
          evidence.chainId,
          domainId,
          evidence.account,
          order.templateId,
          order.seriesId,
          order.executionClassId,
          order.economicQuantity.asset.assetId,
          order.economicQuantity.asset.decimals,
          order.economicQuantity.atoms.toString(),
          receiptRow.order_hash,
          receiptRow.order_hash,
          receiptHash,
          nextStateHash,
          changedAtMs,
          changedAtMs,
        );
      } else {
        requireCondition(existingRow !== undefined && existingRow.status === "OPEN"
          && bytesEqual(existingRow.state_hash, previousStateHash)
          && existingRow.owner_id === order.owner
          && existingRow.chain_id === evidence.chainId
          && existingRow.domain_id === domainId
          && existingRow.settlement_account === evidence.account
          && existingRow.template_id === order.templateId
          && existingRow.series_id === order.seriesId
          && existingRow.execution_class_id === order.executionClassId
          && existingRow.base_asset_id === order.economicQuantity.asset.assetId
          && existingRow.base_asset_decimals === order.economicQuantity.asset.decimals,
        "STALE_STRATEGY_STATE", "The EVM strategy state or identity changed before finalization.");
        const currentQuantity = BigInt(existingRow.economic_quantity_atoms);
        const terminal = order.lifecycleAction === "EXIT" || order.lifecycleAction === "EMERGENCY_UNWIND";
        requireCondition(terminal || order.lifecycleAction === "INCREASE" || order.lifecycleAction === "DECREASE",
          "UNSUPPORTED_EXECUTION", "The EVM strategy lifecycle action is unsupported.");
        const nextQuantity = terminal ? 0n
          : order.lifecycleAction === "INCREASE"
            ? currentQuantity + order.economicQuantity.atoms
            : currentQuantity - order.economicQuantity.atoms;
        requireCondition((terminal && zeroHash) || (!terminal && !zeroHash && nextQuantity > 0n),
          "POSITION_CONFLICT", "The EVM strategy next state is invalid for the lifecycle action.");
        const updated = this.db.prepare(`
          UPDATE strategy_evm_positions
          SET economic_quantity_atoms = ?, latest_order_hash = ?, latest_receipt_hash = ?,
              state_hash = ?, status = ?, updated_at_ms = ?
          WHERE package_id = ? AND status = 'OPEN' AND state_hash = ?
        `).run(
          nextQuantity.toString(),
          receiptRow.order_hash,
          receiptHash,
          nextStateHash,
          terminal ? "CLOSED" : "OPEN",
          changedAtMs,
          packageId,
          previousStateHash,
        );
        requireCondition(updated.changes === 1, "STALE_STRATEGY_STATE",
          "The EVM strategy state changed before finalization.");
      }
      const stored = this.db.prepare("SELECT * FROM strategy_evm_positions WHERE package_id = ?")
        .get(packageId) as EvmPositionRow | undefined;
      requireCondition(stored !== undefined, "POSITION_NOT_FOUND", "The finalized EVM strategy position was not stored.");
      return evmPositionRow(stored);
    }).immediate();
  }

  selectHyperliquidExecution(request: SelectHyperliquidStrategyExecutionRequest): SelectedStrategyPackageAttempt {
    const { quoteHashHex, orderHashHex, routeHashHex, sourceOrderHashHex, idempotencyKey } = request;
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey), "INVALID_IDEMPOTENCY_KEY", "The execution idempotency key is invalid.");
    hashBuffer(orderHashHex);
    hashBuffer(routeHashHex);
    hashBuffer(sourceOrderHashHex);
    const admission = this.admissionByQuote(quoteHashHex);
    requireCondition(admission !== undefined, "QUOTE_NOT_FOUND", "The strategy package quote is not stored.");
    requireCondition(this.ownerAuthorization(admission.orderHashHex) !== undefined,
      "OWNER_AUTHORIZATION_REQUIRED", "The strategy package owner must authorize the exact generalized order before selection.");
    requireCondition(admission.order.environment === "testnet"
      && admission.order.lifecycleAction === "ENTRY"
      && admission.order.settlementClass === "BATCHED_IOC_WITH_RECOVERY"
      && admission.route.domainPlans.length === 1
      && admission.route.domainPlans[0]?.domain.domainId === "hypercore:testnet"
      && admission.route.domainPlans[0]?.executionPlanKind === "HYPERCORE_BATCHED_IOC",
    "UNSUPPORTED_EXECUTION", "The selected strategy quote is not an executable Hyperliquid Testnet entry.");
    const source = this.sourceBinding(admission.orderHashHex);
    requireCondition(source !== undefined, "SOURCE_NOT_FOUND", "The strategy package order has no canonical source binding.");
    requireCondition(admission.orderHashHex === orderHashHex
      && admission.routeHashHex === routeHashHex
      && source.sourceOrderHashHex === sourceOrderHashHex,
    "SELECTION_MISMATCH", "The selected quote does not match the reviewed order, route, and source commitments.");
    const selectedAtMs = this.clock();
    requireCondition(Number.isSafeInteger(selectedAtMs) && selectedAtMs >= 0, "INVALID_CLOCK", "The execution selection clock is invalid.");
    const currentTime = BigInt(selectedAtMs);
    requireCondition(currentTime < admission.order.expiryValue
      && currentTime < admission.quote.validUntilValue
      && currentTime < admission.route.routeExpiryValue,
    "QUOTE_EXPIRED", "The selected strategy quote or route has expired.");
    const attemptId = strategyAttemptId(
      admission.orderHashHex,
      quoteHashHex,
      admission.routeHashHex,
      source.sourceOrderHashHex,
    );
    return this.db.transaction(() => {
      const nativeByKey = this.db.prepare("SELECT * FROM strategy_native_execution_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Parameters<typeof nativeAttemptRow>[0] | undefined;
      requireCondition(nativeByKey === undefined, "IDEMPOTENCY_CONFLICT", "The execution idempotency key is already bound to a native strategy attempt.");
      const nativeByQuote = this.db.prepare("SELECT * FROM strategy_native_execution_attempts WHERE quote_hash = ?").get(hashBuffer(quoteHashHex)) as Parameters<typeof nativeAttemptRow>[0] | undefined;
      requireCondition(nativeByQuote === undefined, "QUOTE_ALREADY_SELECTED", "The strategy quote was already selected as a native strategy attempt.");
      const byKey = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Parameters<typeof attemptRow>[0] | undefined;
      if (byKey !== undefined) {
        const known = attemptRow(byKey);
        requireCondition(known.attemptId === attemptId && known.quoteHashHex === quoteHashHex, "IDEMPOTENCY_CONFLICT", "The execution idempotency key is already bound to another quote.");
        return known;
      }
      const byQuote = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE quote_hash = ?").get(hashBuffer(quoteHashHex)) as Parameters<typeof attemptRow>[0] | undefined;
      requireCondition(byQuote === undefined, "QUOTE_ALREADY_SELECTED", "The strategy quote was already selected with another idempotency key.");
      this.db.prepare(`
        INSERT INTO strategy_execution_attempts
          (attempt_id, idempotency_key, order_hash, graph_hash, quote_hash, route_hash,
           source_order_hash, status, selected_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'HYPERLIQUID_TESTNET_QUOTE_SELECTED', ?)
      `).run(
        attemptId,
        idempotencyKey,
        hashBuffer(admission.orderHashHex),
        hashBuffer(admission.graphHashHex),
        hashBuffer(quoteHashHex),
        hashBuffer(admission.routeHashHex),
        hashBuffer(source.sourceOrderHashHex),
        selectedAtMs,
      );
      return Object.freeze({
        attemptId,
        idempotencyKey,
        orderHashHex: admission.orderHashHex,
        graphHashHex: admission.graphHashHex,
        quoteHashHex,
        routeHashHex: admission.routeHashHex,
        sourceOrderHashHex: source.sourceOrderHashHex,
        status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED" as const,
        selectedAtMs,
      });
    }).immediate();
  }

  selectNativeHyperliquidExecution(
    request: SelectNativeHyperliquidStrategyExecutionRequest,
  ): SelectedNativeStrategyPackageAttempt {
    const { quoteHashHex, orderHashHex, routeHashHex, idempotencyKey } = request;
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey), "INVALID_IDEMPOTENCY_KEY", "The execution idempotency key is invalid.");
    hashBuffer(orderHashHex);
    hashBuffer(routeHashHex);
    const admission = this.admissionByQuote(quoteHashHex);
    requireCondition(admission !== undefined, "QUOTE_NOT_FOUND", "The strategy package quote is not stored.");
    requireCondition(this.ownerAuthorization(admission.orderHashHex) !== undefined,
      "OWNER_AUTHORIZATION_REQUIRED", "The strategy package owner must authorize the exact generalized order before selection.");
    requireCondition(admission.order.environment === "testnet"
      && (admission.order.lifecycleAction === "ENTRY" || admission.order.lifecycleAction === "INCREASE"
        || admission.order.lifecycleAction === "DECREASE" || admission.order.lifecycleAction === "EXIT"
        || admission.order.lifecycleAction === "EMERGENCY_UNWIND")
      && admission.order.settlementClass === "BATCHED_IOC_WITH_RECOVERY"
      && admission.order.expiryUnit === "HYPERLIQUID_UNIX_MILLISECONDS"
      && admission.quote.validUntilUnit === "HYPERLIQUID_UNIX_MILLISECONDS"
      && admission.route.routeExpiryUnit === "HYPERLIQUID_UNIX_MILLISECONDS"
      && admission.route.domainPlans.length === 1
      && admission.route.domainPlans[0]?.domain.domainId === "hypercore:testnet"
      && admission.route.domainPlans[0]?.executionPlanKind === "HYPERCORE_BATCHED_IOC",
    "UNSUPPORTED_EXECUTION", "The selected strategy quote is not an executable native Hyperliquid Testnet package.");
    requireCondition(admission.orderHashHex === orderHashHex
      && admission.routeHashHex === routeHashHex,
    "SELECTION_MISMATCH", "The selected quote does not match the reviewed order and route commitments.");
    const selectedAtMs = this.clock();
    requireCondition(Number.isSafeInteger(selectedAtMs) && selectedAtMs >= 0, "INVALID_CLOCK", "The execution selection clock is invalid.");
    const currentTime = BigInt(selectedAtMs);
    requireCondition(currentTime < admission.order.expiryValue
      && currentTime < admission.quote.validUntilValue
      && currentTime < admission.route.routeExpiryValue,
    "QUOTE_EXPIRED", "The selected strategy quote or route has expired.");
    const attemptId = nativeStrategyAttemptId(
      admission.orderHashHex,
      quoteHashHex,
      admission.routeHashHex,
    );
    return this.db.transaction(() => {
      const legacyByKey = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Parameters<typeof attemptRow>[0] | undefined;
      requireCondition(legacyByKey === undefined, "IDEMPOTENCY_CONFLICT", "The execution idempotency key is already bound to a source-backed strategy attempt.");
      const legacyByQuote = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE quote_hash = ?").get(hashBuffer(quoteHashHex)) as Parameters<typeof attemptRow>[0] | undefined;
      requireCondition(legacyByQuote === undefined, "QUOTE_ALREADY_SELECTED", "The strategy quote was already selected as a source-backed strategy attempt.");
      const byKey = this.db.prepare("SELECT * FROM strategy_native_execution_attempts WHERE idempotency_key = ?").get(idempotencyKey) as Parameters<typeof nativeAttemptRow>[0] | undefined;
      if (byKey !== undefined) {
        const known = nativeAttemptRow(byKey);
        requireCondition(known.attemptId === attemptId && known.quoteHashHex === quoteHashHex, "IDEMPOTENCY_CONFLICT", "The execution idempotency key is already bound to another quote.");
        return known;
      }
      const byQuote = this.db.prepare("SELECT * FROM strategy_native_execution_attempts WHERE quote_hash = ?").get(hashBuffer(quoteHashHex)) as Parameters<typeof nativeAttemptRow>[0] | undefined;
      requireCondition(byQuote === undefined, "QUOTE_ALREADY_SELECTED", "The strategy quote was already selected with another idempotency key.");
      let transitionPosition: StoredNativeStrategyPosition | undefined;
      if (admission.order.lifecycleAction !== "ENTRY") {
        requireCondition(admission.order.expectedStrategyStateHash !== undefined,
          "STALE_STRATEGY_STATE", "A native strategy transition must bind an open strategy state.");
        transitionPosition = this.nativeStrategyPositionByStateHash(toHex(admission.order.expectedStrategyStateHash));
        requireCondition(transitionPosition !== undefined, "STALE_STRATEGY_STATE",
          "The native strategy state is unknown or no longer current.");
        try {
          if (admission.order.lifecycleAction === "EXIT" || admission.order.lifecycleAction === "EMERGENCY_UNWIND") {
            validateNativeStrategyExit(transitionPosition, admission.order, admission.graph);
          } else {
            validateNativeStrategyTransition(transitionPosition, admission.order, admission.graph);
          }
        } catch (error) {
          if (error instanceof NativeStrategyPositionError) {
            throw new StrategyPackageStoreError(error.code, error.message);
          }
          throw error;
        }
      }
      this.db.prepare(`
        INSERT INTO strategy_native_execution_attempts
          (attempt_id, idempotency_key, order_hash, graph_hash, quote_hash, route_hash,
           status, selected_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'HYPERLIQUID_TESTNET_QUOTE_SELECTED', ?)
      `).run(
        attemptId,
        idempotencyKey,
        hashBuffer(admission.orderHashHex),
        hashBuffer(admission.graphHashHex),
        hashBuffer(quoteHashHex),
        hashBuffer(admission.routeHashHex),
        selectedAtMs,
      );
      if (transitionPosition !== undefined) {
        const pending = this.db.prepare(`
          SELECT 1 FROM strategy_native_transitions
          WHERE strategy_id = ? AND receipt_hash IS NULL
        `).get(transitionPosition.strategyId);
        requireCondition(pending === undefined, "STRATEGY_TRANSITION_PENDING",
          "The native strategy already has a selected lifecycle transition.");
      }
      if (transitionPosition !== undefined
        && (admission.order.lifecycleAction === "EXIT" || admission.order.lifecycleAction === "EMERGENCY_UNWIND")) {
        const updated = this.db.prepare(`
          UPDATE strategy_native_positions
          SET status = 'EXITING', exit_order_hash = ?, exit_receipt_hash = NULL, updated_at_ms = ?
          WHERE strategy_id = ? AND status = ? AND state_hash = ?
        `).run(
          hashBuffer(admission.orderHashHex),
          selectedAtMs,
          transitionPosition.strategyId,
          transitionPosition.status,
          hashBuffer(transitionPosition.stateHashHex),
        );
        requireCondition(updated.changes === 1, "STALE_STRATEGY_STATE",
          "The native strategy state changed before exit selection.");
      } else if (transitionPosition !== undefined) {
        this.db.prepare(`
          INSERT INTO strategy_native_transitions
            (order_hash, strategy_id, action, expected_state_hash, receipt_hash,
             selected_at_ms, finalized_at_ms)
          VALUES (?, ?, ?, ?, NULL, ?, NULL)
        `).run(
          hashBuffer(admission.orderHashHex),
          transitionPosition.strategyId,
          admission.order.lifecycleAction,
          hashBuffer(transitionPosition.stateHashHex),
          selectedAtMs,
        );
      }
      return Object.freeze({
        attemptId,
        idempotencyKey,
        orderHashHex: admission.orderHashHex,
        graphHashHex: admission.graphHashHex,
        quoteHashHex,
        routeHashHex: admission.routeHashHex,
        status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED" as const,
        selectedAtMs,
      });
    }).immediate();
  }

  strategyExecutionAttempt(attemptId: string): SelectedStrategyPackageAttempt | undefined {
    if (!/^strategy-hl-[0-9a-f]{48}$/.test(attemptId)) return undefined;
    const row = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE attempt_id = ?")
      .get(attemptId) as Parameters<typeof attemptRow>[0] | undefined;
    return row === undefined ? undefined : attemptRow(row);
  }

  nativeStrategyExecutionAttempt(attemptId: string): SelectedNativeStrategyPackageAttempt | undefined {
    if (!/^strategy-hl-[0-9a-f]{48}$/.test(attemptId)) return undefined;
    const row = this.db.prepare("SELECT * FROM strategy_native_execution_attempts WHERE attempt_id = ?")
      .get(attemptId) as Parameters<typeof nativeAttemptRow>[0] | undefined;
    return row === undefined ? undefined : nativeAttemptRow(row);
  }

  anyStrategyExecutionAttempt(attemptId: string): AnySelectedStrategyPackageAttempt | undefined {
    const native = this.nativeStrategyExecutionAttempt(attemptId);
    if (native !== undefined) return native;
    return this.strategyExecutionAttempt(attemptId);
  }

  recordReceipt(input: StrategyPackageReceiptInput): { readonly created: boolean; readonly receiptHashHex: string } {
    const receipt = strategyPackageReceipt(input);
    const receiptHash = strategyPackageReceiptHash(receipt);
    const quoteRow = this.db.prepare("SELECT order_hash, route_hash, quote_json, route_json FROM strategy_package_quotes WHERE quote_hash = ?").get(receipt.quoteHash) as { order_hash: Uint8Array; route_hash: Uint8Array; quote_json: string; route_json: string } | undefined;
    requireCondition(quoteRow !== undefined, "QUOTE_NOT_FOUND", "The receipt's quote is not stored.");
    requireCondition(bytesEqual(quoteRow.order_hash, receipt.orderHash) && bytesEqual(quoteRow.route_hash, receipt.routeHash), "BINDING_MISMATCH", "The receipt does not bind the stored order, quote, and route.");
    const orderRow = this.db.prepare("SELECT graph_hash, order_json, graph_json FROM strategy_package_orders WHERE order_hash = ?").get(receipt.orderHash) as { graph_hash: Uint8Array; order_json: string; graph_json: string } | undefined;
    requireCondition(orderRow !== undefined && bytesEqual(orderRow.graph_hash, receipt.graphHash), "BINDING_MISMATCH", "The receipt does not bind the stored graph.");
    const order = strategyPackageOrder(parseProtocolJson(orderRow.order_json) as StrategyPackageOrderInput);
    const graph = packageGraph(parseProtocolJson(orderRow.graph_json) as PackageGraphInput);
    const quote = strategyPackageQuote(parseProtocolJson(quoteRow.quote_json) as StrategyPackageQuote);
    requireCondition(receipt.environment === order.environment && receipt.owner === order.owner && receipt.templateId === order.templateId && receipt.templateVersion === order.templateVersion && bytesEqual(receipt.packageTemplateManifestHash, order.packageTemplateManifestHash), "BINDING_MISMATCH", "The receipt order identity differs.");
    requireCondition(receipt.seriesId === order.seriesId && receipt.seriesVersion === order.seriesVersion && bytesEqual(receipt.seriesManifestHash, order.seriesManifestHash), "BINDING_MISMATCH", "The receipt series identity differs.");
    requireCondition(receipt.executionClassId === order.executionClassId && receipt.executionClassVersion === order.executionClassVersion && bytesEqual(receipt.executionClassManifestHash, order.executionClassManifestHash), "BINDING_MISMATCH", "The receipt execution class differs.");
    requireCondition(receipt.lifecycleAction === order.lifecycleAction.toLowerCase().replaceAll("_", "-") && receipt.settlementClass === order.settlementClass, "BINDING_MISMATCH", "The receipt lifecycle semantics differ.");
    requireCondition(receipt.solverId === quote.solverId, "BINDING_MISMATCH", "The receipt solver differs from the selected quote.");
    requireCondition(sameAsset(receipt.quoteAsset, order.quoteAsset), "BINDING_MISMATCH", "The receipt quote asset differs from the order.");
    const graphLegIds = graph.legs.map((leg) => leg.legId).sort();
    const receiptLegIds = receipt.legOutcomes.map((leg) => leg.legId).sort();
    requireCondition(graphLegIds.length === receiptLegIds.length && graphLegIds.every((legId, index) => legId === receiptLegIds[index]), "BINDING_MISMATCH", "The receipt must report every graph leg exactly once.");
    for (const leg of graph.legs) {
      const outcome = receipt.legOutcomes.find((candidate) => candidate.legId === leg.legId)!;
      requireCondition(sameDomain(outcome.domain, leg.domain), "BINDING_MISMATCH", `The receipt domain differs for ${leg.legId}.`);
      requireCondition(sameAsset(outcome.requestedQuantity.asset, leg.quantityAsset) && outcome.requestedQuantity.atoms === leg.quantityAtoms, "BINDING_MISMATCH", `The receipt requested quantity differs for ${leg.legId}.`);
      requireCondition(sameAsset(outcome.settledQuantity.asset, leg.quantityAsset) && absolute(outcome.settledQuantity.atoms) <= leg.quantityAtoms, "BINDING_MISMATCH", `The receipt settled quantity exceeds ${leg.legId}.`);
      if (outcome.status === "EXECUTED") {
        requireCondition(absolute(outcome.settledQuantity.atoms) >= leg.minimumQuantityAtoms, "BINDING_MISMATCH", `The receipt settled less than the minimum for ${leg.legId}.`);
      }
    }
    const receiptHashHex = toHex(receiptHash);
    const receiptJson = stringifyProtocolJson(receipt);
    return this.db.transaction(() => {
      const knownForQuote = this.db.prepare("SELECT receipt_hash, receipt_json FROM strategy_package_receipts WHERE quote_hash = ?").get(receipt.quoteHash) as { receipt_hash: Uint8Array; receipt_json: string } | undefined;
      if (knownForQuote !== undefined) {
        requireCondition(bytesEqual(knownForQuote.receipt_hash, receiptHash) && knownForQuote.receipt_json === receiptJson,
          "RECEIPT_CONFLICT", "The selected quote already has another terminal receipt.");
        return Object.freeze({ created: false, receiptHashHex });
      }
      const known = this.db.prepare("SELECT receipt_json FROM strategy_package_receipts WHERE receipt_hash = ?").get(receiptHash) as { receipt_json: string } | undefined;
      if (known !== undefined) {
        requireCondition(known.receipt_json === receiptJson, "HASH_CONFLICT", "The receipt hash is already stored with different bytes.");
        return Object.freeze({ created: false, receiptHashHex });
      }
      this.db.prepare("INSERT INTO strategy_package_receipts (receipt_hash, order_hash, quote_hash, route_hash, receipt_json, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(receiptHash, receipt.orderHash, receipt.quoteHash, receipt.routeHash, receiptJson, this.clock());
      const nativeAttempt = this.db.prepare("SELECT 1 FROM strategy_native_execution_attempts WHERE quote_hash = ?")
        .get(receipt.quoteHash);
      if (nativeAttempt !== undefined) {
        const changedAtMs = this.clock();
        requireCondition(Number.isSafeInteger(changedAtMs) && changedAtMs >= 0,
          "INVALID_CLOCK", "The native strategy position clock is invalid.");
        try {
          if (order.lifecycleAction === "ENTRY") {
            const position = nativeStrategyPositionFromEntry({
              orderHashHex: toHex(receipt.orderHash),
              receiptHashHex,
              order,
              graph,
              receipt,
            });
            if (position !== undefined) {
              this.db.prepare(`
                INSERT INTO strategy_native_positions
                  (strategy_id, owner_id, template_id, economic_quantity_atoms,
                   entry_order_hash, entry_receipt_hash,
                   state_hash, state_json, status, exit_order_hash, exit_receipt_hash,
                   recorded_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
              `).run(
                position.strategyId,
                position.owner,
                position.templateId,
                position.economicQuantityAtoms.toString(),
                hashBuffer(position.entryOrderHashHex),
                hashBuffer(position.entryReceiptHashHex),
                hashBuffer(position.stateHashHex),
                stringifyProtocolJson(position.state),
                position.status,
                changedAtMs,
                changedAtMs,
              );
            }
          } else if (order.lifecycleAction === "EXIT" || order.lifecycleAction === "EMERGENCY_UNWIND") {
            const row = this.db.prepare("SELECT * FROM strategy_native_positions WHERE exit_order_hash = ?")
              .get(receipt.orderHash) as NativePositionRow | undefined;
            requireCondition(row !== undefined, "EXIT_NOT_SELECTED",
              "The native strategy exit receipt has no selected open position.");
            const position = nativePositionRow(row);
            const next = applyNativeStrategyExitReceipt(
              position,
              toHex(receipt.orderHash),
              receiptHashHex,
              order,
              graph,
              receipt,
            );
            const updated = this.db.prepare(`
              UPDATE strategy_native_positions
              SET state_hash = ?, state_json = ?, status = ?, exit_order_hash = ?,
                  exit_receipt_hash = ?, updated_at_ms = ?
              WHERE strategy_id = ? AND status = 'EXITING' AND exit_order_hash = ?
            `).run(
              hashBuffer(next.stateHashHex),
              stringifyProtocolJson(next.state),
              next.status,
              next.exitOrderHashHex === undefined ? null : hashBuffer(next.exitOrderHashHex),
              hashBuffer(receiptHashHex),
              changedAtMs,
              next.strategyId,
              receipt.orderHash,
            );
            requireCondition(updated.changes === 1, "STALE_STRATEGY_STATE",
              "The native strategy state changed before receipt finalization.");
          } else if (order.lifecycleAction === "INCREASE" || order.lifecycleAction === "DECREASE") {
            const transition = this.db.prepare(`
              SELECT strategy_id, expected_state_hash, receipt_hash
              FROM strategy_native_transitions WHERE order_hash = ?
            `).get(receipt.orderHash) as {
              strategy_id: string;
              expected_state_hash: Uint8Array;
              receipt_hash: Uint8Array | null;
            } | undefined;
            requireCondition(transition !== undefined && transition.receipt_hash === null,
              "TRANSITION_NOT_SELECTED", "The native strategy receipt has no pending lifecycle transition.");
            const row = this.db.prepare("SELECT * FROM strategy_native_positions WHERE strategy_id = ?")
              .get(transition.strategy_id) as NativePositionRow | undefined;
            requireCondition(row !== undefined && row.status === "OPEN"
              && bytesEqual(row.state_hash, transition.expected_state_hash),
            "STALE_STRATEGY_STATE", "The native strategy state changed before transition finalization.");
            const position = nativePositionRow(row);
            const next = applyNativeStrategyTransitionReceipt(position, order, graph, receipt);
            const updated = this.db.prepare(`
              UPDATE strategy_native_positions
              SET economic_quantity_atoms = ?, state_hash = ?, state_json = ?, status = ?, updated_at_ms = ?
              WHERE strategy_id = ? AND status = 'OPEN' AND state_hash = ?
            `).run(
              next.economicQuantityAtoms.toString(),
              hashBuffer(next.stateHashHex),
              stringifyProtocolJson(next.state),
              next.status,
              changedAtMs,
              next.strategyId,
              transition.expected_state_hash,
            );
            requireCondition(updated.changes === 1, "STALE_STRATEGY_STATE",
              "The native strategy state changed before transition finalization.");
            const finalized = this.db.prepare(`
              UPDATE strategy_native_transitions
              SET receipt_hash = ?, finalized_at_ms = ?
              WHERE order_hash = ? AND receipt_hash IS NULL
            `).run(receiptHash, changedAtMs, receipt.orderHash);
            requireCondition(finalized.changes === 1, "TRANSITION_NOT_SELECTED",
              "The native strategy transition was already finalized.");
          }
        } catch (error) {
          if (error instanceof NativeStrategyPositionError) {
            throw new StrategyPackageStoreError(error.code, error.message);
          }
          throw error;
        }
      }
      return Object.freeze({ created: true, receiptHashHex });
    }).immediate();
  }

  order(orderHashHex: string): StoredStrategyPackageOrder | undefined {
    const row = this.db.prepare("SELECT graph_hash, order_json, graph_json, recorded_at_ms FROM strategy_package_orders WHERE order_hash = ?").get(hashBuffer(orderHashHex)) as { graph_hash: Uint8Array; order_json: string; graph_json: string; recorded_at_ms: number } | undefined;
    if (row === undefined) return undefined;
    const order = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrderInput);
    const graph = packageGraph(parseProtocolJson(row.graph_json) as PackageGraphInput);
    requireCondition(toHex(strategyPackageOrderHash(order)) === orderHashHex && bytesEqual(packageGraphHash(graph), row.graph_hash), "CORRUPT_ROW", "A stored order or graph does not match its hash.");
    return Object.freeze({ orderHashHex, graphHashHex: toHex(row.graph_hash), order, graph, recordedAtMs: row.recorded_at_ms });
  }

  quotes(orderHashHex: string): readonly StoredStrategyPackageQuote[] {
    const rows = this.db.prepare("SELECT quote_hash, route_hash, quote_json, route_json, recorded_at_ms FROM strategy_package_quotes WHERE order_hash = ? ORDER BY recorded_at_ms, quote_hash").all(hashBuffer(orderHashHex)) as { quote_hash: Uint8Array; route_hash: Uint8Array; quote_json: string; route_json: string; recorded_at_ms: number }[];
    return Object.freeze(rows.map((row) => {
      const quote = strategyPackageQuote(parseProtocolJson(row.quote_json) as StrategyPackageQuote);
      const route = parseProtocolJson(row.route_json) as TypedStrategyRoute;
      requireCondition(bytesEqual(strategyPackageQuoteHash(quote), row.quote_hash) && bytesEqual(typedStrategyRouteHash(route), row.route_hash), "CORRUPT_ROW", "A stored quote or route does not match its hash.");
      return Object.freeze({ quoteHashHex: toHex(row.quote_hash), routeHashHex: toHex(row.route_hash), quote, route, recordedAtMs: row.recorded_at_ms });
    }));
  }

  admissionByQuote(quoteHashHex: string): StoredStrategyPackageAdmission | undefined {
    const row = this.db.prepare(`
      SELECT q.order_hash, q.route_hash, q.quote_json, q.route_json, q.recorded_at_ms,
             o.graph_hash, o.order_json, o.graph_json
      FROM strategy_package_quotes q
      JOIN strategy_package_orders o ON o.order_hash = q.order_hash
      WHERE q.quote_hash = ?
    `).get(hashBuffer(quoteHashHex)) as {
      order_hash: Uint8Array;
      route_hash: Uint8Array;
      quote_json: string;
      route_json: string;
      recorded_at_ms: number;
      graph_hash: Uint8Array;
      order_json: string;
      graph_json: string;
    } | undefined;
    if (row === undefined) return undefined;
    const order = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrderInput);
    const graph = packageGraph(parseProtocolJson(row.graph_json) as PackageGraphInput);
    const quote = strategyPackageQuote(parseProtocolJson(row.quote_json) as StrategyPackageQuote);
    const route = parseProtocolJson(row.route_json) as TypedStrategyRoute;
    const orderHashHex = toHex(strategyPackageOrderHash(order));
    const graphHashHex = toHex(packageGraphHash(graph));
    const routeHashHex = toHex(typedStrategyRouteHash(route));
    requireCondition(orderHashHex === toHex(row.order_hash), "CORRUPT_ROW", "The stored strategy package order does not match its hash.");
    requireCondition(graphHashHex === toHex(row.graph_hash) && bytesEqual(order.graphHash, row.graph_hash), "CORRUPT_ROW", "The stored strategy package graph does not match its hash.");
    requireCondition(toHex(strategyPackageQuoteHash(quote)) === quoteHashHex && bytesEqual(quote.orderHash, row.order_hash), "CORRUPT_ROW", "The stored strategy package quote does not match its hash.");
    requireCondition(routeHashHex === toHex(row.route_hash) && bytesEqual(quote.routeHash, row.route_hash), "CORRUPT_ROW", "The stored strategy package route does not match its hash.");
    return Object.freeze({
      orderHashHex,
      graphHashHex,
      quoteHashHex,
      routeHashHex,
      order,
      graph,
      quote,
      route,
      recordedAtMs: row.recorded_at_ms,
    });
  }

  recentAdmissions(limit: number): readonly StrategyPackageAdmissionSummary[] {
    requireCondition(Number.isSafeInteger(limit) && limit > 0 && limit <= 50, "INVALID_LIMIT", "Recent strategy packages limit must be between 1 and 50.");
    const rows = this.db.prepare(`
      SELECT q.quote_hash, q.order_hash, q.route_hash, q.quote_json, q.route_json, q.recorded_at_ms,
             o.order_json
      FROM strategy_package_quotes q
      JOIN strategy_package_orders o ON o.order_hash = q.order_hash
      ORDER BY q.recorded_at_ms DESC, q.quote_hash DESC
      LIMIT ?
    `).all(limit) as {
      quote_hash: Uint8Array;
      order_hash: Uint8Array;
      route_hash: Uint8Array;
      quote_json: string;
      route_json: string;
      recorded_at_ms: number;
      order_json: string;
    }[];
    return Object.freeze(rows.map((row): StrategyPackageAdmissionSummary => {
      const order = strategyPackageOrder(parseProtocolJson(row.order_json) as StrategyPackageOrderInput);
      const quote = strategyPackageQuote(parseProtocolJson(row.quote_json) as StrategyPackageQuoteInput);
      const route = parseProtocolJson(row.route_json) as TypedStrategyRoute;
      requireCondition(bytesEqual(strategyPackageOrderHash(order), row.order_hash), "CORRUPT_ROW", "A recent strategy package order does not match its hash.");
      requireCondition(bytesEqual(strategyPackageQuoteHash(quote), row.quote_hash) && bytesEqual(quote.orderHash, row.order_hash), "CORRUPT_ROW", "A recent strategy package quote does not match its hash.");
      requireCondition(bytesEqual(typedStrategyRouteHash(route), row.route_hash) && bytesEqual(quote.routeHash, row.route_hash), "CORRUPT_ROW", "A recent strategy package route does not match its hash.");
      return Object.freeze({
        orderHashHex: toHex(row.order_hash),
        quoteHashHex: toHex(row.quote_hash),
        routeHashHex: toHex(row.route_hash),
        templateId: order.templateId,
        templateVersion: order.templateVersion,
        lifecycleAction: order.lifecycleAction,
        settlementClass: order.settlementClass,
        solverId: quote.solverId,
        domainIds: Object.freeze(route.domainPlans.map((plan) => plan.domain.domainId)),
        validUntilUnit: quote.validUntilUnit,
        validUntilValue: quote.validUntilValue,
        recordedAtMs: row.recorded_at_ms,
      });
    }));
  }

  receipt(receiptHashHex: string): StrategyPackageReceiptInput | undefined {
    const row = this.db.prepare("SELECT receipt_json FROM strategy_package_receipts WHERE receipt_hash = ?").get(hashBuffer(receiptHashHex)) as { receipt_json: string } | undefined;
    if (row === undefined) return undefined;
    const receipt = strategyPackageReceipt(parseProtocolJson(row.receipt_json) as StrategyPackageReceiptInput);
    requireCondition(toHex(strategyPackageReceiptHash(receipt)) === receiptHashHex, "CORRUPT_ROW", "A stored receipt does not match its hash.");
    return receipt;
  }

  receiptByQuote(quoteHashHex: string): StoredStrategyPackageReceipt | undefined {
    const row = this.db.prepare("SELECT receipt_hash, receipt_json, recorded_at_ms FROM strategy_package_receipts WHERE quote_hash = ?").get(hashBuffer(quoteHashHex)) as { receipt_hash: Uint8Array; receipt_json: string; recorded_at_ms: number } | undefined;
    if (row === undefined) return undefined;
    const receipt = strategyPackageReceipt(parseProtocolJson(row.receipt_json) as StrategyPackageReceiptInput);
    const receiptHashHex = toHex(row.receipt_hash);
    requireCondition(toHex(receipt.quoteHash) === quoteHashHex && toHex(strategyPackageReceiptHash(receipt)) === receiptHashHex,
      "CORRUPT_ROW", "A stored receipt does not match its quote or receipt hash.");
    return Object.freeze({ receiptHashHex, receipt, recordedAtMs: row.recorded_at_ms });
  }
}

export function createStrategyPackageInternalHandler(
  store: Pick<SqliteStrategyPackageStore, "admissionByQuote" | "order" | "recordReceipt">,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal.local");
    const quoteMatch = /^\/internal\/strategy-packages\/quotes\/([0-9a-f]{64})$/.exec(url.pathname);
    const orderMatch = /^\/internal\/strategy-packages\/orders\/([0-9a-f]{64})$/.exec(url.pathname);
    const recordsReceipt = url.pathname === "/internal/strategy-packages/receipts";
    if (quoteMatch === null && orderMatch === null && !recordsReceipt) return false;
    if (!internalCaller(request)) return sendError(response, 403, "FORBIDDEN", "Strategy package routes answer loopback callers only.");
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Strategy package routes accept no query parameters.");
    if (recordsReceipt) {
      if (request.method !== "POST") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
      }
      readInternalBody(request, response, (body) => {
        try {
          if (Object.keys(body).length !== 1 || body.receipt === undefined) {
            sendError(response, 400, "INVALID_REQUEST", "The body must contain only receipt.");
            return;
          }
          sendJson(response, 200, { version: 1, ...store.recordReceipt(body.receipt as StrategyPackageReceiptInput) });
        } catch (error) {
          if (error instanceof StrategyPackageStoreError) {
            sendError(response, error.code === "CORRUPT_ROW" ? 500 : 400, error.code, error.message);
            return;
          }
          sendError(response, 400, "RECEIPT_REJECTED", "The strategy package receipt was rejected.");
        }
      });
      return true;
    }
    if (request.method !== "GET") return sendError(response, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
    try {
      if (orderMatch !== null) {
        const stored = store.order(orderMatch[1]!);
        if (stored === undefined) return sendError(response, 404, "NOT_FOUND", "No stored strategy package order exists for this hash.");
        return sendJson(response, 200, { version: 1, ...stored });
      }
      const admission = store.admissionByQuote(quoteMatch![1]!);
      if (admission === undefined) return sendError(response, 404, "NOT_FOUND", "No admitted strategy package exists for this quote.");
      return sendJson(response, 200, { version: 1, ...admission });
    } catch (error) {
      if (error instanceof StrategyPackageStoreError) {
        return sendError(response, error.code === "CORRUPT_ROW" ? 500 : 400, error.code, error.message);
      }
      return sendError(response, 500, "INTERNAL_ERROR", "Strategy package retrieval failed closed.");
    }
  };
}

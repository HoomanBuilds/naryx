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
  type TypedStrategyRoute,
} from "@naryx/protocol-types";
import { openDurableDatabase } from "./durable-sqlite.js";
import { internalCaller, readInternalBody, sendError, sendJson } from "./internal-http.js";

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
CREATE TABLE IF NOT EXISTS strategy_package_receipts (
  receipt_hash BLOB PRIMARY KEY,
  order_hash BLOB NOT NULL REFERENCES strategy_package_orders(order_hash),
  quote_hash BLOB NOT NULL REFERENCES strategy_package_quotes(quote_hash),
  route_hash BLOB NOT NULL REFERENCES strategy_package_quotes(route_hash),
  receipt_json TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS strategy_package_orders_by_owner ON strategy_package_orders(owner_id, recorded_at_ms);
CREATE INDEX IF NOT EXISTS strategy_package_quotes_by_order ON strategy_package_quotes(order_hash, recorded_at_ms);
CREATE INDEX IF NOT EXISTS strategy_package_receipts_by_order ON strategy_package_receipts(order_hash, recorded_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_package_receipts_by_quote ON strategy_package_receipts(quote_hash);
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

  strategyExecutionAttempt(attemptId: string): SelectedStrategyPackageAttempt | undefined {
    if (!/^strategy-hl-[0-9a-f]{48}$/.test(attemptId)) return undefined;
    const row = this.db.prepare("SELECT * FROM strategy_execution_attempts WHERE attempt_id = ?")
      .get(attemptId) as Parameters<typeof attemptRow>[0] | undefined;
    return row === undefined ? undefined : attemptRow(row);
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

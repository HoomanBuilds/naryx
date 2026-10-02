import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { PackageOrder } from "@naryx/protocol-types";
import {
  ExecutionReadinessError,
  type ExecutionHandoff,
  type ExecutionReadinessGate,
  type ExecutionReadinessReceipt,
  type ExecutionReadinessScopeResolver,
} from "./execution-readiness-gate.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";

/**
 * Automatic testnet execution approval within operator caps.
 *
 * Every execution handoff is resolved to the durable order behind its selected attempt, and the
 * order's own worst-case quote spend is checked against the caps configured for its domain: per
 * operation, per UTC day, and the order's signed recovery-loss bound. Only allowlisted public
 * testnet domains are accepted; mainnet domains and environments are refused regardless of the
 * policy file. Every allow and deny is recorded durably before the handoff proceeds.
 */

const POLICY_VERSION = 1;
const DOMAIN_ID_PATTERN = /^[a-z0-9]+:[A-Za-z0-9._-]{1,64}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9:._/-]{1,128}$/;
const ATOMS_PATTERN = /^(0|[1-9]\d{0,38})$/;
const MAINNET_DOMAINS = new Set([
  "eip155:1",
  "eip155:8453",
  "eip155:42161",
  "evm:base-mainnet",
  "evm:arbitrum-one",
  "hypercore:mainnet",
  "svm:mainnet",
  "svm:mainnet-beta",
]);

export type TestnetDomainCaps = Readonly<{
  domainId: string;
  /** The asset every cap is denominated in; the order's quote spend must be in this asset. */
  quoteAssetId: string;
  maxPrincipalAtomsPerOperation: bigint;
  maxPrincipalAtomsPerDay: bigint;
  maxRecoveryLossAtomsPerOperation: bigint;
}>;

export type TestnetExecutionPolicy = Readonly<{
  version: 1;
  domains: readonly TestnetDomainCaps[];
  /** sha256 of the policy file bytes, recorded with every decision. */
  policyHash: string;
}>;

export class TestnetExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestnetExecutionPolicyError";
  }
}

function policyFail(message: string): never {
  throw new TestnetExecutionPolicyError(`Testnet execution policy rejected: ${message}`);
}

function atoms(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !ATOMS_PATTERN.test(value)) policyFail(`${name} must be a decimal atom string.`);
  return BigInt(value);
}

export function isMainnetScope(environment: string, domainId: string): boolean {
  const normalized = environment.toLowerCase();
  return normalized.includes("mainnet") || normalized === "production" || MAINNET_DOMAINS.has(domainId.toLowerCase());
}

export function parseTestnetExecutionPolicy(text: string): TestnetExecutionPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    policyFail("the file is not JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) policyFail("the root must be an object.");
  const root = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(root).filter((key) => key !== "version" && key !== "domains");
  if (unknownKeys.length > 0) policyFail(`unknown fields ${unknownKeys.join(", ")}.`);
  if (root.version !== POLICY_VERSION) policyFail(`version must be ${POLICY_VERSION}.`);
  if (!Array.isArray(root.domains) || root.domains.length === 0) policyFail("domains must be a non-empty array.");
  const seen = new Set<string>();
  const domains = root.domains.map((entry, index): TestnetDomainCaps => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) policyFail(`domains[${index}] must be an object.`);
    const value = entry as Record<string, unknown>;
    const allowed = ["domainId", "quoteAssetId", "maxPrincipalAtomsPerOperation", "maxPrincipalAtomsPerDay", "maxRecoveryLossAtomsPerOperation"];
    const extra = Object.keys(value).filter((key) => !allowed.includes(key));
    if (extra.length > 0) policyFail(`domains[${index}] has unknown fields ${extra.join(", ")}.`);
    if (typeof value.domainId !== "string" || !DOMAIN_ID_PATTERN.test(value.domainId)) policyFail(`domains[${index}].domainId is invalid.`);
    if (isMainnetScope("", value.domainId)) policyFail(`domains[${index}] names a mainnet domain.`);
    if (seen.has(value.domainId)) policyFail(`domain ${value.domainId} is listed twice.`);
    seen.add(value.domainId);
    if (typeof value.quoteAssetId !== "string" || !ASSET_ID_PATTERN.test(value.quoteAssetId)) policyFail(`domains[${index}].quoteAssetId is invalid.`);
    const perOperation = atoms(value.maxPrincipalAtomsPerOperation, `domains[${index}].maxPrincipalAtomsPerOperation`);
    const perDay = atoms(value.maxPrincipalAtomsPerDay, `domains[${index}].maxPrincipalAtomsPerDay`);
    const loss = atoms(value.maxRecoveryLossAtomsPerOperation, `domains[${index}].maxRecoveryLossAtomsPerOperation`);
    if (perOperation === 0n || perDay < perOperation) policyFail(`domains[${index}] caps must satisfy 0 < per operation <= per day.`);
    return Object.freeze({
      domainId: value.domainId,
      quoteAssetId: value.quoteAssetId,
      maxPrincipalAtomsPerOperation: perOperation,
      maxPrincipalAtomsPerDay: perDay,
      maxRecoveryLossAtomsPerOperation: loss,
    });
  });
  return Object.freeze({
    version: POLICY_VERSION,
    domains: Object.freeze(domains),
    policyHash: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}

let cachedRepositoryRoot: string | undefined;

function repositoryRoot(): string | undefined {
  if (cachedRepositoryRoot !== undefined) return cachedRepositoryRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, ".git"))) return cachedRepositoryRoot = current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function outsideRepository(value: string, name: string): string {
  if (!isAbsolute(value) || value === ":memory:") policyFail(`${name} must be an absolute path.`);
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(root + sep))) policyFail(`${name} must be outside the repository.`);
  return path;
}

export function loadTestnetExecutionPolicy(path: string): TestnetExecutionPolicy {
  return parseTestnetExecutionPolicy(readFileSync(outsideRepository(path, "NARYX_EXECUTION_POLICY_FILE"), "utf8"));
}

/** What the cap gate needs to decide, resolved from durable order and attempt records only. */
export type TestnetExecutionScope = Readonly<{
  handoff: ExecutionHandoff;
  attemptId: string;
  idempotencyKey: string;
  environment: string;
  domainId: string;
  orderHash: string;
  quoteAssetId: string;
  /** Worst-case quote spent: the spot-leg quote cap plus the margin cap. */
  principalAtoms: bigint;
  recoveryLossAtoms: bigint;
}>;

function rejectScope(message: string): never {
  throw new ExecutionReadinessError("READINESS_REJECTED", message);
}

/** The scope of an order: its domain, quote asset, and the caps it signs. Mixed assets fail closed. */
export function scopeFromOrder(
  handoff: ExecutionHandoff,
  request: Readonly<{ attemptId: string; idempotencyKey: string; orderHash: string }>,
  order: PackageOrder,
): TestnetExecutionScope {
  const quoteAsset = order.maxMarginAdded.asset.assetId;
  if (order.maxSpotQuoteIn !== undefined && order.maxSpotQuoteIn.asset.assetId !== quoteAsset) {
    rejectScope("The order's spot quote cap and margin cap are in different assets.");
  }
  if (order.maxAggregateRecoveryLossQuote.asset.assetId !== quoteAsset) {
    rejectScope("The order's recovery-loss cap is not in its quote asset.");
  }
  // An exit spends no new quote: its spot leg sells, its perp close only returns margin, and it signs
  // no spot quote cap and no added margin, so its principal is zero. Counting its sale value would let
  // the daily entry cap trap a package the cap already admitted; the domain allowlist, mainnet
  // refusal, quote asset, and recovery-loss checks still apply to it.
  if (order.action === "EXIT" && (order.maxSpotQuoteIn !== undefined || order.maxMarginAdded.atoms !== 0n)) {
    rejectScope("An exit order must not sign new spot spend or added margin.");
  }
  return Object.freeze({
    handoff,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    environment: order.environment,
    domainId: order.domain.domainId,
    orderHash: request.orderHash,
    quoteAssetId: quoteAsset,
    principalAtoms: (order.maxSpotQuoteIn?.atoms ?? 0n) + order.maxMarginAdded.atoms,
    recoveryLossAtoms: order.maxAggregateRecoveryLossQuote.atoms,
  });
}

/**
 * Resolves a handoff to its durable order. Solana Devnet preparation is keyed by the order's
 * idempotency key; every other handoff names its selected attempt.
 */
export class DurableAttemptScopeResolver implements ExecutionReadinessScopeResolver<TestnetExecutionScope> {
  readonly #orders: Pick<InternalOrderStore, "getByIdempotencyKey" | "getCanonicalOrderByHash">;
  readonly #intents: Pick<ExecutionIntentStore, "getAttempt" | "getAttemptForOrder">;

  constructor(
    orders: Pick<InternalOrderStore, "getByIdempotencyKey" | "getCanonicalOrderByHash">,
    intents: Pick<ExecutionIntentStore, "getAttempt" | "getAttemptForOrder">,
  ) {
    this.#orders = orders;
    this.#intents = intents;
  }

  resolve(handoff: ExecutionHandoff, request: Readonly<{ attemptId?: string; idempotencyKey: string }>): TestnetExecutionScope {
    if (handoff === "SOLANA_LOCAL_SUBMIT") rejectScope("Local fixture submission is not a testnet handoff.");
    let attemptId: string;
    let orderHash: string;
    if (handoff === "SOLANA_DEVNET_PREPARE") {
      const record = this.#orders.getByIdempotencyKey(request.idempotencyKey);
      if (record === undefined) rejectScope("No durable order exists for this preparation.");
      const attempt = this.#intents.getAttemptForOrder(record.orderHashHex);
      if (attempt === undefined) rejectScope("The order has no selected attempt.");
      attemptId = attempt.attemptId;
      orderHash = record.orderHashHex;
    } else {
      if (request.attemptId === undefined) rejectScope("The handoff does not name an attempt.");
      const attempt = this.#intents.getAttempt(request.attemptId);
      if (attempt === undefined) rejectScope("The named attempt does not exist.");
      attemptId = attempt.attemptId;
      orderHash = attempt.orderHash;
    }
    const order = this.#orders.getCanonicalOrderByHash(orderHash);
    if (order === undefined) rejectScope("The attempt's canonical order is missing.");
    return scopeFromOrder(handoff, { attemptId, idempotencyKey: request.idempotencyKey, orderHash }, order);
  }
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function decisionHash(fields: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type TestnetExecutionGateOptions = Readonly<{
  policy: () => TestnetExecutionPolicy;
  databasePath: string;
  nowMs?: () => number;
}>;

/**
 * The cap gate. An attempt is approved once and counted once against its domain's daily cap;
 * later handoffs of the same attempt (Base authorize then prepare) reuse that approval. A denial
 * is recorded and never counts toward the day.
 */
export class TestnetCapExecutionGate implements ExecutionReadinessGate<TestnetExecutionScope> {
  readonly #policy: () => TestnetExecutionPolicy;
  readonly #nowMs: () => number;
  readonly #db: Database.Database;
  readonly #getApproval: Database.Statement;
  readonly #dayRows: Database.Statement;
  readonly #insertApproval: Database.Statement;
  readonly #insertHandoff: Database.Statement;
  readonly #insertDenial: Database.Statement;

  constructor(options: TestnetExecutionGateOptions) {
    this.#policy = options.policy;
    this.#nowMs = options.nowMs ?? Date.now;
    const path = outsideRepository(options.databasePath, "NARYX_EXECUTION_POLICY_DB");
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS testnet_execution_approvals (
        attempt_id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL,
        order_hash TEXT NOT NULL,
        quote_asset_id TEXT NOT NULL,
        principal_atoms TEXT NOT NULL,
        utc_day TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        decision_hash TEXT NOT NULL,
        decided_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS testnet_execution_approvals_day ON testnet_execution_approvals (domain_id, utc_day);
      CREATE TABLE IF NOT EXISTS testnet_execution_handoffs (
        handoff TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        decision_hash TEXT NOT NULL,
        decided_at_ms INTEGER NOT NULL,
        PRIMARY KEY (handoff, attempt_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS testnet_execution_denials (
        handoff TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        principal_atoms TEXT NOT NULL,
        reason TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        decided_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    this.#getApproval = this.#db.prepare("SELECT * FROM testnet_execution_approvals WHERE attempt_id = ?");
    this.#dayRows = this.#db.prepare(
      "SELECT principal_atoms FROM testnet_execution_approvals WHERE domain_id = ? AND utc_day = ?",
    );
    this.#insertApproval = this.#db.prepare(`
      INSERT INTO testnet_execution_approvals
        (attempt_id, domain_id, order_hash, quote_asset_id, principal_atoms, utc_day, policy_hash, decision_hash, decided_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#insertHandoff = this.#db.prepare(`
      INSERT INTO testnet_execution_handoffs (handoff, attempt_id, idempotency_key, decision_hash, decided_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (handoff, attempt_id, idempotency_key) DO NOTHING
    `);
    this.#insertDenial = this.#db.prepare(`
      INSERT INTO testnet_execution_denials
        (handoff, attempt_id, idempotency_key, domain_id, principal_atoms, reason, policy_hash, decided_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  authorize(scope: TestnetExecutionScope): ExecutionReadinessReceipt {
    const now = this.#nowMs();
    let policy: TestnetExecutionPolicy;
    try {
      policy = this.#policy();
    } catch (error) {
      throw new ExecutionReadinessError(
        "READINESS_UNAVAILABLE",
        error instanceof Error ? error.message : "The testnet execution policy is unavailable.",
      );
    }
    // Annotated so control-flow analysis treats every call as terminating. The denial row is
    // written after the transaction rolls back, below.
    const deny: (reason: string) => never = (reason) => rejectScope(reason);
    const decide = this.#db.transaction((): ExecutionReadinessReceipt => {
      if (isMainnetScope(scope.environment, scope.domainId)) deny("Mainnet execution is forbidden regardless of policy.");
      const caps = policy.domains.find((entry) => entry.domainId === scope.domainId);
      if (caps === undefined) deny(`Domain ${scope.domainId} is not enabled for testnet execution.`);
      if (scope.quoteAssetId !== caps.quoteAssetId) deny("The order's quote asset is not the asset its domain caps are set in.");
      if (scope.recoveryLossAtoms > caps.maxRecoveryLossAtomsPerOperation) deny("The order's recovery-loss bound exceeds the per-operation cap.");

      const existing = this.#getApproval.get(scope.attemptId) as Record<string, string | number> | undefined;
      if (existing !== undefined) {
        if (existing.domain_id !== scope.domainId || existing.order_hash !== scope.orderHash ||
            existing.principal_atoms !== scope.principalAtoms.toString()) {
          deny("The attempt was approved for a different order.");
        }
        this.#insertHandoff.run(scope.handoff, scope.attemptId, scope.idempotencyKey, existing.decision_hash, now);
        return Object.freeze({
          handoff: scope.handoff,
          attemptId: scope.attemptId,
          idempotencyKey: scope.idempotencyKey,
          fundedOperationManifestHash: String(existing.decision_hash),
          readinessDecisionHash: String(existing.policy_hash),
        });
      }

      if (scope.principalAtoms > caps.maxPrincipalAtomsPerOperation) deny("The order's worst-case spend exceeds the per-operation cap.");
      const day = utcDay(now);
      const spent = (this.#dayRows.all(scope.domainId, day) as { principal_atoms: string }[])
        .reduce((total, row) => total + BigInt(row.principal_atoms), 0n);
      if (spent + scope.principalAtoms > caps.maxPrincipalAtomsPerDay) deny("The order would exceed the domain's daily cap.");

      const hash = decisionHash({
        attemptId: scope.attemptId,
        domainId: scope.domainId,
        orderHash: scope.orderHash,
        quoteAssetId: scope.quoteAssetId,
        principalAtoms: scope.principalAtoms.toString(),
        utcDay: day,
        policyHash: policy.policyHash,
      });
      this.#insertApproval.run(
        scope.attemptId, scope.domainId, scope.orderHash, scope.quoteAssetId,
        scope.principalAtoms.toString(), day, policy.policyHash, hash, now,
      );
      this.#insertHandoff.run(scope.handoff, scope.attemptId, scope.idempotencyKey, hash, now);
      return Object.freeze({
        handoff: scope.handoff,
        attemptId: scope.attemptId,
        idempotencyKey: scope.idempotencyKey,
        fundedOperationManifestHash: hash,
        readinessDecisionHash: policy.policyHash,
      });
    });
    try {
      return decide();
    } catch (error) {
      if (error instanceof ExecutionReadinessError && error.code === "READINESS_REJECTED") {
        this.#insertDenial.run(
          scope.handoff, scope.attemptId, scope.idempotencyKey, scope.domainId,
          scope.principalAtoms.toString(), error.message, policy.policyHash, now,
        );
      }
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }
}

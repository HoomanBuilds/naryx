import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  bytesEqual,
  fundedOperationManifest,
  fundedOperationManifestHash,
  parseProtocolJson,
  readinessDecision,
  readinessDecisionHash,
  readinessEvidenceHash,
  toHex,
  type DomainRef,
  type ExpiryUnit,
  type FundedOperationAction,
  type FundedOperationManifestInput,
  type QuoteMode,
  type ReadinessDecisionInput,
  type ReadinessEvidenceInput,
  type SettlementClass,
  type VersionedManifestRef,
} from "@naryx/protocol-types";

export type ExecutionHandoff =
  | "SOLANA_LOCAL_SUBMIT"
  | "SOLANA_DEVNET_PREPARE"
  | "BASE_TESTNET_ATOMIC_AUTHORIZE"
  | "BASE_TESTNET_ATOMIC_PREPARE"
  | "ARBITRUM_TESTNET_ASYNC_HANDOFF"
  | "HYPERLIQUID_TESTNET_EXECUTE";

export type ExecutionReadinessScope = Readonly<{
  handoff: ExecutionHandoff;
  attemptId: string;
  idempotencyKey: string;
  environment: string;
  domain: DomainRef;
  template: VersionedManifestRef;
  settlementClass: SettlementClass;
  quoteMode: QuoteMode;
  sizeCohort: string;
  assetId: string;
  action: FundedOperationAction;
  operationId: string;
  sourceAccountCommitment: Uint8Array | string;
  destinationAccountCommitment: Uint8Array | string;
  unsignedPayloadHash: Uint8Array | string;
  principalAtoms: bigint;
  networkFeeAtoms: bigint;
  protocolFeeAtoms: bigint;
  slippageAtoms: bigint;
  marginAtoms: bigint;
  recoveryAtoms: bigint;
  lossAtoms: bigint;
  nowUnit: ExpiryUnit;
  nowValue: bigint;
  runtimeCodeHash: Uint8Array | string;
  configurationManifestHash: Uint8Array | string;
  authorityInventoryHash: Uint8Array | string;
  evidence: readonly ReadinessEvidenceInput[];
  expectedFundedOperationManifestHash: Uint8Array | string;
  expectedReadinessDecisionHash: Uint8Array | string;
}>;

export type ExecutionReadinessReceipt = Readonly<{
  handoff: ExecutionHandoff;
  attemptId: string;
  idempotencyKey: string;
  fundedOperationManifestHash: string;
  readinessDecisionHash: string;
}>;

export interface ExecutionReadinessPolicyProvider {
  current(): ReadinessDecisionInput | undefined;
}

/** The fields every gate's scope carries; the HTTP boundary checks them against the request. */
export type ExecutionReadinessScopeIdentity = Readonly<{
  handoff: ExecutionHandoff;
  attemptId: string;
  idempotencyKey: string;
}>;

export interface ExecutionReadinessScopeResolver<Scope extends ExecutionReadinessScopeIdentity = ExecutionReadinessScope> {
  resolve(handoff: ExecutionHandoff, request: Readonly<{ attemptId?: string; idempotencyKey: string }>):
    Promise<Scope> | Scope;
}

export interface ExecutionReadinessEvidenceStore {
  persist(receipt: ExecutionReadinessReceipt): void;
}

export interface ExecutionReadinessGate<Scope extends ExecutionReadinessScopeIdentity = ExecutionReadinessScope> {
  authorize(scope: Scope): ExecutionReadinessReceipt;
}

export class ExecutionReadinessError extends Error {
  readonly code: "READINESS_UNAVAILABLE" | "READINESS_REJECTED";

  constructor(code: ExecutionReadinessError["code"], message: string) {
    super(message);
    this.name = "ExecutionReadinessError";
    this.code = code;
  }
}

function reject(message: string): never {
  throw new ExecutionReadinessError("READINESS_REJECTED", message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId &&
    left.domainManifestVersion === right.domainManifestVersion &&
    bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId && left.manifestVersion === right.manifestVersion &&
    bytesEqual(left.manifestHash, right.manifestHash);
}

function hashEqual(left: Uint8Array | string, right: Uint8Array | string): boolean {
  try {
    const leftHex = typeof left === "string" ? left.replace(/^0x/, "") : toHex(left);
    const rightHex = typeof right === "string" ? right.replace(/^0x/, "") : toHex(right);
    return leftHex === rightHex;
  } catch {
    return false;
  }
}

function exactEvidence(expected: readonly ReadinessEvidenceInput[], actual: readonly ReadinessEvidenceInput[]): boolean {
  if (expected.length !== actual.length) return false;
  const identity = (item: ReadinessEvidenceInput) => `${item.kind}:${toHex(readinessEvidenceHash(item))}`;
  const expectedRecords = expected.map(identity).sort();
  const actualRecords = actual.map(identity).sort();
  return expectedRecords.every((record, index) => record === actualRecords[index]);
}

function isMainnet(environment: string, domainId: string): boolean {
  const knownMainnetDomains = new Set([
    "eip155:1",
    "eip155:8453",
    "eip155:42161",
    "hypercore:mainnet",
    "svm:mainnet",
    "svm:mainnet-beta",
  ]);
  return environment.toLowerCase().includes("mainnet") ||
    environment.toLowerCase() === "production" || knownMainnetDomains.has(domainId.toLowerCase());
}

function checkedAtoms(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n) reject(`${name} must be nonnegative integer atoms.`);
  return value;
}

function operationInput(operation: ReturnType<typeof fundedOperationManifest>): FundedOperationManifestInput {
  return {
    ...operation,
    validFromUnit: operation.validFrom.unit,
    validFromValue: operation.validFrom.value,
    validUntilUnit: operation.validUntil.unit,
    validUntilValue: operation.validUntil.value,
  };
}

export class ManifestExecutionReadinessGate implements ExecutionReadinessGate {
  readonly #policies: ExecutionReadinessPolicyProvider;
  readonly #evidence: ExecutionReadinessEvidenceStore;

  constructor(policies: ExecutionReadinessPolicyProvider, evidence: ExecutionReadinessEvidenceStore) {
    this.#policies = policies;
    this.#evidence = evidence;
  }

  authorize(scope: ExecutionReadinessScope): ExecutionReadinessReceipt {
    if (isMainnet(scope.environment, scope.domain.domainId)) {
      reject("Mainnet execution is forbidden regardless of readiness status.");
    }
    const input = this.#policies.current();
    if (input === undefined) {
      throw new ExecutionReadinessError("READINESS_UNAVAILABLE", "A current readiness decision is unavailable.");
    }
    const decision = readinessDecision(input);
    if (decision.status !== "READY") reject("The current readiness decision is not READY.");
    if (decision.environment !== scope.environment) reject("Readiness environment does not match the execution scope.");
    const decisionHash = readinessDecisionHash(input);
    if (!hashEqual(decisionHash, scope.expectedReadinessDecisionHash)) reject("Readiness decision hash mismatch.");
    if (!hashEqual(decision.authorityInventoryHash, scope.authorityInventoryHash)) reject("Authority inventory hash mismatch.");
    if (!exactEvidence(input.evidence, scope.evidence)) reject("Readiness evidence records mismatch.");

    const candidates = input.fundedOperations.map((value) => fundedOperationManifest(value));
    const operation = candidates.find((candidate) =>
      candidate.environment === scope.environment && sameDomain(candidate.domain, scope.domain) &&
      sameManifest(candidate.template, scope.template) && candidate.settlementClass === scope.settlementClass &&
      candidate.quoteMode === scope.quoteMode && candidate.sizeCohort === scope.sizeCohort &&
      candidate.assetId === scope.assetId && candidate.operationId === scope.operationId &&
      candidate.allowedActions.includes(scope.action) &&
      hashEqual(candidate.sourceAccountCommitment, scope.sourceAccountCommitment) &&
      hashEqual(candidate.destinationAccountCommitment, scope.destinationAccountCommitment) &&
      hashEqual(candidate.unsignedPayloadHash, scope.unsignedPayloadHash));
    if (operation === undefined) reject("No funded operation manifest exactly matches the execution scope.");
    if (operation.validFrom.unit !== scope.nowUnit || operation.validUntil.unit !== scope.nowUnit ||
        scope.nowValue < operation.validFrom.value || scope.nowValue >= operation.validUntil.value) {
      reject("Funded operation manifest is not currently valid.");
    }
    if (!hashEqual(operation.runtimeCodeHash, scope.runtimeCodeHash) ||
        !hashEqual(operation.configurationManifestHash, scope.configurationManifestHash) ||
        !hashEqual(operation.authorityInventoryHash, scope.authorityInventoryHash)) {
      reject("Funded operation identity hash mismatch.");
    }
    const manifestHash = fundedOperationManifestHash(operationInput(operation));
    if (!hashEqual(manifestHash, scope.expectedFundedOperationManifestHash) ||
        !decision.fundedOperationHashes.some((hash) => bytesEqual(hash, manifestHash))) {
      reject("Funded operation manifest hash mismatch.");
    }
    if (checkedAtoms(scope.principalAtoms, "principalAtoms") > operation.maxPrincipalAtoms ||
        checkedAtoms(scope.networkFeeAtoms, "networkFeeAtoms") > operation.maxNetworkFeeAtoms ||
        checkedAtoms(scope.protocolFeeAtoms, "protocolFeeAtoms") > operation.maxProtocolFeeAtoms ||
        checkedAtoms(scope.slippageAtoms, "slippageAtoms") > operation.maxSlippageAtoms ||
        checkedAtoms(scope.marginAtoms, "marginAtoms") > operation.maxMarginAtoms ||
        checkedAtoms(scope.recoveryAtoms, "recoveryAtoms") > operation.maxRecoveryAtoms ||
        checkedAtoms(scope.lossAtoms, "lossAtoms") > operation.maxLossAtoms) {
      reject("Execution scope exceeds a funded operation cap.");
    }
    const receipt = Object.freeze({
      handoff: scope.handoff,
      attemptId: scope.attemptId,
      idempotencyKey: scope.idempotencyKey,
      fundedOperationManifestHash: toHex(manifestHash),
      readinessDecisionHash: toHex(decisionHash),
    });
    this.#evidence.persist(receipt);
    return receipt;
  }
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

function durablePath(value: string): string {
  if (!isAbsolute(value) || value === ":memory:") throw new Error("Readiness evidence database path must be absolute.");
  const path = resolve(value);
  const root = repositoryRoot();
  if (root !== undefined && (path === root || path.startsWith(root + sep))) {
    throw new Error("Readiness evidence database must remain outside the repository.");
  }
  return path;
}

export class FileExecutionReadinessPolicyProvider implements ExecutionReadinessPolicyProvider {
  readonly #path: string;

  constructor(path: string) {
    this.#path = durablePath(path);
  }

  current(): ReadinessDecisionInput {
    const value = parseProtocolJson(
      readFileSync(this.#path, "utf8"),
      "executionReadinessDecision",
    ) as unknown as ReadinessDecisionInput;
    readinessDecision(value);
    return value;
  }
}

export class SqliteExecutionReadinessEvidenceStore implements ExecutionReadinessEvidenceStore {
  readonly #db: Database.Database;
  readonly #insert: Database.Statement;

  constructor(path: string) {
    const resolved = durablePath(path);
    mkdirSync(dirname(resolved), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS execution_readiness_evidence (
        handoff TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        funded_operation_manifest_hash TEXT NOT NULL,
        readiness_decision_hash TEXT NOT NULL,
        PRIMARY KEY (handoff, attempt_id, idempotency_key)
      ) STRICT;
    `);
    this.#insert = this.#db.prepare(`
      INSERT INTO execution_readiness_evidence
        (handoff, attempt_id, idempotency_key, funded_operation_manifest_hash, readiness_decision_hash)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (handoff, attempt_id, idempotency_key) DO UPDATE SET
        funded_operation_manifest_hash = excluded.funded_operation_manifest_hash,
        readiness_decision_hash = excluded.readiness_decision_hash
      WHERE funded_operation_manifest_hash = excluded.funded_operation_manifest_hash
        AND readiness_decision_hash = excluded.readiness_decision_hash
    `);
  }

  persist(receipt: ExecutionReadinessReceipt): void {
    const result = this.#insert.run(
      receipt.handoff,
      receipt.attemptId,
      receipt.idempotencyKey,
      receipt.fundedOperationManifestHash,
      receipt.readinessDecisionHash,
    );
    if (result.changes !== 1) reject("Attempt evidence is already bound to different readiness hashes.");
  }

  close(): void { this.#db.close(); }
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  authorityInventoryHash,
  domainRef,
  fundedOperationManifestHash,
  readinessDecisionHash,
  versionedManifestRef,
  type AuthorityInventoryInput,
  type FundedOperationManifestInput,
  type ReadinessDecisionInput,
} from "@naryx/protocol-types";
import {
  ExecutionReadinessError,
  ManifestExecutionReadinessGate,
  type ExecutionReadinessReceipt,
  type ExecutionReadinessScope,
} from "../src/index.js";

const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const domain = domainRef("hypercore:testnet", 1, hash(1));
const template = versionedManifestRef("template:cash-carry", 1, hash(2));

function inventory(environment = "testnet"): AuthorityInventoryInput {
  return {
    schemaVersion: 1,
    inventoryVersion: 1,
    environment,
    roles: [
      {
        roleId: "role:incident",
        authorityClass: "INCIDENT_OWNER",
        publicIdentityCommitment: hash(3),
        custodyPolicyHash: hash(4),
      },
      {
        roleId: "role:executor",
        authorityClass: "EXECUTION_SIGNER",
        publicIdentityCommitment: hash(5),
        custodyPolicyHash: hash(6),
      },
    ],
  };
}

function operation(environment = "testnet", operationDomain = domain): FundedOperationManifestInput {
  const authorities = inventory(environment);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    environment,
    domain: operationDomain,
    template,
    settlementClass: "BATCHED_IOC_WITH_RECOVERY",
    quoteMode: "EXECUTION_COMMITMENT",
    sizeCohort: "cohort:small",
    assetId: "asset:usdc",
    maxAssetMovementAtoms: 1_000_000n,
    maxFeeAtoms: 10_000n,
    maxMarginAtoms: 500_000n,
    maxRecoveryAtoms: 100_000n,
    runtimeCodeHash: hash(7),
    configurationManifestHash: hash(8),
    authorityInventoryVersion: 1,
    authorityInventoryHash: authorityInventoryHash(authorities),
    signerRoleIds: ["role:executor"],
    allowedActions: ["EXECUTE"],
    validFromUnit: "EVM_UNIX_SECONDS",
    validFromValue: 100n,
    validUntilUnit: "EVM_UNIX_SECONDS",
    validUntilValue: 200n,
    incidentOwnerRoleId: "role:incident",
    mainnetAuthorizationStatus: "NOT_AUTHORIZED",
  };
}

function decision(environment = "testnet", fundedOperation = operation(environment)): ReadinessDecisionInput {
  const authorities = inventory(environment);
  return {
    schemaVersion: 1,
    decisionVersion: 1,
    environment,
    evaluatedAtUnit: "EVM_UNIX_SECONDS",
    evaluatedAtValue: 150n,
    authorityInventory: authorities,
    capPolicy: {
      schemaVersion: 1,
      policyVersion: 1,
      environment,
      caps: [{
        ...fundedOperation,
        maxAssetMovementAtoms: 1_000_000n,
        maxFeeAtoms: 10_000n,
        maxMarginAtoms: 500_000n,
        maxRecoveryAtoms: 100_000n,
      }],
    },
    fundedOperations: [fundedOperation],
    findingSummary: { schemaVersion: 1, registerVersion: 1, findings: [] },
    evidence: [
      { kind: "BUILD", commitment: hash(10) },
      { kind: "FOCUSED_TESTS", commitment: hash(11) },
      { kind: "DEPLOYMENT_DRY_RUN", commitment: hash(12) },
      { kind: "AUTHORITY_REVIEW", commitment: hash(13) },
      { kind: "INCIDENT_RUNBOOK", commitment: hash(14) },
    ],
  };
}

function scope(input = decision(), fundedOperation = input.fundedOperations[0] as FundedOperationManifestInput): ExecutionReadinessScope {
  return {
    handoff: "HYPERLIQUID_TESTNET_EXECUTE",
    attemptId: "hyperliquid-testnet-0123456789abcdef0123456789abcdef0123456789abcdef",
    idempotencyKey: "idempotency-01234567",
    environment: input.environment,
    domain: fundedOperation.domain,
    template: fundedOperation.template,
    settlementClass: fundedOperation.settlementClass,
    quoteMode: fundedOperation.quoteMode,
    sizeCohort: fundedOperation.sizeCohort,
    assetId: fundedOperation.assetId,
    action: "EXECUTE",
    quantityAtoms: 900_000n,
    notionalAtoms: 900_000n,
    feeAtoms: 9_000n,
    marginAtoms: 400_000n,
    recoveryAtoms: 90_000n,
    nowUnit: "EVM_UNIX_SECONDS",
    nowValue: 150n,
    runtimeCodeHash: fundedOperation.runtimeCodeHash,
    configurationManifestHash: fundedOperation.configurationManifestHash,
    authorityInventoryHash: fundedOperation.authorityInventoryHash,
    evidenceCommitments: input.evidence.map((item) => item.commitment),
    expectedFundedOperationManifestHash: fundedOperationManifestHash(fundedOperation),
    expectedReadinessDecisionHash: readinessDecisionHash(input),
  };
}

function gate(input: ReadinessDecisionInput | undefined, receipts: ExecutionReadinessReceipt[] = []) {
  return new ManifestExecutionReadinessGate(
    { current: () => input },
    { persist: (receipt) => { receipts.push(receipt); } },
  );
}

function rejected(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error) => error instanceof ExecutionReadinessError && pattern.test(error.message));
}

test("readiness gate rejects an absent funded-operation policy", () => {
  rejected(() => gate(undefined).authorize(scope()), /unavailable/i);
});

test("readiness gate rejects an exact scope mismatch", () => {
  const input = decision();
  rejected(() => gate(input).authorize({ ...scope(input), sizeCohort: "cohort:large" }), /exactly matches/i);
});

test("readiness gate rejects an expired funded operation", () => {
  const input = decision();
  rejected(() => gate(input).authorize({ ...scope(input), nowValue: 200n }), /currently valid/i);
});

test("readiness gate rejects quantity, fee, margin, and recovery cap excess", () => {
  const input = decision();
  rejected(() => gate(input).authorize({ ...scope(input), notionalAtoms: 1_000_001n }), /exceeds/i);
});

test("readiness gate rejects manifest and decision hash mismatch", () => {
  const input = decision();
  rejected(() => gate(input).authorize({ ...scope(input), expectedReadinessDecisionHash: hash(31) }), /decision hash/i);
  rejected(() => gate(input).authorize({ ...scope(input), expectedFundedOperationManifestHash: hash(30) }), /manifest hash/i);
});

test("readiness gate persists exact hashes for a valid Testnet handoff", () => {
  const input = decision();
  const receipts: ExecutionReadinessReceipt[] = [];
  const receipt = gate(input, receipts).authorize(scope(input));
  assert.deepEqual(receipts, [receipt]);
  assert.equal(receipt.fundedOperationManifestHash, Buffer.from(input.fundedOperations[0] === undefined ? [] : fundedOperationManifestHash(input.fundedOperations[0])).toString("hex"));
  assert.equal(receipt.readinessDecisionHash, Buffer.from(readinessDecisionHash(input)).toString("hex"));
});

test("readiness gate rejects mainnet even when the canonical decision is READY", () => {
  const mainnetDomain = domainRef("hypercore:mainnet", 1, hash(20));
  const fundedOperation = operation("mainnet", mainnetDomain);
  const input = decision("mainnet", fundedOperation);
  rejected(() => gate(input).authorize(scope(input, fundedOperation)), /Mainnet execution is forbidden/);
});

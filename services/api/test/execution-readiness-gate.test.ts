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
const releaseHash = hash(30);
const sourceAccount = hash(21);
const destinationAccount = hash(22);

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
      {
        roleId: "role:reviewer",
        authorityClass: "SECURITY_REVIEWER",
        publicIdentityCommitment: hash(17),
        custodyPolicyHash: hash(19),
      },
      {
        roleId: "role:approver",
        authorityClass: "RELEASE_APPROVER",
        publicIdentityCommitment: hash(18),
        custodyPolicyHash: hash(20),
      },
    ],
    forbiddenCollisions: [
      { leftClass: "EXECUTION_SIGNER", rightClass: "RELEASE_APPROVER", forbidIdentityCollision: true, forbidCustodyCollision: true },
      { leftClass: "INCIDENT_OWNER", rightClass: "SECURITY_REVIEWER", forbidIdentityCollision: true, forbidCustodyCollision: true },
      { leftClass: "SECURITY_REVIEWER", rightClass: "RELEASE_APPROVER", forbidIdentityCollision: true, forbidCustodyCollision: true },
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
    maxPrincipalAtoms: 900_000n,
    maxNetworkFeeAtoms: 900n,
    maxProtocolFeeAtoms: 9_000n,
    maxSlippageAtoms: 19_000n,
    maxMarginAtoms: 400_000n,
    maxRecoveryAtoms: 90_000n,
    maxLossAtoms: 40_000n,
    operationId: "operation:one",
    sourceAccountCommitment: sourceAccount,
    destinationAccountCommitment: destinationAccount,
    unsignedPayloadHash: hash(23),
    runtimeCodeHash: hash(7),
    configurationManifestHash: hash(8),
    authorityInventoryVersion: 1,
    authorityInventoryHash: authorityInventoryHash(authorities),
    signerRoleIds: ["role:executor"],
    approverRoleCommitments: [{ roleId: "role:approver", identityCommitment: hash(18) }],
    allowedActions: ["EXECUTE"],
    prerequisites: ["DOMAIN_QUALIFIED", "ADAPTER_QUALIFIED", "ACCOUNT_BALANCE_CONFIRMED", "ALLOWANCE_CONFIRMED", "SIMULATION_PASSED", "RECOVERY_PROVEN"],
    stopConditions: ["PRINCIPAL_CAP_REACHED", "FEE_CAP_REACHED", "SLIPPAGE_CAP_REACHED", "LOSS_CAP_REACHED", "STALE_OBSERVATION", "DEPENDENCY_UNAVAILABLE", "RECONCILIATION_FAILED"],
    simulationEvidenceHash: hash(24),
    recoverabilityEvidenceHash: hash(25),
    validFromUnit: "EVM_UNIX_SECONDS",
    validFromValue: 100n,
    validUntilUnit: "EVM_UNIX_SECONDS",
    validUntilValue: 200n,
    incidentOwnerRoleId: "role:incident",
    mainnetAuthorizationStatus: "NOT_AUTHORIZED",
  };
}

function aggregateCap() {
  return {
    assetId: "asset:usdc",
    maxPrincipalAtoms: 1_000_000n,
    maxNetworkFeeAtoms: 1_000n,
    maxProtocolFeeAtoms: 10_000n,
    maxSlippageAtoms: 20_000n,
    maxMarginAtoms: 500_000n,
    maxRecoveryAtoms: 100_000n,
    maxLossAtoms: 50_000n,
  };
}

function evidence(environment: string, fundedOperation: FundedOperationManifestInput) {
  const manifestHash = fundedOperationManifestHash(fundedOperation);
  const kinds = [
    "BUILD", "FOCUSED_TESTS", "DEPLOYMENT_DRY_RUN", "AUTHORITY_REVIEW", "INCIDENT_RUNBOOK",
    "MONITORING", "RECOVERY_DRILL", "SIGNER_INVENTORY", "STOP_CONDITION_DRILL", "RECONCILIATION",
  ] as const;
  return kinds.map((kind, index) => ({
    kind,
    releaseHash,
    fundedOperationManifestHash: manifestHash,
    reviewerRoleId: "role:approver",
    reviewerIdentityCommitment: hash(18),
    result: "PASS" as const,
    environment,
    observedAtUnit: "EVM_UNIX_SECONDS" as const,
    observedAtValue: 120n,
    expiresAtUnit: "EVM_UNIX_SECONDS" as const,
    expiresAtValue: 190n,
    signatureCommitment: hash(40 + index),
  }));
}

function decision(environment = "testnet", fundedOperation = operation(environment)): ReadinessDecisionInput {
  const authorities = inventory(environment);
  return {
    schemaVersion: 1,
    decisionVersion: 1,
    environment,
    releaseHash,
    evaluatedAtUnit: "EVM_UNIX_SECONDS",
    evaluatedAtValue: 150n,
    authorityInventory: authorities,
    capPolicy: {
      schemaVersion: 1,
      policyVersion: 1,
      environment,
      caps: [{
        ...fundedOperation,
        maxPrincipalAtoms: 1_000_000n,
        maxNetworkFeeAtoms: 1_000n,
        maxProtocolFeeAtoms: 10_000n,
        maxSlippageAtoms: 20_000n,
        maxMarginAtoms: 500_000n,
        maxRecoveryAtoms: 100_000n,
        maxLossAtoms: 50_000n,
      }],
      aggregateAssetCaps: [aggregateCap()],
      aggregateAccountCaps: [
        { ...aggregateCap(), accountCommitment: sourceAccount },
        { ...aggregateCap(), accountCommitment: destinationAccount },
      ],
    },
    fundedOperations: [fundedOperation],
    findingSummary: {
      schemaVersion: 1,
      registerVersion: 1,
      findings: [{ findingId: "finding:none-observed", severity: "INFORMATIONAL", status: "OPEN", evidenceHash: hash(26) }],
      reviewAttestation: {
        reviewScopeHash: releaseHash,
        reviewerRoleId: "role:reviewer",
        reviewerIdentityCommitment: hash(17),
        result: "PASS",
        environment,
        completedAtUnit: "EVM_UNIX_SECONDS",
        completedAtValue: 120n,
        expiresAtUnit: "EVM_UNIX_SECONDS",
        expiresAtValue: 190n,
        signatureCommitment: hash(27),
      },
    },
    evidence: evidence(environment, fundedOperation),
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
    operationId: fundedOperation.operationId,
    sourceAccountCommitment: fundedOperation.sourceAccountCommitment,
    destinationAccountCommitment: fundedOperation.destinationAccountCommitment,
    unsignedPayloadHash: fundedOperation.unsignedPayloadHash,
    principalAtoms: 800_000n,
    networkFeeAtoms: 800n,
    protocolFeeAtoms: 8_000n,
    slippageAtoms: 18_000n,
    marginAtoms: 300_000n,
    recoveryAtoms: 80_000n,
    lossAtoms: 30_000n,
    nowUnit: "EVM_UNIX_SECONDS",
    nowValue: 150n,
    runtimeCodeHash: fundedOperation.runtimeCodeHash,
    configurationManifestHash: fundedOperation.configurationManifestHash,
    authorityInventoryHash: fundedOperation.authorityInventoryHash,
    evidence: input.evidence,
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

test("readiness gate rejects a separate network-fee budget excess", () => {
  const input = decision();
  rejected(() => gate(input).authorize({ ...scope(input), networkFeeAtoms: 901n }), /exceeds/i);
});

test("readiness gate rejects an exact evidence record mismatch", () => {
  const input = decision();
  const changed = input.evidence.map((item, index) => index === 0
    ? { ...item, signatureCommitment: hash(99) }
    : item);
  rejected(() => gate(input).authorize({ ...scope(input), evidence: changed }), /evidence records/i);
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

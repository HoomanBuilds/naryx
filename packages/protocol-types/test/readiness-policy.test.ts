import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DuplicateElementError, MalformedInputError, RangeViolationError,
  assertOperationLedgerTransition, authorityInventory, authorityInventoryHash, domainRef,
  fundedOperationManifest, fundedOperationManifestHash, operationCapPolicy, operationLedgerRecord,
  operationLedgerRecordHash, readinessDecision, readinessDecisionHash, securityFindingSummary,
  toHex, versionedManifestRef,
  type AuthorityInventoryInput, type FundedOperationManifestInput, type OperationBudgetInput,
  type OperationCapInput, type OperationCapPolicyInput, type OperationLedgerRecordInput,
  type ReadinessDecisionInput, type ReadinessEvidenceInput, type SecurityFindingSummaryInput,
} from '../src/index.js';

const U128_MAX = (1n << 128n) - 1n;
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const domain = domainRef('domain:test', 1, hash(1));
const template = versionedManifestRef('template:cash-carry', 1, hash(2));
const releaseHash = hash(30);
const sourceAccount = hash(21);
const destinationAccount = hash(22);

function inventory(overrides: Partial<AuthorityInventoryInput> = {}): AuthorityInventoryInput {
  return {
    schemaVersion: 1, inventoryVersion: 1, environment: 'testnet',
    roles: [
      { roleId: 'role:incident', authorityClass: 'INCIDENT_OWNER', publicIdentityCommitment: hash(3), custodyPolicyHash: hash(4) },
      { roleId: 'role:executor', authorityClass: 'EXECUTION_SIGNER', publicIdentityCommitment: hash(5), custodyPolicyHash: hash(6) },
      { roleId: 'role:reviewer', authorityClass: 'SECURITY_REVIEWER', publicIdentityCommitment: hash(17), custodyPolicyHash: hash(19) },
      { roleId: 'role:approver', authorityClass: 'RELEASE_APPROVER', publicIdentityCommitment: hash(18), custodyPolicyHash: hash(20) },
    ],
    forbiddenCollisions: [
      { leftClass: 'EXECUTION_SIGNER', rightClass: 'RELEASE_APPROVER', forbidIdentityCollision: true, forbidCustodyCollision: true },
      { leftClass: 'INCIDENT_OWNER', rightClass: 'SECURITY_REVIEWER', forbidIdentityCollision: true, forbidCustodyCollision: true },
      { leftClass: 'SECURITY_REVIEWER', rightClass: 'RELEASE_APPROVER', forbidIdentityCollision: true, forbidCustodyCollision: true },
    ],
    ...overrides,
  };
}

function cap(overrides: Partial<OperationCapInput> = {}): OperationCapInput {
  return {
    domain, template, settlementClass: 'BATCHED_IOC_WITH_RECOVERY', quoteMode: 'EXECUTION_COMMITMENT',
    sizeCohort: 'cohort:small', assetId: 'asset:usdc', maxPrincipalAtoms: 1_000_000n,
    maxNetworkFeeAtoms: 1_000n, maxProtocolFeeAtoms: 10_000n, maxSlippageAtoms: 20_000n,
    maxMarginAtoms: 500_000n, maxRecoveryAtoms: 100_000n, maxLossAtoms: 50_000n, ...overrides,
  };
}

function aggregateCap(overrides: Partial<OperationCapInput> = {}) {
  const value = cap(overrides);
  return {
    assetId: value.assetId, maxPrincipalAtoms: value.maxPrincipalAtoms,
    maxNetworkFeeAtoms: value.maxNetworkFeeAtoms, maxProtocolFeeAtoms: value.maxProtocolFeeAtoms,
    maxSlippageAtoms: value.maxSlippageAtoms, maxMarginAtoms: value.maxMarginAtoms,
    maxRecoveryAtoms: value.maxRecoveryAtoms, maxLossAtoms: value.maxLossAtoms,
  };
}

function capPolicy(overrides: Partial<OperationCapPolicyInput> = {}): OperationCapPolicyInput {
  return {
    schemaVersion: 1, policyVersion: 1, environment: 'testnet', caps: [cap()],
    aggregateAssetCaps: [aggregateCap()],
    aggregateAccountCaps: [
      { ...aggregateCap(), accountCommitment: sourceAccount },
      { ...aggregateCap(), accountCommitment: destinationAccount },
    ],
    ...overrides,
  };
}

function operation(overrides: Partial<FundedOperationManifestInput> = {}): FundedOperationManifestInput {
  return {
    ...cap({ maxPrincipalAtoms: 900_000n, maxNetworkFeeAtoms: 900n, maxProtocolFeeAtoms: 9_000n,
      maxSlippageAtoms: 19_000n, maxMarginAtoms: 400_000n, maxRecoveryAtoms: 90_000n, maxLossAtoms: 40_000n }),
    schemaVersion: 1, manifestVersion: 1, environment: 'testnet', operationId: 'operation:one',
    sourceAccountCommitment: sourceAccount, destinationAccountCommitment: destinationAccount,
    unsignedPayloadHash: hash(23), runtimeCodeHash: hash(7), configurationManifestHash: hash(8),
    authorityInventoryVersion: 1, authorityInventoryHash: authorityInventoryHash(inventory()),
    signerRoleIds: ['role:executor'],
    approverRoleCommitments: [{ roleId: 'role:approver', identityCommitment: hash(18) }],
    allowedActions: ['EXECUTE', 'RECOVER'],
    prerequisites: ['DOMAIN_QUALIFIED', 'ADAPTER_QUALIFIED', 'ACCOUNT_BALANCE_CONFIRMED', 'ALLOWANCE_CONFIRMED', 'SIMULATION_PASSED', 'RECOVERY_PROVEN'],
    stopConditions: ['PRINCIPAL_CAP_REACHED', 'FEE_CAP_REACHED', 'SLIPPAGE_CAP_REACHED', 'LOSS_CAP_REACHED', 'STALE_OBSERVATION', 'DEPENDENCY_UNAVAILABLE', 'RECONCILIATION_FAILED'],
    simulationEvidenceHash: hash(24), recoverabilityEvidenceHash: hash(25),
    validFromUnit: 'EVM_UNIX_SECONDS', validFromValue: 100n,
    validUntilUnit: 'EVM_UNIX_SECONDS', validUntilValue: 200n,
    incidentOwnerRoleId: 'role:incident', mainnetAuthorizationStatus: 'NOT_AUTHORIZED', ...overrides,
  };
}

function findings(overrides: Partial<SecurityFindingSummaryInput> = {}): SecurityFindingSummaryInput {
  return {
    schemaVersion: 1, registerVersion: 1,
    findings: [{ findingId: 'finding:none-observed', severity: 'INFORMATIONAL', status: 'OPEN', evidenceHash: hash(26) }],
    reviewAttestation: {
      reviewScopeHash: releaseHash, reviewerRoleId: 'role:reviewer', reviewerIdentityCommitment: hash(17),
      result: 'PASS', environment: 'testnet', completedAtUnit: 'EVM_UNIX_SECONDS', completedAtValue: 120n,
      expiresAtUnit: 'EVM_UNIX_SECONDS', expiresAtValue: 190n, signatureCommitment: hash(27),
    },
    ...overrides,
  };
}

function evidence(operationInput = operation()): readonly ReadinessEvidenceInput[] {
  const manifestHash = fundedOperationManifestHash(operationInput);
  const kinds = ['BUILD', 'FOCUSED_TESTS', 'DEPLOYMENT_DRY_RUN', 'AUTHORITY_REVIEW', 'INCIDENT_RUNBOOK',
    'MONITORING', 'RECOVERY_DRILL', 'SIGNER_INVENTORY', 'STOP_CONDITION_DRILL', 'RECONCILIATION'] as const;
  return kinds.map((kind, index) => ({
    kind, releaseHash, fundedOperationManifestHash: manifestHash, reviewerRoleId: 'role:approver',
    reviewerIdentityCommitment: hash(18), result: 'PASS', environment: 'testnet',
    observedAtUnit: 'EVM_UNIX_SECONDS', observedAtValue: 120n,
    expiresAtUnit: 'EVM_UNIX_SECONDS', expiresAtValue: 190n, signatureCommitment: hash(40 + index),
  }));
}

function decision(overrides: Partial<ReadinessDecisionInput> = {}): ReadinessDecisionInput {
  const fundedOperation = operation();
  return {
    schemaVersion: 1, decisionVersion: 1, environment: 'testnet', releaseHash,
    evaluatedAtUnit: 'EVM_UNIX_SECONDS', evaluatedAtValue: 150n,
    authorityInventory: inventory(), capPolicy: capPolicy(), fundedOperations: [fundedOperation],
    findingSummary: findings(), evidence: evidence(fundedOperation), ...overrides,
  };
}

const zeroBudget = (): OperationBudgetInput => ({
  principalAtoms: 0n, networkFeeAtoms: 0n, protocolFeeAtoms: 0n, slippageAtoms: 0n,
  marginAtoms: 0n, recoveryAtoms: 0n, lossAtoms: 0n,
});

function ledger(overrides: Partial<OperationLedgerRecordInput> = {}): OperationLedgerRecordInput {
  return {
    schemaVersion: 1, ledgerVersion: 1, operationId: 'operation:one',
    fundedOperationManifestHash: fundedOperationManifestHash(operation()),
    sourceAccountCommitment: sourceAccount, destinationAccountCommitment: destinationAccount,
    assetId: 'asset:usdc', state: 'RESERVED',
    reserved: { ...zeroBudget(), principalAtoms: 100n, networkFeeAtoms: 10n },
    consumed: zeroBudget(), reconciled: zeroBudget(), released: zeroBudget(), ...overrides,
  };
}

describe('readiness policy canonical identity', () => {
  test('canonical inventory ordering and readiness hash are stable', () => {
    const normal = inventory();
    const reversed = inventory({ roles: [...normal.roles].reverse(), forbiddenCollisions: [...normal.forbiddenCollisions].reverse() });
    assert.equal(toHex(authorityInventoryHash(normal)), toHex(authorityInventoryHash(reversed)));
    assert.equal(toHex(readinessDecisionHash(decision())), 'a343b5068b5091d9968e4fca1aadf168fc0bff45282af5109545df4b371e93a9');
  });
});

describe('readiness policy validation', () => {
  test('bounds, duplicate scopes, and forbidden authority collisions reject', () => {
    assert.throws(() => operationCapPolicy(capPolicy({ policyVersion: 0 })), MalformedInputError);
    assert.throws(() => operationCapPolicy(capPolicy({ caps: [cap({ maxPrincipalAtoms: 0n })] })), MalformedInputError);
    assert.doesNotThrow(() => operationCapPolicy(capPolicy({ caps: [cap({ maxPrincipalAtoms: U128_MAX })] })));
    assert.throws(() => operationCapPolicy(capPolicy({ caps: [cap({ maxPrincipalAtoms: U128_MAX + 1n })] })), RangeViolationError);
    assert.throws(() => operationCapPolicy(capPolicy({ caps: [cap(), cap()] })), DuplicateElementError);
    const base = inventory();
    const roles = [...base.roles];
    roles[3] = { ...roles[3]!, publicIdentityCommitment: hash(5) };
    assert.throws(() => authorityInventory(inventory({ roles })), MalformedInputError);
  });

  test('operation IDs, windows, prerequisites, and aggregate caps gate readiness', () => {
    assert.throws(() => fundedOperationManifest(operation({ validUntilValue: 100n })), MalformedInputError);
    assert.throws(() => readinessDecision(decision({ fundedOperations: [operation(), operation()] })), DuplicateElementError);
    const missing = operation({ prerequisites: ['DOMAIN_QUALIFIED'] });
    assert.equal(readinessDecision(decision({ fundedOperations: [missing], evidence: evidence(missing) })).status, 'NOT_READY');
    const overCap = operation({ maxNetworkFeeAtoms: 1_001n });
    assert.equal(readinessDecision(decision({ fundedOperations: [overCap], evidence: evidence(overCap) })).status, 'NOT_READY');
    const first = operation({ maxPrincipalAtoms: 600_000n });
    const second = operation({ operationId: 'operation:two', unsignedPayloadHash: hash(29), maxPrincipalAtoms: 600_000n });
    assert.equal(readinessDecision(decision({
      fundedOperations: [first, second],
      evidence: [...evidence(first), ...evidence(second)],
    })).status, 'NOT_READY');
  });

  test('security review and signed evidence gate READY', () => {
    assert.throws(() => securityFindingSummary(findings({ findings: [] })), MalformedInputError);
    assert.throws(() => securityFindingSummary(findings({ findings: [{ findingId: 'finding:fixed', severity: 'HIGH', status: 'RESOLVED', evidenceHash: hash(31) }] })), MalformedInputError);
    assert.equal(readinessDecision(decision()).status, 'READY');
    assert.equal(readinessDecision(decision({ evidence: evidence().slice(1) })).status, 'NOT_READY');
    const closed = findings({ findings: [{ findingId: 'finding:fixed', severity: 'HIGH', status: 'RESOLVED', evidenceHash: hash(31), closureEvidenceHash: hash(32) }] });
    assert.equal(readinessDecision(decision({ findingSummary: closed })).status, 'READY');
  });
});

describe('durable operation ledger', () => {
  test('reserve, consume, reconcile, and release preserve accounting', () => {
    const reserved = ledger();
    const spent = { ...zeroBudget(), principalAtoms: 60n, networkFeeAtoms: 5n };
    const consumed = ledger({ ledgerVersion: 2, state: 'CONSUMED', consumed: spent, previousRecordHash: operationLedgerRecordHash(reserved) });
    assert.equal(assertOperationLedgerTransition(reserved, consumed).state, 'CONSUMED');
    const reconciled = ledger({ ledgerVersion: 3, state: 'RECONCILED', consumed: spent, reconciled: spent, previousRecordHash: operationLedgerRecordHash(consumed) });
    assert.equal(assertOperationLedgerTransition(consumed, reconciled).state, 'RECONCILED');
    const released = ledger({ ledgerVersion: 4, state: 'RELEASED', consumed: spent, reconciled: spent,
      released: { ...zeroBudget(), principalAtoms: 40n, networkFeeAtoms: 5n }, previousRecordHash: operationLedgerRecordHash(reconciled) });
    assert.equal(assertOperationLedgerTransition(reconciled, released).state, 'RELEASED');
  });

  test('over-consumption and invalid release conservation reject', () => {
    assert.throws(() => operationLedgerRecord(ledger({ ledgerVersion: 2, state: 'CONSUMED',
      consumed: { ...zeroBudget(), principalAtoms: 101n }, previousRecordHash: hash(33) })), MalformedInputError);
    assert.throws(() => operationLedgerRecord(ledger({ ledgerVersion: 2, state: 'RELEASED',
      released: { ...zeroBudget(), principalAtoms: 99n, networkFeeAtoms: 10n }, previousRecordHash: hash(33) })), MalformedInputError);
  });
});

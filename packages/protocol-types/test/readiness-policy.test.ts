import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  authorityInventory,
  authorityInventoryHash,
  domainRef,
  fundedOperationManifest,
  operationCapPolicy,
  readinessDecision,
  readinessDecisionHash,
  securityFindingSummary,
  toHex,
  versionedManifestRef,
  type AuthorityInventoryInput,
  type FundedOperationManifestInput,
  type OperationCapInput,
  type OperationCapPolicyInput,
  type ReadinessDecisionInput,
  type ReadinessEvidenceInput,
  type SecurityFindingSummaryInput,
} from '../src/index.js';

const U128_MAX = (1n << 128n) - 1n;
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const domain = domainRef('domain:test', 1, hash(1));
const template = versionedManifestRef('template:cash-carry', 1, hash(2));

function inventory(overrides: Partial<AuthorityInventoryInput> = {}): AuthorityInventoryInput {
  return {
    schemaVersion: 1,
    inventoryVersion: 1,
    environment: 'testnet',
    roles: [
      {
        roleId: 'role:incident',
        authorityClass: 'INCIDENT_OWNER',
        publicIdentityCommitment: hash(3),
        custodyPolicyHash: hash(4),
      },
      {
        roleId: 'role:executor',
        authorityClass: 'EXECUTION_SIGNER',
        publicIdentityCommitment: hash(5),
        custodyPolicyHash: hash(6),
      },
    ],
    ...overrides,
  };
}

function cap(overrides: Partial<OperationCapInput> = {}): OperationCapInput {
  return {
    domain,
    template,
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    quoteMode: 'EXECUTION_COMMITMENT',
    sizeCohort: 'cohort:small',
    assetId: 'asset:usdc',
    maxAssetMovementAtoms: 1_000_000n,
    maxFeeAtoms: 10_000n,
    maxMarginAtoms: 500_000n,
    maxRecoveryAtoms: 100_000n,
    ...overrides,
  };
}

function capPolicy(overrides: Partial<OperationCapPolicyInput> = {}): OperationCapPolicyInput {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    environment: 'testnet',
    caps: [cap()],
    ...overrides,
  };
}

function operation(overrides: Partial<FundedOperationManifestInput> = {}): FundedOperationManifestInput {
  return {
    ...cap({
      maxAssetMovementAtoms: 900_000n,
      maxFeeAtoms: 9_000n,
      maxMarginAtoms: 400_000n,
      maxRecoveryAtoms: 90_000n,
    }),
    schemaVersion: 1,
    manifestVersion: 1,
    environment: 'testnet',
    runtimeCodeHash: hash(7),
    configurationManifestHash: hash(8),
    authorityInventoryVersion: 1,
    authorityInventoryHash: authorityInventoryHash(inventory()),
    signerRoleIds: ['role:executor'],
    allowedActions: ['EXECUTE', 'RECOVER'],
    validFromUnit: 'EVM_UNIX_SECONDS',
    validFromValue: 100n,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: 200n,
    incidentOwnerRoleId: 'role:incident',
    mainnetAuthorizationStatus: 'NOT_AUTHORIZED',
    ...overrides,
  };
}

function findings(overrides: Partial<SecurityFindingSummaryInput> = {}): SecurityFindingSummaryInput {
  return {
    schemaVersion: 1,
    registerVersion: 1,
    findings: [],
    ...overrides,
  };
}

function evidence(): ReadonlyArray<ReadinessEvidenceInput> {
  return [
    { kind: 'BUILD', commitment: hash(10) },
    { kind: 'FOCUSED_TESTS', commitment: hash(11) },
    { kind: 'DEPLOYMENT_DRY_RUN', commitment: hash(12) },
    { kind: 'AUTHORITY_REVIEW', commitment: hash(13) },
    { kind: 'INCIDENT_RUNBOOK', commitment: hash(14) },
  ];
}

function decision(overrides: Partial<ReadinessDecisionInput> = {}): ReadinessDecisionInput {
  return {
    schemaVersion: 1,
    decisionVersion: 1,
    environment: 'testnet',
    evaluatedAtUnit: 'EVM_UNIX_SECONDS',
    evaluatedAtValue: 150n,
    authorityInventory: inventory(),
    capPolicy: capPolicy(),
    fundedOperations: [operation()],
    findingSummary: findings(),
    evidence: evidence(),
    ...overrides,
  };
}

describe('readiness policy canonical identity', () => {
  test('canonical hashes are stable across unordered authority input', () => {
    const normal = inventory();
    const reversed = inventory({ roles: [...normal.roles].reverse() });
    assert.equal(toHex(authorityInventoryHash(normal)), toHex(authorityInventoryHash(reversed)));
    assert.equal(
      toHex(readinessDecisionHash(decision())),
      '4b4df8be5faad82e86f76b10de44c4484305d6ac912d81a61a718024589c1e51',
    );
  });
});

describe('readiness policy validation', () => {
  test('zero, overflow, and exact u128 boundary are enforced', () => {
    assert.throws(() => operationCapPolicy(capPolicy({ policyVersion: 0 })), MalformedInputError);
    assert.throws(
      () => operationCapPolicy(capPolicy({ caps: [cap({ maxAssetMovementAtoms: 0n })] })),
      MalformedInputError,
    );
    assert.doesNotThrow(() => operationCapPolicy(capPolicy({ caps: [cap({ maxAssetMovementAtoms: U128_MAX })] })));
    assert.throws(
      () => operationCapPolicy(capPolicy({ caps: [cap({ maxAssetMovementAtoms: U128_MAX + 1n })] })),
      RangeViolationError,
    );
  });

  test('duplicate roles and duplicate complete cap scopes reject', () => {
    const role = inventory().roles[0] as AuthorityInventoryInput['roles'][number];
    assert.throws(() => authorityInventory(inventory({ roles: [role, role] })), DuplicateElementError);
    assert.throws(() => operationCapPolicy(capPolicy({ caps: [cap(), cap()] })), DuplicateElementError);
  });

  test('validity windows increase and an expired operation is not ready', () => {
    assert.throws(
      () => fundedOperationManifest(operation({ validUntilValue: 100n })),
      MalformedInputError,
    );
    assert.equal(readinessDecision(decision({ evaluatedAtValue: 200n })).status, 'NOT_READY');
  });

  test('open critical or high findings block readiness', () => {
    const findingSummary = findings({
      findings: [{
        findingId: 'finding:critical',
        severity: 'CRITICAL',
        status: 'OPEN',
        evidenceHash: hash(15),
      }],
    });
    assert.equal(securityFindingSummary(findingSummary).hasZeroOpenCriticalOrHigh, false);
    assert.equal(readinessDecision(decision({ findingSummary })).status, 'NOT_READY');
  });

  test('ready is computed only when evidence, roles, caps, validity, and findings pass', () => {
    assert.equal(readinessDecision(decision()).status, 'READY');
    assert.equal(readinessDecision(decision({ evidence: evidence().slice(1) })).status, 'NOT_READY');
    assert.equal(
      readinessDecision(decision({ fundedOperations: [operation({ signerRoleIds: ['role:missing'] })] })).status,
      'NOT_READY',
    );
    assert.equal(
      readinessDecision(decision({ fundedOperations: [operation({ maxFeeAtoms: 10_001n })] })).status,
      'NOT_READY',
    );
    assert.equal(
      readinessDecision(decision({ fundedOperations: [operation({ authorityInventoryHash: hash(16) })] })).status,
      'NOT_READY',
    );
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  authorityInventory,
  domainRef,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type AuthorityRole,
  type ReadinessDecision,
} from '@naryx/protocol-types';
import {
  DependencyIncidentFileStore,
  applyDependencyTrigger,
  createDependencyIncidentJournal,
  dependencyScopeHash,
  restoreDependencyScope,
  type DependencyIncidentJournal,
  type DependencyScopeInput,
  type QualificationEvidenceInput,
} from '../src/dependency-incident-engine.js';

const nowMs = 1_000_000n;
const scope: DependencyScopeInput = {
  scopeId: 'hypercore-testnet-cash-carry-small',
  domain: domainRef('hypercore:testnet', 1, '11'.repeat(32)),
  template: versionedManifestRef('cash-carry-v1', 1, '12'.repeat(32)),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  quoteMode: 'FIRM_ONCHAIN',
  sizeCohort: 'small',
};

const readyDecision = {
  schemaVersion: 1,
  decisionVersion: 7,
  environment: protocolId('testnet'),
  releaseHash: manifestHash('24'.repeat(32)),
  evaluatedAt: { unit: 'HYPERLIQUID_UNIX_MILLISECONDS', value: nowMs },
  authorityInventoryHash: manifestHash('20'.repeat(32)),
  capPolicyHash: manifestHash('21'.repeat(32)),
  fundedOperationHashes: [manifestHash('22'.repeat(32))],
  findingSummaryHash: manifestHash('23'.repeat(32)),
  evidence: [],
  status: 'READY',
} as ReadinessDecision;

function evidence(
  suffix: string,
  overrides: Partial<QualificationEvidenceInput> = {},
): QualificationEvidenceInput {
  return {
    scopeHash: dependencyScopeHash(scope),
    readinessDecision: readyDecision,
    readinessDecisionCommitment: `${suffix.padStart(2, '0')}`.repeat(32),
    evidenceCommitment: `${(Number(suffix) + 40).toString(16).padStart(2, '0')}`.repeat(32),
    observedAtMs: nowMs,
    validUntilMs: nowMs + 10_000n,
    exitSafe: true,
    ...overrides,
  };
}

function journal(): DependencyIncidentJournal {
  return createDependencyIncidentJournal(scope, evidence('01'), nowMs + 1n);
}

function reviewer(
  roleId: string,
  authorityClass: 'RISK_ADMIN' | 'INCIDENT_OWNER',
  commitmentByte: string,
): AuthorityRole {
  return authorityInventory({
    schemaVersion: 1,
    inventoryVersion: 1,
    environment: 'testnet',
    roles: [{
      roleId,
      authorityClass,
      publicIdentityCommitment: commitmentByte.repeat(32),
      custodyPolicyHash: '55'.repeat(32),
    }],
    forbiddenCollisions: [
      { leftClass: 'INCIDENT_OWNER', rightClass: 'SECURITY_REVIEWER', forbidIdentityCollision: true, forbidCustodyCollision: true },
    ],
  }).roles[0]!;
}

const riskReviewer = reviewer('risk-reviewer', 'RISK_ADMIN', '31');
const incidentReviewer = reviewer('incident-reviewer', 'INCIDENT_OWNER', '32');

test('code and authority drift fail closed into quarantine', () => {
  const codeDrift = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'CODE_DRIFT',
    evidence: evidence('02'),
    occurredAtMs: nowMs + 2n,
  });
  assert.equal(codeDrift.state, 'QUARANTINED');
  assert.equal(codeDrift.entryAllowed, false);
  assert.equal(codeDrift.exitAllowed, true);
  assert.equal(codeDrift.receipts[0]!.trigger, 'CODE_DRIFT');
  assert.match(codeDrift.receipts[0]!.receiptHash, /^0x[0-9a-f]{64}$/);

  const authorityDrift = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'AUTHORITY_DRIFT',
    evidence: evidence('03', { exitSafe: false }),
    occurredAtMs: nowMs + 2n,
  });
  assert.equal(authorityDrift.state, 'QUARANTINED');
  assert.equal(authorityDrift.exitAllowed, false);
});

test('preserves exits when qualification evidence says exit is safe', () => {
  for (const trigger of ['STALE_EVIDENCE', 'ORACLE_DIVERGENCE', 'LIQUIDITY_LOSS',
    'RECOVERY_UNAVAILABLE', 'CAP_EXHAUSTION'] as const) {
    const next = applyDependencyTrigger(journal(), {
      expectedRevision: 0n,
      trigger,
      evidence: evidence('04'),
      occurredAtMs: nowMs + 2n,
    });
    assert.equal(next.entryAllowed, false, trigger);
    assert.equal(next.exitAllowed, true, trigger);
  }
});

test('unsafe dependency evidence pauses entries and exits', () => {
  const paused = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'ORACLE_DIVERGENCE',
    evidence: evidence('05', { exitSafe: false }),
    occurredAtMs: nowMs + 2n,
  });
  assert.equal(paused.state, 'ALL_PAUSED');
  assert.equal(paused.entryAllowed, false);
  assert.equal(paused.exitAllowed, false);
});

test('durable journal survives restart with its receipt chain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'naryx-incident-'));
  try {
    const path = join(directory, 'journal.json');
    const store = new DependencyIncidentFileStore(path);
    const paused = applyDependencyTrigger(journal(), {
      expectedRevision: 0n,
      trigger: 'SIGNER_FENCING',
      evidence: evidence('06'),
      occurredAtMs: nowMs + 2n,
    });
    await store.save(paused);
    const restarted = await new DependencyIncidentFileStore(path).load();
    assert.equal(restarted.revision, 1n);
    assert.equal(restarted.state, 'QUARANTINED');
    assert.equal(restarted.receipts[0]!.receiptHash, paused.receipts[0]!.receiptHash);
    assert.equal(restarted.latestEvidence.evidenceCommitment, paused.latestEvidence.evidenceCommitment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects restoration self-approval', () => {
  const paused = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'CAP_EXHAUSTION',
    evidence: evidence('07'),
    occurredAtMs: nowMs + 2n,
  });
  assert.throws(() => restoreDependencyScope(paused, {
    expectedRevision: 1n,
    evidence: evidence('08', { observedAtMs: nowMs + 3n }),
    reviewers: [
      { role: riskReviewer, approvedAtMs: nowMs + 4n },
      { role: riskReviewer, approvedAtMs: nowMs + 4n },
    ],
    occurredAtMs: nowMs + 5n,
  }), /self-approval/);
});

test('rejects stale restoration evidence', () => {
  const paused = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'LIQUIDITY_LOSS',
    evidence: evidence('09'),
    occurredAtMs: nowMs + 2n,
  });
  assert.throws(() => restoreDependencyScope(paused, {
    expectedRevision: 1n,
    evidence: evidence('10', { observedAtMs: nowMs + 3n, validUntilMs: nowMs + 4n }),
    reviewers: [
      { role: riskReviewer, approvedAtMs: nowMs + 3n },
      { role: incidentReviewer, approvedAtMs: nowMs + 3n },
    ],
    occurredAtMs: nowMs + 4n,
  }), /stale/);
});

test('restores only with fresh same-scope evidence and two distinct reviewers', () => {
  const paused = applyDependencyTrigger(journal(), {
    expectedRevision: 0n,
    trigger: 'RECOVERY_UNAVAILABLE',
    evidence: evidence('11'),
    occurredAtMs: nowMs + 2n,
  });
  const restored = restoreDependencyScope(paused, {
    expectedRevision: 1n,
    evidence: evidence('12', { observedAtMs: nowMs + 3n }),
    reviewers: [
      { role: riskReviewer, approvedAtMs: nowMs + 4n },
      { role: incidentReviewer, approvedAtMs: nowMs + 4n },
    ],
    occurredAtMs: nowMs + 5n,
  });
  assert.equal(restored.state, 'ACTIVE');
  assert.equal(restored.entryAllowed, true);
  assert.equal(restored.exitAllowed, true);
  assert.equal(restored.receipts.length, 2);
  assert.equal(restored.receipts[1]!.previousReceiptHash, restored.receipts[0]!.receiptHash);
  assert.equal(restored.receipts[1]!.approvers.length, 2);
  assert.notEqual(
    restored.receipts[1]!.approvers[0]!.reviewerRoleCommitment,
    restored.receipts[1]!.approvers[1]!.reviewerRoleCommitment,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainnetFundsManifestHash, mainnetOperationGate, toHex, type MainnetFundsManifestInput } from '../src/index.js';

const operation = {
  operationId: 'canary-entry',
  chain: 'eip155:8453',
  action: 'package-entry',
  signerRole: 'strategy-owner',
  sourceAccount: 'strategy-account',
  destinationOrContract: 'package-verifier',
  assetId: 'usdc',
  maximumPrincipalAtoms: 100_000_000n,
  maximumNetworkFeeAtoms: 2_000_000n,
  maximumProtocolFeeAtoms: 0n,
  maximumSlippageAtoms: 500_000n,
  maximumCapitalLockedAtoms: 100_000_000n,
  maximumRecoveryTurnoverAtoms: 50_000_000n,
  maximumWorstCaseLossAtoms: 5_000_000n,
  balanceRequiredBeforeAtoms: 160_000_000n,
  expectedBalanceAfterAtoms: 0n,
  recoverable: true,
  simulationEvidenceHashes: ['a1'.repeat(32)],
  prerequisiteGapIds: ['G-004'],
  payloadHash: 'b1'.repeat(32),
};
const manifest: MainnetFundsManifestInput = {
  manifestVersion: 1,
  environment: 'mainnet-canary',
  chainIdentity: 'eip155:8453',
  releaseCommit: 'c'.repeat(40),
  buildArtifactHashes: ['d1'.repeat(32)],
  dependencyManifestHash: 'e1'.repeat(32),
  expiresAtMs: 2_000n,
  approverIds: ['approver-a', 'approver-b'],
  operations: [operation],
  aggregateCapsByAsset: [{ assetId: 'usdc', maximumAtoms: 152_500_000n }],
  incidentOwner: 'incident-lead',
  stopConditionIds: ['loss-above-cap'],
};
const request = { operationId: 'canary-entry', payloadHash: 'b1'.repeat(32), principalAtoms: 100_000_000n, networkFeeAtoms: 1_000_000n, nowMs: 1_000n };
const approved = { verifiedApproverIds: ['approver-a', 'approver-b'], userAuthorizedManifestHash: mainnetFundsManifestHash(manifest), unresolvedGapIds: [], triggeredStopConditionIds: [] };

test('the manifest caps every asset and needs two distinct approvers', () => {
  assert.throws(() => mainnetFundsManifestHash({ ...manifest, aggregateCapsByAsset: [{ assetId: 'usdc', maximumAtoms: 152_499_999n }] }), /more than its aggregate cap/);
  assert.throws(() => mainnetFundsManifestHash({ ...manifest, approverIds: ['approver-a'] }), /2 to 64/);
  assert.throws(() => mainnetFundsManifestHash({ ...manifest, aggregateCapsByAsset: [] }), /no aggregate cap/);
  assert.notEqual(toHex(mainnetFundsManifestHash({ ...manifest, operations: [{ ...operation, payloadHash: 'b2'.repeat(32) }] })), toHex(mainnetFundsManifestHash(manifest)));
});

test('the gate allows only an exact, authorized, approved, in-cap operation', () => {
  assert.deepEqual(mainnetOperationGate(manifest, request, approved), { allowed: true });
  const refused = (change: object, context: object = {}) => {
    const result = mainnetOperationGate(manifest, { ...request, ...change }, { ...approved, ...context });
    return result.allowed ? [] : result.reasons;
  };
  assert.deepEqual(refused({}, { userAuthorizedManifestHash: undefined }), ['USER_AUTHORIZATION_MISSING']);
  assert.deepEqual(refused({}, { verifiedApproverIds: ['approver-a', 'approver-a', 'outsider'] }), ['APPROVALS_INSUFFICIENT']);
  assert.deepEqual(refused({ payloadHash: 'b2'.repeat(32), principalAtoms: 100_000_001n }), ['PAYLOAD_CHANGED', 'PRINCIPAL_ABOVE_CAP']);
  assert.deepEqual(refused({ nowMs: 2_000n }), ['MANIFEST_EXPIRED']);
  assert.deepEqual(refused({}, { unresolvedGapIds: ['G-004'], triggeredStopConditionIds: ['loss-above-cap'] }), ['PREREQUISITE_OPEN', 'STOP_CONDITION_TRIGGERED']);
  assert.deepEqual(refused({ operationId: 'unlisted' }), ['OPERATION_UNKNOWN']);
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  assertPackageLifecycleTransition,
  domainRef,
  packageLifecycleEventIntent,
  packageLifecycleEventIntentBytes,
  packageLifecycleEventIntentCommitment,
  packageLifecycleReceipt,
  packageLifecycleReceiptBytes,
  packageLifecycleReceiptHash,
  versionedManifestRef,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);

function baseIntent(overrides = {}) {
  return {
    version: 1,
    domain: domainRef('svm:testnet', 1, hash('1')),
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageId: 'pkg-001',
    packageCommitment: hash('4'),
    attemptId: 'attempt-001',
    eventId: 'event-001',
    expectedRevision: 0n,
    nextState: 'PACKAGE_CREATED',
    evidenceGrade: 'LOCAL_RECORDED',
    onchainEnforced: false,
    evidenceSource: versionedManifestRef('evidence-schema-v1', 1, hash('5')),
    evidenceCommitment: hash('6'),
    ...overrides,
  } as const;
}

describe('package lifecycle canonical hashing', () => {
  test('intent commitment and receipt hash are deterministic and separated', () => {
    const intent = baseIntent();
    const otherEvent = baseIntent({ eventId: 'event-002' });
    assert.equal(
      packageLifecycleEventIntentBytes(intent).length > 0,
      true,
    );
    const commitment = packageLifecycleEventIntentCommitment(intent);
    assert.equal(commitment.length, 32);
    assert.deepEqual(packageLifecycleEventIntentCommitment(intent), commitment);
    assert.notDeepEqual(
      packageLifecycleEventIntentCommitment(otherEvent),
      commitment,
    );

    const receiptInput = {
      version: 1,
      domain: intent.domain,
      settlementClass: intent.settlementClass,
      packageId: intent.packageId,
      packageCommitment: intent.packageCommitment,
      attemptId: intent.attemptId,
      eventId: intent.eventId,
      revision: 1n,
      nextState: 'PACKAGE_CREATED',
      observedAtUnixMilliseconds: 1_700_000_000_000n,
      evidenceGrade: intent.evidenceGrade,
      onchainEnforced: intent.onchainEnforced,
      evidenceSource: intent.evidenceSource,
      evidenceCommitment: intent.evidenceCommitment,
    } as const;
    const receipt = packageLifecycleReceipt(receiptInput);
    assert.equal(receipt.revision, 1n);
    assert.equal(packageLifecycleReceiptBytes(receiptInput).length > 0, true);
    const receiptHash = packageLifecycleReceiptHash(receiptInput);
    assert.equal(receiptHash.length, 32);
    assert.deepEqual(packageLifecycleReceiptHash(receipt), receiptHash);
    assert.notDeepEqual(receiptHash, commitment);

    const flipped = packageLifecycleReceipt({ ...receiptInput, onchainEnforced: true });
    assert.equal(flipped.onchainEnforced, true);
    assert.notDeepEqual(packageLifecycleReceiptHash(flipped), receiptHash);

    const second = packageLifecycleReceipt({
      ...receiptInput,
      eventId: 'event-002',
      revision: 2n,
      priorState: 'PACKAGE_CREATED',
      previousReceiptHash: receiptHash,
      nextState: 'ENTRY_PREPARED',
      observedAtUnixMilliseconds: 1_700_000_000_007n,
    });
    assert.equal(second.revision, 2n);
    assert.equal(second.priorState, 'PACKAGE_CREATED');
    assert.deepEqual(packageLifecycleReceipt(second), second);
    assert.equal(packageLifecycleEventIntent(intent).expectedRevision, 0n);
  });

  test('the closest skipped transition and a terminal replay are rejected', () => {
    assert.throws(
      () => assertPackageLifecycleTransition('PACKAGE_CREATED', 'ENTRY_SUBMITTED'),
      MalformedInputError,
    );
    assert.throws(
      () =>
        packageLifecycleReceipt({
          version: 1,
          domain: domainRef('svm:testnet', 1, hash('1')),
          settlementClass: 'ATOMIC_POSTCONDITION',
          packageId: 'pkg-001',
          packageCommitment: hash('4'),
          attemptId: 'attempt-001',
          eventId: 'event-009',
          revision: 2n,
          priorState: 'CLOSED',
          previousReceiptHash: hash('7'),
          nextState: 'OPEN',
          observedAtUnixMilliseconds: 1_700_000_000_001n,
          evidenceGrade: 'LOCAL_RECORDED',
          onchainEnforced: false,
          evidenceSource: versionedManifestRef('evidence-schema-v1', 1, hash('5')),
          evidenceCommitment: hash('6'),
        }),
      MalformedInputError,
    );
  });
});

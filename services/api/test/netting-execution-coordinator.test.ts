import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  domainRef,
  netObligations,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  toHex,
  versionedManifestRef,
  type NettingExternalExecutionEvidence,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  NettingExecutionCoordinator,
  type NettingExternalExecutionStorePort,
  type PreparedNettingBatch,
} from '../src/index.js';

const id = (n: number): string => n.toString(16).padStart(64, '0');
const base = assetRef('sol', id(1), 9);
const quote = assetRef('usdc', id(2), 6);
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'sol-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(3),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'sol-perp',
    domain: domainRef('hypercore:testnet', 1, id(4)),
    adapter: { adapterId: 'hypercore-perp', adapterManifestVersion: 1, adapterManifestHash: id(5) },
    venue: versionedManifestRef('hypercore', 1, id(6)),
    market: versionedManifestRef('sol-perp', 1, id(7)),
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer', strategyOrderHash: id(10), packageOrderId: id(11),
  settlementReadinessHash: id(12), legId: 'perp', instrumentId: 'sol-perp',
  signedQuantityAtoms: 10n, limitPriceTicks: 12n, sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'sol-perp',
  validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  validUntilValue: 2_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2n }],
});

class Store implements NettingExternalExecutionStorePort {
  batch: PreparedNettingBatch = Object.freeze({
    status: 'PREPARED',
    proofHashHex: toHex(result.proofHash),
    policy,
    result,
    externalExecutions: Object.freeze([Object.freeze({ intent })]),
    externalExecutionStatus: 'PENDING',
    settlementEvidence: Object.freeze([]),
    settlementStatus: 'AWAITING_FINAL_ALLOCATION',
    packages: Object.freeze([Object.freeze({
      packageOrderIdHex: id(11),
      strategyOrderHashHex: id(10),
      settlementReadinessHashHex: id(12),
    })]),
    recordedAtMs: 1,
  });

  nettingBatch(): PreparedNettingBatch {
    return this.batch;
  }

  recordVerifiedNettingExternalExecutionEvidence(
    evidence: NettingExternalExecutionEvidence,
  ): { readonly evidence: NettingExternalExecutionEvidence; readonly replayed: boolean } {
    this.batch = Object.freeze({
      ...this.batch,
      externalExecutions: Object.freeze([Object.freeze({ intent, evidence })]),
      externalExecutionStatus: evidence.outcome === 'EXACT_FILLED' ? 'EXACT_FILLED' : 'RECOVERY_REQUIRED',
    });
    return Object.freeze({ evidence, replayed: false });
  }
}

test('executes each pending residual once under intent-hash idempotency', async () => {
  const store = new Store();
  const calls: string[] = [];
  const coordinator = new NettingExecutionCoordinator(store, {
    async execute(input) {
      calls.push(input.idempotencyKey);
      return nettingExternalExecutionEvidence({
        version: 1,
        intentHash: input.intent.intentHash,
        outcome: 'EXACT_FILLED',
        filledSignedQuantityAtoms: 10n,
        grossQuoteAtoms: 12n,
        feeQuoteAtoms: 1n,
        submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        submittedAtValue: 1_999n,
        observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        observedAtValue: 2_001n,
        executionReferenceHash: id(20),
        authoritativeEvidenceHash: id(21),
      }, input.intent);
    },
  });
  const first = await coordinator.execute(result.proofHash);
  assert.deepEqual(first.executedIntentHashes, [toHex(intent.intentHash)]);
  assert.equal(first.batch.externalExecutionStatus, 'EXACT_FILLED');
  const replay = await coordinator.execute(result.proofHash);
  assert.deepEqual(replay.executedIntentHashes, []);
  assert.deepEqual(calls, [toHex(intent.intentHash)]);
});

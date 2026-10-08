import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  commitmentHash,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  crossBatchExternalExecutionEvidence,
  crossBatchExternalExecutionIntent,
  domainRef,
  netObligations,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  toHex,
  versionedManifestRef,
  type NettingExternalExecutionEvidence,
  type CrossBatchExternalExecutionEvidence,
  type NettingAllocationExecutionAuthorization,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  NettingExecutionCoordinator,
  NettingExternalExecutionRouter,
  CrossBatchClearingCoordinator,
  NettingAllocationObservationRouter,
  NettingAllocationSettlementCoordinator,
  type NettingAllocationExecutionObservation,
  type NettingAllocationSettlementStorePort,
  type NettingExternalExecutionStorePort,
  type CrossBatchClearingStorePort,
  type PreparedCrossBatchClearing,
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

test('direct residual execution skips intents committed to cross-batch clearing', async () => {
  const store = new Store();
  store.batch = Object.freeze({
    ...store.batch,
    externalExecutions: Object.freeze([Object.freeze({
      intent,
      crossBatchClearingPlanHashHex: id(90),
      crossBatchStatus: 'PENDING' as const,
    })]),
  });
  let calls = 0;
  const result = await new NettingExecutionCoordinator(store, {
    async execute() {
      calls += 1;
      throw new Error('pooled intent must not execute directly');
    },
  }).execute(intent.nettingProofHash);
  assert.equal(calls, 0);
  assert.deepEqual(result.executedIntentHashes, []);
});

test('executes a cross-batch residual once under pooled intent idempotency', async () => {
  const sellResult = netObligations([{
    ownerId: 'seller', strategyOrderHash: id(91), packageOrderId: id(92),
    settlementReadinessHash: id(93), legId: 'perp', instrumentId: 'sol-perp',
    signedQuantityAtoms: -20n, limitPriceTicks: 8n, sequence: 2n,
  }], policy);
  const sellIntent = nettingExternalExecutionIntent(sellResult, policy, {
    instrumentId: 'sol-perp',
    validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    validUntilValue: 2_000n,
    sourceFeeCaps: [{ obligationId: sellResult.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 3n }],
  });
  const clearingPolicy = crossBatchClearingPolicy({
    version: 1,
    policyId: 'hyperliquid-testnet-cross-batch-v1',
    domain: policy.instruments[0]!.domain,
    adapter: policy.instruments[0]!.adapter,
    expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    maximumSourceIntents: 8,
    maximumSourceBatches: 8,
    maximumExpirySpread: 10n,
  });
  const plan = crossBatchClearingPlan([intent, sellIntent], clearingPolicy);
  const pooledIntent = crossBatchExternalExecutionIntent(plan);

  class CrossBatchStore implements CrossBatchClearingStorePort {
    clearing: PreparedCrossBatchClearing = Object.freeze({
      status: 'PENDING',
      policy: clearingPolicy,
      sourceIntents: Object.freeze([intent, sellIntent]),
      plan,
      intent: pooledIntent,
      recordedAtMs: 1,
    });

    crossBatchClearing(): PreparedCrossBatchClearing {
      return this.clearing;
    }

    recordVerifiedCrossBatchExternalExecutionEvidence(
      evidence: CrossBatchExternalExecutionEvidence,
    ): { readonly evidence: CrossBatchExternalExecutionEvidence; readonly replayed: boolean } {
      this.clearing = Object.freeze({ ...this.clearing, status: 'EXACT_FILLED', evidence });
      return Object.freeze({ evidence, replayed: false });
    }
  }

  const store = new CrossBatchStore();
  const calls: string[] = [];
  const coordinator = new CrossBatchClearingCoordinator(store, {
    async execute(input) {
      calls.push(input.idempotencyKey);
      return crossBatchExternalExecutionEvidence({
        version: 1,
        intentHash: input.intent.intentHash,
        outcome: 'EXACT_FILLED',
        filledSignedQuantityAtoms: -10n,
        grossQuoteAtoms: 8n,
        feeQuoteAtoms: 1n,
        submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        submittedAtValue: 1_999n,
        observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        observedAtValue: 2_001n,
        executionReferenceHash: id(94),
        authoritativeEvidenceHash: id(95),
      }, input.intent);
    },
  });
  const first = await coordinator.execute(plan.planHash);
  assert.equal(first.clearing.status, 'EXACT_FILLED');
  assert.equal(first.executedIntentHash, toHex(pooledIntent.intentHash));
  const replay = await coordinator.execute(plan.planHash);
  assert.equal(replay.executedIntentHash, undefined);
  assert.deepEqual(calls, [toHex(pooledIntent.intentHash)]);
});

test('routes residuals to exactly one domain executor and fails closed otherwise', async () => {
  const evidence = nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: 'EXACT_FILLED',
    filledSignedQuantityAtoms: 10n,
    grossQuoteAtoms: 12n,
    feeQuoteAtoms: 1n,
    submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    submittedAtValue: 1_999n,
    observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    observedAtValue: 2_001n,
    executionReferenceHash: id(30),
    authoritativeEvidenceHash: id(31),
  }, intent);
  const calls: string[] = [];
  const router = new NettingExternalExecutionRouter([{
    routeId: 'hypercore:testnet',
    supports: (candidate) => candidate.domain.domainId === 'hypercore:testnet',
    execute: async (input) => {
      calls.push(input.idempotencyKey);
      return evidence;
    },
  }]);
  assert.equal(await router.execute({ intent, idempotencyKey: toHex(intent.intentHash) }), evidence);
  assert.deepEqual(calls, [toHex(intent.intentHash)]);
  const unsupported = { ...intent, domain: domainRef('svm:solana-devnet', 1, id(40)) };
  await assert.rejects(
    router.execute({ intent: unsupported, idempotencyKey: toHex(intent.intentHash) }),
    /no registered execution route/,
  );
});

test('records only authorized allocation observations and reports missing authorizations', async () => {
  const firstAllocationHash = commitmentHash(id(70));
  const secondAllocationHash = commitmentHash(id(71));
  const authorization = {
    authorizationHash: commitmentHash(id(72)),
    allocationReceiptHash: firstAllocationHash,
    domain: domainRef('svm:solana-devnet', 1, id(73)),
  } as NettingAllocationExecutionAuthorization;
  class AllocationStore implements NettingAllocationSettlementStorePort {
    batch = {
      finalAllocationReceipt: {
        allocations: [{ allocationReceiptHash: firstAllocationHash }, { allocationReceiptHash: secondAllocationHash }],
      },
      settlementEvidence: [],
    } as unknown as PreparedNettingBatch;

    nettingBatch(): PreparedNettingBatch {
      return this.batch;
    }

    nettingAllocationExecutionAuthorizations(): readonly NettingAllocationExecutionAuthorization[] {
      return [authorization];
    }

    recordNettingAllocationExecutionObservation(
      observation: NettingAllocationExecutionObservation,
    ): { readonly replayed: boolean } {
      assert.equal(toHex(commitmentHash(observation.authorizationHash)), toHex(authorization.authorizationHash));
      this.batch = {
        ...this.batch,
        settlementEvidence: [{ allocationReceiptHash: firstAllocationHash }],
      } as unknown as PreparedNettingBatch;
      return { replayed: false };
    }
  }
  const store = new AllocationStore();
  const observer = new NettingAllocationObservationRouter([{
    routeId: 'solana-devnet',
    supports: (candidate) => candidate.domain.domainId === 'svm:solana-devnet',
    observe: async ({ authorization: candidate }) => ({
      authorizationHash: candidate.authorizationHash,
      observedAtUnit: 'SOLANA_SLOT',
      observedAtValue: 100n,
      settlementReferenceHash: id(74),
      authoritativeEvidenceHash: id(75),
    }),
  }]);
  const settled = await new NettingAllocationSettlementCoordinator(store, observer).settle(id(76));
  assert.deepEqual(settled.observedAuthorizationHashes, [toHex(authorization.authorizationHash)]);
  assert.deepEqual(settled.pendingAllocationReceiptHashes, [toHex(secondAllocationHash)]);
});

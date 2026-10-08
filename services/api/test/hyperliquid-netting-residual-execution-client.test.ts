import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetRef,
  crossBatchClearingPlan,
  crossBatchClearingPolicy,
  crossBatchExternalExecutionEvidence,
  crossBatchExternalExecutionIntent,
  domainRef,
  netObligations,
  nettingExternalExecutionEvidence,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  API_HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH,
  API_HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH,
  HttpHyperliquidCrossBatchResidualExecutionClient,
  HttpHyperliquidNettingResidualExecutionClient,
  HyperliquidNettingResidualExecutionClientError,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
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
    adapter: {
      adapterId: 'hypercore-perp',
      adapterManifestVersion: 1,
      adapterManifestHash: id(5),
    },
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
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'sol-perp',
  signedQuantityAtoms: 10n,
  limitPriceTicks: 12n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'sol-perp',
  validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  validUntilValue: 2_000n,
  sourceFeeCaps: [{
    obligationId: result.allocations[0]!.obligationId,
    maximumFeeQuoteAtoms: 2n,
  }],
});
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
  executionReferenceHash: id(20),
  authoritativeEvidenceHash: id(21),
}, intent);
const sellResult = netObligations([{
  ownerId: 'seller',
  strategyOrderHash: id(30),
  packageOrderId: id(31),
  settlementReadinessHash: id(32),
  legId: 'perp',
  instrumentId: 'sol-perp',
  signedQuantityAtoms: -20n,
  limitPriceTicks: 8n,
  sequence: 2n,
}], policy);
const sellIntent = nettingExternalExecutionIntent(sellResult, policy, {
  instrumentId: 'sol-perp',
  validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  validUntilValue: 2_000n,
  sourceFeeCaps: [{ obligationId: sellResult.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 3n }],
});
const crossBatchIntent = crossBatchExternalExecutionIntent(crossBatchClearingPlan(
  [intent, sellIntent],
  crossBatchClearingPolicy({
    version: 1,
    policyId: 'hyperliquid-testnet-cross-batch-v1',
    domain: policy.instruments[0]!.domain,
    adapter: policy.instruments[0]!.adapter,
    expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    maximumSourceIntents: 8,
    maximumSourceBatches: 8,
    maximumExpirySpread: 10n,
  }),
));
const crossBatchEvidence = crossBatchExternalExecutionEvidence({
  version: 1,
  intentHash: crossBatchIntent.intentHash,
  outcome: 'EXACT_FILLED',
  filledSignedQuantityAtoms: -10n,
  grossQuoteAtoms: 8n,
  feeQuoteAtoms: 1n,
  submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  submittedAtValue: 1_999n,
  observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  observedAtValue: 2_001n,
  executionReferenceHash: id(33),
  authoritativeEvidenceHash: id(34),
}, crossBatchIntent);

test('execution client submits the canonical intent and verifies returned evidence', async () => {
  const client = new HttpHyperliquidNettingResidualExecutionClient(
    'http://127.0.0.1:8788',
    async (request, init) => {
      assert.equal(String(request),
        `http://127.0.0.1:8788${API_HYPERLIQUID_NETTING_RESIDUAL_EXECUTION_PATH}`);
      assert.equal(init?.method, 'POST');
      const submitted = parseProtocolJson(String(init?.body)) as {
        intent: typeof intent;
        idempotencyKey: string;
      };
      assert.equal(submitted.idempotencyKey, toHex(intent.intentHash));
      assert.deepEqual(submitted.intent.intentHash, intent.intentHash);
      return new Response(stringifyProtocolJson({ version: 1, evidence }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  const received = await client.execute({
    intent,
    idempotencyKey: toHex(intent.intentHash),
  });
  assert.deepEqual(received.evidenceHash, evidence.evidenceHash);
});

test('execution client preserves a nonterminal evidence state', async () => {
  const client = new HttpHyperliquidNettingResidualExecutionClient(
    'http://127.0.0.1:8788',
    async () => new Response(stringifyProtocolJson({
      error: { code: 'EVIDENCE_PENDING', message: 'pending' },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
  );
  await assert.rejects(
    client.execute({ intent, idempotencyKey: toHex(intent.intentHash) }),
    (error: unknown) => error instanceof HyperliquidNettingResidualExecutionClientError
      && error.code === 'EVIDENCE_PENDING',
  );
});

test('cross-batch execution client uses the isolated pooled residual path', async () => {
  const client = new HttpHyperliquidCrossBatchResidualExecutionClient(
    'http://127.0.0.1:8788',
    async (request, init) => {
      assert.equal(String(request),
        `http://127.0.0.1:8788${API_HYPERLIQUID_CROSS_BATCH_RESIDUAL_EXECUTION_PATH}`);
      const submitted = parseProtocolJson(String(init?.body)) as {
        intent: typeof crossBatchIntent;
        idempotencyKey: string;
      };
      assert.equal(submitted.idempotencyKey, toHex(crossBatchIntent.intentHash));
      assert.deepEqual(submitted.intent.clearingPlanHash, crossBatchIntent.clearingPlanHash);
      return new Response(stringifyProtocolJson({ version: 1, evidence: crossBatchEvidence }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  const received = await client.execute({
    intent: crossBatchIntent,
    idempotencyKey: toHex(crossBatchIntent.intentHash),
  });
  assert.deepEqual(received.evidenceHash, crossBatchEvidence.evidenceHash);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainRef,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  toHex,
  toProtocolJson,
  versionedManifestRef,
} from '@naryx/protocol-types';
import {
  HttpNettingBatchPreparationClient,
  NettingBatchParticipant,
  type NettingBatchPreparationPort,
} from '../src/netting-batch-participant.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const policy = nettingPolicyManifest({
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'basis-v1',
  executionClassVersion: 1,
  executionClassManifestHash: id(1),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'sol-perp',
    domain: domainRef('hypercore:testnet', 1, id(2)),
    adapter: adapterRef({ adapterId: 'hypercore', adapterManifestVersion: 1, adapterManifestHash: id(3) }),
    venue: versionedManifestRef('hyperliquid', 1, id(4)),
    market: versionedManifestRef('sol-perp', 1, id(5)),
    quantityAsset: assetRef('sol', id(6), 9),
    quoteAsset: assetRef('usdc', id(7), 6),
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 1n,
    priceTickQuoteAtoms: 1n,
  }],
});

test('validates a prepared batch returned by the loopback API', async () => {
  assert.throws(
    () => new HttpNettingBatchPreparationClient('http://127.example.com:8787'),
    /loopback HTTP origin/,
  );
  const packageOrderId = id(8);
  let requests = 0;
  const client = new HttpNettingBatchPreparationClient('http://127.0.0.1:8787', (async (input, init) => {
    requests += 1;
    assert.equal(String(input), 'http://127.0.0.1:8787/internal/netting/batches/prepare-next');
    assert.equal(init?.method, 'POST');
    return new Response(JSON.stringify(toProtocolJson({
      version: 1,
      status: 'PREPARED',
      proofHashHex: id(9),
      policyHashHex: toHex(nettingPolicyManifestHash(policy)),
      packageOrderIds: [packageOrderId],
      replayed: false,
    })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch);
  const result = await client.prepareNext(policy);
  assert.equal(result.status, 'PREPARED');
  if (result.status === 'PREPARED') assert.deepEqual(result.packageOrderIds, [packageOrderId]);
  assert.equal(requests, 1);
});

test('drains prepared netting batches until the policy becomes idle', async () => {
  let calls = 0;
  const preparation: NettingBatchPreparationPort = {
    async prepareNext() {
      calls += 1;
      return calls < 3
        ? { status: 'PREPARED', proofHashHex: id(10 + calls), policyHashHex: id(20), packageOrderIds: [id(30 + calls)], replayed: false }
        : { status: 'IDLE' };
    },
  };
  await new NettingBatchParticipant({ policies: [policy], preparation }).tick();
  assert.equal(calls, 3);
});

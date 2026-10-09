import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  crossBatchClearingPolicy,
  domainRef,
  toProtocolJson,
} from '@naryx/protocol-types';
import {
  CrossBatchClearingParticipant,
  HttpCrossBatchClearingControlClient,
} from '../src/cross-batch-clearing-participant.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const policy = crossBatchClearingPolicy({
  version: 1,
  policyId: 'hypercore-testnet-cross-batch-v1',
  domain: domainRef('hypercore:testnet', 1, id(1)),
  adapter: adapterRef({
    adapterId: 'hypercore',
    adapterManifestVersion: 1,
    adapterManifestHash: id(2),
  }),
  expiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  maximumSourceIntents: 8,
  maximumSourceBatches: 8,
  maximumExpirySpread: 5_000n,
});

test('prepares and executes authoritative cross-batch clearing through loopback controls', async () => {
  assert.throws(
    () => new HttpCrossBatchClearingControlClient('https://127.0.0.1:8787'),
    /loopback HTTP origin/,
  );
  const planHash = id(3);
  const sourceIntentHashes = [id(4), id(5)];
  const requests: string[] = [];
  let preparations = 0;
  const client = new HttpCrossBatchClearingControlClient('http://127.0.0.1:8787', (async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    assert.equal(init?.method, 'POST');
    if (path.endsWith('/execute')) {
      return new Response(JSON.stringify(toProtocolJson({
        version: 1,
        clearing: {
          status: 'EXACT_FILLED',
          plan: { planHash: new Uint8Array(Buffer.from(planHash, 'hex')) },
        },
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    preparations += 1;
    return new Response(JSON.stringify(toProtocolJson(preparations === 1 ? {
      version: 1,
      status: 'PREPARED',
      planHashHex: planHash,
      policyHashHex: Buffer.from(policy.policyHash).toString('hex'),
      sourceIntentHashes,
      clearingStatus: 'PENDING',
      executionRequired: true,
      replayed: false,
    } : {
      version: 1,
      status: 'IDLE',
    })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch);
  await new CrossBatchClearingParticipant({ policies: [policy], controls: client }).tick();
  assert.deepEqual(requests, [
    '/internal/netting/cross-batch/prepare-next',
    `/internal/netting/cross-batch/${planHash}/execute`,
    '/internal/netting/cross-batch/prepare-next',
  ]);
});

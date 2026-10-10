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
  CrossBatchClearingParticipantError,
  HttpCrossBatchClearingControlClient,
  type CrossBatchClearingControlPort,
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

test('an execution with an unknown outcome is not re-fired until its hold passes, and other policies still clear', async () => {
  const { policyHash: _policyHash, ...fields } = policy;
  const other = crossBatchClearingPolicy({ ...fields, policyId: 'hypercore-testnet-cross-batch-v2' });
  const planHash = id(3);
  const prepared: string[] = [];
  const executed: string[] = [];
  let now = 1_000;
  const controls: CrossBatchClearingControlPort = {
    async prepareNext(input) {
      prepared.push(input.policyId);
      return input.policyId === policy.policyId
        ? {
            status: 'PREPARED', planHashHex: planHash, policyHashHex: Buffer.from(policy.policyHash).toString('hex'),
            sourceIntentHashes: [id(4), id(5)], clearingStatus: 'PENDING', executionRequired: true, replayed: false,
          }
        : { status: 'IDLE' };
    },
    async execute(hash) {
      executed.push(hash);
      throw new CrossBatchClearingParticipantError('UNAVAILABLE', 'cross-batch API request failed');
    },
  };
  const participant = new CrossBatchClearingParticipant({ policies: [policy, other], controls, now: () => now });
  await assert.rejects(participant.tick(), /request failed/);
  assert.deepEqual(prepared, [policy.policyId, other.policyId]);
  assert.equal(executed.length, 1);

  now += 119_999;
  await participant.tick();
  assert.equal(executed.length, 1);
  now += 1;
  await assert.rejects(participant.tick(), /request failed/);
  assert.equal(executed.length, 2);
});

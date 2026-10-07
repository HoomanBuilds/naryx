import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import {
  assetAmount,
  assetRef,
  domainRef,
  strategyPackageReceipt,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import { HttpSolanaStrategyExecutionObservationClient } from '../src/solana-strategy-execution-observation-client.js';

const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const hash = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);
const key = (byte: number) => new PublicKey(bytes(byte)).toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(24));
const quoteHash = hash(4);
const domain = domainRef('svm:devnet', 1, hash(1));
const baseAsset = assetRef('sol', hash(2), 9);
const quoteAsset = assetRef('usdc', hash(3), 6);

const receipt = strategyPackageReceipt({
  version: 1,
  environment: 'devnet',
  domains: [domain],
  orderHash: hash(5),
  graphHash: hash(6),
  quoteHash,
  routeHash: hash(7),
  templateId: 'treasury-inventory-hedge-v1',
  templateVersion: 1,
  packageTemplateManifestHash: hash(8),
  seriesId: 'sol-treasury-hedge',
  seriesVersion: 1,
  seriesManifestHash: hash(9),
  executionClassId: 'solana-atomic-treasury-hedge',
  executionClassVersion: 1,
  executionClassManifestHash: hash(10),
  lifecycleAction: 'ENTRY',
  owner: key(11),
  solverId: 'solver-1',
  settlementClass: 'ATOMIC_POSTCONDITION',
  terminalState: 'FINALIZED_COMPLETE',
  quoteAsset,
  legOutcomes: [{
    legId: 'treasury-hedge',
    positionLegId: 'treasury-hedge',
    domain,
    status: 'EXECUTED',
    requestedQuantity: assetAmount(baseAsset, 1_000_000_000n),
    settledQuantity: assetAmount(baseAsset, -1_000_000_000n),
    grossNotional: assetAmount(quoteAsset, 100_000_000n),
    venueFee: assetAmount(quoteAsset, 50_000n),
    residualValue: assetAmount(quoteAsset, 0n),
    evidenceGrade: 'CONSENSUS_VERIFIED',
    onchainEnforced: true,
    evidenceHash: hash(12),
  }],
  serviceFee: assetAmount(quoteAsset, 0n),
  solverFee: assetAmount(quoteAsset, 0n),
  venueFees: assetAmount(quoteAsset, 50_000n),
  networkCost: assetAmount(quoteAsset, 0n),
  recoveryCost: assetAmount(quoteAsset, 0n),
  terminalResidualValue: assetAmount(quoteAsset, 0n),
  finalityStatus: 'FINALIZED',
  executedAtValue: 1_000n,
  receiptNonce: 23n,
});

const finalized = Object.freeze({
  version: 1,
  status: 'FINALIZED',
  signature,
  domain,
  slot: 101n,
  strategyAccount: key(13),
  position: key(14),
  receiptAccount: key(15),
  packageId: hash(16),
  orderHash: hash(5),
  graphHash: hash(6),
  quoteHash,
  routeHash: hash(7),
  operation: 'ENTRY',
  previousStateHash: hash(17),
  nextStateHash: hash(18),
  callsHash: hash(19),
  evidenceRoot: hash(20),
  onchainReceiptHash: hash(21),
  solver: key(22),
  nonce: 22n,
  receipt,
});

function client(observation: unknown): HttpSolanaStrategyExecutionObservationClient {
  return new HttpSolanaStrategyExecutionObservationClient('http://127.0.0.1:8788', async () => new Response(
    stringifyProtocolJson({ version: 1, observation }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));
}

test('accepts only a canonical Solana receipt bound to the finalized observation', async () => {
  const observed = await client(finalized).observe(quoteHash, signature);
  assert.equal(observed.status, 'FINALIZED');
  if (observed.status !== 'FINALIZED') return;
  assert.equal(observed.receipt.legOutcomes[0]?.evidenceGrade, 'CONSENSUS_VERIFIED');

  await assert.rejects(
    client({ ...finalized, graphHash: hash(23) }).observe(quoteHash, signature),
    /canonical strategy receipt changed/,
  );
});

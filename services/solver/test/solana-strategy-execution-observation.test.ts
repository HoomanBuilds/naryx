import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  solanaMultiStrategyEvidenceRoot,
  solanaMultiStrategyReceiptHash,
} from '@naryx/adapter-solana';
import { assetAmount, assetRef, domainRef, type Hash32 } from '@naryx/protocol-types';
import {
  SolanaStrategyExecutionObservationService,
  type PreparedStrategyExecutionTransport,
  type SolanaTreasuryHedgeExecutionLane,
  type StoredStrategyPackageDocuments,
} from '../src/index.js';

const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const key = (byte: number) => new PublicKey(bytes(byte));
const domain = domainRef('svm:devnet', 1, '11'.repeat(32));
const owner = key(1);
const solver = key(2);
const program = key(3);
const account = key(4);
const receiptAddress = key(17);
const quoteHash = bytes(6) as Hash32;
const executionHash = bytes(13);
const callsHash = bytes(14);
const evidenceHash = bytes(15);
const evidenceRoot = solanaMultiStrategyEvidenceRoot([evidenceHash]);
const executionSlot = 101n;
const inventoryAsset = assetRef('sol', bytes(25), 9);
const quoteAsset = assetRef('usdc', bytes(26), 6);

function documents(): StoredStrategyPackageDocuments {
  return {
    orderHashHex: Buffer.from(bytes(10)).toString('hex'),
    graphHashHex: Buffer.from(bytes(11)).toString('hex'),
    quoteHashHex: Buffer.from(quoteHash).toString('hex'),
    routeHashHex: Buffer.from(bytes(12)).toString('hex'),
    order: {
      environment: 'devnet',
      templateId: 'treasury-inventory-hedge-v1',
      templateVersion: 1,
      packageTemplateManifestHash: bytes(8),
      seriesId: 'sol-treasury-hedge',
      seriesVersion: 1,
      seriesManifestHash: bytes(27),
      executionClassId: 'solana-atomic-treasury-hedge',
      executionClassVersion: 1,
      executionClassManifestHash: bytes(28),
      lifecycleAction: 'ENTRY',
      owner: owner.toBase58(),
      settlementClass: 'ATOMIC_POSTCONDITION',
      quoteAsset,
    },
    graph: {
      legs: [{
        legId: 'treasury-hedge',
        legFamily: 'PERP_OPEN',
        domain,
        side: 'SELL',
        quantityAsset: inventoryAsset,
        quantityAtoms: 1_000_000_000n,
      }],
    },
    quote: {
      solverId: 'solver-1',
      serviceCharges: [],
      passThroughCosts: [],
      legEconomics: [{
        legId: 'treasury-hedge',
        grossNotional: assetAmount(quoteAsset, 100_000_000n),
        venueFee: assetAmount(quoteAsset, 50_000n),
      }],
    },
    route: { domainPlans: [{ domain }] },
    recordedAtMs: 1,
  } as unknown as StoredStrategyPackageDocuments;
}

function prepared(): PreparedStrategyExecutionTransport {
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      packageId: bytes(7) as Hash32,
      templateId: 'treasury-inventory-hedge-v1',
      templateVersion: 1,
      templateManifestHash: bytes(8),
      operation: 'ENTRY',
      nextStateHash: bytes(9) as Hash32,
    }),
    settlementClass: 'ATOMIC_POSTCONDITION',
    coordination: 'SINGLE_DOMAIN_ATOMIC',
    orderHash: bytes(10),
    graphHash: bytes(11),
    quoteHash,
    routeHash: bytes(12),
    domains: Object.freeze([{
      kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT' as const,
      domain,
      routeSettlementClass: 'ATOMIC_POSTCONDITION' as const,
      localGuarantee: 'ATOMIC_POSTCONDITION' as const,
      legIds: Object.freeze(['treasury-hedge']),
      envelope: Object.freeze({
        instruction: Object.freeze({
          programId: program.toBase58(),
          accounts: Object.freeze([
            Object.freeze({ pubkey: owner.toBase58(), isSigner: true, isWritable: true }),
            Object.freeze({ pubkey: solver.toBase58(), isSigner: true, isWritable: false }),
            Object.freeze({ pubkey: account.toBase58(), isSigner: false, isWritable: true }),
            Object.freeze({ pubkey: receiptAddress.toBase58(), isSigner: false, isWritable: true }),
          ]),
          data: Uint8Array.from([1, 2, 3]),
        }),
        executionHash,
        callsHash,
        strategyAccount: key(15).toBase58(),
        position: key(16).toBase58(),
        receipt: receiptAddress.toBase58(),
        requiredSignerPubkeys: Object.freeze([owner.toBase58(), solver.toBase58()].sort()),
      }),
    }]),
  });
}

function receiptData(): Uint8Array {
  const receiptHash = solanaMultiStrategyReceiptHash({ executionHash, callsHash, evidenceRoot });
  const data = Buffer.alloc(379);
  createHash('sha256').update('account:StrategyReceipt', 'ascii').digest().copy(data, 0, 0, 8);
  let offset = 8;
  data[offset++] = 1;
  for (const value of [bytes(7), bytes(10), bytes(11), quoteHash, bytes(12)]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  data[offset++] = 0;
  for (const value of [new Uint8Array(32), bytes(9), callsHash, evidenceRoot, receiptHash]) {
    Buffer.from(value).copy(data, offset);
    offset += 32;
  }
  data.writeBigUInt64LE(22n, offset);
  offset += 8;
  solver.toBuffer().copy(data, offset);
  offset += 32;
  data.writeBigUInt64LE(executionSlot, offset);
  offset += 8;
  data[offset] = 23;
  return data;
}

function lane(
  transactionData = Uint8Array.from([1, 2, 3]),
  logMessages?: readonly string[],
): SolanaTreasuryHedgeExecutionLane {
  const event = Buffer.alloc(106);
  createHash('sha256').update('event:StrategyAdapterLegExecuted', 'ascii').digest().copy(event, 0, 0, 8);
  receiptAddress.toBuffer().copy(event, 8);
  event[40] = 0;
  Buffer.from(bytes(29)).copy(event, 41);
  event[73] = 0;
  Buffer.from(evidenceHash).copy(event, 74);
  return Object.freeze({
    domain,
    solver: solver.toBase58(),
    computeUnitLimit: 600_000,
    materializer: {} as SolanaTreasuryHedgeExecutionLane['materializer'],
    reader: {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getFinalizedSlot: async () => executionSlot,
      getBlockTime: async () => 1_000n,
      getAccounts: async (addresses: readonly string[]) => {
        assert.deepEqual(addresses, [receiptAddress.toBase58()]);
        return [Object.freeze({ owner: program.toBase58(), data: receiptData() })];
      },
      getTransactionObservation: async () => Object.freeze({
        status: 'FINALIZED' as const,
        slot: executionSlot,
        instructions: Object.freeze([Object.freeze({
          programId: program.toBase58(),
          accounts: Object.freeze([owner, solver, account, receiptAddress].map((value) => value.toBase58())),
          data: transactionData,
        })]),
        logMessages: Object.freeze(logMessages ?? [
          `Program ${program.toBase58()} invoke [1]`,
          `Program data: ${event.toString('base64')}`,
          `Program ${program.toBase58()} success`,
        ]),
      }),
    },
  });
}

test('returns finalized evidence only for the exact prepared Solana instruction and receipt', async () => {
  const service = new SolanaStrategyExecutionObservationService({
    packages: { getByQuote: async () => documents() },
    preparations: { prepareByQuote: async () => prepared() },
    lanes: [lane()],
  });
  const signature = bs58.encode(new Uint8Array(64).fill(24));
  const observation = await service.observe({ quoteHash, signature });
  assert.equal(observation?.status, 'FINALIZED');
  if (observation?.status !== 'FINALIZED') return;
  assert.equal(observation.slot, executionSlot);
  assert.equal(observation.receiptAccount, receiptAddress.toBase58());
  assert.equal(observation.quoteHash, Buffer.from(quoteHash).toString('hex'));
  assert.equal(observation.solver, solver.toBase58());
  assert.equal(observation.receipt.finalityStatus, 'FINALIZED');
  assert.equal(observation.receipt.legOutcomes[0]?.evidenceGrade, 'CONSENSUS_VERIFIED');

  const changed = new SolanaStrategyExecutionObservationService({
    packages: { getByQuote: async () => documents() },
    preparations: { prepareByQuote: async () => prepared() },
    lanes: [lane(Uint8Array.from([1, 2, 4]))],
  });
  await assert.rejects(changed.observe({ quoteHash, signature }), /exact prepared strategy instruction/);

  const incompleteLogs = new SolanaStrategyExecutionObservationService({
    packages: { getByQuote: async () => documents() },
    preparations: { prepareByQuote: async () => prepared() },
    lanes: [lane(Uint8Array.from([1, 2, 3]), [
      `Program ${program.toBase58()} invoke [1]`,
    ])],
  });
  await assert.rejects(incompleteLogs.observe({ quoteHash, signature }), /log stack is incomplete/);
});

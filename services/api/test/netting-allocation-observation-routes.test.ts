import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import type {
  EvmNettingAllocationObservation,
  EvmNettingAllocationObservationBinding,
} from '@naryx/adapter-evm';
import type {
  SolanaNettingAllocationObservationBinding,
} from '@naryx/adapter-solana';
import {
  commitmentHash,
  domainRef,
  hash32,
  toHex,
  type NettingAllocationExecutionAuthorization,
} from '@naryx/protocol-types';
import {
  EvmNettingAllocationObservationRoute,
  SolanaNettingAllocationObservationRoute,
} from '../src/netting-allocation-observation-routes.js';
import type { NettingAllocationExecutionAttempt } from '../src/netting-allocation-attempt-store.js';

function hash(byte: number) {
  return hash32(new Uint8Array(32).fill(byte));
}

const evmDomain = domainRef('eip155:84532', 1, hash(1));
const solanaDomain = domainRef('svm:solana-devnet', 1, hash(2));

function authorization(domain = evmDomain): NettingAllocationExecutionAuthorization {
  return {
    authorizationHash: commitmentHash(hash(3)),
    domain,
  } as NettingAllocationExecutionAuthorization;
}

function attempts(...values: NettingAllocationExecutionAttempt[]) {
  return { attemptsForAuthorization: () => values };
}

test('converts finalized EVM and Solana receipts into canonical allocation observations', async () => {
  const evmAuthorization = authorization();
  const transactionHash = `0x${'04'.repeat(32)}`;
  const receiptHash = `0x${'05'.repeat(32)}`;
  const evmBinding = { chainReference: 84_532n } as EvmNettingAllocationObservationBinding;
  const evmAttempt = {
    attemptId: 'attempt-evm-0001',
    idempotencyKey: 'idempotency-evm-0001',
    authorizationHashHex: toHex(evmAuthorization.authorizationHash),
    observation: { runtimeClass: 'EVM', binding: evmBinding },
    executionReference: transactionHash,
    recordedAtMs: 1,
  } as const satisfies NettingAllocationExecutionAttempt;
  const evm = new EvmNettingAllocationObservationRoute({
    routeId: 'base-sepolia',
    domain: evmDomain,
    attempts: attempts(evmAttempt),
    reads: {} as never,
    finality: { requiredConfirmations: 2, requireFinalized: true },
    blockTimestamp: async () => 1_750_000_000n,
    observe: async () => ({
      lifecycle: 'FINALIZED',
      evidenceGrade: 'finalized-contract-receipt',
      chainReference: 84_532n,
      transactionHash,
      blockNumber: 50n,
      confirmations: 5,
      authorizationHash: `0x${toHex(evmAuthorization.authorizationHash)}`,
      receipt: { receiptHash },
      reason: null,
    } as EvmNettingAllocationObservation),
  });
  const evmObserved = await evm.observe({
    authorization: evmAuthorization,
    idempotencyKey: toHex(evmAuthorization.authorizationHash),
  });
  assert.equal(evmObserved?.observedAtUnit, 'EVM_UNIX_SECONDS');
  assert.equal(evmObserved?.observedAtValue, 1_750_000_000n);
  assert.equal(evmObserved?.settlementReferenceHash, transactionHash);
  assert.equal(evmObserved?.authoritativeEvidenceHash, receiptHash);

  const solanaAuthorization = authorization(solanaDomain);
  const signature = bs58.encode(new Uint8Array(64).fill(6));
  const solanaBinding = { receiptAccount: 'receipt-account' } as SolanaNettingAllocationObservationBinding;
  const solanaAttempt = {
    attemptId: 'attempt-svm-0001',
    idempotencyKey: 'idempotency-svm-0001',
    authorizationHashHex: toHex(solanaAuthorization.authorizationHash),
    observation: { runtimeClass: 'SVM', binding: solanaBinding },
    executionReference: signature,
    recordedAtMs: 2,
  } as const satisfies NettingAllocationExecutionAttempt;
  const solana = new SolanaNettingAllocationObservationRoute({
    routeId: 'solana-devnet',
    domain: solanaDomain,
    expectedGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    attempts: attempts(solanaAttempt),
    reads: {
      genesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      finalizedTransaction: async () => ({ slot: 90n, successful: true, instructions: [] }),
      finalizedAccount: async () => ({ address: 'receipt-account', owner: 'program', data: new Uint8Array() }),
    },
    observe: () => ({
      observedAtUnit: 'SOLANA_SLOT',
      observedAtValue: 90n,
      receiptAccount: 'receipt-account',
      receiptHash: hash(7),
      evidenceRoot: hash(8),
      authorizationHash: solanaAuthorization.authorizationHash,
    }),
  });
  const solanaObserved = await solana.observe({
    authorization: solanaAuthorization,
    idempotencyKey: toHex(solanaAuthorization.authorizationHash),
  });
  assert.equal(solanaObserved?.observedAtUnit, 'SOLANA_SLOT');
  assert.equal(solanaObserved?.observedAtValue, 90n);
  assert.equal(toHex(commitmentHash(solanaObserved!.authoritativeEvidenceHash)), toHex(hash(7)));
  assert.equal((solanaObserved!.settlementReferenceHash as Uint8Array).length, 32);
});

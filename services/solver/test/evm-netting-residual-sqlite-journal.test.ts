import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EvmTestPerpNettingResidualPlan } from '@naryx/adapter-evm';
import {
  assetRef,
  commitmentHash,
  domainRef,
  type NettingExternalExecutionEvidence,
} from '@naryx/protocol-types';
import { getAddress, type Hex } from 'viem';
import { EvmNettingResidualSqliteJournal } from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const hexId = (value: number): Hex => `0x${id(value)}`;
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, '0')}`);

function plan(value: number): EvmTestPerpNettingResidualPlan {
  const intentHash = commitmentHash(id(value));
  const base = assetRef('weth', id(10), 18);
  const quote = assetRef('tusdc', id(11), 6);
  return Object.freeze({
    version: 1,
    guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT',
    intentHash,
    domain: domainRef('eip155:84532', 2, id(12)),
    instrumentHash: commitmentHash(id(13)),
    quantityAsset: base,
    quoteAsset: quote,
    requestedSignedQuantityAtoms: 1_000_000_000_000_000_000n,
    sizeDeltaWad: 1_000_000_000_000_000_000n,
    balanceDeltaWad: 400_000_000_000_000_000_000n,
    minimumNotionalWad: 1n,
    maximumNotionalWad: 2_100_000_000_000_000_000_000n,
    maximumFeeWad: 2_000_000_000_000_000_000n,
    requestExpirySeconds: 2_000_000_000n,
    executionId: `0x${id(value)}`,
    executionAccount: address(20),
    transaction: Object.freeze({ chainId: 84532, to: address(21), value: 0n, data: '0x1234' }),
  });
}

function evidence(intent: EvmTestPerpNettingResidualPlan['intentHash']): NettingExternalExecutionEvidence {
  return Object.freeze({
    version: 1,
    evidenceHash: commitmentHash(id(40)),
    intentHash: intent,
    outcome: 'REJECTED',
    filledSignedQuantityAtoms: 0n,
    grossQuoteAtoms: 0n,
    feeQuoteAtoms: 0n,
    submittedAtUnit: 'EVM_UNIX_SECONDS',
    submittedAtValue: 1_900_000_000n,
    observedAtUnit: 'EVM_UNIX_SECONDS',
    observedAtValue: 1_900_000_002n,
    executionReferenceHash: commitmentHash(id(41)),
    authoritativeEvidenceHash: commitmentHash(id(42)),
  });
}

test('persists the signed transaction before broadcast and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-evm-residual-'));
  const path = join(directory, 'journal.sqlite');
  const candidate = plan(1);
  const hash = id(1);
  try {
    let journal = new EvmNettingResidualSqliteJournal(path);
    assert.equal((await journal.prepare({ intentHash: hash, plan: candidate })).status, 'PREPARED');
    const signed = await journal.recordSigned({
      intentHash: hash,
      rawTransaction: '0x0102',
      transactionHash: hexId(30),
      transactionNonce: 7n,
      signedAtSeconds: 1_900_000_000n,
    });
    assert.equal(signed.status, 'SIGNED');
    journal.close();

    journal = new EvmNettingResidualSqliteJournal(path);
    const recovered = await journal.read(hash);
    assert.equal(recovered?.rawTransaction, '0x0102');
    assert.equal(recovered?.transactionNonce, 7n);
    assert.equal((await journal.recordSubmitted({
      intentHash: hash,
      transactionHash: hexId(30),
      submittedAtSeconds: 1_900_000_000n,
    })).status, 'SUBMITTED');
    assert.equal((await journal.recordTerminal({
      intentHash: hash,
      evidence: evidence(candidate.intentHash),
    })).status, 'TERMINAL');
    journal.close();

    journal = new EvmNettingResidualSqliteJournal(path);
    const terminal = await journal.read(hash);
    assert.equal(terminal?.status, 'TERMINAL');
    assert.equal(terminal?.evidence?.outcome, 'REJECTED');
    journal.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('permits only one unresolved transaction for the shared execution account', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-evm-residual-'));
  const path = join(directory, 'journal.sqlite');
  const journal = new EvmNettingResidualSqliteJournal(path);
  try {
    await journal.prepare({ intentHash: id(1), plan: plan(1) });
    await assert.rejects(journal.prepare({ intentHash: id(2), plan: plan(2) }), /another EVM residual/);
    assert.equal((await journal.read(id(2))), null);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects repository-local journal paths', () => {
  assert.throws(
    () => new EvmNettingResidualSqliteJournal(join(process.cwd(), 'journal.sqlite')),
    /outside the repository/,
  );
});

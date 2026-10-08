import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  toHex,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  SolanaNettingResidualRuntimeError,
  SolanaNettingResidualSqliteJournal,
  SolanaTestPerpNettingResidualRuntime,
  type SolanaNettingResidualChainPort,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const key = (value: number): string => new PublicKey(Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? value : 0)).toBase58();
const signature = (value: number): string => bs58.encode(Uint8Array.from({ length: 64 }, () => value));
const blockhash = (value: number): string => bs58.encode(Uint8Array.from({ length: 32 }, () => value));
const base = assetRef('wsol', id(1), 9);
const quote = assetRef('tusdc', id(2), 6);
const domain = domainRef('svm:devnet', 2, id(3));
const adapter = adapterRef({
  adapterId: 'solana-test-perp-residual',
  adapterManifestVersion: 1,
  adapterManifestHash: id(4),
});
const venue = versionedManifestRef('solana-test-perp', 1, id(5));
const market = versionedManifestRef('wsol-perp', 1, id(6));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'devnet',
  executionClassId: 'solana-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(7),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'wsol-perp',
    domain,
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 1_000_000n,
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
  instrumentId: 'wsol-perp',
  signedQuantityAtoms: 1_000_000_000n,
  limitPriceTicks: 100_500n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'wsol-perp',
  validUntilUnit: 'SOLANA_SLOT',
  validUntilValue: 500_000_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 60_000n }],
});
const binding = {
  domain,
  adapter,
  venue,
  market,
  programId: key(20),
  marketAddress: key(21),
  positionAddress: key(22),
  oracleAddress: key(23),
  collateralVaultAddress: key(24),
  feeVaultAddress: key(25),
  insuranceVaultAddress: key(26),
  executionAccount: key(27),
  baseLotAtoms: 1_000_000n,
  quoteAtomsPerTickPerBaseLot: 1n,
};

class RetryChain implements SolanaNettingResidualChainPort {
  readonly account = binding.executionAccount;
  signCount = 0;
  observeCount = 0;

  async genesisHash(): Promise<string> {
    return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  }

  async currentSlot(): Promise<bigint> {
    return 400_000_000n;
  }

  async sign() {
    this.signCount += 1;
    return Object.freeze({
      rawTransactionBase64: Buffer.from([this.signCount]).toString('base64'),
      signature: signature(this.signCount),
      recentBlockhash: blockhash(this.signCount),
      lastValidBlockHeight: BigInt(this.signCount * 10),
      signedAtSlot: 400_000_000n + BigInt(this.signCount),
    });
  }

  async broadcast(_rawTransactionBase64: string, expectedSignature: string): Promise<string> {
    return expectedSignature;
  }

  async observe(input: Parameters<SolanaNettingResidualChainPort['observe']>[0]) {
    this.observeCount += 1;
    if (this.observeCount === 1) {
      return Object.freeze({ status: 'PENDING' as const, currentBlockHeight: 5n });
    }
    if (this.observeCount === 2) {
      return Object.freeze({
        status: 'EXPIRED_UNSEEN' as const,
        currentBlockHeight: 11n,
        observation: Object.freeze({
          intentHash: input.plan.intentHash,
          authority: binding.executionAccount,
          market: binding.marketAddress,
          position: binding.positionAddress,
          terminalStatus: 'REJECTED' as const,
          side: input.plan.side,
          baseLots: 0n,
          fillPricePerLot: 0n,
          grossQuoteAtoms: 0n,
          feeQuoteAtoms: 0n,
          executionSlot: 0n,
          submittedAtSlot: input.submission.submittedAtSlot!,
          observedAtSlot: 400_000_010n,
          executionReferenceHash: id(40),
          authoritativeEvidenceHash: id(41),
        }),
      });
    }
    return Object.freeze({
      status: 'TERMINAL' as const,
      observation: Object.freeze({
        intentHash: input.plan.intentHash,
        authority: binding.executionAccount,
        market: binding.marketAddress,
        position: binding.positionAddress,
        terminalStatus: 'SUCCEEDED' as const,
        side: input.plan.side,
        baseLots: input.plan.baseLots,
        fillPricePerLot: 100_000n,
        grossQuoteAtoms: input.plan.baseLots * 100_000n,
        feeQuoteAtoms: 50_000n,
        executionSlot: 400_000_020n,
        submittedAtSlot: input.submission.submittedAtSlot!,
        observedAtSlot: 400_000_021n,
        executionReferenceHash: id(42),
        authoritativeEvidenceHash: id(43),
      }),
    });
  }
}

test('recovers a pending Solana residual and safely re-signs only after blockhash expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-solana-residual-'));
  const databasePath = join(directory, 'journal.sqlite');
  const chain = new RetryChain();
  const resolver = { resolve: () => ({ instrument: policy.instruments[0]!, binding }) };
  const idempotencyKey = toHex(intent.intentHash);
  let journal = new SolanaNettingResidualSqliteJournal(databasePath);
  try {
    let runtime = new SolanaTestPerpNettingResidualRuntime(resolver, journal, chain);
    await assert.rejects(runtime.execute({ intent, idempotencyKey }), (error: unknown) =>
      error instanceof SolanaNettingResidualRuntimeError && error.code === 'EVIDENCE_PENDING');
    assert.equal((await journal.read(idempotencyKey))?.submissions.length, 1);
    journal.close();

    journal = new SolanaNettingResidualSqliteJournal(databasePath);
    runtime = new SolanaTestPerpNettingResidualRuntime(resolver, journal, chain);
    const evidence = await runtime.execute({ intent, idempotencyKey });
    assert.equal(evidence.outcome, 'EXACT_FILLED');
    assert.equal(chain.signCount, 2);
    assert.deepEqual((await journal.read(idempotencyKey))?.submissions.map((item) => item.status),
      ['EXPIRED', 'SUBMITTED']);
    const replay = await runtime.execute({ intent, idempotencyKey });
    assert.equal(toHex(replay.evidenceHash), toHex(evidence.evidenceHash));
    assert.equal(chain.signCount, 2);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

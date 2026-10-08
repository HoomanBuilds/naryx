import assert from 'node:assert/strict';
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
  type NettingExternalExecutionEvidence,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { getAddress, type Hex } from 'viem';
import {
  EvmNettingResidualRuntimeError,
  EvmTestPerpNettingResidualRuntime,
  type EvmNettingResidualAttempt,
  type EvmNettingResidualChainPort,
  type EvmNettingResidualJournalPort,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const hexId = (value: number): Hex => `0x${id(value)}`;
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, '0')}`);
const base = assetRef('weth', id(1), 18);
const quote = assetRef('tusdc', id(2), 6);
const domain = domainRef('eip155:84532', 2, id(3));
const adapter = adapterRef({
  adapterId: 'base-test-perp-residual', adapterManifestVersion: 1, adapterManifestHash: id(4),
});
const venue = versionedManifestRef('base-test-perp', 1, id(5));
const market = versionedManifestRef('weth-perp', 1, id(6));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'base-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(7),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'weth-perp',
    domain,
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 100_000_000_000_000_000n,
    priceTickQuoteAtoms: 10_000_000n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'weth-perp',
  signedQuantityAtoms: 1_000_000_000_000_000_000n,
  limitPriceTicks: 21n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'weth-perp',
  validUntilUnit: 'EVM_UNIX_SECONDS',
  validUntilValue: 2_000_000_000n,
  sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2_000_000n }],
});
const executionAccount = address(20);
const binding = {
  domain,
  adapter,
  venue,
  market,
  chainId: 84532 as const,
  marketAddress: address(21),
  executionAccount,
  expiry: 4_294_967_295,
};

class MemoryJournal implements EvmNettingResidualJournalPort {
  attempt: EvmNettingResidualAttempt | null = null;

  async read(intentHash: string): Promise<EvmNettingResidualAttempt | null> {
    return this.attempt?.intentHash === intentHash ? this.attempt : null;
  }

  async prepare(input: Readonly<{
    intentHash: string;
    plan: EvmNettingResidualAttempt['plan'];
  }>): Promise<EvmNettingResidualAttempt> {
    if (this.attempt !== null) throw new Error('another attempt is active');
    this.attempt = Object.freeze({ ...input, status: 'PREPARED' });
    return this.attempt;
  }

  async recordSigned(input: Readonly<{
    intentHash: string;
    rawTransaction: Hex;
    transactionHash: Hex;
    transactionNonce: bigint;
    signedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt> {
    assert.equal(this.attempt?.status, 'PREPARED');
    this.attempt = Object.freeze({ ...this.attempt!, ...input, status: 'SIGNED' });
    return this.attempt;
  }

  async recordSubmitted(input: Readonly<{
    intentHash: string;
    transactionHash: Hex;
    submittedAtSeconds: bigint;
  }>): Promise<EvmNettingResidualAttempt> {
    assert.equal(this.attempt?.status, 'SIGNED');
    this.attempt = Object.freeze({ ...this.attempt!, ...input, status: 'SUBMITTED' });
    return this.attempt;
  }

  async recordTerminal(input: Readonly<{
    intentHash: string;
    evidence: NettingExternalExecutionEvidence;
  }>): Promise<EvmNettingResidualAttempt> {
    assert.equal(this.attempt?.status, 'SUBMITTED');
    this.attempt = Object.freeze({ ...this.attempt!, ...input, status: 'TERMINAL' });
    return this.attempt;
  }
}

class FakeChain implements EvmNettingResidualChainPort {
  readonly account = executionAccount;
  signCount = 0;
  broadcastCount = 0;
  observations = 0;
  pendingOnce = false;

  async chainId(): Promise<number> { return 84_532; }
  async currentTimeSeconds(): Promise<bigint> { return 1_900_000_000n; }

  async sign(): Promise<Readonly<{
    rawTransaction: Hex;
    transactionHash: Hex;
    transactionNonce: bigint;
    signedAtSeconds: bigint;
  }>> {
    this.signCount += 1;
    return Object.freeze({
      rawTransaction: '0x01', transactionHash: hexId(30), transactionNonce: 7n, signedAtSeconds: 1_900_000_000n,
    });
  }

  async broadcast(_raw: Hex, expected: Hex): Promise<Hex> {
    this.broadcastCount += 1;
    return expected;
  }

  async observe(input: Parameters<EvmNettingResidualChainPort['observe']>[0]) {
    this.observations += 1;
    if (this.pendingOnce && this.observations === 1) return null;
    return Object.freeze({
      executionId: input.plan.executionId,
      trader: executionAccount,
      terminalStatus: 'SUCCEEDED' as const,
      sizeDeltaWad: input.plan.sizeDeltaWad,
      notionalWad: 2_000_420_000_000_000_000_000n,
      feeWad: 1_000_210_000_000_000_000n,
      submittedAtSeconds: input.submittedAtSeconds,
      observedAtSeconds: 1_900_000_002n,
      executionReferenceHash: id(30),
      authoritativeEvidenceHash: id(31),
    });
  }
}

function runtime(journal: MemoryJournal, chain: FakeChain) {
  return new EvmTestPerpNettingResidualRuntime({
    resolve: () => ({ instrument: policy.instruments[0]!, binding, marginQuoteAtoms: 400_000_000n }),
  }, journal, chain);
}

test('signs and broadcasts a Base residual once, then replays terminal evidence', async () => {
  const journal = new MemoryJournal();
  const chain = new FakeChain();
  const subject = runtime(journal, chain);
  const idempotencyKey = toHex(intent.intentHash);
  const first = await subject.execute({ intent, idempotencyKey });
  const replay = await subject.execute({ intent, idempotencyKey });
  assert.equal(first.outcome, 'EXACT_FILLED');
  assert.equal(toHex(first.evidenceHash), toHex(replay.evidenceHash));
  assert.equal(chain.signCount, 1);
  assert.equal(chain.broadcastCount, 1);
  assert.equal(chain.observations, 1);
  assert.equal(journal.attempt?.status, 'TERMINAL');
});

test('reconciles a pending receipt without signing or broadcasting again', async () => {
  const journal = new MemoryJournal();
  const chain = new FakeChain();
  chain.pendingOnce = true;
  const subject = runtime(journal, chain);
  const idempotencyKey = toHex(intent.intentHash);
  await assert.rejects(subject.execute({ intent, idempotencyKey }), (error: unknown) =>
    error instanceof EvmNettingResidualRuntimeError && error.code === 'EVIDENCE_PENDING');
  const evidence = await subject.execute({ intent, idempotencyKey });
  assert.equal(evidence.outcome, 'EXACT_FILLED');
  assert.equal(chain.signCount, 1);
  assert.equal(chain.broadcastCount, 1);
  assert.equal(chain.observations, 2);
});

test('rejects a noncanonical idempotency key before touching the chain', async () => {
  const journal = new MemoryJournal();
  const chain = new FakeChain();
  await assert.rejects(runtime(journal, chain).execute({ intent, idempotencyKey: id(99) }),
    (error: unknown) => error instanceof EvmNettingResidualRuntimeError
      && error.code === 'IDEMPOTENCY_MISMATCH');
  assert.equal(chain.signCount, 0);
  assert.equal(journal.attempt, null);
});

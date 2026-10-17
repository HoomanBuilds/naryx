import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assetRef, domainRef, netObligations, nettingPolicyManifest, nettingExternalExecutionIntent,
  nettingExternalExecutionEvidence, nettingFinalAllocationReceipt, versionedManifestRef,
  stringifyProtocolJson, type NettingPolicyManifest, type NettingResult, type NettingExternalExecutionIntent,
  type NettingExternalExecutionEvidence } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore } from '../src/hyperliquid-pooled-collateral-store.js';
import { HyperliquidPoolEpochService, poolEpochTypedData, poolEpochPolicyHash, reconcileHyperliquidPoolEpoch,
  type HyperliquidPoolEpochPlan, type HyperliquidPoolEpochClosure } from '../src/hyperliquid-pool-epoch.js';
import { HyperliquidPoolNettingExecution } from '../src/hyperliquid-pool-netting-execution.js';
import { createHyperliquidPoolExecutionReads } from '../src/hyperliquid-pool-execution-reads.js';
import { createHyperliquidPoolController } from '../src/hyperliquid-pool-http.js';
import { HyperliquidPoolFundingService } from '../src/hyperliquid-pool-funding.js';
import { HyperliquidPoolWithdrawalService } from '../src/hyperliquid-pool-withdrawal.js';
import { loadHyperliquidPoolRuntime } from '../src/hyperliquid-pool-runtime.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

function fixture() {
  const wallets = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
  const owners = wallets.map(wallet => wallet.address.toLowerCase() as `0x${string}`);
  const domain = domainRef('hypercore:testnet', 1, hash(1));
  const quote = assetRef('test-usdc', hash(2), 6);
  const entryPolicy = nettingPolicyManifest({ schemaVersion: 1, manifestVersion: 1, nettingPolicyVersion: 2,
    environment: 'testnet', executionClassId: 'pool-netting', executionClassVersion: 1, executionClassManifestHash: hash(30),
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY', allocationRule: 'PRO_RATA_SEQUENCE', externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR', maximumObligations: 8, maximumBatchWindowMilliseconds: 1_000n,
    instruments: [{ instrumentId: 'btc-perp', domain, adapter: { adapterId: 'core-perp', adapterManifestVersion: 1, adapterManifestHash: hash(31) },
      venue: versionedManifestRef('hypercore', 1, hash(32)), market: versionedManifestRef('btc', 1, hash(33)),
      quantityAsset: assetRef('btc', hash(34), 8), quoteAsset: quote, legFamily: 'PERP_OPEN', quantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n }] });
  const exitPolicy = nettingPolicyManifest({ ...entryPolicy, manifestVersion: 2,
    instruments: entryPolicy.instruments.map(({ instrumentHash: _hash, ...row }) => ({ ...row, legFamily: 'PERP_CLOSE' })) });
  const store = new HyperliquidPooledCollateralStore(':memory:', { version: 1, environment: 'TESTNET', domain,
    poolAccount: `0x${'99'.repeat(20)}`, policyHash: poolEpochPolicyHash(entryPolicy, exitPolicy), quoteAsset: quote,
    collateralTokenId: `0x${'11'.repeat(16)}`, dedicatedTestOwners: owners, maximumTotalQuoteAtoms: 10_000n });
  owners.forEach((owner, i) => {
    store.enroll(owner, hash(10 + i));
    store.creditDeposit({ id: `deposit-${i}`, owner, receivedQuoteAtoms: 1_000n, transferHash: hash(20 + i) }, BigInt(i + 1) * 1_000n);
  });
  function result(policy: NettingPolicyManifest, close: boolean, price: bigint) {
    return netObligations(owners.slice(0, 2).map((owner, i) => ({ ownerId: owner,
      strategyOrderHash: hash((close ? 50 : 40) + i), packageOrderId: hash((close ? 60 : 70) + i),
      settlementReadinessHash: hash(80 + i), legId: 'perp', instrumentId: 'btc-perp',
      signedQuantityAtoms: (i === 0 ? 20n : -10n) * (close ? -1n : 1n), limitPriceTicks: price, sequence: BigInt(i + 1) })), policy);
  }
  function evidence(result: NettingResult, policy: NettingPolicyManifest, close: boolean, price: bigint) {
    const intent = nettingExternalExecutionIntent(result, policy, { instrumentId: 'btc-perp', validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      validUntilValue: close ? 11_000n : 10_050n, sourceFeeCaps: result.allocations.filter(row => row.externalQuantityAtoms !== 0n)
        .map(row => ({ obligationId: row.obligationId, maximumFeeQuoteAtoms: 10n })) });
    const proof = nettingExternalExecutionEvidence({ version: 1, intentHash: intent.intentHash, outcome: 'EXACT_FILLED',
      filledSignedQuantityAtoms: close ? -10n : 10n, grossQuoteAtoms: price * 10n, feeQuoteAtoms: 2n,
      submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', submittedAtValue: close ? 10_999n : 10_001n,
      observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', observedAtValue: close ? 11_000n : 10_002n,
      executionReferenceHash: hash(close ? 92 : 90), authoritativeEvidenceHash: hash(close ? 93 : 91) }, intent);
    return { result, intents: [intent], evidence: [proof], receipt: nettingFinalAllocationReceipt(result, policy, [intent], [proof]) };
  }
  const entry = result(entryPolicy, false, 100n);
  const plan: HyperliquidPoolEpochPlan = { id: 'epoch-1', entryPolicy, exitPolicy, entry, entryDeadlineMs: 10_050, closeAfterMs: 11_000,
    mandates: owners.map((owner, i) => ({ owner, role: i === 2 ? 'RECOVERY_SPONSOR' : 'TRADER',
      maximumLossQuoteAtoms: i === 2 ? 1_000n : 500n, maximumFeeQuoteAtoms: 10n })) };
  function closure(price = 110n): HyperliquidPoolEpochClosure {
    return { account: store.binding.poolAccount, environment: 'TESTNET', openedAtMs: 10_000, closedAtMs: 11_000,
      entry: evidence(entry, entryPolicy, false, 100n), exit: evidence(result(exitPolicy, true, price), exitPolicy, true, price),
      funding: [{ hash: hash(95), instrumentId: 'btc-perp', timeMs: 10_500, netPositionAtoms: 10n, quoteDeltaAtoms: -3n }] };
  }
  let now = 10_000;
  let equity = 3_000n;
  let closed: HyperliquidPoolEpochClosure | undefined;
  let entries = 0;
  const reads = {
    async flat() { return { environment: 'TESTNET' as const, account: store.binding.poolAccount,
      equityQuoteAtoms: equity, withdrawableQuoteAtoms: equity, requestedAtMs: now, observedAtMs: now }; },
    async transfer() { throw new Error('unexpected transfer lookup'); },
  };
  const execution = { async enter() { assert.ok(store.epochStage(plan.id, 'ENTRY_REQUESTED')); entries++; },
    async close() { assert.ok(store.epochStage(plan.id, 'CLOSE_REQUESTED')); }, async closure() { return closed; },
    async recover() { return undefined; } };
  const service = new HyperliquidPoolEpochService(store, reads, execution, () => now);
  const signatures = (p = plan) => Promise.all(wallets.map(async (wallet, i) => ({ owner: owners[i]!,
    signature: await wallet.signTypedData(poolEpochTypedData(store.binding, p, owners[i]!)) })));
  return { store, owners, wallets, plan, closure, service, signatures, reads, clock: () => now, entries: () => entries,
    setState(time: number, balance = equity) { now = time; equity = balance; },
    finish(value: HyperliquidPoolEpochClosure, balance: bigint) { closed = value; now = 11_001; equity = balance; } };
}

test('signed epoch reconciles net execution, owner positions, fees and funding without charging unrelated owners', async () => {
  const f = fixture();
  try {
    await f.service.prepare(f.plan, await f.signatures());
    await f.service.enter(f.plan.id);
    assert.equal(f.entries(), 1);
    assert.equal(await f.service.reconcile(f.plan.id), 'PENDING');
    await f.service.close(f.plan.id);
    await assert.rejects(f.service.enter(f.plan.id), /closing epoch/);
    f.finish(f.closure(), 3_093n);
    assert.equal(await f.service.reconcile(f.plan.id), 'SETTLED');
    assert.equal(await f.service.reconcile(f.plan.id), 'SETTLED');
    const balances = new Map(f.store.members().map(row => [row.owner, row.balanceQuoteAtoms]));
    assert.equal(balances.get(f.owners[0]!), 1_190n);
    assert.equal(balances.get(f.owners[1]!), 903n);
    assert.equal(balances.get(f.owners[2]!), 1_000n);
    assert.equal(f.store.pending(), undefined);
  } finally { f.store.close(); }
});

function residualProof(intent: NettingExternalExecutionIntent, quantity: bigint, price: bigint, fee: bigint, time: number, ref: number) {
  const abs = quantity < 0n ? -quantity : quantity;
  return nettingExternalExecutionEvidence({ version: 1, intentHash: intent.intentHash,
    outcome: abs === 0n ? 'NO_FILL' : abs === intent.quantityAtoms ? 'EXACT_FILLED' : 'PARTIAL_FILL',
    filledSignedQuantityAtoms: quantity, grossQuoteAtoms: abs * price, feeQuoteAtoms: fee,
    submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', submittedAtValue: BigInt(time),
    observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', observedAtValue: BigInt(time + 1),
    executionReferenceHash: hash(ref), authoritativeEvidenceHash: hash(ref + 1) }, intent);
}

test('pooled residual executor resumes a partial close without reopening or duplicating owner positions', async () => {
  const f = fixture();
  try {
    let entryCalls = 0;
    let closeCalls = 0;
    const runtime = new HyperliquidPoolNettingExecution(f.store, {
      async execute({ intent }) { entryCalls++; return residualProof(intent, 10n, 100n, 2n, 10_001, 100); },
      async observe() { throw new Error('unexpected entry observation'); },
      cancelUnsubmitted() { return false; },
    }, {
      async execute({ intent }) {
        closeCalls++;
        if (closeCalls === 2) throw new Error('evidence pending');
        return residualProof(intent, closeCalls === 1 ? -4n : -6n, 110n, 1n, 10_100 + closeCalls, 110 + closeCalls * 2);
      },
      async observe() { throw new Error('unexpected close observation'); },
      cancelUnsubmitted() { return false; },
    }, {
      async closePrices() { return { observedAtMs: f.clock(), prices: [{ instrumentId: 'btc-perp',
        buyLimitPriceTicks: f.clock() < 10_050 ? 100n : 110n, sellLimitPriceTicks: f.clock() < 10_050 ? 100n : 110n }] }; },
      async funding() { return []; },
    }, f.clock);
    const service = new HyperliquidPoolEpochService(f.store, f.reads, runtime, f.clock);
    await service.prepare(f.plan, await f.signatures());
    await service.enter(f.plan.id);
    f.setState(10_100);
    await assert.rejects(service.close(f.plan.id), /evidence pending/);
    assert.equal(f.store.totalQuoteAtoms(), 3_000n);
    await service.close(f.plan.id);
    f.setState(10_200, 3_096n);
    assert.equal(await service.reconcile(f.plan.id), 'SETTLED');
    assert.equal(entryCalls, 1);
    assert.equal(closeCalls, 3);
    const balances = new Map(f.store.members().map(row => [row.owner, row.balanceQuoteAtoms]));
    assert.equal(balances.get(f.owners[0]!), 1_196n);
    assert.equal(balances.get(f.owners[1]!), 900n);
    assert.equal(balances.get(f.owners[2]!), 1_000n);
  } finally { f.store.close(); }
});

test('entry abort observes uncertain orders without resubmission and charges only the signed sponsor', async () => {
  const f = fixture();
  try {
    let submitted: NettingExternalExecutionIntent | undefined;
    let observed: NettingExternalExecutionEvidence | undefined;
    let entries = 0;
    let exits = 0;
    const runtime = new HyperliquidPoolNettingExecution(f.store, {
      async execute({ intent }) { entries++; submitted = intent; throw new Error('response unknown'); },
      async observe() { return observed; },
      cancelUnsubmitted() { return false; },
    }, {
      async execute({ intent }) { exits++; return residualProof(intent, -4n, 99n, 1n, 10_110, 122); },
      async observe() { throw new Error('unexpected exit observation'); },
      cancelUnsubmitted() { return false; },
    }, {
      async closePrices() { return { observedAtMs: f.clock(), prices: [{ instrumentId: 'btc-perp', buyLimitPriceTicks: 100n, sellLimitPriceTicks: 99n }] }; },
      async funding() { return []; },
    }, f.clock);
    const service = new HyperliquidPoolEpochService(f.store, f.reads, runtime, f.clock);
    await service.prepare(f.plan, await f.signatures());
    await assert.rejects(service.enter(f.plan.id), /response unknown/);
    assert.equal(await service.recover(f.plan.id), 'PENDING');
    await assert.rejects(service.enter(f.plan.id), /recovering epoch/);
    assert.throws(() => f.store.recordEpochStage(f.plan.id, 'ENTRY_RESULT', {}), /locked entry allocation/);
    observed = residualProof(submitted!, 4n, 100n, 1n, 10_001, 120);
    f.setState(10_120, 2_994n);
    assert.equal(await service.recover(f.plan.id), 'RECOVERED');
    assert.equal(await service.recover(f.plan.id), 'RECOVERED');
    assert.equal(entries, 1);
    assert.equal(exits, 1);
    assert.equal(f.store.members().find(row => row.owner === f.owners[2])!.balanceQuoteAtoms, 994n);
    assert.equal(f.store.members().find(row => row.owner === f.owners[0])!.balanceQuoteAtoms, 1_000n);
  } finally { f.store.close(); }
});

test('funded sponsor covers only the consented shortfall and exhaustion cannot release the pool', async () => {
  const f = fixture();
  try {
    await f.service.prepare(f.plan, await f.signatures());
    const covered = reconcileHyperliquidPoolEpoch(f.store.binding, f.plan, f.closure(200n), 3_000n, 3_993n);
    assert.equal(covered.recoveryLossQuoteAtoms, 497n);
    assert.equal(covered.allocations.find(row => row.owner === f.owners[1])?.pnlQuoteAtoms, -500n);
    assert.equal(covered.allocations.find(row => row.owner === f.owners[2])?.pnlQuoteAtoms, -497n);
    f.finish(f.closure(400n), 5_993n);
    await assert.rejects(f.service.reconcile(f.plan.id), /reserve exhausted/);
    assert.equal(f.store.totalQuoteAtoms(), 3_000n);
    assert.equal(f.store.pending()?.id, f.plan.id);
  } finally { f.store.close(); }
});

test('changing signed mandate terms, missing consent, repeated funding or unreconciled equity fails closed', async () => {
  const f = fixture();
  try {
    const signatures = await f.signatures();
    await assert.rejects(f.service.prepare({ ...f.plan, closeAfterMs: 11_001 }, signatures), /signature/);
    await assert.rejects(f.service.prepare(f.plan, signatures.slice(0, 2)), /every owner/);
    assert.equal(f.store.pending(), undefined);
    const closed = f.closure();
    assert.throws(() => reconcileHyperliquidPoolEpoch(f.store.binding, f.plan,
      { ...closed, funding: [...closed.funding, ...closed.funding] }, 3_000n, 3_090n), /funding/);
    assert.throws(() => reconcileHyperliquidPoolEpoch(f.store.binding, f.plan, closed, 3_000n, 3_094n), /reconcile/);
    assert.throws(() => reconcileHyperliquidPoolEpoch(f.store.binding, f.plan,
      { ...closed, account: f.owners[0]! }, 3_000n, 3_093n), /identity/);
  } finally { f.store.close(); }
});

test('pool reader binds venue assets, rejects stale books and refuses truncated funding history', async () => {
  const f = fixture();
  try {
    let stale = false;
    let truncated = false;
    const reads = createHyperliquidPoolExecutionReads(f.store.binding.poolAccount, f.plan.entryPolicy,
      [{ instrumentId: 'btc-perp', coin: 'BTC', assetId: 0, sizeDecimals: 8 }], f.store.binding.collateralTokenId, {
        async meta() { return { collateralToken: 0, universe: [{ name: 'BTC', szDecimals: 8 }], marginTables: [] }; },
        async spotMeta() { return { tokens: [{ index: 0, tokenId: f.store.binding.collateralTokenId, name: 'USDC', isCanonical: true }], universe: [] }; },
        async l2Book() { return { coin: 'BTC', time: stale ? 1 : f.clock(),
          levels: [[{ px: '10000', sz: '1' }], [{ px: '10100', sz: '1' }]] }; },
        async userFunding() {
          const entry = { time: 10_000, hash: hash(300), delta: { type: 'funding', coin: 'BTC', szi: '0.0000001', usdc: '-0.000003' } };
          return truncated ? Array.from({ length: 500 }, () => entry) : [entry];
        },
      } as unknown as Parameters<typeof createHyperliquidPoolExecutionReads>[4], f.clock);
    assert.deepEqual((await reads.closePrices(f.plan.exitPolicy)).prices,
      [{ instrumentId: 'btc-perp', buyLimitPriceTicks: 101n, sellLimitPriceTicks: 100n }]);
    stale = true;
    await assert.rejects(reads.closePrices(f.plan.entryPolicy), /freshness/);
    assert.equal((await reads.funding(f.plan, 9_000, 10_000))[0]?.quoteDeltaAtoms, -3n);
    truncated = true;
    await assert.rejects(reads.funding(f.plan, 9_000, 10_000), /truncated/);
  } finally { f.store.close(); }
});

test('pool operator HTTP keeps trading behind authentication and exact owner-signed commands', async () => {
  const f = fixture();
  const token = 'ab'.repeat(32);
  const controller = createHyperliquidPoolController({ store: f.store, epochs: f.service,
    funding: new HyperliquidPoolFundingService(f.store, f.reads, f.clock),
    withdrawals: new HyperliquidPoolWithdrawalService(f.store, f.reads,
      { async send() { assert.fail('this test must not dispatch withdrawals'); } }, f.clock) }, token);
  const server = createServer((req, res) => { void controller.handle(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${origin}/v1/pool/state`)).status, 403);
    assert.equal((await fetch(`${origin}/v1/pool/state`, { headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.example' } })).status, 403);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${origin}/v1/pool/epoch`, { method: 'POST', headers,
      body: stringifyProtocolJson({ plan: f.plan, authorizations: await f.signatures() }) })).status, 200);
    assert.equal(f.store.pending()?.id, f.plan.id);
    assert.equal((await fetch(`${origin}/v1/pool/advance`, { method: 'POST', headers,
      body: stringifyProtocolJson({ extra: 'refused' }) })).status, 409);
    await assert.rejects(loadHyperliquidPoolRuntime({ NARYX_HYPERLIQUID_POOL_ENABLED: 'true', NARYX_HYPERLIQUID_POOL_ENVIRONMENT: 'MAINNET' }), /testnet pool activation/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.store.close();
  }
});

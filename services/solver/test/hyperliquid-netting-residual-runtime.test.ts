import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { OrderSuccessResponse } from '@nktkas/hyperliquid/api/exchange';
import {
  assetRef,
  adapterRef,
  domainRef,
  netObligations,
  nettingExternalExecutionIntent,
  nettingPolicyManifest,
  toHex,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidNettingResidualSqliteDurableJournal,
  HyperliquidNettingResidualTestnetRuntime,
  HyperliquidNettingResidualTestnetSubmissionService,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidSqliteDurableJournal,
  type HyperliquidNettingResidualEvidenceCollectInput,
  type HyperliquidServerSigner,
  type HyperliquidTestnetExchangeTransport,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const base = assetRef('btc', id(1), 2);
const quote = assetRef('usdc', id(2), 2);
const adapter = adapterRef({
  adapterId: 'hypercore-perp',
  adapterManifestVersion: 1,
  adapterManifestHash: id(3),
});
const venue = versionedManifestRef('hypercore', 1, id(4));
const market = versionedManifestRef('btc-perp', 1, id(5));
const policyInput: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: 'testnet',
  executionClassId: 'hypercore-netting',
  executionClassVersion: 1,
  executionClassManifestHash: id(6),
  settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
  allocationRule: 'PRO_RATA_SEQUENCE',
  externalExecutionMode: 'EXACT_NET_ONLY',
  clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
  maximumObligations: 8,
  maximumBatchWindowMilliseconds: 1_000n,
  instruments: [{
    instrumentId: 'btc-perp',
    domain: domainRef('hypercore:testnet', 1, id(7)),
    adapter,
    venue,
    market,
    quantityAsset: base,
    quoteAsset: quote,
    legFamily: 'PERP_OPEN',
    quantityIncrementAtoms: 100n,
    priceTickQuoteAtoms: 250n,
  }],
};
const policy = nettingPolicyManifest(policyInput);
const result = netObligations([{
  ownerId: 'buyer',
  strategyOrderHash: id(10),
  packageOrderId: id(11),
  settlementReadinessHash: id(12),
  legId: 'perp',
  instrumentId: 'btc-perp',
  signedQuantityAtoms: 100n,
  limitPriceTicks: 1n,
  sequence: 1n,
}], policy);
const intent = nettingExternalExecutionIntent(result, policy, {
  instrumentId: 'btc-perp',
  validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
  validUntilValue: 2_000_000_000_000n,
  sourceFeeCaps: [{
    obligationId: result.allocations[0]!.obligationId,
    maximumFeeQuoteAtoms: 2n,
  }],
});
const marketBinding = {
  adapter,
  venue,
  market,
  assetId: 3,
  sizeDecimals: 2,
  maximumPriceDecimals: 6,
};

function signer(): HyperliquidServerSigner {
  return {
    signerScope: HYPERLIQUID_SERVER_SIGNER_SCOPE,
    address: agentWallet,
    async signTypedData(_args: unknown) {
      return `0x${'01'.repeat(64)}1b`;
    },
  } as HyperliquidServerSigner;
}

class FakeExchangeTransport implements HyperliquidTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_EXCHANGE_URL;
  readonly requests: unknown[] = [];

  request<T>(endpoint: 'exchange', payload: unknown): Promise<T> {
    assert.equal(endpoint, 'exchange');
    this.requests.push(payload);
    const action = (payload as { action: { orders: readonly [{ c: `0x${string}` }] } }).action;
    const response: OrderSuccessResponse = {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [{
            filled: { totalSz: '1', avgPx: '2.5', oid: 1, cloid: action.orders[0].c },
          }],
        },
      },
    };
    return Promise.resolve(response as T);
  }
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-net-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.sqlite');
  const baseJournal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  baseJournal.close();
  return path;
}

test('executes one durable residual and resumes evidence without rebroadcast', async (t) => {
  const journal = new HyperliquidNettingResidualSqliteDurableJournal({
    databasePath: databasePath(t),
  });
  t.after(() => journal.close());
  const transport = new FakeExchangeTransport();
  const submission = new HyperliquidNettingResidualTestnetSubmissionService(
    journal,
    new HyperliquidSdkTestnetOrderSubmitter(signer(), transport),
  );
  let nowMs = 1_999_999_999_900;
  const evidence = {
    async collect(input: HyperliquidNettingResidualEvidenceCollectInput) {
      return {
        status: 'COMPLETE' as const,
        observation: {
          clientOrderId: input.plan.clientOrderId,
          terminalStatus: 'FILLED' as const,
          filledSignedQuantityAtoms: 100n,
          grossQuoteAtoms: 250n,
          feeQuoteAtoms: 1n,
          submittedAtMs: BigInt(input.window.startTimeMs),
          observedAtMs: BigInt(input.window.endTimeMs),
          executionReferenceHash: id(20),
          authoritativeEvidenceHash: id(21),
        },
        rawResponseCommitments: [],
      };
    },
  };
  const runtime = new HyperliquidNettingResidualTestnetRuntime(
    { resolve: () => ({
      instrument: policy.instruments[0]!,
      marketBinding,
      evidenceBinding: {
        assetId: 3,
        marketKind: 'PERPETUAL',
        baseFeeToken: 'BTC',
        quoteFeeToken: 'USDC',
      },
    }) },
    journal,
    submission,
    evidence,
    {
      account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
      agentWallet,
      signerLeaseId: 'solver-runtime-1',
      vaultAddress: tradingAccount,
      maximumEvidenceAgeMs: 1_000,
      maximumSnapshotSkewMs: 100,
      clock: () => nowMs,
    },
  );
  const executionInput = { intent, idempotencyKey: toHex(intent.intentHash) };

  const first = await runtime.execute(executionInput);
  assert.equal(first.outcome, 'EXACT_FILLED');
  assert.equal(first.filledSignedQuantityAtoms, 100n);
  assert.equal(transport.requests.length, 1);

  nowMs = Number(intent.validUntilValue + 1n);
  const resumed = await runtime.execute(executionInput);
  assert.equal(resumed.outcome, 'EXACT_FILLED');
  assert.equal(resumed.filledSignedQuantityAtoms, first.filledSignedQuantityAtoms);
  assert.equal(resumed.submittedAtValue, first.submittedAtValue);
  assert.equal(resumed.observedAtValue, intent.validUntilValue + 1n);
  assert.equal(transport.requests.length, 1);

  await assert.rejects(
    runtime.execute({ intent, idempotencyKey: id(99) }),
    (error: unknown) => error instanceof Error
      && error.name === 'HyperliquidNettingResidualRuntimeError'
      && error.message.includes('idempotency'),
  );
  await assert.rejects(
    runtime.execute({
      intent: { ...intent, quantityAtoms: intent.quantityAtoms + 100n },
      idempotencyKey: toHex(intent.intentHash),
    }),
    /idempotency differs from the intent/,
  );
  assert.equal(transport.requests.length, 1);
});

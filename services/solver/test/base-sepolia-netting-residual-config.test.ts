import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  stringifyProtocolJson,
  versionedManifestRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { getAddress } from 'viem';
import { BaseSepoliaNettingResidualLaneRegistry } from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');
const base = assetRef('weth', id(1), 18);
const quote = assetRef('tusdc', id(2), 6);
const domain = domainRef('eip155:84532', 2, id(3));
const adapter = adapterRef({ adapterId: 'base-test-perp', adapterManifestVersion: 1, adapterManifestHash: id(4) });
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
const netting = netObligations([{
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
const intent = nettingExternalExecutionIntent(netting, policy, {
  instrumentId: 'weth-perp',
  validUntilUnit: 'EVM_UNIX_SECONDS',
  validUntilValue: 2_000_000_000n,
  sourceFeeCaps: [{ obligationId: netting.allocations[0]!.obligationId, maximumFeeQuoteAtoms: 2_000_000n }],
});

test('loads a Base policy and derives bounded solver margin from signed notional', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-base-net-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'runtime.json');
  writeFileSync(path, stringifyProtocolJson({
    version: 1,
    environment: 'BASE_SEPOLIA',
    policy: policyInput,
    bindings: [{
      instrumentId: 'weth-perp',
      marketAddress: getAddress(`0x${'21'.repeat(20)}`),
      expiry: 4_294_967_295,
      marginBps: 2_000n,
      maximumMarginQuoteAtoms: 1_000_000_000n,
    }],
  }));
  const executionAccount = getAddress(`0x${'20'.repeat(20)}`);
  const lane = new BaseSepoliaNettingResidualLaneRegistry(path, executionAccount).resolve(intent);
  assert.equal(lane.binding.executionAccount, executionAccount);
  assert.equal(lane.binding.chainId, 84_532);
  assert.equal(lane.marginQuoteAtoms, 420_000_000n);
});

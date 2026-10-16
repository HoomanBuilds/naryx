import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef } from '@naryx/protocol-types';
import type { EvmStrategyCallPolicy } from '@naryx/adapter-evm';
import type { Address, Hex } from 'viem';
import { EvmStrategyFundingRequiredError, evmTestnetRiskIdentity, evmTestnetRiskTerms } from '../src/evm-risk-terms.js';
import type { EvmOptionSpreadReadPort } from '../src/evm-option-spread-quote.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const ADAPTER = '0x3333333333333333333333333333333333333333' as Address;
const SUBJECT_A = `0x${'11'.repeat(32)}` as Hex;
const SUBJECT_B = `0x${'22'.repeat(32)}` as Hex;
const MANIFEST = `0x${'33'.repeat(32)}` as Hex;

function call(subjectId: Hex, notional: bigint, approvalAtoms: bigint): EvmStrategyCallPolicy {
  return {
    legId: subjectId,
    adapter: { subjectId, manifestVersion: 1, manifestHash: MANIFEST },
    expectedAdapterAddress: ADAPTER,
    expectedAdapterCodeHash: MANIFEST,
    riskIncreasing: true,
    approvalToken: TOKEN,
    approvalAtoms,
    grossNotionalAtoms: notional,
  };
}

function chain(balance: bigint): EvmOptionSpreadReadPort {
  return {
    chainId: async () => 84_532n,
    latestBlockTimestamp: async () => 1_000n,
    codeHash: async () => MANIFEST,
    readContract: async () => balance,
  };
}

test('risk terms use exact adapter exposures and only available quote balance as recovery capacity', async () => {
  const result = await evmTestnetRiskTerms({
    chain: chain(10_000_000n), chainId: 84_532n, templateId: 'treasury-inventory-hedge-v1',
    account: ACCOUNT, accountingToken: TOKEN,
    totalGrossNotionalAtoms: 4_000_000n, marginQuoteAtoms: 2_000_000n, riskIncreasing: true,
    callPolicies: [call(SUBJECT_B, 3_000_000n, 1_000_000n), call(SUBJECT_A, 1_000_000n, 2_000_000n)],
  });
  assert.deepEqual(result.dependencyExposures, [
    { dependencyId: SUBJECT_A, grossQuoteAtoms: 1_000_000n },
    { dependencyId: SUBJECT_B, grossQuoteAtoms: 3_000_000n },
  ]);
  assert.equal(result.reservedRecoveryQuoteAtoms, 7_000_000n);
  assert.equal(result.netQuoteAtoms, 4_000_000n);
  assert.equal(result.marginQuoteAtoms, 2_000_000n);
});

test('risk terms refuse insufficient post-spend balance and margin', async () => {
  const input = {
    chain: chain(1_999_999n), chainId: 84_532n, templateId: 'treasury-inventory-hedge-v1',
    account: ACCOUNT, accountingToken: TOKEN,
    totalGrossNotionalAtoms: 2_000_000n, marginQuoteAtoms: 1_000_000n,
    riskIncreasing: true, callPolicies: [call(SUBJECT_A, 2_000_000n, 1_000_000n)],
  } as const;
  await assert.rejects(evmTestnetRiskTerms(input), (error: unknown) => {
    assert.ok(error instanceof EvmStrategyFundingRequiredError);
    assert.deepEqual(error.funding, {
      chainId: 84_532, strategyAccount: ACCOUNT, token: TOKEN,
      balanceAtoms: '1999999', requiredAtoms: '2000000', deficitAtoms: '1',
    });
    return true;
  });
  await assert.rejects(evmTestnetRiskTerms({ ...input, chain: chain(10_000_000n), marginQuoteAtoms: 999_999n }), /margin is below/);
  await assert.rejects(evmTestnetRiskTerms({ ...input, chain: chain(0n), marginQuoteAtoms: 999_999n }), /margin is below/);
});

test('risk identity rejects unsupported chains and duplicate dependencies', () => {
  assert.throws(() => evmTestnetRiskIdentity({ chainId: 1n, templateId: 'treasury-inventory-hedge-v1', dependencyIds: [SUBJECT_A] }), /unsupported/);
  assert.throws(() => evmTestnetRiskIdentity({ chainId: 84_532n, templateId: 'treasury-inventory-hedge-v1', dependencyIds: [SUBJECT_A, SUBJECT_A] }), /repeat/);
});

test('risk terms check separately denominated input funding before quote reserves', async () => {
  const input = {
    chain: chain(1n), chainId: 84_532n, templateId: 'option-spread-v1',
    account: ACCOUNT, accountingToken: TOKEN, totalGrossNotionalAtoms: 20_000_000n,
    marginQuoteAtoms: 10_000_000n, riskIncreasing: true, callPolicies: [call(SUBJECT_A, 20_000_000n, 0n)],
    inputAssetFunding: { token: ADAPTER, asset: assetRef('base-test-token', '44'.repeat(32), 18), requiredAtoms: 10n ** 16n },
  } as const;
  await assert.rejects(evmTestnetRiskTerms(input), (error: unknown) => {
    assert.ok(error instanceof EvmStrategyFundingRequiredError);
    assert.equal(error.funding.assetId, 'base-test-token');
    assert.equal(error.funding.decimals, 18);
    assert.equal(error.funding.token, ADAPTER);
    assert.equal(error.funding.deficitAtoms, '9999999999999999');
    return true;
  });
  await assert.rejects(evmTestnetRiskTerms({ ...input, inputAssetFunding: { ...input.inputAssetFunding, token: TOKEN } }), /distinct/);
});

test('risk identity matches the reviewed Base Sepolia treasury policy', () => {
  const result = evmTestnetRiskIdentity({
    chainId: 84_532n,
    templateId: 'treasury-inventory-hedge-v1',
    dependencyIds: [
      '0xaa7f9ac8782bb6a6934c37b109e681dbe2e2229311d6a936eeef2ed6b3e90415',
      '0xcca48e9565467e219bb64067e9fec3b4e339e67e8d3013b2fbe093137e432267',
    ],
  });
  assert.equal(result.riskDomainId, '0xc108c822ece289c3c550f5c83f4904a355b0e3865801f80d4faff0d5baaaa26e');
  assert.equal(result.policyManifestHash, '0x1976088ef045a8769ff1ccf7d3c18e5fa039df5045be7cf8156e9dfc7a78d26b');
});

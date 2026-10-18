import { hashTypedData, keccak256, toHex } from 'viem';
import { stringifyProtocolJson } from '@naryx/protocol-types';

export interface TestPoolConfig {
  readonly environment: 'TESTNET';
  readonly custody: 'CUSTODIAL_TESTNET_POOL_V1' | 'CUSTODIAL_TESTNET_POOL_V2';
  readonly poolAccount: `0x${string}`;
  readonly bindingHash: `0x${string}`;
  readonly policyHash: `0x${string}`;
  readonly maximumTotalQuoteAtoms: bigint;
  readonly quoteDecimals: 6;
}

export function testPoolConfig(value: unknown): TestPoolConfig {
  const config = value as TestPoolConfig;
  if (!config || config.environment !== 'TESTNET' || !['CUSTODIAL_TESTNET_POOL_V1', 'CUSTODIAL_TESTNET_POOL_V2'].includes(config.custody)
    || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(config.poolAccount)
    || ![config.bindingHash, config.policyHash].every(hash => /^0x(?!0{64}$)[0-9a-f]{64}$/.test(hash))
    || config.quoteDecimals !== 6 || typeof config.maximumTotalQuoteAtoms !== 'bigint'
    || config.maximumTotalQuoteAtoms <= 0n || config.maximumTotalQuoteAtoms > 100_000_000n) throw new Error('Invalid test pool configuration');
  return config;
}

export function testPoolRequest(config: TestPoolConfig, owner: `0x${string}`, action: string, payload: unknown, expiresAtMs: number) {
  testPoolConfig(config);
  if (!/^0x(?!0{40}$)[0-9a-f]{40}$/.test(owner)
    || !['member', 'deposit', 'withdrawal-submit', 'withdrawal-complete', 'withdrawal-release'].includes(action)
    || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw new Error('Invalid test pool request');
  return { domain: { name: 'Naryx Testnet Pool Request', version: '1', chainId: 421614, verifyingContract: config.poolAccount },
    primaryType: 'PoolRequest', types: { PoolRequest: [
      { name: 'owner', type: 'address' }, { name: 'bindingHash', type: 'bytes32' },
      { name: 'action', type: 'string' }, { name: 'payloadHash', type: 'bytes32' }, { name: 'expiresAtMs', type: 'uint48' },
    ] }, message: { owner, bindingHash: config.bindingHash, action,
      payloadHash: keccak256(toHex(stringifyProtocolJson(payload))), expiresAtMs } } as const;
}

export function testPoolConsent(config: TestPoolConfig, owner: `0x${string}`) {
  testPoolConfig(config);
  return { domain: { name: 'Naryx Custodial Testnet Pool', version: '1', chainId: 421614, verifyingContract: config.poolAccount },
    primaryType: 'PoolConsent', types: { PoolConsent: [
      { name: 'owner', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'bindingHash', type: 'bytes32' },
      { name: 'policyHash', type: 'bytes32' }, { name: 'custodyMode', type: 'string' },
    ] }, message: { owner, pool: config.poolAccount, bindingHash: config.bindingHash,
      policyHash: config.policyHash, custodyMode: config.custody } } as const;
}

export function testPoolWithdrawal(config: TestPoolConfig,
  request: Readonly<{ id: string; owner: `0x${string}`; debitQuoteAtoms: bigint; expiresAtMs: number }>) {
  testPoolConfig(config);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.id) || typeof request.debitQuoteAtoms !== 'bigint'
    || request.debitQuoteAtoms <= 0n || request.debitQuoteAtoms >= (1n << 128n)
    || !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= 0) throw new Error('Invalid pool withdrawal');
  return { domain: { name: 'Naryx Custodial Testnet Pool', version: '1', chainId: 421614, verifyingContract: config.poolAccount },
    primaryType: 'PoolWithdrawal', types: { PoolWithdrawal: [
      { name: 'owner', type: 'address' }, { name: 'pool', type: 'address' }, { name: 'bindingHash', type: 'bytes32' },
      { name: 'policyHash', type: 'bytes32' }, { name: 'requestId', type: 'string' },
      { name: 'debitQuoteAtoms', type: 'uint128' }, { name: 'expiresAtMs', type: 'uint48' },
    ] }, message: { owner: request.owner, pool: config.poolAccount, bindingHash: config.bindingHash,
      policyHash: config.policyHash, requestId: request.id, debitQuoteAtoms: request.debitQuoteAtoms, expiresAtMs: request.expiresAtMs } } as const;
}

export function verifyTestPoolChallenge(expected: ReturnType<typeof testPoolRequest> | ReturnType<typeof testPoolConsent>
  | ReturnType<typeof testPoolWithdrawal>, received: unknown): void {
  if (stringifyProtocolJson(expected) !== stringifyProtocolJson(received)) throw new Error('Pool signing payload differs from your request');
  if (expected.primaryType === 'PoolRequest') hashTypedData(expected);
  else if (expected.primaryType === 'PoolConsent') hashTypedData(expected);
  else hashTypedData(expected);
}

import { keccak256, toHex, verifyTypedData } from 'viem';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import type { HyperliquidPooledCollateralStore } from './hyperliquid-pooled-collateral-store.js';
import { poolBindingHash, poolConsentTypedData, poolWithdrawalTypedData,
  type HyperliquidPoolFundingService, type PoolWithdrawalRequest } from './hyperliquid-pool-funding.js';
import type { HyperliquidPoolWithdrawalService } from './hyperliquid-pool-withdrawal.js';
import type { HyperliquidPoolEpochService, HyperliquidPoolEpochPlan } from './hyperliquid-pool-epoch.js';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const ACTIONS = ['member', 'deposit', 'withdrawal-submit', 'withdrawal-complete', 'withdrawal-release'] as const;
type Action = typeof ACTIONS[number];
interface Services {
  readonly store: HyperliquidPooledCollateralStore;
  readonly funding: HyperliquidPoolFundingService;
  readonly withdrawals: HyperliquidPoolWithdrawalService;
  readonly epochs?: HyperliquidPoolEpochService;
}

function fields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid pool browser command');
}

export function poolBrowserTypedData(store: HyperliquidPooledCollateralStore, owner: `0x${string}`,
  action: Action, payload: unknown, expiresAtMs: number) {
  return { domain: { name: 'Naryx Testnet Pool Request', version: '1', chainId: 421614,
    verifyingContract: store.binding.poolAccount }, primaryType: 'PoolRequest' as const,
  types: { PoolRequest: [
    { name: 'owner', type: 'address' }, { name: 'bindingHash', type: 'bytes32' },
    { name: 'action', type: 'string' }, { name: 'payloadHash', type: 'bytes32' }, { name: 'expiresAtMs', type: 'uint48' },
  ] }, message: { owner, bindingHash: poolBindingHash(store.binding), action,
    payloadHash: keccak256(toHex(stringifyProtocolJson(payload))), expiresAtMs } } as const;
}

export function createPoolBrowserCommands(services: Services, clock = Date.now) {
  const { store, funding, withdrawals } = services;
  const ownerOf = (value: unknown): `0x${string}` => {
    if (typeof value !== 'string' || !ADDRESS.test(value)
      || !store.acceptsOwner(value)) throw new Error('Wallet is not eligible for this pool');
    return value as `0x${string}`;
  };
  const withdrawalOf = (id: unknown, owner: string) => {
    if (typeof id !== 'string') throw new Error('Withdrawal identity required');
    const operation = store.operation(id);
    if (operation?.kind !== 'WITHDRAWAL' || (operation.payload as { owner?: string }).owner !== owner) {
      throw new Error('Withdrawal does not belong to this wallet');
    }
    return id;
  };
  return async (command: string, body: unknown): Promise<unknown> => {
    if (command === 'config') {
      fields(body, []);
      return { environment: 'TESTNET', custody: `CUSTODIAL_TESTNET_POOL_V${store.binding.version}`, poolAccount: store.binding.poolAccount,
        bindingHash: poolBindingHash(store.binding), policyHash: store.binding.policyHash,
        maximumTotalQuoteAtoms: store.binding.maximumTotalQuoteAtoms, quoteDecimals: 6,
        ...(store.binding.version === 3 ? { maximumOwnerQuoteAtoms: store.binding.maximumOwnerQuoteAtoms } : {}),
        access: store.binding.version !== 1 ? 'PUBLIC_TESTNET' : 'DEDICATED_TEST_ACCOUNTS',
        availableQuoteAtoms: store.binding.maximumTotalQuoteAtoms > store.totalQuoteAtoms()
          ? store.binding.maximumTotalQuoteAtoms - store.totalQuoteAtoms() : 0n };
    }
    if (command === 'consent') {
      fields(body, ['owner']);
      return poolConsentTypedData(store.binding, ownerOf(body.owner));
    }
    if (command === 'enroll') {
      fields(body, ['owner', 'signature']);
      await funding.enroll(ownerOf(body.owner), body.signature as `0x${string}`);
      return { status: 'ENROLLED' };
    }
    if (command === 'epoch-submit') {
      fields(body, ['plan', 'authorizations']);
      if (store.binding.version === 1 || !services.epochs) throw new Error('Public pooled execution is unavailable');
      await services.epochs.prepare(body.plan as HyperliquidPoolEpochPlan,
        body.authorizations as Parameters<HyperliquidPoolEpochService['prepare']>[1]);
      return { status: 'AUTHORIZED', operationId: (body.plan as HyperliquidPoolEpochPlan).id };
    }
    if (command === 'withdrawal-challenge' || command === 'withdrawal') {
      fields(body, command === 'withdrawal' ? ['request', 'signature'] : ['request']);
      fields(body.request, ['id', 'owner', 'debitQuoteAtoms', 'expiresAtMs']);
      ownerOf(body.request.owner);
      const request = body.request as unknown as PoolWithdrawalRequest;
      if (command === 'withdrawal-challenge') {
        if (typeof request.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.id)
          || typeof request.debitQuoteAtoms !== 'bigint' || request.debitQuoteAtoms <= 0n || request.debitQuoteAtoms >= (1n << 128n)
          || !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= clock() || request.expiresAtMs > clock() + 600_000) {
          throw new Error('Invalid withdrawal challenge');
        }
        return poolWithdrawalTypedData(store.binding, request);
      }
      return funding.prepareWithdrawal(request, body.signature as `0x${string}`);
    }
    fields(body, command === 'challenge' ? ['owner', 'action', 'payload', 'expiresAtMs']
      : ['owner', 'action', 'payload', 'expiresAtMs', 'signature']);
    if (command !== 'challenge' && command !== 'execute') throw new Error('Unknown browser command');
    const owner = ownerOf(body.owner);
    if (!ACTIONS.includes(body.action as Action) || !Number.isSafeInteger(body.expiresAtMs)
      || (body.expiresAtMs as number) <= clock() || (body.expiresAtMs as number) > clock() + 120_000) {
      throw new Error('Invalid or expired pool request');
    }
    const action = body.action as Action;
    const keys = action === 'member' ? [] : action === 'deposit' ? ['id', 'transferHash', 'transferTimeMs']
      : action === 'withdrawal-complete' ? ['id', 'transferHash', 'transferTimeMs'] : ['id'];
    fields(body.payload, keys);
    const typedData = poolBrowserTypedData(store, owner, action, body.payload, body.expiresAtMs as number);
    if (command === 'challenge') return typedData;
    if (!await verifyTypedData({ ...typedData, address: owner, signature: body.signature as `0x${string}` })) {
      throw new Error('Wallet signature does not authorize this request');
    }
    switch (action) {
      case 'member': {
        const member = store.members().find(item => item.owner === owner);
        const poolRemaining = store.binding.maximumTotalQuoteAtoms - store.totalQuoteAtoms();
        const ownerRemaining = store.binding.version === 3
          ? store.binding.maximumOwnerQuoteAtoms! - (member?.balanceQuoteAtoms ?? 0n) : poolRemaining;
        const remaining = ownerRemaining < poolRemaining ? ownerRemaining : poolRemaining;
        return { owner, enrolled: member !== undefined, balanceQuoteAtoms: member?.balanceQuoteAtoms ?? 0n,
          ...(store.binding.version === 3 ? { availableDepositQuoteAtoms: remaining > 0n ? remaining : 0n } : {}),
          poolBusy: store.pending() !== undefined, observedAtMs: clock(), operations: store.ownerFundingOperations(owner) };
      }
      case 'deposit':
        await funding.creditDeposit({ ...body.payload, owner } as Parameters<typeof funding.creditDeposit>[0]);
        return { status: 'CREDITED' };
      case 'withdrawal-submit': return { status: await withdrawals.submit(withdrawalOf(body.payload.id, owner)) };
      case 'withdrawal-complete':
        withdrawalOf(body.payload.id, owner);
        await funding.completeWithdrawal(body.payload as Parameters<typeof funding.completeWithdrawal>[0]);
        return { status: 'COMPLETE' };
      case 'withdrawal-release':
        await funding.releaseExpiredUnsubmittedWithdrawal(withdrawalOf(body.payload.id, owner));
        return { status: 'RELEASED' };
    }
  };
}

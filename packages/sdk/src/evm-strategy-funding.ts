import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from 'viem';

export interface EvmStrategyFundingReview {
  readonly quoteHash: string;
  readonly chainId: number;
  readonly strategyAccount: Address;
  readonly token: Address;
  readonly balanceAtoms: bigint;
  readonly requiredAtoms: bigint;
  readonly deficitAtoms: bigint;
  readonly transaction: Readonly<{ to: Address; data: Hex; value: '0' }>;
}

export function reviewEvmStrategyFunding(value: unknown, expected: Readonly<{
  quoteHash: string;
  chainId: number;
  strategyAccount: string;
  maximumRequiredAtoms: bigint;
}>): EvmStrategyFundingReview {
  const fail = (): never => { throw new Error('Funding requirement does not match the selected testnet package.'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const f = value as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== 'balanceAtoms,chainId,deficitAtoms,quoteHash,requiredAtoms,strategyAccount,token,version'
    || f.version !== 1 || f.quoteHash !== expected.quoteHash || !/^[0-9a-f]{64}$/.test(expected.quoteHash)
    || (f.chainId !== 84_532 && f.chainId !== 421_614) || f.chainId !== expected.chainId
    || typeof f.strategyAccount !== 'string' || typeof f.token !== 'string'
    || !/^0x(?!0{40}$)[0-9a-f]{40}$/i.test(f.strategyAccount) || !/^0x(?!0{40}$)[0-9a-f]{40}$/i.test(f.token)) return fail();
  const atoms = (value: unknown): bigint => {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,77})$/.test(value)) return fail();
    const amount = BigInt(value);
    return amount < (1n << 256n) ? amount : fail();
  };
  const strategyAccount = getAddress(f.strategyAccount);
  const token = getAddress(f.token);
  const balanceAtoms = atoms(f.balanceAtoms);
  const requiredAtoms = atoms(f.requiredAtoms);
  const deficitAtoms = atoms(f.deficitAtoms);
  if (strategyAccount !== getAddress(expected.strategyAccount) || token === strategyAccount
    || requiredAtoms <= balanceAtoms || requiredAtoms > expected.maximumRequiredAtoms
    || deficitAtoms !== requiredAtoms - balanceAtoms) return fail();
  return Object.freeze({
    quoteHash: expected.quoteHash, chainId: f.chainId, strategyAccount, token,
    balanceAtoms, requiredAtoms, deficitAtoms,
    transaction: Object.freeze({
      to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [strategyAccount, deficitAtoms] }), value: '0',
    }),
  });
}

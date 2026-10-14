import type { EvmStrategyCallPolicy, EvmStrategyRiskTerms } from '@naryx/adapter-evm';
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import type { EvmOptionSpreadReadPort } from './evm-option-spread-quote.js';

const BALANCE_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}] as const;
const DOMAIN_PARAMETERS = parseAbiParameters('string,uint256,bytes32');
const POLICY_PARAMETERS = parseAbiParameters('string,bytes32,bytes32[]');
const MINIMUM_RECOVERY_RESERVE = 1_000_000n;
const MAXIMUM_UNWIND_MS = 3_600_000n;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function evmTestnetRiskIdentity(input: Readonly<{
  chainId: bigint;
  templateId: string;
  dependencyIds: readonly Hex[];
}>): Readonly<Pick<EvmStrategyRiskTerms, 'riskDomainId' | 'policyVersion' | 'policyManifestHash' | 'series'>> {
  requireCondition(input.chainId === 84_532n || input.chainId === 421_614n, 'unsupported EVM risk chain');
  requireCondition(input.dependencyIds.length > 0, 'risk policy needs adapter dependencies');
  const templateHash = keccak256(stringToHex(input.templateId));
  const sortedDependencies = [...new Set(input.dependencyIds.map((id) => id.toLowerCase() as Hex))].sort();
  requireCondition(sortedDependencies.length === input.dependencyIds.length, 'risk dependencies repeat');
  const riskDomainId = keccak256(encodeAbiParameters(DOMAIN_PARAMETERS, ['naryx-testnet-risk-domain-v2', input.chainId, templateHash]));
  return Object.freeze({
    riskDomainId,
    policyVersion: 1,
    policyManifestHash: keccak256(encodeAbiParameters(POLICY_PARAMETERS, ['naryx-testnet-risk-policy-v2', riskDomainId, sortedDependencies])),
    series: Object.freeze({
      seriesId: templateHash,
      manifestVersion: 1,
      manifestHash: keccak256(encodeAbiParameters(DOMAIN_PARAMETERS, ['naryx-testnet-series-v1', input.chainId, templateHash])),
    }),
  });
}

export async function evmTestnetRiskTerms(input: Readonly<{
  chain: EvmOptionSpreadReadPort;
  chainId: bigint;
  templateId: string;
  account: Address;
  accountingToken: Address;
  totalGrossNotionalAtoms: bigint;
  marginQuoteAtoms: bigint;
  riskIncreasing: boolean;
  callPolicies: readonly EvmStrategyCallPolicy[];
}>): Promise<EvmStrategyRiskTerms> {
  const accountingToken = getAddress(input.accountingToken);
  const exposures = new Map<Hex, bigint>();
  let maximumQuoteSpend = 0n;
  for (const call of input.callPolicies) {
    const dependencyId = call.adapter.subjectId.toLowerCase() as Hex;
    exposures.set(dependencyId, (exposures.get(dependencyId) ?? 0n) + (call.riskIncreasing ? call.grossNotionalAtoms : 0n));
    if (call.approvalToken !== undefined && getAddress(call.approvalToken) === accountingToken) {
      maximumQuoteSpend += call.approvalAtoms;
    }
  }
  const dependencyExposures = [...exposures.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([dependencyId, grossQuoteAtoms]) => Object.freeze({ dependencyId, grossQuoteAtoms }));
  const identity = evmTestnetRiskIdentity({
    chainId: input.chainId,
    templateId: input.templateId,
    dependencyIds: dependencyExposures.map((exposure) => exposure.dependencyId),
  });
  let reservedRecoveryQuoteAtoms = 0n;
  if (input.riskIncreasing) {
    const balance = await input.chain.readContract({
      address: accountingToken,
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [input.account],
    });
    requireCondition(typeof balance === 'bigint' && balance >= maximumQuoteSpend + MINIMUM_RECOVERY_RESERVE,
      'strategy account lacks quote balance after maximum spend for recovery');
    requireCondition(input.marginQuoteAtoms >= MINIMUM_RECOVERY_RESERVE, 'quoted margin is below the risk-policy floor');
    reservedRecoveryQuoteAtoms = balance - maximumQuoteSpend;
  }
  return Object.freeze({
    ...identity,
    accountingToken,
    grossQuoteAtoms: input.totalGrossNotionalAtoms,
    netQuoteAtoms: input.totalGrossNotionalAtoms,
    marginQuoteAtoms: input.riskIncreasing ? input.marginQuoteAtoms : 0n,
    reservedRecoveryQuoteAtoms,
    observationAgeMs: 0n,
    timeToUnwindMs: MAXIMUM_UNWIND_MS,
    dependencyExposures: Object.freeze(dependencyExposures),
  });
}

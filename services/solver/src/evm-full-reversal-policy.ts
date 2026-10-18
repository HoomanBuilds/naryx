import type { EvmMultiStrategyAccountEnvelope, EvmMultiStrategyCall } from '@naryx/adapter-evm';
import { decodeAbiParameters, getAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';

export const EXACT_SPOT_PARAMETERS = parseAbiParameters('(bytes32 packageId,bytes32 orderHash,bytes32 quoteHash,bytes32 routeHash,uint8 action,uint256 baseAtoms,uint256 quoteBoundAtoms)');
const SPOT_CLASS = keccak256(stringToHex('naryx.evm.spot-exact'));

export interface EvmRecoveryAdapterPolicy {
  readonly address: Address;
  readonly codeHash: Hex;
  readonly kind: 'SPOT';
  readonly baseToken: Address;
  readonly quoteToken: Address;
}

export interface EvmRecoveryAdapterState {
  readonly codeHash: Hex;
  readonly account: Address;
  readonly packageId: Hex;
  readonly classId: Hex;
  readonly classVersion: number;
  readonly baseToken: Address;
  readonly quoteToken: Address;
}

export interface EvmFullReversal {
  readonly maximumLossQuoteAtoms: bigint;
  readonly spotBaseDeltas: ReadonlyMap<Address, bigint>;
  readonly adapters: readonly EvmRecoveryAdapterPolicy[];
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Full reversal refused: ${message}`);
}

function sameAddress(a: Address, b: Address) { return getAddress(a) === getAddress(b); }

function identity(payload: { packageId: Hex; orderHash: Hex; quoteHash: Hex; routeHash: Hex }, envelope: EvmMultiStrategyAccountEnvelope) {
  for (const field of ['packageId', 'orderHash', 'quoteHash', 'routeHash'] as const) {
    requireCondition(payload[field] === envelope.execution[field], `leg ${field} differs from execution`);
  }
}

function adapterIdentity(a: EvmMultiStrategyCall, b: EvmMultiStrategyCall) {
  requireCondition(a.adapter.subjectId === b.adapter.subjectId && a.adapter.manifestVersion === b.adapter.manifestVersion
    && a.adapter.manifestHash === b.adapter.manifestHash, 'recovery changes adapter identity');
}

export function validateEvmFullReversal(entry: EvmMultiStrategyAccountEnvelope, recovery: EvmMultiStrategyAccountEnvelope,
  policies: readonly EvmRecoveryAdapterPolicy[]): EvmFullReversal {
  requireCondition(entry.calls.length > 0 && entry.calls.length === recovery.calls.length, 'every entry leg needs one reversal');
  requireCondition(new Set(entry.calls.map(c => getAddress(c.target))).size === entry.calls.length
    && new Set(recovery.calls.map(c => getAddress(c.target))).size === recovery.calls.length, 'repeated adapters are unsupported');
  const accountingToken = entry.execution.risk.accountingToken;
  requireCondition(sameAddress(entry.execution.fees.token, accountingToken), 'entry fees use another asset');
  let maximumSpent = entry.execution.fees.protocolFeeAtoms + entry.execution.fees.solverFeeAtoms;
  let minimumReturned = 0n;
  const spotBaseDeltas = new Map<Address, bigint>();
  const adapters: EvmRecoveryAdapterPolicy[] = [];
  for (const original of entry.calls) {
    const close = recovery.calls.find(c => sameAddress(c.target, original.target));
    const matches = policies.filter(p => sameAddress(p.address, original.target));
    requireCondition(close !== undefined && matches.length === 1, 'unqualified or missing reversal adapter');
    const policy = matches[0]!;
    requireCondition(policy.kind === 'SPOT' && /^0x[0-9a-fA-F]{64}$/.test(policy.codeHash)
      && !/^0x0{64}$/.test(policy.codeHash), 'unsupported adapter class or code hash');
    requireCondition(sameAddress(policy.quoteToken, accountingToken) && !sameAddress(policy.baseToken, accountingToken), 'adapter accounting asset mismatch');
    adapterIdentity(original, close);
    requireCondition(!close.riskIncreasing, 'reversal increases risk');
    const [buy] = decodeAbiParameters(EXACT_SPOT_PARAMETERS, original.payload);
    const [sell] = decodeAbiParameters(EXACT_SPOT_PARAMETERS, close.payload);
    identity(buy, entry); identity(sell, recovery);
    requireCondition(buy.action === 1 && sell.action === 2 && buy.baseAtoms > 0n && sell.baseAtoms === buy.baseAtoms,
      'spot recovery must sell the entire exact entry quantity');
    requireCondition(buy.quoteBoundAtoms > 0n && sell.quoteBoundAtoms > 0n, 'spot proceeds must be bounded');
    requireCondition(sameAddress(original.approvalToken, accountingToken) && original.approvalAtoms === buy.quoteBoundAtoms
      && sameAddress(close.approvalToken, policy.baseToken) && close.approvalAtoms === sell.baseAtoms, 'spot approval differs from exact reversal');
    maximumSpent += buy.quoteBoundAtoms;
    minimumReturned += sell.quoteBoundAtoms;
    const base = getAddress(policy.baseToken);
    spotBaseDeltas.set(base, (spotBaseDeltas.get(base) ?? 0n) + buy.baseAtoms);
    adapters.push(policy);
  }
  return { maximumLossQuoteAtoms: maximumSpent > minimumReturned ? maximumSpent - minimumReturned : 0n, spotBaseDeltas, adapters };
}

export function validateEvmRecoveryAdapterState(policy: EvmRecoveryAdapterPolicy, state: EvmRecoveryAdapterState,
  entry: EvmMultiStrategyAccountEnvelope) {
  requireCondition(state.codeHash === policy.codeHash && sameAddress(state.account, entry.account)
    && policy.kind === 'SPOT' && state.packageId === entry.execution.packageId && state.classId === SPOT_CLASS && state.classVersion === 1
    && sameAddress(state.baseToken, policy.baseToken) && sameAddress(state.quoteToken, policy.quoteToken), 'adapter deployment differs from qualified policy');
}

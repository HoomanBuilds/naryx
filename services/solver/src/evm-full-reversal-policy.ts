import type { EvmMultiStrategyAccountEnvelope, EvmMultiStrategyCall } from '@naryx/adapter-evm';
import { decodeAbiParameters, encodeAbiParameters, getAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';

export const EXACT_SPOT_PARAMETERS = parseAbiParameters('(bytes32 packageId,bytes32 orderHash,bytes32 quoteHash,bytes32 routeHash,uint8 action,uint256 baseAtoms,uint256 quoteBoundAtoms)');
export const RECOVERABLE_PERP_ENTRY_PARAMETERS = parseAbiParameters('uint8 mode,uint64 generation,(bytes32 packageId,bytes32 orderHash,bytes32 quoteHash,bytes32 routeHash,bytes32 expectedPrePositionHash,bytes32[2] tradeArgs,int128 expectedPostSizeWad,int128 minimumPostBalanceWad,int128 maximumPostBalanceWad,uint128 minimumPostEntryNotionalWad,uint128 maximumPostEntryNotionalWad,uint256 expectedReserveBeforeAtoms,uint256 minimumReserveAfterAtoms,uint256 maximumReserveAfterAtoms,uint256 collateralInAtoms,uint256 collateralOutAtoms,bool withdrawAll,uint256 minimumCollateralOutAtoms,uint256 maximumCollateralOutAtoms)');
export const RECOVERABLE_PERP_CLOSE_PARAMETERS = parseAbiParameters('uint8 mode,(bytes32 packageId,bytes32 orderHash,bytes32 quoteHash,bytes32 routeHash,uint64 generation,bytes32 entryPayloadHash,int128 expectedSizeWad,bytes32[2] tradeArgs,uint256 minimumCollateralOutAtoms,uint256 maximumCollateralOutAtoms)');
const POSITION_PARAMETERS = parseAbiParameters('int128 balance,int128 size,uint128 entryNotional,uint128 entrySocialLossIndex,int128 entryFundingIndex');
const EMPTY_POSITION_HASH = keccak256(encodeAbiParameters(POSITION_PARAMETERS, [0n, 0n, 0n, 0n, 0n]));
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const CLASSES = {
  SPOT: keccak256(stringToHex('naryx.evm.spot-exact')),
  RECOVERABLE_PERP: keccak256(stringToHex('naryx.evm.perp-recoverable')),
  RECOVERABLE_FUTURE: keccak256(stringToHex('naryx.evm.future-recoverable')),
} as const;

export interface EvmRecoveryAdapterPolicy {
  readonly address: Address;
  readonly codeHash: Hex;
  readonly kind: keyof typeof CLASSES;
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
  readonly derivative?: {
    readonly generation: bigint;
    readonly entryPayloadHash: Hex;
    readonly entrySizeWad: bigint;
    readonly sizeWad: bigint;
    readonly balanceWad: bigint;
    readonly entryNotionalWad: bigint;
    readonly reserveAtoms: bigint;
  };
}

export interface EvmDerivativeReversal {
  readonly generation: bigint;
  readonly entryPayloadHash: Hex;
  readonly expectedSizeWad: bigint;
}

export interface EvmFullReversal {
  readonly maximumEntryQuoteAtoms: bigint;
  readonly maximumLossQuoteAtoms: bigint;
  readonly spotBaseDeltas: ReadonlyMap<Address, bigint>;
  readonly adapters: readonly EvmRecoveryAdapterPolicy[];
  readonly derivatives: ReadonlyMap<Address, EvmDerivativeReversal>;
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
  const derivatives = new Map<Address, EvmDerivativeReversal>();
  for (const original of entry.calls) {
    const close = recovery.calls.find(c => sameAddress(c.target, original.target));
    const matches = policies.filter(p => sameAddress(p.address, original.target));
    requireCondition(close !== undefined && matches.length === 1, 'unqualified or missing reversal adapter');
    const policy = matches[0]!;
    requireCondition(Object.hasOwn(CLASSES, policy.kind) && /^0x[0-9a-fA-F]{64}$/.test(policy.codeHash)
      && !/^0x0{64}$/.test(policy.codeHash), 'unsupported adapter class or code hash');
    requireCondition(sameAddress(policy.quoteToken, accountingToken) && !sameAddress(policy.baseToken, accountingToken), 'adapter accounting asset mismatch');
    adapterIdentity(original, close);
    requireCondition(!close.riskIncreasing, 'reversal increases risk');
    if (policy.kind !== 'SPOT') {
      const [mode, generation, open] = decodeAbiParameters(RECOVERABLE_PERP_ENTRY_PARAMETERS, original.payload);
      const [closeMode, unwind] = decodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, close.payload);
      requireCondition(encodeAbiParameters(RECOVERABLE_PERP_ENTRY_PARAMETERS, [mode, generation, open]).toLowerCase() === original.payload.toLowerCase()
        && encodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, [closeMode, unwind]).toLowerCase() === close.payload.toLowerCase(), 'noncanonical derivative payload');
      identity(open, entry); identity(unwind, recovery);
      requireCondition(mode === 1 && closeMode === 2 && generation > 0n && generation === unwind.generation
        && unwind.entryPayloadHash === keccak256(original.payload), 'derivative recovery is not bound to the exact entry');
      requireCondition(original.riskIncreasing && open.expectedPostSizeWad !== 0n
        && unwind.expectedSizeWad === open.expectedPostSizeWad, 'derivative recovery must close the exact entry size');
      requireCondition(open.expectedPrePositionHash === EMPTY_POSITION_HASH && open.expectedReserveBeforeAtoms === 0n
        && open.collateralInAtoms > 0n && open.collateralOutAtoms === 0n && !open.withdrawAll
        && open.minimumCollateralOutAtoms === 0n && open.maximumCollateralOutAtoms === 0n
        && open.minimumPostBalanceWad >= 0n && open.minimumPostBalanceWad <= open.maximumPostBalanceWad
        && open.minimumPostEntryNotionalWad <= open.maximumPostEntryNotionalWad
        && open.minimumReserveAfterAtoms <= open.maximumReserveAfterAtoms, 'derivative entry must start flat with bounded collateral');
      requireCondition(unwind.minimumCollateralOutAtoms > 0n && unwind.minimumCollateralOutAtoms <= unwind.maximumCollateralOutAtoms,
        'derivative recovery proceeds must be bounded');
      requireCondition(sameAddress(original.approvalToken, accountingToken) && original.approvalAtoms === open.collateralInAtoms
        && close.approvalAtoms === 0n, 'derivative approval differs from exact reversal');
      maximumSpent += open.collateralInAtoms;
      minimumReturned += unwind.minimumCollateralOutAtoms;
      derivatives.set(getAddress(policy.address), { generation, entryPayloadHash: unwind.entryPayloadHash, expectedSizeWad: unwind.expectedSizeWad });
      adapters.push(policy);
      continue;
    }
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
  return { maximumEntryQuoteAtoms: maximumSpent, maximumLossQuoteAtoms: maximumSpent > minimumReturned ? maximumSpent - minimumReturned : 0n, spotBaseDeltas, adapters, derivatives };
}

export function validateEvmRecoveryAdapterState(policy: EvmRecoveryAdapterPolicy, state: EvmRecoveryAdapterState,
  entry: EvmMultiStrategyAccountEnvelope) {
  requireCondition(state.codeHash === policy.codeHash && sameAddress(state.account, entry.account)
    && Object.hasOwn(CLASSES, policy.kind) && state.packageId === entry.execution.packageId && state.classId === CLASSES[policy.kind] && state.classVersion === 1
    && sameAddress(state.baseToken, policy.baseToken) && sameAddress(state.quoteToken, policy.quoteToken), 'adapter deployment differs from qualified policy');
}

export function validateEvmDerivativeRecoveryState(binding: EvmDerivativeReversal, state: EvmRecoveryAdapterState, closed = false) {
  const observed = state.derivative;
  requireCondition(observed !== undefined, 'derivative position evidence missing');
  const flat = observed.sizeWad === 0n && observed.balanceWad === 0n && observed.entryNotionalWad === 0n
    && observed.reserveAtoms === 0n && observed.entrySizeWad === 0n && observed.entryPayloadHash === ZERO;
  if (closed) {
    requireCondition(flat && observed.generation === binding.generation, 'recovery did not flatten the exact derivative generation');
    return;
  }
  requireCondition((flat && (observed.generation + 1n === binding.generation || observed.generation === binding.generation))
    || (observed.generation === binding.generation && observed.entryPayloadHash === binding.entryPayloadHash
      && observed.entrySizeWad === binding.expectedSizeWad && observed.sizeWad === binding.expectedSizeWad),
  'derivative state is unrelated to this entry');
}

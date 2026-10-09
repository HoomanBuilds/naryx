import {
  bytesEqual,
  crossBatchExternalExecutionEvidence,
  nettingExternalExecutionEvidence,
  nettingInstrumentHash,
  scaleDecimals,
  type AdapterRef,
  type AssetRef,
  type CommitmentHash,
  type CrossBatchExternalExecutionEvidence,
  type CrossBatchExternalExecutionIntent,
  type DomainRef,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  encodeFunctionData,
  getAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { encodeTestPerpTradeArgs, NARYX_TEST_PERP_MARKET_ABI } from './testPerpMarket.js';

const BASE_SEPOLIA_CHAIN_ID = 84_532;
const UINT256_MAX = (1n << 256n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;

export type EvmNettingResidualIntent =
  | NettingExternalExecutionIntent
  | CrossBatchExternalExecutionIntent;

export type EvmNettingResidualEvidence =
  | NettingExternalExecutionEvidence
  | CrossBatchExternalExecutionEvidence;

export interface EvmTestPerpNettingResidualBinding {
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly chainId: 84532;
  readonly marketAddress: Address;
  readonly executionAccount: Address;
  readonly expiry: number;
}

export interface EvmTestPerpNettingResidualPlan {
  readonly version: 1;
  readonly guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT';
  readonly intentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly instrumentHash: CommitmentHash;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly requestedSignedQuantityAtoms: bigint;
  readonly sizeDeltaWad: bigint;
  readonly balanceDeltaWad: bigint;
  readonly minimumNotionalWad: bigint;
  readonly maximumNotionalWad: bigint;
  readonly maximumFeeWad: bigint;
  readonly requestExpirySeconds: bigint;
  readonly executionId: Hex;
  readonly executionAccount: Address;
  readonly transaction: Readonly<{
    chainId: 84532;
    to: Address;
    value: 0n;
    data: Hex;
  }>;
}

export interface EvmTestPerpNettingResidualObservation {
  readonly executionId: Hex;
  readonly trader: Address;
  readonly terminalStatus: 'SUCCEEDED' | 'REVERTED';
  readonly sizeDeltaWad: bigint;
  readonly notionalWad: bigint;
  readonly feeWad: bigint;
  readonly submittedAtSeconds: bigint;
  readonly observedAtSeconds: bigint;
  readonly executionReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function exactWad(value: bigint, decimals: number, context: string): bigint {
  requireCondition(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18, `${context} decimals exceed WAD precision`);
  const result = scaleDecimals(value, decimals, 18, 'TOWARD_ZERO', context);
  requireCondition(scaleDecimals(result, 18, decimals, 'TOWARD_ZERO', context) === value,
    `${context} cannot be represented exactly as WAD`);
  return result;
}

function quoteAtomsFromWad(value: bigint, decimals: number, rounding: 'FLOOR' | 'CEIL'): bigint {
  return scaleDecimals(value, 18, decimals, rounding, 'EVM residual quote amount');
}

export function compileEvmTestPerpNettingResidualPlan(input: Readonly<{
  intent: EvmNettingResidualIntent;
  instrument: NettingInstrumentPolicy;
  binding: EvmTestPerpNettingResidualBinding;
  marginQuoteAtoms: bigint;
}>): EvmTestPerpNettingResidualPlan {
  const { intent, instrument, binding } = input;
  requireCondition(intent.domain.domainId === 'eip155:84532'
    && binding.chainId === BASE_SEPOLIA_CHAIN_ID
    && sameDomain(binding.domain, intent.domain), 'only the bound Base Sepolia domain can execute this residual');
  requireCondition(intent.validUntilUnit === 'EVM_UNIX_SECONDS', 'EVM residual intent requires a Unix-second expiry');
  requireCondition(bytesEqual(nettingInstrumentHash(instrument), intent.instrumentHash)
    && instrument.instrumentId === intent.instrumentId, 'residual intent and instrument policy differ');
  requireCondition(sameAdapter(binding.adapter, intent.adapter)
    && sameAdapter(instrument.adapter, intent.adapter)
    && sameManifest(binding.venue, intent.venue)
    && sameManifest(instrument.venue, intent.venue)
    && sameManifest(binding.market, intent.market)
    && sameManifest(instrument.market, intent.market), 'residual market binding differs from the signed instrument');
  requireCondition(instrument.quantityIncrementAtoms === intent.quantityIncrementAtoms
    && instrument.priceTickQuoteAtoms === intent.priceTickQuoteAtoms
    && bytesEqual(instrument.quantityAsset.assetManifestHash, intent.quantityAsset.assetManifestHash)
    && bytesEqual(instrument.quoteAsset.assetManifestHash, intent.quoteAsset.assetManifestHash),
  'residual asset or lattice binding differs from the signed instrument');
  requireCondition(
    instrument.legFamily === 'PERP_OPEN'
      || instrument.legFamily === 'PERP_CLOSE'
      || instrument.legFamily === 'PERP_INCREASE'
      || instrument.legFamily === 'PERP_DECREASE',
    `Base test perp cannot execute residual ${instrument.legFamily}`,
  );
  requireCondition(intent.quantityAtoms % intent.quantityIncrementAtoms === 0n,
    'EVM residual quantity is off its signed increment lattice');
  requireCondition(typeof input.marginQuoteAtoms === 'bigint' && input.marginQuoteAtoms >= 0n,
    'EVM residual margin must be nonnegative');
  const riskIncreasing = instrument.legFamily === 'PERP_OPEN' || instrument.legFamily === 'PERP_INCREASE';
  requireCondition(riskIncreasing ? input.marginQuoteAtoms > 0n : input.marginQuoteAtoms === 0n,
    riskIncreasing ? 'risk-increasing EVM residual requires solver margin' : 'risk-reducing EVM residual cannot add margin');
  const signedQuantityAtoms = intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms;
  const sizeDeltaWad = exactWad(signedQuantityAtoms, intent.quantityAsset.decimals, 'EVM residual quantity');
  const balanceDeltaWad = exactWad(input.marginQuoteAtoms, intent.quoteAsset.decimals, 'EVM residual margin');
  requireCondition(sizeDeltaWad >= -INT128_MAX - 1n && sizeDeltaWad <= INT128_MAX,
    'EVM residual size exceeds int128');
  requireCondition(balanceDeltaWad <= INT128_MAX, 'EVM residual margin exceeds int128');
  const limitQuoteAtoms = (intent.quantityAtoms / intent.quantityIncrementAtoms)
    * intent.limitPriceTicks * intent.priceTickQuoteAtoms;
  const limitNotionalWad = exactWad(limitQuoteAtoms, intent.quoteAsset.decimals, 'EVM residual notional limit');
  const maximumFeeWad = exactWad(intent.maximumFeeQuoteAtoms, intent.quoteAsset.decimals, 'EVM residual fee cap');
  const minimumNotionalWad = intent.side === 'SELL' ? limitNotionalWad : 1n;
  const maximumNotionalWad = intent.side === 'BUY' ? limitNotionalWad : UINT256_MAX;
  const encodedTradeArgs = encodeTestPerpTradeArgs({
    deadline: intent.validUntilValue,
    expiry: binding.expiry,
    sizeDeltaWad,
    balanceDeltaWad,
  });
  const tradeArgs = [toHex(encodedTradeArgs[0]), toHex(encodedTradeArgs[1])] as const;
  const executionId = toHex(intent.intentHash);
  const marketAddress = getAddress(binding.marketAddress);
  const executionAccount = getAddress(binding.executionAccount);
  const data = encodeFunctionData({
    abi: NARYX_TEST_PERP_MARKET_ABI,
    functionName: 'tradeBounded',
    args: [executionId, [...tradeArgs], minimumNotionalWad, maximumNotionalWad, maximumFeeWad],
  });
  return Object.freeze({
    version: 1,
    guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT',
    intentHash: intent.intentHash,
    domain: intent.domain,
    instrumentHash: intent.instrumentHash,
    quantityAsset: intent.quantityAsset,
    quoteAsset: intent.quoteAsset,
    requestedSignedQuantityAtoms: signedQuantityAtoms,
    sizeDeltaWad,
    balanceDeltaWad,
    minimumNotionalWad,
    maximumNotionalWad,
    maximumFeeWad,
    requestExpirySeconds: intent.validUntilValue,
    executionId,
    executionAccount,
    transaction: Object.freeze({ chainId: 84532 as const, to: marketAddress, value: 0n as const, data }),
  });
}

export function evmTestPerpNettingResidualEvidence(input: Readonly<{
  intent: NettingExternalExecutionIntent;
  plan: EvmTestPerpNettingResidualPlan;
  observation: EvmTestPerpNettingResidualObservation;
}>): NettingExternalExecutionEvidence;
export function evmTestPerpNettingResidualEvidence(input: Readonly<{
  intent: CrossBatchExternalExecutionIntent;
  plan: EvmTestPerpNettingResidualPlan;
  observation: EvmTestPerpNettingResidualObservation;
}>): CrossBatchExternalExecutionEvidence;
export function evmTestPerpNettingResidualEvidence(input: Readonly<{
  intent: EvmNettingResidualIntent;
  plan: EvmTestPerpNettingResidualPlan;
  observation: EvmTestPerpNettingResidualObservation;
}>): EvmNettingResidualEvidence {
  const { intent, plan, observation } = input;
  requireCondition(plan.version === 1
    && plan.guarantee === 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_EVENT'
    && plan.domain.domainId === 'eip155:84532'
    && bytesEqual(plan.intentHash, intent.intentHash)
    && plan.requestedSignedQuantityAtoms === (intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms)
    && plan.maximumFeeWad === exactWad(intent.maximumFeeQuoteAtoms, intent.quoteAsset.decimals, 'EVM residual fee cap')
    && plan.requestExpirySeconds === intent.validUntilValue,
  'EVM residual execution plan differs from the intent');
  requireCondition(observation.executionId.toLowerCase() === plan.executionId.toLowerCase(),
    'EVM residual observation cites another execution');
  requireCondition(getAddress(observation.trader) === plan.executionAccount,
    'EVM residual observation cites another execution account');
  const succeeded = observation.terminalStatus === 'SUCCEEDED';
  if (succeeded) {
    requireCondition(observation.sizeDeltaWad === plan.sizeDeltaWad,
      'EVM residual event size differs from the plan');
    requireCondition(observation.notionalWad >= plan.minimumNotionalWad
      && observation.notionalWad <= plan.maximumNotionalWad
      && observation.feeWad <= plan.maximumFeeWad,
    'EVM residual event violates the bounded trade');
  } else {
    requireCondition(observation.sizeDeltaWad === 0n && observation.notionalWad === 0n && observation.feeWad === 0n,
      'reverted EVM residual cannot carry fill amounts');
  }
  const grossQuoteAtoms = succeeded
    ? quoteAtomsFromWad(observation.notionalWad, intent.quoteAsset.decimals, intent.side === 'BUY' ? 'CEIL' : 'FLOOR')
    : 0n;
  const feeQuoteAtoms = succeeded
    ? quoteAtomsFromWad(observation.feeWad, intent.quoteAsset.decimals, 'CEIL')
    : 0n;
  const evidence = {
    version: 1,
    intentHash: intent.intentHash,
    outcome: succeeded ? 'EXACT_FILLED' : 'REJECTED',
    filledSignedQuantityAtoms: succeeded ? plan.requestedSignedQuantityAtoms : 0n,
    grossQuoteAtoms,
    feeQuoteAtoms,
    submittedAtUnit: 'EVM_UNIX_SECONDS',
    submittedAtValue: observation.submittedAtSeconds,
    observedAtUnit: 'EVM_UNIX_SECONDS',
    observedAtValue: observation.observedAtSeconds,
    executionReferenceHash: observation.executionReferenceHash,
    authoritativeEvidenceHash: observation.authoritativeEvidenceHash,
  } as const;
  return 'clearingPlanHash' in intent
    ? crossBatchExternalExecutionEvidence(evidence, intent)
    : nettingExternalExecutionEvidence(evidence, intent);
}

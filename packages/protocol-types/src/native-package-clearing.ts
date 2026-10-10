import { absBigInt, checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { bytesEqual } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  assetRef,
  encodeAssetRef,
  encodeProtocolId,
  encodeVersionedManifestRef,
  protocolId,
  versionedManifestRef,
  type AssetRef,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

export const NATIVE_CLEARING_POLICY_VERSION = 1;
export const NATIVE_CLEARING_DOMAIN_STATE_VERSION = 1;
export const NATIVE_CLEARING_ACCOUNT_VERSION = 1;
export const NATIVE_CLEARING_MATCH_VERSION = 1;
export const NATIVE_CLEARING_DEFAULT_VERSION = 1;

const BPS = 10_000n;
const U64_BITS = 64;
const U128_BITS = 128;
const U256_BITS = 256;
const I128_BITS = 128;
const I256_BITS = 256;

export const NATIVE_CLEARING_ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 1,
  REDUCE_ONLY: 2,
  LIQUIDATABLE: 3,
  DEFAULTED: 4,
  FLAT: 5,
} as const);
export type NativeClearingAccountStatus = keyof typeof NATIVE_CLEARING_ACCOUNT_STATUS;

export interface NativeClearingPolicyInput {
  readonly version: number;
  readonly clearingDomainId: string;
  readonly strategySeries: VersionedManifestRef;
  readonly riskDomainId: string;
  readonly accountingAsset: AssetRef;
  readonly packageQuantityIncrementAtoms: bigint;
  readonly priceTickQuoteAtoms: bigint;
  readonly initialMarginQuoteAtomsPerIncrement: bigint;
  readonly maintenanceMarginQuoteAtomsPerIncrement: bigint;
  readonly maximumPositionAtoms: bigint;
  readonly maximumOpenInterestAtoms: bigint;
  readonly maximumDefaultTransferDiscountBps: bigint;
  readonly markMaximumStalenessMs: bigint;
}

export interface NativeClearingPolicy extends Omit<
  NativeClearingPolicyInput,
  'version' | 'clearingDomainId' | 'strategySeries' | 'riskDomainId' | 'accountingAsset'
> {
  readonly version: 1;
  readonly clearingDomainId: ProtocolId;
  readonly strategySeries: VersionedManifestRef;
  readonly riskDomainId: ProtocolId;
  readonly accountingAsset: AssetRef;
  readonly policyHash: CommitmentHash;
}

export interface NativeClearingDomainStateInput {
  readonly version: number;
  readonly policyHash: Uint8Array | string;
  readonly openInterestAtoms: bigint;
  readonly recoveryReserveQuoteAtoms: bigint;
  readonly sequence: bigint;
}

export interface NativeClearingDomainState extends Omit<NativeClearingDomainStateInput, 'version' | 'policyHash'> {
  readonly version: 1;
  readonly policyHash: CommitmentHash;
  readonly stateHash: CommitmentHash;
}

export interface NativeClearingAccountInput {
  readonly version: number;
  readonly policyHash: Uint8Array | string;
  readonly accountId: string;
  readonly ownerId: string;
  readonly collateralQuoteAtoms: bigint;
  readonly cashBalanceQuoteAtoms: bigint;
  readonly positionAtoms: bigint;
  readonly sequence: bigint;
}

export interface NativeClearingAccount extends Omit<
  NativeClearingAccountInput,
  'version' | 'policyHash' | 'accountId' | 'ownerId'
> {
  readonly version: 1;
  readonly policyHash: CommitmentHash;
  readonly accountId: ProtocolId;
  readonly ownerId: ProtocolId;
  readonly accountHash: CommitmentHash;
}

export interface NativeClearingAccountHealth {
  readonly accountHash: CommitmentHash;
  readonly markPriceTicks: bigint;
  readonly observedAtMs: bigint;
  readonly equityQuoteAtoms: bigint;
  readonly initialMarginRequirementQuoteAtoms: bigint;
  readonly maintenanceMarginRequirementQuoteAtoms: bigint;
  readonly status: NativeClearingAccountStatus;
}

export interface NativeClearingMatchReceipt {
  readonly version: 1;
  readonly receiptHash: CommitmentHash;
  readonly executionId: ProtocolId;
  readonly policyHash: CommitmentHash;
  readonly previousDomainStateHash: CommitmentHash;
  readonly resultingDomainStateHash: CommitmentHash;
  readonly previousLongAccountHash: CommitmentHash;
  readonly resultingLongAccountHash: CommitmentHash;
  readonly previousShortAccountHash: CommitmentHash;
  readonly resultingShortAccountHash: CommitmentHash;
  readonly quantityAtoms: bigint;
  readonly priceTicks: bigint;
  readonly markPriceTicks: bigint;
  readonly observedAtMs: bigint;
}

export interface NativeClearingMatchResult {
  readonly domainState: NativeClearingDomainState;
  readonly longAccount: NativeClearingAccount;
  readonly shortAccount: NativeClearingAccount;
  readonly receipt: NativeClearingMatchReceipt;
}

export interface NativeClearingDefaultResolution {
  readonly version: 1;
  readonly resolutionHash: CommitmentHash;
  readonly resolutionId: ProtocolId;
  readonly policyHash: CommitmentHash;
  readonly previousDomainStateHash: CommitmentHash;
  readonly resultingDomainStateHash: CommitmentHash;
  readonly previousDefaultedAccountHash: CommitmentHash;
  readonly resultingDefaultedAccountHash: CommitmentHash;
  readonly previousBackstopAccountHash: CommitmentHash;
  readonly resultingBackstopAccountHash: CommitmentHash;
  readonly transferredPositionAtoms: bigint;
  readonly transferPriceTicks: bigint;
  readonly reserveConsumedQuoteAtoms: bigint;
  readonly uncoveredDeficitQuoteAtoms: bigint;
  readonly markPriceTicks: bigint;
  readonly observedAtMs: bigint;
}

export interface NativeClearingDefaultResult {
  readonly domainState: NativeClearingDomainState;
  readonly defaultedAccount: NativeClearingAccount;
  readonly backstopAccount: NativeClearingAccount;
  readonly resolution: NativeClearingDefaultResolution;
}

function object(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) throw new MalformedInputError(context, 'expected an object');
}

function version(value: number, expected: number, context: string): 1 {
  if (value !== expected) throw new MalformedInputError(context, `version must equal ${expected}`);
  return 1;
}

function unsigned(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, bits, context);
}

function positive(value: bigint, bits: number, context: string): bigint {
  const checked = unsigned(value, bits, context);
  if (checked === 0n) throw new MalformedInputError(context, 'value is zero');
  return checked;
}

function signed(value: bigint, bits: number, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedSigned(value, bits, context);
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

function policyPayload(input: NativeClearingPolicyInput | NativeClearingPolicy): Omit<NativeClearingPolicy, 'policyHash'> {
  object(input, 'nativeClearingPolicy');
  const quantityIncrement = positive(input.packageQuantityIncrementAtoms, U128_BITS, 'nativeClearingPolicy.packageQuantityIncrementAtoms');
  const maximumPosition = positive(input.maximumPositionAtoms, U128_BITS, 'nativeClearingPolicy.maximumPositionAtoms');
  const maximumOpenInterest = positive(input.maximumOpenInterestAtoms, U128_BITS, 'nativeClearingPolicy.maximumOpenInterestAtoms');
  if (maximumPosition % quantityIncrement !== 0n || maximumOpenInterest % quantityIncrement !== 0n) {
    throw new MalformedInputError('nativeClearingPolicy', 'position limits are off the package quantity lattice');
  }
  const initialMargin = positive(input.initialMarginQuoteAtomsPerIncrement, U128_BITS, 'nativeClearingPolicy.initialMarginQuoteAtomsPerIncrement');
  const maintenanceMargin = positive(input.maintenanceMarginQuoteAtomsPerIncrement, U128_BITS, 'nativeClearingPolicy.maintenanceMarginQuoteAtomsPerIncrement');
  if (maintenanceMargin > initialMargin) {
    throw new MalformedInputError('nativeClearingPolicy.maintenanceMarginQuoteAtomsPerIncrement', 'maintenance margin exceeds initial margin');
  }
  const maximumDiscount = unsigned(input.maximumDefaultTransferDiscountBps, U64_BITS, 'nativeClearingPolicy.maximumDefaultTransferDiscountBps');
  if (maximumDiscount > BPS) {
    throw new MalformedInputError('nativeClearingPolicy.maximumDefaultTransferDiscountBps', 'basis points exceed 10000');
  }
  return Object.freeze({
    version: version(input.version, NATIVE_CLEARING_POLICY_VERSION, 'nativeClearingPolicy.version'),
    clearingDomainId: protocolId(input.clearingDomainId, 'nativeClearingPolicy.clearingDomainId'),
    strategySeries: versionedManifestRef(
      input.strategySeries.subjectId,
      input.strategySeries.manifestVersion,
      input.strategySeries.manifestHash,
      'nativeClearingPolicy.strategySeries',
    ),
    riskDomainId: protocolId(input.riskDomainId, 'nativeClearingPolicy.riskDomainId'),
    accountingAsset: assetRef(
      input.accountingAsset.assetId,
      input.accountingAsset.assetManifestHash,
      input.accountingAsset.decimals,
      'nativeClearingPolicy.accountingAsset',
    ),
    packageQuantityIncrementAtoms: quantityIncrement,
    priceTickQuoteAtoms: positive(input.priceTickQuoteAtoms, U128_BITS, 'nativeClearingPolicy.priceTickQuoteAtoms'),
    initialMarginQuoteAtomsPerIncrement: initialMargin,
    maintenanceMarginQuoteAtomsPerIncrement: maintenanceMargin,
    maximumPositionAtoms: maximumPosition,
    maximumOpenInterestAtoms: maximumOpenInterest,
    maximumDefaultTransferDiscountBps: maximumDiscount,
    markMaximumStalenessMs: positive(input.markMaximumStalenessMs, U64_BITS, 'nativeClearingPolicy.markMaximumStalenessMs'),
  });
}

function policyBytes(input: Omit<NativeClearingPolicy, 'policyHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeProtocolId(writer, input.clearingDomainId, 'clearingDomainId');
    encodeVersionedManifestRef(writer, input.strategySeries);
    encodeProtocolId(writer, input.riskDomainId, 'riskDomainId');
    encodeAssetRef(writer, input.accountingAsset);
    writer.writeU128(input.packageQuantityIncrementAtoms, 'packageQuantityIncrementAtoms');
    writer.writeU128(input.priceTickQuoteAtoms, 'priceTickQuoteAtoms');
    writer.writeU128(input.initialMarginQuoteAtomsPerIncrement, 'initialMarginQuoteAtomsPerIncrement');
    writer.writeU128(input.maintenanceMarginQuoteAtomsPerIncrement, 'maintenanceMarginQuoteAtomsPerIncrement');
    writer.writeU128(input.maximumPositionAtoms, 'maximumPositionAtoms');
    writer.writeU128(input.maximumOpenInterestAtoms, 'maximumOpenInterestAtoms');
    writer.writeU64(input.maximumDefaultTransferDiscountBps, 'maximumDefaultTransferDiscountBps');
    writer.writeU64(input.markMaximumStalenessMs, 'markMaximumStalenessMs');
  });
}

export function nativeClearingPolicy(input: NativeClearingPolicyInput | NativeClearingPolicy): NativeClearingPolicy {
  const payload = policyPayload(input);
  const policyHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_POLICY, policyBytes(payload)),
    'nativeClearingPolicy.policyHash',
  );
  if ('policyHash' in input && !sameHash(policyHash, commitmentHash(input.policyHash, 'nativeClearingPolicy.inputPolicyHash'))) {
    throw new MalformedInputError('nativeClearingPolicy.policyHash', 'policy hash mismatch');
  }
  return Object.freeze({ ...payload, policyHash });
}

function domainStatePayload(input: Omit<NativeClearingDomainState, 'stateHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    writer.writeU128(input.openInterestAtoms, 'openInterestAtoms');
    writer.writeU256(input.recoveryReserveQuoteAtoms, 'recoveryReserveQuoteAtoms');
    writer.writeU64(input.sequence, 'sequence');
  });
}

export function nativeClearingDomainState(
  input: NativeClearingDomainStateInput | NativeClearingDomainState,
  policyInput: NativeClearingPolicyInput | NativeClearingPolicy,
): NativeClearingDomainState {
  object(input, 'nativeClearingDomainState');
  const policy = nativeClearingPolicy(policyInput);
  const policyHash = commitmentHash(input.policyHash, 'nativeClearingDomainState.policyHash');
  if (!sameHash(policyHash, policy.policyHash)) throw new MalformedInputError('nativeClearingDomainState.policyHash', 'policy mismatch');
  const openInterestAtoms = unsigned(input.openInterestAtoms, U128_BITS, 'nativeClearingDomainState.openInterestAtoms');
  if (openInterestAtoms % policy.packageQuantityIncrementAtoms !== 0n || openInterestAtoms > policy.maximumOpenInterestAtoms) {
    throw new MalformedInputError('nativeClearingDomainState.openInterestAtoms', 'open interest violates the policy');
  }
  const payload = Object.freeze({
    version: version(input.version, NATIVE_CLEARING_DOMAIN_STATE_VERSION, 'nativeClearingDomainState.version'),
    policyHash,
    openInterestAtoms,
    recoveryReserveQuoteAtoms: unsigned(input.recoveryReserveQuoteAtoms, U256_BITS, 'nativeClearingDomainState.recoveryReserveQuoteAtoms'),
    sequence: unsigned(input.sequence, U64_BITS, 'nativeClearingDomainState.sequence'),
  });
  const stateHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_DOMAIN_STATE, domainStatePayload(payload)),
    'nativeClearingDomainState.stateHash',
  );
  if ('stateHash' in input && !sameHash(stateHash, commitmentHash(input.stateHash, 'nativeClearingDomainState.inputStateHash'))) {
    throw new MalformedInputError('nativeClearingDomainState.stateHash', 'state hash mismatch');
  }
  return Object.freeze({ ...payload, stateHash });
}

function accountPayload(input: Omit<NativeClearingAccount, 'accountHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    encodeProtocolId(writer, input.accountId, 'accountId');
    encodeProtocolId(writer, input.ownerId, 'ownerId');
    writer.writeU256(input.collateralQuoteAtoms, 'collateralQuoteAtoms');
    writer.writeI256(input.cashBalanceQuoteAtoms, 'cashBalanceQuoteAtoms');
    writer.writeI128(input.positionAtoms, 'positionAtoms');
    writer.writeU64(input.sequence, 'sequence');
  });
}

export function nativeClearingAccount(
  input: NativeClearingAccountInput | NativeClearingAccount,
  policyInput: NativeClearingPolicyInput | NativeClearingPolicy,
): NativeClearingAccount {
  object(input, 'nativeClearingAccount');
  const policy = nativeClearingPolicy(policyInput);
  const policyHash = commitmentHash(input.policyHash, 'nativeClearingAccount.policyHash');
  if (!sameHash(policyHash, policy.policyHash)) throw new MalformedInputError('nativeClearingAccount.policyHash', 'policy mismatch');
  const positionAtoms = signed(input.positionAtoms, I128_BITS, 'nativeClearingAccount.positionAtoms');
  if (positionAtoms % policy.packageQuantityIncrementAtoms !== 0n || absBigInt(positionAtoms) > policy.maximumPositionAtoms) {
    throw new MalformedInputError('nativeClearingAccount.positionAtoms', 'position violates the policy');
  }
  const payload = Object.freeze({
    version: version(input.version, NATIVE_CLEARING_ACCOUNT_VERSION, 'nativeClearingAccount.version'),
    policyHash,
    accountId: protocolId(input.accountId, 'nativeClearingAccount.accountId'),
    ownerId: protocolId(input.ownerId, 'nativeClearingAccount.ownerId'),
    collateralQuoteAtoms: unsigned(input.collateralQuoteAtoms, U256_BITS, 'nativeClearingAccount.collateralQuoteAtoms'),
    cashBalanceQuoteAtoms: signed(input.cashBalanceQuoteAtoms, I256_BITS, 'nativeClearingAccount.cashBalanceQuoteAtoms'),
    positionAtoms,
    sequence: unsigned(input.sequence, U64_BITS, 'nativeClearingAccount.sequence'),
  });
  const accountHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_ACCOUNT, accountPayload(payload)),
    'nativeClearingAccount.accountHash',
  );
  if ('accountHash' in input && !sameHash(accountHash, commitmentHash(input.accountHash, 'nativeClearingAccount.inputAccountHash'))) {
    throw new MalformedInputError('nativeClearingAccount.accountHash', 'account hash mismatch');
  }
  return Object.freeze({ ...payload, accountHash });
}

function quoteValue(policy: NativeClearingPolicy, positionAtoms: bigint, priceTicks: bigint, context: string): bigint {
  if (positionAtoms % policy.packageQuantityIncrementAtoms !== 0n) {
    throw new MalformedInputError(context, 'position is off the package quantity lattice');
  }
  return checkedSigned(
    (positionAtoms / policy.packageQuantityIncrementAtoms) * priceTicks * policy.priceTickQuoteAtoms,
    I256_BITS,
    context,
  );
}

function marginRequirement(policy: NativeClearingPolicy, positionAtoms: bigint, perIncrement: bigint): bigint {
  return checkedUnsigned(
    (absBigInt(positionAtoms) / policy.packageQuantityIncrementAtoms) * perIncrement,
    U256_BITS,
    'nativeClearingAccountHealth.marginRequirement',
  );
}

export function nativeClearingAccountHealth(
  accountInput: NativeClearingAccountInput | NativeClearingAccount,
  policyInput: NativeClearingPolicyInput | NativeClearingPolicy,
  markPriceTicks: bigint,
  observedAtMs: bigint,
  nowMs: bigint,
): NativeClearingAccountHealth {
  const policy = nativeClearingPolicy(policyInput);
  const account = nativeClearingAccount(accountInput, policy);
  const mark = positive(markPriceTicks, U128_BITS, 'nativeClearingAccountHealth.markPriceTicks');
  const observed = unsigned(observedAtMs, U64_BITS, 'nativeClearingAccountHealth.observedAtMs');
  const now = unsigned(nowMs, U64_BITS, 'nativeClearingAccountHealth.nowMs');
  if (observed > now || now - observed > policy.markMaximumStalenessMs) {
    throw new MalformedInputError('nativeClearingAccountHealth.observedAtMs', 'mark is stale or from the future');
  }
  const equity = checkedSigned(
    account.collateralQuoteAtoms + account.cashBalanceQuoteAtoms + quoteValue(policy, account.positionAtoms, mark, 'nativeClearingAccountHealth.markValue'),
    I256_BITS,
    'nativeClearingAccountHealth.equityQuoteAtoms',
  );
  const initial = marginRequirement(policy, account.positionAtoms, policy.initialMarginQuoteAtomsPerIncrement);
  const maintenance = marginRequirement(policy, account.positionAtoms, policy.maintenanceMarginQuoteAtomsPerIncrement);
  const status: NativeClearingAccountStatus = account.positionAtoms === 0n && equity >= 0n
    ? 'FLAT'
    : equity < 0n
      ? 'DEFAULTED'
      : equity < maintenance
        ? 'LIQUIDATABLE'
        : equity < initial
          ? 'REDUCE_ONLY'
          : 'ACTIVE';
  return Object.freeze({
    accountHash: account.accountHash,
    markPriceTicks: mark,
    observedAtMs: observed,
    equityQuoteAtoms: equity,
    initialMarginRequirementQuoteAtoms: initial,
    maintenanceMarginRequirementQuoteAtoms: maintenance,
    status,
  });
}

export function adjustNativeClearingCollateral(
  accountInput: NativeClearingAccountInput | NativeClearingAccount,
  policyInput: NativeClearingPolicyInput | NativeClearingPolicy,
  collateralDeltaQuoteAtoms: bigint,
  markPriceTicks: bigint,
  observedAtMs: bigint,
  nowMs: bigint,
): NativeClearingAccount {
  const policy = nativeClearingPolicy(policyInput);
  const account = nativeClearingAccount(accountInput, policy);
  const delta = signed(collateralDeltaQuoteAtoms, I256_BITS, 'adjustNativeClearingCollateral.collateralDeltaQuoteAtoms');
  const collateral = account.collateralQuoteAtoms + delta;
  if (collateral < 0n) throw new MalformedInputError('adjustNativeClearingCollateral.collateralDeltaQuoteAtoms', 'withdrawal exceeds collateral');
  const result = nativeClearingAccount({
    version: account.version,
    policyHash: account.policyHash,
    accountId: account.accountId,
    ownerId: account.ownerId,
    collateralQuoteAtoms: collateral,
    cashBalanceQuoteAtoms: account.cashBalanceQuoteAtoms,
    positionAtoms: account.positionAtoms,
    sequence: account.sequence + 1n,
  }, policy);
  if (delta < 0n) {
    const health = nativeClearingAccountHealth(result, policy, markPriceTicks, observedAtMs, nowMs);
    if (result.positionAtoms !== 0n && health.status !== 'ACTIVE') {
      throw new MalformedInputError('adjustNativeClearingCollateral.collateralDeltaQuoteAtoms', 'withdrawal leaves the account below initial margin');
    }
    if (health.equityQuoteAtoms < 0n) {
      throw new MalformedInputError('adjustNativeClearingCollateral.collateralDeltaQuoteAtoms', 'withdrawal creates a deficit');
    }
  }
  return result;
}

function nextOpenInterest(
  domain: NativeClearingDomainState,
  beforeLong: bigint,
  afterLong: bigint,
  beforeShort: bigint,
  afterShort: bigint,
  policy: NativeClearingPolicy,
): bigint {
  const grossBefore = absBigInt(beforeLong) + absBigInt(beforeShort);
  const grossAfter = absBigInt(afterLong) + absBigInt(afterShort);
  const grossDelta = grossAfter - grossBefore;
  if (grossDelta % 2n !== 0n) throw new MalformedInputError('nativeClearingMatch.openInterestAtoms', 'gross position delta is not pairwise');
  const result = domain.openInterestAtoms + grossDelta / 2n;
  if (result < 0n || result > policy.maximumOpenInterestAtoms) {
    throw new MalformedInputError('nativeClearingMatch.openInterestAtoms', 'open interest violates the policy');
  }
  return result;
}

function matchReceiptBytes(input: Omit<NativeClearingMatchReceipt, 'receiptHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeProtocolId(writer, input.executionId, 'executionId');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    encodeCommitmentHash(writer, input.previousDomainStateHash, 'previousDomainStateHash');
    encodeCommitmentHash(writer, input.resultingDomainStateHash, 'resultingDomainStateHash');
    encodeCommitmentHash(writer, input.previousLongAccountHash, 'previousLongAccountHash');
    encodeCommitmentHash(writer, input.resultingLongAccountHash, 'resultingLongAccountHash');
    encodeCommitmentHash(writer, input.previousShortAccountHash, 'previousShortAccountHash');
    encodeCommitmentHash(writer, input.resultingShortAccountHash, 'resultingShortAccountHash');
    writer.writeU128(input.quantityAtoms, 'quantityAtoms');
    writer.writeU128(input.priceTicks, 'priceTicks');
    writer.writeU128(input.markPriceTicks, 'markPriceTicks');
    writer.writeU64(input.observedAtMs, 'observedAtMs');
  });
}

export function applyNativeClearingMatch(input: Readonly<{
  policy: NativeClearingPolicyInput | NativeClearingPolicy;
  domainState: NativeClearingDomainStateInput | NativeClearingDomainState;
  longAccount: NativeClearingAccountInput | NativeClearingAccount;
  shortAccount: NativeClearingAccountInput | NativeClearingAccount;
  executionId: string;
  quantityAtoms: bigint;
  priceTicks: bigint;
  markPriceTicks: bigint;
  observedAtMs: bigint;
  nowMs: bigint;
}>): NativeClearingMatchResult {
  object(input, 'applyNativeClearingMatch');
  const policy = nativeClearingPolicy(input.policy);
  const domain = nativeClearingDomainState(input.domainState, policy);
  const longBefore = nativeClearingAccount(input.longAccount, policy);
  const shortBefore = nativeClearingAccount(input.shortAccount, policy);
  if (longBefore.accountId === shortBefore.accountId || longBefore.ownerId === shortBefore.ownerId) {
    throw new MalformedInputError('applyNativeClearingMatch.accounts', 'self matching is prohibited');
  }
  const quantity = positive(input.quantityAtoms, U128_BITS, 'applyNativeClearingMatch.quantityAtoms');
  if (quantity % policy.packageQuantityIncrementAtoms !== 0n) {
    throw new MalformedInputError('applyNativeClearingMatch.quantityAtoms', 'quantity is off the package quantity lattice');
  }
  const price = positive(input.priceTicks, U128_BITS, 'applyNativeClearingMatch.priceTicks');
  const longPreHealth = nativeClearingAccountHealth(longBefore, policy, input.markPriceTicks, input.observedAtMs, input.nowMs);
  const shortPreHealth = nativeClearingAccountHealth(shortBefore, policy, input.markPriceTicks, input.observedAtMs, input.nowMs);
  const quote = quoteValue(policy, quantity, price, 'applyNativeClearingMatch.quoteAtoms');
  const longAfter = nativeClearingAccount({
    version: longBefore.version,
    policyHash: longBefore.policyHash,
    accountId: longBefore.accountId,
    ownerId: longBefore.ownerId,
    collateralQuoteAtoms: longBefore.collateralQuoteAtoms,
    cashBalanceQuoteAtoms: longBefore.cashBalanceQuoteAtoms - quote,
    positionAtoms: longBefore.positionAtoms + quantity,
    sequence: longBefore.sequence + 1n,
  }, policy);
  const shortAfter = nativeClearingAccount({
    version: shortBefore.version,
    policyHash: shortBefore.policyHash,
    accountId: shortBefore.accountId,
    ownerId: shortBefore.ownerId,
    collateralQuoteAtoms: shortBefore.collateralQuoteAtoms,
    cashBalanceQuoteAtoms: shortBefore.cashBalanceQuoteAtoms + quote,
    positionAtoms: shortBefore.positionAtoms - quantity,
    sequence: shortBefore.sequence + 1n,
  }, policy);
  for (const [before, after, preHealth] of [
    [longBefore, longAfter, longPreHealth],
    [shortBefore, shortAfter, shortPreHealth],
  ] as const) {
    const crossesThroughFlat = before.positionAtoms !== 0n && after.positionAtoms !== 0n
      && (before.positionAtoms > 0n) !== (after.positionAtoms > 0n);
    const increasesRisk = absBigInt(after.positionAtoms) > absBigInt(before.positionAtoms) || crossesThroughFlat;
    const health = nativeClearingAccountHealth(after, policy, input.markPriceTicks, input.observedAtMs, input.nowMs);
    if (preHealth.status === 'DEFAULTED') {
      throw new MalformedInputError('applyNativeClearingMatch.accounts', 'a defaulted account requires the default transfer path');
    }
    if (increasesRisk && (!['ACTIVE', 'FLAT'].includes(preHealth.status) || health.status !== 'ACTIVE')) {
      throw new MalformedInputError('applyNativeClearingMatch.accounts', 'risk-increasing match leaves an account below initial margin');
    }
    if (!increasesRisk && health.status === 'DEFAULTED') {
      throw new MalformedInputError('applyNativeClearingMatch.accounts', 'risk reduction cannot create a default');
    }
  }
  if (longAfter.positionAtoms + shortAfter.positionAtoms !== longBefore.positionAtoms + shortBefore.positionAtoms
    || longAfter.cashBalanceQuoteAtoms + shortAfter.cashBalanceQuoteAtoms
      !== longBefore.cashBalanceQuoteAtoms + shortBefore.cashBalanceQuoteAtoms) {
    throw new MalformedInputError('applyNativeClearingMatch', 'match does not conserve position and quote value');
  }
  const nextDomain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: nextOpenInterest(
      domain,
      longBefore.positionAtoms,
      longAfter.positionAtoms,
      shortBefore.positionAtoms,
      shortAfter.positionAtoms,
      policy,
    ),
    recoveryReserveQuoteAtoms: domain.recoveryReserveQuoteAtoms,
    sequence: domain.sequence + 1n,
  }, policy);
  const payload = Object.freeze({
    version: NATIVE_CLEARING_MATCH_VERSION as 1,
    executionId: protocolId(input.executionId, 'applyNativeClearingMatch.executionId'),
    policyHash: policy.policyHash,
    previousDomainStateHash: domain.stateHash,
    resultingDomainStateHash: nextDomain.stateHash,
    previousLongAccountHash: longBefore.accountHash,
    resultingLongAccountHash: longAfter.accountHash,
    previousShortAccountHash: shortBefore.accountHash,
    resultingShortAccountHash: shortAfter.accountHash,
    quantityAtoms: quantity,
    priceTicks: price,
    markPriceTicks: positive(input.markPriceTicks, U128_BITS, 'applyNativeClearingMatch.markPriceTicks'),
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, 'applyNativeClearingMatch.observedAtMs'),
  });
  const receiptHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_MATCH, matchReceiptBytes(payload)),
    'applyNativeClearingMatch.receiptHash',
  );
  return Object.freeze({
    domainState: nextDomain,
    longAccount: longAfter,
    shortAccount: shortAfter,
    receipt: Object.freeze({ ...payload, receiptHash }),
  });
}

function defaultResolutionBytes(input: Omit<NativeClearingDefaultResolution, 'resolutionHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(input.version, 'version');
    encodeProtocolId(writer, input.resolutionId, 'resolutionId');
    encodeCommitmentHash(writer, input.policyHash, 'policyHash');
    encodeCommitmentHash(writer, input.previousDomainStateHash, 'previousDomainStateHash');
    encodeCommitmentHash(writer, input.resultingDomainStateHash, 'resultingDomainStateHash');
    encodeCommitmentHash(writer, input.previousDefaultedAccountHash, 'previousDefaultedAccountHash');
    encodeCommitmentHash(writer, input.resultingDefaultedAccountHash, 'resultingDefaultedAccountHash');
    encodeCommitmentHash(writer, input.previousBackstopAccountHash, 'previousBackstopAccountHash');
    encodeCommitmentHash(writer, input.resultingBackstopAccountHash, 'resultingBackstopAccountHash');
    writer.writeI128(input.transferredPositionAtoms, 'transferredPositionAtoms');
    writer.writeU128(input.transferPriceTicks, 'transferPriceTicks');
    writer.writeU256(input.reserveConsumedQuoteAtoms, 'reserveConsumedQuoteAtoms');
    writer.writeU256(input.uncoveredDeficitQuoteAtoms, 'uncoveredDeficitQuoteAtoms');
    writer.writeU128(input.markPriceTicks, 'markPriceTicks');
    writer.writeU64(input.observedAtMs, 'observedAtMs');
  });
}

export function resolveNativeClearingDefault(input: Readonly<{
  policy: NativeClearingPolicyInput | NativeClearingPolicy;
  domainState: NativeClearingDomainStateInput | NativeClearingDomainState;
  defaultedAccount: NativeClearingAccountInput | NativeClearingAccount;
  backstopAccount: NativeClearingAccountInput | NativeClearingAccount;
  resolutionId: string;
  transferPriceTicks: bigint;
  markPriceTicks: bigint;
  observedAtMs: bigint;
  nowMs: bigint;
}>): NativeClearingDefaultResult {
  object(input, 'resolveNativeClearingDefault');
  const policy = nativeClearingPolicy(input.policy);
  const domain = nativeClearingDomainState(input.domainState, policy);
  const defaulterBefore = nativeClearingAccount(input.defaultedAccount, policy);
  const backstopBefore = nativeClearingAccount(input.backstopAccount, policy);
  if (defaulterBefore.accountId === backstopBefore.accountId || defaulterBefore.ownerId === backstopBefore.ownerId) {
    throw new MalformedInputError('resolveNativeClearingDefault.accounts', 'self backstop is prohibited');
  }
  const health = nativeClearingAccountHealth(defaulterBefore, policy, input.markPriceTicks, input.observedAtMs, input.nowMs);
  if (health.status !== 'DEFAULTED' || defaulterBefore.positionAtoms === 0n) {
    throw new MalformedInputError('resolveNativeClearingDefault.defaultedAccount', 'account is not an open default');
  }
  const transferPrice = positive(input.transferPriceTicks, U128_BITS, 'resolveNativeClearingDefault.transferPriceTicks');
  const mark = positive(input.markPriceTicks, U128_BITS, 'resolveNativeClearingDefault.markPriceTicks');
  const discount = policy.maximumDefaultTransferDiscountBps;
  const minimumLongPrice = mulDiv(mark, BPS - discount, BPS, ROUNDING.CEIL, 'resolveNativeClearingDefault.minimumLongPrice');
  const maximumShortPrice = mulDiv(mark, BPS + discount, BPS, ROUNDING.FLOOR, 'resolveNativeClearingDefault.maximumShortPrice');
  if ((defaulterBefore.positionAtoms > 0n && transferPrice < minimumLongPrice)
    || (defaulterBefore.positionAtoms < 0n && transferPrice > maximumShortPrice)) {
    throw new MalformedInputError('resolveNativeClearingDefault.transferPriceTicks', 'default transfer price exceeds its bound');
  }
  const transferValue = quoteValue(policy, defaulterBefore.positionAtoms, transferPrice, 'resolveNativeClearingDefault.transferValue');
  const backstopAfter = nativeClearingAccount({
    version: backstopBefore.version,
    policyHash: backstopBefore.policyHash,
    accountId: backstopBefore.accountId,
    ownerId: backstopBefore.ownerId,
    collateralQuoteAtoms: backstopBefore.collateralQuoteAtoms,
    cashBalanceQuoteAtoms: backstopBefore.cashBalanceQuoteAtoms - transferValue,
    positionAtoms: backstopBefore.positionAtoms + defaulterBefore.positionAtoms,
    sequence: backstopBefore.sequence + 1n,
  }, policy);
  const backstopHealth = nativeClearingAccountHealth(backstopAfter, policy, mark, input.observedAtMs, input.nowMs);
  if (backstopAfter.positionAtoms !== 0n && backstopHealth.status !== 'ACTIVE') {
    throw new MalformedInputError('resolveNativeClearingDefault.backstopAccount', 'backstop is below initial margin');
  }
  const closedCash = checkedSigned(
    defaulterBefore.cashBalanceQuoteAtoms + transferValue,
    I256_BITS,
    'resolveNativeClearingDefault.closedCash',
  );
  const closedEquity = checkedSigned(
    defaulterBefore.collateralQuoteAtoms + closedCash,
    I256_BITS,
    'resolveNativeClearingDefault.closedEquity',
  );
  const deficit = closedEquity < 0n ? -closedEquity : 0n;
  const reserveConsumed = deficit < domain.recoveryReserveQuoteAtoms ? deficit : domain.recoveryReserveQuoteAtoms;
  const uncovered = deficit - reserveConsumed;
  const defaulterAfter = nativeClearingAccount({
    version: defaulterBefore.version,
    policyHash: defaulterBefore.policyHash,
    accountId: defaulterBefore.accountId,
    ownerId: defaulterBefore.ownerId,
    collateralQuoteAtoms: closedEquity > 0n ? closedEquity : 0n,
    cashBalanceQuoteAtoms: -uncovered,
    positionAtoms: 0n,
    sequence: defaulterBefore.sequence + 1n,
  }, policy);
  const nextDomain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: nextOpenInterest(
      domain,
      defaulterBefore.positionAtoms,
      0n,
      backstopBefore.positionAtoms,
      backstopAfter.positionAtoms,
      policy,
    ),
    recoveryReserveQuoteAtoms: domain.recoveryReserveQuoteAtoms - reserveConsumed,
    sequence: domain.sequence + 1n,
  }, policy);
  const payload = Object.freeze({
    version: NATIVE_CLEARING_DEFAULT_VERSION as 1,
    resolutionId: protocolId(input.resolutionId, 'resolveNativeClearingDefault.resolutionId'),
    policyHash: policy.policyHash,
    previousDomainStateHash: domain.stateHash,
    resultingDomainStateHash: nextDomain.stateHash,
    previousDefaultedAccountHash: defaulterBefore.accountHash,
    resultingDefaultedAccountHash: defaulterAfter.accountHash,
    previousBackstopAccountHash: backstopBefore.accountHash,
    resultingBackstopAccountHash: backstopAfter.accountHash,
    transferredPositionAtoms: defaulterBefore.positionAtoms,
    transferPriceTicks: transferPrice,
    reserveConsumedQuoteAtoms: reserveConsumed,
    uncoveredDeficitQuoteAtoms: uncovered,
    markPriceTicks: mark,
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, 'resolveNativeClearingDefault.observedAtMs'),
  });
  const resolutionHash = commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_DEFAULT, defaultResolutionBytes(payload)),
    'resolveNativeClearingDefault.resolutionHash',
  );
  return Object.freeze({
    domainState: nextDomain,
    defaultedAccount: defaulterAfter,
    backstopAccount: backstopAfter,
    resolution: Object.freeze({ ...payload, resolutionHash }),
  });
}

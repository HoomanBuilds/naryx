import { checkedSigned, checkedUnsigned, mulDiv, ROUNDING } from './arithmetic.js';
import { bytesEqual, compareBytes } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  nativeClearingAccount,
  nativeClearingAccountHealth,
  nativeClearingPolicy,
  type NativeClearingAccount,
  type NativeClearingPolicy,
} from './native-package-clearing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  encodeProtocolId,
  encodeVersionedManifestRef,
  protocolId,
  versionedManifestRef,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

export const NATIVE_CLEARING_COLLATERAL_AUTHORIZATION_VERSION = 1;
export const NATIVE_CLEARING_MARK_OBSERVATION_VERSION = 1;
export const NATIVE_CLEARING_DEFAULT_AUCTION_VERSION = 1;
export const NATIVE_CLEARING_DEFAULT_BID_VERSION = 1;

const BPS = 10_000n;
const U64_BITS = 64;
const U128_BITS = 128;
const I256_BITS = 256;

export interface NativeClearingCollateralAuthorizationInput {
  readonly version: number;
  readonly policyHash: Uint8Array | string;
  readonly accountId: string;
  readonly ownerId: string;
  readonly expectedAccountHash: Uint8Array | string;
  readonly expectedAccountSequence: bigint;
  readonly collateralDeltaQuoteAtoms: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
}

export interface NativeClearingCollateralAuthorization extends Omit<
  NativeClearingCollateralAuthorizationInput,
  'version' | 'policyHash' | 'accountId' | 'ownerId' | 'expectedAccountHash'
> {
  readonly version: 1;
  readonly policyHash: CommitmentHash;
  readonly accountId: ProtocolId;
  readonly ownerId: ProtocolId;
  readonly expectedAccountHash: CommitmentHash;
  readonly authorizationHash: CommitmentHash;
}

export interface NativeClearingMarkObservationInput {
  readonly version: number;
  readonly policyHash: Uint8Array | string;
  readonly source: VersionedManifestRef;
  readonly authorityId: string;
  readonly sourceSequence: bigint;
  readonly priceTicks: bigint;
  readonly observedAtMs: bigint;
  readonly validUntilMs: bigint;
}

export interface NativeClearingMarkObservation extends Omit<
  NativeClearingMarkObservationInput,
  'version' | 'policyHash' | 'source' | 'authorityId'
> {
  readonly version: 1;
  readonly policyHash: CommitmentHash;
  readonly source: VersionedManifestRef;
  readonly authorityId: ProtocolId;
  readonly observationHash: CommitmentHash;
}

export interface NativeClearingDefaultAuction {
  readonly version: 1;
  readonly auctionHash: CommitmentHash;
  readonly auctionId: ProtocolId;
  readonly policyHash: CommitmentHash;
  readonly defaultedAccountId: ProtocolId;
  readonly defaultedAccountHash: CommitmentHash;
  readonly positionAtoms: bigint;
  readonly markObservationHash: CommitmentHash;
  readonly markPriceTicks: bigint;
  readonly minimumTransferPriceTicks: bigint;
  readonly maximumTransferPriceTicks: bigint;
  readonly openedAtMs: bigint;
  readonly bidsCloseAtMs: bigint;
}

export interface NativeClearingDefaultBidInput {
  readonly version: number;
  readonly auctionHash: Uint8Array | string;
  readonly backstopAccountId: string;
  readonly backstopAccountHash: Uint8Array | string;
  readonly backstopOwnerId: string;
  readonly transferPriceTicks: bigint;
  readonly nonce: bigint;
  readonly validUntilMs: bigint;
}

export interface NativeClearingDefaultBid extends Omit<
  NativeClearingDefaultBidInput,
  'version' | 'auctionHash' | 'backstopAccountId' | 'backstopAccountHash' | 'backstopOwnerId'
> {
  readonly version: 1;
  readonly auctionHash: CommitmentHash;
  readonly backstopAccountId: ProtocolId;
  readonly backstopAccountHash: CommitmentHash;
  readonly backstopOwnerId: ProtocolId;
  readonly bidHash: CommitmentHash;
}

function defaultAuctionBytes(payload: Omit<NativeClearingDefaultAuction, 'auctionHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(payload.version, 'version');
    encodeProtocolId(writer, payload.auctionId, 'auctionId');
    encodeCommitmentHash(writer, payload.policyHash, 'policyHash');
    encodeProtocolId(writer, payload.defaultedAccountId, 'defaultedAccountId');
    encodeCommitmentHash(writer, payload.defaultedAccountHash, 'defaultedAccountHash');
    writer.writeI128(payload.positionAtoms, 'positionAtoms');
    encodeCommitmentHash(writer, payload.markObservationHash, 'markObservationHash');
    writer.writeU128(payload.markPriceTicks, 'markPriceTicks');
    writer.writeU128(payload.minimumTransferPriceTicks, 'minimumTransferPriceTicks');
    writer.writeU128(payload.maximumTransferPriceTicks, 'maximumTransferPriceTicks');
    writer.writeU64(payload.openedAtMs, 'openedAtMs');
    writer.writeU64(payload.bidsCloseAtMs, 'bidsCloseAtMs');
  });
}

export function nativeClearingDefaultAuctionHash(
  auction: Omit<NativeClearingDefaultAuction, 'auctionHash'>,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_DEFAULT_AUCTION, defaultAuctionBytes(auction)),
    'nativeClearingDefaultAuctionHash',
  );
}

function defaultBidBytes(payload: Omit<NativeClearingDefaultBid, 'bidHash'>): Uint8Array {
  return canonicalBytes((writer) => {
    writer.writeU32(payload.version, 'version');
    encodeCommitmentHash(writer, payload.auctionHash, 'auctionHash');
    encodeProtocolId(writer, payload.backstopAccountId, 'backstopAccountId');
    encodeCommitmentHash(writer, payload.backstopAccountHash, 'backstopAccountHash');
    encodeProtocolId(writer, payload.backstopOwnerId, 'backstopOwnerId');
    writer.writeU128(payload.transferPriceTicks, 'transferPriceTicks');
    writer.writeU64(payload.nonce, 'nonce');
    writer.writeU64(payload.validUntilMs, 'validUntilMs');
  });
}

export function nativeClearingDefaultBidHash(
  bid: Omit<NativeClearingDefaultBid, 'bidHash'>,
): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.NATIVE_CLEARING_DEFAULT_BID, defaultBidBytes(bid)),
    'nativeClearingDefaultBidHash',
  );
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
  const result = unsigned(value, bits, context);
  if (result === 0n) throw new MalformedInputError(context, 'value is zero');
  return result;
}

export function nativeClearingCollateralAuthorization(
  input: NativeClearingCollateralAuthorizationInput,
): NativeClearingCollateralAuthorization {
  const payload = Object.freeze({
    version: version(input.version, NATIVE_CLEARING_COLLATERAL_AUTHORIZATION_VERSION, 'nativeClearingCollateralAuthorization.version'),
    policyHash: commitmentHash(input.policyHash, 'nativeClearingCollateralAuthorization.policyHash'),
    accountId: protocolId(input.accountId, 'nativeClearingCollateralAuthorization.accountId'),
    ownerId: protocolId(input.ownerId, 'nativeClearingCollateralAuthorization.ownerId'),
    expectedAccountHash: commitmentHash(input.expectedAccountHash, 'nativeClearingCollateralAuthorization.expectedAccountHash'),
    expectedAccountSequence: unsigned(input.expectedAccountSequence, U64_BITS, 'nativeClearingCollateralAuthorization.expectedAccountSequence'),
    collateralDeltaQuoteAtoms: checkedSigned(input.collateralDeltaQuoteAtoms, I256_BITS, 'nativeClearingCollateralAuthorization.collateralDeltaQuoteAtoms'),
    validUntilUnit: input.validUntilUnit,
    validUntilValue: positive(input.validUntilValue, U64_BITS, 'nativeClearingCollateralAuthorization.validUntilValue'),
  });
  enumDiscriminant(EXPIRY_UNIT, payload.validUntilUnit, 'nativeClearingCollateralAuthorization.validUntilUnit');
  if (payload.collateralDeltaQuoteAtoms === 0n) {
    throw new MalformedInputError('nativeClearingCollateralAuthorization.collateralDeltaQuoteAtoms', 'collateral adjustment is zero');
  }
  const authorizationHash = commitmentHash(domainHash(
    HASH_DOMAIN.NATIVE_CLEARING_COLLATERAL_AUTHORIZATION,
    canonicalBytes((writer) => {
      writer.writeU32(payload.version, 'version');
      encodeCommitmentHash(writer, payload.policyHash, 'policyHash');
      encodeProtocolId(writer, payload.accountId, 'accountId');
      encodeProtocolId(writer, payload.ownerId, 'ownerId');
      encodeCommitmentHash(writer, payload.expectedAccountHash, 'expectedAccountHash');
      writer.writeU64(payload.expectedAccountSequence, 'expectedAccountSequence');
      writer.writeI256(payload.collateralDeltaQuoteAtoms, 'collateralDeltaQuoteAtoms');
      writer.writeEnum(EXPIRY_UNIT, payload.validUntilUnit, 'validUntilUnit');
      writer.writeU64(payload.validUntilValue, 'validUntilValue');
    }),
  ), 'nativeClearingCollateralAuthorization.authorizationHash');
  return Object.freeze({ ...payload, authorizationHash });
}

export function verifyNativeClearingCollateralAuthorization(
  authorizationInput: NativeClearingCollateralAuthorizationInput,
  policyInput: NativeClearingPolicy,
  accountInput: NativeClearingAccount,
  currentExpiryUnit: ExpiryUnit,
  currentExpiryValue: bigint,
): NativeClearingCollateralAuthorization {
  const authorization = nativeClearingCollateralAuthorization(authorizationInput);
  const policy = nativeClearingPolicy(policyInput);
  const account = nativeClearingAccount(accountInput, policy);
  const now = unsigned(currentExpiryValue, U64_BITS, 'verifyNativeClearingCollateralAuthorization.currentExpiryValue');
  if (!bytesEqual(authorization.policyHash, policy.policyHash)
    || !bytesEqual(authorization.expectedAccountHash, account.accountHash)
    || authorization.accountId !== account.accountId
    || authorization.ownerId !== account.ownerId
    || authorization.expectedAccountSequence !== account.sequence) {
    throw new MalformedInputError('verifyNativeClearingCollateralAuthorization', 'authorization is not bound to current account state');
  }
  if (authorization.validUntilUnit !== currentExpiryUnit || now >= authorization.validUntilValue) {
    throw new MalformedInputError('verifyNativeClearingCollateralAuthorization', 'authorization is expired or uses another clock');
  }
  return authorization;
}

export function nativeClearingMarkObservation(
  input: NativeClearingMarkObservationInput,
  policyInput: NativeClearingPolicy,
): NativeClearingMarkObservation {
  const policy = nativeClearingPolicy(policyInput);
  const source = versionedManifestRef(
    input.source.subjectId,
    input.source.manifestVersion,
    input.source.manifestHash,
    'nativeClearingMarkObservation.source',
  );
  const payload = Object.freeze({
    version: version(input.version, NATIVE_CLEARING_MARK_OBSERVATION_VERSION, 'nativeClearingMarkObservation.version'),
    policyHash: commitmentHash(input.policyHash, 'nativeClearingMarkObservation.policyHash'),
    source,
    authorityId: protocolId(input.authorityId, 'nativeClearingMarkObservation.authorityId'),
    sourceSequence: positive(input.sourceSequence, U64_BITS, 'nativeClearingMarkObservation.sourceSequence'),
    priceTicks: positive(input.priceTicks, U128_BITS, 'nativeClearingMarkObservation.priceTicks'),
    observedAtMs: unsigned(input.observedAtMs, U64_BITS, 'nativeClearingMarkObservation.observedAtMs'),
    validUntilMs: positive(input.validUntilMs, U64_BITS, 'nativeClearingMarkObservation.validUntilMs'),
  });
  if (!bytesEqual(payload.policyHash, policy.policyHash)
    || payload.authorityId !== policy.markAuthorityId
    || source.subjectId !== policy.markSource.subjectId
    || source.manifestVersion !== policy.markSource.manifestVersion
    || !bytesEqual(source.manifestHash, policy.markSource.manifestHash)) {
    throw new MalformedInputError('nativeClearingMarkObservation', 'observation is outside the policy mark source');
  }
  if (payload.validUntilMs <= payload.observedAtMs
    || payload.validUntilMs - payload.observedAtMs > policy.markMaximumStalenessMs) {
    throw new MalformedInputError('nativeClearingMarkObservation.validUntilMs', 'observation lifetime violates the mark policy');
  }
  const observationHash = commitmentHash(domainHash(
    HASH_DOMAIN.NATIVE_CLEARING_MARK_OBSERVATION,
    canonicalBytes((writer) => {
      writer.writeU32(payload.version, 'version');
      encodeCommitmentHash(writer, payload.policyHash, 'policyHash');
      encodeVersionedManifestRef(writer, payload.source);
      encodeProtocolId(writer, payload.authorityId, 'authorityId');
      writer.writeU64(payload.sourceSequence, 'sourceSequence');
      writer.writeU128(payload.priceTicks, 'priceTicks');
      writer.writeU64(payload.observedAtMs, 'observedAtMs');
      writer.writeU64(payload.validUntilMs, 'validUntilMs');
    }),
  ), 'nativeClearingMarkObservation.observationHash');
  return Object.freeze({ ...payload, observationHash });
}

export function nativeClearingDefaultAuction(input: Readonly<{
  policy: NativeClearingPolicy;
  defaultedAccount: NativeClearingAccount;
  markObservation: NativeClearingMarkObservation;
  auctionId: string;
  openedAtMs: bigint;
  bidsCloseAtMs: bigint;
}>): NativeClearingDefaultAuction {
  const policy = nativeClearingPolicy(input.policy);
  const account = nativeClearingAccount(input.defaultedAccount, policy);
  const mark = nativeClearingMarkObservation(input.markObservation, policy);
  const openedAtMs = unsigned(input.openedAtMs, U64_BITS, 'nativeClearingDefaultAuction.openedAtMs');
  const bidsCloseAtMs = positive(input.bidsCloseAtMs, U64_BITS, 'nativeClearingDefaultAuction.bidsCloseAtMs');
  if (openedAtMs >= bidsCloseAtMs || openedAtMs >= mark.validUntilMs || bidsCloseAtMs > mark.validUntilMs) {
    throw new MalformedInputError('nativeClearingDefaultAuction', 'auction window is invalid or mark is expired');
  }
  if (nativeClearingAccountHealth(account, policy, mark.priceTicks, mark.observedAtMs, openedAtMs).status !== 'DEFAULTED'
    || account.positionAtoms === 0n) {
    throw new MalformedInputError('nativeClearingDefaultAuction.defaultedAccount', 'account is not an open default');
  }
  const minimumTransferPriceTicks = mulDiv(
    mark.priceTicks,
    BPS - policy.maximumDefaultTransferDiscountBps,
    BPS,
    ROUNDING.CEIL,
    'nativeClearingDefaultAuction.minimumTransferPriceTicks',
  );
  const maximumTransferPriceTicks = mulDiv(
    mark.priceTicks,
    BPS + policy.maximumDefaultTransferDiscountBps,
    BPS,
    ROUNDING.FLOOR,
    'nativeClearingDefaultAuction.maximumTransferPriceTicks',
  );
  const payload = Object.freeze({
    version: NATIVE_CLEARING_DEFAULT_AUCTION_VERSION as 1,
    auctionId: protocolId(input.auctionId, 'nativeClearingDefaultAuction.auctionId'),
    policyHash: policy.policyHash,
    defaultedAccountId: account.accountId,
    defaultedAccountHash: account.accountHash,
    positionAtoms: account.positionAtoms,
    markObservationHash: mark.observationHash,
    markPriceTicks: mark.priceTicks,
    minimumTransferPriceTicks,
    maximumTransferPriceTicks,
    openedAtMs,
    bidsCloseAtMs,
  });
  const auctionHash = nativeClearingDefaultAuctionHash(payload);
  return Object.freeze({ ...payload, auctionHash });
}

export function nativeClearingDefaultBid(
  input: NativeClearingDefaultBidInput,
  auction: NativeClearingDefaultAuction,
): NativeClearingDefaultBid {
  const payload = Object.freeze({
    version: version(input.version, NATIVE_CLEARING_DEFAULT_BID_VERSION, 'nativeClearingDefaultBid.version'),
    auctionHash: commitmentHash(input.auctionHash, 'nativeClearingDefaultBid.auctionHash'),
    backstopAccountId: protocolId(input.backstopAccountId, 'nativeClearingDefaultBid.backstopAccountId'),
    backstopAccountHash: commitmentHash(input.backstopAccountHash, 'nativeClearingDefaultBid.backstopAccountHash'),
    backstopOwnerId: protocolId(input.backstopOwnerId, 'nativeClearingDefaultBid.backstopOwnerId'),
    transferPriceTicks: positive(input.transferPriceTicks, U128_BITS, 'nativeClearingDefaultBid.transferPriceTicks'),
    nonce: unsigned(input.nonce, U64_BITS, 'nativeClearingDefaultBid.nonce'),
    validUntilMs: positive(input.validUntilMs, U64_BITS, 'nativeClearingDefaultBid.validUntilMs'),
  });
  if (!bytesEqual(payload.auctionHash, auction.auctionHash)
    || payload.backstopAccountId === auction.defaultedAccountId
    || payload.transferPriceTicks < auction.minimumTransferPriceTicks
    || payload.transferPriceTicks > auction.maximumTransferPriceTicks
    || payload.validUntilMs < auction.bidsCloseAtMs) {
    throw new MalformedInputError('nativeClearingDefaultBid', 'bid is outside the auction bounds');
  }
  const bidHash = nativeClearingDefaultBidHash(payload);
  return Object.freeze({ ...payload, bidHash });
}

export function selectNativeClearingDefaultBid(
  auction: NativeClearingDefaultAuction,
  bids: readonly NativeClearingDefaultBid[],
  nowMs: bigint,
): NativeClearingDefaultBid {
  const now = unsigned(nowMs, U64_BITS, 'selectNativeClearingDefaultBid.nowMs');
  if (now < auction.bidsCloseAtMs) throw new MalformedInputError('selectNativeClearingDefaultBid', 'auction is still open');
  const live = bids.filter((bid) => bytesEqual(bid.auctionHash, auction.auctionHash) && bid.validUntilMs >= now);
  if (live.length === 0) throw new MalformedInputError('selectNativeClearingDefaultBid', 'auction has no live bids');
  return [...live].sort((left, right) => {
    if (left.transferPriceTicks !== right.transferPriceTicks) {
      const leftFirst = auction.positionAtoms > 0n
        ? left.transferPriceTicks > right.transferPriceTicks
        : left.transferPriceTicks < right.transferPriceTicks;
      return leftFirst ? -1 : 1;
    }
    return compareBytes(left.bidHash, right.bidHash);
  })[0]!;
}

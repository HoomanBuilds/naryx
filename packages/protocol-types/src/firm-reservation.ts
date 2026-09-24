import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, type CanonicalWriter } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { HASH_DOMAIN, domainHash } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  type CommitmentHash,
} from './package-order-primitives.js';
import {
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  protocolId,
  type DomainRef,
  type ProtocolId,
} from './primitives.js';

const U256_BITS = 256;

export interface FirmReservationIdentityInput {
  readonly domain: DomainRef;
  readonly solverId: string;
  readonly orderHash: Uint8Array | string;
  readonly reservationNonce: bigint;
}

export interface FirmReservationIdentity {
  readonly domain: DomainRef;
  readonly solverId: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly reservationNonce: bigint;
}

export function firmReservationIdentity(
  input: FirmReservationIdentityInput,
  context = 'firmReservationIdentity',
): FirmReservationIdentity {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
  if (typeof input.reservationNonce !== 'bigint') {
    throw new MalformedInputError(`${context}.reservationNonce`, 'expected a bigint');
  }
  const reservationNonce = checkedUnsigned(
    input.reservationNonce,
    U256_BITS,
    `${context}.reservationNonce`,
  );
  if (reservationNonce === 0n) {
    throw new MalformedInputError(`${context}.reservationNonce`, 'nonce is zero');
  }
  return Object.freeze({
    domain: domainRef(
      input.domain.domainId,
      input.domain.domainManifestVersion,
      input.domain.domainManifestHash,
      `${context}.domain`,
    ),
    solverId: protocolId(input.solverId, `${context}.solverId`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    reservationNonce,
  });
}

export function encodeFirmReservationIdentity(
  writer: CanonicalWriter,
  input: FirmReservationIdentityInput,
): void {
  const checked = firmReservationIdentity(input);
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.solverId, 'firmReservationIdentity.solverId');
  encodeCommitmentHash(writer, checked.orderHash, 'firmReservationIdentity.orderHash');
  writer.writeU256(checked.reservationNonce, 'firmReservationIdentity.reservationNonce');
}

export function firmReservationIdentityBytes(
  input: FirmReservationIdentityInput,
): Uint8Array {
  return canonicalBytes((writer) => encodeFirmReservationIdentity(writer, input));
}

export function firmReservationId(input: FirmReservationIdentityInput): CommitmentHash {
  return commitmentHash(
    domainHash(HASH_DOMAIN.RESERVATION_ID, firmReservationIdentityBytes(input)),
    'firmReservationId',
  );
}

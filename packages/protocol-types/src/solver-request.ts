import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes } from './encoding.js';
import { MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, hash32, protocolId } from './primitives.js';

export const SOLVER_REQUEST_VERSION = 1;
export const SOLVER_REQUEST_METHODS = Object.freeze(['GET', 'POST', 'PUT'] as const);
export type SolverRequestMethod = (typeof SOLVER_REQUEST_METHODS)[number];
const MAX_PATH_BYTES = 512;
const PATH = /^\/v1\/solver\/[\x21-\x7e]*$/;

export interface SolverRequestInput {
  readonly method: SolverRequestMethod;
  /** The request path and query exactly as sent, beginning with /v1/solver/. */
  readonly pathAndQuery: string;
  /** SHA-256 of the exact body bytes sent; the hash of zero bytes for a request without a body. */
  readonly bodySha256: Uint8Array | string;
  readonly solverId: string;
  readonly keyId: string;
  readonly timestampMs: bigint;
  /** 32 random bytes, never reused by the same solver. */
  readonly nonce: Uint8Array | string;
}

/**
 * The digest a solver signs with a registered quote key to authenticate one API request. It binds
 * the method, path and query, body, solver, key, time, and a single-use nonce, so a captured
 * request cannot be replayed, redirected to another route, or given another body.
 */
export function solverRequestDigest(input: SolverRequestInput): CommitmentHash {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError('solverRequest', 'expected an object');
  if (!SOLVER_REQUEST_METHODS.includes(input.method)) throw new MalformedInputError('solverRequest.method', 'unsupported method');
  if (typeof input.pathAndQuery !== 'string' || input.pathAndQuery.length > MAX_PATH_BYTES || !PATH.test(input.pathAndQuery)) {
    throw new MalformedInputError('solverRequest.pathAndQuery', 'expected a printable ASCII /v1/solver/ path of at most 512 bytes');
  }
  if (typeof input.timestampMs !== 'bigint') throw new MalformedInputError('solverRequest.timestampMs', 'expected a bigint');
  const timestamp = checkedUnsigned(input.timestampMs, 64, 'solverRequest.timestampMs');
  const nonce = hash32(input.nonce, 'solverRequest.nonce');
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(SOLVER_REQUEST_VERSION, 'version');
    writer.writeString(input.method, 'method');
    writer.writeString(input.pathAndQuery, 'pathAndQuery');
    writer.writeFixedBytes(hash32(input.bodySha256, 'solverRequest.bodySha256'), 32, 'bodySha256');
    encodeProtocolId(writer, protocolId(input.solverId, 'solverRequest.solverId'), 'solverId');
    encodeProtocolId(writer, protocolId(input.keyId, 'solverRequest.keyId'), 'keyId');
    writer.writeU64(timestamp, 'timestampMs');
    writer.writeFixedBytes(nonce, 32, 'nonce');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.SOLVER_REQUEST, bytes), 'solverRequestDigest');
}


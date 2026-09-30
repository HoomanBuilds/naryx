import { checkedUnsigned } from './arithmetic.js';
import { toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const MAINNET_FUNDS_MANIFEST_VERSION = 1;
const MAX_ITEMS = 64;

/** One funded mainnet operation, bound to the exact unsigned payload that was simulated. */
export interface MainnetFundedOperationInput {
  readonly operationId: string;
  readonly chain: string;
  readonly action: string;
  readonly signerRole: string;
  readonly sourceAccount: string;
  readonly destinationOrContract: string;
  readonly assetId: string;
  readonly maximumPrincipalAtoms: bigint;
  readonly maximumNetworkFeeAtoms: bigint;
  readonly maximumProtocolFeeAtoms: bigint;
  readonly maximumSlippageAtoms: bigint;
  readonly maximumCapitalLockedAtoms: bigint;
  readonly maximumRecoveryTurnoverAtoms: bigint;
  readonly maximumWorstCaseLossAtoms: bigint;
  readonly balanceRequiredBeforeAtoms: bigint;
  readonly expectedBalanceAfterAtoms: bigint;
  readonly recoverable: boolean;
  readonly simulationEvidenceHashes: readonly (Uint8Array | string)[];
  readonly prerequisiteGapIds: readonly string[];
  readonly payloadHash: Uint8Array | string;
}

/**
 * The machine-readable budget every production writer requires. Its hash is what approvers sign;
 * any change to a payload, amount, account, release, or dependency is a different manifest.
 */
export interface MainnetFundsManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly chainIdentity: string;
  /** The reviewed release commit, 40 lowercase hex characters. */
  readonly releaseCommit: string;
  readonly buildArtifactHashes: readonly (Uint8Array | string)[];
  readonly dependencyManifestHash: Uint8Array | string;
  readonly expiresAtMs: bigint;
  readonly approverIds: readonly string[];
  readonly operations: readonly MainnetFundedOperationInput[];
  readonly aggregateCapsByAsset: readonly { readonly assetId: string; readonly maximumAtoms: bigint }[];
  readonly incidentOwner: string;
  readonly stopConditionIds: readonly string[];
}

const ATOM_FIELDS = [
  'maximumPrincipalAtoms',
  'maximumNetworkFeeAtoms',
  'maximumProtocolFeeAtoms',
  'maximumSlippageAtoms',
  'maximumCapitalLockedAtoms',
  'maximumRecoveryTurnoverAtoms',
  'maximumWorstCaseLossAtoms',
  'balanceRequiredBeforeAtoms',
  'expectedBalanceAfterAtoms',
] as const;

function atoms(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, 128, context);
}

function ids(values: readonly string[], context: string, minimum: number): readonly ProtocolId[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > MAX_ITEMS) throw new MalformedInputError(context, `expected ${minimum} to ${MAX_ITEMS} identifiers`);
  const sorted = values.map((value) => protocolId(value, context)).sort();
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i - 1] === sorted[i]) throw new DuplicateElementError(context, 'identifiers repeat');
  return Object.freeze(sorted);
}

function hashes(values: readonly (Uint8Array | string)[], context: string, minimum: number): readonly CommitmentHash[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > MAX_ITEMS) throw new MalformedInputError(context, `expected ${minimum} to ${MAX_ITEMS} hashes`);
  const checked = values.map((value) => commitmentHash(value, context)).sort((a, b) => (toHex(a) < toHex(b) ? -1 : 1));
  for (let i = 1; i < checked.length; i += 1) if (toHex(checked[i - 1] as CommitmentHash) === toHex(checked[i] as CommitmentHash)) throw new DuplicateElementError(context, 'hashes repeat');
  return Object.freeze(checked);
}

/** What one operation can take out of its asset: principal, fees, slippage, and recovery turnover. */
function exposure(operation: MainnetFundedOperationInput): bigint {
  return operation.maximumPrincipalAtoms + operation.maximumNetworkFeeAtoms + operation.maximumProtocolFeeAtoms + operation.maximumSlippageAtoms + operation.maximumRecoveryTurnoverAtoms;
}

export function mainnetFundsManifestBytes(input: MainnetFundsManifestInput): Uint8Array {
  const context = 'mainnetFundsManifest';
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.manifestVersion !== MAINNET_FUNDS_MANIFEST_VERSION) throw new MalformedInputError(`${context}.manifestVersion`, `version must equal ${MAINNET_FUNDS_MANIFEST_VERSION}`);
  if (typeof input.releaseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(input.releaseCommit)) throw new MalformedInputError(`${context}.releaseCommit`, 'expected a 40-character lowercase commit');
  const approvers = ids(input.approverIds, `${context}.approverIds`, 2);
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MAX_ITEMS) throw new MalformedInputError(`${context}.operations`, 'expected 1 to 64 operations');
  const operations = [...input.operations].sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
  ids(operations.map((operation) => operation.operationId), `${context}.operations.operationId`, 1);
  const caps = new Map<string, bigint>();
  for (const cap of input.aggregateCapsByAsset ?? []) {
    const id = protocolId(cap.assetId, `${context}.aggregateCapsByAsset.assetId`);
    if (caps.has(id)) throw new DuplicateElementError(`${context}.aggregateCapsByAsset`, 'an asset has two caps');
    caps.set(id, atoms(cap.maximumAtoms, `${context}.aggregateCapsByAsset.maximumAtoms`));
  }
  const used = new Map<string, bigint>();
  for (const operation of operations) {
    for (const field of ATOM_FIELDS) atoms(operation[field], `${context}.operations.${operation.operationId}.${field}`);
    if (typeof operation.recoverable !== 'boolean') throw new MalformedInputError(`${context}.operations.${operation.operationId}.recoverable`, 'expected a boolean');
    const asset = protocolId(operation.assetId, `${context}.operations.assetId`);
    if (!caps.has(asset)) throw new MalformedInputError(`${context}.aggregateCapsByAsset`, `${asset} has no aggregate cap`);
    used.set(asset, (used.get(asset) ?? 0n) + exposure(operation));
  }
  for (const [asset, total] of used) {
    if (total > (caps.get(asset) as bigint)) throw new MalformedInputError(`${context}.aggregateCapsByAsset`, `${asset} operations can take more than its aggregate cap`);
  }
  return canonicalBytes((writer) => {
    writer.writeU32(MAINNET_FUNDS_MANIFEST_VERSION, 'manifestVersion');
    encodeProtocolId(writer, protocolId(input.environment, `${context}.environment`), 'environment');
    encodeProtocolId(writer, protocolId(input.chainIdentity, `${context}.chainIdentity`), 'chainIdentity');
    encodeProtocolId(writer, protocolId(input.releaseCommit), 'releaseCommit');
    writer.writeArray(hashes(input.buildArtifactHashes, `${context}.buildArtifactHashes`, 1), (w, h) => encodeCommitmentHash(w, h, 'buildArtifactHash'), 'buildArtifactHashes');
    encodeCommitmentHash(writer, commitmentHash(input.dependencyManifestHash, `${context}.dependencyManifestHash`), 'dependencyManifestHash');
    writer.writeU64(checkedUnsigned(input.expiresAtMs, 64, `${context}.expiresAtMs`), 'expiresAtMs');
    writer.writeArray(approvers, (w, id) => encodeProtocolId(w, id, 'approverId'), 'approverIds');
    writer.writeArray(operations, (w, operation) => {
      encodeProtocolId(w, protocolId(operation.operationId), 'operationId');
      for (const field of ['chain', 'action', 'signerRole', 'sourceAccount', 'destinationOrContract', 'assetId'] as const) {
        encodeProtocolId(w, protocolId(operation[field], `${context}.operations.${field}`), field);
      }
      for (const field of ATOM_FIELDS) w.writeU128(operation[field], field);
      w.writeBool(operation.recoverable, 'recoverable');
      w.writeArray(hashes(operation.simulationEvidenceHashes, `${context}.operations.simulationEvidenceHashes`, 1), (i, h) => encodeCommitmentHash(i, h, 'simulationEvidenceHash'), 'simulationEvidenceHashes');
      w.writeArray(ids(operation.prerequisiteGapIds, `${context}.operations.prerequisiteGapIds`, 0), (i, id) => encodeProtocolId(i, id, 'gapId'), 'prerequisiteGapIds');
      encodeCommitmentHash(w, commitmentHash(operation.payloadHash, `${context}.operations.payloadHash`), 'payloadHash');
    }, 'operations');
    writer.writeArray([...caps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), (w, [asset, maximum]) => {
      encodeProtocolId(w, asset as ProtocolId, 'assetId');
      w.writeU128(maximum, 'maximumAtoms');
    }, 'aggregateCapsByAsset');
    encodeProtocolId(writer, protocolId(input.incidentOwner, `${context}.incidentOwner`), 'incidentOwner');
    writer.writeArray(ids(input.stopConditionIds, `${context}.stopConditionIds`, 1), (w, id) => encodeProtocolId(w, id, 'stopConditionId'), 'stopConditionIds');
  });
}

export function mainnetFundsManifestHash(input: MainnetFundsManifestInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.MAINNET_FUNDS_MANIFEST, mainnetFundsManifestBytes(input)), 'mainnetFundsManifestHash');
}

export interface MainnetOperationRequest {
  readonly operationId: string;
  /** Hash of the exact unsigned payload about to be signed. */
  readonly payloadHash: Uint8Array | string;
  readonly principalAtoms: bigint;
  readonly networkFeeAtoms: bigint;
  readonly nowMs: bigint;
}

export interface MainnetOperationContext {
  /** Approver ids whose signatures over the manifest hash were verified by the caller. */
  readonly verifiedApproverIds: readonly string[];
  /** The user's explicit authorization of this exact manifest; a manifest approval alone never suffices. */
  readonly userAuthorizedManifestHash?: Uint8Array | string;
  readonly unresolvedGapIds: readonly string[];
  readonly triggeredStopConditionIds: readonly string[];
}

export type MainnetGateReason =
  | 'MANIFEST_EXPIRED'
  | 'APPROVALS_INSUFFICIENT'
  | 'USER_AUTHORIZATION_MISSING'
  | 'OPERATION_UNKNOWN'
  | 'PAYLOAD_CHANGED'
  | 'PRINCIPAL_ABOVE_CAP'
  | 'NETWORK_FEE_ABOVE_CAP'
  | 'PREREQUISITE_OPEN'
  | 'STOP_CONDITION_TRIGGERED';

/**
 * The mechanical gate in front of every mainnet write. It allows an operation only when the
 * manifest is unexpired, at least two distinct listed approvers signed its hash, the user
 * explicitly authorized this exact manifest, the operation and its exact payload are in it, the
 * amounts are within its caps, none of its prerequisite gaps is open, and no stop condition has
 * fired. Every failing reason is reported; it never allows by default.
 */
export function mainnetOperationGate(
  manifest: MainnetFundsManifestInput,
  request: MainnetOperationRequest,
  context: MainnetOperationContext,
): { readonly allowed: true } | { readonly allowed: false; readonly reasons: readonly MainnetGateReason[] } {
  const manifestHash = toHex(mainnetFundsManifestHash(manifest));
  const reasons: MainnetGateReason[] = [];
  if (checkedUnsigned(request.nowMs, 64, 'mainnetOperationGate.nowMs') >= manifest.expiresAtMs) reasons.push('MANIFEST_EXPIRED');
  const approvers = new Set(context.verifiedApproverIds.filter((id) => manifest.approverIds.includes(id)));
  if (approvers.size < 2) reasons.push('APPROVALS_INSUFFICIENT');
  const authorized = context.userAuthorizedManifestHash;
  if (authorized === undefined || toHex(commitmentHash(authorized, 'mainnetOperationGate.userAuthorizedManifestHash')) !== manifestHash) reasons.push('USER_AUTHORIZATION_MISSING');
  const operation = manifest.operations.find((entry) => entry.operationId === request.operationId);
  if (operation === undefined) reasons.push('OPERATION_UNKNOWN');
  else {
    if (toHex(commitmentHash(request.payloadHash, 'mainnetOperationGate.payloadHash')) !== toHex(commitmentHash(operation.payloadHash))) reasons.push('PAYLOAD_CHANGED');
    if (atoms(request.principalAtoms, 'mainnetOperationGate.principalAtoms') > operation.maximumPrincipalAtoms) reasons.push('PRINCIPAL_ABOVE_CAP');
    if (atoms(request.networkFeeAtoms, 'mainnetOperationGate.networkFeeAtoms') > operation.maximumNetworkFeeAtoms) reasons.push('NETWORK_FEE_ABOVE_CAP');
    if (operation.prerequisiteGapIds.some((gap) => context.unresolvedGapIds.includes(gap))) reasons.push('PREREQUISITE_OPEN');
  }
  if (context.triggeredStopConditionIds.some((id) => manifest.stopConditionIds.includes(id))) reasons.push('STOP_CONDITION_TRIGGERED');
  return reasons.length === 0 ? Object.freeze({ allowed: true as const }) : Object.freeze({ allowed: false as const, reasons: Object.freeze(reasons) });
}

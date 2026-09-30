import { checkedUnsigned } from './arithmetic.js';
import { toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { enumDiscriminant, EXPIRY_UNIT, type ExpiryUnit } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const MANUAL_RECOVERY_INCIDENT_VERSION = 1;
const MAX_APPROVERS = 16;

/**
 * A `MANUAL_CONTROLLED_RECOVERY` incident: automation stops, execution authority is fenced, and
 * only actions a quorum of named approvers approved may run until the verified baseline is restored.
 */
export interface ManualRecoveryIncidentInput {
  readonly incidentVersion: number;
  readonly environment: string;
  readonly incidentId: string;
  readonly orderHash: Uint8Array | string;
  readonly timeUnit: ExpiryUnit;
  readonly fencedAtValue: bigint;
  readonly approverIds: readonly string[];
  readonly approvalQuorum: number;
  /** The state the incident restores, such as a strategy state or position snapshot hash. */
  readonly baselineTargetHash: Uint8Array | string;
}

export interface ManualRecoveryIncident {
  readonly incidentVersion: 1;
  readonly environment: ProtocolId;
  readonly incidentId: ProtocolId;
  readonly orderHash: CommitmentHash;
  readonly timeUnit: ExpiryUnit;
  readonly fencedAtValue: bigint;
  readonly approverIds: readonly ProtocolId[];
  readonly approvalQuorum: number;
  readonly baselineTargetHash: CommitmentHash;
}

export function manualRecoveryIncident(input: ManualRecoveryIncidentInput, context = 'manualRecoveryIncident'): ManualRecoveryIncident {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.incidentVersion !== MANUAL_RECOVERY_INCIDENT_VERSION) throw new MalformedInputError(`${context}.incidentVersion`, `version must equal ${MANUAL_RECOVERY_INCIDENT_VERSION}`);
  enumDiscriminant(EXPIRY_UNIT, input.timeUnit, `${context}.timeUnit`);
  if (!Array.isArray(input.approverIds) || input.approverIds.length === 0 || input.approverIds.length > MAX_APPROVERS) {
    throw new MalformedInputError(`${context}.approverIds`, `expected 1 to ${MAX_APPROVERS} approvers`);
  }
  const approverIds = input.approverIds.map((id) => protocolId(id, `${context}.approverIds`)).sort();
  for (let i = 1; i < approverIds.length; i += 1) if (approverIds[i - 1] === approverIds[i]) throw new DuplicateElementError(`${context}.approverIds`, 'approvers repeat');
  // With more than one approver, one person alone never releases an action.
  const minimum = approverIds.length > 1 ? 2 : 1;
  if (!Number.isSafeInteger(input.approvalQuorum) || input.approvalQuorum < minimum || input.approvalQuorum > approverIds.length) {
    throw new MalformedInputError(`${context}.approvalQuorum`, `quorum must be between ${minimum} and the approver count`);
  }
  if (typeof input.fencedAtValue !== 'bigint') throw new MalformedInputError(`${context}.fencedAtValue`, 'expected a bigint');
  return Object.freeze({
    incidentVersion: 1 as const,
    environment: protocolId(input.environment, `${context}.environment`),
    incidentId: protocolId(input.incidentId, `${context}.incidentId`),
    orderHash: commitmentHash(input.orderHash, `${context}.orderHash`),
    timeUnit: input.timeUnit,
    fencedAtValue: checkedUnsigned(input.fencedAtValue, 64, `${context}.fencedAtValue`),
    approverIds: Object.freeze(approverIds),
    approvalQuorum: input.approvalQuorum,
    baselineTargetHash: commitmentHash(input.baselineTargetHash, `${context}.baselineTargetHash`),
  });
}

export function manualRecoveryIncidentHash(input: ManualRecoveryIncidentInput): CommitmentHash {
  const incident = manualRecoveryIncident(input);
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(incident.incidentVersion, 'incidentVersion');
    encodeProtocolId(writer, incident.environment, 'environment');
    encodeProtocolId(writer, incident.incidentId, 'incidentId');
    encodeCommitmentHash(writer, incident.orderHash, 'orderHash');
    writer.writeEnum(EXPIRY_UNIT, incident.timeUnit, 'timeUnit');
    writer.writeU64(incident.fencedAtValue, 'fencedAtValue');
    writer.writeArray(incident.approverIds, (inner, id) => encodeProtocolId(inner, id, 'approverId'), 'approverIds');
    writer.writeU32(incident.approvalQuorum, 'approvalQuorum');
    encodeCommitmentHash(writer, incident.baselineTargetHash, 'baselineTargetHash');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.MANUAL_RECOVERY_INCIDENT, bytes), 'manualRecoveryIncidentHash');
}

/** One named approver's signed approval of one recovery action within one incident. */
export interface ManualRecoveryApprovalInput {
  readonly incidentHash: Uint8Array | string;
  readonly actionHash: Uint8Array | string;
  readonly approverId: string;
  readonly atValue: bigint;
}

export function manualRecoveryApprovalHash(input: ManualRecoveryApprovalInput): CommitmentHash {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError('manualRecoveryApproval', 'expected an object');
  const bytes = canonicalBytes((writer) => {
    writer.writeU32(MANUAL_RECOVERY_INCIDENT_VERSION, 'incidentVersion');
    encodeCommitmentHash(writer, commitmentHash(input.incidentHash, 'manualRecoveryApproval.incidentHash'), 'incidentHash');
    encodeCommitmentHash(writer, commitmentHash(input.actionHash, 'manualRecoveryApproval.actionHash'), 'actionHash');
    encodeProtocolId(writer, protocolId(input.approverId, 'manualRecoveryApproval.approverId'), 'approverId');
    writer.writeU64(checkedUnsigned(input.atValue, 64, 'manualRecoveryApproval.atValue'), 'atValue');
  });
  return commitmentHash(domainHash(HASH_DOMAIN.MANUAL_RECOVERY_APPROVAL, bytes), 'manualRecoveryApprovalHash');
}

export type ManualRecoveryEvent =
  | { readonly kind: 'ACTION_APPROVED'; readonly actionHash: Uint8Array | string; readonly approverId: string; readonly atValue: bigint }
  | { readonly kind: 'ACTION_EXECUTED'; readonly actionHash: Uint8Array | string; readonly evidenceHash: Uint8Array | string; readonly atValue: bigint }
  | { readonly kind: 'AUTOMATED_ACTION_ATTEMPTED'; readonly actionHash: Uint8Array | string; readonly atValue: bigint }
  | { readonly kind: 'BASELINE_VERIFIED'; readonly baselineHash: Uint8Array | string; readonly evidenceHash: Uint8Array | string; readonly atValue: bigint };

export interface ManualRecoveryState {
  readonly incidentHash: string;
  readonly phase: 'FENCED' | 'RESTORED';
  /** Actions that reached quorum, with the approvers counted toward it. */
  readonly approvedActions: readonly { readonly actionHash: string; readonly approvers: readonly string[] }[];
  readonly executedActions: readonly string[];
  /** Automated actions refused while fenced; automation never runs during an incident. */
  readonly refusedAutomatedActions: number;
  readonly violations: readonly string[];
}

/**
 * Replays an incident. Approvals count once per named approver; an action executes only after
 * reaching quorum, and only once; any execution without quorum is a violation. The incident is
 * restored only by baseline evidence for exactly the target hash, after which nothing more runs.
 */
export function replayManualRecovery(incidentInput: ManualRecoveryIncidentInput, events: readonly ManualRecoveryEvent[]): ManualRecoveryState {
  const incident = manualRecoveryIncident(incidentInput);
  if (!Array.isArray(events) || events.length > 1_024) throw new MalformedInputError('replayManualRecovery.events', 'too many events');
  const approvals = new Map<string, Set<string>>();
  const executed: string[] = [];
  const violations: string[] = [];
  let refused = 0;
  let phase: 'FENCED' | 'RESTORED' = 'FENCED';
  let lastAt = incident.fencedAtValue;
  for (const [index, event] of events.entries()) {
    const at = checkedUnsigned(event.atValue, 64, `events[${index}].atValue`);
    if (at < lastAt) {
      violations.push(`events[${index}] runs backward in time`);
      continue;
    }
    lastAt = at;
    if (phase === 'RESTORED') {
      violations.push(`events[${index}] arrived after the baseline was restored`);
      continue;
    }
    switch (event.kind) {
      case 'ACTION_APPROVED': {
        const action = toHex(commitmentHash(event.actionHash, `events[${index}].actionHash`));
        if (!incident.approverIds.includes(event.approverId as ProtocolId)) {
          violations.push(`${event.approverId} is not an approver of this incident`);
          break;
        }
        const set = approvals.get(action) ?? new Set<string>();
        set.add(event.approverId);
        approvals.set(action, set);
        break;
      }
      case 'ACTION_EXECUTED': {
        const action = toHex(commitmentHash(event.actionHash, `events[${index}].actionHash`));
        commitmentHash(event.evidenceHash, `events[${index}].evidenceHash`);
        if ((approvals.get(action)?.size ?? 0) < incident.approvalQuorum) violations.push(`action ${action} executed without quorum`);
        else if (executed.includes(action)) violations.push(`action ${action} executed twice`);
        else executed.push(action);
        break;
      }
      case 'AUTOMATED_ACTION_ATTEMPTED':
        commitmentHash(event.actionHash, `events[${index}].actionHash`);
        refused += 1;
        break;
      case 'BASELINE_VERIFIED': {
        commitmentHash(event.evidenceHash, `events[${index}].evidenceHash`);
        if (toHex(commitmentHash(event.baselineHash, `events[${index}].baselineHash`)) !== toHex(incident.baselineTargetHash)) {
          violations.push('the verified baseline is not the incident target');
        } else if (violations.length > 0) {
          violations.push('the baseline cannot restore an incident with violations');
        } else {
          phase = 'RESTORED';
        }
        break;
      }
      default:
        violations.push(`events[${index}] has an unknown kind`);
    }
  }
  return Object.freeze({
    incidentHash: toHex(manualRecoveryIncidentHash(incidentInput)),
    phase,
    approvedActions: Object.freeze(
      [...approvals.entries()]
        .filter(([, set]) => set.size >= incident.approvalQuorum)
        .map(([actionHash, set]) => Object.freeze({ actionHash, approvers: Object.freeze([...set].sort()) })),
    ),
    executedActions: Object.freeze(executed),
    refusedAutomatedActions: refused,
    violations: Object.freeze(violations),
  });
}

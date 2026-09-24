import { createHash } from 'node:crypto';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreBatchedOrderAction,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  canonicalBytes,
  encodeAdapterRef,
  encodeAssetRef,
  encodeRecoveryPlan,
  encodeVersionedManifestRef,
} from '@naryx/protocol-types';
import {
  beginHyperliquidReconciliation,
  createHyperliquidPackageAttempt,
  markHyperliquidSubmissionUnknown,
  type HyperliquidAccountIdentityInput,
  type HyperliquidPackageAttempt,
} from './index.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TWO_DAYS_MS = 172_800n * 1_000n;
const ONE_DAY_MS = 86_400n * 1_000n;

export const HYPERLIQUID_NONCE_WINDOW_SIZE = 100;
export const HYPERLIQUID_SIGNER_LEASE_POLICY = 'ONE_PROCESS_PER_AGENT_WALLET';
export const HYPERLIQUID_NONCE_POLICY = 'STRICTLY_INCREASING_PER_AGENT_WALLET';
export const NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME =
  'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1';

export type HyperliquidSubmissionStatus =
  | 'PREPARED'
  | 'DURABLE_RECORD_CONFIRMED'
  | 'SUBMITTED_UNKNOWN'
  | 'ACKNOWLEDGED'
  | 'RECONCILING'
  | 'REJECTED'
  | 'FENCED';

export interface HyperliquidSubmissionRecord {
  readonly attemptId: string;
  readonly status: HyperliquidSubmissionStatus;
  readonly account: HyperliquidPackageAttempt['account'];
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: HypercoreBatchedOrderAction;
  readonly actionCommitmentScheme: typeof NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
  readonly packageAttempt: HyperliquidPackageAttempt;
  readonly durableRevision: string | null;
  readonly acknowledgementId: string | null;
  readonly rejectionId: string | null;
}

export interface HyperliquidAgentJournal {
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly status: 'ACTIVE' | 'FENCED' | 'RETIRED';
  readonly highestReservedNonce: bigint | null;
  readonly attempts: readonly HyperliquidSubmissionRecord[];
}

export interface HyperliquidSubmissionJournal {
  readonly version: bigint;
  readonly agents: readonly HyperliquidAgentJournal[];
}

export interface HyperliquidPrepareInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidExecutionPlan;
  readonly account: HyperliquidAccountIdentityInput;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidReconciliationHandoff {
  readonly attemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly account: HyperliquidSubmissionRecord['account'];
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
  readonly attempt: HyperliquidPackageAttempt;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(value: string, name: string): string {
  requireCondition(IDENTIFIER.test(value), `${name} is invalid`);
  return value;
}

function address(value: string, name: string): `0x${string}` {
  requireCondition(ADDRESS.test(value), `${name} must be a 20-byte address`);
  return value.toLowerCase() as `0x${string}`;
}

function sha256(value: string | Uint8Array): `0x${string}` {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function normalizedOrder(order: HypercoreOrderWire): HypercoreOrderWire {
  requireCondition(order.t.limit.tif === 'Ioc', 'only IOC orders are supported');
  return Object.freeze({
    a: order.a,
    b: order.b,
    p: order.p,
    s: order.s,
    r: order.r,
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' }) }),
    c: order.c.toLowerCase() as `0x${string}`,
  });
}

function orderFields(order: HypercoreOrderWire): readonly (string | number | boolean)[] {
  return [order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c.toLowerCase()];
}

function normalizedAction(plan: HyperliquidExecutionPlan): HypercoreBatchedOrderAction {
  const { action } = plan.unsignedRequestFields;
  requireCondition(action.type === 'order' && action.grouping === 'na', 'unsupported HyperCore action');
  requireCondition(action.orders.length === 2 && plan.legs.length === 2, 'two IOC legs are required');
  const first = normalizedOrder(action.orders[0]);
  const second = normalizedOrder(action.orders[1]);
  const spot = plan.legs.find((leg) => leg.role === 'SPOT');
  const perpetual = plan.legs.find((leg) => leg.role === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined, 'distinct plan legs are required');
  requireCondition(spot.clientOrderId.toLowerCase() !== perpetual.clientOrderId.toLowerCase(), 'client order IDs must differ');
  for (const leg of [spot, perpetual]) {
    const matching = [first, second].filter((order) => order.c === leg.clientOrderId.toLowerCase());
    requireCondition(
      matching.length === 1 && JSON.stringify(orderFields(matching[0]!)) === JSON.stringify(orderFields(leg.order)),
      `${leg.role} action does not match its planned leg`,
    );
  }
  return Object.freeze({ type: 'order', orders: Object.freeze([first, second] as const), grouping: 'na' });
}

function actionCommitment(action: HypercoreBatchedOrderAction): `0x${string}` {
  return sha256(JSON.stringify([NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME, action.type,
    action.orders.map(orderFields), action.grouping]));
}

function recoveryPolicyCommitment(
  plan: HyperliquidSubmissionRecord['packageAttempt']['plan'],
): `0x${string}` {
  return sha256(canonicalBytes((writer) => encodeRecoveryPlan(writer, plan.recoveryPolicy)));
}

function recoveryLegsCommitment(
  plan: HyperliquidSubmissionRecord['packageAttempt']['plan'],
): `0x${string}` {
  return sha256(canonicalBytes((writer) => {
    writer.writeArray(plan.legs, (target, leg) => {
      target.writeU8(leg.legIndex, 'leg.legIndex');
      target.writeString(leg.role, 'leg.role');
      encodeAdapterRef(target, leg.adapter);
      encodeVersionedManifestRef(target, leg.venue);
      encodeVersionedManifestRef(target, leg.market);
      encodeAssetRef(target, leg.baseAsset);
      encodeAssetRef(target, leg.quoteAsset);
      target.writeString(leg.side, 'leg.side');
      target.writeU128(leg.quantityAtoms, 'leg.quantityAtoms');
      target.writeU8(leg.sizeDecimals, 'leg.sizeDecimals');
      target.writeU8(leg.maxPriceDecimals, 'leg.maxPriceDecimals');
      target.writeI128(leg.signedBaseDeltaAtoms, 'leg.signedBaseDeltaAtoms');
      target.writeString(leg.clientOrderId, 'leg.clientOrderId');
      target.writeU32(leg.order.a, 'leg.order.assetId');
      target.writeBool(leg.order.b, 'leg.order.isBuy');
      target.writeString(leg.order.p, 'leg.order.price');
      target.writeString(leg.order.s, 'leg.order.size');
      target.writeBool(leg.order.r, 'leg.order.reduceOnly');
      target.writeString(leg.order.t.limit.tif, 'leg.order.timeInForce');
      target.writeString(leg.order.c, 'leg.order.clientOrderId');
    }, 'recoveryLegs');
  }));
}

function recordCommitment(record: Omit<HyperliquidSubmissionRecord,
  'status' | 'recordHash' | 'durableRevision' | 'acknowledgementId' | 'rejectionId'>): `0x${string}` {
  const { plan } = record.packageAttempt;
  const policy = plan.terminalResidualPolicy;
  const policyFields = policy.kind === 'EXACT_NET'
    ? [policy.kind, policy.netSpotDeltaAtoms.toString()]
    : [policy.kind, policy.minNetSpotDeltaAtoms.toString(), policy.maxNetSpotDeltaAtoms.toString(),
      policy.maxTerminalResidualBaseAtoms.toString(), policy.maxTerminalResidualQuoteAtoms.toString(),
      policy.residualValuationSchemaVersion,
      policy.residualValuationReferencePrice.baseAtoms.toString(),
      policy.residualValuationReferencePrice.quoteAtoms.toString(),
      policy.residualValuationReferencePrice.baseAsset.assetId,
      policy.residualValuationReferencePrice.baseAsset.decimals,
      hex(policy.residualValuationReferencePrice.baseAsset.assetManifestHash),
      policy.residualValuationReferencePrice.quoteAsset.assetId,
      policy.residualValuationReferencePrice.quoteAsset.decimals,
      hex(policy.residualValuationReferencePrice.quoteAsset.assetManifestHash),
      policy.residualValuationReferencePrice.roundingDirection];
  return sha256(JSON.stringify(['naryx/hypercore/submission-record/v1', record.attemptId,
    plan.domain.domainId, plan.domain.domainManifestVersion, hex(plan.domain.domainManifestHash),
    hex(plan.commitments.seriesManifestHash), hex(plan.commitments.executionClassManifestHash),
    hex(plan.commitments.orderHash), hex(plan.commitments.quoteHash), hex(plan.commitments.routeHash),
    record.account.masterAccount, record.account.tradingAccount, record.account.accountKind,
    record.agentWallet, record.signerLeaseId, record.nonce.toString(),
    record.expiresAfterMs.toString(), record.vaultAddress,
    record.actionCommitmentScheme, record.actionHash,
    record.spotClientOrderId, record.perpetualClientOrderId,
    recoveryLegsCommitment(plan), recoveryPolicyCommitment(plan),
    plan.plannedSpotDeltaAtoms.toString(), plan.prePerpetualPositionAtoms.toString(),
    plan.plannedPerpetualDeltaAtoms.toString(), plan.perpetualPositionTargetAtoms.toString(),
    plan.recoveryDeadlineMs.toString(), policyFields]));
}

function agentAt(journal: HyperliquidSubmissionJournal, agentWallet: string): number {
  return journal.agents.findIndex((agent) => agent.agentWallet === agentWallet);
}

function locate(journal: HyperliquidSubmissionJournal, attemptId: string):
  { agentIndex: number; recordIndex: number; agent: HyperliquidAgentJournal; record: HyperliquidSubmissionRecord } {
  for (const [agentIndex, agent] of journal.agents.entries()) {
    const recordIndex = agent.attempts.findIndex((record) => record.attemptId === attemptId);
    if (recordIndex >= 0) {
      const record = agent.attempts[recordIndex]!;
      requireCondition(record.actionCommitmentScheme === NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
        'journal action commitment scheme is unsupported');
      requireCondition(record.actionHash === actionCommitment(record.action), 'journal action was modified');
      requireCondition(record.recordHash === recordCommitment(record), 'journal record was modified');
      return { agentIndex, recordIndex, agent, record };
    }
  }
  throw new Error('attempt ID is unknown');
}

function checkVersion(journal: HyperliquidSubmissionJournal, expectedVersion: bigint): void {
  requireCondition(expectedVersion === journal.version, 'journal compare-and-set version mismatch');
}

function replaceAgent(
  journal: HyperliquidSubmissionJournal,
  index: number,
  agent: HyperliquidAgentJournal,
): HyperliquidSubmissionJournal {
  const agents = [...journal.agents];
  agents[index] = Object.freeze(agent);
  return Object.freeze({ version: journal.version + 1n, agents: Object.freeze(agents) });
}

function replaceRecord(
  journal: HyperliquidSubmissionJournal,
  agentIndex: number,
  recordIndex: number,
  record: HyperliquidSubmissionRecord,
): HyperliquidSubmissionJournal {
  const agent = journal.agents[agentIndex]!;
  const attempts = [...agent.attempts];
  attempts[recordIndex] = Object.freeze(record);
  return replaceAgent(journal, agentIndex, { ...agent, attempts: Object.freeze(attempts) });
}

export function createHyperliquidSubmissionJournal(): HyperliquidSubmissionJournal {
  return Object.freeze({ version: 0n, agents: Object.freeze([]) });
}

export function registerHyperliquidAgentWallet(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly agentWallet: `0x${string}`; readonly signerLeaseId: string },
): HyperliquidSubmissionJournal {
  const agentWallet = address(input.agentWallet, 'agentWallet');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  requireCondition(agentAt(journal, agentWallet) < 0, 'agent wallet is already registered or retired');
  requireCondition(
    journal.agents.every((agent) => agent.signerLeaseId !== signerLeaseId),
    'signer process lease is already assigned',
  );
  checkVersion(journal, input.expectedVersion);
  return Object.freeze({
    version: journal.version + 1n,
    agents: Object.freeze([...journal.agents, Object.freeze({
      agentWallet, signerLeaseId, status: 'ACTIVE', highestReservedNonce: null,
      attempts: Object.freeze([]),
    })]),
  });
}

export function prepareHyperliquidSubmission(
  journal: HyperliquidSubmissionJournal,
  input: HyperliquidPrepareInput,
): HyperliquidSubmissionJournal {
  const attemptId = identifier(input.attemptId, 'attemptId');
  const agentWallet = address(input.agentWallet, 'agentWallet');
  const signerLeaseId = identifier(input.signerLeaseId, 'signerLeaseId');
  const agentIndex = agentAt(journal, agentWallet);
  requireCondition(agentIndex >= 0, 'agent wallet is not registered');
  const agent = journal.agents[agentIndex]!;
  requireCondition(agent.signerLeaseId === signerLeaseId, 'signer process lease mismatch');
  requireCondition(input.plan.version === 1 && input.plan.guarantee === HYPERCORE_EXECUTION_GUARANTEE,
    'unsupported HyperCore plan');
  const packageAttempt = createHyperliquidPackageAttempt(input.plan, input.account);
  requireCondition(packageAttempt.plan.domain.domainId === 'hypercore:testnet', 'only HyperCore testnet is supported');
  requireCondition(agentWallet !== packageAttempt.account.masterAccount
    && agentWallet !== packageAttempt.account.tradingAccount,
  'agent wallet must be distinct from account query identity');
  requireCondition(Number.isSafeInteger(input.plan.unsignedRequestFields.expiresAfter)
    && BigInt(input.plan.unsignedRequestFields.expiresAfter) === input.plan.requestExpiryMs,
  'unsigned expiresAfter does not match the plan');
  requireCondition(input.nowMs > 0n && input.nonce > 0n, 'clock and nonce must be positive');
  requireCondition(input.nonce >= input.nowMs - TWO_DAYS_MS
    && input.nonce <= input.nowMs + ONE_DAY_MS, 'nonce is outside HyperCore time window');
  requireCondition(input.plan.requestExpiryMs > input.nowMs
    && input.plan.requestExpiryMs > input.nonce, 'expiresAfter is stale');
  const action = normalizedAction(input.plan);
  const actionHash = actionCommitment(action);
  const vaultAddress = input.vaultAddress === null ? null : address(input.vaultAddress, 'vaultAddress');
  requireCondition(packageAttempt.account.accountKind === 'MASTER'
    ? vaultAddress === null
    : vaultAddress === packageAttempt.account.tradingAccount,
  'vault context must match trading account identity');
  const core: Omit<HyperliquidSubmissionRecord,
    'status' | 'recordHash' | 'durableRevision' | 'acknowledgementId' | 'rejectionId'> = {
    attemptId,
    account: packageAttempt.account,
    agentWallet,
    signerLeaseId,
    nonce: input.nonce,
    expiresAfterMs: input.plan.requestExpiryMs,
    vaultAddress,
    action,
    actionCommitmentScheme: NARYX_HYPERCORE_ACTION_COMMITMENT_SCHEME,
    actionHash,
    spotClientOrderId: packageAttempt.plan.spotClientOrderId,
    perpetualClientOrderId: packageAttempt.plan.perpetualClientOrderId,
    packageAttempt,
  };
  const recordHash = recordCommitment(core);
  const existing = journal.agents.flatMap((entry) => entry.attempts)
    .find((record) => record.attemptId === attemptId);
  if (existing !== undefined) {
    requireCondition(existing.actionHash === actionCommitment(existing.action)
      && existing.recordHash === recordCommitment(existing), 'journal record was modified');
    requireCondition(existing.recordHash === recordHash, 'attempt replay changed its binding');
    return journal;
  }
  requireCondition(agent.status === 'ACTIVE', 'agent wallet is fenced or retired');
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.highestReservedNonce === null || input.nonce > agent.highestReservedNonce,
    'nonce must strictly increase for the agent wallet');
  const record: HyperliquidSubmissionRecord = Object.freeze({
    ...core, recordHash, status: 'PREPARED', durableRevision: null,
    acknowledgementId: null, rejectionId: null,
  });
  return replaceAgent(journal, agentIndex, {
    ...agent,
    highestReservedNonce: input.nonce,
    attempts: Object.freeze([...agent.attempts, record]),
  });
}

export function confirmHyperliquidDurableRecord(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string;
    readonly recordHash: `0x${string}`; readonly durableRevision: string },
): HyperliquidSubmissionJournal {
  const { agentIndex, recordIndex, record } = locate(journal, input.attemptId);
  const durableRevision = identifier(input.durableRevision, 'durableRevision');
  requireCondition(input.recordHash === record.recordHash, 'durable record hash mismatch');
  if (record.status !== 'PREPARED' && record.durableRevision === durableRevision) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(record.status === 'PREPARED', 'durable confirmation requires PREPARED');
  return replaceRecord(journal, agentIndex, recordIndex,
    { ...record, status: 'DURABLE_RECORD_CONFIRMED', durableRevision });
}

function transition(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string },
  from: readonly HyperliquidSubmissionStatus[],
  to: HyperliquidSubmissionStatus,
): HyperliquidSubmissionJournal {
  const { agentIndex, recordIndex, agent, record } = locate(journal, input.attemptId);
  if (record.status === to) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.status === 'ACTIVE', 'agent wallet is fenced or retired');
  requireCondition(from.includes(record.status), `${to} cannot follow ${record.status}`);
  return replaceRecord(journal, agentIndex, recordIndex, { ...record, status: to });
}

export function markHyperliquidSubmittedUnknown(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string; readonly nowMs: bigint },
): HyperliquidSubmissionJournal {
  const { record } = locate(journal, input.attemptId);
  if (record.status !== 'SUBMITTED_UNKNOWN') {
    requireCondition(input.nowMs > 0n && input.nowMs < record.expiresAfterMs,
      'expiresAfter is stale before submission');
    requireCondition(record.nonce >= input.nowMs - TWO_DAYS_MS
      && record.nonce <= input.nowMs + ONE_DAY_MS,
    'nonce is outside HyperCore time window before submission');
  }
  return transition(journal, input, ['DURABLE_RECORD_CONFIRMED'], 'SUBMITTED_UNKNOWN');
}

export function acknowledgeHyperliquidSubmission(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string;
    readonly acknowledgementId: string },
): HyperliquidSubmissionJournal {
  const { agentIndex, recordIndex, agent, record } = locate(journal, input.attemptId);
  const acknowledgementId = identifier(input.acknowledgementId, 'acknowledgementId');
  if (record.acknowledgementId === acknowledgementId) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.status === 'ACTIVE' && record.status === 'SUBMITTED_UNKNOWN',
    'acknowledgement requires submitted-unknown state');
  return replaceRecord(journal, agentIndex, recordIndex,
    { ...record, status: 'ACKNOWLEDGED', acknowledgementId });
}

export function rejectHyperliquidSubmission(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string;
    readonly rejectionId: string },
): HyperliquidSubmissionJournal {
  const { agentIndex, recordIndex, agent, record } = locate(journal, input.attemptId);
  const rejectionId = identifier(input.rejectionId, 'rejectionId');
  if (record.rejectionId === rejectionId) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.status === 'ACTIVE' && record.status === 'SUBMITTED_UNKNOWN',
    'rejection requires submitted-unknown state');
  return replaceRecord(journal, agentIndex, recordIndex,
    { ...record, status: 'REJECTED', rejectionId });
}

export function beginHyperliquidSubmissionReconciliation(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly attemptId: string },
): HyperliquidSubmissionJournal {
  return transition(journal, input,
    ['DURABLE_RECORD_CONFIRMED', 'SUBMITTED_UNKNOWN', 'ACKNOWLEDGED', 'REJECTED'],
    'RECONCILING');
}

export function fenceHyperliquidAgentWallet(
  journal: HyperliquidSubmissionJournal,
  input: { readonly expectedVersion: bigint; readonly agentWallet: `0x${string}`;
    readonly signerLeaseId: string; readonly disposition: 'FENCED' | 'RETIRED' },
): HyperliquidSubmissionJournal {
  requireCondition(input.disposition === 'FENCED' || input.disposition === 'RETIRED',
    'agent disposition is unsupported');
  const agentIndex = agentAt(journal, address(input.agentWallet, 'agentWallet'));
  requireCondition(agentIndex >= 0, 'agent wallet is not registered');
  const agent = journal.agents[agentIndex]!;
  requireCondition(agent.signerLeaseId === input.signerLeaseId, 'signer process lease mismatch');
  if (agent.status === input.disposition) return journal;
  checkVersion(journal, input.expectedVersion);
  requireCondition(agent.status === 'ACTIVE', 'fenced or retired wallet cannot be reactivated');
  return replaceAgent(journal, agentIndex, {
    ...agent,
    status: input.disposition,
    attempts: Object.freeze(agent.attempts.map((record) => Object.freeze({
      ...record, status: 'FENCED' as const,
    }))),
  });
}

export function hyperliquidReconciliationHandoff(
  journal: HyperliquidSubmissionJournal,
  attemptId: string,
): HyperliquidReconciliationHandoff {
  const { record } = locate(journal, attemptId);
  requireCondition(record.durableRevision !== null, 'unconfirmed record cannot be reconciled');
  const attempt = beginHyperliquidReconciliation(
    markHyperliquidSubmissionUnknown(structuredClone(record.packageAttempt)),
  );
  return Object.freeze({
    attemptId: record.attemptId,
    agentWallet: record.agentWallet,
    account: record.account,
    actionHash: record.actionHash,
    actionCommitmentScheme: record.actionCommitmentScheme,
    nonce: record.nonce,
    expiresAfterMs: record.expiresAfterMs,
    vaultAddress: record.vaultAddress,
    spotClientOrderId: record.spotClientOrderId,
    perpetualClientOrderId: record.perpetualClientOrderId,
    attempt,
  });
}

import {
  bytesEqual,
  commitmentHash,
  crossDomainPlanHash,
  domainRef,
  protocolId,
  toHex,
  type CommitmentHash,
  type CrossDomainCompensationKind,
  type CrossDomainEvent,
  type CrossDomainFinality,
  type DomainRef,
} from '@naryx/protocol-types';
import type { PreparedStrategyDomainTransport } from './strategy-execution-transport.js';
import type {
  CrossDomainDriverAdvanceInput,
  CrossDomainExecutionDriver,
} from './cross-domain-execution-coordinator.js';

const EVM_TEST_CHAIN_REFERENCES = new Set([84_532n, 421_614n]);

export type EvmCrossDomainPhase = 'PREPARE' | 'COMMIT' | 'COMPENSATE';

export type EvmCrossDomainPhaseResult = Readonly<
  | { status: 'PENDING' }
  | {
      status: 'DEFINITIVE_PREPARE_FAILURE';
      evidenceHash: Uint8Array | string;
      atValue: bigint;
    }
  | {
      status: CrossDomainFinality;
      evidenceHash: Uint8Array | string;
      atValue: bigint;
    }
>;

export interface EvmCrossDomainLaneInput extends CrossDomainDriverAdvanceInput {
  readonly phase: EvmCrossDomainPhase;
}

export interface EvmCrossDomainFinalityInput extends EvmCrossDomainLaneInput {
  readonly evidenceHash: CommitmentHash;
}

export interface EvmCrossDomainExecutionLane {
  readonly environment: 'testnet';
  readonly domain: DomainRef;
  readonly chainReference: bigint;
  chainId(): Promise<bigint>;
  currentTime(): Promise<bigint>;
  start(input: Readonly<EvmCrossDomainLaneInput>): Promise<EvmCrossDomainPhaseResult>;
  awaitFinality(input: Readonly<EvmCrossDomainFinalityInput>): Promise<EvmCrossDomainPhaseResult>;
}

export interface EvmCrossDomainCompensationProfile {
  readonly executorClassId: string;
  readonly executorClassVersion: number;
  readonly executorClassManifestHash: Uint8Array | string;
  readonly allowedActionKinds: readonly CrossDomainCompensationKind[];
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM cross-domain execution refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function domainChainReference(domainId: string): bigint {
  const match = /^eip155:([1-9][0-9]*)$/.exec(domainId);
  requireCondition(match !== null, 'domain is not an EVM chain');
  return BigInt(match[1]!);
}

function executionLegIds(execution: PreparedStrategyDomainTransport): readonly string[] {
  if (execution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT') return execution.legIds;
  if (execution.kind === 'EVM_ASYNC_EXECUTOR') {
    return execution.plan.stages.flatMap((stage) => stage.calls.map((call) => call.legId));
  }
  throw new Error('EVM cross-domain execution refused: domain execution is not EVM');
}

function phaseForAwait(input: CrossDomainDriverAdvanceInput): Readonly<{
  phase: EvmCrossDomainPhase;
  kind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED';
  evidenceHash: CommitmentHash;
}> {
  const event = [...input.events].reverse().find((candidate) => candidate.domainId === input.action.domainId
    && candidate.kind !== 'PREPARE_FAILED' && candidate.finality !== 'FINALIZED');
  requireCondition(event !== undefined && event.kind !== 'PREPARE_FAILED', 'no pending domain evidence is available');
  return Object.freeze({
    phase: event.kind === 'PREPARED' ? 'PREPARE' : event.kind === 'COMMITTED' ? 'COMMIT' : 'COMPENSATE',
    kind: event.kind,
    evidenceHash: commitmentHash(event.evidenceHash, 'pending evidence hash'),
  });
}

function eventKind(phase: EvmCrossDomainPhase): 'PREPARED' | 'COMMITTED' | 'COMPENSATED' {
  return phase === 'PREPARE' ? 'PREPARED' : phase === 'COMMIT' ? 'COMMITTED' : 'COMPENSATED';
}

export class EvmCrossDomainExecutionDriver implements CrossDomainExecutionDriver {
  readonly domain: DomainRef;
  readonly #lane: EvmCrossDomainExecutionLane;
  readonly #executorClassId: string;
  readonly #executorClassVersion: number;
  readonly #executorClassManifestHash: CommitmentHash;
  readonly #allowedActionKinds: ReadonlySet<CrossDomainCompensationKind>;

  constructor(lane: EvmCrossDomainExecutionLane, profile: EvmCrossDomainCompensationProfile) {
    requireCondition(lane.environment === 'testnet', 'lane environment is not testnet');
    const chainReference = domainChainReference(lane.domain.domainId);
    requireCondition(EVM_TEST_CHAIN_REFERENCES.has(chainReference), 'only Base Sepolia and Arbitrum Sepolia are allowed');
    requireCondition(chainReference === lane.chainReference, 'lane chain reference differs from its domain');
    requireCondition(Number.isSafeInteger(profile.executorClassVersion) && profile.executorClassVersion > 0,
      'compensation executor class version is invalid');
    requireCondition(profile.allowedActionKinds.length > 0
      && new Set(profile.allowedActionKinds).size === profile.allowedActionKinds.length,
    'compensation action kinds are empty or duplicated');
    this.domain = domainRef(
      lane.domain.domainId,
      lane.domain.domainManifestVersion,
      lane.domain.domainManifestHash,
      'lane.domain',
    );
    this.#lane = lane;
    this.#executorClassId = protocolId(profile.executorClassId, 'compensation.executorClassId');
    this.#executorClassVersion = profile.executorClassVersion;
    this.#executorClassManifestHash = commitmentHash(
      profile.executorClassManifestHash,
      'compensation.executorClassManifestHash',
    );
    this.#allowedActionKinds = new Set(profile.allowedActionKinds);
  }

  async advance(input: Readonly<CrossDomainDriverAdvanceInput>): Promise<CrossDomainEvent | undefined> {
    this.#validateInput(input);
    requireCondition(await this.#lane.chainId() === this.#lane.chainReference, 'RPC chain identity differs from the lane');
    const now = await this.#lane.currentTime();
    requireCondition(now >= 0n, 'lane time is negative');

    let phase: EvmCrossDomainPhase;
    let expectedKind: 'PREPARED' | 'COMMITTED' | 'COMPENSATED';
    let result: EvmCrossDomainPhaseResult;
    let pendingEvidence: CommitmentHash | undefined;
    if (input.action.kind === 'AWAIT_FINALITY') {
      const pending = phaseForAwait(input);
      phase = pending.phase;
      expectedKind = pending.kind;
      pendingEvidence = pending.evidenceHash;
      result = await this.#lane.awaitFinality({ ...input, phase, evidenceHash: pending.evidenceHash });
    } else {
      phase = input.action.kind;
      expectedKind = eventKind(phase);
      const deadline = phase === 'PREPARE'
        ? input.plan.prepareDeadline
        : phase === 'COMMIT'
          ? input.plan.commitDeadline
          : input.plan.compensationDeadline;
      requireCondition(now <= deadline, `${phase.toLowerCase()} deadline has passed`);
      result = await this.#lane.start({ ...input, phase });
    }
    if (result.status === 'PENDING') return undefined;
    requireCondition(result.atValue >= 0n && result.atValue <= now, 'lane evidence time is invalid');
    const evidenceHash = commitmentHash(result.evidenceHash, 'lane evidence hash');
    if (pendingEvidence !== undefined) {
      requireCondition(bytesEqual(evidenceHash, pendingEvidence), 'finality evidence differs from the submitted evidence');
    }
    if (result.status === 'DEFINITIVE_PREPARE_FAILURE') {
      requireCondition(phase === 'PREPARE' && pendingEvidence === undefined,
        'only a new prepare can report a definitive failure');
      return Object.freeze({
        kind: 'PREPARE_FAILED' as const,
        domainId: this.domain.domainId,
        evidenceHash,
        atValue: result.atValue,
      });
    }
    return Object.freeze({
      kind: expectedKind,
      domainId: this.domain.domainId,
      evidenceHash,
      finality: result.status,
      atValue: result.atValue,
    });
  }

  #validateInput(input: CrossDomainDriverAdvanceInput): void {
    requireCondition(input.plan.environment === 'testnet' && input.plan.timeUnit === 'EVM_UNIX_SECONDS',
      'plan environment or clock is unsupported');
    requireCondition(input.planHash === toHex(crossDomainPlanHash(input.plan)), 'plan hash is invalid');
    requireCondition(input.action.domainId === this.domain.domainId, 'coordination action names another domain');
    requireCondition(sameDomain(input.planLeg.domain, this.domain)
      && sameDomain(input.execution.domain, this.domain)
      && sameDomain(input.compensation.domain, this.domain),
    'plan, execution, or compensation domain differs from the lane');
    requireCondition(input.execution.routeSettlementClass === 'CROSS_DOMAIN_PREPOSITIONED',
      'prepared execution is not cross-domain prepositioned');
    if (input.execution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT') {
      requireCondition(BigInt(input.execution.envelope.ownerTypedData.domain.chainId) === this.#lane.chainReference,
        'prepared account execution names another chain');
    } else if (input.execution.kind === 'EVM_ASYNC_EXECUTOR') {
      requireCondition(sameDomain(input.execution.plan.domain, this.domain),
        'prepared asynchronous plan names another domain');
    }
    const actualLegIds = [...executionLegIds(input.execution)].sort();
    const plannedLegIds = [...input.planLeg.legIds].sort();
    requireCondition(actualLegIds.length > 0 && actualLegIds.length === plannedLegIds.length
      && actualLegIds.every((legId, index) => legId === plannedLegIds[index]),
    'prepared execution legs differ from the plan');
    requireCondition(input.compensation.executorClassId === this.#executorClassId
      && input.compensation.executorClassVersion === this.#executorClassVersion
      && bytesEqual(input.compensation.executorClassManifestHash, this.#executorClassManifestHash),
    'compensation executor class differs from the reviewed lane');
    requireCondition(this.#allowedActionKinds.has(input.compensation.actionKind),
      'compensation action kind is unsupported by the lane');
    requireCondition(input.compensation.environment === input.plan.environment
      && bytesEqual(input.compensation.orderHash, commitmentHash(input.plan.orderHash))
      && bytesEqual(input.compensation.quoteHash, commitmentHash(input.plan.quoteHash))
      && bytesEqual(input.compensation.routeHash, commitmentHash(input.plan.routeHash))
      && input.compensation.expiryUnit === input.plan.timeUnit
      && input.compensation.expiryValue === input.plan.compensationDeadline,
    'compensation action differs from the plan');
  }
}

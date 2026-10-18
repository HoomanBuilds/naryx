import {
  encodeEvmMultiStrategyAccountRecovery, evmMultiStrategyCallsHash, evmMultiStrategyExecutionHash,
  isCanonicalEvmSignature, type EvmMultiStrategyAccountEnvelope,
} from '@naryx/adapter-evm';
import { encodeFunctionData, getAddress, keccak256, parseAbi, recoverTypedDataAddress, type Hex } from 'viem';
import { commitmentHash, crossDomainCompensationAction } from '@naryx/protocol-types';
import {
  EvmFirmReservationCrossDomainLane, type EvmCrossDomainAuthorizationProvider,
  type EvmFirmReservationCrossDomainLaneConfig,
} from './evm-firm-reservation-cross-domain-lane.js';
import type { EvmRecoverableCrossDomainPort, EvmCrossDomainSubmissionObservation } from './evm-cross-domain-recovery-port.js';
import type { EvmCrossDomainExecutionLane, EvmCrossDomainLaneInput, EvmCrossDomainFinalityInput, EvmCrossDomainPhaseResult } from './evm-cross-domain-execution-driver.js';
import { validateEvmFullReversal, validateEvmRecoveryAdapterState, type EvmFullReversal, type EvmRecoveryAdapterPolicy } from './evm-full-reversal-policy.js';

const ZERO = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RELEASE_ABI = parseAbi(['function releaseExpired(bytes32 reservationId)']);
const PENDING = Object.freeze({ status: 'PENDING' as const });

export interface EvmCrossDomainRecoveryAuthorization {
  readonly envelope: EvmMultiStrategyAccountEnvelope;
  readonly ownerSignature: Hex;
}

type ValidatedRecovery = EvmCrossDomainRecoveryAuthorization & { readonly data: Hex; readonly callsHash: Hex; readonly reversal: EvmFullReversal };
export interface EvmRecoverableCrossDomainLaneConfig extends EvmFirmReservationCrossDomainLaneConfig {
  readonly recoveryAdapters: readonly EvmRecoveryAdapterPolicy[];
}

export interface EvmCrossDomainRecoveryAuthorizations extends EvmCrossDomainAuthorizationProvider {
  resolveRecovery(planHash: string, domainId: string): Promise<EvmCrossDomainRecoveryAuthorization | undefined>;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Recoverable EVM lane refused: ${message}`);
}

function hex(value: Uint8Array | string): Hex {
  const valueHex = typeof value === 'string' ? value.replace(/^0x/, '') : Buffer.from(value).toString('hex');
  requireCondition(/^[0-9a-fA-F]{64}$/.test(valueHex), 'invalid commitment');
  return `0x${valueHex.toLowerCase()}`;
}

export class EvmRecoverableCrossDomainLane implements EvmCrossDomainExecutionLane {
  readonly environment = 'testnet' as const;
  readonly supportsCommitRecovery = true as const;
  readonly domain;
  readonly chainReference;
  readonly #entry: EvmFirmReservationCrossDomainLane;
  readonly config: EvmRecoverableCrossDomainLaneConfig;
  readonly port: EvmRecoverableCrossDomainPort;
  readonly authorizations: EvmCrossDomainRecoveryAuthorizations;

  constructor(
    config: EvmRecoverableCrossDomainLaneConfig,
    port: EvmRecoverableCrossDomainPort,
    authorizations: EvmCrossDomainRecoveryAuthorizations,
  ) {
    this.config = Object.freeze({ ...config, recoveryAdapters: Object.freeze(config.recoveryAdapters.map(p => Object.freeze({ ...p }))) });
    this.port = port;
    this.authorizations = authorizations;
    this.domain = config.domain;
    this.chainReference = config.chainReference;
    this.#entry = new EvmFirmReservationCrossDomainLane(config, port, authorizations);
  }

  chainId() { return this.port.chainId(); }
  currentTime() { return this.port.currentTime(); }

  async start(input: EvmCrossDomainLaneInput): Promise<EvmCrossDomainPhaseResult> {
    const recovery = await this.#recovery(input);
    if (recovery === undefined) return PENDING;
    if (input.phase === 'COMPENSATE') return this.#compensate(input, recovery);
    if (input.phase === 'COMMIT') {
      const known = await this.reconcileCommit(input);
      if (known.status !== 'PENDING') return known;
    }
    return this.#entry.start(this.#entryInput(input));
  }

  async awaitFinality(input: EvmCrossDomainFinalityInput): Promise<EvmCrossDomainPhaseResult> {
    if (input.phase === 'COMMIT') return this.reconcileCommit(input);
    const recovery = await this.#recovery(input);
    if (recovery === undefined) return PENDING;
    if (input.phase === 'PREPARE') return this.#entry.awaitFinality({ ...this.#entryInput(input), evidenceHash: input.evidenceHash });
    return this.#compensate(input, recovery, false);
  }

  async reconcileCommit(input: EvmCrossDomainLaneInput): Promise<EvmCrossDomainPhaseResult> {
    if (await this.#recovery(input) === undefined) return PENDING;
    const entry = this.#execution(input);
    const known = await this.port.observeSubmission(`${input.planHash}:COMMIT`, entry.account);
    const atValue = await this.port.finalizedTime();
    const evidenceHash = entry.execution.packageId;
    if (known.status === 'PENDING') return PENDING;
    if (known.status === 'SUCCESS') {
      const authorization = await this.authorizations.resolve(input.planHash, this.domain.domainId);
      requireCondition(authorization !== undefined && known.data === authorization.data, 'finalized entry payload differs');
      this.#receiptMatches(known, entry);
      return { status: 'FINALIZED', evidenceHash, atValue };
    }
    if (known.status === 'ABSENT' && atValue <= input.plan.commitDeadline) return PENDING;
    const state = await this.port.packageState(entry.account, entry.execution.packageId);
    requireCondition(!state.active && state.stateHash === ZERO
      && await this.port.accountNextNonce(entry.account) === entry.execution.nonce,
    'failed entry has unexplained account effects');
    return { status: 'DEFINITIVE_COMMIT_FAILURE', evidenceHash, atValue };
  }

  async settleUnusedReservation(input: EvmCrossDomainLaneInput): Promise<boolean> {
    const entry = this.#execution(input);
    requireCondition(await this.port.chainId() === this.chainReference
      && await this.port.codeHash(this.config.reservationBook) === this.config.reservationBookCodeHash, 'reservation deployment changed');
    const id = hex(input.planLeg.inventoryReservationId);
    const reservation = await this.port.reservation(this.config.reservationBook, id);
    if (reservation.state === 'NONE') return true;
    const original = entry.execution;
    requireCondition(reservation.domainIdHash === original.domainIdHash
      && reservation.domainManifestVersion === original.domainManifestVersion
      && reservation.domainManifestHash === original.domainManifestHash
      && getAddress(reservation.solver) === getAddress(original.solver)
      && getAddress(reservation.strategyAccount) === getAddress(entry.account)
      && reservation.packageNonce === original.nonce && reservation.orderHash === original.orderHash
      && ((reservation.quoteHash === original.quoteHash && reservation.routeHash === original.routeHash)
        || (reservation.quoteHash === ZERO && reservation.routeHash === ZERO)), 'reservation differs from terminal job');
    if (reservation.state === 'CONSUMED' || reservation.state === 'RELEASED') return true;
    if (await this.port.finalizedTime() <= reservation.expiry) return false;
    await this.port.submit({ operationId: `${input.planHash}:RELEASE`, to: this.config.reservationBook,
      data: encodeFunctionData({ abi: RELEASE_ABI, functionName: 'releaseExpired', args: [id] }),
      gas: this.config.compensationGasLimit, maximumFeePerGasWei: this.config.maximumFeePerGasWei });
    return false;
  }

  #execution(input: EvmCrossDomainLaneInput) {
    requireCondition(input.plan.planVersion === 2 && input.compensation.actionKind === 'REVERSE_FILLED_LEGS',
      'only version-two filled-position recovery is supported');
    requireCondition(input.execution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'execution must use a multi-strategy account');
    const entry = input.execution.envelope;
    requireCondition(entry.execution.operation === 1 && entry.execution.previousStateHash === ZERO
      && entry.execution.nextStateHash !== ZERO && entry.execution.deadline <= input.plan.commitDeadline,
    'entry identity or deadline is invalid');
    return entry;
  }

  #entryInput(input: EvmCrossDomainLaneInput): EvmCrossDomainLaneInput {
    const data = encodeFunctionData({ abi: RELEASE_ABI, functionName: 'releaseExpired', args: [hex(input.planLeg.inventoryReservationId)] });
    return { ...input, compensation: crossDomainCompensationAction({ ...input.compensation,
      actionKind: 'RELEASE_RESERVED_INVENTORY', actionPayloadHash: keccak256(data) }) };
  }

  async #recovery(input: EvmCrossDomainLaneInput): Promise<ValidatedRecovery | undefined> {
    const entry = this.#execution(input);
    requireCondition(await this.port.chainId() === this.chainReference, 'chain identity changed');
    requireCondition(await this.port.codeHash(entry.account) === this.config.strategyAccountCodeHash
      && await this.port.codeHash(this.config.reservationBook) === this.config.reservationBookCodeHash,
    'account or reservation code changed');
    const recovery = await this.authorizations.resolveRecovery(input.planHash, this.domain.domainId);
    const authorization = await this.authorizations.resolve(input.planHash, this.domain.domainId);
    if (recovery === undefined || authorization === undefined) return undefined;
    const execution = recovery.envelope.execution;
    const original = entry.execution;
    requireCondition(getAddress(recovery.envelope.account) === getAddress(entry.account)
      && execution.domainIdHash === original.domainIdHash
      && execution.domainManifestVersion === original.domainManifestVersion
      && execution.domainManifestHash === original.domainManifestHash
      && execution.packageId === original.packageId && execution.previousStateHash === original.nextStateHash
      && execution.nextStateHash === ZERO && (execution.operation === 7 || execution.operation === 8)
      && execution.nonce === original.nonce + 1n && execution.deadline >= input.plan.compensationDeadline
      && execution.solver === ZERO_ADDRESS && execution.fees.protocolFeeAtoms === 0n && execution.fees.solverFeeAtoms === 0n
      && execution.fees.policyVersion === 0 && execution.fees.policyManifestHash === ZERO && execution.fees.token === ZERO_ADDRESS
      && execution.template.templateId === original.template.templateId
      && execution.template.templateVersion === original.template.templateVersion
      && execution.template.templateManifestHash === original.template.templateManifestHash
      && execution.risk.accountingToken === original.risk.accountingToken
      && execution.risk.riskDomainId === original.risk.riskDomainId
      && execution.risk.policyVersion === original.risk.policyVersion
      && execution.risk.policyManifestHash === original.risk.policyManifestHash
      && execution.risk.series.seriesId === original.risk.series.seriesId
      && execution.risk.series.manifestVersion === original.risk.series.manifestVersion
      && execution.risk.series.manifestHash === original.risk.series.manifestHash,
    'recovery is not a fee-free exact close of this entry');
    requireCondition(recovery.envelope.calls.length > 0 && recovery.envelope.calls.every(call => !call.riskIncreasing)
      && isCanonicalEvmSignature(recovery.ownerSignature), 'recovery calls or signature are invalid');
    const executionHash = evmMultiStrategyExecutionHash(execution);
    const callsHash = evmMultiStrategyCallsHash(recovery.envelope.calls);
    const owner = await recoverTypedDataAddress({
      domain: { name: 'Naryx Multi Strategy Account', version: '1', chainId: Number(this.chainReference), verifyingContract: entry.account },
      types: { OwnerExecution: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
      primaryType: 'OwnerExecution', message: { executionHash, callsHash }, signature: recovery.ownerSignature,
    });
    requireCondition(getAddress(owner) === getAddress(authorization.owner), 'recovery signer is not the entry owner');
    const data = encodeEvmMultiStrategyAccountRecovery(recovery);
    requireCondition(keccak256(data) === hex(input.compensation.actionPayloadHash), 'recovery differs from the signed compensation commitment');
    const reversal = validateEvmFullReversal(entry, recovery.envelope, this.config.recoveryAdapters);
    requireCondition(reversal.maximumLossQuoteAtoms <= this.config.maximumCompensationCostQuoteAtoms
      && reversal.maximumLossQuoteAtoms <= input.compensation.maximumCostQuoteAtoms,
      'recovery cost exceeds the signed cap');
    for (const policy of reversal.adapters) {
      validateEvmRecoveryAdapterState(policy, await this.port.recoveryAdapterState(policy), entry);
    }
    return { ...recovery, data, callsHash, reversal };
  }

  #receiptMatches(observation: Extract<EvmCrossDomainSubmissionObservation, { status: 'SUCCESS' }>, envelope: EvmMultiStrategyAccountEnvelope) {
    const receipt = observation.receipt;
    const execution = envelope.execution;
    requireCondition(getAddress(observation.to) === getAddress(envelope.account)
      && receipt.packageId === execution.packageId && receipt.orderHash === execution.orderHash
      && receipt.quoteHash === execution.quoteHash && receipt.routeHash === execution.routeHash
      && receipt.operation === execution.operation && receipt.previousStateHash === execution.previousStateHash
      && receipt.nextStateHash === execution.nextStateHash && receipt.nonce === execution.nonce
      && getAddress(receipt.solver) === getAddress(execution.solver)
      && receipt.callsHash === evmMultiStrategyCallsHash(envelope.calls), 'finalized receipt differs from authorized execution');
  }

  async #compensate(input: EvmCrossDomainLaneInput, recovery: ValidatedRecovery, submit = true): Promise<EvmCrossDomainPhaseResult> {
    const entry = this.#execution(input);
    const committed = await this.reconcileCommit(input);
    if (committed.status === 'PENDING') return PENDING;
    if (committed.status === 'DEFINITIVE_COMMIT_FAILURE') {
      return submit ? this.#entry.start(this.#entryInput(input))
        : this.#entry.awaitFinality({ ...this.#entryInput(input), evidenceHash: commitmentHash(input.planLeg.inventoryReservationId) });
    }
    const known = await this.port.observeSubmission(`${input.planHash}:COMPENSATE`, entry.account);
    const atValue = await this.port.finalizedTime();
    const evidenceHash = hex(input.planLeg.inventoryReservationId);
    if (known.status === 'SUCCESS') {
      requireCondition(known.data === recovery.data, 'finalized recovery payload differs');
      this.#receiptMatches(known, recovery.envelope);
      const state = await this.port.packageState(entry.account, entry.execution.packageId);
      requireCondition(!state.active && state.stateHash === ZERO
        && await this.port.accountNextNonce(entry.account) === recovery.envelope.execution.nonce + 1n,
      'recovery did not close the exact account position');
      const entryEvidence = await this.port.observeSubmission(`${input.planHash}:COMMIT`, entry.account);
      requireCondition(entryEvidence.status === 'SUCCESS', 'entry evidence disappeared during recovery reconciliation');
      for (const [token, quantity] of recovery.reversal.spotBaseDeltas) {
        requireCondition(entryEvidence.tokenDeltas.get(token) === quantity && known.tokenDeltas.get(token) === -quantity,
          'finalized token transfers do not reverse the full spot quantity');
      }
      const quoteToken = getAddress(entry.execution.risk.accountingToken);
      requireCondition(entryEvidence.tokenDeltas.has(quoteToken) && known.tokenDeltas.has(quoteToken), 'missing finalized accounting token flows');
      const netQuote = entryEvidence.tokenDeltas.get(quoteToken)! + known.tokenDeltas.get(quoteToken)!;
      requireCondition(netQuote >= -recovery.reversal.maximumLossQuoteAtoms, 'realized recovery loss exceeds enforced bounds');
      for (const policy of recovery.reversal.adapters) {
        validateEvmRecoveryAdapterState(policy, await this.port.recoveryAdapterState(policy), entry);
      }
      if (!await this.settleUnusedReservation(input)) return PENDING;
      return { status: 'FINALIZED', evidenceHash, atValue };
    }
    requireCondition(known.status !== 'REVERTED', 'owner-authorized recovery reverted; account remains fenced');
    if (known.status === 'PENDING') return PENDING;
    if (!submit) return PENDING;
    requireCondition(await this.port.currentTime() <= input.plan.compensationDeadline, 'compensation deadline passed');
    await this.port.submit({ operationId: `${input.planHash}:COMPENSATE`, to: entry.account, data: recovery.data,
      gas: this.config.compensationGasLimit, maximumFeePerGasWei: this.config.maximumFeePerGasWei });
    return { status: 'OBSERVED', evidenceHash, atValue: await this.port.currentTime() };
  }

}

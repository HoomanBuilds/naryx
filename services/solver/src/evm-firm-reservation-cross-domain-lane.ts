import {
  encodeEvmMultiStrategyAccountExecution,
  isCanonicalEvmSignature,
} from '@naryx/adapter-evm';
import type { DomainRef } from '@naryx/protocol-types';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import type { AuthorizedEvmStrategyExecution } from './evm-strategy-execution-authorization.js';
import type { PreparedStrategyDomainTransport } from './strategy-execution-transport.js';
import type {
  EvmCrossDomainExecutionLane,
  EvmCrossDomainFinalityInput,
  EvmCrossDomainLaneInput,
  EvmCrossDomainPhaseResult,
} from './evm-cross-domain-execution-driver.js';

const RESERVATION_BOOK_ABI = parseAbi([
  'function releaseExpired(bytes32 reservationId)',
]);
type EvmAtomicPreparedExecution = Extract<PreparedStrategyDomainTransport, Readonly<{
  kind: 'EVM_MULTI_STRATEGY_ACCOUNT';
}>>;

export type EvmFirmReservationState = 'NONE' | 'FUNDED' | 'LIVE' | 'CONSUMED' | 'RELEASED';

export interface EvmFirmReservationRecord {
  readonly domainIdHash: Hex;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Hex;
  readonly solver: Address;
  readonly strategyAccount: Address;
  readonly packageNonce: bigint;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly expiry: bigint;
  readonly state: EvmFirmReservationState;
}

export interface EvmAtomicPackageState {
  readonly stateHash: Hex;
  readonly lastReceiptHash: Hex;
  readonly active: boolean;
}

export interface EvmAtomicPackageReceipt {
  readonly packageId: Hex;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly nextStateHash: Hex;
  readonly nonce: bigint;
  readonly solver: Address;
}

export interface EvmFirmReservationCrossDomainPort {
  chainId(): Promise<bigint>;
  currentTime(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | null>;
  reservation(book: Address, reservationId: Hex): Promise<EvmFirmReservationRecord>;
  liveReservationId(book: Address, solver: Address, strategyAccount: Address): Promise<Hex>;
  accountNextNonce(account: Address): Promise<bigint>;
  packageState(account: Address, packageId: Hex): Promise<EvmAtomicPackageState>;
  packageReceipt(account: Address, receiptHash: Hex): Promise<EvmAtomicPackageReceipt>;
  submit(input: Readonly<{
    to: Address;
    data: Hex;
    gas: bigint;
    maximumFeePerGasWei: bigint;
  }>): Promise<Hex>;
}

export interface EvmCrossDomainAuthorizationProvider {
  resolve(planHash: string, domainId: string): Promise<AuthorizedEvmStrategyExecution | undefined>;
}

export interface EvmFirmReservationCrossDomainLaneConfig {
  readonly domain: DomainRef;
  readonly chainReference: bigint;
  readonly reservationBook: Address;
  readonly reservationBookCodeHash: Hex;
  readonly strategyAccountCodeHash: Hex;
  readonly commitGasLimit: bigint;
  readonly compensationGasLimit: bigint;
  readonly maximumFeePerGasWei: bigint;
  readonly maximumCompensationCostQuoteAtoms: bigint;
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM firm reservation lane refused: ${message}`);
}

function hex(value: Uint8Array | string, context: string): Hex {
  const encoded = typeof value === 'string' ? value : Buffer.from(value).toString('hex');
  const result = encoded.startsWith('0x') || encoded.startsWith('0X') ? encoded : `0x${encoded}`;
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(result), `${context} is not bytes32`);
  return result.toLowerCase() as Hex;
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function releaseCalldata(reservationId: Hex): Hex {
  return encodeFunctionData({
    abi: RESERVATION_BOOK_ABI,
    functionName: 'releaseExpired',
    args: [reservationId],
  });
}

export class EvmFirmReservationCrossDomainLane implements EvmCrossDomainExecutionLane {
  readonly environment = 'testnet' as const;
  readonly domain: DomainRef;
  readonly chainReference: bigint;
  readonly #config: EvmFirmReservationCrossDomainLaneConfig;
  readonly #port: EvmFirmReservationCrossDomainPort;
  readonly #authorizations: EvmCrossDomainAuthorizationProvider;

  constructor(
    config: EvmFirmReservationCrossDomainLaneConfig,
    port: EvmFirmReservationCrossDomainPort,
    authorizations: EvmCrossDomainAuthorizationProvider,
  ) {
    requireCondition(config.domain.domainId === `eip155:${config.chainReference}`,
      'domain and chain reference differ');
    requireCondition(config.chainReference === 84_532n || config.chainReference === 421_614n,
      'only Base Sepolia and Arbitrum Sepolia are allowed');
    requireCondition(config.commitGasLimit > 0n && config.compensationGasLimit > 0n
      && config.maximumFeePerGasWei > 0n && config.maximumCompensationCostQuoteAtoms >= 0n,
    'gas or compensation limits are invalid');
    requireCondition(config.reservationBookCodeHash !== ZERO_HASH
      && config.strategyAccountCodeHash !== ZERO_HASH, 'expected code hashes are zero');
    this.domain = config.domain;
    this.chainReference = config.chainReference;
    this.#config = Object.freeze({ ...config });
    this.#port = port;
    this.#authorizations = authorizations;
  }

  chainId(): Promise<bigint> { return this.#port.chainId(); }
  currentTime(): Promise<bigint> { return this.#port.currentTime(); }

  async start(input: Readonly<EvmCrossDomainLaneInput>): Promise<EvmCrossDomainPhaseResult> {
    if (input.phase === 'PREPARE') return this.#prepare(input);
    if (input.phase === 'COMMIT') return this.#commit(input);
    return this.#compensate(input);
  }

  async awaitFinality(input: Readonly<EvmCrossDomainFinalityInput>): Promise<EvmCrossDomainPhaseResult> {
    if (input.phase === 'PREPARE') return this.#prepare(input);
    if (input.phase === 'COMMIT') return this.#committed(input, input.evidenceHash);
    return this.#compensated(input, input.evidenceHash);
  }

  async #prepare(input: EvmCrossDomainLaneInput): Promise<EvmCrossDomainPhaseResult> {
    const execution = this.#atomicExecution(input);
    const reservationId = hex(input.planLeg.inventoryReservationId, 'reservation ID');
    const now = await this.#port.currentTime();
    await this.#verifyCode(execution.envelope.account);
    const authorization = await this.#authorization(input, execution);
    if (authorization === undefined) return Object.freeze({ status: 'PENDING' as const });
    const reservation = await this.#port.reservation(this.#config.reservationBook, reservationId);
    const valid = this.#reservationMatches(input, execution, reservation)
      && reservation.state === 'LIVE'
      && reservation.expiry > now
      && sameHash(
        await this.#port.liveReservationId(
          this.#config.reservationBook,
          reservation.solver,
          reservation.strategyAccount,
        ),
        reservationId,
      )
      && await this.#port.accountNextNonce(execution.envelope.account) === execution.envelope.execution.nonce;
    if (!valid) {
      return Object.freeze({
        status: 'DEFINITIVE_PREPARE_FAILURE' as const,
        evidenceHash: reservationId,
        atValue: now,
      });
    }
    return Object.freeze({ status: 'FINALIZED' as const, evidenceHash: reservationId, atValue: now });
  }

  async #commit(input: EvmCrossDomainLaneInput): Promise<EvmCrossDomainPhaseResult> {
    const execution = this.#atomicExecution(input);
    const packageId = execution.envelope.execution.packageId;
    const already = await this.#committed(input, packageId);
    if (already.status === 'FINALIZED') return already;
    const authorization = await this.#authorization(input, execution);
    if (authorization === undefined) return Object.freeze({ status: 'PENDING' as const });
    const now = await this.#port.currentTime();
    requireCondition(now < authorization.deadline && now <= input.plan.commitDeadline,
      'execution authorization expired');
    requireCondition(await this.#port.accountNextNonce(execution.envelope.account) === execution.envelope.execution.nonce,
      'strategy account nonce changed before commit');
    const reservation = await this.#port.reservation(
      this.#config.reservationBook,
      hex(input.planLeg.inventoryReservationId, 'reservation ID'),
    );
    requireCondition(reservation.state === 'LIVE' && reservation.expiry > now
      && this.#reservationMatches(input, execution, reservation), 'firm reservation is no longer executable');
    await this.#port.submit({
      to: authorization.to,
      data: authorization.data,
      gas: this.#config.commitGasLimit,
      maximumFeePerGasWei: this.#config.maximumFeePerGasWei,
    });
    return Object.freeze({ status: 'OBSERVED' as const, evidenceHash: packageId, atValue: now });
  }

  async #committed(
    input: EvmCrossDomainLaneInput,
    evidenceHash: Uint8Array | string,
  ): Promise<EvmCrossDomainPhaseResult> {
    const execution = this.#atomicExecution(input);
    await this.#verifyCode(execution.envelope.account);
    const packageId = execution.envelope.execution.packageId;
    requireCondition(sameHash(hex(evidenceHash, 'commit evidence hash'), packageId),
      'commit evidence is not the package ID');
    const now = await this.#port.currentTime();
    const state = await this.#port.packageState(execution.envelope.account, packageId);
    if (!state.active) return Object.freeze({ status: 'PENDING' as const });
    requireCondition(sameHash(state.stateHash, execution.envelope.execution.nextStateHash)
      && state.lastReceiptHash !== ZERO_HASH, 'active package state differs from the prepared execution');
    const receipt = await this.#port.packageReceipt(execution.envelope.account, state.lastReceiptHash);
    requireCondition(sameHash(receipt.packageId, packageId)
      && sameHash(receipt.orderHash, execution.envelope.execution.orderHash)
      && sameHash(receipt.quoteHash, execution.envelope.execution.quoteHash)
      && sameHash(receipt.routeHash, execution.envelope.execution.routeHash)
      && sameHash(receipt.nextStateHash, execution.envelope.execution.nextStateHash)
      && receipt.nonce === execution.envelope.execution.nonce
      && getAddress(receipt.solver) === getAddress(execution.envelope.execution.solver),
    'finalized package receipt differs from the prepared execution');
    return Object.freeze({ status: 'FINALIZED' as const, evidenceHash: packageId, atValue: now });
  }

  async #compensate(input: EvmCrossDomainLaneInput): Promise<EvmCrossDomainPhaseResult> {
    const execution = this.#atomicExecution(input);
    const reservationId = hex(input.planLeg.inventoryReservationId, 'reservation ID');
    const settled = await this.#compensated(input, reservationId);
    if (settled.status === 'FINALIZED') return settled;
    const now = await this.#port.currentTime();
    const reservation = await this.#port.reservation(this.#config.reservationBook, reservationId);
    requireCondition(reservation.state === 'FUNDED' || reservation.state === 'LIVE',
      'reservation cannot be released from its current state');
    requireCondition(this.#releasableReservationMatches(input, execution, reservation),
      'reservation differs from the prepared package');
    if (now < reservation.expiry) return Object.freeze({ status: 'PENDING' as const });
    const data = releaseCalldata(reservationId);
    requireCondition(sameHash(keccak256(data), hex(input.compensation.actionPayloadHash, 'compensation payload hash')),
      'compensation payload commitment differs from releaseExpired');
    requireCondition(this.#config.maximumCompensationCostQuoteAtoms <= input.compensation.maximumCostQuoteAtoms,
      'reviewed compensation cost exceeds the signed cap');
    await this.#port.submit({
      to: this.#config.reservationBook,
      data,
      gas: this.#config.compensationGasLimit,
      maximumFeePerGasWei: this.#config.maximumFeePerGasWei,
    });
    return Object.freeze({ status: 'OBSERVED' as const, evidenceHash: reservationId, atValue: now });
  }

  async #compensated(
    input: EvmCrossDomainLaneInput,
    evidenceHash: Uint8Array | string,
  ): Promise<EvmCrossDomainPhaseResult> {
    const execution = this.#atomicExecution(input);
    await this.#verifyReservationBookCode();
    const data = releaseCalldata(hex(input.planLeg.inventoryReservationId, 'reservation ID'));
    requireCondition(sameHash(keccak256(data), hex(input.compensation.actionPayloadHash, 'compensation payload hash')),
      'compensation payload commitment differs from releaseExpired');
    requireCondition(this.#config.maximumCompensationCostQuoteAtoms <= input.compensation.maximumCostQuoteAtoms,
      'reviewed compensation cost exceeds the signed cap');
    const reservationId = hex(input.planLeg.inventoryReservationId, 'reservation ID');
    requireCondition(sameHash(hex(evidenceHash, 'compensation evidence hash'), reservationId),
      'compensation evidence is not the reservation ID');
    const now = await this.#port.currentTime();
    const reservation = await this.#port.reservation(this.#config.reservationBook, reservationId);
    requireCondition(this.#releasableReservationMatches(input, execution, reservation),
      'reservation differs from the prepared package');
    if (reservation.state !== 'RELEASED') return Object.freeze({ status: 'PENDING' as const });
    return Object.freeze({ status: 'FINALIZED' as const, evidenceHash: reservationId, atValue: now });
  }

  #atomicExecution(input: EvmCrossDomainLaneInput): EvmAtomicPreparedExecution {
    requireCondition(input.execution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT',
      'lane requires an EVM multi-strategy account execution');
    requireCondition(input.execution.envelope.execution.operation === 1
      && input.execution.envelope.execution.previousStateHash === ZERO_HASH
      && input.execution.envelope.execution.nextStateHash !== ZERO_HASH,
    'firm cross-domain lane only supports package entry');
    return input.execution;
  }

  async #verifyReservationBookCode(): Promise<void> {
    const bookCodeHash = await this.#port.codeHash(this.#config.reservationBook);
    requireCondition(bookCodeHash !== null && sameHash(bookCodeHash, this.#config.reservationBookCodeHash),
      'reservation book code identity changed');
  }

  async #verifyCode(strategyAccount: Address): Promise<void> {
    const [bookCodeHash, accountCodeHash] = await Promise.all([
      this.#port.codeHash(this.#config.reservationBook),
      this.#port.codeHash(strategyAccount),
    ]);
    requireCondition(bookCodeHash !== null && sameHash(bookCodeHash, this.#config.reservationBookCodeHash),
      'reservation book code identity changed');
    requireCondition(accountCodeHash !== null && sameHash(accountCodeHash, this.#config.strategyAccountCodeHash),
      'strategy account code identity changed');
  }

  async #authorization(input: EvmCrossDomainLaneInput, execution: EvmAtomicPreparedExecution) {
    const authorization = await this.#authorizations.resolve(input.planHash, this.domain.domainId);
    if (authorization === undefined) return undefined;
    const envelope = execution.envelope;
    requireCondition(authorization.version === 1 && authorization.chainId === Number(this.chainReference)
      && authorization.domain.domainId === this.domain.domainId
      && authorization.domain.domainManifestVersion === this.domain.domainManifestVersion
      && sameHash(
        hex(authorization.domain.domainManifestHash, 'authorization domain manifest hash'),
        hex(this.domain.domainManifestHash, 'lane domain manifest hash'),
      )
      && getAddress(authorization.to) === getAddress(envelope.account)
      && authorization.value === 0n
      && sameHash(authorization.packageId, envelope.execution.packageId)
      && sameHash(authorization.orderHash, envelope.execution.orderHash)
      && sameHash(authorization.quoteHash, envelope.execution.quoteHash)
      && sameHash(authorization.routeHash, envelope.execution.routeHash)
      && sameHash(authorization.expectedNextStateHash, envelope.execution.nextStateHash)
      && authorization.deadline === envelope.execution.deadline,
    'authorization differs from the prepared execution');
    requireCondition(isCanonicalEvmSignature(authorization.ownerSignature)
      && isCanonicalEvmSignature(authorization.solverSignature), 'authorization signatures are not canonical');
    const [owner, solver] = await Promise.all([
      recoverTypedDataAddress({ ...envelope.ownerTypedData, signature: authorization.ownerSignature }),
      recoverTypedDataAddress({ ...envelope.solverTypedData, signature: authorization.solverSignature }),
    ]);
    requireCondition(getAddress(owner) === getAddress(authorization.owner)
      && getAddress(solver) === getAddress(envelope.execution.solver), 'authorization signatures recover to other accounts');
    const expectedData = encodeEvmMultiStrategyAccountExecution({
      envelope,
      ownerSignature: authorization.ownerSignature,
      solverSignature: authorization.solverSignature,
    });
    requireCondition(expectedData === authorization.data, 'authorization calldata differs from the prepared execution');
    return authorization;
  }

  #reservationMatches(
    input: EvmCrossDomainLaneInput,
    execution: EvmAtomicPreparedExecution,
    reservation: EvmFirmReservationRecord,
  ): boolean {
    return this.#reservationIdentityMatches(input, execution, reservation)
      && sameHash(reservation.quoteHash, hex(input.plan.quoteHash, 'plan quote hash'))
      && sameHash(reservation.routeHash, hex(input.plan.routeHash, 'plan route hash'));
  }

  #releasableReservationMatches(
    input: EvmCrossDomainLaneInput,
    execution: EvmAtomicPreparedExecution,
    reservation: EvmFirmReservationRecord,
  ): boolean {
    const unfinalized = reservation.quoteHash === ZERO_HASH && reservation.routeHash === ZERO_HASH;
    return this.#reservationIdentityMatches(input, execution, reservation)
      && (unfinalized || (
        sameHash(reservation.quoteHash, hex(input.plan.quoteHash, 'plan quote hash'))
        && sameHash(reservation.routeHash, hex(input.plan.routeHash, 'plan route hash'))
      ));
  }

  #reservationIdentityMatches(
    input: EvmCrossDomainLaneInput,
    execution: EvmAtomicPreparedExecution,
    reservation: EvmFirmReservationRecord,
  ): boolean {
    const envelope = execution.envelope;
    return sameHash(reservation.domainIdHash, envelope.execution.domainIdHash)
      && reservation.domainManifestVersion === this.domain.domainManifestVersion
      && sameHash(reservation.domainManifestHash, hex(this.domain.domainManifestHash, 'domain manifest hash'))
      && getAddress(reservation.solver) === getAddress(envelope.execution.solver)
      && getAddress(reservation.strategyAccount) === getAddress(envelope.account)
      && reservation.packageNonce === envelope.execution.nonce
      && sameHash(reservation.orderHash, hex(input.plan.orderHash, 'plan order hash'))
      && reservation.baseAtoms > 0n
      && reservation.quoteAtoms > 0n;
  }
}

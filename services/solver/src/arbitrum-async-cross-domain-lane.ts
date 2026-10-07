import {
  bytesEqual,
  commitmentHash,
  domainRef,
  type DomainRef,
} from '@naryx/protocol-types';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  ARBITRUM_ASYNC_COORDINATOR_ABI,
  ARBITRUM_GMX_ADAPTER_ABI,
  type ArbitrumSepoliaExecutionBinding,
  type ArbitrumSepoliaExecutionResult,
} from './arbitrum-sepolia-executor.js';
import type {
  EvmCrossDomainExecutionLane,
  EvmCrossDomainFinalityInput,
  EvmCrossDomainLaneInput,
  EvmCrossDomainPhaseResult,
} from './evm-cross-domain-execution-driver.js';

const ARBITRUM_SEPOLIA_CHAIN_REFERENCE = 421_614n;
const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const CANCELLATION_PAYLOAD_DOMAIN = keccak256(stringToHex('NARYX_ARBITRUM_ASYNC_CANCELLATION_V1'));

export interface ArbitrumAsyncCrossDomainAttemptProvider {
  resolve(planHash: string, domainId: string): Promise<string | undefined>;
}

export interface ArbitrumAsyncCrossDomainExecutor {
  binding(attemptId: string): Promise<ArbitrumSepoliaExecutionBinding>;
  reserve(attemptId: string): Promise<ArbitrumSepoliaExecutionResult>;
  advance(attemptId: string): Promise<ArbitrumSepoliaExecutionResult>;
  observe(attemptId: string, blockTag: 'latest' | 'finalized'): Promise<ArbitrumSepoliaExecutionResult>;
  cancelReserved(attemptId: string): Promise<ArbitrumSepoliaExecutionResult>;
}

export interface ArbitrumAsyncCrossDomainClock {
  chainId(): Promise<bigint>;
  currentTime(): Promise<bigint>;
}

export interface ArbitrumAsyncCrossDomainLaneConfig {
  readonly domain: DomainRef;
  readonly coordinator: Address;
  readonly adapter: Address;
  readonly maximumCompensationCostQuoteAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Arbitrum cross-domain execution refused: ${message}`);
}

function sameHash(left: Uint8Array | string, right: Uint8Array | string): boolean {
  return bytesEqual(commitmentHash(left), commitmentHash(right));
}

export function arbitrumAsyncCancellationPayloadHash(input: Readonly<{
  coordinator: Address;
  adapter: Address;
  packageId: Hex;
  owner: Address;
}>): Hex {
  const coordinator = getAddress(input.coordinator);
  const adapter = getAddress(input.adapter);
  const owner = getAddress(input.owner);
  const cancel = encodeFunctionData({
    abi: ARBITRUM_ASYNC_COORDINATOR_ABI,
    functionName: 'cancelReserved',
    args: [input.packageId, 1n],
  });
  const release = encodeFunctionData({
    abi: ARBITRUM_GMX_ADAPTER_ABI,
    functionName: 'releaseCancelledFunding',
    args: [input.packageId, owner],
  });
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'bytes' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [CANCELLATION_PAYLOAD_DOMAIN, coordinator, cancel, adapter, release],
  ));
}

export class ArbitrumAsyncCrossDomainLane implements EvmCrossDomainExecutionLane {
  readonly environment = 'testnet' as const;
  readonly domain: DomainRef;
  readonly chainReference = ARBITRUM_SEPOLIA_CHAIN_REFERENCE;
  readonly #config: ArbitrumAsyncCrossDomainLaneConfig;
  readonly #attempts: ArbitrumAsyncCrossDomainAttemptProvider;
  readonly #executor: ArbitrumAsyncCrossDomainExecutor;
  readonly #clock: ArbitrumAsyncCrossDomainClock;
  #evidenceTime = 0n;

  constructor(options: Readonly<{
    config: ArbitrumAsyncCrossDomainLaneConfig;
    attempts: ArbitrumAsyncCrossDomainAttemptProvider;
    executor: ArbitrumAsyncCrossDomainExecutor;
    clock: ArbitrumAsyncCrossDomainClock;
  }>) {
    requireCondition(options.config.domain.domainId === 'eip155:421614', 'domain is not Arbitrum Sepolia');
    requireCondition(options.config.maximumCompensationCostQuoteAtoms >= 0n,
      'maximum compensation cost is negative');
    this.domain = domainRef(
      options.config.domain.domainId,
      options.config.domain.domainManifestVersion,
      options.config.domain.domainManifestHash,
      'arbitrumCrossDomain.domain',
    );
    this.#config = Object.freeze({
      ...options.config,
      coordinator: getAddress(options.config.coordinator),
      adapter: getAddress(options.config.adapter),
    });
    this.#attempts = options.attempts;
    this.#executor = options.executor;
    this.#clock = options.clock;
  }

  chainId(): Promise<bigint> {
    return this.#clock.chainId();
  }

  async currentTime(): Promise<bigint> {
    const now = await this.#clock.currentTime();
    requireCondition(now >= 0n, 'chain time is negative');
    this.#evidenceTime = now;
    return now;
  }

  async start(input: Readonly<EvmCrossDomainLaneInput>): Promise<EvmCrossDomainPhaseResult> {
    const attempt = await this.#attempt(input);
    if (attempt === undefined) return Object.freeze({ status: 'PENDING' as const });
    if (input.phase === 'PREPARE') return this.#prepare(attempt.attemptId, attempt.binding);
    if (input.phase === 'COMMIT') return this.#commit(attempt.attemptId, attempt.binding);
    return this.#compensate(input, attempt.attemptId, attempt.binding);
  }

  async awaitFinality(input: Readonly<EvmCrossDomainFinalityInput>): Promise<EvmCrossDomainPhaseResult> {
    const attempt = await this.#attempt(input);
    if (attempt === undefined) return Object.freeze({ status: 'PENDING' as const });
    requireCondition(sameHash(input.evidenceHash, attempt.binding.packageId),
      'pending evidence is not the bonded package ID');
    const result = await this.#executor.observe(attempt.attemptId, 'finalized');
    if (input.phase === 'PREPARE') {
      return result.status === 'RESERVED' ? this.#finalized(attempt.binding.packageId) : Object.freeze({ status: 'PENDING' as const });
    }
    if (input.phase === 'COMMIT') {
      return result.status === 'SETTLED' ? this.#finalized(attempt.binding.packageId) : Object.freeze({ status: 'PENDING' as const });
    }
    return result.status === 'COMPENSATED' ? this.#finalized(attempt.binding.packageId) : Object.freeze({ status: 'PENDING' as const });
  }

  async #attempt(input: EvmCrossDomainLaneInput): Promise<Readonly<{
    attemptId: string;
    binding: ArbitrumSepoliaExecutionBinding;
  }> | undefined> {
    requireCondition(input.execution.kind === 'EVM_ASYNC_EXECUTOR', 'lane requires an asynchronous EVM execution');
    const attemptId = await this.#attempts.resolve(input.planHash, this.domain.domainId);
    if (attemptId === undefined) return undefined;
    requireCondition(ATTEMPT_ID.test(attemptId), 'attempt provider returned an invalid ID');
    const binding = await this.#executor.binding(attemptId);
    requireCondition(binding.attemptId === attemptId
      && sameHash(binding.orderHash, input.plan.orderHash)
      && sameHash(binding.quoteHash, input.plan.quoteHash)
      && sameHash(binding.routeHash, input.plan.routeHash),
    'attempt binding differs from the coordinated order, quote, or route');
    requireCondition(sameHash(binding.packageId, input.planLeg.inventoryReservationId),
      'inventory reservation is not the bonded package ID');
    requireCondition(getAddress(binding.account) === getAddress(input.execution.plan.strategyAccount),
      'asynchronous strategy account differs from the bonded package');
    requireCondition(input.compensation.actionKind === 'CANCEL_PENDING_EXECUTION',
      'compensation must cancel the reserved asynchronous execution');
    const payloadHash = arbitrumAsyncCancellationPayloadHash({
      coordinator: this.#config.coordinator,
      adapter: this.#config.adapter,
      packageId: binding.packageId,
      owner: binding.owner,
    });
    requireCondition(sameHash(payloadHash, input.compensation.actionPayloadHash),
      'compensation payload differs from the exact cancel and funding-release calls');
    requireCondition(this.#config.maximumCompensationCostQuoteAtoms <= input.compensation.maximumCostQuoteAtoms,
      'reviewed compensation cost exceeds the signed cap');
    return Object.freeze({ attemptId, binding });
  }

  async #prepare(attemptId: string, binding: ArbitrumSepoliaExecutionBinding): Promise<EvmCrossDomainPhaseResult> {
    const result = await this.#executor.reserve(attemptId);
    if (result.status === 'RESERVED') return this.#observed(binding.packageId);
    if (result.status === 'FAILED' || result.status === 'COMPENSATED') {
      return Object.freeze({
        status: 'DEFINITIVE_PREPARE_FAILURE' as const,
        evidenceHash: binding.packageId,
        atValue: this.#evidenceTime,
      });
    }
    if (result.status === 'AWAITING_OWNER_SIGNATURE'
      || result.status === 'AWAITING_OWNER_FUNDING'
      || result.status === 'IN_FLIGHT') return Object.freeze({ status: 'PENDING' as const });
    throw new Error(`Arbitrum cross-domain execution refused: prepare reached ${result.status}`);
  }

  async #commit(attemptId: string, binding: ArbitrumSepoliaExecutionBinding): Promise<EvmCrossDomainPhaseResult> {
    const result = await this.#executor.advance(attemptId);
    if (result.status === 'SETTLED') return this.#observed(binding.packageId);
    if (result.status === 'RESERVED'
      || result.status === 'IN_FLIGHT'
      || result.status === 'VENUE_PENDING'
      || result.status === 'RECOVERY_REQUIRED') return Object.freeze({ status: 'PENDING' as const });
    throw new Error(`Arbitrum cross-domain execution refused: commit reached ${result.status}`);
  }

  async #compensate(
    _input: EvmCrossDomainLaneInput,
    attemptId: string,
    binding: ArbitrumSepoliaExecutionBinding,
  ): Promise<EvmCrossDomainPhaseResult> {
    const result = await this.#executor.cancelReserved(attemptId);
    if (result.status === 'COMPENSATED') return this.#observed(binding.packageId);
    if (result.status === 'IN_FLIGHT') return Object.freeze({ status: 'PENDING' as const });
    throw new Error(`Arbitrum cross-domain execution refused: compensation reached ${result.status}`);
  }

  #observed(evidenceHash: Hex): EvmCrossDomainPhaseResult {
    return Object.freeze({ status: 'OBSERVED' as const, evidenceHash, atValue: this.#evidenceTime });
  }

  #finalized(evidenceHash: Hex): EvmCrossDomainPhaseResult {
    return Object.freeze({ status: 'FINALIZED' as const, evidenceHash, atValue: this.#evidenceTime });
  }
}

import {
  encodeEvmNettingAllocationExecution,
  isCanonicalEvmSignature,
  type EvmNettingOwnerTypedData,
} from '@naryx/adapter-evm';
import type { Hash32 } from '@naryx/protocol-types';
import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import type {
  NettingAllocationLifecycleService,
  RegisteredPreparedNettingAllocation,
} from './netting-allocation-lifecycle.js';

const TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);

export interface EvmNettingAllocationRequest {
  readonly proofHash: Uint8Array | string;
  readonly allocationReceiptHash: Uint8Array | string;
  readonly quoteHash: Hash32;
  readonly domainId: string;
  readonly attemptId: string;
}

export interface EvmNettingAllocationChallenge {
  readonly version: 1;
  readonly attemptId: string;
  readonly authorizationHash: Hex;
  readonly chainId: number;
  readonly owner: Address;
  readonly to: Address;
  readonly ownerTypedData: EvmNettingOwnerTypedData;
}

export interface AuthorizedEvmNettingAllocation extends EvmNettingAllocationChallenge {
  readonly value: 0n;
  readonly data: Hex;
  readonly ownerSignature: Hex;
  readonly solverSignature: Hex;
}

type LifecyclePort = Pick<NettingAllocationLifecycleService, 'prepareAndRegister'>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM netting allocation authorization refused: ${message}`);
}

function hex(value: Uint8Array): Hex {
  return `0x${Buffer.from(value).toString('hex')}`;
}

export class EvmNettingAllocationAuthorizationService {
  readonly #lifecycle: LifecyclePort;
  readonly #solver: LocalAccount;

  constructor(lifecycle: LifecyclePort, solver: LocalAccount) {
    this.#lifecycle = lifecycle;
    this.#solver = solver;
  }

  async challenge(input: EvmNettingAllocationRequest): Promise<EvmNettingAllocationChallenge> {
    const registered = await this.#registered(input);
    const prepared = registered.prepared;
    requireCondition(prepared.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'prepared allocation is not EVM');
    const netting = prepared.netting;
    const chainId = netting.ownerTypedData.domain.chainId;
    requireCondition(TEST_CHAIN_IDS.has(chainId), 'execution chain is not an allowed test chain');
    requireCondition(getAddress(prepared.authorization.solverId) === this.#solver.address,
      'prepared solver differs from the configured signing account');
    return Object.freeze({
      version: 1,
      attemptId: registered.attempt.attemptId,
      authorizationHash: hex(prepared.authorization.authorizationHash),
      chainId,
      owner: getAddress(prepared.authorization.ownerId),
      to: netting.envelope.account,
      ownerTypedData: netting.ownerTypedData,
    });
  }

  async authorize(input: EvmNettingAllocationRequest & Readonly<{
    ownerSignature: Hex;
  }>): Promise<AuthorizedEvmNettingAllocation> {
    requireCondition(isCanonicalEvmSignature(input.ownerSignature), 'owner signature is not canonical ECDSA');
    const registered = await this.#registered(input);
    const prepared = registered.prepared;
    requireCondition(prepared.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'prepared allocation is not EVM');
    const netting = prepared.netting;
    const chainId = netting.ownerTypedData.domain.chainId;
    requireCondition(TEST_CHAIN_IDS.has(chainId), 'execution chain is not an allowed test chain');
    requireCondition(getAddress(prepared.authorization.solverId) === this.#solver.address,
      'prepared solver differs from the configured signing account');
    const owner = getAddress(prepared.authorization.ownerId);
    const recovered = await recoverTypedDataAddress({
      domain: netting.ownerTypedData.domain,
      types: netting.ownerTypedData.types,
      primaryType: netting.ownerTypedData.primaryType,
      message: netting.ownerTypedData.message,
      signature: input.ownerSignature,
    });
    requireCondition(recovered === owner, 'owner signature does not authorize the netting allocation');
    const solverSignature = await this.#solver.signTypedData({
      domain: netting.solverTypedData.domain,
      types: netting.solverTypedData.types,
      primaryType: netting.solverTypedData.primaryType,
      message: netting.solverTypedData.message,
    });
    requireCondition(isCanonicalEvmSignature(solverSignature), 'solver produced a noncanonical signature');
    const data = encodeEvmNettingAllocationExecution({
      netting,
      ownerSignature: input.ownerSignature,
      solverSignature,
    });
    return Object.freeze({
      version: 1,
      attemptId: registered.attempt.attemptId,
      authorizationHash: hex(prepared.authorization.authorizationHash),
      chainId,
      owner,
      to: netting.envelope.account,
      ownerTypedData: netting.ownerTypedData,
      value: 0n,
      data,
      ownerSignature: input.ownerSignature,
      solverSignature,
    });
  }

  async #registered(input: EvmNettingAllocationRequest): Promise<RegisteredPreparedNettingAllocation> {
    return this.#lifecycle.prepareAndRegister(input);
  }
}

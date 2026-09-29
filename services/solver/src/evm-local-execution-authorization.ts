import {
  compileEvmLocalAtomicExecution,
  type EvmLocalAtomicBinding,
  type EvmLocalAtomicBounds,
  type EvmLocalAtomicExecution,
  type EvmLocalAtomicPayload,
} from '@naryx/adapter-evm';
import type { CompiledExecution } from '@naryx/adapter-core';
import type { PackageAdmission } from '@naryx/protocol-types';
import {
  getAddress,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';

const EMPTY_SIGNATURE = `0x${'00'.repeat(65)}` as Hex;

export interface EvmLocalExecutionAuthorizationChain {
  readonly environment: 'local';
  readonly mainnet: false;
  chainReference(): Promise<bigint>;
  traderPermitDigest(execution: EvmLocalAtomicExecution): Promise<Hex>;
  solverAuthorizationDigest(execution: EvmLocalAtomicExecution): Promise<Hex>;
}

export interface EvmLocalExecutionSigner {
  readonly address: Address;
  signDigest(digest: Hex): Promise<Hex>;
}

export type EvmLocalExecutionAuthorizationInput = Readonly<{
  admission: PackageAdmission;
  binding: EvmLocalAtomicBinding;
  bounds: Omit<EvmLocalAtomicBounds, 'solverSignature'>;
}>;

export type AuthorizedEvmLocalExecution = Readonly<{
  compiled: CompiledExecution<EvmLocalAtomicPayload>;
  traderPermitDigest: Hex;
  solverAuthorizationDigest: Hex;
  solverSignature: Hex;
}>;

export class EvmLocalExecutionAuthorizationService {
  readonly #chain: EvmLocalExecutionAuthorizationChain;
  readonly #signer: EvmLocalExecutionSigner;

  constructor(options: Readonly<{
    chain: EvmLocalExecutionAuthorizationChain;
    signer: EvmLocalExecutionSigner;
  }>) {
    if (options.chain.environment !== 'local' || options.chain.mainnet !== false) {
      throw new Error('EVM execution authorization is restricted to a local non-mainnet chain');
    }
    this.#chain = options.chain;
    this.#signer = options.signer;
  }

  async authorize(input: EvmLocalExecutionAuthorizationInput): Promise<AuthorizedEvmLocalExecution> {
    const chainReference = await this.#chain.chainReference();
    if (chainReference !== input.binding.chainReference) {
      throw new Error('EVM local chain identity does not match the execution binding');
    }
    if (getAddress(this.#signer.address) !== getAddress(input.binding.solver)) {
      throw new Error('EVM local signer does not match the bound solver');
    }
    const draft = compileEvmLocalAtomicExecution(input.admission, input.binding, {
      ...input.bounds,
      solverSignature: EMPTY_SIGNATURE,
    });
    const traderPermitDigest = await this.#chain.traderPermitDigest(draft.payload.execution);
    const recoveredTrader = await recoverAddress({
      hash: traderPermitDigest,
      signature: input.bounds.traderSignature,
    });
    if (getAddress(recoveredTrader) !== getAddress(draft.payload.execution.trader)) {
      throw new Error('EVM trader authorization does not match the admitted owner');
    }
    const solverAuthorizationDigest = await this.#chain.solverAuthorizationDigest(draft.payload.execution);
    const solverSignature = await this.#signer.signDigest(solverAuthorizationDigest);
    const compiled = compileEvmLocalAtomicExecution(input.admission, input.binding, {
      ...input.bounds,
      solverSignature,
    });
    return Object.freeze({
      compiled,
      traderPermitDigest,
      solverAuthorizationDigest,
      solverSignature,
    });
  }
}

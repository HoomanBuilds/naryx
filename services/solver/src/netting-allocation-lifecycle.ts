import {
  commitmentHash,
  protocolId,
  toHex,
  type Hash32,
} from '@naryx/protocol-types';
import type {
  HttpNettingAllocationAdminClient,
  RegisteredNettingAllocationAttempt,
} from './netting-allocation-admin-client.js';
import {
  prepareNettingAllocationExecution,
  type PreparedNettingAllocationExecution,
} from './netting-allocation-execution-preparer.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

type AdminPort = Pick<
  HttpNettingAllocationAdminClient,
  'preparation' | 'register' | 'bindExecutionReference' | 'settle'
>;

type StrategyPort = Pick<StrategyPreparationService, 'prepareNativeByQuote'>;

export interface RegisteredPreparedNettingAllocation {
  readonly proofHashHex: string;
  readonly allocationReceiptHashHex: string;
  readonly prepared: PreparedNettingAllocationExecution;
  readonly attempt: RegisteredNettingAllocationAttempt;
}

export interface NettingAllocationExecutionRequest {
  readonly proofHash: Uint8Array | string;
  readonly allocationReceiptHash: Uint8Array | string;
  readonly quoteHash: Hash32;
  readonly domainId: string;
  readonly attemptId: string;
}

function attemptId(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(value)) {
    throw new Error('netting allocation attempt ID is invalid');
  }
  return value;
}

export class NettingAllocationLifecycleService {
  readonly #admin: AdminPort;
  readonly #strategies: StrategyPort;
  readonly #prepare: typeof prepareNettingAllocationExecution;

  constructor(
    admin: AdminPort,
    strategies: StrategyPort,
    prepare: typeof prepareNettingAllocationExecution = prepareNettingAllocationExecution,
  ) {
    this.#admin = admin;
    this.#strategies = strategies;
    this.#prepare = prepare;
  }

  async prepareAndRegister(input: NettingAllocationExecutionRequest): Promise<RegisteredPreparedNettingAllocation> {
    const proofHashHex = toHex(commitmentHash(input.proofHash, 'proofHash'));
    const allocationReceiptHashHex = toHex(commitmentHash(
      input.allocationReceiptHash,
      'allocationReceiptHash',
    ));
    const domainId = protocolId(input.domainId, 'domainId');
    const [batch, strategy] = await Promise.all([
      this.#admin.preparation(proofHashHex),
      this.#strategies.prepareNativeByQuote(input.quoteHash),
    ]);
    if (strategy === undefined) throw new Error('netting allocation strategy quote was not found');
    const allocations = batch.allocations.filter((value) =>
      value.allocationReceiptHashHex === allocationReceiptHashHex);
    if (allocations.length !== 1) {
      throw new Error('netting allocation does not resolve to exactly one settlement commitment');
    }
    const domains = strategy.domains.filter((value) => value.domain.domainId === domainId);
    if (domains.length !== 1) {
      throw new Error('netting allocation does not resolve to exactly one prepared execution domain');
    }
    const prepared = this.#prepare({
      finalAllocationReceipt: batch.finalAllocationReceipt,
      allocationReceiptHash: allocationReceiptHashHex,
      result: batch.result,
      policy: batch.policy,
      intents: batch.externalExecutions.map((value) => value.intent),
      externalEvidence: batch.externalExecutions.flatMap((value) =>
        value.evidence === undefined ? [] : [value.evidence]),
      settlement: allocations[0]!.settlement,
      domainExecution: domains[0]!,
    });
    const authorizationHashHex = toHex(prepared.authorization.authorizationHash);
    const attempt = await this.#admin.register({
      attemptId: attemptId(input.attemptId),
      idempotencyKey: authorizationHashHex,
      authorization: prepared.authorization,
      observation: prepared.observation,
    });
    return Object.freeze({
      proofHashHex,
      allocationReceiptHashHex,
      prepared,
      attempt,
    });
  }

  bindExecutionReference(input: Readonly<{
    attemptId: string;
    authorizationHash: Uint8Array | string;
    executionReference: string;
  }>): Promise<RegisteredNettingAllocationAttempt> {
    return this.#admin.bindExecutionReference({
      attemptId: attemptId(input.attemptId),
      authorizationHash: toHex(commitmentHash(input.authorizationHash, 'authorizationHash')),
      executionReference: input.executionReference,
    });
  }

  reconcile(proofHash: Uint8Array | string): Promise<unknown> {
    return this.#admin.settle(toHex(commitmentHash(proofHash, 'proofHash')));
  }
}

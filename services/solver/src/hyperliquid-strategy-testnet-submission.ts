import { createHash } from 'node:crypto';
import {
  AbstractWalletError,
  ValidationError,
} from '@nktkas/hyperliquid';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import type { HyperliquidStrategyExecutionPlan } from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME,
  HYPERLIQUID_RECONCILIATION_COLLECTOR,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  type HyperliquidSubmissionAccount,
} from './index.js';
import type {
  HyperliquidStrategyDurableSubmissionJournalPort,
  HyperliquidStrategyJournalReceipt,
  HyperliquidStrategyJournalRecord,
} from './hyperliquid-strategy-sqlite-journal.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface HyperliquidStrategySubmissionInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly batchStage: number;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidStrategyExecutionPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidStrategyReconciliationHandoff {
  readonly collector: typeof HYPERLIQUID_RECONCILIATION_COLLECTOR;
  readonly attemptId: string;
  readonly batchStage: number;
  readonly account: HyperliquidSubmissionAccount;
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly legIds: readonly string[];
  readonly clientOrderIds: readonly `0x${string}`[];
}

interface SubmissionEvidenceBase {
  readonly attemptId: string;
  readonly batchStage: number;
  readonly actionCommitment: `0x${string}` | null;
  readonly requestCommitment: `0x${string}` | null;
}

export type HyperliquidStrategySubmissionResult =
  | Readonly<SubmissionEvidenceBase & {
      status: 'NOT_SUBMITTED';
      evidenceStatus: 'PRECONDITION_REJECTED' | 'JOURNAL_REJECTED';
      settlementStatus: 'NOT_APPLICABLE';
      errorCommitment: `0x${string}`;
      reconciliation: null;
    }>
  | Readonly<SubmissionEvidenceBase & {
      status: 'SUBMISSION_ACKNOWLEDGED';
      evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      responseCommitment: `0x${string}`;
      reconciliation: HyperliquidStrategyReconciliationHandoff;
    }>
  | Readonly<SubmissionEvidenceBase & {
      status: 'SUBMISSION_REJECTED';
      evidenceStatus: 'SIGNER_REJECTED' | 'CLIENT_REJECTED' | 'VENUE_REJECTED';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidStrategyReconciliationHandoff;
    }>
  | Readonly<SubmissionEvidenceBase & {
      status: 'SUBMISSION_AMBIGUOUS';
      evidenceStatus: 'RESPONSE_UNKNOWN';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidStrategyReconciliationHandoff;
    }>;

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function commitment(value: unknown): `0x${string}` {
  return `0x${createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function errorCommitment(error: unknown): `0x${string}` {
  if (error instanceof ApiRequestError) {
    return commitment({ name: error.name, message: error.message, response: error.response });
  }
  if (error instanceof Error) return commitment({ name: error.name, message: error.message });
  return commitment({ error });
}

function normalizedAddress(value: string, name: string): `0x${string}` {
  const normalized = value.toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error(`${name} must be a 20-byte address`);
  return normalized as `0x${string}`;
}

function validateInput(input: HyperliquidStrategySubmissionInput): Readonly<{
  account: HyperliquidSubmissionAccount;
  agentWallet: `0x${string}`;
  vaultAddress: `0x${string}` | null;
}> {
  if (!IDENTIFIER.test(input.attemptId) || !IDENTIFIER.test(input.signerLeaseId)
    || !Number.isSafeInteger(input.batchStage) || input.batchStage < 0
    || input.expectedVersion < 0n || input.nowMs <= 0n || input.nonce <= 0n
    || input.nonce > MAX_SAFE_INTEGER) {
    throw new Error('submission identity, journal version, clock, or nonce is invalid');
  }
  if (input.plan.version !== 1
    || input.plan.guarantee !== 'BATCHED_IOC_WITH_BOUNDED_RECOVERY'
    || input.plan.domain.domainId !== 'hypercore:testnet'
    || input.plan.requestExpiryMs <= input.nowMs
    || input.plan.requestExpiryMs <= input.nonce
    || input.plan.requestExpiryMs > MAX_SAFE_INTEGER) {
    throw new Error('only current compiled HyperCore Testnet strategy actions are supported');
  }
  const batch = input.plan.batches.filter((candidate) => candidate.stage === input.batchStage);
  if (batch.length !== 1 || batch[0]!.action.orders.length < 1
    || batch[0]!.action.orders.length > 16) {
    throw new Error('strategy batch stage is missing or unsupported');
  }
  const masterAccount = normalizedAddress(input.account.masterAccount, 'masterAccount');
  const tradingAccount = normalizedAddress(input.account.tradingAccount, 'tradingAccount');
  if (input.account.accountKind !== 'MASTER' && input.account.accountKind !== 'SUBACCOUNT') {
    throw new Error('account kind is unsupported');
  }
  if ((input.account.accountKind === 'MASTER' && masterAccount !== tradingAccount)
    || (input.account.accountKind === 'SUBACCOUNT' && masterAccount === tradingAccount)) {
    throw new Error('master and trading account relation is invalid');
  }
  const agentWallet = normalizedAddress(input.agentWallet, 'agentWallet');
  if (agentWallet === masterAccount || agentWallet === tradingAccount) {
    throw new Error('agent wallet must differ from account identities');
  }
  const vaultAddress = input.vaultAddress === null
    ? null : normalizedAddress(input.vaultAddress, 'vaultAddress');
  if ((input.account.accountKind === 'MASTER' && vaultAddress !== null)
    || (input.account.accountKind === 'SUBACCOUNT' && vaultAddress !== tradingAccount)) {
    throw new Error('vault context does not match the trading account');
  }
  return Object.freeze({
    account: Object.freeze({ masterAccount, tradingAccount, accountKind: input.account.accountKind }),
    agentWallet,
    vaultAddress,
  });
}

function evidenceBase(
  input: Pick<HyperliquidStrategySubmissionInput, 'attemptId' | 'batchStage'>,
  record: HyperliquidStrategyJournalRecord | null,
): SubmissionEvidenceBase {
  return Object.freeze({
    attemptId: input.attemptId,
    batchStage: input.batchStage,
    actionCommitment: record?.actionHash ?? null,
    requestCommitment: record?.recordHash ?? null,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAction(
  left: HyperliquidStrategyJournalRecord['action'],
  right: HyperliquidStrategyJournalRecord['action'],
): boolean {
  const fields = (action: HyperliquidStrategyJournalRecord['action']): unknown => [
    action.type,
    action.grouping,
    action.orders.map((order) => [
      order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c.toLowerCase(),
    ]),
  ];
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

function validateReceipt(
  receipt: HyperliquidStrategyJournalReceipt,
  input: HyperliquidStrategySubmissionInput,
  status: HyperliquidStrategyJournalRecord['status'],
  previousVersion?: bigint,
): void {
  const record = receipt.record;
  const batch = input.plan.batches.find((candidate) => candidate.stage === input.batchStage)!;
  const orders = input.plan.orders.filter((candidate) => candidate.stage === input.batchStage);
  const expectedClientOrderIds = orders.map((order) => order.clientOrderId.toLowerCase());
  if (receipt.journalVersion < 0n
    || (previousVersion !== undefined && receipt.journalVersion <= previousVersion)
    || record.status !== status
    || record.attemptId !== input.attemptId
    || record.batchStage !== input.batchStage
    || record.agentWallet !== input.agentWallet.toLowerCase()
    || record.signerLeaseId !== input.signerLeaseId
    || record.nonce !== input.nonce
    || record.expiresAfterMs !== input.plan.requestExpiryMs
    || record.vaultAddress !== (input.vaultAddress === null ? null : input.vaultAddress.toLowerCase())
    || record.account.masterAccount !== input.account.masterAccount.toLowerCase()
    || record.account.tradingAccount !== input.account.tradingAccount.toLowerCase()
    || record.account.accountKind !== input.account.accountKind
    || !sameAction(record.action, batch.action)
    || record.legIds.length !== batch.legIds.length
    || record.legIds.some((legId, index) => legId !== batch.legIds[index])
    || record.clientOrderIds.length !== expectedClientOrderIds.length
    || record.clientOrderIds.some((clientOrderId, index) =>
      clientOrderId !== expectedClientOrderIds[index])
    || record.domain.domainId !== input.plan.domain.domainId
    || record.domain.domainManifestVersion !== input.plan.domain.domainManifestVersion
    || !bytesEqual(record.domain.domainManifestHash, input.plan.domain.domainManifestHash)
    || !bytesEqual(record.commitments.orderHash, input.plan.orderHash)
    || !bytesEqual(record.commitments.graphHash, input.plan.graphHash)
    || !bytesEqual(record.commitments.quoteHash, input.plan.quoteHash)
    || !bytesEqual(record.commitments.routeHash, input.plan.routeHash)
    || (status === 'PREPARED' ? record.durableRevision !== null : record.durableRevision === null)) {
    throw new Error(`journal ${status} receipt does not match the compiled strategy batch`);
  }
}

function handoff(record: HyperliquidStrategyJournalRecord): HyperliquidStrategyReconciliationHandoff {
  if (record.durableRevision === null) throw new Error('reconciliation requires a durable record');
  return Object.freeze({
    collector: HYPERLIQUID_RECONCILIATION_COLLECTOR,
    attemptId: record.attemptId,
    batchStage: record.batchStage,
    account: record.account,
    actionHash: record.actionHash,
    actionCommitmentScheme: record.actionCommitmentScheme,
    requestCommitment: record.recordHash,
    durableRevision: record.durableRevision,
    legIds: record.legIds,
    clientOrderIds: record.clientOrderIds,
  });
}

export class HyperliquidStrategyTestnetSubmissionService {
  readonly #journal: HyperliquidStrategyDurableSubmissionJournalPort;
  readonly #submitter: HyperliquidSdkTestnetOrderSubmitter;

  constructor(
    journal: HyperliquidStrategyDurableSubmissionJournalPort,
    submitter: HyperliquidSdkTestnetOrderSubmitter,
  ) {
    if (!journal || typeof journal.prepare !== 'function'
      || typeof journal.confirmDurable !== 'function'
      || typeof journal.markSubmittedUnknown !== 'function'
      || typeof journal.acknowledge !== 'function'
      || typeof journal.reject !== 'function'
      || typeof journal.beginReconciliation !== 'function') {
      throw new Error('a complete durable Hyperliquid strategy journal is required');
    }
    if (!(submitter instanceof HyperliquidSdkTestnetOrderSubmitter)
      || submitter.environment !== 'testnet'
      || submitter.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('submission client is not exact Hyperliquid Testnet');
    }
    this.#journal = journal;
    this.#submitter = submitter;
  }

  async submitBatch(input: HyperliquidStrategySubmissionInput):
  Promise<HyperliquidStrategySubmissionResult> {
    let validated: ReturnType<typeof validateInput>;
    try {
      validated = validateInput(input);
      if (await this.#submitter.signerAddress() !== validated.agentWallet) {
        throw new Error('injected signer does not match the journal agent wallet');
      }
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input, null),
        status: 'NOT_SUBMITTED',
        evidenceStatus: 'PRECONDITION_REJECTED',
        settlementStatus: 'NOT_APPLICABLE',
        errorCommitment: errorCommitment(error),
        reconciliation: null,
      });
    }

    let receipt: HyperliquidStrategyJournalReceipt;
    let lastRecord: HyperliquidStrategyJournalRecord | null = null;
    try {
      const prepared = await this.#journal.prepare({ ...input, ...validated });
      validateReceipt(prepared, input, 'PREPARED', input.expectedVersion);
      lastRecord = prepared.record;
      const durable = await this.#journal.confirmDurable({
        expectedVersion: prepared.journalVersion,
        attemptId: input.attemptId,
        batchStage: input.batchStage,
        recordHash: prepared.record.recordHash,
      });
      validateReceipt(durable, input, 'DURABLE_RECORD_CONFIRMED', prepared.journalVersion);
      lastRecord = durable.record;
      receipt = await this.#journal.markSubmittedUnknown({
        expectedVersion: durable.journalVersion,
        attemptId: input.attemptId,
        batchStage: input.batchStage,
        nowMs: input.nowMs,
      });
      validateReceipt(receipt, input, 'SUBMITTED_UNKNOWN', durable.journalVersion);
      lastRecord = receipt.record;
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input, lastRecord),
        status: 'NOT_SUBMITTED',
        evidenceStatus: 'JOURNAL_REJECTED',
        settlementStatus: 'NOT_APPLICABLE',
        errorCommitment: errorCommitment(error),
        reconciliation: null,
      });
    }

    try {
      const response = await this.#submitter.submit({
        action: receipt.record.action,
        nonce: receipt.record.nonce,
        expiresAfterMs: receipt.record.expiresAfterMs,
        vaultAddress: receipt.record.vaultAddress,
      });
      const responseCommitment = commitment(response);
      const acknowledged = await this.#journal.acknowledge({
        expectedVersion: receipt.journalVersion,
        attemptId: input.attemptId,
        batchStage: input.batchStage,
        acknowledgementId: responseCommitment,
      });
      validateReceipt(acknowledged, input, 'ACKNOWLEDGED', receipt.journalVersion);
      const reconciling = await this.#journal.beginReconciliation({
        expectedVersion: acknowledged.journalVersion,
        attemptId: input.attemptId,
        batchStage: input.batchStage,
      });
      validateReceipt(reconciling, input, 'RECONCILING', acknowledged.journalVersion);
      return Object.freeze({
        ...evidenceBase(input, reconciling.record),
        status: 'SUBMISSION_ACKNOWLEDGED',
        evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY',
        settlementStatus: 'RECONCILIATION_REQUIRED',
        responseCommitment,
        reconciliation: handoff(reconciling.record),
      });
    } catch (error) {
      const knownRejection = error instanceof ApiRequestError
        || error instanceof AbstractWalletError || error instanceof ValidationError;
      try {
        if (knownRejection) {
          const rejected = await this.#journal.reject({
            expectedVersion: receipt.journalVersion,
            attemptId: input.attemptId,
            batchStage: input.batchStage,
            rejectionId: errorCommitment(error),
          });
          validateReceipt(rejected, input, 'REJECTED', receipt.journalVersion);
          const reconciling = await this.#journal.beginReconciliation({
            expectedVersion: rejected.journalVersion,
            attemptId: input.attemptId,
            batchStage: input.batchStage,
          });
          validateReceipt(reconciling, input, 'RECONCILING', rejected.journalVersion);
          return Object.freeze({
            ...evidenceBase(input, reconciling.record),
            status: 'SUBMISSION_REJECTED',
            evidenceStatus: error instanceof AbstractWalletError
              ? 'SIGNER_REJECTED'
              : error instanceof ValidationError ? 'CLIENT_REJECTED' : 'VENUE_REJECTED',
            settlementStatus: 'RECONCILIATION_REQUIRED',
            errorCommitment: errorCommitment(error),
            reconciliation: handoff(reconciling.record),
          });
        }
        const reconciling = await this.#journal.beginReconciliation({
          expectedVersion: receipt.journalVersion,
          attemptId: input.attemptId,
          batchStage: input.batchStage,
        });
        validateReceipt(reconciling, input, 'RECONCILING', receipt.journalVersion);
        return Object.freeze({
          ...evidenceBase(input, reconciling.record),
          status: 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: 'RESPONSE_UNKNOWN',
          settlementStatus: 'RECONCILIATION_REQUIRED',
          errorCommitment: errorCommitment(error),
          reconciliation: handoff(reconciling.record),
        });
      } catch (journalError) {
        return Object.freeze({
          ...evidenceBase(input, receipt.record),
          status: 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: 'RESPONSE_UNKNOWN',
          settlementStatus: 'RECONCILIATION_REQUIRED',
          errorCommitment: commitment({
            submission: errorCommitment(error),
            journal: errorCommitment(journalError),
          }),
          reconciliation: handoff(receipt.record),
        });
      }
    }
  }
}

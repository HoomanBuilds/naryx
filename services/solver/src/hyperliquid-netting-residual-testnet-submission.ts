import { createHash } from 'node:crypto';
import {
  AbstractWalletError,
  ValidationError,
} from '@nktkas/hyperliquid';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import type { HyperliquidNettingResidualPlan } from '@naryx/adapter-hyperliquid';
import type { CommitmentHash } from '@naryx/protocol-types';
import {
  HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME,
  HYPERLIQUID_RECONCILIATION_COLLECTOR,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  type HyperliquidSubmissionAccount,
} from './index.js';
import type {
  HyperliquidNettingResidualDurableJournalPort,
  HyperliquidNettingResidualJournalReceipt,
  HyperliquidNettingResidualJournalRecord,
} from './hyperliquid-netting-residual-sqlite-journal.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface HyperliquidNettingResidualSubmissionInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidNettingResidualPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidNettingResidualReconciliationHandoff {
  readonly collector: typeof HYPERLIQUID_RECONCILIATION_COLLECTOR;
  readonly attemptId: string;
  readonly account: HyperliquidSubmissionAccount;
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly clientOrderId: `0x${string}`;
  readonly intentHash: CommitmentHash;
  readonly instrumentHash: CommitmentHash;
}

interface SubmissionEvidenceBase {
  readonly attemptId: string;
  readonly actionCommitment: `0x${string}` | null;
  readonly requestCommitment: `0x${string}` | null;
}

export type HyperliquidNettingResidualSubmissionResult =
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
      reconciliation: HyperliquidNettingResidualReconciliationHandoff;
    }>
  | Readonly<SubmissionEvidenceBase & {
      status: 'SUBMISSION_REJECTED';
      evidenceStatus: 'SIGNER_REJECTED' | 'CLIENT_REJECTED' | 'VENUE_REJECTED';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidNettingResidualReconciliationHandoff;
    }>
  | Readonly<SubmissionEvidenceBase & {
      status: 'SUBMISSION_AMBIGUOUS';
      evidenceStatus: 'RESPONSE_UNKNOWN';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidNettingResidualReconciliationHandoff;
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateInput(input: HyperliquidNettingResidualSubmissionInput): Readonly<{
  account: HyperliquidSubmissionAccount;
  agentWallet: `0x${string}`;
  vaultAddress: `0x${string}` | null;
}> {
  if (!IDENTIFIER.test(input.attemptId) || !IDENTIFIER.test(input.signerLeaseId)
    || input.expectedVersion < 0n || input.nowMs <= 0n || input.nonce <= 0n
    || input.nonce > MAX_SAFE_INTEGER) {
    throw new Error('submission identity, journal version, clock, or nonce is invalid');
  }
  const plan = input.plan;
  if (plan.version !== 1 || plan.guarantee !== 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE'
    || plan.domain.domainId !== 'hypercore:testnet'
    || plan.requestExpiryMs <= input.nowMs || plan.requestExpiryMs <= input.nonce
    || plan.requestExpiryMs > MAX_SAFE_INTEGER || plan.action.type !== 'order'
    || plan.action.grouping !== 'na' || plan.action.orders.length !== 1
    || plan.action.orders[0]?.c.toLowerCase() !== plan.clientOrderId.toLowerCase()) {
    throw new Error('only current compiled Hyperliquid Testnet residual actions are supported');
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
  attemptId: string,
  record: HyperliquidNettingResidualJournalRecord | null,
): SubmissionEvidenceBase {
  return Object.freeze({
    attemptId,
    actionCommitment: record?.actionHash ?? null,
    requestCommitment: record?.recordHash ?? null,
  });
}

function sameAction(
  left: HyperliquidNettingResidualJournalRecord['action'],
  right: HyperliquidNettingResidualJournalRecord['action'],
): boolean {
  const fields = (action: HyperliquidNettingResidualJournalRecord['action']): unknown => [
    action.type,
    action.grouping,
    action.orders.map((order) => [
      order.a, order.b, order.p, order.s, order.r, order.t.limit.tif, order.c.toLowerCase(),
    ]),
  ];
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

function validateReceipt(
  receipt: HyperliquidNettingResidualJournalReceipt,
  input: HyperliquidNettingResidualSubmissionInput,
  status: HyperliquidNettingResidualJournalRecord['status'],
  previousVersion?: bigint,
): void {
  const record = receipt.record;
  if (receipt.journalVersion < 0n
    || (previousVersion !== undefined && receipt.journalVersion <= previousVersion)
    || record.status !== status || record.attemptId !== input.attemptId
    || record.agentWallet !== input.agentWallet.toLowerCase()
    || record.signerLeaseId !== input.signerLeaseId || record.nonce !== input.nonce
    || record.expiresAfterMs !== input.plan.requestExpiryMs
    || record.vaultAddress !== (input.vaultAddress === null ? null : input.vaultAddress.toLowerCase())
    || record.account.masterAccount !== input.account.masterAccount.toLowerCase()
    || record.account.tradingAccount !== input.account.tradingAccount.toLowerCase()
    || record.account.accountKind !== input.account.accountKind
    || !sameAction(record.action, input.plan.action)
    || record.clientOrderId !== input.plan.clientOrderId.toLowerCase()
    || record.domain.domainId !== input.plan.domain.domainId
    || record.domain.domainManifestVersion !== input.plan.domain.domainManifestVersion
    || !bytesEqual(record.domain.domainManifestHash, input.plan.domain.domainManifestHash)
    || !bytesEqual(record.intentHash, input.plan.intentHash)
    || !bytesEqual(record.instrumentHash, input.plan.instrumentHash)
    || (status === 'PREPARED' ? record.durableRevision !== null : record.durableRevision === null)) {
    throw new Error(`journal ${status} receipt does not match the compiled residual action`);
  }
}

function handoff(
  record: HyperliquidNettingResidualJournalRecord,
): HyperliquidNettingResidualReconciliationHandoff {
  if (record.durableRevision === null) throw new Error('reconciliation requires a durable record');
  return Object.freeze({
    collector: HYPERLIQUID_RECONCILIATION_COLLECTOR,
    attemptId: record.attemptId,
    account: record.account,
    actionHash: record.actionHash,
    actionCommitmentScheme: record.actionCommitmentScheme,
    requestCommitment: record.recordHash,
    durableRevision: record.durableRevision,
    clientOrderId: record.clientOrderId,
    intentHash: record.intentHash,
    instrumentHash: record.instrumentHash,
  });
}

export class HyperliquidNettingResidualTestnetSubmissionService {
  readonly #journal: HyperliquidNettingResidualDurableJournalPort;
  readonly #submitter: HyperliquidSdkTestnetOrderSubmitter;

  constructor(
    journal: HyperliquidNettingResidualDurableJournalPort,
    submitter: HyperliquidSdkTestnetOrderSubmitter,
  ) {
    if (!journal || typeof journal.prepare !== 'function'
      || typeof journal.confirmDurable !== 'function'
      || typeof journal.markSubmittedUnknown !== 'function'
      || typeof journal.acknowledge !== 'function'
      || typeof journal.reject !== 'function'
      || typeof journal.beginReconciliation !== 'function'
      || typeof journal.readAttempt !== 'function') {
      throw new Error('a complete durable Hyperliquid residual journal is required');
    }
    if (!(submitter instanceof HyperliquidSdkTestnetOrderSubmitter)
      || submitter.environment !== 'testnet'
      || submitter.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('submission client is not exact Hyperliquid Testnet');
    }
    this.#journal = journal;
    this.#submitter = submitter;
  }

  async submitResidual(input: HyperliquidNettingResidualSubmissionInput):
  Promise<HyperliquidNettingResidualSubmissionResult> {
    let validated: ReturnType<typeof validateInput>;
    try {
      validated = validateInput(input);
      if (await this.#submitter.signerAddress() !== validated.agentWallet) {
        throw new Error('injected signer does not match the journal agent wallet');
      }
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input.attemptId, null),
        status: 'NOT_SUBMITTED',
        evidenceStatus: 'PRECONDITION_REJECTED',
        settlementStatus: 'NOT_APPLICABLE',
        errorCommitment: errorCommitment(error),
        reconciliation: null,
      });
    }

    let receipt: HyperliquidNettingResidualJournalReceipt;
    let lastRecord: HyperliquidNettingResidualJournalRecord | null = null;
    try {
      const existing = await this.#journal.readAttempt(input.attemptId);
      let current = existing;
      if (current === null) {
        current = await this.#journal.prepare({ ...input, ...validated });
        validateReceipt(current, input, 'PREPARED', input.expectedVersion);
      } else {
        validateReceipt(current, input, current.record.status);
      }
      lastRecord = current.record;
      if (current.record.status === 'PREPARED') {
        const durable = await this.#journal.confirmDurable({
          expectedVersion: current.journalVersion,
          attemptId: input.attemptId,
          recordHash: current.record.recordHash,
        });
        validateReceipt(durable, input, 'DURABLE_RECORD_CONFIRMED', current.journalVersion);
        current = durable;
        lastRecord = current.record;
      }
      if (current.record.status === 'DURABLE_RECORD_CONFIRMED') {
        const submitted = await this.#journal.markSubmittedUnknown({
          expectedVersion: current.journalVersion,
          attemptId: input.attemptId,
          nowMs: input.nowMs,
        });
        validateReceipt(submitted, input, 'SUBMITTED_UNKNOWN', current.journalVersion);
        current = submitted;
        lastRecord = current.record;
      }
      if (existing !== null && (current.record.status === 'SUBMITTED_UNKNOWN'
        || current.record.status === 'ACKNOWLEDGED' || current.record.status === 'REJECTED')) {
        const reconciling = await this.#journal.beginReconciliation({
          expectedVersion: current.journalVersion,
          attemptId: input.attemptId,
        });
        validateReceipt(reconciling, input, 'RECONCILING', current.journalVersion);
        current = reconciling;
        lastRecord = current.record;
      }
      if (existing !== null && current.record.status === 'RECONCILING') {
        return Object.freeze({
          ...evidenceBase(input.attemptId, current.record),
          status: 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: 'RESPONSE_UNKNOWN',
          settlementStatus: 'RECONCILIATION_REQUIRED',
          errorCommitment: commitment({ attemptId: input.attemptId, status: 'RECONCILING' }),
          reconciliation: handoff(current.record),
        });
      }
      if (current.record.status !== 'SUBMITTED_UNKNOWN') {
        throw new Error('residual submission is not ready for one network attempt');
      }
      receipt = current;
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input.attemptId, lastRecord),
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
        acknowledgementId: responseCommitment,
      });
      validateReceipt(acknowledged, input, 'ACKNOWLEDGED', receipt.journalVersion);
      const reconciling = await this.#journal.beginReconciliation({
        expectedVersion: acknowledged.journalVersion,
        attemptId: input.attemptId,
      });
      validateReceipt(reconciling, input, 'RECONCILING', acknowledged.journalVersion);
      return Object.freeze({
        ...evidenceBase(input.attemptId, reconciling.record),
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
        const transitioned = knownRejection
          ? await this.#journal.reject({
              expectedVersion: receipt.journalVersion,
              attemptId: input.attemptId,
              rejectionId: errorCommitment(error),
            })
          : receipt;
        if (knownRejection) validateReceipt(transitioned, input, 'REJECTED', receipt.journalVersion);
        const reconciling = await this.#journal.beginReconciliation({
          expectedVersion: transitioned.journalVersion,
          attemptId: input.attemptId,
        });
        validateReceipt(reconciling, input, 'RECONCILING', transitioned.journalVersion);
        return Object.freeze({
          ...evidenceBase(input.attemptId, reconciling.record),
          status: knownRejection ? 'SUBMISSION_REJECTED' : 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: knownRejection
            ? error instanceof AbstractWalletError
              ? 'SIGNER_REJECTED'
              : error instanceof ValidationError ? 'CLIENT_REJECTED' : 'VENUE_REJECTED'
            : 'RESPONSE_UNKNOWN',
          settlementStatus: 'RECONCILIATION_REQUIRED',
          errorCommitment: errorCommitment(error),
          reconciliation: handoff(reconciling.record),
        } as HyperliquidNettingResidualSubmissionResult);
      } catch (journalError) {
        return Object.freeze({
          ...evidenceBase(input.attemptId, receipt.record),
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

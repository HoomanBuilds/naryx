import { createHash } from 'node:crypto';
import {
  AbstractWalletError,
  HttpTransport,
  TESTNET_API_URL,
  ValidationError,
  type IRequestTransport,
} from '@nktkas/hyperliquid';
import {
  ApiRequestError,
  order,
  type OrderSuccessResponse,
} from '@nktkas/hyperliquid/api/exchange';
import {
  getWalletAddress,
  type AbstractWallet,
} from '@nktkas/hyperliquid/signing';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreBatchedOrderAction,
  type HyperliquidExecutionPlan,
  type HyperliquidPlanCommitments,
} from '@naryx/adapter-hyperliquid';

export {
  EvmLocalExecutionAuthorizationService,
  type AuthorizedEvmLocalExecution,
  type EvmLocalExecutionAuthorizationChain,
  type EvmLocalExecutionAuthorizationInput,
  type EvmLocalExecutionSigner,
} from './evm-local-execution-authorization.js';

export const HYPERLIQUID_TESTNET_EXCHANGE_URL = TESTNET_API_URL;
export const HYPERLIQUID_SERVER_SIGNER_SCOPE = 'SERVER_SIDE_HYPERLIQUID_TESTNET_AGENT';
export const HYPERLIQUID_RECONCILIATION_COLLECTOR =
  'HYPERLIQUID_TESTNET_AUTHORITATIVE_EVIDENCE';
export const HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME =
  'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const CLOID = /^0x[0-9a-f]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export type HyperliquidServerSigner = AbstractWallet & Readonly<{
  signerScope: typeof HYPERLIQUID_SERVER_SIGNER_SCOPE;
}>;

export interface HyperliquidTestnetExchangeTransport extends IRequestTransport<'exchange'> {
  readonly isTestnet: true;
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_EXCHANGE_URL;
}

export class HyperliquidTestnetHttpExchangeTransport
implements HyperliquidTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_EXCHANGE_URL;
  readonly #transport: HttpTransport;

  constructor() {
    this.#transport = new HttpTransport({
      isTestnet: true,
      apiUrl: HYPERLIQUID_TESTNET_EXCHANGE_URL,
    });
    this.#assertIdentity();
  }

  #assertIdentity(): void {
    if (!this.#transport.isTestnet
      || this.#transport.apiUrl.toString() !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('Hyperliquid exchange transport is not pinned to Testnet');
    }
  }

  request<T>(endpoint: 'exchange', payload: unknown, signal?: AbortSignal): Promise<T> {
    this.#assertIdentity();
    if (endpoint !== 'exchange') throw new Error('only the Hyperliquid exchange endpoint is available');
    return this.#transport.request<T>('exchange', payload, signal);
  }
}

export interface HyperliquidSignedOrderRequest {
  readonly action: HypercoreBatchedOrderAction;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

interface HyperliquidSignedOrderSubmitter {
  readonly environment: 'testnet';
  readonly apiUrl: typeof HYPERLIQUID_TESTNET_EXCHANGE_URL;
  signerAddress(): Promise<`0x${string}`>;
  submit(request: HyperliquidSignedOrderRequest): Promise<OrderSuccessResponse>;
}

export class HyperliquidSdkTestnetOrderSubmitter implements HyperliquidSignedOrderSubmitter {
  readonly environment = 'testnet' as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_EXCHANGE_URL;
  readonly #signer: HyperliquidServerSigner;
  readonly #transport: HyperliquidTestnetExchangeTransport;

  constructor(
    signer: HyperliquidServerSigner,
    transport: HyperliquidTestnetExchangeTransport = new HyperliquidTestnetHttpExchangeTransport(),
  ) {
    if (signer.signerScope !== HYPERLIQUID_SERVER_SIGNER_SCOPE) {
      throw new Error('a server-side Hyperliquid Testnet signer is required');
    }
    requireTestnetTransport(transport);
    this.#signer = signer;
    this.#transport = transport;
  }

  async signerAddress(): Promise<`0x${string}`> {
    return normalizedAddress(await getWalletAddress(this.#signer), 'signerAddress');
  }

  submit(request: HyperliquidSignedOrderRequest): Promise<OrderSuccessResponse> {
    if (request.nonce <= 0n || request.nonce > MAX_SAFE_INTEGER
      || request.expiresAfterMs <= 0n || request.expiresAfterMs > MAX_SAFE_INTEGER) {
      throw new Error('nonce and expiry must be positive safe integers');
    }
    requireTestnetTransport(this.#transport);
    const options = request.vaultAddress === null
      ? { expiresAfter: Number(request.expiresAfterMs) }
      : { expiresAfter: Number(request.expiresAfterMs), vaultAddress: request.vaultAddress };
    return order({
      transport: this.#transport as IRequestTransport,
      wallet: this.#signer,
      nonceManager: async () => Number(request.nonce),
    }, {
      orders: [...request.action.orders],
      grouping: request.action.grouping,
    }, options);
  }
}

export interface HyperliquidSubmissionAccount {
  readonly masterAccount: `0x${string}`;
  readonly tradingAccount: `0x${string}`;
  readonly accountKind: 'MASTER' | 'SUBACCOUNT';
}

export type HyperliquidJournalStatus =
  | 'PREPARED'
  | 'DURABLE_RECORD_CONFIRMED'
  | 'SUBMITTED_UNKNOWN'
  | 'ACKNOWLEDGED'
  | 'REJECTED'
  | 'RECONCILING';

export interface HyperliquidJournalRecord {
  readonly attemptId: string;
  readonly status: HyperliquidJournalStatus;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly nonce: bigint;
  readonly expiresAfterMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
  readonly action: HypercoreBatchedOrderAction;
  readonly actionCommitmentScheme: typeof HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME;
  readonly actionHash: `0x${string}`;
  readonly recordHash: `0x${string}`;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
  readonly domain: HyperliquidExecutionPlan['domain'];
  readonly commitments: HyperliquidPlanCommitments;
  readonly durableRevision: string | null;
}

export interface HyperliquidJournalReceipt {
  readonly journalVersion: bigint;
  readonly record: HyperliquidJournalRecord;
}

export interface HyperliquidJournalPrepareInput {
  readonly expectedVersion: bigint;
  readonly attemptId: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly plan: HyperliquidExecutionPlan;
  readonly account: HyperliquidSubmissionAccount;
  readonly nonce: bigint;
  readonly nowMs: bigint;
  readonly vaultAddress: `0x${string}` | null;
}

export interface HyperliquidDurableSubmissionJournalPort {
  prepare(input: HyperliquidJournalPrepareInput): Promise<HyperliquidJournalReceipt>;
  confirmDurable(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    recordHash: `0x${string}`;
  }>): Promise<HyperliquidJournalReceipt>;
  markSubmittedUnknown(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    nowMs: bigint;
  }>): Promise<HyperliquidJournalReceipt>;
  acknowledge(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    acknowledgementId: string;
  }>): Promise<HyperliquidJournalReceipt>;
  reject(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
    rejectionId: string;
  }>): Promise<HyperliquidJournalReceipt>;
  beginReconciliation(input: Readonly<{
    expectedVersion: bigint;
    attemptId: string;
  }>): Promise<HyperliquidJournalReceipt>;
}

export interface HyperliquidPackageSubmissionInput extends HyperliquidJournalPrepareInput {}

export interface HyperliquidReconciliationHandoff {
  readonly collector: typeof HYPERLIQUID_RECONCILIATION_COLLECTOR;
  readonly attemptId: string;
  readonly account: HyperliquidSubmissionAccount;
  readonly actionHash: `0x${string}`;
  readonly actionCommitmentScheme: typeof HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME;
  readonly requestCommitment: `0x${string}`;
  readonly durableRevision: string;
  readonly spotClientOrderId: `0x${string}`;
  readonly perpetualClientOrderId: `0x${string}`;
}

interface HyperliquidSubmissionEvidenceBase {
  readonly attemptId: string;
  readonly actionCommitmentScheme:
    typeof HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME | null;
  readonly actionCommitment: `0x${string}` | null;
  readonly requestCommitment: `0x${string}` | null;
}

export type HyperliquidPackageSubmissionResult =
  | Readonly<HyperliquidSubmissionEvidenceBase & {
      status: 'NOT_SUBMITTED';
      evidenceStatus: 'PRECONDITION_REJECTED' | 'JOURNAL_REJECTED';
      settlementStatus: 'NOT_APPLICABLE';
      errorCommitment: `0x${string}`;
      reconciliation: null;
    }>
  | Readonly<HyperliquidSubmissionEvidenceBase & {
      status: 'SUBMISSION_ACKNOWLEDGED';
      evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      responseCommitment: `0x${string}`;
      reconciliation: HyperliquidReconciliationHandoff;
    }>
  | Readonly<HyperliquidSubmissionEvidenceBase & {
      status: 'SUBMISSION_REJECTED';
      evidenceStatus: 'SIGNER_REJECTED' | 'CLIENT_REJECTED' | 'VENUE_REJECTED';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidReconciliationHandoff;
    }>
  | Readonly<HyperliquidSubmissionEvidenceBase & {
      status: 'SUBMISSION_AMBIGUOUS';
      evidenceStatus: 'RESPONSE_UNKNOWN';
      settlementStatus: 'RECONCILIATION_REQUIRED';
      errorCommitment: `0x${string}`;
      reconciliation: HyperliquidReconciliationHandoff;
    }>;

interface ValidatedSubmission {
  readonly input: HyperliquidPackageSubmissionInput;
  readonly account: HyperliquidSubmissionAccount;
  readonly agentWallet: `0x${string}`;
  readonly vaultAddress: `0x${string}` | null;
}

function requireTestnetTransport(transport: HyperliquidTestnetExchangeTransport): void {
  if (transport.isTestnet !== true || transport.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
    throw new Error('exchange transport identity is not exact Hyperliquid Testnet');
  }
}

function normalizedAddress(value: string, name: string): `0x${string}` {
  const normalized = value.toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error(`${name} must be a 20-byte address`);
  return normalized as `0x${string}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isHash32(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length === 32;
}

function sameCommitments(left: HyperliquidPlanCommitments, right: HyperliquidPlanCommitments): boolean {
  return bytesEqual(left.seriesManifestHash, right.seriesManifestHash)
    && bytesEqual(left.executionClassManifestHash, right.executionClassManifestHash)
    && bytesEqual(left.orderHash, right.orderHash)
    && bytesEqual(left.quoteHash, right.quoteHash)
    && bytesEqual(left.routeHash, right.routeHash);
}

function sameDomain(
  left: HyperliquidExecutionPlan['domain'],
  right: HyperliquidExecutionPlan['domain'],
): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function actionFields(action: HypercoreBatchedOrderAction): unknown {
  return [action.type, action.grouping, action.orders.map((value) => [
    value.a, value.b, value.p, value.s, value.r, value.t.limit.tif, value.c.toLowerCase(),
  ])];
}

function sameAction(left: HypercoreBatchedOrderAction, right: HypercoreBatchedOrderAction): boolean {
  return JSON.stringify(actionFields(left)) === JSON.stringify(actionFields(right));
}

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

function normalizedAccount(account: HyperliquidSubmissionAccount): HyperliquidSubmissionAccount {
  const masterAccount = normalizedAddress(account.masterAccount, 'masterAccount');
  const tradingAccount = normalizedAddress(account.tradingAccount, 'tradingAccount');
  if (account.accountKind !== 'MASTER' && account.accountKind !== 'SUBACCOUNT') {
    throw new Error('account kind is unsupported');
  }
  if ((account.accountKind === 'MASTER' && masterAccount !== tradingAccount)
    || (account.accountKind === 'SUBACCOUNT' && masterAccount === tradingAccount)) {
    throw new Error('master and trading account relation is invalid');
  }
  return Object.freeze({ masterAccount, tradingAccount, accountKind: account.accountKind });
}

function validateInput(input: HyperliquidPackageSubmissionInput): ValidatedSubmission {
  if (!IDENTIFIER.test(input.attemptId) || !IDENTIFIER.test(input.signerLeaseId)) {
    throw new Error('attempt or signer lease identity is invalid');
  }
  if (input.expectedVersion < 0n || input.nowMs <= 0n || input.nonce <= 0n
    || input.nonce > MAX_SAFE_INTEGER) {
    throw new Error('journal version, clock, or nonce is invalid');
  }
  if (input.plan.version !== 1 || input.plan.guarantee !== HYPERCORE_EXECUTION_GUARANTEE
    || input.plan.domain.domainId !== 'hypercore:testnet'
    || !Number.isInteger(input.plan.domain.domainManifestVersion)
    || input.plan.domain.domainManifestVersion <= 0
    || !isHash32(input.plan.domain.domainManifestHash)
    || !isHash32(input.plan.commitments.seriesManifestHash)
    || !isHash32(input.plan.commitments.executionClassManifestHash)
    || !isHash32(input.plan.commitments.orderHash)
    || !isHash32(input.plan.commitments.quoteHash)
    || !isHash32(input.plan.commitments.routeHash)) {
    throw new Error('only compiled HyperCore Testnet package actions are supported');
  }
  if (input.plan.requestExpiryMs <= input.nowMs || input.plan.requestExpiryMs <= input.nonce
    || input.plan.requestExpiryMs > MAX_SAFE_INTEGER
    || !Number.isSafeInteger(input.plan.unsignedRequestFields.expiresAfter)
    || BigInt(input.plan.unsignedRequestFields.expiresAfter) !== input.plan.requestExpiryMs) {
    throw new Error('compiled request expiry is invalid or stale');
  }
  const action = input.plan.unsignedRequestFields.action;
  if (action.type !== 'order' || action.grouping !== 'na' || action.orders.length !== 2
    || action.orders.some((value) => value.t.limit.tif !== 'Ioc'
      || !CLOID.test(value.c.toLowerCase()))) {
    throw new Error('compiled package action is not two HyperCore IOC orders');
  }
  if (input.plan.legs.length !== 2
    || !sameAction(action, {
      type: 'order', grouping: 'na', orders: [input.plan.legs[0].order, input.plan.legs[1].order],
    })
    || input.plan.legs.some((leg) => leg.clientOrderId.toLowerCase()
      !== leg.order.c.toLowerCase())) {
    throw new Error('compiled action and planned legs differ');
  }
  const spot = input.plan.legs.find((value) => value.role === 'SPOT');
  const perpetual = input.plan.legs.find((value) => value.role === 'PERPETUAL');
  if (spot === undefined || perpetual === undefined) {
    throw new Error('compiled action requires one spot and one perpetual leg');
  }
  if (spot.clientOrderId.toLowerCase() === perpetual.clientOrderId.toLowerCase()) {
    throw new Error('compiled action client order IDs must be distinct');
  }
  const account = normalizedAccount(input.account);
  const agentWallet = normalizedAddress(input.agentWallet, 'agentWallet');
  if (agentWallet === account.masterAccount || agentWallet === account.tradingAccount) {
    throw new Error('agent wallet must differ from account identities');
  }
  const vaultAddress = input.vaultAddress === null
    ? null : normalizedAddress(input.vaultAddress, 'vaultAddress');
  if ((account.accountKind === 'MASTER' && vaultAddress !== null)
    || (account.accountKind === 'SUBACCOUNT' && vaultAddress !== account.tradingAccount)) {
    throw new Error('vault context does not match the trading account');
  }
  return Object.freeze({ input, account, agentWallet, vaultAddress });
}

function validateReceipt(
  receipt: HyperliquidJournalReceipt,
  validated: ValidatedSubmission,
  status: HyperliquidJournalStatus,
  previousVersion?: bigint,
): void {
  const record = receipt.record;
  if (receipt.journalVersion < 0n
    || (previousVersion !== undefined && receipt.journalVersion <= previousVersion)
    || record.status !== status
    || record.attemptId !== validated.input.attemptId
    || record.agentWallet !== validated.agentWallet
    || record.signerLeaseId !== validated.input.signerLeaseId
    || record.nonce !== validated.input.nonce
    || record.expiresAfterMs !== validated.input.plan.requestExpiryMs
    || record.vaultAddress !== validated.vaultAddress
    || record.account.masterAccount !== validated.account.masterAccount
    || record.account.tradingAccount !== validated.account.tradingAccount
    || record.account.accountKind !== validated.account.accountKind
    || !sameAction(record.action, validated.input.plan.unsignedRequestFields.action)
    || record.actionCommitmentScheme !== HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME
    || !sameDomain(record.domain, validated.input.plan.domain)
    || !sameCommitments(record.commitments, validated.input.plan.commitments)
    || record.spotClientOrderId.toLowerCase()
      !== validated.input.plan.legs.find((leg) => leg.role === 'SPOT')!.clientOrderId.toLowerCase()
    || record.perpetualClientOrderId.toLowerCase() !== validated.input.plan.legs.find(
      (leg) => leg.role === 'PERPETUAL',
    )!.clientOrderId.toLowerCase()
    || !HASH.test(record.actionHash) || !HASH.test(record.recordHash)
    || (status === 'PREPARED'
      ? record.durableRevision !== null
      : record.durableRevision === null || !IDENTIFIER.test(record.durableRevision))) {
    throw new Error(`journal ${status} receipt does not match the compiled package`);
  }
}

function handoff(record: HyperliquidJournalRecord): HyperliquidReconciliationHandoff {
  if (record.durableRevision === null) throw new Error('reconciliation requires a durable record');
  return Object.freeze({
    collector: HYPERLIQUID_RECONCILIATION_COLLECTOR,
    attemptId: record.attemptId,
    account: record.account,
    actionHash: record.actionHash,
    actionCommitmentScheme: record.actionCommitmentScheme,
    requestCommitment: record.recordHash,
    durableRevision: record.durableRevision,
    spotClientOrderId: record.spotClientOrderId,
    perpetualClientOrderId: record.perpetualClientOrderId,
  });
}

function evidenceBase(
  attemptId: string,
  record: HyperliquidJournalRecord | null,
): HyperliquidSubmissionEvidenceBase {
  return {
    attemptId,
    actionCommitmentScheme: record?.actionCommitmentScheme ?? null,
    actionCommitment: record?.actionHash ?? null,
    requestCommitment: record?.recordHash ?? null,
  };
}

async function reconcile(
  journal: HyperliquidDurableSubmissionJournalPort,
  receipt: HyperliquidJournalReceipt,
  validated: ValidatedSubmission,
): Promise<HyperliquidJournalReceipt> {
  const next = await journal.beginReconciliation({
    expectedVersion: receipt.journalVersion,
    attemptId: validated.input.attemptId,
  });
  validateReceipt(next, validated, 'RECONCILING', receipt.journalVersion);
  return next;
}

export class HyperliquidTestnetPackageSubmissionService {
  readonly #journal: HyperliquidDurableSubmissionJournalPort;
  readonly #submitter: HyperliquidSdkTestnetOrderSubmitter;

  constructor(
    journal: HyperliquidDurableSubmissionJournalPort,
    submitter: HyperliquidSdkTestnetOrderSubmitter,
  ) {
    if (!journal
      || typeof journal.prepare !== 'function'
      || typeof journal.confirmDurable !== 'function'
      || typeof journal.markSubmittedUnknown !== 'function'
      || typeof journal.acknowledge !== 'function'
      || typeof journal.reject !== 'function'
      || typeof journal.beginReconciliation !== 'function') {
      throw new Error('a complete durable Hyperliquid journal port is required');
    }
    if (!(submitter instanceof HyperliquidSdkTestnetOrderSubmitter)
      || submitter.environment !== 'testnet'
      || submitter.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('submission client is not exact Hyperliquid Testnet');
    }
    this.#journal = journal;
    this.#submitter = submitter;
  }

  async submitPackage(
    input: HyperliquidPackageSubmissionInput,
  ): Promise<HyperliquidPackageSubmissionResult> {
    let validated: ValidatedSubmission;
    try {
      validated = validateInput(input);
      if (await this.#submitter.signerAddress() !== validated.agentWallet) {
        throw new Error('injected signer does not match the journal agent wallet');
      }
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input.attemptId, null), status: 'NOT_SUBMITTED',
        evidenceStatus: 'PRECONDITION_REJECTED', errorCommitment: errorCommitment(error),
        settlementStatus: 'NOT_APPLICABLE', reconciliation: null,
      });
    }

    let receipt: HyperliquidJournalReceipt;
    let lastJournalReceipt: HyperliquidJournalReceipt | null = null;
    try {
      const prepared = await this.#journal.prepare({ ...input, account: validated.account,
        agentWallet: validated.agentWallet, vaultAddress: validated.vaultAddress });
      validateReceipt(prepared, validated, 'PREPARED', input.expectedVersion);
      lastJournalReceipt = prepared;
      const durable = await this.#journal.confirmDurable({
        expectedVersion: prepared.journalVersion,
        attemptId: input.attemptId,
        recordHash: prepared.record.recordHash,
      });
      validateReceipt(durable, validated, 'DURABLE_RECORD_CONFIRMED', prepared.journalVersion);
      lastJournalReceipt = durable;
      receipt = await this.#journal.markSubmittedUnknown({
        expectedVersion: durable.journalVersion,
        attemptId: input.attemptId,
        nowMs: input.nowMs,
      });
      validateReceipt(receipt, validated, 'SUBMITTED_UNKNOWN', durable.journalVersion);
      lastJournalReceipt = receipt;
    } catch (error) {
      return Object.freeze({
        ...evidenceBase(input.attemptId, lastJournalReceipt?.record ?? null), status: 'NOT_SUBMITTED',
        evidenceStatus: 'JOURNAL_REJECTED', errorCommitment: errorCommitment(error),
        settlementStatus: 'NOT_APPLICABLE', reconciliation: null,
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
      validateReceipt(acknowledged, validated, 'ACKNOWLEDGED', receipt.journalVersion);
      const reconciling = await reconcile(this.#journal, acknowledged, validated);
      return Object.freeze({
        ...evidenceBase(input.attemptId, reconciling.record), status: 'SUBMISSION_ACKNOWLEDGED',
        evidenceStatus: 'SUBMISSION_EVIDENCE_ONLY', responseCommitment,
        settlementStatus: 'RECONCILIATION_REQUIRED', reconciliation: handoff(reconciling.record),
      });
    } catch (error) {
      const knownRejection = error instanceof ApiRequestError
        || error instanceof AbstractWalletError || error instanceof ValidationError;
      try {
        if (knownRejection) {
          const rejected = await this.#journal.reject({
            expectedVersion: receipt.journalVersion,
            attemptId: input.attemptId,
            rejectionId: errorCommitment(error),
          });
          validateReceipt(rejected, validated, 'REJECTED', receipt.journalVersion);
          const reconciling = await reconcile(this.#journal, rejected, validated);
          return Object.freeze({
            ...evidenceBase(input.attemptId, reconciling.record), status: 'SUBMISSION_REJECTED',
            evidenceStatus: error instanceof AbstractWalletError
              ? 'SIGNER_REJECTED'
              : error instanceof ValidationError ? 'CLIENT_REJECTED' : 'VENUE_REJECTED',
            errorCommitment: errorCommitment(error),
            settlementStatus: 'RECONCILIATION_REQUIRED',
            reconciliation: handoff(reconciling.record),
          });
        }
        const reconciling = await reconcile(this.#journal, receipt, validated);
        return Object.freeze({
          ...evidenceBase(input.attemptId, reconciling.record), status: 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: 'RESPONSE_UNKNOWN', errorCommitment: errorCommitment(error),
          settlementStatus: 'RECONCILIATION_REQUIRED',
          reconciliation: handoff(reconciling.record),
        });
      } catch (journalError) {
        return Object.freeze({
          ...evidenceBase(input.attemptId, receipt.record), status: 'SUBMISSION_AMBIGUOUS',
          evidenceStatus: 'RESPONSE_UNKNOWN',
          errorCommitment: commitment({ submission: errorCommitment(error),
            journal: errorCommitment(journalError) }),
          settlementStatus: 'RECONCILIATION_REQUIRED', reconciliation: handoff(receipt.record),
        });
      }
    }
  }
}

export {
  HyperliquidSqliteDurableJournal,
  type HyperliquidSqliteJournalOptions,
} from './hyperliquid-sqlite-journal.js';
export {
  AtomicRouteDecisionError,
  planAtomicEntryRoute,
  type AtomicRouteCandidate,
  type AtomicRouteCandidateProvider,
  type AtomicRouteDecision,
  type AtomicRouteDecisionRecord,
  type AtomicRouteEligibleDecision,
  type AtomicRoutePlanInput,
  type AtomicRouteRejectedDecision,
  type AtomicRouteRejectionReason,
} from './atomic-route-decision.js';
export {
  SignedAtomicEntryQuoteError,
  signAtomicEntryQuote,
  type AtomicEntryQuoteTerms,
  type Ed25519AtomicQuoteSigner,
  type SignedAtomicEntryQuote,
  type SignedAtomicEntryQuoteCode,
  type SignedAtomicEntryQuoteInput,
} from './signed-atomic-entry-quote.js';
export {
  InternalAtomicQuoteError,
  InMemoryInternalAtomicQuoteStore,
  createInternalAtomicQuoteCoordinator,
  createInternalAtomicQuoteRequestHandler,
  createInternalAtomicQuoteServer,
  type InternalAtomicQuoteDependencies,
  type InternalAtomicQuoteOrderProvider,
  type InternalAtomicQuotePort,
  type InternalAtomicQuoteRequest,
  type InternalAtomicQuoteResponse,
  type InternalAtomicQuoteStore,
  type InternalAtomicQuoteTermsProvider,
  type StoredInternalAtomicQuote,
} from './internal-atomic-quote-server.js';
export { HttpInternalOrderProvider } from './http-internal-order-provider.js';
export {
  SqliteAtomicQuoteNonceSource,
  SqliteInternalAtomicQuoteStore,
} from './internal-atomic-quote-sqlite-store.js';
export {
  HttpSelectedSolanaAdmissionProvider,
  SolanaExecutionAuthorizationError,
  SolanaExecutionAuthorizationService,
  SqliteSolanaExecutionAuthorizationStore,
  type SelectedSolanaAdmissionProvider,
  type SolanaExecutionAuthorization,
  type SolanaExecutionAuthorizationCompiler,
  type SolanaExecutionAuthorizationPayload,
  type SolanaExecutionAuthorizationPort,
  type SolanaExecutionAuthorizationRecord,
  type SolanaExecutionAuthorizationRequest,
  type SolanaExecutionAuthorizationStore,
  type SolanaExecutionSigner,
} from './solana-execution-authorization.js';
export {
  InMemoryAtomicQuoteNonceSource,
  createConfiguredAtomicMarketProviders,
  type AtomicQuoteNonceSource,
  type ConfiguredAtomicFeeSchedule,
  type ConfiguredAtomicMarketInput,
  type ConfiguredAtomicMarketLeg,
  type ConfiguredAtomicMarketProviders,
} from './configured-atomic-market.js';
export {
  createLocalAtomicMarketRuntime,
  type LocalAtomicMarketRuntime,
} from './local-atomic-market-runtime.js';
export {
  composeQuoteProviders,
  createHyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteLeg,
  type HyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteRuntimeInput,
  type HyperliquidTestnetRecoveryIdentity,
} from './hyperliquid-testnet-quote-runtime.js';
export {
  HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV,
  loadHyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteConfigDependencies,
} from './hyperliquid-testnet-quote-config.js';
export {
  HyperliquidTestnetRuntimeCoordinator,
  type HandoffBearingSubmission,
  type HyperliquidTestnetPackageSubmissionPort,
  type HyperliquidTestnetRuntimeCoordinatorInput,
  type HyperliquidTestnetRuntimeCoordinatorResult,
  type HyperliquidTestnetRuntimeEvidenceWindow,
  type HyperliquidTestnetRuntimeMarketBinding,
  type HyperliquidTestnetRuntimePrepareInput,
  type HyperliquidTestnetRuntimePrepareResult,
  type HyperliquidTestnetRuntimeRawCommitment,
  type HyperliquidTestnetStructuralEvidencePort,
  type NotSubmittedSubmission,
} from './hyperliquid-testnet-runtime.js';
export {
  HyperliquidTestnetHttpStructuralEvidence,
  SOLVER_TESTNET_EVIDENCE_PREPARE_PATH,
  SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH,
  createHyperliquidTestnetLoopbackCoordinator,
  type HyperliquidTestnetEvidenceHttpOptions,
  type HyperliquidTestnetLoopbackCoordinatorOptions,
} from './hyperliquid-testnet-evidence-http.js';
export {
  SOLVER_TESTNET_EXECUTE_PATH,
  HyperliquidTestnetExecutorError,
  createHyperliquidTestnetExecutor,
  createHyperliquidTestnetExecutorRequestHandler,
  createHyperliquidTestnetExecutorServer,
  validateHyperliquidTestnetRuntimeAttempt,
  type HyperliquidTestnetExecutorPort,
  type HyperliquidTestnetExecutorRequest,
  type HyperliquidTestnetExecutorResult,
  type HyperliquidTestnetExecutorRuntime,
  type HyperliquidTestnetExecutorRuntimeFactory,
  type HyperliquidTestnetAttemptHandoff,
  type HyperliquidTestnetTrustedAttemptProvider,
} from './hyperliquid-testnet-executor-http.js';
export {
  API_HYPERLIQUID_TESTNET_ATTEMPT_PATH,
  HttpHyperliquidTestnetTrustedAttemptProvider,
  type HyperliquidTestnetAttemptHttpOptions,
} from './hyperliquid-testnet-attempt-http.js';
export {
  HYPERLIQUID_TESTNET_EXECUTION_ENABLED_ENV,
  loadHyperliquidTestnetExecutorRuntime,
  type HyperliquidTestnetExecutorRuntimeDependencies,
  type HyperliquidTestnetExecutorRuntimeStatus,
  type LoadedHyperliquidTestnetExecutorRuntime,
} from './hyperliquid-testnet-executor-runtime.js';
export { loadHyperliquidTestnetAgentSigner } from './hyperliquid-testnet-agent-key.js';

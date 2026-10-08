import {
  parseProtocolJson,
  stringifyProtocolJson,
} from '@naryx/protocol-types';
import type {
  HyperliquidReconciliationHandoff,
  HyperliquidNettingResidualReconciliationHandoff,
  HyperliquidStrategyReconciliationHandoff,
} from './index.js';
import type {
  HyperliquidNettingResidualObservation,
  HyperliquidNettingResidualPlan,
  HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import type { HyperliquidStrategyEvidenceBinding } from './hyperliquid-strategy-testnet-runtime.js';
import {
  HyperliquidTestnetRuntimeCoordinator,
  type HyperliquidTestnetPackageSubmissionPort,
  type HyperliquidTestnetRuntimeMarketBinding,
  type HyperliquidTestnetRuntimeEvidenceWindow,
  type HyperliquidTestnetRuntimePrepareInput,
  type HyperliquidTestnetRuntimePrepareResult,
  type HyperliquidTestnetRuntimeRawCommitment,
  type HyperliquidTestnetStructuralEvidencePort,
} from './hyperliquid-testnet-runtime.js';

// Paths must match the keeper evidence HTTP boundary. They are duplicated
// here because a service never imports another service's internals.
export const SOLVER_TESTNET_EVIDENCE_PREPARE_PATH =
  '/internal/keeper/hyperliquid-testnet/prepare';
export const SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH =
  '/internal/keeper/hyperliquid-testnet/reconcile';
export const SOLVER_TESTNET_STRATEGY_EVIDENCE_RECONCILE_PATH =
  '/internal/keeper/hyperliquid-testnet/strategy/reconcile';
export const SOLVER_TESTNET_NETTING_RESIDUAL_EVIDENCE_RECONCILE_PATH =
  '/internal/keeper/hyperliquid-testnet/netting-residual/reconcile';

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export interface HyperliquidTestnetEvidenceHttpOptions {
  readonly keeperOrigin: string;
  readonly timeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export interface HyperliquidTestnetLoopbackCoordinatorOptions
  extends HyperliquidTestnetEvidenceHttpOptions {
  readonly enabled: boolean;
}

export interface HyperliquidStrategyEvidenceLeg {
  readonly legId: string;
  readonly clientOrderId: `0x${string}`;
  readonly plannedSignedBaseAtoms: bigint;
  readonly filledSignedBaseAtoms: bigint;
  readonly terminalStatus: 'FILLED' | 'UNFILLED_IOC_CANCELLED'
    | 'PARTIALLY_FILLED_IOC_CANCELLED' | 'REJECTED' | 'UNKNOWN';
  readonly openOrderStatus: 'NONE' | 'OPEN' | 'UNKNOWN';
  readonly orderId: number | null;
  readonly fillCount: number;
  readonly grossQuoteAtoms: bigint;
  readonly feeAssetId: string;
  readonly feeAssetDecimals: number;
  readonly feeAtoms: bigint;
  readonly venueFeeQuoteAtoms: bigint;
  readonly observedAtMs: number | null;
}

export type HyperliquidStrategyEvidenceResult = Readonly<{
  status: 'COMPLETE';
  outcome: 'COMPLETED' | 'NO_EFFECT' | 'RECOVERY_REQUIRED' | 'MANUAL_INTERVENTION';
  reasons: readonly string[];
  observedAtMs: number;
  legs: readonly HyperliquidStrategyEvidenceLeg[];
  rawResponseCommitments: readonly unknown[];
}> | Readonly<{
  status: 'INCOMPLETE';
  outcome: null;
  reasons: readonly string[];
  observedAtMs: number | null;
  legs: readonly HyperliquidStrategyEvidenceLeg[];
  rawResponseCommitments: readonly unknown[];
}>;

export interface HyperliquidStrategyEvidenceCollectInput {
  readonly handoff: HyperliquidStrategyReconciliationHandoff;
  readonly binding: HyperliquidStrategyEvidenceBinding;
  readonly plan: HyperliquidStrategyExecutionPlan;
  readonly window: HyperliquidTestnetRuntimeEvidenceWindow;
}

export interface HyperliquidNettingResidualEvidenceBinding {
  readonly assetId: number;
  readonly marketKind: 'SPOT' | 'PERPETUAL';
  readonly baseFeeToken: string;
  readonly quoteFeeToken: string;
}

export interface HyperliquidNettingResidualEvidenceCollectInput {
  readonly handoff: HyperliquidNettingResidualReconciliationHandoff;
  readonly binding: HyperliquidNettingResidualEvidenceBinding;
  readonly plan: HyperliquidNettingResidualPlan;
  readonly window: HyperliquidTestnetRuntimeEvidenceWindow;
}

export type HyperliquidNettingResidualEvidenceResult = Readonly<{
  status: 'COMPLETE';
  observation: HyperliquidNettingResidualObservation;
  rawResponseCommitments: readonly unknown[];
}> | Readonly<{
  status: 'INCOMPLETE';
  observation: null;
  reasons: readonly string[];
  rawResponseCommitments: readonly unknown[];
}>;

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function requireLoopbackKeeperOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('keeper evidence origin must be an absolute URL');
  }
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)
    || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('keeper evidence origin must be a loopback HTTP origin');
  }
  return url.origin;
}

function checkedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('keeper evidence timeout must be a bounded positive integer');
  }
  return timeoutMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedProtocolJson(response: Response, context: string): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json' || response.body === null) {
    throw new Error('keeper evidence response is invalid');
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null
    && (!/^\d+$/.test(statedLength) || Number(statedLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('keeper evidence response is invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('keeper evidence response is invalid');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('keeper evidence response is invalid');
  }
  try {
    return parseProtocolJson(text, context);
  } catch {
    throw new Error('keeper evidence response is invalid');
  }
}

function decodePrepareResult(value: unknown): HyperliquidTestnetRuntimePrepareResult<unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('keeper evidence prepare result is invalid');
  }
  if (value.status === 'PREPARED') {
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'state' || keys[1] !== 'status') {
      throw new Error('keeper evidence prepare result is invalid');
    }
    if (!isRecord(value.state)) {
      throw new Error('keeper evidence prepare result is invalid');
    }
    return Object.freeze({ status: 'PREPARED' as const, state: value.state });
  }
  if (value.status === 'CHECKPOINT_INCOMPLETE') {
    const keys = Object.keys(value).sort();
    if (keys.length !== 3 || keys[0] !== 'rawResponseCommitments'
      || keys[1] !== 'reasons' || keys[2] !== 'status') {
      throw new Error('keeper evidence prepare result is invalid');
    }
    if (!Array.isArray(value.reasons) || !Array.isArray(value.rawResponseCommitments)) {
      throw new Error('keeper evidence prepare result is invalid');
    }
    return Object.freeze({
      status: 'CHECKPOINT_INCOMPLETE' as const,
      reasons: Object.freeze([...value.reasons] as readonly string[]),
      rawResponseCommitments: Object.freeze(
        [...value.rawResponseCommitments] as readonly HyperliquidTestnetRuntimeRawCommitment[],
      ),
    });
  }
  throw new Error('keeper evidence prepare result is invalid');
}

function decodeReconcileResult(value: unknown): unknown {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new Error('keeper evidence reconcile result is invalid');
  }
  if (value.status !== 'RECONCILED'
    && value.status !== 'EVIDENCE_INCOMPLETE'
    && value.status !== 'HANDOFF_REJECTED') {
    throw new Error('keeper evidence reconcile result is invalid');
  }
  return value;
}

function decodeStrategyReconcileResult(value: unknown): HyperliquidStrategyEvidenceResult {
  if (!isRecord(value) || (value.status !== 'COMPLETE' && value.status !== 'INCOMPLETE')
    || !Array.isArray(value.reasons) || !Array.isArray(value.legs)
    || !Array.isArray(value.rawResponseCommitments)) {
    throw new Error('keeper strategy evidence result is invalid');
  }
  if (value.status === 'COMPLETE'
    && value.outcome !== 'COMPLETED' && value.outcome !== 'NO_EFFECT'
    && value.outcome !== 'RECOVERY_REQUIRED' && value.outcome !== 'MANUAL_INTERVENTION') {
    throw new Error('keeper strategy evidence result is invalid');
  }
  if (value.status === 'INCOMPLETE' && value.outcome !== null) {
    throw new Error('keeper strategy evidence result is invalid');
  }
  if ((value.status === 'COMPLETE'
      && (typeof value.observedAtMs !== 'number' || !Number.isSafeInteger(value.observedAtMs)
        || value.observedAtMs <= 0))
    || (value.status === 'INCOMPLETE' && value.observedAtMs !== null
      && (typeof value.observedAtMs !== 'number' || !Number.isSafeInteger(value.observedAtMs)
        || value.observedAtMs <= 0))) {
    throw new Error('keeper strategy evidence result is invalid');
  }
  for (const leg of value.legs) {
    if (!isRecord(leg) || typeof leg.legId !== 'string'
      || typeof leg.clientOrderId !== 'string'
      || typeof leg.plannedSignedBaseAtoms !== 'bigint'
      || typeof leg.filledSignedBaseAtoms !== 'bigint'
      || typeof leg.terminalStatus !== 'string'
      || typeof leg.openOrderStatus !== 'string'
      || (leg.orderId !== null && typeof leg.orderId !== 'number')
      || typeof leg.fillCount !== 'number'
      || typeof leg.grossQuoteAtoms !== 'bigint'
      || typeof leg.feeAssetId !== 'string'
      || typeof leg.feeAssetDecimals !== 'number'
      || typeof leg.feeAtoms !== 'bigint'
      || typeof leg.venueFeeQuoteAtoms !== 'bigint'
      || (leg.observedAtMs !== null && typeof leg.observedAtMs !== 'number')) {
      throw new Error('keeper strategy evidence result is invalid');
    }
  }
  return value as unknown as HyperliquidStrategyEvidenceResult;
}

function decodeNettingResidualReconcileResult(
  value: unknown,
): HyperliquidNettingResidualEvidenceResult {
  if (!isRecord(value) || (value.status !== 'COMPLETE' && value.status !== 'INCOMPLETE')
    || !Array.isArray(value.rawResponseCommitments)) {
    throw new Error('keeper netting residual evidence result is invalid');
  }
  if (value.status === 'INCOMPLETE') {
    if (value.observation !== null || !Array.isArray(value.reasons)
      || value.reasons.some((reason) => typeof reason !== 'string')) {
      throw new Error('keeper netting residual evidence result is invalid');
    }
    return value as unknown as HyperliquidNettingResidualEvidenceResult;
  }
  if (!isRecord(value.observation) || 'reasons' in value
    || typeof value.observation.clientOrderId !== 'string'
    || !/^0x[0-9a-f]{32}$/.test(value.observation.clientOrderId)
    || !['FILLED', 'PARTIALLY_FILLED_IOC_CANCELLED', 'UNFILLED_IOC_CANCELLED', 'REJECTED']
      .includes(String(value.observation.terminalStatus))
    || typeof value.observation.filledSignedQuantityAtoms !== 'bigint'
    || typeof value.observation.grossQuoteAtoms !== 'bigint'
    || typeof value.observation.feeQuoteAtoms !== 'bigint'
    || typeof value.observation.submittedAtMs !== 'bigint'
    || typeof value.observation.observedAtMs !== 'bigint'
    || typeof value.observation.executionReferenceHash !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(value.observation.executionReferenceHash)
    || typeof value.observation.authoritativeEvidenceHash !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(value.observation.authoritativeEvidenceHash)) {
    throw new Error('keeper netting residual evidence result is invalid');
  }
  return value as unknown as HyperliquidNettingResidualEvidenceResult;
}

async function postProtocolJson(
  origin: string,
  path: string,
  body: unknown,
  context: string,
  timeoutMs: number,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  let payload: string;
  try {
    payload = stringifyProtocolJson(body, context);
  } catch {
    throw new Error('keeper evidence request is invalid');
  }
  let response: Response;
  try {
    response = await fetchImplementation(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('keeper evidence request failed');
  }
  if (!response.ok) {
    throw new Error(`keeper evidence request failed with HTTP ${response.status}`);
  }
  try {
    return await readBoundedProtocolJson(response, context);
  } catch {
    throw new Error('keeper evidence request failed');
  }
}

// Stateless loopback client for the keeper Hyperliquid Testnet evidence
// boundary. Prepared and reconciliation payloads stay opaque: Testnet domain,
// IOC, commitment, and handoff semantics are enforced by the solver runtime
// coordinator, the durable submission journal, and the keeper runtime. This
// client only enforces the transport shape. It holds no signer, key, secret,
// exchange client, retry loop, or mainnet path.
export class HyperliquidTestnetHttpStructuralEvidence
implements HyperliquidTestnetStructuralEvidencePort<unknown, unknown> {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HyperliquidTestnetEvidenceHttpOptions) {
    this.#origin = requireLoopbackKeeperOrigin(options.keeperOrigin);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = checkedTimeout(options.timeoutMs);
  }

  async prepare(
    input: HyperliquidTestnetRuntimePrepareInput,
  ): Promise<HyperliquidTestnetRuntimePrepareResult<unknown>> {
    const body = {
      account: input.account,
      attemptId: input.attemptId,
      binding: input.binding,
      plan: input.plan,
      window: input.window,
    };
    let decoded: unknown;
    try {
      decoded = await postProtocolJson(
        this.#origin,
        SOLVER_TESTNET_EVIDENCE_PREPARE_PATH,
        body,
        'solver.evidence.prepare',
        this.#timeoutMs,
        this.#fetch,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('keeper evidence request failed')) {
        throw error;
      }
      throw new Error('keeper evidence request failed');
    }
    try {
      return decodePrepareResult(decoded);
    } catch {
      throw new Error('keeper evidence request failed');
    }
  }

  async reconcile(
    prepared: unknown,
    handoff: HyperliquidReconciliationHandoff,
    binding: HyperliquidTestnetRuntimeMarketBinding,
    window: HyperliquidTestnetRuntimeEvidenceWindow,
  ): Promise<unknown> {
    const body = {
      binding,
      handoff,
      prepared,
      window,
    };
    let decoded: unknown;
    try {
      decoded = await postProtocolJson(
        this.#origin,
        SOLVER_TESTNET_EVIDENCE_RECONCILE_PATH,
        body,
        'solver.evidence.reconcile',
        this.#timeoutMs,
        this.#fetch,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('keeper evidence request failed')) {
        throw error;
      }
      throw new Error('keeper evidence request failed');
    }
    try {
      return decodeReconcileResult(decoded);
    } catch {
      throw new Error('keeper evidence request failed');
    }
  }
}

export class HyperliquidStrategyTestnetHttpEvidence {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HyperliquidTestnetEvidenceHttpOptions) {
    this.#origin = requireLoopbackKeeperOrigin(options.keeperOrigin);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = checkedTimeout(options.timeoutMs);
  }

  async collect(input: HyperliquidStrategyEvidenceCollectInput):
  Promise<HyperliquidStrategyEvidenceResult> {
    const body = {
      account: input.handoff.account,
      actionHash: input.handoff.actionHash,
      attemptId: input.handoff.attemptId,
      batchStage: input.handoff.batchStage,
      binding: input.binding,
      clientOrderIds: input.handoff.clientOrderIds,
      durableRevision: input.handoff.durableRevision,
      legIds: input.handoff.legIds,
      plan: input.plan,
      requestCommitment: input.handoff.requestCommitment,
      window: input.window,
    };
    let decoded: unknown;
    try {
      decoded = await postProtocolJson(
        this.#origin,
        SOLVER_TESTNET_STRATEGY_EVIDENCE_RECONCILE_PATH,
        body,
        'solver.strategy.evidence.reconcile',
        this.#timeoutMs,
        this.#fetch,
      );
    } catch {
      throw new Error('keeper strategy evidence request failed');
    }
    try {
      return decodeStrategyReconcileResult(decoded);
    } catch {
      throw new Error('keeper strategy evidence request failed');
    }
  }
}

export class HyperliquidNettingResidualTestnetHttpEvidence {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HyperliquidTestnetEvidenceHttpOptions) {
    this.#origin = requireLoopbackKeeperOrigin(options.keeperOrigin);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = checkedTimeout(options.timeoutMs);
  }

  async collect(input: HyperliquidNettingResidualEvidenceCollectInput):
  Promise<HyperliquidNettingResidualEvidenceResult> {
    const body = {
      account: input.handoff.account,
      actionHash: input.handoff.actionHash,
      attemptId: input.handoff.attemptId,
      binding: input.binding,
      clientOrderId: input.handoff.clientOrderId,
      durableRevision: input.handoff.durableRevision,
      instrumentHash: input.handoff.instrumentHash,
      intentHash: input.handoff.intentHash,
      plan: input.plan,
      requestCommitment: input.handoff.requestCommitment,
      window: input.window,
    };
    let decoded: unknown;
    try {
      decoded = await postProtocolJson(
        this.#origin,
        SOLVER_TESTNET_NETTING_RESIDUAL_EVIDENCE_RECONCILE_PATH,
        body,
        'solver.netting-residual.evidence.reconcile',
        this.#timeoutMs,
        this.#fetch,
      );
    } catch {
      throw new Error('keeper netting residual evidence request failed');
    }
    try {
      return decodeNettingResidualReconcileResult(decoded);
    } catch {
      throw new Error('keeper netting residual evidence request failed');
    }
  }
}

// No attempt resolver is introduced. The coordinator plus the injected
// durable submission journal own the attempt lifecycle (prepare, durable
// confirm, submitted-unknown, acknowledge/reject, reconcile). The evidence
// client is stateless and only forwards the coordinator's exact inputs.

// Composes the existing solver Testnet runtime with the loopback evidence
// client. Disabled (null) unless explicitly enabled, so no keeper traffic
// exists by default. The submission port stays injected: this factory never
// creates a signer, journal, or exchange transport.
export function createHyperliquidTestnetLoopbackCoordinator(
  submission: HyperliquidTestnetPackageSubmissionPort,
  options: HyperliquidTestnetLoopbackCoordinatorOptions,
): HyperliquidTestnetRuntimeCoordinator<unknown, unknown> | null {
  if (options.enabled !== true) return null;
  const evidence = new HyperliquidTestnetHttpStructuralEvidence(options);
  return new HyperliquidTestnetRuntimeCoordinator(evidence, submission);
}

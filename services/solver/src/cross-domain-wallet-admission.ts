import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import {
  encodeEvmMultiStrategyAccountExecution, encodeEvmMultiStrategyAccountRecovery,
  evmMultiStrategyCallsHash, evmMultiStrategyExecutionHash, isCanonicalEvmSignature,
  type EvmMultiStrategyAccountEnvelope,
} from '@naryx/adapter-evm';
import {
  crossDomainCompensationAction, crossDomainCompensationActionHash, crossDomainPlanHash,
  commitmentHash, bytesEqual, parseProtocolJson, stringifyProtocolJson, toHex, type CrossDomainPlanInput,
} from '@naryx/protocol-types';
import { getAddress, hashTypedData, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { validateCrossDomainJob, type CrossDomainJob } from './cross-domain-job-store.js';
import type { PreparedStrategyExecutionTransport } from './strategy-execution-transport.js';

export interface CrossDomainWalletDraft {
  readonly version: 1;
  readonly owner: Address;
  readonly execution: Omit<PreparedStrategyExecutionTransport, 'crossDomainPlanHash'>;
  readonly plan: Omit<CrossDomainPlanInput, 'legs'>;
  readonly lanes: readonly {
    readonly domainId: string;
    readonly inventoryReservationId: Hex;
    readonly interimExposureQuoteAtoms: bigint;
    readonly recovery: EvmMultiStrategyAccountEnvelope;
    readonly maximumRecoveryCostQuoteAtoms: bigint;
    readonly executorClassId: string;
    readonly executorClassVersion: number;
    readonly executorClassManifestHash: Uint8Array | string;
  }[];
}

export interface CrossDomainWalletSignatures {
  readonly draftId: string;
  readonly signatures: readonly { readonly domainId: string; readonly entry: Hex; readonly recovery: Hex }[];
}

export interface CrossDomainWalletAdmissionPort {
  prepare(request: unknown): Promise<CrossDomainWalletDraft>;
  signSolver(envelope: EvmMultiStrategyAccountEnvelope): Promise<Hex>;
  validate(draft: CrossDomainWalletDraft, job: CrossDomainJob): Promise<void>;
  reserve(draftId: string, draft: CrossDomainWalletDraft, job: CrossDomainJob): Promise<boolean>;
  release(draftId: string, draft: CrossDomainWalletDraft, job: CrossDomainJob): Promise<boolean>;
  admit(job: CrossDomainJob): Promise<{ planHash: string; admittedPlanHash: string }>;
  status(planHash: string): unknown;
  now(): bigint;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cross-chain approval refused: ${message}`);
}

function exactKeys(value: object, keys: readonly string[]) {
  requireCondition(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'unknown preparation fields');
}

function typedData(envelope: EvmMultiStrategyAccountEnvelope, chainId: number, primaryType: 'OwnerExecution' | 'SolverExecution') {
  const executionHash = evmMultiStrategyExecutionHash(envelope.execution);
  const callsHash = evmMultiStrategyCallsHash(envelope.calls);
  requireCondition(envelope.executionHash === executionHash && envelope.callsHash === callsHash,
    'prepared execution commitments changed');
  return {
    domain: { name: 'Naryx Multi Strategy Account', version: '1', chainId, verifyingContract: envelope.account },
    primaryType,
    types: { [primaryType]: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
    message: { executionHash, callsHash },
  } as const;
}

export function validateCrossDomainWalletDraft(draft: CrossDomainWalletDraft): void {
  exactKeys(draft, ['version', 'owner', 'execution', 'plan', 'lanes']);
  exactKeys(draft.plan, ['planVersion', 'environment', 'orderHash', 'quoteHash', 'routeHash', 'timeUnit',
    'prepareDeadline', 'commitDeadline', 'compensationDeadline', 'maximumInterimExposureQuoteAtoms']);
  exactKeys(draft.execution, ['version', 'identity', 'settlementClass', 'coordination', 'orderHash', 'graphHash', 'quoteHash', 'routeHash', 'domains']);
  requireCondition(draft.version === 1 && draft.plan.planVersion === 2 && draft.plan.environment === 'testnet'
    && draft.plan.timeUnit === 'EVM_UNIX_SECONDS' && draft.execution.version === 1
    && draft.execution.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED'
    && draft.execution.coordination === 'CROSS_DOMAIN_PREPOSITIONED', 'unsupported draft');
  requireCondition(draft.execution.domains.length === 2 && draft.lanes.length === 2, 'exactly two domains are required');
  const domains = new Set<string>(draft.execution.domains.map(domain => domain.domain.domainId));
  requireCondition(domains.size === 2 && domains.has('eip155:84532') && domains.has('eip155:421614'), 'only the approved testnets are supported');
  requireCondition(getAddress(draft.owner) !== '0x0000000000000000000000000000000000000000', 'owner is zero');
  requireCondition(draft.plan.prepareDeadline > 0n && draft.plan.prepareDeadline < draft.plan.commitDeadline
    && draft.plan.commitDeadline < draft.plan.compensationDeadline
    && draft.plan.compensationDeadline - draft.plan.prepareDeadline <= 86_400n, 'invalid preparation or recovery window');
  for (const field of ['orderHash', 'quoteHash', 'routeHash'] as const) {
    requireCondition(bytesEqual(commitmentHash(draft.plan[field]), draft.execution[field]), 'plan binds another execution');
  }
  const legIds: string[] = [];
  for (const domain of draft.execution.domains) {
    requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported execution account');
    legIds.push(...domain.legIds);
    const lanes = draft.lanes.filter(lane => lane.domainId === domain.domain.domainId);
    requireCondition(lanes.length === 1, 'missing or repeated recovery domain');
    const lane = lanes[0]!;
    exactKeys(lane, ['domainId', 'inventoryReservationId', 'interimExposureQuoteAtoms', 'recovery',
      'maximumRecoveryCostQuoteAtoms', 'executorClassId', 'executorClassVersion', 'executorClassManifestHash']);
    requireCondition(lane.interimExposureQuoteAtoms > 0n && lane.maximumRecoveryCostQuoteAtoms >= 0n,
      'invalid exposure or recovery cap');
    const chainId = Number(domain.domain.domainId.slice(7));
    for (const envelope of [domain.envelope, lane.recovery]) {
      exactKeys(envelope, ['account', 'execution', 'calls', 'executionHash', 'callsHash', 'ownerTypedData', 'solverTypedData', 'ownerDigest', 'solverDigest']);
      requireCondition(getAddress(envelope.account) === getAddress(domain.envelope.account)
        && hashTypedData(typedData(envelope, chainId, 'OwnerExecution')) === envelope.ownerDigest
        && hashTypedData(envelope.ownerTypedData) === envelope.ownerDigest,
      'wallet typed data differs from the actual contract authorization');
    }
    requireCondition(hashTypedData(typedData(domain.envelope, chainId, 'SolverExecution')) === domain.envelope.solverDigest
      && hashTypedData(domain.envelope.solverTypedData) === domain.envelope.solverDigest, 'solver typed data differs from the contract authorization');
    requireCondition(domain.envelope.execution.orderHash === `0x${toHex(draft.execution.orderHash)}`
      && domain.envelope.execution.quoteHash === `0x${toHex(draft.execution.quoteHash)}`
      && domain.envelope.execution.routeHash === `0x${toHex(draft.execution.routeHash)}`
      && domain.envelope.execution.graphHash === `0x${toHex(draft.execution.graphHash)}`
      && domain.envelope.execution.deadline === draft.plan.commitDeadline
      && lane.recovery.execution.deadline === draft.plan.compensationDeadline,
    'prepared domain binds another package');
  }
  requireCondition(legIds.length > 0 && new Set(legIds).size === legIds.length, 'execution repeats a leg across domains');
  requireCondition(draft.lanes.reduce((sum, lane) => sum + lane.interimExposureQuoteAtoms, 0n)
    <= draft.plan.maximumInterimExposureQuoteAtoms, 'interim exposure exceeds the package cap');
}

export async function authorizeCrossDomainWalletDraft(
  draft: CrossDomainWalletDraft, input: CrossDomainWalletSignatures,
  signSolver: CrossDomainWalletAdmissionPort['signSolver'],
): Promise<CrossDomainJob> {
  validateCrossDomainWalletDraft(draft);
  requireCondition(Array.isArray(input.signatures) && input.signatures.length === 2, 'both chains need entry and recovery approval');
  // Validate every owner signature before requesting any solver authorization.
  for (const domain of draft.execution.domains) {
    requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported execution');
    const signatures = input.signatures.filter(signature => signature.domainId === domain.domain.domainId);
    requireCondition(signatures.length === 1, 'signature domains are missing or repeated');
    const signature = signatures[0]!;
    const lane = draft.lanes.find(candidate => candidate.domainId === domain.domain.domainId)!;
    for (const [envelope, value] of [[domain.envelope, signature.entry], [lane.recovery, signature.recovery]] as const) {
      requireCondition(isCanonicalEvmSignature(value), 'invalid wallet signature');
      const signer = await recoverTypedDataAddress({ ...typedData(envelope, Number(domain.domain.domainId.slice(7)), 'OwnerExecution'), signature: value });
      requireCondition(getAddress(signer) === getAddress(draft.owner), 'signature belongs to another owner');
    }
  }
  const authorizations: CrossDomainJob['authorizations'][number][] = [];
  const compensations = [];
  const legs = [];
  for (const domain of draft.execution.domains) {
    requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported execution');
    const lane = draft.lanes.find(candidate => candidate.domainId === domain.domain.domainId)!;
    const signatures = input.signatures.find(signature => signature.domainId === domain.domain.domainId)!;
    const envelope = domain.envelope;
    const chainId = Number(domain.domain.domainId.slice(7));
    const solverSignature = await signSolver(envelope);
    requireCondition(isCanonicalEvmSignature(solverSignature)
      && getAddress(await recoverTypedDataAddress({ ...typedData(envelope, chainId, 'SolverExecution'), signature: solverSignature }))
        === getAddress(envelope.execution.solver), 'invalid solver authorization');
    const recovery = { envelope: lane.recovery, ownerSignature: signatures.recovery };
    const compensation = crossDomainCompensationAction({
      actionVersion: 1, environment: 'testnet', orderHash: draft.execution.orderHash,
      quoteHash: draft.execution.quoteHash, routeHash: draft.execution.routeHash,
      domain: domain.domain, legIds: domain.legIds, inventoryReservationId: lane.inventoryReservationId,
      actionKind: 'REVERSE_FILLED_LEGS', executorClassId: lane.executorClassId,
      executorClassVersion: lane.executorClassVersion, executorClassManifestHash: lane.executorClassManifestHash,
      actionPayloadHash: keccak256(encodeEvmMultiStrategyAccountRecovery(recovery)),
      maximumCostQuoteAtoms: lane.maximumRecoveryCostQuoteAtoms,
      expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: draft.plan.compensationDeadline,
    });
    compensations.push(compensation);
    legs.push({ domain: domain.domain, legIds: domain.legIds, inventoryReservationId: lane.inventoryReservationId,
      interimExposureQuoteAtoms: lane.interimExposureQuoteAtoms, compensationActionHash: crossDomainCompensationActionHash(compensation) });
    authorizations.push({ domainId: domain.domain.domainId, recovery, entry: {
      version: 1, domain: domain.domain, chainId, owner: draft.owner, to: envelope.account, value: 0n,
      data: encodeEvmMultiStrategyAccountExecution({ envelope, ownerSignature: signatures.entry, solverSignature }),
      ownerSignature: signatures.entry, solverSignature, packageId: envelope.execution.packageId,
      orderHash: envelope.execution.orderHash, quoteHash: envelope.execution.quoteHash, routeHash: envelope.execution.routeHash,
      expectedNextStateHash: envelope.execution.nextStateHash, deadline: envelope.execution.deadline,
    } });
  }
  const plan: CrossDomainPlanInput = { ...draft.plan, legs };
  const job: CrossDomainJob = { version: 1, bundle: { plan, compensations },
    execution: { ...draft.execution, crossDomainPlanHash: crossDomainPlanHash(plan) }, authorizations };
  validateCrossDomainJob(job);
  return job;
}

type State = 'DRAFT' | 'RESERVING' | 'ADMITTED' | 'RELEASING' | 'EXPIRED';
interface Row { draft_id: string; draft_json: string; job_json: string | null; state: State; plan_hash: string | null }

export class CrossDomainWalletAdmission {
  readonly #db: Database.Database;
  readonly #port: CrossDomainWalletAdmissionPort;
  #busy = false;

  constructor(path: string, port: CrossDomainWalletAdmissionPort) {
    requireCondition(isAbsolute(path), 'durable draft database required');
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS wallet_cross_domain_drafts (
      draft_id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
      draft_json TEXT NOT NULL, job_json TEXT, plan_hash TEXT,
      state TEXT NOT NULL CHECK(state IN ('DRAFT','RESERVING','ADMITTED','RELEASING','EXPIRED')),
      expires_at TEXT NOT NULL
    ) STRICT`);
    this.#port = port;
  }

  close() { this.#db.close(); }

  async prepare(request: unknown) {
    requireCondition(!this.#busy, 'another preparation is in progress; retry');
    this.#busy = true;
    try {
      const requestKey = createHash('sha256').update(stringifyProtocolJson(request)).digest('hex');
      const prior = this.#db.prepare('SELECT * FROM wallet_cross_domain_drafts WHERE request_key = ?').get(requestKey) as Row | undefined;
      if (prior !== undefined) return this.get(prior.draft_id);
      const draft = await this.#port.prepare(request);
      validateCrossDomainWalletDraft(draft);
      requireCondition(draft.plan.prepareDeadline > this.#port.now(), 'preparation expired');
      const json = stringifyProtocolJson(draft);
      requireCondition(Buffer.byteLength(json) <= 1_048_576, 'preparation exceeds size limit');
      const draftId = createHash('sha256').update('NARYX/cross-domain-wallet-draft/v1\0').update(json).digest('hex');
      const owner = getAddress(draft.owner);
      this.#db.transaction(() => {
        this.#db.prepare("UPDATE wallet_cross_domain_drafts SET state = 'EXPIRED' WHERE state = 'DRAFT' AND CAST(expires_at AS INTEGER) <= ?")
          .run(Number(this.#port.now()));
        const active = this.#db.prepare("SELECT draft_id FROM wallet_cross_domain_drafts WHERE owner = ? AND state IN ('DRAFT','RESERVING','RELEASING')").get(owner);
        requireCondition(active === undefined, 'this wallet already has a preparation in progress');
        this.#db.prepare("INSERT INTO wallet_cross_domain_drafts VALUES (?, ?, ?, ?, NULL, NULL, 'DRAFT', ?)")
          .run(draftId, owner, requestKey, json, draft.plan.prepareDeadline.toString());
      })();
      return this.get(draftId);
    } finally { this.#busy = false; }
  }

  get(draftId: string) {
    requireCondition(/^[0-9a-f]{64}$/.test(draftId), 'invalid preparation identifier');
    const row = this.#db.prepare('SELECT * FROM wallet_cross_domain_drafts WHERE draft_id = ?').get(draftId) as Row | undefined;
    if (row === undefined) return undefined;
    const draft = parseProtocolJson(row.draft_json) as CrossDomainWalletDraft;
    const state = row.state === 'DRAFT' && draft.plan.prepareDeadline <= this.#port.now() ? 'EXPIRED' : row.state;
    return { draftId, state, draft, planHash: row.plan_hash,
      job: row.plan_hash === null ? undefined : this.#port.status(row.plan_hash) };
  }

  async authorize(input: CrossDomainWalletSignatures) {
    requireCondition(!this.#busy, 'another approval is in progress; retry');
    this.#busy = true;
    try {
      const current = this.get(input.draftId);
      requireCondition(current !== undefined && current.state !== 'EXPIRED' && current.state !== 'RELEASING', 'preparation unavailable or expired');
      const job = await authorizeCrossDomainWalletDraft(current.draft, input, envelope => this.#port.signSolver(envelope));
      const json = stringifyProtocolJson(job);
      const row = this.#db.prepare('SELECT job_json FROM wallet_cross_domain_drafts WHERE draft_id = ?').get(input.draftId) as Row;
      if (row.job_json !== null) {
        requireCondition(row.job_json === json, 'preparation already has different authorizations');
        return this.get(input.draftId);
      }
      await this.#port.validate(current.draft, job);
      requireCondition(current.draft.plan.prepareDeadline > this.#port.now(), 'preparation expired during approval');
      this.#db.prepare("UPDATE wallet_cross_domain_drafts SET job_json = ?, plan_hash = ?, state = 'RESERVING' WHERE draft_id = ? AND state = 'DRAFT'")
        .run(json, validateCrossDomainJob(job), input.draftId);
      return this.get(input.draftId);
    } finally { this.#busy = false; }
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const rows = this.#db.prepare("SELECT * FROM wallet_cross_domain_drafts WHERE state IN ('RESERVING','RELEASING') LIMIT 32").all() as Row[];
      for (const row of rows) {
        const draft = parseProtocolJson(row.draft_json) as CrossDomainWalletDraft;
        const job = parseProtocolJson(row.job_json!) as CrossDomainJob;
        // Admission may have committed before the process stopped updating this database.
        if (this.#port.status(validateCrossDomainJob(job)) !== undefined) {
          this.#db.prepare("UPDATE wallet_cross_domain_drafts SET state = 'ADMITTED' WHERE draft_id = ?").run(row.draft_id);
          continue;
        }
        if (draft.plan.prepareDeadline <= this.#port.now() || row.state === 'RELEASING') {
          this.#db.prepare("UPDATE wallet_cross_domain_drafts SET state = 'RELEASING' WHERE draft_id = ?").run(row.draft_id);
          if (await this.#port.release(row.draft_id, draft, job)) {
            this.#db.prepare("UPDATE wallet_cross_domain_drafts SET state = 'EXPIRED' WHERE draft_id = ?").run(row.draft_id);
          }
        } else if (await this.#port.reserve(row.draft_id, draft, job)) {
          await this.#port.admit(job);
          this.#db.prepare("UPDATE wallet_cross_domain_drafts SET state = 'ADMITTED' WHERE draft_id = ?").run(row.draft_id);
        }
      }
    } finally { this.#busy = false; }
  }
}

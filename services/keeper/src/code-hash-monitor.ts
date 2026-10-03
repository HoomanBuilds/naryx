import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { protocolId, toHex, type ReadinessDecision } from '@naryx/protocol-types';
import {
  applyDependencyTrigger,
  type DependencyIncidentFileStore,
  type DependencyIncidentJournal,
} from './dependency-incident-engine.js';
import {
  chainIdentity,
  jsonRpc,
  loadKeeperRpcUrls,
  RpcIdentityMismatchError,
  rpcUrl,
  verifyRpcIdentity,
  type ChainIdentity,
  type FetchLike,
} from './chain-identity.js';

const HEX_32 = /^0x[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Upgradeable-loader ProgramData metadata: 4-byte state tag, 8-byte slot, 1-byte option, 32-byte authority. */
const PROGRAM_DATA_METADATA_BYTES = 45;
const PROGRAM_DATA_STATE_TAG = 3;

/**
 * One piece of reviewed code a dependency scope relies on: a verifier, adapter, venue contract,
 * proxy implementation, or program. The expected hash is keccak-256 of the deployed runtime code
 * on EVM, and SHA-256 of a Solana program's executable bytes, trailing zero padding removed, read
 * from its ProgramData account.
 */
export interface CodeWatchTarget {
  readonly targetId: string;
  readonly scopeId: string;
  /** The chain the code lives on: `eip155:<chain id>`, `solana:devnet`, or `solana:mainnet-beta`. */
  readonly chainRef: string;
  readonly address: string;
  readonly expectedCodeHash: `0x${string}`;
}

/**
 * RPC_IDENTITY_MISMATCH means the configured endpoint proved, from chain data, that it serves
 * another chain. Like UNREADABLE it is reported and never quarantines a scope, because nothing was
 * learned about the watched code.
 */
export type CodeObservationStatus = 'MATCH' | 'DRIFT' | 'MISSING' | 'UNREADABLE' | 'RPC_IDENTITY_MISMATCH';

export interface CodeObservation {
  readonly targetId: string;
  readonly scopeId: string;
  readonly chainRef: string;
  readonly address: string;
  readonly expectedCodeHash: `0x${string}`;
  readonly observedCodeHash?: `0x${string}`;
  readonly status: CodeObservationStatus;
  readonly observedAtMs: bigint;
  readonly detail?: string;
}

/** Reads the current code hash at a target on one chain; null when no code exists there. Reads never write. */
export interface CodeReader {
  /** Proves from chain data that the endpoint serves the reader's chain; throws RpcIdentityMismatchError when it serves another. */
  verifyChainIdentity(): Promise<void>;
  readCodeHash(target: CodeWatchTarget): Promise<`0x${string}` | null>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function codeWatchTarget(input: CodeWatchTarget): CodeWatchTarget {
  requireCondition(typeof input === 'object' && input !== null, 'code watch target must be an object');
  const identity = chainIdentity(input.chainRef);
  requireCondition(
    identity.chain === 'EVM' ? EVM_ADDRESS.test(input.address) : BASE58_ADDRESS.test(input.address),
    `code watch address is not a valid ${identity.chain} address`,
  );
  requireCondition(HEX_32.test(input.expectedCodeHash), 'expected code hash must be 32 bytes of lowercase hex');
  return Object.freeze({
    targetId: protocolId(input.targetId, 'codeWatch.targetId'),
    scopeId: protocolId(input.scopeId, 'codeWatch.scopeId'),
    chainRef: identity.chainRef,
    address: input.address,
    expectedCodeHash: input.expectedCodeHash,
  });
}

function readerIdentity(chainRef: string, family: ChainIdentity['chain']): ChainIdentity {
  const identity = chainIdentity(chainRef);
  requireCondition(identity.chain === family, `${chainRef} is not an ${family} chain`);
  return identity;
}

/** Reads EVM runtime code with `eth_getCode` at the latest block and hashes it with keccak-256. */
export class EvmJsonRpcCodeReader implements CodeReader {
  readonly #identity: ChainIdentity;
  readonly #url: string;
  readonly #fetch: FetchLike;

  constructor(chainRef: string, url: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.#identity = readerIdentity(chainRef, 'EVM');
    this.#url = rpcUrl(url, `${chainRef} RPC URL`);
    this.#fetch = fetchImpl;
  }

  verifyChainIdentity(): Promise<void> {
    return verifyRpcIdentity(this.#fetch, this.#url, this.#identity);
  }

  async readCodeHash(target: CodeWatchTarget): Promise<`0x${string}` | null> {
    requireCondition(target.chainRef === this.#identity.chainRef, 'target is on another chain than this reader');
    const code = await jsonRpc(this.#fetch, this.#url, 'eth_getCode', [target.address, 'latest']);
    requireCondition(typeof code === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(code), 'eth_getCode returned malformed code');
    if (code === '0x') return null;
    return `0x${toHex(keccak_256(Buffer.from(code.slice(2), 'hex')))}`;
  }
}

/** The hash of a ProgramData account's executable bytes, trailing zero padding removed. */
export function programDataCodeHash(data: Uint8Array): `0x${string}` | null {
  if (data.length <= PROGRAM_DATA_METADATA_BYTES) return null;
  requireCondition(Buffer.from(data.subarray(0, 4)).readUInt32LE(0) === PROGRAM_DATA_STATE_TAG, 'account is not upgradeable-loader ProgramData');
  let end = data.length;
  while (end > PROGRAM_DATA_METADATA_BYTES && data[end - 1] === 0) end -= 1;
  if (end === PROGRAM_DATA_METADATA_BYTES) return null;
  return `0x${createHash('sha256').update(data.subarray(PROGRAM_DATA_METADATA_BYTES, end)).digest('hex')}`;
}

/** Reads a Solana program's ProgramData account with `getAccountInfo`. */
export class SolanaRpcProgramDataReader implements CodeReader {
  readonly #identity: ChainIdentity;
  readonly #url: string;
  readonly #fetch: FetchLike;

  constructor(chainRef: string, url: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.#identity = readerIdentity(chainRef, 'SVM');
    this.#url = rpcUrl(url, `${chainRef} RPC URL`);
    this.#fetch = fetchImpl;
  }

  verifyChainIdentity(): Promise<void> {
    return verifyRpcIdentity(this.#fetch, this.#url, this.#identity);
  }

  async readCodeHash(target: CodeWatchTarget): Promise<`0x${string}` | null> {
    requireCondition(target.chainRef === this.#identity.chainRef, 'target is on another chain than this reader');
    const result = (await jsonRpc(this.#fetch, this.#url, 'getAccountInfo', [target.address, { encoding: 'base64', commitment: 'finalized' }])) as {
      value?: { data?: unknown } | null;
    } | null;
    const value = result?.value;
    if (value === null || value === undefined) return null;
    const data = value.data;
    requireCondition(Array.isArray(data) && typeof data[0] === 'string' && data[1] === 'base64', 'getAccountInfo returned malformed data');
    return programDataCodeHash(Uint8Array.from(Buffer.from(data[0] as string, 'base64')));
  }
}

/** The reader for an EVM or Solana chain reference. */
export function createCodeReader(chainRef: string, url: string, fetchImpl?: FetchLike): CodeReader {
  return chainIdentity(chainRef).chain === 'EVM' ? new EvmJsonRpcCodeReader(chainRef, url, fetchImpl) : new SolanaRpcProgramDataReader(chainRef, url, fetchImpl);
}

/**
 * Observes every target once, with one reader per chain reference. Before any code on a chain is
 * read in a pass, that chain's endpoint must prove its identity; an endpoint serving another chain
 * makes every target on it RPC_IDENTITY_MISMATCH. A different hash is DRIFT and absent code is
 * MISSING; a read that fails is UNREADABLE, which is reported but never treated as a match.
 */
export async function observeCode(
  targets: readonly CodeWatchTarget[],
  readers: Readonly<Record<string, CodeReader>>,
  nowMs: bigint,
): Promise<readonly CodeObservation[]> {
  const observations: CodeObservation[] = [];
  const identities = new Map<string, Promise<{ readonly status: 'RPC_IDENTITY_MISMATCH' | 'UNREADABLE'; readonly detail: string } | undefined>>();
  for (const input of targets) {
    const target = codeWatchTarget(input);
    const base = { targetId: target.targetId, scopeId: target.scopeId, chainRef: target.chainRef, address: target.address, expectedCodeHash: target.expectedCodeHash, observedAtMs: nowMs };
    const reader = Object.hasOwn(readers, target.chainRef) ? readers[target.chainRef] : undefined;
    if (reader === undefined) {
      observations.push(Object.freeze({ ...base, status: 'UNREADABLE' as const, detail: `no ${target.chainRef} reader is configured` }));
      continue;
    }
    let identity = identities.get(target.chainRef);
    if (identity === undefined) {
      identity = reader.verifyChainIdentity().then(
        () => undefined,
        (error: unknown) => ({
          status: error instanceof RpcIdentityMismatchError ? ('RPC_IDENTITY_MISMATCH' as const) : ('UNREADABLE' as const),
          detail: error instanceof Error ? error.message : 'identity check failed',
        }),
      );
      identities.set(target.chainRef, identity);
    }
    const failure = await identity;
    if (failure !== undefined) {
      observations.push(Object.freeze({ ...base, ...failure }));
      continue;
    }
    try {
      const observed = await reader.readCodeHash(target);
      if (observed === null) observations.push(Object.freeze({ ...base, status: 'MISSING' as const }));
      else observations.push(Object.freeze({ ...base, observedCodeHash: observed, status: observed === target.expectedCodeHash ? 'MATCH' as const : 'DRIFT' as const }));
    } catch (error) {
      observations.push(Object.freeze({ ...base, status: 'UNREADABLE' as const, detail: error instanceof Error ? error.message : 'read failed' }));
    }
  }
  return Object.freeze(observations);
}

/** A commitment to the exact observations that justified a transition. */
export function observationCommitment(observations: readonly CodeObservation[]): `0x${string}` {
  const canonical = observations
    .map((entry) => [entry.targetId, entry.chainRef, entry.address, entry.expectedCodeHash, entry.observedCodeHash ?? '', entry.status, entry.observedAtMs.toString()].join('|'))
    .sort()
    .join('\n');
  return `0x${createHash('sha256').update(`naryx/code-hash-observation/v2\n${canonical}`).digest('hex')}`;
}

/**
 * Applies drift to one scope's incident journal: any DRIFT or MISSING observation for that scope
 * quarantines it through the CODE_DRIFT trigger, whose evidence commits to those observations.
 * A journal already quarantined, or a scope with no drift, is returned unchanged.
 */
export function codeDriftTransition(
  journal: DependencyIncidentJournal,
  observations: readonly CodeObservation[],
  readinessDecision: ReadinessDecision,
  nowMs: bigint,
  evidenceTtlMs: bigint,
): DependencyIncidentJournal {
  const drifted = observations.filter((entry) => entry.scopeId === journal.scope.scopeId && (entry.status === 'DRIFT' || entry.status === 'MISSING'));
  if (drifted.length === 0 || journal.state === 'QUARANTINED') return journal;
  requireCondition(evidenceTtlMs > 0n, 'evidence validity must be positive');
  return applyDependencyTrigger(journal, {
    expectedRevision: journal.revision,
    trigger: 'CODE_DRIFT',
    evidence: {
      scopeHash: journal.scopeHash,
      readinessDecision,
      readinessDecisionCommitment: journal.latestEvidence.readinessDecisionCommitment,
      evidenceCommitment: observationCommitment(drifted),
      observedAtMs: nowMs,
      validUntilMs: nowMs + evidenceTtlMs,
      exitSafe: false,
    },
    occurredAtMs: nowMs,
  });
}

/** One monitoring pass over every configured scope journal; returns the observations it made. */
export async function runCodeHashPass(input: {
  readonly targets: readonly CodeWatchTarget[];
  readonly readers: Readonly<Record<string, CodeReader>>;
  readonly journals: readonly { readonly store: Pick<DependencyIncidentFileStore, 'load' | 'save'>; readonly readinessDecision: ReadinessDecision }[];
  readonly nowMs: bigint;
  readonly evidenceTtlMs: bigint;
}): Promise<readonly CodeObservation[]> {
  const observations = await observeCode(input.targets, input.readers, input.nowMs);
  for (const entry of input.journals) {
    let journal: DependencyIncidentJournal;
    try {
      journal = await entry.store.load();
    } catch (error) {
      // A scope whose incident journal was never created (no READY qualification yet) still gets its drift
      // reported through the returned observations; it has nothing to quarantine.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    const next = codeDriftTransition(journal, observations, entry.readinessDecision, input.nowMs, input.evidenceTtlMs);
    if (next !== journal) await entry.store.save(next);
  }
  return observations;
}

export interface CodeHashMonitorConfig {
  readonly intervalMs: number;
  readonly evidenceTtlMs: bigint;
  readonly targets: readonly CodeWatchTarget[];
  readonly journals: readonly { readonly journalPath: string; readonly readinessDecision: ReadinessDecision }[];
  /** One RPC URL for each chain reference a target lives on. */
  readonly rpcUrls: ReadonlyMap<string, string>;
}

/**
 * Loads the monitor from NARYX_CODE_WATCHLIST, a protocol-JSON file naming the targets, the scope
 * journals with their current readiness decisions, the poll interval, and the evidence validity.
 * Reads go only to the per-chain URLs in NARYX_KEEPER_RPC_URLS, and every target's chain needs one.
 * Unset, the monitor stays off.
 */
export function loadCodeHashMonitorConfig(
  environment: NodeJS.ProcessEnv,
  readText: (path: string) => string,
  parse: (text: string) => unknown,
): CodeHashMonitorConfig | undefined {
  const path = environment.NARYX_CODE_WATCHLIST;
  if (path === undefined || path === '') return undefined;
  const raw = parse(readText(path)) as Record<string, unknown>;
  requireCondition(typeof raw === 'object' && raw !== null, 'code watchlist must be an object');
  const intervalMs = raw.intervalMs;
  requireCondition(typeof intervalMs === 'number' && Number.isSafeInteger(intervalMs) && intervalMs >= 5_000, 'intervalMs must be at least 5000');
  requireCondition(typeof raw.evidenceTtlMs === 'bigint' && raw.evidenceTtlMs > 0n, 'evidenceTtlMs must be a positive exact integer');
  requireCondition(Array.isArray(raw.targets) && raw.targets.length > 0 && raw.targets.length <= 256, 'targets must list 1 to 256 targets');
  requireCondition(Array.isArray(raw.journals) && raw.journals.length > 0, 'journals must list at least one scope journal');
  const targets = (raw.targets as CodeWatchTarget[]).map(codeWatchTarget);
  const journals = (raw.journals as { journalPath: unknown; readinessDecision: unknown }[]).map((entry) => {
    requireCondition(typeof entry.journalPath === 'string' && entry.journalPath.startsWith('/'), 'journalPath must be absolute');
    requireCondition(typeof entry.readinessDecision === 'object' && entry.readinessDecision !== null, 'readinessDecision is required');
    return { journalPath: entry.journalPath, readinessDecision: entry.readinessDecision as ReadinessDecision };
  });
  const configured = loadKeeperRpcUrls(environment);
  const rpcUrls = new Map<string, string>();
  for (const target of targets) {
    const url = configured.get(target.chainRef);
    requireCondition(url !== undefined, `targets on ${target.chainRef} need its RPC URL in NARYX_KEEPER_RPC_URLS`);
    rpcUrls.set(target.chainRef, url);
  }
  return Object.freeze({ intervalMs, evidenceTtlMs: raw.evidenceTtlMs, targets, journals, rpcUrls });
}

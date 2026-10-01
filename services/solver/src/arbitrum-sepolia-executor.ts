import { createPublicKey, verify } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import {
  bytesEqual,
  fromProtocolJson,
  packageOrderHash,
  parseProtocolJson,
  quoteHash as solverQuoteHash,
  routeHash as routePayloadHash,
  routePayload,
  solverQuote,
  solverSignatureDigest,
  stringifyProtocolJson,
  validatePackageOrderProfile,
  type DomainRef,
  type PackageOrder,
  type PackageOrderInput,
  type RoutePayload,
  type RoutePayloadInput,
  type SolverQuote,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  GMX_DATA_STORE_KEYS,
  ceilDiv,
  createViemArbitrumSepoliaReadPort,
  gmxIncreaseExecutionFeeWei,
  readGmxExecutionFeeParameters,
  readGmxUint,
  requireArbitrumSepoliaChain,
  requireArbitrumSepoliaCode,
  type ArbitrumSepoliaContractIdentity,
  type ArbitrumSepoliaReadPort,
  type ArbitrumSepoliaReadRequest,
} from './arbitrum-sepolia-gmx.js';

export const SOLVER_ARBITRUM_SEPOLIA_EXECUTE_PATH = '/internal/solver/arbitrum-sepolia/execute';
export const API_ARBITRUM_SEPOLIA_ATTEMPT_PATH = '/internal/solver/attempts/';
export const ARBITRUM_SEPOLIA_EXECUTOR_CONFIG_VERSION = 1;

const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const BPS_SCALE = 10_000n;
const GMX_USD_DECIMALS = 30;
const SCHEMA_VERSION = 1;
const MAX_BODY_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_KEY_FILE_BYTES = 4_096;
const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const EIP712_DOMAIN_NAME = 'Naryx Async Bonded Package';
const EXECUTION_CLASS_ID = keccak256(stringToHex('ASYNC_BONDED_SOLVER'));
const EVIDENCE_SCHEMA_ID = keccak256(stringToHex('NARYX_ASYNC_VENUE_EVIDENCE_V1'));
const RECOVERY_POLICY_ID = keccak256(stringToHex('NARYX_ASYNC_CANCEL_OR_RECONCILE_V1'));
const FILL_COMMITMENT_DOMAIN = 'NARYX_ARBITRUM_SEPOLIA_SPOT_FILL_V1';

const STRUCTS = [
  'struct DomainRef { bytes32 domainIdHash; uint32 manifestVersion; bytes32 manifestHash; }',
  'struct Terms { DomainRef domain; address owner; address solver; address adapter; address handler; bytes32 adapterCodeHash; bytes32 handlerCodeHash; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; bytes32 seriesIdentityKey; uint32 seriesBindingVersion; bytes32 seriesBindingHash; bytes32 executionClassIdentityHash; bytes32 executionClassManifestHash; bytes32 requestPayloadHash; bytes32 reservationHash; bytes32 bondHash; bytes32 recoveryPolicyHash; bytes32 evidenceSchemaHash; address bondRecipient; address recoveryReserveRecipient; address slashRecipient; address lossAsset; address residualAsset; uint256 bondAtoms; uint256 recoveryReserveAtoms; uint256 maxAggregateLossAtoms; uint256 maxIntermediateResidualAtoms; uint256 maxTerminalResidualAtoms; uint256 nonce; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }',
  'struct SpotEntry { address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; }',
  'struct VenueRequest { bytes32 marketId; address collateralToken; int256 sizeDelta; uint256 collateralAtoms; uint256 acceptablePrice; uint256 executionFeeWei; uint256 callbackGasLimit; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; SpotEntry spot; uint64 submissionDeadline; uint64 venueDeadline; uint64 recoveryDeadline; }',
  'struct Package { Terms terms; bytes32 requestKey; bytes32 outcomeEvidenceHash; bytes32 recoveryEvidenceHash; bytes32 venueEvidenceCommitment; bytes32 recoveryEvidenceCommitment; uint8 state; uint64 stateVersion; uint64 admissionGeneration; uint64 recoveryDutyStartedAt; uint8 lastVenueOutcome; bool hasVenueOutcome; bool recoveryDutyActive; bool recoveryActionSubmitted; bool recoveryProven; bool bondSlashed; bool evidenceConflict; uint256 settledLossAtoms; }',
] as const;

export const ARBITRUM_ASYNC_COORDINATOR_ABI = parseAbi([
  ...STRUCTS,
  'function nextNonce(address owner) view returns (uint256)',
  'function packageId(Terms terms) view returns (bytes32)',
  'function reserveDigest(Terms terms) view returns (bytes32)',
  'function bondCommitment(Terms terms) view returns (bytes32)',
  'function reservationCommitment(Terms terms) view returns (bytes32)',
  'function recoveryPolicyCommitment(Terms terms) view returns (bytes32)',
  'function packageState(bytes32 id) view returns (Package)',
  'function reserve(Terms terms, bytes ownerSignature) returns (bytes32)',
  'function submitRequest(bytes32 id, uint64 expectedVersion, VenueRequest request) returns (bytes32)',
  'function markVenuePending(bytes32 id, uint64 expectedVersion)',
  'function close(bytes32 id, uint64 expectedVersion)',
]);
export const ARBITRUM_GMX_ADAPTER_ABI = parseAbi([
  ...STRUCTS,
  'function funding(bytes32 packageId) view returns (bytes32 requestPayloadHash, uint256 collateralAtoms, uint256 spotQuoteAtoms, uint256 executionFeeWei, uint64 submissionDeadline, bool consumed)',
  'function requestEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint256 positionSizeBefore, uint256 positionSizeAfter, uint64 revision)',
  'function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable',
  'function relayEvidence(bytes32 requestKey, uint64 expectedVersion)',
]);
export const ARBITRUM_ISOLATED_ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function fundingAuthority() view returns (address)',
  'function spotPort() view returns (address)',
  'function spotBaseToken() view returns (address)',
]);
export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const STATE = Object.freeze({
  NONE: 0, RESERVED: 1, REQUEST_SUBMITTED: 2, VENUE_PENDING: 3, EXECUTED: 4, CANCELLED: 5,
  FROZEN: 6, RECOVERY_PENDING: 7, RECOVERED: 8, MANUAL_INTERVENTION: 9, CLOSED: 10,
});
const STATE_NAMES = Object.freeze(Object.keys(STATE)) as readonly (keyof typeof STATE)[];
// Adapter request outcomes that relayEvidence forwards to the coordinator.
const RELAYABLE_REQUEST_STATUS = new Set([2, 3, 4, 5]);

export interface ArbitrumSepoliaExecutorConfig {
  readonly domain: DomainRef;
  readonly coordinator: ArbitrumSepoliaContractIdentity;
  readonly adapter: ArbitrumSepoliaContractIdentity;
  readonly isolatedAccount: ArbitrumSepoliaContractIdentity;
  readonly collateralToken: ArbitrumSepoliaContractIdentity;
  readonly spotPort: ArbitrumSepoliaContractIdentity;
  readonly spotBaseToken: ArbitrumSepoliaContractIdentity;
  readonly gmxDataStore: ArbitrumSepoliaContractIdentity;
  readonly gmxMarket: Address;
  readonly quoteAssetDecimals: number;
  readonly executionClassManifestHash: Hex;
  readonly seriesIdentityKey: Hex;
  readonly seriesBindingVersion: number;
  readonly seriesBindingHash: Hex;
  readonly bondAtoms: bigint;
  readonly recoveryReserveAtoms: bigint;
  readonly maxAggregateLossAtoms: bigint;
  readonly maxIntermediateResidualAtoms: bigint;
  readonly maxTerminalResidualAtoms: bigint;
  readonly slashRecipient: Address;
  readonly callbackGasLimit: bigint;
  readonly executionFeeBufferBps: number;
  readonly maxExecutionFeeWei: bigint;
  readonly maxCollateralAtoms: bigint;
  readonly maxSpotQuoteAtoms: bigint;
  readonly receiptWaitMs: number;
}

export interface ArbitrumSepoliaExecutionAttempt {
  readonly attemptId: string;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly order: PackageOrder;
  readonly route: RoutePayload;
  readonly quote: SolverQuote;
}

export interface ArbitrumSepoliaAttemptProvider {
  resolve(attemptId: string): Promise<ArbitrumSepoliaExecutionAttempt | undefined>;
}

export interface ArbitrumSepoliaWriteRequest extends ArbitrumSepoliaReadRequest {
  readonly value?: bigint;
}

/** Arbitrum Sepolia writes by the solver account. Every write is preceded by an eth_chainId check. */
export interface ArbitrumSepoliaWritePort extends ArbitrumSepoliaReadPort {
  readonly account: Address;
  writeContract(request: ArbitrumSepoliaWriteRequest): Promise<Hex>;
  /** Waits up to waitMs; null means not yet mined. */
  receipt(hash: Hex, waitMs: number): Promise<'success' | 'reverted' | null>;
}

export interface ArbitrumSepoliaOwnerSigner {
  readonly address: Address;
  signTypedData(typedData: Parameters<typeof hashTypedData>[0]): Promise<Hex>;
}

export type ArbitrumSepoliaExecutionStep =
  | 'APPROVE_ADAPTER' | 'FUND' | 'APPROVE_COORDINATOR' | 'RESERVE' | 'SUBMIT' | 'MARK_PENDING' | 'RELAY' | 'CLOSE';

export interface ArbitrumSepoliaExecutionResult {
  readonly version: 1;
  readonly attemptId: string;
  readonly status: 'IN_FLIGHT' | 'VENUE_PENDING' | 'SETTLED' | 'RECOVERY_REQUIRED' | 'FAILED';
  readonly packageId: Hex;
  readonly coordinatorState: string;
  readonly requestKey: Hex | null;
  readonly transactions: readonly Readonly<{ step: ArbitrumSepoliaExecutionStep; txHash: Hex; status: string }>[];
}

export class ArbitrumSepoliaExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArbitrumSepoliaExecutorError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ArbitrumSepoliaExecutorError(code, message);
}

function hex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

function lower(address: string): Address {
  return address.toLowerCase() as Address;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function externalAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} path must be absolute`);
  const path = resolve(value);
  const projectRelativePath = relative(PROJECT_ROOT, path);
  if (projectRelativePath !== '..' && !projectRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(projectRelativePath)) {
    throw new Error(`${label} must be outside the repository`);
  }
  return path;
}

/** Loads a testnet EVM key from an external 0400/0600 JSON file. The key is never logged or returned. */
export function loadArbitrumSepoliaKey(pathValue: string, expectedAddress: string, label: string): LocalAccount {
  if (!ADDRESS.test(expectedAddress)) throw new Error(`expected ${label} address must be lowercase`);
  const path = externalAbsolutePath(pathValue, label);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || realpathSync(path) !== path) {
    throw new Error(`${label} path must be a canonical regular file`);
  }
  if ((status.mode & 0o077) !== 0 || (status.mode & 0o400) === 0 || (status.mode & 0o111) !== 0) {
    throw new Error(`${label} file permissions must be 0400 or 0600`);
  }
  if (typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new Error(`${label} file must be owned by the current user`);
  }
  if (status.size < 1 || status.size > MAX_KEY_FILE_BYTES) throw new Error(`${label} file size is invalid`);
  const bytes = readFileSync(path);
  try {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${label} file is malformed`);
    }
    if (typeof record !== 'object' || record === null
      || Object.keys(record).sort().join(',') !== 'environment,privateKey,version'
      || record.version !== 1 || record.environment !== 'ARBITRUM_SEPOLIA'
      || typeof record.privateKey !== 'string' || !PRIVATE_KEY.test(record.privateKey)
      || /^0x0+$/.test(record.privateKey)) {
      throw new Error(`${label} file fields are invalid`);
    }
    const account = privateKeyToAccount(record.privateKey as Hex);
    if (lower(account.address) !== expectedAddress) throw new Error(`${label} does not match the expected address`);
    return account;
  } finally {
    bytes.fill(0);
  }
}

export function createViemArbitrumSepoliaWritePort(rpcUrl: string, account: LocalAccount): ArbitrumSepoliaWritePort {
  const read = createViemArbitrumSepoliaReadPort(rpcUrl);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpcUrl) });
  return Object.freeze({
    ...read,
    account: lower(account.address),
    writeContract: async (request: ArbitrumSepoliaWriteRequest) => wallet.writeContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      ...(request.value === undefined ? {} : { value: request.value }),
    } as never),
    receipt: async (hash: Hex, waitMs: number) => {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: waitMs });
        return receipt.status;
      } catch (error) {
        if (error instanceof Error && /Timeout|NotFound/.test(error.name)) return null;
        throw error;
      }
    },
  });
}

export function arbitrumSepoliaOwnerSigner(account: LocalAccount): ArbitrumSepoliaOwnerSigner {
  return Object.freeze({
    address: lower(account.address),
    signTypedData: (typedData: Parameters<typeof hashTypedData>[0]) => account.signTypedData(typedData as never),
  });
}

type Terms = Readonly<{
  domain: Readonly<{ domainIdHash: Hex; manifestVersion: number; manifestHash: Hex }>;
  owner: Address; solver: Address; adapter: Address; handler: Address;
  adapterCodeHash: Hex; handlerCodeHash: Hex; orderHash: Hex; quoteHash: Hex; routeHash: Hex;
  seriesIdentityKey: Hex; seriesBindingVersion: number; seriesBindingHash: Hex;
  executionClassIdentityHash: Hex; executionClassManifestHash: Hex; requestPayloadHash: Hex;
  reservationHash: Hex; bondHash: Hex; recoveryPolicyHash: Hex; evidenceSchemaHash: Hex;
  bondRecipient: Address; recoveryReserveRecipient: Address; slashRecipient: Address;
  lossAsset: Address; residualAsset: Address;
  bondAtoms: bigint; recoveryReserveAtoms: bigint; maxAggregateLossAtoms: bigint;
  maxIntermediateResidualAtoms: bigint; maxTerminalResidualAtoms: bigint; nonce: bigint;
  submissionDeadline: bigint; venueDeadline: bigint; recoveryDeadline: bigint;
}>;

type VenueRequest = Readonly<{
  marketId: Hex; collateralToken: Address; sizeDelta: bigint; collateralAtoms: bigint;
  acceptablePrice: bigint; executionFeeWei: bigint; callbackGasLimit: bigint; packageNonce: bigint;
  orderHash: Hex; quoteHash: Hex; routeHash: Hex;
  spot: Readonly<{
    fundingOwner: Address; port: Address; portCodeHash: Hex; baseToken: Address; quoteToken: Address;
    baseAtoms: bigint; maxQuoteAtoms: bigint; rollbackMinQuoteAtoms: bigint;
    entryFillCommitment: Hex; rollbackFillCommitment: Hex;
  }>;
  submissionDeadline: bigint; venueDeadline: bigint; recoveryDeadline: bigint;
}>;

export interface ArbitrumSepoliaExecutionPlan {
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly terms: Terms;
  readonly request: VenueRequest;
  readonly ownerSignature: Hex;
}

function tupleType(name: 'Terms' | 'VenueRequest') {
  const fn = ARBITRUM_ASYNC_COORDINATOR_ABI.find((item) => item.type === 'function'
    && item.name === (name === 'Terms' ? 'packageId' : 'submitRequest'));
  const input = fn !== undefined && 'inputs' in fn
    ? fn.inputs.find((candidate) => candidate.type === 'tuple')
    : undefined;
  if (input === undefined) throw new Error(`${name} ABI is missing`);
  return input;
}

const TERMS_TUPLE = tupleType('Terms');
const REQUEST_TUPLE = tupleType('VenueRequest');

export function arbitrumAsyncTermsHash(terms: Terms): Hex {
  return keccak256(encodeAbiParameters([TERMS_TUPLE], [terms as never]));
}

export function arbitrumAsyncPackageId(terms: Terms, coordinator: Address): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
    [ARBITRUM_SEPOLIA_CHAIN_ID, coordinator, arbitrumAsyncTermsHash(terms)],
  ));
}

export function arbitrumAsyncReserveTypedData(terms: Terms, coordinator: Address) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME, version: '1', chainId: Number(ARBITRUM_SEPOLIA_CHAIN_ID), verifyingContract: coordinator,
    },
    types: { ReserveAsyncPackage: [{ name: 'termsHash', type: 'bytes32' }] },
    primaryType: 'ReserveAsyncPackage',
    message: { termsHash: arbitrumAsyncTermsHash(terms) },
  } as const;
}

function encodeHash(types: readonly { type: string }[], values: readonly unknown[]): Hex {
  return keccak256(encodeAbiParameters(types, values as never));
}

function hashValue(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('CHAIN_MISMATCH', `${name} is invalid`);
  return value.toLowerCase() as Hex;
}

function requirePositive(value: bigint, cap: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > cap) {
    fail('AMOUNT_LIMIT', `${name} must be positive and within the configured atom limit`);
  }
  return value;
}

function validateConfig(config: ArbitrumSepoliaExecutorConfig): void {
  const identities = [
    config.coordinator, config.adapter, config.isolatedAccount, config.collateralToken,
    config.spotPort, config.spotBaseToken, config.gmxDataStore,
  ];
  if (config.domain?.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID
    || identities.some((identity) => !ADDRESS.test(identity?.address ?? '')
      || !HASH.test(identity.expectedCodeHash) || identity.expectedCodeHash === ZERO_HASH)
    || !ADDRESS.test(config.gmxMarket) || !ADDRESS.test(config.slashRecipient)
    || !HASH.test(config.executionClassManifestHash) || !HASH.test(config.seriesIdentityKey)
    || !HASH.test(config.seriesBindingHash)
    || !Number.isSafeInteger(config.seriesBindingVersion) || config.seriesBindingVersion < 1
    || !Number.isSafeInteger(config.quoteAssetDecimals) || config.quoteAssetDecimals < 0
    || config.quoteAssetDecimals > GMX_USD_DECIMALS
    || !Number.isSafeInteger(config.executionFeeBufferBps) || config.executionFeeBufferBps < 0
    || config.executionFeeBufferBps > 10_000
    || !Number.isSafeInteger(config.receiptWaitMs) || config.receiptWaitMs < 1 || config.receiptWaitMs > 20_000
    || [config.bondAtoms, config.recoveryReserveAtoms, config.maxAggregateLossAtoms,
      config.maxIntermediateResidualAtoms, config.maxTerminalResidualAtoms, config.callbackGasLimit,
      config.maxExecutionFeeWei, config.maxCollateralAtoms, config.maxSpotQuoteAtoms]
      .some((value) => typeof value !== 'bigint' || value <= 0n)
    || config.maxAggregateLossAtoms > config.recoveryReserveAtoms
    || config.maxTerminalResidualAtoms > config.maxIntermediateResidualAtoms) {
    throw new Error('Arbitrum Sepolia executor configuration is incomplete or invalid');
  }
}

/** The durable per-attempt journal. A recorded transaction is never resent. */
export class SqliteArbitrumSepoliaExecutionJournal {
  readonly #db: Database.Database;

  constructor(path: string) {
    const resolved = externalAbsolutePath(path, 'Arbitrum Sepolia executor journal');
    mkdirSync(dirname(resolved), { recursive: true });
    this.#db = new Database(resolved);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS arbitrum_executor_schema (version INTEGER NOT NULL) STRICT;
      INSERT INTO arbitrum_executor_schema(version)
        SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM arbitrum_executor_schema);
      CREATE TABLE IF NOT EXISTS arbitrum_execution_plans (
        attempt_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL UNIQUE,
        plan_json TEXT NOT NULL,
        failed_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS arbitrum_execution_transactions (
        attempt_id TEXT NOT NULL REFERENCES arbitrum_execution_plans(attempt_id),
        step TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('SENT', 'CONFIRMED', 'REVERTED')),
        PRIMARY KEY (attempt_id, step)
      ) STRICT;
    `);
    const version = this.#db.prepare('SELECT version FROM arbitrum_executor_schema').pluck().get();
    if (version !== SCHEMA_VERSION) {
      this.#db.close();
      throw new Error('Arbitrum Sepolia executor journal schema version is unsupported');
    }
  }

  plan(attemptId: string): ArbitrumSepoliaExecutionPlan | undefined {
    const row = this.#db.prepare('SELECT plan_json FROM arbitrum_execution_plans WHERE attempt_id = ?')
      .get(attemptId) as { plan_json: string } | undefined;
    return row === undefined
      ? undefined
      : parseProtocolJson(row.plan_json, 'arbitrumExecutionPlan') as unknown as ArbitrumSepoliaExecutionPlan;
  }

  savePlan(plan: ArbitrumSepoliaExecutionPlan): ArbitrumSepoliaExecutionPlan {
    this.#db.prepare(`
      INSERT INTO arbitrum_execution_plans (attempt_id, package_id, plan_json) VALUES (?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(plan.attemptId, plan.packageId, stringifyProtocolJson(plan as never, 'arbitrumExecutionPlan'));
    const stored = this.plan(plan.attemptId);
    if (stored === undefined || stored.packageId !== plan.packageId) {
      fail('JOURNAL_CONFLICT', 'a different plan is already journaled for the attempt');
    }
    return stored;
  }

  failed(attemptId: string): string | undefined {
    const row = this.#db.prepare('SELECT failed_reason FROM arbitrum_execution_plans WHERE attempt_id = ?')
      .get(attemptId) as { failed_reason: string | null } | undefined;
    return row?.failed_reason ?? undefined;
  }

  markFailed(attemptId: string, reason: string): void {
    this.#db.prepare('UPDATE arbitrum_execution_plans SET failed_reason = ? WHERE attempt_id = ? AND failed_reason IS NULL')
      .run(reason, attemptId);
  }

  transaction(attemptId: string, step: ArbitrumSepoliaExecutionStep) {
    return this.#db.prepare(
      'SELECT tx_hash AS txHash, status FROM arbitrum_execution_transactions WHERE attempt_id = ? AND step = ?',
    ).get(attemptId, step) as { txHash: Hex; status: 'SENT' | 'CONFIRMED' | 'REVERTED' } | undefined;
  }

  transactions(attemptId: string) {
    return this.#db.prepare(`
      SELECT step, tx_hash AS txHash, status FROM arbitrum_execution_transactions WHERE attempt_id = ? ORDER BY rowid
    `).all(attemptId) as { step: ArbitrumSepoliaExecutionStep; txHash: Hex; status: string }[];
  }

  recordSent(attemptId: string, step: ArbitrumSepoliaExecutionStep, txHash: Hex): void {
    this.#db.prepare(`
      INSERT INTO arbitrum_execution_transactions (attempt_id, step, tx_hash, status) VALUES (?, ?, ?, 'SENT')
    `).run(attemptId, step, txHash);
  }

  recordOutcome(attemptId: string, step: ArbitrumSepoliaExecutionStep, status: 'CONFIRMED' | 'REVERTED'): void {
    this.#db.prepare(`
      UPDATE arbitrum_execution_transactions SET status = ? WHERE attempt_id = ? AND step = ? AND status = 'SENT'
    `).run(status, attemptId, step);
  }

  close(): void {
    this.#db.close();
  }
}

export interface ArbitrumSepoliaExecutorOptions {
  readonly config: ArbitrumSepoliaExecutorConfig;
  readonly attempts: ArbitrumSepoliaAttemptProvider;
  readonly chain: ArbitrumSepoliaWritePort;
  readonly owner: ArbitrumSepoliaOwnerSigner;
  readonly journal: SqliteArbitrumSepoliaExecutionJournal;
}

class InFlight extends Error {}

export class ArbitrumSepoliaExecutor {
  readonly #options: ArbitrumSepoliaExecutorOptions;
  // The adapter funds one package at a time, so attempts advance strictly one after another.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ArbitrumSepoliaExecutorOptions) {
    validateConfig(options.config);
    if (!ADDRESS.test(options.chain.account) || !ADDRESS.test(options.owner.address)) {
      throw new Error('Arbitrum Sepolia solver and owner accounts must be lowercase addresses');
    }
    if (options.chain.account === options.owner.address) {
      throw new Error('Arbitrum Sepolia solver and owner accounts must be separate wallets');
    }
    this.#options = options;
  }

  advance(attemptId: string): Promise<ArbitrumSepoliaExecutionResult> {
    if (!ATTEMPT_ID.test(attemptId)) return Promise.reject(new ArbitrumSepoliaExecutorError('INVALID_ATTEMPT', 'attempt ID is invalid'));
    const next = this.#queue.then(() => this.#advance(attemptId));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #advance(attemptId: string): Promise<ArbitrumSepoliaExecutionResult> {
    const { chain, journal } = this.#options;
    await this.#requireChain();
    const failure = journal.failed(attemptId);
    if (failure !== undefined) return this.#result(attemptId, journal.plan(attemptId)!, 'FAILED', undefined);
    const plan = journal.plan(attemptId) ?? journal.savePlan(await this.#plan(attemptId));
    try {
      await this.#ensureAllowance(plan, 'APPROVE_ADAPTER', plan.terms.adapter,
        plan.request.collateralAtoms + plan.request.spot.maxQuoteAtoms);
      const funded = await this.#read(plan.terms.adapter, ARBITRUM_GMX_ADAPTER_ABI, 'funding', [plan.packageId]) as readonly unknown[];
      if (hashValue(funded[0], 'funding request hash') !== plan.terms.requestPayloadHash) {
        if (funded[0] !== ZERO_HASH) fail('CHAIN_MISMATCH', 'adapter funding belongs to another request');
        await this.#send(plan, 'FUND', {
          address: plan.terms.adapter, abi: ARBITRUM_GMX_ADAPTER_ABI, functionName: 'fundRequest',
          args: [plan.packageId, plan.request], value: plan.request.executionFeeWei,
        });
      }
      let state = await this.#state(plan);
      if (state.state === STATE.NONE) {
        await this.#ensureAllowance(plan, 'APPROVE_COORDINATOR', this.#coordinator(),
          plan.terms.bondAtoms + plan.terms.recoveryReserveAtoms);
        await this.#send(plan, 'RESERVE', {
          address: this.#coordinator(), abi: ARBITRUM_ASYNC_COORDINATOR_ABI, functionName: 'reserve',
          args: [plan.terms, plan.ownerSignature],
        });
        state = await this.#state(plan);
      }
      if (state.state === STATE.RESERVED) {
        await this.#send(plan, 'SUBMIT', {
          address: this.#coordinator(), abi: ARBITRUM_ASYNC_COORDINATOR_ABI, functionName: 'submitRequest',
          args: [plan.packageId, state.stateVersion, plan.request],
        });
        state = await this.#state(plan);
      }
      if (state.state === STATE.REQUEST_SUBMITTED) {
        await this.#send(plan, 'MARK_PENDING', {
          address: this.#coordinator(), abi: ARBITRUM_ASYNC_COORDINATOR_ABI, functionName: 'markVenuePending',
          args: [plan.packageId, state.stateVersion],
        });
        state = await this.#state(plan);
      }
      if (state.state === STATE.VENUE_PENDING) {
        const evidence = await this.#read(plan.terms.adapter, ARBITRUM_GMX_ADAPTER_ABI, 'requestEvidence', [state.requestKey]) as readonly unknown[];
        if (!RELAYABLE_REQUEST_STATUS.has(Number(evidence[0]))) {
          return this.#result(attemptId, plan, 'VENUE_PENDING', state);
        }
        await this.#send(plan, 'RELAY', {
          address: plan.terms.adapter, abi: ARBITRUM_GMX_ADAPTER_ABI, functionName: 'relayEvidence',
          args: [state.requestKey, state.stateVersion],
        });
        state = await this.#state(plan);
      }
      if (state.state === STATE.EXECUTED || state.state === STATE.RECOVERED) {
        await this.#send(plan, 'CLOSE', {
          address: this.#coordinator(), abi: ARBITRUM_ASYNC_COORDINATOR_ABI, functionName: 'close',
          args: [plan.packageId, state.stateVersion],
        });
        state = await this.#state(plan);
      }
      if (state.state === STATE.CLOSED) return this.#result(attemptId, plan, 'SETTLED', state);
      // Cancelled, frozen, or overdue packages need the coordinator recovery path, which the keeper drives.
      return this.#result(attemptId, plan, 'RECOVERY_REQUIRED', state);
    } catch (error) {
      if (error instanceof InFlight) return this.#result(attemptId, plan, 'IN_FLIGHT', undefined);
      if (error instanceof ArbitrumSepoliaExecutorError && error.code === 'TRANSACTION_REVERTED') {
        journal.markFailed(attemptId, error.message);
        return this.#result(attemptId, plan, 'FAILED', undefined);
      }
      throw error;
    }
  }

  #coordinator(): Address {
    return lower(this.#options.config.coordinator.address);
  }

  async #requireChain(): Promise<void> {
    try {
      await requireArbitrumSepoliaChain(this.#options.chain);
    } catch {
      fail('WRONG_CHAIN', 'RPC eth_chainId is not Arbitrum Sepolia 421614; no transaction was sent');
    }
  }

  #read(address: Address, abi: ArbitrumSepoliaReadRequest['abi'], functionName: string, args?: readonly unknown[]) {
    return this.#options.chain.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }) });
  }

  async #state(plan: ArbitrumSepoliaExecutionPlan) {
    const record = await this.#read(this.#coordinator(), ARBITRUM_ASYNC_COORDINATOR_ABI, 'packageState', [plan.packageId]) as Record<string, unknown>;
    const state = Number(record.state);
    if (!Number.isSafeInteger(state) || state < 0 || state >= STATE_NAMES.length) fail('CHAIN_MISMATCH', 'package state is invalid');
    if (state !== STATE.NONE && arbitrumAsyncTermsHash(record.terms as Terms) !== arbitrumAsyncTermsHash(plan.terms)) {
      fail('CHAIN_MISMATCH', 'reserved package terms do not match the journaled plan');
    }
    return Object.freeze({
      state,
      stateVersion: BigInt(record.stateVersion as bigint),
      requestKey: hashValue(record.requestKey, 'package request key'),
    });
  }

  async #ensureAllowance(plan: ArbitrumSepoliaExecutionPlan, step: ArbitrumSepoliaExecutionStep, spender: Address, atoms: bigint) {
    if (this.#options.journal.transaction(plan.attemptId, step)?.status === 'CONFIRMED') return;
    const token = lower(this.#options.config.collateralToken.address);
    const current = await this.#read(token, ERC20_ABI, 'allowance', [this.#options.chain.account, spender]);
    if (typeof current === 'bigint' && current >= atoms && this.#options.journal.transaction(plan.attemptId, step) === undefined) return;
    await this.#send(plan, step, { address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, atoms] });
  }

  async #send(plan: ArbitrumSepoliaExecutionPlan, step: ArbitrumSepoliaExecutionStep, request: ArbitrumSepoliaWriteRequest) {
    const { chain, journal, config } = this.#options;
    let recorded = journal.transaction(plan.attemptId, step);
    if (recorded === undefined) {
      await this.#requireChain();
      const txHash = await chain.writeContract(request);
      if (!HASH.test(txHash)) fail('CHAIN_MISMATCH', 'RPC returned an invalid transaction hash');
      journal.recordSent(plan.attemptId, step, txHash);
      recorded = { txHash, status: 'SENT' };
    }
    if (recorded.status === 'CONFIRMED') return;
    if (recorded.status === 'REVERTED') fail('TRANSACTION_REVERTED', `${step} transaction reverted`);
    const outcome = await chain.receipt(recorded.txHash, config.receiptWaitMs);
    if (outcome === null) throw new InFlight();
    journal.recordOutcome(plan.attemptId, step, outcome === 'success' ? 'CONFIRMED' : 'REVERTED');
    if (outcome !== 'success') fail('TRANSACTION_REVERTED', `${step} transaction reverted`);
  }

  #result(
    attemptId: string,
    plan: ArbitrumSepoliaExecutionPlan,
    status: ArbitrumSepoliaExecutionResult['status'],
    state: { state: number; requestKey: Hex } | undefined,
  ): ArbitrumSepoliaExecutionResult {
    return Object.freeze({
      version: 1,
      attemptId,
      status,
      packageId: plan.packageId,
      coordinatorState: state === undefined ? 'UNKNOWN' : STATE_NAMES[state.state]!,
      requestKey: state === undefined || state.requestKey === ZERO_HASH ? null : state.requestKey,
      transactions: Object.freeze(this.#options.journal.transactions(attemptId).map((entry) => Object.freeze(entry))),
    });
  }

  async #plan(attemptId: string): Promise<ArbitrumSepoliaExecutionPlan> {
    const { config, chain, owner } = this.#options;
    const attempt = await this.#options.attempts.resolve(attemptId);
    if (attempt === undefined || attempt.attemptId !== attemptId) fail('ATTEMPT_NOT_FOUND', 'selected attempt was not found');
    const { order, route, quote } = attempt;
    if (order.domain.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID
      || order.domain.domainManifestVersion !== config.domain.domainManifestVersion
      || !bytesEqual(order.domain.domainManifestHash, config.domain.domainManifestHash)
      || order.settlementClass !== 'ASYNC_BONDED_SOLVER' || order.action !== 'ENTRY'
      || route.executionPlanKind !== 'EVM_ASYNC_REQUEST' || route.recoveryPlan === undefined) {
      fail('ATTEMPT_MISMATCH', 'attempt is not a reviewed Arbitrum Sepolia async entry');
    }
    const ownerAddress = lower(order.owner);
    const solver = chain.account;
    const coordinator = this.#coordinator();
    const adapter = lower(config.adapter.address);
    const account = lower(config.isolatedAccount.address);
    if (ownerAddress !== owner.address || lower(route.settlementAccount) !== account
      || lower(order.settlementAccount) !== account) {
      fail('ACCOUNT_MISMATCH', 'only the configured isolated account owner can be executed');
    }
    for (const [identity, name] of [
      [config.coordinator, 'coordinator'], [config.adapter, 'adapter'], [config.isolatedAccount, 'isolated account'],
      [config.collateralToken, 'collateral token'], [config.spotPort, 'spot port'],
      [config.spotBaseToken, 'spot base token'], [config.gmxDataStore, 'GMX data store'],
    ] as const) await requireArbitrumSepoliaCode(chain, identity, name);
    const [onchainOwner, fundingAuthority, spotPort, spotBase] = await Promise.all([
      this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'owner'),
      this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'fundingAuthority'),
      this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'spotPort'),
      this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'spotBaseToken'),
    ]);
    if (!sameAddress(onchainOwner, ownerAddress) || !sameAddress(fundingAuthority, solver)
      || !sameAddress(spotPort, config.spotPort.address) || !sameAddress(spotBase, config.spotBaseToken.address)) {
      fail('CHAIN_MISMATCH', 'isolated account owner, funding authority, or spot binding does not match');
    }

    const now = await chain.latestBlockTimestamp();
    const recovery = route.recoveryPlan!;
    const submissionDeadline = route.routeExpiryValue;
    const venueDeadline = recovery.maxActionExpiryValue;
    const recoveryDeadline = recovery.deadlineValue;
    const requestExpiration = await readGmxUint(chain, lower(config.gmxDataStore.address), GMX_DATA_STORE_KEYS.requestExpirationTime);
    if (now >= submissionDeadline || venueDeadline < now + requestExpiration
      || submissionDeadline >= venueDeadline || venueDeadline >= recoveryDeadline) {
      fail('DEADLINE', 'route deadlines no longer leave a valid GMX submission window');
    }
    const executionFeeWei = gmxIncreaseExecutionFeeWei(
      await readGmxExecutionFeeParameters(chain, lower(config.gmxDataStore.address)),
      config.callbackGasLimit, await chain.gasPrice(), BigInt(config.executionFeeBufferBps),
    );
    requirePositive(executionFeeWei, config.maxExecutionFeeWei, 'execution fee');

    const perpetual = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
    const rollback = recovery.actionSlots.find((slot) => slot.action === 'ROLLBACK_SPOT');
    if (perpetual?.limitPrice === undefined || rollback?.limitPrice === undefined
      || order.maxSpotQuoteIn === undefined || quote.expectedPerpNotional.atoms <= 0n) {
      fail('ATTEMPT_MISMATCH', 'route is missing perpetual or rollback price bounds');
    }
    // The quote asset is the GMX USD unit at par, so quote atoms scale to GMX 30-decimal USD exactly.
    const usdScale = 10n ** BigInt(GMX_USD_DECIMALS - config.quoteAssetDecimals);
    const sizeDeltaUsd = quote.expectedPerpNotional.atoms * usdScale;
    // A short increase accepts any fill at or above this price, so the bound rounds up.
    const acceptablePrice = ceilDiv(perpetual.limitPrice.quoteAtoms * usdScale, perpetual.limitPrice.baseAtoms);
    const quantity = order.quantity.atoms;
    const rollbackMinQuoteAtoms = ceilDiv(quantity * rollback.limitPrice.quoteAtoms, rollback.limitPrice.baseAtoms);
    const nonce = await this.#read(coordinator, ARBITRUM_ASYNC_COORDINATOR_ABI, 'nextNonce', [ownerAddress]);
    if (typeof nonce !== 'bigint') fail('CHAIN_MISMATCH', 'owner nonce is invalid');
    const fill = (kind: string) => encodeHash(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [FILL_COMMITMENT_DOMAIN, kind, attempt.orderHash, attempt.quoteHash, attempt.routeHash, nonce],
    );
    const request: VenueRequest = Object.freeze({
      marketId: `0x${lower(config.gmxMarket).slice(2).padStart(64, '0')}` as Hex,
      collateralToken: lower(config.collateralToken.address),
      sizeDelta: -sizeDeltaUsd,
      collateralAtoms: requirePositive(quote.expectedMarginDelta.atoms, config.maxCollateralAtoms, 'collateral'),
      acceptablePrice,
      executionFeeWei,
      callbackGasLimit: config.callbackGasLimit,
      packageNonce: nonce,
      orderHash: attempt.orderHash,
      quoteHash: attempt.quoteHash,
      routeHash: attempt.routeHash,
      spot: Object.freeze({
        fundingOwner: solver,
        port: lower(config.spotPort.address),
        portCodeHash: config.spotPort.expectedCodeHash,
        baseToken: lower(config.spotBaseToken.address),
        quoteToken: lower(config.collateralToken.address),
        baseAtoms: quantity,
        maxQuoteAtoms: requirePositive(order.maxSpotQuoteIn.atoms, config.maxSpotQuoteAtoms, 'spot quote'),
        rollbackMinQuoteAtoms: requirePositive(rollbackMinQuoteAtoms, order.maxSpotQuoteIn.atoms, 'rollback quote'),
        entryFillCommitment: fill('ENTRY'),
        rollbackFillCommitment: fill('ROLLBACK'),
      }),
      submissionDeadline, venueDeadline, recoveryDeadline,
    });
    const requestPayloadHash = keccak256(encodeAbiParameters([REQUEST_TUPLE], [request as never]));
    const token = lower(config.collateralToken.address);
    const bondHash = encodeHash(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
      [token, config.bondAtoms, config.recoveryReserveAtoms, solver, solver, lower(config.slashRecipient)],
    );
    const terms: Terms = Object.freeze({
      domain: Object.freeze({
        domainIdHash: keccak256(stringToHex(ARBITRUM_SEPOLIA_DOMAIN_ID)),
        manifestVersion: order.domain.domainManifestVersion,
        manifestHash: hex(order.domain.domainManifestHash),
      }),
      owner: ownerAddress, solver, adapter, handler: adapter,
      adapterCodeHash: config.adapter.expectedCodeHash, handlerCodeHash: config.adapter.expectedCodeHash,
      orderHash: attempt.orderHash, quoteHash: attempt.quoteHash, routeHash: attempt.routeHash,
      seriesIdentityKey: config.seriesIdentityKey, seriesBindingVersion: config.seriesBindingVersion,
      seriesBindingHash: config.seriesBindingHash,
      executionClassIdentityHash: EXECUTION_CLASS_ID, executionClassManifestHash: config.executionClassManifestHash,
      requestPayloadHash,
      reservationHash: encodeHash(
        [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }],
        [ownerAddress, solver, attempt.orderHash, nonce, bondHash],
      ),
      bondHash,
      recoveryPolicyHash: encodeHash(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint64' }],
        [RECOVERY_POLICY_ID, adapter, requestPayloadHash, 0, recoveryDeadline],
      ),
      evidenceSchemaHash: EVIDENCE_SCHEMA_ID,
      bondRecipient: solver, recoveryReserveRecipient: solver, slashRecipient: lower(config.slashRecipient),
      lossAsset: token, residualAsset: token,
      bondAtoms: config.bondAtoms, recoveryReserveAtoms: config.recoveryReserveAtoms,
      maxAggregateLossAtoms: config.maxAggregateLossAtoms,
      maxIntermediateResidualAtoms: config.maxIntermediateResidualAtoms,
      maxTerminalResidualAtoms: config.maxTerminalResidualAtoms,
      nonce, submissionDeadline, venueDeadline, recoveryDeadline,
    });
    const packageId = arbitrumAsyncPackageId(terms, coordinator);
    const typedData = arbitrumAsyncReserveTypedData(terms, coordinator);
    // The coordinator's own views must agree with every locally derived commitment before signing.
    const [chainPackageId, digest, bond, reservation, recoveryPolicy] = await Promise.all(
      ['packageId', 'reserveDigest', 'bondCommitment', 'reservationCommitment', 'recoveryPolicyCommitment']
        .map((name) => this.#read(coordinator, ARBITRUM_ASYNC_COORDINATOR_ABI, name, [terms])),
    );
    if (hashValue(chainPackageId, 'packageId') !== packageId
      || hashValue(digest, 'reserveDigest') !== hashTypedData(typedData as never)
      || hashValue(bond, 'bondCommitment') !== terms.bondHash
      || hashValue(reservation, 'reservationCommitment') !== terms.reservationHash
      || hashValue(recoveryPolicy, 'recoveryPolicyCommitment') !== terms.recoveryPolicyHash) {
      fail('CHAIN_MISMATCH', 'coordinator commitments do not match the locally derived terms');
    }
    const ownerSignature = await owner.signTypedData(typedData as never);
    return Object.freeze({ attemptId, packageId, terms, request, ownerSignature });
  }
}

function ed25519Verify(digest: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean {
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key)]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(digest), publicKey, Buffer.from(signature));
}

/** Recomputes every hash and requires this solver's own signature before an attempt can be executed. */
export function verifyArbitrumSepoliaAttempt(
  attemptId: string,
  value: unknown,
  solverVerificationKey: Uint8Array,
): ArbitrumSepoliaExecutionAttempt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('ATTEMPT_MISMATCH', 'attempt must be an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'attemptId,order,orderHash,quote,quoteHash,route,routeHash,version'
    || record.version !== 1 || record.attemptId !== attemptId) {
    fail('ATTEMPT_MISMATCH', 'attempt fields are invalid');
  }
  let order: PackageOrder;
  let route: RoutePayload;
  let quote: SolverQuote;
  try {
    order = validatePackageOrderProfile(fromProtocolJson(record.order as never, 'attempt.order') as PackageOrderInput);
    route = routePayload(fromProtocolJson(record.route as never, 'attempt.route') as RoutePayloadInput);
    quote = solverQuote(fromProtocolJson(record.quote as never, 'attempt.quote') as SolverQuoteInput);
  } catch {
    fail('ATTEMPT_MISMATCH', 'attempt order, route, or quote is malformed');
  }
  const orderHash = hex(packageOrderHash(order));
  const routeHash = hex(routePayloadHash(route));
  const quoteHash = hex(solverQuoteHash(quote));
  if (`0x${String(record.orderHash)}` !== orderHash || `0x${String(record.routeHash)}` !== routeHash
    || `0x${String(record.quoteHash)}` !== quoteHash
    || !bytesEqual(route.orderHash, packageOrderHash(order)) || !bytesEqual(quote.routeHash, routePayloadHash(route))
    || !bytesEqual(quote.orderHash, packageOrderHash(order))) {
    fail('ATTEMPT_MISMATCH', 'attempt hashes do not match the canonical order, route, and quote');
  }
  if (!bytesEqual(quote.solverVerificationKey, solverVerificationKey)
    || !ed25519Verify(solverSignatureDigest(quote), quote.signature, solverVerificationKey)) {
    fail('ATTEMPT_MISMATCH', 'quote was not signed by this solver');
  }
  return Object.freeze({ attemptId, orderHash, routeHash, quoteHash, order, route, quote });
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('attempt API origin must be an absolute URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('attempt API origin must be a loopback HTTP origin');
  }
  return url.origin;
}

export class HttpArbitrumSepoliaAttemptProvider implements ArbitrumSepoliaAttemptProvider {
  readonly #origin: string;
  readonly #key: Uint8Array;
  readonly #fetch: typeof fetch;

  constructor(apiOrigin: string, solverVerificationKey: Uint8Array, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(apiOrigin);
    if (!(solverVerificationKey instanceof Uint8Array) || solverVerificationKey.length !== 32) {
      throw new Error('solver verification key must be 32 bytes');
    }
    this.#key = Uint8Array.from(solverVerificationKey);
    this.#fetch = fetchImplementation;
  }

  async resolve(attemptId: string): Promise<ArbitrumSepoliaExecutionAttempt | undefined> {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error('attempt ID is invalid');
    const response = await this.#fetch(`${this.#origin}${API_ARBITRUM_SEPOLIA_ATTEMPT_PATH}${attemptId}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return undefined;
    const text = await response.text();
    if (!response.ok || text.length > MAX_RESPONSE_BYTES) throw new Error(`attempt API request failed with HTTP ${response.status}`);
    return verifyArbitrumSepoliaAttempt(attemptId, JSON.parse(text) as unknown, this.#key);
  }
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(status === 200 ? stringifyProtocolJson(body as never, 'arbitrumExecutionResult') : JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > MAX_BODY_BYTES) throw new ArbitrumSepoliaExecutorError('INVALID_REQUEST', 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ArbitrumSepoliaExecutorError('INVALID_REQUEST', 'request body must be JSON');
  }
}

export function createArbitrumSepoliaExecutorServer(executor: Pick<ArbitrumSepoliaExecutor, 'advance'>): Server {
  return createServer((request, response) => {
    void (async () => {
      if (!isLoopbackPeer(request.socket.remoteAddress)) {
        send(response, 403, { error: { code: 'LOOPBACK_REQUIRED', message: 'Executor access is loopback-only.' } });
        return;
      }
      if (request.url !== SOLVER_ARBITRUM_SEPOLIA_EXECUTE_PATH || request.method !== 'POST') {
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown executor route.' } });
        return;
      }
      try {
        const body = await readBody(request);
        if (typeof body !== 'object' || body === null || Object.keys(body).join(',') !== 'attemptId'
          || typeof (body as { attemptId?: unknown }).attemptId !== 'string') {
          fail('INVALID_REQUEST', 'request must contain only attemptId');
        }
        send(response, 200, await executor.advance((body as { attemptId: string }).attemptId));
      } catch (error) {
        const code = error instanceof ArbitrumSepoliaExecutorError ? error.code : 'EXECUTION_FAILED';
        const status = code === 'INVALID_REQUEST' || code === 'INVALID_ATTEMPT' ? 400
          : code === 'ATTEMPT_NOT_FOUND' ? 404 : code === 'WRONG_CHAIN' ? 503 : 409;
        send(response, error instanceof ArbitrumSepoliaExecutorError ? status : 502, {
          error: { code, message: error instanceof ArbitrumSepoliaExecutorError ? error.message : 'Arbitrum execution failed closed.' },
        });
      }
    })();
  });
}

export function loadArbitrumSepoliaExecutorConfig(path: string): ArbitrumSepoliaExecutorConfig {
  if (!isAbsolute(path)) throw new Error('NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CONFIG must be an absolute path');
  const decoded = parseProtocolJson(readFileSync(resolve(path), 'utf8'), 'arbitrumSepoliaExecutorConfig');
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)
    || (decoded as Record<string, unknown>).version !== ARBITRUM_SEPOLIA_EXECUTOR_CONFIG_VERSION) {
    throw new Error(`Arbitrum Sepolia executor config must be version ${ARBITRUM_SEPOLIA_EXECUTOR_CONFIG_VERSION}`);
  }
  const { version: _version, ...config } = decoded as Record<string, unknown>;
  const checked = config as unknown as ArbitrumSepoliaExecutorConfig;
  validateConfig(checked);
  return checked;
}

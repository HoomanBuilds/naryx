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
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import {
  ARBITRUM_EXIT_CONTROLLER_ABI,
  ARBITRUM_EXIT_VIEWS_ABI,
  arbitrumExitTypedData,
  readArbitrumSepoliaOpenPosition,
  type ArbitrumExitAuthorization,
} from './arbitrum-sepolia-exit.js';
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  GMX_DATA_STORE_KEYS,
  arbitrumSepoliaAccountCodeHash,
  arbitrumSepoliaAccountOf,
  ceilDiv,
  createViemArbitrumSepoliaReadPort,
  gmxDecreaseExecutionFeeWei,
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
export const SOLVER_ARBITRUM_SEPOLIA_PREPARE_PATH = '/internal/solver/arbitrum-sepolia/prepare';
export const SOLVER_ARBITRUM_SEPOLIA_AUTHORIZE_PATH = '/internal/solver/arbitrum-sepolia/authorize';
export const SOLVER_ARBITRUM_SEPOLIA_PREPARE_EXIT_PATH = '/internal/solver/arbitrum-sepolia/prepare-exit';
export const SOLVER_ARBITRUM_SEPOLIA_AUTHORIZE_EXIT_PATH = '/internal/solver/arbitrum-sepolia/authorize-exit';
export const API_ARBITRUM_SEPOLIA_ATTEMPT_PATH = '/internal/solver/attempts/';
export const ARBITRUM_SEPOLIA_EXECUTOR_CONFIG_VERSION = 1;

const ATTEMPT_ID = /^arbitrum-async-[0-9a-f]{48}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const BPS_SCALE = 10_000n;
const GMX_USD_DECIMALS = 30;
const SCHEMA_VERSION = 3;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
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
  'function funding(bytes32 packageId, address owner) view returns (address account, bytes32 requestPayloadHash, uint256 collateralAtoms, uint256 spotQuoteAtoms, uint256 executionFeeWei, uint64 submissionDeadline, bool consumed)',
  'function requestEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint256 positionSizeBefore, uint256 positionSizeAfter, uint64 revision)',
  'function fundRequest(bytes32 packageId, VenueRequest venueRequest) payable',
  'function relayEvidence(bytes32 requestKey, uint64 expectedVersion)',
]);
export const ARBITRUM_ISOLATED_ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function spotPort() view returns (address)',
  'function spotBaseToken() view returns (address)',
]);
export const ARBITRUM_ACCOUNT_FACTORY_ABI = parseAbi([
  'function accountOf(address owner) view returns (address)',
  'function ownerOf(address account) view returns (address)',
  'function implementation() view returns (address)',
  'function accountCodeHash() view returns (bytes32)',
  'function adapter() view returns (address)',
  'function exitController() view returns (address)',
  'function create(address owner) returns (address)',
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
const EXIT_STATUS = Object.freeze({ NONE: 0, PENDING: 1, EXECUTED: 2, CANCELLED: 3, FROZEN: 4, RECOVERED: 5, CONFLICT: 6 });
const EXIT_STATUS_NAMES = Object.freeze(Object.keys(EXIT_STATUS)) as readonly (keyof typeof EXIT_STATUS)[];

export interface ArbitrumSepoliaExecutorConfig {
  readonly domain: DomainRef;
  readonly coordinator: ArbitrumSepoliaContractIdentity;
  readonly adapter: ArbitrumSepoliaContractIdentity;
  /** The shared GmxV2IsolatedAccountFactory; every owner settles through `accountOf(owner)`. */
  readonly accountFactory: ArbitrumSepoliaContractIdentity;
  /** The factory's account implementation, which every account clones. */
  readonly accountImplementation: ArbitrumSepoliaContractIdentity;
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
  /** The factory-bound GmxV2ExitController. Exits fail closed without it. */
  readonly exitController?: ArbitrumSepoliaContractIdentity;
  /** GMX callback gas for a full close, whose callback also sells the spot leg and releases the package. */
  readonly exitCallbackGasLimit?: bigint;
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
  /** The logs of a mined transaction. */
  receiptLogs(hash: Hex): Promise<readonly Readonly<{ address: Address; topics: readonly Hex[]; data: Hex }>[]>;
}

export type ArbitrumSepoliaExecutionStep =
  | 'APPROVE_COORDINATOR' | 'RESERVE' | 'SUBMIT' | 'MARK_PENDING' | 'RELAY' | 'CLOSE'
  | 'SUBMIT_EXIT' | 'RECONCILE_EXIT' | 'PROCESS_RECONCILIATION' | 'FINALIZE_EXIT';

export interface ArbitrumSepoliaExecutionResult {
  readonly version: 1;
  readonly attemptId: string;
  /** CANCELLED: an exit's GMX close was cancelled or recovered, so the package stays open. */
  readonly status:
    | 'AWAITING_OWNER_SIGNATURE' | 'AWAITING_OWNER_FUNDING'
    | 'IN_FLIGHT' | 'VENUE_PENDING' | 'SETTLED' | 'RECOVERY_REQUIRED' | 'FAILED' | 'CANCELLED';
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
    receiptLogs: async (hash: Hex) => (await publicClient.getTransactionReceipt({ hash })).logs
      .map((log) => ({ address: lower(log.address), topics: log.topics, data: log.data })),
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

/** The unsigned, journaled plan. The owner's reservation signature is journaled separately. */
export interface ArbitrumSepoliaExecutionPlan {
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly account: Address;
  readonly terms: Terms;
  readonly request: VenueRequest;
}

/**
 * What the owner's browser wallet needs: the EIP-712 reservation to sign, and the two wallet
 * transactions that fund the request (collateral approval, then `fundRequest` with the GMX fee).
 * Every integer is a decimal string.
 */
export interface ArbitrumSepoliaOwnerAuthorizationRequest {
  readonly version: 1;
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly chainId: number;
  readonly owner: Address;
  readonly account: Address;
  readonly accountFactory: Address;
  readonly coordinator: Address;
  readonly adapter: Address;
  readonly typedData: Readonly<{
    domain: Readonly<{ name: string; version: string; chainId: number; verifyingContract: Address }>;
    types: Readonly<{ ReserveAsyncPackage: readonly Readonly<{ name: 'termsHash'; type: 'bytes32' }>[] }>;
    primaryType: 'ReserveAsyncPackage';
    message: Readonly<{ termsHash: Hex }>;
  }>;
  readonly digest: Hex;
  readonly signed: boolean;
  readonly funding: Readonly<{
    token: Address;
    spender: Address;
    approveAtoms: string;
    collateralAtoms: string;
    spotQuoteAtoms: string;
    executionFeeWei: string;
    fundRequest: Readonly<{ to: Address; data: Hex; value: string }>;
    reclaimAfterUnixSeconds: string;
  }>;
  readonly summary: Readonly<{
    nonce: string;
    sizeDeltaUsd: string;
    acceptablePrice: string;
    spotBaseAtoms: string;
    rollbackMinQuoteAtoms: string;
    bondAtoms: string;
    solver: Address;
    submissionDeadline: string;
    venueDeadline: string;
    recoveryDeadline: string;
  }>;
}

/** The journaled full close: the owner's exit authorization and its EIP-712 digest. */
export interface ArbitrumSepoliaExitPlan {
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly account: Address;
  readonly authorization: ArbitrumExitAuthorization;
  readonly digest: Hex;
}

/** What the owner's browser wallet signs to close its package. Integers are decimal strings. */
export interface ArbitrumSepoliaExitAuthorizationRequest {
  readonly version: 1;
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly chainId: number;
  readonly owner: Address;
  readonly account: Address;
  readonly exitController: Address;
  readonly typedData: Readonly<{
    domain: Readonly<{ name: string; version: string; chainId: number; verifyingContract: Address }>;
    types: Readonly<{ ExitAuthorization: readonly Readonly<{ name: string; type: string }>[] }>;
    primaryType: 'ExitAuthorization';
    message: Readonly<Record<string, string | boolean>>;
  }>;
  readonly digest: Hex;
  readonly signed: boolean;
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
    config.coordinator, config.adapter, config.accountFactory, config.accountImplementation, config.collateralToken,
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
    || config.maxTerminalResidualAtoms > config.maxIntermediateResidualAtoms
    || (config.exitController === undefined) !== (config.exitCallbackGasLimit === undefined)
    || (config.exitController !== undefined && (!ADDRESS.test(config.exitController.address)
      || !HASH.test(config.exitController.expectedCodeHash) || config.exitController.expectedCodeHash === ZERO_HASH))
    || (config.exitCallbackGasLimit !== undefined
      && (typeof config.exitCallbackGasLimit !== 'bigint' || config.exitCallbackGasLimit <= 0n))) {
    throw new Error('Arbitrum Sepolia executor configuration is incomplete or invalid');
  }
}

type TransactionRecord = { txHash: Hex; status: 'SENT' | 'CONFIRMED' | 'REVERTED' };

/** One durable send ledger: a recorded transaction is never resent. */
interface TransactionLedger {
  transaction(attemptId: string, step: ArbitrumSepoliaExecutionStep): TransactionRecord | undefined;
  transactions(attemptId: string): { step: ArbitrumSepoliaExecutionStep; txHash: Hex; status: string }[];
  recordSent(attemptId: string, step: ArbitrumSepoliaExecutionStep, txHash: Hex): void;
  recordOutcome(attemptId: string, step: ArbitrumSepoliaExecutionStep, status: 'CONFIRMED' | 'REVERTED'): void;
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
        owner_signature TEXT,
        failed_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS arbitrum_execution_transactions (
        attempt_id TEXT NOT NULL REFERENCES arbitrum_execution_plans(attempt_id),
        step TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('SENT', 'CONFIRMED', 'REVERTED')),
        PRIMARY KEY (attempt_id, step)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS arbitrum_exit_plans (
        attempt_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        owner_signature TEXT,
        request_key TEXT UNIQUE,
        final_receipt TEXT,
        failed_reason TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS arbitrum_exit_transactions (
        attempt_id TEXT NOT NULL REFERENCES arbitrum_exit_plans(attempt_id),
        step TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('SENT', 'CONFIRMED', 'REVERTED')),
        PRIMARY KEY (attempt_id, step)
      ) STRICT;
    `);
    // Version 2 journals gain only the additive exit tables above.
    this.#db.prepare('UPDATE arbitrum_executor_schema SET version = ? WHERE version = 2').run(SCHEMA_VERSION);
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

  ownerSignature(attemptId: string): Hex | undefined {
    const row = this.#db.prepare('SELECT owner_signature FROM arbitrum_execution_plans WHERE attempt_id = ?')
      .get(attemptId) as { owner_signature: string | null } | undefined;
    return (row?.owner_signature ?? undefined) as Hex | undefined;
  }

  /** Records the owner's signature once; a different signature for the same plan is refused. */
  saveOwnerSignature(attemptId: string, signature: Hex): void {
    this.#db.prepare(`
      UPDATE arbitrum_execution_plans SET owner_signature = ? WHERE attempt_id = ? AND owner_signature IS NULL
    `).run(signature, attemptId);
    if (this.ownerSignature(attemptId) !== signature) {
      fail('JOURNAL_CONFLICT', 'a different owner signature is already journaled for the attempt');
    }
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

  exitPlan(attemptId: string): ArbitrumSepoliaExitPlan | undefined {
    const row = this.#db.prepare('SELECT plan_json FROM arbitrum_exit_plans WHERE attempt_id = ?')
      .get(attemptId) as { plan_json: string } | undefined;
    return row === undefined
      ? undefined
      : parseProtocolJson(row.plan_json, 'arbitrumExitPlan') as unknown as ArbitrumSepoliaExitPlan;
  }

  saveExitPlan(plan: ArbitrumSepoliaExitPlan): ArbitrumSepoliaExitPlan {
    this.#db.prepare(`
      INSERT INTO arbitrum_exit_plans (attempt_id, package_id, plan_json) VALUES (?, ?, ?)
      ON CONFLICT(attempt_id) DO NOTHING
    `).run(plan.attemptId, plan.packageId, stringifyProtocolJson(plan as never, 'arbitrumExitPlan'));
    const stored = this.exitPlan(plan.attemptId);
    if (stored === undefined || stored.packageId !== plan.packageId) {
      fail('JOURNAL_CONFLICT', 'a different exit plan is already journaled for the attempt');
    }
    return stored;
  }

  #exitColumn(attemptId: string, column: 'owner_signature' | 'request_key' | 'final_receipt' | 'failed_reason') {
    const row = this.#db.prepare(`SELECT ${column} AS value FROM arbitrum_exit_plans WHERE attempt_id = ?`)
      .get(attemptId) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  /** Sets a write-once exit column; a different value for the same attempt is refused. */
  #setExitColumn(attemptId: string, column: 'owner_signature' | 'request_key' | 'final_receipt', value: string): void {
    this.#db.prepare(`UPDATE arbitrum_exit_plans SET ${column} = ? WHERE attempt_id = ? AND ${column} IS NULL`)
      .run(value, attemptId);
    if (this.#exitColumn(attemptId, column) !== value) {
      fail('JOURNAL_CONFLICT', `a different exit ${column.replace('_', ' ')} is already journaled for the attempt`);
    }
  }

  exitOwnerSignature(attemptId: string): Hex | undefined {
    return this.#exitColumn(attemptId, 'owner_signature') as Hex | undefined;
  }

  saveExitOwnerSignature(attemptId: string, signature: Hex): void {
    this.#setExitColumn(attemptId, 'owner_signature', signature);
  }

  exitRequestKey(attemptId: string): Hex | undefined {
    return this.#exitColumn(attemptId, 'request_key') as Hex | undefined;
  }

  saveExitRequestKey(attemptId: string, requestKey: Hex): void {
    this.#setExitColumn(attemptId, 'request_key', requestKey);
  }

  /** The final package receipt commitment the exit controller recorded. */
  exitFinalReceipt(attemptId: string): Hex | undefined {
    return this.#exitColumn(attemptId, 'final_receipt') as Hex | undefined;
  }

  saveExitFinalReceipt(attemptId: string, commitment: Hex): void {
    this.#setExitColumn(attemptId, 'final_receipt', commitment);
  }

  exitFailed(attemptId: string): string | undefined {
    return this.#exitColumn(attemptId, 'failed_reason');
  }

  markExitFailed(attemptId: string, reason: string): void {
    this.#db.prepare('UPDATE arbitrum_exit_plans SET failed_reason = ? WHERE attempt_id = ? AND failed_reason IS NULL')
      .run(reason, attemptId);
  }

  readonly exitLedger: TransactionLedger = Object.freeze({
    transaction: (attemptId: string, step: ArbitrumSepoliaExecutionStep) => this.#db.prepare(
      'SELECT tx_hash AS txHash, status FROM arbitrum_exit_transactions WHERE attempt_id = ? AND step = ?',
    ).get(attemptId, step) as TransactionRecord | undefined,
    transactions: (attemptId: string) => this.#db.prepare(`
      SELECT step, tx_hash AS txHash, status FROM arbitrum_exit_transactions WHERE attempt_id = ? ORDER BY rowid
    `).all(attemptId) as { step: ArbitrumSepoliaExecutionStep; txHash: Hex; status: string }[],
    recordSent: (attemptId: string, step: ArbitrumSepoliaExecutionStep, txHash: Hex) => {
      this.#db.prepare(`
        INSERT INTO arbitrum_exit_transactions (attempt_id, step, tx_hash, status) VALUES (?, ?, ?, 'SENT')
      `).run(attemptId, step, txHash);
    },
    recordOutcome: (attemptId: string, step: ArbitrumSepoliaExecutionStep, status: 'CONFIRMED' | 'REVERTED') => {
      this.#db.prepare(`
        UPDATE arbitrum_exit_transactions SET status = ? WHERE attempt_id = ? AND step = ? AND status = 'SENT'
      `).run(status, attemptId, step);
    },
  });

  close(): void {
    this.#db.close();
  }
}

export interface ArbitrumSepoliaExecutorOptions {
  readonly config: ArbitrumSepoliaExecutorConfig;
  readonly attempts: ArbitrumSepoliaAttemptProvider;
  readonly chain: ArbitrumSepoliaWritePort;
  readonly journal: SqliteArbitrumSepoliaExecutionJournal;
}

class InFlight extends Error {}

export class ArbitrumSepoliaExecutor {
  readonly #options: ArbitrumSepoliaExecutorOptions;
  // The adapter funds one package at a time, so attempts advance strictly one after another.
  #queue: Promise<unknown> = Promise.resolve();
  // Every terminal poll asks to advance its attempt; a call while that attempt's advance is queued
  // or running joins it, so polling many attempts never grows the queue beyond one entry each.
  readonly #advancing = new Map<string, Promise<ArbitrumSepoliaExecutionResult>>();

  constructor(options: ArbitrumSepoliaExecutorOptions) {
    validateConfig(options.config);
    if (!ADDRESS.test(options.chain.account)) {
      throw new Error('Arbitrum Sepolia solver account must be a lowercase address');
    }
    this.#options = options;
  }

  advance(attemptId: string): Promise<ArbitrumSepoliaExecutionResult> {
    const inFlight = this.#advancing.get(attemptId);
    if (inFlight !== undefined) return inFlight;
    const next = this.#enqueue(attemptId, async () => {
      await this.#requireChain();
      const route = await this.#route(attemptId);
      return route.exit ? this.#advanceExit(attemptId, route.attempt) : this.#advance(attemptId, route.attempt);
    });
    this.#advancing.set(attemptId, next);
    const settle = () => {
      if (this.#advancing.get(attemptId) === next) this.#advancing.delete(attemptId);
    };
    next.then(settle, settle);
    return next;
  }

  /** Builds and journals the unsigned full close, then returns what the owner's wallet must sign. */
  prepareExit(attemptId: string): Promise<ArbitrumSepoliaExitAuthorizationRequest> {
    return this.#enqueue(attemptId, async () => {
      await this.#requireChain();
      const plan = await this.#journaledExitPlan(attemptId);
      if (this.#options.journal.exitFailed(attemptId) !== undefined) fail('ATTEMPT_FAILED', 'attempt already failed closed');
      return this.#exitAuthorizationRequest(plan);
    });
  }

  /** Journals the owner's EIP-712 exit signature after recovering it to the package owner. Nothing is sent. */
  authorizeExit(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaExitAuthorizationRequest> {
    return this.#enqueue(attemptId, async () => {
      if (typeof ownerSignature !== 'string' || !SIGNATURE.test(ownerSignature)) {
        fail('INVALID_SIGNATURE', 'owner signature must be a lowercase 65-byte hex string');
      }
      const { journal } = this.#options;
      const plan = journal.exitPlan(attemptId);
      if (plan === undefined) fail('NOT_PREPARED', 'attempt has no prepared exit authorization');
      if (journal.exitFailed(attemptId) !== undefined) fail('ATTEMPT_FAILED', 'attempt already failed closed');
      let signer: Address;
      try {
        signer = lower(await recoverTypedDataAddress({
          ...arbitrumExitTypedData(plan.authorization, this.#exitController()),
          signature: ownerSignature as Hex,
        } as never));
      } catch {
        fail('INVALID_SIGNATURE', 'owner signature is malformed');
      }
      if (signer !== lower(plan.authorization.owner)) fail('INVALID_SIGNATURE', 'signature was not made by the package owner');
      journal.saveExitOwnerSignature(attemptId, ownerSignature as Hex);
      return this.#exitAuthorizationRequest(plan);
    });
  }

  /** Builds and journals the unsigned plan, then returns what the owner's wallet must sign and send. */
  prepare(attemptId: string): Promise<ArbitrumSepoliaOwnerAuthorizationRequest> {
    return this.#enqueue(attemptId, async () => {
      await this.#requireChain();
      if (this.#options.journal.failed(attemptId) !== undefined) fail('ATTEMPT_FAILED', 'attempt already failed closed');
      return this.#authorizationRequest(await this.#journaledPlan(attemptId));
    });
  }

  /**
   * Journals the owner's EIP-712 reservation signature after recovering it to the plan owner. No
   * transaction is sent here; the readiness-gated handoff later calls `advance`.
   */
  authorize(attemptId: string, ownerSignature: string): Promise<ArbitrumSepoliaOwnerAuthorizationRequest> {
    return this.#enqueue(attemptId, async () => {
      if (typeof ownerSignature !== 'string' || !SIGNATURE.test(ownerSignature)) {
        fail('INVALID_SIGNATURE', 'owner signature must be a lowercase 65-byte hex string');
      }
      const { journal } = this.#options;
      const plan = journal.plan(attemptId);
      if (plan === undefined) fail('NOT_PREPARED', 'attempt has no prepared owner authorization');
      if (journal.failed(attemptId) !== undefined) fail('ATTEMPT_FAILED', 'attempt already failed closed');
      let signer: Address;
      try {
        signer = lower(await recoverTypedDataAddress({
          ...arbitrumAsyncReserveTypedData(plan.terms, this.#coordinator()),
          signature: ownerSignature as Hex,
        } as never));
      } catch {
        fail('INVALID_SIGNATURE', 'owner signature is malformed');
      }
      if (signer !== lower(plan.terms.owner)) fail('INVALID_SIGNATURE', 'signature was not made by the package owner');
      journal.saveOwnerSignature(attemptId, ownerSignature as Hex);
      return this.#authorizationRequest(plan);
    });
  }

  #enqueue<T>(attemptId: string, run: () => Promise<T>): Promise<T> {
    if (!ATTEMPT_ID.test(attemptId)) return Promise.reject(new ArbitrumSepoliaExecutorError('INVALID_ATTEMPT', 'attempt ID is invalid'));
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #journaledPlan(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExecutionPlan> {
    const { journal } = this.#options;
    return journal.plan(attemptId) ?? journal.savePlan(await this.#plan(attemptId, resolved));
  }

  async #resolve(attemptId: string): Promise<ArbitrumSepoliaExecutionAttempt> {
    const attempt = await this.#options.attempts.resolve(attemptId);
    if (attempt === undefined || attempt.attemptId !== attemptId) fail('ATTEMPT_NOT_FOUND', 'selected attempt was not found');
    return attempt;
  }

  /** A journaled plan decides an attempt's kind; otherwise its selected order's action does. */
  async #route(attemptId: string): Promise<{ exit: boolean; attempt?: ArbitrumSepoliaExecutionAttempt }> {
    const { journal } = this.#options;
    if (journal.exitPlan(attemptId) !== undefined) return { exit: true };
    if (journal.plan(attemptId) !== undefined) return { exit: false };
    const attempt = await this.#resolve(attemptId);
    return { exit: attempt.order.action === 'EXIT', attempt };
  }

  #authorizationRequest(plan: ArbitrumSepoliaExecutionPlan): ArbitrumSepoliaOwnerAuthorizationRequest {
    const coordinator = this.#coordinator();
    const typedData = arbitrumAsyncReserveTypedData(plan.terms, coordinator);
    const { request, terms } = plan;
    return Object.freeze({
      version: 1,
      attemptId: plan.attemptId,
      packageId: plan.packageId,
      chainId: Number(ARBITRUM_SEPOLIA_CHAIN_ID),
      owner: lower(terms.owner),
      account: plan.account,
      accountFactory: lower(this.#options.config.accountFactory.address),
      coordinator,
      adapter: lower(terms.adapter),
      typedData,
      digest: hashTypedData(typedData as never),
      signed: this.#options.journal.ownerSignature(plan.attemptId) !== undefined,
      funding: Object.freeze({
        token: lower(this.#options.config.collateralToken.address),
        spender: lower(terms.adapter),
        approveAtoms: (request.collateralAtoms + request.spot.maxQuoteAtoms).toString(),
        collateralAtoms: request.collateralAtoms.toString(),
        spotQuoteAtoms: request.spot.maxQuoteAtoms.toString(),
        executionFeeWei: request.executionFeeWei.toString(),
        fundRequest: Object.freeze({
          to: lower(terms.adapter),
          data: encodeFunctionData({
            abi: ARBITRUM_GMX_ADAPTER_ABI, functionName: 'fundRequest', args: [plan.packageId, request as never],
          }),
          value: request.executionFeeWei.toString(),
        }),
        reclaimAfterUnixSeconds: request.submissionDeadline.toString(),
      }),
      summary: Object.freeze({
        nonce: terms.nonce.toString(),
        sizeDeltaUsd: (-request.sizeDelta).toString(),
        acceptablePrice: request.acceptablePrice.toString(),
        spotBaseAtoms: request.spot.baseAtoms.toString(),
        rollbackMinQuoteAtoms: request.spot.rollbackMinQuoteAtoms.toString(),
        bondAtoms: terms.bondAtoms.toString(),
        solver: lower(terms.solver),
        submissionDeadline: request.submissionDeadline.toString(),
        venueDeadline: request.venueDeadline.toString(),
        recoveryDeadline: request.recoveryDeadline.toString(),
      }),
    });
  }

  async #advance(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExecutionResult> {
    const { chain, journal } = this.#options;
    await this.#requireChain();
    const failure = journal.failed(attemptId);
    if (failure !== undefined) return this.#result(attemptId, journal.plan(attemptId)!, 'FAILED', undefined);
    const plan = await this.#journaledPlan(attemptId, resolved);
    try {
      let state = await this.#state(plan);
      if (state.state === STATE.NONE) {
        // The service holds no owner key: nothing is reserved until the owner has signed the
        // reservation and funded the request from its own wallet.
        const ownerSignature = journal.ownerSignature(attemptId);
        if (ownerSignature === undefined) return this.#result(attemptId, plan, 'AWAITING_OWNER_SIGNATURE', state);
        if (await chain.latestBlockTimestamp() >= plan.terms.submissionDeadline) {
          journal.markFailed(attemptId, 'submission deadline passed before the owner signed and funded');
          return this.#result(attemptId, plan, 'FAILED', state);
        }
        const funded = await this.#read(plan.terms.adapter, ARBITRUM_GMX_ADAPTER_ABI, 'funding', [plan.packageId, plan.terms.owner]) as readonly unknown[];
        const fundedHash = hashValue(funded[1], 'funding request hash');
        if (fundedHash === ZERO_HASH) return this.#result(attemptId, plan, 'AWAITING_OWNER_FUNDING', state);
        if (fundedHash !== plan.terms.requestPayloadHash || !sameAddress(funded[0], plan.account) || funded[6] !== false) {
          fail('CHAIN_MISMATCH', 'owner funding belongs to another request or account');
        }
        await this.#ensureAllowance(plan, 'APPROVE_COORDINATOR', this.#coordinator(),
          plan.terms.bondAtoms + plan.terms.recoveryReserveAtoms);
        await this.#send(plan, 'RESERVE', {
          address: this.#coordinator(), abi: ARBITRUM_ASYNC_COORDINATOR_ABI, functionName: 'reserve',
          args: [plan.terms, ownerSignature],
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

  async #journaledExitPlan(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExitPlan> {
    const { journal } = this.#options;
    return journal.exitPlan(attemptId) ?? journal.saveExitPlan(await this.#exitPlan(attemptId, resolved));
  }

  #exitController(): Address {
    const identity = this.#options.config.exitController;
    if (identity === undefined) fail('EXIT_UNAVAILABLE', 'the Arbitrum Sepolia exit controller is not configured');
    return lower(identity.address);
  }

  #exitAuthorizationRequest(plan: ArbitrumSepoliaExitPlan): ArbitrumSepoliaExitAuthorizationRequest {
    const exitController = this.#exitController();
    const typedData = arbitrumExitTypedData(plan.authorization, exitController);
    const message = Object.fromEntries(Object.entries(plan.authorization).map(([name, value]) => [
      name, typeof value === 'bigint' ? value.toString() : typeof value === 'boolean' ? value : String(value).toLowerCase(),
    ]));
    return Object.freeze({
      version: 1,
      attemptId: plan.attemptId,
      packageId: plan.packageId,
      chainId: Number(ARBITRUM_SEPOLIA_CHAIN_ID),
      owner: lower(plan.authorization.owner),
      account: plan.account,
      exitController,
      typedData: Object.freeze({ ...typedData, message: Object.freeze(message) }),
      digest: plan.digest,
      signed: this.#options.journal.exitOwnerSignature(plan.attemptId) !== undefined,
    });
  }

  #exitResult(
    plan: ArbitrumSepoliaExitPlan,
    status: ArbitrumSepoliaExecutionResult['status'],
    exitStatus: number | undefined,
  ): ArbitrumSepoliaExecutionResult {
    const requestKey = this.#options.journal.exitRequestKey(plan.attemptId);
    return Object.freeze({
      version: 1,
      attemptId: plan.attemptId,
      status,
      packageId: plan.packageId,
      coordinatorState: exitStatus === undefined ? 'EXIT_UNKNOWN' : `EXIT_${EXIT_STATUS_NAMES[exitStatus]!}`,
      requestKey: requestKey ?? null,
      transactions: Object.freeze(this.#options.journal.exitLedger.transactions(plan.attemptId)
        .map((entry) => Object.freeze(entry))),
    });
  }

  async #exitEvidence(requestKey: Hex) {
    const record = await this.#read(this.#exitController(), ARBITRUM_EXIT_CONTROLLER_ABI, 'exitEvidence', [requestKey]) as readonly unknown[];
    const status = Number(record[0]);
    if (!Number.isSafeInteger(status) || status < 0 || status >= EXIT_STATUS_NAMES.length
      || typeof record[3] !== 'boolean' || typeof record[4] !== 'boolean') {
      fail('CHAIN_MISMATCH', 'exit evidence is invalid');
    }
    return Object.freeze({ status, reconciling: record[3], released: record[4] });
  }

  /**
   * Live preconditions of `submitFullClose`, read just before the solver pays the GMX execution fee: the
   * pinned code, the factory binding, the open package and its full short, no other active exit, the
   * authorization nonce, and the controller's own digest of the journaled authorization.
   */
  async #requireExitSubmittable(plan: ArbitrumSepoliaExitPlan): Promise<string | undefined> {
    const { config, chain } = this.#options;
    const exitController = this.#exitController();
    for (const [identity, name] of [
      [config.exitController!, 'exit controller'], [config.adapter, 'adapter'], [config.accountFactory, 'account factory'],
      [config.accountImplementation, 'account implementation'], [config.collateralToken, 'collateral token'],
      [config.spotPort, 'spot port'], [config.gmxDataStore, 'GMX data store'],
    ] as const) await requireArbitrumSepoliaCode(chain, identity, name);
    const { authorization } = plan;
    const [boundExit, activePackage, activeRequest, shortSize, longSize, activeExit, nonce, digest] = await Promise.all([
      this.#read(lower(config.accountFactory.address), ARBITRUM_ACCOUNT_FACTORY_ABI, 'exitController'),
      this.#read(lower(config.adapter.address), ARBITRUM_EXIT_VIEWS_ABI, 'activePackageOf', [plan.account]),
      this.#read(lower(config.adapter.address), ARBITRUM_EXIT_VIEWS_ABI, 'activeRequestKeyOf', [plan.account]),
      this.#read(plan.account, ARBITRUM_EXIT_VIEWS_ABI, 'positionSize', [false]),
      this.#read(plan.account, ARBITRUM_EXIT_VIEWS_ABI, 'positionSize', [true]),
      this.#read(exitController, ARBITRUM_EXIT_CONTROLLER_ABI, 'activeExitRequestKey', [plan.account]),
      this.#read(exitController, ARBITRUM_EXIT_CONTROLLER_ABI, 'nextNonce', [plan.account]),
      this.#read(exitController, ARBITRUM_EXIT_CONTROLLER_ABI, 'exitDigest', [authorization]),
    ]);
    if (!sameAddress(boundExit, exitController)) return 'the factory no longer binds the configured exit controller';
    if (hashValue(activePackage, 'active package') !== plan.packageId
      || hashValue(activeRequest, 'active request key') !== authorization.entryRequestKey) {
      return 'the package is no longer open on the adapter';
    }
    if (shortSize !== authorization.fullCloseSizeUsd || longSize !== 0n) return 'the GMX position changed since the exit was prepared';
    if (hashValue(activeExit, 'active exit') !== ZERO_HASH) return 'another exit for the account is already active';
    if (nonce !== authorization.nonce) return 'the exit authorization nonce was already used';
    if (hashValue(digest, 'exitDigest') !== plan.digest) return 'the exit controller digest no longer matches the authorization';
    return undefined;
  }

  /** The exit request key the controller emitted in the confirmed submission for exactly this digest. */
  async #submittedExitKey(plan: ArbitrumSepoliaExitPlan, txHash: Hex): Promise<Hex> {
    const exitController = this.#exitController();
    const keys: Hex[] = [];
    for (const log of await this.#options.chain.receiptLogs(txHash)) {
      if (!sameAddress(log.address, exitController)) continue;
      try {
        const event = decodeEventLog({ abi: ARBITRUM_EXIT_CONTROLLER_ABI, topics: log.topics as never, data: log.data });
        const args = event.args as { packageId?: Hex; requestKey?: Hex; authorizationHash?: Hex };
        if (event.eventName === 'ExitSubmitted' && hashValue(args.packageId, 'exit package') === plan.packageId
          && hashValue(args.authorizationHash, 'exit authorization') === plan.digest) {
          keys.push(hashValue(args.requestKey, 'exit request key'));
        }
      } catch {
        continue;
      }
    }
    if (keys.length !== 1 || keys[0] === ZERO_HASH) fail('CHAIN_MISMATCH', 'the submission did not emit exactly one matching exit');
    return keys[0]!;
  }

  /**
   * Submits the owner-signed full close once, paying the GMX execution fee, then drives the controller:
   * GMX keepers execute or cancel the decrease, whose callback normally sells the spot leg and records
   * the final receipt. An executed but unreleased exit is finalized once; a close still pending after
   * `cancelAfter` is cancelled or reconciled once, and processed once more if it stays reconciling.
   * Anything left after those single attempts is reported for recovery rather than retried.
   */
  async #advanceExit(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExecutionResult> {
    const { chain, journal } = this.#options;
    const ledger = journal.exitLedger;
    const plan = await this.#journaledExitPlan(attemptId, resolved);
    if (journal.exitFailed(attemptId) !== undefined) return this.#exitResult(plan, 'FAILED', undefined);
    const exitController = this.#exitController();
    const control = (step: ArbitrumSepoliaExecutionStep, functionName: string, requestKey: Hex) => this.#send(plan, step, {
      address: exitController, abi: ARBITRUM_EXIT_CONTROLLER_ABI, functionName, args: [requestKey],
    }, ledger);
    try {
      let requestKey = journal.exitRequestKey(attemptId);
      if (requestKey === undefined) {
        const signature = journal.exitOwnerSignature(attemptId);
        if (signature === undefined) return this.#exitResult(plan, 'AWAITING_OWNER_SIGNATURE', undefined);
        if (ledger.transaction(attemptId, 'SUBMIT_EXIT') === undefined) {
          const reason = await chain.latestBlockTimestamp() >= plan.authorization.authorizationExpiry
            ? 'the exit authorization expired before submission'
            : await this.#requireExitSubmittable(plan);
          if (reason !== undefined) {
            journal.markExitFailed(attemptId, reason);
            return this.#exitResult(plan, 'FAILED', undefined);
          }
        }
        const txHash = await this.#send(plan, 'SUBMIT_EXIT', {
          address: exitController, abi: ARBITRUM_EXIT_CONTROLLER_ABI, functionName: 'submitFullClose',
          args: [plan.authorization, signature], value: plan.authorization.executionFeeWei,
        }, ledger);
        requestKey = await this.#submittedExitKey(plan, txHash);
        journal.saveExitRequestKey(attemptId, requestKey);
      }
      let exit = await this.#exitEvidence(requestKey);
      if (exit.status === EXIT_STATUS.EXECUTED && !exit.released) {
        await control('FINALIZE_EXIT', 'finalizeExecutedExit', requestKey);
        exit = await this.#exitEvidence(requestKey);
      } else if (exit.status === EXIT_STATUS.PENDING || exit.status === EXIT_STATUS.FROZEN) {
        if (!exit.reconciling && await chain.latestBlockTimestamp() >= plan.authorization.cancelAfter) {
          await control('RECONCILE_EXIT', 'requestCancellationOrReconciliation', requestKey);
          exit = await this.#exitEvidence(requestKey);
        } else if (exit.reconciling && ledger.transaction(attemptId, 'PROCESS_RECONCILIATION') === undefined) {
          await control('PROCESS_RECONCILIATION', 'processReconciliation', requestKey);
          exit = await this.#exitEvidence(requestKey);
        }
      }
      if (exit.status === EXIT_STATUS.EXECUTED && exit.released) {
        const receipt = await this.#read(exitController, ARBITRUM_EXIT_CONTROLLER_ABI, 'finalPackageReceipt', [requestKey]) as Record<string, unknown>;
        const commitment = hashValue(receipt.commitment, 'final receipt commitment');
        if (commitment === ZERO_HASH || hashValue(receipt.exitRequestKey, 'final receipt exit') !== requestKey
          || !sameAddress(receipt.recipient, plan.authorization.owner)) {
          fail('CHAIN_MISMATCH', 'released exit carries no matching final package receipt');
        }
        journal.saveExitFinalReceipt(attemptId, commitment);
        return this.#exitResult(plan, 'SETTLED', exit.status);
      }
      if (exit.status === EXIT_STATUS.CANCELLED || exit.status === EXIT_STATUS.RECOVERED) {
        return this.#exitResult(plan, 'CANCELLED', exit.status);
      }
      const waiting = (exit.status === EXIT_STATUS.PENDING || exit.status === EXIT_STATUS.FROZEN)
        && ledger.transaction(attemptId, 'PROCESS_RECONCILIATION') === undefined;
      return this.#exitResult(plan, waiting ? 'VENUE_PENDING' : 'RECOVERY_REQUIRED', exit.status);
    } catch (error) {
      if (error instanceof InFlight) return this.#exitResult(plan, 'IN_FLIGHT', undefined);
      if (error instanceof ArbitrumSepoliaExecutorError && error.code === 'TRANSACTION_REVERTED') {
        // Only a reverted submission leaves no exit on GMX; any later revert leaves a live exit to recover.
        if (journal.exitRequestKey(attemptId) === undefined) {
          journal.markExitFailed(attemptId, error.message);
          return this.#exitResult(plan, 'FAILED', undefined);
        }
        return this.#exitResult(plan, 'RECOVERY_REQUIRED', undefined);
      }
      throw error;
    }
  }

  /** Derives the owner's full close from the selected EXIT attempt and the open package on chain. */
  async #exitPlan(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExitPlan> {
    const { config, chain } = this.#options;
    const exitController = this.#exitController();
    const callbackGasLimit = config.exitCallbackGasLimit;
    if (callbackGasLimit === undefined) fail('EXIT_UNAVAILABLE', 'the exit callback gas limit is not configured');
    const attempt = resolved ?? await this.#resolve(attemptId);
    const { order, route } = attempt;
    if (order.domain.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID
      || order.domain.domainManifestVersion !== config.domain.domainManifestVersion
      || !bytesEqual(order.domain.domainManifestHash, config.domain.domainManifestHash)
      || order.settlementClass !== 'ASYNC_BONDED_SOLVER' || order.action !== 'EXIT'
      || route.executionPlanKind !== 'EVM_ASYNC_REQUEST' || route.recoveryPlan === undefined
      || order.entryReceiptHash === undefined || order.minSpotQuoteOut === undefined
      || order.minExitQuoteOutcome === undefined) {
      fail('ATTEMPT_MISMATCH', 'attempt is not a reviewed Arbitrum Sepolia async exit');
    }
    const owner = lower(order.owner);
    const solver = chain.account;
    const factory = lower(config.accountFactory.address);
    const implementation = lower(config.accountImplementation.address);
    if (!ADDRESS.test(owner) || owner === solver) fail('ACCOUNT_MISMATCH', 'package owner must be a wallet other than the solver');
    const account = arbitrumSepoliaAccountOf(factory, implementation, owner);
    if (lower(route.settlementAccount) !== account || lower(order.settlementAccount) !== account) {
      fail('ACCOUNT_MISMATCH', 'settlement account is not the owner factory account');
    }
    for (const [identity, name] of [
      [config.exitController!, 'exit controller'], [config.adapter, 'adapter'], [config.accountFactory, 'account factory'],
      [config.accountImplementation, 'account implementation'], [config.collateralToken, 'collateral token'],
      [config.spotPort, 'spot port'], [config.gmxDataStore, 'GMX data store'],
    ] as const) await requireArbitrumSepoliaCode(chain, identity, name);
    const accountCodeHash = arbitrumSepoliaAccountCodeHash(implementation);
    if ((await chain.codeHash(account))?.toLowerCase() !== accountCodeHash) {
      fail('ACCOUNT_NOT_CREATED', 'the owner has no factory account');
    }
    const [recordedOwner, boundCodeHash, boundAdapter, boundExit, onchainOwner] = await Promise.all([
      this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'ownerOf', [account]),
      this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'accountCodeHash'),
      this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'adapter'),
      this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'exitController'),
      this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'owner'),
    ]);
    if (!sameAddress(recordedOwner, owner) || hashValue(boundCodeHash, 'account code hash') !== accountCodeHash
      || !sameAddress(boundAdapter, config.adapter.address) || !sameAddress(boundExit, exitController)
      || !sameAddress(onchainOwner, owner)) {
      fail('CHAIN_MISMATCH', 'factory account, owner, adapter, or exit controller binding does not match');
    }
    const dataStore = lower(config.gmxDataStore.address);
    const position = await readArbitrumSepoliaOpenPosition(chain, {
      factory, implementation, adapter: lower(config.adapter.address), exitController,
      market: lower(config.gmxMarket), collateralToken: lower(config.collateralToken.address), dataStore,
    }, owner);
    const usdScale = 10n ** BigInt(GMX_USD_DECIMALS - config.quoteAssetDecimals);
    if (hex(order.entryReceiptHash) !== position.packageId || position.activeExitRequestKey !== ZERO_HASH
      || order.expectedPrePositionEntryNotional.atoms * usdScale !== position.sizeInUsd
      || order.expectedPrePositionSize.atoms !== -order.quantity.atoms
      || position.spotRegistration.baseAtoms !== order.quantity.atoms
      || position.spotRegistration.fundingOwner !== owner
      || !sameAddress(position.spotRegistration.port, config.spotPort.address)) {
      fail('CHAIN_MISMATCH', 'exit order does not match the open package on chain');
    }

    const now = await chain.latestBlockTimestamp();
    const authorizationExpiry = route.routeExpiryValue;
    const cancelAfter = route.recoveryPlan.maxActionExpiryValue;
    const requestExpiration = await readGmxUint(chain, dataStore, GMX_DATA_STORE_KEYS.requestExpirationTime);
    // Any submission before the authorization expires must still meet GMX's cancellation delay.
    if (now >= authorizationExpiry || authorizationExpiry >= cancelAfter || cancelAfter < authorizationExpiry + requestExpiration) {
      fail('DEADLINE', 'route deadlines no longer leave a valid GMX exit window');
    }
    const [feeParameters, decreaseOrderGasLimit, gasPrice] = await Promise.all([
      readGmxExecutionFeeParameters(chain, dataStore),
      readGmxUint(chain, dataStore, GMX_DATA_STORE_KEYS.decreaseOrderGasLimit),
      chain.gasPrice(),
    ]);
    const executionFeeWei = gmxDecreaseExecutionFeeWei(
      feeParameters, decreaseOrderGasLimit, callbackGasLimit, gasPrice, BigInt(config.executionFeeBufferBps),
    );
    requirePositive(executionFeeWei, config.maxExecutionFeeWei, 'execution fee');
    const perpetual = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
    if (perpetual?.limitPrice === undefined || perpetual.side !== 'BUY' || !perpetual.reduceOnly) {
      fail('ATTEMPT_MISMATCH', 'route is missing the perpetual close bound');
    }
    // A short close accepts any fill at or below this price, so the bound rounds down.
    const acceptablePrice = (perpetual.limitPrice.quoteAtoms * usdScale) / perpetual.limitPrice.baseAtoms;
    // GMX checks the decrease output in USD; the signed outcome less the signed spot floor, at par.
    const minPerpOutputAtoms = order.minExitQuoteOutcome.atoms - order.minSpotQuoteOut.atoms;
    if (acceptablePrice <= 0n || minPerpOutputAtoms <= 0n || order.minSpotQuoteOut.atoms <= 0n) {
      fail('ATTEMPT_MISMATCH', 'exit price or output bounds are not positive');
    }
    const nonce = position.exitNonce;
    const authorization: ArbitrumExitAuthorization = Object.freeze({
      packageId: position.packageId,
      entryRequestKey: position.entryRequestKey,
      spotRegistrationHash: position.spotRegistrationHash,
      account,
      owner,
      receiver: owner,
      spotProceedsRecipient: owner,
      feePayer: solver,
      executionFeeRefundRecipient: solver,
      market: lower(config.gmxMarket),
      collateralToken: lower(config.collateralToken.address),
      isLong: false,
      fullCloseSizeUsd: position.sizeInUsd,
      spotBaseAtoms: order.quantity.atoms,
      spotMinQuoteAtoms: order.minSpotQuoteOut.atoms,
      packageNonce: position.spotRegistration.packageNonce,
      exitOrderHash: attempt.orderHash,
      exitQuoteHash: attempt.quoteHash,
      exitRouteHash: attempt.routeHash,
      exitFillCommitment: encodeHash(
        [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [FILL_COMMITMENT_DOMAIN, 'EXIT', attempt.orderHash, attempt.quoteHash, attempt.routeHash, nonce],
      ),
      acceptablePrice,
      minOutputAmount: minPerpOutputAtoms * usdScale,
      executionFeeWei,
      callbackGasLimit,
      authorizationExpiry,
      cancelAfter,
      nonce,
    });
    const digest = hashTypedData(arbitrumExitTypedData(authorization, exitController) as never);
    // The controller's own view must agree with the locally derived digest before the owner signs it.
    const onchain = await this.#read(exitController, ARBITRUM_EXIT_CONTROLLER_ABI, 'exitDigest', [authorization]);
    if (hashValue(onchain, 'exitDigest') !== digest) {
      fail('CHAIN_MISMATCH', 'exit controller digest does not match the locally derived authorization');
    }
    return Object.freeze({ attemptId, packageId: position.packageId, account, authorization, digest });
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

  async #send(
    plan: Pick<ArbitrumSepoliaExecutionPlan, 'attemptId'>,
    step: ArbitrumSepoliaExecutionStep,
    request: ArbitrumSepoliaWriteRequest,
    ledger: TransactionLedger = this.#options.journal,
  ): Promise<Hex> {
    const { chain, config } = this.#options;
    let recorded = ledger.transaction(plan.attemptId, step);
    if (recorded === undefined) {
      await this.#requireChain();
      const txHash = await chain.writeContract(request);
      if (!HASH.test(txHash)) fail('CHAIN_MISMATCH', 'RPC returned an invalid transaction hash');
      ledger.recordSent(plan.attemptId, step, txHash);
      recorded = { txHash, status: 'SENT' };
    }
    if (recorded.status === 'CONFIRMED') return recorded.txHash;
    if (recorded.status === 'REVERTED') fail('TRANSACTION_REVERTED', `${step} transaction reverted`);
    const outcome = await chain.receipt(recorded.txHash, config.receiptWaitMs);
    if (outcome === null) throw new InFlight();
    ledger.recordOutcome(plan.attemptId, step, outcome === 'success' ? 'CONFIRMED' : 'REVERTED');
    if (outcome !== 'success') fail('TRANSACTION_REVERTED', `${step} transaction reverted`);
    return recorded.txHash;
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

  async #plan(attemptId: string, resolved?: ArbitrumSepoliaExecutionAttempt): Promise<ArbitrumSepoliaExecutionPlan> {
    const { config, chain } = this.#options;
    const attempt = resolved ?? await this.#resolve(attemptId);
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
    const factory = lower(config.accountFactory.address);
    const implementation = lower(config.accountImplementation.address);
    if (!ADDRESS.test(ownerAddress) || ownerAddress === solver) {
      fail('ACCOUNT_MISMATCH', 'package owner must be a wallet other than the solver');
    }
    // Any wallet may trade, but only through its own factory account.
    const account = arbitrumSepoliaAccountOf(factory, implementation, ownerAddress);
    if (lower(route.settlementAccount) !== account || lower(order.settlementAccount) !== account) {
      fail('ACCOUNT_MISMATCH', 'settlement account is not the owner factory account');
    }
    for (const [identity, name] of [
      [config.coordinator, 'coordinator'], [config.adapter, 'adapter'], [config.accountFactory, 'account factory'],
      [config.accountImplementation, 'account implementation'],
      [config.collateralToken, 'collateral token'], [config.spotPort, 'spot port'],
      [config.spotBaseToken, 'spot base token'], [config.gmxDataStore, 'GMX data store'],
    ] as const) await requireArbitrumSepoliaCode(chain, identity, name);
    const accountCodeHash = arbitrumSepoliaAccountCodeHash(implementation);
    if ((await chain.codeHash(account))?.toLowerCase() !== accountCodeHash) {
      fail('ACCOUNT_NOT_CREATED', 'the owner must create its factory account before authorizing');
    }
    const [predicted, recordedOwner, boundImplementation, boundCodeHash, boundAdapter, onchainOwner, spotPort, spotBase] =
      await Promise.all([
        this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'accountOf', [ownerAddress]),
        this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'ownerOf', [account]),
        this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'implementation'),
        this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'accountCodeHash'),
        this.#read(factory, ARBITRUM_ACCOUNT_FACTORY_ABI, 'adapter'),
        this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'owner'),
        this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'spotPort'),
        this.#read(account, ARBITRUM_ISOLATED_ACCOUNT_ABI, 'spotBaseToken'),
      ]);
    if (!sameAddress(predicted, account) || !sameAddress(recordedOwner, ownerAddress)
      || !sameAddress(boundImplementation, implementation) || hashValue(boundCodeHash, 'account code hash') !== accountCodeHash
      || !sameAddress(boundAdapter, adapter) || !sameAddress(onchainOwner, ownerAddress)
      || !sameAddress(spotPort, config.spotPort.address) || !sameAddress(spotBase, config.spotBaseToken.address)) {
      fail('CHAIN_MISMATCH', 'factory account, owner, adapter, or spot binding does not match');
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
        fundingOwner: ownerAddress,
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
    return Object.freeze({ attemptId, packageId, account, terms, request });
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

function send(response: ServerResponse, status: number, body: unknown, plain = false): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(status === 200 && !plain ? stringifyProtocolJson(body as never, 'arbitrumExecutionResult') : JSON.stringify(body));
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

function requestBody(body: unknown, keys: string): Record<string, string> {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys
    || Object.values(body).some((value) => typeof value !== 'string')) {
    fail('INVALID_REQUEST', `request must contain only ${keys}`);
  }
  return body as Record<string, string>;
}

export function createArbitrumSepoliaExecutorServer(
  executor: Pick<ArbitrumSepoliaExecutor, 'advance' | 'prepare' | 'authorize' | 'prepareExit' | 'authorizeExit'>,
): Server {
  return createServer((request, response) => {
    void (async () => {
      if (!isLoopbackPeer(request.socket.remoteAddress)) {
        send(response, 403, { error: { code: 'LOOPBACK_REQUIRED', message: 'Executor access is loopback-only.' } });
        return;
      }
      const route = request.method !== 'POST' ? undefined
        : request.url === SOLVER_ARBITRUM_SEPOLIA_EXECUTE_PATH ? 'execute'
          : request.url === SOLVER_ARBITRUM_SEPOLIA_PREPARE_PATH ? 'prepare'
            : request.url === SOLVER_ARBITRUM_SEPOLIA_AUTHORIZE_PATH ? 'authorize'
              : request.url === SOLVER_ARBITRUM_SEPOLIA_PREPARE_EXIT_PATH ? 'prepare-exit'
                : request.url === SOLVER_ARBITRUM_SEPOLIA_AUTHORIZE_EXIT_PATH ? 'authorize-exit' : undefined;
      if (route === undefined) {
        send(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown executor route.' } });
        return;
      }
      try {
        const body = await readBody(request);
        if (route === 'execute') {
          send(response, 200, await executor.advance(requestBody(body, 'attemptId').attemptId!));
        } else if (route === 'prepare') {
          send(response, 200, await executor.prepare(requestBody(body, 'attemptId').attemptId!), true);
        } else if (route === 'prepare-exit') {
          send(response, 200, await executor.prepareExit(requestBody(body, 'attemptId').attemptId!), true);
        } else if (route === 'authorize-exit') {
          const fields = requestBody(body, 'attemptId,ownerSignature');
          send(response, 200, await executor.authorizeExit(fields.attemptId!, fields.ownerSignature!), true);
        } else {
          const fields = requestBody(body, 'attemptId,ownerSignature');
          send(response, 200, await executor.authorize(fields.attemptId!, fields.ownerSignature!), true);
        }
      } catch (error) {
        const code = error instanceof ArbitrumSepoliaExecutorError ? error.code : 'EXECUTION_FAILED';
        const status = code === 'INVALID_REQUEST' || code === 'INVALID_ATTEMPT' || code === 'INVALID_SIGNATURE' ? 400
          : code === 'ATTEMPT_NOT_FOUND' || code === 'NOT_PREPARED' ? 404
            : code === 'WRONG_CHAIN' || code === 'EXIT_UNAVAILABLE' ? 503 : 409;
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

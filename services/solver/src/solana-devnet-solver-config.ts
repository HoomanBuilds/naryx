import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bytesEqual,
  parseProtocolJson,
  type ActionCommitmentInput,
  type AdapterRef,
  type DomainRef,
  type EvidenceRequirementsInput,
  type StateConstraintInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  solanaIdlContentHash,
  type SolanaDevnetProgramExpectation,
} from '@naryx/adapter-solana';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT } from './solana-devnet-wire.js';

type CoreIdl = Parameters<typeof solanaIdlContentHash>[0];

function fail(message: string): never {
  throw new Error(`Solana Devnet solver config: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function address(value: unknown, name: string): string {
  try {
    return new PublicKey(String(value)).toBase58();
  } catch {
    fail(`${name} is not a Solana address`);
  }
}

function hash32(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32 || value.every((byte) => byte === 0)) {
    fail(`${name} must be 32 nonzero bytes`);
  }
  return value;
}

function positive(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) fail(`${name} must be positive`);
  return value;
}

/** The same reviewed runtime manifest the API loads; the solver reads it as data. */
export type SolanaDevnetSharedManifest = Readonly<{
  domain: DomainRef;
  programs: readonly SolanaDevnetProgramExpectation[];
  coreIdl: CoreIdl;
  expectedCoreIdlHash: Uint8Array;
  perpVenueKind: 'NARYX_TEST_PERP';
  testPerp: Readonly<{ market: string; oracle: string; feedIdHex: string; strategyIdHex: string }>;
}>;

export type SolanaDevnetResourceEvidenceConfig = Readonly<{
  manifestHash: Uint8Array;
  subjectAddress: string;
  programId: string;
  codeIdentity?: Uint8Array;
  adapterClassId?: string;
}>;

export const SOLANA_DEVNET_RESOURCE_NAMES = [
  'spotAdapter', 'perpAdapter', 'spotMarket', 'perpMarket', 'spotVenue', 'perpVenue', 'baseAsset', 'quoteAsset',
] as const;
export type SolanaDevnetResourceName = typeof SOLANA_DEVNET_RESOURCE_NAMES[number];

/**
 * Solver-side Devnet configuration. Registry account addresses, resource evidence, and the series
 * are reviewed registration output; the solver re-reads every one of them live before it binds.
 */
export type SolanaDevnetSolverConfig = Readonly<{
  schemaVersion: 1;
  runtimeManifestPath: string;
  solverId: string;
  solverCapabilityManifestHash: Uint8Array;
  templateRegistryRecordHash: Uint8Array;
  feePolicyVersion: number;
  feePolicyManifestHash: Uint8Array;
  candidateId: string;
  evidenceGrade: string;
  spot: Readonly<{ adapter: AdapterRef; venue: VersionedManifestRef; market: VersionedManifestRef; actionSequence: number }>;
  perpetual: Readonly<{ adapter: AdapterRef; venue: VersionedManifestRef; market: VersionedManifestRef; actionSequence: number }>;
  /** Firm inventory price over the oracle, in bps. */
  inventorySpreadBps: number;
  /** Tolerance below the expected perp fill that the perp leg limit allows, in bps. */
  perpLimitToleranceBps: number;
  quoteTtlSlots: bigint;
  maxQuantityAtoms: bigint;
  computeUnitLimit: number;
  levelTtlSlots: bigint;
  levelCapacityUnits: bigint;
  accounts: Readonly<{
    config: string;
    solverRegistry: string;
    reservationClass: string;
    seriesIndex: string;
    seriesRecord: string;
    packageBookClass: string;
    packageBookShard: string;
    packageBookLevelPage: string;
    indexes: Readonly<Record<SolanaDevnetResourceName, string>>;
    records: Readonly<Record<SolanaDevnetResourceName, string>>;
  }>;
  resources: Readonly<Record<SolanaDevnetResourceName, SolanaDevnetResourceEvidenceConfig>>;
  spotBaseLotAtoms: bigint;
  series: Readonly<{
    seriesManifestHash: Uint8Array;
    executionClassManifestHash: Uint8Array;
    settlementClassIdentityHash: Uint8Array;
    spotBaseAtomsPerPackageUnit: bigint;
    perpQuantityAtomsPerPackageUnit: bigint;
  }>;
  resourceAdmissionCommitment: Uint8Array;
  route: Readonly<{
    actions: readonly ActionCommitmentInput[];
    preconditions: readonly StateConstraintInput[];
    postconditions: readonly StateConstraintInput[];
    evidenceRequirements: EvidenceRequirementsInput;
  }>;
}>;

export function loadSolanaDevnetSharedManifest(path: string): SolanaDevnetSharedManifest {
  if (!isAbsolute(path)) fail('runtimeManifestPath must be absolute');
  const value = parseProtocolJson(readFileSync(resolve(path), 'utf8'), 'solanaDevnetRuntimeManifest');
  if (!isRecord(value) || value.schemaVersion !== 1 || value.activationState !== 'ACTIVE'
    || value.expectedGenesisHash !== SOLANA_DEVNET_GENESIS_HASH || value.perpVenueKind !== 'NARYX_TEST_PERP'
    || !isRecord(value.testPerp) || !isRecord(value.domain) || value.domain.domainId !== 'svm:devnet'
    || !Array.isArray(value.programs) || !isRecord(value.coreIdl)) {
    fail('runtime manifest is not an active svm:devnet NARYX_TEST_PERP manifest');
  }
  const manifest = value as unknown as SolanaDevnetSharedManifest;
  const names = manifest.programs.map((program) => program.name).sort().join(',');
  if (names !== 'core,package_book,perp_adapter,perp_venue,reservation') fail('runtime manifest program set is not reviewed');
  if (!bytesEqual(solanaIdlContentHash(manifest.coreIdl), hash32(manifest.expectedCoreIdlHash, 'expectedCoreIdlHash'))) {
    fail('core IDL hash does not match the runtime manifest');
  }
  if (manifest.testPerp.oracle !== SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT || manifest.testPerp.feedIdHex !== SOLANA_DEVNET_SOL_USD_FEED_ID_HEX
    || !/^[0-9a-f]{64}$/.test(manifest.testPerp.strategyIdHex)) {
    fail('runtime manifest test perp oracle, feed, or strategy id is not reviewed');
  }
  address(manifest.testPerp.market, 'testPerp.market');
  return manifest;
}

export function loadSolanaDevnetSolverConfig(path: string): SolanaDevnetSolverConfig {
  if (!isAbsolute(path)) fail('NARYX_SOLANA_DEVNET_SOLVER_CONFIG must be an absolute path');
  const value = parseProtocolJson(readFileSync(resolve(path), 'utf8'), 'solanaDevnetSolverConfig') as SolanaDevnetSolverConfig;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.runtimeManifestPath !== 'string'
    || !isRecord(value.accounts) || !isRecord(value.resources) || !isRecord(value.series) || !isRecord(value.route)
    || !Number.isSafeInteger(value.inventorySpreadBps) || value.inventorySpreadBps < 0 || value.inventorySpreadBps > 1_000
    || !Number.isSafeInteger(value.perpLimitToleranceBps) || value.perpLimitToleranceBps < 0 || value.perpLimitToleranceBps > 500
    || !Number.isSafeInteger(value.computeUnitLimit) || value.computeUnitLimit <= 0 || value.computeUnitLimit > 1_260_000) {
    fail('configuration is invalid');
  }
  address(value.solverId, 'solverId');
  positive(value.quoteTtlSlots, 'quoteTtlSlots');
  positive(value.maxQuantityAtoms, 'maxQuantityAtoms');
  positive(value.levelTtlSlots, 'levelTtlSlots');
  positive(value.levelCapacityUnits, 'levelCapacityUnits');
  positive(value.spotBaseLotAtoms, 'spotBaseLotAtoms');
  positive(value.series.spotBaseAtomsPerPackageUnit, 'series.spotBaseAtomsPerPackageUnit');
  positive(value.series.perpQuantityAtomsPerPackageUnit, 'series.perpQuantityAtomsPerPackageUnit');
  hash32(value.resourceAdmissionCommitment, 'resourceAdmissionCommitment');
  for (const name of ['config', 'solverRegistry', 'reservationClass', 'seriesIndex', 'seriesRecord', 'packageBookClass', 'packageBookShard', 'packageBookLevelPage'] as const) {
    address(value.accounts[name], `accounts.${name}`);
  }
  for (const name of SOLANA_DEVNET_RESOURCE_NAMES) {
    address(value.accounts.indexes[name], `accounts.indexes.${name}`);
    address(value.accounts.records[name], `accounts.records.${name}`);
    const resource = value.resources[name];
    hash32(resource?.manifestHash, `resources.${name}.manifestHash`);
    address(resource?.subjectAddress, `resources.${name}.subjectAddress`);
    address(resource?.programId, `resources.${name}.programId`);
  }
  return value;
}

function repositoryRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export type SolanaDevnetSolverKey = Readonly<{
  publicKey: PublicKey;
  keypair: Keypair;
  verificationKey: Uint8Array;
  signDigest(digest: Uint8Array): Uint8Array;
}>;

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Loads a Solana CLI keypair file held outside the repository, readable only by its owner, and
 * requires its public key to equal the configured solver id.
 */
export function loadSolanaDevnetSolverKey(path: string, expectedSolverId: string): SolanaDevnetSolverKey {
  if (!isAbsolute(path)) fail('NARYX_SOLANA_DEVNET_SOLVER_KEYPAIR_PATH must be absolute');
  const resolved = resolve(path);
  const root = repositoryRoot();
  if (root !== undefined && (resolved === root || resolved.startsWith(resolve(root) + sep))) {
    fail('solver keypair must remain outside the repository');
  }
  if ((statSync(resolved).mode & 0o077) !== 0) fail('solver keypair file must not be readable by group or others');
  const raw = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    fail('solver keypair file is not a Solana CLI keypair');
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  if (keypair.publicKey.toBase58() !== address(expectedSolverId, 'solverId')) fail('solver keypair does not match solverId');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (!Buffer.from(spki.subarray(12)).equals(keypair.publicKey.toBuffer())) fail('solver keypair encoding is inconsistent');
  return Object.freeze({
    publicKey: keypair.publicKey,
    keypair,
    verificationKey: keypair.publicKey.toBytes(),
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  });
}

/** Stable reviewed strategy id helper for configuration authors. */
export function solanaDevnetStrategyIdHex(label: string): string {
  return createHash('sha256').update(`NARYX/solana-devnet/strategy/${label}`).digest('hex');
}

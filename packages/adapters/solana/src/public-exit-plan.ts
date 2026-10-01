import { createHash } from 'node:crypto';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Ed25519Program,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesEqual, type DomainRef, type PackageAdmission } from '@naryx/protocol-types';
import type {
  SolanaMessageContext,
  SolanaMessageSizeEvidence,
  SolanaProgramDeploymentRef,
  SolanaRouteAccountBinding,
  UnsignedSolanaTransactionPlan,
} from './firm-plan.js';
import {
  type NaryxTestPerpAccountName,
  type RiseVenueAccountName,
  type SolanaPerpVenueKind,
  type SolanaPerpVenueProfile,
  RISE_VENUE_ACCOUNT_NAMES,
  requireOnlyProfileVenueAccounts,
  solanaPerpVenueProfile,
} from './perp-venue.js';

const { BN, BorshCoder } = anchor;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_RESOLVED_ADDRESSES = 64;
// Fixed exit addresses other than the perp venue accounts: 54 with the eight Rise accounts.
const FIXED_EXIT_BASE_ADDRESS_COUNT = 46;
const LEGACY_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const HASH_DOMAINS = {
  execution: 'NARYX/cash-carry-execution/v1',
  resources: 'NARYX/cash-carry-resources/v1',
  economicPackage: 'NARYX/cash-carry-economic-package/v1',
  packageAccounts: 'NARYX/cash-carry-package-accounts/v1',
} as const;

export const PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES = [
  'trader',
  'config',
  'solverRegistry',
  'receipt',
  'nonceMarker',
  'openPackage',
  'entryReceipt',
  'executorAuthority',
  'spotAdapterIndex',
  'perpAdapterIndex',
  'spotMarketIndex',
  'perpMarketIndex',
  'spotVenueIndex',
  'perpVenueIndex',
  'baseAssetIndex',
  'quoteAssetIndex',
  'spotAdapterRecord',
  'perpAdapterRecord',
  'spotMarketRecord',
  'perpMarketRecord',
  'spotVenueRecord',
  'perpVenueRecord',
  'baseAssetRecord',
  'quoteAssetRecord',
  'spotAdapterProgram',
  'spotAdapterProgramData',
  'perpAdapterProgram',
  'perpAdapterProgramData',
  'spotVenueProgram',
  'spotVenueProgramData',
  'perpVenueProgram',
  'perpVenueProgramData',
  'traderTokenA',
  'traderTokenB',
  'spotVaultA',
  'spotVaultB',
  'whirlpool',
  'tickArray0',
  'tickArray1',
  'tickArray2',
  'whirlpoolOracle',
  'riseStrategy',
  'riseLogAuthority',
  'riseGlobalConfig',
  'riseTraderAccount',
  'risePerpAssetMap',
  'riseGlobalTraderIndexHeader',
  'riseActiveTraderBufferHeader',
  'riseOrderbook',
  'riseSplineCollection',
  'tokenProgram',
  'instructionsSysvar',
  'systemProgram',
] as const;

export type PublicCashCarryExitAccountName = typeof PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES[number];
export type PublicCashCarryExitTestPerpAccountName =
  | Exclude<PublicCashCarryExitAccountName, RiseVenueAccountName>
  | NaryxTestPerpAccountName;
type ExitAccountKey = PublicCashCarryExitAccountName | NaryxTestPerpAccountName;
export type AnyPublicCashCarryExitBinding = PublicCashCarryExitBinding<SolanaPerpVenueKind>;
export type PublicCashCarryExitAccountsFor<K extends SolanaPerpVenueKind> = K extends 'NARYX_TEST_PERP'
  ? Readonly<Record<PublicCashCarryExitTestPerpAccountName, SolanaRouteAccountBinding>>
  : Readonly<Record<PublicCashCarryExitAccountName, SolanaRouteAccountBinding>>;
const EXIT_COMMON_ACCOUNT_NAMES = PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES.filter(
  (name) => !(RISE_VENUE_ACCOUNT_NAMES as readonly string[]).includes(name),
);
export type PublicCashCarryExitTokenAccountName = 'traderTokenA' | 'traderTokenB' | 'spotVaultA' | 'spotVaultB';
export type PublicCashCarryResourceName =
  | 'spotAdapter'
  | 'perpAdapter'
  | 'spotMarket'
  | 'perpMarket'
  | 'spotVenue'
  | 'perpVenue'
  | 'baseAsset'
  | 'quoteAsset';

export interface PublicCashCarryResourceEvidence {
  readonly domain: DomainRef;
  readonly protocolSubjectId: string;
  readonly subjectId: Uint8Array;
  readonly manifestVersion: number;
  readonly manifestHash: Uint8Array;
  readonly subjectAddress: PublicKey | string;
  readonly programId: PublicKey | string;
  readonly programDataAddress?: PublicKey | string;
  readonly codeIdentity?: Uint8Array;
  readonly lifecycle: 'ACTIVE' | 'ENTRY_PAUSED' | 'EXIT_ONLY';
  readonly currentActiveRecord: PublicKey | string;
}

export interface PublicCashCarryExitResources {
  readonly spotAdapter: PublicCashCarryResourceEvidence;
  readonly perpAdapter: PublicCashCarryResourceEvidence;
  readonly spotMarket: PublicCashCarryResourceEvidence;
  readonly perpMarket: PublicCashCarryResourceEvidence;
  readonly spotVenue: PublicCashCarryResourceEvidence;
  readonly perpVenue: PublicCashCarryResourceEvidence;
  readonly baseAsset: PublicCashCarryResourceEvidence;
  readonly quoteAsset: PublicCashCarryResourceEvidence;
  readonly quoteDecimals: number;
  readonly spotBaseLotAtoms: bigint;
  readonly perpBaseLotAtoms: bigint;
  readonly perpQuoteTickAtomsPerBaseLot: bigint;
  readonly settlementVersion: 1;
  readonly settlementManifestHash: Uint8Array;
}

export interface PublicCashCarryExitTokenEvidence {
  readonly mint: PublicKey | string;
  readonly authority: PublicKey | string;
  readonly amountAtoms: bigint;
}

export interface PublicCashCarryExitExecutionArgs {
  readonly spotQuantityAtoms: bigint;
  readonly perpQuantityAtoms: bigint;
  readonly spotLimitQuoteAtomsPerBaseLot: bigint;
  readonly perpLimitQuoteAtomsPerBaseLot: bigint;
  readonly packageNotionalAtoms: bigint;
  readonly spotSqrtPriceLimit: bigint;
  readonly minimumRiseCollateralQuoteLots: bigint;
  readonly clientOrderId: bigint;
  readonly expirySlot: bigint;
  readonly nonce: bigint;
}

export interface PublicCashCarryExitPostconditions {
  readonly expectedSpotBaseDebitAtoms: bigint;
  readonly minimumSpotQuoteOutAtoms: bigint;
  readonly expectedPreRiseBaseLots: bigint;
  readonly expectedPostRiseBaseLots: 0n;
  readonly minimumPostRiseCollateralQuoteLots: bigint;
}

export interface PublicCashCarryHistoricalSeriesEvidence {
  readonly identityKey: Uint8Array;
  readonly bindingVersion: number;
  readonly bindingHash: Uint8Array;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassManifestHash: Uint8Array;
  readonly index: PublicKey | string;
  readonly record: PublicKey | string;
}

export interface PublicCashCarryHistoricalOpenPackageEvidence {
  readonly version: 2;
  readonly address: PublicKey | string;
  readonly domain: DomainRef;
  readonly trader: PublicKey | string;
  readonly entryReceipt: PublicKey | string;
  readonly entryRouteHash: Uint8Array;
  readonly quoteIntentCommitment: Uint8Array;
  readonly packageFillCommitment: Uint8Array;
  readonly entryResourceAdmissionCommitment: Uint8Array;
  readonly entryRouteAccountsCommitment: Uint8Array;
  readonly economicPackageCommitment: Uint8Array;
  readonly packageAccountsCommitment: Uint8Array;
  readonly spotQuantityAtoms: bigint;
  readonly perpQuantityAtoms: bigint;
  readonly entryPackageNonce: bigint;
}

export interface PublicCashCarryHistoricalEntryReceiptEvidence {
  readonly address: PublicKey | string;
  readonly ownerProgram: PublicKey | string;
  readonly receiptHash: Uint8Array;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly trader: PublicKey | string;
  readonly solver: PublicKey | string;
  readonly nonce: bigint;
  readonly action: 'ENTRY';
  readonly recovery: false;
  readonly quoteIntentCommitment: Uint8Array;
  readonly packageFillCommitment: Uint8Array;
  readonly resourceAdmissionCommitment: Uint8Array;
  readonly routeAccountsCommitment: Uint8Array;
  readonly spotQuantityAtoms: bigint;
  readonly perpQuantityAtoms: bigint;
}

export type PublicCashCarryExitAuthorization =
  | Readonly<{
      mode: 'SOLVER_AUTHORIZED';
      activeSolver: PublicKey | string;
      solverRouteBindingId: string;
      solverSignature: Uint8Array;
    }>
  | Readonly<{
      mode: 'TRADER_RECOVERY';
      recoveryAuthority: PublicKey | string;
      recoveryAuthorityRouteBindingId: string;
      acknowledgedOpenPackage: PublicKey | string;
    }>;

export interface PublicCashCarryExitBinding<K extends SolanaPerpVenueKind = 'PHOENIX_RISE'> {
  readonly admission: PackageAdmission;
  readonly activeDomain: DomainRef;
  readonly deployments: Readonly<{
    core: SolanaProgramDeploymentRef;
    spotAdapter: SolanaProgramDeploymentRef;
    perpAdapter: SolanaProgramDeploymentRef;
    spotVenue: SolanaProgramDeploymentRef;
    perpVenue: SolanaProgramDeploymentRef;
  }>;
  /** Selected by the Devnet manifest. Omitted means the default Phoenix Rise core build. */
  readonly perpVenueKind?: K;
  readonly accounts: PublicCashCarryExitAccountsFor<K>;
  readonly riseDynamicAccounts: readonly (SolanaRouteAccountBinding & Readonly<{ isWritable: boolean }>)[];
  readonly resources: PublicCashCarryExitResources;
  readonly tokenAccounts: Readonly<Record<PublicCashCarryExitTokenAccountName, PublicCashCarryExitTokenEvidence>>;
  readonly historicalSeries: PublicCashCarryHistoricalSeriesEvidence;
  readonly openPackage: PublicCashCarryHistoricalOpenPackageEvidence;
  readonly entryReceipt: PublicCashCarryHistoricalEntryReceiptEvidence;
  readonly executionArgs: PublicCashCarryExitExecutionArgs;
  readonly postconditions: PublicCashCarryExitPostconditions;
  readonly authorization: PublicCashCarryExitAuthorization;
  readonly resourceAdmissionCommitment: Uint8Array;
  readonly computeUnitLimit: number;
  readonly currentSlot: bigint;
  readonly traderRouteBindingId: string;
  readonly messageContext?: SolanaMessageContext;
}

export interface PublicCashCarryEntryContext {
  readonly environment: 'local' | 'devnet' | 'testnet';
  readonly coreIdl: Idl;
  readonly domain: DomainRef;
  readonly coreProgram: PublicKey;
  readonly trader: PublicKey;
  readonly solver: PublicKey;
  readonly config: PublicKey;
  readonly solverRegistry: PublicKey;
  readonly entryReceipt: PublicKey;
  readonly openPackage: PublicKey;
  readonly executorAuthority: PublicKey;
  readonly riseStrategy: PublicKey;
  readonly traderBase: PublicKey;
  readonly traderQuote: PublicKey;
  readonly seriesIndex: PublicKey;
  readonly seriesRecord: PublicKey;
  readonly entryOrderHash: Uint8Array;
  readonly entryQuoteHash: Uint8Array;
  readonly entryRouteHash: Uint8Array;
  readonly templateVersion: number;
  readonly templateManifestHash: Uint8Array;
  readonly entryNonce: bigint;
  readonly spotQuantityAtoms: bigint;
  readonly perpQuantityAtoms: bigint;
  readonly quoteIntentCommitment: Uint8Array;
  readonly packageFillCommitment: Uint8Array;
  readonly resourceAdmissionCommitment: Uint8Array;
  readonly routeAccountsCommitment: Uint8Array;
  readonly packageAccountsCommitment: Uint8Array;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassManifestHash: Uint8Array;
  readonly settlementClassIdentityHash: Uint8Array;
  readonly spotBaseAtomsPerPackageUnit: bigint;
  readonly perpQuantityAtomsPerPackageUnit: bigint;
  readonly entryResourceRecords: Readonly<{
    perpAdapter: PublicKey;
    perpMarket: PublicKey;
    perpVenue: PublicKey;
    baseAsset: PublicKey;
    quoteAsset: PublicKey;
  }>;
}

export type PublicCashCarryExitPlan = UnsignedSolanaTransactionPlan & Readonly<{
  status: 'SUPPORTED';
  stage: 'PUBLIC_CASH_CARRY_EXIT';
  domain: DomainRef;
  orderHash: Uint8Array;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
  executionDigest: Uint8Array;
  authorization:
    | Readonly<{ mode: 'SOLVER_AUTHORIZED'; solver: PublicKey; ed25519InstructionIndex: number }>
    | Readonly<{ mode: 'TRADER_RECOVERY'; recoveryAuthority: PublicKey }>;
}>;

interface AccountSpec {
  readonly idlName: string;
  readonly bindingName: ExitAccountKey;
  readonly signer: boolean;
  readonly writable: boolean;
}

interface FlatIdlAccount {
  readonly name: string;
  readonly signer?: boolean;
  readonly writable?: boolean;
  readonly address?: string;
}

const EXIT_PREFIX_SPECS: readonly AccountSpec[] = [
  { idlName: 'trader', bindingName: 'trader', signer: true, writable: true },
  { idlName: 'config', bindingName: 'config', signer: false, writable: false },
  { idlName: 'solver_registry', bindingName: 'solverRegistry', signer: false, writable: false },
  { idlName: 'receipt', bindingName: 'receipt', signer: false, writable: true },
  { idlName: 'nonce_marker', bindingName: 'nonceMarker', signer: false, writable: true },
  { idlName: 'open_package', bindingName: 'openPackage', signer: false, writable: true },
  { idlName: 'entry_receipt', bindingName: 'entryReceipt', signer: false, writable: false },
  { idlName: 'executor_authority', bindingName: 'executorAuthority', signer: false, writable: false },
  ...[
    ['spot_adapter_index', 'spotAdapterIndex'], ['perp_adapter_index', 'perpAdapterIndex'],
    ['spot_market_index', 'spotMarketIndex'], ['perp_market_index', 'perpMarketIndex'],
    ['spot_venue_index', 'spotVenueIndex'], ['perp_venue_index', 'perpVenueIndex'],
    ['base_asset_index', 'baseAssetIndex'], ['quote_asset_index', 'quoteAssetIndex'],
    ['spot_adapter_record', 'spotAdapterRecord'], ['perp_adapter_record', 'perpAdapterRecord'],
    ['spot_market_record', 'spotMarketRecord'], ['perp_market_record', 'perpMarketRecord'],
    ['spot_venue_record', 'spotVenueRecord'], ['perp_venue_record', 'perpVenueRecord'],
    ['base_asset_record', 'baseAssetRecord'], ['quote_asset_record', 'quoteAssetRecord'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as PublicCashCarryExitAccountName, signer: false, writable: false })),
  ...[
    ['spot_adapter_program', 'spotAdapterProgram'], ['spot_adapter_program_data', 'spotAdapterProgramData'],
    ['perp_adapter_program', 'perpAdapterProgram'], ['perp_adapter_program_data', 'perpAdapterProgramData'],
    ['spot_venue_program', 'spotVenueProgram'], ['spot_venue_program_data', 'spotVenueProgramData'],
    ['perp_venue_program', 'perpVenueProgram'], ['perp_venue_program_data', 'perpVenueProgramData'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as PublicCashCarryExitAccountName, signer: false, writable: false })),
  ...[
    ['trader_token_a', 'traderTokenA'], ['trader_token_b', 'traderTokenB'],
    ['spot_vault_a', 'spotVaultA'], ['spot_vault_b', 'spotVaultB'],
    ['whirlpool', 'whirlpool'], ['tick_array_0', 'tickArray0'], ['tick_array_1', 'tickArray1'],
    ['tick_array_2', 'tickArray2'], ['whirlpool_oracle', 'whirlpoolOracle'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as PublicCashCarryExitAccountName, signer: false, writable: true })),
  { idlName: 'rise_strategy', bindingName: 'riseStrategy', signer: false, writable: true },
] as const;

const EXIT_SUFFIX_SPECS: readonly AccountSpec[] = [
  { idlName: 'token_program', bindingName: 'tokenProgram', signer: false, writable: false },
  { idlName: 'instructions_sysvar', bindingName: 'instructionsSysvar', signer: false, writable: false },
  { idlName: 'system_program', bindingName: 'systemProgram', signer: false, writable: false },
] as const;

function exitIdlSpecs(profile: SolanaPerpVenueProfile): readonly AccountSpec[] {
  return [
    ...EXIT_PREFIX_SPECS,
    ...profile.accounts.map((account) => ({ ...account, signer: false })),
    ...EXIT_SUFFIX_SPECS,
  ];
}

function accountBinding(binding: AnyPublicCashCarryExitBinding, name: ExitAccountKey): SolanaRouteAccountBinding {
  const account = (binding.accounts as Readonly<Record<string, SolanaRouteAccountBinding | undefined>>)[name];
  if (account === undefined) throw new Error(`missing ${name} account binding`);
  return account;
}

const RESOURCE_BINDINGS: Readonly<Record<PublicCashCarryResourceName, Readonly<{ index: PublicCashCarryExitAccountName; record: PublicCashCarryExitAccountName; kindSeed: string }>>> = {
  spotAdapter: { index: 'spotAdapterIndex', record: 'spotAdapterRecord', kindSeed: 'adapter' },
  perpAdapter: { index: 'perpAdapterIndex', record: 'perpAdapterRecord', kindSeed: 'adapter' },
  spotMarket: { index: 'spotMarketIndex', record: 'spotMarketRecord', kindSeed: 'market' },
  perpMarket: { index: 'perpMarketIndex', record: 'perpMarketRecord', kindSeed: 'market' },
  spotVenue: { index: 'spotVenueIndex', record: 'spotVenueRecord', kindSeed: 'venue' },
  perpVenue: { index: 'perpVenueIndex', record: 'perpVenueRecord', kindSeed: 'venue' },
  baseAsset: { index: 'baseAssetIndex', record: 'baseAssetRecord', kindSeed: 'asset' },
  quoteAsset: { index: 'quoteAssetIndex', record: 'quoteAssetRecord', kindSeed: 'asset' },
};

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function publicKey(value: PublicKey | string, name: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function hash32(value: Uint8Array, name: string): Uint8Array {
  requireCondition(value instanceof Uint8Array && value.length === 32 && value.some((byte) => byte !== 0), `${name} must be a nonzero 32-byte hash`);
  return value;
}

function requireBytes(actual: Uint8Array, expected: Uint8Array, name: string): void {
  requireCondition(bytesEqual(actual, expected), `${name} mismatch`);
}

function requireKey(actual: PublicKey | string, expected: PublicKey | string, name: string): void {
  requireCondition(publicKey(actual, name).equals(publicKey(expected, name)), `${name} mismatch`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function checkedUnsigned(value: bigint, maximum: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= maximum, `${name} is out of range`);
  return value;
}

function checkedPositiveU64(value: bigint, name: string): bigint {
  const checked = checkedUnsigned(value, U64_MAX, name);
  requireCondition(checked !== 0n, `${name} must be nonzero`);
  return checked;
}

function checkedSigned(value: bigint, minimum: bigint, maximum: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= minimum && value <= maximum, `${name} is out of range`);
  return value;
}

function bigEndian(value: bigint, byteLength: number, signed = false): Uint8Array {
  const bits = BigInt(byteLength * 8);
  let remaining = signed && value < 0n ? (1n << bits) + value : value;
  const output = new Uint8Array(byteLength);
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function protocolIdBytes(value: string, name: string): Uint8Array {
  const encoded = Buffer.from(value, 'utf8');
  requireCondition(encoded.length > 0 && encoded.length <= 64 && /^[\x20-\x7e]+$/.test(value), `${name} is invalid`);
  return Buffer.concat([Buffer.from(bigEndian(BigInt(encoded.length), 4)), encoded]);
}

function domainBytes(domain: DomainRef): Uint8Array {
  requireCondition(domain.domainManifestVersion > 0, 'domain manifest version must be nonzero');
  return Buffer.concat([
    Buffer.from(protocolIdBytes(domain.domainId, 'domain id')),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(hash32(domain.domainManifestHash, 'domain manifest hash')),
  ]);
}

function domainHash(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const digest = createHash('sha256');
  digest.update(Buffer.from(domain, 'ascii'));
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

function manifestRefBytes(resource: PublicCashCarryResourceEvidence, name: string): Uint8Array {
  requireCondition(resource.manifestVersion > 0 && Number.isInteger(resource.manifestVersion), `${name} manifest version must be nonzero`);
  return Buffer.concat([
    Buffer.from(hash32(resource.subjectId, `${name} subject identity`)),
    Buffer.from(bigEndian(BigInt(resource.manifestVersion), 4)),
    Buffer.from(hash32(resource.manifestHash, `${name} manifest hash`)),
  ]);
}

function flattenIdlAccounts(items: readonly unknown[]): FlatIdlAccount[] {
  return items.flatMap((item) => {
    requireCondition(typeof item === 'object' && item !== null && 'name' in item, 'IDL account is invalid');
    const account = item as { name: unknown; accounts?: unknown; signer?: unknown; writable?: unknown; address?: unknown };
    requireCondition(typeof account.name === 'string', 'IDL account name is invalid');
    if (account.accounts !== undefined) {
      requireCondition(Array.isArray(account.accounts), `IDL account group ${account.name} is invalid`);
      return flattenIdlAccounts(account.accounts);
    }
    return [{
      name: account.name,
      ...(account.signer === true ? { signer: true } : {}),
      ...(account.writable === true ? { writable: true } : {}),
      ...(typeof account.address === 'string' ? { address: account.address } : {}),
    }];
  });
}

function exitIdlAccounts(idl: Idl, specs: readonly AccountSpec[]): readonly FlatIdlAccount[] {
  const instruction = idl.instructions.find((item) => item.name === 'execute_cash_and_carry');
  requireCondition(instruction !== undefined, 'published core IDL is missing execute_cash_and_carry');
  const expectedArgs = ['order_hash', 'quote_hash', 'route_hash', 'args'];
  requireCondition(
    instruction.args.length === expectedArgs.length
      && instruction.args.every((argument, index) => argument.name === expectedArgs[index]),
    'execute_cash_and_carry IDL argument shape mismatch',
  );
  const accounts = flattenIdlAccounts(instruction.accounts);
  requireCondition(accounts.length === specs.length, 'execute_cash_and_carry IDL account count mismatch');
  for (const [index, spec] of specs.entries()) {
    const account = accounts[index]!;
    requireCondition(
      account.name === spec.idlName
        && (account.signer === true) === spec.signer
        && (account.writable === true) === spec.writable,
      `execute_cash_and_carry IDL account ${spec.idlName} mismatch`,
    );
  }
  return accounts;
}

function routeBindings(admission: PackageAdmission): Map<string, PackageAdmission['route']['accountBindings'][number]> {
  const bindings = new Map<string, PackageAdmission['route']['accountBindings'][number]>();
  for (const binding of admission.route.accountBindings) {
    requireCondition(!bindings.has(binding.routeBindingId), `duplicate route binding ${binding.routeBindingId}`);
    bindings.set(binding.routeBindingId, binding);
  }
  return bindings;
}

function validateRouteAccount(
  binding: SolanaRouteAccountBinding,
  routes: ReadonlyMap<string, PackageAdmission['route']['accountBindings'][number]>,
  name: string,
): PublicKey {
  const route = routes.get(binding.routeBindingId);
  requireCondition(route !== undefined, `missing route binding for ${name}`);
  requireKey(binding.address, route.accountIdentity, `${name} route account`);
  return publicKey(binding.address, name);
}

function resourceReference(
  name: PublicCashCarryResourceName,
  resource: PublicCashCarryResourceEvidence,
  expected: { subjectId: string; manifestVersion?: number; manifestHash: Uint8Array },
  historicalDomain: DomainRef,
): void {
  requireCondition(sameDomain(resource.domain, historicalDomain), `${name} historical domain mismatch`);
  requireCondition(resource.protocolSubjectId === expected.subjectId, `${name} protocol identity mismatch`);
  if (expected.manifestVersion !== undefined) requireCondition(resource.manifestVersion === expected.manifestVersion, `${name} manifest version mismatch`);
  requireBytes(resource.manifestHash, expected.manifestHash, `${name} manifest hash`);
  publicKey(resource.currentActiveRecord, `${name} current active record`);
}

function validateResources(
  admission: PackageAdmission,
  binding: AnyPublicCashCarryExitBinding,
  context: PublicCashCarryEntryContext,
  addresses: ReadonlyMap<ExitAccountKey, PublicKey>,
  routes: ReadonlyMap<string, PackageAdmission['route']['accountBindings'][number]>,
): { baseMint: PublicKey; quoteMint: PublicKey } {
  const spot = admission.route.legs[0]!;
  const perp = admission.route.legs[1]!;
  const references = {
    spotAdapter: { subjectId: spot.adapter.adapterId, manifestVersion: spot.adapter.adapterManifestVersion, manifestHash: spot.adapter.adapterManifestHash },
    perpAdapter: { subjectId: perp.adapter.adapterId, manifestVersion: perp.adapter.adapterManifestVersion, manifestHash: perp.adapter.adapterManifestHash },
    spotMarket: spot.market,
    perpMarket: perp.market,
    spotVenue: spot.venue,
    perpVenue: perp.venue,
    baseAsset: { subjectId: spot.baseAsset.assetId, manifestHash: spot.baseAsset.assetManifestHash },
    quoteAsset: { subjectId: spot.quoteAsset.assetId, manifestHash: spot.quoteAsset.assetManifestHash },
  } as const;
  for (const name of Object.keys(RESOURCE_BINDINGS) as PublicCashCarryResourceName[]) {
    const resource = binding.resources[name];
    resourceReference(name, resource, references[name], context.domain);
    const accountNames = RESOURCE_BINDINGS[name];
    const expectedIndex = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-index'),
      Buffer.from(accountNames.kindSeed),
      Buffer.from(hash32(resource.subjectId, `${name} subject identity`)),
    ], context.coreProgram)[0];
    const expectedRecord = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-record'),
      Buffer.from(accountNames.kindSeed),
      Buffer.from(resource.subjectId),
      Buffer.from(bigEndian(BigInt(resource.manifestVersion), 4)),
    ], context.coreProgram)[0];
    requireKey(addresses.get(accountNames.index)!, expectedIndex, `${name} index PDA`);
    requireKey(addresses.get(accountNames.record)!, expectedRecord, `${name} record PDA`);
    const route = routes.get(accountBinding(binding, accountNames.record).routeBindingId)!;
    requireCondition(route.ownerIdentity === context.coreProgram.toBase58(), `${name} record owner mismatch`);
  }

  for (const [name, entryRecord] of Object.entries(context.entryResourceRecords) as [keyof typeof context.entryResourceRecords, PublicKey][]) {
    requireKey(addresses.get(RESOURCE_BINDINGS[name].record)!, entryRecord, `${name} historical record`);
  }

  const baseMint = publicKey(binding.resources.baseAsset.subjectAddress, 'base mint');
  const quoteMint = publicKey(binding.resources.quoteAsset.subjectAddress, 'quote mint');
  requireCondition(!baseMint.equals(quoteMint), 'asset mints must differ');
  requireKey(baseMint, spot.baseAsset.assetId, 'base asset mint');
  requireKey(quoteMint, spot.quoteAsset.assetId, 'quote asset mint');
  requireCondition(binding.resources.quoteDecimals === spot.quoteAsset.decimals, 'quote decimals mismatch');
  requireKey(binding.resources.baseAsset.programId, LEGACY_TOKEN_PROGRAM_ID, 'base token program');
  requireKey(binding.resources.quoteAsset.programId, LEGACY_TOKEN_PROGRAM_ID, 'quote token program');

  const deployments = binding.deployments;
  for (const [name, deployment, programAccount, dataAccount] of [
    ['spot adapter', deployments.spotAdapter, 'spotAdapterProgram', 'spotAdapterProgramData'],
    ['perp adapter', deployments.perpAdapter, 'perpAdapterProgram', 'perpAdapterProgramData'],
    ['spot venue', deployments.spotVenue, 'spotVenueProgram', 'spotVenueProgramData'],
    ['perp venue', deployments.perpVenue, 'perpVenueProgram', 'perpVenueProgramData'],
  ] as const) {
    requireKey(addresses.get(programAccount)!, deployment.programId, `${name} program`);
    requireKey(addresses.get(dataAccount)!, deployment.programDataAddress, `${name} program data`);
    const route = routes.get(accountBinding(binding, programAccount).routeBindingId)!;
    requireCondition(route.codeIdentity === Buffer.from(hash32(deployment.codeIdentity, `${name} code identity`)).toString('hex'), `${name} route code identity mismatch`);
  }

  for (const [name, deployment, subject] of [
    ['spotAdapter', deployments.spotAdapter, deployments.spotAdapter.programId],
    ['perpAdapter', deployments.perpAdapter, deployments.perpAdapter.programId],
    ['spotVenue', deployments.spotVenue, addresses.get('whirlpool')!],
    ['spotMarket', deployments.spotVenue, addresses.get('whirlpool')!],
    ['perpVenue', deployments.perpVenue, addresses.get(solanaPerpVenueProfile(binding.perpVenueKind).venueSubject)!],
    ['perpMarket', deployments.perpVenue, addresses.get(solanaPerpVenueProfile(binding.perpVenueKind).marketSubject)!],
  ] as const) {
    const resource = binding.resources[name];
    requireKey(resource.subjectAddress, subject, `${name} subject`);
    requireKey(resource.programId, deployment.programId, `${name} program`);
    requireKey(resource.programDataAddress!, deployment.programDataAddress, `${name} program data`);
    requireBytes(resource.codeIdentity!, deployment.codeIdentity, `${name} code identity`);
  }
  return { baseMint, quoteMint };
}

function validatePackage(admission: PackageAdmission, binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext): void {
  const { order, quote, route } = admission;
  requireCondition(order.environment === context.environment && quote.environment === context.environment && route.environment === context.environment, 'exit environment mismatch');
  requireCondition(sameDomain(order.domain, context.domain) && sameDomain(quote.domain, context.domain) && sameDomain(route.domain, context.domain), 'exit must use the historical open-package domain');
  requireCondition(binding.activeDomain.domainId === context.domain.domainId, 'active domain identity mismatch');
  domainBytes(binding.activeDomain);
  requireCondition(order.action === 'EXIT' && route.action === 'EXIT', 'public exit requires EXIT package semantics');
  requireCondition(order.templateId === 'cash-and-carry-v1' && route.templateId === order.templateId, 'cash-carry template mismatch');
  requireCondition(order.templateVersion === context.templateVersion && route.templateVersion === context.templateVersion, 'historical template version mismatch');
  requireBytes(order.packageTemplateManifestHash, context.templateManifestHash, 'historical template manifest');
  requireBytes(route.packageTemplateManifestHash, context.templateManifestHash, 'historical route template manifest');
  requireCondition(order.direction === 'LONG_SPOT_SHORT_PERP' && route.direction === order.direction, 'cash-carry direction mismatch');
  requireCondition(order.settlementClass === 'ATOMIC_POSTCONDITION' && route.settlementClass === order.settlementClass, 'settlement class mismatch');
  requireCondition(route.executionPlanKind === 'SVM_ATOMIC_CPI', 'execution plan kind mismatch');
  requireCondition(order.partialFillPolicy === 'EXACT_ALL_LEGS' && route.partialFillPolicy === order.partialFillPolicy, 'partial exit is unsupported');
  requireCondition(order.owner === route.owner && order.owner === context.trader.toBase58(), 'exit trader mismatch');
  requireCondition(quote.solverId === route.solver, 'exit solver identity mismatch');
  requireCondition(route.serviceCharges.length === 0 && quote.protocolFee.atoms === 0n && quote.solverFee.atoms === 0n, 'public exit fees must be zero');
  requireBytes(quote.orderHash, admission.orderHash, 'exit quote order commitment');
  requireBytes(route.orderHash, admission.orderHash, 'exit route order commitment');
  requireBytes(quote.routeHash, admission.routeHash, 'exit quote route commitment');
  requireCondition(order.expiryUnit === 'SOLANA_SLOT' && quote.validUntilUnit === 'SOLANA_SLOT' && route.routeExpiryUnit === 'SOLANA_SLOT', 'exit expiry unit mismatch');
  const expiry = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((left, right) => left < right ? left : right);
  requireCondition(binding.currentSlot < expiry && binding.executionArgs.expirySlot === expiry, 'exit expiry mismatch');
  requireCondition(route.legs.length === 2, 'public exit requires exactly two legs');
  const spot = route.legs[0];
  const perp = route.legs[1];
  requireCondition(spot?.legRole === 'SPOT' && perp?.legRole === 'PERPETUAL', 'exit leg roles mismatch');
  requireCondition(spot.side === 'SELL' && perp.side === 'BUY' && perp.reduceOnly === true, 'exit leg direction or ReduceOnly mismatch');
  requireCondition(spot.quantity.atoms === order.quantity.atoms && perp.quantity.atoms === order.quantity.atoms, 'exit leg quantity mismatch');
  requireCondition(binding.executionArgs.spotQuantityAtoms === order.quantity.atoms && binding.executionArgs.perpQuantityAtoms === order.quantity.atoms, 'exit execution quantity mismatch');
  requireCondition(order.quantity.atoms > 0n && order.expectedPrePositionSize.atoms === -order.quantity.atoms, 'exit pre-position commitment mismatch');
  requireCondition(order.entryReceiptHash !== undefined, 'exit entry-receipt commitment is missing');
  requireBytes(order.entryReceiptHash, binding.entryReceipt.receiptHash, 'exit entry-receipt commitment');
  requireCondition(binding.executionArgs.nonce === order.nonce && binding.executionArgs.nonce !== context.entryNonce, 'exit package nonce mismatch');
  requireCondition(!bytesEqual(admission.orderHash, context.entryOrderHash), 'exit order replays the entry order');
}

function validateHistoricalPackage(binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext): void {
  const open = binding.openPackage;
  const receipt = binding.entryReceipt;
  requireCondition(open.version === 2, 'open package version mismatch');
  requireKey(open.address, context.openPackage, 'open package address');
  requireKey(open.trader, context.trader, 'open package trader');
  requireKey(open.entryReceipt, context.entryReceipt, 'open package entry receipt');
  requireCondition(sameDomain(open.domain, context.domain), 'open package historical domain mismatch');
  requireBytes(open.entryRouteHash, context.entryRouteHash, 'open package entry route');
  requireBytes(open.quoteIntentCommitment, context.quoteIntentCommitment, 'open package quote intent');
  requireBytes(open.packageFillCommitment, context.packageFillCommitment, 'open package fill commitment');
  requireBytes(open.entryResourceAdmissionCommitment, context.resourceAdmissionCommitment, 'open package entry resource commitment');
  requireBytes(open.entryRouteAccountsCommitment, context.routeAccountsCommitment, 'open package entry route-account commitment');
  requireBytes(open.packageAccountsCommitment, context.packageAccountsCommitment, 'open package account commitment');
  requireCondition(open.spotQuantityAtoms === context.spotQuantityAtoms && open.perpQuantityAtoms === context.perpQuantityAtoms, 'open package quantity mismatch');
  requireCondition(open.entryPackageNonce === context.entryNonce, 'open package entry nonce mismatch');

  requireKey(receipt.address, context.entryReceipt, 'historical entry receipt address');
  requireKey(context.entryReceipt, PublicKey.findProgramAddressSync([
    Buffer.from('cash-carry-receipt'), context.trader.toBuffer(), Buffer.from(context.entryOrderHash),
  ], context.coreProgram)[0], 'historical entry receipt PDA');
  requireKey(receipt.ownerProgram, context.coreProgram, 'historical entry receipt owner');
  requireCondition(sameDomain(receipt.domain, context.domain), 'historical entry receipt domain mismatch');
  requireBytes(receipt.orderHash, context.entryOrderHash, 'historical entry order commitment');
  requireBytes(receipt.quoteHash, context.entryQuoteHash, 'historical entry quote commitment');
  requireBytes(receipt.routeHash, context.entryRouteHash, 'historical entry route commitment');
  requireKey(receipt.trader, context.trader, 'historical entry trader');
  requireKey(receipt.solver, context.solver, 'historical entry solver');
  requireCondition(receipt.nonce === context.entryNonce && receipt.action === 'ENTRY' && receipt.recovery === false, 'historical entry receipt shape mismatch');
  requireBytes(receipt.quoteIntentCommitment, context.quoteIntentCommitment, 'historical entry quote intent');
  requireBytes(receipt.packageFillCommitment, context.packageFillCommitment, 'historical entry fill commitment');
  requireBytes(receipt.resourceAdmissionCommitment, context.resourceAdmissionCommitment, 'historical entry resource commitment');
  requireBytes(receipt.routeAccountsCommitment, context.routeAccountsCommitment, 'historical entry route-account commitment');
  requireCondition(receipt.spotQuantityAtoms === context.spotQuantityAtoms && receipt.perpQuantityAtoms === context.perpQuantityAtoms, 'historical entry receipt quantity mismatch');

  const series = binding.historicalSeries;
  const domainIdentity = domainHash('CON/v1/domain-ref-identity', domainBytes(context.domain));
  const identity = domainHash(
    'CON/v1/cash-carry-series-identity',
    domainIdentity,
    hash32(series.seriesManifestHash, 'historical series manifest'),
    hash32(series.executionClassManifestHash, 'historical execution class'),
  );
  requireBytes(series.identityKey, identity, 'historical series identity');
  requireCondition(Number.isInteger(series.bindingVersion) && series.bindingVersion > 0, 'historical series binding version must be nonzero');
  requireBytes(series.seriesManifestHash, context.seriesManifestHash, 'historical series manifest');
  requireBytes(series.executionClassManifestHash, context.executionClassManifestHash, 'historical execution class');
  const templateIdentity = domainHash('CON/v1/protocol-id-identity', protocolIdBytes(binding.admission.order.templateId, 'template id'));
  const quoteConventionIdentity = domainHash('CON/v1/protocol-id-identity', protocolIdBytes('annualized-net-yield-v1', 'quote convention'));
  const expectedBindingHash = domainHash(
    'CON/v1/cash-carry-series-binding',
    bigEndian(1n, 4),
    bigEndian(BigInt(series.bindingVersion), 4),
    domainIdentity,
    series.seriesManifestHash,
    series.executionClassManifestHash,
    templateIdentity,
    bigEndian(BigInt(context.templateVersion), 4),
    context.templateManifestHash,
    hash32(context.settlementClassIdentityHash, 'settlement class identity'),
    manifestRefBytes(binding.resources.baseAsset, 'base asset'),
    manifestRefBytes(binding.resources.quoteAsset, 'quote asset'),
    quoteConventionIdentity,
    Uint8Array.of(1),
    bigEndian(context.spotBaseAtomsPerPackageUnit, 16),
    bigEndian(context.perpQuantityAtomsPerPackageUnit, 16),
  );
  requireBytes(series.bindingHash, expectedBindingHash, 'historical series binding hash');
  requireKey(series.index, context.seriesIndex, 'historical series index');
  requireKey(series.record, context.seriesRecord, 'historical series record');
  requireKey(series.index, PublicKey.findProgramAddressSync([Buffer.from('cash-carry-series-index'), Buffer.from(identity)], context.coreProgram)[0], 'historical series index PDA');
  requireKey(series.record, PublicKey.findProgramAddressSync([
    Buffer.from('cash-carry-series-record'), Buffer.from(identity), Buffer.from(bigEndian(BigInt(series.bindingVersion), 4)),
  ], context.coreProgram)[0], 'historical series record PDA');
}

function resourceCommitment(binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext, addresses: ReadonlyMap<ExitAccountKey, PublicKey>): Uint8Array {
  const ordered = Object.keys(RESOURCE_BINDINGS) as PublicCashCarryResourceName[];
  return domainHash(
    HASH_DOMAINS.resources,
    domainBytes(context.domain),
    ...ordered.map((name) => manifestRefBytes(binding.resources[name], name)),
    protocolIdBytes(binding.admission.order.templateId, 'template id'),
    bigEndian(BigInt(binding.admission.order.templateVersion), 4),
    hash32(binding.admission.order.packageTemplateManifestHash, 'template manifest hash'),
    Uint8Array.of(1),
    bigEndian(BigInt(binding.resources.settlementVersion), 4),
    hash32(binding.resources.settlementManifestHash, 'settlement manifest hash'),
    Uint8Array.of(binding.resources.quoteDecimals),
    ...ordered.map((name) => addresses.get(RESOURCE_BINDINGS[name].record)!.toBytes()),
  );
}

function economicPackageCommitment(binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext, addresses: ReadonlyMap<ExitAccountKey, PublicKey>): Uint8Array {
  const ordered: readonly PublicCashCarryResourceName[] = ['perpAdapter', 'perpMarket', 'perpVenue', 'baseAsset', 'quoteAsset'];
  return domainHash(
    HASH_DOMAINS.economicPackage,
    domainBytes(context.domain),
    ...ordered.map((name) => manifestRefBytes(binding.resources[name], name)),
    protocolIdBytes(binding.admission.order.templateId, 'template id'),
    bigEndian(BigInt(binding.admission.order.templateVersion), 4),
    hash32(binding.admission.order.packageTemplateManifestHash, 'template manifest hash'),
    Uint8Array.of(1),
    bigEndian(BigInt(binding.resources.settlementVersion), 4),
    hash32(binding.resources.settlementManifestHash, 'settlement manifest hash'),
    Uint8Array.of(binding.resources.quoteDecimals),
    ...ordered.map((name) => addresses.get(RESOURCE_BINDINGS[name].record)!.toBytes()),
  );
}

function validateAmounts(binding: AnyPublicCashCarryExitBinding): void {
  const admission = binding.admission;
  const args = binding.executionArgs;
  const spot = admission.route.legs[0]!;
  const perp = admission.route.legs[1]!;
  const spotLot = checkedPositiveU64(binding.resources.spotBaseLotAtoms, 'spot base lot');
  const perpLot = checkedPositiveU64(binding.resources.perpBaseLotAtoms, 'perp base lot');
  const perpTick = checkedPositiveU64(binding.resources.perpQuoteTickAtomsPerBaseLot, 'perp quote tick');
  checkedPositiveU64(args.spotQuantityAtoms, 'spot quantity');
  checkedPositiveU64(args.perpQuantityAtoms, 'perp quantity');
  requireCondition(args.spotQuantityAtoms % spotLot === 0n && args.perpQuantityAtoms % perpLot === 0n, 'exit quantities are not exact market lots');
  checkedPositiveU64(args.spotLimitQuoteAtomsPerBaseLot, 'spot quote floor per lot');
  checkedPositiveU64(args.perpLimitQuoteAtomsPerBaseLot, 'perp limit per lot');
  requireCondition(args.perpLimitQuoteAtomsPerBaseLot % perpTick === 0n, 'perp limit is not an exact market tick');
  const spotNumerator = spot.limitPrice.quoteAtoms * spotLot;
  const perpNumerator = perp.limitPrice.quoteAtoms * perpLot;
  requireCondition(spot.limitPrice.baseAtoms > 0n && spotNumerator % spot.limitPrice.baseAtoms === 0n, 'spot limit cannot be represented per base lot');
  requireCondition(perp.limitPrice.baseAtoms > 0n && perpNumerator % perp.limitPrice.baseAtoms === 0n, 'perp limit cannot be represented per base lot');
  requireCondition(args.spotLimitQuoteAtomsPerBaseLot === spotNumerator / spot.limitPrice.baseAtoms, 'spot limit commitment mismatch');
  requireCondition(args.perpLimitQuoteAtomsPerBaseLot === perpNumerator / perp.limitPrice.baseAtoms, 'perp limit commitment mismatch');
  const minimumSpotQuoteOut = (args.spotQuantityAtoms / spotLot) * args.spotLimitQuoteAtomsPerBaseLot;
  requireCondition(admission.order.minSpotQuoteOut !== undefined && minimumSpotQuoteOut === admission.order.minSpotQuoteOut.atoms, 'minimum spot quote out mismatch');
  requireCondition(binding.postconditions.minimumSpotQuoteOutAtoms === minimumSpotQuoteOut, 'spot quote postcondition mismatch');
  requireCondition(binding.postconditions.expectedSpotBaseDebitAtoms === args.spotQuantityAtoms, 'spot base postcondition mismatch');
  const perpLots = args.perpQuantityAtoms / perpLot;
  requireCondition(perpLots <= BigInt(I64_MAX), 'perp close size exceeds i64');
  requireCondition(binding.postconditions.expectedPreRiseBaseLots === -perpLots && binding.postconditions.expectedPostRiseBaseLots === 0n, 'Rise full-close postcondition mismatch');
  checkedSigned(args.minimumRiseCollateralQuoteLots, I64_MIN, I64_MAX, 'minimum Rise collateral');
  requireCondition(binding.postconditions.minimumPostRiseCollateralQuoteLots === args.minimumRiseCollateralQuoteLots, 'Rise collateral postcondition mismatch');
  checkedPositiveU64(args.packageNotionalAtoms, 'package notional');
  requireCondition(args.packageNotionalAtoms === admission.quote.expectedSpotNotional.atoms, 'package notional mismatch');
  checkedUnsigned(args.spotSqrtPriceLimit, U128_MAX, 'spot sqrt price limit');
  requireCondition(args.spotSqrtPriceLimit !== 0n, 'spot sqrt price limit must be nonzero');
  checkedUnsigned(args.clientOrderId, U128_MAX, 'client order id');
  checkedPositiveU64(args.expirySlot, 'execution expiry');
  checkedPositiveU64(args.nonce, 'execution nonce');
}

function validateTokens(binding: AnyPublicCashCarryExitBinding, addresses: ReadonlyMap<ExitAccountKey, PublicKey>, routes: ReadonlyMap<string, PackageAdmission['route']['accountBindings'][number]>, baseMint: PublicKey, quoteMint: PublicKey, trader: PublicKey): void {
  requireKey(addresses.get('tokenProgram')!, LEGACY_TOKEN_PROGRAM_ID, 'legacy SPL Token program');
  requireKey(addresses.get('instructionsSysvar')!, SYSVAR_INSTRUCTIONS_PUBKEY, 'instructions sysvar');
  requireKey(addresses.get('systemProgram')!, SystemProgram.programId, 'system program');
  const baseIsA = publicKey(binding.tokenAccounts.traderTokenA.mint, 'trader token A mint').equals(baseMint);
  const expected = {
    traderTokenA: { mint: baseIsA ? baseMint : quoteMint, authority: trader },
    traderTokenB: { mint: baseIsA ? quoteMint : baseMint, authority: trader },
    spotVaultA: { mint: baseIsA ? baseMint : quoteMint, authority: addresses.get('whirlpool')! },
    spotVaultB: { mint: baseIsA ? quoteMint : baseMint, authority: addresses.get('whirlpool')! },
  } as const;
  requireCondition(!publicKey(binding.tokenAccounts.traderTokenB.mint, 'trader token B mint').equals(publicKey(binding.tokenAccounts.traderTokenA.mint, 'trader token A mint')), 'trader token mints must differ');
  for (const name of Object.keys(expected) as PublicCashCarryExitTokenAccountName[]) {
    const evidence = binding.tokenAccounts[name];
    requireKey(evidence.mint, expected[name].mint, `${name} mint`);
    requireKey(evidence.authority, expected[name].authority, `${name} authority`);
    checkedUnsigned(evidence.amountAtoms, U64_MAX, `${name} amount`);
    const route = routes.get(accountBinding(binding, name).routeBindingId)!;
    requireCondition(route.ownerIdentity === LEGACY_TOKEN_PROGRAM_ID.toBase58(), `${name} token program binding mismatch`);
    requireCondition(route.authorityIdentity === expected[name].authority.toBase58(), `${name} authority binding mismatch`);
  }
}

function executionDigest(binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext, addresses: ReadonlyMap<ExitAccountKey, PublicKey>, resource: Uint8Array): Uint8Array {
  const solver = binding.authorization.mode === 'SOLVER_AUTHORIZED'
    ? publicKey(binding.authorization.activeSolver, 'active solver')
    : PublicKey.default;
  const keys = [
    context.coreProgram,
    addresses.get('trader')!,
    addresses.get('config')!,
    addresses.get('solverRegistry')!,
    solver,
    ...exitIdlSpecs(solanaPerpVenueProfile(binding.perpVenueKind)).slice(3).map((spec) => addresses.get(spec.bindingName)!),
    ...binding.riseDynamicAccounts.map((account) => publicKey(account.address, 'Rise dynamic account')),
  ];
  const args = binding.executionArgs;
  return domainHash(
    HASH_DOMAINS.execution,
    domainBytes(context.domain),
    binding.admission.orderHash,
    binding.admission.quoteHash,
    binding.admission.routeHash,
    Uint8Array.of(2),
    Uint8Array.of(binding.authorization.mode === 'TRADER_RECOVERY' ? 1 : 0),
    bigEndian(args.spotQuantityAtoms, 8),
    bigEndian(args.perpQuantityAtoms, 8),
    bigEndian(args.spotLimitQuoteAtomsPerBaseLot, 8),
    bigEndian(args.perpLimitQuoteAtomsPerBaseLot, 8),
    bigEndian(args.packageNotionalAtoms, 8),
    bigEndian(args.spotSqrtPriceLimit, 16),
    bigEndian(args.minimumRiseCollateralQuoteLots, 8, true),
    bigEndian(args.clientOrderId, 16),
    bigEndian(args.expirySlot, 8),
    bigEndian(args.nonce, 8),
    resource,
    bigEndian(BigInt(keys.length), 4),
    ...keys.map((key) => key.toBytes()),
  );
}

function borshExecutionArgs(args: PublicCashCarryExitExecutionArgs, recovery: boolean) {
  return {
    action: { Exit: {} },
    recovery,
    spot_quantity_atoms: new BN(args.spotQuantityAtoms.toString()),
    perp_quantity_atoms: new BN(args.perpQuantityAtoms.toString()),
    spot_limit_quote_atoms_per_base_lot: new BN(args.spotLimitQuoteAtomsPerBaseLot.toString()),
    perp_limit_quote_atoms_per_base_lot: new BN(args.perpLimitQuoteAtomsPerBaseLot.toString()),
    package_notional_atoms: new BN(args.packageNotionalAtoms.toString()),
    spot_sqrt_price_limit: new BN(args.spotSqrtPriceLimit.toString()),
    minimum_rise_collateral_quote_lots: new BN(args.minimumRiseCollateralQuoteLots.toString()),
    client_order_id: new BN(args.clientOrderId.toString()),
    expiry_slot: new BN(args.expirySlot.toString()),
    nonce: new BN(args.nonce.toString()),
  };
}

function resolvedAddressCount(payer: PublicKey, instructions: readonly TransactionInstruction[]): number {
  const addresses = new Set<string>([payer.toBase58()]);
  for (const instruction of instructions) {
    addresses.add(instruction.programId.toBase58());
    for (const key of instruction.keys) addresses.add(key.pubkey.toBase58());
  }
  return addresses.size;
}

function messageSize(payer: PublicKey, instructions: readonly TransactionInstruction[], context: SolanaMessageContext | undefined): SolanaMessageSizeEvidence {
  if (context === undefined) return Object.freeze({ status: 'UNPROVEN', reason: 'RECENT_BLOCKHASH_AND_ALT_CONTENTS_REQUIRED' });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: context.recentBlockhash,
    instructions: [...instructions],
  }).compileToV0Message([...context.addressLookupTables]);
  const serializedMessageBytes = message.serialize().length;
  const serializedTransactionBytes = new VersionedTransaction(message).serialize().length;
  return Object.freeze({
    status: 'PROVEN',
    serializedMessageBytes,
    serializedTransactionBytes,
    fitsPacketDataLimit: serializedTransactionBytes <= PACKET_DATA_SIZE,
    lookupTableCount: context.addressLookupTables.length,
  });
}

export function compilePublicCashCarryExitPlan(binding: AnyPublicCashCarryExitBinding, context: PublicCashCarryEntryContext): PublicCashCarryExitPlan {
  validatePackage(binding.admission, binding, context);
  validateHistoricalPackage(binding, context);
  requireKey(binding.deployments.core.programId, context.coreProgram, 'exit core deployment');
  const profile = solanaPerpVenueProfile(binding.perpVenueKind);
  requireOnlyProfileVenueAccounts(binding.accounts, profile);
  // The resolved-address limit bounds Rise arena accounts on exit; the test perp takes none.
  requireCondition(profile.maxDynamicAccounts > 0 || binding.riseDynamicAccounts.length === 0, `${profile.kind} public exit takes no dynamic accounts`);
  const exitSpecs = exitIdlSpecs(profile);
  const exitAccountNames = [...EXIT_COMMON_ACCOUNT_NAMES, ...profile.accounts.map((account) => account.bindingName)];
  const idlAccounts = exitIdlAccounts(context.coreIdl, exitSpecs);
  const routes = routeBindings(binding.admission);
  const addresses = new Map<ExitAccountKey, PublicKey>();
  for (const name of exitAccountNames) addresses.set(name, validateRouteAccount(accountBinding(binding, name), routes, name));
  for (const [index, account] of binding.riseDynamicAccounts.entries()) validateRouteAccount(account, routes, `Rise dynamic account ${index}`);
  requireCondition(binding.accounts.trader.routeBindingId === binding.traderRouteBindingId, 'exit trader authority binding mismatch');
  requireCondition(binding.admission.route.actions.length > 0 && binding.admission.route.actions.every((action) => action.authorityBindingId === binding.traderRouteBindingId), 'exit route actions must use trader authority');
  requireKey(addresses.get('trader')!, context.trader, 'exit trader');
  requireKey(addresses.get('config')!, context.config, 'exit config');
  requireKey(addresses.get('solverRegistry')!, context.solverRegistry, 'exit solver registry');
  requireKey(context.config, PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], context.coreProgram)[0], 'config PDA');
  requireKey(context.solverRegistry, PublicKey.findProgramAddressSync([Buffer.from('conformance-solver')], context.coreProgram)[0], 'solver registry PDA');
  requireKey(addresses.get('receipt')!, PublicKey.findProgramAddressSync([Buffer.from('cash-carry-receipt'), context.trader.toBuffer(), Buffer.from(binding.admission.orderHash)], context.coreProgram)[0], 'exit receipt PDA');
  requireKey(addresses.get('nonceMarker')!, PublicKey.findProgramAddressSync([Buffer.from('cash-carry-nonce'), context.trader.toBuffer(), Buffer.from(bigEndian(binding.executionArgs.nonce, 8))], context.coreProgram)[0], 'exit nonce PDA');
  requireKey(addresses.get('openPackage')!, context.openPackage, 'exit open package');
  requireKey(addresses.get('entryReceipt')!, context.entryReceipt, 'exit entry receipt');
  requireKey(addresses.get('executorAuthority')!, context.executorAuthority, 'exit executor authority');
  requireKey(addresses.get('riseStrategy')!, context.riseStrategy, 'exit Rise strategy');
  requireKey(context.openPackage, PublicKey.findProgramAddressSync([
    Buffer.from('cash-carry-open'), context.trader.toBuffer(), context.riseStrategy.toBuffer(),
  ], context.coreProgram)[0], 'open package PDA');
  requireKey(context.executorAuthority, PublicKey.findProgramAddressSync([
    Buffer.from('cash-carry-executor'), context.trader.toBuffer(), context.riseStrategy.toBuffer(),
  ], context.coreProgram)[0], 'executor authority PDA');

  const routeIds = new Set<string>([
    ...exitAccountNames.map((name) => accountBinding(binding, name).routeBindingId),
    ...binding.riseDynamicAccounts.map((account) => account.routeBindingId),
    ...(binding.authorization.mode === 'SOLVER_AUTHORIZED' ? [binding.authorization.solverRouteBindingId] : []),
  ]);
  requireCondition(routeIds.size === binding.admission.route.accountBindings.length && binding.admission.route.accountBindings.every((route) => routeIds.has(route.routeBindingId)), 'exit route account set mismatch');

  const { baseMint, quoteMint } = validateResources(binding.admission, binding, context, addresses, routes);
  validateTokens(binding, addresses, routes, baseMint, quoteMint, context.trader);
  validateAmounts(binding);
  const resource = resourceCommitment(binding, context, addresses);
  requireBytes(binding.resourceAdmissionCommitment, resource, 'exit resource admission commitment');
  requireBytes(binding.openPackage.economicPackageCommitment, economicPackageCommitment(binding, context, addresses), 'historical economic package commitment');
  const packageAccounts = domainHash(
    HASH_DOMAINS.packageAccounts,
    bigEndian(3n, 4),
    context.traderBase.toBytes(),
    context.traderQuote.toBytes(),
    context.riseStrategy.toBytes(),
  );
  requireBytes(binding.openPackage.packageAccountsCommitment, packageAccounts, 'historical package-account commitment');
  const traderTokenAddresses = [addresses.get('traderTokenA')!, addresses.get('traderTokenB')!];
  requireCondition(traderTokenAddresses.some((account) => account.equals(context.traderBase)) && traderTokenAddresses.some((account) => account.equals(context.traderQuote)), 'exit trader token accounts do not match the open package');

  const keys = exitSpecs.map((spec, index) => {
    const account = idlAccounts[index]!;
    const pubkey = addresses.get(spec.bindingName)!;
    if (account.address !== undefined) requireKey(pubkey, account.address, `IDL account ${account.name}`);
    return { pubkey, isSigner: spec.signer, isWritable: spec.writable };
  });
  const fixedCount = new Set([context.coreProgram.toBase58(), ...keys.map((key) => key.pubkey.toBase58())]).size;
  const expectedFixedCount = FIXED_EXIT_BASE_ADDRESS_COUNT + profile.accounts.length;
  requireCondition(fixedCount === expectedFixedCount, `public exit must resolve exactly ${expectedFixedCount} fixed addresses, resolved ${fixedCount}`);
  const recovery = binding.authorization.mode === 'TRADER_RECOVERY';
  const instruction = new TransactionInstruction({
    programId: context.coreProgram,
    keys: [
      ...keys,
      ...binding.riseDynamicAccounts.map((account) => ({ pubkey: publicKey(account.address, 'Rise dynamic account'), isSigner: false, isWritable: account.isWritable })),
    ],
    data: new BorshCoder(context.coreIdl).instruction.encode('execute_cash_and_carry', {
      order_hash: Array.from(binding.admission.orderHash),
      quote_hash: Array.from(binding.admission.quoteHash),
      route_hash: Array.from(binding.admission.routeHash),
      args: borshExecutionArgs(binding.executionArgs, recovery),
    }),
  });
  requireCondition(instruction.keys.filter((key) => key.isSigner).length === 1 && instruction.keys[0]?.pubkey.equals(context.trader) === true, 'public exit must require only the trader transaction signer');
  requireCondition(Number.isInteger(binding.computeUnitLimit) && binding.computeUnitLimit > 0 && binding.computeUnitLimit <= 1_260_000, 'compute unit limit exceeds the public exit route cap');
  const digest = executionDigest(binding, context, addresses, resource);
  const compute = ComputeBudgetProgram.setComputeUnitLimit({ units: binding.computeUnitLimit });
  let instructions: readonly TransactionInstruction[];
  let authorization: PublicCashCarryExitPlan['authorization'];
  if (binding.authorization.mode === 'SOLVER_AUTHORIZED') {
    const solver = publicKey(binding.authorization.activeSolver, 'active solver');
    requireCondition(binding.authorization.solverSignature instanceof Uint8Array && binding.authorization.solverSignature.length === 64, 'solver signature must be 64 bytes');
    requireCondition(binding.authorization.solverRouteBindingId !== binding.traderRouteBindingId, 'solver and trader authority bindings must differ');
    const solverRoute = routes.get(binding.authorization.solverRouteBindingId);
    requireCondition(solverRoute !== undefined, 'active solver route binding is missing');
    requireKey(solverRoute.accountIdentity, solver, 'active solver route account');
    requireCondition(binding.admission.route.solver === solver.toBase58(), 'active solver identity mismatch');
    requireCondition(bytesEqual(binding.admission.quote.solverVerificationKey, solver.toBytes()), 'active solver verification key mismatch');
    instructions = Object.freeze([
      compute,
      Ed25519Program.createInstructionWithPublicKey({ publicKey: solver.toBytes(), message: digest, signature: binding.authorization.solverSignature }),
      instruction,
    ]);
    authorization = Object.freeze({ mode: 'SOLVER_AUTHORIZED', solver, ed25519InstructionIndex: 1 });
  } else {
    requireKey(binding.authorization.recoveryAuthority, context.trader, 'recovery authority');
    requireCondition(binding.authorization.recoveryAuthorityRouteBindingId === binding.traderRouteBindingId, 'recovery authority binding mismatch');
    requireKey(binding.authorization.acknowledgedOpenPackage, context.openPackage, 'recovery open-package acknowledgement');
    instructions = Object.freeze([compute, instruction]);
    authorization = Object.freeze({ mode: 'TRADER_RECOVERY', recoveryAuthority: context.trader });
  }
  const resolved = resolvedAddressCount(context.trader, instructions);
  requireCondition(resolved <= MAX_RESOLVED_ADDRESSES, 'public exit exceeds 64 resolved addresses');
  return Object.freeze({
    status: 'SUPPORTED',
    stage: 'PUBLIC_CASH_CARRY_EXIT',
    authorityRole: 'TRADER',
    payer: context.trader,
    instructions,
    resolvedAddressCount: resolved,
    messageSize: messageSize(context.trader, instructions, binding.messageContext),
    domain: context.domain,
    orderHash: Uint8Array.from(binding.admission.orderHash),
    quoteHash: Uint8Array.from(binding.admission.quoteHash),
    routeHash: Uint8Array.from(binding.admission.routeHash),
    executionDigest: Uint8Array.from(digest),
    authorization,
  });
}

import { createHash } from 'node:crypto';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  type AddressLookupTableAccount,
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
import {
  bytesEqual,
  type AssetRef,
  type DomainRef,
  type PackageAdmission,
} from '@naryx/protocol-types';
import {
  compilePublicCashCarryExitPlan,
  type PublicCashCarryExitBinding,
  type PublicCashCarryExitPlan,
} from './public-exit-plan.js';
import {
  type NaryxTestPerpAccountName,
  type RiseVenueAccountName,
  type SolanaPerpVenueKind,
  type SolanaPerpVenueProfile,
  RISE_VENUE_ACCOUNT_NAMES,
  requireOnlyProfileVenueAccounts,
  solanaPerpVenueProfile,
} from './perp-venue.js';
import {
  borshRiskArgs,
  riskDigestParts,
  type SolanaCashCarryRiskArgs,
  validateSolanaCashCarryRiskArgs,
} from './risk-domain.js';

const { BN, BorshCoder } = anchor;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const FIRM_QUOTE_MODE = 2;
const FIRM_QUOTE_SIDE = 2;
const FIRM_EXIT_QUOTE_SIDE = 1;
const RESERVATION_CLASS_VERSION = 2;
// Fixed firm entry addresses other than the perp venue accounts: 59 with the eight Rise accounts.
const FIXED_FIRM_ENTRY_BASE_ADDRESS_COUNT = 51;
const MAX_RESOLVED_ADDRESSES = 64;
const LEGACY_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const FIRM_RESERVATION_ADAPTER_CLASS = 'naryx.solana.spot-firm-reservation';

const HASH_DOMAINS = {
  execution: 'NARYX/cash-carry-execution/v1',
  quotedExecution: 'NARYX/quoted-cash-carry-execution/v1',
  firmExecution: 'NARYX/firm-cash-carry-execution/v1',
  quoteIntent: 'NARYX/cash-carry-quote-intent/v1',
  quoteArgs: 'NARYX/firm-quote-args/v1',
  reservationPolicy: 'NARYX/firm-reservation-policy/v1',
  domainIdentity: 'CON/v1/domain-ref-identity',
  reservationId: 'CON/v1/reservation-id',
  routeAccounts: 'NARYX/cash-carry-route-accounts/v1',
  packageAccounts: 'NARYX/cash-carry-package-accounts/v1',
} as const;

export const FIRM_CASH_CARRY_ACCOUNT_NAMES = [
  'trader',
  'config',
  'solverRegistry',
  'riskDomainIndex',
  'riskDomainRecord',
  'solver',
  'receipt',
  'nonceMarker',
  'openPackage',
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
  'reservationProgram',
  'reservationProgramData',
  'coreProgram',
  'coreProgramData',
  'reservationClass',
  'reservationCapacity',
  'reservation',
  'livePair',
  'reservationVault',
  'solverQuote',
  'traderBase',
  'traderQuote',
  'executorBase',
  'executorQuote',
  'quoteLock',
  'seriesIndex',
  'seriesRecord',
  'perpAdapterProgram',
  'perpAdapterProgramData',
  'perpVenueProgram',
  'perpVenueProgramData',
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
  'packageBookProgram',
  'packageBookProgramData',
  'packageBookClass',
  'packageBookShard',
  'packageBookLevelPage',
] as const;

export type FirmCashCarryAccountName = typeof FIRM_CASH_CARRY_ACCOUNT_NAMES[number];
export type FirmCashCarryTestPerpAccountName =
  | Exclude<FirmCashCarryAccountName, RiseVenueAccountName>
  | NaryxTestPerpAccountName;
type FirmAccountKey = FirmCashCarryAccountName | NaryxTestPerpAccountName;
export type AnyFirmCashCarryBinding = FirmCashCarryBinding<SolanaPerpVenueKind>;
export type FirmCashCarryAccountsFor<K extends SolanaPerpVenueKind> = K extends 'NARYX_TEST_PERP'
  ? Readonly<Record<FirmCashCarryTestPerpAccountName, SolanaRouteAccountBinding>>
  : Readonly<Record<FirmCashCarryAccountName, SolanaRouteAccountBinding>>;
const FIRM_COMMON_ACCOUNT_NAMES = FIRM_CASH_CARRY_ACCOUNT_NAMES.filter(
  (name) => !(RISE_VENUE_ACCOUNT_NAMES as readonly string[]).includes(name),
);
export type FirmTokenAccountName =
  | 'reservationVault'
  | 'solverQuote'
  | 'traderBase'
  | 'traderQuote'
  | 'executorBase'
  | 'executorQuote';

export interface SolanaRouteAccountBinding {
  readonly address: PublicKey | string;
  readonly routeBindingId: string;
}

export interface FirmRiseDynamicAccountBinding extends SolanaRouteAccountBinding {
  readonly isWritable: boolean;
}

export interface SolanaProgramDeploymentRef {
  readonly programId: PublicKey | string;
  readonly programDataAddress: PublicKey | string;
  readonly codeIdentity: Uint8Array;
}

export interface FirmCashCarryDeployments {
  readonly core: SolanaProgramDeploymentRef;
  readonly reservation: SolanaProgramDeploymentRef;
  readonly packageBook: SolanaProgramDeploymentRef;
  readonly perpAdapter: SolanaProgramDeploymentRef;
  readonly perpVenue: SolanaProgramDeploymentRef;
}

export interface FirmResourceManifestEvidence {
  readonly subjectId: Uint8Array;
  readonly manifestHash: Uint8Array;
  readonly subjectAddress: PublicKey | string;
  readonly programId: PublicKey | string;
  readonly codeIdentity?: Uint8Array;
  readonly adapterClassId?: string;
}

export interface FirmResourceEvidence {
  readonly spotAdapter: FirmResourceManifestEvidence;
  readonly perpAdapter: FirmResourceManifestEvidence;
  readonly spotMarket: FirmResourceManifestEvidence;
  readonly perpMarket: FirmResourceManifestEvidence;
  readonly spotVenue: FirmResourceManifestEvidence;
  readonly perpVenue: FirmResourceManifestEvidence;
  readonly baseAsset: FirmResourceManifestEvidence;
  readonly quoteAsset: FirmResourceManifestEvidence;
  readonly spotBaseLotAtoms: bigint;
  readonly perpBaseLotAtoms: bigint;
  readonly perpQuoteTickAtomsPerBaseLot: bigint;
}

export interface FirmSeriesEvidence {
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassManifestHash: Uint8Array;
  readonly settlementClassIdentityHash: Uint8Array;
  readonly entrySide: 'ASK';
  readonly spotBaseAtomsPerPackageUnit: bigint;
  readonly perpQuantityAtomsPerPackageUnit: bigint;
}

export interface FirmReservationClassEvidence {
  readonly version: 2;
  readonly domain: DomainRef;
  readonly policyHash: Uint8Array;
  readonly baseMint: PublicKey | string;
  readonly quoteMint: PublicKey | string;
  readonly maxTtlSlots: bigint;
  readonly maxBaseAtoms: bigint;
  readonly maxSolverReservedBaseAtoms: bigint;
}

export interface FirmReservationEvidence {
  readonly fundingFinalized: true;
  readonly state: 'LIVE';
  readonly domain: DomainRef;
  readonly reservationId: Uint8Array;
  readonly reservationNonce: Uint8Array;
  readonly solverId: string;
  readonly solver: PublicKey | string;
  readonly strategyAuthority: PublicKey | string;
  readonly packageNonce: bigint;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly baseMint: PublicKey | string;
  readonly quoteMint: PublicKey | string;
  readonly solverReclaimBase: PublicKey | string;
  readonly solverQuote: PublicKey | string;
  readonly strategyBase: PublicKey | string;
  readonly strategyQuote: PublicKey | string;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly expirySlot: bigint;
  /** ENTRY: the solver sells base for escrowed base. EXIT: the solver buys base back with escrowed quote. */
  readonly action: 'ENTRY' | 'EXIT';
}

export interface FirmQuoteLockEvidence {
  readonly consumed: false;
  readonly domain: DomainRef;
  readonly solver: PublicKey | string;
  readonly reservation: PublicKey | string;
  readonly reservationId: Uint8Array;
  readonly reservationPolicyHash: Uint8Array;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly quoteArgsHash: Uint8Array;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassManifestHash: Uint8Array;
  readonly fillCommitment: Uint8Array;
  readonly packageSizeUnits: bigint;
  readonly baseAtoms: bigint;
  readonly quoteAtoms: bigint;
  readonly expirySlot: bigint;
}

export interface FirmTokenAccountEvidence {
  readonly mint: PublicKey | string;
  readonly authority: PublicKey | string;
  readonly amountAtoms: bigint;
}

export interface FirmCashCarryExecutionArgs extends SolanaCashCarryRiskArgs {
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

export interface FirmCashCarryQuoteArgs {
  readonly packageBookCodeIdentity: Uint8Array;
  readonly seriesManifestHash: Uint8Array;
  readonly executionClassManifestHash: Uint8Array;
  readonly expectedReferenceSequence: bigint;
  readonly expectedShardSequence: bigint;
  readonly slotIndex: number;
  readonly levelId: bigint;
  readonly expectedLevelSequence: bigint;
  /** 2 lifts the solver's ask on entry; 1 hits the solver's bid on a firm exit. */
  readonly expectedSide: 1 | 2;
  readonly packageSizeUnits: bigint;
  readonly expectedPackagePrice: bigint;
  readonly expectedMaxFeeAtoms: 0n;
  readonly expectedExpirySlot: bigint;
  readonly expectedSettlementClassIdentityHash: Uint8Array;
  readonly expectedQuoteMode: 2;
  readonly expectedReservationPolicyHash: Uint8Array;
  readonly reservationId: Uint8Array;
  readonly expectedFillCommitment: Uint8Array;
}

export interface SolanaMessageContext {
  readonly recentBlockhash: string;
  readonly addressLookupTables: readonly AddressLookupTableAccount[];
}

export interface FirmCashCarryBinding<K extends SolanaPerpVenueKind = 'PHOENIX_RISE'> {
  /** Omitted means ENTRY. EXIT is the firm buy-back exit of the open package (test perp core build). */
  readonly action?: 'ENTRY' | 'EXIT';
  readonly environment: 'local' | 'devnet' | 'testnet';
  readonly domain: DomainRef;
  readonly coreIdl: Idl;
  readonly expectedCoreIdlHash: Uint8Array;
  readonly deployments: FirmCashCarryDeployments;
  /** Selected by the Devnet manifest. Omitted means the default Phoenix Rise core build. */
  readonly perpVenueKind?: K;
  readonly accounts: FirmCashCarryAccountsFor<K>;
  readonly riseDynamicAccounts: readonly FirmRiseDynamicAccountBinding[];
  readonly tokenAccounts: Readonly<Record<FirmTokenAccountName, FirmTokenAccountEvidence>>;
  readonly resources: FirmResourceEvidence;
  readonly series: FirmSeriesEvidence;
  readonly reservationClass: FirmReservationClassEvidence;
  readonly reservation: FirmReservationEvidence;
  readonly quoteLock: FirmQuoteLockEvidence;
  readonly executionArgs: FirmCashCarryExecutionArgs;
  readonly quoteArgs: FirmCashCarryQuoteArgs;
  readonly firmQuoteAtoms: bigint;
  readonly resourceAdmissionCommitment: Uint8Array;
  readonly solverSignature: Uint8Array;
  readonly computeUnitLimit: number;
  readonly currentSlot: bigint;
  readonly traderRouteBindingId: string;
  readonly solverRouteBindingId: string;
  readonly messageContext?: SolanaMessageContext;
  readonly publicExit?: PublicCashCarryExitBinding<K>;
}

export type SolanaMessageSizeEvidence =
  | Readonly<{
      status: 'PROVEN';
      serializedMessageBytes: number;
      serializedTransactionBytes: number;
      fitsPacketDataLimit: boolean;
      lookupTableCount: number;
    }>
  | Readonly<{
      status: 'UNPROVEN';
      reason: 'RECENT_BLOCKHASH_AND_ALT_CONTENTS_REQUIRED';
    }>;

export interface UnsignedSolanaTransactionPlan {
  readonly authorityRole: 'SOLVER' | 'TRADER';
  readonly payer: PublicKey;
  readonly instructions: readonly TransactionInstruction[];
  readonly resolvedAddressCount: number;
  readonly messageSize: SolanaMessageSizeEvidence;
}

export interface FirmCashCarryPlan {
  readonly kind: 'MULTI_TRANSACTION_FIRM_CASH_CARRY_PLAN';
  readonly atomicity: 'ONLY_TRADER_ENTRY_TRANSACTION_IS_ATOMIC';
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly executionDigest: Uint8Array;
  readonly solverLock: UnsignedSolanaTransactionPlan & Readonly<{
    stage: 'SOLVER_FIRM_QUOTE_LOCK';
    prerequisite: 'FUNDED_FINALIZED_LIVE_RESERVATION';
  }>;
  readonly traderEntry: UnsignedSolanaTransactionPlan & Readonly<{
    stage: 'TRADER_ATOMIC_FIRM_ENTRY';
  }>;
  readonly publicExit: PublicCashCarryExitPlan | Readonly<{
    status: 'EVIDENCE_REQUIRED';
    code: 'PUBLIC_EXIT_BINDING_REQUIRED';
  }>;
}

export interface FirmCashCarryExitPlan {
  readonly kind: 'MULTI_TRANSACTION_FIRM_CASH_CARRY_EXIT_PLAN';
  readonly atomicity: 'ONLY_TRADER_EXIT_TRANSACTION_IS_ATOMIC';
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly executionDigest: Uint8Array;
  readonly solverLock: UnsignedSolanaTransactionPlan & Readonly<{
    stage: 'SOLVER_FIRM_QUOTE_LOCK';
    prerequisite: 'FUNDED_FINALIZED_LIVE_RESERVATION';
  }>;
  readonly traderExit: UnsignedSolanaTransactionPlan & Readonly<{
    stage: 'TRADER_ATOMIC_FIRM_EXIT';
  }>;
}

interface AccountSpec {
  readonly idlName: string;
  readonly bindingName: FirmAccountKey;
  readonly signer: boolean;
  readonly writable: boolean;
}

interface FlatIdlAccount {
  readonly name: string;
  readonly signer?: boolean;
  readonly writable?: boolean;
  readonly address?: string;
}

const LOCK_IDL_SPECS: readonly AccountSpec[] = [
  { idlName: 'solver', bindingName: 'solver', signer: true, writable: true },
  { idlName: 'config', bindingName: 'config', signer: false, writable: false },
  { idlName: 'reservation', bindingName: 'reservation', signer: false, writable: false },
  { idlName: 'reservation_class', bindingName: 'reservationClass', signer: false, writable: false },
  { idlName: 'quote_lock', bindingName: 'quoteLock', signer: false, writable: true },
  { idlName: 'system_program', bindingName: 'systemProgram', signer: false, writable: false },
] as const;

const LOCK_REMAINING_SPECS: readonly AccountSpec[] = [
  { idlName: 'package_book_program', bindingName: 'packageBookProgram', signer: false, writable: false },
  { idlName: 'package_book_program_data', bindingName: 'packageBookProgramData', signer: false, writable: false },
  { idlName: 'core_program', bindingName: 'coreProgram', signer: false, writable: false },
  { idlName: 'core_program_data', bindingName: 'coreProgramData', signer: false, writable: false },
  { idlName: 'package_book_class', bindingName: 'packageBookClass', signer: false, writable: false },
  { idlName: 'package_book_shard', bindingName: 'packageBookShard', signer: false, writable: true },
  { idlName: 'package_book_level_page', bindingName: 'packageBookLevelPage', signer: false, writable: true },
] as const;

const ENTRY_PREFIX_SPECS: readonly AccountSpec[] = [
  { idlName: 'trader', bindingName: 'trader', signer: true, writable: true },
  { idlName: 'config', bindingName: 'config', signer: false, writable: false },
  { idlName: 'solver_registry', bindingName: 'solverRegistry', signer: false, writable: false },
  { idlName: 'risk_domain_index', bindingName: 'riskDomainIndex', signer: false, writable: false },
  { idlName: 'risk_domain_record', bindingName: 'riskDomainRecord', signer: false, writable: false },
  { idlName: 'solver', bindingName: 'solver', signer: false, writable: true },
  { idlName: 'receipt', bindingName: 'receipt', signer: false, writable: true },
  { idlName: 'nonce_marker', bindingName: 'nonceMarker', signer: false, writable: true },
  { idlName: 'open_package', bindingName: 'openPackage', signer: false, writable: true },
  { idlName: 'executor_authority', bindingName: 'executorAuthority', signer: false, writable: false },
  ...[
    ['spot_adapter_index', 'spotAdapterIndex'],
    ['perp_adapter_index', 'perpAdapterIndex'],
    ['spot_market_index', 'spotMarketIndex'],
    ['perp_market_index', 'perpMarketIndex'],
    ['spot_venue_index', 'spotVenueIndex'],
    ['perp_venue_index', 'perpVenueIndex'],
    ['base_asset_index', 'baseAssetIndex'],
    ['quote_asset_index', 'quoteAssetIndex'],
    ['spot_adapter_record', 'spotAdapterRecord'],
    ['perp_adapter_record', 'perpAdapterRecord'],
    ['spot_market_record', 'spotMarketRecord'],
    ['perp_market_record', 'perpMarketRecord'],
    ['spot_venue_record', 'spotVenueRecord'],
    ['perp_venue_record', 'perpVenueRecord'],
    ['base_asset_record', 'baseAssetRecord'],
    ['quote_asset_record', 'quoteAssetRecord'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as FirmCashCarryAccountName, signer: false, writable: false })),
  ...[
    ['reservation_program', 'reservationProgram'],
    ['reservation_program_data', 'reservationProgramData'],
    ['core_program', 'coreProgram'],
    ['core_program_data', 'coreProgramData'],
    ['reservation_class', 'reservationClass'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as FirmCashCarryAccountName, signer: false, writable: false })),
  ...[
    ['reservation_capacity', 'reservationCapacity'],
    ['reservation', 'reservation'],
    ['live_pair', 'livePair'],
    ['reservation_vault', 'reservationVault'],
    ['solver_quote', 'solverQuote'],
    ['trader_base', 'traderBase'],
    ['trader_quote', 'traderQuote'],
    ['executor_base', 'executorBase'],
    ['executor_quote', 'executorQuote'],
  ].map(([idlName, bindingName]) => ({ idlName: idlName!, bindingName: bindingName! as FirmCashCarryAccountName, signer: false, writable: true })),
  { idlName: 'quote_lock', bindingName: 'quoteLock', signer: false, writable: true },
  { idlName: 'series_index', bindingName: 'seriesIndex', signer: false, writable: false },
  { idlName: 'series_record', bindingName: 'seriesRecord', signer: false, writable: false },
  { idlName: 'perp_adapter_program', bindingName: 'perpAdapterProgram', signer: false, writable: false },
  { idlName: 'perp_adapter_program_data', bindingName: 'perpAdapterProgramData', signer: false, writable: false },
  { idlName: 'perp_venue_program', bindingName: 'perpVenueProgram', signer: false, writable: false },
  { idlName: 'perp_venue_program_data', bindingName: 'perpVenueProgramData', signer: false, writable: false },
  { idlName: 'rise_strategy', bindingName: 'riseStrategy', signer: false, writable: true },
] as const;

const ENTRY_SUFFIX_SPECS: readonly AccountSpec[] = [
  { idlName: 'token_program', bindingName: 'tokenProgram', signer: false, writable: false },
  { idlName: 'instructions_sysvar', bindingName: 'instructionsSysvar', signer: false, writable: false },
  { idlName: 'system_program', bindingName: 'systemProgram', signer: false, writable: false },
] as const;

function entryIdlSpecs(profile: SolanaPerpVenueProfile): readonly AccountSpec[] {
  return [
    ...ENTRY_PREFIX_SPECS,
    ...profile.accounts.map((account) => ({ ...account, signer: false })),
    ...ENTRY_SUFFIX_SPECS,
  ];
}

function isExit(binding: AnyFirmCashCarryBinding): boolean {
  requireCondition(binding.action === undefined || binding.action === 'ENTRY' || binding.action === 'EXIT', 'firm binding action is invalid');
  return binding.action === 'EXIT';
}

function bindingProfile(binding: AnyFirmCashCarryBinding): SolanaPerpVenueProfile {
  return solanaPerpVenueProfile(binding.perpVenueKind);
}

function accountBinding(binding: AnyFirmCashCarryBinding, name: FirmAccountKey): SolanaRouteAccountBinding {
  const account = (binding.accounts as Readonly<Record<string, SolanaRouteAccountBinding | undefined>>)[name];
  requireCondition(account !== undefined, `missing ${name} account binding`);
  return account;
}

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
  requireCondition(value instanceof Uint8Array && value.length === 32, `${name} must be 32 bytes`);
  requireCondition(value.some((byte) => byte !== 0), `${name} must be nonzero`);
  return Uint8Array.from(value);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function requireBytes(actual: Uint8Array, expected: Uint8Array, name: string): void {
  requireCondition(bytesEqual(actual, expected), `${name} mismatch`);
}

function requireKey(actual: PublicKey | string, expected: PublicKey | string, name: string): void {
  requireCondition(publicKey(actual, name).equals(publicKey(expected, name)), `${name} mismatch`);
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

function bn(value: bigint): InstanceType<typeof BN> {
  return new BN(value.toString());
}

function bigEndian(value: bigint, byteLength: number, signed = false): Uint8Array {
  const bits = BigInt(byteLength * 8);
  const encoded = signed && value < 0n ? (1n << bits) + value : value;
  const output = new Uint8Array(byteLength);
  let remaining = encoded;
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function lengthPrefix(value: number): Uint8Array {
  return bigEndian(BigInt(value), 4);
}

function protocolIdBytes(value: string, name: string): Uint8Array {
  const encoded = Buffer.from(value, 'utf8');
  requireCondition(encoded.length > 0 && encoded.length <= 64 && /^[\x20-\x7e]+$/.test(value), `${name} is invalid`);
  return Buffer.concat([Buffer.from(lengthPrefix(encoded.length)), encoded]);
}

function domainBytes(domain: DomainRef): Uint8Array {
  requireCondition(domain.domainManifestVersion > 0, 'domain manifest version must be nonzero');
  return Buffer.concat([
    Buffer.from(protocolIdBytes(domain.domainId, 'domain id')),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(hash32(domain.domainManifestHash, 'domain manifest hash')),
  ]);
}

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

function domainHash(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  return sha256(Buffer.from(domain, 'ascii'), ...parts);
}

function codeIdentityHex(value: Uint8Array, name: string): string {
  return Buffer.from(hash32(value, name)).toString('hex');
}

export function solanaIdlContentHash(idl: Idl): Uint8Array {
  return sha256(Buffer.from(JSON.stringify(idl), 'utf8'));
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), LEGACY_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
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

function idlInstruction(idl: Idl, name: string, expectedArgs: readonly string[], expectedAccounts: readonly AccountSpec[]) {
  const instruction = idl.instructions.find((item) => item.name === name);
  requireCondition(instruction !== undefined, `published core IDL is missing ${name}`);
  requireCondition(
    instruction.args.length === expectedArgs.length
      && instruction.args.every((argument, index) => argument.name === expectedArgs[index]),
    `${name} IDL argument shape mismatch`,
  );
  const accounts = flattenIdlAccounts(instruction.accounts);
  requireCondition(accounts.length === expectedAccounts.length, `${name} IDL account count mismatch`);
  for (const [index, expected] of expectedAccounts.entries()) {
    const actual = accounts[index]!;
    requireCondition(actual.name === expected.idlName, `${name} IDL account ${index} mismatch`);
    requireCondition((actual.signer === true) === expected.signer, `${name} IDL signer ${actual.name} mismatch`);
    requireCondition((actual.writable === true) === expected.writable, `${name} IDL writable ${actual.name} mismatch`);
  }
  return { instruction, accounts };
}

function routeBindings(admission: PackageAdmission): Map<string, typeof admission.route.accountBindings[number]> {
  const result = new Map<string, typeof admission.route.accountBindings[number]>();
  for (const binding of admission.route.accountBindings) {
    requireCondition(!result.has(binding.routeBindingId), `duplicate route binding ${binding.routeBindingId}`);
    result.set(binding.routeBindingId, binding);
  }
  return result;
}

function validateRouteAccount(
  binding: SolanaRouteAccountBinding,
  routes: Map<string, PackageAdmission['route']['accountBindings'][number]>,
  name: string,
): PublicKey {
  const address = publicKey(binding.address, name);
  const route = routes.get(binding.routeBindingId);
  requireCondition(route !== undefined, `${name} route binding is missing`);
  requireCondition(route.accountIdentity === address.toBase58(), `${name} route binding address mismatch`);
  return address;
}

function accountKeys(
  specs: readonly AccountSpec[],
  idlAccounts: readonly FlatIdlAccount[],
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
) {
  return specs.map((spec, index) => {
    const pubkey = addresses.get(spec.bindingName)!;
    const idlAccount = idlAccounts[index]!;
    if (idlAccount.address !== undefined) {
      requireCondition(pubkey.equals(publicKey(idlAccount.address, `IDL ${idlAccount.name}`)), `IDL ${idlAccount.name} address mismatch`);
    }
    return { pubkey, isSigner: idlAccount.signer === true, isWritable: idlAccount.writable === true };
  });
}

function explicitKeys(specs: readonly AccountSpec[], addresses: ReadonlyMap<FirmAccountKey, PublicKey>) {
  return specs.map((spec) => ({
    pubkey: addresses.get(spec.bindingName)!,
    isSigner: spec.signer,
    isWritable: spec.writable,
  }));
}

function borshQuoteArgs(args: FirmCashCarryQuoteArgs) {
  return {
    package_book_code_identity: Array.from(args.packageBookCodeIdentity),
    series_manifest_hash: Array.from(args.seriesManifestHash),
    execution_class_manifest_hash: Array.from(args.executionClassManifestHash),
    expected_reference_sequence: bn(args.expectedReferenceSequence),
    expected_shard_sequence: bn(args.expectedShardSequence),
    slot_index: args.slotIndex,
    level_id: bn(args.levelId),
    expected_level_sequence: bn(args.expectedLevelSequence),
    expected_side: args.expectedSide,
    package_size_units: bn(args.packageSizeUnits),
    expected_package_price: bn(args.expectedPackagePrice),
    expected_max_fee_atoms: bn(args.expectedMaxFeeAtoms),
    expected_expiry_slot: bn(args.expectedExpirySlot),
    expected_settlement_class_identity_hash: Array.from(args.expectedSettlementClassIdentityHash),
    expected_quote_mode: args.expectedQuoteMode,
    expected_reservation_policy_hash: Array.from(args.expectedReservationPolicyHash),
    reservation_id: Array.from(args.reservationId),
    expected_fill_commitment: Array.from(args.expectedFillCommitment),
  };
}

function borshExecutionArgs(args: FirmCashCarryExecutionArgs, exit: boolean) {
  return {
    action: exit ? { Exit: {} } : { Entry: {} },
    recovery: false,
    spot_quantity_atoms: bn(args.spotQuantityAtoms),
    perp_quantity_atoms: bn(args.perpQuantityAtoms),
    spot_limit_quote_atoms_per_base_lot: bn(args.spotLimitQuoteAtomsPerBaseLot),
    perp_limit_quote_atoms_per_base_lot: bn(args.perpLimitQuoteAtomsPerBaseLot),
    package_notional_atoms: bn(args.packageNotionalAtoms),
    spot_sqrt_price_limit: bn(args.spotSqrtPriceLimit),
    minimum_rise_collateral_quote_lots: bn(args.minimumRiseCollateralQuoteLots),
    client_order_id: bn(args.clientOrderId),
    expiry_slot: bn(args.expirySlot),
    nonce: bn(args.nonce),
    ...borshRiskArgs(args),
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

function messageSize(
  payer: PublicKey,
  instructions: readonly TransactionInstruction[],
  context: SolanaMessageContext | undefined,
): SolanaMessageSizeEvidence {
  if (context === undefined) {
    return Object.freeze({ status: 'UNPROVEN', reason: 'RECENT_BLOCKHASH_AND_ALT_CONTENTS_REQUIRED' });
  }
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

function validatePackage(admission: PackageAdmission, binding: AnyFirmCashCarryBinding): void {
  const { order, quote, route } = admission;
  requireCondition(binding.domain.domainId.startsWith('svm:'), 'domain must use the SVM namespace');
  requireCondition(order.environment === binding.environment, 'order environment mismatch');
  requireCondition(quote.environment === binding.environment && route.environment === binding.environment, 'package environment mismatch');
  requireCondition(sameDomain(order.domain, binding.domain), 'order domain mismatch');
  requireCondition(sameDomain(quote.domain, binding.domain) && sameDomain(route.domain, binding.domain), 'package domain mismatch');
  const action = isExit(binding) ? 'EXIT' : 'ENTRY';
  requireCondition(order.action === action && route.action === action, `firm ${action.toLowerCase()} plan requires a ${action} package`);
  requireCondition(quote.quoteMode === 'FIRM_ONCHAIN', 'firm plan requires FIRM_ONCHAIN quote mode');
  requireCondition(quote.solverSignatureScheme === 'ED25519', 'firm plan requires Ed25519 solver verification');
  requireCondition(order.templateId === 'cash-and-carry-v1' && route.templateId === order.templateId, 'cash-carry template mismatch');
  requireCondition(order.direction === 'LONG_SPOT_SHORT_PERP' && route.direction === order.direction, 'cash-carry direction mismatch');
  requireCondition(order.settlementClass === 'ATOMIC_POSTCONDITION' && route.settlementClass === order.settlementClass, 'settlement class mismatch');
  requireCondition(route.executionPlanKind === 'SVM_ATOMIC_CPI', 'execution plan kind mismatch');
  requireCondition(order.partialFillPolicy === 'EXACT_ALL_LEGS' && route.partialFillPolicy === order.partialFillPolicy, 'partial fill policy mismatch');
  requireCondition(order.owner === route.owner, 'trader identity mismatch');
  requireCondition(quote.solverId === route.solver, 'solver identity mismatch');
  requireCondition(route.serviceCharges.length === 0 && quote.protocolFee.atoms === 0n && quote.solverFee.atoms === 0n, 'protocol and solver fees must be zero');
  requireBytes(quote.orderHash, admission.orderHash, 'quote order commitment');
  requireBytes(route.orderHash, admission.orderHash, 'route order commitment');
  requireBytes(quote.routeHash, admission.routeHash, 'quote route commitment');
  requireCondition(quote.reservationId !== undefined, 'firm reservation commitment is missing');
  requireBytes(quote.reservationId, binding.quoteArgs.reservationId, 'quote reservation commitment');
  requireCondition(order.expiryUnit === 'SOLANA_SLOT' && quote.validUntilUnit === 'SOLANA_SLOT' && route.routeExpiryUnit === 'SOLANA_SLOT', 'expiry unit mismatch');
  const expiry = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((left, right) => left < right ? left : right);
  requireCondition(binding.currentSlot < expiry, 'package is expired');
  requireCondition(binding.executionArgs.expirySlot === expiry && binding.quoteArgs.expectedExpirySlot === expiry, 'firm expiry commitment mismatch');
  requireCondition(route.legs.length === 2, 'firm route requires exactly two legs');
  const spot = route.legs[0];
  const perp = route.legs[1];
  requireCondition(spot?.legRole === 'SPOT' && perp?.legRole === 'PERPETUAL', 'firm leg roles mismatch');
  requireCondition(
    action === 'ENTRY'
      ? spot.side === 'BUY' && perp.side === 'SELL' && !perp.reduceOnly
      : spot.side === 'SELL' && perp.side === 'BUY' && perp.reduceOnly,
    'firm leg sides mismatch',
  );
  requireCondition(
    order.quantity.atoms === quote.expectedGrossSpotQuantity.atoms
      && spot.quantity.atoms === order.quantity.atoms
      && perp.quantity.atoms === order.quantity.atoms
      && binding.executionArgs.spotQuantityAtoms === order.quantity.atoms
      && binding.executionArgs.perpQuantityAtoms === order.quantity.atoms,
    'firm leg quantities mismatch',
  );
  requireCondition(order.quantity.atoms > 0n, 'package quantity must be nonzero');
  requireCondition(sameAsset(order.quantity.asset, spot.baseAsset) && sameAsset(spot.baseAsset, perp.baseAsset), 'base asset mismatch');
  requireCondition(sameAsset(spot.quoteAsset, perp.quoteAsset), 'quote asset mismatch');
}

function validateProgramsAndResources(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
  routes: Map<string, PackageAdmission['route']['accountBindings'][number]>,
): { baseMint: PublicKey; quoteMint: PublicKey; solver: PublicKey; trader: PublicKey } {
  const deployments = binding.deployments;
  requireKey(addresses.get('coreProgram')!, deployments.core.programId, 'core program');
  requireKey(addresses.get('coreProgramData')!, deployments.core.programDataAddress, 'core program data');
  requireKey(addresses.get('reservationProgram')!, deployments.reservation.programId, 'reservation program');
  requireKey(addresses.get('reservationProgramData')!, deployments.reservation.programDataAddress, 'reservation program data');
  requireKey(addresses.get('packageBookProgram')!, deployments.packageBook.programId, 'package book program');
  requireKey(addresses.get('packageBookProgramData')!, deployments.packageBook.programDataAddress, 'package book program data');
  requireKey(addresses.get('perpAdapterProgram')!, deployments.perpAdapter.programId, 'perp adapter program');
  requireKey(addresses.get('perpAdapterProgramData')!, deployments.perpAdapter.programDataAddress, 'perp adapter program data');
  requireKey(addresses.get('perpVenueProgram')!, deployments.perpVenue.programId, 'perp venue program');
  requireKey(addresses.get('perpVenueProgramData')!, deployments.perpVenue.programDataAddress, 'perp venue program data');
  requireBytes(binding.quoteArgs.packageBookCodeIdentity, hash32(deployments.packageBook.codeIdentity, 'package book code identity'), 'package book code identity');

  for (const [name, deployment, accountName] of [
    ['core', deployments.core, 'coreProgram'],
    ['reservation', deployments.reservation, 'reservationProgram'],
    ['package book', deployments.packageBook, 'packageBookProgram'],
    ['perp adapter', deployments.perpAdapter, 'perpAdapterProgram'],
    ['perp venue', deployments.perpVenue, 'perpVenueProgram'],
  ] as const) {
    const route = routes.get(accountBinding(binding, accountName).routeBindingId)!;
    requireCondition(route.codeIdentity === codeIdentityHex(deployment.codeIdentity, `${name} code identity`), `${name} route code identity mismatch`);
  }

  const spot = admission.route.legs[0]!;
  const perp = admission.route.legs[1]!;
  const resourcePairs = [
    ['spot adapter', binding.resources.spotAdapter, spot.adapter.adapterManifestHash],
    ['perp adapter', binding.resources.perpAdapter, perp.adapter.adapterManifestHash],
    ['spot market', binding.resources.spotMarket, spot.market.manifestHash],
    ['perp market', binding.resources.perpMarket, perp.market.manifestHash],
    ['spot venue', binding.resources.spotVenue, spot.venue.manifestHash],
    ['perp venue', binding.resources.perpVenue, perp.venue.manifestHash],
    ['base asset', binding.resources.baseAsset, spot.baseAsset.assetManifestHash],
    ['quote asset', binding.resources.quoteAsset, spot.quoteAsset.assetManifestHash],
  ] as const;
  for (const [name, resource, expectedHash] of resourcePairs) {
    hash32(resource.subjectId, `${name} subject id`);
    requireBytes(hash32(resource.manifestHash, `${name} manifest hash`), expectedHash, `${name} manifest commitment`);
  }

  const baseMint = publicKey(binding.resources.baseAsset.subjectAddress, 'base mint');
  const quoteMint = publicKey(binding.resources.quoteAsset.subjectAddress, 'quote mint');
  requireCondition(!baseMint.equals(quoteMint), 'asset mints must differ');
  requireCondition(spot.baseAsset.assetId === baseMint.toBase58() && spot.quoteAsset.assetId === quoteMint.toBase58(), 'asset mint identity mismatch');
  requireKey(binding.resources.baseAsset.programId, LEGACY_TOKEN_PROGRAM_ID, 'base asset token program');
  requireKey(binding.resources.quoteAsset.programId, LEGACY_TOKEN_PROGRAM_ID, 'quote asset token program');
  requireCondition(binding.resources.spotAdapter.adapterClassId === FIRM_RESERVATION_ADAPTER_CLASS, 'firm spot adapter class mismatch');

  const reservationProgram = deployments.reservation.programId;
  const reservationClass = addresses.get('reservationClass')!;
  for (const [name, resource, subject] of [
    ['spot adapter', binding.resources.spotAdapter, reservationProgram],
    ['spot venue', binding.resources.spotVenue, reservationClass],
    ['spot market', binding.resources.spotMarket, reservationClass],
  ] as const) {
    requireKey(resource.subjectAddress, subject, `${name} subject`);
    requireKey(resource.programId, reservationProgram, `${name} program`);
    requireBytes(hash32(resource.codeIdentity!, `${name} code identity`), deployments.reservation.codeIdentity, `${name} code identity`);
  }
  for (const [name, resource, subject, deployment] of [
    ['perp adapter', binding.resources.perpAdapter, deployments.perpAdapter.programId, deployments.perpAdapter],
    ['perp venue', binding.resources.perpVenue, addresses.get(bindingProfile(binding).venueSubject)!, deployments.perpVenue],
    ['perp market', binding.resources.perpMarket, addresses.get(bindingProfile(binding).marketSubject)!, deployments.perpVenue],
  ] as const) {
    requireKey(resource.subjectAddress, subject, `${name} subject`);
    requireKey(resource.programId, deployment.programId, `${name} program`);
    requireBytes(hash32(resource.codeIdentity!, `${name} code identity`), deployment.codeIdentity, `${name} code identity`);
  }

  const trader = addresses.get('trader')!;
  const solver = addresses.get('solver')!;
  requireCondition(trader.toBase58() === admission.order.owner, 'trader account mismatch');
  requireCondition(solver.toBase58() === admission.route.solver, 'solver account mismatch');
  requireCondition(bytesEqual(solver.toBytes(), admission.quote.solverVerificationKey), 'solver verification key mismatch');
  return { baseMint, quoteMint, solver, trader };
}

function validateSeriesAndAmounts(admission: PackageAdmission, binding: AnyFirmCashCarryBinding): void {
  const { executionArgs: execution, quoteArgs: quote, series, resources } = binding;
  requireBytes(quote.seriesManifestHash, hash32(series.seriesManifestHash, 'series manifest hash'), 'series commitment');
  requireBytes(quote.executionClassManifestHash, hash32(series.executionClassManifestHash, 'execution class manifest hash'), 'execution class commitment');
  requireBytes(quote.expectedSettlementClassIdentityHash, hash32(series.settlementClassIdentityHash, 'settlement class identity hash'), 'settlement class identity commitment');
  const exit = isExit(binding);
  requireCondition(series.entrySide === 'ASK' && quote.expectedSide === (exit ? FIRM_EXIT_QUOTE_SIDE : FIRM_QUOTE_SIDE), 'firm quote side mismatch');
  const spotUnit = checkedPositiveU64(series.spotBaseAtomsPerPackageUnit, 'spot atoms per package unit');
  const perpUnit = checkedPositiveU64(series.perpQuantityAtomsPerPackageUnit, 'perp atoms per package unit');
  requireCondition(execution.spotQuantityAtoms % spotUnit === 0n && execution.perpQuantityAtoms % perpUnit === 0n, 'package quantity is not an exact series unit');
  const spotUnits = execution.spotQuantityAtoms / spotUnit;
  const perpUnits = execution.perpQuantityAtoms / perpUnit;
  requireCondition(spotUnits !== 0n && spotUnits === perpUnits && quote.packageSizeUnits === spotUnits, 'package size and leg units mismatch');

  const spotLot = checkedPositiveU64(resources.spotBaseLotAtoms, 'spot base lot');
  const perpLot = checkedPositiveU64(resources.perpBaseLotAtoms, 'perp base lot');
  const perpTick = checkedPositiveU64(resources.perpQuoteTickAtomsPerBaseLot, 'perp quote tick');
  requireCondition(execution.spotQuantityAtoms % spotLot === 0n && execution.perpQuantityAtoms % perpLot === 0n, 'leg quantities are not exact market lots');
  requireCondition(execution.perpLimitQuoteAtomsPerBaseLot % perpTick === 0n, 'perp limit is not an exact market tick');
  const totalSpotLimit = (execution.spotQuantityAtoms / spotLot) * execution.spotLimitQuoteAtomsPerBaseLot;
  if (exit) {
    // The program enforces quote out >= the spot limit, so the limit must carry the signed minimum.
    requireCondition(binding.firmQuoteAtoms >= totalSpotLimit, 'firm quote is below the spot minimum');
    requireCondition(admission.order.minSpotQuoteOut !== undefined && totalSpotLimit >= admission.order.minSpotQuoteOut.atoms, 'spot minimum is below the signed order bound');
  } else {
    requireCondition(binding.firmQuoteAtoms <= totalSpotLimit, 'firm quote exceeds the spot limit');
    requireCondition(admission.order.maxSpotQuoteIn !== undefined && totalSpotLimit <= admission.order.maxSpotQuoteIn.atoms, 'spot limit exceeds the signed order bound');
  }

  checkedPositiveU64(execution.spotQuantityAtoms, 'spot quantity');
  checkedPositiveU64(execution.perpQuantityAtoms, 'perp quantity');
  checkedPositiveU64(execution.spotLimitQuoteAtomsPerBaseLot, 'spot quote limit');
  checkedPositiveU64(execution.perpLimitQuoteAtomsPerBaseLot, 'perp quote limit');
  checkedPositiveU64(execution.packageNotionalAtoms, 'package notional');
  checkedUnsigned(execution.spotSqrtPriceLimit, U128_MAX, 'spot sqrt price limit');
  requireCondition(execution.spotSqrtPriceLimit === 1n, 'firm spot sqrt price limit must be one');
  checkedSigned(execution.minimumRiseCollateralQuoteLots, I64_MIN, I64_MAX, 'minimum Rise collateral');
  checkedUnsigned(execution.clientOrderId, U128_MAX, 'client order id');
  checkedPositiveU64(execution.expirySlot, 'execution expiry');
  checkedPositiveU64(execution.nonce, 'execution nonce');
  requireCondition(execution.nonce === admission.order.nonce, 'execution nonce mismatch');
  checkedPositiveU64(binding.firmQuoteAtoms, 'firm quote amount');
  requireCondition(binding.firmQuoteAtoms === admission.quote.expectedSpotNotional.atoms, 'firm quote amount mismatch');
  for (const [name, value] of [
    ['reference sequence', quote.expectedReferenceSequence],
    ['shard sequence', quote.expectedShardSequence],
    ['level id', quote.levelId],
    ['level sequence', quote.expectedLevelSequence],
    ['package size', quote.packageSizeUnits],
    ['quote expiry', quote.expectedExpirySlot],
  ] as const) checkedPositiveU64(value, name);
  requireCondition(Number.isInteger(quote.slotIndex) && quote.slotIndex >= 0 && quote.slotIndex <= 255, 'slot index is out of range');
  checkedSigned(quote.expectedPackagePrice, I128_MIN, I128_MAX, 'expected package price');
  requireCondition(quote.expectedMaxFeeAtoms === 0n, 'firm quote fee must be zero');
  requireCondition(quote.expectedQuoteMode === FIRM_QUOTE_MODE, 'firm quote mode commitment mismatch');
  hash32(quote.expectedFillCommitment, 'fill commitment');
  hash32(quote.expectedReservationPolicyHash, 'reservation policy hash');
}

function validateReservation(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
  identities: { baseMint: PublicKey; quoteMint: PublicKey; solver: PublicKey; trader: PublicKey },
  quoteArgsHash: Uint8Array,
): void {
  const { reservationClass, reservation, quoteLock, quoteArgs, deployments } = binding;
  requireCondition(reservation.fundingFinalized === true && reservation.state === 'LIVE', 'reservation must be funded, finalized, and live');
  requireCondition(quoteLock.consumed === false, 'quote lock has already been consumed');
  requireCondition(sameDomain(reservationClass.domain, binding.domain), 'reservation class domain mismatch');
  requireCondition(sameDomain(reservation.domain, binding.domain), 'reservation domain mismatch');
  requireCondition(sameDomain(quoteLock.domain, binding.domain), 'quote lock domain mismatch');
  requireCondition(reservationClass.version === RESERVATION_CLASS_VERSION, 'reservation class version mismatch');
  requireKey(reservationClass.baseMint, identities.baseMint, 'reservation class base mint');
  requireKey(reservationClass.quoteMint, identities.quoteMint, 'reservation class quote mint');
  checkedPositiveU64(reservationClass.maxTtlSlots, 'reservation class max TTL');
  checkedPositiveU64(reservationClass.maxBaseAtoms, 'reservation class max base amount');
  requireCondition(reservationClass.maxSolverReservedBaseAtoms >= reservationClass.maxBaseAtoms, 'reservation class solver cap mismatch');

  const domainIdentity = domainHash(HASH_DOMAINS.domainIdentity, domainBytes(binding.domain));
  const reservationProgram = publicKey(deployments.reservation.programId, 'reservation program');
  const coreProgram = publicKey(deployments.core.programId, 'core program');
  const expectedClass = PublicKey.findProgramAddressSync([
    Buffer.from('reservation-class'),
    Buffer.from(domainIdentity),
    Buffer.from(bigEndian(BigInt(binding.domain.domainManifestVersion), 4)),
    Buffer.from(binding.domain.domainManifestHash),
    identities.baseMint.toBuffer(),
    identities.quoteMint.toBuffer(),
    coreProgram.toBuffer(),
  ], reservationProgram)[0];
  requireKey(addresses.get('reservationClass')!, expectedClass, 'reservation class PDA');

  const policyHash = domainHash(
    HASH_DOMAINS.reservationPolicy,
    reservationProgram.toBytes(),
    publicKey(deployments.reservation.programDataAddress, 'reservation program data').toBytes(),
    hash32(deployments.reservation.codeIdentity, 'reservation code identity'),
    expectedClass.toBytes(),
    bigEndian(BigInt(RESERVATION_CLASS_VERSION), 2),
    domainBytes(binding.domain),
    identities.baseMint.toBytes(),
    identities.quoteMint.toBytes(),
    coreProgram.toBytes(),
    publicKey(deployments.core.programDataAddress, 'core program data').toBytes(),
    hash32(deployments.core.codeIdentity, 'core code identity'),
  );
  requireBytes(reservationClass.policyHash, policyHash, 'reservation class policy hash');
  requireBytes(quoteArgs.expectedReservationPolicyHash, policyHash, 'quote reservation policy hash');

  const reservationNonce = hash32(reservation.reservationNonce, 'reservation nonce');
  const reservationId = domainHash(
    HASH_DOMAINS.reservationId,
    domainBytes(binding.domain),
    protocolIdBytes(reservation.solverId, 'reservation solver id'),
    admission.orderHash,
    reservationNonce,
  );
  requireBytes(reservation.reservationId, reservationId, 'reservation id');
  requireBytes(quoteArgs.reservationId, reservationId, 'quote reservation id');
  requireCondition(reservation.solverId === admission.quote.solverId, 'reservation solver id mismatch');
  requireKey(reservation.solver, identities.solver, 'reservation solver');
  requireKey(reservation.strategyAuthority, addresses.get('executorAuthority')!, 'reservation strategy authority');
  requireCondition(reservation.packageNonce === binding.executionArgs.nonce, 'reservation package nonce mismatch');
  requireBytes(reservation.orderHash, admission.orderHash, 'reservation order commitment');
  requireBytes(reservation.quoteHash, admission.quoteHash, 'reservation quote commitment');
  requireBytes(reservation.routeHash, admission.routeHash, 'reservation route commitment');
  requireKey(reservation.baseMint, identities.baseMint, 'reservation base mint');
  requireKey(reservation.quoteMint, identities.quoteMint, 'reservation quote mint');
  const exit = isExit(binding);
  const solverQuoteAccount = associatedTokenAddress(identities.solver, identities.quoteMint);
  requireKey(reservation.solverQuote, solverQuoteAccount, 'reservation solver quote account');
  // The settlement slot carries the solver's quote account on entry and its base account on exit.
  requireKey(
    addresses.get('solverQuote')!,
    exit ? associatedTokenAddress(identities.solver, identities.baseMint) : solverQuoteAccount,
    'solver settlement account',
  );
  requireKey(reservation.strategyBase, addresses.get('executorBase')!, 'reservation strategy base account');
  requireKey(reservation.strategyQuote, addresses.get('executorQuote')!, 'reservation strategy quote account');
  requireKey(reservation.solverReclaimBase, associatedTokenAddress(identities.solver, identities.baseMint), 'reservation solver reclaim account');
  requireCondition(reservation.baseAtoms === binding.executionArgs.spotQuantityAtoms, 'reservation base amount mismatch');
  requireCondition(reservation.quoteAtoms === binding.firmQuoteAtoms, 'reservation quote amount mismatch');
  requireCondition(reservation.expirySlot === quoteArgs.expectedExpirySlot, 'reservation expiry mismatch');
  requireCondition(reservation.action === (exit ? 'EXIT' : 'ENTRY') && binding.currentSlot < reservation.expirySlot, 'reservation action or expiry mismatch');

  const reservationAddress = PublicKey.findProgramAddressSync([
    Buffer.from('reservation'),
    expectedClass.toBuffer(),
    identities.solver.toBuffer(),
    Buffer.from(reservationId),
  ], reservationProgram)[0];
  requireKey(addresses.get('reservation')!, reservationAddress, 'reservation PDA');
  requireKey(addresses.get('reservationCapacity')!, PublicKey.findProgramAddressSync([
    Buffer.from('reservation-capacity'), expectedClass.toBuffer(), identities.solver.toBuffer(),
  ], reservationProgram)[0], 'reservation capacity PDA');
  requireKey(addresses.get('livePair')!, PublicKey.findProgramAddressSync([
    Buffer.from('live-pair'), expectedClass.toBuffer(), identities.solver.toBuffer(), addresses.get('executorAuthority')!.toBuffer(),
  ], reservationProgram)[0], 'reservation live-pair PDA');
  requireKey(addresses.get('reservationVault')!, PublicKey.findProgramAddressSync([
    Buffer.from('reservation-vault'), expectedClass.toBuffer(), identities.solver.toBuffer(), Buffer.from(reservationId),
  ], reservationProgram)[0], 'reservation vault PDA');
  requireKey(addresses.get('quoteLock')!, PublicKey.findProgramAddressSync([
    Buffer.from('firm-quote-lock'), Buffer.from(reservationId),
  ], coreProgram)[0], 'quote lock PDA');

  requireKey(quoteLock.solver, identities.solver, 'quote lock solver');
  requireKey(quoteLock.reservation, reservationAddress, 'quote lock reservation');
  requireBytes(quoteLock.reservationId, reservationId, 'quote lock reservation id');
  requireBytes(quoteLock.reservationPolicyHash, policyHash, 'quote lock policy hash');
  requireBytes(quoteLock.orderHash, admission.orderHash, 'quote lock order commitment');
  requireBytes(quoteLock.quoteHash, admission.quoteHash, 'quote lock quote commitment');
  requireBytes(quoteLock.routeHash, admission.routeHash, 'quote lock route commitment');
  requireBytes(quoteLock.quoteArgsHash, quoteArgsHash, 'quote lock quote-args hash');
  requireBytes(quoteLock.seriesManifestHash, binding.series.seriesManifestHash, 'quote lock series commitment');
  requireBytes(quoteLock.executionClassManifestHash, binding.series.executionClassManifestHash, 'quote lock execution class commitment');
  requireBytes(quoteLock.fillCommitment, quoteArgs.expectedFillCommitment, 'quote lock fill commitment');
  requireCondition(quoteLock.packageSizeUnits === quoteArgs.packageSizeUnits, 'quote lock package size mismatch');
  requireCondition(quoteLock.baseAtoms === reservation.baseAtoms && quoteLock.quoteAtoms === reservation.quoteAtoms, 'quote lock amount mismatch');
  requireCondition(quoteLock.expirySlot === reservation.expirySlot, 'quote lock expiry mismatch');
}

function validateTokens(
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
  routes: Map<string, PackageAdmission['route']['accountBindings'][number]>,
  identities: { baseMint: PublicKey; quoteMint: PublicKey; solver: PublicKey; trader: PublicKey },
): void {
  requireKey(addresses.get('tokenProgram')!, LEGACY_TOKEN_PROGRAM_ID, 'legacy SPL Token program');
  requireKey(addresses.get('instructionsSysvar')!, SYSVAR_INSTRUCTIONS_PUBKEY, 'instructions sysvar');
  requireKey(addresses.get('systemProgram')!, SystemProgram.programId, 'system program');
  const exit = isExit(binding);
  const expected = {
    reservationVault: { mint: exit ? identities.quoteMint : identities.baseMint, authority: addresses.get('reservation')! },
    solverQuote: { mint: exit ? identities.baseMint : identities.quoteMint, authority: identities.solver },
    traderBase: { mint: identities.baseMint, authority: identities.trader },
    traderQuote: { mint: identities.quoteMint, authority: identities.trader },
    executorBase: { mint: identities.baseMint, authority: addresses.get('executorAuthority')! },
    executorQuote: { mint: identities.quoteMint, authority: addresses.get('executorAuthority')! },
  } as const;
  for (const name of Object.keys(expected) as FirmTokenAccountName[]) {
    const evidence = binding.tokenAccounts[name];
    requireKey(evidence.mint, expected[name].mint, `${name} mint`);
    requireKey(evidence.authority, expected[name].authority, `${name} authority`);
    checkedUnsigned(evidence.amountAtoms, U64_MAX, `${name} amount`);
    const route = routes.get(accountBinding(binding, name).routeBindingId)!;
    requireCondition(route.ownerIdentity === LEGACY_TOKEN_PROGRAM_ID.toBase58(), `${name} token program binding mismatch`);
    requireCondition(route.authorityIdentity === expected[name].authority.toBase58(), `${name} authority binding mismatch`);
    if (name !== 'reservationVault') {
      requireKey(addresses.get(name)!, associatedTokenAddress(expected[name].authority, expected[name].mint), `${name} associated token account`);
    }
  }
  requireCondition(
    binding.tokenAccounts.reservationVault.amountAtoms === (exit ? binding.reservation.quoteAtoms : binding.reservation.baseAtoms),
    'reservation vault funding mismatch',
  );
  requireCondition(binding.tokenAccounts.executorBase.amountAtoms === 0n && binding.tokenAccounts.executorQuote.amountAtoms === 0n, 'executor token accounts must start empty');
}

function executionDigest(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
): Uint8Array {
  const execution = binding.executionArgs;
  const profile = bindingProfile(binding);
  const orderedNames: readonly FirmAccountKey[] = [
    'trader', 'config', 'solverRegistry', 'riskDomainIndex', 'riskDomainRecord', 'solver',
    'receipt', 'nonceMarker', 'openPackage', 'executorAuthority',
    'spotAdapterIndex', 'perpAdapterIndex', 'spotMarketIndex', 'perpMarketIndex',
    'spotVenueIndex', 'perpVenueIndex', 'baseAssetIndex', 'quoteAssetIndex',
    'spotAdapterRecord', 'perpAdapterRecord', 'spotMarketRecord', 'perpMarketRecord',
    'spotVenueRecord', 'perpVenueRecord', 'baseAssetRecord', 'quoteAssetRecord',
    'reservationProgram', 'reservationProgramData', 'coreProgram', 'coreProgramData',
    'perpAdapterProgram', 'perpAdapterProgramData', 'perpVenueProgram', 'perpVenueProgramData',
    'reservationClass', 'reservationCapacity', 'reservation', 'livePair', 'reservationVault',
    'solverQuote', 'traderBase', 'traderQuote', 'executorBase', 'executorQuote',
    'quoteLock', 'seriesIndex', 'seriesRecord', 'riseStrategy',
    ...profile.accounts.map((account) => account.bindingName),
    'tokenProgram', 'instructionsSysvar', 'systemProgram',
  ];
  const keys = [
    publicKey(binding.deployments.core.programId, 'core program'),
    ...orderedNames.map((name) => addresses.get(name)!),
    ...binding.riseDynamicAccounts.map((account) => publicKey(account.address, 'Rise dynamic account')),
  ];
  const base = domainHash(
    HASH_DOMAINS.execution,
    domainBytes(binding.domain),
    admission.orderHash,
    admission.quoteHash,
    admission.routeHash,
    Uint8Array.of(isExit(binding) ? 2 : 1),
    Uint8Array.of(0),
    bigEndian(execution.spotQuantityAtoms, 8),
    bigEndian(execution.perpQuantityAtoms, 8),
    bigEndian(execution.spotLimitQuoteAtomsPerBaseLot, 8),
    bigEndian(execution.perpLimitQuoteAtomsPerBaseLot, 8),
    bigEndian(execution.packageNotionalAtoms, 8),
    bigEndian(execution.spotSqrtPriceLimit, 16),
    bigEndian(execution.minimumRiseCollateralQuoteLots, 8, true),
    bigEndian(execution.clientOrderId, 16),
    bigEndian(execution.expirySlot, 8),
    bigEndian(execution.nonce, 8),
    ...riskDigestParts(execution),
    hash32(binding.resourceAdmissionCommitment, 'resource admission commitment'),
    lengthPrefix(keys.length),
    ...keys.map((key) => key.toBytes()),
  );
  const intent = quoteIntentCommitment(admission, binding, addresses);
  const quote = binding.quoteArgs;
  const quoted = domainHash(HASH_DOMAINS.quotedExecution, base, intent, quote.expectedFillCommitment);
  return domainHash(HASH_DOMAINS.firmExecution, quoted, bigEndian(binding.firmQuoteAtoms, 8));
}

function quoteIntentCommitment(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
): Uint8Array {
  const quote = binding.quoteArgs;
  const quoteKeys = [addresses.get('quoteLock')!, addresses.get('seriesIndex')!, addresses.get('seriesRecord')!];
  return domainHash(
    HASH_DOMAINS.quoteIntent,
    domainBytes(binding.domain),
    addresses.get('solver')!.toBytes(),
    addresses.get('quoteLock')!.toBytes(),
    admission.orderHash,
    admission.quoteHash,
    admission.routeHash,
    quote.packageBookCodeIdentity,
    quote.seriesManifestHash,
    quote.executionClassManifestHash,
    bigEndian(quote.expectedReferenceSequence, 8),
    bigEndian(quote.expectedShardSequence, 8),
    Uint8Array.of(quote.slotIndex),
    bigEndian(quote.levelId, 8),
    bigEndian(quote.expectedLevelSequence, 8),
    Uint8Array.of(quote.expectedSide),
    bigEndian(quote.packageSizeUnits, 8),
    bigEndian(quote.expectedPackagePrice, 16, true),
    bigEndian(quote.expectedMaxFeeAtoms, 8),
    bigEndian(quote.expectedExpirySlot, 8),
    quote.expectedSettlementClassIdentityHash,
    Uint8Array.of(quote.expectedQuoteMode),
    quote.expectedReservationPolicyHash,
    quote.reservationId,
    quote.expectedFillCommitment,
    lengthPrefix(quoteKeys.length),
    ...quoteKeys.map((key) => key.toBytes()),
  );
}

function firmRouteAccountsCommitment(
  binding: AnyFirmCashCarryBinding,
  addresses: ReadonlyMap<FirmAccountKey, PublicKey>,
): Uint8Array {
  const names: readonly FirmAccountKey[] = [
    'traderBase', 'traderQuote', 'executorBase', 'executorQuote', 'solverQuote',
    'reservationClass', 'reservationCapacity', 'reservation', 'livePair', 'reservationVault',
    'quoteLock', 'seriesIndex', 'seriesRecord', 'riskDomainIndex', 'riskDomainRecord', 'riseStrategy',
    ...bindingProfile(binding).accounts.map((account) => account.bindingName),
  ];
  const keys = [
    ...names.map((name) => addresses.get(name)!),
    ...binding.riseDynamicAccounts.map((account) => publicKey(account.address, 'Rise dynamic account')),
  ];
  return domainHash(
    HASH_DOMAINS.routeAccounts,
    lengthPrefix(keys.length),
    ...keys.map((key) => key.toBytes()),
  );
}

function firmPackageAccountsCommitment(addresses: ReadonlyMap<FirmAccountKey, PublicKey>): Uint8Array {
  const keys = [addresses.get('traderBase')!, addresses.get('traderQuote')!, addresses.get('riseStrategy')!];
  return domainHash(
    HASH_DOMAINS.packageAccounts,
    lengthPrefix(keys.length),
    ...keys.map((key) => key.toBytes()),
  );
}

function compileFirmInstructions(admission: PackageAdmission, binding: AnyFirmCashCarryBinding) {
  validatePackage(admission, binding);
  const profile = bindingProfile(binding);
  requireOnlyProfileVenueAccounts(binding.accounts, profile);
  requireBytes(solanaIdlContentHash(binding.coreIdl), hash32(binding.expectedCoreIdlHash, 'expected core IDL hash'), 'core IDL content hash');
  requireKey(binding.coreIdl.address, binding.deployments.core.programId, 'core IDL program identity');
  const lockIdl = idlInstruction(
    binding.coreIdl,
    'lock_firm_quote',
    ['order_hash', 'quote_hash', 'route_hash', 'quote_args'],
    LOCK_IDL_SPECS,
  );
  const entryIdl = idlInstruction(
    binding.coreIdl,
    'execute_firm_cash_and_carry',
    ['order_hash', 'quote_hash', 'route_hash', 'args', 'quote_args', 'firm_quote_atoms'],
    entryIdlSpecs(profile),
  );
  const coder = new BorshCoder(binding.coreIdl);
  const routes = routeBindings(admission);
  const addresses = new Map<FirmAccountKey, PublicKey>();
  for (const name of [...FIRM_COMMON_ACCOUNT_NAMES, ...profile.accounts.map((account) => account.bindingName)]) {
    addresses.set(name, validateRouteAccount(accountBinding(binding, name), routes, name));
  }
  for (const [index, account] of binding.riseDynamicAccounts.entries()) {
    validateRouteAccount(account, routes, `Rise dynamic account ${index}`);
  }
  requireCondition(binding.accounts.trader.routeBindingId === binding.traderRouteBindingId, 'trader authority binding mismatch');
  requireCondition(binding.accounts.solver.routeBindingId === binding.solverRouteBindingId, 'solver authority binding mismatch');
  requireCondition(admission.route.actions.length > 0 && admission.route.actions.every((action) => action.authorityBindingId === binding.traderRouteBindingId), 'firm entry route actions must use trader authority');
  requireCondition(binding.riseDynamicAccounts.length <= profile.maxDynamicAccounts, `firm entry supports at most ${profile.maxDynamicAccounts} perp venue dynamic accounts`);

  const coreProgram = publicKey(binding.deployments.core.programId, 'core program');
  const identities = validateProgramsAndResources(admission, binding, addresses, routes);
  validateSolanaCashCarryRiskArgs(binding.executionArgs);
  const riskDomainId = hash32(binding.executionArgs.riskDomainId, 'risk domain id');
  requireKey(addresses.get('riskDomainIndex')!, PublicKey.findProgramAddressSync([
    Buffer.from('risk-domain-index'), Buffer.from(riskDomainId),
  ], coreProgram)[0], 'risk domain index PDA');
  requireKey(addresses.get('riskDomainRecord')!, PublicKey.findProgramAddressSync([
    Buffer.from('risk-domain-record'),
    Buffer.from(riskDomainId),
    Buffer.from(bigEndian(BigInt(binding.executionArgs.riskPolicyVersion), 4)),
  ], coreProgram)[0], 'risk domain record PDA');
  for (const name of ['riskDomainIndex', 'riskDomainRecord'] as const) {
    const route = routes.get(accountBinding(binding, name).routeBindingId)!;
    requireCondition(route.ownerIdentity === coreProgram.toBase58(), `${name} owner mismatch`);
  }
  validateSeriesAndAmounts(admission, binding);
  const quoteArgs = borshQuoteArgs(binding.quoteArgs);
  const quoteArgsHash = domainHash(
    HASH_DOMAINS.quoteArgs,
    coder.types.encode('CashCarryQuoteArgs', quoteArgs),
  );
  validateReservation(admission, binding, addresses, identities, quoteArgsHash);
  validateTokens(binding, addresses, routes, identities);

  const lockKeys = [
    ...accountKeys(LOCK_IDL_SPECS, lockIdl.accounts, addresses),
    ...explicitKeys(LOCK_REMAINING_SPECS, addresses),
  ];
  const lockInstruction = new TransactionInstruction({
    programId: coreProgram,
    keys: lockKeys,
    data: coder.instruction.encode('lock_firm_quote', {
      order_hash: Array.from(admission.orderHash),
      quote_hash: Array.from(admission.quoteHash),
      route_hash: Array.from(admission.routeHash),
      quote_args: quoteArgs,
    }),
  });

  const fixedEntryKeys = accountKeys(entryIdlSpecs(profile), entryIdl.accounts, addresses);
  const fixedAddressCount = new Set([coreProgram.toBase58(), ...fixedEntryKeys.map((key) => key.pubkey.toBase58())]).size;
  const expectedFixedCount = FIXED_FIRM_ENTRY_BASE_ADDRESS_COUNT + profile.accounts.length;
  requireCondition(fixedAddressCount === expectedFixedCount, `firm entry must resolve exactly ${expectedFixedCount} fixed addresses`);
  const firmEntryInstruction = new TransactionInstruction({
    programId: coreProgram,
    keys: [
      ...fixedEntryKeys,
      ...binding.riseDynamicAccounts.map((account) => ({
        pubkey: publicKey(account.address, 'Rise dynamic account'),
        isSigner: false,
        isWritable: account.isWritable,
      })),
    ],
    data: coder.instruction.encode('execute_firm_cash_and_carry', {
      order_hash: Array.from(admission.orderHash),
      quote_hash: Array.from(admission.quoteHash),
      route_hash: Array.from(admission.routeHash),
      args: borshExecutionArgs(binding.executionArgs, isExit(binding)),
      quote_args: quoteArgs,
      firm_quote_atoms: bn(binding.firmQuoteAtoms),
    }),
  });

  requireCondition(Number.isInteger(binding.computeUnitLimit) && binding.computeUnitLimit > 0 && binding.computeUnitLimit <= 1_260_000, 'compute unit limit exceeds the firm route cap');
  requireCondition(binding.solverSignature instanceof Uint8Array && binding.solverSignature.length === 64, 'solver signature must be 64 bytes');
  const digest = executionDigest(admission, binding, addresses);
  const entryInstructions = Object.freeze([
    ComputeBudgetProgram.setComputeUnitLimit({ units: binding.computeUnitLimit }),
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: identities.solver.toBytes(),
      message: digest,
      signature: binding.solverSignature,
    }),
    firmEntryInstruction,
  ]);
  requireCondition(lockInstruction.keys.filter((key) => key.isSigner).length === 1 && lockInstruction.keys[0]?.pubkey.equals(identities.solver) === true, 'firm lock must require only solver authority');
  requireCondition(firmEntryInstruction.keys.filter((key) => key.isSigner).length === 1 && firmEntryInstruction.keys[0]?.pubkey.equals(identities.trader) === true, 'firm entry must require only trader authority');

  const lockInstructions = Object.freeze([lockInstruction]);
  const lockAddressCount = resolvedAddressCount(identities.solver, lockInstructions);
  const entryAddressCount = resolvedAddressCount(identities.trader, entryInstructions);
  requireCondition(lockAddressCount <= MAX_RESOLVED_ADDRESSES, 'firm lock exceeds 64 resolved addresses');
  requireCondition(entryAddressCount <= MAX_RESOLVED_ADDRESSES, 'firm entry exceeds 64 resolved addresses');
  return {
    profile, addresses, identities, coreProgram, digest,
    lockInstructions, lockAddressCount, entryInstructions, entryAddressCount,
  };
}

export function compileFirmCashCarryPlan(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
): FirmCashCarryPlan {
  requireCondition(!isExit(binding), 'firm entry plan requires an entry binding');
  const {
    profile, addresses, identities, coreProgram, digest,
    lockInstructions, lockAddressCount, entryInstructions, entryAddressCount,
  } = compileFirmInstructions(admission, binding);
  const publicExit = binding.publicExit === undefined
    ? Object.freeze({ status: 'EVIDENCE_REQUIRED' as const, code: 'PUBLIC_EXIT_BINDING_REQUIRED' as const })
    : (() => {
        requireCondition(solanaPerpVenueProfile(binding.publicExit.perpVenueKind) === profile, 'public exit perp venue kind mismatch');
        for (const [name, exitDeployment, entryDeployment] of [
          ['core', binding.publicExit.deployments.core, binding.deployments.core],
          ['perp adapter', binding.publicExit.deployments.perpAdapter, binding.deployments.perpAdapter],
          ['perp venue', binding.publicExit.deployments.perpVenue, binding.deployments.perpVenue],
        ] as const) {
          requireKey(exitDeployment.programId, entryDeployment.programId, `${name} exit deployment`);
          requireKey(exitDeployment.programDataAddress, entryDeployment.programDataAddress, `${name} exit program data`);
          requireBytes(exitDeployment.codeIdentity, entryDeployment.codeIdentity, `${name} exit code identity`);
        }
        return compilePublicCashCarryExitPlan(binding.publicExit, {
          environment: binding.environment,
          coreIdl: binding.coreIdl,
          domain: binding.domain,
          coreProgram,
          trader: identities.trader,
          solver: identities.solver,
          config: addresses.get('config')!,
          solverRegistry: addresses.get('solverRegistry')!,
          entryReceipt: addresses.get('receipt')!,
          openPackage: addresses.get('openPackage')!,
          executorAuthority: addresses.get('executorAuthority')!,
          riseStrategy: addresses.get('riseStrategy')!,
          traderBase: addresses.get('traderBase')!,
          traderQuote: addresses.get('traderQuote')!,
          seriesIndex: addresses.get('seriesIndex')!,
          seriesRecord: addresses.get('seriesRecord')!,
          entryOrderHash: admission.orderHash,
          entryQuoteHash: admission.quoteHash,
          entryRouteHash: admission.routeHash,
          templateVersion: admission.order.templateVersion,
          templateManifestHash: admission.order.packageTemplateManifestHash,
          entryNonce: binding.executionArgs.nonce,
          spotQuantityAtoms: binding.executionArgs.spotQuantityAtoms,
          perpQuantityAtoms: binding.executionArgs.perpQuantityAtoms,
          quoteIntentCommitment: quoteIntentCommitment(admission, binding, addresses),
          packageFillCommitment: binding.quoteArgs.expectedFillCommitment,
          resourceAdmissionCommitment: binding.resourceAdmissionCommitment,
          routeAccountsCommitment: firmRouteAccountsCommitment(binding, addresses),
          packageAccountsCommitment: firmPackageAccountsCommitment(addresses),
          seriesManifestHash: binding.series.seriesManifestHash,
          executionClassManifestHash: binding.series.executionClassManifestHash,
          settlementClassIdentityHash: binding.series.settlementClassIdentityHash,
          spotBaseAtomsPerPackageUnit: binding.series.spotBaseAtomsPerPackageUnit,
          perpQuantityAtomsPerPackageUnit: binding.series.perpQuantityAtomsPerPackageUnit,
          entryResourceRecords: {
            perpAdapter: addresses.get('perpAdapterRecord')!,
            perpMarket: addresses.get('perpMarketRecord')!,
            perpVenue: addresses.get('perpVenueRecord')!,
            baseAsset: addresses.get('baseAssetRecord')!,
            quoteAsset: addresses.get('quoteAssetRecord')!,
          },
        });
      })();

  return Object.freeze({
    kind: 'MULTI_TRANSACTION_FIRM_CASH_CARRY_PLAN',
    atomicity: 'ONLY_TRADER_ENTRY_TRANSACTION_IS_ATOMIC',
    domain: binding.domain,
    orderHash: Uint8Array.from(admission.orderHash),
    quoteHash: Uint8Array.from(admission.quoteHash),
    routeHash: Uint8Array.from(admission.routeHash),
    executionDigest: Uint8Array.from(digest),
    solverLock: Object.freeze({
      stage: 'SOLVER_FIRM_QUOTE_LOCK',
      prerequisite: 'FUNDED_FINALIZED_LIVE_RESERVATION',
      authorityRole: 'SOLVER',
      payer: identities.solver,
      instructions: lockInstructions,
      resolvedAddressCount: lockAddressCount,
      messageSize: messageSize(identities.solver, lockInstructions, binding.messageContext),
    }),
    traderEntry: Object.freeze({
      stage: 'TRADER_ATOMIC_FIRM_ENTRY',
      authorityRole: 'TRADER',
      payer: identities.trader,
      instructions: entryInstructions,
      resolvedAddressCount: entryAddressCount,
      messageSize: messageSize(identities.trader, entryInstructions, binding.messageContext),
    }),
    publicExit,
  });
}

/**
 * Compiles the firm exit: the solver's buy-back lock and the trader's one atomic exit transaction
 * that closes the perp short, sells the exact spot base to the solver's escrowed bid, and closes the
 * open package. Only the Devnet test perp core build accepts it.
 */
export function compileFirmCashCarryExitPlan(
  admission: PackageAdmission,
  binding: AnyFirmCashCarryBinding,
): FirmCashCarryExitPlan {
  requireCondition(isExit(binding), 'firm exit plan requires an exit binding');
  requireCondition(binding.perpVenueKind === 'NARYX_TEST_PERP', 'firm exit is available only on the test perp venue');
  requireCondition(binding.publicExit === undefined, 'firm exit binding must not carry a public exit');
  const { identities, digest, lockInstructions, lockAddressCount, entryInstructions, entryAddressCount } =
    compileFirmInstructions(admission, binding);
  return Object.freeze({
    kind: 'MULTI_TRANSACTION_FIRM_CASH_CARRY_EXIT_PLAN',
    atomicity: 'ONLY_TRADER_EXIT_TRANSACTION_IS_ATOMIC',
    domain: binding.domain,
    orderHash: Uint8Array.from(admission.orderHash),
    quoteHash: Uint8Array.from(admission.quoteHash),
    routeHash: Uint8Array.from(admission.routeHash),
    executionDigest: Uint8Array.from(digest),
    solverLock: Object.freeze({
      stage: 'SOLVER_FIRM_QUOTE_LOCK',
      prerequisite: 'FUNDED_FINALIZED_LIVE_RESERVATION',
      authorityRole: 'SOLVER',
      payer: identities.solver,
      instructions: lockInstructions,
      resolvedAddressCount: lockAddressCount,
      messageSize: messageSize(identities.solver, lockInstructions, binding.messageContext),
    }),
    traderExit: Object.freeze({
      stage: 'TRADER_ATOMIC_FIRM_EXIT',
      authorityRole: 'TRADER',
      payer: identities.trader,
      instructions: entryInstructions,
      resolvedAddressCount: entryAddressCount,
      messageSize: messageSize(identities.trader, entryInstructions, binding.messageContext),
    }),
  });
}

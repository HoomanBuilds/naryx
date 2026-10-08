import anchor, { type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

const { BorshCoder, BN } = anchor;

export type DecodedCashCarryDomain = Readonly<{
  domainId: string;
  domainManifestVersion: number;
  domainManifestHash: Uint8Array;
}>;

export type DecodedCashCarryExecutionReceipt = Readonly<{
  domain: DecodedCashCarryDomain;
  orderHash: Uint8Array;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
  trader: string;
  solver: string;
  nonce: bigint;
  executionDigest: Uint8Array;
  quoteIntentCommitment: Uint8Array;
  packageFillCommitment: Uint8Array;
  action: number;
  recovery: boolean;
  spotQuantityAtoms: bigint;
  perpQuantityAtoms: bigint;
  resourceAdmissionCommitment: Uint8Array;
  routeAccountsCommitment: Uint8Array;
  entryReceipt: string;
  executionSlot: bigint;
  riskDomainId: Uint8Array;
  riskPolicyVersion: number;
  riskPolicyManifestHash: Uint8Array;
  riskSeries: DecodedCashCarryRiskSeries;
}>;

export type DecodedCashCarryRiskSeries = Readonly<{
  seriesId: Uint8Array;
  manifestVersion: number;
  manifestHash: Uint8Array;
}>;

export type DecodedOpenCashCarryPackage = Readonly<{
  version: number;
  domain: DecodedCashCarryDomain;
  trader: string;
  entryReceipt: string;
  entryRouteHash: Uint8Array;
  quoteIntentCommitment: Uint8Array;
  packageFillCommitment: Uint8Array;
  entryResourceAdmissionCommitment: Uint8Array;
  entryRouteAccountsCommitment: Uint8Array;
  economicPackageCommitment: Uint8Array;
  packageAccountsCommitment: Uint8Array;
  spotQuantityAtoms: bigint;
  perpQuantityAtoms: bigint;
  riskDomainId: Uint8Array;
  riskPolicyVersion: number;
  riskPolicyManifestHash: Uint8Array;
  riskSeries: DecodedCashCarryRiskSeries;
}>;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function bytes32(value: unknown, name: string): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : Array.isArray(value) ? Uint8Array.from(value) : undefined;
  if (bytes === undefined || bytes.length !== 32) throw new Error(`${name} is invalid`);
  return Uint8Array.from(bytes);
}

function publicKey(value: unknown, name: string): string {
  if (!(value instanceof PublicKey)) throw new Error(`${name} is invalid`);
  return value.toBase58();
}

function unsigned(value: unknown, name: string): bigint {
  if (!(value instanceof BN)) throw new Error(`${name} is invalid`);
  const result = BigInt((value as InstanceType<typeof BN>).toString());
  if (result < 0n) throw new Error(`${name} is invalid`);
  return result;
}

function version(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function domain(value: unknown): DecodedCashCarryDomain {
  const decoded = record(value, 'cash-carry domain');
  if (typeof decoded.domain_id !== 'string' || decoded.domain_id.length === 0) throw new Error('cash-carry domain id is invalid');
  if (typeof decoded.domain_manifest_version !== 'number' || !Number.isSafeInteger(decoded.domain_manifest_version) || decoded.domain_manifest_version <= 0) {
    throw new Error('cash-carry domain version is invalid');
  }
  return Object.freeze({
    domainId: decoded.domain_id,
    domainManifestVersion: decoded.domain_manifest_version,
    domainManifestHash: bytes32(decoded.domain_manifest_hash, 'cash-carry domain hash'),
  });
}

function riskSeries(value: unknown, name: string): DecodedCashCarryRiskSeries {
  const decoded = record(value, name);
  if (typeof decoded.manifest_version !== 'number' || !Number.isSafeInteger(decoded.manifest_version) || decoded.manifest_version <= 0) {
    throw new Error(`${name} version is invalid`);
  }
  return Object.freeze({
    seriesId: bytes32(decoded.series_id, `${name} id`),
    manifestVersion: decoded.manifest_version,
    manifestHash: bytes32(decoded.manifest_hash, `${name} manifest hash`),
  });
}

export function decodeCashCarryExecutionReceipt(idl: Idl, data: Uint8Array): DecodedCashCarryExecutionReceipt {
  const decoded = record(new BorshCoder(idl).accounts.decode('CashCarryExecutionReceipt', Buffer.from(data)), 'cash-carry receipt');
  if (typeof decoded.action !== 'number' || !Number.isInteger(decoded.action)) throw new Error('cash-carry receipt action is invalid');
  if (typeof decoded.recovery !== 'boolean') throw new Error('cash-carry receipt recovery flag is invalid');
  return Object.freeze({
    domain: domain(decoded.domain),
    orderHash: bytes32(decoded.order_hash, 'cash-carry receipt order hash'),
    quoteHash: bytes32(decoded.quote_hash, 'cash-carry receipt quote hash'),
    routeHash: bytes32(decoded.route_hash, 'cash-carry receipt route hash'),
    trader: publicKey(decoded.trader, 'cash-carry receipt trader'),
    solver: publicKey(decoded.solver, 'cash-carry receipt solver'),
    nonce: unsigned(decoded.nonce, 'cash-carry receipt nonce'),
    executionDigest: bytes32(decoded.execution_digest, 'cash-carry receipt execution digest'),
    quoteIntentCommitment: bytes32(decoded.quote_intent_commitment, 'cash-carry receipt quote intent'),
    packageFillCommitment: bytes32(decoded.package_fill_commitment, 'cash-carry receipt package fill'),
    action: decoded.action,
    recovery: decoded.recovery,
    spotQuantityAtoms: unsigned(decoded.spot_quantity_atoms, 'cash-carry receipt spot quantity'),
    perpQuantityAtoms: unsigned(decoded.perp_quantity_atoms, 'cash-carry receipt perp quantity'),
    resourceAdmissionCommitment: bytes32(decoded.resource_admission_commitment, 'cash-carry receipt resource admission'),
    routeAccountsCommitment: bytes32(decoded.route_accounts_commitment, 'cash-carry receipt route accounts'),
    entryReceipt: publicKey(decoded.entry_receipt, 'cash-carry receipt entry receipt'),
    executionSlot: unsigned(decoded.execution_slot, 'cash-carry receipt execution slot'),
    riskDomainId: bytes32(decoded.risk_domain_id, 'cash-carry receipt risk domain'),
    riskPolicyVersion: version(decoded.risk_policy_version, 'cash-carry receipt risk policy version'),
    riskPolicyManifestHash: bytes32(decoded.risk_policy_manifest_hash, 'cash-carry receipt risk policy manifest'),
    riskSeries: riskSeries(decoded.risk_series, 'cash-carry receipt risk series'),
  });
}

export function decodeOpenCashCarryPackage(idl: Idl, data: Uint8Array): DecodedOpenCashCarryPackage {
  const decoded = record(new BorshCoder(idl).accounts.decode('OpenCashCarryPackage', Buffer.from(data)), 'open cash-carry package');
  if (typeof decoded.version !== 'number' || !Number.isInteger(decoded.version)) throw new Error('open cash-carry package version is invalid');
  return Object.freeze({
    version: decoded.version,
    domain: domain(decoded.domain),
    trader: publicKey(decoded.trader, 'open cash-carry package trader'),
    entryReceipt: publicKey(decoded.entry_receipt, 'open cash-carry package entry receipt'),
    entryRouteHash: bytes32(decoded.entry_route_hash, 'open cash-carry package route hash'),
    quoteIntentCommitment: bytes32(decoded.quote_intent_commitment, 'open cash-carry package quote intent'),
    packageFillCommitment: bytes32(decoded.package_fill_commitment, 'open cash-carry package package fill'),
    entryResourceAdmissionCommitment: bytes32(decoded.entry_resource_admission_commitment, 'open cash-carry package resource admission'),
    entryRouteAccountsCommitment: bytes32(decoded.entry_route_accounts_commitment, 'open cash-carry package route accounts'),
    economicPackageCommitment: bytes32(decoded.economic_package_commitment, 'open cash-carry package economic commitment'),
    packageAccountsCommitment: bytes32(decoded.package_accounts_commitment, 'open cash-carry package accounts commitment'),
    spotQuantityAtoms: unsigned(decoded.spot_quantity_atoms, 'open cash-carry package spot quantity'),
    perpQuantityAtoms: unsigned(decoded.perp_quantity_atoms, 'open cash-carry package perp quantity'),
    riskDomainId: bytes32(decoded.risk_domain_id, 'open cash-carry package risk domain'),
    riskPolicyVersion: version(decoded.risk_policy_version, 'open cash-carry package risk policy version'),
    riskPolicyManifestHash: bytes32(decoded.risk_policy_manifest_hash, 'open cash-carry package risk policy manifest'),
    riskSeries: riskSeries(decoded.risk_series, 'open cash-carry package risk series'),
  });
}

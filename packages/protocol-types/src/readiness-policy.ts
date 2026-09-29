import { checkedUnsigned } from './arithmetic.js';
import { bytesEqual, toHex } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  EXPIRY_UNIT,
  QUOTE_MODE,
  SETTLEMENT_CLASS,
  enumDiscriminant,
  type ExpiryUnit,
  type QuoteMode,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  encodeVersionedManifestRef,
  expiry,
  manifestHash,
  protocolId,
  versionedManifestRef,
  type DomainRef,
  type Expiry,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';

const SCHEMA_VERSION = 1;
const U32_BITS = 32;
const ATOM_BITS = 128;

export const AUTHORITY_CLASS = Object.freeze({
  DEPLOYER: 1,
  PROGRAM_UPGRADE: 2,
  REGISTRY_ADMIN: 3,
  RISK_ADMIN: 4,
  EXECUTION_SIGNER: 5,
  INCIDENT_OWNER: 6,
} as const);
export type AuthorityClass = keyof typeof AUTHORITY_CLASS;

export const FUNDED_OPERATION_ACTION = Object.freeze({
  DEPLOY: 1,
  INITIALIZE: 2,
  CONFIGURE: 3,
  FUND: 4,
  EXECUTE: 5,
  RECOVER: 6,
} as const);
export type FundedOperationAction = keyof typeof FUNDED_OPERATION_ACTION;

export const MAINNET_AUTHORIZATION_STATUS = Object.freeze({
  NOT_AUTHORIZED: 1,
} as const);
export type MainnetAuthorizationStatus = keyof typeof MAINNET_AUTHORIZATION_STATUS;

export const FINDING_SEVERITY = Object.freeze({
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  INFORMATIONAL: 5,
} as const);
export type FindingSeverity = keyof typeof FINDING_SEVERITY;

export const FINDING_STATUS = Object.freeze({
  OPEN: 1,
  RESOLVED: 2,
} as const);
export type FindingStatus = keyof typeof FINDING_STATUS;

export const READINESS_EVIDENCE_KIND = Object.freeze({
  BUILD: 1,
  FOCUSED_TESTS: 2,
  DEPLOYMENT_DRY_RUN: 3,
  AUTHORITY_REVIEW: 4,
  INCIDENT_RUNBOOK: 5,
} as const);
export type ReadinessEvidenceKind = keyof typeof READINESS_EVIDENCE_KIND;

export const READINESS_STATUS = Object.freeze({
  NOT_READY: 1,
  READY: 2,
} as const);
export type ReadinessStatus = keyof typeof READINESS_STATUS;

function fixedVersion(value: number, context: string): 1 {
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked !== BigInt(SCHEMA_VERSION)) {
    throw new MalformedInputError(context, `version must equal ${SCHEMA_VERSION}`);
  }
  return 1;
}

function nonzeroU32(value: number, context: string): number {
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'version is zero');
  return Number(checked);
}

function atoms(value: bigint, context: string, allowZero = true): bigint {
  const checked = checkedUnsigned(value, ATOM_BITS, context);
  if (!allowZero && checked === 0n) {
    throw new MalformedInputError(context, 'amount is zero');
  }
  return checked;
}

function checkedDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference');
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

function checkedManifestRef(value: VersionedManifestRef, context: string): VersionedManifestRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a manifest reference');
  }
  return versionedManifestRef(
    value.subjectId,
    value.manifestVersion,
    value.manifestHash,
    context,
  );
}

function checkedHash(value: Uint8Array | string, context: string): ManifestHash {
  return manifestHash(value, context);
}

function canonicalByKey<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: string,
  requireNonempty = true,
): readonly T[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  if (requireNonempty && values.length === 0) {
    throw new MalformedInputError(context, 'set is empty');
  }
  const sorted = [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1] as T) === key(sorted[index] as T)) {
      throw new DuplicateElementError(context, `duplicate element ${key(sorted[index] as T)}`);
    }
  }
  return Object.freeze(sorted);
}

export interface AuthorityRoleInput {
  readonly roleId: string;
  readonly authorityClass: AuthorityClass;
  readonly publicIdentityCommitment: Uint8Array | string;
  readonly custodyPolicyHash: Uint8Array | string;
}

export interface AuthorityRole {
  readonly roleId: ProtocolId;
  readonly authorityClass: AuthorityClass;
  readonly publicIdentityCommitment: ManifestHash;
  readonly custodyPolicyHash: ManifestHash;
}

function authorityRole(input: AuthorityRoleInput, context: string): AuthorityRole {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an authority role');
  }
  enumDiscriminant(AUTHORITY_CLASS, input.authorityClass, `${context}.authorityClass`);
  const identity = checkedHash(input.publicIdentityCommitment, `${context}.publicIdentityCommitment`);
  const custody = checkedHash(input.custodyPolicyHash, `${context}.custodyPolicyHash`);
  return Object.freeze({
    roleId: protocolId(input.roleId, `${context}.roleId`),
    authorityClass: input.authorityClass,
    get publicIdentityCommitment(): ManifestHash {
      return Uint8Array.from(identity) as ManifestHash;
    },
    get custodyPolicyHash(): ManifestHash {
      return Uint8Array.from(custody) as ManifestHash;
    },
  });
}

function encodeAuthorityRole(writer: CanonicalWriter, value: AuthorityRole): void {
  const checked = authorityRole(value, 'authorityRole');
  encodeProtocolId(writer, checked.roleId, 'authorityRole.roleId');
  writer.writeEnum(AUTHORITY_CLASS, checked.authorityClass, 'authorityRole.authorityClass');
  encodeManifestHash(writer, checked.publicIdentityCommitment, 'authorityRole.publicIdentityCommitment');
  encodeManifestHash(writer, checked.custodyPolicyHash, 'authorityRole.custodyPolicyHash');
}

export interface AuthorityInventoryInput {
  readonly schemaVersion: number;
  readonly inventoryVersion: number;
  readonly environment: string;
  readonly roles: readonly AuthorityRoleInput[];
}

export interface AuthorityInventory {
  readonly schemaVersion: 1;
  readonly inventoryVersion: number;
  readonly environment: ProtocolId;
  readonly roles: readonly AuthorityRole[];
}

export function authorityInventory(input: AuthorityInventoryInput, context = 'authorityInventory'): AuthorityInventory {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an authority inventory');
  }
  const roles = canonicalByKey(
    input.roles.map((role, index) => authorityRole(role, `${context}.roles[${index}]`)),
    (role) => role.roleId,
    `${context}.roles`,
  );
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    inventoryVersion: nonzeroU32(input.inventoryVersion, `${context}.inventoryVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    roles,
  });
}

export function encodeAuthorityInventory(writer: CanonicalWriter, value: AuthorityInventory): void {
  const checked = authorityInventory(value, 'authorityInventory');
  writer.writeU32(checked.schemaVersion, 'authorityInventory.schemaVersion');
  writer.writeU32(checked.inventoryVersion, 'authorityInventory.inventoryVersion');
  encodeProtocolId(writer, checked.environment, 'authorityInventory.environment');
  writer.writeArray(checked.roles, encodeAuthorityRole, 'authorityInventory.roles');
}

export function authorityInventoryBytes(value: AuthorityInventoryInput): Uint8Array {
  const checked = authorityInventory(value);
  return canonicalBytes((writer) => encodeAuthorityInventory(writer, checked));
}

export function authorityInventoryHash(value: AuthorityInventoryInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.AUTHORITY_INVENTORY, authorityInventoryBytes(value)), 'authorityInventoryHash');
}

export interface OperationCapInput {
  readonly domain: DomainRef;
  readonly template: VersionedManifestRef;
  readonly settlementClass: SettlementClass;
  readonly quoteMode: QuoteMode;
  readonly sizeCohort: string;
  readonly assetId: string;
  readonly maxAssetMovementAtoms: bigint;
  readonly maxFeeAtoms: bigint;
  readonly maxMarginAtoms: bigint;
  readonly maxRecoveryAtoms: bigint;
}

export interface OperationCap extends Omit<OperationCapInput, 'sizeCohort' | 'assetId'> {
  readonly domain: DomainRef;
  readonly template: VersionedManifestRef;
  readonly sizeCohort: ProtocolId;
  readonly assetId: ProtocolId;
}

function capKey(value: OperationCap): string {
  return toHex(canonicalBytes((writer) => {
    encodeDomainRef(writer, value.domain);
    encodeVersionedManifestRef(writer, value.template);
    writer.writeEnum(SETTLEMENT_CLASS, value.settlementClass);
    writer.writeEnum(QUOTE_MODE, value.quoteMode);
    encodeProtocolId(writer, value.sizeCohort);
    encodeProtocolId(writer, value.assetId);
  }));
}

function operationCap(input: OperationCapInput, context: string): OperationCap {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an operation cap');
  }
  enumDiscriminant(SETTLEMENT_CLASS, input.settlementClass, `${context}.settlementClass`);
  enumDiscriminant(QUOTE_MODE, input.quoteMode, `${context}.quoteMode`);
  return Object.freeze({
    domain: checkedDomainRef(input.domain, `${context}.domain`),
    template: checkedManifestRef(input.template, `${context}.template`),
    settlementClass: input.settlementClass,
    quoteMode: input.quoteMode,
    sizeCohort: protocolId(input.sizeCohort, `${context}.sizeCohort`),
    assetId: protocolId(input.assetId, `${context}.assetId`),
    maxAssetMovementAtoms: atoms(input.maxAssetMovementAtoms, `${context}.maxAssetMovementAtoms`, false),
    maxFeeAtoms: atoms(input.maxFeeAtoms, `${context}.maxFeeAtoms`),
    maxMarginAtoms: atoms(input.maxMarginAtoms, `${context}.maxMarginAtoms`),
    maxRecoveryAtoms: atoms(input.maxRecoveryAtoms, `${context}.maxRecoveryAtoms`),
  });
}

function encodeOperationCap(writer: CanonicalWriter, value: OperationCap): void {
  const checked = operationCap(value, 'operationCap');
  encodeDomainRef(writer, checked.domain);
  encodeVersionedManifestRef(writer, checked.template);
  writer.writeEnum(SETTLEMENT_CLASS, checked.settlementClass, 'operationCap.settlementClass');
  writer.writeEnum(QUOTE_MODE, checked.quoteMode, 'operationCap.quoteMode');
  encodeProtocolId(writer, checked.sizeCohort, 'operationCap.sizeCohort');
  encodeProtocolId(writer, checked.assetId, 'operationCap.assetId');
  writer.writeU128(checked.maxAssetMovementAtoms, 'operationCap.maxAssetMovementAtoms');
  writer.writeU128(checked.maxFeeAtoms, 'operationCap.maxFeeAtoms');
  writer.writeU128(checked.maxMarginAtoms, 'operationCap.maxMarginAtoms');
  writer.writeU128(checked.maxRecoveryAtoms, 'operationCap.maxRecoveryAtoms');
}

export interface OperationCapPolicyInput {
  readonly schemaVersion: number;
  readonly policyVersion: number;
  readonly environment: string;
  readonly caps: readonly OperationCapInput[];
}

export interface OperationCapPolicy {
  readonly schemaVersion: 1;
  readonly policyVersion: number;
  readonly environment: ProtocolId;
  readonly caps: readonly OperationCap[];
}

export function operationCapPolicy(input: OperationCapPolicyInput, context = 'operationCapPolicy'): OperationCapPolicy {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an operation cap policy');
  }
  const caps = canonicalByKey(
    input.caps.map((cap, index) => operationCap(cap, `${context}.caps[${index}]`)),
    capKey,
    `${context}.caps`,
  );
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    policyVersion: nonzeroU32(input.policyVersion, `${context}.policyVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    caps,
  });
}

export function encodeOperationCapPolicy(writer: CanonicalWriter, value: OperationCapPolicy): void {
  const checked = operationCapPolicy(value, 'operationCapPolicy');
  writer.writeU32(checked.schemaVersion, 'operationCapPolicy.schemaVersion');
  writer.writeU32(checked.policyVersion, 'operationCapPolicy.policyVersion');
  encodeProtocolId(writer, checked.environment, 'operationCapPolicy.environment');
  writer.writeArray(checked.caps, encodeOperationCap, 'operationCapPolicy.caps');
}

export function operationCapPolicyBytes(value: OperationCapPolicyInput): Uint8Array {
  const checked = operationCapPolicy(value);
  return canonicalBytes((writer) => encodeOperationCapPolicy(writer, checked));
}

export function operationCapPolicyHash(value: OperationCapPolicyInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.OPERATION_CAP_POLICY, operationCapPolicyBytes(value)), 'operationCapPolicyHash');
}

export interface FundedOperationManifestInput extends OperationCapInput {
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly environment: string;
  readonly runtimeCodeHash: Uint8Array | string;
  readonly configurationManifestHash: Uint8Array | string;
  readonly authorityInventoryVersion: number;
  readonly authorityInventoryHash: Uint8Array | string;
  readonly signerRoleIds: readonly string[];
  readonly allowedActions: readonly FundedOperationAction[];
  readonly validFromUnit: ExpiryUnit;
  readonly validFromValue: bigint;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly incidentOwnerRoleId: string;
  readonly mainnetAuthorizationStatus: MainnetAuthorizationStatus;
}

export interface FundedOperationManifest extends OperationCap {
  readonly schemaVersion: 1;
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly runtimeCodeHash: ManifestHash;
  readonly configurationManifestHash: ManifestHash;
  readonly authorityInventoryVersion: number;
  readonly authorityInventoryHash: ManifestHash;
  readonly signerRoleIds: readonly ProtocolId[];
  readonly allowedActions: readonly FundedOperationAction[];
  readonly validFrom: Expiry;
  readonly validUntil: Expiry;
  readonly incidentOwnerRoleId: ProtocolId;
  readonly mainnetAuthorizationStatus: 'NOT_AUTHORIZED';
}

function canonicalActions(values: readonly FundedOperationAction[], context: string): readonly FundedOperationAction[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new MalformedInputError(context, 'action set is empty');
  }
  const sorted = [...values].sort((left, right) =>
    enumDiscriminant(FUNDED_OPERATION_ACTION, left) - enumDiscriminant(FUNDED_OPERATION_ACTION, right));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) {
      throw new DuplicateElementError(context, `duplicate action ${String(sorted[index])}`);
    }
  }
  sorted.forEach((value, index) => enumDiscriminant(FUNDED_OPERATION_ACTION, value, `${context}[${index}]`));
  return Object.freeze(sorted);
}

export function fundedOperationManifest(input: FundedOperationManifestInput, context = 'fundedOperationManifest'): FundedOperationManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a funded operation manifest');
  }
  enumDiscriminant(MAINNET_AUTHORIZATION_STATUS, input.mainnetAuthorizationStatus, `${context}.mainnetAuthorizationStatus`);
  const cap = operationCap(input, context);
  const signerRoleIds = canonicalByKey(
    input.signerRoleIds.map((role, index) => protocolId(role, `${context}.signerRoleIds[${index}]`)),
    (role) => role,
    `${context}.signerRoleIds`,
  );
  const validFrom = expiry(input.validFromUnit, input.validFromValue, `${context}.validFrom`);
  const validUntil = expiry(input.validUntilUnit, input.validUntilValue, `${context}.validUntil`);
  if (validFrom.unit !== validUntil.unit || validFrom.value >= validUntil.value) {
    throw new MalformedInputError(context, 'validity window units must match and increase');
  }
  const runtimeCodeHash = checkedHash(input.runtimeCodeHash, `${context}.runtimeCodeHash`);
  const configurationManifestHash = checkedHash(input.configurationManifestHash, `${context}.configurationManifestHash`);
  const authorityInventoryHashValue = checkedHash(input.authorityInventoryHash, `${context}.authorityInventoryHash`);
  return Object.freeze({
    ...cap,
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    get runtimeCodeHash(): ManifestHash {
      return Uint8Array.from(runtimeCodeHash) as ManifestHash;
    },
    get configurationManifestHash(): ManifestHash {
      return Uint8Array.from(configurationManifestHash) as ManifestHash;
    },
    authorityInventoryVersion: nonzeroU32(input.authorityInventoryVersion, `${context}.authorityInventoryVersion`),
    get authorityInventoryHash(): ManifestHash {
      return Uint8Array.from(authorityInventoryHashValue) as ManifestHash;
    },
    signerRoleIds,
    allowedActions: canonicalActions(input.allowedActions, `${context}.allowedActions`),
    validFrom,
    validUntil,
    incidentOwnerRoleId: protocolId(input.incidentOwnerRoleId, `${context}.incidentOwnerRoleId`),
    mainnetAuthorizationStatus: 'NOT_AUTHORIZED',
  });
}

export function encodeFundedOperationManifest(writer: CanonicalWriter, value: FundedOperationManifest): void {
  const checked = fundedOperationManifest({
    ...value,
    validFromUnit: value.validFrom.unit,
    validFromValue: value.validFrom.value,
    validUntilUnit: value.validUntil.unit,
    validUntilValue: value.validUntil.value,
  }, 'fundedOperationManifest');
  writer.writeU32(checked.schemaVersion, 'fundedOperationManifest.schemaVersion');
  writer.writeU32(checked.manifestVersion, 'fundedOperationManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'fundedOperationManifest.environment');
  encodeOperationCap(writer, checked);
  encodeManifestHash(writer, checked.runtimeCodeHash, 'fundedOperationManifest.runtimeCodeHash');
  encodeManifestHash(writer, checked.configurationManifestHash, 'fundedOperationManifest.configurationManifestHash');
  writer.writeU32(checked.authorityInventoryVersion, 'fundedOperationManifest.authorityInventoryVersion');
  encodeManifestHash(writer, checked.authorityInventoryHash, 'fundedOperationManifest.authorityInventoryHash');
  writer.writeArray(checked.signerRoleIds, (target, role) => encodeProtocolId(target, role), 'fundedOperationManifest.signerRoleIds');
  writer.writeArray(checked.allowedActions, (target, action) => target.writeEnum(FUNDED_OPERATION_ACTION, action), 'fundedOperationManifest.allowedActions');
  targetExpiry(writer, checked.validFrom, 'fundedOperationManifest.validFrom');
  targetExpiry(writer, checked.validUntil, 'fundedOperationManifest.validUntil');
  encodeProtocolId(writer, checked.incidentOwnerRoleId, 'fundedOperationManifest.incidentOwnerRoleId');
  writer.writeEnum(MAINNET_AUTHORIZATION_STATUS, checked.mainnetAuthorizationStatus, 'fundedOperationManifest.mainnetAuthorizationStatus');
}

function targetExpiry(writer: CanonicalWriter, value: Expiry, context: string): void {
  writer.writeEnum(EXPIRY_UNIT, value.unit, `${context}.unit`);
  writer.writeU64(value.value, `${context}.value`);
}

export function fundedOperationManifestBytes(value: FundedOperationManifestInput): Uint8Array {
  const checked = fundedOperationManifest(value);
  return canonicalBytes((writer) => encodeFundedOperationManifest(writer, checked));
}

export function fundedOperationManifestHash(value: FundedOperationManifestInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.FUNDED_OPERATION_MANIFEST, fundedOperationManifestBytes(value)), 'fundedOperationManifestHash');
}

export interface SecurityFindingInput {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly evidenceHash: Uint8Array | string;
}

export interface SecurityFinding {
  readonly findingId: ProtocolId;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly evidenceHash: ManifestHash;
}

function securityFinding(input: SecurityFindingInput, context: string): SecurityFinding {
  enumDiscriminant(FINDING_SEVERITY, input.severity, `${context}.severity`);
  enumDiscriminant(FINDING_STATUS, input.status, `${context}.status`);
  const evidence = checkedHash(input.evidenceHash, `${context}.evidenceHash`);
  return Object.freeze({
    findingId: protocolId(input.findingId, `${context}.findingId`),
    severity: input.severity,
    status: input.status,
    get evidenceHash(): ManifestHash {
      return Uint8Array.from(evidence) as ManifestHash;
    },
  });
}

function encodeSecurityFinding(writer: CanonicalWriter, value: SecurityFinding): void {
  const checked = securityFinding(value, 'securityFinding');
  encodeProtocolId(writer, checked.findingId, 'securityFinding.findingId');
  writer.writeEnum(FINDING_SEVERITY, checked.severity, 'securityFinding.severity');
  writer.writeEnum(FINDING_STATUS, checked.status, 'securityFinding.status');
  encodeManifestHash(writer, checked.evidenceHash, 'securityFinding.evidenceHash');
}

export interface SecurityFindingSummaryInput {
  readonly schemaVersion: number;
  readonly registerVersion: number;
  readonly findings: readonly SecurityFindingInput[];
}

export interface SecurityFindingSummary {
  readonly schemaVersion: 1;
  readonly registerVersion: number;
  readonly findings: readonly SecurityFinding[];
  readonly hasZeroOpenCriticalOrHigh: boolean;
}

export function securityFindingSummary(input: SecurityFindingSummaryInput, context = 'securityFindingSummary'): SecurityFindingSummary {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a security finding summary');
  }
  const findings = canonicalByKey(
    input.findings.map((finding, index) => securityFinding(finding, `${context}.findings[${index}]`)),
    (finding) => finding.findingId,
    `${context}.findings`,
    false,
  );
  const hasZeroOpenCriticalOrHigh = !findings.some((finding) =>
    finding.status === 'OPEN' && (finding.severity === 'CRITICAL' || finding.severity === 'HIGH'));
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    registerVersion: nonzeroU32(input.registerVersion, `${context}.registerVersion`),
    findings,
    hasZeroOpenCriticalOrHigh,
  });
}

export function encodeSecurityFindingSummary(writer: CanonicalWriter, value: SecurityFindingSummary): void {
  const checked = securityFindingSummary(value, 'securityFindingSummary');
  writer.writeU32(checked.schemaVersion, 'securityFindingSummary.schemaVersion');
  writer.writeU32(checked.registerVersion, 'securityFindingSummary.registerVersion');
  writer.writeArray(checked.findings, encodeSecurityFinding, 'securityFindingSummary.findings');
}

export function securityFindingSummaryBytes(value: SecurityFindingSummaryInput): Uint8Array {
  const checked = securityFindingSummary(value);
  return canonicalBytes((writer) => encodeSecurityFindingSummary(writer, checked));
}

export function securityFindingSummaryHash(value: SecurityFindingSummaryInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.SECURITY_FINDING_SUMMARY, securityFindingSummaryBytes(value)), 'securityFindingSummaryHash');
}

export interface ReadinessEvidenceInput {
  readonly kind: ReadinessEvidenceKind;
  readonly commitment: Uint8Array | string;
}

export interface ReadinessEvidence {
  readonly kind: ReadinessEvidenceKind;
  readonly commitment: ManifestHash;
}

export interface ReadinessDecisionInput {
  readonly schemaVersion: number;
  readonly decisionVersion: number;
  readonly environment: string;
  readonly evaluatedAtUnit: ExpiryUnit;
  readonly evaluatedAtValue: bigint;
  readonly authorityInventory: AuthorityInventoryInput;
  readonly capPolicy: OperationCapPolicyInput;
  readonly fundedOperations: readonly FundedOperationManifestInput[];
  readonly findingSummary: SecurityFindingSummaryInput;
  readonly evidence: readonly ReadinessEvidenceInput[];
}

export interface ReadinessDecision {
  readonly schemaVersion: 1;
  readonly decisionVersion: number;
  readonly environment: ProtocolId;
  readonly evaluatedAt: Expiry;
  readonly authorityInventoryHash: ManifestHash;
  readonly capPolicyHash: ManifestHash;
  readonly fundedOperationHashes: readonly ManifestHash[];
  readonly findingSummaryHash: ManifestHash;
  readonly evidence: readonly ReadinessEvidence[];
  readonly status: ReadinessStatus;
}

const REQUIRED_EVIDENCE = Object.freeze(Object.keys(READINESS_EVIDENCE_KIND) as ReadinessEvidenceKind[]);

function evidenceItem(input: ReadinessEvidenceInput, context: string): ReadinessEvidence {
  enumDiscriminant(READINESS_EVIDENCE_KIND, input.kind, `${context}.kind`);
  const commitment = checkedHash(input.commitment, `${context}.commitment`);
  return Object.freeze({
    kind: input.kind,
    get commitment(): ManifestHash {
      return Uint8Array.from(commitment) as ManifestHash;
    },
  });
}

function domainsEqual(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId &&
    left.domainManifestVersion === right.domainManifestVersion &&
    bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function manifestsEqual(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId && left.manifestVersion === right.manifestVersion &&
    bytesEqual(left.manifestHash, right.manifestHash);
}

function matchingCap(operation: FundedOperationManifest, cap: OperationCap): boolean {
  return domainsEqual(operation.domain, cap.domain) && manifestsEqual(operation.template, cap.template) &&
    operation.settlementClass === cap.settlementClass && operation.quoteMode === cap.quoteMode &&
    operation.sizeCohort === cap.sizeCohort && operation.assetId === cap.assetId;
}

function operationPasses(
  operation: FundedOperationManifest,
  inventory: AuthorityInventory,
  policy: OperationCapPolicy,
  evaluatedAt: Expiry,
  environment: ProtocolId,
): boolean {
  if (operation.environment !== environment || inventory.environment !== environment || policy.environment !== environment) return false;
  if (operation.authorityInventoryVersion !== inventory.inventoryVersion) return false;
  if (!bytesEqual(operation.authorityInventoryHash, authorityInventoryHash(inventory))) return false;
  if (operation.validFrom.unit !== evaluatedAt.unit || operation.validUntil.unit !== evaluatedAt.unit) return false;
  if (evaluatedAt.value < operation.validFrom.value || evaluatedAt.value >= operation.validUntil.value) return false;
  const roles = new Map(inventory.roles.map((role) => [role.roleId, role.authorityClass]));
  if (roles.get(operation.incidentOwnerRoleId) !== 'INCIDENT_OWNER') return false;
  if (operation.signerRoleIds.some((role) => roles.get(role) !== 'EXECUTION_SIGNER')) return false;
  const cap = policy.caps.find((candidate) => matchingCap(operation, candidate));
  return cap !== undefined &&
    operation.maxAssetMovementAtoms <= cap.maxAssetMovementAtoms &&
    operation.maxFeeAtoms <= cap.maxFeeAtoms &&
    operation.maxMarginAtoms <= cap.maxMarginAtoms &&
    operation.maxRecoveryAtoms <= cap.maxRecoveryAtoms;
}

export function readinessDecision(input: ReadinessDecisionInput, context = 'readinessDecision'): ReadinessDecision {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a readiness decision input');
  }
  const environment = protocolId(input.environment, `${context}.environment`);
  const evaluatedAt = expiry(input.evaluatedAtUnit, input.evaluatedAtValue, `${context}.evaluatedAt`);
  const inventory = authorityInventory(input.authorityInventory, `${context}.authorityInventory`);
  const policy = operationCapPolicy(input.capPolicy, `${context}.capPolicy`);
  if (!Array.isArray(input.fundedOperations) || input.fundedOperations.length === 0) {
    throw new MalformedInputError(`${context}.fundedOperations`, 'set is empty');
  }
  const operations = input.fundedOperations.map((operation, index) =>
    fundedOperationManifest(operation, `${context}.fundedOperations[${index}]`));
  const findingSummary = securityFindingSummary(input.findingSummary, `${context}.findingSummary`);
  const evidence = canonicalByKey(
    input.evidence.map((item, index) => evidenceItem(item, `${context}.evidence[${index}]`)),
    (item) => String(enumDiscriminant(READINESS_EVIDENCE_KIND, item.kind)).padStart(3, '0'),
    `${context}.evidence`,
  );
  const evidencePasses = evidence.length === REQUIRED_EVIDENCE.length &&
    REQUIRED_EVIDENCE.every((kind) => evidence.some((item) => item.kind === kind));
  const operationsPass = operations.every((operation) =>
    operationPasses(operation, inventory, policy, evaluatedAt, environment));
  const status: ReadinessStatus = evidencePasses && operationsPass && findingSummary.hasZeroOpenCriticalOrHigh
    ? 'READY'
    : 'NOT_READY';
  const inventoryHash = authorityInventoryHash(inventory);
  const capHash = operationCapPolicyHash(policy);
  const operationHashes = canonicalByKey(operations.map((operation) => fundedOperationManifestHash({
    ...operation,
    validFromUnit: operation.validFrom.unit,
    validFromValue: operation.validFrom.value,
    validUntilUnit: operation.validUntil.unit,
    validUntilValue: operation.validUntil.value,
  })), toHex, `${context}.fundedOperationHashes`);
  const findingsHash = securityFindingSummaryHash(findingSummary);
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    decisionVersion: nonzeroU32(input.decisionVersion, `${context}.decisionVersion`),
    environment,
    evaluatedAt,
    get authorityInventoryHash(): ManifestHash { return Uint8Array.from(inventoryHash) as ManifestHash; },
    get capPolicyHash(): ManifestHash { return Uint8Array.from(capHash) as ManifestHash; },
    fundedOperationHashes: operationHashes,
    get findingSummaryHash(): ManifestHash { return Uint8Array.from(findingsHash) as ManifestHash; },
    evidence,
    status,
  });
}

export function encodeReadinessDecision(writer: CanonicalWriter, value: ReadinessDecision): void {
  writer.writeU32(fixedVersion(value.schemaVersion, 'readinessDecision.schemaVersion'));
  writer.writeU32(nonzeroU32(value.decisionVersion, 'readinessDecision.decisionVersion'));
  encodeProtocolId(writer, protocolId(value.environment), 'readinessDecision.environment');
  targetExpiry(writer, expiry(value.evaluatedAt.unit, value.evaluatedAt.value), 'readinessDecision.evaluatedAt');
  encodeManifestHash(writer, checkedHash(value.authorityInventoryHash, 'readinessDecision.authorityInventoryHash'));
  encodeManifestHash(writer, checkedHash(value.capPolicyHash, 'readinessDecision.capPolicyHash'));
  writer.writeArray(value.fundedOperationHashes, (target, hash) => encodeManifestHash(target, checkedHash(hash, 'readinessDecision.fundedOperationHash')));
  encodeManifestHash(writer, checkedHash(value.findingSummaryHash, 'readinessDecision.findingSummaryHash'));
  const evidence = canonicalByKey(value.evidence.map((item, index) => evidenceItem(item, `readinessDecision.evidence[${index}]`)), (item) => String(enumDiscriminant(READINESS_EVIDENCE_KIND, item.kind)).padStart(3, '0'), 'readinessDecision.evidence');
  writer.writeArray(evidence, (target, item) => {
    target.writeEnum(READINESS_EVIDENCE_KIND, item.kind);
    encodeManifestHash(target, item.commitment);
  });
  writer.writeEnum(READINESS_STATUS, value.status, 'readinessDecision.status');
}

export function readinessDecisionBytes(value: ReadinessDecisionInput): Uint8Array {
  const checked = readinessDecision(value);
  return canonicalBytes((writer) => encodeReadinessDecision(writer, checked));
}

export function readinessDecisionHash(value: ReadinessDecisionInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.READINESS_DECISION, readinessDecisionBytes(value)), 'readinessDecisionHash');
}

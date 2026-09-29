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
  SECURITY_REVIEWER: 7,
  RELEASE_APPROVER: 8,
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
  MONITORING: 6,
  RECOVERY_DRILL: 7,
  SIGNER_INVENTORY: 8,
  STOP_CONDITION_DRILL: 9,
  RECONCILIATION: 10,
} as const);
export type ReadinessEvidenceKind = keyof typeof READINESS_EVIDENCE_KIND;

export const EVIDENCE_RESULT = Object.freeze({
  PASS: 1,
  FAIL: 2,
} as const);
export type EvidenceResult = keyof typeof EVIDENCE_RESULT;

export const OPERATION_PREREQUISITE = Object.freeze({
  DOMAIN_QUALIFIED: 1,
  ADAPTER_QUALIFIED: 2,
  ACCOUNT_BALANCE_CONFIRMED: 3,
  ALLOWANCE_CONFIRMED: 4,
  SIMULATION_PASSED: 5,
  RECOVERY_PROVEN: 6,
} as const);
export type OperationPrerequisite = keyof typeof OPERATION_PREREQUISITE;

export const STOP_CONDITION = Object.freeze({
  PRINCIPAL_CAP_REACHED: 1,
  FEE_CAP_REACHED: 2,
  SLIPPAGE_CAP_REACHED: 3,
  LOSS_CAP_REACHED: 4,
  STALE_OBSERVATION: 5,
  DEPENDENCY_UNAVAILABLE: 6,
  RECONCILIATION_FAILED: 7,
} as const);
export type StopCondition = keyof typeof STOP_CONDITION;

export const OPERATION_LEDGER_STATE = Object.freeze({
  RESERVED: 1,
  CONSUMED: 2,
  RECONCILED: 3,
  RELEASED: 4,
} as const);
export type OperationLedgerState = keyof typeof OPERATION_LEDGER_STATE;

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
  readonly forbiddenCollisions: readonly AuthorityCollisionRuleInput[];
}

export interface AuthorityInventory {
  readonly schemaVersion: 1;
  readonly inventoryVersion: number;
  readonly environment: ProtocolId;
  readonly roles: readonly AuthorityRole[];
  readonly forbiddenCollisions: readonly AuthorityCollisionRule[];
}

export interface AuthorityCollisionRuleInput {
  readonly leftClass: AuthorityClass;
  readonly rightClass: AuthorityClass;
  readonly forbidIdentityCollision: boolean;
  readonly forbidCustodyCollision: boolean;
}

export interface AuthorityCollisionRule extends AuthorityCollisionRuleInput {}

function authorityCollisionRule(input: AuthorityCollisionRuleInput, context: string): AuthorityCollisionRule {
  const left = enumDiscriminant(AUTHORITY_CLASS, input.leftClass, `${context}.leftClass`);
  const right = enumDiscriminant(AUTHORITY_CLASS, input.rightClass, `${context}.rightClass`);
  if (left >= right) {
    throw new MalformedInputError(context, 'authority classes must be distinct and canonically ordered');
  }
  if (typeof input.forbidIdentityCollision !== 'boolean' || typeof input.forbidCustodyCollision !== 'boolean') {
    throw new MalformedInputError(context, 'collision flags must be booleans');
  }
  if (!input.forbidIdentityCollision && !input.forbidCustodyCollision) {
    throw new MalformedInputError(context, 'collision rule forbids nothing');
  }
  return Object.freeze({ ...input });
}

function collisionRuleKey(value: AuthorityCollisionRule): string {
  return `${String(enumDiscriminant(AUTHORITY_CLASS, value.leftClass)).padStart(3, '0')}:${String(enumDiscriminant(AUTHORITY_CLASS, value.rightClass)).padStart(3, '0')}`;
}

function encodeAuthorityCollisionRule(writer: CanonicalWriter, value: AuthorityCollisionRule): void {
  const checked = authorityCollisionRule(value, 'authorityCollisionRule');
  writer.writeEnum(AUTHORITY_CLASS, checked.leftClass, 'authorityCollisionRule.leftClass');
  writer.writeEnum(AUTHORITY_CLASS, checked.rightClass, 'authorityCollisionRule.rightClass');
  writer.writeBool(checked.forbidIdentityCollision, 'authorityCollisionRule.forbidIdentityCollision');
  writer.writeBool(checked.forbidCustodyCollision, 'authorityCollisionRule.forbidCustodyCollision');
}

function enforceAuthorityCollisions(
  roles: readonly AuthorityRole[],
  rules: readonly AuthorityCollisionRule[],
  context: string,
): void {
  for (const rule of rules) {
    const leftRoles = roles.filter((role) => role.authorityClass === rule.leftClass);
    const rightRoles = roles.filter((role) => role.authorityClass === rule.rightClass);
    for (const left of leftRoles) {
      for (const right of rightRoles) {
        if (rule.forbidIdentityCollision && bytesEqual(left.publicIdentityCommitment, right.publicIdentityCommitment)) {
          throw new MalformedInputError(context, `identity collision between ${left.roleId} and ${right.roleId}`);
        }
        if (rule.forbidCustodyCollision && bytesEqual(left.custodyPolicyHash, right.custodyPolicyHash)) {
          throw new MalformedInputError(context, `custody collision between ${left.roleId} and ${right.roleId}`);
        }
      }
    }
  }
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
  const forbiddenCollisions = canonicalByKey(
    input.forbiddenCollisions.map((rule, index) => authorityCollisionRule(rule, `${context}.forbiddenCollisions[${index}]`)),
    collisionRuleKey,
    `${context}.forbiddenCollisions`,
  );
  enforceAuthorityCollisions(roles, forbiddenCollisions, `${context}.forbiddenCollisions`);
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    inventoryVersion: nonzeroU32(input.inventoryVersion, `${context}.inventoryVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    roles,
    forbiddenCollisions,
  });
}

export function encodeAuthorityInventory(writer: CanonicalWriter, value: AuthorityInventory): void {
  const checked = authorityInventory(value, 'authorityInventory');
  writer.writeU32(checked.schemaVersion, 'authorityInventory.schemaVersion');
  writer.writeU32(checked.inventoryVersion, 'authorityInventory.inventoryVersion');
  encodeProtocolId(writer, checked.environment, 'authorityInventory.environment');
  writer.writeArray(checked.roles, encodeAuthorityRole, 'authorityInventory.roles');
  writer.writeArray(checked.forbiddenCollisions, encodeAuthorityCollisionRule, 'authorityInventory.forbiddenCollisions');
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
  readonly maxPrincipalAtoms: bigint;
  readonly maxNetworkFeeAtoms: bigint;
  readonly maxProtocolFeeAtoms: bigint;
  readonly maxSlippageAtoms: bigint;
  readonly maxMarginAtoms: bigint;
  readonly maxRecoveryAtoms: bigint;
  readonly maxLossAtoms: bigint;
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
    maxPrincipalAtoms: atoms(input.maxPrincipalAtoms, `${context}.maxPrincipalAtoms`, false),
    maxNetworkFeeAtoms: atoms(input.maxNetworkFeeAtoms, `${context}.maxNetworkFeeAtoms`),
    maxProtocolFeeAtoms: atoms(input.maxProtocolFeeAtoms, `${context}.maxProtocolFeeAtoms`),
    maxSlippageAtoms: atoms(input.maxSlippageAtoms, `${context}.maxSlippageAtoms`),
    maxMarginAtoms: atoms(input.maxMarginAtoms, `${context}.maxMarginAtoms`),
    maxRecoveryAtoms: atoms(input.maxRecoveryAtoms, `${context}.maxRecoveryAtoms`),
    maxLossAtoms: atoms(input.maxLossAtoms, `${context}.maxLossAtoms`),
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
  writer.writeU128(checked.maxPrincipalAtoms, 'operationCap.maxPrincipalAtoms');
  writer.writeU128(checked.maxNetworkFeeAtoms, 'operationCap.maxNetworkFeeAtoms');
  writer.writeU128(checked.maxProtocolFeeAtoms, 'operationCap.maxProtocolFeeAtoms');
  writer.writeU128(checked.maxSlippageAtoms, 'operationCap.maxSlippageAtoms');
  writer.writeU128(checked.maxMarginAtoms, 'operationCap.maxMarginAtoms');
  writer.writeU128(checked.maxRecoveryAtoms, 'operationCap.maxRecoveryAtoms');
  writer.writeU128(checked.maxLossAtoms, 'operationCap.maxLossAtoms');
}

export interface AggregateAssetCapInput extends Omit<OperationCapInput, 'domain' | 'template' | 'settlementClass' | 'quoteMode' | 'sizeCohort'> {}
export interface AggregateAssetCap extends Omit<AggregateAssetCapInput, 'assetId'> {
  readonly assetId: ProtocolId;
}

export interface AggregateAccountCapInput extends AggregateAssetCapInput {
  readonly accountCommitment: Uint8Array | string;
}

export interface AggregateAccountCap extends AggregateAssetCap {
  readonly accountCommitment: ManifestHash;
}

function aggregateAssetCap(input: AggregateAssetCapInput, context: string): AggregateAssetCap {
  return Object.freeze({
    assetId: protocolId(input.assetId, `${context}.assetId`),
    maxPrincipalAtoms: atoms(input.maxPrincipalAtoms, `${context}.maxPrincipalAtoms`, false),
    maxNetworkFeeAtoms: atoms(input.maxNetworkFeeAtoms, `${context}.maxNetworkFeeAtoms`),
    maxProtocolFeeAtoms: atoms(input.maxProtocolFeeAtoms, `${context}.maxProtocolFeeAtoms`),
    maxSlippageAtoms: atoms(input.maxSlippageAtoms, `${context}.maxSlippageAtoms`),
    maxMarginAtoms: atoms(input.maxMarginAtoms, `${context}.maxMarginAtoms`),
    maxRecoveryAtoms: atoms(input.maxRecoveryAtoms, `${context}.maxRecoveryAtoms`),
    maxLossAtoms: atoms(input.maxLossAtoms, `${context}.maxLossAtoms`),
  });
}

function encodeAggregateAssetCap(writer: CanonicalWriter, value: AggregateAssetCapInput): void {
  const checked = aggregateAssetCap(value, 'aggregateAssetCap');
  encodeProtocolId(writer, checked.assetId as ProtocolId, 'aggregateAssetCap.assetId');
  writer.writeU128(checked.maxPrincipalAtoms, 'aggregateAssetCap.maxPrincipalAtoms');
  writer.writeU128(checked.maxNetworkFeeAtoms, 'aggregateAssetCap.maxNetworkFeeAtoms');
  writer.writeU128(checked.maxProtocolFeeAtoms, 'aggregateAssetCap.maxProtocolFeeAtoms');
  writer.writeU128(checked.maxSlippageAtoms, 'aggregateAssetCap.maxSlippageAtoms');
  writer.writeU128(checked.maxMarginAtoms, 'aggregateAssetCap.maxMarginAtoms');
  writer.writeU128(checked.maxRecoveryAtoms, 'aggregateAssetCap.maxRecoveryAtoms');
  writer.writeU128(checked.maxLossAtoms, 'aggregateAssetCap.maxLossAtoms');
}

function aggregateAccountCap(input: AggregateAccountCapInput, context: string): AggregateAccountCap {
  const cap = aggregateAssetCap(input, context);
  const account = checkedHash(input.accountCommitment, `${context}.accountCommitment`);
  return Object.freeze({
    ...cap,
    get accountCommitment(): ManifestHash { return Uint8Array.from(account) as ManifestHash; },
  });
}

function accountCapKey(value: AggregateAccountCapInput): string {
  return `${toHex(checkedHash(value.accountCommitment, 'aggregateAccountCap.accountCommitment'))}:${value.assetId}`;
}

function encodeAggregateAccountCap(writer: CanonicalWriter, value: AggregateAccountCapInput): void {
  const checked = aggregateAccountCap(value, 'aggregateAccountCap');
  encodeManifestHash(writer, checked.accountCommitment as ManifestHash, 'aggregateAccountCap.accountCommitment');
  encodeAggregateAssetCap(writer, checked);
}

export interface OperationCapPolicyInput {
  readonly schemaVersion: number;
  readonly policyVersion: number;
  readonly environment: string;
  readonly caps: readonly OperationCapInput[];
  readonly aggregateAssetCaps: readonly AggregateAssetCapInput[];
  readonly aggregateAccountCaps: readonly AggregateAccountCapInput[];
}

export interface OperationCapPolicy {
  readonly schemaVersion: 1;
  readonly policyVersion: number;
  readonly environment: ProtocolId;
  readonly caps: readonly OperationCap[];
  readonly aggregateAssetCaps: readonly AggregateAssetCap[];
  readonly aggregateAccountCaps: readonly AggregateAccountCap[];
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
  const aggregateAssetCaps = canonicalByKey(
    input.aggregateAssetCaps.map((cap, index) => aggregateAssetCap(cap, `${context}.aggregateAssetCaps[${index}]`)),
    (cap) => cap.assetId,
    `${context}.aggregateAssetCaps`,
  );
  const aggregateAccountCaps = canonicalByKey(
    input.aggregateAccountCaps.map((cap, index) => aggregateAccountCap(cap, `${context}.aggregateAccountCaps[${index}]`)),
    accountCapKey,
    `${context}.aggregateAccountCaps`,
  );
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    policyVersion: nonzeroU32(input.policyVersion, `${context}.policyVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    caps,
    aggregateAssetCaps,
    aggregateAccountCaps,
  });
}

export function encodeOperationCapPolicy(writer: CanonicalWriter, value: OperationCapPolicy): void {
  const checked = operationCapPolicy(value, 'operationCapPolicy');
  writer.writeU32(checked.schemaVersion, 'operationCapPolicy.schemaVersion');
  writer.writeU32(checked.policyVersion, 'operationCapPolicy.policyVersion');
  encodeProtocolId(writer, checked.environment, 'operationCapPolicy.environment');
  writer.writeArray(checked.caps, encodeOperationCap, 'operationCapPolicy.caps');
  writer.writeArray(checked.aggregateAssetCaps, encodeAggregateAssetCap, 'operationCapPolicy.aggregateAssetCaps');
  writer.writeArray(checked.aggregateAccountCaps, encodeAggregateAccountCap, 'operationCapPolicy.aggregateAccountCaps');
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
  readonly operationId: string;
  readonly sourceAccountCommitment: Uint8Array | string;
  readonly destinationAccountCommitment: Uint8Array | string;
  readonly unsignedPayloadHash: Uint8Array | string;
  readonly runtimeCodeHash: Uint8Array | string;
  readonly configurationManifestHash: Uint8Array | string;
  readonly authorityInventoryVersion: number;
  readonly authorityInventoryHash: Uint8Array | string;
  readonly signerRoleIds: readonly string[];
  readonly approverRoleCommitments: readonly ApproverRoleCommitmentInput[];
  readonly allowedActions: readonly FundedOperationAction[];
  readonly prerequisites: readonly OperationPrerequisite[];
  readonly stopConditions: readonly StopCondition[];
  readonly simulationEvidenceHash: Uint8Array | string;
  readonly recoverabilityEvidenceHash: Uint8Array | string;
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
  readonly operationId: ProtocolId;
  readonly sourceAccountCommitment: ManifestHash;
  readonly destinationAccountCommitment: ManifestHash;
  readonly unsignedPayloadHash: ManifestHash;
  readonly runtimeCodeHash: ManifestHash;
  readonly configurationManifestHash: ManifestHash;
  readonly authorityInventoryVersion: number;
  readonly authorityInventoryHash: ManifestHash;
  readonly signerRoleIds: readonly ProtocolId[];
  readonly approverRoleCommitments: readonly ApproverRoleCommitment[];
  readonly allowedActions: readonly FundedOperationAction[];
  readonly prerequisites: readonly OperationPrerequisite[];
  readonly stopConditions: readonly StopCondition[];
  readonly simulationEvidenceHash: ManifestHash;
  readonly recoverabilityEvidenceHash: ManifestHash;
  readonly validFrom: Expiry;
  readonly validUntil: Expiry;
  readonly incidentOwnerRoleId: ProtocolId;
  readonly mainnetAuthorizationStatus: 'NOT_AUTHORIZED';
}

export interface ApproverRoleCommitmentInput {
  readonly roleId: string;
  readonly identityCommitment: Uint8Array | string;
}

export interface ApproverRoleCommitment {
  readonly roleId: ProtocolId;
  readonly identityCommitment: ManifestHash;
}

function approverRoleCommitment(input: ApproverRoleCommitmentInput, context: string): ApproverRoleCommitment {
  const identity = checkedHash(input.identityCommitment, `${context}.identityCommitment`);
  return Object.freeze({
    roleId: protocolId(input.roleId, `${context}.roleId`),
    get identityCommitment(): ManifestHash { return Uint8Array.from(identity) as ManifestHash; },
  });
}

function encodeApproverRoleCommitment(writer: CanonicalWriter, value: ApproverRoleCommitment): void {
  const checked = approverRoleCommitment(value, 'approverRoleCommitment');
  encodeProtocolId(writer, checked.roleId, 'approverRoleCommitment.roleId');
  encodeManifestHash(writer, checked.identityCommitment, 'approverRoleCommitment.identityCommitment');
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

function canonicalEnumSet<Name extends string>(
  values: readonly Name[],
  table: Readonly<Record<Name, number>>,
  context: string,
): readonly Name[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new MalformedInputError(context, 'set is empty');
  }
  const sorted = [...values].sort((left, right) => enumDiscriminant(table, left) - enumDiscriminant(table, right));
  sorted.forEach((value, index) => enumDiscriminant(table, value, `${context}[${index}]`));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) {
      throw new DuplicateElementError(context, `duplicate value ${String(sorted[index])}`);
    }
  }
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
  const approverRoleCommitments = canonicalByKey(
    input.approverRoleCommitments.map((approval, index) => approverRoleCommitment(approval, `${context}.approverRoleCommitments[${index}]`)),
    (approval) => approval.roleId,
    `${context}.approverRoleCommitments`,
  );
  const validFrom = expiry(input.validFromUnit, input.validFromValue, `${context}.validFrom`);
  const validUntil = expiry(input.validUntilUnit, input.validUntilValue, `${context}.validUntil`);
  if (validFrom.unit !== validUntil.unit || validFrom.value >= validUntil.value) {
    throw new MalformedInputError(context, 'validity window units must match and increase');
  }
  const runtimeCodeHash = checkedHash(input.runtimeCodeHash, `${context}.runtimeCodeHash`);
  const configurationManifestHash = checkedHash(input.configurationManifestHash, `${context}.configurationManifestHash`);
  const authorityInventoryHashValue = checkedHash(input.authorityInventoryHash, `${context}.authorityInventoryHash`);
  const sourceAccount = checkedHash(input.sourceAccountCommitment, `${context}.sourceAccountCommitment`);
  const destinationAccount = checkedHash(input.destinationAccountCommitment, `${context}.destinationAccountCommitment`);
  const payloadHash = checkedHash(input.unsignedPayloadHash, `${context}.unsignedPayloadHash`);
  const simulationHash = checkedHash(input.simulationEvidenceHash, `${context}.simulationEvidenceHash`);
  const recoverabilityHash = checkedHash(input.recoverabilityEvidenceHash, `${context}.recoverabilityEvidenceHash`);
  const prerequisites = canonicalEnumSet(input.prerequisites, OPERATION_PREREQUISITE, `${context}.prerequisites`);
  const stopConditions = canonicalEnumSet(input.stopConditions, STOP_CONDITION, `${context}.stopConditions`);
  return Object.freeze({
    ...cap,
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    operationId: protocolId(input.operationId, `${context}.operationId`),
    get sourceAccountCommitment(): ManifestHash { return Uint8Array.from(sourceAccount) as ManifestHash; },
    get destinationAccountCommitment(): ManifestHash { return Uint8Array.from(destinationAccount) as ManifestHash; },
    get unsignedPayloadHash(): ManifestHash { return Uint8Array.from(payloadHash) as ManifestHash; },
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
    approverRoleCommitments,
    allowedActions: canonicalActions(input.allowedActions, `${context}.allowedActions`),
    prerequisites,
    stopConditions,
    get simulationEvidenceHash(): ManifestHash { return Uint8Array.from(simulationHash) as ManifestHash; },
    get recoverabilityEvidenceHash(): ManifestHash { return Uint8Array.from(recoverabilityHash) as ManifestHash; },
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
  encodeProtocolId(writer, checked.operationId, 'fundedOperationManifest.operationId');
  encodeManifestHash(writer, checked.sourceAccountCommitment, 'fundedOperationManifest.sourceAccountCommitment');
  encodeManifestHash(writer, checked.destinationAccountCommitment, 'fundedOperationManifest.destinationAccountCommitment');
  encodeManifestHash(writer, checked.unsignedPayloadHash, 'fundedOperationManifest.unsignedPayloadHash');
  encodeOperationCap(writer, checked);
  encodeManifestHash(writer, checked.runtimeCodeHash, 'fundedOperationManifest.runtimeCodeHash');
  encodeManifestHash(writer, checked.configurationManifestHash, 'fundedOperationManifest.configurationManifestHash');
  writer.writeU32(checked.authorityInventoryVersion, 'fundedOperationManifest.authorityInventoryVersion');
  encodeManifestHash(writer, checked.authorityInventoryHash, 'fundedOperationManifest.authorityInventoryHash');
  writer.writeArray(checked.signerRoleIds, (target, role) => encodeProtocolId(target, role), 'fundedOperationManifest.signerRoleIds');
  writer.writeArray(checked.approverRoleCommitments, encodeApproverRoleCommitment, 'fundedOperationManifest.approverRoleCommitments');
  writer.writeArray(checked.allowedActions, (target, action) => target.writeEnum(FUNDED_OPERATION_ACTION, action), 'fundedOperationManifest.allowedActions');
  writer.writeArray(checked.prerequisites, (target, prerequisite) => target.writeEnum(OPERATION_PREREQUISITE, prerequisite), 'fundedOperationManifest.prerequisites');
  writer.writeArray(checked.stopConditions, (target, condition) => target.writeEnum(STOP_CONDITION, condition), 'fundedOperationManifest.stopConditions');
  encodeManifestHash(writer, checked.simulationEvidenceHash, 'fundedOperationManifest.simulationEvidenceHash');
  encodeManifestHash(writer, checked.recoverabilityEvidenceHash, 'fundedOperationManifest.recoverabilityEvidenceHash');
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
  readonly closureEvidenceHash?: Uint8Array | string;
}

export interface SecurityFinding {
  readonly findingId: ProtocolId;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly evidenceHash: ManifestHash;
  readonly closureEvidenceHash?: ManifestHash;
}

function securityFinding(input: SecurityFindingInput, context: string): SecurityFinding {
  enumDiscriminant(FINDING_SEVERITY, input.severity, `${context}.severity`);
  enumDiscriminant(FINDING_STATUS, input.status, `${context}.status`);
  const evidence = checkedHash(input.evidenceHash, `${context}.evidenceHash`);
  const requiresClosure = input.status === 'RESOLVED' && (input.severity === 'CRITICAL' || input.severity === 'HIGH');
  if (requiresClosure !== (input.closureEvidenceHash !== undefined)) {
    throw new MalformedInputError(context, 'resolved critical or high findings require closure evidence and no other finding may carry it');
  }
  const closure = input.closureEvidenceHash === undefined
    ? undefined
    : checkedHash(input.closureEvidenceHash, `${context}.closureEvidenceHash`);
  return Object.freeze({
    findingId: protocolId(input.findingId, `${context}.findingId`),
    severity: input.severity,
    status: input.status,
    get evidenceHash(): ManifestHash {
      return Uint8Array.from(evidence) as ManifestHash;
    },
    ...(closure === undefined ? {} : {
      get closureEvidenceHash(): ManifestHash { return Uint8Array.from(closure) as ManifestHash; },
    }),
  });
}

function encodeSecurityFinding(writer: CanonicalWriter, value: SecurityFinding): void {
  const checked = securityFinding(value, 'securityFinding');
  encodeProtocolId(writer, checked.findingId, 'securityFinding.findingId');
  writer.writeEnum(FINDING_SEVERITY, checked.severity, 'securityFinding.severity');
  writer.writeEnum(FINDING_STATUS, checked.status, 'securityFinding.status');
  encodeManifestHash(writer, checked.evidenceHash, 'securityFinding.evidenceHash');
  writer.writeOptional(
    checked.closureEvidenceHash,
    (target, hash) => encodeManifestHash(target, hash, 'securityFinding.closureEvidenceHash'),
    'securityFinding.closureEvidenceHash',
  );
}

export interface IndependentReviewAttestationInput {
  readonly reviewScopeHash: Uint8Array | string;
  readonly reviewerRoleId: string;
  readonly reviewerIdentityCommitment: Uint8Array | string;
  readonly result: EvidenceResult;
  readonly environment: string;
  readonly completedAtUnit: ExpiryUnit;
  readonly completedAtValue: bigint;
  readonly expiresAtUnit: ExpiryUnit;
  readonly expiresAtValue: bigint;
  readonly signatureCommitment: Uint8Array | string;
}

export interface IndependentReviewAttestation {
  readonly reviewScopeHash: ManifestHash;
  readonly reviewerRoleId: ProtocolId;
  readonly reviewerIdentityCommitment: ManifestHash;
  readonly result: EvidenceResult;
  readonly environment: ProtocolId;
  readonly completedAt: Expiry;
  readonly expiresAt: Expiry;
  readonly signatureCommitment: ManifestHash;
}

function independentReviewAttestation(input: IndependentReviewAttestationInput, context: string): IndependentReviewAttestation {
  enumDiscriminant(EVIDENCE_RESULT, input.result, `${context}.result`);
  const completedAt = expiry(input.completedAtUnit, input.completedAtValue, `${context}.completedAt`);
  const expiresAt = expiry(input.expiresAtUnit, input.expiresAtValue, `${context}.expiresAt`);
  if (completedAt.unit !== expiresAt.unit || completedAt.value >= expiresAt.value) {
    throw new MalformedInputError(context, 'review interval units must match and increase');
  }
  const scope = checkedHash(input.reviewScopeHash, `${context}.reviewScopeHash`);
  const identity = checkedHash(input.reviewerIdentityCommitment, `${context}.reviewerIdentityCommitment`);
  const signature = checkedHash(input.signatureCommitment, `${context}.signatureCommitment`);
  return Object.freeze({
    get reviewScopeHash(): ManifestHash { return Uint8Array.from(scope) as ManifestHash; },
    reviewerRoleId: protocolId(input.reviewerRoleId, `${context}.reviewerRoleId`),
    get reviewerIdentityCommitment(): ManifestHash { return Uint8Array.from(identity) as ManifestHash; },
    result: input.result,
    environment: protocolId(input.environment, `${context}.environment`),
    completedAt,
    expiresAt,
    get signatureCommitment(): ManifestHash { return Uint8Array.from(signature) as ManifestHash; },
  });
}

function encodeIndependentReviewAttestation(writer: CanonicalWriter, value: IndependentReviewAttestation): void {
  const checked = independentReviewAttestation({
    ...value,
    completedAtUnit: value.completedAt.unit,
    completedAtValue: value.completedAt.value,
    expiresAtUnit: value.expiresAt.unit,
    expiresAtValue: value.expiresAt.value,
  }, 'independentReviewAttestation');
  encodeManifestHash(writer, checked.reviewScopeHash, 'independentReviewAttestation.reviewScopeHash');
  encodeProtocolId(writer, checked.reviewerRoleId, 'independentReviewAttestation.reviewerRoleId');
  encodeManifestHash(writer, checked.reviewerIdentityCommitment, 'independentReviewAttestation.reviewerIdentityCommitment');
  writer.writeEnum(EVIDENCE_RESULT, checked.result, 'independentReviewAttestation.result');
  encodeProtocolId(writer, checked.environment, 'independentReviewAttestation.environment');
  targetExpiry(writer, checked.completedAt, 'independentReviewAttestation.completedAt');
  targetExpiry(writer, checked.expiresAt, 'independentReviewAttestation.expiresAt');
  encodeManifestHash(writer, checked.signatureCommitment, 'independentReviewAttestation.signatureCommitment');
}

export interface SecurityFindingSummaryInput {
  readonly schemaVersion: number;
  readonly registerVersion: number;
  readonly findings: readonly SecurityFindingInput[];
  readonly reviewAttestation: IndependentReviewAttestationInput;
}

export interface SecurityFindingSummary {
  readonly schemaVersion: 1;
  readonly registerVersion: number;
  readonly findings: readonly SecurityFinding[];
  readonly reviewAttestation: IndependentReviewAttestation;
  readonly hasZeroOpenCriticalOrHigh: boolean;
}

export function securityFindingSummary(input: SecurityFindingSummaryInput | SecurityFindingSummary, context = 'securityFindingSummary'): SecurityFindingSummary {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a security finding summary');
  }
  const findings = canonicalByKey(
    input.findings.map((finding, index) => securityFinding(finding, `${context}.findings[${index}]`)),
    (finding) => finding.findingId,
    `${context}.findings`,
  );
  const reviewInput: IndependentReviewAttestationInput = 'completedAt' in input.reviewAttestation
    ? {
        ...input.reviewAttestation,
        completedAtUnit: input.reviewAttestation.completedAt.unit,
        completedAtValue: input.reviewAttestation.completedAt.value,
        expiresAtUnit: input.reviewAttestation.expiresAt.unit,
        expiresAtValue: input.reviewAttestation.expiresAt.value,
      }
    : input.reviewAttestation;
  const reviewAttestation = independentReviewAttestation(reviewInput, `${context}.reviewAttestation`);
  const hasZeroOpenCriticalOrHigh = !findings.some((finding) =>
    finding.status === 'OPEN' && (finding.severity === 'CRITICAL' || finding.severity === 'HIGH'));
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    registerVersion: nonzeroU32(input.registerVersion, `${context}.registerVersion`),
    findings,
    reviewAttestation,
    hasZeroOpenCriticalOrHigh,
  });
}

export function encodeSecurityFindingSummary(writer: CanonicalWriter, value: SecurityFindingSummary): void {
  const checked = securityFindingSummary(value, 'securityFindingSummary');
  writer.writeU32(checked.schemaVersion, 'securityFindingSummary.schemaVersion');
  writer.writeU32(checked.registerVersion, 'securityFindingSummary.registerVersion');
  writer.writeArray(checked.findings, encodeSecurityFinding, 'securityFindingSummary.findings');
  encodeIndependentReviewAttestation(writer, checked.reviewAttestation);
}

export function securityFindingSummaryBytes(value: SecurityFindingSummaryInput | SecurityFindingSummary): Uint8Array {
  const checked = securityFindingSummary(value);
  return canonicalBytes((writer) => encodeSecurityFindingSummary(writer, checked));
}

export function securityFindingSummaryHash(value: SecurityFindingSummaryInput | SecurityFindingSummary): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.SECURITY_FINDING_SUMMARY, securityFindingSummaryBytes(value)), 'securityFindingSummaryHash');
}

export interface ReadinessEvidenceInput {
  readonly kind: ReadinessEvidenceKind;
  readonly releaseHash: Uint8Array | string;
  readonly fundedOperationManifestHash: Uint8Array | string;
  readonly reviewerRoleId: string;
  readonly reviewerIdentityCommitment: Uint8Array | string;
  readonly result: EvidenceResult;
  readonly environment: string;
  readonly observedAtUnit: ExpiryUnit;
  readonly observedAtValue: bigint;
  readonly expiresAtUnit: ExpiryUnit;
  readonly expiresAtValue: bigint;
  readonly signatureCommitment: Uint8Array | string;
}

export interface ReadinessEvidence {
  readonly kind: ReadinessEvidenceKind;
  readonly releaseHash: ManifestHash;
  readonly fundedOperationManifestHash: ManifestHash;
  readonly reviewerRoleId: ProtocolId;
  readonly reviewerIdentityCommitment: ManifestHash;
  readonly result: EvidenceResult;
  readonly environment: ProtocolId;
  readonly observedAt: Expiry;
  readonly expiresAt: Expiry;
  readonly signatureCommitment: ManifestHash;
}

export interface ReadinessDecisionInput {
  readonly schemaVersion: number;
  readonly decisionVersion: number;
  readonly environment: string;
  readonly releaseHash: Uint8Array | string;
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
  readonly releaseHash: ManifestHash;
  readonly evaluatedAt: Expiry;
  readonly authorityInventoryHash: ManifestHash;
  readonly capPolicyHash: ManifestHash;
  readonly fundedOperationHashes: readonly ManifestHash[];
  readonly findingSummaryHash: ManifestHash;
  readonly evidence: readonly ReadinessEvidence[];
  readonly status: ReadinessStatus;
}

const REQUIRED_EVIDENCE = Object.freeze(Object.keys(READINESS_EVIDENCE_KIND) as ReadinessEvidenceKind[]);
const REQUIRED_PREREQUISITES = Object.freeze(Object.keys(OPERATION_PREREQUISITE) as OperationPrerequisite[]);
const REQUIRED_STOP_CONDITIONS = Object.freeze([
  'FEE_CAP_REACHED',
  'LOSS_CAP_REACHED',
  'STALE_OBSERVATION',
  'DEPENDENCY_UNAVAILABLE',
  'RECONCILIATION_FAILED',
] as const satisfies readonly StopCondition[]);

function evidenceItem(input: ReadinessEvidenceInput, context: string): ReadinessEvidence {
  enumDiscriminant(READINESS_EVIDENCE_KIND, input.kind, `${context}.kind`);
  enumDiscriminant(EVIDENCE_RESULT, input.result, `${context}.result`);
  const release = checkedHash(input.releaseHash, `${context}.releaseHash`);
  const operation = checkedHash(input.fundedOperationManifestHash, `${context}.fundedOperationManifestHash`);
  const identity = checkedHash(input.reviewerIdentityCommitment, `${context}.reviewerIdentityCommitment`);
  const signature = checkedHash(input.signatureCommitment, `${context}.signatureCommitment`);
  const observedAt = expiry(input.observedAtUnit, input.observedAtValue, `${context}.observedAt`);
  const expiresAt = expiry(input.expiresAtUnit, input.expiresAtValue, `${context}.expiresAt`);
  if (observedAt.unit !== expiresAt.unit || observedAt.value >= expiresAt.value) {
    throw new MalformedInputError(context, 'evidence interval units must match and increase');
  }
  return Object.freeze({
    kind: input.kind,
    get releaseHash(): ManifestHash { return Uint8Array.from(release) as ManifestHash; },
    get fundedOperationManifestHash(): ManifestHash { return Uint8Array.from(operation) as ManifestHash; },
    reviewerRoleId: protocolId(input.reviewerRoleId, `${context}.reviewerRoleId`),
    get reviewerIdentityCommitment(): ManifestHash { return Uint8Array.from(identity) as ManifestHash; },
    result: input.result,
    environment: protocolId(input.environment, `${context}.environment`),
    observedAt,
    expiresAt,
    get signatureCommitment(): ManifestHash { return Uint8Array.from(signature) as ManifestHash; },
  });
}

function readinessEvidenceKey(value: ReadinessEvidence): string {
  return `${toHex(value.fundedOperationManifestHash)}:${String(enumDiscriminant(READINESS_EVIDENCE_KIND, value.kind)).padStart(3, '0')}`;
}

export function encodeReadinessEvidence(writer: CanonicalWriter, value: ReadinessEvidence): void {
  const checked = evidenceItem({
    ...value,
    observedAtUnit: value.observedAt.unit,
    observedAtValue: value.observedAt.value,
    expiresAtUnit: value.expiresAt.unit,
    expiresAtValue: value.expiresAt.value,
  }, 'readinessEvidence');
  writer.writeEnum(READINESS_EVIDENCE_KIND, checked.kind, 'readinessEvidence.kind');
  encodeManifestHash(writer, checked.releaseHash, 'readinessEvidence.releaseHash');
  encodeManifestHash(writer, checked.fundedOperationManifestHash, 'readinessEvidence.fundedOperationManifestHash');
  encodeProtocolId(writer, checked.reviewerRoleId, 'readinessEvidence.reviewerRoleId');
  encodeManifestHash(writer, checked.reviewerIdentityCommitment, 'readinessEvidence.reviewerIdentityCommitment');
  writer.writeEnum(EVIDENCE_RESULT, checked.result, 'readinessEvidence.result');
  encodeProtocolId(writer, checked.environment, 'readinessEvidence.environment');
  targetExpiry(writer, checked.observedAt, 'readinessEvidence.observedAt');
  targetExpiry(writer, checked.expiresAt, 'readinessEvidence.expiresAt');
  encodeManifestHash(writer, checked.signatureCommitment, 'readinessEvidence.signatureCommitment');
}

export function readinessEvidenceBytes(value: ReadinessEvidenceInput): Uint8Array {
  const checked = evidenceItem(value, 'readinessEvidence');
  return canonicalBytes((writer) => encodeReadinessEvidence(writer, checked));
}

export function readinessEvidenceHash(value: ReadinessEvidenceInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.READINESS_EVIDENCE, readinessEvidenceBytes(value)), 'readinessEvidenceHash');
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

function withinBudget(operation: OperationCap, cap: AggregateAssetCapInput): boolean {
  return operation.maxPrincipalAtoms <= cap.maxPrincipalAtoms &&
    operation.maxNetworkFeeAtoms <= cap.maxNetworkFeeAtoms &&
    operation.maxProtocolFeeAtoms <= cap.maxProtocolFeeAtoms &&
    operation.maxSlippageAtoms <= cap.maxSlippageAtoms &&
    operation.maxMarginAtoms <= cap.maxMarginAtoms &&
    operation.maxRecoveryAtoms <= cap.maxRecoveryAtoms &&
    operation.maxLossAtoms <= cap.maxLossAtoms;
}

function budgetFromCap(cap: OperationCap): OperationBudget {
  return Object.freeze({
    principalAtoms: cap.maxPrincipalAtoms,
    networkFeeAtoms: cap.maxNetworkFeeAtoms,
    protocolFeeAtoms: cap.maxProtocolFeeAtoms,
    slippageAtoms: cap.maxSlippageAtoms,
    marginAtoms: cap.maxMarginAtoms,
    recoveryAtoms: cap.maxRecoveryAtoms,
    lossAtoms: cap.maxLossAtoms,
  });
}

function addBudget(left: OperationBudget, right: OperationBudget, context: string): OperationBudget {
  return Object.freeze({
    principalAtoms: atoms(left.principalAtoms + right.principalAtoms, `${context}.principalAtoms`),
    networkFeeAtoms: atoms(left.networkFeeAtoms + right.networkFeeAtoms, `${context}.networkFeeAtoms`),
    protocolFeeAtoms: atoms(left.protocolFeeAtoms + right.protocolFeeAtoms, `${context}.protocolFeeAtoms`),
    slippageAtoms: atoms(left.slippageAtoms + right.slippageAtoms, `${context}.slippageAtoms`),
    marginAtoms: atoms(left.marginAtoms + right.marginAtoms, `${context}.marginAtoms`),
    recoveryAtoms: atoms(left.recoveryAtoms + right.recoveryAtoms, `${context}.recoveryAtoms`),
    lossAtoms: atoms(left.lossAtoms + right.lossAtoms, `${context}.lossAtoms`),
  });
}

const EMPTY_BUDGET: OperationBudget = Object.freeze({
  principalAtoms: 0n, networkFeeAtoms: 0n, protocolFeeAtoms: 0n, slippageAtoms: 0n,
  marginAtoms: 0n, recoveryAtoms: 0n, lossAtoms: 0n,
});

function budgetWithinAggregate(budget: OperationBudget, cap: AggregateAssetCapInput): boolean {
  return budget.principalAtoms <= cap.maxPrincipalAtoms && budget.networkFeeAtoms <= cap.maxNetworkFeeAtoms &&
    budget.protocolFeeAtoms <= cap.maxProtocolFeeAtoms && budget.slippageAtoms <= cap.maxSlippageAtoms &&
    budget.marginAtoms <= cap.maxMarginAtoms && budget.recoveryAtoms <= cap.maxRecoveryAtoms &&
    budget.lossAtoms <= cap.maxLossAtoms;
}

function aggregateOperationsPass(operations: readonly FundedOperationManifest[], policy: OperationCapPolicy): boolean {
  const assetTotals = new Map<string, OperationBudget>();
  const accountTotals = new Map<string, OperationBudget>();
  for (const operation of operations) {
    const budget = budgetFromCap(operation);
    assetTotals.set(operation.assetId, addBudget(assetTotals.get(operation.assetId) ?? EMPTY_BUDGET, budget, `assetAggregate.${operation.assetId}`));
    const accountKeys = new Set([
      `${toHex(operation.sourceAccountCommitment)}:${operation.assetId}`,
      `${toHex(operation.destinationAccountCommitment)}:${operation.assetId}`,
    ]);
    for (const key of accountKeys) {
      accountTotals.set(key, addBudget(accountTotals.get(key) ?? EMPTY_BUDGET, budget, `accountAggregate.${key}`));
    }
  }
  return [...assetTotals].every(([assetId, total]) => {
    const cap = policy.aggregateAssetCaps.find((candidate) => candidate.assetId === assetId);
    return cap !== undefined && budgetWithinAggregate(total, cap);
  }) && [...accountTotals].every(([key, total]) => {
    const cap = policy.aggregateAccountCaps.find((candidate) => accountCapKey(candidate) === key);
    return cap !== undefined && budgetWithinAggregate(total, cap);
  });
}

function accountCapMatches(cap: AggregateAccountCap, commitment: ManifestHash, assetId: ProtocolId): boolean {
  return cap.assetId === assetId && bytesEqual(cap.accountCommitment, commitment);
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
  const roleDetails = new Map(inventory.roles.map((role) => [role.roleId, role]));
  if (operation.approverRoleCommitments.some((approval) => {
    const role = roleDetails.get(approval.roleId);
    return role?.authorityClass !== 'RELEASE_APPROVER' ||
      !bytesEqual(role.publicIdentityCommitment, approval.identityCommitment);
  })) return false;
  if (!REQUIRED_PREREQUISITES.every((required) => operation.prerequisites.includes(required))) return false;
  if (!REQUIRED_STOP_CONDITIONS.every((required) => operation.stopConditions.includes(required))) return false;
  const cap = policy.caps.find((candidate) => matchingCap(operation, candidate));
  const assetCap = policy.aggregateAssetCaps.find((candidate) => candidate.assetId === operation.assetId);
  const sourceCap = policy.aggregateAccountCaps.find((candidate) =>
    accountCapMatches(candidate, operation.sourceAccountCommitment, operation.assetId));
  const destinationCap = policy.aggregateAccountCaps.find((candidate) =>
    accountCapMatches(candidate, operation.destinationAccountCommitment, operation.assetId));
  return cap !== undefined && assetCap !== undefined && sourceCap !== undefined && destinationCap !== undefined &&
    withinBudget(operation, cap) && withinBudget(operation, assetCap) &&
    withinBudget(operation, sourceCap) && withinBudget(operation, destinationCap);
}

function evidencePassesForRelease(
  evidence: readonly ReadinessEvidence[],
  operationHashes: readonly ManifestHash[],
  releaseHash: ManifestHash,
  inventory: AuthorityInventory,
  environment: ProtocolId,
  evaluatedAt: Expiry,
): boolean {
  const roles = new Map(inventory.roles.map((role) => [role.roleId, role]));
  return evidence.length === operationHashes.length * REQUIRED_EVIDENCE.length && operationHashes.every((operationHash) =>
    REQUIRED_EVIDENCE.every((kind) => evidence.some((item) => {
      const reviewer = roles.get(item.reviewerRoleId);
      return item.kind === kind && bytesEqual(item.fundedOperationManifestHash, operationHash) &&
        bytesEqual(item.releaseHash, releaseHash) && item.result === 'PASS' && item.environment === environment &&
        item.observedAt.unit === evaluatedAt.unit && item.expiresAt.unit === evaluatedAt.unit &&
        item.observedAt.value <= evaluatedAt.value && evaluatedAt.value < item.expiresAt.value &&
        reviewer?.authorityClass === 'RELEASE_APPROVER' &&
        bytesEqual(reviewer.publicIdentityCommitment, item.reviewerIdentityCommitment);
    })));
}

function securityReviewPasses(
  summary: SecurityFindingSummary,
  inventory: AuthorityInventory,
  releaseHash: ManifestHash,
  environment: ProtocolId,
  evaluatedAt: Expiry,
): boolean {
  const review = summary.reviewAttestation;
  const reviewer = inventory.roles.find((role) => role.roleId === review.reviewerRoleId);
  const identityIsIndependent = inventory.roles.every((role) =>
    role.roleId === review.reviewerRoleId || !bytesEqual(role.publicIdentityCommitment, review.reviewerIdentityCommitment));
  return summary.findings.length > 0 && summary.hasZeroOpenCriticalOrHigh && review.result === 'PASS' &&
    review.environment === environment && bytesEqual(review.reviewScopeHash, releaseHash) &&
    review.completedAt.unit === evaluatedAt.unit && review.expiresAt.unit === evaluatedAt.unit &&
    review.completedAt.value <= evaluatedAt.value && evaluatedAt.value < review.expiresAt.value &&
    reviewer?.authorityClass === 'SECURITY_REVIEWER' &&
    bytesEqual(reviewer.publicIdentityCommitment, review.reviewerIdentityCommitment) && identityIsIndependent;
}

export function readinessDecision(input: ReadinessDecisionInput, context = 'readinessDecision'): ReadinessDecision {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a readiness decision input');
  }
  const environment = protocolId(input.environment, `${context}.environment`);
  const releaseHash = checkedHash(input.releaseHash, `${context}.releaseHash`);
  const evaluatedAt = expiry(input.evaluatedAtUnit, input.evaluatedAtValue, `${context}.evaluatedAt`);
  const inventory = authorityInventory(input.authorityInventory, `${context}.authorityInventory`);
  const policy = operationCapPolicy(input.capPolicy, `${context}.capPolicy`);
  if (!Array.isArray(input.fundedOperations) || input.fundedOperations.length === 0) {
    throw new MalformedInputError(`${context}.fundedOperations`, 'set is empty');
  }
  const operations = canonicalByKey(input.fundedOperations.map((operation, index) =>
    fundedOperationManifest(operation, `${context}.fundedOperations[${index}]`)),
  (operation) => operation.operationId, `${context}.fundedOperations`);
  const findingSummary = securityFindingSummary(input.findingSummary, `${context}.findingSummary`);
  const operationHashes = canonicalByKey(operations.map((operation) => fundedOperationManifestHash({
    ...operation,
    validFromUnit: operation.validFrom.unit,
    validFromValue: operation.validFrom.value,
    validUntilUnit: operation.validUntil.unit,
    validUntilValue: operation.validUntil.value,
  })), toHex, `${context}.fundedOperationHashes`);
  const evidence = canonicalByKey(
    input.evidence.map((item, index) => evidenceItem(item, `${context}.evidence[${index}]`)),
    readinessEvidenceKey,
    `${context}.evidence`,
  );
  const evidencePasses = evidencePassesForRelease(evidence, operationHashes, releaseHash, inventory, environment, evaluatedAt);
  const operationsPass = operations.every((operation) =>
    operationPasses(operation, inventory, policy, evaluatedAt, environment)) &&
    aggregateOperationsPass(operations, policy);
  const reviewPasses = securityReviewPasses(findingSummary, inventory, releaseHash, environment, evaluatedAt);
  const status: ReadinessStatus = evidencePasses && operationsPass && reviewPasses
    ? 'READY'
    : 'NOT_READY';
  const inventoryHash = authorityInventoryHash(inventory);
  const capHash = operationCapPolicyHash(policy);
  const findingsHash = securityFindingSummaryHash(findingSummary);
  return Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    decisionVersion: nonzeroU32(input.decisionVersion, `${context}.decisionVersion`),
    environment,
    get releaseHash(): ManifestHash { return Uint8Array.from(releaseHash) as ManifestHash; },
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
  encodeManifestHash(writer, checkedHash(value.releaseHash, 'readinessDecision.releaseHash'));
  targetExpiry(writer, expiry(value.evaluatedAt.unit, value.evaluatedAt.value), 'readinessDecision.evaluatedAt');
  encodeManifestHash(writer, checkedHash(value.authorityInventoryHash, 'readinessDecision.authorityInventoryHash'));
  encodeManifestHash(writer, checkedHash(value.capPolicyHash, 'readinessDecision.capPolicyHash'));
  writer.writeArray(value.fundedOperationHashes, (target, hash) => encodeManifestHash(target, checkedHash(hash, 'readinessDecision.fundedOperationHash')));
  encodeManifestHash(writer, checkedHash(value.findingSummaryHash, 'readinessDecision.findingSummaryHash'));
  const evidence = canonicalByKey(value.evidence.map((item, index) => evidenceItem({
    ...item,
    observedAtUnit: item.observedAt.unit,
    observedAtValue: item.observedAt.value,
    expiresAtUnit: item.expiresAt.unit,
    expiresAtValue: item.expiresAt.value,
  }, `readinessDecision.evidence[${index}]`)), readinessEvidenceKey, 'readinessDecision.evidence');
  writer.writeArray(evidence, encodeReadinessEvidence, 'readinessDecision.evidence');
  writer.writeEnum(READINESS_STATUS, value.status, 'readinessDecision.status');
}

export function readinessDecisionBytes(value: ReadinessDecisionInput): Uint8Array {
  const checked = readinessDecision(value);
  return canonicalBytes((writer) => encodeReadinessDecision(writer, checked));
}

export function readinessDecisionHash(value: ReadinessDecisionInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.READINESS_DECISION, readinessDecisionBytes(value)), 'readinessDecisionHash');
}

export interface OperationBudgetInput {
  readonly principalAtoms: bigint;
  readonly networkFeeAtoms: bigint;
  readonly protocolFeeAtoms: bigint;
  readonly slippageAtoms: bigint;
  readonly marginAtoms: bigint;
  readonly recoveryAtoms: bigint;
  readonly lossAtoms: bigint;
}

export interface OperationBudget extends OperationBudgetInput {}

function operationBudget(input: OperationBudgetInput, context: string, requirePrincipal = false): OperationBudget {
  return Object.freeze({
    principalAtoms: atoms(input.principalAtoms, `${context}.principalAtoms`, !requirePrincipal),
    networkFeeAtoms: atoms(input.networkFeeAtoms, `${context}.networkFeeAtoms`),
    protocolFeeAtoms: atoms(input.protocolFeeAtoms, `${context}.protocolFeeAtoms`),
    slippageAtoms: atoms(input.slippageAtoms, `${context}.slippageAtoms`),
    marginAtoms: atoms(input.marginAtoms, `${context}.marginAtoms`),
    recoveryAtoms: atoms(input.recoveryAtoms, `${context}.recoveryAtoms`),
    lossAtoms: atoms(input.lossAtoms, `${context}.lossAtoms`),
  });
}

function encodeOperationBudget(writer: CanonicalWriter, value: OperationBudget, context: string): void {
  const checked = operationBudget(value, context);
  writer.writeU128(checked.principalAtoms, `${context}.principalAtoms`);
  writer.writeU128(checked.networkFeeAtoms, `${context}.networkFeeAtoms`);
  writer.writeU128(checked.protocolFeeAtoms, `${context}.protocolFeeAtoms`);
  writer.writeU128(checked.slippageAtoms, `${context}.slippageAtoms`);
  writer.writeU128(checked.marginAtoms, `${context}.marginAtoms`);
  writer.writeU128(checked.recoveryAtoms, `${context}.recoveryAtoms`);
  writer.writeU128(checked.lossAtoms, `${context}.lossAtoms`);
}

function budgetValues(value: OperationBudget): readonly bigint[] {
  return [
    value.principalAtoms,
    value.networkFeeAtoms,
    value.protocolFeeAtoms,
    value.slippageAtoms,
    value.marginAtoms,
    value.recoveryAtoms,
    value.lossAtoms,
  ];
}

function budgetEvery(
  left: OperationBudget,
  right: OperationBudget,
  predicate: (leftValue: bigint, rightValue: bigint) => boolean,
): boolean {
  const leftValues = budgetValues(left);
  const rightValues = budgetValues(right);
  return leftValues.every((value, index) => predicate(value, rightValues[index] as bigint));
}

function budgetIsZero(value: OperationBudget): boolean {
  return budgetValues(value).every((amount) => amount === 0n);
}

export interface OperationLedgerRecordInput {
  readonly schemaVersion: number;
  readonly ledgerVersion: number;
  readonly operationId: string;
  readonly fundedOperationManifestHash: Uint8Array | string;
  readonly sourceAccountCommitment: Uint8Array | string;
  readonly destinationAccountCommitment: Uint8Array | string;
  readonly assetId: string;
  readonly state: OperationLedgerState;
  readonly reserved: OperationBudgetInput;
  readonly consumed: OperationBudgetInput;
  readonly reconciled: OperationBudgetInput;
  readonly released: OperationBudgetInput;
  readonly previousRecordHash?: Uint8Array | string;
}

export interface OperationLedgerRecord {
  readonly schemaVersion: 1;
  readonly ledgerVersion: number;
  readonly operationId: ProtocolId;
  readonly fundedOperationManifestHash: ManifestHash;
  readonly sourceAccountCommitment: ManifestHash;
  readonly destinationAccountCommitment: ManifestHash;
  readonly assetId: ProtocolId;
  readonly state: OperationLedgerState;
  readonly reserved: OperationBudget;
  readonly consumed: OperationBudget;
  readonly reconciled: OperationBudget;
  readonly released: OperationBudget;
  readonly previousRecordHash?: ManifestHash;
}

function assertLedgerState(record: OperationLedgerRecord, context: string): void {
  const consumedWithinReserve = budgetEvery(record.consumed, record.reserved, (consumed, reserved) => consumed <= reserved);
  const reconciledEqualsConsumed = budgetEvery(record.reconciled, record.consumed, (reconciled, consumed) => reconciled === consumed);
  const releasedConservesReserve = budgetEvery(record.released, record.reserved, (released, reserved) => released <= reserved) &&
    budgetEvery(record.consumed, record.reserved, (consumed, reserved) => consumed <= reserved);
  if (!consumedWithinReserve) throw new MalformedInputError(context, 'consumed budget exceeds reservation');
  if (record.state === 'RESERVED' && (!budgetIsZero(record.consumed) || !budgetIsZero(record.reconciled) || !budgetIsZero(record.released))) {
    throw new MalformedInputError(context, 'reserved state has consumption, reconciliation, or release');
  }
  if (record.state === 'CONSUMED' && (budgetIsZero(record.consumed) || !budgetIsZero(record.reconciled) || !budgetIsZero(record.released))) {
    throw new MalformedInputError(context, 'consumed state has invalid amounts');
  }
  if (record.state === 'RECONCILED' && (!reconciledEqualsConsumed || !budgetIsZero(record.released))) {
    throw new MalformedInputError(context, 'reconciled state does not exactly reconcile consumption');
  }
  if (record.state === 'RELEASED') {
    const conserved = releasedConservesReserve && budgetValues(record.reserved).every((reserved, index) =>
      reserved === (budgetValues(record.consumed)[index] as bigint) + (budgetValues(record.released)[index] as bigint));
    if (!reconciledEqualsConsumed || !conserved) {
      throw new MalformedInputError(context, 'released state violates reservation conservation');
    }
  }
}

export function operationLedgerRecord(input: OperationLedgerRecordInput, context = 'operationLedgerRecord'): OperationLedgerRecord {
  enumDiscriminant(OPERATION_LEDGER_STATE, input.state, `${context}.state`);
  const manifest = checkedHash(input.fundedOperationManifestHash, `${context}.fundedOperationManifestHash`);
  const source = checkedHash(input.sourceAccountCommitment, `${context}.sourceAccountCommitment`);
  const destination = checkedHash(input.destinationAccountCommitment, `${context}.destinationAccountCommitment`);
  const previous = input.previousRecordHash === undefined
    ? undefined
    : checkedHash(input.previousRecordHash, `${context}.previousRecordHash`);
  const record: OperationLedgerRecord = Object.freeze({
    schemaVersion: fixedVersion(input.schemaVersion, `${context}.schemaVersion`),
    ledgerVersion: nonzeroU32(input.ledgerVersion, `${context}.ledgerVersion`),
    operationId: protocolId(input.operationId, `${context}.operationId`),
    get fundedOperationManifestHash(): ManifestHash { return Uint8Array.from(manifest) as ManifestHash; },
    get sourceAccountCommitment(): ManifestHash { return Uint8Array.from(source) as ManifestHash; },
    get destinationAccountCommitment(): ManifestHash { return Uint8Array.from(destination) as ManifestHash; },
    assetId: protocolId(input.assetId, `${context}.assetId`),
    state: input.state,
    reserved: operationBudget(input.reserved, `${context}.reserved`, true),
    consumed: operationBudget(input.consumed, `${context}.consumed`),
    reconciled: operationBudget(input.reconciled, `${context}.reconciled`),
    released: operationBudget(input.released, `${context}.released`),
    ...(previous === undefined ? {} : {
      get previousRecordHash(): ManifestHash { return Uint8Array.from(previous) as ManifestHash; },
    }),
  });
  if ((record.ledgerVersion === 1) !== (record.previousRecordHash === undefined)) {
    throw new MalformedInputError(context, 'only ledger version one omits the previous record hash');
  }
  if (record.ledgerVersion === 1 && record.state !== 'RESERVED') {
    throw new MalformedInputError(context, 'ledger starts in reserved state');
  }
  assertLedgerState(record, context);
  return record;
}

export function encodeOperationLedgerRecord(writer: CanonicalWriter, value: OperationLedgerRecord): void {
  const checked = operationLedgerRecord(value, 'operationLedgerRecord');
  writer.writeU32(checked.schemaVersion, 'operationLedgerRecord.schemaVersion');
  writer.writeU32(checked.ledgerVersion, 'operationLedgerRecord.ledgerVersion');
  encodeProtocolId(writer, checked.operationId, 'operationLedgerRecord.operationId');
  encodeManifestHash(writer, checked.fundedOperationManifestHash, 'operationLedgerRecord.fundedOperationManifestHash');
  encodeManifestHash(writer, checked.sourceAccountCommitment, 'operationLedgerRecord.sourceAccountCommitment');
  encodeManifestHash(writer, checked.destinationAccountCommitment, 'operationLedgerRecord.destinationAccountCommitment');
  encodeProtocolId(writer, checked.assetId, 'operationLedgerRecord.assetId');
  writer.writeEnum(OPERATION_LEDGER_STATE, checked.state, 'operationLedgerRecord.state');
  encodeOperationBudget(writer, checked.reserved, 'operationLedgerRecord.reserved');
  encodeOperationBudget(writer, checked.consumed, 'operationLedgerRecord.consumed');
  encodeOperationBudget(writer, checked.reconciled, 'operationLedgerRecord.reconciled');
  encodeOperationBudget(writer, checked.released, 'operationLedgerRecord.released');
  writer.writeOptional(checked.previousRecordHash, (target, hash) => encodeManifestHash(target, hash), 'operationLedgerRecord.previousRecordHash');
}

export function operationLedgerRecordBytes(value: OperationLedgerRecordInput): Uint8Array {
  const checked = operationLedgerRecord(value);
  return canonicalBytes((writer) => encodeOperationLedgerRecord(writer, checked));
}

export function operationLedgerRecordHash(value: OperationLedgerRecordInput): ManifestHash {
  return manifestHash(domainHash(HASH_DOMAIN.OPERATION_LEDGER_RECORD, operationLedgerRecordBytes(value)), 'operationLedgerRecordHash');
}

export function assertOperationLedgerTransition(
  previousInput: OperationLedgerRecordInput,
  nextInput: OperationLedgerRecordInput,
): OperationLedgerRecord {
  const previous = operationLedgerRecord(previousInput, 'previousOperationLedgerRecord');
  const next = operationLedgerRecord(nextInput, 'nextOperationLedgerRecord');
  const expectedPreviousHash = operationLedgerRecordHash(previousInput);
  if (next.ledgerVersion !== previous.ledgerVersion + 1 || next.previousRecordHash === undefined ||
      !bytesEqual(next.previousRecordHash, expectedPreviousHash)) {
    throw new MalformedInputError('operationLedgerTransition', 'version or previous record hash mismatch');
  }
  if (previous.operationId !== next.operationId || previous.assetId !== next.assetId ||
      !bytesEqual(previous.fundedOperationManifestHash, next.fundedOperationManifestHash) ||
      !bytesEqual(previous.sourceAccountCommitment, next.sourceAccountCommitment) ||
      !bytesEqual(previous.destinationAccountCommitment, next.destinationAccountCommitment) ||
      !budgetEvery(previous.reserved, next.reserved, (left, right) => left === right)) {
    throw new MalformedInputError('operationLedgerTransition', 'operation identity or reservation changed');
  }
  const allowed = previous.state === 'RESERVED'
    ? next.state === 'CONSUMED' || next.state === 'RELEASED'
    : previous.state === 'CONSUMED'
      ? next.state === 'CONSUMED' || next.state === 'RECONCILED'
      : previous.state === 'RECONCILED' && next.state === 'RELEASED';
  if (!allowed || !budgetEvery(previous.consumed, next.consumed, (left, right) => left <= right)) {
    throw new MalformedInputError('operationLedgerTransition', 'state transition or consumption is not monotonic');
  }
  if (previous.state === 'RESERVED' && next.state === 'RELEASED' && !budgetIsZero(next.consumed)) {
    throw new MalformedInputError('operationLedgerTransition', 'direct release cannot consume a reservation');
  }
  if ((next.state === 'RECONCILED' || previous.state === 'RECONCILED') &&
      !budgetEvery(previous.consumed, next.consumed, (left, right) => left === right)) {
    throw new MalformedInputError('operationLedgerTransition', 'consumption changed after reconciliation started');
  }
  return next;
}

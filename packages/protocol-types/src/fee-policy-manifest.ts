import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  DIRECTION,
  enumDiscriminant,
  EXPIRY_UNIT,
  QUANTITY_POLICY_CLASS,
  SETTLEMENT_CLASS,
  type Direction,
  type ExpiryUnit,
  type QuantityPolicyClass,
  type SettlementClass,
} from './enums.js';
import { MalformedInputError } from './errors.js';
import {
  canonicalPassThroughCostRules,
  canonicalServiceFeeRules,
  encodePassThroughCostRule,
  encodeServiceFeeRule,
  passThroughCostRule,
  serviceFeeRule,
  type PassThroughCostRule,
  type PassThroughCostRuleInput,
  type ServiceFeeRule,
  type ServiceFeeRuleInput,
} from './fee-policy-primitives.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainRef,
  encodeDomainRef,
  encodeProtocolId,
  expiry,
  manifestHash,
  protocolId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;
const SCHEMA_VERSION = 1;
const REFUND_POLICY_VERSION = 1;

export interface FeePolicyManifestInput {
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly scopeDirection: Direction;
  readonly scopeQuantityPolicyClass?: QuantityPolicyClass;
  readonly scopeSettlementClass?: SettlementClass;
  readonly scopeAccountModeClass?: string;
  readonly feePolicyVersion: number;
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly serviceFeeRules: readonly ServiceFeeRuleInput[];
  readonly passThroughCostRules: readonly PassThroughCostRuleInput[];
  readonly refundPolicyVersion: number;
  readonly expiryUnit?: ExpiryUnit;
  readonly expiryValue?: bigint;
}

export interface FeePolicyManifest {
  readonly schemaVersion: 1;
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly scopeDirection: Direction;
  readonly scopeQuantityPolicyClass?: QuantityPolicyClass;
  readonly scopeSettlementClass?: SettlementClass;
  readonly scopeAccountModeClass?: ProtocolId;
  readonly feePolicyVersion: number;
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly serviceFeeRules: readonly ServiceFeeRule[];
  readonly passThroughCostRules: readonly PassThroughCostRule[];
  readonly refundPolicyVersion: 1;
  readonly expiryUnit?: ExpiryUnit;
  readonly expiryValue?: bigint;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, VERSION_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function fixedVersion(value: number, expected: number, context: string): 1 {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = Number(checkedUnsigned(value, VERSION_BITS, context));
  if (checked !== expected) {
    throw new MalformedInputError(context, `version must equal ${expected}`);
  }
  return 1;
}

function canonicalDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(
      `${context}.domainManifestHash`,
      'expected 32 canonical bytes',
    );
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

interface ValidatedScope {
  readonly quantityPolicyClass?: QuantityPolicyClass;
  readonly settlementClass?: SettlementClass;
  readonly accountModeClass?: ProtocolId;
}

function validateScope(
  input: FeePolicyManifestInput,
  hasCharges: boolean,
  context: string,
): ValidatedScope {
  const hasQuantity = input.scopeQuantityPolicyClass !== undefined;
  const hasSettlement = input.scopeSettlementClass !== undefined;
  const hasAccountMode = input.scopeAccountModeClass !== undefined;
  if (!(hasQuantity === hasSettlement && hasSettlement === hasAccountMode)) {
    throw new MalformedInputError(
      context,
      'scope fields must be all present or all absent',
    );
  }
  if (!hasQuantity) {
    if (hasCharges) {
      throw new MalformedInputError(
        context,
        'an unscoped policy must have empty rule arrays',
      );
    }
    return Object.freeze({});
  }
  enumDiscriminant(
    QUANTITY_POLICY_CLASS,
    input.scopeQuantityPolicyClass as QuantityPolicyClass,
    `${context}.scopeQuantityPolicyClass`,
  );
  enumDiscriminant(
    SETTLEMENT_CLASS,
    input.scopeSettlementClass as SettlementClass,
    `${context}.scopeSettlementClass`,
  );
  return Object.freeze({
    quantityPolicyClass: input.scopeQuantityPolicyClass as QuantityPolicyClass,
    settlementClass: input.scopeSettlementClass as SettlementClass,
    accountModeClass: protocolId(
      input.scopeAccountModeClass as string,
      `${context}.scopeAccountModeClass`,
    ),
  });
}

interface ValidatedExpiry {
  readonly unit?: ExpiryUnit;
  readonly value?: bigint;
}

function validateExpiry(
  input: FeePolicyManifestInput,
  activationUnit: ExpiryUnit,
  activationValue: bigint,
  context: string,
): ValidatedExpiry {
  const hasUnit = input.expiryUnit !== undefined;
  const hasValue = input.expiryValue !== undefined;
  if (hasUnit !== hasValue) {
    throw new MalformedInputError(context, 'expiry unit and value must both be present');
  }
  if (!hasUnit) {
    return Object.freeze({});
  }
  const checked = expiry(
    input.expiryUnit as ExpiryUnit,
    input.expiryValue as bigint,
    context,
  );
  if (checked.unit !== activationUnit) {
    throw new MalformedInputError(context, 'expiry unit must equal activation unit');
  }
  if (checked.value <= activationValue) {
    throw new MalformedInputError(context, 'expiry must be greater than activation');
  }
  return Object.freeze({ unit: checked.unit, value: checked.value });
}

interface ValidatedManifest {
  readonly schemaVersion: 1;
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly scopeDirection: Direction;
  readonly scope: ValidatedScope;
  readonly feePolicyVersion: number;
  readonly activationUnit: ExpiryUnit;
  readonly activationValue: bigint;
  readonly serviceFeeRules: readonly ServiceFeeRule[];
  readonly passThroughCostRules: readonly PassThroughCostRule[];
  readonly refundPolicyVersion: 1;
  readonly expires: ValidatedExpiry;
}

function frozenManifest(value: ValidatedManifest): FeePolicyManifest {
  const common = {
    schemaVersion: value.schemaVersion,
    manifestVersion: value.manifestVersion,
    environment: value.environment,
    domain: value.domain,
    scopeDirection: value.scopeDirection,
    feePolicyVersion: value.feePolicyVersion,
    activationUnit: value.activationUnit,
    activationValue: value.activationValue,
    serviceFeeRules: value.serviceFeeRules,
    passThroughCostRules: value.passThroughCostRules,
    refundPolicyVersion: value.refundPolicyVersion,
  } as const;
  const scope = value.scope.quantityPolicyClass === undefined
    ? {}
    : {
        scopeQuantityPolicyClass: value.scope.quantityPolicyClass,
        scopeSettlementClass: value.scope.settlementClass as SettlementClass,
        scopeAccountModeClass: value.scope.accountModeClass as ProtocolId,
      };
  const expires = value.expires.unit === undefined
    ? {}
    : {
        expiryUnit: value.expires.unit,
        expiryValue: value.expires.value as bigint,
      };
  return Object.freeze({ ...common, ...scope, ...expires });
}

export function feePolicyManifest(
  input: FeePolicyManifestInput,
  context = 'feePolicyManifest',
): FeePolicyManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a fee policy manifest object');
  }
  if (!Array.isArray(input.serviceFeeRules)) {
    throw new MalformedInputError(`${context}.serviceFeeRules`, 'expected an array');
  }
  if (!Array.isArray(input.passThroughCostRules)) {
    throw new MalformedInputError(`${context}.passThroughCostRules`, 'expected an array');
  }

  enumDiscriminant(DIRECTION, input.scopeDirection, `${context}.scopeDirection`);
  const activation = expiry(
    input.activationUnit,
    input.activationValue,
    `${context}.activation`,
  );
  const serviceFeeRules = canonicalServiceFeeRules(
    input.serviceFeeRules.map((value, index) =>
      serviceFeeRule(value, `${context}.serviceFeeRules[${index}]`),
    ),
    `${context}.serviceFeeRules`,
  );
  const passThroughCostRules = canonicalPassThroughCostRules(
    input.passThroughCostRules.map((value, index) =>
      passThroughCostRule(value, `${context}.passThroughCostRules[${index}]`),
    ),
    `${context}.passThroughCostRules`,
  );
  const scope = validateScope(
    input,
    serviceFeeRules.length > 0 || passThroughCostRules.length > 0,
    context,
  );
  const expires = validateExpiry(
    input,
    activation.unit,
    activation.value,
    `${context}.expiry`,
  );

  return frozenManifest({
    schemaVersion: fixedVersion(
      input.schemaVersion,
      SCHEMA_VERSION,
      `${context}.schemaVersion`,
    ),
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    domain: canonicalDomainRef(input.domain, `${context}.domain`),
    scopeDirection: input.scopeDirection,
    scope,
    feePolicyVersion: nonzeroU32(
      input.feePolicyVersion,
      `${context}.feePolicyVersion`,
    ),
    activationUnit: activation.unit,
    activationValue: activation.value,
    serviceFeeRules,
    passThroughCostRules,
    refundPolicyVersion: fixedVersion(
      input.refundPolicyVersion,
      REFUND_POLICY_VERSION,
      `${context}.refundPolicyVersion`,
    ),
    expires,
  });
}

function checkedFeePolicyManifest(
  value: FeePolicyManifest,
  context: string,
): FeePolicyManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a fee policy manifest object');
  }
  return feePolicyManifest(
    {
      schemaVersion: value.schemaVersion,
      manifestVersion: value.manifestVersion,
      environment: value.environment,
      domain: value.domain,
      scopeDirection: value.scopeDirection,
      ...(value.scopeQuantityPolicyClass === undefined
        ? {}
        : { scopeQuantityPolicyClass: value.scopeQuantityPolicyClass }),
      ...(value.scopeSettlementClass === undefined
        ? {}
        : { scopeSettlementClass: value.scopeSettlementClass }),
      ...(value.scopeAccountModeClass === undefined
        ? {}
        : { scopeAccountModeClass: value.scopeAccountModeClass }),
      feePolicyVersion: value.feePolicyVersion,
      activationUnit: value.activationUnit,
      activationValue: value.activationValue,
      serviceFeeRules: value.serviceFeeRules,
      passThroughCostRules: value.passThroughCostRules,
      refundPolicyVersion: value.refundPolicyVersion,
      ...(value.expiryUnit === undefined ? {} : { expiryUnit: value.expiryUnit }),
      ...(value.expiryValue === undefined ? {} : { expiryValue: value.expiryValue }),
    },
    context,
  );
}

export function encodeFeePolicyManifest(
  writer: CanonicalWriter,
  value: FeePolicyManifest,
): void {
  const checked = checkedFeePolicyManifest(value, 'feePolicyManifest');
  writer.writeU32(checked.schemaVersion, 'feePolicyManifest.schemaVersion');
  writer.writeU32(checked.manifestVersion, 'feePolicyManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'feePolicyManifest.environment');
  encodeDomainRef(writer, checked.domain);
  writer.writeEnum(DIRECTION, checked.scopeDirection, 'feePolicyManifest.scopeDirection');
  writer.writeOptional(
    checked.scopeQuantityPolicyClass,
    (target, value_) =>
      target.writeEnum(
        QUANTITY_POLICY_CLASS,
        value_,
        'feePolicyManifest.scopeQuantityPolicyClass.value',
      ),
    'feePolicyManifest.scopeQuantityPolicyClass',
  );
  writer.writeOptional(
    checked.scopeSettlementClass,
    (target, value_) =>
      target.writeEnum(
        SETTLEMENT_CLASS,
        value_,
        'feePolicyManifest.scopeSettlementClass.value',
      ),
    'feePolicyManifest.scopeSettlementClass',
  );
  writer.writeOptional(
    checked.scopeAccountModeClass,
    (target, value_) =>
      encodeProtocolId(target, value_, 'feePolicyManifest.scopeAccountModeClass.value'),
    'feePolicyManifest.scopeAccountModeClass',
  );
  writer.writeU32(checked.feePolicyVersion, 'feePolicyManifest.feePolicyVersion');
  writer.writeEnum(EXPIRY_UNIT, checked.activationUnit, 'feePolicyManifest.activationUnit');
  writer.writeU64(checked.activationValue, 'feePolicyManifest.activationValue');
  writer.writeArray(
    checked.serviceFeeRules,
    encodeServiceFeeRule,
    'feePolicyManifest.serviceFeeRules',
  );
  writer.writeArray(
    checked.passThroughCostRules,
    encodePassThroughCostRule,
    'feePolicyManifest.passThroughCostRules',
  );
  writer.writeU32(
    checked.refundPolicyVersion,
    'feePolicyManifest.refundPolicyVersion',
  );
  writer.writeOptional(
    checked.expiryUnit,
    (target, value_) =>
      target.writeEnum(EXPIRY_UNIT, value_, 'feePolicyManifest.expiryUnit.value'),
    'feePolicyManifest.expiryUnit',
  );
  writer.writeOptional(
    checked.expiryValue,
    (target, value_) => target.writeU64(value_, 'feePolicyManifest.expiryValue.value'),
    'feePolicyManifest.expiryValue',
  );
}

export function feePolicyManifestBytes(value: FeePolicyManifestInput): Uint8Array {
  const checked = feePolicyManifest(value, 'feePolicyManifest');
  return canonicalBytes((writer) => encodeFeePolicyManifest(writer, checked));
}

export function feePolicyManifestHash(value: FeePolicyManifestInput): ManifestHash {
  return manifestHash(
    domainHash(
      HASH_DOMAIN.FEE_POLICY,
      feePolicyManifestBytes(value),
      'feePolicyManifestHash',
    ),
    'feePolicyManifestHash',
  );
}

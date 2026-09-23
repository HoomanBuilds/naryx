import { checkedUnsigned } from './arithmetic.js';
import { compareBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter, type ElementEncoder } from './encoding.js';
import {
  ADAPTER_ACCESS_MODE,
  ADAPTER_IDENTITY_SOURCE,
  ADAPTER_SIGNER_MODE,
  enumDiscriminant,
  SETTLEMENT_CLASS,
  type AdapterAccessMode,
  type AdapterIdentitySource,
  type AdapterSignerMode,
  type EnumTable,
  type SettlementClass,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  assetId,
  domainRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type AssetId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';
import {
  encodePackageTemplateRef,
  packageTemplateRef,
  type PackageTemplateRef,
  type PackageTemplateRefInput,
} from './registry-primitives.js';

const U32_BITS = 32;

export interface AdapterMarketRefInput {
  readonly marketId: string;
  readonly marketManifestHash: Uint8Array | string;
}

export interface AdapterMarketRef {
  readonly marketId: ProtocolId;
  readonly marketManifestHash: ManifestHash;
}

export interface AdapterAssetRefInput {
  readonly assetId: string;
  readonly assetManifestHash: Uint8Array | string;
}

export interface AdapterAssetRef {
  readonly assetId: AssetId;
  readonly assetManifestHash: ManifestHash;
}

export interface IdentityConstraintInput {
  readonly source: AdapterIdentitySource;
  readonly exactIdentity?: string;
  readonly ruleId?: string;
  readonly ruleVersion?: number;
}

export interface IdentityConstraint {
  readonly source: AdapterIdentitySource;
  readonly exactIdentity?: ProtocolId;
  readonly ruleId?: ProtocolId;
  readonly ruleVersion?: number;
}

export interface SignerRuleInput {
  readonly mode: AdapterSignerMode;
  readonly schemeId?: string;
}

export interface SignerRule {
  readonly mode: AdapterSignerMode;
  readonly schemeId?: ProtocolId;
}

export interface AccountAndAuthorityBindingInput {
  readonly bindingId: string;
  readonly accountRole: string;
  readonly accountIdentity: IdentityConstraintInput;
  readonly codeIdentity?: IdentityConstraintInput;
  readonly ownerIdentity?: IdentityConstraintInput;
  readonly accessModes: readonly AdapterAccessMode[];
  readonly authorityRole: string;
  readonly authorityIdentity: IdentityConstraintInput;
  readonly signerRule: SignerRuleInput;
}

export interface AccountAndAuthorityBinding {
  readonly bindingId: ProtocolId;
  readonly accountRole: ProtocolId;
  readonly accountIdentity: IdentityConstraint;
  readonly codeIdentity?: IdentityConstraint;
  readonly ownerIdentity?: IdentityConstraint;
  readonly accessModes: readonly AdapterAccessMode[];
  readonly authorityRole: ProtocolId;
  readonly authorityIdentity: IdentityConstraint;
  readonly signerRule: SignerRule;
}

export interface AdapterManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly adapterId: string;
  readonly adapterClass: string;
  readonly adapterClassVersion: number;
  readonly domain: DomainRef;
  readonly venueId: string;
  readonly venueManifestHash: Uint8Array | string;
  readonly codeIdentity: string;
  readonly supportedMarkets: readonly AdapterMarketRefInput[];
  readonly supportedAssets: readonly AdapterAssetRefInput[];
  readonly supportedLegTypes: readonly string[];
  readonly supportedSettlementClasses: readonly SettlementClass[];
  readonly supportedTemplates: readonly PackageTemplateRefInput[];
  readonly accountAndAuthorityMap: readonly AccountAndAuthorityBindingInput[];
  readonly accountingSchemaHash: Uint8Array | string;
}

export interface AdapterManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly adapterId: ProtocolId;
  readonly adapterClass: ProtocolId;
  readonly adapterClassVersion: number;
  readonly domain: DomainRef;
  readonly venueId: ProtocolId;
  readonly venueManifestHash: ManifestHash;
  readonly codeIdentity: ProtocolId;
  readonly supportedMarkets: readonly AdapterMarketRef[];
  readonly supportedAssets: readonly AdapterAssetRef[];
  readonly supportedLegTypes: readonly ProtocolId[];
  readonly supportedSettlementClasses: readonly SettlementClass[];
  readonly supportedTemplates: readonly PackageTemplateRef[];
  readonly accountAndAuthorityMap: readonly AccountAndAuthorityBinding[];
  readonly accountingSchemaHash: ManifestHash;
}

interface CanonicalEntry<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) throw new MalformedInputError(context, 'version is zero');
  return Number(checked);
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function canonicalDomainRef(value: DomainRef, context: string): DomainRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain reference object');
  }
  if (!(value.domainManifestHash instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.domainManifestHash`, 'expected 32 canonical bytes');
  }
  return domainRef(
    value.domainId,
    value.domainManifestVersion,
    value.domainManifestHash,
    context,
  );
}

function canonicalSet<T>(
  values: readonly T[],
  validate: (value: T, context: string) => T,
  encode: ElementEncoder<T>,
  context: string,
  requireNonempty = false,
): readonly T[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  if (requireNonempty && values.length === 0) {
    throw new MalformedInputError(context, 'set is empty');
  }
  const entries: CanonicalEntry<T>[] = values.map((value, index) => {
    const checked = validate(value, `${context}[${index}]`);
    return { value: checked, bytes: canonicalBytes((writer) => encode(writer, checked)) };
  });
  entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.bytes, entries[index]!.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate canonical element at sorted index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function canonicalEnumSet<Name extends string>(
  values: readonly Name[],
  table: EnumTable<Name>,
  context: string,
  requireNonempty = false,
): readonly Name[] {
  return canonicalSet(
    values,
    (value, itemContext) => {
      enumDiscriminant(table, value, itemContext);
      return value;
    },
    (writer, value) => writer.writeEnum(table, value, context),
    context,
    requireNonempty,
  );
}

function frozenAdapterMarketRef(
  marketId: ProtocolId,
  capturedHash: ManifestHash,
): AdapterMarketRef {
  return Object.freeze({
    marketId,
    get marketManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
  });
}

function adapterMarketRef(
  input: AdapterMarketRefInput,
  context: string,
): AdapterMarketRef {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a manifest subject reference object');
  }
  return frozenAdapterMarketRef(
    protocolId(input.marketId, `${context}.marketId`),
    manifestHash(input.marketManifestHash, `${context}.marketManifestHash`),
  );
}

function checkedAdapterMarketRef(
  value: AdapterMarketRef,
  context: string,
): AdapterMarketRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a manifest subject reference object');
  }
  return frozenAdapterMarketRef(
    protocolId(value.marketId, `${context}.marketId`),
    canonicalManifestHash(value.marketManifestHash, `${context}.marketManifestHash`),
  );
}

export function encodeAdapterMarketRef(
  writer: CanonicalWriter,
  value: AdapterMarketRef,
): void {
  const checked = checkedAdapterMarketRef(value, 'adapterMarketRef');
  encodeProtocolId(writer, checked.marketId, 'adapterMarketRef.marketId');
  encodeManifestHash(writer, checked.marketManifestHash, 'adapterMarketRef.marketManifestHash');
}

function frozenAdapterAssetRef(
  id: AssetId,
  capturedHash: ManifestHash,
): AdapterAssetRef {
  return Object.freeze({
    assetId: id,
    get assetManifestHash(): ManifestHash {
      return Uint8Array.from(capturedHash) as ManifestHash;
    },
  });
}

function adapterAssetRef(input: AdapterAssetRefInput, context: string): AdapterAssetRef {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an adapter asset reference object');
  }
  return frozenAdapterAssetRef(
    assetId(input.assetId, `${context}.assetId`),
    manifestHash(input.assetManifestHash, `${context}.assetManifestHash`),
  );
}

function checkedAdapterAssetRef(value: AdapterAssetRef, context: string): AdapterAssetRef {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an adapter asset reference object');
  }
  return frozenAdapterAssetRef(
    assetId(value.assetId, `${context}.assetId`),
    canonicalManifestHash(value.assetManifestHash, `${context}.assetManifestHash`),
  );
}

export function encodeAdapterAssetRef(writer: CanonicalWriter, value: AdapterAssetRef): void {
  const checked = checkedAdapterAssetRef(value, 'adapterAssetRef');
  encodeProtocolId(writer, checked.assetId, 'adapterAssetRef.assetId');
  encodeManifestHash(writer, checked.assetManifestHash, 'adapterAssetRef.assetManifestHash');
}

export function identityConstraint(
  input: IdentityConstraintInput,
  context = 'identityConstraint',
): IdentityConstraint {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an identity constraint object');
  }
  enumDiscriminant(ADAPTER_IDENTITY_SOURCE, input.source, `${context}.source`);
  if (input.source === 'EXACT') {
    if (input.exactIdentity === undefined) {
      throw new MalformedInputError(context, 'EXACT requires exactIdentity');
    }
    if (input.ruleId !== undefined || input.ruleVersion !== undefined) {
      throw new MalformedInputError(context, 'EXACT forbids rule fields');
    }
    return Object.freeze({
      source: input.source,
      exactIdentity: protocolId(input.exactIdentity, `${context}.exactIdentity`),
    });
  }
  if (input.exactIdentity !== undefined) {
    throw new MalformedInputError(context, 'derived identity forbids exactIdentity');
  }
  if (input.ruleId === undefined || input.ruleVersion === undefined) {
    throw new MalformedInputError(context, 'derived identity requires ruleId and ruleVersion');
  }
  return Object.freeze({
    source: input.source,
    ruleId: protocolId(input.ruleId, `${context}.ruleId`),
    ruleVersion: nonzeroU32(input.ruleVersion, `${context}.ruleVersion`),
  });
}

function checkedIdentityConstraint(value: IdentityConstraint, context: string): IdentityConstraint {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an identity constraint object');
  }
  return identityConstraint(
    {
      source: value.source,
      ...(value.exactIdentity === undefined ? {} : { exactIdentity: value.exactIdentity }),
      ...(value.ruleId === undefined ? {} : { ruleId: value.ruleId }),
      ...(value.ruleVersion === undefined ? {} : { ruleVersion: value.ruleVersion }),
    },
    context,
  );
}

export function encodeIdentityConstraint(
  writer: CanonicalWriter,
  value: IdentityConstraint,
): void {
  const checked = checkedIdentityConstraint(value, 'identityConstraint');
  writer.writeEnum(ADAPTER_IDENTITY_SOURCE, checked.source, 'identityConstraint.source');
  writer.writeOptional(
    checked.exactIdentity,
    (target, identity) => encodeProtocolId(target, identity, 'identityConstraint.exactIdentity.value'),
    'identityConstraint.exactIdentity',
  );
  writer.writeOptional(
    checked.ruleId,
    (target, id) => encodeProtocolId(target, id, 'identityConstraint.ruleId.value'),
    'identityConstraint.ruleId',
  );
  writer.writeOptional(
    checked.ruleVersion,
    (target, version) => target.writeU32(version, 'identityConstraint.ruleVersion.value'),
    'identityConstraint.ruleVersion',
  );
}

export function signerRule(input: SignerRuleInput, context = 'signerRule'): SignerRule {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a signer rule object');
  }
  enumDiscriminant(ADAPTER_SIGNER_MODE, input.mode, `${context}.mode`);
  if (input.mode === 'NONE') {
    if (input.schemeId !== undefined) {
      throw new MalformedInputError(context, 'NONE forbids schemeId');
    }
    return Object.freeze({ mode: input.mode });
  }
  if (input.schemeId === undefined) {
    throw new MalformedInputError(context, 'signing mode requires schemeId');
  }
  return Object.freeze({
    mode: input.mode,
    schemeId: protocolId(input.schemeId, `${context}.schemeId`),
  });
}

function checkedSignerRule(value: SignerRule, context: string): SignerRule {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a signer rule object');
  }
  return signerRule(
    {
      mode: value.mode,
      ...(value.schemeId === undefined ? {} : { schemeId: value.schemeId }),
    },
    context,
  );
}

export function encodeSignerRule(writer: CanonicalWriter, value: SignerRule): void {
  const checked = checkedSignerRule(value, 'signerRule');
  writer.writeEnum(ADAPTER_SIGNER_MODE, checked.mode, 'signerRule.mode');
  writer.writeOptional(
    checked.schemeId,
    (target, schemeId) => encodeProtocolId(target, schemeId, 'signerRule.schemeId.value'),
    'signerRule.schemeId',
  );
}

export function accountAndAuthorityBinding(
  input: AccountAndAuthorityBindingInput,
  context = 'accountAndAuthorityBinding',
): AccountAndAuthorityBinding {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an account and authority binding object');
  }
  return Object.freeze({
    bindingId: protocolId(input.bindingId, `${context}.bindingId`),
    accountRole: protocolId(input.accountRole, `${context}.accountRole`),
    accountIdentity: identityConstraint(input.accountIdentity, `${context}.accountIdentity`),
    ...(input.codeIdentity === undefined
      ? {}
      : { codeIdentity: identityConstraint(input.codeIdentity, `${context}.codeIdentity`) }),
    ...(input.ownerIdentity === undefined
      ? {}
      : { ownerIdentity: identityConstraint(input.ownerIdentity, `${context}.ownerIdentity`) }),
    accessModes: canonicalEnumSet(
      input.accessModes,
      ADAPTER_ACCESS_MODE,
      `${context}.accessModes`,
      true,
    ),
    authorityRole: protocolId(input.authorityRole, `${context}.authorityRole`),
    authorityIdentity: identityConstraint(
      input.authorityIdentity,
      `${context}.authorityIdentity`,
    ),
    signerRule: signerRule(input.signerRule, `${context}.signerRule`),
  });
}

function checkedAccountAndAuthorityBinding(
  value: AccountAndAuthorityBinding,
  context: string,
): AccountAndAuthorityBinding {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an account and authority binding object');
  }
  return accountAndAuthorityBinding(
    {
      bindingId: value.bindingId,
      accountRole: value.accountRole,
      accountIdentity: value.accountIdentity,
      ...(value.codeIdentity === undefined ? {} : { codeIdentity: value.codeIdentity }),
      ...(value.ownerIdentity === undefined ? {} : { ownerIdentity: value.ownerIdentity }),
      accessModes: value.accessModes,
      authorityRole: value.authorityRole,
      authorityIdentity: value.authorityIdentity,
      signerRule: value.signerRule,
    },
    context,
  );
}

export function encodeAccountAndAuthorityBinding(
  writer: CanonicalWriter,
  value: AccountAndAuthorityBinding,
): void {
  const checked = checkedAccountAndAuthorityBinding(value, 'accountAndAuthorityBinding');
  encodeProtocolId(writer, checked.bindingId, 'accountAndAuthorityBinding.bindingId');
  encodeProtocolId(writer, checked.accountRole, 'accountAndAuthorityBinding.accountRole');
  encodeIdentityConstraint(writer, checked.accountIdentity);
  writer.writeOptional(
    checked.codeIdentity,
    encodeIdentityConstraint,
    'accountAndAuthorityBinding.codeIdentity',
  );
  writer.writeOptional(
    checked.ownerIdentity,
    encodeIdentityConstraint,
    'accountAndAuthorityBinding.ownerIdentity',
  );
  writer.writeArray(
    checked.accessModes,
    (target, mode) =>
      target.writeEnum(ADAPTER_ACCESS_MODE, mode, 'accountAndAuthorityBinding.accessModes.element'),
    'accountAndAuthorityBinding.accessModes',
  );
  encodeProtocolId(writer, checked.authorityRole, 'accountAndAuthorityBinding.authorityRole');
  encodeIdentityConstraint(writer, checked.authorityIdentity);
  encodeSignerRule(writer, checked.signerRule);
}

function canonicalBindings(
  values: readonly AccountAndAuthorityBindingInput[],
  context: string,
): readonly AccountAndAuthorityBinding[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  if (values.length === 0) throw new MalformedInputError(context, 'binding map is empty');
  const entries = values.map((value, index) => {
    const checked = accountAndAuthorityBinding(value, `${context}[${index}]`);
    return {
      value: checked,
      key: canonicalBytes((writer) =>
        encodeProtocolId(writer, checked.bindingId, `${context}[${index}].bindingId`),
      ),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    const relation = compareBytes(entries[index - 1]!.key, entries[index]!.key);
    if (relation === 0) {
      throw new DuplicateElementError(context, `duplicate bindingId at index ${index}`);
    }
    if (relation > 0) {
      throw new MalformedInputError(context, `noncanonical binding order at index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function checkedBindings(
  values: readonly AccountAndAuthorityBinding[],
  context: string,
): readonly AccountAndAuthorityBinding[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  return canonicalBindings(
    values.map((value) => value as AccountAndAuthorityBindingInput),
    context,
  );
}

function canonicalProtocolIds(values: readonly string[], context: string): readonly ProtocolId[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  const entries = values.map((value, index) => {
    const checked = protocolId(value, `${context}[${index}]`);
    return {
      value: checked,
      bytes: canonicalBytes((writer) => encodeProtocolId(writer, checked, context)),
    };
  });
  entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareBytes(entries[index - 1]!.bytes, entries[index]!.bytes) === 0) {
      throw new DuplicateElementError(context, `duplicate canonical element at sorted index ${index}`);
    }
  }
  return Object.freeze(entries.map((entry) => entry.value));
}

function canonicalAdapterMarkets(
  values: readonly AdapterMarketRefInput[],
  context: string,
): readonly AdapterMarketRef[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  return canonicalSet(
    values.map((value, index) => adapterMarketRef(value, `${context}[${index}]`)),
    checkedAdapterMarketRef,
    encodeAdapterMarketRef,
    context,
  );
}

function canonicalAdapterAssets(
  values: readonly AdapterAssetRefInput[],
  context: string,
): readonly AdapterAssetRef[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  return canonicalSet(
    values.map((value, index) => adapterAssetRef(value, `${context}[${index}]`)),
    checkedAdapterAssetRef,
    encodeAdapterAssetRef,
    context,
  );
}

function canonicalTemplates(
  values: readonly PackageTemplateRefInput[],
  context: string,
): readonly PackageTemplateRef[] {
  if (!Array.isArray(values)) throw new MalformedInputError(context, 'expected an array');
  return canonicalSet(
    values.map((value, index) => packageTemplateRef(value, `${context}[${index}]`)),
    (value, itemContext) =>
      packageTemplateRef(
        {
          templateId: value.templateId,
          templateVersion: value.templateVersion,
          packageTemplateManifestHash: value.packageTemplateManifestHash,
        },
        itemContext,
      ),
    encodePackageTemplateRef,
    context,
  );
}

function copiedHash(value: ManifestHash): ManifestHash {
  return Uint8Array.from(value) as ManifestHash;
}

export function adapterManifest(
  input: AdapterManifestInput,
  context = 'adapterManifest',
): AdapterManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected an adapter manifest object');
  }
  const venueManifestHash = manifestHash(input.venueManifestHash, `${context}.venueManifestHash`);
  const accountingSchemaHash = manifestHash(
    input.accountingSchemaHash,
    `${context}.accountingSchemaHash`,
  );
  const domain = canonicalDomainRef(input.domain, `${context}.domain`);
  const supportedMarkets = canonicalAdapterMarkets(
    input.supportedMarkets,
    `${context}.supportedMarkets`,
  );
  const supportedAssets = canonicalAdapterAssets(
    input.supportedAssets,
    `${context}.supportedAssets`,
  );
  const supportedTemplates = canonicalTemplates(
    input.supportedTemplates,
    `${context}.supportedTemplates`,
  );
  const accountAndAuthorityMap = canonicalBindings(
    input.accountAndAuthorityMap,
    `${context}.accountAndAuthorityMap`,
  );
  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    adapterId: protocolId(input.adapterId, `${context}.adapterId`),
    adapterClass: protocolId(input.adapterClass, `${context}.adapterClass`),
    adapterClassVersion: nonzeroU32(
      input.adapterClassVersion,
      `${context}.adapterClassVersion`,
    ),
    domain,
    venueId: protocolId(input.venueId, `${context}.venueId`),
    get venueManifestHash(): ManifestHash {
      return copiedHash(venueManifestHash);
    },
    codeIdentity: protocolId(input.codeIdentity, `${context}.codeIdentity`),
    supportedMarkets,
    supportedAssets,
    supportedLegTypes: canonicalProtocolIds(
      input.supportedLegTypes,
      `${context}.supportedLegTypes`,
    ),
    supportedSettlementClasses: canonicalEnumSet(
      input.supportedSettlementClasses,
      SETTLEMENT_CLASS,
      `${context}.supportedSettlementClasses`,
    ),
    supportedTemplates,
    accountAndAuthorityMap,
    get accountingSchemaHash(): ManifestHash {
      return copiedHash(accountingSchemaHash);
    },
  });
}

function checkedAdapterManifest(value: AdapterManifest, context: string): AdapterManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an adapter manifest object');
  }
  return adapterManifest(
    {
      ...value,
      venueManifestHash: canonicalManifestHash(
        value.venueManifestHash,
        `${context}.venueManifestHash`,
      ),
      supportedMarkets: value.supportedMarkets.map((entry) => ({
        marketId: entry.marketId,
        marketManifestHash: canonicalManifestHash(
          entry.marketManifestHash,
          `${context}.supportedMarkets.marketManifestHash`,
        ),
      })),
      supportedAssets: value.supportedAssets.map((entry) => ({
        assetId: entry.assetId,
        assetManifestHash: canonicalManifestHash(
          entry.assetManifestHash,
          `${context}.supportedAssets.assetManifestHash`,
        ),
      })),
      supportedTemplates: value.supportedTemplates.map((entry) => ({
        templateId: entry.templateId,
        templateVersion: entry.templateVersion,
        packageTemplateManifestHash: canonicalManifestHash(
          entry.packageTemplateManifestHash,
          `${context}.supportedTemplates.packageTemplateManifestHash`,
        ),
      })),
      accountAndAuthorityMap: checkedBindings(
        value.accountAndAuthorityMap,
        `${context}.accountAndAuthorityMap`,
      ),
      accountingSchemaHash: canonicalManifestHash(
        value.accountingSchemaHash,
        `${context}.accountingSchemaHash`,
      ),
    },
    context,
  );
}

export function encodeAdapterManifest(writer: CanonicalWriter, value: AdapterManifest): void {
  const checked = checkedAdapterManifest(value, 'adapterManifest');
  writer.writeU32(checked.manifestVersion, 'adapterManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'adapterManifest.environment');
  encodeProtocolId(writer, checked.adapterId, 'adapterManifest.adapterId');
  encodeProtocolId(writer, checked.adapterClass, 'adapterManifest.adapterClass');
  writer.writeU32(checked.adapterClassVersion, 'adapterManifest.adapterClassVersion');
  encodeDomainRef(writer, checked.domain);
  encodeProtocolId(writer, checked.venueId, 'adapterManifest.venueId');
  encodeManifestHash(writer, checked.venueManifestHash, 'adapterManifest.venueManifestHash');
  encodeProtocolId(writer, checked.codeIdentity, 'adapterManifest.codeIdentity');
  writer.writeArray(checked.supportedMarkets, encodeAdapterMarketRef, 'adapterManifest.supportedMarkets');
  writer.writeArray(checked.supportedAssets, encodeAdapterAssetRef, 'adapterManifest.supportedAssets');
  writer.writeArray(
    checked.supportedLegTypes,
    (target, legType) => encodeProtocolId(target, legType, 'adapterManifest.supportedLegTypes.element'),
    'adapterManifest.supportedLegTypes',
  );
  writer.writeArray(
    checked.supportedSettlementClasses,
    (target, settlementClass) =>
      target.writeEnum(SETTLEMENT_CLASS, settlementClass, 'adapterManifest.supportedSettlementClasses.element'),
    'adapterManifest.supportedSettlementClasses',
  );
  writer.writeArray(checked.supportedTemplates, encodePackageTemplateRef, 'adapterManifest.supportedTemplates');
  writer.writeArray(
    checked.accountAndAuthorityMap,
    encodeAccountAndAuthorityBinding,
    'adapterManifest.accountAndAuthorityMap',
  );
  encodeManifestHash(writer, checked.accountingSchemaHash, 'adapterManifest.accountingSchemaHash');
}

export function adapterManifestBytes(value: AdapterManifestInput): Uint8Array {
  const checked = adapterManifest(value, 'adapterManifest');
  return canonicalBytes((writer) => encodeAdapterManifest(writer, checked));
}

export function adapterManifestHash(value: AdapterManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.ADAPTER_MANIFEST, adapterManifestBytes(value), 'adapterManifestHash'),
    'adapterManifestHash',
  );
}

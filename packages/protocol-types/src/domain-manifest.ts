import { checkedUnsigned } from './arithmetic.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import { enumDiscriminant, SETTLEMENT_CLASS, type SettlementClass } from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import {
  domainId,
  domainRef,
  encodeManifestHash,
  encodeProtocolId,
  manifestHash,
  protocolId,
  type DomainId,
  type DomainRef,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION_BITS = 32;

export interface DomainManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly domainId: string;
  readonly runtimeClassId: string;
  readonly runtimeClassVersion: number;
  readonly chainNamespace: string;
  readonly chainReference: string;
  readonly executionVerifierId: string;
  readonly executionVerifierCodeHash: Uint8Array | string;
  readonly clockModelId: string;
  readonly finalityPolicyHash: Uint8Array | string;
  readonly addressCodecId: string;
  readonly supportedSettlementClasses: readonly SettlementClass[];
}

export interface DomainManifest {
  readonly manifestVersion: number;
  readonly environment: ProtocolId;
  readonly domainId: DomainId;
  readonly runtimeClassId: ProtocolId;
  readonly runtimeClassVersion: number;
  readonly chainNamespace: ProtocolId;
  readonly chainReference: ProtocolId;
  readonly executionVerifierId: ProtocolId;
  readonly executionVerifierCodeHash: ManifestHash;
  readonly clockModelId: ProtocolId;
  readonly finalityPolicyHash: ManifestHash;
  readonly addressCodecId: ProtocolId;
  readonly supportedSettlementClasses: readonly SettlementClass[];
}

function nonzeroU32(value: number, context: string): number {
  const checked = checkedUnsigned(value, VERSION_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function canonicalSettlementClasses(
  values: readonly SettlementClass[],
  context: string,
): readonly SettlementClass[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  if (values.length === 0) {
    throw new MalformedInputError(context, 'settlement class set is empty');
  }

  const entries = values
    .map((value, index) => ({
      value,
      discriminant: enumDiscriminant(SETTLEMENT_CLASS, value, `${context}[${index}]`),
    }))
    .sort((left, right) => left.discriminant - right.discriminant);

  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.discriminant === entries[index]?.discriminant) {
      throw new DuplicateElementError(context, `duplicate settlement class at sorted index ${index}`);
    }
  }

  return Object.freeze(entries.map((entry) => entry.value));
}

export function domainManifest(
  input: DomainManifestInput,
  context = 'domainManifest',
): DomainManifest {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError(context, 'expected a domain manifest object');
  }

  const executionVerifierCodeHash = manifestHash(
    input.executionVerifierCodeHash,
    `${context}.executionVerifierCodeHash`,
  );
  const finalityPolicyHash = manifestHash(
    input.finalityPolicyHash,
    `${context}.finalityPolicyHash`,
  );
  const supportedSettlementClasses = canonicalSettlementClasses(
    input.supportedSettlementClasses,
    `${context}.supportedSettlementClasses`,
  );

  return Object.freeze({
    manifestVersion: nonzeroU32(input.manifestVersion, `${context}.manifestVersion`),
    environment: protocolId(input.environment, `${context}.environment`),
    domainId: domainId(input.domainId, `${context}.domainId`),
    runtimeClassId: protocolId(input.runtimeClassId, `${context}.runtimeClassId`),
    runtimeClassVersion: nonzeroU32(
      input.runtimeClassVersion,
      `${context}.runtimeClassVersion`,
    ),
    chainNamespace: protocolId(input.chainNamespace, `${context}.chainNamespace`),
    chainReference: protocolId(input.chainReference, `${context}.chainReference`),
    executionVerifierId: protocolId(
      input.executionVerifierId,
      `${context}.executionVerifierId`,
    ),
    get executionVerifierCodeHash(): ManifestHash {
      return Uint8Array.from(executionVerifierCodeHash) as ManifestHash;
    },
    clockModelId: protocolId(input.clockModelId, `${context}.clockModelId`),
    get finalityPolicyHash(): ManifestHash {
      return Uint8Array.from(finalityPolicyHash) as ManifestHash;
    },
    addressCodecId: protocolId(input.addressCodecId, `${context}.addressCodecId`),
    supportedSettlementClasses,
  });
}

function canonicalManifestHash(value: ManifestHash, context: string): ManifestHash {
  if (!(value instanceof Uint8Array)) {
    throw new MalformedInputError(context, 'expected 32 canonical bytes');
  }
  return manifestHash(value, context);
}

function checkedDomainManifest(value: DomainManifest, context: string): DomainManifest {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected a domain manifest object');
  }
  return domainManifest(
    {
      ...value,
      executionVerifierCodeHash: canonicalManifestHash(
        value.executionVerifierCodeHash,
        `${context}.executionVerifierCodeHash`,
      ),
      finalityPolicyHash: canonicalManifestHash(
        value.finalityPolicyHash,
        `${context}.finalityPolicyHash`,
      ),
    },
    context,
  );
}

export function encodeDomainManifest(writer: CanonicalWriter, value: DomainManifest): void {
  const checked = checkedDomainManifest(value, 'domainManifest');
  writer.writeU32(checked.manifestVersion, 'domainManifest.manifestVersion');
  encodeProtocolId(writer, checked.environment, 'domainManifest.environment');
  encodeProtocolId(writer, checked.domainId, 'domainManifest.domainId');
  encodeProtocolId(writer, checked.runtimeClassId, 'domainManifest.runtimeClassId');
  writer.writeU32(checked.runtimeClassVersion, 'domainManifest.runtimeClassVersion');
  encodeProtocolId(writer, checked.chainNamespace, 'domainManifest.chainNamespace');
  encodeProtocolId(writer, checked.chainReference, 'domainManifest.chainReference');
  encodeProtocolId(writer, checked.executionVerifierId, 'domainManifest.executionVerifierId');
  encodeManifestHash(
    writer,
    checked.executionVerifierCodeHash,
    'domainManifest.executionVerifierCodeHash',
  );
  encodeProtocolId(writer, checked.clockModelId, 'domainManifest.clockModelId');
  encodeManifestHash(writer, checked.finalityPolicyHash, 'domainManifest.finalityPolicyHash');
  encodeProtocolId(writer, checked.addressCodecId, 'domainManifest.addressCodecId');
  writer.writeSet(
    checked.supportedSettlementClasses,
    (target, settlementClass) =>
      target.writeEnum(
        SETTLEMENT_CLASS,
        settlementClass,
        'domainManifest.supportedSettlementClasses.element',
      ),
    'domainManifest.supportedSettlementClasses',
  );
}

export function domainManifestBytes(value: DomainManifestInput): Uint8Array {
  const checked = domainManifest(value, 'domainManifest');
  return canonicalBytes((writer) => encodeDomainManifest(writer, checked));
}

export function domainManifestHash(value: DomainManifestInput): ManifestHash {
  return manifestHash(
    domainHash(HASH_DOMAIN.DOMAIN_MANIFEST, domainManifestBytes(value), 'domainManifestHash'),
    'domainManifestHash',
  );
}

export function domainRefFromManifest(value: DomainManifestInput): DomainRef {
  const checked = domainManifest(value, 'domainManifest');
  return domainRef(
    checked.domainId,
    checked.manifestVersion,
    domainManifestHash(checked),
    'domainManifestRef',
  );
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('package root not found');
    }
    directory = parent;
  }
  return directory;
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(packageRoot(), 'fixtures', name), 'utf8')) as T;
}

export interface EncodingVector {
  name: string;
  kind: string;
  bits?: number;
  length?: number;
  value?: string | boolean;
  valueHex?: string;
  valueCodeUnits?: string[];
  values?: string[];
  subjectId?: string;
  manifestVersion?: string;
  manifestHash?: string;
  domainId?: string;
  domainManifestVersion?: string;
  domainManifestHash?: string;
  assetId?: string;
  assetManifestHash?: string;
  decimals?: number;
  atoms?: string;
  hex: string;
}

export interface EncodingFixture {
  encoding: string;
  vectors: EncodingVector[];
}

export interface HashingVector {
  name: string;
  domain: string;
  payloadHex: string;
  digestHex: string;
}

export interface HashingFixture {
  algorithm: string;
  vectors: HashingVector[];
  domainSeparationPayloadHex: string;
}

export interface DomainManifestFixture {
  manifestVersion: string;
  environment: string;
  domainId: string;
  runtimeClassId: string;
  runtimeClassVersion: string;
  chainNamespace: string;
  chainReference: string;
  executionVerifierId: string;
  executionVerifierCodeHash: string;
  clockModelId: string;
  finalityPolicyHash: string;
  addressCodecId: string;
  supportedSettlementClasses: string[];
  canonicalHex: string;
  digestHex: string;
}

export interface AssetManifestFixture {
  manifestVersion: string;
  environment: string;
  assetId: string;
  economicAssetId: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  tokenIdentity: string;
  decimals: number;
  atomUnitName: string;
  minimumTransferAtoms: string;
  transferSemantics: string;
  canonicalHex: string;
  digestHex: string;
}

export interface RoundingExpectation {
  FLOOR: string;
  CEIL: string;
  TOWARD_ZERO: string;
  AWAY_FROM_ZERO: string;
}

export interface MulDivVector {
  name: string;
  left: string;
  right: string;
  divisor: string;
  expected: RoundingExpectation;
}

export interface ScaleVector {
  name: string;
  value: string;
  fromDecimals: number;
  toDecimals: number;
  expected: RoundingExpectation;
}

export interface ArithmeticFixture {
  roundingModes: (keyof RoundingExpectation)[];
  mulDiv: MulDivVector[];
  scaleDecimals: ScaleVector[];
}

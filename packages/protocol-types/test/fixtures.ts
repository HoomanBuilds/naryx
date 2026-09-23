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

export interface VenueManifestFixture {
  manifestVersion: string;
  environment: string;
  venueId: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  venueKind: string;
  protocolIdentity: string;
  codeIdentity: string;
  authorityIdentity: string;
  canonicalHex: string;
  digestHex: string;
}

export interface PriceSourceManifestFixture {
  manifestVersion: string;
  environment: string;
  priceSourceId: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  sourceKind: string;
  feedIdentity: string;
  priceDecimals: number;
  priceConvention: string;
  maxStaleness: {
    unit: string;
    value: string;
  };
  fallbackRule: string;
  canonicalHex: string;
  digestHex: string;
}

export interface MarketManifestFixture {
  manifestVersion: string;
  environment: string;
  marketId: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  venueId: string;
  venueManifestHash: string;
  marketIdentity: string;
  instrumentKind: string;
  baseAssetId: string;
  baseAssetManifestHash: string;
  quoteAssetId: string;
  quoteAssetManifestHash: string;
  baseLotSize: {
    baseAssetId: string;
    baseAssetManifestHash: string;
    baseDecimals: number;
    atoms: string;
  };
  priceTick: {
    quoteAssetId: string;
    quoteAssetManifestHash: string;
    quoteDecimals: number;
    quoteAtoms: string;
    baseLotCount: string;
  };
  minimumNotional: {
    quoteAssetId: string;
    quoteAssetManifestHash: string;
    quoteDecimals: number;
    atoms: string;
  };
  contractMultiplier: {
    numerator: string;
    denominator: string;
    unitConvention: string;
  };
  permittedPriceSources: {
    priceSourceId: string;
    priceSourceManifestHash: string;
  }[];
  canonicalHex: string;
  digestHex: string;
}

export interface PackageTemplateManifestFixture {
  manifestVersion: string;
  environment: string;
  templateId: string;
  templateVersion: string;
  supportedDomains: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  }[];
  orderSchemaHash: string;
  quoteSchemaHash: string;
  routeSchemaHash: string;
  receiptSchemaHash: string;
  entryCompilerVersion: string;
  exitCompilerVersion: string;
  legCount: string;
  legTypes: string[];
  supportedDirections: string[];
  supportedSettlementClasses: string[];
  allowedSpotAdapterIds: string[];
  allowedPerpAdapterIds: string[];
  riskPolicyHash: string;
  canonicalHex: string;
  digestHex: string;
}

export interface PackageTemplateRegistryRecordFixture {
  recordVersion: string;
  environment: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  templateId: string;
  templateVersion: string;
  packageTemplateManifestHash: string;
  registryState: string;
  activationUnit: string;
  activationValue: string;
  governanceReference: string;
  canonicalHex: string;
  digestHex: string;
}

export interface AdapterManifestFixture {
  manifestVersion: string;
  environment: string;
  adapterId: string;
  adapterClass: string;
  adapterClassVersion: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  venueId: string;
  venueManifestHash: string;
  codeIdentity: string;
  supportedMarkets: { marketId: string; marketManifestHash: string }[];
  supportedAssets: { assetId: string; assetManifestHash: string }[];
  supportedLegTypes: string[];
  supportedSettlementClasses: string[];
  supportedTemplates: {
    templateId: string;
    templateVersion: string;
    packageTemplateManifestHash: string;
  }[];
  accountAndAuthorityMap: {
    bindingId: string;
    accountRole: string;
    accountIdentity: { source: string; exactIdentity?: string; ruleId?: string; ruleVersion?: string };
    codeIdentity?: { source: string; exactIdentity?: string; ruleId?: string; ruleVersion?: string };
    ownerIdentity?: { source: string; exactIdentity?: string; ruleId?: string; ruleVersion?: string };
    accessModes: string[];
    authorityRole: string;
    authorityIdentity: { source: string; exactIdentity?: string; ruleId?: string; ruleVersion?: string };
    signerRule: { mode: string; schemeId?: string };
  }[];
  accountingSchemaHash: string;
  canonicalHex: string;
  digestHex: string;
}

export interface DomainRegistryRecordFixture {
  recordVersion: string;
  environment: string;
  domain: {
    domainId: string;
    domainManifestVersion: string;
    domainManifestHash: string;
  };
  recordKind: string;
  subjectId: string;
  subjectManifestVersion: string;
  subjectManifestHash: string;
  registryState: string;
  riskLimits: {
    limitKind: string;
    assetId: string;
    assetManifestHash: string;
    decimals: number;
    maxAtoms: string;
    windowUnit?: string;
    windowValue?: string;
  }[];
  allowedTemplates: {
    templateId: string;
    templateVersion: string;
    packageTemplateManifestHash: string;
  }[];
  allowedSettlementClasses: string[];
  activationUnit: string;
  activationValue: string;
  governanceReference: string;
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

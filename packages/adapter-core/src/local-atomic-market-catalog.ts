import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  exactSignedRate,
  versionedManifestRef,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type ExactPrice,
  type ExactSignedRate,
  type VersionedManifestRef,
} from '@naryx/protocol-types';

export interface LocalAtomicMarketCatalog {
  readonly version: 1;
  readonly contextId: string;
  readonly domain: DomainRef;
  readonly template: Readonly<{
    templateId: string;
    templateVersion: number;
    packageTemplateManifestHash: string;
    templateRegistryRecordHash: string;
  }>;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly adapter: AdapterRef;
  readonly spotVenue: VersionedManifestRef;
  readonly perpetualVenue: VersionedManifestRef;
  readonly spotMarket: VersionedManifestRef;
  readonly perpetualMarket: VersionedManifestRef;
  readonly feePolicy: Readonly<{ version: number; manifestHash: string }>;
  readonly solver: Readonly<{
    solverId: string;
    capabilityManifestHash: string;
    candidateId: string;
    capacityBaseAtoms: bigint;
    routeTtlSlots: bigint;
    quoteTtlSlots: bigint;
    marginBps: number;
  }>;
  readonly pricing: Readonly<{
    spot: ExactPrice;
    perpetual: ExactPrice;
    maximumEntrySpread: ExactSignedRate;
  }>;
  readonly orderLimits: Readonly<{
    maximumQuantityAtoms: bigint;
    maximumSlippageBps: number;
    expiryTtlSlots: bigint;
    maxMarginAddedAtoms: bigint;
    maxProtocolFeeAtoms: bigint;
    maxSolverFeeAtoms: bigint;
    maxPriorityFeeAtoms: bigint;
  }>;
  readonly programs: Readonly<{ core: string; conformanceVenue: string }>;
  readonly accounts: Readonly<{
    trader: string;
    market: string;
    position: string;
    traderBase: string;
    traderQuote: string;
    spotBaseVault: string;
    spotQuoteVault: string;
    perpQuoteVault: string;
  }>;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  names: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} contains unsupported fields`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`${name} must be a nonempty bounded string`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = 0xffff_ffff,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be a bounded integer`);
  }
  return value;
}

function atoms(value: unknown, name: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be canonical decimal atoms`);
  }
  const parsed = BigInt(value);
  if ((positive && parsed === 0n) || parsed > (1n << 256n) - 1n) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
}

function hash(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value) ||
    /^0+$/.test(value)
  ) {
    throw new Error(`${name} must be a nonzero lowercase 32-byte hex hash`);
  }
  return value;
}

function asset(value: unknown, name: string): AssetRef {
  const input = record(value, name);
  exactKeys(input, ['assetId', 'assetManifestHash', 'decimals'], name);
  return assetRef(
    text(input.assetId, `${name}.assetId`),
    hash(input.assetManifestHash, `${name}.assetManifestHash`),
    integer(input.decimals, `${name}.decimals`, 0, 255),
  );
}

function subject(value: unknown, name: string): VersionedManifestRef {
  const input = record(value, name);
  exactKeys(input, ['subjectId', 'manifestVersion', 'manifestHash'], name);
  return versionedManifestRef(
    text(input.subjectId, `${name}.subjectId`),
    integer(input.manifestVersion, `${name}.manifestVersion`, 1),
    hash(input.manifestHash, `${name}.manifestHash`),
  );
}

export function parseLocalAtomicMarketCatalog(
  value: unknown,
): LocalAtomicMarketCatalog {
  const input = record(value, 'catalog');
  exactKeys(
    input,
    [
      'version',
      'contextId',
      'domain',
      'template',
      'baseAsset',
      'quoteAsset',
      'adapter',
      'spotVenue',
      'perpetualVenue',
      'spotMarket',
      'perpetualMarket',
      'feePolicy',
      'solver',
      'pricing',
      'orderLimits',
      'programs',
      'accounts',
    ],
    'catalog',
  );
  if (input.version !== 1) throw new Error('catalog.version must be 1');
  const domainInput = record(input.domain, 'catalog.domain');
  exactKeys(
    domainInput,
    ['domainId', 'domainManifestVersion', 'domainManifestHash'],
    'catalog.domain',
  );
  const domain = domainRef(
    text(domainInput.domainId, 'catalog.domain.domainId'),
    integer(
      domainInput.domainManifestVersion,
      'catalog.domain.domainManifestVersion',
      1,
    ),
    hash(domainInput.domainManifestHash, 'catalog.domain.domainManifestHash'),
  );
  if (domain.domainId !== 'svm:local')
    throw new Error('local catalog domain must be svm:local');

  const templateInput = record(input.template, 'catalog.template');
  exactKeys(
    templateInput,
    [
      'templateId',
      'templateVersion',
      'packageTemplateManifestHash',
      'templateRegistryRecordHash',
    ],
    'catalog.template',
  );
  const adapterInput = record(input.adapter, 'catalog.adapter');
  exactKeys(
    adapterInput,
    ['adapterId', 'adapterManifestVersion', 'adapterManifestHash'],
    'catalog.adapter',
  );
  const feePolicyInput = record(input.feePolicy, 'catalog.feePolicy');
  exactKeys(feePolicyInput, ['version', 'manifestHash'], 'catalog.feePolicy');
  const solverInput = record(input.solver, 'catalog.solver');
  exactKeys(
    solverInput,
    [
      'solverId',
      'capabilityManifestHash',
      'candidateId',
      'capacityBaseAtoms',
      'routeTtlSlots',
      'quoteTtlSlots',
      'marginBps',
    ],
    'catalog.solver',
  );
  const pricingInput = record(input.pricing, 'catalog.pricing');
  exactKeys(
    pricingInput,
    [
      'spotQuoteAtoms',
      'spotBaseAtoms',
      'perpetualQuoteAtoms',
      'perpetualBaseAtoms',
      'maximumEntrySpreadQuoteAtoms',
      'maximumEntrySpreadBaseAtoms',
    ],
    'catalog.pricing',
  );
  const limitsInput = record(input.orderLimits, 'catalog.orderLimits');
  exactKeys(
    limitsInput,
    [
      'maximumQuantityAtoms',
      'maximumSlippageBps',
      'expiryTtlSlots',
      'maxMarginAddedAtoms',
      'maxProtocolFeeAtoms',
      'maxSolverFeeAtoms',
      'maxPriorityFeeAtoms',
    ],
    'catalog.orderLimits',
  );
  const programsInput = record(input.programs, 'catalog.programs');
  exactKeys(programsInput, ['core', 'conformanceVenue'], 'catalog.programs');
  const accountsInput = record(input.accounts, 'catalog.accounts');
  exactKeys(
    accountsInput,
    [
      'trader',
      'market',
      'position',
      'traderBase',
      'traderQuote',
      'spotBaseVault',
      'spotQuoteVault',
      'perpQuoteVault',
    ],
    'catalog.accounts',
  );

  const baseAsset = asset(input.baseAsset, 'catalog.baseAsset');
  const quoteAsset = asset(input.quoteAsset, 'catalog.quoteAsset');
  const spotBaseAtoms = atoms(
    pricingInput.spotBaseAtoms,
    'catalog.pricing.spotBaseAtoms',
    true,
  );
  const perpetualBaseAtoms = atoms(
    pricingInput.perpetualBaseAtoms,
    'catalog.pricing.perpetualBaseAtoms',
    true,
  );
  const spotQuoteAtoms = atoms(
    pricingInput.spotQuoteAtoms,
    'catalog.pricing.spotQuoteAtoms',
    true,
  );
  const perpetualQuoteAtoms = atoms(
    pricingInput.perpetualQuoteAtoms,
    'catalog.pricing.perpetualQuoteAtoms',
    true,
  );
  if (
    perpetualQuoteAtoms * spotBaseAtoms <
    spotQuoteAtoms * perpetualBaseAtoms
  ) {
    throw new Error(
      'local cash-and-carry perpetual price must not be below spot',
    );
  }
  return Object.freeze({
    version: 1,
    contextId: text(input.contextId, 'catalog.contextId'),
    domain,
    template: Object.freeze({
      templateId: text(templateInput.templateId, 'catalog.template.templateId'),
      templateVersion: integer(
        templateInput.templateVersion,
        'catalog.template.templateVersion',
        1,
      ),
      packageTemplateManifestHash: hash(
        templateInput.packageTemplateManifestHash,
        'catalog.template.packageTemplateManifestHash',
      ),
      templateRegistryRecordHash: hash(
        templateInput.templateRegistryRecordHash,
        'catalog.template.templateRegistryRecordHash',
      ),
    }),
    baseAsset,
    quoteAsset,
    adapter: adapterRef({
      adapterId: text(adapterInput.adapterId, 'catalog.adapter.adapterId'),
      adapterManifestVersion: integer(
        adapterInput.adapterManifestVersion,
        'catalog.adapter.adapterManifestVersion',
        1,
      ),
      adapterManifestHash: hash(
        adapterInput.adapterManifestHash,
        'catalog.adapter.adapterManifestHash',
      ),
    }),
    spotVenue: subject(input.spotVenue, 'catalog.spotVenue'),
    perpetualVenue: subject(input.perpetualVenue, 'catalog.perpetualVenue'),
    spotMarket: subject(input.spotMarket, 'catalog.spotMarket'),
    perpetualMarket: subject(input.perpetualMarket, 'catalog.perpetualMarket'),
    feePolicy: Object.freeze({
      version: integer(feePolicyInput.version, 'catalog.feePolicy.version', 1),
      manifestHash: hash(
        feePolicyInput.manifestHash,
        'catalog.feePolicy.manifestHash',
      ),
    }),
    solver: Object.freeze({
      solverId: text(solverInput.solverId, 'catalog.solver.solverId'),
      capabilityManifestHash: hash(
        solverInput.capabilityManifestHash,
        'catalog.solver.capabilityManifestHash',
      ),
      candidateId: text(solverInput.candidateId, 'catalog.solver.candidateId'),
      capacityBaseAtoms: atoms(
        solverInput.capacityBaseAtoms,
        'catalog.solver.capacityBaseAtoms',
        true,
      ),
      routeTtlSlots: atoms(
        solverInput.routeTtlSlots,
        'catalog.solver.routeTtlSlots',
        true,
      ),
      quoteTtlSlots: atoms(
        solverInput.quoteTtlSlots,
        'catalog.solver.quoteTtlSlots',
        true,
      ),
      marginBps: integer(
        solverInput.marginBps,
        'catalog.solver.marginBps',
        0,
        10_000,
      ),
    }),
    pricing: Object.freeze({
      spot: exactPrice(
        {
          baseAsset,
          quoteAsset,
          quoteAtoms: spotQuoteAtoms,
          baseAtoms: spotBaseAtoms,
          roundingDirection: 'CEIL',
        },
        'catalog.pricing.spot',
      ),
      perpetual: exactPrice(
        {
          baseAsset,
          quoteAsset,
          quoteAtoms: perpetualQuoteAtoms,
          baseAtoms: perpetualBaseAtoms,
          roundingDirection: 'CEIL',
        },
        'catalog.pricing.perpetual',
      ),
      maximumEntrySpread: exactSignedRate(
        {
          baseAsset,
          quoteAsset,
          quoteAtoms: atoms(
            pricingInput.maximumEntrySpreadQuoteAtoms,
            'catalog.pricing.maximumEntrySpreadQuoteAtoms',
          ),
          baseAtoms: atoms(
            pricingInput.maximumEntrySpreadBaseAtoms,
            'catalog.pricing.maximumEntrySpreadBaseAtoms',
            true,
          ),
          roundingDirection: 'CEIL',
        },
        'catalog.pricing.maximumEntrySpread',
      ),
    }),
    orderLimits: Object.freeze({
      maximumQuantityAtoms: atoms(
        limitsInput.maximumQuantityAtoms,
        'catalog.orderLimits.maximumQuantityAtoms',
        true,
      ),
      maximumSlippageBps: integer(
        limitsInput.maximumSlippageBps,
        'catalog.orderLimits.maximumSlippageBps',
        1,
        10_000,
      ),
      expiryTtlSlots: atoms(
        limitsInput.expiryTtlSlots,
        'catalog.orderLimits.expiryTtlSlots',
        true,
      ),
      maxMarginAddedAtoms: atoms(
        limitsInput.maxMarginAddedAtoms,
        'catalog.orderLimits.maxMarginAddedAtoms',
      ),
      maxProtocolFeeAtoms: atoms(
        limitsInput.maxProtocolFeeAtoms,
        'catalog.orderLimits.maxProtocolFeeAtoms',
      ),
      maxSolverFeeAtoms: atoms(
        limitsInput.maxSolverFeeAtoms,
        'catalog.orderLimits.maxSolverFeeAtoms',
      ),
      maxPriorityFeeAtoms: atoms(
        limitsInput.maxPriorityFeeAtoms,
        'catalog.orderLimits.maxPriorityFeeAtoms',
      ),
    }),
    programs: Object.freeze({
      core: text(programsInput.core, 'catalog.programs.core'),
      conformanceVenue: text(
        programsInput.conformanceVenue,
        'catalog.programs.conformanceVenue',
      ),
    }),
    accounts: Object.freeze({
      trader: text(accountsInput.trader, 'catalog.accounts.trader'),
      market: text(accountsInput.market, 'catalog.accounts.market'),
      position: text(accountsInput.position, 'catalog.accounts.position'),
      traderBase: text(accountsInput.traderBase, 'catalog.accounts.traderBase'),
      traderQuote: text(
        accountsInput.traderQuote,
        'catalog.accounts.traderQuote',
      ),
      spotBaseVault: text(
        accountsInput.spotBaseVault,
        'catalog.accounts.spotBaseVault',
      ),
      spotQuoteVault: text(
        accountsInput.spotQuoteVault,
        'catalog.accounts.spotQuoteVault',
      ),
      perpQuoteVault: text(
        accountsInput.perpQuoteVault,
        'catalog.accounts.perpQuoteVault',
      ),
    }),
  });
}

export const LOCAL_ATOMIC_MARKET_CATALOG_V1 = parseLocalAtomicMarketCatalog({
  version: 1,
  contextId: 'local:svm:sol-carry-v1',
  domain: {
    domainId: 'svm:local',
    domainManifestVersion: 1,
    domainManifestHash: '33'.repeat(32),
  },
  template: {
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: '44'.repeat(32),
    templateRegistryRecordHash: 'b1'.repeat(32),
  },
  baseAsset: {
    assetId: 'sol-local',
    assetManifestHash: '11'.repeat(32),
    decimals: 6,
  },
  quoteAsset: {
    assetId: 'usdc-local',
    assetManifestHash: '22'.repeat(32),
    decimals: 6,
  },
  adapter: {
    adapterId: 'solana-conformance-v1',
    adapterManifestVersion: 1,
    adapterManifestHash: '55'.repeat(32),
  },
  spotVenue: {
    subjectId: 'solana-conformance-spot',
    manifestVersion: 1,
    manifestHash: 'a1'.repeat(32),
  },
  perpetualVenue: {
    subjectId: 'solana-conformance-perpetual',
    manifestVersion: 1,
    manifestHash: 'a2'.repeat(32),
  },
  spotMarket: {
    subjectId: 'sol-usdc-local-spot',
    manifestVersion: 1,
    manifestHash: 'a3'.repeat(32),
  },
  perpetualMarket: {
    subjectId: 'sol-usdc-local-perpetual',
    manifestVersion: 1,
    manifestHash: 'a4'.repeat(32),
  },
  feePolicy: { version: 1, manifestHash: 'c1'.repeat(32) },
  solver: {
    solverId: 'naryx-local-solver',
    capabilityManifestHash: 'e1'.repeat(32),
    candidateId: 'local-sol-carry-atomic',
    capacityBaseAtoms: '100000000000',
    routeTtlSlots: '80',
    quoteTtlSlots: '40',
    marginBps: 1000,
  },
  pricing: {
    spotQuoteAtoms: '3706',
    spotBaseAtoms: '25',
    perpetualQuoteAtoms: '14907',
    perpetualBaseAtoms: '100',
    maximumEntrySpreadQuoteAtoms: '2',
    maximumEntrySpreadBaseAtoms: '1',
  },
  orderLimits: {
    maximumQuantityAtoms: '100000000000',
    maximumSlippageBps: 25,
    expiryTtlSlots: '120',
    maxMarginAddedAtoms: '20000000000',
    maxProtocolFeeAtoms: '0',
    maxSolverFeeAtoms: '0',
    maxPriorityFeeAtoms: '0',
  },
  programs: {
    core: '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i',
    conformanceVenue: 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y',
  },
  accounts: {
    trader: '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i',
    market: 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y',
    position: '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i',
    traderBase: '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i',
    traderQuote: '8qmA9VuQwAAqQ3F93CAfLNFB3P8M8ygXgvn9xCnZXa2i',
    spotBaseVault: 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y',
    spotQuoteVault: 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y',
    perpQuoteVault: 'ERGvPwyenaZDcAr9cyni7paeXPQ72NKC75ozz1fjCY7y',
  },
});

export function localConformanceSlot(nowMs = Date.now()): bigint {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error('local clock is invalid');
  return BigInt(Math.floor(nowMs / 400));
}

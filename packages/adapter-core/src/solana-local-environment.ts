import {
  HASH_DOMAIN,
  adapterManifestHash,
  assetRefFromManifest,
  domainHash,
  domainManifest,
  domainRefFromManifest,
  duration,
  encodeAscii,
  feePolicyManifestHash,
  marketManifestHash,
  packageTemplateManifestHash,
  packageTemplateRegistryRecordHash,
  priceSourceManifestHash,
  venueManifestHash,
  type DomainManifest,
} from '@naryx/protocol-types';
import {
  parseLocalAtomicMarketCatalog,
  type LocalAtomicMarketCatalog,
} from './local-atomic-market-catalog.js';

const PROGRAM_NAMES = ['core', 'conformanceVenue'] as const;
const IDENTITY_NAMES = [
  'payer',
  'governanceProposer',
  'governanceCanceller',
  'governanceExecutor',
  'governancePauser',
  'venueAdmin',
  'trader',
  'solver',
  'maker',
  'recovery',
] as const;
const ACCOUNT_NAMES = [
  'config',
  'solverRegistry',
  'market',
  'spotBaseVault',
  'spotQuoteVault',
  'perpQuoteVault',
  'position',
  'trader-base',
  'trader-quote',
  'maker-base',
  'maker-quote',
  'recovery-base',
  'recovery-quote',
] as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;

export interface SolanaLocalProgramIdentity {
  readonly id: string;
  readonly programDataId: string;
  readonly sha256: string;
}

export interface SolanaLocalEnvironmentManifest {
  readonly schemaVersion: 2;
  readonly evidenceGrade: 'CONFORMANCE_DEPENDENCY';
  readonly network: 'local-validator';
  readonly mainnet: false;
  readonly limitations: readonly string[];
  readonly rpc: Readonly<{
    url: string;
    genesisHash: string;
    manifestSlot: number;
    maximumManifestAgeSlots: number;
  }>;
  readonly programs: Readonly<
    Record<(typeof PROGRAM_NAMES)[number], SolanaLocalProgramIdentity>
  >;
  readonly identities: Readonly<
    Record<(typeof IDENTITY_NAMES)[number], string>
  >;
  readonly assets: Readonly<
    Record<
      'base' | 'quote',
      Readonly<{ label: string; mint: string; decimals: number }>
    >
  >;
  readonly accounts: Readonly<Record<(typeof ACCOUNT_NAMES)[number], string>>;
  readonly governance: Readonly<{
    configDelaySlots: number;
    solverActivationSlot: number;
    entryActivationSlot: number;
    activatedAtSlot: number;
  }>;
  readonly economics: Readonly<Record<string, string>>;
  readonly balances: Readonly<Record<string, string>>;
  readonly runtime: Readonly<{
    domainManifest: DomainManifest;
    domainManifestHash: string;
    catalog: LocalAtomicMarketCatalog;
  }>;
}

export interface SolanaLocalManifestFacts {
  readonly rpcUrl: string;
  readonly genesisHash: string;
  readonly manifestSlot: number;
  readonly maximumManifestAgeSlots: number;
  readonly programs: Record<
    (typeof PROGRAM_NAMES)[number],
    SolanaLocalProgramIdentity
  >;
  readonly identities: Record<(typeof IDENTITY_NAMES)[number], string>;
  readonly assets: Record<
    'base' | 'quote',
    { label: string; mint: string; decimals: number }
  >;
  readonly accounts: Record<(typeof ACCOUNT_NAMES)[number], string>;
  readonly governance: SolanaLocalEnvironmentManifest['governance'];
  readonly economics: Record<string, string>;
  readonly balances: Record<string, string>;
  readonly limitations: readonly string[];
}

export interface SolanaLocalRpcSnapshot {
  readonly genesisHash: string;
  readonly slot: number;
  readonly programs: Readonly<
    Record<
      (typeof PROGRAM_NAMES)[number],
      Readonly<{
        id: string;
        programDataId: string;
        sha256: string;
      }>
    >
  >;
}

function catalogJson(
  catalog: LocalAtomicMarketCatalog,
): Record<string, unknown> {
  const asset = (value: LocalAtomicMarketCatalog['baseAsset']) => ({
    assetId: value.assetId,
    assetManifestHash: hex(value.assetManifestHash),
    decimals: value.decimals,
  });
  const subject = (value: LocalAtomicMarketCatalog['spotVenue']) => ({
    subjectId: value.subjectId,
    manifestVersion: value.manifestVersion,
    manifestHash: hex(value.manifestHash),
  });
  return {
    version: catalog.version,
    contextId: catalog.contextId,
    domain: {
      domainId: catalog.domain.domainId,
      domainManifestVersion: catalog.domain.domainManifestVersion,
      domainManifestHash: hex(catalog.domain.domainManifestHash),
    },
    template: catalog.template,
    baseAsset: asset(catalog.baseAsset),
    quoteAsset: asset(catalog.quoteAsset),
    adapter: {
      adapterId: catalog.adapter.adapterId,
      adapterManifestVersion: catalog.adapter.adapterManifestVersion,
      adapterManifestHash: hex(catalog.adapter.adapterManifestHash),
    },
    spotVenue: subject(catalog.spotVenue),
    perpetualVenue: subject(catalog.perpetualVenue),
    spotMarket: subject(catalog.spotMarket),
    perpetualMarket: subject(catalog.perpetualMarket),
    feePolicy: catalog.feePolicy,
    solver: {
      ...catalog.solver,
      capacityBaseAtoms: catalog.solver.capacityBaseAtoms.toString(),
      routeTtlSlots: catalog.solver.routeTtlSlots.toString(),
      quoteTtlSlots: catalog.solver.quoteTtlSlots.toString(),
    },
    pricing: {
      spotQuoteAtoms: catalog.pricing.spot.quoteAtoms.toString(),
      spotBaseAtoms: catalog.pricing.spot.baseAtoms.toString(),
      perpetualQuoteAtoms: catalog.pricing.perpetual.quoteAtoms.toString(),
      perpetualBaseAtoms: catalog.pricing.perpetual.baseAtoms.toString(),
      maximumEntrySpreadQuoteAtoms:
        catalog.pricing.maximumEntrySpread.quoteAtoms.toString(),
      maximumEntrySpreadBaseAtoms:
        catalog.pricing.maximumEntrySpread.baseAtoms.toString(),
    },
    orderLimits: Object.fromEntries(
      Object.entries(catalog.orderLimits).map(([name, value]) => [
        name,
        typeof value === 'bigint' ? value.toString() : value,
      ]),
    ),
    programs: catalog.programs,
    accounts: catalog.accounts,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  ) {
    throw new Error(`${name} contains unsupported or missing fields`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw new Error(`${name} must be a bounded nonempty string`);
  return value;
}

function publicKey(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!BASE58.test(parsed))
    throw new Error(`${name} must be a Solana public key`);
  return parsed;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !HEX_32.test(value) || /^0+$/.test(value))
    throw new Error(`${name} must be a nonzero lowercase SHA-256 hash`);
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error(`${name} must be a bounded integer`);
  return value;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function semanticHash(
  domain: (typeof HASH_DOMAIN)[keyof typeof HASH_DOMAIN],
  value: string,
): string {
  return hex(domainHash(domain, encodeAscii(value)));
}

function domainManifestJson(manifest: DomainManifest): Record<string, unknown> {
  return {
    ...manifest,
    executionVerifierCodeHash: hex(manifest.executionVerifierCodeHash),
    finalityPolicyHash: hex(manifest.finalityPolicyHash),
  };
}

export function deriveSolanaLocalRuntime(
  facts: SolanaLocalManifestFacts,
): SolanaLocalEnvironmentManifest['runtime'] {
  const domainInput = {
    manifestVersion: 1,
    environment: 'local',
    domainId: 'svm:local',
    runtimeClassId: 'svm',
    runtimeClassVersion: 1,
    chainNamespace: 'solana',
    chainReference: facts.genesisHash,
    executionVerifierId: facts.programs.core.id,
    executionVerifierCodeHash: facts.programs.core.sha256,
    clockModelId: 'solana-slot',
    finalityPolicyHash: semanticHash(
      HASH_DOMAIN.DOMAIN_REF_IDENTITY,
      'solana:confirmed',
    ),
    addressCodecId: 'solana-base58-pubkey',
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'] as const,
  };
  const domain = domainRefFromManifest(domainInput);
  const domainHashHex = hex(domain.domainManifestHash);
  const baseInput = {
    manifestVersion: 1,
    environment: 'local',
    assetId: 'base-local',
    economicAssetId: 'base',
    domain,
    tokenIdentity: facts.assets.base.mint,
    decimals: facts.assets.base.decimals,
    atomUnitName: 'base-atom',
    minimumTransferAtoms: 1n,
    transferSemantics: 'spl-token',
  };
  const quoteInput = {
    manifestVersion: 1,
    environment: 'local',
    assetId: 'quote-local',
    economicAssetId: 'quote',
    domain,
    tokenIdentity: facts.assets.quote.mint,
    decimals: facts.assets.quote.decimals,
    atomUnitName: 'quote-atom',
    minimumTransferAtoms: 1n,
    transferSemantics: 'spl-token',
  };
  const baseAsset = assetRefFromManifest(baseInput);
  const quoteAsset = assetRefFromManifest(quoteInput);
  const venueInput = {
    manifestVersion: 1,
    environment: 'local',
    venueId: 'solana-conformance',
    domain,
    venueKind: 'conformance-spot-perpetual',
    protocolIdentity: facts.programs.conformanceVenue.id,
    codeIdentity: `${facts.programs.conformanceVenue.id}:${facts.programs.conformanceVenue.sha256}`,
    authorityIdentity: facts.identities.venueAdmin,
  };
  const venueHashHex = hex(venueManifestHash(venueInput));
  const priceSourceId = 'solana-conformance-market-state';
  const priceSourceHash = hex(
    priceSourceManifestHash({
      manifestVersion: 1,
      environment: 'local',
      priceSourceId,
      domain,
      sourceKind: 'onchain-account',
      feedIdentity: facts.accounts.market,
      priceDecimals: facts.assets.quote.decimals,
      priceConvention: 'quote-atoms-per-base-atom',
      maxStaleness: duration('MILLISECONDS', 10_000n),
      fallbackRule: 'fail-closed',
    }),
  );
  const market = (marketId: string, instrumentKind: string) => ({
    manifestVersion: 1,
    environment: 'local',
    marketId,
    domain,
    venueId: venueInput.venueId,
    venueManifestHash: venueHashHex,
    marketIdentity: facts.accounts.market,
    instrumentKind,
    baseAssetId: baseAsset.assetId,
    baseAssetManifestHash: baseAsset.assetManifestHash,
    quoteAssetId: quoteAsset.assetId,
    quoteAssetManifestHash: quoteAsset.assetManifestHash,
    baseLotSize: {
      baseAssetId: baseAsset.assetId,
      baseAssetManifestHash: baseAsset.assetManifestHash,
      baseDecimals: baseAsset.decimals,
      atoms: 1n,
    },
    priceTick: {
      quoteAssetId: quoteAsset.assetId,
      quoteAssetManifestHash: quoteAsset.assetManifestHash,
      quoteDecimals: quoteAsset.decimals,
      quoteAtoms: 1n,
      baseLotCount: 1n,
    },
    minimumNotional: {
      quoteAssetId: quoteAsset.assetId,
      quoteAssetManifestHash: quoteAsset.assetManifestHash,
      quoteDecimals: quoteAsset.decimals,
      atoms: 1n,
    },
    contractMultiplier: {
      numerator: 1n,
      denominator: 1n,
      unitConvention: 'base-atom',
    },
    permittedPriceSources: [
      { priceSourceId, priceSourceManifestHash: priceSourceHash },
    ],
  });
  const spotMarketHash = hex(
    marketManifestHash(market('base-quote-local-spot', 'SPOT')),
  );
  const perpetualMarketHash = hex(
    marketManifestHash(
      market('base-quote-local-perpetual', 'LINEAR_PERPETUAL'),
    ),
  );
  const templateInput = {
    manifestVersion: 1,
    environment: 'local',
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: semanticHash(HASH_DOMAIN.ORDER, 'cash-and-carry-v1'),
    quoteSchemaHash: semanticHash(HASH_DOMAIN.QUOTE, 'cash-and-carry-v1'),
    routeSchemaHash: semanticHash(HASH_DOMAIN.ROUTE, 'cash-and-carry-v1'),
    receiptSchemaHash: semanticHash(HASH_DOMAIN.RECEIPT, 'cash-and-carry-v1'),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: ['SPOT', 'PERPETUAL'],
    supportedDirections: ['LONG_SPOT_SHORT_PERP'] as const,
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'] as const,
    allowedSpotAdapterIds: ['solana-conformance-v1'],
    allowedPerpAdapterIds: ['solana-conformance-v1'],
    riskPolicyHash: semanticHash(
      HASH_DOMAIN.EVIDENCE_MANIFEST,
      'local-conformance-risk-v1',
    ),
  };
  const templateHash = hex(packageTemplateManifestHash(templateInput));
  const registryHash = hex(
    packageTemplateRegistryRecordHash({
      recordVersion: 1,
      environment: 'local',
      domain,
      templateId: templateInput.templateId,
      templateVersion: 1,
      packageTemplateManifestHash: templateHash,
      registryState: 'ACTIVE',
      activationUnit: 'SOLANA_SLOT',
      activationValue: BigInt(facts.governance.entryActivationSlot),
      governanceReference: facts.accounts.config,
    }),
  );
  const adapterHash = hex(
    adapterManifestHash({
      manifestVersion: 1,
      environment: 'local',
      adapterId: 'solana-conformance-v1',
      adapterClass: 'solana-conformance',
      adapterClassVersion: 1,
      domain,
      venueId: venueInput.venueId,
      venueManifestHash: venueHashHex,
      codeIdentity: `${facts.programs.conformanceVenue.id}:${facts.programs.conformanceVenue.sha256}`,
      supportedMarkets: [
        {
          marketId: 'base-quote-local-spot',
          marketManifestHash: spotMarketHash,
        },
        {
          marketId: 'base-quote-local-perpetual',
          marketManifestHash: perpetualMarketHash,
        },
      ],
      supportedAssets: [
        {
          assetId: baseAsset.assetId,
          assetManifestHash: baseAsset.assetManifestHash,
        },
        {
          assetId: quoteAsset.assetId,
          assetManifestHash: quoteAsset.assetManifestHash,
        },
      ],
      supportedLegTypes: ['SPOT', 'PERPETUAL'],
      supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      supportedTemplates: [
        {
          templateId: templateInput.templateId,
          templateVersion: 1,
          packageTemplateManifestHash: templateHash,
        },
      ],
      accountAndAuthorityMap: [
        {
          bindingId: 'market',
          accountRole: 'venue-market',
          accountIdentity: {
            source: 'EXACT',
            exactIdentity: facts.accounts.market,
          },
          codeIdentity: {
            source: 'EXACT',
            exactIdentity: facts.programs.conformanceVenue.id,
          },
          ownerIdentity: {
            source: 'EXACT',
            exactIdentity: facts.programs.conformanceVenue.id,
          },
          accessModes: ['OBSERVE', 'INVOKE'],
          authorityRole: 'venue-admin',
          authorityIdentity: {
            source: 'EXACT',
            exactIdentity: facts.identities.venueAdmin,
          },
          signerRule: {
            mode: 'RUNTIME_SIGNATURE',
            schemeId: 'solana-ed25519-v1',
          },
        },
      ],
      accountingSchemaHash: semanticHash(
        HASH_DOMAIN.EVIDENCE_MANIFEST,
        'solana-conformance-accounting-v1',
      ),
    }),
  );
  const feeHash = hex(
    feePolicyManifestHash({
      schemaVersion: 1,
      manifestVersion: 1,
      environment: 'local',
      domain,
      scopeDirection: 'LONG_SPOT_SHORT_PERP',
      feePolicyVersion: 1,
      activationUnit: 'SOLANA_SLOT',
      activationValue: BigInt(facts.governance.entryActivationSlot),
      serviceFeeRules: [],
      passThroughCostRules: [],
      refundPolicyVersion: 1,
    }),
  );
  const catalog = parseLocalAtomicMarketCatalog({
    version: 1,
    contextId: `local:${facts.genesisHash.slice(0, 16)}:cash-carry-v1`,
    domain: {
      domainId: domain.domainId,
      domainManifestVersion: domain.domainManifestVersion,
      domainManifestHash: domainHashHex,
    },
    template: {
      templateId: templateInput.templateId,
      templateVersion: 1,
      packageTemplateManifestHash: templateHash,
      templateRegistryRecordHash: registryHash,
    },
    baseAsset: {
      assetId: baseAsset.assetId,
      assetManifestHash: hex(baseAsset.assetManifestHash),
      decimals: baseAsset.decimals,
    },
    quoteAsset: {
      assetId: quoteAsset.assetId,
      assetManifestHash: hex(quoteAsset.assetManifestHash),
      decimals: quoteAsset.decimals,
    },
    adapter: {
      adapterId: 'solana-conformance-v1',
      adapterManifestVersion: 1,
      adapterManifestHash: adapterHash,
    },
    spotVenue: {
      subjectId: venueInput.venueId,
      manifestVersion: 1,
      manifestHash: venueHashHex,
    },
    perpetualVenue: {
      subjectId: venueInput.venueId,
      manifestVersion: 1,
      manifestHash: venueHashHex,
    },
    spotMarket: {
      subjectId: 'base-quote-local-spot',
      manifestVersion: 1,
      manifestHash: spotMarketHash,
    },
    perpetualMarket: {
      subjectId: 'base-quote-local-perpetual',
      manifestVersion: 1,
      manifestHash: perpetualMarketHash,
    },
    feePolicy: { version: 1, manifestHash: feeHash },
    solver: {
      solverId: facts.identities.solver,
      capabilityManifestHash: semanticHash(
        HASH_DOMAIN.SOLVER_CAPABILITY,
        `${facts.identities.solver}:${domainHashHex}`,
      ),
      candidateId: 'local-cash-carry-atomic',
      capacityBaseAtoms: facts.economics.maxSpotBaseAtoms,
      routeTtlSlots: '80',
      quoteTtlSlots: '40',
      marginBps: 1000,
    },
    pricing: {
      spotQuoteAtoms: facts.economics.priceQuoteAtoms,
      spotBaseAtoms: facts.economics.priceBaseAtoms,
      perpetualQuoteAtoms: facts.economics.priceQuoteAtoms,
      perpetualBaseAtoms: facts.economics.priceBaseAtoms,
      maximumEntrySpreadQuoteAtoms: '2',
      maximumEntrySpreadBaseAtoms: '1',
    },
    orderLimits: {
      maximumQuantityAtoms: facts.economics.maxSpotBaseAtoms,
      maximumSlippageBps: 25,
      expiryTtlSlots: '120',
      maxMarginAddedAtoms: facts.economics.maxPerpBaseAtoms,
      maxProtocolFeeAtoms: '0',
      maxSolverFeeAtoms: '0',
      maxPriorityFeeAtoms: '0',
    },
    programs: {
      core: facts.programs.core.id,
      conformanceVenue: facts.programs.conformanceVenue.id,
    },
    accounts: {
      trader: facts.identities.trader,
      market: facts.accounts.market,
      position: facts.accounts.position,
      traderBase: facts.accounts['trader-base'],
      traderQuote: facts.accounts['trader-quote'],
      spotBaseVault: facts.accounts.spotBaseVault,
      spotQuoteVault: facts.accounts.spotQuoteVault,
      perpQuoteVault: facts.accounts.perpQuoteVault,
    },
  });
  return Object.freeze({
    domainManifest: domainManifest(domainInput),
    domainManifestHash: domainHashHex,
    catalog,
  });
}

function parseFacts(value: unknown): SolanaLocalManifestFacts {
  const root = object(value, 'manifest');
  keys(
    root,
    [
      'schemaVersion',
      'evidenceGrade',
      'network',
      'mainnet',
      'limitations',
      'rpc',
      'programs',
      'identities',
      'assets',
      'accounts',
      'governance',
      'economics',
      'balances',
      'runtime',
    ],
    'manifest',
  );
  if (
    root.schemaVersion !== 2 ||
    root.evidenceGrade !== 'CONFORMANCE_DEPENDENCY' ||
    root.network !== 'local-validator' ||
    root.mainnet !== false
  )
    throw new Error('manifest identity is unsupported');
  if (!Array.isArray(root.limitations) || root.limitations.length === 0)
    throw new Error('manifest.limitations must be nonempty');
  const limitations = root.limitations.map((entry, index) =>
    text(entry, `manifest.limitations[${index}]`),
  );
  const rpc = object(root.rpc, 'manifest.rpc');
  keys(
    rpc,
    ['url', 'genesisHash', 'manifestSlot', 'maximumManifestAgeSlots'],
    'manifest.rpc',
  );
  const rpcUrl = text(rpc.url, 'manifest.rpc.url');
  if (
    !/^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):(?:[1-9]\d{0,4})\/?$/.test(
      rpcUrl,
    )
  )
    throw new Error(
      'manifest.rpc.url must be an unauthenticated loopback HTTP origin',
    );
  const programsInput = object(root.programs, 'manifest.programs');
  keys(programsInput, PROGRAM_NAMES, 'manifest.programs');
  const programs = Object.fromEntries(
    PROGRAM_NAMES.map((name) => {
      const entry = object(programsInput[name], `manifest.programs.${name}`);
      keys(
        entry,
        ['id', 'programDataId', 'sha256'],
        `manifest.programs.${name}`,
      );
      return [
        name,
        {
          id: publicKey(entry.id, `manifest.programs.${name}.id`),
          programDataId: publicKey(
            entry.programDataId,
            `manifest.programs.${name}.programDataId`,
          ),
          sha256: hash(entry.sha256, `manifest.programs.${name}.sha256`),
        },
      ];
    }),
  ) as unknown as SolanaLocalManifestFacts['programs'];
  const identitiesInput = object(root.identities, 'manifest.identities');
  keys(identitiesInput, IDENTITY_NAMES, 'manifest.identities');
  const identities = Object.fromEntries(
    IDENTITY_NAMES.map((name) => [
      name,
      publicKey(identitiesInput[name], `manifest.identities.${name}`),
    ]),
  ) as unknown as SolanaLocalManifestFacts['identities'];
  const assetsInput = object(root.assets, 'manifest.assets');
  keys(assetsInput, ['base', 'quote'], 'manifest.assets');
  const assets = Object.fromEntries(
    ['base', 'quote'].map((name) => {
      const entry = object(assetsInput[name], `manifest.assets.${name}`);
      keys(entry, ['label', 'mint', 'decimals'], `manifest.assets.${name}`);
      return [
        name,
        {
          label: text(entry.label, `manifest.assets.${name}.label`),
          mint: publicKey(entry.mint, `manifest.assets.${name}.mint`),
          decimals: integer(entry.decimals, `manifest.assets.${name}.decimals`),
        },
      ];
    }),
  ) as SolanaLocalManifestFacts['assets'];
  const accountsInput = object(root.accounts, 'manifest.accounts');
  keys(accountsInput, ACCOUNT_NAMES, 'manifest.accounts');
  const accounts = Object.fromEntries(
    ACCOUNT_NAMES.map((name) => [
      name,
      publicKey(accountsInput[name], `manifest.accounts.${name}`),
    ]),
  ) as unknown as SolanaLocalManifestFacts['accounts'];
  const governanceInput = object(root.governance, 'manifest.governance');
  keys(
    governanceInput,
    [
      'configDelaySlots',
      'solverActivationSlot',
      'entryActivationSlot',
      'activatedAtSlot',
    ],
    'manifest.governance',
  );
  const governance = Object.fromEntries(
    Object.keys(governanceInput).map((name) => [
      name,
      integer(governanceInput[name], `manifest.governance.${name}`),
    ]),
  ) as unknown as SolanaLocalManifestFacts['governance'];
  const decimalRecord = (raw: unknown, name: string) =>
    Object.fromEntries(
      Object.entries(object(raw, name)).map(([key, entry]) => {
        if (typeof entry !== 'string' || !DECIMAL.test(entry))
          throw new Error(`${name}.${key} must be canonical decimal text`);
        return [key, entry];
      }),
    );
  return {
    rpcUrl: rpcUrl.endsWith('/') ? rpcUrl : `${rpcUrl}/`,
    genesisHash: publicKey(rpc.genesisHash, 'manifest.rpc.genesisHash'),
    manifestSlot: integer(rpc.manifestSlot, 'manifest.rpc.manifestSlot', 1),
    maximumManifestAgeSlots: integer(
      rpc.maximumManifestAgeSlots,
      'manifest.rpc.maximumManifestAgeSlots',
      1,
    ),
    programs,
    identities,
    assets,
    accounts,
    governance,
    economics: decimalRecord(root.economics, 'manifest.economics'),
    balances: decimalRecord(root.balances, 'manifest.balances'),
    limitations,
  };
}

export function parseSolanaLocalEnvironmentManifest(
  value: unknown,
): SolanaLocalEnvironmentManifest {
  const facts = parseFacts(value);
  const root = object(value, 'manifest');
  const expected = deriveSolanaLocalRuntime(facts);
  const runtime = object(root.runtime, 'manifest.runtime');
  keys(
    runtime,
    ['domainManifest', 'domainManifestHash', 'catalog'],
    'manifest.runtime',
  );
  const actualCatalog = parseLocalAtomicMarketCatalog(runtime.catalog);
  if (
    JSON.stringify(runtime.domainManifest) !==
      JSON.stringify(domainManifestJson(expected.domainManifest)) ||
    runtime.domainManifestHash !== expected.domainManifestHash ||
    JSON.stringify(catalogJson(actualCatalog)) !==
      JSON.stringify(catalogJson(expected.catalog))
  )
    throw new Error(
      'manifest.runtime canonical identities do not match infrastructure',
    );
  return Object.freeze({
    schemaVersion: 2,
    evidenceGrade: 'CONFORMANCE_DEPENDENCY',
    network: 'local-validator',
    mainnet: false,
    limitations: Object.freeze([...facts.limitations]),
    rpc: Object.freeze({
      url: facts.rpcUrl,
      genesisHash: facts.genesisHash,
      manifestSlot: facts.manifestSlot,
      maximumManifestAgeSlots: facts.maximumManifestAgeSlots,
    }),
    programs: Object.freeze(facts.programs),
    identities: Object.freeze(facts.identities),
    assets: Object.freeze(facts.assets),
    accounts: Object.freeze(facts.accounts),
    governance: Object.freeze(facts.governance),
    economics: Object.freeze(facts.economics),
    balances: Object.freeze(facts.balances),
    runtime: expected,
  });
}

export function createSolanaLocalEnvironmentManifest(
  facts: SolanaLocalManifestFacts,
): SolanaLocalEnvironmentManifest {
  return parseSolanaLocalEnvironmentManifest(
    createSolanaLocalEnvironmentManifestJson(facts),
  );
}

export function createSolanaLocalEnvironmentManifestJson(
  facts: SolanaLocalManifestFacts,
): Record<string, unknown> {
  const runtime = deriveSolanaLocalRuntime(facts);
  return {
    schemaVersion: 2,
    evidenceGrade: 'CONFORMANCE_DEPENDENCY',
    network: 'local-validator',
    mainnet: false,
    limitations: facts.limitations,
    rpc: {
      url: facts.rpcUrl,
      genesisHash: facts.genesisHash,
      manifestSlot: facts.manifestSlot,
      maximumManifestAgeSlots: facts.maximumManifestAgeSlots,
    },
    programs: facts.programs,
    identities: facts.identities,
    assets: facts.assets,
    accounts: facts.accounts,
    governance: facts.governance,
    economics: facts.economics,
    balances: facts.balances,
    runtime: {
      domainManifest: domainManifestJson(runtime.domainManifest),
      domainManifestHash: runtime.domainManifestHash,
      catalog: catalogJson(runtime.catalog),
    },
  };
}

export function validateSolanaLocalRpcSnapshot(
  manifest: SolanaLocalEnvironmentManifest,
  snapshot: SolanaLocalRpcSnapshot,
  expectedSolverId: string,
): bigint {
  if (expectedSolverId !== manifest.identities.solver)
    throw new Error('configured solver identity does not match manifest');
  if (snapshot.genesisHash !== manifest.rpc.genesisHash)
    throw new Error('RPC genesis hash does not match manifest');
  if (
    snapshot.slot < manifest.rpc.manifestSlot ||
    snapshot.slot - manifest.rpc.manifestSlot >
      manifest.rpc.maximumManifestAgeSlots
  )
    throw new Error(
      'environment manifest slot is stale or ahead of the validator',
    );
  for (const name of PROGRAM_NAMES) {
    const expected = manifest.programs[name];
    const actual = snapshot.programs[name];
    if (
      actual.id !== expected.id ||
      actual.programDataId !== expected.programDataId ||
      actual.sha256 !== expected.sha256
    )
      throw new Error(
        `${name} program identity or code hash does not match manifest`,
      );
  }
  return BigInt(snapshot.slot);
}

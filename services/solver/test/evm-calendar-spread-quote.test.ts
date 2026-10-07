import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  packageGraph,
  packageGraphHash,
  packageTemplateManifest,
  packageTemplateManifestHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  toHex as protocolHex,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type Hash32,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import { hexToBytes, type Abi, type Address, type Hex } from 'viem';
import {
  EvmCalendarSpreadPreparationContextResolver,
  EvmOptionSpreadProvisioningResolver,
  GeneralizedStrategyQuoteContextRegistry,
  GeneralizedStrategyQuoteService,
  StrategyPreparationService,
  createEvmCalendarSpreadGeneralizedPricing,
  type EvmCalendarSpreadPricingInput,
  type EvmOptionSpreadReadPort,
  type StoredStrategyPackageDocuments,
  type StoredStrategyPackageOrderDocuments,
} from '../src/index.js';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const codeHash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hash = (byte: string) => byte.repeat(64);
const NOW = 1_000n;
const QUANTITY = 10n ** 18n;
const BASE_TOKEN = address('1');
const QUOTE_TOKEN = address('2');
const ORACLE = address('3');
const NEAR_MARKET = address('4');
const FAR_MARKET = address('5');
const OWNER = address('6');
const ACCOUNT = address('7');
const ACCOUNT_FACTORY = address('8');
const NEAR_FACTORY = address('9');
const FAR_FACTORY = address('a');
const NEAR_ADAPTER = address('b');
const FAR_ADAPTER = address('c');
const SOLVER = address('d');

const domain = domainRef('eip155:84532', 1, hash('1'));
const baseAsset = assetRef('base-sepolia:ntbase', hash('2'), 18);
const quoteAsset = assetRef('base-sepolia:ntquote', hash('3'), 6);
const nearAdapter = adapterRef({
  adapterId: 'base-near-future',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('4'),
});
const farAdapter = adapterRef({
  adapterId: 'base-far-future',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('5'),
});
const venue = versionedManifestRef('naryx-evm-conformance', 1, hash('6'));
const nearMarket = versionedManifestRef('ntbase-near-future', 1, hash('7'));
const farMarket = versionedManifestRef('ntbase-far-future', 1, hash('8'));
const templateInput: PackageTemplateManifestInput = {
  manifestVersion: 2,
  environment: 'testnet',
  templateId: 'calendar-spread-v1',
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: hash('9'),
  quoteSchemaHash: hash('a'),
  routeSchemaHash: hash('b'),
  receiptSchemaHash: hash('c'),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 2,
  legTypes: ['near-future', 'far-future'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [],
  allowedPerpAdapterIds: [],
  allowedAdapterIds: [nearAdapter.adapterId, farAdapter.adapterId],
  riskPolicyHash: hash('d'),
};
const template = packageTemplateManifest(templateInput);
const templateHash = packageTemplateManifestHash(template);

function registry(
  recordKind: DomainRegistryRecordInput['recordKind'],
  subjectId: string,
  subjectManifestHash: Uint8Array | string,
): DomainRegistryRecordInput {
  return {
    recordVersion: 1,
    environment: 'testnet',
    domain,
    recordKind,
    subjectId,
    subjectManifestVersion: 1,
    subjectManifestHash,
    registryState: 'ACTIVE',
    riskLimits: [],
    allowedTemplates: [{ templateId: template.templateId, templateVersion: 1, packageTemplateManifestHash: templateHash }],
    allowedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    activationUnit: 'EVM_UNIX_SECONDS',
    activationValue: 1n,
    governanceReference: 'testnet-governance',
  };
}

const activeRegistryRecords = [
  registry('ASSET', baseAsset.assetId, baseAsset.assetManifestHash),
  registry('ASSET', quoteAsset.assetId, quoteAsset.assetManifestHash),
  registry('ADAPTER', nearAdapter.adapterId, nearAdapter.adapterManifestHash),
  registry('ADAPTER', farAdapter.adapterId, farAdapter.adapterManifestHash),
  registry('VENUE', venue.subjectId, venue.manifestHash),
  registry('MARKET', nearMarket.subjectId, nearMarket.manifestHash),
  registry('MARKET', farMarket.subjectId, farMarket.manifestHash),
];

function reducedPrice(value: bigint): readonly [bigint, bigint] {
  let left = value;
  let right = 10n ** 12n;
  while (right !== 0n) [left, right] = [right, left % right];
  return [value / left, (10n ** 12n) / left];
}

class Chain implements EvmOptionSpreadReadPort {
  readonly codes = new Map<string, Hex>([
    [BASE_TOKEN, codeHash('1')],
    [QUOTE_TOKEN, codeHash('2')],
    [ORACLE, codeHash('3')],
    [NEAR_MARKET, codeHash('4')],
    [FAR_MARKET, codeHash('5')],
    [ACCOUNT_FACTORY, codeHash('6')],
    [ACCOUNT, codeHash('7')],
    [NEAR_FACTORY, codeHash('8')],
    [FAR_FACTORY, codeHash('9')],
    [NEAR_ADAPTER, codeHash('a')],
    [FAR_ADAPTER, codeHash('b')],
  ]);

  async chainId() { return 84_532n; }
  async latestBlockTimestamp() { return NOW; }
  async codeHash(value: Address) { return this.codes.get(value.toLowerCase()); }

  async readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown> {
    const target = request.address.toLowerCase();
    if (target === NEAR_MARKET.toLowerCase() || target === FAR_MARKET.toLowerCase()) {
      const near = target === NEAR_MARKET.toLowerCase();
      switch (request.functionName) {
        case 'collateral': return QUOTE_TOKEN;
        case 'oracle': return ORACLE;
        case 'expiry': return near ? 87_400n : 173_800n;
        case 'takerFeeBps': return 10n;
        case 'initialMarginBps': return 2_000n;
        case 'maintenanceMarginBps': return 1_000n;
        case 'collateralScale': return 10n ** 12n;
        case 'oraclePriceWad': return 100n * 10n ** 18n;
        case 'currentFundingIndex': return 0n;
        case 'reserveOf': return 0n;
        case 'previewOpen': {
          assert.deepEqual(request.args, [near ? QUANTITY : -QUANTITY, 0n]);
          const price = (near ? 101n : 105n) * 10n ** 18n;
          return [price, price, price / 1_000n, 0n];
        }
        default: throw new Error(`unexpected market read ${request.functionName}`);
      }
    }
    if (target === ACCOUNT_FACTORY.toLowerCase()) {
      if (request.functionName === 'accountOf') return ACCOUNT;
      if (request.functionName === 'isAccount') return true;
      if (request.functionName === 'accountCodeHash') return codeHash('7');
    }
    if (target === ACCOUNT.toLowerCase()) {
      if (request.functionName === 'owner') return OWNER;
      if (request.functionName === 'nextNonce') return 0n;
      if (request.functionName === 'packageState') {
        return [[`0x${'00'.repeat(32)}`, 0, `0x${'00'.repeat(32)}`], `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, false];
      }
    }
    if (target === NEAR_FACTORY.toLowerCase() || target === FAR_FACTORY.toLowerCase()) {
      if (request.functionName === 'adapterOf') return target === NEAR_FACTORY.toLowerCase() ? NEAR_ADAPTER : FAR_ADAPTER;
      if (request.functionName === 'validateInstance') return true;
    }
    if (target === NEAR_ADAPTER.toLowerCase() || target === FAR_ADAPTER.toLowerCase()) {
      if (request.functionName === 'position') return [0n, 0n, 0n, 0n, 0n];
    }
    throw new Error(`unexpected read ${request.functionName} at ${request.address}`);
  }
}

function documents(nearLimit: bigint, farLimit: bigint): StoredStrategyPackageOrderDocuments {
  const [nearQuoteAtoms, nearBaseAtoms] = reducedPrice(nearLimit);
  const [farQuoteAtoms, farBaseAtoms] = reducedPrice(farLimit);
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'testnet',
    templateId: 'calendar-spread-v1',
    templateVersion: 1,
    packageTemplateManifestHash: templateHash,
    seriesId: 'ntbase-calendar-spread',
    seriesVersion: 1,
    seriesManifestHash: hash('a'),
    executionClassId: 'evm-atomic-calendar-spread',
    executionClassVersion: 1,
    executionClassManifestHash: hash('b'),
    lifecycleAction: 'ENTRY',
    owner: OWNER.toLowerCase(),
    strategyAccountRefs: [ACCOUNT.toLowerCase()],
    legs: [{
      legId: 'near-future',
      legFamily: 'FUTURE_OPEN',
      legTypeId: 'near-future',
      domain,
      adapter: nearAdapter,
      venue,
      market: nearMarket,
      assets: [baseAsset, quoteAsset],
      side: 'BUY',
      quantityAsset: baseAsset,
      quantityAtoms: QUANTITY,
      minimumQuantityAtoms: QUANTITY,
      limitPrice: {
        baseAsset,
        quoteAsset,
        quoteAtoms: nearQuoteAtoms,
        baseAtoms: nearBaseAtoms,
        roundingDirection: 'FLOOR',
      },
      maximumFeeQuoteAtoms: 250_000n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_200n,
    }, {
      legId: 'far-future',
      legFamily: 'FUTURE_OPEN',
      legTypeId: 'far-future',
      domain,
      adapter: farAdapter,
      venue,
      market: farMarket,
      assets: [baseAsset, quoteAsset],
      side: 'SELL',
      quantityAsset: baseAsset,
      quantityAtoms: QUANTITY,
      minimumQuantityAtoms: QUANTITY,
      limitPrice: {
        baseAsset,
        quoteAsset,
        quoteAtoms: farQuoteAtoms,
        baseAtoms: farBaseAtoms,
        roundingDirection: 'CEIL',
      },
      maximumFeeQuoteAtoms: 250_000n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC',
      legExpiryValue: 1_200n,
    }],
    dependencyEdges: [],
    executionGroups: [{ groupId: 'calendar-spread', kind: 'ALL_OR_NONE', legIds: ['near-future', 'far-future'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: {
      netting: hash('1'), privacy: hash('2'), solver: hash('3'), delivery: hash('4'),
      resource: hash('5'), portfolioRiskLimits: hash('6'),
    },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'EVM_UNIX_SECONDS',
    packageExpiryValue: 1_200n,
    nonce: 1n,
  });
  const order = strategyPackageOrder({
    version: 1,
    environment: graph.environment,
    templateId: graph.templateId,
    templateVersion: graph.templateVersion,
    packageTemplateManifestHash: graph.packageTemplateManifestHash,
    graphHash: packageGraphHash(graph),
    seriesId: graph.seriesId,
    seriesVersion: graph.seriesVersion,
    seriesManifestHash: graph.seriesManifestHash,
    executionClassId: graph.executionClassId,
    executionClassVersion: graph.executionClassVersion,
    executionClassManifestHash: graph.executionClassManifestHash,
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.FORWARD_BASIS,
    riskClassId: STRATEGY_RISK_CLASS_ID.CALENDAR,
    owner: graph.owner,
    settlementAccount: ACCOUNT.toLowerCase(),
    lifecycleAction: 'ENTRY',
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(baseAsset, QUANTITY),
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [{ asset: quoteAsset, maxAtoms: 250_000n }],
    maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 250_000n }],
    maximumNetworkFeesByAsset: [{ asset: quoteAsset, maxAtoms: 1_000n }],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: assetAmount(quoteAsset, 42_000_000n),
    maximumResidualValue: assetAmount(quoteAsset, 0n),
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 1_200n,
    nonce: 1n,
  });
  return {
    orderHashHex: Buffer.from(strategyPackageOrderHash(order)).toString('hex'),
    graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
    order,
    graph,
    recordedAtMs: 1,
  };
}

function pricing(chain: Chain): EvmCalendarSpreadPricingInput {
  return {
    chainId: 84_532n,
    domain,
    baseAsset,
    quoteAsset,
    baseToken: { address: BASE_TOKEN, expectedCodeHash: codeHash('1') },
    quoteToken: { address: QUOTE_TOKEN, expectedCodeHash: codeHash('2') },
    oracle: { address: ORACLE, expectedCodeHash: codeHash('3') },
    markets: [{
      role: 'near-future', adapter: nearAdapter, venue, market: nearMarket,
      contract: { address: NEAR_MARKET, expectedCodeHash: codeHash('4') },
    }, {
      role: 'far-future', adapter: farAdapter, venue, market: farMarket,
      contract: { address: FAR_MARKET, expectedCodeHash: codeHash('5') },
    }],
    protocolFeeBps: 5,
    solverFeeBps: 5,
    networkFeeQuoteAtoms: 1_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('c'),
    routeTtlSeconds: 30n,
    quoteTtlSeconds: 60n,
    chain,
    nonceSource: { nextNonce: () => 9n },
  };
}

test('prices an atomic EVM calendar spread and enforces both future limits', async () => {
  const port = createEvmCalendarSpreadGeneralizedPricing(pricing(new Chain()));
  const terms = await port.quote({
    documents: documents(102n, 104n),
    currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW },
  });
  assert.equal(terms.legEconomics[0]?.grossNotional.atoms, 101_000_000n);
  assert.equal(terms.legEconomics[0]?.marginDelta.atoms, 20_301_000n);
  assert.equal(terms.legEconomics[1]?.grossNotional.atoms, 105_000_000n);
  assert.equal(terms.legEconomics[1]?.marginDelta.atoms, 21_105_000n);
  assert.equal(terms.economics.templateId, 'calendar-spread-v1');
  assert.equal(terms.netPackageOutcomeAtoms, -308_000n);
  assert.equal(terms.quoteNonce, 9n);

  await assert.rejects(
    port.quote({
      documents: documents(100n, 104n),
      currentTime: { unit: 'EVM_UNIX_SECONDS', value: NOW },
    }),
    /near-future executable price violates the signed limit/,
  );
});

test('quotes and prepares an exact atomic EVM calendar spread entry', async () => {
  const chain = new Chain();
  const quotePricing = pricing(chain);
  const orderDocuments = documents(102n, 104n);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const quoteService = new GeneralizedStrategyQuoteService({
    packages: {
      getByOrder: async (requested) => protocolHex(requested) === orderDocuments.orderHashHex
        ? orderDocuments
        : undefined,
    },
    contexts: new GeneralizedStrategyQuoteContextRegistry([{
      laneId: 'base-calendar-spread',
      environment: 'testnet',
      templateManifest: template,
      executionClassId: orderDocuments.order.executionClassId,
      executionClassVersion: orderDocuments.order.executionClassVersion,
      executionClassManifestHash: orderDocuments.order.executionClassManifestHash,
      activeRegistryRecords,
      resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
      adapterSupport: [{
        domain,
        adapter: nearAdapter,
        legFamily: 'FUTURE_OPEN',
        supportedSides: ['BUY'],
        materializationClassId: 'naryx.evm.future-exact',
        executionPlanKind: 'EVM_ATOMIC_BATCH',
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      }, {
        domain,
        adapter: farAdapter,
        legFamily: 'FUTURE_OPEN',
        supportedSides: ['SELL'],
        materializationClassId: 'naryx.evm.future-exact',
        executionPlanKind: 'EVM_ATOMIC_BATCH',
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
      }],
      solverId: 'base-calendar-solver',
      solverCapabilityManifestHash: hash('e'),
      pricing: createEvmCalendarSpreadGeneralizedPricing(quotePricing),
      currentTime: async () => ({ unit: 'EVM_UNIX_SECONDS', value: NOW }),
    }]),
    signer: {
      scheme: 'ED25519',
      verificationKey: Uint8Array.from(spki.subarray(spki.length - 32)),
      signDigest: (digest) => Uint8Array.from(sign(null, digest, privateKey)),
    },
  });
  const quoted = await quoteService.quote({
    orderHash: orderDocuments.orderHashHex,
    idempotencyKey: 'evm-calendar-spread-quote-0001',
  });
  const stored: StoredStrategyPackageDocuments = {
    ...orderDocuments,
    quoteHashHex: quoted.quoteHash,
    routeHashHex: quoted.routeHash,
    quote: quoted.quote,
    route: quoted.route,
  };
  const quoteHash = hexToBytes(`0x${quoted.quoteHash}`) as Hash32;
  const preparationLane = Object.freeze({
    environment: 'testnet' as const,
    templateManifest: template,
    activeRegistryRecords,
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
    pricing: quotePricing,
    accountFactory: { address: ACCOUNT_FACTORY, expectedCodeHash: codeHash('6') },
    expectedStrategyAccountCodeHash: codeHash('7'),
    adapters: [{
      role: 'near-future' as const,
      factory: { address: NEAR_FACTORY, expectedCodeHash: codeHash('8') },
      expectedAdapterCodeHash: codeHash('a'),
      maximumGasLimit: 600_000n,
    }, {
      role: 'far-future' as const,
      factory: { address: FAR_FACTORY, expectedCodeHash: codeHash('9') },
      expectedAdapterCodeHash: codeHash('b'),
      maximumGasLimit: 600_000n,
    }] as const,
    solver: SOLVER,
    packageIds: { resolvePackageId: async () => undefined },
  });
  const provisioning = await new EvmOptionSpreadProvisioningResolver([preparationLane]).resolve(orderDocuments);
  assert.equal(provisioning.ready, true);
  assert.equal(provisioning.transactions.length, 0);
  const preparation = new StrategyPreparationService(
    {
      getByQuote: async (requested) => protocolHex(requested) === quoted.quoteHash ? stored : undefined,
    },
    new EvmCalendarSpreadPreparationContextResolver([preparationLane]),
  );
  const prepared = await preparation.prepareByQuote(quoteHash);
  assert.equal(prepared?.domains[0]?.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (prepared?.domains[0]?.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('missing EVM preparation');
  const envelope = prepared.domains[0].envelope;
  assert.equal(envelope.calls.length, 2);
  assert.deepEqual(envelope.calls.map((call) => call.approvalAtoms), [21_105_000n, 20_301_000n]);
  assert.equal(envelope.execution.fees.protocolFeeAtoms, 50_500n);
  assert.equal(envelope.execution.fees.solverFeeAtoms, 50_500n);
  assert.notEqual(envelope.execution.nextStateHash, `0x${'00'.repeat(32)}`);
});

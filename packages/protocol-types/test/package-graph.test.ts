import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  adapterRef,
  assetRef,
  compilePackageGraph,
  compileTypedStrategyRoute,
  domainRef,
  packageGraph,
  packageGraphHash,
  packageTemplateManifestHash,
  simulatePackageGraphFailures,
  toHex,
  versionedManifestRef,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type DomainRegistryRecordInput,
  type PackageGraphCompileContext,
  type PackageGraphInput,
  type PackageLegInput,
  type PackageTemplateManifestInput,
  type VersionedManifestRef,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);
const svm = domainRef('svm:devnet', 1, hash('1'));
const hl = domainRef('hypercore:testnet', 1, hash('2'));
const sol = assetRef('sol', hash('3'), 9);
const usdc = assetRef('usdc', hash('4'), 6);
const spotAdapter = adapterRef({ adapterId: 'spot-adapter-v1', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const perpAdapter = adapterRef({ adapterId: 'perp-adapter-v1', adapterManifestVersion: 1, adapterManifestHash: hash('6') });
const spotVenue = versionedManifestRef('spot-venue', 1, hash('7'));
const perpVenue = versionedManifestRef('perp-venue', 1, hash('8'));
const spotMarket = versionedManifestRef('sol-usdc-spot', 1, hash('9'));
const perpMarket = versionedManifestRef('sol-usdc-perp', 1, hash('a'));

const template: PackageTemplateManifestInput = {
  manifestVersion: 1,
  environment: 'devnet',
  templateId: 'basis-graph-v1',
  templateVersion: 1,
  supportedDomains: [svm, hl],
  orderSchemaHash: hash('b'),
  quoteSchemaHash: hash('c'),
  routeSchemaHash: hash('d'),
  receiptSchemaHash: hash('e'),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 3,
  legTypes: ['spot-purchase', 'perp-sale', 'margin-deposit'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION', 'BATCHED_IOC_WITH_RECOVERY'],
  allowedSpotAdapterIds: [spotAdapter.adapterId],
  allowedPerpAdapterIds: [perpAdapter.adapterId],
  riskPolicyHash: hash('f'),
};

function record(domain: DomainRef, kind: 'ASSET' | 'ADAPTER' | 'VENUE' | 'MARKET', reference: AssetRef | AdapterRef | VersionedManifestRef, overrides: Partial<DomainRegistryRecordInput> = {}): DomainRegistryRecordInput {
  const adapter = 'adapterId' in reference;
  const asset = 'assetId' in reference;
  return {
    recordVersion: 1,
    environment: 'devnet',
    domain,
    recordKind: kind,
    subjectId: adapter ? reference.adapterId : asset ? reference.assetId : reference.subjectId,
    subjectManifestVersion: asset ? 1 : adapter ? reference.adapterManifestVersion : reference.manifestVersion,
    subjectManifestHash: asset ? reference.assetManifestHash : adapter ? reference.adapterManifestHash : reference.manifestHash,
    registryState: 'ACTIVE',
    riskLimits: [],
    allowedTemplates: [{ templateId: template.templateId, templateVersion: template.templateVersion, packageTemplateManifestHash: packageTemplateManifestHash(template) }],
    allowedSettlementClasses: ['ATOMIC_POSTCONDITION', 'BATCHED_IOC_WITH_RECOVERY'],
    activationUnit: 'EVM_UNIX_SECONDS',
    activationValue: 900n,
    governanceReference: 'governance-devnet-v1',
    ...overrides,
  };
}

const registry = (domain: DomainRef) => [
  record(domain, 'ASSET', sol),
  record(domain, 'ASSET', usdc),
  record(domain, 'ADAPTER', spotAdapter),
  record(domain, 'ADAPTER', perpAdapter),
  record(domain, 'VENUE', spotVenue),
  record(domain, 'VENUE', perpVenue),
  record(domain, 'MARKET', spotMarket),
  record(domain, 'MARKET', perpMarket),
];

function leg(legId: string, overrides: Partial<PackageLegInput> = {}): PackageLegInput {
  return {
    legId,
    legFamily: 'SPOT_SWAP',
    legTypeId: 'spot-purchase',
    domain: svm,
    adapter: spotAdapter,
    venue: spotVenue,
    market: spotMarket,
    assets: [sol, usdc],
    side: 'BUY',
    quantityAsset: sol,
    quantityAtoms: 1_000_000_000n,
    minimumQuantityAtoms: 1_000_000_000n,
    limitPrice: { baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 20n, roundingDirection: 'CEIL' },
    maximumFeeQuoteAtoms: 10_000n,
    preconditionHashes: ['c1'.repeat(32)],
    postconditionHashes: ['c2'.repeat(32)],
    timeInForce: 'FOK',
    legExpiryValue: 1_900n,
    ...overrides,
  };
}

const perpLeg = (overrides: Partial<PackageLegInput> = {}) =>
  leg('perp', { legFamily: 'PERP_OPEN', legTypeId: 'perp-sale', adapter: perpAdapter, venue: perpVenue, market: perpMarket, side: 'SELL', ...overrides });

function graph(overrides: Partial<PackageGraphInput> = {}): PackageGraphInput {
  return {
    graphVersion: 1,
    environment: 'devnet',
    templateId: template.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: packageTemplateManifestHash(template),
    seriesId: 'sol-basis',
    seriesVersion: 1,
    seriesManifestHash: hash('b'),
    executionClassId: 'sol-basis-atomic',
    executionClassVersion: 1,
    executionClassManifestHash: hash('1'),
    lifecycleAction: 'ENTRY',
    owner: 'trader-1',
    strategyAccountRefs: ['strategy-1'],
    legs: [leg('spot'), perpLeg()],
    dependencyEdges: [],
    executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['spot', 'perp'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: { netting: 'd1'.repeat(32), privacy: 'd2'.repeat(32), solver: 'd3'.repeat(32), delivery: 'd4'.repeat(32), resource: 'd5'.repeat(32), portfolioRiskLimits: 'd6'.repeat(32) },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'EVM_UNIX_SECONDS',
    packageExpiryValue: 2_000n,
    nonce: 1n,
    ...overrides,
  };
}

const context = (overrides: Partial<PackageGraphCompileContext> = {}): PackageGraphCompileContext => ({
  templateManifest: template,
  activeRegistryRecords: [...registry(svm), ...registry(hl)],
  resourceLimits: [{ domainId: 'svm:devnet', maximumActionsPerTransaction: 4 }, { domainId: 'hypercore:testnet', maximumActionsPerTransaction: 2 }],
  currentTime: { unit: 'EVM_UNIX_SECONDS', value: 1_000n },
  ...overrides,
});

describe('package graph structure', () => {
  test('a graph is ordered canonically and its hash ignores input order', () => {
    const reordered = graph({ legs: [perpLeg(), leg('spot')], executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['perp', 'spot'] }] });
    assert.equal(toHex(packageGraphHash(reordered)), toHex(packageGraphHash(graph())));
    assert.notEqual(toHex(packageGraphHash(graph({ nonce: 2n }))), toHex(packageGraphHash(graph())));
  });

  test('dependencies must form an acyclic graph over known legs', () => {
    const margin = leg('margin', { legFamily: 'MARGIN_DEPOSIT', legTypeId: 'margin-deposit', side: 'NONE', assets: [usdc], quantityAsset: usdc, limitPrice: undefined } as never);
    const ordered = packageGraph(graph({ legs: [leg('spot'), perpLeg(), margin], dependencyEdges: [{ fromLegId: 'margin', toLegId: 'perp' }], executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['margin', 'perp', 'spot'] }] }));
    assert.deepEqual(ordered.stages, [['margin', 'spot'], ['perp']]);
    assert.throws(() => packageGraph(graph({ dependencyEdges: [{ fromLegId: 'spot', toLegId: 'perp' }, { fromLegId: 'perp', toLegId: 'spot' }] })), /cycle/);
    assert.throws(() => packageGraph(graph({ dependencyEdges: [{ fromLegId: 'spot', toLegId: 'spot' }] })), /itself/);
    assert.throws(() => packageGraph(graph({ dependencyEdges: [{ fromLegId: 'spot', toLegId: 'ghost' }] })), /unknown leg/);
  });

  test('a graph with any partial state needs a signed completion or rollback for every leg, within its bounds', () => {
    const split = { executionGroups: [{ groupId: 'spot-only', kind: 'EXACT_FILL' as const, legIds: ['spot'] }, { groupId: 'perp-only', kind: 'EXACT_FILL' as const, legIds: ['perp'] }], settlementClass: 'BATCHED_IOC_WITH_RECOVERY' as const };
    assert.throws(() => packageGraph(graph(split)), /no signed completion or rollback/);
    const slots = [
      { legId: 'spot', action: 'ROLLBACK' as const, maximumQuantityAtoms: 1_000_000_000n, maximumCostQuoteAtoms: 5_000n },
      { legId: 'perp', action: 'COMPLETE' as const, maximumQuantityAtoms: 1_000_000_000n, maximumCostQuoteAtoms: 5_000n },
    ];
    assert.equal(packageGraph(graph({ ...split, recoverySlots: slots, maximumRecoveryCostQuoteAtoms: 10_000n })).recoverySlots.length, 2);
    assert.throws(() => packageGraph(graph({ ...split, recoverySlots: slots, maximumRecoveryCostQuoteAtoms: 9_999n })), /more than the signed recovery cost bound/);
    assert.throws(
      () => packageGraph(graph({ ...split, recoverySlots: [{ ...slots[0]!, maximumQuantityAtoms: 1_000_000_001n }, slots[1]!], maximumRecoveryCostQuoteAtoms: 10_000n })),
      /cannot exceed it/,
    );
    assert.throws(() => packageGraph(graph({ executionGroups: [{ groupId: 'partial', kind: 'BOUNDED_PARTIAL', legIds: ['spot', 'perp'] }] })), /residual bound/);
    assert.throws(() => packageGraph(graph({ legs: [leg('spot', { legExpiryValue: 2_001n }), perpLeg()] })), /outlive its package/);
  });
});

describe('package graph compilation', () => {
  test('an atomic two-leg graph compiles against the template, active registry, and resource limits', () => {
    const compiled = compilePackageGraph(graph(), context());
    assert.equal(compiled.compiled, true);
    if (compiled.compiled) {
      assert.equal(toHex(compiled.graphHash), toHex(packageGraphHash(graph())));
      assert.deepEqual(compiled.groups.map((group) => [group.groupId, group.domainId, group.actionCount]), [['atomic', 'svm:devnet', 2]]);
      assert.equal(compiled.worstCaseRecoveryCostQuoteAtoms, 0n);
    }
  });

  test('a graph outside its template or registry is rejected with every reason', () => {
    const reasons = (input: PackageGraphInput, ctx = context()) => {
      const result = compilePackageGraph(input, ctx);
      return result.compiled ? [] : result.reasons;
    };
    assert.deepEqual(reasons(graph({ legs: [leg('spot', { legTypeId: 'option-sale' }), perpLeg()] })), ['LEG_TYPE_NOT_IN_TEMPLATE']);
    assert.deepEqual(reasons(graph(), context({ activeRegistryRecords: registry(svm).filter((entry) => entry.recordKind !== 'MARKET') })), ['MARKET_NOT_ACTIVE']);
    const paused = registry(svm).map((entry) => (entry.recordKind === 'ADAPTER' ? { ...entry, registryState: 'EXIT_ONLY' as const } : entry));
    assert.deepEqual(reasons(graph(), context({ activeRegistryRecords: paused })), ['ADAPTER_NOT_ACTIVE']);
    assert.deepEqual(reasons(graph({ lifecycleAction: 'EXIT' }), context({ activeRegistryRecords: paused })), []);
    assert.deepEqual(reasons(graph(), context({ currentTime: { unit: 'EVM_UNIX_SECONDS', value: 2_000n } })), ['EXPIRED']);
    // A foreign template hash is also a template no registry record allows.
    assert.deepEqual(reasons(graph({ packageTemplateManifestHash: '99'.repeat(32) })), ['ADAPTER_NOT_ACTIVE', 'ASSET_NOT_ACTIVE', 'MARKET_NOT_ACTIVE', 'TEMPLATE_MISMATCH', 'VENUE_NOT_ACTIVE']);
    // An atomic group cannot span two domains: no rollback boundary exists across them.
    assert.deepEqual(reasons(graph({ legs: [leg('spot'), perpLeg({ domain: hl })] })), ['ROLLBACK_BOUNDARY_MISSING']);
    // An overflowing atomic group is rejected, never relabeled as atomic.
    assert.deepEqual(reasons(graph(), context({ resourceLimits: [{ domainId: 'svm:devnet', maximumActionsPerTransaction: 1 }] })), ['RESOURCE_LIMIT_EXCEEDED']);
    assert.deepEqual(reasons(graph(), context({ resourceLimits: [] })), ['RESOURCE_LIMIT_UNKNOWN']);
  });

  test('a cross-domain graph compiles only as a recoverable class with every leg covered', () => {
    const slots = [
      { legId: 'spot', action: 'ROLLBACK' as const, maximumQuantityAtoms: 1_000_000_000n, maximumCostQuoteAtoms: 5_000n },
      { legId: 'perp', action: 'COMPLETE' as const, maximumQuantityAtoms: 1_000_000_000n, maximumCostQuoteAtoms: 7_000n },
    ];
    const crossDomain = graph({
      legs: [leg('spot'), perpLeg({ domain: hl })],
      dependencyEdges: [{ fromLegId: 'spot', toLegId: 'perp' }],
      executionGroups: [],
      settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
      recoverySlots: slots,
      maximumRecoveryCostQuoteAtoms: 12_000n,
    });
    const compiled = compilePackageGraph(crossDomain, context());
    assert.equal(compiled.compiled, true);
    if (compiled.compiled) {
      assert.deepEqual(compiled.stages, [['spot'], ['perp']]);
      assert.deepEqual(compiled.ungroupedLegIds, ['perp', 'spot']);
      assert.equal(compiled.worstCaseRecoveryCostQuoteAtoms, 12_000n);
    }
    // If the perp stage stops after the spot settled, the spot rollback or the perp completion gets out.
    assert.deepEqual(simulatePackageGraphFailures(crossDomain).map((point) => [point.stage, point.settledBeforeLegIds, point.recoverable, point.worstCaseRecoveryCostQuoteAtoms]), [[1, ['spot'], true, 12_000n]]);
    // Slots that cannot undo the settled spot or finish the open perp leave a state with no way out.
    const noWayBack = { ...crossDomain, recoverySlots: [{ ...slots[0]!, legId: 'perp', action: 'ROLLBACK' as const }, { ...slots[1]!, legId: 'spot', action: 'COMPLETE' as const }] };
    assert.equal(simulatePackageGraphFailures(noWayBack)[0]?.recoverable, false);
    const stuck = compilePackageGraph(noWayBack, context());
    assert.deepEqual(stuck.compiled ? [] : stuck.reasons, ['PARTIAL_STATE_UNRECOVERABLE']);
    // Two parallel legs: one that can only roll back and one that can only complete can be split badly.
    const parallel = { ...crossDomain, dependencyEdges: [], legs: [leg('spot'), perpLeg()], recoverySlots: slots };
    assert.equal(simulatePackageGraphFailures(parallel)[0]?.recoverable, false);
    const bothWays = { ...parallel, recoverySlots: [...slots, { ...slots[0]!, action: 'COMPLETE' as const, maximumCostQuoteAtoms: 0n }], maximumRecoveryCostQuoteAtoms: 12_000n };
    assert.equal(simulatePackageGraphFailures(bothWays)[0]?.recoverable, true);
    assert.deepEqual(simulatePackageGraphFailures(graph()), []);
    const atomicClaim = compilePackageGraph({ ...crossDomain, settlementClass: 'ATOMIC_POSTCONDITION' }, context());
    assert.deepEqual(atomicClaim.compiled ? [] : atomicClaim.reasons, ['ATOMIC_CLASS_NEEDS_ONE_ATOMIC_GROUP']);
  });
});

describe('typed strategy route compilation', () => {
  const cashTemplate: PackageTemplateManifestInput = {
    ...template,
    templateId: 'cash-and-carry-v1',
    legCount: 2,
    legTypes: ['spot-purchase', 'perp-sale'],
  };
  const cashTemplateRef = {
    templateId: cashTemplate.templateId,
    templateVersion: cashTemplate.templateVersion,
    packageTemplateManifestHash: packageTemplateManifestHash(cashTemplate),
  };
  const cashGraph = graph({
    templateId: cashTemplate.templateId,
    packageTemplateManifestHash: cashTemplateRef.packageTemplateManifestHash,
  });
  const cashContext: PackageGraphCompileContext = {
    ...context(),
    templateManifest: cashTemplate,
    activeRegistryRecords: context().activeRegistryRecords.map((entry) => ({
      ...entry,
      allowedTemplates: [cashTemplateRef],
    })),
  };
  const support = [
    {
      domain: svm,
      adapter: spotAdapter,
      legFamily: 'SPOT_SWAP' as const,
      supportedSides: ['BUY'] as const,
      materializationClassId: 'orca-exact-input-v1',
      executionPlanKind: 'SVM_ATOMIC_CPI' as const,
      supportedSettlementClasses: ['ATOMIC_POSTCONDITION'] as const,
    },
    {
      domain: svm,
      adapter: perpAdapter,
      legFamily: 'PERP_OPEN' as const,
      supportedSides: ['SELL'] as const,
      materializationClassId: 'short-perp-open-v1',
      executionPlanKind: 'SVM_ATOMIC_CPI' as const,
      supportedSettlementClasses: ['ATOMIC_POSTCONDITION'] as const,
    },
  ];
  const compile = (adapterSupport: Parameters<typeof compileTypedStrategyRoute>[0]['adapterSupport']) => compileTypedStrategyRoute({
    graph: cashGraph,
    compileContext: cashContext,
    adapterSupport,
    orderHash: hash('d'),
    solverId: 'solver-1',
    routeExpiryUnit: 'EVM_UNIX_SECONDS',
    routeExpiryValue: 1_800n,
  });

  test('binds every leg to a materializer that supports its exact side', () => {
    const result = compile(support);
    assert.equal(result.compiled, true);
    if (result.compiled) {
      assert.deepEqual(result.route.legs.map((value) => [value.legId, value.materializationClassId]), [
        ['perp', 'short-perp-open-v1'],
        ['spot', 'orca-exact-input-v1'],
      ]);
    }
  });

  test('rejects a leg when the adapter only supports its opposite side', () => {
    const result = compile([{ ...support[0]!, supportedSides: ['SELL'] }, support[1]!]);
    assert.deepEqual(result.compiled ? [] : result.reasons, ['ADAPTER_ACTION_UNSUPPORTED']);
  });

  test('rejects overlapping materializers instead of selecting by input order', () => {
    const result = compile([
      ...support,
      { ...support[0]!, materializationClassId: 'second-spot-materializer-v1' },
    ]);
    assert.deepEqual(result.compiled ? [] : result.reasons, ['ADAPTER_ACTION_AMBIGUOUS']);
  });
});

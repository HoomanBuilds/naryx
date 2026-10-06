import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  adapterRef,
  assetAmount,
  assetRef,
  domainRef,
  packageGraph,
  packageGraphHash,
  packageTemplateManifestHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  STRATEGY_QUOTE_CONVENTION_ID,
  STRATEGY_RISK_CLASS_ID,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type PackageGraphInput,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import { GeneralizedStrategyQuoteError, GeneralizedStrategyQuoteService } from '../src/index.js';

const domain = domainRef('eip155:84532', 1, '11'.repeat(32));
const sol = assetRef('sol', '22'.repeat(32), 9);
const usdc = assetRef('usdc', '33'.repeat(32), 6);
const spotAdapter = adapterRef({ adapterId: 'spot-adapter', adapterManifestVersion: 1, adapterManifestHash: '44'.repeat(32) });
const perpAdapter = adapterRef({ adapterId: 'perp-adapter', adapterManifestVersion: 1, adapterManifestHash: '55'.repeat(32) });
const venue = versionedManifestRef('venue', 1, '66'.repeat(32));
const spotMarket = versionedManifestRef('sol-usdc-spot', 1, '77'.repeat(32));
const perpMarket = versionedManifestRef('sol-usdc-perp', 1, '88'.repeat(32));
const template: PackageTemplateManifestInput = {
  manifestVersion: 1,
  environment: 'testnet',
  templateId: 'cash-and-carry-v1',
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: '91'.repeat(32),
  quoteSchemaHash: '92'.repeat(32),
  routeSchemaHash: '93'.repeat(32),
  receiptSchemaHash: '94'.repeat(32),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 2,
  legTypes: ['spot-purchase', 'perp-sale'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [spotAdapter.adapterId],
  allowedPerpAdapterIds: [perpAdapter.adapterId],
  riskPolicyHash: '95'.repeat(32),
};
const templateHash = packageTemplateManifestHash(template);

function record(
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

const graphInput: PackageGraphInput = {
  graphVersion: 1,
  environment: 'testnet',
  templateId: template.templateId,
  templateVersion: 1,
  packageTemplateManifestHash: templateHash,
  seriesId: 'sol-basis',
  seriesVersion: 1,
  seriesManifestHash: 'a1'.repeat(32),
  executionClassId: 'base-atomic-basis',
  executionClassVersion: 1,
  executionClassManifestHash: 'a2'.repeat(32),
  lifecycleAction: 'ENTRY',
  owner: 'trader',
  strategyAccountRefs: ['strategy-account'],
  legs: [{
    legId: 'spot',
    legFamily: 'SPOT_SWAP',
    legTypeId: 'spot-purchase',
    domain,
    adapter: spotAdapter,
    venue,
    market: spotMarket,
    assets: [sol, usdc],
    side: 'BUY',
    quantityAsset: sol,
    quantityAtoms: 1_000_000_000n,
    minimumQuantityAtoms: 1_000_000_000n,
    limitPrice: { baseAsset: sol, quoteAsset: usdc, quoteAtoms: 4n, baseAtoms: 25n, roundingDirection: 'CEIL' },
    maximumFeeQuoteAtoms: 0n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'FOK',
    legExpiryValue: 1_500n,
  }, {
    legId: 'perp',
    legFamily: 'PERP_OPEN',
    legTypeId: 'perp-sale',
    domain,
    adapter: perpAdapter,
    venue,
    market: perpMarket,
    assets: [sol, usdc],
    side: 'SELL',
    quantityAsset: sol,
    quantityAtoms: 1_000_000_000n,
    minimumQuantityAtoms: 1_000_000_000n,
    limitPrice: { baseAsset: sol, quoteAsset: usdc, quoteAtoms: 7n, baseAtoms: 50n, roundingDirection: 'FLOOR' },
    maximumFeeQuoteAtoms: 0n,
    preconditionHashes: [],
    postconditionHashes: [],
    timeInForce: 'FOK',
    legExpiryValue: 1_500n,
  }],
  dependencyEdges: [],
  executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['spot', 'perp'] }],
  settlementClass: 'ATOMIC_POSTCONDITION',
  policyHashes: {
    netting: 'b1'.repeat(32),
    privacy: 'b2'.repeat(32),
    solver: 'b3'.repeat(32),
    delivery: 'b4'.repeat(32),
    resource: 'b5'.repeat(32),
    portfolioRiskLimits: 'b6'.repeat(32),
  },
  recoverySlots: [],
  maximumRecoveryCostQuoteAtoms: 0n,
  expiryUnit: 'EVM_UNIX_SECONDS',
  packageExpiryValue: 2_000n,
  nonce: 1n,
};
const graph = packageGraph(graphInput);
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
  quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.ANNUALIZED_NET_YIELD,
  riskClassId: STRATEGY_RISK_CLASS_ID.DELTA_NEUTRAL_BASIS,
  owner: graph.owner,
  settlementAccount: 'strategy-account',
  lifecycleAction: 'ENTRY',
  settlementClass: 'ATOMIC_POSTCONDITION',
  packageOrderType: 'LIMIT',
  packageTimeInForce: 'FOK',
  economicQuantity: assetAmount(sol, 1_000_000_000n),
  quoteAsset: usdc,
  metricLimits: [],
  maximumServiceFeesByAsset: [],
  maximumVenueFeesByAsset: [],
  maximumNetworkFeesByAsset: [],
  maximumRecoveryCostByAsset: [],
  maximumMarginIncrease: assetAmount(usdc, 50_000_000n),
  maximumResidualValue: assetAmount(usdc, 0n),
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: 1_500n,
  nonce: 1n,
});
const orderHash = strategyPackageOrderHash(order);
const activeRegistryRecords = [
  record('ASSET', sol.assetId, sol.assetManifestHash),
  record('ASSET', usdc.assetId, usdc.assetManifestHash),
  record('ADAPTER', spotAdapter.adapterId, spotAdapter.adapterManifestHash),
  record('ADAPTER', perpAdapter.adapterId, perpAdapter.adapterManifestHash),
  record('VENUE', venue.subjectId, venue.manifestHash),
  record('MARKET', spotMarket.subjectId, spotMarket.manifestHash),
  record('MARKET', perpMarket.subjectId, perpMarket.manifestHash),
];

test('generalized RFQ prices, compiles, signs, validates, and replays one committed order', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const verificationKey = Uint8Array.from(spki.subarray(spki.length - 32));
  let pricingCalls = 0;
  const service = new GeneralizedStrategyQuoteService({
    packages: {
      getByOrder: async (hash) => {
        assert.deepEqual(hash, orderHash);
        return {
          orderHashHex: Buffer.from(orderHash).toString('hex'),
          graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
          order,
          graph,
          recordedAtMs: 1,
        };
      },
    },
    contexts: {
      resolve: async () => ({
        compileContext: {
          templateManifest: template,
          activeRegistryRecords,
          resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
          currentTime: { unit: 'EVM_UNIX_SECONDS', value: 1_000n },
        },
        adapterSupport: [{
          domain,
          adapter: spotAdapter,
          legFamily: 'SPOT_SWAP',
          supportedSides: ['BUY'],
          materializationClassId: 'evm-spot',
          executionPlanKind: 'EVM_ATOMIC_BATCH',
          supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
        }, {
          domain,
          adapter: perpAdapter,
          legFamily: 'PERP_OPEN',
          supportedSides: ['SELL'],
          materializationClassId: 'evm-perp',
          executionPlanKind: 'EVM_ATOMIC_BATCH',
          supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
        }],
        solverId: 'solver',
        solverCapabilityManifestHash: 'c1'.repeat(32),
        pricing: {
          quote: async () => {
            pricingCalls += 1;
            const executionPrice = { baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 20n, roundingDirection: 'TOWARD_ZERO' as const };
            return {
              quoteMode: 'EXECUTION_COMMITMENT',
              economics: {
                templateId: 'cash-and-carry-v1',
                spotNotionalAtoms: 150_000_000n,
                derivativeNotionalAtoms: 150_000_000n,
                expectedFundingAtoms: 1n,
                borrowCostAtoms: 0n,
                totalFeesAtoms: 0n,
                capitalRequiredAtoms: 50_000_000n,
                holdingDurationMs: 86_400_000n,
                exitBasisBps: 0n,
              },
              legEconomics: [{
                legId: 'spot',
                quantity: assetAmount(sol, 1_000_000_000n),
                executionPrice,
                grossNotional: assetAmount(usdc, 150_000_000n),
                marginDelta: assetAmount(usdc, 0n),
                venueFee: assetAmount(usdc, 0n),
                builderFee: assetAmount(usdc, 0n),
                residualValue: assetAmount(usdc, 0n),
              }, {
                legId: 'perp',
                quantity: assetAmount(sol, 1_000_000_000n),
                executionPrice,
                grossNotional: assetAmount(usdc, 150_000_000n),
                marginDelta: assetAmount(usdc, 50_000_000n),
                venueFee: assetAmount(usdc, 0n),
                builderFee: assetAmount(usdc, 0n),
                residualValue: assetAmount(usdc, 0n),
              }],
              netPackageOutcomeAtoms: 1n,
              serviceCharges: [],
              passThroughCosts: [],
              feePolicyVersion: 1,
              feePolicyManifestHash: 'c2'.repeat(32),
              routeExpiryValue: 1_200n,
              validUntilValue: 1_300n,
              quoteNonce: 1n,
            };
          },
        },
      }),
    },
    signer: {
      scheme: 'ED25519',
      verificationKey,
      signDigest: (digest) => Uint8Array.from(sign(null, digest, privateKey)),
    },
  });
  const request = { orderHash: Buffer.from(orderHash).toString('hex'), idempotencyKey: 'strategy-quote-0001' };
  const first = await service.quote(request);
  const replay = await service.quote(request);
  assert.equal(first.status, 'SIGNED');
  assert.equal(first.quote.solverId, 'solver');
  assert.deepEqual(first.route.legs.map((leg) => leg.materializationClassId), ['evm-perp', 'evm-spot']);
  assert.equal(replay.quoteHash, first.quoteHash);
  assert.equal(pricingCalls, 1);
  await assert.rejects(
    () => service.quote({ orderHash: 'ff'.repeat(32), idempotencyKey: request.idempotencyKey }),
    (error: unknown) => error instanceof GeneralizedStrategyQuoteError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

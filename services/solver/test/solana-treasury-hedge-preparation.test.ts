import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  deriveSolanaMultiStrategyAccount,
  deriveSolanaPackageInventoryAddresses,
} from '@naryx/adapter-solana';
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
  versionedManifestRef,
  type PackageTemplateManifestInput,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import {
  SolanaTreasuryHedgeProvisioningResolver,
  SolanaTreasuryHedgePreparationContextResolver,
  type SolanaTreasuryHedgePricingInput,
  type StoredStrategyPackageDocuments,
} from '../src/index.js';
import type {
  SolanaDevnetAccount,
  SolanaDevnetSolverReadPort,
} from '../src/solana-devnet-rpc.js';
import {
  BorshWriter,
  TOKEN_PROGRAM_ID,
  accountDiscriminator,
  associatedTokenAddress,
  type TestPerpMarketState,
} from '../src/solana-devnet-wire.js';

const hash = (byte: string) => byte.repeat(64);
const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const key = (byte: number) => new PublicKey(bytes(byte)).toBase58();
const SLOT = 1_000n;
const QUANTITY = 2_000_000_000n;
const OWNER = key(1);
const CORE_PROGRAM = key(2);
const MULTI_PROGRAM = key(3);
const INVENTORY_PROGRAM = key(4);
const INVENTORY_PROGRAM_DATA = key(5);
const HEDGE_PROGRAM = key(6);
const HEDGE_PROGRAM_DATA = key(7);
const TEST_PERP_PROGRAM = key(8);
const SOLVER = key(9);
const INVENTORY_MINT = key(10);
const QUOTE_MINT = key(11);
const MARKET = key(12);
const ORACLE = key(13);
const STRATEGY_ID = bytes(14);

const domain = domainRef('svm:devnet', 1, hash('1'));
const inventoryAsset = assetRef(INVENTORY_MINT, hash('2'), 9);
const quoteAsset = assetRef(QUOTE_MINT, hash('3'), 6);
const inventoryAdapter = adapterRef({
  adapterId: 'solana-inventory-position',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('4'),
});
const hedgeAdapter = adapterRef({
  adapterId: 'solana-treasury-hedge',
  adapterManifestVersion: 1,
  adapterManifestHash: hash('5'),
});
const venue = versionedManifestRef('naryx-solana-conformance', 1, hash('6'));
const inventoryMarket = versionedManifestRef('sol-inventory', 1, hash('7'));
const hedgeMarket = versionedManifestRef('sol-test-perpetual', 1, hash('8'));
const templateInput: PackageTemplateManifestInput = {
  manifestVersion: 2,
  environment: 'devnet',
  templateId: 'treasury-inventory-hedge-v1',
  templateVersion: 1,
  supportedDomains: [domain],
  orderSchemaHash: hash('9'),
  quoteSchemaHash: hash('a'),
  routeSchemaHash: hash('b'),
  receiptSchemaHash: hash('c'),
  entryCompilerVersion: 1,
  exitCompilerVersion: 1,
  legCount: 2,
  legTypes: ['inventory-position', 'treasury-hedge'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'],
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [],
  allowedPerpAdapterIds: [hedgeAdapter.adapterId],
  allowedAdapterIds: [inventoryAdapter.adapterId, hedgeAdapter.adapterId],
  riskPolicyHash: hash('d'),
};
const template = packageTemplateManifest(templateInput);
const templateHash = packageTemplateManifestHash(template);
const market: TestPerpMarketState = Object.freeze({
  oracle: ORACLE,
  feedIdHex: hash('e'),
  collateralMint: QUOTE_MINT,
  collateralVault: key(15),
  feeVault: key(16),
  insuranceVault: key(17),
  collateralDecimals: 6,
  baseDecimals: 9,
  maxPriceAgeSeconds: 60,
  maxConfidenceBps: 50,
  takerFeeBps: 5,
  halfSpreadBps: 2,
  impactBpsPerUnit: 1,
  maxSlippageBps: 100,
  initialMarginBps: 1_000,
  maintenanceMarginBps: 500,
  impactUnitLots: 10_000n,
  baseLotAtoms: 1_000_000n,
  quoteTickAtomsPerBaseLot: 1n,
  maxPositionLots: 1_000_000n,
  pauseOpens: false,
});

function documents(): StoredStrategyPackageDocuments {
  const strategyAccount = deriveSolanaMultiStrategyAccount({ programId: MULTI_PROGRAM, owner: OWNER });
  const graph = packageGraph({
    graphVersion: 1,
    environment: 'devnet',
    templateId: template.templateId,
    templateVersion: 1,
    packageTemplateManifestHash: templateHash,
    seriesId: 'sol-treasury-hedge',
    seriesVersion: 1,
    seriesManifestHash: hash('f'),
    executionClassId: 'solana-atomic-treasury-hedge',
    executionClassVersion: 1,
    executionClassManifestHash: hash('1'),
    lifecycleAction: 'ENTRY',
    owner: OWNER,
    strategyAccountRefs: [strategyAccount.toBase58()],
    legs: [{
      legId: 'inventory-position', legFamily: 'INVENTORY_TRANSFER', legTypeId: 'inventory-position',
      domain, adapter: inventoryAdapter, venue, market: inventoryMarket, assets: [inventoryAsset, quoteAsset],
      side: 'NONE', quantityAsset: inventoryAsset, quantityAtoms: QUANTITY, minimumQuantityAtoms: QUANTITY,
      maximumFeeQuoteAtoms: 0n, preconditionHashes: [], postconditionHashes: [], timeInForce: 'IOC', legExpiryValue: 1_200n,
    }, {
      legId: 'treasury-hedge', legFamily: 'PERP_OPEN', legTypeId: 'treasury-hedge',
      domain, adapter: hedgeAdapter, venue, market: hedgeMarket, assets: [inventoryAsset, quoteAsset],
      side: 'SELL', quantityAsset: inventoryAsset, quantityAtoms: QUANTITY, minimumQuantityAtoms: QUANTITY,
      limitPrice: { baseAsset: inventoryAsset, quoteAsset, quoteAtoms: 2_999n, baseAtoms: 20_000_000n, roundingDirection: 'CEIL' },
      maximumFeeQuoteAtoms: 200_000n, preconditionHashes: [], postconditionHashes: [], timeInForce: 'IOC', legExpiryValue: 1_200n,
    }],
    dependencyEdges: [{ fromLegId: 'inventory-position', toLegId: 'treasury-hedge' }],
    executionGroups: [{ groupId: 'treasury-hedge', kind: 'ALL_OR_NONE', legIds: ['inventory-position', 'treasury-hedge'] }],
    settlementClass: 'ATOMIC_POSTCONDITION',
    policyHashes: { netting: hash('2'), privacy: hash('3'), solver: hash('4'), delivery: hash('5'),
      resource: hash('6'), portfolioRiskLimits: hash('7') },
    recoverySlots: [],
    maximumRecoveryCostQuoteAtoms: 0n,
    expiryUnit: 'SOLANA_SLOT',
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
    quoteConventionId: STRATEGY_QUOTE_CONVENTION_ID.HEDGE_COST,
    riskClassId: STRATEGY_RISK_CLASS_ID.TREASURY_HEDGE,
    owner: OWNER,
    settlementAccount: strategyAccount.toBase58(),
    lifecycleAction: 'ENTRY',
    settlementClass: 'ATOMIC_POSTCONDITION',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'IOC',
    economicQuantity: assetAmount(inventoryAsset, QUANTITY),
    quoteAsset,
    metricLimits: [],
    maximumServiceFeesByAsset: [],
    maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 200_000n }],
    maximumNetworkFeesByAsset: [],
    maximumRecoveryCostByAsset: [],
    maximumMarginIncrease: assetAmount(quoteAsset, 31_000_000n),
    maximumResidualValue: assetAmount(quoteAsset, 0n),
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 1_200n,
    nonce: 1n,
  });
  const amount = (atoms: bigint) => assetAmount(quoteAsset, atoms);
  return {
    orderHashHex: Buffer.from(strategyPackageOrderHash(order)).toString('hex'),
    graphHashHex: Buffer.from(packageGraphHash(graph)).toString('hex'),
    quoteHashHex: hash('8'),
    routeHashHex: hash('9'),
    order,
    graph,
    quote: {
      serviceCharges: [],
      legEconomics: [
        { legId: 'inventory-position', grossNotional: amount(300_000_000n), marginDelta: amount(0n) },
        { legId: 'treasury-hedge', grossNotional: amount(299_910_000n), marginDelta: amount(30_149_955n),
          venueFee: amount(149_955n), executionPrice: { baseAsset: inventoryAsset, quoteAsset,
            quoteAtoms: 29_991n, baseAtoms: 200_000n, roundingDirection: 'FLOOR' } },
      ],
      feePolicyVersion: 1,
      feePolicyManifestHash: bytes(18),
      validUntilValue: 1_100n,
    },
    route: {
      domainPlans: [{ executionPlanKind: 'SVM_ATOMIC_CPI', domain, legIds: ['inventory-position', 'treasury-hedge'] }],
      routeExpiryValue: 1_100n,
    },
    recordedAtMs: 1,
  } as unknown as StoredStrategyPackageDocuments;
}

function tokenAccount(mint: string, owner: string, amount: bigint): Uint8Array {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

class Rpc implements SolanaDevnetSolverReadPort {
  readonly accounts = new Map<string, SolanaDevnetAccount>();

  async getGenesisHash() { return SOLANA_DEVNET_GENESIS_HASH; }
  async getFinalizedSlot() { return SLOT; }
  async getBlockTime() { return 1_000n; }
  async getAccounts(addresses: readonly string[]) {
    return addresses.map((address) => this.accounts.get(address) ?? null);
  }
}

function pricing(): SolanaTreasuryHedgePricingInput {
  return {
    domain,
    inventoryAsset,
    quoteAsset,
    inventoryMint: INVENTORY_MINT,
    quoteMint: QUOTE_MINT,
    marketAddress: MARKET,
    oracleAddress: ORACLE,
    inventory: { adapter: inventoryAdapter, venue, market: inventoryMarket },
    hedge: { adapter: hedgeAdapter, venue, market: hedgeMarket },
    protocolFeeBps: 0,
    solverFeeBps: 0,
    networkFeeQuoteAtoms: 0n,
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('a'),
    routeTtlSlots: 30n,
    quoteTtlSlots: 60n,
    maximumStateAdvanceSlots: 2n,
    readState: async () => ({ slot: SLOT, marketAddress: MARKET, market, oraclePricePerLot: 150_000n }),
    nonceSource: { nextNonce: () => 1n },
  };
}

function setupRpc(packageDocuments: StoredStrategyPackageDocuments): Rpc {
  const rpc = new Rpc();
  const owner = new PublicKey(OWNER);
  const strategyAccount = deriveSolanaMultiStrategyAccount({ programId: MULTI_PROGRAM, owner });
  const packageId = strategyPackageOrderHash(packageDocuments.order);
  const inventory = deriveSolanaPackageInventoryAddresses({
    programId: INVENTORY_PROGRAM,
    strategyAccount,
    packageId,
    mint: INVENTORY_MINT,
  });
  const strategyToken = associatedTokenAddress(strategyAccount, INVENTORY_MINT);
  const perpStrategy = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-strategy'), owner.toBuffer(), Buffer.from(STRATEGY_ID)],
    new PublicKey(HEDGE_PROGRAM),
  )[0];
  const perpPosition = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-position'), new PublicKey(MARKET).toBuffer(), owner.toBuffer()],
    new PublicKey(TEST_PERP_PROGRAM),
  )[0];
  const config = PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], new PublicKey(CORE_PROGRAM))[0];
  rpc.accounts.set(strategyAccount.toBase58(), {
    owner: MULTI_PROGRAM,
    data: new BorshWriter().bytes(accountDiscriminator('MultiStrategyAccount')).u8(1).key(config).key(owner).u64(7n).u8(1).done(),
  });
  rpc.accounts.set(inventory.inventory.toBase58(), {
    owner: INVENTORY_PROGRAM,
    data: new BorshWriter().bytes(accountDiscriminator('PackageInventory')).u8(1).u8(1).u8(1)
      .key(strategyAccount).bytes(packageId).key(INVENTORY_MINT).key(inventory.vault).done(),
  });
  rpc.accounts.set(inventory.vault.toBase58(), {
    owner: TOKEN_PROGRAM_ID.toBase58(),
    data: tokenAccount(INVENTORY_MINT, inventory.inventory.toBase58(), 0n),
  });
  rpc.accounts.set(strategyToken.toBase58(), {
    owner: TOKEN_PROGRAM_ID.toBase58(),
    data: tokenAccount(INVENTORY_MINT, strategyAccount.toBase58(), QUANTITY),
  });
  rpc.accounts.set(perpStrategy.toBase58(), {
    owner: HEDGE_PROGRAM,
    data: new BorshWriter().bytes(accountDiscriminator('TestPerpStrategy')).key(owner).key(strategyAccount)
      .bytes(STRATEGY_ID).key(MARKET).key(perpPosition).u64(1_000_000n).u8(1).done(),
  });
  rpc.accounts.set(perpPosition.toBase58(), {
    owner: TEST_PERP_PROGRAM,
    data: new BorshWriter().bytes(accountDiscriminator('TestPerpPosition')).key(MARKET).key(owner).key(perpStrategy)
      .u64(30_149_955n).i64(0n).u64(0n).i128(0n).u8(1).done(),
  });
  return rpc;
}

test('prepares a state-bound Solana treasury hedge entry from owner-controlled accounts', async () => {
  const packageDocuments = documents();
  const rpc = setupRpc(packageDocuments);
  let remembered: readonly [string, string] | undefined;
  const context = await new SolanaTreasuryHedgePreparationContextResolver([{
    environment: 'devnet',
    templateManifest: template,
    activeRegistryRecords: [],
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
    pricing: pricing(),
    rpc,
    coreProgramId: CORE_PROGRAM,
    multiStrategyProgramId: MULTI_PROGRAM,
    settlementManifestHash: bytes(19),
    solver: SOLVER,
    inventoryAdapter: {
      role: 'inventory-position', programId: INVENTORY_PROGRAM, programDataAddress: INVENTORY_PROGRAM_DATA,
      expectedProgramDataHash: bytes(20), adapterSubjectId: bytes(21), maximumComputeUnitLimit: 200_000,
    },
    hedgeAdapter: {
      role: 'treasury-hedge', programId: HEDGE_PROGRAM, programDataAddress: HEDGE_PROGRAM_DATA,
      expectedProgramDataHash: bytes(22), adapterSubjectId: bytes(23), maximumComputeUnitLimit: 300_000,
    },
    testPerpProgramId: TEST_PERP_PROGRAM,
    testPerpStrategyId: STRATEGY_ID,
    testPerpMaximumBaseLots: 10_000n,
    maximumTransactionComputeUnits: 600_000,
    packageIds: {
      resolvePackageId: async () => undefined,
      rememberPackageId: async (stateHash, packageId) => { remembered = [stateHash, packageId]; },
    },
  }]).resolve(packageDocuments);
  assert.equal(context.identity.operation, 'ENTRY');
  assert.equal(context.identity.nextStateHash?.length, 32);
  assert.equal(context.bindings[0]?.kind, 'SOLANA_MULTI_STRATEGY_ACCOUNT');
  if (context.bindings[0]?.kind !== 'SOLANA_MULTI_STRATEGY_ACCOUNT') throw new Error('missing Solana binding');
  assert.equal(context.bindings[0].nonce, 7n);
  assert.equal(context.bindings[0].totalGrossNotionalAtoms, 599_910_000n);
  assert.deepEqual(context.bindings[0].policies.map((policy) => [policy.legId, policy.riskIncreasing]), [
    ['inventory-position', true],
    ['treasury-hedge', true],
  ]);
  assert.equal(remembered?.[1], packageDocuments.orderHashHex);
});

test('reports the exact remaining Devnet collateral before Solana treasury hedge execution', async () => {
  const packageDocuments = documents();
  const rpc = setupRpc(packageDocuments);
  const plan = await new SolanaTreasuryHedgeProvisioningResolver([{
    environment: 'devnet',
    templateManifest: template,
    activeRegistryRecords: [],
    resourceLimits: [{ domainId: domain.domainId, maximumActionsPerTransaction: 4 }],
    pricing: pricing(),
    rpc,
    coreProgramId: CORE_PROGRAM,
    multiStrategyProgramId: MULTI_PROGRAM,
    settlementManifestHash: bytes(19),
    solver: SOLVER,
    inventoryAdapter: {
      role: 'inventory-position', programId: INVENTORY_PROGRAM, programDataAddress: INVENTORY_PROGRAM_DATA,
      expectedProgramDataHash: bytes(20), adapterSubjectId: bytes(21), maximumComputeUnitLimit: 200_000,
    },
    hedgeAdapter: {
      role: 'treasury-hedge', programId: HEDGE_PROGRAM, programDataAddress: HEDGE_PROGRAM_DATA,
      expectedProgramDataHash: bytes(22), adapterSubjectId: bytes(23), maximumComputeUnitLimit: 300_000,
    },
    testPerpProgramId: TEST_PERP_PROGRAM,
    testPerpStrategyId: STRATEGY_ID,
    testPerpMaximumBaseLots: 10_000n,
    maximumTransactionComputeUnits: 600_000,
    packageIds: { resolvePackageId: async () => undefined },
  }]).resolve(packageDocuments);
  assert.equal(plan.packageId, packageDocuments.orderHashHex);
  assert.equal(plan.inventoryFundingRequiredAtoms, 0n);
  assert.equal(plan.quoteFundingRequiredAtoms, 850_045n);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.steps.map((step) => step.kind), ['CREATE_TOKEN_ACCOUNTS']);
});

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  adapterRef,
  assetRef,
  domainRef,
  domainRegistryRecord,
  packageTemplateManifest,
  parseProtocolJson,
  versionedManifestRef,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type PackageTemplateManifestInput,
  type TypedAdapterActionSupportInput,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import { HttpSolanaDevnetSolverRpc, requireSolanaDevnet } from './solana-devnet-rpc.js';
import {
  PYTH_RECEIVER_PROGRAM_ID,
  SOLANA_DEVNET_SOL_USD_FEED_ID_HEX,
  SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT,
  decodeTestPerpMarket,
  testPerpOraclePricePerLot,
} from './solana-devnet-wire.js';
import type { SolanaTreasuryHedgePackageIdPort, SolanaTreasuryHedgePreparationLane } from './solana-treasury-hedge-preparation.js';
import { createSolanaTreasuryHedgeGeneralizedPricing } from './solana-treasury-hedge-quote.js';
import type { GeneralizedStrategyQuoteLane } from './strategy-quote-context-registry.js';

const MAX_CONFIG_BYTES = 2_097_152;

interface RuntimeLane {
  readonly quote: GeneralizedStrategyQuoteLane;
  readonly preparation: SolanaTreasuryHedgePreparationLane;
}

function fail(message: string): never {
  throw new Error(`Solana treasury hedge runtime config: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${context} must be a nonempty string`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${context} must be a positive safe integer`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${context} must be a nonnegative safe integer`);
  return Number(value);
}

function natural(value: unknown, context: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) fail(`${context} must be a nonnegative bigint`);
  return value;
}

function positive(value: unknown, context: string): bigint {
  const checked = natural(value, context);
  if (checked === 0n) fail(`${context} must be positive`);
  return checked;
}

function address(value: unknown, context: string): string {
  try {
    const checked = new PublicKey(string(value, context));
    if (checked.equals(PublicKey.default) || checked.toBase58() !== value) fail(`${context} is invalid`);
    return checked.toBase58();
  } catch {
    return fail(`${context} is not a canonical Solana address`);
  }
}

function bytes32(value: unknown, context: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32 || value.every((byte) => byte === 0)) {
    fail(`${context} must be 32 nonzero bytes`);
  }
  return Uint8Array.from(value);
}

function asset(value: unknown, context: string) {
  const input = record(value, context);
  return assetRef(
    address(input.assetId, `${context}.assetId`),
    input.assetManifestHash as Uint8Array | string,
    nonnegativeInteger(input.decimals, `${context}.decimals`),
  );
}

function leg(value: unknown, context: string) {
  const input = record(value, context);
  const venue = record(input.venue, `${context}.venue`);
  const market = record(input.market, `${context}.market`);
  return Object.freeze({
    adapter: adapterRef(input.adapter as never, `${context}.adapter`),
    venue: versionedManifestRef(
      string(venue.subjectId, `${context}.venue.subjectId`),
      integer(venue.manifestVersion, `${context}.venue.manifestVersion`),
      venue.manifestHash as Uint8Array | string,
    ),
    market: versionedManifestRef(
      string(market.subjectId, `${context}.market.subjectId`),
      integer(market.manifestVersion, `${context}.market.manifestVersion`),
      market.manifestHash as Uint8Array | string,
    ),
  });
}

function absoluteJson(path: string): unknown {
  if (!isAbsolute(path)) fail('config path must be absolute');
  const resolved = resolve(path);
  if (statSync(resolved).size > MAX_CONFIG_BYTES) fail('config file is too large');
  try {
    return parseProtocolJson(readFileSync(resolved, 'utf8'), 'solanaTreasuryHedgeRuntime');
  } catch {
    return fail('config file is not valid protocol JSON');
  }
}

function adapterBinding(value: unknown, context: string) {
  const input = record(value, context);
  if (input.role !== 'inventory-position' && input.role !== 'treasury-hedge') fail(`${context}.role is invalid`);
  return Object.freeze({
    role: input.role,
    programId: address(input.programId, `${context}.programId`),
    programDataAddress: address(input.programDataAddress, `${context}.programDataAddress`),
    expectedProgramDataHash: bytes32(input.expectedProgramDataHash, `${context}.expectedProgramDataHash`),
    adapterSubjectId: bytes32(input.adapterSubjectId, `${context}.adapterSubjectId`),
    maximumComputeUnitLimit: integer(input.maximumComputeUnitLimit, `${context}.maximumComputeUnitLimit`),
  });
}

function lane(
  value: unknown,
  rpc: HttpSolanaDevnetSolverRpc,
  nonceSource: (laneId: string) => Readonly<{ nextNonce(): bigint }>,
  packageIds: SolanaTreasuryHedgePackageIdPort,
): RuntimeLane {
  const input = record(value, 'lane');
  const laneId = string(input.laneId, 'lane.laneId');
  const templateManifest = packageTemplateManifest(input.templateManifest as PackageTemplateManifestInput, 'lane.templateManifest');
  if (templateManifest.environment !== 'devnet' || templateManifest.templateId !== 'treasury-inventory-hedge-v1') {
    fail(`lane ${laneId} template manifest is not a Devnet treasury hedge`);
  }
  if (!Array.isArray(input.activeRegistryRecords) || input.activeRegistryRecords.length === 0
    || !Array.isArray(input.resourceLimits) || input.resourceLimits.length === 0
    || !Array.isArray(input.adapterSupport) || input.adapterSupport.length === 0
    || !Array.isArray(input.adapters) || input.adapters.length !== 2) {
    fail(`lane ${laneId} collections are incomplete`);
  }
  const activeRegistryRecords = Object.freeze(input.activeRegistryRecords.map((item, index) =>
    domainRegistryRecord(item as DomainRegistryRecordInput, `lane.activeRegistryRecords[${index}]`)));
  const resourceLimits = Object.freeze(input.resourceLimits as DomainResourceLimit[]);
  const adapterSupport = Object.freeze(input.adapterSupport as TypedAdapterActionSupportInput[]);
  const domainValue = record(input.domain, 'lane.domain');
  const domain = domainRef(
    string(domainValue.domainId, 'lane.domain.domainId'),
    integer(domainValue.domainManifestVersion, 'lane.domain.domainManifestVersion'),
    domainValue.domainManifestHash as Uint8Array | string,
  );
  if (domain.domainId !== 'svm:devnet') fail(`lane ${laneId} domain is not Solana Devnet`);
  const inventoryAsset = asset(input.inventoryAsset, 'lane.inventoryAsset');
  const quoteAsset = asset(input.quoteAsset, 'lane.quoteAsset');
  const inventoryMint = address(input.inventoryMint, 'lane.inventoryMint');
  const quoteMint = address(input.quoteMint, 'lane.quoteMint');
  if (inventoryAsset.assetId !== inventoryMint || quoteAsset.assetId !== quoteMint) {
    fail(`lane ${laneId} asset and mint identities differ`);
  }
  const marketAddress = address(input.marketAddress, 'lane.marketAddress');
  const oracleAddress = address(input.oracleAddress, 'lane.oracleAddress');
  if (oracleAddress !== SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT) fail(`lane ${laneId} oracle is not the reviewed Devnet feed`);
  const testPerpProgramId = address(input.testPerpProgramId, 'lane.testPerpProgramId');
  const inventory = leg(input.inventory, 'lane.inventory');
  const hedge = leg(input.hedge, 'lane.hedge');
  const protocolFeeBps = nonnegativeInteger(input.protocolFeeBps, 'lane.protocolFeeBps');
  const solverFeeBps = nonnegativeInteger(input.solverFeeBps, 'lane.solverFeeBps');
  if (protocolFeeBps !== 0 || solverFeeBps !== 0) {
    fail(`lane ${laneId} service fees must remain zero until the Solana account collects them`);
  }
  const maximumStateAdvanceSlots = natural(input.maximumStateAdvanceSlots, 'lane.maximumStateAdvanceSlots');
  const pricing = Object.freeze({
    domain,
    inventoryAsset,
    quoteAsset,
    inventoryMint,
    quoteMint,
    marketAddress,
    oracleAddress,
    inventory,
    hedge,
    protocolFeeBps,
    solverFeeBps,
    networkFeeQuoteAtoms: natural(input.networkFeeQuoteAtoms, 'lane.networkFeeQuoteAtoms'),
    feePolicyVersion: integer(input.feePolicyVersion, 'lane.feePolicyVersion'),
    feePolicyManifestHash: input.feePolicyManifestHash as Uint8Array | string,
    routeTtlSlots: positive(input.routeTtlSlots, 'lane.routeTtlSlots'),
    quoteTtlSlots: positive(input.quoteTtlSlots, 'lane.quoteTtlSlots'),
    maximumStateAdvanceSlots,
    nonceSource: nonceSource(laneId),
    readState: async () => {
      const slot = await rpc.getFinalizedSlot();
      const [marketAccount, oracleAccount] = await rpc.getAccounts([marketAddress, oracleAddress], slot);
      if (marketAccount?.owner !== testPerpProgramId) fail(`lane ${laneId} market is absent or has the wrong owner`);
      if (oracleAccount?.owner !== PYTH_RECEIVER_PROGRAM_ID) fail(`lane ${laneId} oracle is absent or has the wrong owner`);
      const market = decodeTestPerpMarket(marketAccount.data);
      if (market.oracle !== oracleAddress || market.feedIdHex !== SOLANA_DEVNET_SOL_USD_FEED_ID_HEX
        || market.collateralMint !== quoteMint || market.baseDecimals !== inventoryAsset.decimals
        || market.collateralDecimals !== quoteAsset.decimals) {
        fail(`lane ${laneId} live market identity or units differ`);
      }
      const now = await rpc.getBlockTime(slot);
      return Object.freeze({
        slot,
        marketAddress,
        market,
        oraclePricePerLot: testPerpOraclePricePerLot(
          market,
          { address: oracleAddress, owner: oracleAccount.owner, data: oracleAccount.data },
          now,
        ),
      });
    },
  });
  const adapters = input.adapters.map((item, index) => adapterBinding(item, `lane.adapters[${index}]`));
  if (new Set(adapters.map((item) => item.role)).size !== 2) fail(`lane ${laneId} adapter roles repeat`);
  const byRole = (role: 'inventory-position' | 'treasury-hedge') => adapters.find((item) => item.role === role)!;
  const preparation: SolanaTreasuryHedgePreparationLane = Object.freeze({
    environment: 'devnet',
    templateManifest,
    activeRegistryRecords,
    resourceLimits,
    pricing,
    rpc,
    coreProgramId: address(input.coreProgramId, 'lane.coreProgramId'),
    multiStrategyProgramId: address(input.multiStrategyProgramId, 'lane.multiStrategyProgramId'),
    settlementManifestHash: bytes32(input.settlementManifestHash, 'lane.settlementManifestHash'),
    solver: address(input.solver, 'lane.solver'),
    inventoryAdapter: byRole('inventory-position'),
    hedgeAdapter: byRole('treasury-hedge'),
    testPerpProgramId,
    testPerpStrategyId: bytes32(input.testPerpStrategyId, 'lane.testPerpStrategyId'),
    maximumTransactionComputeUnits: integer(input.maximumTransactionComputeUnits, 'lane.maximumTransactionComputeUnits'),
    packageIds,
  });
  return Object.freeze({
    preparation,
    quote: Object.freeze({
      laneId,
      environment: 'devnet',
      templateManifest,
      executionClassId: string(input.executionClassId, 'lane.executionClassId'),
      executionClassVersion: integer(input.executionClassVersion, 'lane.executionClassVersion'),
      executionClassManifestHash: input.executionClassManifestHash as Uint8Array | string,
      activeRegistryRecords,
      resourceLimits,
      adapterSupport,
      solverId: string(input.solverId, 'lane.solverId'),
      solverCapabilityManifestHash: input.solverCapabilityManifestHash as Uint8Array | string,
      pricing: createSolanaTreasuryHedgeGeneralizedPricing(pricing),
      currentTime: async () => Object.freeze({ unit: 'SOLANA_SLOT' as const, value: await rpc.getFinalizedSlot() }),
    }),
  });
}

export async function loadSolanaTreasuryHedgeRuntime(
  path: string,
  dependencies: Readonly<{
    nonceSource: (laneId: string) => Readonly<{ nextNonce(): bigint }>;
    packageIds: SolanaTreasuryHedgePackageIdPort;
  }>,
): Promise<Readonly<{
  quoteLanes: readonly GeneralizedStrategyQuoteLane[];
  preparationLanes: readonly SolanaTreasuryHedgePreparationLane[];
}>> {
  const root = record(absoluteJson(path), 'root');
  if (root.version !== 1 || root.environment !== 'devnet' || typeof root.rpcUrl !== 'string'
    || !Array.isArray(root.lanes) || root.lanes.length === 0 || root.lanes.length > 8) {
    fail('root must define version 1, devnet, rpcUrl, and one to eight lanes');
  }
  const rpc = new HttpSolanaDevnetSolverRpc(root.rpcUrl, { writesEnabled: false });
  await requireSolanaDevnet(rpc);
  const lanes = root.lanes.map((item) => lane(item, rpc, dependencies.nonceSource, dependencies.packageIds));
  return Object.freeze({
    quoteLanes: Object.freeze(lanes.map((item) => item.quote)),
    preparationLanes: Object.freeze(lanes.map((item) => item.preparation)),
  });
}

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  ConnectionSolanaReadOnlyRpc,
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaMultiStrategyTransactionMaterializer,
  type SolanaLookupTableConfig,
} from '@naryx/adapter-solana';
import {
  adapterRef,
  assetRef,
  bytesEqual,
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
import {
  HttpSolanaDevnetSolverRpc,
  requireSolanaDevnet,
  type SolanaDevnetObservationReadPort,
} from './solana-devnet-rpc.js';
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
  readonly execution?: SolanaTreasuryHedgeExecutionLane;
}

export interface SolanaTreasuryHedgeExecutionLane {
  readonly domain: ReturnType<typeof domainRef>;
  readonly solver: string;
  readonly computeUnitLimit: number;
  readonly materializer: SolanaMultiStrategyTransactionMaterializer;
  readonly reader: SolanaDevnetObservationReadPort;
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

function anyAddress(value: unknown, context: string): string {
  try {
    const checked = new PublicKey(string(value, context));
    if (checked.toBase58() !== value) fail(`${context} is invalid`);
    return checked.toBase58();
  } catch {
    return fail(`${context} is not a canonical Solana address`);
  }
}

function lookupTables(value: unknown, context: string): readonly SolanaLookupTableConfig[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    fail(`${context} must contain one to four lookup tables`);
  }
  const tables = value.map((item, index) => {
    const table = record(item, `${context}[${index}]`);
    if (Object.keys(table).sort().join(',') !== 'address,expectedAddresses'
      || !Array.isArray(table.expectedAddresses)
      || table.expectedAddresses.length === 0
      || table.expectedAddresses.length > 256) {
      fail(`${context}[${index}] is invalid`);
    }
    return Object.freeze({
      address: address(table.address, `${context}[${index}].address`),
      expectedAddresses: Object.freeze(table.expectedAddresses.map((candidate, addressIndex) =>
        anyAddress(candidate, `${context}[${index}].expectedAddresses[${addressIndex}]`))),
    });
  });
  if (new Set(tables.map((table) => table.address)).size !== tables.length) {
    fail(`${context} addresses repeat`);
  }
  return Object.freeze(tables);
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
  materializationRpc: ConnectionSolanaReadOnlyRpc,
  rpcUrl: string,
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
  const quoteAssetRecords = activeRegistryRecords.filter((record) =>
    record.recordKind === 'ASSET'
    && record.subjectId === quoteAsset.assetId
    && record.domain.domainId === domain.domainId
    && record.domain.domainManifestVersion === domain.domainManifestVersion
    && bytesEqual(record.domain.domainManifestHash, domain.domainManifestHash)
    && bytesEqual(record.subjectManifestHash, quoteAsset.assetManifestHash)
    && record.registryState === 'ACTIVE');
  if (quoteAssetRecords.length !== 1) fail(`lane ${laneId} quote asset must resolve to one active registry record`);
  const quoteAssetRecord = quoteAssetRecords[0]!;
  const marketAddress = address(input.marketAddress, 'lane.marketAddress');
  const oracleAddress = address(input.oracleAddress, 'lane.oracleAddress');
  if (oracleAddress !== SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT) fail(`lane ${laneId} oracle is not the reviewed Devnet feed`);
  const testPerpProgramId = address(input.testPerpProgramId, 'lane.testPerpProgramId');
  const inventory = leg(input.inventory, 'lane.inventory');
  const hedge = leg(input.hedge, 'lane.hedge');
  const protocolFeeBps = nonnegativeInteger(input.protocolFeeBps, 'lane.protocolFeeBps');
  const solverFeeBps = nonnegativeInteger(input.solverFeeBps, 'lane.solverFeeBps');
  const maximumStateAdvanceSlots = natural(input.maximumStateAdvanceSlots, 'lane.maximumStateAdvanceSlots');
  const maximumTransactionComputeUnits = integer(
    input.maximumTransactionComputeUnits,
    'lane.maximumTransactionComputeUnits',
  );
  if (maximumTransactionComputeUnits > 1_260_000) {
    fail(`lane ${laneId} maximum transaction compute units exceed the Solana route cap`);
  }
  const reviewedLookupTables = input.lookupTables === undefined
    ? undefined
    : lookupTables(input.lookupTables, 'lane.lookupTables');
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
    protocolFeeRecipient: address(input.protocolFeeRecipient, 'lane.protocolFeeRecipient'),
    quoteAssetSubjectId: bytes32(input.quoteAssetSubjectId, 'lane.quoteAssetSubjectId'),
    quoteAssetManifestVersion: quoteAssetRecord.subjectManifestVersion,
    inventoryAdapter: byRole('inventory-position'),
    hedgeAdapter: byRole('treasury-hedge'),
    testPerpProgramId,
    testPerpStrategyId: bytes32(input.testPerpStrategyId, 'lane.testPerpStrategyId'),
    testPerpMaximumBaseLots: positive(input.testPerpMaximumBaseLots, 'lane.testPerpMaximumBaseLots'),
    maximumTransactionComputeUnits,
    packageIds,
  });
  return Object.freeze({
    preparation,
    ...(reviewedLookupTables === undefined
      ? {}
      : {
          execution: Object.freeze({
            domain,
            solver: preparation.solver,
            computeUnitLimit: maximumTransactionComputeUnits,
            reader: rpc,
            materializer: new SolanaMultiStrategyTransactionMaterializer(materializationRpc, {
              environment: 'devnet',
              domain,
              rpcUrl,
              expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
              lookupTables: reviewedLookupTables,
            }),
          }),
        }),
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
  executionLanes: readonly SolanaTreasuryHedgeExecutionLane[];
}>> {
  const root = record(absoluteJson(path), 'root');
  if (root.version !== 1 || root.environment !== 'devnet' || typeof root.rpcUrl !== 'string'
    || !Array.isArray(root.lanes) || root.lanes.length === 0 || root.lanes.length > 8) {
    fail('root must define version 1, devnet, rpcUrl, and one to eight lanes');
  }
  const rpcUrl = string(root.rpcUrl, 'root.rpcUrl');
  const rpc = new HttpSolanaDevnetSolverRpc(rpcUrl, { writesEnabled: false });
  const materializationRpc = new ConnectionSolanaReadOnlyRpc(rpcUrl);
  await requireSolanaDevnet(rpc);
  const lanes = root.lanes.map((item) => lane(
    item,
    rpc,
    materializationRpc,
    rpcUrl,
    dependencies.nonceSource,
    dependencies.packageIds,
  ));
  return Object.freeze({
    quoteLanes: Object.freeze(lanes.map((item) => item.quote)),
    preparationLanes: Object.freeze(lanes.map((item) => item.preparation)),
    executionLanes: Object.freeze(lanes.flatMap((item) => item.execution === undefined ? [] : [item.execution])),
  });
}

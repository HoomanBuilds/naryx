import { createHash } from 'node:crypto';
import {
  createSolanaExactInventoryMaterializer,
  createSolanaTestPerpExactShortMaterializer,
  deriveSolanaMultiStrategyAccount,
  deriveSolanaPackageInventoryAddresses,
  type SolanaStrategyAdapterPolicy,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  packageTemplateManifestHash,
  strategyPackageOrderHash,
  type DomainRegistryRecordInput,
  type DomainResourceLimit,
  type Hash32,
  type PackageTemplateManifest,
} from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import type { StoredStrategyPackageDocuments } from './http-strategy-package-provider.js';
import { createSolanaStrategyDomainCompiler } from './strategy-domain-compilers.js';
import {
  BorshReader,
  TOKEN_PROGRAM_ID,
  accountDiscriminator,
  associatedTokenAddress,
  bigEndian,
  decodeTestPerpPosition,
  decodeTestPerpStrategyController,
  decodeTokenAccount,
  priceTestPerpCloseShort,
  priceTestPerpShort,
} from './solana-devnet-wire.js';
import { requireSolanaDevnet, type SolanaDevnetSolverReadPort } from './solana-devnet-rpc.js';
import type { SolanaTreasuryHedgePricingInput } from './solana-treasury-hedge-quote.js';
import type { StrategyPreparationContext, StrategyPreparationContextResolver } from './strategy-preparation-service.js';

const INVENTORY_CLASS = 'naryx.solana.inventory-transfer';
const PERP_CLASS = 'naryx.solana.perp-exact';
const U64_MAX = (1n << 64n) - 1n;

type AdapterRole = 'inventory-position' | 'treasury-hedge';

export interface SolanaTreasuryHedgeAdapterBinding {
  readonly role: AdapterRole;
  readonly programId: string;
  readonly programDataAddress: string;
  readonly expectedProgramDataHash: Uint8Array;
  readonly adapterSubjectId: Uint8Array;
  readonly maximumComputeUnitLimit: number;
}

export interface SolanaTreasuryHedgePackageIdPort {
  resolvePackageId(expectedStateHashHex: string): Promise<string | undefined>;
  rememberPackageId?(stateHashHex: string, packageIdHex: string): Promise<void>;
}

export interface SolanaTreasuryHedgePreparationLane {
  readonly environment: 'devnet';
  readonly templateManifest: PackageTemplateManifest;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
  readonly resourceLimits: readonly DomainResourceLimit[];
  readonly pricing: SolanaTreasuryHedgePricingInput;
  readonly rpc: SolanaDevnetSolverReadPort;
  readonly coreProgramId: string;
  readonly multiStrategyProgramId: string;
  readonly settlementManifestHash: Uint8Array;
  readonly solver: string;
  readonly inventoryAdapter: SolanaTreasuryHedgeAdapterBinding;
  readonly hedgeAdapter: SolanaTreasuryHedgeAdapterBinding;
  readonly testPerpProgramId: string;
  readonly testPerpStrategyId: Uint8Array;
  readonly testPerpMaximumBaseLots: bigint;
  readonly maximumTransactionComputeUnits: number;
  readonly packageIds: SolanaTreasuryHedgePackageIdPort;
}

interface MultiStrategyState {
  readonly config: string;
  readonly owner: string;
  readonly nextNonce: bigint;
}

interface StrategyPositionState {
  readonly packageId: Uint8Array;
  readonly domainId: string;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Uint8Array;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateManifestHash: Uint8Array;
  readonly stateHash: Uint8Array;
  readonly active: boolean;
}

interface InventoryState {
  readonly strategyAccount: string;
  readonly packageId: Uint8Array;
  readonly mint: string;
  readonly vault: string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana treasury hedge preparation refused: ${message}`);
}

function key(value: string, context: string): PublicKey {
  try {
    const checked = new PublicKey(value);
    requireCondition(!checked.equals(PublicKey.default) && checked.toBase58() === value, `${context} is invalid`);
    return checked;
  } catch {
    throw new Error(`Solana treasury hedge preparation refused: ${context} is invalid`);
  }
}

function hash32(value: Uint8Array, context: string, allowZero = false): Hash32 {
  requireCondition(value.length === 32 && (allowZero || value.some((byte) => byte !== 0)), `${context} is invalid`);
  return Uint8Array.from(value) as Hash32;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function fromHex(value: string, context: string): Hash32 {
  requireCondition(/^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value), `${context} is invalid`);
  return Uint8Array.from(Buffer.from(value, 'hex')) as Hash32;
}

function u64(value: bigint, context: string): bigint {
  requireCondition(value >= 0n && value <= U64_MAX, `${context} must fit u64`);
  return value;
}

function i64be(value: bigint, context: string): Buffer {
  requireCondition(value >= -(1n << 63n) && value < (1n << 63n), `${context} must fit i64`);
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigInt64BE(value);
  return encoded;
}

function decodeMultiStrategyAccount(data: Uint8Array): MultiStrategyState {
  const reader = new BorshReader(data, accountDiscriminator('MultiStrategyAccount'), 'MultiStrategyAccount');
  requireCondition(reader.u8() === 1, 'multi-strategy account version is unsupported');
  return Object.freeze({ config: reader.key(), owner: reader.key(), nextNonce: reader.u64() });
}

function decodeStrategyPosition(data: Uint8Array): StrategyPositionState {
  const reader = new BorshReader(data, accountDiscriminator('StrategyPosition'), 'StrategyPosition');
  requireCondition(reader.u8() === 1, 'strategy position version is unsupported');
  const packageId = reader.hash();
  const domain = reader.domain();
  const templateId = reader.string();
  const templateVersion = reader.u32();
  const templateManifestHash = reader.hash();
  const stateHash = reader.hash();
  reader.hash();
  return Object.freeze({
    packageId,
    domainId: domain.domainId,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: domain.domainManifestHash,
    templateId,
    templateVersion,
    templateManifestHash,
    stateHash,
    active: reader.bool(),
  });
}

function decodeInventory(data: Uint8Array): InventoryState {
  const reader = new BorshReader(data, accountDiscriminator('PackageInventory'), 'PackageInventory');
  requireCondition(reader.u8() === 1, 'package inventory version is unsupported');
  reader.u8();
  reader.u8();
  return Object.freeze({
    strategyAccount: reader.key(),
    packageId: reader.hash(),
    mint: reader.key(),
    vault: reader.key(),
  });
}

function derivePosition(program: PublicKey, strategyAccount: PublicKey, packageId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('strategy-position'), strategyAccount.toBuffer(), Buffer.from(packageId)],
    program,
  )[0];
}

function deriveTestPerpAccounts(input: Readonly<{
  adapterProgram: PublicKey;
  venueProgram: PublicKey;
  owner: PublicKey;
  strategyId: Uint8Array;
  market: PublicKey;
}>): Readonly<{ strategy: PublicKey; position: PublicKey }> {
  const strategy = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-strategy'), input.owner.toBuffer(), Buffer.from(input.strategyId)],
    input.adapterProgram,
  )[0];
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-position'), input.market.toBuffer(), input.owner.toBuffer()],
    input.venueProgram,
  )[0];
  return Object.freeze({ strategy, position });
}

function stateHash(input: Readonly<{
  packageId: Uint8Array;
  strategyAccount: PublicKey;
  inventory: PublicKey;
  inventoryAtoms: bigint;
  perpStrategy: PublicKey;
  perpPosition: PublicKey;
  baseLots: bigint;
  collateralAtoms: bigint;
  entryNotionalAtoms: bigint;
  quoteHash: Uint8Array;
  routeHash: Uint8Array;
}>): Hash32 {
  const digest = createHash('sha256');
  digest.update('NARYX/solana-treasury-hedge-state/v1', 'ascii');
  digest.update(input.packageId);
  digest.update(input.strategyAccount.toBuffer());
  digest.update(input.inventory.toBuffer());
  digest.update(bigEndian(u64(input.inventoryAtoms, 'inventory atoms'), 8));
  digest.update(input.perpStrategy.toBuffer());
  digest.update(input.perpPosition.toBuffer());
  digest.update(i64be(input.baseLots, 'base lots'));
  digest.update(bigEndian(u64(input.collateralAtoms, 'collateral atoms'), 8));
  digest.update(bigEndian(u64(input.entryNotionalAtoms, 'entry notional'), 8));
  digest.update(hash32(input.quoteHash, 'quote hash'));
  digest.update(hash32(input.routeHash, 'route hash'));
  return Uint8Array.from(digest.digest()) as Hash32;
}

function clientOrderId(orderHash: Uint8Array, quoteHash: Uint8Array, routeHash: Uint8Array): bigint {
  const value = createHash('sha256')
    .update('NARYX/solana-treasury-hedge-client-order/v1', 'ascii')
    .update(orderHash)
    .update(quoteHash)
    .update(routeHash)
    .digest()
    .subarray(0, 16);
  const id = BigInt(`0x${value.toString('hex')}`);
  return id === 0n ? 1n : id;
}

function role(binding: SolanaTreasuryHedgeAdapterBinding, expected: AdapterRole): void {
  requireCondition(binding.role === expected, `${expected} adapter role is invalid`);
  key(binding.programId, `${expected} adapter program`);
  key(binding.programDataAddress, `${expected} adapter ProgramData`);
  hash32(binding.expectedProgramDataHash, `${expected} ProgramData hash`);
  hash32(binding.adapterSubjectId, `${expected} adapter subject`);
  requireCondition(Number.isInteger(binding.maximumComputeUnitLimit) && binding.maximumComputeUnitLimit > 0,
    `${expected} compute limit is invalid`);
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

export class SolanaTreasuryHedgePreparationContextResolver implements StrategyPreparationContextResolver {
  readonly #lanes: readonly SolanaTreasuryHedgePreparationLane[];

  constructor(lanes: readonly SolanaTreasuryHedgePreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    for (const lane of lanes) {
      requireCondition(lane.environment === 'devnet' && lane.pricing.domain.domainId === 'svm:devnet',
        'lane must target Solana Devnet');
      key(lane.coreProgramId, 'core program');
      key(lane.multiStrategyProgramId, 'multi-strategy program');
      key(lane.solver, 'solver');
      key(lane.testPerpProgramId, 'test perp program');
      hash32(lane.settlementManifestHash, 'settlement manifest hash');
      hash32(lane.testPerpStrategyId, 'test perp strategy id');
      requireCondition(lane.testPerpMaximumBaseLots > 0n && lane.testPerpMaximumBaseLots <= (1n << 63n) - 1n,
        'test perp strategy limit is invalid');
      role(lane.inventoryAdapter, 'inventory-position');
      role(lane.hedgeAdapter, 'treasury-hedge');
      requireCondition(Number.isInteger(lane.maximumTransactionComputeUnits)
        && lane.maximumTransactionComputeUnits > 0, 'transaction compute limit is invalid');
    }
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolve(documents: StoredStrategyPackageDocuments): Promise<StrategyPreparationContext> {
    const matches = this.#lanes.filter((lane) => lane.environment === documents.order.environment
      && lane.templateManifest.templateId === documents.order.templateId
      && lane.templateManifest.templateVersion === documents.order.templateVersion
      && bytesEqual(packageTemplateManifestHash(lane.templateManifest), documents.order.packageTemplateManifestHash)
      && documents.route.domainPlans.length === 1
      && documents.route.domainPlans[0]!.executionPlanKind === 'SVM_ATOMIC_CPI'
      && documents.route.domainPlans[0]!.domain.domainId === lane.pricing.domain.domainId
      && bytesEqual(documents.route.domainPlans[0]!.domain.domainManifestHash, lane.pricing.domain.domainManifestHash));
    requireCondition(matches.length === 1, 'package must resolve to exactly one preparation lane');
    const lane = matches[0]!;
    requireCondition(documents.order.settlementClass === 'ATOMIC_POSTCONDITION'
      && documents.order.expiryUnit === 'SOLANA_SLOT', 'package is not an atomic Solana execution');
    await requireSolanaDevnet(lane.rpc);
    const [slot, quoteState] = await Promise.all([lane.rpc.getFinalizedSlot(), lane.pricing.readState()]);
    requireCondition(quoteState.slot >= slot && quoteState.slot - slot <= lane.pricing.maximumStateAdvanceSlots,
      'quote state and finalized RPC head differ');
    requireCondition(quoteState.marketAddress === lane.pricing.marketAddress
      && quoteState.market.oracle === lane.pricing.oracleAddress
      && quoteState.market.collateralMint === lane.pricing.quoteMint,
    'live market identity differs from the reviewed lane');
    requireCondition(documents.quote.serviceCharges.every((charge) => charge.amount.atoms === 0n),
      'Solana multi-strategy execution does not yet collect service charges');
    const currentSlot = quoteState.slot;
    const deadline = [documents.order.expiryValue, documents.quote.validUntilValue, documents.route.routeExpiryValue]
      .reduce((minimum, candidate) => candidate < minimum ? candidate : minimum);
    requireCondition(currentSlot < deadline, 'order, quote, or route expired');
    const orderHash = strategyPackageOrderHash(documents.order);
    const quoteHash = fromHex(documents.quoteHashHex, 'quote hash');
    const routeHash = fromHex(documents.routeHashHex, 'route hash');
    const packageId = documents.order.lifecycleAction === 'ENTRY'
      ? orderHash
      : fromHex(await lane.packageIds.resolvePackageId(hex(documents.order.expectedStrategyStateHash!))
        ?? '', 'prior package id');
    const owner = key(documents.order.owner, 'owner');
    const coreProgram = key(lane.coreProgramId, 'core program');
    const multiProgram = key(lane.multiStrategyProgramId, 'multi-strategy program');
    const strategyAccount = deriveSolanaMultiStrategyAccount({ programId: multiProgram, owner });
    requireCondition(strategyAccount.toBase58() === documents.order.settlementAccount,
      'settlement account is not the owner multi-strategy account');
    const positionAddress = derivePosition(multiProgram, strategyAccount, packageId);
    const inventoryProgram = key(lane.inventoryAdapter.programId, 'inventory adapter program');
    const inventoryMint = key(lane.pricing.inventoryMint, 'inventory mint');
    const inventoryAddresses = deriveSolanaPackageInventoryAddresses({
      programId: inventoryProgram,
      strategyAccount,
      packageId,
      mint: inventoryMint,
    });
    const strategyToken = associatedTokenAddress(strategyAccount, inventoryMint);
    const hedgeProgram = key(lane.hedgeAdapter.programId, 'hedge adapter program');
    const market = key(lane.pricing.marketAddress, 'test perp market');
    const testPerpProgram = key(lane.testPerpProgramId, 'test perp program');
    const perpAccounts = deriveTestPerpAccounts({
      adapterProgram: hedgeProgram,
      venueProgram: testPerpProgram,
      owner,
      strategyId: lane.testPerpStrategyId,
      market,
    });
    const addresses = [
      strategyAccount, positionAddress, inventoryAddresses.inventory, inventoryAddresses.vault,
      strategyToken, perpAccounts.strategy, perpAccounts.position,
    ].map((value) => value.toBase58());
    const [strategyAccountValue, strategyPositionValue, inventoryValue, inventoryVaultValue,
      strategyTokenValue, perpStrategyValue, perpPositionValue] = await lane.rpc.getAccounts(addresses, currentSlot);
    requireCondition(strategyAccountValue?.owner === multiProgram.toBase58(), 'multi-strategy account is absent or has the wrong owner');
    requireCondition(inventoryValue?.owner === inventoryProgram.toBase58(), 'package inventory is absent or has the wrong owner');
    requireCondition(inventoryVaultValue?.owner === TOKEN_PROGRAM_ID.toBase58()
      && strategyTokenValue?.owner === TOKEN_PROGRAM_ID.toBase58(), 'inventory token accounts are absent or invalid');
    requireCondition(perpStrategyValue?.owner === hedgeProgram.toBase58(), 'test perp strategy is absent or has the wrong owner');
    requireCondition(perpPositionValue?.owner === testPerpProgram.toBase58(), 'test perp position is absent or has the wrong owner');
    const strategy = decodeMultiStrategyAccount(strategyAccountValue.data);
    const config = PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], coreProgram)[0];
    requireCondition(strategy.owner === owner.toBase58() && strategy.config === config.toBase58(),
      'multi-strategy ownership or config is invalid');
    const inventory = decodeInventory(inventoryValue.data);
    requireCondition(inventory.strategyAccount === strategyAccount.toBase58()
      && sameHash(inventory.packageId, packageId)
      && inventory.mint === inventoryMint.toBase58()
      && inventory.vault === inventoryAddresses.vault.toBase58(), 'package inventory identity is invalid');
    const vault = decodeTokenAccount(inventoryVaultValue.data);
    const strategyInventory = decodeTokenAccount(strategyTokenValue.data);
    requireCondition(vault.mint === inventoryMint.toBase58() && vault.owner === inventoryAddresses.inventory.toBase58()
      && strategyInventory.mint === inventoryMint.toBase58() && strategyInventory.owner === strategyAccount.toBase58(),
    'inventory token ownership is invalid');
    const perpStrategy = decodeTestPerpStrategyController(perpStrategyValue.data);
    const perpPosition = decodeTestPerpPosition(perpPositionValue.data);
    requireCondition(perpStrategy.owner === owner.toBase58() && perpStrategy.controller === strategyAccount.toBase58()
      && perpStrategy.market === market.toBase58() && perpStrategy.position === perpAccounts.position.toBase58(),
    'test perp strategy identity is invalid');
    requireCondition(perpPosition.owner === owner.toBase58() && perpPosition.delegate === perpAccounts.strategy.toBase58()
      && perpPosition.market === market.toBase58(), 'test perp position identity is invalid');
    const opening = documents.order.lifecycleAction === 'ENTRY';
    requireCondition(opening || documents.order.lifecycleAction === 'EXIT'
      || documents.order.lifecycleAction === 'EMERGENCY_UNWIND', 'lifecycle action is unsupported');
    if (opening) {
      requireCondition(strategyPositionValue === null, 'entry strategy position already exists');
    } else {
      requireCondition(strategyPositionValue?.owner === multiProgram.toBase58(), 'strategy position is absent or has the wrong owner');
      const position = decodeStrategyPosition(strategyPositionValue.data);
      requireCondition(position.active && sameHash(position.packageId, packageId)
        && position.domainId === lane.pricing.domain.domainId
        && position.domainManifestVersion === lane.pricing.domain.domainManifestVersion
        && sameHash(position.domainManifestHash, lane.pricing.domain.domainManifestHash)
        && position.templateId === documents.order.templateId
        && position.templateVersion === documents.order.templateVersion
        && sameHash(position.templateManifestHash, documents.order.packageTemplateManifestHash)
        && sameHash(position.stateHash, documents.order.expectedStrategyStateHash!),
      'onchain strategy position differs from the signed expected state');
    }
    const quantity = documents.order.economicQuantity.atoms;
    requireCondition(quantity > 0n && quantity % quoteState.market.baseLotAtoms === 0n, 'quantity is not an exact perp lot');
    const lots = quantity / quoteState.market.baseLotAtoms;
    requireCondition(lots <= perpStrategy.maxBaseLots, 'quantity exceeds the delegated perp strategy limit');
    requireCondition(opening
      ? vault.amount === 0n && strategyInventory.amount >= quantity && perpPosition.baseLots === 0n
      : vault.amount === quantity && perpPosition.baseLots === -lots,
    opening ? 'entry accounts are not ready' : 'exit accounts differ from the open hedge');
    const entryPricing = opening
      ? priceTestPerpShort(quoteState.market, quoteState.oraclePricePerLot, quantity)
      : undefined;
    const exitPricing = opening
      ? undefined
      : priceTestPerpCloseShort(quoteState.market, quoteState.oraclePricePerLot, quantity);
    const priced = entryPricing ?? exitPricing!;
    const hedgeEconomics = documents.quote.legEconomics.find((leg) => leg.legId === 'treasury-hedge');
    const inventoryEconomics = documents.quote.legEconomics.find((leg) => leg.legId === 'inventory-position');
    requireCondition(hedgeEconomics?.executionPrice !== undefined && inventoryEconomics !== undefined,
      'quote lacks treasury hedge economics');
    requireCondition(hedgeEconomics.executionPrice.quoteAtoms * quoteState.market.baseLotAtoms
      === priced.fillPricePerLot * hedgeEconomics.executionPrice.baseAtoms
      && hedgeEconomics.grossNotional.atoms === priced.notionalAtoms
      && hedgeEconomics.venueFee.atoms === priced.feeAtoms,
    'live perp economics differ from the signed quote');
    const requiredMargin = entryPricing === undefined ? 0n : entryPricing.initialMarginAtoms + entryPricing.feeAtoms;
    requireCondition(!opening || hedgeEconomics.marginDelta.atoms === requiredMargin,
      'signed margin differs from the live requirement');
    requireCondition(!opening || perpPosition.collateralAtoms >= requiredMargin,
      'test perp position lacks the quoted collateral');
    const inventoryLeg = documents.graph.legs.find((leg) => leg.legId === 'inventory-position');
    const hedgeLeg = documents.graph.legs.find((leg) => leg.legId === 'treasury-hedge');
    requireCondition(inventoryLeg !== undefined && hedgeLeg !== undefined, 'strategy legs are missing');
    const materializers = Object.freeze([
      createSolanaExactInventoryMaterializer({
        binding: {
          domain: lane.pricing.domain,
          adapter: lane.pricing.inventory.adapter,
          venue: lane.pricing.inventory.venue,
          market: lane.pricing.inventory.market,
          legFamily: inventoryLeg.legFamily,
          materializationClassId: INVENTORY_CLASS,
          programId: inventoryProgram,
          expectedProgramDataHash: lane.inventoryAdapter.expectedProgramDataHash,
          maximumComputeUnitLimit: lane.inventoryAdapter.maximumComputeUnitLimit,
        },
        inventoryAsset: lane.pricing.inventoryAsset,
        strategyAccount,
        strategyToken,
        mint: inventoryMint,
        bounds: [{
          legId: inventoryLeg.legId,
          action: opening ? 'LOCK' : 'RELEASE',
          expectedPreInventoryAtoms: vault.amount,
          expectedPostInventoryAtoms: opening ? vault.amount + quantity : vault.amount - quantity,
        }],
      }),
      createSolanaTestPerpExactShortMaterializer({
        binding: {
          domain: lane.pricing.domain,
          adapter: lane.pricing.hedge.adapter,
          venue: lane.pricing.hedge.venue,
          market: lane.pricing.hedge.market,
          legFamily: hedgeLeg.legFamily,
          materializationClassId: PERP_CLASS,
          programId: hedgeProgram,
          expectedProgramDataHash: lane.hedgeAdapter.expectedProgramDataHash,
          maximumComputeUnitLimit: lane.hedgeAdapter.maximumComputeUnitLimit,
        },
        baseAsset: lane.pricing.inventoryAsset,
        quoteAsset: lane.pricing.quoteAsset,
        baseLotAtoms: quoteState.market.baseLotAtoms,
        quoteAtomsPerTickPerBaseLot: quoteState.market.quoteTickAtomsPerBaseLot,
        accounts: {
          strategy: perpAccounts.strategy,
          controller: strategyAccount,
          testPerpProgram,
          market,
          position: perpAccounts.position,
          oracle: lane.pricing.oracleAddress,
          collateralVault: quoteState.market.collateralVault,
          feeVault: quoteState.market.feeVault,
          insuranceVault: quoteState.market.insuranceVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        bounds: [{
          legId: hedgeLeg.legId,
          lastValidSlot: deadline,
          minimumPostCollateralQuoteLots: opening ? perpPosition.collateralAtoms - priced.feeAtoms : 0n,
          clientOrderId: clientOrderId(orderHash, quoteHash, routeHash),
        }],
      }),
    ]);
    const nextStateHash = opening ? stateHash({
      packageId,
      strategyAccount,
      inventory: inventoryAddresses.inventory,
      inventoryAtoms: quantity,
      perpStrategy: perpAccounts.strategy,
      perpPosition: perpAccounts.position,
      baseLots: -lots,
      collateralAtoms: perpPosition.collateralAtoms - priced.feeAtoms,
      entryNotionalAtoms: priced.notionalAtoms,
      quoteHash,
      routeHash,
    }) : undefined;
    if (nextStateHash !== undefined) await lane.packageIds.rememberPackageId?.(hex(nextStateHash), hex(packageId));
    const policy = (
      binding: SolanaTreasuryHedgeAdapterBinding,
      legId: string,
      manifestVersion: number,
      manifestHash: Uint8Array,
      grossNotionalAtoms: bigint,
    ): SolanaStrategyAdapterPolicy => Object.freeze({
      legId,
      adapterSubjectId: binding.adapterSubjectId,
      adapterManifestVersion: manifestVersion,
      adapterManifestHash: manifestHash,
      adapterProgram: binding.programId,
      adapterProgramData: binding.programDataAddress,
      riskIncreasing: opening,
      grossNotionalAtoms,
    });
    const totalGrossNotionalAtoms = inventoryEconomics.grossNotional.atoms + hedgeEconomics.grossNotional.atoms;
    u64(totalGrossNotionalAtoms, 'total gross notional');
    return Object.freeze({
      compileContext: Object.freeze({
        templateManifest: lane.templateManifest,
        activeRegistryRecords: lane.activeRegistryRecords,
        resourceLimits: lane.resourceLimits,
        currentTime: Object.freeze({ unit: 'SOLANA_SLOT' as const, value: currentSlot }),
      }),
      identity: Object.freeze({
        packageId,
        templateId: documents.order.templateId,
        templateVersion: documents.order.templateVersion,
        templateManifestHash: documents.order.packageTemplateManifestHash,
        operation: documents.order.lifecycleAction,
        ...(documents.order.expectedStrategyStateHash === undefined
          ? {}
          : { previousStateHash: documents.order.expectedStrategyStateHash }),
        ...(nextStateHash === undefined ? {} : { nextStateHash }),
      }),
      compilers: Object.freeze([createSolanaStrategyDomainCompiler({
        domain: lane.pricing.domain,
        feePayer: owner,
        allowedSignerPubkeys: [strategyAccount],
        maximumTransactionComputeUnits: lane.maximumTransactionComputeUnits,
        materializers,
      })]),
      bindings: Object.freeze([{
        kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT' as const,
        domain: lane.pricing.domain,
        coreProgramId: coreProgram,
        multiStrategyProgramId: multiProgram,
        owner,
        solver: lane.solver,
        settlementManifestHash: lane.settlementManifestHash,
        totalGrossNotionalAtoms,
        nonce: strategy.nextNonce,
        deadlineSlot: deadline,
        policies: Object.freeze([
          policy(
            lane.inventoryAdapter,
            inventoryLeg.legId,
            lane.pricing.inventory.adapter.adapterManifestVersion,
            lane.pricing.inventory.adapter.adapterManifestHash,
            inventoryEconomics.grossNotional.atoms,
          ),
          policy(
            lane.hedgeAdapter,
            hedgeLeg.legId,
            lane.pricing.hedge.adapter.adapterManifestVersion,
            lane.pricing.hedge.adapter.adapterManifestHash,
            hedgeEconomics.grossNotional.atoms,
          ),
        ]),
      }]),
    });
  }
}

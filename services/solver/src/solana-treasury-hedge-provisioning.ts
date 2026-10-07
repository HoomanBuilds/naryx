import {
  deriveSolanaMultiStrategyAccount,
  deriveSolanaPackageInventoryAddresses,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  strategyPackageOrderHash,
  type AdapterRef,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import type {
  StoredStrategyPackageOrderDocuments,
  StrategyPackageOrderProvider,
} from './http-strategy-package-provider.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BorshWriter,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodeTestPerpPosition,
  decodeTestPerpStrategyController,
  decodeTokenAccount,
  instructionDiscriminator,
} from './solana-devnet-wire.js';
import { requireSolanaDevnet } from './solana-devnet-rpc.js';
import type { SolanaTreasuryHedgePreparationLane } from './solana-treasury-hedge-preparation.js';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const U64_MAX = (1n << 64n) - 1n;

export type SolanaTreasuryHedgeProvisioningInstruction = Readonly<{
  programId: string;
  accounts: readonly Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>[];
  dataBase64: string;
}>;

export type SolanaTreasuryHedgeProvisioningStep = Readonly<{
  kind: 'CREATE_STRATEGY_ACCOUNT' | 'CREATE_TOKEN_ACCOUNTS' | 'CREATE_PACKAGE_INVENTORY'
    | 'WRAP_INVENTORY' | 'FUND_INVENTORY' | 'CREATE_PERP_POSITION' | 'DELEGATE_PERP_POSITION'
    | 'CREATE_PERP_STRATEGY' | 'DEPOSIT_PERP_COLLATERAL';
  label: string;
  instructions: readonly SolanaTreasuryHedgeProvisioningInstruction[];
}>;

export type SolanaTreasuryHedgeProvisioningPlan = Readonly<{
  version: 1;
  domainId: 'svm:devnet';
  owner: string;
  packageId: string;
  strategyAccount: string;
  ready: boolean;
  inventoryFundingRequiredAtoms: bigint;
  quoteFundingRequiredAtoms: bigint;
  steps: readonly SolanaTreasuryHedgeProvisioningStep[];
}>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Solana treasury hedge provisioning refused: ${message}`);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function key(value: string): PublicKey {
  return new PublicKey(value);
}

function u64(value: bigint, context: string): bigint {
  requireCondition(value >= 0n && value <= U64_MAX, `${context} must fit u64`);
  return value;
}

function wire(value: TransactionInstruction): SolanaTreasuryHedgeProvisioningInstruction {
  return Object.freeze({
    programId: value.programId.toBase58(),
    accounts: Object.freeze(value.keys.map((account) => Object.freeze({
      pubkey: account.pubkey.toBase58(),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    }))),
    dataBase64: Buffer.from(value.data).toString('base64'),
  });
}

function instruction(
  programId: PublicKey,
  keys: TransactionInstruction['keys'],
  data: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean) {
  return Object.freeze({ pubkey, isSigner, isWritable });
}

function anchor(name: string, payload?: Uint8Array): Uint8Array {
  return payload === undefined
    ? instructionDiscriminator(name)
    : Buffer.concat([instructionDiscriminator(name), Buffer.from(payload)]);
}

function u64le(value: bigint): Uint8Array {
  return new BorshWriter().u64(u64(value, 'instruction amount')).done();
}

function createAta(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return instruction(ASSOCIATED_TOKEN_PROGRAM_ID, [
    meta(payer, true, true),
    meta(associatedTokenAddress(owner, mint), false, true),
    meta(owner, false, false),
    meta(mint, false, false),
    meta(SystemProgram.programId, false, false),
    meta(TOKEN_PROGRAM_ID, false, false),
  ], Uint8Array.of(1));
}

function transferChecked(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(u64(amount, 'transfer amount'), 1);
  data[9] = decimals;
  return instruction(TOKEN_PROGRAM_ID, [
    meta(source, false, true), meta(mint, false, false), meta(destination, false, true), meta(owner, true, false),
  ], data);
}

function matchesLane(documents: StoredStrategyPackageOrderDocuments, lane: SolanaTreasuryHedgePreparationLane): boolean {
  if (documents.order.environment !== 'devnet' || documents.order.lifecycleAction !== 'ENTRY'
    || documents.order.templateId !== lane.templateManifest.templateId
    || documents.order.templateVersion !== lane.templateManifest.templateVersion
    || documents.graph.legs.length !== 2) return false;
  const inventory = documents.graph.legs.find((leg) => leg.legId === 'inventory-position');
  const hedge = documents.graph.legs.find((leg) => leg.legId === 'treasury-hedge');
  return inventory !== undefined && hedge !== undefined
    && sameDomain(inventory.domain, lane.pricing.domain) && sameDomain(hedge.domain, lane.pricing.domain)
    && sameAdapter(inventory.adapter, lane.pricing.inventory.adapter)
    && sameAdapter(hedge.adapter, lane.pricing.hedge.adapter);
}

function testPerpAccounts(lane: SolanaTreasuryHedgePreparationLane, owner: PublicKey) {
  const strategy = PublicKey.findProgramAddressSync([
    Buffer.from('test-perp-strategy'), owner.toBuffer(), Buffer.from(lane.testPerpStrategyId),
  ], key(lane.hedgeAdapter.programId))[0];
  const position = PublicKey.findProgramAddressSync([
    Buffer.from('test-perp-position'), key(lane.pricing.marketAddress).toBuffer(), owner.toBuffer(),
  ], key(lane.testPerpProgramId))[0];
  return Object.freeze({ strategy, position });
}

export class SolanaTreasuryHedgeProvisioningResolver {
  readonly #lanes: readonly SolanaTreasuryHedgePreparationLane[];

  constructor(lanes: readonly SolanaTreasuryHedgePreparationLane[]) {
    requireCondition(lanes.length > 0, 'at least one lane is required');
    this.#lanes = Object.freeze([...lanes]);
  }

  async resolve(documents: StoredStrategyPackageOrderDocuments): Promise<SolanaTreasuryHedgeProvisioningPlan> {
    const matches = this.#lanes.filter((lane) => matchesLane(documents, lane));
    requireCondition(matches.length === 1, 'entry order must resolve to exactly one lane');
    const lane = matches[0]!;
    await requireSolanaDevnet(lane.rpc);
    const packageId = strategyPackageOrderHash(documents.order);
    const owner = key(documents.order.owner);
    const strategyAccount = deriveSolanaMultiStrategyAccount({ programId: lane.multiStrategyProgramId, owner });
    requireCondition(strategyAccount.toBase58() === documents.order.settlementAccount,
      'order settlement account is not the owner multi-strategy account');
    const inventoryMint = key(lane.pricing.inventoryMint);
    const quoteMint = key(lane.pricing.quoteMint);
    const ownerInventory = associatedTokenAddress(owner, inventoryMint);
    const ownerQuote = associatedTokenAddress(owner, quoteMint);
    const protocolFeeToken = associatedTokenAddress(key(lane.protocolFeeRecipient), quoteMint);
    const solverFeeToken = associatedTokenAddress(key(lane.solver), quoteMint);
    const strategyInventory = associatedTokenAddress(strategyAccount, inventoryMint);
    const inventory = deriveSolanaPackageInventoryAddresses({
      programId: lane.inventoryAdapter.programId,
      strategyAccount,
      packageId,
      mint: inventoryMint,
    });
    const perp = testPerpAccounts(lane, owner);
    const slot = await lane.rpc.getFinalizedSlot();
    const state = await lane.pricing.readState();
    requireCondition(state.slot >= slot && state.slot - slot <= lane.pricing.maximumStateAdvanceSlots,
      'market and account reads are not from the same finalized head');
    const addresses = [
      strategyAccount, inventory.inventory, inventory.vault, ownerInventory, ownerQuote, strategyInventory,
      perp.position, perp.strategy, protocolFeeToken, solverFeeToken,
    ].map((value) => value.toBase58());
    const values = await lane.rpc.getAccounts(addresses, state.slot);
    const strategyValue = values[0] ?? null;
    const inventoryValue = values[1] ?? null;
    const inventoryVaultValue = values[2] ?? null;
    const ownerInventoryValue = values[3] ?? null;
    const ownerQuoteValue = values[4] ?? null;
    const strategyInventoryValue = values[5] ?? null;
    const positionValue = values[6] ?? null;
    const perpStrategyValue = values[7] ?? null;
    const protocolFeeTokenValue = values[8] ?? null;
    const solverFeeTokenValue = values[9] ?? null;
    requireCondition((inventoryValue === null) === (inventoryVaultValue === null), 'package inventory is partially initialized');
    requireCondition(strategyValue === null || strategyValue.owner === lane.multiStrategyProgramId,
      'strategy account has the wrong owner');
    requireCondition(inventoryValue === null || inventoryValue.owner === lane.inventoryAdapter.programId,
      'package inventory has the wrong owner');
    requireCondition(inventoryVaultValue === null || inventoryVaultValue.owner === TOKEN_PROGRAM_ID.toBase58(),
      'package inventory vault has the wrong owner');
    const tokenAmount = (account: typeof ownerInventoryValue, expectedOwner: PublicKey, expectedMint: PublicKey): bigint => {
      if (account === null) return 0n;
      requireCondition(account.owner === TOKEN_PROGRAM_ID.toBase58(), 'token account has the wrong program owner');
      const decoded = decodeTokenAccount(account.data);
      requireCondition(decoded.owner === expectedOwner.toBase58() && decoded.mint === expectedMint.toBase58(),
        'token account identity differs from its address');
      return decoded.amount;
    };
    const ownerInventoryAtoms = tokenAmount(ownerInventoryValue, owner, inventoryMint);
    const ownerQuoteAtoms = tokenAmount(ownerQuoteValue, owner, quoteMint);
    const strategyInventoryAtoms = tokenAmount(strategyInventoryValue, strategyAccount, inventoryMint);
    tokenAmount(protocolFeeTokenValue, key(lane.protocolFeeRecipient), quoteMint);
    tokenAmount(solverFeeTokenValue, key(lane.solver), quoteMint);
    const position = positionValue === null ? undefined : decodeTestPerpPosition(positionValue.data);
    if (positionValue !== null) {
      requireCondition(positionValue.owner === lane.testPerpProgramId && position?.owner === owner.toBase58()
        && position.market === lane.pricing.marketAddress, 'test perp position identity is invalid');
    }
    const child = perpStrategyValue === null ? undefined : decodeTestPerpStrategyController(perpStrategyValue.data);
    if (perpStrategyValue !== null) {
      requireCondition(perpStrategyValue.owner === lane.hedgeAdapter.programId
        && child?.owner === owner.toBase58() && child.controller === strategyAccount.toBase58()
        && child.position === perp.position.toBase58() && child.market === lane.pricing.marketAddress
        && child.maxBaseLots >= lane.testPerpMaximumBaseLots, 'test perp strategy identity or capacity is invalid');
    }
    const quantity = u64(documents.order.economicQuantity.atoms, 'package quantity');
    const requiredCollateral = u64(documents.order.maximumMarginIncrease.atoms, 'maximum margin increase');
    const currentCollateral = position?.collateralAtoms ?? 0n;
    const inventoryShortfall = quantity > strategyInventoryAtoms ? quantity - strategyInventoryAtoms : 0n;
    const quoteShortfall = requiredCollateral > currentCollateral ? requiredCollateral - currentCollateral : 0n;
    const serviceFeeCap = documents.order.maximumServiceFeesByAsset.find((cap) =>
      cap.asset.assetId === lane.pricing.quoteAsset.assetId
      && cap.asset.decimals === lane.pricing.quoteAsset.decimals
      && bytesEqual(cap.asset.assetManifestHash, lane.pricing.quoteAsset.assetManifestHash))?.maxAtoms ?? 0n;
    const ownerQuoteRequirement = u64(quoteShortfall + serviceFeeCap, 'quote funding requirement');
    const steps: SolanaTreasuryHedgeProvisioningStep[] = [];
    const push = (step: SolanaTreasuryHedgeProvisioningStep) => steps.push(Object.freeze({
      ...step,
      instructions: Object.freeze(step.instructions),
    }));
    if (strategyValue === null) {
      const config = PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], key(lane.coreProgramId))[0];
      push({
        kind: 'CREATE_STRATEGY_ACCOUNT',
        label: 'Create owner multi-strategy account',
        instructions: [wire(instruction(key(lane.multiStrategyProgramId), [
          meta(owner, true, true), meta(config, false, false), meta(strategyAccount, false, true),
          meta(SystemProgram.programId, false, false),
        ], anchor('initialize_multi_strategy_account')))],
      });
    }
    const missingAtas: TransactionInstruction[] = [];
    if (ownerInventoryValue === null) missingAtas.push(createAta(owner, owner, inventoryMint));
    if (ownerQuoteValue === null) missingAtas.push(createAta(owner, owner, quoteMint));
    if (strategyInventoryValue === null) missingAtas.push(createAta(owner, strategyAccount, inventoryMint));
    if (protocolFeeTokenValue === null) {
      missingAtas.push(createAta(owner, key(lane.protocolFeeRecipient), quoteMint));
    }
    if (solverFeeTokenValue === null) missingAtas.push(createAta(owner, key(lane.solver), quoteMint));
    if (missingAtas.length > 0) {
      push({ kind: 'CREATE_TOKEN_ACCOUNTS', label: 'Create strategy token accounts', instructions: missingAtas.map(wire) });
    }
    if (inventoryValue === null) {
      push({
        kind: 'CREATE_PACKAGE_INVENTORY',
        label: 'Create isolated package inventory',
        instructions: [wire(instruction(key(lane.inventoryAdapter.programId), [
          meta(owner, true, true), meta(strategyAccount, false, false), meta(inventoryMint, false, false),
          meta(inventory.inventory, false, true), meta(inventory.vault, false, true),
          meta(SystemProgram.programId, false, false), meta(TOKEN_PROGRAM_ID, false, false),
        ], anchor('initialize_package_inventory', packageId)))],
      });
    }
    if (inventoryShortfall > 0n && inventoryMint.toBase58() === WRAPPED_SOL_MINT
      && ownerInventoryAtoms < inventoryShortfall) {
      const wrapAtoms = inventoryShortfall - ownerInventoryAtoms;
      push({
        kind: 'WRAP_INVENTORY',
        label: `Wrap ${wrapAtoms} lamports for package inventory`,
        instructions: [
          wire(SystemProgram.transfer({ fromPubkey: owner, toPubkey: ownerInventory, lamports: wrapAtoms })),
          wire(instruction(TOKEN_PROGRAM_ID, [meta(ownerInventory, false, true)], Uint8Array.of(17))),
        ],
      });
    }
    const inventoryAvailable = inventoryMint.toBase58() === WRAPPED_SOL_MINT
      ? ownerInventoryAtoms + (inventoryShortfall > ownerInventoryAtoms ? inventoryShortfall - ownerInventoryAtoms : 0n)
      : ownerInventoryAtoms;
    if (inventoryShortfall > 0n && inventoryAvailable >= inventoryShortfall) {
      push({
        kind: 'FUND_INVENTORY',
        label: `Fund strategy inventory with ${inventoryShortfall} atoms`,
        instructions: [wire(transferChecked(
          ownerInventory, inventoryMint, strategyInventory, owner, inventoryShortfall, lane.pricing.inventoryAsset.decimals,
        ))],
      });
    }
    if (positionValue === null) {
      push({
        kind: 'CREATE_PERP_POSITION',
        label: 'Create owner test perpetual position',
        instructions: [wire(instruction(key(lane.testPerpProgramId), [
          meta(owner, true, true), meta(key(lane.pricing.marketAddress), false, false), meta(perp.position, false, true),
          meta(SystemProgram.programId, false, false),
        ], anchor('initialize_position')))],
      });
    }
    if (position === undefined || position.delegate !== perp.strategy.toBase58()) {
      push({
        kind: 'DELEGATE_PERP_POSITION',
        label: 'Delegate test perpetual trading to the strategy',
        instructions: [wire(instruction(key(lane.testPerpProgramId), [
          meta(owner, true, false), meta(perp.position, false, true),
        ], anchor('set_delegate', perp.strategy.toBytes())))],
      });
    }
    if (perpStrategyValue === null) {
      const payload = new BorshWriter()
        .bytes(lane.testPerpStrategyId)
        .key(strategyAccount)
        .u64(lane.testPerpMaximumBaseLots)
        .done();
      push({
        kind: 'CREATE_PERP_STRATEGY',
        label: 'Create controller-bound test perpetual strategy',
        instructions: [wire(instruction(key(lane.hedgeAdapter.programId), [
          meta(owner, true, true), meta(perp.strategy, false, true), meta(key(lane.pricing.marketAddress), false, false),
          meta(perp.position, false, false), meta(SystemProgram.programId, false, false),
        ], anchor('initialize_test_perp_strategy', payload)))],
      });
    }
    if (quoteShortfall > 0n && ownerQuoteAtoms >= ownerQuoteRequirement) {
      push({
        kind: 'DEPOSIT_PERP_COLLATERAL',
        label: `Deposit ${quoteShortfall} quote atoms as test perpetual collateral`,
        instructions: [wire(instruction(key(lane.testPerpProgramId), [
          meta(owner, true, false), meta(key(lane.pricing.marketAddress), false, false), meta(perp.position, false, true),
          meta(key(state.market.collateralVault), false, true), meta(ownerQuote, false, true), meta(TOKEN_PROGRAM_ID, false, false),
        ], anchor('deposit', u64le(quoteShortfall))))],
      });
    }
    const inventoryFundingRequiredAtoms = inventoryShortfall > inventoryAvailable
      ? inventoryShortfall - inventoryAvailable : 0n;
    const quoteFundingRequiredAtoms = ownerQuoteRequirement > ownerQuoteAtoms
      ? ownerQuoteRequirement - ownerQuoteAtoms : 0n;
    return Object.freeze({
      version: 1,
      domainId: 'svm:devnet',
      owner: owner.toBase58(),
      packageId: Buffer.from(packageId).toString('hex'),
      strategyAccount: strategyAccount.toBase58(),
      ready: steps.length === 0 && inventoryFundingRequiredAtoms === 0n && quoteFundingRequiredAtoms === 0n,
      inventoryFundingRequiredAtoms,
      quoteFundingRequiredAtoms,
      steps: Object.freeze(steps),
    });
  }
}

export class SolanaTreasuryHedgeProvisioningService {
  readonly #packages: StrategyPackageOrderProvider;
  readonly #resolver: SolanaTreasuryHedgeProvisioningResolver;

  constructor(packages: StrategyPackageOrderProvider, resolver: SolanaTreasuryHedgeProvisioningResolver) {
    this.#packages = packages;
    this.#resolver = resolver;
  }

  async provisionByOrder(orderHash: Hash32): Promise<SolanaTreasuryHedgeProvisioningPlan | undefined> {
    const documents = await this.#packages.getByOrder(orderHash);
    return documents === undefined ? undefined : this.#resolver.resolve(documents);
  }
}

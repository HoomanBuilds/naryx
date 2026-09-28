import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Ed25519Program,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { DomainRef, PackageAdmission } from '@naryx/protocol-types';
import {
  compileFirmCashCarryPlan,
  decodeCashCarryExecutionReceipt,
  FIRM_CASH_CARRY_ACCOUNT_NAMES,
  PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  SolanaUnsignedTransactionMaterializer,
  solanaIdlContentHash,
  type FirmCashCarryAccountName,
  type FirmCashCarryBinding,
  type PublicCashCarryExitAccountName,
  type PublicCashCarryExitBinding,
  type PublicCashCarryResourceEvidence,
  type PublicCashCarryResourceName,
  type SolanaLookupTableSnapshot,
  type SolanaReadOnlyRpc,
} from '../src/index.js';

const { BN, BorshCoder } = anchor;
const coreIdl = JSON.parse(readFileSync(new URL('../../../../../deployments/solana/program/idl/naryx_core.json', import.meta.url), 'utf8')) as Idl;
const LEGACY_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const address = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

test('decodes the production cash-carry receipt account shape', async () => {
  const coder = new BorshCoder(coreIdl);
  const trader = address(21);
  const solver = address(22);
  const entryReceipt = address(23);
  const data = await coder.accounts.encode('CashCarryExecutionReceipt', {
    domain: { domain_id: 'svm:devnet', domain_manifest_version: 1, domain_manifest_hash: Array.from(hash(1)) },
    order_hash: Array.from(hash(2)),
    quote_hash: Array.from(hash(3)),
    route_hash: Array.from(hash(4)),
    trader,
    solver,
    nonce: new BN(7),
    execution_digest: Array.from(hash(5)),
    quote_intent_commitment: Array.from(hash(6)),
    package_fill_commitment: Array.from(hash(7)),
    action: 1,
    recovery: false,
    spot_quantity_atoms: new BN(10),
    perp_quantity_atoms: new BN(11),
    spot_quote_delta_atoms: new BN(12),
    pre_base_balance: new BN(13),
    post_base_balance: new BN(14),
    pre_quote_balance: new BN(15),
    post_quote_balance: new BN(16),
    pre_rise_base_lots: new BN(-10),
    post_rise_base_lots: new BN(-11),
    pre_rise_collateral_quote_lots: new BN(17),
    post_rise_collateral_quote_lots: new BN(18),
    execution_slot: new BN(19),
    resource_admission_commitment: Array.from(hash(8)),
    route_accounts_commitment: Array.from(hash(9)),
    entry_receipt: entryReceipt,
    bump: 255,
  });
  const decoded = decodeCashCarryExecutionReceipt(coreIdl, data);
  assert.equal(decoded.trader, trader.toBase58());
  assert.equal(decoded.solver, solver.toBase58());
  assert.equal(decoded.entryReceipt, entryReceipt.toBase58());
  assert.equal(decoded.nonce, 7n);
  assert.equal(decoded.spotQuantityAtoms, 10n);
  assert.equal(decoded.perpQuantityAtoms, 11n);
  assert.equal(hex(decoded.routeAccountsCommitment), hex(hash(9)));
});

function fixedIdlAddress(name: string): PublicKey {
  const instruction = coreIdl.instructions.find((item) => item.name === 'execute_firm_cash_and_carry')!;
  const visit = (items: typeof instruction.accounts): string | undefined => {
    for (const item of items) {
      if ('accounts' in item) {
        const found = visit(item.accounts);
        if (found !== undefined) return found;
      } else if (item.name === name) {
        return item.address;
      }
    }
    return undefined;
  };
  const value = visit(instruction.accounts);
  assert(value !== undefined, `missing fixed IDL address ${name}`);
  return new PublicKey(value);
}

function publicExitIdlAddress(name: string): PublicKey {
  const instruction = coreIdl.instructions.find((item) => item.name === 'execute_cash_and_carry')!;
  const visit = (items: typeof instruction.accounts): string | undefined => {
    for (const item of items) {
      if ('accounts' in item) {
        const found = visit(item.accounts);
        if (found !== undefined) return found;
      } else if (item.name === name) {
        return item.address;
      }
    }
    return undefined;
  };
  const value = visit(instruction.accounts);
  assert(value !== undefined, `missing fixed public-exit IDL address ${name}`);
  return new PublicKey(value);
}

function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return new Uint8Array(digest.digest());
}

function domainHash(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  return sha256(Buffer.from(domain, 'ascii'), ...parts);
}

function bigEndian(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function protocolIdBytes(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(bigEndian(BigInt(bytes.length), 4)), bytes]);
}

function domainBytes(domain: DomainRef): Uint8Array {
  return Buffer.concat([
    Buffer.from(protocolIdBytes(domain.domainId)),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(domain.domainManifestHash),
  ]);
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), LEGACY_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function quoteArgsForCoder(binding: FirmCashCarryBinding) {
  const value = binding.quoteArgs;
  return {
    package_book_code_identity: Array.from(value.packageBookCodeIdentity),
    series_manifest_hash: Array.from(value.seriesManifestHash),
    execution_class_manifest_hash: Array.from(value.executionClassManifestHash),
    expected_reference_sequence: new BN(value.expectedReferenceSequence.toString()),
    expected_shard_sequence: new BN(value.expectedShardSequence.toString()),
    slot_index: value.slotIndex,
    level_id: new BN(value.levelId.toString()),
    expected_level_sequence: new BN(value.expectedLevelSequence.toString()),
    expected_side: value.expectedSide,
    package_size_units: new BN(value.packageSizeUnits.toString()),
    expected_package_price: new BN(value.expectedPackagePrice.toString()),
    expected_max_fee_atoms: new BN(value.expectedMaxFeeAtoms.toString()),
    expected_expiry_slot: new BN(value.expectedExpirySlot.toString()),
    expected_settlement_class_identity_hash: Array.from(value.expectedSettlementClassIdentityHash),
    expected_quote_mode: value.expectedQuoteMode,
    expected_reservation_policy_hash: Array.from(value.expectedReservationPolicyHash),
    reservation_id: Array.from(value.reservationId),
    expected_fill_commitment: Array.from(value.expectedFillCommitment),
  };
}

function fixture(dynamicCount = 0): { admission: PackageAdmission; binding: FirmCashCarryBinding } {
  const domain = {
    domainId: 'svm:local-firm',
    domainManifestVersion: 1,
    domainManifestHash: hash(9),
  } as unknown as DomainRef;
  const coreProgram = new PublicKey(coreIdl.address);
  const reservationProgram = fixedIdlAddress('reservation_program');
  const packageBookProgram = address(202);
  const perpAdapterProgram = fixedIdlAddress('perp_adapter_program');
  const perpVenueProgram = fixedIdlAddress('perp_venue_program');
  const baseMint = address(205);
  const quoteMint = address(206);
  const trader = address(207);
  const solver = address(208);
  const riseStrategy = address(209);
  const executorAuthority = PublicKey.findProgramAddressSync([
    Buffer.from('cash-carry-executor'), trader.toBuffer(), riseStrategy.toBuffer(),
  ], coreProgram)[0];
  const coreCode = hash(31);
  const reservationCode = hash(32);
  const packageBookCode = hash(33);
  const perpAdapterCode = hash(34);
  const perpVenueCode = hash(35);
  const seriesHash = hash(36);
  const executionClassHash = hash(37);
  const settlementClassHash = hash(38);
  const fillCommitment = hash(39);
  const reservationNonce = hash(40);
  const orderHash = hash(41);
  const quoteHash = hash(42);
  const routeHash = hash(43);
  const resourceCommitment = hash(44);
  const domainIdentity = domainHash('CON/v1/domain-ref-identity', domainBytes(domain));
  const reservationClass = PublicKey.findProgramAddressSync([
    Buffer.from('reservation-class'),
    Buffer.from(domainIdentity),
    Buffer.from(bigEndian(1n, 4)),
    Buffer.from(domain.domainManifestHash),
    baseMint.toBuffer(),
    quoteMint.toBuffer(),
    coreProgram.toBuffer(),
  ], reservationProgram)[0];
  const reservationPolicy = domainHash(
    'NARYX/firm-reservation-policy/v1',
    reservationProgram.toBytes(),
    address(211).toBytes(),
    reservationCode,
    reservationClass.toBytes(),
    bigEndian(2n, 2),
    domainBytes(domain),
    baseMint.toBytes(),
    quoteMint.toBytes(),
    coreProgram.toBytes(),
    address(210).toBytes(),
    coreCode,
  );
  const reservationId = domainHash(
    'CON/v1/reservation-id',
    domainBytes(domain),
    protocolIdBytes(solver.toBase58()),
    orderHash,
    reservationNonce,
  );
  const reservation = PublicKey.findProgramAddressSync([
    Buffer.from('reservation'), reservationClass.toBuffer(), solver.toBuffer(), Buffer.from(reservationId),
  ], reservationProgram)[0];
  const reservationCapacity = PublicKey.findProgramAddressSync([
    Buffer.from('reservation-capacity'), reservationClass.toBuffer(), solver.toBuffer(),
  ], reservationProgram)[0];
  const livePair = PublicKey.findProgramAddressSync([
    Buffer.from('live-pair'), reservationClass.toBuffer(), solver.toBuffer(), executorAuthority.toBuffer(),
  ], reservationProgram)[0];
  const reservationVault = PublicKey.findProgramAddressSync([
    Buffer.from('reservation-vault'), reservationClass.toBuffer(), solver.toBuffer(), Buffer.from(reservationId),
  ], reservationProgram)[0];
  const quoteLock = PublicKey.findProgramAddressSync([
    Buffer.from('firm-quote-lock'), Buffer.from(reservationId),
  ], coreProgram)[0];

  let nextAddress = 1;
  const accountAddresses = Object.fromEntries(FIRM_CASH_CARRY_ACCOUNT_NAMES.map((name) => [name, address(nextAddress++).toBase58()])) as Record<FirmCashCarryAccountName, string>;
  const resourceSeeds = {
    spotAdapter: ['adapter', hash(71)], perpAdapter: ['adapter', hash(72)],
    spotMarket: ['market', hash(73)], perpMarket: ['market', hash(74)],
    spotVenue: ['venue', hash(75)], perpVenue: ['venue', hash(76)],
    baseAsset: ['asset', hash(77)], quoteAsset: ['asset', hash(78)],
  } as const;
  for (const [name, [kind, subjectId]] of Object.entries(resourceSeeds)) {
    accountAddresses[`${name}Index` as FirmCashCarryAccountName] = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-index'), Buffer.from(kind), Buffer.from(subjectId),
    ], coreProgram)[0].toBase58();
    accountAddresses[`${name}Record` as FirmCashCarryAccountName] = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-record'), Buffer.from(kind), Buffer.from(subjectId), Buffer.from(bigEndian(1n, 4)),
    ], coreProgram)[0].toBase58();
  }
  const seriesIdentity = domainHash(
    'CON/v1/cash-carry-series-identity', domainIdentity, seriesHash, executionClassHash,
  );
  Object.assign(accountAddresses, {
    trader: trader.toBase58(),
    solver: solver.toBase58(),
    config: PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], coreProgram)[0].toBase58(),
    solverRegistry: PublicKey.findProgramAddressSync([Buffer.from('conformance-solver')], coreProgram)[0].toBase58(),
    receipt: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-receipt'), trader.toBuffer(), Buffer.from(orderHash)], coreProgram)[0].toBase58(),
    nonceMarker: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-nonce'), trader.toBuffer(), Buffer.from(bigEndian(7n, 8))], coreProgram)[0].toBase58(),
    openPackage: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-open'), trader.toBuffer(), riseStrategy.toBuffer()], coreProgram)[0].toBase58(),
    executorAuthority: executorAuthority.toBase58(),
    reservationClass: reservationClass.toBase58(),
    reservationCapacity: reservationCapacity.toBase58(),
    reservation: reservation.toBase58(),
    livePair: livePair.toBase58(),
    reservationVault: reservationVault.toBase58(),
    solverQuote: ata(solver, quoteMint).toBase58(),
    traderBase: ata(trader, baseMint).toBase58(),
    traderQuote: ata(trader, quoteMint).toBase58(),
    executorBase: ata(executorAuthority, baseMint).toBase58(),
    executorQuote: ata(executorAuthority, quoteMint).toBase58(),
    quoteLock: quoteLock.toBase58(),
    seriesIndex: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-series-index'), Buffer.from(seriesIdentity)], coreProgram)[0].toBase58(),
    seriesRecord: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-series-record'), Buffer.from(seriesIdentity), Buffer.from(bigEndian(1n, 4))], coreProgram)[0].toBase58(),
    coreProgram: coreProgram.toBase58(),
    coreProgramData: address(210).toBase58(),
    reservationProgram: reservationProgram.toBase58(),
    reservationProgramData: address(211).toBase58(),
    packageBookProgram: packageBookProgram.toBase58(),
    packageBookProgramData: address(212).toBase58(),
    perpAdapterProgram: perpAdapterProgram.toBase58(),
    perpAdapterProgramData: address(213).toBase58(),
    perpVenueProgram: perpVenueProgram.toBase58(),
    perpVenueProgramData: address(214).toBase58(),
    riseStrategy: riseStrategy.toBase58(),
    riseLogAuthority: fixedIdlAddress('rise_log_authority').toBase58(),
    riseGlobalConfig: fixedIdlAddress('rise_global_config').toBase58(),
    tokenProgram: LEGACY_TOKEN_PROGRAM_ID.toBase58(),
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
  });
  const accounts = Object.fromEntries(FIRM_CASH_CARRY_ACCOUNT_NAMES.map((name) => [name, {
    address: accountAddresses[name],
    routeBindingId: `firm-${name}`,
  }])) as FirmCashCarryBinding['accounts'];
  const dynamic = Array.from({ length: dynamicCount }, (_, index) => ({
    address: address(220 + index).toBase58(),
    routeBindingId: `rise-dynamic-${index}`,
    isWritable: index % 2 === 0,
  }));
  const codeByAccount = new Map<FirmCashCarryAccountName, Uint8Array>([
    ['coreProgram', coreCode],
    ['reservationProgram', reservationCode],
    ['packageBookProgram', packageBookCode],
    ['perpAdapterProgram', perpAdapterCode],
    ['perpVenueProgram', perpVenueCode],
  ]);
  const authorityByToken = {
    reservationVault: reservation,
    solverQuote: solver,
    traderBase: trader,
    traderQuote: trader,
    executorBase: executorAuthority,
    executorQuote: executorAuthority,
  } as const;
  const accountBindings = FIRM_CASH_CARRY_ACCOUNT_NAMES.map((name) => ({
    routeBindingId: accounts[name].routeBindingId,
    accountIdentity: accountAddresses[name],
    ...(codeByAccount.has(name) ? { codeIdentity: hex(codeByAccount.get(name)!) } : {}),
    ...((name in authorityByToken) ? {
      ownerIdentity: LEGACY_TOKEN_PROGRAM_ID.toBase58(),
      authorityIdentity: authorityByToken[name as keyof typeof authorityByToken].toBase58(),
    } : {}),
  }));
  accountBindings.push(...dynamic.map((item) => ({
    routeBindingId: item.routeBindingId,
    accountIdentity: item.address,
  })));

  const baseAsset = { assetId: baseMint.toBase58(), assetManifestHash: hash(51), decimals: 6 };
  const quoteAsset = { assetId: quoteMint.toBase58(), assetManifestHash: hash(52), decimals: 6 };
  const spotAdapter = { adapterId: 'firm-reservation', adapterManifestVersion: 1, adapterManifestHash: hash(53) };
  const perpAdapter = { adapterId: 'rise', adapterManifestVersion: 1, adapterManifestHash: hash(54) };
  const spotVenue = { subjectId: 'reservation-class', manifestVersion: 1, manifestHash: hash(55) };
  const perpVenue = { subjectId: 'rise', manifestVersion: 1, manifestHash: hash(56) };
  const spotMarket = { subjectId: 'reservation-market', manifestVersion: 1, manifestHash: hash(57) };
  const perpMarket = { subjectId: 'rise-market', manifestVersion: 1, manifestHash: hash(58) };
  const admission = {
    orderHash,
    quoteHash,
    routeHash,
    order: {
      environment: 'local',
      domain,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: hash(59),
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      action: 'ENTRY',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      owner: trader.toBase58(),
      expiryUnit: 'SOLANA_SLOT',
      expiryValue: 500n,
      nonce: 7n,
      quantity: { asset: baseAsset, atoms: 10n },
      maxSpotQuoteIn: { asset: quoteAsset, atoms: 100n },
    },
    quote: {
      environment: 'local',
      domain,
      orderHash,
      routeHash,
      quoteMode: 'FIRM_ONCHAIN',
      reservationId,
      solverId: solver.toBase58(),
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: solver.toBytes(),
      expectedGrossSpotQuantity: { asset: baseAsset, atoms: 10n },
      expectedSpotNotional: { asset: quoteAsset, atoms: 50n },
      protocolFee: { asset: quoteAsset, atoms: 0n },
      solverFee: { asset: quoteAsset, atoms: 0n },
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: 480n,
    },
    route: {
      environment: 'local',
      domain,
      orderHash,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: hash(59),
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      executionPlanKind: 'SVM_ATOMIC_CPI',
      action: 'ENTRY',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      owner: trader.toBase58(),
      solver: solver.toBase58(),
      routeExpiryUnit: 'SOLANA_SLOT',
      routeExpiryValue: 490n,
      serviceCharges: [],
      accountBindings,
      legs: [
        { legRole: 'SPOT', side: 'BUY', quantity: { asset: baseAsset, atoms: 10n }, baseAsset, quoteAsset, adapter: spotAdapter, venue: spotVenue, market: spotMarket },
        { legRole: 'PERPETUAL', side: 'SELL', quantity: { asset: baseAsset, atoms: 10n }, baseAsset, quoteAsset, adapter: perpAdapter, venue: perpVenue, market: perpMarket },
      ],
      actions: [
        { authorityBindingId: accounts.trader.routeBindingId },
        { authorityBindingId: accounts.trader.routeBindingId },
      ],
    },
  } as unknown as PackageAdmission;

  const quoteArgs = {
    packageBookCodeIdentity: packageBookCode,
    seriesManifestHash: seriesHash,
    executionClassManifestHash: executionClassHash,
    expectedReferenceSequence: 1n,
    expectedShardSequence: 2n,
    slotIndex: 0,
    levelId: 3n,
    expectedLevelSequence: 4n,
    expectedSide: 2 as const,
    packageSizeUnits: 10n,
    expectedPackagePrice: 5n,
    expectedMaxFeeAtoms: 0n as const,
    expectedExpirySlot: 480n,
    expectedSettlementClassIdentityHash: settlementClassHash,
    expectedQuoteMode: 2 as const,
    expectedReservationPolicyHash: reservationPolicy,
    reservationId,
    expectedFillCommitment: fillCommitment,
  };
  const quoteArgsBorsh = {
    package_book_code_identity: Array.from(quoteArgs.packageBookCodeIdentity),
    series_manifest_hash: Array.from(quoteArgs.seriesManifestHash),
    execution_class_manifest_hash: Array.from(quoteArgs.executionClassManifestHash),
    expected_reference_sequence: new BN('1'),
    expected_shard_sequence: new BN('2'),
    slot_index: 0,
    level_id: new BN('3'),
    expected_level_sequence: new BN('4'),
    expected_side: 2,
    package_size_units: new BN('10'),
    expected_package_price: new BN('5'),
    expected_max_fee_atoms: new BN('0'),
    expected_expiry_slot: new BN('480'),
    expected_settlement_class_identity_hash: Array.from(settlementClassHash),
    expected_quote_mode: 2,
    expected_reservation_policy_hash: Array.from(reservationPolicy),
    reservation_id: Array.from(reservationId),
    expected_fill_commitment: Array.from(fillCommitment),
  };
  const quoteArgsHash = domainHash(
    'NARYX/firm-quote-args/v1',
    new BorshCoder(coreIdl).types.encode('CashCarryQuoteArgs', quoteArgsBorsh),
  );
  const binding = {
    environment: 'local',
    domain,
    coreIdl,
    expectedCoreIdlHash: solanaIdlContentHash(coreIdl),
    deployments: {
      core: { programId: coreProgram, programDataAddress: address(210), codeIdentity: coreCode },
      reservation: { programId: reservationProgram, programDataAddress: address(211), codeIdentity: reservationCode },
      packageBook: { programId: packageBookProgram, programDataAddress: address(212), codeIdentity: packageBookCode },
      perpAdapter: { programId: perpAdapterProgram, programDataAddress: address(213), codeIdentity: perpAdapterCode },
      perpVenue: { programId: perpVenueProgram, programDataAddress: address(214), codeIdentity: perpVenueCode },
    },
    accounts,
    riseDynamicAccounts: dynamic,
    tokenAccounts: {
      reservationVault: { mint: baseMint, authority: reservation, amountAtoms: 10n },
      solverQuote: { mint: quoteMint, authority: solver, amountAtoms: 100n },
      traderBase: { mint: baseMint, authority: trader, amountAtoms: 0n },
      traderQuote: { mint: quoteMint, authority: trader, amountAtoms: 100n },
      executorBase: { mint: baseMint, authority: executorAuthority, amountAtoms: 0n },
      executorQuote: { mint: quoteMint, authority: executorAuthority, amountAtoms: 0n },
    },
    resources: {
      spotAdapter: { manifestHash: spotAdapter.adapterManifestHash, subjectAddress: reservationProgram, programId: reservationProgram, codeIdentity: reservationCode, adapterClassId: 'naryx.solana.spot-firm-reservation' },
      perpAdapter: { manifestHash: perpAdapter.adapterManifestHash, subjectAddress: perpAdapterProgram, programId: perpAdapterProgram, codeIdentity: perpAdapterCode },
      spotMarket: { manifestHash: spotMarket.manifestHash, subjectAddress: reservationClass, programId: reservationProgram, codeIdentity: reservationCode },
      perpMarket: { manifestHash: perpMarket.manifestHash, subjectAddress: accountAddresses.riseOrderbook, programId: perpVenueProgram, codeIdentity: perpVenueCode },
      spotVenue: { manifestHash: spotVenue.manifestHash, subjectAddress: reservationClass, programId: reservationProgram, codeIdentity: reservationCode },
      perpVenue: { manifestHash: perpVenue.manifestHash, subjectAddress: accountAddresses.riseGlobalConfig, programId: perpVenueProgram, codeIdentity: perpVenueCode },
      baseAsset: { manifestHash: baseAsset.assetManifestHash, subjectAddress: baseMint, programId: LEGACY_TOKEN_PROGRAM_ID },
      quoteAsset: { manifestHash: quoteAsset.assetManifestHash, subjectAddress: quoteMint, programId: LEGACY_TOKEN_PROGRAM_ID },
      spotBaseLotAtoms: 1n,
      perpBaseLotAtoms: 1n,
      perpQuoteTickAtomsPerBaseLot: 1n,
    },
    series: {
      seriesManifestHash: seriesHash,
      executionClassManifestHash: executionClassHash,
      settlementClassIdentityHash: settlementClassHash,
      entrySide: 'ASK',
      spotBaseAtomsPerPackageUnit: 1n,
      perpQuantityAtomsPerPackageUnit: 1n,
    },
    reservationClass: {
      version: 2,
      domain,
      policyHash: reservationPolicy,
      baseMint,
      quoteMint,
      maxTtlSlots: 100n,
      maxBaseAtoms: 100n,
      maxSolverReservedBaseAtoms: 200n,
    },
    reservation: {
      fundingFinalized: true,
      state: 'LIVE',
      domain,
      reservationId,
      reservationNonce,
      solverId: solver.toBase58(),
      solver,
      strategyAuthority: executorAuthority,
      packageNonce: 7n,
      orderHash,
      quoteHash,
      routeHash,
      baseMint,
      quoteMint,
      solverReclaimBase: ata(solver, baseMint),
      solverQuote: accountAddresses.solverQuote,
      strategyBase: accountAddresses.executorBase,
      strategyQuote: accountAddresses.executorQuote,
      baseAtoms: 10n,
      quoteAtoms: 50n,
      expirySlot: 480n,
      action: 'ENTRY',
    },
    quoteLock: {
      consumed: false,
      domain,
      solver,
      reservation,
      reservationId,
      reservationPolicyHash: reservationPolicy,
      orderHash,
      quoteHash,
      routeHash,
      quoteArgsHash,
      seriesManifestHash: seriesHash,
      executionClassManifestHash: executionClassHash,
      fillCommitment,
      packageSizeUnits: 10n,
      baseAtoms: 10n,
      quoteAtoms: 50n,
      expirySlot: 480n,
    },
    executionArgs: {
      spotQuantityAtoms: 10n,
      perpQuantityAtoms: 10n,
      spotLimitQuoteAtomsPerBaseLot: 10n,
      perpLimitQuoteAtomsPerBaseLot: 8n,
      packageNotionalAtoms: 80n,
      spotSqrtPriceLimit: 1n,
      minimumRiseCollateralQuoteLots: 1n,
      clientOrderId: 6n,
      expirySlot: 480n,
      nonce: 7n,
    },
    quoteArgs,
    firmQuoteAtoms: 50n,
    resourceAdmissionCommitment: resourceCommitment,
    solverSignature: new Uint8Array(64).fill(61),
    computeUnitLimit: 1_000_000,
    currentSlot: 100n,
    traderRouteBindingId: accounts.trader.routeBindingId,
    solverRouteBindingId: accounts.solver.routeBindingId,
  } as const satisfies FirmCashCarryBinding;
  return { admission, binding };
}

function namedAddress(name: string): PublicKey {
  return new PublicKey(sha256(Buffer.from(name, 'ascii')));
}

function attachPublicExit(
  value: ReturnType<typeof fixture>,
  mode: 'SOLVER_AUTHORIZED' | 'TRADER_RECOVERY' = 'SOLVER_AUTHORIZED',
  dynamicCount = 0,
): PublicCashCarryExitBinding {
  const { admission: entry, binding: firm } = value;
  const coreProgram = new PublicKey(firm.deployments.core.programId);
  const trader = new PublicKey(firm.accounts.trader.address);
  const solver = new PublicKey(firm.accounts.solver.address);
  const baseMint = new PublicKey(firm.resources.baseAsset.subjectAddress);
  const quoteMint = new PublicKey(firm.resources.quoteAsset.subjectAddress);
  const spotAdapterProgram = publicExitIdlAddress('spot_adapter_program');
  const spotVenueProgram = publicExitIdlAddress('spot_venue_program');
  const spotAdapterData = namedAddress('exit-spot-adapter-data');
  const spotVenueData = namedAddress('exit-spot-venue-data');
  const spotAdapterCode = hash(91);
  const spotVenueCode = hash(92);
  const whirlpool = namedAddress('exit-whirlpool');
  const exitOrderHash = hash(93);
  const exitQuoteHash = hash(94);
  const exitRouteHash = hash(95);
  const entryReceiptHash = hash(96);
  const settlementManifestHash = hash(97);

  const resourceInputs = {
    spotAdapter: { protocolSubjectId: 'orca', subjectId: hash(81), manifestHash: hash(101), subjectAddress: spotAdapterProgram, programId: spotAdapterProgram, programDataAddress: spotAdapterData, codeIdentity: spotAdapterCode },
    perpAdapter: { protocolSubjectId: entry.route.legs[1]!.adapter.adapterId, subjectId: hash(72), manifestHash: entry.route.legs[1]!.adapter.adapterManifestHash, subjectAddress: firm.deployments.perpAdapter.programId, programId: firm.deployments.perpAdapter.programId, programDataAddress: firm.deployments.perpAdapter.programDataAddress, codeIdentity: firm.deployments.perpAdapter.codeIdentity },
    spotMarket: { protocolSubjectId: 'orca-market', subjectId: hash(82), manifestHash: hash(102), subjectAddress: whirlpool, programId: spotVenueProgram, programDataAddress: spotVenueData, codeIdentity: spotVenueCode },
    perpMarket: { protocolSubjectId: entry.route.legs[1]!.market.subjectId, subjectId: hash(74), manifestHash: entry.route.legs[1]!.market.manifestHash, subjectAddress: firm.accounts.riseOrderbook.address, programId: firm.deployments.perpVenue.programId, programDataAddress: firm.deployments.perpVenue.programDataAddress, codeIdentity: firm.deployments.perpVenue.codeIdentity },
    spotVenue: { protocolSubjectId: 'orca-venue', subjectId: hash(83), manifestHash: hash(103), subjectAddress: whirlpool, programId: spotVenueProgram, programDataAddress: spotVenueData, codeIdentity: spotVenueCode },
    perpVenue: { protocolSubjectId: entry.route.legs[1]!.venue.subjectId, subjectId: hash(76), manifestHash: entry.route.legs[1]!.venue.manifestHash, subjectAddress: firm.accounts.riseGlobalConfig.address, programId: firm.deployments.perpVenue.programId, programDataAddress: firm.deployments.perpVenue.programDataAddress, codeIdentity: firm.deployments.perpVenue.codeIdentity },
    baseAsset: { protocolSubjectId: baseMint.toBase58(), subjectId: hash(77), manifestHash: entry.order.quantity.asset.assetManifestHash, subjectAddress: baseMint, programId: LEGACY_TOKEN_PROGRAM_ID },
    quoteAsset: { protocolSubjectId: quoteMint.toBase58(), subjectId: hash(78), manifestHash: entry.order.maxSpotQuoteIn!.asset.assetManifestHash, subjectAddress: quoteMint, programId: LEGACY_TOKEN_PROGRAM_ID },
  } as const;
  const resources = Object.fromEntries(Object.entries(resourceInputs).map(([name, resource]) => [name, {
    domain: firm.domain,
    protocolSubjectId: resource.protocolSubjectId,
    subjectId: resource.subjectId,
    manifestVersion: 1,
    manifestHash: resource.manifestHash,
    subjectAddress: resource.subjectAddress,
    programId: resource.programId,
    ...('programDataAddress' in resource ? { programDataAddress: resource.programDataAddress, codeIdentity: resource.codeIdentity } : {}),
    lifecycle: 'EXIT_ONLY' as const,
    currentActiveRecord: namedAddress(`current-${name}`),
  }])) as unknown as Record<PublicCashCarryResourceName, PublicCashCarryResourceEvidence>;

  const accountAddresses = Object.fromEntries(PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES.map((name) => [name, namedAddress(`exit-${name}`).toBase58()])) as Record<PublicCashCarryExitAccountName, string>;
  Object.assign(accountAddresses, {
    trader: trader.toBase58(),
    config: new PublicKey(firm.accounts.config.address).toBase58(),
    solverRegistry: new PublicKey(firm.accounts.solverRegistry.address).toBase58(),
    receipt: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-receipt'), trader.toBuffer(), Buffer.from(exitOrderHash)], coreProgram)[0].toBase58(),
    nonceMarker: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-nonce'), trader.toBuffer(), Buffer.from(bigEndian(8n, 8))], coreProgram)[0].toBase58(),
    openPackage: new PublicKey(firm.accounts.openPackage.address).toBase58(),
    entryReceipt: new PublicKey(firm.accounts.receipt.address).toBase58(),
    executorAuthority: new PublicKey(firm.accounts.executorAuthority.address).toBase58(),
    spotAdapterProgram: spotAdapterProgram.toBase58(),
    spotAdapterProgramData: spotAdapterData.toBase58(),
    perpAdapterProgram: new PublicKey(firm.deployments.perpAdapter.programId).toBase58(),
    perpAdapterProgramData: new PublicKey(firm.deployments.perpAdapter.programDataAddress).toBase58(),
    spotVenueProgram: spotVenueProgram.toBase58(),
    spotVenueProgramData: spotVenueData.toBase58(),
    perpVenueProgram: new PublicKey(firm.deployments.perpVenue.programId).toBase58(),
    perpVenueProgramData: new PublicKey(firm.deployments.perpVenue.programDataAddress).toBase58(),
    traderTokenA: new PublicKey(firm.accounts.traderBase.address).toBase58(),
    traderTokenB: new PublicKey(firm.accounts.traderQuote.address).toBase58(),
    whirlpool: whirlpool.toBase58(),
    whirlpoolOracle: PublicKey.findProgramAddressSync([Buffer.from('oracle'), whirlpool.toBuffer()], spotVenueProgram)[0].toBase58(),
    riseStrategy: new PublicKey(firm.accounts.riseStrategy.address).toBase58(),
    riseLogAuthority: new PublicKey(firm.accounts.riseLogAuthority.address).toBase58(),
    riseGlobalConfig: new PublicKey(firm.accounts.riseGlobalConfig.address).toBase58(),
    riseTraderAccount: new PublicKey(firm.accounts.riseTraderAccount.address).toBase58(),
    risePerpAssetMap: new PublicKey(firm.accounts.risePerpAssetMap.address).toBase58(),
    riseGlobalTraderIndexHeader: new PublicKey(firm.accounts.riseGlobalTraderIndexHeader.address).toBase58(),
    riseActiveTraderBufferHeader: new PublicKey(firm.accounts.riseActiveTraderBufferHeader.address).toBase58(),
    riseOrderbook: new PublicKey(firm.accounts.riseOrderbook.address).toBase58(),
    riseSplineCollection: new PublicKey(firm.accounts.riseSplineCollection.address).toBase58(),
    tokenProgram: LEGACY_TOKEN_PROGRAM_ID.toBase58(),
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
  });
  const resourceAccountNames = {
    spotAdapter: ['spotAdapterIndex', 'spotAdapterRecord', 'adapter'],
    perpAdapter: ['perpAdapterIndex', 'perpAdapterRecord', 'adapter'],
    spotMarket: ['spotMarketIndex', 'spotMarketRecord', 'market'],
    perpMarket: ['perpMarketIndex', 'perpMarketRecord', 'market'],
    spotVenue: ['spotVenueIndex', 'spotVenueRecord', 'venue'],
    perpVenue: ['perpVenueIndex', 'perpVenueRecord', 'venue'],
    baseAsset: ['baseAssetIndex', 'baseAssetRecord', 'asset'],
    quoteAsset: ['quoteAssetIndex', 'quoteAssetRecord', 'asset'],
  } as const;
  for (const [name, [indexName, recordName, kind]] of Object.entries(resourceAccountNames) as [PublicCashCarryResourceName, readonly [PublicCashCarryExitAccountName, PublicCashCarryExitAccountName, string]][]) {
    const resource = resources[name];
    accountAddresses[indexName] = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-index'), Buffer.from(kind), Buffer.from(resource.subjectId),
    ], coreProgram)[0].toBase58();
    accountAddresses[recordName] = PublicKey.findProgramAddressSync([
      Buffer.from('naryx-resource-record'), Buffer.from(kind), Buffer.from(resource.subjectId), Buffer.from(bigEndian(1n, 4)),
    ], coreProgram)[0].toBase58();
  }
  const accounts = Object.fromEntries(PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES.map((name) => [name, {
    address: accountAddresses[name],
    routeBindingId: `exit-${name}`,
  }])) as PublicCashCarryExitBinding['accounts'];
  const dynamic = Array.from({ length: dynamicCount }, (_, index) => ({
    address: namedAddress(`exit-dynamic-${index}`).toBase58(),
    routeBindingId: `exit-dynamic-${index}`,
    isWritable: index % 2 === 0,
  }));
  const programCodes = new Map<PublicCashCarryExitAccountName, Uint8Array>([
    ['spotAdapterProgram', spotAdapterCode],
    ['perpAdapterProgram', firm.deployments.perpAdapter.codeIdentity],
    ['spotVenueProgram', spotVenueCode],
    ['perpVenueProgram', firm.deployments.perpVenue.codeIdentity],
  ]);
  const tokenAuthorities = {
    traderTokenA: trader,
    traderTokenB: trader,
    spotVaultA: whirlpool,
    spotVaultB: whirlpool,
  } as const;
  const resourceOwnerNames = new Set(PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES.filter((name) => name.endsWith('Index') || name.endsWith('Record')));
  const accountBindings = PUBLIC_CASH_CARRY_EXIT_ACCOUNT_NAMES.map((name) => ({
    routeBindingId: accounts[name].routeBindingId,
    accountIdentity: accountAddresses[name],
    ...(programCodes.has(name) ? { codeIdentity: hex(programCodes.get(name)!) } : {}),
    ...(resourceOwnerNames.has(name) ? { ownerIdentity: coreProgram.toBase58() } : {}),
    ...(name in tokenAuthorities ? {
      ownerIdentity: LEGACY_TOKEN_PROGRAM_ID.toBase58(),
      authorityIdentity: tokenAuthorities[name as keyof typeof tokenAuthorities].toBase58(),
    } : {}),
  }));
  accountBindings.push(...dynamic.map((account) => ({ routeBindingId: account.routeBindingId, accountIdentity: account.address })));
  if (mode === 'SOLVER_AUTHORIZED') accountBindings.push({ routeBindingId: 'exit-solver', accountIdentity: solver.toBase58() });

  const baseAsset = entry.order.quantity.asset;
  const quoteAsset = entry.order.maxSpotQuoteIn!.asset;
  const spotAdapter = { adapterId: 'orca', adapterManifestVersion: 1, adapterManifestHash: resources.spotAdapter.manifestHash };
  const perpAdapter = entry.route.legs[1]!.adapter;
  const spotVenue = { subjectId: 'orca-venue', manifestVersion: 1, manifestHash: resources.spotVenue.manifestHash };
  const spotMarket = { subjectId: 'orca-market', manifestVersion: 1, manifestHash: resources.spotMarket.manifestHash };
  const exitAdmission = {
    orderHash: exitOrderHash,
    quoteHash: exitQuoteHash,
    routeHash: exitRouteHash,
    order: {
      environment: firm.environment,
      domain: firm.domain,
      templateId: 'cash-and-carry-v1',
      templateVersion: entry.order.templateVersion,
      packageTemplateManifestHash: entry.order.packageTemplateManifestHash,
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      action: 'EXIT',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      owner: trader.toBase58(),
      expiryUnit: 'SOLANA_SLOT',
      expiryValue: 700n,
      nonce: 8n,
      quantity: { asset: baseAsset, atoms: 10n },
      expectedPrePositionSize: { asset: baseAsset, atoms: -10n },
      minSpotQuoteOut: { asset: quoteAsset, atoms: 50n },
      entryReceiptHash,
    },
    quote: {
      environment: firm.environment,
      domain: firm.domain,
      orderHash: exitOrderHash,
      routeHash: exitRouteHash,
      solverId: solver.toBase58(),
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: solver.toBytes(),
      expectedGrossSpotQuantity: { asset: baseAsset, atoms: 10n },
      expectedSpotNotional: { asset: quoteAsset, atoms: 50n },
      protocolFee: { asset: quoteAsset, atoms: 0n },
      solverFee: { asset: quoteAsset, atoms: 0n },
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: 680n,
    },
    route: {
      environment: firm.environment,
      domain: firm.domain,
      orderHash: exitOrderHash,
      templateId: 'cash-and-carry-v1',
      templateVersion: entry.order.templateVersion,
      packageTemplateManifestHash: entry.order.packageTemplateManifestHash,
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      executionPlanKind: 'SVM_ATOMIC_CPI',
      action: 'EXIT',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      owner: trader.toBase58(),
      solver: solver.toBase58(),
      routeExpiryUnit: 'SOLANA_SLOT',
      routeExpiryValue: 690n,
      serviceCharges: [],
      accountBindings,
      legs: [
        { legRole: 'SPOT', side: 'SELL', reduceOnly: false, quantity: { asset: baseAsset, atoms: 10n }, baseAsset, quoteAsset, adapter: spotAdapter, venue: spotVenue, market: spotMarket, limitPrice: { baseAtoms: 1n, quoteAtoms: 5n } },
        { legRole: 'PERPETUAL', side: 'BUY', reduceOnly: true, quantity: { asset: baseAsset, atoms: 10n }, baseAsset, quoteAsset, adapter: perpAdapter, venue: entry.route.legs[1]!.venue, market: entry.route.legs[1]!.market, limitPrice: { baseAtoms: 1n, quoteAtoms: 8n } },
      ],
      actions: [{ authorityBindingId: accounts.trader.routeBindingId }, { authorityBindingId: accounts.trader.routeBindingId }],
    },
  } as unknown as PackageAdmission;

  const quote = firm.quoteArgs;
  const quoteKeys = [firm.accounts.quoteLock, firm.accounts.seriesIndex, firm.accounts.seriesRecord].map((account) => new PublicKey(account.address));
  const quoteIntentCommitment = domainHash(
    'NARYX/cash-carry-quote-intent/v1',
    domainBytes(firm.domain),
    solver.toBytes(),
    new PublicKey(firm.accounts.quoteLock.address).toBytes(),
    entry.orderHash,
    entry.quoteHash,
    entry.routeHash,
    quote.packageBookCodeIdentity,
    quote.seriesManifestHash,
    quote.executionClassManifestHash,
    bigEndian(quote.expectedReferenceSequence, 8),
    bigEndian(quote.expectedShardSequence, 8),
    Uint8Array.of(quote.slotIndex),
    bigEndian(quote.levelId, 8),
    bigEndian(quote.expectedLevelSequence, 8),
    Uint8Array.of(quote.expectedSide),
    bigEndian(quote.packageSizeUnits, 8),
    bigEndian(quote.expectedPackagePrice, 16),
    bigEndian(quote.expectedMaxFeeAtoms, 8),
    bigEndian(quote.expectedExpirySlot, 8),
    quote.expectedSettlementClassIdentityHash,
    Uint8Array.of(quote.expectedQuoteMode),
    quote.expectedReservationPolicyHash,
    quote.reservationId,
    quote.expectedFillCommitment,
    bigEndian(BigInt(quoteKeys.length), 4),
    ...quoteKeys.map((key) => key.toBytes()),
  );
  const routeNames: readonly FirmCashCarryAccountName[] = [
    'traderBase', 'traderQuote', 'executorBase', 'executorQuote', 'solverQuote', 'reservationClass',
    'reservationCapacity', 'reservation', 'livePair', 'reservationVault', 'quoteLock', 'seriesIndex',
    'seriesRecord', 'riseStrategy', 'riseLogAuthority', 'riseGlobalConfig', 'riseTraderAccount',
    'risePerpAssetMap', 'riseGlobalTraderIndexHeader', 'riseActiveTraderBufferHeader', 'riseOrderbook', 'riseSplineCollection',
  ];
  const routeKeys = [...routeNames.map((name) => new PublicKey(firm.accounts[name].address)), ...firm.riseDynamicAccounts.map((account) => new PublicKey(account.address))];
  const entryRouteAccountsCommitment = domainHash(
    'NARYX/cash-carry-route-accounts/v1', bigEndian(BigInt(routeKeys.length), 4), ...routeKeys.map((key) => key.toBytes()),
  );
  const packageKeys = [firm.accounts.traderBase, firm.accounts.traderQuote, firm.accounts.riseStrategy].map((account) => new PublicKey(account.address));
  const packageAccountsCommitment = domainHash(
    'NARYX/cash-carry-package-accounts/v1', bigEndian(3n, 4), ...packageKeys.map((key) => key.toBytes()),
  );
  const orderedResources: readonly PublicCashCarryResourceName[] = ['spotAdapter', 'perpAdapter', 'spotMarket', 'perpMarket', 'spotVenue', 'perpVenue', 'baseAsset', 'quoteAsset'];
  const manifestBytes = (resource: PublicCashCarryResourceEvidence) => Buffer.concat([
    Buffer.from(resource.subjectId), Buffer.from(bigEndian(BigInt(resource.manifestVersion), 4)), Buffer.from(resource.manifestHash),
  ]);
  const commonCommitmentParts = [
    protocolIdBytes('cash-and-carry-v1'),
    bigEndian(BigInt(entry.order.templateVersion), 4),
    entry.order.packageTemplateManifestHash,
    Uint8Array.of(1),
    bigEndian(1n, 4),
    settlementManifestHash,
    Uint8Array.of(quoteAsset.decimals),
  ];
  const resourceAdmissionCommitment = domainHash(
    'NARYX/cash-carry-resources/v1',
    domainBytes(firm.domain),
    ...orderedResources.map((name) => manifestBytes(resources[name])),
    ...commonCommitmentParts,
    ...orderedResources.map((name) => new PublicKey(accounts[`${name}Record` as PublicCashCarryExitAccountName].address).toBytes()),
  );
  const economicNames: readonly PublicCashCarryResourceName[] = ['perpAdapter', 'perpMarket', 'perpVenue', 'baseAsset', 'quoteAsset'];
  const economicPackageCommitment = domainHash(
    'NARYX/cash-carry-economic-package/v1',
    domainBytes(firm.domain),
    ...economicNames.map((name) => manifestBytes(resources[name])),
    ...commonCommitmentParts,
    ...economicNames.map((name) => new PublicKey(accounts[`${name}Record` as PublicCashCarryExitAccountName].address).toBytes()),
  );
  const domainIdentity = domainHash('CON/v1/domain-ref-identity', domainBytes(firm.domain));
  const seriesIdentity = domainHash(
    'CON/v1/cash-carry-series-identity', domainIdentity, firm.series.seriesManifestHash, firm.series.executionClassManifestHash,
  );
  const seriesBindingHash = domainHash(
    'CON/v1/cash-carry-series-binding',
    bigEndian(1n, 4),
    bigEndian(1n, 4),
    domainIdentity,
    firm.series.seriesManifestHash,
    firm.series.executionClassManifestHash,
    domainHash('CON/v1/protocol-id-identity', protocolIdBytes('cash-and-carry-v1')),
    bigEndian(BigInt(entry.order.templateVersion), 4),
    entry.order.packageTemplateManifestHash,
    firm.series.settlementClassIdentityHash,
    manifestBytes(resources.baseAsset),
    manifestBytes(resources.quoteAsset),
    domainHash('CON/v1/protocol-id-identity', protocolIdBytes('annualized-net-yield-v1')),
    Uint8Array.of(1),
    bigEndian(firm.series.spotBaseAtomsPerPackageUnit, 16),
    bigEndian(firm.series.perpQuantityAtomsPerPackageUnit, 16),
  );
  const publicExit = {
    admission: exitAdmission,
    activeDomain: { ...firm.domain, domainManifestVersion: 2, domainManifestHash: hash(98) } as DomainRef,
    deployments: {
      core: firm.deployments.core,
      spotAdapter: { programId: spotAdapterProgram, programDataAddress: spotAdapterData, codeIdentity: spotAdapterCode },
      perpAdapter: firm.deployments.perpAdapter,
      spotVenue: { programId: spotVenueProgram, programDataAddress: spotVenueData, codeIdentity: spotVenueCode },
      perpVenue: firm.deployments.perpVenue,
    },
    accounts,
    riseDynamicAccounts: dynamic,
    resources: {
      ...resources,
      quoteDecimals: quoteAsset.decimals,
      spotBaseLotAtoms: 1n,
      perpBaseLotAtoms: 1n,
      perpQuoteTickAtomsPerBaseLot: 1n,
      settlementVersion: 1 as const,
      settlementManifestHash,
    },
    tokenAccounts: {
      traderTokenA: { mint: baseMint, authority: trader, amountAtoms: 10n },
      traderTokenB: { mint: quoteMint, authority: trader, amountAtoms: 0n },
      spotVaultA: { mint: baseMint, authority: whirlpool, amountAtoms: 1_000n },
      spotVaultB: { mint: quoteMint, authority: whirlpool, amountAtoms: 1_000n },
    },
    historicalSeries: {
      identityKey: seriesIdentity,
      bindingVersion: 1,
      bindingHash: seriesBindingHash,
      seriesManifestHash: firm.series.seriesManifestHash,
      executionClassManifestHash: firm.series.executionClassManifestHash,
      index: firm.accounts.seriesIndex.address,
      record: firm.accounts.seriesRecord.address,
    },
    openPackage: {
      version: 2 as const,
      address: firm.accounts.openPackage.address,
      domain: firm.domain,
      trader,
      entryReceipt: firm.accounts.receipt.address,
      entryRouteHash: entry.routeHash,
      quoteIntentCommitment,
      packageFillCommitment: firm.quoteArgs.expectedFillCommitment,
      entryResourceAdmissionCommitment: firm.resourceAdmissionCommitment,
      entryRouteAccountsCommitment,
      economicPackageCommitment,
      packageAccountsCommitment,
      spotQuantityAtoms: firm.executionArgs.spotQuantityAtoms,
      perpQuantityAtoms: firm.executionArgs.perpQuantityAtoms,
      entryPackageNonce: firm.executionArgs.nonce,
    },
    entryReceipt: {
      address: firm.accounts.receipt.address,
      ownerProgram: coreProgram,
      receiptHash: entryReceiptHash,
      domain: firm.domain,
      orderHash: entry.orderHash,
      quoteHash: entry.quoteHash,
      routeHash: entry.routeHash,
      trader,
      solver,
      nonce: firm.executionArgs.nonce,
      action: 'ENTRY' as const,
      recovery: false as const,
      quoteIntentCommitment,
      packageFillCommitment: firm.quoteArgs.expectedFillCommitment,
      resourceAdmissionCommitment: firm.resourceAdmissionCommitment,
      routeAccountsCommitment: entryRouteAccountsCommitment,
      spotQuantityAtoms: firm.executionArgs.spotQuantityAtoms,
      perpQuantityAtoms: firm.executionArgs.perpQuantityAtoms,
    },
    executionArgs: {
      spotQuantityAtoms: 10n,
      perpQuantityAtoms: 10n,
      spotLimitQuoteAtomsPerBaseLot: 5n,
      perpLimitQuoteAtomsPerBaseLot: 8n,
      packageNotionalAtoms: 50n,
      spotSqrtPriceLimit: 1n,
      minimumRiseCollateralQuoteLots: 1n,
      clientOrderId: 10n,
      expirySlot: 680n,
      nonce: 8n,
    },
    postconditions: {
      expectedSpotBaseDebitAtoms: 10n,
      minimumSpotQuoteOutAtoms: 50n,
      expectedPreRiseBaseLots: -10n,
      expectedPostRiseBaseLots: 0n as const,
      minimumPostRiseCollateralQuoteLots: 1n,
    },
    authorization: mode === 'SOLVER_AUTHORIZED'
      ? { mode, activeSolver: solver, solverRouteBindingId: 'exit-solver', solverSignature: new Uint8Array(64).fill(100) }
      : { mode, recoveryAuthority: trader, recoveryAuthorityRouteBindingId: accounts.trader.routeBindingId, acknowledgedOpenPackage: firm.accounts.openPackage.address },
    resourceAdmissionCommitment,
    computeUnitLimit: 1_000_000,
    currentSlot: 200n,
    traderRouteBindingId: accounts.trader.routeBindingId,
  } as const satisfies PublicCashCarryExitBinding;
  (firm as { publicExit: PublicCashCarryExitBinding }).publicExit = publicExit;
  return publicExit;
}

function useDevnet(value: ReturnType<typeof fixture>): void {
  (value.binding as { environment: 'devnet' }).environment = 'devnet';
  for (const item of [value.admission.order, value.admission.quote, value.admission.route]) {
    (item as { environment: 'devnet' }).environment = 'devnet';
  }
}

class MaterializerRpc implements SolanaReadOnlyRpc {
  readonly rpcUrl = 'https://trusted.invalid';
  readonly calls: string[] = [];
  readonly #genesisHash: string;
  readonly #table: AddressLookupTableAccount | null;

  constructor(genesisHash: string, table: AddressLookupTableAccount | null) {
    this.#genesisHash = genesisHash;
    this.#table = table;
  }

  async getGenesisHash(): Promise<string> {
    this.calls.push('genesis');
    return this.#genesisHash;
  }

  async getLatestBlockhash() {
    this.calls.push('blockhash');
    return { contextSlot: 500, blockhash: namedAddress('materializer-blockhash').toBase58(), lastValidBlockHeight: 650 };
  }

  async getLookupTable(address: PublicKey, minContextSlot: number): Promise<SolanaLookupTableSnapshot | null> {
    this.calls.push(`lookup:${minContextSlot}`);
    if (this.#table === null || !this.#table.key.equals(address)) return null;
    return {
      contextSlot: 500,
      owner: AddressLookupTableProgram.programId,
      executable: false,
      account: this.#table,
    };
  }
}

function materializerHarness(value: ReturnType<typeof fixture>, genesisHash = SOLANA_DEVNET_GENESIS_HASH, includeLookup = true) {
  const lookupAddresses = [...new Map([
    ...value.admission.route.accountBindings,
    ...(value.binding.publicExit?.admission.route.accountBindings ?? []),
  ].map((binding) => [binding.accountIdentity, new PublicKey(binding.accountIdentity)])).values()];
  const table = includeLookup
    ? new AddressLookupTableAccount({
        key: namedAddress('materializer-lookup-table'),
        state: {
          deactivationSlot: (1n << 64n) - 1n,
          lastExtendedSlot: 400,
          lastExtendedSlotStartIndex: 0,
          addresses: lookupAddresses,
        },
      })
    : null;
  const rpc = new MaterializerRpc(genesisHash, table);
  const materializer = new SolanaUnsignedTransactionMaterializer(rpc, {
    environment: 'devnet',
    domain: value.binding.domain,
    rpcUrl: rpc.rpcUrl,
    expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
    lookupTables: table === null ? [] : [{ address: table.key, expectedAddresses: lookupAddresses }],
  });
  return { materializer, rpc };
}

test('compiles separate solver lock and atomic trader firm entry from the generated IDL', () => {
  const { admission, binding } = fixture();
  const result = compileFirmCashCarryPlan(admission, binding);
  assert.equal(result.kind, 'MULTI_TRANSACTION_FIRM_CASH_CARRY_PLAN');
  assert.equal(result.atomicity, 'ONLY_TRADER_ENTRY_TRANSACTION_IS_ATOMIC');
  assert.equal(result.solverLock.authorityRole, 'SOLVER');
  assert.equal(result.solverLock.instructions.length, 1);
  assert.equal(result.traderEntry.authorityRole, 'TRADER');
  assert.equal(result.traderEntry.instructions.length, 3);
  assert(result.solverLock.instructions.every((instruction) => instruction instanceof TransactionInstruction));
  assert(result.traderEntry.instructions.every((instruction) => instruction instanceof TransactionInstruction));
  assert(result.traderEntry.instructions[0]!.programId.equals(ComputeBudgetProgram.programId));
  assert(result.traderEntry.instructions[1]!.programId.equals(Ed25519Program.programId));
  assert.deepEqual(Array.from(result.traderEntry.instructions[1]!.data.subarray(112)), Array.from(result.executionDigest));
  assert.deepEqual(result.publicExit, { status: 'EVIDENCE_REQUIRED', code: 'PUBLIC_EXIT_BINDING_REQUIRED' });
  assert.deepEqual(result.solverLock.messageSize, { status: 'UNPROVEN', reason: 'RECENT_BLOCKHASH_AND_ALT_CONTENTS_REQUIRED' });

  const coder = new BorshCoder(coreIdl);
  const decoded = coder.instruction.decode(result.traderEntry.instructions[2]!.data);
  assert.equal(decoded?.name, 'execute_firm_cash_and_carry');
  assert.deepEqual((decoded?.data as { args: { action: object } }).args.action, { Entry: {} });
  const expectedData = coder.instruction.encode('execute_firm_cash_and_carry', {
    order_hash: Array.from(admission.orderHash),
    quote_hash: Array.from(admission.quoteHash),
    route_hash: Array.from(admission.routeHash),
    args: {
      action: { Entry: {} },
      recovery: false,
      spot_quantity_atoms: new BN('10'),
      perp_quantity_atoms: new BN('10'),
      spot_limit_quote_atoms_per_base_lot: new BN('10'),
      perp_limit_quote_atoms_per_base_lot: new BN('8'),
      package_notional_atoms: new BN('80'),
      spot_sqrt_price_limit: new BN('1'),
      minimum_rise_collateral_quote_lots: new BN('1'),
      client_order_id: new BN('6'),
      expiry_slot: new BN('480'),
      nonce: new BN('7'),
    },
    quote_args: quoteArgsForCoder(binding),
    firm_quote_atoms: new BN('50'),
  });
  assert.deepEqual(result.traderEntry.instructions[2]!.data, expectedData);
});

test('rejects wrong domain, commitments, authority roles, token program, and IDL account shape', () => {
  for (const [name, mutate, pattern] of [
    ['domain', (value: ReturnType<typeof fixture>) => { (value.binding as { domain: DomainRef }).domain = { ...value.binding.domain, domainManifestHash: hash(99) } as DomainRef; }, /order domain mismatch/],
    ['commitment', (value: ReturnType<typeof fixture>) => { value.binding.expectedCoreIdlHash[0] = value.binding.expectedCoreIdlHash[0]! ^ 1; }, /core IDL content hash mismatch/],
    ['role', (value: ReturnType<typeof fixture>) => { (value.binding as { traderRouteBindingId: string }).traderRouteBindingId = value.binding.solverRouteBindingId; }, /trader authority binding mismatch/],
    ['token program', (value: ReturnType<typeof fixture>) => {
      const wrong = address(250).toBase58();
      (value.binding.accounts as Record<string, { address: string }>).tokenProgram!.address = wrong;
      const routeBinding = value.admission.route.accountBindings.find((item) => item.routeBindingId === value.binding.accounts.tokenProgram.routeBindingId)!;
      (routeBinding as { accountIdentity: string }).accountIdentity = wrong;
    }, /legacy SPL Token program mismatch/],
    ['compute cap', (value: ReturnType<typeof fixture>) => { (value.binding as { computeUnitLimit: number }).computeUnitLimit = 1_400_000; }, /compute unit limit exceeds the firm route cap/],
    ['IDL shape', (value: ReturnType<typeof fixture>) => {
      const cloned = JSON.parse(JSON.stringify(value.binding.coreIdl)) as Idl;
      const instruction = cloned.instructions.find((item) => item.name === 'execute_firm_cash_and_carry')!;
      (instruction.accounts[0] as { signer?: boolean }).signer = false;
      (value.binding as { coreIdl: Idl; expectedCoreIdlHash: Uint8Array }).coreIdl = cloned;
      (value.binding as { coreIdl: Idl; expectedCoreIdlHash: Uint8Array }).expectedCoreIdlHash = solanaIdlContentHash(cloned);
    }, /IDL signer trader mismatch/],
  ] as const) {
    const value = fixture();
    mutate(value);
    assert.throws(() => compileFirmCashCarryPlan(value.admission, value.binding), pattern, name);
  }
});

test('rejects replayed reservation and mismatched quote lock evidence', () => {
  const replayed = fixture();
  (replayed.binding.reservation as { state: string }).state = 'CONSUMED';
  assert.throws(() => compileFirmCashCarryPlan(replayed.admission, replayed.binding), /reservation must be funded, finalized, and live/);

  const mismatched = fixture();
  (mismatched.binding.quoteLock as { orderHash: Uint8Array }).orderHash = hash(99);
  assert.throws(() => compileFirmCashCarryPlan(mismatched.admission, mismatched.binding), /quote lock order commitment mismatch/);
});

test('rejects six dynamic Rise accounts', () => {
  const { admission, binding } = fixture(6);
  assert.throws(() => compileFirmCashCarryPlan(admission, binding), /at most five Rise dynamic accounts/);
});

test('accepts the exact 64 resolved-address boundary', () => {
  const { admission, binding } = fixture(5);
  const result = compileFirmCashCarryPlan(admission, binding);
  assert.equal(result.traderEntry.resolvedAddressCount, 64);
});

test('encodes solver-authorized and trader-recovery public exits with distinct authorization', () => {
  const normal = fixture();
  attachPublicExit(normal, 'SOLVER_AUTHORIZED');
  const normalPlan = compileFirmCashCarryPlan(normal.admission, normal.binding).publicExit;
  assert.equal(normalPlan.status, 'SUPPORTED');
  if (normalPlan.status === 'SUPPORTED') {
    assert.equal(normalPlan.authorization.mode, 'SOLVER_AUTHORIZED');
    assert.equal(normalPlan.instructions.length, 3);
    assert(normalPlan.instructions[1]!.programId.equals(Ed25519Program.programId));
    assert.deepEqual(Array.from(normalPlan.instructions[1]!.data.subarray(112)), Array.from(normalPlan.executionDigest));
    const decoded = new BorshCoder(coreIdl).instruction.decode(normalPlan.instructions[2]!.data);
    assert.equal(decoded?.name, 'execute_cash_and_carry');
    const args = (decoded?.data as { args: { action: object; recovery: boolean; spot_quantity_atoms: InstanceType<typeof BN>; nonce: InstanceType<typeof BN> } }).args;
    assert.deepEqual(args.action, { Exit: {} });
    assert.equal(args.recovery, false);
    assert.equal(args.spot_quantity_atoms.toString(), '10');
    assert.equal(args.nonce.toString(), '8');
  }

  const recovery = fixture();
  attachPublicExit(recovery, 'TRADER_RECOVERY');
  const recoveryPlan = compileFirmCashCarryPlan(recovery.admission, recovery.binding).publicExit;
  assert.equal(recoveryPlan.status, 'SUPPORTED');
  if (recoveryPlan.status === 'SUPPORTED') {
    assert.equal(recoveryPlan.authorization.mode, 'TRADER_RECOVERY');
    assert.equal(recoveryPlan.instructions.length, 2);
    assert(recoveryPlan.instructions.every((instruction) => !instruction.programId.equals(Ed25519Program.programId)));
    const decoded = new BorshCoder(coreIdl).instruction.decode(recoveryPlan.instructions[1]!.data);
    assert.equal((decoded?.data as { args: { recovery: boolean } }).args.recovery, true);
  }
});

test('proves the 64-address public-exit boundary and full unsigned envelope', () => {
  const value = fixture();
  const exit = attachPublicExit(value, 'SOLVER_AUTHORIZED', 8);
  const lookupTable = new AddressLookupTableAccount({
    key: namedAddress('exit-lookup-table'),
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: exit.admission.route.accountBindings.map((account) => new PublicKey(account.accountIdentity)),
    },
  });
  (exit as { messageContext: PublicCashCarryExitBinding['messageContext'] }).messageContext = {
    recentBlockhash: namedAddress('exit-blockhash').toBase58(),
    addressLookupTables: [lookupTable],
  };
  const plan = compileFirmCashCarryPlan(value.admission, value.binding).publicExit;
  assert.equal(plan.status, 'SUPPORTED');
  if (plan.status === 'SUPPORTED') {
    assert.equal(plan.resolvedAddressCount, 64);
    assert.equal(plan.messageSize.status, 'PROVEN');
    if (plan.messageSize.status === 'PROVEN') {
      assert.deepEqual([plan.messageSize.serializedMessageBytes, plan.messageSize.serializedTransactionBytes], [684, 749]);
      assert.equal(plan.messageSize.fitsPacketDataLimit, plan.messageSize.serializedTransactionBytes <= PACKET_DATA_SIZE);
    }
  }

  const over = fixture();
  attachPublicExit(over, 'SOLVER_AUTHORIZED', 9);
  assert.throws(() => compileFirmCashCarryPlan(over.admission, over.binding), /public exit exceeds 64 resolved addresses/);
});

test('rejects a public exit whose open package points at another entry receipt', () => {
  const value = fixture();
  const exit = attachPublicExit(value, 'SOLVER_AUTHORIZED');
  (exit.openPackage as { entryReceipt: PublicKey }).entryReceipt = namedAddress('wrong-entry-receipt');
  assert.throws(() => compileFirmCashCarryPlan(value.admission, value.binding), /open package entry receipt mismatch/);
});

test('proves the full unsigned v0 transaction envelope size with concrete message context', () => {
  const { admission, binding } = fixture(5);
  const lookupTable = new AddressLookupTableAccount({
    key: address(250),
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: admission.route.accountBindings.map((account) => new PublicKey(account.accountIdentity)),
    },
  });
  (binding as { messageContext: FirmCashCarryBinding['messageContext'] }).messageContext = {
    recentBlockhash: address(251).toBase58(),
    addressLookupTables: [lookupTable],
  };
  const evidence = compileFirmCashCarryPlan(admission, binding).traderEntry.messageSize;
  assert.equal(evidence.status, 'PROVEN');
  if (evidence.status === 'PROVEN') {
    assert.deepEqual(
      [evidence.serializedTransactionBytes - evidence.serializedMessageBytes, evidence.fitsPacketDataLimit],
      [65, evidence.serializedTransactionBytes <= PACKET_DATA_SIZE],
    );
  }
});

test('has no signing, RPC, simulation, or network behavior', () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error('network access is forbidden');
  }) as typeof fetch;
  try {
    const { admission, binding } = fixture();
    const result = compileFirmCashCarryPlan(admission, binding);
    assert.equal(networkCalls, 0);
    assert.equal('signatures' in result.solverLock, false);
    assert.equal('signatures' in result.traderEntry, false);
    assert.equal('connection' in result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('materializes a Devnet trader entry with exact ALT and unsigned v0 evidence', async () => {
  const value = fixture();
  useDevnet(value);
  const { materializer, rpc } = materializerHarness(value);
  const result = await materializer.materialize({
    planKind: 'TRADER_ENTRY',
    admission: value.admission,
    binding: value.binding,
  });

  const transaction = VersionedTransaction.deserialize(result.transactionBytes);
  assert.equal(result.planKind, 'TRADER_ENTRY');
  assert.equal(transaction.version, 0);
  assert.equal(result.genesisHash, SOLANA_DEVNET_GENESIS_HASH);
  assert.equal(result.recentBlockhash, namedAddress('materializer-blockhash').toBase58());
  assert.equal(result.lastValidBlockHeight, 650);
  assert.deepEqual(result.requiredSignerPubkeys, [value.binding.accounts.trader.address]);
  assert(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert.equal(result.transactionBase64, Buffer.from(result.transactionBytes).toString('base64'));
  assert.equal(result.messageBase64, Buffer.from(result.messageBytes).toString('base64'));
  assert(result.evidence.serializedTransactionBytes <= PACKET_DATA_SIZE);
  assert(result.evidence.resolvedAddressCount <= 64);
  assert.equal(result.evidence.computeUnitLimit, value.binding.computeUnitLimit);
  assert.equal(result.lookupTables.length, 1);
  assert.equal(result.lookupTables[0]!.contentCommitment.length, 32);
  assert.equal(result.requestCommitment.length, 32);
  assert.deepEqual(rpc.calls, ['genesis', 'blockhash', 'lookup:500']);
});

test('materializes a Devnet trader-recovery exit without a solver signer', async () => {
  const value = fixture();
  useDevnet(value);
  attachPublicExit(value, 'TRADER_RECOVERY');
  const { materializer } = materializerHarness(value);
  const result = await materializer.materialize({
    planKind: 'TRADER_RECOVERY_EXIT',
    admission: value.admission,
    binding: value.binding,
  });

  const transaction = VersionedTransaction.deserialize(result.transactionBytes);
  assert.equal(result.planKind, 'TRADER_RECOVERY_EXIT');
  assert.deepEqual(result.requiredSignerPubkeys, [value.binding.accounts.trader.address]);
  assert.equal(transaction.message.compiledInstructions.length, 2);
  assert(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert(result.evidence.serializedTransactionBytes <= PACKET_DATA_SIZE);
  assert.equal(result.evidence.computeUnitLimit, value.binding.publicExit!.computeUnitLimit);
});

test('rejects wrong genesis and an uncompressed oversized entry before materialization', async () => {
  const wrongGenesis = fixture();
  useDevnet(wrongGenesis);
  const wrongHarness = materializerHarness(wrongGenesis, SOLANA_MAINNET_BETA_GENESIS_HASH);
  await assert.rejects(
    wrongHarness.materializer.materialize({
      planKind: 'TRADER_ENTRY',
      admission: wrongGenesis.admission,
      binding: wrongGenesis.binding,
    }),
    /mainnet-beta genesis is prohibited/,
  );
  assert.deepEqual(wrongHarness.rpc.calls, ['genesis']);

  const oversized = fixture(5);
  useDevnet(oversized);
  const oversizedHarness = materializerHarness(oversized, SOLANA_DEVNET_GENESIS_HASH, false);
  await assert.rejects(
    oversizedHarness.materializer.materialize({
      planKind: 'TRADER_ENTRY',
      admission: oversized.admission,
      binding: oversized.binding,
    }),
    /1232-byte wire limit|encoding overruns Uint8Array/,
  );
});

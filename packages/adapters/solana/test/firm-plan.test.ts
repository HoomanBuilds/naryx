import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Ed25519Program,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import type { DomainRef, PackageAdmission } from '@naryx/protocol-types';
import {
  compileFirmCashCarryPlan,
  FIRM_CASH_CARRY_ACCOUNT_NAMES,
  solanaIdlContentHash,
  type FirmCashCarryAccountName,
  type FirmCashCarryBinding,
} from '../src/index.js';

const { BN, BorshCoder } = anchor;
const coreIdl = JSON.parse(readFileSync(new URL('../../../../../deployments/solana/program/idl/naryx_core.json', import.meta.url), 'utf8')) as Idl;
const LEGACY_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const address = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

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
  const executorAuthority = address(209);
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
  Object.assign(accountAddresses, {
    trader: trader.toBase58(),
    solver: solver.toBase58(),
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
  assert.equal(result.publicExit.code, 'PUBLISHED_PUBLIC_EXIT_IDL_AND_BINDINGS_REQUIRED');
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

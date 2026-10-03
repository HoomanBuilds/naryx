import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  canonicalBytes,
  compareBytes,
  domainRefFromManifest,
  encodeAssetRef,
  feePolicyManifestHash,
  fromProtocolJson,
  packageOrderHash,
  packageTemplateManifestHash,
  packageTemplateRegistryRecordHash,
  payloadTemplateHash,
  toHex,
  validatePackageAdmission,
  versionedManifestRef,
  type AssetRef,
  type DomainManifestInput,
  type DomainRegistryRecordInput,
  type FeeCap,
  type FeePolicyManifestInput,
  type PackageOrder,
  type PackageOrderInput,
  type PackageTemplateManifestInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  SqliteSolanaDevnetFirmQuoteJournal,
  createSolanaDevnetFirmQuotePort,
  deriveSolanaDevnetFirmAccounts,
  firmRouteBindingId,
  priceSolanaDevnetEntry,
  priceSolanaDevnetExit,
} from '../src/solana-devnet-firm-quote.js';
import {
  SOLANA_DEVNET_RESOURCE_NAMES,
  loadSolanaDevnetSolverKey,
  type SolanaDevnetSharedManifest,
  type SolanaDevnetSolverConfig,
} from '../src/solana-devnet-solver-config.js';
import {
  BorshWriter,
  PYTH_RECEIVER_PROGRAM_ID,
  QUOTE_SIDE_ASK,
  QUOTE_SIDE_BID,
  SOLANA_DEVNET_SOL_USD_FEED_ID_HEX,
  SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT,
  accountDiscriminator,
  type TestPerpMarketState,
} from '../src/solana-devnet-wire.js';

const SLOT = 10_000n;
const BLOCK_TIME = 1_700_000_000n;
const QUANTITY = 2_000_000_000n;
const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const key = () => Keypair.generate().publicKey;
const u16 = (value: number) => Buffer.from(Uint16Array.of(value).buffer);

const template = JSON.parse(readFileSync(new URL('../../../../deployments/solana/devnet/release.template.json', import.meta.url), 'utf8'));

/** Fills the release template's directives with test values, failing on any it does not know. */
function fromTemplate(node: unknown, defs: Readonly<Record<string, unknown>>, operator: Readonly<Record<string, unknown>> = {}, name = ''): unknown {
  if (Array.isArray(node)) return node.map((entry) => fromTemplate(entry, defs, operator, name));
  if (node === null || typeof node !== 'object') return node;
  const record = node as Record<string, unknown>;
  if ('$def' in record) {
    assert.ok(String(record.$def) in defs, `test has no value for $def ${String(record.$def)}`);
    return defs[String(record.$def)];
  }
  if ('$bigint' in record) {
    assert.ok(name in operator, `test has no operator value for ${name}`);
    return operator[name];
  }
  assert.ok(!Object.keys(record).some((entry) => entry.startsWith('$')), `unexpected directive at ${name}`);
  return Object.fromEntries(Object.entries(record).map(([entry, value]) => [entry, fromTemplate(value, defs, operator, entry)]));
}

const assetKey = (asset: AssetRef) => canonicalBytes((writer) => encodeAssetRef(writer, asset));

const programs = Object.fromEntries(['core', 'package_book', 'perp_adapter', 'perp_venue', 'reservation'].map((name) => [name, {
  name, programId: key().toBase58(), programDataAddress: key().toBase58(), programDataHeaderIdentity: bytes(name.length),
}])) as Record<string, { name: string; programId: string; programDataAddress: string; programDataHeaderIdentity: Uint8Array }>;
const programId = (name: string) => new PublicKey(programs[name]!.programId);
const pda = (program: string, ...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), programId(program))[0];

const domainManifest: DomainManifestInput = {
  manifestVersion: 1, environment: 'devnet', domainId: 'svm:devnet', runtimeClassId: 'svm', runtimeClassVersion: 1,
  chainNamespace: 'solana', chainReference: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  executionVerifierId: programs.core!.programId, executionVerifierCodeHash: bytes(1), clockModelId: 'solana-slot',
  finalityPolicyHash: bytes(2), addressCodecId: 'solana-base58-pubkey', supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
};
const domain = domainRefFromManifest(domainManifest);
const baseMint = key();
const quoteMint = key();
const base = assetRef(baseMint.toBase58(), bytes(3), 9);
const quote = assetRef(quoteMint.toBase58(), bytes(4), 6);
const spotAdapter = adapterRef({ adapterId: 'solana-firm-inventory-v1', adapterManifestVersion: 1, adapterManifestHash: bytes(5) });
const perpAdapter = adapterRef({ adapterId: 'solana-test-perp-v1', adapterManifestVersion: 1, adapterManifestHash: bytes(6) });
const spotVenue = versionedManifestRef('firm-inventory', 1, bytes(7));
const perpVenue = versionedManifestRef('test-perp', 1, bytes(8));
const spotMarket = versionedManifestRef('sol-usdc-firm', 1, bytes(9));
const perpMarket = versionedManifestRef('sol-usdc-test-perp', 1, bytes(10));
const templateManifest: PackageTemplateManifestInput = {
  manifestVersion: 1, environment: 'devnet', templateId: 'cash-and-carry-v1', templateVersion: 1, supportedDomains: [domain],
  orderSchemaHash: bytes(11), quoteSchemaHash: bytes(12), routeSchemaHash: bytes(13), receiptSchemaHash: bytes(14),
  entryCompilerVersion: 1, exitCompilerVersion: 1, legCount: 2, legTypes: ['spot-purchase', 'perp-sale'],
  supportedDirections: ['LONG_SPOT_SHORT_PERP'], supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  allowedSpotAdapterIds: [spotAdapter.adapterId], allowedPerpAdapterIds: [perpAdapter.adapterId], riskPolicyHash: bytes(15),
};
const templateHash = packageTemplateManifestHash(templateManifest);
const activation = { activationUnit: 'SOLANA_SLOT' as const, activationValue: 900n, governanceReference: 'devnet-review' };
const templateRegistryRecord = {
  recordVersion: 1, environment: 'devnet', domain, templateId: 'cash-and-carry-v1', templateVersion: 1,
  packageTemplateManifestHash: templateHash, registryState: 'ACTIVE' as const, ...activation,
};
const record = (recordKind: DomainRegistryRecordInput['recordKind'], subjectId: string, subjectManifestVersion: number, subjectManifestHash: Uint8Array): DomainRegistryRecordInput => ({
  recordVersion: 1, environment: 'devnet', domain, recordKind, subjectId, subjectManifestVersion, subjectManifestHash,
  registryState: 'ACTIVE', riskLimits: [],
  allowedTemplates: [{ templateId: 'cash-and-carry-v1', templateVersion: 1, packageTemplateManifestHash: templateHash }],
  allowedSettlementClasses: ['ATOMIC_POSTCONDITION'], ...activation,
});
const activeRegistryRecords = [
  record('ASSET', base.assetId, 1, base.assetManifestHash),
  record('ASSET', quote.assetId, 1, quote.assetManifestHash),
  record('ADAPTER', spotAdapter.adapterId, 1, spotAdapter.adapterManifestHash),
  record('ADAPTER', perpAdapter.adapterId, 1, perpAdapter.adapterManifestHash),
  ...[spotVenue, perpVenue].map((venue) => record('VENUE', venue.subjectId, venue.manifestVersion, venue.manifestHash)),
  ...[spotMarket, perpMarket].map((market) => record('MARKET', market.subjectId, market.manifestVersion, market.manifestHash)),
];

const manifest: SolanaDevnetSharedManifest = {
  domain,
  programs: Object.values(programs) as never,
  coreIdl: {} as never,
  expectedCoreIdlHash: bytes(16),
  perpVenueKind: 'NARYX_TEST_PERP',
  testPerp: { market: key().toBase58(), oracle: SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT, feedIdHex: SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, strategyIdHex: '17'.repeat(32) },
};
const market: TestPerpMarketState = {
  oracle: SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT, feedIdHex: SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, collateralMint: quoteMint.toBase58(),
  collateralVault: key().toBase58(), feeVault: key().toBase58(), insuranceVault: key().toBase58(), collateralDecimals: 6, baseDecimals: 9,
  maxPriceAgeSeconds: 60, maxConfidenceBps: 50, takerFeeBps: 5, halfSpreadBps: 2, impactBpsPerUnit: 1, maxSlippageBps: 100,
  initialMarginBps: 1_000, impactUnitLots: 10_000n, baseLotAtoms: 1_000_000n, quoteTickAtomsPerBaseLot: 1n, maxPositionLots: 1_000_000n, pauseOpens: false,
};
// 150 USD per SOL with exponent -8: 150_000 quote atoms per 0.001 SOL lot.
const ORACLE_PRICE_PER_LOT = 150_000n;
const solver = Keypair.generate();
const reservationPolicyHash = bytes(18);
const settlementClassIdentityHash = bytes(19);
const accounts = {
  config: pda('core', Buffer.from('naryx-protocol-config')).toBase58(),
  solverRegistry: pda('core', Buffer.from('conformance-solver')).toBase58(),
  reservationClass: key().toBase58(), seriesIndex: key().toBase58(), seriesRecord: key().toBase58(),
  packageBookClass: key().toBase58(), packageBookShard: key().toBase58(), packageBookLevelPage: key().toBase58(),
  indexes: Object.fromEntries(SOLANA_DEVNET_RESOURCE_NAMES.map((name) => [name, key().toBase58()])),
  records: Object.fromEntries(SOLANA_DEVNET_RESOURCE_NAMES.map((name) => [name, key().toBase58()])),
} as SolanaDevnetSolverConfig['accounts'];
const resources = Object.fromEntries(SOLANA_DEVNET_RESOURCE_NAMES.map((name) => [name, {
  manifestHash: bytes(20), subjectAddress: name === 'baseAsset' ? baseMint.toBase58() : name === 'quoteAsset' ? quoteMint.toBase58() : key().toBase58(),
  programId: key().toBase58(),
}])) as SolanaDevnetSolverConfig['resources'];

/** The reviewed route commitments: every firm account binding is named by one of the two leg actions. */
function routeCommitments(): SolanaDevnetSolverConfig['route'] {
  const names = Object.keys(deriveSolanaDevnetFirmAccounts({
    manifest, config: { solverId: solver.publicKey.toBase58(), accounts, resources } as SolanaDevnetSolverConfig, market,
    owner: key().toBase58(), orderHash: bytes(21), nonce: 1n, reservationId: bytes(22),
  }));
  const payload = Uint8Array.from([1, 2, 3]);
  const action = (sequence: number, adapter: typeof spotAdapter, target: string) => ({
    sequence, actionClassId: 'svm-firm-cash-carry-v1', legIndex: sequence, adapter,
    targetBindingId: firmRouteBindingId(target), authorityBindingId: firmRouteBindingId('trader'),
    accountMetas: (sequence === 0 ? names : [target, 'trader']).map((name) => ({ routeBindingId: firmRouteBindingId(name), isSigner: name === 'trader', isWritable: true })),
    payload: { codecId: 'svm-instruction-v1', templateLength: payload.length, templateHash: payloadTemplateHash(payload, []), lateBoundFields: [] },
  });
  return {
    actions: [action(0, spotAdapter, 'reservationProgram'), action(1, perpAdapter, 'perpAdapterProgram')],
    preconditions: [{
      constraintId: 'pre-authority', ruleId: 'authority-equals-owner-v1', accountBindingId: firmRouteBindingId('trader'),
      componentId: 'authorized', comparator: 'EQ', value: { kind: 'BOOLEAN', value: true }, evidenceRequirementId: 'authority-state',
    }],
    postconditions: [{
      constraintId: 'post-perp', ruleId: 'position-delta-v1', accountBindingId: firmRouteBindingId('testPerpPosition'),
      componentId: 'base-position-delta', comparator: 'EQ', value: { kind: 'BOOLEAN', value: true }, evidenceRequirementId: 'perp-state',
    }],
    evidenceRequirements: {
      schemaVersion: 1, profileId: 'svm-atomic-evidence-v1', requiredPreStateComponentIds: ['authority-state'], requiredPostStateComponentIds: ['perp-state'],
      requiredActionEvidenceTypeIds: ['transaction-signature'], stateReferenceSchemaHash: bytes(23), receiptSchemaHash: bytes(24), outcomeSchemaHash: bytes(25),
    },
  } as never;
}

/** The template's fee policy, order venue cap, and admission account mode, filled with one cap value. */
function templatePolicy(maxVenueFeeAtoms: bigint): Readonly<{ feePolicy: FeePolicyManifestInput; orderCaps: FeeCap[]; accountModeClass: string }> {
  const defs = {
    domain, 'activation.activationValue': 900n, 'res.quoteAsset.subjectId': quote.assetId,
    'res.quoteAsset.manifestHash': quote.assetManifestHash, 'quoteAssetRef.decimals': quote.decimals, quoteAssetRef: quote, maxVenueFeeAtoms,
  };
  const feePolicy = fromTemplate(template.definitions.feePolicyManifest, defs, { expiryValue: 1_000_000n }) as FeePolicyManifestInput;
  const configured = fromTemplate(template.outputs['api/solana-devnet-order-context.json'].content.maxVenueFeeAtomsByAsset, defs) as FeeCap[];
  // What the API's venueFeeCapsWithBase adds to every Solana order: a zero base-asset cap, canonical order.
  const orderCaps = [...configured, { asset: base, maxAtoms: 0n }].sort((left, right) => compareBytes(assetKey(left.asset), assetKey(right.asset)));
  return { feePolicy, orderCaps, accountModeClass: template.outputs['api/solana-devnet-runtime.json'].content.admission.accountModeClass };
}

function solverConfig(feePolicy: FeePolicyManifestInput): SolanaDevnetSolverConfig {
  return {
    schemaVersion: 1, runtimeManifestPath: '/unused', solverId: solver.publicKey.toBase58(), solverCapabilityManifestHash: bytes(26),
    templateRegistryRecordHash: packageTemplateRegistryRecordHash(templateRegistryRecord), feePolicyVersion: 1,
    feePolicyManifestHash: feePolicyManifestHash(feePolicy), candidateId: 'solana-devnet-firm', evidenceGrade: 'devnet',
    spot: { adapter: spotAdapter, venue: spotVenue, market: spotMarket, actionSequence: 0 },
    perpetual: { adapter: perpAdapter, venue: perpVenue, market: perpMarket, actionSequence: 1 },
    inventorySpreadBps: 10, perpLimitToleranceBps: 5, quoteTtlSlots: 450n, maxQuantityAtoms: 10_000_000_000n,
    computeUnitLimit: 1_260_000, levelTtlSlots: 1_500n, levelCapacityUnits: 100n, accounts, resources,
    spotBaseLotAtoms: 1_000_000n,
    series: {
      seriesManifestHash: bytes(27), executionClassManifestHash: bytes(28), settlementClassIdentityHash,
      spotBaseAtomsPerPackageUnit: 100_000_000n, perpQuantityAtomsPerPackageUnit: 100_000_000n,
    },
    resourceAdmissionCommitment: bytes(29),
    route: routeCommitments(),
  };
}

function chainAccounts(trader: PublicKey, order: PackageOrder): Map<string, { owner: string; data: Uint8Array }> {
  const marketData = new BorshWriter().bytes(accountDiscriminator('TestPerpMarket')).key(key()).key(key()).key(quoteMint)
    .key(SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT).bytes(Buffer.from(SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, 'hex'))
    .key(market.collateralVault).key(market.feeVault).key(market.insuranceVault).u8(6).u8(9).u32(60)
    .bytes(u16(50)).bytes(u16(5)).bytes(u16(2)).bytes(u16(1)).bytes(u16(100)).bytes(u16(1_000)).bytes(u16(0)).bytes(u16(0))
    .u64(10_000n).u64(1_000_000n).u64(1n).u64(1_000_000n).bytes(new Uint8Array(64)).bool(false).done();
  const oracle = Buffer.alloc(134);
  Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(oracle, 0);
  oracle[40] = 1;
  Buffer.from(SOLANA_DEVNET_SOL_USD_FEED_ID_HEX, 'hex').copy(oracle, 41);
  oracle.writeBigInt64LE(15_000_000_000n, 73);
  oracle.writeBigUInt64LE(1_000_000n, 81);
  oracle.writeInt32LE(-8, 89);
  oracle.writeBigInt64LE(BLOCK_TIME, 93);
  const classData = new BorshWriter().bytes(accountDiscriminator('ReservationClass')).bytes(u16(1)).domain(domain).bytes(bytes(30))
    .key(programId('reservation')).key(key()).bytes(bytes(31)).bytes(reservationPolicyHash).key(baseMint).key(quoteMint)
    .key(programId('core')).key(key()).bytes(bytes(32)).key(key()).key(key()).bytes(bytes(33)).u64(1_000n).u64(10n ** 12n).u64(10n ** 12n).done();
  const shardData = new BorshWriter().bytes(accountDiscriminator('PackageQuoteShard')).bytes(u16(1)).domain(domain)
    .key(accounts.packageBookClass).key(solver.publicKey).string(solver.publicKey.toBase58()).bytes(bytes(27)).bytes(bytes(28))
    .key(key()).key(key()).bytes(bytes(34)).key(key()).key(key()).bytes(bytes(35))
    .i128(ORACLE_PRICE_PER_LOT).bytes(bytes(36)).u64(4n).u64(9n).u64(SLOT + 5_000n).u64(2n).bool(false).done();
  const page = new BorshWriter().bytes(accountDiscriminator('QuoteLevelPage'));
  for (let slotIndex = 0; slotIndex < 32; slotIndex += 1) {
    const side = slotIndex === 0 ? QUOTE_SIDE_ASK : slotIndex === 1 ? QUOTE_SIDE_BID : 0;
    page.bytes(settlementClassIdentityHash).bytes(reservationPolicyHash).i128(0n).u64(BigInt(70 + slotIndex)).u64(2n).u64(1n)
      .u64(1n).u64(100n).u64(0n).u64(SLOT + 300n).u64(100n).u8(side === 0 ? 0 : 1).u8(side).u8(2).bytes(new Uint8Array(13));
  }
  const strategy = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-strategy'), trader.toBuffer(), Buffer.from(manifest.testPerp.strategyIdHex, 'hex')], programId('perp_adapter'),
  )[0];
  const result = new Map([
    [manifest.testPerp.market, { owner: programs.perp_venue!.programId, data: marketData }],
    [SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT, { owner: PYTH_RECEIVER_PROGRAM_ID, data: Uint8Array.from(oracle) }],
    [accounts.reservationClass, { owner: programs.reservation!.programId, data: classData }],
    [accounts.packageBookShard, { owner: programs.package_book!.programId, data: shardData }],
    [accounts.packageBookLevelPage, { owner: programs.package_book!.programId, data: page.key(accounts.packageBookShard).done() }],
  ]);
  if (order.action === 'EXIT') {
    const open = pda('core', Buffer.from('cash-carry-open'), trader.toBuffer(), strategy.toBuffer());
    const entryReceipt = pda('core', Buffer.from('cash-carry-receipt'), trader.toBuffer(), Buffer.from(order.entryReceiptHash!));
    const position = PublicKey.findProgramAddressSync(
      [Buffer.from('test-perp-position'), new PublicKey(manifest.testPerp.market).toBuffer(), trader.toBuffer()], programId('perp_venue'),
    )[0];
    result.set(open.toBase58(), {
      owner: programs.core!.programId,
      data: new BorshWriter().bytes(accountDiscriminator('OpenCashCarryPackage')).u8(1).domain(domain).key(trader).key(entryReceipt).done(),
    });
    result.set(position.toBase58(), {
      owner: programs.perp_venue!.programId,
      data: new BorshWriter().bytes(accountDiscriminator('TestPerpPosition')).key(manifest.testPerp.market).key(trader).key(strategy)
        .u64(50_000_000n).i64(-(QUANTITY / market.baseLotAtoms)).u64(order.expectedPrePositionEntryNotional.atoms).done(),
    });
  }
  return result;
}

function packageOrder(action: 'ENTRY' | 'EXIT', trader: PublicKey, maxVenueFeeAtomsByAsset: FeeCap[]): PackageOrderInput {
  const common = {
    version: 1, environment: 'devnet', domain, templateId: 'cash-and-carry-v1', templateVersion: 1, packageTemplateManifestHash: templateHash,
    owner: trader.toBase58(), settlementAccount: trader.toBase58(), nonce: 7n, expiryUnit: 'SOLANA_SLOT' as const, expiryValue: SLOT + 1_500n,
    direction: 'LONG_SPOT_SHORT_PERP' as const, packageOrderType: 'MARKETABLE_LIMIT' as const, packageTimeInForce: 'FOK' as const,
    partialFillPolicy: 'EXACT_ALL_LEGS' as const, quantity: { asset: base, atoms: QUANTITY },
    minVenueReserveReturned: { asset: quote, atoms: 0n }, minWalletQuoteBalanceDelta: { asset: quote, atoms: 0n }, maxVenueFeeAtomsByAsset,
    maxProtocolFee: { asset: quote, atoms: 0n }, maxSolverFee: { asset: quote, atoms: 0n }, maxPriorityFee: { asset: quote, atoms: 0n },
    maxRecoveryCostAtomsByAsset: [], permittedSpotAdapters: [spotAdapter], permittedPerpAdapters: [perpAdapter],
    settlementClass: 'ATOMIC_POSTCONDITION' as const, maxAggregateRecoveryLossQuote: { asset: quote, atoms: 0n },
    maxResidualBaseQuantity: { asset: base, atoms: 0n }, allowedRecoveryActions: [],
  };
  if (action === 'ENTRY') {
    return {
      ...common, action, exitOutcomeSchemaVersion: 0,
      expectedPrePositionSize: { asset: base, atoms: 0n }, expectedPrePositionEntryNotional: { asset: quote, atoms: 0n },
      maxEntrySpread: { baseAsset: base, quoteAsset: quote, quoteAtoms: 1n, baseAtoms: 1_000n, roundingDirection: 'CEIL' },
      maxSpotQuoteIn: { asset: quote, atoms: 400_000_000n }, maxMarginAdded: { asset: quote, atoms: 100_000_000n },
    };
  }
  return {
    ...common, action, exitOutcomeSchemaVersion: 1, entryReceiptHash: bytes(37),
    expectedPrePositionSize: { asset: base, atoms: -QUANTITY }, expectedPrePositionEntryNotional: { asset: quote, atoms: 299_910_000n },
    minExitQuoteOutcome: { asset: quote, atoms: 1n }, minSpotQuoteOut: { asset: quote, atoms: 1n }, maxMarginAdded: { asset: quote, atoms: 0n },
  };
}

/** Quotes the order through the solver's own firm signing path against fixed Devnet account state. */
async function signThroughSolver(order: PackageOrderInput, feePolicy: FeePolicyManifestInput) {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-solana-firm-'));
  const keyPath = join(directory, 'solver.json');
  writeFileSync(keyPath, JSON.stringify(Array.from(solver.secretKey)));
  chmodSync(keyPath, 0o600);
  const journal = new SqliteSolanaDevnetFirmQuoteJournal(':memory:');
  try {
    const validated = order as PackageOrder;
    const state = chainAccounts(new PublicKey(order.owner), validated);
    let nonce = 0n;
    const port = createSolanaDevnetFirmQuotePort({
      manifest, config: solverConfig(feePolicy), key: loadSolanaDevnetSolverKey(keyPath, solver.publicKey.toBase58()), journal,
      rpc: {
        getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        getFinalizedSlot: async () => SLOT,
        getBlockTime: async () => BLOCK_TIME,
        getAccounts: async (addresses) => addresses.map((address) => state.get(address) ?? null),
      },
      orders: () => validated,
      nonceSource: { next: () => (nonce += 1n) },
      randomNonce: () => bytes(38),
    }, { quote: async () => assert.fail('a Devnet order must not reach the fallback') });
    const response = await port.quote({ orderHash: toHex(packageOrderHash(order)), idempotencyKey: 'solana-firm-admission-test' });
    return {
      route: fromProtocolJson(response.route, 'route') as RoutePayloadInput,
      quote: fromProtocolJson(response.quote, 'quote') as SolverQuoteInput,
    };
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function admit(order: PackageOrderInput, signed: Awaited<ReturnType<typeof signThroughSolver>>, feePolicy: FeePolicyManifestInput, accountModeClass: string) {
  return validatePackageAdmission({
    order, ...signed, currentTime: { unit: 'SOLANA_SLOT', value: SLOT }, accountModeClass, domainManifest, templateManifest,
    templateRegistryRecord, feePolicyManifest: feePolicy, activeRegistryRecords,
  });
}

const entryFee = priceSolanaDevnetEntry({ inventorySpreadBps: 10, perpLimitToleranceBps: 5, spotBaseLotAtoms: 1_000_000n }, market, ORACLE_PRICE_PER_LOT, QUANTITY).perpFeeAtoms;
const exitFee = priceSolanaDevnetExit({ inventorySpreadBps: 10, perpLimitToleranceBps: 5, spotBaseLotAtoms: 1_000_000n }, market, ORACLE_PRICE_PER_LOT, QUANTITY).perpFeeAtoms;

test('a signed Solana firm entry with a nonzero perp taker fee is admitted under the template fee policy, and only up to its cap', async () => {
  assert.ok(entryFee > 0n);
  const trader = key();
  // The fee at exactly the one template cap value is admitted.
  const atCap = templatePolicy(entryFee);
  const order = packageOrder('ENTRY', trader, atCap.orderCaps);
  const signed = await signThroughSolver(order, atCap.feePolicy);
  const admitted = admit(order, signed, atCap.feePolicy, atCap.accountModeClass);
  const fee = (asset: AssetRef) => admitted.quote.expectedNormalizedVenueFeesByAsset.find((entry) => compareBytes(assetKey(entry.asset), assetKey(asset)) === 0)?.atoms;
  assert.equal(fee(quote), entryFee);
  assert.equal(fee(base), 0n);
  assert.equal(admitted.quote.expectedBaseAssetFee.atoms, 0n);

  // A fee policy one atom below the fee refuses the quote even where the order cap allows it.
  const below = templatePolicy(entryFee - 1n);
  const lenient = await signThroughSolver(order, below.feePolicy);
  assert.throws(() => admit(order, lenient, below.feePolicy, below.accountModeClass), /venue fee exceeds policy/);
  // An order cap one atom below the fee is refused before anything is signed.
  await assert.rejects(signThroughSolver(packageOrder('ENTRY', trader, below.orderCaps), below.feePolicy), /perp taker fee exceeds the order cap/);
});

test('a Solana firm exit quote passes every fee list rule, and the order cap still bounds its perp taker fee', async () => {
  assert.ok(exitFee > 0n);
  const trader = key();
  const policy = templatePolicy(exitFee);
  // The protocol validates the fee lists before the quote mode, and it does not yet admit a firm quote
  // with an exit outcome. Reaching that rule, not the base-asset fee rule, is what the fee lists prove;
  // once the protocol admits firm exits this exit must run through validatePackageAdmission as entry does.
  await assert.rejects(signThroughSolver(packageOrder('EXIT', trader, policy.orderCaps), policy.feePolicy), (error: Error) =>
    /firm quotes require atomic entry outcomes/.test(error.message) && !/expectedBaseAssetFee/.test(error.message));
  await assert.rejects(signThroughSolver(packageOrder('EXIT', trader, templatePolicy(exitFee - 1n).orderCaps), policy.feePolicy), /perp taker fee exceeds the order cap/);
});

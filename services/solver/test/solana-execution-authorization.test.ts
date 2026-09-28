import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import bs58 from 'bs58';
import { LOCAL_ATOMIC_MARKET_CATALOG_V1, type SolanaLocalEnvironmentManifest } from '@naryx/adapter-core';
import {
  adapterRef,
  packageOrderHash,
  validatePackageOrderProfile,
  type PackageAdmission,
  type PackageOrderInput,
} from '@naryx/protocol-types';
import {
  SolanaExecutionAuthorizationError,
  SolanaExecutionAuthorizationService,
  SqliteSolanaExecutionAuthorizationStore,
  createLocalAtomicMarketRuntime,
  planAtomicEntryRoute,
  signAtomicEntryQuote,
  type SolanaExecutionAuthorizationCompiler,
} from '../src/index.js';

const address = (byte: number): string => bs58.encode(new Uint8Array(32).fill(byte));

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return Object.freeze({
    verificationKey: Uint8Array.from(spki.subarray(spki.length - 32)),
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, Buffer.from(digest), privateKey)),
  });
}

async function fixture(executionSigner = signer(), quoteNonce = 1n) {
  const accounts = {
    trader: address(8), market: address(10), position: address(11), traderBase: address(12),
    traderQuote: address(13), spotBaseVault: address(14), spotQuoteVault: address(15),
    perpQuoteVault: address(16),
  };
  const catalog = {
    ...LOCAL_ATOMIC_MARKET_CATALOG_V1,
    solver: { ...LOCAL_ATOMIC_MARKET_CATALOG_V1.solver, solverId: bs58.encode(executionSigner.verificationKey) },
    programs: { core: address(20), conformanceVenue: address(21) },
    accounts,
  };
  const base = catalog.baseAsset;
  const quote = catalog.quoteAsset;
  const order = validatePackageOrderProfile({
    version: 1,
    environment: 'local',
    domain: catalog.domain,
    templateId: catalog.template.templateId,
    templateVersion: catalog.template.templateVersion,
    packageTemplateManifestHash: catalog.template.packageTemplateManifestHash,
    owner: accounts.trader,
    settlementAccount: accounts.position,
    nonce: 7n,
    expiryUnit: 'SOLANA_SLOT',
    expiryValue: 500n,
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    packageOrderType: 'MARKETABLE_LIMIT',
    packageTimeInForce: 'FOK',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    quantity: { asset: base, atoms: 1_000_000n },
    exitOutcomeSchemaVersion: 0,
    expectedPrePositionSize: { asset: base, atoms: 0n },
    expectedPrePositionEntryNotional: { asset: quote, atoms: 0n },
    maxEntrySpread: catalog.pricing.maximumEntrySpread,
    maxSpotQuoteIn: { asset: quote, atoms: 200_000_000n },
    maxMarginAdded: { asset: quote, atoms: 20_000_000n },
    minVenueReserveReturned: { asset: quote, atoms: 0n },
    minWalletQuoteBalanceDelta: { asset: quote, atoms: 0n },
    maxVenueFeeAtomsByAsset: [{ asset: base, maxAtoms: 0n }, { asset: quote, maxAtoms: 0n }],
    maxProtocolFee: { asset: quote, atoms: 0n },
    maxSolverFee: { asset: quote, atoms: 0n },
    maxPriorityFee: { asset: quote, atoms: 0n },
    maxRecoveryCostAtomsByAsset: [],
    permittedSpotAdapters: [adapterRef(catalog.adapter)],
    permittedPerpAdapters: [adapterRef(catalog.adapter)],
    settlementClass: 'ATOMIC_POSTCONDITION',
    maxAggregateRecoveryLossQuote: { asset: quote, atoms: 0n },
    maxResidualBaseQuantity: { asset: base, atoms: 0n },
    allowedRecoveryActions: [],
  } satisfies PackageOrderInput);
  const orderHash = packageOrderHash(order);
  const runtime = createLocalAtomicMarketRuntime(catalog, { next: () => quoteNonce }, () => 100n);
  const decision = planAtomicEntryRoute({ order, orderHash }, runtime.providers.candidates);
  const terms = await runtime.providers.terms({ order, decision });
  const manifest = {
    network: 'local-validator',
    mainnet: false,
    identities: { trader: accounts.trader, solver: catalog.solver.solverId },
    accounts: {
      market: accounts.market, position: accounts.position, 'trader-base': accounts.traderBase,
      'trader-quote': accounts.traderQuote, spotBaseVault: accounts.spotBaseVault,
      spotQuoteVault: accounts.spotQuoteVault, perpQuoteVault: accounts.perpQuoteVault,
    },
    programs: { core: { id: catalog.programs.core }, conformanceVenue: { id: catalog.programs.conformanceVenue } },
    governance: { solverActivationSlot: 90 },
    runtime: { catalog },
  } as unknown as SolanaLocalEnvironmentManifest;
  const signed = await signAtomicEntryQuote({ order, decision, terms, signer: executionSigner });
  const admission = Object.freeze({
    order,
    quote: signed.quote,
    route: decision.route,
    orderHash,
    quoteHash: signed.quoteHash,
    routeHash: decision.routeHash,
  }) as PackageAdmission;
  const attemptId = `local-atomic-${createHash('sha256')
    .update('NARYX/local-execution-attempt/v1', 'ascii').update(orderHash)
    .update(decision.routeHash).update(signed.quoteHash).digest('hex')}`;
  const compiler: SolanaExecutionAuthorizationCompiler = {
    compileAuthorizationPayload: (selected) => ({
      executionDigest: createHash('sha256')
        .update('test-canonical-execution').update(selected.orderHash)
        .update(selected.routeHash).update(selected.quoteHash).digest(),
      programId: catalog.programs.core,
      solver: catalog.solver.solverId,
      nonce: selected.order.nonce,
      expirySlot: selected.quote.validUntilValue,
    }),
  };
  return { admission, attemptId, compiler, executionSigner, manifest };
}

test('authorizes only the stored selected attempt and returns a verifiable digest signature', async (context) => {
  const value = await fixture();
  const scratch = mkdtempSync(join(tmpdir(), 'naryx-solana-authorization-'));
  const store = new SqliteSolanaExecutionAuthorizationStore(join(scratch, 'authorization.db'));
  context.after(() => { store.close(); rmSync(scratch, { recursive: true, force: true }); });
  let signs = 0;
  const service = new SolanaExecutionAuthorizationService({
    manifest: value.manifest,
    selectedAdmission: (attemptId) => attemptId === value.attemptId ? value.admission : undefined,
    compiler: value.compiler,
    signer: { ...value.executionSigner, signDigest: (digest) => { signs += 1; return value.executionSigner.signDigest(digest); } },
    store,
    readSlot: () => 120n,
  });
  const authorization = await service.authorize({ attemptId: value.attemptId });
  assert.equal(authorization.nonce, '7');
  assert.equal(authorization.solver, value.manifest.identities.solver);
  assert.equal(verify(null, Buffer.from(authorization.executionDigest, 'hex'), {
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value.executionSigner.verificationKey)]),
    format: 'der', type: 'spki',
  }, Buffer.from(authorization.solverSignature, 'hex')), true);
  assert.deepEqual(await service.authorize({ attemptId: value.attemptId }), authorization);
  assert.equal(signs, 1);
  await assert.rejects(
    service.authorize({ attemptId: value.attemptId, executionDigest: 'ff'.repeat(32) } as never),
    (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'INVALID_REQUEST',
  );
});

test('rejects tampered selection, expiry, wrong domain, and wrong solver key', async (context) => {
  const value = await fixture();
  const scratch = mkdtempSync(join(tmpdir(), 'naryx-solana-authorization-reject-'));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const create = (admission: PackageAdmission, slot = 120n) => {
    const store = new SqliteSolanaExecutionAuthorizationStore(join(scratch, `${Math.random()}.db`));
    context.after(() => store.close());
    return new SolanaExecutionAuthorizationService({
      manifest: value.manifest, selectedAdmission: () => admission, compiler: value.compiler,
      signer: value.executionSigner, store, readSlot: () => slot,
    });
  };
  await assert.rejects(create({ ...value.admission, order: { ...value.admission.order, nonce: 8n } }).authorize({ attemptId: value.attemptId }),
    (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'BINDING_MISMATCH');
  await assert.rejects(create(value.admission, value.admission.quote.validUntilValue).authorize({ attemptId: value.attemptId }),
    (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'EXPIRED');
  const wrongDomain = { ...value.admission.order.domain, domainId: 'svm:other' as typeof value.admission.order.domain.domainId };
  await assert.rejects(create({ ...value.admission, order: { ...value.admission.order, domain: wrongDomain } }).authorize({ attemptId: value.attemptId }),
    (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'BINDING_MISMATCH');
  assert.throws(() => new SolanaExecutionAuthorizationService({
    manifest: value.manifest, selectedAdmission: () => value.admission, compiler: value.compiler,
    signer: signer(), store: { reserve: () => { throw new Error(); }, complete: () => { throw new Error(); }, close: () => {} },
    readSlot: () => 120n,
  }), (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'SOLVER_MISMATCH');
});

test('persists nonce reservations across restart and rejects a conflicting selected attempt', async () => {
  const executionSigner = signer();
  const first = await fixture(executionSigner, 1n);
  const second = await fixture(executionSigner, 2n);
  const scratch = mkdtempSync(join(tmpdir(), 'naryx-solana-authorization-restart-'));
  const path = join(scratch, 'authorization.db');
  const initialStore = new SqliteSolanaExecutionAuthorizationStore(path);
  await new SolanaExecutionAuthorizationService({
    manifest: first.manifest, selectedAdmission: () => first.admission, compiler: first.compiler,
    signer: executionSigner, store: initialStore, readSlot: () => 120n,
  }).authorize({ attemptId: first.attemptId });
  initialStore.close();
  const reopened = new SqliteSolanaExecutionAuthorizationStore(path);
  try {
    await assert.rejects(new SolanaExecutionAuthorizationService({
      manifest: second.manifest, selectedAdmission: () => second.admission, compiler: second.compiler,
      signer: executionSigner, store: reopened, readSlot: () => 120n,
    }).authorize({ attemptId: second.attemptId }),
    (error: unknown) => error instanceof SolanaExecutionAuthorizationError && error.code === 'NONCE_REPLAY');
  } finally {
    reopened.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

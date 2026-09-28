import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import anchor, { type Idl } from '@coral-xyz/anchor';
import { Connection, Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import type { DomainRef, PackageAdmission } from '@naryx/protocol-types';
import { SolanaConformanceAdapter, type ConformanceExecutionSignatureProvider } from '../src/index.js';

const coreIdl = JSON.parse(readFileSync(new URL('../../../../../deployments/solana/conformance/idl/naryx_core.json', import.meta.url), 'utf8')) as Idl;
const venueIdl = JSON.parse(readFileSync(new URL('../../../../../deployments/solana/conformance/idl/naryx_conformance_venue.json', import.meta.url), 'utf8')) as Idl;
const { BN, BorshCoder } = anchor;
const coder = new BorshCoder(coreIdl);
const address = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));
const trader = address(8);
const solver = address(17);
const domain = {
  domainId: 'svm:local-conformance',
  domainManifestVersion: 1,
  domainManifestHash: new Uint8Array(32).fill(9),
} as unknown as DomainRef;
const hash = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const accountIds = {
  trader,
  solver,
  market: address(10),
  position: address(11),
  'trader-base': address(12),
  'trader-quote': address(13),
  'spot-base-vault': address(14),
  'spot-quote-vault': address(15),
  'perp-quote-vault': address(16),
  'conformance-program': new PublicKey(venueIdl.address),
};

function admission(action: 'ENTRY' | 'EXIT' = 'ENTRY'): PackageAdmission {
  const orderHash = hash(1);
  const routeHash = hash(2);
  const quoteHash = hash(3);
  return {
    orderHash,
    routeHash,
    quoteHash,
    order: {
      environment: 'local',
      domain,
      templateId: 'cash-and-carry-v1',
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      action,
      partialFillPolicy: 'EXACT_ALL_LEGS',
      owner: trader.toBase58(),
      nonce: 7n,
      expiryUnit: 'SOLANA_SLOT',
      expiryValue: 500n,
      quantity: { atoms: 9n },
      maxSpotQuoteIn: action === 'ENTRY' ? { atoms: 70n } : undefined,
      minSpotQuoteOut: action === 'EXIT' ? { atoms: 60n } : undefined,
      maxMarginAdded: { atoms: 20n },
      minVenueReserveReturned: { atoms: 10n },
    },
    quote: {
      environment: 'local',
      domain,
      orderHash,
      routeHash,
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: solver.toBytes(),
      expectedGrossSpotQuantity: { atoms: 9n },
      protocolFee: { atoms: 0n },
      solverFee: { atoms: 0n },
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: 480n,
    },
    route: {
      environment: 'local',
      domain,
      orderHash,
      solver: solver.toBase58(),
      templateId: 'cash-and-carry-v1',
      direction: 'LONG_SPOT_SHORT_PERP',
      settlementClass: 'ATOMIC_POSTCONDITION',
      executionPlanKind: 'SVM_ATOMIC_CPI',
      action,
      partialFillPolicy: 'EXACT_ALL_LEGS',
      routeExpiryUnit: 'SOLANA_SLOT',
      routeExpiryValue: 490n,
      serviceCharges: [],
      accountBindings: Object.entries(accountIds).map(([routeBindingId, pubkey]) => ({
        routeBindingId,
        accountIdentity: pubkey.toBase58(),
      })),
      legs: [
        { legRole: 'SPOT', side: action === 'ENTRY' ? 'BUY' : 'SELL', quantity: { atoms: 9n } },
        { legRole: 'PERPETUAL', side: action === 'ENTRY' ? 'SELL' : 'BUY', quantity: { atoms: 9n } },
      ],
      actions: [
        { targetBindingId: 'conformance-program', authorityBindingId: 'trader' },
        { targetBindingId: 'conformance-program', authorityBindingId: 'trader' },
      ],
    },
  } as unknown as PackageAdmission;
}

const executionSignature = new Uint8Array(64).fill(21);

function adapter(
  connection = new Connection('http://127.0.0.1:8899'),
  executionSignatureProvider: ConformanceExecutionSignatureProvider = async () => executionSignature,
): SolanaConformanceAdapter {
  return new SolanaConformanceAdapter({
    connection,
    domain,
    environment: 'local',
    expectedGenesisHash: 'local-genesis',
    executionSignatureProvider,
  });
}

for (const action of ['ENTRY', 'EXIT'] as const) {
  test(`compiles ${action} with IDL account order and exact limits`, async () => {
    const result = await adapter().compile(admission(action));
    assert.equal(result.payload.coreInstruction.programId.toBase58(), coreIdl.address);
    assert.equal(result.payload.instructions.length, 2);
    assert.equal(result.payload.instructions[0]?.programId.toBase58(), Ed25519Program.programId.toBase58());
    assert.equal(result.payload.instructions[1], result.payload.coreInstruction);
    const verificationData = result.payload.instructions[0]!.data;
    assert.deepEqual(Array.from(verificationData.subarray(16, 48)), Array.from(solver.toBytes()));
    assert.deepEqual(Array.from(verificationData.subarray(48, 112)), Array.from(executionSignature));
    assert.deepEqual(Array.from(verificationData.subarray(112)), Array.from(result.payload.executionDigest));
    const decoded = coder.instruction.decode(result.payload.coreInstruction.data);
    assert.equal(decoded?.name, 'execute_conformance_atomic');
    const data = decoded?.data as { order_hash: number[]; quote_hash: number[]; route_hash: number[]; args: { action: object; base_quantity_atoms: InstanceType<typeof BN>; spot_quote_limit_atoms: InstanceType<typeof BN>; collateral_quote_limit_atoms: InstanceType<typeof BN>; expiry_slot: InstanceType<typeof BN>; nonce: InstanceType<typeof BN> } };
    assert.deepEqual(data.order_hash, Array.from(hash(1)));
    assert.deepEqual(data.quote_hash, Array.from(hash(3)));
    assert.deepEqual(data.route_hash, Array.from(hash(2)));
    assert.deepEqual(data.args.action, action === 'ENTRY' ? { Entry: {} } : { Exit: {} });
    assert.equal(data.args.base_quantity_atoms.toString(), '9');
    assert.equal(data.args.spot_quote_limit_atoms.toString(), action === 'ENTRY' ? '70' : '60');
    assert.equal(data.args.collateral_quote_limit_atoms.toString(), action === 'ENTRY' ? '20' : '10');
    assert.equal(data.args.expiry_slot.toString(), '480');
    assert.equal(data.args.nonce.toString(), '7');
    const instruction = coreIdl.instructions.find((item) => item.name === 'execute_conformance_atomic')!;
    assert.deepEqual(result.payload.coreInstruction.keys.map((item) => item.pubkey.toBase58()), instruction.accounts.map((item) => {
      if (item.name === 'config') return adapter().configAddress().toBase58();
      if (item.name === 'solver_registry') return adapter().solverRegistryAddress().toBase58();
      if (item.name === 'receipt') return adapter().receiptAddress(trader, hash(1)).toBase58();
      if (item.name === 'nonce_marker') return adapter().nonceMarkerAddress(trader, 7n).toBase58();
      if (item.name === 'instructions_sysvar') return SYSVAR_INSTRUCTIONS_PUBKEY.toBase58();
      if (item.name === 'token_program' || item.name === 'system_program') return (item as { address: string }).address;
      return accountIds[item.name === 'trader_base' ? 'trader-base'
        : item.name === 'trader_quote' ? 'trader-quote'
        : item.name === 'spot_base_vault' ? 'spot-base-vault'
        : item.name === 'spot_quote_vault' ? 'spot-quote-vault'
        : item.name === 'perp_quote_vault' ? 'perp-quote-vault'
        : item.name === 'conformance_program' ? 'conformance-program'
        : item.name as keyof typeof accountIds].toBase58();
    }));
    assert.deepEqual(result.payload.coreInstruction.keys.map((item) => ({ signer: item.isSigner, writable: item.isWritable })),
      instruction.accounts.map((item) => ({ signer: 'signer' in item && item.signer === true, writable: 'writable' in item && item.writable === true })));
  });
}

test('binds the execution digest to nonce and core accounts', async () => {
  let providedDigest: Uint8Array | undefined;
  const compiler = adapter(undefined, async (digest) => {
    providedDigest = Uint8Array.from(digest);
    return executionSignature;
  });
  const first = await compiler.compile(admission());
  assert.deepEqual(providedDigest, first.payload.executionDigest);
  const changed = admission();
  const second = await compiler.compile({ ...changed, order: { ...changed.order, nonce: 8n } });
  assert.notDeepEqual(first.payload.executionDigest, second.payload.executionDigest);
  assert.equal(second.payload.coreInstruction.keys[4]?.pubkey.toBase58(), compiler.nonceMarkerAddress(trader, 8n).toBase58());
  const changedMarket = admission();
  const marketBindings = changedMarket.route.accountBindings.map((binding) => binding.routeBindingId === 'market'
    ? { ...binding, accountIdentity: address(24).toBase58() as typeof binding.accountIdentity }
    : binding);
  const third = await compiler.compile({ ...changedMarket, route: { ...changedMarket.route, accountBindings: marketBindings } });
  assert.notDeepEqual(first.payload.executionDigest, third.payload.executionDigest);
});

test('accepts an externally produced execution signature without invoking the provider', async () => {
  const compiler = adapter(undefined, async () => { throw new Error('provider must not run'); });
  const authorization = compiler.compileAuthorizationPayload(admission());
  assert.equal(authorization.programId, coreIdl.address);
  assert.equal(authorization.solver, solver.toBase58());
  assert.equal(authorization.nonce, 7n);
  assert.equal(authorization.expirySlot, 480n);
  const compiled = await compiler.compileAuthenticated(admission(), executionSignature);
  assert.deepEqual(authorization.executionDigest, compiled.payload.executionDigest);
  assert.deepEqual(Array.from(compiled.payload.instructions[0]!.data.subarray(48, 112)), Array.from(executionSignature));
  await assert.rejects(compiler.compileAuthenticated(admission(), new Uint8Array(63)), /solver execution signature must be 64 bytes/);
});

test('rejects missing bindings, mismatched venue, and u64 overflow', async () => {
  const compiler = adapter();
  const missing = admission();
  const brokenBindings = missing.route.accountBindings.filter((binding) => binding.routeBindingId !== 'position');
  await assert.rejects(compiler.compile({ ...missing, route: { ...missing.route, accountBindings: brokenBindings } }), /missing route binding position/);
  const wrongVenue = admission();
  const wrongBindings = wrongVenue.route.accountBindings.map((binding) => binding.routeBindingId === 'conformance-program'
    ? { ...binding, accountIdentity: address(22).toBase58() as typeof binding.accountIdentity }
    : binding);
  await assert.rejects(compiler.compile({ ...wrongVenue, route: { ...wrongVenue.route, accountBindings: wrongBindings } }), /conformance program binding mismatch/);
  const wrongSolver = admission();
  const wrongSolverBindings = wrongSolver.route.accountBindings.map((binding) => binding.routeBindingId === 'solver'
    ? { ...binding, accountIdentity: address(23).toBase58() as typeof binding.accountIdentity }
    : binding);
  await assert.rejects(compiler.compile({ ...wrongSolver, route: { ...wrongSolver.route, accountBindings: wrongSolverBindings } }), /solver binding does not match route solver/);
  const zeroNonce = admission();
  await assert.rejects(compiler.compile({ ...zeroNonce, order: { ...zeroNonce.order, nonce: 0n } }), /nonce must be nonzero/);
  const overflow = admission();
  await assert.rejects(compiler.compile({ ...overflow, order: { ...overflow.order, quantity: { ...overflow.order.quantity, atoms: 1n << 64n } }, quote: { ...overflow.quote, expectedGrossSpotQuantity: { ...overflow.quote.expectedGrossSpotQuantity, atoms: 1n << 64n } }, route: { ...overflow.route, legs: overflow.route.legs.map((leg) => ({ ...leg, quantity: { ...leg.quantity, atoms: 1n << 64n } })) } }), /base quantity must fit u64/);
});

test('decodes receipt only at trader-bound PDA', async () => {
  const compiler = adapter();
  const receiptAddress = compiler.receiptAddress(trader, hash(1));
  const encoded = await coder.accounts.encode('ConformanceExecutionReceipt', {
    domain: { domain_id: domain.domainId, domain_manifest_version: domain.domainManifestVersion, domain_manifest_hash: Array.from(domain.domainManifestHash) },
    order_hash: Array.from(hash(1)), quote_hash: Array.from(hash(3)), route_hash: Array.from(hash(2)), trader,
    solver, nonce: new BN(7), execution_digest: Array.from(hash(4)),
    action: 1, base_quantity_atoms: new BN(9), pre_base_balance: new BN(0), post_base_balance: new BN(9),
    pre_quote_balance: new BN(100), post_quote_balance: new BN(40), pre_short_base_atoms: new BN(0),
    post_short_base_atoms: new BN(9), pre_collateral_quote_atoms: new BN(0), post_collateral_quote_atoms: new BN(20),
    execution_slot: new BN(320), bump: 255,
  });
  const receipt = compiler.decodeReceipt(receiptAddress, encoded);
  assert.equal(receipt.action, 'ENTRY');
  assert.equal(receipt.solver.toBase58(), solver.toBase58());
  assert.equal(receipt.nonce, 7n);
  assert.deepEqual(receipt.executionDigest, hash(4));
  assert.deepEqual(receipt.domain.domainManifestHash, domain.domainManifestHash);
  assert.equal(receipt.postShortBaseAtoms, 9n);
  assert.throws(() => compiler.decodeReceipt(address(25), encoded), /receipt PDA mismatch/);
});

test('simulation verifies RPC genesis before issuing an unsigned simulation', async () => {
  let simulated = false;
  const connection = {
    getGenesisHash: async () => 'unexpected-genesis',
    simulateTransaction: async () => { simulated = true; throw new Error('should not run'); },
  } as unknown as Connection;
  await assert.rejects(adapter(connection).simulate(await adapter().compile(admission())), /RPC genesis hash mismatch/);
  assert.equal(simulated, false);
});

test('simulation sends an unsigned transaction only to the RPC simulation method', async () => {
  let simulated = false;
  const connection = {
    getGenesisHash: async () => 'local-genesis',
    getLatestBlockhash: async () => ({ blockhash: address(30).toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async (transaction: { signatures: readonly Uint8Array[] }, config: { sigVerify: boolean; replaceRecentBlockhash: boolean }) => {
      simulated = true;
      assert.equal(config.sigVerify, false);
      assert.equal(config.replaceRecentBlockhash, true);
      assert.equal(transaction.signatures.length, 1);
      assert.ok(transaction.signatures[0]?.every((byte) => byte === 0));
      return { value: { err: null, logs: ['ok'], unitsConsumed: 123 } };
    },
  } as unknown as Connection;
  const result = await adapter(connection).simulate(await adapter().compile(admission()));
  assert.equal(simulated, true);
  assert.equal(result.succeeded, true);
  assert.equal(result.resourceUnits, 123n);
});

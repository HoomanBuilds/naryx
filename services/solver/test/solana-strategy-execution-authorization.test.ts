import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaMultiStrategyTransactionMaterializer,
  type SolanaReadOnlyRpc,
} from '@naryx/adapter-solana';
import { domainRef, type Hash32 } from '@naryx/protocol-types';
import {
  SolanaStrategyExecutionAuthorizationService,
  type PreparedStrategyExecutionTransport,
  type SolanaTreasuryHedgeExecutionLane,
} from '../src/index.js';

const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const key = (byte: number) => new PublicKey(bytes(byte));
const domain = domainRef('svm:devnet', 1, '11'.repeat(32));
const owner = key(1);
const solver = Keypair.fromSeed(bytes(2));
const program = key(3);
const account = key(4);
const tableAddress = key(5);
const quoteHash = bytes(6) as Hash32;

function prepared(): PreparedStrategyExecutionTransport {
  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      packageId: bytes(7) as Hash32,
      templateId: 'treasury-inventory-hedge-v1',
      templateVersion: 1,
      templateManifestHash: bytes(8),
      operation: 'ENTRY',
      nextStateHash: bytes(9) as Hash32,
    }),
    settlementClass: 'ATOMIC_POSTCONDITION',
    coordination: 'SINGLE_DOMAIN_ATOMIC',
    orderHash: bytes(10),
    graphHash: bytes(11),
    quoteHash,
    routeHash: bytes(12),
    domains: Object.freeze([{
      kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT' as const,
      domain,
      routeSettlementClass: 'ATOMIC_POSTCONDITION' as const,
      localGuarantee: 'ATOMIC_POSTCONDITION' as const,
      legIds: Object.freeze(['treasury-hedge']),
      envelope: Object.freeze({
        instruction: Object.freeze({
          programId: program.toBase58(),
          accounts: Object.freeze([
            Object.freeze({ pubkey: owner.toBase58(), isSigner: true, isWritable: true }),
            Object.freeze({ pubkey: solver.publicKey.toBase58(), isSigner: true, isWritable: false }),
            Object.freeze({ pubkey: account.toBase58(), isSigner: false, isWritable: true }),
          ]),
          data: Uint8Array.from([1, 2, 3]),
        }),
        executionHash: bytes(13),
        callsHash: bytes(14),
        strategyAccount: key(15).toBase58(),
        position: key(16).toBase58(),
        receipt: key(17).toBase58(),
        requiredSignerPubkeys: Object.freeze([owner.toBase58(), solver.publicKey.toBase58()].sort()),
      }),
    }]),
  });
}

function lane(expectedSolver = solver.publicKey.toBase58()): SolanaTreasuryHedgeExecutionLane {
  const lookup = new AddressLookupTableAccount({
    key: tableAddress,
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 90,
      lastExtendedSlotStartIndex: 0,
      addresses: [account],
    },
  });
  const rpc: SolanaReadOnlyRpc = Object.freeze({
    rpcUrl: 'https://api.devnet.solana.com',
    getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => Object.freeze({
      contextSlot: 99,
      blockhash: key(18).toBase58(),
      lastValidBlockHeight: 500,
    }),
    getLookupTable: async () => Object.freeze({
      contextSlot: 100,
      owner: AddressLookupTableProgram.programId,
      executable: false,
      account: lookup,
    }),
  });
  return Object.freeze({
    domain,
    solver: expectedSolver,
    computeUnitLimit: 600_000,
    reader: {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getFinalizedSlot: async () => 100n,
      getBlockTime: async () => 1_000n,
      getAccounts: async () => [],
      getTransactionObservation: async () => Object.freeze({ status: 'PENDING' as const }),
    },
    materializer: new SolanaMultiStrategyTransactionMaterializer(rpc, {
      environment: 'devnet',
      domain,
      rpcUrl: rpc.rpcUrl,
      expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
      lookupTables: [{ address: tableAddress, expectedAddresses: [account] }],
    }),
  });
}

test('returns a Devnet transaction signed only by the configured solver', async () => {
  const service = new SolanaStrategyExecutionAuthorizationService({
    preparations: { prepareByQuote: async () => prepared() },
    lanes: [lane()],
    signer: {
      publicKey: solver.publicKey.toBase58(),
      sign: (transaction) => transaction.sign([solver]),
    },
  });
  const authorization = await service.authorize(quoteHash);
  assert(authorization !== undefined);
  const transaction = VersionedTransaction.deserialize(Buffer.from(authorization.transactionBase64, 'base64'));
  const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  const ownerIndex = signerKeys.findIndex((value) => value.equals(owner));
  const solverIndex = signerKeys.findIndex((value) => value.equals(solver.publicKey));

  assert(ownerIndex >= 0 && solverIndex >= 0);
  assert(transaction.signatures[ownerIndex]!.every((byte) => byte === 0));
  assert(transaction.signatures[solverIndex]!.some((byte) => byte !== 0));
  assert.equal(authorization.owner, owner.toBase58());
  assert.equal(authorization.quoteHash, Buffer.from(quoteHash).toString('hex'));
  assert.equal(authorization.lookupTables[0]?.address, tableAddress.toBase58());
});

test('refuses to sign when the lane names another solver', async () => {
  const service = new SolanaStrategyExecutionAuthorizationService({
    preparations: { prepareByQuote: async () => prepared() },
    lanes: [lane(key(19).toBase58())],
    signer: {
      publicKey: solver.publicKey.toBase58(),
      sign: (transaction) => transaction.sign([solver]),
    },
  });
  await assert.rejects(service.authorize(quoteHash), /execution lane solver differs from the signing account/);
});

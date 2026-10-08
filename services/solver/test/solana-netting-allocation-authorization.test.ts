import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaMultiStrategyTransactionMaterializer,
  type SolanaMultiStrategyEnvelope,
  type SolanaReadOnlyRpc,
} from '@naryx/adapter-solana';
import { domainRef } from '@naryx/protocol-types';
import {
  SolanaNettingAllocationAuthorizationService,
  type SolanaTreasuryHedgeExecutionLane,
} from '../src/index.js';

const bytes = (byte: number) => new Uint8Array(32).fill(byte);
const key = (byte: number) => new PublicKey(bytes(byte));
const domain = domainRef('svm:devnet', 1, bytes(1));
const owner = key(2);
const solver = Keypair.fromSeed(bytes(3));
const program = key(4);
const account = key(5);
const tableAddress = key(6);

function lane(): Readonly<{
  execution: SolanaTreasuryHedgeExecutionLane;
  lookup: AddressLookupTableAccount;
}> {
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
      blockhash: key(7).toBase58(),
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
    lookup,
    execution: Object.freeze({
      domain,
      solver: solver.publicKey.toBase58(),
      computeUnitLimit: 600_000,
      reader: {} as SolanaTreasuryHedgeExecutionLane['reader'],
      materializer: new SolanaMultiStrategyTransactionMaterializer(rpc, {
        environment: 'devnet',
        domain,
        rpcUrl: rpc.rpcUrl,
        expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
        lookupTables: [{ address: tableAddress, expectedAddresses: [account] }],
      }),
    }),
  });
}

function prepared() {
  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: solver.publicKey, isSigner: true, isWritable: false },
    { pubkey: account, isSigner: false, isWritable: true },
  ];
  const envelope: SolanaMultiStrategyEnvelope = Object.freeze({
    instruction: new TransactionInstruction({ programId: program, keys, data: Buffer.from([1]) }),
    executionHash: bytes(8),
    callsHash: bytes(9),
    domain,
    owner,
    solver: solver.publicKey,
    packageId: bytes(10),
    orderHash: bytes(11),
    graphHash: bytes(12),
    quoteHash: bytes(13),
    routeHash: bytes(14),
    operation: 'ENTRY',
    previousStateHash: new Uint8Array(32),
    nextStateHash: bytes(15),
    nonce: 1n,
    deadlineSlot: 500n,
    strategyAccount: key(16),
    position: key(17),
    receipt: key(18),
    requiredSignerPubkeys: Object.freeze([owner.toBase58(), solver.publicKey.toBase58()].sort()),
  });
  const instruction = new TransactionInstruction({
    programId: program,
    keys,
    data: Buffer.from([9, 8, 7, 6]),
  });
  return {
    kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT',
    authorization: { authorizationHash: bytes(19) },
    netting: {
      envelope,
      authorizationHash: bytes(19),
      instruction,
      requiredSignerPubkeys: envelope.requiredSignerPubkeys,
    },
    observation: { runtimeClass: 'SVM', binding: {} },
  } as const;
}

test('returns a Devnet netting transaction signed only by the solver', async () => {
  const preparedAllocation = prepared();
  const executionLane = lane();
  const service = new SolanaNettingAllocationAuthorizationService({
    lifecycle: {
      prepareAndRegister: async () => ({
        proofHashHex: '11'.repeat(32),
        allocationReceiptHashHex: '22'.repeat(32),
        prepared: preparedAllocation,
        attempt: {
          attemptId: 'allocation-attempt-0001',
          idempotencyKey: '33'.repeat(32),
          authorizationHashHex: '44'.repeat(32),
          observation: preparedAllocation.observation,
          recordedAtMs: 1,
        },
      }) as never,
    },
    lanes: [executionLane.execution],
    signer: {
      publicKey: solver.publicKey.toBase58(),
      sign: (transaction) => transaction.sign([solver]),
    },
  });
  const authorization = await service.authorize({
    proofHash: bytes(20),
    allocationReceiptHash: bytes(21),
    quoteHash: bytes(13) as never,
    domainId: domain.domainId,
    attemptId: 'allocation-attempt-0001',
  });
  const transaction = VersionedTransaction.deserialize(Buffer.from(authorization.transactionBase64, 'base64'));
  const signers = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  const ownerIndex = signers.findIndex((value) => value.equals(owner));
  const solverIndex = signers.findIndex((value) => value.equals(solver.publicKey));
  const message = TransactionMessage.decompile(transaction.message, {
    addressLookupTableAccounts: [executionLane.lookup],
  });

  assert(ownerIndex >= 0 && solverIndex >= 0);
  assert(transaction.signatures[ownerIndex]!.every((byte) => byte === 0));
  assert(transaction.signatures[solverIndex]!.some((byte) => byte !== 0));
  assert.deepEqual(message.instructions[1]!.data, Buffer.from([9, 8, 7, 6]));
  assert.equal(authorization.authorizationHash, '13'.repeat(32));
  assert.equal(authorization.attemptId, 'allocation-attempt-0001');
});

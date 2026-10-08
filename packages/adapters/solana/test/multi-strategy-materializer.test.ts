import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { domainRef } from '@naryx/protocol-types';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaMultiStrategyTransactionMaterializer,
  type SolanaLookupTableSnapshot,
  type SolanaMultiStrategyEnvelope,
  type SolanaReadOnlyRpc,
} from '../src/index.js';

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const domain = domainRef('svm:devnet', 1, '11'.repeat(32));
const payer = key(1);
const solver = key(2);
const program = key(3);
const lookupAddress = key(4);
const lookedUpAddresses = Object.freeze(Array.from({ length: 24 }, (_, index) => key(index + 20)));
const lookupAccount = new AddressLookupTableAccount({
  key: lookupAddress,
  state: {
    deactivationSlot: (1n << 64n) - 1n,
    lastExtendedSlot: 90,
    lastExtendedSlotStartIndex: 0,
    addresses: [...lookedUpAddresses],
  },
});

function envelope(): SolanaMultiStrategyEnvelope {
  return Object.freeze({
    instruction: new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: solver, isSigner: true, isWritable: false },
        ...lookedUpAddresses.map((pubkey, index) => ({
          pubkey,
          isSigner: false,
          isWritable: index < 12,
        })),
      ],
      data: Buffer.alloc(400, 7),
    }),
    executionHash: new Uint8Array(32).fill(5),
    callsHash: new Uint8Array(32).fill(6),
    domain,
    owner: payer,
    solver,
    packageId: new Uint8Array(32).fill(7),
    orderHash: new Uint8Array(32).fill(8),
    graphHash: new Uint8Array(32).fill(9),
    quoteHash: new Uint8Array(32).fill(10),
    routeHash: new Uint8Array(32).fill(11),
    operation: 'ENTRY',
    previousStateHash: new Uint8Array(32),
    nextStateHash: new Uint8Array(32).fill(12),
    nonce: 1n,
    deadlineSlot: 500n,
    strategyAccount: key(5),
    position: key(6),
    receipt: key(7),
    requiredSignerPubkeys: Object.freeze([payer.toBase58(), solver.toBase58()].sort()),
  });
}

function rpc(addresses: readonly PublicKey[] = lookedUpAddresses): SolanaReadOnlyRpc {
  const snapshot: SolanaLookupTableSnapshot = Object.freeze({
    contextSlot: 100,
    owner: AddressLookupTableProgram.programId,
    executable: false,
    account: new AddressLookupTableAccount({
      key: lookupAddress,
      state: { ...lookupAccount.state, addresses: [...addresses] },
    }),
  });
  return Object.freeze({
    rpcUrl: 'https://api.devnet.solana.com',
    getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => Object.freeze({
      contextSlot: 99,
      blockhash: key(8).toBase58(),
      lastValidBlockHeight: 500,
    }),
    getLookupTable: async () => snapshot,
  });
}

function materializer(readOnlyRpc: SolanaReadOnlyRpc) {
  return new SolanaMultiStrategyTransactionMaterializer(readOnlyRpc, {
    environment: 'devnet',
    domain,
    rpcUrl: readOnlyRpc.rpcUrl,
    expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
    lookupTables: [{ address: lookupAddress, expectedAddresses: lookedUpAddresses }],
  });
}

test('materializes a packet-safe v0 multi-strategy transaction with exact signers and lookup evidence', async () => {
  const result = await materializer(rpc()).materialize({
    domain,
    payer,
    envelope: envelope(),
    computeUnitLimit: 600_000,
  });
  const transaction = VersionedTransaction.deserialize(result.transactionBytes);

  assert.deepEqual([...result.requiredSignerPubkeys].sort(), [payer.toBase58(), solver.toBase58()].sort());
  assert.equal(transaction.message.addressTableLookups.length, 1);
  assert.equal(result.lookupTables[0]?.address, lookupAddress.toBase58());
  assert.equal(result.evidence.computeUnitLimit, 600_000);
  assert(result.evidence.serializedTransactionBytes <= result.evidence.packetDataLimit);
  assert(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert.equal(result.materializationCommitment.length, 32);
});

test('fails closed when live lookup-table content differs from reviewed configuration', async () => {
  const changed = [...lookedUpAddresses];
  changed[5] = key(99);
  await assert.rejects(
    materializer(rpc(changed)).materialize({
      domain,
      payer,
      envelope: envelope(),
      computeUnitLimit: 600_000,
    }),
    /lookup table .* content mismatch at index 5/,
  );
});

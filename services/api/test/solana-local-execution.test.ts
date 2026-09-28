import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { SolanaLocalEnvironmentManifest } from "@naryx/adapter-core";
import type { PackageAdmission } from "@naryx/protocol-types";
import type { ConformanceReceipt } from "@naryx/adapter-solana";
import {
  SolanaLocalExecutionService,
  SqliteSolanaLocalPreparedExecutionStore,
  type SolanaLocalConformancePort,
  type SolanaLocalExecutionLifecyclePort,
  type SolanaLocalExecutionRpc,
} from "../src/index.js";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const hash = (byte: number) => new Uint8Array(32).fill(byte);

function fixture(scratch: string) {
  const traderKeys = generateKeyPairSync("ed25519");
  const spki = traderKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const trader = new PublicKey(spki.subarray(spki.length - 32));
  const core = key(20);
  const venue = key(21);
  const market = key(10);
  const position = key(11);
  const traderBase = key(12);
  const traderQuote = key(13);
  const spotBaseVault = key(14);
  const spotQuoteVault = key(15);
  const perpQuoteVault = key(16);
  const receiptAddress = key(22);
  const nonceAddress = key(23);
  const domain = {
    domainId: "svm:local",
    domainManifestVersion: 1,
    domainManifestHash: hash(9),
  };
  const admission = {
    orderHash: hash(1),
    routeHash: hash(2),
    quoteHash: hash(3),
    order: { owner: trader.toBase58(), nonce: 7n, quantity: { atoms: 2n } },
    route: {},
    quote: {},
  } as unknown as PackageAdmission;
  const executionDigest = hash(7);
  const receipt = {
    address: receiptAddress,
    domain,
    trader,
    solver: key(17),
    orderHash: admission.orderHash,
    quoteHash: admission.quoteHash,
    routeHash: admission.routeHash,
    action: "ENTRY" as const,
    nonce: 7n,
    executionDigest,
    baseQuantityAtoms: 2n,
    preBaseBalance: 10n,
    postBaseBalance: 12n,
    preQuoteBalance: 100n,
    postQuoteBalance: 95n,
    preShortBaseAtoms: 0n,
    postShortBaseAtoms: 2n,
    preCollateralQuoteAtoms: 0n,
    postCollateralQuoteAtoms: 1n,
    executionSlot: 50n,
  } as unknown as ConformanceReceipt;
  const adapter: SolanaLocalConformancePort = {
    compileAuthenticated: async (_admission, solverSignature) => ({
      payload: {
        executionDigest,
        coreInstruction: new TransactionInstruction({
          programId: core,
          keys: [{ pubkey: trader, isSigner: true, isWritable: true }],
          data: Buffer.from([1]),
        }),
        instructions: [
          Ed25519Program.createInstructionWithPublicKey({
            publicKey: key(17).toBytes(),
            message: executionDigest,
            signature: solverSignature,
          }),
          new TransactionInstruction({
            programId: core,
            keys: [{ pubkey: trader, isSigner: true, isWritable: true }],
            data: Buffer.from([1]),
          }),
        ],
      },
    }),
    receiptAddress: () => receiptAddress,
    nonceMarkerAddress: () => nonceAddress,
    readEvidence: async () => ({
      executionReference: receiptAddress.toBase58(),
      domain: domain as never,
      orderHash: admission.orderHash,
      quoteHash: admission.quoteHash,
      routeHash: admission.routeHash,
      receipt,
    }),
    decodePosition: () => ({
      market,
      trader,
      shortBaseAtoms: 2n,
      collateralQuoteAtoms: 1n,
    }),
  };
  const manifest = {
    network: "local-validator",
    mainnet: false,
    rpc: { url: "http://127.0.0.1:8899" },
    runtime: { domainManifest: { environment: "local", chainNamespace: "solana" } },
    accounts: {
      market: market.toBase58(),
      position: position.toBase58(),
      "trader-base": traderBase.toBase58(),
      "trader-quote": traderQuote.toBase58(),
      spotBaseVault: spotBaseVault.toBase58(),
      spotQuoteVault: spotQuoteVault.toBase58(),
      perpQuoteVault: perpQuoteVault.toBase58(),
    },
    identities: { trader: trader.toBase58() },
    programs: { core: { id: core.toBase58() }, conformanceVenue: { id: venue.toBase58() } },
  } as unknown as SolanaLocalEnvironmentManifest;
  let status: { confirmationStatus: string; err: unknown } | null = null;
  let loseResponse = false;
  const tokenAmounts = new Map([
    [traderBase.toBase58(), 12n],
    [traderQuote.toBase58(), 95n],
  ]);
  const rpc: SolanaLocalExecutionRpc = {
    getLatestBlockhash: async () => ({ blockhash: key(30).toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async (bytes) => {
      const signature = bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
      if (loseResponse) throw new Error("response lost");
      return signature;
    },
    getSignatureStatus: async () => status,
    getAccount: async (address) => {
      if (address.equals(nonceAddress)) return { owner: core, data: Buffer.alloc(1) };
      if (address.equals(position)) return { owner: venue, data: Buffer.alloc(1) };
      return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data: Buffer.alloc(165) };
    },
    getTokenAmount: async (address) => tokenAmounts.get(address.toBase58()) ?? 1n,
  };
  const lifecycleCalls: string[] = [];
  const lifecycle: SolanaLocalExecutionLifecyclePort = {
    prepare: (id) => lifecycleCalls.push(`prepare:${id}`),
    submit: (id) => lifecycleCalls.push(`submit:${id}`),
    recordConsensusOpen: (id) => lifecycleCalls.push(`open:${id}`),
  };
  const path = join(scratch, "preparations.db");
  const service = (store: SqliteSolanaLocalPreparedExecutionStore) => new SolanaLocalExecutionService({
    manifest,
    intents: {} as never,
    orders: {} as never,
    authorization: { authorize: async (attemptId) => ({
      version: 1, attemptId, executionDigest: Buffer.from(executionDigest).toString("hex"),
      solverSignature: "11".repeat(64),
    }) },
    adapter,
    rpc,
    store,
    lifecycle,
    validateLive: async () => undefined,
    selectedAdmission: () => admission,
  });
  const signPrepared = (prepared: { unsignedTransactionBase64: string }) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
    transaction.signatures[0] = sign(null, Buffer.from(transaction.message.serialize()), traderKeys.privateKey);
    return Buffer.from(transaction.serialize()).toString("base64");
  };
  return {
    path,
    service,
    signPrepared,
    lifecycleCalls,
    setStatus: (value: typeof status) => { status = value; },
    setLoseResponse: (value: boolean) => { loseResponse = value; },
  };
}

test("prepares a trader-bound entry and rejects a tampered signed envelope", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-solana-local-execution-"));
  const setup = fixture(scratch);
  const store = new SqliteSolanaLocalPreparedExecutionStore(setup.path);
  try {
    const attemptId = `local-atomic-${"44".repeat(32)}`;
    const prepared = await setup.service(store).prepare(attemptId);
    const tampered = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransactionBase64, "base64"));
    tampered.message.recentBlockhash = key(31).toBase58();
    await assert.rejects(
      setup.service(store).submit(attemptId, { signedTransactionBase64: Buffer.from(tampered.serialize()).toString("base64") }),
      /does not match the durable preparation/,
    );
    assert.equal(store.get(attemptId)?.status, "PREPARED");
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("submits and verifies a successful local entry", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-solana-local-success-"));
  const setup = fixture(scratch);
  const store = new SqliteSolanaLocalPreparedExecutionStore(setup.path);
  try {
    const attemptId = `local-atomic-${"66".repeat(32)}`;
    const prepared = await setup.service(store).prepare(attemptId);
    setup.setStatus({ confirmationStatus: "confirmed", err: null });
    const result = await setup.service(store).submit(attemptId, {
      signedTransactionBase64: setup.signPrepared(prepared),
    });
    assert.equal(result.status, "CONSENSUS_VERIFIED");
    assert.equal(store.get(attemptId)?.status, "CONSENSUS_VERIFIED");
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("reconciles response loss across restart without resubmitting", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-solana-local-reconcile-"));
  const setup = fixture(scratch);
  const attemptId = `local-atomic-${"55".repeat(32)}`;
  let store = new SqliteSolanaLocalPreparedExecutionStore(setup.path);
  try {
    const service = setup.service(store);
    const prepared = await service.prepare(attemptId);
    setup.setLoseResponse(true);
    const ambiguous = await service.submit(attemptId, { signedTransactionBase64: setup.signPrepared(prepared) });
    assert.equal(ambiguous.status, "SUBMITTED_UNKNOWN");
    store.close();

    store = new SqliteSolanaLocalPreparedExecutionStore(setup.path);
    setup.setStatus({ confirmationStatus: "confirmed", err: null });
    const reconciled = await setup.service(store).reconcile(attemptId);
    assert.equal(reconciled.status, "CONSENSUS_VERIFIED");
    assert.equal(store.get(attemptId)?.status, "CONSENSUS_VERIFIED");
    assert.deepEqual(setup.lifecycleCalls.map((value) => value.split(":", 1)[0]), ["prepare", "submit", "open"]);
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

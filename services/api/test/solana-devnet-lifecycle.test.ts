import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import bs58 from "bs58";
import type { DomainRef, PackageAdmission } from "@naryx/protocol-types";
import type {
  FirmCashCarryBinding,
  SolanaMaterializationRequest,
  UnsignedSolanaMaterialization,
} from "@naryx/adapter-solana";
import {
  createSolanaDevnetExecutionPorts,
  deriveSolanaDevnetLifecycleBinding,
  InMemoryPreparedSolanaDevnetStore,
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaDevnetLifecycleStoreRecorder,
  SqlitePackageLifecycleStore,
} from "../src/index.js";

const TEMPLATE_MESSAGE_BASE64 = "gAEAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAA=";

function buildMessage(traderBytes: Uint8Array, blockhashBytes: Uint8Array): Buffer {
  const out = Buffer.from(TEMPLATE_MESSAGE_BASE64, "base64");
  Buffer.from(traderBytes).copy(out, 5);
  Buffer.from(blockhashBytes).copy(out, 5 + 32);
  return out;
}

function buildTransaction(message: Buffer): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 0), message]);
}

function setupTrader() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawTrader = Uint8Array.from(
    (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32),
  );
  const trader = bs58.encode(rawTrader);
  return { rawTrader, trader, privateKey };
}

function makeDomain(): DomainRef {
  return {
    domainId: "svm:devnet",
    domainManifestVersion: 1,
    domainManifestHash: Uint8Array.from(Buffer.from("11".repeat(32), "hex")),
  } as unknown as DomainRef;
}

function entryOrderHex(): string {
  return "33".repeat(32);
}

function secondEntryOrderHex(): string {
  return "34".repeat(32);
}

function makeEntryAdmission(domain: DomainRef, orderHex: string): PackageAdmission {
  return {
    order: {
      environment: "devnet",
      domain,
      settlementClass: "ATOMIC_POSTCONDITION",
      action: "ENTRY",
    },
    quote: { environment: "devnet", domain },
    route: { environment: "devnet", domain },
    orderHash: Uint8Array.from(Buffer.from(orderHex, "hex")),
  } as unknown as PackageAdmission;
}

function makeExitAdmission(domain: DomainRef): PackageAdmission {
  return {
    order: {
      environment: "devnet",
      domain,
      settlementClass: "ATOMIC_POSTCONDITION",
      action: "ENTRY",
    },
    quote: { environment: "devnet", domain },
    route: { environment: "devnet", domain },
    orderHash: Uint8Array.from(Buffer.from("44".repeat(32), "hex")),
  } as unknown as PackageAdmission;
}

function makeEntryBinding(domain: DomainRef): FirmCashCarryBinding {
  return {
    environment: "devnet",
    domain,
  } as unknown as FirmCashCarryBinding;
}

function makeExitBinding(
  domain: DomainRef,
  entryHex: string,
  exitDomain: DomainRef | undefined = undefined,
  settlementClass: string | undefined = undefined,
): FirmCashCarryBinding {
  const publicDomain = exitDomain ?? domain;
  return {
    environment: "devnet",
    domain,
    publicExit: {
      admission: {
        order: {
          environment: "devnet",
          domain: publicDomain,
          settlementClass: settlementClass ?? "ATOMIC_POSTCONDITION",
          action: "EXIT",
        },
        quote: { environment: "devnet", domain: publicDomain },
        route: { environment: "devnet", domain: publicDomain },
        orderHash: Uint8Array.from(Buffer.from("44".repeat(32), "hex")),
      },
      activeDomain: publicDomain,
      entryReceipt: {
        orderHash: Uint8Array.from(Buffer.from(entryHex, "hex")),
      },
    },
  } as unknown as FirmCashCarryBinding;
}

function makeMaterializer(
  trader: string,
  entryMessage: Buffer,
  entryTransactionBase64: string,
  entryMessageBase64: string,
  entryBlockhash: string,
  exitMessage: Buffer,
  exitTransactionBase64: string,
  exitMessageBase64: string,
  exitBlockhash: string,
) {
  return {
    materialize: async (
      input: SolanaMaterializationRequest,
    ): Promise<UnsignedSolanaMaterialization> => {
      const isExit = input.planKind === "TRADER_RECOVERY_EXIT";
      const message = isExit ? exitMessage : entryMessage;
      const messageBase64 = isExit ? exitMessageBase64 : entryMessageBase64;
      const transactionBase64 = isExit ? exitTransactionBase64 : entryTransactionBase64;
      const blockhash = isExit ? exitBlockhash : entryBlockhash;
      const domain = (input.admission as unknown as { order: { domain: DomainRef } }).order.domain;
      return Object.freeze({
        domain,
        planKind: input.planKind,
        messageBytes: Uint8Array.from(message),
        messageBase64,
        transactionBytes: Uint8Array.from(Buffer.from(transactionBase64, "base64")),
        transactionBase64,
        requiredSignerPubkeys: Object.freeze([trader]),
        recentBlockhash: blockhash,
        blockhashContextSlot: 100,
        lastValidBlockHeight: 250,
        genesisHash: SOLANA_DEVNET_GENESIS_HASH,
        lookupTables: Object.freeze([]),
        evidence: Object.freeze({
          resolvedAddressCount: 1,
          serializedMessageBytes: message.length,
          serializedTransactionBytes: Buffer.from(transactionBase64, "base64").length,
          packetDataLimit: 1232,
          computeUnitLimit: 200000,
          computeUnitLimitSource: "EXPLICIT",
          routeComputeUnitLimit: 1260000,
        }),
        requestCommitment: Uint8Array.from(Buffer.from("22".repeat(32), "hex")),
      }) as UnsignedSolanaMaterialization;
    },
  };
}

function withTempLifecycleStore(fn: (dbPath: string) => Promise<void>): Promise<void> {
  return (async () => {
    const scratch = mkdtempSync(join(tmpdir(), "naryx-solana-lifecycle-"));
    const dbPath = join(scratch, "lifecycle.db");
    try {
      await fn(dbPath);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
}

test("entry prepare creates two receipts with durable attempt id", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const { rawTrader, trader, privateKey } = setupTrader();
    void privateKey;
    const domain = makeDomain();
    const orderHex = entryOrderHex();
    const expectedAttempt = `solana-cash-carry-${orderHex}`;
    const blockhashBytes = Buffer.alloc(32, 2);
    const message = buildMessage(rawTrader, blockhashBytes);
    const messageBase64 = message.toString("base64");
    const transactionBase64 = buildTransaction(message).toString("base64");
    const blockhash = bs58.encode(blockhashBytes);
    const exitMessage = buildMessage(rawTrader, Buffer.alloc(32, 9));
    const exitMessageBase64 = exitMessage.toString("base64");
    const exitTransactionBase64 = buildTransaction(exitMessage).toString("base64");
    const exitBlockhash = bs58.encode(Buffer.alloc(32, 9));
    const entryAdmission = makeEntryAdmission(domain, orderHex);
    const exitAdmission = makeExitAdmission(domain);
    const entryBinding = makeEntryBinding(domain);
    const exitBinding = makeExitBinding(domain, orderHex);
    const rpc = {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getSignatureStatus: async () => null,
      getBlockHeight: async () => 100,
    };
    const preparedStore = new InMemoryPreparedSolanaDevnetStore();
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
      const ports = createSolanaDevnetExecutionPorts({
        contextProvider: (request) =>
          request.mode === "entry"
            ? { admission: entryAdmission, binding: entryBinding }
            : { admission: exitAdmission, binding: exitBinding },
        materializer: makeMaterializer(
          trader,
          message,
          transactionBase64,
          messageBase64,
          blockhash,
          exitMessage,
          exitTransactionBase64,
          exitMessageBase64,
          exitBlockhash,
        ),
        store: preparedStore,
        rpc,
        lifecycleRecorder: recorder,
      });
      const request = Object.freeze({
        domain: "svm:devnet",
        mode: "entry",
        sizeAtoms: "1000000",
        slippageBps: 10,
        quoteMode: "coordinated_limits",
        traderPublicKey: trader,
        idempotencyKey: "test-lifecycle-entry-0001",
      });
      const prepared = await ports.preparation!.prepare(request as never);
      assert.equal(prepared.lifecycleAttemptId, expectedAttempt);
      const stored = preparedStore.get("test-lifecycle-entry-0001");
      assert.ok(stored !== undefined);
      assert.equal(stored.lifecycleBinding.attemptId, expectedAttempt);
      assert.equal(stored.lifecycleBinding.packageId, expectedAttempt);
      assert.equal(stored.lifecycleBinding.packageCommitmentHex, orderHex);
      assert.equal(stored.lifecycleBinding.action, "ENTRY");
      const receipts = lifecycleStore.listReceipts(expectedAttempt, 0n, 100);
      assert.equal(receipts.length, 2);
      assert.equal(receipts[0]!.nextState, "PACKAGE_CREATED");
      assert.equal(receipts[0]!.evidenceGrade, "LOCAL_RECORDED");
      assert.equal(receipts[1]!.nextState, "ENTRY_PREPARED");
      assert.equal(receipts[1]!.evidenceGrade, "CONTROLLER_ATTESTED");
      for (const receipt of receipts) {
        assert.equal(receipt.onchainEnforced, false);
        assert.equal(receipt.packageId, expectedAttempt);
        assert.equal(receipt.attemptId, expectedAttempt);
      }
      const head = lifecycleStore.getAttempt(expectedAttempt);
      assert.ok(head !== undefined);
      assert.equal(head.state, "ENTRY_PREPARED");
      const replayed = await ports.preparation!.prepare(request as never);
      assert.deepEqual(replayed, prepared);
      assert.equal(lifecycleStore.listReceipts(expectedAttempt, 0n, 100).length, 2);
    } finally {
      lifecycleStore.close();
    }
  });
});

test("direct finalization creates submitted plus confirmed but not OPEN", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const { rawTrader, trader, privateKey } = setupTrader();
    const domain = makeDomain();
    const orderHex = entryOrderHex();
    const expectedAttempt = `solana-cash-carry-${orderHex}`;
    const blockhashBytes = Buffer.alloc(32, 2);
    const message = buildMessage(rawTrader, blockhashBytes);
    const messageBase64 = message.toString("base64");
    const transactionBase64 = buildTransaction(message).toString("base64");
    const blockhash = bs58.encode(blockhashBytes);
    const signature = bs58.encode(sign(null, message, privateKey));
    const exitMessage = buildMessage(rawTrader, Buffer.alloc(32, 9));
    const rpc = {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getSignatureStatus: async () => Object.freeze({ slot: 300, confirmationStatus: "finalized", err: null }),
      getBlockHeight: async () => 100,
    };
    const preparedStore = new InMemoryPreparedSolanaDevnetStore();
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
      const entryAdmission = makeEntryAdmission(domain, orderHex);
      const exitAdmission = makeExitAdmission(domain);
      const entryBinding = makeEntryBinding(domain);
      const exitBinding = makeExitBinding(domain, orderHex);
      const ports = createSolanaDevnetExecutionPorts({
        contextProvider: (request) =>
          request.mode === "entry"
            ? { admission: entryAdmission, binding: entryBinding }
            : { admission: exitAdmission, binding: exitBinding },
        materializer: makeMaterializer(
          trader,
          message,
          transactionBase64,
          messageBase64,
          blockhash,
          exitMessage,
          buildTransaction(exitMessage).toString("base64"),
          exitMessage.toString("base64"),
          bs58.encode(Buffer.alloc(32, 9)),
        ),
        store: preparedStore,
        rpc,
        lifecycleRecorder: recorder,
      });
      const key = "test-lifecycle-final-0001";
      await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "entry",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: key,
        }) as never,
      );
      const observed = await ports.observation!.observe({ idempotencyKey: key, signature });
      assert.equal(observed.lifecycle, "FINALIZED");
      const receipts = lifecycleStore.listReceipts(expectedAttempt, 0n, 100);
      assert.deepEqual(
        receipts.map((entry) => entry.nextState),
        ["PACKAGE_CREATED", "ENTRY_PREPARED", "ENTRY_SUBMITTED", "ENTRY_CONFIRMED"],
      );
      assert.equal(receipts[2]!.evidenceGrade, "CONTROLLER_ATTESTED");
      assert.equal(receipts[3]!.evidenceGrade, "CONSENSUS_VERIFIED");
      const replayed = await ports.observation!.observe({ idempotencyKey: key, signature });
      assert.deepEqual(replayed, observed);
      assert.equal(lifecycleStore.listReceipts(expectedAttempt, 0n, 100).length, 4);
    } finally {
      lifecycleStore.close();
    }
  });
});

test("entry failed and expired observations are terminal", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      for (const [suffix, orderHex, makeRpc, check] of [
        [
          "fail",
          entryOrderHex(),
          () => ({
            getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
            getSignatureStatus: async () =>
              Object.freeze({ slot: 310, confirmationStatus: "confirmed", err: { code: 1 } }),
            getBlockHeight: async () => 100,
          }),
          (receipts: readonly { nextState: string; evidenceGrade: string }[]) => {
            assert.equal(receipts[receipts.length - 1]!.nextState, "FAILED");
            assert.equal(receipts[receipts.length - 1]!.evidenceGrade, "VENUE_CORROBORATED");
          },
        ],
        [
          "expire",
          secondEntryOrderHex(),
          () => ({
            getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
            getSignatureStatus: async () => null,
            getBlockHeight: async () => 500,
          }),
          (receipts: readonly { nextState: string; evidenceGrade: string }[]) => {
            assert.equal(receipts[receipts.length - 1]!.nextState, "EXPIRED");
            assert.equal(receipts[receipts.length - 1]!.evidenceGrade, "CONTROLLER_ATTESTED");
          },
        ],
      ] as const) {
        const { rawTrader, trader, privateKey } = setupTrader();
        const domain = makeDomain();
        const expectedAttempt = `solana-cash-carry-${orderHex}`;
        const blockhashBytes = Buffer.alloc(32, 2);
        const message = buildMessage(rawTrader, blockhashBytes);
        const messageBase64 = message.toString("base64");
        const transactionBase64 = buildTransaction(message).toString("base64");
        const blockhash = bs58.encode(blockhashBytes);
        const signature = bs58.encode(sign(null, message, privateKey));
        const exitMessage = buildMessage(rawTrader, Buffer.alloc(32, 9));
        const preparedStore = new InMemoryPreparedSolanaDevnetStore();
        const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
        const entryAdmission = makeEntryAdmission(domain, orderHex);
        const exitAdmission = makeExitAdmission(domain);
        const entryBinding = makeEntryBinding(domain);
        const exitBinding = makeExitBinding(domain, orderHex);
        const ports = createSolanaDevnetExecutionPorts({
          contextProvider: (request) =>
            request.mode === "entry"
              ? { admission: entryAdmission, binding: entryBinding }
              : { admission: exitAdmission, binding: exitBinding },
          materializer: makeMaterializer(
            trader,
            message,
            transactionBase64,
            messageBase64,
            blockhash,
            exitMessage,
            buildTransaction(exitMessage).toString("base64"),
            exitMessage.toString("base64"),
            bs58.encode(Buffer.alloc(32, 9)),
          ),
          store: preparedStore,
          rpc: makeRpc() as never,
          lifecycleRecorder: recorder,
        });
        const key = `test-lifecycle-${suffix}-0001`;
        await ports.preparation!.prepare(
          Object.freeze({
            domain: "svm:devnet",
            mode: "entry",
            sizeAtoms: "1000000",
            slippageBps: 10,
            quoteMode: "coordinated_limits",
            traderPublicKey: trader,
            idempotencyKey: key,
          }) as never,
        );
        const observed = await ports.observation!.observe({ idempotencyKey: key, signature });
        const receipts = lifecycleStore.listReceipts(expectedAttempt, 0n, 100);
        check(receipts as never);
        assert.ok(observed.lifecycle === "FAILED" || observed.lifecycle === "EXPIRED");
        const replayed = await ports.observation!.observe({ idempotencyKey: key, signature });
        assert.deepEqual(replayed, observed);
        assert.equal(
          lifecycleStore.listReceipts(expectedAttempt, 0n, 100).length,
          receipts.length,
        );
      }
    } finally {
      lifecycleStore.close();
    }
  });
});

test("exit is rejected before OPEN and binding mismatch fails closed", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const { rawTrader, trader, privateKey } = setupTrader();
    void privateKey;
    const domain = makeDomain();
    const orderHex = entryOrderHex();
    const expectedAttempt = `solana-cash-carry-${orderHex}`;
    const blockhashBytes = Buffer.alloc(32, 2);
    const message = buildMessage(rawTrader, blockhashBytes);
    const messageBase64 = message.toString("base64");
    const transactionBase64 = buildTransaction(message).toString("base64");
    const blockhash = bs58.encode(blockhashBytes);
    const exitMessage = buildMessage(rawTrader, Buffer.alloc(32, 7));
    const exitMessageBase64 = exitMessage.toString("base64");
    const exitTransactionBase64 = buildTransaction(exitMessage).toString("base64");
    const exitBlockhash = bs58.encode(Buffer.alloc(32, 7));
    const entryAdmission = makeEntryAdmission(domain, orderHex);
    const exitAdmission = makeExitAdmission(domain);
    const entryBinding = makeEntryBinding(domain);
    const exitBinding = makeExitBinding(domain, orderHex);
    const rpc = {
      getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
      getSignatureStatus: async () => null,
      getBlockHeight: async () => 100,
    };
    const preparedStore = new InMemoryPreparedSolanaDevnetStore();
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
      const ports = createSolanaDevnetExecutionPorts({
        contextProvider: (request) =>
          request.mode === "entry"
            ? { admission: entryAdmission, binding: entryBinding }
            : { admission: exitAdmission, binding: exitBinding },
        materializer: makeMaterializer(
          trader,
          message,
          transactionBase64,
          messageBase64,
          blockhash,
          exitMessage,
          exitTransactionBase64,
          exitMessageBase64,
          exitBlockhash,
        ),
        store: preparedStore,
        rpc,
        lifecycleRecorder: recorder,
      });
      await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "entry",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: "test-lifecycle-exit-reject-entry",
        }) as never,
      );
      await assert.rejects(
        ports.preparation!.prepare(
          Object.freeze({
            domain: "svm:devnet",
            mode: "exit",
            sizeAtoms: "1000000",
            slippageBps: 10,
            quoteMode: "coordinated_limits",
            traderPublicKey: trader,
            idempotencyKey: "test-lifecycle-exit-reject-exit",
          }) as never,
        ),
      );
      const stored = preparedStore.get("test-lifecycle-exit-reject-entry")!;
      const tampered = Object.freeze({
        ...stored,
        lifecycleBinding: Object.freeze({
          ...stored.lifecycleBinding,
          packageCommitmentHex: "44".repeat(32),
        }),
      }) as never;
      assert.throws(() => recorder.recordPrepared(tampered as never));
      assert.equal(lifecycleStore.listReceipts(expectedAttempt, 0n, 100).length, 2);
    } finally {
      lifecycleStore.close();
    }
  });
});

test("verified postconditions promote finalized entry and exit exactly once", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const { rawTrader, trader, privateKey } = setupTrader();
    const domain = makeDomain();
    const orderHex = entryOrderHex();
    const expectedAttempt = `solana-cash-carry-${orderHex}`;
    const blockhashBytes = Buffer.alloc(32, 2);
    const entryMessage = buildMessage(rawTrader, blockhashBytes);
    const entryMessageBase64 = entryMessage.toString("base64");
    const entryTransactionBase64 = buildTransaction(entryMessage).toString("base64");
    const entryBlockhash = bs58.encode(blockhashBytes);
    const entrySignature = bs58.encode(sign(null, entryMessage, privateKey));
    const exitBlockhashBytes = Buffer.alloc(32, 7);
    const exitMessage = buildMessage(rawTrader, exitBlockhashBytes);
    const exitMessageBase64 = exitMessage.toString("base64");
    const exitTransactionBase64 = buildTransaction(exitMessage).toString("base64");
    const exitBlockhash = bs58.encode(exitBlockhashBytes);
    const exitSignature = bs58.encode(sign(null, exitMessage, privateKey));
    const entryAdmission = makeEntryAdmission(domain, orderHex);
    const exitAdmission = makeExitAdmission(domain);
    const entryBinding = makeEntryBinding(domain);
    const exitBinding = makeExitBinding(domain, orderHex);
    const preparedStore = new InMemoryPreparedSolanaDevnetStore();
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
      let rpcMode: "finalized" | "failed" | "submitted" = "finalized";
      const rpc = {
        getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
        getSignatureStatus: async (signature: string) => {
          if (signature === entrySignature) {
            return Object.freeze({ slot: 300, confirmationStatus: "finalized", err: null });
          }
          if (signature === exitSignature) {
            if (rpcMode === "finalized") {
              return Object.freeze({ slot: 400, confirmationStatus: "finalized", err: null });
            }
            if (rpcMode === "failed") {
              return Object.freeze({ slot: 410, confirmationStatus: "confirmed", err: { code: 1 } });
            }
            return Object.freeze({ slot: 401, confirmationStatus: "confirmed", err: null });
          }
          return null;
        },
        getBlockHeight: async () => 100,
      };
      const ports = createSolanaDevnetExecutionPorts({
        contextProvider: (request) =>
          request.mode === "entry"
            ? { admission: entryAdmission, binding: entryBinding }
            : { admission: exitAdmission, binding: exitBinding },
        materializer: makeMaterializer(
          trader,
          entryMessage,
          entryTransactionBase64,
          entryMessageBase64,
          entryBlockhash,
          exitMessage,
          exitTransactionBase64,
          exitMessageBase64,
          exitBlockhash,
        ),
        store: preparedStore,
        rpc,
        lifecycleRecorder: recorder,
      });
      const entryKey = "test-lifecycle-exit-open-entry";
      await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "entry",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: entryKey,
        }) as never,
      );
      await ports.observation!.observe({ idempotencyKey: entryKey, signature: entrySignature });
      const headBeforeOpen = lifecycleStore.getAttempt(expectedAttempt)!;
      assert.equal(headBeforeOpen.state, "ENTRY_CONFIRMED");
      const entryRecord = preparedStore.get(entryKey)!;
      assert.throws(() => recorder.recordPostcondition(entryRecord, {
        action: "EXIT",
        finalizedSlot: 300,
        accountContextSlot: 301,
        receiptDataHashHex: "aa".repeat(32),
        openPackageDataHashHex: null,
      }));
      const entryProof = {
        action: "ENTRY" as const,
        finalizedSlot: 300,
        accountContextSlot: 301,
        receiptDataHashHex: "aa".repeat(32),
        openPackageDataHashHex: "bb".repeat(32),
      };
      recorder.recordPostcondition(entryRecord, entryProof);
      recorder.recordPostcondition(entryRecord, entryProof);
      assert.equal(lifecycleStore.getAttempt(expectedAttempt)!.state, "OPEN");
      const exitKey = "test-lifecycle-exit-open-exit";
      const exitPrepared = await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "exit",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: exitKey,
        }) as never,
      );
      assert.equal(exitPrepared.lifecycleAttemptId, expectedAttempt);
      assert.equal(lifecycleStore.getAttempt(expectedAttempt)!.state, "EXIT_REQUESTED");
      const exitReplayed = await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "exit",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: exitKey,
        }) as never,
      );
      assert.deepEqual(exitReplayed, exitPrepared);
      rpcMode = "finalized";
      const finalized = await ports.observation!.observe({ idempotencyKey: exitKey, signature: exitSignature });
      assert.equal(finalized.lifecycle, "FINALIZED");
      const afterFinalized = lifecycleStore.getAttempt(expectedAttempt)!;
      assert.equal(afterFinalized.state, "EXIT_SUBMITTED");
      const states = lifecycleStore.listReceipts(expectedAttempt, 0n, 100).map((entry) => entry.nextState);
      assert.ok(!states.includes("CLOSED"));
      const exitRecord = preparedStore.get(exitKey)!;
      const exitProof = {
        action: "EXIT" as const,
        finalizedSlot: 400,
        accountContextSlot: 402,
        receiptDataHashHex: "cc".repeat(32),
        openPackageDataHashHex: null,
      };
      recorder.recordPostcondition(exitRecord, exitProof);
      recorder.recordPostcondition(exitRecord, exitProof);
      const closed = lifecycleStore.getAttempt(expectedAttempt)!;
      assert.equal(closed.state, "CLOSED");
      const closedReceipt = lifecycleStore.listReceipts(expectedAttempt, closed.revision - 1n, 1)[0]!;
      assert.equal(closedReceipt.evidenceGrade, "CONSENSUS_VERIFIED");
      assert.equal(closedReceipt.onchainEnforced, true);
    } finally {
      lifecycleStore.close();
    }
  });
});

test("exit expiry reaches recovery pending and never closes", async () => {
  await withTempLifecycleStore(async (dbPath) => {
    const { rawTrader, trader, privateKey } = setupTrader();
    const domain = makeDomain();
    const orderHex = secondEntryOrderHex();
    const expectedAttempt = `solana-cash-carry-${orderHex}`;
    const entryMessage = buildMessage(rawTrader, Buffer.alloc(32, 2));
    const entrySignature = bs58.encode(sign(null, entryMessage, privateKey));
    const exitMessage = buildMessage(rawTrader, Buffer.alloc(32, 7));
    const exitSignature = bs58.encode(sign(null, exitMessage, privateKey));
    const entryAdmission = makeEntryAdmission(domain, orderHex);
    const exitAdmission = makeExitAdmission(domain);
    const entryBinding = makeEntryBinding(domain);
    const exitBinding = makeExitBinding(domain, orderHex);
    const preparedStore = new InMemoryPreparedSolanaDevnetStore();
    const lifecycleStore = new SqlitePackageLifecycleStore(dbPath);
    try {
      const recorder = new SolanaDevnetLifecycleStoreRecorder(lifecycleStore);
      const rpc = {
        getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
        getSignatureStatus: async (signature: string) => {
          if (signature === entrySignature) {
            return Object.freeze({ slot: 300, confirmationStatus: "finalized", err: null });
          }
          return null;
        },
        getBlockHeight: async () => 500,
      };
      const ports = createSolanaDevnetExecutionPorts({
        contextProvider: (request) =>
          request.mode === "entry"
            ? { admission: entryAdmission, binding: entryBinding }
            : { admission: exitAdmission, binding: exitBinding },
        materializer: makeMaterializer(
          trader,
          entryMessage,
          buildTransaction(entryMessage).toString("base64"),
          entryMessage.toString("base64"),
          bs58.encode(Buffer.alloc(32, 2)),
          exitMessage,
          buildTransaction(exitMessage).toString("base64"),
          exitMessage.toString("base64"),
          bs58.encode(Buffer.alloc(32, 7)),
        ),
        store: preparedStore,
        rpc,
        lifecycleRecorder: recorder,
      });
      const entryKey = "test-lifecycle-exit-expiry-entry";
      await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "entry",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: entryKey,
        }) as never,
      );
      await ports.observation!.observe({ idempotencyKey: entryKey, signature: entrySignature });
      const head = lifecycleStore.getAttempt(expectedAttempt)!;
      lifecycleStore.recordEvent({
        version: 1,
        domain,
        settlementClass: "ATOMIC_POSTCONDITION",
        packageId: expectedAttempt,
        packageCommitment: orderHex,
        attemptId: expectedAttempt,
        eventId: "seed-open-002",
        expectedRevision: head.revision,
        nextState: "OPEN",
        evidenceGrade: "CONSENSUS_VERIFIED",
        onchainEnforced: false,
        evidenceSource: {
          subjectId: domain.domainId,
          manifestVersion: domain.domainManifestVersion,
          manifestHash: Uint8Array.from(domain.domainManifestHash) as unknown as import("@naryx/protocol-types").ManifestHash,
        },
        evidenceCommitment: "ab".repeat(32),
      });
      const exitKey = "test-lifecycle-exit-expiry-exit";
      await ports.preparation!.prepare(
        Object.freeze({
          domain: "svm:devnet",
          mode: "exit",
          sizeAtoms: "1000000",
          slippageBps: 10,
          quoteMode: "coordinated_limits",
          traderPublicKey: trader,
          idempotencyKey: exitKey,
        }) as never,
      );
      const expired = await ports.observation!.observe({ idempotencyKey: exitKey, signature: exitSignature });
      assert.equal(expired.lifecycle, "EXPIRED");
      assert.equal(lifecycleStore.getAttempt(expectedAttempt)!.state, "RECOVERY_PENDING");
      const states = lifecycleStore.listReceipts(expectedAttempt, 0n, 100).map((entry) => entry.nextState);
      assert.ok(!states.includes("CLOSED"));
      assert.ok(!states.includes("FAILED"));
    } finally {
      lifecycleStore.close();
    }
  });
});

test("exit lifecycle binding uses public exit admission domain and settlement", () => {
  const topDomain = makeDomain();
  const exitDomain = {
    domainId: "svm:devnet",
    domainManifestVersion: 2,
    domainManifestHash: Uint8Array.from(Buffer.from("22".repeat(32), "hex")),
  } as unknown as DomainRef;
  const entryHex = entryOrderHex();
  const topAdmission = makeExitAdmission(topDomain);
  assert.equal(
    (topAdmission as unknown as { order: { action: string } }).order.action,
    "ENTRY",
  );
  const binding = makeExitBinding(topDomain, entryHex, exitDomain, "BATCHED_IOC_WITH_RECOVERY");
  assert.equal(
    (binding as unknown as { publicExit: { admission: { order: { action: string } } } }).publicExit.admission.order.action,
    "EXIT",
  );
  const result = deriveSolanaDevnetLifecycleBinding({
    request: { mode: "exit" } as never,
    admission: topAdmission,
    binding,
  });
  assert.equal(result.action, "EXIT");
  assert.equal(result.packageCommitmentHex, entryHex);
  assert.equal(result.attemptId, `solana-cash-carry-${entryHex}`);
  assert.equal(result.packageId, `solana-cash-carry-${entryHex}`);
  assert.equal(result.domain.domainId, "svm:devnet");
  assert.equal(result.domain.domainManifestVersion, 2);
  assert.deepEqual(
    Uint8Array.from(result.domain.domainManifestHash),
    Uint8Array.from(Buffer.from("22".repeat(32), "hex")),
  );
  assert.equal(result.settlementClass, "BATCHED_IOC_WITH_RECOVERY");
  assert.equal(result.evidenceSource.manifestVersion, 2);
});

test("exit lifecycle binding rejects top-level EXIT and non-EXIT public exit order", () => {
  const domain = makeDomain();
  const entryHex = entryOrderHex();
  const entryTopAdmission = makeExitAdmission(domain);
  const exitTopAdmission = {
    order: {
      environment: "devnet",
      domain,
      settlementClass: "ATOMIC_POSTCONDITION",
      action: "EXIT",
    },
    quote: { environment: "devnet", domain },
    route: { environment: "devnet", domain },
    orderHash: Uint8Array.from(Buffer.from("44".repeat(32), "hex")),
  } as unknown as PackageAdmission;
  const validBinding = makeExitBinding(domain, entryHex);
  assert.throws(
    () =>
      deriveSolanaDevnetLifecycleBinding({
        request: { mode: "exit" } as never,
        admission: exitTopAdmission,
        binding: validBinding,
      }),
    /Admission order action does not match exit request/,
  );
  const entryExitBinding = {
    environment: "devnet",
    domain,
    publicExit: {
      admission: {
        order: {
          environment: "devnet",
          domain,
          settlementClass: "ATOMIC_POSTCONDITION",
          action: "ENTRY",
        },
        quote: { environment: "devnet", domain },
        route: { environment: "devnet", domain },
        orderHash: Uint8Array.from(Buffer.from("44".repeat(32), "hex")),
      },
      activeDomain: domain,
      entryReceipt: {
        orderHash: Uint8Array.from(Buffer.from(entryHex, "hex")),
      },
    },
  } as unknown as FirmCashCarryBinding;
  assert.throws(
    () =>
      deriveSolanaDevnetLifecycleBinding({
        request: { mode: "exit" } as never,
        admission: entryTopAdmission,
        binding: entryExitBinding,
      }),
    /Public exit admission order action does not match exit request/,
  );
});

test("exit lifecycle binding rejects public exit active domain mismatch", () => {
  const topDomain = makeDomain();
  const exitDomain = {
    domainId: "svm:devnet",
    domainManifestVersion: 2,
    domainManifestHash: Uint8Array.from(Buffer.from("22".repeat(32), "hex")),
  } as unknown as DomainRef;
  const mismatchedActive = {
    domainId: "svm:testnet",
    domainManifestVersion: 2,
    domainManifestHash: Uint8Array.from(Buffer.from("22".repeat(32), "hex")),
  } as unknown as DomainRef;
  const entryHex = entryOrderHex();
  const topAdmission = makeExitAdmission(topDomain);
  const binding = {
    environment: "devnet",
    domain: topDomain,
    publicExit: {
      admission: {
        order: {
          environment: "devnet",
          domain: exitDomain,
          settlementClass: "ATOMIC_POSTCONDITION",
          action: "EXIT",
        },
        quote: { environment: "devnet", domain: exitDomain },
        route: { environment: "devnet", domain: exitDomain },
        orderHash: Uint8Array.from(Buffer.from("44".repeat(32), "hex")),
      },
      activeDomain: mismatchedActive,
      entryReceipt: {
        orderHash: Uint8Array.from(Buffer.from(entryHex, "hex")),
      },
    },
  } as unknown as FirmCashCarryBinding;
  assert.throws(
    () =>
      deriveSolanaDevnetLifecycleBinding({
        request: { mode: "exit" } as never,
        admission: topAdmission,
        binding,
      }),
    /active domain/,
  );
});

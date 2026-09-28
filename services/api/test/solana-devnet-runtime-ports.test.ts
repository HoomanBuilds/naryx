import assert from "node:assert/strict";
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
  InMemoryPreparedSolanaDevnetStore,
  SOLANA_DEVNET_GENESIS_HASH,
} from "../src/index.js";

const TEMPLATE_MESSAGE_BASE64 = "gAEAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAA=";

function canonicalSignature(fill: number): string {
  return bs58.encode(Buffer.alloc(64, fill));
}

function buildMessage(traderBytes: Uint8Array, blockhashBytes: Uint8Array): Buffer {
  const out = Buffer.from(TEMPLATE_MESSAGE_BASE64, "base64");
  Buffer.from(traderBytes).copy(out, 5);
  Buffer.from(blockhashBytes).copy(out, 5 + 32);
  return out;
}

function buildTransaction(message: Buffer): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 0), message]);
}

test("solana devnet runtime prepares once and observes with bound signatures", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawTrader = Uint8Array.from(
    (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32),
  );
  const TRADER_PUBLIC_KEY = bs58.encode(rawTrader);
  const firstBlockhashBytes = Buffer.alloc(32, 2);
  const secondBlockhashBytes = Buffer.alloc(32, 3);
  const firstMessage = buildMessage(rawTrader, firstBlockhashBytes);
  const secondMessage = buildMessage(rawTrader, secondBlockhashBytes);
  const FIRST_MESSAGE_BASE64 = firstMessage.toString("base64");
  const FIRST_TRANSACTION_BASE64 = buildTransaction(firstMessage).toString("base64");
  const SECOND_MESSAGE_BASE64 = secondMessage.toString("base64");
  const SECOND_TRANSACTION_BASE64 = buildTransaction(secondMessage).toString("base64");
  const FIRST_RECENT_BLOCKHASH = bs58.encode(firstBlockhashBytes);
  const SECOND_RECENT_BLOCKHASH = bs58.encode(secondBlockhashBytes);
  const signatureA = bs58.encode(sign(null, firstMessage, privateKey));
  const signatureC = bs58.encode(sign(null, secondMessage, privateKey));
  assert.notEqual(signatureA, signatureC);

  const firstKey = "test-devnet-key-0001";
  const secondKey = "test-devnet-key-0002";
  const firstRequest = Object.freeze({
    domain: "svm:devnet",
    mode: "entry",
    sizeAtoms: "1000000",
    slippageBps: 10,
    quoteMode: "coordinated_limits",
    traderPublicKey: TRADER_PUBLIC_KEY,
    idempotencyKey: firstKey,
  });
  const secondRequest = Object.freeze({
    domain: "svm:devnet",
    mode: "entry",
    sizeAtoms: "1000000",
    slippageBps: 10,
    quoteMode: "coordinated_limits",
    traderPublicKey: TRADER_PUBLIC_KEY,
    idempotencyKey: secondKey,
  });
  const devnetDomain = {
    domainId: "svm:devnet",
    domainManifestVersion: 1,
    domainManifestHash: Uint8Array.from(Buffer.from("11".repeat(32), "hex")),
  } as unknown as DomainRef;
  const admissionStub = {
    order: {
      environment: "devnet",
      domain: devnetDomain,
      settlementClass: "ATOMIC_POSTCONDITION",
      action: "ENTRY",
    },
    quote: { environment: "devnet", domain: devnetDomain },
    route: { environment: "devnet", domain: devnetDomain },
    orderHash: Uint8Array.from(Buffer.from("33".repeat(32), "hex")),
  } as unknown as PackageAdmission;
  const bindingStub = {
    environment: "devnet",
    domain: devnetDomain,
  } as unknown as FirmCashCarryBinding;
  let materializerCalls = 0;
  const materializer = {
    materialize: async (
      input: SolanaMaterializationRequest,
    ): Promise<UnsignedSolanaMaterialization> => {
      materializerCalls += 1;
      assert.equal(input.planKind, "TRADER_ENTRY");
      assert.deepEqual(input.admission, admissionStub);
      assert.deepEqual(input.binding, bindingStub);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const isSecond = materializerCalls > 1;
      const message = isSecond ? secondMessage : firstMessage;
      const messageBase64 = isSecond ? SECOND_MESSAGE_BASE64 : FIRST_MESSAGE_BASE64;
      const transactionBase64 = isSecond ? SECOND_TRANSACTION_BASE64 : FIRST_TRANSACTION_BASE64;
      return Object.freeze({
        domain: devnetDomain,
        planKind: input.planKind,
        messageBytes: Uint8Array.from(message),
        messageBase64,
        transactionBytes: Uint8Array.from(Buffer.from(transactionBase64, "base64")),
        transactionBase64,
        requiredSignerPubkeys: Object.freeze([TRADER_PUBLIC_KEY]),
        recentBlockhash: isSecond ? SECOND_RECENT_BLOCKHASH : FIRST_RECENT_BLOCKHASH,
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
  const signatureB = canonicalSignature(9);
  const finalizedSlot = 300;
  const observedBlockHeight = 400;
  const rpc = {
    getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
    getSignatureStatus: async (signature: string) => {
      if (signature === signatureA) {
        return Object.freeze({ slot: finalizedSlot, confirmationStatus: "finalized", err: null });
      }
      return null;
    },
    getBlockHeight: async () => observedBlockHeight,
  };
  const store = new InMemoryPreparedSolanaDevnetStore();
  const ports = createSolanaDevnetExecutionPorts({
    contextProvider: () => ({ admission: admissionStub, binding: bindingStub }),
    materializer,
    store,
    rpc,
  });
  assert.ok(ports.preparation !== undefined);
  assert.ok(ports.observation !== undefined);

  const [prepared, concurrentPrepared] = await Promise.all([
    ports.preparation.prepare(firstRequest as never),
    ports.preparation.prepare(firstRequest as never),
  ]) as [Awaited<ReturnType<NonNullable<typeof ports.preparation>["prepare"]>>, Awaited<ReturnType<NonNullable<typeof ports.preparation>["prepare"]>>];
  assert.deepEqual(concurrentPrepared, prepared);
  assert.equal(prepared.domain, "svm:devnet");
  assert.equal(prepared.planKind, "TRADER_ENTRY");
  assert.deepEqual([...prepared.requiredSignerPubkeys], [TRADER_PUBLIC_KEY]);
  assert.equal(prepared.transactionBase64, FIRST_TRANSACTION_BASE64);
  assert.equal(prepared.messageBase64, FIRST_MESSAGE_BASE64);
  assert.equal(prepared.genesisHash, SOLANA_DEVNET_GENESIS_HASH);
  assert.equal(prepared.lastValidBlockHeight, 250);
  assert.equal(materializerCalls, 1);
  const stored = store.get(firstKey);
  assert.ok(stored !== undefined);
  assert.deepEqual(stored.materialization, prepared);

  const replayed = await ports.preparation.prepare(firstRequest as never);
  assert.deepEqual(replayed, prepared);
  assert.equal(materializerCalls, 1);

  await assert.rejects(
    ports.preparation.prepare({ ...firstRequest, sizeAtoms: "2000000" } as never),
  );

  const finalized = await ports.observation.observe({ idempotencyKey: firstKey, signature: signatureA });
  assert.equal(finalized.lifecycle, "FINALIZED");
  assert.equal(finalized.signature, signatureA);
  assert.equal(store.get(firstKey)?.boundSignature, signatureA);

  await assert.rejects(
    ports.observation.observe({ idempotencyKey: firstKey, signature: signatureB }),
  );

  const preparedSecond = await ports.preparation.prepare(secondRequest as never);
  assert.equal(preparedSecond.lastValidBlockHeight, 250);
  assert.equal(preparedSecond.messageBase64, SECOND_MESSAGE_BASE64);
  assert.equal(preparedSecond.transactionBase64, SECOND_TRANSACTION_BASE64);
  assert.notEqual(preparedSecond.messageBase64, prepared.messageBase64);
  assert.equal(materializerCalls, 2);
  const expired = await ports.observation.observe({ idempotencyKey: secondKey, signature: signatureC });
  assert.equal(expired.lifecycle, "EXPIRED");
  assert.equal(expired.signature, signatureC);
});

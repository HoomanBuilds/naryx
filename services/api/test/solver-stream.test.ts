import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fromProtocolJson, solverRequestDigest, toProtocolJson } from "@naryx/protocol-types";
import { createSolverStream, SOLVER_STREAM_PATH, SqliteEvidenceStore, SqlitePrivateDeliveryStore, SqliteRegistryStore, SqliteSolverApiStore } from "../src/index.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";
import { signedOrder } from "./evidence-fixtures.js";

const NOW_MS = 1_900_000_000_000;
const FAR = BigInt(NOW_MS / 1_000) + 86_400n;

type Message = Record<string, unknown>;

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${SOLVER_STREAM_PATH}`);
  const received: Message[] = [];
  let closeCode: number | undefined;
  socket.addEventListener("message", (event) => received.push(fromProtocolJson(JSON.parse(String(event.data))) as Message));
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const wait = async (predicate: (message: Message) => boolean) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const index = received.findIndex(predicate);
      if (index >= 0) return received.splice(index, 1)[0] as Message;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("timed out waiting for a solver stream message");
  };
  const closed = async () => {
    for (let attempt = 0; attempt < 100 && closeCode === undefined; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    return closeCode;
  };
  return { socket, wait, closed, send: (message: Message) => socket.send(JSON.stringify(toProtocolJson(message))) };
}

test("a solver stream opens only with a signed, unreplayed auth and then pushes open orders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-solver-stream-"));
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  const store = new SqliteSolverApiStore(join(dir, "solver.sqlite"), { clock: () => NOW_MS });
  const evidence = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => NOW_MS });
  const delivery = new SqlitePrivateDeliveryStore(join(dir, "delivery.sqlite"), { clock: () => NOW_MS });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  registry.registerDomain(DOMAIN_MANIFEST);
  registry.registerSolverManifest(signedSolverManifest(operatorKeys(), { quoteVerificationKeys: [{ keyId: "q-1", scheme: "ED25519", verificationKey: raw, validFromValue: 0n, validUntilValue: FAR }], validUntilValue: FAR }));
  const stream = createSolverStream({ store, registry, evidence, delivery, clockMs: () => NOW_MS, pollIntervalMs: 50 });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (!stream.upgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const auth = (nonce = randomBytes(32).toString("hex"), key = privateKey) => {
    const digest = solverRequestDigest({
      method: "GET",
      pathAndQuery: SOLVER_STREAM_PATH,
      bodySha256: new Uint8Array(createHash("sha256").update("").digest()),
      solverId: "solver-a",
      keyId: "q-1",
      timestampMs: BigInt(NOW_MS),
      nonce,
    });
    return { op: "auth", solverId: "solver-a", keyId: "q-1", timestampMs: NOW_MS, nonce, signature: sign(null, digest, key).toString("hex") };
  };
  try {
    // Anything before a valid auth closes the stream.
    const early = await connect(port);
    early.send({ op: "subscribe", channel: "orders" });
    assert.equal(await early.closed(), 4401);
    const forged = await connect(port);
    forged.send(auth(undefined, generateKeyPairSync("ed25519").privateKey));
    assert.equal((await forged.wait((message) => message.type === "error")).code, "INVALID_SIGNATURE");
    assert.equal(await forged.closed(), 4401);

    const nonce = randomBytes(32).toString("hex");
    const solver = await connect(port);
    solver.send(auth(nonce));
    assert.equal((await solver.wait((message) => message.type === "authenticated")).solverId, "solver-a");
    // The same signed auth cannot open a second stream.
    const replay = await connect(port);
    replay.send(auth(nonce));
    assert.equal((await replay.wait((message) => message.type === "error")).code, "REPLAYED_REQUEST");

    solver.send({ op: "subscribe", channel: "orders", after: 0 });
    await solver.wait((message) => message.type === "subscribed");
    const { order, orderHashHex, signature } = signedOrder();
    evidence.submitOrder(order, signature);
    const pushed = await solver.wait((message) => message.type === "orders");
    assert.deepEqual((pushed.orders as readonly { orderHash: string }[]).map((entry) => entry.orderHash), [orderHashHex]);
    const auction = delivery.createAuction({
      version: 1,
      auctionId: "auction-1",
      environment: "testnet",
      orderHash: "55".repeat(32),
      eligibleSolverIds: ["solver-a"],
      timeUnit: "EVM_UNIX_SECONDS",
      commitDeadlineValue: BigInt(NOW_MS / 1_000) + 10n,
      revealDeadlineValue: BigInt(NOW_MS / 1_000) + 20n,
      settlementDeadlineValue: BigInt(NOW_MS / 1_000) + 30n,
      minimumValidReveals: 1,
    });
    solver.send({ op: "subscribe", channel: "auctions", after: 0 });
    await solver.wait((message) => message.type === "subscribed" && message.channel === "auctions");
    const auctionPush = await solver.wait((message) => message.type === "auctions");
    assert.deepEqual((auctionPush.auctions as readonly { auctionHash: string }[]).map((entry) => entry.auctionHash), [auction.auctionHashHex]);
    solver.socket.close();
  } finally {
    stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    registry.close();
    store.close();
    evidence.close();
    delivery.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import { SqlitePackageExchangeStore } from "../src/index.js";
import { createMarketStream } from "../src/market-stream.js";
import { CLASS, CLASS_SUPPORT, NOW, SERIES_SUPPORT, order, registerAll, settlement } from "./exchange-fixtures.js";

type Message = Record<string, unknown>;

function inbox(socket: WebSocket) {
  const received: Message[] = [];
  const waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const message = parseProtocolJson(String(event.data)) as Message;
    received.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return {
    received,
    next(predicate: (message: Message) => boolean, timeoutMs = 3_000): Promise<Message> {
      const found = received.find(predicate);
      if (found !== undefined) {
        received.splice(received.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a stream message")), timeoutMs);
        waiters.push({ predicate, resolve: (message) => {
          clearTimeout(timer);
          received.splice(received.indexOf(message), 1);
          resolve(message);
        } });
      });
    },
  };
}

test("the stream pushes executable depth on change and observed trades after a cursor, with the HTTP labels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-stream-"));
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  registerAll(exchange);
  const stream = createMarketStream({ exchange, nowValue: () => NOW, pollIntervalMs: 50, maximumSubscriptionsPerConnection: 2 });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!stream.upgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`);
  const messages = inbox(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  const send = (message: Message) => socket.send(stringifyProtocolJson(message));
  try {
    const firstOrder = order(1);
    exchange.submitOrder(CLASS, firstOrder, NOW, settlement(firstOrder));
    send({ op: "subscribe", channel: "package-depth", packageMarketId: CLASS });
    assert.equal((await messages.next((message) => message.type === "subscribed")).channel, "package-depth");
    const first = await messages.next((message) => message.type === "package-depth");
    assert.equal(first.label, "EXECUTABLE");
    assert.equal((first.asks as readonly unknown[]).length, 1);
    // A new resting order changes depth, so it is pushed without asking.
    const secondOrder = order(2, { limitPriceTicks: 101n });
    exchange.submitOrder(CLASS, secondOrder, NOW, settlement(secondOrder));
    const second = await messages.next((message) => message.type === "package-depth");
    assert.equal((second.asks as readonly unknown[]).length, 2);

    // A trade after the tape subscription arrives as observed tape.
    send({ op: "subscribe", channel: "package-tape", packageMarketId: CLASS });
    const subscribed = await messages.next((message) => message.type === "subscribed" && message.channel === "package-tape");
    assert.equal(subscribed.after, 0);
    const takerOrder = order(3, { side: "BID", timeInForce: "IOC" });
    exchange.submitOrder(CLASS, takerOrder, NOW, settlement(takerOrder));
    const tape = await messages.next((message) => message.type === "package-tape");
    assert.equal(tape.label, "OBSERVED");
    assert.equal((tape.trades as readonly unknown[]).length, 1);

    // The connection is at its two-subscription cap, so a third is refused until one is dropped.
    send({ op: "subscribe", channel: "package-depth", packageMarketId: "no-such-book" });
    assert.equal((await messages.next((message) => message.type === "error")).code, "TOO_MANY_SUBSCRIPTIONS");
    send({ op: "unsubscribe", channel: "package-tape", packageMarketId: CLASS });
    await messages.next((message) => message.type === "unsubscribed");
    send({ op: "subscribe", channel: "package-depth", packageMarketId: "no-such-book" });
    assert.equal((await messages.next((message) => message.type === "error")).code, "BOOK_NOT_FOUND");
    send({ op: "subscribe", channel: "package-candles", packageMarketId: CLASS });
    assert.equal((await messages.next((message) => message.type === "error")).code, "INVALID_SUBSCRIPTION");
    assert.equal(stream.connectionCount, 1);
  } finally {
    socket.close();
    stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrades on other paths are declined and malformed handshakes are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-stream-"));
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const stream = createMarketStream({ exchange, nowValue: () => NOW, pollIntervalMs: 50 });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (!stream.upgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const refused = new WebSocket(`ws://127.0.0.1:${port}/v1/other`);
    await new Promise((resolve) => refused.addEventListener("error", resolve));
    const response = await fetch(`http://127.0.0.1:${port}/v1/stream`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "bad" } }).catch(() => undefined);
    assert.notEqual(response?.status, 101);
  } finally {
    stream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parseProtocolJson, stringifyProtocolJson } from "@naryx/protocol-types";
import type { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { packageDepthView, packageTapeView } from "./public-api.js";
import { clientKey } from "./rate-limit.js";
import { acceptWebSocket, type WebSocketConnection } from "./websocket.js";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TAPE_BATCH = 100;

export type MarketStreamChannel = "package-depth" | "package-tape";

export interface MarketStreamOptions {
  readonly exchange: Pick<SqlitePackageExchangeStore, "getBook" | "allocationTape" | "latestTrade">;
  readonly nowValue: () => bigint;
  readonly pollIntervalMs?: number;
  readonly maximumConnections?: number;
  readonly maximumConnectionsPerClient?: number;
  readonly maximumSubscriptionsPerConnection?: number;
}

interface Subscription {
  readonly channel: MarketStreamChannel;
  readonly packageMarketId: string;
  lastDepth?: string;
  cursor: number;
}

interface Client {
  readonly connection: WebSocketConnection;
  readonly key: string;
  readonly subscriptions: Map<string, Subscription>;
}

/**
 * Public market data over WebSocket at `/v1/stream`. A client subscribes to executable package
 * depth or the observed package tape of a market and receives exactly what the HTTP routes serve,
 * with the same labels: depth whenever it changes, and tape trades after the cursor it names (or
 * only new trades). Nothing here accepts orders or reveals anything the HTTP routes do not.
 */
export function createMarketStream(options: MarketStreamOptions): {
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
  readonly connectionCount: number;
} {
  const maximumConnections = options.maximumConnections ?? 512;
  const perClient = options.maximumConnectionsPerClient ?? 8;
  const maximumSubscriptions = options.maximumSubscriptionsPerConnection ?? 16;
  const clients = new Set<Client>();

  const send = (client: Client, message: Record<string, unknown>) => client.connection.send(stringifyProtocolJson(message));

  const depthMessage = (packageMarketId: string) => {
    const state = options.exchange.getBook(packageMarketId);
    return state === undefined ? undefined : { type: "package-depth", label: "EXECUTABLE", ...packageDepthView(state, options.nowValue()) };
  };

  const pushDepth = (client: Client, subscription: Subscription, cache: Map<string, { text: string; content: string } | undefined>) => {
    if (!cache.has(subscription.packageMarketId)) {
      const message = depthMessage(subscription.packageMarketId);
      // Depth is pushed when its content changes; the as-of time alone is not a change.
      cache.set(
        subscription.packageMarketId,
        message === undefined ? undefined : { text: stringifyProtocolJson(message), content: stringifyProtocolJson({ ...message, asOfValue: 0n }) },
      );
    }
    const entry = cache.get(subscription.packageMarketId);
    if (entry === undefined || entry.content === subscription.lastDepth) return;
    subscription.lastDepth = entry.content;
    client.connection.send(entry.text);
  };

  const pushTape = (client: Client, subscription: Subscription) => {
    const records = options.exchange.allocationTape(subscription.packageMarketId, subscription.cursor, TAPE_BATCH);
    if (records.length === 0) return;
    const page = packageTapeView(subscription.packageMarketId, records, subscription.cursor);
    subscription.cursor = page.nextCursor;
    send(client, { type: "package-tape", label: "OBSERVED", ...page });
  };

  const tick = () => {
    const depthCache = new Map<string, { text: string; content: string } | undefined>();
    for (const client of clients) {
      for (const subscription of client.subscriptions.values()) {
        try {
          if (subscription.channel === "package-depth") pushDepth(client, subscription, depthCache);
          else pushTape(client, subscription);
        } catch {
          send(client, { type: "error", code: "STREAM_READ_FAILED", message: `The ${subscription.channel} of ${subscription.packageMarketId} could not be read.` });
        }
      }
    }
  };
  const timer = setInterval(tick, options.pollIntervalMs ?? 1_000);

  const onText = (client: Client, text: string) => {
    let message: Record<string, unknown>;
    try {
      message = parseProtocolJson(text) as Record<string, unknown>;
      if (typeof message !== "object" || message === null) throw new Error("not an object");
    } catch {
      send(client, { type: "error", code: "INVALID_MESSAGE", message: "Messages are protocol JSON objects." });
      return;
    }
    const channel = message.channel;
    const packageMarketId = message.packageMarketId;
    if ((channel !== "package-depth" && channel !== "package-tape") || typeof packageMarketId !== "string" || !ID.test(packageMarketId)) {
      send(client, { type: "error", code: "INVALID_SUBSCRIPTION", message: "Name a channel of package-depth or package-tape and a package market id." });
      return;
    }
    const key = `${channel}/${packageMarketId}`;
    if (message.op === "unsubscribe") {
      client.subscriptions.delete(key);
      send(client, { type: "unsubscribed", channel, packageMarketId });
      return;
    }
    if (message.op !== "subscribe") {
      send(client, { type: "error", code: "INVALID_MESSAGE", message: "op must be subscribe or unsubscribe." });
      return;
    }
    if (!client.subscriptions.has(key) && client.subscriptions.size >= maximumSubscriptions) {
      send(client, { type: "error", code: "TOO_MANY_SUBSCRIPTIONS", message: `A connection holds at most ${maximumSubscriptions} subscriptions.` });
      return;
    }
    if (options.exchange.getBook(packageMarketId) === undefined) {
      send(client, { type: "error", code: "BOOK_NOT_FOUND", message: "Package market is not open.", channel, packageMarketId });
      return;
    }
    let cursor = 0;
    if (channel === "package-tape") {
      const after = message.after;
      if (after === undefined) cursor = options.exchange.latestTrade(packageMarketId)?.cursor ?? 0;
      else if (typeof after === "number" && Number.isSafeInteger(after) && after >= 0) cursor = after;
      else {
        send(client, { type: "error", code: "INVALID_SUBSCRIPTION", message: "after must be a nonnegative tape cursor." });
        return;
      }
    }
    const subscription: Subscription = { channel, packageMarketId, cursor };
    client.subscriptions.set(key, subscription);
    send(client, { type: "subscribed", channel, packageMarketId, ...(channel === "package-tape" ? { after: cursor } : {}) });
    try {
      if (channel === "package-depth") pushDepth(client, subscription, new Map());
      else pushTape(client, subscription);
    } catch {
      send(client, { type: "error", code: "STREAM_READ_FAILED", message: `The ${channel} of ${packageMarketId} could not be read.` });
    }
  };

  return {
    upgrade(request, socket) {
      const url = new URL(request.url ?? "/", "http://public-api.local");
      if (url.pathname !== "/v1/stream") return false;
      const key = clientKey(request.socket.remoteAddress);
      const fromClient = [...clients].filter((client) => client.key === key).length;
      if (clients.size >= maximumConnections || fromClient >= perClient) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return true;
      }
      acceptWebSocket(
        request,
        socket,
        (connection) => {
          const client: Client = { connection, key, subscriptions: new Map() };
          clients.add(client);
          return { onText: (text) => onText(client, text), onClose: () => clients.delete(client) };
        },
        { maximumMessageBytes: 1_024, pingIntervalMs: 30_000 },
      );
      return true;
    },
    close() {
      clearInterval(timer);
      for (const client of clients) client.connection.close(1001);
      clients.clear();
    },
    get connectionCount() {
      return clients.size;
    },
  };
}

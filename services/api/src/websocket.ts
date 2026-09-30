import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface WebSocketConnection {
  send(text: string): void;
  close(code?: number): void;
  readonly closed: boolean;
}

export interface WebSocketHandlers {
  onText(text: string): void;
  onClose(): void;
}

/**
 * A minimal RFC 6455 server endpoint for small client messages and server pushes. Client frames
 * must be masked and unfragmented and may not exceed `maximumMessageBytes`; anything else closes
 * the connection. Only text, ping, pong, and close are understood. The caller authorizes the
 * request before accepting it.
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  handlers: (connection: WebSocketConnection) => WebSocketHandlers,
  options: { readonly maximumMessageBytes: number; readonly pingIntervalMs: number },
): WebSocketConnection | undefined {
  const key = request.headers["sec-websocket-key"];
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
    request.headers["sec-websocket-version"] !== "13" ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let closed = false;
  let buffered = Buffer.alloc(0);
  let awaitingPong = false;

  const frame = (opcode: number, payload: Buffer): Buffer => {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (length >= 126) {
      header[0] = 0x80 | opcode;
      if (length < 65_536) {
        header[1] = 126;
        header.writeUInt16BE(length, 2);
      } else {
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }
    }
    return Buffer.concat([header, payload]);
  };

  const connection: WebSocketConnection = {
    send(text) {
      if (!closed) socket.write(frame(OPCODE_TEXT, Buffer.from(text, "utf8")));
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.end(frame(OPCODE_CLOSE, payload));
    },
    get closed() {
      return closed;
    },
  };
  const handler = handlers(connection);
  const ping = setInterval(() => {
    if (closed) return;
    // A client that has not answered the previous ping is gone.
    if (awaitingPong) {
      connection.close(1001);
      return;
    }
    awaitingPong = true;
    socket.write(frame(OPCODE_PING, Buffer.alloc(0)));
  }, options.pingIntervalMs);
  const finish = () => {
    clearInterval(ping);
    if (!closed) closed = true;
    handler.onClose();
  };
  socket.on("close", finish);
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const first = buffered[0] as number;
      const second = buffered[1] as number;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        // Clients here send only small control and subscription messages.
        connection.close(1009);
        return;
      }
      if (!final || !masked || (first & 0x70) !== 0 || length > options.maximumMessageBytes) {
        connection.close(!masked ? 1002 : length > options.maximumMessageBytes ? 1009 : 1003);
        return;
      }
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] as number) ^ (mask[index % 4] as number);
      buffered = buffered.subarray(offset + 4 + length);
      if (opcode === OPCODE_TEXT) handler.onText(payload.toString("utf8"));
      else if (opcode === OPCODE_PING) socket.write(frame(OPCODE_PONG, payload));
      else if (opcode === OPCODE_PONG) awaitingPong = false;
      else if (opcode === OPCODE_CLOSE) {
        connection.close(1000);
        return;
      } else {
        connection.close(1003);
        return;
      }
    }
  });
  return connection;
}

/**
 * Fixed-window request limiting shared by the public and solver APIs. The table holds at most
 * `maxKeys` clients; when it is full the least recently seen client is evicted, so a flood of new
 * addresses can never lock every new client out.
 */
export function createRateLimiter(options: {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly clockMs: () => number;
  readonly maxKeys?: number;
}): (key: string) => boolean {
  const { windowMs, maxRequests, clockMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("Rate limit must be positive.");
  }
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error("Rate limit key capacity must be positive.");
  // Map iteration follows insertion order; re-inserting on every hit keeps it least-recent first.
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = clockMs();
    const current = windows.get(key);
    windows.delete(key);
    if (current === undefined || now - current.start >= windowMs) {
      while (windows.size >= maxKeys) {
        const oldest = windows.keys().next();
        if (oldest.done === true) break;
        windows.delete(oldest.value);
      }
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    current.count += 1;
    windows.set(key, current);
    return current.count > maxRequests;
  };
}

/**
 * The rate-limit identity of a peer address. IPv6 clients are grouped by their /64 prefix, since a
 * single host commonly controls a whole /64; IPv4 and IPv4-mapped addresses are used as is.
 */
/**
 * The rate-limit key of a request. Behind the same-host reverse proxy every peer is loopback, so the
 * client is the last X-Forwarded-For entry, the address the proxy itself saw (deployments/aws/nginx);
 * entries a client sent earlier in that header are ignored. A direct peer is keyed by its address.
 */
export function requestClientKey(request: Readonly<{ socket: { remoteAddress?: string | undefined }; headers: Readonly<Record<string, string | string[] | undefined>> }>): string {
  const peer = request.socket.remoteAddress;
  const forwarded = request.headers["x-forwarded-for"];
  const loopbackPeer = peer === "::1" || peer === "127.0.0.1" || peer === "::ffff:127.0.0.1";
  if (loopbackPeer && typeof forwarded === "string" && forwarded.trim() !== "") {
    const last = forwarded.split(",").pop()?.trim() ?? "";
    if (/^[0-9a-fA-F.:]{2,45}$/.test(last)) return clientKey(last);
  }
  return clientKey(peer);
}

export function clientKey(address: string | undefined): string {
  if (address === undefined || address === "") return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped !== null) return mapped[1] as string;
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("%", 1)[0]!.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = address.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

import { chmodSync, mkdirSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import type { MxRecord } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { sendError, sendJson } from "./internal-http.js";
import { createRateLimiter, requestClientKey } from "./rate-limit.js";
import { isAllowedTerminalOrigin, type TerminalOrigins } from "./terminal-origin.js";

export function normalizeWaitlistEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 320) return undefined;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return undefined;
  const parts = email.split("@");
  if (parts.length !== 2) return undefined;
  const [local = "", domain = ""] = parts;
  if (local.length === 0 || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return email;
}

export function createEmailDomainCheck(resolver = new Resolver({ timeout: 1500, tries: 1 })) {
  const cache = new Map<string, { valid: boolean; until: number }>();
  const absent = (error: unknown) => ["ENODATA", "ENOTFOUND"].includes((error as NodeJS.ErrnoException).code ?? "");
  return async (domain: string): Promise<boolean> => {
    const cached = cache.get(domain);
    if (cached !== undefined && cached.until > Date.now()) return cached.valid;
    let exchanges: MxRecord[];
    try { exchanges = await resolver.resolveMx(domain); }
    catch (error) {
      if (!absent(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOTFOUND") exchanges = [{ exchange: ".", priority: 0 }];
      else exchanges = [];
    }
    let valid = exchanges.some(record => record.exchange !== "" && record.exchange !== ".");
    if (exchanges.length === 0) {
      // SMTP permits an address record when a domain publishes no MX records.
      const addresses = await Promise.all([resolver.resolve4(domain), resolver.resolve6(domain)].map(async query => {
        try { return (await query).length > 0; }
        catch (error) { if (absent(error)) return false; throw error; }
      }));
      valid = addresses.some(Boolean);
    }
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(domain, { valid, until: Date.now() + (valid ? 300_000 : 60_000) });
    return valid;
  };
}

export class MainnetWaitlistStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Waitlist database must use an absolute durable path.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS mainnet_waitlist (
      email TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      consent_version TEXT NOT NULL,
      source TEXT NOT NULL
    )`);
  }

  subscribe(email: string, nowMs: number): void {
    const normalized = normalizeWaitlistEmail(email);
    if (normalized === undefined) throw new Error("Invalid waitlist email.");
    this.db.prepare(`INSERT INTO mainnet_waitlist (email, created_at_ms, consent_version, source)
      VALUES (?, ?, 'mainnet-launch-v1', 'website') ON CONFLICT(email) DO NOTHING`).run(normalized, nowMs);
  }

  close(): void { this.db.close(); }
}

export function createMainnetWaitlistHandler(options: {
  readonly store: Pick<MainnetWaitlistStore, "subscribe">;
  readonly allowedOrigins: TerminalOrigins;
  readonly clockMs?: () => number;
  readonly acceptsEmailDomain?: (domain: string) => Promise<boolean>;
}) {
  const clockMs = options.clockMs ?? Date.now;
  const acceptsEmailDomain = options.acceptsEmailDomain ?? createEmailDomainCheck();
  const limited = createRateLimiter({ windowMs: 600_000, maxRequests: 5, clockMs });
  const globallyLimited = createRateLimiter({ windowMs: 600_000, maxRequests: 300, clockMs, maxKeys: 1 });
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = new URL(request.url ?? "/", "http://waitlist.local");
    if (url.pathname !== "/v1/waitlist") return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!isAllowedTerminalOrigin(options.allowedOrigins, origin)) {
        return sendError(response, 403, "ORIGIN_NOT_ALLOWED", "Browser origin is not allowed.");
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Max-Age", "600");
    }
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return true; }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST, OPTIONS");
      return sendError(response, 405, "METHOD_NOT_ALLOWED", "Use POST to join the waitlist.");
    }
    if (url.search !== "") return sendError(response, 400, "INVALID_REQUEST", "Query parameters are not accepted.");
    if (limited(requestClientKey(request)) || globallyLimited("waitlist")) {
      response.setHeader("Retry-After", "600");
      return sendError(response, 429, "RATE_LIMITED", "Too many attempts. Please try again in 10 minutes.");
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return sendError(response, 415, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      if (!response.writableEnded) sendError(response, 408, "REQUEST_TIMEOUT", "Please try again.");
      request.resume();
    }, 10_000).unref();
    response.once("close", () => clearTimeout(timeout));
    request.on("error", () => {
      clearTimeout(timeout);
      if (!response.destroyed && !response.writableEnded) sendError(response, 400, "INVALID_REQUEST", "Please try again.");
    });
    request.on("data", (chunk: Buffer) => {
      if (response.writableEnded) return;
      bytes += chunk.length;
      if (bytes > 2048) {
        chunks.length = 0;
        clearTimeout(timeout);
        sendError(response, 413, "BODY_TOO_LARGE", "Request body is too large.");
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      clearTimeout(timeout);
      if (response.writableEnded) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { sendError(response, 400, "INVALID_JSON", "Request body must contain valid JSON."); return; }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        sendError(response, 400, "INVALID_REQUEST", "Provide an email and launch-email consent."); return;
      }
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !["email", "consent", "website"].includes(key))
        || input.consent !== true || (input.website !== undefined && typeof input.website !== "string")) {
        sendError(response, 400, "INVALID_REQUEST", "Provide an email and launch-email consent."); return;
      }
      if (typeof input.website === "string" && input.website !== "") { sendJson(response, 200, { status: "joined" }); return; }
      const email = normalizeWaitlistEmail(input.email);
      if (email === undefined) { sendError(response, 400, "INVALID_EMAIL", "Enter a valid email address."); return; }
      void acceptsEmailDomain(email.split("@")[1]!).then(valid => {
        if (!valid) { sendError(response, 400, "INVALID_EMAIL_DOMAIN", "This email domain cannot receive mail. Check your email address."); return; }
        options.store.subscribe(email, clockMs());
        sendJson(response, 200, { status: "joined" });
      }).catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          sendError(response, 503, "WAITLIST_UNAVAILABLE", "We could not validate and save your email. Please try again shortly.");
        }
      });
    });
    return true;
  };
}

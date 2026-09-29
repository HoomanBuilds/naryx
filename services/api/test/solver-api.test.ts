import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  domainManifestHash,
  domainRef,
  fromProtocolJson,
  packageQuoteShardHash,
  solverRequestDigest,
  toProtocolJson,
  type PackageQuoteLevel,
  type PackageQuoteShardInput,
  type SolverRequestMethod,
} from "@naryx/protocol-types";
import {
  createPublicApiHandler,
  createSolverApiHandler,
  SqlitePackageExchangeStore,
  SqliteRegistryStore,
  SqliteSolverApiStore,
} from "../src/index.js";
import { CLASS, CLASS_SUPPORT, NOW, SERIES, SERIES_SUPPORT, id, registerAll } from "./exchange-fixtures.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";

const NOW_MS = 1_900_000_000_000;
const NOW_S = BigInt(NOW_MS / 1_000);
const FAR = NOW_S + 86_400n;

function quoteKey(): { raw: Uint8Array; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { raw: new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), privateKey };
}

const level = (levelId: bigint, direction: "BID" | "ASK", referenceOffset: bigint): PackageQuoteLevel => ({
  levelId,
  direction,
  size: 10n,
  referenceOffset,
  maximumFee: 5n,
  settlementClass: "ATOMIC_POSTCONDITION",
  quoteMode: "FIRM_ONCHAIN",
  validUntilUnit: "EVM_UNIX_SECONDS",
  validUntilValue: FAR,
  reservationPolicy: "RESERVE_ON_ACCEPT",
});

interface Harness {
  call(method: SolverRequestMethod, path: string, body?: unknown, tweak?: { solverId?: string; key?: KeyObject; keyId?: string; timestampMs?: number; nonce?: string; tamper?: boolean }): Promise<{ status: number; body: Record<string, unknown> }>;
  plain(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  signShard(shard: PackageQuoteShardInput, key?: KeyObject): PackageQuoteShardInput;
  shard(overrides?: Partial<PackageQuoteShardInput>): PackageQuoteShardInput;
  exchange: SqlitePackageExchangeStore;
  solverKey: KeyObject;
}

async function withSolverApi(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-solver-api-"));
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  const solverState = new SqliteSolverApiStore(join(dir, "solver.sqlite"), { clock: () => NOW_MS });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  registerAll(exchange);
  const operator = operatorKeys();
  const key = quoteKey();
  registry.registerDomain(DOMAIN_MANIFEST);
  registry.registerSolverManifest(
    signedSolverManifest(operator, { quoteVerificationKeys: [{ keyId: "q-1", scheme: "ED25519", verificationKey: key.raw, validFromValue: 0n, validUntilValue: FAR }], validUntilValue: FAR }),
  );
  const rateLimit = { windowMs: 60_000, maxRequests: 1_000 };
  const solver = createSolverApiHandler({ store: solverState, registry, exchange, nowValue: () => NOW, clockMs: () => NOW_MS, rateLimit });
  const publicApi = createPublicApiHandler({ exchange, registry, solverState, nowValue: () => NOW, clockMs: () => NOW_MS, rateLimit });
  const server = createServer((request, response) => {
    if (!solver(request, response) && !publicApi(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const decode = async (response: Response) => ({ status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> });
  const harness: Harness = {
    exchange,
    solverKey: key.privateKey,
    async call(method, path, body, tweak = {}) {
      const text = body === undefined ? "" : JSON.stringify(toProtocolJson(body));
      const nonce = tweak.nonce ?? randomBytes(32).toString("hex");
      const timestampMs = tweak.timestampMs ?? NOW_MS;
      const solverId = tweak.solverId ?? "solver-a";
      const keyId = tweak.keyId ?? "q-1";
      const digest = solverRequestDigest({
        method,
        pathAndQuery: path,
        bodySha256: new Uint8Array(createHash("sha256").update(text).digest()),
        solverId,
        keyId,
        timestampMs: BigInt(timestampMs),
        nonce,
      });
      const signature = sign(null, digest, tweak.key ?? key.privateKey).toString("hex");
      const sent = tweak.tamper === true ? text.replace("10", "11") : text;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(sent === "" ? {} : { "Content-Type": "application/json" }),
          "X-Naryx-Solver": solverId,
          "X-Naryx-Key": keyId,
          "X-Naryx-Timestamp": String(timestampMs),
          "X-Naryx-Nonce": nonce,
          "X-Naryx-Signature": signature,
        },
        ...(sent === "" ? {} : { body: sent }),
      });
      return decode(response);
    },
    async plain(method, path, body) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) }),
      });
      return decode(response);
    },
    signShard(shard, signer = key.privateKey) {
      return { ...shard, signature: new Uint8Array(sign(null, packageQuoteShardHash(shard), signer)) };
    },
    shard(overrides = {}) {
      return harness.signShard({
        shardVersion: 1,
        environment: "testnet",
        domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)),
        solverId: "solver-a",
        templateId: "cash-and-carry-v1",
        marketGroupId: CLASS,
        referenceStateHash: "31".repeat(32),
        referenceSequence: 1n,
        quoteLevels: [level(1n, "BID", -5n), level(2n, "ASK", 5n)],
        inventoryCap: 100n,
        reservedCapacity: 0n,
        heartbeatExpiry: FAR,
        shardSequence: 1n,
        killSwitchState: "INACTIVE",
        signature: new Uint8Array(0),
        ...overrides,
      });
    },
  };
  try {
    await run(harness);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    exchange.close();
    solverState.close();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHARD_PATH = `/v1/solver/quote-shards/cash-and-carry-v1.${CLASS}`;

test("requests are authenticated by a registered key, a fresh timestamp, and a single-use nonce", async () => {
  await withSolverApi(async (api) => {
    const ok = await api.call("PUT", SHARD_PATH, { shard: api.shard() });
    assert.equal(ok.status, 200, JSON.stringify(toProtocolJson(ok.body)));
    assert.equal((await api.plain("GET", SHARD_PATH)).status, 401);
    const nonce = "ab".repeat(32);
    assert.equal((await api.call("GET", SHARD_PATH, undefined, { nonce })).status, 200);
    assert.equal(((await api.call("GET", SHARD_PATH, undefined, { nonce })).body.error as { code: string }).code, "REPLAYED_REQUEST");
    const code = async (tweak: Parameters<Harness["call"]>[3], body?: unknown) =>
      ((await api.call(body === undefined ? "GET" : "PUT", SHARD_PATH, body, tweak)).body.error as { code: string } | undefined)?.code;
    assert.equal(await code({ timestampMs: NOW_MS - 60_000 }), "STALE_REQUEST");
    assert.equal(await code({ key: quoteKey().privateKey }), "INVALID_SIGNATURE");
    assert.equal(await code({ keyId: "q-9" }), "KEY_NOT_VALID");
    assert.equal(await code({ solverId: "solver-z" }), "UNKNOWN_SOLVER");
    assert.equal(await code({ tamper: true }, { shard: api.shard({ shardSequence: 2n }) }), "INVALID_SIGNATURE");
  });
});

test("shard operations enforce ownership, signatures, sequence, and the change each route allows", async () => {
  await withSolverApi(async (api) => {
    assert.equal((await api.call("PUT", SHARD_PATH, { shard: api.shard() })).status, 200);
    const heartbeat = await api.call("POST", `${SHARD_PATH}/heartbeat`, { shard: api.shard({ shardSequence: 2n, heartbeatExpiry: FAR + 60n }) });
    assert.equal(heartbeat.status, 200);
    const sneaky = await api.call("POST", `${SHARD_PATH}/heartbeat`, { shard: api.shard({ shardSequence: 3n, heartbeatExpiry: FAR + 120n, inventoryCap: 999n }) });
    assert.equal((sneaky.body.error as { code: string }).code, "UNEXPECTED_CHANGE");
    const reused = await api.call("PUT", SHARD_PATH, { shard: api.shard({ shardSequence: 2n }) });
    assert.equal((reused.body.error as { code: string }).code, "SEQUENCE_REUSED");
    const unsigned = await api.call("PUT", SHARD_PATH, { shard: api.signShard({ ...api.shard({ shardSequence: 3n }) }, quoteKey().privateKey) });
    assert.equal((unsigned.body.error as { code: string }).code, "INVALID_SHARD_SIGNATURE");
    const foreign = await api.call("PUT", SHARD_PATH, { shard: api.shard({ shardSequence: 3n, solverId: "solver-b" }) });
    assert.equal(foreign.status, 403);
    const quotes = (await api.plain("GET", `/v1/markets/${CLASS}/quotes`)).body as { quotes: readonly { quoteMode: string; solverId: string }[] };
    assert.deepEqual(quotes.quotes.map((quote) => [quote.solverId, quote.quoteMode]), [["solver-a", "FIRM_ONCHAIN"], ["solver-a", "FIRM_ONCHAIN"]]);
    const cancelled = await api.call("POST", `${SHARD_PATH}/cancel-all`, { shard: api.shard({ shardSequence: 3n, heartbeatExpiry: FAR + 60n, quoteLevels: [] }) });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(((await api.plain("GET", `/v1/markets/${CLASS}/quotes`)).body as { quotes: readonly unknown[] }).quotes, []);
    const killed = await api.call("POST", "/v1/solver/kill-switch", {
      shardId: `cash-and-carry-v1.${CLASS}`,
      shard: api.shard({ shardSequence: 4n, heartbeatExpiry: FAR + 60n, quoteLevels: [], killSwitchState: "ACTIVE" }),
    });
    assert.equal(killed.status, 200);
  });
});

test("capacity evidence bounds reservations, and book quotes are derived and owner-cancellable", async () => {
  await withSolverApi(async (api) => {
    const scope = { domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)), asset: { assetId: "usdc", assetManifestHash: "33".repeat(32), decimals: 6 } };
    const record = { version: 1, environment: "testnet", solverId: "solver-a", ...scope, availableAtoms: 100n, maximumConcurrentRecoveryAtoms: 50n, evidenceGrade: "ONCHAIN_AVAILABLE", evidenceCommitment: "44".repeat(32), observedAtValue: NOW_S - 10n, expiresAtValue: FAR };
    assert.equal((await api.call("PUT", "/v1/solver/capacity", { record })).status, 200);
    const commit = (n: number, atoms: bigint) => api.call("POST", "/v1/solver/reservations", { ...scope, commitment: { commitmentId: id(n), atoms, recoveryAtoms: 0n, firm: true, atValue: NOW_S } });
    assert.equal((await commit(1, 60n)).status, 200);
    assert.equal(((await commit(2, 60n)).body.error as { code: string }).code, "INSUFFICIENT_CAPACITY");
    const capacity = (await api.plain("GET", "/v1/solvers/solver-a/capacity")).body as { scopes: readonly { status: { committedAtoms: bigint; remainingAtoms: bigint } }[] };
    assert.deepEqual([capacity.scopes[0]?.status.committedAtoms, capacity.scopes[0]?.status.remainingAtoms], [60n, 40n]);

    const quote = {
      executionClassId: CLASS,
      side: "ASK",
      evidence: "RESERVATION_BACKED_IMPLIED",
      legRatios: SERIES.economicLegRatios,
      legSources: [
        { sourceId: "spot-1", sourceVersion: 1n, side: "ASK", priceTicks: 1_100n, quantity: 20n, reservationId: id(501) },
        { sourceId: "perp-1", sourceVersion: 1n, side: "BID", priceTicks: 1_000n, quantity: 20n, reservationId: id(901) },
      ],
    };
    const posted = await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote });
    assert.equal(posted.status, 200, JSON.stringify(toProtocolJson(posted.body)));
    const entryId = posted.body.entryId as string;
    assert.equal(api.exchange.getBook(CLASS)?.entries[0]?.participantId, "solver-a");
    const cancelled = await api.call("POST", "/v1/solver/quotes/cancel", { packageMarketId: CLASS, entryId });
    assert.equal(cancelled.status, 200);
    assert.equal(api.exchange.getBook(CLASS)?.entries.length, 0);
  });
});

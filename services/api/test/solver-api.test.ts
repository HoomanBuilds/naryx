import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  domainManifestHash,
  domainRef,
  fromProtocolJson,
  packageQuoteShardHash,
  packageReceiptHash,
  privateRfqEnvelopeHash,
  routeHash,
  sealedQuoteCommitment,
  solverRequestDigest,
  toHex,
  toProtocolJson,
  openPerformanceBond,
  type PerformanceBondLedger,
  type PackageQuoteLevel,
  type PackageQuoteShardInput,
  type PrivateRfqEnvelopeInput,
  type SolverRequestMethod,
} from "@naryx/protocol-types";
import {
  createPublicApiHandler,
  createSolverApiHandler,
  SqliteEvidenceStore,
  SqlitePackageExchangeStore,
  SqlitePrivateDeliveryStore,
  SqliteRegistryStore,
  SqliteSolverApiStore,
  type AdmissionContext,
} from "../src/index.js";
import { CALENDAR_SERIES, CLASS, CLASS_SUPPORT, NEAR_BASIS_SERIES, NOW, SERIES, SERIES_SUPPORT, id, registerAll } from "./exchange-fixtures.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";
import { hash as fill, manifest as evidenceManifestFor, outcome as outcomeFor, receipt as receiptFor, signedOrder, terms } from "./evidence-fixtures.js";
import { routeFor, signedQuoteFor } from "./quote-fixtures.js";
import { privateRfqResponseMatchesQuote, sealedAuctionAwardMatchesQuote } from "../src/public-api.js";

const NOW_MS = 1_900_000_000_000;
/** Observed bond ledgers the harness's solver API reads by bond id. */
const OBSERVED_BONDS = new Map<string, PerformanceBondLedger>();
const RFQ_SUITE = "hpke-x25519-sha256-aes256gcm";
const NOW_S = BigInt(NOW_MS / 1_000);
const FAR = NOW_S + 86_400n;

test("sealed auction awards bind the exact solver quote through the settlement deadline", () => {
  const quote = {
    environment: "testnet",
    solverId: "solver-a",
    quoteHash: "77".repeat(32),
    netOutcomeAtoms: 500n,
    validUntilUnit: "EVM_UNIX_SECONDS",
    validUntilValue: NOW_S + 30n,
  };
  const award = {
    environment: "testnet",
    solverId: "solver-a",
    quoteHash: "77".repeat(32),
    netOutcomeAtoms: 500n,
    timeUnit: "EVM_UNIX_SECONDS",
    settlementDeadlineValue: NOW_S + 30n,
  };
  assert.equal(sealedAuctionAwardMatchesQuote(quote, award), true);
  assert.equal(sealedAuctionAwardMatchesQuote({ ...quote, quoteHash: "78".repeat(32) }, award), false);
  assert.equal(sealedAuctionAwardMatchesQuote({ ...quote, solverId: "solver-b" }, award), false);
  assert.equal(sealedAuctionAwardMatchesQuote({ ...quote, netOutcomeAtoms: 501n }, award), false);
  assert.equal(sealedAuctionAwardMatchesQuote({ ...quote, validUntilValue: NOW_S + 29n }, award), false);
});

test("private RFQ acceptance binds the exact encrypted-response quote", () => {
  const quote = {
    environment: "testnet",
    orderHash: "55".repeat(32),
    solverId: "solver-a",
    quoteHash: "77".repeat(32),
  };
  assert.equal(privateRfqResponseMatchesQuote(quote, quote), true);
  assert.equal(privateRfqResponseMatchesQuote({ ...quote, environment: "mainnet" }, quote), false);
  assert.equal(privateRfqResponseMatchesQuote({ ...quote, orderHash: "56".repeat(32) }, quote), false);
  assert.equal(privateRfqResponseMatchesQuote({ ...quote, solverId: "solver-b" }, quote), false);
  assert.equal(privateRfqResponseMatchesQuote({ ...quote, quoteHash: "78".repeat(32) }, quote), false);
});

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
  evidence: SqliteEvidenceStore;
  solverKey: KeyObject;
  setClock(ms: number): void;
}

async function withSolverApi(
  run: (harness: Harness) => Promise<void>,
  pinnedSuiteIds: readonly string[] = [RFQ_SUITE],
  admission?: ReadonlyMap<string, AdmissionContext>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-solver-api-"));
  let clock = NOW_MS;
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  const solverState = new SqliteSolverApiStore(join(dir, "solver.sqlite"), { clock: () => clock });
  const delivery = new SqlitePrivateDeliveryStore(join(dir, "delivery.sqlite"), { clock: () => clock });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const evidence = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => clock });
  registerAll(exchange);
  const operator = operatorKeys();
  const key = quoteKey();
  registry.registerDomain(DOMAIN_MANIFEST);
  registry.registerSolverManifest(
    signedSolverManifest(operator, {
      quoteVerificationKeys: [{ keyId: "q-1", scheme: "ED25519", verificationKey: key.raw, validFromValue: 0n, validUntilValue: FAR }],
      rfqEncryptionKeys: [{ keyId: "rfq-1", encryptionSuiteId: RFQ_SUITE, publicKey: new Uint8Array(32).fill(8), validFromValue: 0n, validUntilValue: FAR }],
      validUntilValue: FAR,
    }),
  );
  const rateLimit = { windowMs: 60_000, maxRequests: 1_000 };
  const solver = createSolverApiHandler({
    store: solverState,
    registry,
    exchange,
    delivery,
    evidence,
    bonds: (id) => OBSERVED_BONDS.get(id),
    backingAtomsPerPackageUnit: new Map([[CLASS, { commitment: 1n, legs: [1n, 1n] }]]),
    packageSourceBackingAtomsPerUnit: new Map([
      [NEAR_BASIS_SERIES.seriesId, 1n],
      [CALENDAR_SERIES.seriesId, 1n],
    ]),
    ...(admission === undefined ? {} : { admission }),
    nowValue: () => NOW,
    clockMs: () => clock,
    rateLimit,
  });
  const publicApi = createPublicApiHandler({ exchange, registry, solverState, delivery, evidence, pinnedSuiteIds, nowValue: () => NOW, clockMs: () => clock, rateLimit });
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
    evidence,
    solverKey: key.privateKey,
    setClock(ms) {
      clock = ms;
    },
    async call(method, path, body, tweak = {}) {
      const text = body === undefined ? "" : JSON.stringify(toProtocolJson(body));
      const nonce = tweak.nonce ?? randomBytes(32).toString("hex");
      const timestampMs = tweak.timestampMs ?? clock;
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
    evidence.close();
    delivery.close();
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
        { sourceId: "solver-a:spot-1", sourceVersion: 1n, side: "ASK", priceTicks: 1_100n, quantity: 20n, reservationId: id(501) },
        { sourceId: "solver-a:perp-1", sourceVersion: 1n, side: "BID", priceTicks: 1_000n, quantity: 20n, reservationId: id(901) },
      ],
    };
    // Made-up reservations and a missing expiry never become executable depth.
    assert.equal(((await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote, expiresAtValue: NOW + 60n })).body.error as { code: string }).code, "BACKING_NOT_OUTSTANDING");
    assert.equal((await commit(501, 20n)).status, 200);
    assert.equal((await commit(901, 20n)).status, 200);
    assert.equal((await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote })).status, 400);
    const posted = await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote, expiresAtValue: NOW + 60n });
    assert.equal(posted.status, 200, JSON.stringify(toProtocolJson(posted.body)));
    const reused = { ...quote, legSources: quote.legSources.map((source) => ({ ...source, priceTicks: source.side === "ASK" ? 1_200n : source.priceTicks })) };
    assert.equal(((await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote: reused, expiresAtValue: NOW + 60n })).body.error as { code: string }).code, "BACKING_IN_USE");
    // Executable quantity never exceeds what its reservations hold.
    const oversized = { ...quote, legSources: quote.legSources.map((source) => ({ ...source, quantity: 30n })) };
    assert.equal(((await api.call("POST", "/v1/solver/quotes", { packageMarketId: CLASS, quote: oversized, expiresAtValue: NOW + 60n })).body.error as { code: string }).code, "BACKING_INSUFFICIENT");
    const entryId = posted.body.entryId as string;
    assert.equal(api.exchange.getBook(CLASS)?.entries[0]?.participantId, "solver-a");
    const cancelled = await api.call("POST", "/v1/solver/quotes/cancel", { packageMarketId: CLASS, entryId });
    assert.equal(cancelled.status, 200);
    assert.equal(api.exchange.getBook(CLASS)?.entries.length, 0);
  });
});

test("registered package series imply executable package liquidity", async () => {
  await withSolverApi(async (api) => {
    const scope = {
      domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)),
      asset: { assetId: "usdc", assetManifestHash: "33".repeat(32), decimals: 6 },
    };
    const record = {
      version: 1,
      environment: "testnet",
      solverId: "solver-a",
      ...scope,
      availableAtoms: 100n,
      maximumConcurrentRecoveryAtoms: 50n,
      evidenceGrade: "ONCHAIN_AVAILABLE",
      evidenceCommitment: "44".repeat(32),
      observedAtValue: NOW_S - 10n,
      expiresAtValue: FAR,
    };
    assert.equal((await api.call("PUT", "/v1/solver/capacity", { record })).status, 200);
    for (const commitmentId of [601, 602]) {
      const result = await api.call("POST", "/v1/solver/reservations", {
        ...scope,
        commitment: { commitmentId: id(commitmentId), atoms: 20n, recoveryAtoms: 0n, firm: true, atValue: NOW_S },
      });
      assert.equal(result.status, 200);
    }
    const sources = [
      {
        entryId: id(701),
        sourceVersion: 1n,
        side: "ASK",
        priceTicks: 80n,
        quantity: 20n,
        derivationDepth: 0,
        seriesId: NEAR_BASIS_SERIES.seriesId,
        seriesVersion: NEAR_BASIS_SERIES.seriesVersion,
        unitsPerTarget: { numerator: 1n, denominator: 1n },
        reservationId: id(601),
        ancestorEntryIds: [],
      },
      {
        entryId: id(702),
        sourceVersion: 1n,
        side: "ASK",
        priceTicks: 20n,
        quantity: 20n,
        derivationDepth: 0,
        seriesId: CALENDAR_SERIES.seriesId,
        seriesVersion: CALENDAR_SERIES.seriesVersion,
        unitsPerTarget: { numerator: 1n, denominator: 1n },
        reservationId: id(602),
        ancestorEntryIds: [],
      },
    ];
    const posted = await api.call("POST", "/v1/solver/quotes/package-implication", {
      packageMarketId: CLASS,
      targetSide: "ASK",
      sources,
      expiresAtValue: NOW + 60n,
    });
    assert.equal(posted.status, 200, JSON.stringify(toProtocolJson(posted.body)));
    assert.deepEqual(
      [posted.body.priceTicks, posted.body.quantity, posted.body.derivationDepth],
      [100n, 20n, 1],
    );
    assert.equal(api.exchange.getBook(CLASS)?.entries[0]?.source, "IMPLIED");

    const unknown = await api.call("POST", "/v1/solver/quotes/package-implication", {
      packageMarketId: CLASS,
      targetSide: "ASK",
      sources: [{ ...sources[0], seriesId: "unknown-series" }, sources[1]],
      expiresAtValue: NOW + 60n,
    });
    assert.equal((unknown.body.error as { code: string }).code, "SERIES_UNKNOWN");
  });
});

/** A private RFQ sender whose key id is its base58 Ed25519 public key, signing envelope hashes. */
function rfqSender() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = bs58.encode((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  const signEnvelope = (envelope: PrivateRfqEnvelopeInput) => new Uint8Array(sign(null, privateRfqEnvelopeHash(envelope), privateKey));
  const entry = (envelope: PrivateRfqEnvelopeInput, ciphertext: unknown) => ({ envelope, ciphertext, senderSignature: signEnvelope(envelope) });
  return { keyId, signEnvelope, entry };
}

test("implied quotes post atomically in batches and a solver reads only its own settlements", async () => {
  await withSolverApi(async (api) => {
    const scope = { domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)), asset: { assetId: "usdc", assetManifestHash: "33".repeat(32), decimals: 6 } };
    const record = { version: 1, environment: "testnet", solverId: "solver-a", ...scope, availableAtoms: 100n, maximumConcurrentRecoveryAtoms: 50n, evidenceGrade: "ONCHAIN_AVAILABLE", evidenceCommitment: "44".repeat(32), observedAtValue: NOW_S - 10n, expiresAtValue: FAR };
    assert.equal((await api.call("PUT", "/v1/solver/capacity", { record })).status, 200);
    for (const n of [501, 901, 502, 902]) {
      assert.equal((await api.call("POST", "/v1/solver/reservations", { ...scope, commitment: { commitmentId: id(n), atoms: 20n, recoveryAtoms: 0n, firm: true, atValue: NOW_S } })).status, 200);
    }
    const quote = (spot: number, perp: number, spotPrice: bigint) => ({
      executionClassId: CLASS,
      side: "ASK",
      evidence: "RESERVATION_BACKED_IMPLIED",
      legRatios: SERIES.economicLegRatios,
      legSources: [
        { sourceId: `solver-a:spot-${spot}`, sourceVersion: 1n, side: "ASK", priceTicks: spotPrice, quantity: 20n, reservationId: id(spot) },
        { sourceId: `solver-a:perp-${perp}`, sourceVersion: 1n, side: "BID", priceTicks: 1_000n, quantity: 20n, reservationId: id(perp) },
      ],
    });
    const entry = (spot: number, perp: number, spotPrice: bigint) => ({ quote: quote(spot, perp, spotPrice), expiresAtValue: NOW + 60n });

    // Reusing one reservation inside a batch rejects the whole batch; nothing is posted.
    const conflicting = await api.call("POST", "/v1/solver/quotes/batch", { packageMarketId: CLASS, quotes: [entry(501, 901, 1_100n), entry(501, 902, 1_110n)] });
    assert.equal((conflicting.body.error as { code: string }).code, "BACKING_IN_USE");
    assert.equal(api.exchange.getBook(CLASS)?.entries.length, 0);
    const tooMany = await api.call("POST", "/v1/solver/quotes/batch", { packageMarketId: CLASS, quotes: Array.from({ length: 17 }, () => entry(501, 901, 1_100n)) });
    assert.equal(tooMany.status, 400);

    const posted = await api.call("POST", "/v1/solver/quotes/batch", { packageMarketId: CLASS, quotes: [entry(501, 901, 1_100n), entry(502, 902, 1_120n)] });
    assert.equal(posted.status, 200, JSON.stringify(toProtocolJson(posted.body)));
    assert.deepEqual((posted.body.entries as readonly { priceTicks: bigint }[]).map((value) => value.priceTicks), [100n, 120n]);
    assert.equal(api.exchange.getBook(CLASS)?.entries.length, 2);

    // Settlements are read by quote hash, and only the solver named on the receipt sees them.
    const orderHash = fill(1);
    const settled = receiptFor(orderHash, { solver: "solver-a", quoteHash: fill(2) });
    api.evidence.recordOutcome({
      evidenceManifest: evidenceManifestFor(orderHash),
      outcome: outcomeFor(orderHash, { terminalState: "FINALIZED_COMPLETE", successfulReceiptHash: packageReceiptHash(settled) }),
      receipt: settled,
      acceptedQuoteFeeTerms: terms,
    });
    const quoteHashHex = toHex(fill(2));
    const settlement = await api.call("GET", `/v1/solver/settlements/${quoteHashHex}`);
    assert.equal(settlement.status, 200);
    assert.deepEqual(
      (settlement.body.settlements as readonly { orderHash: string; terminalState: string; receiptHash: string }[]).map((value) => [value.orderHash, value.terminalState, value.receiptHash]),
      [[toHex(orderHash), "FINALIZED_COMPLETE", toHex(packageReceiptHash(settled))]],
    );
    assert.equal((await api.call("GET", `/v1/solver/settlements/${"ab".repeat(32)}`)).status, 404);
    assert.equal((await api.call("GET", "/v1/solver/settlements/not-a-hash")).status, 404);
  });
});

test("solvers answer public orders with signed quotes that takers read back with their routes", async () => {
  await withSolverApi(async (api) => {
    const { order, orderHashHex, signature } = signedOrder();
    api.evidence.submitOrder(order, signature);
    const manifestHash = ((await api.plain("GET", "/v1/solvers/solver-a")).body as { manifestHash: string }).manifestHash;
    const route = routeFor(orderHashHex, order.domain, order.environment);
    const quote = (overrides: Partial<Parameters<typeof signedQuoteFor>[0]> = {}) => signedQuoteFor({
      orderHash: orderHashHex,
      route,
      environment: order.environment,
      domain: order.domain,
      solverId: "solver-a",
      manifestHash,
      quoteKey: api.solverKey,
      validUntilUnit: "EVM_UNIX_SECONDS",
      validUntilValue: NOW_S + 60n,
      ...overrides,
    });
    const post = (body: Record<string, unknown>) => api.call("POST", "/v1/solver/order-quotes", body);
    const errorCode = (response: { body: Record<string, unknown> }) => (response.body.error as { code: string }).code;

    const accepted = await post({ quote: quote(), route });
    assert.equal(accepted.status, 200, JSON.stringify(toProtocolJson(accepted.body)));
    assert.equal(accepted.body.replayed, false);
    assert.equal((await post({ quote: quote(), route })).body.replayed, true);

    // Only the authenticated solver's own, validly signed, honestly labeled, live quote is accepted.
    const tampered = { ...quote(), signature: new Uint8Array(64).fill(3) };
    assert.equal(errorCode(await post({ quote: tampered, route })), "INVALID_QUOTE_SIGNATURE");
    assert.equal(errorCode(await post({ quote: quote({ solverId: "solver-b" }), route })), "SOLVER_MISMATCH");
    assert.equal(errorCode(await post({ quote: quote({ manifestHash: "ab".repeat(32) }), route })), "MANIFEST_MISMATCH");
    assert.equal(errorCode(await post({ quote: quote({ quoteMode: "FIRM_ONCHAIN", reservationId: "cd".repeat(32), quoteNonce: 9n }), route })), "QUOTE_MODE_MISLABELED");
    assert.equal(errorCode(await post({ quote: quote({ validUntilValue: NOW_S, quoteNonce: 11n }), route })), "QUOTE_EXPIRED");
    const otherRoute = routeFor(orderHashHex, order.domain, order.environment, { routeExpiryValue: 600_000n });
    assert.equal(errorCode(await post({ quote: quote({ quoteNonce: 12n }), route: otherRoute })), "ROUTE_MISMATCH");
    const stranger = signedOrder("evidence-order-0009");
    const strangerRoute = routeFor(stranger.orderHashHex, order.domain, order.environment);
    assert.equal(errorCode(await post({ quote: quote({ orderHash: stranger.orderHashHex, route: strangerRoute }), route: strangerRoute })), "ORDER_NOT_FOUND");

    const listed = (await api.plain("GET", `/v1/orders/${orderHashHex}/quotes`)).body as { quotes: readonly { quoteHash: string; quoteMode: string; solverId: string; routeHash: string }[] };
    assert.deepEqual(listed.quotes.map((entry) => [entry.quoteHash, entry.quoteMode, entry.solverId]), [[accepted.body.quoteHashHex, "EXECUTION_COMMITMENT", "solver-a"]]);
    // The exact manifest a quote binds is served for takers to verify the quote key against.
    const bound = (await api.plain("GET", `/v1/solvers/solver-a/manifests/${manifestHash}`)).body as { manifestHash: string; manifest: { solverId: string } };
    assert.equal(bound.manifestHash, manifestHash);
    assert.equal(bound.manifest.solverId, "solver-a");
    assert.equal((await api.plain("GET", `/v1/solvers/solver-b/manifests/${manifestHash}`)).status, 404);
    // A newer quote from the same solver replaces its earlier one in the taker's view.
    const replacement = await post({ quote: quote({ quoteNonce: 21n }), route });
    assert.equal(replacement.status, 200);
    const relisted = (await api.plain("GET", `/v1/orders/${orderHashHex}/quotes`)).body as { quotes: readonly { quoteHash: string }[] };
    assert.deepEqual(relisted.quotes.map((entry) => entry.quoteHash), [replacement.body.quoteHashHex]);
    // A bonded quote is accepted only when an observed bond backs it for its whole life.
    const bonded = (quoteNonce: bigint) => quote({ quoteMode: "FIRM_BONDED", reservationId: "cd".repeat(32), performanceBondId: "b0".repeat(32), quoteNonce });
    assert.equal(errorCode(await post({ quote: bonded(31n), route })), "BOND_UNVERIFIED");
    const bondFor = (expiresAtValue: bigint) => openPerformanceBond({ version: 1, bondId: "b0".repeat(32), solverId: "solver-a", asset: { assetId: "svm:test-domain-1:usdc", assetManifestHash: "55".repeat(32), decimals: 6 } as never, bondAtoms: 1_000_000_000n, coveredFaults: ["FAILED_TO_HONOR_FUNDED_RESERVATION"], maximumPayoutPerClaimAtoms: 500_000_000n, disputeWindowValue: 60n, expiresAtValue });
    OBSERVED_BONDS.set("b0".repeat(32), bondFor(NOW_S + 61n));
    assert.equal(errorCode(await post({ quote: bonded(32n), route })), "BOND_INSUFFICIENT");
    OBSERVED_BONDS.set("b0".repeat(32), bondFor(NOW_S + 86_400n));
    assert.equal((await post({ quote: bonded(33n), route })).status, 200);
    OBSERVED_BONDS.clear();
    // Expired quotes drop out of the taker's view.
    api.setClock(Number(NOW_S + 60n) * 1_000);
    assert.deepEqual(((await api.plain("GET", `/v1/orders/${orderHashHex}/quotes`)).body as { quotes: readonly unknown[] }).quotes, []);
    assert.equal((await api.plain("GET", `/v1/orders/${"ee".repeat(32)}/quotes`)).status, 404);
  });
});

test("a solver records route decisions only for routes it quoted, and takers read them replayed", async () => {
  await withSolverApi(async (api) => {
    const { order, orderHashHex, signature } = signedOrder();
    api.evidence.submitOrder(order, signature);
    const manifestHash = ((await api.plain("GET", "/v1/solvers/solver-a")).body as { manifestHash: string }).manifestHash;
    const route = routeFor(orderHashHex, order.domain, order.environment);
    const quote = signedQuoteFor({ orderHash: orderHashHex, route, environment: order.environment, domain: order.domain, solverId: "solver-a", manifestHash, quoteKey: api.solverKey, validUntilUnit: "EVM_UNIX_SECONDS", validUntilValue: NOW_S + 60n });
    assert.equal((await api.call("POST", "/v1/solver/order-quotes", { quote, route })).status, 200);
    const quotedRoute = toHex(routeHash(route));
    const eligible = (routeHashHex: string, expectedNetOutcomeAtoms: bigint) => ({
      routeHash: routeHashHex,
      expectedNetOutcomeAtoms,
      feesAtoms: 5n,
      marginAtoms: 500n,
      residualAtoms: 0n,
      recoveryBoundAtoms: 20n,
      completionCohortBps: 9_900n,
      deliveryPolicyId: "public-relay",
      resourceHeadroomBps: 4_000n,
    });
    const decision = (overrides: Record<string, unknown> = {}) => ({
      decisionVersion: 1,
      orderHash: orderHashHex,
      solverId: "solver-a",
      stateSnapshots: [{ domainId: order.domain.domainId, sourceId: "rpc-a", sequence: 9n, receivedAtValue: 95n, stateHash: "a1".repeat(32) }],
      normalizationPolicyHash: "a2".repeat(32),
      objective: { kind: "MAXIMIZE_NET_OUTCOME", maximumResidualAtoms: 50n, maximumStateAgeValue: 50n, maximumSourceSkewValue: 20n },
      eligible: [eligible(quotedRoute, 100n), eligible("a3".repeat(32), 90n)],
      excluded: [],
      selectedRouteHash: quotedRoute,
      resourcePlanHash: "a4".repeat(32),
      decisionAtValue: 100n,
      quoteToSubmitBudgetValue: 2n,
      ...overrides,
    });
    const post = (body: unknown) => api.call("POST", "/v1/solver/routes/decision", { decision: body });
    const recorded = await post(decision());
    assert.equal(recorded.status, 200, JSON.stringify(toProtocolJson(recorded.body)));
    assert.equal((recorded.body.replay as { valid: boolean }).valid, true);
    assert.equal((await post(decision())).body.replayed, true);
    // A decision that picks the wrong winner is kept on the record, marked by its replay.
    const loser = await post(decision({ eligible: [eligible(quotedRoute, 80n), eligible("a3".repeat(32), 90n)] }));
    assert.deepEqual((loser.body.replay as { discrepancies: readonly string[] }).discrepancies, ["SELECTED_NOT_WINNER"]);
    const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code: string }).code;
    assert.equal(code(await post(decision({ selectedRouteHash: "a3".repeat(32) }))), "ROUTE_NOT_QUOTED");
    assert.equal(code(await post(decision({ solverId: "solver-b" }))), "SOLVER_MISMATCH");
    assert.equal(code(await post(decision({ orderHash: "ee".repeat(32) }))), "ORDER_NOT_FOUND");
    assert.equal(code(await post(decision({ decisionVersion: 2 }))), "INVALID_DECISION");

    const read = (await api.plain("GET", `/v1/orders/${orderHashHex}/route-decisions`)).body as { decisions: readonly { decisionHash: string; replay: { valid: boolean } }[] };
    assert.deepEqual(read.decisions.map((entry) => [entry.decisionHash, entry.replay.valid]), [
      [recorded.body.decisionHashHex, true],
      [loser.body.decisionHashHex, false],
    ]);
  });
});

test("route simulation dry-runs admission on the server's registry state and reports failures honestly", async () => {
  const { order, orderHashHex } = signedOrder();
  const unavailable = async (api: Harness) => {
    const manifestHash = ((await api.plain("GET", "/v1/solvers/solver-a")).body as { manifestHash: string }).manifestHash;
    const route = routeFor(orderHashHex, order.domain, order.environment);
    const quote = signedQuoteFor({ orderHash: orderHashHex, route, environment: order.environment, domain: order.domain, solverId: "solver-a", manifestHash, quoteKey: api.solverKey, validUntilUnit: "EVM_UNIX_SECONDS", validUntilValue: NOW_S + 60n });
    return { route, quote };
  };
  await withSolverApi(async (api) => {
    const { route, quote } = await unavailable(api);
    const response = await api.call("POST", "/v1/solver/routes/simulate", { order, quote, route, atSlot: 1_000_600n });
    assert.equal((response.body.error as { code: string }).code, "ADMISSION_UNAVAILABLE");
  });
  // A context for another domain's manifest cannot admit this order, and says why.
  const context = { domainManifest: DOMAIN_MANIFEST, templateManifest: {}, templateRegistryRecord: {}, feePolicyManifest: {}, activeRegistryRecords: [] } as unknown as AdmissionContext;
  await withSolverApi(async (api) => {
    const { route, quote } = await unavailable(api);
    const code = (response: { body: Record<string, unknown> }) => (response.body.error as { code: string }).code;
    assert.equal(code(await api.call("POST", "/v1/solver/routes/simulate", { order, quote, route })), "TIME_REQUIRED");
    assert.equal(code(await api.call("POST", "/v1/solver/routes/simulate", { order, quote: { ...quote, solverId: "solver-b" }, route, atSlot: 1n })), "SOLVER_MISMATCH");
    const simulated = await api.call("POST", "/v1/solver/routes/simulate", { order, quote, route, atSlot: 1_000_600n });
    assert.equal(simulated.status, 200, JSON.stringify(toProtocolJson(simulated.body)));
    assert.equal(simulated.body.simulated, true);
    assert.equal(simulated.body.admitted, false);
    assert.equal(simulated.body.timeSource, "CALLER");
    assert.equal(simulated.body.signatureValid, true);
    assert.equal(typeof (simulated.body.error as { detail: string }).detail, "string");
  }, [RFQ_SUITE], new Map([[order.domain.domainId, context]]));
});

test("the private RFQ relay stores ciphertext only, fails closed without a pinned suite, and binds responses", async () => {
  const taker = rfqSender();
  const envelope = (overrides: Record<string, unknown> = {}): PrivateRfqEnvelopeInput => ({
    envelopeVersion: 1,
    environment: "testnet",
    domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)),
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    orderHash: "55".repeat(32),
    senderKeyId: taker.keyId,
    responseEncryptionKey: new Uint8Array(32).fill(7),
    recipientSolverId: "solver-a",
    recipientEncryptionKeyId: "rfq-1",
    encryptionSuiteId: RFQ_SUITE,
    ciphertextHash: new Uint8Array(createHash("sha256").update(Buffer.from("sealed-order")).digest()),
    createdAtUnit: "EVM_UNIX_SECONDS",
    createdAtValue: NOW_S - 5n,
    expiresAtUnit: "EVM_UNIX_SECONDS",
    expiresAtValue: NOW_S + 60n,
    envelopeNonce: 1n,
    ...overrides,
  });
  const ciphertext = new Uint8Array(Buffer.from("sealed-order"));
  await withSolverApi(async (api) => {
    const closed = await api.plain("POST", "/v1/rfqs/private", { envelopes: [taker.entry(envelope(), ciphertext)] });
    assert.equal((closed.body.error as { code: string }).code, "PRIVATE_PATH_UNAVAILABLE");
  }, []);
  await withSolverApi(async (api) => {
    type Results = { results: readonly { admitted: boolean; envelopeHashHex?: string; reason?: string }[] };
    // Nobody but the sender key can spend its nonces: a squatter signing with its own key, an
    // unsigned entry, and a key id that is not a key are all refused before any nonce is checked.
    const squatter = rfqSender();
    const squat = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [{ envelope: envelope(), ciphertext, senderSignature: squatter.signEnvelope(envelope()) }] })).body as Results;
    assert.equal(squat.results[0]?.reason, "SENDER_UNAUTHENTICATED");
    const unsigned = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [{ envelope: envelope(), ciphertext }] })).body as Results;
    assert.equal(unsigned.results[0]?.reason, "SENDER_UNAUTHENTICATED");
    const named = envelope({ senderKeyId: "taker-key-1" });
    const notKey = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [{ envelope: named, ciphertext, senderSignature: taker.signEnvelope(named) }] })).body as Results;
    assert.equal(notKey.results[0]?.reason, "SENDER_UNAUTHENTICATED");

    const submitted = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [taker.entry(envelope(), ciphertext)] })).body as Results;
    assert.equal(submitted.results[0]?.admitted, true);
    const hash = submitted.results[0]?.envelopeHashHex as string;
    const replay = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [taker.entry(envelope(), ciphertext)] })).body as Results;
    assert.equal(replay.results[0]?.reason, "REPLAY");
    const mutated = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [taker.entry(envelope({ envelopeNonce: 2n }), new Uint8Array([1, 2, 3]))] })).body as Results;
    assert.equal(mutated.results[0]?.reason, "CIPHERTEXT_MUTATED");

    const pending = (await api.call("GET", "/v1/solver/private-rfqs")).body as { envelopes: readonly { envelopeHash: string; ciphertext: Uint8Array; senderSignature?: Uint8Array }[] };
    assert.deepEqual(pending.envelopes.map((entry) => entry.envelopeHash), [hash]);
    assert.deepEqual([...(pending.envelopes[0]?.senderSignature ?? [])], [...taker.signEnvelope(envelope())]);
    assert.equal(((await api.plain("GET", `/v1/rfqs/private/${hash}`)).body as { acknowledged: boolean }).acknowledged, false);
    const prematureAcceptance = await api.plain("POST", `/v1/rfqs/private/${hash}/accept`, {});
    assert.equal(prematureAcceptance.status, 409);
    assert.equal((prematureAcceptance.body.error as { code: string }).code, "PRIVATE_RFQ_RESPONSE_PENDING");
    assert.equal((await api.call("POST", `/v1/solver/private-rfqs/${hash}/ack`)).status, 200);
    assert.equal(((await api.plain("GET", `/v1/rfqs/private/${hash}`)).body as { acknowledged: boolean }).acknowledged, true);
    const response = (key: Uint8Array) => ({ quoteHash: "66".repeat(32), quoteOrderHash: "55".repeat(32), responseEncryptionKey: key, responseCiphertext: new Uint8Array([9, 9, 9]) });
    const substituted = await api.call("POST", `/v1/solver/private-rfqs/${hash}/response`, response(new Uint8Array(32).fill(6)));
    assert.equal((substituted.body.error as { code: string }).code, "RESPONSE_KEY_SUBSTITUTED");
    assert.equal((await api.call("POST", `/v1/solver/private-rfqs/${hash}/response`, response(new Uint8Array(32).fill(7)))).status, 200);
    const status = (await api.plain("GET", `/v1/rfqs/private/${hash}`)).body as { response?: { responseCiphertext: Uint8Array } };
    assert.deepEqual([...(status.response?.responseCiphertext ?? [])], [9, 9, 9]);
    const acceptance = await api.plain("POST", `/v1/rfqs/private/${hash}/accept`, {});
    assert.equal(acceptance.status, 503);
    assert.equal((acceptance.body.error as { code: string }).code, "STRATEGY_PACKAGE_STORE_UNAVAILABLE");
  });
});

test("expired envelopes cannot starve the inbox and a rejected batch delivers nothing", async () => {
  const ciphertext = new Uint8Array(Buffer.from("sealed-order"));
  const spammer = rfqSender();
  const taker = rfqSender();
  const batcher = rfqSender();
  const envelope = (nonce: bigint, expiresInSeconds: bigint): PrivateRfqEnvelopeInput => ({
    envelopeVersion: 1,
    environment: "testnet",
    domain: domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST)),
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    orderHash: "55".repeat(32),
    senderKeyId: spammer.keyId,
    responseEncryptionKey: new Uint8Array(32).fill(7),
    recipientSolverId: "solver-a",
    recipientEncryptionKeyId: "rfq-1",
    encryptionSuiteId: RFQ_SUITE,
    ciphertextHash: new Uint8Array(createHash("sha256").update(Buffer.from("sealed-order")).digest()),
    createdAtUnit: "EVM_UNIX_SECONDS",
    createdAtValue: NOW_S - 5n,
    expiresAtUnit: "EVM_UNIX_SECONDS",
    expiresAtValue: NOW_S + expiresInSeconds,
    envelopeNonce: nonce,
  });
  await withSolverApi(async (api) => {
    // More short-lived envelopes than one inbox page, then one that stays live.
    for (let batch = 0; batch < 40; batch += 1) {
      const envelopes = Array.from({ length: 16 }, (_, index) => spammer.entry(envelope(BigInt(batch * 16 + index + 1), 2n), ciphertext));
      assert.equal((await api.plain("POST", "/v1/rfqs/private", { envelopes })).status, 200);
    }
    const live = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [taker.entry({ ...envelope(10_000n, 600n), senderKeyId: taker.keyId }, ciphertext)] })).body as { results: readonly { envelopeHashHex?: string }[] };
    api.setClock(Number(NOW_S + 10n) * 1_000);
    const pending = (await api.call("GET", "/v1/solver/private-rfqs")).body as { envelopes: readonly { envelopeHash: string }[] };
    assert.deepEqual(pending.envelopes.map((entry) => entry.envelopeHash), [live.results[0]?.envelopeHashHex]);

    // A later malformed entry rejects the whole batch before the good entry is stored.
    const good = batcher.entry({ ...envelope(20_000n, 600n), senderKeyId: batcher.keyId }, ciphertext);
    const rejected = await api.plain("POST", "/v1/rfqs/private", { envelopes: [good, { ...good, ciphertext: "not-bytes" }] });
    assert.equal(rejected.status, 400);
    const retried = (await api.plain("POST", "/v1/rfqs/private", { envelopes: [good] })).body as { results: readonly { admitted: boolean }[] };
    assert.equal(retried.results[0]?.admitted, true);
    const missing = await api.plain("POST", "/v1/rfqs/private", { envelopes: [{ ciphertext }] });
    assert.equal(missing.status, 400);
  });
});

test("a sealed auction accepts commits before its deadline, reveals after, and publishes a replayable result", async () => {
  await withSolverApi(async (api) => {
    const definition = {
      version: 1,
      auctionId: "auction-1",
      environment: "testnet",
      orderHash: "55".repeat(32),
      eligibleSolverIds: ["solver-a"],
      timeUnit: "EVM_UNIX_SECONDS",
      commitDeadlineValue: NOW_S + 10n,
      revealDeadlineValue: NOW_S + 20n,
      settlementDeadlineValue: NOW_S + 30n,
      minimumValidReveals: 1,
    };
    const created = (await api.plain("POST", "/v1/auctions/sealed", { definition })).body as { auctionHashHex: string };
    const hash = created.auctionHashHex;
    const discovered = (await api.call("GET", "/v1/solver/auctions?after=0")).body as {
      auctions: readonly { cursor: number; auctionHash: string; definition: { auctionId: string } }[];
      nextCursor: number;
    };
    assert.deepEqual(discovered.auctions.map((entry) => [entry.auctionHash, entry.definition.auctionId]), [[hash, "auction-1"]]);
    assert.deepEqual(((await api.call("GET", `/v1/solver/auctions?after=${discovered.nextCursor}`)).body as { auctions: readonly unknown[] }).auctions, []);
    assert.equal((await api.call("GET", "/v1/solver/auctions?after=-1")).status, 400);
    const salt = new Uint8Array(32).fill(4);
    const opening = { solverId: "solver-a", quoteHash: "77".repeat(32), netOutcomeAtoms: 500n, salt };
    const commitment = sealedQuoteCommitment(hash, opening);
    assert.equal((await api.call("POST", `/v1/solver/auctions/${hash}/commit`, { commitment: toHex(commitment) })).status, 200);
    assert.equal((await api.call("POST", `/v1/solver/auctions/${hash}/commit`, { commitment: toHex(commitment) })).status, 200);
    const prematureAward = await api.plain("POST", `/v1/auctions/sealed/${hash}/award`, {});
    assert.equal(prematureAward.status, 409);
    assert.equal((prematureAward.body.error as { code: string }).code, "AUCTION_NOT_CLOSED");
    const early = await api.call("POST", `/v1/solver/auctions/${hash}/reveal`, { quoteHash: opening.quoteHash, netOutcomeAtoms: 500n, salt });
    assert.equal((early.body.error as { code: string }).code, "EARLY_REVEAL");
    assert.deepEqual(((await api.plain("GET", `/v1/auctions/sealed/${hash}`)).body as { phase: string; commitmentCount: number }).commitmentCount, 1);
    api.setClock(NOW_MS + 11_000);
    assert.equal((await api.call("POST", `/v1/solver/auctions/${hash}/reveal`, { quoteHash: opening.quoteHash, netOutcomeAtoms: 500n, salt })).status, 200);
    assert.equal((await api.call("POST", `/v1/solver/auctions/${hash}/reveal`, { quoteHash: opening.quoteHash, netOutcomeAtoms: 500n, salt })).status, 200);
    const view = (await api.plain("GET", `/v1/auctions/sealed/${hash}`)).body as { phase: string; result: { outcome: string; winner: { solverId: string } }; events: readonly unknown[] };
    assert.deepEqual([view.phase, view.result.outcome, view.result.winner.solverId, view.events.length], ["CLOSED", "AWARDED", "solver-a", 2]);
    assert.equal((await api.plain("POST", "/v1/auctions/sealed", { definition: { ...definition, eligibleSolverIds: ["solver-x"] } })).status, 400);
  });
});

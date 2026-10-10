import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assetRef,
  domainRef,
  fromProtocolJson,
  commitmentHash,
  toProtocolJson,
  packageAllocationHash,
  packageBookAmendmentBytes,
  packageBookAmendmentHash,
  packageMatchingPolicy,
  packageTakerOrderHash,
  packageSettlementCommitment,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  packageBookCancellationBytes,
  packageBookCancellationHash,
  packageReopeningResultHash,
  packageReopeningSettlementHandoffHash,
  packageReopeningSnapshotHash,
  toHex,
  verifyNettingResult,
  verifyNettingResultAgainstPolicy,
  verifyPackageAllocation,
  verifyPackageReopeningSettlementHandoff,
  versionedManifestRef,
  type NettingObligationInput,
  type NettingPolicyManifestInput,
  type PackageAllocation,
  type PackageMatchingPolicy,
} from "@naryx/protocol-types";
import {
  createPrivateTerminalServer,
  createPublicApiHandler,
  GeneralizedStrategyQuoteClientError,
  loadPublicMarketRuntime,
  PublicMarketConfigError,
  SqlitePackageExchangeStore,
  SqliteRegistryStore,
  type PublicApiOptions,
} from "../src/index.js";
import { DOMAIN_MANIFEST, operatorKeys, signedSolverManifest } from "./registry-fixtures.js";
import { CALENDAR_SERIES, CLASS, CLASS_SUPPORT, NEAR_BASIS_SERIES, NOW, SERIES, SERIES_SUPPORT, id, impliedAsk, order, registerAll, settlement } from "./exchange-fixtures.js";

const NETTING_POLICY: NettingPolicyManifestInput = {
  schemaVersion: 1,
  manifestVersion: 1,
  nettingPolicyVersion: 2,
  environment: "testnet",
  executionClassId: CLASS,
  executionClassVersion: 1,
  executionClassManifestHash: id(85),
  settlementClass: "BATCHED_IOC_WITH_RECOVERY",
  allocationRule: "PRO_RATA_SEQUENCE",
  externalExecutionMode: "EXACT_NET_ONLY",
  clearingRule: "LIMIT_MIDPOINT_BUYER_FAVOR",
  maximumObligations: 16,
  maximumBatchWindowMilliseconds: 500n,
  instruments: [{
    instrumentId: "sol",
    domain: domainRef("svm:solana-devnet", 1, id(86)),
    adapter: { adapterId: "phoenix-perps", adapterManifestVersion: 1, adapterManifestHash: id(87) },
    venue: versionedManifestRef("phoenix", 1, id(88)),
    market: versionedManifestRef("sol-perp", 1, id(89)),
    quantityAsset: assetRef("sol", id(90), 9),
    quoteAsset: assetRef("usdc", id(91), 6),
    legFamily: "PERP_OPEN",
    quantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
  }],
};

const nettingObligation = (n: number, ownerId: string, signedQuantityAtoms: bigint): NettingObligationInput => ({
  ownerId,
  strategyOrderHash: id(100 + n),
  packageOrderId: id(110 + n),
  settlementReadinessHash: id(120 + n),
  legId: `leg-${n}`,
  instrumentId: "sol",
  signedQuantityAtoms,
  limitPriceTicks: signedQuantityAtoms > 0n ? 12n : 8n,
  sequence: BigInt(n),
});

function submitBookOrder(store: SqlitePackageExchangeStore, input: ReturnType<typeof order>) {
  return store.submitOrder(CLASS, input, NOW, settlement(input));
}

function haltBook(store: SqlitePackageExchangeStore, incident: number) {
  const book = store.getBook(CLASS)!;
  const policy = packageMatchingPolicy(store.getMatchingPolicy(book.matchingPolicyHash)!);
  return store.haltBook({
    version: 1,
    executionClassId: CLASS,
    expectedOpenSnapshotHash: packageReopeningSnapshotHash(policy, book),
    incidentEvidenceHash: id(incident),
    reasonCode: "test-incident",
  });
}

async function withMarket(
  run: (get: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown; text: string }>, store: SqlitePackageExchangeStore) => Promise<void>,
  overrides: Partial<PublicApiOptions> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-"));
  const store = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const handler = createPublicApiHandler({ exchange: store, nowValue: () => NOW, rateLimit: { windowMs: 60_000, maxRequests: 1_000 }, ...overrides });
  const server = createServer((request, response) => {
    if (!handler(request, response)) {
      response.statusCode = 418;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (path: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : fromProtocolJson(JSON.parse(text)), text };
  };
  try {
    await run(get, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("depth keeps direct and implied quantity apart within a level", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    store.addImpliedLiquidity(CLASS, { quote: impliedAsk(1, 1, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    const { status, body } = await get(`/v1/markets/${CLASS}/package-depth`);
    assert.equal(status, 200);
    const book = body as { halted: boolean; asks: readonly { priceTicks: bigint; directQuantity: bigint; impliedQuantity: bigint }[]; bids: readonly unknown[] };
    assert.equal(book.halted, false);
    assert.deepEqual(book.bids, []);
    assert.deepEqual(book.asks, [{ priceTicks: 100n, directQuantity: 10n, impliedQuantity: 20n }]);
    assert.equal((await get("/v1/markets/unknown-class/package-depth")).status, 404);
  });
});

test("advanced-order activation registration and status use the configured durable runtime", async () => {
  const orderHash = id(8_001);
  const condition = {
    conditionVersion: 1,
    metric: "TIME",
    comparator: "AT_OR_ABOVE",
    threshold: 1_000n,
    observationUnit: "EVM_UNIX_SECONDS",
    maximumObservationAge: 0n,
  } as const;
  const view = {
    orderHashHex: orderHash,
    order: { packageOrderType: "CONDITIONAL" },
    condition,
    status: "WAITING",
    progress: { executedQuantity: 0n, executedNotionalTicks: 0n, attemptedSlices: 0, failedSlices: 0 },
    attempts: [],
    registeredAtMs: 1,
    updatedAtMs: 1,
  } as never;
  let registered = false;
  await withMarket(async (request) => {
    const post = await request("/v1/order-activations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toProtocolJson({ orderHash, condition })),
    });
    assert.equal(post.status, 200);
    assert.equal((post.body as { created: boolean }).created, true);
    assert.equal(registered, true);
    const read = await request(`/v1/order-activations/${orderHash}`);
    assert.equal(read.status, 200);
    assert.equal((read.body as { orderHashHex: string }).orderHashHex, orderHash);
  }, {
    orderActivations: {
      register: (input) => {
        registered = input.orderHashHex === orderHash && input.condition?.metric === "TIME";
        return { created: true, view };
      },
      view: (requested) => requested === orderHash ? view : undefined,
    },
  });
});

test('native clearing reads remain optional and event pages are bounded', async () => {
  const domain = {
    policy: { clearingDomainId: 'sol-carry-clearing' },
    state: { openInterestAtoms: 10n },
  };
  const events = [{
    kind: 'MATCH',
    eventHashHex: id(200),
    policyHashHex: id(201),
    sequence: 1,
    sourceSequence: 1,
    payload: {},
    recordedAtMs: 1,
  }];
  const nativeClearing = {
    domains: () => [domain],
    domain: (clearingDomainId: string) => clearingDomainId === 'sol-carry-clearing' ? domain : undefined,
    accounts: () => [],
    account: () => undefined,
    latestMark: () => undefined,
    defaultAuction: () => { throw new Error('unused'); },
    events: (_clearingDomainId: string, after: number, limit: number) => after === 0 && limit === 1 ? events : [],
  } as unknown as NonNullable<PublicApiOptions['nativeClearing']>;
  await withMarket(async (get) => {
    const domains = await get('/v1/native-clearing/domains');
    assert.equal(domains.status, 200);
    assert.deepEqual((domains.body as { domains: unknown[] }).domains, [domain]);
    const page = await get('/v1/native-clearing/domains/sol-carry-clearing/events?after=0&limit=1');
    assert.equal(page.status, 200);
    assert.deepEqual((page.body as { events: unknown[] }).events, events);
    assert.equal((await get('/v1/native-clearing/domains/sol-carry-clearing/events?limit=501')).status, 400);
  }, { nativeClearing });

  await withMarket(async (get) => {
    assert.equal((await get('/v1/native-clearing/domains')).status, 503);
  });
});

test("the tape pages by cursor and omits participant and taker order identities", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    submitBookOrder(store, order(2, { side: "BID", timeInForce: "IOC" }));
    const first = await get(`/v1/markets/${CLASS}/package-tape?limit=1`);
    assert.equal(first.status, 200);
    const tape = first.body as { trades: readonly { cursor: number; allocationHash: string; fills: readonly unknown[] }[]; nextCursor: number };
    assert.equal(tape.trades.length, 1);
    for (const hidden of ["maker-1", "maker-2", "group-1", id(1), id(2), "participantId", "consumedSourceKeys"]) {
      assert.equal(first.text.includes(hidden), false, hidden);
    }
    // The resting order produced no fill, so the tape holds exactly the one trade.
    assert.equal(tape.trades[0]?.fills.length, 1);
    submitBookOrder(store, order(3));
    submitBookOrder(store, order(4, { side: "BID", timeInForce: "IOC" }));
    const next = await get(`/v1/markets/${CLASS}/package-tape?after=${tape.nextCursor}&limit=1`);
    const page = next.body as { trades: readonly { fills: readonly unknown[] }[]; nextCursor: number };
    assert.equal(page.trades.length, 1);
    assert.equal(page.trades[0]?.fills.length, 1);
    const rest = await get(`/v1/markets/${CLASS}/package-tape?after=${page.nextCursor}`);
    assert.deepEqual((rest.body as { trades: readonly unknown[] }).trades, []);
    assert.equal((await get("/v1/markets/unknown-class/package-tape")).status, 404);
  });
});

test("allocation evidence verifies independently against the served policy", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    submitBookOrder(store, order(2, { side: "BID", timeInForce: "IOC" }));
    const { status, body } = await get(`/v1/allocations/${id(2)}`);
    assert.equal(status, 200);
    const { allocation, matchingPolicy } = body as { allocation: PackageAllocation; matchingPolicy: PackageMatchingPolicy };
    verifyPackageAllocation(packageMatchingPolicy(matchingPolicy), allocation);
    const tape = (await get(`/v1/markets/${CLASS}/package-tape`)).body as { trades: readonly { allocationHash: string }[] };
    assert.ok(tape.trades.some((trade) => trade.allocationHash === toHex(packageAllocationHash(allocation))));
    assert.equal((await get(`/v1/allocations/${id(77)}`)).status, 404);
  });
});

test("reopening evidence is published with independently verifiable settlement handoffs", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    const halt = haltBook(store, 700);
    const haltEvidence = await get(`/v1/package-book/halts/${halt.haltHashHex}`);
    assert.equal(haltEvidence.status, 200, haltEvidence.text);
    assert.deepEqual(
      [
        (haltEvidence.body as { haltHashHex: string }).haltHashHex,
        (haltEvidence.body as { haltedSnapshotHashHex: string }).haltedSnapshotHashHex,
      ],
      [halt.haltHashHex, halt.haltedSnapshotHashHex],
    );
    const ask = order(1, { side: "ASK", limitPriceTicks: 95n });
    const bid = order(2, { side: "BID", limitPriceTicks: 105n });
    store.queueReopeningOrder(CLASS, ask, NOW, settlement(ask));
    store.queueReopeningOrder(CLASS, bid, NOW, settlement(bid));
    const opening = store.getBook(CLASS)!;
    const cleared = store.clearReopeningAuction(
      CLASS,
      id(800),
      packageReopeningSnapshotHash(packageMatchingPolicy(store.getMatchingPolicy(opening.matchingPolicyHash)!), opening),
      id(900),
      100n,
      NOW,
    );
    const resultHash = toHex(packageReopeningResultHash(cleared.result));
    const response = await get(`/v1/package-book/reopenings/${resultHash}`);
    assert.equal(response.status, 200, response.text);
    const body = response.body as {
      resultHash: string;
      settlementHandoffHash: string;
      result: typeof cleared.result;
      settlementHandoff: NonNullable<typeof cleared.settlementHandoff>;
    };
    assert.equal(body.resultHash, resultHash);
    assert.equal(body.settlementHandoffHash, toHex(packageReopeningSettlementHandoffHash(body.settlementHandoff)));
    assert.doesNotThrow(() => verifyPackageReopeningSettlementHandoff(body.result, body.settlementHandoff));
    assert.equal((await get(`/v1/package-book/reopenings/${id(999)}`)).status, 404);
  });
});

test("writes, malformed requests, and unknown parameters are refused", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    assert.equal((await get(`/v1/markets/${CLASS}/package-depth`, { method: "PUT" })).status, 405);
    assert.equal((await get(`/v1/markets/${CLASS}/package-depth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
    for (const path of [
      `/v1/markets/${CLASS}/package-depth?side=BID`,
      `/v1/markets/${CLASS}/package-tape?limit=101`,
      `/v1/markets/${CLASS}/package-tape?after=-1`,
      `/v1/markets/${CLASS}/package-tape?after=1&after=2`,
      "/v1/markets/bad%20id/package-depth",
      "/v1/allocations/XYZ",
    ]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal((await get("/v1/other")).status, 404);
    assert.equal((await get("/internal/healthz")).status, 418);
  });
});

test("requests are rate limited per client window", async () => {
  let now = 0;
  await withMarket(
    async (get, store) => {
      registerAll(store);
      assert.equal((await get(`/v1/markets/${CLASS}/package-depth`)).status, 200);
      assert.equal((await get(`/v1/markets/${CLASS}/package-depth`)).status, 200);
      assert.equal((await get(`/v1/markets/${CLASS}/package-depth`)).status, 429);
      now = 1_000;
      assert.equal((await get(`/v1/markets/${CLASS}/package-depth`)).status, 200);
    },
    { rateLimit: { windowMs: 1_000, maxRequests: 2 }, clockMs: () => now },
  );
});

test("the runtime is off by default and validates its configuration", () => {
  assert.equal(loadPublicMarketRuntime({}), undefined);
  assert.throws(() => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "yes" }), PublicMarketConfigError);
  assert.throws(() => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "true" }), /NARYX_EXCHANGE_DB is required/);
  assert.throws(
    () => loadPublicMarketRuntime({ NARYX_PUBLIC_MARKET_ENABLED: "true", NARYX_EXCHANGE_DB: "relative.db" }),
    /absolute path/,
  );
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-config-"));
  try {
    const manifest = join(dir, "support.json");
    const env = { NARYX_PUBLIC_MARKET_ENABLED: "true", NARYX_EXCHANGE_DB: join(dir, "exchange.sqlite"), NARYX_EXCHANGE_SUPPORT_MANIFEST: manifest };
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "SOLANA_SLOT", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
    assert.throws(() => loadPublicMarketRuntime(env), /slot source/);
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT, extra: true }));
    assert.throws(() => loadPublicMarketRuntime(env), /version 1 with clockUnit/);
    writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
    assert.throws(() => loadPublicMarketRuntime({ ...env, NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE: "0" }), /between 1 and 10000/);
    assert.throws(() => loadPublicMarketRuntime({
      ...env,
      NARYX_SOLANA_DEVNET_NETTING_SETTLEMENT_ENABLED: "true",
    }), /require NARYX_NETTING_ALLOCATION_SETTLEMENT_ENABLED=true/);
    assert.throws(() => loadPublicMarketRuntime({
      ...env,
      NARYX_NETTING_ALLOCATION_SETTLEMENT_ENABLED: "true",
    }), /restricted to NARYX_PUBLIC_ENVIRONMENT=testnet/);
    const runtime = loadPublicMarketRuntime(env);
    assert.ok(runtime);
    assert.equal(runtime.clockUnit, "UNIX_SECONDS");
    assert.equal(runtime.requestsPerMinute, 120);
    assert.equal(runtime.listener, undefined);
    runtime.close();
    assert.throws(() => loadPublicMarketRuntime({ ...env, NARYX_PUBLIC_API_PORT: "70000" }), /between 1 and 65535/);
    assert.throws(() => loadPublicMarketRuntime({ ...env, NARYX_PUBLIC_API_HOST: "0.0.0.0" }), /requires NARYX_PUBLIC_API_PORT/);
    const separate = loadPublicMarketRuntime({ ...env, NARYX_PUBLIC_API_PORT: "8788", NARYX_PUBLIC_API_HOST: "0.0.0.0" });
    assert.deepEqual(separate?.listener, { host: "0.0.0.0", port: 8788 });
    separate?.close();
    const qualificationDb = { ...env, NARYX_QUALIFICATION_DB: join(dir, "qualification.sqlite") };
    assert.throws(() => loadPublicMarketRuntime(qualificationDb), /requires NARYX_QUALIFICATION_AUTHORITIES/);
    const key = "4".repeat(44);
    assert.throws(() => loadPublicMarketRuntime({ ...qualificationDb, NARYX_QUALIFICATION_AUTHORITIES: "key-1:not-a-key", NARYX_QUALIFICATION_ACTIVATION_DELAY: "10" }), /distinct keyId:base58/);
    assert.throws(() => loadPublicMarketRuntime({ ...qualificationDb, NARYX_QUALIFICATION_AUTHORITIES: `key-1:${key}` }), /ACTIVATION_DELAY/);
    const qualified = loadPublicMarketRuntime({ ...qualificationDb, NARYX_QUALIFICATION_AUTHORITIES: `key-1:${key}`, NARYX_QUALIFICATION_ACTIVATION_DELAY: "10" });
    assert.ok(qualified);
    qualified?.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the private terminal server answers public market routes before its origin policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-market-mount-"));
  const manifest = join(dir, "support.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, clockUnit: "UNIX_SECONDS", seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT }));
  const runtime = loadPublicMarketRuntime({
    NARYX_PUBLIC_MARKET_ENABLED: "true",
    NARYX_EXCHANGE_DB: join(dir, "exchange.sqlite"),
    NARYX_EXCHANGE_SUPPORT_MANIFEST: manifest,
  });
  assert.ok(runtime);
  const server = createPrivateTerminalServer(
    { host: "127.0.0.1", port: 0, terminalOrigin: null },
    {}, undefined, undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, runtime.handler,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const book = await fetch(`http://127.0.0.1:${port}/v1/markets/${CLASS}/package-depth`, { headers: { Origin: "https://reader.example" } });
    assert.equal(book.status, 404);
    assert.equal(book.headers.get("access-control-allow-origin"), "*");
    const privateRoute = await fetch(`http://127.0.0.1:${port}/internal/healthz`, { headers: { Origin: "https://reader.example" } });
    assert.equal(privateRoute.status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/healthz`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(toProtocolJson(body)),
});

test("signed public package orders create durable settlement handoffs and replay idempotently", async () => {
  const strategies = new Map<string, unknown>();
  const requestedQuotes: { orderHash: string; idempotencyKey: string }[] = [];
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    const keys = generateKeyPairSync("ed25519");
    const participantId = bs58.encode((keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
    const draft = order(9, {
      orderId: "00".repeat(32),
      side: "BID",
      timeInForce: "IOC",
      participantId,
      commonControlGroupId: participantId,
    });
    const orderId = toHex(packageTakerOrderHash(draft));
    const signed = { ...draft, orderId };
    const settlementCommitment = packageSettlementCommitment({
      version: 1,
      environment: "local",
      executionClassId: CLASS,
      packageOrderId: orderId,
      strategyOrderHash: id(7_001),
      graphHash: id(7_002),
      participantId,
      settlementAccount: "solana-settlement-account",
      quantity: signed.quantity,
      validUntilUnit: "SOLANA_SLOT",
      validUntilValue: 2_000n,
    });
    const strategyOrder = {
      environment: "local",
      executionClassId: CLASS,
      graphHash: settlementCommitment.graphHash,
      owner: participantId,
      settlementAccount: "solana-settlement-account",
      economicQuantity: { atoms: signed.quantity },
      packageOrderType: signed.orderType,
      packageTimeInForce: signed.timeInForce,
      expiryUnit: "SOLANA_SLOT",
      expiryValue: 2_000n,
    };
    strategies.set(id(7_001), { orderHashHex: id(7_001), graphHashHex: id(7_002), order: strategyOrder, graph: {}, recordedAtMs: 1 });
    const authorization = {
      scheme: "ED25519",
      signature: bs58.encode(sign(null, Buffer.from(packageSettlementCommitmentBytes(settlementCommitment)), keys.privateKey)),
    };
    const authorizationChallenge = await get("/v1/package-book/orders/authorization", post({ order: signed, settlementCommitment }));
    assert.equal(authorizationChallenge.status, 200, authorizationChallenge.text);
    assert.deepEqual(authorizationChallenge.body, {
      version: 1,
      scheme: "ED25519",
      participantId,
      packageOrderId: orderId,
      settlementCommitmentHash: toHex(packageSettlementCommitmentHash(settlementCommitment)),
      messageHex: toHex(packageSettlementCommitmentBytes(settlementCommitment)),
    });
    const first = await get("/v1/package-book/orders", post({ order: signed, settlementCommitment, authorization }));
    assert.equal(first.status, 200, first.text);
    const accepted = first.body as {
      accepted: boolean;
      replayed: boolean;
      orderId: string;
      allocationHash: string;
      settlementCommitmentHash: string;
      settlementHandoffHash: string;
      allocation: PackageAllocation;
      matchingPolicy: PackageMatchingPolicy;
    };
    assert.deepEqual([accepted.accepted, accepted.replayed, accepted.orderId, accepted.allocation.fills.length], [true, false, orderId, 1]);
    assert.equal(accepted.settlementCommitmentHash.length, 64);
    assert.equal(accepted.settlementHandoffHash.length, 64);
    verifyPackageAllocation(packageMatchingPolicy(accepted.matchingPolicy), accepted.allocation);
    assert.equal(accepted.allocationHash, toHex(packageAllocationHash(accepted.allocation)));
    assert.equal(((await get("/v1/package-book/orders", post({ order: signed, settlementCommitment, authorization }))).body as { replayed: boolean }).replayed, true);
    assert.equal(store.getAllocation(orderId)?.fills.length, 1);
    assert.ok(store.settlementHandoff(accepted.allocationHash));
    const progressResponse = await get(`/v1/package-book/orders/${orderId}/settlement-readiness`);
    assert.equal(progressResponse.status, 200);
    const progress = progressResponse.body as {
      readiness: { status: string };
      readinessHashHex: string;
      obligations: readonly unknown[];
    };
    assert.equal(progress.readiness.status, "READY_FOR_OWNER_AUTHORIZATION");
    assert.equal(progress.readinessHashHex.length, 64);
    assert.equal(progress.obligations.length, 1);
    const quoteRequest = await get("/v1/package-book/settlement-quotes/request", post({
      packageOrderId: orderId,
      idempotencyKey: "settlement-quote-0001",
    }));
    assert.equal(quoteRequest.status, 409);
    assert.deepEqual(requestedQuotes, [{ orderHash: id(7_001), idempotencyKey: "settlement-quote-0001" }]);
    const recoveredResponse = await get(`/v1/allocations/${orderId}`);
    assert.equal(recoveredResponse.status, 200);
    const recovered = recoveredResponse.body as {
      allocationHash: string;
      settlementCommitmentHash: string;
      settlementHandoffHash: string;
    };
    assert.deepEqual(
      [recovered.allocationHash, recovered.settlementCommitmentHash, recovered.settlementHandoffHash],
      [accepted.allocationHash, accepted.settlementCommitmentHash, accepted.settlementHandoffHash],
    );

    const changed = { ...signed, quantity: 20n };
    assert.equal((await get("/v1/package-book/orders", post({ order: changed, settlementCommitment, authorization }))).status, 400);
    const other = generateKeyPairSync("ed25519");
    const forged = { ...authorization, signature: bs58.encode(sign(null, Buffer.from(packageSettlementCommitmentBytes(settlementCommitment)), other.privateKey)) };
    assert.equal((await get("/v1/package-book/orders", post({ order: signed, settlementCommitment, authorization: forged }))).status, 400);

    const passiveDraft = { ...signed, orderId: "00".repeat(32), limitPriceTicks: 90n, timeInForce: "GTD" as const, expiresAtValue: 2_000n };
    const passiveOrder = { ...passiveDraft, orderId: toHex(packageTakerOrderHash(passiveDraft)) };
    const passiveCommitment = packageSettlementCommitment({ ...settlementCommitment, packageOrderId: passiveOrder.orderId, strategyOrderHash: id(7_003) });
    strategies.set(id(7_003), {
      orderHashHex: id(7_003),
      graphHashHex: id(7_002),
      order: { ...strategyOrder, packageTimeInForce: "GTD" },
      graph: {},
      recordedAtMs: 2,
    });
    const passiveAuthorization = {
      scheme: "ED25519",
      signature: bs58.encode(sign(null, Buffer.from(packageSettlementCommitmentBytes(passiveCommitment)), keys.privateKey)),
    };
    assert.equal((await get("/v1/package-book/orders", post({ order: passiveOrder, settlementCommitment: passiveCommitment, authorization: passiveAuthorization }))).status, 200);
    assert.equal(store.getBook(CLASS)?.entries.length, 1);
    const amendment = {
      version: 1,
      executionClassId: CLASS,
      entryId: passiveOrder.orderId,
      participantId,
      expectedQuantity: passiveOrder.quantity,
      expectedPriceTicks: passiveOrder.limitPriceTicks,
      priceTicks: 91n,
    } as const;
    const amendmentAuthorization = {
      scheme: "ED25519",
      signature: bs58.encode(sign(null, Buffer.from(packageBookAmendmentBytes(amendment)), keys.privateKey)),
    };
    const amended = await get("/v1/package-book/amendments", post({ amendment, authorization: amendmentAuthorization }));
    assert.equal(amended.status, 200, amended.text);
    assert.deepEqual(
      [
        (amended.body as { amendmentHash: string }).amendmentHash,
        (amended.body as { entry: { priceTicks: bigint } }).entry.priceTicks,
        (amended.body as { replayed: boolean }).replayed,
      ],
      [toHex(packageBookAmendmentHash(amendment)), 91n, false],
    );
    assert.equal((await get("/v1/package-book/amendments", post({ amendment, authorization: amendmentAuthorization }))).status, 200);
    const cancellation = { version: 1, executionClassId: CLASS, entryId: passiveOrder.orderId, participantId };
    const cancellationAuthorization = {
      scheme: "ED25519",
      signature: bs58.encode(sign(null, Buffer.from(packageBookCancellationBytes(cancellation)), keys.privateKey)),
    };
    const cancelled = await get("/v1/package-book/cancellations", post({ cancellation, authorization: cancellationAuthorization }));
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, {
      cancelled: true,
      packageMarketId: CLASS,
      entryId: passiveOrder.orderId,
      cancellationHash: toHex(packageBookCancellationHash(cancellation)),
      replayed: false,
    });
    assert.equal(((await get("/v1/package-book/cancellations", post({ cancellation, authorization: cancellationAuthorization }))).body as { replayed: boolean }).replayed, true);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);

    const reopeningDraft = { ...passiveOrder, orderId: "00".repeat(32), limitPriceTicks: 105n };
    const reopeningOrder = { ...reopeningDraft, orderId: toHex(packageTakerOrderHash(reopeningDraft)) };
    const reopeningCommitment = packageSettlementCommitment({
      ...settlementCommitment,
      packageOrderId: reopeningOrder.orderId,
      strategyOrderHash: id(7_004),
    });
    strategies.set(id(7_004), {
      orderHashHex: id(7_004),
      graphHashHex: id(7_002),
      order: { ...strategyOrder, packageTimeInForce: "GTD" },
      graph: {},
      recordedAtMs: 3,
    });
    const reopeningAuthorization = {
      scheme: "ED25519",
      signature: bs58.encode(sign(null, Buffer.from(packageSettlementCommitmentBytes(reopeningCommitment)), keys.privateKey)),
    };
    haltBook(store, 701);
    const queued = await get("/v1/package-book/reopening/orders", post({
      order: reopeningOrder,
      settlementCommitment: reopeningCommitment,
      authorization: reopeningAuthorization,
    }));
    assert.equal(queued.status, 200, queued.text);
    assert.deepEqual(
      [
        (queued.body as { accepted: boolean }).accepted,
        (queued.body as { queuedForReopening: boolean }).queuedForReopening,
        (queued.body as { orderId: string }).orderId,
      ],
      [true, true, reopeningOrder.orderId],
    );
    assert.equal(store.getBook(CLASS)?.entries.length, 1);
    assert.equal((await get("/v1/package-book/settlement-quotes/request", post({
      packageOrderId: passiveOrder.orderId,
      idempotencyKey: "settlement-quote-0002",
    }))).status, 409);
    assert.equal(requestedQuotes.length, 1);
  }, {
    strategyPackages: {
      order: (orderHashHex: string) => strategies.get(orderHashHex),
      lockPackageExecution: () => undefined,
    } as never,
    strategyQuotes: {
      quote: async (orderHash: string, idempotencyKey: string) => {
        requestedQuotes.push({ orderHash, idempotencyKey });
        throw new GeneralizedStrategyQuoteClientError("QUOTE_DECLINED", "test quote declined");
      },
    },
  });
});

test("EVM owners authorize, amend, and cancel native package-book orders with chainless typed data", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const participantId = owner.address.toLowerCase();
  const strategies = new Map<string, unknown>();
  await withMarket(async (get, store) => {
    registerAll(store);
    strategies.set(id(7_101), {
      orderHashHex: id(7_101),
      graphHashHex: id(7_102),
      order: {
        environment: "local",
        executionClassId: CLASS,
        graphHash: commitmentHash(id(7_102)),
        owner: participantId,
        settlementAccount: participantId,
        economicQuantity: { atoms: 10n },
        packageOrderType: "LIMIT",
        packageTimeInForce: "GTD",
        expiryUnit: "SOLANA_SLOT",
        expiryValue: 2_000n,
      },
      graph: {},
      recordedAtMs: 1,
    });

    const preparedResponse = await get("/v1/package-book/orders/prepare", post({
      strategyOrderHash: id(7_101),
      side: "ASK",
      limitPriceTicks: "101",
    }));
    assert.equal(preparedResponse.status, 200, preparedResponse.text);
    const prepared = preparedResponse.body as {
      packageOrderId: string;
      order: ReturnType<typeof order>;
      settlementCommitment: ReturnType<typeof packageSettlementCommitment>;
    };
    const { order: packageOrder, settlementCommitment } = prepared;
    const orderId = prepared.packageOrderId;
    assert.equal(orderId, toHex(packageTakerOrderHash(packageOrder)));
    assert.equal(packageOrder.limitPriceTicks, 101n);

    const challengeResponse = await get("/v1/package-book/orders/authorization", post({
      order: packageOrder,
      settlementCommitment,
    }));
    assert.equal(challengeResponse.status, 200, challengeResponse.text);
    const challenge = challengeResponse.body as { scheme: string; typedData: unknown };
    assert.equal(challenge.scheme, "EIP712_SECP256K1");
    const forgedSignature = await stranger.signTypedData(challenge.typedData as never);
    assert.equal((await get("/v1/package-book/orders", post({
      order: packageOrder,
      settlementCommitment,
      authorization: { scheme: "EIP712_SECP256K1", signature: forgedSignature },
    }))).status, 400);
    const signature = await owner.signTypedData(challenge.typedData as never);
    const submitted = await get("/v1/package-book/orders", post({
      order: packageOrder,
      settlementCommitment,
      authorization: { scheme: "EIP712_SECP256K1", signature },
    }));
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal((submitted.body as { accepted: boolean }).accepted, true);
    assert.equal(store.getBook(CLASS)?.entries.length, 1);
    const openState = await get(`/v1/package-book/orders/${orderId}/settlement-readiness`);
    assert.equal(openState.status, 200, openState.text);
    assert.deepEqual((openState.body as { restingOrder: unknown }).restingOrder, {
      quantity: packageOrder.quantity,
      priceTicks: packageOrder.limitPriceTicks,
    });
    assert.equal(openState.text.includes(participantId), false);

    const amendment = {
      version: 1,
      executionClassId: CLASS,
      entryId: orderId,
      participantId,
      expectedQuantity: packageOrder.quantity,
      expectedPriceTicks: packageOrder.limitPriceTicks,
      priceTicks: 102n,
    } as const;
    const amendmentChallengeResponse = await get("/v1/package-book/amendments/authorization", post({ amendment }));
    assert.equal(amendmentChallengeResponse.status, 200, amendmentChallengeResponse.text);
    const amendmentChallenge = amendmentChallengeResponse.body as { typedData: unknown };
    const amendmentSignature = await owner.signTypedData(amendmentChallenge.typedData as never);
    const amended = await get("/v1/package-book/amendments", post({
      amendment,
      authorization: { scheme: "EIP712_SECP256K1", signature: amendmentSignature },
    }));
    assert.equal(amended.status, 200, amended.text);
    assert.equal((amended.body as { entry: { priceTicks: bigint } }).entry.priceTicks, 102n);
    const amendedState = await get(`/v1/package-book/orders/${orderId}/settlement-readiness`);
    assert.deepEqual((amendedState.body as { restingOrder: unknown }).restingOrder, {
      quantity: packageOrder.quantity,
      priceTicks: 102n,
    });

    const cancellation = { version: 1, executionClassId: CLASS, entryId: orderId, participantId };
    const cancellationChallengeResponse = await get("/v1/package-book/cancellations/authorization", post({ cancellation }));
    assert.equal(cancellationChallengeResponse.status, 200, cancellationChallengeResponse.text);
    const cancellationChallenge = cancellationChallengeResponse.body as { typedData: unknown };
    const cancellationSignature = await owner.signTypedData(cancellationChallenge.typedData as never);
    const cancelled = await get("/v1/package-book/cancellations", post({
      cancellation,
      authorization: { scheme: "EIP712_SECP256K1", signature: cancellationSignature },
    }));
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal((cancelled.body as { cancelled: boolean }).cancelled, true);
    assert.equal(store.getBook(CLASS)?.entries.length, 0);
    const cancelledState = await get(`/v1/package-book/orders/${orderId}/settlement-readiness`);
    assert.equal((cancelledState.body as { restingOrder: unknown }).restingOrder, null);
  }, {
    strategyPackages: {
      order: (orderHashHex: string) => strategies.get(orderHashHex),
      lockPackageExecution: () => undefined,
    } as never,
  });
});

test("registries, strategy series, and package markets are listed from their stores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-public-registry-"));
  const registry = new SqliteRegistryStore(join(dir, "registry.sqlite"));
  try {
    registry.registerDomain(DOMAIN_MANIFEST);
    registry.registerSolverManifest(signedSolverManifest(operatorKeys()));
    await withMarket(
      async (get, store) => {
        registerAll(store);
        submitBookOrder(store, order(1));
        const domains = (await get("/v1/domains")).body as { domains: readonly { subjectId: string }[] };
        assert.deepEqual(domains.domains.map((entry) => entry.subjectId), [DOMAIN_MANIFEST.domainId]);
        const solver = (await get("/v1/solvers/solver-a")).body as { solverId: string; manifestNonce: number; quoteVerificationKeys: readonly unknown[] };
        assert.equal(solver.solverId, "solver-a");
        assert.equal(solver.manifestNonce, 1);
        assert.equal((await get("/v1/solvers/solver-z")).status, 404);
        const series = (await get("/v1/strategy-series")).body as { series: readonly { seriesId: string }[] };
        assert.deepEqual(series.series.map((entry) => entry.seriesId), [
          SERIES.seriesId,
          NEAR_BASIS_SERIES.seriesId,
          CALENDAR_SERIES.seriesId,
        ]);
        const classes = (await get(`/v1/strategy-series/${SERIES.seriesId}/execution-classes`)).body as { executionClasses: readonly { executionClassId: string }[] };
        assert.deepEqual(classes.executionClasses.map((entry) => entry.executionClassId), [CLASS]);
        const markets = (await get("/v1/markets")).body as { markets: readonly { packageMarketId: string; bestAskTicks?: bigint; label: string }[] };
        assert.deepEqual(markets.markets.map((market) => [market.packageMarketId, market.bestAskTicks, market.label]), [[CLASS, 100n, "EXECUTABLE"]]);
      },
      { registry },
    );
    await withMarket(async (get) => {
      assert.equal((await get("/v1/domains")).status, 503);
    });
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recent admitted strategy packages are exposed as bounded read-only summaries", async () => {
  const summary = {
    orderHashHex: "11".repeat(32),
    quoteHashHex: "22".repeat(32),
    routeHashHex: "33".repeat(32),
    templateId: "funding-spread-v1",
    templateVersion: 1,
    lifecycleAction: "ENTRY" as const,
    settlementClass: "BATCHED_IOC_WITH_RECOVERY" as const,
    solverId: "solver-a",
    domainIds: ["hypercore:testnet"],
    validUntilUnit: "HYPERLIQUID_UNIX_MILLISECONDS" as const,
    validUntilValue: 123_456n,
    recordedAtMs: 120_000,
  };
  let requestedLimit = 0;
  let requestedOwner: readonly [string, number] | null = null;
  const ownerReceipt = {
    receiptHashHex: "44".repeat(32),
    orderHashHex: "11".repeat(32),
    quoteHashHex: "22".repeat(32),
    templateId: "funding-spread-v1",
    lifecycleAction: "ENTRY" as const,
    expectedStrategyStateHashHex: null,
    terminalState: "FINALIZED_COMPLETE" as const,
    finalityStatus: "FINALIZED" as const,
    domainIds: ["hypercore:testnet"],
    portfolioEligible: true,
    executionEvidence: {
      routeHashHex: "33".repeat(32),
      solverId: "solver-a",
      settlementClass: "BATCHED_IOC_WITH_RECOVERY" as const,
      legCount: 2,
      onchainEnforcedLegCount: 0,
      evidenceGrades: ["VENUE_API_CORROBORATED" as const],
    },
    executionEconomics: {
      quoteAssetId: "usdc",
      quoteAssetDecimals: 6,
      grossLegNotionalAtoms: 2_000_000n,
      serviceFeeAtoms: 1_000n,
      solverFeeAtoms: 2_000n,
      venueFeeAtoms: 3_000n,
      networkCostAtoms: 4_000n,
      recoveryCostAtoms: 0n,
      explicitCostAtoms: 10_000n,
      terminalResidualValueAtoms: 0n,
    },
    recordedAtMs: 120_001,
  };
  const quoteProof = {
    orderHashHex: "11".repeat(32),
    graphHashHex: "66".repeat(32),
    quoteHashHex: "22".repeat(32),
    routeHashHex: "33".repeat(32),
    order: { version: 1, nonce: 1n },
    graph: { graphVersion: 1, nonce: 2n },
    quote: { version: 1, quoteNonce: 3n },
    route: { version: 1, routeExpiryValue: 4n },
    recordedAtMs: 120_000,
  };
  const receiptDocument = { version: 1, receiptNonce: 7n, quoteHash: Uint8Array.from(Buffer.from("22".repeat(32), "hex")) };
  await withMarket(async (get) => {
    const result = await get("/v1/strategy-packages/recent?limit=7");
    assert.equal(result.status, 200);
    assert.equal(requestedLimit, 7);
    assert.deepEqual(result.body, { version: 1, admissions: [summary] });
    assert.equal((await get("/v1/strategy-packages/recent?limit=0")).status, 400);
    assert.equal((await get("/v1/strategy-packages/recent?limit=51")).status, 400);
    assert.equal((await get("/v1/strategy-packages/recent?other=1")).status, 400);
    const receipt = await get(`/v1/strategy-receipts/${"44".repeat(32)}`);
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, { version: 1, receiptHash: "44".repeat(32), receipt: receiptDocument });
    assert.equal((await get(`/v1/strategy-receipts/${"55".repeat(32)}`)).status, 404);
    const byQuote = await get(`/v1/strategy-receipts/by-quote/${"22".repeat(32)}`);
    assert.equal(byQuote.status, 200);
    assert.deepEqual(byQuote.body, {
      version: 1,
      quoteHash: "22".repeat(32),
      receiptHashHex: "44".repeat(32),
      receipt: receiptDocument,
      recordedAtMs: 120_001,
    });
    assert.equal((await get(`/v1/strategy-receipts/by-quote/${"33".repeat(32)}`)).status, 404);
    const receiptProof = await get(`/v1/strategy-receipts/${"44".repeat(32)}/proof`);
    assert.equal(receiptProof.status, 200);
    assert.deepEqual(receiptProof.body, {
      version: 1,
      receiptHash: "44".repeat(32),
      receipt: receiptDocument,
      recordedAtMs: 120_001,
      quoteProof: {
        version: 1,
        orderHash: quoteProof.orderHashHex,
        graphHash: quoteProof.graphHashHex,
        quoteHash: quoteProof.quoteHashHex,
        routeHash: quoteProof.routeHashHex,
        order: quoteProof.order,
        graph: quoteProof.graph,
        quote: quoteProof.quote,
        route: quoteProof.route,
        recordedAtMs: quoteProof.recordedAtMs,
      },
    });
    assert.equal((await get(`/v1/strategy-receipts/${"55".repeat(32)}/proof`)).status, 404);
    const proof = await get(`/v1/strategy-quotes/${"22".repeat(32)}/proof`);
    assert.equal(proof.status, 200);
    assert.deepEqual(proof.body, {
      version: 1,
      orderHash: quoteProof.orderHashHex,
      graphHash: quoteProof.graphHashHex,
      quoteHash: quoteProof.quoteHashHex,
      routeHash: quoteProof.routeHashHex,
      order: quoteProof.order,
      graph: quoteProof.graph,
      quote: quoteProof.quote,
      route: quoteProof.route,
      recordedAtMs: quoteProof.recordedAtMs,
    });
    assert.equal((await get(`/v1/strategy-quotes/${"33".repeat(32)}/proof`)).status, 404);
    const ownerReceipts = await get("/v1/owners/0x00000000000000000000000000000000000000AB/strategy-receipts?limit=7");
    assert.equal(ownerReceipts.status, 200);
    assert.deepEqual(requestedOwner, ["0x00000000000000000000000000000000000000ab", 7]);
    assert.deepEqual(ownerReceipts.body, {
      version: 1,
      ownerId: "0x00000000000000000000000000000000000000ab",
      receipts: [ownerReceipt],
    });
    assert.equal((await get("/v1/owners/owner-a/strategy-receipts?limit=0")).status, 400);
  }, {
    strategyPackages: {
      registerOrder: () => { throw new Error("not used"); },
      registerQuote: () => { throw new Error("not used"); },
      recentAdmissions: (limit) => {
        requestedLimit = limit;
        return [summary];
      },
      receipt: (hash) => hash === "44".repeat(32) ? (receiptDocument as never) : undefined,
      receiptByQuote: (hash) => hash === "22".repeat(32) ? ({
        receiptHashHex: "44".repeat(32),
        receipt: receiptDocument as never,
        recordedAtMs: 120_001,
      }) : undefined,
      admissionByQuote: (hash) => hash === "22".repeat(32) ? quoteProof as never : undefined,
      ownerReceipts: (ownerId, limit) => {
        requestedOwner = [ownerId, limit ?? 50];
        return [ownerReceipt];
      },
    },
  });
});

test("candles are built only from recorded trades and the index keeps executable depth separate", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    submitBookOrder(store, order(2, { side: "BID", timeInForce: "IOC" }));
    const to = Date.now() + 60_000;
    const candles = (await get(`/v1/markets/${CLASS}/candles?interval=1h&from=${to - 86_400_000}&to=${to}`)).body as {
      label: string;
      candles: readonly { open: bigint; close: bigint; volume: bigint; tradeCount: number }[];
    };
    assert.equal(candles.label, "OBSERVED");
    assert.deepEqual(candles.candles.map((candle) => [candle.open, candle.close, candle.volume, candle.tradeCount]), [[100n, 100n, 10n, 1]]);
    assert.equal((await get(`/v1/markets/${CLASS}/candles?interval=2m`)).status, 400);
    assert.equal((await get(`/v1/markets/${CLASS}/candles?interval=1m&from=0&to=${to}`)).status, 400);
    submitBookOrder(store, order(3));
    store.addImpliedLiquidity(CLASS, { quote: impliedAsk(1, 1, 501), participantId: "solver-a", commonControlGroupId: "solver", nowValue: NOW });
    const index = (await get(`/v1/markets/${CLASS}/index?sizes=10,30`)).body as {
      executable: { asks: readonly { averagePriceTicks?: bigint; label: string }[] };
      withImplied: { asks: readonly { averagePriceTicks?: bigint; label: string }[] };
    };
    assert.deepEqual(index.executable.asks.map((quote) => [quote.averagePriceTicks, quote.label]), [[100n, "EXECUTABLE"], [undefined, "EXECUTABLE"]]);
    assert.deepEqual(index.withImplied.asks.map((quote) => [quote.averagePriceTicks, quote.label]), [[100n, "INDICATIVE"], [100n, "INDICATIVE"]]);
    const provenance = (await get(`/v1/package-book/${CLASS}/implied-provenance`)).body as {
      implied: readonly { solverId: string; evidence: string; sources: readonly unknown[]; label: string }[];
    };
    assert.equal(provenance.implied.length, 1);
    assert.deepEqual([provenance.implied[0]?.solverId, provenance.implied[0]?.evidence, provenance.implied[0]?.label], ["solver-a", "RESERVATION_BACKED_IMPLIED", "EXECUTABLE"]);
    assert.equal(provenance.implied[0]?.sources.length, 2);
  });
});

test("series indices, curves, and the opportunity feed are built from executable depth and observed trades", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    const opportunitiesBefore = (await get("/v1/opportunities?size=10")).body as { opportunities: readonly unknown[] };
    assert.deepEqual(opportunitiesBefore.opportunities, []);
    const unopened = (await get(`/v1/curves/${SERIES.seriesId}?sizes=10`)).body as { points: readonly { open: boolean; lastTrade?: unknown }[] };
    assert.deepEqual(unopened.points.map((point) => [point.open, point.lastTrade]), [[true, undefined]]);

    submitBookOrder(store, order(1));
    submitBookOrder(store, order(2, { side: "BID", timeInForce: "IOC" }));
    submitBookOrder(store, order(3, { limitPriceTicks: 104n }));
    submitBookOrder(store, order(4, { side: "BID", limitPriceTicks: 96n }));

    const indices = (await get(`/v1/indices/${SERIES.seriesId}?sizes=10,20`)).body as {
      seriesId: string;
      executionClasses: readonly { executionClassId: string; settlementClass: string; open: boolean; index: { executable: { asks: readonly { averagePriceTicks?: bigint; label: string }[] } } }[];
    };
    assert.equal(indices.seriesId, SERIES.seriesId);
    assert.deepEqual(indices.executionClasses.map((entry) => [entry.executionClassId, entry.open]), [[CLASS, true]]);
    assert.deepEqual(indices.executionClasses[0]?.index.executable.asks.map((quote) => [quote.averagePriceTicks, quote.label]), [[104n, "EXECUTABLE"], [undefined, "EXECUTABLE"]]);

    const curve = (await get(`/v1/curves/${SERIES.seriesId}?sizes=10`)).body as {
      quoteConvention: string;
      points: readonly {
        executionClassId: string;
        executable: { bids: readonly { averagePriceTicks?: bigint }[]; asks: readonly { averagePriceTicks?: bigint }[] };
        indicativeWithImplied: { bids: readonly { averagePriceTicks?: bigint; label: string }[]; asks: readonly { averagePriceTicks?: bigint; label: string }[] };
        lastTrade?: { priceTicks: bigint; quantity: bigint; label: string };
      }[];
    };
    assert.equal(curve.quoteConvention, SERIES.quoteConvention);
    assert.deepEqual(
      curve.points.map((point) => [point.executable.bids[0]?.averagePriceTicks, point.executable.asks[0]?.averagePriceTicks, point.lastTrade?.priceTicks, point.lastTrade?.quantity, point.lastTrade?.label]),
      [[96n, 104n, 100n, 10n, "OBSERVED"]],
    );
    assert.deepEqual(
      curve.points.map((point) => [point.indicativeWithImplied.bids[0]?.averagePriceTicks, point.indicativeWithImplied.asks[0]?.averagePriceTicks, point.indicativeWithImplied.bids[0]?.label]),
      [[96n, 104n, "INDICATIVE"]],
    );

    const feed = (await get("/v1/opportunities?size=10")).body as {
      label: string;
      opportunities: readonly { packageMarketId: string; seriesId?: string; spreadAtSizeTicks?: bigint; lastTrade?: { priceTicks: bigint } }[];
    };
    assert.equal(feed.label, "EXECUTABLE");
    assert.deepEqual(feed.opportunities.map((entry) => [entry.packageMarketId, entry.seriesId, entry.spreadAtSizeTicks, entry.lastTrade?.priceTicks]), [[CLASS, SERIES.seriesId, 8n, 100n]]);
    // Size the book cannot fill on either side is not an opportunity.
    assert.deepEqual(((await get("/v1/opportunities?size=1000")).body as { opportunities: readonly unknown[] }).opportunities, []);

    assert.equal((await get("/v1/curves/unknown-series")).status, 404);
    assert.equal((await get("/v1/indices/unknown-series")).status, 404);
    assert.equal((await get("/v1/opportunities?size=0")).status, 400);
    assert.equal((await get(`/v1/curves/${SERIES.seriesId}?depth=1`)).status, 400);
    assert.equal((await get(`/v1/outcomes/${"ab".repeat(32)}`)).status, 503);
  });
});

test("compute routes validate, simulate without persisting, and reject malformed bodies", async () => {
  await withMarket(async (get, store) => {
    registerAll(store);
    submitBookOrder(store, order(1));
    const simulated = (await get("/v1/clearing/simulate", post({ packageMarketId: CLASS, order: order(9, { side: "BID", timeInForce: "IOC" }) }))).body as {
      accepted: boolean;
      simulated: boolean;
      allocation: { fills: readonly unknown[] };
    };
    assert.deepEqual([simulated.accepted, simulated.simulated, simulated.allocation.fills.length], [true, true, 1]);
    assert.equal(store.getBook(CLASS)?.entries.length, 1);
    assert.equal(store.getAllocation(id(9)), undefined);
    const netting = (await get("/v1/netting/simulate", post({
      obligations: [
        nettingObligation(1, "alice", 30n),
        nettingObligation(2, "bob", -20n),
      ],
      policy: NETTING_POLICY,
    }))).body as { simulated: boolean; result: Parameters<typeof verifyNettingResult>[0] };
    assert.equal(netting.simulated, true);
    verifyNettingResultAgainstPolicy(netting.result, NETTING_POLICY);
    assert.equal(netting.result.underlyings[0]?.externalNetAtoms, 10n);
    assert.equal((await get("/v1/netting/simulate", post({ obligations: [] }))).status, 400);
    const invalid = (await get("/v1/orders/validate", post({ order: { version: 99 } }))).body as { valid: boolean; error: { code: string } };
    assert.equal(invalid.valid, false);
    assert.equal(typeof invalid.error.code, "string");
    const plan = (await get("/v1/de-risk/validate", post({ positions: [], policy: { triggerLiquidationDistanceBps: 500n, reductionBps: 2_500n }, stateCertain: true }))).body as { actions: readonly unknown[] };
    assert.ok(Array.isArray(plan.actions));
    assert.equal((await get("/v1/orders/validate", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await get("/v1/orders/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" })).status, 400);
    assert.equal((await get("/v1/orders/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(70_000) }) })).status, 413);
    const preflight = await fetchOptions(get);
    assert.equal(preflight, 204);
  });
});

async function fetchOptions(get: (path: string, init?: RequestInit) => Promise<{ status: number }>): Promise<number> {
  return (await get("/v1/orders/validate", { method: "OPTIONS" })).status;
}

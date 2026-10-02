import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PackageOrder } from "@naryx/protocol-types";
import {
  DurableAttemptScopeResolver,
  ExecutionReadinessError,
  TestnetCapExecutionGate,
  parseTestnetExecutionPolicy,
  scopeFromOrder,
  type TestnetExecutionScope,
} from "../src/index.js";

const USDC = "usdc:testnet";

function policyText(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    domains: [{
      domainId: "eip155:84532",
      quoteAssetId: USDC,
      maxPrincipalAtomsPerOperation: "1000000000",
      maxPrincipalAtomsPerDay: "2500000000",
      maxRecoveryLossAtomsPerOperation: "50000000",
      ...overrides,
    }],
  });
}

function scope(attemptId: string, principalAtoms: bigint, extra: Partial<TestnetExecutionScope> = {}): TestnetExecutionScope {
  return {
    handoff: "BASE_TESTNET_ATOMIC_AUTHORIZE",
    attemptId,
    idempotencyKey: `${attemptId}-key`,
    environment: "testnet",
    domainId: "eip155:84532",
    orderHash: `order-${attemptId}`,
    quoteAssetId: USDC,
    principalAtoms,
    recoveryLossAtoms: 0n,
    ...extra,
  };
}

function withGate(run: (gate: TestnetCapExecutionGate, reopen: () => TestnetCapExecutionGate, clock: { now: number }) => void, text = policyText()) {
  const directory = mkdtempSync(join(tmpdir(), "naryx-policy-"));
  const clock = { now: Date.UTC(2026, 9, 1, 12) };
  const make = () => new TestnetCapExecutionGate({
    policy: () => parseTestnetExecutionPolicy(text),
    databasePath: join(directory, "decisions.db"),
    nowMs: () => clock.now,
  });
  const gates: TestnetCapExecutionGate[] = [];
  const open = () => {
    const gate = make();
    gates.push(gate);
    return gate;
  };
  try {
    run(open(), open, clock);
  } finally {
    for (const gate of gates) gate.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function rejected(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (error: unknown) =>
    error instanceof ExecutionReadinessError && error.code === "READINESS_REJECTED" && pattern.test(error.message));
}

test("policy parsing refuses mainnet domains, unknown fields, and inverted caps", () => {
  assert.throws(() => parseTestnetExecutionPolicy(policyText({ domainId: "eip155:8453" })), /mainnet/);
  assert.throws(() => parseTestnetExecutionPolicy(policyText({ surprise: true })), /unknown fields/);
  assert.throws(() => parseTestnetExecutionPolicy(policyText({ maxPrincipalAtomsPerDay: "10" })), /per operation <= per day/);
  assert.throws(() => parseTestnetExecutionPolicy(policyText({ maxPrincipalAtomsPerOperation: "1.5" })), /decimal atom string/);
  assert.equal(parseTestnetExecutionPolicy(policyText()).domains[0]?.maxPrincipalAtomsPerDay, 2_500_000_000n);
});

test("an attempt within caps is approved once and reused by its later handoffs", () => {
  withGate((gate) => {
    const first = gate.authorize(scope("a1", 900_000_000n));
    const second = gate.authorize({ ...scope("a1", 900_000_000n), handoff: "BASE_TESTNET_ATOMIC_PREPARE" });
    assert.equal(second.fundedOperationManifestHash, first.fundedOperationManifestHash);
    // The reuse did not count twice: a second 900 USDC attempt still fits under the 2,500 USDC day.
    gate.authorize(scope("a2", 900_000_000n));
  });
});

test("per-operation, daily, loss, asset, domain, and mainnet limits fail closed", () => {
  withGate((gate) => {
    rejected(() => gate.authorize(scope("big", 1_000_000_001n)), /per-operation cap/);
    rejected(() => gate.authorize(scope("loss", 1n, { recoveryLossAtoms: 50_000_001n })), /recovery-loss/);
    rejected(() => gate.authorize(scope("asset", 1n, { quoteAssetId: "usdt:testnet" })), /quote asset/);
    rejected(() => gate.authorize(scope("domain", 1n, { domainId: "eip155:421614" })), /not enabled/);
    rejected(() => gate.authorize(scope("main", 1n, { environment: "mainnet" })), /Mainnet/);
    gate.authorize(scope("d1", 1_000_000_000n));
    gate.authorize(scope("d2", 1_000_000_000n));
    rejected(() => gate.authorize(scope("d3", 600_000_000n)), /daily cap/);
    // Denials never consumed the day: 500 USDC still fits.
    gate.authorize(scope("d4", 500_000_000n));
  });
});

test("an approved attempt cannot be rebound to a different order", () => {
  withGate((gate) => {
    gate.authorize(scope("r1", 10n));
    rejected(() => gate.authorize(scope("r1", 11n)), /different order/);
    rejected(() => gate.authorize({ ...scope("r1", 10n), orderHash: "other" }), /different order/);
  });
});

test("daily usage survives a restart and resets on the next UTC day", () => {
  withGate((gate, reopen, clock) => {
    gate.authorize(scope("p1", 1_000_000_000n));
    gate.authorize(scope("p2", 1_000_000_000n));
    gate.close();
    const restarted = reopen();
    rejected(() => restarted.authorize(scope("p3", 600_000_000n)), /daily cap/);
    clock.now += 24 * 60 * 60 * 1000;
    restarted.authorize(scope("p3", 600_000_000n));
  });
});

test("an unreadable policy makes execution unavailable, not approved", () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-policy-"));
  const gate = new TestnetCapExecutionGate({
    policy: () => { throw new Error("policy file missing"); },
    databasePath: join(directory, "decisions.db"),
  });
  try {
    assert.throws(() => gate.authorize(scope("x", 1n)), (error: unknown) =>
      error instanceof ExecutionReadinessError && error.code === "READINESS_UNAVAILABLE");
  } finally {
    gate.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function order(fields: { quote?: string; spot?: bigint; margin?: bigint; loss?: bigint; spotAsset?: string }): PackageOrder {
  const asset = (assetId: string) => ({ assetId, assetManifestHash: new Uint8Array(32), decimals: 6 });
  return {
    environment: "testnet",
    domain: { domainId: "eip155:84532", domainManifestVersion: 1, domainManifestHash: new Uint8Array(32) },
    maxSpotQuoteIn: { asset: asset(fields.spotAsset ?? fields.quote ?? USDC), atoms: fields.spot ?? 700n },
    maxMarginAdded: { asset: asset(fields.quote ?? USDC), atoms: fields.margin ?? 300n },
    maxAggregateRecoveryLossQuote: { asset: asset(fields.quote ?? USDC), atoms: fields.loss ?? 0n },
  } as unknown as PackageOrder;
}

test("scope principal is the order's spot quote cap plus its margin cap, in one asset", () => {
  const resolved = scopeFromOrder("BASE_TESTNET_ATOMIC_PREPARE", { attemptId: "a", idempotencyKey: "k", orderHash: "h" }, order({}));
  assert.equal(resolved.principalAtoms, 1_000n);
  assert.equal(resolved.quoteAssetId, USDC);
  rejected(() => scopeFromOrder("BASE_TESTNET_ATOMIC_PREPARE", { attemptId: "a", idempotencyKey: "k", orderHash: "h" }, order({ spotAsset: "weth" })), /different assets/);
});

test("an exit carries zero principal and may not sign new spend or added margin", () => {
  const request = { attemptId: "a", idempotencyKey: "k", orderHash: "h" };
  const exit = { ...order({ margin: 0n }), action: "EXIT", maxSpotQuoteIn: undefined } as unknown as PackageOrder;
  assert.equal(scopeFromOrder("BASE_TESTNET_ATOMIC_PREPARE", request, exit).principalAtoms, 0n);
  rejected(() => scopeFromOrder("BASE_TESTNET_ATOMIC_PREPARE", request, { ...exit, maxMarginAdded: order({}).maxMarginAdded }), /must not sign/);
});

test("the resolver binds handoffs to durable orders and selected attempts only", () => {
  const record = { orderHashHex: "hash-1" };
  const attempt = { attemptId: "base-atomic-1", orderHash: "hash-1" };
  const resolver = new DurableAttemptScopeResolver(
    {
      getByIdempotencyKey: (key: string) => (key === "order-key" ? record : undefined) as never,
      getCanonicalOrderByHash: (hash: Uint8Array | string) => (hash === "hash-1" ? order({}) : undefined),
    },
    {
      getAttempt: (id: string) => (id === attempt.attemptId ? attempt : undefined) as never,
      getAttemptForOrder: (hash: string) => (hash === "hash-1" ? attempt : undefined) as never,
    },
  );
  const devnet = resolver.resolve("SOLANA_DEVNET_PREPARE", { idempotencyKey: "order-key" });
  assert.equal(devnet.attemptId, "base-atomic-1");
  const base = resolver.resolve("BASE_TESTNET_ATOMIC_AUTHORIZE", { attemptId: "base-atomic-1", idempotencyKey: "exec-key" });
  assert.equal(base.orderHash, "hash-1");
  rejected(() => resolver.resolve("BASE_TESTNET_ATOMIC_AUTHORIZE", { attemptId: "missing", idempotencyKey: "k" }), /does not exist/);
  rejected(() => resolver.resolve("SOLANA_DEVNET_PREPARE", { idempotencyKey: "unknown" }), /No durable order/);
  rejected(() => resolver.resolve("SOLANA_LOCAL_SUBMIT", { attemptId: "x", idempotencyKey: "x" }), /not a testnet handoff/);
});

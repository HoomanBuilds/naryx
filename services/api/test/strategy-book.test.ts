import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bs58 from "bs58";
import {
  fromProtocolJson,
  packageReceiptHash,
  strategyCommandHash,
  strategyStateHash,
  toHex,
  toProtocolJson,
  type StrategyCommandInput,
  type StrategyState,
} from "@naryx/protocol-types";
import { createPublicApiHandler, SqliteEvidenceStore, SqlitePackageExchangeStore, SqliteStrategyBookStore } from "../src/index.js";
import { CLASS_SUPPORT, NOW, SERIES_SUPPORT } from "./exchange-fixtures.js";
import { hash, manifest, outcome, receipt, terms } from "./evidence-fixtures.js";

const NOW_MS = 1_790_000_000_000;

function actor(): { id: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: bs58.encode((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32)), key: privateKey };
}

test("the strategy book opens from one settled entry, applies signed commands through the kernel, and records their receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-strategy-book-"));
  const evidence = new SqliteEvidenceStore(join(dir, "evidence.sqlite"), { clock: () => NOW_MS });
  const book = new SqliteStrategyBookStore(join(dir, "strategies.sqlite"), {
    environment: "testnet",
    originReceipt: (receiptHashHex) => evidence.outcomeByReceipt(receiptHashHex)?.receipt,
    clock: () => NOW_MS,
  });
  const exchange = new SqlitePackageExchangeStore(join(dir, "exchange.sqlite"), { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  const owner = actor();
  const bot = actor();
  try {
    // A settled entry for this owner founds the strategy.
    const orderHash = hash(1);
    const settled = receipt(orderHash, { owner: owner.id, netSpotDelta: 1_000_000_000n });
    evidence.recordOutcome({
      evidenceManifest: manifest(orderHash),
      outcome: outcome(orderHash, { terminalState: "FINALIZED_COMPLETE", successfulReceiptHash: packageReceiptHash(settled) }),
      receipt: settled,
      acceptedQuoteFeeTerms: terms,
    });
    const originReceiptHash = toHex(packageReceiptHash(settled));
    const state = (overrides: Partial<StrategyState> = {}): StrategyState => ({
      version: 1,
      strategyId: "carry-1",
      ownerId: owner.id,
      subaccountId: "desk-1",
      seriesId: "sol-cash-carry",
      executionClassId: "sol-carry",
      open: true,
      stateVersion: 1n,
      legs: [
        { legId: "spot", underlyingId: "sol", instrumentId: "sol-spot", venueId: "phoenix", signedQuantityAtoms: 1_000_000_000n, lotAtoms: 1_000_000n, ratioNumerator: 1n, ratioDenominator: 1n },
        { legId: "perp", underlyingId: "sol", instrumentId: "sol-perp", venueId: "drift", signedQuantityAtoms: -1_000_000_000n, lotAtoms: 1_000_000n, ratioNumerator: -1n, ratioDenominator: 1n },
      ],
      liabilities: [],
      delegations: [],
      venuePositionsTransferable: false,
      legalTransferRestricted: false,
      ...overrides,
    });
    const signed = (who: { id: string; key: KeyObject }, command: Omit<StrategyCommandInput, "commandVersion" | "environment" | "actorId" | "atValue"> & { atValue?: bigint }) => {
      const full: StrategyCommandInput = { commandVersion: 1, environment: "testnet", actorId: who.id, atValue: BigInt(NOW_MS), ...command };
      return { command: full, signature: bs58.encode(sign(null, strategyCommandHash(full), who.key)) };
    };
    const openCommand = (strategyId: string, legs?: StrategyState["legs"]) =>
      signed(owner, {
        strategyId,
        expectedStateVersion: 0n,
        expectedStateHash: "00".repeat(32),
        parameters: { kind: "OPEN", originReceiptHash, state: state({ strategyId, ...(legs === undefined ? {} : { legs }) }) },
      });
    const submit = (entry: { command: StrategyCommandInput; signature: string }) => book.submit(entry.command, { scheme: "ED25519", signature: entry.signature });

    const wrongLegs = state().legs.map((leg) => ({ ...leg, signedQuantityAtoms: leg.signedQuantityAtoms / 2n }));
    await assert.rejects(() => submit(openCommand("carry-1", wrongLegs)), { code: "ORIGIN_MISMATCH" });
    const opening = openCommand("carry-1");
    const opened = await submit(opening);
    assert.ok(opened.accepted && !opened.replayed);
    assert.equal(opened.states[0]?.stateHashHex, toHex(strategyStateHash(state())));
    assert.ok((await submit(opening)).accepted, "a replayed command returns its first result");
    await assert.rejects(() => submit(openCommand("carry-2")), { code: "ORIGIN_CLAIMED" });

    // Signatures must come from the actor's own key, at the book's time.
    await assert.rejects(() => book.submit(openCommand("carry-3").command, { scheme: "ED25519", signature: bs58.encode(new Uint8Array(64)) }), { code: "INVALID_SIGNATURE" });
    const current = () => book.strategy("carry-1")?.state as StrategyState;
    const bind = (value: StrategyState) => ({ strategyId: value.strategyId, expectedStateVersion: value.stateVersion, expectedStateHash: strategyStateHash(value) });
    await assert.rejects(() => submit(signed(owner, { ...bind(current()), atValue: BigInt(NOW_MS - 600_000), parameters: { kind: "ASSIGN_INTERNAL", subaccountId: "desk-2" } })), { code: "STALE_COMMAND" });

    const delegated = await submit(signed(owner, { ...bind(current()), parameters: { kind: "DELEGATE", delegateId: bot.id, authorities: ["REBALANCE", "EXIT"], expiresAtValue: BigInt(NOW_MS + 86_400_000) } }));
    assert.ok(delegated.accepted && delegated.receipt?.externalPositionsMoved === false);
    // A delegate may not split: splitting is the owner's alone.
    const botSplit = await submit(signed(bot, { ...bind(current()), parameters: { kind: "SPLIT", childStrategyIds: ["carry-1a", "carry-1b"], firstShareBps: 5_000n } }));
    assert.deepEqual(botSplit, { accepted: false, rejection: "UNAUTHORIZED" });
    const stale = await submit(signed(owner, { strategyId: "carry-1", expectedStateVersion: 1n, expectedStateHash: strategyStateHash(state()), parameters: { kind: "ASSIGN_INTERNAL", subaccountId: "desk-2" } }));
    assert.deepEqual(stale, { accepted: false, rejection: "STALE_STATE" });

    const split = await submit(signed(owner, { ...bind(current()), parameters: { kind: "SPLIT", childStrategyIds: ["carry-1a", "carry-1b"], firstShareBps: 5_000n } }));
    assert.ok(split.accepted && split.states.length === 2);
    assert.ok(book.strategy("carry-1")?.retiredByCommandHashHex === split.commandHashHex);
    await assert.rejects(() => submit(signed(owner, { ...bind(current()), parameters: { kind: "ASSIGN_INTERNAL", subaccountId: "desk-9" } })), { code: "STRATEGY_RETIRED" });

    const first = book.strategy("carry-1a")?.state as StrategyState;
    const second = book.strategy("carry-1b")?.state as StrategyState;
    const merged = await submit(signed(owner, {
      ...bind(first),
      parameters: { kind: "MERGE", otherStrategyId: "carry-1b", otherExpectedStateVersion: second.stateVersion, otherExpectedStateHash: strategyStateHash(second), mergedStrategyId: "carry-1m" },
    }));
    assert.ok(merged.accepted);
    assert.equal(book.strategy("carry-1m")?.state.legs.find((leg) => leg.legId === "spot")?.signedQuantityAtoms, 1_000_000_000n, "a split then merge conserves every leg");
    assert.deepEqual(book.history("carry-1").map((entry) => entry.command.parameters.kind), ["OPEN", "DELEGATE", "SPLIT"]);
    assert.deepEqual(book.history("carry-1a").map((entry) => entry.command.parameters.kind), ["SPLIT", "MERGE"]);
    assert.deepEqual(book.ownerStrategies(owner.id).map((entry) => [entry.state.strategyId, entry.retiredByCommandHashHex !== undefined]), [
      ["carry-1", true],
      ["carry-1a", true],
      ["carry-1b", true],
      ["carry-1m", false],
    ]);

    // The public routes serve the book with every hash and signature needed to check it.
    const handler = createPublicApiHandler({ exchange, evidence, strategies: book, nowValue: () => NOW, clockMs: () => NOW_MS, rateLimit: { windowMs: 60_000, maxRequests: 1_000 } });
    const server = createServer((request, response) => {
      if (!handler(request, response)) {
        response.statusCode = 418;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(toProtocolJson(body)) }),
      });
      return { status: response.status, body: fromProtocolJson(JSON.parse(await response.text())) as Record<string, unknown> };
    };
    try {
      const read = await call("GET", "/v1/strategies/carry-1m");
      assert.equal(read.status, 200);
      assert.equal(read.body.stateHash, toHex(strategyStateHash(read.body.state as StrategyState)));
      const history = await call("GET", "/v1/strategies/carry-1/history");
      assert.equal((history.body.commands as unknown[]).length, 3);
      const merged = book.strategy("carry-1m")?.state as StrategyState;
      const assign = signed(owner, { ...bind(merged), parameters: { kind: "ASSIGN_INTERNAL", subaccountId: "desk-2" } });
      const challenge = await call("POST", "/v1/strategies/commands/authorization", { command: assign.command });
      assert.equal(challenge.status, 200);
      assert.equal(challenge.body.scheme, "ED25519");
      assert.equal(challenge.body.commandHash, toHex(strategyCommandHash(assign.command)));
      const posted = await call("POST", "/v1/strategies/commands", { command: assign.command, authorization: { scheme: "ED25519", signature: assign.signature } });
      assert.equal(posted.status, 200);
      const rejected = await call("POST", "/v1/strategies/commands", { command: assign.command, authorization: { scheme: "ED25519", signature: bs58.encode(new Uint8Array(64)) } });
      assert.equal(rejected.status, 400);
      const owned = await call("GET", `/v1/owners/${owner.id}/strategies`);
      assert.equal((owned.body.strategies as unknown[]).length, 4);
      assert.equal((await call("GET", "/v1/strategies/nope")).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    book.close();
    evidence.close();
    exchange.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("position moves are accepted only with unclaimed settled receipts that account for the exact change, and novation needs consent and venue evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-strategy-moves-"));
  const owner = actor();
  const buyer = actor();
  const receipts = new Map<string, ReturnType<typeof receipt>>();
  const verified = new Set<string>();
  const book = new SqliteStrategyBookStore(join(dir, "strategies.sqlite"), {
    environment: "testnet",
    originReceipt: (hex) => receipts.get(hex),
    transferEvidence: (claim) => verified.has(`${claim.venueId}:${claim.evidenceHashHex}:${claim.toOwnerId}`),
    clock: () => NOW_MS,
  });
  try {
    receipts.set("aa".repeat(32), receipt(hash(1), { owner: owner.id, netSpotDelta: 1_000_000_000n }));
    const exitReceipt = (who: string, spot: bigint) => receipt(hash(2), { owner: who, action: "EXIT", netSpotDelta: -spot, perpPositionDelta: spot });
    receipts.set("b1".repeat(32), exitReceipt(owner.id, 500_000_000n));
    receipts.set("b2".repeat(32), exitReceipt(owner.id, 400_000_000n));
    receipts.set("b3".repeat(32), exitReceipt(buyer.id, 500_000_000n));
    const legs: StrategyState["legs"] = [
      { legId: "spot", underlyingId: "sol", instrumentId: "sol-spot", venueId: "phoenix", signedQuantityAtoms: 1_000_000_000n, lotAtoms: 1_000_000n, ratioNumerator: 1n, ratioDenominator: 1n },
      { legId: "perp", underlyingId: "sol", instrumentId: "sol-perp", venueId: "drift", signedQuantityAtoms: -1_000_000_000n, lotAtoms: 1_000_000n, ratioNumerator: -1n, ratioDenominator: 1n },
    ];
    const initial: StrategyState = {
      version: 1, strategyId: "carry-1", ownerId: owner.id, subaccountId: "desk-1", seriesId: "sol-cash-carry", executionClassId: "sol-carry", open: true, stateVersion: 1n,
      legs, liabilities: [], delegations: [], venuePositionsTransferable: true, legalTransferRestricted: false,
    };
    const build = (who: { id: string }, parameters: StrategyCommandInput["parameters"]): StrategyCommandInput => {
      const current = book.strategy("carry-1")?.state;
      return {
        commandVersion: 1, environment: "testnet", strategyId: "carry-1", actorId: who.id, atValue: BigInt(NOW_MS), parameters,
        expectedStateVersion: current?.stateVersion ?? 0n, expectedStateHash: current === undefined ? "00".repeat(32) : strategyStateHash(current),
      };
    };
    const signature = (who: { key: KeyObject }, full: StrategyCommandInput) => bs58.encode(sign(null, strategyCommandHash(full), who.key));
    const submit = (who: { id: string; key: KeyObject }, parameters: StrategyCommandInput["parameters"], consents: { signerId: string; authorization: { scheme: "ED25519"; signature: string } }[] = []) => {
      const full = build(who, parameters);
      return book.submit(full, { scheme: "ED25519", signature: signature(who, full) }, consents);
    };
    assert.ok((await submit(owner, { kind: "OPEN", originReceiptHash: "aa".repeat(32), state: initial })).accepted);

    const decrease = (hashes: string[]) => submit(owner, { kind: "DECREASE", changeBps: 5_000n, executionReceiptHashes: hashes });
    await assert.rejects(() => decrease(["b2".repeat(32)]), { code: "EXECUTION_MISMATCH" });
    await assert.rejects(() => decrease(["b9".repeat(32)]), { code: "RECEIPT_NOT_FOUND" });
    await assert.rejects(() => decrease(["aa".repeat(32)]), { code: "RECEIPT_CLAIMED" });
    await assert.rejects(() => decrease(["b3".repeat(32)]), { code: "RECEIPT_OWNER_MISMATCH" });
    const decreased = await decrease(["b1".repeat(32)]);
    assert.ok(decreased.accepted && decreased.receipt?.externalPositionsMoved === true);
    assert.equal(book.strategy("carry-1")?.state.legs.find((leg) => leg.legId === "spot")?.signedQuantityAtoms, 500_000_000n);
    receipts.set("b4".repeat(32), exitReceipt(owner.id, 250_000_000n));
    await assert.rejects(() => decrease(["b1".repeat(32)]), { code: "RECEIPT_CLAIMED" });

    // Novation: the signer's claim alone is not consent, and every venue's transfer must verify.
    const novation: StrategyCommandInput["parameters"] = { kind: "NOVATE", newOwnerId: buyer.id, venueConfirmations: [{ venueId: "phoenix", evidenceHash: "c1".repeat(32) }, { venueId: "drift", evidenceHash: "c2".repeat(32) }] };
    assert.deepEqual(await submit(owner, novation), { accepted: false, rejection: "CONSENT_MISSING" });
    const consent = () => [{ signerId: buyer.id, authorization: { scheme: "ED25519" as const, signature: signature(buyer, build(owner, novation)) } }];
    await assert.rejects(() => submit(owner, novation, [{ signerId: buyer.id, authorization: { scheme: "ED25519", signature: signature(owner, build(owner, novation)) } }]), { code: "INVALID_SIGNATURE" });
    verified.add(`phoenix:${"c1".repeat(32)}:${buyer.id}`);
    assert.deepEqual(await submit(owner, novation, consent()), { accepted: false, rejection: "VENUE_CONFIRMATION_MISSING" });
    verified.add(`drift:${"c2".repeat(32)}:${buyer.id}`);
    const novated = await submit(owner, novation, consent());
    assert.ok(novated.accepted);
    assert.equal(book.strategy("carry-1")?.state.ownerId, buyer.id);
    assert.equal(book.ownerStrategies(buyer.id).length, 1);
    assert.deepEqual(book.history("carry-1").at(-1)?.consents.map((entry) => entry.signerId), [buyer.id]);

    // The new owner exits with its own settled receipt, and the strategy closes.
    assert.deepEqual(await submit(owner, { kind: "EXIT", settlements: [], executionReceiptHashes: ["b3".repeat(32)] }), { accepted: false, rejection: "UNAUTHORIZED" });
    const exited = await submit(buyer, { kind: "EXIT", settlements: [], executionReceiptHashes: ["b3".repeat(32)] });
    assert.ok(exited.accepted);
    assert.equal(book.strategy("carry-1")?.state.open, false);
  } finally {
    book.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

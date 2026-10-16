import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assetAmount,
  assetRef,
  domainRef,
  strategyPackageReceiptHash,
  toHex,
  toProtocolJson,
  type AssetRef,
  type PackageOrder,
  type StrategyPackageReceipt,
} from "@naryx/protocol-types";
import {
  HyperliquidOwnerLedgerError,
  HyperliquidTestnetOwnerLedger,
} from "../src/hyperliquid-testnet-owner-ledger.js";
import {
  createHyperliquidTestnetExecutionGuard,
  hyperliquidTestnetAuthorizationTypedData,
  verifyHyperliquidTestnetAuthorization,
} from "../src/hyperliquid-testnet-owner-routes.js";
import type { HyperliquidTestnetTerminalExecutionResult } from "../src/hyperliquid-testnet-terminal.js";
import { routeFor, signedQuoteFor } from "./quote-fixtures.js";

const ALICE = `0x${"a1".repeat(20)}`;
const BOB = `0x${"b2".repeat(20)}`;
const TRADING = `0x${"c3".repeat(20)}`;
const LIMITS = { maxOpenPackagesPerOwner: 1, maxOpenNotionalQuoteAtoms: 5_000n };
const HASH = `0x${"dd".repeat(32)}`;
const KEY = "idem-0123456789ABCD";
const QUOTE = { assetId: "usdc", decimals: 6, assetManifestHash: new Uint8Array(32).fill(7) } as unknown as AssetRef;
const BASE = assetRef("hypercore:testnet:btc", "08".repeat(32), 5);
const DOMAIN = domainRef("hypercore:testnet", 1, "13".repeat(32));

function reconciled(
  attemptId: string,
  packageStatus: "COMPLETED_EXACT" | "NO_EFFECT" | "MANUAL_INTERVENTION",
  netSpot: string,
  perpetual: string,
): HyperliquidTestnetTerminalExecutionResult {
  return {
    attemptId, idempotencyKey: KEY, domain: "hypercore:testnet", environment: "TESTNET",
    status: "RECONCILED", submissionStatus: "ACKNOWLEDGED", packageStatus, reasons: [],
    actionCommitment: HASH, requestCommitment: HASH, rawEvidenceCommitments: [],
    observedNetSpotDeltaAtoms: netSpot, observedPerpetualDeltaAtoms: perpetual,
  };
}

function notSubmitted(attemptId: string): HyperliquidTestnetTerminalExecutionResult {
  return {
    attemptId, idempotencyKey: KEY, domain: "hypercore:testnet", environment: "TESTNET",
    status: "NOT_SUBMITTED", evidenceStatus: "PRECONDITION_REJECTED",
    actionCommitment: null, requestCommitment: null, errorCommitment: HASH,
  };
}

function strategyResult(attemptId: string, packageStatus: "COMPLETED" | "NO_EFFECT"): HyperliquidTestnetTerminalExecutionResult {
  return {
    attemptId, idempotencyKey: KEY, domain: "hypercore:testnet", environment: "TESTNET",
    status: "STRATEGY_EXECUTION", packageStatus, completedStages: [], stages: [],
  } as unknown as HyperliquidTestnetTerminalExecutionResult;
}

function withLedger(run: (ledger: HyperliquidTestnetOwnerLedger) => void | Promise<void>) {
  return async () => {
    const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-ledger-"));
    const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"));
    try {
      await run(ledger);
    } finally {
      ledger.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

const refused = (code: string) => (error: unknown) =>
  error instanceof HyperliquidOwnerLedgerError && error.code === code;

test("an owner exits only their own open package, and exactly it", withLedger((ledger) => {
  ledger.reserveEntry({ attemptId: "entry-alice-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
  ledger.settleEntry("entry-alice-1", reconciled("entry-alice-1", "COMPLETED_EXACT", "100", "-100"), 600n);
  const open = ledger.openPackage(ALICE)!;
  assert.equal(open.state, "OPEN");
  assert.deepEqual([open.spotQuantityAtoms, open.perpQuantityAtoms, open.entryNotionalAtoms], [100n, 100n, 600n]);
  assert.equal(ledger.openPackage(BOB), undefined);

  assert.throws(() => ledger.bindExitOrder(open.entryAttemptId, BOB, "e1".repeat(32)), refused("NO_OPEN_PACKAGE"));
  ledger.bindExitOrder(open.entryAttemptId, ALICE, "e1".repeat(32));
  const exact = {
    owner: ALICE, orderHash: "e1".repeat(32), perpQuantityAtoms: 100n,
    grossSpotQuantityAtoms: 100n, spotLotAtoms: 1n, entryReceiptHash: open.entryReceiptHash!,
  };
  // An exit order presented under another wallet, or for a different size, closes nothing.
  assert.throws(() => ledger.beginExit("exit-bob-1", { ...exact, owner: BOB }), refused("EXIT_PACKAGE_MISMATCH"));
  assert.throws(() => ledger.beginExit("exit-alice-1", { ...exact, grossSpotQuantityAtoms: 99n }), refused("EXIT_PACKAGE_MISMATCH"));
  assert.throws(() => ledger.beginExit("exit-alice-1", { ...exact, entryReceiptHash: "ff".repeat(32) }), refused("EXIT_PACKAGE_MISMATCH"));

  // Anyone can build a newer exit order for the package; the owner's earlier one stays valid.
  ledger.bindExitOrder(open.entryAttemptId, ALICE, "e2".repeat(32));
  ledger.beginExit("exit-alice-1", exact);
  ledger.settleExit("exit-alice-1", notSubmitted("exit-alice-1"));
  assert.equal(ledger.openPackage(ALICE)?.state, "OPEN");
  ledger.beginExit("exit-alice-2", exact);
  ledger.settleExit("exit-alice-2", reconciled("exit-alice-2", "COMPLETED_EXACT", "-100", "100"));
  assert.equal(ledger.openPackage(ALICE), undefined);
  assert.equal(ledger.packages(ALICE)[0]?.state, "CLOSED");
}));

test("entries respect the per-owner package limit and the omnibus notional limit", withLedger((ledger) => {
  ledger.reserveEntry({ attemptId: "entry-alice-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-alice-2", owner: ALICE, orderHash: "02".repeat(32), notionalAtoms: 1n, limits: LIMITS }),
    refused("OWNER_PACKAGE_LIMIT"),
  );
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "03".repeat(32), notionalAtoms: 4_001n, limits: LIMITS }),
    refused("OMNIBUS_NOTIONAL_LIMIT"),
  );
  ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "03".repeat(32), notionalAtoms: 4_000n, limits: LIMITS });
  // A package that never reached the venue returns its reservation.
  ledger.settleEntry("entry-alice-1", reconciled("entry-alice-1", "NO_EFFECT", "0", "0"), 600n);
  assert.deepEqual(ledger.packages(ALICE), []);
  ledger.reserveEntry({ attemptId: "entry-alice-2", owner: ALICE, orderHash: "02".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
}));

test("only the owner wallet's typed-data signature authorizes its package", withLedger(async (ledger) => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const input = { orderHash: "0a".repeat(32), action: "ENTRY" as const, owner: owner.address.toLowerCase(), tradingAccount: TRADING };
  const typed = hyperliquidTestnetAuthorizationTypedData(input);
  const sign = (account: typeof owner, orderHash = input.orderHash) => account.signTypedData({
    domain: typed.domain,
    types: { PackageAuthorization: [...typed.types.PackageAuthorization] },
    primaryType: "PackageAuthorization",
    message: { ...typed.message, orderHash: `0x${orderHash}` as `0x${string}`, owner: input.owner as `0x${string}`, tradingAccount: TRADING as `0x${string}` },
  });
  assert.equal(await verifyHyperliquidTestnetAuthorization(input, await sign(owner)), true);
  assert.equal(await verifyHyperliquidTestnetAuthorization(input, await sign(stranger)), false);
  assert.equal(await verifyHyperliquidTestnetAuthorization(input, await sign(owner, "0b".repeat(32))), false);

  const order = {
    owner: input.owner, settlementAccount: TRADING, action: "ENTRY",
    maxSpotQuoteIn: { atoms: 1_000n }, quantity: { atoms: 100n },
  } as unknown as PackageOrder;
  const guard = createHyperliquidTestnetExecutionGuard({
    ledger,
    intents: {
      getAttempt: () => ({ status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED", orderHash: input.orderHash }) as never,
      getAttemptForOrder: () => undefined,
      getSelectedQuote: () => undefined,
    },
    orders: { getCanonicalOrderByHash: () => order },
    tradingAccount: TRADING,
    limits: LIMITS,
    quoteAsset: QUOTE,
    spotLotAtoms: 1n,
  });
  const request = { attemptId: `hyperliquid-testnet-${"ab".repeat(24)}`, idempotencyKey: KEY };
  assert.throws(() => guard.admit(request), /OWNER_AUTHORIZATION_REQUIRED|must sign/);
  ledger.recordAuthorization(input.orderHash, input.owner, await sign(owner));
  assert.throws(() => ledger.recordAuthorization(input.orderHash, BOB, "0x00"), refused("LEDGER_CONFLICT"));
  guard.admit(request);
  assert.equal(ledger.packages(input.owner)[0]?.state, "PENDING_ENTRY");
}));

test("a generalized strategy attempt requires its own authorization and reserves under the cash caps", withLedger((ledger) => {
  const sourceOrderHash = "0c".repeat(32);
  const strategyOrderHash = "0d".repeat(32);
  const sourceAttemptId = `hyperliquid-testnet-${"cd".repeat(24)}`;
  const strategyAttemptId = `strategy-hl-${"ef".repeat(24)}`;
  let generalizedAuthorized = false;
  const order = {
    owner: ALICE, settlementAccount: TRADING, action: "ENTRY",
    maxSpotQuoteIn: { atoms: 1_000n }, quantity: { atoms: 100n },
  } as unknown as PackageOrder;
  const guard = createHyperliquidTestnetExecutionGuard({
    ledger,
    intents: {
      getAttempt: () => undefined,
      getAttemptForOrder: (orderHash) => orderHash === sourceOrderHash ? ({
        attemptId: sourceAttemptId,
        orderHash: sourceOrderHash,
        status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED",
        domainId: "hypercore:testnet",
      }) as never : undefined,
      getSelectedQuote: () => undefined,
    },
    orders: { getCanonicalOrderByHash: (orderHash) => orderHash === sourceOrderHash ? order : undefined },
    strategyAttempts: {
      anyStrategyExecutionAttempt: (attemptId: string) => attemptId === strategyAttemptId
        ? { sourceOrderHashHex: sourceOrderHash, orderHashHex: strategyOrderHash, quoteHashHex: "0e".repeat(32) } : undefined,
    },
    strategyReceipts: {
      anyStrategyExecutionAttempt: (attemptId: string) => attemptId === strategyAttemptId
        ? { sourceOrderHashHex: sourceOrderHash, orderHashHex: strategyOrderHash, quoteHashHex: "0e".repeat(32) } as never
        : undefined,
      admissionByQuote: () => ({
        orderHashHex: strategyOrderHash,
        order: { owner: ALICE, settlementAccount: TRADING, lifecycleAction: "ENTRY" },
        quote: { totalGrossNotional: { asset: QUOTE, atoms: 1_000n } },
      }) as never,
      ownerAuthorization: () => generalizedAuthorized
        ? { owner: ALICE } as never : undefined,
      nativeStrategyPositionByStateHash: () => undefined,
      recordReceipt: () => { throw new Error("must not record during admission"); },
      receiptByQuote: () => undefined,
      nativeStrategyReduction: () => undefined,
    },
    tradingAccount: TRADING,
    limits: LIMITS,
    quoteAsset: QUOTE,
    spotLotAtoms: 1n,
  });
  const request = { attemptId: strategyAttemptId, idempotencyKey: KEY };
  assert.throws(() => guard.admit(request), /OWNER_AUTHORIZATION_REQUIRED|must sign/);
  ledger.recordAuthorization(sourceOrderHash, ALICE, "0x00");
  assert.throws(() => guard.admit(request), /OWNER_AUTHORIZATION_REQUIRED|must sign/);
  generalizedAuthorized = true;
  guard.admit(request);
  // A source-backed entry is a cash-and-carry package: it holds the owner's one package slot and its
  // signed notional in the shared account.
  assert.deepEqual(ledger.packages(ALICE).map((entry) => [entry.entryAttemptId, entry.state, entry.reservedNotionalAtoms]),
    [[strategyAttemptId, "PENDING_ENTRY", 1_000n]]);
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-alice-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1n, limits: LIMITS }),
    refused("OWNER_PACKAGE_LIMIT"),
  );
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "02".repeat(32), notionalAtoms: 4_001n, limits: LIMITS }),
    refused("OMNIBUS_NOTIONAL_LIMIT"),
  );
}));

const STRATEGY_ATTEMPT = (n: number) => `strategy-hl-${n.toString(16).padStart(48, "0")}`;

function strategyGuard(
  ledger: HyperliquidTestnetOwnerLedger,
  admissions: ReadonlyMap<string, Readonly<{
    owner: string; action: string; notionalAtoms: bigint; quoteAsset?: typeof QUOTE;
  }>>,
  limits: typeof LIMITS | null = LIMITS,
) {
  const attempt = (attemptId: string) => admissions.has(attemptId)
    ? { orderHashHex: attemptId.slice(-32).padStart(64, "0"), quoteHashHex: attemptId.slice(-32).padStart(64, "1") } as never
    : undefined;
  return createHyperliquidTestnetExecutionGuard({
    ledger,
    intents: { getAttempt: () => undefined, getAttemptForOrder: () => undefined, getSelectedQuote: () => undefined },
    orders: { getCanonicalOrderByHash: () => undefined },
    strategyAttempts: { anyStrategyExecutionAttempt: attempt },
    strategyReceipts: {
      anyStrategyExecutionAttempt: attempt,
      admissionByQuote: (quoteHashHex: string) => {
        const [attemptId, entry] = [...admissions].find(([id]) => id.slice(-32).padStart(64, "1") === quoteHashHex)!;
        return {
          orderHashHex: attemptId.slice(-32).padStart(64, "0"),
          order: {
            owner: entry.owner, settlementAccount: TRADING, lifecycleAction: entry.action,
            expectedStrategyStateHash: new Uint8Array(32).fill(9),
          },
          quote: { totalGrossNotional: { asset: entry.quoteAsset ?? QUOTE, atoms: entry.notionalAtoms } },
        } as never;
      },
      ownerAuthorization: (orderHashHex: string) => ({
        owner: [...admissions].find(([id]) => id.slice(-32).padStart(64, "0") === orderHashHex)![1].owner,
      }) as never,
      nativeStrategyPositionByStateHash: () => undefined,
      recordReceipt: () => { throw new Error("no receipt for an unsubmitted attempt"); },
      receiptByQuote: () => undefined,
      nativeStrategyReduction: () => undefined,
    },
    tradingAccount: TRADING,
    limits: limits ?? undefined,
    quoteAsset: QUOTE,
    spotLotAtoms: 1n,
  });
}

test("a generalized entry reserves its signed quote notional and is refused at either cap; reducing actions never are", withLedger((ledger) => {
  const admissions = new Map([
    [STRATEGY_ATTEMPT(1), { owner: ALICE, action: "ENTRY", notionalAtoms: 1_000n }],
    [STRATEGY_ATTEMPT(2), { owner: BOB, action: "ENTRY", notionalAtoms: 4_001n }],
    [STRATEGY_ATTEMPT(3), { owner: BOB, action: "ENTRY", notionalAtoms: 4_000n }],
    [STRATEGY_ATTEMPT(4), { owner: ALICE, action: "DECREASE", notionalAtoms: 9_000n }],
    [STRATEGY_ATTEMPT(5), { owner: ALICE, action: "EXIT", notionalAtoms: 9_000n }],
    [STRATEGY_ATTEMPT(6), { owner: BOB, action: "ENTRY", notionalAtoms: 1n, quoteAsset: { ...QUOTE, decimals: 18 } }],
  ]);
  const guard = strategyGuard(ledger, admissions);
  const admit = (n: number) => guard.admit({ attemptId: STRATEGY_ATTEMPT(n), idempotencyKey: KEY });
  // Alice's one slot is a cash-and-carry package: her generalized entry is refused.
  ledger.reserveEntry({ attemptId: "entry-alice-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
  assert.throws(() => admit(1), { code: "OWNER_PACKAGE_LIMIT" });
  // 1000 of 5000 is held; 4001 more exceeds the account, exactly 4000 fits.
  assert.throws(() => admit(2), { code: "OMNIBUS_NOTIONAL_LIMIT" });
  assert.throws(() => admit(6), { code: "STRATEGY_NOTIONAL_UNAVAILABLE" });
  admit(3);
  // Both caps are now full, and a decrease or exit of a strategy is still admitted.
  admit(4);
  admit(5);
  assert.throws(() => strategyGuard(ledger, admissions, null).admit({ attemptId: STRATEGY_ATTEMPT(3), idempotencyKey: KEY }),
    { code: "OMNIBUS_LIMITS_UNCONFIGURED" });
  // An entry that never reached the venue returns its reservation.
  guard.settle({ attemptId: STRATEGY_ATTEMPT(3), idempotencyKey: KEY }, notSubmitted(STRATEGY_ATTEMPT(3)));
  ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "02".repeat(32), notionalAtoms: 4_000n, limits: LIMITS });
}));

test("a strategy reservation is held while unresolved, released on no effect, and kept once completed", withLedger((ledger) => {
  const reserve = (attemptId: string, owner: string, notionalAtoms: bigint, strategyKey = attemptId, newPackage = true) =>
    ledger.reserveExposure({ attemptId, owner, strategyKey, notionalAtoms, newPackage, limits: LIMITS });
  reserve("alice-entry", ALICE, 5_000n);
  ledger.settleExposure("alice-entry", reconciled("alice-entry", "MANUAL_INTERVENTION", "0", "0"));
  assert.throws(() => reserve("bob-entry", BOB, 1n), refused("OMNIBUS_NOTIONAL_LIMIT"));
  ledger.settleExposure("alice-entry", strategyResult("alice-entry", "NO_EFFECT"));
  // A released attempt admitted again reserves nothing.
  reserve("alice-entry", ALICE, 5_000n);
  reserve("bob-entry", BOB, 4_000n);
  ledger.settleExposure("bob-entry", strategyResult("bob-entry", "COMPLETED"));
  ledger.settleExposure("bob-entry", strategyResult("bob-entry", "NO_EFFECT"));
  assert.throws(() => reserve("carol-entry", ALICE, 1_001n), refused("OMNIBUS_NOTIONAL_LIMIT"));
  // An increase shares its strategy's slot; another entry by the same owner does not.
  assert.throws(() => reserve("bob-entry-2", BOB, 1n), refused("OWNER_PACKAGE_LIMIT"));
  reserve("bob-increase", BOB, 1_000n, "bob-entry", false);
  assert.throws(() => reserve("bob-increase-2", BOB, 1n, "bob-entry", false), refused("OMNIBUS_NOTIONAL_LIMIT"));
}));

test("a completed strategy decrease or exit releases its exposure exactly once, rounded toward holding", withLedger((ledger) => {
  const limits = { maxOpenPackagesPerOwner: 2, maxOpenNotionalQuoteAtoms: 10_000n };
  const reserve = (attemptId: string, owner: string, notionalAtoms: bigint, strategyKey = attemptId, newPackage = true) =>
    ledger.reserveExposure({ attemptId, owner, strategyKey, notionalAtoms, newPackage, limits });
  const reduce = (attemptId: string, result: HyperliquidTestnetTerminalExecutionResult, reducedQuantityAtoms: bigint | null) =>
    ledger.settleReduction({ attemptId, strategyKey: "strategy-k", result, reducedQuantityAtoms, priorQuantityAtoms: 3n });
  reserve("entry", ALICE, 6_001n, "strategy-k");
  ledger.settleExposure("entry", strategyResult("entry", "COMPLETED"));
  reserve("increase", ALICE, 3_000n, "strategy-k", false);
  ledger.settleExposure("increase", strategyResult("increase", "COMPLETED"));
  // Unresolved or no-effect reductions hold everything: 9001 of 10000 stays held.
  reduce("decrease", reconciled("decrease", "MANUAL_INTERVENTION", "0", "0"), 1n);
  reduce("decrease", strategyResult("decrease", "NO_EFFECT"), 1n);
  assert.throws(() => reserve("bob-1", BOB, 1_000n), refused("OMNIBUS_NOTIONAL_LIMIT"));
  // A third closed: 6001 keeps 4001 (2000 released, rounded down) and 3000 keeps 2000. Applied once.
  reduce("decrease", strategyResult("decrease", "COMPLETED"), 1n);
  reduce("decrease", strategyResult("decrease", "COMPLETED"), 1n);
  assert.throws(() => reserve("bob-1", BOB, 4_000n), refused("OMNIBUS_NOTIONAL_LIMIT"));
  reserve("bob-1", BOB, 3_999n);
  // A completed exit releases the strategy's slot and every notional it held.
  reduce("exit", strategyResult("exit", "COMPLETED"), null);
  reserve("alice-2", ALICE, 3_000n);
  reserve("alice-3", ALICE, 3_001n);
}));

test("a strategy backfill counts each pre-ledger execution once, never revives a release, and frees closed strategies", withLedger((ledger) => {
  const reconcile = (open: { attemptId: string; owner: string; strategyKey: string; notionalAtoms: bigint }[], closedStrategyKeys: string[] = []) =>
    ledger.reconcileStrategyExposures({ open, closedStrategyKeys });
  const reserve = (attemptId: string, owner: string, notionalAtoms: bigint) =>
    ledger.reserveExposure({ attemptId, owner, strategyKey: attemptId, notionalAtoms, newPackage: true, limits: LIMITS });
  const aliceEntry = { attemptId: "alice-entry", owner: ALICE, strategyKey: "alice-k", notionalAtoms: 3_000n };
  assert.deepEqual(reconcile([aliceEntry]), { backfilled: 1, released: 0 });
  assert.deepEqual(reconcile([aliceEntry]), { backfilled: 0, released: 0 });
  assert.throws(() => reserve("alice-2", ALICE, 1n), refused("OWNER_PACKAGE_LIMIT"));
  assert.throws(() => reserve("bob-1", BOB, 2_001n), refused("OMNIBUS_NOTIONAL_LIMIT"));
  // An exit released the strategy; a store still listing its entry does not revive it.
  ledger.applyReduction({ attemptId: "alice-exit", strategyKey: "alice-k", reducedQuantityAtoms: null, priorQuantityAtoms: 1n });
  assert.deepEqual(reconcile([aliceEntry]), { backfilled: 0, released: 0 });
  reserve("bob-1", BOB, 5_000n);
  // A strategy the store closed while its reduction went unreported is released at the next startup.
  assert.deepEqual(reconcile([], ["bob-1"]), { backfilled: 0, released: 1 });
  reserve("alice-2", ALICE, 5_000n);
  assert.throws(() => reconcile([{ ...aliceEntry, attemptId: "alice-zero", notionalAtoms: 0n }]), refused("LEDGER_CONFLICT"));
}));

test("an UNRESOLVED entry or exit takes its later final outcome, and a later unresolved one changes nothing", withLedger((ledger) => {
  ledger.reserveEntry({ attemptId: "entry-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
  ledger.settleEntry("entry-1", reconciled("entry-1", "MANUAL_INTERVENTION", "0", "0"), 600n);
  assert.equal(ledger.packages(ALICE)[0]?.state, "UNRESOLVED");
  // Still not final: stays UNRESOLVED.
  ledger.settleEntry("entry-1", reconciled("entry-1", "MANUAL_INTERVENTION", "0", "0"), 600n);
  assert.equal(ledger.packages(ALICE)[0]?.state, "UNRESOLVED");
  // The lane release reconciled it as completed: the package opens with its observed legs.
  ledger.settleEntry("entry-1", reconciled("entry-1", "COMPLETED_EXACT", "100", "-100"), 600n);
  assert.equal(ledger.packages(ALICE)[0]?.state, "OPEN");
  assert.equal(ledger.packages(ALICE)[0]?.spotQuantityAtoms, 100n);

  ledger.bindExitOrder("entry-1", ALICE, "09".repeat(32));
  ledger.beginExit("exit-1", {
    owner: ALICE, orderHash: "09".repeat(32), perpQuantityAtoms: 100n, grossSpotQuantityAtoms: 100n, spotLotAtoms: 1n,
    entryReceiptHash: ledger.packages(ALICE)[0]!.entryReceiptHash!,
  });
  ledger.settleExit("exit-1", reconciled("exit-1", "MANUAL_INTERVENTION", "0", "0"));
  assert.equal(ledger.packages(ALICE)[0]?.state, "UNRESOLVED");
  ledger.settleExit("exit-1", reconciled("exit-1", "COMPLETED_EXACT", "-100", "100"));
  assert.equal(ledger.packages(ALICE)[0]?.state, "CLOSED");
}));

test("a ledger created under the first table rule is rebuilt once, keeping its rows", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-ledger-"));
  const path = join(scratch, "execution.db");
  try {
    const old = new Database(path);
    old.exec(`
      CREATE TABLE hyperliquid_owner_packages (
        entry_attempt_id TEXT PRIMARY KEY, owner TEXT NOT NULL, entry_order_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('PENDING_ENTRY', 'OPEN', 'EXITING', 'CLOSED', 'UNRESOLVED')),
        reserved_notional_atoms TEXT NOT NULL, perp_quantity_atoms TEXT, spot_quantity_atoms TEXT,
        entry_notional_atoms TEXT, entry_receipt_hash TEXT UNIQUE, exit_order_hash TEXT UNIQUE,
        exit_attempt_id TEXT UNIQUE, opened_at_ms INTEGER, closed_at_ms INTEGER, updated_at_ms INTEGER NOT NULL,
        CHECK ((state IN ('OPEN', 'EXITING', 'CLOSED')) = (entry_receipt_hash IS NOT NULL))
      ) STRICT;
      INSERT INTO hyperliquid_owner_packages (entry_attempt_id, owner, entry_order_hash, state, reserved_notional_atoms, updated_at_ms)
      VALUES ('entry-old', '${ALICE}', '${"01".repeat(32)}', 'PENDING_ENTRY', '1000', 1);
    `);
    old.close();
    const ledger = new HyperliquidTestnetOwnerLedger(path);
    try {
      assert.equal(ledger.packages(ALICE)[0]?.state, "PENDING_ENTRY");
      ledger.settleEntry("entry-old", reconciled("entry-old", "COMPLETED_EXACT", "100", "-100"), 600n);
      assert.equal(ledger.packages(ALICE)[0]?.state, "OPEN");
    } finally {
      ledger.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a package listing shows each Hyperliquid entry and exit attempt's state", withLedger((ledger) => {
  ledger.reserveEntry({ attemptId: "entry-1", owner: ALICE, orderHash: "01".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
  assert.equal(ledger.attemptOutcome("entry-1")?.state, "PENDING_ENTRY");
  ledger.settleEntry("entry-1", reconciled("entry-1", "COMPLETED_EXACT", "100", "-100"), 600n);
  assert.equal(ledger.attemptOutcome("entry-1")?.state, "OPEN");
  // The listing's receipt reference has the shape every lane's listing uses (the web rejects others).
  assert.match(ledger.attemptOutcome("entry-1")?.receiptHash ?? "", /^0x[0-9a-f]{64}$/);
  ledger.bindExitOrder("entry-1", ALICE, "09".repeat(32));
  ledger.beginExit("exit-1", {
    owner: ALICE, orderHash: "09".repeat(32), perpQuantityAtoms: 100n, grossSpotQuantityAtoms: 100n, spotLotAtoms: 1n,
    entryReceiptHash: ledger.packages(ALICE)[0]!.entryReceiptHash!,
  });
  ledger.settleExit("exit-1", reconciled("exit-1", "COMPLETED_EXACT", "-100", "100"));
  assert.equal(ledger.attemptOutcome("exit-1")?.state, "CLOSED");
  assert.equal(ledger.attemptOutcome("entry-1")?.state, "OPENED");
  assert.equal(ledger.attemptOutcome("unknown"), undefined);
}));

test("an owner's open package stays listed behind any number of later closed packages", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-hyperliquid-ledger-"));
  let now = 1;
  const ledger = new HyperliquidTestnetOwnerLedger(join(scratch, "execution.db"), () => now++);
  const limits = { maxOpenPackagesPerOwner: 2, maxOpenNotionalQuoteAtoms: 5_000n };
  try {
    ledger.reserveEntry({ attemptId: "entry-old", owner: ALICE, orderHash: "f0".repeat(32), notionalAtoms: 1_000n, limits });
    ledger.settleEntry("entry-old", reconciled("entry-old", "COMPLETED_EXACT", "100", "-100"), 600n);
    for (let index = 0; index < 22; index += 1) {
      const id = `entry-${index}`;
      const exitHash = index.toString(16).padStart(2, "0").repeat(32);
      ledger.reserveEntry({ attemptId: id, owner: ALICE, orderHash: `a${index.toString(16).padStart(2, "0")}`.padEnd(64, "0"), notionalAtoms: 1_000n, limits });
      ledger.settleEntry(id, reconciled(id, "COMPLETED_EXACT", "100", "-100"), 600n);
      ledger.bindExitOrder(id, ALICE, exitHash);
      ledger.beginExit(`exit-${index}`, {
        owner: ALICE, orderHash: exitHash, perpQuantityAtoms: 100n, grossSpotQuantityAtoms: 100n, spotLotAtoms: 1n,
        entryReceiptHash: ledger.openPackage(ALICE, id)!.entryReceiptHash!,
      });
      ledger.settleExit(`exit-${index}`, reconciled(`exit-${index}`, "COMPLETED_EXACT", "-100", "100"));
    }
    const listed = ledger.packages(ALICE);
    assert.equal(listed.length, 21);
    assert.deepEqual(listed.filter((row) => row.state !== "CLOSED").map((row) => row.entryAttemptId), ["entry-old"]);
    assert.equal(listed[0]?.entryAttemptId, "entry-21");
    assert.equal(listed.some((row) => row.entryAttemptId === "entry-0" || row.entryAttemptId === "entry-1"), false);
    assert.deepEqual(ledger.packages(BOB), []);
  } finally {
    ledger.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const commitment = (byte: string) => `0x${byte.repeat(32)}`;

/**
 * One source-backed generalized entry of a cash-and-carry source order: the guard over shape-only
 * store fakes, the executor's completed strategy result (spot bought 100 with a 1 base-atom fee,
 * 100 sold short), and the source quote's expected perp notional as the entry notional.
 */
function sourceBackedEntry(ledger: HyperliquidTestnetOwnerLedger, n: number, owner: string, options: Readonly<{
  selectedSourceQuote?: boolean;
  exitOrders?: Map<string, PackageOrder>;
  exitAttempts?: Map<string, string>;
}> = {}) {
  const byte = (offset: number) => (n * 16 + offset).toString(16).padStart(2, "0");
  const strategyOrderHash = byte(1).repeat(32);
  const strategyQuoteHash = byte(2).repeat(32);
  const sourceOrderHash = byte(3).repeat(32);
  const sourceAttemptId = `hyperliquid-testnet-${byte(4).repeat(24)}`;
  const attemptId = `strategy-hl-${byte(5).repeat(24)}`;
  const leg = (legId: string, legFamily: string, side: string) => ({
    legId, legFamily, side, domain: DOMAIN, quantityAsset: BASE, quantityAtoms: 100n, minimumQuantityAtoms: 90n,
    maximumFeeQuoteAtoms: 25n,
  });
  const admission = {
    orderHashHex: strategyOrderHash, graphHashHex: byte(6).repeat(32), quoteHashHex: strategyQuoteHash,
    routeHashHex: byte(7).repeat(32),
    order: {
      environment: "testnet", templateId: "cash-and-carry-v1", templateVersion: 1,
      packageTemplateManifestHash: new Uint8Array(32).fill(0x31), seriesId: "btc-cash-carry-usdc", seriesVersion: 1,
      seriesManifestHash: new Uint8Array(32).fill(0x32), executionClassId: "hyperliquid-testnet-batched-ioc",
      executionClassVersion: 1, executionClassManifestHash: new Uint8Array(32).fill(0x33), lifecycleAction: "ENTRY",
      owner, settlementAccount: TRADING, settlementClass: "BATCHED_IOC_WITH_RECOVERY", quoteAsset: QUOTE,
      maximumResidualValue: assetAmount(QUOTE, 100n),
      maximumVenueFeesByAsset: [{ asset: QUOTE, maxAtoms: 35n }],
    },
    graph: { legs: [leg("spot", "SPOT_SWAP", "BUY"), leg("perp", "PERP_OPEN", "SELL")] },
    quote: {
      domains: [DOMAIN], solverId: "solver-hypercore-testnet-v1", totalGrossNotional: assetAmount(QUOTE, 1_000n),
      passThroughCosts: [{ category: "VENUE", amount: assetAmount(QUOTE, 35n) }],
    },
    route: { domainPlans: [{ domain: DOMAIN }] },
  };
  const observed = (legId: string, signed: string, feeAsset: AssetRef, fee: string) => ({
    legId, clientOrderId: `0x${byte(8).repeat(16)}`, plannedSignedBaseAtoms: signed, filledSignedBaseAtoms: signed,
    terminalStatus: "FILLED", openOrderStatus: "NONE", orderId: 1, fillCount: 1, grossQuoteAtoms: "6000000",
    feeAssetId: feeAsset.assetId, feeAssetDecimals: feeAsset.decimals, feeAtoms: fee, venueFeeQuoteAtoms: "10",
    observedAtMs: "1000000", evidenceCommitment: commitment(byte(9)),
  });
  const result = {
    attemptId, idempotencyKey: KEY, domain: "hypercore:testnet", environment: "TESTNET",
    status: "STRATEGY_EXECUTION", packageStatus: "COMPLETED", completedStages: [1],
    stages: [{
      batchStage: 1, submissionStatus: "ACKNOWLEDGED", actionCommitment: commitment(byte(10)),
      requestCommitment: commitment(byte(11)),
      evidence: {
        status: "COMPLETE", outcome: "COMPLETED", reasons: [], observedAtMs: "1000000", rawEvidenceCommitments: [],
        legs: [observed("spot", "100", BASE, "1"), observed("perp", "-100", QUOTE, "10")],
      },
    }],
  } as unknown as HyperliquidTestnetTerminalExecutionResult;
  const route = routeFor(sourceOrderHash, DOMAIN, "testnet");
  const sourceQuote = signedQuoteFor({
    orderHash: sourceOrderHash, route, environment: "testnet", domain: DOMAIN, solverId: "solver-a",
    manifestHash: "ab".repeat(32), quoteKey: generateKeyPairSync("ed25519").privateKey,
    validUntilUnit: "HYPERLIQUID_UNIX_MILLISECONDS", validUntilValue: 2_000_000n,
  });
  const receipts = new Map<string, string>();
  const recorded: string[] = [];
  const strategyAttempt = (id: string) => id === attemptId
    ? { sourceOrderHashHex: sourceOrderHash, orderHashHex: strategyOrderHash, quoteHashHex: strategyQuoteHash } as never
    : undefined;
  const guard = createHyperliquidTestnetExecutionGuard({
    ledger,
    intents: {
      getAttempt: (id) => options.exitAttempts?.has(id) === true
        ? { status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED", orderHash: options.exitAttempts.get(id) } as never : undefined,
      getAttemptForOrder: (orderHash) => orderHash === sourceOrderHash ? {
        attemptId: sourceAttemptId, orderHash, status: "HYPERLIQUID_TESTNET_QUOTE_SELECTED", domainId: "hypercore:testnet",
      } as never : undefined,
      getSelectedQuote: (id) => id === sourceAttemptId && options.selectedSourceQuote !== false
        ? { quote: toProtocolJson(sourceQuote) } as never : undefined,
    },
    orders: {
      getCanonicalOrderByHash: (orderHash) => orderHash === sourceOrderHash
        ? { owner, settlementAccount: TRADING, action: "ENTRY" } as unknown as PackageOrder
        : options.exitOrders?.get(orderHash as string),
    },
    strategyAttempts: { anyStrategyExecutionAttempt: strategyAttempt },
    strategyReceipts: {
      anyStrategyExecutionAttempt: strategyAttempt,
      admissionByQuote: () => admission as never,
      ownerAuthorization: () => ({ owner }) as never,
      nativeStrategyPositionByStateHash: () => undefined,
      recordReceipt: (receipt) => {
        const receiptHashHex = toHex(strategyPackageReceiptHash(receipt as StrategyPackageReceipt));
        recorded.push(receiptHashHex);
        receipts.set(toHex((receipt as StrategyPackageReceipt).quoteHash), receiptHashHex);
        return { created: true, receiptHashHex };
      },
      receiptByQuote: (quoteHashHex) => receipts.has(quoteHashHex)
        ? { receiptHashHex: receipts.get(quoteHashHex) } as never : undefined,
      nativeStrategyReduction: () => undefined,
    },
    tradingAccount: TRADING,
    limits: LIMITS,
    quoteAsset: QUOTE,
    spotLotAtoms: 10n,
  });
  return { guard, attemptId, request: { attemptId, idempotencyKey: KEY }, result, recorded, strategyOrderHash };
}

test("a source-backed entry opens one owner package from its net fill and exits only through its owner's cash-and-carry exit", withLedger((ledger) => {
  const exitOrders = new Map<string, PackageOrder>();
  const exitAttempts = new Map<string, string>();
  const entry = sourceBackedEntry(ledger, 1, ALICE, { exitOrders, exitAttempts });
  entry.guard.admit(entry.request);
  // The package holds the signed notional once: 1000 of 5000, so another owner's 4001 is refused.
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "f1".repeat(32), notionalAtoms: 4_001n, limits: LIMITS }),
    refused("OMNIBUS_NOTIONAL_LIMIT"),
  );
  // Settled on execution and again on a status read: one receipt, one package.
  entry.guard.settle(entry.request, entry.result);
  entry.guard.settle(entry.request, entry.result);
  assert.equal(entry.recorded.length, 1);
  const open = ledger.openPackage(ALICE, entry.attemptId)!;
  assert.deepEqual(
    [open.state, open.spotQuantityAtoms, open.perpQuantityAtoms, open.entryNotionalAtoms, open.entryReceiptHash],
    ["OPEN", 99n, 100n, 99_500_000n, entry.recorded[0]],
  );
  ledger.reserveEntry({ attemptId: "entry-bob-1", owner: BOB, orderHash: "f1".repeat(32), notionalAtoms: 4_000n, limits: LIMITS });

  // Another wallet cannot bind or present an exit for it.
  assert.throws(() => ledger.bindExitOrder(entry.attemptId, BOB, "e3".repeat(32)), refused("NO_OPEN_PACKAGE"));
  const exitOrder = (exitOwner: string) => ({
    owner: exitOwner, settlementAccount: TRADING, action: "EXIT", quantity: { atoms: 100n },
    // HyperCore sells whole lots: 99 floored to the 10-atom lot is 90; the 9 atoms stay as dust.
    hyperliquidGrossSpotQuantity: { atoms: 90n }, entryReceiptHash: Buffer.from(open.entryReceiptHash!, "hex"),
  }) as unknown as PackageOrder;
  const bobExit = { attemptId: `hyperliquid-testnet-${"e2".repeat(24)}`, idempotencyKey: KEY };
  exitOrders.set("e2".repeat(32), exitOrder(BOB));
  exitAttempts.set(bobExit.attemptId, "e2".repeat(32));
  ledger.recordAuthorization("e2".repeat(32), BOB, "0x00");
  assert.throws(() => entry.guard.admit(bobExit), { code: "EXIT_PACKAGE_MISMATCH" });

  const aliceExit = { attemptId: `hyperliquid-testnet-${"e1".repeat(24)}`, idempotencyKey: KEY };
  exitOrders.set("e1".repeat(32), exitOrder(ALICE));
  exitAttempts.set(aliceExit.attemptId, "e1".repeat(32));
  ledger.recordAuthorization("e1".repeat(32), ALICE, "0x00");
  ledger.bindExitOrder(entry.attemptId, ALICE, "e1".repeat(32));
  entry.guard.admit(aliceExit);
  assert.equal(ledger.packages(ALICE)[0]?.exitSpotQuantityAtoms, 90n);
  entry.guard.settle(aliceExit, reconciled(aliceExit.attemptId, "COMPLETED_EXACT", "-90", "100"));
  assert.equal(ledger.packages(ALICE)[0]?.state, "CLOSED");
  // The closed package freed its slot and notional.
  ledger.reserveEntry({ attemptId: "entry-alice-2", owner: ALICE, orderHash: "f2".repeat(32), notionalAtoms: 1_000n, limits: LIMITS });
}));

test("source-backed entries completed under strategy exposure migrate once onto packages, counted once", withLedger((ledger) => {
  const legacy = (entry: ReturnType<typeof sourceBackedEntry>, owner: string) => {
    ledger.reserveExposure({
      attemptId: entry.attemptId, owner, strategyKey: entry.strategyOrderHash, notionalAtoms: 1_000n, newPackage: true, limits: LIMITS,
    });
    ledger.settleExposure(entry.attemptId, entry.result);
  };
  const alice = sourceBackedEntry(ledger, 1, ALICE);
  const bob = sourceBackedEntry(ledger, 2, BOB, { selectedSourceQuote: false });
  legacy(alice, ALICE);
  legacy(bob, BOB);
  const lines: string[] = [];
  const migrate = (entry: typeof alice) => entry.guard.migrateSourceBackedEntries(
    [entry.request, { attemptId: `strategy-hl-${"99".repeat(24)}`, idempotencyKey: KEY }],
    (request) => request.attemptId === entry.attemptId ? entry.result : undefined,
    (line) => lines.push(line),
  );
  assert.deepEqual(migrate(alice), { migrated: 1, skipped: 0 });
  // Without the source quote's entry notional the exit limits cannot be derived: skipped, reported, still held.
  assert.deepEqual(migrate(bob), { migrated: 0, skipped: 1 });
  assert.match(lines[0] ?? "", new RegExp(`skipped ${bob.attemptId}`));
  assert.deepEqual(ledger.packages(BOB), []);
  const open = ledger.openPackage(ALICE, alice.attemptId)!;
  assert.deepEqual([open.spotQuantityAtoms, open.perpQuantityAtoms, open.entryReceiptHash], [99n, 100n, alice.recorded[0]]);
  // A second startup changes nothing, and each entry is still counted once: 2000 of 5000 held.
  assert.deepEqual(migrate(alice), { migrated: 0, skipped: 0 });
  assert.equal(alice.recorded.length, 1);
  const carol = `0x${"c4".repeat(20)}`;
  assert.throws(
    () => ledger.reserveEntry({ attemptId: "entry-carol-1", owner: carol, orderHash: "f3".repeat(32), notionalAtoms: 3_001n, limits: LIMITS }),
    refused("OMNIBUS_NOTIONAL_LIMIT"),
  );
  ledger.reserveEntry({ attemptId: "entry-carol-1", owner: carol, orderHash: "f3".repeat(32), notionalAtoms: 3_000n, limits: LIMITS });
}));

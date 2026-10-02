import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PackageOrder } from "@naryx/protocol-types";
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

const ALICE = `0x${"a1".repeat(20)}`;
const BOB = `0x${"b2".repeat(20)}`;
const TRADING = `0x${"c3".repeat(20)}`;
const LIMITS = { maxOpenPackagesPerOwner: 1, maxOpenNotionalQuoteAtoms: 5_000n };
const HASH = `0x${"dd".repeat(32)}`;
const KEY = "idem-0123456789ABCD";

function reconciled(
  attemptId: string,
  packageStatus: "COMPLETED_EXACT" | "NO_EFFECT",
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
      getSelectedQuote: () => undefined,
    },
    orders: { getCanonicalOrderByHash: () => order },
    tradingAccount: TRADING,
    limits: LIMITS,
    spotLotAtoms: 1n,
  });
  const request = { attemptId: `hyperliquid-testnet-${"ab".repeat(24)}`, idempotencyKey: KEY };
  assert.throws(() => guard.admit(request), /OWNER_AUTHORIZATION_REQUIRED|must sign/);
  ledger.recordAuthorization(input.orderHash, input.owner, await sign(owner));
  assert.throws(() => ledger.recordAuthorization(input.orderHash, BOB, "0x00"), refused("LEDGER_CONFLICT"));
  guard.admit(request);
  assert.equal(ledger.packages(input.owner)[0]?.state, "PENDING_ENTRY");
}));

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetAmount } from "@naryx/protocol-types";
import { RevenueLedgerError, SqliteRevenueLedger } from "../src/index.js";
import { receipt, usdc } from "./evidence-fixtures.js";

test("revenue claims and settlements remain exact, append-only, and channel-deduplicated", () => {
  const dir = mkdtempSync(join(tmpdir(), "naryx-revenue-"));
  const ledger = new SqliteRevenueLedger(join(dir, "revenue.sqlite"));
  try {
    const settled = receipt(Buffer.alloc(32, 7), {
      protocolFee: assetAmount(usdc, 50_000n),
      solverFee: assetAmount(usdc, 25_000n),
      rawFillFeesByAsset: [assetAmount(usdc, 19_000n)],
      builderFeesByAsset: [assetAmount(usdc, 10_000n)],
      normalizedVenueFeesByAsset: [assetAmount(usdc, 9_000n)],
      recoveryRefundByAsset: [assetAmount(usdc, 5_000n)],
    });
    const claims = ledger.recordReceipt({
      receipt: settled,
      protocolRecipientId: "naryx-protocol",
      builderRecipientId: "builder-a",
      occurredAtMs: 1_000,
    });
    assert.deepEqual(claims.map((claim) => [claim.category, claim.atoms]), [
      ["PROTOCOL_FEE", 50_000n],
      ["SOLVER_FEE", 25_000n],
      ["BUILDER_FEE", 10_000n],
      ["RECOVERY_REFUND", 5_000n],
    ]);
    assert.deepEqual(ledger.recordReceipt({
      receipt: settled,
      protocolRecipientId: "naryx-protocol",
      builderRecipientId: "builder-a",
      occurredAtMs: 1_000,
    }).map((claim) => claim.claimId), claims.map((claim) => claim.claimId));

    const protocolClaim = claims[0] as (typeof claims)[number];
    assert.equal(ledger.recordSettlement({
      settlementId: "chain-tx-1",
      claimId: protocolClaim.claimId,
      channel: "ONCHAIN_TRANSFER",
      atoms: 30_000n,
      occurredAtMs: 1_100,
      externalReference: "0xabc:1",
    }).replayed, false);
    assert.equal(ledger.recordSettlement({
      settlementId: "invoice-payment-1",
      claimId: protocolClaim.claimId,
      channel: "INVOICE_PAYMENT",
      atoms: 20_000n,
      occurredAtMs: 1_200,
      externalReference: "invoice-001",
    }).replayed, false);
    assert.throws(() => ledger.recordSettlement({
      settlementId: "duplicate-payment",
      claimId: protocolClaim.claimId,
      channel: "OFFCHAIN_PAYMENT",
      atoms: 1n,
      occurredAtMs: 1_300,
      externalReference: "bank-001",
    }), (error) => error instanceof RevenueLedgerError && error.code === "OVERSETTLEMENT");
    assert.deepEqual(ledger.claimView(protocolClaim.claimId), { ...protocolClaim, settledAtoms: 50_000n, outstandingAtoms: 0n });

    const share = ledger.recordPartnerShare({
      shareId: "partner-share-1",
      protocolClaimId: protocolClaim.claimId,
      protocolRecipientId: "naryx-protocol",
      partnerId: "partner-a",
      atoms: 10_000n,
      occurredAtMs: 1_300,
    }).claim;
    assert.equal(share.category, "PARTNER_SHARE");
    assert.throws(() => ledger.recordPartnerShare({
      shareId: "partner-share-2",
      protocolClaimId: protocolClaim.claimId,
      protocolRecipientId: "naryx-protocol",
      partnerId: "partner-b",
      atoms: 41_000n,
      occurredAtMs: 1_400,
    }), (error) => error instanceof RevenueLedgerError && error.code === "SHARE_EXCEEDS_PARENT");

    assert.deepEqual(ledger.partyBalances("naryx-protocol"), [{
      asset: usdc,
      dueToPartyAtoms: 50_000n,
      owedByPartyAtoms: 10_000n,
      settledToPartyAtoms: 50_000n,
      settledByPartyAtoms: 0n,
      outstandingToPartyAtoms: 0n,
      outstandingByPartyAtoms: 10_000n,
    }]);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

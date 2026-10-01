import assert from "node:assert/strict";
import test from "node:test";
import type { DomainRef, PackageAdmission } from "@naryx/protocol-types";
import type { FirmCashCarryBinding } from "@naryx/adapter-solana";
import { solanaDevnetExitLimits } from "../src/solana-devnet-order-context.js";
import { deriveSolanaDevnetLifecycleBinding } from "../src/solana-devnet-runtime-ports.js";
import type { TestPerpMarketState } from "../src/solana-devnet-test-perp.js";

const market = {
  baseLotAtoms: 10_000_000n,
  impactUnitLots: 10n,
  impactBpsPerUnit: 1,
  halfSpreadBps: 5,
  maxSlippageBps: 100,
  takerFeeBps: 5,
} as unknown as TestPerpMarketState;

test("exit limits floor the spot minimum and bound the outcome by the worst buy-back", () => {
  // 100 lots at 1.5 quote per lot; 20 bps spread + 30 bps slippage; venue impact 10 + spread 5 bps.
  const limits = solanaDevnetExitLimits(market, 1_500_000n, 1_000_000_000n, 149_000_000n, 20, 30);
  assert.equal(limits.minSpotQuoteOutAtoms, 149_250_000n);
  // 149_250_000 + 149_000_000 - 150_675_000 close - 75_338 fee (rounded up).
  assert.equal(limits.minExitQuoteOutcomeAtoms, 147_499_662n);
  assert.equal(solanaDevnetExitLimits(market, 1_500_000n, 1_000_000_000n, 1n, 20, 30).minExitQuoteOutcomeAtoms, 0n);
  assert.throws(() => solanaDevnetExitLimits(market, 1_500_000n, 1_000_000_001n, 149_000_000n, 20, 30), /exact market lot/);
  assert.throws(() => solanaDevnetExitLimits(market, 1_500_000n, 1_000_000_000n, 149_000_000n, 5_000, 5_000), /too large/);
});

test("a firm exit keys the package lifecycle by the entry order hash its receipt commitment names", () => {
  const domain = {
    domainId: "svm:devnet",
    domainManifestVersion: 1,
    domainManifestHash: new Uint8Array(32).fill(0x11),
  } as unknown as DomainRef;
  const entryOrderHash = new Uint8Array(32).fill(0x44);
  const request = {
    domain: "svm:devnet",
    mode: "exit",
    sizeAtoms: "1000000000",
    slippageBps: 30,
    quoteMode: "coordinated_limits",
    traderPublicKey: "11111111111111111111111111111112",
    idempotencyKey: "firm-exit-key-0001",
  } as never;
  const admission = {
    orderHash: new Uint8Array(32).fill(0x55),
    order: { action: "EXIT", domain, settlementClass: "ATOMIC_POSTCONDITION", entryReceiptHash: entryOrderHash },
  } as unknown as PackageAdmission;
  const binding = { action: "EXIT", environment: "devnet", domain } as unknown as FirmCashCarryBinding;
  const lifecycle = deriveSolanaDevnetLifecycleBinding({ request, admission, binding });
  assert.equal(lifecycle.action, "EXIT");
  assert.equal(lifecycle.attemptId, `solana-cash-carry-${"44".repeat(32)}`);
  assert.equal(lifecycle.packageId, lifecycle.attemptId);

  const entryShaped = { ...admission, order: { ...admission.order, action: "ENTRY" } } as unknown as PackageAdmission;
  assert.throws(() => deriveSolanaDevnetLifecycleBinding({ request, admission: entryShaped, binding }), /does not match exit/);
  const noReceipt = { ...admission, order: { ...admission.order, entryReceiptHash: undefined } } as unknown as PackageAdmission;
  assert.throws(() => deriveSolanaDevnetLifecycleBinding({ request, admission: noReceipt, binding }), /entryReceiptHash/);
});

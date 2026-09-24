import type { QuoteMode, SlippageBps } from "./terminal-types.js";

export const TERMINAL_CAPTURED_AT = "2026-09-20 12:00 UTC";

export const PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1 = Object.freeze({
  version: 1,
  packageId: "SOL-CARRY-30D",
  baseSymbol: "SOL" as const,
  quoteSymbol: "USDC" as const,
  baseDecimals: 6,
  quoteDecimals: 6,
  spotReferenceAtoms: 148_240_000n,
  perpetualReferenceAtoms: 149_070_000n,
  maximumSizeAtoms: 100_000n * 1_000_000n,
  spotFeeBps: 8n,
  perpetualFeeBps: 2n,
  coordinatorFeeBps: 0n,
  networkFeeAtoms: 180_000n,
  slippageChoices: [5, 10, 25] as readonly SlippageBps[],
  quoteModes: ["coordinated_limits", "indicative_preview"] as readonly QuoteMode[],
  settlementClass: "COORDINATED_ISOLATED_ACCOUNTS",
  evidenceGrade: "FIXTURE_UNATTESTED",
});

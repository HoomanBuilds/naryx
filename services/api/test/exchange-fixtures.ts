import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveImpliedPackageQuote,
  domainRef,
  duration,
  economicStrategySeriesHash,
  packageMatchingPolicy,
  packageMatchingPolicyHash,
} from "@naryx/protocol-types";
import type {
  EconomicStrategySeriesInput,
  PackageMatchingPolicyInput,
  PackageTakerOrderInput,
  SeriesExecutionClassInput,
} from "@naryx/protocol-types";
import { SqlitePackageExchangeStore } from "../src/index.js";

export const CLASS = "solana-atomic-cash-carry-v1";
export const NOW = 1_000n;
export const SERIES_SUPPORT = {
  supportedTemplateIds: ["cash-and-carry-v1"],
  supportedQuoteConventionIds: ["annualized-net-yield-v1"],
  supportedRiskClassIds: ["delta-neutral-basis-v1"],
  supportedLifecycleConventionIds: ["rolling-evaluation-window-v1"],
};
export const CLASS_SUPPORT = {
  supportedVenueClassIds: ["svm-spot-amm-v1", "svm-perp-clob-v1"],
  supportedCollateralModeIds: ["isolated-prefunded-v1"],
  supportedSettlementClasses: ["ATOMIC_POSTCONDITION"] as const,
  supportedFirmnessClassIds: ["firm-inventory-reservation-v1"],
};
export const POLICY: PackageMatchingPolicyInput = {
  matchingPolicyVersion: 1,
  environment: "local",
  executionClassId: CLASS,
  allocationRule: "PRICE_TIME",
  directVersusImpliedPriority: "DIRECT_FIRST",
  selfMatchPolicy: "CANCEL_INCOMING",
  commonControlAsSelf: true,
  amendmentPriorityRule: "RETAIN_ON_SIZE_REDUCTION",
  quantityIncrement: 10n,
  minimumExecutionQuantity: 10n,
  maximumImplicationDepth: 1,
};
export const SERIES: EconomicStrategySeriesInput = {
  seriesVersion: 1,
  seriesId: "sol-cash-carry-30d-usdc-v1",
  templateId: "cash-and-carry-v1",
  templateVersion: 1,
  templateManifestHash: "11".repeat(32),
  underlyingRefs: ["sol", "sol"],
  quoteAsset: "usd",
  economicLegRatios: [
    { numerator: 1n, denominator: 1n },
    { numerator: -1n, denominator: 1n },
  ],
  maturityOrEvaluationWindow: duration("MILLISECONDS", 2_592_000_000n),
  quoteConvention: "annualized-net-yield-v1",
  riskClass: "delta-neutral-basis-v1",
  lifecycleConvention: "rolling-evaluation-window-v1",
};

export const id = (n: number): string => n.toString(16).padStart(64, "0");

export function executionClass(overrides: Partial<SeriesExecutionClassInput> = {}): SeriesExecutionClassInput {
  return {
    executionClassVersion: 1,
    executionClassId: CLASS,
    seriesId: SERIES.seriesId,
    seriesVersion: 1,
    seriesManifestHash: economicStrategySeriesHash(SERIES, SERIES_SUPPORT),
    domains: [domainRef("svm:solana-devnet", 1, "22".repeat(32))],
    venueClasses: ["svm-perp-clob-v1", "svm-spot-amm-v1"],
    collateralMode: "isolated-prefunded-v1",
    settlementClass: "ATOMIC_POSTCONDITION",
    firmnessClass: "firm-inventory-reservation-v1",
    deliveryPolicyHash: "44".repeat(32),
    recoveryPolicyHash: "55".repeat(32),
    matchingPolicyHash: packageMatchingPolicyHash(packageMatchingPolicy(POLICY)),
    ...overrides,
  };
}

export function order(n: number, overrides: Partial<PackageTakerOrderInput> = {}): PackageTakerOrderInput {
  return {
    orderId: id(n),
    executionClassId: CLASS,
    side: "ASK",
    orderType: "LIMIT",
    timeInForce: "GTC",
    limitPriceTicks: 100n,
    quantity: 10n,
    minimumQuantity: 10n,
    participantId: `maker-${n}`,
    commonControlGroupId: `group-${n}`,
    ...overrides,
  };
}

export function impliedAsk(spot: number, perp: number, spotReservation: number) {
  return deriveImpliedPackageQuote(packageMatchingPolicy(POLICY), {
    executionClassId: CLASS,
    side: "ASK",
    evidence: "RESERVATION_BACKED_IMPLIED",
    legRatios: SERIES.economicLegRatios,
    legSources: [
      { sourceId: `spot-${spot}`, sourceVersion: 1n, side: "ASK", priceTicks: 1_100n, quantity: 20n, reservationId: id(spotReservation) },
      { sourceId: `perp-${perp}`, sourceVersion: 1n, side: "BID", priceTicks: 1_000n, quantity: 20n, reservationId: id(900 + perp) },
    ],
  });
}

export function withStore(run: (store: SqlitePackageExchangeStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "naryx-exchange-"));
  const path = join(dir, "exchange.sqlite");
  const store = new SqlitePackageExchangeStore(path, { seriesSupport: SERIES_SUPPORT, executionClassSupport: CLASS_SUPPORT });
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerAll(store: SqlitePackageExchangeStore): void {
  store.registerMatchingPolicy(POLICY);
  store.registerSeries(SERIES);
  store.registerExecutionClass(executionClass());
  store.openBook(CLASS, 1);
}

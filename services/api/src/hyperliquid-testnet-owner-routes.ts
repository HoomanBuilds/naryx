import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyTypedData, type Hex } from "viem";
import {
  bytesEqual,
  canonicalBytes,
  fromProtocolJson,
  hash32,
  packageOrderBytes,
  packageOrderHash,
  solverQuote,
  validatePackageOrderProfile,
  type AssetAmount,
  type AssetRef,
  type PackageOrder,
  type PackageOrderInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import type { ActiveOrderContextProvider } from "./canonical-entry-order.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import {
  HYPERLIQUID_TESTNET_OWNER_PATTERN,
  deriveHyperliquidTestnetExitLimits,
} from "./hyperliquid-testnet-order-context.js";
import {
  HyperliquidOwnerLedgerError,
  type HyperliquidEntryFill,
  type HyperliquidOmnibusLimits,
  type HyperliquidOwnerPackage,
  type HyperliquidTestnetOwnerLedger,
} from "./hyperliquid-testnet-owner-ledger.js";
import type { HyperliquidTestnetPriceSource } from "./hyperliquid-testnet-price-feed.js";
import type { HyperliquidTestnetOrderContextConfig } from "./hyperliquid-testnet-runtime-client.js";
import {
  HYPERLIQUID_TESTNET_DOMAIN,
  HyperliquidTestnetTerminalValidationError,
  parseHyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionRequest,
  type HyperliquidTestnetTerminalExecutionResult,
} from "./hyperliquid-testnet-terminal.js";
import type {
  HyperliquidTestnetAttemptState,
  HyperliquidTestnetExecutionGuard,
} from "./hyperliquid-testnet-terminal-execution.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import { buildHyperliquidStrategyPackageReceipt } from "./hyperliquid-strategy-receipt.js";
import type { SqliteStrategyPackageStore, StoredStrategyPackageAdmission } from "./strategy-package-store.js";
import type { InternalOrderClockPort } from "./terminal-orders.js";

export const HYPERLIQUID_TESTNET_ACCOUNT_PATH = "/internal/terminal/hyperliquid-testnet/account";
export const HYPERLIQUID_TESTNET_AUTHORIZATION_PATH = "/internal/terminal/hyperliquid-testnet/authorization";
export const HYPERLIQUID_TESTNET_AUTHORIZE_PATH = "/internal/terminal/hyperliquid-testnet/authorize";
export const HYPERLIQUID_TESTNET_EXIT_ORDER_PATH = "/internal/terminal/hyperliquid-testnet/exit-order";
export const HYPERLIQUID_TESTNET_ATTEMPT_STATUS_PATH = "/internal/terminal/hyperliquid-testnet/attempt-status";

const MAX_BODY_BYTES = 2_048;
const ATTEMPT_ID = /^hyperliquid-testnet-[0-9a-f]{48}$/;
const STRATEGY_ATTEMPT_ID = /^strategy-hl-[0-9a-f]{48}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const ENTRY_ATTEMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const U64_MAX = 18446744073709551615n;
const EXIT_REQUEST_DOMAIN = "NARYX/hyperliquid-testnet-exit-order-request/v1";

class OwnerRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * What the owner's wallet signs: the canonical order hash, which commits to the owner, the
 * settlement account, every limit, and the action. No chain id is bound because Hyperliquid
 * Testnet orders are not EVM transactions; the wallet may sit on any network.
 */
export function hyperliquidTestnetAuthorizationTypedData(input: Readonly<{
  orderHash: string;
  action: PackageOrder["action"];
  owner: string;
  tradingAccount: string;
}>) {
  return Object.freeze({
    domain: Object.freeze({ name: "Naryx Hyperliquid Testnet", version: "1" }),
    types: Object.freeze({
      PackageAuthorization: Object.freeze([
        { name: "orderHash", type: "bytes32" },
        { name: "action", type: "string" },
        { name: "owner", type: "address" },
        { name: "tradingAccount", type: "address" },
        { name: "domainId", type: "string" },
      ]),
    }),
    primaryType: "PackageAuthorization" as const,
    message: Object.freeze({
      orderHash: `0x${input.orderHash}`,
      action: input.action,
      owner: input.owner,
      tradingAccount: input.tradingAccount,
      domainId: HYPERLIQUID_TESTNET_DOMAIN,
    }),
  });
}

export async function verifyHyperliquidTestnetAuthorization(
  input: Parameters<typeof hyperliquidTestnetAuthorizationTypedData>[0],
  signature: string,
): Promise<boolean> {
  if (!SIGNATURE.test(signature) || !HYPERLIQUID_TESTNET_OWNER_PATTERN.test(input.owner)) return false;
  const typed = hyperliquidTestnetAuthorizationTypedData(input);
  try {
    return await verifyTypedData({
      address: input.owner as Hex,
      domain: typed.domain,
      types: { PackageAuthorization: [...typed.types.PackageAuthorization] },
      primaryType: typed.primaryType,
      message: { ...typed.message, orderHash: typed.message.orderHash as Hex, owner: input.owner as Hex,
        tradingAccount: input.tradingAccount as Hex },
      signature: signature as Hex,
    });
  } catch {
    return false;
  }
}

type StrategyAttemptLookup = Readonly<{
  anyStrategyExecutionAttempt(attemptId: string): Readonly<{
    sourceOrderHashHex?: string;
    orderHashHex: string;
    quoteHashHex: string;
  }> | undefined;
}>;

type AttemptBinding = Readonly<{
  attemptId: string;
  orderHash: string;
  order: PackageOrder | null;
  selectedQuoteAttemptId: string | null;
  strategyOrderHash: string | null;
  strategyQuoteHash: string | null;
}>;

function attemptBinding(
  attemptId: string,
  intents: Pick<ExecutionIntentStore, "getAttempt"> & Partial<Pick<ExecutionIntentStore, "getAttemptForOrder">>,
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">,
  strategyAttempts?: StrategyAttemptLookup,
): AttemptBinding {
  let attempt: ReturnType<ExecutionIntentStore["getAttempt"]>;
  try {
    attempt = ATTEMPT_ID.test(attemptId) ? intents.getAttempt(attemptId) : undefined;
  } catch {
    attempt = undefined;
  }
  if (attempt !== undefined && attempt.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED") {
    const order = orders.getCanonicalOrderByHash(attempt.orderHash);
    if (order !== undefined) {
      return Object.freeze({
        attemptId,
        orderHash: attempt.orderHash,
        order,
        selectedQuoteAttemptId: attempt.attemptId,
        strategyOrderHash: null,
        strategyQuoteHash: null,
      });
    }
  }
  const strategyAttempt = STRATEGY_ATTEMPT_ID.test(attemptId)
    ? strategyAttempts?.anyStrategyExecutionAttempt(attemptId)
    : undefined;
  const sourceAttempt = strategyAttempt?.sourceOrderHashHex === undefined
    ? undefined
    : intents.getAttemptForOrder?.(strategyAttempt.sourceOrderHashHex);
  const sourceOrderHash = strategyAttempt?.sourceOrderHashHex;
  const sourceOrder = sourceAttempt?.status === "HYPERLIQUID_TESTNET_QUOTE_SELECTED"
    && sourceAttempt.domainId === HYPERLIQUID_TESTNET_DOMAIN && sourceOrderHash !== undefined
    ? orders.getCanonicalOrderByHash(sourceOrderHash)
    : undefined;
  if (strategyAttempt === undefined
    || (sourceOrderHash !== undefined && (sourceAttempt === undefined || sourceOrder === undefined))) {
    throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid attempt was not found.");
  }
  return Object.freeze({
    attemptId,
    orderHash: sourceOrderHash ?? strategyAttempt.orderHashHex,
    order: sourceOrder ?? null,
    selectedQuoteAttemptId: sourceAttempt?.attemptId ?? null,
    strategyOrderHash: strategyAttempt.orderHashHex,
    strategyQuoteHash: strategyAttempt.quoteHashHex,
  });
}

/** The signed notional the omnibus cap counts: positive and in the cap's quote asset, else undefined. */
function capNotional(notional: AssetAmount, quoteAsset: AssetRef): bigint | undefined {
  return notional.atoms > 0n && notional.asset.assetId === quoteAsset.assetId
    && notional.asset.decimals === quoteAsset.decimals
    && bytesEqual(notional.asset.assetManifestHash, quoteAsset.assetManifestHash) ? notional.atoms : undefined;
}

/**
 * Puts native Hyperliquid strategies under the shared account caps whichever path moves them: it
 * backfills the executions of strategies opened before the exposure ledger existed, releases closed
 * ones, and then applies every reduction the strategy store records. An execution whose signed
 * notional is not in the cap's quote asset is skipped and reported, never guessed.
 */
export function attachHyperliquidStrategyExposures(options: Readonly<{
  ledger: Pick<HyperliquidTestnetOwnerLedger, "reconcileStrategyExposures" | "applyReduction">;
  strategies: Pick<SqliteStrategyPackageStore, "nativeStrategyExposures" | "onNativeStrategyReduction">;
  quoteAsset: AssetRef;
  log: (line: string) => void;
}>): Readonly<{ backfilled: number; released: number; skipped: number }> {
  const { open, closedStrategyKeys } = options.strategies.nativeStrategyExposures();
  const counted = open.flatMap(({ attemptId, owner, strategyKey, totalGrossNotional }) => {
    const notionalAtoms = capNotional(totalGrossNotional, options.quoteAsset);
    if (notionalAtoms !== undefined) return [{ attemptId, owner, strategyKey, notionalAtoms }];
    options.log(`Hyperliquid strategy exposure backfill skipped ${attemptId}: its signed notional is not in the cap's quote asset.`);
    return [];
  });
  const result = options.ledger.reconcileStrategyExposures({ open: counted, closedStrategyKeys });
  options.strategies.onNativeStrategyReduction((reduction) => options.ledger.applyReduction(reduction));
  return Object.freeze({ ...result, skipped: open.length - counted.length });
}

/**
 * The spot and short a completed source-backed entry left in the trading account, from the same
 * authoritative fields the cash-and-carry lane opens a package from: the observed net deltas of a
 * reconciled result, or for a strategy result the spot leg's fill net of its base-asset fee and the
 * perpetual leg's fill. Undefined unless the result completed with exactly that evidence.
 */
export function sourceBackedEntryFill(
  admission: StoredStrategyPackageAdmission,
  result: HyperliquidTestnetTerminalExecutionResult,
  entryReceiptHash: string,
): HyperliquidEntryFill | undefined {
  if (result.status === "RECONCILED") {
    if ((result.packageStatus !== "COMPLETED_EXACT" && result.packageStatus !== "COMPLETED_BOUNDED")
      || result.observedNetSpotDeltaAtoms === undefined || result.observedPerpetualDeltaAtoms === undefined) return undefined;
    return Object.freeze({
      spotQuantityAtoms: BigInt(result.observedNetSpotDeltaAtoms),
      perpQuantityAtoms: -BigInt(result.observedPerpetualDeltaAtoms),
      entryReceiptHash,
    });
  }
  if (result.status !== "STRATEGY_EXECUTION" || result.packageStatus !== "COMPLETED") return undefined;
  const graphLegs = admission.graph.legs;
  const spot = graphLegs.filter((leg) => leg.legFamily === "SPOT_SWAP" && leg.side === "BUY");
  const perp = graphLegs.filter((leg) => leg.legFamily === "PERP_OPEN" && leg.side === "SELL");
  if (graphLegs.length !== 2 || spot.length !== 1 || perp.length !== 1) return undefined;
  const observed = result.stages.flatMap((stage) => stage.evidence?.legs ?? []);
  const spotFill = observed.filter((leg) => leg.legId === spot[0]!.legId);
  const perpFill = observed.filter((leg) => leg.legId === perp[0]!.legId);
  if (spotFill.length !== 1 || perpFill.length !== 1) return undefined;
  const base = spot[0]!.quantityAsset;
  if (spotFill[0]!.feeAssetId !== base.assetId || spotFill[0]!.feeAssetDecimals !== base.decimals) return undefined;
  return Object.freeze({
    spotQuantityAtoms: BigInt(spotFill[0]!.filledSignedBaseAtoms) - BigInt(spotFill[0]!.feeAtoms),
    perpQuantityAtoms: -BigInt(perpFill[0]!.filledSignedBaseAtoms),
    entryReceiptHash,
  });
}

function ledgerRefusal(error: unknown): never {
  if (error instanceof HyperliquidOwnerLedgerError) {
    throw new HyperliquidTestnetTerminalValidationError(error.code, error.message);
  }
  throw error;
}

type MigrateSourceBackedEntries = (
  attempts: readonly HyperliquidTestnetTerminalExecutionRequest[],
  finalResult: (request: HyperliquidTestnetTerminalExecutionRequest) => HyperliquidTestnetTerminalExecutionResult | undefined,
  log: (line: string) => void,
) => Readonly<{ migrated: number; skipped: number }>;

/**
 * Refuses a handoff unless the order's owner signed it and it settles in the trading account;
 * then reserves the owner's package slot and the account's notional for an entry, or claims the
 * exact open package an exit closes. A generalized strategy ENTRY or INCREASE reserves under the
 * same caps; its risk-reducing actions are never capped and release exposure once completed.
 */
export function createHyperliquidTestnetExecutionGuard(options: Readonly<{
  ledger: HyperliquidTestnetOwnerLedger;
  intents: Pick<ExecutionIntentStore, "getAttempt" | "getSelectedQuote" | "getAttemptForOrder">;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  strategyAttempts?: StrategyAttemptLookup;
  strategyReceipts?: Pick<
    SqliteStrategyPackageStore,
    "anyStrategyExecutionAttempt" | "admissionByQuote" | "ownerAuthorization" | "recordReceipt"
    | "nativeStrategyPositionByStateHash" | "receiptByQuote" | "nativeStrategyReduction"
  >;
  tradingAccount: string;
  limits: HyperliquidOmnibusLimits | undefined;
  accountMode?: 'PER_USER' | 'SHARED_TEST_FIXTURE';
  /** The asset the omnibus notional cap is denominated in. */
  quoteAsset: AssetRef;
  /** Base atoms per spot size unit; an exit sells the package spot floored to it. */
  spotLotAtoms: bigint;
}>): HyperliquidTestnetExecutionGuard & Readonly<{ migrateSourceBackedEntries: MigrateSourceBackedEntries }> {
  const entryNotional = (attemptId: string): bigint => {
    const selected = options.intents.getSelectedQuote(attemptId);
    if (selected === undefined) return 0n;
    try {
      return solverQuote(fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput)
        .expectedPerpNotional.atoms;
    } catch {
      return 0n;
    }
  };
  const authorized = (request: HyperliquidTestnetTerminalExecutionRequest): AttemptBinding & Readonly<{
    admission: StoredStrategyPackageAdmission | undefined;
  }> => {
    const binding = attemptBinding(request.attemptId, options.intents, options.orders, options.strategyAttempts);
    if (binding.strategyOrderHash !== null) {
      const admission = binding.strategyQuoteHash === null
        ? undefined : options.strategyReceipts?.admissionByQuote(binding.strategyQuoteHash);
      const authorization = options.strategyReceipts?.ownerAuthorization(binding.strategyOrderHash);
      if (admission === undefined || admission.orderHashHex !== binding.strategyOrderHash
        || authorization?.owner !== admission.order.owner) {
        throw new HyperliquidTestnetTerminalValidationError(
          "OWNER_AUTHORIZATION_REQUIRED",
          "The package owner must sign the generalized package authorization before execution.",
        );
      }
      if (admission.order.settlementAccount !== (options.accountMode === 'PER_USER'
        ? admission.order.owner : options.tradingAccount)) {
        throw new HyperliquidTestnetTerminalValidationError(
          "SETTLEMENT_ACCOUNT_MISMATCH",
          "The generalized order does not settle in the configured trading account.",
        );
      }
      return { ...binding, admission };
    }
    if (binding.order === null || binding.order.settlementAccount !== (options.accountMode === 'PER_USER'
      ? binding.order.owner : options.tradingAccount)) {
      throw new HyperliquidTestnetTerminalValidationError(
        "SETTLEMENT_ACCOUNT_MISMATCH",
        "The order does not settle in the configured trading account.",
      );
    }
    if (options.ledger.authorization(binding.orderHash)?.owner !== binding.order.owner) {
      throw new HyperliquidTestnetTerminalValidationError(
        "OWNER_AUTHORIZATION_REQUIRED",
        "The package owner must sign the package authorization before execution.",
      );
    }
    return { ...binding, admission: undefined };
  };
  const priorStrategyPosition = (admission: StoredStrategyPackageAdmission) => {
    const position = admission.order.lifecycleAction === "ENTRY" || admission.order.expectedStrategyStateHash === undefined
      ? undefined
      : options.strategyReceipts?.nativeStrategyPositionByStateHash(hex(admission.order.expectedStrategyStateHash));
    if (admission.order.lifecycleAction !== "ENTRY" && position === undefined) {
      throw new HyperliquidTestnetTerminalValidationError(
        "STALE_STRATEGY_STATE",
        "The strategy state committed by the lifecycle order is no longer current.",
      );
    }
    return position;
  };
  // The signed quote's gross notional is what the strategy adds to the shared account. A
  // source-backed entry is a cash-and-carry package, so it reserves a package rather than exposure.
  const reserveStrategyExposure = (
    attemptId: string,
    admission: StoredStrategyPackageAdmission,
    sourceBacked: boolean,
  ): void => {
    const { order, quote } = admission;
    if (order.lifecycleAction !== "ENTRY" && order.lifecycleAction !== "INCREASE") return;
    if (options.limits === undefined) {
      throw new HyperliquidTestnetTerminalValidationError(
        "OMNIBUS_LIMITS_UNCONFIGURED",
        "Hyperliquid testnet entries are closed until the shared account limits are configured.",
      );
    }
    const notionalAtoms = capNotional(quote.totalGrossNotional, options.quoteAsset);
    if (notionalAtoms === undefined) {
      throw new HyperliquidTestnetTerminalValidationError(
        "STRATEGY_NOTIONAL_UNAVAILABLE",
        "The strategy quote carries no positive notional in the shared account's quote asset.",
      );
    }
    if (sourceBacked && order.lifecycleAction === "ENTRY") {
      try {
        options.ledger.reserveEntry({
          attemptId, owner: order.owner, orderHash: admission.orderHashHex, notionalAtoms, limits: options.limits,
        });
      } catch (error) {
        ledgerRefusal(error);
      }
      return;
    }
    const strategyKey = order.lifecycleAction === "ENTRY"
      ? admission.orderHashHex : priorStrategyPosition(admission)!.entryOrderHashHex;
    try {
      options.ledger.reserveExposure({
        attemptId,
        owner: order.owner,
        strategyKey,
        notionalAtoms,
        newPackage: order.lifecycleAction === "ENTRY",
        limits: options.limits,
      });
    } catch (error) {
      ledgerRefusal(error);
    }
  };
  const strategyAdmission = (quoteHashHex: string): StoredStrategyPackageAdmission => {
    const admission = options.strategyReceipts?.admissionByQuote(quoteHashHex);
    if (admission === undefined) {
      throw new HyperliquidTestnetTerminalValidationError(
        "STRATEGY_ADMISSION_NOT_FOUND",
        "The selected strategy admission was not found.",
      );
    }
    return admission;
  };
  // Settling repeats (status reads, replays, sweeps). Once the receipt is recorded the strategy
  // state it consumed is gone, so a repeat reuses it and reruns only the idempotent ledger steps.
  const strategyReceiptHash = (
    attemptId: string,
    quoteHashHex: string,
    admission: StoredStrategyPackageAdmission,
    result: HyperliquidTestnetTerminalExecutionResult,
  ): string | undefined => {
    const recorded = options.strategyReceipts!.receiptByQuote(quoteHashHex);
    if (recorded !== undefined) return recorded.receiptHashHex;
    const priorPosition = priorStrategyPosition(admission);
    const receipt = buildHyperliquidStrategyPackageReceipt({
      attemptId,
      admission,
      result,
      ...(priorPosition === undefined ? {} : { priorState: priorPosition.state }),
    });
    return receipt === undefined ? undefined : options.strategyReceipts!.recordReceipt(receipt).receiptHashHex;
  };
  const settleSourceBackedEntry = (
    attemptId: string,
    admission: StoredStrategyPackageAdmission,
    result: HyperliquidTestnetTerminalExecutionResult,
    fill: HyperliquidEntryFill | undefined,
    entryNotionalAtoms: bigint,
  ): boolean => {
    const created = options.ledger.adoptStrategyEntry({
      attemptId,
      owner: admission.order.owner,
      orderHash: admission.orderHashHex,
      notionalAtoms: capNotional(admission.quote.totalGrossNotional, options.quoteAsset) ?? 0n,
    });
    options.ledger.settleStrategyEntry(attemptId, result, fill, entryNotionalAtoms);
    return created;
  };
  /**
   * Moves source-backed entries that completed before they opened owner-ledger packages onto
   * cash-and-carry packages from their stored final results, releasing the strategy exposure they
   * held. Idempotent: a migrated, exited, or released entry is never migrated or revived again.
   * An entry whose result lacks a positive net fill or entry notional is skipped and reported.
   */
  const migrateSourceBackedEntries: MigrateSourceBackedEntries = (attempts, finalResult, log) => {
    let migrated = 0;
    let skipped = 0;
    for (const request of attempts) {
      try {
        const result = finalResult(request);
        if (result === undefined || !((result.status === "STRATEGY_EXECUTION" && result.packageStatus === "COMPLETED")
          || (result.status === "RECONCILED"
            && (result.packageStatus === "COMPLETED_EXACT" || result.packageStatus === "COMPLETED_BOUNDED")))) continue;
        const binding = attemptBinding(request.attemptId, options.intents, options.orders, options.strategyAttempts);
        if (binding.strategyQuoteHash === null || binding.selectedQuoteAttemptId === null) {
          throw new Error("it is not a source-backed strategy attempt");
        }
        const admission = strategyAdmission(binding.strategyQuoteHash);
        const receiptHashHex = strategyReceiptHash(request.attemptId, binding.strategyQuoteHash, admission, result);
        const fill = receiptHashHex === undefined ? undefined : sourceBackedEntryFill(admission, result, receiptHashHex);
        const entryNotionalAtoms = entryNotional(binding.selectedQuoteAttemptId);
        if (fill === undefined || fill.spotQuantityAtoms <= 0n || fill.perpQuantityAtoms <= 0n || entryNotionalAtoms <= 0n) {
          throw new Error("its stored result has no positive net fill, receipt, or entry notional");
        }
        if (settleSourceBackedEntry(request.attemptId, admission, result, fill, entryNotionalAtoms)) migrated += 1;
      } catch (error) {
        skipped += 1;
        log(`Hyperliquid source-backed entry migration skipped ${request.attemptId}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    return Object.freeze({ migrated, skipped });
  };
  return Object.freeze({
    requireOwnerAuthorization(request: HyperliquidTestnetTerminalExecutionRequest) {
      authorized(request);
    },
    admit(request: HyperliquidTestnetTerminalExecutionRequest) {
      const { order, orderHash, admission, selectedQuoteAttemptId } = authorized(request);
      if (admission !== undefined) {
        reserveStrategyExposure(request.attemptId, admission, selectedQuoteAttemptId !== null);
        return;
      }
      if (order === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid order was not found.");
      try {
        if (order.action === "ENTRY") {
          if (options.limits === undefined) {
            throw new HyperliquidTestnetTerminalValidationError(
              "OMNIBUS_LIMITS_UNCONFIGURED",
              "Hyperliquid testnet entries are closed until the shared account limits are configured.",
            );
          }
          options.ledger.reserveEntry({
            attemptId: request.attemptId,
            owner: order.owner,
            orderHash,
            notionalAtoms: order.maxSpotQuoteIn!.atoms,
            limits: options.limits,
          });
          return;
        }
        options.ledger.beginExit(request.attemptId, {
          owner: order.owner,
          orderHash,
          perpQuantityAtoms: order.quantity.atoms,
          grossSpotQuantityAtoms: order.hyperliquidGrossSpotQuantity?.atoms ?? 0n,
          spotLotAtoms: options.spotLotAtoms,
          entryReceiptHash: order.entryReceiptHash === undefined ? "" : hex(order.entryReceiptHash),
        });
      } catch (error) {
        ledgerRefusal(error);
      }
    },
    settle(request: HyperliquidTestnetTerminalExecutionRequest, result: HyperliquidTestnetTerminalExecutionResult) {
      const binding = attemptBinding(request.attemptId, options.intents, options.orders, options.strategyAttempts);
      const strategyAttempt = options.strategyReceipts?.anyStrategyExecutionAttempt(request.attemptId);
      if (strategyAttempt !== undefined) {
        const admission = strategyAdmission(strategyAttempt.quoteHashHex);
        const receiptHashHex = strategyReceiptHash(request.attemptId, strategyAttempt.quoteHashHex, admission, result);
        // The exposure ledger follows the recorded receipt, so a receipt that fails keeps exposure held.
        const action = admission.order.lifecycleAction;
        if (binding.selectedQuoteAttemptId !== null && action === "ENTRY") {
          settleSourceBackedEntry(
            request.attemptId,
            admission,
            result,
            receiptHashHex === undefined ? undefined : sourceBackedEntryFill(admission, result, receiptHashHex),
            entryNotional(binding.selectedQuoteAttemptId),
          );
        } else if (action === "ENTRY" || action === "INCREASE") {
          options.ledger.settleExposure(request.attemptId, result);
        } else if (action === "DECREASE" || action === "EXIT" || action === "EMERGENCY_UNWIND") {
          const reduction = options.strategyReceipts!.nativeStrategyReduction(request.attemptId);
          if (reduction !== undefined) options.ledger.applyReduction(reduction);
        }
        return;
      }
      const { order } = binding;
      if (order === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid order was not found.");
      if (order.action === "ENTRY") {
        if (binding.selectedQuoteAttemptId === null) throw new HyperliquidTestnetTerminalValidationError("ATTEMPT_NOT_FOUND", "Hyperliquid quote attempt was not found.");
        options.ledger.settleEntry(request.attemptId, result, entryNotional(binding.selectedQuoteAttemptId));
      } else {
        options.ledger.settleExit(request.attemptId, result);
      }
    },
    migrateSourceBackedEntries,
  });
}

/**
 * Builds and stores the canonical EXIT of the owner's open package from the live books: sell the
 * package's spot floored to the spot lot and buy back exactly its short, executed by the trading
 * account. HyperCore sells whole size units only, so the sub-lot remainder (the base-token fee
 * dust of the entry) stays in the trading account, bounded by the terminal residual caps.
 */
export function createHyperliquidTestnetExitOrderFactory(options: Readonly<{
  config: HyperliquidTestnetOrderContextConfig;
  accountMode?: 'PER_USER' | 'SHARED_TEST_FIXTURE';
  /** Base atoms per spot size unit. */
  spotLotAtoms: bigint;
  contexts: ActiveOrderContextProvider;
  clock: InternalOrderClockPort;
  prices: HyperliquidTestnetPriceSource;
  ledger: HyperliquidTestnetOwnerLedger;
  orders: Pick<InternalOrderStore, "createOrGet"> & Partial<Pick<InternalOrderStore, "getCanonicalOrderByHash">>;
}>) {
  const { config } = options;
  return async (request: Readonly<{ owner: string; slippageBps: number; idempotencyKey: string; entryAttemptId?: string }>) => {
    const tradingAccount = options.accountMode === 'PER_USER' ? request.owner : config.tradingAccount;
    if (!HYPERLIQUID_TESTNET_OWNER_PATTERN.test(request.owner)) {
      throw new OwnerRouteError(400, "INVALID_OWNER", "Owner must be a lowercase nonzero 0x address.");
    }
    if (!Number.isSafeInteger(request.slippageBps) || request.slippageBps < 1
      || request.slippageBps > config.maxSlippageBps) {
      throw new OwnerRouteError(400, "INVALID_SLIPPAGE", "Slippage is outside the context bound.");
    }
    if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
      throw new OwnerRouteError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency key must use 16 to 64 URL-safe characters.");
    }
    if (request.entryAttemptId !== undefined && !ENTRY_ATTEMPT_ID.test(request.entryAttemptId)) {
      throw new OwnerRouteError(400, "INVALID_ENTRY_ATTEMPT_ID", "Entry attempt id must use 1 to 128 URL-safe characters.");
    }
    const open = options.ledger.openPackage(request.owner, request.entryAttemptId);
    if (open === undefined || open.perpQuantityAtoms === null || open.spotQuantityAtoms === null
      || open.entryNotionalAtoms === null || open.entryReceiptHash === null) {
      throw new OwnerRouteError(404, "NO_OPEN_PACKAGE", request.entryAttemptId === undefined
        ? "This wallet has no open Hyperliquid testnet package."
        : "This wallet has no open Hyperliquid testnet package with that entry attempt.");
    }
    if (options.accountMode === 'PER_USER') {
      const entry = options.orders.getCanonicalOrderByHash?.(open.entryOrderHash);
      if (entry === undefined || entry.owner !== request.owner || entry.settlementAccount !== tradingAccount) {
        throw new OwnerRouteError(409, "LEGACY_SHARED_POSITION",
          "This package belongs to the historical shared venue account and cannot close your personal account.");
      }
    }
    const snapshot = options.prices.latest();
    const context = options.contexts(config.contextId);
    if (snapshot === undefined || context === undefined || context.state !== "ACTIVE"
      || context.capturedAtClock !== BigInt(snapshot.capturedAtMs)) {
      throw new OwnerRouteError(503, "CONTEXT_UNAVAILABLE", "Live Hyperliquid testnet prices are unavailable.");
    }
    const currentClock = await options.clock.currentClock(context);
    if (currentClock < context.capturedAtClock || currentClock - context.capturedAtClock > context.maxStaleness) {
      throw new OwnerRouteError(503, "STALE_CONTEXT", "Live Hyperliquid testnet prices are stale.");
    }
    if (typeof options.spotLotAtoms !== "bigint" || options.spotLotAtoms <= 0n) {
      throw new OwnerRouteError(503, "CONTEXT_UNAVAILABLE", "The Hyperliquid spot lot is not configured.");
    }
    const spotSellAtoms = open.spotQuantityAtoms - open.spotQuantityAtoms % options.spotLotAtoms;
    if (spotSellAtoms <= 0n) {
      throw new OwnerRouteError(409, "EXIT_BELOW_SPOT_LOT", "The package spot is smaller than one spot lot.");
    }
    const limits = deriveHyperliquidTestnetExitLimits(
      config.baseAsset, config.quoteAsset, snapshot,
      spotSellAtoms, open.perpQuantityAtoms, open.entryNotionalAtoms, request.slippageBps,
    );
    const residual = open.perpQuantityAtoms - spotSellAtoms;
    if ((residual < 0n ? -residual : residual) > config.maxTerminalResidualBaseQuantityAtoms) {
      throw new OwnerRouteError(409, "EXIT_RESIDUAL_EXCEEDS_CAP", "The package spot and short differ by more than the residual cap.");
    }
    const requestPayload = canonicalBytes((writer) => {
      writer.writeString(config.contextId, "exitRequest.contextId");
      writer.writeString(request.owner, "exitRequest.owner");
      writer.writeString(tradingAccount, "exitRequest.settlementAccount");
      writer.writeString(open.entryReceiptHash!, "exitRequest.entryReceiptHash");
      writer.writeU256(open.perpQuantityAtoms!, "exitRequest.perpQuantityAtoms");
      writer.writeU256(open.spotQuantityAtoms!, "exitRequest.spotQuantityAtoms");
      writer.writeU32(request.slippageBps, "exitRequest.slippageBps");
      writer.writeString(request.idempotencyKey, "exitRequest.idempotencyKey");
    });
    const requestCommitment = hash32(
      createHash("sha256").update(EXIT_REQUEST_DOMAIN, "ascii").update(requestPayload).digest(),
      "exitRequestCommitment",
    );
    let nonce = 0n;
    for (const byte of requestCommitment.subarray(0, 8)) nonce = (nonce << 8n) + BigInt(byte);
    const expiryValue = currentClock + config.expiryTtlMs;
    if (expiryValue > U64_MAX) throw new OwnerRouteError(409, "UNSAFE_EXPIRY", "Exit expiry is outside the safe window.");
    const input: PackageOrderInput = {
      version: config.orderVersion,
      environment: context.environment,
      domain: context.domain,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      packageTemplateManifestHash: config.packageTemplateManifestHash,
      owner: request.owner,
      settlementAccount: tradingAccount,
      nonce: nonce === 0n ? 1n : nonce,
      expiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      expiryValue,
      direction: "LONG_SPOT_SHORT_PERP",
      action: "EXIT",
      packageOrderType: "MARKETABLE_LIMIT",
      packageTimeInForce: "IOC",
      partialFillPolicy: "EXACT_ALL_LEGS",
      quantity: { asset: config.baseAsset, atoms: open.perpQuantityAtoms },
      hyperliquidQuantityPolicy: "BOUNDED_NET",
      hyperliquidGrossSpotQuantity: { asset: config.baseAsset, atoms: spotSellAtoms },
      // HyperCore charges a spot sell's fee in quote, so the base delta is exactly the spot sold.
      hyperliquidMinNetSpotDelta: { asset: config.baseAsset, atoms: -spotSellAtoms },
      hyperliquidMaxNetSpotDelta: { asset: config.baseAsset, atoms: -spotSellAtoms },
      hyperliquidMaxTerminalResidualBaseQuantity: {
        asset: config.baseAsset, atoms: config.maxTerminalResidualBaseQuantityAtoms,
      },
      hyperliquidResidualValuationSchemaVersion: 1,
      hyperliquidResidualValuationReferencePrice: context.hyperliquidResidualValuationReferencePrice!,
      hyperliquidMaxTerminalResidualQuoteValue: {
        asset: config.quoteAsset, atoms: config.maxTerminalResidualQuoteValueAtoms,
      },
      expectedPreStrategySpotQuantity: { asset: config.baseAsset, atoms: open.spotQuantityAtoms },
      hyperliquidRecoveryExpiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      hyperliquidMaxRecoveryActionExpiryValue: currentClock + config.recoveryActionExpiryTtlMs,
      hyperliquidRecoveryDeadlineValue: currentClock + config.recoveryDeadlineTtlMs,
      hyperliquidMinRecoveryWindowMs: config.minRecoveryWindowMs,
      hyperliquidMaxPerpBuyPrice: limits.maxPerpBuyPrice,
      maxRecoverySpotBuyPrice: context.maxRecoverySpotBuyPrice!,
      minRecoverySpotSellPrice: context.minRecoverySpotSellPrice!,
      minRecoveryPerpSellPrice: context.minRecoveryPerpSellPrice!,
      maxRecoveryPerpBuyPrice: context.maxRecoveryPerpBuyPrice!,
      exitOutcomeSchemaVersion: 1,
      entryReceiptHash: hash32(open.entryReceiptHash, "entryReceiptHash"),
      expectedPrePositionSize: { asset: config.baseAsset, atoms: -open.perpQuantityAtoms },
      expectedPrePositionEntryNotional: { asset: config.quoteAsset, atoms: open.entryNotionalAtoms },
      minExitQuoteOutcome: { asset: config.quoteAsset, atoms: limits.minExitQuoteOutcomeAtoms },
      minSpotQuoteOut: { asset: config.quoteAsset, atoms: limits.minSpotQuoteOutAtoms },
      maxMarginAdded: { asset: config.quoteAsset, atoms: 0n },
      minVenueReserveReturned: { asset: config.quoteAsset, atoms: config.minVenueReserveReturnedAtoms },
      minWalletQuoteBalanceDelta: { asset: config.quoteAsset, atoms: config.minWalletQuoteBalanceDeltaAtoms },
      maxVenueFeeAtomsByAsset: [...config.maxVenueFeeAtomsByAsset],
      maxProtocolFee: { asset: config.quoteAsset, atoms: config.maxProtocolFeeAtoms },
      maxSolverFee: { asset: config.quoteAsset, atoms: config.maxSolverFeeAtoms },
      maxPriorityFee: { asset: config.quoteAsset, atoms: config.maxPriorityFeeAtoms },
      maxRecoveryCostAtomsByAsset: [...config.maxRecoveryCostAtomsByAsset],
      permittedSpotAdapters: [config.spotAdapter],
      permittedPerpAdapters: [config.perpetualAdapter],
      settlementClass: "BATCHED_IOC_WITH_RECOVERY",
      maxAggregateRecoveryLossQuote: { asset: config.quoteAsset, atoms: config.maxAggregateRecoveryLossQuoteAtoms },
      maxResidualBaseQuantity: { asset: config.baseAsset, atoms: config.maxResidualBaseQuantityAtoms },
      allowedRecoveryActions: ["CANCEL_OPEN_ORDERS", "COMPLETE_SPOT", "COMPLETE_PERP", "ROLLBACK_SPOT", "ROLLBACK_PERP"],
    };
    const order = validatePackageOrderProfile(input, "packageOrder");
    const orderHash = packageOrderHash(input);
    const stored = options.orders.createOrGet({
      order: { order, orderBytes: packageOrderBytes(input), orderHash, requestCommitment },
      request: {
        contextId: config.contextId,
        owner: request.owner,
        settlementAccount: tradingAccount,
        sizeAtoms: open.perpQuantityAtoms,
        slippageBps: request.slippageBps,
        idempotencyKey: request.idempotencyKey,
        currentClock,
      },
    });
    options.ledger.bindExitOrder(open.entryAttemptId, request.owner, stored.record.orderHashHex);
    return Object.freeze({ ...stored, package: open });
  };
}

function packageView(entry: HyperliquidOwnerPackage) {
  const atoms = (value: bigint | null) => value === null ? null : value.toString();
  return {
    entryAttemptId: entry.entryAttemptId,
    entryOrderHash: entry.entryOrderHash,
    state: entry.state,
    perpQuantityAtoms: atoms(entry.perpQuantityAtoms),
    spotQuantityAtoms: atoms(entry.spotQuantityAtoms),
    exitSpotQuantityAtoms: atoms(entry.exitSpotQuantityAtoms),
    // Base-fee dust below one spot lot that the exit leaves in the shared trading account.
    retainedSpotDustAtoms: entry.exitSpotQuantityAtoms === null || entry.spotQuantityAtoms === null
      ? null : (entry.spotQuantityAtoms - entry.exitSpotQuantityAtoms).toString(),
    entryNotionalAtoms: atoms(entry.entryNotionalAtoms),
    entryReceiptHash: entry.entryReceiptHash,
    exitAttemptId: entry.exitAttemptId,
    openedAtMs: entry.openedAtMs,
    closedAtMs: entry.closedAtMs,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new OwnerRouteError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_BODY_BYTES) throw new OwnerRouteError(400, "BODY_TOO_LARGE", "Request body is too large.");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OwnerRouteError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerRouteError(400, "INVALID_BODY", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).sort().join(",") !== [...keys].sort().join(",")) {
    throw new OwnerRouteError(400, "INVALID_FIELDS", `Request must contain only ${keys.join(", ")}.`);
  }
}

export type HyperliquidTestnetOwnerRoutesOptions = Readonly<{
  tradingAccount: string;
  accountMode?: 'PER_USER' | 'SHARED_TEST_FIXTURE';
  maxOpenPackagesPerOwner: number | null;
  /** Atom decimals of the package's base and quote assets, so the terminal can show sizes. */
  baseDecimals: number;
  quoteDecimals: number;
  ledger: HyperliquidTestnetOwnerLedger;
  intents: Pick<ExecutionIntentStore, "getAttempt"> & Partial<Pick<ExecutionIntentStore, "getAttemptForOrder">>;
  orders: Pick<InternalOrderStore, "getCanonicalOrderByHash">;
  strategyAttempts?: StrategyAttemptLookup;
  createExitOrder?: ReturnType<typeof createHyperliquidTestnetExitOrderFactory>;
  attemptStatus?: (request: HyperliquidTestnetTerminalExecutionRequest) => Promise<HyperliquidTestnetAttemptState>;
}>;

/**
 * Lane routes under the private server's one origin policy:
 * GET  account?owner=0x...                       the wallet's packages in the shared account
 * POST authorization {attemptId}                 the typed data the owner signs
 * POST authorize {attemptId, signature}          records the owner's signature
 * POST exit-order {owner, slippageBps, idempotencyKey, entryAttemptId?}  the named open package, else the oldest
 * POST attempt-status {attemptId, idempotencyKey}
 */
export function createHyperliquidTestnetOwnerRoutes(
  options: HyperliquidTestnetOwnerRoutesOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  const cashOrder = (binding: AttemptBinding): PackageOrder => {
    if (binding.order === null) {
      throw new OwnerRouteError(
        409,
        "STRATEGY_AUTHORIZATION_REQUIRED",
        "Generalized strategies use the strategy package authorization endpoint.",
      );
    }
    if (binding.order.settlementAccount !== (options.accountMode === 'PER_USER'
      ? binding.order.owner : options.tradingAccount)) {
      throw new OwnerRouteError(409, "SETTLEMENT_ACCOUNT_MISMATCH", "The signed order must bind the owner's trading account.");
    }
    return binding.order;
  };
  const typedDataFor = (binding: AttemptBinding) => {
    const order = cashOrder(binding);
    return hyperliquidTestnetAuthorizationTypedData({
      orderHash: binding.orderHash,
      action: order.action,
      owner: order.owner,
      tradingAccount: order.settlementAccount,
    });
  };
  const handlers: Readonly<Record<string, (request: IncomingMessage, url: URL) => Promise<unknown>>> = {
    [HYPERLIQUID_TESTNET_ACCOUNT_PATH]: async (request, url) => {
      if (request.method !== "GET") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only GET is allowed.");
      const owner = url.searchParams.get("owner") ?? "";
      if ([...url.searchParams.keys()].join(",") !== "owner" || !HYPERLIQUID_TESTNET_OWNER_PATTERN.test(owner)) {
        throw new OwnerRouteError(400, "INVALID_OWNER", "Query must contain only a lowercase nonzero owner address.");
      }
      return {
        version: 1,
        owner,
        tradingAccount: options.accountMode === 'PER_USER' ? owner : options.tradingAccount,
        executionModel: options.accountMode === 'PER_USER' ? "PER_USER_TESTNET_ACCOUNT" : "OMNIBUS_TESTNET_ACCOUNT",
        maxOpenPackagesPerOwner: options.maxOpenPackagesPerOwner,
        baseDecimals: options.baseDecimals,
        quoteDecimals: options.quoteDecimals,
        packages: options.ledger.packages(owner).filter((entry) => options.accountMode !== 'PER_USER'
          || options.orders.getCanonicalOrderByHash(entry.entryOrderHash)?.settlementAccount === owner).map(packageView),
      };
    },
    [HYPERLIQUID_TESTNET_AUTHORIZATION_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const body = await readJson(request);
      exactKeys(body, ["attemptId"]);
      const binding = attemptBinding(String(body.attemptId), options.intents, options.orders, options.strategyAttempts);
      return { attemptId: binding.attemptId, orderHash: binding.orderHash, typedData: typedDataFor(binding) };
    },
    [HYPERLIQUID_TESTNET_AUTHORIZE_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      const body = await readJson(request);
      exactKeys(body, ["attemptId", "signature"]);
      const binding = attemptBinding(String(body.attemptId), options.intents, options.orders, options.strategyAttempts);
      const order = cashOrder(binding);
      const signature = String(body.signature).toLowerCase();
      if (!await verifyHyperliquidTestnetAuthorization({
        orderHash: binding.orderHash, action: order.action,
        owner: order.owner, tradingAccount: order.settlementAccount,
      }, signature)) {
        throw new OwnerRouteError(400, "INVALID_SIGNATURE", "The signature is not the package owner's authorization.");
      }
      options.ledger.recordAuthorization(binding.orderHash, order.owner, signature);
      return { status: "OWNER_AUTHORIZED", attemptId: binding.attemptId, orderHash: binding.orderHash, owner: order.owner };
    },
    [HYPERLIQUID_TESTNET_EXIT_ORDER_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      if (options.createExitOrder === undefined) {
        throw new OwnerRouteError(503, "EXIT_UNAVAILABLE", "Hyperliquid testnet exits are unavailable.");
      }
      const body = await readJson(request);
      exactKeys(body, ["idempotencyKey", "owner", "slippageBps", ...("entryAttemptId" in body ? ["entryAttemptId"] : [])]);
      if (typeof body.owner !== "string" || typeof body.idempotencyKey !== "string"
        || typeof body.slippageBps !== "number"
        || (body.entryAttemptId !== undefined && typeof body.entryAttemptId !== "string")) {
        throw new OwnerRouteError(400, "INVALID_FIELDS", "owner, slippageBps, and idempotencyKey are required; entryAttemptId is a string.");
      }
      const created = await options.createExitOrder({
        owner: body.owner, slippageBps: body.slippageBps, idempotencyKey: body.idempotencyKey,
        ...(body.entryAttemptId === undefined ? {} : { entryAttemptId: body.entryAttemptId }),
      });
      return {
        status: "UNSIGNED_CREATED",
        created: created.created,
        order: created.record,
        package: packageView(created.package),
        executionModel: options.accountMode === 'PER_USER' ? "PER_USER_TESTNET_ACCOUNT" : "OMNIBUS_TESTNET_ACCOUNT",
      };
    },
    [HYPERLIQUID_TESTNET_ATTEMPT_STATUS_PATH]: async (request) => {
      if (request.method !== "POST") throw new OwnerRouteError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed.");
      if (options.attemptStatus === undefined) {
        throw new OwnerRouteError(503, "EXECUTION_UNAVAILABLE", "Hyperliquid testnet execution is unavailable.");
      }
      const identity = parseHyperliquidTestnetTerminalExecutionRequest(await readJson(request));
      const status = await options.attemptStatus(identity);
      return { ...identity, ...status };
    },
  };

  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://private-terminal.local");
    const handler = handlers[url.pathname];
    if (handler === undefined) return false;
    void handler(request, url).then(
      (body) => send(response, 200, body),
      (error: unknown) => {
        if (error instanceof OwnerRouteError) {
          send(response, error.status, { error: { code: error.code, message: error.message } });
        } else if (error instanceof HyperliquidTestnetTerminalValidationError) {
          send(response, error.code === "ATTEMPT_NOT_FOUND" ? 404 : 400, { error: { code: error.code, message: error.message } });
        } else if (error instanceof HyperliquidOwnerLedgerError) {
          send(response, error.code === "NO_OPEN_PACKAGE" ? 404 : 409, { error: { code: error.code, message: error.message } });
        } else {
          send(response, 502, { error: { code: "HYPERLIQUID_OWNER_ROUTE_FAILED", message: "Hyperliquid owner route failed closed." } });
        }
      },
    );
    return true;
  };
}

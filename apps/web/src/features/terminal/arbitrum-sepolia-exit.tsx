"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatEther } from "viem";
import {
  ArbitrumObservationError,
  arbitrumExitWalletTypedData,
  type ArbitrumAccountStatus,
  type ArbitrumAsyncObservation,
  type ArbitrumExitAuthorization,
  type ArbitrumExitOrder,
  type ArbitrumSelectedAttempt,
  type ArbitrumSolverQuote,
  type PrivateHttpTerminalProvider,
} from "./private-http-terminal-provider";
import styles from "./trading-terminal.module.css";

/**
 * Arbitrum Sepolia full-close exit, in the same progressive steps as the entry: the service builds
 * the canonical EXIT order for the wallet's open package from chain, the bonded solver quotes it,
 * the wallet signs the full-close authorization (an EIP-712 message, never a transaction), and the
 * solver submits it and pays the GMX execution fee. GMX keepers then close the short and the exit
 * controller sells the spot leg to the wallet and records the final package receipt.
 */

const POLL_INTERVAL_MS = 4_000;
const QUOTE_DECIMALS = 6;
const USD_DECIMALS = 30;
/** The Arbitrum Sepolia base asset is WETH, fixed at 18 decimals by the release template. */
const BASE_DECIMALS = 18;

export type ArbitrumExitStep = "account" | "create" | "quote" | "select" | "prepare" | "sign" | "restart";

type ExitFlow = {
  owner: string;
  account: ArbitrumAccountStatus | null;
  exitOrder: ArbitrumExitOrder | null;
  quote: ArbitrumSolverQuote | null;
  attempt: ArbitrumSelectedAttempt | null;
  authorization: ArbitrumExitAuthorization | null;
  /** One key binds every observation of this attempt. */
  idempotencyKey: string;
  observation: ArbitrumAsyncObservation | null;
  observationNote: string | null;
  busy: ArbitrumExitStep | null;
  error: string | null;
};

export type ArbitrumExitAction = Readonly<{
  kind: "arbitrum-exit" | "none";
  label: string;
  reason: string;
  disabled: boolean;
}>;

function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.$naryxType === "bigint" && typeof record.value === "string") return record.value;
  }
  return "-";
}

function decimalText(atoms: string, decimals: number, unit = ""): string {
  if (!/^(0|[1-9][0-9]*)$/.test(atoms)) return "-";
  const padded = atoms.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).slice(0, 6).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}${unit ? ` ${unit}` : ""}`;
}

function compact(value: string, leading = 10, trailing = 8): string {
  return value.length > leading + trailing + 3 ? `${value.slice(0, leading)}...${value.slice(-trailing)}` : value;
}

function unixTimeText(seconds: unknown): string {
  const text = typeof seconds === "string" ? seconds : "";
  if (!/^(0|[1-9][0-9]{0,11})$/.test(text)) return "-";
  return new Date(Number(text) * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function cancelled(observation: ArbitrumAsyncObservation | null): boolean {
  return observation?.exit?.status === "CANCELLED" || observation?.exit?.status === "RECOVERED";
}

/** No further progress is observable: closed with its receipt, cancelled, or awaiting recovery. */
function finished(observation: ArbitrumAsyncObservation | null): boolean {
  return observation !== null && (observation.exitCompleted || cancelled(observation)
    || observation.exit?.status === "CONFLICT" || observation.lifecycle === "CONFLICT"
    || observation.lifecycle === "EVIDENCE_MISMATCH");
}

function freshFlow(owner: string, account: ArbitrumAccountStatus | null, error: string | null): ExitFlow {
  return {
    owner, account, exitOrder: null, quote: null, attempt: null, authorization: null,
    idempotencyKey: crypto.randomUUID(), observation: null, observationNote: null, busy: null, error,
  };
}

export function useArbitrumSepoliaExit(input: Readonly<{
  /** Exit mode on Arbitrum Sepolia with the wallet connected on that chain. */
  enabled: boolean;
  owner: string | null;
  provider: PrivateHttpTerminalProvider | null;
  contextId: string;
  slippageBps: number;
  signTypedData: (typedData: unknown) => Promise<string>;
  /** The selected exit attempt, the package size it closes as a base-asset decimal, and its owner. */
  onSelected: (attemptId: string, size: string, owner: string) => void;
}>) {
  const { enabled, owner, provider, contextId, slippageBps, signTypedData, onSelected } = input;
  const [flow, setFlow] = useState<ExitFlow | null>(null);
  const current = flow !== null && flow.owner === owner ? flow : null;

  const missing = current === null;
  useEffect(() => {
    if (!enabled || !provider || !owner || !missing) return;
    const controller = new AbortController();
    provider.getArbitrumAccountStatus(owner, controller.signal)
      .then((account) => { if (!controller.signal.aborted) setFlow(freshFlow(owner, account, null)); })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setFlow(freshFlow(owner, null, cause instanceof Error ? cause.message : "Strategy account read failed."));
        }
      });
    return () => controller.abort();
  }, [enabled, missing, owner, provider]);

  const attemptId = current?.attempt?.attemptId ?? null;
  const idempotencyKey = current?.idempotencyKey ?? null;
  const observing = enabled && current?.authorization?.signed === true && !finished(current.observation);
  useEffect(() => {
    if (!provider || !observing || !attemptId || !idempotencyKey) return;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const observation = await provider.observeArbitrumAsyncExecution({ attemptId, idempotencyKey }, controller.signal);
        if (controller.signal.aborted) return;
        setFlow((previous) => previous?.attempt?.attemptId === attemptId
          ? { ...previous, observation, observationNote: null, error: null }
          : previous);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setFlow((previous) => previous?.attempt?.attemptId !== attemptId ? previous : cause instanceof ArbitrumObservationError
          ? { ...previous, observationNote: "Waiting for the solver to submit the signed exit.", error: null }
          : { ...previous, error: cause instanceof Error ? cause.message : "Observation is temporarily unavailable." });
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [attemptId, idempotencyKey, observing, provider]);

  const nextStep: ArbitrumExitStep | null = (() => {
    if (!current || current.busy) return null;
    if (!current.account) return "account";
    if (current.authorization?.signed) return cancelled(current.observation) ? "restart" : null;
    if (!current.account.openPackage?.exitable) return null;
    if (!current.exitOrder) return "create";
    if (!current.quote) return "quote";
    if (!current.attempt) return "select";
    if (!current.authorization) return "prepare";
    return "sign";
  })();

  const action = useMemo<ArbitrumExitAction>(() => {
    const none = (label: string, reason: string): ArbitrumExitAction => ({ kind: "none", label, reason, disabled: true });
    const step = (label: string, reason: string): ArbitrumExitAction => ({
      kind: "arbitrum-exit", label, reason: current?.error ?? reason, disabled: false,
    });
    if (!current) return none("Loading strategy account", "Reading your Arbitrum Sepolia strategy account and open package from chain.");
    if (current.busy) return none("Working", current.error ?? "Waiting for the current exit step.");
    if (!current.account) return step("Retry account read", "The strategy account read failed.");
    const observation = current.observation;
    if (current.authorization?.signed) {
      if (observation?.exitCompleted && observation.finalReceipt) {
        return none("Package closed", `GMX closed the short and the spot leg sold for ${decimalText(observation.finalReceipt.spotQuoteAtoms, QUOTE_DECIMALS, "USDC")} to your wallet. The final package receipt is in the exit review.`);
      }
      if (cancelled(observation)) {
        return step("Start a new exit", "GMX did not execute the close, so the package is still open and nothing left the account. Create a fresh exit order.");
      }
      if (finished(observation)) {
        return none("Exit needs recovery", observation?.reason ?? "The exit evidence conflicts; the package is held for manual recovery.");
      }
      if (observation?.exit?.status === "EXECUTED") {
        return none("Closed on GMX, selling spot", current.error ?? "The short is closed; the exit controller is selling the spot leg and recording the final receipt.");
      }
      return none(observation?.exit ? `Exit ${observation.exit.status.toLowerCase()}` : "Exit signed, submitting",
        current.error ?? current.observationNote ?? "The solver submits your signed full close and pays the GMX execution fee; GMX keepers execute it asynchronously.");
    }
    const open = current.account.openPackage;
    if (!current.account.deployed || open === null) {
      return none("No open package", "This wallet's Arbitrum Sepolia strategy account holds no package to exit.");
    }
    if (open.activeExitRequestKey !== null) {
      return none("Exit in progress", "An exit for this package is already submitted on Arbitrum Sepolia; its result appears on the Activity page.");
    }
    if (!open.exitable) return none("Package not exitable yet", "The package entry has not executed on GMX yet.");
    switch (nextStep) {
      case "create":
        return step("Create exit order", "Reads your open package from chain and prices the exit minimums from the live Chainlink reference and pool, less the pool fee and your slippage.");
      case "quote":
        return step("Request exit quote", "Asks the bonded solver for a signed quote on the full close.");
      case "select":
        return step("Accept exit quote", "Review the signed exit outcome and fees in the exit review before accepting.");
      case "prepare":
        return step("Review exit", "Prepares the full-close authorization for your review. Nothing is signed or sent.");
      case "sign":
        return step("Sign exit", "Your wallet signs the reviewed full close (EIP-712 message, no transaction). The solver submits it and pays the GMX execution fee.");
      default:
        return none("Exit unavailable", current.error ?? "No exit step is available.");
    }
  }, [current, nextStep]);

  const advance = useCallback(async () => {
    if (!provider || !current || !nextStep) return;
    const flowAtStart = current;
    setFlow({ ...flowAtStart, busy: nextStep, error: null });
    const done = (next: Partial<ExitFlow>) => setFlow((previous) => ({ ...(previous ?? flowAtStart), ...next, busy: null, error: null }));
    try {
      if (nextStep === "account" || nextStep === "restart") {
        const account = await provider.getArbitrumAccountStatus(flowAtStart.owner);
        setFlow(freshFlow(flowAtStart.owner, account, null));
        return;
      }
      const account = flowAtStart.account!;
      if (nextStep === "create") {
        done({ exitOrder: await provider.createArbitrumExitOrder(account, { contextId, slippageBps, idempotencyKey: crypto.randomUUID() }) });
        return;
      }
      const exitOrder = flowAtStart.exitOrder!;
      if (nextStep === "quote") {
        const quote = await provider.requestArbitrumQuote(exitOrder.order, crypto.randomUUID());
        if (quote.route.action !== "EXIT") throw new Error("The solver quote is not an exit.");
        done({ quote });
        return;
      }
      if (nextStep === "select") {
        const attempt = await provider.selectArbitrumQuote(flowAtStart.quote!);
        done({ attempt });
        onSelected(attempt.attemptId, decimalText(exitOrder.quantityAtoms, BASE_DECIMALS), flowAtStart.owner);
        return;
      }
      const attempt = flowAtStart.attempt!;
      if (nextStep === "prepare") {
        done({ authorization: await provider.prepareArbitrumExitAuthorization(attempt, { account, packageId: exitOrder.packageId }) });
        return;
      }
      const authorization = flowAtStart.authorization!;
      if (Math.floor(Date.now() / 1000) >= Number(authorization.typedData.message.authorizationExpiry)) {
        throw new Error("The exit authorization expired before signing.");
      }
      const signature = await signTypedData(arbitrumExitWalletTypedData(authorization));
      done({ authorization: await provider.authorizeArbitrumExit(authorization, attempt, signature) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Arbitrum Sepolia exit step failed.";
      // An expired quote or authorization cannot be reused for the same order: start a fresh exit order.
      const restart = (nextStep === "prepare" || nextStep === "sign") && /expired|admission|deadline/i.test(message);
      setFlow((previous) => ({
        ...(previous ?? flowAtStart),
        ...(restart ? { exitOrder: null, quote: null, attempt: null, authorization: null, idempotencyKey: crypto.randomUUID() } : {}),
        busy: null,
        error: restart ? `${message} Create a fresh exit order.` : message,
      }));
    }
  }, [contextId, current, nextStep, onSelected, provider, signTypedData, slippageBps]);

  const panel: ReactNode = enabled && current ? <ArbitrumSepoliaExitPanel flow={current} /> : null;
  return { action, advance, busy: current?.busy != null, panel };
}

/** The open package, the exit order's minimums, the signed quote, the reviewed authorization, and the receipt. */
function ArbitrumSepoliaExitPanel({ flow }: { flow: ExitFlow }) {
  const open = flow.account?.openPackage ?? null;
  const order = flow.exitOrder;
  const terms = flow.quote?.quote;
  const outcome = (terms?.quotedOutcome as { exitQuoteOutcome?: { atoms?: unknown } } | undefined)?.exitQuoteOutcome?.atoms;
  const spot = (terms?.expectedSpotNotional as { atoms?: unknown } | undefined)?.atoms;
  const message = flow.authorization?.typedData.message;
  const observation = flow.observation;
  const receipt = observation?.finalReceipt ?? null;
  const usd = (value: unknown) => decimalText(typeof value === "string" ? value : "", USD_DECIMALS, "USD");
  return (
    <details className={styles.flowDetails} open={flow.exitOrder !== null}>
      <summary>
        <span>Testnet exit review</span>
        <span className={styles.chipNeutral}>{receipt ? "CLOSED" : observation?.exit?.status ?? (flow.authorization?.signed ? "SIGNED" : flow.authorization ? "REVIEW" : flow.attempt ? "SELECTED" : flow.quote ? "QUOTE" : order ? "ORDER" : "PACKAGE")}</span>
      </summary>
      <section className={styles.executionReview} aria-labelledby="arbitrum-exit-title">
        <div className={styles.evidenceHeading}>
          <h3 id="arbitrum-exit-title">Arbitrum Sepolia full close</h3>
          <span>{open ? (open.exitable ? "OPEN" : open.activeExitRequestKey ? "EXIT ACTIVE" : "NOT EXITABLE") : "NO PACKAGE"}</span>
        </div>
        <p className={styles.reviewNotice}>
          Testnet only. Your wallet signs one message; it sends no transaction. The bonded solver submits the full close and pays the GMX execution fee. Every proceed, the closed short&apos;s collateral and the spot sale, goes to your wallet.
        </p>
        {open ? (
          <div className={styles.reviewGrid}>
            <span>Package id</span><strong title={open.packageId}>{compact(open.packageId, 12, 10)}</strong>
            <span>GMX short</span><strong>{usd(open.positionSizeUsd)}</strong>
            <span>Spot inventory</span><strong>{decimalText(open.spotBaseAtoms, BASE_DECIMALS, "WETH")}</strong>
          </div>
        ) : null}
        {order ? (
          <div className={styles.reviewGrid}>
            <span>Exit order</span><strong title={order.order.orderHashHex}>{compact(order.order.orderHashHex, 12, 10)}</strong>
            <span>Minimum spot proceeds</span><strong>{decimalText(order.limits.minSpotQuoteOutAtoms, QUOTE_DECIMALS, "USDC")}</strong>
            <span>Minimum close output</span><strong>{decimalText(order.limits.minPerpOutputAtoms, QUOTE_DECIMALS, "USDC")}</strong>
            <span>Minimum exit outcome</span><strong>{decimalText(order.limits.minExitQuoteOutcomeAtoms, QUOTE_DECIMALS, "USDC")}</strong>
          </div>
        ) : null}
        {terms ? (
          <div className={styles.reviewGrid}>
            <span>Quoted exit outcome</span><strong>{decimalText(scalar(outcome), QUOTE_DECIMALS, "USDC")}</strong>
            <span>Expected spot proceeds</span><strong>{decimalText(scalar(spot), QUOTE_DECIMALS, "USDC")}</strong>
            <span>Quote hash</span><strong title={flow.quote?.quoteHash}>{compact(flow.quote?.quoteHash ?? "", 12, 10)}</strong>
          </div>
        ) : null}
        {flow.authorization && message ? (
          <div className={styles.reviewGrid}>
            <span>Authorization</span><strong>{flow.authorization.signed ? "Signed by your wallet" : "Awaiting your signature"}</strong>
            <span>Digest</span><strong title={flow.authorization.digest}>{compact(flow.authorization.digest, 12, 10)}</strong>
            <span>Exit controller</span><strong title={flow.authorization.exitController}>{compact(flow.authorization.exitController, 10, 8)}</strong>
            <span>Close size</span><strong>{usd(message.fullCloseSizeUsd)}</strong>
            <span>Acceptable price (raw)</span><strong title={String(message.acceptablePrice)}>{compact(String(message.acceptablePrice), 10, 6)}</strong>
            <span>Minimum close output</span><strong>{usd(message.minOutputAmount)}</strong>
            <span>Minimum spot proceeds</span><strong>{decimalText(String(message.spotMinQuoteAtoms), QUOTE_DECIMALS, "USDC")}</strong>
            <span>GMX execution fee</span><strong>{formatEther(BigInt(String(message.executionFeeWei)))} ETH, paid by the solver</strong>
            <span>Submit before</span><strong>{unixTimeText(message.authorizationExpiry)}</strong>
            <span>Cancellable after</span><strong>{unixTimeText(message.cancelAfter)}</strong>
          </div>
        ) : null}
        {flow.authorization?.signed ? (
          <div className={styles.submissionReceipt} role="status">
            <span>Async exit</span>
            <strong>{observation?.exit ? observation.exit.status.toLowerCase() : "awaiting submission"}</strong>
            <small>
              {observation?.exit
                ? `Evidence ${observation.evidenceGrade}; revision ${observation.exit.revision}${observation.exit.reconciling ? ", reconciling" : ""}${observation.exit.released ? ", released" : ""}.${observation.reason ? ` ${observation.reason}` : ""}`
                : flow.observationNote ?? "Waiting for the first observation."}
            </small>
          </div>
        ) : null}
        {receipt ? (
          <div className={styles.reviewGrid} aria-label="Final package receipt">
            <span>Final receipt</span><strong title={receipt.commitment}>{compact(receipt.commitment, 12, 10)}</strong>
            <span>Spot proceeds</span><strong>{decimalText(receipt.spotQuoteAtoms, QUOTE_DECIMALS, "USDC")} to {compact(receipt.recipient, 8, 6)}</strong>
            <span>Closed short</span><strong>{usd(receipt.fullCloseSizeUsd)}</strong>
            <span>Spot sold</span><strong>{decimalText(receipt.spotBaseAtoms, BASE_DECIMALS, "WETH")}</strong>
            <span>Exit request</span><strong title={receipt.exitRequestKey}>{compact(receipt.exitRequestKey, 12, 10)}</strong>
          </div>
        ) : null}
      </section>
    </details>
  );
}

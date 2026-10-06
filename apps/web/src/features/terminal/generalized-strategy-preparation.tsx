"use client";

import { Fragment, useEffect, useState } from "react";
import { formatAtomicAmount, formatMetricValue } from "./format";
import styles from "./trading-terminal.module.css";

const HASH = /^[0-9a-f]{64}$/;
const DOMAIN_KINDS = new Set([
  "SOLANA_MULTI_STRATEGY_ACCOUNT",
  "EVM_MULTI_STRATEGY_ACCOUNT",
  "EVM_ASYNC_EXECUTOR",
  "HYPERCORE_EXECUTOR",
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type DomainReview = Readonly<{
  kind: string;
  domainId: string;
  manifestVersion: number;
  manifestHash: string;
  routeSettlementClass: string;
  localGuarantee: string;
  summary: string;
  expiry: string | null;
}>;

type StrategyPreparationReview = Readonly<{
  quoteHash: string;
  orderHash: string;
  graphHash: string;
  routeHash: string;
  crossDomainPlanHash: string | null;
  packageId: string;
  templateId: string;
  templateVersion: number;
  operation: string;
  settlementClass: string;
  coordination: string;
  domains: readonly DomainReview[];
}>;

type AdmissionSummary = Readonly<{
  quoteHash: string;
  routeHash: string;
  templateId: string;
  templateVersion: number;
  lifecycleAction: string;
  settlementClass: string;
  solverId: string;
  domainIds: readonly string[];
  validUntilValue: string;
}>;

type QuoteMetric = Readonly<{
  metricId: string;
  value: string;
  scale: number;
  unitId: string;
}>;

type PackageQuoteReview = Readonly<{
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  solverId: string;
  seriesId: string;
  quoteMode: string;
  settlementClass: string;
  quoteAsset: string;
  quoteDecimals: number;
  netOutcomeAtoms: string;
  grossNotionalAtoms: string;
  marginDeltaAtoms: string;
  residualValueAtoms: string;
  serviceFeeAtoms: string;
  passThroughCostAtoms: string;
  validUntilUnit: string;
  validUntilValue: string;
  metrics: readonly QuoteMetric[];
}>;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is invalid.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} is invalid.`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${context} is invalid.`);
  return value;
}

function unsignedInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${context} is invalid.`);
  return value;
}

function decimalInteger(value: unknown, context: string): string {
  const result = text(value, context);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(result)) throw new Error(`${context} is invalid.`);
  return result;
}

function hash(value: unknown, context: string): string {
  const result = text(value, context);
  if (!HASH.test(result) || /^0+$/.test(result)) throw new Error(`${context} is invalid.`);
  return result;
}

function list(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} is invalid.`);
  return value;
}

function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (value.$naryxType === "bigint" && typeof value.value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value.value)) {
      return value.value;
    }
    if (value.$naryxType === "bytes" && typeof value.value === "string" && /^(?:[0-9a-f]{2})*$/.test(value.value)) {
      return value.value;
    }
    if ("$naryxType" in value) throw new Error("Protocol response contains an invalid tagged value.");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

function domainSummary(kind: string, value: Record<string, unknown>): Readonly<{ summary: string; expiry: string | null }> {
  if (kind === "HYPERCORE_EXECUTOR") {
    const plan = record(value.plan, "HyperCore plan");
    const orders = list(plan.orders, "HyperCore orders").length;
    const batches = list(plan.batches, "HyperCore batches").length;
    const recoveries = list(plan.recoveryAuthorizations, "HyperCore recovery authorizations").length;
    const expiry = text(plan.requestExpiryMs, "HyperCore request expiry");
    return { summary: `${orders} IOC orders / ${batches} stages / ${recoveries} bounded recoveries`, expiry };
  }
  if (kind === "SOLANA_MULTI_STRATEGY_ACCOUNT") {
    const envelope = record(value.envelope, "Solana envelope");
    const instruction = record(envelope.instruction, "Solana instruction");
    const accounts = list(instruction.accounts, "Solana accounts").length;
    const signers = list(envelope.requiredSignerPubkeys, "Solana signers").length;
    return { summary: `1 atomic instruction / ${accounts} accounts / ${signers} required signers`, expiry: null };
  }
  if (kind === "EVM_MULTI_STRATEGY_ACCOUNT") {
    const envelope = record(value.envelope, "EVM envelope");
    return { summary: `${list(envelope.calls, "EVM calls").length} policy-checked account calls`, expiry: null };
  }
  const plan = record(value.plan, "EVM asynchronous plan");
  const stages = list(plan.stages, "EVM asynchronous stages");
  const calls = stages.reduce<number>((total, stage, index) => total + list(record(stage, `EVM stage ${index}`).calls, `EVM stage ${index} calls`).length, 0);
  return { summary: `${calls} bonded asynchronous calls / ${stages.length} stages`, expiry: null };
}

function parseReview(payload: unknown, requestedQuoteHash: string): StrategyPreparationReview {
  const root = record(decode(payload as Json), "Strategy preparation response");
  if (root.status !== "UNSIGNED_REVIEW_REQUIRED") throw new Error("Strategy preparation is not marked for unsigned review.");
  const preparation = record(root.preparation, "Strategy preparation");
  if (preparation.version !== 1) throw new Error("Strategy preparation version is unsupported.");
  const prepared = record(preparation.prepared, "Prepared strategy");
  if (prepared.version !== 1) throw new Error("Prepared strategy version is unsupported.");
  const quoteHash = hash(prepared.quoteHash, "Quote hash");
  if (quoteHash !== requestedQuoteHash) throw new Error("Prepared strategy does not bind the requested quote.");
  const identity = record(prepared.identity, "Strategy identity");
  const domains = list(prepared.domains, "Prepared domains").map((candidate, index): DomainReview => {
    const domainExecution = record(candidate, `Prepared domain ${index}`);
    const kind = text(domainExecution.kind, `Prepared domain ${index} kind`);
    if (!DOMAIN_KINDS.has(kind)) throw new Error(`Prepared domain ${index} kind is unsupported.`);
    const domain = record(domainExecution.domain, `Prepared domain ${index} identity`);
    const details = domainSummary(kind, domainExecution);
    return Object.freeze({
      kind,
      domainId: text(domain.domainId, `Prepared domain ${index} id`),
      manifestVersion: integer(domain.domainManifestVersion, `Prepared domain ${index} manifest version`),
      manifestHash: hash(domain.domainManifestHash, `Prepared domain ${index} manifest hash`),
      routeSettlementClass: text(domainExecution.routeSettlementClass, `Prepared domain ${index} settlement class`),
      localGuarantee: text(domainExecution.localGuarantee, `Prepared domain ${index} guarantee`),
      summary: details.summary,
      expiry: details.expiry,
    });
  });
  if (domains.length === 0) throw new Error("Prepared strategy has no execution domains.");
  return Object.freeze({
    quoteHash,
    orderHash: hash(prepared.orderHash, "Order hash"),
    graphHash: hash(prepared.graphHash, "Graph hash"),
    routeHash: hash(prepared.routeHash, "Route hash"),
    crossDomainPlanHash: prepared.crossDomainPlanHash === undefined ? null : hash(prepared.crossDomainPlanHash, "Cross-domain plan hash"),
    packageId: hash(identity.packageId, "Package id"),
    templateId: text(identity.templateId, "Template id"),
    templateVersion: integer(identity.templateVersion, "Template version"),
    operation: text(identity.operation, "Lifecycle operation"),
    settlementClass: text(prepared.settlementClass, "Settlement class"),
    coordination: text(prepared.coordination, "Coordination mode"),
    domains: Object.freeze(domains),
  });
}

function parseAdmissions(payload: unknown): readonly AdmissionSummary[] {
  const root = record(decode(payload as Json), "Recent strategy packages");
  if (root.version !== 1) throw new Error("Recent strategy package version is unsupported.");
  return list(root.admissions, "Recent strategy package admissions").map((candidate, index): AdmissionSummary => {
    const admission = record(candidate, `Recent strategy package ${index}`);
    const domainIds = list(admission.domainIds, `Recent strategy package ${index} domains`).map((domain, domainIndex) => text(domain, `Recent strategy package ${index} domain ${domainIndex}`));
    if (domainIds.length === 0) throw new Error(`Recent strategy package ${index} has no domain.`);
    return Object.freeze({
      quoteHash: hash(admission.quoteHashHex, `Recent strategy package ${index} quote hash`),
      routeHash: hash(admission.routeHashHex, `Recent strategy package ${index} route hash`),
      templateId: text(admission.templateId, `Recent strategy package ${index} template`),
      templateVersion: integer(admission.templateVersion, `Recent strategy package ${index} template version`),
      lifecycleAction: text(admission.lifecycleAction, `Recent strategy package ${index} action`),
      settlementClass: text(admission.settlementClass, `Recent strategy package ${index} settlement class`),
      solverId: text(admission.solverId, `Recent strategy package ${index} solver`),
      domainIds: Object.freeze(domainIds),
      validUntilValue: text(admission.validUntilValue, `Recent strategy package ${index} validity`),
    });
  });
}

function parseAmount(value: unknown, context: string, assetId: string, decimals: number): string {
  const amount = record(value, context);
  const asset = record(amount.asset, `${context} asset`);
  if (text(asset.assetId, `${context} asset id`) !== assetId || unsignedInteger(asset.decimals, `${context} asset decimals`) !== decimals) {
    throw new Error(`${context} uses another quote asset.`);
  }
  return decimalInteger(amount.atoms, `${context} atoms`);
}

function sumCosts(value: unknown, context: string, assetId: string, decimals: number): string {
  return list(value, context).reduce<bigint>((total, entry, index) => {
    const cost = record(entry, `${context} ${index}`);
    text(cost.category, `${context} ${index} category`);
    const atoms = BigInt(parseAmount(cost.amount, `${context} ${index} amount`, assetId, decimals));
    if (atoms < BigInt(0)) throw new Error(`${context} ${index} is negative.`);
    return total + atoms;
  }, BigInt(0)).toString();
}

function parseQuoteReview(payload: unknown, requestedOrderHash: string): PackageQuoteReview {
  const root = record(decode(payload as Json), "Strategy quote response");
  if (root.version !== 1 || root.status !== "SIGNED_AND_STORED") throw new Error("Strategy quote was not signed and stored.");
  const orderHash = hash(root.orderHash, "Order hash");
  if (orderHash !== requestedOrderHash) throw new Error("Strategy quote does not bind the requested order.");
  const quoteHash = hash(root.quoteHash, "Quote hash");
  const routeHash = hash(root.routeHash, "Route hash");
  const quote = record(root.quote, "Strategy quote");
  if (hash(quote.orderHash, "Quoted order hash") !== orderHash || hash(quote.routeHash, "Quoted route hash") !== routeHash) {
    throw new Error("Strategy quote commitments do not match the response.");
  }
  const quoteAsset = record(quote.quoteAsset, "Quote asset");
  const assetId = text(quoteAsset.assetId, "Quote asset id");
  const decimals = unsignedInteger(quoteAsset.decimals, "Quote asset decimals");
  if (decimals > 255) throw new Error("Quote asset decimals are invalid.");
  const metrics = list(quote.metrics, "Quote metrics").map((entry, index): QuoteMetric => {
    const metric = record(entry, `Quote metric ${index}`);
    return Object.freeze({
      metricId: text(metric.metricId, `Quote metric ${index} id`),
      value: decimalInteger(metric.value, `Quote metric ${index} value`),
      scale: unsignedInteger(metric.scale, `Quote metric ${index} scale`),
      unitId: text(metric.unitId, `Quote metric ${index} unit`),
    });
  });
  return Object.freeze({
    orderHash,
    quoteHash,
    routeHash,
    solverId: text(quote.solverId, "Solver id"),
    seriesId: text(quote.seriesId, "Series id"),
    quoteMode: text(quote.quoteMode, "Quote mode"),
    settlementClass: text(quote.settlementClass, "Settlement class"),
    quoteAsset: assetId.toUpperCase(),
    quoteDecimals: decimals,
    netOutcomeAtoms: parseAmount(quote.netPackageOutcome, "Net package outcome", assetId, decimals),
    grossNotionalAtoms: parseAmount(quote.totalGrossNotional, "Gross notional", assetId, decimals),
    marginDeltaAtoms: parseAmount(quote.totalMarginDelta, "Margin delta", assetId, decimals),
    residualValueAtoms: parseAmount(quote.totalResidualValue, "Residual value", assetId, decimals),
    serviceFeeAtoms: sumCosts(quote.serviceCharges, "Service charges", assetId, decimals),
    passThroughCostAtoms: sumCosts(quote.passThroughCosts, "Pass-through costs", assetId, decimals),
    validUntilUnit: text(quote.validUntilUnit, "Quote validity unit"),
    validUntilValue: decimalInteger(quote.validUntilValue, "Quote validity value"),
    metrics: Object.freeze(metrics),
  });
}

function compact(value: string, head = 10, tail = 8): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = record(await response.json(), "Error response");
    const error = record(body.error, "Error");
    return typeof error.message === "string" && error.message.length > 0 ? error.message : `Request failed with HTTP ${response.status}.`;
  } catch {
    return `Request failed with HTTP ${response.status}.`;
  }
}

function expiryText(unit: string, value: string): string {
  if (unit === "HYPERLIQUID_UNIX_MILLISECONDS" || unit === "UNIX_MILLISECONDS") {
    const milliseconds = Number(value);
    if (Number.isSafeInteger(milliseconds)) return new Date(milliseconds).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }
  if (unit === "EVM_UNIX_SECONDS") {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return new Date(seconds * 1_000).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }
  return `${value} ${unit}`;
}

export function GeneralizedStrategyPreparationPanel({
  privateApiBaseUrl,
  publicApiBaseUrl,
  templateId,
  lifecycleAction,
}: {
  privateApiBaseUrl: string | null;
  publicApiBaseUrl: string | null;
  templateId: string;
  lifecycleAction: string;
}) {
  const [orderHash, setOrderHash] = useState("");
  const [quoteRequestKey, setQuoteRequestKey] = useState("");
  const [quoteReview, setQuoteReview] = useState<PackageQuoteReview | null>(null);
  const [quoteHash, setQuoteHash] = useState("");
  const [review, setReview] = useState<StrategyPreparationReview | null>(null);
  const [admissions, setAdmissions] = useState<readonly AdmissionSummary[]>([]);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (publicApiBaseUrl === null) return;
    const controller = new AbortController();
    void fetch(`${publicApiBaseUrl}/v1/strategy-packages/recent?limit=50`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Recent package feed answered HTTP ${response.status}.`);
      return parseAdmissions(await response.json());
    }).then((value) => {
      setAdmissions(value);
      setAdmissionError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setAdmissionError(cause instanceof Error ? cause.message : "Recent package feed is unavailable.");
    });
    return () => controller.abort();
  }, [publicApiBaseUrl]);

  const matchingAdmissions = admissions.filter((admission) => admission.templateId === templateId && admission.lifecycleAction === lifecycleAction);

  async function requestQuote() {
    if (publicApiBaseUrl === null || !HASH.test(orderHash)) return;
    setQuoteBusy(true);
    setError(null);
    const idempotencyKey = quoteRequestKey || crypto.randomUUID();
    if (quoteRequestKey === "") setQuoteRequestKey(idempotencyKey);
    try {
      const response = await fetch(`${publicApiBaseUrl}/v1/strategy-quotes/request`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderHash, idempotencyKey }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const parsed = parseQuoteReview(await response.json(), orderHash);
      setQuoteReview(parsed);
      setQuoteHash(parsed.quoteHash);
      setReview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy quote request failed closed.");
    } finally {
      setQuoteBusy(false);
    }
  }

  async function prepare() {
    if (privateApiBaseUrl === null || !HASH.test(quoteHash)) return;
    setPrepareBusy(true);
    setError(null);
    try {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/prepare`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      setReview(parseReview(await response.json(), quoteHash));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy preparation failed closed.");
    } finally {
      setPrepareBusy(false);
    }
  }

  return (
    <section className={styles.executionReview} aria-labelledby="generalized-strategy-review-title">
      <div className={styles.evidenceHeading}>
        <h3 id="generalized-strategy-review-title">Package quote and execution</h3>
        <span>{review ? "UNSIGNED PLAN" : quoteReview ? "SIGNED QUOTE" : "QUOTE REQUIRED"}</span>
      </div>
      <p className={styles.reviewNotice}>
        Request a live solver-signed quote for a stored typed order, inspect its complete-package economics, then compile the admitted route into an unsigned execution plan.
      </p>
      <div className={styles.strategyPrepareForm}>
        <label htmlFor="generalized-strategy-order">Stored order hash</label>
        <input
          id="generalized-strategy-order"
          value={orderHash}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="64 lowercase hex characters"
          onChange={(event) => {
            setOrderHash(event.target.value.trim());
            setQuoteRequestKey("");
            setQuoteReview(null);
            setReview(null);
            setError(null);
          }}
        />
        <button type="button" className={styles.primaryAction} disabled={publicApiBaseUrl === null || quoteBusy || !HASH.test(orderHash)} onClick={() => void requestQuote()}>
          {quoteBusy ? "Requesting package quote" : "Request signed package quote"}
        </button>
      </div>
      {quoteReview ? (
        <div className={styles.quoteReview}>
          <div className={styles.reviewEconomics}>
            <div><span>Net outcome</span><strong>{formatAtomicAmount(quoteReview.netOutcomeAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
            <div><span>Gross notional</span><strong>{formatAtomicAmount(quoteReview.grossNotionalAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
            <div><span>Margin delta</span><strong>{formatAtomicAmount(quoteReview.marginDeltaAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
            <div><span>Venue costs</span><strong>{formatAtomicAmount(quoteReview.passThroughCostAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
            <div><span>Service fees</span><strong>{formatAtomicAmount(quoteReview.serviceFeeAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
            <div><span>Residual value</span><strong>{formatAtomicAmount(quoteReview.residualValueAtoms, quoteReview.quoteDecimals, quoteReview.quoteAsset)}</strong></div>
          </div>
          <div className={styles.reviewGrid}>
            <span>Series</span><strong>{quoteReview.seriesId}</strong>
            <span>Solver</span><strong>{quoteReview.solverId}</strong>
            <span>Quote mode</span><strong>{quoteReview.quoteMode}</strong>
            <span>Settlement</span><strong>{quoteReview.settlementClass}</strong>
            <span>Valid until</span><strong>{expiryText(quoteReview.validUntilUnit, quoteReview.validUntilValue)}</strong>
            <span>Quote</span><strong title={quoteReview.quoteHash}>{compact(quoteReview.quoteHash)}</strong>
            <span>Route</span><strong title={quoteReview.routeHash}>{compact(quoteReview.routeHash)}</strong>
          </div>
          {quoteReview.metrics.length > 0 ? (
            <details className={styles.quoteMetrics}>
              <summary>Package economics</summary>
              <div className={styles.reviewGrid}>
                {quoteReview.metrics.map((metric) => (
                  <Fragment key={metric.metricId}>
                    <span>{metric.metricId.replaceAll("-", " ")}</span>
                    <strong>{formatMetricValue(metric.value, metric.scale, metric.unitId, quoteReview.quoteAsset, quoteReview.quoteDecimals)}</strong>
                  </Fragment>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className={styles.strategyPrepareForm}>
        {matchingAdmissions.length > 0 ? (
          <>
            <label htmlFor="generalized-strategy-admission">Recent admitted package</label>
            <select
              id="generalized-strategy-admission"
              value={matchingAdmissions.some((admission) => admission.quoteHash === quoteHash) ? quoteHash : ""}
              onChange={(event) => {
                setQuoteHash(event.target.value);
                setReview(null);
                setError(null);
              }}
            >
              <option value="">Select an admitted quote</option>
              {matchingAdmissions.map((admission) => (
                <option key={admission.quoteHash} value={admission.quoteHash}>
                  {admission.domainIds.join(" + ")} / {admission.solverId} / {compact(admission.quoteHash, 8, 6)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="generalized-strategy-quote">Quote hash</label>
        <input
          id="generalized-strategy-quote"
          value={quoteHash}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="64 lowercase hex characters"
          onChange={(event) => {
            setQuoteHash(event.target.value.trim());
            setReview(null);
            setError(null);
          }}
        />
        <button type="button" className={styles.secondaryAction} disabled={privateApiBaseUrl === null || prepareBusy || !HASH.test(quoteHash)} onClick={() => void prepare()}>
          {prepareBusy ? "Preparing unsigned plan" : "Prepare unsigned plan"}
        </button>
      </div>
      <p className={styles.fieldContext} role="status">
        {error ?? (privateApiBaseUrl === null
          ? "Configure the private terminal API to prepare an admitted package."
          : review ? "Compilation passed. Nothing has been signed or submitted."
            : quoteReview ? "The signed quote is admitted and ready for unsigned execution preparation."
            : admissionError ?? (publicApiBaseUrl === null
              ? "Preparation is read-only. Paste an admitted quote hash from the package API."
              : matchingAdmissions.length === 0
                ? "No recent admitted quote matches this template and lifecycle action."
                : "Select a recent admitted quote or paste its hash. Preparation never broadcasts."))}
      </p>
      {review ? (
        <>
          <div className={styles.reviewGrid}>
            <span>Template</span><strong>{review.templateId} v{review.templateVersion}</strong>
            <span>Operation</span><strong>{review.operation}</strong>
            <span>Settlement</span><strong>{review.settlementClass}</strong>
            <span>Coordination</span><strong>{review.coordination}</strong>
            <span>Package</span><strong title={review.packageId}>{compact(review.packageId)}</strong>
            <span>Order</span><strong title={review.orderHash}>{compact(review.orderHash)}</strong>
            <span>Graph</span><strong title={review.graphHash}>{compact(review.graphHash)}</strong>
            <span>Quote</span><strong title={review.quoteHash}>{compact(review.quoteHash)}</strong>
            <span>Route</span><strong title={review.routeHash}>{compact(review.routeHash)}</strong>
            {review.crossDomainPlanHash ? <><span>Coordination plan</span><strong title={review.crossDomainPlanHash}>{compact(review.crossDomainPlanHash)}</strong></> : null}
          </div>
          {review.domains.map((domain) => (
            <div className={styles.strategyDomainReview} key={`${domain.domainId}:${domain.manifestVersion}`}>
              <div className={styles.evidenceHeading}>
                <h3>{domain.domainId}</h3>
                <span>{domain.kind.replaceAll("_", " ")}</span>
              </div>
              <div className={styles.reviewGrid}>
                <span>Guarantee</span><strong>{domain.localGuarantee}</strong>
                <span>Route settlement</span><strong>{domain.routeSettlementClass}</strong>
                <span>Manifest</span><strong title={domain.manifestHash}>v{domain.manifestVersion} / {compact(domain.manifestHash)}</strong>
                <span>Concrete plan</span><strong title={domain.summary}>{domain.summary}</strong>
                {domain.expiry ? <><span>Request expiry</span><strong>{domain.expiry} ms</strong></> : null}
              </div>
            </div>
          ))}
          <p className={styles.reviewNotice}>
            This is an execution review artifact only. A domain-specific signer and executor must independently revalidate it before submission.
          </p>
        </>
      ) : null}
    </section>
  );
}

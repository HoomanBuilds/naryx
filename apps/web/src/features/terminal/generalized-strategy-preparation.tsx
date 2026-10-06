"use client";

import { useEffect, useState } from "react";
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
    if ("$naryxType" in value) throw new Error("Strategy preparation contains an invalid tagged value.");
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

function compact(value: string, head = 10, tail = 8): string {
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = record(await response.json(), "Error response");
    const error = record(body.error, "Error");
    return typeof error.message === "string" && error.message.length > 0 ? error.message : `Preparation failed with HTTP ${response.status}.`;
  } catch {
    return `Preparation failed with HTTP ${response.status}.`;
  }
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
  const [quoteHash, setQuoteHash] = useState("");
  const [review, setReview] = useState<StrategyPreparationReview | null>(null);
  const [admissions, setAdmissions] = useState<readonly AdmissionSummary[]>([]);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function prepare() {
    if (privateApiBaseUrl === null || !HASH.test(quoteHash)) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <section className={styles.executionReview} aria-labelledby="generalized-strategy-review-title">
      <div className={styles.evidenceHeading}>
        <h3 id="generalized-strategy-review-title">Admitted package execution</h3>
        <span>{review ? "UNSIGNED PLAN" : "QUOTE REQUIRED"}</span>
      </div>
      <p className={styles.reviewNotice}>
        Load a solver-signed quote already admitted by the package market. Naryx recompiles its typed graph and route before returning any plan.
      </p>
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
        <button type="button" className={styles.secondaryAction} disabled={privateApiBaseUrl === null || busy || !HASH.test(quoteHash)} onClick={() => void prepare()}>
          {busy ? "Preparing" : "Prepare unsigned plan"}
        </button>
      </div>
      <p className={styles.fieldContext} role="status">
        {error ?? (privateApiBaseUrl === null
          ? "Configure the private terminal API to prepare an admitted package."
          : review ? "Compilation passed. Nothing has been signed or submitted."
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

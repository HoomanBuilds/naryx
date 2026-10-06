"use client";

import { Fragment, useEffect, useState } from "react";
import { formatAtomicAmount, formatMetricValue } from "./format";
import styles from "./trading-terminal.module.css";

const HASH = /^[0-9a-f]{64}$/;
const OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const STRATEGY_AUTHORIZATION_FIELDS = [
  ["orderHash", "bytes32"],
  ["owner", "address"],
  ["environment", "string"],
  ["templateId", "string"],
  ["lifecycleAction", "string"],
  ["settlementClass", "string"],
  ["settlementAccount", "string"],
  ["expiryUnit", "string"],
  ["expiryValue", "uint256"],
] as const;
const DOMAIN_KINDS = new Set([
  "SOLANA_MULTI_STRATEGY_ACCOUNT",
  "EVM_MULTI_STRATEGY_ACCOUNT",
  "EVM_ASYNC_EXECUTOR",
  "HYPERCORE_EXECUTOR",
]);
const NATIVE_HYPERCORE_TEMPLATES = new Set([
  "treasury-inventory-hedge-v1",
  "perpetual-funding-spread-v1",
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

type StagedStrategyOrder = Readonly<{
  sourceOrderHash: string;
  orderHash: string;
  graphHash: string;
}>;

type NativeStrategyMarketProfile = Readonly<{
  role: string;
  entrySide: "BUY" | "SELL";
  coin: string;
  assetId: number;
  sizeDecimals: number;
  maximumPriceDecimals: number;
}>;

type NativeStrategyProfile = Readonly<{
  profileId: string;
  displayName: string;
  templateId: string;
  templateVersion: number;
  seriesId: string;
  executionClassId: string;
  settlementAccount: string;
  baseAsset: Readonly<{ assetId: string; decimals: number }>;
  quoteAsset: Readonly<{ assetId: string; decimals: number }>;
  markets: readonly NativeStrategyMarketProfile[];
  bounds: Readonly<{
    minimumQuantityAtoms: string;
    maximumQuantityAtoms: string;
    maximumEconomicQuantityAtoms: string;
    maximumExpiryTtlMs: string;
  }>;
}>;

type CreatedNativeStrategyOrder = Readonly<{
  profileId: string;
  orderHash: string;
  graphHash: string;
}>;

type SelectedStrategyExecution = Readonly<{
  attemptId: string;
  orderHash: string;
  quoteHash: string;
  routeHash: string;
  sourceOrderHash: string | null;
  selectedAtMs: number;
}>;

export type StrategyOrderAuthorizationChallenge = Readonly<{
  orderHash: string;
  owner: string;
  typedData: unknown;
}>;

type StrategyExecutionResult = Readonly<{
  status: string;
  packageStatus: string | null;
  reasons: readonly string[];
}>;

type StrategyExecutionProgress = Readonly<{
  state: "NOT_STARTED" | "QUEUED" | "EXECUTING" | "UNCERTAIN" | "COMPLETED";
  lane: string | null;
  queuePosition: number | null;
}>;

type StrategyReceiptAmount = Readonly<{
  assetId: string;
  decimals: number;
  atoms: string;
}>;

type StrategyReceiptSummary = Readonly<{
  receiptHash: string;
  terminalState: string;
  finalityStatus: string;
  executedAtValue: string;
  solverId: string;
  venueFees: StrategyReceiptAmount;
  residualValue: StrategyReceiptAmount;
  legs: readonly Readonly<{
    legId: string;
    status: string;
    settled: StrategyReceiptAmount;
    venueFee: StrategyReceiptAmount;
    evidenceGrade: string;
    evidenceHash: string;
  }>[];
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

function parseStagedStrategyOrder(payload: unknown, requestedSourceOrderHash: string): StagedStrategyOrder {
  const root = record(payload, "Strategy order staging response");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || typeof root.created !== "boolean") {
    throw new Error("Strategy order staging response is invalid.");
  }
  const sourceOrderHash = hash(root.sourceOrderHash, "Source order hash");
  if (sourceOrderHash !== requestedSourceOrderHash) throw new Error("Staged strategy order does not bind the source order.");
  return Object.freeze({
    sourceOrderHash,
    orderHash: hash(root.orderHash, "Strategy order hash"),
    graphHash: hash(root.graphHash, "Strategy graph hash"),
  });
}

function parseNativeStrategyProfiles(payload: unknown): readonly NativeStrategyProfile[] {
  const root = record(payload, "Native strategy profiles");
  if (root.version !== 1) throw new Error("Native strategy profile version is unsupported.");
  return list(root.profiles, "Native strategy profiles").map((candidate, index): NativeStrategyProfile => {
    const profile = record(candidate, `Native strategy profile ${index}`);
    const baseAsset = record(profile.baseAsset, `Native strategy profile ${index} base asset`);
    const quoteAsset = record(profile.quoteAsset, `Native strategy profile ${index} quote asset`);
    const bounds = record(profile.bounds, `Native strategy profile ${index} bounds`);
    const markets = list(profile.markets, `Native strategy profile ${index} markets`).map((value, marketIndex) => {
      const market = record(value, `Native strategy profile ${index} market ${marketIndex}`);
      if (market.entrySide !== "BUY" && market.entrySide !== "SELL") {
        throw new Error(`Native strategy profile ${index} market ${marketIndex} side is invalid.`);
      }
      return Object.freeze({
        role: text(market.role, `Native strategy profile ${index} market ${marketIndex} role`),
        entrySide: market.entrySide,
        coin: text(market.coin, `Native strategy profile ${index} market ${marketIndex} coin`),
        assetId: unsignedInteger(market.assetId, `Native strategy profile ${index} market ${marketIndex} asset id`),
        sizeDecimals: unsignedInteger(market.sizeDecimals, `Native strategy profile ${index} market ${marketIndex} size decimals`),
        maximumPriceDecimals: unsignedInteger(market.maximumPriceDecimals, `Native strategy profile ${index} market ${marketIndex} price decimals`),
      });
    });
    if (markets.length === 0) throw new Error(`Native strategy profile ${index} has no markets.`);
    return Object.freeze({
      profileId: text(profile.profileId, `Native strategy profile ${index} id`),
      displayName: text(profile.displayName, `Native strategy profile ${index} display name`),
      templateId: text(profile.templateId, `Native strategy profile ${index} template`),
      templateVersion: integer(profile.templateVersion, `Native strategy profile ${index} template version`),
      seriesId: text(profile.seriesId, `Native strategy profile ${index} series`),
      executionClassId: text(profile.executionClassId, `Native strategy profile ${index} execution class`),
      settlementAccount: text(profile.settlementAccount, `Native strategy profile ${index} settlement account`),
      baseAsset: Object.freeze({
        assetId: text(baseAsset.assetId, `Native strategy profile ${index} base asset id`),
        decimals: unsignedInteger(baseAsset.decimals, `Native strategy profile ${index} base decimals`),
      }),
      quoteAsset: Object.freeze({
        assetId: text(quoteAsset.assetId, `Native strategy profile ${index} quote asset id`),
        decimals: unsignedInteger(quoteAsset.decimals, `Native strategy profile ${index} quote decimals`),
      }),
      markets: Object.freeze(markets),
      bounds: Object.freeze({
        minimumQuantityAtoms: decimalInteger(bounds.minimumQuantityAtoms, `Native strategy profile ${index} minimum quantity`),
        maximumQuantityAtoms: decimalInteger(bounds.maximumQuantityAtoms, `Native strategy profile ${index} maximum quantity`),
        maximumEconomicQuantityAtoms: decimalInteger(bounds.maximumEconomicQuantityAtoms, `Native strategy profile ${index} maximum economic quantity`),
        maximumExpiryTtlMs: decimalInteger(bounds.maximumExpiryTtlMs, `Native strategy profile ${index} expiry TTL`),
      }),
    });
  });
}

function parseCreatedNativeStrategyOrder(
  payload: unknown,
  expected: Readonly<{ profileId: string; templateId: string; lifecycleAction: string }>,
): CreatedNativeStrategyOrder {
  const root = record(payload, "Native strategy order creation");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || typeof root.created !== "boolean"
    || root.profileId !== expected.profileId || root.templateId !== expected.templateId
    || root.lifecycleAction !== expected.lifecycleAction) {
    throw new Error("Native strategy order creation response changed the requested strategy.");
  }
  return Object.freeze({
    profileId: expected.profileId,
    orderHash: hash(root.orderHash, "Native strategy order hash"),
    graphHash: hash(root.graphHash, "Native strategy graph hash"),
  });
}

function amountToAtoms(value: string, decimals: number, context: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error(`${context} must be a decimal amount.`);
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${context} supports at most ${decimals} decimal places.`);
  const atoms = BigInt(whole) * (BigInt(10) ** BigInt(decimals))
    + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (atoms <= BigInt(0)) throw new Error(`${context} must be greater than zero.`);
  return atoms;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a;
}

function priceToAtomicRatio(
  value: string,
  baseDecimals: number,
  quoteDecimals: number,
  maximumPriceDecimals: number,
  context: string,
): Readonly<{ quoteAtoms: string; baseAtoms: string }> {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new Error(`${context} must be a decimal price.`);
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > maximumPriceDecimals) {
    throw new Error(`${context} supports at most ${maximumPriceDecimals} decimal places.`);
  }
  const displayScale = BigInt(10) ** BigInt(fraction.length);
  const displayNumerator = BigInt(whole) * displayScale + BigInt(fraction || "0");
  if (displayNumerator <= BigInt(0)) throw new Error(`${context} must be greater than zero.`);
  const quoteAtoms = displayNumerator * (BigInt(10) ** BigInt(quoteDecimals));
  const baseAtoms = displayScale * (BigInt(10) ** BigInt(baseDecimals));
  const divisor = greatestCommonDivisor(quoteAtoms, baseAtoms);
  return Object.freeze({
    quoteAtoms: (quoteAtoms / divisor).toString(),
    baseAtoms: (baseAtoms / divisor).toString(),
  });
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return BigInt(`0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`).toString();
}

function unixTimeMs(): bigint {
  return BigInt(Date.now());
}

function parseStrategyOrderAuthorization(
  payload: unknown,
  requestedOrderHash: string,
): StrategyOrderAuthorizationChallenge {
  const root = record(payload, "Strategy order authorization");
  if (root.version !== 1 || root.status !== "UNSIGNED_STRATEGY_ORDER") {
    throw new Error("Strategy order authorization response is invalid.");
  }
  const orderHash = hash(root.orderHash, "Authorized strategy order hash");
  const owner = text(root.owner, "Strategy order owner");
  if (orderHash !== requestedOrderHash || !OWNER.test(owner)) {
    throw new Error("Strategy order authorization does not bind the reviewed order and owner.");
  }
  const typedData = record(root.typedData, "Strategy order typed data");
  const domain = record(typedData.domain, "Strategy order typed-data domain");
  const types = record(typedData.types, "Strategy order typed-data types");
  const message = record(typedData.message, "Strategy order typed-data message");
  const fields = list(types.StrategyPackageAuthorization, "Strategy order authorization fields");
  const expectedFields = STRATEGY_AUTHORIZATION_FIELDS.map(([name, type]) => ({ name, type }));
  if (domain.name !== "Naryx Strategy Package Testnet" || domain.version !== "1" || "chainId" in domain
    || typedData.primaryType !== "StrategyPackageAuthorization"
    || JSON.stringify(fields) !== JSON.stringify(expectedFields)
    || message.orderHash !== `0x${orderHash}` || message.owner !== owner
    || message.environment !== "testnet") {
    throw new Error("Strategy order authorization typed data is invalid.");
  }
  return Object.freeze({ orderHash, owner, typedData });
}

function parseAuthorizedStrategyOrder(payload: unknown, expected: StrategyOrderAuthorizationChallenge): void {
  const root = record(payload, "Authorized strategy order");
  const authorization = record(root.authorization, "Stored strategy order authorization");
  if (root.version !== 1 || root.status !== "OWNER_AUTHORIZED" || typeof root.created !== "boolean"
    || authorization.orderHashHex !== expected.orderHash || authorization.owner !== expected.owner
    || authorization.scheme !== "EIP712_SECP256K1") {
    throw new Error("Stored strategy order authorization changed the reviewed identity.");
  }
}

function parseSelectedExecution(
  payload: unknown,
  expected: Readonly<{ orderHash: string; quoteHash: string; routeHash: string; sourceOrderHash: string | null }>,
): SelectedStrategyExecution {
  const root = record(payload, "Strategy execution selection");
  const legacy = expected.sourceOrderHash !== null;
  if (root.version !== (legacy ? 1 : 2) || root.status !== "HYPERLIQUID_TESTNET_QUOTE_SELECTED") {
    throw new Error("Strategy execution selection response is invalid.");
  }
  const sourceOrderHash = legacy
    ? hash(root.sourceOrderHashHex, "Selected source order hash")
    : null;
  if (!legacy && "sourceOrderHashHex" in root) {
    throw new Error("Native strategy execution unexpectedly carries a source order.");
  }
  const selected = Object.freeze({
    attemptId: text(root.attemptId, "Strategy attempt id"),
    orderHash: hash(root.orderHashHex, "Selected order hash"),
    quoteHash: hash(root.quoteHashHex, "Selected quote hash"),
    routeHash: hash(root.routeHashHex, "Selected route hash"),
    sourceOrderHash,
    selectedAtMs: unsignedInteger(root.selectedAtMs, "Selection time"),
  });
  if (selected.orderHash !== expected.orderHash || selected.quoteHash !== expected.quoteHash
    || selected.routeHash !== expected.routeHash || selected.sourceOrderHash !== expected.sourceOrderHash) {
    throw new Error("Strategy execution selection changed a reviewed commitment.");
  }
  return selected;
}

function parseExecutionResult(payload: unknown, attemptId: string, idempotencyKey: string): StrategyExecutionResult {
  const root = record(payload, "Strategy execution result");
  if (root.attemptId !== attemptId || root.idempotencyKey !== idempotencyKey
    || root.domain !== "hypercore:testnet" || root.environment !== "TESTNET") {
    throw new Error("Strategy execution result does not bind the submitted testnet request.");
  }
  const status = text(root.status, "Strategy execution status");
  const packageStatus = root.packageStatus === undefined ? null : text(root.packageStatus, "Strategy package status");
  const reasons = root.reasons === undefined
    ? []
    : list(root.reasons, "Strategy execution reasons").map((reason, index) => text(reason, `Strategy execution reason ${index}`));
  return Object.freeze({ status, packageStatus, reasons: Object.freeze(reasons) });
}

function parseReceiptAmount(value: unknown, context: string): StrategyReceiptAmount {
  const amount = record(value, context);
  const asset = record(amount.asset, `${context} asset`);
  hash(asset.assetManifestHash, `${context} asset manifest`);
  const decimals = unsignedInteger(asset.decimals, `${context} asset decimals`);
  if (decimals > 255) throw new Error(`${context} asset decimals are invalid.`);
  return Object.freeze({
    assetId: text(asset.assetId, `${context} asset id`).toUpperCase(),
    decimals,
    atoms: decimalInteger(amount.atoms, `${context} atoms`),
  });
}

function parseStrategyReceipt(payload: unknown, expectedQuoteHash: string): StrategyReceiptSummary {
  const root = record(decode(payload as Json), "Strategy receipt response");
  if (root.version !== 1 || hash(root.quoteHash, "Receipt lookup quote hash") !== expectedQuoteHash) {
    throw new Error("Strategy receipt response does not bind the selected quote.");
  }
  const receipt = record(root.receipt, "Strategy receipt");
  if (hash(receipt.quoteHash, "Receipt quote hash") !== expectedQuoteHash) {
    throw new Error("Strategy receipt changed the selected quote commitment.");
  }
  const legs = list(receipt.legOutcomes, "Strategy receipt legs").map((value, index) => {
    const leg = record(value, `Strategy receipt leg ${index}`);
    if (typeof leg.onchainEnforced !== "boolean") throw new Error(`Strategy receipt leg ${index} enforcement is invalid.`);
    return Object.freeze({
      legId: text(leg.legId, `Strategy receipt leg ${index} id`),
      status: text(leg.status, `Strategy receipt leg ${index} status`),
      settled: parseReceiptAmount(leg.settledQuantity, `Strategy receipt leg ${index} settled quantity`),
      venueFee: parseReceiptAmount(leg.venueFee, `Strategy receipt leg ${index} venue fee`),
      evidenceGrade: text(leg.evidenceGrade, `Strategy receipt leg ${index} evidence grade`),
      evidenceHash: hash(leg.evidenceHash, `Strategy receipt leg ${index} evidence hash`),
    });
  });
  if (legs.length === 0) throw new Error("Strategy receipt has no leg outcomes.");
  return Object.freeze({
    receiptHash: hash(root.receiptHashHex, "Strategy receipt hash"),
    terminalState: text(receipt.terminalState, "Strategy receipt terminal state"),
    finalityStatus: text(receipt.finalityStatus, "Strategy receipt finality"),
    executedAtValue: decimalInteger(receipt.executedAtValue, "Strategy receipt execution time"),
    solverId: text(receipt.solverId, "Strategy receipt solver"),
    venueFees: parseReceiptAmount(receipt.venueFees, "Strategy receipt venue fees"),
    residualValue: parseReceiptAmount(receipt.terminalResidualValue, "Strategy receipt residual value"),
    legs: Object.freeze(legs),
  });
}

function hasTerminalStrategyReceipt(result: StrategyExecutionResult): boolean {
  return result.status === "RECONCILED"
    && (result.packageStatus === "NO_EFFECT" || result.packageStatus === "COMPLETED_EXACT" || result.packageStatus === "COMPLETED_BOUNDED");
}

function isFinalStrategyResult(result: StrategyExecutionResult): boolean {
  return hasTerminalStrategyReceipt(result)
    || result.status === "NOT_SUBMITTED"
    || result.status === "CHECKPOINT_INCOMPLETE"
    || result.status === "CHECKPOINT_FAILED";
}

function parseExecutionProgress(
  payload: unknown,
  attemptId: string,
  idempotencyKey: string,
): Readonly<{ progress: StrategyExecutionProgress; result: StrategyExecutionResult | null }> {
  const root = record(payload, "Strategy execution progress");
  if (root.attemptId !== attemptId || root.idempotencyKey !== idempotencyKey) {
    throw new Error("Strategy execution progress does not bind the selected attempt.");
  }
  const lane = root.lane === null || root.lane === undefined ? null : text(root.lane, "Strategy execution lane");
  if (root.state === "COMPLETED") {
    return Object.freeze({
      progress: Object.freeze({ state: "COMPLETED", lane, queuePosition: null }),
      result: parseExecutionResult(root.result, attemptId, idempotencyKey),
    });
  }
  if (root.state === "QUEUED") {
    const queuePosition = unsignedInteger(root.queuePosition, "Strategy execution queue position");
    return Object.freeze({
      progress: Object.freeze({ state: "QUEUED", lane, queuePosition }),
      result: null,
    });
  }
  if (root.state !== "NOT_STARTED" && root.state !== "EXECUTING" && root.state !== "UNCERTAIN") {
    throw new Error("Strategy execution progress state is invalid.");
  }
  return Object.freeze({
    progress: Object.freeze({ state: root.state, lane, queuePosition: null }),
    result: null,
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
  sourceOrderHash = null,
  strategyOwner = null,
  signStrategyOrder,
}: {
  privateApiBaseUrl: string | null;
  publicApiBaseUrl: string | null;
  templateId: string;
  lifecycleAction: string;
  sourceOrderHash?: string | null;
  strategyOwner?: string | null;
  signStrategyOrder?: (challenge: StrategyOrderAuthorizationChallenge) => Promise<string>;
}) {
  const [orderHash, setOrderHash] = useState("");
  const [staged, setStaged] = useState<StagedStrategyOrder | null>(null);
  const [quoteRequestKey, setQuoteRequestKey] = useState("");
  const [quoteReview, setQuoteReview] = useState<PackageQuoteReview | null>(null);
  const [quoteHash, setQuoteHash] = useState("");
  const [review, setReview] = useState<StrategyPreparationReview | null>(null);
  const [executionAttempt, setExecutionAttempt] = useState<SelectedStrategyExecution | null>(null);
  const [authorizedOrderHash, setAuthorizedOrderHash] = useState<string | null>(null);
  const [selectionKey, setSelectionKey] = useState("");
  const [executionKey, setExecutionKey] = useState("");
  const [executionResult, setExecutionResult] = useState<StrategyExecutionResult | null>(null);
  const [executionProgress, setExecutionProgress] = useState<StrategyExecutionProgress | null>(null);
  const [strategyReceipt, setStrategyReceipt] = useState<StrategyReceiptSummary | null>(null);
  const [admissions, setAdmissions] = useState<readonly AdmissionSummary[]>([]);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [nativeProfiles, setNativeProfiles] = useState<readonly NativeStrategyProfile[] | null>(null);
  const [nativeProfileError, setNativeProfileError] = useState<string | null>(null);
  const [selectedNativeProfileId, setSelectedNativeProfileId] = useState("");
  const [nativeQuantity, setNativeQuantity] = useState("");
  const [nativeEconomicQuantity, setNativeEconomicQuantity] = useState("");
  const [nativeLimitPrices, setNativeLimitPrices] = useState<Record<string, string>>({});
  const [expectedStrategyStateHash, setExpectedStrategyStateHash] = useState("");
  const [createdNativeOrder, setCreatedNativeOrder] = useState<CreatedNativeStrategyOrder | null>(null);
  const [nativeCreateBusy, setNativeCreateBusy] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
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

  useEffect(() => {
    if (privateApiBaseUrl === null || sourceOrderHash !== null || !NATIVE_HYPERCORE_TEMPLATES.has(templateId)) {
      return;
    }
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/strategy-order-profiles`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseNativeStrategyProfiles(await response.json());
    }).then((profiles) => {
      setNativeProfiles(profiles);
      setNativeProfileError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setNativeProfiles([]);
      setNativeProfileError(cause instanceof Error ? cause.message : "Native strategy profiles are unavailable.");
    });
    return () => controller.abort();
  }, [privateApiBaseUrl, sourceOrderHash, templateId]);

  const matchingAdmissions = admissions.filter((admission) => admission.templateId === templateId && admission.lifecycleAction === lifecycleAction);
  const matchingNativeProfiles = (nativeProfiles ?? []).filter((profile) => profile.templateId === templateId);
  const selectedNativeProfile = matchingNativeProfiles.find((profile) => profile.profileId === selectedNativeProfileId)
    ?? matchingNativeProfiles[0]
    ?? null;

  async function createNativeStrategyOrder() {
    if (privateApiBaseUrl === null || selectedNativeProfile === null) return;
    setNativeCreateBusy(true);
    setError(null);
    try {
      if (strategyOwner === null || !OWNER.test(strategyOwner)) {
        throw new Error("Connect the EVM wallet that will own and authorize this strategy.");
      }
      if (lifecycleAction !== "ENTRY" && lifecycleAction !== "EXIT") {
        throw new Error("This native strategy profile supports entry and exit only.");
      }
      const quantityAtoms = amountToAtoms(
        nativeQuantity,
        selectedNativeProfile.baseAsset.decimals,
        "Package quantity",
      );
      const economicQuantityAtoms = selectedNativeProfile.templateId === "perpetual-funding-spread-v1"
        ? quantityAtoms
        : amountToAtoms(
          nativeEconomicQuantity,
          selectedNativeProfile.baseAsset.decimals,
          "Inventory exposure",
        );
      const limitPrices = selectedNativeProfile.markets.map((market) => ({
        legId: market.role,
        ...priceToAtomicRatio(
          nativeLimitPrices[market.role] ?? "",
          selectedNativeProfile.baseAsset.decimals,
          selectedNativeProfile.quoteAsset.decimals,
          market.maximumPriceDecimals,
          `${market.coin} limit price`,
        ),
      }));
      const ttlMs = BigInt(selectedNativeProfile.bounds.maximumExpiryTtlMs) < BigInt(60_000)
        ? BigInt(selectedNativeProfile.bounds.maximumExpiryTtlMs)
        : BigInt(60_000);
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-orders/create`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedNativeProfile.profileId,
          owner: strategyOwner,
          lifecycleAction,
          quantityAtoms: quantityAtoms.toString(),
          economicQuantityAtoms: economicQuantityAtoms.toString(),
          limitPrices,
          expiryValue: (unixTimeMs() + ttlMs).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "EXIT" ? { expectedStrategyStateHash } : {}),
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const created = parseCreatedNativeStrategyOrder(await response.json(), {
        profileId: selectedNativeProfile.profileId,
        templateId,
        lifecycleAction,
      });
      setCreatedNativeOrder(created);
      setStaged(null);
      setOrderHash(created.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setExecutionAttempt(null);
      setAuthorizedOrderHash(null);
      setSelectionKey("");
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Native strategy order creation failed closed.");
    } finally {
      setNativeCreateBusy(false);
    }
  }

  async function stageStrategyOrder() {
    if (privateApiBaseUrl === null || sourceOrderHash === null || !HASH.test(sourceOrderHash)) return;
    setStageBusy(true);
    setError(null);
    try {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-orders/stage`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceOrderHash }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const result = parseStagedStrategyOrder(await response.json(), sourceOrderHash);
      setStaged(result);
      setOrderHash(result.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setExecutionAttempt(null);
      setAuthorizedOrderHash(null);
      setSelectionKey("");
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy order staging failed closed.");
    } finally {
      setStageBusy(false);
    }
  }

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
      setExecutionAttempt(null);
      setAuthorizedOrderHash(null);
      setSelectionKey("");
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
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
      setExecutionAttempt(null);
      setAuthorizedOrderHash(null);
      setSelectionKey("");
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy preparation failed closed.");
    } finally {
      setPrepareBusy(false);
    }
  }

  async function authorizeStrategyOrder() {
    if (privateApiBaseUrl === null || review === null) return;
    setAuthorizationBusy(true);
    setError(null);
    try {
      if (signStrategyOrder === undefined) throw new Error("Connect the strategy owner wallet before authorization.");
      const challengeResponse = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-orders/authorization`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderHash: review.orderHash }),
      });
      if (!challengeResponse.ok) throw new Error(await failureMessage(challengeResponse));
      const challenge = parseStrategyOrderAuthorization(await challengeResponse.json(), review.orderHash);
      const signature = await signStrategyOrder(challenge);
      const authorizationResponse = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-orders/authorize`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderHash: review.orderHash, signature }),
      });
      if (!authorizationResponse.ok) throw new Error(await failureMessage(authorizationResponse));
      parseAuthorizedStrategyOrder(await authorizationResponse.json(), challenge);
      setAuthorizedOrderHash(review.orderHash);
      setExecutionAttempt(null);
      setSelectionKey("");
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy order authorization failed closed.");
    } finally {
      setAuthorizationBusy(false);
    }
  }

  async function selectExecution() {
    if (privateApiBaseUrl === null || review === null || authorizedOrderHash !== review.orderHash) return;
    setSelectionBusy(true);
    setError(null);
    const idempotencyKey = selectionKey || crypto.randomUUID();
    if (selectionKey === "") setSelectionKey(idempotencyKey);
    try {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/select`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderHash: review.orderHash,
          quoteHash: review.quoteHash,
          routeHash: review.routeHash,
          ...(sourceOrderHash === null ? {} : { sourceOrderHash }),
          idempotencyKey,
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      setExecutionAttempt(parseSelectedExecution(await response.json(), {
        orderHash: review.orderHash,
        quoteHash: review.quoteHash,
        routeHash: review.routeHash,
        sourceOrderHash,
      }));
      setExecutionKey("");
      setExecutionResult(null);
      setExecutionProgress(null);
      setStrategyReceipt(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy execution selection failed closed.");
    } finally {
      setSelectionBusy(false);
    }
  }

  async function executeStrategy() {
    if (privateApiBaseUrl === null || executionAttempt === null) return;
    setExecutionBusy(true);
    setError(null);
    const idempotencyKey = executionKey || `strategy-exec-${executionAttempt.attemptId.slice(-40)}`;
    if (executionKey === "") setExecutionKey(idempotencyKey);
    let handoffStarted = false;
    try {
      handoffStarted = true;
      setExecutionProgress(Object.freeze({ state: "EXECUTING", lane: null, queuePosition: null }));
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/hyperliquid-testnet/execute`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: executionAttempt.attemptId, idempotencyKey }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const result = parseExecutionResult(await response.json(), executionAttempt.attemptId, idempotencyKey);
      setExecutionResult(result);
      setExecutionProgress(Object.freeze({
        state: isFinalStrategyResult(result) ? "COMPLETED" : "UNCERTAIN",
        lane: null,
        queuePosition: null,
      }));
      if (hasTerminalStrategyReceipt(result) && publicApiBaseUrl !== null) {
        const receiptResponse = await fetch(`${publicApiBaseUrl}/v1/strategy-receipts/by-quote/${executionAttempt.quoteHash}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (!receiptResponse.ok) throw new Error("Execution finalized, but its canonical strategy receipt is unavailable.");
        setStrategyReceipt(parseStrategyReceipt(await receiptResponse.json(), executionAttempt.quoteHash));
      }
    } catch (cause) {
      if (handoffStarted) setExecutionProgress(Object.freeze({ state: "UNCERTAIN", lane: null, queuePosition: null }));
      setError(cause instanceof Error ? cause.message : "Strategy execution failed closed.");
    } finally {
      setExecutionBusy(false);
    }
  }

  async function refreshExecutionStatus() {
    if (privateApiBaseUrl === null || executionAttempt === null) return;
    setExecutionBusy(true);
    setError(null);
    const idempotencyKey = executionKey || `strategy-exec-${executionAttempt.attemptId.slice(-40)}`;
    if (executionKey === "") setExecutionKey(idempotencyKey);
    try {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/hyperliquid-testnet/attempt-status`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId: executionAttempt.attemptId, idempotencyKey }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const next = parseExecutionProgress(await response.json(), executionAttempt.attemptId, idempotencyKey);
      setExecutionProgress(next.progress);
      if (next.result !== null) {
        setExecutionResult(next.result);
        if (hasTerminalStrategyReceipt(next.result) && publicApiBaseUrl !== null) {
          const receiptResponse = await fetch(`${publicApiBaseUrl}/v1/strategy-receipts/by-quote/${executionAttempt.quoteHash}`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (!receiptResponse.ok) throw new Error("Execution finalized, but its canonical strategy receipt is unavailable.");
          setStrategyReceipt(parseStrategyReceipt(await receiptResponse.json(), executionAttempt.quoteHash));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Strategy execution status failed closed.");
    } finally {
      setExecutionBusy(false);
    }
  }

  const nativeOrderFieldsReady = selectedNativeProfile !== null
    && strategyOwner !== null
    && OWNER.test(strategyOwner)
    && nativeQuantity.trim() !== ""
    && (selectedNativeProfile.templateId === "perpetual-funding-spread-v1"
      || nativeEconomicQuantity.trim() !== "")
    && selectedNativeProfile.markets.every((market) => (nativeLimitPrices[market.role] ?? "").trim() !== "")
    && (lifecycleAction !== "EXIT" || HASH.test(expectedStrategyStateHash));

  return (
    <section className={styles.executionReview} aria-labelledby="generalized-strategy-review-title">
      <div className={styles.evidenceHeading}>
        <h3 id="generalized-strategy-review-title">Package quote and execution</h3>
        <span>{review && authorizedOrderHash === review.orderHash ? "OWNER AUTHORIZED" : review ? "UNSIGNED PLAN" : quoteReview ? "SIGNED QUOTE" : "QUOTE REQUIRED"}</span>
      </div>
      <p className={styles.reviewNotice}>
        Request a live solver-signed quote for a stored typed order, inspect its complete-package economics, then compile the admitted route into an unsigned execution plan.
      </p>
      {sourceOrderHash !== null ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="generalized-strategy-source">Selected canonical order</label>
          <input id="generalized-strategy-source" value={sourceOrderHash} readOnly spellCheck={false} />
          <button type="button" className={styles.primaryAction} disabled={privateApiBaseUrl === null || stageBusy || !HASH.test(sourceOrderHash)} onClick={() => void stageStrategyOrder()}>
            {stageBusy ? "Staging typed strategy order" : staged?.sourceOrderHash === sourceOrderHash ? "Restage typed strategy order" : "Stage typed strategy order"}
          </button>
          {staged ? <p className={styles.fieldContext}>Graph {compact(staged.graphHash)} is stored for solver quoting.</p> : null}
        </div>
      ) : null}
      {sourceOrderHash === null && NATIVE_HYPERCORE_TEMPLATES.has(templateId) ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="native-strategy-profile">HyperCore strategy market</label>
          <select
            id="native-strategy-profile"
            value={selectedNativeProfile?.profileId ?? ""}
            disabled={nativeProfiles === null || matchingNativeProfiles.length === 0}
            onChange={(event) => {
              setSelectedNativeProfileId(event.target.value);
              setNativeQuantity("");
              setNativeEconomicQuantity("");
              setExpectedStrategyStateHash("");
              setCreatedNativeOrder(null);
              setOrderHash("");
              setError(null);
            }}
          >
            {matchingNativeProfiles.length === 0 ? <option value="">No reviewed market is active</option> : null}
            {matchingNativeProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>
            ))}
          </select>
          {selectedNativeProfile ? (
            <>
              <label htmlFor="native-strategy-quantity">Package quantity</label>
              <input
                id="native-strategy-quantity"
                value={nativeQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => {
                  setNativeQuantity(event.target.value.trim());
                  setCreatedNativeOrder(null);
                  setError(null);
                }}
              />
              <p className={styles.fieldContext}>
                Reviewed range {formatAtomicAmount(
                  selectedNativeProfile.bounds.minimumQuantityAtoms,
                  selectedNativeProfile.baseAsset.decimals,
                  selectedNativeProfile.markets[0]?.coin ?? selectedNativeProfile.baseAsset.assetId,
                )} to {formatAtomicAmount(
                  selectedNativeProfile.bounds.maximumQuantityAtoms,
                  selectedNativeProfile.baseAsset.decimals,
                  selectedNativeProfile.markets[0]?.coin ?? selectedNativeProfile.baseAsset.assetId,
                )}.
              </p>
              {selectedNativeProfile.templateId === "treasury-inventory-hedge-v1" ? (
                <>
                  <label htmlFor="native-strategy-economic-quantity">Inventory exposure to hedge</label>
                  <input
                    id="native-strategy-economic-quantity"
                    value={nativeEconomicQuantity}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    onChange={(event) => {
                      setNativeEconomicQuantity(event.target.value.trim());
                      setCreatedNativeOrder(null);
                      setError(null);
                    }}
                  />
                </>
              ) : null}
              {selectedNativeProfile.markets.map((market) => (
                <Fragment key={market.role}>
                  <label htmlFor={`native-strategy-price-${market.role}`}>
                    {market.coin} {lifecycleAction === "ENTRY" ? market.entrySide : market.entrySide === "BUY" ? "SELL" : "BUY"} limit price
                  </label>
                  <input
                    id={`native-strategy-price-${market.role}`}
                    value={nativeLimitPrices[market.role] ?? ""}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={`Price in ${selectedNativeProfile.quoteAsset.assetId.split(":").at(-1)?.toUpperCase() ?? "quote asset"}`}
                    onChange={(event) => {
                      setNativeLimitPrices((current) => ({ ...current, [market.role]: event.target.value.trim() }));
                      setCreatedNativeOrder(null);
                      setError(null);
                    }}
                  />
                </Fragment>
              ))}
              {lifecycleAction === "EXIT" ? (
                <>
                  <label htmlFor="native-strategy-state-hash">Expected open strategy state</label>
                  <input
                    id="native-strategy-state-hash"
                    value={expectedStrategyStateHash}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="64 lowercase hex characters"
                    onChange={(event) => {
                      setExpectedStrategyStateHash(event.target.value.trim());
                      setCreatedNativeOrder(null);
                      setError(null);
                    }}
                  />
                </>
              ) : null}
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || nativeCreateBusy || !nativeOrderFieldsReady}
                onClick={() => void createNativeStrategyOrder()}
              >
                {nativeCreateBusy ? "Creating typed strategy order" : createdNativeOrder ? "Recreate typed strategy order" : "Create typed strategy order"}
              </button>
              <p className={styles.fieldContext} role="status">
                {createdNativeOrder
                  ? `Graph ${compact(createdNativeOrder.graphHash)} is stored for solver quoting.`
                  : strategyOwner === null
                    ? "Connect the EVM wallet that will own this package."
                    : `Settlement uses ${selectedNativeProfile.settlementAccount} on HyperCore Testnet.`}
              </p>
            </>
          ) : (
            <p className={styles.fieldContext} role="status">
              {nativeProfiles === null ? "Loading reviewed HyperCore markets." : nativeProfileError ?? "No reviewed HyperCore market matches this strategy."}
            </p>
          )}
        </div>
      ) : null}
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
            setExecutionAttempt(null);
            setAuthorizedOrderHash(null);
            setSelectionKey("");
            setExecutionKey("");
            setExecutionResult(null);
            setExecutionProgress(null);
            setStrategyReceipt(null);
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
                setExecutionAttempt(null);
                setAuthorizedOrderHash(null);
                setSelectionKey("");
                setExecutionKey("");
                setExecutionResult(null);
                setExecutionProgress(null);
                setStrategyReceipt(null);
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
            setExecutionAttempt(null);
            setAuthorizedOrderHash(null);
            setSelectionKey("");
            setExecutionKey("");
            setExecutionResult(null);
            setExecutionProgress(null);
            setStrategyReceipt(null);
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
          <button
            type="button"
            className={styles.primaryAction}
            disabled={privateApiBaseUrl === null || authorizationBusy || authorizedOrderHash === review.orderHash}
            onClick={() => void authorizeStrategyOrder()}
          >
            {authorizationBusy ? "Confirming strategy authorization" : authorizedOrderHash === review.orderHash ? "Strategy order authorized" : "Authorize exact strategy order"}
          </button>
          <button
            type="button"
            className={styles.primaryAction}
            disabled={privateApiBaseUrl === null || selectionBusy || authorizedOrderHash !== review.orderHash}
            onClick={() => void selectExecution()}
          >
            {selectionBusy ? "Selecting package execution" : executionAttempt ? "Package execution selected" : "Select package execution"}
          </button>
          {executionAttempt ? (
            <>
              <p className={styles.fieldContext} role="status">
                Attempt {compact(executionAttempt.attemptId)} durably binds every reviewed commitment. Nothing has been submitted.
              </p>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || executionBusy || executionResult !== null || executionProgress !== null}
                onClick={() => void executeStrategy()}
              >
                {executionBusy ? "Executing package" : executionResult ? "Package execution recorded" : executionProgress ? "Execution handoff started" : "Execute selected package"}
              </button>
              {executionResult ? (
                <p className={styles.fieldContext} role="status">
                  {executionResult.status}{executionResult.packageStatus ? ` / ${executionResult.packageStatus}` : ""}
                  {executionResult.reasons.length > 0 ? `: ${executionResult.reasons.join(", ")}` : ""}
                </p>
              ) : null}
              {executionProgress && executionProgress.state !== "COMPLETED" ? (
                <p className={styles.fieldContext} role="status">
                  {executionProgress.state === "QUEUED"
                    ? `Queued at position ${executionProgress.queuePosition ?? 0}${executionProgress.lane ? ` on ${executionProgress.lane}` : ""}.`
                    : `${executionProgress.state.replaceAll("_", " ").toLowerCase()}${executionProgress.lane ? ` on ${executionProgress.lane}` : ""}.`}
                </p>
              ) : null}
              {executionProgress && executionProgress.state !== "COMPLETED"
                && (executionResult === null || !isFinalStrategyResult(executionResult)) ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={privateApiBaseUrl === null || executionBusy}
                  onClick={() => void refreshExecutionStatus()}
                >
                  {executionBusy ? "Refreshing execution evidence" : "Refresh durable execution status"}
                </button>
              ) : null}
              {strategyReceipt ? (
                <div className={styles.quoteReview}>
                  <div className={styles.reviewEconomics}>
                    <div><span>Venue fees</span><strong>{formatAtomicAmount(strategyReceipt.venueFees.atoms, strategyReceipt.venueFees.decimals, strategyReceipt.venueFees.assetId)}</strong></div>
                    <div><span>Terminal residual</span><strong>{formatAtomicAmount(strategyReceipt.residualValue.atoms, strategyReceipt.residualValue.decimals, strategyReceipt.residualValue.assetId)}</strong></div>
                  </div>
                  <div className={styles.reviewGrid}>
                    <span>Terminal state</span><strong>{strategyReceipt.terminalState}</strong>
                    <span>Finality</span><strong>{strategyReceipt.finalityStatus}</strong>
                    <span>Solver</span><strong>{strategyReceipt.solverId}</strong>
                    <span>Receipt</span><strong title={strategyReceipt.receiptHash}>{compact(strategyReceipt.receiptHash)}</strong>
                    <span>Executed at</span><strong>{strategyReceipt.executedAtValue}</strong>
                  </div>
                  {strategyReceipt.legs.map((leg) => (
                    <div className={styles.reviewGrid} key={leg.legId}>
                      <span>{leg.legId}</span><strong>{leg.status}</strong>
                      <span>Settled</span><strong>{formatAtomicAmount(leg.settled.atoms, leg.settled.decimals, leg.settled.assetId)}</strong>
                      <span>Venue fee</span><strong>{formatAtomicAmount(leg.venueFee.atoms, leg.venueFee.decimals, leg.venueFee.assetId)}</strong>
                      <span>Evidence</span><strong title={leg.evidenceHash}>{leg.evidenceGrade} / {compact(leg.evidenceHash)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          <p className={styles.reviewNotice}>
            {executionResult
              ? "The testnet executor independently revalidated the selected package before submission."
              : authorizedOrderHash === review.orderHash
                ? "The owner authorized this exact strategy hash. Selection and testnet execution remain separate fail-closed steps."
                : "This remains an unsigned review until the owner authorizes the exact strategy hash."}
          </p>
        </>
      ) : null}
    </section>
  );
}

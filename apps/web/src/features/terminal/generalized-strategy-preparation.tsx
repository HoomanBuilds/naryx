"use client";

import { Fragment, useEffect, useState } from "react";
import { formatAtomicAmount, formatMetricValue } from "./format";
import {
  buildSolanaWalletTransaction,
  getSolanaDevnetBlockhash,
  getSolanaDevnetSlot,
  waitForSolanaDevnetFinality,
  type SolanaWalletInstructionBatch,
} from "./solana-devnet-onboarding";
import type { DomainId } from "./terminal-view-model";
import styles from "./trading-terminal.module.css";

const HASH = /^[0-9a-f]{64}$/;
const OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const EVM_ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/i;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const SOLANA_PACKET_LIMIT = 1232;
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
  "hedge-migration-v1",
  "delta-neutral-rebalance-v1",
]);
const EVM_STRATEGY_TEMPLATES = new Set([
  "calendar-spread-v1",
  "option-spread-v1",
  "treasury-inventory-hedge-v1",
  "collateral-conversion-hedge-v1",
  "reverse-cash-and-carry-v1",
]);
const EVM_CHAIN_IDS: Readonly<Partial<Record<DomainId, number>>> = Object.freeze({
  base: 84_532,
  arbitrum: 421_614,
});
const TEST_DOMAIN_IDS: Readonly<Record<DomainId, string>> = Object.freeze({
  solana: "svm:devnet",
  base: "eip155:84532",
  arbitrum: "eip155:421614",
  hyperliquid: "hypercore:testnet",
});

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
  evmAuthorization: Readonly<{
    chainId: number;
    account: string;
    ownerTypedData: unknown;
  }> | null;
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
  venueId: string;
  marketId: string;
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

type SolanaTreasuryHedgeProfile = Readonly<{
  profileId: string;
  displayName: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  domainId: "svm:devnet";
  multiStrategyProgramId: string;
  inventoryAsset: Readonly<{ assetId: string; decimals: number }>;
  quoteAsset: Readonly<{ assetId: string; decimals: number }>;
  bounds: Readonly<{
    minimumQuantityAtoms: string;
    maximumQuantityAtoms: string;
    maximumExpiryTtlSlots: string;
  }>;
}>;

type SolanaStrategyPositionReview = Readonly<{
  packageId: string;
  owner: string;
  domainId: string;
  settlementAccount: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  baseAssetId: string;
  baseAssetDecimals: number;
  economicQuantityAtoms: string;
  stateHash: string;
  status: "OPEN" | "CLOSED";
}>;

type SolanaProvisioningPlan = Readonly<{
  owner: string;
  packageId: string;
  strategyAccount: string;
  ready: boolean;
  inventoryFundingRequiredAtoms: string;
  quoteFundingRequiredAtoms: string;
  steps: readonly Readonly<{
    kind: string;
    label: string;
    instructions: SolanaWalletInstructionBatch["instructions"];
  }>[];
}>;

type AuthorizedSolanaExecution = Readonly<{
  transactionBytes: Uint8Array;
  owner: string;
  solver: string;
  strategyAccount: string;
  quoteHash: string;
  lastValidBlockHeight: number;
}>;

type SolanaExecutionObservation = Readonly<
  | { status: "PENDING" | "FAILED"; signature: string }
  | {
      status: "FINALIZED";
      signature: string;
      slot: string;
      strategyAccount: string;
      position: string;
      receiptAccount: string;
      packageId: string;
      operation: string;
      previousStateHash: string;
      nextStateHash: string;
      evidenceRoot: string;
      onchainReceiptHash: string;
      solver: string;
      nonce: string;
      receipt: StrategyReceiptSummary;
    }
>;

type NativeStrategyPositionReview = Readonly<{
  strategyId: string;
  owner: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  settlementAccount: string;
  economicQuantityAtoms: string;
  stateHash: string;
  status: "OPEN" | "EXITING" | "CLOSED" | "UNRESOLVED";
  legs: readonly Readonly<{
    legId: string;
    underlyingId: string;
    instrumentId: string;
    venueId: string;
    signedQuantityAtoms: string;
  }>[];
}>;

type CreatedNativeStrategyOrder = Readonly<{
  profileId: string;
  orderHash: string;
  graphHash: string;
}>;

type EvmOptionProfile = Readonly<{
  profileId: string;
  displayName: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  chainId: number;
  domainId: string;
  accountFactory: string;
  baseAsset: Readonly<{ assetId: string; decimals: number }>;
  quoteAsset: Readonly<{ assetId: string; decimals: number }>;
  markets: readonly Readonly<{ role: "option-long" | "option-short"; strike: string; maturity: string }>[];
  bounds: Readonly<{
    minimumQuantityAtoms: string;
    maximumQuantityAtoms: string;
    maximumExpiryTtlSeconds: string;
  }>;
}>;

type EvmCalendarProfile = Readonly<{
  profileId: string;
  displayName: string;
  templateId: "calendar-spread-v1";
  seriesId: string;
  executionClassId: string;
  chainId: number;
  domainId: string;
  accountFactory: string;
  baseAsset: Readonly<{ assetId: string; decimals: number }>;
  quoteAsset: Readonly<{ assetId: string; decimals: number }>;
  markets: readonly Readonly<{ role: "near-future" | "far-future"; maturity: string }>[];
  bounds: Readonly<{
    minimumQuantityAtoms: string;
    maximumQuantityAtoms: string;
    maximumExpiryTtlSeconds: string;
  }>;
}>;

type EvmDirectionalProfile = Readonly<{
  kind: "TREASURY_HEDGE" | "COLLATERAL_CONVERSION" | "REVERSE_BASIS";
  profileId: string;
  displayName: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  chainId: number;
  domainId: string;
  accountFactory: string;
  baseAsset: Readonly<{ assetId: string; decimals: number }>;
  quoteAsset: Readonly<{ assetId: string; decimals: number }>;
  bounds: Readonly<{
    minimumQuantityAtoms: string;
    maximumQuantityAtoms: string;
    maximumExpiryTtlSeconds: string;
  }>;
}>;

type EvmStrategyPositionReview = Readonly<{
  packageId: string;
  owner: string;
  chainId: number;
  domainId: string;
  settlementAccount: string;
  templateId: string;
  seriesId: string;
  executionClassId: string;
  baseAssetId: string;
  baseAssetDecimals: number;
  economicQuantityAtoms: string;
  stateHash: string;
  status: "OPEN" | "CLOSED";
}>;

type EvmProvisioningTransaction = Readonly<{
  kind: "CREATE_STRATEGY_ACCOUNT" | "CREATE_PACKAGE_ADAPTER";
  to: string;
  data: string;
  value: "0";
  expectedAddress: string;
}>;

type EvmProvisioningPlan = Readonly<{
  chainId: number;
  owner: string;
  strategyAccount: string;
  ready: boolean;
  transactions: readonly EvmProvisioningTransaction[];
}>;

type EvmCollateralTransaction = Readonly<{
  kind: "RESET_COLLATERAL_ALLOWANCE" | "APPROVE_COLLATERAL" | "MANAGE_PACKAGE_COLLATERAL";
  to: string;
  data: string;
  value: "0";
}>;

type EvmCollateralPlan = Readonly<{
  chainId: number;
  owner: string;
  strategyAccount: string;
  quoteHash: string;
  action: "SUPPLY" | "WITHDRAW";
  assetToken: string;
  minimumOutputAtoms: string;
  maximumOutputAtoms: string;
  transactions: readonly EvmCollateralTransaction[];
}>;

type AuthorizedEvmExecution = Readonly<{
  chainId: number;
  to: string;
  data: string;
  value: "0";
  quoteHash: string;
  expectedNextStateHash: string;
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

function bytes32(value: unknown, context: string): string {
  const result = text(value, context);
  if (!HASH.test(result)) throw new Error(`${context} is invalid.`);
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

function solanaAddress(value: unknown, context: string): string {
  const result = text(value, context);
  if (!SOLANA_ADDRESS.test(result)) throw new Error(`${context} is invalid.`);
  return result;
}

function base64Bytes(value: unknown, context: string): Uint8Array {
  const encoded = text(value, context);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`${context} is invalid.`);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error(`${context} is invalid.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (btoa(binary) !== encoded) throw new Error(`${context} is not canonical base64.`);
  return bytes;
}

function parseSolanaTreasuryHedgeProfiles(payload: unknown): readonly SolanaTreasuryHedgeProfile[] {
  const root = record(decode(payload as Json), "Solana treasury hedge profiles");
  if (root.version !== 1) throw new Error("Solana treasury hedge profile version is unsupported.");
  return list(root.profiles, "Solana treasury hedge profiles").map((candidate, index) => {
    const profile = record(candidate, `Solana treasury hedge profile ${index}`);
    const inventoryAsset = record(profile.inventoryAsset, `Solana treasury hedge profile ${index} inventory asset`);
    const quoteAsset = record(profile.quoteAsset, `Solana treasury hedge profile ${index} quote asset`);
    const bounds = record(profile.bounds, `Solana treasury hedge profile ${index} bounds`);
    const domainId = text(profile.domainId, `Solana treasury hedge profile ${index} domain`);
    if (domainId !== "svm:devnet") throw new Error(`Solana treasury hedge profile ${index} is not Devnet.`);
    return Object.freeze({
      profileId: text(profile.profileId, `Solana treasury hedge profile ${index} id`),
      displayName: text(profile.displayName, `Solana treasury hedge profile ${index} display name`),
      templateId: text(profile.templateId, `Solana treasury hedge profile ${index} template`),
      seriesId: text(profile.seriesId, `Solana treasury hedge profile ${index} series`),
      executionClassId: text(profile.executionClassId, `Solana treasury hedge profile ${index} execution class`),
      domainId,
      multiStrategyProgramId: solanaAddress(profile.multiStrategyProgramId, `Solana treasury hedge profile ${index} program`),
      inventoryAsset: Object.freeze({
        assetId: text(inventoryAsset.assetId, `Solana treasury hedge profile ${index} inventory asset id`),
        decimals: unsignedInteger(inventoryAsset.decimals, `Solana treasury hedge profile ${index} inventory decimals`),
      }),
      quoteAsset: Object.freeze({
        assetId: text(quoteAsset.assetId, `Solana treasury hedge profile ${index} quote asset id`),
        decimals: unsignedInteger(quoteAsset.decimals, `Solana treasury hedge profile ${index} quote decimals`),
      }),
      bounds: Object.freeze({
        minimumQuantityAtoms: decimalInteger(bounds.minimumQuantityAtoms, `Solana treasury hedge profile ${index} minimum quantity`),
        maximumQuantityAtoms: decimalInteger(bounds.maximumQuantityAtoms, `Solana treasury hedge profile ${index} maximum quantity`),
        maximumExpiryTtlSlots: decimalInteger(bounds.maximumExpiryTtlSlots, `Solana treasury hedge profile ${index} expiry TTL`),
      }),
    });
  });
}

function parseSolanaStrategyPositions(
  payload: unknown,
  requestedOwner: string,
): readonly SolanaStrategyPositionReview[] {
  const root = record(decode(payload as Json), "Solana strategy positions");
  if (root.version !== 1 || root.owner !== requestedOwner) {
    throw new Error("Solana strategy positions do not bind the connected owner.");
  }
  return list(root.positions, "Solana strategy positions").map((candidate, index) => {
    const position = record(candidate, `Solana strategy position ${index}`);
    const status = text(position.status, `Solana strategy position ${index} status`);
    if (status !== "OPEN" && status !== "CLOSED") {
      throw new Error(`Solana strategy position ${index} status is invalid.`);
    }
    const owner = solanaAddress(position.owner, `Solana strategy position ${index} owner`);
    const settlementAccount = solanaAddress(
      position.settlementAccount,
      `Solana strategy position ${index} account`,
    );
    if (owner !== requestedOwner) throw new Error(`Solana strategy position ${index} owner is invalid.`);
    return Object.freeze({
      packageId: hash(position.packageIdHex, `Solana strategy position ${index} package`),
      owner,
      domainId: text(position.domainId, `Solana strategy position ${index} domain`),
      settlementAccount,
      templateId: text(position.templateId, `Solana strategy position ${index} template`),
      seriesId: text(position.seriesId, `Solana strategy position ${index} series`),
      executionClassId: text(position.executionClassId, `Solana strategy position ${index} execution class`),
      baseAssetId: text(position.baseAssetId, `Solana strategy position ${index} base asset`),
      baseAssetDecimals: unsignedInteger(
        position.baseAssetDecimals,
        `Solana strategy position ${index} base decimals`,
      ),
      economicQuantityAtoms: decimalInteger(
        position.economicQuantityAtoms,
        `Solana strategy position ${index} quantity`,
      ),
      stateHash: hash(position.stateHashHex, `Solana strategy position ${index} state hash`),
      status,
    });
  });
}

function parseCreatedSolanaTreasuryHedgeOrder(
  payload: unknown,
  profileId: string,
  lifecycleAction: string,
): Readonly<{ orderHash: string; graphHash: string }> {
  const root = record(payload, "Solana treasury hedge order creation");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || root.profileId !== profileId
    || root.templateId !== "treasury-inventory-hedge-v1" || root.lifecycleAction !== lifecycleAction) {
    throw new Error("Solana treasury hedge order creation changed the requested package.");
  }
  solanaAddress(root.settlementAccount, "Solana strategy account");
  return Object.freeze({
    orderHash: hash(root.orderHash, "Solana treasury hedge order hash"),
    graphHash: hash(root.graphHash, "Solana treasury hedge graph hash"),
  });
}

function parseSolanaProvisioning(
  payload: unknown,
  expectedPackageId: string,
  expectedOwner: string,
): SolanaProvisioningPlan {
  const root = record(decode(payload as Json), "Solana provisioning response");
  const status = text(root.status, "Solana provisioning status");
  if (root.version !== 1 || (status !== "READY" && status !== "FUNDING_REQUIRED"
    && status !== "WALLET_TRANSACTIONS_REQUIRED")) {
    throw new Error("Solana provisioning response is invalid.");
  }
  const plan = record(root.provisioning, "Solana provisioning plan");
  const owner = solanaAddress(plan.owner, "Solana provisioning owner");
  const packageId = hash(plan.packageId, "Solana provisioning package");
  const strategyAccount = solanaAddress(plan.strategyAccount, "Solana strategy account");
  const inventoryFundingRequiredAtoms = decimalInteger(plan.inventoryFundingRequiredAtoms, "Inventory funding requirement");
  const quoteFundingRequiredAtoms = decimalInteger(plan.quoteFundingRequiredAtoms, "Quote funding requirement");
  if (plan.version !== 1 || plan.domainId !== "svm:devnet" || owner !== expectedOwner
    || packageId !== expectedPackageId || typeof plan.ready !== "boolean"
    || BigInt(inventoryFundingRequiredAtoms) < BigInt(0) || BigInt(quoteFundingRequiredAtoms) < BigInt(0)) {
    throw new Error("Solana provisioning plan changed the selected package.");
  }
  const steps = list(plan.steps, "Solana provisioning steps").map((candidate, stepIndex) => {
    const step = record(candidate, `Solana provisioning step ${stepIndex}`);
    const instructions = list(step.instructions, `Solana provisioning step ${stepIndex} instructions`).map((raw, instructionIndex) => {
      const instruction = record(raw, `Solana provisioning instruction ${stepIndex}:${instructionIndex}`);
      const accounts = list(instruction.accounts, `Solana provisioning instruction ${stepIndex}:${instructionIndex} accounts`).map((rawAccount, accountIndex) => {
        const account = record(rawAccount, `Solana provisioning account ${stepIndex}:${instructionIndex}:${accountIndex}`);
        const pubkey = solanaAddress(account.pubkey, `Solana provisioning account ${stepIndex}:${instructionIndex}:${accountIndex}`);
        if (typeof account.isSigner !== "boolean" || typeof account.isWritable !== "boolean"
          || (account.isSigner && pubkey !== owner)) {
          throw new Error(`Solana provisioning account ${stepIndex}:${instructionIndex}:${accountIndex} is invalid.`);
        }
        return Object.freeze({ pubkey, isSigner: account.isSigner, isWritable: account.isWritable });
      });
      if (!accounts.some((account) => account.isSigner && account.pubkey === owner)) {
        throw new Error(`Solana provisioning instruction ${stepIndex}:${instructionIndex} is not owner-authorized.`);
      }
      return Object.freeze({
        programId: solanaAddress(instruction.programId, `Solana provisioning instruction ${stepIndex}:${instructionIndex} program`),
        accounts: Object.freeze(accounts),
        data: base64Bytes(instruction.dataBase64, `Solana provisioning instruction ${stepIndex}:${instructionIndex} data`),
      });
    });
    if (instructions.length === 0) throw new Error(`Solana provisioning step ${stepIndex} is empty.`);
    return Object.freeze({
      kind: text(step.kind, `Solana provisioning step ${stepIndex} kind`),
      label: text(step.label, `Solana provisioning step ${stepIndex} label`),
      instructions: Object.freeze(instructions),
    });
  });
  const inventoryFunding = BigInt(inventoryFundingRequiredAtoms);
  const quoteFunding = BigInt(quoteFundingRequiredAtoms);
  const ready = plan.ready;
  if (ready !== (steps.length === 0 && inventoryFunding === BigInt(0) && quoteFunding === BigInt(0))
    || status === "READY" !== ready
    || status === "FUNDING_REQUIRED" !== (!ready && (inventoryFunding > BigInt(0) || quoteFunding > BigInt(0)))) {
    throw new Error("Solana provisioning readiness is inconsistent.");
  }
  return Object.freeze({
    owner,
    packageId,
    strategyAccount,
    ready,
    inventoryFundingRequiredAtoms,
    quoteFundingRequiredAtoms,
    steps: Object.freeze(steps),
  });
}

function parseAuthorizedSolanaExecution(
  payload: unknown,
  expectedOwner: string,
  review: StrategyPreparationReview,
): AuthorizedSolanaExecution {
  const root = record(decode(payload as Json), "Solana strategy authorization");
  if (root.version !== 1 || root.status !== "OWNER_SIGNATURE_REQUIRED") {
    throw new Error("Solana strategy authorization is not ready for the owner wallet.");
  }
  const authorization = record(root.authorization, "Solana strategy authorization");
  const domain = record(authorization.domain, "Solana authorization domain");
  const owner = solanaAddress(authorization.owner, "Solana authorization owner");
  const solver = solanaAddress(authorization.solver, "Solana authorization solver");
  const transactionBytes = base64Bytes(authorization.transactionBase64, "Solana authorized transaction");
  const requiredSigners = list(authorization.requiredSignerPubkeys, "Solana authorization signers")
    .map((value, index) => solanaAddress(value, `Solana authorization signer ${index}`));
  if (domain.domainId !== "svm:devnet" || owner !== expectedOwner || solver === owner
    || transactionBytes.length === 0 || transactionBytes.length > SOLANA_PACKET_LIMIT
    || requiredSigners.length !== 2 || new Set(requiredSigners).size !== 2
    || !requiredSigners.includes(owner) || !requiredSigners.includes(solver)
    || hash(authorization.packageId, "Solana authorization package") !== review.packageId
    || hash(authorization.orderHash, "Solana authorization order") !== review.orderHash
    || hash(authorization.quoteHash, "Solana authorization quote") !== review.quoteHash
    || hash(authorization.routeHash, "Solana authorization route") !== review.routeHash) {
    throw new Error("Solana strategy authorization changed the reviewed execution.");
  }
  const lastValidBlockHeight = integer(authorization.lastValidBlockHeight, "Solana authorization block height");
  return Object.freeze({
    transactionBytes,
    owner,
    solver,
    strategyAccount: solanaAddress(authorization.strategyAccount, "Solana authorization strategy account"),
    quoteHash: review.quoteHash,
    lastValidBlockHeight,
  });
}

function parseSolanaExecutionObservation(
  payload: unknown,
  expectedSignature: string,
  review: StrategyPreparationReview,
): SolanaExecutionObservation {
  const root = record(decode(payload as Json), "Solana execution observation");
  const observation = record(root.observation, "Solana execution observation result");
  const status = text(observation.status, "Solana observation status");
  const signature = text(observation.signature, "Solana observation signature");
  if (root.status !== status || observation.version !== 1 || signature !== expectedSignature
    || !SOLANA_SIGNATURE.test(signature)
    || (status !== "PENDING" && status !== "FAILED" && status !== "FINALIZED")) {
    throw new Error("Solana execution observation changed the submitted transaction.");
  }
  if (status !== "FINALIZED") return Object.freeze({ status, signature });
  const domain = record(observation.domain, "Solana observation domain");
  const packageId = hash(observation.packageId, "Solana observed package");
  const orderHash = hash(observation.orderHash, "Solana observed order");
  const quoteHash = hash(observation.quoteHash, "Solana observed quote");
  const routeHash = hash(observation.routeHash, "Solana observed route");
  if (domain.domainId !== "svm:devnet" || packageId !== review.packageId
    || orderHash !== review.orderHash || quoteHash !== review.quoteHash || routeHash !== review.routeHash) {
    throw new Error("Finalized Solana evidence changed the reviewed package commitments.");
  }
  const slot = decimalInteger(observation.slot, "Solana execution slot");
  const nonce = decimalInteger(observation.nonce, "Solana execution nonce");
  if (BigInt(slot) <= BigInt(0) || BigInt(nonce) < BigInt(0)) {
    throw new Error("Finalized Solana evidence has invalid chain coordinates.");
  }
  return Object.freeze({
    status: "FINALIZED",
    signature,
    slot,
    strategyAccount: solanaAddress(observation.strategyAccount, "Solana observed strategy account"),
    position: solanaAddress(observation.position, "Solana observed position"),
    receiptAccount: solanaAddress(observation.receiptAccount, "Solana observed receipt account"),
    packageId,
    operation: text(observation.operation, "Solana observed operation"),
    previousStateHash: bytes32(observation.previousStateHash, "Solana previous state"),
    nextStateHash: bytes32(observation.nextStateHash, "Solana next state"),
    evidenceRoot: hash(observation.evidenceRoot, "Solana evidence root"),
    onchainReceiptHash: hash(observation.onchainReceiptHash, "Solana onchain receipt"),
    solver: solanaAddress(observation.solver, "Solana observed solver"),
    nonce,
    receipt: parseStrategyReceipt({
      version: 1,
      quoteHash,
      receipt: observation.receipt,
    }, review.quoteHash),
  });
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
  const orderHash = hash(prepared.orderHash, "Order hash");
  const graphHash = hash(prepared.graphHash, "Graph hash");
  const routeHash = hash(prepared.routeHash, "Route hash");
  const identity = record(prepared.identity, "Strategy identity");
  const domains = list(prepared.domains, "Prepared domains").map((candidate, index): DomainReview => {
    const domainExecution = record(candidate, `Prepared domain ${index}`);
    const kind = text(domainExecution.kind, `Prepared domain ${index} kind`);
    if (!DOMAIN_KINDS.has(kind)) throw new Error(`Prepared domain ${index} kind is unsupported.`);
    const domain = record(domainExecution.domain, `Prepared domain ${index} identity`);
    const details = domainSummary(kind, domainExecution);
    let evmAuthorization: DomainReview["evmAuthorization"] = null;
    if (kind === "EVM_MULTI_STRATEGY_ACCOUNT") {
      const envelope = record(domainExecution.envelope, `Prepared domain ${index} EVM envelope`);
      const execution = record(envelope.execution, `Prepared domain ${index} EVM execution`);
      const ownerTypedData = record(envelope.ownerTypedData, `Prepared domain ${index} EVM owner typed data`);
      const typedDomain = record(ownerTypedData.domain, `Prepared domain ${index} EVM typed domain`);
      const account = text(envelope.account, `Prepared domain ${index} EVM account`);
      const chainId = integer(typedDomain.chainId, `Prepared domain ${index} EVM chain id`);
      if (!EVM_ADDRESS.test(account) || typedDomain.name !== "Naryx Multi Strategy Account" || typedDomain.version !== "1"
        || String(typedDomain.verifyingContract).toLowerCase() !== account.toLowerCase()
        || ownerTypedData.primaryType !== "OwnerExecution"
        || execution.orderHash !== `0x${orderHash}` || execution.quoteHash !== `0x${quoteHash}`
        || execution.routeHash !== `0x${routeHash}`) {
        throw new Error(`Prepared domain ${index} EVM authorization does not bind the reviewed package.`);
      }
      evmAuthorization = Object.freeze({ chainId, account, ownerTypedData });
    }
    return Object.freeze({
      kind,
      domainId: text(domain.domainId, `Prepared domain ${index} id`),
      manifestVersion: integer(domain.domainManifestVersion, `Prepared domain ${index} manifest version`),
      manifestHash: hash(domain.domainManifestHash, `Prepared domain ${index} manifest hash`),
      routeSettlementClass: text(domainExecution.routeSettlementClass, `Prepared domain ${index} settlement class`),
      localGuarantee: text(domainExecution.localGuarantee, `Prepared domain ${index} guarantee`),
      summary: details.summary,
      expiry: details.expiry,
      evmAuthorization,
    });
  });
  if (domains.length === 0) throw new Error("Prepared strategy has no execution domains.");
  return Object.freeze({
    quoteHash,
    orderHash,
    graphHash,
    routeHash,
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
        venueId: text(market.venueId, `Native strategy profile ${index} market ${marketIndex} venue`),
        marketId: text(market.marketId, `Native strategy profile ${index} market ${marketIndex} market`),
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

function parseNativeStrategyPositions(payload: unknown, requestedOwner: string): readonly NativeStrategyPositionReview[] {
  const root = record(decode(payload as Json), "Native strategy positions");
  if (root.version !== 1 || root.owner !== requestedOwner) {
    throw new Error("Native strategy positions do not bind the connected owner.");
  }
  return list(root.positions, "Native strategy positions").map((candidate, index) => {
    const position = record(candidate, `Native strategy position ${index}`);
    const state = record(position.state, `Native strategy position ${index} state`);
    const status = text(position.status, `Native strategy position ${index} status`);
    if (status !== "OPEN" && status !== "EXITING" && status !== "CLOSED" && status !== "UNRESOLVED") {
      throw new Error(`Native strategy position ${index} status is invalid.`);
    }
    const owner = text(position.owner, `Native strategy position ${index} owner`);
    if (owner !== requestedOwner || state.ownerId !== requestedOwner || state.open !== (status !== "CLOSED")) {
      throw new Error(`Native strategy position ${index} owner or state is invalid.`);
    }
    const legs = list(state.legs, `Native strategy position ${index} legs`).map((candidateLeg, legIndex) => {
      const leg = record(candidateLeg, `Native strategy position ${index} leg ${legIndex}`);
      return Object.freeze({
        legId: text(leg.legId, `Native strategy position ${index} leg ${legIndex} id`),
        underlyingId: text(leg.underlyingId, `Native strategy position ${index} leg ${legIndex} underlying`),
        instrumentId: text(leg.instrumentId, `Native strategy position ${index} leg ${legIndex} instrument`),
        venueId: text(leg.venueId, `Native strategy position ${index} leg ${legIndex} venue`),
        signedQuantityAtoms: decimalInteger(
          leg.signedQuantityAtoms,
          `Native strategy position ${index} leg ${legIndex} quantity`,
        ),
      });
    });
    if (legs.length === 0) throw new Error(`Native strategy position ${index} has no legs.`);
    return Object.freeze({
      strategyId: text(position.strategyId, `Native strategy position ${index} id`),
      owner,
      templateId: text(position.templateId, `Native strategy position ${index} template`),
      seriesId: text(state.seriesId, `Native strategy position ${index} series`),
      executionClassId: text(state.executionClassId, `Native strategy position ${index} execution class`),
      settlementAccount: text(state.subaccountId, `Native strategy position ${index} settlement account`),
      economicQuantityAtoms: decimalInteger(
        position.economicQuantityAtoms,
        `Native strategy position ${index} economic quantity`,
      ),
      stateHash: hash(position.stateHashHex, `Native strategy position ${index} state hash`),
      status,
      legs: Object.freeze(legs),
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

function atomsToInput(atoms: string, decimals: number): string {
  const negative = atoms.startsWith("-");
  const digits = negative ? atoms.slice(1) : atoms;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function parseEvmOptionProfiles(payload: unknown): readonly EvmOptionProfile[] {
  const root = record(payload, "EVM option profiles");
  if (root.version !== 1) throw new Error("EVM option profile version is unsupported.");
  return list(root.profiles, "EVM option profiles").map((candidate, index): EvmOptionProfile => {
    const profile = record(candidate, `EVM option profile ${index}`);
    const baseAsset = record(profile.baseAsset, `EVM option profile ${index} base asset`);
    const quoteAsset = record(profile.quoteAsset, `EVM option profile ${index} quote asset`);
    const bounds = record(profile.bounds, `EVM option profile ${index} bounds`);
    const markets = list(profile.markets, `EVM option profile ${index} markets`).map((candidateMarket, marketIndex) => {
      const market = record(candidateMarket, `EVM option profile ${index} market ${marketIndex}`);
      if (market.role !== "option-long" && market.role !== "option-short") {
        throw new Error(`EVM option profile ${index} market ${marketIndex} role is invalid.`);
      }
      return Object.freeze({
        role: market.role,
        strike: decimalInteger(market.strike, `EVM option profile ${index} market ${marketIndex} strike`),
        maturity: decimalInteger(market.maturity, `EVM option profile ${index} market ${marketIndex} maturity`),
      });
    });
    const accountFactory = text(profile.accountFactory, `EVM option profile ${index} account factory`);
    if (!EVM_ADDRESS.test(accountFactory) || markets.length !== 2) throw new Error(`EVM option profile ${index} is invalid.`);
    return Object.freeze({
      profileId: text(profile.profileId, `EVM option profile ${index} id`),
      displayName: text(profile.displayName, `EVM option profile ${index} display name`),
      templateId: text(profile.templateId, `EVM option profile ${index} template`),
      seriesId: text(profile.seriesId, `EVM option profile ${index} series`),
      executionClassId: text(profile.executionClassId, `EVM option profile ${index} execution class`),
      chainId: integer(profile.chainId, `EVM option profile ${index} chain id`),
      domainId: text(profile.domainId, `EVM option profile ${index} domain`),
      accountFactory,
      baseAsset: Object.freeze({
        assetId: text(baseAsset.assetId, `EVM option profile ${index} base asset id`),
        decimals: unsignedInteger(baseAsset.decimals, `EVM option profile ${index} base decimals`),
      }),
      quoteAsset: Object.freeze({
        assetId: text(quoteAsset.assetId, `EVM option profile ${index} quote asset id`),
        decimals: unsignedInteger(quoteAsset.decimals, `EVM option profile ${index} quote decimals`),
      }),
      markets: Object.freeze(markets),
      bounds: Object.freeze({
        minimumQuantityAtoms: decimalInteger(bounds.minimumQuantityAtoms, `EVM option profile ${index} minimum quantity`),
        maximumQuantityAtoms: decimalInteger(bounds.maximumQuantityAtoms, `EVM option profile ${index} maximum quantity`),
        maximumExpiryTtlSeconds: decimalInteger(bounds.maximumExpiryTtlSeconds, `EVM option profile ${index} expiry TTL`),
      }),
    });
  });
}

function parseCreatedEvmOptionOrder(
  payload: unknown,
  profileId: string,
  lifecycleAction: string,
): Readonly<{ orderHash: string; graphHash: string }> {
  const root = record(payload, "EVM option order creation");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || root.profileId !== profileId
    || root.templateId !== "option-spread-v1" || root.lifecycleAction !== lifecycleAction) {
    throw new Error("EVM option order creation changed the requested package.");
  }
  return Object.freeze({
    orderHash: hash(root.orderHash, "EVM option order hash"),
    graphHash: hash(root.graphHash, "EVM option graph hash"),
  });
}

function parseEvmCalendarProfiles(payload: unknown): readonly EvmCalendarProfile[] {
  const root = record(payload, "EVM calendar spread profiles");
  if (root.version !== 1) throw new Error("EVM calendar spread profile version is unsupported.");
  return list(root.profiles, "EVM calendar spread profiles").map((candidate, index): EvmCalendarProfile => {
    const profile = record(candidate, `EVM calendar spread profile ${index}`);
    const baseAsset = record(profile.baseAsset, `EVM calendar spread profile ${index} base asset`);
    const quoteAsset = record(profile.quoteAsset, `EVM calendar spread profile ${index} quote asset`);
    const bounds = record(profile.bounds, `EVM calendar spread profile ${index} bounds`);
    const markets = list(profile.markets, `EVM calendar spread profile ${index} markets`).map(
      (candidateMarket, marketIndex) => {
        const market = record(candidateMarket, `EVM calendar spread profile ${index} market ${marketIndex}`);
        if (market.role !== "near-future" && market.role !== "far-future") {
          throw new Error(`EVM calendar spread profile ${index} market ${marketIndex} role is invalid.`);
        }
        return Object.freeze({
          role: market.role,
          maturity: decimalInteger(
            market.maturity,
            `EVM calendar spread profile ${index} market ${marketIndex} maturity`,
          ),
        });
      },
    );
    const near = markets.find((market) => market.role === "near-future");
    const far = markets.find((market) => market.role === "far-future");
    const accountFactory = text(profile.accountFactory, `EVM calendar spread profile ${index} account factory`);
    if (!EVM_ADDRESS.test(accountFactory) || near === undefined || far === undefined
      || BigInt(near.maturity) >= BigInt(far.maturity) || markets.length !== 2
      || profile.templateId !== "calendar-spread-v1") {
      throw new Error(`EVM calendar spread profile ${index} is invalid.`);
    }
    return Object.freeze({
      profileId: text(profile.profileId, `EVM calendar spread profile ${index} id`),
      displayName: text(profile.displayName, `EVM calendar spread profile ${index} display name`),
      templateId: "calendar-spread-v1",
      seriesId: text(profile.seriesId, `EVM calendar spread profile ${index} series`),
      executionClassId: text(profile.executionClassId, `EVM calendar spread profile ${index} execution class`),
      chainId: integer(profile.chainId, `EVM calendar spread profile ${index} chain id`),
      domainId: text(profile.domainId, `EVM calendar spread profile ${index} domain`),
      accountFactory,
      baseAsset: Object.freeze({
        assetId: text(baseAsset.assetId, `EVM calendar spread profile ${index} base asset id`),
        decimals: unsignedInteger(baseAsset.decimals, `EVM calendar spread profile ${index} base decimals`),
      }),
      quoteAsset: Object.freeze({
        assetId: text(quoteAsset.assetId, `EVM calendar spread profile ${index} quote asset id`),
        decimals: unsignedInteger(quoteAsset.decimals, `EVM calendar spread profile ${index} quote decimals`),
      }),
      markets: Object.freeze([near, far]),
      bounds: Object.freeze({
        minimumQuantityAtoms: decimalInteger(
          bounds.minimumQuantityAtoms,
          `EVM calendar spread profile ${index} minimum quantity`,
        ),
        maximumQuantityAtoms: decimalInteger(
          bounds.maximumQuantityAtoms,
          `EVM calendar spread profile ${index} maximum quantity`,
        ),
        maximumExpiryTtlSeconds: decimalInteger(
          bounds.maximumExpiryTtlSeconds,
          `EVM calendar spread profile ${index} expiry TTL`,
        ),
      }),
    });
  });
}

function parseCreatedEvmCalendarOrder(
  payload: unknown,
  profileId: string,
  lifecycleAction: string,
): Readonly<{ orderHash: string; graphHash: string }> {
  const root = record(payload, "EVM calendar spread order creation");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || root.profileId !== profileId
    || root.templateId !== "calendar-spread-v1" || root.lifecycleAction !== lifecycleAction) {
    throw new Error("EVM calendar spread order creation changed the requested package.");
  }
  return Object.freeze({
    orderHash: hash(root.orderHash, "EVM calendar spread order hash"),
    graphHash: hash(root.graphHash, "EVM calendar spread graph hash"),
  });
}

function parseEvmDirectionalProfiles(
  payload: unknown,
  kind: EvmDirectionalProfile["kind"],
): readonly EvmDirectionalProfile[] {
  const context = kind === "TREASURY_HEDGE" ? "EVM treasury hedge profiles"
    : kind === "COLLATERAL_CONVERSION" ? "EVM collateral conversion profiles"
      : "EVM reverse basis profiles";
  const root = record(payload, context);
  if (root.version !== 1) throw new Error(`${context} version is unsupported.`);
  return list(root.profiles, context).map((candidate, index) => {
    const profile = record(candidate, `${context} ${index}`);
    const base = record(kind === "TREASURY_HEDGE" ? profile.inventoryAsset
      : kind === "COLLATERAL_CONVERSION" ? profile.collateralAsset : profile.baseAsset,
      `${context} ${index} base asset`);
    const quote = record(profile.quoteAsset, `${context} ${index} quote asset`);
    const bounds = record(profile.bounds, `${context} ${index} bounds`);
    const accountFactory = text(profile.accountFactory, `${context} ${index} account factory`);
    if (!EVM_ADDRESS.test(accountFactory)) throw new Error(`${context} ${index} account factory is invalid.`);
    return Object.freeze({
      kind,
      profileId: text(profile.profileId, `${context} ${index} id`),
      displayName: text(profile.displayName, `${context} ${index} display name`),
      templateId: text(profile.templateId, `${context} ${index} template`),
      seriesId: text(profile.seriesId, `${context} ${index} series`),
      executionClassId: text(profile.executionClassId, `${context} ${index} execution class`),
      chainId: integer(profile.chainId, `${context} ${index} chain id`),
      domainId: text(profile.domainId, `${context} ${index} domain`),
      accountFactory,
      baseAsset: Object.freeze({ assetId: text(base.assetId, `${context} ${index} base asset id`),
        decimals: unsignedInteger(base.decimals, `${context} ${index} base decimals`) }),
      quoteAsset: Object.freeze({ assetId: text(quote.assetId, `${context} ${index} quote asset id`),
        decimals: unsignedInteger(quote.decimals, `${context} ${index} quote decimals`) }),
      bounds: Object.freeze({
        minimumQuantityAtoms: decimalInteger(bounds.minimumQuantityAtoms, `${context} ${index} minimum quantity`),
        maximumQuantityAtoms: decimalInteger(bounds.maximumQuantityAtoms, `${context} ${index} maximum quantity`),
        maximumExpiryTtlSeconds: decimalInteger(bounds.maximumExpiryTtlSeconds, `${context} ${index} expiry TTL`),
      }),
    });
  });
}

function parseCreatedEvmDirectionalOrder(
  payload: unknown,
  profile: EvmDirectionalProfile,
  lifecycleAction: string,
): Readonly<{ orderHash: string; graphHash: string }> {
  const root = record(payload, "EVM strategy order creation");
  if (root.version !== 1 || root.status !== "STORED_FOR_QUOTING" || root.profileId !== profile.profileId
    || root.templateId !== profile.templateId || root.lifecycleAction !== lifecycleAction) {
    throw new Error("EVM strategy order creation changed the requested package.");
  }
  return Object.freeze({
    orderHash: hash(root.orderHash, "EVM strategy order hash"),
    graphHash: hash(root.graphHash, "EVM strategy graph hash"),
  });
}

function parseEvmStrategyPositions(payload: unknown, requestedOwner: string): readonly EvmStrategyPositionReview[] {
  const root = record(decode(payload as Json), "EVM strategy positions");
  if (root.version !== 1 || root.owner !== requestedOwner) {
    throw new Error("EVM strategy positions do not bind the connected owner.");
  }
  return list(root.positions, "EVM strategy positions").map((candidate, index) => {
    const position = record(candidate, `EVM strategy position ${index}`);
    const status = text(position.status, `EVM strategy position ${index} status`);
    if (status !== "OPEN" && status !== "CLOSED") throw new Error(`EVM strategy position ${index} status is invalid.`);
    const owner = text(position.owner, `EVM strategy position ${index} owner`);
    const settlementAccount = text(position.settlementAccount, `EVM strategy position ${index} account`);
    if (owner !== requestedOwner || !EVM_ADDRESS.test(settlementAccount)) {
      throw new Error(`EVM strategy position ${index} owner or account is invalid.`);
    }
    return Object.freeze({
      packageId: hash(position.packageIdHex, `EVM strategy position ${index} package`),
      owner,
      chainId: integer(position.chainId, `EVM strategy position ${index} chain`),
      domainId: text(position.domainId, `EVM strategy position ${index} domain`),
      settlementAccount,
      templateId: text(position.templateId, `EVM strategy position ${index} template`),
      seriesId: text(position.seriesId, `EVM strategy position ${index} series`),
      executionClassId: text(position.executionClassId, `EVM strategy position ${index} execution class`),
      baseAssetId: text(position.baseAssetId, `EVM strategy position ${index} base asset`),
      baseAssetDecimals: unsignedInteger(position.baseAssetDecimals, `EVM strategy position ${index} base decimals`),
      economicQuantityAtoms: decimalInteger(position.economicQuantityAtoms, `EVM strategy position ${index} quantity`),
      stateHash: hash(position.stateHashHex, `EVM strategy position ${index} state hash`),
      status,
    });
  });
}

function parseEvmProvisioning(payload: unknown, expectedChainId: number, expectedOwner: string): EvmProvisioningPlan {
  const root = record(decode(payload as Json), "EVM provisioning response");
  const provisioning = record(root.provisioning, "EVM provisioning plan");
  if (root.status !== "READY" && root.status !== "WALLET_TRANSACTIONS_REQUIRED") {
    throw new Error("EVM provisioning status is invalid.");
  }
  const chainId = integer(provisioning.chainId, "EVM provisioning chain id");
  const owner = text(provisioning.owner, "EVM provisioning owner");
  const strategyAccount = text(provisioning.strategyAccount, "EVM strategy account");
  if (chainId !== expectedChainId || owner.toLowerCase() !== expectedOwner.toLowerCase()
    || !EVM_ADDRESS.test(strategyAccount) || typeof provisioning.ready !== "boolean") {
    throw new Error("EVM provisioning plan changed the selected account.");
  }
  const transactions = list(provisioning.transactions, "EVM provisioning transactions").map((candidate, index) => {
    const transaction = record(candidate, `EVM provisioning transaction ${index}`);
    if ((transaction.kind !== "CREATE_STRATEGY_ACCOUNT" && transaction.kind !== "CREATE_PACKAGE_ADAPTER")
      || !EVM_ADDRESS.test(String(transaction.to)) || !EVM_ADDRESS.test(String(transaction.expectedAddress))
      || typeof transaction.data !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data)
      || decimalInteger(transaction.value, `EVM provisioning transaction ${index} value`) !== "0") {
      throw new Error(`EVM provisioning transaction ${index} is invalid.`);
    }
    return Object.freeze({
      kind: transaction.kind,
      to: String(transaction.to),
      data: transaction.data,
      value: "0" as const,
      expectedAddress: String(transaction.expectedAddress),
    });
  });
  if (provisioning.ready !== (transactions.length === 0)) throw new Error("EVM provisioning readiness is inconsistent.");
  return Object.freeze({ chainId, owner, strategyAccount, ready: provisioning.ready, transactions: Object.freeze(transactions) });
}

function parseEvmCollateralPlan(
  payload: unknown,
  expectedChainId: number,
  expectedOwner: string,
  expectedQuoteHash: string,
  expectedAction: "SUPPLY" | "WITHDRAW",
): EvmCollateralPlan {
  const root = record(decode(payload as Json), "EVM collateral response");
  if (root.status !== "WALLET_TRANSACTIONS_REQUIRED") throw new Error("EVM collateral status is invalid.");
  const collateral = record(root.collateral, "EVM collateral plan");
  const chainId = integer(collateral.chainId, "EVM collateral chain id");
  const owner = text(collateral.owner, "EVM collateral owner");
  const strategyAccount = text(collateral.strategyAccount, "EVM collateral account");
  const quoteHash = text(collateral.quoteHash, "EVM collateral quote");
  const action = text(collateral.action, "EVM collateral action");
  const assetToken = text(collateral.assetToken, "EVM collateral asset");
  const minimumOutputAtoms = decimalInteger(collateral.minimumOutputAtoms, "EVM collateral minimum output");
  const maximumOutputAtoms = decimalInteger(collateral.maximumOutputAtoms, "EVM collateral maximum output");
  if (chainId !== expectedChainId || owner.toLowerCase() !== expectedOwner.toLowerCase()
    || !EVM_ADDRESS.test(strategyAccount) || quoteHash !== `0x${expectedQuoteHash}`
    || action !== expectedAction || !EVM_ADDRESS.test(assetToken)
    || BigInt(minimumOutputAtoms) <= BigInt(0) || BigInt(maximumOutputAtoms) < BigInt(minimumOutputAtoms)) {
    throw new Error("EVM collateral plan changed the selected package.");
  }
  const transactions = list(collateral.transactions, "EVM collateral transactions").map((candidate, index) => {
    const transaction = record(candidate, `EVM collateral transaction ${index}`);
    if ((transaction.kind !== "RESET_COLLATERAL_ALLOWANCE" && transaction.kind !== "APPROVE_COLLATERAL"
      && transaction.kind !== "MANAGE_PACKAGE_COLLATERAL") || !EVM_ADDRESS.test(String(transaction.to))
      || typeof transaction.data !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.data)
      || decimalInteger(transaction.value, `EVM collateral transaction ${index} value`) !== "0") {
      throw new Error(`EVM collateral transaction ${index} is invalid.`);
    }
    return Object.freeze({
      kind: transaction.kind,
      to: String(transaction.to),
      data: transaction.data,
      value: "0" as const,
    });
  });
  if (transactions.length === 0) throw new Error("EVM collateral plan has no wallet transaction.");
  return Object.freeze({
    chainId,
    owner,
    strategyAccount,
    quoteHash,
    action: action as "SUPPLY" | "WITHDRAW",
    assetToken,
    minimumOutputAtoms,
    maximumOutputAtoms,
    transactions: Object.freeze(transactions),
  });
}

function parseAuthorizedEvmExecution(payload: unknown, review: StrategyPreparationReview): AuthorizedEvmExecution {
  const root = record(decode(payload as Json), "EVM strategy authorization");
  if (root.status !== "READY_FOR_WALLET_SUBMISSION") throw new Error("EVM strategy authorization is not ready.");
  const authorization = record(root.authorization, "EVM strategy authorization");
  const chainId = integer(authorization.chainId, "EVM authorization chain id");
  const to = text(authorization.to, "EVM authorization target");
  const data = text(authorization.data, "EVM authorization calldata");
  const quoteHash = text(authorization.quoteHash, "EVM authorization quote hash");
  const expectedNextStateHash = text(authorization.expectedNextStateHash, "EVM authorization next state");
  const evm = review.domains[0]?.evmAuthorization;
  if (evm === null || evm === undefined || chainId !== evm.chainId || to.toLowerCase() !== evm.account.toLowerCase()
    || quoteHash !== `0x${review.quoteHash}` || !EVM_HASH.test(expectedNextStateHash)
    || decimalInteger(authorization.value, "EVM authorization value") !== "0"
    || !/^0x(?:[0-9a-f]{2})+$/i.test(data)) {
    throw new Error("EVM strategy authorization changed the reviewed execution.");
  }
  return Object.freeze({ chainId, to, data, value: "0", quoteHash, expectedNextStateHash });
}

function nativePositionQuantityAtoms(position: NativeStrategyPositionReview): bigint {
  const quantities = position.legs.map((leg) => {
    const value = BigInt(leg.signedQuantityAtoms);
    return value < BigInt(0) ? -value : value;
  });
  if (quantities[0] === undefined || quantities.some((quantity) => quantity !== quantities[0])) {
    throw new Error("The selected strategy does not use one executable package quantity.");
  }
  return quantities[0];
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
  executionDomain,
  templateId,
  lifecycleAction,
  sourceOrderHash = null,
  strategyOwner = null,
  solanaOwner = null,
  signStrategyOrder,
  signEvmStrategyExecution,
  sendEvmTransaction,
  waitForEvmReceipt,
  sendSolanaTransaction,
}: {
  privateApiBaseUrl: string | null;
  publicApiBaseUrl: string | null;
  executionDomain: DomainId;
  templateId: string;
  lifecycleAction: string;
  sourceOrderHash?: string | null;
  strategyOwner?: string | null;
  solanaOwner?: string | null;
  signStrategyOrder?: (challenge: StrategyOrderAuthorizationChallenge) => Promise<string>;
  signEvmStrategyExecution?: (chainId: number, typedData: unknown) => Promise<string>;
  sendEvmTransaction?: (chainId: number, transaction: Readonly<{ to: string; data: string; value: string }>) => Promise<string>;
  waitForEvmReceipt?: (chainId: number, hash: string) => Promise<boolean>;
  sendSolanaTransaction?: (transaction: Uint8Array) => Promise<string>;
}) {
  const hyperliquidLane = executionDomain === "hyperliquid";
  const solanaLane = executionDomain === "solana";
  const evmChainId = EVM_CHAIN_IDS[executionDomain];
  const evmLane = evmChainId !== undefined;
  const expectedDomainId = TEST_DOMAIN_IDS[executionDomain];
  const laneSupportsTemplate = sourceOrderHash !== null
    ? hyperliquidLane
    : hyperliquidLane
      ? NATIVE_HYPERCORE_TEMPLATES.has(templateId)
      : solanaLane
        ? templateId === "treasury-inventory-hedge-v1"
          && (lifecycleAction === "ENTRY" || lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND")
        : evmLane && EVM_STRATEGY_TEMPLATES.has(templateId);
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
  const [nativePositions, setNativePositions] = useState<readonly NativeStrategyPositionReview[] | null>(null);
  const [nativePositionError, setNativePositionError] = useState<string | null>(null);
  const [selectedNativeProfileId, setSelectedNativeProfileId] = useState("");
  const [selectedNativeStrategyId, setSelectedNativeStrategyId] = useState("");
  const [nativeQuantity, setNativeQuantity] = useState("");
  const [nativeEconomicQuantity, setNativeEconomicQuantity] = useState("");
  const [nativeAdjustmentKind, setNativeAdjustmentKind] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const [nativeLimitPrices, setNativeLimitPrices] = useState<Record<string, string>>({});
  const [createdNativeOrder, setCreatedNativeOrder] = useState<CreatedNativeStrategyOrder | null>(null);
  const [solanaProfiles, setSolanaProfiles] = useState<readonly SolanaTreasuryHedgeProfile[] | null>(null);
  const [solanaPositions, setSolanaPositions] = useState<readonly SolanaStrategyPositionReview[] | null>(null);
  const [solanaPositionError, setSolanaPositionError] = useState<string | null>(null);
  const [selectedSolanaProfileId, setSelectedSolanaProfileId] = useState("");
  const [selectedSolanaPackageId, setSelectedSolanaPackageId] = useState("");
  const [solanaQuantity, setSolanaQuantity] = useState("");
  const [solanaHedgePrice, setSolanaHedgePrice] = useState("");
  const [solanaProvisioning, setSolanaProvisioning] = useState<SolanaProvisioningPlan | null>(null);
  const [solanaCreateBusy, setSolanaCreateBusy] = useState(false);
  const [solanaProvisionBusy, setSolanaProvisionBusy] = useState(false);
  const [solanaExecutionBusy, setSolanaExecutionBusy] = useState(false);
  const [solanaExecutionSignature, setSolanaExecutionSignature] = useState<string | null>(null);
  const [solanaObservation, setSolanaObservation] = useState<SolanaExecutionObservation | null>(null);
  const [evmOptionProfiles, setEvmOptionProfiles] = useState<readonly EvmOptionProfile[] | null>(null);
  const [selectedEvmOptionProfileId, setSelectedEvmOptionProfileId] = useState("");
  const [evmOptionQuantity, setEvmOptionQuantity] = useState("");
  const [evmLongPremium, setEvmLongPremium] = useState("");
  const [evmShortPremium, setEvmShortPremium] = useState("");
  const [evmCalendarProfiles, setEvmCalendarProfiles] = useState<readonly EvmCalendarProfile[] | null>(null);
  const [selectedEvmCalendarProfileId, setSelectedEvmCalendarProfileId] = useState("");
  const [evmCalendarQuantity, setEvmCalendarQuantity] = useState("");
  const [evmNearFuturePrice, setEvmNearFuturePrice] = useState("");
  const [evmFarFuturePrice, setEvmFarFuturePrice] = useState("");
  const [evmDirectionalProfiles, setEvmDirectionalProfiles] = useState<readonly EvmDirectionalProfile[] | null>(null);
  const [selectedEvmDirectionalProfileId, setSelectedEvmDirectionalProfileId] = useState("");
  const [evmPositions, setEvmPositions] = useState<readonly EvmStrategyPositionReview[] | null>(null);
  const [evmPositionError, setEvmPositionError] = useState<string | null>(null);
  const [selectedEvmPackageId, setSelectedEvmPackageId] = useState("");
  const [evmDirectionalQuantity, setEvmDirectionalQuantity] = useState("");
  const [evmHedgePrice, setEvmHedgePrice] = useState("");
  const [evmSwapPrice, setEvmSwapPrice] = useState("");
  const [evmProvisioning, setEvmProvisioning] = useState<EvmProvisioningPlan | null>(null);
  const [evmCollateral, setEvmCollateral] = useState<EvmCollateralPlan | null>(null);
  const [evmCollateralCompletionKey, setEvmCollateralCompletionKey] = useState("");
  const [evmCreateBusy, setEvmCreateBusy] = useState(false);
  const [evmProvisionBusy, setEvmProvisionBusy] = useState(false);
  const [evmCollateralBusy, setEvmCollateralBusy] = useState(false);
  const [evmExecutionBusy, setEvmExecutionBusy] = useState(false);
  const [evmExecutionHash, setEvmExecutionHash] = useState<string | null>(null);
  const [evmExecutionConfirmed, setEvmExecutionConfirmed] = useState(false);
  const [nativeCreateBusy, setNativeCreateBusy] = useState(false);
  const [stageBusy, setStageBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!solanaLane || privateApiBaseUrl === null || sourceOrderHash !== null
      || templateId !== "treasury-inventory-hedge-v1") return;
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/solana-treasury-hedge-profiles`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseSolanaTreasuryHedgeProfiles(await response.json());
    }).then((profiles) => {
      setSolanaProfiles(profiles);
      setSelectedSolanaProfileId((current) => current || profiles[0]?.profileId || "");
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setSolanaProfiles([]);
      setError(cause instanceof Error ? cause.message : "Solana treasury hedge markets are unavailable.");
    });
    return () => controller.abort();
  }, [lifecycleAction, privateApiBaseUrl, solanaLane, sourceOrderHash, templateId]);

  useEffect(() => {
    if (!solanaLane || privateApiBaseUrl === null || sourceOrderHash !== null || lifecycleAction === "ENTRY"
      || solanaOwner === null || !SOLANA_ADDRESS.test(solanaOwner)
      || templateId !== "treasury-inventory-hedge-v1") return;
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/solana-strategies?owner=${encodeURIComponent(solanaOwner)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseSolanaStrategyPositions(await response.json(), solanaOwner);
    }).then((positions) => {
      setSolanaPositions(positions);
      setSolanaPositionError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setSolanaPositions([]);
      setSolanaPositionError(cause instanceof Error ? cause.message : "Solana strategy positions are unavailable.");
    });
    return () => controller.abort();
  }, [privateApiBaseUrl, solanaLane, sourceOrderHash, lifecycleAction, solanaOwner, templateId,
    solanaObservation?.status]);

  useEffect(() => {
    if (!evmLane || privateApiBaseUrl === null || sourceOrderHash !== null || templateId !== "option-spread-v1") return;
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/evm-option-spread-profiles`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseEvmOptionProfiles(await response.json());
    }).then((profiles) => {
      setEvmOptionProfiles(profiles);
      setSelectedEvmOptionProfileId((current) => current || profiles[0]?.profileId || "");
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEvmOptionProfiles([]);
      setError(cause instanceof Error ? cause.message : "EVM option markets are unavailable.");
    });
    return () => controller.abort();
  }, [evmLane, privateApiBaseUrl, sourceOrderHash, templateId]);

  useEffect(() => {
    if (!evmLane || privateApiBaseUrl === null || sourceOrderHash !== null || templateId !== "calendar-spread-v1") return;
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/evm-calendar-spread-profiles`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseEvmCalendarProfiles(await response.json());
    }).then((profiles) => {
      setEvmCalendarProfiles(profiles);
      setSelectedEvmCalendarProfileId((current) => current || profiles[0]?.profileId || "");
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEvmCalendarProfiles([]);
      setError(cause instanceof Error ? cause.message : "EVM calendar spread markets are unavailable.");
    });
    return () => controller.abort();
  }, [evmLane, privateApiBaseUrl, sourceOrderHash, templateId]);

  useEffect(() => {
    const kind = templateId === "treasury-inventory-hedge-v1" ? "TREASURY_HEDGE"
      : templateId === "collateral-conversion-hedge-v1" ? "COLLATERAL_CONVERSION"
        : templateId === "reverse-cash-and-carry-v1" ? "REVERSE_BASIS" : null;
    if (!evmLane || privateApiBaseUrl === null || sourceOrderHash !== null || kind === null) return;
    const controller = new AbortController();
    const route = kind === "TREASURY_HEDGE"
      ? "/internal/terminal/evm-treasury-hedge-profiles"
      : kind === "COLLATERAL_CONVERSION"
        ? "/internal/terminal/evm-collateral-conversion-profiles"
        : "/internal/terminal/evm-reverse-basis-profiles";
    void fetch(`${privateApiBaseUrl}${route}`, {
      headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit",
      referrerPolicy: "no-referrer", signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseEvmDirectionalProfiles(await response.json(), kind);
    }).then((profiles) => {
      setEvmDirectionalProfiles(profiles);
      setSelectedEvmDirectionalProfileId((current) => current || profiles[0]?.profileId || "");
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEvmDirectionalProfiles([]);
      setError(cause instanceof Error ? cause.message : "EVM strategy markets are unavailable.");
    });
    return () => controller.abort();
  }, [evmLane, privateApiBaseUrl, sourceOrderHash, templateId]);

  useEffect(() => {
    if (!evmLane || privateApiBaseUrl === null || sourceOrderHash !== null || lifecycleAction === "ENTRY"
      || strategyOwner === null || !OWNER.test(strategyOwner) || !EVM_STRATEGY_TEMPLATES.has(templateId)) {
      return;
    }
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/evm-strategies?owner=${encodeURIComponent(strategyOwner)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseEvmStrategyPositions(await response.json(), strategyOwner);
    }).then((positions) => {
      setEvmPositions(positions);
      setEvmPositionError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setEvmPositions([]);
      setEvmPositionError(cause instanceof Error ? cause.message : "EVM strategy positions are unavailable.");
    });
    return () => controller.abort();
  }, [evmLane, privateApiBaseUrl, sourceOrderHash, lifecycleAction, strategyOwner, templateId, strategyReceipt?.receiptHash]);

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
    if (!hyperliquidLane || privateApiBaseUrl === null || sourceOrderHash !== null || !NATIVE_HYPERCORE_TEMPLATES.has(templateId)) {
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
  }, [hyperliquidLane, privateApiBaseUrl, sourceOrderHash, templateId]);

  useEffect(() => {
    if (!hyperliquidLane || privateApiBaseUrl === null || sourceOrderHash !== null
      || (lifecycleAction !== "INCREASE" && lifecycleAction !== "DECREASE"
        && lifecycleAction !== "EXIT" && lifecycleAction !== "MIGRATE"
        && lifecycleAction !== "REBALANCE"
        && lifecycleAction !== "EMERGENCY_UNWIND")
      || strategyOwner === null || !OWNER.test(strategyOwner)
      || !NATIVE_HYPERCORE_TEMPLATES.has(templateId)) {
      return;
    }
    const controller = new AbortController();
    void fetch(`${privateApiBaseUrl}/internal/terminal/native-strategies?owner=${encodeURIComponent(strategyOwner)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await failureMessage(response));
      return parseNativeStrategyPositions(await response.json(), strategyOwner);
    }).then((positions) => {
      setNativePositions(positions);
      setNativePositionError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setNativePositions([]);
      setNativePositionError(cause instanceof Error ? cause.message : "Native strategy positions are unavailable.");
    });
    return () => controller.abort();
  }, [hyperliquidLane, privateApiBaseUrl, sourceOrderHash, lifecycleAction, strategyOwner, templateId, strategyReceipt?.receiptHash]);

  const matchingAdmissions = admissions.filter((admission) => admission.templateId === templateId
    && admission.lifecycleAction === lifecycleAction
    && admission.domainIds.length === 1
    && admission.domainIds[0] === expectedDomainId);
  const matchingSolanaProfiles = (solanaProfiles ?? []).filter((profile) => profile.templateId === templateId);
  const selectedSolanaProfile = matchingSolanaProfiles.find((profile) => profile.profileId === selectedSolanaProfileId)
    ?? matchingSolanaProfiles[0]
    ?? null;
  const matchingSolanaPositions = (solanaPositions ?? []).filter((position) => position.status === "OPEN"
    && position.owner === solanaOwner
    && selectedSolanaProfile !== null
    && position.domainId === selectedSolanaProfile.domainId
    && position.templateId === selectedSolanaProfile.templateId
    && position.seriesId === selectedSolanaProfile.seriesId
    && position.executionClassId === selectedSolanaProfile.executionClassId
    && position.baseAssetId === selectedSolanaProfile.inventoryAsset.assetId
    && position.baseAssetDecimals === selectedSolanaProfile.inventoryAsset.decimals);
  const selectedSolanaPosition = matchingSolanaPositions.find((position) =>
    position.packageId === selectedSolanaPackageId) ?? matchingSolanaPositions[0] ?? null;
  const matchingEvmOptionProfiles = (evmOptionProfiles ?? []).filter((profile) => profile.chainId === evmChainId);
  const selectedEvmOptionProfile = matchingEvmOptionProfiles.find((profile) => profile.profileId === selectedEvmOptionProfileId)
    ?? matchingEvmOptionProfiles[0]
    ?? null;
  const matchingEvmCalendarProfiles = (evmCalendarProfiles ?? []).filter((profile) => profile.chainId === evmChainId);
  const selectedEvmCalendarProfile = matchingEvmCalendarProfiles.find((profile) =>
    profile.profileId === selectedEvmCalendarProfileId) ?? matchingEvmCalendarProfiles[0] ?? null;
  const matchingEvmDirectionalProfiles = (evmDirectionalProfiles ?? []).filter((profile) =>
    profile.templateId === templateId && profile.chainId === evmChainId);
  const selectedEvmDirectionalProfile = matchingEvmDirectionalProfiles.find((profile) =>
    profile.profileId === selectedEvmDirectionalProfileId) ?? matchingEvmDirectionalProfiles[0] ?? null;
  const selectedEvmProfile = templateId === "option-spread-v1"
    ? selectedEvmOptionProfile
    : templateId === "calendar-spread-v1"
      ? selectedEvmCalendarProfile
      : selectedEvmDirectionalProfile;
  const matchingEvmPositions = (evmPositions ?? []).filter((position) => position.status === "OPEN"
    && position.owner === strategyOwner
    && selectedEvmProfile !== null
    && position.chainId === selectedEvmProfile.chainId
    && position.domainId === selectedEvmProfile.domainId
    && position.templateId === selectedEvmProfile.templateId
    && position.seriesId === selectedEvmProfile.seriesId
    && position.executionClassId === selectedEvmProfile.executionClassId
    && position.baseAssetId === selectedEvmProfile.baseAsset.assetId
    && position.baseAssetDecimals === selectedEvmProfile.baseAsset.decimals);
  const selectedEvmPosition = matchingEvmPositions.find((position) => position.packageId === selectedEvmPackageId)
    ?? matchingEvmPositions[0]
    ?? null;
  const evmLifecycleSupported = lifecycleAction === "ENTRY"
    || ((templateId === "option-spread-v1" || templateId === "calendar-spread-v1"
      || templateId === "treasury-inventory-hedge-v1")
      && (lifecycleAction === "INCREASE" || lifecycleAction === "DECREASE"))
    || lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND";
  const fullEvmUnwind = lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND";
  const matchingNativeProfiles = (nativeProfiles ?? []).filter((profile) => profile.templateId === templateId);
  const selectedNativeProfile = matchingNativeProfiles.find((profile) => profile.profileId === selectedNativeProfileId)
    ?? matchingNativeProfiles[0]
    ?? null;
  const migrationSource = selectedNativeProfile?.templateId === "hedge-migration-v1"
    ? selectedNativeProfile.markets.find((market) => market.role === "source-hedge") ?? null
    : null;
  const rebalanceMarket = selectedNativeProfile?.templateId === "delta-neutral-rebalance-v1"
    ? selectedNativeProfile.markets.find((market) => market.role === "perp-adjustment") ?? null
    : null;
  const matchingNativePositions = (nativePositions ?? []).filter((position) =>
    (position.status === "OPEN" || (lifecycleAction === "EMERGENCY_UNWIND" && position.status === "UNRESOLVED"))
    && position.owner === strategyOwner
    && selectedNativeProfile !== null
    && position.settlementAccount === selectedNativeProfile.settlementAccount
    && (lifecycleAction === "MIGRATE"
      ? migrationSource !== null && position.legs.length === 1
        && position.legs[0]?.underlyingId === selectedNativeProfile.baseAsset.assetId
        && position.legs[0]?.instrumentId === migrationSource.marketId
        && position.legs[0]?.venueId === migrationSource.venueId
        && (BigInt(position.legs[0]?.signedQuantityAtoms ?? "0") > BigInt(0)
          ? migrationSource.entrySide === "BUY" : migrationSource.entrySide === "SELL")
      : lifecycleAction === "REBALANCE"
        ? rebalanceMarket !== null && position.templateId === "treasury-inventory-hedge-v1"
          && position.legs.length === 1
          && position.legs[0]?.underlyingId === selectedNativeProfile.baseAsset.assetId
          && position.legs[0]?.instrumentId === rebalanceMarket.marketId
          && position.legs[0]?.venueId === rebalanceMarket.venueId
          && (BigInt(position.legs[0]?.signedQuantityAtoms ?? "0") > BigInt(0)
            ? rebalanceMarket.entrySide === "BUY" : rebalanceMarket.entrySide === "SELL")
      : position.templateId === templateId
        && position.seriesId === selectedNativeProfile.seriesId
        && position.executionClassId === selectedNativeProfile.executionClassId));
  const selectedNativePosition = matchingNativePositions.find((position) => position.strategyId === selectedNativeStrategyId)
    ?? matchingNativePositions[0]
    ?? null;
  const nativeLifecycleSupported = lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
    || lifecycleAction === "DECREASE" || lifecycleAction === "EXIT"
    || lifecycleAction === "MIGRATE" || lifecycleAction === "REBALANCE"
    || lifecycleAction === "EMERGENCY_UNWIND";

  async function createSolanaTreasuryHedgeOrder() {
    if (privateApiBaseUrl === null || selectedSolanaProfile === null) return;
    setSolanaCreateBusy(true);
    setError(null);
    try {
      if (lifecycleAction !== "ENTRY" && lifecycleAction !== "EXIT" && lifecycleAction !== "EMERGENCY_UNWIND") {
        throw new Error("This Solana treasury hedge lifecycle action is not active.");
      }
      if (solanaOwner === null || !SOLANA_ADDRESS.test(solanaOwner)) {
        throw new Error("Connect the Solana wallet that will own this treasury hedge package.");
      }
      if (lifecycleAction !== "ENTRY" && selectedSolanaPosition === null) {
        throw new Error("Select an authoritative open Solana package before creating its exit.");
      }
      const quantityAtoms = lifecycleAction === "ENTRY"
        ? amountToAtoms(
          solanaQuantity,
          selectedSolanaProfile.inventoryAsset.decimals,
          "Treasury inventory quantity",
        )
        : BigInt(selectedSolanaPosition!.economicQuantityAtoms);
      const limitHedgePrice = priceToAtomicRatio(
        solanaHedgePrice,
        selectedSolanaProfile.inventoryAsset.decimals,
        selectedSolanaProfile.quoteAsset.decimals,
        12,
        lifecycleAction === "ENTRY" ? "Short hedge limit price" : "Hedge close limit price",
      );
      const currentSlot = BigInt(await getSolanaDevnetSlot());
      const maximumTtl = BigInt(selectedSolanaProfile.bounds.maximumExpiryTtlSlots);
      const ttl = maximumTtl < BigInt(600) ? maximumTtl : BigInt(600);
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/solana-treasury-hedge-orders/create`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedSolanaProfile.profileId,
          owner: solanaOwner,
          lifecycleAction,
          quantityAtoms: quantityAtoms.toString(),
          limitHedgePrice,
          expiryValue: (currentSlot + ttl).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "ENTRY" ? {} : {
            expectedStrategyStateHash: selectedSolanaPosition!.stateHash,
          }),
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const created = parseCreatedSolanaTreasuryHedgeOrder(
        await response.json(),
        selectedSolanaProfile.profileId,
        lifecycleAction,
      );
      setOrderHash(created.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setSolanaProvisioning(null);
      setSolanaExecutionSignature(null);
      setSolanaObservation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Solana treasury hedge order creation failed closed.");
    } finally {
      setSolanaCreateBusy(false);
    }
  }

  async function provisionSolanaTreasuryHedge() {
    if (privateApiBaseUrl === null || solanaOwner === null || !HASH.test(orderHash)) return;
    setSolanaProvisionBusy(true);
    setError(null);
    try {
      if (sendSolanaTransaction === undefined) {
        throw new Error("Connect a Wallet Standard account with Solana Devnet v0 transaction support.");
      }
      const loadPlan = async () => {
        const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/solana-provision`, {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderHash }),
        });
        if (!response.ok) throw new Error(await failureMessage(response));
        const expectedPackageId = lifecycleAction === "ENTRY" ? orderHash : selectedSolanaPosition?.packageId;
        if (expectedPackageId === undefined) throw new Error("The selected Solana package is unavailable.");
        return parseSolanaProvisioning(await response.json(), expectedPackageId, solanaOwner);
      };
      let plan = await loadPlan();
      for (const step of plan.steps) {
        const { blockhash, lastValidBlockHeight } = await getSolanaDevnetBlockhash();
        const transaction = buildSolanaWalletTransaction(step, solanaOwner, blockhash);
        const signature = await sendSolanaTransaction(transaction);
        await waitForSolanaDevnetFinality(signature, lastValidBlockHeight);
      }
      plan = await loadPlan();
      setSolanaProvisioning(plan);
      if (!plan.ready && plan.inventoryFundingRequiredAtoms === "0" && plan.quoteFundingRequiredAtoms === "0") {
        throw new Error("Solana strategy provisioning has not finalized yet. Retry after Devnet confirms the account state.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Solana treasury hedge provisioning failed closed.");
    } finally {
      setSolanaProvisionBusy(false);
    }
  }

  async function executeSolanaTreasuryHedge() {
    if (privateApiBaseUrl === null || review === null || solanaOwner === null) return;
    setSolanaExecutionBusy(true);
    setError(null);
    try {
      if (sendSolanaTransaction === undefined) {
        throw new Error("Connect a Wallet Standard account with Solana Devnet v0 transaction support.");
      }
      if (solanaProvisioning?.ready !== true) throw new Error("Provision the isolated Solana strategy accounts first.");
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/authorize-solana`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: review.quoteHash }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const authorization = parseAuthorizedSolanaExecution(await response.json(), solanaOwner, review);
      if (authorization.strategyAccount !== solanaProvisioning.strategyAccount) {
        throw new Error("Solana execution authorization changed the provisioned strategy account.");
      }
      const signature = await sendSolanaTransaction(authorization.transactionBytes);
      setSolanaExecutionSignature(signature);
      setSolanaObservation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Solana treasury hedge submission failed closed.");
    } finally {
      setSolanaExecutionBusy(false);
    }
  }

  async function refreshSolanaObservation() {
    if (privateApiBaseUrl === null || review === null || solanaExecutionSignature === null) return;
    setSolanaExecutionBusy(true);
    setError(null);
    try {
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/observe-solana`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: review.quoteHash, signature: solanaExecutionSignature }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      setSolanaObservation(parseSolanaExecutionObservation(
        await response.json(),
        solanaExecutionSignature,
        review,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Solana execution observation failed closed.");
    } finally {
      setSolanaExecutionBusy(false);
    }
  }

  async function createEvmOptionOrder() {
    if (privateApiBaseUrl === null || selectedEvmOptionProfile === null) return;
    setEvmCreateBusy(true);
    setError(null);
    try {
      if (!evmLifecycleSupported) throw new Error("This option lifecycle action is not available on the atomic EVM lane.");
      if (strategyOwner === null || !OWNER.test(strategyOwner.toLowerCase())) {
        throw new Error("Connect the EVM wallet that will own this option package.");
      }
      if (lifecycleAction !== "ENTRY" && selectedEvmPosition === null) {
        throw new Error("Select an authoritative open option package before creating its transition.");
      }
      const quantityAtoms = fullEvmUnwind
        ? BigInt(selectedEvmPosition!.economicQuantityAtoms)
        : amountToAtoms(evmOptionQuantity, selectedEvmOptionProfile.baseAsset.decimals, "Option quantity");
      if (lifecycleAction === "DECREASE" && quantityAtoms >= BigInt(selectedEvmPosition!.economicQuantityAtoms)) {
        throw new Error("An option decrease must retain an open package quantity. Use exit to close it.");
      }
      const longPremiumAtoms = amountToAtoms(evmLongPremium, selectedEvmOptionProfile.quoteAsset.decimals, "Maximum long premium");
      const shortPremiumAtoms = amountToAtoms(evmShortPremium, selectedEvmOptionProfile.quoteAsset.decimals, "Minimum short premium");
      const maximumTtl = BigInt(selectedEvmOptionProfile.bounds.maximumExpiryTtlSeconds);
      const ttl = maximumTtl < BigInt(600) ? maximumTtl : BigInt(600);
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/evm-option-spread-orders/create`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedEvmOptionProfile.profileId,
          owner: strategyOwner.toLowerCase(),
          lifecycleAction,
          quantityAtoms: quantityAtoms.toString(),
          limitPremiums: [
            { legId: "option-long", quoteAtoms: longPremiumAtoms.toString(), baseAtoms: quantityAtoms.toString() },
            { legId: "option-short", quoteAtoms: shortPremiumAtoms.toString(), baseAtoms: quantityAtoms.toString() },
          ],
          expiryValue: (BigInt(Math.floor(Date.now() / 1_000)) + ttl).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: selectedEvmPosition!.stateHash }),
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const created = parseCreatedEvmOptionOrder(await response.json(), selectedEvmOptionProfile.profileId, lifecycleAction);
      setOrderHash(created.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setEvmProvisioning(null);
      setEvmCollateral(null);
      setEvmCollateralCompletionKey("");
      setEvmExecutionHash(null);
      setEvmExecutionConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM option order creation failed closed.");
    } finally {
      setEvmCreateBusy(false);
    }
  }

  async function createEvmCalendarOrder() {
    if (privateApiBaseUrl === null || selectedEvmCalendarProfile === null) return;
    setEvmCreateBusy(true);
    setError(null);
    try {
      if (!evmLifecycleSupported) {
        throw new Error("This calendar spread lifecycle action is not active.");
      }
      if (strategyOwner === null || !OWNER.test(strategyOwner.toLowerCase())) {
        throw new Error("Connect the EVM wallet that will own this calendar spread.");
      }
      if (lifecycleAction !== "ENTRY" && selectedEvmPosition === null) {
        throw new Error("Select an authoritative open calendar spread before creating its transition.");
      }
      const quantityAtoms = fullEvmUnwind
        ? BigInt(selectedEvmPosition!.economicQuantityAtoms)
        : amountToAtoms(evmCalendarQuantity, selectedEvmCalendarProfile.baseAsset.decimals, "Calendar quantity");
      if (lifecycleAction === "DECREASE" && quantityAtoms >= BigInt(selectedEvmPosition!.economicQuantityAtoms)) {
        throw new Error("A calendar decrease must retain an open package quantity. Use exit to close it.");
      }
      const nearPrice = priceToAtomicRatio(
        evmNearFuturePrice,
        selectedEvmCalendarProfile.baseAsset.decimals,
        selectedEvmCalendarProfile.quoteAsset.decimals,
        12,
        "Near future limit price",
      );
      const farPrice = priceToAtomicRatio(
        evmFarFuturePrice,
        selectedEvmCalendarProfile.baseAsset.decimals,
        selectedEvmCalendarProfile.quoteAsset.decimals,
        12,
        "Far future limit price",
      );
      const nearFuture = selectedEvmCalendarProfile.markets.find((market) => market.role === "near-future");
      if (nearFuture === undefined) throw new Error("The reviewed calendar spread has no near future.");
      const now = BigInt(Math.floor(Date.now() / 1_000));
      const maximumTtl = BigInt(selectedEvmCalendarProfile.bounds.maximumExpiryTtlSeconds);
      const maturityHeadroom = BigInt(nearFuture.maturity) - now - BigInt(1);
      const ttl = [BigInt(600), maximumTtl, maturityHeadroom].reduce(
        (minimum, candidate) => candidate < minimum ? candidate : minimum,
      );
      if (ttl <= BigInt(15)) throw new Error("The near future is too close to maturity for a new package order.");
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/evm-calendar-spread-orders/create`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedEvmCalendarProfile.profileId,
          owner: strategyOwner.toLowerCase(),
          lifecycleAction,
          quantityAtoms: quantityAtoms.toString(),
          limitPrices: [
            { legId: "near-future", ...nearPrice },
            { legId: "far-future", ...farPrice },
          ],
          expiryValue: (now + ttl).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: selectedEvmPosition!.stateHash }),
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const created = parseCreatedEvmCalendarOrder(
        await response.json(),
        selectedEvmCalendarProfile.profileId,
        lifecycleAction,
      );
      setOrderHash(created.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setEvmProvisioning(null);
      setEvmCollateral(null);
      setEvmCollateralCompletionKey("");
      setEvmExecutionHash(null);
      setEvmExecutionConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM calendar spread creation failed closed.");
    } finally {
      setEvmCreateBusy(false);
    }
  }

  async function createEvmDirectionalOrder() {
    if (privateApiBaseUrl === null || selectedEvmDirectionalProfile === null) return;
    setEvmCreateBusy(true);
    setError(null);
    try {
      const resizing = selectedEvmDirectionalProfile.kind === "TREASURY_HEDGE"
        && (lifecycleAction === "INCREASE" || lifecycleAction === "DECREASE");
      if (!evmLifecycleSupported || (lifecycleAction !== "ENTRY" && !fullEvmUnwind && !resizing)) {
        throw new Error("This lifecycle action is not active for the selected EVM strategy lane.");
      }
      if (strategyOwner === null || !OWNER.test(strategyOwner.toLowerCase())) {
        throw new Error("Connect the EVM wallet that will own this strategy package.");
      }
      if (lifecycleAction !== "ENTRY" && selectedEvmPosition === null) {
        throw new Error("Select an authoritative open strategy before creating its transition.");
      }
      const quantityAtoms = fullEvmUnwind
        ? BigInt(selectedEvmPosition!.economicQuantityAtoms)
        : amountToAtoms(evmDirectionalQuantity, selectedEvmDirectionalProfile.baseAsset.decimals, "Package quantity");
      if (lifecycleAction === "DECREASE" && quantityAtoms >= BigInt(selectedEvmPosition!.economicQuantityAtoms)) {
        throw new Error("A treasury hedge decrease must retain an open package quantity. Use exit to close it.");
      }
      const hedgeLimit = priceToAtomicRatio(evmHedgePrice, selectedEvmDirectionalProfile.baseAsset.decimals,
        selectedEvmDirectionalProfile.quoteAsset.decimals, 12, "Hedge limit price");
      const maximumTtl = BigInt(selectedEvmDirectionalProfile.bounds.maximumExpiryTtlSeconds);
      const ttl = maximumTtl < BigInt(600) ? maximumTtl : BigInt(600);
      const collateralConversion = selectedEvmDirectionalProfile.kind === "COLLATERAL_CONVERSION";
      const reverseBasis = selectedEvmDirectionalProfile.kind === "REVERSE_BASIS";
      const route = collateralConversion
        ? "/internal/terminal/evm-collateral-conversion-orders/create"
        : reverseBasis
          ? "/internal/terminal/evm-reverse-basis-orders/create"
          : "/internal/terminal/evm-treasury-hedge-orders/create";
      const response = await fetch(`${privateApiBaseUrl}${route}`, {
        method: "POST", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedEvmDirectionalProfile.profileId,
          owner: strategyOwner.toLowerCase(),
          lifecycleAction,
          quantityAtoms: quantityAtoms.toString(),
          ...(collateralConversion ? {
            limitSwapPrice: priceToAtomicRatio(evmSwapPrice, selectedEvmDirectionalProfile.baseAsset.decimals,
              selectedEvmDirectionalProfile.quoteAsset.decimals, 12, "Swap limit price"),
            limitHedgePrice: hedgeLimit,
          } : reverseBasis ? {
            limitSpotPrice: priceToAtomicRatio(evmSwapPrice, selectedEvmDirectionalProfile.baseAsset.decimals,
              selectedEvmDirectionalProfile.quoteAsset.decimals, 12, "Spot limit price"),
            limitHedgePrice: hedgeLimit,
          } : { limitHedgePrice: hedgeLimit }),
          expiryValue: (BigInt(Math.floor(Date.now() / 1_000)) + ttl).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: selectedEvmPosition!.stateHash }),
        }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const created = parseCreatedEvmDirectionalOrder(await response.json(), selectedEvmDirectionalProfile, lifecycleAction);
      setOrderHash(created.orderHash);
      setQuoteRequestKey("");
      setQuoteReview(null);
      setQuoteHash("");
      setReview(null);
      setEvmProvisioning(null);
      setEvmCollateral(null);
      setEvmCollateralCompletionKey("");
      setEvmExecutionHash(null);
      setEvmExecutionConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM strategy order creation failed closed.");
    } finally {
      setEvmCreateBusy(false);
    }
  }

  async function provisionEvmStrategy() {
    if (privateApiBaseUrl === null || selectedEvmProfile === null || !HASH.test(orderHash)) return;
    setEvmProvisionBusy(true);
    setError(null);
    try {
      if (sendEvmTransaction === undefined || waitForEvmReceipt === undefined) {
        throw new Error("Connect the EVM wallet on the selected strategy testnet.");
      }
      const loadPlan = async () => {
        const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/provision`, {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderHash }),
        });
        if (!response.ok) throw new Error(await failureMessage(response));
        return parseEvmProvisioning(await response.json(), selectedEvmProfile.chainId, strategyOwner ?? "");
      };
      let plan = await loadPlan();
      for (const transaction of plan.transactions) {
        const transactionHash = await sendEvmTransaction(plan.chainId, transaction);
        if (!await waitForEvmReceipt(plan.chainId, transactionHash)) {
          throw new Error(`${transaction.kind.replaceAll("_", " ").toLowerCase()} reverted on the testnet.`);
        }
      }
      plan = await loadPlan();
      if (!plan.ready) throw new Error("Strategy account provisioning has not finalized yet. Retry after the testnet confirms it.");
      setEvmProvisioning(plan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM strategy provisioning failed closed.");
    } finally {
      setEvmProvisionBusy(false);
    }
  }

  async function manageEvmReverseBasisCollateral(action: "SUPPLY" | "WITHDRAW") {
    if (privateApiBaseUrl === null || selectedEvmDirectionalProfile?.kind !== "REVERSE_BASIS"
      || strategyOwner === null || !HASH.test(quoteHash)) return;
    setEvmCollateralBusy(true);
    setError(null);
    try {
      if (sendEvmTransaction === undefined || waitForEvmReceipt === undefined) {
        throw new Error("Connect the EVM wallet on the selected strategy testnet.");
      }
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/reverse-basis-collateral`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash, action }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const plan = parseEvmCollateralPlan(
        await response.json(),
        selectedEvmDirectionalProfile.chainId,
        strategyOwner,
        quoteHash,
        action,
      );
      for (const transaction of plan.transactions) {
        const transactionHash = await sendEvmTransaction(plan.chainId, transaction);
        if (!await waitForEvmReceipt(plan.chainId, transactionHash)) {
          throw new Error(`${transaction.kind.replaceAll("_", " ").toLowerCase()} reverted on the testnet.`);
        }
      }
      setEvmCollateral(plan);
      setEvmCollateralCompletionKey(`${quoteHash}:${action}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM collateral management failed closed.");
    } finally {
      setEvmCollateralBusy(false);
    }
  }

  async function executeEvmStrategy() {
    const evm = review?.domains.length === 1 ? review.domains[0]?.evmAuthorization : null;
    if (privateApiBaseUrl === null || review === null || evm === null || evm === undefined) return;
    setEvmExecutionBusy(true);
    setError(null);
    try {
      if (signEvmStrategyExecution === undefined || sendEvmTransaction === undefined || waitForEvmReceipt === undefined) {
        throw new Error("Connect the EVM wallet on the reviewed strategy testnet.");
      }
      const ownerSignature = await signEvmStrategyExecution(evm.chainId, evm.ownerTypedData);
      const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/authorize-evm`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteHash: review.quoteHash, ownerSignature }),
      });
      if (!response.ok) throw new Error(await failureMessage(response));
      const transaction = parseAuthorizedEvmExecution(await response.json(), review);
      const transactionHash = await sendEvmTransaction(transaction.chainId, transaction);
      setEvmExecutionHash(transactionHash);
      const confirmed = await waitForEvmReceipt(transaction.chainId, transactionHash);
      if (!confirmed) throw new Error("The strategy package transaction reverted on the testnet.");
      await observeEvmStrategy(transactionHash, review.quoteHash);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM strategy execution failed closed.");
    } finally {
      setEvmExecutionBusy(false);
    }
  }

  async function observeEvmStrategy(transactionHash = evmExecutionHash ?? "", observedQuoteHash = review?.quoteHash ?? "") {
    if (privateApiBaseUrl === null || !/^0x[0-9a-f]{64}$/.test(transactionHash) || !HASH.test(observedQuoteHash)) return;
    const response = await fetch(`${privateApiBaseUrl}/internal/terminal/strategy-executions/observe-evm`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteHash: observedQuoteHash, transactionHash }),
    });
    if (response.status === 202) {
      setEvmExecutionConfirmed(false);
      return;
    }
    if (!response.ok) throw new Error(await failureMessage(response));
    if (publicApiBaseUrl === null) throw new Error("Execution finalized, but the public receipt API is unavailable.");
    const receiptResponse = await fetch(`${publicApiBaseUrl}/v1/strategy-receipts/by-quote/${observedQuoteHash}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!receiptResponse.ok) throw new Error("Execution finalized, but its canonical strategy receipt is unavailable.");
    setStrategyReceipt(parseStrategyReceipt(await receiptResponse.json(), observedQuoteHash));
    setEvmExecutionConfirmed(true);
  }

  async function refreshEvmObservation() {
    setEvmExecutionBusy(true);
    setError(null);
    try {
      await observeEvmStrategy();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM strategy observation failed closed.");
    } finally {
      setEvmExecutionBusy(false);
    }
  }

  async function createNativeStrategyOrder() {
    if (privateApiBaseUrl === null || selectedNativeProfile === null) return;
    setNativeCreateBusy(true);
    setError(null);
    try {
      if (strategyOwner === null || !OWNER.test(strategyOwner)) {
        throw new Error("Connect the EVM wallet that will own and authorize this strategy.");
      }
      if (lifecycleAction !== "ENTRY" && lifecycleAction !== "INCREASE"
        && lifecycleAction !== "DECREASE" && lifecycleAction !== "EXIT"
        && lifecycleAction !== "MIGRATE"
        && lifecycleAction !== "REBALANCE"
        && lifecycleAction !== "EMERGENCY_UNWIND") {
        throw new Error("This native strategy profile does not support the selected lifecycle action yet.");
      }
      if (lifecycleAction !== "ENTRY" && selectedNativePosition === null) {
        throw new Error("Select an authoritative open strategy before creating its transition.");
      }
      const fullPosition = lifecycleAction === "EXIT" || lifecycleAction === "MIGRATE"
        || lifecycleAction === "EMERGENCY_UNWIND";
      const quantityAtoms = fullPosition
        ? nativePositionQuantityAtoms(selectedNativePosition!)
        : amountToAtoms(nativeQuantity, selectedNativeProfile.baseAsset.decimals, "Package quantity");
      const economicQuantityAtoms = lifecycleAction === "MIGRATE"
        ? quantityAtoms
        : lifecycleAction === "REBALANCE"
          ? BigInt(selectedNativePosition!.economicQuantityAtoms)
        : fullPosition
        ? BigInt(selectedNativePosition!.economicQuantityAtoms)
        : selectedNativeProfile.templateId === "perpetual-funding-spread-v1"
          ? quantityAtoms
          : amountToAtoms(nativeEconomicQuantity, selectedNativeProfile.baseAsset.decimals, "Inventory exposure");
      if (lifecycleAction === "DECREASE") {
        if (quantityAtoms >= nativePositionQuantityAtoms(selectedNativePosition!)) {
          throw new Error("A decrease must retain an open package quantity. Use exit to close the strategy.");
        }
        if (economicQuantityAtoms >= BigInt(selectedNativePosition!.economicQuantityAtoms)) {
          throw new Error("A decrease must retain positive economic exposure. Use exit to close the strategy.");
        }
      }
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
          ...(lifecycleAction === "REBALANCE" ? {
            adjustmentKind: nativeAdjustmentKind,
            preDeltaAtoms: (BigInt(selectedNativePosition!.economicQuantityAtoms)
              + BigInt(selectedNativePosition!.legs[0]!.signedQuantityAtoms)).toString(),
          } : {}),
          limitPrices,
          expiryValue: (unixTimeMs() + ttlMs).toString(),
          nonce: randomNonce(),
          ...(lifecycleAction === "ENTRY" ? {} : { expectedStrategyStateHash: selectedNativePosition!.stateHash }),
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
      setSolanaExecutionSignature(null);
      setSolanaObservation(null);
      setEvmCollateral(null);
      setEvmCollateralCompletionKey("");
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
      const parsed = parseReview(await response.json(), quoteHash);
      if (parsed.domains.length !== 1 || parsed.domains[0]?.domainId !== expectedDomainId) {
        throw new Error(`Prepared strategy does not belong to the selected ${executionDomain} lane.`);
      }
      setReview(parsed);
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
    && nativeLifecycleSupported
    && strategyOwner !== null
    && OWNER.test(strategyOwner)
    && (lifecycleAction === "ENTRY" ? nativeQuantity.trim() !== "" : selectedNativePosition !== null)
    && ((lifecycleAction === "EXIT" || lifecycleAction === "MIGRATE"
      || lifecycleAction === "EMERGENCY_UNWIND") || nativeQuantity.trim() !== "")
    && ((lifecycleAction === "EXIT" || lifecycleAction === "MIGRATE"
      || lifecycleAction === "EMERGENCY_UNWIND")
      || selectedNativeProfile.templateId === "perpetual-funding-spread-v1"
      || selectedNativeProfile.templateId === "delta-neutral-rebalance-v1"
      || nativeEconomicQuantity.trim() !== "")
    && selectedNativeProfile.markets.every((market) => (nativeLimitPrices[market.role] ?? "").trim() !== "")
    && (lifecycleAction === "ENTRY" || HASH.test(selectedNativePosition?.stateHash ?? ""));
  const solanaFieldsReady = selectedSolanaProfile !== null
    && (lifecycleAction === "ENTRY" || lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND")
    && solanaOwner !== null
    && SOLANA_ADDRESS.test(solanaOwner)
    && (lifecycleAction === "ENTRY" ? solanaQuantity.trim() !== "" : selectedSolanaPosition !== null)
    && solanaHedgePrice.trim() !== "";
  const evmOptionFieldsReady = selectedEvmOptionProfile !== null
    && evmLifecycleSupported
    && strategyOwner !== null
    && OWNER.test(strategyOwner.toLowerCase())
    && (lifecycleAction === "ENTRY" || selectedEvmPosition !== null)
    && (fullEvmUnwind || evmOptionQuantity !== "")
    && evmLongPremium !== ""
    && evmShortPremium !== "";
  const evmCalendarFieldsReady = selectedEvmCalendarProfile !== null
    && evmLifecycleSupported
    && strategyOwner !== null
    && OWNER.test(strategyOwner.toLowerCase())
    && (lifecycleAction === "ENTRY" || selectedEvmPosition !== null)
    && (fullEvmUnwind || evmCalendarQuantity !== "")
    && evmNearFuturePrice !== ""
    && evmFarFuturePrice !== "";
  const evmDirectionalFieldsReady = selectedEvmDirectionalProfile !== null
    && evmLifecycleSupported
    && (lifecycleAction === "ENTRY" || fullEvmUnwind
      || (selectedEvmDirectionalProfile.kind === "TREASURY_HEDGE"
        && (lifecycleAction === "INCREASE" || lifecycleAction === "DECREASE")))
    && strategyOwner !== null
    && OWNER.test(strategyOwner.toLowerCase())
    && (lifecycleAction === "ENTRY" || selectedEvmPosition !== null)
    && (fullEvmUnwind || evmDirectionalQuantity !== "")
    && evmHedgePrice !== ""
    && (selectedEvmDirectionalProfile.kind === "TREASURY_HEDGE" || evmSwapPrice !== "");
  const evmPackageLabel = templateId === "option-spread-v1" ? "option package"
    : templateId === "calendar-spread-v1" ? "calendar spread" : "strategy package";
  const evmReview = review?.domains.length === 1 ? review.domains[0]?.evmAuthorization ?? null : null;
  const solanaReview = review?.domains.length === 1 && review.domains[0]?.kind === "SOLANA_MULTI_STRATEGY_ACCOUNT"
    ? review.domains[0]
    : null;

  if (!laneSupportsTemplate) {
    return (
      <section className={styles.executionReview} aria-labelledby="generalized-strategy-review-title">
        <div className={styles.evidenceHeading}>
          <h3 id="generalized-strategy-review-title">Package quote and execution</h3>
          <span>LANE NOT ACTIVE</span>
        </div>
        <p className={styles.reviewNotice}>
          This strategy has no reviewed execution lane on {executionDomain}. Select a supported chain before creating or authorizing an order.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.executionReview} aria-labelledby="generalized-strategy-review-title">
      <div className={styles.evidenceHeading}>
        <h3 id="generalized-strategy-review-title">Package quote and execution</h3>
        <span>{evmExecutionConfirmed || solanaObservation?.status === "FINALIZED" ? "ONCHAIN CONFIRMED"
          : solanaObservation?.status === "FAILED" ? "FAILED"
          : evmExecutionHash || solanaExecutionSignature ? "SUBMITTED"
          : review && authorizedOrderHash === review.orderHash ? "OWNER AUTHORIZED"
          : review ? "UNSIGNED PLAN" : quoteReview ? "SIGNED QUOTE" : "QUOTE REQUIRED"}</span>
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
      {sourceOrderHash === null && hyperliquidLane && NATIVE_HYPERCORE_TEMPLATES.has(templateId) ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="native-strategy-profile">HyperCore strategy market</label>
          <select
            id="native-strategy-profile"
            value={selectedNativeProfile?.profileId ?? ""}
            disabled={nativeProfiles === null || matchingNativeProfiles.length === 0}
            onChange={(event) => {
              setSelectedNativeProfileId(event.target.value);
              setSelectedNativeStrategyId("");
              setNativeQuantity("");
              setNativeEconomicQuantity("");
              setNativeAdjustmentKind("INCREASE");
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
              {lifecycleAction !== "ENTRY" ? (
                <>
                  <label htmlFor="native-strategy-position">Open strategy package</label>
                  <select
                    id="native-strategy-position"
                    value={selectedNativePosition?.strategyId ?? ""}
                    disabled={nativePositions === null || matchingNativePositions.length === 0}
                    onChange={(event) => {
                      setSelectedNativeStrategyId(event.target.value);
                      setCreatedNativeOrder(null);
                      setOrderHash("");
                      setError(null);
                    }}
                  >
                    {matchingNativePositions.length === 0 ? <option value="">No open package matches this market</option> : null}
                    {matchingNativePositions.map((position) => (
                      <option key={position.strategyId} value={position.strategyId}>
                        {compact(position.strategyId, 18, 8)} / {compact(position.stateHash, 8, 6)}
                      </option>
                    ))}
                  </select>
                  {selectedNativePosition ? (
                    <p className={styles.fieldContext}>
                      {lifecycleAction.toLowerCase()} is bound to state {compact(selectedNativePosition.stateHash)}. Market identity comes from its finalized position state.
                    </p>
                  ) : (
                    <p className={styles.fieldContext} role="status">
                      {nativePositions === null ? "Loading authoritative open strategies." : nativePositionError ?? "No open strategy matches this reviewed market."}
                    </p>
                  )}
                </>
              ) : null}
              {selectedNativeProfile.templateId === "delta-neutral-rebalance-v1" ? (
                <>
                  <label htmlFor="native-strategy-adjustment-kind">Hedge adjustment</label>
                  <select
                    id="native-strategy-adjustment-kind"
                    value={nativeAdjustmentKind}
                    onChange={(event) => {
                      setNativeAdjustmentKind(event.target.value as "INCREASE" | "DECREASE");
                      setCreatedNativeOrder(null);
                      setOrderHash("");
                      setError(null);
                    }}
                  >
                    <option value="INCREASE">Increase hedge</option>
                    <option value="DECREASE">Decrease hedge</option>
                  </select>
                </>
              ) : null}
              <label htmlFor="native-strategy-quantity">Package quantity</label>
              <input
                id="native-strategy-quantity"
                value={(lifecycleAction === "EXIT" || lifecycleAction === "MIGRATE"
                  || lifecycleAction === "EMERGENCY_UNWIND") && selectedNativePosition !== null
                  ? atomsToInput(nativePositionQuantityAtoms(selectedNativePosition).toString(), selectedNativeProfile.baseAsset.decimals)
                  : nativeQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                readOnly={lifecycleAction === "EXIT" || lifecycleAction === "MIGRATE"
                  || lifecycleAction === "EMERGENCY_UNWIND"}
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
                    value={(lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND") && selectedNativePosition !== null
                      ? atomsToInput(selectedNativePosition.economicQuantityAtoms, selectedNativeProfile.baseAsset.decimals)
                      : nativeEconomicQuantity}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    readOnly={lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND"}
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
                    {market.coin} {(lifecycleAction === "MIGRATE"
                      ? market.role === "source-hedge"
                        ? market.entrySide === "BUY" ? "SELL" : "BUY"
                        : market.entrySide
                      : lifecycleAction === "REBALANCE"
                        ? nativeAdjustmentKind === "INCREASE"
                          ? market.entrySide : market.entrySide === "BUY" ? "SELL" : "BUY"
                      : lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                        ? market.entrySide : market.entrySide === "BUY" ? "SELL" : "BUY")} limit price
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
      {sourceOrderHash === null && solanaLane && templateId === "treasury-inventory-hedge-v1" ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="solana-treasury-hedge-profile">Atomic treasury hedge market</label>
          <select
            id="solana-treasury-hedge-profile"
            value={selectedSolanaProfile?.profileId ?? ""}
            disabled={solanaProfiles === null || matchingSolanaProfiles.length === 0}
            onChange={(event) => {
              setSelectedSolanaProfileId(event.target.value);
              setSelectedSolanaPackageId("");
              setOrderHash("");
              setQuoteHash("");
              setQuoteReview(null);
              setReview(null);
              setSolanaProvisioning(null);
              setSolanaExecutionSignature(null);
              setSolanaObservation(null);
              setError(null);
            }}
          >
            {matchingSolanaProfiles.length === 0 ? <option value="">No reviewed Solana market is active</option> : null}
            {matchingSolanaProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>
            ))}
          </select>
          {selectedSolanaProfile ? (
            <>
              <div className={styles.reviewGrid}>
                <span>Domain</span><strong>{selectedSolanaProfile.domainId}</strong>
                <span>Inventory asset</span><strong>{selectedSolanaProfile.inventoryAsset.assetId}</strong>
                <span>Quote asset</span><strong>{selectedSolanaProfile.quoteAsset.assetId}</strong>
                <span>Settlement</span><strong>Atomic postconditions</strong>
              </div>
              {lifecycleAction !== "ENTRY" ? (
                <>
                  <label htmlFor="solana-treasury-hedge-position">Open Solana package</label>
                  <select
                    id="solana-treasury-hedge-position"
                    value={selectedSolanaPosition?.packageId ?? ""}
                    disabled={solanaPositions === null || matchingSolanaPositions.length === 0}
                    onChange={(event) => {
                      setSelectedSolanaPackageId(event.target.value);
                      setOrderHash("");
                      setQuoteHash("");
                      setQuoteReview(null);
                      setReview(null);
                      setSolanaProvisioning(null);
                      setSolanaExecutionSignature(null);
                      setSolanaObservation(null);
                      setError(null);
                    }}
                  >
                    {matchingSolanaPositions.length === 0
                      ? <option value="">No open package matches this market</option> : null}
                    {matchingSolanaPositions.map((position) => (
                      <option key={position.packageId} value={position.packageId}>
                        {compact(position.packageId, 18, 8)} / {compact(position.stateHash, 8, 6)}
                      </option>
                    ))}
                  </select>
                  {selectedSolanaPosition ? (
                    <p className={styles.fieldContext}>
                      {lifecycleAction.toLowerCase()} is bound to finalized state {compact(selectedSolanaPosition.stateHash)}.
                    </p>
                  ) : (
                    <p className={styles.fieldContext} role="status">
                      {solanaPositions === null ? "Loading authoritative open Solana packages."
                        : solanaPositionError ?? "No open Solana package matches this reviewed market."}
                    </p>
                  )}
                </>
              ) : null}
              <label htmlFor="solana-treasury-hedge-quantity">Inventory quantity</label>
              <input
                id="solana-treasury-hedge-quantity"
                value={lifecycleAction !== "ENTRY" && selectedSolanaPosition !== null
                  ? atomsToInput(selectedSolanaPosition.economicQuantityAtoms, selectedSolanaProfile.inventoryAsset.decimals)
                  : solanaQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                readOnly={lifecycleAction !== "ENTRY"}
                onChange={(event) => {
                  setSolanaQuantity(event.target.value.trim());
                  setOrderHash("");
                  setSolanaProvisioning(null);
                  setSolanaExecutionSignature(null);
                  setSolanaObservation(null);
                  setError(null);
                }}
              />
              <p className={styles.fieldContext}>
                Reviewed range {formatAtomicAmount(selectedSolanaProfile.bounds.minimumQuantityAtoms,
                  selectedSolanaProfile.inventoryAsset.decimals, selectedSolanaProfile.inventoryAsset.assetId)} to {formatAtomicAmount(
                  selectedSolanaProfile.bounds.maximumQuantityAtoms, selectedSolanaProfile.inventoryAsset.decimals,
                  selectedSolanaProfile.inventoryAsset.assetId)}.
              </p>
              <label htmlFor="solana-treasury-hedge-price">
                {lifecycleAction === "ENTRY" ? "Minimum short hedge price" : "Maximum hedge close price"}
              </label>
              <input
                id="solana-treasury-hedge-price"
                value={solanaHedgePrice}
                inputMode="decimal"
                autoComplete="off"
                placeholder={`Price in ${selectedSolanaProfile.quoteAsset.assetId.split(":").at(-1)?.toUpperCase() ?? "quote asset"}`}
                onChange={(event) => {
                  setSolanaHedgePrice(event.target.value.trim());
                  setOrderHash("");
                  setSolanaProvisioning(null);
                  setSolanaExecutionSignature(null);
                  setSolanaObservation(null);
                  setError(null);
                }}
              />
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || solanaCreateBusy || !solanaFieldsReady}
                onClick={() => void createSolanaTreasuryHedgeOrder()}
              >
                {solanaCreateBusy ? "Creating atomic Solana package"
                  : lifecycleAction === "ENTRY" ? "Create atomic Solana package" : "Create atomic Solana exit"}
              </button>
              {HASH.test(orderHash) ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={solanaProvisionBusy || solanaProvisioning?.ready === true}
                  onClick={() => void provisionSolanaTreasuryHedge()}
                >
                  {solanaProvisionBusy ? "Verifying isolated accounts" : solanaProvisioning?.ready
                    ? "Solana strategy accounts ready"
                    : lifecycleAction === "ENTRY" ? "Provision Solana strategy accounts" : "Verify Solana strategy accounts"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {solanaOwner === null
                  ? "Connect the Solana wallet that will own this package."
                  : solanaProvisioning?.ready
                    ? `Strategy account ${compact(solanaProvisioning.strategyAccount, 10, 8)} is ready.`
                    : solanaProvisioning !== null
                      && (solanaProvisioning.inventoryFundingRequiredAtoms !== "0"
                        || solanaProvisioning.quoteFundingRequiredAtoms !== "0")
                      ? `Funding required: ${formatAtomicAmount(solanaProvisioning.inventoryFundingRequiredAtoms,
                        selectedSolanaProfile.inventoryAsset.decimals, selectedSolanaProfile.inventoryAsset.assetId)} and ${formatAtomicAmount(
                        solanaProvisioning.quoteFundingRequiredAtoms, selectedSolanaProfile.quoteAsset.decimals,
                        selectedSolanaProfile.quoteAsset.assetId)}.`
                      : "The wallet provisions isolated inventory, collateral, perpetual, and strategy accounts on Devnet."}
              </p>
            </>
          ) : (
            <p className={styles.fieldContext} role="status">Loading reviewed Solana treasury hedge markets.</p>
          )}
        </div>
      ) : null}
      {sourceOrderHash === null && evmLane && templateId === "option-spread-v1" ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="evm-option-profile">Atomic option market</label>
          <select
            id="evm-option-profile"
            value={selectedEvmOptionProfile?.profileId ?? ""}
            disabled={evmOptionProfiles === null || evmOptionProfiles.length === 0}
            onChange={(event) => {
              setSelectedEvmOptionProfileId(event.target.value);
              setSelectedEvmPackageId("");
              setOrderHash("");
              setEvmProvisioning(null);
              setError(null);
            }}
          >
            {matchingEvmOptionProfiles.length === 0 ? <option value="">No reviewed option market is active on this chain</option> : null}
            {matchingEvmOptionProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>
            ))}
          </select>
          {selectedEvmOptionProfile ? (
            <>
              <div className={styles.reviewGrid}>
                <span>Domain</span><strong>{selectedEvmOptionProfile.domainId}</strong>
                {selectedEvmOptionProfile.markets.map((market) => (
                  <Fragment key={market.role}>
                    <span>{market.role === "option-long" ? "Long strike" : "Short strike"}</span>
                    <strong>{market.strike}</strong>
                  </Fragment>
                ))}
              </div>
              {lifecycleAction !== "ENTRY" ? (
                <>
                  <label htmlFor="evm-option-position">Open option package</label>
                  <select
                    id="evm-option-position"
                    value={selectedEvmPosition?.packageId ?? ""}
                    disabled={evmPositions === null || matchingEvmPositions.length === 0}
                    onChange={(event) => {
                      setSelectedEvmPackageId(event.target.value);
                      setOrderHash("");
                      setEvmProvisioning(null);
                      setError(null);
                    }}
                  >
                    {matchingEvmPositions.length === 0 ? <option value="">No open package matches this market</option> : null}
                    {matchingEvmPositions.map((position) => (
                      <option key={position.packageId} value={position.packageId}>
                        {compact(position.packageId, 18, 8)} / {compact(position.stateHash, 8, 6)}
                      </option>
                    ))}
                  </select>
                  <p className={styles.fieldContext} role="status">
                    {selectedEvmPosition
                      ? `${lifecycleAction.toLowerCase()} is bound to finalized state ${compact(selectedEvmPosition.stateHash)}.`
                      : evmPositions === null ? "Loading authoritative EVM packages."
                        : evmPositionError ?? "No open package matches this reviewed market."}
                  </p>
                </>
              ) : null}
              <label htmlFor="evm-option-quantity">Package quantity</label>
              <input
                id="evm-option-quantity"
                value={fullEvmUnwind && selectedEvmPosition !== null
                  ? atomsToInput(selectedEvmPosition.economicQuantityAtoms, selectedEvmOptionProfile.baseAsset.decimals)
                  : evmOptionQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                readOnly={fullEvmUnwind}
                onChange={(event) => { setEvmOptionQuantity(event.target.value.trim()); setOrderHash(""); setError(null); }}
              />
              <p className={styles.fieldContext}>
                Reviewed range {formatAtomicAmount(selectedEvmOptionProfile.bounds.minimumQuantityAtoms, selectedEvmOptionProfile.baseAsset.decimals, selectedEvmOptionProfile.baseAsset.assetId)} to {formatAtomicAmount(selectedEvmOptionProfile.bounds.maximumQuantityAtoms, selectedEvmOptionProfile.baseAsset.decimals, selectedEvmOptionProfile.baseAsset.assetId)}.
              </p>
              <label htmlFor="evm-option-long-premium">
                {lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                  ? "Maximum total long premium" : "Minimum total long sale premium"}
              </label>
              <input
                id="evm-option-long-premium"
                value={evmLongPremium}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => { setEvmLongPremium(event.target.value.trim()); setOrderHash(""); setError(null); }}
              />
              <label htmlFor="evm-option-short-premium">
                {lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                  ? "Minimum total short premium" : "Maximum total short close premium"}
              </label>
              <input
                id="evm-option-short-premium"
                value={evmShortPremium}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => { setEvmShortPremium(event.target.value.trim()); setOrderHash(""); setError(null); }}
              />
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || evmCreateBusy || !evmOptionFieldsReady}
                onClick={() => void createEvmOptionOrder()}
              >
                {evmCreateBusy ? "Creating atomic option package" : "Create atomic option package"}
              </button>
              {HASH.test(orderHash) ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={evmProvisionBusy || evmProvisioning?.ready === true}
                  onClick={() => void provisionEvmStrategy()}
                >
                  {evmProvisionBusy ? "Provisioning strategy account" : evmProvisioning?.ready ? "Strategy account ready" : "Provision strategy account"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {strategyOwner === null
                  ? "Connect the EVM wallet that will own this package."
                  : evmProvisioning?.ready
                    ? `Strategy account ${compact(evmProvisioning.strategyAccount, 10, 8)} is ready.`
                    : "The wallet creates one isolated account and its two policy-bound option adapters before execution."}
              </p>
            </>
          ) : (
            <p className={styles.fieldContext} role="status">Loading reviewed EVM option markets.</p>
          )}
        </div>
      ) : null}
      {sourceOrderHash === null && evmLane && templateId === "calendar-spread-v1" ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="evm-calendar-profile">Atomic calendar market</label>
          <select
            id="evm-calendar-profile"
            value={selectedEvmCalendarProfile?.profileId ?? ""}
            disabled={evmCalendarProfiles === null || evmCalendarProfiles.length === 0}
            onChange={(event) => {
              setSelectedEvmCalendarProfileId(event.target.value);
              setSelectedEvmPackageId("");
              setOrderHash("");
              setEvmProvisioning(null);
              setError(null);
            }}
          >
            {matchingEvmCalendarProfiles.length === 0
              ? <option value="">No reviewed calendar market is active on this chain</option> : null}
            {matchingEvmCalendarProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>
            ))}
          </select>
          {selectedEvmCalendarProfile ? (
            <>
              <div className={styles.reviewGrid}>
                <span>Domain</span><strong>{selectedEvmCalendarProfile.domainId}</strong>
                {selectedEvmCalendarProfile.markets.map((market) => (
                  <Fragment key={market.role}>
                    <span>{market.role === "near-future" ? "Near maturity" : "Far maturity"}</span>
                    <strong>{expiryText("EVM_UNIX_SECONDS", market.maturity)}</strong>
                  </Fragment>
                ))}
                <span>Settlement</span><strong>Atomic postconditions</strong>
              </div>
              {lifecycleAction !== "ENTRY" ? (
                <>
                  <label htmlFor="evm-calendar-position">Open calendar spread</label>
                  <select
                    id="evm-calendar-position"
                    value={selectedEvmPosition?.packageId ?? ""}
                    disabled={evmPositions === null || matchingEvmPositions.length === 0}
                    onChange={(event) => {
                      setSelectedEvmPackageId(event.target.value);
                      setOrderHash("");
                      setEvmProvisioning(null);
                      setError(null);
                    }}
                  >
                    {matchingEvmPositions.length === 0
                      ? <option value="">No open calendar spread matches this market</option> : null}
                    {matchingEvmPositions.map((position) => (
                      <option key={position.packageId} value={position.packageId}>
                        {compact(position.packageId, 18, 8)} / {compact(position.stateHash, 8, 6)}
                      </option>
                    ))}
                  </select>
                  <p className={styles.fieldContext} role="status">
                    {selectedEvmPosition
                      ? `${lifecycleAction.toLowerCase()} is bound to finalized state ${compact(selectedEvmPosition.stateHash)}.`
                      : evmPositions === null ? "Loading authoritative EVM packages."
                        : evmPositionError ?? "No open calendar spread matches this reviewed market."}
                  </p>
                </>
              ) : null}
              <label htmlFor="evm-calendar-quantity">Package quantity</label>
              <input
                id="evm-calendar-quantity"
                value={fullEvmUnwind && selectedEvmPosition !== null
                  ? atomsToInput(selectedEvmPosition.economicQuantityAtoms, selectedEvmCalendarProfile.baseAsset.decimals)
                  : evmCalendarQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                readOnly={fullEvmUnwind}
                onChange={(event) => {
                  setEvmCalendarQuantity(event.target.value.trim());
                  setOrderHash("");
                  setError(null);
                }}
              />
              <p className={styles.fieldContext}>
                Reviewed range {formatAtomicAmount(
                  selectedEvmCalendarProfile.bounds.minimumQuantityAtoms,
                  selectedEvmCalendarProfile.baseAsset.decimals,
                  selectedEvmCalendarProfile.baseAsset.assetId,
                )} to {formatAtomicAmount(
                  selectedEvmCalendarProfile.bounds.maximumQuantityAtoms,
                  selectedEvmCalendarProfile.baseAsset.decimals,
                  selectedEvmCalendarProfile.baseAsset.assetId,
                )}.
              </p>
              <label htmlFor="evm-near-future-price">
                {lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                  ? "Maximum near future purchase price" : "Minimum near future sale price"}
              </label>
              <input
                id="evm-near-future-price"
                value={evmNearFuturePrice}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => {
                  setEvmNearFuturePrice(event.target.value.trim());
                  setOrderHash("");
                  setError(null);
                }}
              />
              <label htmlFor="evm-far-future-price">
                {lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                  ? "Minimum far future sale price" : "Maximum far future purchase price"}
              </label>
              <input
                id="evm-far-future-price"
                value={evmFarFuturePrice}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => {
                  setEvmFarFuturePrice(event.target.value.trim());
                  setOrderHash("");
                  setError(null);
                }}
              />
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || evmCreateBusy || !evmCalendarFieldsReady}
                onClick={() => void createEvmCalendarOrder()}
              >
                {evmCreateBusy ? "Creating atomic calendar spread" : "Create atomic calendar spread"}
              </button>
              {HASH.test(orderHash) ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={evmProvisionBusy || evmProvisioning?.ready === true}
                  onClick={() => void provisionEvmStrategy()}
                >
                  {evmProvisionBusy ? "Provisioning strategy account" : evmProvisioning?.ready
                    ? "Strategy account ready" : "Provision strategy account"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {strategyOwner === null
                  ? "Connect the EVM wallet that will own this calendar spread."
                  : evmProvisioning?.ready
                    ? `Strategy account ${compact(evmProvisioning.strategyAccount, 10, 8)} is ready.`
                    : "The wallet creates one isolated account and two policy-bound future adapters before execution."}
              </p>
            </>
          ) : (
            <p className={styles.fieldContext} role="status">Loading reviewed EVM calendar markets.</p>
          )}
        </div>
      ) : null}
      {sourceOrderHash === null && evmLane
        && (templateId === "treasury-inventory-hedge-v1" || templateId === "collateral-conversion-hedge-v1"
          || templateId === "reverse-cash-and-carry-v1") ? (
        <div className={styles.strategyPrepareForm}>
          <label htmlFor="evm-directional-profile">
            {templateId === "treasury-inventory-hedge-v1" ? "Atomic treasury hedge market"
              : templateId === "collateral-conversion-hedge-v1" ? "Atomic conversion market"
                : "Atomic reverse basis market"}
          </label>
          <select
            id="evm-directional-profile"
            value={selectedEvmDirectionalProfile?.profileId ?? ""}
            disabled={evmDirectionalProfiles === null || matchingEvmDirectionalProfiles.length === 0}
            onChange={(event) => {
              setSelectedEvmDirectionalProfileId(event.target.value);
              setSelectedEvmPackageId("");
              setOrderHash("");
              setEvmProvisioning(null);
              setError(null);
            }}
          >
            {matchingEvmDirectionalProfiles.length === 0 ? <option value="">No reviewed EVM market is active</option> : null}
            {matchingEvmDirectionalProfiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>
            ))}
          </select>
          {selectedEvmDirectionalProfile ? (
            <>
              <div className={styles.reviewGrid}>
                <span>Domain</span><strong>{selectedEvmDirectionalProfile.domainId}</strong>
                <span>Base asset</span><strong>{selectedEvmDirectionalProfile.baseAsset.assetId}</strong>
                <span>Quote asset</span><strong>{selectedEvmDirectionalProfile.quoteAsset.assetId}</strong>
                <span>Settlement</span><strong>Atomic postconditions</strong>
              </div>
              {lifecycleAction !== "ENTRY" ? (
                <>
                  <label htmlFor="evm-directional-position">Open strategy package</label>
                  <select
                    id="evm-directional-position"
                    value={selectedEvmPosition?.packageId ?? ""}
                    disabled={evmPositions === null || matchingEvmPositions.length === 0}
                    onChange={(event) => {
                      setSelectedEvmPackageId(event.target.value);
                      setOrderHash("");
                      setEvmProvisioning(null);
                      setError(null);
                    }}
                  >
                    {matchingEvmPositions.length === 0 ? <option value="">No open package matches this market</option> : null}
                    {matchingEvmPositions.map((position) => (
                      <option key={position.packageId} value={position.packageId}>
                        {compact(position.packageId, 18, 8)} / {compact(position.stateHash, 8, 6)}
                      </option>
                    ))}
                  </select>
                  <p className={styles.fieldContext} role="status">
                    {selectedEvmPosition
                      ? `${lifecycleAction.toLowerCase()} is bound to finalized state ${compact(selectedEvmPosition.stateHash)}.`
                      : evmPositions === null ? "Loading authoritative EVM packages."
                        : evmPositionError ?? "No open package matches this reviewed market."}
                  </p>
                </>
              ) : null}
              <label htmlFor="evm-directional-quantity">Package quantity</label>
              <input
                id="evm-directional-quantity"
                value={fullEvmUnwind && selectedEvmPosition !== null
                  ? atomsToInput(selectedEvmPosition.economicQuantityAtoms, selectedEvmDirectionalProfile.baseAsset.decimals)
                  : evmDirectionalQuantity}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                readOnly={fullEvmUnwind}
                onChange={(event) => { setEvmDirectionalQuantity(event.target.value.trim()); setOrderHash(""); setError(null); }}
              />
              <p className={styles.fieldContext}>
                Reviewed range {formatAtomicAmount(selectedEvmDirectionalProfile.bounds.minimumQuantityAtoms,
                  selectedEvmDirectionalProfile.baseAsset.decimals, selectedEvmDirectionalProfile.baseAsset.assetId)} to {formatAtomicAmount(
                  selectedEvmDirectionalProfile.bounds.maximumQuantityAtoms, selectedEvmDirectionalProfile.baseAsset.decimals,
                  selectedEvmDirectionalProfile.baseAsset.assetId)}.
              </p>
              {selectedEvmDirectionalProfile.kind !== "TREASURY_HEDGE" ? (
                <>
                  <label htmlFor="evm-swap-price">
                    {selectedEvmDirectionalProfile.kind === "REVERSE_BASIS"
                      ? lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                        ? "Minimum spot sale price" : "Maximum spot repurchase price"
                      : lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                        ? "Maximum collateral purchase price" : "Minimum collateral sale price"}
                  </label>
                  <input
                    id="evm-swap-price"
                    value={evmSwapPrice}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    onChange={(event) => { setEvmSwapPrice(event.target.value.trim()); setOrderHash(""); setError(null); }}
                  />
                </>
              ) : null}
              <label htmlFor="evm-hedge-price">
                {selectedEvmDirectionalProfile.kind === "REVERSE_BASIS"
                  ? lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                    ? "Maximum long hedge price" : "Minimum long close price"
                  : lifecycleAction === "ENTRY" || lifecycleAction === "INCREASE"
                    ? "Minimum short hedge price" : "Maximum hedge close price"}
              </label>
              <input
                id="evm-hedge-price"
                value={evmHedgePrice}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                onChange={(event) => { setEvmHedgePrice(event.target.value.trim()); setOrderHash(""); setError(null); }}
              />
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || evmCreateBusy || !evmDirectionalFieldsReady}
                onClick={() => void createEvmDirectionalOrder()}
              >
                {evmCreateBusy ? "Creating atomic package" : "Create atomic strategy package"}
              </button>
              {HASH.test(orderHash) ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={evmProvisionBusy || evmProvisioning?.ready === true}
                  onClick={() => void provisionEvmStrategy()}
                >
                  {evmProvisionBusy ? "Provisioning strategy account" : evmProvisioning?.ready
                    ? "Strategy account ready" : "Provision strategy account"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {strategyOwner === null
                  ? "Connect the EVM wallet that will own this package."
                  : evmProvisioning?.ready
                    ? `Strategy account ${compact(evmProvisioning.strategyAccount, 10, 8)} is ready.`
                    : selectedEvmDirectionalProfile.kind === "COLLATERAL_CONVERSION"
                      ? "The wallet provisions isolated swap, lending, and hedge adapters before execution."
                      : selectedEvmDirectionalProfile.kind === "REVERSE_BASIS"
                        ? "The wallet provisions isolated borrowing, spot, and long hedge adapters. Supply lending collateral before entry."
                        : "The wallet provisions isolated inventory and hedge adapters before execution."}
              </p>
            </>
          ) : (
            <p className={styles.fieldContext} role="status">Loading reviewed EVM strategy markets.</p>
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
            setSolanaExecutionSignature(null);
            setSolanaObservation(null);
            setEvmCollateral(null);
            setEvmCollateralCompletionKey("");
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
          {selectedEvmDirectionalProfile?.kind === "REVERSE_BASIS" && lifecycleAction === "ENTRY" ? (
            <>
              <button
                type="button"
                className={styles.secondaryAction}
                disabled={privateApiBaseUrl === null || evmCollateralBusy || evmProvisioning?.ready !== true
                  || evmCollateralCompletionKey === `${quoteHash}:SUPPLY`}
                onClick={() => void manageEvmReverseBasisCollateral("SUPPLY")}
              >
                {evmCollateralBusy ? "Supplying isolated collateral"
                  : evmCollateralCompletionKey === `${quoteHash}:SUPPLY` ? "Lending collateral supplied"
                    : "Supply isolated lending collateral"}
              </button>
              <p className={styles.fieldContext} role="status">
                {evmCollateralCompletionKey === `${quoteHash}:SUPPLY` && evmCollateral !== null
                  ? `Collateral funding confirmed for strategy account ${compact(evmCollateral.strategyAccount, 10, 8)}.`
                  : "The wallet funds only this package adapter. Entry remains unavailable until collateral confirms."}
              </p>
            </>
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
                setSolanaExecutionSignature(null);
                setSolanaObservation(null);
                setEvmCollateral(null);
                setEvmCollateralCompletionKey("");
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
            setSolanaExecutionSignature(null);
            setSolanaObservation(null);
            setEvmCollateral(null);
            setEvmCollateralCompletionKey("");
            setError(null);
          }}
        />
        <button
          type="button"
          className={styles.secondaryAction}
          disabled={privateApiBaseUrl === null || prepareBusy || !HASH.test(quoteHash)
            || (solanaLane && selectedSolanaProfile !== null && solanaProvisioning?.ready !== true)
            || (selectedEvmProfile !== null && lifecycleAction === "ENTRY" && evmProvisioning?.ready !== true)
            || (selectedEvmDirectionalProfile?.kind === "REVERSE_BASIS" && lifecycleAction === "ENTRY"
              && evmCollateralCompletionKey !== `${quoteHash}:SUPPLY`)}
          onClick={() => void prepare()}
        >
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
          {evmReview ? (
            <>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || evmExecutionBusy || evmExecutionHash !== null}
                onClick={() => void executeEvmStrategy()}
              >
                {evmExecutionBusy ? `Confirming atomic ${evmPackageLabel}`
                  : evmExecutionConfirmed ? `Atomic ${evmPackageLabel} finalized`
                    : evmExecutionHash ? `Atomic ${evmPackageLabel} submitted`
                      : `Sign and execute atomic ${evmPackageLabel}`}
              </button>
              {evmExecutionHash !== null && !evmExecutionConfirmed ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={privateApiBaseUrl === null || evmExecutionBusy}
                  onClick={() => void refreshEvmObservation()}
                >
                  {evmExecutionBusy ? "Checking finalized evidence" : "Refresh finalized receipt"}
                </button>
              ) : null}
              {evmExecutionConfirmed && selectedEvmDirectionalProfile?.kind === "REVERSE_BASIS"
                && (lifecycleAction === "EXIT" || lifecycleAction === "EMERGENCY_UNWIND") ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={privateApiBaseUrl === null || evmCollateralBusy
                    || evmCollateralCompletionKey === `${quoteHash}:WITHDRAW`}
                  onClick={() => void manageEvmReverseBasisCollateral("WITHDRAW")}
                >
                  {evmCollateralBusy ? "Withdrawing isolated collateral"
                    : evmCollateralCompletionKey === `${quoteHash}:WITHDRAW` ? "Lending collateral withdrawn"
                      : "Withdraw lending collateral and yield"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {evmExecutionHash
                  ? `${evmExecutionConfirmed ? "Finalized with canonical receipt" : "Submitted and awaiting finality"} transaction ${compact(evmExecutionHash, 12, 10)} on chain ${evmReview.chainId}.`
                  : `The owner and solver sign the same ${review.domains[0]?.summary ?? "atomic package"}. The wallet submits one transaction.`}
              </p>
            </>
          ) : solanaReview ? (
            <>
              <button
                type="button"
                className={styles.primaryAction}
                disabled={privateApiBaseUrl === null || solanaExecutionBusy
                  || solanaExecutionSignature !== null || solanaProvisioning?.ready !== true}
                onClick={() => void executeSolanaTreasuryHedge()}
              >
                {solanaExecutionBusy ? "Confirming atomic Solana package"
                  : solanaObservation?.status === "FINALIZED" ? "Atomic Solana package finalized"
                    : solanaExecutionSignature ? "Atomic Solana package submitted" : "Sign and submit atomic Solana package"}
              </button>
              {solanaExecutionSignature !== null && solanaObservation?.status !== "FINALIZED"
                && solanaObservation?.status !== "FAILED" ? (
                <button
                  type="button"
                  className={styles.secondaryAction}
                  disabled={privateApiBaseUrl === null || solanaExecutionBusy}
                  onClick={() => void refreshSolanaObservation()}
                >
                  {solanaExecutionBusy ? "Checking finalized evidence" : "Refresh finalized Solana receipt"}
                </button>
              ) : null}
              <p className={styles.fieldContext} role="status">
                {solanaExecutionSignature
                  ? solanaObservation?.status === "FINALIZED"
                    ? `Finalized Devnet transaction ${compact(solanaExecutionSignature, 12, 10)} at slot ${solanaObservation.slot}.`
                    : solanaObservation?.status === "FAILED"
                      ? `Devnet transaction ${compact(solanaExecutionSignature, 12, 10)} failed onchain.`
                      : `Submitted Devnet transaction ${compact(solanaExecutionSignature, 12, 10)}. Finalized package observation is pending.`
                  : `The solver has signed the reviewed ${solanaReview.summary}. Your wallet supplies the owner signature and submits it.`}
              </p>
              {solanaObservation?.status === "FINALIZED" ? (
                <div className={styles.quoteReview}>
                  <div className={styles.reviewEconomics}>
                    <div><span>Venue fees</span><strong>{formatAtomicAmount(
                      solanaObservation.receipt.venueFees.atoms,
                      solanaObservation.receipt.venueFees.decimals,
                      solanaObservation.receipt.venueFees.assetId,
                    )}</strong></div>
                    <div><span>Terminal residual</span><strong>{formatAtomicAmount(
                      solanaObservation.receipt.residualValue.atoms,
                      solanaObservation.receipt.residualValue.decimals,
                      solanaObservation.receipt.residualValue.assetId,
                    )}</strong></div>
                  </div>
                  <div className={styles.reviewGrid}>
                    <span>Operation</span><strong>{solanaObservation.operation}</strong>
                    <span>Strategy account</span><strong title={solanaObservation.strategyAccount}>{compact(solanaObservation.strategyAccount)}</strong>
                    <span>Position</span><strong title={solanaObservation.position}>{compact(solanaObservation.position)}</strong>
                    <span>Receipt account</span><strong title={solanaObservation.receiptAccount}>{compact(solanaObservation.receiptAccount)}</strong>
                    <span>Onchain receipt</span><strong title={solanaObservation.onchainReceiptHash}>{compact(solanaObservation.onchainReceiptHash)}</strong>
                    <span>Evidence root</span><strong title={solanaObservation.evidenceRoot}>{compact(solanaObservation.evidenceRoot)}</strong>
                    <span>Next state</span><strong title={solanaObservation.nextStateHash}>{compact(solanaObservation.nextStateHash)}</strong>
                    <span>Solver</span><strong title={solanaObservation.solver}>{compact(solanaObservation.solver)}</strong>
                  </div>
                  {solanaObservation.receipt.legs.map((leg) => (
                    <div className={styles.reviewGrid} key={leg.legId}>
                      <span>{leg.legId}</span><strong>{leg.status}</strong>
                      <span>Settled</span><strong>{formatAtomicAmount(
                        leg.settled.atoms,
                        leg.settled.decimals,
                        leg.settled.assetId,
                      )}</strong>
                      <span>Venue fee</span><strong>{formatAtomicAmount(
                        leg.venueFee.atoms,
                        leg.venueFee.decimals,
                        leg.venueFee.assetId,
                      )}</strong>
                      <span>Evidence</span><strong title={leg.evidenceHash}>{leg.evidenceGrade} / {compact(leg.evidenceHash)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
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
            </>
          )}
          {!evmReview && !solanaReview && executionAttempt ? (
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
            {evmExecutionConfirmed
              ? "The atomic package executed under the strategy account's onchain call policies and postconditions."
              : solanaObservation?.status === "FINALIZED"
                ? "The exact reviewed Solana instruction finalized and its program-owned receipt passed all commitment and hash checks."
              : solanaObservation?.status === "FAILED"
                ? "The submitted Solana transaction failed. No successful package execution is claimed."
              : solanaExecutionSignature
                ? "The owner and solver signed one atomic Solana Devnet transaction. Finalized onchain receipt evidence remains separate."
              : executionResult
              ? "The testnet executor independently revalidated the selected package before submission."
              : solanaReview
                ? "The reviewed Solana transaction remains unsigned by the owner until wallet confirmation."
              : authorizedOrderHash === review.orderHash
                ? "The owner authorized this exact strategy hash. Selection and testnet execution remain separate fail-closed steps."
                : "This remains an unsigned review until the owner authorizes the exact strategy hash."}
          </p>
        </>
      ) : null}
    </section>
  );
}

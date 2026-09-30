import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { adapterRef, assetAmount, assetRef, domainRef, evidenceManifestHash, exactPrice, exactSignedRate, packageOrderBytes, toHex } from "@naryx/protocol-types";
import type { AcceptedQuoteFeeTerms, EvidenceManifestInput, PackageOrderInput, PackageReceiptInput, TerminalOutcomeInput } from "@naryx/protocol-types";
import { createCanonicalEntryOrder, type ActiveOrderContext } from "../src/index.js";

export const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
export const domain = domainRef("svm:testnet", 1, "11".repeat(32));
export const sol = assetRef("svm:testnet:sol", "22".repeat(32), 9);
export const usdc = assetRef("svm:testnet:usdc", "33".repeat(32), 6);

export function manifest(orderHash: Uint8Array): EvidenceManifestInput {
  return {
    manifestVersion: 1,
    environment: "testnet",
    domain,
    orderHash,
    entries: [
      { sequence: 0n, kind: "ATTEMPT", attemptId: "attempt-1", reference: "attempt-1", contentHash: hash(50), observedAtValue: 10n },
      { sequence: 1n, kind: "CHAIN_TRANSACTION", attemptId: "attempt-1", reference: "tx-1", contentHash: hash(51), observedAtValue: 11n },
    ],
  };
}

export const outcomeEvidence = ["evidenceManifestHash", "orderHash", "terminalState"].map((fieldId) => ({ fieldId, grade: "CONSENSUS_VERIFIED" as const, onchainEnforced: true }));

export function outcome(orderHash: Uint8Array, overrides: Partial<TerminalOutcomeInput> = {}): TerminalOutcomeInput {
  return {
    outcomeVersion: 1,
    environment: "testnet",
    domain,
    orderHash,
    packageTemplateManifestHash: "44".repeat(32),
    templateRegistryReference: hash(4),
    terminalState: "NO_EFFECT",
    attemptIds: ["attempt-1"],
    responseAvailability: "ABSENT",
    responseAbsenceReason: "chain-event-only",
    authoritativeEvidenceRefs: [hash(51)],
    evidenceManifestHash: evidenceManifestHash(manifest(orderHash)),
    residualValuationApplicability: "NOT_APPLICABLE",
    authorizedResidualValue: { availability: "NOT_APPLICABLE" },
    terminalResidualMark: { availability: "NOT_APPLICABLE" },
    issuerKind: "CONSENSUS_EVENT",
    issuer: "verifier-program",
    fieldEvidence: outcomeEvidence,
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

export function receipt(orderHash: Uint8Array, overrides: Partial<PackageReceiptInput> = {}): PackageReceiptInput {
  return {
    receiptVersion: 1,
    environment: "testnet",
    domain,
    attemptIds: ["attempt-1"],
    orderedActionEvidenceRefs: [hash(51)],
    orderedOrderEvidenceRefs: [],
    orderedFillEvidenceRefs: [],
    transactionIds: ["tx-1"],
    evidenceManifestHash: evidenceManifestHash(manifest(orderHash)),
    orderHash,
    quoteHash: hash(2),
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    templateRegistryReference: hash(4),
    solverCapabilityManifestHash: hash(5),
    packageMarketId: "sol-carry",
    owner: "owner",
    solver: "solver-a",
    action: "ENTRY",
    settlementClass: "ATOMIC_POSTCONDITION",
    terminalState: "FINALIZED_COMPLETE",
    quantity: 1_000_000_000n,
    spotVenue: "phoenix",
    perpVenue: "drift",
    spotExecutionPrice: 148_240_000n,
    perpExecutionPrice: 149_070_000n,
    perpPriceEnforcement: "CONTRACT_ENFORCED",
    spotQuoteDelta: -148_240_000n,
    externalQuoteBalanceDelta: -148_240_000n,
    venueWithdrawableQuoteDelta: 0n,
    exitOutcomeSchemaVersion: 1,
    authoritativePreStateRefs: [{ locator: "slot-1", accountKey: "owner", component: "spot-balance", value: 0n, unit: "sol", evidenceHash: hash(54) }],
    authoritativePostStateRefs: [{ locator: "slot-2", accountKey: "owner", component: "spot-balance", value: 1_000_000_000n, unit: "sol", evidenceHash: hash(55) }],
    perpPositionDelta: -1_000_000_000n,
    marginDelta: 20_000_000n,
    matchedPackageNotional: 148_240_000n,
    grossLegNotional: 297_310_000n,
    rawFillFeesByAsset: [assetAmount(usdc, 9_000n)],
    builderFeesByAsset: [],
    normalizedVenueFeesByAsset: [assetAmount(usdc, 9_000n)],
    protocolFee: assetAmount(usdc, 5_000n),
    solverFee: assetAmount(usdc, 10_000n),
    feePolicyVersion: 3,
    feePolicyManifestHash: hash(6),
    maxResidualBaseQuantityObserved: 0n,
    timeUnhedgedMs: 0n,
    recoveryCostByAsset: [],
    recoveryRefundByAsset: [],
    priorityFee: assetAmount(usdc, 5_000n),
    finalityStatus: "FINALIZED",
    fieldEvidence: ["evidenceManifestHash", "orderHash", "protocolFee", "quantity", "quoteHash", "solverFee", "spotExecutionPrice", "terminalState"]
      .map((fieldId) => ({ fieldId, grade: "CONSENSUS_VERIFIED" as const, onchainEnforced: true })),
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

export const terms: AcceptedQuoteFeeTerms = {
  protocolFee: assetAmount(usdc, 5_000n),
  solverFee: assetAmount(usdc, 10_000n),
  feePolicyVersion: 3,
  feePolicyManifestHash: hash(6),
  maxRecoveryCostByAsset: [],
};

export function context(): ActiveOrderContext {
  return Object.freeze({
    contextId: "evidence-context",
    state: "ACTIVE",
    capturedAtClock: 1_000_000n,
    maxStaleness: 1_000_000n,
    domain,
    environment: "testnet",
    orderVersion: 1,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: "44".repeat(32),
    baseAsset: sol,
    quoteAsset: usdc,
    spotAdapters: Object.freeze([adapterRef({ adapterId: "spot-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "55".repeat(32) })]),
    perpAdapters: Object.freeze([adapterRef({ adapterId: "perp-adapter-v1", adapterManifestVersion: 1, adapterManifestHash: "66".repeat(32) })]),
    settlementClass: "ATOMIC_POSTCONDITION",
    expiryUnit: "SOLANA_SLOT",
    expiryTtl: 1_000n,
    spotReferencePrice: exactPrice({ baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 20n, roundingDirection: "CEIL" }),
    maxEntrySpread: exactSignedRate({ baseAsset: sol, quoteAsset: usdc, quoteAtoms: 1n, baseAtoms: 400n, roundingDirection: "CEIL" }),
    maximumQuantityAtoms: 10_000_000_000n,
    maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: Object.freeze([]),
    maxMarginAddedAtoms: 20_000_000n,
    maxProtocolFeeAtoms: 100_000n,
    maxSolverFeeAtoms: 100_000n,
    maxPriorityFeeAtoms: 100_000n,
    minVenueReserveReturnedAtoms: 0n,
    minWalletQuoteBalanceDeltaAtoms: 0n,
    maxResidualBaseQuantityAtoms: 0n,
  });
}

export function signedOrder(idempotencyKey = "evidence-order-0001") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const owner = bs58.encode(raw);
  const active = context();
  const created = createCanonicalEntryOrder((contextId) => (contextId === active.contextId ? active : undefined), {
    contextId: active.contextId,
    owner,
    settlementAccount: owner,
    sizeAtoms: 1_000_000_000n,
    slippageBps: 10,
    idempotencyKey,
    currentClock: 1_000_500n,
  });
  const signOrder = (order: PackageOrderInput) => bs58.encode(sign(null, Buffer.from(packageOrderBytes(order)), privateKey));
  const signBytes = (bytes: Uint8Array) => bs58.encode(sign(null, Buffer.from(bytes), privateKey));
  return { order: created.order as PackageOrderInput, orderHashHex: toHex(created.orderHash), signature: signOrder(created.order), signOrder, signBytes };
}

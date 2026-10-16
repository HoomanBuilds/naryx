export type StrategyReceiptHistoryRow = Readonly<{
  receiptHash: string;
  orderHash: string;
  quoteHash: string;
  templateId: string;
  lifecycleAction: string;
  expectedStateHash: string | null;
  terminalState: string;
  finalityStatus: string;
  domainIds: readonly string[];
  portfolioEligible: boolean;
  executionEvidence: Readonly<{
    routeHash: string;
    solverId: string;
    settlementClass: string;
    legCount: number;
    onchainEnforcedLegCount: number;
    evidenceGrades: readonly string[];
  }>;
  executionEconomics: Readonly<{
    quoteAssetId: string;
    quoteAssetDecimals: number;
    grossLegNotionalAtoms: bigint;
    serviceFeeAtoms: bigint;
    solverFeeAtoms: bigint;
    venueFeeAtoms: bigint;
    networkCostAtoms: bigint;
    recoveryCostAtoms: bigint;
    explicitCostAtoms: bigint;
    terminalResidualValueAtoms: bigint;
  }>;
  recordedAtMs: number;
}>;

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is malformed.`);
  return value as Record<string, unknown>;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.$naryxType === "bigint" && typeof record.value === "string") return BigInt(record.value);
    if (record.$naryxType === "bytes" && typeof record.value === "string") return record.value;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

function exactAtoms(value: unknown, context: string): bigint {
  if (typeof value !== "bigint" || value < BigInt(0)) throw new Error(`${context} is malformed.`);
  return value;
}

function receiptEconomics(value: unknown, context: string): StrategyReceiptHistoryRow["executionEconomics"] {
  const economics = object(value, context);
  if (typeof economics.quoteAssetId !== "string"
    || !/^[\x20-\x7E]{1,128}$/.test(economics.quoteAssetId)
    || typeof economics.quoteAssetDecimals !== "number"
    || !Number.isSafeInteger(economics.quoteAssetDecimals)
    || economics.quoteAssetDecimals < 0
    || economics.quoteAssetDecimals > 255) {
    throw new Error(`${context} quote asset is malformed.`);
  }
  const parsed = Object.freeze({
    quoteAssetId: economics.quoteAssetId,
    quoteAssetDecimals: economics.quoteAssetDecimals,
    grossLegNotionalAtoms: exactAtoms(economics.grossLegNotionalAtoms, `${context} gross leg notional`),
    serviceFeeAtoms: exactAtoms(economics.serviceFeeAtoms, `${context} service fee`),
    solverFeeAtoms: exactAtoms(economics.solverFeeAtoms, `${context} solver fee`),
    venueFeeAtoms: exactAtoms(economics.venueFeeAtoms, `${context} venue fee`),
    networkCostAtoms: exactAtoms(economics.networkCostAtoms, `${context} network cost`),
    recoveryCostAtoms: exactAtoms(economics.recoveryCostAtoms, `${context} recovery cost`),
    explicitCostAtoms: exactAtoms(economics.explicitCostAtoms, `${context} explicit cost`),
    terminalResidualValueAtoms: exactAtoms(economics.terminalResidualValueAtoms, `${context} residual value`),
  });
  if (parsed.explicitCostAtoms !== parsed.serviceFeeAtoms + parsed.solverFeeAtoms + parsed.venueFeeAtoms
    + parsed.networkCostAtoms + parsed.recoveryCostAtoms) {
    throw new Error(`${context} explicit cost does not equal its components.`);
  }
  return parsed;
}

function receiptEvidence(value: unknown, context: string): StrategyReceiptHistoryRow["executionEvidence"] {
  const evidence = object(value, context);
  if (typeof evidence.routeHashHex !== "string" || !/^[0-9a-f]{64}$/.test(evidence.routeHashHex)
    || typeof evidence.solverId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(evidence.solverId)
    || typeof evidence.settlementClass !== "string" || !/^[A-Z_]{1,64}$/.test(evidence.settlementClass)
    || typeof evidence.legCount !== "number" || !Number.isSafeInteger(evidence.legCount) || evidence.legCount < 1 || evidence.legCount > 64
    || typeof evidence.onchainEnforcedLegCount !== "number" || !Number.isSafeInteger(evidence.onchainEnforcedLegCount)
    || evidence.onchainEnforcedLegCount < 0 || evidence.onchainEnforcedLegCount > evidence.legCount
    || !Array.isArray(evidence.evidenceGrades) || evidence.evidenceGrades.length < 1
    || new Set(evidence.evidenceGrades).size !== evidence.evidenceGrades.length
    || !evidence.evidenceGrades.every((grade) => grade === "CONTROLLER_ATTESTED" || grade === "VENUE_API_CORROBORATED" || grade === "CONSENSUS_VERIFIED")) {
    throw new Error(`${context} is malformed.`);
  }
  return Object.freeze({
    routeHash: evidence.routeHashHex,
    solverId: evidence.solverId,
    settlementClass: evidence.settlementClass,
    legCount: evidence.legCount,
    onchainEnforcedLegCount: evidence.onchainEnforcedLegCount,
    evidenceGrades: Object.freeze(evidence.evidenceGrades as string[]),
  });
}

function strategyReceiptHistory(value: unknown, owner: string): readonly StrategyReceiptHistoryRow[] {
  const root = object(decode(value), "Strategy receipt history");
  const expectedOwner = owner.startsWith("0x") ? owner.toLowerCase() : owner;
  if (root.version !== 1 || root.ownerId !== expectedOwner || !Array.isArray(root.receipts)) {
    throw new Error("Strategy receipt history is bound to another owner.");
  }
  return Object.freeze(root.receipts.map((entry, index) => {
    const receipt = object(entry, `Strategy receipt ${index}`);
    const hashes = [receipt.receiptHashHex, receipt.orderHashHex, receipt.quoteHashHex];
    if (!hashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
      || typeof receipt.templateId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(receipt.templateId)
      || typeof receipt.lifecycleAction !== "string" || !/^[A-Z_]{1,32}$/.test(receipt.lifecycleAction)
      || (receipt.expectedStrategyStateHashHex !== null
        && (typeof receipt.expectedStrategyStateHashHex !== "string" || !/^[0-9a-f]{64}$/.test(receipt.expectedStrategyStateHashHex)))
      || typeof receipt.terminalState !== "string" || !/^[A-Z_]{1,40}$/.test(receipt.terminalState)
      || typeof receipt.finalityStatus !== "string" || !/^[A-Z_]{1,24}$/.test(receipt.finalityStatus)
      || !Array.isArray(receipt.domainIds)
      || !receipt.domainIds.every((domainId) => typeof domainId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(domainId))
      || typeof receipt.portfolioEligible !== "boolean"
      || typeof receipt.recordedAtMs !== "number" || !Number.isSafeInteger(receipt.recordedAtMs) || receipt.recordedAtMs < 0) {
      throw new Error(`Strategy receipt ${index} is malformed.`);
    }
    return Object.freeze({
      receiptHash: receipt.receiptHashHex as string,
      orderHash: receipt.orderHashHex as string,
      quoteHash: receipt.quoteHashHex as string,
      templateId: receipt.templateId,
      lifecycleAction: receipt.lifecycleAction,
      expectedStateHash: receipt.expectedStrategyStateHashHex as string | null,
      terminalState: receipt.terminalState,
      finalityStatus: receipt.finalityStatus,
      domainIds: Object.freeze(receipt.domainIds as string[]),
      portfolioEligible: receipt.portfolioEligible,
      executionEvidence: receiptEvidence(receipt.executionEvidence, `Strategy receipt ${index} evidence`),
      executionEconomics: receiptEconomics(receipt.executionEconomics, `Strategy receipt ${index} economics`),
      recordedAtMs: receipt.recordedAtMs,
    });
  }));
}

export async function ownerStrategyReceipts(baseUrl: string, owner: string, signal: AbortSignal) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/owners/${encodeURIComponent(owner)}/strategy-receipts?limit=50`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`Strategy receipt history answered ${response.status}.`);
  return strategyReceiptHistory(await response.json(), owner);
}

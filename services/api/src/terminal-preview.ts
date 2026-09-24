import {
  formatDecimalAtoms,
  multiplyDivideCeil,
  multiplyDivideFloor,
  parseDecimalAtoms,
} from "./decimal.js";
import {
  PRIVATE_TERMINAL_PACKAGE_MANIFEST_V1 as manifest,
  TERMINAL_CAPTURED_AT,
} from "./private-terminal-manifest.js";
import {
  isDomainId,
  isPackageMode,
  isQuoteMode,
  isSlippageBps,
  type PreviewLeg,
  type PreviewRequest,
  type PreviewResponse,
} from "./terminal-types.js";

const REQUEST_KEYS = ["domain", "mode", "quoteMode", "size", "slippageBps"] as const;
const SIZE_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;
const BPS_SCALE = 10_000n;

export class PreviewValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreviewValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePreviewRequest(value: unknown): PreviewRequest {
  if (!isRecord(value)) {
    throw new PreviewValidationError("INVALID_BODY", "Request body must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== REQUEST_KEYS.length ||
      !REQUEST_KEYS.every((key, index) => keys[index] === key)) {
    throw new PreviewValidationError(
      "INVALID_FIELDS",
      "Request must contain only domain, mode, size, slippageBps, and quoteMode.",
    );
  }
  if (!isDomainId(value.domain)) {
    throw new PreviewValidationError("INVALID_DOMAIN", "Domain is not supported.");
  }
  if (!isPackageMode(value.mode)) {
    throw new PreviewValidationError("INVALID_MODE", "Mode must be entry or exit.");
  }
  if (typeof value.size !== "string" || !SIZE_PATTERN.test(value.size)) {
    throw new PreviewValidationError(
      "INVALID_SIZE",
      "Size must be a positive decimal string with at most six decimal places.",
    );
  }
  const sizeAtoms = parseDecimalAtoms(value.size, manifest.baseDecimals);
  if (sizeAtoms <= 0n || sizeAtoms > manifest.maximumSizeAtoms) {
    throw new PreviewValidationError("INVALID_SIZE", "Size is outside the supported range.");
  }
  if (!isSlippageBps(value.slippageBps)) {
    throw new PreviewValidationError("INVALID_SLIPPAGE", "Slippage choice is not supported.");
  }
  if (!isQuoteMode(value.quoteMode)) {
    throw new PreviewValidationError("INVALID_QUOTE_MODE", "Quote mode is not supported.");
  }
  return {
    domain: value.domain,
    mode: value.mode,
    size: value.size,
    slippageBps: value.slippageBps,
    quoteMode: value.quoteMode,
  };
}

function quoteForSize(sizeAtoms: bigint, priceAtoms: bigint, roundUp: boolean): bigint {
  const scale = 10n ** BigInt(manifest.baseDecimals);
  return roundUp
    ? multiplyDivideCeil(sizeAtoms, priceAtoms, scale)
    : multiplyDivideFloor(sizeAtoms, priceAtoms, scale);
}

function feeForNotional(notionalAtoms: bigint, feeBps: bigint): bigint {
  return multiplyDivideCeil(notionalAtoms, feeBps, BPS_SCALE);
}

function displayQuote(atoms: bigint): string {
  return formatDecimalAtoms(atoms, manifest.quoteDecimals);
}

function displayBase(atoms: bigint): string {
  return formatDecimalAtoms(atoms, manifest.baseDecimals);
}

function entryLegs(size: string, slippageBps: bigint): PreviewLeg[] {
  const maximumSpot = multiplyDivideCeil(
    manifest.spotReferenceAtoms,
    BPS_SCALE + slippageBps,
    BPS_SCALE,
  );
  const minimumPerpetual = multiplyDivideFloor(
    manifest.perpetualReferenceAtoms,
    BPS_SCALE - slippageBps,
    BPS_SCALE,
  );
  return [
    {
      sequence: 1,
      action: "Buy spot",
      instrument: "SOL / USDC",
      venue: "Solana spot route fixture",
      quantity: `${size} SOL`,
      limitLabel: "Maximum price",
      limit: `$${displayQuote(maximumSpot)}`,
      state: "Preview ready",
      dependency: "First leg",
    },
    {
      sequence: 2,
      action: "Short perpetual",
      instrument: "SOL-PERP",
      venue: "Hyperliquid testnet route fixture",
      quantity: `${size} SOL`,
      limitLabel: "Minimum entry",
      limit: `$${displayQuote(minimumPerpetual)}`,
      state: "Awaiting leg 1",
      dependency: "Requires accepted spot receipt",
    },
  ];
}

function exitLegs(size: string, slippageBps: bigint): PreviewLeg[] {
  const maximumPerpetual = multiplyDivideCeil(
    manifest.perpetualReferenceAtoms,
    BPS_SCALE + slippageBps,
    BPS_SCALE,
  );
  const minimumSpot = multiplyDivideFloor(
    manifest.spotReferenceAtoms,
    BPS_SCALE - slippageBps,
    BPS_SCALE,
  );
  return [
    {
      sequence: 1,
      action: "Buy to close",
      instrument: "SOL-PERP",
      venue: "Hyperliquid testnet route fixture",
      quantity: `${size} SOL`,
      limitLabel: "Maximum close",
      limit: `$${displayQuote(maximumPerpetual)}`,
      state: "Preview ready",
      dependency: "First leg",
    },
    {
      sequence: 2,
      action: "Sell spot",
      instrument: "SOL / USDC",
      venue: "Solana spot route fixture",
      quantity: `${size} SOL`,
      limitLabel: "Minimum output",
      limit: `$${displayQuote(minimumSpot)}`,
      state: "Awaiting leg 1",
      dependency: "Requires accepted perp close",
    },
  ];
}

export function createTerminalPreview(request: PreviewRequest): PreviewResponse {
  const sizeAtoms = parseDecimalAtoms(request.size, manifest.baseDecimals);
  const normalizedSize = displayBase(sizeAtoms);
  const slippageBps = BigInt(request.slippageBps);
  const spotNotional = quoteForSize(sizeAtoms, manifest.spotReferenceAtoms, true);
  const perpetualNotional = quoteForSize(sizeAtoms, manifest.perpetualReferenceAtoms, true);
  const spotFee = feeForNotional(spotNotional, manifest.spotFeeBps);
  const perpetualFee = feeForNotional(perpetualNotional, manifest.perpetualFeeBps);
  const coordinatorFee = feeForNotional(spotNotional, manifest.coordinatorFeeBps);
  const fees = [
    { label: "Spot venue fee", amountAtoms: spotFee.toString(), value: displayQuote(spotFee) },
    { label: "Perp venue fee", amountAtoms: perpetualFee.toString(), value: displayQuote(perpetualFee) },
    { label: "Coordinator fee", amountAtoms: coordinatorFee.toString(), value: displayQuote(coordinatorFee) },
    {
      label: "Estimated network fees",
      amountAtoms: manifest.networkFeeAtoms.toString(),
      value: displayQuote(manifest.networkFeeAtoms),
    },
  ];
  const totalFeeAtoms = fees.reduce((total, fee) => total + BigInt(fee.amountAtoms), 0n);

  const entryMaximumPrice = multiplyDivideCeil(
    manifest.spotReferenceAtoms,
    BPS_SCALE + slippageBps,
    BPS_SCALE,
  );
  const exitMinimumPrice = multiplyDivideFloor(
    manifest.spotReferenceAtoms,
    BPS_SCALE - slippageBps,
    BPS_SCALE,
  );
  const boundAtoms = request.mode === "entry"
    ? quoteForSize(sizeAtoms, entryMaximumPrice, true)
    : quoteForSize(sizeAtoms, exitMinimumPrice, false);

  return {
    source: "PRIVATE_TERMINAL_BFF",
    environment: "LOCAL_CONFORMANCE",
    capturedAt: TERMINAL_CAPTURED_AT,
    evidenceGrade: "FIXTURE_UNATTESTED",
    executionAvailable: false,
    domain: request.domain,
    mode: request.mode,
    quoteMode: request.quoteMode,
    size: {
      baseAtoms: sizeAtoms.toString(),
      value: normalizedSize,
      symbol: "SOL",
    },
    bound: {
      label: request.mode === "entry" ? "Maximum quote" : "Minimum output",
      quoteAtoms: boundAtoms.toString(),
      value: displayQuote(boundAtoms),
      symbol: "USDC",
    },
    fees,
    totalFee: {
      amountAtoms: totalFeeAtoms.toString(),
      value: displayQuote(totalFeeAtoms),
      symbol: "USDC",
    },
    legs: request.mode === "entry"
      ? entryLegs(normalizedSize, slippageBps)
      : exitLegs(normalizedSize, slippageBps),
    action: {
      available: false,
      reason: "Execution is not available in the private preview service.",
    },
  };
}

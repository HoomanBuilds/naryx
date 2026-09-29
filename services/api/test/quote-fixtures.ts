import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  adapterRef,
  assetAmount,
  assetRef,
  exactPrice,
  payloadTemplateHash,
  routeHash,
  solverSignatureDigest,
  versionedManifestRef,
  type AssetAmount,
  type DomainRef,
  type ExpiryUnit,
  type QuoteMode,
  type RoundingDirection,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";

const hash = (byte: string): string => byte.repeat(64);

/** A valid atomic cash-and-carry route bound to one order, adapted from the kernel's route vector. */
export function routeFor(orderHash: Uint8Array | string, domain: DomainRef, environment: string, overrides: Partial<RoutePayloadInput> = {}): RoutePayloadInput {
  const sol = assetRef("sol", hash("1"), 9);
  const usdc = assetRef("usdc", hash("2"), 6);
  const spotAdapter = adapterRef({ adapterId: "phoenix-spot", adapterManifestVersion: 1, adapterManifestHash: hash("4") });
  const perpAdapter = adapterRef({ adapterId: "phoenix-perp", adapterManifestVersion: 1, adapterManifestHash: hash("5") });
  const price = exactPrice({ baseAsset: sol, quoteAsset: usdc, quoteAtoms: 3n, baseAtoms: 2n, roundingDirection: "CEIL" });
  const leg = (legIndex: number, legRole: "SPOT" | "PERPETUAL", side: "BUY" | "SELL", adapter: typeof spotAdapter, venue: string, market: string) => ({
    legIndex,
    legRole,
    actionSequence: legIndex,
    adapter,
    venue: versionedManifestRef(venue, 1, hash(String(6 + legIndex))),
    market: versionedManifestRef(market, 1, hash(String(8 + legIndex))),
    baseAsset: sol,
    quoteAsset: usdc,
    side,
    quantity: { asset: sol, atoms: 1_000_000_000n },
    limitPrice: price,
    timeInForce: "FOK" as const,
    reduceOnly: false,
  });
  const action = (sequence: number, legIndex: number, adapter: typeof spotAdapter, target: string, classId: string) => ({
    sequence,
    actionClassId: classId,
    legIndex,
    adapter,
    targetBindingId: target,
    authorityBindingId: "trader-authority",
    accountMetas: [
      { routeBindingId: target, isSigner: false, isWritable: false },
      { routeBindingId: "trader-authority", isSigner: true, isWritable: true },
    ],
    payload: { codecId: "svm-instruction-v1", templateLength: 3, templateHash: payloadTemplateHash(Uint8Array.from([9, 8, 7 - sequence]), []), lateBoundFields: [] },
  });
  return {
    version: 1,
    environment,
    domain,
    orderHash,
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    packageTemplateManifestHash: hash("b"),
    templateRegistryRecordHash: hash("c"),
    owner: "trader-wallet",
    settlementAccount: "strategy-account-1",
    solver: "solver-a",
    direction: "LONG_SPOT_SHORT_PERP",
    action: "ENTRY",
    quantityPolicyClass: "EXACT_ATOMIC",
    partialFillPolicy: "EXACT_ALL_LEGS",
    settlementClass: "ATOMIC_POSTCONDITION",
    executionPlanKind: "SVM_ATOMIC_CPI",
    routeExpiryUnit: "SOLANA_SLOT",
    routeExpiryValue: 500_000n,
    feePolicyVersion: 2,
    feePolicyManifestHash: hash("d"),
    accountBindings: [
      { routeBindingId: "trader-authority", accountIdentity: "trader-wallet", authorityIdentity: "trader-wallet" },
      { routeBindingId: "spot-program", adapter: spotAdapter, adapterBindingId: "market-program", accountIdentity: "phoenix-program", codeIdentity: "phoenix-code-v1" },
      { routeBindingId: "perp-program", adapter: perpAdapter, adapterBindingId: "market-program", accountIdentity: "phoenix-perp-program", codeIdentity: "phoenix-perp-code-v1" },
    ],
    serviceCharges: [],
    preconditions: [
      {
        constraintId: "pre-trader-authorized",
        ruleId: "authority-equals-owner-v1",
        accountBindingId: "trader-authority",
        componentId: "is-authorized",
        comparator: "EQ",
        value: { kind: "BOOLEAN", value: true },
        evidenceRequirementId: "authority-state",
      },
    ],
    legs: [leg(0, "SPOT", "BUY", spotAdapter, "phoenix", "sol-usdc-spot"), leg(1, "PERPETUAL", "SELL", perpAdapter, "phoenix-perps", "sol-usdc-perp")],
    actions: [action(0, 0, spotAdapter, "spot-program", "svm-cpi-spot-v1"), action(1, 1, perpAdapter, "perp-program", "svm-cpi-perp-v1")],
    postconditions: [
      {
        constraintId: "post-perp-position",
        ruleId: "position-delta-v1",
        accountBindingId: "perp-program",
        componentId: "base-position-delta",
        comparator: "EQ",
        value: { kind: "SIGNED_ASSET_AMOUNT", value: assetAmount(sol, -1_000_000_000n) },
        evidenceRequirementId: "perp-position-state",
      },
    ],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: "svm-atomic-evidence-v1",
      requiredPreStateComponentIds: ["authority-state"],
      requiredPostStateComponentIds: ["perp-position-state"],
      requiredActionEvidenceTypeIds: ["cpi-result"],
      stateReferenceSchemaHash: hash("e"),
      receiptSchemaHash: hash("f"),
      outcomeSchemaHash: `01${"0".repeat(62)}`,
    },
    ...overrides,
  };
}

type Fixture = Record<string, any>;
const QUOTE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../packages/protocol-types/fixtures/solver-quote.json", import.meta.url), "utf8"),
) as Fixture;
const asset = (value: Fixture) => assetRef(value.assetId, value.assetManifestHash, value.decimals);
const amount = (value: Fixture): AssetAmount => assetAmount(asset(value.asset), BigInt(value.atoms));

/**
 * A solver quote from the kernel's committed quote vector, rebound to an order, route, solver,
 * manifest, and quote key, and signed over its solver signature digest.
 */
export function signedQuoteFor(input: {
  readonly orderHash: Uint8Array | string;
  readonly route: RoutePayloadInput;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly solverId: string;
  readonly manifestHash: string;
  readonly quoteKey: KeyObject;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly quoteMode?: QuoteMode;
  readonly reservationId?: string;
  readonly quoteNonce?: bigint;
}): SolverQuoteInput {
  const f = QUOTE_FIXTURE;
  const raw = new Uint8Array((createPublicKey(input.quoteKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  const unsigned: SolverQuoteInput = {
    version: Number(f.version),
    environment: input.environment,
    domain: input.domain,
    orderHash: input.orderHash,
    solverId: input.solverId,
    solverCapabilityManifestHash: input.manifestHash,
    solverSignatureScheme: "ED25519",
    solverVerificationKey: raw,
    quoteMode: input.quoteMode ?? "EXECUTION_COMMITMENT",
    routeHash: routeHash(input.route),
    quotedOutcome: {
      kind: "ENTRY_SPREAD",
      entrySpread: {
        baseAsset: asset(f.quotedOutcome.entrySpread.baseAsset),
        quoteAsset: asset(f.quotedOutcome.entrySpread.quoteAsset),
        quoteAtoms: BigInt(f.quotedOutcome.entrySpread.quoteAtoms),
        baseAtoms: BigInt(f.quotedOutcome.entrySpread.baseAtoms),
        roundingDirection: f.quotedOutcome.entrySpread.roundingDirection as RoundingDirection,
      },
    },
    expectedSpotNotional: amount(f.expectedSpotNotional),
    expectedPerpNotional: amount(f.expectedPerpNotional),
    expectedGrossSpotQuantity: amount(f.expectedGrossSpotQuantity),
    expectedNetSpotQuantity: amount(f.expectedNetSpotQuantity),
    expectedBaseAssetFee: amount(f.expectedBaseAssetFee),
    expectedMarginDelta: amount(f.expectedMarginDelta),
    expectedRawFillFeesByAsset: f.expectedRawFillFeesByAsset.map(amount),
    expectedBuilderFeesByAsset: f.expectedBuilderFeesByAsset.map(amount),
    expectedNormalizedVenueFeesByAsset: f.expectedNormalizedVenueFeesByAsset.map(amount),
    solverFee: amount(f.solverFee),
    protocolFee: amount(f.protocolFee),
    expectedPriorityFee: amount(f.expectedPriorityFee),
    maxRecoveryCostAtomsByAsset: f.maxRecoveryCostAtomsByAsset.map((cap: Fixture) => ({ asset: asset(cap.asset), maxAtoms: BigInt(cap.maxAtoms) })),
    feePolicyVersion: Number(f.feePolicyVersion),
    feePolicyManifestHash: f.feePolicyManifestHash,
    validUntilUnit: input.validUntilUnit,
    validUntilValue: input.validUntilValue,
    ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
    quoteNonce: input.quoteNonce ?? BigInt(f.quoteNonce),
    signature: new Uint8Array(64),
  };
  return { ...unsigned, signature: new Uint8Array(sign(null, solverSignatureDigest(unsigned), input.quoteKey)) };
}


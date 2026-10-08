import bs58 from "bs58";
import {
  bytesEqual,
  commitmentHash,
  netObligations,
  nettingInstrumentHash,
  nettingPolicyManifest,
  nettingPolicyManifestHash,
  packageGraph,
  packageGraphHash,
  packageSettlementCommitmentBytes,
  packageSettlementCommitmentHash,
  toHex,
  type NettingObligationInput,
  type NettingPolicyManifestInput,
  type AssetRef,
} from "@naryx/protocol-types";
import { verifyEd25519 } from "./ed25519.js";
import {
  verifyEvmPackageSettlementAuthorization,
} from "./package-book-authorization.js";
import type {
  PackageSettlementAuthorizationEvidence,
  PreparedNettingBatch,
  SqlitePackageExchangeStore,
} from "./package-exchange-store.js";
import type { SqliteStrategyPackageStore } from "./strategy-package-store.js";

export class AuthoritativeNettingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthoritativeNettingError";
    this.code = code;
  }
}

export interface AuthoritativeNettingExchangePort extends Pick<
  SqlitePackageExchangeStore,
  | "settlementCommitment"
  | "settlementAuthorization"
  | "settlementProgress"
  | "recordPreparedNettingBatch"
  | "nettingBatch"
> {}

export interface AuthoritativeNettingStrategyPort extends Pick<SqliteStrategyPackageStore, "order"> {}

export interface PrepareAuthoritativeNettingBatchInput {
  readonly packageOrderIds: readonly (Uint8Array | string)[];
  readonly policy: NettingPolicyManifestInput;
}

export interface PrepareAuthoritativeNettingBatchResult {
  readonly batch: PreparedNettingBatch;
  readonly replayed: boolean;
}

function fail(code: string, message: string): never {
  throw new AuthoritativeNettingError(code, message);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function priceTicks(
  leg: ReturnType<typeof packageGraph>["legs"][number],
  instrument: ReturnType<typeof nettingPolicyManifest>["instruments"][number],
  packageOrderIdHex: string,
): bigint {
  const limit = leg.limitPrice;
  if (limit === undefined) {
    fail("UNBOUNDED_NETTING_LEG", `Package ${packageOrderIdHex} leg ${leg.legId} has no exact limit price.`);
  }
  if (!sameAsset(limit.baseAsset, instrument.quantityAsset) || !sameAsset(limit.quoteAsset, instrument.quoteAsset)) {
    fail("PRICE_ASSET_MISMATCH", `Package ${packageOrderIdHex} leg ${leg.legId} limit price uses another asset pair.`);
  }
  const numerator = limit.quoteAtoms * instrument.quantityIncrementAtoms;
  const denominator = limit.baseAtoms * instrument.priceTickQuoteAtoms;
  if (numerator % denominator !== 0n) {
    fail("OFF_TICK_LIMIT", `Package ${packageOrderIdHex} leg ${leg.legId} limit price is off the signed price lattice.`);
  }
  const ticks = numerator / denominator;
  if (ticks === 0n || ticks >= (1n << 128n)) {
    fail("INVALID_LIMIT", `Package ${packageOrderIdHex} leg ${leg.legId} limit price is outside the supported range.`);
  }
  return ticks;
}

async function verifiesAuthorization(
  evidence: PackageSettlementAuthorizationEvidence,
  commitment: NonNullable<ReturnType<AuthoritativeNettingExchangePort["settlementCommitment"]>>,
): Promise<boolean> {
  if (
    evidence.packageOrderIdHex !== toHex(commitment.packageOrderId)
    || evidence.settlementCommitmentHashHex !== toHex(packageSettlementCommitmentHash(commitment))
    || evidence.participantId !== commitment.participantId
  ) return false;
  if (evidence.scheme === "EIP712_SECP256K1") {
    return verifyEvmPackageSettlementAuthorization(commitment, evidence.signature);
  }
  try {
    const publicKey = bs58.decode(commitment.participantId);
    const signature = bs58.decode(evidence.signature);
    return publicKey.length === 32
      && signature.length === 64
      && bs58.encode(publicKey) === commitment.participantId
      && bs58.encode(signature) === evidence.signature
      && verifyEd25519(publicKey, packageSettlementCommitmentBytes(commitment), signature);
  } catch {
    return false;
  }
}

/**
 * Derives a netting batch only from admitted strategy orders, fully allocated package-book state,
 * and the exact wallet authorization already attached to each settlement commitment.
 */
export async function prepareAuthoritativeNettingBatch(
  exchange: AuthoritativeNettingExchangePort,
  strategies: AuthoritativeNettingStrategyPort,
  input: PrepareAuthoritativeNettingBatchInput,
): Promise<PrepareAuthoritativeNettingBatchResult> {
  if (!Array.isArray(input.packageOrderIds) || input.packageOrderIds.length === 0) {
    fail("INVALID_BATCH", "A netting batch must name at least one package order.");
  }
  const policy = nettingPolicyManifest(input.policy, "authoritativeNetting.policy");
  const policyHash = nettingPolicyManifestHash(policy);
  const packageOrderIds = input.packageOrderIds.map((value) => toHex(commitmentHash(value)));
  if (new Set(packageOrderIds).size !== packageOrderIds.length) {
    fail("INVALID_BATCH", "Package order ids repeat.");
  }

  const sources: {
    packageOrderIdHex: string;
    strategyOrderHashHex: string;
    settlementReadinessHashHex: string;
    authorizedAtMs: number;
    fillSequence: bigint;
    obligations: Omit<NettingObligationInput, "sequence">[];
  }[] = [];

  for (const packageOrderIdHex of packageOrderIds) {
    const commitment = exchange.settlementCommitment(packageOrderIdHex);
    const authorization = exchange.settlementAuthorization(packageOrderIdHex);
    const progress = exchange.settlementProgress(packageOrderIdHex);
    if (commitment === undefined || authorization === undefined || progress === undefined) {
      fail("PACKAGE_NOT_READY", `Package ${packageOrderIdHex} lacks durable settlement evidence.`);
    }
    if (!(await verifiesAuthorization(authorization, commitment))) {
      fail("INVALID_AUTHORIZATION", `Package ${packageOrderIdHex} has no valid owner authorization.`);
    }
    if (progress.readiness.status !== "READY_FOR_OWNER_AUTHORIZATION" || progress.obligations.length === 0) {
      fail("PACKAGE_NOT_READY", `Package ${packageOrderIdHex} is not fully allocated.`);
    }
    const strategyOrderHashHex = toHex(commitment.strategyOrderHash);
    const stored = strategies.order(strategyOrderHashHex);
    if (stored === undefined) fail("STRATEGY_ORDER_NOT_FOUND", `Package ${packageOrderIdHex} has no admitted strategy order.`);
    const order = stored.order;
    const graph = packageGraph(stored.graph, `authoritativeNetting.graph.${packageOrderIdHex}`);
    if (
      commitment.environment !== policy.environment
      || commitment.executionClassId !== policy.executionClassId
      || order.environment !== policy.environment
      || order.executionClassId !== policy.executionClassId
      || order.executionClassVersion !== policy.executionClassVersion
      || !bytesEqual(order.executionClassManifestHash, policy.executionClassManifestHash)
      || order.settlementClass !== policy.settlementClass
      || graph.environment !== policy.environment
      || graph.executionClassId !== policy.executionClassId
      || graph.executionClassVersion !== policy.executionClassVersion
      || !bytesEqual(graph.executionClassManifestHash, policy.executionClassManifestHash)
      || graph.settlementClass !== policy.settlementClass
      || !bytesEqual(graph.policyHashes.netting, policyHash)
    ) {
      fail("POLICY_MISMATCH", `Package ${packageOrderIdHex} is not authorized for this netting policy.`);
    }
    if (
      !bytesEqual(order.graphHash, packageGraphHash(graph))
      || !bytesEqual(commitment.graphHash, order.graphHash)
      || commitment.participantId !== order.owner
      || graph.owner !== order.owner
      || commitment.settlementAccount !== order.settlementAccount
      || commitment.quantity !== order.economicQuantity.atoms
      || !bytesEqual(progress.readiness.strategyOrderHash, commitment.strategyOrderHash)
      || !bytesEqual(progress.readiness.packageOrderId, commitment.packageOrderId)
    ) {
      fail("PACKAGE_MISMATCH", `Package ${packageOrderIdHex} differs from its admitted strategy graph or readiness evidence.`);
    }

    const obligations: Omit<NettingObligationInput, "sequence">[] = [];
    for (const leg of graph.legs) {
      if (leg.side === "NONE") continue;
      const instrument = policy.instruments.find((candidate) => bytesEqual(
        candidate.instrumentHash,
        nettingInstrumentHash({
          instrumentId: candidate.instrumentId,
          domain: leg.domain,
          adapter: leg.adapter,
          venue: leg.venue,
          market: leg.market,
          quantityAsset: leg.quantityAsset,
          quoteAsset: candidate.quoteAsset,
          legFamily: leg.legFamily,
          quantityIncrementAtoms: candidate.quantityIncrementAtoms,
          priceTickQuoteAtoms: candidate.priceTickQuoteAtoms,
        }),
      ));
      if (instrument === undefined) {
        fail("UNSUPPORTED_LEG", `Package ${packageOrderIdHex} leg ${leg.legId} is outside the signed netting policy.`);
      }
      obligations.push(Object.freeze({
        ownerId: commitment.participantId,
        strategyOrderHash: commitment.strategyOrderHash,
        packageOrderId: commitment.packageOrderId,
        settlementReadinessHash: progress.readinessHashHex,
        legId: leg.legId,
        instrumentId: instrument.instrumentId,
        signedQuantityAtoms: leg.side === "BUY" ? leg.quantityAtoms : -leg.quantityAtoms,
        limitPriceTicks: priceTicks(leg, instrument, packageOrderIdHex),
      }));
    }
    if (obligations.length === 0) {
      fail("UNSUPPORTED_PACKAGE", `Package ${packageOrderIdHex} has no nettable trade leg.`);
    }
    const fillSequence = progress.obligations.reduce(
      (minimum, obligation) => obligation.fillSequence < minimum ? obligation.fillSequence : minimum,
      progress.obligations[0]!.fillSequence,
    );
    sources.push({
      packageOrderIdHex,
      strategyOrderHashHex,
      settlementReadinessHashHex: progress.readinessHashHex,
      authorizedAtMs: authorization.authorizedAtMs,
      fillSequence,
      obligations,
    });
  }

  const earliestAuthorization = sources.reduce((minimum, source) => Math.min(minimum, source.authorizedAtMs), Number.MAX_SAFE_INTEGER);
  const latestAuthorization = sources.reduce((maximum, source) => Math.max(maximum, source.authorizedAtMs), 0);
  if (BigInt(latestAuthorization - earliestAuthorization) > policy.maximumBatchWindowMilliseconds) {
    fail("BATCH_WINDOW_EXCEEDED", "Package authorizations exceed the signed netting batch window.");
  }
  const sequenced = sources
    .flatMap((source) => source.obligations.map((obligation) => ({ source, obligation })))
    .sort((left, right) => {
      if (left.source.fillSequence !== right.source.fillSequence) return left.source.fillSequence < right.source.fillSequence ? -1 : 1;
      const packageOrderComparison = left.source.packageOrderIdHex.localeCompare(right.source.packageOrderIdHex);
      return packageOrderComparison !== 0 ? packageOrderComparison : left.obligation.legId.localeCompare(right.obligation.legId);
    })
    .map(({ obligation }, index): NettingObligationInput => Object.freeze({ ...obligation, sequence: BigInt(index + 1) }));
  const result = netObligations(sequenced, policy);
  return exchange.recordPreparedNettingBatch({
    policy,
    result,
    packages: sources.map((source) => ({
      packageOrderIdHex: source.packageOrderIdHex,
      strategyOrderHashHex: source.strategyOrderHashHex,
      settlementReadinessHashHex: source.settlementReadinessHashHex,
    })),
  });
}

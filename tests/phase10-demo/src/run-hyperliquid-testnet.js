import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  HyperliquidSdkTestnetAuthorityReader,
  HyperliquidRecoveryTestnetHttpExecution,
  HYPERLIQUID_TESTNET_MARKET_INFO_URL,
  HyperliquidTestnetHttpExchangeTransport,
  HyperliquidSdkTestnetMarketReadClient,
  createHyperliquidTestnetExecutor,
  hyperliquidTestnetAccountInventory,
  loadHyperliquidTestnetAgentSigner,
  loadHyperliquidTestnetExecutorRuntime,
} from "../../../services/solver/dist/index.js";
import {
  HYPERCORE_RECONCILIATION_SOURCE,
  HyperliquidRecoveryCompiler,
  beginHyperliquidReconciliation,
  createHyperliquidPackageAttempt,
  reconcileHyperliquidPackageAttempt,
} from "../../../services/keeper/dist/index.js";
import {
  boundedIocPrice,
  buildCashCarryPlan,
  buildCashCarryRecoverySourcePlan,
} from "./hyperliquid-testnet-plan.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (!process.argv.includes("--execute")
  || process.env.NARYX_DEMO_NETWORK_POLICY !== "TESTNET_WRITES_EXPLICITLY_ENABLED") {
  throw new Error("Hyperliquid Testnet execution requires --execute and explicit testnet write policy");
}
if (required("NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT") !== "TESTNET") {
  throw new Error("only Hyperliquid Testnet is supported");
}

const masterAccount = required("NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT");
const tradingAccount = required("NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT");
const agentAddress = required("NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS");
const keyPath = required("NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH");
const spotCoin = required("NARYX_HYPERLIQUID_TESTNET_SPOT_UNIVERSE_NAME");
const perpetualCoin = required("NARYX_HYPERLIQUID_TESTNET_PERPETUAL_NAME");
const sizeDecimals = Number(required("NARYX_HYPERLIQUID_TESTNET_SPOT_SIZE_DECIMALS"));
const baseDecimals = Number(required("NARYX_HYPERLIQUID_TESTNET_SPOT_TOKEN_DECIMALS"));
const quoteDecimals = Number(required("NARYX_HYPERLIQUID_TESTNET_QUOTE_TOKEN_DECIMALS"));
const lotAtoms = 10n ** BigInt(baseDecimals - sizeDecimals);
const spotAssetId = 10_000 + Number(spotCoin.slice(1));
const perpetualAssetId = 3;
const spotTokenIndex = 2202;
const quoteTokenIndex = 0;
const quantityAtoms = 2_000_000n;
const recoveryDrill = process.argv.includes("--recovery-drill");
const attempts = new Map();
const provider = Object.freeze({ resolve: async (attemptId) => attempts.get(attemptId) });
const signer = loadHyperliquidTestnetAgentSigner(keyPath, agentAddress);
const marketReader = new HyperliquidSdkTestnetMarketReadClient();
const authorityReader = new HyperliquidSdkTestnetAuthorityReader();
const account = Object.freeze({ masterAccount, tradingAccount, accountKind: "MASTER" });
const diagnosticTransport = () => {
  const transport = new HyperliquidTestnetHttpExchangeTransport();
  return Object.freeze({
    isTestnet: transport.isTestnet,
    apiUrl: transport.apiUrl,
    async request(endpoint, payload, signal) {
      try {
        const response = await transport.request(endpoint, payload, signal);
        const statuses = response?.response?.data?.statuses;
        if (Array.isArray(statuses) && statuses.some((status) => status?.error)) {
          process.stderr.write(`${JSON.stringify({ venueResponse: response })}\n`);
        }
        return response;
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          venueError: error instanceof Error ? error.message : "unknown error",
          response: typeof error === "object" && error !== null && "response" in error
            ? error.response : null,
        })}\n`);
        throw error;
      }
    },
  });
};

function attemptId(label) {
  return `hl-${label}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function decimalAtoms(value, decimals, name) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > decimals) throw new Error(`${name} exceeds asset precision`);
  const atoms = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  return negative ? -atoms : atoms;
}

async function lightweightPerpetualPosition() {
  const query = async (body) => {
    const response = await fetch(new URL("/info", HYPERLIQUID_TESTNET_MARKET_INFO_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid account read failed with ${response.status}`);
    return response.json();
  };
  const clearing = await query({ type: "clearinghouseState", user: tradingAccount });
  const position = clearing?.assetPositions?.find(
    (item) => item?.position?.coin === perpetualCoin,
  )?.position?.szi ?? "0";
  return decimalAtoms(position, baseDecimals, "perpetual position");
}

async function livePrices(action) {
  const entry = action === "ENTRY";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const [spot, perpetual] = await Promise.all([
      marketReader.l2Book(spotCoin),
      marketReader.l2Book(perpetualCoin),
    ]);
    const spotLevel = spot?.levels[entry ? 1 : 0][0];
    const perpetualLevel = perpetual?.levels[entry ? 0 : 1][0];
    if (spotLevel && perpetualLevel) {
      return Object.freeze({
        spotPrice: boundedIocPrice(spotLevel.px, entry ? "BUY" : "SELL"),
        perpetualPrice: boundedIocPrice(perpetualLevel.px, entry ? "SELL" : "BUY"),
      });
    }
    await delay(2_500);
  }
  throw new Error("qualified books remained one-sided for 30 seconds");
}

async function registerAttempt(action, spotAtoms, perpetualAtoms, options = {}) {
  const id = attemptId(action.toLowerCase());
  const selectedAtMs = Date.now();
  const expiresAtMs = selectedAtMs + 120_000;
  const prices = await livePrices(action);
  const plan = buildCashCarryPlan({
    attemptId: id,
    action,
    spotBaseAtoms: spotAtoms,
    perpetualBaseAtoms: perpetualAtoms,
    baseDecimals,
    quoteDecimals,
    spotAssetId,
    perpetualAssetId,
    ...prices,
    expiresAtMs,
    forceEntryPerpetualReduceOnly: options.forcePerpetualNoFill === true,
  });
  attempts.set(id, Object.freeze({
    attemptId: id,
    authority: Object.freeze({ requiredUntilMs: BigInt(expiresAtMs), baseAssetDecimals: baseDecimals }),
    seriesManifestHash: Buffer.from(plan.orderHash).toString("hex"),
    executionClassManifestHash: Buffer.from(plan.routeHash).toString("hex"),
    market: Object.freeze({
      spot: Object.freeze({
        adapterId: "hypercore-spot-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: Buffer.from(plan.domain.domainManifestHash).toString("hex"),
        venueId: "hypercore-testnet",
        venueManifestVersion: 1,
        venueManifestHash: Buffer.from(plan.domain.domainManifestHash).toString("hex"),
        marketId: "pobtc-usdc-spot",
        marketManifestVersion: 1,
        marketManifestHash: Buffer.from(plan.graphHash).toString("hex"),
        assetId: spotAssetId,
        sizeDecimals,
        universeIndex: Number(spotCoin.slice(1)),
        tokenIndex: spotTokenIndex,
      }),
      perpetual: Object.freeze({
        adapterId: "hypercore-perpetual-v1",
        adapterManifestVersion: 1,
        adapterManifestHash: Buffer.from(plan.domain.domainManifestHash).toString("hex"),
        venueId: "hypercore-testnet",
        venueManifestVersion: 1,
        venueManifestHash: Buffer.from(plan.domain.domainManifestHash).toString("hex"),
        marketId: "btc-usdc-perpetual",
        marketManifestVersion: 1,
        marketManifestHash: Buffer.from(plan.quoteHash).toString("hex"),
        assetId: perpetualAssetId,
        sizeDecimals,
        assetIndex: perpetualAssetId,
      }),
      quoteTokenIndex,
    }),
    limits: Object.freeze({ maxEvidenceAgeMs: 30_000, maxSnapshotSkewMs: 10_000, maxFillPages: 4 }),
    selectedAtMs,
    strategy: Object.freeze({ graphHash: plan.graphHash, plan }),
  }));
  return Object.freeze({ id, plan, seriesManifestHash: attempts.get(id).seriesManifestHash,
    executionClassManifestHash: attempts.get(id).executionClassManifestHash });
}

async function inventory() {
  const snapshot = await authorityReader.read(account, agentAddress, [perpetualCoin]);
  return hyperliquidTestnetAccountInventory(snapshot, perpetualCoin, spotTokenIndex, baseDecimals);
}

async function recoveryIdentity() {
  const path = required("NARYX_HYPERLIQUID_TESTNET_RECOVERY_CONFIG");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config?.environment !== "HYPERLIQUID_TESTNET"
    || config?.verifierIdentity?.environment !== "testnet") {
    throw new Error("Hyperliquid recovery config is not pinned to testnet");
  }
  return config.verifierIdentity;
}

function recoverySourceAttempt({ registration, result, before, identity, prices }) {
  const spotEvidence = result.stages.flatMap((stage) => stage.evidence?.legs ?? [])
    .find((leg) => leg.legId === "spot");
  const perpetualEvidence = result.stages.flatMap((stage) => stage.evidence?.legs ?? [])
    .find((leg) => leg.legId === "perpetual");
  if (!spotEvidence || !perpetualEvidence) throw new Error("partial package evidence is incomplete");
  const now = Date.now();
  const sourcePlan = buildCashCarryRecoverySourcePlan({
    strategyPlan: registration.plan,
    seriesManifestHash: registration.seriesManifestHash,
    executionClassManifestHash: registration.executionClassManifestHash,
    prePerpetualPositionAtoms: before.perpetualPositionAtoms,
    recoveryIdentity: identity,
    rollbackSpotPrice: prices.spotPrice,
    rollbackPerpetualPrice: prices.perpetualPrice,
    recoveryActionExpiryMs: now + 240_000,
    recoveryDeadlineMs: now + 600_000,
  });
  const fees = result.stages.flatMap((stage) => stage.evidence?.legs ?? [])
    .filter((leg) => BigInt(leg.feeAtoms) > 0n)
    .map((leg) => Object.freeze({
      assetId: leg.feeAssetId,
      assetDecimals: leg.feeAssetDecimals,
      amountAtoms: BigInt(leg.feeAtoms),
      evidenceStatus: "CONFIRMED",
    }));
  const baseFeeAtoms = fees
    .filter((fee) => fee.assetId === sourcePlan.legs[0].baseAsset.assetId)
    .reduce((sum, fee) => sum + fee.amountAtoms, 0n);
  const spotFill = BigInt(spotEvidence.filledSignedBaseAtoms);
  const perpetualFill = BigInt(perpetualEvidence.filledSignedBaseAtoms);
  const observedAtMs = BigInt(Math.max(
    ...result.stages.map((stage) => Number(stage.evidence?.observedAtMs ?? 0)),
  ));
  const planned = beginHyperliquidReconciliation(createHyperliquidPackageAttempt(
    sourcePlan,
    account,
  ));
  const attempt = reconcileHyperliquidPackageAttempt(planned, {
    source: HYPERCORE_RECONCILIATION_SOURCE,
    domain: sourcePlan.domain,
    commitments: sourcePlan.commitments,
    account,
    evidenceVersion: 1n,
    observedAtMs,
    spot: Object.freeze({
      clientOrderId: sourcePlan.legs[0].clientOrderId,
      terminalStatus: spotEvidence.terminalStatus,
      openOrderStatus: spotEvidence.openOrderStatus,
      filledSignedBaseAtoms: spotFill,
    }),
    perpetual: Object.freeze({
      clientOrderId: sourcePlan.legs[1].clientOrderId,
      terminalStatus: perpetualEvidence.terminalStatus,
      openOrderStatus: perpetualEvidence.openOrderStatus,
      filledSignedBaseAtoms: perpetualFill,
    }),
    netSpotDeltaAtoms: spotFill - baseFeeAtoms,
    perpetualPositionDeltaAtoms: perpetualFill,
    observedPerpetualPositionAtoms: before.perpetualPositionAtoms + perpetualFill,
    perpetualPositionTargetAtoms: sourcePlan.signedPerpTargetAtoms,
    feeEvidenceComplete: true,
    fees: Object.freeze(fees),
  });
  if (attempt.status !== "RECOVERY_REQUIRED") {
    throw new Error(`partial package did not compile a recovery obligation: ${attempt.status}`);
  }
  return attempt;
}

async function waitForRecoveredPosition(expectedPerpetualAtoms, expectedSpotAtoms) {
  for (let read = 0; read < 18; read += 1) {
    try {
      const perpetualPositionAtoms = await lightweightPerpetualPosition();
      if (perpetualPositionAtoms === expectedPerpetualAtoms) {
        return Object.freeze({ spotBalanceAtoms: expectedSpotAtoms, perpetualPositionAtoms });
      }
    } catch {
      // Hyperliquid Testnet can temporarily rate limit account reads after submission.
    }
    await delay(5_000);
  }
  throw new Error("recovery submission did not reach the expected perpetual position");
}

const loaded = await loadHyperliquidTestnetExecutorRuntime(process.env, {
  attempts: provider,
  signer,
  marketReader,
  authorityReader,
  transportFactory: diagnosticTransport,
});
try {
  if (!loaded.status.enabled || !loaded.runtimeFactory) throw new Error("testnet executor is disabled");
  const executor = createHyperliquidTestnetExecutor(loaded.runtimeFactory);
  if (!executor) throw new Error("testnet executor is unavailable");
  const before = await inventory();
  if (before.perpetualPositionAtoms !== 0n || before.spotBalanceAtoms >= lotAtoms) {
    throw new Error("the dedicated test account must start without a tradable package position");
  }
  const entryRegistration = await registerAttempt(
    "ENTRY",
    quantityAtoms,
    quantityAtoms,
    recoveryDrill ? { forcePerpetualNoFill: true } : {},
  );
  const entryId = entryRegistration.id;
  const entry = await executor.execute({ attemptId: entryId, idempotencyKey: `${entryId}-run` });
  let recovery = null;
  if (recoveryDrill) {
    if (entry.status !== "STRATEGY_EXECUTION" || entry.packageStatus !== "RECOVERY_REQUIRED") {
      throw new Error(`entry did not require recovery: ${JSON.stringify(entry)}`);
    }
    const sourceAttempt = recoverySourceAttempt({
      registration: entryRegistration,
      result: entry,
      before,
      identity: await recoveryIdentity(),
      prices: await livePrices("EXIT"),
    });
    const recoveryAttemptId = attemptId("recovery");
    const recoveryClient = new HyperliquidRecoveryTestnetHttpExecution({
      keeperOrigin: required("NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN"),
      timeoutMs: 30_000,
    });
    const costCaps = sourceAttempt.plan.recoveryPolicy.maxRecoveryCostCaps;
    const projectedRecoveryCosts = Object.freeze(costCaps.map((cap) => Object.freeze({
      asset: cap.asset,
      atoms: cap.maxAtoms,
    })));
    const projectedAggregateLoss = sourceAttempt.plan.recoveryPolicy.maxAggregateRecoveryLoss;
    new HyperliquidRecoveryCompiler(await recoveryIdentity()).compile({
      attempt: sourceAttempt,
      nowMs: sourceAttempt.acceptedEvidence.observedAtMs,
      recoverySequence: 0,
      projectedRecoveryCosts,
      projectedAggregateLoss,
    });
    const recoveryResult = await recoveryClient.execute({
      recoveryAttemptId,
      sourceAttempt,
      recoverySequence: 0,
      projectedRecoveryCosts,
      projectedAggregateLoss,
    });
    if (recoveryResult.submission.status !== "ACKNOWLEDGED") {
      throw new Error(`recovery submission was not acknowledged: ${recoveryResult.submission.status}`);
    }
    const recovered = await waitForRecoveredPosition(
      sourceAttempt.plan.perpetualPositionTargetAtoms,
      before.spotBalanceAtoms + sourceAttempt.acceptedEvidence.netSpotDeltaAtoms,
    );
    recovery = Object.freeze({
      recoveryAttemptId,
      submissionStatus: recoveryResult.submission.status,
      mode: recoveryResult.plan.mode,
      orderCount: recoveryResult.plan.orders.length,
      inventory: Object.freeze({
        spot: recovered.spotBalanceAtoms.toString(),
        perpetual: recovered.perpetualPositionAtoms.toString(),
      }),
    });
    if (typeof loaded.releaseLane !== "function") {
      throw new Error("testnet executor cannot release a recovered strategy lane");
    }
    await loaded.releaseLane({
      attemptId: entryId,
      disposition: "ABANDONED",
      reason: "Testnet recovery drill verified the bounded recovery submission and account target.",
    });
  } else if (entry.status !== "STRATEGY_EXECUTION" || entry.packageStatus !== "COMPLETED") {
    throw new Error(`entry did not complete: ${JSON.stringify(entry)}`);
  }
  const opened = await inventory();
  const exitSpotAtoms = opened.spotBalanceAtoms - opened.spotBalanceAtoms % lotAtoms;
  const exitPerpetualAtoms = -opened.perpetualPositionAtoms;
  if (exitSpotAtoms <= 0n || exitPerpetualAtoms <= 0n) {
    throw new Error("entry produced no closable package inventory");
  }
  const exitRegistration = await registerAttempt("EXIT", exitSpotAtoms, exitPerpetualAtoms);
  const exitId = exitRegistration.id;
  const exit = await executor.execute({ attemptId: exitId, idempotencyKey: `${exitId}-run` });
  if (exit.status !== "STRATEGY_EXECUTION" || exit.packageStatus !== "COMPLETED") {
    throw new Error(`exit did not complete: ${JSON.stringify(exit)}`);
  }
  const after = await inventory();
  if (after.perpetualPositionAtoms !== 0n || after.spotBalanceAtoms >= lotAtoms) {
    throw new Error("exit left a tradable package position");
  }
  process.stdout.write(`${JSON.stringify({
    evidenceClass: recoveryDrill
      ? "NARYX_HYPERLIQUID_TESTNET_BOUNDED_RECOVERY_V1"
      : "NARYX_HYPERLIQUID_TESTNET_PACKAGE_V1",
    environment: "TESTNET",
    market: { spot: spotCoin, perpetual: perpetualCoin },
    entry,
    recovery,
    exit,
    inventory: {
      before: { spot: before.spotBalanceAtoms.toString(), perpetual: before.perpetualPositionAtoms.toString() },
      opened: { spot: opened.spotBalanceAtoms.toString(), perpetual: opened.perpetualPositionAtoms.toString() },
      after: { spot: after.spotBalanceAtoms.toString(), perpetual: after.perpetualPositionAtoms.toString() },
    },
  })}\n`);
} finally {
  loaded.close();
}

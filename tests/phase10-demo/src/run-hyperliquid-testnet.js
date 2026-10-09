import { randomBytes } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  HyperliquidSdkTestnetAuthorityReader,
  HyperliquidTestnetHttpExchangeTransport,
  HyperliquidSdkTestnetMarketReadClient,
  createHyperliquidTestnetExecutor,
  hyperliquidTestnetAccountInventory,
  loadHyperliquidTestnetAgentSigner,
  loadHyperliquidTestnetExecutorRuntime,
} from "../../../services/solver/dist/index.js";
import {
  boundedIocPrice,
  buildCashCarryPlan,
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

async function registerAttempt(action, spotAtoms, perpetualAtoms) {
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
  return id;
}

async function inventory() {
  const snapshot = await authorityReader.read(account, agentAddress, [perpetualCoin]);
  return hyperliquidTestnetAccountInventory(snapshot, perpetualCoin, spotTokenIndex, baseDecimals);
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
  const entryId = await registerAttempt("ENTRY", quantityAtoms, quantityAtoms);
  const entry = await executor.execute({ attemptId: entryId, idempotencyKey: `${entryId}-run` });
  if (entry.status !== "STRATEGY_EXECUTION" || entry.packageStatus !== "COMPLETED") {
    throw new Error(`entry did not complete: ${JSON.stringify(entry)}`);
  }
  const opened = await inventory();
  const exitSpotAtoms = opened.spotBalanceAtoms - opened.spotBalanceAtoms % lotAtoms;
  const exitPerpetualAtoms = -opened.perpetualPositionAtoms;
  if (exitSpotAtoms <= 0n || exitPerpetualAtoms <= 0n) {
    throw new Error("entry produced no closable package inventory");
  }
  const exitId = await registerAttempt("EXIT", exitSpotAtoms, exitPerpetualAtoms);
  const exit = await executor.execute({ attemptId: exitId, idempotencyKey: `${exitId}-run` });
  if (exit.status !== "STRATEGY_EXECUTION" || exit.packageStatus !== "COMPLETED") {
    throw new Error(`exit did not complete: ${JSON.stringify(exit)}`);
  }
  const after = await inventory();
  if (after.perpetualPositionAtoms !== 0n || after.spotBalanceAtoms >= lotAtoms) {
    throw new Error("exit left a tradable package position");
  }
  process.stdout.write(`${JSON.stringify({
    evidenceClass: "NARYX_HYPERLIQUID_TESTNET_PACKAGE_V1",
    environment: "TESTNET",
    market: { spot: spotCoin, perpetual: perpetualCoin },
    entry,
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

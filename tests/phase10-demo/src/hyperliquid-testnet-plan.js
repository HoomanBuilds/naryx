import { createHash } from "node:crypto";

function hash(label) {
  return Uint8Array.from(createHash("sha256").update(label, "utf8").digest());
}

function positiveDecimal(value, name) {
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function priceIncrement(price) {
  if (price >= 100_000) return 10;
  if (price >= 10_000) return 1;
  if (price >= 1_000) return 0.1;
  if (price >= 100) return 0.01;
  return 0.001;
}

export function boundedIocPrice(value, side) {
  const price = positiveDecimal(value, "book price");
  const increment = priceIncrement(price);
  const stressed = side === "BUY" ? price * 1.0025 : price * 0.9975;
  const units = stressed / increment;
  const rounded = side === "BUY" ? Math.ceil(units) : Math.floor(units);
  return (rounded * increment).toFixed(Math.max(0, -Math.floor(Math.log10(increment))));
}

export function baseAtomsToSize(atoms, decimals) {
  if (typeof atoms !== "bigint" || atoms <= 0n || !Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error("base quantity is invalid");
  }
  const digits = atoms.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  const value = `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  return value.replace(/\.0+$/, "").replace(/(\.[0-9]*?)0+$/, "$1");
}

function clientOrderId(attemptId, legId) {
  return `0x${createHash("sha256").update(`${attemptId}:${legId}`, "utf8").digest("hex").slice(0, 32)}`;
}

export function buildCashCarryPlan({
  attemptId,
  action,
  spotBaseAtoms,
  perpetualBaseAtoms,
  baseDecimals,
  quoteDecimals,
  spotAssetId,
  perpetualAssetId,
  spotPrice,
  perpetualPrice,
  expiresAtMs,
}) {
  const entry = action === "ENTRY";
  if (!entry && action !== "EXIT") throw new Error("action is invalid");
  const spotSize = baseAtomsToSize(spotBaseAtoms, baseDecimals);
  const perpetualSize = baseAtomsToSize(perpetualBaseAtoms, baseDecimals);
  const baseAsset = Object.freeze({
    assetId: "POBTC",
    decimals: baseDecimals,
    assetManifestHash: hash("naryx:testnet:pobtc-btc-base-v1"),
  });
  const quoteAsset = Object.freeze({
    assetId: "USDC",
    decimals: quoteDecimals,
    assetManifestHash: hash("naryx:testnet:hypercore-usdc-v1"),
  });
  const price = (value) => Object.freeze({
    baseAsset,
    quoteAsset,
    quoteAtoms: BigInt(value.replace(".", "")),
    baseAtoms: 10n ** BigInt((value.split(".")[1] ?? "").length),
    roundingDirection: "CEIL",
  });
  const orders = Object.freeze([
    Object.freeze({
      legId: "spot",
      stage: entry ? 0 : 1,
      baseAsset,
      quoteAsset,
      signedBaseDeltaAtoms: entry ? spotBaseAtoms : -spotBaseAtoms,
      limitPrice: price(spotPrice),
      clientOrderId: clientOrderId(attemptId, "spot"),
      wire: Object.freeze({
        a: spotAssetId,
        b: entry,
        p: spotPrice,
        s: spotSize,
        r: false,
        t: Object.freeze({ limit: Object.freeze({ tif: "Ioc" }) }),
        c: clientOrderId(attemptId, "spot"),
      }),
    }),
    Object.freeze({
      legId: "perpetual",
      stage: entry ? 1 : 0,
      baseAsset,
      quoteAsset,
      signedBaseDeltaAtoms: entry ? -perpetualBaseAtoms : perpetualBaseAtoms,
      limitPrice: price(perpetualPrice),
      clientOrderId: clientOrderId(attemptId, "perpetual"),
      wire: Object.freeze({
        a: perpetualAssetId,
        b: !entry,
        p: perpetualPrice,
        s: perpetualSize,
        r: !entry,
        t: Object.freeze({ limit: Object.freeze({ tif: "Ioc" }) }),
        c: clientOrderId(attemptId, "perpetual"),
      }),
    }),
  ]);
  return Object.freeze({
    version: 1,
    guarantee: "BATCHED_IOC_WITH_BOUNDED_RECOVERY",
    domain: Object.freeze({
      domainId: "hypercore:testnet",
      domainManifestVersion: 1,
      domainManifestHash: hash("naryx:hypercore-testnet-domain-v1"),
    }),
    orderHash: hash(`${attemptId}:order`),
    graphHash: hash(`${attemptId}:graph`),
    quoteHash: hash(`${attemptId}:quote`),
    routeHash: hash(`${attemptId}:route`),
    requestExpiryMs: BigInt(expiresAtMs),
    orders,
    batches: Object.freeze([0, 1].map((stage) => {
      const stageOrders = orders.filter((order) => order.stage === stage);
      return Object.freeze({
        stage,
        action: Object.freeze({
          type: "order",
          grouping: "na",
          orders: Object.freeze(stageOrders.map((order) => order.wire)),
        }),
        legIds: Object.freeze(stageOrders.map((order) => order.legId)),
      });
    })),
    recoveryAuthorizations: Object.freeze(orders.map((order) => Object.freeze({
      legId: order.legId,
      action: "COMPLETE",
      maximumQuantityAtoms: order.legId === "spot" ? spotBaseAtoms : perpetualBaseAtoms,
      maximumCostQuoteAtoms: 100_000_000n,
    }))),
    maximumRecoveryCostQuoteAtoms: 200_000_000n,
  });
}

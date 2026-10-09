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

function gcd(left, right) {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
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
  forceEntryPerpetualReduceOnly = false,
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
  const price = (value) => exactPrice(value, baseAsset, quoteAsset, "CEIL");
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
        r: !entry || forceEntryPerpetualReduceOnly,
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

function hexBytes(value, name) {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${name} is invalid`);
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function exactPrice(value, baseAsset, quoteAsset, roundingDirection) {
  const [whole, fraction = ""] = value.split(".");
  const numerator = BigInt(`${whole}${fraction}`) * 10n ** BigInt(quoteAsset.decimals);
  const denominator = 10n ** BigInt(fraction.length + baseAsset.decimals);
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    baseAsset,
    quoteAsset,
    quoteAtoms: numerator / divisor,
    baseAtoms: denominator / divisor,
    roundingDirection,
  });
}

function manifestRef(subjectId, label) {
  return Object.freeze({
    subjectId,
    manifestVersion: 1,
    manifestHash: hash(label),
  });
}

function adapterRef(adapterId, label) {
  return Object.freeze({
    adapterId,
    adapterManifestVersion: 1,
    adapterManifestHash: hash(label),
  });
}

export function buildCashCarryRecoverySourcePlan({
  strategyPlan,
  seriesManifestHash,
  executionClassManifestHash,
  prePerpetualPositionAtoms,
  recoveryIdentity,
  rollbackSpotPrice,
  rollbackPerpetualPrice,
  recoveryActionExpiryMs,
  recoveryDeadlineMs,
}) {
  const spot = strategyPlan.orders.find((order) => order.legId === "spot");
  const perpetual = strategyPlan.orders.find((order) => order.legId === "perpetual");
  if (!spot || !perpetual || spot.signedBaseDeltaAtoms <= 0n
    || perpetual.signedBaseDeltaAtoms >= 0n) {
    throw new Error("entry recovery source requires long spot and short perpetual legs");
  }
  const spotAdapter = adapterRef("hypercore-spot-v1", "naryx:testnet:hypercore-spot-adapter-v1");
  const perpetualAdapter = adapterRef(
    "hypercore-perpetual-v1",
    "naryx:testnet:hypercore-perpetual-adapter-v1",
  );
  const venue = manifestRef("hypercore-testnet", "naryx:testnet:hypercore-venue-v1");
  const spotMarket = manifestRef("pobtc-usdc-spot", "naryx:testnet:pobtc-usdc-spot-v1");
  const perpetualMarket = manifestRef(
    "btc-usdc-perpetual",
    "naryx:testnet:btc-usdc-perpetual-v1",
  );
  const baseAsset = spot.baseAsset;
  const quoteAsset = spot.quoteAsset;
  const quantityAtoms = spot.signedBaseDeltaAtoms;
  const perpetualQuantityAtoms = -perpetual.signedBaseDeltaAtoms;
  const residualCapAtoms = 5_000n;
  const spotLeg = Object.freeze({
    legId: "spot",
    role: "SPOT",
    legIndex: 0,
    adapter: spotAdapter,
    venue,
    market: spotMarket,
    baseAsset,
    quoteAsset,
    side: "BUY",
    quantityAtoms,
    sizeDecimals: 5,
    maxPriceDecimals: 3,
    signedBaseDeltaAtoms: quantityAtoms,
    clientOrderId: spot.clientOrderId,
    order: spot.wire,
  });
  const perpetualLeg = Object.freeze({
    legId: "perpetual",
    role: "PERPETUAL",
    legIndex: 1,
    adapter: perpetualAdapter,
    venue,
    market: perpetualMarket,
    baseAsset,
    quoteAsset,
    side: "SELL",
    quantityAtoms: perpetualQuantityAtoms,
    sizeDecimals: 5,
    maxPriceDecimals: 1,
    signedBaseDeltaAtoms: -perpetualQuantityAtoms,
    clientOrderId: perpetual.clientOrderId,
    order: Object.freeze({ ...perpetual.wire, r: false }),
  });
  const completeSpotPrice = spot.limitPrice;
  const completePerpetualPrice = perpetual.limitPrice;
  const rollbackSpot = exactPrice(rollbackSpotPrice, baseAsset, quoteAsset, "CEIL");
  const rollbackPerpetual = exactPrice(
    rollbackPerpetualPrice,
    baseAsset,
    quoteAsset,
    "FLOOR",
  );
  const recoveryCostCap = 200_000_000n;
  return Object.freeze({
    version: 1,
    guarantee: "BATCHED_IOC_WITH_BOUNDED_RECOVERY",
    domain: strategyPlan.domain,
    commitments: Object.freeze({
      seriesManifestHash: hexBytes(seriesManifestHash, "seriesManifestHash"),
      executionClassManifestHash: hexBytes(
        executionClassManifestHash,
        "executionClassManifestHash",
      ),
      orderHash: strategyPlan.orderHash,
      quoteHash: strategyPlan.quoteHash,
      routeHash: strategyPlan.routeHash,
    }),
    requestExpiryMs: strategyPlan.requestExpiryMs,
    unsignedRequestFields: Object.freeze({
      action: Object.freeze({
        type: "order",
        orders: Object.freeze([spot.wire, Object.freeze({ ...perpetual.wire, r: false })]),
        grouping: "na",
      }),
      expiresAfter: Number(strategyPlan.requestExpiryMs),
    }),
    legs: Object.freeze([spotLeg, perpetualLeg]),
    grossSpotQuantityAtoms: quantityAtoms,
    prePerpPositionAtoms: prePerpetualPositionAtoms,
    signedPerpDeltaAtoms: -perpetualQuantityAtoms,
    signedPerpTargetAtoms: prePerpetualPositionAtoms - perpetualQuantityAtoms,
    terminalResidualPolicy: Object.freeze({
      kind: "BOUNDED_NET",
      minNetSpotDeltaAtoms: quantityAtoms - residualCapAtoms,
      maxNetSpotDeltaAtoms: quantityAtoms,
      maxTerminalResidualBaseAtoms: residualCapAtoms,
      residualValuationSchemaVersion: 1,
      residualValuationReferencePrice: spot.limitPrice,
      maxTerminalResidualQuoteAtoms: 200_000_000n,
    }),
    recoveryPolicy: Object.freeze({
      policyVersion: 1,
      controllerId: recoveryIdentity.controllerId,
      controllerCodeHash: hexBytes(recoveryIdentity.controllerCodeHash, "controllerCodeHash"),
      authorityModeId: recoveryIdentity.authorityModeId,
      recoveryExpiryUnit: "HYPERLIQUID_UNIX_MILLISECONDS",
      maxActionExpiryValue: BigInt(recoveryActionExpiryMs),
      deadlineValue: BigInt(recoveryDeadlineMs),
      minRecoveryWindowMs: 30_000n,
      maxRecoveryCostCaps: Object.freeze([
        Object.freeze({ asset: quoteAsset, maxAtoms: recoveryCostCap }),
      ]),
      maxAggregateRecoveryLoss: Object.freeze({ asset: quoteAsset, atoms: recoveryCostCap }),
      maxIntermediateResidual: Object.freeze({ asset: baseAsset, atoms: quantityAtoms }),
      maxTerminalResidual: Object.freeze({ asset: baseAsset, atoms: residualCapAtoms }),
      reconciledStateSchemaHash: hash("naryx:testnet:hypercore-reconciled-state-v1"),
      actionBuilderCodeHash: hexBytes(
        recoveryIdentity.actionBuilderCodeHash,
        "actionBuilderCodeHash",
      ),
      actionSlots: Object.freeze([
        Object.freeze({
          sequence: 0,
          action: "COMPLETE_SPOT",
          targetLeg: 0,
          adapter: spotAdapter,
          markets: Object.freeze([spotMarket]),
          maxQuantity: Object.freeze({ asset: baseAsset, atoms: quantityAtoms }),
          limitPrice: completeSpotPrice,
          reduceOnly: false,
          timeInForce: "IOC",
        }),
        Object.freeze({
          sequence: 1,
          action: "COMPLETE_PERP",
          targetLeg: 1,
          adapter: perpetualAdapter,
          markets: Object.freeze([perpetualMarket]),
          maxQuantity: Object.freeze({ asset: baseAsset, atoms: perpetualQuantityAtoms }),
          limitPrice: completePerpetualPrice,
          reduceOnly: false,
          timeInForce: "IOC",
        }),
        Object.freeze({
          sequence: 2,
          action: "ROLLBACK_SPOT",
          targetLeg: 0,
          adapter: spotAdapter,
          markets: Object.freeze([spotMarket]),
          maxQuantity: Object.freeze({ asset: baseAsset, atoms: quantityAtoms }),
          limitPrice: rollbackSpot,
          reduceOnly: false,
          timeInForce: "IOC",
        }),
        Object.freeze({
          sequence: 3,
          action: "ROLLBACK_PERP",
          targetLeg: 1,
          adapter: perpetualAdapter,
          markets: Object.freeze([perpetualMarket]),
          maxQuantity: Object.freeze({ asset: baseAsset, atoms: perpetualQuantityAtoms }),
          limitPrice: rollbackPerpetual,
          reduceOnly: true,
          timeInForce: "IOC",
        }),
      ]),
    }),
    recoveryDeadlineMs: BigInt(recoveryDeadlineMs),
  });
}

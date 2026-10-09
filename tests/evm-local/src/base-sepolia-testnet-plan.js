import { encodePacked, keccak256, stringToHex } from "viem";
import { deriveTestPerpEntryLimits, encodeTestPerpTradeArgs } from "@naryx/adapter-evm";

const ZERO_HASH = `0x${"00".repeat(32)}`;
const BPS = 10_000n;
const SPOT_FILL_DOMAIN = stringToHex("NARYX/base-uniswap-spot-fill/v1");

export const BASE_SEPOLIA_RESOURCES = Object.freeze({
  baseAsset: Object.freeze({
    subjectId: "0x70b8d5aa962883071145572c69774c7c2e5ee83d7d0c1979035a43d92012b4ed",
    manifestVersion: 1,
    manifestHash: "0x95a455f36c27216e803322d3830544455ef5a479ab6c145b46f434530ceaf0fc",
  }),
  quoteAsset: Object.freeze({
    subjectId: "0xe5882e19f6b25ffcfb1cb84c6518fd63faa0b1f9fde6647fc246642e95c9fd72",
    manifestVersion: 1,
    manifestHash: "0x94eac45d67cb8acce44670647ff7c76f6e11b877bdda6af6195f7629a7d747d3",
  }),
  spotVenue: Object.freeze({
    subjectId: "0x9f0455be4a6b141ff05f3d8623dff49e2b4df5edc531ac0283de5bd27b71d3bb",
    manifestVersion: 1,
    manifestHash: "0x574c0d028312e2627eb2e12dde8b6d7ae5817dfc908bfce66242d5b2fe37d28d",
  }),
  perpetualVenue: Object.freeze({
    subjectId: "0x462addafc2064aab0f01a36db26a0c4eb49ca6a898e780a3ea1c8888e683c470",
    manifestVersion: 1,
    manifestHash: "0x574a7265945a4a20ae2980da7a82360a924d80dd222d6ee9d858fe55d6e40bfc",
  }),
  spotMarket: Object.freeze({
    subjectId: "0xd8ddbfb114531f349fd09fe5164db7fe9b49b6f81852e7810fedbf77291baf9e",
    manifestVersion: 1,
    manifestHash: "0x6059255ec5ce560dc6c456334c2203171aeae27d202bb62f4e0b3874594e8730",
  }),
  perpetualMarket: Object.freeze({
    subjectId: "0x777b06e72a43974004909e4b0cc1c5518f20ce32812a5f9a3ae661f96f5370e2",
    manifestVersion: 1,
    manifestHash: "0x1ba5a91a7c738108cc1373833ffedcc5f6607decc2b1b42d386fb63ea9e9f116",
  }),
  spotAdapter: Object.freeze({
    subjectId: "0xf836ea900e51191d4f5f32acdffb3f4e3f58cc2ee28f9d671948279485a1a699",
    manifestVersion: 1,
    manifestHash: "0xba12e2fc7488b369de3b992907946572cd28733aeffa76a5d1e6e1fa554c281a",
  }),
  perpetualAdapter: Object.freeze({
    subjectId: "0xcc8c1b967e0a806a8fd6f8840f23676664c035999e47a6877932bde630055295",
    manifestVersion: 1,
    manifestHash: "0xd7ca8f1267ab3eb7d5cb9c64cc940ab98e47f099320c08ec6fb8032ed1627ed4",
  }),
});

export const BASE_SEPOLIA_SERIES = Object.freeze({
  identityKey: "0x404e763ab8b45e5b7f03b96c6a6b107db78766b8cebde8c546c6a8fe829f5d50",
  bindingVersion: 1,
  bindingHash: "0xc1fc90792d87858efdb01abc5a27b3087b0d208777d9dcb6c6664c2790488a2c",
  spotBaseAtomsPerPackageUnit: 1_000_000_000_000_000n,
  perpetualQuantityWadPerPackageUnit: 1_000_000_000_000_000n,
});

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}
function resource(manifest, address, expectedCodeHash) {
  return Object.freeze({ manifest, localAddress: address, expectedCodeHash });
}

function hash(label, nonce) {
  return keccak256(stringToHex(`naryx/base-sepolia/${label}/${nonce}`));
}

function spotFillCommitment(orderHash, quoteHash, routeHash) {
  return keccak256(encodePacked(
    ["bytes", "bytes32", "bytes32", "bytes32"],
    [SPOT_FILL_DOMAIN, orderHash, quoteHash, routeHash],
  ));
}

function admission(input, action, spotLimitAtoms, perpetualLimitAtoms) {
  const packageNotionalQuoteAtoms = spotLimitAtoms > perpetualLimitAtoms
    ? spotLimitAtoms
    : perpetualLimitAtoms;
  return Object.freeze({
    domain: Object.freeze({
      domainIdHash: keccak256(stringToHex("eip155:84532")),
      manifestVersion: input.release.domainManifest.manifestVersion,
      manifestHash: input.release.domainManifest.manifestHash,
    }),
    template: Object.freeze({
      templateId: keccak256(stringToHex("cash-and-carry-v1")),
      templateVersion: 1,
      templateManifestHash: input.release.economicSeries.templateManifestHash,
    }),
    settlementClass: Object.freeze({
      classId: keccak256(stringToHex("ATOMIC_POSTCONDITION")),
      classVersion: 1,
    }),
    spot: Object.freeze({
      adapter: resource(BASE_SEPOLIA_RESOURCES.spotAdapter, input.release.contracts.spotPort.address, input.release.contracts.spotPort.runtimeCodeHash),
      adapterClassId: keccak256(stringToHex("base-strategy-spot-adapter-v1")),
      adapterClassVersion: 1,
      market: resource(BASE_SEPOLIA_RESOURCES.spotMarket, input.release.externalDependencies.uniswapPool.address, input.release.externalDependencies.uniswapPool.runtimeCodeHash),
      venue: resource(BASE_SEPOLIA_RESOURCES.spotVenue, input.release.externalDependencies.uniswapFactory.address, input.release.externalDependencies.uniswapFactory.runtimeCodeHash),
      quantityAtoms: input.quantityAtoms,
      limitQuoteAtomsPerBaseLot: spotLimitAtoms,
    }),
    perpetual: Object.freeze({
      adapter: resource(BASE_SEPOLIA_RESOURCES.perpetualAdapter, input.release.contracts.packageVerifier.address, input.release.contracts.packageVerifier.runtimeCodeHash),
      adapterClassId: keccak256(stringToHex("base-strategy-perp-port-v1")),
      adapterClassVersion: 1,
      market: resource(BASE_SEPOLIA_RESOURCES.perpetualMarket, input.release.contracts.testPerpMarket.address, input.release.contracts.testPerpMarket.runtimeCodeHash),
      venue: resource(BASE_SEPOLIA_RESOURCES.perpetualVenue, input.release.contracts.testPerpMarket.address, input.release.contracts.testPerpMarket.runtimeCodeHash),
      quantityAtoms: input.quantityAtoms,
      limitQuoteAtomsPerBaseLot: perpetualLimitAtoms,
    }),
    baseAsset: Object.freeze({
      ...resource(BASE_SEPOLIA_RESOURCES.baseAsset, input.release.externalDependencies.weth.address, input.release.externalDependencies.weth.runtimeCodeHash),
      decimals: 18,
    }),
    quoteAsset: Object.freeze({
      ...resource(BASE_SEPOLIA_RESOURCES.quoteAsset, input.release.externalDependencies.testUsdc.address, input.release.externalDependencies.testUsdc.runtimeCodeHash),
      decimals: 6,
    }),
    action,
    packageNotionalQuoteAtoms,
  });
}

function commonExecution(input, action, nonce, deadline, hashes, packageNotionalQuoteAtoms) {
  const release = input.release;
  return {
    domainIdHash: keccak256(stringToHex("eip155:84532")),
    domainManifestVersion: release.domainManifest.manifestVersion,
    domainManifestHash: release.domainManifest.manifestHash,
    orderHash: hashes.orderHash,
    quoteHash: hashes.quoteHash,
    routeHash: hashes.routeHash,
    spotFillCommitment: spotFillCommitment(hashes.orderHash, hashes.quoteHash, hashes.routeHash),
    packageQuoteIntentHash: ZERO_HASH,
    seriesIdentityKey: BASE_SEPOLIA_SERIES.identityKey,
    seriesBindingVersion: BASE_SEPOLIA_SERIES.bindingVersion,
    seriesBindingHash: BASE_SEPOLIA_SERIES.bindingHash,
    action,
    strategyAccount: input.strategyAccount,
    solver: input.solver,
    spotPort: release.contracts.spotPort.address,
    perpObserver: release.contracts.testPerpMarket.address,
    perpInstrument: release.contracts.testPerpMarket.address,
    perpExpiry: input.perpExpiry,
    baseToken: release.externalDependencies.weth.address,
    quoteToken: release.externalDependencies.testUsdc.address,
    baseQuantityAtoms: input.quantityAtoms,
    perpQuantityWad: input.quantityAtoms,
    packageNotionalQuoteAtoms,
    packageSizeUnits: input.quantityAtoms / BASE_SEPOLIA_SERIES.spotBaseAtomsPerPackageUnit,
    nonce,
    deadline,
  };
}

export function buildBaseSepoliaEntryPlan(input) {
  const hashes = Object.freeze({
    orderHash: hash("entry-order", input.nonce),
    quoteHash: hash("entry-quote", input.nonce),
    routeHash: hash("entry-route", input.nonce),
  });
  const limits = deriveTestPerpEntryLimits({
    previewEntryNotionalWad: input.previewEntryNotionalWad,
    balanceWad: input.marginAtoms * input.collateralScale,
    oracleMoveAllowanceBps: input.oracleMoveAllowanceBps,
    market: {
      takerFeeBps: input.takerFeeBps,
      initialMarginBps: input.initialMarginBps,
      collateralScale: input.collateralScale,
    },
  });
  const spotLimitAtoms = ceilDiv(input.spotQuoteAtoms * (BPS + input.spotSlippageBps), BPS);
  const perpetualLimitAtoms = ceilDiv(limits.maximumPostPerpEntryNotionalWad, input.collateralScale);
  const resourceAdmission = admission(input, 1, spotLimitAtoms, perpetualLimitAtoms);
  const execution = Object.freeze({
    ...commonExecution(input, 1, input.nonce, input.deadline, hashes, resourceAdmission.packageNotionalQuoteAtoms),
    spotQuoteBoundAtoms: spotLimitAtoms,
    expectedPrePerpBalanceWad: 0n,
    expectedPrePerpSizeWad: 0n,
    expectedPrePerpEntryNotionalWad: 0n,
    expectedPostPerpSizeWad: -input.quantityAtoms,
    ...limits,
    entryReceiptHash: ZERO_HASH,
  });
  return Object.freeze({
    execution,
    admission: resourceAdmission,
    perpArgs: encodeTestPerpTradeArgs({
      deadline: input.deadline,
      expiry: input.perpExpiry,
      sizeDeltaWad: -input.quantityAtoms,
      balanceDeltaWad: input.marginAtoms * input.collateralScale,
    }),
  });
}

export function failedPostconditionEntryPlan(plan) {
  return Object.freeze({
    ...plan,
    execution: Object.freeze({
      ...plan.execution,
      minimumPostPerpBalanceWad: 0n,
      maximumPostPerpBalanceWad: 0n,
    }),
  });
}

export function buildBaseSepoliaExitPlan(input) {
  const hashes = Object.freeze({
    orderHash: hash("exit-order", input.nonce),
    quoteHash: hash("exit-quote", input.nonce),
    routeHash: hash("exit-route", input.nonce),
  });
  const spotLimitAtoms = input.spotQuoteAtoms * (BPS - input.spotSlippageBps) / BPS;
  if (spotLimitAtoms <= 0n) throw new Error("exit spot floor is zero");
  const resourceAdmission = admission(input, 2, spotLimitAtoms, spotLimitAtoms);
  const execution = Object.freeze({
    ...commonExecution(input, 2, input.nonce, input.deadline, hashes, resourceAdmission.packageNotionalQuoteAtoms),
    spotQuoteBoundAtoms: spotLimitAtoms,
    expectedPrePerpBalanceWad: input.position.balance,
    expectedPrePerpSizeWad: input.position.size,
    expectedPrePerpEntryNotionalWad: input.position.entryNotional,
    expectedPostPerpSizeWad: 0n,
    minimumPostPerpBalanceWad: 0n,
    maximumPostPerpBalanceWad: 0n,
    maximumPostPerpEntryNotionalWad: 0n,
    entryReceiptHash: input.entryReceiptHash,
  });
  return Object.freeze({
    execution,
    admission: resourceAdmission,
    perpArgs: encodeTestPerpTradeArgs({
      deadline: input.deadline,
      expiry: input.perpExpiry,
      sizeDeltaWad: input.quantityAtoms,
      balanceDeltaWad: 0n,
    }),
  });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainManifest,
  domainRefFromManifest,
  feePolicyManifestHash,
  packageTemplateManifestHash,
  packageTemplateRegistryRecordHash,
  payloadTemplateHash,
  quoteHash,
  routeHash,
  routePayloadBytes,
  solverQuoteBytes,
  solverSignatureDigest,
  toProtocolJson,
  versionedManifestRef,
  type AdapterRef,
  type AssetRef,
  type DomainManifest,
  type DomainRegistryRecordInput,
  type Hash32,
  type PackageTemplateManifestInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
  type VersionedManifestRef,
} from "@naryx/protocol-types";
import {
  EVM_RUNTIME_IDENTITY,
  type EvmContractIdentity,
  type EvmDeploymentIdentity,
  type EvmManifestResourceIdentity,
} from "@naryx/adapter-evm";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS,
  BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL,
  BaseSepoliaAtomicContextError,
  SqliteExecutionIntentStore,
  SqliteInternalOrderStore,
  composePrivateTerminalRuntime,
  createBaseSepoliaRuntime,
  createBaseSepoliaAtomicContextProvider,
  createCanonicalEntryOrder,
  type ActiveOrderContext,
  type BaseSepoliaAtomicDeploymentConfiguration,
  type BaseSepoliaLiveReadClient,
  type BaseSepoliaRuntimeManifest,
  type SolverAtomicQuoteResponse,
} from "../src/index.js";

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const hashHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, "0").repeat(20)}`;
const bytesHex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

const strategyAccount = address(1);
const spotPort = address(2);
const perpInstrument = address(3);
const perpObserver = address(4);
const baseToken = address(5);
const quoteToken = address(6);
const packageVerifier = address(7);
const solver = address(8);
const spotPool = address(9);
const spotFactory = address(10);
const perpMarketAddress = address(11);
const perpVenueAddress = address(12);

const baseAsset = assetRef("weth", hash(20), 18);
const quoteAsset = assetRef("usdc", hash(21), 6);
const spotAdapter = adapterRef({
  adapterId: "uniswap-v3-spot-v1",
  adapterManifestVersion: 1,
  adapterManifestHash: hash(22),
});
const perpAdapter = adapterRef({
  adapterId: "base-sepolia-conformance-perp-v1",
  adapterManifestVersion: 1,
  adapterManifestHash: hash(23),
});
const spotMarket = versionedManifestRef("weth-usdc-pool", 1, hash(24));
const perpMarket = versionedManifestRef("weth-usdc-conformance-perp", 1, hash(25));
const spotVenue = versionedManifestRef("uniswap-v3-base-sepolia", 1, hash(26));
const perpVenue = versionedManifestRef("naryx-conformance", 1, hash(27));

function manifest(): DomainManifest {
  return domainManifest({
    manifestVersion: 1,
    environment: "testnet",
    domainId: "evm:base-sepolia",
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId,
    runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace,
    chainReference: "84532",
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId,
    executionVerifierCodeHash: hash(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId,
    finalityPolicyHash: hash(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId,
    supportedSettlementClasses: ["ATOMIC_POSTCONDITION"],
  });
}

function contractIdentity(localAddress: Address, codeHashByte: number): EvmContractIdentity {
  return { address: localAddress, expectedCodeHash: hashHex(codeHashByte) };
}

function resource(
  subjectId: string,
  manifestVersion: number,
  manifestHash: Hash32,
  localAddress: Address,
  codeHashByte: number,
): EvmManifestResourceIdentity {
  return {
    subjectId,
    manifestVersion,
    manifestHash,
    ...contractIdentity(localAddress, codeHashByte),
  };
}

function activeRecord(
  domainManifestValue: DomainManifest,
  templateManifest: PackageTemplateManifestInput,
  kind: "ASSET" | "ADAPTER" | "VENUE" | "MARKET",
  reference: AssetRef | AdapterRef | VersionedManifestRef,
): DomainRegistryRecordInput {
  const adapter = "adapterId" in reference;
  const asset = "assetId" in reference;
  return {
    recordVersion: 1,
    environment: "testnet",
    domain: domainRefFromManifest(domainManifestValue),
    recordKind: kind,
    subjectId: adapter ? reference.adapterId : asset ? reference.assetId : reference.subjectId,
    subjectManifestVersion: asset ? 1
      : adapter ? reference.adapterManifestVersion : reference.manifestVersion,
    subjectManifestHash: asset ? reference.assetManifestHash
      : adapter ? reference.adapterManifestHash : reference.manifestHash,
    registryState: "ACTIVE",
    riskLimits: [],
    allowedTemplates: [{
      templateId: templateManifest.templateId,
      templateVersion: templateManifest.templateVersion,
      packageTemplateManifestHash: packageTemplateManifestHash(templateManifest),
    }],
    allowedSettlementClasses: ["ATOMIC_POSTCONDITION"],
    activationUnit: "EVM_UNIX_SECONDS",
    activationValue: 900n,
    governanceReference: "base-sepolia-governance-v1",
  };
}

function setupPackage() {
  const domainManifestValue = manifest();
  const domain = domainRefFromManifest(domainManifestValue);
  const templateManifest: PackageTemplateManifestInput = {
    manifestVersion: 1,
    environment: "testnet",
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    supportedDomains: [domain],
    orderSchemaHash: hash(30),
    quoteSchemaHash: hash(31),
    routeSchemaHash: hash(32),
    receiptSchemaHash: hash(33),
    entryCompilerVersion: 1,
    exitCompilerVersion: 1,
    legCount: 2,
    legTypes: ["spot-purchase", "perp-sale"],
    supportedDirections: ["LONG_SPOT_SHORT_PERP"],
    supportedSettlementClasses: ["ATOMIC_POSTCONDITION"],
    allowedSpotAdapterIds: [spotAdapter.adapterId],
    allowedPerpAdapterIds: [perpAdapter.adapterId],
    riskPolicyHash: hash(34),
  };
  const templateHash = packageTemplateManifestHash(templateManifest);
  const context: ActiveOrderContext = Object.freeze({
    contextId: "base-sepolia-reviewed-v1",
    state: "ACTIVE",
    capturedAtClock: 900n,
    maxStaleness: 1_000n,
    domain,
    environment: "testnet",
    orderVersion: 1,
    templateId: templateManifest.templateId,
    templateVersion: templateManifest.templateVersion,
    packageTemplateManifestHash: templateHash,
    baseAsset,
    quoteAsset,
    spotAdapters: [spotAdapter],
    perpAdapters: [perpAdapter],
    settlementClass: "ATOMIC_POSTCONDITION",
    expiryUnit: "EVM_UNIX_SECONDS",
    expiryTtl: 2_000n,
    spotReferencePrice: {
      baseAsset,
      quoteAsset,
      quoteAtoms: 3_000_000_000n,
      baseAtoms: 1_000_000_000_000_000_000n,
      roundingDirection: "CEIL" as const,
    },
    maxEntrySpread: {
      baseAsset,
      quoteAsset,
      quoteAtoms: 1n,
      baseAtoms: 100n,
      roundingDirection: "CEIL" as const,
    },
    maximumQuantityAtoms: 10_000_000_000_000_000_000n,
    maxSlippageBps: 100,
    maxVenueFeeAtomsByAsset: [{ asset: baseAsset, maxAtoms: 0n }],
    maxMarginAddedAtoms: 1_000_000_000n,
    maxProtocolFeeAtoms: 100_000n,
    maxSolverFeeAtoms: 100_000n,
    maxPriorityFeeAtoms: 100_000n,
    minVenueReserveReturnedAtoms: 0n,
    minWalletQuoteBalanceDeltaAtoms: 0n,
    maxResidualBaseQuantityAtoms: 0n,
  });
  const canonical = createCanonicalEntryOrder(
    (contextId) => contextId === context.contextId ? context : undefined,
    {
      contextId: context.contextId,
      owner: address(13),
      settlementAccount: strategyAccount,
      sizeAtoms: 2_000_000_000_000_000_000n,
      slippageBps: 10,
      idempotencyKey: "base-context-order-0001",
      currentClock: 1_000n,
    },
  );
  const order = canonical.order;
  const templateRegistryRecord = {
    recordVersion: 1,
    environment: "testnet",
    domain,
    templateId: templateManifest.templateId,
    templateVersion: templateManifest.templateVersion,
    packageTemplateManifestHash: templateHash,
    registryState: "ACTIVE" as const,
    activationUnit: "EVM_UNIX_SECONDS" as const,
    activationValue: 900n,
    governanceReference: "base-sepolia-governance-v1",
  };
  const feePolicyManifest = {
    schemaVersion: 1,
    manifestVersion: 1,
    environment: "testnet",
    domain,
    scopeDirection: "LONG_SPOT_SHORT_PERP" as const,
    feePolicyVersion: 1,
    activationUnit: "EVM_UNIX_SECONDS" as const,
    activationValue: 900n,
    serviceFeeRules: [],
    passThroughCostRules: [],
    refundPolicyVersion: 1,
    expiryUnit: "EVM_UNIX_SECONDS" as const,
    expiryValue: 4_000n,
  };
  const feeHash = feePolicyManifestHash(feePolicyManifest);
  const emptyPayload = new Uint8Array();
  const route: RoutePayloadInput = {
    version: 1,
    environment: "testnet",
    domain,
    orderHash: canonical.orderHash,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: templateHash,
    templateRegistryRecordHash: packageTemplateRegistryRecordHash(templateRegistryRecord),
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    solver: "base-sepolia-solver-v1",
    direction: order.direction,
    action: order.action,
    quantityPolicyClass: "EXACT_ATOMIC",
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: order.settlementClass,
    executionPlanKind: "EVM_ATOMIC_BATCH",
    routeExpiryUnit: "EVM_UNIX_SECONDS",
    routeExpiryValue: 2_000n,
    feePolicyVersion: 1,
    feePolicyManifestHash: feeHash,
    accountBindings: [
      {
        routeBindingId: "strategy-account",
        accountIdentity: strategyAccount,
      },
      {
        routeBindingId: "spot-port",
        adapter: spotAdapter,
        adapterBindingId: "uniswap-v3-port",
        accountIdentity: spotPort,
        codeIdentity: hashHex(42),
      },
      {
        routeBindingId: "perp-instrument",
        adapter: perpAdapter,
        adapterBindingId: "conformance-perpetual",
        accountIdentity: perpInstrument,
        codeIdentity: hashHex(45),
      },
    ],
    serviceCharges: [],
    preconditions: [{
      constraintId: "pre-strategy-authorized",
      ruleId: "strategy-authorized-v1",
      accountBindingId: "strategy-account",
      componentId: "strategy-authority",
      comparator: "EQ",
      value: { kind: "BOOLEAN", value: true },
      evidenceRequirementId: "strategy-state",
    }],
    legs: [
      {
        legIndex: 0,
        legRole: "SPOT",
        actionSequence: 0,
        adapter: spotAdapter,
        venue: spotVenue,
        market: spotMarket,
        baseAsset,
        quoteAsset,
        side: "BUY",
        quantity: order.quantity,
        limitPrice: {
          baseAsset,
          quoteAsset,
          quoteAtoms: 303n,
          baseAtoms: 100_000_000_000n,
          roundingDirection: "CEIL",
        },
        timeInForce: "FOK",
        reduceOnly: false,
      },
      {
        legIndex: 1,
        legRole: "PERPETUAL",
        actionSequence: 1,
        adapter: perpAdapter,
        venue: perpVenue,
        market: perpMarket,
        baseAsset,
        quoteAsset,
        side: "SELL",
        quantity: order.quantity,
        limitPrice: {
          baseAsset,
          quoteAsset,
          quoteAtoms: 3n,
          baseAtoms: 1_000_000_000n,
          roundingDirection: "FLOOR",
        },
        timeInForce: "FOK",
        reduceOnly: false,
      },
    ],
    actions: [
      {
        sequence: 0,
        actionClassId: "evm-uniswap-v3-swap-v1",
        legIndex: 0,
        adapter: spotAdapter,
        targetBindingId: "spot-port",
        authorityBindingId: "strategy-account",
        accountMetas: [],
        payload: {
          codecId: "evm-calldata-v1",
          templateLength: 0,
          templateHash: payloadTemplateHash(emptyPayload, []),
          lateBoundFields: [],
        },
      },
      {
        sequence: 1,
        actionClassId: "evm-conformance-perp-v1",
        legIndex: 1,
        adapter: perpAdapter,
        targetBindingId: "perp-instrument",
        authorityBindingId: "strategy-account",
        accountMetas: [],
        payload: {
          codecId: "evm-calldata-v1",
          templateLength: 0,
          templateHash: payloadTemplateHash(emptyPayload, []),
          lateBoundFields: [],
        },
      },
    ],
    postconditions: [
      {
        constraintId: "post-spot-balance",
        ruleId: "spot-balance-delta-v1",
        accountBindingId: "spot-port",
        componentId: "spot-base-delta",
        comparator: "GTE",
        value: { kind: "SIGNED_ASSET_AMOUNT", value: order.quantity },
        evidenceRequirementId: "spot-state",
      },
      {
        constraintId: "post-perp-position",
        ruleId: "perp-position-delta-v1",
        accountBindingId: "perp-instrument",
        componentId: "perp-base-delta",
        comparator: "EQ",
        value: {
          kind: "SIGNED_ASSET_AMOUNT",
          value: { asset: baseAsset, atoms: -order.quantity.atoms },
        },
        evidenceRequirementId: "perp-state",
      },
    ],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: "package-verifier-atomic-v1",
      requiredPreStateComponentIds: ["strategy-state"],
      requiredPostStateComponentIds: ["perp-state", "spot-state"],
      requiredActionEvidenceTypeIds: ["package-verified-receipt"],
      stateReferenceSchemaHash: hash(35),
      receiptSchemaHash: hash(36),
      outcomeSchemaHash: hash(37),
    },
  };
  const routeIdentity = routeHash(route);
  const zeroBase = { asset: baseAsset, atoms: 0n };
  const zeroQuote = { asset: quoteAsset, atoms: 0n };
  const quote: SolverQuoteInput = {
    version: 1,
    environment: "testnet",
    domain,
    orderHash: canonical.orderHash,
    solverId: route.solver,
    solverCapabilityManifestHash: hash(38),
    solverSignatureScheme: "SECP256K1_RECOVERABLE",
    solverVerificationKey: Uint8Array.from(Buffer.from(solver.slice(2), "hex")),
    quoteMode: "EXECUTION_COMMITMENT",
    routeHash: routeIdentity,
    quotedOutcome: {
      kind: "ENTRY_SPREAD",
      entrySpread: {
        baseAsset,
        quoteAsset,
        quoteAtoms: 1n,
        baseAtoms: 200n,
        roundingDirection: "CEIL",
      },
    },
    expectedSpotNotional: { asset: quoteAsset, atoms: 6_000_000_000n },
    expectedPerpNotional: { asset: quoteAsset, atoms: 6_000_000_000n },
    expectedGrossSpotQuantity: order.quantity,
    expectedNetSpotQuantity: order.quantity,
    expectedBaseAssetFee: zeroBase,
    expectedMarginDelta: zeroQuote,
    expectedRawFillFeesByAsset: [zeroBase],
    expectedBuilderFeesByAsset: [zeroBase],
    expectedNormalizedVenueFeesByAsset: [zeroBase],
    solverFee: zeroQuote,
    protocolFee: zeroQuote,
    expectedPriorityFee: zeroQuote,
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: 1,
    feePolicyManifestHash: feeHash,
    validUntilUnit: "EVM_UNIX_SECONDS",
    validUntilValue: 2_500n,
    quoteNonce: 1n,
    signature: new Uint8Array(65).fill(1),
  };
  const quoteIdentity = quoteHash(quote);
  const deployment: EvmDeploymentIdentity = {
    domainManifest: domainManifestValue,
    deploymentChainReference: 84_532n,
    strategyAccount: contractIdentity(strategyAccount, 40),
    packageVerifier: contractIdentity(packageVerifier, 70),
    settlementClass: {
      classId: Uint8Array.from(
        Buffer.from(keccak256(stringToHex("ATOMIC_POSTCONDITION")).slice(2), "hex"),
      ) as Hash32,
      classVersion: 1,
    },
    spot: {
      adapter: resource(spotAdapter.adapterId, 1, spotAdapter.adapterManifestHash, spotPort, 42),
      adapterClassId: "uniswap-v3-spot-port",
      adapterClassVersion: 1,
      market: resource(spotMarket.subjectId, 1, spotMarket.manifestHash, spotPool, 43),
      venue: resource(spotVenue.subjectId, 1, spotVenue.manifestHash, spotFactory, 44),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetual: {
      adapter: resource(perpAdapter.adapterId, 1, perpAdapter.adapterManifestHash, perpInstrument, 45),
      adapterClassId: "base-sepolia-conformance-perpetual",
      adapterClassVersion: 1,
      market: resource(perpMarket.subjectId, 1, perpMarket.manifestHash, perpMarketAddress, 46),
      venue: resource(perpVenue.subjectId, 1, perpVenue.manifestHash, perpVenueAddress, 47),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetualObserver: contractIdentity(perpObserver, 48),
    baseAsset: { ...resource(baseAsset.assetId, 1, baseAsset.assetManifestHash, baseToken, 49), decimals: 18 },
    quoteAsset: { ...resource(quoteAsset.assetId, 1, quoteAsset.assetManifestHash, quoteToken, 50), decimals: 6 },
  };
  const configuration: BaseSepoliaAtomicDeploymentConfiguration = {
    admission: {
      domainManifest: domainManifestValue,
      templateManifest,
      templateRegistryRecord,
      feePolicyManifest,
      activeRegistryRecords: [
        activeRecord(domainManifestValue, templateManifest, "ASSET", baseAsset),
        activeRecord(domainManifestValue, templateManifest, "ASSET", quoteAsset),
        activeRecord(domainManifestValue, templateManifest, "ADAPTER", spotAdapter),
        activeRecord(domainManifestValue, templateManifest, "ADAPTER", perpAdapter),
        activeRecord(domainManifestValue, templateManifest, "VENUE", spotVenue),
        activeRecord(domainManifestValue, templateManifest, "VENUE", perpVenue),
        activeRecord(domainManifestValue, templateManifest, "MARKET", spotMarket),
        activeRecord(domainManifestValue, templateManifest, "MARKET", perpMarket),
      ],
    },
    deployment,
    uniswapV3: {
      spotPort: contractIdentity(spotPort, 42),
      pool: contractIdentity(spotPool, 43),
      factory: contractIdentity(spotFactory, 44),
    },
    conformancePerpetual: {
      instrument: contractIdentity(perpInstrument, 45),
      observer: contractIdentity(perpObserver, 48),
      evidenceLabel: BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL,
    },
    seriesBindingInput: {
      schemaVersion: 1,
      bindingVersion: 1,
      domain,
      seriesManifestHash: hash(81),
      executionClassManifestHash: hash(82),
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      templateManifestHash: templateHash,
      settlementClass: "ATOMIC_POSTCONDITION",
      settlementClassVersion: 1,
      baseAsset: {
        subjectIdentity: Uint8Array.from(Buffer.from(keccak256(stringToHex(baseAsset.assetId)).slice(2), "hex")) as Hash32,
        manifestVersion: 1,
        manifestHash: baseAsset.assetManifestHash,
      },
      quoteAsset: {
        subjectIdentity: Uint8Array.from(Buffer.from(keccak256(stringToHex(quoteAsset.assetId)).slice(2), "hex")) as Hash32,
        manifestVersion: 1,
        manifestHash: quoteAsset.assetManifestHash,
      },
      quoteConvention: "annualized-net-yield-v1",
      entrySide: "ASK",
      spotBaseAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
      perpQuantityAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
    },
    executionBounds: {
      spotFillCommitment: hash(55),
      expectedPrePerpBalanceWad: 10n,
      minimumPostPerpBalanceWad: 0n,
      maximumPostPerpBalanceWad: 100n,
      maximumPostPerpEntryNotionalWad: 7_000_000_000_000_000_000_000n,
      perpExpiry: 1_900_000_000,
      perpArgs: [hash(56), hash(57)],
    },
    atomicEvidenceClass: BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS,
    finality: {
      policy: { requiredConfirmations: 5, requireFinalized: true },
      manifestHash: hash(71),
    },
  };
  const response: SolverAtomicQuoteResponse = {
    version: 1,
    status: "SIGNED",
    idempotencyKey: "base-context-quote-0001",
    orderHash: bytesHex(canonical.orderHash),
    routeHash: bytesHex(routeIdentity),
    quoteHash: bytesHex(quoteIdentity),
    solverSignatureDigest: bytesHex(solverSignatureDigest(quote)),
    routeBytes: bytesHex(routePayloadBytes(route)),
    solverQuoteBytes: bytesHex(solverQuoteBytes(quote)),
    route: toProtocolJson(route) as Readonly<Record<string, unknown>>,
    quote: toProtocolJson(quote) as Readonly<Record<string, unknown>>,
  };
  return { canonical, context, configuration, response };
}

test("materializes a reviewed Base Sepolia context from durable selected evidence", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-context-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const fixture = setupPackage();
    const record = orders.createOrGet({
      order: fixture.canonical,
      request: {
        contextId: fixture.context.contextId,
        owner: fixture.canonical.order.owner,
        settlementAccount: fixture.canonical.order.settlementAccount,
        sizeAtoms: fixture.canonical.order.quantity.atoms,
        slippageBps: 10,
        idempotencyKey: "base-context-order-0001",
        currentClock: 1_000n,
      },
    }).record;
    intents.recordQuote(fixture.response);
    const attempt = intents.selectQuoteForOrder(record, fixture.context.domain, fixture.response.quoteHash);
    const provider = createBaseSepoliaAtomicContextProvider({
      intents,
      orders,
      deployments: [fixture.configuration],
      currentUnixSeconds: () => 1_500n,
    });
    const context = provider(attempt.attemptId);
    assert.equal(context.admission.orderHash[0], fixture.canonical.orderHash[0]);
    assert.equal(context.deployment.strategyAccount.address, strategyAccount);
    assert.equal(context.atomicBinding.orderHash, `0x${record.orderHashHex}`);
    assert.equal(context.atomicBinding.quoteHash, `0x${fixture.response.quoteHash}`);
    assert.equal(context.atomicBinding.routeHash, `0x${fixture.response.routeHash}`);
    assert.equal(context.atomicBinding.packageVerifier, packageVerifier);
    assert.equal(context.bounds.currentUnixSeconds, 1_500n);
    assert.deepEqual(context.finality, { requiredConfirmations: 5, requireFinalized: true });

    assert.throws(
      () => createBaseSepoliaAtomicContextProvider({
        intents,
        orders,
        deployments: [],
        currentUnixSeconds: () => 1_500n,
      })(attempt.attemptId),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "DEPLOYMENT_NOT_FOUND",
    );
    assert.throws(
      () => createBaseSepoliaAtomicContextProvider({
        intents,
        orders,
        deployments: [fixture.configuration],
        currentUnixSeconds: () => 2_500n,
      })(attempt.attemptId),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "PACKAGE_ADMISSION_FAILED",
    );
    assert.throws(
      () => provider(`base-atomic-${"0".repeat(52)}`),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "ATTEMPT_NOT_FOUND",
    );
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fails closed on deployment code and evidence mismatches", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-context-mismatch-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const fixture = setupPackage();
    const record = orders.createOrGet({
      order: fixture.canonical,
      request: {
        contextId: fixture.context.contextId,
        owner: fixture.canonical.order.owner,
        settlementAccount: fixture.canonical.order.settlementAccount,
        sizeAtoms: fixture.canonical.order.quantity.atoms,
        slippageBps: 10,
        idempotencyKey: "base-context-order-0001",
        currentClock: 1_000n,
      },
    }).record;
    intents.recordQuote(fixture.response);
    const attempt = intents.selectQuoteForOrder(record, fixture.context.domain, fixture.response.quoteHash);
    const invoke = (configuration: BaseSepoliaAtomicDeploymentConfiguration) =>
      createBaseSepoliaAtomicContextProvider({
        intents,
        orders,
        deployments: [configuration],
        currentUnixSeconds: () => 1_500n,
      })(attempt.attemptId);

    assert.throws(
      () => invoke({
        ...fixture.configuration,
        uniswapV3: {
          ...fixture.configuration.uniswapV3,
          pool: contractIdentity(spotPool, 99),
        },
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "SPOT_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => invoke({
        ...fixture.configuration,
        atomicEvidenceClass: "UNSUPPORTED" as typeof BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS,
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "UNSUPPORTED_EVIDENCE_CLASS",
    );
    assert.throws(
      () => invoke({
        ...fixture.configuration,
        conformancePerpetual: {
          ...fixture.configuration.conformancePerpetual,
          evidenceLabel: "PRODUCTION" as typeof BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL,
        },
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "PERPETUAL_IDENTITY_MISMATCH",
    );
    assert.throws(
      () => invoke({
        ...fixture.configuration,
        finality: {
          ...fixture.configuration.finality,
          manifestHash: hash(72),
        },
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "FINALITY_POLICY_MISMATCH",
    );
    assert.throws(
      () => invoke({
        ...fixture.configuration,
        deployment: {
          ...fixture.configuration.deployment,
          packageVerifier: contractIdentity(packageVerifier, 99),
        },
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "DEPLOYMENT_ADMISSION_FAILED",
    );
    assert.throws(
      () => invoke({
        ...fixture.configuration,
        deployment: {
          ...fixture.configuration.deployment,
          spot: {
            ...fixture.configuration.deployment.spot,
            market: {
              ...fixture.configuration.deployment.spot.market,
              manifestHash: hash(99),
            },
          },
        },
      }),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "DEPLOYMENT_ADMISSION_FAILED",
    );
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rejects selected solver evidence with a mismatched signature digest", () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-context-signature-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const fixture = setupPackage();
    const record = orders.createOrGet({
      order: fixture.canonical,
      request: {
        contextId: fixture.context.contextId,
        owner: fixture.canonical.order.owner,
        settlementAccount: fixture.canonical.order.settlementAccount,
        sizeAtoms: fixture.canonical.order.quantity.atoms,
        slippageBps: 10,
        idempotencyKey: "base-context-order-0001",
        currentClock: 1_000n,
      },
    }).record;
    intents.recordQuote({ ...fixture.response, solverSignatureDigest: "99".repeat(32) });
    const attempt = intents.selectQuoteForOrder(record, fixture.context.domain, fixture.response.quoteHash);
    const provider = createBaseSepoliaAtomicContextProvider({
      intents,
      orders,
      deployments: [fixture.configuration],
      currentUnixSeconds: () => 1_500n,
    });
    assert.throws(
      () => provider(attempt.attemptId),
      (error: unknown) => error instanceof BaseSepoliaAtomicContextError
        && error.code === "SIGNED_EVIDENCE_MISMATCH",
    );
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function liveClient(
  configuration: BaseSepoliaAtomicDeploymentConfiguration,
  chainId = 84_532n,
  wrongAddress?: Address,
): BaseSepoliaLiveReadClient {
  const deployment = configuration.deployment;
  const identities = [
    deployment.strategyAccount,
    deployment.packageVerifier,
    deployment.spot.adapter,
    deployment.spot.market,
    deployment.spot.venue,
    deployment.perpetual.adapter,
    deployment.perpetual.market,
    deployment.perpetual.venue,
    deployment.perpetualObserver,
    deployment.baseAsset,
    deployment.quoteAsset,
  ];
  const hashes = new Map(identities.map((identity) => [identity.address.toLowerCase(), identity.expectedCodeHash]));
  return {
    chainId: async () => chainId,
    codeHash: async (localAddress) => localAddress.toLowerCase() === wrongAddress?.toLowerCase()
      ? hashHex(99)
      : hashes.get(localAddress.toLowerCase()),
    transactionReceipt: async () => null,
    readContract: async () => { throw new Error("unexpected contract read"); },
    chainHead: async () => ({ latestBlock: 1n, finalizedBlock: 1n }),
  };
}

test("composes the active Base Sepolia runtime after live chain and code verification", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-runtime-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const fixture = setupPackage();
    const manifest: BaseSepoliaRuntimeManifest = {
      schemaVersion: 1,
      activationState: "ACTIVE",
      deployment: fixture.configuration,
    };
    const ports = await createBaseSepoliaRuntime({
      manifest,
      intents,
      orders,
      client: liveClient(fixture.configuration),
      currentUnixSeconds: () => 1_500n,
    });
    const runtime = composePrivateTerminalRuntime({
      NARYX_BASE_TESTNET_RUNTIME_ENABLED: "true",
    }, { evmTestnet: () => ports });
    assert.equal(typeof runtime.evmTestnet.authorization?.prepare, "function");
    assert.equal(typeof runtime.evmTestnet.preparation?.prepare, "function");
    assert.equal(typeof runtime.evmTestnet.atomicObservation?.observe, "function");
    assert.deepEqual(runtime.health.baseTestnetAtomic, { available: true, reason: null });
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rejects wrong Base chain, deployed code, and activation state", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-base-runtime-reject-"));
  const orders = new SqliteInternalOrderStore(join(scratch, "orders.db"));
  const intents = new SqliteExecutionIntentStore(join(scratch, "intents.db"));
  try {
    const fixture = setupPackage();
    const manifest: BaseSepoliaRuntimeManifest = {
      schemaVersion: 1,
      activationState: "ACTIVE",
      deployment: fixture.configuration,
    };
    await assert.rejects(
      createBaseSepoliaRuntime({ manifest, intents, orders, client: liveClient(fixture.configuration, 1n) }),
      /chain ID does not match/,
    );
    await assert.rejects(
      createBaseSepoliaRuntime({
        manifest,
        intents,
        orders,
        client: liveClient(fixture.configuration, 84_532n, packageVerifier),
      }),
      /deployed code does not match/,
    );
    await assert.rejects(
      createBaseSepoliaRuntime({
        manifest: { ...manifest, activationState: "ALL_PAUSED" } as unknown as BaseSepoliaRuntimeManifest,
        intents,
        orders,
        client: liveClient(fixture.configuration),
      }),
      /must be schema version 1 and ACTIVE/,
    );
  } finally {
    intents.close();
    orders.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

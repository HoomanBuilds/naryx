import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  adapterRef,
  assetRef,
  domainManifest,
  domainRefFromManifest,
  versionedManifestRef,
  type CashCarrySeriesBindingV1Input,
  type DomainManifest,
  type Hash32,
  type PackageAdmission,
} from "@naryx/protocol-types";
import {
  EVM_RUNTIME_IDENTITY,
  type EvmDeploymentIdentity,
  type EvmManifestResourceIdentity,
  type EvmReadPort,
} from "@naryx/adapter-evm";
import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  createEvmTestnetTerminalPorts,
  createPrivateTerminalServer,
  InMemoryPreparedEvmTestnetAtomicStore,
} from "../src/index.js";

const hashBytes = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const hashHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex;
const addressOf = (byte: number): Address => `0x${byte.toString(16).padStart(2, "0").repeat(20)}` as Address;
const signatureHex = (byte: number): string => `0x${byte.toString(16).padStart(2, "0").repeat(65)}`;
const hashHexBytes = (value: Hex): Hash32 => Uint8Array.from(Buffer.from(value.slice(2), "hex")) as Hash32;

const strategyAccount = addressOf(1);
const spotPort = addressOf(2);
const perpInstrument = addressOf(3);
const perpObserver = addressOf(4);
const baseToken = addressOf(5);
const quoteToken = addressOf(6);
const packageVerifier = addressOf(7);
const solver = addressOf(8);

const baseAsset = assetRef("eth", hashBytes(20), 18);
const quoteAsset = assetRef("usdc", hashBytes(21), 6);
const spotAdapter = adapterRef({
  adapterId: "uniswap-v3-spot-v1",
  adapterManifestVersion: 1,
  adapterManifestHash: hashBytes(22),
});
const perpAdapter = adapterRef({
  adapterId: "synfutures-perp-v1",
  adapterManifestVersion: 1,
  adapterManifestHash: hashBytes(23),
});
const spotMarket = versionedManifestRef("eth-usdc-spot", 1, hashBytes(24));
const perpMarket = versionedManifestRef("eth-usdc-perp", 1, hashBytes(25));
const spotVenue = versionedManifestRef("uniswap-v3", 1, hashBytes(26));
const perpVenue = versionedManifestRef("synfutures", 1, hashBytes(27));
const atomicSettlementClassId = Uint8Array.from(
  Buffer.from(keccak256(stringToHex("ATOMIC_POSTCONDITION")).slice(2), "hex"),
) as Hash32;

function baseManifest(
  domainId: string,
  chainReference: bigint,
  settlementClasses: readonly ("ATOMIC_POSTCONDITION" | "ASYNC_BONDED_SOLVER")[] = ["ATOMIC_POSTCONDITION"],
): DomainManifest {
  return domainManifest({
    manifestVersion: 1,
    environment: "testnet",
    domainId,
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId,
    runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace,
    chainReference: chainReference.toString(),
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId,
    executionVerifierCodeHash: hashBytes(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId,
    finalityPolicyHash: hashBytes(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId,
    supportedSettlementClasses: [...settlementClasses],
  });
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
    address: localAddress,
    expectedCodeHash: hashHex(codeHashByte),
  };
}

function baseDeployment(manifest: DomainManifest, chainReference: bigint): EvmDeploymentIdentity {
  return {
    domainManifest: manifest,
    deploymentChainReference: chainReference,
    strategyAccount: { address: strategyAccount, expectedCodeHash: hashHex(40) },
    packageVerifier: { address: packageVerifier, expectedCodeHash: hashHex(70) },
    settlementClass: { classId: atomicSettlementClassId, classVersion: 1 },
    spot: {
      adapter: resource(spotAdapter.adapterId, spotAdapter.adapterManifestVersion, spotAdapter.adapterManifestHash, spotPort, 42),
      adapterClassId: "exact-spot-port",
      adapterClassVersion: 1,
      market: resource(spotMarket.subjectId, spotMarket.manifestVersion, spotMarket.manifestHash, addressOf(9), 43),
      venue: resource(spotVenue.subjectId, spotVenue.manifestVersion, spotVenue.manifestHash, addressOf(10), 44),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetual: {
      adapter: resource(perpAdapter.adapterId, perpAdapter.adapterManifestVersion, perpAdapter.adapterManifestHash, perpInstrument, 45),
      adapterClassId: "synfutures-instrument",
      adapterClassVersion: 1,
      market: resource(perpMarket.subjectId, perpMarket.manifestVersion, perpMarket.manifestHash, addressOf(11), 46),
      venue: resource(perpVenue.subjectId, perpVenue.manifestVersion, perpVenue.manifestHash, addressOf(12), 47),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetualObserver: { address: perpObserver, expectedCodeHash: hashHex(48) },
    baseAsset: {
      ...resource(baseAsset.assetId, 1, baseAsset.assetManifestHash, baseToken, 49),
      decimals: baseAsset.decimals,
    },
    quoteAsset: {
      ...resource(quoteAsset.assetId, 1, quoteAsset.assetManifestHash, quoteToken, 50),
      decimals: quoteAsset.decimals,
    },
  };
}

function baseSeriesBinding(manifest: DomainManifest): CashCarrySeriesBindingV1Input {
  return {
    schemaVersion: 1,
    bindingVersion: 1,
    domain: domainRefFromManifest(manifest),
    seriesManifestHash: hashBytes(81),
    executionClassManifestHash: hashBytes(82),
    templateId: "cash-and-carry-v1",
    templateVersion: 1,
    templateManifestHash: hashBytes(54),
    settlementClass: "ATOMIC_POSTCONDITION",
    settlementClassVersion: 1,
    baseAsset: {
      subjectIdentity: hashHexBytes(keccak256(stringToHex(baseAsset.assetId)) as Hex),
      manifestVersion: 1,
      manifestHash: baseAsset.assetManifestHash,
    },
    quoteAsset: {
      subjectIdentity: hashHexBytes(keccak256(stringToHex(quoteAsset.assetId)) as Hex),
      manifestVersion: 1,
      manifestHash: quoteAsset.assetManifestHash,
    },
    quoteConvention: "annualized-net-yield-v1",
    entrySide: "ASK",
    spotBaseAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
    perpQuantityAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
  };
}

function baseAdmission(manifest: DomainManifest): PackageAdmission {
  const domain = domainRefFromManifest(manifest);
  const orderHash = hashBytes(51);
  const routeHash = hashBytes(52);
  const quoteHash = hashBytes(53);
  const quantity = 2_000_000_000_000_000_000n;
  return {
    orderHash,
    routeHash,
    quoteHash,
    order: {
      environment: "testnet",
      domain,
      templateId: "cash-and-carry-v1",
      templateVersion: 1,
      packageTemplateManifestHash: hashBytes(54),
      owner: addressOf(13),
      settlementAccount: strategyAccount,
      nonce: 9n,
      expiryUnit: "EVM_UNIX_SECONDS",
      expiryValue: 3_000n,
      direction: "LONG_SPOT_SHORT_PERP",
      action: "ENTRY",
      partialFillPolicy: "EXACT_ALL_LEGS",
      quantity: { asset: baseAsset, atoms: quantity },
      expectedPrePositionSize: { asset: baseAsset, atoms: 0n },
      expectedPrePositionEntryNotional: { asset: quoteAsset, atoms: 0n },
      maxSpotQuoteIn: { asset: quoteAsset, atoms: 7_000_000_000n },
      settlementClass: "ATOMIC_POSTCONDITION",
    },
    quote: {
      environment: "testnet",
      domain,
      orderHash,
      routeHash,
      solverSignatureScheme: "SECP256K1_RECOVERABLE",
      solverVerificationKey: Uint8Array.from(Buffer.from(solver.slice(2), "hex")),
      expectedSpotNotional: { asset: quoteAsset, atoms: 6_000_000_000n },
      validUntilUnit: "EVM_UNIX_SECONDS",
      validUntilValue: 2_500n,
      signature: new Uint8Array(65).fill(1),
    },
    route: {
      environment: "testnet",
      domain,
      orderHash,
      settlementAccount: strategyAccount,
      direction: "LONG_SPOT_SHORT_PERP",
      action: "ENTRY",
      partialFillPolicy: "EXACT_ALL_LEGS",
      settlementClass: "ATOMIC_POSTCONDITION",
      executionPlanKind: "EVM_ATOMIC_BATCH",
      routeExpiryUnit: "EVM_UNIX_SECONDS",
      routeExpiryValue: 2_000n,
      accountBindings: [
        { routeBindingId: "strategy-account", accountIdentity: strategyAccount },
        { routeBindingId: "spot-port", accountIdentity: spotPort },
        { routeBindingId: "perp-instrument", accountIdentity: perpInstrument },
      ],
      serviceCharges: [],
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
          quantity: { asset: baseAsset, atoms: quantity },
          limitPrice: { baseAsset, quoteAsset, quoteAtoms: 3_000_000n, baseAtoms: 1_000_000_000_000_000_000n, roundingDirection: "CEIL" },
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
          quantity: { asset: baseAsset, atoms: quantity },
          limitPrice: { baseAsset, quoteAsset, quoteAtoms: 2_900_000n, baseAtoms: 1_000_000_000_000_000_000n, roundingDirection: "FLOOR" },
        },
      ],
      actions: [
        { sequence: 0, adapter: spotAdapter, targetBindingId: "spot-port", authorityBindingId: "strategy-account" },
        { sequence: 1, adapter: perpAdapter, targetBindingId: "perp-instrument", authorityBindingId: "strategy-account" },
      ],
    },
  } as unknown as PackageAdmission;
}

async function listen(server: ReturnType<typeof createPrivateTerminalServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createPrivateTerminalServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("evm testnet terminal unavailable defaults are 503 and health is false", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const server = createPrivateTerminalServer(config);
  const url = await listen(server);
  try {
    const health = await fetch(`${url}/internal/healthz`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as Record<string, unknown>;
    assert.equal(body.evmTestnetAtomicAuthorizationAvailable, false);
    assert.equal(body.evmTestnetAtomicPreparationAvailable, false);
    assert.equal(body.evmTestnetAtomicObservationAvailable, false);
    assert.equal(body.evmTestnetAsyncObservationAvailable, false);
    for (const [path, payload] of [
      ["/internal/terminal/evm-testnet/prepare-atomic-authorization", { attemptId: "attempt-base-0123456789", idempotencyKey: "idem-base-0123456789AB" }],
      ["/internal/terminal/evm-testnet/prepare-atomic", { attemptId: "attempt-base-0123456789", idempotencyKey: "idem-base-0123456789AB", traderSignature: signatureHex(9) }],
      ["/internal/terminal/evm-testnet/observe-atomic", { attemptId: "attempt-base-0123456789", idempotencyKey: "idem-base-0123456789AB", transactionHash: hashHex(61) }],
      ["/internal/terminal/evm-testnet/observe-async", { attemptId: "attempt-arb-pending-01", idempotencyKey: "idem-arb-pending-0001" }],
    ] as const) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 503);
      const unavailable = (await response.json()) as { error: { code: string } };
      assert.equal(unavailable.error.code, "EXECUTION_UNAVAILABLE");
    }
  } finally {
    await close(server);
  }
});

test("evm testnet terminal prepares atomically and observes without browser-controlled fields", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };

  const baseDomainId = "evm:base-sepolia";
  const baseChain = 84_532n;
  const manifest = baseManifest(baseDomainId, baseChain);
  const admission = baseAdmission(manifest);
  const deployment = baseDeployment(manifest, baseChain);
  const seriesInput = baseSeriesBinding(manifest);
  const boundsBase = {
    currentUnixSeconds: 1_000n,
    spotFillCommitment: hashBytes(55),
    expectedPrePerpBalanceWad: 10n,
    minimumPostPerpBalanceWad: 0n,
    maximumPostPerpBalanceWad: 100n,
    maximumPostPerpEntryNotionalWad: 7_000_000_000_000_000_000_000n,
    perpExpiry: 1_900_000_000,
    perpArgs: [hashBytes(56), hashBytes(57)] as unknown as readonly [Hash32, Hash32],
  };
  const admissionHashes = admission as unknown as { orderHash: Uint8Array; quoteHash: Uint8Array; routeHash: Uint8Array };
  const orderHex = `0x${Buffer.from(admissionHashes.orderHash).toString("hex")}` as Hex;
  const quoteHex = `0x${Buffer.from(admissionHashes.quoteHash).toString("hex")}` as Hex;
  const routeHex = `0x${Buffer.from(admissionHashes.routeHash).toString("hex")}` as Hex;
  const atomicBinding = {
    chainReference: baseChain,
    packageVerifier,
    strategyAccount,
    orderHash: orderHex,
    quoteHash: quoteHex,
    routeHash: routeHex,
    executionPlanKind: "EVM_ATOMIC_BATCH" as const,
  };
  const finality = { requiredConfirmations: 5, requireFinalized: true };

  const receiptHash = hashHex(60);
  const eventSignature = keccak256(stringToHex("PackageVerified(bytes32,address,uint8,address,bool,uint256,uint256,bytes32,bytes32)"));
  const baseDomain = domainRefFromManifest(manifest);
  const baseDomainIdHash = keccak256(stringToHex(baseDomainId)) as Hex;
  const baseDomainManifestHashHex = `0x${Buffer.from(baseDomain.domainManifestHash).toString("hex")}` as Hex;
  const atomicReadPort: EvmReadPort = {
    chainId: async () => baseChain,
    transactionReceipt: async () => ({
      status: "success" as const,
      blockNumber: 100n,
      logs: [
        {
          address: packageVerifier,
          topics: [
            eventSignature,
            receiptHash,
            `0x${"0".repeat(24)}${strategyAccount.slice(2).toLowerCase()}` as Hex,
            `0x${"0".repeat(62)}01` as Hex,
          ],
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
            [solver, false, 1_000n, 900n, hashHex(62), hashHex(63)],
          ),
        },
      ],
    }),
    readContract: async () => ({
      domainIdHash: baseDomainIdHash,
      domainManifestVersion: 1,
      domainManifestHash: baseDomainManifestHashHex,
      orderHash: orderHex,
      quoteHash: quoteHex,
      routeHash: routeHex,
      spotFillCommitment: hashHex(55),
      packageQuoteIntentHash: hashHex(62),
      packageQuoteFillCommitment: hashHex(63),
      seriesIdentityKey: hashHex(72),
      seriesBindingVersion: 1,
      seriesBindingHash: hashHex(73),
      action: 1,
      strategyAccount,
      solver,
      recovery: false,
      baseQuantityAtoms: 1_000n,
      spotQuoteAtoms: 900n,
      packageSizeUnits: 2n,
      prePerpBalanceWad: 0n,
      prePerpSizeWad: 0n,
      prePerpEntryNotionalWad: 0n,
      postPerpBalanceWad: 10n,
      postPerpSizeWad: -2n,
      postPerpEntryNotionalWad: 5n,
      entryReceiptHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
      nonce: 9n,
    }),
    chainHead: async () => ({ latestBlock: 110n, finalizedBlock: 105n }),
  };

  const arbDomainId = "evm:arbitrum-sepolia";
  const arbChain = 421_614n;
  const arbManifest = baseManifest(arbDomainId, arbChain, ["ASYNC_BONDED_SOLVER"]);
  const arbDomain = domainRefFromManifest(arbManifest);
  const coordinator = addressOf(30);
  const entryAdapter = addressOf(31);
  const exitController = addressOf(32);
  const owner = addressOf(33);
  const asyncPackageId = hashHex(80);
  const asyncEntryKey = hashHex(81);
  const asyncExitKey = hashHex(82);
  const executionClassManifestHash = hashHex(74);
  const domainIdHash = keccak256(stringToHex(arbDomainId)) as Hex;
  const domainManifestHashHex = `0x${Buffer.from(arbDomain.domainManifestHash).toString("hex")}` as Hex;
  const asyncBinding = {
    chainReference: arbChain,
    coordinator,
    entryAdapter,
    handler: entryAdapter,
    exitController,
    owner,
    orderHash: hashHex(51),
    quoteHash: hashHex(53),
    routeHash: hashHex(52),
    domainIdHash,
    domainManifestVersion: 1,
    domainManifestHash: domainManifestHashHex,
    executionClassManifestHash,
  };
  const executionClassId = keccak256(stringToHex("ASYNC_BONDED_SOLVER"));
  const asyncTerms = () => ({
    domain: { domainIdHash, manifestVersion: 1, manifestHash: domainManifestHashHex },
    owner,
    solver: addressOf(34),
    adapter: entryAdapter,
    handler: entryAdapter,
    adapterCodeHash: hashHex(75),
    handlerCodeHash: hashHex(75),
    orderHash: hashHex(51),
    quoteHash: hashHex(53),
    routeHash: hashHex(52),
    seriesIdentityKey: hashHex(72),
    seriesBindingVersion: 1,
    seriesBindingHash: hashHex(73),
    executionClassIdentityHash: executionClassId,
    executionClassManifestHash,
    requestPayloadHash: hashHex(76),
    reservationHash: hashHex(77),
    bondHash: hashHex(78),
    recoveryPolicyHash: hashHex(79),
    evidenceSchemaHash: hashHex(83),
  });
  const asyncPackage = (state: number, overrides: Record<string, unknown> = {}) => ({
    terms: asyncTerms(),
    requestKey: asyncEntryKey,
    outcomeEvidenceHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    recoveryEvidenceHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    venueEvidenceCommitment: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    recoveryEvidenceCommitment: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    state,
    stateVersion: 2,
    admissionGeneration: 1,
    recoveryDutyStartedAt: 0,
    lastVenueOutcome: 0,
    hasVenueOutcome: false,
    recoveryDutyActive: false,
    recoveryActionSubmitted: false,
    recoveryProven: false,
    bondSlashed: false,
    evidenceConflict: false,
    settledLossAtoms: 0n,
    ...overrides,
  });
  const asyncEntry = (status: number, overrides: Record<string, unknown> = {}) => ({
    status,
    evidenceHash: status === 1 ? ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex) : hashHex(90),
    positionSizeBefore: 0n,
    positionSizeAfter: status === 2 ? 1_000n : 0n,
    revision: status === 0 ? 0 : 2,
    ...overrides,
  });
  const asyncExit = (status: number, overrides: Record<string, unknown> = {}) => ({
    status,
    evidenceHash: status === 1 ? ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex) : hashHex(91),
    revision: status === 0 ? 0 : 2,
    reconciling: false,
    released: false,
    ...overrides,
  });
  const asyncReceipt = () => ({
    commitment: hashHex(92),
    packageId: asyncPackageId,
    entryRequestKey: asyncEntryKey,
    exitRequestKey: asyncExitKey,
    entryRequestPayloadHash: hashHex(76),
    spotRegistrationHash: hashHex(93),
    exitAuthorizationHash: hashHex(94),
    perpEvidenceHash: hashHex(91),
    spotEvidenceHash: hashHex(95),
    entryCommitmentsHash: hashHex(96),
    exitCommitmentsHash: hashHex(97),
    recipient: owner,
    fullCloseSizeUsd: 1_000n,
    spotBaseAtoms: 500n,
    spotQuoteAtoms: 600n,
    perpStatus: 2,
    terminalState: 1,
  });
  let asyncStage: "pending" | "recovery" | "final" = "pending";
  const expectedOwnerKey = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [entryAdapter, asyncEntryKey]));
  const asyncReadPort: EvmReadPort = {
    chainId: async () => arbChain,
    transactionReceipt: async () => null,
    readContract: async (read) => {
      if (read.functionName === "packageState") {
        if (asyncStage === "pending") return asyncPackage(2);
        if (asyncStage === "recovery") return asyncPackage(7, { recoveryDutyActive: true });
        return asyncPackage(10, { outcomeEvidenceHash: hashHex(90), hasVenueOutcome: true, stateVersion: 5 });
      }
      if (read.functionName === "requestKeyOwner") {
        const key = read.args?.[0] as Hex;
        return key.toLowerCase() === expectedOwnerKey.toLowerCase() ? asyncPackageId : hashHex(99);
      }
      if (read.functionName === "requestEvidence") {
        if (asyncStage === "pending") return asyncEntry(1, { revision: 1 });
        if (asyncStage === "recovery") return asyncEntry(4);
        return asyncEntry(2);
      }
      if (read.functionName === "exitEvidence") return asyncExit(2, { released: true });
      if (read.functionName === "finalPackageReceipt") return asyncReceipt();
      throw new Error("unexpected read");
    },
    chainHead: async () => ({ latestBlock: 100n, finalizedBlock: 95n }),
  };

  const attemptId = "attempt-base-0123456789";
  const idempotencyKey = "idem-base-0123456789AB";
  const traderSignature = signatureHex(9);
  const transactionHash = hashHex(61);
  const replacementHash = hashHex(62);

  const store = new InMemoryPreparedEvmTestnetAtomicStore();
  const ports = createEvmTestnetTerminalPorts({
    atomicContextProvider: (id) => {
      if (id !== attemptId) throw new Error("unknown attempt");
      return { admission, deployment, seriesBindingInput: seriesInput, bounds: boundsBase, atomicBinding, finality };
    },
    asyncContextProvider: (id) => {
      if (id === "attempt-arb-pending-01" || id === "attempt-arb-recovery-02") {
        return { domainManifest: arbManifest, binding: asyncBinding, keys: { packageId: asyncPackageId, entryRequestKey: asyncEntryKey } };
      }
      if (id === "attempt-arb-final-00001") {
        return { domainManifest: arbManifest, binding: asyncBinding, keys: { packageId: asyncPackageId, entryRequestKey: asyncEntryKey, exitRequestKey: asyncExitKey } };
      }
      throw new Error("unknown async attempt");
    },
    atomicReadPort,
    asyncReadPort,
    store,
  });

  const server = createPrivateTerminalServer(config, {}, undefined, undefined, ports);
  const url = await listen(server);
  try {
    const health = (await (await fetch(`${url}/internal/healthz`)).json()) as Record<string, unknown>;
    assert.equal(health.evmTestnetAtomicPreparationAvailable, true);
    assert.equal(health.evmTestnetAtomicAuthorizationAvailable, true);
    assert.equal(health.evmTestnetAtomicObservationAvailable, true);
    assert.equal(health.evmTestnetAsyncObservationAvailable, true);

    const authorizationResponse = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic-authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey }),
    });
    assert.equal(authorizationResponse.status, 200);
    const authorization = (await authorizationResponse.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(authorization).sort(), [
      "attemptId", "chainReference", "digest", "domainId", "domainManifestHash",
      "domainManifestVersion", "environment", "idempotencyKey", "requestCommitment", "typedData",
    ]);
    assert.equal(authorization.environment, "TESTNET");
    assert.equal(authorization.domainId, baseDomainId);
    assert.equal(authorization.chainReference, "84532");
    const typedData = authorization.typedData as {
      domain: { name: string; version: string; chainId: string; verifyingContract: Address };
      types: { TraderPermit: readonly { name: string; type: string }[] };
      primaryType: "TraderPermit";
      message: { packageHash: Hex; accountsHash: Hex; limitsHash: Hex; nonce: string; deadline: string };
    };
    assert.deepEqual(typedData.domain, {
      name: "Naryx Package Verifier",
      version: "1",
      chainId: "84532",
      verifyingContract: packageVerifier,
    });
    assert.equal(authorization.digest, hashTypedData({
      domain: { ...typedData.domain, chainId: 84_532n },
      types: { TraderPermit: typedData.types.TraderPermit },
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        nonce: BigInt(typedData.message.nonce),
        deadline: BigInt(typedData.message.deadline),
      },
    }));
    const rejectedAuthorization = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic-authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, chainReference: "84532" }),
    });
    assert.equal(rejectedAuthorization.status, 400);

    const prepareBody = { attemptId, idempotencyKey, traderSignature };
    const first = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(prepareBody),
    });
    assert.equal(first.status, 200);
    const prepared = (await first.json()) as Record<string, unknown>;
    assert.equal(prepared.environment, "TESTNET");
    assert.equal(prepared.domainId, baseDomainId);
    assert.equal(prepared.domainManifestVersion, 1);
    assert.match(prepared.domainManifestHash as string, /^0x[0-9a-f]{64}$/);
    assert.equal(prepared.chainReference, "84532");
    assert.equal((prepared.to as string).toLowerCase(), strategyAccount.toLowerCase());
    assert.equal(prepared.value, "0");
    assert.match(prepared.data as string, /^0x[0-9a-f]+$/);
    assert.equal(((prepared.data as string).length - 2) % 2, 0);
    assert.match(prepared.orderHash as string, /^0x[0-9a-f]{64}$/);
    assert.match(prepared.requestCommitment as string, /^0x[0-9a-f]{64}$/);
    assert.notEqual(prepared.requestCommitment, `0x${"0".repeat(64)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(prepared)), prepared);

    const replay = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(prepareBody),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), prepared);

    const conflictAttempt = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: "attempt-base-9999999999", idempotencyKey, traderSignature }),
    });
    assert.equal(conflictAttempt.status, 502);

    const conflictSig = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, traderSignature: signatureHex(7) }),
    });
    assert.equal(conflictSig.status, 502);

    for (const extra of [
      { ...prepareBody, plan: {} },
      { ...prepareBody, to: strategyAccount },
      { ...prepareBody, data: "0x1234" },
      { ...prepareBody, rpcUrl: "https://example.invalid" },
      { ...prepareBody, packageId: hashHex(80) },
    ]) {
      const rejected = await fetch(`${url}/internal/terminal/evm-testnet/prepare-atomic`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(extra),
      });
      assert.equal(rejected.status, 400);
    }

    const observeBody = { attemptId, idempotencyKey, transactionHash };
    const observed = await fetch(`${url}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(observeBody),
    });
    assert.equal(observed.status, 200);
    const observation = (await observed.json()) as { lifecycle: string; transactionHash: string; chainReference: string };
    assert.equal(observation.lifecycle, "FINALIZED");
    assert.equal(observation.transactionHash, transactionHash);
    assert.equal(observation.chainReference, "84532");

    const replacement = await fetch(`${url}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash: replacementHash }),
    });
    assert.equal(replacement.status, 502);

    asyncStage = "pending";
    const pending = await fetch(`${url}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: "attempt-arb-pending-01", idempotencyKey: "idem-arb-pending-0001" }),
    });
    assert.equal(pending.status, 200);
    const pendingBody = (await pending.json()) as { lifecycle: string; chainReference: string };
    assert.equal(pendingBody.lifecycle, "REQUEST_SUBMITTED");
    assert.equal(pendingBody.chainReference, "421614");
    assert.ok(!["CONFIRMED", "FINALIZED", "SUBMITTED", "REVERTED"].includes(pendingBody.lifecycle));

    asyncStage = "recovery";
    const recovery = await fetch(`${url}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: "attempt-arb-recovery-02", idempotencyKey: "idem-arb-recovery-0002" }),
    });
    assert.equal(recovery.status, 200);
    assert.equal(((await recovery.json()) as { lifecycle: string }).lifecycle, "RECOVERY_PENDING");

    asyncStage = "final";
    const finished = await fetch(`${url}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: "attempt-arb-final-00001", idempotencyKey: "idem-arb-final-000003" }),
    });
    assert.equal(finished.status, 200);
    const finalBody = (await finished.json()) as { lifecycle: string; exitCompleted: boolean };
    assert.equal(finalBody.lifecycle, "CLOSED");
    assert.equal(finalBody.exitCompleted, true);
  } finally {
    await close(server);
  }

  const badPorts = {
    preparation: {
      prepare: async () => ({ attemptId, idempotencyKey, environment: "TESTNET", extra: true }),
    },
  };
  const badServer = createPrivateTerminalServer(config, {}, undefined, undefined, badPorts as never);
  const badUrl = await listen(badServer);
  try {
    const response = await fetch(`${badUrl}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, traderSignature }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(badServer);
  }
});

test("evm testnet rejects mismatched atomic binding before hash binding", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const baseDomainId = "evm:base-sepolia";
  const baseChain = 84_532n;
  const manifest = baseManifest(baseDomainId, baseChain);
  const admission = baseAdmission(manifest);
  const deployment = baseDeployment(manifest, baseChain);
  const seriesInput = baseSeriesBinding(manifest);
  const boundsBase = {
    currentUnixSeconds: 1_000n,
    spotFillCommitment: hashBytes(55),
    expectedPrePerpBalanceWad: 10n,
    minimumPostPerpBalanceWad: 0n,
    maximumPostPerpBalanceWad: 100n,
    maximumPostPerpEntryNotionalWad: 7_000_000_000_000_000_000_000n,
    perpExpiry: 1_900_000_000,
    perpArgs: [hashBytes(56), hashBytes(57)] as unknown as readonly [Hash32, Hash32],
  };
  const admissionHashes = admission as unknown as { orderHash: Uint8Array; quoteHash: Uint8Array; routeHash: Uint8Array };
  const orderHex = `0x${Buffer.from(admissionHashes.orderHash).toString("hex")}` as Hex;
  const quoteHex = `0x${Buffer.from(admissionHashes.quoteHash).toString("hex")}` as Hex;
  const routeHex = `0x${Buffer.from(admissionHashes.routeHash).toString("hex")}` as Hex;
  const goodBinding = {
    chainReference: baseChain,
    packageVerifier,
    strategyAccount,
    orderHash: orderHex,
    quoteHash: quoteHex,
    routeHash: routeHex,
    executionPlanKind: "EVM_ATOMIC_BATCH" as const,
  };
  const badBinding = { ...goodBinding, chainReference: 1n };
  const finality = { requiredConfirmations: 5, requireFinalized: true };
  const minimalReadPort: EvmReadPort = {
    chainId: async () => baseChain,
    transactionReceipt: async () => null,
    readContract: async () => {
      throw new Error("unexpected contract read");
    },
    chainHead: async () => ({ latestBlock: 110n, finalizedBlock: 105n }),
  };
  const attemptId = "attempt-base-mismatch-01";
  const idempotencyKey = "idem-base-mismatch-0001";
  const traderSignature = signatureHex(9);
  const transactionHash = hashHex(61);
  const otherHash = hashHex(62);

  const badStore = new InMemoryPreparedEvmTestnetAtomicStore();
  const badPorts = createEvmTestnetTerminalPorts({
    atomicContextProvider: () => ({ admission, deployment, seriesBindingInput: seriesInput, bounds: boundsBase, atomicBinding: badBinding, finality }),
    asyncContextProvider: () => {
      throw new Error("unused");
    },
    atomicReadPort: minimalReadPort,
    asyncReadPort: minimalReadPort,
    store: badStore,
  });
  const badServer = createPrivateTerminalServer(config, {}, undefined, undefined, badPorts);
  const badUrl = await listen(badServer);
  try {
    const response = await fetch(`${badUrl}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, traderSignature }),
    });
    assert.equal(response.status, 502);
    assert.equal(badStore.get(idempotencyKey), undefined);
  } finally {
    await close(badServer);
  }

  const sharedStore = new InMemoryPreparedEvmTestnetAtomicStore();
  const goodPorts = createEvmTestnetTerminalPorts({
    atomicContextProvider: () => ({ admission, deployment, seriesBindingInput: seriesInput, bounds: boundsBase, atomicBinding: goodBinding, finality }),
    asyncContextProvider: () => {
      throw new Error("unused");
    },
    atomicReadPort: minimalReadPort,
    asyncReadPort: minimalReadPort,
    store: sharedStore,
  });
  const badObservePorts = createEvmTestnetTerminalPorts({
    atomicContextProvider: () => ({ admission, deployment, seriesBindingInput: seriesInput, bounds: boundsBase, atomicBinding: badBinding, finality }),
    asyncContextProvider: () => {
      throw new Error("unused");
    },
    atomicReadPort: minimalReadPort,
    asyncReadPort: minimalReadPort,
    store: sharedStore,
  });
  const goodServer = createPrivateTerminalServer(config, {}, undefined, undefined, goodPorts);
  const badObserveServer = createPrivateTerminalServer(config, {}, undefined, undefined, badObservePorts);
  const goodUrl = await listen(goodServer);
  const badObserveUrl = await listen(badObserveServer);
  try {
    const prepared = await fetch(`${goodUrl}/internal/terminal/evm-testnet/prepare-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, traderSignature }),
    });
    assert.equal(prepared.status, 200);
    const badObserve = await fetch(`${badObserveUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash }),
    });
    assert.equal(badObserve.status, 502);
    assert.equal(sharedStore.get(idempotencyKey)?.boundTransactionHash, undefined);
    const goodObserve = await fetch(`${goodUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash }),
    });
    assert.equal(goodObserve.status, 200);
    assert.equal(sharedStore.get(idempotencyKey)?.boundTransactionHash, transactionHash.toLowerCase());
    const different = await fetch(`${goodUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash: otherHash }),
    });
    assert.equal(different.status, 502);
  } finally {
    await close(goodServer);
    await close(badObserveServer);
  }
});

test("evm testnet rejects mismatched async domain-manifest chain reference", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const arbDomainId = "evm:arbitrum-sepolia";
  const arbChain = 421_614n;
  const arbManifest = baseManifest(arbDomainId, arbChain, ["ASYNC_BONDED_SOLVER"]);
  const arbDomain = domainRefFromManifest(arbManifest);
  const domainManifestHashHex = `0x${Buffer.from(arbDomain.domainManifestHash).toString("hex")}` as Hex;
  const domainIdHash = keccak256(stringToHex(arbDomainId)) as Hex;
  const goodBinding = {
    chainReference: arbChain,
    coordinator: addressOf(30),
    entryAdapter: addressOf(31),
    handler: addressOf(31),
    exitController: addressOf(32),
    owner: addressOf(33),
    orderHash: hashHex(51),
    quoteHash: hashHex(53),
    routeHash: hashHex(52),
    domainIdHash,
    domainManifestVersion: 1,
    domainManifestHash: domainManifestHashHex,
    executionClassManifestHash: hashHex(74),
  };
  const badBinding = { ...goodBinding, chainReference: 999_999n };
  const dummyReadPort: EvmReadPort = {
    chainId: async () => arbChain,
    transactionReceipt: async () => null,
    readContract: async () => {
      throw new Error("read port must not be called for a mismatched manifest");
    },
    chainHead: async () => ({ latestBlock: 100n, finalizedBlock: 95n }),
  };
  const store = new InMemoryPreparedEvmTestnetAtomicStore();
  const ports = createEvmTestnetTerminalPorts({
    atomicContextProvider: () => {
      throw new Error("unused");
    },
    asyncContextProvider: () => ({
      domainManifest: arbManifest,
      binding: badBinding,
      keys: { packageId: hashHex(80), entryRequestKey: hashHex(81) },
    }),
    atomicReadPort: dummyReadPort,
    asyncReadPort: dummyReadPort,
    store,
  });
  const server = createPrivateTerminalServer(config, {}, undefined, undefined, ports);
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: "attempt-arb-badchain-01", idempotencyKey: "idem-arb-badchain-0001" }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(server);
  }
});

test("evm testnet rejects impossible injected FINALIZED and CLOSED evidence", async () => {
  const origin = "http://127.0.0.1:3000";
  const config = { host: "127.0.0.1", port: 0, terminalOrigin: origin };
  const arbDomainId = "evm:arbitrum-sepolia";
  const arbChain = 421_614n;
  const arbManifest = baseManifest(arbDomainId, arbChain, ["ASYNC_BONDED_SOLVER"]);
  const arbDomain = domainRefFromManifest(arbManifest);
  const arbManifestHashHex = `0x${Buffer.from(arbDomain.domainManifestHash).toString("hex")}` as Hex;
  const attemptId = "attempt-evm-impossible-01";
  const idempotencyKey = "idem-evm-impossible-0001";
  const transactionHash = hashHex(61);
  const asyncAttempt = "attempt-evm-impossible-02";
  const asyncIdem = "idem-evm-impossible-0002";
  const asyncPackageId = hashHex(80);
  const impossibleAtomicPorts = {
    atomicObservation: {
      observe: async (request: { attemptId: string; idempotencyKey: string; transactionHash: string }) => ({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        environment: "TESTNET",
        domainId: "evm:base-sepolia",
        domainManifestVersion: 1,
        domainManifestHash: hashHex(71),
        chainReference: "84532",
        transactionHash: request.transactionHash,
        lifecycle: "FINALIZED",
        evidenceGrade: "none",
        blockNumber: null,
        confirmations: null,
        receiptHash: null,
        packageReceipt: null,
        openPackage: null,
        reason: "impossible",
      }),
    },
  };
  const atomicServer = createPrivateTerminalServer(config, {}, undefined, undefined, impossibleAtomicPorts as never);
  const atomicUrl = await listen(atomicServer);
  try {
    const response = await fetch(`${atomicUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(atomicServer);
  }

  const arbitraryStatusPorts = {
    asyncObservation: {
      observe: async (request: { attemptId: string; idempotencyKey: string }) => ({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        environment: "TESTNET",
        domainId: arbDomainId,
        domainManifestVersion: 1,
        domainManifestHash: arbManifestHashHex,
        chainReference: "421614",
        packageId: asyncPackageId,
        lifecycle: "CLOSED",
        evidenceGrade: "contract-state",
        coordinator: {
          state: "ARBITRARY",
          stateVersion: 1,
          requestKey: hashHex(81),
          outcomeEvidenceHash: hashHex(90),
          recoveryEvidenceHash: hashHex(91),
          hasVenueOutcome: false,
          lastVenueOutcome: 0,
          recoveryDutyActive: false,
          recoveryActionSubmitted: false,
          recoveryProven: false,
          bondSlashed: false,
          evidenceConflict: false,
        },
        entry: {
          status: "BOGUS",
          evidenceHash: hashHex(90),
          positionSizeBefore: "0",
          positionSizeAfter: "0",
          revision: 1,
        },
        exit: {
          status: "WHATEVER",
          evidenceHash: hashHex(91),
          revision: 1,
          reconciling: false,
          released: false,
        },
        finalReceipt: null,
        exitCompleted: false,
        reason: null,
      }),
    },
  };
  const arbitraryServer = createPrivateTerminalServer(config, {}, undefined, undefined, arbitraryStatusPorts as never);
  const arbitraryUrl = await listen(arbitraryServer);
  try {
    const response = await fetch(`${arbitraryUrl}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: asyncAttempt, idempotencyKey: asyncIdem }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(arbitraryServer);
  }

  const exitCompletedPorts = {
    asyncObservation: {
      observe: async (request: { attemptId: string; idempotencyKey: string }) => ({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        environment: "TESTNET",
        domainId: arbDomainId,
        domainManifestVersion: 1,
        domainManifestHash: arbManifestHashHex,
        chainReference: "421614",
        packageId: asyncPackageId,
        lifecycle: "CLOSED",
        evidenceGrade: "contract-state",
        coordinator: {
          state: "CLOSED",
          stateVersion: 2,
          requestKey: hashHex(81),
          outcomeEvidenceHash: hashHex(90),
          recoveryEvidenceHash: hashHex(91),
          hasVenueOutcome: true,
          lastVenueOutcome: 2,
          recoveryDutyActive: false,
          recoveryActionSubmitted: false,
          recoveryProven: false,
          bondSlashed: false,
          evidenceConflict: false,
        },
        entry: {
          status: "EXECUTED",
          evidenceHash: hashHex(90),
          positionSizeBefore: "0",
          positionSizeAfter: "1000",
          revision: 2,
        },
        exit: {
          status: "EXECUTED",
          evidenceHash: hashHex(91),
          revision: 2,
          reconciling: false,
          released: true,
        },
        finalReceipt: null,
        exitCompleted: true,
        reason: null,
      }),
    },
  };
  const exitServer = createPrivateTerminalServer(config, {}, undefined, undefined, exitCompletedPorts as never);
  const exitUrl = await listen(exitServer);
  try {
    const response = await fetch(`${exitUrl}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: asyncAttempt, idempotencyKey: asyncIdem }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(exitServer);
  }

  const nullCoordinatorPorts = {
    asyncObservation: {
      observe: async (request: { attemptId: string; idempotencyKey: string }) => ({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        environment: "TESTNET",
        domainId: arbDomainId,
        domainManifestVersion: 1,
        domainManifestHash: arbManifestHashHex,
        chainReference: "421614",
        packageId: asyncPackageId,
        lifecycle: "CLOSED",
        evidenceGrade: "contract-state",
        coordinator: null,
        entry: null,
        exit: null,
        finalReceipt: null,
        exitCompleted: false,
        reason: null,
      }),
    },
  };
  const nullCoordinatorServer = createPrivateTerminalServer(config, {}, undefined, undefined, nullCoordinatorPorts as never);
  const nullCoordinatorUrl = await listen(nullCoordinatorServer);
  try {
    const response = await fetch(`${nullCoordinatorUrl}/internal/terminal/evm-testnet/observe-async`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId: asyncAttempt, idempotencyKey: asyncIdem }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(nullCoordinatorServer);
  }

  const baseDomainIdHash = keccak256(stringToHex("evm:base-sepolia")) as Hex;
  const receiptMismatchPorts = {
    atomicObservation: {
      observe: async (request: { attemptId: string; idempotencyKey: string; transactionHash: string }) => ({
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        environment: "TESTNET",
        domainId: "evm:base-sepolia",
        domainManifestVersion: 1,
        domainManifestHash: hashHex(71),
        chainReference: "84532",
        transactionHash: request.transactionHash,
        lifecycle: "FINALIZED",
        evidenceGrade: "finalized-contract-receipt",
        blockNumber: "100",
        confirmations: 6,
        receiptHash: hashHex(60),
        packageReceipt: {
          receiptHash: hashHex(61),
          domainIdHash: baseDomainIdHash,
          domainManifestVersion: 1,
          domainManifestHash: hashHex(71),
          orderHash: hashHex(51),
          quoteHash: hashHex(53),
          routeHash: hashHex(52),
          spotFillCommitment: hashHex(55),
          seriesIdentityKey: hashHex(72),
          seriesBindingVersion: 1,
          seriesBindingHash: hashHex(73),
          action: 1,
          strategyAccount: addressOf(1),
          solver: addressOf(8),
          recovery: false,
          baseQuantityAtoms: "1000",
          spotQuoteAtoms: "900",
          packageSizeUnits: "2",
          nonce: "9",
        },
        openPackage: null,
        reason: null,
      }),
    },
  };
  const receiptMismatchServer = createPrivateTerminalServer(config, {}, undefined, undefined, receiptMismatchPorts as never);
  const receiptMismatchUrl = await listen(receiptMismatchServer);
  try {
    const response = await fetch(`${receiptMismatchUrl}/internal/terminal/evm-testnet/observe-atomic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ attemptId, idempotencyKey, transactionHash }),
    });
    assert.equal(response.status, 502);
  } finally {
    await close(receiptMismatchServer);
  }
});

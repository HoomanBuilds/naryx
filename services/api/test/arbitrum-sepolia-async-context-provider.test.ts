import assert from "node:assert/strict";
import test from "node:test";
import { domainManifest, domainRefFromManifest, type Hash32 } from "@naryx/protocol-types";
import { EVM_RUNTIME_IDENTITY } from "@naryx/adapter-evm";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  ARBITRUM_SEPOLIA_GMX_DEPENDENCIES,
  ArbitrumSepoliaAsyncContextError,
  composePrivateTerminalRuntime,
  createArbitrumSepoliaAsyncContextProvider,
  createArbitrumSepoliaAsyncRuntimeFactory,
  createArbitrumSepoliaRuntime,
  loadArbitrumSepoliaRuntimeManifest,
  type ArbitrumSepoliaLiveReadClient,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
  type ExecutionIntentStore,
  type InternalOrderStore,
} from "../src/index.js";
import { arbitrumSepoliaAccountCodeHash } from "../src/arbitrum-sepolia-async-context-provider.js";

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;

function manifest(version: number) {
  return domainManifest({
    manifestVersion: version,
    environment: "testnet",
    domainId: "eip155:421614",
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId,
    runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace,
    chainReference: "421614",
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId,
    executionVerifierCodeHash: hash(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId,
    finalityPolicyHash: hash(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId,
    supportedSettlementClasses: ["ASYNC_BONDED_SOLVER"],
  });
}

function configuration(
  domainManifest: ReturnType<typeof manifest>,
): ArbitrumSepoliaAsyncDeploymentConfiguration {
  const evmAddress = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}` as Address;
  const identity = (address: Address, byte: number) => ({
    address,
    expectedCodeHash: `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as Hex,
  });
  return {
    admission: {} as ArbitrumSepoliaAsyncDeploymentConfiguration["admission"],
    domainManifest,
    protocolConfig: identity(evmAddress(1), 1),
    coordinator: identity(evmAddress(2), 2),
    accountFactory: identity(evmAddress(3), 3),
    accountImplementation: identity(evmAddress(8), 8),
    entryAdapter: identity(evmAddress(4), 4),
    orderVerifier: identity(evmAddress(5), 5),
    market: identity(evmAddress(6), 6),
    collateralToken: identity(evmAddress(7), 7),
    gmx: Object.fromEntries(Object.entries(ARBITRUM_SEPOLIA_GMX_DEPENDENCIES).map(
      ([name, dependency], index) => [name, identity(dependency, 20 + index)],
    )) as ArbitrumSepoliaAsyncDeploymentConfiguration["gmx"],
    executionClassManifestHash: hash(30),
    route: {
      perpetualAdapterId: "gmx-v2-arbitrum",
      perpetualMarketId: "gmx-eth-usd",
      perpetualVenueId: "gmx-v2",
      evidenceProfileId: "gmx-v2-callback-v1",
      seriesIdentityKey: hash(31),
      seriesBindingVersion: 1,
      seriesBindingHash: hash(32),
      stateReferenceSchemaHash: hash(33),
      receiptSchemaHash: hash(34),
      outcomeSchemaHash: hash(35),
      coordinatorEvidenceSchemaHash: hash(36),
    },
    bounds: {
      maximumRouteExpiryValue: 2_000n,
      maximumRecoveryDeadlineValue: 3_000n,
      maximumPackageQuantityAtoms: 1_000n,
    },
    finality: {
      policy: { requiredConfirmations: 20, requireFinalized: true },
      manifestHash: domainManifest.finalityPolicyHash,
    },
  };
}

test("Arbitrum async provider rejects a deployment outside the durable attempt domain", async () => {
  const orderManifest = manifest(1);
  const deploymentManifest = manifest(2);
  const domain = domainRefFromManifest(orderManifest);
  const hashHex = Buffer.from(domain.domainManifestHash).toString("hex");
  const attempt = {
    attemptId: `arbitrum-async-${"1".repeat(48)}`,
    orderHash: "2".repeat(64),
    routeHash: "3".repeat(64),
    quoteHash: "4".repeat(64),
    status: "ARBITRUM_ASYNC_QUOTE_SELECTED" as const,
    selectedAtMs: 1,
    domainId: "eip155:421614" as const,
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: hashHex,
  };
  const intents = {
    getAttempt: () => attempt,
    getSelectedQuote: () => ({
      orderHash: attempt.orderHash,
      routeHash: attempt.routeHash,
      quoteHash: attempt.quoteHash,
    }),
  } as unknown as ExecutionIntentStore;
  const orders = {
    getByOrderHash: () => ({
      domainId: attempt.domainId,
      domainManifestVersion: attempt.domainManifestVersion,
      domainManifestHashHex: attempt.domainManifestHash,
    }),
    getCanonicalOrderByHash: () => ({ domain }),
  } as unknown as InternalOrderStore;
  const provider = createArbitrumSepoliaAsyncContextProvider({
    intents,
    orders,
    deployments: [configuration(deploymentManifest)],
    evidence: () => ({
      attemptId: attempt.attemptId,
      packageId: `0x${"5".repeat(64)}`,
      entryRequestKey: `0x${"6".repeat(64)}`,
    }),
    currentUnixSeconds: () => 1n,
  });
  await assert.rejects(
    provider(attempt.attemptId),
    (error: unknown) => error instanceof ArbitrumSepoliaAsyncContextError
      && error.code === "DEPLOYMENT_NOT_FOUND",
  );
});

function liveClient(
  deployment: ArbitrumSepoliaAsyncDeploymentConfiguration,
  chainId = 421_614n,
  wrongCodeAddress?: Address,
): ArbitrumSepoliaLiveReadClient {
  const hashes = new Map<string, Hex>();
  const identities = [
    deployment.protocolConfig,
    deployment.coordinator,
    deployment.accountFactory,
    deployment.accountImplementation,
    deployment.entryAdapter,
    deployment.orderVerifier,
    deployment.market,
    deployment.collateralToken,
    ...Object.values(deployment.gmx),
  ];
  for (const identity of identities) hashes.set(identity.address.toLowerCase(), identity.expectedCodeHash);
  return {
    chainId: async () => chainId,
    latestBlockTimestamp: async () => 1n,
    codeHash: async (address) => address.toLowerCase() === wrongCodeAddress?.toLowerCase()
      ? `0x${"ff".repeat(32)}`
      : hashes.get(address.toLowerCase()),
    transactionReceipt: async () => null,
    chainHead: async () => ({ latestBlock: 1n, finalizedBlock: 1n }),
    attemptEvidence: async () => undefined,
    exitEvidence: async () => undefined,
    readContract: async (read) => {
      switch (read.functionName) {
        case "config": return deployment.protocolConfig.address;
        case "bondToken": return deployment.collateralToken.address;
        case "deploymentChainId": return 421_614n;
        case "deploymentDomainIdHash": return keccak256(stringToHex("eip155:421614"));
        case "executionClassManifestHash": return `0x${Buffer.from(deployment.executionClassManifestHash).toString("hex")}`;
        case "admissions": return {
          handler: deployment.entryAdapter.address,
          adapterCodeHash: deployment.entryAdapter.expectedCodeHash,
          handlerCodeHash: deployment.entryAdapter.expectedCodeHash,
          active: true,
          generation: 1n,
        };
        case "entryController": return deployment.entryAdapter.address;
        case "entryControllerCodeHash": return deployment.entryAdapter.expectedCodeHash;
        case "factory": return deployment.accountFactory.address;
        case "adapter": return deployment.entryAdapter.address;
        case "adapterCodeHash": return deployment.entryAdapter.expectedCodeHash;
        case "implementation": return deployment.accountImplementation.address;
        case "accountCodeHash": return arbitrumSepoliaAccountCodeHash(deployment);
        default: throw new Error(`unexpected read ${read.functionName}`);
      }
    },
  };
}

test("Arbitrum live runtime composes only after exact signerless validation", async () => {
  const deployment = configuration(manifest(1));
  const runtimePort = await createArbitrumSepoliaRuntime({
    manifest: {
      schemaVersion: 1,
      activationState: "ACTIVE",
      observationStartBlock: 100n,
      deployment,
    },
    intents: {} as ExecutionIntentStore,
    orders: {} as InternalOrderStore,
    client: liveClient(deployment),
  });
  const runtime = composePrivateTerminalRuntime({
    NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED: "true",
  }, { arbitrumTestnetAsync: () => runtimePort });
  assert.equal(runtime.evmTestnet.asyncObservation, runtimePort);
  assert.deepEqual(runtime.health.arbitrumTestnetAsync, { available: true, reason: null });

  await assert.rejects(
    createArbitrumSepoliaRuntime({
      manifest: { schemaVersion: 1, activationState: "ACTIVE", observationStartBlock: 100n, deployment },
      intents: {} as ExecutionIntentStore,
      orders: {} as InternalOrderStore,
      client: liveClient(deployment, 1n),
    }),
    /chain ID does not match/,
  );
  await assert.rejects(
    createArbitrumSepoliaRuntime({
      manifest: { schemaVersion: 1, activationState: "ACTIVE", observationStartBlock: 100n, deployment },
      intents: {} as ExecutionIntentStore,
      orders: {} as InternalOrderStore,
      client: liveClient(deployment, 421_614n, deployment.coordinator.address),
    }),
    /deployed code does not match/,
  );
  await assert.rejects(
    createArbitrumSepoliaRuntime({
      manifest: {
        schemaVersion: 1,
        activationState: "ALL_PAUSED",
        observationStartBlock: 100n,
        deployment,
      } as unknown as Parameters<typeof createArbitrumSepoliaRuntime>[0]["manifest"],
      intents: {} as ExecutionIntentStore,
      orders: {} as InternalOrderStore,
      client: liveClient(deployment),
    }),
    /schema version 1 and ACTIVE/,
  );
  assert.throws(
    () => loadArbitrumSepoliaRuntimeManifest("relative/arbitrum-runtime.json"),
    /path must be absolute/,
  );
});

test("Arbitrum async runtime factory remains disabled unless composition enables it", () => {
  let reads = 0;
  const factory = createArbitrumSepoliaAsyncRuntimeFactory({
    intents: {} as ExecutionIntentStore,
    orders: {} as InternalOrderStore,
    deployments: [configuration(manifest(1))],
    evidence: () => undefined,
    currentUnixSeconds: () => 1n,
    readPort: {
      chainId: async () => { reads += 1; return 421_614n; },
      transactionReceipt: async () => null,
      readContract: async () => { reads += 1; throw new Error("not called"); },
      chainHead: async () => ({ latestBlock: 1n, finalizedBlock: 1n }),
    },
  });
  const runtime = composePrivateTerminalRuntime({}, { arbitrumTestnetAsync: factory });
  assert.equal(runtime.evmTestnet.asyncObservation, undefined);
  assert.equal(runtime.health.arbitrumTestnetAsync.reason, "DISABLED_BY_CONFIGURATION");
  assert.equal(reads, 0);
});

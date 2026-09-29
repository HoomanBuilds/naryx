import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ASYNC_COORDINATOR_OBSERVATION_ABI,
  equalAddress,
  equalHash,
  requiredEvmAddress,
  type EvmContractIdentity,
  type EvmContractRead,
  type EvmReadPort,
} from "@naryx/adapter-evm";
import { parseProtocolJson } from "@naryx/protocol-types";
import {
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARBITRUM_SEPOLIA_CHAIN_REFERENCE,
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  createArbitrumSepoliaAsyncContextProvider,
  validateArbitrumSepoliaAsyncDeploymentConfiguration,
  type ArbitrumSepoliaAsyncAttemptEvidence,
  type ArbitrumSepoliaAsyncDeploymentConfiguration,
} from "./arbitrum-sepolia-async-context-provider.js";
import { createEvmTestnetAsyncObservationPort, type EvmTestnetAsyncObservationPort } from "./evm-testnet-runtime-ports.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const REQUEST_REGISTERED = parseAbiItem(
  "event RequestRegistered(bytes32 indexed packageId, bytes32 indexed requestKey)",
);
const PACKAGE_TRANSITION = parseAbiItem(
  "event PackageTransition(bytes32 indexed packageId, uint8 state, uint64 stateVersion, bytes32 evidenceHash)",
);
const DEPLOYMENT_ABI = parseAbi([
  "function config() view returns (address)",
  "function bondToken() view returns (address)",
  "function deploymentChainId() view returns (uint256)",
  "function deploymentDomainIdHash() view returns (bytes32)",
  "function executionClassManifestHash() view returns (bytes32)",
  "function admissions(address) view returns (address handler, bytes32 adapterCodeHash, bytes32 handlerCodeHash, bool active, uint64 generation)",
  "function entryController() view returns (address)",
  "function entryControllerCodeHash() view returns (bytes32)",
  "function isolatedAccount() view returns (address)",
]);

export interface ArbitrumSepoliaRuntimeManifest {
  readonly schemaVersion: 1;
  readonly activationState: "ACTIVE";
  readonly observationStartBlock: bigint;
  readonly deployment: ArbitrumSepoliaAsyncDeploymentConfiguration;
}

export interface ArbitrumSepoliaAttemptBinding {
  readonly attemptId: string;
  readonly coordinator: Address;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly seriesIdentityKey: Hex;
  readonly seriesBindingVersion: number;
  readonly seriesBindingHash: Hex;
  readonly executionClassManifestHash: Hex;
  readonly evidenceSchemaHash: Hex;
}

export interface ArbitrumSepoliaLiveReadClient extends EvmReadPort {
  codeHash(address: Address): Promise<Hex | undefined>;
  attemptEvidence(
    binding: ArbitrumSepoliaAttemptBinding,
    observationStartBlock: bigint,
  ): Promise<ArbitrumSepoliaAsyncAttemptEvidence | undefined>;
}

export interface ArbitrumSepoliaRuntimeOptions {
  readonly manifest: ArbitrumSepoliaRuntimeManifest;
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly client: ArbitrumSepoliaLiveReadClient;
  readonly currentUnixSeconds?: () => bigint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireManifest(value: unknown): ArbitrumSepoliaRuntimeManifest {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "activationState,deployment,observationStartBlock,schemaVersion"
    || value.schemaVersion !== 1 || value.activationState !== "ACTIVE"
    || typeof value.observationStartBlock !== "bigint" || value.observationStartBlock < 0n
    || !isRecord(value.deployment)) {
    throw new Error("Arbitrum Sepolia runtime manifest must be schema version 1 and ACTIVE.");
  }
  const manifest = value as unknown as ArbitrumSepoliaRuntimeManifest;
  validateArbitrumSepoliaAsyncDeploymentConfiguration(manifest.deployment);
  return manifest;
}

export function loadArbitrumSepoliaRuntimeManifest(path: string): ArbitrumSepoliaRuntimeManifest {
  if (!isAbsolute(path)) throw new Error("Arbitrum Sepolia runtime manifest path must be absolute.");
  return requireManifest(parseProtocolJson(
    readFileSync(resolve(path), "utf8"),
    "arbitrumSepoliaRuntimeManifest",
  ));
}

function identities(configuration: ArbitrumSepoliaAsyncDeploymentConfiguration): readonly EvmContractIdentity[] {
  return [
    configuration.protocolConfig,
    configuration.coordinator,
    configuration.isolatedAccount,
    configuration.entryAdapter,
    configuration.orderVerifier,
    configuration.market,
    configuration.collateralToken,
    ...Object.values(configuration.gmx),
  ];
}

async function read(client: EvmReadPort, address: Address, functionName: string, args?: readonly unknown[]) {
  return client.readContract({ address, abi: DEPLOYMENT_ABI, functionName, ...(args === undefined ? {} : { args }) });
}

function addressValue(value: unknown, field: string): Address {
  if (typeof value !== "string") throw new Error(`Arbitrum Sepolia ${field} is invalid.`);
  return requiredEvmAddress(value, field);
}

function hashValue(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Arbitrum Sepolia ${field} is invalid.`);
  }
  return value.toLowerCase() as Hex;
}

async function validateLiveDeployment(
  client: ArbitrumSepoliaLiveReadClient,
  configuration: ArbitrumSepoliaAsyncDeploymentConfiguration,
): Promise<void> {
  if (await client.chainId() !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)) {
    throw new Error("Arbitrum Sepolia RPC chain ID does not match the runtime manifest.");
  }
  const expectedByAddress = new Map<Address, Hex>();
  for (const identity of identities(configuration)) {
    const address = requiredEvmAddress(identity.address, "deployment contract address");
    const previous = expectedByAddress.get(address);
    if (previous !== undefined && !equalHash(previous, identity.expectedCodeHash)) {
      throw new Error(`Arbitrum Sepolia runtime manifest has conflicting code hashes for ${address}.`);
    }
    expectedByAddress.set(address, identity.expectedCodeHash);
  }
  await Promise.all([...expectedByAddress].map(async ([address, expectedCodeHash]) => {
    const observed = await client.codeHash(address);
    if (observed === undefined || !equalHash(observed, expectedCodeHash)) {
      throw new Error(`Arbitrum Sepolia deployed code does not match the runtime manifest at ${address}.`);
    }
  }));

  const coordinator = requiredEvmAddress(configuration.coordinator.address, "coordinator");
  const adapter = requiredEvmAddress(configuration.entryAdapter.address, "entryAdapter");
  const account = requiredEvmAddress(configuration.isolatedAccount.address, "isolatedAccount");
  const config = requiredEvmAddress(configuration.protocolConfig.address, "protocolConfig");
  const token = requiredEvmAddress(configuration.collateralToken.address, "collateralToken");
  const [boundConfig, bondToken, chainId, domainIdHash, executionClassHash, admission, controller, controllerHash, boundAccount] =
    await Promise.all([
      read(client, coordinator, "config"),
      read(client, coordinator, "bondToken"),
      read(client, coordinator, "deploymentChainId"),
      read(client, coordinator, "deploymentDomainIdHash"),
      read(client, coordinator, "executionClassManifestHash"),
      read(client, coordinator, "admissions", [adapter]),
      read(client, account, "entryController"),
      read(client, account, "entryControllerCodeHash"),
      read(client, adapter, "isolatedAccount"),
    ]);
  const admissionRecord = admission as readonly unknown[] & Record<string, unknown>;
  const handler = admissionRecord.handler ?? admissionRecord[0];
  const adapterCodeHash = admissionRecord.adapterCodeHash ?? admissionRecord[1];
  const handlerCodeHash = admissionRecord.handlerCodeHash ?? admissionRecord[2];
  const active = admissionRecord.active ?? admissionRecord[3];
  if (!equalAddress(addressValue(boundConfig, "coordinator config"), config)
    || !equalAddress(addressValue(bondToken, "coordinator bond token"), token)
    || chainId !== BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE)
    || !equalHash(hashValue(domainIdHash, "coordinator domain"), keccak256(stringToHex(ARBITRUM_SEPOLIA_DOMAIN_ID)))
    || !equalHash(hashValue(executionClassHash, "execution class"), `0x${Buffer.from(configuration.executionClassManifestHash).toString("hex")}` as Hex)
    || !equalAddress(addressValue(handler, "admission handler"), adapter)
    || !equalHash(hashValue(adapterCodeHash, "admission adapter code"), configuration.entryAdapter.expectedCodeHash)
    || !equalHash(hashValue(handlerCodeHash, "admission handler code"), configuration.entryAdapter.expectedCodeHash)
    || active !== true
    || !equalAddress(addressValue(controller, "entry controller"), adapter)
    || !equalHash(hashValue(controllerHash, "entry controller code"), configuration.entryAdapter.expectedCodeHash)
    || !equalAddress(addressValue(boundAccount, "adapter isolated account"), account)) {
    throw new Error("Arbitrum Sepolia live deployment relationships do not match the runtime manifest.");
  }
}

export async function createArbitrumSepoliaRuntime(
  options: ArbitrumSepoliaRuntimeOptions,
): Promise<EvmTestnetAsyncObservationPort> {
  const manifest = requireManifest(options.manifest);
  await validateLiveDeployment(options.client, manifest.deployment);
  const evidence = async (attemptId: string) => {
    const attempt = options.intents.getAttempt(attemptId);
    if (attempt === undefined || attempt.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED") return undefined;
    return options.client.attemptEvidence({
      attemptId,
      coordinator: requiredEvmAddress(manifest.deployment.coordinator.address, "coordinator"),
      orderHash: `0x${attempt.orderHash}`,
      quoteHash: `0x${attempt.quoteHash}`,
      routeHash: `0x${attempt.routeHash}`,
      seriesIdentityKey: `0x${Buffer.from(manifest.deployment.route.seriesIdentityKey).toString("hex")}`,
      seriesBindingVersion: manifest.deployment.route.seriesBindingVersion,
      seriesBindingHash: `0x${Buffer.from(manifest.deployment.route.seriesBindingHash).toString("hex")}`,
      executionClassManifestHash: `0x${Buffer.from(manifest.deployment.executionClassManifestHash).toString("hex")}`,
      evidenceSchemaHash: `0x${Buffer.from(manifest.deployment.route.coordinatorEvidenceSchemaHash).toString("hex")}`,
    }, manifest.observationStartBlock);
  };
  const context = createArbitrumSepoliaAsyncContextProvider({
    intents: options.intents,
    orders: options.orders,
    deployments: [manifest.deployment],
    evidence,
    currentUnixSeconds: options.currentUnixSeconds ?? (() => BigInt(Math.floor(Date.now() / 1_000))),
  });
  return createEvmTestnetAsyncObservationPort({
    contextProvider: async (attemptId) => {
      await validateLiveDeployment(options.client, manifest.deployment);
      return context(attemptId);
    },
    readPort: options.client,
  });
}

type ViemClient = Pick<PublicClient,
  "getChainId" | "getCode" | "getTransactionReceipt" | "readContract" | "getBlockNumber" | "getBlock" | "getLogs">;

export function createViemArbitrumSepoliaReadClient(rpcUrl: string): ArbitrumSepoliaLiveReadClient {
  if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error("Arbitrum Sepolia RPC URL must be an HTTP or HTTPS URL.");
  }
  const client = createPublicClient({ transport: http(rpcUrl) }) as ViemClient;
  return Object.freeze({
    chainId: async () => BigInt(await client.getChainId()),
    codeHash: async (address: Address) => {
      const code = await client.getCode({ address });
      return code === undefined || code === "0x" ? undefined : keccak256(code);
    },
    transactionReceipt: async (transactionHash: Hex) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash: transactionHash });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
    readContract: async (readRequest: EvmContractRead) => client.readContract({
      address: readRequest.address,
      abi: readRequest.abi as Abi,
      functionName: readRequest.functionName,
      ...(readRequest.args === undefined ? {} : { args: readRequest.args }),
    } as never),
    chainHead: async () => {
      const latestBlock = await client.getBlockNumber();
      try {
        const finalized = await client.getBlock({ blockTag: "finalized" });
        return { latestBlock, finalizedBlock: finalized.number };
      } catch {
        return { latestBlock, finalizedBlock: null };
      }
    },
    attemptEvidence: async (
      binding: ArbitrumSepoliaAttemptBinding,
      observationStartBlock: bigint,
    ): Promise<ArbitrumSepoliaAsyncAttemptEvidence | undefined> => {
      const [transitionLogs, requestLogs] = await Promise.all([
        client.getLogs({
          address: binding.coordinator,
          event: PACKAGE_TRANSITION,
          fromBlock: observationStartBlock,
          toBlock: "latest",
        }),
        client.getLogs({
          address: binding.coordinator,
          event: REQUEST_REGISTERED,
          fromBlock: observationStartBlock,
          toBlock: "latest",
        }),
      ]);
      const requestKeys = new Map<Hex, Hex>();
      for (const log of requestLogs) {
        const args = log.args as { packageId?: Hex; requestKey?: Hex };
        if (args.packageId !== undefined && args.requestKey !== undefined) {
          requestKeys.set(args.packageId, args.requestKey);
        }
      }
      const packageIds = new Set<Hex>();
      for (const log of transitionLogs) {
        const packageId = (log.args as { packageId?: Hex }).packageId;
        if (packageId !== undefined && packageId !== ZERO_HASH) packageIds.add(packageId);
      }
      const matches: ArbitrumSepoliaAsyncAttemptEvidence[] = [];
      for (const packageId of packageIds) {
        const record = await client.readContract({
          address: binding.coordinator,
          abi: ASYNC_COORDINATOR_OBSERVATION_ABI,
          functionName: "packageState",
          args: [packageId],
        } as never) as Record<string, unknown>;
        const terms = (record.terms ?? record[0]) as Record<string, unknown>;
        const orderHash = hashValue(terms.orderHash ?? terms[7], "package order hash");
        const quoteHash = hashValue(terms.quoteHash ?? terms[8], "package quote hash");
        const routeHash = hashValue(terms.routeHash ?? terms[9], "package route hash");
        const seriesIdentityKey = hashValue(terms.seriesIdentityKey ?? terms[10], "package series identity");
        const rawSeriesBindingVersion = terms.seriesBindingVersion ?? terms[11];
        const seriesBindingVersion = typeof rawSeriesBindingVersion === "bigint"
          ? Number(rawSeriesBindingVersion)
          : rawSeriesBindingVersion;
        const seriesBindingHash = hashValue(terms.seriesBindingHash ?? terms[12], "package series binding");
        const executionClassManifestHash = hashValue(
          terms.executionClassManifestHash ?? terms[14],
          "package execution class manifest",
        );
        const evidenceSchemaHash = hashValue(terms.evidenceSchemaHash ?? terms[19], "package evidence schema");
        if (equalHash(orderHash, binding.orderHash) && equalHash(quoteHash, binding.quoteHash)
          && equalHash(routeHash, binding.routeHash)
          && equalHash(seriesIdentityKey, binding.seriesIdentityKey)
          && seriesBindingVersion === binding.seriesBindingVersion
          && equalHash(seriesBindingHash, binding.seriesBindingHash)
          && equalHash(executionClassManifestHash, binding.executionClassManifestHash)
          && equalHash(evidenceSchemaHash, binding.evidenceSchemaHash)) {
          matches.push({
            attemptId: binding.attemptId,
            packageId,
            entryRequestKey: requestKeys.get(packageId) ?? ZERO_HASH,
          });
        }
      }
      if (matches.length > 1) throw new Error("Arbitrum Sepolia attempt resolves to multiple coordinator packages.");
      return matches[0];
    },
  });
}

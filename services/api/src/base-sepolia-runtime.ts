import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
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
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  createBaseSepoliaAtomicContextProvider,
  validateBaseSepoliaAtomicDeploymentConfiguration,
  type BaseSepoliaAtomicDeploymentConfiguration,
} from "./base-sepolia-atomic-context-provider.js";
import {
  BASE_SEPOLIA_CHAIN_REFERENCE,
  createEvmTestnetTerminalPorts,
  type EvmTestnetSolverAuthorizer,
  type EvmTestnetTerminalPorts,
  type PreparedEvmTestnetAtomicStore,
} from "./evm-testnet-runtime-ports.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";

export interface BaseSepoliaRuntimeManifest {
  readonly schemaVersion: 1;
  readonly activationState: "ACTIVE";
  readonly deployment: BaseSepoliaAtomicDeploymentConfiguration;
}

export interface BaseSepoliaLiveReadClient {
  chainId(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  transactionReceipt: EvmReadPort["transactionReceipt"];
  readContract: EvmReadPort["readContract"];
  chainHead: EvmReadPort["chainHead"];
  latestBlockTimestamp(): Promise<bigint>;
}

export interface BaseSepoliaRuntimeOptions {
  readonly manifest: BaseSepoliaRuntimeManifest;
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly client: BaseSepoliaLiveReadClient;
  readonly store: PreparedEvmTestnetAtomicStore;
  readonly solverAuthorizer: EvmTestnetSolverAuthorizer;
  readonly currentUnixSeconds?: () => bigint | Promise<bigint>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireManifest(value: unknown): BaseSepoliaRuntimeManifest {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "activationState,deployment,schemaVersion"
    || value.schemaVersion !== 1
    || value.activationState !== "ACTIVE"
    || !isRecord(value.deployment)) {
    throw new Error("Base Sepolia runtime manifest must be schema version 1 and ACTIVE.");
  }
  const manifest = value as unknown as BaseSepoliaRuntimeManifest;
  validateBaseSepoliaAtomicDeploymentConfiguration(manifest.deployment);
  return manifest;
}

export function loadBaseSepoliaRuntimeManifest(path: string): BaseSepoliaRuntimeManifest {
  if (!isAbsolute(path)) throw new Error("Base Sepolia runtime manifest path must be absolute.");
  return requireManifest(parseProtocolJson(
    readFileSync(resolve(path), "utf8"),
    "baseSepoliaRuntimeManifest",
  ));
}

function contractIdentities(
  configuration: BaseSepoliaAtomicDeploymentConfiguration,
): readonly EvmContractIdentity[] {
  const deployment = configuration.deployment;
  return [
    deployment.strategyAccountFactory,
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
}

async function validateLiveDeployment(
  client: BaseSepoliaLiveReadClient,
  configuration: BaseSepoliaAtomicDeploymentConfiguration,
): Promise<void> {
  const chainId = await client.chainId();
  if (chainId !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE)) {
    throw new Error("Base Sepolia RPC chain ID does not match the runtime manifest.");
  }
  const expectedByAddress = new Map<Address, Hex>();
  for (const identity of contractIdentities(configuration)) {
    const address = requiredEvmAddress(identity.address, "deployment contract address");
    const previous = expectedByAddress.get(address);
    if (previous !== undefined && !equalHash(previous, identity.expectedCodeHash)) {
      throw new Error(`Base Sepolia runtime manifest has conflicting code hashes for ${address}.`);
    }
    expectedByAddress.set(address, identity.expectedCodeHash);
  }
  await Promise.all([...expectedByAddress].map(async ([address, expectedCodeHash]) => {
    const codeHash = await client.codeHash(address);
    if (codeHash === undefined || !equalHash(codeHash, expectedCodeHash)) {
      throw new Error(`Base Sepolia deployed code does not match the runtime manifest at ${address}.`);
    }
  }));
  const factory = requiredEvmAddress(configuration.deployment.strategyAccountFactory.address, "strategyAccountFactory");
  const [factoryVerifier, accountCodeHash] = await Promise.all([
    client.readContract({ address: factory, abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI, functionName: "verifier" }),
    client.readContract({ address: factory, abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI, functionName: "accountCodeHash" }),
  ]);
  if (!equalAddress(
    requiredEvmAddress(String(factoryVerifier), "factory.verifier"),
    requiredEvmAddress(configuration.deployment.packageVerifier.address, "packageVerifier"),
  ) || typeof accountCodeHash !== "string"
    || !equalHash(accountCodeHash as Hex, configuration.deployment.strategyAccountCodeHash)) {
    throw new Error("Base Sepolia account factory does not bind the reviewed verifier and account code.");
  }
}

export async function createBaseSepoliaRuntime(
  options: BaseSepoliaRuntimeOptions,
): Promise<EvmTestnetTerminalPorts> {
  const manifest = requireManifest(options.manifest);
  await validateLiveDeployment(options.client, manifest.deployment);
  const context = createBaseSepoliaAtomicContextProvider({
    intents: options.intents,
    orders: options.orders,
    deployments: [manifest.deployment],
    // The verifier checks every deadline against block.timestamp, so admission uses chain time.
    currentUnixSeconds: options.currentUnixSeconds ?? (() => options.client.latestBlockTimestamp()),
    reads: options.client,
  });
  const atomicContextProvider: Parameters<typeof createEvmTestnetTerminalPorts>[0]["atomicContextProvider"] =
    async (attemptId, purpose) => {
      await validateLiveDeployment(options.client, manifest.deployment);
      return context(attemptId, purpose);
    };
  return createEvmTestnetTerminalPorts({
    atomicContextProvider,
    solverAuthorizer: options.solverAuthorizer,
    asyncContextProvider: () => { throw new Error("Arbitrum Sepolia runtime is not configured."); },
    atomicReadPort: options.client,
    asyncReadPort: options.client,
    store: options.store,
    atomicChainTime: () => options.client.latestBlockTimestamp(),
  });
}

type ViemClient = Pick<PublicClient, "getChainId" | "getCode" | "getTransactionReceipt" | "readContract" | "getBlockNumber" | "getBlock">;

export function createViemBaseSepoliaReadClient(rpcUrl: string): BaseSepoliaLiveReadClient {
  if (typeof rpcUrl !== "string" || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error("Base Sepolia RPC URL must be an HTTP or HTTPS URL.");
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
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
          })),
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
    readContract: async (read: EvmContractRead) => client.readContract({
      address: read.address,
      abi: read.abi as Abi,
      functionName: read.functionName,
      ...(read.args === undefined ? {} : { args: read.args }),
    } as never),
    latestBlockTimestamp: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
    chainHead: async () => {
      const latestBlock = await client.getBlockNumber();
      try {
        const finalized = await client.getBlock({ blockTag: "finalized" });
        return { latestBlock, finalizedBlock: finalized.number };
      } catch {
        return { latestBlock, finalizedBlock: null };
      }
    },
  });
}

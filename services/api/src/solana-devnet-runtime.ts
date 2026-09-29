import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ConnectionSolanaDeploymentIdentityReadPort,
  ConnectionSolanaReadOnlyRpc,
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaUnsignedTransactionMaterializer,
  solanaIdlContentHash,
  verifySolanaDevnetDeploymentIdentity,
  type FirmCashCarryBinding,
  type SolanaDeploymentIdentityReadPort,
  type SolanaDevnetProgramExpectation,
  type SolanaLookupTableConfig,
  type SolanaReadOnlyRpc,
} from "@naryx/adapter-solana";
import { bytesEqual, fromProtocolJson, parseProtocolJson, type DomainRef, type PackageAdmissionInput } from "@naryx/protocol-types";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { PackageLifecycleStore } from "./package-lifecycle-store.js";
import { createSolanaDevnetContextProvider, type SolanaDevnetLiveBindingSource } from "./solana-devnet-context-provider.js";
import { SolanaDevnetLifecycleStoreRecorder } from "./solana-devnet-lifecycle-recorder.js";
import { ReadOnlySolanaDevnetPostconditionVerifier } from "./solana-devnet-postcondition-verifier.js";
import { SqlitePreparedSolanaDevnetStore } from "./solana-devnet-prepared-store.js";
import {
  HttpSolanaDevnetReadOnlyRpc,
  createSolanaDevnetExecutionPorts,
  type SolanaDevnetReadOnlyRpc,
} from "./solana-devnet-runtime-ports.js";
import type { PrivateTerminalExecutionPorts } from "./terminal-execution.js";

type AdmissionConfiguration = Omit<PackageAdmissionInput, "order" | "quote" | "route" | "currentTime">;
type SolanaCoreIdl = Parameters<typeof solanaIdlContentHash>[0];

export type SolanaDevnetRuntimeManifest = Readonly<{
  schemaVersion: 1;
  activationState: "ACTIVE";
  domain: DomainRef;
  expectedGenesisHash: typeof SOLANA_DEVNET_GENESIS_HASH;
  programs: readonly SolanaDevnetProgramExpectation[];
  lookupTables: readonly SolanaLookupTableConfig[];
  coreIdl: SolanaCoreIdl;
  expectedCoreIdlHash: Uint8Array;
  admission: AdmissionConfiguration;
  evidence: Readonly<{
    evidenceClass: "SOLANA_FINALIZED_ACCOUNT_EVIDENCE_V1";
    settlementClass: "ATOMIC_POSTCONDITION";
    quoteMode: "FIRM_ONCHAIN";
    executionPlanKind: "SVM_ATOMIC_CPI";
    packetDataLimit: 1232;
    maxResolvedAddresses: 64;
    maxRouteComputeUnits: 1260000;
  }>;
}>;

export type SolanaDevnetRuntimeOptions = Readonly<{
  manifest: SolanaDevnetRuntimeManifest;
  rpcUrl: string;
  preparedStorePath: string;
  intents: ExecutionIntentStore;
  orders: InternalOrderStore;
  lifecycle: PackageLifecycleStore;
  bindings: SolanaDevnetLiveBindingSource;
  deploymentRpc?: SolanaDeploymentIdentityReadPort;
  materializerRpc?: SolanaReadOnlyRpc;
  observationRpc?: SolanaDevnetReadOnlyRpc & { getMultipleAccounts(addresses: readonly string[], minContextSlot: number): Promise<{ contextSlot: number; accounts: readonly ({ owner: string; data: Uint8Array } | null)[] }> };
  currentSlot?: () => Promise<bigint>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireManifest(value: unknown): SolanaDevnetRuntimeManifest {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "activationState,admission,coreIdl,domain,evidence,expectedCoreIdlHash,expectedGenesisHash,lookupTables,programs,schemaVersion"
    || value.schemaVersion !== 1
    || value.activationState !== "ACTIVE") {
    throw new Error("Solana Devnet runtime manifest must be schema version 1 and ACTIVE.");
  }
  const manifest = value as unknown as SolanaDevnetRuntimeManifest;
  if (manifest.domain.domainId !== "svm:devnet"
    || manifest.domain.domainManifestVersion < 1
    || manifest.expectedGenesisHash !== SOLANA_DEVNET_GENESIS_HASH
    || !isRecord(manifest.evidence)
    || manifest.evidence.evidenceClass !== "SOLANA_FINALIZED_ACCOUNT_EVIDENCE_V1"
    || manifest.evidence.settlementClass !== "ATOMIC_POSTCONDITION"
    || manifest.evidence.quoteMode !== "FIRM_ONCHAIN"
    || manifest.evidence.executionPlanKind !== "SVM_ATOMIC_CPI"
    || manifest.evidence.packetDataLimit !== 1232
    || manifest.evidence.maxResolvedAddresses !== 64
    || manifest.evidence.maxRouteComputeUnits !== 1260000) {
    throw new Error("Solana Devnet runtime manifest has an unsupported domain, bound, or evidence class.");
  }
  const names = manifest.programs.map((program) => program.name).sort().join(",");
  if (names !== "core,package_book,perp_adapter,perp_venue,reservation") {
    throw new Error("Solana Devnet runtime manifest must bind the exact reviewed program set.");
  }
  if (!bytesEqual(solanaIdlContentHash(manifest.coreIdl), manifest.expectedCoreIdlHash)) {
    throw new Error("Solana Devnet core IDL hash does not match the runtime manifest.");
  }
  const core = manifest.programs.find((program) => program.name === "core")!;
  if (new PublicKey(manifest.coreIdl.address).toBase58() !== new PublicKey(core.programId).toBase58()) {
    throw new Error("Solana Devnet core IDL address does not match the reviewed core program.");
  }
  return manifest;
}

export function loadSolanaDevnetRuntimeManifest(path: string): SolanaDevnetRuntimeManifest {
  if (!isAbsolute(path)) throw new Error("Solana Devnet runtime manifest path must be absolute.");
  return requireManifest(parseProtocolJson(readFileSync(resolve(path), "utf8"), "solanaDevnetRuntimeManifest"));
}

function checkedBindingSource(
  source: SolanaDevnetLiveBindingSource,
  expectations: readonly SolanaDevnetProgramExpectation[],
  rpc: SolanaDeploymentIdentityReadPort,
): SolanaDevnetLiveBindingSource {
  const keyByName = {
    core: "core",
    reservation: "reservation",
    package_book: "packageBook",
    perp_adapter: "perpAdapter",
    perp_venue: "perpVenue",
  } as const;
  return Object.freeze({
    readBinding: async (input: Parameters<SolanaDevnetLiveBindingSource["readBinding"]>[0]) => {
      const programs = (await verifySolanaDevnetDeploymentIdentity(expectations, rpc)).programs;
      const binding = await source.readBinding(input);
      for (const program of programs) {
        const deployment = binding.deployments[keyByName[program.name as keyof typeof keyByName]];
        if (deployment === undefined
          || new PublicKey(deployment.programId).toBase58() !== program.programId.toBase58()
          || new PublicKey(deployment.programDataAddress).toBase58() !== program.programDataAddress.toBase58()
          || !bytesEqual(deployment.codeIdentity, program.deployedCodeCommitment)) {
          throw new Error(`Solana Devnet live binding does not match reviewed ${program.name} deployment identity.`);
        }
      }
      return binding;
    },
  });
}

export async function createSolanaDevnetRuntime(options: SolanaDevnetRuntimeOptions): Promise<PrivateTerminalExecutionPorts> {
  const manifest = requireManifest(options.manifest);
  const deploymentRpc = options.deploymentRpc ?? new ConnectionSolanaDeploymentIdentityReadPort(options.rpcUrl);
  await verifySolanaDevnetDeploymentIdentity(manifest.programs, deploymentRpc);
  const materializerRpc = options.materializerRpc ?? new ConnectionSolanaReadOnlyRpc(options.rpcUrl);
  const observationRpc = options.observationRpc ?? new HttpSolanaDevnetReadOnlyRpc(options.rpcUrl);
  if (await observationRpc.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) {
    throw new Error("Solana observation RPC is not Devnet.");
  }
  const currentSlot = options.currentSlot ?? (() => new Connection(options.rpcUrl, "finalized").getSlot("finalized").then(BigInt));
  const contextProvider = createSolanaDevnetContextProvider({
    intents: options.intents,
    orders: options.orders,
    configuration: { admission: manifest.admission, evidenceClass: manifest.evidence.evidenceClass },
    currentSlot,
    bindings: checkedBindingSource(options.bindings, manifest.programs, deploymentRpc),
  });
  const lifecycleRecorder = new SolanaDevnetLifecycleStoreRecorder(options.lifecycle);
  return createSolanaDevnetExecutionPorts({
    contextProvider,
    materializer: new SolanaUnsignedTransactionMaterializer(materializerRpc, {
      environment: "devnet",
      domain: manifest.domain,
      rpcUrl: options.rpcUrl,
      expectedGenesisHash: manifest.expectedGenesisHash,
      lookupTables: manifest.lookupTables,
    }),
    store: new SqlitePreparedSolanaDevnetStore(options.preparedStorePath),
    rpc: observationRpc,
    lifecycleRecorder,
    postconditionVerifier: new ReadOnlySolanaDevnetPostconditionVerifier({ rpc: observationRpc, coreIdl: manifest.coreIdl }),
  });
}

export class HttpSolanaDevnetBindingSource implements SolanaDevnetLiveBindingSource {
  readonly #endpoint: URL;

  constructor(origin: string) {
    const endpoint = new URL("/internal/solana-devnet/attempt-binding", origin);
    if (endpoint.protocol !== "http:" || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")) {
      throw new Error("Solana Devnet binding source must be a loopback HTTP origin.");
    }
    this.#endpoint = endpoint;
  }

  async readBinding(input: Parameters<SolanaDevnetLiveBindingSource["readBinding"]>[0]): Promise<FirmCashCarryBinding> {
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: input.attempt.attemptId }),
    });
    if (!response.ok) throw new Error(`Solana Devnet binding source failed with status ${response.status}.`);
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || Object.keys(payload).join(",") !== "binding") {
      throw new Error("Solana Devnet binding source returned a malformed response.");
    }
    return fromProtocolJson(payload.binding, "solanaDevnetBinding") as FirmCashCarryBinding;
  }
}

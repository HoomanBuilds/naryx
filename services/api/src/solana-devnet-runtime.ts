import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ConnectionSolanaDeploymentIdentityReadPort,
  ConnectionSolanaReadOnlyRpc,
  SOLANA_DEVNET_GENESIS_HASH,
  SolanaUnsignedTransactionMaterializer,
  solanaIdlContentHash,
  verifySolanaDevnetDeploymentIdentity,
  type AnyFirmCashCarryBinding,
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
import {
  SOLANA_DEVNET_SOL_USD_FEED_ID_HEX,
  SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT,
  deriveSolanaDevnetTraderAccounts,
} from "./solana-devnet-test-perp.js";

type AdmissionConfiguration = Omit<PackageAdmissionInput, "order" | "quote" | "route" | "currentTime">;
type SolanaCoreIdl = Parameters<typeof solanaIdlContentHash>[0];

/**
 * The Devnet perp leg is the Naryx test perp (Phoenix Rise has no Devnet deployment). The manifest
 * pins the venue kind, the market account, the Pyth SOL/USD PriceUpdateV2 account and feed, and the
 * strategy id every trader's strategy PDA is derived from. There is no fallback to another kind.
 */
export type SolanaDevnetTestPerpConfiguration = Readonly<{
  market: string;
  oracle: typeof SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT;
  feedIdHex: typeof SOLANA_DEVNET_SOL_USD_FEED_ID_HEX;
  strategyIdHex: string;
}>;

export type SolanaDevnetRuntimeManifest = Readonly<{
  schemaVersion: 1;
  activationState: "ACTIVE";
  domain: DomainRef;
  expectedGenesisHash: typeof SOLANA_DEVNET_GENESIS_HASH;
  programs: readonly SolanaDevnetProgramExpectation[];
  lookupTables: readonly SolanaLookupTableConfig[];
  coreIdl: SolanaCoreIdl;
  expectedCoreIdlHash: Uint8Array;
  perpVenueKind: "NARYX_TEST_PERP";
  testPerp: SolanaDevnetTestPerpConfiguration;
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
    || Object.keys(value).sort().join(",") !== "activationState,admission,coreIdl,domain,evidence,expectedCoreIdlHash,expectedGenesisHash,lookupTables,perpVenueKind,programs,schemaVersion,testPerp"
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
  requireTestPerpConfiguration(manifest);
  return manifest;
}

function idlAccountNames(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string") return [];
    return Array.isArray(item.accounts) ? idlAccountNames(item.accounts) : [item.name];
  });
}

function requireTestPerpConfiguration(manifest: SolanaDevnetRuntimeManifest): void {
  const testPerp = manifest.testPerp;
  if (manifest.perpVenueKind !== "NARYX_TEST_PERP"
    || !isRecord(testPerp)
    || Object.keys(testPerp).sort().join(",") !== "feedIdHex,market,oracle,strategyIdHex"
    || testPerp.oracle !== SOLANA_DEVNET_SOL_USD_PRICE_ACCOUNT
    || testPerp.feedIdHex !== SOLANA_DEVNET_SOL_USD_FEED_ID_HEX
    || typeof testPerp.strategyIdHex !== "string"
    || !/^[0-9a-f]{64}$/.test(testPerp.strategyIdHex)
    || /^0+$/.test(testPerp.strategyIdHex)) {
    throw new Error("Solana Devnet runtime manifest must select NARYX_TEST_PERP with the reviewed Pyth SOL/USD feed.");
  }
  new PublicKey(testPerp.market);
  const entry = manifest.coreIdl.instructions.find((instruction) => instruction.name === "execute_firm_cash_and_carry");
  const names = entry === undefined ? [] : idlAccountNames(entry.accounts as readonly unknown[]);
  if (!names.includes("test_perp_market") || !names.includes("test_perp_oracle") || names.some((name) => name.startsWith("rise_") && name !== "rise_strategy")) {
    throw new Error("Solana Devnet core IDL is not the devnet-test-perp feature build.");
  }
}

export function loadSolanaDevnetRuntimeManifest(path: string): SolanaDevnetRuntimeManifest {
  if (!isAbsolute(path)) throw new Error("Solana Devnet runtime manifest path must be absolute.");
  return requireManifest(parseProtocolJson(readFileSync(resolve(path), "utf8"), "solanaDevnetRuntimeManifest"));
}

function requireTestPerpBinding(
  binding: FirmCashCarryBinding,
  manifest: SolanaDevnetRuntimeManifest,
  trader: string,
): void {
  const candidate = binding as unknown as AnyFirmCashCarryBinding;
  const accounts = candidate.accounts as unknown as Readonly<Record<string, { address: PublicKey | string } | undefined>>;
  const address = (name: string) => {
    const account = accounts[name];
    if (account === undefined) throw new Error(`Solana Devnet live binding is missing ${name}.`);
    return new PublicKey(account.address).toBase58();
  };
  const program = (name: string) => manifest.programs.find((item) => item.name === name)!;
  const derived = deriveSolanaDevnetTraderAccounts({
    owner: trader,
    strategyIdHex: manifest.testPerp.strategyIdHex,
    market: manifest.testPerp.market,
    coreProgram: new PublicKey(program("core").programId).toBase58(),
    perpAdapterProgram: new PublicKey(program("perp_adapter").programId).toBase58(),
    perpVenueProgram: new PublicKey(program("perp_venue").programId).toBase58(),
    baseMint: new PublicKey(candidate.resources.baseAsset.subjectAddress).toBase58(),
    quoteMint: new PublicKey(candidate.resources.quoteAsset.subjectAddress).toBase58(),
  });
  if (candidate.perpVenueKind !== manifest.perpVenueKind
    || !bytesEqual(candidate.expectedCoreIdlHash, manifest.expectedCoreIdlHash)
    || address("testPerpMarket") !== new PublicKey(manifest.testPerp.market).toBase58()
    || address("testPerpOracle") !== manifest.testPerp.oracle
    || address("trader") !== derived.trader
    || address("riseStrategy") !== derived.strategy
    || address("testPerpPosition") !== derived.position
    || address("executorAuthority") !== derived.executorAuthority
    || address("openPackage") !== derived.openPackage) {
    throw new Error("Solana Devnet live binding does not match the reviewed test perp venue or the trader's own accounts.");
  }
}

function checkedBindingSource(
  source: SolanaDevnetLiveBindingSource,
  expectations: readonly SolanaDevnetProgramExpectation[],
  rpc: SolanaDeploymentIdentityReadPort,
  manifest: SolanaDevnetRuntimeManifest,
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
      requireTestPerpBinding(binding, manifest, input.request.traderPublicKey);
      for (const program of programs) {
        const deployment = binding.deployments[keyByName[program.name as keyof typeof keyByName]];
        if (deployment === undefined
          || new PublicKey(deployment.programId).toBase58() !== program.programId.toBase58()
          || new PublicKey(deployment.programDataAddress).toBase58() !== program.programDataAddress.toBase58()
          || !bytesEqual(deployment.codeIdentity, program.programDataHeaderIdentity)) {
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
    bindings: checkedBindingSource(options.bindings, manifest.programs, deploymentRpc, manifest),
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

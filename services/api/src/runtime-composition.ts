import { isAbsolute, resolve } from "node:path";
import type { EvmTestnetAsyncObservationPort, EvmTestnetTerminalPorts } from "./evm-testnet-runtime-ports.js";
import { isLoopbackHost, type PrivateTerminalServerConfig } from "./http-server.js";
import type { HyperliquidTestnetTerminalExecutionPort } from "./hyperliquid-testnet-terminal.js";
import type { HyperliquidTestnetEvidenceRuntime } from "./hyperliquid-testnet-runtime-client.js";
import type { PrivateTerminalExecutionPorts } from "./terminal-execution.js";

const ENABLED_VALUES = new Set(["true", "false"]);
const PUBLIC_TESTNET_RUNTIME_FLAGS = [
  "NARYX_SOLANA_DEVNET_RUNTIME_ENABLED",
  "NARYX_BASE_TESTNET_RUNTIME_ENABLED",
  "NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED",
  "NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED",
] as const;
const FIXTURE_DATABASE_DIRECTORY = "/tmp/naryx-local";
const MAX_LOGGED_MESSAGE_LENGTH = 240;

export type LocalAtomicRuntimeMode = "PHASE4_FIXTURE" | "MANIFEST_VALIDATED" | "DISABLED";

export type PrivateTerminalStartupConfig = Readonly<{
  localAtomicRuntimeMode: LocalAtomicRuntimeMode;
  orderDbPath: string;
  lifecycleDbPath: string;
  executionIntentDbPath: string;
  solanaLocalEnvironmentManifestPath: string | undefined;
  solanaLocalPreparationDbPath: string | undefined;
}>;

export type RuntimeFailureReporter = (runtime: string, error: unknown) => void;

export type RuntimeBoundaryHealth = Readonly<{
  available: boolean;
  reason: "DISABLED_BY_CONFIGURATION" |
    "RUNTIME_FACTORY_NOT_INJECTED" |
    "RUNTIME_INITIALIZATION_FAILED" |
    "REQUIRED_PORTS_MISSING" |
    null;
}>;

export type PrivateTerminalRuntimeHealth = Readonly<{
  solanaDevnet: RuntimeBoundaryHealth;
  baseTestnetAtomic: RuntimeBoundaryHealth;
  arbitrumTestnetAsync: RuntimeBoundaryHealth;
  hyperliquidTestnet: RuntimeBoundaryHealth;
}>;

export type PrivateTerminalRuntimeFactories = Readonly<{
  solanaDevnet?: () => PrivateTerminalExecutionPorts;
  evmTestnet?: () => EvmTestnetTerminalPorts;
  arbitrumTestnetAsync?: () => EvmTestnetAsyncObservationPort;
  hyperliquidTestnet?: () => HyperliquidTestnetTerminalExecutionPort;
  hyperliquidTestnetEvidence?: () => HyperliquidTestnetEvidenceRuntime;
}>;

export type PrivateTerminalRuntimeComposition = Readonly<{
  solanaDevnet: PrivateTerminalExecutionPorts;
  evmTestnet: EvmTestnetTerminalPorts;
  hyperliquidTestnet: HyperliquidTestnetTerminalExecutionPort | undefined;
  hyperliquidTestnetEvidence: HyperliquidTestnetEvidenceRuntime | undefined;
  health: PrivateTerminalRuntimeHealth;
}>;

function enabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name] ?? "false";
  if (!ENABLED_VALUES.has(value)) throw new Error(`${name} must be true or false.`);
  return value === "true";
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function databasePath(
  environment: NodeJS.ProcessEnv,
  name: string,
  fixtureFile: string | undefined,
  requirement: string,
): string {
  const value = environment[name];
  if (value !== undefined && value !== "") return absolutePath(value, name);
  if (fixtureFile === undefined) {
    throw new Error(`${name} is required ${requirement}: set an absolute durable database path outside the repository.`);
  }
  return `${FIXTURE_DATABASE_DIRECTORY}/${fixtureFile}`;
}

/**
 * Resolves which local runtime the process composes and where its durable stores live. The fixture
 * catalog is composed only on an explicit loopback opt-in that excludes every manifest-validated
 * and public testnet runtime, so fixture receipts never share a database with real evidence.
 */
export function loadPrivateTerminalStartupConfig(
  environment: NodeJS.ProcessEnv,
  server: Pick<PrivateTerminalServerConfig, "host">,
): PrivateTerminalStartupConfig {
  const fixtureMode = enabled(environment, "NARYX_LOCAL_FIXTURE_MODE");
  const manifestValue = environment.NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST;
  const manifestPath = manifestValue === undefined || manifestValue === ""
    ? undefined
    : absolutePath(manifestValue, "NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST");
  if (fixtureMode) {
    if (!isLoopbackHost(server.host)) {
      throw new Error("NARYX_LOCAL_FIXTURE_MODE=true requires a loopback NARYX_API_HOST.");
    }
    if (manifestPath !== undefined) {
      throw new Error("NARYX_LOCAL_FIXTURE_MODE=true cannot be combined with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST.");
    }
    const testnet = PUBLIC_TESTNET_RUNTIME_FLAGS.find((name) => enabled(environment, name));
    if (testnet !== undefined) {
      throw new Error(`NARYX_LOCAL_FIXTURE_MODE=true cannot be combined with ${testnet}=true.`);
    }
  }
  const fixtureDefault = (file: string) => fixtureMode ? file : undefined;
  const unlessFixture = "unless NARYX_LOCAL_FIXTURE_MODE=true";
  return Object.freeze({
    localAtomicRuntimeMode: fixtureMode ? "PHASE4_FIXTURE" : manifestPath === undefined ? "DISABLED" : "MANIFEST_VALIDATED",
    orderDbPath: databasePath(environment, "NARYX_API_ORDER_DB", fixtureDefault("api-orders.db"), unlessFixture),
    lifecycleDbPath: databasePath(environment, "NARYX_API_LIFECYCLE_DB", fixtureDefault("package-lifecycle.db"), unlessFixture),
    executionIntentDbPath: databasePath(
      environment,
      "NARYX_API_EXECUTION_INTENT_DB",
      fixtureDefault("execution-intents.db"),
      unlessFixture,
    ),
    solanaLocalEnvironmentManifestPath: manifestPath,
    solanaLocalPreparationDbPath: manifestPath === undefined
      ? undefined
      : databasePath(
        environment,
        "NARYX_API_SOLANA_LOCAL_PREPARATION_DB",
        undefined,
        "with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST",
      ),
  });
}

/**
 * The first line of an error message with URLs and credential-shaped parameters removed, so an RPC
 * endpoint key or a manifest body never reaches the log.
 */
export function runtimeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "non-error value thrown";
  const line = (raw.split(/\r?\n/, 1)[0] ?? "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(api[-_]?key|key|token|secret|password|auth)=[^&\s]+/gi, "$1=[redacted]")
    .replace(/[^\x20-\x7e]/g, "?");
  if (line === "") return "no message";
  return line.length > MAX_LOGGED_MESSAGE_LENGTH ? `${line.slice(0, MAX_LOGGED_MESSAGE_LENGTH)}...` : line;
}

/** Writes one stderr line per distinct failure, so an error rethrown by a factory is not logged twice. */
export function stderrRuntimeFailureReporter(): RuntimeFailureReporter {
  const reported = new WeakSet<object>();
  return (runtime, error) => {
    if (typeof error === "object" && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    process.stderr.write(`Naryx API runtime ${runtime} failed to initialize: ${runtimeFailureMessage(error)}\n`);
  };
}

function health(
  available: boolean,
  reason: RuntimeBoundaryHealth["reason"],
): RuntimeBoundaryHealth {
  return Object.freeze({ available, reason });
}

export function composePrivateTerminalRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  factories: PrivateTerminalRuntimeFactories = {},
  report: RuntimeFailureReporter = stderrRuntimeFailureReporter(),
): PrivateTerminalRuntimeComposition {
  const solanaEnabled = enabled(environment, "NARYX_SOLANA_DEVNET_RUNTIME_ENABLED");
  const baseEnabled = enabled(environment, "NARYX_BASE_TESTNET_RUNTIME_ENABLED");
  const arbitrumEnabled = enabled(environment, "NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED");
  const hyperliquidEnabled = enabled(environment, "NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED");

  let solanaDevnet: PrivateTerminalExecutionPorts = {};
  let solanaHealth = health(false, "DISABLED_BY_CONFIGURATION");
  if (solanaEnabled) {
    if (factories.solanaDevnet === undefined) {
      solanaHealth = health(false, "RUNTIME_FACTORY_NOT_INJECTED");
    } else {
      try {
        const candidate = factories.solanaDevnet();
        if (typeof candidate.preparation?.prepare === "function" &&
            typeof candidate.observation?.observe === "function") {
          solanaDevnet = Object.freeze({
            preparation: candidate.preparation,
            observation: candidate.observation,
          });
          solanaHealth = health(true, null);
        } else {
          solanaHealth = health(false, "REQUIRED_PORTS_MISSING");
        }
      } catch (error) {
        report("solanaDevnet", error);
        solanaHealth = health(false, "RUNTIME_INITIALIZATION_FAILED");
      }
    }
  }

  let evmCandidate: EvmTestnetTerminalPorts | undefined;
  let evmInitializationFailed = false;
  if (baseEnabled || arbitrumEnabled) {
    if (factories.evmTestnet !== undefined) {
      try {
        evmCandidate = factories.evmTestnet();
      } catch (error) {
        report("evmTestnet", error);
        evmInitializationFailed = true;
      }
    }
  }

  const evmTestnet: {
    authorization?: NonNullable<EvmTestnetTerminalPorts["authorization"]>;
    preparation?: NonNullable<EvmTestnetTerminalPorts["preparation"]>;
    atomicObservation?: NonNullable<EvmTestnetTerminalPorts["atomicObservation"]>;
    asyncObservation?: NonNullable<EvmTestnetTerminalPorts["asyncObservation"]>;
  } = {};
  let baseHealth = health(false, "DISABLED_BY_CONFIGURATION");
  if (baseEnabled) {
    if (factories.evmTestnet === undefined) {
      baseHealth = health(false, "RUNTIME_FACTORY_NOT_INJECTED");
    } else if (evmInitializationFailed) {
      baseHealth = health(false, "RUNTIME_INITIALIZATION_FAILED");
    } else if (typeof evmCandidate?.authorization?.prepare !== "function" ||
        typeof evmCandidate.preparation?.prepare !== "function" ||
        typeof evmCandidate.atomicObservation?.observe !== "function") {
      baseHealth = health(false, "REQUIRED_PORTS_MISSING");
    } else {
      evmTestnet.authorization = evmCandidate.authorization;
      evmTestnet.preparation = evmCandidate.preparation;
      evmTestnet.atomicObservation = evmCandidate.atomicObservation;
      baseHealth = health(true, null);
    }
  }

  let arbitrumHealth = health(false, "DISABLED_BY_CONFIGURATION");
  if (arbitrumEnabled) {
    if (factories.arbitrumTestnetAsync !== undefined) {
      try {
        const candidate = factories.arbitrumTestnetAsync();
        if (typeof candidate?.observe === "function") {
          evmTestnet.asyncObservation = candidate;
          arbitrumHealth = health(true, null);
        } else {
          arbitrumHealth = health(false, "REQUIRED_PORTS_MISSING");
        }
      } catch (error) {
        report("arbitrumTestnetAsync", error);
        arbitrumHealth = health(false, "RUNTIME_INITIALIZATION_FAILED");
      }
    } else if (factories.evmTestnet === undefined) {
      arbitrumHealth = health(false, "RUNTIME_FACTORY_NOT_INJECTED");
    } else if (evmInitializationFailed) {
      arbitrumHealth = health(false, "RUNTIME_INITIALIZATION_FAILED");
    } else if (typeof evmCandidate?.asyncObservation?.observe !== "function") {
      arbitrumHealth = health(false, "REQUIRED_PORTS_MISSING");
    } else {
      evmTestnet.asyncObservation = evmCandidate.asyncObservation;
      arbitrumHealth = health(true, null);
    }
  }

  let hyperliquidTestnet: HyperliquidTestnetTerminalExecutionPort | undefined;
  let hyperliquidTestnetEvidence: HyperliquidTestnetEvidenceRuntime | undefined;
  let hyperliquidHealth = health(false, "DISABLED_BY_CONFIGURATION");
  if (hyperliquidEnabled) {
    if (factories.hyperliquidTestnet === undefined
      || factories.hyperliquidTestnetEvidence === undefined) {
      hyperliquidHealth = health(false, "RUNTIME_FACTORY_NOT_INJECTED");
    } else {
      try {
        const executionCandidate = factories.hyperliquidTestnet();
        const evidenceCandidate = factories.hyperliquidTestnetEvidence();
        if (typeof executionCandidate?.execute === "function"
          && typeof evidenceCandidate?.preparation?.prepare === "function"
          && typeof evidenceCandidate.evidence?.prepare === "function"
          && typeof evidenceCandidate.evidence.reconcile === "function"
          && evidenceCandidate.readiness.preparationAvailable === true
          && evidenceCandidate.readiness.evidenceReconciliationAvailable === true) {
          hyperliquidTestnet = executionCandidate;
          hyperliquidTestnetEvidence = evidenceCandidate;
          hyperliquidHealth = health(true, null);
        } else {
          hyperliquidHealth = health(false, "REQUIRED_PORTS_MISSING");
        }
      } catch (error) {
        report("hyperliquidTestnet", error);
        hyperliquidHealth = health(false, "RUNTIME_INITIALIZATION_FAILED");
      }
    }
  }

  return Object.freeze({
    solanaDevnet,
    evmTestnet: Object.freeze(evmTestnet),
    hyperliquidTestnet,
    hyperliquidTestnetEvidence,
    health: Object.freeze({
      solanaDevnet: solanaHealth,
      baseTestnetAtomic: baseHealth,
      arbitrumTestnetAsync: arbitrumHealth,
      hyperliquidTestnet: hyperliquidHealth,
    }),
  });
}

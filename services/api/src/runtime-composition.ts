import type { EvmTestnetTerminalPorts } from "./evm-testnet-runtime-ports.js";
import type { HyperliquidTestnetTerminalExecutionPort } from "./hyperliquid-testnet-terminal.js";
import type { HyperliquidTestnetEvidenceRuntime } from "./hyperliquid-testnet-runtime-client.js";
import type { PrivateTerminalExecutionPorts } from "./terminal-execution.js";

const ENABLED_VALUES = new Set(["true", "false"]);

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

function health(
  available: boolean,
  reason: RuntimeBoundaryHealth["reason"],
): RuntimeBoundaryHealth {
  return Object.freeze({ available, reason });
}

export function composePrivateTerminalRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  factories: PrivateTerminalRuntimeFactories = {},
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
      } catch {
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
      } catch {
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
    if (factories.evmTestnet === undefined) {
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
    if (factories.hyperliquidTestnetEvidence !== undefined) {
      try {
        const candidate = factories.hyperliquidTestnetEvidence();
        if (typeof candidate?.preparation?.prepare === "function"
          && typeof candidate.evidence?.prepare === "function"
          && typeof candidate.evidence.reconcile === "function"
          && candidate.readiness.preparationAvailable === true
          && candidate.readiness.evidenceReconciliationAvailable === true
          && candidate.readiness.executionSubmissionAvailable === false) {
          hyperliquidTestnetEvidence = candidate;
        }
      } catch {
        hyperliquidTestnetEvidence = undefined;
      }
    }
    if (factories.hyperliquidTestnet === undefined) {
      hyperliquidHealth = health(false, "RUNTIME_FACTORY_NOT_INJECTED");
    } else {
      try {
        const candidate = factories.hyperliquidTestnet();
        if (typeof candidate?.execute === "function") {
          hyperliquidTestnet = candidate;
          hyperliquidHealth = health(true, null);
        } else {
          hyperliquidHealth = health(false, "REQUIRED_PORTS_MISSING");
        }
      } catch {
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

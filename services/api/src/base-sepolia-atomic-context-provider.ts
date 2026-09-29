import {
  EVM_RUNTIME_IDENTITY,
  equalAddress,
  equalHash,
  prepareEvmTraderPermitAuthorization,
  requiredEvmAddress,
  validateFinalityPolicy,
  type EvmAtomicExecutionBounds,
  type EvmContractIdentity,
  type EvmDeploymentIdentity,
  type EvmFinalityPolicy,
} from "@naryx/adapter-evm";
import {
  bytesEqual,
  domainRefFromManifest,
  fromProtocolJson,
  routePayloadBytes,
  solverQuoteBytes,
  solverSignatureDigest,
  toHex,
  validatePackageAdmission,
  type CashCarrySeriesBindingV1Input,
  type DomainRef,
  type Hash32,
  type PackageAdmissionInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import type { Hex } from "viem";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import {
  BASE_SEPOLIA_CHAIN_REFERENCE,
  BASE_SEPOLIA_DOMAIN_ID,
  type EvmTestnetAtomicAttemptContext,
} from "./evm-testnet-runtime-ports.js";

export const BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS = "PACKAGE_VERIFIER_ATOMIC_V1" as const;
export const BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL =
  "BASE_SEPOLIA_CONFORMANCE_ONLY" as const;

type AdmissionConfiguration = Omit<
  PackageAdmissionInput,
  "order" | "quote" | "route" | "currentTime"
>;

type AuthorizationBounds = Omit<
  EvmAtomicExecutionBounds,
  "currentUnixSeconds" | "traderSignature"
>;

export interface BaseSepoliaAtomicDeploymentConfiguration {
  readonly admission: AdmissionConfiguration;
  readonly deployment: EvmDeploymentIdentity;
  readonly uniswapV3: Readonly<{
    spotPort: EvmContractIdentity;
    pool: EvmContractIdentity;
    factory: EvmContractIdentity;
  }>;
  readonly conformancePerpetual: Readonly<{
    instrument: EvmContractIdentity;
    observer: EvmContractIdentity;
    evidenceLabel: typeof BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL;
  }>;
  readonly seriesBindingInput: CashCarrySeriesBindingV1Input;
  readonly executionBounds: AuthorizationBounds;
  readonly atomicEvidenceClass: typeof BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS;
  readonly finality: Readonly<{
    policy: EvmFinalityPolicy;
    manifestHash: Hash32;
  }>;
}

export interface BaseSepoliaAtomicContextProviderOptions {
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly deployments: readonly BaseSepoliaAtomicDeploymentConfiguration[];
  readonly currentUnixSeconds: () => bigint;
}

export class BaseSepoliaAtomicContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BaseSepoliaAtomicContextError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new BaseSepoliaAtomicContextError(code, message);
}

function contractMatches(left: EvmContractIdentity, right: EvmContractIdentity): boolean {
  const leftAddress = requiredEvmAddress(left.address, "contract.address");
  const rightAddress = requiredEvmAddress(right.address, "expectedContract.address");
  return equalAddress(leftAddress, rightAddress)
    && equalHash(left.expectedCodeHash, right.expectedCodeHash);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function deploymentFor(
  domain: DomainRef,
  deployments: readonly BaseSepoliaAtomicDeploymentConfiguration[],
): BaseSepoliaAtomicDeploymentConfiguration {
  const matches = deployments.filter((candidate) => {
    try {
      return sameDomain(domainRefFromManifest(candidate.deployment.domainManifest), domain);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    fail("DEPLOYMENT_NOT_FOUND", "Exactly one reviewed Base Sepolia deployment must match the order domain.");
  }
  return matches[0] as BaseSepoliaAtomicDeploymentConfiguration;
}

export function validateBaseSepoliaAtomicDeploymentConfiguration(
  configuration: BaseSepoliaAtomicDeploymentConfiguration,
): void {
  const deployment = configuration.deployment;
  const manifest = deployment.domainManifest;
  if (manifest.environment !== "testnet"
    || manifest.domainId !== BASE_SEPOLIA_DOMAIN_ID
    || manifest.chainReference !== BASE_SEPOLIA_CHAIN_REFERENCE
    || deployment.deploymentChainReference !== BigInt(BASE_SEPOLIA_CHAIN_REFERENCE)
    || manifest.runtimeClassId !== EVM_RUNTIME_IDENTITY.runtimeClassId
    || manifest.runtimeClassVersion !== EVM_RUNTIME_IDENTITY.runtimeClassVersion
    || manifest.chainNamespace !== EVM_RUNTIME_IDENTITY.chainNamespace
    || manifest.executionVerifierId !== EVM_RUNTIME_IDENTITY.executionVerifierId
    || manifest.clockModelId !== EVM_RUNTIME_IDENTITY.clockModelId
    || manifest.addressCodecId !== EVM_RUNTIME_IDENTITY.addressCodecId) {
    fail("WRONG_DOMAIN", "Deployment is not the recognized Base Sepolia EVM runtime.");
  }
  if (!contractMatches(configuration.uniswapV3.spotPort, deployment.spot.adapter)
    || !contractMatches(configuration.uniswapV3.pool, deployment.spot.market)
    || !contractMatches(configuration.uniswapV3.factory, deployment.spot.venue)) {
    fail("SPOT_IDENTITY_MISMATCH", "Uniswap V3 port, pool, or factory identity does not match deployment.");
  }
  if (configuration.conformancePerpetual.evidenceLabel
      !== BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL
    || !contractMatches(configuration.conformancePerpetual.instrument, deployment.perpetual.adapter)
    || !contractMatches(configuration.conformancePerpetual.observer, deployment.perpetualObserver)) {
    fail(
      "PERPETUAL_IDENTITY_MISMATCH",
      "Conformance perpetual identity or evidence label does not match deployment.",
    );
  }
  if (configuration.atomicEvidenceClass !== BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS) {
    fail("UNSUPPORTED_EVIDENCE_CLASS", "Atomic evidence class is unsupported.");
  }
  validateFinalityPolicy(configuration.finality.policy);
  if (!bytesEqual(manifest.finalityPolicyHash, configuration.finality.manifestHash)) {
    fail("FINALITY_POLICY_MISMATCH", "Finality policy does not match the domain manifest identity.");
  }
}

function requireClock(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    fail("INVALID_CLOCK", "Current Base Sepolia Unix time must be a positive integer.");
  }
  return value;
}

export function createBaseSepoliaAtomicContextProvider(
  options: BaseSepoliaAtomicContextProviderOptions,
): (attemptId: string) => EvmTestnetAtomicAttemptContext {
  if (typeof options.currentUnixSeconds !== "function") {
    throw new Error("Base Sepolia atomic context provider requires a trusted clock.");
  }
  return (attemptId: string): EvmTestnetAtomicAttemptContext => {
    let attempt;
    try {
      attempt = options.intents.getAttempt(attemptId);
    } catch {
      fail("ATTEMPT_NOT_FOUND", "Base Sepolia atomic attempt was not found.");
    }
    if (attempt === undefined || attempt.status !== "BASE_ATOMIC_QUOTE_SELECTED"
      || attempt.domainId !== BASE_SEPOLIA_DOMAIN_ID) {
      fail("ATTEMPT_NOT_FOUND", "Base Sepolia atomic attempt was not found.");
    }
    const record = options.orders.getByOrderHash(attempt.orderHash);
    const order = options.orders.getCanonicalOrderByHash(attempt.orderHash);
    const selected = options.intents.getSelectedQuote(attemptId);
    if (record === undefined || order === undefined || selected === undefined) {
      fail("ATTEMPT_EVIDENCE_MISSING", "Selected attempt order or signed quote evidence is missing.");
    }
    if (record.domainId !== BASE_SEPOLIA_DOMAIN_ID
      || record.domainManifestVersion !== attempt.domainManifestVersion
      || record.domainManifestHashHex !== attempt.domainManifestHash
      || order.domain.domainId !== attempt.domainId
      || order.domain.domainManifestVersion !== attempt.domainManifestVersion
      || toHex(order.domain.domainManifestHash) !== attempt.domainManifestHash
      || selected.orderHash !== attempt.orderHash
      || selected.quoteHash !== attempt.quoteHash
      || selected.routeHash !== attempt.routeHash) {
      fail("ATTEMPT_EVIDENCE_MISMATCH", "Selected attempt evidence is inconsistent.");
    }

    const orderDomain = order.domain;
    const configuration = deploymentFor(orderDomain, options.deployments);
    validateBaseSepoliaAtomicDeploymentConfiguration(configuration);
    const currentUnixSeconds = requireClock(options.currentUnixSeconds());
    let admission;
    try {
      admission = validatePackageAdmission({
        ...configuration.admission,
        order,
        route: fromProtocolJson(selected.route, "selected.route") as RoutePayloadInput,
        quote: fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput,
        currentTime: { unit: "EVM_UNIX_SECONDS", value: currentUnixSeconds },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown admission error";
      fail("PACKAGE_ADMISSION_FAILED", `Selected Base Sepolia package failed admission: ${reason}`);
    }
    if (toHex(admission.orderHash) !== attempt.orderHash
      || toHex(admission.quoteHash) !== attempt.quoteHash
      || toHex(admission.routeHash) !== attempt.routeHash) {
      fail("ATTEMPT_EVIDENCE_MISMATCH", "Selected attempt hashes do not match admitted package evidence.");
    }
    if (toHex(routePayloadBytes(admission.route)) !== selected.routeBytes
      || toHex(solverQuoteBytes(admission.quote)) !== selected.solverQuoteBytes
      || toHex(solverSignatureDigest(admission.quote)) !== selected.solverSignatureDigest) {
      fail("SIGNED_EVIDENCE_MISMATCH", "Stored solver bytes or signature digest do not match admitted evidence.");
    }
    const bounds = Object.freeze({
      ...configuration.executionBounds,
      currentUnixSeconds,
    });
    try {
      prepareEvmTraderPermitAuthorization(
        admission,
        configuration.deployment,
        configuration.seriesBindingInput,
        bounds,
      );
    } catch {
      fail("DEPLOYMENT_ADMISSION_FAILED", "Deployment identities, series binding, or execution bounds are invalid.");
    }
    const deployment = configuration.deployment;
    return Object.freeze({
      admission,
      deployment,
      seriesBindingInput: configuration.seriesBindingInput,
      bounds,
      atomicBinding: Object.freeze({
        chainReference: deployment.deploymentChainReference,
        packageVerifier: requiredEvmAddress(deployment.packageVerifier.address, "packageVerifier"),
        strategyAccount: requiredEvmAddress(deployment.strategyAccount.address, "strategyAccount"),
        orderHash: `0x${attempt.orderHash}` as Hex,
        quoteHash: `0x${attempt.quoteHash}` as Hex,
        routeHash: `0x${attempt.routeHash}` as Hex,
        executionPlanKind: "EVM_ATOMIC_BATCH",
      }),
      finality: configuration.finality.policy,
    });
  };
}

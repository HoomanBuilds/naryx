import {
  EVM_RUNTIME_IDENTITY,
  equalAddress,
  hash32,
  requiredEvmAddress,
  validateFinalityPolicy,
  type EvmAsyncObservationKeys,
  type EvmContractIdentity,
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
  type DomainManifest,
  type DomainRef,
  type Hash32,
  type PackageAdmissionInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import type { EvmTestnetAsyncAttemptContext } from "./evm-testnet-runtime-ports.js";

export const ARBITRUM_SEPOLIA_CHAIN_REFERENCE = "421614" as const;
export const ARBITRUM_SEPOLIA_DOMAIN_ID = "eip155:421614" as const;
export const ARBITRUM_ASYNC_SETTLEMENT_CLASS = "ASYNC_BONDED_SOLVER" as const;

const CLONE_INIT_PREFIX = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const CLONE_RUNTIME_PREFIX = "0x363d3d373d3d3d363d73";
const CLONE_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3";

/**
 * The factory account of `owner`: the CREATE2 address of the ERC-1167 clone of the reviewed
 * implementation with salt `keccak256(abi.encode(owner))`. Pure, so order admission needs no RPC.
 */
export function arbitrumSepoliaAccountOf(
  configuration: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "accountFactory" | "accountImplementation">,
  owner: string,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: requiredEvmAddress(configuration.accountFactory.address, "accountFactory"),
    salt: keccak256(encodeAbiParameters([{ type: "address" }], [requiredEvmAddress(owner, "owner")])),
    bytecode: concat([
      CLONE_INIT_PREFIX,
      requiredEvmAddress(configuration.accountImplementation.address, "accountImplementation"),
      CLONE_SUFFIX,
    ]),
  }).toLowerCase() as Address;
}

/** The runtime code hash every factory account shares. */
export function arbitrumSepoliaAccountCodeHash(
  configuration: Pick<ArbitrumSepoliaAsyncDeploymentConfiguration, "accountImplementation">,
): Hex {
  return keccak256(concat([
    CLONE_RUNTIME_PREFIX,
    requiredEvmAddress(configuration.accountImplementation.address, "accountImplementation"),
    CLONE_SUFFIX,
  ]));
}

export const ARBITRUM_SEPOLIA_GMX_DEPENDENCIES = Object.freeze({
  dataStore: "0xCF4c2C4c53157BcC01A596e3788fFF69cBBCD201",
  eventEmitter: "0xa973c2692C1556E1a3d478e745e9a75624AEDc73",
  exchangeRouter: "0x6B489dD5bB1AAE8df246359d59aA7316760a75d2",
  router: "0x72F13a44C8ba16a678CAD549F17bc9e06d2B8bD2",
  orderVault: "0x1b8AC606de71686fd2a1AEDEcb6E0EFba28909a2",
  orderHandler: "0xC881c2391611829d7bc81c12a285cB0201F08f8c",
  roleStore: "0x433E3C47885b929aEcE4149E3c835E565a20D95c",
} satisfies Record<string, Address>);

type AdmissionConfiguration = Omit<PackageAdmissionInput, "order" | "quote" | "route" | "currentTime">;

export interface ArbitrumSepoliaAsyncDeploymentConfiguration {
  readonly admission: AdmissionConfiguration;
  readonly domainManifest: DomainManifest;
  readonly protocolConfig: EvmContractIdentity;
  readonly coordinator: EvmContractIdentity;
  /** The shared GmxV2IsolatedAccountFactory. Every owner settles through its own `accountOf(owner)`. */
  readonly accountFactory: EvmContractIdentity;
  /** The factory's account implementation; it fixes every account address and code hash. */
  readonly accountImplementation: EvmContractIdentity;
  readonly entryAdapter: EvmContractIdentity;
  /** The factory-bound GmxV2ExitController. Without it exits are unavailable and fail closed. */
  readonly exitController?: EvmContractIdentity;
  /** The factory-bound UniswapV3SpotPort that buys and sells the spot leg. */
  readonly spotPort?: EvmContractIdentity;
  readonly orderVerifier: EvmContractIdentity;
  readonly market: EvmContractIdentity;
  readonly collateralToken: EvmContractIdentity;
  readonly gmx: Readonly<Record<keyof typeof ARBITRUM_SEPOLIA_GMX_DEPENDENCIES, EvmContractIdentity>>;
  readonly executionClassManifestHash: Hash32;
  readonly route: Readonly<{
    perpetualAdapterId: string;
    perpetualMarketId: string;
    perpetualVenueId: string;
    evidenceProfileId: string;
    stateReferenceSchemaHash: Hash32;
    receiptSchemaHash: Hash32;
    outcomeSchemaHash: Hash32;
    coordinatorEvidenceSchemaHash: Hash32;
    seriesIdentityKey: Hash32;
    seriesBindingVersion: number;
    seriesBindingHash: Hash32;
  }>;
  readonly bounds: Readonly<{
    maximumRouteExpiryValue: bigint;
    maximumRecoveryDeadlineValue: bigint;
    maximumPackageQuantityAtoms: bigint;
  }>;
  readonly finality: Readonly<{ policy: EvmFinalityPolicy; manifestHash: Hash32 }>;
}

export interface ArbitrumSepoliaAsyncAttemptEvidence {
  readonly attemptId: string;
  readonly packageId: Hex;
  readonly entryRequestKey: Hex;
  readonly exitRequestKey?: Hex;
  /** An EXIT attempt observes the entry package it closes, bound by that package's own hashes. */
  readonly entryBinding?: Readonly<{ orderHash: Hex; quoteHash: Hex; routeHash: Hex }>;
  readonly minimumStateVersion?: number;
  readonly minimumEntryRevision?: number;
  readonly minimumExitRevision?: number;
}

export interface ArbitrumSepoliaAsyncContextProviderOptions {
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly deployments: readonly ArbitrumSepoliaAsyncDeploymentConfiguration[];
  readonly evidence: (
    attemptId: string,
  ) => Promise<ArbitrumSepoliaAsyncAttemptEvidence | undefined> | ArbitrumSepoliaAsyncAttemptEvidence | undefined;
  /** Chain time: admission must agree with the coordinator's block.timestamp checks. */
  readonly currentUnixSeconds: () => bigint | Promise<bigint>;
}

export class ArbitrumSepoliaAsyncContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArbitrumSepoliaAsyncContextError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ArbitrumSepoliaAsyncContextError(code, message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function contract(identity: EvmContractIdentity, field: string): void {
  requiredEvmAddress(identity.address, `${field}.address`);
  const codeHash = hash32(identity.expectedCodeHash, `${field}.expectedCodeHash`);
  if (/^0x0+$/.test(codeHash)) fail("INVALID_DEPLOYMENT", `${field} code hash must be nonzero.`);
}

function deploymentFor(
  domain: DomainRef,
  deployments: readonly ArbitrumSepoliaAsyncDeploymentConfiguration[],
): ArbitrumSepoliaAsyncDeploymentConfiguration {
  const matches = deployments.filter((candidate) => {
    try {
      return sameDomain(domainRefFromManifest(candidate.domainManifest), domain);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    fail("DEPLOYMENT_NOT_FOUND", "Exactly one reviewed Arbitrum Sepolia deployment must match the order domain.");
  }
  return matches[0] as ArbitrumSepoliaAsyncDeploymentConfiguration;
}

export function validateArbitrumSepoliaAsyncDeploymentConfiguration(
  configuration: ArbitrumSepoliaAsyncDeploymentConfiguration,
): void {
  const manifest = configuration.domainManifest;
  if (manifest.environment !== "testnet" || manifest.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID
    || manifest.chainNamespace !== EVM_RUNTIME_IDENTITY.chainNamespace
    || manifest.chainReference !== ARBITRUM_SEPOLIA_CHAIN_REFERENCE
    || manifest.runtimeClassId !== EVM_RUNTIME_IDENTITY.runtimeClassId
    || manifest.runtimeClassVersion !== EVM_RUNTIME_IDENTITY.runtimeClassVersion
    || manifest.executionVerifierId !== EVM_RUNTIME_IDENTITY.executionVerifierId
    || manifest.clockModelId !== EVM_RUNTIME_IDENTITY.clockModelId
    || manifest.addressCodecId !== EVM_RUNTIME_IDENTITY.addressCodecId
    || !manifest.supportedSettlementClasses.includes(ARBITRUM_ASYNC_SETTLEMENT_CLASS)) {
    fail("WRONG_DOMAIN", "Deployment is not the recognized Arbitrum Sepolia async EVM runtime.");
  }
  for (const field of [
    "protocolConfig", "coordinator", "accountFactory", "accountImplementation", "entryAdapter", "orderVerifier", "market",
    "collateralToken",
  ] as const) contract(configuration[field], field);
  if ((configuration.exitController === undefined) !== (configuration.spotPort === undefined)) {
    fail("INVALID_DEPLOYMENT", "The exit controller and spot port are configured together.");
  }
  if (configuration.exitController !== undefined) contract(configuration.exitController, "exitController");
  if (configuration.spotPort !== undefined) contract(configuration.spotPort, "spotPort");
  for (const [name, expectedAddress] of Object.entries(ARBITRUM_SEPOLIA_GMX_DEPENDENCIES)) {
    const identity = configuration.gmx[name as keyof typeof configuration.gmx];
    contract(identity, `gmx.${name}`);
    if (!equalAddress(requiredEvmAddress(identity.address, `gmx.${name}.address`), expectedAddress)) {
      fail("GMX_IDENTITY_MISMATCH", `Reviewed GMX ${name} identity does not match Arbitrum Sepolia.`);
    }
  }
  const executionClassHash = hash32(`0x${toHex(configuration.executionClassManifestHash)}`, "executionClassManifestHash");
  if (/^0x0+$/.test(executionClassHash)) fail("INVALID_DEPLOYMENT", "Execution class manifest hash must be nonzero.");
  if (!Number.isSafeInteger(configuration.route.seriesBindingVersion)
    || configuration.route.seriesBindingVersion < 1
    || configuration.route.perpetualAdapterId.length === 0
    || configuration.route.perpetualMarketId.length === 0
    || configuration.route.perpetualVenueId.length === 0
    || configuration.route.evidenceProfileId.length === 0) {
    fail("INVALID_ROUTE_BINDING", "Reviewed Arbitrum route and series identity is invalid.");
  }
  hash32(`0x${toHex(configuration.route.seriesIdentityKey)}`, "seriesIdentityKey");
  hash32(`0x${toHex(configuration.route.seriesBindingHash)}`, "seriesBindingHash");
  hash32(`0x${toHex(configuration.route.stateReferenceSchemaHash)}`, "stateReferenceSchemaHash");
  hash32(`0x${toHex(configuration.route.receiptSchemaHash)}`, "receiptSchemaHash");
  hash32(`0x${toHex(configuration.route.outcomeSchemaHash)}`, "outcomeSchemaHash");
  hash32(`0x${toHex(configuration.route.coordinatorEvidenceSchemaHash)}`, "coordinatorEvidenceSchemaHash");
  if (configuration.bounds.maximumRouteExpiryValue <= 0n
    || configuration.bounds.maximumRecoveryDeadlineValue <= 0n
    || configuration.bounds.maximumPackageQuantityAtoms <= 0n) {
    fail("INVALID_BOUNDS", "Arbitrum route bounds must be positive.");
  }
  validateFinalityPolicy(configuration.finality.policy);
  if (!bytesEqual(manifest.finalityPolicyHash, configuration.finality.manifestHash)) {
    fail("FINALITY_POLICY_MISMATCH", "Finality policy does not match the domain manifest identity.");
  }
}

function checkedKeys(evidence: ArbitrumSepoliaAsyncAttemptEvidence, attemptId: string): EvmAsyncObservationKeys {
  if (evidence.attemptId !== attemptId) fail("EVIDENCE_MISMATCH", "Async evidence attempt identity does not match.");
  const keys: EvmAsyncObservationKeys = {
    packageId: hash32(evidence.packageId, "packageId"),
    entryRequestKey: hash32(evidence.entryRequestKey, "entryRequestKey"),
    ...(evidence.exitRequestKey === undefined ? {} : { exitRequestKey: hash32(evidence.exitRequestKey, "exitRequestKey") }),
    ...(evidence.minimumStateVersion === undefined ? {} : { minimumStateVersion: evidence.minimumStateVersion }),
    ...(evidence.minimumEntryRevision === undefined ? {} : { minimumEntryRevision: evidence.minimumEntryRevision }),
    ...(evidence.minimumExitRevision === undefined ? {} : { minimumExitRevision: evidence.minimumExitRevision }),
  };
  return Object.freeze(keys);
}

export function createArbitrumSepoliaAsyncContextProvider(
  options: ArbitrumSepoliaAsyncContextProviderOptions,
): (attemptId: string) => Promise<EvmTestnetAsyncAttemptContext> {
  if (typeof options.evidence !== "function" || typeof options.currentUnixSeconds !== "function") {
    throw new Error("Arbitrum Sepolia async context provider requires trusted evidence and clock ports.");
  }
  if (!Array.isArray(options.deployments) || options.deployments.length === 0) {
    throw new Error("Arbitrum Sepolia async context provider requires reviewed deployment configuration.");
  }
  for (const deployment of options.deployments) validateArbitrumSepoliaAsyncDeploymentConfiguration(deployment);
  return async (attemptId: string): Promise<EvmTestnetAsyncAttemptContext> => {
    let attempt;
    try {
      attempt = options.intents.getAttempt(attemptId);
    } catch {
      fail("ATTEMPT_NOT_FOUND", "Arbitrum Sepolia async attempt was not found.");
    }
    if (attempt === undefined || attempt.status !== "ARBITRUM_ASYNC_QUOTE_SELECTED"
      || attempt.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID) {
      fail("ATTEMPT_NOT_FOUND", "Arbitrum Sepolia async attempt was not found.");
    }
    const record = options.orders.getByOrderHash(attempt.orderHash);
    const order = options.orders.getCanonicalOrderByHash(attempt.orderHash);
    const selected = options.intents.getSelectedQuote(attemptId);
    const evidence = await options.evidence(attemptId);
    if (record === undefined || order === undefined || selected === undefined || evidence === undefined) {
      fail("ATTEMPT_EVIDENCE_MISSING", "Selected attempt order, signed quote, or async evidence is missing.");
    }
    if (record.domainId !== attempt.domainId
      || record.domainManifestVersion !== attempt.domainManifestVersion
      || record.domainManifestHashHex !== attempt.domainManifestHash
      || order.domain.domainId !== attempt.domainId
      || order.domain.domainManifestVersion !== attempt.domainManifestVersion
      || toHex(order.domain.domainManifestHash) !== attempt.domainManifestHash
      || selected.orderHash !== attempt.orderHash || selected.quoteHash !== attempt.quoteHash
      || selected.routeHash !== attempt.routeHash) {
      fail("ATTEMPT_EVIDENCE_MISMATCH", "Selected Arbitrum attempt evidence is inconsistent.");
    }
    const configuration = deploymentFor(order.domain, options.deployments);
    validateArbitrumSepoliaAsyncDeploymentConfiguration(configuration);
    const currentUnixSeconds = await options.currentUnixSeconds();
    if (typeof currentUnixSeconds !== "bigint" || currentUnixSeconds <= 0n) {
      fail("INVALID_CLOCK", "Current Arbitrum Sepolia Unix time must be positive.");
    }
    const selectedRoute = fromProtocolJson(selected.route, "selected.route") as RoutePayloadInput;
    // Observation only binds identities and hashes, so it still admits the evidence after expiry.
    const admissionTime = currentUnixSeconds >= selectedRoute.routeExpiryValue
      ? selectedRoute.routeExpiryValue - 1n
      : currentUnixSeconds;
    let admission;
    try {
      admission = validatePackageAdmission({
        ...configuration.admission,
        order,
        route: selectedRoute,
        quote: fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput,
        currentTime: { unit: "EVM_UNIX_SECONDS", value: admissionTime },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown admission error";
      fail("PACKAGE_ADMISSION_FAILED", `Selected Arbitrum package failed admission: ${reason}`);
    }
    if (toHex(admission.orderHash) !== attempt.orderHash || toHex(admission.quoteHash) !== attempt.quoteHash
      || toHex(admission.routeHash) !== attempt.routeHash
      || toHex(routePayloadBytes(admission.route)) !== selected.routeBytes
      || toHex(solverQuoteBytes(admission.quote)) !== selected.solverQuoteBytes
      || toHex(solverSignatureDigest(admission.quote)) !== selected.solverSignatureDigest) {
      fail("SIGNED_EVIDENCE_MISMATCH", "Stored solver bytes and hashes do not match admitted evidence.");
    }
    const route = admission.route;
    const perpetual = route.legs.find((leg) => leg.legRole === "PERPETUAL");
    if (route.settlementClass !== ARBITRUM_ASYNC_SETTLEMENT_CLASS
      || route.executionPlanKind !== "EVM_ASYNC_REQUEST" || route.recoveryPlan === undefined
      || route.owner.toLowerCase() !== order.owner.toLowerCase()
      || route.settlementAccount.toLowerCase() !== order.settlementAccount.toLowerCase()
      || !equalAddress(
        requiredEvmAddress(route.settlementAccount, "route.settlementAccount"),
        arbitrumSepoliaAccountOf(configuration, order.owner),
      )
      || perpetual?.adapter.adapterId !== configuration.route.perpetualAdapterId
    || perpetual.market.subjectId !== configuration.route.perpetualMarketId
    || perpetual.venue.subjectId !== configuration.route.perpetualVenueId
      || route.evidenceRequirements.profileId !== configuration.route.evidenceProfileId
      || !bytesEqual(route.evidenceRequirements.stateReferenceSchemaHash, configuration.route.stateReferenceSchemaHash)
      || !bytesEqual(route.evidenceRequirements.receiptSchemaHash, configuration.route.receiptSchemaHash)
      || !bytesEqual(route.evidenceRequirements.outcomeSchemaHash, configuration.route.outcomeSchemaHash)) {
      fail("ROUTE_BINDING_MISMATCH", "Selected route does not match the reviewed Arbitrum async route.");
    }
    if (route.routeExpiryValue > configuration.bounds.maximumRouteExpiryValue
      || route.recoveryPlan.deadlineValue > configuration.bounds.maximumRecoveryDeadlineValue
      || order.quantity.atoms > configuration.bounds.maximumPackageQuantityAtoms) {
      fail("BOUNDS_EXCEEDED", "Selected Arbitrum package exceeds reviewed runtime bounds.");
    }
    const keys = checkedKeys(evidence, attemptId);
    // An exit is observed on its entry package: the coordinator terms carry the entry's hashes, and the
    // exit controller reports the close. The exit's own hashes are bound by the owner's authorization.
    const exit = order.action === "EXIT";
    const entryBinding = evidence.entryBinding;
    if (exit !== (entryBinding !== undefined) || (exit && (configuration.exitController === undefined
      || order.entryReceiptHash === undefined || toHex(order.entryReceiptHash) !== keys.packageId.slice(2)))) {
      fail("ATTEMPT_EVIDENCE_MISMATCH", "Exit evidence is not bound to the order's entry package.");
    }
    return Object.freeze({
      domainManifest: configuration.domainManifest,
      binding: Object.freeze({
        chainReference: BigInt(ARBITRUM_SEPOLIA_CHAIN_REFERENCE),
        coordinator: requiredEvmAddress(configuration.coordinator.address, "coordinator"),
        entryAdapter: requiredEvmAddress(configuration.entryAdapter.address, "entryAdapter"),
        handler: requiredEvmAddress(configuration.entryAdapter.address, "handler"),
        ...(exit ? { exitController: requiredEvmAddress(configuration.exitController!.address, "exitController") } : {}),
        owner: requiredEvmAddress(order.owner, "order.owner"),
        orderHash: entryBinding === undefined ? `0x${attempt.orderHash}` as Hex : hash32(entryBinding.orderHash, "entry orderHash"),
        quoteHash: entryBinding === undefined ? `0x${attempt.quoteHash}` as Hex : hash32(entryBinding.quoteHash, "entry quoteHash"),
        routeHash: entryBinding === undefined ? `0x${attempt.routeHash}` as Hex : hash32(entryBinding.routeHash, "entry routeHash"),
        domainIdHash: keccak256(stringToHex(ARBITRUM_SEPOLIA_DOMAIN_ID)),
        domainManifestVersion: attempt.domainManifestVersion,
        domainManifestHash: `0x${attempt.domainManifestHash}` as Hex,
        executionClassManifestHash: `0x${toHex(configuration.executionClassManifestHash)}` as Hex,
      }),
      keys,
      requirements: Object.freeze({
        settlementClass: ARBITRUM_ASYNC_SETTLEMENT_CLASS,
        executionPlanKind: "EVM_ASYNC_REQUEST",
        seriesIdentityKey: `0x${toHex(configuration.route.seriesIdentityKey)}` as Hex,
        seriesBindingVersion: configuration.route.seriesBindingVersion,
        seriesBindingHash: `0x${toHex(configuration.route.seriesBindingHash)}` as Hex,
        maximumRouteExpiryValue: configuration.bounds.maximumRouteExpiryValue,
        maximumRecoveryDeadlineValue: configuration.bounds.maximumRecoveryDeadlineValue,
        maximumPackageQuantityAtoms: configuration.bounds.maximumPackageQuantityAtoms,
        finality: configuration.finality.policy,
        evidenceProfileId: route.evidenceRequirements.profileId,
        stateReferenceSchemaHash: `0x${toHex(configuration.route.stateReferenceSchemaHash)}` as Hex,
        receiptSchemaHash: `0x${toHex(configuration.route.receiptSchemaHash)}` as Hex,
        outcomeSchemaHash: `0x${toHex(configuration.route.outcomeSchemaHash)}` as Hex,
      }),
    });
  };
}

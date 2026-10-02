import {
  EVM_RUNTIME_IDENTITY,
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
  NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  deriveTestPerpEntryLimits,
  encodeTestPerpTradeArgs,
  equalAddress,
  equalHash,
  packageVerifierOpenPackage,
  prepareEvmTraderPermitAuthorization,
  requiredEvmAddress,
  validateFinalityPolicy,
  type EvmAtomicAuthorizationBounds,
  type EvmContractIdentity,
  type EvmDeploymentIdentity,
  type EvmFinalityPolicy,
  type EvmReadPort,
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
  type PackageAdmission,
  type PackageAdmissionInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from "@naryx/protocol-types";
import { encodePacked, keccak256, stringToHex, type Address, type Hex } from "viem";
import type { ExecutionIntentStore } from "./execution-intent-store.js";
import type { InternalOrderStore } from "./internal-order-store.js";
import {
  BASE_SEPOLIA_CHAIN_REFERENCE,
  BASE_SEPOLIA_DOMAIN_ID,
  EvmTestnetTerminalValidationError,
  type EvmTestnetAtomicAttemptContext,
  type EvmTestnetAtomicContextPurpose,
} from "./evm-testnet-runtime-ports.js";

export const BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS = "PACKAGE_VERIFIER_ATOMIC_V1" as const;
export const BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL =
  "BASE_SEPOLIA_CONFORMANCE_ONLY" as const;

type AdmissionConfiguration = Omit<
  PackageAdmissionInput,
  "order" | "quote" | "route" | "currentTime"
>;

const MAX_CACHED_ATTEMPTS = 256;
const SPOT_FILL_DOMAIN = stringToHex("NARYX/base-uniswap-spot-fill/v1");

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
  /**
   * Reviewed execution policy. Perpetual bounds are never configured: they are derived per attempt
   * from the market's live position, reserve, and `previewOpen`.
   */
  readonly executionPolicy: Readonly<{
    /** Active solver address that co-signs the on-chain SolverAuthorization. */
    solver: Address;
    /** How far the oracle may move between authorization and execution, in basis points. */
    oracleMoveAllowanceBps: number;
  }>;
  readonly atomicEvidenceClass: typeof BASE_SEPOLIA_ATOMIC_EVIDENCE_CLASS;
  readonly finality: Readonly<{
    policy: EvmFinalityPolicy;
    manifestHash: Hash32;
  }>;
}

/** Signerless reads the live context needs; chain identity is checked by the runtime. */
export interface BaseSepoliaAtomicLiveReads {
  codeHash(address: Address): Promise<Hex | undefined>;
  readContract: EvmReadPort["readContract"];
}

export interface BaseSepoliaAtomicContextProviderOptions {
  readonly intents: ExecutionIntentStore;
  readonly orders: InternalOrderStore;
  readonly deployments: readonly BaseSepoliaAtomicDeploymentConfiguration[];
  readonly currentUnixSeconds: () => bigint;
  readonly reads: BaseSepoliaAtomicLiveReads;
}

export class BaseSepoliaAtomicContextError extends EvmTestnetTerminalValidationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BaseSepoliaAtomicContextError";
  }
}

export type BaseSepoliaStrategyAccount = Readonly<{
  owner: Address;
  account: Address;
  deployed: boolean;
}>;

type TestPerpPosition = Readonly<{ balance: bigint; size: bigint; entryNotional: bigint }>;

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
  if (!/^0x[0-9a-f]{64}$/i.test(deployment.strategyAccountCodeHash ?? "")
    || /^0x0{64}$/.test(deployment.strategyAccountCodeHash)) {
    fail("ACCOUNT_IDENTITY_INVALID", "Strategy account code hash must be a nonzero 32-byte hash.");
  }
  requiredEvmAddress(deployment.strategyAccountFactory?.address, "strategyAccountFactory");
  requiredEvmAddress(configuration.executionPolicy?.solver, "executionPolicy.solver");
  const allowance = configuration.executionPolicy.oracleMoveAllowanceBps;
  if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance >= 1_000) {
    fail("EXECUTION_POLICY_INVALID", "Oracle move allowance must be an integer below 1000 bps.");
  }
  if (!contractMatches(configuration.uniswapV3.spotPort, deployment.spot.adapter)
    || !contractMatches(configuration.uniswapV3.pool, deployment.spot.market)
    || !contractMatches(configuration.uniswapV3.factory, deployment.spot.venue)) {
    fail("SPOT_IDENTITY_MISMATCH", "Uniswap V3 port, pool, or factory identity does not match deployment.");
  }
  if (configuration.conformancePerpetual.evidenceLabel
      !== BASE_SEPOLIA_CONFORMANCE_PERPETUAL_EVIDENCE_LABEL
    || !contractMatches(configuration.conformancePerpetual.instrument, deployment.perpetual.market)
    || !contractMatches(configuration.conformancePerpetual.observer, deployment.perpetualObserver)
    || !contractMatches(deployment.perpetual.venue, deployment.perpetualObserver)
    || !contractMatches(deployment.perpetual.adapter, deployment.packageVerifier)) {
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

/**
 * Resolves the owner's factory account from chain. The address is `accountOf(owner)`; once deployed
 * its code must be the factory's shared account code, bound to this verifier, and still owned by
 * `owner` (a novated account no longer settles for its previous owner).
 */
export async function resolveBaseSepoliaStrategyAccount(
  reads: BaseSepoliaAtomicLiveReads,
  deployment: EvmDeploymentIdentity,
  ownerValue: string,
): Promise<BaseSepoliaStrategyAccount> {
  let owner: Address;
  try {
    owner = requiredEvmAddress(ownerValue, "owner");
  } catch {
    fail("INVALID_OWNER", "Base Sepolia order owner must be an EVM address.");
  }
  const factory = requiredEvmAddress(deployment.strategyAccountFactory.address, "strategyAccountFactory");
  const account = requiredEvmAddress(
    String(await reads.readContract({
      address: factory,
      abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
      functionName: "accountOf",
      args: [owner],
    })),
    "accountOf(owner)",
  );
  const codeHash = await reads.codeHash(account);
  if (codeHash === undefined) return Object.freeze({ owner, account, deployed: false });
  if (!equalHash(codeHash, deployment.strategyAccountCodeHash)) {
    fail("ACCOUNT_CODE_MISMATCH", "Strategy account code does not match the factory account code.");
  }
  const [boundVerifier, currentOwner] = await Promise.all([
    reads.readContract({ address: account, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "verifier" }),
    reads.readContract({ address: account, abi: NARYX_STRATEGY_ACCOUNT_OWNER_ABI, functionName: "owner" }),
  ]);
  if (!equalAddress(requiredEvmAddress(String(boundVerifier), "account.verifier"),
    requiredEvmAddress(deployment.packageVerifier.address, "packageVerifier"))) {
    fail("ACCOUNT_VERIFIER_MISMATCH", "Strategy account is not bound to the reviewed package verifier.");
  }
  if (!equalAddress(requiredEvmAddress(String(currentOwner), "account.owner"), owner)) {
    fail("ACCOUNT_OWNER_MISMATCH", "Strategy account is no longer owned by the order owner.");
  }
  return Object.freeze({ owner, account, deployed: true });
}

function readPosition(value: unknown): TestPerpPosition {
  const record = value as Record<string, unknown> | undefined;
  const balance = record?.balance;
  const size = record?.size;
  const entryNotional = record?.entryNotional;
  if (typeof balance !== "bigint" || typeof size !== "bigint" || typeof entryNotional !== "bigint") {
    fail("PERP_POSITION_INVALID", "Test perpetual position read is malformed.");
  }
  return Object.freeze({ balance, size, entryNotional });
}

function positiveBigint(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) fail("PERP_MARKET_INVALID", `${name} must be positive.`);
  return value;
}

type CachedBounds = Readonly<{
  bounds: Omit<EvmAtomicAuthorizationBounds, "currentUnixSeconds">;
  deadline: bigint;
}>;

async function deriveAttemptBounds(
  reads: BaseSepoliaAtomicLiveReads,
  configuration: BaseSepoliaAtomicDeploymentConfiguration,
  admission: PackageAdmission,
  account: Address,
): Promise<CachedBounds> {
  const { order, quote, route } = admission;
  const market = requiredEvmAddress(configuration.deployment.perpetual.market.address, "perpetual.market");
  const read = (functionName: string, args?: readonly unknown[]) => reads.readContract({
    address: market,
    abi: NARYX_TEST_PERP_MARKET_ABI,
    functionName,
    ...(args === undefined ? {} : { args }),
  });
  const expiry = Number(await read("expiry"));
  if (!Number.isSafeInteger(expiry) || expiry <= 0) fail("PERP_MARKET_INVALID", "Test perpetual expiry is invalid.");
  const position = readPosition(await read("getPosition", [market, expiry, account]));
  const quantity = order.quantity.atoms;
  if (order.quantity.asset.decimals !== 18 || quantity <= 0n) {
    fail("UNSUPPORTED_QUANTITY", "Base Sepolia perpetual quantity must be a positive 18-decimal amount.");
  }
  const deadline = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue]
    .reduce((left, right) => left < right ? left : right);
  const verifier = requiredEvmAddress(configuration.deployment.packageVerifier.address, "packageVerifier");
  const [packageNonce, openRecord] = await Promise.all([
    reads.readContract({ address: verifier, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "nextNonce", args: [account] }),
    reads.readContract({ address: verifier, abi: PACKAGE_VERIFIER_ACCOUNT_ABI, functionName: "openPackage", args: [account] }),
  ]);
  if (typeof packageNonce !== "bigint" || packageNonce < 0n) {
    fail("PACKAGE_NONCE_INVALID", "Package verifier nonce read is malformed.");
  }
  let open;
  try {
    open = packageVerifierOpenPackage(openRecord);
  } catch {
    fail("OPEN_PACKAGE_INVALID", "Package verifier open package read is malformed.");
  }
  const spotFillCommitment = Uint8Array.from(Buffer.from(keccak256(encodePacked(
    ["bytes", "bytes32", "bytes32", "bytes32"],
    [SPOT_FILL_DOMAIN, `0x${toHex(admission.orderHash)}`, `0x${toHex(admission.quoteHash)}`, `0x${toHex(admission.routeHash)}`],
  )).slice(2), "hex")) as Hash32;
  const common = {
    strategyAccount: account,
    solver: requiredEvmAddress(configuration.executionPolicy.solver, "executionPolicy.solver"),
    spotFillCommitment,
    packageNonce,
    perpExpiry: expiry,
  };
  if (order.action === "EXIT") {
    // The verifier admits an exit only of the exact open package record, so bind to it here.
    if (open === null) fail("NO_OPEN_PACKAGE", "The strategy account has no open package to exit.");
    if (order.entryReceiptHash === undefined
      || !equalHash(open.entryReceiptHash, `0x${toHex(order.entryReceiptHash)}`)
      || open.baseQuantityAtoms !== quantity || open.perpQuantityWad !== quantity
      || !equalAddress(open.perpInstrument, market) || open.perpExpiry !== expiry) {
      fail("OPEN_PACKAGE_MISMATCH", "The exit order does not match the open package record.");
    }
    if (position.size !== -quantity || position.entryNotional !== open.entryPerpNotionalWad) {
      fail("PERP_POSITION_MISMATCH", "Open test perpetual position does not match the exit quantity.");
    }
    return Object.freeze({
      deadline,
      bounds: Object.freeze({
        ...common,
        expectedPrePerpEntryNotionalWad: open.entryPerpNotionalWad,
        expectedPrePerpBalanceWad: position.balance,
        minimumPostPerpBalanceWad: 0n,
        maximumPostPerpBalanceWad: 0n,
        maximumPostPerpEntryNotionalWad: 0n,
        // A full close returns the payout to the account's reserve at the market.
        perpArgs: encodeTestPerpTradeArgs({ deadline, expiry, sizeDeltaWad: quantity, balanceDeltaWad: 0n }),
      }),
    });
  }
  if (open !== null || position.size !== 0n || position.balance !== 0n || position.entryNotional !== 0n) {
    fail("PERP_POSITION_EXISTS", "The strategy account already holds a test perpetual position.");
  }
  if (await read("opensPaused") === true) fail("PERP_OPENS_PAUSED", "Test perpetual opens are paused.");
  const marginAtoms = quote.expectedMarginDelta?.atoms;
  if (typeof marginAtoms !== "bigint" || marginAtoms <= 0n || marginAtoms > order.maxMarginAdded.atoms) {
    fail("MARGIN_OUT_OF_BOUNDS", "Quoted perpetual margin must be positive and within the order margin cap.");
  }
  const [reserve, collateralScale, takerFeeBps, initialMarginBps] = await Promise.all([
    read("reserveOf", [account]),
    read("collateralScale"),
    read("takerFeeBps"),
    read("initialMarginBps"),
  ]);
  if (typeof reserve !== "bigint" || reserve < marginAtoms) {
    fail("MARGIN_RESERVE_INSUFFICIENT", "Deposit perpetual margin to the strategy account reserve before authorizing.");
  }
  const scale = positiveBigint(collateralScale, "collateralScale");
  const balanceWad = marginAtoms * scale;
  const preview = await read("previewOpen", [-quantity, balanceWad]) as readonly unknown[];
  let limits;
  try {
    limits = deriveTestPerpEntryLimits({
      previewEntryNotionalWad: positiveBigint(preview?.[1], "previewOpen entry notional"),
      balanceWad,
      oracleMoveAllowanceBps: BigInt(configuration.executionPolicy.oracleMoveAllowanceBps),
      market: {
        takerFeeBps: BigInt(Number(takerFeeBps)),
        initialMarginBps: BigInt(Number(initialMarginBps)),
        collateralScale: scale,
      },
    });
  } catch (error) {
    fail("PERP_BOUNDS_UNSAFE", error instanceof Error ? error.message : "Perpetual entry bounds are unsafe.");
  }
  return Object.freeze({
    deadline,
    bounds: Object.freeze({
      ...common,
      expectedPrePerpEntryNotionalWad: 0n,
      expectedPrePerpBalanceWad: 0n,
      ...limits,
      perpArgs: encodeTestPerpTradeArgs({ deadline, expiry, sizeDeltaWad: -quantity, balanceDeltaWad: balanceWad }),
    }),
  });
}

export function createBaseSepoliaAtomicContextProvider(
  options: BaseSepoliaAtomicContextProviderOptions,
): (attemptId: string, purpose?: EvmTestnetAtomicContextPurpose) => Promise<EvmTestnetAtomicAttemptContext> {
  if (typeof options.currentUnixSeconds !== "function") {
    throw new Error("Base Sepolia atomic context provider requires a trusted clock.");
  }
  if (typeof options.reads?.readContract !== "function" || typeof options.reads?.codeHash !== "function") {
    throw new Error("Base Sepolia atomic context provider requires live chain reads.");
  }
  // Bounds are fixed when the trader is asked to sign and reused until the package deadline, so the
  // signed limits hash and the submitted calldata always agree.
  const cache = new Map<string, CachedBounds>();
  return async (attemptId: string, purpose: EvmTestnetAtomicContextPurpose = "authorize") => {
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
    const route = fromProtocolJson(selected.route, "selected.route") as RoutePayloadInput;
    const quote = fromProtocolJson(selected.quote, "selected.quote") as SolverQuoteInput;
    // Observation only binds identities and hashes, so it still admits the evidence after expiry.
    const admissionTime = purpose === "observe" && currentUnixSeconds >= route.routeExpiryValue
      ? route.routeExpiryValue - 1n
      : currentUnixSeconds;
    let admission;
    try {
      admission = validatePackageAdmission({
        ...configuration.admission,
        order,
        route,
        quote,
        currentTime: { unit: "EVM_UNIX_SECONDS", value: admissionTime },
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
    const deployment = configuration.deployment;
    let settlementAccount: Address;
    try {
      settlementAccount = requiredEvmAddress(order.settlementAccount, "order.settlementAccount");
    } catch {
      fail("SETTLEMENT_ACCOUNT_MISMATCH", "Order settlement account must be an EVM address.");
    }
    const atomicBinding = Object.freeze({
      chainReference: deployment.deploymentChainReference,
      packageVerifier: requiredEvmAddress(deployment.packageVerifier.address, "packageVerifier"),
      strategyAccount: settlementAccount,
      orderHash: `0x${attempt.orderHash}` as Hex,
      quoteHash: `0x${attempt.quoteHash}` as Hex,
      routeHash: `0x${attempt.routeHash}` as Hex,
      executionPlanKind: "EVM_ATOMIC_BATCH" as const,
    });
    if (purpose === "observe") {
      const cached = cache.get(attemptId);
      return Object.freeze({
        admission,
        deployment,
        seriesBindingInput: configuration.seriesBindingInput,
        bounds: cached === undefined ? undefined : Object.freeze({ ...cached.bounds, currentUnixSeconds }),
        atomicBinding,
        finality: configuration.finality.policy,
      });
    }

    const resolved = await resolveBaseSepoliaStrategyAccount(options.reads, deployment, order.owner);
    if (!equalAddress(resolved.account, settlementAccount)) {
      fail("SETTLEMENT_ACCOUNT_MISMATCH", "Order settlement account is not the owner's factory account.");
    }
    if (!resolved.deployed) {
      fail("ACCOUNT_NOT_DEPLOYED", "Create the strategy account before authorizing a package.");
    }
    for (const [key, entry] of cache) if (entry.deadline <= currentUnixSeconds) cache.delete(key);
    let derived = cache.get(attemptId);
    if (derived === undefined) {
      if (purpose === "prepare") {
        // The signed limits are gone; deriving new ones would not match the trader signature.
        fail("AUTHORIZATION_EXPIRED", "Authorize the package again before preparing it.");
      }
      derived = await deriveAttemptBounds(options.reads, configuration, admission, settlementAccount);
      cache.set(attemptId, derived);
      while (cache.size > MAX_CACHED_ATTEMPTS) cache.delete(cache.keys().next().value!);
    }
    const bounds = Object.freeze({ ...derived.bounds, currentUnixSeconds });
    try {
      prepareEvmTraderPermitAuthorization(admission, deployment, configuration.seriesBindingInput, bounds);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown compiler error";
      fail("DEPLOYMENT_ADMISSION_FAILED", `Deployment identities, series binding, or bounds are invalid: ${reason}`);
    }
    return Object.freeze({
      admission,
      deployment,
      seriesBindingInput: configuration.seriesBindingInput,
      bounds,
      atomicBinding,
      finality: configuration.finality.policy,
    });
  };
}

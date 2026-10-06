import type { CompiledExecution } from '@naryx/adapter-core';
import {
  bytesEqual,
  cashCarrySeriesBindingV1,
  cashCarrySeriesBindingV1Hash,
  cashCarrySeriesIdentityKey,
  domainRefFromManifest,
  enumDiscriminant,
  PACKAGE_ACTION,
  mulDiv,
  scaleDecimals,
  type AdapterRef,
  type AssetRef,
  type CashCarrySeriesBindingV1,
  type CashCarrySeriesBindingV1Input,
  type DomainManifest,
  type DomainRef,
  type Hash32,
  type PackageAdmission,
  type RouteAccountBinding,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  bytesToHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import {
  EVM_CASH_CARRY_ADMISSION_COMPONENTS,
  NARYX_STRATEGY_ACCOUNT_ABI,
} from './abi.js';

export * from './strategy-plan.js';
export * from './multi-strategy-account.js';
export * from './typed-materializers.js';

const UINT32_MAX = (1n << 32n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const INT128_MIN = -(1n << 127n);
const INT128_MAX = (1n << 127n) - 1n;
const ATOMIC_SETTLEMENT_CLASS_ID = keccak256(stringToHex('ATOMIC_POSTCONDITION'));

export const EVM_RUNTIME_IDENTITY = Object.freeze({
  runtimeClassId: 'naryx-evm',
  runtimeClassVersion: 1,
  chainNamespace: 'eip155',
  executionVerifierId: 'package-verifier-v1',
  clockModelId: 'evm-unix-seconds',
  addressCodecId: 'evm-address-20',
} as const);

export interface EvmContractIdentity {
  readonly address: Address;
  readonly expectedCodeHash: Hex;
}

export interface EvmManifestResourceIdentity extends EvmContractIdentity {
  readonly subjectId: string;
  readonly manifestVersion: number;
  readonly manifestHash: Hash32;
}

export interface EvmAssetDeploymentIdentity extends EvmManifestResourceIdentity {
  readonly decimals: number;
}

export interface EvmLegDeploymentIdentity {
  readonly adapter: EvmManifestResourceIdentity;
  readonly adapterClassId: string;
  readonly adapterClassVersion: number;
  readonly market: EvmManifestResourceIdentity;
  readonly venue: EvmManifestResourceIdentity;
  readonly baseLotAtoms: bigint;
}

export interface EvmDeploymentIdentity {
  readonly domainManifest: DomainManifest;
  readonly deploymentChainReference: bigint;
  /** Per-owner accounts: `accountOf(owner)` is the only settlement account an order may name. */
  readonly strategyAccountFactory: EvmContractIdentity;
  /** Runtime code hash every factory account shares (`accountCodeHash()`). */
  readonly strategyAccountCodeHash: Hex;
  readonly packageVerifier: EvmContractIdentity;
  readonly settlementClass: Readonly<{
    classId: Hash32;
    classVersion: number;
  }>;
  readonly spot: EvmLegDeploymentIdentity;
  readonly perpetual: EvmLegDeploymentIdentity;
  readonly perpetualObserver: EvmContractIdentity;
  readonly baseAsset: EvmAssetDeploymentIdentity;
  readonly quoteAsset: EvmAssetDeploymentIdentity;
}

export interface EvmAtomicExecutionBounds {
  readonly currentUnixSeconds: bigint;
  /** The owner's factory account, resolved from chain (`accountOf(owner)`) by the caller. */
  readonly strategyAccount: Address;
  /** The active-solver EVM address that signs the on-chain SolverAuthorization. */
  readonly solver: Address;
  readonly traderSignature: Hex;
  readonly solverSignature: Hex;
  readonly spotFillCommitment: Hash32;
  /**
   * The verifier's `nextNonce(strategyAccount)` read from chain. The order nonce is an off-chain
   * request identity; the verifier admits only the account's next package nonce.
   */
  readonly packageNonce: bigint;
  /**
   * Exit only: the open package's exact `entryPerpNotionalWad` from chain. The order commits it in
   * quote atoms, which cannot carry the WAD remainder the verifier compares; zero for an entry.
   */
  readonly expectedPrePerpEntryNotionalWad: bigint;
  readonly expectedPrePerpBalanceWad: bigint;
  readonly minimumPostPerpBalanceWad: bigint;
  readonly maximumPostPerpBalanceWad: bigint;
  readonly maximumPostPerpEntryNotionalWad: bigint;
  readonly perpExpiry: number;
  readonly perpArgs: readonly [Hash32, Hash32];
}

export type EvmAtomicAuthorizationBounds = Omit<EvmAtomicExecutionBounds, 'traderSignature' | 'solverSignature'>;

export const EVM_TRADER_PERMIT_DOMAIN = Object.freeze({
  name: 'Naryx Package Verifier',
  version: '1',
} as const);

const PACKAGE_DIGEST_FIELDS = Object.freeze([
  { name: 'packageHash', type: 'bytes32' },
  { name: 'accountsHash', type: 'bytes32' },
  { name: 'limitsHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const);

export const EVM_TRADER_PERMIT_TYPES = Object.freeze({ TraderPermit: PACKAGE_DIGEST_FIELDS } as const);
export const EVM_SOLVER_AUTHORIZATION_TYPES = Object.freeze({ SolverAuthorization: PACKAGE_DIGEST_FIELDS } as const);

export interface EvmPackageAuthorization<Types, PrimaryType extends string> {
  readonly domain: Readonly<{
    name: typeof EVM_TRADER_PERMIT_DOMAIN.name;
    version: typeof EVM_TRADER_PERMIT_DOMAIN.version;
    chainId: bigint;
    verifyingContract: Address;
  }>;
  readonly types: Types;
  readonly primaryType: PrimaryType;
  readonly message: Readonly<{
    packageHash: Hex;
    accountsHash: Hex;
    limitsHash: Hex;
    nonce: bigint;
    deadline: bigint;
  }>;
  readonly digest: Hex;
}

export type EvmTraderPermitAuthorization =
  EvmPackageAuthorization<typeof EVM_TRADER_PERMIT_TYPES, 'TraderPermit'>;
export type EvmSolverAuthorization =
  EvmPackageAuthorization<typeof EVM_SOLVER_AUTHORIZATION_TYPES, 'SolverAuthorization'>;

export interface EvmCallPayload {
  readonly chainReference: bigint;
  readonly to: Address;
  readonly value: 0n;
  readonly data: Hex;
}

export type CompiledEvmAtomicPackage = CompiledExecution<EvmCallPayload>;

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

function sameAdapter(left: AdapterRef, right: EvmManifestResourceIdentity): boolean {
  return left.adapterId === right.subjectId
    && left.adapterManifestVersion === right.manifestVersion
    && sameHash(left.adapterManifestHash, right.manifestHash);
}

function sameManifest(left: VersionedManifestRef, right: EvmManifestResourceIdentity): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && sameHash(left.manifestHash, right.manifestHash);
}

function sameAsset(left: AssetRef, right: EvmAssetDeploymentIdentity): boolean {
  return left.assetId === right.subjectId
    && left.decimals === right.decimals
    && sameHash(left.assetManifestHash, right.manifestHash);
}

function sameSeriesSubject(subjectIdentity: Hash32, resource: EvmManifestResourceIdentity): boolean {
  return nonzeroHash(subjectIdentity, `${resource.subjectId}.subjectIdentity`) === identityHash(resource.subjectId);
}

function validateSeriesBinding(
  input: CashCarrySeriesBindingV1Input,
  action: 'ENTRY' | 'EXIT',
  domain: DomainRef,
  deployment: EvmDeploymentIdentity,
  templateId: string,
  templateVersion: number,
  templateManifestHash: Hash32,
): CashCarrySeriesBindingV1 {
  const binding = cashCarrySeriesBindingV1(input, 'seriesBinding');
  requireCondition(binding.domain.domainId === domain.domainId, 'series binding domain identity mismatch');
  requireCondition(sameSeriesSubject(binding.baseAsset.subjectIdentity, deployment.baseAsset), 'series binding base asset identity mismatch');
  requireCondition(sameSeriesSubject(binding.quoteAsset.subjectIdentity, deployment.quoteAsset), 'series binding quote asset identity mismatch');
  requireCondition(binding.templateId === templateId, 'series binding template mismatch');
  requireCondition(binding.templateVersion === templateVersion, 'series binding template version mismatch');
  requireCondition(sameHash(binding.templateManifestHash, templateManifestHash), 'series binding template manifest mismatch');
  requireCondition(binding.settlementClass === 'ATOMIC_POSTCONDITION', 'series binding settlement class mismatch');
  requireCondition(binding.settlementClassVersion === deployment.settlementClass.classVersion, 'series binding settlement class version mismatch');

  if (action === 'ENTRY') {
    requireCondition(sameDomain(binding.domain, domain), 'entry series binding domain mismatch');
    requireCondition(
      binding.baseAsset.manifestVersion === deployment.baseAsset.manifestVersion
        && sameHash(binding.baseAsset.manifestHash, deployment.baseAsset.manifestHash),
      'entry series binding base asset manifest mismatch',
    );
    requireCondition(
      binding.quoteAsset.manifestVersion === deployment.quoteAsset.manifestVersion
        && sameHash(binding.quoteAsset.manifestHash, deployment.quoteAsset.manifestHash),
      'entry series binding quote asset manifest mismatch',
    );
  }

  return binding;
}

function derivePackageSizeUnits(
  baseQuantityAtoms: bigint,
  perpQuantityWad: bigint,
  binding: CashCarrySeriesBindingV1,
): bigint {
  requireCondition(
    baseQuantityAtoms % binding.spotBaseAtomsPerPackageUnit === 0n,
    'base quantity is not divisible by the series spot unit',
  );
  requireCondition(
    perpQuantityWad % binding.perpQuantityAtomsPerPackageUnit === 0n,
    'perpetual quantity is not divisible by the series perpetual unit',
  );
  const spotUnits = baseQuantityAtoms / binding.spotBaseAtomsPerPackageUnit;
  const perpetualUnits = perpQuantityWad / binding.perpQuantityAtomsPerPackageUnit;
  requireCondition(spotUnits !== 0n, 'package size units must be nonzero');
  requireCondition(spotUnits === perpetualUnits, 'spot and perpetual package units differ');
  return positiveUint(spotUnits, UINT128_MAX, 'packageSizeUnits');
}

function nonzeroHash(value: Uint8Array, name: string): Hex {
  requireCondition(value instanceof Uint8Array && value.length === 32, `${name} must be 32 bytes`);
  requireCondition(value.some((byte) => byte !== 0), `${name} must be nonzero`);
  return bytesToHex(value);
}

function optionalHash(value: Uint8Array | undefined, name: string): Hex {
  return value === undefined ? zeroHash : nonzeroHash(value, name);
}

function codeHash(value: unknown, name: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${name} must be a 32-byte hex value`);
  requireCondition(value.toLowerCase() !== zeroHash, `${name} must be nonzero`);
  return value as Hex;
}

function requiredAddress(value: unknown, name: string): Address {
  requireCondition(typeof value === 'string' && isAddress(value, { strict: false }), `${name} must be an EVM address`);
  const checked = getAddress(value);
  requireCondition(checked !== zeroAddress, `${name} must be nonzero`);
  return checked;
}

function ecdsaSignature(value: unknown, name: string): Hex {
  requireCondition(
    typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value),
    `${name} must be exactly 65 bytes`,
  );
  return value as Hex;
}

function uint(value: bigint, maximum: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= maximum, `${name} is outside its unsigned range`);
  return value;
}

function positiveUint(value: bigint, maximum: bigint, name: string): bigint {
  const checked = uint(value, maximum, name);
  requireCondition(checked !== 0n, `${name} must be nonzero`);
  return checked;
}

function uint32(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0 && BigInt(value) <= UINT32_MAX, `${name} must be a nonzero uint32`);
  return value;
}

function int128(value: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= INT128_MIN && value <= INT128_MAX, `${name} is outside int128`);
  return value;
}

function identityHash(value: string): Hex {
  return keccak256(stringToHex(value));
}

function exactWad(value: bigint, decimals: number, name: string): bigint {
  const scaled = scaleDecimals(value, decimals, 18, 'TOWARD_ZERO', name);
  requireCondition(scaleDecimals(scaled, 18, decimals, 'TOWARD_ZERO', name) === value, `${name} cannot be represented exactly as wad`);
  return scaled;
}

function routeBinding(routeBindings: readonly RouteAccountBinding[], bindingId: string): RouteAccountBinding {
  const binding = routeBindings.find((candidate) => candidate.routeBindingId === bindingId);
  requireCondition(binding !== undefined, `missing route binding ${bindingId}`);
  return binding;
}

function validateContractIdentity(identity: EvmContractIdentity, name: string): Address {
  codeHash(identity?.expectedCodeHash, `${name}.expectedCodeHash`);
  return requiredAddress(identity?.address, `${name}.address`);
}

function validateManifestResource(
  identity: EvmManifestResourceIdentity,
  expected: AdapterRef | VersionedManifestRef,
  kind: 'adapter' | 'manifest',
  name: string,
): Address {
  const matches = kind === 'adapter'
    ? sameAdapter(expected as AdapterRef, identity)
    : sameManifest(expected as VersionedManifestRef, identity);
  requireCondition(matches, `${name} deployment identity mismatch`);
  uint32(identity.manifestVersion, `${name}.manifestVersion`);
  nonzeroHash(identity.manifestHash, `${name}.manifestHash`);
  return validateContractIdentity(identity, name);
}

function manifestResource(identity: EvmManifestResourceIdentity) {
  return {
    manifest: {
      subjectId: identityHash(identity.subjectId),
      manifestVersion: identity.manifestVersion,
      manifestHash: nonzeroHash(identity.manifestHash, `${identity.subjectId}.manifestHash`),
    },
    localAddress: requiredAddress(identity.address, `${identity.subjectId}.address`),
    expectedCodeHash: codeHash(identity.expectedCodeHash, `${identity.subjectId}.expectedCodeHash`),
  };
}

function validateDomain(admission: PackageAdmission, deployment: EvmDeploymentIdentity): DomainRef {
  const manifest = deployment.domainManifest;
  requireCondition(manifest.runtimeClassId === EVM_RUNTIME_IDENTITY.runtimeClassId, 'runtime class is unsupported');
  requireCondition(manifest.runtimeClassVersion === EVM_RUNTIME_IDENTITY.runtimeClassVersion, 'runtime class version is unsupported');
  requireCondition(manifest.chainNamespace === EVM_RUNTIME_IDENTITY.chainNamespace, 'chain namespace is unsupported');
  requireCondition(manifest.executionVerifierId === EVM_RUNTIME_IDENTITY.executionVerifierId, 'execution verifier is unsupported');
  requireCondition(manifest.clockModelId === EVM_RUNTIME_IDENTITY.clockModelId, 'clock model is unsupported');
  requireCondition(manifest.addressCodecId === EVM_RUNTIME_IDENTITY.addressCodecId, 'address codec is unsupported');
  requireCondition(manifest.supportedSettlementClasses.includes('ATOMIC_POSTCONDITION'), 'domain does not support atomic settlement');
  requireCondition(/^[1-9][0-9]*$/.test(manifest.chainReference), 'domain chain reference must be a positive EIP-155 chain ID');
  const chainReference = BigInt(manifest.chainReference);
  requireCondition(chainReference === deployment.deploymentChainReference, 'deployment chain reference mismatch');
  uint(chainReference, UINT256_MAX, 'deployment.chainReference');

  const domain = domainRefFromManifest(manifest);
  requireCondition(sameDomain(admission.order.domain, domain), 'order domain does not match deployment');
  requireCondition(sameDomain(admission.quote.domain, domain), 'quote domain does not match deployment');
  requireCondition(sameDomain(admission.route.domain, domain), 'route domain does not match deployment');
  requireCondition(sameHash(manifest.executionVerifierCodeHash, hexBytes(deployment.packageVerifier.expectedCodeHash, 'packageVerifier.expectedCodeHash')), 'execution verifier code hash mismatch');
  return domain;
}

function hexBytes(value: unknown, name: string): Uint8Array {
  const checked = codeHash(value, name);
  return Uint8Array.from(Buffer.from(checked.slice(2), 'hex'));
}

function buildEvmAtomicMaterial(
  admission: PackageAdmission,
  deployment: EvmDeploymentIdentity,
  seriesBindingInput: CashCarrySeriesBindingV1Input,
  bounds: EvmAtomicAuthorizationBounds,
) {
  const { order, quote, route } = admission;
  const domain = validateDomain(admission, deployment);
  requireCondition(order.environment === deployment.domainManifest.environment, 'order environment does not match deployment');
  requireCondition(quote.environment === order.environment && route.environment === order.environment, 'package environment mismatch');
  requireCondition(order.direction === 'LONG_SPOT_SHORT_PERP' && route.direction === order.direction, 'direction is unsupported');
  requireCondition(order.settlementClass === 'ATOMIC_POSTCONDITION' && route.settlementClass === 'ATOMIC_POSTCONDITION', 'settlement class is unsupported');
  const settlementClassId = nonzeroHash(deployment.settlementClass.classId, 'settlementClass.classId');
  requireCondition(settlementClassId === ATOMIC_SETTLEMENT_CLASS_ID, 'settlement class identity is unsupported');
  requireCondition(deployment.settlementClass.classVersion === 1, 'settlement class version is unsupported');
  requireCondition(route.executionPlanKind === 'EVM_ATOMIC_BATCH', 'execution plan is unsupported');
  requireCondition(order.partialFillPolicy === 'EXACT_ALL_LEGS' && route.partialFillPolicy === 'EXACT_ALL_LEGS', 'partial fills are unsupported');
  requireCondition(order.expiryUnit === 'EVM_UNIX_SECONDS' && quote.validUntilUnit === 'EVM_UNIX_SECONDS' && route.routeExpiryUnit === 'EVM_UNIX_SECONDS', 'expiry clock is unsupported');
  uint(bounds.currentUnixSeconds, UINT256_MAX, 'currentUnixSeconds');
  requireCondition(bounds.currentUnixSeconds < route.routeExpiryValue, 'route is expired');
  requireCondition(bounds.currentUnixSeconds < quote.validUntilValue, 'quote is expired');
  requireCondition(bounds.currentUnixSeconds < order.expiryValue, 'order is expired');
  requireCondition(route.routeExpiryValue <= quote.validUntilValue && quote.validUntilValue <= order.expiryValue, 'package expiry ordering is invalid');
  requireCondition(sameHash(route.orderHash, admission.orderHash), 'route order hash mismatch');
  requireCondition(sameHash(quote.orderHash, admission.orderHash), 'quote order hash mismatch');
  requireCondition(sameHash(quote.routeHash, admission.routeHash), 'quote route hash mismatch');
  // The quote signature is verified at quote intake; the verifier checks a separate on-chain
  // SolverAuthorization signed by `bounds.solver` over this exact execution.
  requireCondition(quote.solverSignatureScheme === 'ED25519' || quote.solverSignatureScheme === 'SECP256K1_RECOVERABLE', 'solver signature scheme is unsupported');
  requireCondition(quote.quoteMode !== 'FIRM_ONCHAIN', 'onchain firm quotes require the quoted-package compiler');
  requireCondition(route.actions.length === 2 && route.serviceCharges.length === 0, 'route contains unsupported actions or service charges');
  requireCondition(route.actions.every((action) => action.nativeValue === undefined || action.nativeValue.atoms === 0n), 'native-value actions are unsupported');
  requireCondition(bounds.minimumPostPerpBalanceWad <= bounds.maximumPostPerpBalanceWad, 'post-perpetual balance bounds are inverted');

  validateContractIdentity(deployment.strategyAccountFactory, 'strategyAccountFactory');
  codeHash(deployment.strategyAccountCodeHash, 'strategyAccountCodeHash');
  const packageVerifier = validateContractIdentity(deployment.packageVerifier, 'packageVerifier');
  const strategyAccount = requiredAddress(bounds.strategyAccount, 'bounds.strategyAccount');
  requireCondition(requiredAddress(order.settlementAccount, 'order.settlementAccount') === strategyAccount, 'settlement account is not the owner factory account');
  requireCondition(requiredAddress(route.settlementAccount, 'route.settlementAccount') === strategyAccount, 'route settlement account is not the owner factory account');
  const solver = requiredAddress(bounds.solver, 'bounds.solver');

  requireCondition(route.legs.length === 2, 'route must contain exactly two legs');
  const spotLeg = route.legs.find((leg) => leg.legRole === 'SPOT');
  const perpLeg = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
  requireCondition(spotLeg !== undefined && perpLeg !== undefined, 'route must contain spot and perpetual legs');
  requireCondition(spotLeg.quantity.atoms === order.quantity.atoms && perpLeg.quantity.atoms === order.quantity.atoms, 'leg quantity mismatch');
  requireCondition(spotLeg.side === (order.action === 'ENTRY' ? 'BUY' : 'SELL'), 'spot side mismatch');
  requireCondition(perpLeg.side === (order.action === 'ENTRY' ? 'SELL' : 'BUY'), 'perpetual side mismatch');
  requireCondition(sameAsset(spotLeg.baseAsset, deployment.baseAsset) && sameAsset(perpLeg.baseAsset, deployment.baseAsset), 'base asset deployment identity mismatch');
  requireCondition(sameAsset(spotLeg.quoteAsset, deployment.quoteAsset) && sameAsset(perpLeg.quoteAsset, deployment.quoteAsset), 'quote asset deployment identity mismatch');
  requireCondition(sameAsset(order.quantity.asset, deployment.baseAsset), 'order quantity asset mismatch');
  requireCondition(sameAsset(quote.expectedSpotNotional.asset, deployment.quoteAsset), 'package notional asset mismatch');
  requireCondition(deployment.baseAsset.decimals === spotLeg.baseAsset.decimals && deployment.quoteAsset.decimals === spotLeg.quoteAsset.decimals, 'asset decimals mismatch');

  const spotPort = validateManifestResource(deployment.spot.adapter, spotLeg.adapter, 'adapter', 'spot.adapter');
  validateManifestResource(deployment.spot.market, spotLeg.market, 'manifest', 'spot.market');
  validateManifestResource(deployment.spot.venue, spotLeg.venue, 'manifest', 'spot.venue');
  // The verifier is the perpetual port: it admits only a perpetual adapter at its own address, trades
  // the market record as the instrument, and observes positions through the venue record.
  const perpPort = validateManifestResource(deployment.perpetual.adapter, perpLeg.adapter, 'adapter', 'perpetual.adapter');
  requireCondition(perpPort === packageVerifier, 'perpetual adapter must be the package verifier');
  const perpInstrument = validateManifestResource(deployment.perpetual.market, perpLeg.market, 'manifest', 'perpetual.market');
  const perpVenue = validateManifestResource(deployment.perpetual.venue, perpLeg.venue, 'manifest', 'perpetual.venue');
  const perpObserver = validateContractIdentity(deployment.perpetualObserver, 'perpetualObserver');
  requireCondition(perpObserver === perpVenue, 'perpetual observer must be the perpetual venue');
  const baseToken = validateContractIdentity(deployment.baseAsset, 'baseAsset');
  const quoteToken = validateContractIdentity(deployment.quoteAsset, 'quoteAsset');
  uint32(deployment.baseAsset.manifestVersion, 'baseAsset.manifestVersion');
  uint32(deployment.quoteAsset.manifestVersion, 'quoteAsset.manifestVersion');
  nonzeroHash(deployment.baseAsset.manifestHash, 'baseAsset.manifestHash');
  nonzeroHash(deployment.quoteAsset.manifestHash, 'quoteAsset.manifestHash');

  for (const [leg, expectedTarget] of [[spotLeg, spotPort], [perpLeg, perpInstrument]] as const) {
    const action = route.actions[leg.actionSequence];
    requireCondition(action !== undefined && action.adapter !== undefined && sameAdapter(action.adapter, leg.legRole === 'SPOT' ? deployment.spot.adapter : deployment.perpetual.adapter), `${leg.legRole.toLowerCase()} action adapter mismatch`);
    requireCondition(requiredAddress(routeBinding(route.accountBindings, action.targetBindingId).accountIdentity, `${leg.legRole.toLowerCase()} action target`) === expectedTarget, `${leg.legRole.toLowerCase()} action target mismatch`);
    requireCondition(requiredAddress(routeBinding(route.accountBindings, action.authorityBindingId).accountIdentity, `${leg.legRole.toLowerCase()} action authority`) === strategyAccount, `${leg.legRole.toLowerCase()} action authority mismatch`);
  }

  const deadline = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((left, right) => left < right ? left : right);
  const baseQuantityAtoms = positiveUint(order.quantity.atoms, UINT256_MAX, 'baseQuantityAtoms');
  const perpQuantityWad = positiveUint(exactWad(perpLeg.quantity.atoms, perpLeg.quantity.asset.decimals, 'perpQuantityWad'), UINT256_MAX, 'perpQuantityWad');
  const expectedPrePerpSizeWad = int128(exactWad(order.expectedPrePositionSize.atoms, order.expectedPrePositionSize.asset.decimals, 'expectedPrePerpSizeWad'), 'expectedPrePerpSizeWad');
  const expectedPrePerpEntryNotionalWad = uint(bounds.expectedPrePerpEntryNotionalWad, UINT128_MAX, 'expectedPrePerpEntryNotionalWad');
  requireCondition(
    order.action === 'EXIT' || expectedPrePerpEntryNotionalWad === 0n,
    'entry requires a zero pre-position entry notional',
  );
  requireCondition(
    scaleDecimals(expectedPrePerpEntryNotionalWad, 18, order.expectedPrePositionEntryNotional.asset.decimals, 'FLOOR', 'expectedPrePerpEntryNotionalWad') === order.expectedPrePositionEntryNotional.atoms,
    'pre-position entry notional does not match the order',
  );
  const expectedPostPerpSizeWad = int128(expectedPrePerpSizeWad + (order.action === 'ENTRY' ? -perpQuantityWad : perpQuantityWad), 'expectedPostPerpSizeWad');
  const spotQuoteBound = order.action === 'ENTRY' ? order.maxSpotQuoteIn : order.minSpotQuoteOut;
  requireCondition(spotQuoteBound !== undefined && sameAsset(spotQuoteBound.asset, deployment.quoteAsset), 'spot quote bound is missing or uses the wrong asset');
  const action = enumDiscriminant(PACKAGE_ACTION, order.action, 'order.action');
  const seriesBinding = validateSeriesBinding(
    seriesBindingInput,
    order.action,
    domain,
    deployment,
    order.templateId,
    order.templateVersion,
    order.packageTemplateManifestHash,
  );
  const packageSizeUnits = derivePackageSizeUnits(baseQuantityAtoms, perpQuantityWad, seriesBinding);
  const seriesIdentityKey = cashCarrySeriesIdentityKey(seriesBinding);
  const seriesBindingHash = cashCarrySeriesBindingV1Hash(seriesBinding);
  const spotLimit = mulDiv(spotLeg.limitPrice.quoteAtoms, positiveUint(deployment.spot.baseLotAtoms, UINT256_MAX, 'spot.baseLotAtoms'), spotLeg.limitPrice.baseAtoms, spotLeg.limitPrice.roundingDirection, 'spot.limitQuoteAtomsPerBaseLot');
  const perpLimit = mulDiv(perpLeg.limitPrice.quoteAtoms, positiveUint(deployment.perpetual.baseLotAtoms, UINT256_MAX, 'perpetual.baseLotAtoms'), perpLeg.limitPrice.baseAtoms, perpLeg.limitPrice.roundingDirection, 'perpetual.limitQuoteAtomsPerBaseLot');
  // ResourceRegistry.validateCashCarry admits exactly the larger leg limit notional, lots times limit.
  requireCondition(
    spotLeg.quantity.atoms % deployment.spot.baseLotAtoms === 0n && perpLeg.quantity.atoms % deployment.perpetual.baseLotAtoms === 0n,
    'leg quantity is not a whole number of base lots',
  );
  const spotLimitNotional = (spotLeg.quantity.atoms / deployment.spot.baseLotAtoms) * spotLimit;
  const perpLimitNotional = (perpLeg.quantity.atoms / deployment.perpetual.baseLotAtoms) * perpLimit;
  const packageNotionalQuoteAtoms = positiveUint(
    spotLimitNotional > perpLimitNotional ? spotLimitNotional : perpLimitNotional,
    UINT256_MAX,
    'packageNotionalQuoteAtoms',
  );

  const execution = {
    domainIdHash: identityHash(domain.domainId),
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: nonzeroHash(domain.domainManifestHash, 'domainManifestHash'),
    orderHash: nonzeroHash(admission.orderHash, 'orderHash'),
    quoteHash: nonzeroHash(admission.quoteHash, 'quoteHash'),
    routeHash: nonzeroHash(admission.routeHash, 'routeHash'),
    spotFillCommitment: nonzeroHash(bounds.spotFillCommitment, 'spotFillCommitment'),
    packageQuoteIntentHash: zeroHash,
    seriesIdentityKey: nonzeroHash(seriesIdentityKey, 'seriesIdentityKey'),
    seriesBindingVersion: seriesBinding.bindingVersion,
    seriesBindingHash: nonzeroHash(seriesBindingHash, 'seriesBindingHash'),
    action,
    strategyAccount,
    solver,
    spotPort,
    perpObserver,
    perpInstrument,
    perpExpiry: uint32(bounds.perpExpiry, 'perpExpiry'),
    baseToken,
    quoteToken,
    baseQuantityAtoms,
    perpQuantityWad,
    spotQuoteBoundAtoms: uint(spotQuoteBound.atoms, UINT256_MAX, 'spotQuoteBoundAtoms'),
    packageNotionalQuoteAtoms,
    packageSizeUnits,
    expectedPrePerpBalanceWad: int128(bounds.expectedPrePerpBalanceWad, 'expectedPrePerpBalanceWad'),
    expectedPrePerpSizeWad,
    expectedPrePerpEntryNotionalWad,
    expectedPostPerpSizeWad,
    minimumPostPerpBalanceWad: int128(bounds.minimumPostPerpBalanceWad, 'minimumPostPerpBalanceWad'),
    maximumPostPerpBalanceWad: int128(bounds.maximumPostPerpBalanceWad, 'maximumPostPerpBalanceWad'),
    maximumPostPerpEntryNotionalWad: uint(bounds.maximumPostPerpEntryNotionalWad, UINT128_MAX, 'maximumPostPerpEntryNotionalWad'),
    entryReceiptHash: optionalHash(order.entryReceiptHash, 'entryReceiptHash'),
    nonce: uint(bounds.packageNonce, UINT256_MAX, 'packageNonce'),
    deadline: uint(deadline, UINT256_MAX, 'deadline'),
  };

  const resourceAdmission = {
    domain: {
      domainIdHash: identityHash(domain.domainId),
      manifestVersion: domain.domainManifestVersion,
      manifestHash: nonzeroHash(domain.domainManifestHash, 'domainManifestHash'),
    },
    template: {
      templateId: identityHash(order.templateId),
      templateVersion: uint32(order.templateVersion, 'templateVersion'),
      templateManifestHash: nonzeroHash(order.packageTemplateManifestHash, 'packageTemplateManifestHash'),
    },
    settlementClass: {
      classId: settlementClassId,
      classVersion: deployment.settlementClass.classVersion,
    },
    spot: {
      adapter: manifestResource(deployment.spot.adapter),
      adapterClassId: identityHash(deployment.spot.adapterClassId),
      adapterClassVersion: uint32(deployment.spot.adapterClassVersion, 'spot.adapterClassVersion'),
      market: manifestResource(deployment.spot.market),
      venue: manifestResource(deployment.spot.venue),
      quantityAtoms: uint(spotLeg.quantity.atoms, UINT256_MAX, 'spot.quantityAtoms'),
      limitQuoteAtomsPerBaseLot: uint(spotLimit, UINT256_MAX, 'spot.limitQuoteAtomsPerBaseLot'),
    },
    perpetual: {
      adapter: manifestResource(deployment.perpetual.adapter),
      adapterClassId: identityHash(deployment.perpetual.adapterClassId),
      adapterClassVersion: uint32(deployment.perpetual.adapterClassVersion, 'perpetual.adapterClassVersion'),
      market: manifestResource(deployment.perpetual.market),
      venue: manifestResource(deployment.perpetual.venue),
      quantityAtoms: uint(perpLeg.quantity.atoms, UINT256_MAX, 'perpetual.quantityAtoms'),
      limitQuoteAtomsPerBaseLot: uint(perpLimit, UINT256_MAX, 'perpetual.limitQuoteAtomsPerBaseLot'),
    },
    baseAsset: {
      ...manifestResource(deployment.baseAsset),
      decimals: deployment.baseAsset.decimals,
    },
    quoteAsset: {
      ...manifestResource(deployment.quoteAsset),
      decimals: deployment.quoteAsset.decimals,
    },
    action,
    packageNotionalQuoteAtoms,
  };

  return {
    domain,
    execution,
    resourceAdmission,
    strategyAccount,
    perpArgs: [
      nonzeroHash(bounds.perpArgs[0], 'perpArgs[0]'),
      nonzeroHash(bounds.perpArgs[1], 'perpArgs[1]'),
    ] as const,
  };
}

function packageAuthorizationMessage(
  admission: PackageAdmission,
  deployment: EvmDeploymentIdentity,
  seriesBindingInput: CashCarrySeriesBindingV1Input,
  bounds: EvmAtomicAuthorizationBounds,
) {
  const material = buildEvmAtomicMaterial(admission, deployment, seriesBindingInput, bounds);
  const execution = material.execution;
  const admissionHash = keccak256(encodeAbiParameters(
    [{ type: 'tuple', components: EVM_CASH_CARRY_ADMISSION_COMPONENTS }],
    [material.resourceAdmission],
  ));
  const packageIdentityHash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' },
      { type: 'uint8' },
    ],
    [
      execution.domainIdHash, execution.domainManifestVersion, execution.domainManifestHash,
      execution.orderHash, execution.quoteHash, execution.routeHash, execution.spotFillCommitment,
      execution.packageQuoteIntentHash, execution.seriesIdentityKey, execution.seriesBindingVersion,
      execution.seriesBindingHash, admissionHash, execution.action,
    ],
  ));
  const packageEconomicsHash = keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }],
    [execution.baseQuantityAtoms, execution.perpQuantityWad, execution.packageSizeUnits, execution.entryReceiptHash],
  ));
  const packageHash = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }],
    [packageIdentityHash, packageEconomicsHash],
  ));
  const accountsHash = keccak256(encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'address' }, { type: 'uint32' }, { type: 'address' }, { type: 'address' },
      { type: 'uint256' },
    ],
    [
      execution.strategyAccount, execution.solver, execution.spotPort, execution.perpObserver,
      execution.perpInstrument, execution.perpExpiry, execution.baseToken, execution.quoteToken,
      deployment.deploymentChainReference,
    ],
  ));
  const limitsHash = keccak256(encodeAbiParameters(
    [
      { type: 'uint256' }, { type: 'uint256' }, { type: 'int128' }, { type: 'int128' },
      { type: 'uint128' }, { type: 'int128' }, { type: 'int128' }, { type: 'int128' },
      { type: 'uint128' },
    ],
    [
      execution.spotQuoteBoundAtoms, execution.packageNotionalQuoteAtoms,
      execution.expectedPrePerpBalanceWad, execution.expectedPrePerpSizeWad,
      execution.expectedPrePerpEntryNotionalWad, execution.expectedPostPerpSizeWad,
      execution.minimumPostPerpBalanceWad, execution.maximumPostPerpBalanceWad,
      execution.maximumPostPerpEntryNotionalWad,
    ],
  ));
  const domain = Object.freeze({
    ...EVM_TRADER_PERMIT_DOMAIN,
    chainId: deployment.deploymentChainReference,
    verifyingContract: validateContractIdentity(deployment.packageVerifier, 'packageVerifier'),
  });
  const message = Object.freeze({
    packageHash,
    accountsHash,
    limitsHash,
    nonce: execution.nonce,
    deadline: execution.deadline,
  });
  return { domain, message };
}

const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * The one ECDSA form the contracts accept (OpenZeppelin ECDSA): 65 bytes, s in the lower half of
 * the curve order, and v of 27 or 28. Off-chain checks require it so a signature they accept is never
 * one the verifier, coordinator, or exit controller then rejects after the owner has paid.
 */
export function isCanonicalEvmSignature(signature: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return (v === 27 || v === 28) && s > 0n && s <= SECP256K1_HALF_ORDER;
}

export function prepareEvmTraderPermitAuthorization(
  admission: PackageAdmission,
  deployment: EvmDeploymentIdentity,
  seriesBindingInput: CashCarrySeriesBindingV1Input,
  bounds: EvmAtomicAuthorizationBounds,
): EvmTraderPermitAuthorization {
  const { domain, message } = packageAuthorizationMessage(admission, deployment, seriesBindingInput, bounds);
  return Object.freeze({
    domain,
    types: EVM_TRADER_PERMIT_TYPES,
    primaryType: 'TraderPermit' as const,
    message,
    digest: hashTypedData({ domain, types: EVM_TRADER_PERMIT_TYPES, primaryType: 'TraderPermit', message }),
  });
}

/** The SolverAuthorization the verifier recovers to `bounds.solver` over the same execution. */
export function prepareEvmSolverAuthorization(
  admission: PackageAdmission,
  deployment: EvmDeploymentIdentity,
  seriesBindingInput: CashCarrySeriesBindingV1Input,
  bounds: EvmAtomicAuthorizationBounds,
): EvmSolverAuthorization {
  const { domain, message } = packageAuthorizationMessage(admission, deployment, seriesBindingInput, bounds);
  return Object.freeze({
    domain,
    types: EVM_SOLVER_AUTHORIZATION_TYPES,
    primaryType: 'SolverAuthorization' as const,
    message,
    digest: hashTypedData({
      domain,
      types: EVM_SOLVER_AUTHORIZATION_TYPES,
      primaryType: 'SolverAuthorization',
      message,
    }),
  });
}

export function compileEvmAtomicPackage(
  admission: PackageAdmission,
  deployment: EvmDeploymentIdentity,
  seriesBindingInput: CashCarrySeriesBindingV1Input,
  bounds: EvmAtomicExecutionBounds,
): CompiledEvmAtomicPackage {
  const material = buildEvmAtomicMaterial(admission, deployment, seriesBindingInput, bounds);
  const traderSignature = ecdsaSignature(bounds.traderSignature, 'trader signature');
  const solverSignature = ecdsaSignature(bounds.solverSignature, 'solver signature');
  const data = encodeFunctionData({
    abi: NARYX_STRATEGY_ACCOUNT_ABI,
    functionName: 'executePackage',
    args: [
      material.execution,
      material.resourceAdmission,
      traderSignature,
      solverSignature,
      material.perpArgs,
    ],
  });

  return {
    domain: material.domain,
    orderHash: admission.orderHash,
    quoteHash: admission.quoteHash,
    routeHash: admission.routeHash,
    payload: {
      chainReference: deployment.deploymentChainReference,
      to: material.strategyAccount,
      value: 0n,
      data,
    },
  };
}

export { NARYX_STRATEGY_ACCOUNT_ABI } from './abi.js';
export { ATOMIC_PACKAGE_EXECUTOR_ABI } from './abi.js';
export type {
  EvmLocalAtomicBinding,
  EvmLocalAtomicBounds,
  EvmLocalAtomicExecution,
  EvmLocalAtomicPayload,
} from './localConformance.js';
export { compileEvmLocalAtomicExecution } from './localConformance.js';
export {
  ASYNC_COORDINATOR_OBSERVATION_ABI,
  GMX_ENTRY_ADAPTER_OBSERVATION_ABI,
  GMX_EXIT_CONTROLLER_OBSERVATION_ABI,
  GMX_V2_READER_ABI,
  PACKAGE_VERIFIER_OBSERVATION_ABI,
} from './abi.js';
export type {
  EvmChainHead,
  EvmContractRead,
  EvmEvidenceGrade,
  EvmFinalityPolicy,
  EvmObservedLog,
  EvmObservedReceipt,
  EvmReadPort,
} from './readPort.js';
export {
  chainReference,
  equalAddress,
  equalHash,
  hash32,
  requiredEvmAddress,
  safeCount,
  structField,
  validateFinalityPolicy,
} from './readPort.js';
export type {
  EvmAtomicLifecycle,
  EvmAtomicObservation,
  EvmAtomicObservationBinding,
  EvmAtomicOpenPackage,
  EvmAtomicPackageReceipt,
} from './atomicObservation.js';
export { observeEvmAtomicPackage } from './atomicObservation.js';
export type {
  EvmAsyncBondedObservation,
  EvmAsyncCoordinatorView,
  EvmAsyncEntryView,
  EvmAsyncExitView,
  EvmAsyncFinalReceiptView,
  EvmAsyncLifecycle,
  EvmAsyncObservationBinding,
  EvmAsyncObservationKeys,
} from './asyncObservation.js';
export { COORDINATOR_STATE_LABELS, VENUE_STATUS_LABELS, observeAsyncBondedPackage } from './asyncObservation.js';
export type {
  EvmDeploymentActivationState,
  EvmDeploymentAuthorityBinding,
  EvmDeploymentAuthorityPolicy,
  EvmDeploymentAuthorityReadPort,
  EvmDeploymentAuthorityRole,
  EvmDeploymentCapPolicy,
  EvmDeploymentShapePolicy,
  EvmObservedDeploymentAuthorityEvidence,
  QualifiedEvmDeploymentAuthority,
} from './authorityQualification.js';
export { EVM_DEPLOYMENT_AUTHORITY_ROLES, qualifyEvmDeploymentAuthority } from './authorityQualification.js';
export type {
  PackageVerifierOpenPackage,
  TestPerpCloseSettlement,
  TestPerpEntryLimits,
  TestPerpMarketParameters,
  TestPerpPositionState,
} from './testPerpMarket.js';
export {
  CHAINLINK_AGGREGATOR_ABI,
  ERC20_ABI,
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
  NARYX_STRATEGY_ACCOUNT_OWNER_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  UNISWAP_V3_POOL_ABI,
  deriveTestPerpEntryLimits,
  encodeTestPerpTradeArgs,
  packageVerifierOpenPackage,
  testPerpCloseSettlement,
  testPerpFeeWad,
} from './testPerpMarket.js';

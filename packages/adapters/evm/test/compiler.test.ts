import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  adapterRef,
  assetRef,
  cashCarrySeriesBindingV1Hash,
  cashCarrySeriesIdentityKey,
  domainManifest,
  domainRefFromManifest,
  toHex,
  versionedManifestRef,
  type CashCarrySeriesBindingV1Input,
  type DomainManifest,
  type Hash32,
  type PackageAdmission,
} from '@naryx/protocol-types';
import {
  decodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  getAbiItem,
  keccak256,
  stringToHex,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import {
  compileEvmAtomicPackage,
  EVM_RUNTIME_IDENTITY,
  NARYX_STRATEGY_ACCOUNT_ABI,
  prepareEvmTraderPermitAuthorization,
  type EvmAtomicExecutionBounds,
  type EvmDeploymentIdentity,
  type EvmManifestResourceIdentity,
} from '../src/index.js';
import { EVM_CASH_CARRY_ADMISSION_COMPONENTS } from '../src/abi.js';

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const hashHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
const signatureHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(65)}`;
const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const atomicSettlementClassId = Uint8Array.from(
  Buffer.from(keccak256(stringToHex('ATOMIC_POSTCONDITION')).slice(2), 'hex'),
) as Hash32;
const hashHexBytes = (value: Hex): Hash32 => Uint8Array.from(Buffer.from(value.slice(2), 'hex')) as Hash32;

const strategyAccount = address(1);
const spotPort = address(2);
const perpInstrument = address(3);
const perpObserver = address(4);
const accountFactory = address(14);
const baseToken = address(5);
const quoteToken = address(6);
const packageVerifier = address(7);
const solver = address(8);

const baseAsset = assetRef('eth', hash(20), 18);
const quoteAsset = assetRef('usdc', hash(21), 6);
const spotAdapter = adapterRef({
  adapterId: 'uniswap-v3-spot-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: hash(22),
});
const perpAdapter = adapterRef({
  adapterId: 'synfutures-perp-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: hash(23),
});
const spotMarket = versionedManifestRef('eth-usdc-spot', 1, hash(24));
const perpMarket = versionedManifestRef('eth-usdc-perp', 1, hash(25));
const spotVenue = versionedManifestRef('uniswap-v3', 1, hash(26));
const perpVenue = versionedManifestRef('synfutures', 1, hash(27));

function manifest(domainId: string, chainReference: bigint, manifestVersion = 1): DomainManifest {
  return domainManifest({
    manifestVersion,
    environment: 'testnet',
    domainId,
    runtimeClassId: EVM_RUNTIME_IDENTITY.runtimeClassId,
    runtimeClassVersion: EVM_RUNTIME_IDENTITY.runtimeClassVersion,
    chainNamespace: EVM_RUNTIME_IDENTITY.chainNamespace,
    chainReference: chainReference.toString(),
    executionVerifierId: EVM_RUNTIME_IDENTITY.executionVerifierId,
    executionVerifierCodeHash: hash(70),
    clockModelId: EVM_RUNTIME_IDENTITY.clockModelId,
    finalityPolicyHash: hash(71),
    addressCodecId: EVM_RUNTIME_IDENTITY.addressCodecId,
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  });
}

test('prepares the PackageVerifier TraderPermit typed data from the unsigned execution', () => {
  const domain = manifest('eip155:84532', 84_532n);
  const admitted = admission(domain);
  const identity = deployment(domain, 84_532n);
  const authorization = prepareEvmTraderPermitAuthorization(
    admitted,
    identity,
    seriesBinding(domain),
    bounds,
  );
  const compiled = compileEvmAtomicPackage(admitted, identity, seriesBinding(domain), bounds);
  const decoded = decodeFunctionData({ abi: NARYX_STRATEGY_ACCOUNT_ABI, data: compiled.payload.data });
  const execution = decoded.args?.[0] as {
    domainIdHash: Hex; domainManifestVersion: number; domainManifestHash: Hex;
    orderHash: Hex; quoteHash: Hex; routeHash: Hex; spotFillCommitment: Hex;
    packageQuoteIntentHash: Hex; seriesIdentityKey: Hex; seriesBindingVersion: number;
    seriesBindingHash: Hex; action: number; strategyAccount: Address; solver: Address;
    spotPort: Address; perpObserver: Address; perpInstrument: Address; perpExpiry: number;
    baseToken: Address; quoteToken: Address; baseQuantityAtoms: bigint; perpQuantityWad: bigint;
    packageSizeUnits: bigint; entryReceiptHash: Hex; spotQuoteBoundAtoms: bigint;
    packageNotionalQuoteAtoms: bigint; expectedPrePerpBalanceWad: bigint;
    expectedPrePerpSizeWad: bigint; expectedPrePerpEntryNotionalWad: bigint;
    expectedPostPerpSizeWad: bigint; minimumPostPerpBalanceWad: bigint;
    maximumPostPerpBalanceWad: bigint; maximumPostPerpEntryNotionalWad: bigint;
    nonce: bigint; deadline: bigint;
  };
  const resourceAdmission = decoded.args?.[1];
  const admissionHash = keccak256(encodeAbiParameters(
    [{ type: 'tuple', components: EVM_CASH_CARRY_ADMISSION_COMPONENTS }],
    [resourceAdmission as never],
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
      execution.perpInstrument, execution.perpExpiry, execution.baseToken, execution.quoteToken, 84_532n,
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

  assert.deepEqual(authorization.domain, {
    name: 'Naryx Package Verifier',
    version: '1',
    chainId: 84_532n,
    verifyingContract: packageVerifier,
  });
  assert.equal(authorization.primaryType, 'TraderPermit');
  assert.deepEqual(authorization.message, {
    packageHash,
    accountsHash,
    limitsHash,
    nonce: execution.nonce,
    deadline: execution.deadline,
  });
  assert.equal(authorization.message.nonce, execution.nonce);
  assert.equal(authorization.message.deadline, execution.deadline);
  assert.equal(authorization.digest, hashTypedData({
    domain: authorization.domain,
    types: authorization.types,
    primaryType: authorization.primaryType,
    message: authorization.message,
  }));
});

function exitAdmission(
  domainManifest: DomainManifest,
  currentBaseAsset: typeof baseAsset,
  currentQuoteAsset: typeof quoteAsset,
): PackageAdmission {
  const value = admission(domainManifest);
  const quantity = value.order.quantity.atoms;
  return {
    ...value,
    order: {
      ...value.order,
      action: 'EXIT',
      entryReceiptHash: hash(91),
      quantity: { asset: currentBaseAsset, atoms: quantity },
      expectedPrePositionSize: { asset: currentBaseAsset, atoms: -quantity },
      expectedPrePositionEntryNotional: { asset: currentQuoteAsset, atoms: 5_000_000_000n },
      maxSpotQuoteIn: undefined,
      minSpotQuoteOut: { asset: currentQuoteAsset, atoms: 5_500_000_000n },
    },
    quote: {
      ...value.quote,
      expectedSpotNotional: { asset: currentQuoteAsset, atoms: 6_000_000_000n },
    },
    route: {
      ...value.route,
      action: 'EXIT',
      legs: value.route.legs.map((leg) => ({
        ...leg,
        baseAsset: currentBaseAsset,
        quoteAsset: currentQuoteAsset,
        side: leg.legRole === 'SPOT' ? 'SELL' : 'BUY',
        quantity: { asset: currentBaseAsset, atoms: quantity },
        limitPrice: {
          ...leg.limitPrice,
          baseAsset: currentBaseAsset,
          quoteAsset: currentQuoteAsset,
        },
      })),
    },
  } as unknown as PackageAdmission;
}

function resource(
  subjectId: string,
  manifestVersion: number,
  manifestHash: Hash32,
  localAddress: Address,
  codeHashByte: number,
): EvmManifestResourceIdentity {
  return {
    subjectId,
    manifestVersion,
    manifestHash,
    address: localAddress,
    expectedCodeHash: hashHex(codeHashByte),
  };
}

function deployment(domainManifest: DomainManifest, chainReference: bigint): EvmDeploymentIdentity {
  return {
    domainManifest,
    deploymentChainReference: chainReference,
    strategyAccountFactory: { address: accountFactory, expectedCodeHash: hashHex(39) },
    strategyAccountCodeHash: hashHex(40),
    packageVerifier: { address: packageVerifier, expectedCodeHash: hashHex(70) },
    settlementClass: { classId: atomicSettlementClassId, classVersion: 1 },
    spot: {
      adapter: resource(spotAdapter.adapterId, spotAdapter.adapterManifestVersion, spotAdapter.adapterManifestHash, spotPort, 42),
      adapterClassId: 'exact-spot-port',
      adapterClassVersion: 1,
      market: resource(spotMarket.subjectId, spotMarket.manifestVersion, spotMarket.manifestHash, address(9), 43),
      venue: resource(spotVenue.subjectId, spotVenue.manifestVersion, spotVenue.manifestHash, address(10), 44),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetual: {
      adapter: resource(perpAdapter.adapterId, perpAdapter.adapterManifestVersion, perpAdapter.adapterManifestHash, packageVerifier, 70),
      adapterClassId: 'base-strategy-perp-port-v1',
      adapterClassVersion: 1,
      market: resource(perpMarket.subjectId, perpMarket.manifestVersion, perpMarket.manifestHash, perpInstrument, 46),
      venue: resource(perpVenue.subjectId, perpVenue.manifestVersion, perpVenue.manifestHash, perpObserver, 46),
      baseLotAtoms: 1_000_000_000_000_000n,
    },
    perpetualObserver: { address: perpObserver, expectedCodeHash: hashHex(48) },
    baseAsset: {
      ...resource(baseAsset.assetId, 1, baseAsset.assetManifestHash, baseToken, 49),
      decimals: baseAsset.decimals,
    },
    quoteAsset: {
      ...resource(quoteAsset.assetId, 1, quoteAsset.assetManifestHash, quoteToken, 50),
      decimals: quoteAsset.decimals,
    },
  };
}

function seriesBinding(
  domainManifest: DomainManifest,
  overrides: Partial<CashCarrySeriesBindingV1Input> = {},
): CashCarrySeriesBindingV1Input {
  return {
    schemaVersion: 1,
    bindingVersion: 1,
    domain: domainRefFromManifest(domainManifest),
    seriesManifestHash: hash(81),
    executionClassManifestHash: hash(82),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: hash(54),
    settlementClass: 'ATOMIC_POSTCONDITION',
    settlementClassVersion: 1,
    baseAsset: {
      subjectIdentity: hashHexBytes(keccak256(stringToHex(baseAsset.assetId))),
      manifestVersion: 1,
      manifestHash: baseAsset.assetManifestHash,
    },
    quoteAsset: {
      subjectIdentity: hashHexBytes(keccak256(stringToHex(quoteAsset.assetId))),
      manifestVersion: 1,
      manifestHash: quoteAsset.assetManifestHash,
    },
    quoteConvention: 'annualized-net-yield-v1',
    entrySide: 'ASK',
    spotBaseAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
    perpQuantityAtomsPerPackageUnit: 1_000_000_000_000_000_000n,
    ...overrides,
  };
}

function admission(domainManifest: DomainManifest): PackageAdmission {
  const domain = domainRefFromManifest(domainManifest);
  const orderHash = hash(51);
  const routeHash = hash(52);
  const quoteHash = hash(53);
  const quantity = 2_000_000_000_000_000_000n;
  return {
    orderHash,
    routeHash,
    quoteHash,
    order: {
      environment: 'testnet',
      domain,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: hash(54),
      owner: address(13),
      settlementAccount: strategyAccount,
      nonce: 9n,
      expiryUnit: 'EVM_UNIX_SECONDS',
      expiryValue: 3_000n,
      direction: 'LONG_SPOT_SHORT_PERP',
      action: 'ENTRY',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      quantity: { asset: baseAsset, atoms: quantity },
      expectedPrePositionSize: { asset: baseAsset, atoms: 0n },
      expectedPrePositionEntryNotional: { asset: quoteAsset, atoms: 0n },
      maxSpotQuoteIn: { asset: quoteAsset, atoms: 7_000_000_000n },
      settlementClass: 'ATOMIC_POSTCONDITION',
    },
    quote: {
      environment: 'testnet',
      domain,
      orderHash,
      routeHash,
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: new Uint8Array(32).fill(3),
      expectedSpotNotional: { asset: quoteAsset, atoms: 6_000_000_000n },
      validUntilUnit: 'EVM_UNIX_SECONDS',
      validUntilValue: 2_500n,
      signature: new Uint8Array(64).fill(1),
    },
    route: {
      environment: 'testnet',
      domain,
      orderHash,
      settlementAccount: strategyAccount,
      direction: 'LONG_SPOT_SHORT_PERP',
      action: 'ENTRY',
      partialFillPolicy: 'EXACT_ALL_LEGS',
      settlementClass: 'ATOMIC_POSTCONDITION',
      executionPlanKind: 'EVM_ATOMIC_BATCH',
      routeExpiryUnit: 'EVM_UNIX_SECONDS',
      routeExpiryValue: 2_000n,
      accountBindings: [
        { routeBindingId: 'strategy-account', accountIdentity: strategyAccount },
        { routeBindingId: 'spot-port', accountIdentity: spotPort },
        { routeBindingId: 'perp-instrument', accountIdentity: perpInstrument },
      ],
      serviceCharges: [],
      legs: [
        {
          legIndex: 0,
          legRole: 'SPOT',
          actionSequence: 0,
          adapter: spotAdapter,
          venue: spotVenue,
          market: spotMarket,
          baseAsset,
          quoteAsset,
          side: 'BUY',
          quantity: { asset: baseAsset, atoms: quantity },
          limitPrice: { baseAsset, quoteAsset, quoteAtoms: 3_000_000n, baseAtoms: 1_000_000_000_000_000_000n, roundingDirection: 'CEIL' },
        },
        {
          legIndex: 1,
          legRole: 'PERPETUAL',
          actionSequence: 1,
          adapter: perpAdapter,
          venue: perpVenue,
          market: perpMarket,
          baseAsset,
          quoteAsset,
          side: 'SELL',
          quantity: { asset: baseAsset, atoms: quantity },
          limitPrice: { baseAsset, quoteAsset, quoteAtoms: 2_900_000n, baseAtoms: 1_000_000_000_000_000_000n, roundingDirection: 'FLOOR' },
        },
      ],
      actions: [
        {
          sequence: 0,
          adapter: spotAdapter,
          targetBindingId: 'spot-port',
          authorityBindingId: 'strategy-account',
        },
        {
          sequence: 1,
          adapter: perpAdapter,
          targetBindingId: 'perp-instrument',
          authorityBindingId: 'strategy-account',
        },
      ],
    },
  } as unknown as PackageAdmission;
}

const bounds: EvmAtomicExecutionBounds = {
  currentUnixSeconds: 1_000n,
  strategyAccount,
  solver,
  traderSignature: signatureHex(9),
  solverSignature: signatureHex(10),
  spotFillCommitment: hash(55),
  packageNonce: 3n,
  expectedPrePerpEntryNotionalWad: 0n,
  expectedPrePerpBalanceWad: 10n,
  minimumPostPerpBalanceWad: 0n,
  maximumPostPerpBalanceWad: 100n,
  maximumPostPerpEntryNotionalWad: 7_000_000_000_000_000_000_000n,
  perpExpiry: 1_900_000_000,
  perpArgs: [hash(56), hash(57)],
};

function decodedExecution(data: Hex): Record<string, unknown> {
  const decoded = decodeFunctionData({ abi: NARYX_STRATEGY_ACCOUNT_ABI, data });
  assert.equal(decoded.functionName, 'executePackage');
  return decoded.args?.[0] as Record<string, unknown>;
}

test('matches the published strategy account executePackage selector', () => {
  const published = JSON.parse(readFileSync(
    new URL('../../../../../deployments/evm/conformance/abi/NaryxStrategyAccount.abi.json', import.meta.url),
    'utf8',
  )) as Abi;
  const localFunction = getAbiItem({ abi: NARYX_STRATEGY_ACCOUNT_ABI, name: 'executePackage' }) as AbiFunction;
  const publishedFunction = getAbiItem({ abi: published, name: 'executePackage' }) as AbiFunction;
  assert.equal(toFunctionSelector(localFunction), toFunctionSelector(publishedFunction));
});

for (const network of [
  { name: 'Base', domainId: 'eip155:84532', chainReference: 84_532n },
  { name: 'Arbitrum', domainId: 'evm:arbitrum-sepolia', chainReference: 421_614n },
] as const) {
  test(`compiles deterministic unsigned atomic calldata for ${network.name}`, () => {
    const domainManifest = manifest(network.domainId, network.chainReference);
    const admitted = admission(domainManifest);
    const binding = seriesBinding(domainManifest);
    const compiled = compileEvmAtomicPackage(admitted, deployment(domainManifest, network.chainReference), binding, bounds);
    const repeated = compileEvmAtomicPackage(admitted, deployment(domainManifest, network.chainReference), binding, bounds);

    assert.equal(compiled.payload.chainReference, network.chainReference);
    assert.equal(compiled.payload.to.toLowerCase(), strategyAccount);
    assert.equal(compiled.payload.value, 0n);
    assert.equal(compiled.payload.data, repeated.payload.data);
    assert.deepEqual(compiled.orderHash, admitted.orderHash);
    assert.deepEqual(compiled.quoteHash, admitted.quoteHash);
    assert.deepEqual(compiled.routeHash, admitted.routeHash);

    const execution = decodedExecution(compiled.payload.data);
    assert.equal(execution.domainIdHash, keccak256(stringToHex(network.domainId)));
    assert.equal(execution.orderHash, hashHex(51));
    assert.equal(execution.quoteHash, hashHex(53));
    assert.equal(execution.routeHash, hashHex(52));
    assert.equal(execution.seriesIdentityKey, `0x${toHex(cashCarrySeriesIdentityKey(binding))}`);
    assert.equal(execution.seriesBindingVersion, 1);
    assert.equal(execution.seriesBindingHash, `0x${toHex(cashCarrySeriesBindingV1Hash(binding))}`);
    assert.equal(execution.packageSizeUnits, 2n);
    assert.equal(execution.strategyAccount, strategyAccount);
    assert.equal(execution.solver, solver);
    assert.equal(execution.deadline, 2_000n);
  });
}

test('rejects non-EVM and non-atomic routes', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  assert.throws(
    () => compileEvmAtomicPackage({ ...admitted, route: { ...admitted.route, executionPlanKind: 'HYPERCORE_BATCHED_IOC' } }, deployment(domainManifest, 84_532n), seriesBinding(domainManifest), bounds),
    /execution plan is unsupported/,
  );
  assert.throws(
    () => compileEvmAtomicPackage({ ...admitted, order: { ...admitted.order, settlementClass: 'BATCHED_IOC_WITH_RECOVERY' } }, deployment(domainManifest, 84_532n), seriesBinding(domainManifest), bounds),
    /settlement class is unsupported/,
  );
});

test('rejects an unrecognized atomic settlement identity or version', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, settlementClass: { ...identity.settlementClass, classId: hash(41) } }, seriesBinding(domainManifest), bounds),
    /settlement class identity is unsupported/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, settlementClass: { ...identity.settlementClass, classVersion: 2 } }, seriesBinding(domainManifest), bounds),
    /settlement class version is unsupported/,
  );
});

test('rejects non-65-byte ECDSA signatures', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest), { ...bounds, traderSignature: '0x1234' }),
    /trader signature must be exactly 65 bytes/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest), { ...bounds, solverSignature: '0x1234' }),
    /solver signature must be exactly 65 bytes/,
  );
});

test('rejects domain and deployment chain mismatches', () => {
  const baseManifest = manifest('eip155:84532', 84_532n);
  const arbitrumManifest = manifest('evm:arbitrum-sepolia', 421_614n);
  assert.throws(
    () => compileEvmAtomicPackage(admission(arbitrumManifest), deployment(baseManifest, 84_532n), seriesBinding(baseManifest), bounds),
    /order domain does not match deployment/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admission(baseManifest), deployment(baseManifest, 421_614n), seriesBinding(baseManifest), bounds),
    /deployment chain reference mismatch/,
  );
});

test('rejects missing and zero deployment addresses', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, strategyAccountFactory: { ...identity.strategyAccountFactory, address: zeroAddress } }, seriesBinding(domainManifest), bounds),
    /strategyAccountFactory.address must be nonzero/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest), { ...bounds, strategyAccount: address(15) }),
    /settlement account is not the owner factory account/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, {
      ...identity,
      perpetual: { ...identity.perpetual, adapter: { ...identity.perpetual.adapter, address: perpInstrument } },
    }, seriesBinding(domainManifest), bounds),
    /perpetual adapter must be the package verifier/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, perpetualObserver: { ...identity.perpetualObserver, address: undefined as unknown as Address } }, seriesBinding(domainManifest), bounds),
    /perpetualObserver.address must be an EVM address/,
  );
});

test('rejects an expired route at its exact boundary', () => {
  const domainManifest = manifest('evm:arbitrum-sepolia', 421_614n);
  assert.throws(
    () => compileEvmAtomicPackage(admission(domainManifest), deployment(domainManifest, 421_614n), seriesBinding(domainManifest), { ...bounds, currentUnixSeconds: 2_000n }),
    /route is expired/,
  );
});

test('derives package units and rejects nondivisible or unequal leg ratios', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest, {
      spotBaseAtomsPerPackageUnit: 3_000_000_000_000_000_000n,
    }), bounds),
    /base quantity is not divisible by the series spot unit/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest, {
      perpQuantityAtomsPerPackageUnit: 3_000_000_000_000_000_000n,
    }), bounds),
    /perpetual quantity is not divisible by the series perpetual unit/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest, {
      perpQuantityAtomsPerPackageUnit: 2_000_000_000_000_000_000n,
    }), bounds),
    /spot and perpetual package units differ/,
  );
});

test('requires an entry binding for the exact active domain and asset manifests', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(
      admitted,
      identity,
      seriesBinding(manifest('eip155:84532', 84_532n, 2)),
      bounds,
    ),
    /entry series binding domain mismatch/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest, {
      baseAsset: {
        subjectIdentity: hashHexBytes(keccak256(stringToHex(baseAsset.assetId))),
        manifestVersion: 2,
        manifestHash: hash(92),
      },
    }), bounds),
    /entry series binding base asset manifest mismatch/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest, {
      quoteAsset: {
        subjectIdentity: hash(93),
        manifestVersion: 1,
        manifestHash: quoteAsset.assetManifestHash,
      },
    }), bounds),
    /series binding quote asset identity mismatch/,
  );
});

test('accepts an exact historical exit binding across current domain and asset rotation', () => {
  const historicalDomain = manifest('evm:arbitrum-sepolia', 421_614n);
  const currentDomain = manifest('evm:arbitrum-sepolia', 421_614n, 2);
  const currentBaseAsset = assetRef(baseAsset.assetId, hash(94), baseAsset.decimals);
  const currentQuoteAsset = assetRef(quoteAsset.assetId, hash(95), quoteAsset.decimals);
  const identity = deployment(currentDomain, 421_614n);
  const rotatedIdentity: EvmDeploymentIdentity = {
    ...identity,
    baseAsset: {
      ...identity.baseAsset,
      manifestVersion: 2,
      manifestHash: currentBaseAsset.assetManifestHash,
    },
    quoteAsset: {
      ...identity.quoteAsset,
      manifestVersion: 2,
      manifestHash: currentQuoteAsset.assetManifestHash,
    },
  };
  const compiled = compileEvmAtomicPackage(
    exitAdmission(currentDomain, currentBaseAsset, currentQuoteAsset),
    rotatedIdentity,
    seriesBinding(historicalDomain),
    { ...bounds, maximumPostPerpEntryNotionalWad: 0n, expectedPrePerpEntryNotionalWad: EXIT_ENTRY_NOTIONAL_WAD },
  );
  const execution = decodedExecution(compiled.payload.data);
  assert.equal(execution.seriesBindingVersion, 1);
  assert.equal(execution.packageSizeUnits, 2n);
});

// The open package's exact WAD entry notional: 5,000 quote atoms (6 decimals) plus a sub-atom remainder.
const EXIT_ENTRY_NOTIONAL_WAD = 5_000_000_000n * 1_000_000_000_000n + 123_456_789n;

test('binds the exit to the chain nonce and the exact WAD entry notional the order commits in quote atoms', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const identity = deployment(domainManifest, 84_532n);
  const exit = exitAdmission(domainManifest, baseAsset, quoteAsset);
  const exitBounds = { ...bounds, maximumPostPerpEntryNotionalWad: 0n, expectedPrePerpEntryNotionalWad: EXIT_ENTRY_NOTIONAL_WAD };
  const execution = decodedExecution(compileEvmAtomicPackage(exit, identity, seriesBinding(domainManifest), exitBounds).payload.data);
  assert.equal(execution.nonce, 3n);
  assert.notEqual(execution.nonce, exit.order.nonce);
  assert.equal(execution.expectedPrePerpEntryNotionalWad, EXIT_ENTRY_NOTIONAL_WAD);
  assert.equal(execution.spotQuoteBoundAtoms, 5_500_000_000n);
  // One whole quote atom off the order's committed notional, in either direction, fails closed.
  for (const wrong of [EXIT_ENTRY_NOTIONAL_WAD + 1_000_000_000_000n, EXIT_ENTRY_NOTIONAL_WAD - 1_000_000_000_000n]) {
    assert.throws(
      () => compileEvmAtomicPackage(exit, identity, seriesBinding(domainManifest), { ...exitBounds, expectedPrePerpEntryNotionalWad: wrong }),
      /pre-position entry notional does not match the order/,
    );
  }
  assert.throws(
    () => compileEvmAtomicPackage(admission(domainManifest), identity, seriesBinding(domainManifest), { ...bounds, expectedPrePerpEntryNotionalWad: 1n }),
    /entry requires a zero pre-position entry notional/,
  );
});

test('signs the package notional the resource registry admits: the larger leg lots times limit', () => {
  const domainManifest = manifest('eip155:84532', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  const decoded = decodeFunctionData({
    abi: NARYX_STRATEGY_ACCOUNT_ABI,
    data: compileEvmAtomicPackage(admitted, identity, seriesBinding(domainManifest), bounds).payload.data,
  });
  const execution = decoded.args?.[0] as { packageNotionalQuoteAtoms: bigint };
  const resource = decoded.args?.[1] as {
    spot: { quantityAtoms: bigint; limitQuoteAtomsPerBaseLot: bigint };
    perpetual: { quantityAtoms: bigint; limitQuoteAtomsPerBaseLot: bigint };
    packageNotionalQuoteAtoms: bigint;
  };
  const spot = resource.spot.quantityAtoms / identity.spot.baseLotAtoms * resource.spot.limitQuoteAtomsPerBaseLot;
  const perp = resource.perpetual.quantityAtoms / identity.perpetual.baseLotAtoms * resource.perpetual.limitQuoteAtomsPerBaseLot;
  assert.equal(execution.packageNotionalQuoteAtoms, spot > perp ? spot : perp);
  assert.equal(resource.packageNotionalQuoteAtoms, execution.packageNotionalQuoteAtoms);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, spot: { ...identity.spot, baseLotAtoms: 3n } }, seriesBinding(domainManifest), bounds),
    /whole number of base lots/,
  );
});

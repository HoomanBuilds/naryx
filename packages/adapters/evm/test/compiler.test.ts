import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  adapterRef,
  assetRef,
  domainManifest,
  domainRefFromManifest,
  versionedManifestRef,
  type DomainManifest,
  type Hash32,
  type PackageAdmission,
} from '@naryx/protocol-types';
import {
  decodeFunctionData,
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
  type EvmAtomicExecutionBounds,
  type EvmDeploymentIdentity,
  type EvmManifestResourceIdentity,
} from '../src/index.js';

const hash = (byte: number): Hash32 => new Uint8Array(32).fill(byte) as Hash32;
const hashHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
const signatureHex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(65)}`;
const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const atomicSettlementClassId = Uint8Array.from(
  Buffer.from(keccak256(stringToHex('ATOMIC_POSTCONDITION')).slice(2), 'hex'),
) as Hash32;

const strategyAccount = address(1);
const spotPort = address(2);
const perpInstrument = address(3);
const perpObserver = address(4);
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

function manifest(domainId: string, chainReference: bigint): DomainManifest {
  return domainManifest({
    manifestVersion: 1,
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
    strategyAccount: { address: strategyAccount, expectedCodeHash: hashHex(40) },
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
      adapter: resource(perpAdapter.adapterId, perpAdapter.adapterManifestVersion, perpAdapter.adapterManifestHash, perpInstrument, 45),
      adapterClassId: 'synfutures-instrument',
      adapterClassVersion: 1,
      market: resource(perpMarket.subjectId, perpMarket.manifestVersion, perpMarket.manifestHash, address(11), 46),
      venue: resource(perpVenue.subjectId, perpVenue.manifestVersion, perpVenue.manifestHash, address(12), 47),
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
      solverSignatureScheme: 'SECP256K1_RECOVERABLE',
      solverVerificationKey: Uint8Array.from(Buffer.from(solver.slice(2), 'hex')),
      expectedSpotNotional: { asset: quoteAsset, atoms: 6_000_000_000n },
      validUntilUnit: 'EVM_UNIX_SECONDS',
      validUntilValue: 2_500n,
      signature: new Uint8Array(65).fill(1),
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
  traderSignature: signatureHex(9),
  spotFillCommitment: hash(55),
  packageSizeUnits: 2n,
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
  { name: 'Base', domainId: 'evm:base-sepolia', chainReference: 84_532n },
  { name: 'Arbitrum', domainId: 'evm:arbitrum-sepolia', chainReference: 421_614n },
] as const) {
  test(`compiles deterministic unsigned atomic calldata for ${network.name}`, () => {
    const domainManifest = manifest(network.domainId, network.chainReference);
    const admitted = admission(domainManifest);
    const compiled = compileEvmAtomicPackage(admitted, deployment(domainManifest, network.chainReference), bounds);
    const repeated = compileEvmAtomicPackage(admitted, deployment(domainManifest, network.chainReference), bounds);

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
    assert.equal(execution.strategyAccount, strategyAccount);
    assert.equal(execution.solver, solver);
    assert.equal(execution.deadline, 2_000n);
  });
}

test('rejects non-EVM and non-atomic routes', () => {
  const domainManifest = manifest('evm:base-sepolia', 84_532n);
  const admitted = admission(domainManifest);
  assert.throws(
    () => compileEvmAtomicPackage({ ...admitted, route: { ...admitted.route, executionPlanKind: 'HYPERCORE_BATCHED_IOC' } }, deployment(domainManifest, 84_532n), bounds),
    /execution plan is unsupported/,
  );
  assert.throws(
    () => compileEvmAtomicPackage({ ...admitted, order: { ...admitted.order, settlementClass: 'BATCHED_IOC_WITH_RECOVERY' } }, deployment(domainManifest, 84_532n), bounds),
    /settlement class is unsupported/,
  );
});

test('rejects an unrecognized atomic settlement identity or version', () => {
  const domainManifest = manifest('evm:base-sepolia', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, settlementClass: { ...identity.settlementClass, classId: hash(41) } }, bounds),
    /settlement class identity is unsupported/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, settlementClass: { ...identity.settlementClass, classVersion: 2 } }, bounds),
    /settlement class version is unsupported/,
  );
});

test('rejects non-65-byte ECDSA signatures', () => {
  const domainManifest = manifest('evm:base-sepolia', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, identity, { ...bounds, traderSignature: '0x1234' }),
    /trader signature must be exactly 65 bytes/,
  );
  assert.throws(
    () => compileEvmAtomicPackage({ ...admitted, quote: { ...admitted.quote, signature: new Uint8Array(64).fill(1) } }, identity, bounds),
    /solver quote signature must be exactly 65 bytes/,
  );
});

test('rejects domain and deployment chain mismatches', () => {
  const baseManifest = manifest('evm:base-sepolia', 84_532n);
  const arbitrumManifest = manifest('evm:arbitrum-sepolia', 421_614n);
  assert.throws(
    () => compileEvmAtomicPackage(admission(arbitrumManifest), deployment(baseManifest, 84_532n), bounds),
    /order domain does not match deployment/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admission(baseManifest), deployment(baseManifest, 421_614n), bounds),
    /deployment chain reference mismatch/,
  );
});

test('rejects missing and zero deployment addresses', () => {
  const domainManifest = manifest('evm:base-sepolia', 84_532n);
  const admitted = admission(domainManifest);
  const identity = deployment(domainManifest, 84_532n);
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, strategyAccount: { ...identity.strategyAccount, address: zeroAddress } }, bounds),
    /strategyAccount.address must be nonzero/,
  );
  assert.throws(
    () => compileEvmAtomicPackage(admitted, { ...identity, perpetualObserver: { ...identity.perpetualObserver, address: undefined as unknown as Address } }, bounds),
    /perpetualObserver.address must be an EVM address/,
  );
});

test('rejects an expired route at its exact boundary', () => {
  const domainManifest = manifest('evm:arbitrum-sepolia', 421_614n);
  assert.throws(
    () => compileEvmAtomicPackage(admission(domainManifest), deployment(domainManifest, 421_614n), { ...bounds, currentUnixSeconds: 2_000n }),
    /route is expired/,
  );
});

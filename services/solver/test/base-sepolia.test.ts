import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adapterRef,
  assetRef,
  domainManifest,
  domainRefFromManifest,
  versionedManifestRef,
  type PackageOrder,
} from '@naryx/protocol-types';
import type { Address, Hex } from 'viem';
import {
  createBaseSepoliaQuoteRuntime,
  priceBaseSepoliaEntry,
  type BaseSepoliaReadPort,
  type BaseSepoliaSolverDeployment,
} from '../src/base-sepolia-quote-runtime.js';
import { parseBaseSepoliaAuthorizationBounds } from '../src/base-sepolia-solver-authorization.js';

const hash = (byte: string) => byte.repeat(64);
const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const Q96 = 1n << 96n;
const manifest = domainManifest({
  manifestVersion: 1,
  environment: 'testnet',
  domainId: 'eip155:84532',
  runtimeClassId: 'naryx-evm',
  runtimeClassVersion: 1,
  chainNamespace: 'eip155',
  chainReference: '84532',
  executionVerifierId: 'package-verifier-v1',
  executionVerifierCodeHash: hash('7'),
  clockModelId: 'evm-unix-seconds',
  finalityPolicyHash: hash('8'),
  addressCodecId: 'evm-address-20',
  supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
});
const base = assetRef('weth', hash('2'), 18);
const quote = assetRef('usdc', hash('3'), 6);
const spotAdapter = adapterRef({ adapterId: 'uniswap-v3-spot', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
const perpAdapter = adapterRef({ adapterId: 'base-perp-port', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
const owner = address('1');
const account = address('2');
const deployment = {
  domainManifest: manifest,
  deploymentChainReference: 84_532n,
  strategyAccountFactory: { address: address('a'), expectedCodeHash: `0x${hash('a')}` as Hex },
  spot: { market: { address: address('b') } },
  perpetual: { market: { address: address('c') } },
  baseAsset: { address: address('d'), decimals: 18 },
} as unknown as BaseSepoliaSolverDeployment['deployment'];

function chain(): BaseSepoliaReadPort {
  return {
    chainId: async () => 84_532n,
    codeHash: async () => undefined,
    latestBlockTimestamp: async () => 1_000n,
    readContract: async ({ functionName }) => {
      switch (functionName) {
        // Base is token0 at exactly one quote atom per base atom.
        case 'slot0': return [Q96, 0, 0, 0, 0, 0, true];
        case 'token0': return address('d');
        case 'fee': return 3_000;
        case 'oracle': return address('e');
        case 'collateralScale': return 1_000_000_000_000n;
        case 'previewOpen': return [0n, 2_000_000_000_000_000_123n, 1_000_000_000_000n, 0n];
        case 'decimals': return 8;
        case 'latestRoundData': return [1n, 300_000_000_000n, 0n, 990n, 1n];
        case 'accountOf': return account;
        default: throw new Error(`unexpected read ${functionName}`);
      }
    },
  };
}

test('prices the exact-output spot buy up with the pool fee and margins the perp from previewOpen', async () => {
  const pricing = await priceBaseSepoliaEntry(chain(), deployment, 1_001n, 1_500n);
  // 1001 base atoms at 1 quote atom each plus 0.3%: 1004.003 rounds up to 1005.
  assert.equal(pricing.spotNotionalAtoms, 1_005n);
  assert.equal(pricing.spotFeeAtoms, 4n);
  assert.equal(pricing.perpNotionalAtoms, 2_000_000n);
  assert.equal(pricing.perpFeeAtoms, 1n);
  assert.equal(pricing.marginAtoms, 300_001n);
});

test('refuses to quote an order whose settlement account is not the owner factory account', async () => {
  const action = (sequence: number, adapter: typeof spotAdapter) => ({
    sequence, actionClassId: 'evm-call', adapter, targetBindingId: 't', authorityBindingId: 'strategy-account',
    accountMetas: [], payload: { codecId: 'evm', templateLength: 0, templateHash: hash('9'), lateBoundFields: [] },
  });
  const runtime = createBaseSepoliaQuoteRuntime({
    deployment: {
      deployment,
      admission: { templateManifest: { templateId: 'cash-and-carry-v1', templateVersion: 1 } },
      executionPolicy: { solver: address('f'), oracleMoveAllowanceBps: 100 },
    } as unknown as BaseSepoliaSolverDeployment,
    chain: chain(),
    nonceSource: { next: () => 1n },
    templateRegistryRecordHash: hash('6'),
    candidateId: 'base-sepolia-uniswap',
    capacityBaseAtoms: 10n ** 20n,
    solverId: 'base-solver',
    solverCapabilityManifestHash: hash('6'),
    feePolicyVersion: 1,
    feePolicyManifestHash: hash('6'),
    routeTtlSeconds: 60n,
    marginBps: 1_500,
    perpSlippageBps: 50,
    spot: { adapter: spotAdapter, venue: versionedManifestRef('uni', 1, hash('6')), market: versionedManifestRef('pool', 1, hash('6')), action: action(0, spotAdapter) },
    perpetual: { adapter: perpAdapter, venue: versionedManifestRef('perp', 1, hash('6')), market: versionedManifestRef('perp-m', 1, hash('6')), action: action(1, perpAdapter) },
    strategyAccountBindingId: 'strategy-account',
    accountBindings: [{ routeBindingId: 'strategy-account', accountIdentity: account }],
    preconditions: [],
    postconditions: [],
    evidenceRequirements: {} as never,
  });
  const order = {
    environment: 'testnet',
    settlementClass: 'ATOMIC_POSTCONDITION',
    expiryUnit: 'EVM_UNIX_SECONDS',
    expiryValue: 2_000n,
    action: 'ENTRY',
    domain: domainRefFromManifest(manifest),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    permittedSpotAdapters: [spotAdapter],
    permittedPerpAdapters: [perpAdapter],
    maxSpotQuoteIn: { asset: quote, atoms: 10n ** 12n },
    quantity: { asset: base, atoms: 1_001n },
    owner,
    settlementAccount: address('9'),
  } as unknown as PackageOrder;
  await assert.rejects(
    async () => runtime.candidates({ order, orderHash: new Uint8Array(32).fill(1) as never }),
    /not the owner factory account/,
  );
});

test('accepts only the exact signed-bounds wire shape for co-signing', () => {
  const wire = {
    currentUnixSeconds: '1000',
    strategyAccount: account,
    solver: address('f'),
    spotFillCommitment: `0x${hash('1')}`,
    packageNonce: '4',
    expectedPrePerpEntryNotionalWad: '0',
    expectedPrePerpBalanceWad: '0',
    minimumPostPerpBalanceWad: '1',
    maximumPostPerpBalanceWad: '2',
    maximumPostPerpEntryNotionalWad: '3',
    perpExpiry: 4_294_967_295,
    perpArgs: [`0x${hash('2')}`, `0x${hash('3')}`],
  };
  const parsed = parseBaseSepoliaAuthorizationBounds(wire);
  assert.equal(parsed.maximumPostPerpEntryNotionalWad, 3n);
  assert.equal(parsed.packageNonce, 4n);
  assert.throws(() => parseBaseSepoliaAuthorizationBounds({ ...wire, extra: 1 }), /malformed/);
  assert.throws(() => parseBaseSepoliaAuthorizationBounds({ ...wire, minimumPostPerpBalanceWad: '1.5' }), /decimal/);
});

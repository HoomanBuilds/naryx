import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  adapterRef,
  assetAmount,
  assetRef,
  commitmentHash,
  domainRef,
  encodeRoutePayload,
  exactPrice,
  feeCap,
  fromHex,
  payloadTemplateHash,
  routeHash,
  recoveryPlan,
  routePayload,
  routePayloadBytes,
  toHex,
  versionedManifestRef,
  type RoutePayload,
  type RoutePayloadInput,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';

interface RoutePayloadFixture {
  readonly name: string;
  readonly payloadTemplateHash: string;
  readonly canonicalHex: string;
  readonly digestHex: string;
}

const fixture = loadFixture<RoutePayloadFixture>('route-payload.json');
const hash = (byte: string): string => byte.repeat(64);

function atomicInput(overrides: Partial<RoutePayloadInput> = {}): RoutePayloadInput {
  const sol = assetRef('sol', hash('1'), 9);
  const usdc = assetRef('usdc', hash('2'), 6);
  const domain = domainRef('solana-devnet', 1, hash('3'));
  const spotAdapter = adapterRef({ adapterId: 'phoenix-spot', adapterManifestVersion: 1, adapterManifestHash: hash('4') });
  const perpAdapter = adapterRef({ adapterId: 'phoenix-perp', adapterManifestVersion: 1, adapterManifestHash: hash('5') });
  const spotVenue = versionedManifestRef('phoenix', 1, hash('6'));
  const perpVenue = versionedManifestRef('phoenix-perps', 1, hash('7'));
  const spotMarket = versionedManifestRef('sol-usdc-spot', 1, hash('8'));
  const perpMarket = versionedManifestRef('sol-usdc-perp', 1, hash('9'));
  const price = exactPrice({
    baseAsset: sol,
    quoteAsset: usdc,
    quoteAtoms: 3n,
    baseAtoms: 2n,
    roundingDirection: 'CEIL',
  });
  const firstPayload = new Uint8Array(40);
  firstPayload.set([1, 2, 3, 4, 5, 6, 7, 8]);
  firstPayload.fill(0xaa, 8);
  const lateBoundFields = [{ kind: 'ROUTE_HASH' as const, offset: 8, length: 32 }];

  return {
    version: 1,
    environment: 'devnet',
    domain,
    orderHash: hash('a'),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('b'),
    templateRegistryRecordHash: hash('c'),
    owner: 'trader-wallet',
    settlementAccount: 'strategy-account-1',
    solver: 'solver-alpha',
    direction: 'LONG_SPOT_SHORT_PERP',
    action: 'ENTRY',
    quantityPolicyClass: 'EXACT_ATOMIC',
    partialFillPolicy: 'EXACT_ALL_LEGS',
    settlementClass: 'ATOMIC_POSTCONDITION',
    executionPlanKind: 'SVM_ATOMIC_CPI',
    routeExpiryUnit: 'SOLANA_SLOT',
    routeExpiryValue: 500_000n,
    feePolicyVersion: 2,
    feePolicyManifestHash: hash('d'),
    accountBindings: [
      {
        routeBindingId: 'trader-authority',
        accountIdentity: 'trader-wallet',
        authorityIdentity: 'trader-wallet',
      },
      {
        routeBindingId: 'spot-program',
        adapter: spotAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'phoenix-program',
        codeIdentity: 'phoenix-code-v1',
      },
      {
        routeBindingId: 'perp-program',
        adapter: perpAdapter,
        adapterBindingId: 'market-program',
        accountIdentity: 'phoenix-perp-program',
        codeIdentity: 'phoenix-perp-code-v1',
      },
      {
        routeBindingId: 'fee-vault',
        accountIdentity: 'naryx-fee-vault',
        ownerIdentity: 'naryx-fee-authority',
      },
    ],
    serviceCharges: [],
    preconditions: [
      {
        constraintId: 'pre-trader-authorized',
        ruleId: 'authority-equals-owner-v1',
        accountBindingId: 'trader-authority',
        componentId: 'is-authorized',
        comparator: 'EQ',
        value: { kind: 'BOOLEAN', value: true },
        evidenceRequirementId: 'authority-state',
      },
    ],
    legs: [
      {
        legIndex: 0,
        legRole: 'SPOT',
        actionSequence: 0,
        adapter: spotAdapter,
        venue: spotVenue,
        market: spotMarket,
        baseAsset: sol,
        quoteAsset: usdc,
        side: 'BUY',
        quantity: { asset: sol, atoms: 1_000_000_000n },
        limitPrice: price,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
      {
        legIndex: 1,
        legRole: 'PERPETUAL',
        actionSequence: 1,
        adapter: perpAdapter,
        venue: perpVenue,
        market: perpMarket,
        baseAsset: sol,
        quoteAsset: usdc,
        side: 'SELL',
        quantity: { asset: sol, atoms: 1_000_000_000n },
        limitPrice: price,
        timeInForce: 'FOK',
        reduceOnly: false,
      },
    ],
    actions: [
      {
        sequence: 0,
        actionClassId: 'svm-cpi-spot-v1',
        legIndex: 0,
        adapter: spotAdapter,
        targetBindingId: 'spot-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'spot-program', isSigner: false, isWritable: false },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
        ],
        payload: {
          codecId: 'svm-instruction-v1',
          templateLength: firstPayload.length,
          templateHash: payloadTemplateHash(firstPayload, lateBoundFields),
          lateBoundFields,
        },
        feeRecipientBindingId: 'fee-vault',
      },
      {
        sequence: 1,
        actionClassId: 'svm-cpi-perp-v1',
        legIndex: 1,
        adapter: perpAdapter,
        targetBindingId: 'perp-program',
        authorityBindingId: 'trader-authority',
        accountMetas: [
          { routeBindingId: 'perp-program', isSigner: false, isWritable: false },
          { routeBindingId: 'trader-authority', isSigner: true, isWritable: true },
        ],
        payload: {
          codecId: 'svm-instruction-v1',
          templateLength: 3,
          templateHash: payloadTemplateHash(Uint8Array.from([9, 8, 7]), []),
          lateBoundFields: [],
        },
      },
    ],
    postconditions: [
      {
        constraintId: 'post-perp-position',
        ruleId: 'position-delta-v1',
        accountBindingId: 'perp-program',
        componentId: 'base-position-delta',
        comparator: 'EQ',
        value: { kind: 'SIGNED_ASSET_AMOUNT', value: assetAmount(sol, -1_000_000_000n) },
        evidenceRequirementId: 'perp-position-state',
      },
      {
        constraintId: 'post-spot-balance',
        ruleId: 'balance-delta-v1',
        accountBindingId: 'spot-program',
        componentId: 'base-balance-delta',
        comparator: 'GTE',
        value: { kind: 'SIGNED_ASSET_AMOUNT', value: assetAmount(sol, 1_000_000_000n) },
        evidenceRequirementId: 'spot-balance-state',
      },
    ],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: 'svm-atomic-evidence-v1',
      requiredPreStateComponentIds: ['authority-state'],
      requiredPostStateComponentIds: ['perp-position-state', 'spot-balance-state'],
      requiredActionEvidenceTypeIds: ['cpi-result', 'transaction-signature'],
      stateReferenceSchemaHash: hash('e'),
      receiptSchemaHash: hash('f'),
      outcomeSchemaHash: `01${'0'.repeat(62)}`,
    },
    ...overrides,
  };
}

describe('route payload canonical identity', () => {
  test('atomic canonical bytes, template hash, and route hash match the golden vector', () => {
    const input = atomicInput();
    const route = routePayload(input);
    const template = input.actions[0]!.payload.templateHash;
    assert.equal(toHex(commitmentHash(template)), fixture.payloadTemplateHash);
    assert.equal(toHex(routePayloadBytes(input)), fixture.canonicalHex);
    assert.equal(toHex(routeHash(input)), fixture.digestHex);
    assert.deepEqual(route.accountBindings.map((value) => value.routeBindingId), [
      'fee-vault',
      'perp-program',
      'spot-program',
      'trader-authority',
    ]);
  });

  test('template hashing zeros only declared ranges and rejects invalid ranges', () => {
    const first = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const second = Uint8Array.from([1, 2, 9, 9, 5, 6]);
    const fields = [{ kind: 'ROUTE_HASH' as const, offset: 2, length: 2 }];
    assert.equal(toHex(payloadTemplateHash(first, fields)), toHex(payloadTemplateHash(second, fields)));
    assert.throws(
      () => payloadTemplateHash(first, [
        { kind: 'ROUTE_HASH', offset: 1, length: 3 },
        { kind: 'QUOTE_HASH', offset: 2, length: 2 },
      ]),
      MalformedInputError,
    );
    assert.throws(
      () => payloadTemplateHash(first, [{ kind: 'ROUTE_HASH', offset: 5, length: 2 }]),
      MalformedInputError,
    );
  });

  test('ordered structures and canonical sets reject ambiguous inputs', () => {
    const input = atomicInput();
    assert.throws(
      () => routePayload(atomicInput({ actions: [{ ...input.actions[0]!, sequence: 1 }, input.actions[1]!] })),
      MalformedInputError,
    );
    assert.throws(
      () => routePayload(atomicInput({
        accountBindings: [input.accountBindings[0]!, input.accountBindings[0]!],
      })),
      DuplicateElementError,
    );
    const duplicatedMeta = {
      ...input.actions[0]!,
      accountMetas: [input.actions[0]!.accountMetas[0]!, input.actions[0]!.accountMetas[0]!],
    };
    assert.throws(
      () => routePayload(atomicInput({ actions: [duplicatedMeta, input.actions[1]!] })),
      DuplicateElementError,
    );
  });
});

describe('route payload validation', () => {
  test('plan shapes, versions, widths, and references fail closed', () => {
    assert.throws(() => routePayload(atomicInput({ version: 2 })), MalformedInputError);
    assert.throws(() => routePayload(atomicInput({ feePolicyVersion: 0 })), MalformedInputError);
    assert.throws(() => routePayload(atomicInput({ routeExpiryValue: 1n << 64n })), RangeViolationError);
    assert.throws(
      () => routePayload(atomicInput({ routeExpiryUnit: 'EVM_UNIX_SECONDS' })),
      MalformedInputError,
    );
    assert.throws(
      () => routePayload(atomicInput({ settlementClass: 'BATCHED_IOC_WITH_RECOVERY' })),
      MalformedInputError,
    );
    const input = atomicInput();
    assert.throws(
      () => routePayload(atomicInput({
        actions: [{ ...input.actions[0]!, targetBindingId: 'missing-binding' }, input.actions[1]!],
      })),
      MalformedInputError,
    );

    const asyncRecovery = {
      policyVersion: 1,
      controllerId: 'arbitrum-async-coordinator',
      controllerCodeHash: hash('1'),
      authorityModeId: 'bonded-solver',
      recoveryExpiryUnit: 'EVM_UNIX_SECONDS' as const,
      maxActionExpiryValue: 700n,
      deadlineValue: 1_000n,
      minRecoveryWindowMs: 60_000n,
      maxRecoveryCostCaps: [feeCap({ asset: input.legs[0]!.quoteAsset, maxAtoms: 1_000n })],
      maxAggregateRecoveryLoss: { asset: input.legs[0]!.quoteAsset, atoms: 10_000n },
      maxIntermediateResidual: { asset: input.legs[0]!.baseAsset, atoms: 1_000n },
      maxTerminalResidual: { asset: input.legs[0]!.baseAsset, atoms: 10n },
      reconciledStateSchemaHash: hash('2'),
      actionBuilderCodeHash: hash('3'),
      actionSlots: [{
        sequence: 0,
        action: 'CANCEL_OPEN_ORDERS' as const,
        targetLeg: 1,
        adapter: input.legs[1]!.adapter,
        markets: [input.legs[1]!.market],
      }],
    };
    const asynchronous = routePayload(atomicInput({
      environment: 'testnet',
      domain: domainRef('arbitrum-sepolia', 1, hash('4')),
      quantityPolicyClass: 'EXACT_NET',
      settlementClass: 'ASYNC_BONDED_SOLVER',
      executionPlanKind: 'EVM_ASYNC_REQUEST',
      routeExpiryUnit: 'EVM_UNIX_SECONDS',
      routeExpiryValue: 500n,
      recoveryPlan: asyncRecovery,
    }));
    assert.equal(asynchronous.settlementClass, 'ASYNC_BONDED_SOLVER');
    assert.throws(
      () => routePayload(atomicInput({
        quantityPolicyClass: 'EXACT_NET',
        settlementClass: 'ASYNC_BONDED_SOLVER',
        executionPlanKind: 'EVM_ASYNC_REQUEST',
        routeExpiryUnit: 'EVM_UNIX_SECONDS',
        routeExpiryValue: 500n,
        recoveryPlan: {
          ...asyncRecovery,
          recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
        },
      })),
      MalformedInputError,
    );
  });

  test('captured bytes and arrays cannot be changed by caller mutation', () => {
    const orderHash = fromHex(hash('a'));
    const input = atomicInput({ orderHash });
    const bindings = [...input.accountBindings];
    const captured = routePayload({ ...input, accountBindings: bindings });
    const before = toHex(routePayloadBytes(captured));
    orderHash[0] = 0xff;
    bindings.reverse();
    captured.orderHash[0] = 0xff;
    assert.equal(Object.isFrozen(captured), true);
    assert.equal(Object.isFrozen(captured.accountBindings), true);
    assert.equal(toHex(routePayloadBytes(captured)), before);
  });

  test('encoder rejects forged string hashes before writing route bytes', () => {
    const route = routePayload(atomicInput());
    const forged = { ...route, orderHash: hash('a') } as unknown as RoutePayload;
    const writer = new CanonicalWriter();
    assert.throws(() => encodeRoutePayload(writer, forged), MalformedInputError);
    assert.equal(writer.bytes().length, 0);
  });

  test('recovery plans enforce timing, cost, sequence, and action-slot shapes', () => {
    const sol = assetRef('sol', hash('1'), 9);
    const usdc = assetRef('usdc', hash('2'), 6);
    const adapter = adapterRef({
      adapterId: 'hypercore-perp',
      adapterManifestVersion: 1,
      adapterManifestHash: hash('3'),
    });
    const market = versionedManifestRef('sol-perp', 1, hash('4'));
    const price = exactPrice({
      baseAsset: sol,
      quoteAsset: usdc,
      quoteAtoms: 3n,
      baseAtoms: 2n,
      roundingDirection: 'CEIL',
    });
    const valid = {
      policyVersion: 1,
      controllerId: 'hypercore-controller',
      controllerCodeHash: hash('5'),
      authorityModeId: 'exclusive-agent',
      recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS' as const,
      maxActionExpiryValue: 2_000n,
      deadlineValue: 3_000n,
      minRecoveryWindowMs: 500n,
      maxRecoveryCostCaps: [feeCap({ asset: usdc, maxAtoms: 1_000n })],
      maxAggregateRecoveryLoss: { asset: usdc, atoms: 50_000n },
      maxIntermediateResidual: { asset: sol, atoms: 1_000n },
      maxTerminalResidual: { asset: sol, atoms: 10n },
      reconciledStateSchemaHash: hash('6'),
      actionBuilderCodeHash: hash('7'),
      actionSlots: [
        {
          sequence: 0,
          action: 'CANCEL_OPEN_ORDERS' as const,
          targetLeg: 1,
          adapter,
          markets: [market],
        },
        {
          sequence: 1,
          action: 'COMPLETE_PERP' as const,
          targetLeg: 1,
          adapter,
          markets: [market],
          maxQuantity: { asset: sol, atoms: 100n },
          limitPrice: price,
          reduceOnly: true,
          timeInForce: 'IOC' as const,
        },
      ],
    };
    const checked = recoveryPlan(valid);
    assert.equal(checked.actionSlots.length, 2);
    assert.equal(Object.isFrozen(checked.actionSlots), true);
    assert.throws(
      () => recoveryPlan({ ...valid, maxActionExpiryValue: 2_700n }),
      MalformedInputError,
    );
    assert.throws(
      () => recoveryPlan({
        ...valid,
        maxRecoveryCostCaps: [feeCap({ asset: usdc, maxAtoms: -1n })],
      }),
      MalformedInputError,
    );
    assert.throws(
      () => recoveryPlan({
        ...valid,
        actionSlots: [{
          ...valid.actionSlots[0]!,
          maxQuantity: { asset: sol, atoms: 1n },
        }],
      }),
      MalformedInputError,
    );
    assert.throws(
      () => recoveryPlan({
        ...valid,
        actionSlots: [{ ...valid.actionSlots[1]!, sequence: 0, timeInForce: 'FOK' }],
      }),
      MalformedInputError,
    );
    assert.equal(recoveryPlan({
      ...valid,
      recoveryExpiryUnit: 'EVM_UNIX_SECONDS',
      maxActionExpiryValue: 2_000n,
      deadlineValue: 3_000n,
      minRecoveryWindowMs: 500_000n,
    }).recoveryExpiryUnit, 'EVM_UNIX_SECONDS');
    assert.throws(
      () => recoveryPlan({
        ...valid,
        recoveryExpiryUnit: 'EVM_UNIX_SECONDS',
        minRecoveryWindowMs: 500_001n,
      }),
      MalformedInputError,
    );
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjustNativeClearingCollateral,
  adjustNativeClearingRecoveryReserve,
  applyNativeClearingMatch,
  assetRef,
  nativeClearingAccount,
  nativeClearingAccountHealth,
  nativeClearingDomainState,
  nativeClearingPolicy,
  resolveNativeClearingDefault,
  versionedManifestRef,
  type NativeClearingAccount,
  type NativeClearingPolicyInput,
} from '../src/index.js';

const id = (value: number): string => value.toString(16).padStart(64, '0');

function policyInput(overrides: Partial<NativeClearingPolicyInput> = {}): NativeClearingPolicyInput {
  return {
    version: 1,
    clearingDomainId: 'sol-carry-clearing',
    environment: 'devnet',
    executionClassId: 'sol-carry-package',
    matchingPolicyHash: id(3),
    strategySeries: versionedManifestRef('sol-carry', 1, id(1)),
    riskDomainId: 'sol-carry-isolated-risk',
    accountingAsset: assetRef('usdc', id(2), 6),
    packageQuantityIncrementAtoms: 10n,
    priceTickQuoteAtoms: 1n,
    initialMarginQuoteAtomsPerIncrement: 200n,
    maintenanceMarginQuoteAtomsPerIncrement: 100n,
    maximumPositionAtoms: 1_000n,
    maximumOpenInterestAtoms: 10_000n,
    maximumDefaultTransferDiscountBps: 500n,
    markMaximumStalenessMs: 5_000n,
    ...overrides,
  };
}

function account(
  number: number,
  policyHash: Uint8Array,
  collateralQuoteAtoms: bigint,
  cashBalanceQuoteAtoms = 0n,
  positionAtoms = 0n,
): NativeClearingAccount {
  return nativeClearingAccount({
    version: 1,
    policyHash,
    accountId: `account-${number}`,
    ownerId: `owner-${number}`,
    collateralQuoteAtoms,
    cashBalanceQuoteAtoms,
    positionAtoms,
    sequence: 0n,
  }, policyInput());
}

test('native clearing policy binds one isolated series and rejects unsafe margin ordering', () => {
  const policy = nativeClearingPolicy(policyInput());
  assert.equal(policy.clearingDomainId, 'sol-carry-clearing');
  assert.equal(policy.strategySeries.subjectId, 'sol-carry');
  assert.throws(
    () => nativeClearingPolicy(policyInput({
      initialMarginQuoteAtomsPerIncrement: 99n,
      maintenanceMarginQuoteAtomsPerIncrement: 100n,
    })),
    /maintenance margin exceeds initial margin/,
  );
});

test('a bilateral package match conserves positions and quote value', () => {
  const policy = nativeClearingPolicy(policyInput());
  const domain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 0n,
    recoveryReserveQuoteAtoms: 1_000n,
    sequence: 0n,
  }, policy);
  const long = account(1, policy.policyHash, 5_000n);
  const short = account(2, policy.policyHash, 5_000n);
  const result = applyNativeClearingMatch({
    policy,
    domainState: domain,
    longAccount: long,
    shortAccount: short,
    executionId: 'match-1',
    quantityAtoms: 20n,
    priceTicks: 1_000n,
    markPriceTicks: 1_000n,
    observedAtMs: 10_000n,
    nowMs: 10_100n,
  });
  assert.equal(result.longAccount.positionAtoms, 20n);
  assert.equal(result.shortAccount.positionAtoms, -20n);
  assert.equal(result.longAccount.cashBalanceQuoteAtoms, -2_000n);
  assert.equal(result.shortAccount.cashBalanceQuoteAtoms, 2_000n);
  assert.equal(result.domainState.openInterestAtoms, 20n);
  assert.notDeepEqual(result.receipt.receiptHash, domain.stateHash);
});

test('recovery reserve funding is sequenced and cannot over-withdraw', () => {
  const policy = nativeClearingPolicy(policyInput());
  const state = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 0n,
    recoveryReserveQuoteAtoms: 100n,
    sequence: 0n,
  }, policy);
  const funded = adjustNativeClearingRecoveryReserve(state, policy, 50n);
  assert.equal(funded.recoveryReserveQuoteAtoms, 150n);
  assert.equal(funded.sequence, 1n);
  assert.throws(() => adjustNativeClearingRecoveryReserve(funded, policy, -151n), /exceeds the recovery reserve/);
});

test('risk-increasing matching and collateral withdrawal require initial margin', () => {
  const policy = nativeClearingPolicy(policyInput());
  const domain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 0n,
    recoveryReserveQuoteAtoms: 0n,
    sequence: 0n,
  }, policy);
  assert.throws(() => applyNativeClearingMatch({
    policy,
    domainState: domain,
    longAccount: account(1, policy.policyHash, 100n),
    shortAccount: account(2, policy.policyHash, 100n),
    executionId: 'match-underfunded',
    quantityAtoms: 10n,
    priceTicks: 1_000n,
    markPriceTicks: 1_000n,
    observedAtMs: 10_000n,
    nowMs: 10_000n,
  }), /below initial margin/);

  const funded = account(3, policy.policyHash, 500n, -1_000n, 10n);
  assert.throws(() => adjustNativeClearingCollateral(
    funded,
    policy,
    -301n,
    1_000n,
    10_000n,
    10_000n,
  ), /below initial margin/);
});

test('health moves from active through reduce-only, liquidatable, and defaulted', () => {
  const policy = nativeClearingPolicy(policyInput());
  const position = account(1, policy.policyHash, 1_000n, -1_000n, 10n);
  assert.equal(nativeClearingAccountHealth(position, policy, 1_000n, 10_000n, 10_000n).status, 'ACTIVE');
  assert.equal(nativeClearingAccountHealth(position, policy, 150n, 10_000n, 10_000n).status, 'REDUCE_ONLY');
  assert.equal(nativeClearingAccountHealth(position, policy, 50n, 10_000n, 10_000n).status, 'LIQUIDATABLE');
  assert.equal(nativeClearingAccountHealth(position, policy, 1n, 10_000n, 10_000n).status, 'LIQUIDATABLE');

  const insolvent = account(2, policy.policyHash, 100n, -1_000n, 10n);
  assert.equal(nativeClearingAccountHealth(insolvent, policy, 50n, 10_000n, 10_000n).status, 'DEFAULTED');
  assert.throws(
    () => nativeClearingAccountHealth(position, policy, 1_000n, 1_000n, 10_000n),
    /stale/,
  );
});

test('a reduce-only account may shrink but cannot reverse its exposure', () => {
  const policy = nativeClearingPolicy(policyInput());
  const domain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 10n,
    recoveryReserveQuoteAtoms: 0n,
    sequence: 2n,
  }, policy);
  const reducing = account(1, policy.policyHash, 150n, -1_000n, 10n);
  const healthy = account(2, policy.policyHash, 5_000n, 0n, -10n);
  const result = applyNativeClearingMatch({
    policy,
    domainState: domain,
    longAccount: healthy,
    shortAccount: reducing,
    executionId: 'reduce-only-match',
    quantityAtoms: 10n,
    priceTicks: 1_000n,
    markPriceTicks: 1_000n,
    observedAtMs: 10_000n,
    nowMs: 10_000n,
  });
  assert.equal(result.shortAccount.positionAtoms, 0n);
  assert.equal(result.domainState.openInterestAtoms, 0n);
});

test('default transfer is price-bounded and consumes only the funded reserve', () => {
  const policy = nativeClearingPolicy(policyInput());
  const domain = nativeClearingDomainState({
    version: 1,
    policyHash: policy.policyHash,
    openInterestAtoms: 10n,
    recoveryReserveQuoteAtoms: 300n,
    sequence: 4n,
  }, policy);
  const defaulter = account(1, policy.policyHash, 100n, -1_000n, 10n);
  const backstop = account(2, policy.policyHash, 5_000n);
  assert.throws(() => resolveNativeClearingDefault({
    policy,
    domainState: domain,
    defaultedAccount: defaulter,
    backstopAccount: backstop,
    resolutionId: 'default-out-of-band',
    transferPriceTicks: 40n,
    markPriceTicks: 50n,
    observedAtMs: 10_000n,
    nowMs: 10_000n,
  }), /exceeds its bound/);

  const result = resolveNativeClearingDefault({
    policy,
    domainState: domain,
    defaultedAccount: defaulter,
    backstopAccount: backstop,
    resolutionId: 'default-1',
    transferPriceTicks: 48n,
    markPriceTicks: 50n,
    observedAtMs: 10_000n,
    nowMs: 10_000n,
  });
  assert.equal(result.defaultedAccount.positionAtoms, 0n);
  assert.equal(result.defaultedAccount.cashBalanceQuoteAtoms, -552n);
  assert.equal(result.backstopAccount.positionAtoms, 10n);
  assert.equal(result.domainState.recoveryReserveQuoteAtoms, 0n);
  assert.equal(result.domainState.openInterestAtoms, 10n);
  assert.equal(result.resolution.reserveConsumedQuoteAtoms, 300n);
  assert.equal(result.resolution.uncoveredDeficitQuoteAtoms, 552n);
});

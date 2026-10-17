import type { HyperliquidSubmissionAccount } from './index.js';
import {
  HyperliquidTestnetExecutorError,
  type HyperliquidTestnetAttemptHandoff,
} from './hyperliquid-testnet-executor-http.js';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;

export function hyperliquidTestnetAccountMode(environment: NodeJS.ProcessEnv):
  'PER_USER' | 'SHARED_TEST_FIXTURE' {
  const value = environment.NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE ?? 'PER_USER';
  if (value !== 'PER_USER' && value !== 'SHARED_TEST_FIXTURE') {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE must be PER_USER or SHARED_TEST_FIXTURE');
  }
  return value;
}

export function hyperliquidTestnetAttemptAccount(attempt: HyperliquidTestnetAttemptHandoff):
  Readonly<{ owner: `0x${string}`; settlementAccount: `0x${string}` }> {
  const binding = 'admission' in attempt ? attempt.admission.order : attempt.accountBinding;
  if (binding === undefined || !ADDRESS.test(binding.owner) || !ADDRESS.test(binding.settlementAccount)) {
    throw new HyperliquidTestnetExecutorError('INVALID_ATTEMPT',
      'per-user execution requires the signed owner and settlement account');
  }
  return Object.freeze({
    owner: binding.owner as `0x${string}`,
    settlementAccount: binding.settlementAccount as `0x${string}`,
  });
}

export function requireHyperliquidTestnetAccountBinding(
  attempt: HyperliquidTestnetAttemptHandoff,
  account: HyperliquidSubmissionAccount,
): void {
  const binding = hyperliquidTestnetAttemptAccount(attempt);
  if (binding.owner !== account.masterAccount || binding.settlementAccount !== account.tradingAccount) {
    throw new HyperliquidTestnetExecutorError('INVALID_ATTEMPT',
      'signed owner and settlement account do not match the execution account');
  }
}

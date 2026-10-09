import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
  loadHyperliquidRecoverySigner,
  loadHyperliquidRecoveryTestnetConfig,
} from '../src/index.js';

test('loads only an external Testnet recovery config and matching scoped key', async (suite) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-recovery-config-'));
  suite.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateKey = `0x${'07'.repeat(32)}` as const;
  const agentWallet = privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
  const keyPath = join(directory, 'agent-key.json');
  writeFileSync(keyPath, JSON.stringify({
    version: 1,
    environment: 'HYPERLIQUID_TESTNET',
    privateKey,
  }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const configPath = join(directory, 'recovery.json');
  writeFileSync(configPath, stringifyProtocolJson({
    version: 1,
    environment: 'HYPERLIQUID_TESTNET',
    databasePath: join(directory, 'recovery.sqlite'),
    keyPath,
    agentWallet,
    signerLeaseId: 'keeper-recovery-1',
    vaultAddress: null,
    verifierIdentity: {
      environment: 'testnet',
      controllerId: 'hypercore-recovery-controller-v1',
      controllerCodeHash: new Uint8Array(32).fill(1),
      authorityModeId: 'agent-wallet-v1',
      actionBuilderCodeHash: new Uint8Array(32).fill(2),
    },
    trustedTimePolicy: {
      ntpHosts: ['time.google.com', 'time.cloudflare.com'],
      ntpTimeoutMs: 2_000,
      maximumNtpRoundTripMs: 500,
      maximumSourceSpreadMs: 10_000,
      maximumLocalClockSkewMs: 2_000,
      maximumFutureNonceLeadMs: 10_000,
      hyperliquidClockMarket: 'HYPE',
    },
  }), { mode: 0o600 });
  const config = loadHyperliquidRecoveryTestnetConfig({
    NARYX_HYPERLIQUID_TESTNET_RECOVERY_CONFIG: configPath,
  });
  assert.ok(config);
  assert.equal(config.agentWallet, agentWallet);
  const signer = loadHyperliquidRecoverySigner(config.keyPath, config.agentWallet);
  assert.equal(signer.signerScope, HYPERLIQUID_RECOVERY_SIGNER_SCOPE);
  assert.equal((await getWalletAddress(signer)).toLowerCase(), agentWallet);
});

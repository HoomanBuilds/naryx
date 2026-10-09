import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseProtocolJson } from '@naryx/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';
import type { HyperliquidTrustedTimePolicy } from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
  type HyperliquidRecoverySigner,
} from './hyperliquid-recovery-testnet-ports.js';
import type { HyperliquidRecoveryVerifierIdentity } from './hyperliquid-recovery-validation.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAXIMUM_CONFIG_BYTES = 65_536;
const MAXIMUM_KEY_BYTES = 4_096;
const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

export interface HyperliquidRecoveryTestnetConfig {
  readonly version: 1;
  readonly environment: 'HYPERLIQUID_TESTNET';
  readonly databasePath: string;
  readonly keyPath: string;
  readonly agentWallet: `0x${string}`;
  readonly signerLeaseId: string;
  readonly vaultAddress: `0x${string}` | null;
  readonly verifierIdentity: HyperliquidRecoveryVerifierIdentity;
  readonly trustedTimePolicy: HyperliquidTrustedTimePolicy;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Hyperliquid recovery config failed: ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value),
    `${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(keys.length === wanted.length
    && keys.every((key, index) => key === wanted[index]), `${name} fields are invalid`);
}

function address(value: unknown, name: string): `0x${string}` {
  requireCondition(typeof value === 'string' && ADDRESS.test(value), `${name} is invalid`);
  return value as `0x${string}`;
}

function externalPath(value: unknown, name: string): string {
  requireCondition(typeof value === 'string' && isAbsolute(value), `${name} must be absolute`);
  const path = resolve(value);
  const projectRelativePath = relative(PROJECT_ROOT, path);
  requireCondition(projectRelativePath === '..'
    || projectRelativePath.startsWith(`..${sep}`)
    || isAbsolute(projectRelativePath), `${name} must be outside the repository`);
  return path;
}

function existingExternalFile(value: unknown, name: string, maximumBytes: number): string {
  const path = externalPath(value, name);
  const state = lstatSync(path);
  requireCondition(state.isFile() && !state.isSymbolicLink(), `${name} must be a regular file`);
  requireCondition(realpathSync(path) === path, `${name} path must be canonical`);
  requireCondition(state.size > 0 && state.size <= maximumBytes, `${name} size is invalid`);
  return path;
}

export function loadHyperliquidRecoveryTestnetConfig(
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): HyperliquidRecoveryTestnetConfig | undefined {
  const configuredPath = environment.NARYX_HYPERLIQUID_TESTNET_RECOVERY_CONFIG;
  if (configuredPath === undefined || configuredPath === '') return undefined;
  const path = existingExternalFile(
    configuredPath,
    'NARYX_HYPERLIQUID_TESTNET_RECOVERY_CONFIG',
    MAXIMUM_CONFIG_BYTES,
  );
  const value = record(parseProtocolJson(readFile(path), 'hyperliquidRecoveryConfig'), 'config');
  exactKeys(value, [
    'agentWallet', 'databasePath', 'environment', 'keyPath', 'signerLeaseId',
    'trustedTimePolicy', 'vaultAddress', 'verifierIdentity', 'version',
  ], 'config');
  requireCondition(value.version === 1 && value.environment === 'HYPERLIQUID_TESTNET',
    'config identity is invalid');
  requireCondition(typeof value.signerLeaseId === 'string'
    && IDENTIFIER.test(value.signerLeaseId), 'signerLeaseId is invalid');
  const verifierIdentity = record(value.verifierIdentity, 'verifierIdentity');
  exactKeys(verifierIdentity, [
    'actionBuilderCodeHash', 'authorityModeId', 'controllerCodeHash',
    'controllerId', 'environment',
  ], 'verifierIdentity');
  const trustedTimePolicy = record(value.trustedTimePolicy, 'trustedTimePolicy');
  exactKeys(trustedTimePolicy, [
    'hyperliquidClockMarket', 'maximumFutureNonceLeadMs',
    'maximumLocalClockSkewMs', 'maximumNtpRoundTripMs',
    'maximumSourceSpreadMs', 'ntpHosts', 'ntpTimeoutMs',
  ], 'trustedTimePolicy');
  return Object.freeze({
    version: 1,
    environment: 'HYPERLIQUID_TESTNET',
    databasePath: externalPath(value.databasePath, 'databasePath'),
    keyPath: existingExternalFile(value.keyPath, 'keyPath', MAXIMUM_KEY_BYTES),
    agentWallet: address(value.agentWallet, 'agentWallet'),
    signerLeaseId: value.signerLeaseId,
    vaultAddress: value.vaultAddress === null ? null : address(value.vaultAddress, 'vaultAddress'),
    verifierIdentity: verifierIdentity as unknown as HyperliquidRecoveryVerifierIdentity,
    trustedTimePolicy: trustedTimePolicy as unknown as HyperliquidTrustedTimePolicy,
  });
}

export function loadHyperliquidRecoverySigner(
  pathValue: string,
  expectedAgentWallet: `0x${string}`,
): HyperliquidRecoverySigner {
  const path = existingExternalFile(pathValue, 'keyPath', MAXIMUM_KEY_BYTES);
  const state = lstatSync(path);
  requireCondition((state.mode & 0o077) === 0
    && (state.mode & 0o400) !== 0
    && (state.mode & 0o111) === 0,
  'keyPath permissions must be 0400 or 0600');
  if (typeof process.getuid === 'function') {
    requireCondition(state.uid === process.getuid(), 'keyPath must be owned by the current user');
  }
  const bytes = readFileSync(path);
  try {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('Hyperliquid recovery config failed: key file is malformed');
    }
    const key = record(value, 'key file');
    exactKeys(key, ['environment', 'privateKey', 'version'], 'key file');
    requireCondition(key.version === 1 && key.environment === 'HYPERLIQUID_TESTNET'
      && typeof key.privateKey === 'string' && PRIVATE_KEY.test(key.privateKey)
      && !/^0x0+$/.test(key.privateKey), 'key file identity is invalid');
    const account = privateKeyToAccount(key.privateKey as `0x${string}`);
    requireCondition(account.address.toLowerCase() === expectedAgentWallet,
      'key file does not match agentWallet');
    return Object.freeze({
      ...account,
      signerScope: HYPERLIQUID_RECOVERY_SIGNER_SCOPE,
    }) as HyperliquidRecoverySigner;
  } finally {
    bytes.fill(0);
  }
}

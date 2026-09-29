import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  type HyperliquidServerSigner,
} from './index.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const MAX_KEY_FILE_BYTES = 4_096;
const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

function externalAbsolutePath(value: string): string {
  if (!isAbsolute(value)) throw new Error('Hyperliquid Testnet agent key path must be absolute');
  const path = resolve(value);
  const projectRelativePath = relative(PROJECT_ROOT, path);
  if (projectRelativePath !== '..'
    && !projectRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(projectRelativePath)) {
    throw new Error('Hyperliquid Testnet agent key must be outside the repository');
  }
  return path;
}

export function loadHyperliquidTestnetAgentSigner(
  pathValue: string,
  expectedAgentAddress: string,
): HyperliquidServerSigner {
  if (!ADDRESS.test(expectedAgentAddress)) {
    throw new Error('expected Hyperliquid Testnet agent address must be lowercase');
  }
  const path = externalAbsolutePath(pathValue);
  const linkStatus = lstatSync(path);
  if (linkStatus.isSymbolicLink() || !linkStatus.isFile()) {
    throw new Error('Hyperliquid Testnet agent key path must be a regular file');
  }
  if (realpathSync(path) !== path) {
    throw new Error('Hyperliquid Testnet agent key path must be canonical');
  }
  if ((linkStatus.mode & 0o077) !== 0 || (linkStatus.mode & 0o400) === 0
    || (linkStatus.mode & 0o111) !== 0) {
    throw new Error('Hyperliquid Testnet agent key file permissions must be 0400 or 0600');
  }
  if (typeof process.getuid === 'function' && linkStatus.uid !== process.getuid()) {
    throw new Error('Hyperliquid Testnet agent key file must be owned by the current user');
  }
  if (linkStatus.size < 1 || linkStatus.size > MAX_KEY_FILE_BYTES) {
    throw new Error('Hyperliquid Testnet agent key file size is invalid');
  }

  const bytes = readFileSync(path);
  try {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('Hyperliquid Testnet agent key file is malformed');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Hyperliquid Testnet agent key file is malformed');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 3 || keys[0] !== 'environment' || keys[1] !== 'privateKey'
      || keys[2] !== 'version' || record.version !== 1 || record.environment !== 'TESTNET'
      || typeof record.privateKey !== 'string' || !PRIVATE_KEY.test(record.privateKey)
      || /^0x0+$/.test(record.privateKey)) {
      throw new Error('Hyperliquid Testnet agent key file fields are invalid');
    }
    const account = privateKeyToAccount(record.privateKey as `0x${string}`);
    if (account.address.toLowerCase() !== expectedAgentAddress) {
      throw new Error('Hyperliquid Testnet agent key does not match the expected agent address');
    }
    return Object.freeze({
      ...account,
      signerScope: HYPERLIQUID_SERVER_SIGNER_SCOPE,
    }) as HyperliquidServerSigner;
  } finally {
    bytes.fill(0);
  }
}

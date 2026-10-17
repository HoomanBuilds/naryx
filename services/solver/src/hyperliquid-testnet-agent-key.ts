import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
  encryptionKeyPath?: string,
): ReturnType<typeof privateKeyToAccount> & Pick<HyperliquidServerSigner, 'signerScope'> {
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
    let record = value as Record<string, unknown>;
    if (record.version === 2) {
      if (encryptionKeyPath === undefined || record.environment !== 'TESTNET'
        || Object.keys(record).sort().join(',') !== 'ciphertext,environment,iv,tag,version'
        || typeof record.iv !== 'string' || !/^[0-9a-f]{24}$/.test(record.iv)
        || typeof record.tag !== 'string' || !/^[0-9a-f]{32}$/.test(record.tag)
        || typeof record.ciphertext !== 'string' || !/^[0-9a-f]{132}$/.test(record.ciphertext)) {
        throw new Error('encrypted Hyperliquid Testnet agent key is invalid');
      }
      const encryptionKey = readEncryptionKey(encryptionKeyPath);
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'hex'));
        decipher.setAAD(Buffer.from('Naryx Hyperliquid TESTNET agent v2'));
        decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
        plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'hex')), decipher.final()]);
        record = { version: 1, environment: 'TESTNET', privateKey: plaintext.toString('utf8') };
      } finally { encryptionKey.fill(0); plaintext?.fill(0); }
    }
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
    });
  } finally {
    bytes.fill(0);
  }
}

function readEncryptionKey(pathValue: string): Buffer {
  const path = externalAbsolutePath(pathValue);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || realpathSync(path) !== path
    || status.size !== 32 || (status.mode & 0o077) !== 0 || (status.mode & 0o400) === 0
    || (status.mode & 0o111) !== 0
    || typeof process.getuid === 'function' && status.uid !== process.getuid()) {
    throw new Error('agent encryption key must be an external owner-only 32-byte file');
  }
  return readFileSync(path);
}

export function writeEncryptedHyperliquidTestnetAgentKey(pathValue: string, privateKey: `0x${string}`, encryptionKeyPath: string): void {
  const path = externalAbsolutePath(pathValue);
  if (!PRIVATE_KEY.test(privateKey) || /^0x0+$/.test(privateKey)) throw new Error('invalid Testnet agent key');
  const encryptionKey = readEncryptionKey(encryptionKeyPath);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from('Naryx Hyperliquid TESTNET agent v2'));
    const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
    writeFileSync(path, JSON.stringify({ version: 2, environment: 'TESTNET', iv: iv.toString('hex'),
      ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') }), { mode: 0o600, flag: 'wx' });
  } finally { encryptionKey.fill(0); }
}

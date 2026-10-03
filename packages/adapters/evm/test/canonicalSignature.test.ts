import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashMessage, recoverAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { isCanonicalEvmSignature } from '../src/index.js';

const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

test('only the low-s, v 27 or 28 form the contracts accept is canonical', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const hash = hashMessage('naryx canonical signature');
  const signature = await account.sign({ hash });
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130), 16);
  const highS = `0x${r}${(ORDER - s).toString(16).padStart(64, '0')}${v === 27 ? '1c' : '1b'}`;
  const zeroOne = `0x${r}${signature.slice(66, 130)}${(v - 27).toString(16).padStart(2, '0')}`;
  assert.equal(isCanonicalEvmSignature(signature), true);
  // Both variants recover the same signer off-chain, which is why off-chain checks must refuse them:
  // OpenZeppelin ECDSA, and so every Naryx contract, rejects them.
  assert.equal((await recoverAddress({ hash, signature: highS as `0x${string}` })).toLowerCase(), account.address.toLowerCase());
  assert.equal(isCanonicalEvmSignature(highS), false);
  assert.equal(isCanonicalEvmSignature(zeroOne), false);
  assert.equal(isCanonicalEvmSignature(`${signature}00`), false);
  assert.equal(isCanonicalEvmSignature(`0x${r}${'0'.repeat(64)}1b`), false);
});

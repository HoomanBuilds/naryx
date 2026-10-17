import assert from 'node:assert/strict';
import test from 'node:test';
import { commitmentHash } from '@naryx/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyNativeClearingControlSignature } from '../src/native-clearing-authorization.js';

test('clearing controls verify checksummed authority addresses without rewriting signed identity', async () => {
  const signer = privateKeyToAccount(`0x${'51'.repeat(32)}`);
  const digest = commitmentHash('11'.repeat(32));
  const authorization = { scheme: 'EIP191_SECP256K1' as const,
    signature: await signer.signMessage({ message: { raw: digest } }) };
  assert.notEqual(signer.address, signer.address.toLowerCase());
  assert.equal(await verifyNativeClearingControlSignature(signer.address, digest, authorization), true);
  assert.equal(await verifyNativeClearingControlSignature(signer.address.toLowerCase(), digest, authorization), true);
  assert.equal(await verifyNativeClearingControlSignature(signer.address, commitmentHash('22'.repeat(32)), authorization), false);
  assert.equal(await verifyNativeClearingControlSignature('0x0000000000000000000000000000000000000000', digest, authorization), false);
  assert.equal(await verifyNativeClearingControlSignature(signer.address.replace('0x', '0X'), digest, authorization), false);
});

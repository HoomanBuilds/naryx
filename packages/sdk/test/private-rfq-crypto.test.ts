import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { domainRef } from '@naryx/protocol-types';
import {
  NARYX_RFQ_HPKE_SUITE_ID,
  NaryxPrivateRfqCryptoError,
  decryptPrivateRfqRequest,
  decryptPrivateRfqResponse,
  encryptPrivateRfqRequest,
  encryptPrivateRfqResponse,
  generateNaryxRfqHpkeKeyPair,
  type PrivateRfqEnvelopeHeaderInput,
} from '../src/index.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);
const hash = (fill: string): string => fill.repeat(64);

function header(responseEncryptionKey: Uint8Array, recipientEncryptionKeyId = 'rfq-key-1'): PrivateRfqEnvelopeHeaderInput {
  return {
    envelopeVersion: 1,
    environment: 'testnet',
    domain: domainRef('hypercore-testnet', 1, hash('1')),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: hash('2'),
    orderHash: hash('3'),
    senderKeyId: 'taker-key-1',
    responseEncryptionKey,
    recipientSolverId: 'solver-a',
    recipientEncryptionKeyId,
    encryptionSuiteId: NARYX_RFQ_HPKE_SUITE_ID,
    createdAtUnit: 'EVM_UNIX_SECONDS',
    createdAtValue: 100n,
    expiresAtUnit: 'EVM_UNIX_SECONDS',
    expiresAtValue: 200n,
    envelopeNonce: 1n,
  };
}

describe('private RFQ HPKE suite', () => {
  test('encrypts a request for only the selected solver key', async () => {
    const solver = await generateNaryxRfqHpkeKeyPair();
    const wrongSolver = await generateNaryxRfqHpkeKeyPair();
    const response = await generateNaryxRfqHpkeKeyPair();
    const encrypted = await encryptPrivateRfqRequest({
      header: header(response.publicKey),
      recipientPublicKey: solver.publicKey,
      plaintext: bytes('private package order'),
    });

    assert.equal(text(await decryptPrivateRfqRequest({ ...encrypted, recipientPrivateKey: solver.privateKey })), 'private package order');
    await assert.rejects(
      decryptPrivateRfqRequest({ ...encrypted, recipientPrivateKey: wrongSolver.privateKey }),
      NaryxPrivateRfqCryptoError,
    );
  });

  test('authenticates ciphertext and every envelope header field', async () => {
    const solver = await generateNaryxRfqHpkeKeyPair();
    const response = await generateNaryxRfqHpkeKeyPair();
    const encrypted = await encryptPrivateRfqRequest({
      header: header(response.publicKey),
      recipientPublicKey: solver.publicKey,
      plaintext: bytes('package'),
    });
    const tamperedCiphertext = Uint8Array.from(encrypted.ciphertext);
    const last = tamperedCiphertext.length - 1;
    tamperedCiphertext[last] = (tamperedCiphertext[last] as number) ^ 1;
    await assert.rejects(
      decryptPrivateRfqRequest({ envelope: encrypted.envelope, ciphertext: tamperedCiphertext, recipientPrivateKey: solver.privateKey }),
      /ciphertext hash mismatch/,
    );
    await assert.rejects(
      decryptPrivateRfqRequest({
        envelope: { ...encrypted.envelope, envelopeNonce: 2n },
        ciphertext: encrypted.ciphertext,
        recipientPrivateKey: solver.privateKey,
      }),
      /decryption failed/,
    );
  });

  test('encrypts a response to the taker key and binds its quote metadata', async () => {
    const solver = await generateNaryxRfqHpkeKeyPair();
    const responseKey = await generateNaryxRfqHpkeKeyPair();
    const request = await encryptPrivateRfqRequest({
      header: header(responseKey.publicKey),
      recipientPublicKey: solver.publicKey,
      plaintext: bytes('package'),
    });
    const encrypted = await encryptPrivateRfqResponse({
      envelope: request.envelope,
      solverId: 'solver-a',
      quoteHash: hash('4'),
      quoteOrderHash: hash('3'),
      plaintext: bytes('signed solver quote'),
    });

    assert.equal(text(await decryptPrivateRfqResponse({
      envelope: request.envelope,
      solverId: 'solver-a',
      quoteHash: hash('4'),
      quoteOrderHash: hash('3'),
      ciphertext: encrypted.ciphertext,
      responsePrivateKey: responseKey.privateKey,
    })), 'signed solver quote');
    await assert.rejects(
      decryptPrivateRfqResponse({
        envelope: request.envelope,
        solverId: 'solver-a',
        quoteHash: hash('5'),
        quoteOrderHash: hash('3'),
        ciphertext: encrypted.ciphertext,
        responsePrivateKey: responseKey.privateKey,
      }),
      /decryption failed/,
    );
  });

  test('rejects an unpinned suite before encryption', async () => {
    const solver = await generateNaryxRfqHpkeKeyPair();
    const response = await generateNaryxRfqHpkeKeyPair();
    await assert.rejects(
      encryptPrivateRfqRequest({
        header: { ...header(response.publicKey), encryptionSuiteId: 'legacy-suite' },
        recipientPublicKey: solver.publicKey,
        plaintext: bytes('package'),
      }),
      /unsupported private RFQ encryption suite/,
    );
  });
});

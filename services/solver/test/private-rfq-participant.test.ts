import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  NARYX_RFQ_HPKE_SUITE_ID,
  decodePrivateRfqQuoteResponse,
  decryptPrivateRfqResponse,
  domainRef,
  encodePrivateRfqQuoteRequest,
  encryptPrivateRfqRequest,
  generateNaryxRfqHpkeKeyPair,
  privateRfqEnvelopeHash,
  toHex,
} from '@naryx/protocol-types';
import {
  PrivateRfqParticipant,
  type GeneralizedStrategyQuoteResponse,
  type PrivateRfqRelayPort,
} from '../src/index.js';

const hash = (fill: string): string => fill.repeat(64);

test('decrypts an authenticated private request and returns only an encrypted signed quote', async () => {
  const solverKey = await generateNaryxRfqHpkeKeyPair();
  const responseKey = await generateNaryxRfqHpkeKeyPair();
  const sender = generateKeyPairSync('ed25519');
  const senderSpki = sender.publicKey.export({ format: 'der', type: 'spki' });
  const senderKeyId = bs58.encode(senderSpki.subarray(senderSpki.length - 32));
  const orderHash = hash('5');
  const encrypted = await encryptPrivateRfqRequest({
    header: {
      envelopeVersion: 1,
      environment: 'testnet',
      domain: domainRef('eip155:84532', 1, hash('1')),
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: hash('2'),
      orderHash,
      senderKeyId,
      responseEncryptionKey: responseKey.publicKey,
      recipientSolverId: 'solver-a',
      recipientEncryptionKeyId: 'rfq-key-1',
      encryptionSuiteId: NARYX_RFQ_HPKE_SUITE_ID,
      createdAtUnit: 'EVM_UNIX_SECONDS',
      createdAtValue: 100n,
      expiresAtUnit: 'EVM_UNIX_SECONDS',
      expiresAtValue: 200n,
      envelopeNonce: 1n,
    },
    recipientPublicKey: solverKey.publicKey,
    plaintext: encodePrivateRfqQuoteRequest({ version: 1, orderHash }),
  });
  const envelopeHash = toHex(privateRfqEnvelopeHash(encrypted.envelope));
  const senderSignature = new Uint8Array(sign(null, privateRfqEnvelopeHash(encrypted.envelope), sender.privateKey));
  const responses: Parameters<PrivateRfqRelayPort['respond']>[] = [];
  const relay: PrivateRfqRelayPort = {
    pending: async () => [{
      envelopeHash,
      envelope: encrypted.envelope,
      ciphertext: encrypted.ciphertext,
      senderSignature,
    }],
    respond: async (...input) => { responses.push(input); },
  };
  const quoteHash = hash('7');
  const quoteResponse = {
    version: 1,
    status: 'SIGNED',
    idempotencyKey: `private-rfq.${envelopeHash}`,
    orderHash,
    graphHash: hash('3'),
    routeHash: hash('4'),
    quoteHash,
    route: {},
    quote: {
      environment: 'testnet',
      solverId: 'solver-a',
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: new Uint8Array(32).fill(0x22),
      domains: [domainRef('eip155:84532', 1, hash('1'))],
    },
  } as unknown as GeneralizedStrategyQuoteResponse;
  const participant = new PrivateRfqParticipant({
    solverId: 'solver-a',
    encryptionKeyId: 'rfq-key-1',
    privateKey: solverKey.privateKey,
    relay,
    quotes: {
      quote: async (request) => {
        assert.deepEqual(request, { orderHash, idempotencyKey: `private-rfq.${envelopeHash}` });
        return quoteResponse;
      },
    },
  });

  await participant.tick();
  assert.equal(responses.length, 1);
  const [respondedHash, response] = responses[0] as Parameters<PrivateRfqRelayPort['respond']>;
  assert.equal(respondedHash, envelopeHash);
  assert.equal(response.quoteHash, quoteHash);
  assert.equal(response.quoteOrderHash, orderHash);
  const plaintext = await decryptPrivateRfqResponse({
    envelope: encrypted.envelope,
    solverId: 'solver-a',
    quoteHash,
    quoteOrderHash: orderHash,
    ciphertext: response.responseCiphertext,
    responsePrivateKey: responseKey.privateKey,
  });
  assert.deepEqual(decodePrivateRfqQuoteResponse(plaintext), quoteResponse);

  const mismatched = new PrivateRfqParticipant({
    solverId: 'solver-a',
    encryptionKeyId: 'rfq-key-1',
    privateKey: solverKey.privateKey,
    relay,
    quotes: {
      quote: async () => ({
        ...quoteResponse,
        quote: { ...quoteResponse.quote, templateId: 'another-template' },
      } as GeneralizedStrategyQuoteResponse),
    },
  });
  await assert.rejects(mismatched.tick(), /private RFQ quote does not match its envelope/);
});

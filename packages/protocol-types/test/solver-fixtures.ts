import {
  assetRef,
  domainRef,
  type SolverCapabilityManifestInput,
} from '../src/index.js';

export const DOMAIN = domainRef('svm:solana-devnet', 1, '22'.repeat(32));
export const USD = assetRef('usdc', '33'.repeat(32), 6);
export const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

export function manifestInput(overrides: Partial<SolverCapabilityManifestInput> = {}): SolverCapabilityManifestInput {
  return {
    manifestVersion: 1,
    environment: 'local',
    solverId: 'solver-a',
    commonControlGroupId: 'org-a',
    operatorIdentityScheme: 'ED25519',
    operatorIdentityKey: key(1),
    quoteVerificationKeys: [
      { keyId: 'q-1', scheme: 'ED25519', verificationKey: key(2), validFromValue: 0n, validUntilValue: 100n },
      { keyId: 'q-2', scheme: 'ED25519', verificationKey: key(3), validFromValue: 100n, validUntilValue: 200n },
    ],
    rfqEncryptionKeys: [],
    supportedDomains: [DOMAIN],
    supportedTemplateIds: ['cash-and-carry-v1'],
    supportedQuoteModes: ['IMPLIED', 'FIRM_ONCHAIN'],
    maximumNotionalByMarket: [{ marketId: 'sol-carry', quoteAsset: USD, maximumNotionalAtoms: 1_000n }],
    rfqEndpoints: ['https://solver-a.example/rfq'],
    validityUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: 150n,
    manifestNonce: 1n,
    signature: new Uint8Array(64).fill(9),
    ...overrides,
  };
}


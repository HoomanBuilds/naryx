import { generateKeyPairSync, sign } from "node:crypto";
import { assetRef, domainManifestHash, domainRef, solverCapabilityManifestHash } from "@naryx/protocol-types";
import type { DomainManifestInput, SolverCapabilityManifestInput } from "@naryx/protocol-types";

export const DOMAIN_MANIFEST: DomainManifestInput = {
  manifestVersion: 1,
  environment: "testnet",
  domainId: "svm:test-domain-1",
  runtimeClassId: "svm-program-v1",
  runtimeClassVersion: 1,
  chainNamespace: "svm",
  chainReference: "test-domain-1",
  executionVerifierId: "package-verifier-v1",
  executionVerifierCodeHash: "11".repeat(32),
  clockModelId: "solana-last-valid-block-height",
  finalityPolicyHash: "22".repeat(32),
  addressCodecId: "solana-pubkey-32",
  supportedSettlementClasses: ["BATCHED_IOC_WITH_RECOVERY", "ATOMIC_POSTCONDITION"],
};

export function operatorKeys(): { publicKey: Uint8Array; signHash: (hash: Uint8Array) => Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: new Uint8Array(raw), signHash: (hash) => new Uint8Array(sign(null, hash, privateKey)) };
}

export function signedSolverManifest(
  operator: ReturnType<typeof operatorKeys>,
  overrides: Partial<SolverCapabilityManifestInput> = {},
): SolverCapabilityManifestInput {
  const unsigned: SolverCapabilityManifestInput = {
    manifestVersion: 1,
    environment: "testnet",
    solverId: "solver-a",
    commonControlGroupId: "org-a",
    operatorIdentityScheme: "ED25519",
    operatorIdentityKey: operator.publicKey,
    quoteVerificationKeys: [{ keyId: "q-1", scheme: "ED25519", verificationKey: new Uint8Array(32).fill(2), validFromValue: 0n, validUntilValue: 1_000_000n }],
    rfqEncryptionKeys: [],
    supportedDomains: [domainRef(DOMAIN_MANIFEST.domainId, 1, domainManifestHash(DOMAIN_MANIFEST))],
    supportedTemplateIds: ["cash-and-carry-v1"],
    supportedQuoteModes: ["IMPLIED", "FIRM_ONCHAIN"],
    maximumNotionalByMarket: [{ marketId: "sol-carry", quoteAsset: assetRef("usdc", "33".repeat(32), 6), maximumNotionalAtoms: 1_000n }],
    rfqEndpoints: ["https://solver-a.example/rfq"],
    validityUnit: "EVM_UNIX_SECONDS",
    validUntilValue: 2_000_000n,
    manifestNonce: 1n,
    signature: new Uint8Array(64),
    ...overrides,
  };
  return { ...unsigned, signature: operator.signHash(solverCapabilityManifestHash(unsigned)) };
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_UPGRADEABLE_LOADER_ID,
  solanaIdlContentHash,
  solanaProgramDataHeaderIdentity,
  solanaProgramElfSha256,
  type SolanaDeploymentIdentityReadPort,
  type SolanaDevnetProgramExpectation,
  type SolanaReadOnlyRpc,
} from "@naryx/adapter-solana";
import { PublicKey } from "@solana/web3.js";
import type { ExecutionIntentStore } from "../src/execution-intent-store.js";
import type { InternalOrderStore } from "../src/internal-order-store.js";
import { SqlitePackageLifecycleStore } from "../src/package-lifecycle-store.js";
import { createSolanaDevnetRuntime, type SolanaDevnetRuntimeManifest } from "../src/solana-devnet-runtime.js";

const coreIdl = JSON.parse(readFileSync(
  new URL("../../../../deployments/solana/program/idl/naryx_core.json", import.meta.url),
  "utf8",
));
const hash = (byte: number) => new Uint8Array(32).fill(byte);

function programs(): readonly SolanaDevnetProgramExpectation[] {
  const ids = [
    new PublicKey(coreIdl.address),
    new PublicKey(hash(102)),
    new PublicKey(hash(103)),
    new PublicKey(hash(104)),
    new PublicKey(hash(105)),
  ];
  return ["core", "reservation", "package_book", "perp_adapter", "perp_venue"].map((name, index) => ({
    name,
    programId: ids[index]!.toBase58(),
    programDataAddress: PublicKey.findProgramAddressSync(
      [ids[index]!.toBuffer()],
      SOLANA_UPGRADEABLE_LOADER_ID,
    )[0].toBase58(),
    deploymentSlot: BigInt(10 + index),
    upgradeAuthority: { kind: "IMMUTABLE" as const },
    programDataHeaderIdentity: solanaProgramDataHeaderIdentity(programDataAccount(BigInt(10 + index), index + 1).data),
    programElfSha256: solanaProgramElfSha256(programDataAccount(BigInt(10 + index), index + 1).data.subarray(45)),
  }));
}

function programAccount(programData: PublicKey) {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programData.toBuffer().copy(data, 4);
  return { owner: SOLANA_UPGRADEABLE_LOADER_ID, executable: true, data };
}

function programDataAccount(slot: bigint, byte: number) {
  const data = Buffer.alloc(46, byte);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(slot, 4);
  data[12] = 0;
  return { owner: SOLANA_UPGRADEABLE_LOADER_ID, executable: false, data };
}

function deploymentRpc(expectations: readonly SolanaDevnetProgramExpectation[], genesis = SOLANA_DEVNET_GENESIS_HASH): SolanaDeploymentIdentityReadPort {
  return {
    getGenesisHash: async () => genesis,
    getContextSlot: async () => 50,
    getMultipleAccounts: async () => ({
      contextSlot: 50,
      accounts: expectations.flatMap((program, index) => [
        programAccount(new PublicKey(program.programDataAddress)),
        programDataAccount(program.deploymentSlot, index + 1),
      ]),
    }),
  };
}

function manifest(expectations: readonly SolanaDevnetProgramExpectation[] = programs()): SolanaDevnetRuntimeManifest {
  return {
    schemaVersion: 1,
    activationState: "ACTIVE",
    domain: { domainId: "svm:devnet", domainManifestVersion: 1, domainManifestHash: hash(7) } as SolanaDevnetRuntimeManifest["domain"],
    expectedGenesisHash: SOLANA_DEVNET_GENESIS_HASH,
    programs: expectations,
    lookupTables: [],
    coreIdl,
    expectedCoreIdlHash: solanaIdlContentHash(coreIdl),
    admission: {} as SolanaDevnetRuntimeManifest["admission"],
    evidence: {
      evidenceClass: "SOLANA_FINALIZED_ACCOUNT_EVIDENCE_V1",
      settlementClass: "ATOMIC_POSTCONDITION",
      quoteMode: "FIRM_ONCHAIN",
      executionPlanKind: "SVM_ATOMIC_CPI",
      packetDataLimit: 1232,
      maxResolvedAddresses: 64,
      maxRouteComputeUnits: 1260000,
    },
  };
}

function runtimeDependencies(expectations: readonly SolanaDevnetProgramExpectation[], directory: string) {
  const rpcUrl = "https://solana-devnet.invalid";
  const materializerRpc: SolanaReadOnlyRpc = {
    rpcUrl,
    getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
    getLatestBlockhash: async () => { throw new Error("not called"); },
    getLookupTable: async () => { throw new Error("not called"); },
  };
  const observationRpc = {
    getGenesisHash: async () => SOLANA_DEVNET_GENESIS_HASH,
    getSignatureStatus: async () => null,
    getBlockHeight: async () => 1,
    getMultipleAccounts: async () => ({ contextSlot: 1, accounts: [] }),
  };
  return {
    rpcUrl,
    preparedStorePath: join(directory, "prepared.db"),
    intents: {} as ExecutionIntentStore,
    orders: {} as InternalOrderStore,
    lifecycle: new SqlitePackageLifecycleStore(join(directory, "lifecycle.db")),
    bindings: { readBinding: async () => { throw new Error("not called"); } },
    deploymentRpc: deploymentRpc(expectations),
    materializerRpc,
    observationRpc,
    currentSlot: async () => 50n,
  };
}

test("composes a signerless Solana Devnet runtime from reviewed active configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-solana-runtime-"));
  const expectations = programs();
  const dependencies = runtimeDependencies(expectations, directory);
  try {
    const runtime = await createSolanaDevnetRuntime({ manifest: manifest(expectations), ...dependencies });
    assert.equal(typeof runtime.preparation?.prepare, "function");
    assert.equal(typeof runtime.observation?.observe, "function");
  } finally {
    dependencies.lifecycle.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects wrong genesis, program identity, and evidence configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "naryx-solana-runtime-reject-"));
  const expectations = programs();
  const dependencies = runtimeDependencies(expectations, directory);
  try {
    await assert.rejects(
      createSolanaDevnetRuntime({
        manifest: manifest(expectations),
        ...dependencies,
        deploymentRpc: deploymentRpc(expectations, "wrong-genesis"),
      }),
      /not Solana Devnet/,
    );
    const wrongProgramRpc = deploymentRpc(expectations);
    await assert.rejects(
      createSolanaDevnetRuntime({
        manifest: manifest(expectations),
        ...dependencies,
        deploymentRpc: {
          ...wrongProgramRpc,
          getMultipleAccounts: async (addresses, minContextSlot) => {
            const snapshot = await wrongProgramRpc.getMultipleAccounts(addresses, minContextSlot);
            const accounts = [...snapshot.accounts];
            accounts[0] = programAccount(new PublicKey(hash(199)));
            return { ...snapshot, accounts };
          },
        },
      }),
      /ProgramData linkage mismatch/,
    );
    await assert.rejects(
      createSolanaDevnetRuntime({
        manifest: {
          ...manifest(expectations),
          evidence: { ...manifest(expectations).evidence, maxRouteComputeUnits: 1 } as never,
        },
        ...dependencies,
      }),
      /unsupported domain, bound, or evidence class/,
    );
  } finally {
    dependencies.lifecycle.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { web3 } from "@anchor-lang/core";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  UPGRADEABLE_LOADER_ID,
  parseCandidateReleaseManifest,
  programDataHeaderIdentity,
  verifyCandidateRelease,
} from "./verify-devnet-release.mjs";

const programId = new web3.PublicKey(new Uint8Array(32).fill(1));
const programDataAddress = new web3.PublicKey(new Uint8Array(32).fill(2));
const authority = new web3.PublicKey(new Uint8Array(32).fill(3));
const deployedBytes = Buffer.from("reviewed-program-bytes");

function programAccount() {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programDataAddress.toBuffer().copy(data, 4);
  return { data, executable: true, owner: UPGRADEABLE_LOADER_ID };
}

function programDataAccount(padding = 16) {
  const data = Buffer.alloc(45 + deployedBytes.length + padding);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(42n, 4);
  data[12] = 1;
  authority.toBuffer().copy(data, 13);
  deployedBytes.copy(data, 45);
  return { data, executable: false, owner: UPGRADEABLE_LOADER_ID };
}

function candidate(artifactPath) {
  return {
    schemaVersion: 1,
    cluster: "solana-devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    programs: [{
      name: "naryx_core",
      programId: programId.toBase58(),
      programDataAddress: programDataAddress.toBase58(),
      deploymentSlot: 42,
      upgradeAuthority: authority.toBase58(),
      artifactPath,
    }],
  };
}

test("verifies a candidate using read-only account evidence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "naryx-devnet-preflight-"));
  try {
    const artifactPath = join(scratch, "naryx_core.so");
    const manifestPath = join(scratch, "candidate.json");
    writeFileSync(artifactPath, deployedBytes);
    const manifest = parseCandidateReleaseManifest(candidate(artifactPath), manifestPath);
    const evidence = await verifyCandidateRelease(manifest, {
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
      getMultipleAccountsInfo: async () => [programAccount(), programDataAccount()],
    });
    assert.equal(evidence.programs[0].deploymentSlot, "42");
    assert.equal(evidence.programs[0].upgradeAuthority, authority.toBase58());
    assert.equal(evidence.programs[0].artifactSha256, evidence.programs[0].programElfSha256);
    assert.equal(
      evidence.programs[0].programDataHeaderIdentity,
      programDataHeaderIdentity(programDataAccount().data),
    );
    const pinned = parseCandidateReleaseManifest({
      ...candidate(artifactPath),
      programs: [{
        ...candidate(artifactPath).programs[0],
        programDataHeaderIdentity: evidence.programs[0].programDataHeaderIdentity,
      }],
    }, manifestPath);
    await assert.rejects(
      verifyCandidateRelease(pinned, {
        getGenesisHash: async () => DEVNET_GENESIS_HASH,
        getMultipleAccountsInfo: async () => [programAccount(), programDataAccount(17)],
      }),
      /header identity does not match/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("rejects mainnet and mismatched ProgramData linkage", async () => {
  const manifest = parseCandidateReleaseManifest(candidate(undefined), "/tmp/candidate.json");
  await assert.rejects(
    verifyCandidateRelease(manifest, {
      getGenesisHash: async () => MAINNET_GENESIS_HASH,
      getMultipleAccountsInfo: async () => { throw new Error("must not read accounts"); },
    }),
    /refusing Solana mainnet genesis/,
  );
  const wrongProgram = programAccount();
  wrongProgram.data.fill(9, 4);
  await assert.rejects(
    verifyCandidateRelease(manifest, {
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
      getMultipleAccountsInfo: async () => [wrongProgram, programDataAccount()],
    }),
    /ProgramData linkage does not match/,
  );
});

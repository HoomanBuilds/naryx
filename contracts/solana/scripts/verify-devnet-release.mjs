import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { web3 } from "@anchor-lang/core";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const UPGRADEABLE_LOADER_ID = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROGRAM_STATE = 2;
const PROGRAM_DATA_STATE = 3;
const PROGRAM_DATA_METADATA_SIZE = 45;
export const PROGRAM_DATA_HEADER_IDENTITY_DOMAIN = "naryx.program-data-header.v1";

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
}

function publicKey(value, name) {
  const source = text(value, name);
  let key;
  try {
    key = new web3.PublicKey(source);
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
  if (key.toBase58() !== source) throw new Error(`${name} must be canonical base58`);
  return key;
}

function hash(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function nonnegativeSlot(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return BigInt(value);
}

export function parseCandidateReleaseManifest(value, manifestPath) {
  const input = record(value, "candidate release manifest");
  if (input.schemaVersion !== 1 || input.cluster !== "solana-devnet") {
    throw new Error("candidate release manifest must target solana-devnet schema version 1");
  }
  if (input.genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("candidate release manifest has the wrong Devnet genesis hash");
  }
  if (!Array.isArray(input.programs) || input.programs.length === 0) {
    throw new Error("candidate release manifest must declare at least one program");
  }
  const names = new Set();
  const programIds = new Set();
  const programDataAddresses = new Set();
  const baseDirectory = dirname(manifestPath);
  const programs = input.programs.map((candidate, index) => {
    const item = record(candidate, `programs[${index}]`);
    const name = text(item.name, `programs[${index}].name`);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || names.has(name)) {
      throw new Error(`programs[${index}].name must be unique and canonical`);
    }
    names.add(name);
    const programId = publicKey(item.programId, `programs[${index}].programId`);
    const programDataAddress = publicKey(
      item.programDataAddress,
      `programs[${index}].programDataAddress`,
    );
    if (programIds.has(programId.toBase58()) || programDataAddresses.has(programDataAddress.toBase58())) {
      throw new Error("candidate release manifest program identities must be unique");
    }
    programIds.add(programId.toBase58());
    programDataAddresses.add(programDataAddress.toBase58());
    const upgradeAuthority = item.upgradeAuthority === null
      ? null
      : publicKey(item.upgradeAuthority, `programs[${index}].upgradeAuthority`);
    const artifactPathValue = item.artifactPath === undefined
      ? undefined
      : text(item.artifactPath, `programs[${index}].artifactPath`);
    return Object.freeze({
      name,
      programId,
      programDataAddress,
      deploymentSlot: nonnegativeSlot(item.deploymentSlot, `programs[${index}].deploymentSlot`),
      upgradeAuthority,
      artifactPath: artifactPathValue === undefined
        ? undefined
        : resolve(baseDirectory, artifactPathValue),
      artifactSha256: hash(item.artifactSha256, `programs[${index}].artifactSha256`),
      programElfSha256: hash(item.programElfSha256, `programs[${index}].programElfSha256`),
      programDataHeaderIdentity: hash(
        item.programDataHeaderIdentity,
        `programs[${index}].programDataHeaderIdentity`,
      ),
    });
  });
  return Object.freeze({ schemaVersion: 1, cluster: "solana-devnet", programs });
}

export function decodeProgramAccount(data, name) {
  if (!Buffer.isBuffer(data) || data.length !== 36 || data.readUInt32LE(0) !== PROGRAM_STATE) {
    throw new Error(`${name} has invalid upgradeable Program state`);
  }
  return new web3.PublicKey(data.subarray(4, 36));
}

export function decodeProgramDataAccount(data, name) {
  if (!Buffer.isBuffer(data)
    || data.length <= PROGRAM_DATA_METADATA_SIZE
    || data.readUInt32LE(0) !== PROGRAM_DATA_STATE) {
    throw new Error(`${name} has invalid upgradeable ProgramData state`);
  }
  const deploymentSlot = data.readBigUInt64LE(4);
  const option = data[12];
  if (option !== 0 && option !== 1) throw new Error(`${name} has invalid upgrade authority state`);
  const upgradeAuthority = option === 0
    ? null
    : new web3.PublicKey(data.subarray(13, 45));
  return Object.freeze({
    deploymentSlot,
    upgradeAuthority,
    deployedBytes: data.subarray(PROGRAM_DATA_METADATA_SIZE),
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Matches the on-chain identity in naryx_core program_identity.rs.
export function programDataHeaderIdentity(data) {
  decodeProgramDataAccount(data, "ProgramData");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(data.length));
  return createHash("sha256")
    .update(PROGRAM_DATA_HEADER_IDENTITY_DOMAIN)
    .update(data.subarray(0, PROGRAM_DATA_METADATA_SIZE))
    .update(length)
    .digest("hex");
}

// Trailing zero padding is stripped, matching `solana-verify get-program-hash`.
export function programElfSha256(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0) throw new Error("program ELF must not be empty");
  return sha256(bytes.subarray(0, end));
}

export async function verifyCandidateRelease(manifest, rpc) {
  const observedGenesisHash = await rpc.getGenesisHash();
  if (observedGenesisHash === MAINNET_GENESIS_HASH) {
    throw new Error("refusing Solana mainnet genesis");
  }
  if (observedGenesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(`unexpected Solana genesis hash: ${observedGenesisHash}`);
  }
  const addresses = manifest.programs.flatMap((program) => [
    program.programId,
    program.programDataAddress,
  ]);
  const accounts = await rpc.getMultipleAccountsInfo(addresses, "confirmed");
  if (!Array.isArray(accounts) || accounts.length !== addresses.length) {
    throw new Error("RPC returned an incomplete program account set");
  }
  const evidence = [];
  for (const [index, program] of manifest.programs.entries()) {
    const programAccount = accounts[index * 2];
    const programDataAccount = accounts[index * 2 + 1];
    if (programAccount === null || programDataAccount === null) {
      throw new Error(`${program.name} program or ProgramData account is missing`);
    }
    if (!programAccount.executable || !programAccount.owner.equals(UPGRADEABLE_LOADER_ID)) {
      throw new Error(`${program.name} is not an executable upgradeable-loader program`);
    }
    if (programDataAccount.executable || !programDataAccount.owner.equals(UPGRADEABLE_LOADER_ID)) {
      throw new Error(`${program.name} ProgramData account has invalid ownership or executable state`);
    }
    const linkedProgramData = decodeProgramAccount(programAccount.data, program.name);
    if (!linkedProgramData.equals(program.programDataAddress)) {
      throw new Error(`${program.name} ProgramData linkage does not match the candidate manifest`);
    }
    const programData = decodeProgramDataAccount(programDataAccount.data, program.name);
    if (programData.deploymentSlot !== program.deploymentSlot) {
      throw new Error(`${program.name} deployment slot does not match the candidate manifest`);
    }
    const observedAuthority = programData.upgradeAuthority?.toBase58() ?? null;
    const expectedAuthority = program.upgradeAuthority?.toBase58() ?? null;
    if (observedAuthority !== expectedAuthority) {
      throw new Error(`${program.name} upgrade authority does not match the candidate manifest`);
    }
    const headerIdentity = programDataHeaderIdentity(programDataAccount.data);
    if (program.programDataHeaderIdentity !== undefined
      && headerIdentity !== program.programDataHeaderIdentity) {
      throw new Error(`${program.name} ProgramData header identity does not match the candidate manifest`);
    }
    const deployedElfSha256 = programElfSha256(programData.deployedBytes);
    if (program.programElfSha256 !== undefined && deployedElfSha256 !== program.programElfSha256) {
      throw new Error(`${program.name} program ELF hash does not match the candidate manifest`);
    }
    let artifactSha256 = program.artifactSha256;
    if (program.artifactPath !== undefined) {
      artifactSha256 = programElfSha256(readFileSync(program.artifactPath));
      if (program.artifactSha256 !== undefined && artifactSha256 !== program.artifactSha256) {
        throw new Error(`${program.name} artifact hash does not match the candidate manifest`);
      }
    }
    if (artifactSha256 !== undefined && artifactSha256 !== deployedElfSha256) {
      throw new Error(`${program.name} artifact and deployed ELF differ`);
    }
    evidence.push(Object.freeze({
      name: program.name,
      programId: program.programId.toBase58(),
      programDataAddress: program.programDataAddress.toBase58(),
      deploymentSlot: programData.deploymentSlot.toString(),
      upgradeAuthority: observedAuthority,
      programDataLength: programDataAccount.data.length,
      programDataHeaderIdentity: headerIdentity,
      programElfSha256: deployedElfSha256,
      artifactSha256: artifactSha256 ?? null,
    }));
  }
  return Object.freeze({
    rpcUrl: DEVNET_RPC_URL,
    genesisHash: observedGenesisHash,
    programs: Object.freeze(evidence),
  });
}

function manifestArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--manifest" || !isAbsolute(argv[1])) {
    throw new Error("usage: node scripts/verify-devnet-release.mjs --manifest /absolute/path.json");
  }
  return resolve(argv[1]);
}

async function main() {
  const manifestPath = manifestArgument(process.argv.slice(2));
  const manifest = parseCandidateReleaseManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );
  const connection = new web3.Connection(DEVNET_RPC_URL, "confirmed");
  const evidence = await verifyCandidateRelease(manifest, connection);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

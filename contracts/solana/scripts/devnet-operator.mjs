// Shared, signer-safe helpers for the Solana Devnet operator scripts. Nothing here sends a
// transaction by itself: every write goes through `executeStep`, which only simulates unless the
// caller passed `--send`, and every connection is checked against the Devnet genesis hash first.
import anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVNET_GENESIS_HASH, DEVNET_RPC_URL, MAINNET_GENESIS_HASH } from "./verify-devnet-release.mjs";

const { web3 } = anchor;

export { DEVNET_GENESIS_HASH, DEVNET_RPC_URL, MAINNET_GENESIS_HASH };

export const TOKEN_PROGRAM_ID = new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const UPGRADEABLE_LOADER_ID = new web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
export const REPOSITORY_ROOT = resolve(CONTRACTS_DIRECTORY, "../..");

/**
 * Strict `--flag value` parsing. Unknown flags, repeated flags, and positional arguments fail.
 * `booleans` names flags that take no value.
 */
export function parseFlags(argv, allowed, booleans = []) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (!allowed.includes(name) && !booleans.includes(name)) throw new Error(`unknown flag --${name}`);
    if (Object.hasOwn(flags, name)) throw new Error(`--${name} was given twice`);
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

/** The cluster must be named explicitly; no default, no alias, no URL. */
export function requireDevnetCluster(flags) {
  if (flags.cluster !== "devnet") throw new Error("--cluster devnet is required");
}

export function absolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function insideRepository(path) {
  return path === REPOSITORY_ROOT || path.startsWith(REPOSITORY_ROOT + sep);
}

/**
 * Loads a Devnet-only Solana CLI keypair file. The file must live outside the repository, must not
 * be the configured default wallet, and must not be readable by group or others.
 */
export function loadKeypair(value, name) {
  const path = absolutePath(value, name);
  if (insideRepository(path)) throw new Error(`${name} must be outside the repository`);
  if (path === join(homedir(), ".config/solana/id.json")) {
    throw new Error(`${name} must not be the configured default Solana wallet`);
  }
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${name} must not be readable by group or others`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${name} is not a Solana CLI keypair file`);
  }
  return web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function publicKey(value, name) {
  let key;
  try {
    key = new web3.PublicKey(value);
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
  if (typeof value === "string" && key.toBase58() !== value) throw new Error(`${name} must be canonical base58`);
  return key;
}

export function hex32(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${name} must be a nonzero lowercase 32-byte hex string`);
  }
  return Buffer.from(value, "hex");
}

export function positiveInteger(value, name, maximum = 2n ** 64n - 1n) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
  if ((typeof value !== "string" && typeof value !== "number") || parsed <= 0n || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no larger than ${maximum}`);
  }
  return parsed;
}

export function rpcUrl(flags) {
  const url = new URL(flags["rpc-url"] ?? DEVNET_RPC_URL);
  if (url.protocol !== "https:") throw new Error("--rpc-url must be https");
  return url.href;
}

/** Network identity comes from chain data, never from the URL. */
export async function requireDevnetGenesis(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS_HASH) throw new Error("refusing Solana mainnet genesis");
  if (genesis !== DEVNET_GENESIS_HASH) throw new Error(`unexpected Solana genesis hash ${genesis}`);
  return genesis;
}

export function sha256(...parts) {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest();
}

function u32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function u32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export { u32be };

function u128be(value) {
  const buffer = Buffer.alloc(16);
  buffer.writeBigUInt64BE(value >> 64n, 0);
  buffer.writeBigUInt64BE(value & ((1n << 64n) - 1n), 8);
  return buffer;
}

function protocolIdBytes(value) {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length === 0 || bytes.length > 64 || !/^[\x20-\x7e]+$/.test(value)) throw new Error(`protocol id ${value} is invalid`);
  return Buffer.concat([u32be(bytes.length), bytes]);
}

export function domainCanonicalBytes(domain) {
  return Buffer.concat([protocolIdBytes(domain.domainId), u32be(domain.domainManifestVersion), Buffer.from(domain.domainManifestHash)]);
}

/** `domain_ref_identity_hash` in naryx_core, naryx_package_book, and naryx_inventory_reservation. */
export function domainRefIdentityHash(domain) {
  return sha256(Buffer.from("CON/v1/domain-ref-identity"), domainCanonicalBytes(domain));
}

export function protocolIdIdentityHash(value) {
  return sha256(Buffer.from("CON/v1/protocol-id-identity"), protocolIdBytes(value));
}

export function atomicPostconditionIdentityHash() {
  return sha256(Buffer.from("CON/v1/settlement-class-identity"), Buffer.of(1), u32be(1));
}

function manifestRefBytes(reference) {
  return Buffer.concat([Buffer.from(reference.subjectId), u32be(reference.manifestVersion), Buffer.from(reference.manifestHash)]);
}

/** Mirrors `CashCarrySeriesBindingV1::canonical_bytes`, `identity_key`, and `binding_hash`. */
export function seriesBindingHashes(binding) {
  const canonical = Buffer.concat([
    u32be(binding.schemaVersion),
    u32be(binding.bindingVersion),
    Buffer.from(binding.domainRefIdentityHash),
    Buffer.from(binding.seriesManifestHash),
    Buffer.from(binding.executionClassManifestHash),
    Buffer.from(binding.templateIdentityHash),
    u32be(binding.templateVersion),
    Buffer.from(binding.templateManifestHash),
    Buffer.from(binding.settlementClassIdentityHash),
    manifestRefBytes(binding.baseAsset),
    manifestRefBytes(binding.quoteAsset),
    Buffer.from(binding.quoteConventionIdentityHash),
    Buffer.of(binding.entrySide),
    u128be(binding.spotBaseAtomsPerPackageUnit),
    u128be(binding.perpQuantityAtomsPerPackageUnit),
  ]);
  return {
    canonicalLength: canonical.length,
    identityKey: sha256(
      Buffer.from("CON/v1/cash-carry-series-identity"),
      Buffer.from(binding.domainRefIdentityHash),
      Buffer.from(binding.seriesManifestHash),
      Buffer.from(binding.executionClassManifestHash),
    ),
    bindingHash: sha256(Buffer.from("CON/v1/cash-carry-series-binding"), canonical),
  };
}

/**
 * Mirrors `resource_admission_commitment` in naryx_core: the domain, the eight active identities in
 * spot adapter, perp adapter, spot market, perp market, spot venue, perp venue, base, quote order,
 * the spot adapter's template and settlement, the quote decimals, and the eight record keys.
 */
export function resourceAdmissionCommitment(input) {
  const order = ["spotAdapter", "perpAdapter", "spotMarket", "perpMarket", "spotVenue", "perpVenue", "baseAsset", "quoteAsset"];
  return sha256(
    Buffer.from("NARYX/cash-carry-resources/v1"),
    domainCanonicalBytes(input.domain),
    ...order.map((name) => manifestRefBytes(input.identities[name])),
    protocolIdBytes(input.template.id),
    u32be(input.template.version),
    Buffer.from(input.template.manifestHash),
    Buffer.of(1),
    u32be(input.settlement.version),
    Buffer.from(input.settlement.manifestHash),
    Buffer.of(input.quoteDecimals),
    ...order.map((name) => publicKey(input.records[name], `${name} record`).toBuffer()),
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

/**
 * Devnet resource identity. The subject id is a hash of the resource kind and its protocol subject
 * id; the manifest hash commits to the canonical JSON of the immutable resource manifest document,
 * which is printed next to every registration so reviewers can recompute it.
 */
export function resourceSubjectId(kind, protocolSubjectId) {
  return sha256(Buffer.from("NARYX/solana-devnet/resource-subject/v1"), Buffer.from(kind), Buffer.of(0), Buffer.from(protocolSubjectId));
}

export function resourceManifestHash(document) {
  return sha256(Buffer.from("NARYX/solana-devnet/resource-manifest/v1"), Buffer.from(canonicalJson(document)));
}

/** Converts bytes and bigints to the repository's protocol JSON tags. */
export function protocolJson(value) {
  if (value instanceof Uint8Array) return { $naryxType: "bytes", value: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return { $naryxType: "bigint", value: value.toString() };
  if (value instanceof web3.PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(protocolJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, protocolJson(item)]));
  }
  return value;
}

export function pda(seeds, programId) {
  return web3.PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), programId)[0];
}

export function programDataAddress(programId) {
  return pda([programId.toBuffer()], UPGRADEABLE_LOADER_ID);
}

export function associatedTokenAddress(owner, mint) {
  return pda([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function createAssociatedTokenIdempotent(payer, owner, mint) {
  const ata = associatedTokenAddress(owner, mint);
  return new web3.TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.of(1),
  });
}

/** SPL Token `TransferChecked`. */
export function transferChecked(source, mint, destination, authority, amount, decimals) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function decodeTokenAccount(data) {
  if (!Buffer.isBuffer(data) || data.length < 165) throw new Error("token account is malformed");
  return {
    mint: new web3.PublicKey(data.subarray(0, 32)),
    owner: new web3.PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  };
}

/** Loads an Anchor IDL file and rebinds it to the reviewed program id from the release manifest. */
export function loadIdl(path, programId, requiredInstructions) {
  const idl = JSON.parse(readFileSync(path, "utf8"));
  const names = new Set(idl.instructions.map((instruction) => instruction.name));
  for (const name of requiredInstructions) {
    if (!names.has(name)) throw new Error(`${path} does not declare ${name}`);
  }
  return { ...idl, address: programId.toBase58() };
}

export function defaultIdlPath(name) {
  const devnet = join(REPOSITORY_ROOT, "deployments/solana/devnet/test-perp/idl", name === "naryx_core" ? "naryx_core.devnet-test-perp.json" : `${name}.json`);
  if (existsSync(devnet)) return devnet;
  return join(CONTRACTS_DIRECTORY, "target/idl", `${name}.json`);
}

/**
 * Builds one v0 transaction for a step. Without `send` it is only simulated, unsigned and with
 * signature verification off, so dry runs never produce a broadcastable signature.
 */
export async function executeStep(connection, step, options) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new web3.TransactionMessage({
    payerKey: options.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: step.instructions,
  }).compileToV0Message(options.lookupTables ?? []);
  const transaction = new web3.VersionedTransaction(message);
  if (!options.send) {
    const simulation = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    if (simulation.value.err !== null) {
      const logs = (simulation.value.logs ?? []).slice(-12).join("\n");
      throw new Error(`${step.label} simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs}`);
    }
    return { status: "SIMULATED", unitsConsumed: simulation.value.unitsConsumed ?? null };
  }
  const signers = [options.payer, ...step.signers.filter((signer) => !signer.publicKey.equals(options.payer.publicKey))];
  transaction.sign(signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "finalized");
  if (result.value.err !== null) throw new Error(`${step.label} failed: ${JSON.stringify(result.value.err)} (${signature})`);
  return { status: "FINALIZED", signature };
}

export async function waitForSlot(connection, target, maximumSeconds) {
  const deadline = Date.now() + maximumSeconds * 1000;
  for (;;) {
    const slot = BigInt(await connection.getSlot("finalized"));
    if (slot >= target) return slot;
    if (Date.now() > deadline) throw new Error(`activation slot ${target} not reached within ${maximumSeconds} seconds (finalized ${slot}); rerun later`);
    await new Promise((done) => setTimeout(done, 2_000));
  }
}

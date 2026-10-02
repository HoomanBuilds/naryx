// Creates the Devnet test USDC mint and optionally funds operator wallets from its faucet.
//
//   node scripts/create-devnet-test-usdc.mjs --cluster devnet --test-perp-program <id> \
//     --payer /abs/payer.json [--mint-keypair /abs/mint.json | --mint <address>] \
//     [--claimant /abs/wallet.json --claim-atoms <atoms>] [--send]
//
// The mint has six decimals, the naryx_test_perp faucet PDA as its only mint authority, and no
// freeze authority, so supply only grows through `claim_test_collateral` (10,000 per claim, up to
// 10,000,000 per token account). Use the mint as the plan's quote mint before initialize-devnet.mjs.
// With --claimant, the wallet's associated token account is created and claims are sent until it
// holds --claim-atoms (for example the funder of the insurance and fee vaults, or the solver).
// Dry run is the default: every step is simulated unsigned. `--send` signs, sends, and finalizes.
import anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenIdempotent,
  decodeTokenAccount,
  executeStep,
  loadKeypair,
  parseFlags,
  pda,
  positiveInteger,
  publicKey,
  requireDevnetCluster,
  requireDevnetGenesis,
  rpcUrl,
} from "./devnet-operator.mjs";

const { web3 } = anchor;

export const TEST_COLLATERAL_FAUCET_SEED = "test-collateral-faucet";
export const TEST_COLLATERAL_DECIMALS = 6;
export const TEST_COLLATERAL_MAX_CLAIM_ATOMS = 10_000_000_000n;
export const TEST_COLLATERAL_MAX_BALANCE_ATOMS = 10_000_000_000_000n;
const MINT_SIZE = 82;
const CLAIMS_PER_TRANSACTION = 16n;

/** SPL Token `InitializeMint2` with no freeze authority. */
function initializeMint2(mint, mintAuthority) {
  return new web3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data: Buffer.concat([Buffer.of(20, TEST_COLLATERAL_DECIMALS), mintAuthority.toBuffer(), Buffer.of(0)]),
  });
}

export function claimTestCollateral(programId, recipient, mint, amount) {
  const data = Buffer.alloc(16);
  createHash("sha256").update("global:claim_test_collateral").digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(amount, 8);
  return new web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: recipient, isSigner: true, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: pda([TEST_COLLATERAL_FAUCET_SEED], programId), isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(recipient, mint), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** True when the account is a six-decimal mint minted only by the faucet PDA, with no freeze authority. */
export function isFaucetMint(info, faucet) {
  if (info === null || !info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== MINT_SIZE) return false;
  const data = Buffer.from(info.data);
  return data.readUInt32LE(0) === 1 && new web3.PublicKey(data.subarray(4, 36)).equals(faucet)
    && data[44] === TEST_COLLATERAL_DECIMALS && data[45] === 1 && data.readUInt32LE(46) === 0;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), [
    "cluster", "rpc-url", "test-perp-program", "payer", "mint-keypair", "mint", "claimant", "claim-atoms",
  ], ["send"]);
  requireDevnetCluster(flags);
  const send = flags.send === true;
  const program = publicKey(flags["test-perp-program"], "--test-perp-program");
  const payer = loadKeypair(flags.payer, "--payer");
  if ((flags["mint-keypair"] === undefined) === (flags.mint === undefined)) throw new Error("give exactly one of --mint-keypair or --mint");
  const mintKeypair = flags["mint-keypair"] === undefined ? undefined : loadKeypair(flags["mint-keypair"], "--mint-keypair");
  const mint = mintKeypair?.publicKey ?? publicKey(flags.mint, "--mint");
  const claimant = flags.claimant === undefined ? undefined : loadKeypair(flags.claimant, "--claimant");
  const claimTarget = claimant === undefined ? 0n : positiveInteger(flags["claim-atoms"], "--claim-atoms", TEST_COLLATERAL_MAX_BALANCE_ATOMS);
  if (claimant === undefined && flags["claim-atoms"] !== undefined) throw new Error("--claim-atoms needs --claimant");
  const faucet = pda([TEST_COLLATERAL_FAUCET_SEED], program);

  const connection = new web3.Connection(rpcUrl(flags), "confirmed");
  const genesisHash = await requireDevnetGenesis(connection);
  const programInfo = await connection.getAccountInfo(program, "confirmed");
  if (programInfo === null || !programInfo.executable) throw new Error("--test-perp-program is not a deployed program");
  const steps = [];

  const existing = await connection.getAccountInfo(mint, "confirmed");
  if (existing === null) {
    if (mintKeypair === undefined) throw new Error("--mint does not exist; pass --mint-keypair to create it");
    const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    steps.push({
      label: "create test USDC mint",
      instructions: [
        web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, lamports, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        initializeMint2(mint, faucet),
      ],
      signers: [mintKeypair],
    });
  } else if (!isFaucetMint(existing, faucet)) {
    throw new Error("the mint exists but is not a six-decimal faucet mint without a freeze authority");
  }

  if (claimant !== undefined) {
    const account = associatedTokenAddress(claimant.publicKey, mint);
    const info = await connection.getAccountInfo(account, "confirmed");
    const held = info === null ? 0n : decodeTokenAccount(info.data).amount;
    let remaining = claimTarget > held ? claimTarget - held : 0n;
    let first = info === null;
    while (remaining > 0n) {
      const instructions = first ? [createAssociatedTokenIdempotent(payer.publicKey, claimant.publicKey, mint)] : [];
      first = false;
      for (let count = 0n; count < CLAIMS_PER_TRANSACTION && remaining > 0n; count += 1n) {
        const amount = remaining > TEST_COLLATERAL_MAX_CLAIM_ATOMS ? TEST_COLLATERAL_MAX_CLAIM_ATOMS : remaining;
        instructions.push(claimTestCollateral(program, claimant.publicKey, mint, amount));
        remaining -= amount;
      }
      steps.push({ label: `claim test USDC for ${claimant.publicKey.toBase58()}`, instructions, signers: [claimant] });
    }
  }

  const results = [];
  for (const [index, step] of steps.entries()) {
    // Each step builds on the one before it, so a dry run simulates only the first.
    if (!send && index > 0) {
      results.push({ label: step.label, status: "SKIPPED_IN_DRY_RUN" });
      continue;
    }
    results.push({ label: step.label, ...await executeStep(connection, step, { payer, send }) });
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    cluster: "solana-devnet",
    genesisHash,
    mode: send ? "SEND" : "DRY_RUN",
    mint: mint.toBase58(),
    decimals: TEST_COLLATERAL_DECIMALS,
    faucetAuthority: faucet.toBase58(),
    testPerpProgram: program.toBase58(),
    steps: results,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

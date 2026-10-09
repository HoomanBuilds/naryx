#!/usr/bin/env node
// Updates bounded oracle risk controls while keeping the market paused for the entire change.
// Dry run is the default. --send signs, broadcasts, and waits for finalization on Devnet only.
import anchor from "@anchor-lang/core";
import { pathToFileURL } from "node:url";
import {
  defaultIdlPath,
  executeStep,
  loadIdl,
  loadKeypair,
  parseFlags,
  positiveInteger,
  publicKey,
  requireDevnetCluster,
  requireDevnetGenesis,
  rpcUrl,
} from "./devnet-operator.mjs";

const { AnchorProvider, Program, Wallet, web3 } = anchor;

async function main() {
  const flags = parseFlags(
    process.argv.slice(2),
    [
      "cluster",
      "rpc-url",
      "program",
      "market",
      "market-owner",
      "payer",
      "max-price-age-seconds",
      "max-confidence-bps",
    ],
    ["send"]
  );
  requireDevnetCluster(flags);
  const send = flags.send === true;
  const programId = publicKey(flags.program, "--program");
  const marketAddress = publicKey(flags.market, "--market");
  const marketOwner = loadKeypair(flags["market-owner"], "--market-owner");
  const payer = loadKeypair(flags.payer, "--payer");
  const maxPriceAgeSeconds = Number(
    positiveInteger(
      flags["max-price-age-seconds"],
      "--max-price-age-seconds",
      300n
    )
  );
  const maxConfidenceBps = Number(
    positiveInteger(flags["max-confidence-bps"], "--max-confidence-bps", 1_000n)
  );

  const connection = new web3.Connection(rpcUrl(flags), "confirmed");
  const genesisHash = await requireDevnetGenesis(connection);
  const programInfo = await connection.getAccountInfo(programId, "confirmed");
  if (programInfo === null || !programInfo.executable)
    throw new Error("--program is not executable");
  const marketInfo = await connection.getAccountInfo(
    marketAddress,
    "confirmed"
  );
  if (marketInfo === null || !marketInfo.owner.equals(programId))
    throw new Error("--market is not owned by --program");

  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
  });
  const idl = loadIdl(defaultIdlPath("naryx_test_perp"), programId, [
    "update_market_controls",
    "update_oracle_risk_controls",
  ]);
  const program = new Program(idl, provider);
  const current = program.coder.accounts.decode(
    "testPerpMarket",
    marketInfo.data
  );
  if (!current.owner.equals(marketOwner.publicKey))
    throw new Error("--market-owner does not own --market");

  const pause = await program.methods
    .updateMarketControls(true, current.fundingKeeper)
    .accountsStrict({
      owner: marketOwner.publicKey,
      market: marketAddress,
    })
    .instruction();
  const update = await program.methods
    .updateOracleRiskControls(maxPriceAgeSeconds, maxConfidenceBps)
    .accountsStrict({
      owner: marketOwner.publicKey,
      market: marketAddress,
    })
    .instruction();
  const unpause = await program.methods
    .updateMarketControls(false, current.fundingKeeper)
    .accountsStrict({
      owner: marketOwner.publicKey,
      market: marketAddress,
    })
    .instruction();
  const result = await executeStep(
    connection,
    {
      label: "update Devnet test perp oracle risk controls",
      instructions: [pause, update, unpause],
      signers: [marketOwner],
    },
    { payer, send }
  );

  let finalState;
  if (send) {
    const updatedInfo = await connection.getAccountInfo(
      marketAddress,
      "finalized"
    );
    if (updatedInfo === null)
      throw new Error("market disappeared after finalization");
    const updated = program.coder.accounts.decode(
      "testPerpMarket",
      updatedInfo.data
    );
    if (
      updated.pauseOpens ||
      updated.maxPriceAgeSeconds !== maxPriceAgeSeconds ||
      updated.maxConfidenceBps !== maxConfidenceBps
    ) {
      throw new Error(
        "finalized market controls do not match the requested values"
      );
    }
    finalState = {
      pauseOpens: updated.pauseOpens,
      maxPriceAgeSeconds: updated.maxPriceAgeSeconds,
      maxConfidenceBps: updated.maxConfidenceBps,
    };
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        cluster: "solana-devnet",
        genesisHash,
        mode: send ? "SEND" : "DRY_RUN",
        program: programId.toBase58(),
        market: marketAddress.toBase58(),
        result,
        finalState,
      },
      null,
      2
    )}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

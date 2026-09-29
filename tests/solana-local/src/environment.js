import anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  HASH_DOMAIN,
  domainHash,
  domainRefFromManifest,
  encodeAscii,
} from "@naryx/protocol-types";
import { createSolanaLocalEnvironmentManifestJson } from "@naryx/adapter-core";

const { AnchorProvider, BN, Program, Wallet, web3 } = anchor;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contractsDir = join(rootDir, "contracts/solana");
const idlDir = join(rootDir, "deployments/solana/conformance/idl");
const artifacts = {
  core: join(contractsDir, "target/deploy/naryx_core.so"),
  venue: join(contractsDir, "target/deploy/naryx_conformance_venue.so"),
};
const idls = {
  core: JSON.parse(readFileSync(join(idlDir, "naryx_core.json"), "utf8")),
  venue: JSON.parse(
    readFileSync(join(idlDir, "naryx_conformance_venue.json"), "utf8"),
  ),
};
const programIds = {
  core: new web3.PublicKey(idls.core.address),
  venue: new web3.PublicKey(idls.venue.address),
};
const loaderId = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const tokenProgramId = new web3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const delaySlots = 8;
const economics = Object.freeze({
  priceQuoteAtoms: 2,
  priceBaseAtoms: 1,
  spotFeeBps: 25,
  initialMarginBps: 2_000,
  maxSpotBaseAtoms: 10_000_000,
  maxPerpBaseAtoms: 10_000_000,
});
const seededBalances = Object.freeze({
  spotBaseVault: 100_000_000,
  spotQuoteVault: 200_000_000,
  perpQuoteVault: 100_000_000,
  traderBase: 5_000_000,
  traderQuote: 50_000_000,
  makerBase: 20_000_000,
  makerQuote: 100_000_000,
  recoveryBase: 1_000_000,
  recoveryQuote: 10_000_000,
});

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function localDomain(genesisHash) {
  return domainRefFromManifest({
    manifestVersion: 1,
    environment: "local",
    domainId: "svm:local",
    runtimeClassId: "svm",
    runtimeClassVersion: 1,
    chainNamespace: "solana",
    chainReference: genesisHash,
    executionVerifierId: programIds.core.toBase58(),
    executionVerifierCodeHash: sha256(artifacts.core),
    clockModelId: "solana-slot",
    finalityPolicyHash: domainHash(
      HASH_DOMAIN.DOMAIN_REF_IDENTITY,
      encodeAscii("solana:confirmed"),
    ),
    addressCodecId: "solana-base58-pubkey",
    supportedSettlementClasses: ["ATOMIC_POSTCONDITION"],
  });
}

function keypairPath(runDir, label, keypair) {
  const path = join(runDir, `${label}.json`);
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), {
    mode: 0o600,
    flag: "wx",
  });
  return path;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function availablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function availableRpcPort() {
  for (;;) {
    const port = await availablePort();
    if (port >= 1024 && port < 65534) return port;
  }
}

async function waitForValidator(connection, child, logPath) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited with ${child.exitCode}\n${readFileSync(logPath, "utf8")}`,
      );
    }
    try {
      await connection.getVersion();
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(
    `solana-test-validator did not become ready\n${readFileSync(logPath, "utf8")}`,
  );
}

async function stopValidator(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  const exited = once(child, "exit");
  let timeoutId;
  const timeout = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout("timeout"), 10_000);
    timeoutId.unref();
  });
  const result = await Promise.race([exited, timeout]);
  clearTimeout(timeoutId);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function confirm(connection, signature) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(signature);
    if (status.value?.err) {
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(status.value.err)}`,
      );
    }
    if (
      status.value?.confirmationStatus === "confirmed" ||
      status.value?.confirmationStatus === "finalized"
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Transaction ${signature} was not confirmed`);
}

async function fundIdentities(connection, payer, recipients) {
  const signature = await connection.requestAirdrop(
    payer.publicKey,
    100 * web3.LAMPORTS_PER_SOL,
  );
  await confirm(connection, signature);
  const transaction = new web3.Transaction();
  for (const recipient of recipients) {
    transaction.add(
      web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 5 * web3.LAMPORTS_PER_SOL,
      }),
    );
  }
  await web3.sendAndConfirmTransaction(connection, transaction, [payer]);
}

function deriveAddresses(identities, mints) {
  const [config] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("naryx-protocol-config")],
    programIds.core,
  );
  const [solverRegistry] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("conformance-solver")],
    programIds.core,
  );
  const [market] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      identities.venueAdmin.publicKey.toBuffer(),
      mints.base.publicKey.toBuffer(),
      mints.quote.publicKey.toBuffer(),
    ],
    programIds.venue,
  );
  const venuePda = (seed) =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from(seed), market.toBuffer()],
      programIds.venue,
    )[0];
  const [position] = web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      market.toBuffer(),
      identities.trader.publicKey.toBuffer(),
    ],
    programIds.venue,
  );
  return {
    config,
    solverRegistry,
    market,
    spotBaseVault: venuePda("spot-base-vault"),
    spotQuoteVault: venuePda("spot-quote-vault"),
    perpQuoteVault: venuePda("perp-quote-vault"),
    position,
  };
}

function createTokenResources(runDir, rpcUrl, keyPaths, identities) {
  const mints = {
    base: web3.Keypair.generate(),
    quote: web3.Keypair.generate(),
  };
  const mintPaths = {
    base: keypairPath(runDir, "NARYX_LOCAL_BASE_6-mint", mints.base),
    quote: keypairPath(runDir, "NARYX_LOCAL_QUOTE_6-mint", mints.quote),
  };
  for (const kind of ["base", "quote"]) {
    run("spl-token", [
      "create-token",
      mintPaths[kind],
      "--decimals",
      "6",
      "--mint-authority",
      identities.venueAdmin.publicKey.toBase58(),
      "--fee-payer",
      keyPaths.payer,
      "--url",
      rpcUrl,
      "--output",
      "json-compact",
    ]);
  }

  const tokenAccounts = {};
  for (const owner of ["trader", "maker", "recovery"]) {
    for (const kind of ["base", "quote"]) {
      const account = web3.Keypair.generate();
      const label = `${owner}-${kind}`;
      const accountPath = keypairPath(runDir, `${label}-token`, account);
      run("spl-token", [
        "create-account",
        mints[kind].publicKey.toBase58(),
        accountPath,
        "--owner",
        identities[owner].publicKey.toBase58(),
        "--fee-payer",
        keyPaths.payer,
        "--url",
        rpcUrl,
        "--output",
        "json-compact",
      ]);
      tokenAccounts[label] = account.publicKey;
    }
  }
  return { mints, tokenAccounts };
}

function mintTokens(rpcUrl, keyPaths, mint, destination, uiAmount) {
  run("spl-token", [
    "mint",
    mint.toBase58(),
    String(uiAmount),
    destination.toBase58(),
    "--mint-authority",
    keyPaths.venueAdmin,
    "--fee-payer",
    keyPaths.payer,
    "--url",
    rpcUrl,
    "--output",
    "json-compact",
  ]);
}

async function waitForSlot(connection, target) {
  while ((await connection.getSlot("confirmed")) < target) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function publicIdentities(identities) {
  return Object.fromEntries(
    Object.entries(identities).map(([name, keypair]) => [
      name,
      keypair.publicKey.toBase58(),
    ]),
  );
}

async function tokenBalance(connection, address) {
  return Number(
    (await connection.getTokenAccountBalance(address)).value.amount,
  );
}

async function dumpProgram(runDir, rpcUrl, name, programId) {
  const path = join(runDir, `${name}-deployed.so`);
  run("solana", [
    "program",
    "dump",
    programId.toBase58(),
    path,
    "--url",
    rpcUrl,
  ]);
  return sha256(path);
}

async function provision(runDir, rpcUrl, connection, identities, keyPaths) {
  await fundIdentities(connection, identities.payer, [
    identities.governanceProposer,
    identities.governanceCanceller,
    identities.governanceExecutor,
    identities.governancePauser,
    identities.venueAdmin,
    identities.trader,
    identities.solver,
    identities.maker,
    identities.recovery,
  ]);

  const { mints, tokenAccounts } = createTokenResources(
    runDir,
    rpcUrl,
    keyPaths,
    identities,
  );
  const addresses = deriveAddresses(identities, mints);
  const provider = new AnchorProvider(
    connection,
    new Wallet(identities.payer),
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
  const core = new Program(idls.core, provider);
  const venue = new Program(idls.venue, provider);
  const [programData] = web3.PublicKey.findProgramAddressSync(
    [programIds.core.toBuffer()],
    loaderId,
  );
  const domain = localDomain(await connection.getGenesisHash());

  await core.methods
    .initialize(
      "local-conformance",
      domain.domainId,
      domain.domainManifestVersion,
      Array.from(domain.domainManifestHash),
      new BN(delaySlots),
      {
        proposer: identities.governanceProposer.publicKey,
        canceller: identities.governanceCanceller.publicKey,
        executor: identities.governanceExecutor.publicKey,
        pauser: identities.governancePauser.publicKey,
      },
    )
    .accountsStrict({
      payer: identities.payer.publicKey,
      initializer: identities.payer.publicKey,
      program: programIds.core,
      programData,
      config: addresses.config,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();

  await core.methods
    .proposeSolver(identities.solver.publicKey)
    .accountsStrict({
      proposer: identities.governanceProposer.publicKey,
      config: addresses.config,
      registry: addresses.solverRegistry,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([identities.governanceProposer])
    .rpc();
  await core.methods
    .scheduleUnpause()
    .accountsStrict({
      proposer: identities.governanceProposer.publicKey,
      config: addresses.config,
    })
    .signers([identities.governanceProposer])
    .rpc();

  const proposedRegistry = await core.account.solverRegistry.fetch(
    addresses.solverRegistry,
  );
  const proposedConfig = await core.account.protocolConfig.fetch(
    addresses.config,
  );
  const solverActivationSlot =
    proposedRegistry.pending.activationSlot.toNumber();
  const entryActivationSlot = proposedConfig.pendingUnpauseSlot.toNumber();
  await waitForSlot(
    connection,
    Math.max(solverActivationSlot, entryActivationSlot),
  );

  await core.methods
    .activateSolver()
    .accountsStrict({
      executor: identities.governanceExecutor.publicKey,
      config: addresses.config,
      registry: addresses.solverRegistry,
    })
    .signers([identities.governanceExecutor])
    .rpc();
  await core.methods
    .activateUnpause()
    .accountsStrict({
      executor: identities.governanceExecutor.publicKey,
      config: addresses.config,
    })
    .signers([identities.governanceExecutor])
    .rpc();

  await venue.methods
    .initializeMarket(
      new BN(economics.priceQuoteAtoms),
      new BN(economics.priceBaseAtoms),
      economics.spotFeeBps,
      economics.initialMarginBps,
      new BN(economics.maxSpotBaseAtoms),
      new BN(economics.maxPerpBaseAtoms),
    )
    .accountsStrict({
      admin: identities.venueAdmin.publicKey,
      baseMint: mints.base.publicKey,
      quoteMint: mints.quote.publicKey,
      market: addresses.market,
      spotBaseVault: addresses.spotBaseVault,
      spotQuoteVault: addresses.spotQuoteVault,
      perpQuoteVault: addresses.perpQuoteVault,
      tokenProgram: tokenProgramId,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([identities.venueAdmin])
    .rpc();
  await venue.methods
    .initializePosition()
    .accountsStrict({
      trader: identities.trader.publicKey,
      market: addresses.market,
      position: addresses.position,
      systemProgram: web3.SystemProgram.programId,
    })
    .signers([identities.trader])
    .rpc();

  const mintPlan = [
    [mints.base.publicKey, addresses.spotBaseVault, 100],
    [mints.quote.publicKey, addresses.spotQuoteVault, 200],
    [mints.quote.publicKey, addresses.perpQuoteVault, 100],
    [mints.base.publicKey, tokenAccounts["trader-base"], 5],
    [mints.quote.publicKey, tokenAccounts["trader-quote"], 50],
    [mints.base.publicKey, tokenAccounts["maker-base"], 20],
    [mints.quote.publicKey, tokenAccounts["maker-quote"], 100],
    [mints.base.publicKey, tokenAccounts["recovery-base"], 1],
    [mints.quote.publicKey, tokenAccounts["recovery-quote"], 10],
  ];
  for (const [mint, destination, amount] of mintPlan) {
    mintTokens(rpcUrl, keyPaths, mint, destination, amount);
  }

  return {
    core,
    venue,
    mints,
    tokenAccounts,
    addresses,
    delayEvidence: {
      solverActivationSlot,
      entryActivationSlot,
      activatedAtSlot: await connection.getSlot("confirmed"),
    },
  };
}

function addressStrings(addresses) {
  return Object.fromEntries(
    Object.entries(addresses).map(([name, address]) => [
      name,
      address.toBase58(),
    ]),
  );
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

async function buildManifest(
  runDir,
  rpcUrl,
  connection,
  identities,
  provisioned,
) {
  const deployedHashes = {
    core: await dumpProgram(runDir, rpcUrl, "naryx_core", programIds.core),
    venue: await dumpProgram(
      runDir,
      rpcUrl,
      "naryx_conformance_venue",
      programIds.venue,
    ),
  };
  const localHashes = {
    core: sha256(artifacts.core),
    venue: sha256(artifacts.venue),
  };
  if (
    deployedHashes.core !== localHashes.core ||
    deployedHashes.venue !== localHashes.venue
  ) {
    throw new Error(
      "Deployed program code does not match the built SBF artifacts",
    );
  }
  const balances = {};
  const allTokenAccounts = {
    spotBaseVault: provisioned.addresses.spotBaseVault,
    spotQuoteVault: provisioned.addresses.spotQuoteVault,
    perpQuoteVault: provisioned.addresses.perpQuoteVault,
    traderBase: provisioned.tokenAccounts["trader-base"],
    traderQuote: provisioned.tokenAccounts["trader-quote"],
    makerBase: provisioned.tokenAccounts["maker-base"],
    makerQuote: provisioned.tokenAccounts["maker-quote"],
    recoveryBase: provisioned.tokenAccounts["recovery-base"],
    recoveryQuote: provisioned.tokenAccounts["recovery-quote"],
  };
  for (const [name, address] of Object.entries(allTokenAccounts)) {
    balances[name] = String(await tokenBalance(connection, address));
  }

  const programData = {
    core: web3.PublicKey.findProgramAddressSync(
      [programIds.core.toBuffer()],
      loaderId,
    )[0].toBase58(),
    conformanceVenue: web3.PublicKey.findProgramAddressSync(
      [programIds.venue.toBuffer()],
      loaderId,
    )[0].toBase58(),
  };
  const manifest = deepFreeze(
    createSolanaLocalEnvironmentManifestJson({
      limitations: [
        "The conformance venue is not Orca and does not emulate Orca liquidity or execution.",
        "The conformance venue is not Phoenix and does not emulate Phoenix markets or execution.",
        "This environment provides local protocol conformance evidence only.",
      ],
      rpcUrl,
      genesisHash: await connection.getGenesisHash(),
      manifestSlot: await connection.getSlot("confirmed"),
      maximumManifestAgeSlots: 4096,
      programs: {
        core: {
          id: programIds.core.toBase58(),
          programDataId: programData.core,
          sha256: deployedHashes.core,
        },
        conformanceVenue: {
          id: programIds.venue.toBase58(),
          programDataId: programData.conformanceVenue,
          sha256: deployedHashes.venue,
        },
      },
      identities: publicIdentities(identities),
      assets: {
        base: {
          label: "NARYX_LOCAL_BASE_6",
          mint: provisioned.mints.base.publicKey.toBase58(),
          decimals: 6,
        },
        quote: {
          label: "NARYX_LOCAL_QUOTE_6",
          mint: provisioned.mints.quote.publicKey.toBase58(),
          decimals: 6,
        },
      },
      accounts: {
        ...addressStrings(provisioned.addresses),
        ...Object.fromEntries(
          Object.entries(provisioned.tokenAccounts).map(([name, address]) => [
            name,
            address.toBase58(),
          ]),
        ),
      },
      governance: {
        configDelaySlots: delaySlots,
        solverActivationSlot: provisioned.delayEvidence.solverActivationSlot,
        entryActivationSlot: provisioned.delayEvidence.entryActivationSlot,
        activatedAtSlot: provisioned.delayEvidence.activatedAtSlot,
      },
      economics: Object.fromEntries(
        Object.entries(economics).map(([name, value]) => [name, String(value)]),
      ),
      balances,
    }),
  );
  const manifestPath = join(runDir, "environment-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o444,
    flag: "wx",
  });
  chmodSync(manifestPath, 0o444);
  return { manifest, manifestPath };
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

export async function validateEnvironment(environment) {
  const { connection, manifest, manifestPath, provisioned, rpcUrl, runDir } =
    environment;
  if (!rpcUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("Local environment RPC must bind to 127.0.0.1");
  }
  if ((await connection.getGenesisHash()) !== manifest.rpc.genesisHash) {
    throw new Error("Manifest genesis hash does not match the validator");
  }
  assertEqual(
    JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))),
    JSON.stringify(manifest),
    "In-memory manifest does not match its immutable file",
  );
  assertEqual(
    statSync(manifestPath).mode & 0o777,
    0o444,
    "Environment manifest is not read-only",
  );
  assertEqual(
    manifest.programs.core.id,
    programIds.core.toBase58(),
    "Manifest core program identity is not truthful",
  );
  assertEqual(
    manifest.programs.conformanceVenue.id,
    programIds.venue.toBase58(),
    "Manifest venue program identity is not truthful",
  );
  for (const [name, keypair] of Object.entries(environment.identities)) {
    assertEqual(
      manifest.identities[name],
      keypair.publicKey.toBase58(),
      `Manifest identity for ${name} is not truthful`,
    );
  }
  for (const [name, programId] of Object.entries(programIds)) {
    const account = await connection.getAccountInfo(programId);
    if (!account?.executable || !account.owner.equals(loaderId)) {
      throw new Error(`${name} is not a deployed upgradeable program`);
    }
  }
  const config = await provisioned.core.account.protocolConfig.fetch(
    provisioned.addresses.config,
  );
  const registry = await provisioned.core.account.solverRegistry.fetch(
    provisioned.addresses.solverRegistry,
  );
  const market = await provisioned.venue.account.marketConfig.fetch(
    provisioned.addresses.market,
  );
  const position = await provisioned.venue.account.perpPosition.fetch(
    provisioned.addresses.position,
  );
  assertEqual(
    config.domain.domainId,
    manifest.runtime.catalog.domain.domainId,
    "Core domain ID does not match the generated canonical manifest",
  );
  assertEqual(
    config.domain.domainManifestVersion,
    manifest.runtime.catalog.domain.domainManifestVersion,
    "Core domain manifest version does not match the generated canonical manifest",
  );
  assertEqual(
    Buffer.from(config.domain.domainManifestHash).toString("hex"),
    manifest.runtime.domainManifestHash,
    "Core domain manifest hash does not match the generated canonical manifest",
  );
  if (
    config.entryPaused ||
    !registry.active.equals(environment.identities.solver.publicKey)
  ) {
    throw new Error("Core entry state or solver activation is not provisioned");
  }
  if (
    provisioned.delayEvidence.activatedAtSlot <
    Math.max(
      provisioned.delayEvidence.solverActivationSlot,
      provisioned.delayEvidence.entryActivationSlot,
    )
  ) {
    throw new Error("Core activation did not observe its slot delay");
  }
  if (
    !market.admin.equals(environment.identities.venueAdmin.publicKey) ||
    !market.baseMint.equals(provisioned.mints.base.publicKey) ||
    !market.quoteMint.equals(provisioned.mints.quote.publicKey) ||
    !position.trader.equals(environment.identities.trader.publicKey) ||
    !position.market.equals(provisioned.addresses.market)
  ) {
    throw new Error("Venue market or trader position is not provisioned");
  }
  const marketEconomics = {
    priceQuoteAtoms: market.priceQuoteAtoms.toNumber(),
    priceBaseAtoms: market.priceBaseAtoms.toNumber(),
    spotFeeBps: market.spotFeeBps,
    initialMarginBps: market.initialMarginBps,
    maxSpotBaseAtoms: market.maxSpotBaseAtoms.toNumber(),
    maxPerpBaseAtoms: market.maxPerpBaseAtoms.toNumber(),
  };
  for (const [name, expected] of Object.entries(economics)) {
    assertEqual(
      marketEconomics[name],
      expected,
      `Market economic value for ${name} is not provisioned`,
    );
    assertEqual(
      manifest.economics[name],
      String(expected),
      `Manifest economic value for ${name} is not truthful`,
    );
  }
  const mintSupplies = await Promise.all([
    connection.getTokenSupply(provisioned.mints.base.publicKey),
    connection.getTokenSupply(provisioned.mints.quote.publicKey),
  ]);
  assertEqual(
    mintSupplies[0].value.decimals,
    manifest.assets.base.decimals,
    "Base mint decimals do not match the manifest",
  );
  assertEqual(
    mintSupplies[1].value.decimals,
    manifest.assets.quote.decimals,
    "Quote mint decimals do not match the manifest",
  );
  const balanceAddresses = {
    spotBaseVault: provisioned.addresses.spotBaseVault,
    spotQuoteVault: provisioned.addresses.spotQuoteVault,
    perpQuoteVault: provisioned.addresses.perpQuoteVault,
    traderBase: provisioned.tokenAccounts["trader-base"],
    traderQuote: provisioned.tokenAccounts["trader-quote"],
    makerBase: provisioned.tokenAccounts["maker-base"],
    makerQuote: provisioned.tokenAccounts["maker-quote"],
    recoveryBase: provisioned.tokenAccounts["recovery-base"],
    recoveryQuote: provisioned.tokenAccounts["recovery-quote"],
  };
  for (const [name, expected] of Object.entries(seededBalances)) {
    const actual = await tokenBalance(connection, balanceAddresses[name]);
    assertEqual(
      actual,
      expected,
      `Token balance for ${name} is not provisioned`,
    );
    assertEqual(
      manifest.balances[name],
      String(actual),
      `Manifest balance for ${name} is not truthful`,
    );
  }
  const currentCoreHash = await dumpProgram(
    runDir,
    rpcUrl,
    "naryx_core-validation",
    programIds.core,
  );
  const currentVenueHash = await dumpProgram(
    runDir,
    rpcUrl,
    "naryx_conformance_venue-validation",
    programIds.venue,
  );
  if (
    currentCoreHash !== manifest.programs.core.sha256 ||
    currentVenueHash !== manifest.programs.conformanceVenue.sha256
  ) {
    throw new Error("Manifest program hashes do not match deployed code");
  }
  return true;
}

export async function withLocalSolanaEnvironment(callback) {
  const runDir = mkdtempSync(join(tmpdir(), "naryx-solana-local-"));
  const identities = Object.fromEntries(
    [
      "payer",
      "governanceProposer",
      "governanceCanceller",
      "governanceExecutor",
      "governancePauser",
      "venueAdmin",
      "trader",
      "solver",
      "maker",
      "recovery",
    ].map((name) => [name, web3.Keypair.generate()]),
  );
  const keyPaths = Object.fromEntries(
    Object.entries(identities).map(([name, keypair]) => [
      name,
      keypairPath(runDir, name, keypair),
    ]),
  );
  const ledgerDir = join(runDir, "ledger");
  const logPath = join(runDir, "validator.log");
  const logFd = openSync(logPath, "a", 0o600);
  let validator;
  let connection;
  try {
    const rpcPort = await availableRpcPort();
    const faucetPort = await availablePort();
    const gossipPort = await availablePort();
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    validator = spawn(
      "solana-test-validator",
      [
        "--reset",
        "--quiet",
        "--ledger",
        ledgerDir,
        "--rpc-port",
        String(rpcPort),
        "--faucet-port",
        String(faucetPort),
        "--gossip-port",
        String(gossipPort),
        "--ticks-per-slot",
        "8",
        "--upgradeable-program",
        programIds.core.toBase58(),
        artifacts.core,
        keyPaths.payer,
        "--upgradeable-program",
        programIds.venue.toBase58(),
        artifacts.venue,
        keyPaths.payer,
      ],
      { cwd: runDir, stdio: ["ignore", logFd, logFd] },
    );
    connection = new web3.Connection(rpcUrl, "confirmed");
    await waitForValidator(connection, validator, logPath);
    const provisioned = await provision(
      runDir,
      rpcUrl,
      connection,
      identities,
      keyPaths,
    );
    const { manifest, manifestPath } = await buildManifest(
      runDir,
      rpcUrl,
      connection,
      identities,
      provisioned,
    );
    const environment = {
      connection,
      identities,
      manifest,
      manifestPath,
      provisioned,
      rpcUrl,
      runDir,
    };
    await validateEnvironment(environment);
    return await callback(environment);
  } finally {
    if (connection?._rpcWebSocket) connection._rpcWebSocket.close();
    if (validator) await stopValidator(validator);
    closeSync(logFd);
    if (
      dirname(runDir) !== tmpdir() ||
      !basename(runDir).startsWith("naryx-solana-local-")
    ) {
      throw new Error(`Refusing to clean unexpected run directory ${runDir}`);
    }
    const manifestPath = join(runDir, "environment-manifest.json");
    if (existsSync(manifestPath)) chmodSync(manifestPath, 0o600);
    rmSync(runDir, { recursive: true });
  }
}

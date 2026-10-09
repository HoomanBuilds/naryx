// Initializes a reviewed Solana Devnet release after the operator deployed its programs.
//
//   node scripts/initialize-devnet.mjs --cluster devnet \
//     --release /abs/candidate-release.json --plan /abs/devnet-plan.json \
//     --payer /abs/payer.json --upgrade-authority /abs/upgrade.json \
//     --proposer /abs/proposer.json --executor /abs/executor.json \
//     --market-owner /abs/market-owner.json --solver /abs/solver.json \
//     [--funder /abs/funder.json] [--out /abs/record.json] [--send]
//
// Dry run is the default: every missing step is simulated unsigned and nothing is broadcast.
// `--send` signs and sends each missing step in order and waits for finality. Every step is
// idempotent: an account that already exists is decoded and must match the plan, or the run fails.
import anchor from "@anchor-lang/core";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCandidateReleaseManifest, verifyCandidateRelease } from "./verify-devnet-release.mjs";
import {
  TOKEN_PROGRAM_ID,
  absolutePath,
  associatedTokenAddress,
  atomicPostconditionIdentityHash,
  createAssociatedTokenIdempotent,
  decodeTokenAccount,
  defaultIdlPath,
  domainRefIdentityHash,
  executeStep,
  hex32,
  loadIdl,
  loadKeypair,
  parseFlags,
  pda,
  positiveInteger,
  protocolIdIdentityHash,
  protocolJson,
  publicKey,
  requireDevnetCluster,
  requireDevnetGenesis,
  resourceAdmissionCommitment,
  resourceManifestHash,
  resourceSubjectId,
  rpcUrl,
  seriesBindingHashes,
  sha256,
  transferChecked,
  u32be,
  u32le,
  waitForSlot,
} from "./devnet-operator.mjs";

const { AnchorProvider, BN, Program, Wallet, web3 } = anchor;

export const SOL_USD_PRICE_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const RELEASE_PROGRAMS = Object.freeze({
  naryx_core: "core",
  naryx_inventory_reservation: "reservation",
  naryx_package_book: "package_book",
  naryx_test_perp: "perp_venue",
  naryx_test_perp_adapter: "perp_adapter",
});
const TEMPLATE_ID = "cash-and-carry-v1";
const FIRM_SPOT_CLASS_ID = "naryx.solana.spot-firm-reservation";
const PERP_CLASS_ID = "naryx.solana.perp-exact";
const QUOTE_CONVENTION_ID = "annualized-net-yield-v1";
const MAX_FUNDING_ATOMS = 1_000_000_000_000n;
const DEFAULT_SUBJECTS = Object.freeze({
  spotVenue: "naryx-devnet-inventory-reservation-venue",
  spotMarket: "naryx-devnet-inventory-reservation-market",
  spotAdapter: "naryx-devnet-firm-reservation-adapter",
  perpVenue: "naryx-devnet-test-perp-venue",
  perpMarket: "naryx-devnet-test-perp-market",
  perpAdapter: "naryx-devnet-test-perp-adapter",
});
// Recommended Devnet test perp parameters from deployments/solana/devnet/README.md.
export const RECOMMENDED_TEST_PERP = Object.freeze({
  baseDecimals: 9,
  baseLotAtoms: 1_000_000n,
  quoteTickAtomsPerBaseLot: 1n,
  takerFeeBps: 5,
  halfSpreadBps: 2,
  impactBpsPerUnit: 1,
  impactUnitLots: 10_000n,
  maxSlippageBps: 100,
  initialMarginBps: 1_000,
  maintenanceMarginBps: 500,
  liquidationPenaltyBps: 100,
  maxPriceAgeSeconds: 300,
  maxConfidenceBps: 50,
  maxPositionLots: 1_000_000n,
  maxFundingRatePerSecond: 10_000n,
});

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function smallInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} must be an integer from 0 to ${maximum}`);
  return value;
}

function protocolSubject(value, name) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9.:-]{2,63}$/.test(value)) throw new Error(`${name} must be a lowercase protocol id`);
  return value;
}

/** Validates the operator plan. Every value that becomes an onchain parameter is checked here. */
export function parsePlan(value) {
  const plan = record(value, "plan");
  if (plan.schemaVersion !== 1 || plan.cluster !== "solana-devnet") throw new Error("plan must be schema version 1 for solana-devnet");
  const domain = record(plan.domain, "plan.domain");
  if (domain.domainId !== "svm:devnet") throw new Error("plan.domain.domainId must be svm:devnet");
  const parsedDomain = {
    domainId: "svm:devnet",
    domainManifestVersion: smallInteger(domain.domainManifestVersion, "plan.domain.domainManifestVersion", 0xffffffff),
    domainManifestHash: hex32(domain.domainManifestHash, "plan.domain.domainManifestHash"),
  };
  if (parsedDomain.domainManifestVersion === 0) throw new Error("plan.domain.domainManifestVersion must be nonzero");
  const roles = record(plan.roles, "plan.roles");
  const assets = record(plan.assets, "plan.assets");
  const asset = (name) => {
    const item = record(assets[name], `plan.assets.${name}`);
    return { mint: publicKey(item.mint, `plan.assets.${name}.mint`), decimals: smallInteger(item.decimals, `plan.assets.${name}.decimals`, 18) };
  };
  const base = asset("base");
  const quote = asset("quote");
  if (base.mint.equals(quote.mint)) throw new Error("plan base and quote mints must differ");
  const testPerp = record(plan.testPerp, "plan.testPerp");
  const parameters = { ...RECOMMENDED_TEST_PERP, ...(testPerp.parameters ?? {}) };
  for (const key of ["baseLotAtoms", "quoteTickAtomsPerBaseLot", "impactUnitLots", "maxPositionLots", "maxFundingRatePerSecond"]) {
    parameters[key] = positiveInteger(String(parameters[key]), `plan.testPerp.parameters.${key}`);
  }
  if (parameters.baseDecimals !== base.decimals) throw new Error("test perp base decimals must equal the base asset decimals");
  const strategyLabel = typeof testPerp.strategyLabel === "string" && /^[a-z0-9-]{1,48}$/.test(testPerp.strategyLabel) ? testPerp.strategyLabel : "cash-carry-v1";
  const reservation = record(plan.reservationClass, "plan.reservationClass");
  const book = record(plan.packageBookClass, "plan.packageBookClass");
  const shard = record(plan.shard, "plan.shard");
  const units = record(plan.spotMarketUnits, "plan.spotMarketUnits");
  const descriptors = record(plan.descriptors, "plan.descriptors");
  const series = record(plan.series, "plan.series");
  const subjects = { ...DEFAULT_SUBJECTS, ...(plan.protocolSubjectIds ?? {}) };
  for (const [name, subject] of Object.entries(subjects)) protocolSubject(subject, `plan.protocolSubjectIds.${name}`);
  if (new Set(Object.values(subjects)).size !== Object.keys(subjects).length) throw new Error("plan protocol subject ids must be distinct");
  const parsed = {
    domain: parsedDomain,
    environment: typeof plan.environment === "string" ? plan.environment : "devnet",
    configDelaySlots: positiveInteger(String(plan.configDelaySlots), "plan.configDelaySlots", 432_000n),
    roles: { canceller: publicKey(roles.canceller, "plan.roles.canceller"), pauser: publicKey(roles.pauser, "plan.roles.pauser") },
    solverId: publicKey(plan.solverId, "plan.solverId"),
    base,
    quote,
    testPerp: {
      fundingKeeper: publicKey(testPerp.fundingKeeper, "plan.testPerp.fundingKeeper"),
      strategyIdHex: sha256(Buffer.from(`NARYX/solana-devnet/strategy/${strategyLabel}`)).toString("hex"),
      parameters,
    },
    reservationClass: {
      maxTtlSlots: positiveInteger(String(reservation.maxTtlSlots), "plan.reservationClass.maxTtlSlots"),
      maxBaseAtoms: positiveInteger(String(reservation.maxBaseAtoms), "plan.reservationClass.maxBaseAtoms"),
      maxSolverReservedBaseAtoms: positiveInteger(String(reservation.maxSolverReservedBaseAtoms), "plan.reservationClass.maxSolverReservedBaseAtoms"),
    },
    packageBookClass: {
      maxHeartbeatTtlSlots: positiveInteger(String(book.maxHeartbeatTtlSlots), "plan.packageBookClass.maxHeartbeatTtlSlots"),
      maxLevelTtlSlots: positiveInteger(String(book.maxLevelTtlSlots), "plan.packageBookClass.maxLevelTtlSlots"),
      maxAbsReferencePrice: positiveInteger(String(book.maxAbsReferencePrice), "plan.packageBookClass.maxAbsReferencePrice", 2n ** 126n),
      maxAbsReferenceOffset: positiveInteger(String(book.maxAbsReferenceOffset), "plan.packageBookClass.maxAbsReferenceOffset", 2n ** 126n),
      maxFeeAtoms: book.maxFeeAtoms === undefined || book.maxFeeAtoms === 0 || book.maxFeeAtoms === "0" ? 0n : positiveInteger(String(book.maxFeeAtoms), "plan.packageBookClass.maxFeeAtoms"),
    },
    shard: {
      referencePackagePrice: BigInt(shard.referencePackagePrice),
      referenceStateHash: hex32(shard.referenceStateHash, "plan.shard.referenceStateHash"),
    },
    spotMarketUnits: {
      baseLotAtoms: positiveInteger(String(units.baseLotAtoms), "plan.spotMarketUnits.baseLotAtoms"),
      quoteTickAtomsPerBaseLot: positiveInteger(String(units.quoteTickAtomsPerBaseLot), "plan.spotMarketUnits.quoteTickAtomsPerBaseLot"),
      minimumQuoteNotionalAtoms: positiveInteger(String(units.minimumQuoteNotionalAtoms), "plan.spotMarketUnits.minimumQuoteNotionalAtoms"),
    },
    perpMinimumQuoteNotionalAtoms: positiveInteger(String(plan.perpMinimumQuoteNotionalAtoms), "plan.perpMinimumQuoteNotionalAtoms"),
    maximumNotionalAtoms: positiveInteger(String(plan.maximumNotionalAtoms), "plan.maximumNotionalAtoms"),
    descriptors: {
      templateManifestHash: hex32(descriptors.templateManifestHash, "plan.descriptors.templateManifestHash"),
      settlementManifestHash: hex32(descriptors.settlementManifestHash, "plan.descriptors.settlementManifestHash"),
      spotAdapterClassManifestHash: hex32(descriptors.spotAdapterClassManifestHash, "plan.descriptors.spotAdapterClassManifestHash"),
      perpAdapterClassManifestHash: hex32(descriptors.perpAdapterClassManifestHash, "plan.descriptors.perpAdapterClassManifestHash"),
    },
    series: {
      bindingVersion: Number(positiveInteger(String(series.bindingVersion ?? 1), "plan.series.bindingVersion", 0xffffffffn)),
      seriesManifestHash: hex32(series.seriesManifestHash, "plan.series.seriesManifestHash"),
      executionClassManifestHash: hex32(series.executionClassManifestHash, "plan.series.executionClassManifestHash"),
      spotBaseAtomsPerPackageUnit: positiveInteger(String(series.spotBaseAtomsPerPackageUnit), "plan.series.spotBaseAtomsPerPackageUnit", 2n ** 127n),
      perpQuantityAtomsPerPackageUnit: positiveInteger(String(series.perpQuantityAtomsPerPackageUnit), "plan.series.perpQuantityAtomsPerPackageUnit", 2n ** 127n),
    },
    subjects,
    insuranceVaultTargetAtoms: BigInt(plan.insuranceVaultTargetAtoms ?? 0),
    feeVaultTargetAtoms: BigInt(plan.feeVaultTargetAtoms ?? 0),
  };
  if (parsed.packageBookClass.maxLevelTtlSlots > parsed.packageBookClass.maxHeartbeatTtlSlots) throw new Error("plan level TTL must not exceed heartbeat TTL");
  if (parsed.reservationClass.maxSolverReservedBaseAtoms < parsed.reservationClass.maxBaseAtoms) throw new Error("plan solver reservation cap must cover one reservation");
  for (const [name, amount] of [["insuranceVaultTargetAtoms", parsed.insuranceVaultTargetAtoms], ["feeVaultTargetAtoms", parsed.feeVaultTargetAtoms]]) {
    if (amount < 0n || amount > MAX_FUNDING_ATOMS) throw new Error(`plan.${name} must be from 0 to ${MAX_FUNDING_ATOMS} atoms`);
  }
  const absPrice = parsed.shard.referencePackagePrice < 0n ? -parsed.shard.referencePackagePrice : parsed.shard.referencePackagePrice;
  if (absPrice > parsed.packageBookClass.maxAbsReferencePrice) throw new Error("plan shard reference price exceeds the class bound");
  return Object.freeze(parsed);
}

function anchorRef(reference) {
  return { subjectId: Array.from(reference.subjectId), manifestVersion: reference.manifestVersion, manifestHash: Array.from(reference.manifestHash) };
}

function sameRef(onchain, expected) {
  return onchain !== null && onchain !== undefined
    && Buffer.from(onchain.subjectId).equals(Buffer.from(expected.subjectId))
    && onchain.manifestVersion === expected.manifestVersion
    && Buffer.from(onchain.manifestHash).equals(Buffer.from(expected.manifestHash));
}

function hexOf(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/** Derives every account, identity, and manifest the run touches, without any RPC call. */
export function deriveDevnetLayout(plan, programs, keys) {
  const core = programs.core.programId;
  const reservationProgram = programs.reservation.programId;
  const bookProgram = programs.package_book.programId;
  const venueProgram = programs.perp_venue.programId;
  const adapterProgram = programs.perp_adapter.programId;
  const domainIdentity = domainRefIdentityHash(plan.domain);
  const config = pda([Buffer.from("naryx-protocol-config")], core);
  const market = pda([Buffer.from("test-perp-market"), keys.marketOwner.toBuffer(), Buffer.from(SOL_USD_FEED_ID_HEX, "hex")], venueProgram);
  const reservationClass = pda([
    Buffer.from("reservation-class"), domainIdentity, u32be(plan.domain.domainManifestVersion), plan.domain.domainManifestHash,
    plan.base.mint.toBuffer(), plan.quote.mint.toBuffer(), core.toBuffer(),
  ], reservationProgram);
  const packageBookClass = pda([Buffer.from("package-book-class"), domainIdentity, u32le(plan.domain.domainManifestVersion), plan.domain.domainManifestHash], bookProgram);
  const shard = pda([Buffer.from("package-quote-shard"), packageBookClass.toBuffer(), plan.solverId.toBuffer(), plan.series.seriesManifestHash, plan.series.executionClassManifestHash], bookProgram);
  const domainDocument = { domainId: plan.domain.domainId, domainManifestVersion: plan.domain.domainManifestVersion, domainManifestHash: hexOf(plan.domain.domainManifestHash) };
  const identities = {};
  const documents = {};
  const register = (name, kind, protocolSubjectId, document) => {
    const full = { kind, protocolSubjectId, domain: domainDocument, ...document };
    documents[name] = full;
    identities[name] = { protocolSubjectId, subjectId: resourceSubjectId(kind, protocolSubjectId), manifestVersion: 1, manifestHash: resourceManifestHash(full) };
  };
  const ref = (name) => ({ protocolSubjectId: identities[name].protocolSubjectId, manifestVersion: 1, manifestHash: hexOf(identities[name].manifestHash) });
  register("baseAsset", "asset", plan.base.mint.toBase58(), { mint: plan.base.mint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: plan.base.decimals });
  register("quoteAsset", "asset", plan.quote.mint.toBase58(), { mint: plan.quote.mint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: plan.quote.decimals });
  const program = (name) => ({ programId: programs[name].programId.toBase58(), programDataAddress: programs[name].programDataAddress.toBase58(), codeIdentity: hexOf(programs[name].codeIdentity) });
  register("spotVenue", "venue", plan.subjects.spotVenue, { role: "SPOT", subjectAddress: reservationClass.toBase58(), ...program("reservation"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset") });
  register("perpVenue", "venue", plan.subjects.perpVenue, { role: "PERP", subjectAddress: market.toBase58(), ...program("perp_venue"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset") });
  const spotUnits = {
    baseDecimals: plan.base.decimals, quoteDecimals: plan.quote.decimals, baseLotAtoms: plan.spotMarketUnits.baseLotAtoms,
    quoteTickAtomsPerBaseLot: plan.spotMarketUnits.quoteTickAtomsPerBaseLot, minimumQuoteNotionalAtoms: plan.spotMarketUnits.minimumQuoteNotionalAtoms,
    multiplierNumerator: 1n, multiplierDenominator: 1n,
  };
  const perpUnits = {
    baseDecimals: plan.base.decimals, quoteDecimals: plan.quote.decimals, baseLotAtoms: plan.testPerp.parameters.baseLotAtoms,
    quoteTickAtomsPerBaseLot: plan.testPerp.parameters.quoteTickAtomsPerBaseLot, minimumQuoteNotionalAtoms: plan.perpMinimumQuoteNotionalAtoms,
    multiplierNumerator: 1n, multiplierDenominator: 1n,
  };
  register("spotMarket", "market", plan.subjects.spotMarket, { role: "SPOT", subjectAddress: reservationClass.toBase58(), ...program("reservation"), venue: ref("spotVenue"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset"), units: spotUnits });
  register("perpMarket", "market", plan.subjects.perpMarket, { role: "PERP", subjectAddress: market.toBase58(), ...program("perp_venue"), venue: ref("perpVenue"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset"), units: perpUnits });
  const template = { id: TEMPLATE_ID, version: 1, manifestHash: plan.descriptors.templateManifestHash };
  const settlement = { class: "ATOMIC_POSTCONDITION", version: 1, manifestHash: plan.descriptors.settlementManifestHash };
  const descriptorDocument = (value) => ({ ...value, manifestHash: hexOf(value.manifestHash) });
  const spotClass = { id: FIRM_SPOT_CLASS_ID, version: 1, manifestHash: plan.descriptors.spotAdapterClassManifestHash };
  const perpClass = { id: PERP_CLASS_ID, version: 1, manifestHash: plan.descriptors.perpAdapterClassManifestHash };
  register("spotAdapter", "adapter", plan.subjects.spotAdapter, {
    role: "SPOT", subjectAddress: reservationProgram.toBase58(), ...program("reservation"), adapterClass: descriptorDocument(spotClass),
    venue: ref("spotVenue"), market: ref("spotMarket"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset"),
    template: descriptorDocument(template), settlement: descriptorDocument(settlement),
  });
  register("perpAdapter", "adapter", plan.subjects.perpAdapter, {
    role: "PERP", subjectAddress: adapterProgram.toBase58(), ...program("perp_adapter"), adapterClass: descriptorDocument(perpClass),
    venue: ref("perpVenue"), market: ref("perpMarket"), baseAsset: ref("baseAsset"), quoteAsset: ref("quoteAsset"),
    template: descriptorDocument(template), settlement: descriptorDocument(settlement),
  });
  const kindSeed = { baseAsset: "asset", quoteAsset: "asset", spotVenue: "venue", perpVenue: "venue", spotMarket: "market", perpMarket: "market", spotAdapter: "adapter", perpAdapter: "adapter" };
  const indexes = {};
  const records = {};
  for (const [name, identity] of Object.entries(identities)) {
    indexes[name] = pda([Buffer.from("naryx-resource-index"), Buffer.from(kindSeed[name]), identity.subjectId], core);
    records[name] = pda([Buffer.from("naryx-resource-record"), Buffer.from(kindSeed[name]), identity.subjectId, u32be(1)], core);
  }
  const binding = {
    schemaVersion: 1,
    bindingVersion: plan.series.bindingVersion,
    domainRefIdentityHash: domainIdentity,
    seriesManifestHash: plan.series.seriesManifestHash,
    executionClassManifestHash: plan.series.executionClassManifestHash,
    templateIdentityHash: protocolIdIdentityHash(TEMPLATE_ID),
    templateVersion: 1,
    templateManifestHash: plan.descriptors.templateManifestHash,
    settlementClassIdentityHash: atomicPostconditionIdentityHash(),
    baseAsset: identities.baseAsset,
    quoteAsset: identities.quoteAsset,
    quoteConventionIdentityHash: protocolIdIdentityHash(QUOTE_CONVENTION_ID),
    entrySide: 1,
    spotBaseAtomsPerPackageUnit: plan.series.spotBaseAtomsPerPackageUnit,
    perpQuantityAtomsPerPackageUnit: plan.series.perpQuantityAtomsPerPackageUnit,
  };
  const seriesHashes = seriesBindingHashes(binding);
  const seriesIndex = pda([Buffer.from("cash-carry-series-index"), seriesHashes.identityKey], core);
  const seriesRecord = pda([Buffer.from("cash-carry-series-record"), seriesHashes.identityKey, u32be(binding.bindingVersion)], core);
  return Object.freeze({
    domainIdentity,
    config,
    solverRegistry: pda([Buffer.from("conformance-solver")], core),
    market,
    collateralVault: pda([Buffer.from("test-perp-collateral-vault"), market.toBuffer()], venueProgram),
    feeVault: pda([Buffer.from("test-perp-fee-vault"), market.toBuffer()], venueProgram),
    insuranceVault: pda([Buffer.from("test-perp-insurance-vault"), market.toBuffer()], venueProgram),
    reservationClass,
    packageBookClass,
    shard,
    levelPage: pda([Buffer.from("quote-level-page"), shard.toBuffer()], bookProgram),
    identities,
    documents,
    indexes,
    records,
    spotUnits,
    perpUnits,
    template,
    settlement,
    spotClass,
    perpClass,
    binding,
    seriesHashes,
    seriesIndex,
    seriesRecord,
    solverBase: associatedTokenAddress(plan.solverId, plan.base.mint),
    solverQuote: associatedTokenAddress(plan.solverId, plan.quote.mint),
    resourceAdmissionCommitment: resourceAdmissionCommitment({
      domain: plan.domain, identities, template, settlement, quoteDecimals: plan.quote.decimals, records,
    }),
  });
}

/** Runtime manifest, solver config, and order context fragments the services load as data. */
export function serviceFragments(plan, programs, layout, release) {
  const programEntries = Object.entries(RELEASE_PROGRAMS).map(([releaseName, name]) => {
    const evidence = release.programs.find((item) => item.name === releaseName);
    return {
      name,
      programId: evidence.programId,
      programDataAddress: evidence.programDataAddress,
      deploymentSlot: BigInt(evidence.deploymentSlot),
      upgradeAuthority: evidence.upgradeAuthority === null ? { kind: "IMMUTABLE" } : { kind: "EXACT", authority: evidence.upgradeAuthority },
      programDataHeaderIdentity: Buffer.from(evidence.programDataHeaderIdentity, "hex"),
      programElfSha256: Buffer.from(evidence.programElfSha256, "hex"),
    };
  });
  const id = layout.identities;
  const versioned = (name) => ({ subjectId: id[name].protocolSubjectId, manifestVersion: 1, manifestHash: id[name].manifestHash });
  const adapterRef = (name) => ({ adapterId: id[name].protocolSubjectId, adapterManifestVersion: 1, adapterManifestHash: id[name].manifestHash });
  const resource = (name, subjectAddress, programId, codeIdentity, adapterClassId) => ({
    manifestHash: id[name].manifestHash,
    subjectAddress: subjectAddress.toBase58(),
    programId: programId.toBase58(),
    ...(codeIdentity === undefined ? {} : { codeIdentity }),
    ...(adapterClassId === undefined ? {} : { adapterClassId }),
  });
  const reservation = programs.reservation;
  const venue = programs.perp_venue;
  const adapter = programs.perp_adapter;
  const assetRef = (name, asset) => ({ assetId: asset.mint.toBase58(), assetManifestHash: id[name].manifestHash, decimals: asset.decimals });
  return protocolJson({
    runtimeManifest: {
      domain: plan.domain,
      expectedGenesisHash: release.genesisHash,
      programs: programEntries,
      perpVenueKind: "NARYX_TEST_PERP",
      testPerp: { market: layout.market, oracle: SOL_USD_PRICE_ACCOUNT, feedIdHex: SOL_USD_FEED_ID_HEX, strategyIdHex: plan.testPerp.strategyIdHex },
      lookupTables: [],
    },
    solverConfig: {
      solverId: plan.solverId,
      spot: { adapter: adapterRef("spotAdapter"), venue: versioned("spotVenue"), market: versioned("spotMarket") },
      perpetual: { adapter: adapterRef("perpAdapter"), venue: versioned("perpVenue"), market: versioned("perpMarket") },
      accounts: {
        config: layout.config,
        solverRegistry: layout.solverRegistry,
        reservationClass: layout.reservationClass,
        seriesIndex: layout.seriesIndex,
        seriesRecord: layout.seriesRecord,
        packageBookClass: layout.packageBookClass,
        packageBookShard: layout.shard,
        packageBookLevelPage: layout.levelPage,
        indexes: layout.indexes,
        records: layout.records,
      },
      resources: {
        spotAdapter: resource("spotAdapter", reservation.programId, reservation.programId, reservation.codeIdentity, FIRM_SPOT_CLASS_ID),
        perpAdapter: resource("perpAdapter", adapter.programId, adapter.programId, adapter.codeIdentity, PERP_CLASS_ID),
        spotMarket: resource("spotMarket", layout.reservationClass, reservation.programId, reservation.codeIdentity),
        perpMarket: resource("perpMarket", layout.market, venue.programId, venue.codeIdentity),
        spotVenue: resource("spotVenue", layout.reservationClass, reservation.programId, reservation.codeIdentity),
        perpVenue: resource("perpVenue", layout.market, venue.programId, venue.codeIdentity),
        baseAsset: resource("baseAsset", plan.base.mint, TOKEN_PROGRAM_ID),
        quoteAsset: resource("quoteAsset", plan.quote.mint, TOKEN_PROGRAM_ID),
      },
      spotBaseLotAtoms: plan.spotMarketUnits.baseLotAtoms,
      series: {
        seriesManifestHash: plan.series.seriesManifestHash,
        executionClassManifestHash: plan.series.executionClassManifestHash,
        settlementClassIdentityHash: layout.binding.settlementClassIdentityHash,
        spotBaseAtomsPerPackageUnit: plan.series.spotBaseAtomsPerPackageUnit,
        perpQuantityAtomsPerPackageUnit: plan.series.perpQuantityAtomsPerPackageUnit,
      },
      resourceAdmissionCommitment: layout.resourceAdmissionCommitment,
    },
    orderContext: {
      templateId: TEMPLATE_ID,
      templateVersion: 1,
      packageTemplateManifestHash: plan.descriptors.templateManifestHash,
      baseAsset: assetRef("baseAsset", plan.base),
      quoteAsset: assetRef("quoteAsset", plan.quote),
      spotAdapter: adapterRef("spotAdapter"),
      perpetualAdapter: adapterRef("perpAdapter"),
      registry: {
        baseAssetIndex: layout.indexes.baseAsset,
        baseAssetRecord: layout.records.baseAsset,
        quoteAssetIndex: layout.indexes.quoteAsset,
        quoteAssetRecord: layout.records.quoteAsset,
      },
    },
  });
}

const ACTIVE = { active: {} };

function control(plan, layout, kind) {
  return {
    lifecycle: ACTIVE,
    quoteLimit: kind === "asset" ? null : {
      quoteAsset: anchorRef(layout.identities.quoteAsset),
      quoteDecimals: plan.quote.decimals,
      maximumNotionalAtoms: new BN(plan.maximumNotionalAtoms.toString()),
    },
  };
}

function anchorUnits(units) {
  return Object.fromEntries(Object.entries(units).map(([key, value]) => [key, typeof value === "bigint" ? new BN(value.toString()) : value]));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), [
    "cluster", "rpc-url", "release", "plan", "payer", "upgrade-authority", "proposer", "executor", "market-owner", "solver", "funder",
    "out", "idl-dir", "max-wait-seconds",
  ], ["send"]);
  requireDevnetCluster(flags);
  const send = flags.send === true;
  const releasePath = absolutePath(flags.release, "--release");
  const plan = parsePlan(JSON.parse(readFileSync(absolutePath(flags.plan, "--plan"), "utf8")));
  const payer = loadKeypair(flags.payer, "--payer");
  const upgradeAuthority = loadKeypair(flags["upgrade-authority"], "--upgrade-authority");
  const proposer = loadKeypair(flags.proposer, "--proposer");
  const executor = loadKeypair(flags.executor, "--executor");
  const marketOwner = loadKeypair(flags["market-owner"], "--market-owner");
  const solver = loadKeypair(flags.solver, "--solver");
  const funder = flags.funder === undefined ? undefined : loadKeypair(flags.funder, "--funder");
  if (!solver.publicKey.equals(plan.solverId)) throw new Error("--solver does not match plan.solverId");
  const roleKeys = [proposer.publicKey, plan.roles.canceller, executor.publicKey, plan.roles.pauser].map((key) => key.toBase58());
  if (new Set(roleKeys).size !== 4) throw new Error("governance proposer, canceller, executor, and pauser must be four distinct keys");
  const maxWaitSeconds = Number(flags["max-wait-seconds"] ?? 900);

  const connection = new web3.Connection(rpcUrl(flags), "confirmed");
  const genesisHash = await requireDevnetGenesis(connection);
  const release = await verifyCandidateRelease(parseCandidateReleaseManifest(JSON.parse(readFileSync(releasePath, "utf8")), releasePath), connection);
  const programs = {};
  for (const [releaseName, name] of Object.entries(RELEASE_PROGRAMS)) {
    const evidence = release.programs.find((item) => item.name === releaseName);
    if (evidence === undefined) throw new Error(`release manifest must include ${releaseName}`);
    programs[name] = {
      programId: new web3.PublicKey(evidence.programId),
      programDataAddress: new web3.PublicKey(evidence.programDataAddress),
      codeIdentity: Buffer.from(evidence.programDataHeaderIdentity, "hex"),
      upgradeAuthority: evidence.upgradeAuthority,
    };
  }
  for (const name of ["core", "reservation", "package_book"]) {
    if (programs[name].upgradeAuthority !== upgradeAuthority.publicKey.toBase58()) {
      throw new Error(`--upgrade-authority is not the live ${name} upgrade authority`);
    }
  }
  const layout = deriveDevnetLayout(plan, programs, { marketOwner: marketOwner.publicKey });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const idlDirectory = flags["idl-dir"] === undefined ? undefined : absolutePath(flags["idl-dir"], "--idl-dir");
  const idlPath = (name) => (idlDirectory === undefined ? defaultIdlPath(name) : `${idlDirectory}/${name}.json`);
  const core = new Program(loadIdl(idlPath("naryx_core"), programs.core.programId, ["initialize", "propose_asset", "propose_initial_cash_carry_series_binding"]), provider);
  const reservation = new Program(loadIdl(idlPath("naryx_inventory_reservation"), programs.reservation.programId, ["initialize_class"]), provider);
  const book = new Program(loadIdl(idlPath("naryx_package_book"), programs.package_book.programId, ["initialize_class", "initialize_shard"]), provider);
  const venue = new Program(loadIdl(idlPath("naryx_test_perp"), programs.perp_venue.programId, ["initialize_market"]), provider);

  const results = [];
  const done = new Set();
  const fetchAccount = (address) => connection.getAccountInfo(address, "confirmed");
  const decode = (program, name, info) => program.coder.accounts.decode(name, info.data);
  const owned = (info, program, name) => {
    if (info !== null && !info.owner.equals(program)) throw new Error(`${name} exists with an unexpected owner`);
    return info;
  };

  async function run(name, requires, inspect, build) {
    if (requires.some((dependency) => !done.has(dependency))) {
      results.push({ name, status: "PENDING_PRIOR_STEP" });
      return;
    }
    const state = await inspect();
    if (state.done) {
      done.add(name);
      results.push({ name, status: "ALREADY_DONE", ...(state.detail ?? {}) });
      return;
    }
    if (state.waitSlot !== undefined) {
      if (!send) {
        results.push({ name, status: "WAITING_FOR_ACTIVATION_SLOT", activationSlot: state.waitSlot.toString() });
        return;
      }
      await waitForSlot(connection, state.waitSlot, maxWaitSeconds);
    }
    const step = await build();
    const outcome = await executeStep(connection, { label: name, ...step }, { payer, send });
    if (send) done.add(name);
    results.push({ name, ...outcome });
  }

  // 1. Core protocol config.
  await run("core.initialize", [], async () => {
    const info = owned(await fetchAccount(layout.config), programs.core.programId, "protocol config");
    if (info === null) return {};
    const config = decode(core, "protocolConfig", info);
    if (config.domain.domainId !== plan.domain.domainId || config.domain.domainManifestVersion !== plan.domain.domainManifestVersion
      || !Buffer.from(config.domain.domainManifestHash).equals(plan.domain.domainManifestHash)
      || !config.proposer.equals(proposer.publicKey) || !config.executor.equals(executor.publicKey)) {
      throw new Error("existing protocol config does not match the plan domain or governance roles");
    }
    return { done: true };
  }, async () => ({
    instructions: [await core.methods.initialize(
      plan.environment, plan.domain.domainId, plan.domain.domainManifestVersion, Array.from(plan.domain.domainManifestHash),
      new BN(plan.configDelaySlots.toString()),
      { proposer: proposer.publicKey, canceller: plan.roles.canceller, executor: executor.publicKey, pauser: plan.roles.pauser },
    ).accountsStrict({
      payer: payer.publicKey, initializer: upgradeAuthority.publicKey, program: programs.core.programId,
      programData: programs.core.programDataAddress, config: layout.config, systemProgram: web3.SystemProgram.programId,
    }).instruction()],
    signers: [upgradeAuthority],
  }));

  // 2. Solver registration and entry unpause, each proposed and then activated after the delay.
  const registry = async () => {
    const info = owned(await fetchAccount(layout.solverRegistry), programs.core.programId, "solver registry");
    return info === null ? undefined : decode(core, "solverRegistry", info);
  };
  await run("core.propose_solver", ["core.initialize"], async () => {
    const state = await registry();
    const known = state !== undefined && (state.active.some((key) => key.equals(plan.solverId)) || state.pending.some((item) => item.key.equals(plan.solverId)));
    return { done: known };
  }, async () => ({
    instructions: [await core.methods.proposeSolver(plan.solverId).accountsStrict({
      proposer: proposer.publicKey, config: layout.config, registry: layout.solverRegistry, systemProgram: web3.SystemProgram.programId,
    }).instruction()],
    signers: [proposer],
  }));
  await run("core.schedule_unpause", ["core.initialize"], async () => {
    const config = decode(core, "protocolConfig", await fetchAccount(layout.config));
    return { done: !config.entryPaused || config.pendingUnpauseSlot !== null };
  }, async () => ({
    instructions: [await core.methods.scheduleUnpause().accountsStrict({ proposer: proposer.publicKey, config: layout.config }).instruction()],
    signers: [proposer],
  }));
  await run("core.activate_solver", ["core.propose_solver"], async () => {
    const state = await registry();
    if (state.active.some((key) => key.equals(plan.solverId))) return { done: true };
    const pending = state.pending.find((item) => item.key.equals(plan.solverId));
    return { waitSlot: BigInt(pending.activationSlot.toString()) };
  }, async () => ({
    instructions: [await core.methods.activateSolver(plan.solverId).accountsStrict({
      executor: executor.publicKey, config: layout.config, registry: layout.solverRegistry,
    }).instruction()],
    signers: [executor],
  }));
  await run("core.activate_unpause", ["core.schedule_unpause"], async () => {
    const config = decode(core, "protocolConfig", await fetchAccount(layout.config));
    if (!config.entryPaused) return { done: true };
    return { waitSlot: BigInt(config.pendingUnpauseSlot.toString()) };
  }, async () => ({
    instructions: [await core.methods.activateUnpause().accountsStrict({ executor: executor.publicKey, config: layout.config }).instruction()],
    signers: [executor],
  }));

  // 3. Test perp market with the recommended parameters, pinned to the Pyth SOL/USD account.
  const parameters = plan.testPerp.parameters;
  await run("test_perp.initialize_market", [], async () => {
    const info = owned(await fetchAccount(layout.market), programs.perp_venue.programId, "test perp market");
    if (info === null) return {};
    const market = decode(venue, "testPerpMarket", info);
    if (!market.collateralMint.equals(plan.quote.mint) || market.oracle.toBase58() !== SOL_USD_PRICE_ACCOUNT
      || Buffer.from(market.feedId).toString("hex") !== SOL_USD_FEED_ID_HEX
      || BigInt(market.baseLotAtoms.toString()) !== parameters.baseLotAtoms
      || BigInt(market.quoteTickAtomsPerBaseLot.toString()) !== parameters.quoteTickAtomsPerBaseLot
      || market.baseDecimals !== parameters.baseDecimals) {
      throw new Error("existing test perp market does not match the plan");
    }
    return { done: true };
  }, async () => ({
    instructions: [await venue.methods.initializeMarket({
      feedId: Array.from(Buffer.from(SOL_USD_FEED_ID_HEX, "hex")),
      fundingKeeper: plan.testPerp.fundingKeeper,
      baseDecimals: parameters.baseDecimals,
      maxPriceAgeSeconds: parameters.maxPriceAgeSeconds,
      maxConfidenceBps: parameters.maxConfidenceBps,
      takerFeeBps: parameters.takerFeeBps,
      halfSpreadBps: parameters.halfSpreadBps,
      impactBpsPerUnit: parameters.impactBpsPerUnit,
      impactUnitLots: new BN(parameters.impactUnitLots.toString()),
      maxSlippageBps: parameters.maxSlippageBps,
      initialMarginBps: parameters.initialMarginBps,
      maintenanceMarginBps: parameters.maintenanceMarginBps,
      liquidationPenaltyBps: parameters.liquidationPenaltyBps,
      baseLotAtoms: new BN(parameters.baseLotAtoms.toString()),
      quoteTickAtomsPerBaseLot: new BN(parameters.quoteTickAtomsPerBaseLot.toString()),
      maxPositionLots: new BN(parameters.maxPositionLots.toString()),
      maxFundingRatePerSecond: new BN(parameters.maxFundingRatePerSecond.toString()),
    }).accountsStrict({
      owner: marketOwner.publicKey, collateralMint: plan.quote.mint, oracle: new web3.PublicKey(SOL_USD_PRICE_ACCOUNT),
      market: layout.market, collateralVault: layout.collateralVault, feeVault: layout.feeVault, insuranceVault: layout.insuranceVault,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: web3.SystemProgram.programId,
    }).instruction()],
    signers: [marketOwner],
  }));

  // 4. Inventory reservation class consumed by core.
  await run("reservation.initialize_class", ["core.initialize"], async () => {
    const info = owned(await fetchAccount(layout.reservationClass), programs.reservation.programId, "reservation class");
    if (info === null) return {};
    const state = decode(reservation, "reservationClass", info);
    if (!state.baseMint.equals(plan.base.mint) || !state.quoteMint.equals(plan.quote.mint) || !state.consumerProgram.equals(programs.core.programId)
      || BigInt(state.maxBaseAtoms.toString()) !== plan.reservationClass.maxBaseAtoms) {
      throw new Error("existing reservation class does not match the plan");
    }
    return { done: true };
  }, async () => ({
    instructions: [await reservation.methods.initializeClass({
      domainIdentity: Array.from(layout.domainIdentity),
      maxTtlSlots: new BN(plan.reservationClass.maxTtlSlots.toString()),
      maxBaseAtoms: new BN(plan.reservationClass.maxBaseAtoms.toString()),
      maxSolverReservedBaseAtoms: new BN(plan.reservationClass.maxSolverReservedBaseAtoms.toString()),
    }).accountsStrict({
      payer: payer.publicKey, initializer: upgradeAuthority.publicKey, program: programs.reservation.programId,
      programData: programs.reservation.programDataAddress, coreProgram: programs.core.programId, coreProgramData: programs.core.programDataAddress,
      protocolConfig: layout.config, consumerProgram: programs.core.programId, consumerProgramData: programs.core.programDataAddress,
      baseMint: plan.base.mint, quoteMint: plan.quote.mint, reservationClass: layout.reservationClass, systemProgram: web3.SystemProgram.programId,
    }).instruction()],
    signers: [upgradeAuthority],
  }));

  // 5. Package book class with firm onchain quotes consumed by core.
  await run("package_book.initialize_class", ["core.initialize"], async () => {
    const info = owned(await fetchAccount(layout.packageBookClass), programs.package_book.programId, "package book class");
    if (info === null) return {};
    const state = decode(book, "packageBookClass", info);
    if (!state.firmOnchainEnabled || !state.consumerProgram.equals(programs.core.programId)) throw new Error("existing package book class does not match the plan");
    return { done: true };
  }, async () => ({
    instructions: [await book.methods.initializeClass({
      domainIdentityHash: Array.from(layout.domainIdentity),
      domainManifestVersion: plan.domain.domainManifestVersion,
      domainManifestHash: Array.from(plan.domain.domainManifestHash),
      maxHeartbeatTtlSlots: new BN(plan.packageBookClass.maxHeartbeatTtlSlots.toString()),
      maxLevelTtlSlots: new BN(plan.packageBookClass.maxLevelTtlSlots.toString()),
      maxAbsReferencePrice: new BN(plan.packageBookClass.maxAbsReferencePrice.toString()),
      maxAbsReferenceOffset: new BN(plan.packageBookClass.maxAbsReferenceOffset.toString()),
      maxFeeAtoms: new BN(plan.packageBookClass.maxFeeAtoms.toString()),
      firmOnchainEnabled: true,
    }).accountsStrict({
      payer: payer.publicKey, initializer: upgradeAuthority.publicKey, program: programs.package_book.programId,
      programData: programs.package_book.programDataAddress, coreProgram: programs.core.programId, coreProgramData: programs.core.programDataAddress,
      protocolConfig: layout.config, consumerProgram: programs.core.programId, consumerProgramData: programs.core.programDataAddress,
      packageBookClass: layout.packageBookClass, systemProgram: web3.SystemProgram.programId,
    }).instruction()],
    signers: [upgradeAuthority],
  }));

  // 6. Resource registrations: assets, venues, markets, adapters, each wave proposed then activated.
  const resourceIndex = async (name) => {
    const info = owned(await fetchAccount(layout.indexes[name]), programs.core.programId, `${name} index`);
    return info === null ? undefined : decode(core, "resourceIndex", info);
  };
  const common = (name) => ({
    payer: payer.publicKey, proposer: proposer.publicKey, config: layout.config,
    index: layout.indexes[name], record: layout.records[name], systemProgram: web3.SystemProgram.programId,
  });
  const programData = (name) => programs[name].programDataAddress;
  const proposals = {
    baseAsset: ["core.initialize"],
    quoteAsset: ["core.initialize"],
    spotVenue: ["activate.baseAsset", "activate.quoteAsset", "reservation.initialize_class"],
    perpVenue: ["activate.baseAsset", "activate.quoteAsset", "test_perp.initialize_market"],
    spotMarket: ["activate.spotVenue"],
    perpMarket: ["activate.perpVenue"],
    spotAdapter: ["activate.spotMarket"],
    perpAdapter: ["activate.perpMarket"],
  };
  const builders = {
    baseAsset: () => core.methods.proposeAsset({ identity: anchorRef(layout.identities.baseAsset), decimals: plan.base.decimals, control: control(plan, layout, "asset") })
      .accountsStrict({ ...common("baseAsset"), tokenProgram: TOKEN_PROGRAM_ID, mint: plan.base.mint }),
    quoteAsset: () => core.methods.proposeAsset({ identity: anchorRef(layout.identities.quoteAsset), decimals: plan.quote.decimals, control: control(plan, layout, "asset") })
      .accountsStrict({ ...common("quoteAsset"), tokenProgram: TOKEN_PROGRAM_ID, mint: plan.quote.mint }),
    spotVenue: () => core.methods.proposeVenue({
      identity: anchorRef(layout.identities.spotVenue), role: { spot: {} }, baseAsset: anchorRef(layout.identities.baseAsset),
      quoteAsset: anchorRef(layout.identities.quoteAsset), control: control(plan, layout, "venue"),
    }).accountsStrict({
      ...common("spotVenue"), baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      venueProgram: programs.reservation.programId, venueProgramData: programData("reservation"), venueAccount: layout.reservationClass,
    }),
    perpVenue: () => core.methods.proposeVenue({
      identity: anchorRef(layout.identities.perpVenue), role: { perp: {} }, baseAsset: anchorRef(layout.identities.baseAsset),
      quoteAsset: anchorRef(layout.identities.quoteAsset), control: control(plan, layout, "venue"),
    }).accountsStrict({
      ...common("perpVenue"), baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      venueProgram: programs.perp_venue.programId, venueProgramData: programData("perp_venue"), venueAccount: layout.market,
    }),
    spotMarket: () => core.methods.proposeMarket({
      identity: anchorRef(layout.identities.spotMarket), role: { spot: {} }, venue: anchorRef(layout.identities.spotVenue),
      baseAsset: anchorRef(layout.identities.baseAsset), quoteAsset: anchorRef(layout.identities.quoteAsset),
      units: anchorUnits(layout.spotUnits), control: control(plan, layout, "market"),
    }).accountsStrict({
      ...common("spotMarket"), venue: layout.records.spotVenue, baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      venueProgram: programs.reservation.programId, venueProgramData: programData("reservation"), marketAccount: layout.reservationClass,
    }),
    perpMarket: () => core.methods.proposeMarket({
      identity: anchorRef(layout.identities.perpMarket), role: { perp: {} }, venue: anchorRef(layout.identities.perpVenue),
      baseAsset: anchorRef(layout.identities.baseAsset), quoteAsset: anchorRef(layout.identities.quoteAsset),
      units: anchorUnits(layout.perpUnits), control: control(plan, layout, "market"),
    }).accountsStrict({
      ...common("perpMarket"), venue: layout.records.perpVenue, baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      venueProgram: programs.perp_venue.programId, venueProgramData: programData("perp_venue"), marketAccount: layout.market,
    }),
    spotAdapter: () => core.methods.proposeAdapter(adapterArgs("spot")).accountsStrict({
      ...common("spotAdapter"), venue: layout.records.spotVenue, market: layout.records.spotMarket,
      baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      adapterProgram: programs.reservation.programId, adapterProgramData: programData("reservation"),
    }),
    perpAdapter: () => core.methods.proposeAdapter(adapterArgs("perp")).accountsStrict({
      ...common("perpAdapter"), venue: layout.records.perpVenue, market: layout.records.perpMarket,
      baseAsset: layout.records.baseAsset, quoteAsset: layout.records.quoteAsset,
      adapterProgram: programs.perp_adapter.programId, adapterProgramData: programData("perp_adapter"),
    }),
  };
  function adapterArgs(side) {
    const descriptor = (value) => ({ id: { value: value.id }, version: value.version, manifestHash: Array.from(value.manifestHash) });
    return {
      identity: anchorRef(layout.identities[`${side}Adapter`]),
      role: side === "spot" ? { spot: {} } : { perp: {} },
      adapterClass: descriptor(side === "spot" ? layout.spotClass : layout.perpClass),
      venue: anchorRef(layout.identities[`${side}Venue`]),
      market: anchorRef(layout.identities[`${side}Market`]),
      baseAsset: anchorRef(layout.identities.baseAsset),
      quoteAsset: anchorRef(layout.identities.quoteAsset),
      allowedTemplate: descriptor(layout.template),
      settlement: { class: { atomicPostcondition: {} }, version: 1, manifestHash: Array.from(layout.settlement.manifestHash) },
      control: control(plan, layout, "adapter"),
    };
  }
  const waves = [["baseAsset", "quoteAsset"], ["spotVenue", "perpVenue"], ["spotMarket", "perpMarket"], ["spotAdapter", "perpAdapter"]];
  for (const wave of waves) {
    for (const name of wave) {
      await run(`propose.${name}`, proposals[name], async () => {
        const index = await resourceIndex(name);
        if (index === undefined) return {};
        const expected = layout.identities[name];
        if (sameRef(index.activeIdentity, expected) || sameRef(index.pendingIdentity, expected)) return { done: true };
        throw new Error(`${name} index holds a different identity than the plan`);
      }, async () => ({ instructions: [await builders[name]().instruction()], signers: [proposer] }));
    }
    for (const name of wave) {
      await run(`activate.${name}`, [`propose.${name}`], async () => {
        const index = await resourceIndex(name);
        if (index.activeRecord.equals(layout.records[name])) return { done: true };
        if (!index.pendingRecord.equals(layout.records[name])) throw new Error(`${name} has no pending registration for the planned record`);
        return { waitSlot: BigInt(index.activationSlot.toString()) };
      }, async () => ({
        instructions: [await core.methods.activateInitialResource().accountsStrict({
          executor: executor.publicKey, config: layout.config, index: layout.indexes[name], record: layout.records[name],
        }).instruction()],
        signers: [executor],
      }));
    }
  }

  // 7. Cash-and-carry series binding.
  const seriesAccounts = {
    config: layout.config, index: layout.seriesIndex, record: layout.seriesRecord,
    baseAssetIndex: layout.indexes.baseAsset, baseAsset: layout.records.baseAsset,
    quoteAssetIndex: layout.indexes.quoteAsset, quoteAsset: layout.records.quoteAsset,
  };
  const seriesIndex = async () => {
    const info = owned(await fetchAccount(layout.seriesIndex), programs.core.programId, "series index");
    return info === null ? undefined : decode(core, "cashCarrySeriesBindingIndex", info);
  };
  await run("propose.series", ["activate.baseAsset", "activate.quoteAsset"], async () => {
    const index = await seriesIndex();
    if (index === undefined) return {};
    const hash = layout.seriesHashes.bindingHash;
    if (Buffer.from(index.activeBindingHash).equals(hash) || Buffer.from(index.pendingBindingHash).equals(hash)) return { done: true };
    throw new Error("series index holds a different binding than the plan");
  }, async () => {
    const binding = layout.binding;
    return {
      instructions: [await core.methods.proposeInitialCashCarrySeriesBinding({
        binding: {
          schemaVersion: binding.schemaVersion,
          bindingVersion: binding.bindingVersion,
          domainRefIdentityHash: Array.from(binding.domainRefIdentityHash),
          seriesManifestHash: Array.from(binding.seriesManifestHash),
          executionClassManifestHash: Array.from(binding.executionClassManifestHash),
          templateIdentityHash: Array.from(binding.templateIdentityHash),
          templateVersion: binding.templateVersion,
          templateManifestHash: Array.from(binding.templateManifestHash),
          settlementClassIdentityHash: Array.from(binding.settlementClassIdentityHash),
          baseAsset: anchorRef(binding.baseAsset),
          quoteAsset: anchorRef(binding.quoteAsset),
          quoteConventionIdentityHash: Array.from(binding.quoteConventionIdentityHash),
          entrySide: binding.entrySide,
          spotBaseAtomsPerPackageUnit: new BN(binding.spotBaseAtomsPerPackageUnit.toString()),
          perpQuantityAtomsPerPackageUnit: new BN(binding.perpQuantityAtomsPerPackageUnit.toString()),
        },
        expectedIdentityKey: Array.from(layout.seriesHashes.identityKey),
        expectedBindingHash: Array.from(layout.seriesHashes.bindingHash),
        lifecycle: ACTIVE,
      }).accountsStrict({ payer: payer.publicKey, proposer: proposer.publicKey, ...seriesAccounts, systemProgram: web3.SystemProgram.programId }).instruction()],
      signers: [proposer],
    };
  });
  await run("activate.series", ["propose.series"], async () => {
    const index = await seriesIndex();
    if (index.activeRecord.equals(layout.seriesRecord)) return { done: true };
    return { waitSlot: BigInt(index.activationSlot.toString()) };
  }, async () => ({
    instructions: [await core.methods.activateInitialCashCarrySeriesBinding().accountsStrict({ executor: executor.publicKey, ...seriesAccounts }).instruction()],
    signers: [executor],
  }));

  // 8. The solver's package book shard, signed by the solver key.
  await run("package_book.initialize_shard", ["package_book.initialize_class"], async () => {
    const info = owned(await fetchAccount(layout.shard), programs.package_book.programId, "package book shard");
    return { done: info !== null };
  }, async () => {
    const slot = BigInt(await connection.getSlot("confirmed"));
    return {
      instructions: [await book.methods.initializeShard({
        solverId: { value: plan.solverId.toBase58() },
        seriesManifestHash: Array.from(plan.series.seriesManifestHash),
        executionClassManifestHash: Array.from(plan.series.executionClassManifestHash),
        referencePackagePrice: new BN(plan.shard.referencePackagePrice.toString()),
        referenceStateHash: Array.from(plan.shard.referenceStateHash),
        heartbeatExpirySlot: new BN((slot + (plan.packageBookClass.maxHeartbeatTtlSlots > 1n ? plan.packageBookClass.maxHeartbeatTtlSlots / 2n : 1n)).toString()),
      }).accountsStrict({
        solver: solver.publicKey, coreProgram: programs.core.programId, coreProgramData: programs.core.programDataAddress,
        protocolConfig: layout.config, consumerProgram: programs.core.programId, consumerProgramData: programs.core.programDataAddress,
        packageBookClass: layout.packageBookClass, shard: layout.shard, levelPage: layout.levelPage, systemProgram: web3.SystemProgram.programId,
      }).instruction()],
      signers: [solver],
    };
  });

  // 9. Solver inventory token accounts for both mints.
  await run("solver.inventory_token_accounts", [], async () => {
    const [base, quote] = await connection.getMultipleAccountsInfo([layout.solverBase, layout.solverQuote], "confirmed");
    for (const [info, mint] of [[base, plan.base.mint], [quote, plan.quote.mint]]) {
      if (info === null) continue;
      const token = decodeTokenAccount(info.data);
      if (!info.owner.equals(TOKEN_PROGRAM_ID) || !token.mint.equals(mint) || !token.owner.equals(plan.solverId)) throw new Error("solver token account is malformed");
    }
    return { done: base !== null && quote !== null };
  }, async () => ({
    instructions: [
      createAssociatedTokenIdempotent(payer.publicKey, plan.solverId, plan.base.mint),
      createAssociatedTokenIdempotent(payer.publicKey, plan.solverId, plan.quote.mint),
    ],
    signers: [],
  }));

  // 10. Insurance and fee vault top-ups from the funder's quote token account, in exact atoms.
  for (const [name, vault, target] of [["insurance", layout.insuranceVault, plan.insuranceVaultTargetAtoms], ["fee", layout.feeVault, plan.feeVaultTargetAtoms]]) {
    if (target === 0n) continue;
    await run(`fund.${name}_vault`, ["test_perp.initialize_market"], async () => {
      const info = await fetchAccount(vault);
      const token = decodeTokenAccount(info.data);
      if (!info.owner.equals(TOKEN_PROGRAM_ID) || !token.mint.equals(plan.quote.mint)) throw new Error(`${name} vault is not a quote token account`);
      return { done: token.amount >= target, detail: { balanceAtoms: token.amount.toString() } };
    }, async () => {
      if (funder === undefined) throw new Error(`--funder is required to fund the ${name} vault`);
      const token = decodeTokenAccount((await fetchAccount(vault)).data);
      const amount = target - token.amount;
      if (amount <= 0n || amount > MAX_FUNDING_ATOMS) throw new Error(`${name} vault top-up is out of bounds`);
      return {
        instructions: [transferChecked(associatedTokenAddress(funder.publicKey, plan.quote.mint), plan.quote.mint, vault, funder.publicKey, amount, plan.quote.decimals)],
        signers: [funder],
      };
    });
  }

  const output = {
    schemaVersion: 1,
    cluster: "solana-devnet",
    genesisHash,
    mode: send ? "SEND" : "DRY_RUN",
    steps: results,
    accounts: protocolJson({
      config: layout.config, solverRegistry: layout.solverRegistry, testPerpMarket: layout.market,
      collateralVault: layout.collateralVault, feeVault: layout.feeVault, insuranceVault: layout.insuranceVault,
      reservationClass: layout.reservationClass, packageBookClass: layout.packageBookClass, packageBookShard: layout.shard,
      packageBookLevelPage: layout.levelPage, seriesIndex: layout.seriesIndex, seriesRecord: layout.seriesRecord,
      solverBase: layout.solverBase, solverQuote: layout.solverQuote, indexes: layout.indexes, records: layout.records,
    }),
    resourceManifests: protocolJson(layout.documents),
    series: protocolJson({ identityKey: layout.seriesHashes.identityKey, bindingHash: layout.seriesHashes.bindingHash }),
    fragments: serviceFragments(plan, programs, layout, release),
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (flags.out !== undefined) writeFileSync(absolutePath(flags.out, "--out"), text, { mode: 0o644 });
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

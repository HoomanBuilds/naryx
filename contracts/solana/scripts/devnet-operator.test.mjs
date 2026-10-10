import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import anchor from "@anchor-lang/core";
import {
  CONTRACTS_DIRECTORY,
  atomicPostconditionIdentityHash,
  domainRefIdentityHash,
  loadKeypair,
  parseFlags,
  protocolIdIdentityHash,
  requireDevnetCluster,
  seriesBindingHashes,
} from "./devnet-operator.mjs";
import { fixedFirmAccounts, missingAddresses } from "./devnet-lookup-table.mjs";
import { deriveDevnetLayout, parsePlan, serviceFragments } from "./initialize-devnet.mjs";

const { web3 } = anchor;
const fill = (byte) => Buffer.alloc(32, byte);

test("series binding hashes match the naryx_core shared vector", () => {
  const domain = { domainId: "eip155:8453", domainManifestVersion: 7, domainManifestHash: fill(0x11) };
  const binding = {
    schemaVersion: 1,
    bindingVersion: 9,
    domainRefIdentityHash: domainRefIdentityHash(domain),
    seriesManifestHash: fill(0x22),
    executionClassManifestHash: fill(0x33),
    templateIdentityHash: protocolIdIdentityHash("cash-and-carry-v1"),
    templateVersion: 1,
    templateManifestHash: fill(0x44),
    settlementClassIdentityHash: atomicPostconditionIdentityHash(),
    baseAsset: { subjectId: fill(0x55), manifestVersion: 3, manifestHash: fill(0x66) },
    quoteAsset: { subjectId: fill(0x77), manifestVersion: 4, manifestHash: fill(0x88) },
    quoteConventionIdentityHash: protocolIdIdentityHash("annualized-net-yield-v1"),
    entrySide: 1,
    spotBaseAtomsPerPackageUnit: 1_000_000_000n,
    perpQuantityAtomsPerPackageUnit: 1_000_000n,
  };
  assert.equal(binding.domainRefIdentityHash.toString("hex"), "5c3367ef36475ec11ad5b392fc85a349b37d2fdad631c8da833aa0796897c14c");
  assert.equal(binding.templateIdentityHash.toString("hex"), "f124d7a5a2309c590f307ea911f59dc36c0dfc4203d081ac2fc05d0ee0a8206e");
  assert.equal(binding.quoteConventionIdentityHash.toString("hex"), "94f75da5f71975ba08a0bf694c183715be548bdce998210ac5924669c9c701a5");
  assert.equal(binding.settlementClassIdentityHash.toString("hex"), "d859a5e58ad327a34dc770b146a6120cda0a194dd25734f9fec462a18e11e596");
  const hashes = seriesBindingHashes(binding);
  assert.equal(hashes.canonicalLength, 405);
  assert.equal(hashes.identityKey.toString("hex"), "f3d7bc7a8c6cb3ac5a0b3ca45dfdd333143cb8af576749057e34cb6383840a5d");
  assert.equal(hashes.bindingHash.toString("hex"), "e13ea9e6a47163a913f5caacd460b6ab8bc63e9c91ee46610efd30838870711b");
});

test("operator flags require an explicit Devnet cluster and external owner-only keypairs", () => {
  assert.throws(() => requireDevnetCluster(parseFlags([], ["cluster"])), /--cluster devnet/);
  assert.throws(() => requireDevnetCluster(parseFlags(["--cluster", "mainnet-beta"], ["cluster"])), /--cluster devnet/);
  assert.throws(() => parseFlags(["--cluster", "devnet", "--cluster", "devnet"], ["cluster"]), /twice/);
  assert.throws(() => parseFlags(["--broadcast"], ["cluster"], ["send"]), /unknown flag/);
  assert.throws(() => loadKeypair("relative.json", "--payer"), /absolute/);
  assert.throws(() => loadKeypair(join(CONTRACTS_DIRECTORY, "target/deploy/naryx_core-keypair.json"), "--payer"), /outside the repository/);
  const directory = mkdtempSync(join(tmpdir(), "naryx-operator-"));
  try {
    const path = join(directory, "payer.json");
    writeFileSync(path, JSON.stringify(Array.from(web3.Keypair.generate().secretKey)));
    chmodSync(path, 0o644);
    assert.throws(() => loadKeypair(path, "--payer"), /group or others/);
    chmodSync(path, 0o600);
    assert.equal(loadKeypair(path, "--payer").secretKey.length, 64);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    cluster: "solana-devnet",
    domain: { domainId: "svm:devnet", domainManifestVersion: 1, domainManifestHash: "11".repeat(32) },
    configDelaySlots: 150,
    roles: { canceller: web3.Keypair.generate().publicKey.toBase58(), pauser: web3.Keypair.generate().publicKey.toBase58() },
    solverId: web3.Keypair.generate().publicKey.toBase58(),
    assets: {
      base: { mint: web3.Keypair.generate().publicKey.toBase58(), decimals: 9 },
      quote: { mint: web3.Keypair.generate().publicKey.toBase58(), decimals: 6 },
    },
    testPerp: { fundingKeeper: web3.Keypair.generate().publicKey.toBase58() },
    reservationClass: { maxTtlSlots: 600, maxBaseAtoms: "10000000000", maxSolverReservedBaseAtoms: "100000000000" },
    packageBookClass: { maxHeartbeatTtlSlots: 900, maxLevelTtlSlots: 600, maxAbsReferencePrice: "1000000000000", maxAbsReferenceOffset: "1000000000" },
    shard: { referencePackagePrice: "0", referenceStateHash: "22".repeat(32) },
    spotMarketUnits: { baseLotAtoms: "1000000", quoteTickAtomsPerBaseLot: "1", minimumQuoteNotionalAtoms: "1" },
    perpMinimumQuoteNotionalAtoms: "1",
    maximumNotionalAtoms: "100000000000",
    descriptors: {
      templateManifestHash: "33".repeat(32),
      settlementManifestHash: "44".repeat(32),
      spotAdapterClassManifestHash: "55".repeat(32),
      perpAdapterClassManifestHash: "66".repeat(32),
    },
    series: {
      seriesManifestHash: "77".repeat(32),
      executionClassManifestHash: "88".repeat(32),
      spotBaseAtomsPerPackageUnit: "1000000",
      perpQuantityAtomsPerPackageUnit: "1000000",
    },
    riskDomain: {
      riskDomainId: "99".repeat(32),
      policyVersion: 1,
      policyManifestHash: "aa".repeat(32),
      grossCapQuoteAtoms: "100000000000",
      netCapQuoteAtoms: "100000000000",
      minimumMarginFloorQuoteAtoms: "1000000",
      maximumLeverageBps: "10000",
      maximumStalenessMs: "300000",
      maximumTimeToUnwindMs: "3600000",
      requiredRecoveryReserveQuoteAtoms: "1000000",
      aggregateHaircutBps: 100,
      executionObservationAgeMs: "0",
      executionTimeToUnwindMs: "60000",
    },
    insuranceVaultTargetAtoms: "1000000000",
    ...overrides,
  };
}

test("plan, layout, fragments, and lookup table agree and fail closed on drift", () => {
  assert.throws(() => parsePlan(plan({ cluster: "solana-mainnet" })), /solana-devnet/);
  assert.throws(() => parsePlan(plan({ testPerp: { fundingKeeper: web3.Keypair.generate().publicKey.toBase58(), parameters: { baseDecimals: 6 } } })), /base decimals/);
  assert.throws(() => parsePlan(plan({ insuranceVaultTargetAtoms: "1000000000001" })), /insuranceVaultTargetAtoms/);
  const parsed = parsePlan(plan());
  const program = (seed) => ({
    programId: new web3.PublicKey(fill(seed)),
    programDataAddress: new web3.PublicKey(fill(seed + 16)),
    codeIdentity: fill(seed + 32),
  });
  const programs = { core: program(1), reservation: program(2), package_book: program(3), perp_venue: program(4), perp_adapter: program(5) };
  const layout = deriveDevnetLayout(parsed, programs, { marketOwner: web3.Keypair.generate().publicKey });
  const names = ["naryx_core", "naryx_inventory_reservation", "naryx_package_book", "naryx_test_perp", "naryx_test_perp_adapter"];
  const release = {
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    programs: names.map((name, index) => ({
      name,
      programId: Object.values(programs)[index].programId.toBase58(),
      programDataAddress: Object.values(programs)[index].programDataAddress.toBase58(),
      deploymentSlot: "10",
      upgradeAuthority: null,
      programDataHeaderIdentity: Object.values(programs)[index].codeIdentity.toString("hex"),
      programElfSha256: "aa".repeat(32),
    })),
  };
  const fragments = serviceFragments(parsed, programs, layout, release);
  assert.equal(fragments.solverConfig.accounts.reservationClass, layout.reservationClass.toBase58());
  assert.equal(fragments.solverConfig.resources.spotVenue.subjectAddress, layout.reservationClass.toBase58());
  assert.equal(fragments.solverConfig.accounts.riskDomainRecord, layout.riskDomainRecord.toBase58());
  assert.equal(fragments.solverConfig.riskDomain.policyVersion, 1);
  assert.equal(fragments.solverConfig.resources.spotAdapter.adapterClassId, "naryx.solana.spot-firm-reservation");
  assert.equal(fragments.orderContext.spotAdapter.adapterManifestHash.value, layout.identities.spotAdapter.manifestHash.toString("hex"));
  assert.equal(new Set(Object.values(layout.records).map((key) => key.toBase58())).size, 8);

  const record = { cluster: "solana-devnet", accounts: JSON.parse(JSON.stringify({
    ...Object.fromEntries(Object.entries({
      config: layout.config, solverRegistry: layout.solverRegistry, testPerpMarket: layout.market, collateralVault: layout.collateralVault,
      feeVault: layout.feeVault, insuranceVault: layout.insuranceVault, reservationClass: layout.reservationClass,
      packageBookClass: layout.packageBookClass, packageBookShard: layout.shard, packageBookLevelPage: layout.levelPage,
      seriesIndex: layout.seriesIndex, seriesRecord: layout.seriesRecord, solverQuote: layout.solverQuote,
      riskDomainIndex: layout.riskDomainIndex, riskDomainRecord: layout.riskDomainRecord,
    }).map(([name, key]) => [name, key.toBase58()])),
    indexes: Object.fromEntries(Object.entries(layout.indexes).map(([name, key]) => [name, key.toBase58()])),
    records: Object.fromEntries(Object.entries(layout.records).map(([name, key]) => [name, key.toBase58()])),
  })), fragments };
  const fixed = fixedFirmAccounts(record);
  assert.equal(new Set(fixed).size, fixed.length);
  assert.ok(fixed.includes(layout.seriesRecord.toBase58()));
  assert.ok(fixed.includes(layout.riskDomainRecord.toBase58()));
  assert.deepEqual(missingAddresses(fixed.slice(0, 5), fixed), fixed.slice(5));
  assert.throws(() => missingAddresses([web3.Keypair.generate().publicKey.toBase58()], fixed), /unexpected address/);
});

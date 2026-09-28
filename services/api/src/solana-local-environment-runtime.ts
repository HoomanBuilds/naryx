import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import bs58 from 'bs58';
import {
  parseSolanaLocalEnvironmentManifest,
  validateSolanaLocalRpcSnapshot,
  type SolanaLocalEnvironmentManifest,
  type SolanaLocalRpcSnapshot,
} from '@naryx/adapter-core';

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function rpc(url: string, method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
  const envelope = await response.json() as { result?: unknown; error?: unknown };
  if (envelope.error !== undefined || envelope.result === undefined) throw new Error(`Solana RPC ${method} failed`);
  return envelope.result;
}

async function programSnapshot(manifest: SolanaLocalEnvironmentManifest, name: 'core' | 'conformanceVenue') {
  const expected = manifest.programs[name];
  const result = await rpc(manifest.rpc.url, 'getMultipleAccounts', [[expected.id, expected.programDataId], { encoding: 'base64', commitment: 'confirmed' }]) as { value?: readonly unknown[] };
  if (!Array.isArray(result.value) || result.value.length !== 2) throw new Error(`${name} RPC accounts are missing`);
  const program = result.value[0] as { data?: readonly string[]; executable?: boolean; owner?: string } | null;
  const programData = result.value[1] as { data?: readonly string[]; executable?: boolean; owner?: string } | null;
  if (program === null || programData === null || program.owner !== UPGRADEABLE_LOADER || programData.owner !== UPGRADEABLE_LOADER || program.executable !== true || programData.executable !== false || !Array.isArray(program.data) || !Array.isArray(programData.data)) throw new Error(`${name} program accounts are invalid`);
  const programBytes = Buffer.from(program.data[0] ?? '', 'base64');
  const deployedBytes = Buffer.from(programData.data[0] ?? '', 'base64');
  if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2 || bs58.encode(programBytes.subarray(4)) !== expected.programDataId || deployedBytes.length <= 45 || deployedBytes.readUInt32LE(0) !== 3) throw new Error(`${name} upgradeable loader identity is invalid`);
  return { id: expected.id, programDataId: expected.programDataId, sha256: createHash('sha256').update(deployedBytes.subarray(45)).digest('hex') };
}

export interface LoadedSolanaLocalEnvironmentRuntime {
  readonly manifest: SolanaLocalEnvironmentManifest;
  readonly initialSlot: bigint;
  readSlot(): Promise<bigint>;
  validateLive(): Promise<void>;
}

async function validateManifestAccounts(manifest: SolanaLocalEnvironmentManifest): Promise<void> {
  const expected = new Map<string, string>([
    [manifest.accounts.config, manifest.programs.core.id],
    [manifest.accounts.solverRegistry, manifest.programs.core.id],
    [manifest.accounts.market, manifest.programs.conformanceVenue.id],
    [manifest.accounts.position, manifest.programs.conformanceVenue.id],
    [manifest.assets.base.mint, TOKEN_PROGRAM],
    [manifest.assets.quote.mint, TOKEN_PROGRAM],
    [manifest.accounts.spotBaseVault, TOKEN_PROGRAM],
    [manifest.accounts.spotQuoteVault, TOKEN_PROGRAM],
    [manifest.accounts.perpQuoteVault, TOKEN_PROGRAM],
    [manifest.accounts['trader-base'], TOKEN_PROGRAM],
    [manifest.accounts['trader-quote'], TOKEN_PROGRAM],
  ]);
  const result = await rpc(manifest.rpc.url, 'getMultipleAccounts', [
    [...expected.keys()], { encoding: 'base64', commitment: 'confirmed' },
  ]) as { value?: readonly ({ owner?: string } | null)[] };
  if (!Array.isArray(result.value) || result.value.length !== expected.size) {
    throw new Error('manifest-bound Solana accounts are missing');
  }
  [...expected].forEach(([address, owner], index) => {
    if (result.value?.[index]?.owner !== owner) throw new Error(`manifest-bound Solana account ${address} is invalid`);
  });
}

export async function loadSolanaLocalEnvironmentRuntime(path: string, expectedSolverId: string): Promise<LoadedSolanaLocalEnvironmentRuntime> {
  if (!isAbsolute(path)) throw new Error('Solana local environment manifest path must be absolute');
  if (expectedSolverId.length === 0) throw new Error('Solana local expected solver identity is required');
  const manifest = parseSolanaLocalEnvironmentManifest(JSON.parse(readFileSync(resolve(path), 'utf8')));
  const [genesisHash, slotValue, core, conformanceVenue] = await Promise.all([
    rpc(manifest.rpc.url, 'getGenesisHash'), rpc(manifest.rpc.url, 'getSlot', [{ commitment: 'confirmed' }]),
    programSnapshot(manifest, 'core'), programSnapshot(manifest, 'conformanceVenue'),
  ]);
  const snapshot: SolanaLocalRpcSnapshot = { genesisHash: String(genesisHash), slot: Number(slotValue), programs: { core, conformanceVenue } };
  const initialSlot = validateSolanaLocalRpcSnapshot(manifest, snapshot, expectedSolverId);
  await validateManifestAccounts(manifest);
  const validateLive = async () => {
    const [genesis, slotValue, liveCore, liveVenue] = await Promise.all([
      rpc(manifest.rpc.url, 'getGenesisHash'),
      rpc(manifest.rpc.url, 'getSlot', [{ commitment: 'confirmed' }]),
      programSnapshot(manifest, 'core'),
      programSnapshot(manifest, 'conformanceVenue'),
      validateManifestAccounts(manifest),
    ]);
    validateSolanaLocalRpcSnapshot(manifest, {
      genesisHash: String(genesis),
      slot: Number(slotValue),
      programs: { core: liveCore, conformanceVenue: liveVenue },
    }, expectedSolverId);
  };
  return Object.freeze({
    manifest,
    initialSlot,
    readSlot: async () => {
      const liveGenesis = String(await rpc(manifest.rpc.url, 'getGenesisHash'));
      if (liveGenesis !== manifest.rpc.genesisHash) throw new Error('RPC genesis hash changed from the environment manifest');
      const slot = Number(await rpc(manifest.rpc.url, 'getSlot', [{ commitment: 'confirmed' }]));
      if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error('validator returned an invalid slot');
      return BigInt(slot);
    },
    validateLive,
  });
}

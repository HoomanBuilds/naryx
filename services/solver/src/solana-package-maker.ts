import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import type { loadSolanaTreasuryHedgeRuntime } from './solana-treasury-hedge-config.js';
import { requireSolanaDevnet } from './solana-devnet-rpc.js';
import { decodeTokenAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  priceTestPerpShort, priceTestPerpCloseShort } from './solana-devnet-wire.js';
import { PackageMaker, PackageMakerJournal, HttpPackageMakerGateway, PACKAGE_MAKER_LEVELS, makerPriceTicks, type PackageMakerSnapshot } from './package-maker.js';
import type { MakerControlSigner } from './maker-control.js';
import type { SolanaTreasuryHedgePreparationLane } from './solana-treasury-hedge-preparation.js';

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

export function createSolanaPackageMakerReader(input: Readonly<{
  lane: SolanaTreasuryHedgePreparationLane; marketId: string; solverId: string; fundingAccount: string;
  quantities: readonly bigint[]; backingAtomsPerWholeAsset: bigint; maximumCapacityAtoms: bigint;
  clockMs?: () => number;
}>) {
  const { lane } = input;
  const p = lane.pricing;
  const owner = new PublicKey(input.fundingAccount);
  const tokenAccount = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(),
    new PublicKey(p.quoteMint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0].toBase58();
  if (p.domain.domainId !== 'svm:devnet' || input.quantities.length < 1 || input.quantities.length > PACKAGE_MAKER_LEVELS
    || new Set(input.quantities).size !== input.quantities.length || input.quantities.some(q => q <= 0n)
    || input.backingAtomsPerWholeAsset <= 0n || input.maximumCapacityAtoms <= 0n) throw new Error('Solana maker policy is invalid.');
  const sourceId = (i: number, j: number) => `${input.solverId}:${input.marketId}:${i}:${j}`;
  const sourceIds = [sourceId(0, 0), sourceId(0, 1)];
  const total = input.quantities.reduce((sum, q) => sum + q, 0n);
  return { sourceIds, read: async (sourceVersion: bigint): Promise<PackageMakerSnapshot> => {
    await requireSolanaDevnet(lane.rpc);
    const state = await p.readState();
    const now = BigInt((input.clockMs ?? Date.now)());
    const market = state.market;
    if (state.marketAddress !== p.marketAddress || market.oracle !== p.oracleAddress || market.collateralMint !== p.quoteMint
      || market.pauseOpens || market.baseDecimals !== p.inventoryAsset.decimals || market.collateralDecimals !== p.quoteAsset.decimals
      || now / 1000n - state.nowUnixSeconds > 30n || state.nowUnixSeconds > now / 1000n + 5n
      || input.quantities.some(q => q % market.baseLotAtoms !== 0n)) throw new Error('Solana maker market or clock is unavailable.');
    const [funding, insurance] = await lane.rpc.getAccounts([tokenAccount, market.insuranceVault], state.slot);
    if (!funding || !insurance || funding.owner !== TOKEN_PROGRAM_ID.toBase58() || insurance.owner !== funding.owner) {
      throw new Error('Solana maker token accounts are unavailable.');
    }
    const held = decodeTokenAccount(funding.data);
    const reserve = decodeTokenAccount(insurance.data);
    if (held.owner !== owner.toBase58() || held.mint !== p.quoteMint || held.state !== 1 || reserve.mint !== p.quoteMint || reserve.state !== 1) {
      throw new Error('Solana maker collateral identities changed.');
    }
    const scale = 10n ** BigInt(p.inventoryAsset.decimals);
    const quotes: PackageMakerSnapshot['quotes'][number][] = [];
    let exposure = 0n;
    for (const [i, quantity] of input.quantities.entries()) {
      const sized = total * 2n + quantity;
      const sell = priceTestPerpShort(market, state.oraclePricePerLot, sized);
      const buy = priceTestPerpCloseShort(market, state.oraclePricePerLot, sized);
      const backingAtoms = ceil(quantity * input.backingAtomsPerWholeAsset, scale);
      const gross = ceil(quantity * state.oraclePricePerLot * 2n, market.baseLotAtoms);
      if (backingAtoms < gross) throw new Error('Solana maker backing is below gross exposure.');
      exposure += gross;
      for (const side of ['BID', 'ASK'] as const) {
        const reference = state.oraclePricePerLot * scale;
        const hedge = (side === 'ASK' ? sell : buy).fillPricePerLot * scale;
        quotes.push({ key: `${i}:${side}`, backingAtoms, quote: { executionClassId: input.marketId, side,
          legRatios: [{ numerator: 1n, denominator: 1n }, { numerator: -1n, denominator: 1n }],
          legSources: [{ sourceId: sourceId(0, 0), sourceVersion, side, quantity,
            priceTicks: makerPriceTicks(side === 'ASK' ? ceil(reference, market.baseLotAtoms) : reference / market.baseLotAtoms, side, i) },
          { sourceId: sourceId(0, 1), sourceVersion, side: side === 'ASK' ? 'BID' : 'ASK', quantity,
            priceTicks: makerPriceTicks(side === 'ASK' ? hedge / market.baseLotAtoms : ceil(hedge, market.baseLotAtoms), side === 'ASK' ? 'BID' : 'ASK', i) }] } });
      }
    }
    if (reserve.amount < exposure * 2n) throw new Error('Solana maker payout reserve is insufficient.');
    const availableAtoms = held.amount < input.maximumCapacityAtoms ? held.amount : input.maximumCapacityAtoms;
    if (quotes.reduce((sum, q) => sum + q.backingAtoms, 0n) > availableAtoms) throw new Error('Solana maker collateral is insufficient.');
    return { bookNow: state.slot, quotes, capacity: { version: 1, environment: 'testnet', solverId: input.solverId,
      domain: p.domain, asset: p.quoteAsset, availableAtoms, maximumConcurrentRecoveryAtoms: 0n,
      evidenceGrade: 'ONCHAIN_AVAILABLE', observedAtValue: now, expiresAtValue: now + 120_000n,
      evidenceCommitment: createHash('sha256').update(stringifyProtocolJson({ state, tokenAccount, held, reserve })).digest('hex') } };
  } };
}

export function loadSolanaPackageMaker(input: Readonly<{
  path: string | undefined; runtime: Awaited<ReturnType<typeof loadSolanaTreasuryHedgeRuntime>> | undefined;
  origin: string; signer: MakerControlSigner;
}>) {
  if (!input.path) return undefined;
  if (!isAbsolute(input.path) || !input.runtime) throw new Error('Solana package maker runtime is missing.');
  const config = parseProtocolJson(readFileSync(input.path, 'utf8')) as {
    version: number; environment: string; journalPath: string; intervalMs: number; laneId: string; keyId: string;
    fundingAccount: string; quantities: bigint[]; backingAtomsPerWholeAsset: bigint; maximumCapacityAtoms: bigint;
  };
  if (config.version !== 1 || config.environment !== 'testnet' || !isAbsolute(config.journalPath)
    || !Number.isSafeInteger(config.intervalMs) || config.intervalMs < 10000 || config.intervalMs > 30000) throw new Error('Solana maker configuration is invalid.');
  const index = input.runtime.quoteLanes.findIndex(l => l.laneId === config.laneId);
  const lane = input.runtime.preparationLanes[index];
  const quote = input.runtime.quoteLanes[index];
  if (!lane || !quote) throw new Error('Solana maker lane is not registered.');
  const source = createSolanaPackageMakerReader({ ...config, lane, marketId: quote.executionClassId, solverId: quote.solverId });
  const journal = new PackageMakerJournal(config.journalPath);
  const maker = new PackageMaker({ marketId: quote.executionClassId, solverId: quote.solverId, sourceIds: source.sourceIds,
    binding: { config, domain: lane.pricing.domain, executionClassManifestHash: quote.executionClassManifestHash },
    quoteLifetime: 200n, journal, read: source.read,
    gateway: new HttpPackageMakerGateway({ origin: input.origin, solverId: quote.solverId, keyId: config.keyId, signer: input.signer }) });
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    running = maker.tick().then(result => { process.stdout.write(JSON.stringify({ event: 'package-maker', marketId: quote.executionClassId, ...result }) + '\n'); })
      .catch(error => { process.stderr.write(JSON.stringify({ event: 'package-maker-refused', marketId: quote.executionClassId,
        error: error instanceof Error ? error.message : 'unknown error' }) + '\n'); })
      .finally(() => { running = undefined; if (!stopped) timer = setTimeout(tick, config.intervalMs); });
  };
  return { start: () => { if (stopped) { stopped = false; tick(); } },
    close: async () => { stopped = true; if (timer) clearTimeout(timer); await running; journal.close(); } };
}

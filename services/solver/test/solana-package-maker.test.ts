import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef } from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';
import { SOLANA_DEVNET_GENESIS_HASH } from '@naryx/adapter-solana';
import { createSolanaPackageMakerReader } from '../src/solana-package-maker.js';
import { TOKEN_PROGRAM_ID } from '../src/solana-devnet-wire.js';
import type { SolanaTreasuryHedgePreparationLane } from '../src/solana-treasury-hedge-preparation.js';

test('Solana ladder uses slot time and refuses wrong genesis, frozen funding and insufficient insurance', async () => {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
  const mint = key(2);
  const owner = key(3);
  let genesis: string = SOLANA_DEVNET_GENESIS_HASH;
  let frozen = false;
  let insurance = 100_000_000_000n;
  const token = (amount: bigint, wallet: string) => {
    const data = Buffer.alloc(165);
    new PublicKey(mint).toBuffer().copy(data);
    new PublicKey(wallet).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64); data[108] = frozen ? 2 : 1;
    return { owner: TOKEN_PROGRAM_ID.toBase58(), data };
  };
  const lane = { pricing: {
    domain: domainRef('svm:devnet', 5, '11'.repeat(32)), inventoryAsset: assetRef(key(1), '22'.repeat(32), 9),
    quoteAsset: assetRef(mint, '33'.repeat(32), 6), quoteMint: mint, marketAddress: key(4), oracleAddress: key(5),
    readState: async () => ({ slot: 1234n, nowUnixSeconds: 1000n, marketAddress: key(4), oraclePricePerLot: 150_000n,
      market: { oracle: key(5), collateralMint: mint, insuranceVault: key(6), baseDecimals: 9, collateralDecimals: 6,
        pauseOpens: false, baseLotAtoms: 1_000_000n, maxPositionLots: 1000n, impactUnitLots: 10n,
        impactBpsPerUnit: 1, halfSpreadBps: 2, maxSlippageBps: 100, takerFeeBps: 5, initialMarginBps: 1000 } }),
  }, rpc: { getGenesisHash: async () => genesis, getAccounts: async () => [token(100_000_000_000n, owner), token(insurance, key(7))] } } as unknown as SolanaTreasuryHedgePreparationLane;
  const policy = { lane, marketId: 'treasury', solverId: 'solver', fundingAccount: owner,
    quantities: Array.from({ length: 16 }, (_, i) => BigInt(i + 1) * 1_000_000n), backingAtomsPerWholeAsset: 1000_000_000n,
    maximumCapacityAtoms: 100_000_000_000n, clockMs: () => 1_000_000 };
  const reader = createSolanaPackageMakerReader(policy);
  const snapshot = await reader.read(1n);
  assert.equal(snapshot.bookNow, 1234n);
  assert.equal(snapshot.quotes.length, 32);
  for (const side of ['BID', 'ASK']) {
    const prices = snapshot.quotes.filter(q => q.quote.side === side).map(q =>
      q.quote.legSources[0]!.priceTicks - q.quote.legSources[1]!.priceTicks);
    assert.equal(new Set(prices).size, 16);
    for (let i = 1; i < prices.length; i++) assert.ok(side === 'ASK' ? prices[i]! > prices[i - 1]! : prices[i]! < prices[i - 1]!);
  }
  assert.throws(() => createSolanaPackageMakerReader({ ...policy, quantities: [...policy.quantities, 17_000_000n] }), /policy/);
  assert.equal(snapshot.capacity.observedAtValue, 1_000_000n);
  assert.ok(snapshot.quotes[1]!.quote.legSources[0]!.priceTicks > snapshot.quotes[1]!.quote.legSources[1]!.priceTicks);
  frozen = true;
  await assert.rejects(reader.read(2n), /identities/);
  frozen = false; insurance = 1n;
  await assert.rejects(reader.read(3n), /payout reserve/);
  genesis = 'not-devnet';
  await assert.rejects(reader.read(4n), /genesis/);
});

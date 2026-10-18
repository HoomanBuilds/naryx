import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { NATIVE_CASH_RANGE_ABI, NATIVE_CASH_HOUSE_ABI, type EvmNativeCashRangeBinding } from '@naryx/adapter-evm';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, stringToHex, type Chain, type Hex } from 'viem';
import { baseSepolia, arbitrumSepolia } from 'viem/chains';
import { loadEvmStrategySolverKey } from './evm-strategy-execution-authorization.js';
import { NATIVE_CASH_MARK_GAS_CAP_WEI, NativeCashMarkJournal } from './native-cash-mark-journal.js';
import { runNativeCashMarkWorker } from './native-cash-mark-worker.js';

if (process.env.NARYX_NATIVE_CASH_MARK_ENABLED !== 'true') throw new Error('Native cash mark writes are disabled.');
const path = process.env.NARYX_NATIVE_CASH_MARK_CONFIG;
if (!path || !isAbsolute(path)) throw new Error('Native cash mark config path is required.');
const stat = lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error('Native cash mark config is invalid.');
const config = parseProtocolJson(readFileSync(path, 'utf8')) as { version: number; markets: {
  binding: EvmNativeCashRangeBinding; rpcEnvironmentVariable: string; markKeyPath: string; reservedWei: bigint;
}[] };
if (config.version !== 1 || Object.keys(config).sort().join(',') !== 'markets,version'
  || !Array.isArray(config.markets) || config.markets.length < 1 || config.markets.length > 2
  || new Set(config.markets.map(m => m.binding.domain.domainId)).size !== config.markets.length) throw new Error('Native cash mark market set is invalid.');
const markets = [];
for (const entry of config.markets) {
  const { binding } = entry;
  if (Object.keys(entry).sort().join(',') !== 'binding,markKeyPath,reservedWei,rpcEnvironmentVariable'
    || binding.kind !== 'EVM_NATIVE_CASH_RANGE_V1' || binding.policy.environment !== 'testnet'
    || !['eip155:84532', 'eip155:421614'].includes(binding.domain.domainId)
    || !/^NARYX_[A-Z0-9_]+_RPC_URL$/.test(entry.rpcEnvironmentVariable)) throw new Error('Native cash mark binding is invalid.');
  const chain: Chain = binding.domain.domainId === 'eip155:84532' ? baseSepolia : arbitrumSepolia;
  const rpc = process.env[entry.rpcEnvironmentVariable]; if (!rpc) throw new Error('Native cash mark RPC is unavailable.');
  const client = createPublicClient({ chain, transport: http(rpc, { timeout: 10_000, retryCount: 1 }) });
  if (await client.getChainId() !== chain.id) throw new Error('Native cash mark RPC identity differs.');
  if (keccak256(await client.getCode({ address: binding.controller }) ?? '0x') !== binding.controllerCodeHash) throw new Error('Native cash mark controller code differs.');
  const updater = await client.readContract({ address: binding.controller, abi: parseAbi(['function markUpdater() view returns(address)']), functionName: 'markUpdater' });
  const signer = loadEvmStrategySolverKey(entry.markKeyPath, updater);
  const wallet = createWalletClient({ account: signer, chain, transport: http(rpc, { timeout: 10_000, retryCount: 0 }) });
  markets.push({ entry, chain, client, wallet });
}
const journalPath = process.env.NARYX_NATIVE_CASH_MARK_DB;
if (!journalPath) throw new Error('Native cash mark database path is required.');
const journal = new NativeCashMarkJournal(journalPath, markets.map(m => ({ chainId: m.chain.id, reservedWei: m.entry.reservedWei })));
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  const results = await Promise.allSettled(markets.map(market => {
    const { client, wallet, chain, entry } = market;
    const { binding } = entry;
    return runNativeCashMarkWorker({ signal: controller.signal, tick: async () => {
        if (await client.getChainId() !== chain.id) throw new Error('Native cash mark chain changed.');
        if (keccak256(await client.getCode({ address: binding.controller }) ?? '0x') !== binding.controllerCodeHash
          || keccak256(await client.getCode({ address: binding.clearingHouse }) ?? '0x') !== binding.clearingHouseCodeHash) throw new Error('Native cash mark code changed.');
        let pending = journal.pending(chain.id);
        if (!pending) {
          const [price, round, updatedAt, until] = await client.readContract({ address: binding.controller, abi: NATIVE_CASH_RANGE_ABI, functionName: 'previewMark' });
          const mark = await client.readContract({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'currentMark' });
          const now = (await client.getBlock()).timestamp;
          if (mark[1] === price && mark[4] > now + 120n) return;
          if (until <= now + 120n) throw new Error('Native cash oracle has insufficient remaining validity.');
          const sequence = mark[2] + 1n;
          const hash = keccak256(stringToHex(stringifyProtocolJson({ controller: binding.controller,
            sourceRound: round, priceTicks: price, updatedAt, sequence, validUntil: until })));
          const data = encodeFunctionData({ abi: NATIVE_CASH_RANGE_ABI, functionName: 'refreshMark', args: [hash, price, sequence, until] });
          const gas = (await client.estimateGas({ account: wallet.account, to: binding.controller, data })) * 12n / 10n;
          const fees = await client.estimateFeesPerGas();
          if (journal.reserved(chain.id) + gas * fees.maxFeePerGas > NATIVE_CASH_MARK_GAS_CAP_WEI) throw new Error('Approved testnet gas budget is exhausted.');
          const request = await wallet.prepareTransactionRequest({ to: binding.controller, data, gas, ...fees });
          if (await client.getChainId() !== chain.id) throw new Error('Native cash chain changed before signing.');
          const raw = await wallet.signTransaction(request);
          pending = { id: `${binding.marketId}:${sequence}`, chainId: chain.id, hash: keccak256(raw), raw, costWei: gas * fees.maxFeePerGas };
          journal.reserve(pending);
        }
        let receipt;
        try { receipt = await client.getTransactionReceipt({ hash: pending.hash as Hex }); } catch {}
        if (!receipt) {
          if (await client.getChainId() !== chain.id) throw new Error('Native cash chain changed before broadcast.');
          try { await client.sendRawTransaction({ serializedTransaction: pending.raw as Hex }); }
          catch (error) { if (!/already known|nonce too low/i.test((error as { shortMessage?: string }).shortMessage ?? '')) throw error; }
          return;
        }
        const head = await client.getBlockNumber();
        if (head < receipt.blockNumber + 2n || /^0x0{64}$/.test(receipt.blockHash)) return;
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash !== receipt.blockHash) throw new Error('Native cash mark receipt is not canonical.');
        journal.resolve(pending.hash, receipt.status === 'success');
        process.stdout.write(JSON.stringify({ marketId: binding.marketId, transactionHash: pending.hash,
          status: receipt.status, reservedWei: journal.reserved(chain.id).toString() }) + '\n');
      }, failed: error => {
        const reason = error instanceof Error && /insufficient funds|exceeds the balance/i.test(error.message)
          ? 'Mark updater needs testnet gas; existing marks retain their original expiry.'
          : error instanceof Error && /budget.*exhausted|insufficient remaining validity/.test(error.message)
            ? error.message : 'Mark refresh failed closed; existing marks retain their original expiry.';
        process.stderr.write(JSON.stringify({ marketId: binding.marketId, reason }) + '\n');
      } });
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
} finally { journal.close(); }

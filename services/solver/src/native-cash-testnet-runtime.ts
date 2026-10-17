import { lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { EvmNativeCashRangeAdapter, NATIVE_CASH_RANGE_ABI, NATIVE_CASH_HOUSE_ABI, observeNativeCashMatch,
  type EvmNativeCashRangeBinding, type EvmNativeClearingTransitionReadPort } from '@naryx/adapter-evm';
import { createPublicClient, http, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { loadEvmStrategySolverKey } from './evm-strategy-execution-authorization.js';
import { NativeCashService, type NativeCashMarketPort, type NativeCashQuoteRequest } from './native-cash-service.js';
import { NativeCashRegistration, type NativeCashRegistrationBinding } from './native-cash-registration.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export async function loadNativeCashTestnetRuntime(environment: NodeJS.ProcessEnv) {
  if (environment.NARYX_NATIVE_CASH_TESTNET_ENABLED !== 'true') throw new Error('Native cash testnet service is disabled.');
  const configPath = environment.NARYX_NATIVE_CASH_TESTNET_CONFIG;
  if (configPath === undefined || !isAbsolute(configPath)) throw new Error('Native cash configuration path is required.');
  const status = lstatSync(configPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 262_144) throw new Error('Native cash configuration must be a bounded regular file.');
  const config = parseProtocolJson(readFileSync(configPath, 'utf8')) as {
    version: number; markets: readonly { binding: EvmNativeCashRangeBinding; rpcEnvironmentVariable: string; makerKeyPath: string }[];
  };
  if (config.version !== 1 || !Array.isArray(config.markets) || config.markets.length < 1 || config.markets.length > 8
    || Object.keys(config).sort().join(',') !== 'markets,version') throw new Error('Native cash configuration differs.');
  const ports: NativeCashMarketPort[] = [];
  const registrations: NativeCashRegistrationBinding[] = [];
  let registration: NativeCashRegistration;
  const markets: { marketId: string; binding: EvmNativeCashRangeBinding; inspect: () => Promise<unknown> }[] = [];
  for (const entry of config.markets) {
    if (Object.keys(entry).sort().join(',') !== 'binding,makerKeyPath,rpcEnvironmentVariable'
      || !/^NARYX_[A-Z0-9_]+_RPC_URL$/.test(entry.rpcEnvironmentVariable)) throw new Error('Native cash market configuration differs.');
    const rpc = environment[entry.rpcEnvironmentVariable];
    if (!rpc) throw new Error('Native cash RPC is unavailable.');
    const binding = entry.binding;
    if (binding.kind !== 'EVM_NATIVE_CASH_RANGE_V1' || !['eip155:84532', 'eip155:421614'].includes(binding.domain.domainId)) {
      throw new Error('Native cash runtime is testnet only.');
    }
    const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 1 }) });
    if (await client.getChainId() !== Number(binding.domain.domainId.slice(7))) throw new Error('Native cash RPC is on the wrong network.');
    const reads: EvmNativeClearingTransitionReadPort = {
      chainId: async () => BigInt(await client.getChainId()),
      code: async (address, blockNumber) => await client.getCode({ address, blockNumber }) ?? '0x',
      read: (read, blockNumber) => client.readContract({ ...read, blockNumber }),
      finalizedBlock: async () => {
        const block = await client.getBlock({ blockTag: 'finalized' });
        if (block.number === null || block.hash === null) throw new Error('Native cash finalized block is unavailable.');
        return { number: block.number, hash: block.hash };
      },
      blockHash: async number => {
        const block = await client.getBlock({ blockNumber: number });
        if (block.hash === null) throw new Error('Native cash block hash is unavailable.');
        return block.hash;
      },
      receipt: hash => client.getTransactionReceipt({ hash }), transaction: hash => client.getTransaction({ hash }),
      timestamp: async blockNumber => (await client.getBlock({ blockNumber })).timestamp,
      clearingLogs: blockNumber => client.getLogs({ address: binding.clearingHouse, fromBlock: blockNumber, toBlock: blockNumber }),
    };
    const head = async () => {
      const block = await client.getBlock();
      if (block.hash === null || block.number === null) throw new Error('Native cash head is unavailable.');
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    };
    const adapter = new EvmNativeCashRangeAdapter(binding, { ...reads, head });
    for (const [address, codeHash] of [[binding.controller, binding.controllerCodeHash],
      [binding.clearingHouse, binding.clearingHouseCodeHash], [binding.collateralToken, binding.collateralTokenCodeHash]] as const) {
      if (keccak256(await client.getCode({ address }) ?? '0x') !== codeHash) throw new Error('Native cash runtime deployment code differs.');
    }
    const governor = await client.readContract({ address: binding.clearingHouse,
      abi: parseAbi(['function governor() view returns(address)']), functionName: 'governor' });
    registrations.push({ marketId: binding.marketId, manifestHash: keccak256(stringToHex(stringifyProtocolJson(binding))),
      chainId: Number(binding.domain.domainId.slice(7)), clearingHouse: binding.clearingHouse, governor });
    const signer = loadEvmStrategySolverKey(entry.makerKeyPath, binding.makerOwner);
    ports.push({ marketId: binding.marketId, makerOwner: binding.makerOwner, quote: async input => {
      const quote = await adapter.quote(input);
      const state = registration.status(binding.marketId).state;
      if (state === 'ALL_PAUSED' || state === 'INACTIVE' || state !== 'ACTIVE' && !quote.reducingOnly) throw new Error('Native cash market is not registered for this operation.');
      return quote;
    },
      sign: async quote => {
        if (await reads.chainId() !== BigInt(quote.chainId)) throw new Error('Native cash chain changed before signing.');
        return signer.signTypedData(quote.typedData);
      }, observe: (quote, hash) => observeNativeCashMatch(binding, reads, quote, hash) });
    markets.push({ marketId: binding.marketId, binding, inspect: async () => {
      if (await reads.chainId() !== BigInt(binding.domain.domainId.slice(7))) throw new Error('Native cash chain changed.');
      const block = await head();
      const [reference, paused] = await Promise.all([
        reads.read({ address: binding.controller, abi: NATIVE_CASH_RANGE_ABI, functionName: 'previewMark' }, block.number),
        reads.read({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'entryPaused' }, block.number),
      ]);
      return { reference, entryPaused: paused, block, registration: registration.status(binding.marketId) };
    } });
  }
  const dbPath = environment.NARYX_NATIVE_CASH_TESTNET_DB;
  if (dbPath === undefined) throw new Error('Native cash database path is required.');
  registration = new NativeCashRegistration(`${dbPath}.registrations`, registrations);
  const service = new NativeCashService(dbPath, ports);
  return { service, markets, registration };
}

export function createNativeCashTestnetHandler(runtime: Pick<Awaited<ReturnType<typeof loadNativeCashTestnetRuntime>>, 'service' | 'markets'>
  & Partial<Pick<Awaited<ReturnType<typeof loadNativeCashTestnetRuntime>>, 'registration'>>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(stringifyProtocolJson(body));
    };
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '') || request.headers.origin !== undefined
      || request.headers.forwarded !== undefined || request.headers['x-forwarded-for'] !== undefined || request.headers['x-real-ip'] !== undefined) {
      send(403, { error: 'Direct loopback access is required.' }); return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.search !== '') throw new Error('Unexpected query.');
      if (request.method === 'GET' && url.pathname === '/v1/native-cash/markets') {
        const markets = await Promise.all(runtime.markets.map(async market => {
          let reference: unknown;
          try { reference = await market.inspect(); } catch { reference = { status: 'UNAVAILABLE' }; }
          return { marketId: market.marketId, kind: 'EVM_NATIVE_CASH_RANGE_V1', environment: 'testnet',
            settlement: 'NATIVE_CASH_ONLY', createsExternalPositions: false, binding: market.binding, reference };
        }));
        send(200, { version: 1, markets }); return;
      }
      const quotePath = /^\/v1\/native-cash\/quotes\/([A-Za-z0-9._:-]+)(\/settlement)?$/.exec(url.pathname);
      const activation = /^\/internal\/native-cash\/registrations\/([A-Za-z0-9._:-]+)\/(challenge|authorize)$/.exec(url.pathname);
      if (request.method === 'GET' && quotePath !== null) {
        const result = quotePath[2] ? runtime.service.settlement(quotePath[1]!) : runtime.service.quote(quotePath[1]!);
        send(result === undefined ? 404 : 200, { version: 1, result: result ?? null }); return;
      }
      if (request.method !== 'POST' || (url.pathname !== '/v1/native-cash/quotes' && !quotePath?.[2] && activation === null)) {
        send(404, { error: 'Native cash route not found.' }); return;
      }
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('JSON is required.');
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) throw new Error('Request exceeds 4096 bytes.');
        chunks.push(Buffer.from(chunk));
      }
      const body = parseProtocolJson(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request must be an object.');
      if (activation !== null) {
        if (runtime.registration === undefined) throw new Error('Registration controls are unavailable.');
        if (activation[2] === 'challenge') {
          if (Object.keys(body).join(',') !== 'state' || !['ACTIVE', 'ENTRY_PAUSED', 'EXIT_ONLY', 'ALL_PAUSED', 'DEPRECATED'].includes(String(body.state))) throw new Error('Registration state differs.');
          send(200, runtime.registration.challenge(activation[1]!, body.state as Parameters<NativeCashRegistration['challenge']>[1]));
        } else {
          if (Object.keys(body).sort().join(',') !== 'challengeId,signature' || typeof body.challengeId !== 'string' || typeof body.signature !== 'string') throw new Error('Registration signature differs.');
          const result = await runtime.registration.authorize(activation[1]!, body.challengeId, body.signature as Hex);
          send(200, result);
        }
        return;
      }
      if (quotePath?.[2]) {
        if (Object.keys(body).join(',') !== 'transactionHash' || typeof body.transactionHash !== 'string') throw new Error('Transaction hash is required.');
        send(200, { version: 1, result: await runtime.service.observe(quotePath[1]!, body.transactionHash as Hex) }); return;
      }
      if (Object.keys(body).sort().join(',') !== 'accountId,marketId,owner,quantityAtoms,requestId,side') throw new Error('Quote fields differ.');
      const signed = await runtime.service.requestQuote(body as unknown as NativeCashQuoteRequest);
      send(200, { version: 1, result: signed, execution: { to: signed.quote.clearingHouse, chainId: signed.quote.chainId,
        value: 0n, functionName: 'executeMatch', ownerSignatureRequired: true,
        prepareCalldata: 'Sign the returned typedData, then pass the match and both owner signatures to executeMatch.' } });
    } catch {
      send(409, { error: 'Native cash request could not be qualified. Check funding, market state, expiry and finality.' });
    }
  };
}

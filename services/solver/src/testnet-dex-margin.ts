import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { getAddress, parseUnits, type PrivateKeyAccount } from 'viem';
import { loadHyperliquidTestnetAgentSigner } from './hyperliquid-testnet-agent-key.js';

const endpoint = 'https://api.hyperliquid-testnet.xyz';
const token = 'USDC:0xeb62eee3685fc4c43992febcd9e75443';
const amount = '20';
const amountAtoms = 20_000_000n;

export function validateTestnetMarginAction(payload: unknown, account: string): void {
  const request = payload as { action?: Record<string, unknown>; nonce?: unknown };
  const action = request.action;
  assert.ok(action && action.type === 'agentSendAsset' && action.sourceDex === '' && action.destinationDex === 'sekaw'
    && action.token === token && action.amount === amount && action.fromSubAccount === ''
    && typeof action.destination === 'string' && getAddress(action.destination) === getAddress(account)
    && typeof request.nonce === 'number' && Number.isSafeInteger(request.nonce) && request.nonce > 0
    && action.nonce === request.nonce, 'Only the bounded same-owner testnet margin transfer is permitted');
}

async function main() {
  const { values } = parseArgs({ options: { journal: { type: 'string' }, broadcast: { type: 'boolean', default: false } } });
  const root = resolve(import.meta.dirname, '../../..');
  assert.ok(values.journal && isAbsolute(values.journal) && !resolve(values.journal).startsWith(`${root}/`), 'Use an external journal path');
  const account = getAddress(process.env.NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT ?? '');
  assert.equal(account.toLowerCase(), (process.env.NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT ?? '').toLowerCase(), 'Only the configured main testnet account is supported');
  const transport = new HttpTransport({ isTestnet: true, timeout: 15_000 });
  assert.equal(String(transport.apiUrl).replace(/\/$/, ''), endpoint);
  assert.equal(transport.isTestnet, true);
  const info = new InfoClient({ transport });
  const metadata = await info.meta();
  assert.equal(metadata.universe[3]?.name, 'BTC', 'The expected testnet catalog differs');
  const spot = await info.spotMeta();
  assert.equal(spot.tokens.find((item) => item.name === 'USDC')?.tokenId, token.slice(5), 'Testnet collateral identity differs');
  const state = async (dex: string) => info.clearinghouseState({ user: account, dex });
  const before = { source: await state(''), destination: await state('sekaw') };
  const balance = (value: typeof before.source) => parseUnits(value.marginSummary.totalRawUsd, 6);
  if (existsSync(values.journal)) {
    const previous = JSON.parse(readFileSync(values.journal, 'utf8'));
    assert.equal(previous.account, account);
    assert.equal(previous.amount, amount);
    const verified = balance(before.destination) >= BigInt(previous.destinationBeforeAtoms) + amountAtoms;
    console.log(JSON.stringify({ account, status: previous.status, balanceObserved: verified, resubmission: false }));
    return;
  }
  assert.equal(before.source.assetPositions.length, 0, 'Source has active positions; do not change its collateral');
  assert.equal(before.destination.assetPositions.length, 0, 'Destination has active positions; inspect them first');
  assert.ok(parseUnits(before.source.withdrawable, 6) >= amountAtoms, 'Insufficient free testnet margin');
  const record: Record<string, unknown> = { version: 1, environment: 'TESTNET', account, amount,
    sourceDex: '', destinationDex: 'sekaw', sourceBeforeAtoms: balance(before.source).toString(),
    destinationBeforeAtoms: balance(before.destination).toString(), createdAtMs: Date.now(), status: 'PLANNED' };
  if (!values.broadcast) {
    console.log(JSON.stringify({ account, amountTestUSDC: amount, sourceDex: '', destinationDex: 'sekaw', broadcast: false }));
    return;
  }
  const expectedAgent = process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS ?? '';
  const role = await info.userRole({ user: getAddress(expectedAgent) });
  assert.ok(role.role === 'agent' && getAddress(role.data.user) === account, 'The agent does not control this testnet account');
  const signer = loadHyperliquidTestnetAgentSigner(process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH ?? '', expectedAgent);
  const guardedSigner: PrivateKeyAccount = { ...signer, signTypedData: async (input) => {
    assert.equal(input.primaryType, 'Agent');
    assert.equal((input.message as Record<string, unknown>).source, 'b', 'Mainnet signatures are forbidden');
    return signer.signTypedData(input);
  } };
  const save = () => writeFileSync(values.journal!, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const guardedTransport = { isTestnet: true, request: async <T>(route: 'info' | 'exchange' | 'explorer', payload: unknown, signal?: AbortSignal): Promise<T> => {
    assert.equal(route, 'exchange');
    assert.equal(String(transport.apiUrl).replace(/\/$/, ''), endpoint);
    validateTestnetMarginAction(payload, account);
    record.signedRequest = payload;
    record.status = 'SUBMISSION_PENDING';
    save();
    return transport.request<T>(route, payload, signal);
  } };
  try {
    const exchange = new ExchangeClient({ transport: guardedTransport, wallet: guardedSigner });
    await exchange.agentSendAsset({ destination: account, sourceDex: '', destinationDex: 'sekaw', token, amount, fromSubAccount: '' });
    record.status = 'ACKNOWLEDGED';
    save();
    const after = { source: await state(''), destination: await state('sekaw') };
    assert.equal(balance(after.source), balance(before.source) - amountAtoms);
    assert.equal(balance(after.destination), balance(before.destination) + amountAtoms);
    record.status = 'VERIFIED';
    record.sourceAfterAtoms = balance(after.source).toString();
    record.destinationAfterAtoms = balance(after.destination).toString();
    save();
    console.log(JSON.stringify({ account, amountTestUSDC: amount, destinationDex: 'sekaw', status: record.status }));
  } catch {
    if (record.signedRequest !== undefined) {
      record.status = record.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED_BALANCE_PENDING' : 'SUBMISSION_UNCERTAIN';
      save();
    }
    throw new Error('Testnet margin setup did not verify; inspect the journal and do not submit a replacement transfer');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Testnet margin setup refused'); process.exitCode = 1; });
}

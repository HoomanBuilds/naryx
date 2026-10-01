import type { Server } from 'node:http';
import {
  ConnectionSolanaDeploymentIdentityReadPort,
  verifySolanaDevnetDeploymentIdentity,
} from '@naryx/adapter-solana';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import { HttpInternalOrderProvider } from './http-internal-order-provider.js';
import type { InternalAtomicQuotePort } from './internal-atomic-quote-server.js';
import { createSolanaDevnetBindingServer, createSolanaDevnetBindingService } from './solana-devnet-binding.js';
import { SqliteSolanaDevnetFirmQuoteJournal, createSolanaDevnetFirmQuotePort } from './solana-devnet-firm-quote.js';
import { createSolanaDevnetReservationReleaser } from './solana-devnet-reservation-release.js';
import { HttpSolanaDevnetSolverRpc, requireSolanaDevnet, type SolanaDevnetSolverWritePort } from './solana-devnet-rpc.js';
import {
  loadSolanaDevnetSharedManifest,
  loadSolanaDevnetSolverConfig,
  loadSolanaDevnetSolverKey,
} from './solana-devnet-solver-config.js';
import { HttpSelectedSolanaAdmissionProvider } from './solana-execution-authorization.js';
import { explicitBoolean, tcpPort } from './solver-process-config.js';

export const SOLANA_DEVNET_SOLVER_ENABLED_ENV = 'NARYX_SOLANA_DEVNET_SOLVER_ENABLED';
export const SOLANA_DEVNET_SOLVER_WRITES_ENV = 'NARYX_SOLANA_DEVNET_SOLVER_WRITES_ENABLED';

export type LoadedSolanaDevnetSolverRuntime = Readonly<{
  /** Devnet orders get a FIRM_ONCHAIN quote; every other order goes to the existing coordinator. */
  wrap(port: InternalAtomicQuotePort): InternalAtomicQuotePort;
  listen(host: string): Promise<void>;
  close(): Promise<void>;
  port: number;
  writesEnabled: boolean;
}>;

/** Serializes the solver's own shard and reservation writes so read sequences stay current. */
function exclusiveWriter(writer: SolanaDevnetSolverWritePort): SolanaDevnetSolverWritePort {
  let tail: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    sendAndFinalize(...args: Parameters<SolanaDevnetSolverWritePort['sendAndFinalize']>) {
      const run = tail.then(() => writer.sendAndFinalize(...args));
      tail = run.catch(() => undefined);
      return run;
    },
  });
}

/**
 * Solana Devnet solver: disabled unless NARYX_SOLANA_DEVNET_SOLVER_ENABLED=true. Reads are
 * signerless; Devnet writes (package book level, reservation funding, quote lock) additionally need
 * NARYX_SOLANA_DEVNET_SOLVER_WRITES_ENABLED=true, a keypair file outside the repository, and a
 * Devnet genesis hash read from chain before every write.
 */
export async function loadSolanaDevnetSolverRuntime(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ nonceSource: AtomicQuoteNonceSource; apiOrigin: string; reservedPorts: readonly number[] }>,
): Promise<LoadedSolanaDevnetSolverRuntime | undefined> {
  if (!explicitBoolean(env[SOLANA_DEVNET_SOLVER_ENABLED_ENV], SOLANA_DEVNET_SOLVER_ENABLED_ENV)) return undefined;
  const writesEnabled = explicitBoolean(env[SOLANA_DEVNET_SOLVER_WRITES_ENV], SOLANA_DEVNET_SOLVER_WRITES_ENV);
  const config = loadSolanaDevnetSolverConfig(env.NARYX_SOLANA_DEVNET_SOLVER_CONFIG ?? '');
  const manifest = loadSolanaDevnetSharedManifest(config.runtimeManifestPath);
  const key = loadSolanaDevnetSolverKey(env.NARYX_SOLANA_DEVNET_SOLVER_KEYPAIR_PATH ?? '', config.solverId);
  const rpcUrl = env.NARYX_SOLANA_DEVNET_RPC_URL ?? '';
  const rpc = new HttpSolanaDevnetSolverRpc(rpcUrl, { writesEnabled });
  await requireSolanaDevnet(rpc);
  await verifySolanaDevnetDeploymentIdentity(manifest.programs, new ConnectionSolanaDeploymentIdentityReadPort(rpcUrl));
  const port = tcpPort(env.NARYX_SOLANA_DEVNET_BINDING_PORT, 'NARYX_SOLANA_DEVNET_BINDING_PORT', 8_795);
  if (options.reservedPorts.includes(port)) throw new Error('Solana Devnet binding port must differ from the other solver ports');
  const journal = new SqliteSolanaDevnetFirmQuoteJournal(env.NARYX_SOLANA_DEVNET_SOLVER_JOURNAL_DB ?? '');
  const writer = writesEnabled ? exclusiveWriter(rpc) : undefined;
  const shared = { manifest, config, rpc, key, journal, ...(writer === undefined ? {} : { writer }) };
  const releaser = createSolanaDevnetReservationReleaser(shared);
  const service = createSolanaDevnetBindingService({
    ...shared,
    releaser,
    admissions: new HttpSelectedSolanaAdmissionProvider(options.apiOrigin).get,
  });
  const server: Server = createSolanaDevnetBindingServer(service, releaser);
  const orders = new HttpInternalOrderProvider(options.apiOrigin).get;
  return Object.freeze({
    wrap: (fallback: InternalAtomicQuotePort) => createSolanaDevnetFirmQuotePort({ ...shared, orders, nonceSource: options.nonceSource }, fallback),
    listen: (host: string) => new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolveListen();
      });
    }),
    close: () => new Promise<void>((resolveClose) => {
      journal.close();
      if (!server.listening) { resolveClose(); return; }
      server.close(() => resolveClose());
    }),
    port,
    writesEnabled,
  });
}

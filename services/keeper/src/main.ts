import { createHyperliquidTestnetEvidenceServer, loadKeeperServerConfig } from './hyperliquid-testnet-evidence-http.js';
import { HyperliquidAuthoritativeEvidenceCollector, HyperliquidSdkTestnetReadClient } from './hyperliquid-evidence-collector.js';
import { HyperliquidTestnetEvidenceRuntime } from './hyperliquid-testnet-evidence-runtime.js';

const config = loadKeeperServerConfig();
const client = new HyperliquidSdkTestnetReadClient();
const collector = new HyperliquidAuthoritativeEvidenceCollector(client);
const runtime = new HyperliquidTestnetEvidenceRuntime(collector);
const server = createHyperliquidTestnetEvidenceServer({ runtime });

function shutdown(): void {
  server.close(() => {
    process.exitCode = 0;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(config.port, config.host, () => {
  process.stdout.write(`Keeper evidence service listening on http://${config.host}:${config.port}\n`);
});

import type { Metadata } from "next";
import { TradingTerminal } from "@/features/terminal/trading-terminal";
import { localConformanceTerminalProvider } from "@/features/terminal/local-conformance-provider";

export const metadata: Metadata = { title: "Trade" };

export default async function TradePage() {
  const [snapshot, preview] = await Promise.all([
    localConformanceTerminalProvider.getSnapshot("solana"),
    localConformanceTerminalProvider.getPreview({
      domain: "solana",
      mode: "entry",
      size: "100",
      slippageBps: 10,
      quoteMode: "coordinated_limits",
    }),
  ]);

  return <TradingTerminal initialSnapshot={snapshot} initialPreview={preview} />;
}

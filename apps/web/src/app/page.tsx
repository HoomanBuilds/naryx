import { TradingTerminal } from "@/features/terminal/trading-terminal";
import { localConformanceTerminalProvider } from "@/features/terminal/local-conformance-provider";

export default async function Home() {
  const snapshot = await localConformanceTerminalProvider.getSnapshot();

  return <TradingTerminal snapshot={snapshot} />;
}

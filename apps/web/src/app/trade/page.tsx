import { TradingTerminal } from "@/features/terminal/trading-terminal";
import { localConformanceTerminalProvider } from "@/features/terminal/local-conformance-provider";

export default async function Home() {
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
  const privateApiBaseUrl =
    process.env.NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL ?? null;
  // The public v1 market API and the package market it shows. Without both, market data stays
  // on the labeled fixture.
  const publicApiBaseUrl = process.env.NEXT_PUBLIC_NARYX_PUBLIC_API_BASE_URL ?? null;
  const packageMarketId = process.env.NEXT_PUBLIC_NARYX_PACKAGE_MARKET_ID ?? null;

  return (
    <TradingTerminal
      initialSnapshot={snapshot}
      initialPreview={preview}
      privateApiBaseUrl={privateApiBaseUrl}
      publicApiBaseUrl={publicApiBaseUrl}
      packageMarketId={packageMarketId}
    />
  );
}

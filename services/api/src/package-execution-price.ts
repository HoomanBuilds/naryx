import { bytesEqual, type PackageGraph, type StrategyPackageQuote } from "@naryx/protocol-types";

type Fill = Readonly<{ priceTicks: bigint; quantity: bigint }>;

export function requireMatchedExecutionPrice(input: Readonly<{
  side: "BID" | "ASK";
  quantity: bigint;
  graph: PackageGraph;
  quote: StrategyPackageQuote;
  fills: readonly Fill[];
}>): void {
  const { graph, quote, side, quantity, fills } = input;
  const roles = graph.templateId === "calendar-spread-v1" ? ["near-future", "far-future"]
    : graph.templateId === "option-spread-v1" ? ["option-long", "option-short"] : undefined;
  if (roles === undefined) throw new Error("This template has no executable package-price convention.");
  if (quantity <= 0n || fills.length === 0 || fills.some(fill => fill.quantity <= 0n)
    || fills.reduce((sum, fill) => sum + fill.quantity, 0n) !== quantity
    || graph.legs.length !== 2 || quote.legEconomics.length !== 2) {
    throw new Error("Package price quantities do not match the allocation.");
  }
  let numerator = 0n;
  let denominator = 1n;
  for (const [index, role] of roles.entries()) {
    const leg = graph.legs.find(item => item.legId === role);
    const economics = quote.legEconomics.find(item => item.legId === role);
    const price = economics?.executionPrice;
    const expectedSide = (index === 0) === (side === "BID") ? "BUY" : "SELL";
    if (leg === undefined || economics === undefined || price === undefined || price.baseAtoms <= 0n
      || price.quoteAtoms < 0n || leg.side !== expectedSide
      || leg.quantityAtoms !== quantity || economics.quantity.atoms !== quantity
      || price.baseAsset.assetId !== leg.quantityAsset.assetId
      || price.baseAsset.decimals !== leg.quantityAsset.decimals
      || !bytesEqual(price.baseAsset.assetManifestHash, leg.quantityAsset.assetManifestHash)
      || price.quoteAsset.assetId !== quote.quoteAsset.assetId
      || price.quoteAsset.decimals !== quote.quoteAsset.decimals
      || !bytesEqual(price.quoteAsset.assetManifestHash, quote.quoteAsset.assetManifestHash)) {
      throw new Error("Package execution legs differ from the matched economic direction or assets.");
    }
    const signedPrice = price.quoteAtoms * 10n ** BigInt(price.baseAsset.decimals) * (index === 0 ? 1n : -1n);
    numerator = numerator * price.baseAtoms + signedPrice * denominator;
    denominator *= price.baseAtoms;
  }
  const matched = fills.reduce((sum, fill) => sum + fill.priceTicks * fill.quantity, 0n);
  const actual = numerator * quantity;
  if (side === "BID" ? actual > matched * denominator : actual < matched * denominator) {
    throw new Error("Executable package price is worse than the matched book price.");
  }
}

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
  const roles: readonly (readonly [string, bigint, 'TRADE' | 'REFERENCE' | 'TRANSFER'])[] | undefined =
    graph.templateId === "calendar-spread-v1" ? [["near-future", 1n, 'TRADE'], ["far-future", -1n, 'TRADE']]
    : graph.templateId === "option-spread-v1" ? [["option-long", 1n, 'TRADE'], ["option-short", -1n, 'TRADE']]
    : graph.templateId === "treasury-inventory-hedge-v1" ? [["inventory-position", 1n, 'REFERENCE'], ["treasury-hedge", -1n, 'TRADE']]
    : graph.templateId === "collateral-conversion-hedge-v1" ? [["collateral-swap", 1n, 'TRADE'], ["collateral-transfer", 1n, 'TRANSFER'], ["conversion-hedge", -1n, 'TRADE']]
    : graph.templateId === "reverse-cash-and-carry-v1" ? [["base-borrow", -1n, 'TRANSFER'], ["spot-sale", -1n, 'TRADE'], ["perp-purchase", 1n, 'TRADE']]
    : undefined;
  if (roles === undefined) throw new Error("This template has no executable package-price convention.");
  if (quantity <= 0n || fills.length === 0 || fills.some(fill => fill.quantity <= 0n)
    || fills.reduce((sum, fill) => sum + fill.quantity, 0n) !== quantity
    || graph.legs.length !== roles.length || quote.legEconomics.length !== roles.length) {
    throw new Error("Package price quantities do not match the allocation.");
  }
  let numerator = 0n;
  let denominator = 1n;
  for (const [role, sign, kind] of roles) {
    const leg = graph.legs.find(item => item.legId === role);
    const economics = quote.legEconomics.find(item => item.legId === role);
    const price = kind === 'REFERENCE' && economics !== undefined && leg !== undefined
      ? { baseAsset: leg.quantityAsset, quoteAsset: economics.grossNotional.asset,
        quoteAtoms: economics.grossNotional.atoms, baseAtoms: quantity }
      : economics?.executionPrice;
    const expectedSide = kind === 'TRADE' ? (sign > 0n) === (side === "BID") ? "BUY" : "SELL" : 'NONE';
    if (kind === 'TRANSFER') {
      if (leg === undefined || economics === undefined || leg.side !== 'NONE' || price !== undefined
        || leg.quantityAtoms !== quantity || economics.quantity.atoms !== quantity
        || economics.quantity.asset.assetId !== leg.quantityAsset.assetId
        || economics.quantity.asset.decimals !== leg.quantityAsset.decimals
        || !bytesEqual(economics.quantity.asset.assetManifestHash, leg.quantityAsset.assetManifestHash)) {
        throw new Error('Package transfer differs from the matched economic direction or assets.');
      }
      continue;
    }
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
    const signedPrice = price.quoteAtoms * 10n ** BigInt(price.baseAsset.decimals) * sign;
    numerator = numerator * price.baseAtoms + signedPrice * denominator;
    denominator *= price.baseAtoms;
  }
  const matched = fills.reduce((sum, fill) => sum + fill.priceTicks * fill.quantity, 0n);
  const actual = numerator * quantity;
  if (side === "BID" ? actual > matched * denominator : actual < matched * denominator) {
    throw new Error("Executable package price is worse than the matched book price.");
  }
}

/**
 * The fees charged in a package's base asset (HyperCore takes a spot buy's taker fee in the received
 * base token). The trading account's spot balance moves by the spot fill less exactly this amount.
 */
export function hyperliquidBaseFeeAtoms(
  fees: readonly Readonly<{ assetId: string; assetDecimals: number; amountAtoms: bigint }>[],
  baseAsset: Readonly<{ assetId: string; decimals: number }>,
): bigint {
  return fees
    .filter((fee) => fee.assetId === baseAsset.assetId && fee.assetDecimals === baseAsset.decimals)
    .reduce((total, fee) => total + fee.amountAtoms, 0n);
}

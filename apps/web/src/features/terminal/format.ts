function integerText(value: bigint): string {
  return value.toLocaleString("en-US");
}

function roundedDecimal(atoms: bigint, decimals: number, displayedDecimals: number): string {
  const negative = atoms < BigInt(0);
  const absolute = negative ? -atoms : atoms;
  const hiddenDecimals = decimals - displayedDecimals;
  const divisor = BigInt(10) ** BigInt(hiddenDecimals);
  const rounded = hiddenDecimals === 0 ? absolute : (absolute + divisor / BigInt(2)) / divisor;
  const scale = BigInt(10) ** BigInt(displayedDecimals);
  const whole = rounded / scale;
  const fraction = displayedDecimals === 0
    ? ""
    : (rounded % scale).toString().padStart(displayedDecimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${integerText(whole)}${fraction ? `.${fraction}` : ""}`;
}

export function formatAtomicAmount(atoms: string | bigint, decimals: number, symbol: string): string {
  const value = typeof atoms === "bigint" ? atoms : BigInt(atoms);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Asset decimals are invalid.");
  if (value === BigInt(0)) return `0 ${symbol}`;
  const absolute = value < BigInt(0) ? -value : value;
  const unit = BigInt(10) ** BigInt(decimals);
  if (decimals >= 4 && absolute * BigInt(10_000) < unit) return `${value < BigInt(0) ? ">-" : "<"}0.0001 ${symbol}`;
  const displayedDecimals = absolute < unit ? Math.min(decimals, 6)
    : absolute < BigInt(1_000) * unit ? Math.min(decimals, 4)
      : Math.min(decimals, 2);
  return `${roundedDecimal(value, decimals, displayedDecimals)} ${symbol}`;
}

export function formatScaledInteger(value: string | bigint, scale: number, suffix: string): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) throw new Error("Metric scale is invalid.");
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  return `${roundedDecimal(parsed, scale, scale)}${suffix}`;
}

export function formatMetricValue(value: string, scale: number, unitId: string, quoteSymbol: string, quoteDecimals: number): string {
  if (unitId === "quote-atoms") return formatAtomicAmount(value, quoteDecimals, quoteSymbol);
  if (unitId === "basis-points") return formatScaledInteger(value, scale + 2, "%");
  if (unitId === "parts-per-million") return formatScaledInteger(value, scale + 4, "%");
  if (unitId === "milliseconds") {
    const milliseconds = BigInt(value);
    if (milliseconds % BigInt(86_400_000) === BigInt(0)) return `${integerText(milliseconds / BigInt(86_400_000))} d`;
    if (milliseconds % BigInt(3_600_000) === BigInt(0)) return `${integerText(milliseconds / BigInt(3_600_000))} h`;
    if (milliseconds % BigInt(60_000) === BigInt(0)) return `${integerText(milliseconds / BigInt(60_000))} min`;
    return `${integerText(milliseconds)} ms`;
  }
  const unit = unitId === "base-atoms" ? "base atoms"
    : unitId === "price-ticks" ? "ticks"
      : unitId === "enumeration-code" ? "code" : unitId;
  return formatScaledInteger(value, scale, ` ${unit}`);
}

const PPM = 1_000_000;
const DAYS_PER_YEAR = 365.25;
const SECONDS_PER_YEAR = 31_557_600;
const MAX_VOLATILITY = 128;

export interface CallOptionAnalytics {
  readonly impliedVolatilityPpm: bigint;
  readonly deltaPpm: bigint;
  readonly gammaPpm: bigint;
  readonly vegaPpm: bigint;
  readonly thetaPpm: bigint;
}

export interface CallSpreadAnalytics extends CallOptionAnalytics {
  readonly volatilitySpreadPpm: bigint;
}

function requireFinitePositive(value: number, context: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${context} must be finite and positive`);
  return value;
}

function ppm(value: number, context: string): bigint {
  const scaled = Math.round(value * PPM);
  if (!Number.isSafeInteger(scaled)) throw new Error(`${context} is outside the supported range`);
  return BigInt(scaled);
}

function normalDensity(value: number): number {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function normalCdf(value: number): number {
  const magnitude = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * magnitude);
  const tail = normalDensity(magnitude) * t * (
    0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
  );
  return value >= 0 ? 1 - tail : tail;
}

function callPrice(spot: number, strike: number, years: number, volatility: number): number {
  if (volatility === 0) return Math.max(spot - strike, 0);
  const rootTime = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * volatility * volatility * years) / (volatility * rootTime);
  return spot * normalCdf(d1) - strike * normalCdf(d1 - volatility * rootTime);
}

function impliedVolatility(spot: number, strike: number, years: number, premium: number): number {
  const intrinsic = Math.max(spot - strike, 0);
  const tolerance = Math.max(spot * 1e-12, 1e-12);
  if (premium < intrinsic - tolerance || premium >= spot) {
    throw new Error('call premium violates its zero-carry no-arbitrage bounds');
  }
  if (premium <= intrinsic + tolerance) return 0;
  let low = 0;
  let high = 1;
  while (callPrice(spot, strike, years, high) < premium && high < MAX_VOLATILITY) high *= 2;
  if (callPrice(spot, strike, years, high) < premium) {
    throw new Error('call implied volatility exceeds the supported range');
  }
  for (let iteration = 0; iteration < 96; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (callPrice(spot, strike, years, midpoint) < premium) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

export function callOptionAnalytics(input: Readonly<{
  spot: number;
  strike: number;
  premium: number;
  secondsToMaturity: number;
}>): CallOptionAnalytics {
  const spot = requireFinitePositive(input.spot, 'spot');
  const strike = requireFinitePositive(input.strike, 'strike');
  const premium = requireFinitePositive(input.premium, 'premium');
  if (!Number.isSafeInteger(input.secondsToMaturity)) throw new Error('seconds to maturity must be a safe integer');
  const secondsToMaturity = requireFinitePositive(input.secondsToMaturity, 'seconds to maturity');
  const years = secondsToMaturity / SECONDS_PER_YEAR;
  const volatility = impliedVolatility(spot, strike, years, premium);
  if (volatility === 0) {
    const delta = spot > strike ? 1 : spot < strike ? 0 : 0.5;
    return Object.freeze({
      impliedVolatilityPpm: 0n,
      deltaPpm: ppm(delta, 'delta'),
      gammaPpm: 0n,
      vegaPpm: 0n,
      thetaPpm: 0n,
    });
  }
  const rootTime = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * volatility * volatility * years) / (volatility * rootTime);
  const density = normalDensity(d1);
  const delta = normalCdf(d1);
  const gamma = density / (spot * volatility * rootTime);
  const vega = spot * density * rootTime;
  const annualTheta = -spot * density * volatility / (2 * rootTime);
  return Object.freeze({
    impliedVolatilityPpm: ppm(volatility, 'implied volatility'),
    deltaPpm: ppm(delta, 'delta'),
    gammaPpm: ppm(gamma * spot, 'spot-normalized gamma'),
    vegaPpm: ppm(vega / spot, 'spot-normalized vega'),
    thetaPpm: ppm(annualTheta / spot / DAYS_PER_YEAR, 'daily spot-normalized theta'),
  });
}

export function callSpreadAnalytics(input: Readonly<{
  spot: number;
  longStrike: number;
  shortStrike: number;
  longPremium: number;
  shortPremium: number;
  secondsToMaturity: number;
  direction: 1 | -1;
}>): CallSpreadAnalytics {
  if (!(input.longStrike < input.shortStrike)) throw new Error('long strike must be below short strike');
  const long = callOptionAnalytics({
    spot: input.spot,
    strike: input.longStrike,
    premium: input.longPremium,
    secondsToMaturity: input.secondsToMaturity,
  });
  const short = callOptionAnalytics({
    spot: input.spot,
    strike: input.shortStrike,
    premium: input.shortPremium,
    secondsToMaturity: input.secondsToMaturity,
  });
  const direction = BigInt(input.direction);
  return Object.freeze({
    impliedVolatilityPpm: (long.impliedVolatilityPpm + short.impliedVolatilityPpm) / 2n,
    volatilitySpreadPpm: short.impliedVolatilityPpm - long.impliedVolatilityPpm,
    deltaPpm: direction * (long.deltaPpm - short.deltaPpm),
    gammaPpm: direction * (long.gammaPpm - short.gammaPpm),
    vegaPpm: direction * (long.vegaPpm - short.vegaPpm),
    thetaPpm: direction * (long.thetaPpm - short.thetaPpm),
  });
}

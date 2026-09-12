// Bonding-curve pricing, ported 1:1 from ponscli src/core/quote.ts, which
// transcribes PonsV2BondingCurveMath and the fee ordering of
// PonsV2BondingCurve.buy/.sell. Integer arithmetic matches the contract's
// truncation exactly.

export const BPS = 10_000n;

/** Minimum the contract guarantees a taxed buyer keeps, in basis points. */
const MIN_BUYER_SHARE_BPS = 100n;

export class CurveMathError extends Error {
  constructor(readonly reason: "input" | "output" | "liquidity") {
    super(`curve cannot price this trade: ${reason}`);
    this.name = "CurveMathError";
  }
}

export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw new CurveMathError("input");
  if (reserveIn <= 0n || reserveOut <= 0n) throw new CurveMathError("liquidity");
  const out = (amountIn * reserveOut) / (reserveIn + amountIn);
  if (out === 0n) throw new CurveMathError("output");
  return out;
}

export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new CurveMathError("output");
  if (reserveIn <= 0n || reserveOut <= amountOut) throw new CurveMathError("liquidity");
  return (amountOut * reserveIn) / (reserveOut - amountOut) + 1n;
}

function mulDivCeil(x: bigint, y: bigint, denominator: bigint): bigint {
  const product = x * y;
  return product % denominator === 0n ? product / denominator : product / denominator + 1n;
}

export interface CurveState {
  /** Tradeable quote reserve, phantom included. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  /** Tokens held back to seed the graduated pool. */
  reservedTokens: bigint;
  curveFeeBps: bigint;
  creatorTaxBps: bigint;
}

export interface BuyQuote {
  offered: bigint;
  spent: bigint;
  refund: bigint;
  tokensOut: bigint;
  curveFee: bigint;
  creatorTax: bigint;
  snipeTax: bigint;
  clamped: boolean;
}

/** Cap the snipe tax the way the curve does. */
export function boundedSnipeTaxBps(state: CurveState, snipeTaxBps: bigint): bigint {
  if (snipeTaxBps === 0n) return 0n;
  const max = BPS - state.curveFeeBps - state.creatorTaxBps - MIN_BUYER_SHARE_BPS;
  if (max <= 0n) return 0n;
  return snipeTaxBps > max ? max : snipeTaxBps;
}

/** Price a buy of `offered` quote units; mirrors PonsV2BondingCurve.buy. */
export function quoteBuy(state: CurveState, offered: bigint, snipeTaxBps = 0n): BuyQuote {
  if (offered <= 0n) throw new CurveMathError("input");
  const sellable = state.tokenReserve > state.reservedTokens ? state.tokenReserve - state.reservedTokens : 0n;
  if (sellable === 0n) throw new CurveMathError("liquidity");

  const bounded = boundedSnipeTaxBps(state, snipeTaxBps);
  const legs = (amount: bigint) => ({
    fee: (amount * state.curveFeeBps) / BPS,
    tax: (amount * state.creatorTaxBps) / BPS,
    snipe: (amount * bounded) / BPS,
  });

  let spent = offered;
  let { fee, tax, snipe } = legs(spent);
  let tokensOut = getAmountOut(spent - fee - tax - snipe, state.quoteReserve, state.tokenReserve);

  let clamped = false;
  if (tokensOut > sellable) {
    clamped = true;
    tokensOut = sellable;
    const net = getAmountIn(sellable, state.quoteReserve, state.tokenReserve);
    const grossed = mulDivCeil(net, BPS, BPS - state.curveFeeBps - state.creatorTaxBps - bounded);
    spent = grossed < offered ? grossed : offered;
    ({ fee, tax, snipe } = legs(spent));
  }

  return { offered, spent, refund: offered - spent, tokensOut, curveFee: fee, creatorTax: tax, snipeTax: snipe, clamped };
}

export interface SellQuote {
  tokensIn: bigint;
  gross: bigint;
  quoteOut: bigint;
  curveFee: bigint;
  creatorTax: bigint;
}

/** Price a sell of `tokensIn`; mirrors PonsV2BondingCurve.sell (fees on output). */
export function quoteSell(state: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n) throw new CurveMathError("input");
  const gross = getAmountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  const curveFee = (gross * state.curveFeeBps) / BPS;
  const creatorTax = (gross * state.creatorTaxBps) / BPS;
  return { tokensIn, gross, quoteOut: gross - curveFee - creatorTax, curveFee, creatorTax };
}

/** Round a quoted output down by a slippage tolerance. */
export function withSlippage(expected: bigint, slippageBps: bigint): bigint {
  if (slippageBps <= 0n) return expected;
  if (slippageBps >= BPS) return 0n;
  return (expected * (BPS - slippageBps)) / BPS;
}

/** Never lower a floor the caller already accepted. */
export function floorAtLeast(computed: bigint, accepted: bigint | undefined): bigint {
  if (accepted === undefined) return computed;
  return computed > accepted ? computed : accepted;
}

/** Price impact against the mid price, in basis points (fees excluded). */
export function priceImpactBps(amountIn: bigint, reserveIn: bigint, amountOut: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || amountOut <= 0n) return 0n;
  const ideal = (amountIn * reserveOut) / reserveIn;
  if (ideal <= amountOut) return 0n;
  return ((ideal - amountOut) * BPS) / ideal;
}

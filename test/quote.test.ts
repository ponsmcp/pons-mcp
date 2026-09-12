import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BPS,
  CurveMathError,
  boundedSnipeTaxBps,
  floorAtLeast,
  getAmountIn,
  getAmountOut,
  priceImpactBps,
  quoteBuy,
  quoteSell,
  withSlippage,
  type CurveState,
} from "../src/quote.js";

const state = (over: Partial<CurveState> = {}): CurveState => ({
  quoteReserve: 10_000n,
  tokenReserve: 10_000n,
  reservedTokens: 1_000n,
  curveFeeBps: 100n,
  creatorTaxBps: 0n,
  ...over,
});

test("getAmountOut / getAmountIn are constant-product inverse (floor/ceil)", () => {
  assert.equal(getAmountOut(10n, 1_000n, 1_000n), 9n); // 10*1000/1010 = 9.90…
  assert.equal(getAmountIn(9n, 1_000n, 1_000n), 10n); // exact inverse rounds up
  // larger reserves: 99*10000/(10000+99) = 98.02…
  assert.equal(getAmountOut(99n, 10_000n, 10_000n), 98n);
});

test("getAmountOut/getAmountIn reject degenerate input", () => {
  assert.throws(() => getAmountOut(0n, 1n, 1n), CurveMathError);
  assert.throws(() => getAmountOut(1n, 0n, 1n), CurveMathError);
  assert.throws(() => getAmountOut(1n, 1n, 0n), CurveMathError);
  assert.throws(() => getAmountIn(0n, 1n, 1n), CurveMathError);
  assert.throws(() => getAmountIn(2n, 1n, 2n), CurveMathError); // out >= reserveOut
});

test("quoteBuy: fee-on-input ordering", () => {
  // offered 100, fee 1% → net 99 → tokensOut = 99*10000/(10000+99) = 98
  const q = quoteBuy(state(), 100n);
  assert.equal(q.offered, 100n);
  assert.equal(q.spent, 100n);
  assert.equal(q.refund, 0n);
  assert.equal(q.curveFee, 1n);
  assert.equal(q.creatorTax, 0n);
  assert.equal(q.snipeTax, 0n);
  assert.equal(q.tokensOut, 98n);
  assert.equal(q.clamped, false);
});

test("quoteBuy: creator tax comes off the input too", () => {
  // fee 1% + tax 1% → net 98 → 98*10000/(10000+98) = 97.01… → 97
  const q = quoteBuy(state({ creatorTaxBps: 100n }), 100n);
  assert.equal(q.curveFee, 1n);
  assert.equal(q.creatorTax, 1n);
  assert.equal(q.tokensOut, 97n);
});

test("quoteBuy: snipe tax applies and is bounded", () => {
  // max = 10000 - 100 - 0 - 100 = 9800; 9900 requested → 9800
  // offered 10000: fee 100, snipe 9800 → net 100 → tokensOut = 100*10000/10100 = 99
  const q = quoteBuy(state(), 10_000n, 9_900n);
  assert.equal(q.snipeTax, (10_000n * 9_800n) / BPS); // 9800
  assert.equal(q.tokensOut, getAmountOut(10_000n - 100n - 9_800n, 10_000n, 10_000n));
});

test("boundedSnipeTaxBps clamps and never goes negative", () => {
  assert.equal(boundedSnipeTaxBps(state(), 0n), 0n);
  assert.equal(boundedSnipeTaxBps(state(), 5_000n), 5_000n);
  assert.equal(boundedSnipeTaxBps(state(), 9_900n), 9_800n);
  // pathological fee config: fee+tax > 9900 → max negative → 0 (regression guard)
  assert.equal(boundedSnipeTaxBps(state({ curveFeeBps: 9_950n }), 9_900n), 0n);
});

test("quoteBuy clamps at sellable and refunds the excess", () => {
  // quoteReserve=100, tokenReserve=1000, reserved=900 → sellable=100
  const s = state({ quoteReserve: 100n, tokenReserve: 1_000n, reservedTokens: 900n });
  const q = quoteBuy(s, 10_000n);
  assert.equal(q.clamped, true);
  assert.equal(q.tokensOut, 100n);
  // net needed = getAmountIn(100, 100, 1000) = 100*100/900 + 1 = 12
  // grossed = ceil(12 * 10000 / (10000-100)) = ceil(12.12…) = 13
  assert.equal(q.spent, 13n);
  assert.equal(q.refund, 10_000n - 13n);
});

test("clamped quote satisfies the contract's price bound after 5% floor (regression)", () => {
  // On-chain check: spent * minTokensOut > received * tokensOut → revert.
  // The tool scales the floor by spent/offered on clamped fills; verify the
  // scaled floor always passes the contract check.
  const s = state({ quoteReserve: 100n, tokenReserve: 1_000n, reservedTokens: 900n });
  for (const offered of [150n, 1_000n, 10_000n, 10n ** 24n]) {
    const q = quoteBuy(s, offered);
    const base = q.clamped && q.spent > 0n ? (q.tokensOut * offered) / q.spent : q.tokensOut;
    const minOut = withSlippage(base, 500n);
    assert.ok(
      q.spent * minOut <= offered * q.tokensOut,
      `offered=${offered}: spent*minOut=${q.spent * minOut} > offered*tokensOut=${offered * q.tokensOut}`,
    );
  }
});

test("quoteBuy refuses when nothing is sellable", () => {
  assert.throws(() => quoteBuy(state({ tokenReserve: 900n, reservedTokens: 900n }), 100n), CurveMathError);
  assert.throws(() => quoteBuy(state(), 0n), CurveMathError);
});

test("quoteSell: fees on output", () => {
  // gross = 100*10000/(10000+100) = 99; fee 1% = 0 (99*100/10000 = 0), tax 0 → 99
  const q = quoteSell(state(), 100n);
  assert.equal(q.gross, 99n);
  assert.equal(q.curveFee, 0n);
  assert.equal(q.quoteOut, 99n);
  // bigger sell: gross = 1000 → fee = 10, tax 5% → 50 → out 940
  const q2 = quoteSell(state({ creatorTaxBps: 500n }), 1_111n);
  const gross = getAmountOut(1_111n, 10_000n, 10_000n);
  assert.equal(q2.gross, gross);
  assert.equal(q2.curveFee, (gross * 100n) / BPS);
  assert.equal(q2.creatorTax, (gross * 500n) / BPS);
  assert.equal(q2.quoteOut, gross - q2.curveFee - q2.creatorTax);
});

test("withSlippage / floorAtLeast", () => {
  assert.equal(withSlippage(1_000n, 500n), 950n);
  assert.equal(withSlippage(1_000n, 0n), 1_000n);
  assert.equal(withSlippage(1_000n, 10_000n), 0n);
  assert.equal(floorAtLeast(950n, undefined), 950n);
  assert.equal(floorAtLeast(950n, 900n), 950n); // caller's lower floor never lowers ours
  assert.equal(floorAtLeast(950n, 990n), 990n); // caller can only raise the floor
});

test("priceImpactBps", () => {
  // ideal = 1000*10000/10000 = 1000; actual 900 → (100 * 10000)/1000 = 1000 bps = 10%
  assert.equal(priceImpactBps(1_000n, 10_000n, 900n, 10_000n), 1_000n);
  assert.equal(priceImpactBps(0n, 10_000n, 900n, 10_000n), 0n); // degenerate → 0
  assert.equal(priceImpactBps(1_000n, 10_000n, 1_100n, 10_000n), 0n); // better than mid → 0
});

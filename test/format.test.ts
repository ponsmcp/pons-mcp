import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUnits, formatEth, formatGwei, formatBps, pct, parseUnits, ParseUnitsError, isZeroAddress } from "../src/format.js";

test("formatUnits basics", () => {
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatUnits(100n, 18), "0.0000000000000001");
  assert.equal(formatUnits(15n * 10n ** 17n, 18), "1.5");
  assert.equal(formatUnits(10n ** 18n, 18), "1");
  assert.equal(formatUnits(1_000_000n, 6), "1");
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(42n, 0), "42");
  assert.equal(formatUnits(-15n * 10n ** 17n, 18), "-1.5");
  // trailing zeros trimmed, integer part never empty
  assert.equal(formatUnits(10n ** 17n, 18), "0.1");
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
});

test("unit helpers", () => {
  assert.equal(formatEth(500_000_000_000_000n), "0.0005 ETH");
  assert.equal(formatGwei(373_358_000n), "0.373358 gwei");
  assert.equal(formatBps(10_000n), "100%");
  assert.equal(formatBps(1_000n), "10%");
  assert.equal(formatBps(9_900n), "99%");
  assert.equal(formatBps(100n), "1%");
  assert.equal(formatBps(0n), "0%");
});

test("pct", () => {
  assert.equal(pct(1n, 4n), "25%");
  assert.equal(pct(1n, 3n), "33.33%");
  assert.equal(pct(0n, 0n), "0%"); // zero-denominator guard
  assert.equal(pct(99n, 100n), "99%");
});

test("parseUnits round-trips", () => {
  assert.equal(parseUnits("1.5", 18), 15n * 10n ** 17n);
  assert.equal(parseUnits("0.0005", 18), 500_000_000_000_000n);
  assert.equal(parseUnits("0.000001", 6), 1n);
  assert.equal(parseUnits("6", 6), 6_000_000n);
  assert.equal(parseUnits("0", 18), 0n);
  assert.equal(parseUnits("  2.5  ", 18), 25n * 10n ** 17n); // trims whitespace
  assert.equal(parseUnits("123", 0), 123n);
  for (const [text, d] of [["1.5", 18], ["0.000001", 6], ["714285714.285714", 18]] as const) {
    assert.equal(formatUnits(parseUnits(text, d), d), text.replace(/0+$/, "").replace(/\.$/, ""));
  }
});

test("parseUnits rejects malformed input with ParseUnitsError", () => {
  for (const bad of ["abc", "", "1.2.3", "-5", "+5", "1e18", "0x10", "1,000", ".5", "5.", "1 " .trim() + " eth", "NaN", "Infinity"]) {
    assert.throws(() => parseUnits(bad, 18), ParseUnitsError, `should reject: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseUnits("1.1234567", 6), ParseUnitsError); // too many decimals
  assert.throws(() => parseUnits("1.5", 0), ParseUnitsError); // decimals=0 rejects fractions
});

test("isZeroAddress", () => {
  assert.ok(isZeroAddress("0x0000000000000000000000000000000000000000"));
  assert.ok(isZeroAddress("0x0000000000000000000000000000000000000000".toUpperCase().replace("0X", "0x")));
  assert.ok(!isZeroAddress("0x000000000000000000000000000000000000dEaD"));
});

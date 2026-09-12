import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScanConfig, scoreToken, summarizeTrades, type ScoreGates, type TokenSnapshot } from "../src/scan.js";

const gates: ScoreGates = { minUniqueBuyers: 3, minQuoteWei: 5n * 10n ** 16n, minAgeSec: 30, maxAgeSec: 1200, maxDeployerLaunches: 5 };
const dep = "0x" + "aa".repeat(20);
function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return { token: "0x" + "11".repeat(20), curve: "0x" + "22".repeat(20), deployer: dep, name: "T", symbol: "T", description: "", logo: "",
    isNativeQuote: true, graduated: false, realQuoteReserve: 8n * 10n ** 16n, graduationThreshold: 42n * 10n ** 17n, launchedAt: 1000, nowSec: 1100, ...over };
}
const trade = (side: string, trader: string) => ({ side, trader });

test("summarizeTrades excludes the deployer from unique buyers", () => {
  const t = summarizeTrades([trade("buy", dep), trade("buy", "0x1"), trade("buy", "0x1"), trade("buy", "0x2"), trade("sell", "0x9")], dep);
  assert.deepEqual(t, { buyCount: 4, sellCount: 1, uniqueBuyersExDeployer: 2 });
});

test("score fails a deployer-only curve", () => {
  const r = scoreToken(snap(), { buyCount: 3, sellCount: 0, uniqueBuyersExDeployer: 0 }, gates, 1);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => x.startsWith("unique buyers")));
});

test("score passes 3 unique buyers, 0.08 ETH in, more buys than sells", () => {
  const r = scoreToken(snap(), { buyCount: 5, sellCount: 1, uniqueBuyersExDeployer: 3 }, gates, 1);
  assert.equal(r.pass, true);
  assert.ok(r.score > 0 && r.score <= 100);
});

test("serial deployer, own deployer, graduated and non-ETH pairs are gated", () => {
  const good = { buyCount: 5, sellCount: 1, uniqueBuyersExDeployer: 3 };
  assert.equal(scoreToken(snap(), good, gates, 6).pass, false);
  assert.equal(scoreToken(snap(), good, { ...gates, ourAddress: dep }, 1).pass, false);
  assert.equal(scoreToken(snap({ graduated: true }), good, gates, 1).pass, false);
  assert.equal(scoreToken(snap({ isNativeQuote: false }), good, gates, 1).pass, false);
});

test("parseScanConfig fails closed on malformed values and applies defaults", () => {
  const cfg = parseScanConfig({});
  assert.equal(cfg.scanLimit, 20);
  assert.equal(cfg.gates.minUniqueBuyers, 3);
  assert.throws(() => parseScanConfig({ PONS_SCAN_LIMIT: "abc" }));
  assert.throws(() => parseScanConfig({ PONS_SCAN_LIMIT: "1000" }));
  assert.throws(() => parseScanConfig({ PONS_SCAN_MIN_AGE_SEC: "500", PONS_SCAN_MAX_AGE_SEC: "100" }));
  assert.throws(() => parseScanConfig({ PONS_SCAN_MIN_QUOTE_ETH: "-1" }));
});

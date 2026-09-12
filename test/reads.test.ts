import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingFeeChange, snipeTax, curveTrades } from "../src/pons.js";
import { FACTORY, MEME_HOOK, BURN_DEAD } from "../src/pons.js";
import { mockClient, addrWord, word0x } from "./helpers.js";
import { SEL } from "../src/abi.js";
import type { RpcClient, RpcLog } from "../src/rpc.js";

const TOKEN = "0x" + "70".repeat(20);
const CURVE = "0x" + "c1".repeat(20);
const NEW_RECIPIENT = "0x" + "b1".repeat(20);

// ---------- pons_pending_fee_change ----------

function feeClient(words: [string, bigint, bigint] | null) {
  return mockClient({
    ethCall: (_to, data) => {
      if (data.startsWith("0x" + SEL.pendingCreatorFeeRecipient)) {
        return words
          ? "0x" + [addrWord(words[0]), word0x(words[1]), word0x(words[2])].map((w) => w.slice(2)).join("")
          : "0x" + [addrWord("0x" + "00".repeat(20)), word0x(0n), word0x(0n)].map((w) => w.slice(2)).join("");
      }
      if (data.startsWith("0x" + SEL.feeRecipientTimelock)) return word0x(259_200n);
      if (data.startsWith("0x" + SEL.feeRecipientWindow)) return word0x(259_200n);
      throw new Error("unexpected ethCall " + data.slice(0, 10));
    },
  });
}

test("pendingFeeChange: no pending change → clean null shape", async () => {
  const out = await pendingFeeChange(feeClient(null) as unknown as RpcClient, TOKEN);
  assert.deepEqual(
    { pending: out.pending, recipient: out.recipient, effectiveAt: out.effectiveAt, expiresAt: out.expiresAt, status: out.status },
    { pending: false, recipient: null, effectiveAt: null, expiresAt: null, status: "none" },
  );
});

test("pendingFeeChange: status transitions (timelocked → executable → expired)", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const timelocked = await pendingFeeChange(feeClient([NEW_RECIPIENT, now + 100n, now + 200n]) as unknown as RpcClient, TOKEN);
  assert.equal(timelocked.status, "timelocked");
  assert.equal(timelocked.recipient, NEW_RECIPIENT);
  assert.equal(timelocked.effectiveAt, Number(now + 100n));
  assert.equal(timelocked.expiresAt, Number(now + 200n));

  const executable = await pendingFeeChange(feeClient([NEW_RECIPIENT, now - 100n, now + 100n]) as unknown as RpcClient, TOKEN);
  assert.equal(executable.status, "executable");

  const expired = await pendingFeeChange(feeClient([NEW_RECIPIENT, now - 200n, now - 100n]) as unknown as RpcClient, TOKEN);
  assert.equal(expired.status, "expired");
});

// ---------- pons_snipe_tax ----------

test("snipeTax reads the window from the CURVE's frozen value, not the factory", async () => {
  const launchedAt = BigInt(Math.floor(Date.now() / 1000)) - 10n; // 10s ago
  let factorySnipeCalled = false;
  const c = mockClient({
    ethCall: (to, data) => {
      if (to.toLowerCase() === FACTORY.toLowerCase()) {
        factorySnipeCalled = factorySnipeCalled || data.startsWith("0x" + SEL.snipeTaxSeconds);
        return word0x(60n); // factory global retuned to 60s — must NOT be used
      }
      if (to.toLowerCase() === CURVE) {
        if (data.startsWith("0x" + SEL.currentSnipeTaxBps)) return word0x(0n);
        if (data.startsWith("0x" + SEL.snipeTaxExempt)) return word0x(0n);
        if (data.startsWith("0x" + SEL.launchedAt)) return word0x(launchedAt);
        if (data.startsWith("0x" + SEL.snipeTaxSeconds)) return word0x(3n); // frozen at initialize
        if (data.startsWith("0x" + SEL.deployer)) return addrWord("0x" + "de".repeat(20));
      }
      throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
    },
  });
  const out = await snipeTax(c as unknown as RpcClient, CURVE);
  assert.equal(out.snipeTaxWindowSeconds, 3, "curve's frozen window, not factory's 60");
  assert.equal(out.windowActive, false, "10s since launch > 3s window");
  assert.equal(factorySnipeCalled, false);
  // default recipient is a non-exempt sentinel (deployer is auto-exempt)
  assert.equal(out.recipient, BURN_DEAD.toLowerCase());
  assert.equal(out.snipeTaxExempt, false);
});

test("snipeTax windowActive inside the window for a non-exempt recipient", async () => {
  const launchedAt = BigInt(Math.floor(Date.now() / 1000)) - 1n; // 1s ago
  const c = mockClient({
    ethCall: (to, data) => {
      if (data.startsWith("0x" + SEL.currentSnipeTaxBps)) return word0x(4_000n);
      if (data.startsWith("0x" + SEL.snipeTaxExempt)) return word0x(0n);
      if (data.startsWith("0x" + SEL.launchedAt)) return word0x(launchedAt);
      if (data.startsWith("0x" + SEL.snipeTaxSeconds)) return word0x(3n);
      throw new Error("unexpected " + data.slice(0, 10));
    },
  });
  const out = await snipeTax(c as unknown as RpcClient, CURVE);
  assert.equal(out.windowActive, true);
  assert.equal(out.currentSnipeTaxBps, 4_000);
});

// ---------- pons_curve_trades labels ----------

test("curveTrades: buy entries report spent + feeIncludesSnipeTax; sells don't", async () => {
  const dataWord = (v: bigint) => v.toString(16).padStart(64, "0");
  const mkLog = (topic0: string, data: string, block: number): RpcLog => ({
    address: CURVE,
    topics: [topic0, addrWord("0x" + "aa".repeat(20)), addrWord("0x" + "bb".repeat(20))],
    data,
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + "ff".repeat(32),
    logIndex: "0x0",
  });
  const { TOPIC } = await import("../src/abi.js");
  const buyLog = mkLog("0x" + TOPIC.CurveBuy, "0x" + [1000n, 5000n, 10n, 2n].map(dataWord).join(""), 100);
  const sellLog = mkLog("0x" + TOPIC.CurveSell, "0x" + [700n, 300n, 7n, 1n].map(dataWord).join(""), 90);
  const c = {
    async assertChain() {},
    async scanLogs(_f: unknown, _l: number, _lim: number) {
      const isBuy = JSON.stringify(_f).includes(TOPIC.CurveBuy);
      return {
        logs: isBuy ? [buyLog] : [sellLog],
        latestBlock: 100n,
        fromBlock: 50n,
        scannedFromBlock: 50n,
        complete: true,
      };
    },
  };
  const out = await curveTrades(c as unknown as RpcClient, CURVE, {});
  assert.equal(out.count, 2);
  const buy = out.trades.find((t) => t.side === "buy")!;
  const sell = out.trades.find((t) => t.side === "sell")!;
  assert.equal(buy.spent, "1000");
  assert.equal(buy.tokensOut, "5000");
  assert.equal(buy.feeIncludesSnipeTax, true);
  assert.equal(buy.tokensIn, undefined);
  assert.equal(sell.tokensIn, "700");
  assert.equal(sell.quoteOut, "300");
  assert.equal(sell.feeIncludesSnipeTax, undefined);
  assert.equal(out.trades[0].side, "buy", "newest block first");
  assert.equal(out.scanComplete, true);
});

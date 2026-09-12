import { test } from "node:test";
import assert from "node:assert/strict";
import { buyTool, sellTool, readCurveContext } from "../src/trade.js";
import { FACTORY } from "../src/pons.js";
import { RpcError } from "../src/rpc.js";
import { loadSigner } from "../src/signer.js";
import { mockClient, addrWord, word0x, wordUint } from "./helpers.js";
import { SEL, encodeString, encodeUint } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const CURVE = "0x" + "c1".repeat(20);
const TOKEN = "0x" + "70".repeat(20);
const PAIR2 = "0x" + "99".repeat(20); // ERC-20 quote asset (6 decimals)
const OTHER_CURVE = "0x" + "c2".repeat(20);

const stringReturn = (s: string) => "0x" + encodeUint(32) + encodeString(s);

interface CurveOpts {
  registered?: boolean; // getLaunchedToken exists && curve matches
  quoteReserve?: bigint;
  tokenReserve?: bigint;
  reservedTokens?: bigint;
  tokenDecimals?: number;
  buybackQuoteBalance?: bigint;
  erc20Quote?: boolean; // pair token = PAIR2 instead of native
}

function launchedTokenWords(token: string, curve: string, exists: boolean): string {
  const w = [
    addrWord(token), // 0 token
    addrWord(curve), // 1 curve
    addrWord(signer.address), // 2 deployer
    addrWord(signer.address), // 3 creatorFeeRecipient
    addrWord("0x" + "00".repeat(20)), // 4 pairToken
    word0x(42n * 10n ** 17n), // 5 graduationThreshold
    word0x(0n), // 6 poolFee
    word0x(200n), // 7 tickSpacing
    word0x(0n), // 8 creatorTaxBps
    word0x(0n), // 9 buybackEnabled
    word0x(0n), // 10 phase NotGraduated
    word0x(0n), // 11 sweptQuote
    word0x(0n), // 12 sweptTokens
    word0x(0n), // 13 sweptAt
    word0x(exists ? 1n : 0n), // 14 exists
  ]
    .map((x) => x.slice(2))
    .join("");
  return "0x" + w;
}

function makeCurveClient(o: CurveOpts = {}) {
  const qr = o.quoteReserve ?? 10n ** 19n;
  const tr = o.tokenReserve ?? 10n ** 24n;
  const res = o.reservedTokens ?? 10n ** 23n;
  return mockClient({
    ethCall: (to, data) => {
      const t = to.toLowerCase();
      if (t === FACTORY.toLowerCase() && data.startsWith("0x" + SEL.getLaunchedToken)) {
        return o.registered === false
          ? launchedTokenWords(TOKEN, OTHER_CURVE, false)
          : launchedTokenWords(TOKEN, CURVE, true);
      }
      if (t === CURVE) {
        if (data.startsWith("0x" + SEL.token)) return addrWord(TOKEN);
        if (data.startsWith("0x" + SEL.isNativeQuote)) return word0x(o.erc20Quote ? 0n : 1n);
        if (data.startsWith("0x" + SEL.pairToken)) return addrWord(o.erc20Quote ? PAIR2 : "0x" + "00".repeat(20));
        if (data.startsWith("0x" + SEL.graduated)) return word0x(0n);
        if (data.startsWith("0x" + SEL.readyToGraduate)) return word0x(0n);
        if (data.startsWith("0x" + SEL.getReserves)) return "0x" + word0x(qr).slice(2) + word0x(tr).slice(2);
        if (data.startsWith("0x" + SEL.feeBps)) return word0x(100n);
        if (data.startsWith("0x" + SEL.creatorTaxBps)) return word0x(0n);
        if (data.startsWith("0x" + SEL.realQuoteReserve)) return word0x(qr > 168n * 10n ** 16n ? qr - 168n * 10n ** 16n : 0n);
        if (data.startsWith("0x" + SEL.graduationThreshold)) return word0x(42n * 10n ** 17n);
        if (data.startsWith("0x" + SEL.currentSnipeTaxBps)) return word0x(0n);
        if (data.startsWith("0x" + SEL.reservedTokens)) return word0x(res);
      }
      if (t === TOKEN || t === PAIR2) {
        if (data.startsWith("0x" + SEL.decimals)) return word0x(BigInt(t === PAIR2 ? 6 : (o.tokenDecimals ?? 18)));
        if (data.startsWith("0x" + SEL.symbol)) return stringReturn(t === PAIR2 ? "USDG" : "TST");
        if (data.startsWith("0x" + SEL.balanceOf)) return word0x(10n ** 24n);
        if (data.startsWith( "0x" + SEL.allowance)) return word0x(0n);
      }
      if (t === CURVE) {
        if (data.startsWith("0x" + SEL.quoteFeeBalance)) return word0x(10n ** 16n);
        if (data.startsWith("0x" + SEL.creatorTaxBalance)) return word0x(0n);
        if (data.startsWith("0x" + SEL.buybackQuoteBalance)) return word0x(BigInt(o.buybackQuoteBalance ?? 0));
      }
      throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
    },
    call: (method, params) => {
      if (method === "eth_call") {
        // slot-discovery probes (3-arg with overrides): report the marker so slot 0 "works"
        const p = params as unknown[];
        if (p.length === 3) return word0x(10n ** 30n);
        return "0x"; // plain simulation succeeds
      }
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      throw new Error("unexpected " + method);
    },
  });
}

test("readCurveContext marks factory-registered curves", async () => {
  const ctx = await readCurveContext(makeCurveClient() as unknown as RpcClient, CURVE);
  assert.equal(ctx.registered, true);
  assert.equal(ctx.isNativeQuote, true);
  assert.equal(ctx.token, TOKEN);
});

test("pons_buy refuses an unregistered curve (fake-curve guard)", async () => {
  const c = makeCurveClient({ registered: false });
  await assert.rejects(
    buyTool(c as unknown as RpcClient, signer, CURVE, "0.001"),
    (e: Error) => (e as { code?: string }).code === "NOT_A_LAUNCH",
  );
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("pons_buy: RPC failure during the registration check → RPC_FAILURE, not NOT_A_LAUNCH", async () => {
  const base = makeCurveClient();
  // Simulate a transient RPC failure on the factory record read only
  const failing = mockClient({
    ethCall: (to, data) => {
      if (data.startsWith("0x" + SEL.getLaunchedToken)) throw new Error("node unavailable");
      return base.ethCallRaw(to, data);
    },
    call: base.callRaw,
  });
  await assert.rejects(
    buyTool(failing as unknown as RpcClient, signer, CURVE, "0.001"),
    (e: Error) => (e as { code?: string }).code === "RPC_FAILURE" && /could not verify/.test(e.message),
  );
});

test("pons_sell refuses an unregistered curve (fake-curve guard)", async () => {
  const c = makeCurveClient({ registered: false });
  await assert.rejects(
    sellTool(c as unknown as RpcClient, signer, CURVE, "100"),
    (e: Error) => (e as { code?: string }).code === "NOT_A_LAUNCH",
  );
});

test("pons_buy dry-run on a registered native curve: one step, value = amountIn", async () => {
  const c = makeCurveClient();
  const out = await buyTool(c as unknown as RpcClient, signer, CURVE, "0.001");
  assert.equal(out.mode, "dry-run");
  assert.equal(out.steps.length, 1, "no approve step for native pairs");
  assert.equal(out.steps[0].valueWei, (10n ** 15n).toString());
  assert.equal(out.steps[0].simulation.ok, true);
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("clamped buy: minTokensOut respects the contract price bound (regression)", async () => {
  // Tiny reserves so a 1 ETH buy is massively clamped
  const c = makeCurveClient({ quoteReserve: 100n, tokenReserve: 1_000n, reservedTokens: 900n });
  const out = await buyTool(c as unknown as RpcClient, signer, CURVE, "1");
  const q = out.quote as { tokensOut: string; minTokensOut: string; spent: string; clamped: boolean };
  assert.equal(q.clamped, true);
  const amountIn = 10n ** 18n;
  const spent = BigInt(q.spent);
  const tokensOut = BigInt(q.tokensOut);
  const minOut = BigInt(q.minTokensOut);
  assert.ok(spent * minOut <= amountIn * tokensOut, "contract: spent*minTokensOut > received*tokensOut would revert");
  assert.ok(spent < amountIn, "partial fill");
});

test("pons_buy rejects malformed amounts with a parse error", async () => {
  const c = makeCurveClient();
  await assert.rejects(buyTool(c as unknown as RpcClient, signer, CURVE, "abc"), /invalid decimal amount/);
});

test("malicious token decimals (255) are clamped to 18 (DoS guard)", async () => {
  // Distinct curve/token per case: metadata is cached per address once resolved.
  const variant = (tokenDecimals: number, tokenSuffix: string) => {
    const TOK = "0x" + tokenSuffix.repeat(20);
    const CRV = "0x" + "c3".repeat(20);
    const client = mockClient({
      ethCall: (to, data) => {
        const t = to.toLowerCase();
        if (t === FACTORY.toLowerCase()) {
          const w = (x: string) => x.slice(2);
          return "0x" + [
            addrWord(TOK), addrWord(CRV), addrWord(signer.address), addrWord(signer.address),
            addrWord("0x" + "00".repeat(20)), word0x(42n * 10n ** 17n), word0x(0n), word0x(200n),
            word0x(0n), word0x(0n), word0x(0n), word0x(0n), word0x(0n), word0x(0n), word0x(1n),
          ].map(w).join("");
        }
        if (t === CRV) {
          if (data.startsWith("0x" + SEL.token)) return addrWord(TOK);
          if (data.startsWith("0x" + SEL.isNativeQuote)) return word0x(1n);
          if (data.startsWith("0x" + SEL.pairToken)) return addrWord("0x" + "00".repeat(20));
          if (data.startsWith("0x" + SEL.graduated)) return word0x(0n);
          if (data.startsWith("0x" + SEL.readyToGraduate)) return word0x(0n);
          if (data.startsWith("0x" + SEL.getReserves)) return "0x" + word0x(10n ** 19n).slice(2) + word0x(10n ** 24n).slice(2);
          if (data.startsWith("0x" + SEL.reservedTokens)) return word0x(10n ** 23n);
          return word0x(0n);
        }
        if (t === TOK) {
          if (data.startsWith("0x" + SEL.name)) return stringReturn("Test");
          if (data.startsWith("0x" + SEL.decimals)) return word0x(BigInt(tokenDecimals));
          if (data.startsWith("0x" + SEL.symbol)) return stringReturn("TST");
        }
        throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
      },
    });
    return readCurveContext(client as unknown as RpcClient, CRV);
  };
  assert.equal((await variant(255, "dd")).tokenDecimals, 18, "absurd decimals clamp");
  assert.equal((await variant(36, "de")).tokenDecimals, 36, "36 is allowed");
  assert.equal((await variant(37, "df")).tokenDecimals, 18, "37 is clamped");
});

test("pons_sweep_curve_fees: minBuybackTokensOut semantics + pending-buyback warning", async () => {
  const { sweepCurveFeesTool } = await import("../src/trade.js");
  // No buyback pending: minOut 0 is fine, calldata carries the token-unit floor
  const c1 = makeCurveClient();
  const out1 = await sweepCurveFeesTool(c1 as unknown as RpcClient, signer, CURVE, "5", {});
  assert.equal(out1.mode, "dry-run");
  assert.ok(out1.steps[0].calldata.startsWith("0x" + SEL.sweepFees));
  assert.equal(wordUint(out1.steps[0].calldata.slice(2 + 8), 0), 5n * 10n ** 18n, "5 tokens, 18 decimals");
  assert.equal(out1.warning, undefined);

  // Buyback pending + minOut 0 → warning about MinimumOutputRequired
  const c2 = makeCurveClient({ buybackQuoteBalance: 10n ** 17n });
  const out2 = await sweepCurveFeesTool(c2 as unknown as RpcClient, signer, CURVE, "0", {});
  assert.ok(out2.warning?.includes("MinimumOutputRequired"));
});

test("ERC-20 buy with working slot discovery: a reverting buy simulation BLOCKS broadcast", async () => {
  // Slots discovered → simulation is faithful → dependsOnPrior must NOT waive
  // the gate. (Regression: previously the gate was waived unconditionally
  // when an approve step existed.)
  const base = makeCurveClient({ erc20Quote: true });
  const c = mockClient({
    ethCall: base.ethCallRaw,
    call: (method, params) => {
      if (method === "eth_call") {
        const p = params as [{ to?: string; data?: string }, ...unknown[]];
        // runWrite simulation: the buy call reverts, everything else succeeds
        if (p[0].to?.toLowerCase() === CURVE && p[0].data?.startsWith("0x" + SEL.buy)) {
          throw new RpcError("REVERTED", "execution reverted: SlippageExceeded");
        }
        if (p.length === 3) return word0x(10n ** 30n); // slot-discovery probes
        return "0x";
      }
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      if (method === "eth_getTransactionCount") return "0x7";
      throw new Error("unexpected " + method);
    },
  });
  const out = await buyTool(c as unknown as RpcClient, signer, CURVE, "1");
  const buyStep = out.steps[out.steps.length - 1];
  assert.equal(out.steps.length, 2, "approve + buy");
  assert.equal(buyStep.dependsOnPrior, undefined, "faithful simulation → no waiver");
  assert.equal(buyStep.simulation.ok, false);
  await assert.rejects(
    buyTool(c as unknown as RpcClient, signer, CURVE, "1", undefined, undefined, { dryRun: false, confirm: true }),
    /refusing to broadcast/,
  );
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

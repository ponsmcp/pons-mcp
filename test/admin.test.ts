import { test } from "node:test";
import assert from "node:assert/strict";
import { adminCallTool } from "../src/admin.js";
import { loadSigner } from "../src/signer.js";
import { mockClient, addrWord, wordAt, wordUint } from "./helpers.js";
import { SEL } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const OWNER = "0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd";

function makeClient() {
  return mockClient({
    ethCall: (_to, data) => {
      if (data.startsWith("0x" + SEL.owner)) return addrWord(OWNER);
      throw new Error("unexpected ethCall " + data.slice(0, 10));
    },
    call: (method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      throw new Error("unexpected " + method);
    },
  });
}

const run = (fn: never, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  adminCallTool(makeClient() as unknown as RpcClient, signer, fn, args, extra.iUnderstandIrreversible as boolean | undefined, {});

test("setLaunchFee encodes selector + 18-decimal amount", async () => {
  const out = await run("setLaunchFee" as never, { launchFee: "0.0005" });
  const step = out.steps[0];
  assert.ok(step.calldata.startsWith("0x" + SEL.setLaunchFee));
  assert.equal(wordUint(step.calldata.slice(2 + 8), 0), 500_000_000_000_000n);
  assert.equal(out.mode, "dry-run");
});

test("setPairTokenEconomics scales amounts by the token's decimals (6-dec regression)", async () => {
  const out = await run("setPairTokenEconomics" as never, {
    pairToken: "0x00000000000000000000000000000000000000aa",
    phantomQuote: "1.68",
    graduationThreshold: "4.2",
    decimals: 6,
  });
  const cd = out.steps[0].calldata.slice(2 + 8);
  assert.equal(wordUint(cd, 1), 1_680_000n); // 1.68 * 10^6
  assert.equal(wordUint(cd, 2), 4_200_000n); // 4.2 * 10^6
  assert.equal(wordUint(cd, 3), 6n);
});

test("addLaunchConfig: unsafe JSON numbers rejected (2^53+1)", async () => {
  await assert.rejects(
    run("addLaunchConfig" as never, {
      supply: 9007199254740993, // 2^53 + 1, not safe
      curveFeeBps: 100,
      phantomQuote: "1.68",
      graduationThreshold: "4.2",
      poolFee: 0,
      tickSpacing: 200,
      enabled: true,
    }),
    /2\^53/,
  );
});

test("addLaunchConfig: poolFee/tickSpacing range checks", async () => {
  const base = { supply: "1000000", curveFeeBps: 100, phantomQuote: "1.68", graduationThreshold: "4.2", poolFee: 0, tickSpacing: 200, enabled: true };
  await assert.rejects(run("addLaunchConfig" as never, { ...base, poolFee: 1 << 24 }), /uint24/);
  await assert.rejects(run("addLaunchConfig" as never, { ...base, tickSpacing: 1 << 23 }), /int24/);
  await assert.rejects(run("addLaunchConfig" as never, { ...base, tickSpacing: -(1 << 23) - 1 }), /int24/);
  // negative tickSpacing inside int24 is fine and encodes as two's complement
  const out = await run("addLaunchConfig" as never, { ...base, tickSpacing: -60 });
  const cd = out.steps[0].calldata.slice(2 + 8);
  assert.equal(wordAt(cd, 5), "f".repeat(62) + "c4"); // -60 = 0xff…fc4
});

test("decimals above 36 rejected (padEnd DoS guard)", async () => {
  await assert.rejects(
    run("setPairTokenEconomics" as never, {
      pairToken: "0x00000000000000000000000000000000000000aa",
      phantomQuote: "1",
      graduationThreshold: "1",
      decimals: 1_000_000_000,
    }),
    /0 and 36/,
  );
});

test("renounceOwnership requires iUnderstandIrreversible", async () => {
  await assert.rejects(run("renounceOwnership" as never, {}), /iUnderstandIrreversible/);
  const out = await run("renounceOwnership" as never, {}, { iUnderstandIrreversible: true });
  assert.equal(out.steps[0].calldata, "0x" + SEL.renounceOwnership);
});

test("setCreatorFeeRecipient (owner override) encodes token + newRecipient", async () => {
  const out = await run("setCreatorFeeRecipient" as never, {
    token: "0x" + "70".repeat(20),
    newRecipient: "0x00000000000000000000000000000000000000bb",
  });
  const cd = out.steps[0].calldata;
  assert.ok(cd.startsWith("0x" + "e102c9aa"), "setCreatorFeeRecipient(address,address)");
  const body = cd.slice(2 + 8);
  assert.equal(wordAt(body, 0).endsWith("70".repeat(20)), true);
  assert.equal(wordAt(body, 1).endsWith("00".repeat(10) + "bb"), true);
});

test("unknown fn rejected", async () => {
  await assert.rejects(run("notAFunction" as never, {}), /unknown admin fn/);
});

test("bad address rejected as INVALID_ADDRESS", async () => {
  await assert.rejects(
    run("transferOwnership" as never, { newOwner: "0x123" }),
    /20-byte hex address/,
  );
});

test("signer/owner mismatch is surfaced in the summary", async () => {
  const out = await run("setLaunchEnabled" as never, { enabled: true });
  assert.ok(out.summary.includes("MISMATCH"));
});

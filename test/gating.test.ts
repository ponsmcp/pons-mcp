import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { runWrite } from "../src/trade.js";
import { RpcError } from "../src/rpc.js";
import { loadSigner } from "../src/signer.js";
import { mockClient } from "./helpers.js";
import { encodeCall, encodeUint, SEL } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;

const FEE_HISTORY = { baseFeePerGas: ["0x10000000", "0x10000000"], reward: [["0x100000"]] };

interface MockBehavior {
  simulateReverts?: boolean;
  wrongHash?: boolean;
  status0?: boolean;
}

function makeClient(b: MockBehavior = {}) {
  return mockClient({
    call: (method, params) => {
      switch (method) {
        case "eth_call":
          if (b.simulateReverts) throw new RpcError("REVERTED", "execution reverted: boom");
          return "0x";
        case "eth_estimateGas":
          return "0x10000";
        case "eth_feeHistory":
          return FEE_HISTORY;
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_sendRawTransaction": {
          const rawTx = (params as string[])[0];
          const good = "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
          return b.wrongHash ? "0x" + "00".repeat(32) : good;
        }
        case "eth_getTransactionReceipt":
          return {
            transactionHash: "0x" + Buffer.from(keccak256OfLastSend(params)).toString("hex"),
            blockNumber: "0x123",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x10000000",
            status: b.status0 ? "0x0" : "0x1",
            logs: [],
          };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  });
}

// receipt lookups come back keyed by the hash the client was given; echo it
function keccak256OfLastSend(params: unknown[]): Uint8Array {
  return Buffer.from((params as string[])[0].slice(2), "hex");
}

const plan = {
  summary: "test plan",
  steps: [
    {
      label: "noop",
      to: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
      data: encodeCall(SEL.launchEnabled),
      value: 0n,
    },
  ],
  details: {},
};

test("default opts → dry-run, nothing broadcast", async () => {
  const c = makeClient();
  const out = await runWrite(c as unknown as RpcClient, signer, plan, {});
  assert.equal(out.mode, "dry-run");
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
  assert.ok(c.calls.some((x) => x.method === "eth_call"), "simulation ran");
  assert.ok(c.calls.some((x) => x.method === "eth_estimateGas"));
});

test("only dryRun=false → still dry-run; only confirm=true → still dry-run", async () => {
  for (const opts of [{ dryRun: false }, { confirm: true }, { dryRun: true, confirm: true }] as const) {
    const c = makeClient();
    const out = await runWrite(c as unknown as RpcClient, signer, plan, opts);
    assert.equal(out.mode, "dry-run", JSON.stringify(opts));
    assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
  }
});

test("dryRun=false AND confirm=true broadcasts; receipt verified", async () => {
  const c = makeClient();
  const out = await runWrite(c as unknown as RpcClient, signer, plan, { dryRun: false, confirm: true });
  assert.equal(out.mode, "broadcast");
  assert.equal(out.receipts.length, 1);
  const rawSent = (c.calls.find((x) => x.method === "eth_sendRawTransaction")!.params as string[])[0];
  assert.equal(out.receipts[0].hash, "0x" + Buffer.from(keccak_256(Buffer.from(rawSent.slice(2), "hex"))).toString("hex"));
});

test("reverted simulation refuses to broadcast", async () => {
  const c = makeClient({ simulateReverts: true });
  await assert.rejects(
    runWrite(c as unknown as RpcClient, signer, plan, { dryRun: false, confirm: true }),
    /refusing to broadcast/,
  );
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("dependsOnPrior steps may fail simulation without blocking broadcast", async () => {
  // Second step's simulation reverts (needs the first step mined), but it is
  // marked dependsOnPrior, so broadcast proceeds.
  let n = 0;
  const c2 = mockClient({
    call: (method, params) => {
      if (method === "eth_call") {
        n++;
        if (n === 2) throw new RpcError("REVERTED", "execution reverted: dependent");
        return "0x";
      }
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return FEE_HISTORY;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_sendRawTransaction") {
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        const h = (params as string[])[0];
        return { transactionHash: h, blockNumber: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", status: "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
  const twoStep = {
    summary: "two steps",
    steps: [
      { label: "approve", to: plan.steps[0].to, data: encodeCall(SEL.approve, encodeUint(1n), encodeUint(2n)), value: 0n },
      { label: "dependent", to: plan.steps[0].to, data: plan.steps[0].data, value: 0n, dependsOnPrior: true },
    ],
    details: {},
  };
  const out = await runWrite(c2 as unknown as RpcClient, signer, twoStep, { dryRun: false, confirm: true });
  assert.equal(out.mode, "broadcast");
  assert.equal(out.receipts.length, 2);
});

test("mismatched tx hash from endpoint → RPC_FAILURE, no receipt trust", async () => {
  const c = makeClient({ wrongHash: true });
  await assert.rejects(
    runWrite(c as unknown as RpcClient, signer, plan, { dryRun: false, confirm: true }),
    /does not match the signed transaction/,
  );
});

test("status-0 receipt → REVERTED", async () => {
  const c = makeClient({ status0: true });
  await assert.rejects(
    runWrite(c as unknown as RpcClient, signer, plan, { dryRun: false, confirm: true }),
    (e: Error) => (e as RpcError).code === "REVERTED",
  );
});

test("receipt for a different transaction → RPC_FAILURE", async () => {
  const c = mockClient({
    call: (method, params) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return FEE_HISTORY;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_sendRawTransaction") {
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        return { transactionHash: "0x" + "00".repeat(32), blockNumber: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", status: "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
  await assert.rejects(
    runWrite(c as unknown as RpcClient, signer, plan, { dryRun: false, confirm: true }),
    /receipt hash mismatch/,
  );
});

test("fee ceiling: implausible endpoint fees refuse to build", async () => {
  const c = mockClient({
    call: (method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x" + (100n * 10n ** 9n).toString(16)], reward: [["0x1"]] };
      throw new Error("unexpected " + method);
    },
  });
  await assert.rejects(runWrite(c as unknown as RpcClient, signer, plan, {}), /implausible fee/);
});

test("a failed later step reports the earlier mined steps' hashes", async () => {
  let sendCount = 0;
  const c = mockClient({
    call: (method, params) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x10000";
      if (method === "eth_feeHistory") return FEE_HISTORY;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_sendRawTransaction") {
        sendCount++;
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        const h = (params as string[])[0];
        // second step reverts on-chain
        return { transactionHash: h, blockNumber: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", status: sendCount >= 2 ? "0x0" : "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
  const twoStep = {
    summary: "two steps",
    steps: [
      { label: "approve", to: plan.steps[0].to, data: encodeCall(SEL.approve, encodeUint(1n), encodeUint(2n)), value: 0n },
      { label: "trade", to: plan.steps[0].to, data: plan.steps[0].data, value: 0n, dependsOnPrior: true },
    ],
    details: {},
  };
  await assert.rejects(
    runWrite(c as unknown as RpcClient, signer, twoStep, { dryRun: false, confirm: true }),
    (e: Error) => (e as { code?: string }).code === "REVERTED" && /earlier steps already broadcast/.test(e.message) && /approve mined: 0x[0-9a-f]{64}/.test(e.message),
  );
});

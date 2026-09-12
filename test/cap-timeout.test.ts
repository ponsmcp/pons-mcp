// Cap-slot accounting for post-broadcast failures — own file because the cap
// state is module-global (fresh process per test file). Date.now is patched to
// fast-forward sendAndWait's 30s receipt polling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { launchToken, capsFromEnv } from "../src/launch.js";
import { LAUNCH_AND_BUY_ROUTER } from "../src/pons.js";
import { loadSigner } from "../src/signer.js";
import { mockClient, addrWord, word0x } from "./helpers.js";
import { SEL } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;

const launchConfigWords = [
  word0x(10n ** 27n), word0x(100n), word0x(168n * 10n ** 16n), word0x(42n * 10n ** 17n),
  word0x(0n), word0x(200n), word0x(1n),
].map((w) => w.slice(2)).join("");

function makeClient(opts: { neverMined?: boolean } = {}) {
  return mockClient({
    ethCall: (_to, data) => {
      if (data.startsWith("0x" + SEL.launchFee)) return word0x(5n * 10n ** 14n);
      if (data.startsWith("0x" + SEL.launchEnabled)) return word0x(1n);
      if (data.startsWith("0x" + SEL.canLaunch)) return word0x(1n);
      if (data.startsWith("0x" + SEL.maxCreatorTaxBps)) return word0x(1000n);
      if (data.startsWith("0x" + SEL.getLaunchConfig)) return "0x" + launchConfigWords;
      if (data.startsWith("0x" + SEL.previewLaunchEconomics)) return "0x" + "ab".repeat(32);
      if (data.startsWith("0x" + SEL.launchForwarder)) return addrWord(LAUNCH_AND_BUY_ROUTER);
      return "0x";
    },
    call: (method, params) => {
      if (method === "eth_call") return "0x" + addrWord("0x" + "42".repeat(20)).slice(2) + addrWord("0x" + "43".repeat(20)).slice(2);
      if (method === "eth_estimateGas") return "0x3ade68";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_sendRawTransaction") {
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        if (opts.neverMined) return null; // stays in the mempool
        const h = (params as string[])[0];
        return { transactionHash: h, blockNumber: "0x1", gasUsed: "0x100", effectiveGasPrice: "0x1", status: "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
}

const caps = capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "2" });
const inputs = (n: string) => ({ name: n, symbol: n.toUpperCase(), dryRun: false as const, confirm: true as const });

test("a broadcast-but-unmined launch KEEPS its cap slot (it may still mine)", async () => {
  // Fast-forward the clock so sendAndWait's 30s deadline passes immediately.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    await assert.rejects(
      launchToken(makeClient({ neverMined: true }) as unknown as RpcClient, signer, inputs("alpha"), caps),
      /not mined within 30s/,
    );
  } finally {
    Date.now = realNow;
  }
  // The failed-but-broadcast launch consumed a slot: only one more is allowed.
  const b = await launchToken(makeClient() as unknown as RpcClient, signer, inputs("bravo"), caps);
  assert.equal(b.dailyCap.used, 2, "the timed-out broadcast still counts against the cap");
  await assert.rejects(
    launchToken(makeClient() as unknown as RpcClient, signer, inputs("charlie"), caps),
    (e: Error) => (e as { code?: string }).code === "CAP_EXCEEDED",
  );
});

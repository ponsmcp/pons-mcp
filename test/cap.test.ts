// Daily-cap reservation/rollback tests — separate file because the cap state
// is module-global in src/launch.ts and each test file runs in its own process.
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

function makeClient(opts: { crazyFees?: boolean } = {}) {
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
      if (method === "eth_feeHistory") {
        if (opts.crazyFees) return { baseFeePerGas: ["0x" + (100n * 10n ** 9n).toString(16)], reward: [["0x1"]] };
        return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      }
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_sendRawTransaction") {
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        const h = (params as string[])[0];
        return { transactionHash: h, blockNumber: "0x1", gasUsed: "0x100", effectiveGasPrice: "0x1", status: "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
}

const inputs = (n: string) => ({ name: n, symbol: n.toUpperCase(), dryRun: false as const, confirm: true as const });
const caps = capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "2" });

test("PRE-broadcast failure releases its own cap slot (splice by identity, not pop)", async () => {
  // Launch A fails during preparation (implausible fee market — before any
  // signing or send); its slot must be freed for launch B.
  await assert.rejects(
    launchToken(makeClient({ crazyFees: true }) as unknown as RpcClient, signer, inputs("alpha"), caps),
    /implausible fee/,
  );
  // B and C both succeed — exactly filling the cap of 2 (A's slot was released)
  const b = await launchToken(makeClient() as unknown as RpcClient, signer, inputs("bravo"), caps);
  assert.equal(b.dailyCap.used, 1);
  const c = await launchToken(makeClient() as unknown as RpcClient, signer, inputs("charlie"), caps);
  assert.equal(c.dailyCap.used, 2);
  // D exceeds the cap
  await assert.rejects(
    launchToken(makeClient() as unknown as RpcClient, signer, inputs("delta"), caps),
    (e: Error) => (e as { code?: string }).code === "CAP_EXCEEDED",
  );
});

test("cap is enforced before any signing", async () => {
  const c = makeClient();
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, inputs("echo"), caps),
    (e: Error) => (e as { code?: string }).code === "CAP_EXCEEDED",
  );
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

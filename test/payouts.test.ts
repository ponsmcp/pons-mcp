import { test } from "node:test";
import assert from "node:assert/strict";
import { feeBalances, claimFeesTool, releaseBuybackTool } from "../src/payouts.js";
import { FEE_ESCROW, BUYBACK_VAULT, FACTORY } from "../src/pons.js";
import { loadSigner } from "../src/signer.js";
import { mockClient, addrWord, word0x, wordUint } from "./helpers.js";
import { SEL, encodeString, encodeUint } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const ADDR1 = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TOKEN = "0x" + "70".repeat(20);

const stringReturn = (s: string) => "0x" + encodeUint(32) + encodeString(s);

function makePayoutClient(opts: { escrowEth?: bigint; escrowToken?: bigint; releasable?: bigint; registered?: boolean } = {}) {
  const escrowEth = opts.escrowEth ?? 0n;
  const escrowToken = opts.escrowToken ?? 0n;
  const releasable = opts.releasable ?? 0n;
  return mockClient({
    ethCall: (to, data) => {
      const t = to.toLowerCase();
      if (t === FEE_ESCROW) {
        if (data.startsWith("0x" + SEL.balanceOf)) return word0x(escrowEth);
        if (data.startsWith("0x" + SEL.balanceOfToken)) return word0x(escrowToken);
      }
      if (t === BUYBACK_VAULT) {
        if (data.startsWith("0x" + SEL.vaultTotalLocked)) return word0x(10n ** 24n);
        if (data.startsWith("0x" + SEL.vaultTotalReleased)) return word0x(0n);
        if (data.startsWith("0x" + SEL.vaultVestedAmount)) return word0x(releasable * 2n);
        if (data.startsWith("0x" + SEL.vaultReleasable)) return word0x(releasable);
        if (data.startsWith("0x" + SEL.vaultVestingTerms)) {
          return "0x" + [addrWord(ADDR1), addrWord("0x" + "26".repeat(20)), word0x(3000n)].map((w) => w.slice(2)).join("");
        }
      }
      if (t === FACTORY.toLowerCase() && data.startsWith("0x" + SEL.getLaunchedToken)) {
        const w = (x: string) => x.slice(2);
        return "0x" + [
          addrWord(TOKEN), addrWord("0x" + "c1".repeat(20)), addrWord(ADDR1), addrWord(ADDR1),
          addrWord("0x" + "00".repeat(20)), word0x(42n * 10n ** 17n), word0x(0n), word0x(200n),
          word0x(0n), word0x(0n), word0x(0n), word0x(0n), word0x(0n), word0x(0n),
          word0x(opts.registered === false ? 0n : 1n),
        ].map(w).join("");
      }
      if (t === TOKEN) {
        if (data.startsWith("0x" + SEL.name)) return stringReturn("Test Token");
        if (data.startsWith("0x" + SEL.decimals)) return word0x(18n);
        if (data.startsWith("0x" + SEL.symbol)) return stringReturn("TST");
      }
      throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
    },
    call: (method) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x8000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      throw new Error("unexpected " + method);
    },
  });
}

test("feeBalances: native-only and with token (escrow + vault)", async () => {
  const out = await feeBalances(makePayoutClient({ escrowEth: 10n ** 16n, escrowToken: 5n * 10n ** 20n, releasable: 10n ** 21n }) as unknown as RpcClient, ADDR1, TOKEN);
  assert.equal(out.claimableEth, (10n ** 16n).toString());
  assert.equal(out.claimableEthFormatted, "0.01 ETH");
  const token = out.token as { claimableTokens: string; symbol: string };
  assert.equal(token.claimableTokens, (5n * 10n ** 20n).toString());
  assert.equal(token.symbol, "TST");
  const vault = out.buybackVault as { releasable: string; vestingTerms: { queriedAddressIsBeneficiary: boolean; protocolFeeShareBps: number } };
  assert.equal(vault.releasable, (10n ** 21n).toString());
  assert.equal(vault.vestingTerms.queriedAddressIsBeneficiary, true, "queried address is the creator recipient");
  assert.equal(vault.vestingTerms.protocolFeeShareBps, 3000);
});

test("claimFees: native all / partial, token all / partial, correct selectors", async () => {
  const c = makePayoutClient({ escrowEth: 10n ** 16n, escrowToken: 10n ** 21n }) as unknown as RpcClient;
  const allEth = await claimFeesTool(c, signer, undefined, undefined, {});
  assert.equal(allEth.steps[0].calldata, "0x" + SEL.escrowClaimAll);
  assert.equal(allEth.steps[0].to, FEE_ESCROW);

  const partEth = await claimFeesTool(c, signer, undefined, "0.004", {});
  assert.equal(partEth.steps[0].calldata, "0x" + SEL.escrowClaim + (4n * 10n ** 15n).toString(16).padStart(64, "0"));

  const allTok = await claimFeesTool(c, signer, TOKEN, undefined, {});
  assert.equal(allTok.steps[0].calldata, "0x" + SEL.escrowClaimTokenAll + TOKEN.slice(2).padStart(64, "0"));

  const partTok = await claimFeesTool(c, signer, TOKEN, "500", {});
  assert.equal(wordUint(partTok.steps[0].calldata.slice(2 + 8), 1), 500n * 10n ** 18n);
  assert.ok(partTok.steps[0].calldata.startsWith("0x" + SEL.escrowClaimToken));
});

test("claimFees rejects zero balance and over-claim before any broadcast", async () => {
  const empty = makePayoutClient({}) as unknown as RpcClient;
  await assert.rejects(claimFeesTool(empty, signer, undefined, undefined, {}), /NoBalance/);
  await assert.rejects(claimFeesTool(empty, signer, TOKEN, undefined, {}), /no claimable balance/);
  const funded = makePayoutClient({ escrowEth: 10n ** 16n }) as unknown as RpcClient;
  await assert.rejects(claimFeesTool(funded, signer, undefined, "0.02", {}), /exceeds claimable/);
});

test("releaseBuyback: encodes release(token), surfaces beneficiary status", async () => {
  const c = makePayoutClient({ releasable: 10n ** 21n }) as unknown as RpcClient;
  const out = await releaseBuybackTool(c, signer, TOKEN, {});
  assert.equal(out.steps[0].to, BUYBACK_VAULT);
  assert.equal(out.steps[0].calldata, "0x" + SEL.vaultRelease + TOKEN.slice(2).padStart(64, "0"));
  assert.equal(out.signerIsBeneficiary, true);
  assert.ok(!(out.note as string).includes("WARNING"));
});

test("releaseBuyback: unregistered token → NOT_A_LAUNCH", async () => {
  const c = makePayoutClient({ registered: false }) as unknown as RpcClient;
  await assert.rejects(releaseBuybackTool(c, signer, TOKEN, {}), (e: Error) => (e as { code?: string }).code === "NOT_A_LAUNCH");
});

test("claimFees rejects a zero partial amount (on-chain NoBalance)", async () => {
  const c = makePayoutClient({ escrowEth: 10n ** 16n, escrowToken: 10n ** 21n }) as unknown as RpcClient;
  await assert.rejects(claimFeesTool(c, signer, undefined, "0", {}), /must be positive/);
  await assert.rejects(claimFeesTool(c, signer, undefined, "0.00", {}), /must be positive/);
  await assert.rejects(claimFeesTool(c, signer, TOKEN, "0", {}), /must be positive/);
});

test("releaseBuyback refuses early: non-beneficiary and nothing-vested", async () => {
  // nothing vested
  const c1 = makePayoutClient({ releasable: 0n }) as unknown as RpcClient;
  await assert.rejects(releaseBuybackTool(c1, signer, TOKEN, {}), /nothing vested/);
  // not a beneficiary: make the terms point at other addresses — reuse client
  // but override vestingTerms via a custom mock
  const c2 = mockClient({
    ethCall: (to, data) => {
      const t = to.toLowerCase();
      if (t === FACTORY.toLowerCase()) return makePayoutClient({}).ethCallRaw!(to, data);
      if (t === BUYBACK_VAULT) {
        if (data.startsWith("0x" + SEL.vaultVestingTerms)) {
          return "0x" + [addrWord("0x" + "aa".repeat(20)), addrWord("0x" + "bb".repeat(20)), word0x(3000n)].map((w) => w.slice(2)).join("");
        }
        return makePayoutClient({ releasable: 10n ** 21n }).ethCallRaw!(to, data);
      }
      return makePayoutClient({}).ethCallRaw!(to, data);
    },
  }) as unknown as RpcClient;
  await assert.rejects(releaseBuybackTool(c2, signer, TOKEN, {}), /NotVestBeneficiary/);
});

test("feeBalances: registered is null (unknown) when the factory lookup fails", async () => {
  const base = makePayoutClient({});
  const c = mockClient({
    ethCall: (to, data) => {
      if (data.startsWith("0x" + SEL.getLaunchedToken)) throw new Error("node unavailable");
      return base.ethCallRaw!(to, data);
    },
  }) as unknown as RpcClient;
  const out = await feeBalances(c, ADDR1, TOKEN);
  assert.equal((out.buybackVault as { registered: unknown }).registered, null);
});

test("claimFees explicitly defaults to dry-run and never broadcasts without both flags", async () => {
  const c = makePayoutClient({ escrowEth: 10n ** 16n });
  const out = await claimFeesTool(c as unknown as RpcClient, signer, undefined, undefined, { dryRun: false });
  assert.equal(out.mode, "dry-run", "dryRun=false alone must not broadcast");
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("claimFees broadcast hits the escrow with claim()", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3");
  const base = makePayoutClient({ escrowEth: 10n ** 16n });
  const c = mockClient({
    ethCall: base.ethCallRaw,
    call: (method, params) => {
      if (method === "eth_call") return "0x";
      if (method === "eth_estimateGas") return "0x8000";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      if (method === "eth_getTransactionCount") return "0x0";
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
  const out = await claimFeesTool(c as unknown as RpcClient, signer, undefined, undefined, { dryRun: false, confirm: true });
  assert.equal(out.mode, "broadcast");
  assert.equal(out.receipts[0].status, "success");
});

test("feeBalances native-only: no token/vault keys when tokenAddress omitted", async () => {
  const out = await feeBalances(makePayoutClient({ escrowEth: 10n ** 16n }) as unknown as RpcClient, ADDR1);
  assert.equal(out.claimableEth, (10n ** 16n).toString());
  assert.equal(out.token, undefined);
  assert.equal(out.buybackVault, undefined);
});

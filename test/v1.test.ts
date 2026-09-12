import { test } from "node:test";
import assert from "node:assert/strict";
import { v1GetToken, v1Launches } from "../src/v1.js";
import { V1_FACTORY } from "../src/pons.js";
import { mockClient, addrWord, word0x } from "./helpers.js";
import { SEL, TOPIC, encodeString, encodeUint } from "../src/abi.js";
import type { RpcClient, RpcLog } from "../src/rpc.js";

const PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571";
const DEPLOYER = "0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0";
const PAIRED = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POSMGR = "0x73991a25c818bf1f1128deaab1492d45638de0d3";

// Real values read from chain 4663 (PONS token, 2026-09): positionId 109216,
// restrictionsEndBlock 25526532, supply 1e27, isToken0 false, poolFee 10000,
// exists true, initialBuyAmount 0.1 ETH.
function launchWords(exists: boolean): string {
  return "0x" + [
    addrWord(PONS), addrWord(DEPLOYER), addrWord(PAIRED), addrWord(POSMGR),
    word0x(109216n), word0x(0n), word0x(0n), word0x(25526532n),
    word0x(10n ** 27n), word0x(0n), word0x(10000n), word0x(exists ? 1n : 0n),
    word0x(10n ** 17n),
  ].map((w) => w.slice(2)).join("");
}

// getTokenInfo(): (address, string logo, string description, (5 strings))
function tokenInfoReturn(): string {
  const head = (s: string) => s; // offsets computed below
  const logo = encodeString("ipfs://logo.png");
  const desc = encodeString("The token.");
  const socialBlobs = ["tw", "tg", "dc", "web", "fc"].map(encodeString);
  // head: address | off(logo) | off(desc) | off(socials)
  const headWords = 4 * 32;
  const socialsStart = headWords + logo.length / 2 + desc.length / 2;
  let socialsHead = "";
  let socialsTail = "";
  let off = 5 * 32;
  for (const b of socialBlobs) {
    socialsHead += encodeUint(off);
    socialsTail += b;
    off += b.length / 2;
  }
  return "0x" +
    addrWord(DEPLOYER).slice(2) +
    encodeUint(headWords) +
    encodeUint(headWords + logo.length / 2) +
    encodeUint(socialsStart) +
    logo + desc + socialsHead + socialsTail;
  void head;
}

function makeV1Client(opts: { exists?: boolean } = {}) {
  return mockClient({
    ethCall: (to, data) => {
      const t = to.toLowerCase();
      if (t === V1_FACTORY.toLowerCase()) {
        if (data.startsWith("0x" + SEL.getLaunchedToken)) return launchWords(opts.exists !== false);
        if (data.startsWith("0x" + SEL.v1GraduationStatus)) {
          return "0x" + [word0x(622123145362126224433n), word0x(42n * 10n ** 17n), word0x(1n)].map((w) => w.slice(2)).join("");
        }
      }
      if (t === PONS) {
        if (data.startsWith("0x" + SEL.v1GetTokenInfo)) return tokenInfoReturn();
        if (data.startsWith("0x" + SEL.name)) return "0x" + encodeUint(32) + encodeString("Pons");
        if (data.startsWith("0x" + SEL.symbol)) return "0x" + encodeUint(32) + encodeString("PONS");
        if (data.startsWith("0x" + SEL.decimals)) return word0x(18n);
        if (data.startsWith("0x" + SEL.totalSupply)) return word0x(10n ** 27n);
      }
      if (t === PAIRED) {
        if (data.startsWith("0x" + SEL.name)) return "0x" + encodeUint(32) + encodeString("Wrapped ETH");
        if (data.startsWith("0x" + SEL.symbol)) return "0x" + encodeUint(32) + encodeString("WETH");
        if (data.startsWith("0x" + SEL.decimals)) return word0x(18n);
      }
      throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
    },
  });
}

test("v1GetToken decodes the 13-word record, graduation status, and metadata", async () => {
  const out = await v1GetToken(makeV1Client() as unknown as RpcClient, PONS);
  assert.equal(out.generation.includes("v1"), true);
  assert.equal(out.launch.deployer, DEPLOYER);
  assert.equal(out.launch.pairedToken, PAIRED);
  assert.equal(out.launch.pairedTokenSymbol, "WETH");
  assert.equal(out.launch.positionId, "109216");
  assert.equal(out.launch.poolFeePct, "1%");
  assert.equal(out.launch.initialBuyFormatted, "0.1 WETH", "pair token is 18-decimal WETH");
  assert.equal(out.graduation.graduated, true);
  assert.equal(out.graduation.progress, "100%", "over-threshold progress clamps to 100%");
  assert.equal(out.token.symbol, "PONS");
  assert.equal(out.metadata?.logo, "ipfs://logo.png");
  assert.deepEqual(out.metadata?.socials, { twitter: "tw", telegram: "tg", discord: "dc", website: "web", farcaster: "fc" });
});

test("v1GetToken rejects tokens unknown to the legacy factory", async () => {
  await assert.rejects(
    v1GetToken(makeV1Client({ exists: false }) as unknown as RpcClient, PONS),
    (e: Error) => (e as { code?: string }).code === "NOT_A_LAUNCH",
  );
});

test("v1Launches decodes the legacy TokenLaunched layout", async () => {
  const dataWord = (v: bigint) => v.toString(16).padStart(64, "0");
  const addrDataWord = (a: string) => "0".repeat(24) + a.slice(2);
  const log: RpcLog = {
    address: V1_FACTORY.toLowerCase(),
    topics: ["0x" + TOPIC.V1TokenLaunched, addrWord(PONS), addrWord(DEPLOYER), addrWord(POSMGR)],
    data: "0x" + [
      addrDataWord(PAIRED), addrDataWord("0x" + "42".repeat(20)),
      dataWord(0n), dataWord(3n), dataWord(109216n), dataWord(25526532n), dataWord(10n ** 17n),
    ].join(""),
    blockNumber: "0x88a4ae",
    transactionHash: "0x" + "ab".repeat(32),
    logIndex: "0x0",
  };
  const c = {
    async assertChain() {},
    async scanLogs() {
      return { logs: [log], latestBlock: 9_000_000n, fromBlock: 8_950_000n, scannedFromBlock: 8_950_000n, complete: true };
    },
  };
  const out = await v1Launches(c as unknown as RpcClient, {});
  assert.equal(out.count, 1);
  const l = out.launches[0];
  assert.equal(l.token, PONS);
  assert.equal(l.deployer, DEPLOYER);
  assert.equal(l.dexFactory, POSMGR);
  assert.equal(l.pairToken, PAIRED);
  assert.equal(l.pool, "0x" + "42".repeat(20));
  assert.equal(l.positionId, "109216");
  assert.equal(l.initialBuyAmount, (10n ** 17n).toString());
  assert.equal(l.launchConfigId, 3);
});

test("v1Launches supports absolute block ranges (V1 history is unreachable by lookback)", async () => {
  const dataWord = (v: bigint) => v.toString(16).padStart(64, "0");
  const log: RpcLog = {
    address: V1_FACTORY.toLowerCase(),
    topics: ["0x" + TOPIC.V1TokenLaunched, addrWord(PONS), addrWord(DEPLOYER), addrWord(POSMGR)],
    data: "0x" + ["0".repeat(24) + PAIRED.slice(2), "0".repeat(24) + "42".repeat(20),
      dataWord(0n), dataWord(0n), dataWord(109216n), dataWord(25526532n), dataWord(10n ** 17n)].join(""),
    blockNumber: "0x" + (8963150).toString(16),
    transactionHash: "0x" + "cd".repeat(32),
    logIndex: "0x0",
  };
  const ranges: [bigint, bigint][] = [];
  const c = {
    async assertChain() {},
    async blockNumber() { return 57_000_000n; },
    async getLogs(_f: unknown, from: bigint, to: bigint) {
      ranges.push([from, to]);
      return from <= 8963150n && to >= 8963150n ? [log] : [];
    },
  };
  const out = await v1Launches(c as unknown as RpcClient, { fromBlock: 8_960_000, toBlock: 8_970_000, limit: 5 });
  assert.equal(out.count, 1);
  assert.equal(out.launches[0].token, PONS);
  assert.equal(out.scannedFromBlock, 8_960_000);
  assert.equal(out.scannedToBlock, 8_970_000);
  assert.deepEqual(ranges, [[8_960_001n, 8_970_000n], [8_960_000n, 8_960_000n]], "newest chunk first");
});

test("absolute-range scan: exact-limit stop does NOT falsely report scanComplete (regression)", async () => {
  // Range 0..25000 (3 chunks), 2 logs in the newest chunk, limit 2 → scan
  // stops early; blocks 0..9999 were never queried.
  const dataWord = (v: bigint) => v.toString(16).padStart(64, "0");
  const mkLog = (block: number): RpcLog => ({
    address: V1_FACTORY.toLowerCase(),
    topics: ["0x" + TOPIC.V1TokenLaunched, addrWord(PONS), addrWord(DEPLOYER), addrWord(POSMGR)],
    data: "0x" + ["0".repeat(24) + PAIRED.slice(2), "0".repeat(24) + "42".repeat(20),
      dataWord(0n), dataWord(0n), dataWord(109216n), dataWord(0n), dataWord(10n ** 17n)].join(""),
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + "cd".repeat(32),
    logIndex: "0x0",
  });
  const queried: [bigint, bigint][] = [];
  const c = {
    async assertChain() {},
    async getLogs(_f: unknown, from: bigint, to: bigint) {
      queried.push([from, to]);
      return to === 25_000n ? [mkLog(24_000), mkLog(23_000)] : [];
    },
  };
  const out = await v1Launches(c as unknown as RpcClient, { fromBlock: 0, toBlock: 25_000, limit: 2 });
  assert.equal(out.count, 2);
  assert.equal(out.scanComplete, false, "limit reached before covering the range");
  assert.equal(out.scannedFromBlock, 15_001, "oldest actually-queried block, not the requested from");
  assert.deepEqual(queried, [[15_001n, 25_000n]], "stopped after the first chunk");
});

test("absolute-range scan: fully covered range reports complete even when logs exceed limit", async () => {
  const c = {
    async assertChain() {},
    async getLogs() { return []; },
  };
  const out = await v1Launches(c as unknown as RpcClient, { fromBlock: 100, toBlock: 199, limit: 5 });
  assert.equal(out.scanComplete, true);
  assert.equal(out.scannedFromBlock, 100);
});

test("absolute-range scan: >500k block range is rejected with chunking guidance", async () => {
  const c = { async assertChain() {}, async blockNumber() { return 60_000_000n; } };
  await assert.rejects(
    v1Launches(c as unknown as RpcClient, { fromBlock: 0 }),
    /500,000-block cap/,
  );
});

test("v1GetToken: malformed getTokenInfo degrades visibly (metadataError), never SyntaxError", async () => {
  const base = makeV1Client();
  const c = mockClient({
    ethCall: (to, data) => {
      if (data.startsWith("0x" + SEL.v1GetTokenInfo)) return "0x" + "00".repeat(64); // garbage offsets
      return base.ethCallRaw!(to, data);
    },
  });
  const out = await v1GetToken(c as unknown as RpcClient, PONS);
  assert.equal(out.metadata, null);
  assert.ok(out.metadataError, "degradation must be visible");
});

test("v1GetToken: getTokenInfo RPC failure surfaces as metadataError", async () => {
  const base = makeV1Client();
  const c = mockClient({
    ethCall: (to, data) => {
      if (data.startsWith("0x" + SEL.v1GetTokenInfo)) throw new Error("node down");
      return base.ethCallRaw!(to, data);
    },
  });
  const out = await v1GetToken(c as unknown as RpcClient, PONS);
  assert.equal(out.metadata, null);
  assert.ok(out.metadataError?.includes("failed"));
});

test("absolute-range scan: full coverage with more logs than limit still reports complete", async () => {
  const mkLog = (block: number): RpcLog => ({
    address: V1_FACTORY.toLowerCase(),
    topics: ["0x" + TOPIC.V1TokenLaunched, addrWord(PONS), addrWord(DEPLOYER), addrWord(POSMGR)],
    data: "0x" + ["0".repeat(24) + PAIRED.slice(2), "0".repeat(24) + "42".repeat(20),
      (0n).toString(16).padStart(64, "0"), (0n).toString(16).padStart(64, "0"), (109216n).toString(16).padStart(64, "0"),
      (0n).toString(16).padStart(64, "0"), (10n ** 17n).toString(16).padStart(64, "0")].join(""),
    blockNumber: "0x" + block.toString(16),
    transactionHash: "0x" + "cd".repeat(32),
    logIndex: "0x0",
  });
  const c = {
    async assertChain() {},
    async getLogs() { return [mkLog(150), mkLog(120), mkLog(110)]; },
  };
  const out = await v1Launches(c as unknown as RpcClient, { fromBlock: 100, toBlock: 199, limit: 2 });
  assert.equal(out.scanComplete, true, "range fully covered even though logs exceeded limit");
  assert.equal(out.count, 2);
  assert.equal(out.launches[0].blockNumber, 150, "newest first");
});

test("absolute-range boundaries: exactly 500k blocks allowed, 500001 rejected, from>to rejected", async () => {
  const c = { async assertChain() {}, async blockNumber() { return 60_000_000n; }, async getLogs() { return []; } };
  const ok = await v1Launches(c as unknown as RpcClient, { fromBlock: 0, toBlock: 499_999, limit: 5 });
  assert.equal(ok.count, 0);
  await assert.rejects(v1Launches(c as unknown as RpcClient, { fromBlock: 0, toBlock: 500_000 }), /500,000-block cap/);
  await assert.rejects(v1Launches(c as unknown as RpcClient, { fromBlock: 100, toBlock: 99 }), /invalid block range/);
});

test("v1Launches pushes the deployer filter into topics[2]", async () => {
  let seenTopics: unknown;
  const c = {
    async assertChain() {},
    async scanLogs(filter: { topics: unknown }) {
      seenTopics = filter.topics;
      return { logs: [], latestBlock: 100n, fromBlock: 50n, scannedFromBlock: 50n, complete: true };
    },
  };
  await v1Launches(c as unknown as RpcClient, { deployer: DEPLOYER });
  assert.deepEqual(seenTopics, [
    "0x" + TOPIC.V1TokenLaunched,
    null,
    "0x" + "0".repeat(24) + DEPLOYER.slice(2),
    null,
  ]);
});

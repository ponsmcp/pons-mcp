import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RpcClient, RpcError, type RpcLog } from "../src/rpc.js";

// ---------- fetch mock ----------

type FetchHandler = (url: string, body: { method: string; params: unknown[] }) => { status: number; result?: unknown; error?: { code: number; message: string } } | never;

let fetchCalls: { url: string; method: string }[] = [];
let handler: FetchHandler = () => ({ status: 200, result: "0x0" });
const realFetch = globalThis.fetch;

function installFetch(h: FetchHandler) {
  handler = h;
  fetchCalls = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    const body = JSON.parse(init?.body ?? "{}");
    fetchCalls.push({ url, method: body.method });
    const res = handler(url, body);
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      statusText: "S",
      json: async () => (res.error ? { jsonrpc: "2.0", id: 1, error: res.error } : { jsonrpc: "2.0", id: 1, result: res.result }),
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => installFetch(() => ({ status: 200, result: "0x0" })));
afterEach(() => { globalThis.fetch = realFetch; });

const CLIENT = () => new RpcClient("https://rpc-a.example.com");
const TWO = () => new RpcClient("https://rpc-a.example.com, https://rpc-b.example.com/v3/SECRETKEY123456789?key=TOPSECRET");

// ---------- retry / classification ----------

test("successful call returns result in one attempt", async () => {
  installFetch(() => ({ status: 200, result: "0x1237" }));
  assert.equal(await new RpcClient("https://a.example.com").chainId(), 4663);
  assert.equal(fetchCalls.length, 1);
});

test("429 fails over to the next endpoint and succeeds", async () => {
  installFetch((url) => (url.includes("rpc-a") ? { status: 429 } : { status: 200, result: "0x1237" }));
  assert.equal(await TWO().chainId(), 4663);
  assert.equal(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].url.includes("rpc-b"));
});

test("5xx retries up to 3 attempts then RPC_FAILURE", async () => {
  installFetch(() => ({ status: 503 }));
  await assert.rejects(TWO().chainId(), (e: Error) => e instanceof RpcError && (e as RpcError).code === "RPC_FAILURE" && /3 attempts/.test(e.message));
  assert.equal(fetchCalls.length, 3);
});

test("permanent JSON-RPC errors are NOT retried and keep their message", async () => {
  installFetch(() => ({ status: 200, error: { code: -32602, message: "invalid params: bad thing" } }));
  await assert.rejects(CLIENT().chainId(), /invalid params: bad thing/);
  assert.equal(fetchCalls.length, 1);
});

test("reverts classify as REVERTED and are not retried", async () => {
  installFetch(() => ({ status: 200, error: { code: -32000, message: "execution reverted: NotFactory()" } }));
  await assert.rejects(CLIENT().chainId(), (e: Error) => (e as RpcError).code === "REVERTED");
  assert.equal(fetchCalls.length, 1);
});

test("bare -32000 (insufficient funds) is RPC_FAILURE, not REVERTED (regression)", async () => {
  installFetch(() => ({ status: 200, error: { code: -32000, message: "insufficient funds for gas * price + value" } }));
  await assert.rejects(CLIENT().chainId(), (e: Error) => (e as RpcError).code === "RPC_FAILURE" && /insufficient funds/.test(e.message));
  assert.equal(fetchCalls.length, 1);
});

// ---------- URL sanitization ----------

test("HTTP error messages never contain query strings or long path secrets", async () => {
  installFetch(() => ({ status: 403 }));
  try {
    await new RpcClient("https://rpc-b.example.com/v3/SECRETKEY123456789?key=TOPSECRET").chainId();
    assert.fail("should throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes("TOPSECRET"), msg);
    assert.ok(!msg.includes("SECRETKEY123456789"), msg);
    assert.ok(msg.includes("rpc-b.example.com"), msg);
  }
});

test("network-level failures (fetch throws) never leak the raw URL (regression)", async () => {
  const raw = "https://rpc-b.example.com/v3/SECRETKEY123456789?key=TOPSECRET";
  installFetch(() => {
    throw new TypeError(`Failed to parse URL from ${raw}`);
  });
  try {
    await new RpcClient(raw).chainId();
    assert.fail("should throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes("TOPSECRET"), msg);
    assert.ok(!msg.includes("SECRETKEY123456789"), msg);
  }
});

// ---------- log re-filtering ----------

const mkLog = (over: Partial<RpcLog> = {}): RpcLog => ({
  address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  topics: ["0x" + "aa".repeat(32), "0x" + "00".repeat(24) + "bb".repeat(20)],
  data: "0x",
  blockNumber: "0x10",
  transactionHash: "0x" + "00".repeat(32),
  logIndex: "0x0",
  ...over,
});

test("getLogs re-filters address and topic mismatches client-side", async () => {
  const good = mkLog();
  const badAddr = mkLog({ address: "0x" + "11".repeat(20) });
  const badTopic = mkLog({ topics: ["0x" + "cc".repeat(32)] });
  const mixedCaseAddr = mkLog({ address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" });
  installFetch(() => ({ status: 200, result: [good, badAddr, badTopic, mixedCaseAddr] }));
  const logs = await CLIENT().getLogs({ address: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", topics: ["0x" + "aa".repeat(32)] }, 1n, 100n);
  assert.equal(logs.length, 2, "address case-insensitive, wrong address/topic dropped");
});

// ---------- scanLogs chunking ----------

test("scanLogs scans newest chunk first, no gaps, respects limit", async () => {
  const latest = 100_000n;
  const ranges: [bigint, bigint][] = [];
  installFetch((_url, body) => {
    if (body.method === "eth_blockNumber") return { status: 200, result: "0x" + latest.toString(16) };
    if (body.method === "eth_getLogs") {
      const f = (body.params as [{ fromBlock: string; toBlock: string }])[0];
      const from = BigInt(f.fromBlock);
      const to = BigInt(f.toBlock);
      ranges.push([from, to]);
      // one log at `to` per chunk
      return { status: 200, result: [mkLog({ blockNumber: "0x" + to.toString(16) })] };
    }
    throw new Error("unexpected " + body.method);
  });
  const { logs, latestBlock, fromBlock } = await CLIENT().scanLogs({ address: mkLog().address, topics: [null] }, 25_000, 100, 10_000);
  assert.equal(latestBlock, latest);
  assert.equal(fromBlock, 75_000n);
  // newest chunk first: [90001..100000], then [80001..90000], then [75000..80000]
  assert.deepEqual(ranges, [[90_001n, 100_000n], [80_001n, 90_000n], [75_000n, 80_000n]]);
  assert.equal(logs.length, 3);
  // newest-first ordering
  assert.ok(BigInt(logs[0].blockNumber) > BigInt(logs[1].blockNumber));
});

test("scanLogs short-circuits on limit", async () => {
  let getLogCalls = 0;
  installFetch((_url, body) => {
    if (body.method === "eth_blockNumber") return { status: 200, result: "0x" + (100_000).toString(16) };
    if (body.method === "eth_getLogs") {
      getLogCalls++;
      return { status: 200, result: [mkLog(), mkLog()] };
    }
    throw new Error("unexpected");
  });
  const { logs } = await CLIENT().scanLogs({ address: mkLog().address, topics: [null] }, 50_000, 2, 10_000);
  assert.equal(getLogCalls, 1, "stops after the first chunk satisfies the limit");
  assert.equal(logs.length, 2);
});

test("scanLogs caps lookback at 500k blocks", async () => {
  installFetch((_url, body) => {
    if (body.method === "eth_blockNumber") return { status: 200, result: "0x" + (2_000_000).toString(16) };
    return { status: 200, result: [] };
  });
  const { fromBlock } = await CLIENT().scanLogs({ address: mkLog().address, topics: [null] }, 5_000_000, 1);
  assert.equal(fromBlock, 1_500_000n);
});

test("assertChain memoizes after the first success", async () => {
  installFetch(() => ({ status: 200, result: "0x1237" }));
  const c = new RpcClient("https://a.example.com");
  await c.assertChain(4663);
  await c.assertChain(4663);
  await c.assertChain(4663);
  assert.equal(fetchCalls.length, 1, "eth_chainId fires once per client");
  await assert.rejects(c.assertChain(1), /CHAIN_MISMATCH|expected chainId/);
});

test("malformed JSON-RPC body (no result, no error) → clean RPC_FAILURE", async () => {
  globalThis.fetch = (async () => ({ status: 200, ok: true, statusText: "OK", json: async () => ({ jsonrpc: "2.0", id: 1 }) })) as typeof fetch;
  await assert.rejects(new RpcClient("https://a.example.com").chainId(), /malformed JSON-RPC body/);
});

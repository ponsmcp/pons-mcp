import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeHandler } from "../src/http.js";
import { mockClient } from "./helpers.js";
import type { RpcClient } from "../src/rpc.js";

const WRITE_TOOLS = ["pons_launch_token", "pons_buy", "pons_sell", "pons_swap", "pons_graduate", "pons_admin_call", "pons_claim_fees", "pons_release_buyback"];

async function listen(handler: ReturnType<typeof makeHandler>): Promise<{ srv: Server; base: string }> {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return { srv, base: `http://127.0.0.1:${addr.port}` };
}

test("hosted server: read tools only, over Streamable HTTP, even with a key in the environment", async () => {
  process.env.PONS_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
  const rpc = mockClient({}) as unknown as RpcClient;
  const { srv, base } = await listen(makeHandler(rpc, { ratePerMinute: 1000 }));
  try {
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    assert.equal(names.length, 20, "exactly the read tools");
    assert.ok(names.includes("pons_get_token"));
    for (const w of WRITE_TOOLS) assert.ok(!names.includes(w), `${w} must not exist on the hosted server`);
    const { prompts } = await mcp.listPrompts();
    assert.equal(prompts.length, 3);
    await mcp.close();
  } finally {
    delete process.env.PONS_PRIVATE_KEY;
    srv.close();
  }
});

test("hosted server: landing, health, 404, 405, body limit, rate limit", async () => {
  const rpc = mockClient({}) as unknown as RpcClient;
  const { srv, base } = await listen(makeHandler(rpc, { ratePerMinute: 2, publicUrl: "https://mcp.example" }));
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { ok: boolean }).ok, true);

    const landingJson = await fetch(`${base}/`);
    const meta = await landingJson.json() as { endpoint: string; mode: string; tools: number };
    assert.equal(meta.endpoint, "https://mcp.example/mcp");
    assert.equal(meta.mode, "read-only");
    assert.equal(meta.tools, 20);

    const landingHtml = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    assert.match(landingHtml.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await landingHtml.text(), /claude mcp add --transport http pons https:\/\/mcp\.example\/mcp/);

    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);

    const post = (body: string) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    const big = await post("{" + '"x":"' + "a".repeat(1_100_000) + '"}');
    assert.equal(big.status, 400);
    // rate limit: bucket of 2 per minute, the body-limit request already consumed one
    const r2 = await post("{}");
    assert.notEqual(r2.status, 429);
    const r3 = await post("{}");
    assert.equal(r3.status, 429);
    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  } finally {
    srv.close();
  }
});

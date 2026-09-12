// Hosted, read-only entry: MCP over Streamable HTTP (stateless), one McpServer per request.
// There is no signer here by construction. The write tools are never registered, so the
// hosted endpoint cannot sign or broadcast regardless of environment.
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RpcClient } from "./rpc.js";
import { CHAIN_ID } from "./pons.js";
import { buildServer } from "./server.js";

export const VERSION = "0.2.0";
const MAX_BODY_BYTES = 1_000_000;

export interface HttpOptions {
  /** Requests per minute per client IP for POST /mcp. Default 60. */
  ratePerMinute?: number;
  /** Public URL shown on the landing page. Default https://mcp.ponsmcp.ai */
  publicUrl?: string;
}

class BodyError extends Error {}

interface Bucket { tokens: number; at: number }

function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c: Buffer) => {
      if (overflow) return; // keep draining so the 400 below can be delivered instead of a socket reset
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        reject(new BodyError(`body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new BodyError("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function landingHtml(publicUrl: string, tools: number): string {
  const ep = `${publicUrl.replace(/\/$/, "")}/mcp`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pons MCP, hosted</title>
<style>body{margin:0;background:#f5f7f6;color:#1c2422;font:17px/1.6 system-ui,sans-serif;padding:2rem 1.25rem}main{max-width:40rem;margin:0 auto}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:.92em}pre{background:#e9eeec;padding:.8rem .95rem;border-radius:4px;overflow-x:auto}a{color:#2f6f52}
@media(prefers-color-scheme:dark){body{background:#141a18;color:#e4e9e6}pre{background:#1d2523}a{color:#86c8a6}}</style></head><body><main>
<h1>Pons MCP, hosted</h1>
<p>This is the read-only Pons MCP server for Robinhood Chain (chainId ${CHAIN_ID}), served over Streamable HTTP. ${tools} read tools, no keys, nothing here can sign or send a transaction. Writes need the local server.</p>
<p>Endpoint: <code>${ep}</code></p>
<pre>claude mcp add --transport http pons ${ep}</pre>
<p>Docs, install steps for every client, and the local server with write mode: <a href="https://ponsmcp.ai">ponsmcp.ai</a></p>
</main></body></html>
`;
}

/** Node http request handler. Exported for tests; src/serve.ts wires it to a port. */
export function makeHandler(client: RpcClient, opts: HttpOptions = {}) {
  const rate = Math.max(1, Math.floor(opts.ratePerMinute ?? 60));
  const publicUrl = opts.publicUrl ?? "https://mcp.ponsmcp.ai";
  const buckets = new Map<string, Bucket>();
  let lastPrune = Date.now();
  const readToolCount = buildServer(client, null).toolCount;
  const html = landingHtml(publicUrl, readToolCount);

  function allow(ip: string): boolean {
    const now = Date.now();
    if (now - lastPrune > 5 * 60_000) {
      for (const [k, b] of buckets) if (now - b.at > 10 * 60_000) buckets.delete(k);
      lastPrune = now;
    }
    const b = buckets.get(ip) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    if (b.tokens < 1) { buckets.set(ip, b); return false; }
    b.tokens -= 1;
    buckets.set(ip, b);
    return true;
  }

  function cors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function rpcError(res: ServerResponse, status: number, message: string): void {
    if (status === 400) res.setHeader("Connection", "close");
    json(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    cors(res);
    res.on("finish", () => {
      console.error(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    try {
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (path === "/health") { json(res, 200, { ok: true, chainId: CHAIN_ID, version: VERSION }); return; }
      if (path === "/") {
        const wantsHtml = (req.headers.accept ?? "").includes("text/html");
        if (wantsHtml) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return; }
        json(res, 200, {
          name: "pons-mcp", version: VERSION, chainId: CHAIN_ID, transport: "streamable-http",
          endpoint: `${publicUrl.replace(/\/$/, "")}/mcp`, mode: "read-only", tools: readToolCount, docs: "https://ponsmcp.ai",
        });
        return;
      }
      if (path !== "/mcp") { json(res, 404, { error: "not found" }); return; }
      if (req.method !== "POST") {
        // Stateless: no sessions, no server-initiated SSE stream, nothing to DELETE.
        rpcError(res, 405, "method not allowed; this is a stateless server, POST JSON-RPC to /mcp");
        return;
      }
      if (!allow(clientIp(req))) { rpcError(res, 429, `rate limited: ${rate} requests per minute per IP`); return; }
      const body = await readBody(req);
      const { server } = buildServer(client, null);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) rpcError(res, err instanceof BodyError ? 400 : 500, err instanceof BodyError ? msg : "internal error");
      else res.end();
      if (!(err instanceof BodyError)) console.error("pons-mcp-http error:", msg);
    }
  };
}

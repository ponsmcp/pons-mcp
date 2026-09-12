// Minimal stdio MCP client for driving pons-mcp in-process.
// Spawns `node dist/index.js`, speaks newline-delimited JSON-RPC, matches
// responses by id. The private key is passed to the child via env only.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

export class McpClient {
  constructor(privateKey, { rpcUrl } = {}) {
    this.child = spawn("node", ["dist/index.js"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        ...(privateKey ? { PONS_PRIVATE_KEY: privateKey } : {}),
        ...(rpcUrl ? { PONS_RPC_URL: rpcUrl } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child.stderr.on("data", (d) => {
      this.stderr += d;
    });
    // If the server dies (bad key, RPC down at startup, dist/ not built),
    // reject everything pending immediately with the child's own diagnostics
    // instead of hanging until the request timeout.
    const onDeath = (why) => {
      const detail = this.stderr.trim();
      const err = new Error(`pons-mcp server exited (${why})${detail ? `:\n${detail}` : ""}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(err);
      }
      this.pending.clear();
    };
    this.child.on("exit", (code) => {
      if (this.pending.size > 0) onDeath(`code ${code}`);
    });
    this.child.on("error", (e) => onDeath(e.message));
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not JSON — ignore
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }

  request(method, params, timeoutMs = 90_000) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  notify(method) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pons-live-test", version: "0.0.1" },
    });
    this.notify("notifications/initialized");
  }

  /** The server's startup banner carries the derived signer address. */
  signerAddress() {
    const m = this.stderr.match(/signer (0x[0-9a-f]{40})/);
    return m ? m[1] : null;
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { isError: result.isError === true, data: parsed };
  }

  close() {
    this.rl.close();
    this.child.kill("SIGTERM");
  }
}

/** Pretty-print helper: JSON with 2-space indent. */
export const show = (label, obj) => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(obj, null, 2));
};

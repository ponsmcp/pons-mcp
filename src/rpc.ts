export class RpcError extends Error {
  constructor(
    public code: "RPC_FAILURE" | "REVERTED" | "CHAIN_MISMATCH",
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface LogFilter {
  address: string;
  topics: (string | null | string[])[];
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

const MAX_ATTEMPTS = 3;

// Endpoint URLs can carry API keys (query string or path segment). Never put
// the raw URL into error messages — those surface in MCP tool results and logs.
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const parts = u.pathname
      .split("/")
      .filter(Boolean)
      .map((p) => (p.length >= 8 ? p.slice(0, 4) + "…" : p));
    return u.origin + (parts.length > 0 ? "/" + parts.join("/") : "");
  } catch {
    return "<unparseable RPC URL>";
  }
}

// Network-level errors (e.g. Node's "Failed to parse URL from <raw url>")
// embed the raw endpoint — strip it wherever it appears.
function sanitizeMessage(message: string, rawUrl: string, safeUrl: string): string {
  return message.split(rawUrl).join(safeUrl);
}

export class RpcClient {
  private endpoints: string[];
  private next = 0;
  private id = 0;

  constructor(rpcUrls: string) {
    this.endpoints = rpcUrls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (this.endpoints.length === 0) throw new RpcError("RPC_FAILURE", "no RPC endpoints configured");
  }

  private endpoint(): string {
    return this.endpoints[this.next % this.endpoints.length];
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const url = this.endpoint();
      const safeUrl = sanitizeUrl(url);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new RpcError("RPC_FAILURE", `${safeUrl} responded HTTP ${res.status}`, true);
        }
        if (!res.ok) {
          throw new RpcError("RPC_FAILURE", `${safeUrl} responded HTTP ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          result?: T;
          error?: { code: number; message: string };
        };
        if (body.error) {
          const { code, message } = body.error;
          // Only genuine execution reverts are REVERTED. Nodes also use
          // -32000 for non-revert failures (insufficient funds, nonce too
          // low, log-limit errors); those are permanent but not reverts.
          if (code === 3 || /revert/i.test(message)) {
            throw new RpcError("REVERTED", `execution reverted: ${message}`);
          }
          throw new RpcError("RPC_FAILURE", `RPC error ${code}: ${message}`);
        }
        if (body.result === undefined) {
          throw new RpcError("RPC_FAILURE", `${safeUrl} returned a malformed JSON-RPC body (no result, no error)`);
        }
        return body.result as T;
      } catch (err) {
        // Retry policy: only network failures and 429/5xx retry.
        // Permanent RPC errors and reverts fail immediately.
        if (err instanceof RpcError && !err.retryable) throw err;
        const rawMsg = err instanceof Error ? err.message : String(err);
        lastErr = new Error(sanitizeMessage(rawMsg, url, safeUrl));
        // retryable: network failure, 429, 5xx — rotate endpoint, back off
        this.next++;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
    }
    throw new RpcError(
      "RPC_FAILURE",
      `all ${MAX_ATTEMPTS} attempts failed for ${method}: ${lastErr?.message}`,
    );
  }

  async chainId(): Promise<number> {
    return Number(BigInt((await this.call<string>("eth_chainId", []))));
  }

  async assertChain(expected: number): Promise<void> {
    // Memoized per client: the startup check already ran, and eth_chainId is
    // constant for the process. Without this every tool call pays a round trip.
    if (this.chainAsserted === expected) return;
    const actual = await this.chainId();
    if (actual !== expected) {
      throw new RpcError("CHAIN_MISMATCH", `expected chainId ${expected}, got ${actual}`);
    }
    this.chainAsserted = expected;
  }
  private chainAsserted: number | null = null;

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_blockNumber", []));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_gasPrice", []));
  }

  async ethCall(to: string, data: string): Promise<string> {
    // No archive node: always "latest". Never accept a block-tag parameter.
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  private reFilter(log: RpcLog, filter: LogFilter): boolean {
    if (log.address.toLowerCase() !== filter.address.toLowerCase()) return false;
    for (let i = 0; i < filter.topics.length; i++) {
      const want = filter.topics[i];
      if (want === null || want === undefined) continue;
      const got = log.topics[i]?.toLowerCase();
      if (got === undefined) return false;
      if (Array.isArray(want)) {
        if (!want.some((w) => w.toLowerCase() === got)) return false;
      } else if (want.toLowerCase() !== got) {
        return false;
      }
    }
    return true;
  }

  async getLogs(filter: LogFilter, fromBlock: bigint, toBlock: bigint): Promise<RpcLog[]> {
    const raw = await this.call<RpcLog[]>("eth_getLogs", [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ]);
    // Mandatory client-side re-filtering: some nodes drop or
    // misapply topic filters, so assert address + every topic position.
    return (raw ?? []).filter((log) => this.reFilter(log, filter));
  }

  // Chunked scan, newest chunk first so callers short-circuit on `limit`.
  // Returned logs are sorted newest-first (block desc, logIndex desc).
  // `scannedFromBlock` is the oldest block actually queried — when `limit`
  // short-circuits the scan this is NEWER than `fromBlock`, and `complete`
  // is false so callers are not misled about coverage.
  async scanLogs(
    filter: LogFilter,
    lookbackBlocks: number,
    limit: number,
    chunkSize = 10_000,
  ): Promise<{ logs: RpcLog[]; latestBlock: bigint; fromBlock: bigint; scannedFromBlock: bigint; complete: boolean }> {
    const latest = await this.blockNumber();
    const lookback = BigInt(Math.min(lookbackBlocks, 500_000));
    const from = latest > lookback ? latest - lookback : 0n;
    const out: RpcLog[] = [];
    let oldestScanned = latest;
    let complete = false;
    for (let end = latest; end >= from && out.length < limit; ) {
      const start = end - BigInt(chunkSize) + 1n > from ? end - BigInt(chunkSize) + 1n : from;
      const logs = await this.getLogs(filter, start, end);
      logs.sort((a, b) => {
        const d = BigInt(b.blockNumber) - BigInt(a.blockNumber);
        if (d !== 0n) return d > 0n ? 1 : -1;
        return Number(BigInt(b.logIndex) - BigInt(a.logIndex));
      });
      out.push(...logs);
      oldestScanned = start;
      if (start === 0n || start === from) {
        complete = true;
        break;
      }
      end = start - 1n;
    }
    return { logs: out.slice(0, limit), latestBlock: latest, fromBlock: from, scannedFromBlock: oldestScanned, complete };
  }
}

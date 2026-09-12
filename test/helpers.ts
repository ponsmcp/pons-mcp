// Shared test helpers: a minimal ABI/Rlp reader for asserting on encoded
// calldata, and mock factories for RpcClient/fetch.

export const hex = (s: string) => s.replace(/^0x/, "");

/** Read 32-byte word i from a hex blob (no 0x). */
export function wordAt(blobNoPrefix: string, i: number): string {
  return blobNoPrefix.slice(i * 64, (i + 1) * 64);
}

export function wordUint(blobNoPrefix: string, i: number): bigint {
  return BigInt("0x" + (wordAt(blobNoPrefix, i) || "0"));
}

/** Decode an ABI string inside a tuple blob at byte-offset `off`. */
export function stringAt(blobNoPrefix: string, off: number): string {
  const lenWord = blobNoPrefix.slice(off * 2, off * 2 + 64);
  const len = Number(BigInt("0x" + lenWord));
  const raw = blobNoPrefix.slice(off * 2 + 64, off * 2 + 64 + len * 2);
  return Buffer.from(raw, "hex").toString("utf8");
}

export function addrOf(word: string): string {
  return "0x" + word.slice(24).toLowerCase();
}

// ---------- minimal RLP reader (for asserting signed-tx field order) ----------

export interface RlpNode {
  kind: "bytes" | "list";
  data?: Uint8Array;
  items?: RlpNode[];
}

export function rlpDecode(buf: Uint8Array, pos = 0): { node: RlpNode; next: number } {
  const b0 = buf[pos];
  if (b0 < 0x80) return { node: { kind: "bytes", data: buf.subarray(pos, pos + 1) }, next: pos + 1 };
  if (b0 <= 0xb7) return { node: { kind: "bytes", data: buf.subarray(pos + 1, pos + 1 + (b0 - 0x80)) }, next: pos + 1 + (b0 - 0x80) };
  if (b0 <= 0xbf) {
    const ll = b0 - 0xb7;
    const len = Number(BigInt("0x" + Buffer.from(buf.subarray(pos + 1, pos + 1 + ll)).toString("hex") || "0"));
    const start = pos + 1 + ll;
    return { node: { kind: "bytes", data: buf.subarray(start, start + len) }, next: start + len };
  }
  const [lenLen, base] = b0 <= 0xf7 ? [0, 0xc0] : [b0 - 0xf7, 0xf7];
  const len = lenLen === 0 ? b0 - 0xc0 : Number(BigInt("0x" + Buffer.from(buf.subarray(pos + 1, pos + 1 + lenLen)).toString("hex") || "0"));
  let p = pos + 1 + lenLen;
  const end = p + len;
  const items: RlpNode[] = [];
  while (p < end) {
    const r = rlpDecode(buf, p);
    items.push(r.node);
    p = r.next;
  }
  void base;
  return { node: { kind: "list", items }, next: end };
}

export const rlpBigInt = (n: RlpNode): bigint =>
  n.kind === "bytes" && n.data ? BigInt("0x" + (Buffer.from(n.data).toString("hex") || "0")) : (() => { throw new Error("not bytes"); })();

// ---------- mocked RpcClient (structural) ----------

export interface MockClientOpts {
  /** eth_call(to, data) → hex return data. */
  ethCall?: (to: string, data: string) => string;
  /** client.call(method, params) → JSON-RPC result. Throw to simulate errors. */
  call?: (method: string, params: unknown[]) => unknown;
}

/** A duck-typed RpcClient stand-in. Tracks every call for assertions. */
export function mockClient(opts: MockClientOpts) {
  const calls: { method: string; params: unknown[] }[] = [];
  const client = {
    calls,
    ethCallRaw: opts.ethCall,
    callRaw: opts.call,
    async assertChain() {},
    async ethCall(to: string, data: string): Promise<string> {
      calls.push({ method: "eth_call", params: [{ to, data }] });
      if (!opts.ethCall) throw new Error(`unexpected ethCall ${to} ${data.slice(0, 10)}`);
      return opts.ethCall(to, data);
    },
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push({ method, params });
      if (!opts.call) throw new Error(`unexpected call ${method}`);
      return opts.call(method, params) as T;
    },
  };
  return client;
}

export const word0x = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
export const addrWord = (a: string) => "0x" + "0".repeat(24) + hex(a).toLowerCase();

#!/usr/bin/env node
// Entry for the hosted read-only server. `PONS_PRIVATE_KEY` is ignored here on purpose.
import { createServer } from "node:http";
import { RpcClient } from "./rpc.js";
import { CHAIN_ID } from "./pons.js";
import { makeHandler } from "./http.js";

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

async function main(): Promise<void> {
  if (process.env.PONS_PRIVATE_KEY) {
    delete process.env.PONS_PRIVATE_KEY;
    console.error("pons-mcp-http: PONS_PRIVATE_KEY is set but ignored; the hosted server is read-only by design");
  }
  const client = new RpcClient(process.env.PONS_RPC_URL ?? DEFAULT_RPC);
  await client.assertChain(CHAIN_ID);

  const port = Number(process.env.PORT ?? 8080);
  const rate = Number(process.env.PONS_HTTP_RATE_LIMIT ?? 60);
  if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(rate) || rate <= 0) {
    throw new Error(`PORT and PONS_HTTP_RATE_LIMIT must be positive integers (got ${process.env.PORT}, ${process.env.PONS_HTTP_RATE_LIMIT})`);
  }
  const srv = createServer(makeHandler(client, { ratePerMinute: rate, publicUrl: process.env.PONS_HTTP_PUBLIC_URL }));
  srv.listen(port, () => {
    console.error(`pons-mcp-http: read-only Streamable HTTP on :${port}/mcp (chainId ${CHAIN_ID}, ${rate} req/min per IP)`);
  });
  const stop = (): void => { srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error("pons-mcp-http fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("pons-mcp-http unhandled rejection:", err instanceof Error ? err.message : err);
  process.exit(1);
});

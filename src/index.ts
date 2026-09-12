#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RpcClient } from "./rpc.js";
import { CHAIN_ID } from "./pons.js";
import { loadSigner } from "./signer.js";
import { buildServer } from "./server.js";

const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

async function main(): Promise<void> {
  const client = new RpcClient(process.env.PONS_RPC_URL ?? DEFAULT_RPC);

  // Startup chain assertion: refuse to serve against the wrong chain.
  await client.assertChain(CHAIN_ID);

  // Opt-in write mode: key comes ONLY from PONS_PRIVATE_KEY. Only the derived
  // address is ever logged. The env var is dropped after loading so it does
  // not linger in process.env for the process lifetime.
  const signer = loadSigner(process.env.PONS_PRIVATE_KEY);
  delete process.env.PONS_PRIVATE_KEY;

  const { server, toolCount, writeCount } = buildServer(client, signer);
  await server.connect(new StdioServerTransport());
  const mode =
    signer === null
      ? "read-only (PONS_PRIVATE_KEY unset)"
      : `WRITE ENABLED, signer ${signer.address} (${writeCount} write tools registered; dry-run by default)`;
  console.error(
    `pons-mcp: connected to Robinhood Chain (chainId ${CHAIN_ID}), ${toolCount} tools, 3 resources, 3 prompts, ${mode}`,
  );
}

main().catch((err) => {
  console.error("pons-mcp fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

// A rejected promise outside a tool handler is a bug; die loudly rather than
// serve with unknown state. Tool handlers catch their own errors.
process.on("unhandledRejection", (err) => {
  console.error("pons-mcp unhandled rejection:", err instanceof Error ? err.message : err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("pons-mcp uncaught exception:", err instanceof Error ? err.message : err);
  process.exit(1);
});

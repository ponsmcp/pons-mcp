// Assembles the McpServer: tools (read always; write only with a signer), resources, prompts.
// Shared by the stdio entry (src/index.ts) and the hosted read-only HTTP entry (src/http.ts).
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RpcClient } from "./rpc.js";
import { protocolOverview, getToken, recentLaunches, PonsError } from "./pons.js";
import { toolDefinitions } from "./tools.js";
import type { Signer } from "./signer.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface BuiltServer {
  server: McpServer;
  toolCount: number;
  writeCount: number;
}

export function buildServer(client: RpcClient, signer: Signer | null): BuiltServer {
  const defs = toolDefinitions(client, signer);
  const READ_TOOL_COUNT = 20;
  const writeCount = signer === null ? 0 : defs.length - READ_TOOL_COUNT;

  const server = new McpServer(
    { name: "pons-mcp", version: "0.2.0" },
    {
      instructions:
        signer === null
          ? "Read-only access to the Pons launchpad on Robinhood Chain (chainId 4663). All tools query live chain state at the latest block; nothing here can sign or send transactions."
          : `Access to the Pons launchpad on Robinhood Chain (chainId 4663). Read tools query live chain state at the latest block. ${writeCount} WRITE tools are enabled (pons_launch_token, pons_buy, pons_sell, pons_swap, pons_graduate, fee-recipient and curve controls, fee claims, pons_admin_call) that spend real ETH from the configured signer: every one dry-runs by default and only broadcasts when called with dryRun=false AND confirm=true.`,
    },
  );

  for (const def of defs) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }

  // ---------- resources (live chain state as readable content) ----------

  server.registerResource(
    "protocol-overview",
    "pons://protocol/overview",
    { description: "Live Pons protocol parameters, launch configs, governance constants, contract addresses", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await protocolOverview(client), null, 2) }] }),
  );

  server.registerResource(
    "recent-launches",
    "pons://launches/recent",
    { description: "Newest TokenLaunched events (default 50k-block lookback)", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await recentLaunches(client, {}), null, 2) }] }),
  );

  server.registerResource(
    "token-state",
    new ResourceTemplate("pons://token/{address}", { list: undefined }),
    { description: "Full live state of one Pons-launched token (factory record, curve reserves, graduation progress, fees)", mimeType: "application/json" },
    async (uri, { address }) => {
      const addr = String(address);
      if (!ADDRESS_RE.test(addr)) throw new PonsError("INVALID_ADDRESS", `invalid token address: ${addr}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await getToken(client, addr), null, 2) }] };
    },
  );

  // ---------- prompts (guided workflows) ----------

  server.registerPrompt(
    "launch-a-token",
    {
      description: "Guided safe launch of a Pons token: preview, verify, broadcast, verify on-chain",
      argsSchema: {
        name: z.string().max(128).describe("Token name (≤64 utf8 bytes)"),
        symbol: z.string().max(32).describe("Token symbol (≤16 utf8 bytes)"),
        devBuyEth: z.string().max(32).optional().describe("Optional opening buy in ETH (atomic, snipe-exempt)"),
      },
    },
    ({ name, symbol, devBuyEth }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Help me launch a Pons token named "${name}" with symbol "${symbol}"${devBuyEth ? ` and a ${devBuyEth} ETH dev buy` : ""}. Follow this exact discipline:`,
              "1. Call pons_preview_launch for the config I'll use and explain the economics (supply, phantom quote, graduation threshold).",
              "2. Call pons_can_launch for my signer address; stop if not allowed.",
              `3. Call pons_launch_token with name="${name}", symbol="${symbol}"${devBuyEth ? `, devBuyEth="${devBuyEth}"` : ""} in DEFAULT dry-run mode. Show me the full cost preview (launchFee + devBuy + gas) and the simulation result.`,
              "4. STOP and ask for my explicit approval. Only if I say yes, re-call pons_launch_token with dryRun=false AND confirm=true.",
              "5. After broadcast, verify with pons_get_token on the launched address and give me the explorer links.",
              "Never pass confirm=true without my explicit go-ahead. Identical name+symbol cannot be launched twice from the same wallet (CREATE2 salt).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "analyze-token",
    {
      description: "Full due-diligence pass on a Pons token: curve state, snipe tax, trades, graduation status",
      argsSchema: { tokenAddress: z.string().max(64).describe("0x token address") },
    },
    ({ tokenAddress }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Analyze the Pons token ${tokenAddress}. Gather, then summarize in plain language:`,
              "1. pons_get_token — reserves (real vs phantom quote), graduation progress, fees, creator tax, phase.",
              "2. pons_snipe_tax on its curve — is the snipe window still active? What tax would a buy pay right now?",
              "3. pons_curve_trades — recent activity: how many buys/sells, sizes, who is trading.",
              "4. If phase is PoolCreated (graduated), also quote a small pons_quote_swap buy and sell to show pool liquidity and spread.",
              "5. pons_pending_fee_change — any pending creator-fee-recipient change.",
              "End with a short verdict: is it still on the bonding curve or graduated, how far from graduation, and anything unusual.",
              "Read-only analysis only: do not call any write tool.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "safe-trade",
    {
      description: "Bonding-curve or V4 trade with mandatory dry-run and slippage review",
      argsSchema: {
        tokenAddress: z.string().max(64).describe("0x token address"),
        side: z.enum(["buy", "sell"]),
        amount: z.string().max(64).describe("Decimal amount (ETH/quote asset for buy, tokens for sell)"),
      },
    },
    ({ tokenAddress, side, amount }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `I want to ${side} ${amount} of ${tokenAddress}. Follow the safe-trade workflow:`,
              "1. pons_get_token to learn whether it trades on the bonding curve (phase 0) or the V4 pool (phase 2).",
              `2. Quote first: ${side === "buy" ? "pons_quote_buy" : "pons_quote_sell"} on the curve, or pons_quote_swap if graduated. Show me expected output, price impact, and all fees/taxes.`,
              "3. If price impact exceeds ~5% or the snipe-tax window is active (pons_snipe_tax), warn me and stop.",
              `4. Dry-run the write tool (pons_${side} or pons_swap) with default dryRun=true and show me the steps and simulation results.`,
              "5. STOP for my explicit approval. Only then re-call with dryRun=false AND confirm=true.",
              "6. Report the receipt(s) with explorer links and verify the outcome with pons_get_token or a balance check.",
            ].join("\n"),
          },
        },
      ],
    }),
  );


  return { server, toolCount: defs.length, writeCount };
}

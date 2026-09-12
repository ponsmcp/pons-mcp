#!/usr/bin/env node
// Live end-to-end test driver for pons-mcp on Robinhood Chain.
//
//   node scripts/live/run.mjs <command> [options]
//
// Commands:
//   preflight                       chain check, signer balance, launch permission, gas price
//   launch --name N --symbol S      launch a token (dry-run first; add --confirm to broadcast)
//         [--dev-buy 0.001]         optional atomic dev buy (respects PONS_MAX_DEV_BUY_ETH)
//   buy   [--amount 0.0002]         buy on the launched curve
//   sell  [--amount 50% | --all]    sell tokens back to the curve
//   status                          token/curve state + recent trades for the launched token
//
// SAFETY
// - The key comes ONLY from the PONS_PRIVATE_KEY env var (same as the server).
//   Never put it in a file or on the command line (visible in `ps`).
// - Without --confirm every command is a dry-run: full simulation, cost
//   preview, exact calldata, nothing broadcast, nothing signed.
// - With --confirm the tool broadcasts REAL transactions spending REAL ETH.
// - Use a dedicated hot wallet. ~0.005 ETH covers launch + a few small trades.
//
// State (launched token/curve addresses — no secrets) persists in
// scripts/live/state.json between invocations.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpClient, show } from "./mcp-client.mjs";

const STATE_PATH = fileURLToPath(new URL("./state.json", import.meta.url));
const RPC = (process.env.PONS_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com").split(",")[0].trim();

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const option = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};

const CONFIRM = flag("--confirm");
const KEY = process.env.PONS_PRIVATE_KEY;

/** Set at startup; fatal() always kills the server child before exiting. */
let client = null;
function fatal(msg) {
  console.error(msg);
  if (client) client.close();
  process.exit(1);
}

const loadState = () => (existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {});
const saveState = (patch) => {
  const s = { ...loadState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  return s;
};

/** Exact wei→decimal-string formatting (no Number round-trip). */
function formatWei(wei, decimals = 18) {
  const s = wei.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

function requireKey() {
  if (!KEY) {
    console.error("PONS_PRIVATE_KEY is not set. Export a dedicated hot-wallet key first:");
    console.error("  export PONS_PRIVATE_KEY=0x<32-byte-hex>");
    process.exit(1);
  }
}

async function rpcBalance(address) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
  return { wei: BigInt(body.result ?? "0x0") };
}

async function tokenBalance(token, holder) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: token, data: "0x70a08231" + holder.slice(2).padStart(64, "0") }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
  return BigInt(body.result ?? "0x0");
}

function gate(data) {
  // Shared write-tool output handling: on a tool-level error, show it and stop.
  if (data.error) {
    show("ERROR", data.error);
    fatal("tool returned an error");
  }
  return data;
}

const commands = {
  async preflight(client) {
    const signer = client.signerAddress();
    if (!signer) fatal("server did not report a signer — is PONS_PRIVATE_KEY set and valid?");
    const [overview, canLaunch, costs, balance] = await Promise.all([
      client.callTool("pons_protocol_overview"),
      client.callTool("pons_can_launch", { address: signer }),
      client.callTool("pons_launch_costs"),
      rpcBalance(signer),
    ]);
    const o = gate(overview.data);
    gate(canLaunch.data);
    const c = gate(costs.data);
    show("signer", { address: signer, balanceEth: formatWei(balance.wei), explorer: `https://robinhoodchain.blockscout.com/address/${signer}` });
    show("protocol", o);
    show("canLaunch", canLaunch.data);
    // Live fee market: launchAndBuy gas ≈ 3.85M at the current gas price.
    const gasCost = BigInt(c.measured.launchAndBuyGas) * BigInt(c.live.gasPriceWei);
    const need = BigInt(o.factory.launchFeeWei) + gasCost;
    show("funding estimate", {
      launchFee: o.factory.launchFee,
      gasAtLivePrice: `${formatWei(gasCost)} ETH (${c.measured.launchAndBuyGas} gas @ ${c.live.gasPrice})`,
      minimumForLaunch: `${formatWei(need)} ETH (plus any dev buy / trades)`,
    });
    if (balance.wei < need) {
      console.log("\nWARN: balance is short of launch fee + gas at the live gas price.");
    } else {
      console.log("\nOK: funded for a launch (add more for dev buy / trades).");
    }
  },

  async launch(client) {
    const name = option("--name");
    const symbol = option("--symbol");
    if (!name || !symbol) fatal("usage: launch --name <name> --symbol <symbol> [--dev-buy 0.001] [--confirm]");
    const devBuy = option("--dev-buy");
    const inputs = { name, symbol, ...(devBuy ? { devBuyEth: devBuy } : {}) };
    const dry = gate((await client.callTool("pons_launch_token", { ...inputs, dryRun: true, confirm: false })).data);
    show("launch dry-run preview", dry);
    if (!CONFIRM) {
      console.log("\nDry-run only. Re-run with --confirm to broadcast.");
      return;
    }
    if (!dry.simulation?.ok) fatal("simulation reverted — NOT broadcasting");
    const res = (await client.callTool("pons_launch_token", { ...inputs, dryRun: false, confirm: true })).data;
    if (res.error) {
      // A receipt timeout means the tx may still mine — preserve the hash so
      // the token/curve can be recovered from the explorer.
      const m = String(res.error.message ?? "").match(/0x[0-9a-fA-F]{64}/);
      if (m) {
        saveState({ pendingLaunchTx: m[0], name, symbol });
        console.error(`\nBroadcast outcome unknown; saved pending tx ${m[0]} to state.json.`);
        console.error(`Check https://robinhoodchain.blockscout.com/tx/${m[0]} — if it succeeded, copy the token/curve addresses from the TokenLaunched log into state.json.`);
      }
      show("ERROR", res.error);
      fatal("broadcast failed");
    }
    const out = res;
    show("LAUNCHED (broadcast)", out);
    if (out.launched?.token) {
      saveState({ token: out.launched.token, curve: out.launched.curve, launchTx: out.transaction?.hash, name, symbol, pendingLaunchTx: undefined });
      console.log(`\nSaved to state.json: token=${out.launched.token} curve=${out.launched.curve}`);
      console.log(`Explorer: https://robinhoodchain.blockscout.com/token/${out.launched.token}`);
    } else {
      fatal("broadcast succeeded but no token address was decoded — check the tx on the explorer");
    }
  },

  async buy(client) {
    const s = loadState();
    if (!s.curve) fatal("no curve in state.json — run launch first");
    const amount = option("--amount", "0.0002");
    const dry = gate((await client.callTool("pons_buy", { curveAddress: s.curve, amount, dryRun: true, confirm: false })).data);
    show("buy dry-run preview", dry);
    if (!CONFIRM) { console.log("\nDry-run only. Re-run with --confirm to broadcast."); return; }
    const out = gate((await client.callTool("pons_buy", { curveAddress: s.curve, amount, dryRun: false, confirm: true })).data);
    show("BOUGHT (broadcast)", out);
    saveState({ lastBuyTx: out.receipts?.at(-1)?.hash });
  },

  async sell(client) {
    const s = loadState();
    if (!s.curve || !s.token) fatal("no token/curve in state.json — run launch first");
    const signer = client.signerAddress();
    let amount = option("--amount");
    const all = flag("--all");
    const pctMatch = amount && /^(\d{1,3})%$/.exec(amount);
    if (all || pctMatch) {
      const pct = all ? 100n : BigInt(pctMatch[1]);
      if (pct < 1n || pct > 100n) fatal("percentage must be 1–100");
      const bal = await tokenBalance(s.token, signer);
      // Exact BigInt math; never round through Number.
      amount = formatWei((bal * pct) / 100n);
      console.log(`selling ${pct}% of balance (${formatWei(bal)} tokens) → ${amount}`);
    } else if (amount && !/^\d+(\.\d+)?$/.test(amount)) {
      fatal(`invalid --amount: ${amount} (decimal tokens, e.g. 1000.5, or 50%, or --all)`);
    }
    if (!amount) fatal("usage: sell [--amount <tokens>|NN%|--all] [--confirm]");
    const dry = gate((await client.callTool("pons_sell", { curveAddress: s.curve, tokenAmount: amount, dryRun: true, confirm: false })).data);
    show("sell dry-run preview", dry);
    if (!CONFIRM) { console.log("\nDry-run only. Re-run with --confirm to broadcast."); return; }
    const out = gate((await client.callTool("pons_sell", { curveAddress: s.curve, tokenAmount: amount, dryRun: false, confirm: true })).data);
    show("SOLD (broadcast)", out);
    saveState({ lastSellTx: out.receipts?.at(-1)?.hash });
  },

  async status(client) {
    const s = loadState();
    if (!s.token) fatal("no token in state.json — run launch first");
    if (s.pendingLaunchTx) console.log(`note: pendingLaunchTx ${s.pendingLaunchTx} is recorded from an earlier timed-out broadcast`);
    const [token, snipe, trades] = await Promise.all([
      client.callTool("pons_get_token", { tokenAddress: s.token }),
      s.curve ? client.callTool("pons_snipe_tax", { curveAddress: s.curve }) : null,
      s.curve ? client.callTool("pons_curve_trades", { curveAddress: s.curve, limit: 10 }) : null,
    ]);
    show("token state", gate(token.data));
    if (snipe) show("snipe tax", gate(snipe.data));
    if (trades) show("recent trades", gate(trades.data));
  },

  // V4 swap on an ALREADY-GRADUATED token (phase 2 pool). Independent of
  // state.json — pass any graduated token address.
  async swap(client) {
    const token = option("--token");
    const side = option("--side", "buy");
    const amount = option("--amount", "0.0002");
    if (!token) fatal("usage: swap --token 0x… [--side buy|sell] [--amount 0.0002] [--confirm]");
    if (side !== "buy" && side !== "sell") fatal("--side must be buy or sell");
    const quote = gate((await client.callTool("pons_quote_swap", { tokenAddress: token, side, amount })).data);
    show("V4 quoter price", quote);
    const dry = gate((await client.callTool("pons_swap", { tokenAddress: token, side, amount, dryRun: true, confirm: false })).data);
    show("swap dry-run preview", dry);
    if (!CONFIRM) { console.log("\nDry-run only. Re-run with --confirm to broadcast."); return; }
    const res = (await client.callTool("pons_swap", { tokenAddress: token, side, amount, dryRun: false, confirm: true })).data;
    if (res.error) { show("ERROR", res.error); fatal("broadcast failed"); }
    show("SWAPPED (broadcast)", res);
    if (side === "buy") saveState({ v4Token: token, lastV4BuyTx: res.receipts?.at(-1)?.hash });
    else saveState({ lastV4SellTx: res.receipts?.at(-1)?.hash });
  },
};

if (!command || !commands[command]) {
  console.error("commands: preflight | launch | buy | sell | status | swap");
  process.exit(1);
}
requireKey();

client = new McpClient(KEY);
await client.connect();
try {
  await commands[command](client);
} finally {
  client.close();
}

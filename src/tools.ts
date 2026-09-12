import { z } from "zod";
import { RpcError } from "./rpc.js";
import * as pons from "./pons.js";
import { PonsError } from "./pons.js";
import type { RpcClient } from "./rpc.js";
import type { Signer } from "./signer.js";
import { launchToken, capsFromEnv, LaunchCaps } from "./launch.js";
import { parseScanConfig, scanInteresting } from "./scan.js";
import * as trade from "./trade.js";
import { adminCallTool, ADMIN_FNS } from "./admin.js";
import { quoteSwapTool, swapTool } from "./v4.js";
import { feeBalances, claimFeesTool, releaseBuybackTool } from "./payouts.js";
import { v1GetToken, v1Launches } from "./v1.js";
import { ParseUnitsError } from "./format.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function checkAddress(value: string, field: string): void {
  if (!ADDRESS_RE.test(value)) {
    throw new PonsError("INVALID_ADDRESS", `${field} must be a 0x-prefixed 20-byte hex address, got: ${value}`);
  }
}

const address = z.string().describe("0x-prefixed 20-byte hex address");
const lookbackBlocks = z
  .number()
  .int()
  .min(1)
  .max(500_000)
  .optional()
  .describe("Blocks to look back from latest (default 50000 ≈ 1.4h at ~10 blocks/s; max 500000)");
const limit = z.number().int().min(1).max(100).optional().describe("Max results, newest first (default 20, max 100)");

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [x: string]: unknown;
}

interface RawToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface ToolDef extends Omit<RawToolDef, "handler"> {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function errorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof PonsError || err instanceof RpcError) return { code: err.code, message: err.message };
  if (err instanceof ParseUnitsError) return { code: "INVALID_PARAMS", message: err.message };
  return { code: "RPC_FAILURE", message: err instanceof Error ? err.message : String(err) };
}

export function toolDefinitions(client: RpcClient, signer: Signer | null = null): ToolDef[] {
  const wrap = (fn: RawToolDef["handler"]) => async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ error: errorPayload(err) }, null, 2) }],
      };
    }
  };

  const defs: RawToolDef[] = [
    {
      name: "pons_protocol_overview",
      description:
        "Pons launchpad protocol parameters on Robinhood Chain: launch fee, launch enabled flag, max creator tax, snipe-tax start/duration, all launch configs decoded, contract addresses, explorer link.",
      schema: {},
      handler: () => pons.protocolOverview(client),
    },
    {
      name: "pons_get_token",
      description:
        "Full state of one Pons-launched token: getLaunchedToken struct, ERC-20 metadata, curve reserves (real vs phantom quote), graduation progress, snipe tax, fees. Errors NOT_A_LAUNCH if the token was not launched via the Pons factory.",
      schema: { tokenAddress: address.describe("Token contract address") },
      handler: (a) => {
        const t = a.tokenAddress as string;
        checkAddress(t, "tokenAddress");
        return pons.getToken(client, t);
      },
    },
    {
      name: "pons_can_launch",
      description:
        "Check whether an address is allowed to launch on Pons right now: canLaunch, whitelistedLaunchers, and the global launchEnabled flag.",
      schema: { address: address.describe("Address to check") },
      handler: (a) => {
        const addr = a.address as string;
        checkAddress(addr, "address");
        return pons.canLaunch(client, addr);
      },
    },
    {
      name: "pons_pair_token_economics",
      description:
        "Pair-token economics from the factory: approved status, phantom quote, graduation threshold, and decimals (e.g. ETH or USDG pairs).",
      schema: { pairTokenAddress: address.describe("Pair token contract address") },
      handler: (a) => {
        const t = a.pairTokenAddress as string;
        checkAddress(t, "pairTokenAddress");
        return pons.pairTokenEconomics(client, t);
      },
    },
    {
      name: "pons_recent_launches",
      description:
        "Scan factory TokenLaunched events newest-first. Optional deployer filter (server-side topic) and pairToken filter (client-side). Returns token, curve, deployer, pairToken, threshold, block, tx hash.",
      schema: {
        lookbackBlocks,
        limit,
        deployer: address.optional().describe("Filter by deployer address"),
        pairToken: address.optional().describe("Filter by pair token address (client-side)"),
      },
      handler: (a) => {
        if (a.deployer !== undefined) checkAddress(a.deployer as string, "deployer");
        if (a.pairToken !== undefined) checkAddress(a.pairToken as string, "pairToken");
        return pons.recentLaunches(client, a as pons.ScanOptsLike & { deployer?: string; pairToken?: string });
      },
    },
    {
      name: "pons_recent_graduations",
      description:
        "Scan factory PoolGraduated events newest-first: token, positionId, swept token/pair amounts, block, tx hash.",
      schema: { lookbackBlocks, limit },
      handler: (a) => pons.recentGraduations(client, a as pons.ScanOptsLike),
    },
    {
      name: "pons_creator_launches",
      description:
        "All launches by a given creator (TokenLaunched with deployer = creator), newest-first, with per-token graduated status.",
      schema: {
        creatorAddress: address.describe("Creator/deployer address"),
        lookbackBlocks,
        limit,
      },
      handler: (a) => {
        const c = a.creatorAddress as string;
        checkAddress(c, "creatorAddress");
        return pons.creatorLaunches(client, c, a as pons.ScanOptsLike);
      },
    },
    {
      name: "pons_curve_trades",
      description:
        "CurveBuy + CurveSell events on one bonding curve, decoded and merged newest-first with side, trader, recipient, amounts, fee, tax.",
      schema: {
        curveAddress: address.describe("Bonding curve contract address"),
        lookbackBlocks,
        limit,
      },
      handler: (a) => {
        const c = a.curveAddress as string;
        checkAddress(c, "curveAddress");
        return pons.curveTrades(client, c, a as pons.ScanOptsLike);
      },
    },
    {
      name: "pons_snipe_tax",
      description:
        "Live decaying snipe tax for a recipient on a curve (99% at launch → ~0% after 3s), exemption status, launchedAt, seconds since launch, and whether the tax window is still active.",
      schema: {
        curveAddress: address.describe("Bonding curve contract address"),
        recipient: address.optional().describe("Recipient to check (default: curve deployer)"),
      },
      handler: (a) => {
        const c = a.curveAddress as string;
        checkAddress(c, "curveAddress");
        if (a.recipient !== undefined) checkAddress(a.recipient as string, "recipient");
        return pons.snipeTax(client, c, a.recipient as string | undefined);
      },
    },
    {
      name: "pons_token_supply",
      description:
        "ERC-20 totalSupply and burned amounts (balances of 0x…dEaD and 0x0…0) with burn % of supply. Defaults to the PONS token.",
      schema: {
        tokenAddress: address.optional().describe("Token address (default: PONS token)"),
      },
      handler: (a) => {
        if (a.tokenAddress !== undefined) checkAddress(a.tokenAddress as string, "tokenAddress");
        return pons.tokenSupply(client, a.tokenAddress as string | undefined);
      },
    },
    {
      name: "pons_launch_costs",
      description:
        "Measured launch/buy/sell gas costs on Pons (static, measured 2026-09, clearly labelled) plus live eth_gasPrice for comparison.",
      schema: {},
      handler: () => pons.launchCosts(client),
    },
    {
      name: "pons_preview_launch",
      description:
        "Preview a launch config before launching: getLaunchConfig decoded (supply, curve fee, phantom quote, graduation threshold, pool fee/tick spacing, enabled), the previewLaunchEconomics bytes32 guard, and pair-token economics. Explains every field; performs no writes.",
      schema: {
        launchConfigId: z.number().int().min(0).optional().describe("Launch config index (default 0)"),
        pairToken: address.optional().describe("Quote asset (default: zero address = ETH-paired)"),
      },
      handler: (a) => {
        if (a.pairToken !== undefined) checkAddress(a.pairToken as string, "pairToken");
        return pons.previewLaunch(client, a.launchConfigId as number | undefined, a.pairToken as string | undefined);
      },
    },
    {
      name: "pons_quote_buy",
      description:
        "Quote a bonding-curve buy: local exact curve math (fees, creator tax, live snipe tax, clamp at reserved allocation) cross-checked against an on-chain eth_call of buy(). Returns tokensOut, fee legs, price impact, and the cross-check result.",
      schema: {
        curveAddress: address.describe("Bonding curve contract address"),
        amount: z.string().describe("Quote amount as a decimal string (ETH for native pairs, pair-token units otherwise)"),
        recipient: address.optional().describe("Recipient the snipe tax is priced for (default: 0x…dEaD)"),
      },
      handler: (a) => {
        checkAddress(a.curveAddress as string, "curveAddress");
        if (a.recipient !== undefined) checkAddress(a.recipient as string, "recipient");
        return trade.quoteBuyTool(client, a.curveAddress as string, a.amount as string, a.recipient as string | undefined);
      },
    },
    {
      name: "pons_quote_sell",
      description:
        "Quote a bonding-curve sell: local exact curve math (fees on output) cross-checked against an on-chain eth_call of sell() using state-diff overrides. Returns quoteOut, fee legs, price impact, and the cross-check result.",
      schema: {
        curveAddress: address.describe("Bonding curve contract address"),
        tokenAmount: z.string().describe("Token amount as a decimal string"),
        seller: address.optional().describe("Seller address used for the simulation (default: 0x…dEaD)"),
      },
      handler: (a) => {
        checkAddress(a.curveAddress as string, "curveAddress");
        if (a.seller !== undefined) checkAddress(a.seller as string, "seller");
        return trade.quoteSellTool(client, a.curveAddress as string, a.tokenAmount as string, a.seller as string | undefined);
      },
    },
    {
      name: "pons_pending_fee_change",
      description:
        "Read the factory's pendingCreatorFeeRecipient for a token: proposed recipient, proposed/executable timestamps, and window status (timelocked / executable / expired) using the live timelock and execution-window constants.",
      schema: { tokenAddress: address.describe("Launched token address") },
      handler: (a) => {
        checkAddress(a.tokenAddress as string, "tokenAddress");
        return pons.pendingFeeChange(client, a.tokenAddress as string);
      },
    },
    {
      name: "pons_quote_swap",
      description:
        "Quote a Uniswap V4 swap for a GRADUATED token via the on-chain V4Quoter (hook fees included). Native ETH-quoted and ERC-20-quoted pools. Returns amountOut, quoter gas estimate, pool key, sqrtPrice/tick/liquidity.",
      schema: {
        tokenAddress: address.describe("Graduated token address"),
        side: z.enum(["buy", "sell"]).describe("buy = quote asset in (ETH for native pools, the pair token otherwise), token out; sell = token in, quote asset out"),
        amount: z.string().describe("Input amount as a decimal string — for buys on ERC-20-quoted pools this is PAIR-TOKEN units (e.g. USDG, 6 decimals), NOT ETH; for sells it is tokens"),
      },
      handler: (a) => {
        checkAddress(a.tokenAddress as string, "tokenAddress");
        return quoteSwapTool(client, a.tokenAddress as string, a.side as "buy" | "sell", a.amount as string);
      },
    },
    {
      name: "pons_fee_balances",
      description:
        "Claimable fee balances in the shared PonsV2FeeEscrow for an address (native ETH always; per-token when tokenAddress is given), plus buyback-vault vesting state for a token (totalLocked, vested, releasable, terms). Read-only.",
      schema: {
        address: address.describe("Recipient address to check"),
        tokenAddress: address.optional().describe("Optional token: adds escrow token balance + buyback vesting state"),
      },
      handler: (a) => {
        checkAddress(a.address as string, "address");
        if (a.tokenAddress !== undefined) checkAddress(a.tokenAddress as string, "tokenAddress");
        return feeBalances(client, a.address as string, a.tokenAddress as string | undefined);
      },
    },
    {
      name: "pons_v1_get_token",
      description:
        "V1 (legacy, Uniswap V3 generation) Pons launch state: legacy-factory record (deployer, paired token, position, pool fee, initial buy), live graduationStatus (current/threshold/graduated), ERC-20 metadata, and getTokenInfo metadata (logo, description, socials). V1 is closed to new launches since 2026-08-12. Errors NOT_A_LAUNCH if the token is not in the legacy factory.",
      schema: { tokenAddress: address.describe("V1-launched token contract address") },
      handler: (a) => {
        checkAddress(a.tokenAddress as string, "tokenAddress");
        return v1GetToken(client, a.tokenAddress as string);
      },
    },
    {
      name: "pons_v1_launches",
      description:
        "Scan the V1 legacy factory's TokenLaunched events (Uniswap V3 generation), newest-first: token, deployer, dexFactory, pairToken, pool, positionId, initialBuyAmount, block, tx. Optional deployer filter (server-side topic).",
      schema: {
        lookbackBlocks,
        limit,
        deployer: address.optional().describe("Filter by deployer address"),
        fromBlock: z.number().int().min(0).optional().describe("Absolute start block for historical scans (V1 closed ~block 22M; lookback-from-latest can't reach it). Overrides lookbackBlocks."),
        toBlock: z.number().int().min(0).optional().describe("Absolute end block (default: latest)"),
      },
      handler: (a) => {
        if (a.deployer !== undefined) checkAddress(a.deployer as string, "deployer");
        return v1Launches(client, a as pons.ScanOptsLike & { deployer?: string; fromBlock?: number; toBlock?: number });
      },
    },
    {
      name: "pons_scan_interesting",
      description:
        "Score recent Pons v2 launches for traction using on-chain data only (unique buyers excluding deployer, ETH in the curve, buy/sell mix, age, serial-deployer filter). No LLM, no spend. Sorted by score descending.",
      schema: {
        lookbackBlocks,
        limit,
      },
      handler: (a) => {
        let cfg;
        try {
          cfg = parseScanConfig();
        } catch (e) {
          throw new pons.PonsError("INVALID_PARAMS", e instanceof Error ? e.message : String(e));
        }
        return scanInteresting(client, cfg, {
          lookbackBlocks: a.lookbackBlocks as number | undefined,
          limit: a.limit as number | undefined,
          ourAddress: signer?.address,
        });
      },
    },
  ];

  // Opt-in write capability: only registered when PONS_PRIVATE_KEY is set.
  if (signer !== null) {
    const caps: LaunchCaps = capsFromEnv();
    defs.push({
      name: "pons_launch_token",
      description:
        "WRITE — creates a token on the Pons v2 factory, spending real ETH from the configured signer. " +
        "Defaults to dryRun=true: simulates via eth_call and returns a full cost preview (launchFee + devBuy + gas, calldata, predicted token/curve) without broadcasting. " +
        "Broadcasts only when dryRun=false AND confirm=true. A devBuyEth > 0 routes atomically through the launchAndBuy router (the factory launchToken requires msg.value == launchFee exactly, and the 99% same-block snipe tax makes a non-atomic dev buy impractical). " +
        "Caps: PONS_MAX_DEV_BUY_ETH (default 0.05) and PONS_MAX_LAUNCHES_PER_DAY (default 5). Note: the CREATE2 salt derives from name+symbol, so relaunching identical terms reverts.",
      schema: {
        name: z.string().min(1).max(64).describe("Token name (max 64 bytes utf8)"),
        symbol: z.string().min(1).max(16).describe("Token symbol (max 16 bytes utf8)"),
        logo: z.string().optional().describe("Logo URL (max 512 bytes)"),
        description: z.string().optional().describe("Description (max 2048 bytes)"),
        socials: z
          .object({
            twitter: z.string().optional(),
            telegram: z.string().optional(),
            discord: z.string().optional(),
            website: z.string().optional(),
            farcaster: z.string().optional(),
          })
          .optional(),
        creatorFeeRecipient: address.optional().describe("Who earns creator fees (default: signer)"),
        creatorTaxBps: z.number().int().min(0).max(10_000).optional().describe("Creator tax in bps (default 0; capped by factory maxCreatorTaxBps)"),
        buybackEnabled: z.boolean().optional().describe("Enable buyback vault (default false)"),
        launchConfigId: z.number().int().min(0).optional().describe("Launch config index (default 0)"),
        pairToken: address.optional().describe("Quote asset (default: zero address = ETH-paired)"),
        devBuyEth: z.string().optional().describe('Opening buy in ETH, decimal string (default "0"; ETH pairs only)'),
        snipeTaxExemptions: z.array(address).optional().describe("Snipe-tax-exempt addresses (max 32; 31 with dev buy)"),
        acceptContractDrift: z.boolean().optional().describe("Acknowledge that the live launchForwarder differs from the pinned router address; required to broadcast a dev buy while drifted"),
        dryRun: z.boolean().optional().describe("Simulate only, do not broadcast (default true)"),
        confirm: z.boolean().optional().describe("Must be true together with dryRun=false to broadcast"),
      },
      handler: (a) => {
        for (const field of ["creatorFeeRecipient", "pairToken"] as const) {
          if (a[field] !== undefined) checkAddress(a[field] as string, field);
        }
        (a.snipeTaxExemptions as string[] | undefined)?.forEach((x, i) => checkAddress(x, `snipeTaxExemptions[${i}]`));
        return launchToken(client, signer, a as unknown as Parameters<typeof launchToken>[2], caps);
      },
    });

    const dryRunField = z.boolean().optional().describe("Simulate only, do not broadcast (default true)");
    const confirmField = z.boolean().optional().describe("Must be true together with dryRun=false to broadcast");
    const wopts = (a: Record<string, unknown>) => ({ dryRun: a.dryRun as boolean | undefined, confirm: a.confirm as boolean | undefined });

    defs.push(
      {
        name: "pons_buy",
        description:
          "WRITE — buy on a bonding curve. Native pairs send ETH as value; ERC-20 pairs auto-bundle an exact-amount approve when allowance is insufficient. minTokensOut defaults to quote minus 5% slippage. Dry-run by default.",
        schema: {
          curveAddress: address.describe("Bonding curve contract address"),
          amount: z.string().describe("Quote amount as decimal string (ETH for native pairs, pair-token units otherwise)"),
          minTokensOut: z.string().optional().describe("Minimum tokens out (decimal string, token units; default: quote - 5%)"),
          recipient: address.optional().describe("Token recipient (default: signer)"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          if (a.recipient !== undefined) checkAddress(a.recipient as string, "recipient");
          return trade.buyTool(client, signer, a.curveAddress as string, a.amount as string, a.minTokensOut as string | undefined, a.recipient as string | undefined, wopts(a));
        },
      },
      {
        name: "pons_sell",
        description:
          "WRITE — sell tokens on a bonding curve. Auto-bundles an exact-amount ERC-20 approve(curve, amount) when allowance is insufficient (broadcast: approve first, wait, then sell). minQuoteOut defaults to quote minus 5% slippage. Dry-run by default.",
        schema: {
          curveAddress: address.describe("Bonding curve contract address"),
          tokenAmount: z.string().describe("Token amount as a decimal string"),
          minQuoteOut: z.string().optional().describe("Minimum quote out (decimal string; default: quote - 5%)"),
          recipient: address.optional().describe("Quote recipient (default: signer)"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          if (a.recipient !== undefined) checkAddress(a.recipient as string, "recipient");
          return trade.sellTool(client, signer, a.curveAddress as string, a.tokenAmount as string, a.minQuoteOut as string | undefined, a.recipient as string | undefined, wopts(a));
        },
      },
      {
        name: "pons_graduate",
        description:
          "WRITE (permissionless) — finish a curve that raised its threshold. phase 'sweep' calls factory.graduate(token), 'pool' calls createGraduatedPool(token), 'both' (default) does both in sequence. Clear error with current progress when not ready.",
        schema: {
          token: address.describe("Token OR curve address"),
          phase: z.enum(["sweep", "pool", "both"]).optional().describe("Which graduation step(s) (default both)"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.token as string, "token");
          return trade.graduateTool(client, signer, a.token as string, (a.phase as "sweep" | "pool" | "both" | undefined) ?? "both", wopts(a));
        },
      },
      {
        name: "pons_set_creator_fee_recipient",
        description:
          "WRITE — transfer the creator fee recipient of a token to a new address (factory transferCreatorFeeRecipient). Verified on-chain: this creator self-service call takes effect IMMEDIATELY on broadcast — no timelock, no pending entry, nothing to execute later. Caller must be the current creatorFeeRecipient.",
        schema: {
          tokenAddress: address.describe("Launched token address"),
          recipient: address.describe("New creator fee recipient"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.tokenAddress as string, "tokenAddress");
          checkAddress(a.recipient as string, "recipient");
          return trade.setCreatorFeeRecipientTool(client, signer, a.tokenAddress as string, a.recipient as string, wopts(a));
        },
      },
      {
        name: "pons_execute_fee_recipient_change",
        description: "WRITE — execute a pending owner-initiated creator fee recipient change within its execution window (factory executeCreatorFeeRecipientChange; permissionless). Note: creator self-service transfers (pons_set_creator_fee_recipient) apply immediately and create no pending entry.",
        schema: { tokenAddress: address.describe("Launched token address"), dryRun: dryRunField, confirm: confirmField },
        handler: (a) => {
          checkAddress(a.tokenAddress as string, "tokenAddress");
          return trade.executeFeeRecipientChangeTool(client, signer, a.tokenAddress as string, wopts(a));
        },
      },
      {
        name: "pons_cancel_fee_recipient_change",
        description: "WRITE — cancel a pending creator fee recipient change (factory cancelCreatorFeeRecipientChange).",
        schema: { tokenAddress: address.describe("Launched token address"), dryRun: dryRunField, confirm: confirmField },
        handler: (a) => {
          checkAddress(a.tokenAddress as string, "tokenAddress");
          return trade.cancelFeeRecipientChangeTool(client, signer, a.tokenAddress as string, wopts(a));
        },
      },
      {
        name: "pons_exempt_snipe_tax",
        description:
          "IMPOSSIBLE BY CONSTRUCTION (verified on-chain): curve.exemptFromSnipeTax is factory-internal and reverts NotFactory for any external caller; the factory exposes no wrapper. Snipe-tax exemptions can only be set at launch via snipeTaxExemptions in pons_launch_token. This tool always fails with an explanatory error.",
        schema: {
          curveAddress: address.describe("Bonding curve contract address"),
          account: address.describe("Address to exempt"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          checkAddress(a.account as string, "account");
          return trade.exemptSnipeTaxTool(client, signer, a.curveAddress as string, a.account as string, wopts(a));
        },
      },
      {
        name: "pons_set_buyback",
        description: "WRITE — enable or disable the buyback vault for a launch: factory.setBuybackEnabled(token, enabled). Enabling requires the current creator fee recipient; the owner can also disable. Accepts the curve or token address.",
        schema: {
          curveAddress: address.describe("Bonding curve (or token) contract address"),
          enabled: z.boolean(),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          return trade.setBuybackTool(client, signer, a.curveAddress as string, a.enabled as boolean, wopts(a));
        },
      },
      {
        name: "pons_sweep_curve_fees",
        description: "WRITE — sweep ALL accrued fees from a curve (curve sweepFees(minBuybackTokensOut)). Sweeps everything; the parameter is a token-denominated minimum-output floor for the internal buyback swap (must be > 0 when a buyback balance is pending, and only the operator may sweep then).",
        schema: {
          curveAddress: address.describe("Bonding curve contract address"),
          minBuybackTokensOut: z.string().optional().describe('Minimum tokens the internal buyback swap must return, decimal string in token units (default "0")'),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          return trade.sweepCurveFeesTool(client, signer, a.curveAddress as string, a.minBuybackTokensOut as string | undefined, wopts(a));
        },
      },
      {
        name: "pons_rescue_curve_fees",
        description: "WRITE (owner-gated) — rescue stuck fees for a launch: factory.rescueCurveFees(token). Accepts the curve or token address.",
        schema: { curveAddress: address.describe("Bonding curve (or token) contract address"), dryRun: dryRunField, confirm: confirmField },
        handler: (a) => {
          checkAddress(a.curveAddress as string, "curveAddress");
          return trade.rescueCurveFeesTool(client, signer, a.curveAddress as string, wopts(a));
        },
      },
      {
        name: "pons_admin_call",
        description:
          "WRITE (owner-only) — generic factory owner call. fn is an enum over the factory's owner functions; args is a typed object per fn (addresses as 0x strings, integers as strings/numbers, ETH amounts as decimal strings, e.g. setLaunchFee {launchFee: '0.0005'}, setPairTokenEconomics {pairToken, phantomQuote, graduationThreshold, decimals}, setCreatorFeeRecipient {token, newRecipient} — the timelocked owner override, addLaunchConfig/updateLaunchConfig {supply, curveFeeBps, phantomQuote, graduationThreshold, poolFee, tickSpacing, enabled, decimals?}). renounceOwnership additionally requires iUnderstandIrreversible: true. Reverts for non-owners — the dry-run simulation shows it.",
        schema: {
          fn: z.enum(ADMIN_FNS),
          args: z.record(z.unknown()).optional().describe("Typed args object for the chosen fn"),
          iUnderstandIrreversible: z.boolean().optional().describe("Required true for renounceOwnership"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) =>
          adminCallTool(client, signer, a.fn as (typeof ADMIN_FNS)[number], (a.args as Record<string, unknown>) ?? {}, a.iUnderstandIrreversible as boolean | undefined, wopts(a)),
      },
      {
        name: "pons_claim_fees",
        description:
          "WRITE — claim your accrued fees from the shared fee escrow (PonsV2FeeEscrow). Omit tokenAddress for native ETH; omit amount to claim the entire balance. Pays msg.sender. Dry-run by default.",
        schema: {
          tokenAddress: address.optional().describe("Claim this ERC-20 instead of native ETH"),
          amount: z.string().optional().describe("Partial amount, decimal string (default: entire balance)"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          if (a.tokenAddress !== undefined) checkAddress(a.tokenAddress as string, "tokenAddress");
          return claimFeesTool(client, signer, a.tokenAddress as string | undefined, a.amount as string | undefined, wopts(a));
        },
      },
      {
        name: "pons_release_buyback",
        description:
          "WRITE — release the currently vested slice of a launch's buyback vault lock (5-year linear vesting) into the fee escrow, split creator/protocol by the launch's frozen terms. Callable only by the vest's creator or protocol recipient (else reverts NotVestBeneficiary). Claim afterwards with pons_claim_fees. Dry-run by default.",
        schema: {
          tokenAddress: address.describe("Launched token whose buyback vest to release"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.tokenAddress as string, "tokenAddress");
          return releaseBuybackTool(client, signer, a.tokenAddress as string, wopts(a));
        },
      },
      {
        name: "pons_swap",
        description:
          "WRITE — swap a GRADUATED token on its Uniswap V4 pool via the Universal Router. Native (ETH) and ERC-20-quoted pools both supported. Buy with ETH: one V4_SWAP command, ETH as value. Any ERC-20 input (selling the token, or buying with a pair token): unlimited ERC-20 approve to Permit2 if needed, then PERMIT2_PERMIT (EIP-712 signature, 30 min, exact amount, signed only when broadcasting) + V4_SWAP. Quote from the on-chain V4Quoter; minOut defaults to quote minus 5%. Dry-run by default.",
        schema: {
          tokenAddress: address.describe("Graduated token address"),
          side: z.enum(["buy", "sell"]),
          amount: z.string().describe("Input amount as decimal string — for buys on ERC-20-quoted pools this is PAIR-TOKEN units (e.g. USDG, 6 decimals), NOT ETH; for sells it is tokens"),
          minOut: z.string().optional().describe("Minimum output, decimal string in OUTPUT units (tokens for buy; quote asset for sell; default: quote - 5%)"),
          acceptContractDrift: z.boolean().optional().describe("Acknowledge that the live memeHook differs from the pinned hook address; required to broadcast while drifted"),
          dryRun: dryRunField,
          confirm: confirmField,
        },
        handler: (a) => {
          checkAddress(a.tokenAddress as string, "tokenAddress");
          return swapTool(client, signer, a.tokenAddress as string, a.side as "buy" | "sell", a.amount as string, a.minOut as string | undefined, { ...wopts(a), acceptContractDrift: a.acceptContractDrift as boolean | undefined });
        },
      },
    );
  }

  return defs.map((d) => ({ ...d, handler: wrap(d.handler) }));
}

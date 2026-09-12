// On-chain traction scoring for recent launches (pons_scan_interesting). No LLM, no spend.
import { encodeCall, SEL } from "./abi.js";
import { formatEth, parseUnits, pct } from "./format.js";
import { curveTrades, getToken, recentLaunches } from "./pons.js";
import type { RpcClient } from "./rpc.js";
import { decodeTokenInfo } from "./v1.js";

export interface TokenSnapshot {
  token: string;
  curve: string;
  deployer: string;
  name: string;
  symbol: string;
  description: string;
  logo: string;
  isNativeQuote: boolean;
  graduated: boolean;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  launchedAt: number;
  nowSec: number;
}

export interface TradeSummary {
  buyCount: number;
  sellCount: number;
  uniqueBuyersExDeployer: number;
}

export interface ScoreGates {
  minUniqueBuyers: number;
  minQuoteWei: bigint;
  minAgeSec: number;
  maxAgeSec: number;
  maxDeployerLaunches: number;
  ourAddress?: string;
}

export interface ScoreResult {
  pass: boolean;
  score: number;
  reasons: string[];
  ageSec: number;
}

export function summarizeTrades(
  trades: { side: string; trader: string }[],
  deployer: string,
): TradeSummary {
  const dep = deployer.toLowerCase();
  const buyers = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      buyCount++;
      const trader = t.trader.toLowerCase();
      if (trader !== dep) buyers.add(trader);
    } else if (t.side === "sell") {
      sellCount++;
    }
  }
  return { buyCount, sellCount, uniqueBuyersExDeployer: buyers.size };
}

function cap(n: number, max: number): number {
  return n > max ? max : n;
}

/** 0–100 ranking score. Gates decide pass/fail independently. */
export function rankScore(snap: TokenSnapshot, trades: TradeSummary): number {
  const uniqueScore = cap(trades.uniqueBuyersExDeployer * 4, 40);
  // 0.5 ETH of real quote → 30 points.
  const halfEth = 5n * 10n ** 17n;
  const quoteScore = Number(snap.realQuoteReserve >= halfEth ? 30n : (snap.realQuoteReserve * 30n) / halfEth);
  const totalTrades = trades.buyCount + trades.sellCount;
  const buySellScore =
    totalTrades === 0 || trades.buyCount < trades.sellCount
      ? 0
      : cap(Math.floor((15 * trades.buyCount) / totalTrades), 15);
  const gradScore =
    snap.graduationThreshold <= 0n
      ? 0
      : Number(
          snap.realQuoteReserve >= snap.graduationThreshold
            ? 15n
            : (snap.realQuoteReserve * 15n) / snap.graduationThreshold,
        );
  return uniqueScore + quoteScore + buySellScore + gradScore;
}

export function scoreToken(
  snap: TokenSnapshot,
  trades: TradeSummary,
  gates: ScoreGates,
  deployerLaunchCount: number,
): ScoreResult {
  const fails: string[] = [];
  const ageSec = snap.nowSec - snap.launchedAt;
  if (!snap.isNativeQuote) fails.push("not ETH-paired");
  if (snap.graduated) fails.push("already graduated");
  if (ageSec < gates.minAgeSec) fails.push(`too new (${ageSec}s < ${gates.minAgeSec}s)`);
  if (ageSec > gates.maxAgeSec) fails.push(`too old (${ageSec}s > ${gates.maxAgeSec}s)`);
  if (trades.uniqueBuyersExDeployer < gates.minUniqueBuyers) {
    fails.push(`unique buyers ${trades.uniqueBuyersExDeployer} < ${gates.minUniqueBuyers}`);
  }
  if (snap.realQuoteReserve < gates.minQuoteWei) {
    fails.push(`quote ${formatEth(snap.realQuoteReserve)} < ${formatEth(gates.minQuoteWei)}`);
  }
  if (trades.buyCount < trades.sellCount) {
    fails.push(`more sells than buys (${trades.sellCount} > ${trades.buyCount})`);
  }
  if (gates.ourAddress && snap.deployer.toLowerCase() === gates.ourAddress.toLowerCase()) {
    fails.push("own deployer");
  }
  if (deployerLaunchCount > gates.maxDeployerLaunches) {
    fails.push(`serial deployer (${deployerLaunchCount} launches in window > ${gates.maxDeployerLaunches})`);
  }
  const pass = fails.length === 0;
  const reasons = pass
    ? [
        `${trades.uniqueBuyersExDeployer} unique buyers, ${formatEth(snap.realQuoteReserve)} in, ${pct(snap.realQuoteReserve, snap.graduationThreshold)} to graduation`,
      ]
    : fails;
  return { pass, score: rankScore(snap, trades), reasons, ageSec };
}


export interface ScanConfig {
  lookbackBlocks: number;
  scanLimit: number;
  tradeLimit: number;
  gates: Omit<ScoreGates, "ourAddress">;
}

function parseNonNegInt(env: NodeJS.ProcessEnv, key: string, def: string, min?: number, max?: number): number {
  const raw = env[key] ?? def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got: ${raw}`);
  if (min !== undefined && n < min) throw new Error(`${key} must be >= ${min}, got: ${raw}`);
  if (max !== undefined && n > max) throw new Error(`${key} must be <= ${max}, got: ${raw}`);
  return n;
}

/** Fail-closed env parse for the scan gates. Malformed values throw rather than disabling a gate. */
export function parseScanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  const minAgeSec = parseNonNegInt(env, "PONS_SCAN_MIN_AGE_SEC", "30");
  const maxAgeSec = parseNonNegInt(env, "PONS_SCAN_MAX_AGE_SEC", "1200", 1);
  if (maxAgeSec < minAgeSec) throw new Error(`PONS_SCAN_MAX_AGE_SEC (${maxAgeSec}) must be >= PONS_SCAN_MIN_AGE_SEC (${minAgeSec})`);
  return {
    lookbackBlocks: parseNonNegInt(env, "PONS_SCAN_LOOKBACK_BLOCKS", "10000", 1, 500_000),
    scanLimit: parseNonNegInt(env, "PONS_SCAN_LIMIT", "20", 1, 100),
    tradeLimit: parseNonNegInt(env, "PONS_SCAN_TRADE_LIMIT", "100", 1, 100),
    gates: {
      minUniqueBuyers: parseNonNegInt(env, "PONS_SCAN_MIN_UNIQUE_BUYERS", "3"),
      minQuoteWei: parseUnits(env.PONS_SCAN_MIN_QUOTE_ETH ?? "0.05", 18),
      minAgeSec,
      maxAgeSec,
      maxDeployerLaunches: parseNonNegInt(env, "PONS_SCAN_MAX_DEPLOYER_LAUNCHES", "5"),
    },
  };
}

async function probeTokenMeta(client: RpcClient, token: string): Promise<{ logo: string; description: string }> {
  try {
    const ret = await client.ethCall(token, encodeCall(SEL.v1GetTokenInfo));
    const info = decodeTokenInfo(ret);
    return { logo: info.logo ?? "", description: info.description ?? "" };
  } catch {
    return { logo: "", description: "" };
  }
}

export async function hydrateToken(
  client: RpcClient,
  tokenAddress: string,
  cfg: Pick<ScanConfig, "lookbackBlocks" | "tradeLimit">,
  nowSec: number,
): Promise<{ snapshot: TokenSnapshot; trades: TradeSummary }> {
  const [state, meta] = await Promise.all([getToken(client, tokenAddress), probeTokenMeta(client, tokenAddress)]);
  const curve = state.launch.curve;
  const tradesRaw = await curveTrades(client, curve, { lookbackBlocks: cfg.lookbackBlocks, limit: cfg.tradeLimit });
  const snapshot: TokenSnapshot = {
    token: state.token.address.toLowerCase(),
    curve: curve.toLowerCase(),
    deployer: state.launch.deployer.toLowerCase(),
    name: state.token.name ?? "",
    symbol: state.token.symbol ?? "",
    description: meta.description,
    logo: meta.logo,
    isNativeQuote: state.quote.isNativeQuote,
    graduated: state.launch.graduated,
    realQuoteReserve: BigInt(state.quote.realQuoteReserve),
    graduationThreshold: BigInt(state.quote.graduationThreshold),
    launchedAt: state.launch.launchedAt,
    nowSec,
  };
  return { snapshot, trades: summarizeTrades(tradesRaw.trades, snapshot.deployer) };
}

export interface ScoredLaunch {
  token: string;
  curve: string;
  deployer: string;
  name: string;
  symbol: string;
  score: number;
  pass: boolean;
  reasons: string[];
  ageSec: number;
  uniqueBuyersExDeployer: number;
  buyCount: number;
  sellCount: number;
  realQuote: string;
  graduationProgress: string;
  launchedAt: number;
  launchedAtIso: string;
  deployerLaunchCount: number;
}

export async function scanInteresting(
  client: RpcClient,
  cfg: ScanConfig,
  opts: { lookbackBlocks?: number; limit?: number; ourAddress?: string; nowSec?: number } = {},
): Promise<{ count: number; launches: ScoredLaunch[] }> {
  const lookback = opts.lookbackBlocks ?? cfg.lookbackBlocks;
  const limit = opts.limit ?? cfg.scanLimit;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const found = await recentLaunches(client, { lookbackBlocks: lookback, limit });
  const counts = new Map<string, number>();
  for (const l of found.launches) {
    const d = l.deployer.toLowerCase();
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const gates: ScoreGates = { ...cfg.gates, ourAddress: opts.ourAddress };
  const launches: ScoredLaunch[] = [];
  for (const l of found.launches) {
    try {
      const { snapshot, trades } = await hydrateToken(client, l.token, cfg, nowSec);
      const deployerLaunchCount = counts.get(snapshot.deployer) ?? 1;
      const score = scoreToken(snapshot, trades, gates, deployerLaunchCount);
      launches.push({
        token: snapshot.token, curve: snapshot.curve, deployer: snapshot.deployer, name: snapshot.name, symbol: snapshot.symbol,
        score: score.score, pass: score.pass, reasons: score.reasons, ageSec: score.ageSec,
        uniqueBuyersExDeployer: trades.uniqueBuyersExDeployer, buyCount: trades.buyCount, sellCount: trades.sellCount,
        realQuote: formatEth(snapshot.realQuoteReserve), graduationProgress: pct(snapshot.realQuoteReserve, snapshot.graduationThreshold),
        launchedAt: snapshot.launchedAt, launchedAtIso: new Date(snapshot.launchedAt * 1000).toISOString(), deployerLaunchCount,
      });
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: "hydrate_failed", token: l.token, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  launches.sort((a, b) => b.score - a.score || a.ageSec - b.ageSec);
  return { count: launches.length, launches };
}

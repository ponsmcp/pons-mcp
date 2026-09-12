import {
  SEL,
  TOPIC,
  encodeAddress,
  encodeCall,
  encodeUint,
  words,
  decodeUint,
  decodeInt24,
  decodeBool,
  decodeAddress,
  decodeAbiString,
  topicAddress,
} from "./abi.js";
import { RpcClient, RpcError, RpcLog } from "./rpc.js";
import { formatUnits, formatEth, formatGwei, formatBps, pct, isZeroAddress } from "./format.js";

export const CHAIN_ID = 4663;
export const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const LAUNCH_AND_BUY_ROUTER = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948";
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
// Hook on every graduated V4 pool (docs/PROTOCOL.md). Read live from the
// factory at use time; this pinned value detects endpoint/owner drift.
export const MEME_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
// Shared satellites (verified against the live factory reads, 2026-09):
// claimable-fee ledger and the 5-year buyback vesting vault.
export const FEE_ESCROW = "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e";
export const BUYBACK_VAULT = "0x42df2a798f82289e177311362e8f5ccc45c1219c";
// V1 (legacy, Uniswap V3 generation) — closed to new launches since
// 2026-08-12. Verified: created the PONS token (block 8963150) and emits the
// documented legacy TokenLaunched event. Read-only support.
export const V1_FACTORY = "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";
export const V1_LOCKER = "0x31ca5E101941A93A7DD6d0497928700625CF54B5";
export const PONS_TOKEN = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const BURN_DEAD = "0x000000000000000000000000000000000000dEaD";
export const BURN_ZERO = "0x0000000000000000000000000000000000000000";

export class PonsError extends Error {
  constructor(
    public code: "INVALID_ADDRESS" | "NOT_A_LAUNCH" | "INVALID_PARAMS" | "CAP_EXCEEDED" | "WRITE_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "PonsError";
  }
}

// PonsV2LaunchFactory phase enum: 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued.
export const GRADUATION_PHASES = ["NotGraduated", "Swept", "PoolCreated", "Rescued"] as const;

// ---------- low-level call helpers ----------

export async function callWord(client: RpcClient, to: string, sel: string, ...args: string[]): Promise<string> {
  const ret = await client.ethCall(to, encodeCall(sel, ...args));
  const w = words(ret);
  if (w.length === 0) {
    // An eth_call to an EOA or a contract without this method returns "0x"
    // with success — nothing reverted, the target just has nothing to say.
    throw new RpcError("REVERTED", `empty return from ${to} ${sel} (target has no code or does not implement this method)`);
  }
  return w[0];
}

export const callUint = (c: RpcClient, to: string, sel: string, ...a: string[]) =>
  callWord(c, to, sel, ...a).then(decodeUint);
export const callBool = (c: RpcClient, to: string, sel: string, ...a: string[]) =>
  callWord(c, to, sel, ...a).then(decodeBool);
export const callAddress = (c: RpcClient, to: string, sel: string, ...a: string[]) =>
  callWord(c, to, sel, ...a).then(decodeAddress);

interface Erc20Meta {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
}

// Constructor-immutable ERC-20 fields (name/symbol/decimals) are cached per
// address — they are set at deployment and cannot change on non-proxy tokens.
// Only successful reads are cached: a transient RPC failure must not pin
// missing metadata. totalSupply/balances are mutable and never cached.
const metaCache = new Map<string, Erc20Meta>();

export async function erc20Meta(client: RpcClient, token: string, withSupply = false): Promise<Erc20Meta> {
  const key = token.toLowerCase();
  const cached = metaCache.get(key);
  if (cached !== undefined && !withSupply) return { ...cached };
  const meta: Erc20Meta = cached !== undefined ? { ...cached } : {};
  const safe = <T>(p: Promise<T>): Promise<T | undefined> =>
    p.catch((e) => (e instanceof RpcError && e.code === "REVERTED" ? undefined : Promise.reject(e)));
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    meta.name !== undefined ? Promise.resolve(meta.name) : safe(client.ethCall(token, encodeCall(SEL.name)).then(decodeAbiString)),
    meta.symbol !== undefined ? Promise.resolve(meta.symbol) : safe(client.ethCall(token, encodeCall(SEL.symbol)).then(decodeAbiString)),
    meta.decimals !== undefined ? Promise.resolve(meta.decimals) : safe(callUint(client, token, SEL.decimals).then((d) => {
      // A malicious token can report an absurd decimals value; unbounded it
      // becomes a memory-DoS via padStart in formatUnits. Treat as unknown.
      const n = Number(d);
      return Number.isInteger(n) && n >= 0 && n <= 36 ? n : undefined;
    })),
    withSupply ? safe(callUint(client, token, SEL.totalSupply)) : Promise.resolve(undefined),
  ]);
  // Empty-string metadata (contract returned no/empty data) counts as absent
  // so downstream formatters fall back instead of printing trailing spaces.
  if (name) meta.name = name;
  if (symbol) meta.symbol = symbol;
  if (decimals !== undefined) meta.decimals = decimals;
  if (totalSupply !== undefined) meta.totalSupply = totalSupply;
  // Cache only when every immutable field resolved (partial results retry).
  if (cached === undefined && meta.decimals !== undefined) metaCache.set(key, { ...meta });
  return meta;
}

function quoteFormatter(isNative: boolean, pairMeta: Erc20Meta) {
  if (isNative) return (v: bigint) => formatEth(v);
  const decimals = pairMeta.decimals ?? 18;
  const symbol = pairMeta.symbol ?? "pair-token units";
  return (v: bigint) => `${formatUnits(v, decimals)} ${symbol}`;
}

// ---------- factory / curve decoders ----------

export interface LaunchConfig {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: bigint;
  tickSpacing: bigint;
  enabled: boolean;
}

function decodeLaunchConfig(ret: string): LaunchConfig {
  const w = words(ret);
  if (w.length < 7) throw new RpcError("RPC_FAILURE", "getLaunchConfig returned too few words");
  return {
    supply: decodeUint(w[0]),
    curveFeeBps: decodeUint(w[1]),
    phantomQuote: decodeUint(w[2]),
    graduationThreshold: decodeUint(w[3]),
    poolFee: decodeUint(w[4]),
    tickSpacing: decodeInt24(w[5]),
    enabled: decodeBool(w[6]),
  };
}

export interface LaunchedToken {
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  graduationThreshold: bigint;
  poolFee: bigint;
  tickSpacing: bigint;
  creatorTaxBps: bigint;
  buybackEnabled: boolean;
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
}

function decodeLaunchedToken(ret: string): LaunchedToken {
  const w = words(ret);
  if (w.length < 15) throw new RpcError("RPC_FAILURE", "getLaunchedToken returned too few words");
  return {
    token: decodeAddress(w[0]),
    curve: decodeAddress(w[1]),
    deployer: decodeAddress(w[2]),
    creatorFeeRecipient: decodeAddress(w[3]),
    pairToken: decodeAddress(w[4]),
    graduationThreshold: decodeUint(w[5]),
    poolFee: decodeUint(w[6]),
    tickSpacing: decodeInt24(w[7]),
    creatorTaxBps: decodeUint(w[8]),
    buybackEnabled: decodeBool(w[9]),
    phase: Number(decodeUint(w[10])),
    sweptQuote: decodeUint(w[11]),
    sweptTokens: decodeUint(w[12]),
    sweptAt: decodeUint(w[13]),
    exists: decodeBool(w[14]),
  };
}

export async function getLaunchedToken(client: RpcClient, token: string): Promise<LaunchedToken> {
  const ret = await client.ethCall(FACTORY, encodeCall(SEL.getLaunchedToken, encodeAddress(token)));
  return decodeLaunchedToken(ret);
}

// ---------- tool implementations ----------

export async function protocolOverview(client: RpcClient) {
  await client.assertChain(CHAIN_ID);
  const [block, launchFee, launchEnabled, maxCreatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, configCount] =
    await Promise.all([
      client.blockNumber(),
      callUint(client, FACTORY, SEL.launchFee),
      callBool(client, FACTORY, SEL.launchEnabled),
      callUint(client, FACTORY, SEL.maxCreatorTaxBps),
      callUint(client, FACTORY, SEL.snipeTaxStartBps),
      callUint(client, FACTORY, SEL.snipeTaxSeconds),
      callUint(client, FACTORY, SEL.launchConfigCount),
    ]);
  // Fan out one call per config, but bound it: the count is chain-supplied.
  const configCountSafe = configCount > 64n ? 64n : configCount;
  const configs = await Promise.all(
    Array.from({ length: Number(configCountSafe) }, (_, i) =>
      client
        .ethCall(FACTORY, encodeCall(SEL.getLaunchConfig, encodeUint(i)))
        .then(decodeLaunchConfig)
        .then((cfg) => ({ index: i, ...cfg })),
    ),
  );
  // Satellites and timelock constants — read live; several are owner-settable.
  const addr = (sel: string) => callAddress(client, FACTORY, sel);
  const num = (sel: string) => callUint(client, FACTORY, sel);
  const [
    owner, pendingOwner, locker, memeHook, feeEscrow, buybackVault, poolManager, positionManager,
    permit2, launchDeployer, launchForwarder, graduationExecutor, graduationGuard,
    feeRecipientTimelock, feeRecipientWindow, graduationRescueDelay,
  ] = await Promise.all([
    addr(SEL.owner), addr(SEL.pendingOwner), addr(SEL.locker), addr(SEL.memeHook), addr(SEL.feeEscrow),
    addr(SEL.buybackVault), addr(SEL.poolManager), addr(SEL.positionManager), addr(SEL.permit2),
    addr(SEL.launchDeployer), addr(SEL.launchForwarder), addr(SEL.graduationExecutor), addr(SEL.graduationGuard),
    num(SEL.feeRecipientTimelock), num(SEL.feeRecipientWindow), num(SEL.graduationRescueDelay),
  ]);
  return {
    chainId: CHAIN_ID,
    network: "Robinhood Chain",
    latestBlock: Number(block),
    factory: {
      launchFeeWei: launchFee.toString(),
      launchFee: formatEth(launchFee),
      launchEnabled,
      maxCreatorTaxBps: Number(maxCreatorTaxBps),
      maxCreatorTax: formatBps(maxCreatorTaxBps),
      snipeTaxStartBps: Number(snipeTaxStartBps),
      snipeTaxStart: formatBps(snipeTaxStartBps),
      snipeTaxSeconds: Number(snipeTaxSeconds),
      launchConfigCount: Number(configCount),
      launchConfigsTruncated: configCount > configCountSafe || undefined,
      launchConfigs: configs.map((c) => ({
        ...c,
        supply: c.supply.toString(),
        curveFeeBps: Number(c.curveFeeBps),
        phantomQuote: c.phantomQuote.toString(),
        graduationThreshold: c.graduationThreshold.toString(),
        poolFee: Number(c.poolFee),
        tickSpacing: Number(c.tickSpacing),
      })),
    },
    governance: {
      owner,
      pendingOwner,
      creatorFeeRecipientTimelockSeconds: Number(feeRecipientTimelock),
      creatorFeeRecipientExecutionWindowSeconds: Number(feeRecipientWindow),
      graduationRescueDelaySeconds: Number(graduationRescueDelay),
    },
    contracts: {
      factory: FACTORY,
      launchAndBuyRouter: LAUNCH_AND_BUY_ROUTER,
      launchForwarderLive: launchForwarder,
      launchDeployer,
      uniswapV4PoolManager: UNISWAP_V4_POOL_MANAGER,
      poolManagerLive: poolManager,
      positionManager,
      permit2,
      locker,
      memeHook,
      feeEscrow,
      buybackVault,
      graduationExecutor,
      graduationGuard,
      ponsToken: PONS_TOKEN,
    },
    explorer: EXPLORER,
  };
}

async function curveState(client: RpcClient, curve: string) {
  const [
    realQuoteReserve,
    reserves,
    phantomQuote,
    graduationThreshold,
    graduated,
    readyToGraduate,
    launchedAt,
    isNativeQuote,
    pairToken,
    feeBps,
    creatorTaxBps,
    buybackEnabled,
    deployer,
    launchSupply,
    reservedTokens,
    sellableTokens,
    trackedQuote,
    trackedTokens,
    quoteFeeBalance,
    creatorTaxBalance,
    buybackQuoteBalance,
    protocolFeeRecipient,
    protocolFeeShareBps,
    buybackBurnBps,
    maxInternalPriceImpactBps,
  ] = await Promise.all([
    callUint(client, curve, SEL.realQuoteReserve),
    // One call returns both reserves.
    client.ethCall(curve, encodeCall(SEL.getReserves)).then((ret) => {
      const w = words(ret);
      if (w.length < 2) throw new RpcError("RPC_FAILURE", "getReserves returned too few words");
      return { quoteReserve: decodeUint(w[0]), tokenReserve: decodeUint(w[1]) };
    }),
    callUint(client, curve, SEL.phantomQuote),
    callUint(client, curve, SEL.graduationThreshold),
    callBool(client, curve, SEL.graduated),
    callBool(client, curve, SEL.readyToGraduate),
    callUint(client, curve, SEL.launchedAt),
    callBool(client, curve, SEL.isNativeQuote),
    callAddress(client, curve, SEL.pairToken),
    callUint(client, curve, SEL.feeBps),
    callUint(client, curve, SEL.creatorTaxBps),
    callBool(client, curve, SEL.buybackEnabled),
    callAddress(client, curve, SEL.deployer),
    callUint(client, curve, SEL.launchSupply),
    callUint(client, curve, SEL.reservedTokens),
    callUint(client, curve, SEL.sellableTokens),
    callUint(client, curve, SEL.trackedQuote),
    callUint(client, curve, SEL.trackedTokens),
    callUint(client, curve, SEL.quoteFeeBalance),
    callUint(client, curve, SEL.creatorTaxBalance),
    callUint(client, curve, SEL.buybackQuoteBalance),
    callAddress(client, curve, SEL.protocolFeeRecipient),
    callUint(client, curve, SEL.protocolFeeShareBps),
    callUint(client, curve, SEL.buybackBurnBps),
    callUint(client, curve, SEL.maxInternalPriceImpactBps),
  ]);
  const { quoteReserve, tokenReserve } = reserves;
  return {
    realQuoteReserve,
    quoteReserve,
    phantomQuote,
    graduationThreshold,
    graduated,
    readyToGraduate,
    launchedAt,
    isNativeQuote,
    pairToken,
    feeBps,
    creatorTaxBps,
    buybackEnabled,
    deployer,
    launchSupply,
    reservedTokens,
    sellableTokens,
    trackedQuote,
    trackedTokens,
    tokenReserve,
    quoteFeeBalance,
    creatorTaxBalance,
    buybackQuoteBalance,
    protocolFeeRecipient,
    protocolFeeShareBps,
    buybackBurnBps,
    maxInternalPriceImpactBps,
  };
}

export async function getToken(client: RpcClient, tokenAddress: string) {
  await client.assertChain(CHAIN_ID);
  const lt = await getLaunchedToken(client, tokenAddress);
  if (!lt.exists) {
    throw new PonsError("NOT_A_LAUNCH", `${tokenAddress} is not a Pons-launched token`);
  }
  const [meta, curve, pairMeta, snipeTaxBps] = await Promise.all([
    erc20Meta(client, lt.token, true),
    curveState(client, lt.curve),
    // Native-paired launches have no pair contract to read.
    isZeroAddress(lt.pairToken) ? Promise.resolve({} as Erc20Meta) : erc20Meta(client, lt.pairToken),
    // Probe a non-exempt sentinel: the deployer (and dev-buy recipient) are
    // auto-exempt at launch, so probing them would report 0% even inside the
    // snipe window. This is the tax a normal buyer pays right now.
    callUint(client, lt.curve, SEL.currentSnipeTaxBps, encodeAddress(BURN_DEAD)),
  ]);
  const fmtQuote = quoteFormatter(curve.isNativeQuote, pairMeta);
  const fmtToken = (v: bigint) => formatUnits(v, meta.decimals ?? 18);
  return {
    token: {
      address: lt.token,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply: meta.totalSupply?.toString(),
      totalSupplyFormatted: meta.totalSupply !== undefined ? fmtToken(meta.totalSupply) : undefined,
    },
    launch: {
      curve: lt.curve,
      deployer: lt.deployer,
      creatorFeeRecipient: lt.creatorFeeRecipient,
      phase: lt.phase,
      phaseLabel: GRADUATION_PHASES[lt.phase] ?? `unknown(${lt.phase})`,
      graduated: curve.graduated,
      readyToGraduate: curve.readyToGraduate,
      launchedAt: Number(curve.launchedAt),
      launchedAtIso: new Date(Number(curve.launchedAt) * 1000).toISOString(),
      buybackEnabled: curve.buybackEnabled,
      feeBps: Number(curve.feeBps),
      fee: formatBps(curve.feeBps),
      creatorTaxBps: Number(curve.creatorTaxBps),
      creatorTax: formatBps(curve.creatorTaxBps),
      poolFee: Number(lt.poolFee),
      tickSpacing: Number(lt.tickSpacing),
    },
    quote: {
      pairToken: curve.pairToken,
      pairTokenSymbol: curve.isNativeQuote ? "ETH (native)" : pairMeta.symbol,
      pairTokenDecimals: curve.isNativeQuote ? 18 : pairMeta.decimals,
      isNativeQuote: curve.isNativeQuote,
      realQuoteReserve: curve.realQuoteReserve.toString(),
      realQuoteReserveFormatted: fmtQuote(curve.realQuoteReserve),
      quoteReserve: curve.quoteReserve.toString(),
      quoteReserveFormatted: fmtQuote(curve.quoteReserve),
      phantomQuote: curve.phantomQuote.toString(),
      graduationThreshold: curve.graduationThreshold.toString(),
      graduationThresholdFormatted: fmtQuote(curve.graduationThreshold),
      graduationProgress: pct(curve.realQuoteReserve, curve.graduationThreshold),
      currentSnipeTaxBps: Number(snipeTaxBps),
      currentSnipeTax: formatBps(snipeTaxBps),
    },
    curveDump: {
      launchSupply: curve.launchSupply.toString(),
      launchSupplyFormatted: fmtToken(curve.launchSupply),
      reservedTokens: curve.reservedTokens.toString(),
      reservedTokensFormatted: fmtToken(curve.reservedTokens),
      sellableTokens: curve.sellableTokens.toString(),
      sellableTokensFormatted: fmtToken(curve.sellableTokens),
      trackedQuote: curve.trackedQuote.toString(),
      trackedQuoteFormatted: fmtQuote(curve.trackedQuote),
      trackedTokens: curve.trackedTokens.toString(),
      trackedTokensFormatted: fmtToken(curve.trackedTokens),
      tokenReserve: curve.tokenReserve.toString(),
      tokenReserveFormatted: fmtToken(curve.tokenReserve),
      quoteFeeBalance: curve.quoteFeeBalance.toString(),
      quoteFeeBalanceFormatted: fmtQuote(curve.quoteFeeBalance),
      creatorTaxBalance: curve.creatorTaxBalance.toString(),
      creatorTaxBalanceFormatted: fmtQuote(curve.creatorTaxBalance),
      buybackQuoteBalance: curve.buybackQuoteBalance.toString(),
      buybackQuoteBalanceFormatted: fmtQuote(curve.buybackQuoteBalance),
      protocolFeeRecipient: curve.protocolFeeRecipient,
      protocolFeeShareBps: Number(curve.protocolFeeShareBps),
      buybackBurnBps: Number(curve.buybackBurnBps),
      maxInternalPriceImpactBps: Number(curve.maxInternalPriceImpactBps),
      deployer: curve.deployer,
    },
    swept: {
      sweptQuote: lt.sweptQuote.toString(),
      sweptTokens: lt.sweptTokens.toString(),
      sweptAt: Number(lt.sweptAt),
    },
    explorer: `${EXPLORER}/token/${lt.token}`,
  };
}

export async function previewLaunch(client: RpcClient, launchConfigId = 0, pairToken?: string) {
  await client.assertChain(CHAIN_ID);
  const pair = (pairToken ?? "0x0000000000000000000000000000000000000000").toLowerCase();
  const nativePair = pair === "0x0000000000000000000000000000000000000000";
  const [configRet, economics, economicsRet, meta] = await Promise.all([
    client.ethCall(FACTORY, encodeCall(SEL.getLaunchConfig, encodeUint(launchConfigId))),
    client.ethCall(FACTORY, encodeCall(SEL.previewLaunchEconomics, encodeUint(launchConfigId), encodeAddress(pair))),
    client.ethCall(FACTORY, encodeCall(SEL.pairTokenEconomics, encodeAddress(pair))),
    nativePair ? Promise.resolve({} as Erc20Meta) : erc20Meta(client, pair),
  ]);
  const cfg = decodeLaunchConfig(configRet);
  const ew = words(economicsRet);
  const approved = !nativePair ? await callBool(client, FACTORY, SEL.approvedPairTokens, encodeAddress(pair)) : true;
  const econ = ew.length >= 3
    ? { phantomQuote: decodeUint(ew[0]), graduationThreshold: decodeUint(ew[1]), decimals: Number(decodeUint(ew[2])) }
    : null;
  const quoteDecimals = nativePair ? 18 : (meta.decimals ?? econ?.decimals ?? 18);
  const quoteSymbol = nativePair ? "ETH" : (meta.symbol ?? "units");
  const fmtQ = (v: bigint) => `${formatUnits(v, quoteDecimals)} ${quoteSymbol}`;
  const phantomQuote = nativePair ? cfg.phantomQuote : (econ?.phantomQuote ?? 0n);
  const threshold = nativePair ? cfg.graduationThreshold : (econ?.graduationThreshold ?? 0n);
  return {
    launchConfigId,
    pairToken: pair,
    ethPaired: nativePair,
    pairTokenApproved: approved,
    config: {
      supply: cfg.supply.toString(),
      supplyFormatted: formatUnits(cfg.supply, 18),
      curveFeeBps: Number(cfg.curveFeeBps),
      curveFee: formatBps(cfg.curveFeeBps),
      phantomQuote: phantomQuote.toString(),
      phantomQuoteFormatted: fmtQ(phantomQuote),
      graduationThreshold: threshold.toString(),
      graduationThresholdFormatted: fmtQ(threshold),
      poolFee: Number(cfg.poolFee),
      tickSpacing: Number(cfg.tickSpacing),
      enabled: cfg.enabled,
    },
    expectedEconomics: economics,
    note: "expectedEconomics is the bytes32 guard pons_launch_token passes back verbatim; it pins every owner-controlled term of the launch.",
  };
}

export async function pendingFeeChange(client: RpcClient, tokenAddress: string) {
  await client.assertChain(CHAIN_ID);
  const [ret, timelock, window_] = await Promise.all([
    client.ethCall(FACTORY, encodeCall(SEL.pendingCreatorFeeRecipient, encodeAddress(tokenAddress))),
    callUint(client, FACTORY, SEL.feeRecipientTimelock),
    callUint(client, FACTORY, SEL.feeRecipientWindow),
  ]);
  const w = words(ret);
  if (w.length < 3) throw new RpcError("RPC_FAILURE", "pendingCreatorFeeRecipient returned too few words");
  // On-chain layout (Factory.sol): (newRecipient, effectiveAt, expiresAt).
  // effectiveAt = proposal time + timelock; expiresAt = effectiveAt + window.
  const recipient = decodeAddress(w[0]);
  const effectiveAt = Number(decodeUint(w[1]));
  const expiresAt = Number(decodeUint(w[2]));
  const now = Math.floor(Date.now() / 1000);
  const pending = recipient !== "0x0000000000000000000000000000000000000000";
  return {
    token: tokenAddress.toLowerCase(),
    pending,
    recipient: pending ? recipient : null,
    effectiveAt: pending ? effectiveAt : null,
    effectiveAtIso: pending ? new Date(effectiveAt * 1000).toISOString() : null,
    expiresAt: pending ? expiresAt : null,
    expiresAtIso: pending ? new Date(expiresAt * 1000).toISOString() : null,
    status: !pending
      ? "none"
      : now < effectiveAt
        ? "timelocked"
        : now <= expiresAt
          ? "executable"
          : "expired",
    timelockSeconds: Number(timelock),
    executionWindowSeconds: Number(window_),
  };
}

export async function canLaunch(client: RpcClient, address: string) {  await client.assertChain(CHAIN_ID);
  const arg = encodeAddress(address);
  const [allowed, whitelisted, launchEnabled] = await Promise.all([
    callBool(client, FACTORY, SEL.canLaunch, arg),
    callBool(client, FACTORY, SEL.whitelistedLaunchers, arg),
    callBool(client, FACTORY, SEL.launchEnabled),
  ]);
  return { address: address.toLowerCase(), canLaunch: allowed, whitelistedLauncher: whitelisted, launchEnabled };
}

export async function pairTokenEconomics(client: RpcClient, pairTokenAddress: string) {
  await client.assertChain(CHAIN_ID);
  const arg = encodeAddress(pairTokenAddress);
  const [approved, ret, meta] = await Promise.all([
    callBool(client, FACTORY, SEL.approvedPairTokens, arg),
    client.ethCall(FACTORY, encodeCall(SEL.pairTokenEconomics, arg)),
    erc20Meta(client, pairTokenAddress),
  ]);
  const w = words(ret);
  if (w.length < 3) throw new RpcError("RPC_FAILURE", "pairTokenEconomics returned too few words");
  const phantomQuote = decodeUint(w[0]);
  const graduationThreshold = decodeUint(w[1]);
  const decimals = Number(decodeUint(w[2]));
  const fmt = (v: bigint) => `${formatUnits(v, meta.decimals ?? decimals)} ${meta.symbol ?? "units"}`;
  return {
    pairToken: pairTokenAddress.toLowerCase(),
    symbol: meta.symbol,
    approved: approved,
    phantomQuote: phantomQuote.toString(),
    phantomQuoteFormatted: fmt(phantomQuote),
    graduationThreshold: graduationThreshold.toString(),
    graduationThresholdFormatted: fmt(graduationThreshold),
    economicsDecimals: decimals,
  };
}

export interface ScanOptsLike {
  lookbackBlocks?: number;
  limit?: number;
}

function decodeLaunchLog(log: RpcLog) {
  const w = words(log.data);
  if (log.topics.length < 4) throw new RpcError("RPC_FAILURE", "TokenLaunched log with missing indexed topics");
  if (w.length < 3) throw new RpcError("RPC_FAILURE", "TokenLaunched log with short data");
  return {
    token: topicAddress(log.topics[1]),
    curve: topicAddress(log.topics[2]),
    deployer: topicAddress(log.topics[3]),
    pairToken: decodeAddress(w[0]),
    launchConfigId: Number(decodeUint(w[1])),
    graduationThreshold: decodeUint(w[2]).toString(),
    blockNumber: Number(BigInt(log.blockNumber)),
    transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
  };
}

export async function recentLaunches(
  client: RpcClient,
  opts: ScanOptsLike & { deployer?: string; pairToken?: string },
) {
  await client.assertChain(CHAIN_ID);
  const lookback = opts.lookbackBlocks ?? 50_000;
  const limit = opts.limit ?? 20;
  const topics: (string | null)[] = [
    "0x" + TOPIC.TokenLaunched,
    null,
    null,
    opts.deployer ? "0x" + encodeAddress(opts.deployer) : null,
  ];
  const wantPair = opts.pairToken?.toLowerCase();
  // When filtering pairToken client-side, over-fetch so `limit` survives filtering.
  const fetchLimit = wantPair ? limit * 5 : limit;
  const { logs, latestBlock, fromBlock, scannedFromBlock, complete } = await client.scanLogs({ address: FACTORY, topics }, lookback, fetchLimit);
  let launches = logs.map(decodeLaunchLog);
  if (wantPair) launches = launches.filter((l) => l.pairToken.toLowerCase() === wantPair);
  launches = launches.slice(0, limit);
  return {
    scannedFromBlock: Number(scannedFromBlock),
    scannedToBlock: Number(latestBlock),
    // False when the scan stopped early (limit reached, or pairToken filtering
    // discarded over-fetched results): older matches may exist below
    // scannedFromBlock. Widen lookbackBlocks or raise limit to continue.
    scanComplete: complete && (!wantPair || launches.length < limit || logs.length < fetchLimit),
    requestedFromBlock: Number(fromBlock),
    count: launches.length,
    launches,
  };
}

export async function recentGraduations(client: RpcClient, opts: ScanOptsLike) {
  await client.assertChain(CHAIN_ID);
  const lookback = opts.lookbackBlocks ?? 50_000;
  const limit = opts.limit ?? 20;
  const { logs, latestBlock, scannedFromBlock, complete } = await client.scanLogs(
    { address: FACTORY, topics: ["0x" + TOPIC.PoolGraduated] },
    lookback,
    limit,
  );
  const graduations = logs.map((log) => {
    const w = words(log.data);
    if (log.topics.length < 2) throw new RpcError("RPC_FAILURE", "PoolGraduated log with missing indexed topics");
    if (w.length < 3) throw new RpcError("RPC_FAILURE", "PoolGraduated log with short data");
    return {
      token: topicAddress(log.topics[1]),
      positionId: decodeUint(w[0]).toString(),
      tokenAmount: decodeUint(w[1]).toString(),
      pairTokenAmount: decodeUint(w[2]).toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
    };
  });
  return { scannedFromBlock: Number(scannedFromBlock), scannedToBlock: Number(latestBlock), scanComplete: complete, count: graduations.length, graduations };
}

export async function creatorLaunches(client: RpcClient, creatorAddress: string, opts: ScanOptsLike) {
  const found = await recentLaunches(client, { ...opts, deployer: creatorAddress });
  const launches = await Promise.all(
    found.launches.map(async (l) => ({
      ...l,
      graduated: await callBool(client, l.curve, SEL.graduated),
    })),
  );
  return { ...found, creator: creatorAddress.toLowerCase(), launches };
}

export async function curveTrades(client: RpcClient, curveAddress: string, opts: ScanOptsLike) {
  await client.assertChain(CHAIN_ID);
  const lookback = opts.lookbackBlocks ?? 50_000;
  const limit = opts.limit ?? 20;
  const [buys, sells] = await Promise.all([
    client.scanLogs({ address: curveAddress, topics: ["0x" + TOPIC.CurveBuy] }, lookback, limit),
    client.scanLogs({ address: curveAddress, topics: ["0x" + TOPIC.CurveSell] }, lookback, limit),
  ]);
  const decode = (log: RpcLog, side: "buy" | "sell") => {
    const w = words(log.data);
    if (log.topics.length < 3) throw new RpcError("RPC_FAILURE", `${side} log with missing indexed topics`);
    if (w.length < 4) throw new RpcError("RPC_FAILURE", `${side} log with short data`);
    const [inAmt, outAmt, fee, tax] = [decodeUint(w[0]), decodeUint(w[1]), decodeUint(w[2]), decodeUint(w[3])];
    return {
      side,
      trader: topicAddress(log.topics[1]),
      recipient: topicAddress(log.topics[2]),
      // CurveBuy emits post-clamp `spent` (refunds are a separate
      // CurveBuyRefunded event) and its fee leg includes the snipe tax.
      spent: side === "buy" ? inAmt.toString() : undefined,
      tokensOut: side === "buy" ? outAmt.toString() : undefined,
      tokensIn: side === "sell" ? inAmt.toString() : undefined,
      quoteOut: side === "sell" ? outAmt.toString() : undefined,
      fee: fee.toString(),
      feeIncludesSnipeTax: side === "buy" ? true : undefined,
      tax: tax.toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      logIndex: Number(BigInt(log.logIndex)),
      transactionHash: log.transactionHash,
    };
  };
  const trades = [...buys.logs.map((l) => decode(l, "buy")), ...sells.logs.map((l) => decode(l, "sell"))]
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
    .slice(0, limit);
  // buys/sells each sampled the chain tip independently; report the union.
  const scannedFrom = buys.scannedFromBlock < sells.scannedFromBlock ? buys.scannedFromBlock : sells.scannedFromBlock;
  const scannedTo = buys.latestBlock > sells.latestBlock ? buys.latestBlock : sells.latestBlock;
  return {
    curve: curveAddress.toLowerCase(),
    scannedFromBlock: Number(scannedFrom),
    scannedToBlock: Number(scannedTo),
    scanComplete: buys.complete && sells.complete,
    count: trades.length,
    trades,
  };
}

export async function snipeTax(client: RpcClient, curveAddress: string, recipient?: string) {
  await client.assertChain(CHAIN_ID);
  // Default probe is a non-exempt sentinel: the deployer is auto-exempt at
  // launch, so defaulting to it would always report 0%/exempt.
  const who = recipient ?? BURN_DEAD;
  const arg = encodeAddress(who);
  const [taxBps, exempt, launchedAt] = await Promise.all([
    callUint(client, curveAddress, SEL.currentSnipeTaxBps, arg),
    callBool(client, curveAddress, SEL.snipeTaxExempt, arg),
    callUint(client, curveAddress, SEL.launchedAt),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsSinceLaunch = nowSec - Number(launchedAt);
  // The curve snapshots the window at initialize; the factory's global can be
  // retuned later, so read the curve's own frozen value (same selector).
  const snipeTaxSeconds = Number(await callUint(client, curveAddress, SEL.snipeTaxSeconds));
  return {
    curve: curveAddress.toLowerCase(),
    recipient: who.toLowerCase(),
    currentSnipeTaxBps: Number(taxBps),
    currentSnipeTax: formatBps(taxBps),
    snipeTaxExempt: exempt,
    launchedAt: Number(launchedAt),
    launchedAtIso: new Date(Number(launchedAt) * 1000).toISOString(),
    secondsSinceLaunch,
    snipeTaxWindowSeconds: snipeTaxSeconds,
    windowActive: !exempt && secondsSinceLaunch < snipeTaxSeconds,
  };
}

export async function tokenSupply(client: RpcClient, tokenAddress?: string) {
  await client.assertChain(CHAIN_ID);
  const token = tokenAddress ?? PONS_TOKEN;
  const [meta, deadBal, zeroBal] = await Promise.all([
    erc20Meta(client, token, true),
    callUint(client, token, SEL.balanceOf, encodeAddress(BURN_DEAD)),
    callUint(client, token, SEL.balanceOf, encodeAddress(BURN_ZERO)),
  ]);
  const totalSupply = meta.totalSupply ?? 0n;
  const burned = deadBal + zeroBal;
  const fmt = (v: bigint) => formatUnits(v, meta.decimals ?? 18);
  return {
    token: token.toLowerCase(),
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    totalSupply: totalSupply.toString(),
    totalSupplyFormatted: fmt(totalSupply),
    balances: {
      [BURN_DEAD.toLowerCase()]: deadBal.toString(),
      [BURN_ZERO]: zeroBal.toString(),
    },
    burnedTotal: burned.toString(),
    burnedTotalFormatted: fmt(burned),
    burnedPctOfSupply: pct(burned, totalSupply),
  };
}

export async function launchCosts(client: RpcClient) {
  await client.assertChain(CHAIN_ID);
  const gasPrice = await client.gasPrice();
  return {
    note: "Static values measured on-chain 2026-09 (not live); gasPrice below is live.",
    measured: {
      launchAndBuyGas: 3_850_000,
      launchAndBuyCostWei: "1456000000000000",
      launchAndBuyCost: formatEth(1_456_000_000_000_000n),
      buyGas: 97_800,
      sellGas: 115_000,
      minRoundTripWei: "2100000000000000",
      minRoundTrip: formatEth(2_100_000_000_000_000n),
      observedGasPriceWei: "373358000",
      observedGasPrice: formatGwei(373_358_000n),
    },
    live: {
      gasPriceWei: gasPrice.toString(),
      gasPrice: formatGwei(gasPrice),
    },
    contracts: { factory: FACTORY, launchAndBuyRouter: LAUNCH_AND_BUY_ROUTER },
  };
}

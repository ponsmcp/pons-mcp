import { keccak_256 } from "@noble/hashes/sha3";
import { SEL, encodeAddress, encodeBool, encodeCall, encodeUint, words, decodeUint, decodeAddress } from "./abi.js";
import { RpcClient, RpcError } from "./rpc.js";
import {
  CHAIN_ID,
  FACTORY,
  PonsError,
  GRADUATION_PHASES,
  getLaunchedToken,
  callUint,
  callBool,
  callAddress,
  erc20Meta,
} from "./pons.js";
import { formatUnits, formatEth, formatBps, pct, parseUnits, isZeroAddress } from "./format.js";
import {
  CurveState,
  quoteBuy,
  quoteSell,
  withSlippage,
  floorAtLeast,
  priceImpactBps,
  boundedSnipeTaxBps,
  CurveMathError,
} from "./quote.js";
import { prepareTx, signEip1559, sendAndWait, feeMarket } from "./tx.js";
import type { Signer } from "./signer.js";

const DEFAULT_SLIPPAGE_BPS = 500n;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

// ---------- curve context ----------

export interface CurveContext {
  curve: string;
  token: string;
  isNativeQuote: boolean;
  pairToken: string;
  graduated: boolean;
  readyToGraduate: boolean;
  phase: number | null; // from factory record, when the token is registered
  /** True when the factory knows the token AND its record points at this exact curve. */
  registered: boolean;
  /** Set when the registration check itself failed (RPC error) — fail closed, but say so. */
  registrationError?: string;
  state: CurveState;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  tokenDecimals: number;
  tokenSymbol?: string;
  quoteDecimals: number;
  quoteSymbol: string;
  snipeTaxBps: bigint; // bounded, for `recipient`
}

async function erc20DecimalsSymbol(client: RpcClient, token: string): Promise<{ decimals: number; symbol?: string }> {
  try {
    const m = await erc20Meta(client, token);
    return { decimals: m.decimals ?? 18, symbol: m.symbol };
  } catch {
    return { decimals: 18 };
  }
}

export async function readCurveContext(client: RpcClient, curveAddress: string, recipient?: string): Promise<CurveContext> {
  const curve = curveAddress.toLowerCase();
  const who = (recipient ?? DEAD_ADDRESS).toLowerCase();
  const [token, isNative, pairToken, graduated, ready, reservesRet, feeBps, creatorTaxBps, realQuote, threshold, snipeRaw, reserved] =
    await Promise.all([
      callAddress(client, curve, SEL.token),
      callBool(client, curve, SEL.isNativeQuote),
      callAddress(client, curve, SEL.pairToken),
      callBool(client, curve, SEL.graduated),
      callBool(client, curve, SEL.readyToGraduate),
      client.ethCall(curve, encodeCall(SEL.getReserves)),
      callUint(client, curve, SEL.feeBps),
      callUint(client, curve, SEL.creatorTaxBps),
      callUint(client, curve, SEL.realQuoteReserve),
      callUint(client, curve, SEL.graduationThreshold),
      callUint(client, curve, SEL.currentSnipeTaxBps, encodeAddress(who)),
      callUint(client, curve, SEL.reservedTokens),
    ]);
  const rw = words(reservesRet);
  // Second round: all three depend only on batch 1 and are independent.
  const [tokenMeta, quoteMeta, lt] = await Promise.all([
    erc20DecimalsSymbol(client, token),
    isNative ? Promise.resolve({ decimals: 18, symbol: "ETH" as string | undefined }) : erc20DecimalsSymbol(client, pairToken),
    getLaunchedToken(client, token).catch((e) => (e instanceof Error ? e : new Error(String(e)))), // registration error is surfaced, not thrown here
  ]);
  const state: CurveState = {
    quoteReserve: decodeUint(rw[0]),
    tokenReserve: decodeUint(rw[1]),
    reservedTokens: reserved,
    curveFeeBps: feeBps,
    creatorTaxBps,
  };
  const snipeTaxBps = boundedSnipeTaxBps(state, snipeRaw);
  // Factory record phase (when registered). An RPC failure here must NOT be
  // silently treated as "unregistered" — assertTradeable would then block a
  // legitimate trade with a misleading NOT_A_LAUNCH.
  let phase: number | null = null;
  let registered = false;
  let registrationError: string | undefined;
  if (lt instanceof Error) {
    registrationError = lt.message;
  } else if (lt.exists) {
    phase = lt.phase;
    registered = lt.curve.toLowerCase() === curve;
  }
  return {
    curve,
    token,
    isNativeQuote: isNative,
    pairToken,
    graduated,
    readyToGraduate: ready,
    phase,
    registered,
    registrationError,
    state,
    realQuoteReserve: realQuote,
    graduationThreshold: threshold,
    tokenDecimals: tokenMeta.decimals,
    tokenSymbol: tokenMeta.symbol,
    quoteDecimals: quoteMeta.decimals,
    quoteSymbol: quoteMeta.symbol ?? "units",
    snipeTaxBps,
  };
}

const fmtQ = (ctx: CurveContext, v: bigint) => `${formatUnits(v, ctx.quoteDecimals)} ${ctx.quoteSymbol}`;
const fmtT = (ctx: CurveContext, v: bigint) => `${formatUnits(v, ctx.tokenDecimals)} ${ctx.tokenSymbol ?? "tokens"}`;

function assertTradeable(ctx: CurveContext, direction: "buy" | "sell"): void {
  // A contract that merely implements the curve ABI is not a Pons curve: a
  // fake "curve" would receive the signer's ETH value or an ERC-20 approval.
  // Only the factory-registered curve for the token is acceptable.
  if (!ctx.registered) {
    if (ctx.registrationError !== undefined) {
      throw new RpcError(
        "RPC_FAILURE",
        `could not verify ${ctx.curve} against the factory's launch record (${ctx.registrationError}); refusing to build a transaction against an unverified contract — retry when the RPC is healthy`,
      );
    }
    throw new PonsError("NOT_A_LAUNCH", `curve ${ctx.curve} is not the factory-registered Pons curve for its token; refusing to build a transaction against an unverified contract`);
  }
  if (ctx.graduated || (ctx.phase !== null && ctx.phase !== 0)) {
    throw new PonsError("INVALID_PARAMS", `curve ${ctx.curve} has graduated off the bonding curve (phase ${ctx.phase !== null ? GRADUATION_PHASES[ctx.phase] : "graduated"}); trade the Uniswap V4 pool instead (pons_quote_swap / pons_swap)`);
  }
  if (direction === "sell" && ctx.readyToGraduate) {
    throw new PonsError("INVALID_PARAMS", "the curve has raised its threshold and stopped trading; call pons_graduate, then sell via the V4 pool");
  }
}

// ---------- read: quote tools ----------

export async function quoteBuyTool(client: RpcClient, curveAddress: string, amount: string, recipient?: string) {
  await client.assertChain(CHAIN_ID);
  const ctx = await readCurveContext(client, curveAddress, recipient);
  const amountIn = parseUnits(amount, ctx.quoteDecimals);
  let quote;
  try {
    quote = quoteBuy(ctx.state, amountIn, ctx.snipeTaxBps);
  } catch (e) {
    if (e instanceof CurveMathError) throw new PonsError("INVALID_PARAMS", e.message);
    throw e;
  }
  const impact = priceImpactBps(quote.spent, ctx.state.quoteReserve, quote.tokensOut, ctx.state.tokenReserve);

  // Cross-check: run the actual buy via eth_call. The node enforces balance on
  // value-carrying calls, so the payer gets a state-diff balance override.
  const payer = (recipient ?? DEAD_ADDRESS).toLowerCase();
  const callObj = {
    from: payer,
    to: ctx.curve,
    data: encodeCall(SEL.buy, encodeUint(amountIn), encodeUint(0), encodeAddress(payer)),
    value: ctx.isNativeQuote ? "0x" + amountIn.toString(16) : "0x0",
  };
  let overrides: Record<string, Record<string, unknown>> | undefined;
  if (ctx.isNativeQuote) {
    overrides = { [payer]: { balance: "0x" + (amountIn * 2n).toString(16) } };
  } else {
    // ERC-20 pair: the curve pulls the pair token via transferFrom, so the
    // payer needs balance + allowance state-diff overrides (slots discovered
    // at runtime). Without them the cross-check always reverts.
    try {
      const slots = await discoverErc20Slots(client, ctx.pairToken, payer, ctx.curve);
      const big = "0x" + (amountIn * 4n + 10n ** 30n).toString(16).padStart(64, "0");
      overrides = { [ctx.pairToken]: { stateDiff: { [slots.balance]: big, [slots.allowance]: big } } };
    } catch { /* slot discovery best-effort; cross-check reports the failure */ }
  }
  let crossCheck: Record<string, unknown>;
  try {
    const params: unknown[] = overrides ? [callObj, "latest", overrides] : [callObj, "latest"];
    const ret = await client.call<string>("eth_call", params);
    const w = words(ret);
    const onChainOut = w.length ? decodeUint(w[0]) : null;
    crossCheck = {
      ok: true,
      onChainTokensOut: onChainOut?.toString(),
      matchesLocalQuote: onChainOut === null ? null : onChainOut === quote.tokensOut,
    };
  } catch (e) {
    crossCheck = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return {
    curve: ctx.curve,
    token: ctx.token,
    side: "buy",
    amountIn: amountIn.toString(),
    amountInFormatted: fmtQ(ctx, amountIn),
    spent: quote.spent.toString(),
    spentFormatted: fmtQ(ctx, quote.spent),
    refund: quote.refund.toString(),
    tokensOut: quote.tokensOut.toString(),
    tokensOutFormatted: fmtT(ctx, quote.tokensOut),
    curveFee: quote.curveFee.toString(),
    creatorTax: quote.creatorTax.toString(),
    snipeTax: quote.snipeTax.toString(),
    snipeTaxBpsApplicableNow: Number(ctx.snipeTaxBps),
    snipeTaxApplicableNow: formatBps(ctx.snipeTaxBps),
    clamped: quote.clamped,
    priceImpactBps: Number(impact),
    priceImpact: formatBps(impact),
    crossCheck,
  };
}

export async function quoteSellTool(client: RpcClient, curveAddress: string, tokenAmount: string, seller?: string) {
  await client.assertChain(CHAIN_ID);
  const ctx = await readCurveContext(client, curveAddress);
  const tokensIn = parseUnits(tokenAmount, ctx.tokenDecimals);
  if (ctx.readyToGraduate) {
    throw new PonsError("INVALID_PARAMS", "the curve has raised its threshold and stopped trading; sell via the V4 pool after graduation");
  }
  let quote;
  try {
    quote = quoteSell(ctx.state, tokensIn);
  } catch (e) {
    if (e instanceof CurveMathError) throw new PonsError("INVALID_PARAMS", e.message);
    throw e;
  }
  const impact = priceImpactBps(tokensIn, ctx.state.tokenReserve, quote.gross, ctx.state.quoteReserve);

  // Cross-check the real sell: needs token balance + allowance, both set via
  // state-diff overrides with storage slots discovered at runtime.
  const who = (seller ?? DEAD_ADDRESS).toLowerCase();
  let crossCheck: Record<string, unknown>;
  try {
    const slots = await discoverErc20Slots(client, ctx.token, who, ctx.curve);
    const big = "0x" + (tokensIn * 4n + 10n ** 30n).toString(16).padStart(64, "0");
    const overrides: Record<string, Record<string, unknown>> = {
      [ctx.token]: { stateDiff: { [slots.balance]: big, [slots.allowance]: big } },
    };
    const ret = await client.call<string>("eth_call", [
      { from: who, to: ctx.curve, data: encodeCall(SEL.sell, encodeUint(tokensIn), encodeUint(0), encodeAddress(who)), value: "0x0" },
      "latest",
      overrides,
    ]);
    const w = words(ret);
    const onChainOut = w.length ? decodeUint(w[0]) : null;
    crossCheck = {
      ok: true,
      onChainQuoteOut: onChainOut?.toString(),
      matchesLocalQuote: onChainOut === null ? null : onChainOut === quote.quoteOut,
    };
  } catch (e) {
    crossCheck = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  return {
    curve: ctx.curve,
    token: ctx.token,
    side: "sell",
    tokensIn: tokensIn.toString(),
    tokensInFormatted: fmtT(ctx, tokensIn),
    gross: quote.gross.toString(),
    quoteOut: quote.quoteOut.toString(),
    quoteOutFormatted: fmtQ(ctx, quote.quoteOut),
    curveFee: quote.curveFee.toString(),
    curveFeeFormatted: fmtQ(ctx, quote.curveFee),
    creatorTax: quote.creatorTax.toString(),
    creatorTaxFormatted: fmtQ(ctx, quote.creatorTax),
    priceImpactBps: Number(impact),
    priceImpact: formatBps(impact),
    crossCheck,
  };
}

// ---------- ERC-20 storage-slot discovery (for state-override simulation) ----------

// Cached keys are holder/spender-specific (mapping slots are keyed by them),
// so the cache key must include all three.
const slotCache = new Map<string, { balance: string; allowance: string }>();

function slotKey(holder: string, slot: number): string {
  const data = encodeAddress(holder) + encodeUint(slot);
  return "0x" + Buffer.from(keccak(Buffer.from(data, "hex"))).toString("hex");
}

function allowanceSlotKey(owner: string, spender: string, slot: number): string {
  const inner = keccak(Buffer.from(encodeAddress(owner) + encodeUint(slot), "hex"));
  const outer = keccak(Buffer.concat([Buffer.from(encodeAddress(spender), "hex"), inner]));
  return "0x" + Buffer.from(outer).toString("hex");
}

function keccak(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

// Find the token's balanceOf and allowance mapping slots by probing 0..11
// with a state-diff override and seeing which one moves the view call.
export async function discoverErc20Slots(
  client: RpcClient,
  token: string,
  holder: string,
  spender: string,
): Promise<{ balance: string; allowance: string }> {
  const cacheKey = `${token.toLowerCase()}:${holder.toLowerCase()}:${spender.toLowerCase()}`;
  const cached = slotCache.get(cacheKey);
  if (cached) return cached;
  const marker = "0x" + (10n ** 30n).toString(16).padStart(64, "0");
  let balanceSlot: string | null = null;
  let allowanceSlot: string | null = null;
  for (let slot = 0; slot < 12 && (balanceSlot === null || allowanceSlot === null); slot++) {
    const balKey = slotKey(holder, slot);
    const allowKey = allowanceSlotKey(holder, spender, slot);
    const overrides = { [token]: { stateDiff: { [balKey]: marker, [allowKey]: marker } } };
    // The two probes are independent — run them together (halves the rounds).
    const [balRet, allowRet] = await Promise.all([
      balanceSlot === null
        ? client.call<string>("eth_call", [{ to: token, data: encodeCall(SEL.balanceOf, encodeAddress(holder)) }, "latest", overrides])
        : Promise.resolve(null),
      allowanceSlot === null
        ? client.call<string>(
            "eth_call",
            [{ to: token, data: encodeCall(SEL.allowance, encodeAddress(holder), encodeAddress(spender)) }, "latest", overrides],
          )
        : Promise.resolve(null),
    ]);
    if (balRet !== null) {
      const w = words(balRet);
      if (w.length && decodeUint(w[0]) === 10n ** 30n) balanceSlot = balKey;
    }
    if (allowRet !== null) {
      const w = words(allowRet);
      if (w.length && decodeUint(w[0]) === 10n ** 30n) allowanceSlot = allowKey;
    }
  }
  if (balanceSlot === null || allowanceSlot === null) {
    throw new RpcError("RPC_FAILURE", `could not discover balanceOf/allowance storage slots for ${token}`);
  }
  const found = { balance: balanceSlot, allowance: allowanceSlot };
  // Bound the cache (keys include caller-supplied addresses): FIFO eviction.
  if (slotCache.size >= 1024) slotCache.delete(slotCache.keys().next().value!);
  slotCache.set(cacheKey, found);
  return found;
}

// ---------- write machinery ----------

export interface WriteStep {
  label: string;
  to: string;
  data: string;
  value: bigint;
  // Simulation state overrides (balance for the signer, ERC-20 slots, …).
  overrides?: Record<string, Record<string, unknown>>;
  // True when the step can only succeed after a prior step is mined
  // (e.g. createGraduatedPool after graduate).
  dependsOnPrior?: boolean;
}

export interface WritePlan {
  summary: string;
  steps: WriteStep[];
  details: Record<string, unknown>;
}

export async function runWrite(
  client: RpcClient,
  signer: Signer,
  plan: WritePlan,
  opts: { dryRun?: boolean; confirm?: boolean },
) {
  await client.assertChain(CHAIN_ID);
  const dryRun = opts.dryRun ?? true;
  const confirm = opts.confirm ?? false;

  // feeMarket depends on nothing below — start it now.
  const feesPromise = feeMarket(client);

  // Simulate every independently-simulatable step (signer gets a balance
  // override so unfunded dry-runs still exercise the contract logic).
  const stepResults = [];
  for (const [i, step] of plan.steps.entries()) {
    const callObj = {
      from: signer.address,
      to: step.to,
      data: step.data,
      value: "0x" + step.value.toString(16),
    };
    const overrides = {
      // At least 1000 ETH, and always enough to cover this step's value.
      [signer.address]: { balance: "0x" + (step.value * 2n > 1_000n * 10n ** 18n ? step.value * 2n : 1_000n * 10n ** 18n).toString(16) },
      ...(step.overrides ?? {}),
    };
    // Simulation and gas estimation are independent — run them together.
    const [simRes, gasRes] = await Promise.allSettled([
      client.call<string>("eth_call", [callObj, "latest", overrides]),
      client.call<string>("eth_estimateGas", [callObj, "latest", overrides]),
    ]);
    const simulation: Record<string, unknown> =
      simRes.status === "fulfilled"
        ? { ok: true, returnData: simRes.value === "0x" ? undefined : simRes.value }
        : { ok: false, error: simRes.reason instanceof Error ? simRes.reason.message : String(simRes.reason) };
    const gas: Record<string, unknown> =
      gasRes.status === "fulfilled"
        ? { estimate: BigInt(gasRes.value).toString() }
        : { estimate: null, error: gasRes.reason instanceof Error ? gasRes.reason.message : String(gasRes.reason) };
    stepResults.push({
      step: i + 1,
      label: step.label,
      to: step.to,
      valueWei: step.value.toString(),
      value: formatEth(step.value),
      calldata: step.data,
      dependsOnPrior: step.dependsOnPrior === true || undefined,
      simulation,
      gas,
    });
  }

  const fees = await feesPromise;
  const base = {
    summary: plan.summary,
    mode: dryRun || !confirm ? "dry-run" : "broadcast",
    signer: signer.address,
    steps: stepResults,
    feeMarket: { maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
    ...plan.details,
  };

  if (dryRun || !confirm) {
    return { ...base, note: "dry-run only — nothing was broadcast. Re-run with dryRun=false AND confirm=true to send." };
  }
  const blocking = stepResults.filter(
    (s) => !(s.simulation as { ok: boolean }).ok && s.dependsOnPrior !== true,
  );
  if (blocking.length > 0) {
    throw new PonsError(
      "INVALID_PARAMS",
      `simulation reverted on step ${blocking[0].step} (${blocking[0].label}); refusing to broadcast: ${(blocking[0].simulation as { error?: string }).error}`,
    );
  }

  // Broadcast sequentially; each step's nonce comes from "pending".
  const receipts = [];
  for (const [i, step] of plan.steps.entries()) {
    let receipt;
    try {
      const prepared = await prepareTx(client, signer, { to: step.to, data: step.data, value: step.value });
      const rawTx = signEip1559(signer, CHAIN_ID, prepared);
      receipt = await sendAndWait(client, rawTx);
    } catch (e) {
      // Never lose the already-mined steps: their hashes matter (e.g. a mined
      // approval when the trade itself reverts).
      if (receipts.length > 0 && e instanceof Error) {
        const prior = receipts.map((r) => `${r.label} mined: ${r.hash}`).join("; ");
        const msg = `${e.message} (earlier steps already broadcast — ${prior})`;
        if (e instanceof RpcError) throw new RpcError(e.code, msg);
        throw new PonsError("INVALID_PARAMS", msg);
      }
      throw e;
    }
    receipts.push({
      step: i + 1,
      label: step.label,
      hash: receipt.transactionHash,
      blockNumber: Number(BigInt(receipt.blockNumber ?? "0x0")),
      gasUsed: Number(BigInt(receipt.gasUsed ?? "0x0")),
      effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0").toString(),
      status: "success",
      explorer: `https://robinhoodchain.blockscout.com/tx/${receipt.transactionHash}`,
      logs: receipt.logs ?? [],
    });
  }
  return { ...base, mode: "broadcast", receipts };
}

// ---------- write: buy / sell ----------

export async function buyTool(
  client: RpcClient,
  signer: Signer,
  curveAddress: string,
  amount: string,
  minTokensOut?: string,
  recipient?: string,
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  const ctx = await readCurveContext(client, curveAddress, recipient ?? signer.address);
  assertTradeable(ctx, "buy");
  const amountIn = parseUnits(amount, ctx.quoteDecimals);
  if (amountIn <= 0n) throw new PonsError("INVALID_PARAMS", "amount must be positive");
  let quote;
  try {
    quote = quoteBuy(ctx.state, amountIn, ctx.snipeTaxBps);
  } catch (e) {
    if (e instanceof CurveMathError) throw new PonsError("INVALID_PARAMS", e.message);
    throw e;
  }
  // The on-chain slippage check is a PRICE bound (Curve.sol):
  //   spent * minTokensOut > received * tokensOut  →  revert
  // On a clamped (partial) fill spent < received, so the floor must be scaled
  // by spent/offered or a buy sized past the buyout reverts despite the refund.
  const priceBoundBase = quote.clamped && quote.spent > 0n ? (quote.tokensOut * amountIn) / quote.spent : quote.tokensOut;
  const minOut = floorAtLeast(
    withSlippage(priceBoundBase, DEFAULT_SLIPPAGE_BPS),
    minTokensOut !== undefined ? parseUnits(minTokensOut, ctx.tokenDecimals) : undefined,
  );
  const to = ctx.curve;
  const who = (recipient ?? signer.address).toLowerCase();

  const steps: WriteStep[] = [];
  let buyDependsOnPrior = false;
  let buyOverrides: Record<string, Record<string, unknown>> | undefined;
  if (!ctx.isNativeQuote) {
    // ERC-20 quote: the curve pulls the pair token via transferFrom.
    const allowance = await callUint(client, ctx.pairToken, SEL.allowance, encodeAddress(signer.address), encodeAddress(to));
    if (allowance < amountIn) {
      steps.push({
        label: `approve ${ctx.quoteSymbol} spend`,
        to: ctx.pairToken,
        data: encodeCall(SEL.approve, encodeAddress(to), encodeUint(amountIn)),
        value: 0n,
      });
      buyDependsOnPrior = true;
    }
    // The buy only succeeds once the approval is mined; simulate it with
    // balance + allowance state-diff overrides (slots discovered at runtime).
    try {
      const slots = await discoverErc20Slots(client, ctx.pairToken, signer.address, to);
      const buyStateDiff: Record<string, string> = { [slots.balance]: "0x" + (amountIn * 4n).toString(16).padStart(64, "0") };
      if (buyDependsOnPrior) buyStateDiff[slots.allowance] = "0x" + amountIn.toString(16).padStart(64, "0");
      buyOverrides = { [ctx.pairToken]: { stateDiff: buyStateDiff } };
    } catch { /* slot discovery best-effort; simulation reports the failure */ }
  }
  steps.push({
    label: "buy",
    to,
    data: encodeCall(SEL.buy, encodeUint(amountIn), encodeUint(minOut), encodeAddress(who)),
    value: ctx.isNativeQuote ? amountIn : 0n,
    // Only waive the simulation gate when we could NOT build faithful state
    // overrides — with them, a reverting buy simulation must block broadcast.
    dependsOnPrior: buyDependsOnPrior && buyOverrides === undefined,
    overrides: buyOverrides,
  });

  return runWrite(client, signer, {
    summary: `buy ~${fmtT(ctx, quote.tokensOut)} for ${fmtQ(ctx, quote.spent)} on curve ${ctx.curve}`,
    steps,
    details: {
      quote: {
        amountIn: amountIn.toString(),
        tokensOut: quote.tokensOut.toString(),
        tokensOutFormatted: fmtT(ctx, quote.tokensOut),
        minTokensOut: minOut.toString(),
        spent: quote.spent.toString(),
        spentFormatted: fmtQ(ctx, quote.spent),
        refund: quote.refund.toString(),
        snipeTaxBpsNow: Number(ctx.snipeTaxBps),
        snipeTaxNow: formatBps(ctx.snipeTaxBps),
        priceImpactBps: Number(priceImpactBps(quote.spent, ctx.state.quoteReserve, quote.tokensOut, ctx.state.tokenReserve)),
        clamped: quote.clamped,
        slippageBps: Number(DEFAULT_SLIPPAGE_BPS),
      },
    },
  }, opts);
}

export async function sellTool(
  client: RpcClient,
  signer: Signer,
  curveAddress: string,
  tokenAmount: string,
  minQuoteOut?: string,
  recipient?: string,
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  const ctx = await readCurveContext(client, curveAddress);
  assertTradeable(ctx, "sell");
  const tokensIn = parseUnits(tokenAmount, ctx.tokenDecimals);
  if (tokensIn <= 0n) throw new PonsError("INVALID_PARAMS", "tokenAmount must be positive");
  const broadcasting = opts.dryRun === false && opts.confirm === true;
  const balance = await callUint(client, ctx.token, SEL.balanceOf, encodeAddress(signer.address));
  const balanceNote =
    balance < tokensIn
      ? `signer holds only ${formatUnits(balance, ctx.tokenDecimals)} ${ctx.tokenSymbol ?? "tokens"} on-chain`
      : null;
  if (broadcasting && balanceNote !== null) {
    throw new PonsError("INVALID_PARAMS", balanceNote);
  }
  let quote;
  try {
    quote = quoteSell(ctx.state, tokensIn);
  } catch (e) {
    if (e instanceof CurveMathError) throw new PonsError("INVALID_PARAMS", e.message);
    throw e;
  }
  const minOut = floorAtLeast(
    withSlippage(quote.quoteOut, DEFAULT_SLIPPAGE_BPS),
    minQuoteOut !== undefined ? parseUnits(minQuoteOut, ctx.quoteDecimals) : undefined,
  );
  const who = (recipient ?? signer.address).toLowerCase();

  // Exact-amount approval (no standing grant), then the sell.
  const allowance = await callUint(client, ctx.token, SEL.allowance, encodeAddress(signer.address), encodeAddress(ctx.curve));
  const slots = await discoverErc20Slots(client, ctx.token, signer.address, ctx.curve).catch(() => null);
  const sellStateDiff: Record<string, string> = {};
  if (slots !== null) {
    if (allowance < tokensIn) sellStateDiff[slots.allowance] = "0x" + tokensIn.toString(16).padStart(64, "0");
    if (balanceNote !== null) sellStateDiff[slots.balance] = "0x" + tokensIn.toString(16).padStart(64, "0");
  }
  const steps: WriteStep[] = [];
  if (allowance < tokensIn) {
    steps.push({
      label: "approve curve to move tokens",
      to: ctx.token,
      data: encodeCall(SEL.approve, encodeAddress(ctx.curve), encodeUint(tokensIn)),
      value: 0n,
    });
  }
  steps.push({
    label: "sell",
    to: ctx.curve,
    data: encodeCall(SEL.sell, encodeUint(tokensIn), encodeUint(minOut), encodeAddress(who)),
    value: 0n,
    // Waive the simulation gate only when slot discovery failed (the sim can't
    // be faithful pre-approve); with overrides a reverting sell blocks broadcast.
    dependsOnPrior: allowance < tokensIn && slots === null,
    overrides: Object.keys(sellStateDiff).length > 0 ? { [ctx.token]: { stateDiff: sellStateDiff } } : undefined,
  });

  return runWrite(client, signer, {
    summary: `sell ${fmtT(ctx, tokensIn)} for ~${fmtQ(ctx, quote.quoteOut)} on curve ${ctx.curve}`,
    steps,
    details: {
      ...(balanceNote !== null ? { warning: `${balanceNote}; dry-run simulated with a balance override, broadcast would fail` } : {}),
      quote: {
        tokensIn: tokensIn.toString(),
        gross: quote.gross.toString(),
        quoteOut: quote.quoteOut.toString(),
        quoteOutFormatted: fmtQ(ctx, quote.quoteOut),
        minQuoteOut: minOut.toString(),
        curveFee: quote.curveFee.toString(),
        creatorTax: quote.creatorTax.toString(),
        priceImpactBps: Number(priceImpactBps(tokensIn, ctx.state.tokenReserve, quote.gross, ctx.state.quoteReserve)),
        slippageBps: Number(DEFAULT_SLIPPAGE_BPS),
      },
    },
  }, opts);
}

// ---------- write: graduation (permissionless, two phases) ----------

async function resolveToken(client: RpcClient, tokenOrCurve: string): Promise<{ token: string; curve: string }> {
  const lt = await getLaunchedToken(client, tokenOrCurve).catch(() => null);
  if (lt?.exists) return { token: lt.token, curve: lt.curve };
  // Maybe a curve address was passed.
  const token = await callAddress(client, tokenOrCurve, SEL.token).catch(() => null);
  if (token === null) throw new PonsError("NOT_A_LAUNCH", `${tokenOrCurve} is neither a Pons-launched token nor a Pons curve`);
  return { token, curve: tokenOrCurve.toLowerCase() };
}

export async function graduateTool(
  client: RpcClient,
  signer: Signer,
  tokenOrCurve: string,
  phase: "sweep" | "pool" | "both" = "both",
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  const { token } = await resolveToken(client, tokenOrCurve);
  const lt = await getLaunchedToken(client, token);
  if (!lt.exists) throw new PonsError("NOT_A_LAUNCH", `${token} is not a Pons-launched token`);
  const phaseName = GRADUATION_PHASES[lt.phase] ?? `unknown(${lt.phase})`;
  if (lt.phase === 2) {
    throw new PonsError("INVALID_PARAMS", `token already graduated: its Uniswap V4 pool exists (phase ${phaseName})`);
  }
  const ready = await callBool(client, lt.curve, SEL.readyToGraduate);
  if (lt.phase === 0 && !ready) {
    const real = await callUint(client, lt.curve, SEL.realQuoteReserve);
    const threshold = await callUint(client, lt.curve, SEL.graduationThreshold);
    throw new PonsError(
      "INVALID_PARAMS",
      `curve has not raised its graduation threshold yet: raised ${formatEth(real)} of ${formatEth(threshold)} (${pct(real, threshold)})`,
    );
  }
  const needsSweep = lt.phase === 0;
  const wants: ("sweep" | "pool")[] = phase === "both" ? (needsSweep ? ["sweep", "pool"] : ["pool"]) : [phase];
  if (wants.includes("sweep") && !needsSweep) {
    throw new PonsError("INVALID_PARAMS", `the curve has already been drained (phase ${phaseName}); run with phase "pool"`);
  }
  const steps: WriteStep[] = wants.map((w, i) =>
    w === "sweep"
      ? { label: "graduate (drain curve into factory)", to: FACTORY, data: encodeCall(SEL.graduate, encodeAddress(token)), value: 0n, dependsOnPrior: i > 0 }
      : { label: "createGraduatedPool (seed the V4 pool)", to: FACTORY, data: encodeCall(SEL.createGraduatedPool, encodeAddress(token)), value: 0n, dependsOnPrior: i > 0 },
  );
  return runWrite(client, signer, {
    summary: `graduate ${token} (${wants.join(" + ")}) — permissionless, callable by anyone`,
    steps,
    details: { token, curve: lt.curve, phase: phaseName, readyToGraduate: ready },
  }, opts);
}

// ---------- write: creator fee recipient timelock flow ----------

async function feeRecipientWrite(
  client: RpcClient,
  signer: Signer,
  token: string,
  step: WriteStep,
  summary: string,
  opts: { dryRun?: boolean; confirm?: boolean },
) {
  const lt = await getLaunchedToken(client, token);
  if (!lt.exists) throw new PonsError("NOT_A_LAUNCH", `${token} is not a Pons-launched token`);
  const pendingRet = await client.ethCall(FACTORY, encodeCall(SEL.pendingCreatorFeeRecipient, encodeAddress(token)));
  const w = words(pendingRet);
  const pending = w.length >= 3 && !isZeroAddress(decodeAddress(w[0]));
  return runWrite(client, signer, {
    summary,
    steps: [step],
    details: {
      token,
      currentCreatorFeeRecipient: lt.creatorFeeRecipient,
      // pendingCreatorFeeRecipient = (newRecipient, effectiveAt, expiresAt);
      // entries are created by the OWNER flow (setCreatorFeeRecipient), not by
      // a creator's direct transferCreatorFeeRecipient call.
      pendingChange: pending
        ? { recipient: decodeAddress(w[0]), effectiveAt: Number(decodeUint(w[1])), expiresAt: Number(decodeUint(w[2])) }
        : null,
    },
  }, opts);
}

export function setCreatorFeeRecipientTool(client: RpcClient, signer: Signer, token: string, recipient: string, opts: { dryRun?: boolean; confirm?: boolean }) {
  return feeRecipientWrite(
    client, signer, token,
    { label: "transfer creator fee recipient (immediate)", to: FACTORY, data: encodeCall(SEL.transferCreatorFeeRecipient, encodeAddress(token), encodeAddress(recipient)), value: 0n },
    // Verified on-chain (Factory.sol): this creator self-service call applies
    // IMMEDIATELY — no timelock, no pending entry. (The timelocked
    // propose/execute/cancel flow is the owner's setCreatorFeeRecipient path.)
    `transfer the creator fee recipient of ${token} to ${recipient} — takes effect IMMEDIATELY on broadcast (no timelock); caller must be the current creatorFeeRecipient`,
    opts,
  );
}

export function executeFeeRecipientChangeTool(client: RpcClient, signer: Signer, token: string, opts: { dryRun?: boolean; confirm?: boolean }) {
  return feeRecipientWrite(
    client, signer, token,
    { label: "execute pending (owner-initiated) fee recipient change", to: FACTORY, data: encodeCall(SEL.executeCreatorFeeRecipientChange, encodeAddress(token)), value: 0n },
    `execute the pending creator fee recipient change for ${token} (applies to owner-initiated changes only; permissionless within the execution window)`,
    opts,
  );
}

export function cancelFeeRecipientChangeTool(client: RpcClient, signer: Signer, token: string, opts: { dryRun?: boolean; confirm?: boolean }) {
  return feeRecipientWrite(
    client, signer, token,
    { label: "cancel pending (owner-initiated) fee recipient change", to: FACTORY, data: encodeCall(SEL.cancelCreatorFeeRecipientChange, encodeAddress(token)), value: 0n },
    `cancel the pending creator fee recipient change for ${token} (owner-only on-chain)`,
    opts,
  );
}

// ---------- write: misc curve controls ----------

// Resolve a curve-or-token address to the factory-registered token.
async function resolveToToken(client: RpcClient, tokenOrCurve: string): Promise<string> {
  const lt = await getLaunchedToken(client, tokenOrCurve).catch(() => null);
  if (lt?.exists) return lt.token;
  const token = await callAddress(client, tokenOrCurve, SEL.token).catch(() => null);
  if (token === null) throw new PonsError("NOT_A_LAUNCH", `${tokenOrCurve} is neither a Pons-launched token nor a Pons curve`);
  return token;
}

export async function exemptSnipeTaxTool(_client: RpcClient, _signer: Signer, curveAddress: string, account: string, _opts: { dryRun?: boolean; confirm?: boolean }): Promise<never> {
  // Verified on-chain 2026-09: curve.exemptFromSnipeTax reverts NotFactory()
  // for every external caller and the factory exposes no wrapper. Exemptions
  // are written at launch only (snipeTaxExemptions in pons_launch_token; the
  // launchAndBuy router appends the dev-buy recipient automatically).
  void _client; void _signer; void _opts;
  throw new PonsError(
    "INVALID_PARAMS",
    `post-launch snipe-tax exemption is impossible by construction: curve.exemptFromSnipeTax(${account}) is factory-internal (reverts NotFactory). Exemptions can only be set at launch — use snipeTaxExemptions in pons_launch_token. Curve ${curveAddress} was not modified.`,
  );
}

export async function setBuybackTool(client: RpcClient, signer: Signer, curveAddress: string, enabled: boolean, opts: { dryRun?: boolean; confirm?: boolean }) {
  // Verified on-chain: curve.setBuybackEnabled is factory-internal (NotFactory);
  // the external path is factory.setBuybackEnabled — caller must be the current
  // creatorFeeRecipient or the owner, and only the creator may ENABLE.
  const token = await resolveToToken(client, curveAddress);
  return runWrite(client, signer, {
    summary: `${enabled ? "enable" : "disable"} buyback for ${token} (factory.setBuybackEnabled; enabling requires the creator fee recipient, disabling also works for the owner)`,
    steps: [{ label: "factory.setBuybackEnabled", to: FACTORY, data: encodeCall(SEL.factorySetBuybackEnabled, encodeAddress(token), encodeBool(enabled)), value: 0n }],
    details: { curve: curveAddress.toLowerCase(), token, enabled },
  }, opts);
}

export async function sweepCurveFeesTool(client: RpcClient, signer: Signer, curveAddress: string, minBuybackTokensOut = "0", opts: { dryRun?: boolean; confirm?: boolean } = {}) {
  const ctx = await readCurveContext(client, curveAddress);
  // Verified on-chain (Curve.sol): sweepFees(minBuybackTokensOut) sweeps ALL
  // pending fees; the argument is a token-denominated minimum-output floor for
  // the internal buyback swap, not an amount to sweep. It reverts
  // MinimumOutputRequired when a buyback balance exists and minOut is 0, and
  // InternalSwapRequiresOperator for non-operator callers when a buyback is
  // pending.
  const minOut = parseUnits(minBuybackTokensOut, ctx.tokenDecimals);
  const [quoteFeeBalance, creatorTaxBalance, buybackQuoteBalance] = await Promise.all([
    callUint(client, ctx.curve, SEL.quoteFeeBalance),
    callUint(client, ctx.curve, SEL.creatorTaxBalance),
    callUint(client, ctx.curve, SEL.buybackQuoteBalance),
  ]);
  return runWrite(client, signer, {
    summary: `sweep all accrued fees from curve ${curveAddress} (minBuybackTokensOut ${minBuybackTokensOut})`,
    steps: [{ label: "sweepFees", to: ctx.curve, data: encodeCall(SEL.sweepFees, encodeUint(minOut)), value: 0n }],
    details: {
      curve: ctx.curve,
      minBuybackTokensOut: minOut.toString(),
      quoteFeeBalance: quoteFeeBalance.toString(),
      creatorTaxBalance: creatorTaxBalance.toString(),
      buybackQuoteBalance: buybackQuoteBalance.toString(),
      semantics: "sweeps the full pending fee balances; minBuybackTokensOut is the minimum tokens the internal buyback swap must return",
      ...(buybackQuoteBalance > 0n && minOut === 0n
        ? { warning: "a buyback balance is pending: on-chain this reverts MinimumOutputRequired unless minBuybackTokensOut > 0, and only the operator may sweep while a buyback is pending" }
        : {}),
    },
  }, opts);
}

export async function rescueCurveFeesTool(client: RpcClient, signer: Signer, curveAddress: string, opts: { dryRun?: boolean; confirm?: boolean }) {
  // Verified on-chain: curve.rescueFees is factory-internal (NotFactory); the
  // external path is factory.rescueCurveFees(token), owner-gated.
  const token = await resolveToToken(client, curveAddress);
  return runWrite(client, signer, {
    summary: `rescue stuck fees for ${token} (factory.rescueCurveFees, owner-gated)`,
    steps: [{ label: "factory.rescueCurveFees", to: FACTORY, data: encodeCall(SEL.rescueCurveFees, encodeAddress(token)), value: 0n }],
    details: { curve: curveAddress.toLowerCase(), token },
  }, opts);
}

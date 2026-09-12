import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  SEL,
  encodeAddress,
  encodeBytes,
  encodeCall,
  encodeUint,
  keccakHex,
  words,
  decodeUint,
  decodeInt24,
} from "./abi.js";
import { FACTORY, CHAIN_ID, MEME_HOOK, PonsError, getLaunchedToken, callAddress, callUint, erc20Meta } from "./pons.js";
import { formatUnits, parseUnits, isZeroAddress } from "./format.js";
import { withSlippage, floorAtLeast } from "./quote.js";
import { runWrite, WriteStep, discoverErc20Slots } from "./trade.js";
import type { RpcClient } from "./rpc.js";
import { RpcError } from "./rpc.js";
import type { Signer } from "./signer.js";

// Chain-local deployments (ponscli src/chain/addresses.ts, confirmed by eth_getCode there).
export const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
export const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ZERO = "0x0000000000000000000000000000000000000000";
const MSG_SENDER = "0x0000000000000000000000000000000000000001"; // router remaps to caller
// A payer address for quoter calls; the quoter does not move funds.
const DEAD_ADDRESS_SAFE = "0x000000000000000000000000000000000000dead";
const OPEN_DELTA = 0n; // SETTLE/TAKE: "the whole open delta"

// UniversalRouter command bytes and v4-periphery Actions opcodes (stock V4
// path only — this chain's router is a fork whose V3 command is non-standard).
const CMD_V4_SWAP = 0x10;
const CMD_PERMIT2_PERMIT = 0x0a;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE = 0x0e;

const DEADLINE_SECONDS = 300n;
const PERMIT_EXPIRY_SECONDS = 1_800n;
const MAX_UINT256 = (1n << 256n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  fee: bigint;
  tickSpacing: bigint;
  hooks: string;
}

export function sortedPoolKey(tokenA: string, tokenB: string, fee: bigint, tickSpacing: bigint, hooks: string): V4PoolKey {
  const [currency0, currency1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return { currency0: currency0.toLowerCase(), currency1: currency1.toLowerCase(), fee, tickSpacing, hooks: hooks.toLowerCase() };
}

function encodePoolKey(key: V4PoolKey): string {
  return (
    encodeAddress(key.currency0) +
    encodeAddress(key.currency1) +
    encodeUint(key.fee) +
    encodeUint(key.tickSpacing & ((1n << 256n) - 1n)) +
    encodeAddress(key.hooks)
  );
}

export function poolId(key: V4PoolKey): string {
  return keccakHex(Buffer.from(encodePoolKey(key), "hex"));
}

// ---------- quoter / pool state (read) ----------

export async function readPoolState(client: RpcClient, key: V4PoolKey) {
  const id = poolId(key);
  const [slot0Ret, liquidityRet] = await Promise.all([
    client.ethCall(V4_STATE_VIEW, encodeCall(SEL.v4GetSlot0, id)),
    client.ethCall(V4_STATE_VIEW, encodeCall(SEL.v4GetLiquidity, id)),
  ]);
  const w = words(slot0Ret);
  if (w.length < 2) throw new RpcError("RPC_FAILURE", "v4 getSlot0 returned too few words");
  return {
    sqrtPriceX96: decodeUint(w[0]),
    tick: Number(decodeInt24(w[1])),
    liquidity: decodeUint(words(liquidityRet)[0] ?? "0"),
  };
}

export async function quoteV4ExactIn(
  client: RpcClient,
  key: V4PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  from: string,
): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  if (amountIn < 0n || amountIn > UINT128_MAX) throw new PonsError("INVALID_PARAMS", "amountIn does not fit a uint128");
  // Single dynamic tuple argument: offset head, then 8-word tuple head + bytes tail.
  const tupleHead =
    encodePoolKey(key) +
    encodeUint(zeroForOne ? 1 : 0) +
    encodeUint(amountIn) +
    encodeUint(8 * 32);
  const data = encodeCall(SEL.v4QuoteExactInputSingle, encodeUint(32) + tupleHead + encodeBytes("0x"));
  const ret = await client.call<string>("eth_call", [{ from, to: V4_QUOTER, data }, "latest"]);
  const w = words(ret);
  if (w.length < 2) throw new RpcError("RPC_FAILURE", "v4 quoter returned too few words");
  return { amountOut: decodeUint(w[0]), gasEstimate: decodeUint(w[1]) };
}

// ---------- router command encoding ----------

export function encodeExactInSingle(key: V4PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMinimum: bigint): string {
  if (amountOutMinimum < 0n || amountOutMinimum > UINT128_MAX) throw new PonsError("INVALID_PARAMS", "amountOutMinimum does not fit a uint128");
  // A tuple with a dynamic member is offset-indirected when abi.encoded alone.
  return encodeUint(32) + encodePoolKey(key) + encodeUint(zeroForOne ? 1 : 0) + encodeUint(amountIn) + encodeUint(amountOutMinimum) + encodeUint(9 * 32) + encodeBytes("0x");
}

export function encodeSettle(currency: string, amount: bigint, payerIsUser: boolean): string {
  return encodeAddress(currency) + encodeUint(amount) + encodeUint(payerIsUser ? 1 : 0);
}

export function encodeSettleAll(currency: string, maxAmount: bigint): string {
  return encodeAddress(currency) + encodeUint(maxAmount);
}

export function encodeTake(currency: string, recipient: string, amount: bigint): string {
  return encodeAddress(currency) + encodeAddress(recipient) + encodeUint(amount);
}

const hexLen = (hex: string) => hex.replace(/^0x/, "").length / 2;

// abi.encode(bytes actions, bytes[] params)
export function encodeV4SwapCommand(actions: number[], params: string[]): string {
  const actionsBlob = encodeBytes("0x" + actions.map((a) => a.toString(16).padStart(2, "0")).join(""));
  const headWords = 2 * 32;
  const paramsOffset = headWords + hexLen(actionsBlob);
  let paramsEnc = encodeUint(params.length);
  let offset = params.length * 32;
  let tails = "";
  for (const p of params) {
    paramsEnc += encodeUint(offset);
    tails += encodeBytes(p);
    offset += hexLen(encodeBytes(p));
  }
  return encodeUint(64) + encodeUint(paramsOffset) + actionsBlob + paramsEnc + tails;
}

// abi.encode(bytes commands, bytes[] inputs, uint256 deadline) for router execute
export function encodeExecute(commands: number[], inputs: string[], deadline: bigint): string {
  const commandsBlob = encodeBytes("0x" + commands.map((c) => c.toString(16).padStart(2, "0")).join(""));
  const inputsOffset = 3 * 32 + hexLen(commandsBlob);
  let inputsEnc = encodeUint(inputs.length);
  let offset = inputs.length * 32;
  let tails = "";
  for (const inp of inputs) {
    inputsEnc += encodeUint(offset);
    tails += encodeBytes(inp);
    offset += hexLen(encodeBytes(inp));
  }
  return encodeCall(SEL.routerExecute, encodeUint(3 * 32) + encodeUint(inputsOffset) + encodeUint(deadline) + commandsBlob + inputsEnc + tails);
}

// ---------- Permit2 EIP-712 ----------

export interface PermitSingle {
  details: { token: string; amount: bigint; expiration: number; nonce: number };
  spender: string;
  sigDeadline: bigint;
}

export function permitDigest(permit: PermitSingle, chainId: number): Uint8Array {
  const te = new TextEncoder();
  const k = (s: string) => keccak_256(te.encode(s));
  const domainTypehash = k("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
  const detailsTypehash = k("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
  const singleTypehash = k(
    "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)",
  );
  const word = (v: bigint | number | string) =>
    typeof v === "string" ? encodeAddress(v) : encodeUint(v);
  const domainSeparator = keccak_256(
    Buffer.from(
      Buffer.from(domainTypehash).toString("hex") +
        Buffer.from(k("Permit2")).toString("hex") +
        encodeUint(chainId) +
        encodeAddress(PERMIT2),
      "hex",
    ),
  );
  const detailsHash = keccak_256(
    Buffer.from(
      Buffer.from(detailsTypehash).toString("hex") +
        word(permit.details.token) +
        word(permit.details.amount) +
        word(permit.details.expiration) +
        word(permit.details.nonce),
      "hex",
    ),
  );
  const structHash = keccak_256(
    Buffer.from(
      Buffer.from(singleTypehash).toString("hex") +
        Buffer.from(detailsHash).toString("hex") +
        word(permit.spender) +
        word(permit.sigDeadline),
      "hex",
    ),
  );
  return keccak_256(Buffer.concat([Buffer.from([0x19, 0x01]), domainSeparator, structHash]));
}

export function signPermit(signer: Signer, permit: PermitSingle, chainId: number): string {
  const digest = permitDigest(permit, chainId);
  const sigBytes = secp256k1.sign(digest, signer.privateKey, { prehash: false, format: "recovered", lowS: true });
  const sig = secp256k1.Signature.fromBytes(sigBytes, "recovered");
  if (sig.recovery === undefined) throw new Error("signing did not produce a recovery id");
  const pad = (v: bigint) => v.toString(16).padStart(64, "0");
  return "0x" + pad(sig.r) + pad(sig.s) + (27 + sig.recovery).toString(16).padStart(2, "0");
}

async function readPermit2Allowance(client: RpcClient, owner: string, token: string, spender: string) {
  const w = words(
    await client.ethCall(PERMIT2, encodeCall(SEL.permit2Allowance, encodeAddress(owner), encodeAddress(token), encodeAddress(spender))),
  );
  return { amount: decodeUint(w[0] ?? "0"), expiration: Number(decodeUint(w[1] ?? "0")), nonce: Number(decodeUint(w[2] ?? "0")) };
}

// abi.encode(PermitSingle, bytes signature) for the PERMIT2_PERMIT command
export function encodePermitInput(permit: PermitSingle, signature: string): string {
  const head =
    encodeAddress(permit.details.token) +
    encodeUint(permit.details.amount) +
    encodeUint(permit.details.expiration) +
    encodeUint(permit.details.nonce) +
    encodeAddress(permit.spender) +
    encodeUint(permit.sigDeadline) +
    encodeUint(7 * 32);
  return head + encodeBytes(signature);
}

// ---------- shared launch/pool resolution ----------

async function pairMeta(client: RpcClient, pairToken: string): Promise<{ decimals: number; symbol: string }> {
  // A transient RPC failure here must not silently fall back to 18 decimals —
  // on a 6-decimal pair that reinterprets every amount by 10^12. erc20Meta
  // rejects on RPC errors (only REVERTED is tolerated), preserving that.
  const m = await erc20Meta(client, pairToken);
  return { decimals: m.decimals ?? 18, symbol: m.symbol ?? "pair-token" };
}

async function poolContextFor(client: RpcClient, tokenAddress: string) {
  const lt = await getLaunchedToken(client, tokenAddress);
  if (!lt.exists) throw new PonsError("NOT_A_LAUNCH", `${tokenAddress} is not a Pons-launched token`);
  if (lt.phase !== 2) {
    throw new PonsError(
      "INVALID_PARAMS",
      lt.phase === 3
        ? `${tokenAddress} was rescued (phase 3); its pool and curve are closed`
        : `${tokenAddress} is not graduated (phase ${lt.phase}); curve tools apply instead`,
    );
  }
  // Native (zero address) and ERC-20-quoted pools are both supported. ERC-20
  // in-flows settle through Permit2 (permit signed at broadcast only); no
  // WRAP/UNWRAP envelope is needed on this router for the stock V4 commands.
  const native = isZeroAddress(lt.pairToken);
  const quoteCurrency = native ? ZERO : lt.pairToken.toLowerCase();
  const pair = native ? { decimals: 18, symbol: "ETH" } : await pairMeta(client, quoteCurrency);
  const hooks = await callAddress(client, FACTORY, SEL.memeHook);
  // The hook is part of the pool key, so an endpoint returning a different
  // hook redirects swaps to an attacker's pool. Pin the known-good value and
  // surface drift; broadcasting while drifted requires explicit opt-in.
  const hookDrifted = hooks.toLowerCase() !== MEME_HOOK.toLowerCase();
  const key = sortedPoolKey(lt.token, quoteCurrency, lt.poolFee, lt.tickSpacing, hooks);
  const state = await readPoolState(client, key);
  if (state.liquidity === 0n) throw new PonsError("INVALID_PARAMS", "the V4 pool holds no liquidity");
  return { lt, key, state, hookDrifted, native, quoteCurrency, pairDecimals: pair.decimals, pairSymbol: pair.symbol };
}

// ---------- read: pons_quote_swap ----------

export async function quoteSwapTool(client: RpcClient, tokenAddress: string, side: "buy" | "sell", amount: string) {
  await client.assertChain(CHAIN_ID);
  const { lt, key, state, hookDrifted, quoteCurrency, pairDecimals, pairSymbol } = await poolContextFor(client, tokenAddress);
  // Buy: quote asset in (pairDecimals), token out (18). Sell: token in (18),
  // quote asset out (pairDecimals). Pons curve tokens are 18-decimal.
  const inDecimals = side === "buy" ? pairDecimals : 18;
  const outDecimals = side === "buy" ? 18 : pairDecimals;
  const amountIn = parseUnits(amount, inDecimals);
  if (amountIn <= 0n) throw new PonsError("INVALID_PARAMS", "amount must be positive");
  const currencyIn = side === "buy" ? quoteCurrency : lt.token.toLowerCase();
  const zeroForOne = currencyIn === key.currency0;
  const { amountOut, gasEstimate } = await quoteV4ExactIn(client, key, zeroForOne, amountIn, DEAD_ADDRESS_SAFE);
  const fmtIn = (v: bigint) => `${formatUnits(v, inDecimals)} ${side === "buy" ? pairSymbol : "tokens"}`;
  const fmtOut = (v: bigint) => `${formatUnits(v, outDecimals)} ${side === "buy" ? "tokens" : pairSymbol}`;
  return {
    token: lt.token,
    side,
    nativeQuoted: quoteCurrency === ZERO,
    pool: {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: key.hooks,
      poolId: "0x" + poolId(key),
      sqrtPriceX96: state.sqrtPriceX96.toString(),
      tick: state.tick,
      liquidity: state.liquidity.toString(),
    },
    amountIn: amountIn.toString(),
    amountInFormatted: fmtIn(amountIn),
    amountOut: amountOut.toString(),
    amountOutFormatted: fmtOut(amountOut),
    quoterGasEstimate: gasEstimate.toString(),
    zeroForOne,
    hookDrifted: hookDrifted || undefined,
    note: "quoted on-chain via V4Quoter (hook fees included); not a local estimate",
  };
}

// ---------- Permit2 allowance state-override (dry-run sell simulation) ----------

// Permit2 AllowanceTransfer storage: mapping(owner => mapping(token =>
// mapping(spender => PackedAllowance))) at a small slot number. PackedAllowance
// is one word: uint160 amount | uint48 expiration | uint48 nonce.
function permit2AllowanceKey(owner: string, token: string, spender: string, slot: number): string {
  const k1 = keccak_256(Buffer.from(encodeAddress(owner) + encodeUint(slot), "hex"));
  const k2 = keccak_256(Buffer.from(encodeAddress(token) + Buffer.from(k1).toString("hex"), "hex"));
  const k3 = keccak_256(Buffer.from(encodeAddress(spender) + Buffer.from(k2).toString("hex"), "hex"));
  return "0x" + Buffer.from(k3).toString("hex");
}

const MAX_UINT48 = (1n << 48n) - 1n;

// Grant the router a generous Permit2 allowance in-simulation by probing for
// the allowance mapping slot. Returns undefined when the slot isn't found.
async function permit2AllowanceOverride(
  client: RpcClient,
  owner: string,
  token: string,
  tokensIn: bigint,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  const marker = tokensIn * 4n + 10n ** 30n;
  const word = "0x" + (marker | (MAX_UINT48 << 160n)).toString(16).padStart(64, "0");
  for (let slot = 0; slot < 6; slot++) {
    const key = permit2AllowanceKey(owner, token, UNIVERSAL_ROUTER, slot);
    const overrides = { [PERMIT2]: { stateDiff: { [key]: word } } };
    const w = words(
      await client.call<string>("eth_call", [
        { to: PERMIT2, data: encodeCall(SEL.permit2Allowance, encodeAddress(owner), encodeAddress(token), encodeAddress(UNIVERSAL_ROUTER)) },
        "latest",
        overrides,
      ]),
    );
    if (w.length && decodeUint(w[0]) === marker) return overrides;
  }
  return undefined;
}

// ---------- write: pons_swap ----------

export async function swapTool(
  client: RpcClient,
  signer: Signer,
  tokenAddress: string,
  side: "buy" | "sell",
  amount: string,
  minOut?: string,
  opts: { dryRun?: boolean; confirm?: boolean; acceptContractDrift?: boolean } = {},
) {
  const { lt, key, hookDrifted, quoteCurrency, pairDecimals, pairSymbol } = await poolContextFor(client, tokenAddress);
  const token = lt.token.toLowerCase();
  // Buy: quote asset in (pairDecimals), token out (18). Sell: token in, quote asset out.
  const inDecimals = side === "buy" ? pairDecimals : 18;
  const outDecimals = side === "buy" ? 18 : pairDecimals;
  const amountIn = parseUnits(amount, inDecimals);
  if (amountIn <= 0n) throw new PonsError("INVALID_PARAMS", "amount must be positive");
  const broadcasting = opts.dryRun === false && opts.confirm === true;
  // The hook address comes over RPC; a drifted hook means the pool key (and
  // thus the swap) targets an unverified pool. Refuse to broadcast unless the
  // caller explicitly acknowledges the drift.
  if (broadcasting && hookDrifted && opts.acceptContractDrift !== true) {
    throw new PonsError(
      "INVALID_PARAMS",
      `live memeHook ${key.hooks} differs from the pinned hook ${MEME_HOOK}; the swap would target an unverified pool. Refusing to broadcast — re-run with acceptContractDrift=true only if you trust the new hook.`,
    );
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + DEADLINE_SECONDS;

  const currencyIn = side === "buy" ? quoteCurrency : token;
  const currencyOut = side === "buy" ? token : quoteCurrency;
  const nativeIn = currencyIn === ZERO;
  const zeroForOne = currencyIn === key.currency0;

  const steps: WriteStep[] = [];
  let commands: number[];
  let inputs: string[];
  let value = 0n;
  let permit2Override: Record<string, Record<string, unknown>> | undefined;
  let dryRunNote: string | undefined;

  const { amountOut } = await quoteV4ExactIn(client, key, zeroForOne, amountIn, signer.address);
  const quotedFloor = floorAtLeast(withSlippage(amountOut, 500n), minOut !== undefined ? parseUnits(minOut, outDecimals) : undefined);

  if (nativeIn) {
    // Native quote asset in: settle from msg.value, take the token out.
    inputs = [
      encodeV4SwapCommand(
        [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE],
        [
          encodeExactInSingle(key, zeroForOne, amountIn, quotedFloor),
          encodeSettle(ZERO, amountIn, false),
          encodeTake(currencyOut, MSG_SENDER, OPEN_DELTA),
        ],
      ),
    ];
    commands = [CMD_V4_SWAP];
    value = amountIn;
  } else {
    // ERC-20 in (selling the launched token, or buying with a pair token):
    // Permit2 moves the input. Unlimited ERC-20 approve to Permit2 if needed;
    // the per-trade grant is the PermitSingle signature (broadcast only).
    const balance = await callUint(client, currencyIn, SEL.balanceOf, encodeAddress(signer.address));
    if (broadcasting && balance < amountIn) {
      throw new PonsError(
        "INVALID_PARAMS",
        `signer holds ${formatUnits(balance, inDecimals)} but tried to ${side} ${amount} (${side === "sell" ? "tokens" : pairSymbol})`,
      );
    }
    const erc20Allowance = await callUint(client, currencyIn, SEL.allowance, encodeAddress(signer.address), encodeAddress(PERMIT2));
    if (erc20Allowance < amountIn) {
      steps.push({
        label: `approve Permit2 to move ${side === "sell" ? "the token" : pairSymbol} (unlimited)`,
        to: currencyIn,
        data: encodeCall(SEL.approve, encodeAddress(PERMIT2), encodeUint(MAX_UINT256)),
        value: 0n,
      });
    }
    const swapInput = encodeV4SwapCommand(
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE],
      [
        encodeExactInSingle(key, zeroForOne, amountIn, quotedFloor),
        encodeSettleAll(currencyIn, amountIn),
        encodeTake(currencyOut, MSG_SENDER, OPEN_DELTA),
      ],
    );

    if (broadcasting) {
      // Sign the PermitSingle for this exact trade only when broadcasting —
      // a dry-run must never mint a live, replayable signature.
      const p2 = await readPermit2Allowance(client, signer.address, currencyIn, UNIVERSAL_ROUTER);
      const nowSec = Math.floor(Date.now() / 1000);
      const permit: PermitSingle = {
        details: { token: currencyIn, amount: amountIn, expiration: nowSec + Number(PERMIT_EXPIRY_SECONDS), nonce: p2.nonce },
        spender: UNIVERSAL_ROUTER,
        sigDeadline: now + PERMIT_EXPIRY_SECONDS,
      };
      const signature = signPermit(signer, permit, CHAIN_ID);
      commands = [CMD_PERMIT2_PERMIT, CMD_V4_SWAP];
      inputs = [encodePermitInput(permit, signature), swapInput];
    } else {
      // Dry-run: simulate the bare V4_SWAP with a state-diff override granting
      // the router a Permit2 allowance. Nothing is signed.
      commands = [CMD_V4_SWAP];
      inputs = [swapInput];
      permit2Override = await permit2AllowanceOverride(client, signer.address, currencyIn, amountIn).catch(() => undefined);
      dryRunNote =
        "dry-run simulated the swap without the PERMIT2_PERMIT command (no signature was created); the Permit2 allowance was granted via a state override. Broadcast prepends PERMIT2_PERMIT with a fresh 30-minute signature.";
    }
  }

  const inLabel = nativeIn ? "native in" : side === "sell" ? "token in" : `${pairSymbol} in`;
  const outLabel = side === "buy" ? "token out" : quoteCurrency === ZERO ? "native out" : `${pairSymbol} out`;
  steps.push({
    label: nativeIn
      ? "V4_SWAP (native in, token out)"
      : broadcasting
        ? `PERMIT2_PERMIT + V4_SWAP (${inLabel}, ${outLabel})`
        : `V4_SWAP (${inLabel}, ${outLabel})`,
    to: UNIVERSAL_ROUTER,
    data: encodeExecute(commands, inputs, deadline),
    value,
    dependsOnPrior: steps.length > 0,
    overrides: nativeIn ? undefined : { ...(await sellOverrides(client, signer, currencyIn, amountIn)), ...(permit2Override ?? {}) },
  });

  return runWrite(
    client,
    signer,
    {
      summary: `${side} ${amount} ${side === "buy" ? `${pairSymbol} worth of` : "of"} ${token} on the Uniswap V4 pool`,
      steps,
      details: {
        token: lt.token,
        side,
        nativeQuoted: quoteCurrency === ZERO,
        poolKey: { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks },
        hookDrifted: hookDrifted || undefined,
        quote: { amountIn: amountIn.toString(), amountOut: amountOut.toString(), minOut: quotedFloor.toString(), slippageBps: 500 },
        deadline: Number(deadline),
        ...(dryRunNote ? { dryRunNote } : {}),
      },
    },
    opts,
  );
}

// Overrides making a token-input dry-run simulatable (sell, or buying with a
// pair token): input-token balance + ERC-20 allowance to Permit2 (discovered
// slots). The Permit2 allowance itself is granted via permit2AllowanceOverride
// — no signature is created in dry-run.
async function sellOverrides(client: RpcClient, signer: Signer, token: string, tokensIn: bigint) {
  try {
    const slots = await discoverErc20Slots(client, token, signer.address, PERMIT2);
    const big = "0x" + (tokensIn * 4n).toString(16).padStart(64, "0");
    return { [token]: { stateDiff: { [slots.balance]: big, [slots.allowance]: big } } };
  } catch {
    return undefined;
  }
}

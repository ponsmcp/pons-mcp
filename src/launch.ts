import {
  SEL,
  TOPIC,
  encodeAddress,
  encodeBool,
  encodeBytes32,
  encodeCall,
  encodeString,
  encodeUint,
  keccakHex,
  topicAddress,
  words,
  decodeAddress,
  decodeUint,
} from "./abi.js";
import { RpcClient, RpcError } from "./rpc.js";
import {
  CHAIN_ID,
  FACTORY,
  LAUNCH_AND_BUY_ROUTER,
  EXPLORER,
  PonsError,
  getLaunchedToken,
} from "./pons.js";
import { formatEth, parseUnits } from "./format.js";
import { prepareTx, signEip1559, sendAndWait, feeMarket, TxRequest } from "./tx.js";
import type { Signer } from "./signer.js";

// Sentinel the protocol uses for the native asset (ETH) as quote token —
// NOT WETH. Mirrors ponscli's NATIVE_PAIR_TOKEN.
export const NATIVE_PAIR_TOKEN = "0x0000000000000000000000000000000000000000";

const BPS = 10_000n;
const SLIPPAGE_BPS = 500n; // dev buy is atomic with the launch; 5% floor is ample
const MAX_SNIPE_TAX_EXEMPTIONS = 32;

export interface LaunchInputs {
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
  socials?: { twitter?: string; telegram?: string; discord?: string; website?: string; farcaster?: string };
  creatorFeeRecipient?: string;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
  launchConfigId?: number;
  pairToken?: string;
  devBuyEth?: string;
  snipeTaxExemptions?: string[];
  /** Acknowledge a drifted live launchForwarder (differs from the pinned address). */
  acceptContractDrift?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
}

// Metadata byte-length caps from PonsV2LaunchDeployer (ponscli METADATA_LIMITS).
const METADATA_LIMITS: [string, number][] = [
  ["name", 64],
  ["symbol", 16],
  ["logo", 512],
  ["description", 2048],
  ["twitter", 256],
  ["telegram", 256],
  ["discord", 256],
  ["website", 256],
  ["farcaster", 256],
];

// ---------- TokenParams ABI encoding (dynamic tuple) ----------

interface TokenParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: [string, string, string, string, string];
  creatorFeeRecipient: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: string; // bytes32
  salt: string; // bytes32
}

// A tuple of 5 dynamic strings — socials. Head of 5 offsets, then string tails.
function encodeSocials(socials: [string, string, string, string, string]): string {
  const blobs = socials.map(encodeString);
  let head = "";
  let tail = "";
  let offset = 5 * 32;
  for (const blob of blobs) {
    head += encodeUint(offset);
    tail += blob;
    offset += blob.length / 2;
  }
  return head + tail;
}

export function encodeTokenParams(p: TokenParams): string {
  const socialsBlob = encodeSocials(p.socials);
  const dynBlobs = [encodeString(p.name), encodeString(p.symbol), encodeString(p.logo), encodeString(p.description), socialsBlob];
  const headWords = 10 * 32;
  let head = "";
  let tail = "";
  let offset = headWords;
  for (const blob of dynBlobs) {
    head += encodeUint(offset);
    tail += blob;
    offset += blob.length / 2;
  }
  head += encodeAddress(p.creatorFeeRecipient);
  head += encodeUint(p.creatorTaxBps);
  head += encodeBool(p.buybackEnabled);
  head += encodeBytes32(p.expectedEconomics);
  head += encodeBytes32(p.salt);
  return head + tail;
}

function encodeAddressArray(addrs: string[]): string {
  return encodeUint(addrs.length) + addrs.map(encodeAddress).join("");
}

// Top-level: (params dyn, statics..., exemptions dyn).
function encodeLaunchArgs(paramsBlob: string, statics: string[], exemptions: string[]): string {
  const headWords = (2 + statics.length) * 32;
  const offsetParams = headWords;
  const offsetExemptions = headWords + paramsBlob.length / 2;
  return (
    encodeUint(offsetParams) +
    statics.join("") +
    encodeUint(offsetExemptions) +
    paramsBlob +
    encodeAddressArray(exemptions)
  );
}

// ---------- salt (identical derivation to ponscli's saltFor default) ----------

function saltFor(name: string, symbol: string, nonce = ""): string {
  return keccakHex(Buffer.from(`${name} ${symbol} ${nonce}`, "utf8"));
}

// ---------- opening-buy quote (port of ponscli quoteBuy, snipe tax = 0) ----------

interface OpeningQuote {
  tokensOut: bigint;
  minTokensOut: bigint;
  supplyShareBps: bigint;
  clamped: boolean;
}

function quoteOpeningBuy(
  config: { supply: bigint; curveFeeBps: bigint; phantomQuote: bigint; graduationThreshold: bigint },
  creatorTaxBps: bigint,
  offered: bigint,
): OpeningQuote {
  const { supply, curveFeeBps, phantomQuote, graduationThreshold: threshold } = config;
  // Pathological factory configs would otherwise crash on a division by zero.
  if (supply <= 0n || phantomQuote + threshold <= 0n) {
    throw new PonsError("INVALID_PARAMS", "launch config has degenerate economics (zero supply or zero phantom+threshold)");
  }
  if (curveFeeBps + creatorTaxBps >= BPS) {
    throw new PonsError("INVALID_PARAMS", `launch config fees (${curveFeeBps}+${creatorTaxBps} bps) leave nothing for the buyer`);
  }
  const reserved = (supply * phantomQuote) / (phantomQuote + threshold);
  const sellable = supply - reserved;
  if (sellable <= 0n) throw new PonsError("INVALID_PARAMS", "launch config leaves no sellable supply");
  const legs = (amount: bigint) => ({
    fee: (amount * curveFeeBps) / BPS,
    tax: (amount * creatorTaxBps) / BPS,
  });
  let spent = offered;
  let { fee, tax } = legs(spent);
  const net = spent - fee - tax;
  let tokensOut = (net * supply) / (phantomQuote + net);
  let clamped = false;
  if (tokensOut > sellable) {
    clamped = true;
    tokensOut = sellable;
    const netIn = (sellable * phantomQuote) / (supply - sellable) + 1n; // getAmountIn, rounds up
    const denom = BPS - curveFeeBps - creatorTaxBps;
    const grossed = (netIn * BPS) % denom === 0n ? (netIn * BPS) / denom : (netIn * BPS) / denom + 1n;
    spent = grossed < offered ? grossed : offered;
    ({ fee, tax } = legs(spent));
  }
  // Slippage floor must respect the curve's price bound
  // (spent * minTokensOut <= received * tokensOut): on a clamped fill,
  // spent < offered, so scale the floor down accordingly.
  const priceBoundBase = clamped && spent > 0n ? (tokensOut * spent) / offered : tokensOut;
  return {
    tokensOut,
    minTokensOut: (priceBoundBase * (BPS - SLIPPAGE_BPS)) / BPS,
    supplyShareBps: (tokensOut * BPS) / supply,
    clamped,
  };
}

// ---------- daily launch cap (in-memory, rolling 24h) ----------

// Object identity per reservation: a failed launch must remove ITS OWN slot —
// a LIFO pop could remove a concurrent launch's reservation instead.
const launchTimestamps: { t: number }[] = [];

function checkDailyCap(maxPerDay: number): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  while (launchTimestamps.length > 0 && launchTimestamps[0].t < cutoff) launchTimestamps.shift();
  if (launchTimestamps.length >= maxPerDay) {
    throw new PonsError(
      "CAP_EXCEEDED",
      `daily launch cap reached: ${launchTimestamps.length}/${maxPerDay} launches in the last 24h (PONS_MAX_LAUNCHES_PER_DAY)`,
    );
  }
  return maxPerDay - launchTimestamps.length;
}

export interface LaunchCaps {
  maxDevBuyWei: bigint;
  maxLaunchesPerDay: number;
}

export function capsFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchCaps {
  // Safety caps fail closed: a malformed value crashes startup rather than
  // silently disabling the cap (NaN comparisons are always false).
  const maxLaunchesPerDay = Number(env.PONS_MAX_LAUNCHES_PER_DAY ?? "5");
  if (!Number.isInteger(maxLaunchesPerDay) || maxLaunchesPerDay < 0) {
    throw new Error(`PONS_MAX_LAUNCHES_PER_DAY must be a non-negative integer, got: ${env.PONS_MAX_LAUNCHES_PER_DAY}`);
  }
  return {
    maxDevBuyWei: parseUnits(env.PONS_MAX_DEV_BUY_ETH ?? "0.05", 18),
    maxLaunchesPerDay,
  };
}

// ---------- main entry ----------

export async function launchToken(client: RpcClient, signer: Signer, inputs: LaunchInputs, caps: LaunchCaps) {
  await client.assertChain(CHAIN_ID);
  const dryRun = inputs.dryRun ?? true;
  const confirm = inputs.confirm ?? false;

  // --- validate everything the factory would reject, before touching the chain ---
  const name = inputs.name ?? "";
  const symbol = inputs.symbol ?? "";
  if (name.trim() === "" || symbol.trim() === "") {
    throw new PonsError("INVALID_PARAMS", "name and symbol are required");
  }
  const fields: [string, string][] = [
    ["name", name],
    ["symbol", symbol],
    ["logo", inputs.logo ?? ""],
    ["description", inputs.description ?? ""],
    ["twitter", inputs.socials?.twitter ?? ""],
    ["telegram", inputs.socials?.telegram ?? ""],
    ["discord", inputs.socials?.discord ?? ""],
    ["website", inputs.socials?.website ?? ""],
    ["farcaster", inputs.socials?.farcaster ?? ""],
  ];
  for (const [field, value] of fields) {
    const limit = METADATA_LIMITS.find(([f]) => f === field)![1];
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > limit) {
      throw new PonsError("INVALID_PARAMS", `${field} is ${bytes} bytes; the contract accepts ${limit}`);
    }
  }

  const pairToken = (inputs.pairToken ?? NATIVE_PAIR_TOKEN).toLowerCase();
  const nativePair = pairToken === NATIVE_PAIR_TOKEN;
  const devBuy = parseUnits(inputs.devBuyEth ?? "0", 18);
  if (!nativePair && devBuy > 0n) {
    throw new PonsError("INVALID_PARAMS", "devBuyEth is only supported for ETH-paired launches (ERC-20 pairs need an approval flow this tool does not implement)");
  }
  if (devBuy > caps.maxDevBuyWei) {
    throw new PonsError(
      "CAP_EXCEEDED",
      `devBuyEth ${formatEth(devBuy)} exceeds PONS_MAX_DEV_BUY_ETH cap of ${formatEth(caps.maxDevBuyWei)}`,
    );
  }
  const exemptions = inputs.snipeTaxExemptions ?? [];
  const exemptionCap = devBuy > 0n ? MAX_SNIPE_TAX_EXEMPTIONS - 1 : MAX_SNIPE_TAX_EXEMPTIONS;
  if (exemptions.length > exemptionCap) {
    throw new PonsError("INVALID_PARAMS", `at most ${exemptionCap} snipeTaxExemptions are accepted${devBuy > 0n ? " with a dev buy (the router appends the buy recipient)" : ""}`);
  }

  const configId = BigInt(inputs.launchConfigId ?? 0);
  const creatorTaxBps = BigInt(inputs.creatorTaxBps ?? 0);

  // --- live factory state ---
  const callUint = async (sel: string, ...args: string[]) => {
    const w = words(await client.ethCall(FACTORY, encodeCall(sel, ...args)));
    return w.length ? decodeUint(w[0]) : 0n;
  };
  const [launchFee, launchEnabled, canLaunchFlag, maxCreatorTaxBps, configRet, economicsRet, forwarderRet] =
    await Promise.all([
      callUint(SEL.launchFee),
      callUint(SEL.launchEnabled),
      callUint(SEL.canLaunch, encodeAddress(signer.address)),
      callUint(SEL.maxCreatorTaxBps),
      client.ethCall(FACTORY, encodeCall(SEL.getLaunchConfig, encodeUint(configId))),
      client.ethCall(FACTORY, encodeCall(SEL.previewLaunchEconomics, encodeUint(configId), encodeAddress(pairToken))),
      client.ethCall(FACTORY, encodeCall(SEL.launchForwarder)),
    ]);
  const configWords = words(configRet);
  if (configWords.length < 7) throw new RpcError("RPC_FAILURE", "getLaunchConfig returned too few words");
  const config = {
    supply: decodeUint(configWords[0]),
    curveFeeBps: decodeUint(configWords[1]),
    phantomQuote: decodeUint(configWords[2]),
    graduationThreshold: decodeUint(configWords[3]),
    enabled: decodeUint(configWords[6]) !== 0n,
  };
  if (!launchEnabled) throw new PonsError("INVALID_PARAMS", "launching is globally disabled on the factory");
  if (!canLaunchFlag) throw new PonsError("INVALID_PARAMS", `signer ${signer.address} is not allowed to launch (not whitelisted)`);
  if (!config.enabled) throw new PonsError("INVALID_PARAMS", `launch config ${configId} is disabled`);
  if (creatorTaxBps > maxCreatorTaxBps) {
    throw new PonsError("INVALID_PARAMS", `creatorTaxBps ${creatorTaxBps} exceeds factory cap ${maxCreatorTaxBps}`);
  }
  if (words(economicsRet).length !== 1) {
    throw new RpcError("RPC_FAILURE", "previewLaunchEconomics returned a malformed result");
  }
  const expectedEconomics = economicsRet;
  if (BigInt(expectedEconomics) === 0n) {
    throw new PonsError("INVALID_PARAMS", "factory returned a zero economics digest; refusing to launch unpinned");
  }
  // The forwarder is owner-settable; use the live value, flag if it drifted.
  const forwarderWords = words(forwarderRet);
  if (forwarderWords.length < 1) throw new RpcError("RPC_FAILURE", "launchForwarder returned a malformed result");
  const forwarder = decodeAddress(forwarderWords[0]);
  const forwarderDrifted = forwarder !== LAUNCH_AND_BUY_ROUTER.toLowerCase();

  const params: TokenParams = {
    name,
    symbol,
    logo: inputs.logo ?? "",
    description: inputs.description ?? "",
    socials: [
      inputs.socials?.twitter ?? "",
      inputs.socials?.telegram ?? "",
      inputs.socials?.discord ?? "",
      inputs.socials?.website ?? "",
      inputs.socials?.farcaster ?? "",
    ],
    creatorFeeRecipient: (inputs.creatorFeeRecipient ?? signer.address).toLowerCase(),
    creatorTaxBps: Number(creatorTaxBps),
    buybackEnabled: inputs.buybackEnabled ?? false,
    expectedEconomics,
    salt: saltFor(name, symbol),
  };

  // --- build the call: factory direct (no dev buy) or atomic router (dev buy) ---
  const quote = devBuy > 0n ? quoteOpeningBuy(config, creatorTaxBps, devBuy) : null;
  const paramsBlob = encodeTokenParams(params);
  let req: TxRequest;
  let route: "factory" | "launchAndBuyRouter";
  if (devBuy === 0n) {
    // factory requires msg.value == launchFee exactly
    route = "factory";
    req = {
      to: FACTORY,
      data: encodeCall(SEL.launchToken, encodeLaunchArgs(paramsBlob, [encodeUint(configId), encodeAddress(pairToken)], exemptions)),
      value: launchFee,
    };
  } else {
    route = "launchAndBuyRouter";
    req = {
      to: forwarder,
      data: encodeCall(
        SEL.launchAndBuy,
        encodeLaunchArgs(
          paramsBlob,
          [encodeUint(configId), encodeAddress(pairToken), encodeUint(devBuy), encodeUint(quote!.minTokensOut), encodeAddress(signer.address)],
          exemptions,
        ),
      ),
      value: launchFee + devBuy,
    };
  }

  // --- simulate (always, before anything can broadcast) ---
  const simulated = await simulate(client, signer, req);

  const fees = await feeMarket(client);
  const base = {
    mode: dryRun || !confirm ? "dry-run" : "broadcast",
    route,
    to: req.to,
    forwarderDrifted: route === "launchAndBuyRouter" ? forwarderDrifted : undefined,
    signer: signer.address,
    params: {
      name,
      symbol,
      launchConfigId: Number(configId),
      pairToken,
      ethPaired: nativePair,
      creatorFeeRecipient: params.creatorFeeRecipient,
      creatorTaxBps: Number(creatorTaxBps),
      buybackEnabled: params.buybackEnabled,
      snipeTaxExemptions: exemptions,
      salt: "0x" + params.salt,
      expectedEconomics,
    },
    economics: {
      launchFeeWei: launchFee.toString(),
      launchFee: formatEth(launchFee),
      devBuyWei: devBuy.toString(),
      devBuy: formatEth(devBuy),
      txValueWei: req.value.toString(),
      txValue: formatEth(req.value),
      ...(quote
        ? {
            tokensOut: quote.tokensOut.toString(),
            minTokensOut: quote.minTokensOut.toString(),
            supplyShareBps: Number(quote.supplyShareBps),
            clamped: quote.clamped,
          }
        : {}),
    },
    gas: {
      estimate: simulated.gasEstimate?.toString() ?? null,
      estimateWithBuffer: simulated.gasEstimate ? ((simulated.gasEstimate * 120n) / 100n).toString() : null,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      estimatedGasCost: simulated.gasEstimate
        ? formatEth(((simulated.gasEstimate * 120n) / 100n) * fees.maxFeePerGas)
        : null,
      estimatedTotalCost: simulated.gasEstimate
        ? formatEth(((simulated.gasEstimate * 120n) / 100n) * fees.maxFeePerGas + req.value)
        : null,
      estimateError: simulated.gasError,
    },
    simulation: {
      ok: simulated.ok,
      predictedToken: simulated.token,
      predictedCurve: simulated.curve,
      error: simulated.error,
    },
    calldata: req.data,
  };

  if (dryRun || !confirm) {
    return {
      ...base,
      note: "dry-run only — nothing was broadcast. Re-run with dryRun=false AND confirm=true to send.",
    };
  }

  if (!simulated.ok) {
    throw new PonsError("INVALID_PARAMS", `simulation reverted; refusing to broadcast: ${simulated.error}`);
  }
  // The dev-buy route sends real value to the forwarder, whose address is read
  // live over RPC. A drifted forwarder (factory-owner rotation, or a lying
  // endpoint) must be explicitly acknowledged before broadcasting.
  if (route === "launchAndBuyRouter" && forwarderDrifted && inputs.acceptContractDrift !== true) {
    throw new PonsError(
      "INVALID_PARAMS",
      `live launchForwarder ${forwarder} differs from the pinned router ${LAUNCH_AND_BUY_ROUTER}; the dev buy would send ${formatEth(req.value)} to an unverified contract. Refusing to broadcast — re-run with acceptContractDrift=true only if you trust the new forwarder.`,
    );
  }
  checkDailyCap(caps.maxLaunchesPerDay);
  // Reserve the cap slot before broadcasting: a concurrent launch must not
  // pass the check while this one is in flight. Roll back ONLY when nothing
  // was broadcast — once eth_sendRawTransaction accepted the tx it may mine
  // even if receipt polling fails, so post-send failures keep the slot.
  const slot = { t: Date.now() };
  launchTimestamps.push(slot);
  let receipt;
  let sent = false;
  try {
    const prepared = await prepareTx(client, signer, req);
    const rawTx = signEip1559(signer, CHAIN_ID, prepared);
    sent = true; // sendAndWait's first action is the broadcast
    receipt = await sendAndWait(client, rawTx);
  } catch (e) {
    if (!sent) {
      const idx = launchTimestamps.indexOf(slot);
      if (idx >= 0) launchTimestamps.splice(idx, 1);
    }
    throw e;
  }

  const launchLog = (receipt.logs ?? []).find(
    (l) =>
      l.address.toLowerCase() === FACTORY.toLowerCase() &&
      l.topics.length >= 3 &&
      l.topics[0]?.toLowerCase() === "0x" + TOPIC.TokenLaunched,
  );
  const token = launchLog ? topicAddress(launchLog.topics[1]) : simulated.token;
  const curve = launchLog ? topicAddress(launchLog.topics[2]) : simulated.curve;
  const confirmed = token ? await getLaunchedToken(client, token).catch(() => null) : null;

  return {
    ...base,
    mode: "broadcast",
    dailyCap: { used: launchTimestamps.length, remaining: caps.maxLaunchesPerDay - launchTimestamps.length, max: caps.maxLaunchesPerDay },
    transaction: {
      hash: receipt.transactionHash,
      blockNumber: Number(BigInt(receipt.blockNumber ?? "0x0")),
      gasUsed: Number(BigInt(receipt.gasUsed ?? "0x0")),
      effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? "0x0").toString(),
      status: "success",
    },
    launched: {
      token,
      curve,
      phase: confirmed?.phase,
      explorerToken: token ? `${EXPLORER}/token/${token}` : undefined,
    },
    explorerTx: `${EXPLORER}/tx/${receipt.transactionHash}`,
  };
}

interface Simulation {
  ok: boolean;
  token?: string;
  curve?: string;
  error?: string;
  gasEstimate?: bigint;
  gasError?: string;
}

async function simulate(client: RpcClient, signer: Signer, req: TxRequest): Promise<Simulation> {
  const out: Simulation = { ok: false };
  const callObj = { from: signer.address, to: req.to, data: req.data, value: "0x" + req.value.toString(16) };
  try {
    const ret = await client.call<string>("eth_call", [callObj, "latest"]);
    const w = words(ret);
    if (w.length >= 2) {
      out.token = decodeAddress(w[0]);
      out.curve = decodeAddress(w[1]);
    }
    out.ok = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  try {
    out.gasEstimate = BigInt(
      await client.call<string>("eth_estimateGas", [callObj]),
    );
  } catch (e) {
    out.gasError = e instanceof Error ? e.message : String(e);
  }
  return out;
}

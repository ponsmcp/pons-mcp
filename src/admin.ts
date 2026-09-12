import { SEL, encodeAddress, encodeBool, encodeCall, encodeUint } from "./abi.js";
import { FACTORY, PonsError, callAddress } from "./pons.js";
import { parseUnits } from "./format.js";
import { runWrite, WriteStep } from "./trade.js";
import type { RpcClient } from "./rpc.js";
import type { Signer } from "./signer.js";

// Generic owner-only surface for the factory. These revert for
// non-owners; the tool simulates first so that is visible in the dry-run.

export const ADMIN_FNS = [
  "setLaunchFee",
  "setLaunchEnabled",
  "setMaxCreatorTaxBps",
  "setSnipeTaxStartBps",
  "setSnipeTaxSeconds",
  "setPairTokenApproved",
  "setPairTokenEconomics",
  "setCreatorFeeRecipient",
  "addLaunchConfig",
  "updateLaunchConfig",
  "setWhitelistedLauncher",
  "setGraduationExecutor",
  "setLaunchDeployer",
  "setLaunchForwarder",
  "transferOwnership",
  "acceptOwnership",
  "renounceOwnership",
] as const;

export type AdminFn = (typeof ADMIN_FNS)[number];

type Args = Record<string, unknown>;

function needAddr(args: Args, field: string): string {
  const v = args[field];
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new PonsError("INVALID_ADDRESS", `args.${field} must be a 0x-prefixed 20-byte hex address`);
  }
  return v;
}

function needUint(args: Args, field: string): bigint {
  const v = args[field];
  // JSON numbers above 2^53 are rounded doubles; refuse them rather than
  // silently encoding the wrong value. Pass big values as strings.
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new PonsError("INVALID_PARAMS", `args.${field} must be a non-negative integer (string, or number below 2^53)`);
}

// Decimal-string amounts for human-facing fields, scaled by `decimals`
// (18 for ETH-denominated values, the pair token's own decimals otherwise).
function needAmount(args: Args, field: string, decimals: number): bigint {
  const v = args[field];
  if (typeof v !== "string") throw new PonsError("INVALID_PARAMS", `args.${field} must be a decimal string`);
  return parseUnits(v, decimals);
}

function needBool(args: Args, field: string): boolean {
  const v = args[field];
  if (typeof v !== "boolean") throw new PonsError("INVALID_PARAMS", `args.${field} must be a boolean`);
  return v;
}

function needInt(args: Args, field: string): bigint {
  const v = args[field];
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  throw new PonsError("INVALID_PARAMS", `args.${field} must be an integer`);
}

const UINT24_MAX = (1 << 24) - 1;
const INT24_MIN = -(1 << 23);
const INT24_MAX = (1 << 23) - 1;

function needUint24(args: Args, field: string): bigint {
  const v = needUint(args, field);
  if (v > BigInt(UINT24_MAX)) throw new PonsError("INVALID_PARAMS", `args.${field} must fit a uint24 (0..${UINT24_MAX})`);
  return v;
}

function needInt24(args: Args, field: string): bigint {
  const v = needInt(args, field);
  if (v < BigInt(INT24_MIN) || v > BigInt(INT24_MAX)) {
    throw new PonsError("INVALID_PARAMS", `args.${field} must fit an int24 (${INT24_MIN}..${INT24_MAX})`);
  }
  return v;
}

// Unbounded decimals becomes a memory-DoS via padEnd in parseUnits.
function needDecimals(args: Args): number {
  const v = Number(needUint(args, "decimals"));
  if (v > 36) throw new PonsError("INVALID_PARAMS", "args.decimals must be between 0 and 36");
  return v;
}

// (uint256,uint256,uint256,uint256,uint24,int24,bool) — all static, inline.
// phantomQuote/graduationThreshold are denominated in the pair token's units;
// pass args.decimals for non-18-decimal pair tokens (default 18 = ETH).
function encodeLaunchConfigTuple(args: Args): string {
  const decimals = args.decimals === undefined ? 18 : needDecimals(args);
  return (
    encodeUint(needUint(args, "supply")) +
    encodeUint(needUint(args, "curveFeeBps")) +
    encodeUint(needAmount(args, "phantomQuote", decimals)) +
    encodeUint(needAmount(args, "graduationThreshold", decimals)) +
    encodeUint(needUint24(args, "poolFee")) +
    encodeUint(needInt24(args, "tickSpacing") & ((1n << 256n) - 1n)) +
    encodeBool(needBool(args, "enabled"))
  );
}

function buildAdminCall(fn: AdminFn, args: Args): string {
  switch (fn) {
    case "setLaunchFee":
      return encodeCall(SEL.setLaunchFee, encodeUint(needAmount(args, "launchFee", 18)));
    case "setLaunchEnabled":
      return encodeCall(SEL.setLaunchEnabled, encodeBool(needBool(args, "enabled")));
    case "setMaxCreatorTaxBps":
      return encodeCall(SEL.setMaxCreatorTaxBps, encodeUint(needUint(args, "maxCreatorTaxBps")));
    case "setSnipeTaxStartBps":
      return encodeCall(SEL.setSnipeTaxStartBps, encodeUint(needUint(args, "snipeTaxStartBps")));
    case "setSnipeTaxSeconds":
      return encodeCall(SEL.setSnipeTaxSeconds, encodeUint(needUint(args, "snipeTaxSeconds")));
    case "setPairTokenApproved":
      return encodeCall(SEL.setPairTokenApproved, encodeAddress(needAddr(args, "pairToken")), encodeBool(needBool(args, "approved")));
    case "setCreatorFeeRecipient":
      // Owner override: creates the timelocked pending change (effectiveAt =
      // now + 72 h, expiresAt = effectiveAt + 72 h) executed later via
      // executeCreatorFeeRecipientChange. Distinct from the creator's
      // immediate transferCreatorFeeRecipient (pons_set_creator_fee_recipient).
      return encodeCall(
        SEL.ownerSetCreatorFeeRecipient,
        encodeAddress(needAddr(args, "token")),
        encodeAddress(needAddr(args, "newRecipient")),
      );
    case "setPairTokenEconomics": {
      // phantomQuote/graduationThreshold are denominated in this pair token's
      // own units — scale by its decimals (6 for USDG-style tokens).
      const decimals = needDecimals(args);
      return encodeCall(
        SEL.setPairTokenEconomics,
        encodeAddress(needAddr(args, "pairToken")),
        encodeUint(needAmount(args, "phantomQuote", decimals)),
        encodeUint(needAmount(args, "graduationThreshold", decimals)),
        encodeUint(decimals),
      );
    }
    case "addLaunchConfig":
      return encodeCall(SEL.addLaunchConfig, encodeLaunchConfigTuple(args));
    case "updateLaunchConfig":
      return encodeCall(SEL.updateLaunchConfig, encodeUint(needUint(args, "launchConfigId")), encodeLaunchConfigTuple(args));
    case "setWhitelistedLauncher":
      return encodeCall(SEL.setWhitelistedLauncher, encodeAddress(needAddr(args, "account")), encodeBool(needBool(args, "allowed")));
    case "setGraduationExecutor":
      return encodeCall(SEL.setGraduationExecutor, encodeAddress(needAddr(args, "address")));
    case "setLaunchDeployer":
      return encodeCall(SEL.setLaunchDeployer, encodeAddress(needAddr(args, "address")));
    case "setLaunchForwarder":
      return encodeCall(SEL.setLaunchForwarder, encodeAddress(needAddr(args, "address")));
    case "transferOwnership":
      return encodeCall(SEL.transferOwnership, encodeAddress(needAddr(args, "newOwner")));
    case "acceptOwnership":
      return encodeCall(SEL.acceptOwnership);
    case "renounceOwnership":
      return encodeCall(SEL.renounceOwnership);
  }
}

export async function adminCallTool(
  client: RpcClient,
  signer: Signer,
  fn: AdminFn,
  args: Args,
  iUnderstandIrreversible?: boolean,
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  if (!ADMIN_FNS.includes(fn)) {
    throw new PonsError("INVALID_PARAMS", `unknown admin fn "${fn}"; one of: ${ADMIN_FNS.join(", ")}`);
  }
  if (fn === "renounceOwnership" && iUnderstandIrreversible !== true) {
    throw new PonsError(
      "INVALID_PARAMS",
      "renounceOwnership permanently abandons factory ownership; pass iUnderstandIrreversible: true to proceed",
    );
  }
  const data = buildAdminCall(fn, args);
  const owner = await callAddress(client, FACTORY, SEL.owner);
  const step: WriteStep = { label: `factory.${fn}`, to: FACTORY, data, value: 0n };
  return runWrite(
    client,
    signer,
    {
      summary: `factory owner call ${fn} (owner is ${owner}; signer is ${signer.address}${owner.toLowerCase() === signer.address.toLowerCase() ? " — match" : " — MISMATCH, will revert"})`,
      steps: [step],
      details: { fn, args, factoryOwner: owner, signerIsOwner: owner.toLowerCase() === signer.address.toLowerCase() },
    },
    opts,
  );
}

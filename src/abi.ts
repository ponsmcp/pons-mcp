import { keccak_256 } from "@noble/hashes/sha3";

const te = new TextEncoder();

export function keccakHex(data: Uint8Array): string {
  return Buffer.from(keccak_256(data)).toString("hex");
}

export function selector(sig: string): string {
  return keccakHex(te.encode(sig)).slice(0, 8);
}

export function eventTopic(sig: string): string {
  return keccakHex(te.encode(sig));
}

// Every selector/topic is recomputed from the canonical signature at module
// load and asserted against the hardcoded constant. A mismatch is
// fatal — better to crash than to serve stale calldata.
function checked<const T extends Record<string, [string, string]>>(
  table: T,
  kind: "selector" | "topic",
): { [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const [name, [sig, expected]] of Object.entries(table)) {
    const actual = kind === "selector" ? selector(sig) : eventTopic(sig);
    if (actual !== expected) {
      throw new Error(
        `ABI ${kind} mismatch for ${name} (${sig}): computed 0x${actual}, expected 0x${expected}`,
      );
    }
    out[name] = actual;
  }
  return out as { [K in keyof T]: string };
}

export const SEL = checked({
  // factory
  launchFee: ["launchFee()", "cf3cf573"],
  launchEnabled: ["launchEnabled()", "236a4afb"],
  maxCreatorTaxBps: ["maxCreatorTaxBps()", "f325a5fb"],
  snipeTaxStartBps: ["snipeTaxStartBps()", "50e25ac2"],
  snipeTaxSeconds: ["snipeTaxSeconds()", "6783774b"],
  canLaunch: ["canLaunch(address)", "58373f04"],
  whitelistedLaunchers: ["whitelistedLaunchers(address)", "da3eda65"],
  launchConfigCount: ["launchConfigCount()", "ae72d871"],
  getLaunchConfig: ["getLaunchConfig(uint256)", "1cad862d"],
  getLaunchedToken: ["getLaunchedToken(address)", "3cf28b5a"],
  pairTokenEconomics: ["pairTokenEconomics(address)", "31082134"],
  approvedPairTokens: ["approvedPairTokens(address)", "9831705e"],
  // curve
  token: ["token()", "fc0c546a"],
  graduated: ["graduated()", "e7c2b772"],
  readyToGraduate: ["readyToGraduate()", "c68360a5"],
  realQuoteReserve: ["realQuoteReserve()", "4f1f58fd"],
  quoteReserve: ["quoteReserve()", "9da771f4"],
  phantomQuote: ["phantomQuote()", "c57eadfc"],
  graduationThreshold: ["graduationThreshold()", "8b0bc501"],
  getReserves: ["getReserves()", "0902f1ac"],
  tokenReserve: ["tokenReserve()", "cbcb3171"],
  launchSupply: ["launchSupply()", "3f7ed6b7"],
  reservedTokens: ["reservedTokens()", "15a55347"],
  pairToken: ["pairToken()", "3de35b79"],
  isNativeQuote: ["isNativeQuote()", "dc08e094"],
  launchedAt: ["launchedAt()", "bf56b371"],
  currentSnipeTaxBps: ["currentSnipeTaxBps(address)", "d7e1ef39"],
  snipeTaxExempt: ["snipeTaxExempt(address)", "d44bdfe7"],
  feeBps: ["feeBps()", "24a9d853"],
  creatorTaxBps: ["creatorTaxBps()", "c1bb8901"],
  buybackEnabled: ["buybackEnabled()", "160d0da5"],
  deployer: ["deployer()", "d5f39488"],
  // erc20
  name: ["name()", "06fdde03"],
  symbol: ["symbol()", "95d89b41"],
  decimals: ["decimals()", "313ce567"],
  totalSupply: ["totalSupply()", "18160ddd"],
  balanceOf: ["balanceOf(address)", "70a08231"],
  // write path (pons_launch_token)
  launchToken: [
    "launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])",
    "a72101af",
  ],
  launchAndBuy: [
    "launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])",
    "f85f8e41",
  ],
  previewLaunchEconomics: ["previewLaunchEconomics(uint256,address)", "f718b78c"],
  launchForwarder: ["launchForwarder()", "9b924452"],
  // factory satellites & timelock constants
  owner: ["owner()", "8da5cb5b"],
  pendingOwner: ["pendingOwner()", "e30c3978"],
  locker: ["locker()", "d7b96d4e"],
  memeHook: ["memeHook()", "6651812c"],
  feeEscrow: ["feeEscrow()", "c4b7de97"],
  buybackVault: ["buybackVault()", "f1f5c993"],
  poolManager: ["poolManager()", "dc4c90d3"],
  positionManager: ["positionManager()", "791b98bc"],
  permit2: ["permit2()", "12261ee7"],
  launchDeployer: ["launchDeployer()", "858f5964"],
  graduationExecutor: ["graduationExecutor()", "cc6d7a39"],
  graduationGuard: ["graduationGuard()", "496aa100"],
  feeRecipientTimelock: ["CREATOR_FEE_RECIPIENT_TIMELOCK()", "5a83b00a"],
  feeRecipientWindow: ["CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW()", "02d4753d"],
  graduationRescueDelay: ["GRADUATION_RESCUE_DELAY()", "2d1250b8"],
  // factory: fee-recipient timelock flow + graduation + rescue
  pendingCreatorFeeRecipient: ["pendingCreatorFeeRecipient(address)", "9beacf4a"],
  graduate: ["graduate(address)", "ff6d8d05"],
  createGraduatedPool: ["createGraduatedPool(address)", "2f53ef2f"],
  transferCreatorFeeRecipient: ["transferCreatorFeeRecipient(address,address)", "2931861b"],
  ownerSetCreatorFeeRecipient: ["setCreatorFeeRecipient(address,address)", "e102c9aa"],
  executeCreatorFeeRecipientChange: ["executeCreatorFeeRecipientChange(address)", "3d3d2d58"],
  cancelCreatorFeeRecipientChange: ["cancelCreatorFeeRecipientChange(address)", "6e47a188"],
  rescueCurveFees: ["rescueCurveFees(address)", "189eb0f5"],
  factorySetBuybackEnabled: ["setBuybackEnabled(address,bool)", "b18f1db1"],
  // factory owner functions (pons_admin_call)
  setLaunchFee: ["setLaunchFee(uint256)", "5313be2c"],
  setLaunchEnabled: ["setLaunchEnabled(bool)", "f56f05b2"],
  setMaxCreatorTaxBps: ["setMaxCreatorTaxBps(uint256)", "2260aead"],
  setSnipeTaxStartBps: ["setSnipeTaxStartBps(uint256)", "b20e51af"],
  setSnipeTaxSeconds: ["setSnipeTaxSeconds(uint256)", "d1ec471a"],
  setPairTokenApproved: ["setPairTokenApproved(address,bool)", "8763e3dc"],
  setPairTokenEconomics: ["setPairTokenEconomics(address,uint256,uint256,uint8)", "092c08bd"],
  addLaunchConfig: ["addLaunchConfig((uint256,uint256,uint256,uint256,uint24,int24,bool))", "0e5b0aae"],
  updateLaunchConfig: ["updateLaunchConfig(uint256,(uint256,uint256,uint256,uint256,uint24,int24,bool))", "e73e334a"],
  setWhitelistedLauncher: ["setWhitelistedLauncher(address,bool)", "366f0f3e"],
  setGraduationExecutor: ["setGraduationExecutor(address)", "fbec2d8b"],
  setLaunchDeployer: ["setLaunchDeployer(address)", "3a9391e8"],
  setLaunchForwarder: ["setLaunchForwarder(address)", "767b7c16"],
  transferOwnership: ["transferOwnership(address)", "f2fde38b"],
  acceptOwnership: ["acceptOwnership()", "79ba5097"],
  renounceOwnership: ["renounceOwnership()", "715018a6"],
  // curve reads (full dump)
  sellableTokens: ["sellableTokens()", "808bcddc"],
  trackedQuote: ["trackedQuote()", "ca52b0b7"],
  trackedTokens: ["trackedTokens()", "4c37ef23"],
  quoteFeeBalance: ["quoteFeeBalance()", "ed479c47"],
  creatorTaxBalance: ["creatorTaxBalance()", "db2bd533"],
  buybackQuoteBalance: ["buybackQuoteBalance()", "7809452a"],
  protocolFeeRecipient: ["protocolFeeRecipient()", "64df049e"],
  protocolFeeShareBps: ["protocolFeeShareBps()", "9040f866"],
  buybackBurnBps: ["buybackBurnBps()", "49127e2a"],
  maxInternalPriceImpactBps: ["maxInternalPriceImpactBps()", "90addc1e"],
  // curve writes
  buy: ["buy(uint256,uint256,address)", "59a87bc1"],
  sell: ["sell(uint256,uint256,address)", "d04c6983"],
  exemptFromSnipeTax: ["exemptFromSnipeTax(address)", "31ff7f22"],
  curveSetBuybackEnabled: ["setBuybackEnabled(bool)", "9a9b567d"],
  sweepFees: ["sweepFees(uint256)", "3729bb9a"],
  rescueFees: ["rescueFees()", "52920587"],
  // erc20 extras
  allowance: ["allowance(address,address)", "dd62ed3e"],
  approve: ["approve(address,uint256)", "095ea7b3"],
  // uniswap v4 path (pons_quote_swap / pons_swap)
  v4QuoteExactInputSingle: ["quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))", "aa9d21cb"],
  v4GetSlot0: ["getSlot0(bytes32)", "c815641c"],
  v4GetLiquidity: ["getLiquidity(bytes32)", "fa6793d5"],
  routerExecute: ["execute(bytes,bytes[],uint256)", "3593564c"],
  permit2Allowance: ["allowance(address,address,address)", "927da105"],
  // fee escrow (PonsV2FeeEscrow — claimable fee balances)
  escrowClaimAll: ["claim()", "4e71d92d"],
  escrowClaim: ["claim(uint256)", "379607f5"],
  escrowClaimTokenAll: ["claimToken(address)", "32f289cf"],
  escrowClaimToken: ["claimToken(address,uint256)", "1698755f"],
  balanceOfToken: ["balanceOfToken(address,address)", "f59e38b7"],
  // buyback vault (PonsV2BuybackVault — 5y linear vesting)
  vaultRelease: ["release(address)", "19165587"],
  vaultTotalLocked: ["totalLocked(address)", "d8fb9337"],
  vaultTotalReleased: ["totalReleased(address)", "d79779b2"],
  vaultVestedAmount: ["vestedAmount(address)", "384711cc"],
  vaultReleasable: ["releasable(address)", "a3f8eace"],
  vaultVestingTerms: ["vestingTerms(address)", "b224cf64"],
  // V1 legacy factory (Uniswap V3 generation; read-only, closed to launches)
  v1GraduationStatus: ["graduationStatus(address)", "98d652f1"],
  v1GetTokenInfo: ["getTokenInfo()", "abb1dc44"],
} as const, "selector");

export const TOPIC = checked({
  V1TokenLaunched: [
    "TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)",
    "db51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",
  ],
  TokenLaunched: [
    "TokenLaunched(address,address,address,address,uint256,uint256)",
    "8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
  ],
  PoolGraduated: [
    "PoolGraduated(address,uint256,uint256,uint256)",
    "0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259",
  ],
  CurveBuy: [
    "CurveBuy(address,address,uint256,uint256,uint256,uint256)",
    "ec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  ],
  CurveSell: [
    "CurveSell(address,address,uint256,uint256,uint256,uint256)",
    "8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
  ],
} as const, "topic");

// ---------- encoding ----------

export function encodeUint(v: bigint | number): string {
  return BigInt(v).toString(16).padStart(64, "0");
}

export function encodeAddress(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function encodeCall(selHex: string, ...args: string[]): string {
  return "0x" + selHex + args.join("");
}

export function encodeBool(v: boolean): string {
  return v ? "1".padStart(64, "0") : "0".repeat(64);
}

export function encodeBytes32(hex: string): string {
  const h = hex.replace(/^0x/, "");
  if (h.length !== 64) throw new Error(`bytes32 must be 32 bytes, got ${h.length / 2}`);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("bytes32 must be hex");
  return h;
}

// ABI string: length word + utf8 data right-padded to a 32-byte multiple.
export function encodeString(s: string): string {
  const data = Buffer.from(s, "utf8").toString("hex");
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64 || 0, "0");
  return encodeUint(Buffer.byteLength(s, "utf8")) + padded;
}

// ABI bytes: length word + raw data right-padded to a 32-byte multiple.
export function encodeBytes(hex: string): string {
  const data = hex.replace(/^0x/, "");
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64 || 0, "0");
  return encodeUint(data.length / 2) + padded;
}

// ---------- decoding ----------

export function words(hex: string): string[] {
  const h = hex.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}

export function decodeUint(word: string): bigint {
  return BigInt("0x" + word);
}

export function decodeInt24(word: string): bigint {
  const v = decodeUint(word);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

export function decodeBool(word: string): boolean {
  return decodeUint(word) !== 0n;
}

export function decodeAddress(word: string): string {
  return "0x" + word.slice(24).toLowerCase();
}

export function decodeAbiString(hex: string): string {
  const w = words(hex);
  if (w.length < 2) return "";
  const len = Number(decodeUint(w[1]));
  const data = hex.replace(/^0x/, "").slice(128, 128 + len * 2);
  return Buffer.from(data, "hex").toString("utf8");
}

export function topicAddress(topic: string): string {
  return "0x" + topic.replace(/^0x/, "").slice(24).toLowerCase();
}

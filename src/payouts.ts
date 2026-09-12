import { SEL, encodeAddress, encodeCall, encodeUint, words, decodeUint, decodeAddress } from "./abi.js";
import { CHAIN_ID, FEE_ESCROW, BUYBACK_VAULT, PonsError, callUint, getLaunchedToken, erc20Meta } from "./pons.js";
import { formatUnits, formatEth, parseUnits } from "./format.js";
import { runWrite } from "./trade.js";
import type { RpcClient } from "./rpc.js";
import type { Signer } from "./signer.js";

// PonsV2FeeEscrow + PonsV2BuybackVault — verified against Sourcify sources
// (chain 4663, matchId 43642574 / 43855070).
//
// Escrow: every recipient's claimable fees aggregate in one ledger, native
// ETH and per-token. claim()/claim(amount) pay native; claimToken(token[,
// amount]) pay ERC-20. Partial claims exist because a quote asset with a
// per-transfer limit could otherwise brick a full-balance claim.
//
// Vault: bought-back tokens vest linearly over 5 years; release(token) pays
// the vested slice to the escrow, split creator/protocol by the launch's
// frozen terms. Callable only by the vest's creator or protocol recipient.

async function tokenMeta(client: RpcClient, token: string): Promise<{ decimals: number; symbol?: string }> {
  try {
    const m = await erc20Meta(client, token);
    return { decimals: m.decimals ?? 18, symbol: m.symbol };
  } catch {
    return { decimals: 18 };
  }
}

// ---------- read: pons_fee_balances ----------

export async function feeBalances(client: RpcClient, address: string, tokenAddress?: string) {
  await client.assertChain(CHAIN_ID);
  const addr = address.toLowerCase();
  const claimableEth = await callUint(client, FEE_ESCROW, SEL.balanceOf, encodeAddress(addr));

  const out: Record<string, unknown> = {
    address: addr,
    feeEscrow: FEE_ESCROW,
    claimableEth: claimableEth.toString(),
    claimableEthFormatted: formatEth(claimableEth),
  };

  if (tokenAddress !== undefined) {
    const token = tokenAddress.toLowerCase();
    const [meta, claimableToken, totalLocked, totalReleased, vestedAmount, releasable, termsRet] =
      await Promise.all([
        tokenMeta(client, token),
        callUint(client, FEE_ESCROW, SEL.balanceOfToken, encodeAddress(addr), encodeAddress(token)),
        callUint(client, BUYBACK_VAULT, SEL.vaultTotalLocked, encodeAddress(token)),
        callUint(client, BUYBACK_VAULT, SEL.vaultTotalReleased, encodeAddress(token)),
        callUint(client, BUYBACK_VAULT, SEL.vaultVestedAmount, encodeAddress(token)),
        callUint(client, BUYBACK_VAULT, SEL.vaultReleasable, encodeAddress(token)),
        client.ethCall(BUYBACK_VAULT, encodeCall(SEL.vaultVestingTerms, encodeAddress(token))),
      ]);
    const tw = words(termsRet);
    const fmt = (v: bigint) => `${formatUnits(v, meta.decimals)} ${meta.symbol ?? "tokens"}`;
    const lt = await getLaunchedToken(client, token).catch(() => null);
    out.token = {
      address: token,
      symbol: meta.symbol,
      claimableTokens: claimableToken.toString(),
      claimableTokensFormatted: fmt(claimableToken),
    };
    out.buybackVault = {
      address: BUYBACK_VAULT,
      // null = the factory lookup itself failed (RPC error); distinct from a
      // confirmed "not registered".
      registered: lt === null ? null : lt.exists,
      totalLocked: totalLocked.toString(),
      totalLockedFormatted: fmt(totalLocked),
      totalReleased: totalReleased.toString(),
      vestedAmount: vestedAmount.toString(),
      releasable: releasable.toString(),
      releasableFormatted: fmt(releasable),
      vestingDurationSeconds: 5 * 365 * 24 * 60 * 60,
      vestingTerms:
        tw.length >= 3
          ? {
              creatorRecipient: decodeAddress(tw[0]),
              protocolRecipient: decodeAddress(tw[1]),
              protocolFeeShareBps: Number(decodeUint(tw[2])),
              queriedAddressIsBeneficiary: [decodeAddress(tw[0]), decodeAddress(tw[1])].includes(addr),
            }
          : null,
    };
  }
  return out;
}

// ---------- write: pons_claim_fees ----------

export async function claimFeesTool(
  client: RpcClient,
  signer: Signer,
  tokenAddress: string | undefined,
  amount: string | undefined,
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  const addr = signer.address.toLowerCase();
  let data: string;
  let label: string;
  let balance: bigint;
  let amountWei: bigint | null = null;

  if (tokenAddress === undefined) {
    balance = await callUint(client, FEE_ESCROW, SEL.balanceOf, encodeAddress(addr));
    if (balance === 0n) throw new PonsError("INVALID_PARAMS", `no claimable ETH for ${addr} (would revert NoBalance)`);
    if (amount !== undefined) {
      amountWei = parseUnits(amount, 18);
      if (amountWei === 0n) throw new PonsError("INVALID_PARAMS", "amount must be positive (claim(0) reverts NoBalance on-chain)");
      if (amountWei > balance) {
        throw new PonsError("INVALID_PARAMS", `amount ${formatEth(amountWei)} exceeds claimable ${formatEth(balance)}`);
      }
      data = encodeCall(SEL.escrowClaim, encodeUint(amountWei));
      label = `claim ${formatEth(amountWei)} from fee escrow`;
    } else {
      data = encodeCall(SEL.escrowClaimAll);
      label = `claim entire ETH balance (${formatEth(balance)}) from fee escrow`;
    }
  } else {
    const token = tokenAddress.toLowerCase();
    const meta = await tokenMeta(client, token);
    balance = await callUint(client, FEE_ESCROW, SEL.balanceOfToken, encodeAddress(addr), encodeAddress(token));
    if (balance === 0n) throw new PonsError("INVALID_PARAMS", `no claimable balance of ${token} for ${addr} (would revert NoBalance)`);
    if (amount !== undefined) {
      amountWei = parseUnits(amount, meta.decimals);
      if (amountWei === 0n) throw new PonsError("INVALID_PARAMS", "amount must be positive (claimToken with 0 reverts NoBalance on-chain)");
      if (amountWei > balance) {
        throw new PonsError(
          "INVALID_PARAMS",
          `amount ${formatUnits(amountWei, meta.decimals)} exceeds claimable ${formatUnits(balance, meta.decimals)}`,
        );
      }
      data = encodeCall(SEL.escrowClaimToken, encodeAddress(token), encodeUint(amountWei));
      label = `claim ${formatUnits(amountWei, meta.decimals)} ${meta.symbol ?? "tokens"} from fee escrow`;
    } else {
      data = encodeCall(SEL.escrowClaimTokenAll, encodeAddress(token));
      label = `claim entire ${meta.symbol ?? "token"} balance (${formatUnits(balance, meta.decimals)}) from fee escrow`;
    }
  }

  return runWrite(client, signer, {
    summary: label,
    steps: [{ label, to: FEE_ESCROW, data, value: 0n }],
    details: {
      feeEscrow: FEE_ESCROW,
      token: tokenAddress?.toLowerCase(),
      claimableBalance: balance.toString(),
      amount: amountWei?.toString() ?? "all",
    },
  }, opts);
}

// ---------- write: pons_release_buyback ----------

export async function releaseBuybackTool(
  client: RpcClient,
  signer: Signer,
  tokenAddress: string,
  opts: { dryRun?: boolean; confirm?: boolean } = {},
) {
  const token = tokenAddress.toLowerCase();
  const lt = await getLaunchedToken(client, token);
  if (!lt.exists) throw new PonsError("NOT_A_LAUNCH", `${token} is not a Pons-launched token`);
  const [meta, releasable, termsRet, totalLocked, totalReleased] = await Promise.all([
    tokenMeta(client, token),
    callUint(client, BUYBACK_VAULT, SEL.vaultReleasable, encodeAddress(token)),
    client.ethCall(BUYBACK_VAULT, encodeCall(SEL.vaultVestingTerms, encodeAddress(token))),
    callUint(client, BUYBACK_VAULT, SEL.vaultTotalLocked, encodeAddress(token)),
    callUint(client, BUYBACK_VAULT, SEL.vaultTotalReleased, encodeAddress(token)),
  ]);
  const tw = words(termsRet);
  if (tw.length < 3) throw new PonsError("INVALID_PARAMS", "could not read vesting terms");
  const creatorRecipient = decodeAddress(tw[0]);
  const protocolRecipient = decodeAddress(tw[1]);
  const caller = signer.address.toLowerCase();
  const beneficiary = caller === creatorRecipient || caller === protocolRecipient;
  if (!beneficiary) {
    throw new PonsError(
      "INVALID_PARAMS",
      `signer ${caller} is neither the vest's creator recipient (${creatorRecipient}) nor the protocol recipient (${protocolRecipient}); on-chain this reverts NotVestBeneficiary`,
    );
  }
  if (releasable === 0n) {
    throw new PonsError("INVALID_PARAMS", "nothing vested to release yet — the buyback vest is empty or still vesting (5-year linear)");
  }
  const fmt = (v: bigint) => `${formatUnits(v, meta.decimals)} ${meta.symbol ?? "tokens"}`;

  return runWrite(client, signer, {
    summary: `release ${fmt(releasable)} of vested buyback tokens for ${token} into the fee escrow`,
    steps: [{ label: "vault.release", to: BUYBACK_VAULT, data: encodeCall(SEL.vaultRelease, encodeAddress(token)), value: 0n }],
    details: {
      token,
      buybackVault: BUYBACK_VAULT,
      releasable: releasable.toString(),
      releasableFormatted: fmt(releasable),
      totalLocked: totalLocked.toString(),
      totalReleased: totalReleased.toString(),
      vestingTerms: {
        creatorRecipient,
        protocolRecipient,
        protocolFeeShareBps: Number(decodeUint(tw[2])),
      },
      signerIsBeneficiary: beneficiary,
      note: "release pays into the fee escrow split creator/protocol by the launch's frozen terms — claim your share afterwards with pons_claim_fees",
    },
  }, opts);
}

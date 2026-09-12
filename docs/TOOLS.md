# pons-mcp tool reference

All 35 tools (20 read + 15 write). Every tool returns JSON as a text content block. Errors are structured:

```json
{ "error": { "code": "…", "message": "…" } }
```

**Error codes:** `INVALID_ADDRESS` (malformed 0x address param), `NOT_A_LAUNCH` (address not
registered in the v2 factory), `INVALID_PARAMS` (failed a precheck the contract would revert on),
`CAP_EXCEEDED` (env cap hit), `REVERTED` (deterministic on-chain revert), `RPC_FAILURE`
(network/429/5xx after retries), `CHAIN_MISMATCH` (RPC not on chainId 4663).
`WRITE_DISABLED` is reserved but currently unused: with no key, write tools are not registered.

Every tool except `pons_exempt_snipe_tax` (which always errors without touching the network)
begins with a chainId assertion, so `CHAIN_MISMATCH` is possible on any call.

**Write-tool semantics** (all 13 write tools): `dryRun` defaults to `true`; `confirm` defaults to
`false`. Unless `dryRun=false` **and** `confirm=true`, the tool simulates every transaction step
with `eth_call`, estimates gas, and returns the exact calldata — nothing is broadcast or signed.
Multi-step tools simulate with state-diff overrides so even unfunded signers get a real
simulation; `pons_launch_token` is the exception (it simulates without overrides, so an unfunded
signer sees the node's "insufficient funds" in `simulation.error`). On broadcast, steps are
signed and sent sequentially, each waiting for the prior receipt.

Example values below are real, read from Robinhood Chain mainnet on 2026-09-07: the PIVOT launch
(curve `0x892c704cb1365ca67da2f7c2bf420e19563eafef`, token
`0xa492b226dc30bbe4f12638ea2f57cf70f259c0b6`) and the graduated Bounty launch (token
`0xf25cbd487fe0294dd0a39ba2955982bcff28fd72`, curve
`0xea069fb8e88e3e08b427f8a4d496f7b94a8215b2`).

---

## Protocol & discovery

### `pons_protocol_overview`

Protocol-wide parameters, governance constants, and every contract address, all read live.

**Params:** none.

**Output keys:** `chainId`, `network`, `latestBlock`; `factory` (launchFeeWei/launchFee,
launchEnabled, maxCreatorTaxBps/maxCreatorTax, snipeTaxStartBps/snipeTaxStart, snipeTaxSeconds,
launchConfigCount, `launchConfigs[]` fully decoded, launchConfigsTruncated if capped);
`governance` (owner, pendingOwner,
creatorFeeRecipientTimelockSeconds, creatorFeeRecipientExecutionWindowSeconds,
graduationRescueDelaySeconds); `contracts` (factory, launchAndBuyRouter, launchForwarderLive,
launchDeployer, poolManagerLive, uniswapV4PoolManager, positionManager, permit2, locker,
memeHook, feeEscrow, buybackVault, graduationExecutor, graduationGuard, ponsToken); `explorer`.

**Errors:** `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Example output (abridged, real values):**

```json
{
  "chainId": 4663,
  "latestBlock": 56884468,
  "factory": {
    "launchFee": "0.0005 ETH",
    "launchEnabled": true,
    "maxCreatorTaxBps": 1000,
    "snipeTaxStartBps": 9900,
    "snipeTaxSeconds": 3,
    "launchConfigCount": 1,
    "launchConfigs": [
      { "index": 0, "supply": "1000000000000000000000000000", "curveFeeBps": 100,
        "phantomQuote": "1680000000000000000", "graduationThreshold": "4200000000000000000",
        "poolFee": 0, "tickSpacing": 200, "enabled": true }
    ]
  },
  "governance": {
    "owner": "0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd",
    "pendingOwner": "0x0000000000000000000000000000000000000000",
    "creatorFeeRecipientTimelockSeconds": 259200,
    "creatorFeeRecipientExecutionWindowSeconds": 259200,
    "graduationRescueDelaySeconds": 604800
  }
}
```

### `pons_can_launch`

Whether an address may launch right now.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `address` | string | yes | — | 0x address |

**Output keys:** `address`, `canLaunch`, `whitelistedLauncher`, `launchEnabled`.

**Errors:** `INVALID_ADDRESS`, `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Example:** `{"address": "0xbb6337fa33d4408320f7c87d4610b6bd61430709"}` →
`{"canLaunch": true, "whitelistedLauncher": false, "launchEnabled": true}`.

### `pons_pair_token_economics`

Pair-token economics from the factory.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `pairTokenAddress` | string | yes | — | 0x address |

**Output keys:** `pairToken`, `symbol`, `approved`, `phantomQuote` (+formatted),
`graduationThreshold` (+formatted), `economicsDecimals`.

**Errors:** `INVALID_ADDRESS`, `RPC_FAILURE`, `CHAIN_MISMATCH`. Non-approved tokens return zeros
(`approved: false`), not an error.

### `pons_recent_launches`

Scan factory `TokenLaunched` events, newest first.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `lookbackBlocks` | number | no | 50000 | 1–500000 (500k ≈ 14 h at ~10 blocks/s) |
| `limit` | number | no | 20 | 1–100 |
| `deployer` | string | no | — | 0x address; pushed into topics[3] server-side |
| `pairToken` | string | no | — | 0x address; applied client-side on decoded data |

**Output keys:** `scannedFromBlock` (oldest block actually scanned — see `scanComplete`),
`scannedToBlock`, `scanComplete` (false when the scan stopped early at `limit`; older matches may
exist below `scannedFromBlock` — widen `lookbackBlocks` to continue), `requestedFromBlock`,
`count`, `launches[]` (token, curve,
deployer, pairToken, launchConfigId, graduationThreshold, blockNumber, transactionHash,
logIndex).

**Errors:** `INVALID_ADDRESS`, `RPC_FAILURE`, `CHAIN_MISMATCH`.

### `pons_scan_interesting`

Score recent v2 launches for traction using **on-chain data only**. No LLM, no spend.

**Params:** `lookbackBlocks`, `limit` (same defaults/constraints as `pons_recent_launches`).
Gates come from optional env: `PONS_SCAN_MIN_UNIQUE_BUYERS` (3), `PONS_SCAN_MIN_QUOTE_ETH` (0.05), `PONS_SCAN_MIN_AGE_SEC` (30), `PONS_SCAN_MAX_AGE_SEC` (1200), `PONS_SCAN_MAX_DEPLOYER_LAUNCHES` (5), `PONS_SCAN_LOOKBACK_BLOCKS` (10000), `PONS_SCAN_LIMIT` (20), `PONS_SCAN_TRADE_LIMIT` (100). Malformed values fail closed.

**Output keys:** `count`, `launches[]` sorted by score descending: token, curve, deployer, name,
symbol, score (0–100), pass, reasons, ageSec, uniqueBuyersExDeployer, buyCount, sellCount,
realQuote, graduationProgress, launchedAt, deployerLaunchCount.

**Errors:** `INVALID_PARAMS` (malformed `PONS_SCAN_*` env), `RPC_FAILURE`, `CHAIN_MISMATCH`.

### `pons_recent_graduations`

Scan factory `PoolGraduated` events, newest first.

**Params:** `lookbackBlocks`, `limit` (same defaults/constraints as `pons_recent_launches`).

**Output keys:** `scannedFromBlock`, `scannedToBlock`, `scanComplete`, `count`, `graduations[]` (token,
positionId, tokenAmount, pairTokenAmount, blockNumber, transactionHash).

**Example entry (real):**

```json
{ "token": "0xf25cbd487fe0294dd0a39ba2955982bcff28fd72", "positionId": "2103714",
  "tokenAmount": "204081632653061227197001248", "pairTokenAmount": "4200000000000000195",
  "blockNumber": 56882711,
  "transactionHash": "0x1d49a28a0e27ecdd952094c4aaa9de2105253a2d62924ec36e761c13e43493c9" }
```

### `pons_creator_launches`

All launches by one creator, newest first, with per-token graduated status.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `creatorAddress` | string | yes | — | 0x address |
| `lookbackBlocks` | number | no | 50000 | 1–500000 |
| `limit` | number | no | 20 | 1–100 |

**Output keys:** as `pons_recent_launches`, plus `creator` and `graduated` (bool, read from the
curve) on each entry.

### `pons_curve_trades`

`CurveBuy` + `CurveSell` events on one curve, decoded and merged newest-first.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address |
| `lookbackBlocks` | number | no | 50000 | 1–500000 |
| `limit` | number | no | 20 | 1–100 |

**Output keys:** `curve`, `scannedFromBlock`, `scannedToBlock`, `scanComplete`, `count`, `trades[]` (side
buy/sell, trader, recipient, spent+tokensOut or tokensIn+quoteOut, fee, tax, blockNumber,
logIndex, transactionHash). Note (verified against the curve source): a buy's `spent` is the
post-clamp amount actually spent (any refund arrives as a separate `CurveBuyRefunded` event), and
a buy's `fee` leg includes the snipe tax (`feeIncludesSnipeTax: true`).

**Example entry (real):**

```json
{ "side": "buy", "trader": "0x4a86009a36fcec5aa341ffceb3205a911fcf6f60",
  "recipient": "0x4a86009a36fcec5aa341ffceb3205a911fcf6f60",
  "spent": "429080402631062565", "tokensOut": "22248171530317716015619836",
  "fee": "4290804026310625", "feeIncludesSnipeTax": true, "tax": "0", "blockNumber": 56689029, "logIndex": 22,
  "transactionHash": "0xf5abd1484ce639ee7d38fb157f125235d6b230075670e5cec7812772071d9c98" }
```

### `pons_snipe_tax`

Live decaying snipe tax for a recipient on a curve.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address |
| `recipient` | string | no | `0x…dEaD` (a non-exempt sentinel — the deployer is auto-exempt at launch, so probing it would always read 0%) | 0x address |

**Output keys:** `curve`, `recipient`, `currentSnipeTaxBps` (+`currentSnipeTax` formatted),
`snipeTaxExempt`, `launchedAt` (+ISO), `secondsSinceLaunch`, `snipeTaxWindowSeconds`,
`windowActive`.

**Example output (real):**

```json
{ "curve": "0x1be7ecbfa95ce8ec73d04e0641123dff065c8200",
  "recipient": "0x4c5bb3fbc85c4ab5d6c2dedc311f2ad3a3b36455",
  "currentSnipeTaxBps": 0, "currentSnipeTax": "0%", "snipeTaxExempt": true,
  "launchedAt": 1788768021, "secondsSinceLaunch": 1571, "snipeTaxWindowSeconds": 3,
  "windowActive": false }
```

### `pons_token_supply`

ERC-20 totalSupply and burn balances.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | no | PONS token `0x39dBED3a2bd333467115dE45665cC57F813C4571` | 0x address |

**Output keys:** `token`, `name`, `symbol`, `decimals`, `totalSupply` (+formatted), `balances`
(0x…dEaD and 0x0…0), `burnedTotal` (+formatted), `burnedPctOfSupply`.

**Example output (real, PONS token):** totalSupply 1,000,000,000; burned 298,671,435.53
(29.86%).

### `pons_launch_costs`

Measured launch/buy/sell gas costs (static, measured 2026-09, clearly labelled) plus live
`eth_gasPrice`.

**Params:** none.

**Output keys:** `note`, `measured` (launchAndBuyGas 3,850,000; launchAndBuyCostWei /
launchAndBuyCost 0.001456 ETH; buyGas 97,800; sellGas 115,000; minRoundTripWei / minRoundTrip
0.0021 ETH; observedGasPriceWei / observedGasPrice 0.373358 gwei), `live` (gasPriceWei/gasPrice),
`contracts`.

### `pons_preview_launch`

Preview a launch config before launching.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `launchConfigId` | number | no | 0 | int ≥ 0 |
| `pairToken` | string | no | zero address (ETH-paired) | 0x address |

**Output keys:** `launchConfigId`, `pairToken`, `ethPaired`, `pairTokenApproved`, `config`
(supply, curveFeeBps, phantomQuote, graduationThreshold, poolFee, tickSpacing, enabled — raw +
formatted), `expectedEconomics` (the bytes32 guard), `note`.

**Example output (real):** config 0 → supply 1e9 tokens, curveFee 1%, phantomQuote 1.68 ETH,
graduationThreshold 4.2 ETH, poolFee 0, tickSpacing 200, enabled true;
`expectedEconomics: 0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7`.

---

## Token & curve

### `pons_get_token`

Full state of one Pons-launched token.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | yes | — | 0x address |

**Output keys:** `token` (address, name, symbol, decimals, totalSupply); `launch` (curve,
deployer, creatorFeeRecipient, phase + phaseLabel, graduated, readyToGraduate, launchedAt(+ISO),
buybackEnabled, feeBps, creatorTaxBps, poolFee, tickSpacing); `quote` (pairToken,
pairTokenSymbol, pairTokenDecimals, isNativeQuote, realQuoteReserve / quoteReserve /
graduationThreshold raw + formatted, phantomQuote (raw), graduationProgress, currentSnipeTaxBps /
currentSnipeTax — priced for a **non-exempt buyer**, i.e. the tax a normal buy pays right now);
`curveDump` (launchSupply, reservedTokens, sellableTokens, trackedQuote, trackedTokens, tokenReserve, quoteFeeBalance, creatorTaxBalance,
buybackQuoteBalance, protocolFeeRecipient, protocolFeeShareBps, buybackBurnBps,
maxInternalPriceImpactBps, deployer); `swept` (sweptQuote, sweptTokens, sweptAt); `explorer`.

**Errors:** `INVALID_ADDRESS`, `NOT_A_LAUNCH` (token not in the factory), `RPC_FAILURE`,
`CHAIN_MISMATCH`.

**Example (real, graduated Bounty token):** `phase: 2`, `phaseLabel: "PoolCreated"`,
`graduated: true`, `feeBps: 100`, threshold 4.2 ETH.

---

## Quotes

### `pons_quote_buy`

Quote a bonding-curve buy. Local math is an exact port of the contract's
(`PonsV2BondingCurveMath`); the result is cross-checked with an on-chain `eth_call` of `buy()`.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address |
| `amount` | string | yes | — | decimal string; ETH for native pairs, pair-token units otherwise |
| `recipient` | string | no | `0x…dEaD` | 0x address; the snipe tax is priced for this recipient |

**Output keys:** `curve`, `token`, `side`, `amountIn` (+formatted), `spent` (+formatted),
`refund`, `tokensOut` (+formatted), `curveFee`, `creatorTax`, `snipeTax`,
`snipeTaxBpsApplicableNow`, `clamped`, `priceImpactBps` (+formatted), `crossCheck` (`ok`,
`onChainTokensOut`, `matchesLocalQuote`).

**Example (real):** `{"curveAddress": "0x892c704c…afef", "amount": "0.005"}` → tokensOut
`2903502518026422065628230` (2,903,502.52 PIVOT), curveFee 50,000,000,000,000 wei, snipeTax 0,
priceImpact 1.28%, `crossCheck: { "ok": true, "matchesLocalQuote": true }`.

### `pons_quote_sell`

Quote a bonding-curve sell (fees come off the output). Cross-checked with an on-chain `eth_call`
of `sell()` using state-diff overrides (token balance/allowance slots discovered at runtime).

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address |
| `tokenAmount` | string | yes | — | decimal string, token units |
| `seller` | string | no | `0x…dEaD` | 0x address |

**Output keys:** `curve`, `token`, `side`, `tokensIn` (+formatted), `gross`, `quoteOut`
(+formatted), `curveFee` (+formatted), `creatorTax` (+formatted), `priceImpactBps` (+formatted),
`crossCheck` (`ok`, `onChainQuoteOut`, `matchesLocalQuote`).

**Errors:** additionally `INVALID_PARAMS` when the curve has raised its threshold (sells are
blocked; graduate, then sell on V4).

**Example (real):** 1,000,000 PIVOT → quoteOut `0.001681168680325665 ETH`, priceImpact 0.1%,
`crossCheck.matchesLocalQuote: true`.

### `pons_pending_fee_change`

Read the factory's `pendingCreatorFeeRecipient` for a token.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | yes | — | 0x address |

**Output keys:** `token`, `pending`, `recipient`, `effectiveAt`/`expiresAt` (+ISO variants),
`status` (`none` / `timelocked` / `executable` / `expired`), `timelockSeconds`,
`executionWindowSeconds` (both 259200 = 72 h on-chain). The on-chain tuple is
`(newRecipient, effectiveAt, expiresAt)`; `effectiveAt` = proposal + timelock, `expiresAt` =
effectiveAt + window. Pending entries are created only by the **owner's** `setCreatorFeeRecipient`
override — creator self-service transfers apply immediately and never appear here.

### `pons_quote_swap`

Quote a Uniswap V4 swap for a **graduated** token via the on-chain V4Quoter (hook fees included;
not a local estimate). Native ETH-quoted and ERC-20-quoted pools.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | yes | — | 0x address; must be phase 2 (PoolCreated) |
| `side` | `"buy"` \| `"sell"` | yes | — | buy = quote asset in, token out |
| `amount` | string | yes | — | decimal string (quote-asset units for buy — the pair token's own decimals, e.g. 6 for USDG; tokens for sell); must fit uint128 |

**Output keys:** `token`, `side`, `nativeQuoted`, `pool` (currency0/currency1, fee, tickSpacing, hooks, poolId,
sqrtPriceX96, tick, liquidity), `amountIn` (+formatted), `amountOut` (+formatted),
`quoterGasEstimate`, `zeroForOne`, `hookDrifted` (true when the live `memeHook` differs from the
pinned hook), `note`.

**Errors:** `NOT_A_LAUNCH`, `INVALID_PARAMS` (not graduated, no pool
liquidity), `REVERTED` (quoter), `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Example (real):** buy 0.001 ETH of `0xf25c…fd72` → amountOut `31055153354492009229830`
(31,055.15 tokens), quoterGasEstimate 79675, pool liquidity 29277002188455996254460.

### `pons_fee_balances`

Claimable fee balances in the shared `PonsV2FeeEscrow` for an address, plus buyback-vault vesting
state for a token.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `address` | string | yes | — | 0x address to check |
| `tokenAddress` | string | no | — | adds the escrow token balance + vault vesting state for this token |

**Output keys:** `address`, `feeEscrow`, `claimableEth` (+formatted); with `tokenAddress`:
`token` (address, symbol, claimableTokens + formatted), `buybackVault` (address, registered
— `null` when the factory lookup itself failed, totalLocked, totalReleased, vestedAmount,
releasable (+formatted), vestingDurationSeconds (157680000 = 5 y), `vestingTerms`
(creatorRecipient, protocolRecipient, protocolFeeShareBps, queriedAddressIsBeneficiary)).

### `pons_v1_get_token`

V1 (legacy, Uniswap V3 generation) launch state for a token — the factory that launched the PONS
token itself. V1 is closed to new launches since 2026-08-12.

**Params:** `tokenAddress` (required 0x address).

**Output keys:** `generation`, `factory`, `locker`, `token` (ERC-20 metadata), `launch`
(deployer, pairedToken(+symbol), positionManager, positionId, poolFee(+pct), isToken0,
launchSupply, initialBuyAmount(+formatted), restrictionsEndBlock, dexId, launchConfigId),
`graduation` (current/threshold raw + formatted in pair units, progress clamped to 100%,
graduated — authoritative), `metadata` (deployer, logo, description, socials — from
`getTokenInfo()` on the token), `explorer`.

**Errors:** `NOT_A_LAUNCH` (not in the legacy factory), `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Example (real, the PONS token):** paired WETH, poolFee 1%, positionId 109216, initial buy
0.1 WETH, graduated with ~620 WETH raised against a 4.2 WETH threshold.

### `pons_v1_launches`

Scan the legacy factory's `TokenLaunched` events, newest-first. V1 history sits far behind the
latest block (launches ended ~2026-08), so absolute ranges are supported.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `lookbackBlocks` | number | no | 50000 | 1–500000 (from latest; useless for V1 history) |
| `limit` | number | no | 20 | 1–100 |
| `deployer` | string | no | — | 0x address filter (server-side topic) |
| `fromBlock` | number | no | — | absolute start block; overrides `lookbackBlocks` |
| `toBlock` | number | no | latest | absolute end block |

**Output keys:** `generation`, `factory`, `scannedFromBlock` (oldest block actually scanned),
`scannedToBlock`, `scanComplete` (false when the limit short-circuited before reaching the start —
resume with `toBlock = scannedFromBlock - 1`), `requestedFromBlock` (lookback mode only), `count`,
`launches[]` (token, deployer, dexFactory, pairToken, pool, dexId, launchConfigId,
positionId, restrictionsEndBlock, initialBuyAmount, blockNumber, transactionHash, logIndex).

---

## Writes — launch & trading

All take `dryRun` (default `true`) and `confirm` (default `false`).

### `pons_launch_token`

Create a token on the Pons v2 factory. No dev buy → `factory.launchToken` with
`msg.value == launchFee()` exactly. Dev buy → atomic `launchAndBuy` on the factory's live
`launchForwarder()` with `msg.value = launchFee + devBuy` (the only sane path: the 99% same-block
snipe tax eats any non-atomic first buy).

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `name` | string | yes | — | 1–64 utf8 bytes |
| `symbol` | string | yes | — | 1–16 utf8 bytes |
| `logo` | string | no | `""` | ≤ 512 bytes |
| `description` | string | no | `""` | ≤ 2048 bytes |
| `socials` | object | no | — | `twitter`/`telegram`/`discord`/`website`/`farcaster`, each ≤ 256 bytes |
| `creatorFeeRecipient` | string | no | signer | 0x address |
| `creatorTaxBps` | number | no | 0 | 0–10000, and ≤ factory `maxCreatorTaxBps` (1000) |
| `buybackEnabled` | boolean | no | false | — |
| `launchConfigId` | number | no | 0 | int ≥ 0, must be an enabled config |
| `pairToken` | string | no | zero address (ETH) | 0x address; ERC-20 pairs only with `devBuyEth: "0"` |
| `devBuyEth` | string | no | `"0"` | decimal string; ≤ `PONS_MAX_DEV_BUY_ETH` (default 0.05) |
| `snipeTaxExemptions` | string[] | no | `[]` | ≤ 32 addresses (≤ 31 with a dev buy) |
| `acceptContractDrift` | boolean | no | false | required to broadcast a dev buy when the live `launchForwarder` differs from the pinned router |
| `dryRun` | boolean | no | true | — |
| `confirm` | boolean | no | false | broadcast needs `dryRun=false` + `confirm=true` |

**Output (dry-run):** `mode: "dry-run"`, `route` (`factory` | `launchAndBuyRouter`), `to`,
`signer`, `params` (incl. `salt`, `expectedEconomics`), `economics` (launchFee, devBuy, txValue;
with dev buy also tokensOut/minTokensOut/supplyShareBps/clamped), `gas` (estimate, estimateWithBuffer,
maxFeePerGas, estimatedGasCost, estimatedTotalCost, estimateError), `simulation` (ok, predictedToken,
predictedCurve, error), `calldata`, `forwarderDrifted` (dev-buy route only), `note`.

**Output (broadcast):** plus `transaction` (hash, blockNumber, gasUsed, effectiveGasPrice,
status), `launched` (token, curve, phase, explorerToken), `explorerTx`, `dailyCap`.

**Errors:** `INVALID_PARAMS` (validation, disabled config, not allowed to launch, zero economics
digest, simulation reverted before broadcast), `CAP_EXCEEDED` (dev-buy or daily cap),
`INVALID_ADDRESS`, `REVERTED` (on-chain revert of a broadcast), `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Notes:** the CREATE2 salt derives from `name + " " + symbol + " "` — relaunching identical
terms from the same wallet reverts by design. Launch broadcasts are capped by
`PONS_MAX_LAUNCHES_PER_DAY` (default 5 per rolling 24 h).

**Example dry-run (real, unfunded signer):** route `factory`, txValue 0.0005 ETH,
`expectedEconomics: 0xa9fc…1ca7`, and `simulation.error: "insufficient funds …"` (the preview
fails gracefully; with a funded signer the same call returns `predictedToken`/`predictedCurve`
and a gas estimate around 3.5M).

### `pons_buy`

Buy on a bonding curve.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address; must be the **factory-registered** curve for its token, and still trading (not graduated) |
| `amount` | string | yes | — | decimal string; ETH for native pairs, pair-token units otherwise |
| `minTokensOut` | string | no | quote − 5% | decimal string, token units |
| `recipient` | string | no | signer | 0x address |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Registration guard:** the curve must match the factory's `getLaunchedToken` record for the
token it reports — a contract that merely implements the curve ABI is rejected with
`NOT_A_LAUNCH`. Without this, a fake "curve" could receive the signer's ETH value or an ERC-20
approval.

**Mechanics:** native pair → `curve.buy(amountIn, minTokensOut, recipient)` with
`value = amountIn`. ERC-20 pair → same call with `value = 0`, preceded by an exact-amount
`approve(pairToken → curve)` when allowance is insufficient.

**Output:** `summary`, `mode`, `signer`, `steps[]` (label, to, valueWei, calldata, simulation,
gas), `feeMarket`, `quote` (amountIn, tokensOut(+formatted), minTokensOut, spent, refund,
snipeTaxBpsNow, priceImpactBps, clamped, slippageBps). Broadcast adds `receipts[]`.

**Errors:** `INVALID_PARAMS` (graduated curve, zero amount, simulation reverted),
`INVALID_ADDRESS`, `REVERTED`, `RPC_FAILURE`, `CHAIN_MISMATCH`.

**Example dry-run (real):** 0.005 ETH on the PIVOT curve → one step, `simulation.ok: true`,
gas 102,864, tokensOut 2,903,502.52 PIVOT, minTokensOut at 5% slippage.

### `pons_sell`

Sell tokens on a bonding curve.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address; must be the **factory-registered** curve for its token (same guard as `pons_buy`) |
| `tokenAmount` | string | yes | — | decimal string, token units |
| `minQuoteOut` | string | no | quote − 5% | decimal string, quote units |
| `recipient` | string | no | signer | 0x address |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Mechanics:** exact-amount `approve(token → curve, tokensIn)` first when allowance is
insufficient (no standing grant), then `curve.sell(tokensIn, minQuoteOut, recipient)`. Broadcast
sends approve, waits for its receipt, then sells.

**Output:** as `pons_buy`; quote block has tokensIn, gross, quoteOut(+formatted), minQuoteOut,
curveFee, creatorTax, priceImpactBps, slippageBps. Includes a `warning` when the signer's
on-chain balance is below `tokenAmount` (dry-run simulates with a balance override; broadcast
would fail).

**Errors:** as `pons_buy`, plus `INVALID_PARAMS` when the curve has raised its threshold (sells
are blocked — graduate first) or the signer balance is insufficient on a broadcast attempt.

**Example dry-run (real):** sell 1,000 PIVOT → two steps (approve 46,343 gas, sell 89,219 gas),
both simulated ok.

---

## Writes — creator & lifecycle

### `pons_graduate`

Finish a curve that raised its threshold. **Permissionless** — anyone may call it.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `token` | string | yes | — | 0x address; token **or** curve address |
| `phase` | `"sweep"` \| `"pool"` \| `"both"` | no | `"both"` | sweep = `factory.graduate(token)` (drain curve), pool = `factory.createGraduatedPool(token)` (seed V4 pool) |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Errors:** `NOT_A_LAUNCH` (address is neither token nor curve), `INVALID_PARAMS` when:
already graduated (`phase PoolCreated`), not ready (message includes progress, e.g. "raised
0.0099 ETH of 4.2 ETH (0.23%)"), or sweep requested when already swept.

**Example (real error):** `{"token": "0xa492b226…c0b6"}` →
`"curve has not raised its graduation threshold yet: raised 0.009900000000000016 ETH of 4.2 ETH (0.23%)"`.

### `pons_set_creator_fee_recipient`

Transfer the creator fee recipient to a new address (factory `transferCreatorFeeRecipient`).
**Verified against the factory source: this creator self-service call applies IMMEDIATELY on
broadcast — no timelock, no pending entry, nothing to execute later.** Callable only by the
current creatorFeeRecipient. (The timelocked pending-change flow is the owner's separate
`setCreatorFeeRecipient` override.)

**Params:** `tokenAddress` (required), `recipient` (required 0x address), `dryRun`/`confirm`.

**Output details:** `token`, `currentCreatorFeeRecipient`, `pendingChange` (existing
owner-initiated proposal if any: recipient, effectiveAt, expiresAt).

### `pons_execute_fee_recipient_change`

Execute a pending **owner-initiated** change within its 72 h execution window (permissionless).
**Params:** `tokenAddress`, `dryRun`/`confirm`.
**Errors:** with nothing pending (or the window closed) the dry-run carries the revert in
`steps[].simulation.error`, and a broadcast attempt is refused with `INVALID_PARAMS`
("simulation reverted … refusing to broadcast"). `REVERTED` only results from a mined status-0
receipt. Check pending state with `pons_pending_fee_change`.

### `pons_cancel_fee_recipient_change`

Cancel a pending change. **Owner-only on-chain** (reverts `OwnableUnauthorizedAccount` for the
fee recipient — verified 2026-09).
**Params:** `tokenAddress`, `dryRun`/`confirm`.

### `pons_exempt_snipe_tax`

**Always fails with an explanatory `INVALID_PARAMS` error.** Verified on-chain:
`curve.exemptFromSnipeTax` is factory-internal (`NotFactory`) and the factory exposes no wrapper.
Exemptions can only be set at launch via `snipeTaxExemptions` in `pons_launch_token` (the
launchAndBuy router appends the dev-buy recipient automatically).

**Params** (validated, then the error is raised): `curveAddress` (required 0x address),
`account` (required 0x address), `dryRun`/`confirm` (accepted for interface uniformity, no
effect).

### `pons_set_buyback`

Enable/disable the buyback vault: `factory.setBuybackEnabled(token, enabled)`. Verified on-chain:
**enabling requires the current creator fee recipient; the owner may also disable** (the curve's
own `setBuybackEnabled` is factory-internal). Accepts the curve or token address.

**Params:** `curveAddress` (required), `enabled` (required boolean), `dryRun`/`confirm`.

### `pons_sweep_curve_fees`

Sweep **all** accrued fees from a curve: `curve.sweepFees(minBuybackTokensOut)`. Verified against
the curve source: the argument is a token-denominated minimum-output floor for the internal
buyback swap, not an amount to sweep. When a buyback balance is pending, `minBuybackTokensOut`
must be > 0 (else `MinimumOutputRequired`) and only the operator may sweep
(`InternalSwapRequiresOperator`).

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `curveAddress` | string | yes | — | 0x address |
| `minBuybackTokensOut` | string | no | `"0"` | decimal string in token units |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Output details** include current `quoteFeeBalance`, `creatorTaxBalance`, and
`buybackQuoteBalance`, plus a warning when a pending buyback constrains the call.

### `pons_rescue_curve_fees`

Rescue stuck fees: `factory.rescueCurveFees(token)`, **owner-gated** (the curve's `rescueFees`
is factory-internal). Accepts the curve or token address.

**Params:** `curveAddress`, `dryRun`/`confirm`.

### `pons_claim_fees`

Claim accrued fees from the shared `PonsV2FeeEscrow` (verified source): `claim()` /
`claim(amount)` for native ETH, `claimToken(token)` / `claimToken(token, amount)` for ERC-20.
Pays `msg.sender`. Omit `amount` to claim the entire balance; partial amounts exist because a
quote asset with a per-transfer limit could otherwise brick a full-balance claim.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | no | — (native ETH) | 0x address |
| `amount` | string | no | entire balance | decimal string (token units for ERC-20, ETH otherwise) |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Errors:** `INVALID_PARAMS` when nothing is claimable (the on-chain `NoBalance` revert is
pre-checked) or `amount` exceeds the claimable balance.

### `pons_release_buyback`

Release the currently vested slice of a launch's buyback-vault lock (5-year linear vesting,
weighted-average clock across deposits) into the fee escrow: `buybackVault.release(token)`. The
release is split creator/protocol by the launch's frozen `protocolFeeShareBps`. **Callable only
by the vest's creator or protocol recipient** (else reverts `NotVestBeneficiary`); claim the
escrowed share afterwards with `pons_claim_fees`.

**Params:** `tokenAddress` (required), `dryRun`/`confirm`.

**Output details:** `releasable` (+formatted), `totalLocked`, `totalReleased`, `vestingTerms`,
`signerIsBeneficiary` (with a warning when false).

---

## Writes — admin & swaps

### `pons_admin_call`

Generic factory owner surface. Reverts for non-owners; the dry-run simulation shows that (the
summary line reports whether signer == current owner).

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `fn` | enum | yes | — | see below |
| `args` | object | no | `{}` | typed per fn |
| `iUnderstandIrreversible` | boolean | no | false | required `true` for `renounceOwnership` |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**`fn` values and args:**

| fn | args |
|---|---|
| `setLaunchFee` | `launchFee` (ETH decimal string, e.g. `"0.0005"`) |
| `setLaunchEnabled` | `enabled` (bool) |
| `setMaxCreatorTaxBps` | `maxCreatorTaxBps` (int) |
| `setSnipeTaxStartBps` | `snipeTaxStartBps` (int) |
| `setSnipeTaxSeconds` | `snipeTaxSeconds` (int) |
| `setPairTokenApproved` | `pairToken` (address), `approved` (bool) |
| `setPairTokenEconomics` | `pairToken`, `phantomQuote`, `graduationThreshold` (decimal strings, scaled by `decimals`), `decimals` (int 0–36) |
| `setCreatorFeeRecipient` | `token`, `newRecipient` (addresses) — owner override: creates the **timelocked** pending change (effective after 72 h, executable for 72 h); distinct from the creator's immediate `pons_set_creator_fee_recipient` |
| `addLaunchConfig` | `supply` (raw base units), `curveFeeBps`, `phantomQuote`, `graduationThreshold` (decimal strings; scaled by optional `decimals`, default 18), `poolFee` (uint24), `tickSpacing` (int24, may be negative), `enabled` (bool) |
| `updateLaunchConfig` | `launchConfigId` + same fields as `addLaunchConfig` |
| `setWhitelistedLauncher` | `account` (address), `allowed` (bool) |
| `setGraduationExecutor` / `setLaunchDeployer` / `setLaunchForwarder` | `address` |
| `transferOwnership` | `newOwner` (address) |
| `acceptOwnership` | — |
| `renounceOwnership` | — (needs `iUnderstandIrreversible: true`; note: on-chain it always reverts `OwnershipCannotBeRenounced` — the contract disables renouncing) |

### `pons_swap`

Swap a **graduated** token on its Uniswap V4 pool via the Universal Router. Native ETH-quoted
**and** ERC-20-quoted pools.

**Params:**

| name | type | required | default | constraints |
|---|---|---|---|---|
| `tokenAddress` | string | yes | — | 0x address; must be phase 2 (PoolCreated) |
| `side` | `"buy"` \| `"sell"` | yes | — | — |
| `amount` | string | yes | — | decimal string (quote-asset units for buy — the pair token's own decimals for ERC-20-quoted pools; tokens for sell); must fit uint128 |
| `minOut` | string | no | quote − 5% | decimal string in output units |
| `acceptContractDrift` | boolean | no | false | required to broadcast when the live `memeHook` differs from the pinned hook |
| `dryRun` / `confirm` | boolean | no | true / false | — |

**Mechanics:**

- **Buy, native-quoted pool**: one `V4_SWAP` command (`SWAP_EXACT_IN_SINGLE`, `SETTLE` native
  from the router's balance, `TAKE` token to caller), `msg.value = amountIn`, deadline now + 300 s.
- **Any ERC-20 input** (selling the token, or buying an ERC-20-quoted pool with the pair token):
  if the input token's ERC-20 allowance to Permit2 is insufficient, an unlimited
  `approve(input → Permit2)` step is bundled first; then one transaction carrying
  `PERMIT2_PERMIT` (EIP-712 PermitSingle signed by the signer — 30 min validity, exact amount,
  exact spender) + `V4_SWAP` (`SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL` input token in, `TAKE` output
  to caller — native out when the pool is ETH-quoted, pair token otherwise).
  **The signature is created only when broadcasting.** A dry-run simulates the bare `V4_SWAP`
  with the Permit2 allowance granted by a state-diff override, so no live, replayable signature
  ever leaves the process during a preview.

**Output:** `summary`, `mode`, `steps[]` with simulation + gas, `nativeQuoted`, `poolKey`,
`hookDrifted`, `quote` (amountIn,
amountOut from the on-chain V4Quoter, minOut, slippageBps 500), `deadline`. Broadcast adds
`receipts[]`.

**Errors:** `NOT_A_LAUNCH`, `INVALID_PARAMS` (not graduated, no liquidity,
insufficient signer token balance on a token-input broadcast, hook drift without
`acceptContractDrift`, simulation reverted), `REVERTED`, `RPC_FAILURE` (incl. an underfunded
native-buy broadcast, which surfaces the node's "insufficient funds" as `RPC_FAILURE` rather
than `INVALID_PARAMS`), `CHAIN_MISMATCH`.

**Example dry-run (real, unfunded throwaway signer):** buy 0.001 ETH of `0xf25c…fd72` → one
step, simulation ok, gas 152,411. Sell 1,000 tokens → two steps (approve 46,583 gas;
PERMIT2_PERMIT + V4_SWAP 183,118 gas), both simulated ok.

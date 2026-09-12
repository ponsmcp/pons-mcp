# The Pons v2 protocol, as pons-mcp understands it

Everything below is verified from live chain state on Robinhood Chain (chainId 4663), cross-checked
against the Sourcify-verified contract sources (compiler 0.8.35, exact match) vendored in
[ponscli](https://github.com/mesutgulecen/ponscli). Where documentation and chain state disagree,
**chain wins** — see "Verified divergences" at the end.

## Chain facts

| Property | Value |
|---|---|
| Network | Robinhood Chain (Arbitrum-stack L2 settling to Ethereum) |
| chainId | 4663 (`0x1237`) — asserted at startup and before every tool call |
| Native gas asset | ETH |
| Block time | ~0.1008 s (~9.92 blocks/s); 500k blocks ≈ 14 h |
| Default RPC | `https://rpc.mainnet.chain.robinhood.com` (`PONS_RPC_URL`, comma-separated = failover) |
| Archive support | none — all reads at `latest` |
| Explorer | `https://robinhoodchain.blockscout.com` |

## Contract addresses

| Role | Address | Notes |
|---|---|---|
| Pons v2 factory (`PonsV2LaunchFactory`) | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | hub: launches, graduation, fee-recipient timelock, owner admin |
| `launchAndBuy` router (`PonsV2LaunchAndBuy`) | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | factory's `launchForwarder()` — read live, owner-settable |
| CREATE2 deployer (`PonsV2LaunchDeployer`) | `0x3711cea4feade896c913c68f01eda97cb06d1a42` | factory's `launchDeployer()` — owner-settable |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | quoting via `eth_call` |
| V4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | getSlot0 / getLiquidity |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | **non-standard fork** — see below |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical |
| memeHook | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` | hook on every graduated V4 pool; read live from factory |
| feeEscrow | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e` | creator/protocol fee accrual |
| buybackVault | `0x42df2a798f82289e177311362e8f5ccc45c1219c` | 5-year linear vesting of bought-back supply |
| graduationExecutor | `0xc7819b64a1daecd7ec19856d026cb14efbd89046` | executes the graduation sweep |
| PONS token | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | **not registered in the v2 factory** (predates it); default for `pons_token_supply` only |

Owner (read live, was `0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd` on 2026-09-07).

## Live protocol parameters (2026-09-07)

launchFee **0.0005 ETH** · launchEnabled **true** · maxCreatorTaxBps **1000** (10%) ·
snipeTaxStartBps **9900** (99%) · snipeTaxSeconds **3** · one launch config: supply 1e9 tokens,
curveFee 100 bps (1%), phantomQuote 1.68 ETH, graduationThreshold 4.2 ETH, poolFee 0,
tickSpacing 200 · fee-recipient timelock **259200 s** (72 h) · execution window **259200 s** ·
graduation rescue delay **604800 s** (7 d).

## Launch lifecycle and the phase enum

`getLaunchedToken(token).phase`:

| value | phase | meaning |
|---|---|---|
| 0 | NotGraduated | trading on the bonding curve |
| 1 | Swept | curve drained into the factory (`graduate`), V4 pool not yet created |
| 2 | PoolCreated | graduated; trades on the Uniswap V4 pool |
| 3 | Rescued | rescued by the owner after a failed graduation (post `GRADUATION_RESCUE_DELAY`) |

Graduation is permissionless and two-phased: `factory.graduate(token)` sweeps the curve, then
`factory.createGraduatedPool(token)` seeds the V4 position. A curve stops selling once
`readyToGraduate()` is true; buys/sells revert from that point.

## Function ↔ tool map (1:1 parity reference)

### Factory `0x7eD598…EC7e`

| Contract function | Tool |
|---|---|
| `launchFee` / `launchEnabled` / `maxCreatorTaxBps` / `snipeTaxStartBps` / `snipeTaxSeconds` / `launchConfigCount` / `getLaunchConfig` | `pons_protocol_overview`, `pons_preview_launch` |
| `owner` / `pendingOwner` / `locker` / `memeHook` / `feeEscrow` / `buybackVault` / `poolManager` / `positionManager` / `permit2` / `launchDeployer` / `launchForwarder` / `graduationExecutor` / `graduationGuard` / `CREATOR_FEE_RECIPIENT_TIMELOCK` / `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW` / `GRADUATION_RESCUE_DELAY` | `pons_protocol_overview` |
| `canLaunch` / `whitelistedLaunchers` | `pons_can_launch` |
| `approvedPairTokens` / `pairTokenEconomics` | `pons_pair_token_economics`, `pons_preview_launch` |
| `previewLaunchEconomics` | `pons_preview_launch`, `pons_launch_token` (guard) |
| `getLaunchedToken` | `pons_get_token`, `pons_graduate`, creator tools |
| `launchToken` | `pons_launch_token` (no dev buy) |
| `graduate` / `createGraduatedPool` | `pons_graduate` |
| `transferCreatorFeeRecipient` / `executeCreatorFeeRecipientChange` / `cancelCreatorFeeRecipientChange` / `pendingCreatorFeeRecipient` | `pons_set_creator_fee_recipient` / `pons_execute_fee_recipient_change` / `pons_cancel_fee_recipient_change` / `pons_pending_fee_change` |
| `setBuybackEnabled(token, bool)` | `pons_set_buyback` (deployer-gated) |
| `rescueCurveFees(token)` | `pons_rescue_curve_fees` (owner-gated) |
| `setLaunchFee`, `setLaunchEnabled`, `setMaxCreatorTaxBps`, `setSnipeTaxStartBps`, `setSnipeTaxSeconds`, `setPairTokenApproved`, `setPairTokenEconomics`, `setCreatorFeeRecipient` (owner override → timelocked pending change), `addLaunchConfig`, `updateLaunchConfig`, `setWhitelistedLauncher`, `setGraduationExecutor`, `setLaunchDeployer`, `setLaunchForwarder`, `transferOwnership`, `acceptOwnership`, `renounceOwnership` | `pons_admin_call` |
| `TokenLaunched` / `PoolGraduated` events | `pons_recent_launches`, `pons_recent_graduations`, `pons_creator_launches` |

### Curve (`PonsV2BondingCurve`, deployed per launch)

| Contract function | Tool |
|---|---|
| 26 view functions (`token`, `graduated`, `readyToGraduate`, `realQuoteReserve`, `quoteReserve`, `phantomQuote`, `graduationThreshold`, `getReserves`, `tokenReserve`, `launchSupply`, `reservedTokens`, `sellableTokens`, `trackedQuote`, `trackedTokens`, `pairToken`, `isNativeQuote`, `launchedAt`, `currentSnipeTaxBps`, `snipeTaxExempt`, `feeBps`, `creatorTaxBps`, `buybackEnabled`, `deployer`, `quoteFeeBalance`, `creatorTaxBalance`, `buybackQuoteBalance`, `protocolFeeRecipient`, `protocolFeeShareBps`, `buybackBurnBps`, `maxInternalPriceImpactBps`, …) | `pons_get_token`, `pons_snipe_tax`, quote tools |
| `buy(uint256 amountIn, uint256 minTokensOut, address recipient)` payable | `pons_buy`, `pons_quote_buy` |
| `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)` | `pons_sell`, `pons_quote_sell` |
| `sweepFees(uint256)` | `pons_sweep_curve_fees` |
| `CurveBuy` / `CurveSell` events | `pons_curve_trades` |
| `exemptFromSnipeTax` / `rescueFees` / `setBuybackEnabled` | **factory-internal** (`NotFactory`) — no external path; see verified divergences |

### launchAndBuy router / Uniswap V4

| Contract function | Tool |
|---|---|
| `launchAndBuy(TokenParams, configId, pairToken, quoteIn, minTokensOut, recipient, exemptions)` | `pons_launch_token` (with dev buy) |
| V4Quoter `quoteExactInputSingle` | `pons_quote_swap`, `pons_swap` (floor) |
| StateView `getSlot0` / `getLiquidity` | `pons_quote_swap` (pool context) |
| UniversalRouter `execute(bytes, bytes[], uint256)` | `pons_swap` (stock V4 commands only) |
| Permit2 `permit` (EIP-712 PermitSingle) | `pons_swap` token-input paths (sell, or buy on an ERC-20-quoted pool) |
| ERC-20 `approve` | bundled by `pons_sell` (exact amount), `pons_buy` (ERC-20 pairs), `pons_swap` token inputs (Permit2, unlimited) |

### Fee escrow / buyback vault

| Contract function | Tool |
|---|---|
| escrow `balanceOf(address)` / `balanceOfToken(address,address)` | `pons_fee_balances` |
| escrow `claim()` / `claim(uint256)` / `claimToken(address)` / `claimToken(address,uint256)` | `pons_claim_fees` |
| vault `release(address)` | `pons_release_buyback` (creator/protocol recipient only on-chain) |
| vault `totalLocked` / `totalReleased` / `vestedAmount` / `releasable` / `vestingTerms` | `pons_fee_balances` |

Both satellites are Sourcify-verified on chain 4663 (feeEscrow matchId 43642574, buybackVault
43855070). Key semantics from the verified source: the escrow aggregates every recipient's
claimable balance across all launches (partial claims exist to dodge per-transfer token limits);
the vault vests buybacks linearly over **5 years** with a weighted-average clock, releases pay
into the escrow split by the launch's frozen `protocolFeeShareBps`, and only the vest's
creator/protocol recipient may call `release`.

### V1 legacy launchpad (read-only)

V1 (the Uniswap V3 generation, closed to new launches 2026-08-12) is supported read-only:

| Role | Address |
|---|---|
| Legacy factory | `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` |
| Legacy locker | `0x31ca5E101941A93A7DD6d0497928700625CF54B5` |

Verified three ways (2026-09): the legacy factory created the PONS token (tx `0x1f54f25f…`,
block 8963150); Mobula's Pons integration guide lists it as "Legacy factory"; and it emitted the
documented legacy `TokenLaunched` event in that exact transaction.

| Contract function | Tool |
|---|---|
| `getLaunchedToken(address)` → 13-field tuple (token, deployer, pairedToken, positionManager, positionId, dexId, launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists, initialBuyAmount) | `pons_v1_get_token` |
| `graduationStatus(address)` → (current, threshold, graduated) | `pons_v1_get_token` |
| token `getTokenInfo()` → (deployer, logo, description, socials) | `pons_v1_get_token` |
| `TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)` (indexed: token, deployer, dexFactory; data: pairToken, pool, dexId, launchConfigId, positionId, restrictionsEndBlock, initialBuyAmount) | `pons_v1_launches` (absolute block ranges supported — V1 history predates any lookback window) |

Graduated V1 liquidity lives in Uniswap V3 NFT positions (positionManager `0x73991a25…de0d3`),
not the V4 PoolManager.

## Tuple layouts

`TokenParams` (launch calls):

```
(string name, string symbol, string logo, string description,
 (string twitter, string telegram, string discord, string website, string farcaster) socials,
 address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled,
 bytes32 expectedEconomics, bytes32 salt)
```

`getLaunchedToken(address)` → 15 × 32-byte words:

| word | field | word | field |
|---|---|---|---|
| 0 | token | 8 | creatorTaxBps (uint16) |
| 1 | curve | 9 | buybackEnabled |
| 2 | deployer | 10 | phase (uint8, see enum) |
| 3 | creatorFeeRecipient | 11 | sweptQuote |
| 4 | pairToken | 12 | sweptTokens |
| 5 | graduationThreshold | 13 | sweptAt |
| 6 | poolFee (uint24) | 14 | exists |
| 7 | tickSpacing (int24, sign-extended) | | |

`getLaunchConfig(uint256)` → `(uint256 supply, uint256 curveFeeBps, uint256 phantomQuote,
uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled)`.

## Event layouts

| Event | Signature | Layout |
|---|---|---|
| `TokenLaunched` | `(address,address,address,address,uint256,uint256)` | topics[1]=token, topics[2]=curve, topics[3]=deployer (indexed); data = (pairToken, launchConfigId, graduationThreshold) |
| `PoolGraduated` | `(address,uint256,uint256,uint256)` | topics[1]=token; data = (positionId, tokenAmount, pairTokenAmount) — on the factory |
| `CurveBuy` | `(address,address,uint256,uint256,uint256,uint256)` | topics[1]=buyer, topics[2]=recipient; data = (**spent** (post-clamp), tokensOut, fee **including snipe tax**, tax) — on the curve; clamp refunds arrive as a separate `CurveBuyRefunded` event |
| `CurveSell` | same shape | topics[1]=seller, topics[2]=recipient; data = (tokensIn, quoteOut, fee, tax) — on the curve |

## Verified quirks (checked against the Sourcify-verified factory/router source, 2026-09)

The factory and launchAndBuy router are Sourcify exact-matches on chain 4663. These behaviors
were confirmed from that source and differ from intuition or older docs:

- **`transferCreatorFeeRecipient` (creator self-service) applies IMMEDIATELY** — no timelock, no
  pending entry (`Factory.sol`). The timelocked pending/execute/cancel flow is the *owner's*
  separate `setCreatorFeeRecipient` override; `pendingCreatorFeeRecipient` returns
  `(newRecipient, effectiveAt, expiresAt)` where `effectiveAt = proposed + 72 h` and
  `expiresAt = effectiveAt + 72 h`.
- **`sweepFees(minBuybackTokensOut)` sweeps ALL pending fees**; the argument is a
  token-denominated minimum-output floor for the internal buyback swap. `0` reverts
  `MinimumOutputRequired` when `buybackQuoteBalance != 0`, and only the operator may sweep while
  a buyback is pending (`InternalSwapRequiresOperator`).
- **Buy slippage is a price bound**: `spent * minTokensOut > received * tokensOut` reverts.
  On clamped (partial) fills `spent < received`, so a floor computed from the full offered amount
  reverts — this server scales the floor by `spent / offered`.
- **Snipe-tax window is snapshotted per curve** at initialize (`curve.snipeTaxSeconds()`); the
  factory global can be retuned later without affecting existing launches.
- `renounceOwnership()` is `pure` and always reverts `OwnershipCannotBeRenounced`.
- `setGraduationExecutor` / `setLaunchDeployer` are one-time setters (`AlreadySet`);
  `setLaunchForwarder` is rotatable (and therefore drift-gated in this server).

## Quote-asset multiplicity

- The **zero address is the native-ETH sentinel** for `pairToken` — not WETH. A native launch's
  V4 pool is keyed on `address(0)` and holds real ETH (no wrap/unwrap in the swap path).
- Pair tokens carry their own economics: `pairTokenEconomics(pairToken)` gives phantomQuote,
  graduationThreshold, decimals **per asset**, and each curve re-reads its own
  `graduationThreshold()` (4.2 ETH default; USDG curves use 6-decimal units; observed up to
  711 ETH). Always format with the pair token's own `decimals()`.
- ERC-20-quoted launches cannot take an atomic dev buy through this server (the router pulls
  ERC-20 via `transferFrom`, which needs an approval flow) and ERC-20-quoted V4 pools are
  unsupported for swaps (needs a WRAP/UNWRAP envelope — ponscli refuses these too).

## Verified chain-vs-docs divergences (2026-09)

| Believed / documented | On-chain truth |
|---|---|
| snipeTaxSeconds = 5 (docs) | **3** |
| PONS token is the first v2 graduate | not registered in the v2 factory at all (zero TokenLaunched/PoolGraduated events, `exists=false`) |
| `curve.exemptFromSnipeTax` externally callable | reverts `NotFactory`; exemptions are launch-time only |
| `curve.setBuybackEnabled` / `curve.rescueFees` externally callable | reverts `NotFactory`; use `factory.setBuybackEnabled(token,bool)` (deployer) / `factory.rescueCurveFees(token)` (owner) |
| `factory.rescueCurveFees` takes a curve address | takes the **token** address (`TokenNotFound` otherwise) |
| `cancelCreatorFeeRecipientChange` callable by the fee recipient | owner-only (`OwnableUnauthorizedAccount`) |
| `renounceOwnership()` usable | declared `pure`, always reverts `OwnershipCannotBeRenounced` |
| Universal Router is stock | fork: V3 command carries a trailing `address[]` (omitting it → `SliceOutOfBounds`); stock V4 commands work |
| `factory.launchToken` accepts `msg.value ≥ launchFee` | must **equal** `launchFee()` exactly (`LaunchFeeNotPaid` otherwise) |

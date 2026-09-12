# Security

## Threat model

pons-mcp has two modes with sharply different blast radius:

- **Read-only (default)** — no key material exists in the process. The server can only query
  public chain state. Worst case is wrong data, not lost funds.
- **Write mode** (`PONS_PRIVATE_KEY` set) — the process holds a hot key and can sign and
  broadcast arbitrary Pons-protocol transactions as that key. Everything below exists to keep
  that mode deliberate, bounded, and inspectable.

## Key custody

- The key comes **only** from the `PONS_PRIVATE_KEY` environment variable (32-byte hex, 0x prefix
  optional). There is no key file, no prompt, no RPC parameter, no tool input that can carry a key.
- The key is **never logged**. Only the derived address appears (stderr at startup, and as the
  `signer` field in write previews). The env var is deleted from `process.env` right after
  loading, so it does not linger for the process lifetime (the derived key bytes necessarily stay
  in memory — that is inherent to a hot signer; see "Hot-wallet guidance").
- No key, no writes: with the variable unset the 15 write tools are **not registered at all** —
  an MCP client cannot even see them, let alone invoke them. There is no runtime path to enable
  write mode; it requires a process restart with the env var set.

## Transaction gating

Every write tool requires two independent affirmative signals to broadcast:

- `dryRun=false` (the default is `true`), **and**
- `confirm=true` (the default is `false`).

Both are strict zod booleans, validated by the MCP SDK before any handler runs — a string
`"false"` does not parse. Anything else returns a dry-run: full `eth_call` simulation of every
step, gas estimates, the exact calldata, and cost breakdown — but nothing is broadcast, and
**nothing is signed**. Multi-step write tools (`pons_buy`, `pons_sell`, `pons_swap`, …) simulate
with state-diff overrides so the simulation is faithful even for unfunded wallets;
`pons_launch_token` simulates without overrides (an unfunded signer sees the node's
"insufficient funds" in `simulation.error`). The one place a signature is needed on the
broadcast path (the Permit2 EIP-712 permit in a `pons_swap` sell) is signed only when
broadcasting; the dry-run simulates with a state-diff override on the Permit2 allowance slot
instead, so no live, replayable signature ever appears in a preview.

On broadcast the flow is: re-simulate → refuse if any non-dependent step reverts → sign → send
steps sequentially, waiting for each receipt → status-0 receipt becomes a structured `REVERTED`
error (later steps never send after a failed earlier one).

## RPC trust

The configured RPC endpoint is assumed **honest but unreliable**. Unreliability is handled
(retries, failover, re-filtering); dishonesty is bounded by pinning and verification:

- **Transaction destinations are pinned or verified.** The factory, Universal Router, Permit2,
  quoter, and state-view addresses are hardcoded. The two addresses that must be read live
  (`launchForwarder` for dev buys, `memeHook` for V4 pool keys) are compared against pinned
  known-good values; a drifted value **blocks broadcast** of the affected transaction unless the
  caller passes `acceptContractDrift: true` (the drift is also shown in every dry-run).
- **Transaction hashes are verified locally.** The hash returned by `eth_sendRawTransaction`
  must equal the locally computed keccak-256 of the signed payload, and the polled receipt must
  be for that hash — a fabricated hash or receipt is refused. A receipt's *contents* (e.g. the
  `TokenLaunched` log a launched token address is parsed from) still come from the endpoint;
  cross-check on the explorer before acting on them.
- **Simulations and quotes are advisory.** A malicious endpoint can lie about reserves, quotes,
  and simulation outcomes; the on-chain `minOut` floors (quote − 5% default) are computed from
  those quotes, so they bound slippage relative to the quoted price, not to the true price. Use
  an HTTPS endpoint you trust for pricing.
- **Fee bids are sanity-capped.** `maxFeePerGas` from the endpoint is refused above a fixed
  ceiling (50 gwei ≈ 170× this chain's norm), so a hostile endpoint cannot drain the wallet
  through inflated priority fees.
- **Endpoint URLs never appear in errors.** Error messages sanitize the URL (origin plus masked
  path, no query string or credentials), so an API key embedded in `PONS_RPC_URL` cannot leak
  into MCP tool results or logs.

## Curve identity

`pons_buy` / `pons_sell` verify that the supplied curve is
the factory-registered curve for the token it reports (`getLaunchedToken(token).curve ==
curveAddress`, `exists == true`). A contract that merely implements the curve ABI is rejected
with `NOT_A_LAUNCH` — without this check a fake "curve" could receive the signer's ETH as
transaction value or an ERC-20 approval over a real pair token. The quote tools
(`pons_quote_buy`/`pons_quote_sell`) deliberately accept any curve address: they move no funds,
and quoting an arbitrary constant-product contract is a legitimate read.

## Caps

- `PONS_MAX_DEV_BUY_ETH` (default `0.05`) caps the opening dev buy per launch.
- `PONS_MAX_LAUNCHES_PER_DAY` (default `5`) caps launch broadcasts per rolling 24 h, tracked
  in memory (resets on restart — it is a blast-radius limiter, not an accounting system).
- Both are enforced **before broadcast** (the daily-cap slot is reserved before signing and
  released if the broadcast fails, so concurrent launches cannot race past it). Malformed cap
  values fail closed: startup aborts rather than running uncapped.

## The snipe-tax trap on dev buys

A launch's first 3 seconds carry a 99% decaying snipe tax. A dev buy sent as a separate
transaction from the launch lands after the launch is public and gets taxed to the floor — this
actually happened on-chain (a launch bought out by 22 addresses within two blocks). The factory
itself cannot help: `launchToken` requires `msg.value == launchFee()` exactly. `pons_launch_token`
therefore routes any `devBuyEth > 0` through the factory's trusted `launchForwarder`
(`launchAndBuy`), which launches and buys atomically and appends the buy recipient to the
snipe-tax exemption list in the same transaction. The forwarder address is read live from the
factory (it is owner-settable); because the dev buy sends real value to it, a drifted forwarder
**blocks broadcast** unless explicitly acknowledged with `acceptContractDrift: true` (see
"RPC trust").

## Irreversibility

- Launches burn a name/symbol per deployer: the CREATE2 salt derives from the metadata, so an
  identical relaunch reverts by design (and a different salt means a different token address).
- `renounceOwnership` via `pons_admin_call` additionally requires `iUnderstandIrreversible: true`.
  (On-chain, the factory disables renouncing entirely — it reverts
  `OwnershipCannotBeRenounced` — but the client-side guard stays regardless.)
- Snipe-tax exemptions are written at launch and can never be added afterwards.
- Creator fee-recipient changes come in two on-chain flows: the creator's self-service
  `transferCreatorFeeRecipient` applies **immediately** (no timelock), while the owner's
  `setCreatorFeeRecipient` creates a pending change timelocked 72 h with a 72 h execution window,
  publicly readable via `pons_pending_fee_change` throughout.

## Hot-wallet guidance

Use a dedicated wallet funded only with what you intend to spend on launches/trades. The key can
spend everything the wallet holds: launch fees, dev buys, curve trades, V4 swaps, and gas. Do not
reuse a wallet that holds anything else, and rotate it if it may have leaked. Unlimited
approvals are used in exactly one pattern — `approve(inputToken → Permit2, maxUint256)` before a
Permit2-mediated V4 swap (a token sell, or a buy on an ERC-20-quoted pool)
— which is how Permit2 is designed to work (per-trade grants are the 30-minute EIP-712
signatures); curve sells use exact-amount approvals with no standing grant.

## What the server cannot do

- **No custody beyond the hot key**: it cannot touch any address other than the configured
  signer.
- **No arbitrary calldata**: there is no generic "send this transaction" tool. Write tools build
  calldata only for the fixed Pons v2 surface (factory, curves, launchAndBuy router, Universal
  Router V4 commands). `pons_admin_call` is limited to a fixed enum of 17 owner functions with
  typed args.
- **No historical state**: the chain has no archive node and no tool accepts a block tag.
- **No silent failure modes**: selector mismatches crash at startup; reverts are never retried as
  if they were network errors; every `eth_getLogs` result is re-filtered client-side before use.

## Verification stance

The EIP-1559 signing output is byte-for-byte identical to viem for a fixed test vector; the
Permit2 EIP-712 signature was accepted by the on-chain contract in simulation; every write tool's
calldata was simulated against the live chain (with state overrides) including the full
PERMIT2_PERMIT + V4_SWAP sell path. No transaction was broadcast during development or testing.

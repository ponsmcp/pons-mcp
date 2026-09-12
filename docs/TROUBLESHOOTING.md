# Troubleshooting

All errors are structured: `{ "error": { "code": "…", "message": "…" } }`. Find your code below.

## Startup failures

### Server exits immediately with `CHAIN_MISMATCH` / "expected chainId 4663"

The RPC in `PONS_RPC_URL` is not Robinhood Chain mainnet. Fix the URL
(default `https://rpc.mainnet.chain.robinhood.com`) or unset the variable.

### Server exits with "ABI selector mismatch for …"

A computed keccak selector does not match its hardcoded constant. This should be impossible with
a clean install — it means corrupted source or a broken `@noble/hashes`. Reinstall dependencies;
if it persists, file a bug with the printed signature and both hex values.

### Server exits with "PONS_PRIVATE_KEY must be a 32-byte hex string (0x prefix optional)"

The env var is set but malformed (wrong length or non-hex). Fix or unset it.

## RPC failures

### `RPC_FAILURE` mentioning 429 / "Too Many Requests"

The public RPC rate-limits bursts. The client already retries with backoff across endpoints;
give it more endpoints: `PONS_RPC_URL="https://rpc.mainnet.chain.robinhood.com,https://<your-own>"`.
Large log scans (hundreds of thousands of blocks) are the usual trigger — lower
`lookbackBlocks`.

### `RPC_FAILURE` after "all 3 attempts failed"

All endpoints failed. Check connectivity; the retry policy only covers network/429/5xx errors.

### Tools hang or time out on old history

Robinhood Chain has ~10 blocks/s; the default 50k-block lookback is ~1.4 h and the hard cap is
500k (~14 h). The chain has **no archive node**: historical state queries (e.g. balances at old
blocks) fail outright, and no tool accepts a block tag. Use event scans (`pons_recent_launches`,
`pons_curve_trades`) for history.

## Read-tool errors

### `NOT_A_LAUNCH`

The address is not registered in the v2 factory's `getLaunchedToken` mapping. Causes: typo; the
token launched via the v1 factory; or the PONS token itself
(`0x39dBED…4571` predates the v2 factory; see the README smoke-test note).

### `INVALID_ADDRESS`

An address param failed the `^0x[0-9a-fA-F]{40}$` check. The message names the field.

### `pons_quote_swap` / `pons_swap`: "not graduated" / "no liquidity" / "ERC-20 pair token"

V4 tools only apply to phase-2 (PoolCreated) tokens on native ETH-quoted pools. Check the phase
with `pons_get_token`. ERC-20-quoted pools are unsupported (needs a WRAP/UNWRAP envelope — see
docs/PROTOCOL.md).

## Reverts seen in dry-run simulations (or broadcast)

A dry-run surfaces the contract's own revert before anything is sent. Common ones, decoded:

| Revert | Selector | Meaning / fix |
|---|---|---|
| `LaunchFeeNotPaid()` | `0x7e6d78a5` | `launchToken` requires `msg.value == launchFee()` exactly. The tool sets this for you; seeing it means a hand-built call overpaid/underpaid. |
| `NotFactory()` | `0x32cc7236` | The curve function is factory-internal (`exemptFromSnipeTax`, `rescueFees`, `setBuybackEnabled` on the curve). Use the factory path instead — the tools already do; `pons_exempt_snipe_tax` explains the launch-time-only exemption rule. |
| `OwnableUnauthorizedAccount(address)` | `0x118cdaa7` | Owner-only call from a non-owner (e.g. `pons_admin_call` with the wrong signer, or `cancelCreatorFeeRecipientChange` — owner-only despite the name). |
| `OwnershipCannotBeRenounced()` | `0x2fab92ca` | The factory permanently disables `renounceOwnership`. Nothing to fix; it cannot be done. |
| `TokenNotFound()` | `0xcbdb7b30` | `factory.rescueCurveFees` expects the **token** address, not the curve. (The tool resolves this for you.) |
| `SliceOutOfBounds()` | `0x3b99b53d` | Malformed Universal Router input. The stock V4 command path used by `pons_swap` is the verified-good one; the chain's V3 command is non-standard and never emitted. |
| Create2 collision (no data) | — | Relaunching identical name+symbol from the same wallet. The salt derives from the metadata by design; change name or symbol. |
| "insufficient funds for gas * price + value" | — | The RPC enforces sender balance on `eth_call`/`eth_estimateGas`. Dry-runs work anyway (state-diff overrides give the signer a nominal balance); a **broadcast** with this error means the wallet genuinely needs funding. |

## Write-tool errors

### `INVALID_PARAMS` on broadcast: "simulation reverted … refusing to broadcast"

The re-simulation before broadcast failed. The dry-run output's per-step `simulation.error`
tells you why. Nothing was sent.

### `CAP_EXCEEDED`

You hit `PONS_MAX_DEV_BUY_ETH` (default 0.05) or `PONS_MAX_LAUNCHES_PER_DAY` (default 5,
in-memory rolling 24 h — restarts reset it). Raise the env var deliberately, or wait.

### `pons_graduate`: "has not raised its graduation threshold yet"

The message includes live progress (raised vs threshold, %). Wait for more buys, or buy the
remaining gap yourself with `pons_buy`.

### `pons_execute_fee_recipient_change` reverts

Check `pons_pending_fee_change`: the change must be `executable` (past the 72 h timelock, inside
the 72 h window). `none` means no proposal exists; `expired` means propose again.

### Write tools missing from the tool list

`PONS_PRIVATE_KEY` is unset. Read-only mode registers 16 tools; write mode registers 29.

## Known unimplemented items

- feeEscrow `claim()` / `claimToken(token)` — claiming accrued creator/protocol fees.
- buybackVault `release(token)` — releasing vested buyback supply.
- V4 swaps on ERC-20-quoted pools.

All three are single-call additions against already-vendored ABIs; they were outside the
specified surface.

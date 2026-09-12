# scripts/live — live end-to-end testing

Drives the real MCP server (`dist/index.js`) over stdio against the live chain.
**These commands can spend real ETH.** Read this before running anything.

## Setup

1. Create a **brand-new dedicated wallet** (any EVM wallet → create account). Never reuse one
   that holds anything.
2. Fund it on Robinhood Chain. Suggested: **0.005 ETH** — covers a launch (0.0005 ETH fee + gas)
   and a few small trades with margin.
3. Export the key in your shell (never in a file, never as a CLI arg):

   ```sh
   export PONS_PRIVATE_KEY=0x<32-byte-hex>
   ```

4. Build first: `npm run build`.

## Commands

```sh
node scripts/live/run.mjs preflight
node scripts/live/run.mjs launch --name "Test Token" --symbol TST [--dev-buy 0.001]
node scripts/live/run.mjs buy [--amount 0.0002]
node scripts/live/run.mjs sell [--amount 50% | --all]
node scripts/live/run.mjs status
```

Every command runs a **dry-run first** and prints the full preview (simulation result, gas,
cost, calldata). Add `--confirm` to the same command to actually broadcast. Without `--confirm`
nothing is signed or sent.

`launch` saves the token/curve addresses to `scripts/live/state.json` (no secrets); `buy`,
`sell`, and `status` read from it.

## Suggested sequence

```sh
# 1. Sanity: chain, signer balance, launch permission, gas price
node scripts/live/run.mjs preflight

# 2. Preview a launch, inspect the preview, then broadcast
node scripts/live/run.mjs launch --name "Test Token" --symbol TST
node scripts/live/run.mjs launch --name "Test Token" --symbol TST --confirm

# 3. Preview + broadcast a small buy
node scripts/live/run.mjs buy --amount 0.0002
node scripts/live/run.mjs buy --amount 0.0002 --confirm

# 4. Check state and trades
node scripts/live/run.mjs status

# 5. Sell half, then the rest
node scripts/live/run.mjs sell --amount 50% --confirm
node scripts/live/run.mjs sell --all --confirm

# 6. Confirm the round-trip on the explorer
node scripts/live/run.mjs status
```

## Notes & gotchas

- **Name/symbol burn**: the CREATE2 salt derives from name+symbol — relaunching identical terms
  from the same wallet reverts. Bump the name (e.g. "Test Token 2") between runs.
- **Snipe tax**: the first 3 seconds after launch carry a 99% decaying tax. The scripted `buy`
  happens seconds later, so it should read 0% — `status` shows the live value.
- **Graduation** needs 4.2 ETH raised on the curve — out of scope for smoke funds; the V4 swap
  path (`pons_swap`) is better tested against an already-graduated token (see `npm run smoke`
  output for one).
- **Daily cap**: 5 launches per rolling 24 h by default (`PONS_MAX_LAUNCHES_PER_DAY`).
- If a broadcast hangs >30 s, the tool reports the hash — check the explorer before retrying
  (a retry queues behind the same nonce).
- Rate limits: the public RPC 429s under burst; the server retries automatically.

## Cleanup

`state.json` holds only public addresses/tx hashes — safe to keep or delete. The key lives only
in your shell env; `unset PONS_PRIVATE_KEY` when done.

# AGENTS.md

Guidance for AI agents (and humans) working in this repository. pons-mcp is an MCP server that
can **spend real money** when `PONS_PRIVATE_KEY` is set — treat every write-path change as
fund-critical.

## Commands

```sh
npm install
npm run build    # tsc → dist/ (must be clean)
npm test         # offline suite (node:test via tsx) — no network, no key needed
npm run smoke    # live-chain smoke test; needs network, no key needed
npm start        # run the server (stdio)
```

Before finishing any change: `npm run build && npm test` must pass. If the change touches
chain-facing decoding or write paths, also run `npm run smoke`. Never commit with failing tests.

## Non-negotiable invariants

These are deliberate design constraints, not style preferences. Do not "fix" them away:

1. **No web3 framework.** Raw JSON-RPC over `fetch` only. Do not add viem/ethers/web3 — a past
   viem version silently dropped topic filters; raw RPC + client-side re-filtering is the
   verified-safe pattern (see `docs/ARCHITECTURE.md`).
2. **BigInt everywhere.** Quantities are BigInt internally; decimal formatting happens only at
   the output boundary via `src/format.ts`. Never `Number()` a wei amount.
3. **Selectors/topics are computed and asserted.** Every entry in `SEL`/`TOPIC` (`src/abi.ts`)
   is recomputed from its canonical signature at startup via keccak-256 (`@noble/hashes` — Node's
   `sha3-256` is NOT keccak) and asserted against the constant. Add new entries the same way.
4. **No archive node.** All reads at `"latest"`. Never add a block-tag parameter.
5. **Every `eth_getLogs` result is re-filtered client-side** (address + each supplied topic
   position). Do not remove this.
6. **Retry policy:** only network failures / HTTP 429 / 5xx retry (3 attempts, endpoint failover,
   backoff). Reverts and permanent RPC errors fail immediately. Non-revert -32000 (insufficient
   funds, nonce too low) is `RPC_FAILURE`, not `REVERTED`.
7. **Error messages must never contain the raw RPC URL** (it may carry API keys) — use the
   sanitized form in `src/rpc.ts`.
8. **Write gating is sacred.** Nothing broadcasts unless the caller passes `dryRun=false` AND
   `confirm=true` (strict zod booleans). Dry-runs must never create signatures. Caps
   (`PONS_MAX_DEV_BUY_ETH`, `PONS_MAX_LAUNCHES_PER_DAY`) fail closed.
9. **Value destinations are pinned or verified.** Factory/router/Permit2 addresses are constants;
   live-read addresses (`launchForwarder`, `memeHook`) are pinned with drift gates
   (`acceptContractDrift`). Buy/sell require the factory-registered curve (`ctx.registered`).
10. **The key never appears in any output, log, or error.** Only the derived address.

## Layout

```
src/
  index.ts    entry: chain assert, signer load, tool registration, MCP resources + prompts
  rpc.ts      JSON-RPC client: failover, retry policy, error classes, log re-filtering, scanLogs
  abi.ts      SEL/TOPIC constants (computed+asserted), encode/decode helpers
  format.ts   BigInt ↔ decimal-string units; ParseUnitsError (→ INVALID_PARAMS)
  pons.ts     chain constants, read tools, factory/curve/event decoders
  quote.ts    bonding-curve math (verified against PonsV2BondingCurve source)
  trade.ts    curve context, quote tools, slot discovery, runWrite runner, buy/sell/graduate/…
  payouts.ts  fee-escrow claims + buyback-vault release (verified against satellite sources)
  v1.ts       V1 legacy launchpad reads (Uniswap V3 generation; verified vs Mobula guide + chain)
  launch.ts   pons_launch_token: TokenParams encoding, opening-buy quote, caps, drift gate
  v4.ts       V4 quoter/pool state (native + ERC-20-quoted pools), UniversalRouter encoding,
              Permit2 EIP-712 (sign on broadcast only)
  admin.ts    pons_admin_call: owner fn enum + per-fn arg validation
  signer.ts   key loading (env only, never logged)
  tx.ts       RLP + EIP-1559 sign/broadcast; tx-hash verification; receipt polling
  tools.ts    zod schemas + handlers + error mapping
test/         offline node:test suite (mocked RPC; see test/helpers.ts)
scripts/smoke.mjs  live-chain decode-contract checks
```

## Testing rules

- Add tests for every behavior change. The suite is **offline**: mock `RpcClient`
  (`test/helpers.ts` `mockClient`) or `globalThis.fetch` — never hit the network from tests.
- For signing code, assert by **recovering the signer address** from the output, not by
  comparing against self-generated hex.
- For encoded calldata, decode it structurally (`wordAt`/`stringAt` in `test/helpers.ts`) and
  assert field-by-field.
- Reproduce the bug in a failing test first when fixing one (see the `*regression*` tests).

## Ground truth

When contract behavior is in question, the chain wins over docs — and verified source wins over
memory. The factory (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) and launchAndBuy router are
Sourcify exact-matches on chain 4663:

```
https://sourcify.dev/server/repository/contracts/full_match/4663/<address>/metadata.json
```

`docs/PROTOCOL.md` records verified quirks (e.g. `renounceOwnership` always reverts, creator
fee-recipient transfer is immediate while the owner override is timelocked, sweepFees' argument
is a buyback min-output floor). Keep it updated when new quirks are confirmed.

## Doc sync

Behavior changes must be reflected in the same commit in: `docs/TOOLS.md` (per-tool reference),
`docs/SECURITY.md` (if the threat model or gating is involved), `README.md` (tool tables), and
`docs/PROTOCOL.md` notes where this server intentionally diverges from the Pons docs. Tool descriptions in `src/tools.ts` are
safety-critical text — an MCP client reasons from them — keep them accurate.

## Never do

- Never log, print, return, or commit private keys; never accept a key as a tool parameter.
- Never add a code path that signs or broadcasts without the dryRun/confirm gate.
- Never loosen the address/amount validation to "make a test pass".
- Never broadcast during development or testing; `PONS_PRIVATE_KEY=0x…01` (the well-known
  test key 1, address 0x7e5f…5bdf) is the only key tests and dry-run checks may use.

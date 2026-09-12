# pons-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for the **Pons launchpad** on
**Robinhood Chain** (chainId 4663) — full 1:1 parity with the Pons v2 contracts, driven entirely
from live chain state.

- **20 read tools** — protocol parameters, launch configs, token/curve state, event scans
  (launches, graduations, creator history, curve trades), exact curve buy/sell quotes cross-checked
  against the chain, V4 pool quotes for graduated tokens (native- and ERC-20-quoted), supply/burn
  stats, claimable fee balances and buyback vesting, pending fee-recipient changes, **V1
  (legacy) launchpad reads**, plus on-chain “interesting launch” scoring
  (`pons_scan_interesting`).
- **15 write tools** (opt-in) — launch, curve buy/sell, graduation, creator fee-recipient
  transfer + owner timelock flow, curve controls, fee-escrow claims, buyback-vault release,
  factory admin surface, Uniswap V4 swaps. Every write tool **dry-runs by default** and only
  broadcasts when explicitly confirmed.
- **3 MCP resources + 3 prompts** — live protocol/token state as readable resources
  (`pons://protocol/overview`, `pons://launches/recent`, `pons://token/{address}`) and guided
  workflows (`launch-a-token`, `analyze-token`, `safe-trade`).

**Read-only by default.** With no key configured the server performs `eth_call`, `eth_getLogs`,
`eth_blockNumber`, `eth_chainId`, and `eth_gasPrice` only — no keys, no
transactions, no code path that can spend funds. All reads are at the `latest` block (Robinhood
Chain has no archive node).

No web3 framework anywhere: raw JSON-RPC over `fetch`, hand-rolled ABI codec and RLP, BigInt
throughout, secp256k1 via `@noble/curves`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
why.

## Hosted server (no install)

A read-only instance runs at **https://mcp.ponsmcp.ai/mcp** (Streamable HTTP, stateless, no auth). It exposes the 20 read
tools, 3 resources and 3 prompts; the write tools do not exist on it by construction, so nothing there can sign or send.

```sh
claude mcp add --transport http pons https://mcp.ponsmcp.ai/mcp
```

Any client that takes a remote MCP URL (Claude Desktop connectors, Cursor, Windsurf, VS Code, ChatGPT) works the same way.
Rate limit: 60 requests per minute per IP. For write mode, run the server locally with `PONS_PRIVATE_KEY`, see below.
Site and docs: **https://ponsmcp.ai**.

To host your own: `npm run build && npm run start:http` (env `PORT`, `PONS_RPC_URL`, `PONS_HTTP_RATE_LIMIT`,
`PONS_HTTP_PUBLIC_URL`), or build the included `Dockerfile`.

## Quickstart

```sh
npm install
npm run build      # tsc → dist/
npm test           # 163 offline tests: ABI codec, curve math, RLP/signing, RPC policy, write gating
npm run smoke      # live-chain smoke test (chainId, factory params, log re-filtering)
npm start          # node dist/index.js (stdio MCP server)
npm run start:http # hosted read-only Streamable HTTP server on $PORT (dist/serve.js)
```

Node ≥ 20. The server asserts `eth_chainId == 4663` at startup and exits if the RPC points at
another chain.

The test suite (`npm test`) is fully offline — it covers the ABI codec, curve math (including the
clamped-fill price bound), EIP-1559/Permit2 signing with address recovery, RPC retry and
sanitization policy, log re-filtering and scan chunking, and the write-gating invariants (nothing
broadcasts without `dryRun=false` + `confirm=true`, drift gates, caps, fake-curve rejection).
The smoke test (`npm run smoke`) then verifies the decode contract against the live chain.

## MCP client configuration

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pons": {
      "command": "node",
      "args": ["/absolute/path/to/pons-mcp/dist/index.js"],
      "env": {
        "PONS_RPC_URL": "https://rpc.mainnet.chain.robinhood.com"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add pons -- node /absolute/path/to/pons-mcp/dist/index.js
# with write mode:
claude mcp add pons --env PONS_PRIVATE_KEY=0x<32-byte-hex> -- node /absolute/path/to/pons-mcp/dist/index.js
```

Any stdio-capable MCP client can launch it the same way (`node dist/index.js`), or via the
installed bin: `pons-mcp`.

## Tools

### Read tools (always registered)

| Tool | What it returns |
|---|---|
| `pons_protocol_overview` | Chain id, latest block, launch fee/enabled, tax caps, snipe-tax parameters, every launch config decoded, governance timelocks, all contract addresses |
| `pons_get_token` | Full state of one launched token: factory record, ERC-20 metadata, 26 curve views (reserves, graduation progress, snipe tax, fees, balances). `NOT_A_LAUNCH` if unknown to the factory |
| `pons_preview_launch` | What a launch with a given config/pair token would do: config, economics digest, pair-token economics |
| `pons_quote_buy` / `pons_quote_sell` | Exact bonding-curve quote (fee, creator tax, snipe tax, price impact, clamping) computed locally **and cross-checked on-chain** via `eth_call` with state overrides |
| `pons_can_launch` | Whether an address may launch (whitelist + global flag) |
| `pons_pair_token_economics` | Approval status and economics (phantom quote, threshold, decimals) of a pair token |
| `pons_recent_launches` | `TokenLaunched` scan, newest first; optional deployer/pairToken filters |
| `pons_scan_interesting` | Score recent launches for traction (unique buyers, ETH in, age); no LLM, no spend |
| `pons_recent_graduations` | `PoolGraduated` scan: token, position id, seeded amounts |
| `pons_creator_launches` | All launches by one creator, with graduated status per token |
| `pons_curve_trades` | `CurveBuy`/`CurveSell` on one curve, merged newest-first (buy `spent` is post-refund; buy `fee` includes snipe tax) |
| `pons_snipe_tax` | Live decaying snipe tax for a recipient, exemption status, seconds since launch, window status (window read from the curve's frozen value) |
| `pons_pending_fee_change` | Pending **owner-initiated** creator-fee-recipient change with effective/expires timestamps and window status |
| `pons_token_supply` | Total supply and burned balance/% (defaults to the PONS token) |
| `pons_v1_get_token` / `pons_v1_launches` | V1 (legacy, Uniswap V3 generation) launchpad: token record + graduation status + metadata, and historical launch scans (absolute block ranges supported) |
| `pons_fee_balances` | Claimable fees in the shared fee escrow (ETH + per-token) and buyback-vault vesting state for a token |
| `pons_launch_costs` | Measured gas/cost constants (labelled, 2026-09) plus live `eth_gasPrice` |
| `pons_quote_swap` | On-chain V4 quoter price for a graduated token's pool (native- and ERC-20-quoted) |

### Write tools (registered only when `PONS_PRIVATE_KEY` is set)

| Tool | What it does |
|---|---|
| `pons_launch_token` | Launch via factory (or atomic launch + dev buy via the forwarder). Enforces metadata limits, economics pinning, dev-buy and per-day caps |
| `pons_buy` / `pons_sell` | Trade a live bonding curve; exact-amount ERC-20 approvals bundled automatically when needed |
| `pons_graduate` | Permissionless graduation: drain the curve, then seed the V4 pool (phase-aware) |
| `pons_set_creator_fee_recipient` | Transfer the creator fee recipient — **immediate on broadcast, no timelock** (creator-gated) |
| `pons_execute_fee_recipient_change` / `pons_cancel_fee_recipient_change` | Execute / cancel a pending **owner-initiated** fee-recipient change |
| `pons_set_buyback` | Toggle buyback for a token (creator/owner-gated, via factory) |
| `pons_sweep_curve_fees` / `pons_rescue_curve_fees` | Sweep **all** accrued curve fees (arg is the buyback min-output floor) / rescue stuck fees (owner-gated) |
| `pons_claim_fees` | Claim accrued fees from the shared fee escrow — native ETH or any ERC-20, full or partial amount |
| `pons_release_buyback` | Release the vested slice of a launch's 5-year buyback lock into the escrow (creator/protocol recipient only) |
| `pons_exempt_snipe_tax` | Always errors with an explanation — post-launch exemptions are impossible by construction; set them at launch |
| `pons_swap` | Uniswap V4 swap via UniversalRouter: native buy = V4_SWAP with ETH value; any token input = Permit2 EIP-712 permit + V4_SWAP (ERC-20-quoted pools supported) |
| `pons_admin_call` | Factory owner surface (fees, configs, whitelist, executors, ownership). `renounceOwnership` requires `iUnderstandIrreversible` (and reverts on-chain regardless) |

## Write mode

> **Warning:** use a dedicated hot wallet funded only with what you intend to spend. The key in
> `PONS_PRIVATE_KEY` can spend everything that wallet holds. Never reuse a wallet that stores
> anything else.

Setting `PONS_PRIVATE_KEY` (32-byte hex, 0x prefix optional) registers the 15 write tools. Only the
derived signer address is ever logged (stderr). Every write tool follows the same discipline:

1. **Dry-run** (default): every step is simulated via `eth_call` — with state-diff overrides where
   the node enforces balances, so unfunded dry-runs still exercise contract logic — plus gas
   estimation, full cost preview, and the exact calldata. **Nothing is broadcast.**
2. **Broadcast**: re-call with `dryRun=false, confirm=true`. The server re-simulates, refuses if
   any step reverts, then signs (EIP-1559, hand-rolled RLP + secp256k1, byte-for-byte verified
   against viem) and broadcasts, waiting for each receipt. Multi-step flows
   (approve → sell, graduate → createGraduatedPool, approve → PERMIT2_PERMIT+V4_SWAP) are sent
   sequentially, each waiting for the prior receipt.

Additional safeguards: `pons_buy`/`pons_sell` only accept the factory-registered curve for a
token; RPC-read contract addresses used as value destinations (`launchForwarder`, `memeHook`)
are pinned and drift blocks broadcast unless acknowledged with `acceptContractDrift`; broadcast
tx hashes are verified against the locally computed hash of the signed payload; and dry-runs
never create signatures (the Permit2 permit in a swap sell is signed only at broadcast time).

Safety caps (fail closed — a malformed value stops startup, not the cap):

- `PONS_MAX_DEV_BUY_ETH` (default `"0.05"`) — hard cap on a launch's opening buy.
- `PONS_MAX_LAUNCHES_PER_DAY` (default `5`) — hard cap on launch broadcasts per rolling 24 h.

Details and per-tool mechanics: [docs/TOOLS.md](docs/TOOLS.md). Threat model:
[docs/SECURITY.md](docs/SECURITY.md).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PONS_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | RPC endpoint; comma-separated list = failover across endpoints |
| `PONS_PRIVATE_KEY` | unset | **Opt-in write mode.** 32-byte hex (0x optional). Unset → read-only, no write tools registered. Only the derived address is logged (stderr) at startup |
| `PONS_MAX_DEV_BUY_ETH` | `"0.05"` | Hard cap on the `devBuyEth` opening buy per launch |
| `PONS_MAX_LAUNCHES_PER_DAY` | `5` | Hard cap on launch broadcasts per rolling 24h (in-memory) |
| `PONS_SCAN_*` | see docs/TOOLS.md | Optional gate tuning for `pons_scan_interesting` (min unique buyers, min ETH in, age window, serial-deployer cap) |

## Errors

Every tool returns JSON. Failures are structured:

```json
{ "error": { "code": "NOT_A_LAUNCH", "message": "…" } }
```

| Code | Meaning |
|---|---|
| `INVALID_ADDRESS` | Malformed address parameter |
| `INVALID_PARAMS` | Bad input (amounts, flags), or a state precondition failed (curve graduated, threshold not met, …) |
| `NOT_A_LAUNCH` | Address is not a Pons-launched token/curve |
| `CAP_EXCEEDED` | `PONS_MAX_DEV_BUY_ETH` or `PONS_MAX_LAUNCHES_PER_DAY` hit |
| `CHAIN_MISMATCH` | The RPC is not serving chainId 4663 |
| `REVERTED` | The contract reverted (simulation or mined transaction) |
| `RPC_FAILURE` | Transport/node failure after retries, or a permanent non-revert RPC error (message preserved) |

## Design notes

- ~0.1 s blocks (~10 blocks/s): 500k blocks ≈ 14 h. Log scans are block-count based (10k-block
  chunks, newest chunk first, **client-side re-filtered** — node topic filters are never trusted).
- Retry policy: only network failures and HTTP 429/5xx retry (3 attempts, backoff, endpoint
  failover). Permanent errors — reverts included — fail immediately with their real message.
- All quantities are BigInt internally and formatted with unit labels (`"0.0005 ETH"`) only at the
  output boundary. Pair tokens can be 6-decimal (e.g. USDG) — per-token `decimals()` is always used.
- ABI selectors and event topics are computed from canonical signatures via keccak-256
  (`@noble/hashes`) at startup and asserted against hardcoded constants; a mismatch crashes the
  server rather than serving stale calldata.
- The contract assumptions are verified against ground truth: the factory and launchAndBuy router
  are Sourcify exact-matches on chain 4663, and every selector, tuple layout, event layout, and
  curve-math rule in this repo was cross-checked against that verified source.

## Documentation

| Doc | Contents |
|---|---|
| [docs/TOOLS.md](docs/TOOLS.md) | Full reference for all tools: params, outputs, errors, examples with real chain values |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, raw-JSON-RPC decision, selector assertions, simulation design, signing pipeline |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, key custody, gating, caps, hot-wallet guidance |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Pons v2 as this server understands it: addresses, function↔tool map, event/tuple layouts, chain-vs-docs divergences |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common failures and fixes (CHAIN_MISMATCH, 429s, revert decodings, …) |

## Smoke-test note: the PONS token

An obvious smoke check would use the PONS token (`0x39dBED…4571`) for the
`getLaunchedToken` assertion (`exists == true`, `phase == 2`). Live chain state
contradicts this: the v2 factory has **no record** of that token
(`getLaunchedToken` → `exists=false`, and zero `TokenLaunched`/`PoolGraduated`
events mention it across full chain history — it was presumably launched via an
earlier factory). Following the "chain wins" rule, the smoke test
probes the PONS address as a printed NOTE, and asserts the decode contract
against a real graduated token taken from an actual `PoolGraduated` log (phase 2
PoolCreated, or 3 Rescued). The PONS address remains the default for
`pons_token_supply`, which works (ERC-20 reads only).

Contracts: factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, launchAndBuy router
`0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`, Uniswap v4 PoolManager
`0x8366a39cc670b4001a1121b8f6a443a643e40951`. Explorer:
<https://robinhoodchain.blockscout.com>.

## License

MIT

# Architecture

pons-mcp is a stdio MCP server over raw JSON-RPC. No web3 framework is used anywhere: ABI
encoding/decoding, keccak selectors, RLP, and EIP-1559/EIP-712 signing are all hand-rolled on
BigInt, with `@noble/hashes` (keccak-256) and `@noble/curves` (secp256k1) as the only crypto
dependencies. Runtime deps: `@modelcontextprotocol/sdk`, `zod` (v3), `@noble/hashes`,
`@noble/curves`.

## Module map

| file | role |
|---|---|
| `src/index.ts` | Entry point. Builds the RPC client, asserts chainId 4663, loads the optional signer, registers tool definitions on `McpServer`, connects `StdioServerTransport`. Logs only to stderr (stdout is the MCP channel). |
| `src/abi.ts` | The ABI codec and the trust anchor. Every function selector and event topic is **computed from its canonical signature via keccak-256 at module load and asserted against a hardcoded constant**; a mismatch throws before the server starts. Hand-rolled encode helpers (address, uint256, bool, bytes32, string, bytes) and decode helpers (words, int24 sign-extension, ABI strings). |
| `src/rpc.ts` | JSON-RPC client: endpoint failover (`PONS_RPC_URL` comma list), retry policy, error classification, mandatory client-side re-filtering of `eth_getLogs`, chunked newest-first log scanning. |
| `src/format.ts` | BigInt ↔ decimal-string formatting at the output boundary (`formatUnits`, `formatEth`, `formatBps`, `parseUnits`, percent). |
| `src/pons.ts` | Chain/contract constants, `PonsError` codes, the factory/curve read wrappers behind the read tools (launch configs, the 15-word `getLaunchedToken` struct, the 26-view curve dump, event scans). |
| `src/quote.ts` | Exact port of the bonding-curve pricing math (`PonsV2BondingCurveMath` + the fee ordering of `buy`/`sell`, transcribed via ponscli): `quoteBuy` with snipe-tax bounding and reserved-allocation clamp, `quoteSell`, price impact, slippage floors. Integer arithmetic matches the contract's truncation. |
| `src/trade.ts` | Curve read context, the quote tools' on-chain cross-checks, the shared write runner (`runWrite`: simulate with state overrides → dry-run preview or sequential broadcast), ERC-20 storage-slot discovery, and the curve/lifecycle write tools. |
| `src/launch.ts` | `pons_launch_token`: TokenParams dynamic-tuple encoding, ponscli-identical salt derivation, opening-buy quote, caps, dry-run/broadcast. |
| `src/admin.ts` | `pons_admin_call`: the 17 factory owner functions with typed arg builders. |
| `src/v4.ts` | Uniswap V4 path: pool key sorting/poolId, V4Quoter/StateView reads, Universal Router command encoding (stock V4 commands only), Permit2 EIP-712 PermitSingle signing. |
| `src/signer.ts` | Loads `PONS_PRIVATE_KEY` (the only key source), derives the address. Returns `null` when unset → read-only mode. |
| `src/tx.ts` | RLP encoding, EIP-1559 (type 0x02) build/sign, fee-market resolution, nonce via `eth_getTransactionCount(pending)`, gas via `eth_estimateGas` × 1.2, broadcast + receipt polling. |
| `src/tools.ts` | Zod input schemas, address validation, handler wrapping into MCP results with structured errors, conditional write-tool registration. |
| `src/scan.ts` | On-chain traction scoring behind `pons_scan_interesting`: unique buyers, ETH in, buy/sell mix, age, serial-deployer gate. No LLM, no spend. |
| `scripts/smoke.mjs` | Five live-RPC checks (chainId, launchFee, snipeTaxSeconds, getLaunchedToken decode, 5k-block scan with re-filtering). |

## Why no web3 framework

Two reasons, both learned from published forensics on this chain:

1. **viem 2.56.3 silently dropped topic filters** in log fetching on this chain. The
   verified-safe pattern is raw JSON-RPC plus **mandatory client-side re-filtering**: every
   returned log is asserted against the requested address and every supplied topic position, and
   non-matches are dropped (`RpcClient.reFilter`).
2. Correctness must be provable. Every selector/topic is recomputed at startup and asserted;
   every transaction encoding used by write tools was verified **byte-for-byte against viem** in
   development (and the EIP-1559 signature round-trips through independent address recovery).

## Error classification and retry policy

`RpcClient.call` classifies failures (`src/rpc.ts`):

- **Permanent**: JSON-RPC errors that are deterministic — code 3, or any message matching
  `revert` — become `REVERTED` and are never retried. Other JSON-RPC errors (a bare -32000 such
  as "insufficient funds" or "nonce too low", -32601/-32602, …) become `RPC_FAILURE`, also never
  retried, with the original message preserved.
- **Retryable**: network failures, HTTP 429, HTTP 5xx → rotate to the next endpoint, exponential
  backoff (250 ms × 2ⁿ), max 3 attempts, then `RPC_FAILURE`. Endpoint URLs are sanitized in all
  error messages (origin + masked path, no query string or credentials).

## Log scanning

Robinhood Chain has ~0.1 s blocks (~10 blocks/s), so lookbacks are block-count based: default
50,000 blocks (~1.4 h), hard cap 500,000 (~14 h), chunked at 10,000 blocks per `eth_getLogs`.
Chunks are iterated **newest-first** so a `limit` short-circuits early, and results are sorted by
(block desc, logIndex desc).

## State-override simulation

The public RPC enforces sender balance on `eth_call`/`eth_estimateGas`. Dry-runs would be useless
with an unfunded wallet, so `runWrite` (`src/trade.ts`) simulates every step with a state-diff
override granting the signer a balance of at least 1000 ETH (more when a step carries a larger
value). For ERC-20-gated paths (sells, Permit2 pulls), the token's `balanceOf`/`allowance`
**storage slots are discovered at runtime** by probing slots 0–11 with a marker value and
watching the view calls move (cached per token+holder+spender, since mapping slots are keyed by
all three); those slots are then overridden in simulation. The Permit2 allowance for a swap-sell
dry-run is granted the same way (packed `amount | expiration | nonce` word, slots probed 0–5), so
no signature is created outside a broadcast. This makes dry-runs exercise the real contract
logic end-to-end while broadcasting remains impossible without `dryRun=false` + `confirm=true`.

The same trick verified every write path during development without a single real transaction.

## Signing pipeline (`src/tx.ts`, `src/signer.ts`)

- Key: `PONS_PRIVATE_KEY` only; address derived via secp256k1 → keccak. The key is never logged.
- Transaction: EIP-1559 type 0x02, RLP hand-rolled. Fees from `eth_feeHistory` (baseFee×2 +
  50th-percentile priority), falling back to `eth_gasPrice` × 2. Nonce from
  `eth_getTransactionCount` with the `pending` tag. Gas = `eth_estimateGas` × 1.2.
- Signing: `@noble/curves` v2 `secp256k1.sign(digest, key, { prehash: false, format: "recovered",
  lowS: true })`. **`prehash: false` is load-bearing** — noble v2 hashes the message internally by
  default, and the input here is already the keccak-256 digest of the RLP payload. `lowS: true`
  keeps signatures non-malleable; `yParity` comes from the recovery id.
- Broadcast: `eth_sendRawTransaction`, then `eth_getTransactionReceipt` polled every 500 ms for
  up to 30 s (~0.1 s blocks make this generous). A status-0 receipt becomes a structured
  `REVERTED` error.
- Permit2 signatures (V4 sells) are EIP-712 `PermitSingle` over the domain
  `(name "Permit2", chainId 4663, verifyingContract Permit2)` — no version field, matching
  Permit2's own `EIP712` base. Verified against the contract's `DOMAIN_SEPARATOR()` and a live
  `permit2.permit` simulation.

## Chain constraints that shaped the design

- **No archive node**: every read uses block tag `"latest"`; no tool accepts a block tag.
  Historical state (`eth_getBalance` at old blocks) fails on this chain.
- **~0.1 s blocks**: drives the block-count lookbacks, the 500 ms receipt poll, and the modest
  default lookbacks (50k blocks ≈ 1.4 h).
- **Rate limits**: the public RPC answers 429 under burst; hence endpoint failover, backoff, and
  parallel-call discipline.
- **Owner-settable satellites**: the factory's `launchForwarder`, `launchDeployer`, etc. are
  read live rather than trusted from constants (the launch tool flags `forwarderDrifted` if the
  live forwarder differs from the known router).

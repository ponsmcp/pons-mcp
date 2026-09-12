import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortedPoolKey,
  poolId,
  encodeExactInSingle,
  encodeV4SwapCommand,
  encodeExecute,
  encodePermitInput,
  permitDigest,
  signPermit,
  quoteV4ExactIn,
  PERMIT2,
  UNIVERSAL_ROUTER,
  type PermitSingle,
} from "../src/v4.js";
import { MEME_HOOK } from "../src/pons.js";
import { loadSigner } from "../src/signer.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex, wordAt, wordUint, addrOf } from "./helpers.js";
import type { RpcClient } from "../src/rpc.js";

const TOKEN = "0x05b8d77419042d8c693b56edc5332db5b5d0acaa";
const ZERO = "0x0000000000000000000000000000000000000000";
const key = sortedPoolKey(TOKEN, ZERO, 0n, 200n, MEME_HOOK);

test("sortedPoolKey orders and lowercases", () => {
  assert.equal(key.currency0, ZERO); // 0x00… < 0x05…
  assert.equal(key.currency1, TOKEN.toLowerCase());
  assert.equal(key.hooks, MEME_HOOK);
});

test("poolId = keccak256 of the ABI-encoded PoolKey", () => {
  const id = poolId(key);
  assert.equal(id.length, 64);
  assert.equal(id, poolId(key)); // deterministic
  const other = sortedPoolKey(TOKEN, ZERO, 0n, 60n, MEME_HOOK);
  assert.notEqual(poolId(other), id);
});

test("encodeExactInSingle structure: offset, pool key, direction, amounts, empty hookData", () => {
  const blob = hex(encodeExactInSingle(key, true, 10n ** 18n, 95n * 10n ** 16n));
  assert.equal(wordUint(blob, 0), 32n, "tuple offset");
  assert.equal(addrOf(wordAt(blob, 1)), ZERO);
  assert.equal(addrOf(wordAt(blob, 2)), TOKEN.toLowerCase());
  assert.equal(wordUint(blob, 3), 0n); // fee
  assert.equal(wordUint(blob, 4), 200n); // tickSpacing
  assert.equal(addrOf(wordAt(blob, 5)), MEME_HOOK);
  assert.equal(wordUint(blob, 6), 1n, "zeroForOne");
  assert.equal(wordUint(blob, 7), 10n ** 18n, "amountIn");
  assert.equal(wordUint(blob, 8), 95n * 10n ** 16n, "amountOutMinimum");
  assert.equal(wordUint(blob, 9), 9n * 32n, "hookData offset");
  assert.equal(wordUint(blob, 10), 0n, "empty hookData length");
});

test("encodeV4SwapCommand packs actions and params with correct offsets", () => {
  const p0 = encodeExactInSingle(key, true, 10n ** 18n, 0n);
  const blob = hex(encodeV4SwapCommand([0x06, 0x0b, 0x0e], [p0, "0x" + "11".repeat(96), "0x" + "22".repeat(96)]));
  assert.equal(wordUint(blob, 0), 64n, "actions offset");
  const paramsOffset = Number(wordUint(blob, 1));
  // actions blob at byte 64: length 3, data 060b0e
  assert.equal(wordUint(blob, 2), 3n);
  assert.equal(wordAt(blob, 3).startsWith("060b0e"), true);
  assert.equal(paramsOffset, 64 + 64, "params right after the 2-word actions blob (padded)");
  // params array: length 3, then 3 offsets
  const base = paramsOffset * 2;
  assert.equal(wordUint(blob, paramsOffset / 32), 3n);
  const e0 = Number(BigInt("0x" + blob.slice(base + 64, base + 128)));
  const e1 = Number(BigInt("0x" + blob.slice(base + 128, base + 192)));
  assert.ok(e0 < e1, "increasing element offsets");
});

test("encodeExecute: selector, commands/inputs offsets, deadline", () => {
  const input = encodeV4SwapCommand([0x06], ["0x" + "11".repeat(96)]);
  const blob = hex(encodeExecute([0x10], [input], 1234567890n));
  assert.ok(blob.startsWith("3593564c"), "execute(bytes,bytes[],uint256) selector");
  const body = blob.slice(8);
  assert.equal(wordUint(body, 0), 96n, "commands offset (3-word head)");
  assert.equal(wordUint(body, 2), 1234567890n, "deadline");
  // commands blob: length 1, byte 0x10
  assert.equal(wordUint(body, 3), 1n);
  assert.ok(wordAt(body, 4).startsWith("10"));
});

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const ADDR1 = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

const permit: PermitSingle = {
  details: { token: TOKEN, amount: 10n ** 20n, expiration: 1_800_000_000, nonce: 3 },
  spender: UNIVERSAL_ROUTER,
  sigDeadline: 1_800_000_300n,
};

test("permitDigest: deterministic 32 bytes, domain-binds chainId", () => {
  const d = permitDigest(permit, 4663);
  assert.equal(d.length, 32);
  assert.deepEqual(permitDigest(permit, 4663), d);
  assert.notDeepEqual(permitDigest(permit, 1), d, "different chainId → different digest");
});

test("signPermit: 65-byte sig with v=27/28, recovers the signer, low-S", () => {
  const sig = signPermit(signer, permit, 4663);
  const raw = hex(sig);
  assert.equal(raw.length, 130);
  const r = BigInt("0x" + raw.slice(0, 64));
  const s = BigInt("0x" + raw.slice(64, 128));
  const v = Number("0x" + raw.slice(128));
  assert.ok(v === 27 || v === 28);
  assert.ok(s <= BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"), "low-S");
  const rec = new secp256k1.Signature(r, s, v - 27).recoverPublicKey(permitDigest(permit, 4663));
  const addr = "0x" + Buffer.from(keccak_256(rec.toBytes(false).subarray(1)).subarray(12)).toString("hex");
  assert.equal(addr, ADDR1);
});

test("encodePermitInput: 7-word head then signature tail", () => {
  const sig = signPermit(signer, permit, 4663);
  const blob = hex(encodePermitInput(permit, sig));
  assert.equal(addrOf(wordAt(blob, 0)), TOKEN.toLowerCase());
  assert.equal(wordUint(blob, 1), permit.details.amount);
  assert.equal(wordUint(blob, 2), BigInt(permit.details.expiration));
  assert.equal(wordUint(blob, 3), BigInt(permit.details.nonce));
  assert.equal(addrOf(wordAt(blob, 4)), UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(wordUint(blob, 5), permit.sigDeadline);
  assert.equal(wordUint(blob, 6), 7n * 32n, "signature offset");
  assert.equal(wordUint(blob, 7), 65n, "65-byte signature");
});

test("quoteV4ExactIn rejects amounts over uint128 before touching the network", async () => {
  const bomb = { async call() { throw new Error("network must not be touched"); } };
  await assert.rejects(
    quoteV4ExactIn(bomb as unknown as RpcClient, key, true, (1n << 128n), ADDR1),
    /uint128/,
  );
  await assert.rejects(
    quoteV4ExactIn(bomb as unknown as RpcClient, key, true, -1n, ADDR1),
    /uint128/,
  );
});

test("PERMIT2 is the canonical deployment", () => {
  assert.equal(PERMIT2, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
});

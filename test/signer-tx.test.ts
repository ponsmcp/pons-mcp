import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { loadSigner } from "../src/signer.js";
import { signEip1559, type PreparedTx } from "../src/tx.js";
import { rlpDecode, rlpBigInt, type RlpNode } from "./helpers.js";

export const KEY1 = "0x" + "0".repeat(63) + "1";
export const ADDR1 = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

function recoverSigner(tx: PreparedTx, signedHex: string): string {
  const raw = Buffer.from(signedHex.replace(/^0x/, ""), "hex");
  assert.equal(raw[0], 0x02, "EIP-1559 type byte");
  const { node } = rlpDecode(raw.subarray(1));
  assert.equal(node.kind, "list");
  const fields = node.items!;
  assert.equal(fields.length, 12, "9 unsigned fields + yParity,r,s");
  // Field order: chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, accessList
  assert.equal(rlpBigInt(fields[1]), tx.nonce);
  assert.equal(rlpBigInt(fields[2]), tx.maxPriorityFeePerGas);
  assert.equal(rlpBigInt(fields[3]), tx.maxFeePerGas);
  assert.equal(rlpBigInt(fields[4]), tx.gasLimit);
  assert.equal("0x" + Buffer.from(fields[5].data!).toString("hex"), tx.to.toLowerCase());
  assert.equal(rlpBigInt(fields[6]), tx.value);
  assert.equal("0x" + Buffer.from(fields[7].data!).toString("hex"), tx.data.toLowerCase());
  assert.equal(fields[8].kind, "list");
  assert.equal(fields[8].items!.length, 0, "empty access list");
  const yParity = Number(rlpBigInt(fields[9]));
  assert.ok(yParity === 0 || yParity === 1);
  const r = rlpBigInt(fields[10]);
  const s = rlpBigInt(fields[11]);
  // low-S enforced
  assert.ok(s <= BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"));
  // Recover from the sighash over the unsigned payload (chainId = field 0)
  const sighash = keccak_256(
    Buffer.concat([Buffer.from([0x02]), Buffer.from(rlpEncodeList(fields.slice(0, 9)))]),
  );
  const sig = new secp256k1.Signature(r, s, yParity);
  const pub = sig.recoverPublicKey(sighash);
  return "0x" + Buffer.from(keccak_256(pub.toBytes(false).subarray(1)).subarray(12)).toString("hex");
}

// We need the exact RLP encoding to recompute the sighash; reuse the decoder's
// structure by re-encoding canonically (RLP encoding is deterministic).
function rlpEncode(node: RlpNode): Uint8Array {
  if (node.kind === "bytes") {
    const d = node.data!;
    if (d.length === 1 && d[0] < 0x80) return d;
    return Buffer.concat([rlLen(d.length, 0x80), d]);
  }
  const payload = Buffer.concat(node.items!.map(rlpEncode));
  return Buffer.concat([rlLen(payload.length, 0xc0), payload]);
}
function rlpEncodeList(items: RlpNode[]): Uint8Array {
  return rlpEncode({ kind: "list", items });
}
function rlLen(len: number, offset: number): Uint8Array {
  if (len < 56) return Buffer.from([offset + len]);
  const hb = len.toString(16).padStart(Math.ceil(len.toString(16).length / 2) * 2, "0");
  const lb = Buffer.from(hb, "hex");
  return Buffer.concat([Buffer.from([offset + 55 + lb.length]), lb]);
}

test("loadSigner derives the well-known address for key 0x…01", () => {
  const s = loadSigner(KEY1);
  assert.ok(s);
  assert.equal(s.address, ADDR1);
  assert.equal(s.privateKey.length, 32);
});

test("loadSigner: unset/empty → null; malformed → throws without echoing the key", () => {
  assert.equal(loadSigner(undefined), null);
  assert.equal(loadSigner(""), null);
  assert.equal(loadSigner("   "), null);
  assert.throws(() => loadSigner("0x1234"), /32-byte hex/);
  assert.throws(() => loadSigner("zz".repeat(32)), /32-byte hex/);
  try {
    loadSigner("0xDEADBEEF");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(!(e as Error).message.includes("DEADBEEF"), "error must not echo the key");
  }
});

test("loadSigner accepts bare hex (no 0x) too", () => {
  assert.equal(loadSigner("0".repeat(63) + "1")!.address, ADDR1);
});

const sampleTx: PreparedTx = {
  from: ADDR1,
  to: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  data: "0xa72101af" + "ab".repeat(200),
  value: 500_000_000_000_000n,
  nonce: 7n,
  gasLimit: 4_620_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
};

test("signEip1559: correct field order, low-S, recovers the signer", () => {
  const signer = loadSigner(KEY1)!;
  const signed = signEip1559(signer, 4663, sampleTx);
  assert.ok(signed.startsWith("0x02"));
  // chainId bound as field 0
  const { node } = rlpDecode(Buffer.from(signed.slice(4), "hex"));
  assert.equal(rlpBigInt(node.items![0]), 4663n);
  assert.equal(recoverSigner(sampleTx, signed), ADDR1);
});

test("signEip1559: chainId is bound into the signature", () => {
  const signer = loadSigner(KEY1)!;
  const a = signEip1559(signer, 4663, sampleTx);
  const b = signEip1559(signer, 1, sampleTx);
  assert.notEqual(a, b, "different chainId must change the signature");
  // each recovers the signer against its own embedded chainId
  assert.equal(recoverSigner(sampleTx, a), ADDR1);
  assert.equal(recoverSigner(sampleTx, b), ADDR1);
});

test("signEip1559: zero value and empty data encode correctly", () => {
  const signer = loadSigner(KEY1)!;
  const tx: PreparedTx = { ...sampleTx, value: 0n, data: "0x", nonce: 0n };
  const signed = signEip1559(signer, 4663, tx);
  const raw = Buffer.from(signed.slice(2), "hex");
  const { node } = rlpDecode(raw.subarray(1));
  const fields = node.items!;
  assert.equal(fields[6].data!.length, 0, "zero value → empty RLP string (0x80)");
  assert.equal(fields[7].data!.length, 0, "empty data → empty RLP string");
  assert.equal(recoverSigner(tx, signed), ADDR1);
});

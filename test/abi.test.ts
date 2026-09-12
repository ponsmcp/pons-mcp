import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEL,
  TOPIC,
  selector,
  eventTopic,
  encodeUint,
  encodeAddress,
  encodeBool,
  encodeBytes32,
  encodeBytes,
  encodeString,
  encodeCall,
  words,
  decodeUint,
  decodeInt24,
  decodeBool,
  decodeAddress,
  decodeAbiString,
  topicAddress,
  keccakHex,
} from "../src/abi.js";

// Well-known selectors from the canonical EVM registry (4byte.directory).
const KNOWN_SELECTORS: [string, string][] = [
  ["name()", "06fdde03"],
  ["symbol()", "95d89b41"],
  ["decimals()", "313ce567"],
  ["totalSupply()", "18160ddd"],
  ["balanceOf(address)", "70a08231"],
  ["allowance(address,address)", "dd62ed3e"],
  ["approve(address,uint256)", "095ea7b3"],
  ["transfer(address,uint256)", "a9059cbb"],
  ["owner()", "8da5cb5b"],
  ["transferOwnership(address)", "f2fde38b"],
  ["acceptOwnership()", "79ba5097"],
];

test("selector() matches known keccak-256 values", () => {
  for (const [sig, expected] of KNOWN_SELECTORS) {
    assert.equal(selector(sig), expected, sig);
  }
});

test("SEL constants match their declared signatures (module already asserts at load)", () => {
  assert.equal(SEL.name, "06fdde03");
  assert.equal(SEL.balanceOf, "70a08231");
  assert.equal(SEL.approve, "095ea7b3");
  assert.equal(SEL.owner, "8da5cb5b");
});

test("event topics are 32-byte keccak of the canonical signature", () => {
  const t = eventTopic("TokenLaunched(address,address,address,address,uint256,uint256)");
  assert.equal(t.length, 64);
  assert.equal(t, TOPIC.TokenLaunched);
});

test("encodeUint / decodeUint round-trip", () => {
  for (const v of [0n, 1n, 255n, 2n ** 255n, (1n << 256n) - 1n]) {
    const w = encodeUint(v);
    assert.equal(w.length, 64);
    assert.equal(decodeUint(w), v);
  }
});

test("encodeAddress / decodeAddress / topicAddress", () => {
  const a = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
  const w = encodeAddress(a);
  assert.equal(w.length, 64);
  assert.ok(w.startsWith("000000000000000000000000"));
  assert.equal(decodeAddress(w), a.toLowerCase());
  assert.equal(topicAddress("0x" + w), a.toLowerCase());
});

test("encodeBool / decodeBool", () => {
  assert.equal(decodeBool(encodeBool(true)), true);
  assert.equal(decodeBool(encodeBool(false)), false);
});

test("encodeBytes32 validates input", () => {
  const ok = "0x" + "ab".repeat(32);
  assert.equal(encodeBytes32(ok), "ab".repeat(32));
  assert.throws(() => encodeBytes32("0x1234"));
  assert.throws(() => encodeBytes32("zz".repeat(32)));
});

test("encodeString: utf8 byte length, padded data; decodeAbiString round-trip", () => {
  const s = "Tøken ✨";
  const blob = encodeString(s);
  const byteLen = Buffer.byteLength(s, "utf8");
  assert.equal(decodeUint(blob.slice(0, 64)), BigInt(byteLen));
  // total blob = 32 (length) + ceil(byteLen/32)*32
  assert.equal(blob.length / 2, 32 + Math.ceil(byteLen / 32) * 32);
  // decodeAbiString expects the offset-word layout (single string return)
  const asReturn = "0x" + encodeUint(32) + blob;
  assert.equal(decodeAbiString(asReturn), s);
  assert.equal(decodeAbiString("0x"), ""); // empty return data
});

test("encodeBytes", () => {
  assert.equal(encodeBytes("0x"), encodeUint(0));
  assert.equal(encodeBytes("0x1234"), encodeUint(2) + "1234" + "0".repeat(60));
});

test("decodeInt24 sign-extends from the full 256-bit word", () => {
  assert.equal(decodeInt24(encodeUint(200)), 200n);
  assert.equal(decodeInt24(encodeUint(0)), 0n);
  // -1 as ABI-encoded int24 is a fully-set word
  assert.equal(decodeInt24("f".repeat(64)), -1n);
  // -8: all high bits set, low byte f8
  assert.equal(decodeInt24("f".repeat(62) + "f8"), -8n);
  // negative numbers round-trip through two's-complement masking
  const neg = ((-8872n) & ((1n << 256n) - 1n)).toString(16).padStart(64, "0");
  assert.equal(decodeInt24(neg), -8872n);
});

test("words() splits 32-byte words", () => {
  assert.deepEqual(words("0x"), []);
  assert.deepEqual(words("0x" + "00".repeat(32)), ["00".repeat(32)]);
  assert.equal(words("0x" + "ab".repeat(96)).length, 3);
  assert.equal(words("0x" + "ab".repeat(40)).length, 1); // trailing partial word ignored
});

test("encodeCall concatenates selector and args", () => {
  assert.equal(encodeCall("06fdde03"), "0x06fdde03");
  assert.equal(encodeCall("70a08231", encodeAddress("0x000000000000000000000000000000000000dEaD")), "0x70a08231" + encodeAddress("0x000000000000000000000000000000000000dEaD"));
});

test("keccakHex matches a known vector", () => {
  // keccak256("") = c5d2460186f7233c927e7db2dcc703c0…
  assert.equal(
    keccakHex(new Uint8Array(0)),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

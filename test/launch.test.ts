import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { capsFromEnv, launchToken, encodeTokenParams, NATIVE_PAIR_TOKEN } from "../src/launch.js";
import { LAUNCH_AND_BUY_ROUTER, FACTORY } from "../src/pons.js";
import { loadSigner } from "../src/signer.js";
import { mockClient, wordAt, wordUint, addrOf, stringAt, addrWord, word0x } from "./helpers.js";
import { SEL } from "../src/abi.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const ADDR1 = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

// ---------- encodeTokenParams ----------

test("encodeTokenParams round-trips every field", () => {
  const salt = "0x" + "11".repeat(32);
  const econ = "0x" + "22".repeat(32);
  const blob = encodeTokenParams({
    name: "Test Token ✨",
    symbol: "TST",
    logo: "https://example.com/logo.png",
    description: "A test token",
    socials: ["tw", "tg", "dc", "web", "fc"],
    creatorFeeRecipient: ADDR1,
    creatorTaxBps: 250,
    buybackEnabled: true,
    expectedEconomics: econ,
    salt,
  });
  // 10-word head: 5 dynamic offsets + recipient + tax + buyback + econ + salt
  assert.equal(addrOf(wordAt(blob, 5)), ADDR1);
  assert.equal(wordUint(blob, 6), 250n);
  assert.equal(wordUint(blob, 7), 1n);
  assert.equal("0x" + wordAt(blob, 8), econ);
  assert.equal("0x" + wordAt(blob, 9), salt);
  const [oName, oSymbol, oLogo, oDesc, oSocials] = [0, 1, 2, 3, 4].map((i) => Number(wordUint(blob, i)));
  assert.equal(stringAt(blob, oName), "Test Token ✨");
  assert.equal(stringAt(blob, oSymbol), "TST");
  assert.equal(stringAt(blob, oLogo), "https://example.com/logo.png");
  assert.equal(stringAt(blob, oDesc), "A test token");
  // socials sub-tuple: 5 offsets relative to its own start
  const sub = blob.slice(oSocials * 2);
  const expected = ["tw", "tg", "dc", "web", "fc"];
  for (let i = 0; i < 5; i++) {
    assert.equal(stringAt(sub, Number(wordUint(sub, i))), expected[i]);
  }
  // empty-string fields still decode
  const minimal = encodeTokenParams({
    name: "A", symbol: "B", logo: "", description: "",
    socials: ["", "", "", "", ""],
    creatorFeeRecipient: ADDR1, creatorTaxBps: 0, buybackEnabled: false,
    expectedEconomics: econ, salt,
  });
  assert.equal(stringAt(minimal, Number(wordUint(minimal, 2))), "");
});

// ---------- capsFromEnv ----------

test("capsFromEnv: defaults and overrides", () => {
  const def = capsFromEnv({});
  assert.equal(def.maxDevBuyWei, 5n * 10n ** 16n); // 0.05 ETH
  assert.equal(def.maxLaunchesPerDay, 5);
  const custom = capsFromEnv({ PONS_MAX_DEV_BUY_ETH: "0.5", PONS_MAX_LAUNCHES_PER_DAY: "2" });
  assert.equal(custom.maxDevBuyWei, 5n * 10n ** 17n);
  assert.equal(custom.maxLaunchesPerDay, 2);
  assert.equal(capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "0" }).maxLaunchesPerDay, 0);
});

test("capsFromEnv fails closed on malformed values", () => {
  assert.throws(() => capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "five" }), /non-negative integer/);
  assert.throws(() => capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "1.5" }), /non-negative integer/);
  assert.throws(() => capsFromEnv({ PONS_MAX_LAUNCHES_PER_DAY: "-1" }), /non-negative integer/);
  assert.throws(() => capsFromEnv({ PONS_MAX_DEV_BUY_ETH: "lots" }));
});

// ---------- launchToken drift gate (mocked chain) ----------

const SUPPLY = 10n ** 27n;
const launchConfigWords = [
  word0x(SUPPLY),
  word0x(100n), // curveFeeBps
  word0x(168n * 10n ** 16n), // phantomQuote 1.68
  word0x(42n * 10n ** 17n), // threshold 4.2
  word0x(0n), // poolFee
  word0x(200n), // tickSpacing
  word0x(1n), // enabled
]
  .map((x) => x.slice(2))
  .join("");

function makeLaunchClient(opts: { driftedForwarder?: boolean; canLaunch?: boolean }) {
  const forwarder = opts.driftedForwarder ? "0x" + "99".repeat(20) : LAUNCH_AND_BUY_ROUTER;
  return mockClient({
    ethCall: (_to, data) => {
      if (data.startsWith("0x" + SEL.launchFee)) return word0x(5n * 10n ** 14n);
      if (data.startsWith("0x" + SEL.launchEnabled)) return word0x(1n);
      if (data.startsWith("0x" + SEL.canLaunch)) return word0x(opts.canLaunch === false ? 0n : 1n);
      if (data.startsWith("0x" + SEL.maxCreatorTaxBps)) return word0x(1000n);
      if (data.startsWith("0x" + SEL.getLaunchConfig)) return "0x" + launchConfigWords;
      if (data.startsWith("0x" + SEL.previewLaunchEconomics)) return "0x" + "ab".repeat(32);
      if (data.startsWith("0x" + SEL.launchForwarder)) return addrWord(forwarder);
      return "0x"; // getLaunchedToken post-broadcast confirm → caught
    },
    call: (method, params) => {
      if (method === "eth_call") {
        // simulate: return predicted (token, curve)
        return "0x" + addrWord("0x" + "42".repeat(20)).slice(2) + addrWord("0x" + "43".repeat(20)).slice(2);
      }
      if (method === "eth_estimateGas") return "0x3ade68";
      if (method === "eth_feeHistory") return { baseFeePerGas: ["0x10000000"], reward: [["0x100000"]] };
      if (method === "eth_getTransactionCount") return "0x0";
      if (method === "eth_sendRawTransaction") {
        const rawTx = (params as string[])[0];
        return "0x" + Buffer.from(keccak_256(Buffer.from(rawTx.slice(2), "hex"))).toString("hex");
      }
      if (method === "eth_getTransactionReceipt") {
        const h = (params as string[])[0];
        return { transactionHash: h, blockNumber: "0x1", gasUsed: "0x100", effectiveGasPrice: "0x1", status: "0x1", logs: [] };
      }
      throw new Error("unexpected " + method);
    },
  });
}

const inputs = { name: "Drift Test", symbol: "DRIFT", devBuyEth: "0.01" };

test("launchToken dry-run: routes via forwarder, flags drift, broadcasts nothing", async () => {
  const c = makeLaunchClient({ driftedForwarder: true });
  const out = await launchToken(c as unknown as RpcClient, signer, inputs, capsFromEnv({}));
  assert.equal(out.mode, "dry-run");
  assert.equal(out.route, "launchAndBuyRouter");
  assert.equal(out.forwarderDrifted, true);
  assert.equal(out.to, "0x" + "99".repeat(20));
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("launchToken broadcast refuses a drifted forwarder without acceptContractDrift", async () => {
  const c = makeLaunchClient({ driftedForwarder: true });
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { ...inputs, dryRun: false, confirm: true }, capsFromEnv({})),
    /differs from the pinned router/,
  );
  assert.ok(!c.calls.some((x) => x.method === "eth_sendRawTransaction"));
});

test("launchToken broadcast with acceptContractDrift proceeds and verifies the hash", async () => {
  const c = makeLaunchClient({ driftedForwarder: true });
  const out = await launchToken(
    c as unknown as RpcClient,
    signer,
    { ...inputs, dryRun: false, confirm: true, acceptContractDrift: true },
    capsFromEnv({}),
  );
  assert.equal(out.mode, "broadcast");
  const rawSent = (c.calls.find((x) => x.method === "eth_sendRawTransaction")!.params as string[])[0];
  assert.equal(out.transaction.hash, "0x" + Buffer.from(keccak_256(Buffer.from(rawSent.slice(2), "hex"))).toString("hex"));
  assert.equal(out.dailyCap.used, 1);
});

test("launchToken: dev buy sends launchFee + devBuy as value to the forwarder", async () => {
  const c = makeLaunchClient({});
  const out = await launchToken(c as unknown as RpcClient, signer, inputs, capsFromEnv({}));
  assert.equal(out.to, LAUNCH_AND_BUY_ROUTER.toLowerCase());
  assert.equal(BigInt(out.economics.txValueWei), 5n * 10n ** 14n + 10n ** 16n); // 0.0005 + 0.01
  assert.equal(out.forwarderDrifted, false, "no drift when clean");
});

test("launchToken: no dev buy → factory route, msg.value == launchFee exactly", async () => {
  const c = makeLaunchClient({});
  const out = await launchToken(c as unknown as RpcClient, signer, { name: "Plain", symbol: "PLAIN" }, capsFromEnv({}));
  assert.equal(out.route, "factory");
  assert.equal(out.to.toLowerCase(), FACTORY.toLowerCase());
  assert.equal(BigInt(out.economics.txValueWei), 5n * 10n ** 14n);
});

test("launchToken validation: dev-buy cap, non-native dev buy, metadata limits", async () => {
  const c = makeLaunchClient({});
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { ...inputs, devBuyEth: "0.5" }, capsFromEnv({})),
    (e: Error) => (e as { code?: string }).code === "CAP_EXCEEDED",
  );
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { ...inputs, pairToken: "0x" + "12".repeat(20) }, capsFromEnv({})),
    /ETH-paired/,
  );
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { name: "x".repeat(65), symbol: "OK" }, capsFromEnv({})),
    /64/,
  );
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { name: "", symbol: "OK" }, capsFromEnv({})),
    /required/,
  );
});

test("launchToken enforces utf8 BYTE caps, not character counts", async () => {
  const c = makeLaunchClient({});
  // 40 × "é" = 40 chars but 80 utf8 bytes — passes a char-count check, must fail the byte cap
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { name: "é".repeat(40), symbol: "OK" }, capsFromEnv({})),
    /80 bytes/,
  );
  // 30 × "é" = 60 bytes — under the 64-byte cap, accepted
  const ok = await launchToken(c as unknown as RpcClient, signer, { name: "é".repeat(30), symbol: "OK" }, capsFromEnv({}));
  assert.equal(ok.mode, "dry-run");
  // symbol cap is 16 bytes: 9 × "é" = 18 bytes must fail
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { name: "OK", symbol: "é".repeat(9) }, capsFromEnv({})),
    /18 bytes/,
  );
});

test("launchToken refuses when signer cannot launch", async () => {
  const c = makeLaunchClient({ canLaunch: false });
  await assert.rejects(
    launchToken(c as unknown as RpcClient, signer, { name: "Nope", symbol: "NOPE" }, capsFromEnv({})),
    /not allowed to launch/,
  );
});

test("NATIVE_PAIR_TOKEN is the zero address", () => {
  assert.equal(NATIVE_PAIR_TOKEN, "0x0000000000000000000000000000000000000000");
});

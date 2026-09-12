import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toolDefinitions } from "../src/tools.js";
import { loadSigner } from "../src/signer.js";
import { mockClient } from "./helpers.js";
import type { RpcClient } from "../src/rpc.js";

const signer = loadSigner("0x" + "0".repeat(63) + "1")!;
const WRITE_TOOLS = [
  "pons_launch_token", "pons_buy", "pons_sell", "pons_graduate",
  "pons_set_creator_fee_recipient", "pons_execute_fee_recipient_change", "pons_cancel_fee_recipient_change",
  "pons_exempt_snipe_tax", "pons_set_buyback", "pons_sweep_curve_fees", "pons_rescue_curve_fees",
  "pons_admin_call", "pons_swap", "pons_claim_fees", "pons_release_buyback",
];

test("no key → exactly the 20 read tools; write tools are not even registered", () => {
  const defs = toolDefinitions(mockClient({}) as unknown as RpcClient, null);
  assert.equal(defs.length, 20);
  for (const w of WRITE_TOOLS) assert.ok(!defs.some((d) => d.name === w), `${w} must not exist without a key`);
  assert.ok(defs.some((d) => d.name === "pons_scan_interesting"));
});

test("with key → all 35 tools (20 read + 15 write)", () => {
  const defs = toolDefinitions(mockClient({}) as unknown as RpcClient, signer);
  assert.equal(defs.length, 35);
  for (const w of WRITE_TOOLS) assert.ok(defs.some((d) => d.name === w), `${w} missing`);
});

test("dryRun/confirm are strict booleans — a string 'false' does not parse", () => {
  const defs = toolDefinitions(mockClient({}) as unknown as RpcClient, signer);
  const buy = defs.find((d) => d.name === "pons_buy")!;
  const schema = z.object(buy.schema);
  const base = { curveAddress: "0x" + "11".repeat(20), amount: "1" };
  assert.ok(schema.safeParse({ ...base, dryRun: false, confirm: true }).success);
  assert.ok(!schema.safeParse({ ...base, dryRun: "false" }).success, "string 'false' must fail");
  assert.ok(!schema.safeParse({ ...base, confirm: "true" }).success, "string 'true' must fail");
  assert.ok(!schema.safeParse({ ...base, dryRun: 0 }).success, "0 must fail");
});

test("lookbackBlocks / limit schema caps", () => {
  const defs = toolDefinitions(mockClient({}) as unknown as RpcClient, null);
  const launches = defs.find((d) => d.name === "pons_recent_launches")!;
  const schema = z.object(launches.schema);
  assert.ok(schema.safeParse({ lookbackBlocks: 500_000, limit: 100 }).success);
  assert.ok(!schema.safeParse({ lookbackBlocks: 500_001 }).success);
  assert.ok(!schema.safeParse({ lookbackBlocks: 0 }).success);
  assert.ok(!schema.safeParse({ limit: 101 }).success);
});

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { RpcClient, RpcError } from "./rpc.js";
import type { Signer } from "./signer.js";

// ---------- RLP ----------

type RlpItem = Uint8Array | RlpItem[];

function rlp(item: RlpItem): Uint8Array {
  if (Array.isArray(item)) {
    const payload = Buffer.concat(item.map(rlp));
    return Buffer.concat([rlpLength(payload.length, 0xc0), payload]);
  }
  if (item.length === 1 && item[0] < 0x80) return Buffer.from(item);
  return Buffer.concat([rlpLength(item.length, 0x80), item]);
}

function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Buffer.from([offset + len]);
  const lenBytes = intBytes(BigInt(len));
  return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

function intBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  const hex = v.toString(16).padStart(Math.ceil(v.toString(16).length / 2) * 2, "0");
  return Buffer.from(hex, "hex");
}

const hexBytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error(`malformed hex (odd length or non-hex characters): ${hex.slice(0, 20)}…`);
  }
  return Buffer.from(h, "hex");
};

// ---------- EIP-1559 (type 0x02) ----------

export interface TxRequest {
  to: string;
  data: string;
  value: bigint;
}

export interface PreparedTx extends TxRequest {
  from: string;
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export async function feeMarket(
  client: RpcClient,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  // Plausibility ceiling: a malicious/misconfigured endpoint can inflate fee
  // estimates, and maxPriorityFeePerGas is actually paid. 50 gwei is ~170x the
  // observed norm on this chain (~0.3 gwei).
  const FEE_CEILING = 50n * 10n ** 9n;
  try {
    const history = await client.call<{
      baseFeePerGas: string[];
      reward: string[][];
    }>("eth_feeHistory", ["0x1", "latest", [50]]);
    const baseFee = BigInt(history.baseFeePerGas.at(-1) ?? "0x0");
    const priority = BigInt(history.reward.at(-1)?.[0] ?? "0x0");
    if (baseFee === 0n) throw new Error("zero baseFee");
    const fees = { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority > 0n ? priority : baseFee };
    if (fees.maxFeePerGas > FEE_CEILING) {
      throw new RpcError("RPC_FAILURE", `implausible fee estimate from endpoint (maxFeePerGas ${fees.maxFeePerGas} wei > ${FEE_CEILING}); refusing to build a transaction`);
    }
    return fees;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    const gasPrice = await client.gasPrice();
    if (gasPrice * 2n > FEE_CEILING) {
      throw new RpcError("RPC_FAILURE", `implausible gasPrice from endpoint (${gasPrice} wei); refusing to build a transaction`);
    }
    return { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice };
  }
}

export async function prepareTx(client: RpcClient, signer: Signer, req: TxRequest): Promise<PreparedTx> {
  const [nonceHex, fees, estimateHex] = await Promise.all([
    client.call<string>("eth_getTransactionCount", [signer.address, "pending"]),
    feeMarket(client),
    client.call<string>("eth_estimateGas", [
      { from: signer.address, to: req.to, data: req.data, value: "0x" + req.value.toString(16) },
    ]),
  ]);
  return {
    ...req,
    from: signer.address,
    nonce: BigInt(nonceHex),
    gasLimit: (BigInt(estimateHex) * 120n) / 100n,
    ...fees,
  };
}

export function signEip1559(signer: Signer, chainId: number, tx: PreparedTx): string {
  const fields: RlpItem[] = [
    intBytes(BigInt(chainId)),
    intBytes(tx.nonce),
    intBytes(tx.maxPriorityFeePerGas),
    intBytes(tx.maxFeePerGas),
    intBytes(tx.gasLimit),
    hexBytes(tx.to),
    intBytes(tx.value),
    hexBytes(tx.data),
    [],
  ];
  const sighash = keccak_256(Buffer.concat([Buffer.from([0x02]), rlp(fields)]));
  // prehash: false — the input is already the keccak-256 digest.
  const sigBytes = secp256k1.sign(sighash, signer.privateKey, { prehash: false, format: "recovered", lowS: true });
  const sig = secp256k1.Signature.fromBytes(sigBytes, "recovered");
  if (sig.recovery === undefined) throw new Error("signing did not produce a recovery id");
  const signed = rlp([...fields, intBytes(BigInt(sig.recovery)), intBytes(sig.r), intBytes(sig.s)]);
  return "0x" + Buffer.concat([Buffer.from([0x02]), signed]).toString("hex");
}

export interface Receipt {
  transactionHash: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice: string;
  status: string;
  logs: { address: string; topics: string[]; data: string }[];
}

export async function sendAndWait(client: RpcClient, rawTx: string): Promise<Receipt> {
  // The expected hash is computable locally: keccak256 of the signed payload.
  // An endpoint returning a different hash (or a receipt for a different one)
  // is lying — refuse rather than report a fabricated outcome.
  const expectedHash = "0x" + Buffer.from(keccak_256(hexBytes(rawTx))).toString("hex");
  const hash = await client.call<string>("eth_sendRawTransaction", [rawTx]);
  if (typeof hash !== "string" || hash.toLowerCase() !== expectedHash) {
    throw new RpcError(
      "RPC_FAILURE",
      `endpoint returned tx hash ${String(hash)} which does not match the signed transaction (${expectedHash}); refusing to trust this endpoint`,
    );
  }
  const deadline = Date.now() + 30_000; // ~0.1s blocks; 30s is generous
  while (Date.now() < deadline) {
    const receipt = await client.call<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase()) {
        throw new RpcError("RPC_FAILURE", `receipt hash mismatch: expected ${hash}, got ${receipt.transactionHash}`);
      }
      if (BigInt(receipt.status) === 0n) {
        throw new RpcError("REVERTED", `transaction ${hash} reverted on-chain`);
      }
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new RpcError(
    "RPC_FAILURE",
    `transaction ${hash} not mined within 30s — it may still confirm later; check https://robinhoodchain.blockscout.com/tx/${hash} before retrying (a retry queues behind the same pending nonce)`,
  );
}

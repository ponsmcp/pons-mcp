import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3";

export interface Signer {
  address: string;
  privateKey: Uint8Array;
}

// Key comes ONLY from PONS_PRIVATE_KEY. Never logged; only the derived
// address is surfaced. Returns null when unset (read-only mode).
export function loadSigner(env: string | undefined): Signer | null {
  if (env === undefined || env.trim() === "") return null;
  const hex = env.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PONS_PRIVATE_KEY must be a 32-byte hex string (0x prefix optional)");
  }
  const privateKey = Buffer.from(hex, "hex");
  const pub = secp256k1.getPublicKey(privateKey, false); // uncompressed, 65 bytes
  const address = "0x" + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString("hex");
  return { address, privateKey };
}

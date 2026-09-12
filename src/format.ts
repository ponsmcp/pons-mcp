const ZERO = "0x0000000000000000000000000000000000000000";

export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const intPart = decimals === 0 ? s : s.slice(0, -decimals);
  const fracPart = decimals === 0 ? "" : s.slice(-decimals).replace(/0+$/, "");
  return (negative ? "-" : "") + intPart + (fracPart ? "." + fracPart : "");
}

export function formatEth(wei: bigint): string {
  return `${formatUnits(wei, 18)} ETH`;
}

export function formatGwei(wei: bigint): string {
  return `${formatUnits(wei, 9)} gwei`;
}

export function formatBps(bps: bigint): string {
  return `${formatUnits(bps * 100n, 4)}%`;
}

export function pct(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return "0%";
  return `${formatUnits((numerator * 10_000n) / denominator, 2)}%`;
}

export function shortAddr(a: string): string {
  return a.toLowerCase();
}

export function isZeroAddress(a: string): boolean {
  return a.toLowerCase() === ZERO;
}

export class ParseUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseUnitsError";
  }
}

export function parseUnits(text: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new ParseUnitsError(`invalid decimal amount: ${text}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new ParseUnitsError(`too many decimal places (max ${decimals}): ${text}`);
  return BigInt(m[1] + frac);
}

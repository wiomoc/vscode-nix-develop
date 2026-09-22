
/**
 * RFC 4648 base32, lower case, unpadded. Single-case, because VS Code lower-cases
 * authorities.
 */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function encodeBase32(data: Buffer): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Whatever is left over is padded on the right with zero bits.
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(payload: string): Buffer | undefined {
  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of payload) {
    const index = B32.indexOf(ch);
    if (index === -1) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
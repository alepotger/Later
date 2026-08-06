/**
 * Base64 and byte helpers built only on Web-standard primitives.
 *
 * `Buffer` is deliberately unused: it does not exist on Cloudflare Workers, and this
 * code is shared by both runtimes. `atob`/`btoa` exist in Node 18+, Workers, Deno,
 * and Bun.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array | null {
  // Accept base64url as well as standard base64; share sheets and CLI tools emit both.
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/').trim();
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  return bytesToBase64Url(randomBytes(byteLength));
}

/**
 * Constant-time string comparison.
 *
 * Used for the ingest bearer token so that the endpoint cannot be turned into an oracle
 * that leaks the secret one character at a time. Compares byte length first — length is
 * not secret here, and a mismatch short-circuits safely.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

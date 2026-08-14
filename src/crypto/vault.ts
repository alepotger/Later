/**
 * Encryption at rest for OAuth tokens.
 *
 * A Google refresh token grants ongoing write access to someone's YouTube account, so it
 * is the most sensitive thing Later stores. It is encrypted with AES-256-GCM before it
 * ever reaches the database, and the key lives only in the environment — never in a
 * column, never in a backup of the database.
 *
 * Uses `crypto.subtle` exclusively, so this is the same code path on Cloudflare Workers,
 * Node, Deno, and Bun with no dependency. See docs/adr/0001.
 */

import { base64ToBytes, bytesToBase64, randomBytes } from '../core/bytes.ts';

/** GCM's standard nonce length. 96 bits is the size the mode is designed around. */
const IV_LENGTH = 12;

/**
 * Ciphertext format version.
 *
 * Recorded in the stored string so that a future change of algorithm or key-derivation
 * scheme can be detected rather than guessed at.
 */
const FORMAT = 'v1';

export interface Vault {
  encrypt(plaintext: string): Promise<string>;
  /** Returns null when the value cannot be decrypted or authenticated. */
  decrypt(sealed: string): Promise<string | null>;
}

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

export async function createVault(keyBytes: Uint8Array): Promise<Vault> {
  if (keyBytes.length !== 32) {
    throw new VaultKeyError(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes for AES-256-GCM, got ${keyBytes.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    async encrypt(plaintext: string): Promise<string> {
      // A fresh random IV per record. Reusing an IV under GCM is catastrophic, so it is
      // generated here rather than being derivable from anything.
      const iv = randomBytes(IV_LENGTH);
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
        key,
        new TextEncoder().encode(plaintext) as unknown as ArrayBuffer,
      );
      return `${FORMAT}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
    },

    async decrypt(sealed: string): Promise<string | null> {
      const parts = sealed.split('.');
      if (parts.length !== 3 || parts[0] !== FORMAT) return null;

      const iv = base64ToBytes(parts[1] ?? '');
      const payload = base64ToBytes(parts[2] ?? '');
      if (!iv || !payload || iv.length !== IV_LENGTH) return null;

      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
          key,
          payload as unknown as ArrayBuffer,
        );
        return new TextDecoder().decode(plain);
      } catch {
        // GCM authentication failed: wrong key, or the ciphertext was tampered with.
        // Both are "cannot use this token", and neither should leak which one it was.
        return null;
      }
    },
  };
}

/**
 * HMAC-SHA256, used for the optional signed-ingest mode.
 *
 * Not the default — see docs/adr/0008-ingest-authentication.md for why requiring this
 * would make the iOS Shortcut unbuildable.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message) as unknown as ArrayBuffer,
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

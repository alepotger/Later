import { describe, expect, it } from 'vitest';
import { bytesToBase64, randomBytes, timingSafeEqual } from '../../src/core/bytes.ts';
import { createVault, hmacSha256Hex } from '../../src/crypto/vault.ts';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe('token vault', () => {
  it('round-trips a refresh token', async () => {
    const vault = await createVault(KEY);
    const token = '1//0gABCDEFghijklmnop-qrstuvwxyz_1234567890';
    const sealed = await vault.encrypt(token);
    expect(await vault.decrypt(sealed)).toBe(token);
  });

  it('never stores the plaintext in the sealed value', async () => {
    const vault = await createVault(KEY);
    const token = 'a-very-recognisable-refresh-token';
    const sealed = await vault.encrypt(token);
    expect(sealed).not.toContain(token);
    expect(sealed).not.toContain('recognisable');
  });

  it('produces a different ciphertext each time, because the IV is fresh', async () => {
    const vault = await createVault(KEY);
    const a = await vault.encrypt('same input');
    const b = await vault.encrypt('same input');
    expect(a).not.toBe(b);
    expect(await vault.decrypt(a)).toBe('same input');
    expect(await vault.decrypt(b)).toBe('same input');
  });

  it('carries a format version so a future scheme change is detectable', async () => {
    const vault = await createVault(KEY);
    expect(await vault.encrypt('x')).toMatch(/^v1\./);
  });

  it('refuses a key that is not 32 bytes, with an actionable message', async () => {
    await expect(createVault(randomBytes(16))).rejects.toThrow(/32 bytes/);
    await expect(createVault(randomBytes(16))).rejects.toThrow(/openssl rand -base64 32/);
  });

  it('returns null for a value encrypted under a different key', async () => {
    const sealed = await (await createVault(KEY)).encrypt('secret');
    expect(await (await createVault(OTHER_KEY)).decrypt(sealed)).toBeNull();
  });

  it('detects tampering rather than returning corrupt plaintext', async () => {
    const vault = await createVault(KEY);
    const sealed = await vault.encrypt('secret value');
    const [version, iv, payload] = sealed.split('.');

    // Flip a bit in the ciphertext. GCM's authentication tag must catch this.
    const bytes = Array.from(atob((payload ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = `${version}.${iv}.${bytesToBase64(new Uint8Array(bytes))}`;

    expect(await vault.decrypt(tampered)).toBeNull();
  });

  it('returns null rather than throwing on malformed input', async () => {
    const vault = await createVault(KEY);
    for (const bad of ['', 'garbage', 'v1.only-two-parts', 'v2.aaa.bbb', 'v1..', 'v1.!!!.!!!']) {
      expect(await vault.decrypt(bad)).toBeNull();
    }
  });

  it('rejects a value whose IV is the wrong length', async () => {
    const vault = await createVault(KEY);
    const sealed = await vault.encrypt('x');
    const [, , payload] = sealed.split('.');
    expect(await vault.decrypt(`v1.${bytesToBase64(randomBytes(8))}.${payload}`)).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('rejects different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('handles empty and multi-byte input', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('naïve', 'naïve')).toBe(true);
  });
});

describe('hmacSha256Hex', () => {
  it('is deterministic for the same key and message', async () => {
    const a = await hmacSha256Hex('secret', 'payload');
    const b = await hmacSha256Hex('secret', 'payload');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the key and with the message', async () => {
    const base = await hmacSha256Hex('secret', 'payload');
    expect(await hmacSha256Hex('other', 'payload')).not.toBe(base);
    expect(await hmacSha256Hex('secret', 'payload!')).not.toBe(base);
  });

  it('matches the RFC 4231 test vector for HMAC-SHA256', async () => {
    // Key = 20 bytes of 0x0b, data = "Hi There".
    const key = String.fromCharCode(...new Array(20).fill(0x0b));
    expect(await hmacSha256Hex(key, 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });
});

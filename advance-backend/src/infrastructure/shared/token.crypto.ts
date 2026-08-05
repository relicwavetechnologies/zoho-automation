/**
 * token.crypto — AES-256-GCM token encryption/decryption.
 *
 * Shared by backend-owned integration credential storage.
 *
 * Key derivation:
 *   - If the raw key starts with "base64:" → parse the remainder as base64 (must be 32 bytes).
 *   - Otherwise → SHA-256 hash the string → 32-byte key.
 *
 * Cipher text format: `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 *
 * Legacy v1 integration rows use ZOHO_TOKEN_ENCRYPTION_KEY. New provider rows
 * may use INTEGRATION_TOKEN_ENCRYPTION_KEY, selected by their persisted
 * tokenCipherVersion so key rotation does not make existing ciphertext unreadable.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const CIPHER_ALGO    = 'aes-256-gcm';
const IV_LENGTH      = 12; // 96-bit nonce
const CIPHER_VERSION = 1;

// ─── Error ────────────────────────────────────────────────────────────────────

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

// ─── Key derivation ────────────────────────────────────────────────────────────

function toKeyBuffer(raw: string): Buffer {
  if (raw.startsWith('base64:')) {
    const buf = Buffer.from(raw.slice('base64:'.length), 'base64');
    if (buf.length !== 32) {
      throw new TokenCryptoError('base64 encryption key must resolve to 32 bytes');
    }
    return buf;
  }
  // SHA-256 of the raw string → deterministic 32-byte key
  return createHash('sha256').update(raw).digest();
}

function readKey(encryptionKey: string): Buffer {
  const raw = encryptionKey.trim();
  if (!raw) {
    throw new TokenCryptoError('Token encryption key is empty or not configured');
  }
  const key = toKeyBuffer(raw);
  if (key.length !== 32) {
    throw new TokenCryptoError('Token encryption key must resolve to 32 bytes');
  }
  return key;
}

// ─── Encrypt ──────────────────────────────────────────────────────────────────

export interface EncryptedToken {
  /** The versioned cipher text: `v1:<iv_b64>:<tag_b64>:<data_b64>` */
  cipherText: string;
  version: number;
}

export function encryptToken(plainText: string, encryptionKey: string): EncryptedToken {
  const value = plainText.trim();
  if (!value) {
    throw new TokenCryptoError('Cannot encrypt an empty token');
  }

  const key = readKey(encryptionKey);
  const iv  = randomBytes(IV_LENGTH);

  const cipher    = createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();

  return {
    version:    CIPHER_VERSION,
    cipherText: `v${CIPHER_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`,
  };
}

// ─── Decrypt ──────────────────────────────────────────────────────────────────

export function decryptToken(cipherText: string, encryptionKey: string): string {
  const raw   = cipherText.trim();
  const parts = raw.split(':');

  if (parts.length !== 4 || !(parts[0] ?? '').startsWith('v')) {
    throw new TokenCryptoError('Invalid encrypted token format (expected v1:<iv>:<tag>:<data>)');
  }

  const key     = readKey(encryptionKey);
  const iv      = Buffer.from(parts[1] ?? '', 'base64');
  const authTag = Buffer.from(parts[2] ?? '', 'base64');
  const data    = Buffer.from(parts[3] ?? '', 'base64');

  const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new TokenCryptoError('Token decryption failed — key mismatch or data corrupted');
  }
}

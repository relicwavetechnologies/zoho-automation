import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

import config from '../../../config';
import { ZohoIntegrationError } from './zoho.errors';

const CIPHER_ALGO = 'aes-256-gcm';
const CIPHER_VERSION = 1;
const IV_LENGTH = 12;

const toBuffer = (input: string): Buffer => {
  if (input.startsWith('base64:')) {
    return Buffer.from(input.slice('base64:'.length), 'base64');
  }

  return createHash('sha256').update(input).digest();
};

const readKey = (override?: string): Buffer => {
  const raw = (override ?? config.ZOHO_TOKEN_ENCRYPTION_KEY).trim();
  if (!raw) {
    throw new ZohoIntegrationError({
      message: 'ZOHO_TOKEN_ENCRYPTION_KEY is required for secure token handling',
      code: 'auth_failed',
      retriable: false,
    });
  }

  const key = toBuffer(raw);
  if (key.length !== 32) {
    throw new ZohoIntegrationError({
      message: 'ZOHO_TOKEN_ENCRYPTION_KEY must resolve to 32 bytes',
      code: 'auth_failed',
      retriable: false,
    });
  }

  return key;
};

export type EncryptedZohoSecret = {
  cipherText: string;
  version: number;
};

export const encryptZohoSecret = (plainText: string, keyOverride?: string): EncryptedZohoSecret => {
  const value = plainText.trim();
  if (!value) {
    throw new ZohoIntegrationError({
      message: 'Cannot encrypt empty Zoho token',
      code: 'schema_mismatch',
      retriable: false,
    });
  }

  const key = readKey(keyOverride);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: CIPHER_VERSION,
    cipherText: `v${CIPHER_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`,
  };
};

export const decryptZohoSecret = (cipherText: string, keyOverride?: string): string => {
  const raw = cipherText.trim();
  const parts = raw.split(':');
  if (parts.length !== 4 || !parts[0].startsWith('v')) {
    throw new ZohoIntegrationError({
      message: 'Invalid encrypted Zoho token payload',
      code: 'schema_mismatch',
      retriable: false,
    });
  }

  const key = readKey(keyOverride);
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const encrypted = Buffer.from(parts[3], 'base64');

  try {
    const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new ZohoIntegrationError({
      message: 'Unable to decrypt Zoho token payload',
      code: 'auth_failed',
      retriable: false,
    });
  }
};

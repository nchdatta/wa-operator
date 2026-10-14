import crypto from 'node:crypto';
import { readSecrets, secretStoreAvailable, writeSecret } from './secrets.js';

/**
 * The key that encrypts everything Operator Mode stores (database, WhatsApp link session).
 * Made on first use and kept in the system secret store (Credential Manager, Keychain, keyring), never next to the data.
 * Losing it (e.g. a Windows reinstall) makes the old data unreadable: the app then starts fresh.
 */

const HEX_KEY = /^[0-9a-f]{64}$/;

export function ensureDataKey(existing?: string): string {
  if (existing && HEX_KEY.test(existing)) return existing;
  const stored = readSecrets(['OPERATOR_DATA_KEY']).OPERATOR_DATA_KEY;
  if (stored && HEX_KEY.test(stored)) return stored;
  if (!secretStoreAvailable())
    throw new Error(
      'No OPERATOR_DATA_KEY: secret store is off, so set it (64 hex characters) as an environment variable.',
    );
  const key = crypto.randomBytes(32).toString('hex');
  writeSecret('OPERATOR_DATA_KEY', key);
  return key;
}

/** A separate key per use, so the database key never encrypts files directly. */
export function subKey(dataKey: string, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(dataKey, 'hex'), Buffer.alloc(0), purpose, 32));
}

const MAGIC = Buffer.from('WAOPENC1');

/** AES-256-GCM: MAGIC | iv(12) | tag(16) | ciphertext. */
export function encryptBytes(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function isEncrypted(buf: Buffer): boolean {
  return buf.length >= MAGIC.length + 28 && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBytes(key: Buffer, buf: Buffer): Buffer {
  if (!isEncrypted(buf)) throw new Error('not an encrypted file');
  const iv = buf.subarray(8, 20);
  const tag = buf.subarray(20, 36);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(36)), d.final()]);
}

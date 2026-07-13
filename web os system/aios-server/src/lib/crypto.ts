// AES-256-GCM at-rest encryption for all third-party tokens/secrets.
// Ciphertext format: enc:<iv_b64>:<tag_b64>:<ct_b64>. Key = AIOS_ENCRYPTION_KEY
// (32-byte hex), which lives only in .env and is never written to the DB.
import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.encryptionKey, 'hex');
if (KEY.length !== 32) {
  throw new Error('AIOS_ENCRYPTION_KEY must be 32 bytes (64 hex chars). Generate: openssl rand -hex 32');
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob: string): string {
  if (!blob.startsWith('enc:')) throw new Error('not an aios ciphertext');
  const [, ivb, tagb, ctb] = blob.split(':');
  const iv = Buffer.from(ivb!, 'base64');
  const tag = Buffer.from(tagb!, 'base64');
  const ct = Buffer.from(ctb!, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

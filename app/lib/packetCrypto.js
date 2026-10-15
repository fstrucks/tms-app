// Server-only AES-256-GCM field encryption for carrier packet secrets (EIN/TIN, later ACH).
// Key: PACKET_ENCRYPTION_KEY = 32 random bytes, base64 (or 64 hex chars). Never NEXT_PUBLIC_.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const KEY_ENV = 'PACKET_ENCRYPTION_KEY';
const VERSION = 'v1';

export class PacketKeyError extends Error {}

export function loadKey(raw = process.env[KEY_ENV]) {
  if (!raw || !String(raw).trim()) throw new PacketKeyError(`${KEY_ENV} is not set. Sensitive company fields cannot be saved or read until it is configured on the server.`);
  const v = String(raw).trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (buf.length !== 32) throw new PacketKeyError(`${KEY_ENV} must be 32 bytes (base64 or 64 hex chars).`);
  return buf;
}

export function encryptField(plain, key = loadKey()) {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptField(blob, key = loadKey()) {
  if (blob == null || blob === '') return null;
  const [ver, iv, tag, data] = String(blob).split(':');
  if (ver !== VERSION || !iv || !tag || data == null) throw new Error('Unrecognized ciphertext format.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

// EIN: 9 digits, shown as XX-XXXXXXX. Returns digits or null; throws on bad input.
export function normalizeEin(v) {
  if (v == null || String(v).trim() === '') return null;
  const d = String(v).replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(d)) throw new Error('EIN/TIN must be 9 digits (e.g. 12-3456789).');
  return d;
}
export const last4 = (d) => (d ? String(d).slice(-4) : null);
export const maskEin = (l4) => (l4 ? `•••••${l4}` : '');

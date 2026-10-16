// Server: validate a signature from the pad and build storage paths. Pad contract (SignaturePad onDone):
// { dataUrl: 'data:image/png;base64,…' (trimmed PNG), signerName, signedAt (ISO), method: 'draw'|'type' }.
export const SIG_MAX_BYTES = 512 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parseSignature(body, { now = Date.now() } = {}) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.dataUrl || ''));
  if (!m) return { error: 'Signature must be a PNG image.' };
  const png = Buffer.from(m[1], 'base64');
  if (png.length > SIG_MAX_BYTES) return { error: 'Signature image is too large.' };
  if (png.length < 16 || !png.subarray(0, 8).equals(PNG_MAGIC)) return { error: 'Signature must be a PNG image.' };
  const signerName = String(body?.signerName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!signerName) return { error: 'Enter the signer’s name.' };
  const t = Date.parse(body?.signedAt || '');
  // Trust the pad's time only if it's sane (within a day of the server clock); otherwise use the server's.
  const signedAt = new Date(Number.isFinite(t) && Math.abs(t - now) < 864e5 ? t : now).toISOString();
  const method = body?.method === 'type' ? 'type' : 'draw';
  return { png, signerName, signedAt, method };
}
export const signaturePath = (ownerId, packetId, fieldId, ts = Date.now()) => `${ownerId}/packets/signatures/${packetId}/${fieldId}-${ts}.png`;
export const filledPath = (ownerId, packetId, ts = Date.now()) => `${ownerId}/packets/filled/${packetId}-${ts}.pdf`;
export { formatPacketDate } from './packetDate.js';
export const SIGN_MIGRATION = '20261016001600_packet_signatures.sql';

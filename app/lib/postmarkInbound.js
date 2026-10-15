// Pure helpers for the Postmark inbound webhook (no I/O, unit-tested).
import { timingSafeEqual, createHash } from 'node:crypto';

export const PACKET_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PDFS_PER_EMAIL = 10;
export const INBOUND_ADDRESS = 'packets@in.fstrucks.com';

const h = (s) => createHash('sha256').update(String(s)).digest();
const eq = (a, b) => timingSafeEqual(h(a), h(b));

// True only when both env creds are set and the Basic header matches. Missing config → not configured.
export function checkBasicAuth(header, user, pass) {
  if (!user || !pass) return { ok: false, configured: false };
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return { ok: false, configured: true };
  let dec = '';
  try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return { ok: false, configured: true }; }
  const i = dec.indexOf(':');
  if (i < 0) return { ok: false, configured: true };
  const okU = eq(dec.slice(0, i), user), okP = eq(dec.slice(i + 1), pass);
  return { ok: okU && okP, configured: true };
}

export function emailOf(v) {
  const s = String(v || '').trim();
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) || /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(s);
  return m ? m[1].toLowerCase() : null;
}
const header = (headers, name) => (headers || []).find((x) => String(x?.Name).toLowerCase() === name.toLowerCase())?.Value || null;
export const safeName = (n) => (String(n || 'packet.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'packet.pdf');

const isPdf = (a, bytes) => /pdf/i.test(a.ContentType || '') || /\.pdf$/i.test(a.Name || '') ? bytes.subarray(0, 5).toString('latin1') === '%PDF-' : false;

// Postmark inbound JSON → normalized email + accepted PDFs + rejected list.
export function parseInbound(p) {
  if (!p || typeof p !== 'object') throw new Error('Bad payload');
  const fromEmail = emailOf(p.FromFull?.Email || p.From);
  if (!fromEmail) throw new Error('Missing sender');
  const headers = Array.isArray(p.Headers) ? p.Headers : [];
  const messageId = header(headers, 'Message-ID') || (p.MessageID ? `<${p.MessageID}@postmark>` : null);
  if (!messageId) throw new Error('Missing Message-ID');
  const pdfs = [], rejected = [];
  for (const a of Array.isArray(p.Attachments) ? p.Attachments : []) {
    const name = a?.Name || 'attachment';
    let bytes;
    try { bytes = Buffer.from(String(a?.Content || ''), 'base64'); } catch { rejected.push({ name, reason: 'unreadable' }); continue; }
    if (!bytes.length) { rejected.push({ name, reason: 'empty' }); continue; }
    if (bytes.length > PACKET_MAX_BYTES) { rejected.push({ name, reason: 'too_large' }); continue; }
    if (!isPdf(a, bytes)) { rejected.push({ name, reason: 'not_pdf' }); continue; }
    if (pdfs.length >= MAX_PDFS_PER_EMAIL) { rejected.push({ name, reason: 'too_many' }); continue; }
    pdfs.push({ name: safeName(name), bytes, size: bytes.length });
  }
  return {
    fromEmail, messageId,
    to: p.To || null, cc: p.Cc || null, subject: p.Subject || null,
    inReplyTo: header(headers, 'In-Reply-To'), references: header(headers, 'References'),
    headers: headers.map((x) => ({ Name: String(x?.Name || ''), Value: String(x?.Value || '').slice(0, 2000) })),
    pdfs, rejected,
  };
}

export function packetPath(ownerId, name, now = Date.now(), i = 0) {
  return `${ownerId}/packets/${now}-${i}-${safeName(name)}`;
}

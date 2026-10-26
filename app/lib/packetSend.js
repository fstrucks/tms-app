import { isReplyToEmail } from './companyFields.js';
// Carrier packet step F: Send to broker. Pure helpers (validation, guardrail, draft, Postmark call) so the
// route stays thin and everything is unit-testable with a mocked fetch. Nothing here sends on its own.
import { autoCcFor, uniqueEmails } from './packetSendClient.js';
export const SEND_MIGRATION = '20261016001700_packet_sends.sql';
export const SEND_ROLES = new Set(['owner', 'management']);
export const canSend = (r) => SEND_ROLES.has(r);
const EMAIL = /^[^\s@<>(),;:"\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const MAX_RECIPIENTS = 10;
// PACKET_CC_EMAIL: optional address copied on every packet / COI email. Unset/empty → no automatic copy.
// 'none' / 'off' also means no copy. An invalid value is ignored (no copy) and logged.
export function packetCcEmail(env = process.env) {
  const v = String(env?.PACKET_CC_EMAIL ?? '').trim().toLowerCase();
  if (!v || v === 'none' || v === 'off') return null;
  if (!EMAIL.test(v)) { console.error('[packets] PACKET_CC_EMAIL is not a valid email; no automatic copy'); return null; }
  return v;
}
export const POSTMARK_TIMEOUT_MS = 20000;

// "a@x.com, b@y.com; c@z.com" → { list } | { error }
export function parseEmails(input, { label = 'email', required = false } = {}) {
  const raw = (Array.isArray(input) ? input : String(input || '').split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const list = [...new Set(raw)];
  if (required && !list.length) return { error: `Enter the broker ${label}.` };
  const bad = list.find((e) => !EMAIL.test(e));
  if (bad) return { error: `“${bad}” isn’t a valid ${label}.` };
  if (list.length > MAX_RECIPIENTS) return { error: `Too many addresses (max ${MAX_RECIPIENTS}).` };
  return { list };
}

// PACKET_SEND_ALLOWED_DOMAINS: unset → 'fstrucks.com' (safe default). Set to '*' to allow any domain
// (only once Postmark is out of test mode and Marc OKs it). Empty string also counts as the default.
export function allowedDomains(env = process.env) {
  const v = String(env.PACKET_SEND_ALLOWED_DOMAINS ?? '').trim();
  if (v === '*') return null;
  return (v || 'fstrucks.com').split(/[,\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}
export function blockedRecipients(emails, domains) {
  if (!domains) return [];
  const seen = new Set();
  return emails.filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return !domains.includes(k.split('@')[1]); });
}

// Reply-To for an outgoing email: the company's own Reply-to email (company profile) when set and valid,
// else the PACKET_REPLY_TO one, else none. Never changes From (always the TMS sender).
export function companyReplyTo(profile, fallback = null) {
  const v = String(profile?.reply_to_email ?? '').trim();
  return v && isReplyToEmail(v) ? v : (fallback || null);
}
export function senderConfig(env = process.env) {
  return {
    from: (env.PACKET_FROM_EMAIL || 'noreply@fstrucks.com').trim(),
    replyTo: String(env.PACKET_REPLY_TO || '').trim() || null, // no built-in default
    token: env.POSTMARK_SERVER_TOKEN || null,
    stream: env.PACKET_MESSAGE_STREAM || 'outbound',
  };
}

export function attachmentName(p) {
  return `${String(p?.original_filename || p?.subject || 'carrier-packet').replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'carrier-packet'}-filled.pdf`;
}
// Editable defaults shown in the draft. companyName comes from the company profile.
export function defaultDraft(p, companyName) {
  const co = String(companyName || '').trim() || 'our company';
  const what = String(p?.subject || p?.original_filename || 'carrier packet').replace(/\.pdf$/i, '').replace(/^(re|fwd?):\s*/i, '');
  return {
    subject: `Completed carrier packet – ${co}`.slice(0, 200),
    body: `Hello,\n\nAttached is the completed carrier packet from ${co} (${what}).\n\nPlease reply to this email if you need anything else.\n\nThank you,\n${co}`,
  };
}

// Validates the user's send request. → { to, cc, subject, body } | { error, status, blocked? }
export function validateSend(b, env = process.env) {
  if (b?.confirm !== true) return { error: 'Review the email and confirm before sending.', status: 400 };
  const to = parseEmails(b.to, { label: 'email', required: true }); if (to.error) return { error: to.error, status: 422 };
  const cc = parseEmails(b.cc, { label: 'CC email' }); if (cc.error) return { error: cc.error, status: 422 };
  const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim();
  const body = String(b.body || '').trim();
  if (!subject) return { error: 'Add a subject.', status: 422 };
  if (subject.length > 200) return { error: 'Subject is too long.', status: 422 };
  if (!body) return { error: 'Add a message.', status: 422 };
  if (body.length > 10000) return { error: 'Message is too long.', status: 422 };
  const ccList = cc.list.filter((e) => !to.list.includes(e));
  // The domain limit applies to what the user typed (To + CC), exactly as before; the automatic copy is added after.
  const blocked = blockedRecipients([...to.list, ...ccList], allowedDomains(env));
  if (blocked.length) return { error: `Sending is limited to ${allowedDomains(env).join(', ')} for now. Not allowed: ${blocked.join(', ')}.`, status: 403, blocked };
  const autoCc = autoCcFor(packetCcEmail(env), to.list);
  return { to: to.list, cc: uniqueEmails([...ccList, ...(autoCc ? [autoCc] : [])]).map((e) => e.toLowerCase()), autoCc, subject, body };
}

// One Postmark /email call. fetchImpl is injected (tests use a mock; nothing real is sent in tests).
// → { messageId } | { error, code? } (definitely not sent) | { error, unknown: true } (timed out: may have sent).
// extra: more PDF attachments after the packet (PR #84 vault files, each its own PDF): [{ name, bytes }].
export async function postmarkSend({ token, from, replyTo, stream, to, cc, subject, body, pdf, filename, extra = [], timeoutMs = POSTMARK_TIMEOUT_MS }, fetchImpl = fetch) {
  const files = [...(pdf ? [{ name: filename, bytes: pdf }] : []), ...(extra || [])];
  const payload = {
    From: from, To: to.join(', '), ...(cc.length ? { Cc: cc.join(', ') } : {}), ...(replyTo ? { ReplyTo: replyTo } : {}),
    Subject: subject, TextBody: body, MessageStream: stream, TrackOpens: false,
    ...(files.length ? { Attachments: files.map((f) => ({ Name: f.name, Content: Buffer.from(f.bytes).toString('base64'), ContentType: 'application/pdf' })) } : {}),
  };
  let r;
  try {
    r = await fetchImpl('https://api.postmarkapp.com/email', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Only "couldn't connect at all" is a sure no-send. A timeout or a dropped connection after the request went
    // out may still have sent it, so the caller keeps the claim and the UI says "not confirmed".
    const code = e?.cause?.code || e?.code;
    if (!['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return { error: 'We lost contact with the email service, so we can’t tell if it sent. Check the send history before sending again.', unknown: true };
    return { error: 'Could not reach the email service. Nothing was sent.' };
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.ErrorCode && j.ErrorCode !== 0)) {
    console.error('[packets] postmark', r.status, j.ErrorCode, j.Message);
    // 412 = account pending approval (test mode: only same-domain recipients). 406 = inactive recipient.
    const hint = j.ErrorCode === 412 ? ' The email account is still in test mode and can only send to company addresses.' : '';
    return { error: `The email service refused the message${j.Message ? `: ${j.Message}` : ''}.${hint} Nothing was sent.`, code: j.ErrorCode ?? r.status };
  }
  return { messageId: j.MessageID || null, submittedAt: j.SubmittedAt || null };
}

// Rate con email-in: ratecon+<token>@in.fstrucks.com → rate_confirmation documents (drafts for review).
// Called by app/api/inbound/postmark/route.js after Basic auth. Never logs bodies, tokens or file contents.
// A load is never created here: the user reviews the draft on Documents and taps "Create load".
import { createHash } from 'node:crypto';
import { emailOf, safeName } from './postmarkInbound.js';
import { callRateConModel, pdfTextOf, pickModel } from './rateconExtract.js';
import { classifyDocText, decideDocKind } from './docClassify.js';
import { parseWeightLb } from './loadWeight.js';
import { parseTripMiles } from './loadMiles.js';

export { RATECON_DOMAIN, RATECON_LOCAL, rateconAddress } from './rateconDrafts.js';
import { RATECON_DOMAIN, RATECON_LOCAL } from './rateconDrafts.js';
const ADDR_RE = new RegExp(`^${RATECON_LOCAL}(?:\\+([^@]*))?@${RATECON_DOMAIN.replace(/\./g, '\\.')}$`, 'i');
const TOKEN_RE = /^[a-f0-9]{32}$/;

// Every recipient Postmark gives us (OriginalRecipient first, then To/Cc/Bcc, structured and raw).
function recipients(p) {
  const out = [];
  const add = (v) => { const e = emailOf(v); if (e) out.push(e); };
  add(p?.OriginalRecipient);
  for (const k of ['ToFull', 'CcFull', 'BccFull']) for (const r of Array.isArray(p?.[k]) ? p[k] : []) add(r?.Email);
  for (const k of ['To', 'Cc', 'Bcc']) for (const part of String(p?.[k] || '').split(',')) add(part);
  return out;
}

// null = not a rate con email (the packet path handles it). Otherwise { token } where token is null when the
// address has no / a malformed token (dropped quietly, never treated as a packet).
export function rateconRecipient(p) {
  for (const e of recipients(p)) {
    const m = ADDR_RE.exec(e);
    if (m) { const t = (m[1] || '').toLowerCase(); return { token: TOKEN_RE.test(t) ? t : null }; }
  }
  return null;
}

// Empty allowlist = anyone who has the secret address. Entries are full emails or '@domain'.
export function senderAllowed(list, email) {
  const l = (list || []).map((x) => String(x).toLowerCase());
  if (!l.length) return true;
  const e = String(email || '').toLowerCase();
  const at = e.lastIndexOf('@');
  return l.includes(e) || (at > 0 && l.includes(e.slice(at)));
}

export const rateconMessageId = (p, mail) => `ratecon:${p?.MessageID || mail.messageId}`;
export const rateconPath = (userId, name, now = Date.now(), i = 0) => `${userId}/ratecons/email-${now}-${i}-${safeName(name)}`;
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

const json = (body, status = 200) => Response.json(body, { status });
export const pdfSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Content dedupe: drops PDFs this owner already received by email (same sha256 of the bytes, any time; a
// deleted draft no longer counts) and repeats inside the same email. Returns { keep, dups }; each kept PDF
// carries .sha256. Missing column (migration 20261019000300 not applied) → no dedupe, nothing breaks.
export async function dedupeRateconPdfs(sb, userId, pdfs) {
  const withHash = pdfs.map((p) => ({ ...p, sha256: pdfSha256(p.bytes) }));
  if (!withHash.length) return { keep: [], dups: [] };
  let seen = new Set();
  const { data, error } = await sb.from('documents').select('content_sha256').eq('user_id', userId).eq('source', 'email')
    .in('content_sha256', [...new Set(withHash.map((p) => p.sha256))]);
  if (error) console.error('[inbound ratecon] dedupe lookup', error.code);
  else seen = new Set((data || []).map((r) => r.content_sha256));
  const keep = [], dups = [];
  for (const p of withHash) {
    if (seen.has(p.sha256)) { dups.push({ name: p.name, reason: 'duplicate' }); continue; }
    seen.add(p.sha256); keep.push(p);
  }
  return { keep, dups, hashColumn: !error };
}

// The company an emailed rate con belongs to (company_profiles.id): the one this user owns, else the company where
// they're on the office team (owner / management / dispatcher). Drafts then show for that company's whole office
// team (migration 20261022150000). null when neither (the row still saves, visible to the receiver only).
export const OFFICE_ROLES = ['owner', 'management', 'dispatcher'];
export async function rateconCompanyFor(sb, userId) {
  const { data: prof } = await sb.from('company_profiles').select('id').eq('owner_id', userId).limit(1).maybeSingle();
  if (prof?.id) return prof.id;
  const { data: mem } = await sb.from('company_members').select('profile_id, role').eq('user_id', userId).in('role', OFFICE_ROLES).limit(1).maybeSingle();
  return mem?.profile_id || null;
}

// Handles one rate con email. Always 200 for anything Postmark shouldn't retry (unknown token, blocked sender,
// duplicate, no PDFs). 500 only when nothing was saved, so a Postmark retry can try again.
export async function handleRateconEmail({ sb, payload, mail, token, deps = {} }) {
  const messageId = rateconMessageId(payload, mail);
  const { data: dup } = await sb.from('inbound_emails').select('id').eq('provider', 'postmark').eq('message_id', messageId).maybeSingle();
  if (dup) return json({ ok: true, duplicate: true });

  let owner = null;
  if (token) {
    const { data, error } = await sb.rpc('ratecon_owner_for_token', { p_token: token });
    if (error) { console.error('[inbound ratecon] token lookup', error.code); return json({ error: 'Match failed' }, 500); }
    owner = (Array.isArray(data) ? data[0] : data) || null;
  }
  const base = { provider: 'postmark', kind: 'ratecon', message_id: messageId, from_email: mail.fromEmail, to_emails: null, cc_emails: null,
    subject: mail.subject, in_reply_to: mail.inReplyTo, references_header: mail.references, headers: [], rejected_attachments: mail.rejected };
  // Unknown / rotated token or a sender not on the allowlist: record the drop (no address, no files), answer 200,
  // never bounce (a bounce would confirm the address exists).
  const dropReason = !owner?.user_id ? 'unknown_token' : !senderAllowed(owner.allowed_senders, mail.fromEmail) ? 'sender_not_allowed' : null;
  if (dropReason) {
    console.log('[inbound ratecon] dropped', dropReason, token ? shortHash(token) : 'no-token');
    await sb.from('inbound_emails').insert({ ...base, owner_id: null, status: 'unmatched', attachment_count: 0, rejected_attachments: [] });
    return json({ ok: true, matched: false });
  }
  const userId = owner.user_id;
  // Tag the row with the receiving company (company_profiles.id) so Documents can scope its notices. Best effort.
  const companyId = await rateconCompanyFor(sb, userId);
  const { keep: pdfs, dups, hashColumn } = await dedupeRateconPdfs(sb, userId, mail.pdfs);
  const rejected = [...mail.rejected, ...dups];
  const { data: email, error: eErr } = await sb.from('inbound_emails')
    .insert({ ...base, rejected_attachments: rejected, owner_id: userId, company_id: companyId, status: pdfs.length ? 'matched' : 'rejected', attachment_count: pdfs.length }).select('id').single();
  if (eErr) {
    if (eErr.code === '23505') return json({ ok: true, duplicate: true }); // a parallel retry won the race
    console.error('[inbound ratecon] email insert', eErr.code); return json({ error: 'Save failed' }, 500);
  }

  const now = (deps.now || Date.now)(); const created = [];
  for (const [i, pdf] of pdfs.entries()) {
    const path = rateconPath(userId, pdf.name, now, i);
    const { error: upErr } = await sb.storage.from('documents').upload(path, pdf.bytes, { contentType: 'application/pdf' });
    if (upErr) { console.error('[inbound ratecon] upload', upErr.message); continue; }
    const { data: doc, error: dErr } = await sb.from('documents').insert({ user_id: userId, doc_type: 'rate_confirmation', file_path: path,
      original_filename: pdf.name, source: 'email', inbound_email_id: email.id, extraction_status: 'pending', ...(hashColumn ? { content_sha256: pdf.sha256 } : {}) }).select('id').single();
    if (dErr) { await sb.storage.from('documents').remove([path]); console.error('[inbound ratecon] document insert', dErr.code); continue; }
    created.push({ id: doc.id, bytes: pdf.bytes, name: pdf.name });
  }
  // Reading runs after we answer Postmark (waitUntil keeps the function alive, within maxDuration), one PDF at a time.
  if (created.length) {
    const run = (async () => { for (const d of created) await (deps.extract || extractEmailRateCon)({ sb, userId, docId: d.id, bytes: d.bytes, name: d.name, deps }).catch(() => {}); })();
    (deps.waitUntil || ((p) => p))(run);
  }
  return json({ ok: true, matched: true, ratecons: created.length, rejected: rejected.length, duplicates: dups.length });
}

// Runs the existing rate con reader on one emailed PDF. Any failure keeps the file and marks it failed, so it
// shows on Documents as "Needs manual entry" (Run extraction retries through /api/extract).
export async function extractEmailRateCon({ sb, userId, docId, bytes, name, deps = {} }) {
  const env = deps.env || process.env;
  const mark = (patch) => sb.from('documents').update(patch).eq('id', docId).eq('user_id', userId);
  const failed = (reason) => mark({ extraction_status: 'failed', extraction_error: reason });
  if (!env.OPENAI_API_KEY) return failed('not_configured');
  const { data: runId, error: claimErr } = await sb.rpc('claim_extraction_slot', { p_user: userId, p_document: docId });
  if (claimErr) { console.error('[inbound ratecon] claim', claimErr.code); return failed('error'); }
  if (!runId) return failed('rate_limited');
  const finish = (status) => sb.from('extraction_runs').update({ status }).eq('id', runId);
  const pdfText = await (deps.pdfText || pdfTextOf)(bytes);
  if (classifyDocText(pdfText) === 'coi') { await finish('success'); return failed('not_ratecon'); }
  const ai = await (deps.callModel || callRateConModel)({ apiKey: env.OPENAI_API_KEY, model: pickModel(env.OPENAI_MODEL), mime: 'application/pdf', name, bytes });
  if (!ai.ok) { await finish(ai.status); console.error('[inbound ratecon] read', ai.log?.[0]); return failed(ai.status); }
  const { document_kind: aiKind, heading_text: aiText, ...loadData } = ai.extracted || {};
  if (decideDocKind({ pdfText, aiKind, aiText }) === 'coi' || aiKind === 'other') { await finish('success'); return failed('not_ratecon'); }
  const extracted = { ...loadData, total_miles: parseTripMiles(loadData.total_miles), weight_lb: parseWeightLb(loadData.weight) };
  const empty = !extracted.rate && !extracted.pickup && !extracted.delivery && !extracted.broker_name;
  const { error } = await mark(empty ? { extraction_status: 'failed', extraction_error: 'nothing_read', ai_extracted_data: null }
    : { extraction_status: 'done', extraction_error: null, ai_extracted_data: extracted });
  await finish(error ? 'error' : 'success');
  if (error) console.error('[inbound ratecon] save', error.code);
}


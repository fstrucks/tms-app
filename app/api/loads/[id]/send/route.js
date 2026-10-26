// Email the load export packet (Marc, Oct 25). Same people and statuses as the Export download: owner, management
// and dispatchers of the load's company; delivered / invoiced / paid loads. Same PDF and file name as the download.
//   GET  → { sends, configured, maxTo, prefill, from, replyTo, sendCap, maxBytes } (history degrades if the table is missing)
//   POST { to, note, sel, idempotencyKey, confirm: true, confirmAccounting?, tz } → sends ONE email via Postmark
//
// Fails closed: no Postmark token, no load_packet_sends table, cap reached, a bad recipient
// (more than EXPORT_MAX_TO, internal/reserved domain, or the TMS sender itself), or a PDF over SEND_MAX_BYTES → nothing is sent.
// Duplicate protection (same approach as /api/packets/[id]/send): the client makes one uuid per send attempt; it is
// the load_packet_sends row id. The row is claimed BEFORE Postmark is called, so a double click or a retry with the
// same id never sends twice. postmark_message_id is filled in after Postmark accepts it.
// Any recipient domain is allowed (Marc, Oct 26); PACKET_SEND_ALLOWED_DOMAINS applies only to packet and COI sends.
// No automatic CC (never accounting), and the From address is never marc@.
import { randomUUID } from 'node:crypto';
import { billingCtx, json, invoiceContext } from '../../../../lib/invoiceServer';
import { canExportStatus, prefillRecipient, accountingRecipients, sendEmailText, SEND_MAX_BYTES, SEND_MIGRATION, NOTE_MAX, EXPORT_MAX_TO, exportRecipientProblem } from '../../../../lib/loadExport';
import { brokerForLoad } from '../../../../lib/invoice';
import { loadExportDocs, readSelection, buildLoadPacket } from '../../../../lib/loadExportServer';
import { parseEmails, senderConfig, companyReplyTo, postmarkSend, POSTMARK_TIMEOUT_MS } from '../../../../lib/packetSend';
import { monthlyUsage, capReached, CAP_MSG } from '../../../../lib/sendCap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 60; // building the PDF (same as the download) + Postmark's 20 s timeout

const T = 'load_packet_sends';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_YET = { error: 'The export is available once the load is delivered.' };
const SETUP = { error: 'Sending needs a database update that hasn’t been applied yet. Nothing was sent.', setupNeeded: true, migration: SEND_MIGRATION };
const NO_TOKEN = { error: 'Email sending isn’t set up yet (missing Postmark token). Nothing was sent.', notConfigured: true };
const missingTable = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|Could not find the table/i.test(e.message || ''));
const isMarc = (e) => /^marc@/i.test(String(e || '').trim());

// The From address is noreply@ unless PACKET_FROM_EMAIL says otherwise; refuse marc@ outright.
// Reply-To: the company's Reply-to email (company profile) when set; else PACKET_REPLY_TO, dropped if it is marc@
// (the env default never routes replies to Marc); else none. A company may choose any address for its own replies.
function sender(env, profile) {
  const cfg = senderConfig(env);
  const envReply = env.PACKET_REPLY_TO && !isMarc(env.PACKET_REPLY_TO) ? String(env.PACKET_REPLY_TO).trim() : null;
  return { ...cfg, replyTo: companyReplyTo(profile, envReply), badFrom: isMarc(cfg.from) };
}
// The company's Reply-to email. select('*') so a database without the column (migration not applied) still works,
// and any read error just means "not set": it never blocks a send.
async function companyReplyRow(svc, ownerId) {
  try { const { data } = await svc.from('company_profiles').select('*').eq('owner_id', ownerId).maybeSingle(); return data || null; } catch { return null; }
}
function brokerCandidates(load, brokers) {
  const b = brokerForLoad(load, brokers);
  return [b?.contact_email, ...(b?.emails || []), ...(b?.billing_emails || [])].filter(Boolean);
}
async function names(x, ids) {
  const out = {};
  const admin = x.svc?.auth?.admin;
  for (const id of ids) {
    if (id === x.c.user?.id) { out[id] = 'You'; continue; }
    try { const { data } = admin?.getUserById ? await admin.getUserById(id) : { data: null }; const u = data?.user; out[id] = u?.user_metadata?.full_name || u?.email || 'Team member'; }
    catch { out[id] = 'Team member'; }
  }
  return out;
}
const shape = (r, who = {}) => ({ id: r.id, sent_at: r.sent_at, sent_by: r.sent_by, by: who[r.sent_by] || (r.sent_by ? 'Team member' : 'Removed user'), to: r.to_emails || [],
  with_invoice: !!r.with_invoice, size_bytes: r.size_bytes ?? null, confirmed: !!r.postmark_message_id });
async function history(x, loadId) {
  const { data, error } = await x.svc.from(T).select('*').eq('load_id', loadId).order('sent_at', { ascending: false });
  if (error) return { error };
  const rows = data || [];
  const who = await names(x, [...new Set(rows.map((r) => r.sent_by).filter(Boolean))]);
  return { rows, sends: rows.map((r) => shape(r, who)) };
}

export async function GET(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res;
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false });
  if (ctx.res) return ctx.res;
  const { load, brokers } = ctx;
  if (!canExportStatus(load.status)) return json(NOT_YET, 409);
  const env = deps?.env || process.env;
  const cfg = sender(env, await companyReplyRow(x.svc, x.c.ownerId));
  const h = await history(x, load.id);
  const u = await monthlyUsage(x.svc, env);
  return json({
    sends: h.sends || [], ...(h.error ? (missingTable(h.error) ? { setupNeeded: true, migration: SEND_MIGRATION } : { historyError: true }) : {}),
    configured: !!cfg.token && !cfg.badFrom, from: cfg.from, replyTo: cfg.replyTo, maxTo: EXPORT_MAX_TO, prefill: prefillRecipient(brokerCandidates(load, brokers)),
    sendCap: u.error ? null : { used: u.used, cap: u.cap, remaining: u.remaining }, maxBytes: SEND_MAX_BYTES,
  });
}

export async function POST(req, { params, deps } = {}) {
  const x = await billingCtx(req, deps); if (x.res) return x.res; // drivers: 403
  const ctx = await invoiceContext(x, params?.id, { autoDraft: false });
  if (ctx.res) return ctx.res;
  const { load, profile } = ctx;
  if (!canExportStatus(load.status)) return json(NOT_YET, 409);
  const env = deps?.env || process.env;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  if (!b || typeof b !== 'object') return json({ error: 'Bad request.' }, 400);
  if (b.confirm !== true) return json({ error: 'Review the email and confirm before sending.' }, 400);

  const to = parseEmails(b.to, { label: 'email', required: true });
  if (to.error) return json({ error: to.error.replace('broker ', '') }, 422);
  const bad = exportRecipientProblem(to.list, sender(env, null).from);
  if (bad) return json({ error: `${bad} Nothing was sent.` }, 422);
  const acct = accountingRecipients(to.list);
  if (acct.length && b.confirmAccounting !== true) return json({ error: `${acct.join(', ')} looks like an accounting address. Load paperwork normally goes to the broker contact. Confirm to send it there anyway.`, accountingConfirm: true, accounting: acct }, 409);
  const note = String(b.note || '').trim();
  if (note.length > NOTE_MAX) return json({ error: `The note is too long (max ${NOTE_MAX} characters).` }, 422);

  const cfg = sender(env, await companyReplyRow(x.svc, x.c.ownerId));
  if (!cfg.token) return json(NO_TOKEN, 503);
  if (cfg.badFrom) return json({ error: 'Email sending isn’t set up correctly (sender address). Nothing was sent.', notConfigured: true }, 503);
  const key = b.idempotencyKey == null ? (deps?.uuid || randomUUID)() : String(b.idempotencyKey).toLowerCase();
  if (!UUID.test(key)) return json({ error: 'Bad request (send id).' }, 400);

  // Same id seen before? Return that result; never send twice. Also proves the table exists before anything else.
  const prior = await x.svc.from(T).select('*').eq('id', key).maybeSingle();
  if (prior.error) return missingTable(prior.error) ? json(SETUP, 503) : json({ error: 'Could not check send history. Nothing was sent.' }, 500);
  if (prior.data) return repeat(prior.data, load.id);

  const usage = await monthlyUsage(x.svc, env);
  if (usage.error) return json({ error: 'Could not check this month’s email limit. Nothing was sent.' }, 503);
  if (capReached(usage)) return json({ error: CAP_MSG(usage), capReached: true, sendCap: { used: usage.used, cap: usage.cap, remaining: 0 } }, 429);

  const sel = readSelection(b.sel || {});
  const docs = await loadExportDocs(x, load);
  const pdf = await buildLoadPacket(x, ctx, docs, sel, String(b.tz || ''));
  if (pdf.error) return json({ error: pdf.error }, pdf.status);
  const size = pdf.bytes.byteLength;
  const max = deps?.maxBytes ?? SEND_MAX_BYTES; // tests pass a small limit instead of building a 7.5 MB PDF
  if (size > max) return json({ error: `This PDF is too large to email (${(size / 1e6).toFixed(1)} MB; the limit is ${max / 1e6} MB). Download it instead, or leave out some pictures. Nothing was sent.`, tooLarge: true, size_bytes: size, maxBytes: max }, 413);

  const inv = pdf.invoice;
  const row = { id: key, owner_id: x.c.ownerId, load_id: load.id, sent_by: x.c.user?.id || null, sent_at: new Date().toISOString(), to_emails: to.list,
    with_invoice: sel.invoice, invoice_id: sel.invoice && inv?.id ? inv.id : null, note: note || null, size_bytes: size, postmark_message_id: null };
  const claim = await x.svc.from(T).insert(row);
  if (claim.error) {
    if (claim.error.code === '23505') { // a concurrent request with the same id won the claim
      const { data: again } = await x.svc.from(T).select('*').eq('id', key).maybeSingle();
      if (again) return repeat(again, load.id);
    }
    console.error('[load-send] claim', claim.error.code);
    return missingTable(claim.error) ? json(SETUP, 503) : json({ error: 'Could not record the send. Nothing was sent. Try again.' }, 500);
  }

  const { subject, body } = sendEmailText({ load, companyName: profile?.legal_name, note, withInvoice: sel.invoice });
  const send = deps?.send || ((m) => postmarkSend(m, deps?.fetch || fetch));
  const r = await send({ token: cfg.token, from: cfg.from, replyTo: cfg.replyTo, stream: cfg.stream, to: to.list, cc: [], subject, body, pdf: pdf.bytes, filename: pdf.filename, timeoutMs: POSTMARK_TIMEOUT_MS });
  if (r.error && !r.unknown) { // definitely not sent: release the claim so history stays truthful and the same id can retry
    const { error: dErr } = await x.svc.from(T).delete().eq('id', key);
    if (dErr) console.error('[load-send] claim release', dErr.code);
    return json({ error: r.error, code: r.code }, 502);
  }
  if (r.error) { console.error('[load-send] result unknown', key); return json({ error: r.error, unknown: true, id: key }, 504); }

  // Sent. Nothing below may turn this into an error (the email is already out).
  const now = new Date().toISOString();
  let warning = null;
  try {
    const u1 = await x.svc.from(T).update({ postmark_message_id: r.messageId || 'sent', sent_at: now }).eq('id', key);
    if (u1.error) { console.error('[load-send] log update FAILED (email was sent)', u1.error.code); warning = 'The email was sent, but saving it to the history failed.'; }
  } catch (e) { console.error('[load-send] log update threw (email was sent)', e?.message); warning = 'The email was sent, but saving it to the history failed.'; }
  const h = await history(x, load.id).catch(() => ({}));
  return json({ ok: true, id: key, messageId: r.messageId || null, sent_at: now, to: to.list, filename: pdf.filename, size_bytes: size,
    sendCap: { used: usage.used + 1, cap: usage.cap, remaining: Math.max(0, usage.cap - usage.used - 1) }, sends: h.sends || [], ...(warning ? { warning } : {}) });
}

function repeat(r, loadId) {
  if (r.load_id !== loadId) return json({ error: 'Bad request (send id already used). Nothing was sent.' }, 409);
  if (r.postmark_message_id) return json({ ok: true, duplicate: true, id: r.id, messageId: r.postmark_message_id, sent_at: r.sent_at, to: r.to_emails || [] });
  return json({ error: 'This send is still being processed or its result is unknown. Check the Sent list before sending again.', pending: true, id: r.id }, 409);
}

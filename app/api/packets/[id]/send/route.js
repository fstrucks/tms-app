import { serviceClient, packetAccess, isMissingSchema } from '../../../../lib/packetServer';
import { canSend, validateSend, senderConfig, allowedDomains, defaultDraft, attachmentName, postmarkSend, SEND_MIGRATION } from '../../../../lib/packetSend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 60;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const SETUP = { error: 'Sending needs a database update that hasn’t been applied yet. Nothing was sent.', migration: SEND_MIGRATION };

async function history(sb, packetId) {
  const { data, error } = await sb.from('packet_sends').select('*').eq('packet_id', packetId).order('sent_at', { ascending: false });
  if (error) return { error };
  return { rows: (data || []).map((r) => ({ id: r.id, sent_at: r.sent_at, sent_by: r.sent_by, to: r.to_emails, cc: r.cc_emails, subject: r.subject, postmark_message_id: r.postmark_message_id })) };
}

// Draft defaults + send history. Any member may view history; only owner/management get canSend.
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const env = deps?.env || process.env;
  const { data: profile } = await sb.from('company_profiles').select('*').eq('owner_id', a.packet.owner_id).maybeSingle();
  const h = await history(sb, a.packet.id);
  const cfg = senderConfig(env);
  return json({
    canSend: canSend(a.role), filled: !!a.packet.filled_path, filled_at: a.packet.filled_at ?? null, sent_at: a.packet.sent_at ?? null,
    from: cfg.from, replyTo: cfg.replyTo, allowedDomains: allowedDomains(env), configured: !!cfg.token,
    draft: defaultDraft(a.packet, profile?.legal_name), filename: attachmentName(a.packet),
    sends: h.rows || [], ...(h.error && isMissingSchema(h.error) ? { setupNeeded: true, migration: SEND_MIGRATION } : {}),
  });
}

// Body: { to, cc, subject, body, confirm: true }. Sends the latest filled PDF via Postmark ONLY on this explicit
// request (the UI has a separate review + confirm step). Owner/management only. Logged on the packet.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canSend(a.role)) return json({ error: 'Only the owner or management can send packets.' }, 403);
  const env = deps?.env || process.env;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const v = validateSend(b, env);
  if (v.error) return json({ error: v.error, ...(v.blocked ? { blocked: v.blocked } : {}) }, v.status);
  if (!a.packet.filled_path) return json({ error: 'Fill the packet first, then send it.' }, 409);
  const cfg = senderConfig(env);
  if (!cfg.token) return json({ error: 'Email sending isn’t set up yet (missing Postmark token). Nothing was sent.' }, 503);
  // Make sure the log table exists BEFORE sending, so every real send can be recorded.
  const pre = await sb.from('packet_sends').select('id').eq('packet_id', a.packet.id).limit(1);
  if (pre.error) return isMissingSchema(pre.error) ? json(SETUP, 503) : json({ error: 'Could not check send history. Nothing was sent.' }, 500);
  const { data: pdfBlob } = await sb.storage.from('documents').download(a.packet.filled_path);
  if (!pdfBlob) return json({ error: 'Could not open the filled PDF. Fill the packet again. Nothing was sent.' }, 404);
  const pdf = new Uint8Array(await pdfBlob.arrayBuffer());
  const r = await postmarkSend({ ...cfg, to: v.to, cc: v.cc, subject: v.subject, body: v.body, pdf, filename: attachmentName(a.packet) }, deps?.fetch || fetch);
  if (r.error) return json({ error: r.error, code: r.code }, 502);
  const now = new Date().toISOString();
  const row = { packet_id: a.packet.id, owner_id: a.packet.owner_id, sent_by: a.user.id, sent_at: now, to_emails: v.to, cc_emails: v.cc, from_email: cfg.from, reply_to: cfg.replyTo || null, subject: v.subject, filled_path: a.packet.filled_path, postmark_message_id: r.messageId };
  const { error: iErr } = await sb.from('packet_sends').insert(row);
  if (iErr) console.error('[packets] send log FAILED (email was sent)', iErr.code, r.messageId);
  const { error: pErr } = await sb.from('packets').update({ status: 'sent', sent_at: now, sent_by: a.user.id }).eq('id', a.packet.id);
  if (pErr) console.error('[packets] send status', pErr.code);
  const h = await history(sb, a.packet.id);
  return json({ ok: true, messageId: r.messageId, sent_at: now, logged: !iErr, sends: h.rows || [] });
}

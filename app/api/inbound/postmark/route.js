import { createClient } from '@supabase/supabase-js';
import { noStoreFetch } from '../../../lib/noStoreFetch';
import { waitUntil } from '@vercel/functions';
import { processPacket } from '../../../lib/packetProcess';
import { checkBasicAuth, parseInbound, packetPath } from '../../../lib/postmarkInbound';
import { brokerSender } from '../../../lib/packetFingerprint';
import { savePacketLayout } from '../../../lib/packetLayouts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (body, status = 200) => Response.json(body, { status });

// Postmark inbound webhook. Basic auth vs POSTMARK_INBOUND_USER / POSTMARK_INBOUND_PASSWORD.
// Unmatched senders: logged, no files stored, 200 (so Postmark doesn't retry). Never logs contents.
export async function POST(req, { deps } = {}) {
  const auth = checkBasicAuth(req.headers.get('authorization'), process.env.POSTMARK_INBOUND_USER, process.env.POSTMARK_INBOUND_PASSWORD);
  if (!auth.configured) { console.error('[inbound] POSTMARK_INBOUND_USER/PASSWORD not set'); return json({ error: 'Inbound not configured' }, 503); }
  if (!auth.ok) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="inbound"' } });

  const sb = deps?.supabase || (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, global: { fetch: noStoreFetch } }) : null);
  if (!sb) { console.error('[inbound] SUPABASE_SERVICE_ROLE_KEY not set'); return json({ error: 'Storage not configured' }, 503); }

  let mail;
  try { mail = parseInbound(await req.json()); } catch (e) { return json({ error: e.message }, 400); }

  const { data: dup } = await sb.from('inbound_emails').select('id').eq('provider', 'postmark').eq('message_id', mail.messageId).maybeSingle();
  if (dup) return json({ ok: true, duplicate: true });

  const { data: ownerId, error: mErr } = await sb.rpc('packet_owner_for_email', { p_email: mail.fromEmail });
  if (mErr) { console.error('[inbound] match', mErr.code); return json({ error: 'Match failed' }, 500); }

  const base = { provider: 'postmark', message_id: mail.messageId, from_email: mail.fromEmail, to_emails: mail.to, cc_emails: mail.cc, subject: mail.subject,
    in_reply_to: mail.inReplyTo, references_header: mail.references, headers: mail.headers, rejected_attachments: mail.rejected, owner_id: ownerId || null };
  if (!ownerId) {
    await sb.from('inbound_emails').insert({ ...base, status: 'unmatched', attachment_count: 0 });
    return json({ ok: true, matched: false });
  }
  const status = mail.pdfs.length ? 'matched' : 'rejected';
  const { data: email, error: eErr } = await sb.from('inbound_emails').insert({ ...base, status, attachment_count: mail.pdfs.length }).select('id').single();
  if (eErr) { console.error('[inbound] email insert', eErr.code); return json({ error: 'Save failed' }, 500); }

  const now = Date.now(); let created = 0;
  for (const [i, pdf] of mail.pdfs.entries()) {
    const path = packetPath(ownerId, pdf.name, now, i);
    const { error: upErr } = await sb.storage.from('documents').upload(path, pdf.bytes, { contentType: 'application/pdf' });
    if (upErr) { console.error('[inbound] upload', upErr.message); continue; }
    const { data: pRow, error: pErr } = await sb.from('packets').insert({ owner_id: ownerId, source: 'email', inbound_email_id: email.id, subject: mail.subject, file_path: path, original_filename: pdf.name, size_bytes: pdf.size, status: 'received' }).select('id').single();
    if (pErr) { await sb.storage.from('documents').remove([path]); console.error('[inbound] packet insert', pErr.code); continue; }
    created++;
    // Broker identity for remembered layouts: the forwarded From: (Marc/dispatch forward the broker's email),
    // then Reply-To, then From when it isn't one of ours. Its own update, so a missing column never blocks the packet.
    const sender = brokerSender({ textBody: mail.textBody, replyTo: mail.replyTo, from: mail.fromEmail, ourEmails: [mail.fromEmail] });
    if (pRow?.id && sender.email) await savePacketLayout(sb, pRow.id, { broker_email: sender.email });
    // Detection runs after we answer Postmark (waitUntil keeps the function alive, within maxDuration).
    if (pRow?.id) (deps?.waitUntil || waitUntil)((deps?.process || processPacket)({ sb, packetId: pRow.id }).catch(() => {}));
  }
  return json({ ok: true, matched: true, packets: created, rejected: mail.rejected.length });
}

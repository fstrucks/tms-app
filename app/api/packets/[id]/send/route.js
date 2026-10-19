import { serviceClient, packetAccess, isMissingSchema } from '../../../../lib/packetServer';
import { randomUUID } from 'node:crypto';
import { monthlyUsage, capReached, CAP_MSG } from '../../../../lib/sendCap';
import { vaultSendOptions, loadVaultAttachments } from '../../../../lib/vaultSend';
import { fileSizes } from '../../../../lib/vaultServer';
import { MAX_SEND_RAW_BYTES } from '../../../../lib/companyDocs';
import { canSend, validateSend, packetCcEmail, senderConfig, allowedDomains, defaultDraft, attachmentName, postmarkSend, SEND_MIGRATION, POSTMARK_TIMEOUT_MS } from '../../../../lib/packetSend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
// Postmark is given POSTMARK_TIMEOUT_MS (20 s); the rest is a few Supabase round trips. 30 s leaves headroom
// without letting a stuck call hang the user's Send button for a minute.
export const maxDuration = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const SETUP = { error: 'Sending needs a database update that hasn’t been applied yet. Nothing was sent.', migration: SEND_MIGRATION };

// confirmed = Postmark accepted it. A row without a message id is a claimed attempt whose result is unknown.
const shape = (r) => ({ id: r.id, sent_at: r.sent_at, sent_by: r.sent_by, to: r.to_emails || [], cc: r.cc_emails || [], subject: r.subject, postmark_message_id: r.postmark_message_id, confirmed: !!r.postmark_message_id, attached: Array.isArray(r.attached_document_ids) ? r.attached_document_ids : [] });
async function history(sb, packetId) {
  const { data, error } = await sb.from('packet_sends').select('*').eq('packet_id', packetId).order('sent_at', { ascending: false });
  if (error) return { error };
  return { rows: (data || []).map(shape) };
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
  const u = await monthlyUsage(sb, env);
  // PR #84: current vault files offered as extra attachments (owner/management only; W-9 / NOA are theirs to see).
  let vault = null;
  // Never let the vault part break the draft: on any failure the panel still shows, with the packet PDF only.
  if (canSend(a.role)) {
    try {
      const v = await vaultSendOptions(sb, a.packet.owner_id, { profile });
      const sizes = a.packet.filled_path ? await fileSizes(sb, [a.packet.filled_path]) : {};
      vault = { options: v.options || [], packetSize: sizes[a.packet.filled_path] ?? null, maxRaw: MAX_SEND_RAW_BYTES };
    } catch (e) { console.error('[packets] send vault options', e?.message); vault = { options: [], packetSize: null, maxRaw: MAX_SEND_RAW_BYTES, error: true }; }
  }
  return json({
    vault,
    sendCap: u.error ? null : { used: u.used, cap: u.cap, remaining: u.remaining },
    canSend: canSend(a.role), filled: !!a.packet.filled_path, filled_at: a.packet.filled_at ?? null, sent_at: a.packet.sent_at ?? null,
    from: cfg.from, replyTo: cfg.replyTo, autoCc: packetCcEmail(env), allowedDomains: allowedDomains(env), configured: !!cfg.token,
    draft: defaultDraft(a.packet, profile?.legal_name), filename: attachmentName(a.packet),
    sends: h.rows || [], ...(h.error && isMissingSchema(h.error) ? { setupNeeded: true, migration: SEND_MIGRATION } : {}),
  });
}

// Body: { to, cc, subject, body, confirm: true, idempotencyKey: <uuid>, resend?: true }.
// Sends the latest filled PDF via Postmark ONLY on this explicit request (the UI has a separate review + confirm
// step). Owner/management only. Logged on the packet.
//
// Duplicate protection: the client makes one idempotencyKey (uuid) per send attempt and reuses it on retries.
// The key IS the packet_sends row id (primary key, so unique; no migration needed). We "claim" the row BEFORE
// calling Postmark; a repeat with the same key never calls Postmark again and gets the earlier result back.
// A claimed row with postmark_message_id = null means "send in progress / result unknown".
// If the packet already has a confirmed send, a new send also needs resend: true (UI asks "Send again?").
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canSend(a.role)) return json({ error: 'Only the owner or management can send packets.' }, 403);
  const env = deps?.env || process.env;
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const v = validateSend(b, env); // includes the server-side PACKET_SEND_ALLOWED_DOMAINS check on To + CC, then adds the PACKET_CC_EMAIL copy (logged in cc_emails)
  if (v.error) return json({ error: v.error, ...(v.blocked ? { blocked: v.blocked } : {}) }, v.status);
  const key = b.idempotencyKey == null ? (deps?.uuid || randomUUID)() : String(b.idempotencyKey).toLowerCase();
  if (!UUID.test(key)) return json({ error: 'Bad request (send id).' }, 400);
  if (!a.packet.filled_path) return json({ error: 'Fill the packet first, then send it.' }, 409);
  const cfg = senderConfig(env);
  if (!cfg.token) return json({ error: 'Email sending isn’t set up yet (missing Postmark token). Nothing was sent.' }, 503);

  // Repeat of an earlier attempt? Return its result; never send twice.
  const prior = await sb.from('packet_sends').select('*').eq('packet_id', a.packet.id).order('sent_at', { ascending: false });
  if (prior.error) return isMissingSchema(prior.error) ? json(SETUP, 503) : json({ error: 'Could not check send history. Nothing was sent.' }, 500);
  const rows = prior.data || [];
  const same = rows.find((r) => r.id === key);
  if (same) return repeat(same, rows);
  // Already sent (or an earlier attempt's result is unknown)? Only send again on an explicit "Send again".
  if (rows.length && b.resend !== true) {
    const last = rows.find((r) => r.postmark_message_id) || rows[0];
    return json({ error: last.postmark_message_id ? 'This packet was already sent. Confirm “Send again” to send it again.' : 'An earlier send of this packet wasn’t confirmed. Check with the broker, then confirm “Send again” if needed.', alreadySent: true, last: shape(last), sends: rows.map(shape) }, 409);
  }

  // Shared monthly cap (packet_sends + coi_requests). Checked before anything is claimed or sent.
  const usage = await monthlyUsage(sb, env);
  if (usage.error) return json({ error: 'Could not check this month’s email limit. Nothing was sent.' }, 503);
  if (capReached(usage)) return json({ error: CAP_MSG(usage), capReached: true, sendCap: { used: usage.used, cap: usage.cap, remaining: 0 } }, 429);

  const { data: pdfBlob } = await sb.storage.from('documents').download(a.packet.filled_path);
  if (!pdfBlob) return json({ error: 'Could not open the filled PDF. Fill the packet again. Nothing was sent.' }, 404);
  const pdf = new Uint8Array(await pdfBlob.arrayBuffer());
  // PR #84: ticked vault files (current versions only), each as its own PDF; packet + files capped at 7.5 MB raw /
  // 10 MB encoded. The recipients are still the ones validateSend() allowed above (#64 domain limit unchanged).
  const va = await loadVaultAttachments(sb, a.packet.owner_id, b.attachDocumentIds, pdf);
  if (va.error) return json({ error: va.error, ...(va.tooLarge ? { tooLarge: true } : {}), ...(va.refresh ? { refresh: true } : {}) }, va.status);

  const claimedAt = new Date().toISOString();
  const row = { id: key, packet_id: a.packet.id, owner_id: a.packet.owner_id, sent_by: a.user.id, sent_at: claimedAt, to_emails: v.to, cc_emails: v.cc, from_email: cfg.from, reply_to: cfg.replyTo || null, subject: v.subject, filled_path: a.packet.filled_path, postmark_message_id: null };
  // Pick 5B: record which vault versions went out. Until 20261018000500 is applied the column is missing:
  // claim again without it (the send still works; the list is only in the email).
  let claim = await sb.from('packet_sends').insert(va.ids.length ? { ...row, attached_document_ids: va.ids } : row);
  let recordedIds = va.ids.length > 0;
  if (claim.error && va.ids.length && isMissingSchema(claim.error)) { recordedIds = false; claim = await sb.from('packet_sends').insert(row); }
  if (claim.error) {
    if (claim.error.code === '23505') { // a concurrent request with the same key won the claim
      const { data: again } = await sb.from('packet_sends').select('*').eq('id', key).maybeSingle();
      if (again?.packet_id === a.packet.id) return repeat(again, rows);
      if (again) return json({ error: 'Bad request (send id already used). Nothing was sent.' }, 409);
    }
    console.error('[packets] send claim', claim.error.code);
    return isMissingSchema(claim.error) ? json(SETUP, 503) : json({ error: 'Could not record the send. Nothing was sent. Try again.' }, 500);
  }

  const r = await postmarkSend({ ...cfg, to: v.to, cc: v.cc, subject: v.subject, body: v.body, pdf, filename: attachmentName(a.packet), extra: va.attachments.map((x) => ({ name: x.name, bytes: x.bytes })), timeoutMs: POSTMARK_TIMEOUT_MS }, deps?.fetch || fetch);
  if (r.error && !r.unknown) {
    // Definitely not sent: release the claim so history stays truthful and the same key can retry.
    const { error: dErr } = await sb.from('packet_sends').delete().eq('id', key);
    if (dErr) console.error('[packets] send claim release', dErr.code);
    return json({ error: r.error, code: r.code }, 502);
  }
  if (r.error) { // timed out: Postmark may or may not have sent it. Keep the claim (shown as "not confirmed").
    console.error('[packets] postmark result unknown', key);
    return json({ error: r.error, unknown: true, id: key }, 504);
  }

  // Sent. From here on, nothing may turn this into an error response (the email is already out).
  const now = new Date().toISOString();
  const warnings = [];
  try {
    const [u1, u2] = await Promise.all([
      sb.from('packet_sends').update({ postmark_message_id: r.messageId || 'sent', sent_at: now }).eq('id', key),
      sb.from('packets').update({ status: 'sent', sent_at: now, sent_by: a.user.id }).eq('id', a.packet.id),
    ]);
    if (u1.error) { console.error('[packets] send log FAILED (email was sent)', u1.error.code, r.messageId); warnings.push('The email was sent, but saving it to the send history failed.'); }
    if (u2.error) console.error('[packets] send status', u2.error.code);
  } catch (e) {
    console.error('[packets] send log threw (email was sent)', e?.message, r.messageId);
    warnings.push('The email was sent, but saving it to the send history failed.');
  }
  const done = { ...row, ...(recordedIds ? { attached_document_ids: va.ids } : {}), sent_at: now, postmark_message_id: r.messageId || 'sent' };
  return json({ ok: true, id: key, messageId: r.messageId, sent_at: now, sendCap: { used: usage.used + 1, cap: usage.cap, remaining: Math.max(0, usage.cap - usage.used - 1) }, logged: !warnings.length, attachedCount: va.ids.length, ...(warnings.length ? { warning: warnings[0] } : {}), sends: [shape(done), ...rows.map(shape)] });
}

function repeat(r, rows) {
  const sends = rows.some((x) => x.id === r.id) ? rows.map(shape) : [shape(r), ...rows.map(shape)];
  if (r.postmark_message_id) return json({ ok: true, duplicate: true, id: r.id, messageId: r.postmark_message_id, sent_at: r.sent_at, logged: true, sends });
  return json({ error: 'This send is still being processed or its result is unknown. Check the send history before sending again.', pending: true, id: r.id, sends }, 409);
}

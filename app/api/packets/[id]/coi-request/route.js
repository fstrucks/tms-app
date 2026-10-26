import { serviceClient, packetAccess, isMissingSchema } from '../../../../lib/packetServer';
import { randomUUID } from 'node:crypto';
import { canSend, senderConfig, companyReplyTo, allowedDomains, postmarkSend, POSTMARK_TIMEOUT_MS } from '../../../../lib/packetSend';
import { monthlyUsage, capReached, CAP_MSG } from '../../../../lib/sendCap';
import { coiEnabled, defaultCoiDraft, validateCoiRequest, COI_MIGRATION } from '../../../../lib/coiRequest';
import { minimumsFrom } from '../../../../lib/coiGaps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const maxDuration = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const SETUP = { error: 'COI requests need a database update that hasn’t been applied yet. Nothing was sent.', setupNeeded: true, migration: COI_MIGRATION };
const OFF = { error: 'COI requests aren’t turned on yet. Nothing was sent.', disabled: true };

const shape = (r) => ({ id: r.id, sent_at: r.sent_at, sent_by: r.sent_by, to: r.to_emails || [], cc: r.cc_emails || [], subject: r.subject, cert_holder_name: r.cert_holder_name, load_date: r.load_date, postmark_message_id: r.postmark_message_id, confirmed: !!r.postmark_message_id });
const missing = (e) => isMissingSchema(e) || e?.code === 'PGRST205' || /Could not find the table/i.test(e?.message || '');

// Agent, confirmed/unconfirmed policies, minimums, draft, history and the monthly cap. Any member may view.
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const env = deps?.env || process.env;
  const owner = a.packet.owner_id;
  const [{ data: profile }, ag, pol, hist, u] = await Promise.all([
    sb.from('company_profiles').select('*').eq('owner_id', owner).maybeSingle(),
    sb.from('insurance_agents').select('*').eq('owner_id', owner).maybeSingle(),
    sb.from('insurance_policies').select('*').eq('owner_id', owner),
    sb.from('coi_requests').select('*').eq('packet_id', a.packet.id).order('sent_at', { ascending: false }),
    monthlyUsage(sb, env),
  ]);
  const setupNeeded = [ag.error, pol.error, hist.error].some(missing);
  const base = senderConfig(env);
  const cfg = { ...base, replyTo: companyReplyTo(profile, base.replyTo) }; // company Reply-to email first
  // Prefill the holder from this packet's last COI request (name + address), else the packet's broker name.
  const lastReq = (hist.data || [])[0];
  const certHolder = { name: lastReq?.cert_holder_name || a.packet.broker_name || '', address: lastReq?.cert_holder_address || a.packet.broker_address || '' };
  return json({
    enabled: coiEnabled(env), canSend: canSend(a.role), setupNeeded, ...(setupNeeded ? { migration: COI_MIGRATION } : {}),
    agent: ag.data || null, policies: pol.data || [], minimums: minimumsFrom(profile), certHolder,
    from: cfg.from, replyTo: cfg.replyTo, allowedDomains: allowedDomains(env), configured: !!cfg.token,
    draft: defaultCoiDraft({ packet: a.packet, profile, agent: ag.data, certHolder }),
    // Non-sensitive inputs so the client can rebuild the body from holder/load-date edits (coiTemplate.js).
    draftContext: { packet: { subject: a.packet.subject || null, original_filename: a.packet.original_filename || null }, profile: { legal_name: profile?.legal_name || null, mc_number: profile?.mc_number || null, min_auto_liability: profile?.min_auto_liability ?? null, min_cargo: profile?.min_cargo ?? null }, agent: { name: ag.data?.name || null } },
    requests: (hist.data || []).map(shape),
    sendCap: u.error ? null : { used: u.used, cap: u.cap, remaining: u.remaining },
  });
}

// Body: { to, cc, subject, body, certHolder: { name, address }, loadDate?, confirm: true, idempotencyKey, resend? }.
// Same review-and-confirm + claim-before-send pattern as /send. No attachment. Owner/management only.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const env = deps?.env || process.env;
  if (!coiEnabled(env)) return json(OFF, 403);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canSend(a.role)) return json({ error: 'Only the owner or management can request a COI.' }, 403);
  let b; try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const v = validateCoiRequest(b, env); // includes the fstrucks.com-only allowlist on To + CC
  if (v.error) return json({ error: v.error, ...(v.blocked ? { blocked: v.blocked } : {}) }, v.status);
  const key = b.idempotencyKey == null ? (deps?.uuid || randomUUID)() : String(b.idempotencyKey).toLowerCase();
  if (!UUID.test(key)) return json({ error: 'Bad request (send id).' }, 400);
  let profile = null;
  try { ({ data: profile } = await sb.from('company_profiles').select('*').eq('owner_id', a.packet.owner_id).maybeSingle()); } catch { profile = null; }
  const base = senderConfig(env);
  const cfg = { ...base, replyTo: companyReplyTo(profile, base.replyTo) };
  if (!cfg.token) return json({ error: 'Email sending isn’t set up yet (missing Postmark token). Nothing was sent.' }, 503);

  const prior = await sb.from('coi_requests').select('*').eq('packet_id', a.packet.id).order('sent_at', { ascending: false });
  if (prior.error) return missing(prior.error) ? json(SETUP, 503) : json({ error: 'Could not check request history. Nothing was sent.' }, 500);
  const rows = prior.data || [];
  const same = rows.find((r) => r.id === key);
  if (same) return repeat(same, rows);
  if (rows.length && b.resend !== true) {
    const last = rows.find((r) => r.postmark_message_id) || rows[0];
    return json({ error: last.postmark_message_id ? 'A COI was already requested for this packet. Confirm “Send again” to request again.' : 'An earlier COI request wasn’t confirmed. Check with the agent, then confirm “Send again” if needed.', alreadySent: true, last: shape(last), requests: rows.map(shape) }, 409);
  }

  const usage = await monthlyUsage(sb, env);
  if (usage.error) return json({ error: 'Could not check this month’s email limit. Nothing was sent.' }, 503);
  if (capReached(usage)) return json({ error: CAP_MSG(usage), capReached: true, sendCap: { used: usage.used, cap: usage.cap, remaining: 0 } }, 429);

  const row = { id: key, packet_id: a.packet.id, owner_id: a.packet.owner_id, sent_by: a.user.id, sent_at: new Date().toISOString(), to_emails: v.to, cc_emails: v.cc, from_email: cfg.from, reply_to: cfg.replyTo || null, subject: v.subject, cert_holder_name: v.certHolder.name, cert_holder_address: v.certHolder.address || null, load_date: v.loadDate, postmark_message_id: null };
  const claim = await sb.from('coi_requests').insert(row);
  if (claim.error) {
    if (claim.error.code === '23505') {
      const { data: again } = await sb.from('coi_requests').select('*').eq('id', key).maybeSingle();
      if (again?.packet_id === a.packet.id) return repeat(again, rows);
      if (again) return json({ error: 'Bad request (send id already used). Nothing was sent.' }, 409);
    }
    console.error('[coi] claim', claim.error.code);
    return missing(claim.error) ? json(SETUP, 503) : json({ error: 'Could not record the request. Nothing was sent. Try again.' }, 500);
  }

  const r = await postmarkSend({ ...cfg, to: v.to, cc: v.cc, subject: v.subject, body: v.body, pdf: null, filename: null, timeoutMs: POSTMARK_TIMEOUT_MS }, deps?.fetch || fetch);
  if (r.error && !r.unknown) {
    const { error: dErr } = await sb.from('coi_requests').delete().eq('id', key);
    if (dErr) console.error('[coi] claim release', dErr.code);
    return json({ error: r.error, code: r.code }, 502);
  }
  if (r.error) { console.error('[coi] postmark result unknown', key); return json({ error: r.error, unknown: true, id: key }, 504); }

  const now = new Date().toISOString();
  let warning = null;
  try {
    const u1 = await sb.from('coi_requests').update({ postmark_message_id: r.messageId || 'sent', sent_at: now }).eq('id', key);
    if (u1.error) { console.error('[coi] log FAILED (email was sent)', u1.error.code, r.messageId); warning = 'The email was sent, but saving it to the history failed.'; }
  } catch (e) { console.error('[coi] log threw (email was sent)', e?.message); warning = 'The email was sent, but saving it to the history failed.'; }
  const done = { ...row, sent_at: now, postmark_message_id: r.messageId || 'sent' };
  return json({ ok: true, id: key, messageId: r.messageId, sent_at: now, ...(warning ? { warning } : {}), requests: [shape(done), ...rows.map(shape)], sendCap: { used: usage.used + 1, cap: usage.cap, remaining: Math.max(0, usage.cap - usage.used - 1) } });
}

function repeat(r, rows) {
  const requests = rows.some((x) => x.id === r.id) ? rows.map(shape) : [shape(r), ...rows.map(shape)];
  if (r.postmark_message_id) return json({ ok: true, duplicate: true, id: r.id, messageId: r.postmark_message_id, sent_at: r.sent_at, requests });
  return json({ error: 'This request is still being processed or its result is unknown. Check the history before sending again.', pending: true, id: r.id, requests }, 409);
}

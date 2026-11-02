// "Rescan rate con" on a load (Nov 2). User-triggered only, never automatic.
//   POST { mode: 'preview' } → re-scans the load's rate con (counts toward the scan limit, same slot as /api/extract)
//                               and returns { changes, scan }. Nothing on the load is written.
//   POST { mode: 'apply', scan, accept: [key] } → re-plans against the load's CURRENT values and fills only the
//                               accepted, still-empty fields. Returns { applied, skipped }.
// Auth and data access use the caller's own session (RLS: own loads, stops, documents). The service client is only
// used for the scan-limit claim and run status, exactly like /api/extract. No SQL changes.
import { createClient } from '@supabase/supabase-js';
import { isAuthOutage } from '../../../../lib/authedFetch.js';
import { noStoreFetch } from '../../../../lib/noStoreFetch.js';
import { classifyDocText, decideDocKind } from '../../../../lib/docClassify.js';
import { callRateConModel, pdfTextOf, pickModel } from '../../../../lib/rateconExtract.js';
import { normalizeRateConStops } from '../../../../lib/rateconStops.js';
import { rescanScan, cleanScan, planRescan, rescanUpdates } from '../../../../lib/rateconRescan.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const LIMIT_PER_HOUR = 20;
const LIMIT_PER_DAY = 100;
const GENERIC = 'Couldn’t rescan the rate con. Please try again.';
const SUPPORTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const NOT_RATECON = ['coi', 'bol', 'scale_ticket'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP_COLS = 'id,stop_type,sequence,address_line1,city,state,zip,pickup_number';

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, msg, ...log) => { if (log.length) console.error('[rescan-ratecon]', ...log); return json({ error: msg }, status); };
const mimeOf = (t, name) => (t && t !== 'application/octet-stream' ? t : EXT_TYPES[(String(name).split('.').pop() || '').toLowerCase()] || null);

function clients(token, deps) {
  if (deps.userDb) return { userDb: deps.userDb, admin: deps.admin };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) return null;
  const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: noStoreFetch } };
  return {
    userDb: createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` }, fetch: noStoreFetch } }),
    admin: createClient(url, serviceKey, opts),
  };
}

async function ownLoad(userDb, userId, loadId) {
  const { data, error } = await userDb.from('loads').select(`id,user_id,notes,stops(${STOP_COLS})`).eq('id', loadId).eq('user_id', userId).maybeSingle();
  return { load: data || null, error };
}

export async function POST(req, { params, deps = {} } = {}) {
  const loadId = params?.id;
  if (!UUID.test(loadId || '')) return fail(404, 'Load not found.');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Please sign in again.');
  let body = {};
  try { body = (await req.json()) || {}; } catch {}
  const mode = body.mode;
  if (mode !== 'preview' && mode !== 'apply') return fail(400, 'Unknown request.');
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
  if (mode === 'preview' && !apiKey) return fail(501, 'Rate con scanning is not set up on this server.', 'scan key missing');
  const cl = clients(token, deps);
  if (!cl) return fail(500, 'Server configuration error.', 'missing env');
  const { userDb, admin } = cl;

  const { data: ud, error: ue } = await userDb.auth.getUser(token);
  const user = ud?.user;
  if (isAuthOutage(ue)) return fail(503, 'Couldn’t check your sign-in just now. Please try again.', ue?.message);
  if (ue || !user) return fail(401, 'Please sign in again.');

  const { load, error: le } = await ownLoad(userDb, user.id, loadId);
  if (le) return fail(500, GENERIC, 'load', le.message);
  if (!load) return fail(404, 'Load not found.');

  if (mode === 'apply') return apply(userDb, user, load, body);

  const { data: docs, error: de } = await userDb.from('documents').select('id,user_id,doc_type,file_path,original_filename')
    .eq('load_id', load.id).eq('user_id', user.id).eq('doc_type', 'rate_confirmation').order('created_at', { ascending: false }).limit(1);
  if (de) return fail(500, GENERIC, 'docs', de.message);
  const doc = docs?.[0];
  if (!doc) return fail(404, 'This load has no rate con to rescan.');
  if (typeof doc.file_path !== 'string' || !doc.file_path.startsWith(`${user.id}/`)) return fail(403, 'Not allowed.', 'file_path outside user folder', doc.id);

  const { data: runId, error: ce } = await admin.rpc('claim_extraction_slot', { p_user: user.id, p_document: doc.id });
  if (ce) return fail(500, GENERIC, 'claim slot', ce.message);
  if (!runId) return fail(429, `Scan limit reached (${LIMIT_PER_HOUR}/hour, ${LIMIT_PER_DAY}/day). Try again later.`);
  const finish = (status) => admin.from('extraction_runs').update({ status }).eq('id', runId);

  const { data: blob, error: dl } = await userDb.storage.from('documents').download(doc.file_path);
  if (dl || !blob) { await finish('error'); return fail(500, GENERIC, 'download', dl?.message); }
  if (blob.size > MAX_BYTES) { await finish('rejected'); return fail(413, 'File is too large to scan (max 10 MB).'); }
  const mime = mimeOf(blob.type, doc.file_path) || mimeOf(null, doc.original_filename || '');
  if (!SUPPORTED.includes(mime)) { await finish('rejected'); return fail(415, 'This file type can’t be scanned. Use PDF, JPEG, PNG or WebP.'); }
  const bytes = Buffer.from(await blob.arrayBuffer());
  const pdfText = mime === 'application/pdf' ? await (deps.pdfTextOf || pdfTextOf)(bytes) : '';
  if (NOT_RATECON.includes(classifyDocText(pdfText))) { await finish('rejected'); return fail(422, 'That document doesn’t look like a rate con.'); }
  const ai = await (deps.callModel || callRateConModel)({ apiKey, model: pickModel(process.env.OPENAI_MODEL), mime, name: doc.original_filename || doc.file_path, bytes });
  if (!ai.ok) {
    await finish(ai.status || 'error');
    if (ai.status === 'timeout') return fail(504, 'The scan timed out, please try again.', ...(ai.log || []));
    return fail(502, GENERIC, ...(ai.log || []));
  }
  const { document_kind: aiKind, heading_text: aiText, ...data } = ai.extracted || {};
  const kind = decideDocKind({ pdfText, aiKind, aiText });
  if (NOT_RATECON.includes(kind)) { await finish('rejected'); return fail(422, 'That document doesn’t look like a rate con.'); }
  await finish('success');
  const scan = rescanScan(normalizeRateConStops(data));
  return json({ documentId: doc.id, scan, changes: planRescan(load, scan) });
}

async function apply(userDb, user, load, body) {
  if (!body.scan || typeof body.scan !== 'object' || !Array.isArray(body.accept)) return fail(400, 'Nothing to save.');
  // Re-plan from the load as it is now: anything typed since the preview is kept.
  const scan = cleanScan(body.scan);
  const changes = planRescan(load, scan);
  const { stops, notes } = rescanUpdates(changes, body.accept.map(String).slice(0, 50));
  const applied = [];
  for (const [stopId, patch] of Object.entries(stops)) {
    const { error } = await userDb.from('stops').update(patch).eq('id', stopId).eq('load_id', load.id);
    if (error) return fail(500, GENERIC, 'stop update', error.message);
    for (const f of Object.keys(patch)) applied.push(`${stopId}:${f}`);
  }
  if (notes) {
    let q = userDb.from('loads').update({ notes: notes.to }).eq('id', load.id).eq('user_id', user.id);
    q = load.notes == null ? q.is('notes', null) : q.eq('notes', load.notes);
    const { error } = await q;
    if (error) return fail(500, GENERIC, 'notes update', error.message);
    applied.push('notes');
  }
  const skipped = body.accept.filter((k) => !applied.includes(k));
  return json({ applied, skipped });
}

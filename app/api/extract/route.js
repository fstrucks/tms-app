import { createClient } from '@supabase/supabase-js';
import { noStoreFetch } from '../../lib/noStoreFetch';
import { classifyDocText, decideDocKind } from '../../lib/docClassify';
import { callRateConModel, pdfTextOf, pickModel } from '../../lib/rateconExtract';
import { parseWeightLb } from '../../lib/loadWeight';
import { fillLinkedLoadWeight } from '../../lib/loadWeightFill';
import { parseTripMiles, fillLinkedLoadMiles } from '../../lib/loadMiles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const LIMIT_PER_HOUR = 20;
const LIMIT_PER_DAY = 100;
const GENERIC = 'Extraction failed, please try again.';

// Only these are sent to OpenAI. Anything else gets a 415.
const SUPPORTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, publicMsg, ...log) => {
  if (log.length) console.error('[extract]', ...log);
  return json({ error: publicMsg }, status);
};

function resolveMime(blobType, name) {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_TYPES[ext] || null;
}

export async function POST(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail(501, 'AI extraction is not configured.', 'OPENAI_API_KEY missing');
  if (!url || !anonKey || !serviceKey) {
    return fail(500, 'Server configuration error.', 'Missing env:', [!url && 'NEXT_PUBLIC_SUPABASE_URL', !anonKey && 'NEXT_PUBLIC_SUPABASE_ANON_KEY', !serviceKey && 'SUPABASE_SERVICE_ROLE_KEY'].filter(Boolean).join(', '));
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'Please sign in again.');

  let documentId, force = false;
  try { ({ documentId, force = false } = await req.json()); } catch {}
  if (!documentId) return fail(400, 'documentId is required.');

  const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: noStoreFetch } };
  // User-scoped client: RLS applies, used to verify identity and ownership.
  const userDb = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: `Bearer ${token}` }, fetch: noStoreFetch } });
  const { data: userData, error: userErr } = await userDb.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return fail(401, 'Please sign in again.', userErr?.message);

  const { data: doc, error: docErr } = await userDb
    .from('documents').select('id, user_id, doc_type, file_path, original_filename, ai_extracted_data, load_id').eq('id', documentId).maybeSingle();
  if (docErr) return fail(500, GENERIC, 'doc load', docErr.message);
  if (!doc || doc.user_id !== user.id) return fail(404, 'Document not found.');
  // Only rate confirmations are extracted (e.g. expense receipts are not).
  if (doc.doc_type !== 'rate_confirmation') return fail(400, 'Only rate confirmations can be extracted.', 'doc_type', doc.doc_type, doc.id);

  // The file must live in the user's own folder; never touch storage outside it.
  if (typeof doc.file_path !== 'string' || !doc.file_path.startsWith(`${user.id}/`)) {
    return fail(403, 'Not allowed.', 'file_path outside user folder', doc.id);
  }

  if (doc.ai_extracted_data && force !== true) {
    return json({ error: 'Already extracted. Re-run to overwrite.', data: doc.ai_extracted_data }, 409);
  }

  const name = doc.original_filename || doc.file_path;
  const slash = doc.file_path.lastIndexOf('/');
  const { data: objs } = await userDb.storage.from('documents').list(doc.file_path.slice(0, slash), {
    search: doc.file_path.slice(slash + 1), limit: 1,
  });
  const meta = objs?.[0]?.metadata;
  if (meta?.size > MAX_BYTES) return fail(413, 'File is too large to extract (max 10 MB).');

  const preMime = resolveMime(meta?.mimetype, doc.file_path) || resolveMime(null, name);
  if (preMime === 'image/heic' || preMime === 'image/heif') {
    return fail(415, 'HEIC/HEIF photos cannot be extracted directly. Re-upload it here (photos are converted to JPEG automatically) or upload a JPEG, PNG, WebP or PDF.');
  }
  if (preMime && !SUPPORTED.includes(preMime)) return fail(415, 'Unsupported file type. Use PDF, JPEG, PNG or WebP.');

  // Service client: only after identity, ownership and path are verified.
  // Used for the atomic rate-limit claim, run status and ai_extracted_data.
  const admin = createClient(url, serviceKey, opts);
  const { data: runId, error: claimErr } = await admin.rpc('claim_extraction_slot', { p_user: user.id, p_document: doc.id });
  if (claimErr) return fail(500, GENERIC, 'claim slot', claimErr.message);
  if (!runId) return fail(429, `Extraction limit reached (${LIMIT_PER_HOUR}/hour, ${LIMIT_PER_DAY}/day). Try again later.`);
  const finish = (status) => admin.from('extraction_runs').update({ status }).eq('id', runId);

  const { data: blob, error: dlErr } = await userDb.storage.from('documents').download(doc.file_path);
  if (dlErr || !blob) { await finish('error'); return fail(500, GENERIC, 'download', dlErr?.message); }
  if (blob.size > MAX_BYTES) { await finish('rejected'); return fail(413, 'File is too large to extract (max 10 MB).'); }

  const mime = resolveMime(blob.type, doc.file_path) || preMime;
  if (mime === 'image/heic' || mime === 'image/heif') {
    await finish('rejected');
    return fail(415, 'HEIC/HEIF photos cannot be extracted directly. Re-upload it here (photos are converted to JPEG automatically) or upload a JPEG, PNG, WebP or PDF.');
  }
  if (!SUPPORTED.includes(mime)) { await finish('rejected'); return fail(415, 'Unsupported file type. Use PDF, JPEG, PNG or WebP.'); }

  const bytes = Buffer.from(await blob.arrayBuffer());
  // Digital PDF: read the text layer first. A clear COI (ACORD 25 wording) is reclassified without an AI call.
  let pdfText = '';
  if (mime === 'application/pdf') pdfText = await pdfTextOf(bytes);
  const textKind = classifyDocText(pdfText);
  if (textKind === 'coi') return reclassifyCoi(admin, doc, user, finish);
  if (textKind === 'bol' || textKind === 'scale_ticket') return reclassifyLoadDoc(admin, doc, user, finish, textKind, null);
  const model = pickModel(process.env.OPENAI_MODEL);
  const ai = await callRateConModel({ apiKey, model, mime, name, bytes });
  if (!ai.ok) {
    await finish(ai.status);
    if (ai.status === 'timeout') return fail(504, 'Extraction timed out, please try again.', ...ai.log);
    return fail(502, GENERIC, ...ai.log);
  }
  let extracted = ai.extracted;

  const { document_kind: aiKind, heading_text: aiText, ...loadData } = extracted || {};
  const kind = decideDocKind({ pdfText, aiKind, aiText });
  if (kind === 'coi') return reclassifyCoi(admin, doc, user, finish);
  if (kind === 'bol' || kind === 'scale_ticket') return reclassifyLoadDoc(admin, doc, user, finish, kind, loadData);
  extracted = { ...loadData, total_miles: parseTripMiles(loadData.total_miles), weight_lb: parseWeightLb(loadData.weight) };
  const { error: upErr } = await admin.from('documents').update({ ai_extracted_data: extracted })
    .eq('id', doc.id).eq('user_id', user.id);
  if (upErr) { await finish('error'); return fail(500, GENERIC, 'save', upErr.message); }

  // Re-run on a rate con that already has a load: fill that load's weight if it's empty (never overwrite).
  const lw = await fillLinkedLoadWeight(userDb, { loadId: doc.load_id, userId: user.id, weight: extracted.weight_lb });
  if (lw.error) console.error('[extract] load weight', lw.error.message || lw.error);
  // Same for miles: fill the linked load's total_miles only if it's empty (a typed or earlier value always wins).
  const lm = await fillLinkedLoadMiles(userDb, { loadId: doc.load_id, userId: user.id, miles: extracted.total_miles });
  if (lm.error) console.error('[extract] load miles', lm.error.message || lm.error);
  await finish('success');
  return json({ data: extracted, ...(doc.load_id ? { loadId: doc.load_id } : {}), ...(lw.filled ? { loadWeightFilled: lw.weight } : {}), ...(lm.filled ? { loadMilesFilled: lm.miles } : {}) });
}

// Save the upload as a COI (no load data) and tell the client.
async function reclassifyCoi(admin, doc, user, finish) {
  const { error } = await admin.from('documents').update({ doc_type: 'coi', ai_extracted_data: null }).eq('id', doc.id).eq('user_id', user.id);
  if (error) { await finish('error'); return fail(500, GENERIC, 'reclassify', error.message); }
  await finish('success');
  return json({ reclassified: 'coi', docType: 'coi', data: null });
}

// PR #110: a BOL or scale ticket uploaded as a rate con is re-typed so it shows under its load. The numbers and date
// read off it are kept in ai_extracted_data (doc_kind / reference_numbers / doc_date) for the "Link to load" suggestion.
async function reclassifyLoadDoc(admin, doc, user, finish, kind, data) {
  const refs = [data?.load_number, ...(Array.isArray(data?.reference_numbers) ? data.reference_numbers : [])].map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(data?.pickup?.date || '') ? data.pickup.date : null;
  const read = { doc_kind: kind, reference_numbers: refs, doc_date: date };
  const { error } = await admin.from('documents').update({ doc_type: kind, ai_extracted_data: read }).eq('id', doc.id).eq('user_id', user.id);
  if (error) { await finish('error'); return fail(500, GENERIC, 'reclassify', error.message); }
  await finish('success');
  return json({ reclassified: kind, docType: kind, data: read });
}
